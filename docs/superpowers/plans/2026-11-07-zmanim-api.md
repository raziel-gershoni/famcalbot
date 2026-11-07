# Jewish times API v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner's other apps FamCal's Shabbat, Yom Tov and zmanim times as JSON over `GET /api/v1/shabbat` and `GET /api/v1/day`, each app with its own revocable key made in the admin panel, with no database query per request in the steady state.

**Architecture:** The answers come from the same engine calls the public zmanim pages make: `zmanDayForPlace` (own memo, quiet) and a new `restBlocksBetween` that the city page's "ahead" section is moved onto, shaped by a pure `api-view.ts`. Keys live in a new `ApiKey` table (SHA-256 only), mirrored as one Redis value and copied into process memory on `globalThis`; a request reads only the memory copy and counts its rate in memory. The admin Mini App gets an API keys section over a new admin route.

**Tech Stack:** Next.js 16 route handlers (Node runtime), Prisma + Neon (hand-written migration), Upstash Redis, `@hebcal/core` through the existing zmanim engine, `geo-tz` through `zoneForCoords`, next-intl `createTranslator`, React 19 admin panel on the app-ui kit, offline smokes with `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-07-zmanim-api-design.md` (approved by the owner 2026-11-07). Open point A: the height at the exact point for coordinates in Israel. Open point B: 300 requests a minute per key.

## Global Constraints

- Work only in the worktree `/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/wt-api`, branch `feat/zmanim-api`. Paths below are relative to it.
- One smoke: `bash -c 'source /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fake-env.sh; env $E npx tsx scripts/smoke-<name>.ts'` (written `RUN smoke-<name>` below). Typecheck: `npx tsc --noEmit -p .`. Lint: `npx eslint <the files you touched>`. Prisma client: `bash -c 'source …/fake-env.sh; env $E npx prisma generate'` (generate only).
- Never `npm run build`, never `prisma migrate`, never `scripts/setup-webhook.ts`, never read a `.env` file.
- Shared files get **inserted lines only** (other branches rebase over them): `messages/{en,he,ru}.json`, `prisma/schema.prisma`, `CLAUDE.md`, `README.md`, `src/lib/sentry-scrub.ts` (one existing line changes, see Task 5), `proxy.ts` (no change at all).
- Migration: `prisma/migrations/20261107010000_api_keys/migration.sql`, hand-written, idempotent (`IF NOT EXISTS`), additions only. A parallel branch adds `20261107000000_voice_format`.
- Wall-time rule (CLAUDE.md): read a zone's clock only with `instantToWallTime`; never `formatInTimeZone`, `fromZonedTime`, `setHours`/`setDate`, or a local getter on `new Date(<string>)`. `at` = the wall reading plus the zone's offset by epoch arithmetic.
- No console line or Sentry field holds a key, its hash, its prefix, an origin, an app name, a city slug or name, or coordinates. Log ids, endpoints, statuses, codes and counts only. A thrown error goes to Sentry by its kind (`safeErrorSummary`), never its message.
- Steady state per request: zero Prisma calls and zero Redis commands. The only extra Redis use is one GET per 5 minutes while requests come.
- Rate limit: 300 requests a minute per key, fixed one-minute windows, in process memory. Dates: 2000-01-01 to 2099-12-31; `to` at most 366 days after `from`. `Cache-Control: private, max-age=3600` on a 200 (shorter to the place's midnight when a date was defaulted), `no-store` on every error, `Content-Type: application/json; charset=utf-8` always.
- Candle lighting is 20 minutes before sunset everywhere; no per-custom parameter is ever offered. Communities: `sephardi`, `ashkenazi`, `chabad`; the default is Sephardi where the zone is Israel's (`inIsrael`), Ashkenazi elsewhere. `Asia/Hebron` and `Asia/Gaza` count as abroad.
- Admin UI strings live in `messages/{en,he,ru}.json` under `admin.apiKeys.*`, written natively: Hebrew gender-neutral (plural imperative in a sentence, infinitive on a button), Russian formal. No inline user-facing string. Error `message`s of the API itself are English developer text.
- Admin UI task: the implementer invokes the `frontend-design` skill first, and stays in the admin panel's kit (mobile Mini App, no hover, logical CSS properties, lucide icons only, no emoji).
- Every commit ends with exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
  ```

## Review Focus

The inputs the spec implies but no other test pins; each has its test in the named task.

1. A city slug typed with capitals or spaces (`city=Jerusalem`, `city=tel aviv`): a 400 `UNKNOWN_CITY` whose message points to the slug list, never a guess and never a 500 (Task 4, P2).
2. Coordinates written as `32,46`, `+32.4` or `32.4 ` : a 400 `INVALID_COORDINATES` before any zone lookup, so no Sentry warning is made (Task 4, P2; Task 5, H1).
3. A `from` near the far bound with no `to` (`from=2099-12-28`): a 200 whose `to` is clamped to 2099-12-31, never `OUT_OF_RANGE` for a value the caller did not send (Task 5, H2).
4. Origins typed at creation with a capital or a trailing slash (`https://Candles.Example.test/`): stored as the browser's canonical origin, so the browser's real `Origin` passes the preflight and the GET (Task 5, H6).
5. `/day` in the far north on a summer day (Saint Petersburg, 2027-06-19): a 200 with `null` times where the sun makes none, never a 500 (Task 4, V5).

---

## File map

New:

| File | Responsibility |
|---|---|
| `src/services/zmanim/rest-blocks-view.ts` | `restBlocksBetween`: the Shabbat and Yom Tov blocks of a span of days with their window rows, holidays and parasha (moved out of `buildCityView`) |
| `src/services/zmanim/api-view.ts` | Pure: the JSON of `/shabbat` and `/day`, `isoWithOffset`, names in en/he/ru |
| `src/services/api-keys/mirror.ts` | The key hash, the mirror's shape, the process's key copy on `globalThis.__apiKeys` |
| `src/services/api-keys/store.ts` | The only reader and writer of `ApiKey` rows; rebuilds the Redis mirror and the memory copy after each write |
| `src/services/api-keys/lookup.ts` | `findApiKey`, `anyKeyListsOrigin`: memory first, Redis at most once in 5 minutes, the table only when the mirror is missing |
| `src/lib/api-v1/respond.ts` | Error codes and statuses, `ApiError`, the JSON responses, CORS headers, `reportable` |
| `src/lib/api-v1/params.ts` | Reading and checking the query of each endpoint |
| `src/lib/api-v1/place.ts` | `resolveApiPlace`: a city or coordinates as the engine's `Place` |
| `src/lib/api-v1/credits.ts` | The credits an answer carries |
| `src/lib/api-v1/rate.ts` | The per-key rate limit in memory |
| `src/lib/api-v1/handle.ts` | `handleApiV1`, `preflight`, `notFound` |
| `app/api/v1/shabbat/route.ts`, `app/api/v1/day/route.ts`, `app/api/v1/[...rest]/route.ts` | The routes |
| `app/api/admin/api-keys/route.ts` | The admin route: list, create, revoke |
| `app/[locale]/(app)/admin-panel/data/use-api-keys.ts` | The panel's hook |
| `app/[locale]/(app)/admin-panel/views/ApiKeysView.tsx` | The panel's view |
| `prisma/migrations/20261107010000_api_keys/migration.sql` | The table |
| `scripts/lib/api-world.ts` | The smokes' world: signin-world plus counted Redis, a breakable key table and a clock |
| `scripts/smoke-api-keys.ts`, `scripts/smoke-api-v1.ts` | The smokes |
| `docs/api/jewish-times-v1.md` | The reference handed to another app |

Changed: `src/site/zmanim/city-view.ts`, `src/lib/calendar-view/zman-words.ts`, `components/app-ui/ZmanimRows.tsx`, `prisma/schema.prisma`, `src/config/redis-keys.ts`, `src/lib/sentry-scrub.ts`, `scripts/smoke-sentry-scrub.ts`, `app/[locale]/(app)/admin-panel/{navigation.tsx,AdminPanel.tsx,views/Overview.tsx,data/types.ts}`, `scripts/smoke-admin-render.ts`, `messages/{en,he,ru}.json`, `README.md`, `CLAUDE.md`.

---

### Task 1: One code path with the pages (rest blocks and row names moved)

A refactor under the existing smokes: the city page's "ahead" section moves into `restBlocksBetween`, the sun sheet's `rowText` becomes `zmanRowName`, and the default community gets a zone form. Nothing a person sees changes.

**Files:**
- Create: `src/services/zmanim/rest-blocks-view.ts`
- Modify: `src/site/zmanim/city-view.ts`
- Modify: `src/lib/calendar-view/zman-words.ts`
- Modify: `components/app-ui/ZmanimRows.tsx`
- Test: the existing `scripts/smoke-zmanim-public-view.ts`, `smoke-zmanim-pages.ts`, `smoke-zmanim-sheet.ts`, `smoke-zman-cards.ts`, `smoke-zmanim.ts`, `smoke-site-truth.ts` (unchanged)

**Interfaces:**
- Produces:
  - `restBlocksBetween(place: Place, community: ZmanimCommunity, first: string, until: string, lang: string, il: boolean, memo: ZmanMemo): RestBlockView[]`
  - `type RestBlockDay = { day: string; rows: ZmanimListRow[] }`
  - `type RestBlockView = { eve: string; last: string; start: string | null; end: string | null; holidays: Holiday[]; parasha: Holiday | null; days: RestBlockDay[]; endMissing: boolean }` (`start`/`end` are UTC ISO strings)
  - `daysFrom(first: string, last: string): string[]`, `LONGEST_BLOCK = 3`
  - `zmanRowName(t: ZmanWordsT, row: { key: string; opinion: ZmanOpinion | null }): string` in `src/lib/calendar-view/zman-words.ts`
  - `defaultCommunityIn(timeZone: string): ZmanimCommunity` in `src/site/zmanim/city-view.ts`
  - `AheadDay` and `AheadWindow` stay exported from city-view, now aliases of `RestBlockDay` and `RestBlockView`.

- [ ] **Step 1: Run the baseline**

Run each and note they pass before any change:
```
RUN smoke-zmanim-public-view
RUN smoke-zmanim-pages
RUN smoke-zmanim-sheet
RUN smoke-zman-cards
RUN smoke-zmanim
RUN smoke-site-truth
```
Expected: every one ends with `N/N passed` (exit 0).

- [ ] **Step 2: Create `src/services/zmanim/rest-blocks-view.ts`**

```ts
// The Shabbat and Yom Tov blocks of a span of days, as the zmanim city pages' "ahead" section and the Jewish times API's
// /api/v1/shabbat both list them (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.3): one function, so the
// page and the API cannot drift.
//
// - The blocks are restDayBlocks' (compute.ts): the one under way on `first` (its last day is that day or later, or its
//   end is still after the day's start: a Shabbat that ends at 00:21 on the Sunday in the far north in summer has its last
//   day on the Saturday), and every one whose eve is `until` or before.
// - Each day of a block carries only its window rows (WINDOW_ROW_KEYS), as zmanDayForPlace gives them with the caller's
//   memo and quiet: the candle lighting, the second night's "candle lighting after", the ends.
// - A block is named by its Yom Tov days (holidaysInRange in `lang`, on the Israel schedule when `il`), or, with none, by its
//   chol hamoed or special Shabbat; the parasha is its weekly portion or null.
// - `start` is the eve's sunset and `end` the last day's end, as UTC ISO strings, null where the sun makes none.
//
// Server only (hebcal through compute.ts and the holidays). Pure: no database, Redis, network or clock.

import { WINDOW_ROW_KEYS, type ZmanimListRow } from '../../lib/calendar-view/zmanim-list';
import { holidaysInRange, type Holiday } from '../hebrew-holidays';
import { addDaysToDate, startOfLocalDay } from '../../utils/day-events';
import { restDayBlocks, type Place } from './compute';
import { zmanDayForPlace, type ZmanMemo } from './day-list';
import type { ZmanimCommunity } from './sets';

/** The most rest days in a row (a Yom Tov on Thursday and Friday, then Shabbat): how far a block reaches past its eve. */
export const LONGEST_BLOCK = 3;

/** One day of a block: only its window rows (WINDOW_ROW_KEYS), as the day list gives them. */
export type RestBlockDay = { day: string; rows: ZmanimListRow[] };

export type RestBlockView = {
  /** The day whose sunset begins it (yyyy-MM-dd in the place's zone). */
  eve: string;
  /** Its last rest day. */
  last: string;
  /** The eve's sunset, the block's start (UTC ISO), null where the sun makes none. */
  start: string | null;
  /** The last day's end (UTC ISO), null where the sun makes none. */
  end: string | null;
  /** Its Yom Tov days' names, or, with none, its chol hamoed or special Shabbat's. */
  holidays: Holiday[];
  parasha: Holiday | null;
  days: RestBlockDay[];
  /** The sun does not make its end (the far north in summer): the end row is a dash. */
  endMissing: boolean;
};

/** The days from `first` to `last`, both included. */
export function daysFrom(first: string, last: string): string[] {
  const out: string[] = [];
  for (let day = first; day <= last; day = addDaysToDate(day, 1)) out.push(day);
  return out;
}

function uniqueByTitle(holidays: Holiday[]): Holiday[] {
  const seen = new Set<string>();
  return holidays.filter((h) => (seen.has(h.title) ? false : (seen.add(h.title), true)));
}

/** The blocks under way on `first` or beginning by `until` (both yyyy-MM-dd in the place's zone), in order. */
export function restBlocksBetween(place: Place, community: ZmanimCommunity, first: string, until: string, lang: string, il: boolean, memo: ZmanMemo): RestBlockView[] {
  const zone = place.timeZone;
  const windowRows = (day: string): ZmanimListRow[] => zmanDayForPlace(place, community, day, { memo, quiet: true }).rows.filter((row) => WINDOW_ROW_KEYS.includes(row.key));
  const firstStart = startOfLocalDay(first, zone);
  const blocks = restDayBlocks(
    { from: startOfLocalDay(addDaysToDate(first, -LONGEST_BLOCK), zone), to: startOfLocalDay(addDaysToDate(until, LONGEST_BLOCK + 1), zone) },
    place,
    community,
  )
    .filter((block) => (block.last >= first || (block.end !== null && block.end.getTime() > firstStart.getTime())) && block.eve <= until)
    .sort((a, b) => (a.eve < b.eve ? -1 : a.eve > b.eve ? 1 : 0));
  if (blocks.length === 0) return [];
  const holidays = holidaysInRange(blocks[0].eve, blocks[blocks.length - 1].last, lang, { il });
  return blocks.map((block) => {
    const found = daysFrom(addDaysToDate(block.eve, 1), block.last).flatMap((d) => holidays[d] ?? []);
    const chag = found.filter((h) => h.chag);
    return {
      eve: block.eve,
      last: block.last,
      start: block.start?.toISOString() ?? null,
      end: block.end?.toISOString() ?? null,
      holidays: uniqueByTitle(chag.length > 0 ? chag : found.filter((h) => h.kind === 'cholHamoed' || h.kind === 'specialShabbat')),
      parasha: found.find((h) => h.kind === 'parasha') ?? null,
      days: daysFrom(block.eve, block.last).map((d) => ({ day: d, rows: windowRows(d) })),
      endMissing: block.end === null,
    };
  });
}
```

- [ ] **Step 3: Point `src/site/zmanim/city-view.ts` at it**

3a. Replace the imports block from `import { holidaysInRange, type Holiday } from '@/src/services/hebrew-holidays';` through `import { addDaysToDate, localDate, startOfLocalDay } from '@/src/utils/day-events';` with:

```ts
import { holidaysInRange, type Holiday } from '@/src/services/hebrew-holidays';
import { inIsrael, type Place } from '@/src/services/zmanim/compute';
import { zmanDayForPlace, type ZmanDayList, type ZmanMemo } from '@/src/services/zmanim/day-list';
import { daysFrom, restBlocksBetween, type RestBlockDay, type RestBlockView } from '@/src/services/zmanim/rest-blocks-view';
import { isCommunity, type ZmanimCommunity } from '@/src/services/zmanim/sets';
import type { City } from '@/src/site/cities';
import { addDaysToDate, localDate } from '@/src/utils/day-events';
```

3b. Delete the `LONGEST_BLOCK` constant and its doc comment:

```ts
/** The most rest days in a row (a Yom Tov on Thursday and Friday, then Shabbat): how far a block reaches past its eve. */
const LONGEST_BLOCK = 3;
```

3c. Replace the two type definitions `export type AheadDay = …` and `export type AheadWindow = { … };` (with their doc comments) with:

```ts
/** One day of a window: only its window rows (WINDOW_ROW_KEYS), as the day list gives them. */
export type AheadDay = RestBlockDay;

/** A Shabbat or Yom Tov listed ahead: rest-blocks-view.ts restBlocksBetween, which /api/v1/shabbat lists too. */
export type AheadWindow = RestBlockView;
```

3d. Replace `defaultCommunity` with the zone form and a wrapper:

```ts
/** The owner's rule (spec §2.6): Sephardi in Israel, Ashkenazi abroad, by the place's zone (the Jewish times API asks it too). */
export function defaultCommunityIn(timeZone: string): ZmanimCommunity {
  return inIsrael(timeZone) ? 'sephardi' : 'ashkenazi';
}

/** A city's default community: defaultCommunityIn its zone. */
export function defaultCommunity(city: City): ZmanimCommunity {
  return defaultCommunityIn(city.timeZone);
}
```

3e. Delete the local `daysFrom` function (now imported) and `uniqueByTitle` (moved). Keep `weekdayOf` (the month uses it).

3f. In `buildCityView`, replace the whole `const ahead = attempt('ahead', (): AheadWindow[] => { … });` statement with:

```ts
  const ahead = attempt('ahead', (): AheadWindow[] => restBlocksBetween(place, community, day, addDaysToDate(day, AHEAD_DAYS), locale, il, memo));
```

`windowRows` stays in `buildCityView` (the month section reads it).

- [ ] **Step 4: Move `rowText` into `src/lib/calendar-view/zman-words.ts` as `zmanRowName`**

Append to `zman-words.ts`:

```ts
/**
 * A row of a day's zmanim list by its name (the sun sheet, the city pages and /api/v1/*, so a row is named one way
 * everywhere): a window row by its own message (calendarHome.zmanimList.*), any other zman by its name and opinion.
 */
export function zmanRowName(t: ZmanWordsT, row: { key: string; opinion: ZmanOpinion | null }): string {
  switch (row.key) {
    case 'SHABBAT_ENDS':
      return t('zmanimList.shabbatEnds');
    case 'YOM_TOV_ENDS':
      return t('zmanimList.yomTovEnds');
    case 'SHABBAT_YOM_TOV_ENDS':
      return t('zmanimList.shabbatYomTovEnds');
    case 'CANDLE_LIGHTING_NOT_BEFORE':
      return t('zmanimList.candlesNotBefore');
    default:
      return zmanName(t, row.key, row.opinion);
  }
}
```

In `components/app-ui/ZmanimRows.tsx`: change the import to `import { zmanRowName, type ZmanWordsT } from '@/src/lib/calendar-view/zman-words';`, delete the `rowText` function with its doc comment, and change `<span className="ch-zl-name">{rowText(t, row)}</span>` to `<span className="ch-zl-name">{zmanRowName(t, row)}</span>`. In the file's header comment, change "(zman-words.ts, the editor's words)" to "(zman-words.ts zmanRowName, the editor's words)".

- [ ] **Step 5: Run the same smokes, the typecheck and lint**

```
RUN smoke-zmanim-public-view
RUN smoke-zmanim-pages
RUN smoke-zmanim-sheet
RUN smoke-zman-cards
RUN smoke-zmanim
RUN smoke-site-truth
npx tsc --noEmit -p .
npx eslint src/services/zmanim/rest-blocks-view.ts src/site/zmanim/city-view.ts src/lib/calendar-view/zman-words.ts components/app-ui/ZmanimRows.tsx
```
Expected: the same `N/N passed` as Step 1; tsc and eslint print nothing.

- [ ] **Step 6: Commit**

```bash
git add src/services/zmanim/rest-blocks-view.ts src/site/zmanim/city-view.ts src/lib/calendar-view/zman-words.ts components/app-ui/ZmanimRows.tsx
git commit -m "refactor(zmanim): the city page's rest blocks and the row names move to shared code for the API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 2: The key table, the store and the lookup

**Files:**
- Create: `prisma/migrations/20261107010000_api_keys/migration.sql`
- Modify: `prisma/schema.prisma` (insert the model after `BlockedIdentifier`)
- Modify: `src/config/redis-keys.ts` (insert one key)
- Create: `src/services/api-keys/mirror.ts`, `src/services/api-keys/store.ts`, `src/services/api-keys/lookup.ts`
- Create: `scripts/lib/api-world.ts`
- Test: `scripts/smoke-api-keys.ts`

**Interfaces:**
- Consumes: `safeErrorSummary(error: unknown): string` (`src/services/web-signin/safe-error.ts`), `captureError` (`src/lib/error-capture.ts`), `redis` (`src/utils/redis.ts`), `prisma` (`src/utils/prisma.ts`).
- Produces:
  - `REDIS_KEYS.API_KEYS = 'api:keys:v1'`
  - mirror.ts: `KEY_PREFIX = 'fcj_'`, `KEY_PATTERN: RegExp`, `PREFIX_LENGTH = 10`, `type MirrorEntry = { id: number; app: string; hash: string; origins: string[] }`, `type KeyCopy = { byHash: ReadonlyMap<string, MirrorEntry>; origins: ReadonlySet<string>; loadedAt: number; count: number }`, `hashKey(raw: string): string`, `parseMirror(value: unknown): MirrorEntry[] | null`, `keyCopy(): KeyCopy | null`, `installKeyCopy(entries: readonly MirrorEntry[], now: number): KeyCopy`
  - store.ts: `MAX_ACTIVE_KEYS = 50`, `MAX_APP_NAME = 40`, `type ApiKeyErrorCode = 'INVALID_NAME' | 'INVALID_ORIGIN' | 'NOT_FOUND' | 'MIRROR_FAILED' | 'TOO_MANY_KEYS'`, `class ApiKeyError extends Error { code: ApiKeyErrorCode }`, `type ApiKeyListItem = { id: number; appName: string; prefix: string; origins: string[]; createdAt: string; revokedAt: string | null }`, `checkAppName(value: unknown): string`, `readOrigins(value: unknown): string[]`, `createApiKey(appName: unknown, origins: unknown, adminId: number): Promise<{ key: string; id: number; prefix: string }>`, `revokeApiKey(id: number, adminId: number): Promise<void>`, `listApiKeys(): Promise<ApiKeyListItem[]>`, `rebuildMirror(): Promise<{ entries: MirrorEntry[]; published: boolean }>`
  - lookup.ts: `COPY_FRESH_MS = 300000`, `type FoundKey = { id: number; app: string; origins: readonly string[] }`, `class KeysUnavailable extends Error`, `findApiKey(rawKey: string, now?: number): Promise<FoundKey | null>`, `anyKeyListsOrigin(origin: string, now?: number): Promise<boolean>`, `__pendingKeyRefreshForTests(): Promise<void> | null`
  - api-world.ts: `installApiWorld(): Promise<void>`, `resetApiWorld(): void`, `redisCalls: string[]`, `redisFails: Set<string>`, `redisBefore: Map<string, () => void>`, `prismaFails: Set<string>`, `setClock(ms: number | null): void`, `advanceClock(ms: number): void`
  - globalThis slots: `__apiKeys` (the copy), `__apiKeysLookup` (the lookup's loading/refresh state)

- [ ] **Step 1: Write the test world `scripts/lib/api-world.ts`**

```ts
// The world the Jewish times API smokes run in (smoke-api-keys.ts, smoke-api-v1.ts): signin-world's in-memory Prisma and
// Redis, its error capture and its kept console lines, plus what these smokes count and break:
//   - every Redis command, in order (redisCalls); a command named in redisFails throws; redisBefore runs a probe just before
//     a command does (to see what the code had written by then);
//   - a call of the API key table named in prismaFails ('apiKey.findMany') rejects, as a database that is down does;
//   - the clock the code reads through Date.now(): setClock(ms) fixes it, advanceClock(ms) moves it on, setClock(null) is the
//     real one again;
//   - @hebcal/core resolved to its ESM build, as scripts/lib/site-harness.ts does (tsx compiles the smokes to CommonJS).
// resetApiWorld() is signin-world's resetWorld() plus all of the above, and forgets the process's key copy, the lookup's
// state and the rate counts (their globalThis slots). scripts/lib/ is not a smoke (ci-smokes.sh runs scripts/smoke-*.ts).

import path from 'path';
import { createRequire } from 'module';
import { fakePrisma, fakeRedis, installSigninWorld, prismaCalls, resetWorld, ROOT, stubModule, type Row } from './signin-world';

const nodeRequire = createRequire(__filename);

export const redisCalls: string[] = [];
export const redisFails = new Set<string>();
export const redisBefore = new Map<string, () => void>();
export const prismaFails = new Set<string>();

const realNow = Date.now.bind(Date);
let fixedMs: number | null = null;
let offsetMs = 0;
Date.now = () => (fixedMs ?? realNow()) + offsetMs;

/** The clock fixed at `ms` (null: the real one), with nothing added. */
export function setClock(ms: number | null): void {
  fixedMs = ms;
  offsetMs = 0;
}

/** The clock moved on by `ms`. */
export function advanceClock(ms: number): void {
  offsetMs += ms;
}

const countingRedis: Row = new Proxy({} as Row, {
  get: (_target, name) => {
    if (typeof name !== 'string' || name === 'then') return undefined;
    return async (...args: unknown[]) => {
      redisCalls.push(name);
      redisBefore.get(name)?.();
      if (redisFails.has(name)) throw new Error(`the smoke's Redis refused ${name}`);
      return fakeRedis[name](...args);
    };
  },
});

const keyTable: Row = new Proxy({} as Row, {
  get: (_target, method) => {
    if (typeof method !== 'string' || method === 'then') return undefined;
    return (...args: unknown[]) => {
      if (prismaFails.has(`apiKey.${method}`)) {
        prismaCalls.push(`apiKey.${method}`);
        return Promise.reject(new Error(`the smoke's database refused apiKey.${method}`));
      }
      return fakePrisma.apiKey[method](...args);
    };
  },
});
const breakablePrisma: Row = new Proxy({} as Row, {
  get: (_target, name) => (name === 'apiKey' ? keyTable : fakePrisma[name as string]),
});

let installed = false;

/** signin-world, then the counted Redis and the breakable table in its place. Call before loading the code under test. */
export async function installApiWorld(): Promise<void> {
  if (installed) return;
  installed = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Module: any = nodeRequire('module');
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === '@hebcal/core') return path.join(ROOT, 'node_modules/@hebcal/core/dist/esm/index.js');
    return resolveFilename.call(this, request, ...rest);
  };
  await installSigninWorld();
  stubModule('src/utils/redis.ts', { redis: countingRedis });
  stubModule('src/utils/prisma.ts', { prisma: breakablePrisma, withRetry: (fn: () => unknown) => fn() });
}

/** A fresh process: empty tables and Redis, nothing counted or broken, the real clock, no key copy and no rate counts. */
export function resetApiWorld(): void {
  resetWorld();
  redisCalls.length = 0;
  redisFails.clear();
  redisBefore.clear();
  prismaFails.clear();
  setClock(null);
  const shared = globalThis as Row;
  delete shared.__apiKeys;
  delete shared.__apiKeysLookup;
  const rate = shared.__apiV1Rate as Row | undefined;
  if (rate?.timer) clearTimeout(rate.timer);
  delete shared.__apiV1Rate;
}
```

- [ ] **Step 2: Write the failing smoke `scripts/smoke-api-keys.ts`**

```ts
// Smoke test for the Jewish times API's keys (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.5, §4; plan
// docs/superpowers/plans/2026-11-07-zmanim-api.md, Tasks 2 and 3): src/services/api-keys/{mirror,store,lookup}.ts, the
// ApiKey table and its migration, and the admin route app/api/admin/api-keys/route.ts.
//
// What it pins:
//   - K1 a created key: fcj_ and 43 base64url characters; only its SHA-256 and its first 10 characters reach the table, and
//     the mirror holds the hash; the memory copy has it; one log line, by ids only;
//   - K2 the app name and origin rules; K3 at most 50 active keys;
//   - K4 revoke: the table, then Redis's mirror, then the memory copy, and the key is refused here at once; K5 again: no
//     error, the list written again; no such key: NOT_FOUND;
//   - K6 a failed mirror write deletes the mirror (a create still returns its key); a failed delete too is MIRROR_FAILED for a
//     revoke, and the copy here is still right;
//   - K7 the lookup: a warm copy costs nothing, an unknown key nothing, a cold start one Redis GET (shared by requests at
//     once), a missing or corrupt mirror one database read and one SET, an old copy one GET in the background (and another
//     instance's revoke lands then), a failing Redis keeps the copy and waits 5 minutes, and with nothing at all
//     KeysUnavailable;
//   - K8 the schema, the hand-written migration (additions only, safe twice) and the generated client;
//   - A1-A5 (Task 3) the admin route and the fence on the table;
//   - Z1 no console line or Sentry field holds a key, its hash, its prefix, an app name or an origin.
//
// Real: mirror.ts, store.ts, lookup.ts (and, from Task 3, the admin route, admin-auth and user-service). Faked at the
// boundaries (scripts/lib/api-world.ts over scripts/lib/signin-world.ts): Prisma and Redis in memory, every Redis command
// counted, error capture. No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh:
//   npx tsx scripts/smoke-api-keys.ts

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { advanceClock, installApiWorld, prismaFails, redisBefore, redisCalls, redisFails, resetApiWorld, setClock } from './lib/api-world';
import { assert, captured, check, DB, everyCapture, everyLog, load, logs, prismaCalls, redisStore, report, ROOT, show, type Row } from './lib/signin-world';

