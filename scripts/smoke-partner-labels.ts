// Smoke test for the partner's calendars in a built-in (NATIVE) calendar user's digests:
// src/services/calendar-provider/user-calendars.ts and what the summary, the week views
// and the voice show read from it. A NativeCalendar's labels are its owner's, so the
// partner's own calendar reached the other partner as `primary, yours`: the partner's
// events were filed under "Your Schedule", getSpouseInfo read the Google-only column and
// found no spouse, and the week prompts and the show had no partner or kids at all.
//
// The native store, Prisma, the timezone lookup and the AI are stubbed. No network.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-partner-labels.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-partner-labels.ts

import path from 'path';
import type { CalendarAssignment, CalendarEvent, UserConfig } from '../src/types';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
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

function assertList(got: unknown, want: unknown) {
  assert(JSON.stringify(got) === JSON.stringify(want), `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
}

const IL = 'Asia/Jerusalem';

// Raziel (1) and Dana (2) are paired; Omer (3) is not; Noam (5) is paired with Lior (6),
// who has no English name; Tal (7) is paired with Gal (8), whose calendar names her.
type Row = {
  id: string; ownerUserId: number; name: string; labels: string[];
  personName?: string; personEnglishName?: string; personGender?: string;
};
const VISIBLE: Record<number, Row[]> = {
  1: [
    // Oldest first, as listVisibleCalendars orders them: Dana's main calendar predates Raziel's.
    { id: 'dana-main', ownerUserId: 2, name: 'Dana', labels: ['primary', 'yours'] },
    { id: 'raz-main', ownerUserId: 1, name: 'Raziel', labels: ['primary', 'yours'] },
    { id: 'raz-kids', ownerUserId: 1, name: 'Leo school', labels: ['kids'], personName: 'Leo', personGender: 'male' },
    { id: 'dana-kids', ownerUserId: 2, name: 'Mia', labels: ['kids'], personName: 'Mia', personGender: 'female' },
    { id: 'dana-about-raz', ownerUserId: 2, name: 'Raziel (Dana\'s)', labels: ['spouse'], personName: 'Raziel', personGender: 'male' },
    { id: 'dana-work', ownerUserId: 2, name: 'Dana work', labels: ['yours'], personName: 'Dana W.', personEnglishName: 'Dana W.', personGender: 'female' },
    { id: 'dana-bdays', ownerUserId: 2, name: 'Birthdays', labels: ['birthdays'] },
  ],
  3: [
    { id: 'omer-main', ownerUserId: 3, name: 'Omer', labels: ['primary', 'yours'] },
  ],
  5: [
    { id: 'noam-main', ownerUserId: 5, name: 'Noam', labels: ['primary', 'yours'] },
    { id: 'lior-main', ownerUserId: 6, name: 'Lior', labels: ['primary', 'yours'] },
  ],
  7: [
    { id: 'tal-main', ownerUserId: 7, name: 'Tal', labels: ['primary', 'yours'] },
    { id: 'gal-main', ownerUserId: 8, name: 'Gal', labels: ['primary', 'yours'], personName: 'Gal', personGender: 'female' },
  ],
};
VISIBLE[9] = [
  { id: 'dana-main', ownerUserId: 2, name: 'Dana', labels: ['primary', 'yours', 'kids'] },
];
const USERS = [
  { id: 2, name: 'דנה', englishName: 'Dana', gender: 'female' },
  { id: 6, name: 'ליאור', englishName: '', gender: 'male' },
];

/** Every listVisibleCalendars and prisma.user.findMany call, to count the queries. */
const storeCalls: number[] = [];
const userQueries: Array<{ where: { id: { in: number[] } }; select: Record<string, boolean> }> = [];
let failStore = false;

const fakePrisma = {
  user: {
    findMany: async (args: { where: { id: { in: number[] } }; select: Record<string, boolean> }) => {
      userQueries.push(args);
      return USERS.filter(u => args.where.id.in.includes(u.id));
    },
  },
};

const fakeStore = {
  encodeCalendarId: (cuid: string) => `native:${cuid}`,
  listVisibleCalendars: async (userId: number) => {
    storeCalls.push(userId);
    if (failStore) throw new Error('database unreachable');
    return (VISIBLE[userId] ?? []).map(r => ({
      color: '#039BE5', rules: [], privacy: 'SHARED_EDITOR', isDeleted: false,
      personName: null, personEnglishName: null, personGender: null, ...r,
    }));
  },
  getNativeSeriesRrule: async () => null,
};

const user = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'Raziel',
  englishName: 'Raziel',
  gender: 'male',
  language: 'en',
  culture: 'default',
  calendarSource: 'NATIVE',
  googleRefreshToken: '',
  pairingId: 'pair-1',
  includeWeeklyInLookahead: false,
  lookaheadAlways7Days: false,
  ...extra,
}) as unknown as UserConfig;

const raziel = user(1);
const omer = user(3, { name: 'Omer', englishName: 'Omer', pairingId: null });
const noam = user(5, { name: 'Noam', englishName: 'Noam', pairingId: 'pair-2' });
const tal = user(7, { name: 'Tal', englishName: 'Tal', pairingId: 'pair-3' });
const googleCalendars: CalendarAssignment[] = [
  { calendarId: 'me@example.com', labels: ['primary', 'yours'], name: 'Me', color: '#000' },
  { calendarId: 'noa@example.com', labels: ['spouse'], name: 'Noa', color: '#000', personName: 'Noa', personGender: 'female' },
  { calendarId: 'kids@group', labels: ['kids'], name: 'Kids', color: '#000', personName: 'Ido', personGender: 'male' },
];
const googleUser = user(4, { calendarSource: 'GOOGLE', googleRefreshToken: 'token', calendarAssignments: googleCalendars });

/** An event on one of Raziel's visible calendars, as the native provider hands it over. */
const ev = (summary: string, cuid: string, start = '2026-10-14T07:00:00.000Z', end = '2026-10-14T08:00:00.000Z'): CalendarEvent =>
  ({ summary, start, end, calendarName: VISIBLE[1].find(r => r.id === cuid)!.name, calendarId: `native:${cuid}` });

async function main() {
  // @hebcal/core is ESM-only and tsx loads src/ as CommonJS (see eval-voice-show.ts);
  // the stubs go into require's cache before the modules that import them load.
  const Module = (await import('module')).default as unknown as {
    new (id: string): { filename: string; loaded: boolean; exports: unknown };
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
    _cache: Record<string, unknown>;
  };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === '@hebcal/core') return path.resolve(__dirname, '../node_modules/@hebcal/core/dist/esm/index.js');
    return resolveFilename.call(this, request, ...rest);
  };
  const stub = (file: string, exports: Record<string, unknown>) => {
    const filename = path.resolve(__dirname, '../src', file);
    const mod = new Module(filename);
    Object.assign(mod, { filename, loaded: true, exports });
    Module._cache[filename] = mod;
  };
  const prompts: string[] = [];
  stub('utils/prisma.ts', { prisma: fakePrisma });
  stub('utils/redis.ts', { redis: {} });
  stub('services/native-calendar/event-store.ts', fakeStore);
  stub('lib/timezone.ts', { resolveUserTimezone: async () => IL });
  stub('services/ai-provider.ts', {
    generateAICompletion: async (prompt: string) => {
      prompts.push(prompt);
      return { text: 'ok' };
    },
    streamAICompletion: async () => {
      throw new Error('not streamed in this test');
    },
  });

  const { getCalendarAssignmentsForUser, labelsFromViewerSide } = await import('../src/services/calendar-provider/user-calendars');

  // The week read goes through the shared reader, whose readRange answers with these; the
  // digest adapter and the calendar lookup are the real thing.
  const WEEK_EVENTS: CalendarEvent[] = [
    ev('Pilates', 'dana-main', '2026-10-15T15:00:00.000Z', '2026-10-15T16:00:00.000Z'),
    ev('Ballet', 'dana-kids', '2026-10-16T13:00:00.000Z', '2026-10-16T14:00:00.000Z'),
    ev('Dentist', 'raz-main', '2026-10-17T07:00:00.000Z', '2026-10-17T08:00:00.000Z'),
  ];
  stub('services/calendar-read/index.ts', { readRange: async () => ({ items: WEEK_EVENTS.map(event => ({ event })) }) });
  stub('services/calendar-provider/index.ts', { getCalendarAssignmentsForUser });

  const { getSpouseInfo, getPrimaryCalendar } = await import('../src/utils/calendar-helpers');
  const { categorizeEvents } = await import('../src/services/telegram/summary');
  const { getWeekLookahead } = await import('../src/services/week-lookahead');
  const { generateWeekLookahead, generateNextWeekSummary } = await import('../src/services/claude');
  const { buildShowContext, resolveShowCalendars } = await import('../src/services/voice-show/context');

  storeCalls.length = 0;
  userQueries.length = 0;
  const razCalendars = await getCalendarAssignmentsForUser(raziel);
  const razQueries = [...userQueries];
  const byId = (id: string) => razCalendars.find(c => c.calendarId === `native:${id}`)!;

  await check('labelsFromViewerSide: the owner\'s own is the spouse\'s, the owner\'s spouse is yours, primary goes', () => {
    assertList(labelsFromViewerSide(['primary', 'yours']), ['spouse']);
    assertList(labelsFromViewerSide(['primary']), ['spouse']);
    assertList(labelsFromViewerSide(['yours']), ['spouse']);
    assertList(labelsFromViewerSide(['spouse']), ['yours']);
    assertList(labelsFromViewerSide(['kids']), ['kids']);
    assertList(labelsFromViewerSide(['birthdays']), ['birthdays']);
    assertList(labelsFromViewerSide([]), []);
  });

  await check('own calendars keep their labels and person, in the store\'s order', () => {
    assertList(razCalendars.map(c => c.calendarId), [
      'native:dana-main', 'native:raz-main', 'native:raz-kids', 'native:dana-kids',
      'native:dana-about-raz', 'native:dana-work', 'native:dana-bdays',
    ]);
    assertList(byId('raz-main').labels, ['primary', 'yours']);
    assert(byId('raz-main').personName === undefined, `own primary named ${byId('raz-main').personName}`);
    assertList(byId('raz-kids').labels, ['kids']);
    assert(byId('raz-kids').personName === 'Leo' && byId('raz-kids').personGender === 'male', 'own kids calendar lost its child');
  });

  await check('the partner\'s primary calendar is the spouse\'s, named after the partner', () => {
    const dana = byId('dana-main');
    assertList(dana.labels, ['spouse']);
    assertList([dana.personName, dana.personEnglishName, dana.personGender], ['דנה', 'Dana', 'female']);
    assert(dana.name === 'Dana', `name ${dana.name}`);
  });

  await check('the partner\'s kids and birthdays calendars keep their labels and are not named after the partner', () => {
    assertList(byId('dana-kids').labels, ['kids']);
    assertList([byId('dana-kids').personName, byId('dana-kids').personGender], ['Mia', 'female']);
    assertList(byId('dana-bdays').labels, ['birthdays']);
    assert(byId('dana-bdays').personName === undefined, `birthdays named ${byId('dana-bdays').personName}`);
  });

  await check('the partner\'s calendar about the user is the user\'s own; a named partner calendar keeps its name', () => {
    assertList(byId('dana-about-raz').labels, ['yours']);
    assertList(byId('dana-work').labels, ['spouse']);
    assertList([byId('dana-work').personName, byId('dana-work').personEnglishName], ['Dana W.', 'Dana W.']);
  });

  await check('the owners are read in one query, of the unnamed calendars\' owners only', () => {
    assert(razQueries.length === 1, `${razQueries.length} user queries`);
    assertList(razQueries[0].where.id.in, [2]);
    assertList(Object.keys(razQueries[0].select).sort(), ['englishName', 'gender', 'id', 'name']);
  });

  await check('an unpaired user, and a paired one whose partner calendars are all named, read no user', async () => {
    userQueries.length = 0;
    const omerCalendars = await getCalendarAssignmentsForUser(omer);
    assertList(omerCalendars.map(c => c.labels), [['primary', 'yours']]);
    assert(userQueries.length === 0, `${userQueries.length} user queries for an unpaired user`);
    const gal = (await getCalendarAssignmentsForUser(tal)).find(c => c.calendarId === 'native:gal-main')!;
    assertList([gal.labels, gal.personName, gal.personGender], [['spouse'], 'Gal', 'female']);
    assert(userQueries.length === 0, `${userQueries.length} user queries when every partner calendar is named`);
  });

  await check('a partner with no English name gets none, not an empty one', async () => {
    const lior = (await getCalendarAssignmentsForUser(noam)).find(c => c.calendarId === 'native:lior-main')!;
    assertList([lior.labels, lior.personName, lior.personGender], [['spouse'], 'ליאור', 'male']);
    assert(lior.personEnglishName === undefined, `English name ${JSON.stringify(lior.personEnglishName)}`);
  });

  await check('getPrimaryCalendar is the user\'s own, even when the partner\'s calendar is older', () => {
    assert(getPrimaryCalendar(razCalendars) === 'native:raz-main', `primary ${getPrimaryCalendar(razCalendars)}`);
  });

  await check('categorizeEvents: the partner\'s events are the spouse\'s, kids\' events stay other', () => {
    const events = [
      ev('Standup', 'raz-main'), ev('Pilates', 'dana-main'), ev('Offsite', 'dana-work'),
      ev('Haircut', 'dana-about-raz'), ev('Ballet', 'dana-kids'), ev('PTA', 'raz-kids'),
    ];
    const { userEvents, spouseEvents, otherEvents } = categorizeEvents(events, raziel, razCalendars);
    assertList(userEvents.map(e => e.summary), ['Standup', 'Haircut']);
    assertList(spouseEvents.map(e => e.summary), ['Pilates', 'Offsite']);
    assertList(otherEvents.map(e => e.summary), ['Ballet', 'PTA']);
  });

  await check('getSpouseInfo names the partner from the resolved calendars', () => {
    assertList(getSpouseInfo(raziel, razCalendars), { name: 'דנה', englishName: 'Dana', gender: 'female' });
    // The user row alone has no calendars for a NATIVE user, as before.
    assert(getSpouseInfo(raziel) === null, 'spouse found without the resolved calendars');
  });

  await check('Google users: the Google choices follow their FamCal rows (none here), untouched; spouse info is the same', async () => {
    const resolved = await getCalendarAssignmentsForUser(googleUser);
    assert(resolved.length === googleCalendars.length && resolved.every((a, i) => a === googleCalendars[i]), 'not the user row\'s own list');
    assertList(getSpouseInfo(googleUser, resolved), getSpouseInfo(googleUser));
    assertList(getSpouseInfo(googleUser), { name: 'Noa', gender: 'female' });
  });

  const lookahead = await getWeekLookahead(raziel, razCalendars, new Date('2026-10-14T09:00:00+03:00'));

  await check('week lookahead: the partner\'s events are labelled spouse, the user\'s yours', () => {
    assertList(lookahead.events.map(e => `${e.summary} ${e.calendarLabel}`), ['Pilates spouse', 'Ballet kids', 'Dentist yours']);
  });

  await check('/week and /nextweek prompts name the partner and the partner\'s kids when given the calendars', async () => {
    for (const generate of [generateWeekLookahead, generateNextWeekSummary]) {
      prompts.length = 0;
      await generate(lookahead, raziel, 'en', undefined, false, undefined, razCalendars);
      const prompt = prompts[0] ?? '';
      assert(prompt.includes('Belong to דנה'), `${generate.name}: no spouse context`);
      assert(prompt.includes('- Ballet (Child: Mia)'), `${generate.name}: no Child: prefix`);
      assert(prompt.includes('- Pilates (Dana)'), `${generate.name}: Pilates line missing`);
    }
  });

  await check('/week prompt for a Google user is the same with or without the calendars passed', async () => {
    prompts.length = 0;
    await generateWeekLookahead(lookahead, googleUser, 'en');
    await generateWeekLookahead(lookahead, googleUser, 'en', undefined, false, undefined, googleCalendars);
    assert(prompts.length === 2 && prompts[0] === prompts[1], 'prompts differ');
    assert(prompts[0].includes('Belong to Noa'), 'Google spouse context lost');
  });

  await check('a partner calendar that is also a kids calendar is not named after the partner', async () => {
    const both = await getCalendarAssignmentsForUser(user(9, { pairingId: 'pair-9' }));
    assertList(both[0].labels, ['spouse', 'kids']);
    assert(both[0].personName === undefined, `named ${both[0].personName}`);
    prompts.length = 0;
    await generateWeekLookahead(lookahead, raziel, 'en', undefined, false, undefined, both);
    assert(!(prompts[0] ?? '').includes('Child: דנה'), 'partner annotated as a child');
    assert(!buildShowContext('s', raziel, 'daily', false, both).kids.some(k => k.name === 'דנה'), 'partner listed as a kid');
  });

  await check('voice show: the resolved calendars give the hosts the partner and the kids', () => {
    const c = buildShowContext('summary', raziel, 'daily', false, razCalendars);
    assertList(c.spouse, { name: 'דנה', gender: 'female' });
    assertList(c.kids, [{ name: 'Leo', gender: 'male' }, { name: 'Mia', gender: 'female' }]);
    assert(c.hasKidsCalendars, 'no kids calendars');
    assert(buildShowContext('summary', raziel, 'daily').spouse === undefined, 'spouse without calendars');
  });

  await check('voice show: resolveShowCalendars reads a NATIVE user\'s calendars, never a Google user\'s', async () => {
    storeCalls.length = 0;
    assert((await resolveShowCalendars(googleUser)) === undefined, 'Google user resolved');
    assert(storeCalls.length === 0, 'Google user hit the native store');
    const calendars = await resolveShowCalendars(raziel);
    assertList(calendars?.find(c => c.calendarId === 'native:dana-main')?.labels, ['spouse']);
    assertList(buildShowContext('s', googleUser, 'daily'), buildShowContext('s', googleUser, 'daily', false, googleCalendars));
  });

  await check('voice show: a failed lookup leaves the show without the family, not without a voice', async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    failStore = true;
    try {
      assert((await resolveShowCalendars(raziel)) === undefined, 'resolved while the store failed');
      assert(warnings.some(w => w.startsWith('[VoiceShow]')), `warnings ${JSON.stringify(warnings)}`);
    } finally {
      failStore = false;
      console.warn = warn;
    }
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
