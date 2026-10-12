// Smoke test for src/services/dialogue-tts.ts: ordering, concurrency, retries, failure.
// No network - a fake synthesize function stands in for Gemini.
//
// Run: npx tsx scripts/smoke-dialogue-tts.ts

import { isRetryableTtsError, synthesizeDialogue, type DialogueLine } from '../src/services/dialogue-tts';
import type { SpeechAudio, SynthesizeSpeechInput } from '../src/services/gemini-tts';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function httpError(status: number, message = `status ${status}`): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const lines = (n: number): DialogueLine[] =>
  Array.from({ length: n }, (_, i) => ({ voice: i % 2 ? 'voice_b' : 'voice_a', text: `line ${i}`, style: `style ${i}` }));
const audio = (byte: number, tokens = 10, sampleRate = 24000): SpeechAudio =>
  ({ pcm: Buffer.from([byte, 0]), sampleRate, mimeType: 'audio/l16', audioTokens: tokens });
const indexOf = (input: SynthesizeSpeechInput) => Number(input.text.split(' ')[1]);

async function main() {
  await check('results keep line order and tokens add up', async () => {
    const out = await synthesizeDialogue({
      apiKey: 'k', model: 'm', lines: lines(6), baseDelayMs: 1,
      synthesize: async input => { await sleep((6 - indexOf(input)) * 3); return audio(indexOf(input)); },
    });
    assert(out.pcms.map(p => p[0]).join(',') === '0,1,2,3,4,5', `order ${out.pcms.map(p => p[0]).join(',')}`);
    assert(out.audioTokens === 60, `tokens ${out.audioTokens}`);
    assert(out.requests === 6, `requests ${out.requests}`);
    assert(out.sampleRate === 24000, `rate ${out.sampleRate}`);
  });

  await check('voice, text, style, model, key and line timeout reach synthesize', async () => {
    const seen: SynthesizeSpeechInput[] = [];
    await synthesizeDialogue({
      apiKey: 'key-1', model: 'gemini-3.8-flash-tts', lines: lines(2), lineTimeoutMs: 1234,
      synthesize: async input => { seen.push(input); return audio(0); },
    });
    const first = seen.find(s => s.text === 'line 1')!;
    assert(first.voiceName === 'voice_b' && first.style === 'style 1', JSON.stringify(first));
    assert(first.apiKey === 'key-1' && first.model === 'gemini-3.8-flash-tts' && first.timeoutMs === 1234, JSON.stringify(first));
  });

  await check('never more requests in flight than the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await synthesizeDialogue({
      apiKey: 'k', model: 'm', lines: lines(10), concurrency: 3,
      synthesize: async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(5); inFlight--; return audio(0); },
    });
    assert(peak === 3, `peak ${peak}`);
  });

  await check('429 then success is retried', async () => {
    let calls = 0;
    const out = await synthesizeDialogue({
      apiKey: 'k', model: 'm', lines: lines(1), baseDelayMs: 1,
      synthesize: async () => { calls++; if (calls === 1) throw httpError(429); return audio(7); },
    });
    assert(out.pcms[0][0] === 7 && out.requests === 2, `requests ${out.requests}`);
  });

  await check('timeouts, network errors and "no audio" are retried', async () => {
    const failures: Error[] = [
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
      new TypeError('fetch failed'),
      new Error('Gemini TTS m returned no audio'),
    ];
    let calls = 0;
    const out = await synthesizeDialogue({
      apiKey: 'k', model: 'm', lines: lines(1), maxAttempts: 4, baseDelayMs: 1,
      synthesize: async () => { const f = failures[calls++]; if (f) throw f; return audio(1); },
    });
    assert(out.requests === 4, `requests ${out.requests}`);
  });

  await check('a 400 fails at once without retry', async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await synthesizeDialogue({ apiKey: 'k', model: 'm', lines: lines(1), baseDelayMs: 1,
        synthesize: async () => { calls++; throw httpError(400); } });
    } catch (e) { caught = e; }
    assert((caught as { status?: number })?.status === 400, 'error not passed through');
    assert(calls === 1, `calls ${calls}`);
  });

  await check('persistent 503 gives up after maxAttempts', async () => {
    let calls = 0;
    let threw = false;
    try {
      await synthesizeDialogue({ apiKey: 'k', model: 'm', lines: lines(1), maxAttempts: 3, baseDelayMs: 1,
        synthesize: async () => { calls++; throw httpError(503); } });
    } catch { threw = true; }
    assert(threw && calls === 3, `threw ${threw} calls ${calls}`);
  });

  await check('after a failure no new lines are started', async () => {
    let calls = 0;
    let threw = false;
    try {
      await synthesizeDialogue({ apiKey: 'k', model: 'm', lines: lines(5), concurrency: 1,
        synthesize: async () => { calls++; throw httpError(404, 'The voice was not found'); } });
    } catch { threw = true; }
    assert(threw && calls === 1, `threw ${threw} calls ${calls}`);
  });

  await check('a line waiting out its backoff sends nothing once another line has failed', async () => {
    const calls = [0, 0];
    const start = Date.now();
    let caught: unknown;
    try {
      await synthesizeDialogue({
        apiKey: 'k', model: 'm', lines: lines(2), concurrency: 2, baseDelayMs: 60,
        synthesize: async input => {
          const i = indexOf(input);
          calls[i]++;
          if (i === 0 && calls[0] === 1) throw httpError(503); // line 0 backs off 60 ms
          if (i === 0) { await sleep(300); return audio(0); } // a retry would hold the show up
          await sleep(10);
          throw httpError(400); // line 1 fails for good at ~10 ms
        },
      });
    } catch (e) { caught = e; }
    const elapsed = Date.now() - start;
    assert((caught as { status?: number })?.status === 400, `error ${String(caught)}`);
    assert(calls[0] === 1, `line 0 sent ${calls[0]} requests`);
    assert(elapsed < 250, `rejected after ${elapsed} ms`);
  });

  await check('lines at different sample rates are refused', async () => {
    let threw = false;
    try {
      await synthesizeDialogue({ apiKey: 'k', model: 'm', lines: lines(2),
        synthesize: async input => audio(0, 1, indexOf(input) ? 16000 : 24000) });
    } catch { threw = true; }
    assert(threw, 'mixed rates accepted');
  });

  await check('a dialogue with no lines is refused', async () => {
    let threw = false;
    try { await synthesizeDialogue({ apiKey: 'k', model: 'm', lines: [], synthesize: async () => audio(0) }); } catch { threw = true; }
    assert(threw, 'empty accepted');
  });

  await check('retry classification', () => {
    assert(isRetryableTtsError(httpError(429)), '429');
    assert(isRetryableTtsError(httpError(500)) && isRetryableTtsError(httpError(503)), '5xx');
    assert(!isRetryableTtsError(httpError(400)) && !isRetryableTtsError(httpError(404)), '4xx');
    assert(isRetryableTtsError(Object.assign(new Error('x'), { name: 'AbortError' })), 'abort');
    assert(!isRetryableTtsError(new Error('Unsupported TTS audio format: audio/mpeg')), 'format error');
    assert(!isRetryableTtsError(null), 'null');
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
