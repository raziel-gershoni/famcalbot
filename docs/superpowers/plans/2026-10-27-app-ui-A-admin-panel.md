# A: the admin panel, redesigned on the shared layer, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** rebuild the admin panel as a drill-down Mini App on `components/app-ui`. It opens on an overview, lists people, gives each person a full profile screen, and confirms every risky action. It fixes the panel's known bugs and loses no admin action.

**Owner direction (2026-10-27):** "build me a user profile opening from admin panel. actually the whole panel could be redesigned in ux terms", and "you can proceed till the bitter end and ping me when you finish everything". This supersedes the spec's "split the file first with no visual change". The risk control that step bought is kept another way: Task 1 lands the data layer and its tests before any screen uses it.

**Architecture:**
- **Task 1:** a typed data layer under `app/[locale]/admin-panel/data/`, built and smoke-tested on its own. It has:
  - one request helper;
  - a hook per area;
  - formatters;
  - the server-side self-ban guard.
- **Task 2:** the kit additions (ListRow, Tag tones), the new panel shell with an in-page view stack driven by AppScreen's back, the Overview screen (counts, app switches with confirms, the reset-all action), and the Activity, Feedback and Blocked screens.
- **Task 3:** the Users list and the User profile. Then the 3474-line `AdminPanelClient.tsx` body, its styled-jsx and the dead keys are deleted.

**Tech Stack:** Next.js 16 client components; inline CSS strings; next-intl; tsx smokes with `scripts/lib/fake-dom.ts` (loud on unknown selectors) and `scripts/lib/fake-markup.ts`.

**Spec:** `docs/superpowers/specs/2026-10-19-screens-and-colours-design.md` §4–§5 (A), and the owner direction above. The research map, with file:line on main 79fc962, is `<S>/admin-research.md`; every section of this plan relies on it.

## Global Constraints

