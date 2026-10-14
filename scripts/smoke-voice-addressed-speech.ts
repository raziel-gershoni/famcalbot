// Smoke test for the addressed-speech gate in processVoiceWithGemini. TV or radio is
// speech, so the speech-presence check passes it, and the calendar-primed extraction
// turned a promo ("Don't miss the season finale, this Thursday at 9...") into a create
// at confidence "medium" or "high". A second context-free check asks whether the speech
// was meant for the device. On a NO, a parse whose actions are all below "high" is
// dropped; real commands come back "high", so a "high" parse is kept but flagged
// notAddressed, which the handlers read as "never auto-create".
//
// The Gemini client is faked with the replies measured live, and the clip is a loud
// tone made with the repo's own encoder, so it clears the acoustic gate and the model
// checks decide. No network, no database.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-voice-addressed-speech.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-voice-addressed-speech.ts

import Module from 'node:module';
import path from 'node:path';
import type { CalendarAssignment } from '../src/types';

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

// ---- Environment: fakes only, set before anything under test loads ----

process.env.GEMINI_API_KEY = 'test-key';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

// ---- Fakes ----

type Verdict = 'YES' | 'NO' | 'THROW';

/** What each model call answers, set per check. */
let presence: Verdict = 'YES';
let addressed: Verdict = 'NO';
let extraction: object = {};
let addressedAsked = 0;

const SPEECH_PROMPT = 'Does this audio contain human speech';
const ADDRESSED_PROMPT = 'Is a person in this recording speaking to the device';

const PROMO = "Don't miss the season finale, this Thursday at 9, only on Channel 12.";
const promoCreate = (confidence: string) => ({
  transcription: PROMO,
  intent: 'create',
  confidence,
  event: {
    title: 'Season Finale', startDate: '2026-10-15', startTime: '21:00', endDate: '2026-10-15', endTime: '22:00',
    allDay: false, calendarId: 'primary',
  },
  error: null,
  needsClarification: false,
});

const CALENDARS = [{ calendarId: 'primary', name: 'Me', labels: ['primary'] }] as unknown as CalendarAssignment[];
const IL = 'Asia/Jerusalem';

/** The one Gemini client both the extraction and the context-free checks call. */
const fakeGemini = {
  models: {
    generateContent: async (request: { contents: Array<{ parts: Array<{ text?: string }> }> }) => {
      const prompt = request.contents[0].parts[0].text ?? '';
      const verdict = (v: Verdict) => {
        if (v === 'THROW') throw new Error('stub timeout');
        return { text: v };
      };
      if (prompt.startsWith(SPEECH_PROMPT)) return verdict(presence);
      if (prompt.startsWith(ADDRESSED_PROMPT)) {
        addressedAsked++;
        return verdict(addressed);
      }
      return {
        text: '```json\n' + JSON.stringify(extraction) + '\n```',
        usageMetadata: { promptTokenCount: 3183, candidatesTokenCount: 220 },
      };
    },
  },
};

// The real ai-provider loads every AI client; the voice modules need only getGemini.
const AI_PROVIDER = path.resolve(__dirname, '../src/services/ai-provider.ts');
const ModuleInternals = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (request: string, parent: unknown, isMain: boolean) => string;
};
const realLoad = ModuleInternals._load;
ModuleInternals._load = function (request, parent, isMain) {
  let resolved = request;
  try {
    resolved = ModuleInternals._resolveFilename(request, parent, isMain);
  } catch {}
  if (resolved === AI_PROVIDER) return { getGemini: () => fakeGemini, extractionConfig: () => ({}) };
  return realLoad.call(this, request, parent, isMain);
};