const MIGRATION = '20261107010000_api_keys';
const MIRROR = 'api:keys:v1';
const ADMIN = 9;
/** One second into a minute (the rate smokes rely on it too). */
const T0 = Date.UTC(2026, 10, 13, 8, 0, 1);

const sha = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Everything of the run that no log may hold: each key, its hash and its prefix, and the app names and origins used. */
const SECRETS: string[] = ['Shabbat site', 'Candle app', 'One more', 'shabbat.example.test', 'candles.example.test'];
const remember = (key: string): string => {
  SECRETS.push(key, sha(key), key.slice(0, 10));
  return key;
};
const mirrorOf = (): Row[] | null => {
  const raw = redisStore.get(MIRROR);
  return raw === undefined ? null : JSON.parse(raw);
};
const forgetCopy = () => {
  delete (globalThis as Row).__apiKeys;
};
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'none';
  } catch (error) {
    return String((error as Row).code ?? (error as Error).name);
  }
}
function codeOfSync(fn: () => unknown): string {
  try {
    fn();
    return 'none';
  } catch (error) {
    return String((error as Row).code ?? (error as Error).name);
  }
}

/** Every .ts/.tsx file under the folders, relative to the repo. */
function codeFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  for (const root of roots) walk(root);
  return out.sort();
}

async function main() {
  await installApiWorld();
  const store = await load('src/services/api-keys/store.ts');
  const lookup = await load('src/services/api-keys/lookup.ts');
  const mirror = await load('src/services/api-keys/mirror.ts');

  await check('K1 a created key is fcj_ and 43 base64url characters, returned once; the table holds its SHA-256 and its first 10 characters, never the key; the mirror and the memory copy hold the hash; one log line by ids', async () => {
    resetApiWorld();
    const made = await store.createApiKey('  Shabbat site ', 'https://shabbat.example.test\n\nhttps://shabbat.example.test/', ADMIN);
    remember(made.key);
    assert(/^fcj_[A-Za-z0-9_-]{43}$/.test(made.key) && made.key.length === 47, `the key: ${made.key.length} characters`);
    assert(made.id === 1 && made.prefix === made.key.slice(0, 10), `the answer: ${show({ id: made.id, prefix: made.prefix === made.key.slice(0, 10) })}`);
    const [row] = DB.apiKey;
    const kept = { appName: row.appName, keyHash: row.keyHash, prefix: row.prefix, origins: row.origins, createdBy: row.createdBy };
    assert(show(kept) === show({ appName: 'Shabbat site', keyHash: sha(made.key), prefix: made.key.slice(0, 10), origins: ['https://shabbat.example.test'], createdBy: ADMIN }), 'the row is not the hash, the prefix, the trimmed name and one origin');
    assert(!JSON.stringify(row).includes(made.key), 'the key itself is in the table');
    assert(show(mirrorOf()) === show([{ id: 1, app: 'Shabbat site', hash: sha(made.key), origins: ['https://shabbat.example.test'] }]), 'the mirror');
    const copy = mirror.keyCopy();
    assert(copy?.byHash.get(sha(made.key))?.id === 1 && copy.origins.has('https://shabbat.example.test') && copy.count === 1, 'the memory copy');
    assert(show(logs) === show(['[api-keys] key 1 created by admin 9']), `the logs: ${show(logs)}`);
    const second = remember((await store.createApiKey('Candle app', '', ADMIN)).key);
    assert(second !== made.key && DB.apiKey.length === 2, 'two keys are two');
  });

  await check('K2 the app name is trimmed, 1 to 40 characters and no control character; an origin is https://host[:port] or http://localhost:port, read as the browser sends it (lower case, no default port, no slash), each once', () => {
    for (const bad of ['', '   ', 'x'.repeat(41), 'a\u0007b', 42, null, undefined]) assert(codeOfSync(() => store.checkAppName(bad)) === 'INVALID_NAME', `the name ${show(bad)} was taken`);
    assert(store.checkAppName(' Shabbat site ') === 'Shabbat site' && store.checkAppName('ש'.repeat(40)) === 'ש'.repeat(40), 'a good name');
    const read1 = store.readOrigins('https://a.example.test\nhttps://a.example.test/\n\n  http://localhost:3000  \r\nhttps://b.example.test:8443\nhttps://A.Example.test\nhttps://c.example.test:443');
    assert(show(read1) === show(['https://a.example.test', 'http://localhost:3000', 'https://b.example.test:8443', 'https://c.example.test']), `the origins: ${show(read1)}`);
    assert(show(store.readOrigins(['https://a.example.test'])) === show(['https://a.example.test']), 'a list');
    assert(show(store.readOrigins('')) === '[]' && show(store.readOrigins(undefined)) === '[]' && show(store.readOrigins(null)) === '[]', 'none');
    for (const bad of ['http://a.example.test', 'https://a.example.test/path', 'https://a.example.test?x=1', 'https://a.example.test#x', 'http://localhost', 'ftp://a.example.test', 'https://user@a.example.test', 'not a url', 'https://', 'https://a.example.test x']) {
      assert(codeOfSync(() => store.readOrigins(bad)) === 'INVALID_ORIGIN', `${bad} was taken`);
    }
    assert(codeOfSync(() => store.readOrigins(42)) === 'INVALID_ORIGIN' && codeOfSync(() => store.readOrigins([7])) === 'INVALID_ORIGIN', 'not text');
  });

  await check('K3 at most 50 active keys: the 51st is TOO_MANY_KEYS and writes nothing; a revoked one makes room', async () => {
    resetApiWorld();
    DB.apiKey = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, appName: `app ${i}`, keyHash: sha(`k${i}`), prefix: 'fcj_aaaaaa', origins: [], createdAt: new Date(T0), createdBy: ADMIN, revokedAt: null }));
    assert((await codeOf(() => store.createApiKey('One more', '', ADMIN))) === 'TOO_MANY_KEYS' && DB.apiKey.length === 50, 'the 51st active key was made');
    DB.apiKey[0].revokedAt = new Date(T0);
    remember((await store.createApiKey('One more', '', ADMIN)).key);
    assert(DB.apiKey.length === 51, 'a revoked key does not count');
  });

  await check('K4 revoke writes the table, then the mirror (Redis SET while the copy here still has the key), then the copy; the key is refused here at once and the other still works; one log line', async () => {
    resetApiWorld();
    const a = remember((await store.createApiKey('Shabbat site', '', ADMIN)).key);
    const b = remember((await store.createApiKey('Candle app', 'https://candles.example.test', ADMIN)).key);
    const seen: string[] = [];
    redisBefore.set('set', () => seen.push(`table ${DB.apiKey[0].revokedAt ? 'revoked' : 'active'}, copy ${mirror.keyCopy()?.byHash.has(sha(a)) ? 'has it' : 'without it'}`));
    logs.length = 0;
    await store.revokeApiKey(1, ADMIN);
    redisBefore.clear();
    assert(show(seen) === show(['table revoked, copy has it']), `the order: ${show(seen)}`);
    assert(DB.apiKey[0].revokedAt instanceof Date && DB.apiKey[1].revokedAt == null, 'the table');
    assert(show(mirrorOf()?.map((e) => e.id)) === '[2]' && !mirror.keyCopy()?.byHash.has(sha(a)) && mirror.keyCopy()?.byHash.has(sha(b)), 'the mirror and the copy');
    assert((await lookup.findApiKey(a)) === null && (await lookup.findApiKey(b))?.id === 2, 'refused here at once');
    assert(show(logs) === show(['[api-keys] key 1 revoked by admin 9']), `the logs: ${show(logs)}`);
  });

  await check('K5 revoking a revoked key succeeds and writes the key list again (the retry after MIRROR_FAILED); a key that is not there is NOT_FOUND', async () => {
    logs.length = 0;
    redisCalls.length = 0;
    await store.revokeApiKey(1, ADMIN);
    assert(redisCalls.includes('set') && show(logs) === show(['[api-keys] key 1 was already revoked (admin 9): the key list is written again']), `${show(redisCalls)} ${show(logs)}`);
    assert((await codeOf(() => store.revokeApiKey(999, ADMIN))) === 'NOT_FOUND', 'no such key');
  });

  await check('K6 a failed mirror SET deletes the mirror and reports it (the next cold read rebuilds it); a create still returns its key; SET and DEL both failing is MIRROR_FAILED for a revoke, and the table and the copy here are right', async () => {
    resetApiWorld();
    redisFails.add('set');
    const first = await store.createApiKey('Shabbat site', '', ADMIN);
    const a = remember(first.key);
    assert(first.id === 1 && mirror.keyCopy()?.byHash.has(sha(a)) && !redisStore.has(MIRROR) && show(redisCalls) === show(['set', 'del']), `a create with Redis refusing the SET: ${show(redisCalls)}`);
    assert(captured.some((c) => c.context === 'api-keys' && /the mirror was not written/.test(c.message)), 'the failed SET is reported');
    redisFails.clear();
    const b = remember((await store.createApiKey('Candle app', '', ADMIN)).key);
    redisFails.add('set');
    await store.revokeApiKey(1, ADMIN);
    assert(!redisStore.has(MIRROR) && !mirror.keyCopy()?.byHash.has(sha(a)) && mirror.keyCopy()?.byHash.has(sha(b)), 'after a failed SET: no mirror, the copy right');
    redisFails.clear();
    forgetCopy();
    redisCalls.length = 0;
    prismaCalls.length = 0;
    assert((await lookup.findApiKey(a)) === null && (await lookup.findApiKey(b))?.id === 2, 'the cold read after it');
    assert(show(redisCalls) === show(['get', 'set']) && show(prismaCalls) === show(['apiKey.findMany']) && show(mirrorOf()?.map((e) => e.id)) === '[2]', `rebuilt: ${show(redisCalls)} ${show(prismaCalls)}`);
    redisFails.add('set');
    redisFails.add('del');
    assert((await codeOf(() => store.revokeApiKey(2, ADMIN))) === 'MIRROR_FAILED', 'both failing');
    assert(DB.apiKey[1].revokedAt instanceof Date && mirror.keyCopy()?.byHash.size === 0, 'the table and the copy are right');
    assert(captured.some((c) => c.context === 'api-keys' && /not deleted either/.test(c.message)), 'the failed DEL is reported');
  });

  await check('K7 the lookup: memory only while the copy is under 5 minutes old (an unknown or malformed key costs nothing); a cold start is one Redis GET, shared by requests at once; an old copy serves and refreshes in the background (another instance\'s revoke lands then); a missing or corrupt mirror is one table read and one SET; a failing Redis keeps the copy and waits 5 minutes; with no copy, no Redis and no table it is KeysUnavailable', async () => {
    resetApiWorld();
    setClock(T0);
    const a = remember((await store.createApiKey('Shabbat site', 'https://shabbat.example.test', ADMIN)).key);
    const unknown = `fcj_${'A'.repeat(43)}`;
    redisCalls.length = 0;
    prismaCalls.length = 0;
    assert((await lookup.findApiKey(a))?.id === 1 && (await lookup.findApiKey(unknown)) === null && (await lookup.findApiKey('fcj_short')) === null && (await lookup.findApiKey('')) === null, 'warm answers');
    assert(show((await lookup.findApiKey(a))?.origins) === show(['https://shabbat.example.test']) && (await lookup.anyKeyListsOrigin('https://shabbat.example.test')) && !(await lookup.anyKeyListsOrigin('https://other.example.test')), 'the origins');
    assert(redisCalls.length === 0 && prismaCalls.length === 0, `warm: ${show(redisCalls)} ${show(prismaCalls)}`);

    forgetCopy();
    await lookup.findApiKey(a);
    await lookup.findApiKey(unknown);
    assert(show(redisCalls) === show(['get']) && prismaCalls.length === 0, `cold: ${show(redisCalls)} ${show(prismaCalls)}`);
    forgetCopy();
    redisCalls.length = 0;
    await Promise.all([lookup.findApiKey(a), lookup.findApiKey(a), lookup.anyKeyListsOrigin('https://shabbat.example.test')]);
    assert(show(redisCalls) === show(['get']), `three at once: ${show(redisCalls)}`);

    redisCalls.length = 0;
    advanceClock(5 * 60_000);
    assert((await lookup.findApiKey(a))?.id === 1, 'an old copy serves');
    await lookup.__pendingKeyRefreshForTests();
    await lookup.findApiKey(a);
    assert(show(redisCalls) === show(['get']), `one background GET: ${show(redisCalls)}`);

    // Another instance revoked it: the table and the mirror changed, not this copy
    DB.apiKey[0].revokedAt = new Date(T0);
    redisStore.set(MIRROR, '[]');
    assert((await lookup.findApiKey(a))?.id === 1, 'a fresh copy still serves it');
    advanceClock(5 * 60_000);
    assert((await lookup.findApiKey(a))?.id === 1, 'the request that finds the copy old is served from it');
    await lookup.__pendingKeyRefreshForTests();
    assert((await lookup.findApiKey(a)) === null, 'refused after the refresh');

    resetApiWorld();
    setClock(T0);
    const c = remember((await store.createApiKey('Candle app', '', ADMIN)).key);
    redisStore.delete(MIRROR);
    forgetCopy();
    redisCalls.length = 0;
    prismaCalls.length = 0;
    logs.length = 0;
    assert((await lookup.findApiKey(c))?.id === 1, 'a missing mirror');
    assert(show(redisCalls) === show(['get', 'set']) && show(prismaCalls) === show(['apiKey.findMany']) && logs.includes('[api-keys] rebuilt the key list from the database: 1 active'), `${show(redisCalls)} ${show(prismaCalls)} ${show(logs)}`);
    redisCalls.length = 0;
    prismaCalls.length = 0;
    await lookup.findApiKey(c);
    assert(redisCalls.length === 0 && prismaCalls.length === 0, 'then nothing');
    redisStore.set(MIRROR, '{"not":"a list"}');
    forgetCopy();
    logs.length = 0;
    assert((await lookup.findApiKey(c))?.id === 1 && logs.some((l) => l.includes('the key list in Redis is not one')) && show(mirrorOf()?.map((e) => e.id)) === '[1]', `a corrupt mirror: ${show(logs)}`);

    redisFails.add('get');
    advanceClock(5 * 60_000);
    captured.length = 0;
    redisCalls.length = 0;
    prismaCalls.length = 0;
    assert((await lookup.findApiKey(c))?.id === 1, 'a failing Redis: the old copy serves');
    await lookup.__pendingKeyRefreshForTests();
    assert(show(redisCalls) === show(['get']) && prismaCalls.length === 0 && captured.filter((x) => x.context === 'api-keys').length === 1, `a failed refresh: ${show(redisCalls)} ${show(prismaCalls)} ${captured.length}`);
    advanceClock(60_000);
    redisCalls.length = 0;
    await lookup.findApiKey(c);
    assert(redisCalls.length === 0, 'a new attempt within 5 minutes of the failed one');

    forgetCopy();
    prismaFails.add('apiKey.findMany');
    captured.length = 0;
    assert((await codeOf(() => lookup.findApiKey(c))) === 'KeysUnavailable', 'nothing to read');
    assert(captured.some((x) => x.context === 'api-keys' && /could not be read/.test(x.message)), 'reported');
    prismaFails.clear();
    assert((await lookup.findApiKey(c))?.id === 1, 'the table back, Redis still down: the cold read reads the table');
  });

  await check('K8 the schema has the ApiKey model; the hand-written migration makes the table and its unique hash, only adds and is safe to run twice; the generated client knows the model', () => {
    const schema = read('prisma/schema.prisma');
    const model = /model ApiKey \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
    const lines = model.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim().replace(/\s+/g, ' ')).filter(Boolean);
    for (const want of ['id Int @id @default(autoincrement())', 'appName String', 'keyHash String @unique', 'prefix String', 'origins String[] @default([])', 'createdAt DateTime @default(now())', 'createdBy Int', 'revokedAt DateTime?']) {
      assert(lines.includes(want), `ApiKey lacks "${want}": ${show(lines)}`);
    }
    const dirs = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
    assert(dirs.includes(MIGRATION) && MIGRATION > '20261107000000_voice_format', `the migration folder: ${MIGRATION}`);
    const sql = read(`prisma/migrations/${MIGRATION}/migration.sql`).split('\n').filter((l) => !l.trim().startsWith('--')).join(' ').replace(/\s+/g, ' ').trim();
    for (const want of [
      'CREATE TABLE IF NOT EXISTS "ApiKey" ( "id" SERIAL NOT NULL, "appName" TEXT NOT NULL, "keyHash" TEXT NOT NULL, "prefix" TEXT NOT NULL, "origins" TEXT[] DEFAULT ARRAY[]::TEXT[], "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdBy" INTEGER NOT NULL, "revokedAt" TIMESTAMP(3), CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id") );',
      'CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_keyHash_key" ON "ApiKey"("keyHash");',
    ]) assert(sql.includes(want), `the migration lacks: ${want}`);
    assert(!/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE|ALTER)\b/i.test(sql), `the migration does more than add: ${sql}`);
    assert((sql.match(/\bCREATE\b/g) ?? []).length === (sql.match(/IF NOT EXISTS/g) ?? []).length, 'a CREATE without IF NOT EXISTS');
    const fields = Object.values((Prisma as unknown as Record<string, Record<string, string> | undefined>).ApiKeyScalarFieldEnum ?? {});
    assert(show(fields) === show(['id', 'appName', 'keyHash', 'prefix', 'origins', 'createdAt', 'createdBy', 'revokedAt']), `the generated client's ApiKey: ${show(fields)} (run npx prisma generate)`);
  });

  // ---- Task 3: the admin route (A1-A5) ----

  await check('Z1 no console line or Sentry field of the run holds a key, its hash, its prefix, an app name or an origin', () => {
    const text = [...everyLog, ...everyCapture.map((c) => `${c.message} ${show(c.extra)}`)].join('\n');
    const leaks = SECRETS.filter((s) => text.includes(s));
    assert(leaks.length === 0, `leaked: ${show(leaks.map((s) => (s.length > 12 ? `${s.slice(0, 6)}…` : s)))}`);
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Note: the `MIGRATION > '20261107000000_voice_format'` comparison is a string order check; the voice migration need not exist on this branch.

- [ ] **Step 3: Run it to see it fail**

Run: `RUN smoke-api-keys`
Expected: exit 1, the load of `src/services/api-keys/store.ts` throws (`Cannot find module`).

- [ ] **Step 4: The migration `prisma/migrations/20261107010000_api_keys/migration.sql`**

```sql
-- The Jewish times API's keys (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.5).
--
-- "ApiKey": the key of one of the owner's other apps. "keyHash" is the SHA-256 (hex) of the key, unique: the key itself is
-- never stored. "prefix" is its first 10 characters, for the admin panel's list. "origins" are the web origins a browser
-- may call from (empty: a server key). "createdBy" is the admin's User.id, with no foreign key (a key outlives its maker's
-- account, as BlockedIdentifier."bannedBy" does). "revokedAt" set: refused from then on. Read and written only by
-- src/services/api-keys/store.ts.
--
-- Additions only, so one push is enough: the previous build, still serving while this runs, never reads it. Hand-written
-- and idempotent, like the other recent migrations: each object is made only when missing, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "ApiKey" (
    "id" SERIAL NOT NULL,
    "appName" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "origins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" INTEGER NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
```

- [ ] **Step 5: The schema model**

In `prisma/schema.prisma`, insert after the closing `}` of `model BlockedIdentifier` (and its blank line), before `model OAuthState {`:

```prisma
// The Jewish times API's keys (/api/v1/*): one per app of the owner's. Only the key's SHA-256 is kept; read and written
// only by src/services/api-keys/store.ts.
model ApiKey {
  id        Int       @id @default(autoincrement())
  appName   String
  keyHash   String    @unique // SHA-256 of the key, hex
  prefix    String // "fcj_" and the key's next 6 characters, for the admin list
  origins   String[]  @default([]) // Web origins a browser may call from; empty = a server key
  createdAt DateTime  @default(now())
  createdBy Int // Admin User.id who made it
  revokedAt DateTime?
}

```

Then run `bash -c 'source /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fake-env.sh; env $E npx prisma generate'`. Expected: "Generated Prisma Client".

- [ ] **Step 6: The Redis key**

In `src/config/redis-keys.ts`, insert after the `signinLimit: …` line, before `} as const;`:

```ts

  // The Jewish times API's keys (src/services/api-keys): the active keys as one JSON list [{ id, app, hash, origins }], no
  // TTL, rewritten after each admin change; requests read the process's copy of it, this at most once in 5 minutes.
  API_KEYS: 'api:keys:v1',
```

- [ ] **Step 7: `src/services/api-keys/mirror.ts`**

```ts
// The Jewish times API's keys as a request sees them (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.5):
// the key's hash, the shape of the mirror (the active keys as one Redis value, REDIS_KEYS.API_KEYS) and the process's copy
// of it. The copy is on globalThis (Next 16 gives the routes and the scheduler separate module instances), so the admin
// route's write and the API routes' reads share it. store.ts writes the copy after each change; lookup.ts reads it.
//
// A key is fcj_ and 32 random bytes in base64url (43 characters): 256 bits, so a plain SHA-256 is enough (nobody can guess
// one, so no slow hash). Server only by import discipline. Pure apart from node:crypto.

import crypto from 'node:crypto';

export const KEY_PREFIX = 'fcj_';
/** A key's whole shape: anything else is refused before any lookup. */
export const KEY_PATTERN = /^fcj_[A-Za-z0-9_-]{43}$/;
/** The characters of a key the admin list shows: fcj_ and the next 6. */
export const PREFIX_LENGTH = KEY_PREFIX.length + 6;

/** One active key in the mirror: its row id, its app's name, its SHA-256 (hex) and its origins. */
export type MirrorEntry = { id: number; app: string; hash: string; origins: string[] };

export type KeyCopy = {
  byHash: ReadonlyMap<string, MirrorEntry>;
  /** Every origin some active key lists (the browser's preflight carries no key). */
  origins: ReadonlySet<string>;
  /** When it was read (epoch ms). */
  loadedAt: number;
  count: number;
};

type Shared = { copy: KeyCopy | null };

/** The process's state, read on each call (a smoke starts it over by deleting globalThis.__apiKeys). */
function shared(): Shared {
  const g = globalThis as { __apiKeys?: Shared };
  return (g.__apiKeys ??= { copy: null });
}

/** The SHA-256 of a key, hex: what the table, the mirror and the copy hold. */
export function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

const isEntry = (value: unknown): value is MirrorEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return Number.isInteger(e.id) && typeof e.app === 'string' && typeof e.hash === 'string' && /^[0-9a-f]{64}$/.test(e.hash) && Array.isArray(e.origins) && e.origins.every((o) => typeof o === 'string');
};

/**
 * The mirror's value as Redis answers it (Upstash parses JSON on read; a string is parsed here), or null when it is not a
 * list of entries. Not a failure to report here: the caller logs that it rebuilds the list.
 */
export function parseMirror(value: unknown): MirrorEntry[] | null {
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      // Unreadable text is no list: the caller rebuilds it from the table and logs that
      return null;
    }
  }
  return Array.isArray(list) && list.every(isEntry) ? list : null;
}

/** The process's copy, or null before the first read (a restart, a deploy). */
export function keyCopy(): KeyCopy | null {
  return shared().copy;
}

/** Replaces the process's copy with these entries, read at `now`. */
export function installKeyCopy(entries: readonly MirrorEntry[], now: number): KeyCopy {
  const copy: KeyCopy = {
    byHash: new Map(entries.map((entry) => [entry.hash, entry])),
    origins: new Set(entries.flatMap((entry) => entry.origins)),
    loadedAt: now,
    count: entries.length,
  };
  shared().copy = copy;
  return copy;
}
```

- [ ] **Step 8: `src/services/api-keys/store.ts`**

```ts
// The Jewish times API's keys in the database (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.5): the one
// file that reads or writes ApiKey rows (scripts/smoke-api-keys.ts fences the table to it). The admin route calls it.
//
// - A key is made here and returned once, by createApiKey: only its SHA-256 and its first 10 characters (the prefix, for
//   the list) are kept. It never reaches a log, Redis or Sentry.
// - After each write the mirror is rebuilt: the active keys read back from the table, written to Redis as one value
//   (REDIS_KEYS.API_KEYS, no TTL), then put in this process's memory (mirror.ts), in that order. A failed SET deletes the
//   mirror (the next cold read rebuilds it from the table); a failed delete too is MIRROR_FAILED for a revoke (a create
//   still answers its key: this process's copy has it). The memory copy is always replaced.
// - At most 50 active keys: a guard, not a product limit.
// - Logs name a key by its id and the admin by theirs: never the key, its hash, its prefix, its app's name or its origins.

import crypto from 'node:crypto';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';
import { prisma } from '../../utils/prisma';
import { redis } from '../../utils/redis';
import { safeErrorSummary } from '../web-signin/safe-error';
import { KEY_PREFIX, PREFIX_LENGTH, hashKey, installKeyCopy, type MirrorEntry } from './mirror';

export const MAX_ACTIVE_KEYS = 50;
export const MAX_APP_NAME = 40;

export type ApiKeyErrorCode = 'INVALID_NAME' | 'INVALID_ORIGIN' | 'NOT_FOUND' | 'MIRROR_FAILED' | 'TOO_MANY_KEYS';

/** A refusal the admin route answers with its code. */
export class ApiKeyError extends Error {
  constructor(readonly code: ApiKeyErrorCode) {
    super(code);
    this.name = 'ApiKeyError';
  }
}

/** A key as the admin list shows it. */
export type ApiKeyListItem = { id: number; appName: string; prefix: string; origins: string[]; createdAt: string; revokedAt: string | null };

/** The app's name as stored: trimmed, 1 to 40 characters, no control character. */
export function checkAppName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiKeyError('INVALID_NAME');
  const name = value.trim();
  const length = [...name].length;
  if (length === 0 || length > MAX_APP_NAME || /\p{Cc}/u.test(name)) throw new ApiKeyError('INVALID_NAME');
  return name;
}

/** One origin as a browser sends it (https://host[:port], or http://localhost:port), or null for anything else. */
function originOf(line: string): string | null {
  if (/[\s?#@]/.test(line)) return null;
  let url: URL;
  try {
    url = new URL(line);
  } catch {
    // Not a URL at all: the caller refuses the whole list with INVALID_ORIGIN
    return null;
  }
  const secure = url.protocol === 'https:';
  const local = url.protocol === 'http:' && url.hostname === 'localhost' && url.port !== '';
  if (!secure && !local) return null;
  const rest = line.replace(/^https?:\/\/[^/]+/i, '');
  if (rest !== '' && rest !== '/') return null;
  return url.origin;
}

/** The origins a key is locked to: one per line (or a list), blank lines dropped, each as a browser sends it, each once. */
export function readOrigins(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const lines: unknown[] | null = typeof value === 'string' ? value.split(/\r?\n/) : Array.isArray(value) ? value : null;
  if (!lines) throw new ApiKeyError('INVALID_ORIGIN');
  const out: string[] = [];
  for (const raw of lines) {
    if (typeof raw !== 'string') throw new ApiKeyError('INVALID_ORIGIN');
    const line = raw.trim();
    if (line === '') continue;
    const origin = originOf(line);
    if (!origin) throw new ApiKeyError('INVALID_ORIGIN');
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** The active keys as the mirror holds them, by id. */
async function activeEntries(): Promise<MirrorEntry[]> {
  const rows = await prisma.apiKey.findMany({ where: { revokedAt: null }, orderBy: { id: 'asc' }, select: { id: true, appName: true, keyHash: true, origins: true } });
  return rows.map((row) => ({ id: row.id, app: row.appName, hash: row.keyHash, origins: row.origins }));
}

/** Writes the mirror; a failed SET deletes it. False only when neither went through (Redis holds an old list). */
async function publishMirror(entries: MirrorEntry[]): Promise<boolean> {
  try {
    await redis.set(REDIS_KEYS.API_KEYS, JSON.stringify(entries));
    return true;
  } catch (error) {
    captureError(new Error(`[api-keys] the mirror was not written (${safeErrorSummary(error)}): deleting it`), 'api-keys', { step: 'mirror-set' });
    try {
      await redis.del(REDIS_KEYS.API_KEYS);
      return true;
    } catch (again) {
      captureError(new Error(`[api-keys] the mirror was not deleted either (${safeErrorSummary(again)})`), 'api-keys', { step: 'mirror-del' });
      return false;
    }
  }
}

/** The active keys from the table into Redis (lookup.ts calls it when Redis has no list). Throws what the table throws. */
export async function rebuildMirror(): Promise<{ entries: MirrorEntry[]; published: boolean }> {
  const entries = await activeEntries();
  return { entries, published: await publishMirror(entries) };
}

/** After a write: the table, then Redis, then this process's copy. False when the mirror could be neither written nor deleted. */
async function afterWrite(now: number): Promise<boolean> {
  const { entries, published } = await rebuildMirror();
  installKeyCopy(entries, now);
  return published;
}

/** A new key for an app: answered once, with its row id and its prefix. Throws ApiKeyError for a bad name or origin, or 50 active keys. */
export async function createApiKey(appName: unknown, origins: unknown, adminId: number): Promise<{ key: string; id: number; prefix: string }> {
  const name = checkAppName(appName);
  const allowed = readOrigins(origins);
  const active = await prisma.apiKey.count({ where: { revokedAt: null } });
  if (active >= MAX_ACTIVE_KEYS) throw new ApiKeyError('TOO_MANY_KEYS');
  const key = `${KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const row = await prisma.apiKey.create({
    data: { appName: name, keyHash: hashKey(key), prefix: key.slice(0, PREFIX_LENGTH), origins: allowed, createdBy: adminId },
    select: { id: true, prefix: true },
  });
  console.log(`[api-keys] key ${row.id} created by admin ${adminId}`);
  // A mirror that could not be written is reported in publishMirror; this process's copy has the key either way
  await afterWrite(Date.now());
  return { key, id: row.id, prefix: row.prefix };
}

/** Revokes a key: final. Again on a revoked key writes the list again and succeeds. Throws NOT_FOUND, or MIRROR_FAILED. */
export async function revokeApiKey(id: number, adminId: number): Promise<void> {
  const now = Date.now();
  const done = await prisma.apiKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(now) } });
  if (done.count === 0) {
    const row = await prisma.apiKey.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new ApiKeyError('NOT_FOUND');
    console.log(`[api-keys] key ${id} was already revoked (admin ${adminId}): the key list is written again`);
  } else {
    console.log(`[api-keys] key ${id} revoked by admin ${adminId}`);
  }
  if (!(await afterWrite(now))) throw new ApiKeyError('MIRROR_FAILED');
}