**Security** (unchanged behaviour):
- `page.tsx` keeps passing exactly `{ locale, userId }` and makes no DB call. Its HTML stays identical for every id (smoke-admin-panel-ssr #1).
- The panel loads through `loadAdminPanel` (GET settings + GET stats, with the header). 401/403 gives the denied card.
- Every admin route keeps `verifyAdminAccess`. Route request and response contracts are unchanged, except the one guard in Task 1.
- The panel works only inside Telegram, as today.

**Requests:**
- Every request goes through one helper.
- GETs and DELETEs send `X-Telegram-Init-Data` via `initDataHeaders()`.
- POSTs send the JSON body with `initData: readInitData()` (the 8 POST routes read the body only) plus the header.
- URLs and body fields are exactly today's (`<S>/admin-research.md` §3).

**Ids:**
- Every per-user request uses the DB `User.id` from the list or the profile.
- The page's `userId` prop (a Telegram id) is used only to go back to the calendar.
- Never shadow one with the other. Name them `viewerTelegramId` and `targetUserId`.

**Kit rules** (as W1/W3):
- AppScreen is the only BackButton caller; smoke-app-ui #5's allow-list stays `CalendarsClient`, `AppScreen`, `telegram-ui`.
- Logical CSS. No `:hover`. Font sizes of at least 11 px; targets of at least 44 px.
- No hex outside token blocks. No emoji. Lucide icons.
- New class names must be free; grep first.

**No silent failures:** every request outcome is logged on failure (`console.error('[admin] <action> failed:', …)`) and shown in a Notice in the page's language.

**Copy:**
- Every string comes from the `admin` namespace (or `ui` / `pageGate`), in en/he/ru: natural, gender-neutral Hebrew, formal Russian, ICU plurals.
- No hand `.replace('{days}')`.
- Dead keys are deleted after a grep.
- Brand and technical words stay Latin (Telegram, WhatsApp, Google, Pro, FamCal, Gemini, `DELETE`).

**Times:**
- Dates and times are 24-hour.
- Relative times use `Intl.RelativeTimeFormat(locale, { numeric: 'auto' })`.
- Phones and ids are wrapped in `<bdi dir="ltr">`.

**Gate:** `npx prisma generate && npx tsc --noEmit && npx eslint . && bash scripts/ci-smokes.sh && npx tsx scripts/check-i18n-parity.ts`. Never run a build.

**Tests:** every new check is shown to fail with its fix removed.

## Design (decided by the controller under the owner's direction)

**Navigation:** one page with an in-page view stack, with no new routes.
- Views: `root`, `users`, `user(id)`, `feedback`, `blocked`, `activity`.
- `AppScreen onBack`, Telegram's BackButton and ScreenHeader's in-page back all pop:
  - an open sheet first;
  - then the view;
  - at `root`, `router.push('/{locale}/dashboard?user_id={viewerTelegramId}')`.
- The Users list keeps its search text and filter when you come back from a profile.
- Each view loads its data when it opens. There are no refresh buttons.

**Root, "Admin" (grouped ground):**
1. **Counts card.** A 2×2 grid of four numbers:
   - People;
   - Google connected;
   - Calendars;
   - Still setting up.
   
   Each tile is a button. People and Still setting up open Users (the second filtered to `setup`, if the list data carries setup state; otherwise unfiltered).
   Under the grid is one line: "Setup done: {pct}%" (no NaN at 0 people). The static "Database" health icon goes: a loaded page already proves the database answered.
2. **"People" section:**
   - Users ({count}) ›
   - Feedback ({count}) ›
   - Blocked ({count}) ›
3. **"Activity" section:** Activity ›
4. **"App switches" section:** the 5 SwitchRows, with today's labels and descriptions moved to messages.
   - Early access asks in a sheet in both directions:
     - on: "Everyone gets Pro features until you turn this off.";
     - off: "People without a paid plan lose Pro features now."
   - The other four switch at once.
   - A failure reverts the switch and shows a Notice.
5. **"Setup reminders" section:** a danger row, "Reset everyone still setting up". It asks in a sheet, then shows the result Notice ("{count} people reset", ICU).

**Users:**
- A search TextField (name or Telegram id; `dir="auto"`).
- A ValueRow "Show" with All, Trial, Paid, Free and With overrides (and Still setting up, if the data allows).
- A full-height list of ListRows:
  - **title:** the name;
  - **meta:** a plan line, e.g. "Pro · trial, 9 days left" / "Basic · until 3 Nov" / "Free", plus the platform;
  - **tags:** Suspended (danger), Early access, Overrides (muted);
  - a chevron.
- An empty result shows a plain line, "No one matches".
- Tapping a row opens the profile.

**User profile** (the owner's ask; ScreenHeader title = the person's name):
1. **Who:**
   - tags;
   - rows: Telegram id (LTR, copyable via CopyField), WhatsApp (LTR), language, "Signed up {n} days ago" (ICU).
2. **Plan:**
   - the plan row with a Tag (Trial n days / Paid until date / Free Pro from an admin);
   - Meters for text summaries, voice summaries and calendars, reusing `Meter`;
   - "Give Pro for free" (a reason field in a sheet), or "Stop free Pro" (asks first);
   - when early access is on, a Notice that everyone already has Pro.
3. **Setup:**
   - the progress line with steps done and reminders sent/overdue (ICU);
   - "Send a setup reminder": a sheet to pick the type (today's `reminder_type` options), naming the person. It sends a real message;
   - "Reset setup reminders": asks first.
4. **Feature access:**
   - 5 SwitchRows (unlimited summaries, reminders when the person has Telegram, voice events, unlimited calendars, early adopter);
   - a paid-locked switch is `disabled`, with the note "Included in their plan";
   - a reason TextField;
   - a SaveBar (not sticky), enabled only when something changed;
   - a failure shows a Notice.
5. **Messaging:**
   - the platform row;
   - "Move to WhatsApp…" opens a sheet with an E.164 phone field (LTR) and a confirm. The server's error shows in our copy.
6. **Activity:** 20 rows (action, `activityDetail`, relative time), then "Show more". It has a sequence guard.
7. **Account** (last):
   - Suspend, or Unsuspend (Suspend asks, with an optional reason);
   - Block their Telegram/WhatsApp: a sheet with two SwitchRows, a reason and a confirm;
   - Delete for good: a sheet where the person types DELETE, as the server requires; disabled while working.
   - After a delete: back to Users, where a Notice says "{name} was deleted". No stale notice ever carries over to another person.

**Activity:**
- the action filter as a ValueRow fed by `actionStats`;
- ListRows (user, action, detail, time);
- "Show more" in pages of 20;
- a sequence guard;
- one fetch on open (today it fetches twice).

**Feedback:** ListRows (name, first line, relative time, source Tag). A tap opens a sheet with the full text (`dir="auto"`) and the date. "Show more" when the route returns a full page.

**Blocked:** ListRows (Telegram id and WhatsApp in LTR, reason, date). A tap opens a sheet with "Unblock", which works at once and shows its outcome (today it fails silently).

**Look:**
- AppScreen grouped, ScreenHeader, SectionLabel, FormCard, the kit buttons, Notice, BottomSheet.
- The counts grid is the panel's one screen-specific piece, in `admin-css.ts`, on tokens.
- `startMiniApp('app')` on mount. The purple Telegram colour calls are deleted.

**Denied, error, loading:**
- The denied card becomes `<AppScreen><StateCard tone="crash" …></AppScreen>`, with its two strings from messages. smoke-admin-panel-ssr #6 is updated with the same intent.
- The loader is `PageLoader look="app" ground="grouped"`.
- The error card is today's, in the app look.

## Review Focus
1. **The back stack:**
   - Telegram back closes a sheet first, then profile → users (search and filter kept), sub-screen → root, root → calendar with the locale;
   - nothing double-pops;
   - during a working sheet, back does nothing.
2. **Every risky action asks first** (early access in both directions, reset-all, send reminder, move to WhatsApp, suspend, block, delete, stop free Pro):
   - a cancel sends nothing;
   - a failure shows our message, logs, and leaves the state as it was.
3. **Ids:** every per-user call carries the profile's DB id. The viewer's Telegram id is only in the back URL. Two quick taps on different people never show one person's data under the other's name (sequence guard).
4. **A long profile:** activity "Show more" three times still reaches the Account section, with no clipping. After a delete, the profile is gone and the notice shows once.
5. **Hebrew and dark:**
   - LTR ids and phones; 24-hour dates; Hebrew plurals ("1 day", "2 days");
   - counts and tags readable in dark;
   - no physical CSS;
   - new contrast pairs added.

---

### Task 1: The data layer (no visible change)

**Files:**
- Create, under `app/[locale]/admin-panel/data/`:
  - `types.ts`: today's types, lifted from AdminPanelClient (`UserListItem`, `UserOverrideDetails`, `ActivityItem`, `ActivityStats`, `FeedbackItem`, `BlocklistEntry`, `FilterType` and so on), unchanged in shape;
  - `admin-api.ts`: `adminGet<T>(path, params?)`, `adminPost<T>(path, body)` and `adminDelete<T>(path, params?)`. Each returns `{ ok: true, data } | { ok: false, status, code?: string }`, never throws, and logs failures as `[admin] <path> failed:`. POST puts `initData: readInitData()` in the body and sends the header too;
  - `use-admin-settings.ts`: the 5 flags, one `setFlag(flag, value)` with revert-on-failure, and a `saving` flag per switch;
  - `use-users.ts`: the list (`list=all`), filter and search state (kept across views), `filtered`;
  - `use-user-profile.ts`: `load(targetUserId)` with a sequence guard; the actions `saveOverrides`, `grantComp`, `revokeComp`, `sendReminder`, `resetReminders`, `switchToWhatsApp`, `suspend`, `unsuspend`, `hardDelete`, `ban`; per-user activity paging with a guard. Each action returns an outcome and reloads the profile and the list;
  - `use-activity.ts`, `use-feedback.ts`, `use-blocklist.ts`: paged lists with guards; `unban`;
  - `format.ts`: `relativeTime(iso, locale, now)`, `dateTime24(iso, locale)`, `dateOnly(iso, locale)`, `planLine(user, t)`.
- Modify `app/api/admin/users/blocklist/route.ts`: a ban where `telegramId` or `whatsappPhone` equals the acting admin's own returns 400 `{ error: 'SELF_BAN' }`, as the moderation route does for self-moderation.
- Test:
  - `scripts/smoke-admin-data.ts` (new);
  - extend `smoke-initdata-header` CASES to the POST routes only if the helper's header changes what they accept. It does not; they keep reading the body.

- [ ] **Step 1: Write `scripts/smoke-admin-data.ts`.** Stub fetch and Telegram.
  - **D1:** each helper sends the exact URL, method, header and body for every row of research §3. Deep-equal the bodies. No initData in any URL.
  - **D2:** a 500, a `{success:false}` answer and a throw each give `ok:false` with a log, never a throw.
  - **D3:** `setFlag` reverts on failure.
  - **D4:** the profile `load` sequence guard: two loads, with the first answered last; the second wins.
  - **D5:** the activity paging guard, and one fetch per open.
  - **D6:** every user action carries `targetUserId` (a DB id ≠ the viewer's Telegram id) and reloads both the profile and the list.
  - **D7:** `relativeTime` and `dateTime24` in en/he/ru (24-hour), and plurals.
  - **D8:** the blocklist route returns 400 `SELF_BAN` when an admin bans their own Telegram id or phone. Use the route test harness of `smoke-initdata-header` / `smoke-admin-settings-auth`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** No screen uses these yet.
- [ ] **Step 4: Run** the new smoke, smoke-admin-panel-ssr, smoke-initdata-header and smoke-admin-settings-auth. Expected: PASS.
- [ ] **Step 5: Mutations:**
  - the POST body without initData (D1);
  - a helper that throws (D2);
  - no revert (D3);
  - no sequence guard (D4);
  - the viewer id sent as the target (D6);
  - the self-ban guard removed (D8).
- [ ] **Step 6: Gate, then commit** `feat(admin): a typed data layer for the panel, one request helper, guarded loads; the blocklist refuses an admin's own identifiers`.

### Task 2: Kit additions, the shell, the Overview, Activity, Feedback and Blocked

**Files:**
- Create:
  - `components/app-ui/ListRow.tsx`: `ListRow({ title, meta?, tags?: ReactNode, onClick, describedBy? })` renders `<button class="ch-form-row ch-list-row">` with a title, a meta line (13 px muted), a tag row and a chevron. Its CSS goes in FORM_CSS;
  - `app/[locale]/admin-panel/AdminPanel.tsx`: the shell and view stack;
  - `app/[locale]/admin-panel/views/Overview.tsx`, `ActivityView.tsx`, `FeedbackView.tsx`, `BlockedView.tsx`;
  - `app/[locale]/admin-panel/admin-css.ts`: the counts grid only;
  - `scripts/smoke-admin-render.ts`.
- Modify:
  - `components/app-ui/Tag.tsx`: `tone?: 'accent' | 'danger' | 'muted'` (default accent). New contrast pairs go in `scripts/lib/css-resolve.ts` (danger and muted text on their soft grounds);
  - `app/[locale]/admin-panel/AdminPanelClient.tsx`: keeps `loadAdminPanel`, `AdminUnauthorized` and `AdminPanelLoad` exported (smoke-admin-panel-ssr imports them). Ready renders the new `<AdminPanel>`. Denied and error use the app look;
  - `messages/{en,he,ru}.json`: the `admin` keys these views need;
  - smoke-admin-panel-ssr #6, with the same intent.

**Interfaces:**
- **Consumes:** Task 1's hooks and helper; the kit; `PageLoader` and `startMiniApp` from PageGate.
- **Produces:** the `AdminView` union and `useViewStack()` (`push(view)`, `pop()`, `current`), which Task 3 plugs Users and Profile into.

- [ ] **Step 1: Write `scripts/smoke-admin-render.ts`.** Fake Telegram 7.7 and stubbed fetch; en/he/ru × light/dark.
  - **R1 root:**
    - the counts (tiles are buttons);
    - the setup percentage, with no NaN at 0 people;
    - the People and Activity rows;
    - 5 switches;
    - the reset row;
    - no emoji, no raw key; he/ru carry no Latin outside brand words.
  - **R2 early access:**
    - the switch opens a sheet in both directions; Cancel sends nothing;
    - Confirm posts `{earlyAdoptionMode: v, initData}` once;
    - a failure reverts it and shows a Notice;
    - the other switches post at once.
  - **R3 reset-all:** it asks, posts `{initData, reset_all: true}`, and shows the ICU result.
  - **R4 the back stack:**
    - Activity, Feedback and Blocked push and pop;
    - a sheet closes first;
    - at root, it pushes `/{locale}/dashboard?user_id=<viewer>`;
    - AppScreen is the only BackButton caller.
  - **R5 Activity:** one fetch on open; the filter; Show more; the guard.
  - **R6 Feedback:** the list; a tap opens a sheet with the full text.
  - **R7 Blocked:** the list; Unblock posts, and its failure shows a Notice.
  - **R8:** the denied card in the app look, with translated text; the loader is grouped.
  - **R9:** no React warnings.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Invoke `frontend-design:frontend-design` first. Its direction is this plan's Design section and the kit; there is no new visual language.
- [ ] **Step 4: Run** the new smoke, smoke-admin-panel-ssr, smoke-app-ui (#2 lint over FORM_CSS for ListRow; contrast) and parity. Expected: PASS.
- [ ] **Step 5: Screenshots** into `<S>/a-shots/`: root he light, root en dark, the early-access sheet he dark, Activity ru light, Feedback with the sheet open en light.
- [ ] **Step 6: Mutations:**
  - early access posts without a sheet (R2);
  - no revert (R2);
  - root back without the locale (R4);
  - the double activity fetch put back (R5);
  - unban failing silently (R7).
- [ ] **Step 7: Gate, then commit** `feat(admin): the panel's new shell and overview on the kit, with app switches that ask first, activity, feedback and blocked`.

### Task 3: Users and the User profile; the old panel deleted

**Files:**
- Create:
  - `app/[locale]/admin-panel/views/UsersView.tsx`;
  - `app/[locale]/admin-panel/views/UserProfile.tsx` and its sections (`profile/Who.tsx`, `Plan.tsx`, `Setup.tsx`, `FeatureAccess.tsx`, `Messaging.tsx`, `ProfileActivity.tsx`, `Account.tsx`), plus their sheets.
- Modify:
  - `AdminPanelClient.tsx`: delete the old `AdminPanel` body (310-3474), its styled-jsx and `AdminCard`;
  - `messages/{en,he,ru}.json`: the keys these views need. Delete the 25 dead keys and every key the old body alone read (grep `app components src scripts`). Keep `admin.features.nativeReminders` and `nativeRemindersDescription` (smoke-native-reminder-support).
- Test: extend `scripts/smoke-admin-render.ts`.

- [ ] **Step 1: Extend the render smoke.**
  - **U1 Users:**
    - search by name and by Telegram id;
    - each filter;
    - an empty result line;
    - row meta and tags;
    - search and filter are kept after the profile and back.
  - **U2 profile render** for a trial user, a paid user, a comped user, a WhatsApp-only user (no Reminders switch) and a suspended user:
    - the sections in order;
    - LTR ids;
    - meters;
    - paid-locked switches disabled with the note;
    - the early-access notice.
  - **U3 actions:** each of save overrides, grant and stop free Pro, send reminder, reset reminders, move to WhatsApp, suspend, unsuspend, block and delete:
    - the risky ones ask, and Cancel sends nothing;
    - the body is exact, with the DB id;
    - success reloads the profile and the list;
    - failure shows our Notice and a log.
  - **U4 delete:**
    - the confirm is disabled until DELETE is typed;
    - working disables back;
    - success goes to Users with "{name} was deleted" once;
    - opening another person shows no stale notice.
  - **U5 a long profile:** activity Show more ×3; the Account section is still in the markup, and nothing has `max-height` clipping.
  - **U6 the sequence guard:** tapping A then B quickly shows only B's name and data.
  - **U7:** no file in `app/[locale]/admin-panel/` uses styled-jsx, `:hover`, hex, emoji or physical CSS. The 25 dead keys are gone, and every `admin.*` key is read somewhere.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement, then delete the old body.**
- [ ] **Step 4: Run** the full gate.
- [ ] **Step 5: Screenshots** into `<S>/a-shots/`: Users he light, the profile (trial) he light top and bottom, the profile en dark, the delete sheet ru light, Users after a delete en light.
- [ ] **Step 6: Mutations:**
  - the viewer id sent as the target (U3);
  - the suspend confirm skipped (U3);
  - a stale delete notice (U4);
  - `max-height` clipping put back (U5);
  - no guard (U6).
- [ ] **Step 7: Gate, then commit** `feat(admin): Users and a full profile for each person, every risky action confirmed; the old 3400-line panel is gone`.

## After the build (controller)
- One Opus review, including the he/ru copy, read for natural wording.
- One fix round.
- Mutation spot checks; the fresh-clone CI mirror; push; CI and Railway.
- The spec marks A done, and this plan file is deleted.
- A notification and the memory.
- The owner's phone checks: the overview, a profile, and one harmless action (send a setup reminder to yourself).
