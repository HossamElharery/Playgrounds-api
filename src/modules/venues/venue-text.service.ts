import { Injectable, Logger, Optional } from '@nestjs/common';
import { AiProviderService } from '../ai/ai-provider.service';

export interface BilingualText { ar: string; en: string }

const ARABIC = /[؀-ۿ]/g;
const LATIN = /[A-Za-z]/g;

/**
 * Owners write a venue's name and description once, in the language they think in. This gives the
 * public pages both languages: the other one is translated (public-data profile, never PII) and,
 * when no translator is reachable, the original is shown in both so nothing is ever left empty.
 */
@Injectable()
export class VenueTextService {
  private readonly log = new Logger(VenueTextService.name);
  constructor(@Optional() private readonly ai?: AiProviderService) {}

  static languageOf(text: string): 'ar' | 'en' {
    const arabic = (text.match(ARABIC) ?? []).length;
    const latin = (text.match(LATIN) ?? []).length;
    return arabic >= latin ? 'ar' : 'en';
  }

  async both(input: string, kind: 'name' | 'description'): Promise<BilingualText> {
    const text = input.trim();
    if (!text) return { ar: '', en: '' };
    const from = VenueTextService.languageOf(text);
    const to = from === 'ar' ? 'en' : 'ar';
    const translated = await this.translate(text, to, kind);
    const other = translated ?? text;
    return from === 'ar' ? { ar: text, en: other } : { ar: other, en: text };
  }

  private async translate(text: string, to: 'ar' | 'en', kind: 'name' | 'description'): Promise<string | null> {
    if (!this.ai) return null;
    try {
      const result = await this.ai.getStructuredIntent({
        profile: 'public',
        reasoning: 'minimal',
        timeoutMs: 8000,
        cacheTtlMs: 24 * 3600_000,
        systemPrompt: `You translate the ${kind} of a sports/gaming venue listing in Egypt into ${to === 'ar' ? 'Egyptian-friendly Modern Standard Arabic' : 'natural English'}. Keep brand and place names, numbers and prices unchanged. Return JSON {"translation": string} only.`,
        userPrompt: text,
        responseSchema: { type: 'object', properties: { translation: { type: 'string' } }, required: ['translation'] },
      });
      const value = String((JSON.parse(result.raw) as { translation?: unknown }).translation ?? '').trim();
      return value && value.length <= Math.max(60, text.length * 4) ? value : null;
    } catch (error) {
      this.log.warn(`venue text translation skipped: ${(error as Error).message}`);
      return null;
    }
  }
}