/** Every key, newest first, as the admin list shows it (never a hash). */
export async function listApiKeys(): Promise<ApiKeyListItem[]> {
  const rows = await prisma.apiKey.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, appName: true, prefix: true, origins: true, createdAt: true, revokedAt: true },
  });
  return rows.map((row) => ({ id: row.id, appName: row.appName, prefix: row.prefix, origins: row.origins, createdAt: row.createdAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null }));
}
```

- [ ] **Step 9: `src/services/api-keys/lookup.ts`**

```ts
// A request's key (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.5): `findApiKey` hashes it and looks the
// hash up in the process's copy (mirror.ts), which holds every active key, so an unknown key is a miss in memory.
//
// - A copy under 5 minutes old: memory only (the steady state: no Redis command, no database query).
// - Older: the request is served from it, and one Redis GET refreshes it in the background (one at a time; after a failed
//   one the next waits 5 minutes), so at most one Redis command per 5 minutes, and only while requests come. A failing
//   Redis keeps the copy (reported once per failure); a refresh never reads the table unless Redis has no list.
// - No copy (a restart, a deploy): one Redis GET before answering, shared by the requests that arrive meanwhile.
// - Redis has no list (never written, flushed) or one that is not a list: one table read rebuilds it and writes it back
//   (store.ts rebuildMirror), logged `[api-keys] rebuilt the key list from the database`. The only table read on a
//   request's path, never in the steady state. With no copy and Redis failing, the table is read the same way; if that
//   fails too it is KeysUnavailable (the route answers 503 KEYS_UNAVAILABLE), reported to Sentry.
// No key, hash or origin reaches a log.

import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError } from '../../lib/error-capture';
import { redis } from '../../utils/redis';
import { safeErrorSummary } from '../web-signin/safe-error';
import { KEY_PATTERN, hashKey, installKeyCopy, keyCopy, parseMirror, type KeyCopy, type MirrorEntry } from './mirror';
import { rebuildMirror } from './store';

/** How long a copy answers alone before a request refreshes it. */
export const COPY_FRESH_MS = 5 * 60 * 1000;

/** A request's key as the handler reads it. */
export type FoundKey = { id: number; app: string; origins: readonly string[] };

/** No copy, and neither Redis nor the table could give the list. */
export class KeysUnavailable extends Error {
  constructor() {
    super('The key list could not be read from Redis or the database');
    this.name = 'KeysUnavailable';
  }
}

type LookupState = { loading: Promise<KeyCopy> | null; refreshing: Promise<void> | null; lastAttempt: number };

function state(): LookupState {
  const g = globalThis as { __apiKeysLookup?: LookupState };
  return (g.__apiKeysLookup ??= { loading: null, refreshing: null, lastAttempt: 0 });
}

const reportRedis = (error: unknown) =>
  captureError(new Error(`[api-keys] the key list could not be read from Redis (${safeErrorSummary(error)})`), 'api-keys', { step: 'redis-get' });

/** Redis's list; null when it has none or one that is not a list (logged). Throws what Redis throws. */
async function mirrorList(): Promise<MirrorEntry[] | null> {
  const value = await redis.get<unknown>(REDIS_KEYS.API_KEYS);
  if (value === null || value === undefined) return null;
  const entries = parseMirror(value);
  if (!entries) console.warn('[api-keys] the key list in Redis is not one: rebuilding it from the database');
  return entries;
}

async function fromDatabase(now: number): Promise<KeyCopy> {
  const { entries } = await rebuildMirror();
  console.log(`[api-keys] rebuilt the key list from the database: ${entries.length} active`);
  return installKeyCopy(entries, now);
}

/** The first read of a process: Redis, else the table. Throws what the table throws. */
async function coldRead(now: number): Promise<KeyCopy> {
  let entries: MirrorEntry[] | null = null;
  try {
    entries = await mirrorList();
  } catch (error) {
    reportRedis(error);
  }
  return entries ? installKeyCopy(entries, now) : fromDatabase(now);
}

/** A refresh of an old copy: Redis only, unless Redis has no list. A failing Redis leaves the copy as it is. */
async function refresh(now: number): Promise<void> {
  let entries: MirrorEntry[] | null;
  try {
    entries = await mirrorList();
  } catch (error) {
    reportRedis(error);
    return;
  }
  if (entries) installKeyCopy(entries, now);
  else await fromDatabase(now);
}

function refreshInBackground(now: number): void {
  const s = state();
  if (s.refreshing) return;
  s.lastAttempt = now;
  s.refreshing = refresh(now)
    .catch((error: unknown) => {
      captureError(new Error(`[api-keys] the key list was not refreshed (${safeErrorSummary(error)}): the copy keeps serving`), 'api-keys', { step: 'refresh' });
    })
    .finally(() => {
      state().refreshing = null;
    });
}

async function currentCopy(now: number): Promise<KeyCopy> {
  const copy = keyCopy();
  if (copy) {
    if (now - Math.max(copy.loadedAt, state().lastAttempt) >= COPY_FRESH_MS) refreshInBackground(now);
    return copy;
  }
  const s = state();
  s.loading ??= coldRead(now).finally(() => {
    state().loading = null;
  });
  try {
    return await s.loading;
  } catch (error) {
    captureError(new Error(`[api-keys] the key list could not be read (${safeErrorSummary(error)})`), 'api-keys', { step: 'cold-read' });
    throw new KeysUnavailable();
  }
}

/** The active key `rawKey` is, or null (unknown, revoked or not a key's shape). Throws KeysUnavailable. */
export async function findApiKey(rawKey: string, now: number = Date.now()): Promise<FoundKey | null> {
  if (!KEY_PATTERN.test(rawKey)) return null;
  const entry = (await currentCopy(now)).byHash.get(hashKey(rawKey));
  return entry ? { id: entry.id, app: entry.app, origins: entry.origins } : null;
}

/** Whether some active key lists `origin` (the preflight's answer, which carries no key). Throws KeysUnavailable. */
export async function anyKeyListsOrigin(origin: string, now: number = Date.now()): Promise<boolean> {
  return (await currentCopy(now)).origins.has(origin);
}

/** Smoke scripts only: the background refresh under way, to wait for. */
export function __pendingKeyRefreshForTests(): Promise<void> | null {
  return state().refreshing;
}
```

- [ ] **Step 10: Run the smoke, the typecheck and lint**

```
RUN smoke-api-keys
npx tsc --noEmit -p .
npx eslint src/services/api-keys scripts/lib/api-world.ts scripts/smoke-api-keys.ts src/config/redis-keys.ts
```
Expected: `9/9 passed` (K1-K8 and Z1; the A checks come in Task 3), tsc and eslint clean. Then mutate to prove a check bites: comment out `installKeyCopy(entries, now);` in `afterWrite`, rerun, see K4 fail, restore.

- [ ] **Step 11: Commit**

```bash
git add prisma/migrations/20261107010000_api_keys prisma/schema.prisma src/config/redis-keys.ts src/services/api-keys scripts/lib/api-world.ts scripts/smoke-api-keys.ts
git commit -m "feat(api): the API key table, its Redis mirror and the in-memory key lookup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 3: The admin keys route

**Files:**
- Create: `app/api/admin/api-keys/route.ts`
- Modify: `scripts/smoke-api-keys.ts` (the A checks replace the `// ---- Task 3: the admin route (A1-A5) ----` line)

