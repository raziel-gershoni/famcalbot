# Menu Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A five-entry ⋯ menu, a Sunset zmanim icon, one compact Google calendars screen holding Reconnect and Disconnect, Plan and Feedback rows in Settings, and Open in Telegram / WhatsApp in the admin profile.

**Architecture:** UI changes in the Mini App's existing screens (Next.js 16 client components drawn with `components/app-ui`), a small shared plan-status helper read by Settings and Subscription, one new page-data notice for a dead Google token, and one new admin route that asks Telegram for a username or sends the admin a mention.

**Tech Stack:** Next.js 16, next-intl (en, he, ru), lucide-react 1.71, node-telegram-bot-api 2.x through `getBot()`, Prisma 7; smokes are `scripts/smoke-*.ts` run with `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-11-24-menu-revamp-design.md`

## Global Constraints

- Run every smoke with the fake env only: `bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/repro/run-env.sh npx tsx scripts/<smoke>.ts`. Never `npm run build` (it migrates prod), never `npm audit fix`, never touch `.env*` or print their values, never call the real Telegram API.
- Gate per task: `npx tsc --noEmit`, `npx eslint <changed files>`, and every smoke that names a file you changed (`grep -l <file or key> scripts/*.ts`).
- Copy lives in `messages/{en,he,ru}.json` only, all three in the same commit. Hebrew is gender-neutral (plural imperative, or infinitive / noun on buttons; never "אתה", never a slash form; `scripts/smoke-he-neutral.ts` checks). Russian is formal. Both read as written natively.
- Lucide icons only, no emoji, no `:hover`, RTL correct (`bdi`, logical properties), light and dark through the existing tokens.
- Every Bot API call goes through `getBot()` (`src/services/telegram/bot.ts`); a failure is read only through `telegramErrorInfo` (`src/lib/telegram-errors.ts`).
- No console line or Sentry field holds a name, a username, message text, a phone or a token; log user ids and outcomes only.
- `user.id` (database id) and `telegramId` keep their roles; never swap them.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
  ```
- Commit on `main` locally; do not push.

## Review Focus

1. A Google token that Google refuses (`classifyGoogleError` → `token`): the Google screen must show the Reconnect card with Disconnect under it, never the generic retry card (Task 3 pins it in page-data and in the screen smoke).
2. A hidden Google calendar row: its whole row is the switch and nothing opens a details sheet for it; a shown row's text opens details and its switch only toggles (Task 3 pins both, and that the two controls are sibling buttons, not nested).
3. Subscription or Feedback opened from a bot button (no `from`): Back still goes to the home; with `from=settings` it goes to Settings (Task 2 pins both).
4. An admin profile with no `telegramId` (a web-only account): no Open in Telegram button; the route answers 404 for it and never calls Telegram (Task 4 pins both).
5. A user name with `<`, `&` or quotes in the admin mention message: HTML-escaped in the sent text (Task 4 pins it).

---

### Task 1: Sunset zmanim icon and the five-entry menu

**Files:**
- Modify: `app/[locale]/(app)/dashboard/HomeHeader.tsx` (drop `SunIcon`, the zmanim button renders lucide `Sunset`)
- Modify: `app/[locale]/(app)/dashboard/MenuSheet.tsx`
- Modify: `app/[locale]/(app)/dashboard/CalendarHome.tsx` (its `MenuSheet` / `menuEntries` call)
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (remove `calendarHome.menu.connectGoogle`, `.chooseCalendars`, `.reconnectGoogle`, `.subscription`, `.feedback` once a grep shows nothing else reads them)
- Test: `scripts/smoke-calendar-home-render.ts` (#31), `scripts/smoke-web-fixes.ts` (#4), `scripts/smoke-calendar-home-copy.ts` (the `menu.*` table), plus any other smoke `grep -l "menuEntries\|MenuSheet\|SunIcon" scripts/*.ts` finds

**Interfaces:**
- Produces: `export type MenuEntryId = 'settings' | 'calendars' | 'partner' | 'refresh' | 'admin'` and `export function menuEntries(o: { isAdmin: boolean; inTelegram: boolean; locale: string; userId: number }): MenuEntry[]` (no `googleState`; `MenuSheetProps` drops it too).

- [ ] **Step 1: Rewrite #31 in smoke-calendar-home-render.ts and #4 in smoke-web-fixes.ts**
  - #31: for a non-admin, `menuEntries(...).map(e => e.id)` equals `['settings','calendars','partner','refresh']`; for an admin in Telegram, `['settings','calendars','partner','refresh','admin']`. Hrefs: `/<locale>/settings?user_id=<id>`, `/<locale>/calendars?user_id=<id>`, `/<locale>/pair?user_id=<id>`, `null`, `/<locale>/admin-panel?user_id=<id>`. The rendered sheet's text is exactly the four or five labels plus Close.
  - #4: the admin entry only when `isAdmin && inTelegram`, nothing else changes.
  - New check: HomeHeader's source imports `Sunset` from `lucide-react`, the zmanim button (aria-label `header.zmanim`) renders it, and no `SunIcon` remains.
- [ ] **Step 2: Run both smokes; expect the new checks to FAIL.**
- [ ] **Step 3: Implement.** Remove the five ids from `menuEntries`, `ICONS` and `LABELS`, and the `googleState` parameter. Update the header comment to the new list. In HomeHeader, render `<Sunset aria-hidden="true" focusable="false" />` sized and stroked like the other header icons (the weather block's lucide icons show the pattern), and update the header comment's "the sun" wording to "the zmanim button". Remove the five message keys from all three files and from smoke-calendar-home-copy's table.
- [ ] **Step 4: Run the gate (tsc, eslint, the three smokes, smoke-he-neutral); expect PASS.**
- [ ] **Step 5: Commit** `feat(menu): five entries (Settings, Calendars, Partner, Refresh, Admin) and a Sunset zmanim icon: Google, plan and feedback move to their screens`

### Task 2: Plan at a glance and Send feedback in Settings

**Files:**
- Create: `src/lib/plan-glance.ts`
- Modify: `src/lib/page-data.ts` (`settings()` gains `plan`; `subscription()` unchanged)
- Modify: `app/[locale]/(app)/settings/SettingsClient.tsx` (the Plan card first, the feedback card after `<SignInMethods>` and before `<AccountDelete>`)
- Modify: `app/[locale]/(app)/subscription/SubscriptionClient.tsx` (status from the helper; Back by `from`), `app/[locale]/(app)/subscription/page.tsx` (pass `from`)
- Modify: `app/[locale]/(app)/feedback/FeedbackClient.tsx`, `app/[locale]/(app)/feedback/page.tsx` (Back by `from`)
- Modify: `messages/{en,he,ru}.json`: add `settings.feedbackRow` = en "Send feedback", he "שליחת משוב", ru "Отправить отзыв"
- Test: `scripts/smoke-settings-render.ts` (S1 order, S10 keys, new checks), `scripts/smoke-subscription-render.ts` (U1/U2 status, U5 Back), `scripts/smoke-feedback-render.ts` (Back), `scripts/smoke-page-auth.ts` (settings props), new `scripts/smoke-plan-glance.ts`

**Interfaces:**
- Produces, in `src/lib/plan-glance.ts`:
  - `export type PlanStatus = { kind: 'earlyAccess' } | { kind: 'trial'; days: number } | { kind: 'activeUntil'; date: string } | null` (`date` is an ISO string).
  - `export function planStatusOf(o: { plan: PlanId; currentPeriodEnd: string | null; isEarlyAdopter: boolean; isTrialing: boolean; trialDaysRemaining: number }): PlanStatus`. This is the Subscription screen's existing rule, in order: early adopter → `earlyAccess`; trialing → `trial`; `plan !== 'FREE'` with a period end → `activeUntil`; else `null`.
  - `export function planStatusWords(status: PlanStatus, words: { earlyAccess: () => string; trial: (days: number) => string; activeUntil: (date: string) => string }, locale: string): string | null`. It formats the date exactly as SubscriptionClient does today (`DATE_LOCALES`, day numeric, month long, year numeric).
- Produces: Settings props `plan: { effectivePlan: PlanId; status: PlanStatus }`, read in `settings()` with `getTrialStatus(user.id)` and `checkEarlyAdopterAccess(user.id)` added to its `Promise.all`. A failed read falls back to `{ effectivePlan: 'FREE', status: null }`, captured like the existing `settings-subscription` read.
- Produces: `SubscriptionClientProps.from?: 'settings'` and `FeedbackClient`'s `from?: 'settings'`. Back goes to `/${locale}/settings?user_id=${userId}` when it is set, else to the dashboard as today. A page passes `from` only when `searchParams.from === 'settings'`.

- [ ] **Step 1: Write smoke-plan-glance.ts.** `planStatusOf` table:
  - an early adopter on PRO with a period end → `earlyAccess`;
  - trialing with 5 days → `{trial, 5}`;
  - PRO with period end `2026-12-12T00:00:00Z` → `activeUntil` with that date;
  - PRO with no period end → `null`;
  - FREE → `null`.
  `planStatusWords` gives the three phrases from stub words, and formats `2026-12-12` as "12 December 2026" for `en`. Also: SubscriptionClient's source calls `planStatusOf` and no longer contains its own early-access / trial / activeUntil ternary.
- [ ] **Step 2: Extend the screen smokes.**
  - smoke-settings-render: the Plan card renders first, with the section label `subscription.screen.title`, the row title `subscription.plans.PRO.name` and the meta from `planStatusWords`. A FREE row has no meta. Tapping it pushes `/<locale>/subscription?user_id=<id>&from=settings`. The "Send feedback" row renders after Sign-in methods and before Delete account, and pushes `/<locale>/feedback?user_id=<id>&from=settings`. Update S1's order and S10's coverage (it must read `feedbackRow`).
  - smoke-subscription-render U5: Back goes to the dashboard without `from`, and to `/<locale>/settings?user_id=<id>` with `from: 'settings'`.
  - smoke-feedback-render: the same two Back cases.
  - smoke-page-auth: settings props carry `plan`.
- [ ] **Step 3: Run them; expect the new checks to FAIL.**
- [ ] **Step 4: Implement.**
  - Settings' rows mirror the kit: `ListRow` (`components/app-ui/ListRow.tsx`) for the two-line plan row with its chevron; a plain navigation button row with the kit's chevron for feedback. Never `ButtonRow`'s `aria-haspopup="dialog"` for navigation.
  - Use `router.push`.
  - The Settings client reads the `subscription.screen` and `calendarHome.banner` namespaces for the words.
- [ ] **Step 5: Run the gate; expect PASS.**
- [ ] **Step 6: Commit** `feat(settings): the plan at a glance and Send feedback; the plan and feedback screens go back to Settings when opened from there`

### Task 3: The compact Google calendars screen with the Google account section

**Files:**
- Modify: `app/[locale]/(app)/select-calendars/SelectCalendarsClient.tsx`
- Move: `app/[locale]/(app)/settings/GoogleDisconnect.tsx` and `google-disconnect-client.ts` → `app/[locale]/(app)/select-calendars/` (update imports and every smoke path; its i18n stays `settings.googleDisconnect`)
- Modify: `app/[locale]/(app)/settings/SettingsClient.tsx` (no Disconnect section; drop `googleConnected` state and prop if nothing else reads them, and from `settings()` page data)
- Modify: `src/lib/page-data.ts` (`selectCalendars()`: `cls === 'token'` → `{ kind: 'notice', notice: 'googleReconnect' }`, logged as a warning with the user id)
- Modify: `app/[locale]/(app)/select-calendars/page.tsx` (the `googleReconnect` notice node), and PageGate's notice typing if it lists notice names
- Modify: `messages/{en,he,ru}.json`: remove `selectCalendars.chosen` and `.chosenHint`, and add:

| key | en | he | ru |
|---|---|---|---|
| `selectCalendars.account.title` | Google account | חשבון Google | Аккаунт Google |
| `selectCalendars.account.reconnect` | Reconnect Google | חיבור מחדש ל־Google | Переподключить Google |
| `selectCalendars.account.reconnectHint` | If your Google events stop showing up, connect again. | אם האירועים מ־Google הפסיקו להופיע, אפשר להתחבר מחדש. | Если события из Google перестали появляться, подключите его заново. |
| `selectCalendars.reconnectCard.title` | The connection to Google stopped working | החיבור ל־Google הפסיק לעבוד | Подключение к Google перестало работать |
| `selectCalendars.reconnectCard.body` | Google no longer gives FamCal access to this account. Connect again to keep seeing your calendars. | Google כבר לא מאפשר ל־FamCal גישה לחשבון הזה. כדי להמשיך לראות את היומנים, צריך להתחבר מחדש. | Google больше не даёт FamCal доступ к этому аккаунту. Чтобы календари снова отображались, подключите его заново. |

- Test: `scripts/smoke-select-calendars-screen.ts`, `scripts/smoke-google-disconnect-ui.ts`, `scripts/smoke-settings-render.ts`, `scripts/smoke-page-auth.ts`, plus every smoke `grep -l "GoogleDisconnect\|google-disconnect-client\|select-calendars\|chosenHint" scripts/*.ts` finds

**Interfaces:**
- Consumes: nothing from Tasks 1–2. Task 2 already reordered Settings; this task only removes the Disconnect section from it.
- Produces: page-data notice name `'googleReconnect'`.

- [ ] **Step 1: Invoke the `frontend-design:frontend-design` skill for the row and section design.** Brief it to mirror the existing kit and tokens: no new visual language, no hover.
- [ ] **Step 2: Rewrite the screen checks in smoke-select-calendars-screen.ts.**
  - A shown calendar's row holds two sibling buttons, never nested:
    - a text button with the dot, the name and a meta line of its role (`categoriesOf` names, or `noCategory`) plus the Main tag; clicking it opens the calendar sheet;
    - a `role="switch"` button with `aria-checked="true"`; clicking it saves the whole selection without that calendar, with the exact body.
  - A hidden calendar's row is one `role="switch"` button with `aria-checked="false"`, dot and name, and no description text; clicking it saves.
  - No "Chosen calendars" section, and no `chosen` / `chosenHint` key read.
  - A "Google account" section is last:
    - Reconnect Google is a row whose activation does `window.location.assign('/refresh-token?user_id=<id>')`, with its hint;
    - then the moved Disconnect section.
  - Back with no sheet open pushes `/<locale>/calendars?user_id=<id>`; Back with a sheet open closes it.
  - After a successful disconnect, closing the result pushes `/<locale>/calendars?user_id=<id>`.
  - The calendar sheet, the notes sheet, the unlisted section and the status bar keep their existing checks.
- [ ] **Step 3: Add the page-data and notice checks.**
  - smoke-page-auth (or the smoke that already drives `selectCalendars()` with a mocked reader): a reader error that `classifyGoogleError` reads as `token` gives notice `googleReconnect`; missing scopes still redirect to `/refresh-token?user_id=…`; any other error gives `error`.
  - A render of the `googleReconnect` notice node shows the card's title and body, a Reconnect Google action with href `/refresh-token?user_id=<id>` (a full page load, not a client route), and the Disconnect section.
  - Settings no longer renders the Disconnect section: update S1 and smoke-google-disconnect-ui to the new file path and host screen.
- [ ] **Step 4: Run them; expect FAIL.**
- [ ] **Step 5: Implement the screen, the move, the notice and the Settings removal.** Rename the screen's header comment to the new layout, and keep its save model (instant switch with rollback, sheet Save, one request at a time).
- [ ] **Step 6: Run the gate, including smoke-he-neutral; expect PASS.**
- [ ] **Step 7: Commit** `feat(google): one compact Google calendars list (a switch per row, a tap for details), Reconnect and Disconnect in its Google account section, a Reconnect card for a dead token, Back to Calendars`

### Task 4: Open a user in Telegram or WhatsApp from the admin profile

**Files:**
- Create: `app/api/admin/open-profile/route.ts`
- Create: `src/services/admin-open-profile.ts` (the logic, testable without HTTP)
- Modify: `src/lib/telegram-ui.ts` (add `openTelegramLink`)
- Modify: `app/[locale]/(app)/admin-panel/views/profile/Who.tsx` (two buttons and the outcome line)
- Modify: `messages/{en,he,ru}.json`:

| key | en | he | ru |
|---|---|---|---|
| `admin.profile.who.openTelegram` | Open in Telegram | פתיחה בטלגרם | Открыть в Telegram |
| `admin.profile.who.openWhatsapp` | Open in WhatsApp | פתיחה בוואטסאפ | Открыть в WhatsApp |
| `admin.profile.who.sentToChat` | No public username, so the bot sent a link to the profile to your chat. | אין שם משתמש ציבורי, אז הבוט שלח קישור לפרופיל לצ'אט. | Публичного имени пользователя нет, поэтому бот отправил ссылку на профиль в ваш чат. |
| `admin.profile.who.openFailed` | Couldn't open the profile. Try again. | לא הצלחנו לפתוח את הפרופיל. כדאי לנסות שוב. | Не удалось открыть профиль. Попробуйте ещё раз. |
| `bot.adminProfileLink` | Tap the name to open the profile: {name} | להקיש על השם כדי לפתוח את הפרופיל: {name} | Нажмите на имя, чтобы открыть профиль: {name} |

- Modify: `scripts/smoke-pause.ts` (`NOT_PAUSED`: the new sender, reason "a message to the admin, answering the admin's own tap")
- Test: new `scripts/smoke-admin-open-profile.ts`, and `scripts/smoke-admin-render.ts` for Who

**Interfaces:**
- Produces:
  - `export async function openProfileFor(adminTelegramId: number, userId: number, deps?: { bot?: …; prisma?: … }): Promise<{ kind: 'link'; url: string } | { kind: 'sent' } | { kind: 'notFound' } | { kind: 'failed' }>`. It reads the user's `telegramId` and `name`:
    - no user or no `telegramId` → `notFound`, with no Telegram call;
    - otherwise `getBot().getChat(telegramId)`: a `username` → `link` with `https://t.me/<username>`;
    - no username, or a refused `getChat` (logged through `telegramErrorInfo`) → send the admin's chat `bot.adminProfileLink` in the admin's language, with `{name}` = `<a href="tg://user?id=<telegramId>">escaped name, or the id when there is no name</a>`, `parse_mode: 'HTML'` → `sent`;
    - a failed send → `failed`.
    - Logs: `[admin-open-profile] admin <adminDbId> user <userId>: link|sent|notFound|failed`.
  - Route `POST /api/admin/open-profile`, body `{ userId: number }`, initData through `requestInitData`, guarded by `verifyAdminAccess` like `app/api/admin/send-reminder/route.ts`. It answers 200 `{ kind:'link', url }` or `{ kind:'sent' }`, 404 for `notFound`, 502 for `failed`, 400 for a bad body, and 401/403 as its siblings do.
  - `export function openTelegramLink(url: string): boolean` in `src/lib/telegram-ui.ts`. It accepts only `https://t.me/…`. In Telegram it calls `tg.openTelegramLink` through `tgCall` (the version gate its docs give, `6.1` like `openLink`), else `window.open(url, '_blank', 'noopener')`. It returns false for any other URL.
- Who: "Open in Telegram" shows only with a `telegramId`. It posts the route with the profile's user id (the database id the panel already holds). A `link` is opened with `openTelegramLink`; `sent` shows `sentToChat`; anything else shows `openFailed`. The button is busy while the request runs. "Open in WhatsApp" shows only with a `whatsappPhone` and calls `openExternalLink('https://wa.me/' + digits)`.

- [ ] **Step 1: Write smoke-admin-open-profile.ts with a fake bot and a fake prisma (no network).** Assertions:
  - a username gives `link` `https://t.me/alice` and sends nothing;
  - no username sends one message to the admin's chat id with `parse_mode` `HTML`, containing `<a href="tg://user?id=123">` and the name escaped (`<b>&"` becomes `&lt;b&gt;&amp;&quot;`), and gives `sent`;
  - a `getChat` refusal (a 400 "chat not found" shaped as the Telegram tests already shape it) also sends the mention;
  - no `telegramId` gives `notFound` with zero bot calls;
  - a send that throws gives `failed`;
  - the route's source calls `verifyAdminAccess` before `openProfileFor`;
  - no console line written during the run holds the name, the username or the message text;
  - `openTelegramLink` refuses `tg://user?id=1` and `https://example.com`.
- [ ] **Step 2: Extend smoke-admin-render.ts for Who.**
  - With a `telegramId`, the Open in Telegram button renders; without one, it does not.
  - With a `whatsappPhone` `+972501234567`, Open in WhatsApp calls `openExternalLink('https://wa.me/972501234567')`; without one, there is no button.
- [ ] **Step 3: Run both; expect FAIL.**
- [ ] **Step 4: Implement** the service, the route, the helper, Who, the copy and the smoke-pause entry.
- [ ] **Step 5: Run the gate, including smoke-pause, smoke-telegram-wire, smoke-telegram-errors and smoke-he-neutral; expect PASS.**
- [ ] **Step 6: Commit** `feat(admin): Open in Telegram (the username's t.me link, else a mention sent to the admin's chat) and Open in WhatsApp on a user's profile`
