import { AiAdminQualityService } from './ai-admin-quality.service';
import * as runner from '../eval/ai-eval.runner';

jest.mock('../eval/ai-eval.runner', () => {
  const actual = jest.requireActual('../eval/ai-eval.runner');
  return { ...actual, runEvalSuite: jest.fn() };
});

const summary = (over: Record<string, unknown> = {}) => ({ kind: 'captain', model: 'google/gemini-3.8-flash', reasoning: 'default', pass: 40, total: 40, ran: 40, truncated: false, avgMs: 900, calls: 40, failedCalls: 0, costUsd: 0.06, failures: [], ...over });

function build(opts: { chain?: { kind: string; model: string }[]; enabled?: boolean; rows?: unknown[] } = {}) {
  const prisma = {
    aiEvalRun: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'run1' }), findUnique: jest.fn() },
    aiQuestionLog: { findMany: jest.fn().mockResolvedValue(opts.rows ?? []) },
    auditLogEntry: { create: jest.fn().mockResolvedValue({}) },
  };
  const provider = { enabled: opts.enabled ?? true, chain: jest.fn().mockReturnValue(opts.chain ?? [{ kind: 'openrouter', model: 'google/gemini-3.8-flash' }]) };
  const config = { get: (k: string) => (k === 'OPENROUTER_API_KEY' ? 'key' : undefined) };
  const usage = { record: jest.fn() };
  const knowledge = { forPlayers: jest.fn().mockResolvedValue([]) };
  const nlu = { read: jest.fn() };
  const service = new AiAdminQualityService(prisma as never, config as never, provider as never, usage as never, knowledge as never, nlu as never);
  return { service, prisma, nlu, usage };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe('AiAdminQualityService', () => {
  beforeEach(() => jest.mocked(runner.runEvalSuite).mockReset());

  it('runs the cases on a model, saves the result and audits who started it', async () => {
    jest.mocked(runner.runEvalSuite).mockResolvedValue(summary() as never);
    const { service, prisma } = build();
    const job = await service.startEval({ kind: 'captain' }, 'admin1');
    expect(job.status).toBe('running');
    await settle();
    expect(service.jobStatus(job.id)).toMatchObject({ status: 'done', runId: 'run1' });
    const saved = prisma.aiEvalRun.create.mock.calls[0][0].data;
    expect(saved).toMatchObject({ kind: 'captain', source: 'admin', passed: 40, total: 40, triggeredById: 'admin1', models: ['google/gemini-3.8-flash'] });
    expect(prisma.auditLogEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'ai.eval.run', actorUserId: 'admin1' }) });
  });

  it('puts a hard cost cap on every model run and reports the spend into the real ledger', async () => {
    jest.mocked(runner.runEvalSuite).mockResolvedValue(summary() as never);
    const { service, usage } = build();
    await service.startEval({ kind: 'captain', models: ['google/gemini-3.6-flash'] }, 'admin1');
    await settle();
    const opts = jest.mocked(runner.runEvalSuite).mock.calls[0][0];
    expect(opts.maxCostUsd).toBeLessThanOrEqual(0.25);
    expect(opts.sink).toBe(usage);
  });

  it('refuses a second run while one is in progress, and runs too close together', async () => {
    let finish!: () => void;
    jest.mocked(runner.runEvalSuite).mockImplementation(() => new Promise((res) => (finish = () => res(summary() as never))));
    const { service } = build();
    await service.startEval({ kind: 'captain' }, 'admin1');
    await expect(service.startEval({ kind: 'captain' }, 'admin1')).rejects.toMatchObject({ status: 409 });
    finish();
    await settle();
    await expect(service.startEval({ kind: 'captain' }, 'admin1')).rejects.toMatchObject({ status: 429 });
  });

  it('accepts only real model ids, a few at a time, and keeps the owner suite on Google models', async () => {
    const { service } = build();
    await expect(service.startEval({ kind: 'captain', models: ['not a model'] }, 'a')).rejects.toBeDefined();
    await expect(service.startEval({ kind: 'captain', models: ['a/b', 'c/d', 'e/f', 'g/h'] }, 'a')).rejects.toBeDefined();
    await expect(service.startEval({ kind: 'owner', models: ['deepseek/deepseek-v4.1-flash'] }, 'a')).rejects.toBeDefined();
  });

  it('refuses to run with no AI key', async () => {
    const { service } = build({ enabled: false });
    await expect(service.startEval({ kind: 'captain' }, 'a')).rejects.toBeDefined();
    await expect(service.startShadow({ model: 'google/gemini-3.6-flash' }, 'a')).rejects.toBeDefined();
  });

  describe('shadow comparison', () => {
    const logged = (i: number, over: Record<string, unknown> = {}) => ({
      id: `q${i}`,
      textRedacted: `سؤال ${i}`,
      lang: 'ar',
      userKind: 'guest',
      model: 'google/gemini-3.8-flash',
      ms: 1000,
      intent: 'find_venues',
      factIds: [],
      reading: { sport: 'padel', district: 'maadi' },
      ...over,
    });

    it('needs enough recent questions to say anything', async () => {
      const { service } = build({ rows: [logged(1), logged(2)] });
      await expect(service.startShadow({ model: 'google/gemini-3.6-flash' }, 'a')).rejects.toBeDefined();
    });

    it('replays logged questions on the candidate only (never to a player) and lists where it disagrees', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => logged(i));
      const { service, prisma, nlu } = build({ rows });
      nlu.read.mockImplementation(async ({ text }: { text: string }) => ({
        intent: 'find_venues',
        sport: text === 'سؤال 3' ? 'football' : 'padel',
        district: 'maadi',
        factIds: [],
        meta: { model: 'google/gemini-3.6-flash', ms: 800, costUsd: 0.001 },
      }));
      const job = await service.startShadow({ model: 'google/gemini-3.6-flash', sampleSize: 10 }, 'admin1');
      await settle();
      expect(service.jobStatus(job.id).status).toBe('done');
      for (const [arg] of nlu.read.mock.calls) expect(arg).toMatchObject({ modelsOverride: ['google/gemini-3.6-flash'], skipBudget: true });
      const saved = prisma.aiEvalRun.create.mock.calls[0][0].data;
      expect(saved.kind).toBe('shadow');
      const shadow = (saved.summary as { shadow: { compared: number; agree: number; agreementPct: number; diffs: unknown[]; costUsd: number } }).shadow;
      expect(shadow).toMatchObject({ compared: 10, agree: 9, agreementPct: 90 });
      expect(shadow.diffs).toHaveLength(1);
    });
  });
});
