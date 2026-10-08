// Live evaluation: does the voice pipeline stay quiet when there is no speech, and
// still act on real commands?
//
// Builds a corpus of voice notes - real commands in Hebrew, English and Russian, and
// non-speech (silence, room tone, a tap, pocket rustle, noise, a tone, music, a TV in
// the background) - and runs each through processVoiceWithGemini(), the same entry
// point Telegram and WhatsApp use.
//
// Before the speech gates existed, every non-speech clip produced a high-confidence
// create, edit or delete on both 3.7 and 3.8. Re-run this after any change to the
// voice prompt, the extraction model, or the gates.
//
// Expected: every real command acted on, and no non-speech clip producing an action -
// except loud broadband noise ("pinknoise"), which the model-based gate still lets
// through now and then (measured ~1 run in 6-16 on both 3.7 and 3.8). Anything else
// failing is a regression.
//
// COSTS MONEY: it calls the Gemini API (clips x runs x models, each with a second
// small gate call). Needs macOS `say` (with the Carmit and Milena voices) and ffmpeg
// to build the corpus.
//
// Run:
//   NODE_OPTIONS='--conditions=import' npx tsx -r dotenv/config scripts/eval-voice-no-speech.ts
// Options (env): EVAL_MODELS=gemini-3.7-flash,gemini-3.8-flash  EVAL_RUNS=3

import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CalendarAssignment } from '../src/types';

const MODELS = (process.env.EVAL_MODELS || 'gemini-3.7-flash').split(',');
const RUNS = Number(process.env.EVAL_RUNS || 3);

type Clip = { name: string; language: string; expect: 'create' | 'delete' | 'none' };

const CLIPS: Clip[] = [
  { name: 'he_create', language: 'he', expect: 'create' },
  { name: 'he_create_noisy', language: 'he', expect: 'create' },
  { name: 'he_delete_short', language: 'he', expect: 'delete' },
  { name: 'en_create', language: 'en', expect: 'create' },
  { name: 'en_delete', language: 'en', expect: 'delete' },
  { name: 'ru_create', language: 'ru', expect: 'create' },
  // A real command said quietly, inside a mostly-quiet note. A whole-clip loudness
  // average dropped this as silence; it must reach the model and be acted on.
  { name: 'he_quiet_farfield', language: 'he', expect: 'create' },
  { name: 'silence', language: 'he', expect: 'none' },
  { name: 'roomtone', language: 'he', expect: 'none' },
  { name: 'short', language: 'he', expect: 'none' },
  { name: 'pocket', language: 'he', expect: 'none' },
  { name: 'pinknoise', language: 'he', expect: 'none' },
  { name: 'tone', language: 'he', expect: 'none' },
  { name: 'music', language: 'he', expect: 'none' },
  { name: 'tv_background', language: 'en', expect: 'none' },
];

