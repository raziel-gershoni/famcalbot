# Calendar home: design

**Date:** 2026-10-16 · **Branch:** `feat/calendar-home` · **Status:** approved in conversation, section by section (reader, summaries, loading and errors, week start and Hebrew dates, screens). The owner delegated the smaller choices ("go with your defaults"). They are listed under *Rulings* so they can be reviewed.

Line references are to `main` at 858886c. "Ruling Rn" refers to the table below; "A-n" refers to the summary regression contract in Appendix A.

## Goal

When a user opens FamCal in Telegram, they see their calendar: an **Agenda** for today and the coming week, and an iOS-style **Month**. The screens are the same for FamCal-calendar users and Google-calendar users. The home is view-only in this step.

The daily, tomorrow and weekly summaries move onto the **same server-side reader** as the home, so a summary and the screen never disagree.

## Scope

**In scope**
- A new home at `/dashboard`: header, send-to-chat sheet, ⋯ menu, Agenda tab, Month tab. Behind a rollout switch; the old dashboard stays as the fallback.
- A shared reader, `readRange`, over FamCal and Google, with Google clean-up, a short Google cache and per-source status.
- `GET /api/calendar/range`.
- The daily and tomorrow summaries, the tomorrow summary's week-ahead block, `/week` and `/nextweek` moved onto the reader for users the switch covers, with their Google error handling.
- A country-based week start for the Month grid and for the bot's week ranges (switch-covered users).
- Hebrew dates on the home under the owner's rule.
- Four existing bugs fixed for everyone (§8).

**Out of scope** (later sub-projects)
- Marking reminders done, undo, snooze (2). Creating, editing, deleting (3). Holidays and a Hebrew-month grid (4). Hebrew-date repeats (5).
- Showing FamCal and Google calendars together for one person. Today a user is either FamCal or Google (Owner decision 2); that changes in the "Google becomes a connection" step.
- The 5-minute event-alert pass, the voice/text edit-and-delete matcher and all writes keep today's reads. They do share the §8.2 fix.

## Owner decisions (from the conversation)

1. **One shared reader** for the home and the summaries. The summaries move onto it behind the same admins-first switch.
2. **Each person sees their own kind only in step 1.** Connecting Google switches a user to GOOGLE and soft-deletes their FamCal calendars, a locked rule today (`src/services/google-connect.ts:121-137`). So FamCal users see FamCal; Google users see their chosen Google calendars. Same screens for both.
3. **Google items** are marked, view-only, served from a short cache. Non-events are dropped: working location, out of office, declined invites. Descriptions are plain text. A dead token shows a "Reconnect Google" banner.
4. **Week start by country**, derived from the timezone; always Sunday for Jewish culture. The bot's This week / Next week follow the same rule.
5. **Hebrew dates** for Jewish culture, Hebrew language, or an Israel timezone.
6. **Rollout:** admins first, behind an AdminSettings switch, with the old home as the fallback. The switch can be turned back without a redeploy.
7. **Header buttons:** a Send icon that opens a sheet, plus a ⋯ menu.
8. **Month works like iOS:** months scroll vertically with titles in the cells; tapping a day keeps only that month, compact with dots, with the day's list below. "All months" and Telegram's back button return to browsing. The chevrons change month; Today jumps back. The last layout is remembered per device.
9. **Summary outages:** when Google can't be reached at send time, retry once about 30 s later, then send the summary with one line saying Google couldn't be reached. Never skip silently.
10. **Zoom stays locked** as today; instead nothing on the home is smaller than 11 px.

## Rulings (the owner delegated these)

| # | Ruling | Why |
|---|---|---|
| R1 | `focusTime` is dropped along with `workingLocation` and `outOfOffice`. `birthday`, `fromGmail` and unknown types are kept. | A deny-list keeps types Google adds later. Birthdays drive the "Birthday" label. |
| R2 | "Declined" means declined by the owner of the calendar the copy sits on (`attendees[].self`). | That is what Google's `self` means; on a spouse's calendar it hides what the spouse declined. |
| R3 | A Google user still paired with a FamCal partner sees no FamCal items in step 1. | Showing them needs leak fixes and a pairing screen for Google users, who can't see or unlink a pairing today. |
| R4 | A suspended partner's items stay visible, as in the summaries today. | Matches the summaries. |
| R5 | After a send-to-chat tap, Telegram closes the app only on a 2xx. On failure it stays open and says why (429 = "try in a minute"). In a browser it always stays, with "Sent to WhatsApp". | Today's silent close hides failures (`DashboardClient.tsx:115-135`). |
| R6 | The ⋯ menu: Settings, Subscription, Refresh, Feedback; Calendars and Partner for FamCal users; Choose calendars and Reconnect Google for Google users; Admin for admins. Calendars and Partner open the existing pages as they are. | Without a partner the home shows half a family. |
| R7 | Partner items carry the partner's name; the calendar colour is only an accent. | Works even when colours collide (every default calendar is `#039BE5`). |
| R8 | Agenda covers today + 6 days. Today and tomorrow always show; later empty days fold into one line; "Show next week" extends by 7 days. | Matches the bot's week. |
| R9 | Russian Hebrew months: genitive in day labels ("4 хешвана"), nominative in headers ("Тишрей – Хешван 5787"). | Natural Russian. |
| R10 | Empty calendar: "Nothing planned", plus a how-to-add hint naming only the ways the user's plan allows. | Never promise what the plan lacks. |
| R11 | Daily-repeating reminders are not drawn in Month cells; they are listed for the selected day. | Otherwise every cell carries the same marker. |
| R12 | Month fetches each month's own days (`[1st, 1st of next month)`); cells outside the month stay blank. | Same as iOS, and one fetch per month. |
| R13 | On-demand summaries during a Google outage: one quick retry, then "Couldn't reach Google Calendar, try again in a minute", with no admin page. | The user is waiting; a 30 s retry is too long there. |
| R14 | `/week` and `/nextweek`: a dead token or missing permission gives the same texts as the on-demand daily; an outage gives R13's text. Today both say "No notable events". | Honest, and consistent with the daily. |
| R15 | Week start with no known timezone: by language. Hebrew and English start on Sunday, Russian on Monday, anything else Monday. | CLDR maps plain `en` to the US. |
| R16 | In the bot, Hebrew dates and holidays stay tied to `culture === 'jewish'`. | Switching would, for example, make Hebrew voice summaries drop the Gregorian date (`voice-condenser/he.ts:21`). |
| R17 | Horizontal swipe between months is left out; the chevrons do that. | Avoids a gesture fight with Android's back edge. |
| R18 | When all of a Google user's chosen calendars are gone (deleted, unshared, another account), summaries stay empty as today, with a Sentry warning; the home asks them to choose again. | A retry can't help, and "couldn't be reached" would be wrong. |

---

## Delivery plans

The work ships as five plans, in this order. Each leaves `main` working.

| Plan | Contents | Depends on | Visible to users |
|---|---|---|---|
| **A. Fixes** | §8.1–§8.4 (the §8.3 stamp hook comes with B) | — | Yes, for everyone: the fixes only |
| **B. Reader and route** | §1 switch and admin control, §2 reader, §6's pure rules and zone table, §4 route, the stamp hook | A | No (switch `OFF`) |
| **C. Summaries** | §3, the bot part of §6, the parity smoke | B | Admins once the switch is `ADMINS` |
| **D. Home and Agenda** | §5, §7.1–§7.3, §7.5–§7.7, §9 | B (parallel with C) | Admins once the switch is `ADMINS` |
| **E. Month** | §7.4, §7.8, their smokes, the device check | D | Admins once the switch is `ADMINS` |

The switch goes to `ADMINS` after C and D land; `ALL` after E and the device check (§10).

---

## 1. Rollout switch

- `AdminSettings.calendarHomeRollout`, a new enum `CalendarHomeRollout { OFF ADMINS ALL }`, default `OFF`. Migration `20261016000000_calendar_home_rollout`. Ships as `OFF`: the home and the summary reader change nothing on deploy (the §8 fixes are live for everyone).
- `src/services/calendar-read/rollout.ts`:
  - `getCalendarHomeRollout(): Promise<'OFF' | 'ADMINS' | 'ALL'>`: an in-process memo on `globalThis` for 30 s, then Redis `chome:rollout`, then the DB (also when the Redis read fails). Any other value, both stores failing, or no row → `OFF`. The read-through populate writes `EX 60`.
  - `isCalendarHomeOn(user: { isAdmin?: boolean }): Promise<boolean>`: `ALL`, or `ADMINS` and `user.isAdmin === true`. **Always awaited.**
  - `setCalendarHomeRollout(v)`: DB upsert, then Redis `SET … EX 60`, `DEL` if that fails, and clear this process's memo. It returns whether Redis took the value. So the DB value always wins within about a minute.
- `app/api/admin/settings/route.ts`: GET returns `calendarHomeRollout ?? 'OFF'`. POST accepts it only when it is `'OFF'`, `'ADMINS'` or `'ALL'` (anything else is a 400), counts it in the at-least-one-field check, and calls the setter. When Redis didn't take the value it answers 503 "Saved; takes effect within a minute".
- Admin panel: a three-way control in `AdminPanelClient.tsx` next to the native-reminders toggle. `loadAdminPanel` maps `settings.calendarHomeRollout ?? 'OFF'` into the initial props. Labels in `messages/{en,he,ru}.json`. `scripts/smoke-admin-panel-ssr.ts`'s fixture uses `'ADMINS'`.
- The switch covers the home **and** the summary path. Every call site asks `await isCalendarHomeOn(user)` with a fresh DB user row.

