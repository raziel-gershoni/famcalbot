// Smoke test for what the model says about a zman (zman reminders by voice plan, Tasks 2 and 3):
//   - the mapper readZmanFromModel (src/services/zmanim/spec.ts): a name with an optional opinion, or halachic hours,
//     plus an offset, becomes the stored rule under a community's set. Three results: a spec, the choices (the name has
//     several opinions in the set and none was said: nothing is defaulted), or a refusal (not offered, unknown, bad number);
//   - the parser (parseReminderCreate in gemini-voice.ts): the model's `zman` on a reminder is read strictly, forces a
//     date-only reminder, and a bad shape or a clash (anchor, clock time, an event) is warned about and refused.
// Pure. The model is not called; a fetch throws. Run under any process zone:
//   npx tsx scripts/smoke-zman-model.ts

import { readFileSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { formatInTimeZone } from 'date-fns-tz';
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

process.env.NEXT_PUBLIC_APP_URL = 'https://famcal.test';
process.env.GEMINI_API_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://test@db.invalid/test';
globalThis.fetch = (async () => {
  throw new Error('network is blocked in this smoke test');
}) as typeof fetch;

// @hebcal/core is ESM-only and tsx loads src/ as CommonJS: point it at its ESM build before the module under test loads
const internals = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolveFilename = internals._resolveFilename;
internals._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
  return resolveFilename.call(this, request, ...rest);
};

const print = console.log.bind(console);
const warnings: string[] = [];
console.log = () => {};
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(' '));
};

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const NOW = new Date('2026-10-28T09:00:00Z');
const CALENDARS: CalendarAssignment[] = [
  { calendarId: 'native:cmain00000000000000000001', name: 'Raziel', labels: ['primary', 'yours'], color: '#4285f4' },
];

