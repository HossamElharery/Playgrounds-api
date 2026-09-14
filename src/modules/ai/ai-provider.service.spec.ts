import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AiProviderService } from './ai-provider.service';
import { AiUnavailableError } from './ai-provider.types';

function configWith(vars: Record<string, string>): ConfigService {
  return { get: (key: string) => vars[key] ?? '' } as unknown as ConfigService;
}

const BASE_CONFIG = {
  GEMINI_API_KEY: 'gemini-key',
  GEMINI_MODEL: 'gemini-3.6-flash',
  OPENROUTER_API_KEY: 'openrouter-key',
};

function geminiOk(text: string) {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
}
function geminiFail(status: number) {
  return { ok: false, status };
}
function openRouterOk(text: string) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) };
}
function openRouterFail(status: number) {
  return { ok: false, status };
}

const GOOD_JSON = JSON.stringify({ intent: 'block', confidence: 0.9 });

/** Routes a mocked fetch by which API it targets, so a test can give each provider its own canned response. */
function routedFetch(responses: {
  gemini?: () => unknown;
  ultra?: () => unknown;
  super_?: () => unknown;
}) {
  return jest.fn(async (url: string, init?: { body?: string }) => {
    if (url.includes('generativelanguage.googleapis.com')) {
      if (!responses.gemini) throw new Error('unexpected gemini call');
      return responses.gemini();
    }
    if (url.includes('openrouter.ai')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.model?.includes('super')) {
        if (!responses.super_) throw new Error('unexpected super call');
        return responses.super_();
      }
      if (!responses.ultra) throw new Error('unexpected ultra call');
      return responses.ultra();
    }
    throw new Error(`unexpected url ${url}`);
  });
}

const REQUEST = { systemPrompt: 'sys', userPrompt: 'اقفل ملعب 2 بكرة من 5 لـ 7' };

describe('AiProviderService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the Gemini result and never calls OpenRouter when Gemini succeeds', async () => {
    const fetchMock = routedFetch({ gemini: () => geminiOk(GOOD_JSON) });
    (global as any).fetch = fetchMock;
    const service = new AiProviderService(configWith(BASE_CONFIG));
    const result = await service.getStructuredIntent(REQUEST);
    expect(result).toEqual({ raw: GOOD_JSON, provider: 'gemini' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to openrouter-nemotron-ultra when Gemini returns a 500', async () => {
    (global as any).fetch = routedFetch({
      gemini: () => geminiFail(500),
      ultra: () => openRouterOk(GOOD_JSON),
    });
    const service = new AiProviderService(configWith(BASE_CONFIG));
    const result = await service.getStructuredIntent(REQUEST);
    expect(result).toEqual({ raw: GOOD_JSON, provider: 'openrouter-nemotron-ultra' });
  });

  it('falls back to openrouter-nemotron-super when Gemini and ultra both fail', async () => {
    (global as any).fetch = routedFetch({
      gemini: () => geminiFail(429),
      ultra: () => openRouterFail(503),
      super_: () => openRouterOk(GOOD_JSON),
    });
    const service = new AiProviderService(configWith(BASE_CONFIG));
    const result = await service.getStructuredIntent(REQUEST);
    expect(result).toEqual({ raw: GOOD_JSON, provider: 'openrouter-nemotron-super' });
  });

  it('throws AiUnavailableError when all three providers fail', async () => {
    (global as any).fetch = routedFetch({
      gemini: () => geminiFail(500),
      ultra: () => openRouterFail(500),
      super_: () => openRouterFail(500),
    });
    const service = new AiProviderService(configWith(BASE_CONFIG));
    await expect(service.getStructuredIntent(REQUEST)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('treats an empty/unparseable Gemini reply as a failure and falls back', async () => {
    (global as any).fetch = routedFetch({
      gemini: () => geminiOk('not json at all'),
      ultra: () => openRouterOk(GOOD_JSON),
    });
    const service = new AiProviderService(configWith(BASE_CONFIG));
    const result = await service.getStructuredIntent(REQUEST);
    expect(result.provider).toBe('openrouter-nemotron-ultra');
  });

  it('opens the circuit after 3 consecutive Gemini failures and skips Gemini on the next call', async () => {
    let geminiCalls = 0;
    (global as any).fetch = jest.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        geminiCalls++;
        return geminiFail(500);
      }
      return openRouterOk(GOOD_JSON);
    });
    const service = new AiProviderService(configWith(BASE_CONFIG));

    await service.getStructuredIntent(REQUEST);
    await service.getStructuredIntent(REQUEST);
    await service.getStructuredIntent(REQUEST);
    expect(geminiCalls).toBe(3);

    const result = await service.getStructuredIntent(REQUEST);
    expect(result.provider).toBe('openrouter-nemotron-super');
    expect(geminiCalls).toBe(3); // circuit open — Gemini was not attempted this time
  });

  it('AI_FORCE_FAILURE=gemini forces the OpenRouter path without ever calling the Gemini fetch', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes('generativelanguage.googleapis.com')) throw new Error('gemini should not be called');
      return openRouterOk(GOOD_JSON);
    });
    (global as any).fetch = fetchMock;
    const service = new AiProviderService(
      configWith({ ...BASE_CONFIG, AI_FORCE_FAILURE: 'gemini' }),
    );
    const result = await service.getStructuredIntent(REQUEST);
    expect(result.provider).toBe('openrouter-nemotron-super');
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('generativelanguage.googleapis.com');
    }
  });

  it('parses the same Egyptian Arabic schedule command through the OpenRouter fallback', async () => {
    const parsed = {
      intent: 'block',
      courtIds: ['c1'],
      allCourts: false,
      date: '2026-09-13',
      fromMins: 1020,
      toMins: 1140,
      reason: '',
      confidence: 0.8,
    };
    (global as any).fetch = routedFetch({
      gemini: () => geminiFail(500),
      ultra: () => openRouterOk(JSON.stringify(parsed)),
    });
    const service = new AiProviderService(configWith(BASE_CONFIG));
    const result = await service.getStructuredIntent({
      systemPrompt: 'sys',
      userPrompt: 'اقفل ملعب 2 بكرة من 5 لـ 7',
    });
    expect(JSON.parse(result.raw)).toEqual(parsed);
    expect(result.provider).toBe('openrouter-nemotron-ultra');
  });

  it('logs an auth failure distinctly on a 401', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    (global as any).fetch = routedFetch({
      gemini: () => geminiFail(401),
      ultra: () => openRouterOk(GOOD_JSON),
    });
    const service = new AiProviderService(configWith(BASE_CONFIG));
    await service.getStructuredIntent(REQUEST);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('AUTH FAILURE'));
  });

  it('is disabled with no keys configured at all', () => {
    const service = new AiProviderService(configWith({}));
    expect(service.enabled).toBe(false);
  });
});