---

## 2. The shared reader

### 2.1 Layout

New folder `src/services/calendar-read/`:

| File | Purpose | Exports |
|---|---|---|
| `types.ts` | Server types (§2.2); re-exports `DayKey` and `SourceName` from `src/lib/calendar-view/types.ts` | types |
| `index.ts` | Pick sources, build the window, run both halves in parallel | `readRange`, `sourcesFor` |
| `famcal.ts` | FamCal half (§2.4) | `readFamcal` |
| `google.ts` | Google half: auth, paging, outcome → status, deadline, cache, single-flight (§2.5, §2.6) | `readGoogle`, `stampGoogleCache` |
| `google-map.ts` | Pure Google rules | `classifyGoogleError`, `keepGoogleEvent`, `mapGoogleEvent` |
| `dto.ts` | Pure: bucket into days, mark open, build DTOs (§4) | `toRangeDays`, `toItemDto`, `toCalendarDto` |
| `digest.ts` | Summary adapters (§3) | `readDigestDay`, `readLookaheadEvents` |
| `rollout.ts` | The switch (§1) | see §1 |

Also new:
- `src/utils/locale-rules.ts` (pure): `weekStartFor`, `legacyWeekStart`, `hebrewDatesFor`, `tzKnownFor` (§6).
- `src/config/week-start-zones.ts`: a generated table (§6).
- `htmlToText` added to `src/utils/html.ts`, which stays a leaf module.
- `src/lib/calendar-view/types.ts`: `DayKey`, `SourceName`, the DTO types and `compareItems` (client-safe).
- `src/lib/calendar-view/{grid,hebrew-date,agenda}.ts`: pure view helpers (§7).
- `src/lib/command-client.ts`: the send-to-chat call, pulled out of `DashboardClient.tsx:105-137` and used by both homes.
- `app/api/calendar/range/route.ts` (§4).

Edits to existing files:
1. `src/services/calendar-provider/native-provider.ts:157-193`: split the private `fetchForViewer` into an exported `fetchViewerItems(user, cuids, range) → { ctx, items: { row, state?, event }[] }`; `fetchForViewer` becomes `items.map(i => i.event)`. No behaviour change.
2. `src/services/calendar.ts`: a new export `getGoogleAuth(token)` returns the OAuth2 client that `getCalendarClient` builds today (`:17-28`); `getCalendarClient` calls it. No behaviour change. Nothing else in `calendar.ts` changes.
3. `src/services/calendar-provider/google-provider.ts:85-126`: after each `createEvent` / `updateEvent` / `deleteEvent`, success or failure, `await stampGoogleCache(user.id)`. The write's own result or error is returned unchanged (§2.6).
4. `src/services/google-connect.ts:114-150`: `stampGoogleCache(user.id)` after the transaction and the reminder-cache update.
5. `src/services/telegram/summary.ts` (§3.1): switch-aware fetch wrappers (`:11-14`) for scheduled and on-demand runs; `sendSummaryToUser`'s `onError` (`:297-334`) gains `GOOGLE_FETCH_FAILED`; `sendSummaryToAll` (`:389-505`) gains the C5 retry queue; `prepareSummaryForUser` takes an optional `{ googleUnavailable, summaryDate }`.
6. `src/services/week-lookahead.ts`: the switch-aware fetch at `fetchEventsInRange` (`:202`); week boundaries take a `weekStart` (§6); the recurrence-cache fix (§8.3).
7. `src/services/telegram/commands.ts:553-595, :654-692`: `/week` and `/nextweek` get an `onError` (Ruling R14).
8. `src/services/claude.ts` (`SummaryUserContext`, `:57-63`, and its pass-through `:147-173`) and `src/prompts/calendar-summary/{types,en,he,ru}.ts`: an optional `googleUnavailable` flag adds the C5 guideline line. Without it, prompts are byte-identical.
9. `src/services/native-reminders/open-reminders.ts`: move `reminderDueAt` into the leaf module `due.ts` and re-export it, so `dto.ts` stays free of Prisma imports. Add `fetchOpenReminderItems(...)`, a variant of `fetchOpenReminders` that also returns each carry-over's state row and occurrence `instanceStartsAt`. The summary's `fetchOpenReminders` is unchanged.
10. `src/lib/rate-limit.ts`: `calendarRateLimiter`, 60 per minute, prefix `ratelimit:calendar`.
11. `src/config/redis-keys.ts`: `gcalRange`, `gcalStamp`, `gcalGoneWarned`, `gcalFresh`, `gcalConfigAlert`, `CALENDAR_HOME_ROLLOUT`.
12. `app/api/execute-command/route.ts:17, :38`: read init data with `requestInitData(request, body)`, so the header works (today it reads only the JSON body).
13. `src/lib/page-data.ts:113-151` (dashboard): adds `calendarHome`, and fires `webapp_opened` (§7.1).
14. `app/[locale]/PageGate.tsx`: renders `CalendarHome` when `calendarHome` is true (§7.1).

Not touched: `day-events.ts`, `event-formatter.ts`, the alert pass (`reminders.ts`), the voice matcher.

### 2.2 Types

```ts
// src/services/calendar-read/types.ts
export type { DayKey, SourceName } from '@/lib/calendar-view/types';   // 'yyyy-MM-dd' in the viewer's tz; 'famcal' | 'google'

export interface CalendarRef {                       // what the UI may show about an item's calendar
  id: string | null;                                 // 'native:<cuid>' or the Google id; null when masked
  source: SourceName;
  name: string;
  color: string | null;
  mine: boolean;
  ownerName?: string;                                // the partner, or a spouse-labelled Google calendar's person
  inLegend: boolean;
  unavailable?: boolean;                             // a chosen Google calendar that is gone
}

export interface ReadItem {
  source: SourceName;
  key: string;                                       // 'famcal|<eventId>' | 'google|<calendarId>|<id>'
  event: UnifiedEvent;                               // exactly what the summaries consume today
  calendar: CalendarRef;                             // for the DTO; the summaries never read it
  title: string | null;                              // raw title; event.summary keeps 'No title'
  kind: 'event' | 'reminder';
  seriesId: string | null;
  originalStart: string | null;                      // FamCal instanceStartsAt (one-offs too) or Google originalStartTime
  recurring: boolean;
  rrule: string | null;                              // FamCal series rrule; Google null
  state?: { doneAt: Date | null; snoozedUntil: Date | null };
  google?: { birthday: boolean; htmlLink: string | null };
}

export interface ReadRangeOptions {
  tz: string;                                        // the caller's resolveUserTimezone
  sources?: readonly SourceName[];                   // intersected with sourcesFor(user); absent = all applicable
  calendarIds?: readonly string[];                   // summary callers only: the ids they already resolved
  notBefore?: Date;                                  // clip the start to an instant (This week starts now)
  googleCache?: 'use' | 'refresh' | 'bypass';        // default 'bypass'; only the route uses the cache
  deadlineMs: number;                                // see "Deadlines" below
}

export type FamcalRead =
  | { status: 'ok'; ctx: ViewerContext; calendars: CalendarRef[]; partner: { name: string } | null }
  | { status: 'error'; cause: unknown };

export type GoogleRead =
  | { status: 'ok'; calendars: CalendarRef[]; goneIds: string[];
      partial: { failed: number; truncated: number } | null; stale: boolean }
  | { status: 'reconnect'; reason: 'token' | 'scopes' }
  | { status: 'error'; reason: 'transient' | 'config' | 'timeout' | 'calendars_gone' | 'unknown'; cause?: unknown };

export interface RangeRead {
  window: { from: Date; to: Date };
  items: ReadItem[];                                 // FamCal then Google, each in today's order; not bucketed
  famcal?: FamcalRead;                               // absent when it doesn't apply or wasn't requested
  google?: GoogleRead;
}

export function sourcesFor(user: Pick<UserConfig, 'calendarSource'>): SourceName[];  // NATIVE → ['famcal'], GOOGLE → ['google']
export function readRange(user: UserConfig, fromKey: DayKey, toKey: DayKey, opts: ReadRangeOptions): Promise<RangeRead>;
```

