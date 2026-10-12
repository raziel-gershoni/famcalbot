// The show pipeline wired end to end with the LLM and Gemini faked: captions, cost,
// routing by language, and the narrator fallback when a host voice is missing.
// No network.
//
// Run: npx tsx scripts/smoke-voice-show-produce.ts

import fs from 'fs/promises';
import type { AICompletionResult } from '../src/services/ai-provider';
import { TtsHttpError, type SpeechAudio, type SynthesizeSpeechInput } from '../src/services/gemini-tts';
import type { UserConfig } from '../src/types';
import { estimateTtsCost, formatShowCaption, formatVoiceCaption } from '../src/utils/ai-footer';

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

const RATE = 24000;
function tone(ms: number): Buffer {
  const n = Math.round((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2);
  return b;
}

const writer: AICompletionResult = {
  text: '', usage: { inputTokens: 1200, outputTokens: 300 }, stopReason: 'STOP', model: 'Gemini 3.8 Flash', durationMs: 4200,
};
const SCRIPT = JSON.stringify({ turns: [
  { host: 'A', mood: 'hype', text: 'בוקר טוב דני! <chuckle>' },
  { host: 'B', mood: 'amused', text: 'יש לך יום ענק!' },
  { host: 'A', mood: 'hype', text: 'באחת עשרה פגישה עם לוי.' },
  { host: 'B', mood: 'warm', text: 'שיהיה יום מנצח!' },
] });
const user = { id: 1, name: 'דני', gender: 'male', language: 'he', isAdmin: true, calendarAssignments: [] } as unknown as UserConfig;
const fakeComplete = async () => ({ ...writer, text: SCRIPT });
const fakeSynth = async (_input: SynthesizeSpeechInput): Promise<SpeechAudio> =>
  ({ pcm: tone(500), sampleRate: RATE, mimeType: 'audio/l16', audioTokens: 12 });

async function main() {
  delete process.env.TTS_SERVICE_URL;
  const { isShowLanguage, produceShowVoice } = await import('../src/services/voice-show/produce');

  await check('cost estimate: 1500 audio tokens on 3.8 Flash TTS', () => {
    assert(Math.abs((estimateTtsCost('gemini-3.8-flash-tts', 1500) ?? 0) - 0.0135) < 1e-9, 'cost');
    assert(estimateTtsCost('gemini-unknown-tts', 1500) === null, 'unknown model');
    assert(estimateTtsCost('gemini-3.8-flash-tts', 0) === null, 'no tokens');
  });

  await check('show caption: admin only, with hosts, lines, length, model, cost', () => {
    const show = {
      ttsMs: 6100, ttsModel: 'gemini-3.8-flash-tts', voices: { A: 'voice_a1', B: 'voice_b2' },
      lineCount: 12, audioSeconds: 52.4, audioTokens: 1500, via: 'local' as const,
    };
    assert(formatShowCaption(writer, 1, show, false) === undefined, 'shown to a non-admin');
    const caption = formatShowCaption(writer, 2, show, true)!;
    for (const part of ['🎙 Gemini 3.8 Flash', 'rewritten x1', '🔊 TTS gemini-3.8-flash-tts', 'A:voice_a1 B:voice_b2', '12 lines', '52s audio', '6.1s', 'local', '~$0.0135']) {
      assert(caption.includes(part), `"${part}" missing from: ${caption}`);
    }
  });

  await check('narrator caption no longer takes a style', () => {
    const caption = formatVoiceCaption(writer, 3000, 'gemini-3.8-flash-tts', true, 'Algieba')!;
    assert(caption.includes('| Algieba |') && !caption.includes('style:'), caption);
  });

  await check('only Hebrew has the show', () => {
    assert(isShowLanguage('he') && !isShowLanguage('en') && !isShowLanguage('ru'), 'routing');
  });

  await check('produceShowVoice: script → lines → mixed OGG with admin caption', async () => {
    const voice = await produceShowVoice('summary', user, 'daily', false, { complete: fakeComplete, synthesize: fakeSynth });
    try {
      assert((await fs.readFile(voice.filePath)).subarray(0, 4).toString('ascii') === 'OggS', 'not Ogg');
      assert(voice.durationSeconds >= 2, `duration ${voice.durationSeconds}`);
      assert(!!voice.caption && voice.caption.includes('4 lines') && voice.caption.includes('local'), `caption ${voice.caption}`);
    } finally {
      await fs.unlink(voice.filePath).catch(() => {});
    }
  });

  await check('missing host voice: the narrator reads the same script', async () => {
    const narrated: string[] = [];
    const missing = async (): Promise<SpeechAudio> => {
      throw new TtsHttpError('Gemini TTS gemini-3.8-flash-tts returned 404: The voice was not found or the caller does not have permission to access it.', 404);
    };
    const voice = await produceShowVoice('summary', user, 'daily', false, {
      complete: fakeComplete,
      synthesize: missing,
      narrate: async text => { narrated.push(text); return { filePath: '/tmp/narrator-fake.opus', ttsMs: 900, ttsModel: 'gemini-3.8-flash-tts', voiceName: 'Algieba' }; },
    });
    assert(narrated.length === 1, `narrate calls ${narrated.length}`);
    assert(!narrated[0].includes('<') && narrated[0].includes('בוקר טוב דני'), `narration ${narrated[0]}`);
    assert(narrated[0].normalize('NFC').includes('בְּאַחַת עֶשְׂרֵה'.normalize('NFC')), 'narration not pointed');
    assert(voice.filePath === '/tmp/narrator-fake.opus', voice.filePath);
    assert(!!voice.caption && voice.caption.includes('narrator fallback'), `caption ${voice.caption}`);
  });

  await check('other TTS errors are not hidden by the fallback', async () => {
    let error: unknown;
    try {
      await produceShowVoice('summary', user, 'daily', false, {
        complete: fakeComplete,
        synthesize: async () => { throw new TtsHttpError('Gemini TTS x returned 400: bad request', 400); },
        narrate: async () => { throw new Error('narrator must not be used'); },
      });
    } catch (e) { error = e; }
    assert((error as { status?: number })?.status === 400, `error ${String(error)}`);
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
