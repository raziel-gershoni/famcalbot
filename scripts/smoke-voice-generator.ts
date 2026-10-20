// Show generation in src/services/voice-generator.ts with Gemini faked: the semaphore,
// the host table, and the show made line by line in-process. No network.
//
// Run: npx tsx scripts/smoke-voice-generator.ts

import fs from 'fs/promises';
import { createSemaphore } from '../src/utils/semaphore';
import { TTS_MODEL } from '../src/config/tts-models';
import type { SpeechAudio, SynthesizeSpeechInput } from '../src/services/gemini-tts';
import type { ShowLine } from '../src/services/voice-show/types';

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const RATE = 24000;

function tone(ms: number, amp = 8000): Buffer {
  const n = Math.round((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2);
  return b;
}
const silence = (ms: number) => Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);

const synthCalls: SynthesizeSpeechInput[] = [];
const fakeSynth = async (input: SynthesizeSpeechInput): Promise<SpeechAudio> => {
  synthCalls.push(input);
  return { pcm: Buffer.concat([silence(100), tone(600), silence(100)]), sampleRate: RATE, mimeType: 'audio/l16', audioTokens: 15 };
};

const LINES: ShowLine[] = [
  { host: 'A', text: 'בוקר טוב', style: 'high-energy, excited sports commentator' },
  { host: 'B', text: 'יאללה', style: 'high-energy, excited sports commentator, amused' },
  { host: 'A', text: 'פגישה', style: 'high-energy, excited sports commentator' },
  { host: 'B', text: '<whispers> סוד', style: 'high-energy, excited sports commentator, leaning in close', whisper: true },
];

async function main() {
  const { generateShowVoice, getShowVoices } = await import('../src/services/voice-generator');

  await check('semaphore caps concurrency and runs every task', async () => {
    const run = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const out = await Promise.all([1, 2, 3, 4, 5, 6].map(n => run(async () => {
      active++; peak = Math.max(peak, active); await sleep(5); active--; return n * 10;
    })));
    assert(peak === 2, `peak ${peak}`);
    assert(out.join(',') === '10,20,30,40,50,60', `out ${out.join(',')}`);
  });

  await check('semaphore frees the slot when a task throws', async () => {
    const run = createSemaphore(1);
    const first = run(async () => { throw new Error('boom'); }).catch(() => 'caught');
    const second = run(async () => 'ran');
    assert((await first) === 'caught' && (await second) === 'ran', 'slot leaked');
  });

  await check('semaphore refuses a non-positive size', () => {
    let threw = false;
    try { createSemaphore(0); } catch { threw = true; }
    assert(threw, 'size 0 accepted');
  });

  await check('host table: built-in pairs for Hebrew, English and Russian, nothing elsewhere', () => {
    const he = getShowVoices('he');
    assert(he?.A === 'Schedar', `A ${he?.A}`);
    assert(he?.B === 'Puck', `B ${he?.B}`);
    for (const language of ['he', 'en', 'ru']) {
      const voices = getShowVoices(language);
      assert(!!voices && /^[A-Z][a-z]+$/.test(voices.A) && /^[A-Z][a-z]+$/.test(voices.B) && voices.A !== voices.B, `${language}: ${JSON.stringify(voices)}`);
    }
    assert(getShowVoices('fr') === null, 'fr');
    assert(getShowVoices('__proto__') === null && getShowVoices('constructor') === null, 'prototype keys');
  });

  await check('the show is made in-process, line by line, on the hosts\' voices', async () => {
    // A leftover TTS_SERVICE_URL from the removed Vercel service changes nothing.
    process.env.TTS_SERVICE_URL = 'http://127.0.0.1:9';
    synthCalls.length = 0;
    const result = await generateShowVoice(LINES, 'he', { synthesize: fakeSynth });
    delete process.env.TTS_SERVICE_URL;
    try {
      assert(result.lineCount === 4 && result.audioTokens === 60, JSON.stringify(result));
      assert(synthCalls.length === 4, `synth calls ${synthCalls.length}`);
      assert(synthCalls.every(c => c.model === TTS_MODEL), `models ${synthCalls.map(c => c.model).join(',')}`);
      assert(synthCalls.every((c, i) => c.voiceName === (LINES[i].host === 'A' ? 'Schedar' : 'Puck')), 'voices');
      assert(synthCalls[1].style === 'high-energy, excited sports commentator, amused', `style ${synthCalls[1].style}`);
      // 4 lines of 0.6 s tone + 2 x 40 ms kept edges, 3 gaps of 0.2 s.
      assert(Math.abs(result.audioSeconds - 3.32) < 0.05, `audioSeconds ${result.audioSeconds}`);
      const file = await fs.readFile(result.filePath);
      assert(file.subarray(0, 4).toString('ascii') === 'OggS', 'not an Ogg file');
    } finally {
      await fs.unlink(result.filePath).catch(() => {});
    }
  });

  await check('each line gets only the time the show has left', async () => {
    synthCalls.length = 0;
    const result = await generateShowVoice(LINES, 'he', { synthesize: fakeSynth, deadlineMs: 3000 });
    await fs.unlink(result.filePath).catch(() => {});
    const timeouts = synthCalls.map(c => c.timeoutMs ?? 0);
    assert(timeouts.length === 4 && timeouts.every(t => t <= 3000 && t > 2000), `timeouts ${timeouts.join(',')}`);
  });

  await check('a language without hosts and an empty show are refused', async () => {
    let frThrew = false;
    let emptyThrew = false;
    try { await generateShowVoice(LINES, 'fr', { synthesize: fakeSynth }); } catch { frThrew = true; }
    try { await generateShowVoice([], 'he', { synthesize: fakeSynth }); } catch { emptyThrew = true; }
    assert(frThrew && emptyThrew, `fr ${frThrew} empty ${emptyThrew}`);
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
