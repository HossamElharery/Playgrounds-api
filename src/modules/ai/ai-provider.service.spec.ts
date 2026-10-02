import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AiProviderService } from './ai-provider.service';
import { AiUsageService } from './ai-usage.service';
import { AiUnavailableError } from './ai-provider.types';

function configWith(vars: Record<string, string>): ConfigService {
  return { get: (key: string) => vars[key] ?? '' } as unknown as ConfigService;
}

const KEYS = { OPENROUTER_API_KEY: 'or-key', GEMINI_API_KEY: 'gm-key', GEMINI_MODEL: 'gemini-3.8-flash' };

function build(vars: Record<string, string> = KEYS) {
  const config = configWith(vars);
  const usage = new AiUsageService(config);
  return { service: new AiProviderService(config, usage), usage };
}

const orOk = (text: string, cost = 0.0004) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: text } }], usage: { cost } }),
});
const gmOk = (text: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
});
const fail = (status: number) => ({ ok: false, status });

const GOOD = JSON.stringify({ intent: 'block', confidence: 0.9 });
const REQUEST = { systemPrompt: 'sys', userPrompt: 'اقفل ملعب 2 بكرة من 5 لـ 7' };

/** Routes a mocked fetch by the model asked of OpenRouter (or the Gemini host), so each route gets its own canned answer. */
function routed(answers: Record<string, () => unknown>) {
  const calls: string[] = [];
  const fn = jest.fn(async (url: string, init?: { body?: string }) => {
    let key = url.includes('generativelanguage') ? 'gemini-direct' : JSON.parse(String(init?.body)).model;
    calls.push(key);
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected call to ${key}`);
    return answer();
  });
  return { fn, calls };
}

describe('AiProviderService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('answers from the first OpenRouter model and records what it cost', async () => {
    const { service, usage } = build();
    const { fn, calls } = routed({ 'google/gemini-3.8-flash': () => orOk(GOOD, 0.0009) });
    global.fetch = fn as never;
    const res = await service.getStructuredIntent(REQUEST);
    expect(res).toMatchObject({ provider: 'openrouter', model: 'google/gemini-3.8-flash', costUsd: 0.0009 });
    expect(JSON.parse(res.raw)).toEqual({ intent: 'block', confidence: 0.9 });
    expect(calls).toEqual(['google/gemini-3.8-flash']);
    expect(usage.spentToday('owner')).toBeCloseTo(0.0009);
  });

  it('asks OpenRouter to account for usage and to keep thinking short', async () => {
    const { service } = build();
    const { fn } = routed({ 'google/gemini-3.8-flash': () => orOk(GOOD) });
    global.fetch = fn as never;
    await service.getStructuredIntent({ ...REQUEST, profile: 'public' });
    const body = JSON.parse(String((fn.mock.calls[0] as unknown[])[1] && ((fn.mock.calls[0] as unknown[])[1] as { body: string }).body));
    expect(body.usage).toEqual({ include: true });
    expect(body.reasoning).toEqual({ effort: 'minimal' });
    const owner = build();
    const o = routed({ 'google/gemini-3.8-flash': () => orOk(GOOD) });
    global.fetch = o.fn as never;
    await owner.service.getStructuredIntent(REQUEST);
    expect(JSON.parse(((o.fn.mock.calls[0] as unknown[])[1] as { body: string }).body).reasoning).toEqual({ effort: 'low' });
  });

  it('strips a markdown fence from the reply', async () => {
    const { service } = build();
    global.fetch = routed({ 'google/gemini-3.8-flash': () => orOk('```json\n' + GOOD + '\n```') }).fn as never;
    expect(JSON.parse((await service.getStructuredIntent(REQUEST)).raw)).toEqual({ intent: 'block', confidence: 0.9 });
  });

  it('moves to the next model when one fails', async () => {
    const { service } = build();
    const { fn, calls } = routed({
      'google/gemini-3.8-flash': () => fail(503),
      'google/gemini-3.6-flash': () => orOk(GOOD),
    });
    global.fetch = fn as never;
    const res = await service.getStructuredIntent(REQUEST);
    expect(res.model).toBe('google/gemini-3.6-flash');
    expect(calls).toEqual(['google/gemini-3.8-flash', 'google/gemini-3.6-flash']);
  });

  it('keeps the owner assistant on Google models: never DeepSeek, never a free model', async () => {
    const { service } = build();
    const { fn, calls } = routed({
      'google/gemini-3.8-flash': () => fail(503),
      'google/gemini-3.6-flash': () => fail(503),
      'google/gemini-3.5-flash': () => fail(503),
      'gemini-direct': () => gmOk(GOOD),
    });
    global.fetch = fn as never;
    const res = await service.getStructuredIntent({ ...REQUEST, profile: 'owner' });
    expect(res.provider).toBe('gemini');
    expect(calls.some((c) => c.includes('deepseek') || c.includes(':free'))).toBe(false);
  });

  it('lets public traffic fall through to DeepSeek and finally the free model', async () => {
    const { service } = build({ OPENROUTER_API_KEY: 'or-key' });
    const { fn, calls } = routed({
      'google/gemini-3.8-flash': () => fail(500),
      'google/gemini-3.6-flash': () => fail(500),
      'deepseek/deepseek-v4.1-flash': () => fail(500),
      'nvidia/nemotron-3-super-120b-a12b:free': () => orOk(GOOD),
    });
    global.fetch = fn as never;
    const res = await service.getStructuredIntent({ ...REQUEST, profile: 'public' });
    expect(res.model).toContain(':free');
    expect(calls).toHaveLength(4);
  });

  it('throws AiUnavailableError when every route fails', async () => {
    const { service } = build({ OPENROUTER_API_KEY: 'or-key' });
    global.fetch = jest.fn(async () => fail(500)) as never;
    await expect(service.getStructuredIntent(REQUEST)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('stops using a model that is out of credit instead of retrying it on every message', async () => {
    const { service } = build({ OPENROUTER_API_KEY: 'or-key' });
    const answers = {
      'google/gemini-3.8-flash': () => fail(402),
      'google/gemini-3.6-flash': () => fail(402),
      'google/gemini-3.5-flash': () => fail(402),
    };
    const first = routed(answers);
    global.fetch = first.fn as never;
    await expect(service.getStructuredIntent(REQUEST)).rejects.toBeInstanceOf(AiUnavailableError);
    const second = routed(answers);
    global.fetch = second.fn as never;
    await expect(service.getStructuredIntent(REQUEST)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(second.calls).toHaveLength(0);
  });

  it('refuses without calling anything once the day’s budget is spent', async () => {
    const { service, usage } = build({ ...KEYS, AI_OWNER_DAILY_BUDGET_USD: '0.001' });
    usage.record({ profile: 'owner', provider: 'openrouter', model: 'm', ok: true, ms: 1, costUsd: 0.002 });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    await expect(service.getStructuredIntent(REQUEST)).rejects.toMatchObject({ reason: 'budget' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the public and owner budgets apart', async () => {
    const { service, usage } = build({ ...KEYS, AI_PUBLIC_DAILY_BUDGET_USD: '0.001' });
    usage.record({ profile: 'public', provider: 'openrouter', model: 'm', ok: true, ms: 1, costUsd: 0.5 });
    global.fetch = routed({ 'google/gemini-3.8-flash': () => orOk(GOOD) }).fn as never;
    await expect(service.getStructuredIntent({ ...REQUEST, profile: 'public' })).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(service.getStructuredIntent({ ...REQUEST, profile: 'owner' })).resolves.toBeDefined();
  });

  it('reuses an identical answer inside the cache window', async () => {
    const { service } = build();
    const { fn, calls } = routed({ 'google/gemini-3.8-flash': () => orOk(GOOD) });
    global.fetch = fn as never;
    await service.getStructuredIntent({ ...REQUEST, profile: 'public', cacheTtlMs: 60_000 });
    const again = await service.getStructuredIntent({ ...REQUEST, profile: 'public', cacheTtlMs: 60_000 });
    expect(calls).toHaveLength(1);
    expect(again.costUsd).toBe(0);
  });

  it('honours a configured model list', async () => {
    const { service } = build({ ...KEYS, AI_OWNER_MODELS: 'google/gemini-3.7-flash' });
    const { fn, calls } = routed({ 'google/gemini-3.7-flash': () => orOk(GOOD) });
    global.fetch = fn as never;
    await service.getStructuredIntent(REQUEST);
    expect(calls).toEqual(['google/gemini-3.7-flash']);
  });

  it('is disabled without any key, and works with only the direct Gemini key', async () => {
    expect(build({}).service.enabled).toBe(false);
    const { service } = build({ GEMINI_API_KEY: 'gm-key' });
    expect(service.enabled).toBe(true);
    global.fetch = routed({ 'gemini-direct': () => gmOk(GOOD) }).fn as never;
    expect((await service.getStructuredIntent(REQUEST)).provider).toBe('gemini');
  });

  describe('admin tooling support', () => {
    it('tells the ledger which route of the chain answered, so fallbacks can be counted', async () => {
      const { service, usage } = build();
      const { fn } = routed({
        'google/gemini-3.8-flash': () => fail(500),
        'google/gemini-3.6-flash': () => orOk(GOOD),
      });
      global.fetch = fn as never;
      await service.getStructuredIntent(REQUEST);
      const snap = usage.snapshot();
      expect(snap.models.find((m) => m.model === 'google/gemini-3.6-flash')).toMatchObject({ calls: 1, fallbackCalls: 1 });
      expect(snap.models.find((m) => m.model === 'google/gemini-3.8-flash')).toMatchObject({ calls: 1, failures: 1, fallbackCalls: 0 });
    });

    it('reports which routes are paused and why (out of credit is not the same as a rate limit)', async () => {
      const { service } = build();
      const { fn } = routed({
        'google/gemini-3.8-flash': () => fail(402),
        'google/gemini-3.6-flash': () => fail(429),
        'google/gemini-3.5-flash': () => orOk(GOOD),
      });
      global.fetch = fn as never;
      await service.getStructuredIntent(REQUEST);
      const states = service.breakerStates();
      expect(states.find((b) => b.model === 'google/gemini-3.8-flash')).toMatchObject({ reason: 'credit', kind: 'openrouter' });
      expect(states.find((b) => b.model === 'google/gemini-3.6-flash')).toMatchObject({ reason: 'rate_limit' });
      expect(states.every((b) => b.openUntil > Date.now())).toBe(true);
    });

    it('lets an admin tool ask exactly one named model for public traffic — and never re-routes the owner assistant', async () => {
      const { service } = build();
      const { fn, calls } = routed({ 'google/gemini-3.6-flash': () => orOk(GOOD), 'google/gemini-3.8-flash': () => orOk(GOOD) });
      global.fetch = fn as never;
      await service.getStructuredIntent({ ...REQUEST, profile: 'public', modelsOverride: ['google/gemini-3.6-flash'] });
      expect(calls).toEqual(['google/gemini-3.6-flash']);
      calls.length = 0;
      await service.getStructuredIntent({ ...REQUEST, profile: 'owner', modelsOverride: ['google/gemini-3.6-flash'] });
      expect(calls).toEqual(['google/gemini-3.8-flash']);
    });

    it('lets an admin test while the day’s budget is spent, but live traffic is still stopped', async () => {
      const { service, usage } = build({ ...KEYS, AI_PUBLIC_DAILY_BUDGET_USD: '0.01' });
      usage.record({ profile: 'public', provider: 'openrouter', model: 'm', ok: true, ms: 1, costUsd: 0.02 });
      const { fn } = routed({ 'google/gemini-3.8-flash': () => orOk(GOOD) });
      global.fetch = fn as never;
      await expect(service.getStructuredIntent({ ...REQUEST, profile: 'public' })).rejects.toBeInstanceOf(AiUnavailableError);
      await expect(service.getStructuredIntent({ ...REQUEST, profile: 'public', skipBudget: true })).resolves.toMatchObject({ model: 'google/gemini-3.8-flash' });
    });
  });
});