**Interfaces:**
- Consumes: Task 2's `createApiKey`, `revokeApiKey`, `listApiKeys`, `ApiKeyError`; `verifyAdminAccess(initData)` (`src/lib/admin-auth.ts`), `requestInitData(request, body?)` (`src/lib/request-init-data.ts`), `captureSignInFailure(error, context, { api_route })` (`src/services/web-signin/safe-error.ts`: reports by kind only).
- Produces: `GET /api/admin/api-keys` → `{ success: true, keys: ApiKeyListItem[] }`; `POST { action: 'create', appName, origins }` → `{ success: true, key, id, prefix }`; `POST { action: 'revoke', id }` → `{ success: true }`; errors `{ error: <CODE> }`: 400 `INVALID_NAME` / `INVALID_ORIGIN` / `TOO_MANY_KEYS` / `INVALID_REQUEST`, 401/403 (auth, the other admin routes' words), 404 `NOT_FOUND`, 503 `MIRROR_FAILED`, 500 `INTERNAL`.

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-api-keys.ts`, add `baseUser, body, initDataFor, request` to the import from `./lib/signin-world`, add these constants after `const ADMIN = 9;`:

```ts
const ADMIN_TG = 5550009;
const OTHER_TG = 5550010;
```

and replace the line `  // ---- Task 3: the admin route (A1-A5) ----` with:

```ts
  const seedAdmin = () => {
    DB.user = [baseUser({ id: ADMIN, name: 'Admin', telegramId: BigInt(ADMIN_TG), isAdmin: true }), baseUser({ id: 10, name: 'Someone', telegramId: BigInt(OTHER_TG) })];
  };
  const route = await load('app/api/admin/api-keys/route.ts');
  const adminInit = () => initDataFor(ADMIN_TG);
  const post = async (b: Row, initData: string | null = adminInit()) => {
    const res: Response = await route.POST(request('/api/admin/api-keys', { body: initData ? { ...b, initData } : b, ...(initData ? { initData } : {}) }));
    return { status: res.status, body: await body(res), cache: res.headers.get('cache-control') };
  };

  await check('A1 GET: no initData is 401, a person who is not an admin 403; an admin gets every key newest first, a revoked one with its date, and never a hash', async () => {
    resetApiWorld();
    seedAdmin();
    assert((await route.GET(request('/api/admin/api-keys'))).status === 401, 'no initData');
    assert((await route.GET(request('/api/admin/api-keys', { initData: initDataFor(OTHER_TG) }))).status === 403, 'not an admin');
    const first = await post({ action: 'create', appName: 'Shabbat site', origins: '' });
    const second = await post({ action: 'create', appName: 'Candle app', origins: 'https://candles.example.test' });
    remember(first.body.key);
    remember(second.body.key);
    await post({ action: 'revoke', id: first.body.id });
    const res: Response = await route.GET(request('/api/admin/api-keys', { initData: adminInit() }));
    const listed = await body(res);
    assert(res.status === 200 && listed.success === true && res.headers.get('cache-control') === 'no-store', `${res.status} ${show(listed)}`);
    assert(show(listed.keys.map((k: Row) => Object.keys(k).sort())) === show([['appName', 'createdAt', 'id', 'origins', 'prefix', 'revokedAt'], ['appName', 'createdAt', 'id', 'origins', 'prefix', 'revokedAt']]), 'the fields');
    assert(show(listed.keys.map((k: Row) => [k.id, k.appName, k.origins, k.revokedAt === null])) === show([[2, 'Candle app', ['https://candles.example.test'], true], [1, 'Shabbat site', [], false]]), `the list: ${show(listed.keys)}`);
    assert(!JSON.stringify(listed).includes(sha(first.body.key)) && !JSON.stringify(listed).includes(first.body.key), 'a hash or a key in the list');
  });

  await check('A2 POST create answers { success, key, id, prefix } once, not stored by a cache; a bad name, a bad origin and the 51st active key are refused by their codes', async () => {
    resetApiWorld();
    seedAdmin();
    const made = await post({ action: 'create', appName: 'Shabbat site', origins: 'https://shabbat.example.test' });
    remember(made.body.key);
    assert(made.status === 200 && made.cache === 'no-store' && show(Object.keys(made.body).sort()) === show(['id', 'key', 'prefix', 'success']) && /^fcj_/.test(made.body.key) && made.body.prefix === made.body.key.slice(0, 10), `${made.status} ${show(Object.keys(made.body))}`);
    assert(show(await post({ action: 'create', appName: ' ', origins: '' })) === show({ status: 400, body: { error: 'INVALID_NAME' }, cache: null }), 'a blank name');
    assert(show(await post({ action: 'create', appName: 'One more', origins: 'http://shabbat.example.test' })) === show({ status: 400, body: { error: 'INVALID_ORIGIN' }, cache: null }), 'a plain http origin');
    DB.apiKey.push(...Array.from({ length: 49 }, (_, i) => ({ id: 100 + i, appName: `app ${i}`, keyHash: sha(`k${i}`), prefix: 'fcj_aaaaaa', origins: [], createdAt: new Date(T0), createdBy: ADMIN, revokedAt: null })));
    assert(show(await post({ action: 'create', appName: 'One more', origins: '' })) === show({ status: 400, body: { error: 'TOO_MANY_KEYS' }, cache: null }), 'the 51st');
    assert((await post({ action: 'create', appName: 'One more', origins: '' }, null)).status === 401, 'a POST with no initData');
  });

  await check('A3 POST revoke answers { success }; again succeeds; no such key is 404 NOT_FOUND; a bad id, an unknown action or a body that is no JSON is 400 INVALID_REQUEST; a mirror that could be neither written nor deleted is 503 MIRROR_FAILED', async () => {
    resetApiWorld();
    seedAdmin();
    const made = await post({ action: 'create', appName: 'Shabbat site', origins: '' });
    remember(made.body.key);
    assert(show(await post({ action: 'revoke', id: made.body.id })) === show({ status: 200, body: { success: true }, cache: null }), 'revoke');
    assert((await post({ action: 'revoke', id: made.body.id })).status === 200, 'again');
    assert(show(await post({ action: 'revoke', id: 999 })) === show({ status: 404, body: { error: 'NOT_FOUND' }, cache: null }), 'no such key');
    for (const bad of [{ action: 'revoke', id: '1' }, { action: 'revoke', id: 0 }, { action: 'revoke' }, { action: 'delete', id: 1 }, {}]) {
      assert(show(await post(bad)) === show({ status: 400, body: { error: 'INVALID_REQUEST' }, cache: null }), `${show(bad)} was taken`);
    }
    const { NextRequest } = await import('next/server');
    const notJson = await route.POST(new NextRequest('https://famcal.bot/api/admin/api-keys', { method: 'POST', headers: { 'x-telegram-init-data': adminInit() }, body: '{"action":' }));
    assert(notJson.status === 400 && show(await body(notJson)) === show({ error: 'INVALID_REQUEST' }), 'a body that is no JSON');
    const other = await post({ action: 'create', appName: 'Candle app', origins: '' });
    remember(other.body.key);
    redisFails.add('set');
    redisFails.add('del');
    assert(show(await post({ action: 'revoke', id: other.body.id })) === show({ status: 503, body: { error: 'MIRROR_FAILED' }, cache: null }), 'the mirror stuck');
  });

  await check('A4 the route logs by ids and codes only: the created and revoked lines, a refusal by its code', async () => {
    resetApiWorld();
    seedAdmin();
    const made = await post({ action: 'create', appName: 'Shabbat site', origins: '' });
    remember(made.body.key);
    await post({ action: 'revoke', id: made.body.id });
    await post({ action: 'create', appName: '', origins: '' });
    assert(logs.includes(`[api-keys] key ${made.body.id} created by admin ${ADMIN}`) && logs.includes(`[api-keys] key ${made.body.id} revoked by admin ${ADMIN}`) && logs.includes('[api-keys] refused: INVALID_NAME'), show(logs));
  });

  await check('A5 the fence: only src/services/api-keys/store.ts reads or writes the API key table (no other prisma delegate use in src/, app/ or scripts/, and no raw "ApiKey" SQL in src/ or app/)', () => {
    const ALLOWED = 'src/services/api-keys/store.ts';
    const delegate = new RegExp(['\\bprisma', 'apiKey\\b'].join('\\.'));
    const touching = codeFiles(['src', 'app', 'scripts']).filter((rel) => delegate.test(read(rel)));
    assert(show(touching) === show([ALLOWED]), `the table is used outside store.ts: ${show(touching)}`);
    const raw = codeFiles(['src', 'app']).filter((rel) => /"ApiKey"/.test(read(rel)));
    assert(raw.length === 0, `raw SQL on the table: ${show(raw)}`);
  });
```

The delegate pattern is built from parts so this file never holds the literal it scans for.

- [ ] **Step 2: Run it to see it fail**

Run: `RUN smoke-api-keys`
Expected: exit 1, the load of `app/api/admin/api-keys/route.ts` throws (`Cannot find module`).

- [ ] **Step 3: `app/api/admin/api-keys/route.ts`**

```ts
/**
 * Admin API keys (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §2.1, §3.5): the keys of the owner's other
 * apps for the Jewish times API (/api/v1/*), in the blocklist route's pattern.
 * GET: every key, newest first: { success, keys: [{ id, appName, prefix, origins, createdAt, revokedAt }] } (never a hash).
 * POST { action: 'create', appName, origins }: origins as one string, one per line (or a list) → { success, key, id, prefix }.
 *   The key is in this answer only, which no cache keeps.
 * POST { action: 'revoke', id } → { success }. Revoking a revoked key writes the key list again and succeeds.
 * Errors are codes: 400 INVALID_NAME, INVALID_ORIGIN, TOO_MANY_KEYS, INVALID_REQUEST; 404 NOT_FOUND; 503 MIRROR_FAILED
 * ("Revoked, but the cache was not updated"); 500 INTERNAL.
 * initData: the X-Telegram-Init-Data header (GET), the header or the body's initData (POST), as the other admin routes.
 * Logs carry ids and codes only (store.ts): never a key, an app name or an origin; a failure is reported by its kind.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAccess } from '@/src/lib/admin-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { ApiKeyError, createApiKey, listApiKeys, revokeApiKey, type ApiKeyErrorCode } from '@/src/services/api-keys/store';
import { captureSignInFailure } from '@/src/services/web-signin/safe-error';

export const dynamic = 'force-dynamic';

const ROUTE = '/api/admin/api-keys';
const STATUS: Record<ApiKeyErrorCode, number> = { INVALID_NAME: 400, INVALID_ORIGIN: 400, TOO_MANY_KEYS: 400, NOT_FOUND: 404, MIRROR_FAILED: 503 };
const NO_STORE = { 'Cache-Control': 'no-store' };

const denied = (error: string | undefined) => NextResponse.json({ error }, { status: error === 'Admin access required' ? 403 : 401 });
const badRequest = () => NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAccess(requestInitData(request));
    if (!auth.authorized) return denied(auth.error);
    return NextResponse.json({ success: true, keys: await listApiKeys() }, { headers: NO_STORE });
  } catch (error) {
    captureSignInFailure(error, 'admin-api-keys-get', { api_route: ROUTE });
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    console.warn(`[api-keys] a POST whose body is no JSON (${error instanceof Error ? error.name : typeof error})`);
    return badRequest();
  }
  try {
    const auth = await verifyAdminAccess(requestInitData(request, body));
    if (!auth.authorized || auth.adminId === undefined) return denied(auth.error);
    if (body.action === 'create') {
      const created = await createApiKey(body.appName, body.origins, auth.adminId);
      return NextResponse.json({ success: true, ...created }, { headers: NO_STORE });
    }
    if (body.action === 'revoke') {
      const id = body.id;
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return badRequest();
      await revokeApiKey(id, auth.adminId);
      return NextResponse.json({ success: true });
    }
    return badRequest();
  } catch (error) {
    if (error instanceof ApiKeyError) {
      console.warn(`[api-keys] refused: ${error.code}`);
      return NextResponse.json({ error: error.code }, { status: STATUS[error.code] });
    }
    // By its kind only: a database error can print the row it was writing (the app's name, its origins)
    captureSignInFailure(error, 'admin-api-keys-post', { api_route: ROUTE });
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run the smoke, the typecheck and lint**

```
RUN smoke-api-keys
npx tsc --noEmit -p .
npx eslint app/api/admin/api-keys/route.ts scripts/smoke-api-keys.ts
```
Expected: `14/14 passed`; tsc and eslint clean. Prove A5 bites: add a line `void prisma.apiKey;` with an import in any other `src/` file, rerun, see A5 fail, remove it.

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/api-keys/route.ts scripts/smoke-api-keys.ts
git commit -m "feat(admin): the API keys route: list, create once, revoke

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 4: The place, the parameters, the credits and the answers

**Files:**
- Create: `src/lib/api-v1/respond.ts`, `src/lib/api-v1/params.ts`, `src/lib/api-v1/place.ts`, `src/lib/api-v1/credits.ts`
- Create: `src/services/zmanim/api-view.ts`
- Test: `scripts/smoke-api-v1.ts` (part A: P and V checks)

**Interfaces:**
- Consumes: Task 1's `restBlocksBetween`, `zmanRowName`, `defaultCommunityIn`, `cityPlace` (city-view); `zmanDayForPlace`, `ZmanMemo` (day-list); `zoneForCoords` (`src/lib/zone-for-coords.ts`); `highestHeight` (`src/services/zmanim/heights.ts`); `holidaysInRange`, `Holiday`; `hebrewDateOf`, `hebrewFullDate`; `formatHalachicHour`; `instantToWallTime`; `isDayKey` (`src/lib/calendar-view/picker-model.ts`); `COPERNICUS_NOTICE`; `safeErrorSummary`. Task 2's `scripts/lib/api-world.ts`.
- Produces:
  - respond.ts: `type ApiErrorCode` (the 17 codes of spec §3.7), `STATUS_OF: Record<ApiErrorCode, number>`, `class ApiError extends Error { code: ApiErrorCode }`, `HOUR_S = 3600`, `errorResponse(code, message, headers?): Response`, `okResponse(body, maxAgeS, headers?): Response`, `corsHeaders(origin): Record<string, string>`, `reportable(error: unknown, label: string): Error`
  - params.ts: `API_LANGS`, `type ApiLang = 'en' | 'he' | 'ru'`, `FIRST_DAY = '2000-01-01'`, `LAST_DAY = '2099-12-31'`, `MAX_RANGE_DAYS = 366`, `DEFAULT_SPAN_DAYS = 7`, `type Endpoint = 'shabbat' | 'day'`, `type PlaceParam = { kind: 'city'; slug: string } | { kind: 'coords'; latitude: number; longitude: number }`, `type ShabbatParams`, `type DayParams`, `readShabbatParams(search: URLSearchParams): ShabbatParams`, `readDayParams(search: URLSearchParams): DayParams`, `checkRange(from: string, to: string): void`, `daysBetween(a: string, b: string): number`
  - place.ts: `type ApiPlace = { source: 'city' | 'coords'; slug: string | null; place: Place; il: boolean }`, `resolveApiPlace(param: PlaceParam): ApiPlace`
  - credits.ts: `type Credit = { source: 'copernicus-dem' | 'geonames' | 'openstreetmap'; text: string; url?: string }`, `creditsFor(place: ApiPlace): Credit[]`
  - api-view.ts: `isoWithOffset(instant: Date, zone: string): string`, `apiTime(iso: string | null, zone: string): ApiTime`, `shabbatView(input: ShabbatInput): Promise<ShabbatAnswer>`, `dayView(input: DayInput): Promise<DayAnswer>`, where `ShabbatInput = { place: ApiPlace; community: ZmanimCommunity; lang: ApiLang; from: string; to: string; credits: Credit[] }` and `DayInput = { place: ApiPlace; community: ZmanimCommunity; lang: ApiLang; date: string; credits: Credit[] }`

- [ ] **Step 1: Write the failing smoke `scripts/smoke-api-v1.ts` (part A)**

```ts
// Smoke test for the Jewish times API (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3, §4; plan
// docs/superpowers/plans/2026-11-07-zmanim-api.md, Tasks 4 and 5): the parameters, the place, the credits and the answers
// (src/lib/api-v1/*, src/services/zmanim/api-view.ts) and the routes (app/api/v1/*).
//
// What it pins:
//   - P1 the place: a city, coordinates in Israel (Israel's zone and the point's own height), abroad (no height), at sea
//     (NO_TIME_ZONE), in Hebron (abroad), an unknown city; a height map that fails counts at sea level and is reported
//     without the place; the default community by place;
//   - P2 the parameters: every 400 code, an unknown or repeated parameter, the date bounds and the 366-day range, coordinates
//     rounded to 4 places, slugs and coordinates as people mistype them (Review Focus 1 and 2);
//   - P3 the credits by place;
//   - V1 one code path: /shabbat's blocks are the city page's "ahead" windows over 400 days, the candle lighting is the eve's
//     own, 20 minutes before its sunset, the start is restDayBlocks', and /day's rows and hours are zmanDayForPlace's;
//   - V2 the golden answers: Jerusalem 13-14 November 2026 (as spec §3.1), Yom Kippur, Shavuot on a Friday in Israel, Pesach
//     and Sukkot in New York (the second night's "candle lighting after"), a range that ends on an eve, the far north (a
//     null end);
//   - V3 the times: `local` is the place's clock, `at` its offset on both sides of each clock change, in every process zone;
//   - V4 /day in New York in Hebrew (spec §3.1 b): rows, hours, the Hebrew date in letters, the parasha;
//   - V5 the languages; /day in the far north (Review Focus 5); V6 the bot's process memo is untouched;
//   - (Task 5) H1-H10 the routes, Z1 no place, key or origin in any log or Sentry field.
//
// Real: the engine, the city list, the zone map (geo-tz), the views, and from Task 5 the routes, the key store and lookup.
// Faked at the boundaries (scripts/lib/api-world.ts over scripts/lib/signin-world.ts): Prisma and Redis in memory with every
// Redis command counted, error capture, the clock; the Israel height map is a recorded stand-in. No network, no database.
//
// This file re-runs itself once per process zone (UTC, Asia/Jerusalem, America/New_York) as child processes, so one command
// covers all three; nothing here may depend on the zone the process has:
//   npx tsx scripts/smoke-api-v1.ts

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { installApiWorld, resetApiWorld } from './lib/api-world';
import { assert, captured, check, load, report, ROOT, show, stubModule, type Row } from './lib/signin-world';

const ZONES = ['UTC', 'Asia/Jerusalem', 'America/New_York'] as const;
const CHILD = 'API_V1_SMOKE_CHILD';

async function runChildren(): Promise<void> {
  const outputs = await Promise.all(
    ZONES.map(
      (zone) =>
        new Promise<{ zone: string; code: number; text: string }>((resolve) => {
          const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], { env: { ...process.env, TZ: zone, [CHILD]: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
          let text = '';
          child.stdout.on('data', (chunk) => (text += chunk));
          child.stderr.on('data', (chunk) => (text += chunk));
          child.on('close', (code) => resolve({ zone, code: code ?? 1, text }));
        }),
    ),
  );
  let failed = 0;
  for (const { zone, code, text } of outputs) {
    process.stdout.write(`\n===== process TZ=${zone} =====\n${text.trimEnd()}\n`);
    if (code !== 0) failed++;
  }
  process.stdout.write(`\n${ZONES.length - failed}/${ZONES.length} process zones passed (${ZONES.join(', ')})\n`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---- Fixtures ----

const HEIGHT = 270;
const heightReads: Row[][] = [];
let heightFails = false;

const HARISH = { lat: '32.4618', lon: '35.0456' };
const NY = { lat: '40.7128', lon: '-74.0060' };
const HEBRON = { lat: '31.5326', lon: '35.0998' };
const SEA = { lat: '33.1234', lon: '32.5678' };

/** No log line or Sentry field of the run may hold these (Z1): the coordinates, slugs and names the run uses. */
const PLACES = ['32.4618', '35.0456', '40.7128', '74.006', '31.5326', '35.0998', '33.1234', '32.5678', '31.769', '35.2163', 'jerusalem', 'haifa', 'new-york', 'saint-petersburg', 'atlantis', 'Jerusalem', 'Haifa', 'New York', 'Saint Petersburg'];

/** Spec §3.1 (a), as the engine gives it: Jerusalem at 828 m, Sephardi, 13 to 14 November 2026. */
const GOLDEN_BLOCKS = [
  {
    eve: '2026-11-13',
    last: '2026-11-14',
    candleLighting: { at: '2026-11-13T16:25:00+02:00', local: '16:25' },
    start: { at: '2026-11-13T16:45:00+02:00', local: '16:45' },
    end: { key: 'SHABBAT_ENDS', name: 'Shabbat ends', at: '2026-11-14T17:16:00+02:00', local: '17:16' },
    parasha: { title: 'Parashat Toldot', brief: 'Toldot' },
    holidays: [],
    days: [
      { date: '2026-11-13', rows: [{ key: 'CANDLE_LIGHTING', opinion: null, name: 'Candle lighting', at: '2026-11-13T16:25:00+02:00', local: '16:25' }] },
      { date: '2026-11-14', rows: [{ key: 'SHABBAT_ENDS', opinion: null, name: 'Shabbat ends', at: '2026-11-14T17:16:00+02:00', local: '17:16' }] },
    ],
  },
];

function assertSame(got: unknown, want: unknown, label: string): void {
  assert(show(got) === show(want), `${label}\n     got  ${show(got)}\n     want ${show(want)}`);
}

function codeOfSync(fn: () => unknown): string {
  try {
    fn();
    return 'none';
  } catch (error) {
    return String((error as Row).code ?? (error as Error).name);
  }
}

async function runChecks(): Promise<void> {
  await installApiWorld();
  stubModule('src/services/zmanim/heights.ts', {
    highestHeight: (points: Row[]) => {
      heightReads.push(points);
      if (heightFails) throw new Error('the smoke height map is missing');
      return HEIGHT;
    },
    heightMapLoads: () => 0,
  });
  const { cityBySlug, CITIES } = await load('src/site/cities.ts');
  const { buildCityView, defaultCommunityIn } = await load('src/site/zmanim/city-view.ts');
  const { zmanDayForPlace } = await load('src/services/zmanim/day-list.ts');
  const { restDayBlocks } = await load('src/services/zmanim/compute.ts');
  const { holidaysInRange } = await load('src/services/hebrew-holidays.ts');
  const { instantToWallTime } = await load('src/utils/wall-time.ts');
  const { addDaysToDate, startOfLocalDay } = await load('src/utils/day-events.ts');
  const params = await load('src/lib/api-v1/params.ts');
  const { resolveApiPlace } = await load('src/lib/api-v1/place.ts');
  const { creditsFor } = await load('src/lib/api-v1/credits.ts');
  const { COPERNICUS_NOTICE } = await load('src/site/zmanim/sources.ts');
  const { dayView, shabbatView, isoWithOffset } = await load('src/services/zmanim/api-view.ts');
  const messages: Record<string, Row> = Object.fromEntries(['en', 'he', 'ru'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))]));
  const memoSize = () => ((globalThis as Row).__zmanReminderAnswers as Map<string, unknown> | undefined)?.size ?? 0;
  const memoBefore = memoSize();

  const city = (slug: string) => ({ kind: 'city', slug });
  const coords = (p: { lat: string; lon: string }) => ({ kind: 'coords', latitude: Number(p.lat), longitude: Number(p.lon) });
  const shabbat = async (q: { place: Row; community?: string; lang?: string; from: string; to: string }): Promise<Row> => {
    const place = resolveApiPlace(q.place);
    return shabbatView({ place, community: q.community ?? defaultCommunityIn(place.place.timeZone), lang: q.lang ?? 'en', from: q.from, to: q.to, credits: creditsFor(place) });
  };
  const day = async (q: { place: Row; community?: string; lang?: string; date: string }): Promise<Row> => {
    const place = resolveApiPlace(q.place);
    return dayView({ place, community: q.community ?? defaultCommunityIn(place.place.timeZone), lang: q.lang ?? 'en', date: q.date, credits: creditsFor(place) });
  };
  /** A block's days as [date, [key, local]] pairs. */
  const locals = (block: Row) => block.days.map((d: Row) => [d.date, d.rows.map((r: Row) => [r.key, r.local])]);
  const search = (qs: string) => new URLSearchParams(qs);

  await check('P1 the place: a city is its stored point, height and zone; coordinates in Israel get Israel\'s zone and the height at the point itself (one read of exactly that point); abroad and in Hebron no height; at sea NO_TIME_ZONE; an unknown city UNKNOWN_CITY; a failing height map counts at sea level and is reported without the place; the default community follows the zone', () => {
    resetApiWorld();
    heightReads.length = 0;
    const jlm = resolveApiPlace(city('jerusalem'));
    assertSame(jlm, { source: 'city', slug: 'jerusalem', place: { latitude: 31.769, longitude: 35.2163, elevationM: 828, timeZone: 'Asia/Jerusalem' }, il: true }, 'Jerusalem');
    const harish = resolveApiPlace(coords(HARISH));
    assertSame(harish, { source: 'coords', slug: null, place: { latitude: 32.4618, longitude: 35.0456, timeZone: 'Asia/Jerusalem', elevationM: HEIGHT }, il: true }, 'Harish by coordinates');
    assertSame(heightReads, [[{ latitude: 32.4618, longitude: 35.0456 }]], 'the height read');
    const ny = resolveApiPlace(coords(NY));
    assert(ny.place.timeZone === 'America/New_York' && ny.place.elevationM === null && !ny.il && heightReads.length === 1, `New York: ${show(ny)}`);
    const hebron = resolveApiPlace(coords(HEBRON));
    assert(hebron.place.timeZone === 'Asia/Hebron' && !hebron.il && hebron.place.elevationM === null && heightReads.length === 1, `Hebron: ${show(hebron)}`);
    assert(codeOfSync(() => resolveApiPlace(coords(SEA))) === 'NO_TIME_ZONE', 'at sea');
    assert(codeOfSync(() => resolveApiPlace(city('atlantis'))) === 'UNKNOWN_CITY', 'an unknown city');
    heightFails = true;
    captured.length = 0;
    const failed = resolveApiPlace(coords(HARISH));
    heightFails = false;
    assert(failed.place.elevationM === null && failed.il, 'a failing map: sea level');
    assert(captured.length === 1 && captured[0].context === 'api-v1' && captured[0].message === 'the Israel height map could not be read: counted at sea level: Error' && show(captured[0].extra) === show({ service: 'api-v1', step: 'height' }), `the report: ${show(captured)}`);
    assert(defaultCommunityIn('Asia/Jerusalem') === 'sephardi' && defaultCommunityIn('America/New_York') === 'ashkenazi' && defaultCommunityIn('Asia/Hebron') === 'ashkenazi', 'the default community');
  });

  await check('P2 the parameters: every 400 code by its rule; an unknown or a repeated parameter; coordinates rounded to 4 places and checked before any lookup; the date bounds; to at most 366 days after from; a slug or coordinates as people mistype them', () => {
    const shab = (qs: string) => codeOfSync(() => params.readShabbatParams(search(qs)));
    const dayq = (qs: string) => codeOfSync(() => params.readDayParams(search(qs)));
    const cases: [string, string][] = [
      [shab(''), 'INVALID_PLACE'],
      [shab('city=jerusalem&lat=31.7&lon=35.2'), 'INVALID_PLACE'],
      [dayq('lat=31.7'), 'INVALID_PLACE'],
      [dayq('lon=35.2'), 'INVALID_PLACE'],
      [shab('city=Jerusalem'), 'UNKNOWN_CITY'],
      [shab('city=tel%20aviv'), 'UNKNOWN_CITY'],
      [shab('city='), 'UNKNOWN_CITY'],
      [dayq('lat=91&lon=0'), 'INVALID_COORDINATES'],
      [dayq('lat=0&lon=-180.5'), 'INVALID_COORDINATES'],
      [dayq('lat=abc&lon=0'), 'INVALID_COORDINATES'],
      [dayq('lat=32,46&lon=35'), 'INVALID_COORDINATES'],
      [dayq('lat=%2B32.4&lon=35'), 'INVALID_COORDINATES'],
      [dayq('lat=32.4%20&lon=35'), 'INVALID_COORDINATES'],
      [dayq('lat=1e1&lon=35'), 'INVALID_COORDINATES'],
      [dayq('lat=&lon=35'), 'INVALID_COORDINATES'],
      [dayq('city=jerusalem&date=2026-02-30'), 'INVALID_DATE'],
      [dayq('city=jerusalem&date=2026-2-3'), 'INVALID_DATE'],
      [dayq('city=jerusalem&date=1999-12-31'), 'OUT_OF_RANGE'],
      [shab('city=jerusalem&to=2100-01-01'), 'OUT_OF_RANGE'],
      [shab('city=jerusalem&from=2026-11-20&to=2026-11-13'), 'INVALID_RANGE'],
      [shab('city=jerusalem&from=2026-01-01&to=2027-01-03'), 'INVALID_RANGE'],
      [dayq('city=jerusalem&community=yemenite'), 'INVALID_COMMUNITY'],
      [dayq('city=jerusalem&lang=fr'), 'INVALID_LANG'],
      [dayq('city=jerusalem&from=2026-11-13'), 'UNKNOWN_PARAMETER'],
      [shab('city=jerusalem&date=2026-11-13'), 'UNKNOWN_PARAMETER'],
      [dayq('city=jerusalem&lang=en&lang=he'), 'UNKNOWN_PARAMETER'],
    ];
    cases.forEach(([got, want], i) => assert(got === want, `case ${i}: ${got}, wanted ${want}`));
    assert(shab('city=jerusalem&from=2026-01-01&to=2027-01-02') === 'none', '366 days is one range');
    assertSame(params.readShabbatParams(search('city=jerusalem')), { place: { kind: 'city', slug: 'jerusalem' }, community: null, lang: 'en', from: null, to: null }, 'the defaults');
    assertSame(params.readDayParams(search('lat=40.71284&lon=-74.00606&community=chabad&lang=ru&date=2026-11-14')), { place: { kind: 'coords', latitude: 40.7128, longitude: -74.0061 }, community: 'chabad', lang: 'ru', date: '2026-11-14' }, 'rounded to 4 places');
    let message = '';
    try {
      params.readShabbatParams(search('city=Jerusalem'));
    } catch (error) {
      message = (error as Error).message;
    }
    assert(/city list/.test(message) && !/Jerusalem/.test(message), `the slug message: ${message}`);
    assert(params.daysBetween('2026-01-01', '2027-01-02') === 366 && params.daysBetween('2026-03-27', '2026-03-28') === 1, 'daysBetween');
  });

  await check('P3 the credits: the Copernicus notice wherever a height is given, GeoNames for a city, OpenStreetMap for coordinates', () => {
    const sources = (p: Row) => creditsFor(resolveApiPlace(p)).map((c: Row) => c.source);
    assertSame(sources(city('jerusalem')), ['copernicus-dem', 'geonames'], 'Jerusalem');
    assertSame(sources(city('new-york')), ['geonames'], 'New York');
    assertSame(sources(coords(HARISH)), ['copernicus-dem', 'openstreetmap'], 'Harish');
    assertSame(sources(coords(NY)), ['openstreetmap'], 'New York by coordinates');
    const [copernicus, geonames] = creditsFor(resolveApiPlace(city('jerusalem')));
    assert(copernicus.text === COPERNICUS_NOTICE && copernicus.url === undefined, 'the Copernicus text is the site\'s own');
    assertSame(geonames, { source: 'geonames', text: 'City positions: GeoNames, under CC BY 4.0.', url: 'https://www.geonames.org/' }, 'GeoNames');
    assertSame(creditsFor(resolveApiPlace(coords(NY)))[0], { source: 'openstreetmap', text: 'Time zone map © OpenStreetMap contributors, under ODbL.', url: 'https://www.openstreetmap.org/copyright' }, 'OpenStreetMap');
  });

  await check('V1 one code path: for Jerusalem and Haifa (Sephardi), Haifa (Ashkenazi) and New York (Ashkenazi), every week over 400 days, /shabbat\'s blocks are the city page\'s "ahead" windows row for row and instant for instant; each candle lighting is its eve\'s CANDLE_LIGHTING, 20 minutes before that day\'s SHKIA; each start is restDayBlocks\' start; every day\'s /day rows and hours (Jerusalem, New York) are zmanDayForPlace\'s', async () => {
    const instants = (rows: Row[]) => rows.map((r: Row) => [r.key, r.at === null ? null : Date.parse(r.at)]);
    for (const [slug, community] of [['jerusalem', 'sephardi'], ['haifa', 'sephardi'], ['haifa', 'ashkenazi'], ['new-york', 'ashkenazi']] as const) {
      const c = cityBySlug(slug);
      const apiPlace = resolveApiPlace(city(slug));
      const zone = apiPlace.place.timeZone;
      for (let i = 0; i < 400; i += 7) {
        const from = addDaysToDate('2026-11-01', i);
        const to = addDaysToDate(from, 8);
        const view = buildCityView(c, { day: from, community, today: from, dayFromParam: true, communityFromParam: false }, 'en');
        const answer = await shabbat({ place: city(slug), community, from, to });
        const ours = answer.blocks.map((b: Row) => [b.eve, b.last, b.days.map((d: Row) => [d.date, instants(d.rows)])]);
        const page = view.ahead.map((w: Row) => [w.eve, w.last, w.days.map((d: Row) => [d.day, instants(d.rows)])]);
        assertSame(ours, page, `${slug} ${community} from ${from}`);
        for (const block of answer.blocks) {
          const eve = zmanDayForPlace(apiPlace.place, community, block.eve, { memo: new Map(), quiet: true });
          const candle = eve.rows.find((r: Row) => r.key === 'CANDLE_LIGHTING');
          const sunset = eve.rows.find((r: Row) => r.key === 'SHKIA');
          assert(candle?.at && block.candleLighting.at !== null && Date.parse(block.candleLighting.at) === Date.parse(candle.at), `${slug} ${block.eve}: the candle lighting`);
          assert(sunset?.at && Date.parse(sunset.at) - Date.parse(candle.at) === 20 * 60_000, `${slug} ${block.eve}: not 20 minutes before sunset`);
          const own = restDayBlocks({ from: startOfLocalDay(addDaysToDate(block.eve, -3), zone), to: startOfLocalDay(addDaysToDate(block.eve, 4), zone) }, apiPlace.place, community).find((b: Row) => b.eve === block.eve);
          assert((own?.start?.getTime() ?? null) === (block.start.at === null ? null : Date.parse(block.start.at)), `${slug} ${block.eve}: the start`);
        }
      }
    }
    for (const slug of ['jerusalem', 'new-york']) {
      const apiPlace = resolveApiPlace(city(slug));
      const community = defaultCommunityIn(apiPlace.place.timeZone);
      for (let i = 0; i < 400; i++) {
        const date = addDaysToDate('2026-11-01', i);
        const answer = await day({ place: city(slug), date });
        const list = zmanDayForPlace(apiPlace.place, community, date, { memo: new Map(), quiet: true });
        assertSame(instants(answer.rows), instants(list.rows), `${slug} ${date}: the rows`);
        assertSame(answer.rows.map((r: Row) => r.opinion), list.rows.map((r: Row) => r.opinion), `${slug} ${date}: the opinions`);
        assertSame(answer.hours.map((h: Row) => [h.opinion, h.ms]), list.hours.map((h: Row) => [h.opinion, h.ms]), `${slug} ${date}: the hours`);
      }
    }
  });

  await check('V2 the golden answers: Jerusalem 13-14 November 2026 as spec §3.1; a range that ends on an eve still lists that block whole; Yom Kippur; Shavuot on a Friday in Israel; Pesach and Sukkot in New York with the second night\'s "candle lighting after"; the far north with a null end', async () => {
    const jlm = await shabbat({ place: city('jerusalem'), from: '2026-11-13', to: '2026-11-14' });
    assertSame(jlm.blocks, GOLDEN_BLOCKS, 'Jerusalem');
    assertSame({ place: jlm.place, community: jlm.community, lang: jlm.lang, from: jlm.from, to: jlm.to }, { place: { city: 'jerusalem', timeZone: 'Asia/Jerusalem', inIsrael: true, elevationM: 828 }, community: 'sephardi', lang: 'en', from: '2026-11-13', to: '2026-11-14' }, 'Jerusalem\'s frame');
    assertSame(jlm.credits.map((c: Row) => c.source), ['copernicus-dem', 'geonames'], 'Jerusalem\'s credits');
    assertSame((await shabbat({ place: city('jerusalem'), from: '2026-11-13', to: '2026-11-13' })).blocks, GOLDEN_BLOCKS, 'a range that ends on the eve');
    assertSame((await shabbat({ place: city('jerusalem'), from: '2026-11-14', to: '2026-11-14' })).blocks, GOLDEN_BLOCKS, 'a block under way on from');

    const [yk] = (await shabbat({ place: city('jerusalem'), from: '2026-09-20', to: '2026-09-20' })).blocks;
    assertSame([yk.eve, yk.last, locals(yk), yk.holidays.map((h: Row) => h.title), yk.parasha, yk.end.key, yk.end.name], ['2026-09-20', '2026-09-21', [['2026-09-20', [['CANDLE_LIGHTING', '18:23']]], ['2026-09-21', [['YOM_TOV_ENDS', '19:12']]]], ['Yom Kippur'], null, 'YOM_TOV_ENDS', 'Yom Tov ends'], 'Yom Kippur');

    const [shavuot] = (await shabbat({ place: city('jerusalem'), from: '2026-05-21', to: '2026-05-21' })).blocks;
    assertSame([shavuot.eve, shavuot.last, locals(shavuot), shavuot.holidays.map((h: Row) => h.title), shavuot.parasha?.title], ['2026-05-21', '2026-05-23', [['2026-05-21', [['CANDLE_LIGHTING', '19:17']]], ['2026-05-22', [['CANDLE_LIGHTING', '19:18']]], ['2026-05-23', [['SHABBAT_ENDS', '20:10']]]], ['Shavuot'], 'Parashat Nasso'], 'Shavuot on a Friday in Israel');

    const [pesach] = (await shabbat({ place: city('new-york'), from: '2027-04-21', to: '2027-04-21' })).blocks;
    assertSame([pesach.eve, pesach.last, locals(pesach), pesach.holidays.map((h: Row) => h.title)], ['2027-04-21', '2027-04-24', [['2027-04-21', [['CANDLE_LIGHTING', '19:21']]], ['2027-04-22', [['CANDLE_LIGHTING_NOT_BEFORE', '20:26']]], ['2027-04-23', [['CANDLE_LIGHTING', '19:23']]], ['2027-04-24', [['SHABBAT_ENDS', '20:29']]]], ['Pesach I', 'Pesach II']], 'Pesach in New York');
    assert(pesach.days[1].rows[0].name === 'Candle lighting after', `the second night's row: ${pesach.days[1].rows[0].name}`);

    const [sukkot] = (await shabbat({ place: city('new-york'), from: '2026-09-25', to: '2026-09-25' })).blocks;
    assertSame([sukkot.eve, sukkot.last, locals(sukkot), sukkot.holidays.map((h: Row) => h.title), sukkot.end.key], ['2026-09-25', '2026-09-27', [['2026-09-25', [['CANDLE_LIGHTING', '18:28']]], ['2026-09-26', [['CANDLE_LIGHTING_NOT_BEFORE', '19:27']]], ['2026-09-27', [['YOM_TOV_ENDS', '19:26']]]], ['Sukkot I', 'Sukkot II'], 'YOM_TOV_ENDS'], 'Sukkot in New York');

    const north = await shabbat({ place: city('saint-petersburg'), from: '2027-06-18', to: '2027-06-19' });
    assertSame(north.blocks.map((b: Row) => [b.eve, b.last, b.candleLighting, b.start, b.end]), [['2027-06-18', '2027-06-19', { at: '2027-06-18T22:04:00+03:00', local: '22:04' }, { at: '2027-06-18T22:24:00+03:00', local: '22:24' }, { key: 'SHABBAT_ENDS', name: 'Shabbat ends', at: null, local: null }]], 'the far north');
    assert(north.community === 'ashkenazi', 'the far north\'s default community');
  });

  await check('V3 the times: every at is the place\'s wall clock with the zone\'s offset at that instant and parses back to the engine\'s instant, local is its hh:mm; on both sides of each clock change in Israel and New York; isoWithOffset by itself', async () => {
    const checkAll = (answer: Row, zone: string) => {
      for (const block of answer.blocks) {
        for (const t of [block.candleLighting, block.start, block.end, ...block.days.flatMap((d: Row) => d.rows)].filter(Boolean)) {
          if (t.at === null) continue;
          const instant = new Date(Date.parse(t.at));
          assert(t.at.slice(0, 19) === instantToWallTime(instant, zone) && t.local === t.at.slice(11, 16), `${zone} ${t.at} ${t.local}`);
        }
      }
    };
    const offsets = (answer: Row) => answer.blocks.map((b: Row) => [b.candleLighting.at, b.end.at]);
    const jlmAutumn = await shabbat({ place: city('jerusalem'), from: '2026-10-23', to: '2026-10-30' });
    assertSame(offsets(jlmAutumn), [['2026-10-23T17:42:00+03:00', '2026-10-24T18:32:00+03:00'], ['2026-10-30T16:36:00+02:00', '2026-10-31T17:26:00+02:00']], 'Jerusalem in October');
    const jlmSpring = await shabbat({ place: city('jerusalem'), from: '2027-03-19', to: '2027-03-26' });
    assert(jlmSpring.blocks.length === 2 && jlmSpring.blocks[0].candleLighting.at.endsWith('+02:00') && jlmSpring.blocks[1].candleLighting.at === '2027-03-26T18:38:00+03:00', `Jerusalem in March: ${show(offsets(jlmSpring))}`);
    const nyAutumn = await shabbat({ place: city('new-york'), from: '2026-10-30', to: '2026-11-06' });
    assertSame(offsets(nyAutumn), [['2026-10-30T17:34:00-04:00', '2026-10-31T18:36:00-04:00'], ['2026-11-06T16:26:00-05:00', '2026-11-07T17:28:00-05:00']], 'New York in the autumn');
    const nySpring = await shabbat({ place: city('new-york'), from: '2027-03-12', to: '2027-03-19' });
    assert(nySpring.blocks[0].candleLighting.at === '2027-03-12T17:39:00-05:00' && nySpring.blocks[0].end.at === '2027-03-13T18:41:00-05:00' && nySpring.blocks[1].candleLighting.at.endsWith('-04:00'), `New York in March: ${show(offsets(nySpring))}`);
    for (const [answer, zone] of [[jlmAutumn, 'Asia/Jerusalem'], [jlmSpring, 'Asia/Jerusalem'], [nyAutumn, 'America/New_York'], [nySpring, 'America/New_York']] as const) checkAll(answer, zone);
    const changeDay = await day({ place: city('new-york'), date: '2026-11-01' });
    for (const r of changeDay.rows) assert(r.at === null || (r.at.slice(0, 19) === instantToWallTime(new Date(Date.parse(r.at)), 'America/New_York') && r.local === r.at.slice(11, 16)), `New York on its change day: ${show(r)}`);
    assert(isoWithOffset(new Date('2026-11-14T22:17:30.500Z'), 'UTC') === '2026-11-14T22:17:30+00:00', 'UTC, the seconds kept and the milliseconds dropped');
    assert(isoWithOffset(new Date('2026-11-14T10:00:00Z'), 'Asia/Kolkata') === '2026-11-14T15:30:00+05:30', 'a half-hour zone');
  });

  await check('V4 /day in New York by coordinates, in Hebrew (spec §3.1 b): the place, Ashkenazi by default, the rows in the order of the day with their opinions and Hebrew names, the hours, the Hebrew date in letters, the parasha, the OpenStreetMap credit', async () => {
    const ny = await day({ place: coords(NY), lang: 'he', date: '2026-11-14' });
    assertSame(ny.place, { latitude: 40.7128, longitude: -74.006, timeZone: 'America/New_York', inIsrael: false, elevationM: null }, 'the place');
    assert(ny.community === 'ashkenazi' && ny.lang === 'he' && ny.date === '2026-11-14', 'the frame');
    assertSame(ny.rows.map((r: Row) => [r.key, r.opinion, r.local]), [['ALOT', null, '05:17'], ['MISHEYAKIR', null, '05:43'], ['NETZ', null, '06:42'], ['SOF_SHMA_MGA', 'mga', '08:28'], ['SOF_SHMA_GRA', 'gra', '09:10'], ['SOF_TFILA', null, '10:00'], ['CHATZOT', null, '11:40'], ['MINCHA_GEDOLA', null, '12:11'], ['MINCHA_KETANA', null, '14:35'], ['PLAG_GRA', 'gra', '15:37'], ['SHKIA', null, '16:38'], ['TZEIT', null, '17:22'], ['SHABBAT_ENDS', null, '17:22'], ['CHATZOT_HALAYLA', null, '23:41']], 'the rows');
    assertSame(ny.rows[0], { key: 'ALOT', opinion: null, name: 'עלות השחר', at: '2026-11-14T05:17:00-05:00', local: '05:17' }, 'the first row');
    assert(ny.rows[3].name === 'סוף זמן קריאת שמע (מג״א)' && ny.rows[12].name === 'צאת השבת' && ny.rows[12].at === '2026-11-14T17:22:00-05:00', `the names: ${ny.rows[3].name} | ${ny.rows[12].name}`);
    assertSame(ny.hours, [{ opinion: 'gra', name: 'גר״א', ms: 2985250, text: '49:45' }, { opinion: 'mga', name: 'מג״א', ms: 3830083, text: '63:50' }], 'the hours');
    assertSame(ny.hebrewDate, { text: 'ד׳ בכסלו תשפ״ז', gematriya: 'ד׳ בכסלו תשפ״ז', day: 4, month: 'Kislev', year: 5787 }, 'the Hebrew date');
    assertSame(ny.holidays, [{ title: 'פרשת תולדות', brief: 'תולדות', kind: 'parasha', chag: false }], 'the parasha');
    assertSame(ny.credits.map((c: Row) => c.source), ['openstreetmap'], 'the credits');
  });

  await check('V5 the languages: row names, opinions and the Hebrew date in en, he and ru (Russian in the genitive, the Hebrew date always in letters), holidays as holidaysInRange gives them; and /day in the far north on a summer day is an answer with null times, never a failure (Review Focus 5)', async () => {
    for (const lang of ['en', 'he', 'ru']) {
      const answer = await day({ place: city('jerusalem'), lang, date: '2026-11-14' });
      const words = messages[lang].calendarHome;
      const end = answer.rows.find((r: Row) => r.key === 'SHABBAT_ENDS');
      assert(end.name === words.zmanimList.shabbatEnds, `${lang}: ${end.name}`);
      assertSame(answer.hours.map((h: Row) => h.name), answer.hours.map((h: Row) => words.zmanim.opinions[h.opinion]), `${lang}: the opinions`);
      assertSame(answer.holidays.map((h: Row) => h.title), (holidaysInRange('2026-11-14', '2026-11-14', lang, { il: true })['2026-11-14'] ?? []).map((h: Row) => h.title), `${lang}: the holidays`);
      assert(answer.hebrewDate.gematriya === 'ד׳ בכסלו תשפ״ז' && answer.hebrewDate.month === 'Kislev', `${lang}: the gematriya`);
    }
    assert((await day({ place: city('jerusalem'), lang: 'en', date: '2026-11-14' })).hebrewDate.text === '4 Kislev 5787', 'English');
    assert((await day({ place: city('jerusalem'), lang: 'ru', date: '2026-11-14' })).hebrewDate.text === '4 кислева 5787', 'Russian, genitive');
    const north = await day({ place: city('saint-petersburg'), date: '2027-06-19' });
    assert(north.rows.some((r: Row) => r.at === null && r.local === null) && north.rows.some((r: Row) => r.at !== null), `the far north: ${show(north.rows.map((r: Row) => [r.key, r.local]))}`);
  });

  await check('V6 the bot\'s process memo of zmanim is untouched by every answer of the run', () => {
    assert(memoSize() === memoBefore, `the process memo grew from ${memoBefore} to ${memoSize()}`);
  });

  // ---- Task 5: the routes (H1-H10) and the whole run's logs (Z1) ----

  void CITIES;
  report();
}

if (process.env[CHILD] !== '1') {
  void runChildren();
} else {
  runChecks().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

`void CITIES;` keeps the import used until Task 5 reads it (Task 5 deletes that line).

- [ ] **Step 2: Run it to see it fail**

Run: `RUN smoke-api-v1`
Expected: exit 1 in all three zones: the load of `src/lib/api-v1/params.ts` throws (`Cannot find module`).

- [ ] **Step 3: `src/lib/api-v1/respond.ts`**

```ts
// The Jewish times API's answers (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.6, §3.7): JSON in UTF-8,
// one error shape { error: { code, message } }, the caching and CORS headers, and how a thrown error is reported.
//
// - A 200 is `private, max-age=<s>` (a shared cache such as Cloudflare never serves it to a caller with no key); every error
//   is `no-store`. Every answer sends `Vary: Origin`.
// - An error's message is English developer text: never a place, a key or a value the caller sent.
// - reportable(): a thrown error as Sentry gets it, its kind and stack frames without its message (an engine's message
//   could hold a place).

import { safeErrorSummary } from '../../services/web-signin/safe-error';

export type ApiErrorCode =
  | 'INVALID_PLACE'
  | 'UNKNOWN_CITY'
  | 'INVALID_COORDINATES'
  | 'NO_TIME_ZONE'
  | 'INVALID_DATE'
  | 'INVALID_RANGE'
  | 'OUT_OF_RANGE'
  | 'INVALID_COMMUNITY'
  | 'INVALID_LANG'
  | 'UNKNOWN_PARAMETER'
  | 'MISSING_KEY'
  | 'INVALID_KEY'
  | 'ORIGIN_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'KEYS_UNAVAILABLE';

export const STATUS_OF: Record<ApiErrorCode, number> = {
  INVALID_PLACE: 400,
  UNKNOWN_CITY: 400,
  INVALID_COORDINATES: 400,
  NO_TIME_ZONE: 400,
  INVALID_DATE: 400,
  INVALID_RANGE: 400,
  OUT_OF_RANGE: 400,
  INVALID_COMMUNITY: 400,
  INVALID_LANG: 400,
  UNKNOWN_PARAMETER: 400,
  MISSING_KEY: 401,
  INVALID_KEY: 401,
  ORIGIN_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  KEYS_UNAVAILABLE: 503,
};

/** A refusal the handler answers with its code and message. */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** How long a 200 may be kept: the same inputs always give the same answer. */
export const HOUR_S = 3600;

const JSON_TYPE = 'application/json; charset=utf-8';

export function errorResponse(code: ApiErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status: STATUS_OF[code],
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store', Vary: 'Origin', ...headers },
  });
}

export function okResponse(body: unknown, maxAgeS: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': `private, max-age=${maxAgeS}`, Vary: 'Origin', ...headers },
  });
}

/** The headers that let a browser on `origin` read an answer, its rate headers included. */
export function corsHeaders(origin: string): Record<string, string> {
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset' };
}

/** `error` as Sentry may get it: "<label>: <its kind>", with the original stack frames and never its message. */
export function reportable(error: unknown, label: string): Error {
  const out = new Error(`${label}: ${safeErrorSummary(error)}`);
  if (error instanceof Error && typeof error.stack === 'string') {
    const frames = error.stack.split('\n').filter((line) => /^\s+at /.test(line));
    out.stack = [`${out.name}: ${out.message}`, ...frames].join('\n');
  }
  return out;
}
```

- [ ] **Step 4: `src/lib/api-v1/params.ts`**

```ts
// The query of /api/v1/shabbat and /api/v1/day (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.1, §3.7):
// read strictly, so a typo in the other app shows at once. Any other parameter, a repeated one or a malformed one is a 400
// ApiError; an error's message names the parameter, never echoes its value.
//
// - A place is exactly one of `city` (a slug of src/site/cities.ts) or `lat` and `lon` (decimal degrees, rounded to 4
//   places, about 11 m); coordinates are checked here, before any zone lookup.
// - Dates are real days, yyyy-MM-dd, from 2000-01-01 to 2099-12-31; `to` is at most 366 days after `from`. A date left
//   out stays null here: its default is "today at the place" (handle.ts), which needs the place's zone.
// Pure: no import beyond the day check, the community check and the error.

import { isDayKey } from '../calendar-view/picker-model';
import { isCommunity, type ZmanimCommunity } from '../../services/zmanim/sets';
import { ApiError } from './respond';

export const API_LANGS = ['en', 'he', 'ru'] as const;
export type ApiLang = (typeof API_LANGS)[number];

export const FIRST_DAY = '2000-01-01';
export const LAST_DAY = '2099-12-31';
export const MAX_RANGE_DAYS = 366;
/** /shabbat with no `to`: a week after `from` (this week's Shabbat and any Yom Tov in it). */
export const DEFAULT_SPAN_DAYS = 7;

export type Endpoint = 'shabbat' | 'day';
export type PlaceParam = { kind: 'city'; slug: string } | { kind: 'coords'; latitude: number; longitude: number };
type CommonParams = { place: PlaceParam; community: ZmanimCommunity | null; lang: ApiLang };
export type ShabbatParams = CommonParams & { from: string | null; to: string | null };
export type DayParams = CommonParams & { date: string | null };

const ALLOWED: Record<Endpoint, readonly string[]> = {
  shabbat: ['city', 'lat', 'lon', 'community', 'lang', 'from', 'to'],
  day: ['city', 'lat', 'lon', 'community', 'lang', 'date'],
};
const SLUG = /^[a-z0-9-]{1,40}$/;
const DECIMAL = /^-?\d{1,3}(?:\.\d+)?$/;

/** A parameter name as an error may quote it: printable, at most 40 characters. */
const nameOf = (name: string) => name.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);

/** The parameters, each once; an unknown or a repeated one is UNKNOWN_PARAMETER. */
function singles(search: URLSearchParams, endpoint: Endpoint): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of search) {
    if (!ALLOWED[endpoint].includes(name)) throw new ApiError('UNKNOWN_PARAMETER', `${nameOf(name)} is not a parameter of /api/v1/${endpoint} (${ALLOWED[endpoint].join(', ')})`);
    if (out.has(name)) throw new ApiError('UNKNOWN_PARAMETER', `${name} is given more than once`);
    out.set(name, value);
  }
  return out;
}

function coordinate(text: string | undefined, limit: number, name: string): number {
  if (text === undefined || !DECIMAL.test(text)) throw new ApiError('INVALID_COORDINATES', `${name} must be decimal degrees, like 31.7683`);
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) > limit) throw new ApiError('INVALID_COORDINATES', `${name} must be between -${limit} and ${limit}`);
  return Math.round(value * 10_000) / 10_000;
}

function readPlace(p: Map<string, string>): PlaceParam {
  const city = p.get('city');
  const hasLat = p.has('lat');
  const hasLon = p.has('lon');
  if (city !== undefined && (hasLat || hasLon)) throw new ApiError('INVALID_PLACE', 'give city, or lat and lon, not both');
  if (city !== undefined) {
    if (!SLUG.test(city)) throw new ApiError('UNKNOWN_CITY', 'city must be a slug of the city list in lower case (see the reference\'s city list)');
    return { kind: 'city', slug: city };
  }
  if (!hasLat && !hasLon) throw new ApiError('INVALID_PLACE', 'give city, or lat and lon');
  if (!hasLat || !hasLon) throw new ApiError('INVALID_PLACE', 'lat and lon go together');
  return { kind: 'coords', latitude: coordinate(p.get('lat'), 90, 'lat'), longitude: coordinate(p.get('lon'), 180, 'lon') };
}

function readDay(text: string | undefined, name: string): string | null {
  if (text === undefined) return null;
  if (!isDayKey(text)) throw new ApiError('INVALID_DATE', `${name} must be a real day, yyyy-MM-dd`);
  if (text < FIRST_DAY || text > LAST_DAY) throw new ApiError('OUT_OF_RANGE', `${name} must be between ${FIRST_DAY} and ${LAST_DAY}`);
  return text;
}

function readCommon(p: Map<string, string>): CommonParams {
  const place = readPlace(p);
  const community = p.get('community');
  if (community !== undefined && !isCommunity(community)) throw new ApiError('INVALID_COMMUNITY', 'community must be sephardi, ashkenazi or chabad');
  const lang = p.get('lang') ?? 'en';
  if (!(API_LANGS as readonly string[]).includes(lang)) throw new ApiError('INVALID_LANG', 'lang must be en, he or ru');
  return { place, community: community ?? null, lang: lang as ApiLang };
}

/** Whole days from `a` to `b` (yyyy-MM-dd), read as the UTC days they name. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** `to` is not before `from` and at most 366 days after it. */
export function checkRange(from: string, to: string): void {
  if (to < from) throw new ApiError('INVALID_RANGE', 'to must not be before from');
  if (daysBetween(from, to) > MAX_RANGE_DAYS) throw new ApiError('INVALID_RANGE', `to must be at most ${MAX_RANGE_DAYS} days after from`);
}

export function readShabbatParams(search: URLSearchParams): ShabbatParams {
  const p = singles(search, 'shabbat');
  const common = readCommon(p);
  const from = readDay(p.get('from'), 'from');
  const to = readDay(p.get('to'), 'to');
  if (from !== null && to !== null) checkRange(from, to);
  return { ...common, from, to };
}

export function readDayParams(search: URLSearchParams): DayParams {
  const p = singles(search, 'day');
  return { ...readCommon(p), date: readDay(p.get('date'), 'date') };
}
```

P2's rounding input is `-74.00606` (not a half), so the check does not depend on how `Math.round` treats a half.

- [ ] **Step 5: `src/lib/api-v1/place.ts`**

```ts
// A request's place (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.2) as the engine reads one.
//
// - A city: its stored point, height and zone (cityPlace; every Israeli city is Asia/Jerusalem).
// - Coordinates (checked and rounded in params.ts): the zone from zoneForCoords; none (the open sea) is NO_TIME_ZONE, which
//   zoneForCoords reports as a warning with no coordinates. In Israel's zone the height is the stored map's at the point
//   itself (open point A); a map that cannot be read is reported under api-v1 and the place counts at sea level, as the
//   bot does. Abroad the height is null (no set uses it there).
// - `il` is inIsrael(zone): the Yom Tov days, the height, the Sephardi end of Shabbat, the holidays' { il }, the default
//   community. Asia/Hebron and Asia/Gaza count as abroad, as in the app.
// No place reaches a log or Sentry.

import { inIsrael, type Place } from '../../services/zmanim/compute';
import { highestHeight } from '../../services/zmanim/heights';
import { cityBySlug } from '../../site/cities';
import { cityPlace } from '../../site/zmanim/city-view';
import { captureError } from '../error-capture';
import { zoneForCoords } from '../zone-for-coords';
import type { PlaceParam } from './params';
import { ApiError, reportable } from './respond';

export type ApiPlace = {
  source: 'city' | 'coords';
  /** The city's slug, null for coordinates. */
  slug: string | null;
  place: Place;
  il: boolean;
};

function pointHeight(latitude: number, longitude: number): number | null {
  try {
    return highestHeight([{ latitude, longitude }]);
  } catch (error) {
    captureError(reportable(error, 'the Israel height map could not be read: counted at sea level'), 'api-v1', { service: 'api-v1', step: 'height' });
    return null;
  }
}

export function resolveApiPlace(param: PlaceParam): ApiPlace {
  if (param.kind === 'city') {
    const city = cityBySlug(param.slug);
    if (!city) throw new ApiError('UNKNOWN_CITY', 'city is not a slug of the city list (see the reference\'s city list)');
    return { source: 'city', slug: city.slug, place: cityPlace(city), il: inIsrael(city.timeZone) };
  }
  const zone = zoneForCoords(param.latitude, param.longitude);
  if (zone === null) throw new ApiError('NO_TIME_ZONE', 'there is no time zone at these coordinates (the open sea)');
  const il = inIsrael(zone);
  return {
    source: 'coords',
    slug: null,
    place: { latitude: param.latitude, longitude: param.longitude, timeZone: zone, elevationM: il ? pointHeight(param.latitude, param.longitude) : null },
    il,
  };
}
```

- [ ] **Step 6: `src/lib/api-v1/credits.ts`**

```ts
// The credits an answer carries (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.8): the licences ask for
// credit where derived data is shown, and the other app shows these beside the times, as the zmanim pages do.
//   copernicus-dem  wherever an answer gives a height (the stored heights are adapted Copernicus GLO-90 data)
//   geonames        a city's position and zone (NOTICE item 2)
//   openstreetmap   a zone found from coordinates (timezone-boundary-builder's map)
// The texts are English constants, never translated (a licence's words are its own). hebcal is code and needs no credit.

import { COPERNICUS_NOTICE } from '../../site/zmanim/sources';
import type { ApiPlace } from './place';

export type Credit = { source: 'copernicus-dem' | 'geonames' | 'openstreetmap'; text: string; url?: string };

const COPERNICUS: Credit = { source: 'copernicus-dem', text: COPERNICUS_NOTICE };
const GEONAMES: Credit = { source: 'geonames', text: 'City positions: GeoNames, under CC BY 4.0.', url: 'https://www.geonames.org/' };
const OPENSTREETMAP: Credit = { source: 'openstreetmap', text: 'Time zone map © OpenStreetMap contributors, under ODbL.', url: 'https://www.openstreetmap.org/copyright' };

export function creditsFor(place: ApiPlace): Credit[] {
  const out: Credit[] = [];
  if (place.place.elevationM !== null) out.push(COPERNICUS);
  out.push(place.source === 'city' ? GEONAMES : OPENSTREETMAP);
  return out;
}
```

- [ ] **Step 7: `src/services/zmanim/api-view.ts`**

```ts
// The Jewish times API's answers as JSON (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.1, §3.3, §3.4):
// /api/v1/shabbat's blocks and /api/v1/day's day, from the same code the zmanim pages and the sun sheet read.
//
// - Every time comes from zmanDayForPlace (day-list.ts) with the request's own memo and quiet, never the process memo, and
//   the blocks from restBlocksBetween (rest-blocks-view.ts), which the city pages' "ahead" section calls too.
// - A row is named by zmanRowName over calendarHome.* (the sun sheet's words), an opinion by calendarHome.zmanim.opinions.*,
//   a holiday and the parasha by holidaysInRange in the language (il from the place's zone).
// - `local` is the place's clock, hh:mm in 24 hours; `at` is the same reading with the zone's offset at that instant
//   (isoWithOffset: epoch arithmetic over instantToWallTime, never the server's zone and never formatInTimeZone). Where the
//   sun makes no time both are null.
// - The Hebrew date is the civil day's daytime date (no sunset shift), as the home and the site show it, the Russian month
//   in the genitive (calendarHome.hebrewMonthGenitive); `gematriya` is always the Hebrew text.
//
// Server only (src/services/zmanim, hebcal): only route handlers import it, never a 'use client' file. Pure: no database,
// Redis, network or clock (the caller gives every day).

import { createTranslator } from 'next-intl';
import type { Credit } from '../../lib/api-v1/credits';
import type { ApiLang } from '../../lib/api-v1/params';
import type { ApiPlace } from '../../lib/api-v1/place';
import { hebrewDateOf, hebrewFullDate } from '../../lib/calendar-view/hebrew-date';
import type { ZmanOpinion } from '../../lib/calendar-view/zman-spec';
import { zmanRowName, type ZmanWordsT } from '../../lib/calendar-view/zman-words';
import { formatHalachicHour, type ZmanimListRow } from '../../lib/calendar-view/zmanim-list';
import { instantToWallTime } from '../../utils/wall-time';
import { holidaysInRange, type Holiday } from '../hebrew-holidays';
import { zmanDayForPlace, type ZmanMemo } from './day-list';
import { restBlocksBetween, type RestBlockView } from './rest-blocks-view';
import type { ZmanimCommunity } from './sets';

export type ApiTime = { at: string | null; local: string | null };
export type ApiRow = { key: string; opinion: ZmanOpinion | null; name: string } & ApiTime;
export type ApiHoliday = { title: string; brief: string; kind: Holiday['kind']; chag: boolean };
export type ApiPlaceJson =
  | { city: string; timeZone: string; inIsrael: boolean; elevationM: number | null }
  | { latitude: number; longitude: number; timeZone: string; inIsrael: boolean; elevationM: number | null };

export type ShabbatBlock = {
  eve: string;
  last: string;
  candleLighting: ApiTime;
  start: ApiTime;
  end: ({ key: string; name: string } & ApiTime) | null;
  parasha: { title: string; brief: string } | null;
  holidays: ApiHoliday[];
  days: { date: string; rows: ApiRow[] }[];
};

export type ShabbatAnswer = { place: ApiPlaceJson; community: ZmanimCommunity; lang: ApiLang; from: string; to: string; blocks: ShabbatBlock[]; credits: Credit[] };

export type DayAnswer = {
  place: ApiPlaceJson;
  community: ZmanimCommunity;
  lang: ApiLang;
  date: string;
  hebrewDate: { text: string; gematriya: string; day: number; month: string; year: number };
  holidays: ApiHoliday[];
  rows: ApiRow[];
  hours: { opinion: ZmanOpinion; name: string; ms: number | null; text: string | null }[];
  credits: Credit[];
};

export type ShabbatInput = { place: ApiPlace; community: ZmanimCommunity; lang: ApiLang; from: string; to: string; credits: Credit[] };
export type DayInput = { place: ApiPlace; community: ZmanimCommunity; lang: ApiLang; date: string; credits: Credit[] };

const END_KEYS: readonly string[] = ['SHABBAT_ENDS', 'YOM_TOV_ENDS', 'SHABBAT_YOM_TOV_ENDS'];

type Words = { t: ZmanWordsT; genitive: readonly string[] };
/** One translator of calendarHome.* per language, made once (the pattern of native-reminders/zman-view.ts). */
const WORDS = new Map<ApiLang, Words>();

async function wordsFor(lang: ApiLang): Promise<Words> {
  let words = WORDS.get(lang);
  if (!words) {
    const messages = (await import(`../../../messages/${lang}.json`)).default;
    words = {
      t: createTranslator({ locale: lang, messages, namespace: 'calendarHome' }) as unknown as ZmanWordsT,
      genitive: messages.calendarHome.hebrewMonthGenitive as readonly string[],
    };
    WORDS.set(lang, words);
  }
  return words;
}

/** `instant` on `zone`'s clock with the zone's offset at that instant: 2026-11-13T16:25:00+02:00 (whole seconds). */
export function isoWithOffset(instant: Date, zone: string): string {
  const wall = instantToWallTime(instant, zone);
  const wholeSecond = Math.floor(instant.getTime() / 1000) * 1000;
  const offsetMin = Math.round((Date.parse(`${wall}Z`) - wholeSecond) / 60_000);
  const abs = Math.abs(offsetMin);
  const sign = offsetMin < 0 ? '-' : '+';
  return `${wall}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** A UTC ISO instant (or null) as the API gives a time: `at` with the offset, `local` the place's hh:mm. */
export function apiTime(iso: string | null, zone: string): ApiTime {
  if (iso === null) return { at: null, local: null };
  const instant = new Date(iso);
  return { at: isoWithOffset(instant, zone), local: instantToWallTime(instant, zone).slice(11, 16) };
}

function placeJson(place: ApiPlace): ApiPlaceJson {
  const common = { timeZone: place.place.timeZone, inIsrael: place.il, elevationM: place.place.elevationM };
  return place.source === 'city' && place.slug !== null ? { city: place.slug, ...common } : { latitude: place.place.latitude, longitude: place.place.longitude, ...common };
}

const rowJson = (t: ZmanWordsT, row: ZmanimListRow, zone: string): ApiRow => ({ key: row.key, opinion: row.opinion, name: zmanRowName(t, row), ...apiTime(row.at, zone) });
const holidayJson = (h: Holiday): ApiHoliday => ({ title: h.title, brief: h.brief, kind: h.kind, chag: h.chag });

function blockJson(t: ZmanWordsT, block: RestBlockView, zone: string): ShabbatBlock {
  const candle = block.days[0]?.rows.find((row) => row.key === 'CANDLE_LIGHTING') ?? null;
  const ending = block.days[block.days.length - 1]?.rows.find((row) => END_KEYS.includes(row.key)) ?? null;
  return {
    eve: block.eve,
    last: block.last,
    candleLighting: apiTime(candle?.at ?? null, zone),
    start: apiTime(block.start, zone),
    end: ending ? { key: ending.key, name: zmanRowName(t, ending), ...apiTime(ending.at, zone) } : null,
    parasha: block.parasha ? { title: block.parasha.title, brief: block.parasha.brief } : null,
    holidays: block.holidays.map(holidayJson),
    days: block.days.map((d) => ({ date: d.day, rows: d.rows.map((row) => rowJson(t, row, zone)) })),
  };
}

/** /api/v1/shabbat: every block of rest days under way on `from` or beginning by `to`. */
export async function shabbatView(input: ShabbatInput): Promise<ShabbatAnswer> {
  const { t } = await wordsFor(input.lang);
  const memo: ZmanMemo = new Map();
  const zone = input.place.place.timeZone;
  const blocks = restBlocksBetween(input.place.place, input.community, input.from, input.to, input.lang, input.place.il, memo);
  return { place: placeJson(input.place), community: input.community, lang: input.lang, from: input.from, to: input.to, blocks: blocks.map((b) => blockJson(t, b, zone)), credits: input.credits };
}

/** /api/v1/day: one civil day's zmanim, halachic hours, holidays and Hebrew date. */
export async function dayView(input: DayInput): Promise<DayAnswer> {
  const { t, genitive } = await wordsFor(input.lang);
  const zone = input.place.place.timeZone;
  const list = zmanDayForPlace(input.place.place, input.community, input.date, { memo: new Map(), quiet: true });
  const hd = hebrewDateOf(input.date);
  if (!hd) throw new TypeError('the day is not a real day');
  return {
    place: placeJson(input.place),
    community: input.community,
    lang: input.lang,
    date: input.date,
    hebrewDate: { text: hebrewFullDate(input.date, input.lang, genitive), gematriya: hebrewFullDate(input.date, 'he'), day: hd.getDate(), month: hd.getMonthName(), year: hd.getFullYear() },
    holidays: (holidaysInRange(input.date, input.date, input.lang, { il: input.place.il })[input.date] ?? []).map(holidayJson),
    rows: list.rows.map((row) => rowJson(t, row, zone)),
    hours: list.hours.map((h) => ({ opinion: h.opinion, name: t(`zmanim.opinions.${h.opinion}`), ms: h.ms, text: h.ms === null ? null : formatHalachicHour(h.ms) })),
    credits: input.credits,
  };
}
```

- [ ] **Step 8: Run the smoke, the typecheck and lint**

```
RUN smoke-api-v1
npx tsc --noEmit -p .
npx eslint src/lib/api-v1 src/services/zmanim/api-view.ts scripts/smoke-api-v1.ts
RUN smoke-zmanim
RUN smoke-no-open-meteo
RUN smoke-dst
```
Expected: smoke-api-v1 prints `9/9 passed` in each of the three zones and `3/3 process zones passed`; smoke-zmanim (no 'use client' file imports the zmanim module), smoke-no-open-meteo (no console call holds a place) and smoke-dst (no wall time read through the server's zone) still pass; tsc and eslint clean. Prove V1 bites: in `restBlocksBetween` change `block.eve <= until` to `block.eve < until`; V2's "a range that ends on the eve" fails; restore.

- [ ] **Step 9: Commit**

```bash
git add src/lib/api-v1 src/services/zmanim/api-view.ts scripts/smoke-api-v1.ts
git commit -m "feat(api): the Jewish times answers: place, parameters, credits and views

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 5: The request handler, the routes, Sentry and the reference

**Files:**
- Create: `src/lib/api-v1/rate.ts`, `src/lib/api-v1/handle.ts`
- Create: `app/api/v1/shabbat/route.ts`, `app/api/v1/day/route.ts`, `app/api/v1/[...rest]/route.ts`
- Modify: `src/lib/sentry-scrub.ts`, `scripts/smoke-sentry-scrub.ts`
- Modify: `scripts/smoke-api-v1.ts` (part B replaces the `// ---- Task 5: …` line and `void CITIES;`)
- Create: `docs/api/jewish-times-v1.md`
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: Task 2's `findApiKey`, `anyKeyListsOrigin`, `KeysUnavailable`, `__pendingKeyRefreshForTests`, `createApiKey`; Task 4's `readShabbatParams`, `readDayParams`, `checkRange`, `DEFAULT_SPAN_DAYS`, `LAST_DAY`, `Endpoint`, `resolveApiPlace`, `creditsFor`, `shabbatView`, `dayView`, `ApiError`, `HOUR_S`, `corsHeaders`, `errorResponse`, `okResponse`, `reportable`; Task 1's `defaultCommunityIn`.
- Produces:
  - rate.ts: `API_RATE_LIMIT = 300`, `API_RATE_WINDOW_MS = 60000`, `type RateVerdict = { ok: boolean; limit: number; remaining: number; resetS: number; retryAfterS: number }`, `countRequest(keyId: number, now: number): RateVerdict`, `rateHeaders(v: RateVerdict): Record<string, string>`; state on `globalThis.__apiV1Rate`
  - handle.ts: `handleApiV1(request: Request, endpoint: Endpoint): Promise<Response>`, `preflight(request: Request): Promise<Response>`, `notFound(): Response`

- [ ] **Step 1: Write the failing checks (part B of smoke-api-v1)**

In `scripts/smoke-api-v1.ts`:

1a. Change the two imports at the top to:

```ts
import { advanceClock, installApiWorld, prismaFails, redisCalls, redisFails, resetApiWorld, setClock } from './lib/api-world';
import { assert, captured, check, everyCapture, everyLog, load, logs, prismaCalls, redisStore, report, ROOT, show, stubModule, type Row } from './lib/signin-world';
```

1b. Add after `const SEA = …;`:

```ts
const ADMIN = 9;
const MIRROR = 'api:keys:v1';
/** One second into a minute, so a rate window has 59 seconds to run. */
const T0 = Date.UTC(2026, 10, 13, 8, 0, 1);
const BROWSER_ORIGIN = 'https://candles.example.test';
const OTHER_ORIGIN = 'https://elsewhere.example.test';
const DAY_URL = '/api/v1/day?city=jerusalem&date=2026-11-14';
/** No log line or Sentry field may hold these either: the keys, their hashes and prefixes, the origins (Z1). */
const KEYS: string[] = ['candles.example.test', 'elsewhere.example.test', 'Shabbat site', 'Candle app'];
```

1c. Replace the two lines `  // ---- Task 5: the routes (H1-H10) and the whole run's logs (Z1) ----` and `  void CITIES;` with:

```ts
  const crypto = await import('node:crypto');
  const store = await load('src/services/api-keys/store.ts');
  const lookup = await load('src/services/api-keys/lookup.ts');
  const routes: Record<string, Row> = {
    shabbat: await load('app/api/v1/shabbat/route.ts'),
    day: await load('app/api/v1/day/route.ts'),
    rest: await load('app/api/v1/[...rest]/route.ts'),
  };
  const remember = (key: string) => {
    KEYS.push(key, crypto.createHash('sha256').update(key, 'utf8').digest('hex'), key.slice(0, 10));
    return key;
  };
  /** Two keys: a server key, and a browser key locked to BROWSER_ORIGIN (typed as a person might: capital, trailing slash). */
  const seedKeys = async () => {
    const server = await store.createApiKey('Shabbat site', '', ADMIN);
    const browser = await store.createApiKey('Candle app', 'https://Candles.Example.test/', ADMIN);
    remember(server.key);
    remember(browser.key);
    return { server: server as Row, browser: browser as Row };
  };
  const forgetCopy = () => {
    delete (globalThis as Row).__apiKeys;
  };
  type Call = { key?: string | null; auth?: string; origin?: string; method?: 'GET' | 'OPTIONS' };
  const call = async (url: string, o: Call = {}): Promise<{ status: number; body: Row; headers: Headers }> => {
    const headers: Record<string, string> = {};
    if (o.auth !== undefined) headers.authorization = o.auth;
    else if (o.key) headers.authorization = `Bearer ${o.key}`;
    if (o.origin) headers.origin = o.origin;
    const request = new Request(`https://famcal.bot${url}`, { method: o.method ?? 'GET', headers });
    const pathname = new URL(request.url).pathname;
    const route = pathname === '/api/v1/shabbat' ? routes.shabbat : pathname === '/api/v1/day' ? routes.day : routes.rest;
    const res: Response = await (o.method === 'OPTIONS' ? route.OPTIONS(request) : route.GET(request));
    const text = await res.text();
    let body: Row = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { notJson: text.slice(0, 80) };
    }
    return { status: res.status, body, headers: res.headers };
  };
  const cache = (r: { headers: Headers }) => r.headers.get('cache-control');

  await check('H1 every error code with its status and the one shape { error: { code, message } }, no-store and JSON in UTF-8; a lower-case bearer is a bearer; malformed coordinates make no zone lookup (no warning reaches Sentry)', async () => {
    resetApiWorld();
    setClock(T0);
    const { server } = await seedKeys();
    const cases: [string, Call, number, string][] = [
      ['/api/v1/shabbat?city=jerusalem', { key: null }, 401, 'MISSING_KEY'],
      ['/api/v1/shabbat?city=jerusalem', { auth: 'Basic abc' }, 401, 'MISSING_KEY'],
      ['/api/v1/shabbat?city=jerusalem', { key: `fcj_${'B'.repeat(43)}` }, 401, 'INVALID_KEY'],
      ['/api/v1/shabbat?city=jerusalem', { key: 'not-a-key' }, 401, 'INVALID_KEY'],
      ['/api/v1/shabbat', {}, 400, 'INVALID_PLACE'],
      ['/api/v1/shabbat?city=jerusalem&lat=1&lon=2', {}, 400, 'INVALID_PLACE'],
      ['/api/v1/shabbat?city=atlantis', {}, 400, 'UNKNOWN_CITY'],
      ['/api/v1/day?lat=91&lon=0', {}, 400, 'INVALID_COORDINATES'],
      ['/api/v1/day?lat=32,46&lon=35', {}, 400, 'INVALID_COORDINATES'],
      ['/api/v1/day?city=jerusalem&date=2026-02-30', {}, 400, 'INVALID_DATE'],
      ['/api/v1/shabbat?city=jerusalem&from=2026-11-20&to=2026-11-13', {}, 400, 'INVALID_RANGE'],
      ['/api/v1/shabbat?city=jerusalem&from=2026-01-01&to=2027-01-03', {}, 400, 'INVALID_RANGE'],
      ['/api/v1/day?city=jerusalem&date=1999-12-31', {}, 400, 'OUT_OF_RANGE'],
      ['/api/v1/day?city=jerusalem&community=yemenite', {}, 400, 'INVALID_COMMUNITY'],
      ['/api/v1/day?city=jerusalem&lang=fr', {}, 400, 'INVALID_LANG'],
      ['/api/v1/day?city=jerusalem&from=2026-11-13', {}, 400, 'UNKNOWN_PARAMETER'],
      ['/api/v1/day?city=jerusalem&lang=en&lang=he', {}, 400, 'UNKNOWN_PARAMETER'],
      ['/api/v1/zmanim?city=jerusalem', {}, 404, 'NOT_FOUND'],
    ];
    for (const [url, o, status, code] of cases) {
      const r = await call(url, { key: server.key, ...o });
      assert(r.status === status && r.body.error?.code === code && typeof r.body.error?.message === 'string' && Object.keys(r.body).length === 1 && Object.keys(r.body.error).length === 2, `${url}: ${r.status} ${show(r.body)}`);
      assert(cache(r) === 'no-store' && r.headers.get('content-type') === 'application/json; charset=utf-8' && r.headers.get('vary') === 'Origin', `${url}: the headers`);
    }
    assert(captured.filter((c) => c.context === 'location-lookup').length === 0, `a malformed coordinate reached the zone lookup: ${show(captured)}`);
    const sea = await call(`/api/v1/day?lat=${SEA.lat}&lon=${SEA.lon}`, { key: server.key });
    assert(sea.status === 400 && sea.body.error.code === 'NO_TIME_ZONE', `at sea: ${show(sea.body)}`);
    assert((await call(DAY_URL, { auth: `bearer ${server.key}` })).status === 200, 'a lower-case bearer');
  });

  await check('H2 an answer: 200, private, max-age=3600 with every date given, Vary: Origin and the rate headers; the golden Jerusalem Shabbat through the route; a defaulted date is today at the place and keeps it to the place\'s midnight; a far from with no to is clamped to 2099-12-31 (Review Focus 3)', async () => {
    resetApiWorld();
    setClock(T0);
    const { server } = await seedKeys();
    const r = await call('/api/v1/shabbat?city=jerusalem&from=2026-11-13&to=2026-11-14', { key: server.key });
    assert(r.status === 200 && cache(r) === 'private, max-age=3600' && r.headers.get('content-type') === 'application/json; charset=utf-8' && r.headers.get('vary') === 'Origin', `the headers: ${r.status} ${cache(r)}`);
    assert(r.headers.get('x-ratelimit-limit') === '300' && r.headers.get('x-ratelimit-remaining') === '299' && r.headers.get('x-ratelimit-reset') === String((T0 - 1000 + 60_000) / 1000), 'the rate headers');
    assertSame(r.body.blocks, GOLDEN_BLOCKS, 'the golden blocks');
    assertSame(r.body.place, { city: 'jerusalem', timeZone: 'Asia/Jerusalem', inIsrael: true, elevationM: 828 }, 'the place');
    setClock(Date.parse('2026-11-14T21:30:00Z'));
    const today = await call('/api/v1/day?city=jerusalem', { key: server.key });
    assert(today.body.date === '2026-11-14' && cache(today) === 'private, max-age=1800', `today in Jerusalem at 23:30: ${today.body.date} ${cache(today)}`);
    const week = await call('/api/v1/shabbat?city=jerusalem', { key: server.key });
    assert(week.body.from === '2026-11-14' && week.body.to === '2026-11-21' && cache(week) === 'private, max-age=1800', `this week: ${week.body.from} ${week.body.to} ${cache(week)}`);
    const fromOnly = await call('/api/v1/shabbat?city=jerusalem&from=2026-11-14', { key: server.key });
    assert(fromOnly.body.to === '2026-11-21' && cache(fromOnly) === 'private, max-age=3600', 'from given, to defaulted: nothing depends on today');
    setClock(Date.parse('2026-11-15T04:15:00Z'));
    const ny = await call(`/api/v1/day?lat=${NY.lat}&lon=${NY.lon}`, { key: server.key });
    assert(ny.body.date === '2026-11-14' && cache(ny) === 'private, max-age=2700', `today in New York at 23:15: ${ny.body.date} ${cache(ny)}`);
    setClock(T0);
    const far = await call('/api/v1/shabbat?city=jerusalem&from=2099-12-28', { key: server.key });
    assert(far.status === 200 && far.body.to === '2099-12-31', `a far from: ${far.status} ${show(far.body.to ?? far.body)}`);
    const behind = await call('/api/v1/shabbat?city=jerusalem&to=2026-11-01', { key: server.key });
    assert(behind.status === 400 && behind.body.error.code === 'INVALID_RANGE', 'a to before today');
  });

  await check('H3 no database once warm: after a restart the first request makes one Redis GET and no query; 50 more across both endpoints and both keys make no Redis command and no query; 5 minutes on, one request makes one Redis GET; with the mirror gone, one query and one SET, then none', async () => {
    resetApiWorld();
    setClock(T0);
    const { server, browser } = await seedKeys();
    forgetCopy();
    redisCalls.length = 0;
    prismaCalls.length = 0;
    assert((await call(DAY_URL, { key: server.key })).status === 200, 'the first request');
    assert(show(redisCalls) === show(['get']) && prismaCalls.length === 0, `the first request: ${show(redisCalls)} ${show(prismaCalls)}`);
    redisCalls.length = 0;
    for (let i = 0; i < 50; i++) {
      const key = i % 2 === 0 ? server.key : browser.key;
      const url = i % 3 === 0 ? `/api/v1/shabbat?city=haifa&from=2026-11-${String(10 + (i % 15)).padStart(2, '0')}` : `/api/v1/day?lat=${NY.lat}&lon=${NY.lon}&date=2026-11-14`;
      const r = await call(url, { key });
      assert(r.status === 200, `${url}: ${r.status} ${show(r.body)}`);
    }
    assert(redisCalls.length === 0 && prismaCalls.length === 0, `50 warm requests: ${show(redisCalls)} ${show(prismaCalls)}`);
    advanceClock(5 * 60_000);
    await call(DAY_URL, { key: server.key });
    await lookup.__pendingKeyRefreshForTests();
    await call(DAY_URL, { key: server.key });
    assert(show(redisCalls) === show(['get']) && prismaCalls.length === 0, `5 minutes on: ${show(redisCalls)} ${show(prismaCalls)}`);
    redisStore.delete(MIRROR);
    forgetCopy();
    redisCalls.length = 0;
    await call(DAY_URL, { key: server.key });
    assert(show(redisCalls) === show(['get', 'set']) && show(prismaCalls) === show(['apiKey.findMany']), `the mirror gone: ${show(redisCalls)} ${show(prismaCalls)}`);
    redisCalls.length = 0;
    prismaCalls.length = 0;
    await call(DAY_URL, { key: server.key });
    assert(redisCalls.length === 0 && prismaCalls.length === 0, 'then none');
  });

  await check('H4 a revoked key is refused on the next request in the same process, with the same code as an unknown one; logged as [api] 401 INVALID_KEY', async () => {
    resetApiWorld();
    setClock(T0);
    const { server, browser } = await seedKeys();
    assert((await call(DAY_URL, { key: server.key })).status === 200, 'before');
    await store.revokeApiKey(server.id, ADMIN);
    logs.length = 0;
    const after = await call(DAY_URL, { key: server.key });
    assert(after.status === 401 && after.body.error.code === 'INVALID_KEY' && logs.includes('[api] 401 INVALID_KEY'), `after: ${after.status} ${show(after.body)} ${show(logs)}`);
    assert((await call(DAY_URL, { key: browser.key })).status === 200, 'the other key');
  });

  await check('H5 the rate: 300 requests a minute per key; the 301st is 429 RATE_LIMITED with Retry-After to the minute\'s end and no-store; another key counts on its own; the next minute starts fresh', async () => {
    resetApiWorld();
    setClock(T0);
    const { server, browser } = await seedKeys();
    // A refusal after the rate step is the cheapest request that counts
    const fast = (key: string) => call('/api/v1/day?city=jerusalem&date=bad', { key });
    for (let i = 1; i <= 300; i++) {
      const r = await fast(server.key);
      if (r.status !== 400 || r.headers.get('x-ratelimit-remaining') !== String(300 - i)) throw new Error(`request ${i}: ${r.status} ${r.headers.get('x-ratelimit-remaining')}`);
    }
    const over = await fast(server.key);
    assert(over.status === 429 && over.body.error.code === 'RATE_LIMITED' && over.headers.get('retry-after') === '59' && over.headers.get('x-ratelimit-remaining') === '0' && cache(over) === 'no-store', `the 301st: ${over.status} ${over.headers.get('retry-after')} ${show(over.body)}`);
    assert((await fast(browser.key)).headers.get('x-ratelimit-remaining') === '299', 'another key counts on its own');
    advanceClock(60_000);
    const next = await fast(server.key);
    assert(next.status === 400 && next.headers.get('x-ratelimit-remaining') === '299', `the next minute: ${next.status} ${next.headers.get('x-ratelimit-remaining')}`);
  });

  await check('H6 CORS: a preflight from a listed origin gets Allow-Origin, GET, Authorization and 600 s, from another none; a browser key from its origin gets Allow-Origin and the exposed rate headers, from another origin 403 ORIGIN_NOT_ALLOWED; with no Origin (a server) it works without CORS headers; a server key never gets them; a refused key from a listed origin can be read; the origin typed with a capital and a slash matches the browser\'s (Review Focus 4)', async () => {
    resetApiWorld();
    setClock(T0);
    const { server, browser } = await seedKeys();
    const pre = await call('/api/v1/shabbat', { method: 'OPTIONS', origin: BROWSER_ORIGIN });
    assert(pre.status === 204 && pre.headers.get('access-control-allow-origin') === BROWSER_ORIGIN && pre.headers.get('access-control-allow-methods') === 'GET' && pre.headers.get('access-control-allow-headers') === 'Authorization' && pre.headers.get('access-control-max-age') === '600', `the preflight: ${pre.status} ${show([...pre.headers.entries()])}`);
    const preOther = await call('/api/v1/day', { method: 'OPTIONS', origin: OTHER_ORIGIN });
    assert(preOther.status === 204 && preOther.headers.get('access-control-allow-origin') === null, 'another origin\'s preflight');
    const ok = await call(DAY_URL, { key: browser.key, origin: BROWSER_ORIGIN });
    assert(ok.status === 200 && ok.headers.get('access-control-allow-origin') === BROWSER_ORIGIN && ok.headers.get('vary') === 'Origin' && /X-RateLimit-Remaining/.test(ok.headers.get('access-control-expose-headers') ?? ''), `from its origin: ${ok.status} ${show([...ok.headers.entries()])}`);
    const other = await call(DAY_URL, { key: browser.key, origin: OTHER_ORIGIN });
    assert(other.status === 403 && other.body.error.code === 'ORIGIN_NOT_ALLOWED' && other.headers.get('access-control-allow-origin') === null, `from another origin: ${other.status} ${show(other.body)}`);
    const fromServer = await call(DAY_URL, { key: browser.key });
    assert(fromServer.status === 200 && fromServer.headers.get('access-control-allow-origin') === null, 'a browser key from a server');
    const serverKey = await call(DAY_URL, { key: server.key, origin: BROWSER_ORIGIN });
    assert(serverKey.status === 200 && serverKey.headers.get('access-control-allow-origin') === null, 'a server key gets no CORS headers');
    const missing = await call(DAY_URL, { key: null, origin: BROWSER_ORIGIN });
    assert(missing.status === 401 && missing.headers.get('access-control-allow-origin') === BROWSER_ORIGIN, 'a refused key from a listed origin');
  });

  await check('H7 failures: a thrown error is 500 INTERNAL, reported by its kind with the endpoint and the key id; no copy, no Redis and no table is 503 KEYS_UNAVAILABLE with Retry-After: 60, reported; the table back, the next request works', async () => {
    resetApiWorld();
    setClock(T0);
    const { server } = await seedKeys();
    captured.length = 0;
    // An Invalid Date clock makes the default "today" throw a RangeError inside the answer
    setClock(Number.NaN);
    const boom = await call('/api/v1/day?city=jerusalem', { key: server.key });
    setClock(T0);
    assert(boom.status === 500 && boom.body.error.code === 'INTERNAL' && cache(boom) === 'no-store', `${boom.status} ${show(boom.body)}`);
    const reported = captured.find((c) => c.context === 'api-v1');
    assert(reported && /^api-v1 day failed: RangeError/.test(reported.message) && reported.extra.endpoint === 'day' && reported.extra.key_id === server.id, `the report: ${show(captured)}`);
    resetApiWorld();
    setClock(T0);
    const again = await seedKeys();
    forgetCopy();
    redisFails.add('get');
    prismaFails.add('apiKey.findMany');
    captured.length = 0;
    const down = await call(DAY_URL, { key: again.server.key });
    assert(down.status === 503 && down.body.error.code === 'KEYS_UNAVAILABLE' && down.headers.get('retry-after') === '60' && cache(down) === 'no-store', `${down.status} ${show(down.body)}`);
    assert(captured.some((c) => c.context === 'api-keys'), 'reported');
    prismaFails.clear();
    assert((await call(DAY_URL, { key: again.server.key })).status === 200, 'the table back');
  });

  await check('H8 one log line per request: [api] key <id> <endpoint> <status> [<code>] <ms> ms, and [api] 401 <code> for a refused key; nothing else', async () => {
    resetApiWorld();
    setClock(T0);
    const { server } = await seedKeys();
    logs.length = 0;
    await call(DAY_URL, { key: server.key });
    await call('/api/v1/day?city=jerusalem&lang=fr', { key: server.key });
    await call(DAY_URL, { key: `fcj_${'C'.repeat(43)}` });
    await call(DAY_URL, { key: null });
    const lines = logs.filter((l) => l.startsWith('[api]'));
    assert(lines.length === 4 && new RegExp(`^\\[api\\] key ${server.id} day 200 \\d+ ms$`).test(lines[0]) && new RegExp(`^\\[api\\] key ${server.id} day 400 INVALID_LANG \\d+ ms$`).test(lines[1]) && lines[2] === '[api] 401 INVALID_KEY' && lines[3] === '[api] 401 MISSING_KEY', show(lines));
  });

  await check('H9 the proxy\'s matcher leaves /api/v1/* alone (no city-page limit, no next-intl), and still matches a city page', () => {
    const source = fs.readFileSync(path.join(ROOT, 'proxy.ts'), 'utf8');
    const literal = /matcher:\s*\['([^']+)'/.exec(source)?.[1];
    assert(literal, 'no matcher in proxy.ts');
    const pattern = new RegExp(`^${JSON.parse(`"${literal}"`)}$`);
    assert(!pattern.test('/api/v1/shabbat') && !pattern.test('/api/v1/day') && pattern.test('/zmanim/jerusalem'), `the matcher ${literal}`);
  });

  await check('H10 the reference lists every city slug of src/site/cities.ts, in its order, between its markers', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs/api/jewish-times-v1.md'), 'utf8');
    const block = /<!-- cities:start -->\n([\s\S]*?)\n<!-- cities:end -->/.exec(doc)?.[1] ?? '';
    const want = CITIES.map((c: Row) => `- \`${c.slug}\` (${c.country}, ${c.timeZone})`).join('\n');
    assert(block === want, `the city list differs from src/site/cities.ts; between the markers it should read:\n${want}`);
  });

  await check('Z1 no console line or Sentry field of the whole run holds a coordinate, a city slug or name, a key, its hash or prefix, an app name or an origin', () => {
    const zones = /\b[A-Z][A-Za-z_]+\/[A-Za-z_/+-]+/g;
    const text = [...everyLog, ...everyCapture.map((c) => `${c.message} ${show(c.extra)}`)].join('\n').replace(zones, '<zone>');
    const leaks = [...PLACES, ...KEYS].filter((s) => text.includes(s));
    assert(leaks.length === 0, `leaked: ${show(leaks.map((s) => (s.length > 12 ? `${s.slice(0, 6)}…` : s)))}`);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `RUN smoke-api-v1`
Expected: exit 1 in every zone: the load of `app/api/v1/shabbat/route.ts` throws (`Cannot find module`).

- [ ] **Step 3: `src/lib/api-v1/rate.ts`**

```ts
// The Jewish times API's rate limit (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.6, open point B): 300
// requests a minute per key, in fixed one-minute windows, in this process's memory (the pattern of src/lib/page-limit.ts).
//
// - No Redis: Railway runs one process, and Upstash would cost a command per request. A restart starts the counts over,
//   which is fine for the owner's own apps.
// - On globalThis (Next 16 gives the routes separate module instances). The first counted request of a window schedules
//   one cleanup timer for the window's end (unref'd, so it never holds the process open); a request that rolls the window
//   over takes the old timer back.
// - A key that went over is logged once per minute, as a count, by its id.
// Pure: no import.

export const API_RATE_LIMIT = 300;
export const API_RATE_WINDOW_MS = 60 * 1000;

type RateState = { window: number; counts: Map<number, number>; refused: Map<number, number>; timer: unknown };

export type RateVerdict = {
  ok: boolean;
  limit: number;
  remaining: number;
  /** The window's end, epoch seconds (X-RateLimit-Reset). */
  resetS: number;
  /** Seconds to the window's end, at least 1 (Retry-After). */
  retryAfterS: number;
};

/** The process's counts, read on each call (a smoke starts them over by deleting globalThis.__apiV1Rate). */
function sharedState(): RateState {
  const g = globalThis as { __apiV1Rate?: RateState };
  return (g.__apiV1Rate ??= { window: -1, counts: new Map(), refused: new Map(), timer: null });
}

function rollOver(state: RateState, next: number): void {
  for (const [id, n] of state.refused) {
    console.warn(`[api] key ${id}: ${n} requests over the limit in the minute from ${new Date(state.window * API_RATE_WINDOW_MS).toISOString()}`);
  }
  if (state.timer != null) clearTimeout(state.timer as Parameters<typeof clearTimeout>[0]);
  state.timer = null;
  state.window = next;
  state.counts.clear();
  state.refused.clear();
}

function scheduleCleanup(state: RateState, window: number, now: number): void {
  const timer = setTimeout(() => {
    state.timer = null;
    if (state.window === window) rollOver(state, -1);
  }, (window + 1) * API_RATE_WINDOW_MS - now);
  // A cleanup timer, not a call timeout: it must never keep the process from exiting
  (timer as { unref?: () => unknown }).unref?.();
  state.timer = timer;
}

/** Counts one request of `keyId` at `now` (epoch ms) and says whether it may go on. */
export function countRequest(keyId: number, now: number): RateVerdict {
  const state = sharedState();
  const window = Math.floor(now / API_RATE_WINDOW_MS);
  if (window !== state.window) rollOver(state, window);
  const count = (state.counts.get(keyId) ?? 0) + 1;
  state.counts.set(keyId, count);
  if (state.timer == null) scheduleCleanup(state, window, now);
  const end = (window + 1) * API_RATE_WINDOW_MS;
  const base = { limit: API_RATE_LIMIT, resetS: Math.ceil(end / 1000), retryAfterS: Math.max(1, Math.ceil((end - now) / 1000)) };
  if (count <= API_RATE_LIMIT) return { ok: true, remaining: API_RATE_LIMIT - count, ...base };
  state.refused.set(keyId, (state.refused.get(keyId) ?? 0) + 1);
  return { ok: false, remaining: 0, ...base };
}

export function rateHeaders(verdict: RateVerdict): Record<string, string> {
  return { 'X-RateLimit-Limit': String(verdict.limit), 'X-RateLimit-Remaining': String(verdict.remaining), 'X-RateLimit-Reset': String(verdict.resetS) };
}
```

- [ ] **Step 4: `src/lib/api-v1/handle.ts`**

```ts
// Every request to /api/v1/* (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.6; reference
// docs/api/jewish-times-v1.md), in this order: the key (Authorization: Bearer fcj_…), the origin a key is locked to, the
// key's rate, the parameters, the place, the answer.
//
// - The key comes from the process's copy (findApiKey): no database query and no Redis command in the steady state.
// - CORS: an answer to a key carries Access-Control-Allow-Origin only for an origin that key lists (a key with none is a
//   server key and gets none); a refused key, and the browser's preflight (which carries no key), answer by whether any
//   active key lists the origin, so a listed website can read why it was refused.
// - "Today" is the place's own day (localDate over instantToWallTime), and an answer that depends on it is kept at most to
//   the place's next midnight.
// - One log line per request: `[api] key <id> <endpoint> <status> [<code>] <ms> ms`, or `[api] 401 <code>` for a refused
//   key. No query, place, origin or key reaches a log; a thrown error reaches Sentry by its kind only (reportable).

import { KeysUnavailable, anyKeyListsOrigin, findApiKey, type FoundKey } from '../../services/api-keys/lookup';
import { dayView, shabbatView } from '../../services/zmanim/api-view';
import { defaultCommunityIn } from '../../site/zmanim/city-view';
import { addDaysToDate, localDate, startOfLocalDay } from '../../utils/day-events';
import { captureError } from '../error-capture';
import { creditsFor } from './credits';
import { DEFAULT_SPAN_DAYS, LAST_DAY, checkRange, readDayParams, readShabbatParams, type Endpoint } from './params';
import { resolveApiPlace } from './place';
import { countRequest, rateHeaders } from './rate';
import { ApiError, HOUR_S, corsHeaders, errorResponse, okResponse, reportable, type ApiErrorCode } from './respond';

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** How long an answer may be kept: an hour, or to the place's next midnight when it is about "today". */
function maxAgeFor(aboutToday: boolean, today: string, zone: string, now: number): number {
  if (!aboutToday) return HOUR_S;
  const midnight = startOfLocalDay(addDaysToDate(today, 1), zone).getTime();
  return Math.max(1, Math.min(HOUR_S, Math.ceil((midnight - now) / 1000)));
}

async function answer(endpoint: Endpoint, search: URLSearchParams, now: number): Promise<{ body: unknown; maxAgeS: number }> {
  if (endpoint === 'shabbat') {
    const params = readShabbatParams(search);
    const place = resolveApiPlace(params.place);
    const zone = place.place.timeZone;
    const today = localDate(new Date(now), zone);
    const from = params.from ?? today;
    const spanEnd = addDaysToDate(from, DEFAULT_SPAN_DAYS);
    const to = params.to ?? (spanEnd > LAST_DAY ? LAST_DAY : spanEnd);
    if (params.from === null || params.to === null) checkRange(from, to);
    const community = params.community ?? defaultCommunityIn(zone);
    const body = await shabbatView({ place, community, lang: params.lang, from, to, credits: creditsFor(place) });
    return { body, maxAgeS: maxAgeFor(params.from === null, today, zone, now) };
  }
  const params = readDayParams(search);
  const place = resolveApiPlace(params.place);
  const zone = place.place.timeZone;
  const today = localDate(new Date(now), zone);
  const community = params.community ?? defaultCommunityIn(zone);
  const body = await dayView({ place, community, lang: params.lang, date: params.date ?? today, credits: creditsFor(place) });
  return { body, maxAgeS: maxAgeFor(params.date === null, today, zone, now) };
}

/** The CORS headers for a request that carries no usable key: the origin's, when some active key lists it. */
async function corsForAnyKey(origin: string | null, now: number): Promise<Record<string, string>> {
  if (origin === null) return {};
  try {
    return (await anyKeyListsOrigin(origin, now)) ? corsHeaders(origin) : {};
  } catch (error) {
    console.warn(`[api] no CORS answer: the key list is unavailable (${error instanceof Error ? error.name : typeof error})`);
    return {};
  }
}

async function refusedKey(code: ApiErrorCode, message: string, origin: string | null, now: number): Promise<Response> {
  console.warn(`[api] 401 ${code}`);
  return errorResponse(code, message, await corsForAnyKey(origin, now));
}

export async function handleApiV1(request: Request, endpoint: Endpoint): Promise<Response> {
  const started = performance.now();
  const now = Date.now();
  const origin = request.headers.get('origin');
  const raw = BEARER.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
  if (raw === null) return refusedKey('MISSING_KEY', 'send the key as Authorization: Bearer <key>', origin, now);

  let found: FoundKey | null;
  try {
    found = await findApiKey(raw, now);
  } catch (error) {
    if (!(error instanceof KeysUnavailable)) captureError(reportable(error, 'api-v1 key lookup failed'), 'api-v1', { endpoint });
    console.error(`[api] 503 KEYS_UNAVAILABLE ${endpoint}`);
    return errorResponse('KEYS_UNAVAILABLE', 'the API cannot check keys right now; try again in a minute', { 'Retry-After': '60' });
  }
  if (!found) return refusedKey('INVALID_KEY', 'the key is not the key of an active app', origin, now);
  const key: FoundKey = found;

  const done = (res: Response, code?: ApiErrorCode): Response => {
    console.log(`[api] key ${key.id} ${endpoint} ${res.status}${code ? ` ${code}` : ''} ${Math.round(performance.now() - started)} ms`);
    return res;
  };
  const cors = origin !== null && key.origins.includes(origin) ? corsHeaders(origin) : {};
  if (origin !== null && key.origins.length > 0 && !key.origins.includes(origin)) {
    return done(errorResponse('ORIGIN_NOT_ALLOWED', 'this key may not be used from this website', cors), 'ORIGIN_NOT_ALLOWED');
  }

  const rate = countRequest(key.id, now);
  const headers = { ...cors, ...rateHeaders(rate) };
  if (!rate.ok) {
    return done(errorResponse('RATE_LIMITED', `at most ${rate.limit} requests a minute per key`, { ...headers, 'Retry-After': String(rate.retryAfterS) }), 'RATE_LIMITED');
  }

  try {
    const { body, maxAgeS } = await answer(endpoint, new URL(request.url).searchParams, now);
    return done(okResponse(body, maxAgeS, headers));
  } catch (error) {
    if (error instanceof ApiError) return done(errorResponse(error.code, error.message, headers), error.code);
    captureError(reportable(error, `api-v1 ${endpoint} failed`), 'api-v1', { endpoint, key_id: key.id });
    return done(errorResponse('INTERNAL', 'something went wrong on our side', headers), 'INTERNAL');
  }
}

/** The browser's preflight: it carries no key, so it is allowed for an origin some active key lists, and refused otherwise. */
export async function preflight(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  const cors = await corsForAnyKey(origin, Date.now());
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (cors['Access-Control-Allow-Origin']) {
    Object.assign(headers, cors, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Max-Age': '600' });
  }
  return new Response(null, { status: 204, headers });
}

/** Any other path under /api/v1/. */
export function notFound(): Response {
  console.warn('[api] 404 NOT_FOUND');
  return errorResponse('NOT_FOUND', 'no such endpoint: /api/v1/shabbat and /api/v1/day are the ones there are');
}
```

- [ ] **Step 5: The three routes**

`app/api/v1/shabbat/route.ts`:

```ts
/**
 * GET /api/v1/shabbat: the Shabbat and Yom Tov blocks of a range of days at a place, for the owner's other apps (spec
 * docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.1 a; reference docs/api/jewish-times-v1.md). The key, the
 * origin, the rate, the parameters and the answer are all handleApiV1's.
 */

import { handleApiV1, preflight } from '@/src/lib/api-v1/handle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return handleApiV1(request, 'shabbat');
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request);
}
```

`app/api/v1/day/route.ts`:

```ts
/**
 * GET /api/v1/day: one day's zmanim, halachic hours, holidays and Hebrew date at a place, for the owner's other apps (spec
 * docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.1 b; reference docs/api/jewish-times-v1.md). Everything is
 * handleApiV1's.
 */

import { handleApiV1, preflight } from '@/src/lib/api-v1/handle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return handleApiV1(request, 'day');
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request);
}
```

`app/api/v1/[...rest]/route.ts`:

```ts
/**
 * Any other path under /api/v1/: 404 NOT_FOUND in the API's own error shape (spec
 * docs/superpowers/specs/2026-11-07-zmanim-api-design.md §3.7). /api/v1/shabbat and /api/v1/day are their own routes.
 */

import { notFound, preflight } from '@/src/lib/api-v1/handle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): Response {
  return notFound();
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request);
}
```

- [ ] **Step 6: Run part B**

Run: `RUN smoke-api-v1`
Expected: `20/20 passed` in each zone except H10 (the reference does not exist yet): `19/20`, H10 failing with "the city list differs". Every other check passes.

- [ ] **Step 7: Sentry: the API's place leaves URLs and queries**

In `src/lib/sentry-scrub.ts`:

7a. Insert after the `const SECRET_PARAM = …;` line:

```ts
/**
 * The Jewish times API's place (spec 2026-11-07-zmanim-api §3.6): /api/v1/*?city=…&lat=…&lon=… names a place, and no
 * Sentry field holds one. Its own rule beside the secret query values: URLs and queries, as SECRET_PARAM.
 */
const PLACE_PARAM_NAMES = ['lat', 'lon', 'city'];
const PLACE_PARAM = /(^|[?&])(lat|lon|city)=[^&#]*/gi;
```

7b. In `scrubSecrets`, insert after the line `    .replace(SECRET_PARAM, `$1$2=${SCRUBBED}`)`:

```ts
    .replace(PLACE_PARAM, `$1$2=${SCRUBBED}`)
```

7c. Change the second line of `isSecretParam` (the one existing line this task changes) from

```ts
  name === 'initData' || (typeof name === 'string' && SECRET_PARAM_NAMES.includes(name.toLowerCase()));
```

to

```ts
  name === 'initData' || (typeof name === 'string' && (SECRET_PARAM_NAMES.includes(name.toLowerCase()) || PLACE_PARAM_NAMES.includes(name.toLowerCase())));
```

7d. In the file's header comment, insert before ` * No imports:`:

```ts
 * The Jewish times API's place (spec 2026-11-07-zmanim-api §3.6): the lat, lon and city query values leave URLs and
 * queries, so an error event of /api/v1/* holds no place.
 *
```

7e. In `scripts/smoke-sentry-scrub.ts`, insert before the final `  let failed = 0;` of `main()`:

```ts
  await check('#16 the Jewish times API\'s place: lat, lon and city scrubbed from url, query_string (string, object any case, pairs), the nextjs request path, breadcrumbs and the transaction name; names that only contain them (flat, citycode) and the rest kept', () => {
    const query = 'city=jerusalem&from=2026-11-13&lat=31.7690&lon=35.2163&flat=1&citycode=7&lang=he';
    const want = 'city=[scrubbed]&from=2026-11-13&lat=[scrubbed]&lon=[scrubbed]&flat=1&citycode=7&lang=he';
    const out = scrub.scrubServerEvent({ request: { url: `https://famcal.bot/api/v1/shabbat?${query}`, query_string: query }, contexts: { nextjs: { request_path: `/api/v1/shabbat?${query}` } } });
    assert(out.request.url === `https://famcal.bot/api/v1/shabbat?${want}`, `url ${out.request.url}`);
    assert(out.request.query_string === want, `query_string ${out.request.query_string}`);
    assert(out.contexts.nextjs.request_path === `/api/v1/shabbat?${want}`, `request_path ${out.contexts.nextjs.request_path}`);
    const obj = scrub.scrubServerEvent({ request: { query_string: { City: 'haifa', lat: '32.8', lon: '35', lang: 'en' } } }).request.query_string;
    assert(show(obj) === show({ City: '[scrubbed]', lat: '[scrubbed]', lon: '[scrubbed]', lang: 'en' }), `object ${show(obj)}`);
    const pairs = scrub.scrubServerEvent({ request: { query_string: [['lat', '40.7128'], ['date', '2026-11-14']] } }).request.query_string;
    assert(show(pairs) === show([['lat', '[scrubbed]'], ['date', '2026-11-14']]), `pairs ${show(pairs)}`);
    const crumb = scrub.scrubServerBreadcrumb({ category: 'http', message: `GET /api/v1/day?${query}`, data: { url: `/api/v1/day?${query}` } });
    const tx = scrub.scrubServerTransaction({ type: 'transaction', transaction: `GET /api/v1/day?${query}` });
    for (const [label, value] of [['breadcrumb', crumb], ['transaction', tx]] as [string, Row][]) {
      assert(!/31\.769|35\.2163|jerusalem/.test(show(value)), `${label} still has the place: ${show(value)}`);
    }
    assert(scrub.scrubUrl(scrub.scrubUrl(`/api/v1/day?${query}`)) === scrub.scrubUrl(`/api/v1/day?${query}`), 'a second scrub changes the URL');
  });
