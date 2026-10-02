/**
 * Manual quality check — NOT part of the Jest suite. Run with:
 *   npm run ai:eval                          (all default models, both assistants)
 *   npm run ai:eval -- --only=captain
 *   npm run ai:eval -- --models=google/gemini-3.8-flash,deepseek/deepseek-v4.1-flash
 *   npm run ai:eval -- --reasoning=low
 *   npm run ai:eval -- --save                (also store the results for the admin Quality tab)
 *
 * Sends real sentences — Egyptian Arabic, English, voice-transcript slips —
 * through the same prompts the app uses, one model at a time with no fallback,
 * and scores what comes back against what a person would expect. Use it before
 * trusting a model, and after changing a prompt. It spends real (tiny) money.
 * The cases live in modules/ai/eval and are shared with the admin Quality tab.
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient, type Prisma } from '@prisma/client';
import type { AiReasoningEffort } from '../modules/ai/ai-provider.types';
import { runEvalSuite, type EvalKind, type EvalSummary } from '../modules/ai/eval/ai-eval.runner';
import { toMicros } from '../modules/ai/ai-day';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const only = arg('only') as EvalKind | undefined;
  const reasoning = arg('reasoning') as AiReasoningEffort | undefined;
  const modelsArg = arg('models');
  if (!process.env['OPENROUTER_API_KEY']) {
    console.error('OPENROUTER_API_KEY is not set in .env');
    process.exit(1);
  }
  const defaults = {
    captain: ['google/gemini-3.8-flash', 'google/gemini-3.6-flash', 'deepseek/deepseek-v4.1-flash'],
    owner: ['google/gemini-3.8-flash', 'google/gemini-3.6-flash'],
  };
  const prisma = flag('save') ? new PrismaClient() : null;
  for (const kind of ['captain', 'owner'] as const) {
    if (only && only !== kind) continue;
    const models = modelsArg ? modelsArg.split(',') : defaults[kind];
    const results: EvalSummary[] = [];
    const started = Date.now();
    for (const model of models) {
      const r = await runEvalSuite({ kind, model, reasoning, env: (k) => process.env[k] });
      results.push(r);
      console.log(`\n=== ${r.kind === 'captain' ? 'Captain' : 'Owner'} · ${model} · reasoning=${r.reasoning} ===`);
      console.log(
        `passed ${r.pass}/${r.total} (${Math.round((100 * r.pass) / r.total)}%) · ${r.avgMs} ms/case · ${r.calls} calls, ${r.failedCalls} failed · cost $${r.costUsd.toFixed(4)}`,
      );
      if (r.failures.length) console.log(r.failures.map((f) => `  ✗ "${f.q}" → ${f.got}`).join('\n'));
    }
    if (prisma && results.length) {
      await prisma.aiEvalRun.create({
        data: {
          kind,
          models,
          source: 'cli',
          passed: results.reduce((n, r) => n + r.pass, 0),
          total: results.reduce((n, r) => n + r.total, 0),
          costMicros: toMicros(results.reduce((n, r) => n + r.costUsd, 0)),
          durationMs: Date.now() - started,
          summary: { results } as unknown as Prisma.InputJsonValue,
        },
      });
      console.log(`\n(saved ${kind} results for the admin Quality tab)`);
    }
  }
  await prisma?.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
