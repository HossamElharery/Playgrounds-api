import { OwnerAssistantPreferencesService } from './owner-assistant-preferences.service';

describe('OwnerAssistantPreferencesService', () => {
  const user = { id: 'u1', roles: ['owner'] } as never;

  it('is safely off when this person has never configured this venue', async () => {
    const prisma = {
      venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'u1' }) },
      ownerAssistantPreference: { findUnique: jest.fn().mockResolvedValue(null) },
    } as never;
    const result = await new OwnerAssistantPreferencesService(prisma).get(user, 'v1');
    expect(result).toMatchObject({
      venueId: 'v1',
      voiceEnabled: false,
      autoSendAfterSpeech: true,
      continueAfterReply: true,
      allowVoiceConfirmations: false,
      voice: 'female',
      speechRate: 1,
    });
  });

  it('stores preferences under the user and venue composite key', async () => {
    const saved = {
      venueId: 'v1', voiceEnabled: true, autoSendAfterSpeech: false,
      continueAfterReply: false, allowVoiceConfirmations: true, voice: 'male', speechRate: 1.15,
    };
    const upsert = jest.fn().mockResolvedValue(saved);
    const prisma = {
      venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'u1' }) },
      ownerAssistantPreference: { upsert },
    } as never;
    const result = await new OwnerAssistantPreferencesService(prisma).update(user, 'v1', {
      voiceEnabled: true, autoSendAfterSpeech: false, continueAfterReply: false,
      allowVoiceConfirmations: true, voice: 'male', speechRate: 1.15,
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_venueId: { userId: 'u1', venueId: 'v1' } },
    }));
    expect(result).toEqual(saved);
  });
});
