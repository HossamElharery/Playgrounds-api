import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EdgeTTS } from '@andresaya/edge-tts';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { escapeSpeechXml, normalizeEgyptianSpeech } from './egyptian-speech-normalizer';
import { OwnerAssistantPreferencesService } from './owner-assistant-preferences.service';

const VOICES = {
  female: 'ar-EG-SalmaNeural',
  male: 'ar-EG-ShakirNeural',
} as const;

@Injectable()
export class OwnerAssistantSpeechService {
  private readonly logger = new Logger(OwnerAssistantSpeechService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly preferences: OwnerAssistantPreferencesService,
  ) {}

  async stream(
    user: AuthenticatedUser,
    input: { venueId: string; text: string; voice?: 'female' | 'male'; rate?: number },
  ): Promise<{ stream: Readable; normalizedText: string; contentType: string }> {
    const preference = await this.preferences.get(user, input.venueId);
    if (!preference.voiceEnabled) {
      throw new ForbiddenException('Voice is off for this account at this venue');
    }
    // Voice and speed are server-owned preferences. A stale or modified client
    // cannot silently bypass what the operator selected in Settings.
    input = { ...input, voice: preference.voice, rate: preference.speechRate };
    const normalizedText = normalizeEgyptianSpeech(input.text);
    if (!normalizedText) throw new ServiceUnavailableException('Nothing speakable in the response');

    const selfHostedUrl = this.config.get<string>('OWNER_ASSISTANT_TTS_URL', '').trim();
    if (selfHostedUrl) {
      try {
        return await this.selfHosted(normalizedText, input, selfHostedUrl);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown provider error';
        this.logger.warn(`Self-hosted Egyptian speech failed: ${reason}`);
        if (this.config.get<string>('OWNER_ASSISTANT_TTS_EDGE_FALLBACK', 'true') !== 'true') {
          throw new ServiceUnavailableException('Egyptian voice is temporarily unavailable');
        }
      }
    }

    return this.edge(normalizedText, input);
  }

  /**
   * Provider-neutral contract for a GPU speech worker (VoiceTut today, without
   * coupling the product to that model): POST JSON and stream audio back.
   */
  private async selfHosted(
    normalizedText: string,
    input: { voice?: 'female' | 'male'; rate?: number },
    url: string,
  ): Promise<{ stream: Readable; normalizedText: string; contentType: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const token = this.config.get<string>('OWNER_ASSISTANT_TTS_TOKEN', '').trim();
    const female = this.config.get<string>('OWNER_ASSISTANT_TTS_FEMALE_VOICE', 'Asmaa');
    const male = this.config.get<string>('OWNER_ASSISTANT_TTS_MALE_VOICE', 'Mohamed');
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'accept': 'audio/mpeg, audio/wav, audio/*',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          text: normalizedText,
          speaker: input.voice === 'male' ? male : female,
          speed: input.rate ?? 1,
          language: 'arz',
          format: 'mp3',
          stream: true,
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`provider returned HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/mpeg';
      if (!contentType.startsWith('audio/')) throw new Error(`provider returned ${contentType}`);
      return {
        stream: Readable.fromWeb(response.body as unknown as NodeReadableStream),
        normalizedText,
        contentType,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async edge(
    normalizedText: string,
    input: { voice?: 'female' | 'male'; rate?: number },
  ): Promise<{ stream: Readable; normalizedText: string; contentType: string }> {

    const client = new EdgeTTS({ timeout: 20_000 });
    try {
      const rate = Math.round(((input.rate ?? 1) - 1) * 100);
      const result = await client.generate(
        escapeSpeechXml(normalizedText),
        VOICES[input.voice ?? 'female'],
        {
          rate: `${rate >= 0 ? '+' : ''}${rate}%`,
          pitch: '+0Hz',
          volume: '+0%',
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        },
      );
      if (!result.audio.length) throw new Error('The speech provider returned empty audio');
      return { stream: Readable.from(result.audio), normalizedText, contentType: 'audio/mpeg' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown provider error';
      this.logger.warn(`Egyptian speech synthesis failed: ${reason}`);
      throw new ServiceUnavailableException('Egyptian voice is temporarily unavailable');
    }
  }
}