- `sourcesFor` is the one place that decides which sources apply. The "Google becomes a connection" step changes only this function plus the ownership fixes.
- `user` is always a fresh DB row (the `verifyUserAuth` user or the summary's `getAllUsers` row), never the reminder cache's rebuilt user, which defaults the source to GOOGLE (`src/cron/handlers.ts:168`).
- Order: FamCal items in provider order; Google items in assignment order, then a stable sort by `new Date(start)` (as `calendar.ts:159`). A user has one source in step 1, so concatenation never reorders.

**Deadlines** (`deadlineMs`, covering the whole Google half):

| Caller | Deadline |
|---|---|
| The range route | 6,000 ms |
| Scheduled summaries (first attempt) | 30,000 ms |
| Scheduled summaries (C5 retry) | 15,000 ms |
| On-demand summaries, `/week`, `/nextweek`, the on-demand tomorrow block | 10,000 ms; R13's retry 8,000 ms |

On demand, Google time stays under 30 s of `executeCommand`'s 50 s limit (`command-pipeline.ts:10`), leaving room for the timezone lookup and the AI call.

### 2.3 Windows and days

- The window is `[max(startOfLocalDay(fromKey, tz), notBefore), startOfLocalDay(toKey, tz))`, half-open.
- Both halves use overlap: FamCal `start < to && (start >= from || end > from)` (`recurrence.ts:110-112`); Google `timeMin`/`timeMax`.
- No ±1-day padding. Accepted gap: an all-day item seen from a timezone 24 h or more away from the creator's (true of the summaries today too).
- **readRange does not bucket into days.** Day membership is always `daySpanOf(event, day, tz)` (`src/utils/day-events.ts:58-86`):
  - all-day by date string with exclusive end;
  - a zero-length item on its own day;
  - timed items by overlap with local midnight to midnight (23/25 h DST days);
  - last night's tail ending by 06:00 dropped;
  - edge-crossing items marked `endsLater` / `continues` / `spansDay`.

  The summaries apply it through `shapeEventsForDay`, the home through `toRangeDays`, so both agree.
- Small differences from today's windows: the end becomes an exclusive midnight (today 23:59:59.999 or 23:59:59), and an item without a `start` is dropped.

### 2.4 FamCal half

1. Applies only when `calendarSource === 'NATIVE'`. Otherwise absent, with zero DB queries. It never calls `ensurePrimaryNativeCalendar`, `getMainNativeCalendar` or `hasUsableCalendar`, which write or throw for GOOGLE users.
2. **Legend** = `listVisibleCalendars(user.id, user.pairingId ?? null)` (`event-store.ts:112-124`): own calendars of any privacy plus the ACTIVE partner's `SHARED_*`. With `calendarIds`, intersect with it. Calendar ids never come from the client.
3. No legend calendars → no items (parity with `native-provider.ts:237-238`).
4. **Rows** = `fetchViewerItems` (today's `fetchForViewer`): legend rows, plus the ACTIVE partner's reminders for the viewer on any calendar, deduped and sorted, with reminder states in one query.
5. **ReadItem:**
   - `event`: the provider's event unchanged;
   - `seriesId`: the series id;
   - `originalStart`: the instance's `instanceStartsAt` (one-offs included);
   - `recurring`: `rrule != null`;
   - `rrule`: the series rrule;
   - `kind`: from the series;
   - `state`: `{doneAt, snoozedUntil}`.
6. **CalendarRef:**
   - A legend calendar → its id, name, colour, `mine`, and the partner's name when not mine.
   - A row on a calendar not in the legend (the partner's PRIVATE calendar) → **masked**: `{id: null, name: partner.name, color: null, mine: false, inLegend: false}`.
   - `event.calendarName` keeps the real name for the summary prompt, as today. The DTO never reads it.
7. `partner` = `ctx.partner ? { name: ctx.partner.name } : null`.
8. A thrown error → `{ status: 'error', cause }`.

| Viewer | FamCal half |
|---|---|
| FamCal user, solo or pairing not ACTIVE | Own calendars |
| FamCal user + FamCal partner | Own + partner's shared; partner's reminders-for-me from private calendars, masked |
| FamCal user + Google partner | Own calendars (the partner's are soft-deleted) |
| Google user, paired or not | Absent (Ruling R3) |
| Partner suspended | Visible (Ruling R4) |
| Viewer suspended | Route 403; summary skipped, as today |

### 2.5 Google half

Applies only when `calendarSource === 'GOOGLE'`. The calendar set is `user.calendarAssignments ?? []` (intersected with `calendarIds` when given).

1. **Empty token** → `reconnect('token')`, no Google call. (The summary adapter returns `[]` here instead, for parity with `google-provider.ts:54, :60`.)
2. **No assignments** → `ok` with no items. The home shows the existing "choose calendars" card.
3. **Cache** (route only, §2.6).
4. **Auth and lists:**
   ```ts
   const auth = getGoogleAuth(token);
   await auth.getAccessToken();                      // inside the deadline: one outcome for a dead token or a stuck token server
   const cal = googleCalendar({ version: 'v3', auth });
   // per calendar, in parallel (Promise.allSettled):
   cal.events.list({
     calendarId, timeMin: from.toISOString(), timeMax: to.toISOString(),
     singleEvents: true, orderBy: 'startTime', timeZone: tz,
     maxResults: 2500, maxAttendees: 1, pageToken,
     fields: 'summary,nextPageToken,items(id,status,summary,description,location,start,end,recurringEventId,originalStartTime,eventType,attendees(self,responseStatus),htmlLink)',
   }, { timeout: Math.min(10_000, deadlineMs - 500), retryConfig: { retry: 1, noResponseRetries: 0 } });
   ```
   - `timeZone` is the user's (not the hardcoded `TIMEZONE` of `calendar.ts:466`).
   - The top-level `summary` is the calendar's title, so the per-calendar `calendars.get` goes. If it is missing, use the calendar id, as `calendar.ts:113` does.
   - **Paging:** follow `nextPageToken` until done, the deadline, or 5,000 items for that calendar. Google may return short or empty pages before the end, so the cap is on items, not pages.
5. **Filter** `keepGoogleEvent(raw)`. Drop:
   - `status === 'cancelled'`;
   - no `start`;
   - `eventType` in {`workingLocation`, `outOfOffice`, `focusTime`};
   - any attendee with `self && responseStatus === 'declined'`.

   Keep everything else (Ruling R1).
6. **Map** `mapGoogleEvent(raw, calendarId, calendarName)`:
   - `event`: today's day mapper (`calendar.ts:116-134`) plus `provider: 'google'` (as `google-provider.ts` adds), minus `reminders`, with `description = htmlToText(description) || undefined`;
   - `title`: raw `summary ?? null`;
   - `seriesId`: `recurringEventId ?? null`;
   - `originalStart`: `originalStartTime.dateTime ?? .date ?? null`;
   - `rrule`: null;
   - `google`: `{ birthday: eventType === 'birthday', htmlLink }`.
7. **CalendarRef**, joined from the assignment at read time and never cached:
   - name and saved colour (or null);
   - `mine: !labels.includes('spouse')`;
   - `ownerName`: the `personName` of a spouse calendar;
   - `unavailable` when the id is in `goneIds`.

   Per-event `colorId` is ignored in step 1.
8. **`htmlToText(s, 500)`:**
   - `<br>`, `</p>`, `</li>` and `</div>` become a newline; `<li>` becomes "• ";
   - `<a href=u>t</a>` becomes `t (u)` when t ≠ u, else `u`;
   - other tags are stripped; named and numeric entities are decoded;
   - runs of blank lines collapse; the result is cut at 500 code points.

   Plain text passes through unchanged.

**Error classifier** `classifyGoogleError(e)`, pure. The old `isTokenError` (`src/utils/errors.ts:46-66`) stays for every other path.

| Order | Condition | Outcome |
|---|---|---|
| 1 | `isInsufficientScopesError(e)` (`errors.ts:30-44`) | `scopes` |
| 2 | `response.data.error` is `invalid_grant` or `admin_policy_enforced`, or HTTP 401 | `token` |
| 3 | `response.data.error` is `invalid_client` or `unauthorized_client` | `config` |
| 4 | HTTP 404 or 410 | `gone` |
| 5 | Any of: a 403 with reason `rateLimitExceeded` / `userRateLimitExceeded` / `quotaExceeded` / `dailyLimitExceeded`; 408; 429; ≥ 500; no response and a string `code`; no response and `error.type === 'request-timeout'`; `name === 'AbortError'` | `transient` |
| 6 | anything else | `unknown` |

**Source status:**
1. If the token step fails, its class decides the whole half:
   - `scopes` → `reconnect('scopes')`;
   - `token` → `reconnect('token')`;
   - anything else → `error(<that class>)`.

   No calendar is listed.
2. Otherwise, any calendar `scopes` → `reconnect('scopes')`; else any `token` → `reconnect('token')`.
3. At least one assignment and **every** calendar `gone` → `error('calendars_gone')`.
4. Every calendar that isn't gone failed → `error`, with the first failure's class.
5. Otherwise `ok`:
   - `goneIds` lists the gone calendars;
   - `partial = {failed, truncated}` when either is non-zero.
6. Logging:
   - failed calendars: `captureError(err, 'calendar-read-google', { user_id }, 'warning')`;
   - gone calendars: a Sentry warning at most once per user per day (`gcalGoneWarned(userId)`, `EX 86400`);
   - `config`: `captureError` at level error, plus one `notifyAdminError` per hour (`gcalConfigAlert`, `SET NX EX 3600`). A wrong server secret breaks every user.

**Deadline:** one timer (`deadlineMs`) covers the token step, the lists and paging. When it fires:
- calendars that already settled keep their outcome;
- a calendar that has received at least one page counts as **truncated**;
- a calendar with no page yet counts as failed (`transient`).

The status is then computed as above. Only when the token step hasn't finished, or no calendar settled, is the result `error('timeout')`. The single-flight entry always settles and is deleted in `finally`.

**Token refresh:** the library refreshes from the refresh token; nothing is saved back (Google does not rotate refresh tokens). No access-token cache in step 1.

### 2.6 Google cache (route only)

- **Key:** `gcal:range:v1:{userId}:{setHash}:{tz}:{from}:{to}`.
  - `setHash` = the first 16 hex characters of sha256 over the sorted calendar ids (ids are often email addresses).
  - A calendar re-selection changes the hash, so it needs no invalidation.
- **Value:** `{ startedAt, items, goneIds }` (ReadItems without `calendar`). Values over 512 KB are not written.
- **Freshness:**
  - under 3 minutes old: served as is;
  - 3 to 30 minutes old: served with `stale: true`, and a background refresh starts (single-flight) in `after()` from `next/server`, with its own `.catch` and a 6,000 ms deadline. The client asks again about 3 s later (§5);
  - entries expire after 30 minutes (`EX 1800`).
- **Stamp** `gcal:stamp:{userId}` = `Date.now()`, `EX 3600`, longer than any entry lives.
  - An entry is valid only if `startedAt > stamp`.
  - `startedAt` is taken before the Google call, so a fetch that starts before a bot write and lands after it is never served.
- **Who stamps:**
  - `stampGoogleCache`, after every Google write in `google-provider.ts`. Every bot write goes through it, including `'primary'` and "this and following" edits;
  - `commitGoogleToken`, because a reconnect may be a different account;
  - any read that ends in `reconnect` or `error('calendars_gone')`, so a stale entry never hides a dead token or revoked access.
- **`stampGoogleCache` never throws or rejects.**
  - It uses a separate Upstash client with retries off, is raced against 750 ms, catches everything and records a warning.
  - It is awaited after the write's result is computed, not in a bare `finally`, so it can never replace a write's result. A lost stamp means at worst 3 minutes of pre-write data on the home.
  - It also drops the user's §8.3 recurrence-cache entries.
- **Read:** one `MGET [stamp, key]`.
- **Write:** only `ok` results whose `partial` is null. Gone calendars don't block the write.
  - A read writes only when no read of the same key with a later `startedAt` is in flight.
- **Single-flight:** `globalThis.__gcalInflight: Map<key, { startedAt, promise }>`, because the scheduler and the routes are separate bundles.
  - A request joins an in-flight read only if that read's `startedAt > stamp`.
  - `refresh` joins only a read that started after the request arrived.
- **`fresh=1`** is honoured at most once per 30 s per user (`gcalFresh(userId)`, `SET NX EX 30`); otherwise it is read as `use`.
- **Redis errors** fail open: treated as a miss, no write, a warning.
- **Privacy:** Google titles and descriptions sit in Upstash for at most 30 minutes. Redis already holds decrypted refresh tokens in the reminder cache.
- The summaries never read or write the cache.

---

## 3. Summaries on the reader

### 3.1 Call sites and error seams

All of this applies only to users with `await isCalendarHomeOn(user)`.

1. **Fetch wrappers** (`summary.ts:11-14`):
   - Scheduled and on-demand runs get separate wrappers. Today one wrapper serves both (`:532, :655, :671, :687`).
   - Both call `readDigestDay(user, offset, tz, ids, mode)` with `mode: 'scheduled' | 'onDemand'`.
   - Users the switch doesn't cover keep `getProviderForUser(user).fetch…`.
2. **Week block, `/week`, `/nextweek`** (`src/services/week-lookahead.ts`):
   - `getWeekLookahead` and `getNextWeekLookahead` compute `homeOn` once and pass it, with the mode, to `fetchEventsInRange` (`:202`).
   - Its first line becomes `if (homeOn) return readLookaheadEvents(user, start, end, timezone, calendarIds, mode)`.
   - This covers `/week` (`commands.ts:571-574`), `/nextweek` (`:672-675`) and the tomorrow summary's week block (`summary.ts:147-160`).
3. **Week boundaries** take a `weekStart` (§6).
4. **On-demand daily and tomorrow** (`sendSummaryToUser`'s `onError`, `summary.ts:297-334`): a new branch for `GOOGLE_FETCH_FAILED`.
   - When the first attempt failed in under 5 s, re-run once after about 1 s with the 8,000 ms deadline.
   - If it fails again, or the first attempt timed out: R13's text, return `true`, no admin notice.
   - Token and scopes branches unchanged.
5. **`/week` and `/nextweek`** (`commands.ts:553-595, :654-692`): a new `onError`.
   - `GOOGLE_TOKEN_EXPIRED` and `GOOGLE_INSUFFICIENT_SCOPES` are answered as `sendSummaryToUser` answers them, including clearing the token on scopes.
   - `GOOGLE_FETCH_FAILED` gets R13's text, returning `true`.
6. **Scheduled** (`sendSummaryToAll`, `summary.ts:389-505`), C5:
   1. A user whose read throws `GOOGLE_FETCH_FAILED` is set aside, with the summary day of that first attempt, and the loop moves on.
   2. After the loop, wait until 30 s have passed since the first such failure.
   3. Retry the set-aside users once, in order, each with the 15,000 ms deadline and their original summary day passed in (not recomputed).
   4. If a retry fails, run `prepareSummaryForUser(user, fetch, date, { googleUnavailable: true })`. That uses `[]` for the Google day, sets `SummaryUserContext.googleUnavailable` (the guideline line), appends the localized outage line to the delivered text (and the voice text), and sets the dedup mark.
7. **`calendars_gone`** (Ruling R18): the adapters return `[]` for Google and send a Sentry warning. No retry, no outage line.

**Adapters** (`digest.ts`):
- `readDigestDay(user, offset, tz, ids, mode)`:
  - an empty-token Google user → `[]`;
  - otherwise `readRange(user, day, nextDate(day), { tz, calendarIds: ids, googleCache: 'bypass', deadlineMs })`, then `throwForDigest`, then `items.map(i => i.event)`.
- `readLookaheadEvents(user, start, end, tz, ids, mode)`: the same, with `notBefore: start`.
- `throwForDigest`:

  | Read result | Result |
  |---|---|
  | FamCal error | rethrow the cause |
  | `reconnect('scopes')` | `GOOGLE_INSUFFICIENT_SCOPES` |
  | `reconnect('token')` | `GOOGLE_TOKEN_EXPIRED` |
  | `error('calendars_gone')` | `[]` plus a warning |
  | any other `error` | `GOOGLE_FETCH_FAILED` |
  | `ok` (with or without `partial`) | continue with what loaded, as today |

### 3.2 What must not change

Appendix A lists 33 behaviours. The core of it:
- A summary reads only the user's own source, over exactly the calendars it reads today, with raw `calendarId` and the real `calendarName`. The categorizer and the `[Calendar: Name]` child detection depend on both.
- Day and range rules stay: the summary day comes from `resolveUserTimezone`, membership from `daySpanOf` (including the 06:00 rule), and This week starts at the current instant.
- Birthdays are kept. Text sanitizing, ordering, "None" and the canned empty-week texts are unchanged.
- Reminders:
  - done ones are dropped from the summary day; open marks stay;
  - carry-overs keep the cap of 5, newest first, with "and N more";
  - the reminders guideline appears only when reminders are present.
- Errors:
  - a dead token still sends no summary, sends the token text (with the refresh button on scheduled runs) and sets no dedup mark;
  - missing scopes still clears the token on demand;
  - one failing calendar still lets the rest through;
  - FamCal/DB errors still produce the pipeline's error texts and admin notice.
- Gating order, quota, voice show and narrator, delivery: unchanged.
- Users the switch doesn't cover get today's outputs, except for the §8 fixes. The week-boundary helpers return today's values for `legacyWeekStart` (tested in §10).

### 3.3 Deliberate changes (switch-covered users; each listed in the PR)

- **C1** Working-location, out-of-office and focus-time blocks disappear from every summary.
- **C2** Invites declined by the calendar's owner disappear.
- **C3** Descriptions reach the prompt as plain text.
- **C4** A Google rate limit, quota error, token-server network failure or `unauthorized_client` no longer says "token expired" or pages the admin per user. `config` pages the admin once an hour instead (§2.5).
- **C5** Outages at send time: the scheduled retry queue and the outage line (§3.1 step 6); on demand, Ruling R13.
- **C6** Weekly Google reads run in parallel, report failures to Sentry, and follow Ruling R14.
- **C7** Week start by country (§6).
- **C8** Items past Google's first 250 per calendar are no longer cut off.

### 3.4 Weekly recurrence lookup

`getMasterEventRecurrence` (`week-lookahead.ts:121-171`) stays: instances don't say whether a series is daily or weekly. Its cache fix is §8.3.

---

## 4. `GET /api/calendar/range`

```
GET /api/calendar/range?user_id=<id>[&from=yyyy-MM-dd&to=yyyy-MM-dd][&sources=famcal|google|famcal,google][&fresh=1]
X-Telegram-Init-Data: <initData>        (or the famcal_session cookie in a browser)
```

1. **Auth:** `requestInitData(request)` (the header only, for a GET), then `verifyUserAuth(request, user_id, initData, calendarRateLimiter, 'calendar-range')`. It answers 400, 401, 403 (suspended), 404 or 429 as today.
2. **Switch:** `if (!(await isCalendarHomeOn(user)))` → 404 `{ error: 'not_enabled' }`.
3. **Facts, computed on the server:**
   - `tz = await resolveUserTimezone(user)`;
   - `today = localDate(now, tz)`;
   - `tzKnown = tzKnownFor(user)`;
   - `weekStart` and `hebrewDates` (§6).
4. **Validation** → 400:
   - `from` and `to` come both or neither, in strict `yyyy-MM-dd` with a round-trip check;
   - `from < to`;
   - `to <= addDaysToDate(from, 42)`, compared as **date strings**, so a 42-day window across a DST change is valid;
   - years within ±5 of `today`;
   - `sources` ⊆ {famcal, google}.

   With neither `from` nor `to`, the window is `[today, today+7)`. An absent `sources` means every applicable source.
5. **Read:** `requested = sources ∩ sourcesFor(user)`, then `readRange(user, from, to, { tz, sources: requested, googleCache: fresh ? 'refresh' : 'use', deadlineMs: 6000 })`.
6. **Carry-overs**, when FamCal was requested, is `ok`, and `from ≤ today < to`:
   - call `fetchOpenReminderItems(user, ctx, openRemindersCutoff(today, tz, now), today, tz, Infinity)`;
   - each carry-over's `CalendarRef` follows the legend rule for rows: masked when not in the legend, and `event.calendarName` is never read;
   - its `originalStart` is the occurrence's `instanceStartsAt`;
   - a failure omits them, with a warning.
7. **Respond** with the DTO and `Cache-Control: private, no-store`. Never serialize the user row: it carries the Google token and the phone number.
8. **Unexpected errors** → 500 and `captureError(err, 'calendar-range', { user_id: user.id })`, with no titles in the context.

**DTO** (`src/lib/calendar-view/types.ts`):
```ts
export type DayKey = string;
export type SourceName = 'famcal' | 'google';

export interface RangeResponse {
  tz: string; today: DayKey; weekStart: 0|1|2|3|4|5|6; hebrewDates: boolean;
  from: DayKey; to: DayKey;
  sources: {
    famcal?: { status: 'ok' | 'pending' | 'error' };
    google?: { status: 'ok' | 'pending' | 'reconnect' | 'error';
               reason?: 'token' | 'scopes' | 'calendars_gone' | 'transient' | 'timeout' | 'config' | 'unknown';
               partial?: { failed: number; truncated: number }; stale?: boolean };
  };
  partner: { name: string } | null;
  calendars: CalendarDTO[];                       // legend for the requested sources
  days: { date: DayKey; items: ItemDTO[] }[];     // every day in [from, to), empty ones included, sorted with compareItems
  carryOvers?: ItemDTO[];                         // newest first
}
export interface CalendarDTO { id: string; source: SourceName; name: string; color: string | null; mine: boolean; ownerName?: string; unavailable?: boolean }
export interface ItemDTO {
  key: string; source: SourceName; readOnly: boolean;
  id: string; seriesId: string | null; originalStart: string | null;
  kind: 'event' | 'reminder'; title: string | null;
  start: string; end: string; allDay: boolean; tz: string | null; recurring: boolean; repeatsDaily: boolean;
  span: 'endsLater' | 'continues' | 'spansDay' | null;
  calendar: { id: string | null; name: string; color: string | null; mine: boolean; ownerName?: string; inLegend: boolean };
  location: string | null; description: string | null;
  reminder?: { done: boolean; doneAt: string | null; snoozedUntil: string | null; open: boolean; openSince: string | null;
               ownerIsViewer: boolean; creatorIsViewer: boolean; ownerName?: string; creatorName?: string };
  birthday?: boolean; htmlLink?: string | null;
}
export function compareItems(a: ItemDTO, b: ItemDTO): number;   // all-day first, then start instant, end, FamCal before Google, title
```

**Field sources:**

| Field | Value |
|---|---|
| `id` | `event.eventId` |
| `readOnly` | `source === 'google'` |
| `tz` | `event.timeZone ?? null` (FamCal only) |
| `repeatsDaily` | `kind === 'reminder' && /FREQ=DAILY/.test(rrule ?? '')` |
| `span` | that day's `daySpanOf` |
| `reminder.openSince` | the carry-over's `openSince`; null elsewhere |
| `CalendarDTO.unavailable` | `goneIds.includes(id)` |

**Rules:**
- **`sources`** lists only the sources that **apply** to the user.
  - A requested source carries its status; an applicable one that wasn't requested is `pending`.
  - A FamCal user never gets a `google` key, so can never be shown "Reconnect Google". That flow would switch them to Google and hide their calendars.
- **Reminder state:**
  - done items are kept, with `doneAt`;
  - `open` only in the `today` bucket: `kind === 'reminder' && !doneAt && reminderDueAt(event, tz) < now`;
  - snoozed still counts as open, with `snoozedUntil`;
  - past days are never "open".
- **Times:**
  - FamCal timed values are UTC ISO;
  - Google timed values are RFC 3339 with the user's offset;
  - all-day values are `yyyy-MM-dd` with an exclusive end.
- **Smoke:** add the route to `scripts/smoke-initdata-header.ts` CASES, with `execute-command` as a POST case.

---

## 5. Client data flow and states

**Loading.** PageGate loads page-data as today. When the dashboard props carry `calendarHome: true`, PageGate renders `CalendarHome`. On mount it sends one range request per applicable source (from `calendarSource`), in parallel, with no dates. Each response carries the facts, so whichever answers first paints. In step 1 that is one request. Users the switch doesn't cover make no range call.

**Month windows.** Each month's own days, `[1st, 1st of next month)`, are fetched when the month is on screen or next to it (IntersectionObserver, as `AdminPanelClient.tsx:628-644`). At most 2 requests are in flight, deduped by `YYYY-MM` and source.

**The store.** One client store of days is shared by Agenda and Month.
- A response **replaces**, for each source whose status in it is `ok`, that source's items on every day in its `[from, to)`. Other days, and sources with any other status, keep what they had.
- Within a day, items are deduped by `key` and sorted with `compareItems`. A multi-day item has one entry on each of its days.

**Pinned facts.** The client pins `tz`, `today` and `weekStart` from the first response. Any later response with different values drops the store and starts over. A timer at the next local midnight in `tz` does the same.

**Freshness.**
- Refetch the visible windows on every return to the foreground (`visibilitychange`, Telegram `activated`). That's cheap: FamCal is one query, and a Google cache hit is one `MGET`.
- A response with `google.stale` triggers one re-request after about 3 s.
- ⋯ → Refresh sends `fresh=1`.
- No pull-to-refresh: in Telegram that gesture minimizes the app.

**Empty means answered.** "Nothing planned", the fold lines and free-looking Month cells appear for a day only once every applicable source has answered for it (`ok`, partial, or an error state). Until then the day shows placeholders.

**States**

| Situation | Shown |
|---|---|
| Loading, or a source still `pending` | Placeholder rows; a loading month shows a loading state, never free days |
| Google `partial.failed` or `partial.truncated` | "Some calendars didn't load · Retry" (Agenda and Month) |
| Some Google calendars `unavailable` | "N calendars aren't available · Choose again" → the existing select-calendars page |
| Google `error` (`transient`, `timeout`, `config`, `unknown`) | "Couldn't load Google · Retry", plus one automatic retry after about 5 s |
| Google `error('calendars_gone')` | "Your calendars aren't available · Choose again" → select-calendars |
| Google `reconnect` | A "Reconnect Google" banner → the existing `/refresh-token` flow. For `scopes`, the copy says FamCal needs permission to read the calendar |
| FamCal `error` | "Couldn't load your calendar · Retry" |
| 429, or the limiter's Redis down | "Busy, try again in a minute" |
| 404 `not_enabled` (the switch was turned back) | Reload once; PageGate then renders today's dashboard |
| Any other 404, or 401 / 403 | The existing `NoCredentialCard`, as PageGate does |
| Unexpected / 500 | Retry card |
| A month failed | That month shows "Couldn't load · Retry"; it never looks free |

An error boundary wraps the home; a chunk-load error reloads once.

---

## 6. Week start and Hebrew dates

`src/utils/locale-rules.ts` (pure, server-only by import discipline; the client receives a number and a boolean):

```ts
type Facts = { culture?: string; language?: string; tz: string; tzKnown: boolean };
export function tzKnownFor(u: { location?: string | null; googleRefreshToken?: string | null }): boolean;  // !!location || !!googleRefreshToken
export function weekStartFor(f: Facts): 0|1|2|3|4|5|6;     // 0 = Sunday
export function legacyWeekStart(culture?: string): 0 | 1;   // today's rule: jewish → 0, else 1
export function hebrewDatesFor(f: Facts): boolean;
```

**`weekStartFor`**, in order:
1. `culture === 'jewish'` → 0.
2. If `tzKnown` and the timezone is a country zone (not `Etc/*`, `UTC` or `GMT`, and accepted by `Intl`): `NON_MONDAY_ZONES[tz] ?? NON_MONDAY_ZONES[canon(tz)] ?? 1`. `canon` is `Intl.DateTimeFormat(...).resolvedOptions().timeZone`, in a try.
3. Language: `he` → 0, `en` → 0, `ru` → 1 (Ruling R15).
4. Otherwise 1.

**`NON_MONDAY_ZONES`** (`src/config/week-start-zones.ts`):
- **Source:** generated once from `zone.tab` and CLDR 48 `weekData.firstDay`. About 160 zones map to 0 (Sunday), 6 (Saturday) or 5 (Friday). Both spellings of renamed zones are included (e.g. `Asia/Calcutta` and `Asia/Kolkata`). Header: "generated; do not edit".
- **Coverage:**

  | Week starts | Countries |
  |---|---|
  | Sunday | Israel, the US, Canada, Brazil, India, Japan, Saudi Arabia and others |
  | Saturday | 14 countries, including Egypt, Iran, Iraq, Jordan, Kuwait and Qatar |
  | Friday | the Maldives |
  | Monday | everywhere else |

- `Intl.Locale` week info is not used at runtime: production Node 22 and newer Node expose different APIs.

**`hebrewDatesFor`** = `culture === 'jewish' || language === 'he' || (tzKnown && ISRAEL_ZONES.has(tz))`, with `ISRAEL_ZONES = {'Asia/Jerusalem', 'Asia/Tel_Aviv', 'Israel'}`. Comparisons are strict, because culture and language are not validated on save.

**Where they apply**
- **Home:** the Month grid's columns and weekday row; Hebrew dates in the header, the Agenda day labels and the Month cells.
- **Bot**, for switch-covered users:
  - `getNextWeekBoundary(weekStart, always7, today)` replaces `week-lookahead.ts:80-99`, with `daysUntilBoundary = always7 ? 7 : ((((ws + 6) % 7) - dow) + 7) % 7`;
  - `getNextWeekBoundaries(weekStart, today)` replaces `:435-451`, with a first day `((ws - dow + 7) % 7) || 7`;
  - callers compute `ws = homeOn ? weekStartFor(...) : legacyWeekStart(user.culture)`. For ws 0 and 1 the formulas give today's results on every weekday.
- **Not adopted now:** the Settings day-picker order, voice "next week", the extraction prompts, RRULE `WKST`. Bot Hebrew dates and holidays: Ruling R16.

**Known effects:**
- Default-culture users in Sunday countries move to Sunday–Saturday weeks once the switch reaches them.
- Today's dashboard shows Hebrew dates to everyone. Under the rule, English or Russian speakers outside Israel without Jewish culture won't see them.

---

## 7. Screens

### 7.1 Shell

- **`/dashboard`:**
  - page-data adds `calendarHome: await isCalendarHomeOn(user)` and, when true, calls `trackActivityAsync(user.id, 'webapp_opened')` once per open;
  - PageGate renders `CalendarHome` when it is true, otherwise today's `DashboardClient`, which stays as the fallback;
  - `LOOK.dashboard` stays `'telegram'` for the loader, and `CalendarHome` applies its look on mount;
  - `PRELOAD.dashboard` preloads both chunks.
- **Files:**
  - `app/[locale]/dashboard/CalendarHome.tsx`: the container (SDK calls, data store, tabs);
  - presentational `AgendaView`, `MonthView`, `MonthGrid`, `DayList`, `ItemRow`, `ItemSheet`, `SendSheet`, `MenuSheet`;
  - pure helpers in `src/lib/calendar-view/`: `grid.ts` (`grid(firstKey, lastKey, weekStart) → dayKey[][]`, date-fns only), `hebrew-date.ts`, `agenda.ts`.
- **State:**
  - Tabs and the Month layout are in-page React state. Navigating with `router.push` would remount PageGate and refetch.
  - The last tab is kept in `sessionStorage`. Month state survives tab switches for the session.
  - All storage access is wrapped in try/catch.
- **Look:**
  - Telegram theme tokens are mapped onto the `globals.css` tokens, with fallbacks;
  - dark mode follows `colorScheme` and `themeChanged`, and `prefers-color-scheme` in a browser;
  - on mount: `setHeaderColor('bg_color')` / `setBackgroundColor('bg_color')`, gated with `isVersionAtLeast`;
  - not `TelegramLayout`.
- **Layout:**
  - document-level scroll, with no inner scroller;
  - `min-height: var(--tg-viewport-stable-height, 100dvh)`;
  - safe areas from `--tg-safe-area-inset-*` plus `--tg-content-safe-area-inset-*` (Bot API 8.0), with 0 fallbacks;
  - a 16 px side gutter;
  - no ancestor of the Month tab uses `overflow: hidden` (use `overflow-x: clip`), so sticky keeps working.
- **Zoom** stays locked (`app/[locale]/layout.tsx:13-14`). Minimum text size on the home: 11 px.
- **Direction:**
  - logical CSS properties only;
  - `<bdi>` / `dir="auto"` on titles and names, `dir="ltr"` on times and digits;
  - directional icons flipped in RTL with `scaleX(-1)`.
- **Times:**
  - formatted with `Intl`, `timeZone: tz` and `hourCycle: 'h23'`;
  - "Times in <zone>" shows only when the device timezone differs.

### 7.2 Header, send sheet, menu, banners

- **Header:** "Thursday, 15 October" and, when `hebrewDates`, "4 Cheshvan 5787", from the server's `today`.
- **Send icon** → a sheet with Today, Tomorrow, This week, Next week and Weather.
  - It goes through `src/lib/command-client.ts`, which sends the init-data header and the body fallback, checks `res.status`, and closes the app only per Ruling R5.
- **⋯ menu:** Ruling R6. Refresh sends `fresh=1`.
- **Banners**, non-blocking and stacked under the header:
  - trial days left, during a trial;
  - "Set your location for the right times", when no location is set;
  - the existing Google setup card, when a Google user has no calendars chosen;
  - Reconnect Google (§5);
  - in a browser, "Open FamCal in Telegram".
- FamCal users never see a renew-token or select-calendars entry on the home.

### 7.3 Agenda (landing tab)

- **Still open:** a card with past-due reminders: today's open ones and carry-overs.
  - It shows 5, then "N more".
  - Each shows "since <day>", and who set it when that wasn't the viewer.
- **Days:** today and the next 6 days (Ruling R8).
  - The day header is "Today", "Tomorrow", or the weekday and date, plus the Hebrew date when on.
  - Later empty days fold into one line, e.g. "Nothing planned Sat 17 – Sun 18 Oct", but only once answered (§5).
  - "Show next week" adds 7 days.
- **Rows:**
  - the time, or "All day"; spans get "until …" or "continues";
  - the title;
  - a meta line: location or note, the person chip (Ruling R7), and "Google · <calendar>" for Google items.
- **Reminder icons:**
  - open: an open circle;
  - done: a check, with the title struck through;
  - snoozed: an open circle and a small "until <time>" badge;
  - later: a bell.
- **Whose an item is:**
  - a reminder goes by `reminder.ownerIsViewer`, the same rule as the summary categorizer (`summary.ts:52-55`);
  - an event goes by `calendar.mine`;
  - this decides filled or outlined chips, filled or ring dots, the person chip and a cell's "N from <partner>" label;
  - a reminder the viewer set for the partner reads "for <partner>"; one the partner set reads "from <partner>".
- **Empty:** Ruling R10. The hint is derived from the `subscription.effectivePlan`, trial and early-adopter fields page-data already sends, with no new plan read:
  - voice, forward and photo need `voice_events`;
  - reminders need Pro;
  - no allowed way → no hint.

### 7.4 Month

**Browse** (default):
- **Months:** stacked vertically, each with an `h2` title and, when on, the Hebrew months it touches (§7.8). Month titles get `scroll-margin-top` equal to the sticky bar's height.
- **Sticky bar:** shows the month in view, plus a Today button when today's month is off screen, with the weekday row under it.
  - Its top is `var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px)`.
- **Cells:** about 92 px tall; the grid is full-bleed within the gutter (about 54 px wide). Each cell shows:
  - the Gregorian day;
  - the Hebrew day, with the month name on Hebrew day 1 and on the month's first cell;
  - up to 3 title chips (2 at 360 px or narrower), then "+N";
  - an empty line kept for holidays (sub-project 4).
- **Chips:** one line with an ellipsis and `dir="auto"`.
  - Multi-day items are bars across days, placed first; the title shows on the first day and at each week-row start.
  - Whose an item is (§7.3) decides filled or outlined.
  - Daily-repeating reminders are not drawn (Ruling R11).
- **Window:** 12 months back to 18 months ahead, rendered with known heights.
  - It opens scrolled to today's month, with half a week row of the previous month showing.
  - Opening partway down also keeps `scrollY > 0`, which avoids Telegram's swipe-to-minimize on clients without `disableVerticalSwipes`.
- **Fetching:** per month (Ruling R12), as months come near the viewport.

**Tap a day → picked:**
- **Compact month:** only that month stays, with 46–48 px cells showing dots (filled or ring) and "+N". The grid's height follows its row count, so the list starts above the fold.
- **Bar:** "All months" (a back chevron) and a Today pill.
- **Nav:** previous/next chevrons, disabled at the window's ends. Changing month selects the 1st, or today in today's month.
- **Below:** the day header ("Today · …" when it is today) and that day's rows, the same rows as the Agenda. "Nothing planned" shows when the day is empty and answered.
  - The list ends with `padding-bottom: var(--tg-safe-area-inset-bottom, 0px)`.
- **Back:** "All months", Telegram's BackButton and Android's back gesture all return to browse, scrolled to the month picked was showing.

**Memory:** the layout (browse or picked) is stored per device under `famcal:monthLayout:v1:{userId}`, in try/catch. A restored picked layout opens on today.

### 7.5 Item details

Tapping any row opens a view-only sheet with:
- the title and time range;
- the calendar, masked for a partner's private calendar;
- the location;
- the description, as plain text;
- whose it is, or who set it;
- the reminder state.

Google items add "Open in Google Calendar", via Telegram `openLink(htmlLink)`.

### 7.6 Telegram integration

- **Types** added to `src/types/telegram-webapp.d.ts`:
  - `isVersionAtLeast(v: string): boolean`;
  - `disableVerticalSwipes()` / `enableVerticalSwipes()`;
  - `onEvent` / `offEvent`;
  - `safeAreaInset` / `contentSafeAreaInset`;
  - the `themeParams.section_*` colours.

  `BackButton` and `openLink` are already typed (`:105-111`, `:62`).
- **Swipes (Bot API 7.7+):**
  - `disableVerticalSwipes()` in browse layout only;
  - `enableVerticalSwipes()` in picked layout, on the Agenda and on unmount;
  - never read `isVerticalSwipesEnabled`: it is wrong after a reload.
- **BackButton (6.1+):** one hook, `useTelegramBackButton(active, onBack)`.
  - It calls `hide()` on mount, because the client keeps the button across reloads.
  - It shows the button only in picked layout and while the item sheet is open.
  - Whenever the button stops being needed, it calls `offClick(handler)` and `hide()`: leaving picked, closing the sheet, a tab switch, a navigation from the ⋯ menu, unmount.
- Every call is gated with `isVersionAtLeast` and wrapped in try/catch. In a browser none of this exists; the in-page buttons do the same jobs.

### 7.7 Accessibility

- **Tabs:** `role="tablist"`.
- **Month cells:**
  - one button per cell, with a translated label, e.g. "Thursday 15 October, 4 Cheshvan, 3 items, 1 from Noa";
  - chips and blank cells are `aria-hidden`;
  - `aria-current="date"` on today, `aria-pressed` on the selected day.
- **Picked layout:**
  - entering it moves focus to the selected day;
  - the picked month title is `aria-live="polite"`.
- **Touch targets:** chevrons, Today and All months are at least 44×44 px, with labels in he/en/ru.
- **Colour:** state is shown by icon or text, never by colour alone, with a contrast floor over the theme's hint colours.
- **Motion:** `prefers-reduced-motion` turns off scroll animation.

### 7.8 Hebrew dates

- **Library:** `src/lib/calendar-view/hebrew-date.ts` on `@hebcal/hdate` (a new direct dependency) and `@hebcal/locales/ru`. No `@hebcal/core` on the home.
- **Dates:** each `HDate` is built from `new Date(y, m - 1, d)` of a day key, never from an instant. Every date is the daytime Hebrew date, with no sunset shift.
- **Per language:**
  - he: gematriya day, month without nikud, gematriya year;
  - en: numeric day and month name;
  - ru: Ruling R9, with a 14-entry genitive list in `messages/ru.json`.
- **Month headers:**
  - show the first and last Hebrew months the Gregorian month touches (one can touch three);
  - the year appears on both sides only when it differs, e.g. "Elul 5786 – Tishrei 5787";
  - the Hebrew text is smaller and muted.

---

## 8. Fixes for everyone (not behind the switch)

Each gets its own before/after smoke and a line in the PR.

1. **Timezone after a location change.**
   - Add `resolveTimezoneForLocation(location): Promise<string | null>` to `src/lib/timezone.ts`: `geocodeLocation` with the existing retry, no cache read, no fallback.
   - In `app/api/settings/route.ts`, when the saved location differs from the stored one, call it and run `redis.set(REDIS_KEYS.userTimezone(id), tz, { ex: 86400 })` only when it returns a zone.
   - Today the old timezone stays for up to 24 h.
2. **A repeating event whose first time moved earlier.**
   - Today a recurring series loads only when `series.startsAt < range.to` (`rangeCandidates`, `event-store.ts:167-181`). Moving the first occurrence before the original start hides it from every view and summary.
   - Widen the recurring candidate: `{ rrule: { not: null }, OR: [{ startsAt: { lt: to } }, { instances: { some: { status: 'OVERRIDE', startsAt: { lt: to } } } }] }`.
   - This also reaches the alert pass and the voice matcher, which share the function.
3. **Weekly recurrence lookup cache** (`week-lookahead.ts:59, :121-171`).
   - Today it caches `null` on any error, forever, under a key with no user. One Google hiccup hides a monthly series from `/week` until the next deploy.
   - Re-key it `${userId}:${calendarId}:${recurringEventId}` in `globalThis.__recurrenceCache` as `{ value, at }`.
   - Successes live 6 h; failures 10 minutes (404/410: 6 h).
   - Each series is looked up once per lookahead run.
   - `stampGoogleCache(userId)` deletes that user's keys. `clearRecurrenceCache()` keeps clearing everything, for the smokes.
4. **Rate-limit buckets.**
   - `verifyUserAuth` keys the limiter on the proved row (`checkRateLimit(rateLimiter, \`u${user.id}\`)`, `api-auth.ts:97`) for every route.
   - Today it keys on the raw `user_id` string, so `'123'`, `'0123'` and the DB id each get their own bucket.

---

## 9. Copy and i18n

- A new `calendarHome` namespace in `messages/{en,he,ru}.json`. It is natural in each language and gender-neutral where it names a person. Counts use ICU plurals ("3 items", "N more").
- `scripts/check-i18n-parity.ts` also checks that ICU arguments match.
- Copy needed:
  - tabs and the header aria-labels;
  - the send sheet and the menu;
  - every state in §5, and the banners;
  - the Agenda fold lines and "Show next week";
  - the Month bar, nav and cell labels;
  - the item sheet;
  - the empty state with its plan-aware hints;
  - the summary outage line and its guideline (C5), and R13's text;
  - the admin rollout control and its 503 note.
- Fix hardcoded English on the surfaces the home touches: the Header aria-labels, "ADMIN", "Free", and the redirect loader's "Loading Dashboard...".

---

## 10. Testing

There's no test runner: these are `npx tsx` smoke scripts.
- They run under `TZ=UTC` and `TZ=Asia/Jerusalem`, plus `Pacific/Kiritimati` for day bucketing.
- Every env name is faked before imports.
- New smokes must type-check, because `next build` checks `scripts/**`.

**`smoke-calendar-read.ts`** (pure):
- `classifyGoogleError` on real error shapes: token-endpoint `invalid_grant`; 401; 403 rate and quota; 403 insufficient permissions; 404; 410; 429; 500; `ECONNRESET`; a network error on a `/token` URL (→ transient); a node-fetch `request-timeout`; `AbortError`; `unauthorized_client`; `invalid_client`.
- `keepGoogleEvent` over every eventType: unknown types kept, birthday kept, cancelled, no start, declined by self, declined by another attendee.
- `htmlToText`: entities, line tags, links, plain text unchanged, the 500 code-point cut with emoji.
- `mapGoogleEvent` equals today's day mapper on non-HTML fixtures, minus `reminders`.
- `toRangeDays` equals `shapeEventsForDay` for every day, on these fixtures:
  - overnight 22:00–02:00, and a sleepover until 10:00;
  - a multi-day all-day event, and an all-day event from New York seen in Israel;
  - a zero-length item at 00:00, and one at 23:59;
  - the IL DST end on 2026-10-25, the US DST end on 2026-11-01, and Chile's midnight DST.

  Also: open only on today; done kept; snoozed open.
- DTO field sources: `repeatsDaily`, `readOnly`, `tz`, and carry-over `originalStart`.
- `weekStartFor` table:
  - Cairo → 6; the Maldives → 5;
  - both Kolkata spellings; `Asia/Tel_Aviv` via `canon`;
  - `Asia/Hebron` → 1; `Etc/UTC` → the language rule; an unknown language → 1;
  - `tzKnown: false`.
- Boundary formulas:
  - equal to the legacy ones for ws 0/1 on every weekday, with and without `lookaheadAlways7Days`;
  - ws 6 and ws 5 give Saturday and Friday weeks.
- `hebrewDatesFor` table.
- On Node ≥ 24, rebuild `NON_MONDAY_ZONES` from `Intl` and diff it with the committed table; otherwise print SKIP.

**`smoke-calendar-read-google.ts`** (fake `@googleapis/calendar` and `getGoogleAuth`, in-memory Redis, frozen clock):
- **Request shape:** `fields`, `maxAttendees: 1`, `singleEvents`, `orderBy`, the user's `timeZone`, the timeout, `retryConfig`, and no `eventTypes`.
- **Paging:** follows pages until done; the 5,000-item cap marks the calendar truncated, and the result is not cached.
- **Outcomes:**
  - one 404 plus one ok → ok with `goneIds`, and it is cached;
  - all 404 → `calendars_gone`, and the user's entries are stamped;
  - scopes on one calendar → `reconnect('scopes')`;
  - `invalid_grant` on the token step → `reconnect('token')`, with no list calls;
  - 500 on all → `error`;
  - 500 on one → `partial.failed: 1`, not cached;
  - `config` → one admin notice per hour.
- **Deadline:**
  - a token server that never answers → `error('timeout')` within the deadline, and the single-flight entry is gone afterwards;
  - one calendar stalls while another answers → ok with `partial.failed: 1`;
  - a calendar mid-paging at the deadline → truncated.
- **Cache:**
  - a hit makes no Google call;
  - 3–30 minutes old → `stale` plus one background refresh;
  - a stale entry whose refresh gets `invalid_grant` → the re-request returns `reconnect`;
  - a stamp after `startedAt` invalidates;
  - a stamp during an in-flight read invalidates it, and new requests don't join it;
  - an older read never overwrites a newer one;
  - two concurrent reads → one list call per calendar;
  - `fresh=1` twice within 30 s → the second is read as `use`;
  - a Redis throw fails open.
- **Stamp:**
  - `stampGoogleCache` runs on every google-provider write, including a failed one;
  - a Redis throw or hang inside it leaves the write's result unchanged within 750 ms, with no unhandled rejection.

**`smoke-calendar-range.ts`** (the route with a real `NextRequest` and `initDataFor`, as `smoke-admin-panel-ssr.ts` does):
- **Status codes:**
  - 401: no header; init data in the query;
  - 403: suspended;
  - 429;
  - 404 with the switch off, and for a non-admin under `ADMINS`;
  - 400: bad date, `from ≥ to`, 43 days, year out of range, unknown source;
  - 200: 42-day windows across 2026-10-25 in Israel and across 2026-11-01 in New York.
- **Default window:** `[today, today+7)` in the user's timezone. At 23:30 UTC an Israeli user gets the Israeli date.
- **Sources:**
  - FamCal user → `famcal: ok`, no `google` key;
  - Google user on `sources=famcal` → no `famcal` key, `google: pending`;
  - Google user on `sources=google` with an empty token → `reconnect`, with no Google call.
- **Privacy:**
  - a partner-private reminder-for-me, in range and as a carry-over, never puts the private calendar's name or id in the JSON;
  - the JSON never contains `googleRefreshToken`, `phone` or `pairingId`;
  - no titles in the `captureError` context;
  - `Cache-Control: private, no-store`.
- **Rate limit:** the bucket is keyed `u<id>`: `'123'` and `'0123'` share it.

**`smoke-digest-reader-parity.ts`** (the before/after check):
1. **Same events:** for each user × timezone × clock fixture, `shapeEventsForDay(old fetch)` equals `shapeEventsForDay(readDigestDay(...))`. Only these are normalized:
   - C1/C2 items removed;
   - C3 descriptions replaced with their `htmlToText`;
   - `reminders` deleted.

   FamCal users must match strictly, with no normalization.
2. **Same prompts:** byte-identical (AI stubbed) for a paired FamCal user with reminders, and for a Google user with yours/spouse/kids/birthday calendars. With `googleUnavailable` unset, prompts are byte-identical to today's.
3. **`/week` and `/nextweek`** with the switch off and on:
   - with `weekStartFor` stubbed to `legacyWeekStart`, the events are equal;
   - with the real rule: New York → Sun–Sat, London → Mon–Sun, Cairo → Sat–Fri, an Israeli default-culture user → Sun–Sat.
4. **Outcomes**, with recording fakes:
   - `invalid_grant` → the token text, the refresh button on scheduled runs, no dedup mark;
   - scopes → the token cleared on demand;
   - a rate-limit 403 on every calendar:
     - scheduled: set aside, one retry, then the summary with the outage line, its guideline and the dedup mark;
     - on demand: R13's text, with no `notifyAdminError`;
     - `/week`: R13's text;
   - a hanging token server on demand → R13's text within 50 s;
   - one 404 → a summary from the rest;
   - all 404 → an empty summary plus a warning.
5. **The batch doesn't wait:** 3 Google users failing plus 1 FamCal user. The FamCal user's delivery doesn't wait for the retries.
6. **Fixtures:**
   - users: FamCal paired (own, partner shared, partner-private reminder-for-me); FamCal solo; Google with labelled calendars; Google still paired (no FamCal items); Google with a dead token; Google missing scopes; Google with one 404;
   - clocks: 07:00, 19:00, 00:30, 2026-10-25, Saturday and Sunday.

**Fixes for everyone (§8):**
- the location save sets the timezone only on a successful lookup;
- the moved-first-occurrence fixture appears in a window that ends before the series start;
- the recurrence cache keeps failures for 10 minutes only, and keys per user;
- one shared rate-limit bucket per user.

**UI smokes:**
- pure `grid`: 5- and 6-row months, every week start;
- `hebrew-date`: Adar I/II in 5787, 29- and 30-day Cheshvan and Kislev, the Tishrei year boundary, a month touching three Hebrew months, Russian genitive;
- `agenda`: folding, today and tomorrow always shown, nothing "empty" before every source answered;
- en/he/ru render of `CalendarHome` with fixture data.

**Existing smokes updated:**
- `smoke-week-lookahead.ts`: the switch-off assertions are kept; switch-on cases add `calendarAssignments` on the fixtures, a top-level `summary` from the fake list, and stubs for the reader's imports, including `getGoogleAuth`;
- `smoke-admin-panel-ssr.ts`: the rollout control, with `'ADMINS'` and a rejected bad value;
- `smoke-page-auth.ts` and `smoke-miniapp-gate.ts`: the dashboard branch;
- `smoke-initdata-header.ts`: the new route, and `execute-command` reading the header.

`smoke-native-provider-reminders.ts` and `smoke-reminders.ts` must pass **unchanged**.

**Live check:** after the switch goes to `ADMINS`, compare the owner's next summaries with the old path's, including the `[Calendar: …]` names.

**Device check, before `ALL`:** an iPhone and an Android phone with gesture navigation, in Telegram.
- Drag down at the top of browse, with swipes off, and on a client older than Bot API 7.7.
- Android back: in picked it goes to browse; in browse it closes.
- The BackButton after a reload in picked, and after opening Settings from the ⋯ menu.
- The sticky bar during momentum scroll and the top bounce.
- Send-to-chat closes on a 2xx and stays open on a 429.
- The Hebrew RTL layout.

**Before main:** type-check, lint, all smoke scripts and `check-i18n-parity`. Then a fresh-clone build, which runs the migration. Then the Railway and Vercel commit status.

---

## 11. Accepted limitations and console checks

- Nobody sees FamCal and Google together in step 1 (Owner decision 2).
- **Users with no location and no Google token** fall back to Asia/Jerusalem with `tzKnown` false, so the language rule decides.
- **A user whose timezone lookup fails** (location or Google settings) gets the cached Asia/Jerusalem fallback for 24 h, with `tzKnown` true. That means Sunday weeks and Hebrew dates until the cache expires.
- **Large UTC-offset gaps:** an all-day item created 24 h or more of UTC offset away from the viewer may land a day off. The summaries have the same gap today.
- **`Asia/Hebron` and `Asia/Gaza`** count as Palestine: Monday weeks and no Israel signal, unless the culture is Jewish.
- **Edits made directly in Google** show on the home within about 3 minutes; bot edits show at once.
- **WhatsApp-only users** see a partner's reminders as open, with no way to tick them. That's acceptable while the home is view-only.
- **Upstash plan** (console check): Free allows 500K commands a month.
  - A range call costs about 4–5 commands: limiter, rollout (memoized 30 s), timezone, cache `MGET`, and a `SET` on a miss.
  - A FamCal call costs about 3.
  - An open makes 1–3 calls.
- **Google OAuth app status** (console check): if it's still in "Testing", refresh tokens expire after 7 days.

---

## Appendix A. Summary regression contract

These are hard requirements for users whose summaries move onto the reader.

| # | Requirement |
|---|---|
| A-1 | Provider fetchers (`calendar.ts`, `native-provider.ts`) keep their behaviour, and all filters live in the reader. The only additions are the `getGoogleAuth` export and the `fetchViewerItems` split. |
| A-2 | A summary reads only the user's own source. A Google user who is still paired sees no FamCal items. |
| A-3 | The Google set is exactly `calendarAssignments`. |
| A-4 | The FamCal set is `listVisibleCalendars`, plus the partner's reminders-for-me on any calendar, deduped. |
| A-5 | `calendarId` stays raw: the Google id or `native:<cuid>`. |
| A-6 | `calendarName` stays the Google calendar title or `NativeCalendar.name`, with no source marker. |
| A-7 | The summary day is `localDate(now, resolveUserTimezone)`; tomorrow is `nextDate`. |
| A-8 | Membership uses overlap plus `daySpanOf`, including the 06:00 rule and DST days. |
| A-9 | Span marks drive "next day", "until … (started …)" and "All day (began …, through …)". |
| A-10 | This week starts at the current instant. Next week is whole days. The tomorrow block lists from tomorrow. |
| A-11 | Birthdays are kept and labelled. Weekly birthdays skip the recurrence filter. |
| A-12 | Weekly drops daily repeats, and weekly ones unless opted in. Each item is listed once, on its start day. |
| A-13 | Text sanitizing and length caps are unchanged. Weekly prompts carry no description or location. |
| A-14 | An empty list gives "None". An empty week gives the canned text, with no AI call. |
| A-15 | Prompt order: the day's items by start, then carry-overs newest first. |
| A-16 | Done reminders are dropped from the summary day. Past-due ones are marked open, and snoozed counts as open. |
| A-17 | Carry-over rules: the cutoff, owner or creator, the latest occurrence per series, a cap of 5, and "and N more". |
| A-18 | Reminders are filed by owner, with today's labels and attribution. |
| A-19 | The reminders guideline appears only when reminders are present. Prompts without reminders, and without `googleUnavailable`, are byte-identical. |
| A-20 | Weekly: reminders are listed and done ones dropped, with no open marks or carry-overs. |
| A-21 | There is no plan gate on reading reminders. |
| A-22 | Spouse section rules: daily, when spouse events exist; weekly, when a spouse calendar exists. |
| A-23 | The kid-name follow-up gets the same "other" events. |
| A-24 | A dead token: no summary; the token text, with the refresh button on scheduled runs; an admin warning; no dedup mark. |
| A-25 | Missing scopes: on demand, the scopes text, the token cleared and an admin warning; on scheduled runs, Sentry only. |
| A-26 | One failing Google calendar: continue with the rest. |
| A-27 | Weekly Google errors are replaced by Ruling R14 (deliberate). |
| A-28 | FamCal/DB errors keep the pipeline's `calendarFetch` / `tomorrowFetch` / `lookaheadFetch` / `nextWeekFetch` texts and the admin notice. A carry-over or week-block failure degrades the summary, never fails it. |
| A-29 | A summary waits for every source. |
| A-30 | Summaries read live data, with no cache. |
| A-31 | Gating order, quota and batch eligibility are unchanged. |
| A-32 | The voice show and the narrator get the same final text. |
| A-33 | Users the switch doesn't cover get today's outputs, except for the §8 fixes and the write-path `stampGoogleCache` (which never changes a write's result). |
