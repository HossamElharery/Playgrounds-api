import { ConfigService } from '@nestjs/config';
import { OwnerAssistantSpeechService } from './owner-assistant-speech.service';

describe('OwnerAssistantSpeechService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('streams normalized Egyptian speech from the configured self-hosted provider', async () => {
    const env: Record<string, string> = {
      OWNER_ASSISTANT_TTS_URL: 'http://speech.internal/v1/speech',
      OWNER_ASSISTANT_TTS_TOKEN: 'private-worker-token',
      OWNER_ASSISTANT_TTS_FEMALE_VOICE: 'Asmaa',
    };
    const config = { get: (key: string, fallback = '') => env[key] ?? fallback } as ConfigService;
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(
      new Uint8Array([82, 73, 70, 70]),
      { status: 200, headers: { 'content-type': 'audio/wav' } },
    ));
    const preferences = { get: jest.fn().mockResolvedValue({ voiceEnabled: true, voice: 'female', speechRate: 1 }) } as never;
    const service = new OwnerAssistantSpeechService(config, preferences);

    const result = await service.stream(
      { id: 'u1', roles: ['owner'] } as never,
      { venueId: 'v1', text: 'الحجز ١٩:٣٠ والسعر ٤٠٠ جنيه', voice: 'female' },
    );
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));

    expect(result.contentType).toBe('audio/wav');
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([82, 73, 70, 70]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, request] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://speech.internal/v1/speech');
    expect(request?.headers).toMatchObject({ authorization: 'Bearer private-worker-token' });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      text: 'الحجز الساعة سبعة ونص بالليل والسعر ربعمية جنيه',
      speaker: 'Asmaa',
      language: 'arz',
      stream: true,
    });
  });

  it('rejects a provider response that is not audio', async () => {
    const env: Record<string, string> = {
      OWNER_ASSISTANT_TTS_URL: 'http://speech.internal/v1/speech',
      OWNER_ASSISTANT_TTS_EDGE_FALLBACK: 'false',
    };
    const config = { get: (key: string, fallback = '') => env[key] ?? fallback } as ConfigService;
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const preferences = { get: jest.fn().mockResolvedValue({ voiceEnabled: true, voice: 'female', speechRate: 1 }) } as never;
    await expect(new OwnerAssistantSpeechService(config, preferences).stream(
      { id: 'u1', roles: ['owner'] } as never,
      { venueId: 'v1', text: 'تمام' },
    )).rejects.toThrow('Egyptian voice is temporarily unavailable');
  });

  it('never calls a speech provider while voice is off for this person and venue', async () => {
    const config = { get: jest.fn() } as never;
    const preferences = { get: jest.fn().mockResolvedValue({ voiceEnabled: false }) } as never;
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(new OwnerAssistantSpeechService(config, preferences).stream(
      { id: 'u1', roles: ['owner'] } as never,
      { venueId: 'v1', text: 'تمام' },
    )).rejects.toThrow('Voice is off');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
