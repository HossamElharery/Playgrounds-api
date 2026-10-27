import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { assertVenueAccess } from '../../../common/access/owner-access';
import { PrismaService } from '../../prisma/prisma.service';

export interface OwnerAssistantPreferencesView {
  venueId: string;
  voiceEnabled: boolean;
  autoSendAfterSpeech: boolean;
  continueAfterReply: boolean;
  allowVoiceConfirmations: boolean;
  voice: 'female' | 'male';
  speechRate: number;
}

export type OwnerAssistantPreferencesInput = Omit<OwnerAssistantPreferencesView, 'venueId'>;

const defaults = (venueId: string): OwnerAssistantPreferencesView => ({
  venueId,
  voiceEnabled: false,
  autoSendAfterSpeech: true,
  continueAfterReply: true,
  allowVoiceConfirmations: false,
  voice: 'female',
  speechRate: 1,
});

@Injectable()
export class OwnerAssistantPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(user: AuthenticatedUser, venueId: string): Promise<OwnerAssistantPreferencesView> {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const row = await this.prisma.ownerAssistantPreference.findUnique({
      where: { userId_venueId: { userId: user.id, venueId } },
    });
    return row ? this.view(row) : defaults(venueId);
  }

  async update(
    user: AuthenticatedUser,
    venueId: string,
    input: OwnerAssistantPreferencesInput,
  ): Promise<OwnerAssistantPreferencesView> {
    // This is a personal preference, not a venue mutation: staff may change
    // their own voice experience but never anyone else's.
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const data = {
      voiceEnabled: input.voiceEnabled,
      autoSendAfterSpeech: input.autoSendAfterSpeech,
      continueAfterReply: input.continueAfterReply,
      allowVoiceConfirmations: input.allowVoiceConfirmations,
      voice: input.voice,
      speechRate: input.speechRate,
    };
    const row = await this.prisma.ownerAssistantPreference.upsert({
      where: { userId_venueId: { userId: user.id, venueId } },
      create: { userId: user.id, venueId, ...data },
      update: data,
    });
    return this.view(row);
  }

  private view(row: {
    venueId: string;
    voiceEnabled: boolean;
    autoSendAfterSpeech: boolean;
    continueAfterReply: boolean;
    allowVoiceConfirmations: boolean;
    voice: string;
    speechRate: number;
  }): OwnerAssistantPreferencesView {
    return {
      venueId: row.venueId,
      voiceEnabled: row.voiceEnabled,
      autoSendAfterSpeech: row.autoSendAfterSpeech,
      continueAfterReply: row.continueAfterReply,
      allowVoiceConfirmations: row.allowVoiceConfirmations,
      voice: row.voice === 'male' ? 'male' : 'female',
      speechRate: Math.max(0.8, Math.min(1.2, row.speechRate)),
    };
  }
}
