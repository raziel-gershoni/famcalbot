// Smoke test for the weather briefing prompt and the time-of-day greeting.
// The hazard rules used to name sharav and dust storm in Hebrew, Russian and English
// in every prompt, so the model echoed all three. The prompt also gave the model only
// the raw clock, and between 00:00 and 04:59 it wrote "Good morning"; the digest
// header said the same. Now one language's hazard words reach the model, and the
// greeting comes from code, with a neutral hello before 05:00. No network: Gemini is
// stubbed to capture the prompt.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-weather-prompt.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-weather-prompt.ts

// Fake credentials so importing the services needs no real environment.
process.env.DATABASE_URL ??= 'postgresql://test@db.invalid/test';
process.env.DIRECT_URL ??= 'postgresql://test@db.invalid/test';
process.env.GEMINI_API_KEY ??= 'test';
process.env.OPENAI_API_KEY ??= 'test';
process.env.ANTHROPIC_API_KEY ??= 'test';
process.env.UPSTASH_REDIS_REST_URL ??= 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'test';
process.env.TELEGRAM_BOT_TOKEN ??= 'test';

import fs from 'fs';
import path from 'path';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];
// Checks run one after another: they share the stubbed Gemini's last prompt.
let chain: Promise<void> = Promise.resolve();

function check(name: string, fn: () => void | Promise<void>) {
  chain = chain.then(async () => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---- Frozen clock (for formatDateHeader, which reads the clock itself) ----
const RealDate = Date;
let frozen = RealDate.now();
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(frozen);
    else super(...(args as [number, number, number, number, number, number, number]));
  }
  static now() {
    return frozen;
  }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

const TZ = 'Asia/Jerusalem';
/** Wall-clock time on 13 Oct 2026 in Jerusalem (UTC+3). */
const at = (hhmm: string) => new RealDate(`2026-10-13T${hhmm}:00+03:00`);

const loadFixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

async function main() {
  const { getGemini } = await import('../src/services/ai-provider');
  let lastPrompt = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (getGemini().models as any).generateContent = async (req: any) => {
    lastPrompt = String(req.contents);
    return { text: 'stub', candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
  };
  const { formatWeatherAI } = await import('../src/services/weather/formatter');
  const { formatDateHeader } = await import('../src/services/claude');
  const { timeOfDayGreeting } = await import('../src/utils/greeting');

  const dust = loadFixture('weather-en-dust-storm.json');
  const sharav = loadFixture('weather-he-sharav-heatwave.json');

  async function promptFor(fx: typeof dust, lang: string, when: Date, name = 'X'): Promise<string> {
    lastPrompt = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (formatWeatherAI as any)(fx.weather, lang, name, TZ, 'default', false, false, fx.airQuality, when);
    return lastPrompt;
  }
  const ruleLines = (prompt: string) =>
    prompt.split('\n').filter(l => l.startsWith('- When sharav') || l.startsWith('- When dustStorm'));

  const TERMS: Record<string, string[]> = {
    en: ['sharav', 'dust storm'],
    he: ['שרב', 'סופת אבק'],
    ru: ['хамсин', 'пылевая буря'],
  };

  // ---- Hazard terms: only the target language's reach the model ----
  for (const lang of ['en', 'he', 'ru']) {
    for (const [label, fx] of [['dust', dust], ['sharav', sharav]] as const) {
      check(`${lang}/${label}: the rules name the target terms and no other language's`, async () => {
        const prompt = await promptFor(fx, lang, at('12:00'));
        const rules = ruleLines(prompt);
        assert(rules.length === 2, `expected 2 hazard rules, got ${rules.length}`);
        // "sharav data" names the JSON key the model reads, not a word to say.
        const text = rules.join('\n').replace('When sharav data', 'When the sharav key').replace('sharav key', 'key').toLowerCase();
        for (const t of TERMS[lang]) assert(text.includes(t), `missing "${t}"`);
        for (const other of Object.keys(TERMS).filter(l => l !== lang)) {
          for (const t of TERMS[other]) assert(!text.includes(t), `leaks ${other} term "${t}"`);
        }
        assert(!prompt.includes('sharav/heatwave'), 'still has "sharav/heatwave"');
        if (lang === 'en') assert(!/[֐-׿Ѐ-ӿ]/.test(rules.join('')), 'en rules have Hebrew or Cyrillic');
        if (lang === 'ru') assert(!/[֐-׿]/.test(rules.join('')), 'ru rules have Hebrew');
        if (lang === 'he') assert(!/[Ѐ-ӿ]/.test(rules.join('')), 'he rules have Cyrillic');
      });
    }
  }

  // ---- The greeting the weather prompt hands the model ----
  const HELLO: Record<string, string> = { en: 'Hello', he: 'שלום', ru: 'Здравствуйте' };
  for (const lang of ['en', 'he', 'ru']) {
    check(`${lang}: weather prompt greets with "${HELLO[lang]}" at 00:32`, async () => {
      const prompt = await promptFor(dust, lang, at('00:32'), 'Dana');
      assert(prompt.includes(`- Open with "${HELLO[lang]}" and the person's name (Dana)`), 'no neutral hello rule');
      assert(!/Good morning|בוקר טוב|Доброе утро/.test(prompt), 'still says good morning');
    });
  }
  check('en: weather prompt says "Good morning" at 07:30 and "Good evening" at 19:00', async () => {
    const morning = await promptFor(dust, 'en', at('07:30'), 'Dana');
    assert(morning.includes('- Open with "Good morning" and'), `07:30: ${morning.split('\n').find(l => l.includes('Open with'))}`);
    const evening = await promptFor(dust, 'en', at('19:00'), 'Dana');
    assert(evening.includes('- Open with "Good evening" and'), `19:00: ${evening.split('\n').find(l => l.includes('Open with'))}`);
  });
  check('weather prompt clock line follows the passed time', async () => {
    const prompt = await promptFor(dust, 'en', at('00:32'));
    assert(prompt.includes('The current local time is 00:32'), 'clock line not 00:32');
  });

  // ---- timeOfDayGreeting bands ----
  const BANDS: [number, string, string, string][] = [
    [0, 'Hello', 'שלום', 'Здравствуйте'],
    [4, 'Hello', 'שלום', 'Здравствуйте'],
    [5, 'Good morning', 'בוקר טוב', 'Доброе утро'],
    [11, 'Good morning', 'בוקר טוב', 'Доброе утро'],
    [12, 'Good afternoon', 'צהריים טובים', 'Добрый день'],
    [17, 'Good afternoon', 'צהריים טובים', 'Добрый день'],
    [18, 'Good evening', 'ערב טוב', 'Добрый вечер'],
    [23, 'Good evening', 'ערב טוב', 'Добрый вечер'],
  ];
  check('timeOfDayGreeting bands in en/he/ru', () => {
    for (const [hour, en, he, ru] of BANDS) {
      for (const [lang, want] of [['en', en], ['he', he], ['ru', ru]] as const) {
        const got = timeOfDayGreeting(hour, lang);
        assert(got === want, `${lang} ${hour}h: got "${got}", want "${want}"`);
      }
    }
  });
  check('timeOfDayGreeting: unknown language falls back to English', () => {
    assert(timeOfDayGreeting(8, 'fr') === 'Good morning', 'fr 8h');
    assert(timeOfDayGreeting(2) === 'Hello', 'default 2h');
  });

  // ---- The digest header ----
  check('formatDateHeader: "Hello" at 00:32, "Good evening!" at 22:30', () => {
    frozen = at('00:32').getTime();
    const night = formatDateHeader(new Date(), 'en', undefined, TZ).split('\n')[0];
    assert(night === '<b>Hello!</b>', `00:32 header ${night}`);
    frozen = at('22:30').getTime();
    const evening = formatDateHeader(new Date(), 'en', undefined, TZ).split('\n')[0];
    assert(evening === '<b>Good evening!</b>', `22:30 header ${evening}`);
  });

  await chain;
}

main()
  .catch(err => {
    results.push({ name: 'smoke setup', ok: false, reason: err instanceof Error ? err.message : String(err) });
  })
  .finally(() => {
    let failed = 0;
    for (const r of results) {
      console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
      if (!r.ok) failed++;
    }
    console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
    process.exit(failed ? 1 : 0);
  });
