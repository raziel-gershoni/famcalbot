// Show generation in src/services/voice-generator.ts with Gemini faked: the semaphore,
// the host table, and remote-first with local fallback - including a tts-service that
// predates /api/dialogue and answers 404. Only a local HTTP server; no real network.
//
// Run: npx tsx scripts/smoke-voice-generator.ts

import fs from 'fs/promises';
import http from 'http';
import type { AddressInfo } from 'net';
import { createSemaphore } from '../src/utils/semaphore';
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
  { host: 'A', text: 'בוקר טוב', style: 'excited sports commentator' },
  { host: 'B', text: 'יאללה', style: 'amused, laughing a little' },
  { host: 'A', text: 'פגישה', style: 'excited sports commentator' },
  { host: 'B', text: 'סוד', style: 'whispering, secretive', whisper: true },
];

type Seen = { method?: string; url?: string; auth?: string; body?: { voices?: { A: string; B: string }; lines?: unknown[]; model?: string } };

async function withServer(respond: (res: http.ServerResponse) => void, fn: (url: string, seen: Seen) => Promise<void>) {
  const seen: Seen = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      Object.assign(seen, { method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      respond(res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function main() {
  // Before voice-generator loads: its host table reads the env at import.
  process.env.GEMINI_SHOW_VOICE_HE_B = 'voice_override123';
  process.env.TTS_API_KEY = 'test-key';
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

  await check('host table: Hebrew defaults with env override, nothing elsewhere', () => {
    const he = getShowVoices('he');
    assert(he?.A === 'voice_33yuo333h4y2', `A ${he?.A}`);
    assert(he?.B === 'voice_override123', `B ${he?.B}`);
    assert(getShowVoices('en') === null && getShowVoices('ru') === null, 'en/ru');
    assert(getShowVoices('__proto__') === null && getShowVoices('constructor') === null, 'prototype keys');
  });

  await check('remote 404 (tts-service without /api/dialogue) falls back to local', async () => {
    await withServer(res => { res.statusCode = 404; res.end('Not Found'); }, async (url, seen) => {
      process.env.TTS_SERVICE_URL = url;
      synthCalls.length = 0;
      const result = await generateShowVoice(LINES, 'he', { synthesize: fakeSynth });
      try {
        assert(seen.method === 'POST' && seen.url === '/api/dialogue', `${seen.method} ${seen.url}`);
        assert(seen.auth === 'Bearer test-key', `auth ${seen.auth}`);
        assert(seen.body?.voices?.B === 'voice_override123' && seen.body.lines?.length === 4, 'remote body');
        assert(typeof seen.body?.model === 'string', 'model not sent');
        assert(result.via === 'local' && result.lineCount === 4 && result.audioTokens === 60, JSON.stringify(result));
        assert(synthCalls.length === 4, `synth calls ${synthCalls.length}`);
        assert(synthCalls.every((c, i) => c.voiceName === (LINES[i].host === 'A' ? 'voice_33yuo333h4y2' : 'voice_override123')), 'voices');
        assert(synthCalls[1].style === 'amused, laughing a little', `style ${synthCalls[1].style}`);
        // 4 lines of 0.6 s tone + 2 x 40 ms kept edges, 3 gaps of 0.2 s.
        assert(Math.abs(result.audioSeconds - 3.32) < 0.05, `audioSeconds ${result.audioSeconds}`);
        const file = await fs.readFile(result.filePath);
        assert(file.subarray(0, 4).toString('ascii') === 'OggS', 'not an Ogg file');
      } finally {
        await fs.unlink(result.filePath).catch(() => {});
      }
    });
  });

  await check('remote 200 is used as is', async () => {
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 1)]);
    await withServer(res => {
      res.setHeader('Content-Type', 'audio/ogg');
      res.setHeader('X-TTS-Model', 'gemini-3.8-flash-tts');
      res.setHeader('X-TTS-Audio-Seconds', '12.50');
      res.setHeader('X-TTS-Audio-Tokens', '300');
      res.end(ogg);
    }, async url => {
      process.env.TTS_SERVICE_URL = url;
      synthCalls.length = 0;
      const result = await generateShowVoice(LINES, 'he', { synthesize: fakeSynth });
      try {
        assert(result.via === 'remote' && synthCalls.length === 0, `via ${result.via}, synth ${synthCalls.length}`);
        assert(result.audioSeconds === 12.5 && result.audioTokens === 300, JSON.stringify(result));
        assert(result.ttsModel === 'gemini-3.8-flash-tts', `model ${result.ttsModel}`);
        assert((await fs.readFile(result.filePath)).equals(ogg), 'file differs from the response');
      } finally {
        await fs.unlink(result.filePath).catch(() => {});
      }
    });
  });

  await check('a slow remote failure leaves the local fallback only the time the show has left', async () => {
    await withServer(res => { setTimeout(() => { res.statusCode = 500; res.end('boom'); }, 300); }, async url => {
      process.env.TTS_SERVICE_URL = url;
      synthCalls.length = 0;
      const result = await generateShowVoice(LINES, 'he', { synthesize: fakeSynth, deadlineMs: 3000 });
      await fs.unlink(result.filePath).catch(() => {});
      const timeouts = synthCalls.map(c => c.timeoutMs ?? 0);
      assert(result.via === 'local' && timeouts.length === 4, `via ${result.via}, calls ${timeouts.length}`);
      assert(timeouts.every(t => t <= 2700 && t > 2000), `local timeouts ${timeouts.join(',')}`);
    });
  });

  await check('a hung remote is cut at the show deadline and the local fallback fails fast', async () => {
    let held: http.ServerResponse | undefined;
    // Timed from the remote request: locally the model lookup before the slot waits
    // ~4 s on the Upstash client's retries.
    let receivedAt = 0;
    await withServer(res => { held = res; receivedAt = Date.now(); }, async url => {
      process.env.TTS_SERVICE_URL = url;
      synthCalls.length = 0;
      let caught: unknown;
      try {
        await Promise.race([
          generateShowVoice(LINES, 'he', { synthesize: fakeSynth, deadlineMs: 400 }),
          sleep(15_000).then(() => { throw new Error('still waiting after 15 s'); }),
        ]);
      } catch (e) { caught = e; }
      const elapsed = Date.now() - receivedAt;
      held?.destroy();
      assert((caught as Error)?.name === 'DialogueDeadlineError', `error ${String(caught)}`);
      assert(synthCalls.length === 0, `local synth calls ${synthCalls.length}`);
      assert(receivedAt > 0 && elapsed >= 300 && elapsed < 1500, `rejected ${elapsed} ms after the remote request`);
    });
  });

  await check('without TTS_SERVICE_URL the show is made locally', async () => {
    delete process.env.TTS_SERVICE_URL;
    const result = await generateShowVoice(LINES.slice(0, 2), 'he', { synthesize: fakeSynth });
    await fs.unlink(result.filePath).catch(() => {});
    assert(result.via === 'local' && result.lineCount === 2, JSON.stringify(result));
  });

  await check('a language without hosts and an empty show are refused', async () => {
    let enThrew = false;
    let emptyThrew = false;
    try { await generateShowVoice(LINES, 'en', { synthesize: fakeSynth }); } catch { enThrew = true; }
    try { await generateShowVoice([], 'he', { synthesize: fakeSynth }); } catch { emptyThrew = true; }
    assert(enThrew && emptyThrew, `en ${enThrew} empty ${emptyThrew}`);
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