```

Run: `RUN smoke-sentry-scrub`. Expected: every check passes, #16 included. Prove it bites: remove the `.replace(PLACE_PARAM, …)` line, see #16 fail, restore.

- [ ] **Step 8: The reference `docs/api/jewish-times-v1.md`**

Write the file below. Then fill the city list between the markers with the output of:

```bash
npx tsx -e "import { CITIES } from './src/site/cities'; console.log(CITIES.map((c) => '- \`' + c.slug + '\` (' + c.country + ', ' + c.timeZone + ')').join('\n'))"
```

(H10 prints the same list on failure.)

````markdown
# FamCal Jewish times API, v1

FamCal's Shabbat, Yom Tov and zmanim times as JSON, for the owner's own apps. The times are the ones FamCal's bot, Mini App and public zmanim pages show: the same engine, the same rules.

Base URL: `https://famcal.bot/api/v1/`

## Authentication

Every request is a `GET` with the app's key:

```
Authorization: Bearer fcj_…
```

Each app has its own key, made in FamCal's admin panel (API keys, New key). The key is shown once: keep it in the app's own secret store (an environment variable such as `FAMCAL_API_KEY`). A revoked key stops working at once; to restore access, a new key is made.

A key may be locked to the web origins of an app that calls from a browser (`https://shabbat.example.com`). A browser on any other website is then refused. The lock only stops other websites from using the key in a browser: anyone who reads the key out of a browser app can call the API from a server with it.