async function main() {
  const { processVoiceWithGemini } = await import('../src/services/voice/gemini-voice');
  const { encodePcmToOggOpus } = await import('../src/utils/pcm-to-ogg-opus');

  // 2 s of a loud 220 Hz tone at the encoder's 24 kHz.
  const n = 48000;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 24000) * 12000), i * 2);
  const audio = encodePcmToOggOpus(pcm);

  const run = async (opts: { presence?: Verdict; addressed: Verdict; extraction: object }) => {
    presence = opts.presence ?? 'YES';
    addressed = opts.addressed;
    extraction = opts.extraction;
    addressedAsked = 0;
    return processVoiceWithGemini(audio, 'en', CALENDARS, IL);
  };

  await check('a medium-confidence create the check says was not addressed is dropped, keeping its transcript and metrics', async () => {
    const r = await run({ addressed: 'NO', extraction: promoCreate('medium') });
    assert(!r.intentResult.event, `kept the event "${r.intentResult.event?.title}"`);
    assert(r.intentResult.intent === 'create' && r.intentResult.confidence === 'low', `intent ${r.intentResult.intent}/${r.intentResult.confidence}`);
    assert(r.intentResult.error === 'not_addressed', `error ${r.intentResult.error}`);
    assert(r.intentResults?.length === 1 && r.intentResults[0] === r.intentResult, `intentResults ${JSON.stringify(r.intentResults)}`);
    assert(r.transcription === PROMO, `transcription "${r.transcription}"`);
    assert(r.metrics.inputTokens === 3183 && r.metrics.outputTokens === 220, `metrics ${JSON.stringify(r.metrics)}`);
    assert(addressedAsked === 1, `asked ${addressedAsked} times`);
  });

  await check('a high-confidence create the check says NO to is kept, flagged so it never auto-creates', async () => {
    const r = await run({ addressed: 'NO', extraction: promoCreate('high') });
    assert(r.intentResult.event?.title === 'Season Finale', `event ${r.intentResult.event?.title}, error ${r.intentResult.error}`);
    assert(r.intentResult.confidence === 'high', `confidence ${r.intentResult.confidence}`);
    assert(r.intentResult.notAddressed === true, `notAddressed ${r.intentResult.notAddressed}`);
    assert(r.intentResults?.length === 1 && r.intentResults[0] === r.intentResult, `intentResults ${JSON.stringify(r.intentResults)}`);
    assert(r.transcription === PROMO, `transcription "${r.transcription}"`);
  });

  await check('a high-confidence create the check says was addressed is not flagged', async () => {
    const r = await run({ addressed: 'YES', extraction: promoCreate('high') });
    assert(r.intentResult.event?.title === 'Season Finale', `event ${r.intentResult.event?.title}, error ${r.intentResult.error}`);
    assert(r.intentResult.notAddressed === undefined, `notAddressed ${r.intentResult.notAddressed}`);
  });

  await check('a medium-confidence create the check says was addressed is kept', async () => {
    const r = await run({ addressed: 'YES', extraction: promoCreate('medium') });
    assert(r.intentResult.event?.title === 'Season Finale', `event ${r.intentResult.event?.title}, error ${r.intentResult.error}`);
    assert(r.intentResult.notAddressed === undefined, `notAddressed ${r.intentResult.notAddressed}`);
    assert(addressedAsked === 1, `asked ${addressedAsked} times`);
  });

  await check('a medium-confidence create is kept when the check fails (fail open)', async () => {
    const r = await run({ addressed: 'THROW', extraction: promoCreate('medium') });
    assert(r.intentResult.event?.title === 'Season Finale', `event ${r.intentResult.event?.title}, error ${r.intentResult.error}`);
    assert(addressedAsked === 1, `asked ${addressedAsked} times`);
  });

  await check('a medium-confidence delete (an event reference) the check says was not addressed is dropped', async () => {
    const r = await run({
      addressed: 'NO',
      extraction: {
        transcription: 'The match is cancelled tonight because of the rain.',
        intent: 'delete', confidence: 'medium',
        eventReference: { type: 'by_description', description: 'the match', timeHint: 'tonight' },
        scope: 'single', error: null,
      },
    });
    assert(r.intentResult.intent === 'create' && !r.intentResult.eventReference, `intent ${r.intentResult.intent}`);
    assert(r.intentResult.error === 'not_addressed', `error ${r.intentResult.error}`);
  });

  await check('several actions are kept, all flagged, when any one is high and the check says NO', async () => {
    const r = await run({
      addressed: 'NO',
      extraction: { transcription: PROMO, intents: [promoCreate('high'), promoCreate('medium')] },
    });
    const kept = (r.intentResults ?? []).filter(i => i.event);
    assert(kept.length === 2, `kept ${kept.length} of 2: ${JSON.stringify(r.intentResults?.map(i => i.error ?? i.confidence))}`);
    assert(kept.every(i => i.notAddressed === true) && r.intentResult.notAddressed === true, `flags ${JSON.stringify(r.intentResults?.map(i => i.notAddressed))}`);
  });

  await check('a parse with no action is returned as it was, whatever the check says', async () => {
    const r = await run({
      addressed: 'NO',
      extraction: { transcription: 'And now the weather.', intent: 'create', confidence: 'low', event: null, error: 'No calendar event detected.' },
    });
    assert(r.intentResult.error === 'No calendar event detected.', `error ${r.intentResult.error}`);
    assert(r.transcription === 'And now the weather.', `transcription "${r.transcription}"`);
  });

  await check('audio the speech check says has no speech is still no_speech', async () => {
    const r = await run({ presence: 'NO', addressed: 'NO', extraction: promoCreate('medium') });
    assert(r.intentResult.error === 'no_speech', `error ${r.intentResult.error}`);
    assert(r.transcription === '', `transcription "${r.transcription}"`);
  });
}

async function runAll() {
  const log = console.log;
  // The pipeline logs every call; only the results are wanted here.
  console.log = () => {};
  console.warn = () => {};
  try {
    await main();
  } finally {
    console.log = log;
  }
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed === 0 ? 0 : 1);
}

runAll().catch(err => {
  console.error(err);
  process.exit(1);
});
