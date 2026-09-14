/**
 * Manual smoke test — NOT part of the Jest suite. Run with:
 *   npm run test:openrouter
 *
 * Sends one real request to OpenRouter (the free Nemotron fallback model —
 * see the note in ai-provider.types.ts about why this isn't Llama/Qwen) with
 * a fixed Egyptian Arabic test sentence and prints whether it worked, which
 * model answered, how long it took, and the full parsed JSON. Use this once
 * to confirm OPENROUTER_API_KEY actually works before relying on it as a
 * fallback for Gemini.
 */
import * as dotenv from 'dotenv';
dotenv.config();

const MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'; // the primary OpenRouter fallback — see ai-provider.service.ts
const TEST_SENTENCE = 'اقفل ملعب 2 بكرة من 5 لـ 7';

const SYSTEM_PROMPT = `أنت محلل نوايا لجدول ملعب رياضي مصري. رجّع JSON فقط بالشكل ده:
{"intent": "block"|"unblock"|"free"|"unknown", "courtIds": string[], "allCourts": boolean, "date": "YYYY-MM-DD", "fromMins": number|null, "toMins": number|null, "reason": string, "confidence": number}
الملاعب المتاحة: [{"id":"c1","name":"ملعب 1"},{"id":"c2","name":"ملعب 2"}]. النهاردة تاريخه 2026-09-12.
fromMins/toMins = عدد الدقايق من نص الليل (5 مساءً = 1020، 7 مساءً = 1140).`;

async function main() {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    console.error('❌ OPENROUTER_API_KEY is not set in .env — nothing to test.');
    process.exit(1);
  }

  console.log(`Sending "${TEST_SENTENCE}" to ${MODEL} via OpenRouter...`);
  const started = Date.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: TEST_SENTENCE },
        ],
      }),
    });
    const ms = Date.now() - started;

    if (!res.ok) {
      console.error(`❌ HTTP ${res.status} after ${ms}ms`);
      console.error(await res.text());
      process.exit(1);
    }

    const json = await res.json();
    const raw = json?.choices?.[0]?.message?.content;
    console.log(`✅ Connected — model=${json?.model ?? MODEL} latency=${ms}ms`);
    console.log('Raw content:', raw);
    try {
      const cleaned = String(raw).replace(/```(?:json)?\s*([\s\S]*?)```/i, '$1').trim();
      console.log('Parsed JSON:', JSON.stringify(JSON.parse(cleaned), null, 2));
    } catch {
      console.warn('⚠️  Could not parse the reply as JSON — see raw content above.');
    }
  } catch (err) {
    console.error(`❌ Request failed after ${Date.now() - started}ms:`, err);
    process.exit(1);
  }
}

void main();