function run(cmd: string, args: string[]) {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function buildCorpus(dir: string) {
  const ff = (args: string[]) => run('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
  const toOgg = (input: string, name: string) =>
    ff(['-i', input, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '24k', join(dir, `${name}.ogg`)]);
  const say = (voice: string, text: string, name: string) => {
    const aiff = join(dir, `${name}.aiff`);
    run('say', ['-v', voice, '-o', aiff, text]);
    toOgg(aiff, name);
  };

  say('Carmit', 'תוסיף לי פגישה עם רופא שיניים מחר בשלוש', 'he_create');
  say('Carmit', 'תבטל את זה', 'he_delete_short');
  say('Samantha', 'Add a dentist appointment tomorrow at three', 'en_create');
  say('Samantha', 'Cancel the karate class', 'en_delete');
  say('Milena', 'Добавь встречу с врачом завтра в три часа', 'ru_create');

  // 30 dB quieter, 6 s of near-silence before it, 15 s total.
  ff(['-i', join(dir, 'he_create.aiff'), '-f', 'lavfi', '-i', 'anoisesrc=d=15:c=pink:a=0.0003',
    '-filter_complex', '[0:a]aresample=48000,volume=-30dB,adelay=6000:all=1,apad=whole_dur=15[s];[s][1:a]amix=inputs=2:duration=first:normalize=0',
    '-ac', '1', '-t', '15', join(dir, 'he_quiet_farfield.wav')]);
  toOgg(join(dir, 'he_quiet_farfield.wav'), 'he_quiet_farfield');

  ff(['-i', join(dir, 'he_create.aiff'), '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=pink:a=0.06',
    '-filter_complex', '[0:a]aresample=48000,apad=pad_dur=1[s];[s][1:a]amix=inputs=2:duration=shortest', '-ac', '1',
    join(dir, 'he_create_noisy.wav')]);
  toOgg(join(dir, 'he_create_noisy.wav'), 'he_create_noisy');

  const lavfi = (source: string, name: string, extra: string[] = []) => {
    ff(['-f', 'lavfi', '-i', source, ...extra, join(dir, `${name}.wav`)]);
    toOgg(join(dir, `${name}.wav`), name);
  };
  lavfi('anullsrc=r=48000:cl=mono', 'silence', ['-t', '2']);
  lavfi('anoisesrc=d=3:c=pink:a=0.003', 'roomtone');
  lavfi('anoisesrc=d=0.5:c=pink:a=0.01', 'short');
  lavfi('anoisesrc=d=3:c=brown:a=0.4', 'pocket', ['-af', "volume='0.5+0.5*sin(2*PI*3*t)':eval=frame"]);
  lavfi('anoisesrc=d=3:c=pink:a=0.3', 'pinknoise');
  lavfi('sine=frequency=440:duration=2', 'tone');
  lavfi("aevalsrc='0.2*sin(2*PI*261.6*t)+0.2*sin(2*PI*329.6*t)+0.2*sin(2*PI*392*t)':d=3", 'music');

  run('say', ['-v', 'Samantha', '-o', join(dir, 'tv.aiff'), 'And now the weather. Tomorrow will be sunny with highs of twenty eight degrees.']);
  ff(['-i', join(dir, 'tv.aiff'), '-f', 'lavfi', '-i', 'anoisesrc=d=8:c=pink:a=0.02',
    '-filter_complex', '[0:a]aresample=48000,lowpass=f=2500,volume=0.25,apad=pad_dur=1[s];[s][1:a]amix=inputs=2:duration=shortest', '-ac', '1',
    join(dir, 'tv.wav')]);
  toOgg(join(dir, 'tv.wav'), 'tv_background');
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'famcal-voice-eval-'));
  try {
    buildCorpus(dir);
  } catch (err) {
    console.error('Could not build the corpus - this needs macOS `say` (Carmit, Milena, Samantha voices) and ffmpeg.');
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }

  const { processVoiceWithGemini } = await import('../src/services/voice/gemini-voice');
  const { formatRecentEventsBlock } = await import('../src/services/voice/recent-events-store');

  const calendars = [
    { calendarId: 'primary', name: 'Me', labels: ['yours', 'primary'] },
    { calendarId: 'cal-spouse', name: 'Dana', labels: ['spouse'], personName: 'Dana' },
    { calendarId: 'cal-kids', name: 'Kids', labels: ['kids'] },
  ] as unknown as CalendarAssignment[];
  // Real titles in context are what pull fabricated commands toward real events.
  const now = Date.now();
  const recent = formatRecentEventsBlock([
    { provider: 'google', calendarId: 'primary', eventId: 'e1', title: 'משמרת', startsAt: new Date(now + 864e5).toISOString(), endsAt: new Date(now + 864e5 + 288e5).toISOString(), action: 'create' },
    { provider: 'google', calendarId: 'cal-kids', eventId: 'e2', title: 'קראטה', startsAt: new Date(now + 1728e5).toISOString(), endsAt: new Date(now + 1728e5 + 36e5).toISOString(), action: 'create' },
    { provider: 'google', calendarId: 'primary', eventId: 'e3', title: 'טיפול שיניים', startsAt: new Date(now + 2592e5).toISOString(), endsAt: new Date(now + 2592e5 + 36e5).toISOString(), action: 'edit' },
  ] as never, 'Asia/Jerusalem');

  let failures = 0;
  for (const model of MODELS) {
    // The resolver reads AI_MODEL at call time; runs are serial because it is global.
    process.env.AI_MODEL = model;
    console.log(`\n=== ${model} (${RUNS} runs per clip)`);
    let noiseActions = 0, noiseRuns = 0, speechOk = 0, speechRuns = 0;

    for (const clip of CLIPS) {
      const audio = readFileSync(join(dir, `${clip.name}.ogg`));
      const outcomes: string[] = [];
      for (let r = 0; r < RUNS; r++) {
        try {
          const { intentResult } = await processVoiceWithGemini(audio, clip.language, calendars, 'Asia/Jerusalem', recent);
          const it = intentResult;
          const acts = it.intent === 'create' ? !!it.event : !!it.eventReference;
          outcomes.push(it.error === 'no_speech' ? 'no_speech' : acts ? it.intent : 'no_action');
        } catch {
          outcomes.push('error');
        }
      }
      const ok = clip.expect === 'none'
        ? outcomes.every(o => !['create', 'edit', 'delete'].includes(o))
        : outcomes.every(o => o === clip.expect);
      if (clip.expect === 'none') {
        noiseRuns += outcomes.length;
        noiseActions += outcomes.filter(o => ['create', 'edit', 'delete'].includes(o)).length;
      } else {
        speechRuns += outcomes.length;
        speechOk += outcomes.filter(o => o === clip.expect).length;
      }
      if (!ok) failures++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${clip.name.padEnd(16)} expect=${clip.expect.padEnd(6)} got=[${outcomes.join(',')}]`);
    }
    console.log(`  -> non-speech produced an action ${noiseActions}/${noiseRuns}; real commands correct ${speechOk}/${speechRuns}`);
  }

  console.log(failures === 0 ? '\nALL CLIPS PASSED' : `\n${failures} clip result(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