## The place and the shared parameters

| Parameter | Meaning |
|---|---|
| `city` | A slug of the city list below (`jerusalem`, `new-york`, …), lower case. Exactly one of `city` or `lat` and `lon`. |
| `lat`, `lon` | Decimal degrees with a dot (`31.7683`, `-74.006`), rounded to 4 places on arrival (about 11 m). |
| `community` | `sephardi`, `ashkenazi` or `chabad`. Default: Sephardi where the place's time zone is Israel's, Ashkenazi elsewhere. |
| `lang` | `en` (default), `he` or `ru`: the names of the zmanim, the holidays, the parasha and the Hebrew date. |

Any other parameter, a repeated one, or a malformed one is a 400, so a typo shows at once.

- A city has its stored position, height and time zone. Every Israeli city is `Asia/Jerusalem`.
- Coordinates get their time zone from a map of the world's zones. A point at sea has none: 400 `NO_TIME_ZONE`. In Israel's zone the height counted is the height of the ground at that exact point; for the height of a whole town (the highest point in it), pass the city.
- A point in the zones `Asia/Hebron` or `Asia/Gaza` counts as abroad (two days of Yom Tov, the Ashkenazi default).
- Candle lighting is 20 minutes before sunset everywhere.

## GET /shabbat

The Shabbat and Yom Tov blocks of a range of days. A block is one run of rest days: a Shabbat, a Yom Tov, or several in a row (Rosh Hashana, Yom Tov into Shabbat).

