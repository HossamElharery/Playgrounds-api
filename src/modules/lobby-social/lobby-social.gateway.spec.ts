import {Socket} from 'socket.io';
import {LobbySocialGateway} from './lobby-social.gateway';
import {LobbySocialService} from './lobby-social.service';
import {SocialRuleError} from './social.engine';

describe('Social gateway authentication boundary',()=> {
  const cmd={squadId:'room',requestId:'one',action:'create',game:'cards' as const};
  let service:any;let gateway:LobbySocialGateway;let client:Socket;
  beforeEach(()=> {
    service={snapshot:jest.fn().mockResolvedValue({squadId:'room'}),command:jest.fn().mockResolvedValue({squadId:'room'})};
    gateway=new LobbySocialGateway(service as LobbySocialService);
    client={data:{userId:'me'},rooms:new Set(['squad:room']),emit:jest.fn()} as unknown as Socket;
  });
  it('waits for established authentication instead of racing the JWT handshake',async()=> {
    client.data.userId=undefined;
    client.data.authReady=Promise.resolve().then(()=>{client.data.userId='me';});
    await gateway.command(client,cmd);expect(service.command).toHaveBeenCalledWith('me',cmd);
  });
  it('drops anonymous sockets and cross-room requests before accessing state',async()=> {
    client.data.userId=undefined;await gateway.command(client,cmd);client.data.userId='me';
    await gateway.command(client,{...cmd,squadId:'other'});expect(service.command).not.toHaveBeenCalled();
  });
  it('ignores a forged actor identity and uses only the authenticated user',async()=> {
    await gateway.command(client,{...cmd,userId:'victim'} as any);
    expect(service.command.mock.calls[0][0]).toBe('me');
  });
  it('returns a generic database error without exception text or private state',async()=> {
    service.command.mockRejectedValue(new Error('fabrication private choice database error'));
    await gateway.command(client,cmd);
    expect(client.emit).toHaveBeenCalledWith('lobby.social.error',{squadId:'room',requestId:'one',code:'unavailable'});
  });
  it('correlates rate-limit rejection so the client can finish its pending command',async()=> {
    for(let i=0;i<46;i++)await gateway.command(client,{...cmd,requestId:`r${i}`});
    expect(service.command).toHaveBeenCalledTimes(45);
    expect(client.emit).toHaveBeenLastCalledWith('lobby.social.error',{squadId:'room',requestId:'r45',code:'cooldown'});
  });
  it('never echoes secret values embedded in rejected command text',async()=> {
    service.command.mockRejectedValue(new SocialRuleError('not_allowed'));
    await gateway.command(client,{...cmd,choice:'fabrication'});
    expect(JSON.stringify((client.emit as jest.Mock).mock.calls)).not.toContain('fabrication');
  });
});
