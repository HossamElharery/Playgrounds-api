import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PartnerRegisterDto } from './partner-auth.dto';
describe('Partner registration validation', () => {
  const account = {
    name: ' Owner ',
    username: 'owner.test',
    email: ' OWNER@example.com ',
    password: 'Simple123',
  };
  it('accepts eight characters and normalizes name and email', async () => {
    const dto = plainToInstance(PartnerRegisterDto, account);
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.name).toBe('Owner');
    expect(dto.email).toBe('owner@example.com');
  });
  it('allows blank phones but rejects malformed phones at the field', async () => {
    for (const phone of [undefined, ''])
      expect(
        await validate(
          plainToInstance(PartnerRegisterDto, { ...account, phone }),
        ),
      ).toHaveLength(0);
    const errors = await validate(
      plainToInstance(PartnerRegisterDto, { ...account, phone: '+20123' }),
    );
    expect(errors.map((e) => e.property)).toEqual(['phone']);
  });
  it('accepts omission of a custom username while still rejecting malformed names', async () => {
    const { username, ...minimal } = account;
    expect(await validate(plainToInstance(PartnerRegisterDto, minimal))).toHaveLength(0);
    const errors = await validate(plainToInstance(PartnerRegisterDto, { ...minimal, username: '123' }));
    expect(errors.map(e => e.property)).toContain('username');
  });
  it('rejects short passwords and passwords without letters or digits', async () => {
    for (const password of ['Abc123', 'abcdefgh', '12345678']) {
      const errors = await validate(
        plainToInstance(PartnerRegisterDto, { ...account, password }),
      );
      expect(errors.map((e) => e.property)).toContain('password');
    }
  });
});