| Parameter | Meaning |
|---|---|
| `from` | A civil day at the place, `yyyy-MM-dd`. Default: today at the place. |
| `to` | A civil day at the place, included. Default: `from` plus 7 days. At most 366 days after `from`. |

The answer lists every block whose eve (the day whose sunset begins it) is from `from` to `to`, plus a block already under way on `from`.

`GET /api/v1/shabbat?city=jerusalem&from=2026-11-13&to=2026-11-14`

```json
{
  "place": { "city": "jerusalem", "timeZone": "Asia/Jerusalem", "inIsrael": true, "elevationM": 828 },
  "community": "sephardi",
  "lang": "en",
  "from": "2026-11-13",
  "to": "2026-11-14",
  "blocks": [
    {
      "eve": "2026-11-13",
      "last": "2026-11-14",
      "candleLighting": { "at": "2026-11-13T16:25:00+02:00", "local": "16:25" },
      "start": { "at": "2026-11-13T16:45:00+02:00", "local": "16:45" },
      "end": { "key": "SHABBAT_ENDS", "name": "Shabbat ends", "at": "2026-11-14T17:16:00+02:00", "local": "17:16" },
      "parasha": { "title": "Parashat Toldot", "brief": "Toldot" },
      "holidays": [],
      "days": [
        { "date": "2026-11-13", "rows": [{ "key": "CANDLE_LIGHTING", "opinion": null, "name": "Candle lighting", "at": "2026-11-13T16:25:00+02:00", "local": "16:25" }] },
        { "date": "2026-11-14", "rows": [{ "key": "SHABBAT_ENDS", "opinion": null, "name": "Shabbat ends", "at": "2026-11-14T17:16:00+02:00", "local": "17:16" }] }
      ]
    }
  ],
  "credits": [
    { "source": "copernicus-dem", "text": "Produced using Copernicus WorldDEM™-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM™-90." },
    { "source": "geonames", "text": "City positions: GeoNames, under CC BY 4.0.", "url": "https://www.geonames.org/" }
  ]
}
```

| Field | Meaning |
|---|---|
| `eve`, `last` | The day whose sunset begins the block, and its last rest day. |
| `candleLighting` | The eve's candle lighting: 20 minutes before sunset. |
| `start` | Sunset on the eve: the block begins. |
| `end` | The last day's end row: `SHABBAT_ENDS`, `YOM_TOV_ENDS` or `SHABBAT_YOM_TOV_ENDS` (a Saturday that is also a Yom Tov), with its name. |
| `parasha` | The block's weekly portion (`title`, `brief`), or `null`. |
| `holidays` | Its Yom Tov days' names, or, with none, its chol hamoed or special Shabbat: `{ title, brief, kind, chag }`. |
| `days` | Each day from the eve to the last day with its candle lighting and end rows. On the first night of a two-day Yom Tov the second night's candles are `CANDLE_LIGHTING_NOT_BEFORE` ("Candle lighting after"): not before that day's own end. |

## GET /day

One day's zmanim, halachic hours, holidays and Hebrew date.

| Parameter | Meaning |
|---|---|
| `date` | A civil day at the place, `yyyy-MM-dd`. Default: today at the place. |

`GET /api/v1/day?lat=40.7128&lon=-74.0060&date=2026-11-14&lang=he`

```json
{
  "place": { "latitude": 40.7128, "longitude": -74.006, "timeZone": "America/New_York", "inIsrael": false, "elevationM": null },
  "community": "ashkenazi",
  "lang": "he",
  "date": "2026-11-14",
  "hebrewDate": { "text": "ד׳ בכסלו תשפ״ז", "gematriya": "ד׳ בכסלו תשפ״ז", "day": 4, "month": "Kislev", "year": 5787 },
  "holidays": [{ "title": "פרשת תולדות", "brief": "תולדות", "kind": "parasha", "chag": false }],
  "rows": [
    { "key": "ALOT", "opinion": null, "name": "עלות השחר", "at": "2026-11-14T05:17:00-05:00", "local": "05:17" },
    { "key": "SOF_SHMA_MGA", "opinion": "mga", "name": "סוף זמן קריאת שמע (מג״א)", "at": "2026-11-14T08:28:00-05:00", "local": "08:28" },
    { "key": "SHABBAT_ENDS", "opinion": null, "name": "צאת השבת", "at": "2026-11-14T17:22:00-05:00", "local": "17:22" }
  ],
  "hours": [{ "opinion": "gra", "name": "גר״א", "ms": 2985250, "text": "49:45" }, { "opinion": "mga", "name": "מג״א", "ms": 3830083, "text": "63:50" }],
  "credits": [{ "source": "openstreetmap", "text": "Time zone map © OpenStreetMap contributors, under ODbL.", "url": "https://www.openstreetmap.org/copyright" }]
}
```