async function main() {
  const { readZmanFromModel, asZmanSpec, offeredIn, reminderZmanim } = await import('../src/services/zmanim/spec');
  const { COMMUNITIES, ZMAN_KEYS, zmanimSet } = await import('../src/services/zmanim/sets');
  const { parseGeminiEventResponse, buildEventExtractionPrompt } = await import('../src/services/voice/gemini-voice');
  type Community = (typeof COMMUNITIES)[number];

  const read = (name: string, opinion: string | null, offsetMinutes: number | undefined, community: Community) =>
    readZmanFromModel({ name, ...(opinion === undefined ? {} : { opinion }), ...(offsetMinutes === undefined ? {} : { offsetMinutes }) }, community);
  const specKey = (r: ReturnType<typeof readZmanFromModel>) => (r.kind === 'spec' && 'zman' in r.spec ? r.spec.zman : `<${r.kind}>`);

  // ---- The mapper ----

  /** The name a model says for a key: the key without its opinion suffix. */
  const nameOf = (key: string) => key.replace(/_(GRA|MGA|HALACHA_BERURA|YALKUT_YOSEF)$/, '');

  await check('every key of every set a reminder can use is reachable by its name and the opinion its set gives it', () => {
    for (const community of COMMUNITIES) {
      for (const key of reminderZmanim(community)) {
        const opinion = zmanimSet(community).zmanim[key]?.opinion ?? null;
        const named = read(nameOf(key), opinion, -10, community);
        assert(specKey(named) === key, `${community} ${key} by name+opinion: ${JSON.stringify(named)}`);
        const bare = read(nameOf(key), null, -10, community);
        if (bare.kind === 'spec') assert(specKey(bare) === key, `${community} ${key} bare: ${JSON.stringify(bare)}`);
        else assert(bare.kind === 'choose' && bare.specs.some((s) => 'zman' in s && s.zman === key), `${community} ${key} bare: ${JSON.stringify(bare)}`);
      }
    }
  });

  await check('the choices per community: Sephardi Shema 2 and plag 2, Ashkenazi Shema 2 and plag 1, Chabad 1 and 1', () => {
    const want: Record<Community, [number, number]> = { sephardi: [2, 2], ashkenazi: [2, 1], chabad: [1, 1] };
    for (const community of COMMUNITIES) {
      const counts = (['SOF_SHMA', 'PLAG'] as const).map((name) => {
        const r = read(name, null, 0, community);
        return r.kind === 'choose' ? r.specs.length : r.kind === 'spec' ? 1 : 0;
      });
      assert(counts[0] === want[community][0] && counts[1] === want[community][1], `${community}: ${counts}`);
    }
  });

  await check('choices come in the order of the day (ZMAN_KEYS), carry the offset, and are offered by the set', () => {
    const r = read('SOF_SHMA', null, -10, 'sephardi');
    assert(r.kind === 'choose', JSON.stringify(r));
    assert(JSON.stringify(r.specs) === JSON.stringify([{ zman: 'SOF_SHMA_MGA', offsetMin: -10 }, { zman: 'SOF_SHMA_GRA', offsetMin: -10 }]), JSON.stringify(r.specs));
    const plag = read('PLAG', null, 0, 'sephardi');
    assert(plag.kind === 'choose' && JSON.stringify(plag.specs.map((s) => ('zman' in s ? s.zman : ''))) === '["PLAG_HALACHA_BERURA","PLAG_YALKUT_YOSEF"]', JSON.stringify(plag));
    for (const community of COMMUNITIES) {
      for (const name of new Set(ZMAN_KEYS.map(nameOf))) {
        const got = read(name, null, 0, community);
        if (got.kind === 'choose') for (const s of got.specs) assert(offeredIn(s as never, community) && asZmanSpec(s) !== null, `${community} ${name}`);
      }
    }
  });

  await check('no name has more than 2 keys in any set (WhatsApp shows at most 3 reply buttons, one is Cancel)', () => {
    for (const community of COMMUNITIES) {
      const perName = new Map<string, number>();
      for (const key of reminderZmanim(community)) perName.set(nameOf(key), (perName.get(nameOf(key)) ?? 0) + 1);
      for (const [name, n] of perName) assert(n <= 2, `${community} ${name} has ${n} keys`);
    }
  });

  await check('a named opinion is used as said, with no choices', () => {
    assert(specKey(read('SOF_SHMA', 'gra', -10, 'sephardi')) === 'SOF_SHMA_GRA', 'gra');
    assert(specKey(read('SOF_SHMA', 'mga', -10, 'ashkenazi')) === 'SOF_SHMA_MGA', 'mga');
    assert(specKey(read('PLAG', 'yalkutYosef', 0, 'sephardi')) === 'PLAG_YALKUT_YOSEF', 'yy');
    assert(specKey(read('PLAG', 'halachaBerura', 0, 'sephardi')) === 'PLAG_HALACHA_BERURA', 'hb');
    assert(specKey(read('PLAG', 'gra', 0, 'ashkenazi')) === 'PLAG_GRA', 'ashkenazi plag gra');
  });

  await check('a Chabad reader who says GRA or the Baal HaTanya gets the one Shema key (their GRA key runs on his day)', () => {
    assert(specKey(read('SOF_SHMA', 'gra', 0, 'chabad')) === 'SOF_SHMA_GRA', 'gra');
    assert(specKey(read('SOF_SHMA', 'baalHatanya', 0, 'chabad')) === 'SOF_SHMA_GRA', 'baalHatanya');
    assert(specKey(read('PLAG', 'baalHatanya', 0, 'chabad')) === 'PLAG_GRA', 'plag');
    assert(specKey(read('SOF_SHMA', null, 0, 'chabad')) === 'SOF_SHMA_GRA', 'no opinion, one key, no buttons');
  });

  await check('a named opinion the set lacks is not_offered, and never switched', () => {
    const lacks: Array<[string, string, Community]> = [
      ['SOF_SHMA', 'mga', 'chabad'],
      ['SOF_SHMA', 'baalHatanya', 'sephardi'],
      ['PLAG', 'gra', 'sephardi'],
      ['PLAG', 'halachaBerura', 'ashkenazi'],
      ['PLAG', 'yalkutYosef', 'chabad'],
      ['SHKIA', 'gra', 'sephardi'],
    ];
    for (const [name, opinion, community] of lacks) {
      const r = read(name, opinion, 0, community);
      assert(r.kind === 'refuse' && r.reason === 'not_offered', `${community} ${name} ${opinion}: ${JSON.stringify(r)}`);
    }
  });

  await check('a zman the set lacks (stricter nightfall for Ashkenazi) or a reminder cannot use (end of Shabbat) is not_offered', () => {
    for (const [name, community] of [['TZEIT_LECHUMRA', 'ashkenazi'], ['TZEIT_LECHUMRA', 'chabad'], ['SHABBAT_ENDS', 'sephardi'], ['SHABBAT_ENDS', 'chabad']] as Array<[string, Community]>) {
      const r = read(name, null, 0, community);
      assert(r.kind === 'refuse' && r.reason === 'not_offered', `${community} ${name}: ${JSON.stringify(r)}`);
    }
    assert(specKey(read('TZEIT_LECHUMRA', null, 0, 'sephardi')) === 'TZEIT_LECHUMRA', 'sephardi has it');
  });

  await check('an unknown name, an opinion no one knows, or a shape that is not one is unknown', () => {
    const bad: unknown[] = [
      { name: 'RABBEINU_TAM', opinion: null, offsetMinutes: 0 },
      { name: '', opinion: null, offsetMinutes: 0 },
      { name: 'SOF_SHMA_GRA', opinion: null, offsetMinutes: 0 },
      { name: 'SOF_SHMA', opinion: 'rabbeinuTam', offsetMinutes: 0 },
      { name: 'SOF_SHMA', opinion: 5, offsetMinutes: 0 },
      { name: 5, offsetMinutes: 0 },
      { name: 'SHKIA', halachicHours: 3, offsetMinutes: 0 },
      { offsetMinutes: 5 },
      {},
      null,
      undefined,
      'SHKIA',
      42,
      [],
    ];
    for (const value of bad) {
      for (const community of COMMUNITIES) {
        const r = readZmanFromModel(value, community);
        assert(r.kind === 'refuse' && r.reason === 'unknown', `${JSON.stringify(value)} ${community}: ${JSON.stringify(r)}`);
      }
    }
  });

  await check('the name is read without case or padding', () => {
    assert(specKey(read(' shkia ', null, 0, 'sephardi')) === 'SHKIA', 'shkia');
    assert(specKey(read('Sof_Shma', ' GRA ', 0, 'sephardi')) === 'SOF_SHMA_GRA', 'gra');
  });

  await check('the offset is whole minutes within 12 hours, missing or null is 0, anything else is bad_offset', () => {
    for (const ok of [0, -10, 30, -30, 60, 720, -720, 7, -1]) {
      const r = read('SHKIA', null, ok, 'sephardi');
      assert(r.kind === 'spec' && r.spec.offsetMin === ok, `${ok}: ${JSON.stringify(r)}`);
    }
    for (const missing of [undefined, null]) {
      const r = readZmanFromModel({ name: 'SHKIA', opinion: null, offsetMinutes: missing }, 'sephardi');
      assert(r.kind === 'spec' && r.spec.offsetMin === 0, `${missing}: ${JSON.stringify(r)}`);
    }
    for (const bad of [721, -721, 1.5, -0.5, '10', '', NaN, Infinity, -Infinity, {}, true]) {
      for (const shape of [{ name: 'SHKIA', opinion: null, offsetMinutes: bad }, { halachicHours: 3, offsetMinutes: bad }, { name: 'SOF_SHMA', opinion: null, offsetMinutes: bad }]) {
        const r = readZmanFromModel(shape, 'sephardi');
        assert(r.kind === 'refuse' && r.reason === 'bad_offset', `${JSON.stringify(shape)}: ${JSON.stringify(r)}`);
      }
    }
  });

  await check('halachic hours: 0 to 12 in every set, with an offset; outside that is bad_offset (a number out of range)', () => {
    for (const community of COMMUNITIES) {
      for (const hours of [0, 1, 3, 6, 12]) {
        const r = readZmanFromModel({ halachicHours: hours, offsetMinutes: -15 }, community);
        assert(r.kind === 'spec' && 'halachicHours' in r.spec && r.spec.halachicHours === hours && r.spec.offsetMin === -15, `${community} ${hours}: ${JSON.stringify(r)}`);
        assert(offeredIn(r.spec as never, community), `${community} ${hours} not offered`);
      }
      for (const hours of [-1, 13, NaN, Infinity, '3']) {
        const r = readZmanFromModel({ halachicHours: hours, offsetMinutes: 0 }, community);
        assert(r.kind === 'refuse' && r.reason === 'bad_offset', `${community} ${String(hours)}: ${JSON.stringify(r)}`);
      }
    }
  });

  await check('a spec the mapper returns is always one the store would take', () => {
    for (const community of COMMUNITIES) {
      for (const key of reminderZmanim(community)) {
        const r = read(nameOf(key), zmanimSet(community).zmanim[key]?.opinion ?? null, 15, community);
        assert(r.kind === 'spec' && asZmanSpec(r.spec) !== null && offeredIn(asZmanSpec(r.spec)!, community), `${community} ${key}`);
      }
    }
  });

  // ---- The parser ----

  const parse = (event: Record<string, unknown>, remindersOn = true, tz = IL) =>
    parseGeminiEventResponse(
      { intent: 'create', confidence: 'high', event: { title: 'Say Shema', calendarId: 'primary', kind: 'reminder', forPerson: 'self', ...event } },
      CALENDARS, tz, remindersOn, NOW
    );
  const at = (d: Date, tz: string) => formatInTimeZone(d, tz, 'yyyy-MM-dd HH:mm');
  const SHEMA = { name: 'SOF_SHMA', opinion: null, offsetMinutes: -10 };

  await check('a zman reminder is date-only: all day, no clock time, today at local midnight when no day is said', () => {
    for (const tz of [IL, NY]) {
      const { event, error } = parse({ zman: SHEMA, startDate: null, startTime: null, allDay: false }, true, tz);
      assert(!!event && !error, `${tz}: ${error}`);
      assert(event.allDay && event.kind === 'reminder', `${tz}: ${JSON.stringify(event)}`);
      assert(at(event.startTime, tz) === formatInTimeZone(NOW, tz, 'yyyy-MM-dd') + ' 00:00' && event.endTime.getTime() === event.startTime.getTime(), `${tz}: ${at(event.startTime, tz)}`);
      assert(JSON.stringify(event.zman) === JSON.stringify(SHEMA), JSON.stringify(event.zman));
    }
  });

  await check('a day the person said stays, and allDay is forced even when the model said false', () => {
    const { event } = parse({ zman: SHEMA, startDate: '2026-10-30', allDay: false });
    assert(!!event && event.allDay && at(event.startTime, IL) === '2026-10-30 00:00' && JSON.stringify(event.zman) === JSON.stringify(SHEMA), JSON.stringify(event));
  });

  await check('a said day (or Hebrew date) marks the zman reminder zmanDaySaid; no day said, or no zman, does not', () => {
    const said = parse({ zman: SHEMA, startDate: '2026-10-30' }).event;
    assert(said?.zmanDaySaid === true, `said: ${JSON.stringify(said)}`);
    const hebrew = parse({ zman: SHEMA, startDate: null, hebrewDate: { day: 1, month: 'Kislev' } }).event;
    assert(hebrew?.zmanDaySaid === true, `Hebrew date: ${JSON.stringify(hebrew)}`);
    for (const startDate of [null, undefined, '']) {
      const none = parse({ zman: SHEMA, startDate }).event;
      assert(!!none && !('zmanDaySaid' in none), `${JSON.stringify(startDate)}: ${JSON.stringify(none)}`);
    }
    const daily = parse({ zman: SHEMA, startDate: null, recurrence: { frequency: 'daily' } }).event;
    assert(!!daily && !('zmanDaySaid' in daily), JSON.stringify(daily));
    const plain = parse({ startDate: '2026-10-15', startTime: '10:00', allDay: false }).event;
    assert(!!plain && !('zmanDaySaid' in plain), JSON.stringify(plain));
  });

  await check('the hours form, an opinion, a missing offset and a repeat are read', () => {
    const hours = parse({ zman: { halachicHours: 3, offsetMinutes: 0 } }).event;
    assert(!!hours && JSON.stringify(hours.zman) === '{"halachicHours":3,"offsetMinutes":0}', JSON.stringify(hours?.zman));
    const gra = parse({ zman: { name: 'SOF_SHMA', opinion: 'gra', offsetMinutes: -10 } }).event;
    assert(gra?.zman !== undefined && 'name' in gra.zman && gra.zman.opinion === 'gra', JSON.stringify(gra?.zman));
    const bare = parse({ zman: { name: 'SHKIA' } }).event;
    assert(!!bare && JSON.stringify(bare.zman) === '{"name":"SHKIA","opinion":null,"offsetMinutes":0}', JSON.stringify(bare?.zman));
    const daily = parse({ zman: { name: 'SHKIA', opinion: null, offsetMinutes: -30 }, recurrence: { frequency: 'daily' } }).event;
    assert(!!daily && daily.recurrence?.frequency === 'daily' && daily.allDay, JSON.stringify(daily));
  });

  await check('a reminder with no zman has no zman key at all (and null reads as none)', () => {
    for (const fields of [{}, { zman: null }, { zman: undefined }]) {
      const { event } = parse({ startDate: '2026-10-15', startTime: '10:00', allDay: false, ...fields });
      assert(!!event && !('zman' in event) && !event.allDay, JSON.stringify(fields));
    }
  });

  await check('a zman that is not a readable shape is warned about and the reminder refused', () => {
    const bad: unknown[] = [
      'SHKIA', 5, true, [], [{ name: 'SHKIA' }], {}, { offsetMinutes: -5 },
      { name: 5 }, { name: '' }, { name: '   ' }, { name: 'SHKIA', opinion: 5 }, { name: 'SHKIA', opinion: {} },
      { name: 'SHKIA', offsetMinutes: 'ten' }, { name: 'SHKIA', offsetMinutes: NaN },
      { halachicHours: 'three', offsetMinutes: 0 }, { halachicHours: 3, offsetMinutes: 'x' },
      { name: 'SHKIA', halachicHours: 3, offsetMinutes: 0 },
    ];
    for (const zman of bad) {
      warnings.length = 0;
      const r = parse({ zman });
      assert(!r.event && !!r.error && r.confidence === 'low', `${JSON.stringify(zman)}: ${JSON.stringify(r)}`);
      assert(warnings.some((w) => w.includes('zman')), `${JSON.stringify(zman)}: no warning`);
    }
  });

  await check('a zman with an anchor, with a clock time, or on an event is warned about and refused', () => {
    const clashes: Array<[string, Record<string, unknown>, boolean]> = [
      ['anchor', { zman: SHEMA, anchor: { description: 'the dentist', offsetMinutes: -60 } }, true],
      ['clock time', { zman: SHEMA, startTime: '08:00' }, true],
      ['event kind', { zman: SHEMA, kind: 'event', startDate: '2026-10-30', startTime: '09:00', endTime: '10:00' }, true],
      ['event kind, all day', { zman: SHEMA, kind: 'event', startDate: '2026-10-30', allDay: true }, true],
      ['reminders off', { zman: SHEMA, startDate: '2026-10-30', allDay: true }, false],
    ];
    for (const [name, fields, remindersOn] of clashes) {
      warnings.length = 0;
      const r = parse(fields, remindersOn);
      assert(!r.event && !!r.error && r.confidence === 'low', `${name}: ${JSON.stringify(r)}`);
      assert(warnings.some((w) => w.includes('zman')), `${name}: no warning`);
    }
  });

  await check('an event without a zman is read exactly as before', () => {
    const { event, error } = parse({ kind: 'event', startDate: '2026-10-30', startTime: '09:00', endTime: '10:00' });
    assert(!!event && !error && !('zman' in event), JSON.stringify(event));
  });

  // ---- The prompt teaches what the mapper reads (zman reminders by voice plan, Task 4) ----

  const PEOPLE = { userName: 'Raziel', userEnglishName: null, partnerName: null, partnerEnglishName: null };
  const rulesOf = (mode: 'voice' | 'text') => buildEventExtractionPrompt('en', CALENDARS, IL, mode, undefined, PEOPLE);

  await check('the names the prompt lists are exactly the zman names the mapper knows (no end of Shabbat), and the opinions are its closed list', () => {
    const known = new Set(ZMAN_KEYS.filter((key) => key !== 'SHABBAT_ENDS').map(nameOf));
    for (const mode of ['voice', 'text'] as const) {
      const prompt = rulesOf(mode);
      const listed = prompt.match(/"name" is one of ([A-Z_, ]+)\./)?.[1];
      assert(!!listed, `${mode}: no list of names`);
      const names = listed.split(',').map((n) => n.trim());
      assert(new Set(names).size === names.length && names.length === known.size && names.every((n) => known.has(n)), `${mode}: ${names.join(',')} vs ${[...known].join(',')}`);
      assert(!names.includes('SHABBAT_ENDS'), `${mode}: SHABBAT_ENDS is listed`);
      for (const opinion of ['gra', 'mga', 'halachaBerura', 'yalkutYosef', 'baalHatanya']) assert(prompt.includes(`"${opinion}"`), `${mode}: no opinion ${opinion}`);
    }
  });

  await check('each zman example of the prompt reads back through the parser and the mapper as the rule it teaches, in both modes', () => {
    const want = [
      { zman: 'CANDLE_LIGHTING', offsetMin: -60 },
      { zman: 'SOF_SHMA_MGA', offsetMin: -30 },
      { halachicHours: 3, offsetMin: 0 },
    ];
    for (const mode of ['voice', 'text'] as const) {
      const outputs = rulesOf(mode).split('\n').filter((line) => line.startsWith('Output: ') && line.includes('"zman": {'));
      assert(outputs.length === 3, `${mode}: ${outputs.length} examples`);
      const got = outputs.map((line) => {
        const json = JSON.parse(line.slice('Output: '.length).replace(/YYYY-MM-DD/g, '2026-10-30'));
        const { event, error } = parseGeminiEventResponse(json, CALENDARS, IL, true, NOW);
        assert(!!event && !error && event.allDay && !!event.zman, `${mode}: ${line.slice(0, 80)} -> ${error}`);
        assert(event.startTime.getTime() === event.endTime.getTime(), `${mode}: an example has a length`);
        const mapped = readZmanFromModel(event.zman, 'sephardi');
        assert(mapped.kind === 'spec', `${mode}: ${JSON.stringify(mapped)}`);
        return mapped.spec;
      });
      assert(JSON.stringify(got) === JSON.stringify(want), `${mode}: ${JSON.stringify(got)}`);
    }
  });

  // ---- The live eval's zman cases (Task 10): checked offline, no model call ----

  const evalSource = readFileSync(path.resolve(__dirname, 'eval-native-reminders.ts'), 'utf8');
  const { ALL_CASES } = await import('./eval-native-reminders');
  type ZmanCase = (typeof ALL_CASES)[number];
  const zmanCases = ALL_CASES.filter((c) => c.label.startsWith('zman'));
  const zmanOnly = zmanCases.filter((c) => !c.label.startsWith('zman control'));
  const caseOf = (language: string, label: string) => {
    const found = zmanCases.find((c) => c.language === language && c.label === label);
    assert(!!found, `no eval case ${language} ${label}`);
    return found;
  };

  await check('the eval has 20 zman cases: 17 reminders by a halachic time (en, he, ru) and 3 controls, all selected by EVAL_ONLY=zman and none with an apostrophe in the text', () => {
    assert(zmanCases.length === 20 && zmanOnly.length === 17, `${zmanCases.length} cases, ${zmanOnly.length} zman`);
    for (const [language, count] of [['en', 6], ['he', 5], ['ru', 6]] as const) assert(zmanOnly.filter((c) => c.language === language).length === count, `${language} does not have ${count}`);
    assert(zmanCases.filter((c) => c.label.startsWith('zman control')).length === 3, 'three controls');
    for (const c of zmanCases) assert(!c.text.includes("'"), `${c.label}: an apostrophe breaks the phrasing check's pattern`);
    assert(zmanOnly.filter((c) => c.label === 'zman: opinion said').length === 3, 'one opinion-said case per language');
  });

  /** One correct model answer per case: what a model that reads the phrase right returns. */
  const TOMORROW = '2026-10-29';
  const FRIDAY = '2026-10-30';
  const ANSWERS: Record<string, Record<string, unknown>> = {
    'en zman: shema': { zman: { name: 'SOF_SHMA', opinion: null, offsetMinutes: -12 } },
    'he zman: shema': { zman: { name: 'SOF_SHMA', opinion: null, offsetMinutes: -12 } },
    'ru zman: shema': { zman: { name: 'SOF_SHMA', opinion: null, offsetMinutes: -12 } },
    'en zman: sunset daily': { zman: { name: 'SHKIA', opinion: null, offsetMinutes: -30 }, recurrence: { frequency: 'daily' } },
    'he zman: sunset daily': { zman: { name: 'SHKIA', opinion: null, offsetMinutes: -20 }, recurrence: { frequency: 'daily' } },
    'ru zman: sunset daily': { zman: { name: 'SHKIA', opinion: null, offsetMinutes: -30 }, recurrence: { frequency: 'daily' } },
    'en zman: opinion said': { zman: { name: 'PLAG', opinion: 'yalkutYosef', offsetMinutes: 0 }, startDate: TOMORROW },
    'he zman: opinion said': { zman: { name: 'SOF_SHMA', opinion: 'mga', offsetMinutes: -40 }, startDate: TOMORROW },
    'ru zman: opinion said': { zman: { name: 'PLAG', opinion: 'halachaBerura', offsetMinutes: -20 }, startDate: TOMORROW },
    'en zman: nightfall': { zman: { name: 'TZEIT', opinion: null, offsetMinutes: 15 } },
    'ru zman: nightfall': { zman: { name: 'TZEIT', opinion: null, offsetMinutes: 15 }, startDate: FRIDAY },
    'en zman: friday candles': { zman: { name: 'CANDLE_LIGHTING', opinion: null, offsetMinutes: -90 }, recurrence: { frequency: 'weekly', daysOfWeek: ['FR'] } },
    'he zman: friday candles for both': { zman: { name: 'CANDLE_LIGHTING', opinion: null, offsetMinutes: -60 }, forPerson: 'both', recurrence: { frequency: 'weekly', daysOfWeek: ['FR'] } },
    'ru zman: friday candles': { zman: { name: 'CANDLE_LIGHTING', opinion: null, offsetMinutes: -90 }, recurrence: { frequency: 'weekly', daysOfWeek: ['FR'] } },
    'en zman: chatzot': { zman: { name: 'CHATZOT', opinion: null, offsetMinutes: -10 } },
    'ru zman: halachic midnight': { zman: { name: 'CHATZOT_HALAYLA', opinion: null, offsetMinutes: 30 } },
    'he zman: halachic hours': { zman: { halachicHours: 4, offsetMinutes: 0 }, recurrence: { frequency: 'daily' } },
    'ru zman control: clock time': { startDate: TOMORROW, startTime: '17:30', allDay: false },
    'he zman control: midnight': { startDate: TOMORROW, startTime: '00:00', allDay: false },
  };
  const answerFor = (c: ZmanCase, over: Record<string, unknown> = {}) => {
    const base = ANSWERS[`${c.language} ${c.label}`];
    assert(!!base, `no answer for ${c.language} ${c.label}`);
    const { event, error } = parse({ ...base, ...over });
    return { event, error, results: event ? [{ intent: 'create' as const, confidence: 'high' as const, event }] : [{ intent: 'create' as const, confidence: 'low' as const, error }] };
  };

  await check('each zman case of the eval accepts a correct answer (parsed by the real parser) and the control event stays an event', () => {
    for (const c of zmanCases) {
      if (c.label === 'zman control: event') continue;
      const { results: got } = answerFor(c);
      const problem = c.expect(got, NOW);
      assert(problem === null, `${c.language} ${c.label}: ${problem}`);
    }
    const dinner = parseGeminiEventResponse(
      { intent: 'create', confidence: 'high', event: { title: 'Dinner', calendarId: 'primary', kind: 'event', startDate: FRIDAY, startTime: '18:00', endDate: FRIDAY, endTime: '20:00' } },
      CALENDARS, IL, true, NOW
    );
    assert(caseOf('en', 'zman control: event').expect([dinner], NOW) === null, 'the dinner stays an event');
  });

  await check('the eval refuses a wrong answer: an opinion the person did not say, a wrong name or offset, hours for a name, a day nobody said, a missing or wrong repeat, a zman on a control', () => {
    const shema = caseOf('en', 'zman: shema');
    const fails = (c: ZmanCase, over: Record<string, unknown>, needle: RegExp) => {
      const { results: got } = answerFor(c, over);
      const problem = c.expect(got, NOW);
      assert(problem !== null && needle.test(problem), `${c.language} ${c.label} ${JSON.stringify(over)}: ${problem}`);
    };
    fails(shema, { zman: { name: 'SOF_SHMA', opinion: 'gra', offsetMinutes: -12 } }, /zman/); // the model picked one
    fails(shema, { zman: { name: 'SOF_SHMA', opinion: null, offsetMinutes: 12 } }, /zman/); // the sign
    fails(shema, { zman: { name: 'SOF_TFILA', opinion: null, offsetMinutes: -12 } }, /zman/); // the name
    fails(shema, { zman: { halachicHours: 3, offsetMinutes: -12 } }, /zman/);
    fails(shema, { startDate: TOMORROW }, /read from nothing/); // a day invented for "no day"
    fails(shema, { zman: undefined }, /no zman/); // a clock time or nothing instead
    fails(shema, { recurrence: { frequency: 'daily' } }, /recurrence/);
    fails(caseOf('en', 'zman: sunset daily'), { recurrence: null }, /recurrence/);
    fails(caseOf('en', 'zman: friday candles'), { recurrence: { frequency: 'weekly', daysOfWeek: ['TH'] } }, /recurrence/);
    fails(caseOf('he', 'zman: friday candles for both'), { forPerson: 'self' }, /forPerson/);
    fails(caseOf('en', 'zman: opinion said'), { startDate: null }, /date/); // the day the person said
    fails(caseOf('ru', 'zman control: clock time'), { zman: { name: 'SHKIA', opinion: null, offsetMinutes: 0 }, startTime: null }, /unexpected zman/);
    fails(caseOf('he', 'zman control: midnight'), { startTime: null, zman: { name: 'CHATZOT_HALAYLA', opinion: null, offsetMinutes: 0 } }, /unexpected zman/);
  });

  await check('the eval\'s zman cases are phrased differently from the prompt\'s own examples and rules, in both modes, so they test generalisation', () => {
    for (const mode of ['voice', 'text'] as const) {
      const prompt = buildEventExtractionPrompt('en', CALENDARS, IL, mode, undefined, { userName: 'Raziel', partnerName: 'Dana' }).toLowerCase();
      for (const c of zmanCases) assert(!prompt.includes(c.text.toLowerCase()), `${mode}: the prompt already holds "${c.text}"`);
    }
    assert(/label: 'zman[^']*', text:/.test(evalSource), 'the cases are written in the eval\'s form');
  });

  let failed = 0;
  for (const r of results) {
    print(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` - ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  print(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
