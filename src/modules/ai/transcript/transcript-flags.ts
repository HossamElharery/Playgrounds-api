import { screenMessage } from '../../search/captain/captain-guard';

export type TranscriptFlag =
  | 'unrecognized'
  | 'low_confidence'
  | 'blocked'
  | 'denied'
  | 'limited'
  | 'unavailable'
  | 'failed'
  | 'long'
  | 'noise'
  | 'repeated';

export const TRANSCRIPT_FLAGS: TranscriptFlag[] = [
  'unrecognized',
  'low_confidence',
  'blocked',
  'denied',
  'limited',
  'unavailable',
  'failed',
  'long',
  'noise',
  'repeated',
];

export type TranscriptOutcome =
  | 'planned'
  | 'clarify'
  | 'denied'
  | 'unavailable'
  | 'limited'
  | 'error'
  | 'applied'
  | 'failed'
  | 'undone';

export interface FlagInput {
  text: string;
  intent?: string;
  outcome?: TranscriptOutcome;
  confidence?: number;
  blockingCode?: string;
  recentSame?: number;
}

export function flagsFor(input: FlagInput): TranscriptFlag[] {
  const out = new Set<TranscriptFlag>();
  const { outcome } = input;
  if (outcome === 'clarify' && (input.intent === 'unknown' || !input.intent)) out.add('unrecognized');
  if (outcome === 'clarify' && typeof input.confidence === 'number' && input.confidence > 0 && input.confidence < 0.6 && input.intent !== 'unknown') {
    out.add('low_confidence');
  }
  if (input.blockingCode && input.blockingCode !== 'NO_PERMISSION') out.add('blocked');
  if (outcome === 'denied') out.add('denied');
  if (outcome === 'limited') out.add('limited');
  if (outcome === 'unavailable') out.add('unavailable');
  if (outcome === 'failed' || outcome === 'error') out.add('failed');
  if (input.text.length > 300) out.add('long');
  if (!screenMessage(input.text).ok) out.add('noise');
  if ((input.recentSame ?? 0) >= 2) out.add('repeated');
  return [...out];
}