(Three of the day's fourteen rows are shown.)

| Field | Meaning |
|---|---|
| `rows` | The community's zmanim in the order of the day, with the day's candle lighting and end rows among them. `key` is stable (`ALOT`, `NETZ`, `SOF_SHMA_GRA`, `CHATZOT`, `SHKIA`, `TZEIT`, …); `opinion` names the opinion a zman is counted by (`gra`, `mga`, `halachaBerura`, `yalkutYosef`, `baalHatanya`) or is `null`; `name` is in `lang`. |
| `hours` | The halachic hour under each opinion the community counts the day by: `ms` and `text` (minutes:seconds), `null` where the day has no sunrise or sunset. |
| `hebrewDate` | The Hebrew date of the civil day's daytime. `text` is in `lang` (the day and year in letters in Hebrew); `gematriya` is always the Hebrew text; `month` is the English month name, for a program to read. |
| `holidays` | The day's holidays, fasts, Rosh Chodesh and the weekly portion: `{ title, brief, kind, chag }`, `kind` one of `chag`, `fast`, `erev`, `cholHamoed`, `minor`, `modern`, `roshChodesh`, `parasha`, `specialShabbat`. |

## Times

Every time has two forms:

- `at`: the instant, as ISO 8601 with the place's offset at that instant (`2026-11-13T16:25:00+02:00`).
- `local`: the place's own clock, `hh:mm` in 24 hours.

Where the sun makes no such time that day (the far north in summer), both are `null`; the row, and a block, are still there.

## Errors

Every error has one shape:

```json
{ "error": { "code": "INVALID_DATE", "message": "date must be a real day, yyyy-MM-dd" } }
```

The `message` is for the developer, in English; a program reads `code`.

| Status | Codes |
|---|---|
| 400 | `INVALID_PLACE` (neither or both of city and coordinates, or only one of lat and lon), `UNKNOWN_CITY`, `INVALID_COORDINATES`, `NO_TIME_ZONE`, `INVALID_DATE`, `INVALID_RANGE` (`to` before `from`, or more than 366 days after it), `OUT_OF_RANGE` (outside 2000-01-01 to 2099-12-31), `INVALID_COMMUNITY`, `INVALID_LANG`, `UNKNOWN_PARAMETER` (an unknown or repeated parameter) |
| 401 | `MISSING_KEY`, `INVALID_KEY` (unknown or revoked: the same code for both) |
| 403 | `ORIGIN_NOT_ALLOWED` |
| 404 | `NOT_FOUND` (any other path under `/api/v1/`) |
| 429 | `RATE_LIMITED` (with `Retry-After`) |
| 500 | `INTERNAL` |
| 503 | `KEYS_UNAVAILABLE` (with `Retry-After: 60`) |

## Limits

- 300 requests a minute per key, in fixed one-minute windows. Every answer to a known key carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (the window's end, in Unix seconds). Over the limit: 429 with `Retry-After` in seconds.
- Dates from 2000-01-01 to 2099-12-31. A `/shabbat` range is at most 366 days; a default `to` stops at 2099-12-31.

## Caching

The same inputs always give the same answer. A 200 is `Cache-Control: private, max-age=3600`; when a date was left to its default ("today"), `max-age` runs at most to the place's next midnight. Every error is `no-store`. Cache on your side by the full URL.

## Browsers (CORS)

For a key locked to origins, a browser on one of them may call the API: the preflight is answered for it, and each answer carries `Access-Control-Allow-Origin` and exposes the rate headers. A key with no origins is a server key and gets no CORS headers. A call with no `Origin` header (from a server) is allowed with either kind of key.

## Credits

Show the `credits` of an answer wherever you show its times, as FamCal's zmanim pages do:

- `copernicus-dem`: wherever an answer gives a height (`elevationM`): the heights are derived from the Copernicus DEM.
- `geonames`: for a city: its position and time zone come from GeoNames.
- `openstreetmap`: for coordinates: their time zone comes from a map built from OpenStreetMap.

Licence texts are given in English and are not translated.

## Versioning

`/api/v1/` keeps its fields and their meaning. New fields and new endpoints are added to v1: ignore the fields you do not know. A rename, a removal or a change of meaning comes as `/api/v2/`, served beside v1 until the apps have moved.

## City slugs

<!-- cities:start -->
<!-- cities:end -->
````

After filling, the file has the generated lines between the two markers and no blank line inside them.

- [ ] **Step 9: README and CLAUDE.md**

`README.md`: insert before the line `### Install & run`:

```markdown
### Jewish times API

FamCal's Shabbat, Yom Tov and zmanim times as JSON for the owner's other apps: `GET /api/v1/shabbat` (the Shabbat and Yom Tov blocks of a range of days) and `GET /api/v1/day` (one day's zmanim, holidays and Hebrew date), at a city of the zmanim pages' list or at coordinates, Sephardi, Ashkenazi or Chabad, with names in en, he or ru. The reference handed to another app is `docs/api/jewish-times-v1.md`; the design is `docs/superpowers/specs/2026-11-07-zmanim-api-design.md`.

- **Keys:** admin panel → **API keys** → **New key**: the app's name and, for an app that calls from a browser, its web origins. The key (`fcj_…`) is shown once, to paste into the other app's own secret store. **Revoke** stops that app at once. Only the key's SHA-256 is stored (the `ApiKey` table); nothing is set on Railway.
- **Cost:** a request reads the keys from the process's memory and counts its rate (300 a minute per key) in memory, so it makes no database query and no Redis command; one Redis read every 5 minutes while requests come keeps the copy fresh.
- **Privacy:** no log line or Sentry field holds a key, an origin, a place name or coordinates.

```

`CLAUDE.md`: insert after the bullet that begins `- The bot turns what the model said about a zman into a reminder's rule only through \`readZmanFromModel\``:

```markdown
- The Jewish times API (`/api/v1/*`; spec `docs/superpowers/specs/2026-11-07-zmanim-api-design.md`, reference `docs/api/jewish-times-v1.md`) answers only from `zmanDayForPlace` (the request's own memo, `quiet: true`) and `restBlocksBetween` (`src/services/zmanim/rest-blocks-view.ts`, which the city pages' "ahead" section calls too), shaped by `src/services/zmanim/api-view.ts`, and every request goes through `handleApiV1` (`src/lib/api-v1/handle.ts`). A key is read only through `findApiKey` (`src/services/api-keys/lookup.ts`: the process's copy on `globalThis`, Redis's list `api:keys:v1` at most once in 5 minutes, the table only when that list is missing) and written only in `src/services/api-keys/store.ts` (`scripts/smoke-api-keys.ts` fences the table); only a key's SHA-256 and its prefix are stored. A request makes no database query and no Redis command in the steady state (the rate limit is in memory, `src/lib/api-v1/rate.ts`), and no console line or Sentry field holds a key, its hash, an origin, a place name or coordinates (`lat`, `lon` and `city` are scrubbed from Sentry's URLs; `scripts/smoke-api-v1.ts` checks the run's logs).
```

- [ ] **Step 10: Run everything this task touches**

```
RUN smoke-api-v1
RUN smoke-api-keys
RUN smoke-sentry-scrub
RUN smoke-sentry-envelopes
RUN smoke-secret-hygiene
RUN smoke-no-open-meteo
RUN smoke-dst
RUN smoke-pause
npx tsc --noEmit -p .
npx eslint src/lib/api-v1 app/api/v1 src/lib/sentry-scrub.ts scripts/smoke-api-v1.ts scripts/smoke-sentry-scrub.ts
```
Expected: smoke-api-v1 `20/20 passed` in all three zones and `3/3 process zones passed`; the others pass; tsc and eslint clean. Prove H3 bites: in `currentCopy` change `COPY_FRESH_MS` to `0` in the comparison, see H3 fail on "50 warm requests", restore.

- [ ] **Step 11: Commit**

```bash
git add src/lib/api-v1/rate.ts src/lib/api-v1/handle.ts app/api/v1 src/lib/sentry-scrub.ts scripts/smoke-sentry-scrub.ts scripts/smoke-api-v1.ts docs/api/jewish-times-v1.md README.md CLAUDE.md
git commit -m "feat(api): /api/v1/shabbat and /api/v1/day with keys, rate, CORS, caching and the reference

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

### Task 6: The admin panel's API keys section

**Implementer: invoke the `frontend-design` skill first**, then build within the admin panel's kit: the mobile Mini App on `AppScreen`, `ScreenHeader`, `SectionLabel`, `FormCard`, `ListRow`, `TextField`, `CopyField`, `Notice`, `AdminSheet`/`ConfirmSheet`; no hover, logical CSS properties only, lucide icons only, no emoji, no new CSS unless the kit lacks something (then in `admin-css.ts` under `.ch-admin-*`). The code below is the baseline the skill refines; the smoke pins the behaviour, not pixel choices.

**Files:**
- Create: `app/[locale]/(app)/admin-panel/data/use-api-keys.ts`, `app/[locale]/(app)/admin-panel/views/ApiKeysView.tsx`
- Modify: `app/[locale]/(app)/admin-panel/data/types.ts`, `app/[locale]/(app)/admin-panel/navigation.tsx`, `app/[locale]/(app)/admin-panel/AdminPanel.tsx`, `app/[locale]/(app)/admin-panel/views/Overview.tsx`
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (insert `admin.apiKeys`)
- Test: `scripts/smoke-admin-render.ts`

**Interfaces:**
- Consumes: Task 3's route (`GET api-keys` → `{ keys }`, `POST api-keys` create/revoke, codes `INVALID_NAME`, `INVALID_ORIGIN`, `TOO_MANY_KEYS`, `NOT_FOUND`, `MIRROR_FAILED`); `adminGet`, `adminPost`, `BUSY`, `isBusy`, `outcomeOf`, `AdminResult`, `Outcome` (`data/admin-api.ts`); `dateOnly` (`data/format.ts`).
- Produces: `useApiKeys(): { keys: ApiKeyItem[]; status: LoadStatus; working: 'create' | number | null; activeCount: number | null; load(): Promise<void>; create(appName: string, origins: string): Promise<AdminResult<CreatedKeyAnswer>>; revoke(item: ApiKeyItem): Promise<Outcome> }`; `AdminView` gains `{ kind: 'apiKeys' }`; `Overview` gains the prop `apiKeyCount: number | null`.

- [ ] **Step 1: The messages**

Write the three blocks to a scratch file `/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/api-keys-messages.json`:

```json
{
  "en": {
    "section": "Other apps",
    "row": "API keys",
    "title": "API keys",
    "intro": "Each of your other apps reads FamCal's Jewish times with its own key. Revoking a key stops that app at once.",
    "empty": "No keys yet",
    "newKey": "New key",
    "anyCaller": "Any caller",
    "createdOn": "Created {date}",
    "revokedOn": "Revoked {date}",
    "sheetTitle": "New key",
    "appName": "App name",
    "appNamePlaceholder": "Shabbat times site",
    "origins": "Allowed websites (optional)",
    "originsPlaceholder": "https://shabbat.example.com",
    "originsHint": "Only for an app that calls from a browser. One address per line.",
    "create": "Create",
    "createdTitle": "Key created",
    "keyLabel": "The new key",
    "copy": "Copy",
    "copied": "Copied",
    "copyNow": "Copy it now: it is not shown again.",
    "revoke": "Revoke key",
    "revokeTitle": "Revoke the key of {app}?",
    "revokeBody": "That app stops working at once.",
    "revoked": "Key revoked",
    "errors": {
      "name": "Give the app a name, up to 40 characters.",
      "origin": "Each line must be a website address, like https://shabbat.example.com",
      "tooMany": "There are already 50 active keys. Revoke one first.",
      "mirror": "Revoked, but the cache was not updated. Try again.",
      "create": "Couldn't create the key. Try again.",
      "revoke": "Couldn't revoke the key. Try again."
    }
  },
  "he": {
    "section": "אפליקציות אחרות",
    "row": "מפתחות API",
    "title": "מפתחות API",
    "intro": "כל אפליקציה אחרת שלכם מקבלת את הזמנים של FamCal עם מפתח משלה. ביטול מפתח עוצר את האפליקציה שלו מיד.",
    "empty": "עדיין אין מפתחות",
    "newKey": "מפתח חדש",
    "anyCaller": "בלי הגבלת אתרים",
    "createdOn": "נוצר בתאריך {date}",
    "revokedOn": "בוטל בתאריך {date}",
    "sheetTitle": "מפתח חדש",
    "appName": "שם האפליקציה",
    "appNamePlaceholder": "אתר זמני שבת",
    "origins": "אתרים מורשים (לא חובה)",
    "originsPlaceholder": "https://shabbat.example.com",
    "originsHint": "רק לאפליקציה שפונה מדפדפן. כתובת אחת בכל שורה.",
    "create": "ליצור",
    "createdTitle": "המפתח נוצר",
    "keyLabel": "המפתח החדש",
    "copy": "להעתיק",
    "copied": "הועתק",
    "copyNow": "כדאי להעתיק אותו עכשיו: הוא לא יוצג שוב.",
    "revoke": "לבטל את המפתח",
    "revokeTitle": "לבטל את המפתח של {app}?",
    "revokeBody": "האפליקציה הזאת תפסיק לעבוד מיד.",
    "revoked": "המפתח בוטל",
    "errors": {
      "name": "יש לתת לאפליקציה שם, עד 40 תווים.",
      "origin": "כל שורה צריכה להיות כתובת של אתר, למשל https://shabbat.example.com",
      "tooMany": "כבר יש 50 מפתחות פעילים. יש לבטל אחד קודם.",
      "mirror": "המפתח בוטל, אבל המטמון לא התעדכן. כדאי לנסות שוב.",
      "create": "אי אפשר היה ליצור את המפתח. כדאי לנסות שוב.",
      "revoke": "אי אפשר היה לבטל את המפתח. כדאי לנסות שוב."
    }
  },
  "ru": {
    "section": "Другие приложения",
    "row": "Ключи API",
    "title": "Ключи API",
    "intro": "Каждое из ваших других приложений получает еврейские времена FamCal по своему ключу. Если отозвать ключ, это приложение сразу перестанет работать.",
    "empty": "Ключей пока нет",
    "newKey": "Новый ключ",
    "anyCaller": "Без ограничения по сайтам",
    "createdOn": "Создан: {date}",
    "revokedOn": "Отозван: {date}",
    "sheetTitle": "Новый ключ",
    "appName": "Название приложения",
    "appNamePlaceholder": "Сайт времён Шаббата",
    "origins": "Разрешённые сайты (необязательно)",
    "originsPlaceholder": "https://shabbat.example.com",
    "originsHint": "Только для приложения, которое обращается из браузера. По одному адресу в строке.",
    "create": "Создать",
    "createdTitle": "Ключ создан",
    "keyLabel": "Новый ключ",
    "copy": "Скопировать",
    "copied": "Скопировано",
    "copyNow": "Скопируйте его сейчас: больше он показан не будет.",
    "revoke": "Отозвать ключ",
    "revokeTitle": "Отозвать ключ приложения «{app}»?",
    "revokeBody": "Это приложение сразу перестанет работать.",
    "revoked": "Ключ отозван",
    "errors": {
      "name": "Введите название приложения, до 40 символов.",
      "origin": "Каждая строка должна быть адресом сайта, например https://shabbat.example.com",
      "tooMany": "Уже есть 50 активных ключей. Сначала отзовите один.",
      "mirror": "Ключ отозван, но кэш не обновился. Попробуйте ещё раз.",
      "create": "Не удалось создать ключ. Попробуйте ещё раз.",
      "revoke": "Не удалось отозвать ключ. Попробуйте ещё раз."
    }
  }
}
```

Insert each block as `admin.apiKeys`, right before the `admin.users` member, as inserted lines only (the files are not re-serialised):

```bash
node -e '
const fs = require("fs");
const blocks = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const l of ["en", "he", "ru"]) {
  const file = `messages/${l}.json`;
  const text = fs.readFileSync(file, "utf8");
  const admin = text.indexOf("\n  \"admin\": {");
  const at = text.indexOf("\n    \"users\": {", admin);
  if (admin < 0 || at < 0) throw new Error(`${file}: no admin.users anchor`);
  const body = JSON.stringify(blocks[l], null, 2).split("\n").map((line, i) => (i === 0 ? line : "    " + line)).join("\n");
  fs.writeFileSync(file, text.slice(0, at) + "\n    \"apiKeys\": " + body + "," + text.slice(at));
}' /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/api-keys-messages.json
git diff --stat messages/
```
Expected: each file shows only added lines (no `-` line), the same count in all three. Then delete the scratch file.

- [ ] **Step 2: Write the failing checks in `scripts/smoke-admin-render.ts`**

2a. `const BRANDS = /Telegram|WhatsApp|Google|FamCal|Pro|Gemini|\bID\b/g;` becomes `const BRANDS = /Telegram|WhatsApp|Google|FamCal|Pro|Gemini|\bID\b|\bAPI\b/g;`.

2b. After the `BLOCKED` constant insert:

```ts
const API_KEYS = [
  { id: 2, appName: 'Shabbat site', prefix: 'fcj_3kQ9xA', origins: ['https://shabbat.example.test'], createdAt: ago(60), revokedAt: null },
  { id: 1, appName: 'Old app', prefix: 'fcj_Zz12ab', origins: [], createdAt: ago(9 * 24 * 60), revokedAt: ago(2 * 24 * 60) },
];
/** The key the fake route makes: shown once by the sheet. */
const NEW_KEY = `fcj_${'N'.repeat(43)}`;
```

2c. In `scenario`, after `blocked: …,` insert `  apiKeys: API_KEYS.map((k) => ({ ...k })) as Row[],`; in `reset()`, after `scenario.blocked = …;` insert `  scenario.apiKeys = API_KEYS.map((k) => ({ ...k }));`.

2d. In `respond`, insert before `  return defaultRespond(call);`:

```ts
  if (key === 'GET api-keys') return ok({ keys: scenario.apiKeys });
  if (key === 'POST api-keys' && call.body?.action === 'create') {
    scenario.apiKeys.unshift({ id: 3, appName: call.body.appName, prefix: NEW_KEY.slice(0, 10), origins: String(call.body.origins ?? '').split('\n').filter(Boolean), createdAt: ago(0), revokedAt: null });
    return ok({ key: NEW_KEY, id: 3, prefix: NEW_KEY.slice(0, 10) });
  }
  if (key === 'POST api-keys' && call.body?.action === 'revoke') {
    const item = scenario.apiKeys.find((k) => k.id === call.body?.id);
    if (item) item.revokedAt = ago(0);
    return ok({});
  }
```

2e. In R1, the rows assertion's expected list gains the API keys row at its end, and the sections gain theirs after activity:

```ts
      assert(show(rows) === show([users, word(locale, 'rows.feedback'), word(locale, 'rows.blocked'), `${word(locale, 'rows.activity')} ${word(locale, 'rows.activityHint')}`, word(locale, 'apiKeys.row')]), `${where}: rows ${show(rows)}`);
      const sections = [...html.matchAll(/<h2 class="ch-section-label">([^<]*)<\/h2>/g)].map((m) => m[1]);
      assert(show(sections) === show(['sections.people', 'sections.activity', 'apiKeys.section', 'sections.switches', 'sections.reminders'].map((k) => word(locale, k))), `${where}: sections ${show(sections)}`);
```

2f. In R8, `listRows(errored).length === 4` becomes `listRows(errored).length === 5`.

2g. In U7, the prefix group of the "messages the panel reads that do not exist" filter, `/^(?:users|profile|rows|counts|sections|features|earlyAccess|reset|errors|common|activity|feedback|blocked|plan|planLine|unauthorized)\./`, gains `|apiKeys`.

2h. After the R7 check insert:

```ts
  await check('R11 API keys: the Overview counts the active keys; a row per key (the app, its first characters and its websites left to right or "Any caller", the day; a revoked one dimmed with the day it was revoked); New key opens a sheet whose Create posts { action: "create", appName, origins, initData } and then shows the key once, with Copy and the line to copy it now; Done forgets it; a refused name says so in the sheet; Revoke asks with the app\'s name, Cancel sends nothing, MIRROR_FAILED has its own line and the sheet stays, then it posts { action: "revoke", id, initData }, closes and says so', async () => {
    for (const locale of LOCALES) {
      reset();
      const w = (key: string, args: Row = {}) => word(locale, key, 'admin', args);
      const o = open(locale, propsOf(locale), { version: '7.7' });
      try {
        await settle();
        assert(rowOf(o.m, w('rows.withCount', { name: w('apiKeys.row'), count: 1 })) !== undefined, `${locale}: the Overview's count: ${show(listRows(o.m).map(flat))}`);
        await enter(o, locale, 'apiKeys.row');
        assert(flat(title(o.m) as FakeElement) === w('apiKeys.title') && page(o.m).includes(w('apiKeys.intro')), `${locale}: the header and the intro`);
        const ltr = (row: FakeElement) => elements(row).filter((e) => e.localName === 'bdi' && e.getAttribute('dir') === 'ltr').map(flat);
        let rows = listRows(o.m);
        assert(rows.length === 2 && flat(rows[0]).startsWith('Shabbat site') && show(ltr(rows[0])) === show(['fcj_3kQ9xA…', 'https://shabbat.example.test']) && flat(rows[0]).includes(w('apiKeys.createdOn').split('{')[0].trim()), `${locale}: the active row: ${rows.map(flat).join(' | ')}`);
        assert(rows[1].hasAttribute('disabled') && flat(rows[1]).includes(w('apiKeys.anyCaller')) && flat(rows[1]).includes(w('apiKeys.revokedOn').split('{')[0].trim()), `${locale}: the revoked row: ${flat(rows[1])}`);

        o.m.click(btn(o.m, w('apiKeys.newKey')));
        assert(dialogs(o.m).length === 1 && dialogs(o.m)[0].getAttribute('aria-label') === w('apiKeys.sheetTitle'), `${locale}: the New key sheet`);
        const field = (tag: string, label: string) => inSheet(o.m, (e) => e.localName === tag && e.getAttribute('aria-label') === label) as FakeElement;
        scenario.answers.set('POST api-keys', () => json({ error: 'INVALID_NAME' }, 400));
        o.m.input(field('input', w('apiKeys.appName')), 'x');
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        assert(dialogs(o.m).length === 1 && show(alertsIn(dialogs(o.m)[0])) === show([w('apiKeys.errors.name')]), `${locale}: a refused name: ${show(alertsIn(o.m.container))}`);
        scenario.answers.delete('POST api-keys');
        o.m.input(field('input', w('apiKeys.appName')), 'Candle site');
        o.m.input(field('textarea', w('apiKeys.origins')), 'https://candles.example.test');
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        const creates = posts('api-keys').filter((c) => c.body?.action === 'create');
        assert(creates.length === 2 && show(creates[1].body) === show({ action: 'create', appName: 'Candle site', origins: 'https://candles.example.test', initData: INIT_DATA }), `${locale}: the create: ${show(creates.map((c) => c.body))}`);
        assert(idFields(o.m).some((f) => f.value === NEW_KEY) && flat(dialogs(o.m)[0]).includes(w('apiKeys.copyNow')) && flat(dialogs(o.m)[0]).includes(w('apiKeys.createdTitle')), `${locale}: the key shown once`);
        assert(!adminLogs.some((l) => l.includes(NEW_KEY)), `${locale}: the key reached a log`);
        o.m.click(btn(o.m, word(locale, 'done', 'ui')));
        assert(dialogs(o.m).length === 0 && listRows(o.m).length === 3, `${locale}: Done closes it and the list has the new key`);
        o.m.click(btn(o.m, w('apiKeys.newKey')));
        assert(!idFields(o.m).some((f) => f.value === NEW_KEY) && field('input', w('apiKeys.appName')).value === '', `${locale}: the sheet forgot the key`);
        o.m.click(cancelOf(o.m) as FakeElement);

        const shabbat = () => listRows(o.m).find((r) => flat(r).startsWith('Shabbat site')) as FakeElement;
        o.m.click(shabbat());
        assert(dialogs(o.m)[0]?.getAttribute('aria-label') === w('apiKeys.revokeTitle', { app: 'Shabbat site' }), `${locale}: the revoke sheet`);
        o.m.click(cancelOf(o.m) as FakeElement);
        assert(dialogs(o.m).length === 0 && posts('api-keys').filter((c) => c.body?.action === 'revoke').length === 0, `${locale}: Cancel sent something`);
        o.m.click(shabbat());
        scenario.answers.set('POST api-keys', () => json({ error: 'MIRROR_FAILED' }, 503));
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        assert(dialogs(o.m).length === 1 && show(alertsIn(dialogs(o.m)[0])) === show([w('apiKeys.errors.mirror')]) && adminLogs.some((l) => l.startsWith('[admin] api-keys failed:')), `${locale}: MIRROR_FAILED: ${show(alertsIn(o.m.container))}`);
        scenario.answers.delete('POST api-keys');
        o.m.click(confirmOf(o.m) as FakeElement);
        await settle();
        const revokes = posts('api-keys').filter((c) => c.body?.action === 'revoke');
        assert(revokes.length === 2 && show(revokes[1].body) === show({ action: 'revoke', id: 2, initData: INIT_DATA }), `${locale}: the revoke: ${show(revokes.map((c) => c.body))}`);
        rows = listRows(o.m);
        assert(dialogs(o.m).length === 0 && show(statusesIn(o.m.container)) === show([w('apiKeys.revoked')]) && shabbat().hasAttribute('disabled'), `${locale}: after Revoke: ${show(statusesIn(o.m.container))}`);
      } finally {
        close(o);
      }
    }
  });
```

- [ ] **Step 3: Run it to see it fail**

Run: `RUN smoke-admin-render`
Expected: exit 1: R1 (rows and sections), R8 (5 rows) and R11 fail; U7 fails ("messages the panel never reads: apiKeys.…").

- [ ] **Step 4: The types and the hook**

In `data/types.ts`, insert after `export interface BlocklistAnswer { … }`:

```ts
/** A key of the Jewish times API as the admin list shows it (GET api-keys). */
export interface ApiKeyItem {
  id: number;
  appName: string;
  /** fcj_ and the key's next 6 characters. */
  prefix: string;
  origins: string[];
  createdAt: string;
  revokedAt: string | null;
}
export interface ApiKeysAnswer {
  keys: ApiKeyItem[];
}
/** POST api-keys { action: 'create' }: the key, in this answer only. */
export interface CreatedKeyAnswer {
  key: string;
  id: number;
  prefix: string;
}
```

`data/use-api-keys.ts`:

```ts
'use client';

// The Jewish times API's keys (GET api-keys; spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md §2.1). `load` asks
// for the whole list; `create` makes a key and answers it once (the sheet shows it and forgets it; it is never logged or
// kept here); `revoke` revokes one by its id. Each reloads the list when it worked; one change runs at a time (`working`:
// 'create', or the id being revoked). `activeCount` is what the Overview shows once the list is in.

import { useCallback, useEffect, useRef, useState } from 'react';
import { adminGet, adminPost, BUSY, outcomeOf, type AdminResult, type Outcome } from './admin-api';
import type { ApiKeyItem, ApiKeysAnswer, CreatedKeyAnswer } from './types';
import type { LoadStatus } from './use-users';

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [working, setWorking] = useState<'create' | number | null>(null);
  const latest = useRef(0);
  const running = useRef(false);
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    const result = await adminGet<ApiKeysAnswer>('api-keys');
    if (mine !== latest.current) return;
    if (result.ok) {
      setKeys(result.data.keys ?? []);
      setStatus('ready');
    } else {
      setStatus((s) => (s === 'ready' ? s : 'failed'));
    }
  }, []);

  const create = useCallback(
    async (appName: string, origins: string): Promise<AdminResult<CreatedKeyAnswer>> => {
      if (running.current) return BUSY;
      running.current = true;
      setWorking('create');
      try {
        const result = await adminPost<CreatedKeyAnswer>('api-keys', { action: 'create', appName, origins });
        if (result.ok) await load();
        return result;
      } finally {
        running.current = false;
        setWorking(null);
      }
    },
    [load],
  );

  const revoke = useCallback(
    async (item: ApiKeyItem): Promise<Outcome> => {
      if (running.current) return BUSY;
      running.current = true;
      setWorking(item.id);
      try {
        const outcome = outcomeOf(await adminPost('api-keys', { action: 'revoke', id: item.id }));
        if (outcome.ok) await load();
        return outcome;
      } finally {
        running.current = false;
        setWorking(null);
      }
    },
    [load],
  );

  const activeCount = status === 'ready' ? keys.filter((k) => k.revokedAt === null).length : null;
  return { keys, status, working, activeCount, load, create, revoke };
}
```

- [ ] **Step 5: The view `views/ApiKeysView.tsx`**

```tsx
'use client';

// The keys of the owner's other apps for the Jewish times API (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md
// §2.1): one row per key (the app, the key's first characters, the websites it may be called from or "Any caller", the day it
// was made; a revoked one dimmed, with the day it was revoked), New key, and Revoke on each active key.
//
// - New key: a sheet with the app's name and, optionally, the allowed websites, one per line. Create shows the key once with
//   Copy and "Copy it now: it is not shown again."; Done, Cancel and Back forget it (it lives in this sheet's state only).
// - Revoke asks first, names the app, and works at once; MIRROR_FAILED has its own line ("Revoked, but the cache was not
//   updated"), and a retry is safe (revoking again succeeds).
// - A failure is said in the sheet, which stays; a success closes it and the list says so. The request helper logs failures.

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CopyField } from '@/components/app-ui/CopyField';
import { Notice } from '@/components/app-ui/Notice';
import { ScreenHeader } from '@/components/app-ui/ScreenHeader';
import { FormCard, TextField } from '@/components/app-ui/form-kit';
import { ListRow } from '@/components/app-ui/ListRow';
import { isBusy } from '../data/admin-api';
import { dateOnly } from '../data/format';
import type { ApiKeyItem } from '../data/types';
import type { useApiKeys } from '../data/use-api-keys';
import { AdminSheet, ConfirmSheet } from '../sheets';
import { LoadFailed, Waiting } from './parts';

/** The create refusals the sheet words by their code; anything else is the generic line. */
const CREATE_ERRORS = { INVALID_NAME: 'apiKeys.errors.name', INVALID_ORIGIN: 'apiKeys.errors.origin', TOO_MANY_KEYS: 'apiKeys.errors.tooMany' } as const;
type CreateError = (typeof CREATE_ERRORS)[keyof typeof CREATE_ERRORS] | 'apiKeys.errors.create';
const createError = (code: string | undefined): CreateError => (code !== undefined && code in CREATE_ERRORS ? CREATE_ERRORS[code as keyof typeof CREATE_ERRORS] : 'apiKeys.errors.create');
type RevokeError = 'apiKeys.errors.mirror' | 'apiKeys.errors.revoke';

export function ApiKeysView({ apiKeys, onBack }: { apiKeys: ReturnType<typeof useApiKeys>; onBack: () => void }) {
  const t = useTranslations('admin');
  const ui = useTranslations('ui');
  const locale = useLocale();
  const { load, create, revoke } = apiKeys;
  const [revokedNotice, setRevokedNotice] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [createFailed, setCreateFailed] = useState<CreateError | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyItem | null>(null);
  const [revokeFailed, setRevokeFailed] = useState<RevokeError | null>(null);
  useEffect(() => {
    void load();
  }, [load]);

  const creating = apiKeys.working === 'create';
  const revokingNow = revoking !== null && apiKeys.working === revoking.id;

  const openNew = () => {
    setRevokedNotice(false);
    setName('');
    setOrigins('');
    setCreatedKey(null);
    setCreateFailed(null);
    setNewOpen(true);
  };
  const closeNew = () => {
    if (creating) return;
    setNewOpen(false);
    setCreatedKey(null);
    setName('');
    setOrigins('');
    setCreateFailed(null);
  };
  const submit = async () => {
    setCreateFailed(null);
    const result = await create(name, origins);
    if (result.ok) setCreatedKey(result.data.key);
    else if (!isBusy(result)) setCreateFailed(createError(result.code));
  };
  const closeRevoke = () => {
    if (revokingNow) return;
    setRevoking(null);
    setRevokeFailed(null);
  };
  const confirmRevoke = async () => {
    if (!revoking) return;
    setRevokeFailed(null);
    const outcome = await revoke(revoking);
    if (outcome.ok) {
      setRevoking(null);
      setRevokedNotice(true);
    } else if (!isBusy(outcome)) {
      setRevokeFailed(outcome.code === 'MIRROR_FAILED' ? 'apiKeys.errors.mirror' : 'apiKeys.errors.revoke');
    }
  };

  return (
    <>
      <ScreenHeader title={t('apiKeys.title')} backLabel={ui('back')} onBack={onBack} />
      <div className="ch-form-page ch-form-page-grouped">
        {revokedNotice ? <Notice>{t('apiKeys.revoked')}</Notice> : null}
        <p className="ch-form-fixed">{t('apiKeys.intro')}</p>
        {apiKeys.status === 'failed' ? <LoadFailed onRetry={() => void load()} /> : null}
        {apiKeys.status === 'loading' ? <Waiting /> : null}
        {apiKeys.status === 'ready' && apiKeys.keys.length === 0 ? <p className="ch-form-fixed">{t('apiKeys.empty')}</p> : null}
        {apiKeys.keys.length > 0 ? (
          <FormCard>
            {apiKeys.keys.map((item) => (
              <ListRow
                key={item.id}
                title={item.appName}
                disabled={item.revokedAt !== null}
                meta={
                  <>
                    <span className="ch-admin-line">
                      <bdi dir="ltr">{`${item.prefix}…`}</bdi>
                    </span>
                    <span className="ch-admin-line">{item.origins.length > 0 ? <bdi dir="ltr">{item.origins.join(', ')}</bdi> : t('apiKeys.anyCaller')}</span>
                    <span className="ch-admin-line">{item.revokedAt ? t('apiKeys.revokedOn', { date: dateOnly(item.revokedAt, locale) }) : t('apiKeys.createdOn', { date: dateOnly(item.createdAt, locale) })}</span>
                  </>
                }
                onClick={() => {
                  setRevokedNotice(false);
                  setRevokeFailed(null);
                  setRevoking(item);
                }}
              />
            ))}
          </FormCard>
        ) : null}
        <button type="button" className="ch-btn ch-btn-primary ch-save" aria-haspopup="dialog" onClick={openNew}>
          {t('apiKeys.newKey')}
        </button>
      </div>

      {newOpen ? (
        <AdminSheet label={t('apiKeys.sheetTitle')} closeLabel={ui('cancel')} working={creating} onClose={closeNew}>
          <h2 className="ch-sheet-heading">{createdKey ? t('apiKeys.createdTitle') : t('apiKeys.sheetTitle')}</h2>
          {createdKey ? (
            <div className="ch-sheet-stack">
              <FormCard>
                <CopyField label={t('apiKeys.keyLabel')} value={createdKey} copyLabel={t('apiKeys.copy')} copiedLabel={t('apiKeys.copied')} />
              </FormCard>
              <p className="ch-form-fixed">{t('apiKeys.copyNow')}</p>
              <button type="button" className="ch-btn ch-btn-primary ch-save" onClick={closeNew}>
                {ui('done')}
              </button>
            </div>
          ) : (
            <div className="ch-sheet-stack">
              <FormCard>
                <TextField label={t('apiKeys.appName')} placeholder={t('apiKeys.appNamePlaceholder')} value={name} onChange={setName} maxLength={40} disabled={creating} />
              </FormCard>
              <FormCard>
                <TextField label={t('apiKeys.origins')} placeholder={t('apiKeys.originsPlaceholder')} value={origins} onChange={setOrigins} multiline rows={3} disabled={creating} />
              </FormCard>
              <p className="ch-form-fixed">{t('apiKeys.originsHint')}</p>
              {createFailed ? <Notice tone="error">{t(createFailed)}</Notice> : null}
              <button type="button" className="ch-btn ch-btn-primary ch-save" disabled={creating || name.trim() === ''} aria-busy={creating || undefined} onClick={() => void submit()}>
                {creating ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
                {t('apiKeys.create')}
              </button>
            </div>
          )}
        </AdminSheet>
      ) : null}

      {revoking ? (
        <ConfirmSheet
          title={t('apiKeys.revokeTitle', { app: revoking.appName })}
          body={t('apiKeys.revokeBody')}
          confirmLabel={t('apiKeys.revoke')}
          cancelLabel={ui('cancel')}
          tone="danger"
          working={revokingNow}
          error={revokeFailed ? t(revokeFailed) : null}
          onConfirm={() => void confirmRevoke()}
          onClose={closeRevoke}
        />
      ) : null}
    </>
  );
}
```

The `t(…)` calls name every `apiKeys.*` key as a literal (U7 checks that each message is read).

- [ ] **Step 6: Wire it in**

`navigation.tsx`: the `AdminView` union gains `| { kind: 'apiKeys' }` (after `{ kind: 'activity' }`), and its doc comment says "…and the sub-screens (feedback, blocked, activity, API keys)".

`AdminPanel.tsx`:
- import `import { useApiKeys } from './data/use-api-keys';` and `import { ApiKeysView } from './views/ApiKeysView';` beside their neighbours;
- after `const blocklist = useBlocklist();` add `const apiKeys = useApiKeys();`, and after `const { load: loadBlocklist } = blocklist;` add `const { load: loadApiKeys } = apiKeys;`;
- the root effect loads it too: `void loadBlocklist();` is followed by `void loadApiKeys();`, and its dependency list becomes `[atRoot, loadFeedback, loadBlocklist, loadApiKeys]`; the comment above it becomes "The Overview shows how many messages, blocked entries and active API keys there are";
- `<Overview … blockedCount={…}` gains `apiKeyCount={apiKeys.activeCount}`;
- the `show` switch gains, after `case 'blocked':`,
  ```tsx
      case 'apiKeys':
        return <ApiKeysView apiKeys={apiKeys} onBack={back} />;
  ```
- the header comment's "the feedback and blocklist lists the Overview counts" becomes "the feedback, blocklist and API key lists the Overview counts".

`views/Overview.tsx`:
- `OverviewProps` gains, after `blockedCount: number | null;`, `/** How many API keys are active, once known. */ apiKeyCount: number | null;`, and the function's destructuring gains `apiKeyCount`;
- after the Activity card (`</FormCard>` that closes `rows.activity`), insert:
  ```tsx

        <SectionLabel>{t('apiKeys.section')}</SectionLabel>
        <FormCard>
          <ListRow title={titled(t('apiKeys.row'), apiKeyCount)} onClick={() => onOpen({ kind: 'apiKeys' })} />
        </FormCard>
  ```
- the header comment's list "the ways into people, feedback, the blocked and the activity log" becomes "the ways into people, feedback, the blocked, the activity log and the API keys".

- [ ] **Step 7: Run the panel's smokes and the language checks**

```
RUN smoke-admin-render
RUN smoke-admin-panel-ssr
RUN smoke-admin-data
RUN smoke-he-neutral
RUN smoke-ru-formal
npx tsx scripts/check-i18n-parity.ts
npx tsc --noEmit -p .
npx eslint "app/[locale]/(app)/admin-panel" scripts/smoke-admin-render.ts
```
Expected: all pass (R11 included, in en, he and ru); tsc and eslint clean. Prove R11 bites: in `closeNew` remove `setCreatedKey(null);`, see R11 fail on "the sheet forgot the key", restore.

- [ ] **Step 8: Commit**

```bash
git add "app/[locale]/(app)/admin-panel" messages/en.json messages/he.json messages/ru.json scripts/smoke-admin-render.ts
git commit -m "feat(admin): API keys section: make a key once, list, revoke

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31"
```

---

## The gate (after Task 6)

```
bash scripts/ci-smokes.sh            # with the repo's own fake env, every smoke
npx tsc --noEmit -p .
npm run lint
```
Then a fresh-clone build of the branch (never `npm run build`): clone into the scratchpad, `npm ci`, `bash -c 'source …/fake-env.sh; env $E npx prisma generate && env $E npx next build'`, and delete the clone. Then the whole-branch review (Opus), every valid finding fixed, and the merge to main per the repo's rules.

## Self-review notes

- Spec coverage: §1 decisions 1-12 (keys per app, panel, no Railway, no query per request, hash only, origins; place by city or coordinates, Israel heights and zone, NO_TIME_ZONE; one code path; candle lighting at 20 minutes; community per request; two endpoints and three languages; ISO with offset and local hh:mm; rate 300; cache an hour, private; date bounds; credits; no legal change) → Tasks 1-6. §2.1 panel → Task 6. §3.1-3.4 → Tasks 1, 4, 5. §3.5 → Tasks 2, 3, 6. §3.6-3.9 → Task 5 (and Task 2 for the lookup). §4 tests: smoke-api-v1 (P1-P3, V1-V6, H1-H10, Z1 cover items 1-13), smoke-api-keys (K1-K8, A1-A5, Z1), smoke-sentry-scrub #16, the existing zmanim smokes unchanged. §5 docs → Task 5. §6 non-goals: no usage counting, no per-custom candle lighting, no edit, no weather, no chat message.
- Rulings beyond the spec's text, for the reviewer: a `mirror.ts` beside `store.ts` and `lookup.ts` (no import cycle); the migration timestamp `20261107010000`; `/shabbat`'s day rows carry `opinion` (null) like `/day`'s, one row shape; a repeated parameter is `UNKNOWN_PARAMETER`; a refusal's log line appends its code; `Access-Control-Expose-Headers` on CORS answers; a create whose mirror write fails still returns the key; a background refresh never falls back to the table while Redis fails; 503 carries `Retry-After: 60`; the Overview's row sits in its own "Other apps" section after Activity.
