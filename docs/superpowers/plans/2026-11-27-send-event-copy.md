# Send a Copy of an Event Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A FamCal event's sheet gets "Send a copy". It sends a Telegram card whose button lets the first person who taps it copy the event into a FamCal calendar of their choice, and the sender is told who copied it.

**Architecture:** One table, `EventCopyOffer` (single-use, token hashed), and one service folder, `src/services/event-copy/`. The service covers offers, the copy write, the card's words and Telegram's prepared message. A Mini App route makes the offer and the prepared card; the sheet sends it with `shareMessage`, or falls back to Telegram's share link. The bot's `/start cp_<token>` and the `cp:` buttons do the receiver's side through the event store.

**Tech Stack:** Next.js 16 route handlers, Prisma 7 (Postgres), node-telegram-bot-api 2.4.0 (`savePreparedInlineMessage` is in its Api), next-intl (`createTranslator` on the server), the repo's tsx smokes with fakes.

**Spec:** `docs/superpowers/specs/2026-11-27-send-event-copy-design.md`

## Global Constraints

- Words: sender "Send a copy" (he "שליחת עותק", ru "Отправить копию"); receiver's button "Copy to my calendar" (he "העתקה ליומן שלי", ru "Скопировать в свой календарь"). Never "share" in the UI. Natural, gender-neutral Hebrew; formal Russian. Bot words go in `messages/*.json` under `bot.eventCopy`; the sheet's under `calendarHome.sheet`.
- Only FamCal EVENTS (not reminders, not Google) can be sent. Copies go only into FamCal calendars the receiver can write (`writableCalendarRows`).
- Copied: `title`, `startsAt`, `endsAt`, `allDay`, `timeZone`, `rrule`, `hebrewRule`, `hebrewAnchor`, `exdates`, `birthday`, `birthYear`. Not copied: description, location, alerts (the receiver's defaults apply), single-day changes (`NativeEventInstance`).
- One copy per offer. The offer works only while the original isn't deleted, the sender can still see its calendar (`getCalendarAccess` ≠ `none`) and the sender is active (not suspended, banned or deleted). The sender's own tap never takes it.
- Token: 16 random bytes in base64url (22 characters), stored only as SHA-256 hex. Deep link `https://t.me/<bot>?start=cp_<token>`, with `<bot>` = `process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME` (`src/lib/gate-links.ts`).
- Every Bot API call goes through `getBot()`. Read failures with `telegramErrorInfo`. Library calls retry with `retryWithBackoff(..., { retryable: telegramRetryVerdict })`, as `answerGuestQuery` does in `src/services/messaging/telegram-adapter.ts:301`.
- FamCal events are written only through the event store (`createNativeEvent`), so the alerts gate opens. New writer files go in `OPENS` in `scripts/smoke-alerts-gate-writers.ts`. New senders go in `NOT_PAUSED` in `scripts/smoke-pause.ts`, with the reason "answers the person's own action" (the receiver's replies) or "the quiet note to the sender after someone copies their event (the receiver's action, sent without a sound)".
- No console line or Sentry field holds the token, a title, a name or a card's text. Log user ids, the offer id, the event id, the calendar id and outcomes, under the prefix `[event-copy]`.
- Lucide icons only (`Forward` for Send a copy); no `:hover`; RTL; light and dark.
- Smokes run with the fake env only: `bash <scratchpad>/repro/run-env.sh scripts/<smoke>.ts`. Never the real Telegram API. Never `npm run build`.
- Commit trailer:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
  ```

## Review Focus

1. **Two presses at once:** two people (or one double-tap) press a calendar button on the same offer at once. Exactly one copy exists, and the other press is told it's taken.
2. **The original changed or deleted after sending:** the copy carries the version at the press. A deleted original answers "gone" both at `/start` and at the press.
3. **The sender taps their own card in a group:** the offer stays open, and the sender is told it's waiting for someone else.
4. **A brand-new Telegram user arriving through `cp_`:** the account is made, the calendar question shows (their main FamCal calendar is made when they have none), and "Address me as" follows. The callback still works.
5. **A Telegram app without Bot API 8.0, or a prepare that failed:** the share link opens instead. Closing the picker shows no error.

---

### Task 1: Offers, the copy write and the store's two new fields

**Files:**
- Modify: `prisma/schema.prisma`, adding `model EventCopyOffer` and its relations on `User` and `NativeEvent`.
- Create: `prisma/migrations/20261127000000_event_copy_offer/migration.sql`.
- Create: `src/services/event-copy/offers.ts`.
- Modify: `src/services/native-calendar/event-store.ts`, adding `exdates?: Date[]` and `birthYear?: number | null` to `CreateNativeEventInput`, validated by the store.
- Modify: the account-deletion and account-merge code (`src/services/account-linking.ts` and the account delete service). Offers sent go with the sender's account. A merged account's offers move to the kept user, as its other rows do. Follow each file's own pattern, and the smoke that lists User relations if one exists.
- Test: `scripts/smoke-event-copy.ts` (new; register it where `scripts/ci-smokes.sh` finds smokes).

**Interfaces:**
- Produces:
  - `newCopyToken(): { token: string; tokenHash: string }`
  - `copyTokenHash(token: string): string`
  - `copyStartParam(token: string): string` returns `cp_<token>`.
  - `copyTokenFromStart(payload: string): string | null` checks `/^[A-Za-z0-9_-]{22}$/`.
  - `copyDeepLink(token: string): string`
  - `createCopyOffer(senderUserId: number, sourceEventId: string): Promise<{ offerId: string; token: string }>`
  - `type CopyOfferView = { state: 'invalid' } | { state: 'mine' | 'taken' | 'gone' | 'open'; offer: EventCopyOffer; source: NativeEvent; sender: User } | { state: 'yours'; offer: EventCopyOffer; source: NativeEvent; sender: User; calendarName: string }`
  - `viewCopyOffer(token: string, viewerUserId: number): Promise<CopyOfferView>`: the state rules in Global Constraints. `taken` is taken by someone else; `yours` is taken by the viewer.
  - `claimCopyOffer(offerId: string, userId: number): Promise<boolean>`: one conditional `updateMany` (where `takenAt: null`), true only for the winner.
  - `releaseCopyOffer(offerId: string, userId: number): Promise<void>`
  - `copyEventFor(source: NativeEvent, receiver: UserConfig, calendarCuid: string): Promise<NativeEvent>`: through `createNativeEvent`, with the Global Constraints field list.
  - `recordCopy(offerId: string, copyEventId: string): Promise<void>`

- [ ] **Step 1: Write the failing smoke checks** in `scripts/smoke-event-copy.ts`, using a fake Prisma the way the other store smokes do (find one, e.g. `scripts/smoke-birthday.ts`):
  - `cp_` plus a token is ≤ 64 characters and matches Telegram's `/^[A-Za-z0-9_-]{1,64}$/`.
  - `copyTokenFromStart` refuses 21 or 23 characters and other letters.
  - The stored hash is never the token.
  - `viewCopyOffer` answers each state:
    - `invalid` for an unknown token;
    - `mine` for the sender;
    - `open`;
    - `taken` for another taker;
    - `yours` with the copy's calendar name;
    - `gone` when the original is deleted, when the calendar is now PRIVATE to the sender (the partner's), after an unlink, and when the sender is suspended or banned.
  - Two `claimCopyOffer` calls on one offer give `[true, false]`.
  - `releaseCopyOffer` reopens the offer.
  - `copyEventFor` copies exactly the listed fields, from a yearly Hebrew birthday with `birthYear` and a weekly rrule with exdates. It sends no description, location or alert, and sets the creator to the receiver.
  - It refuses a calendar the receiver can't write (`NativePermissionDeniedError`).
  - The store refuses `birthYear` without `birthday`, and `exdates` on a one-off.
- [ ] **Step 2: Run it and see it fail.** `bash <scratchpad>/repro/run-env.sh scripts/smoke-event-copy.ts`. Expected: failures, because the module doesn't exist yet.
- [ ] **Step 3: Implement the schema, the migration, the store fields and `offers.ts`.** `EventCopyOffer` has:
  - `id String @id @default(cuid())`
  - `tokenHash String @unique`
  - `sourceEventId`, related `onDelete: Cascade`
  - `senderUserId`, related `onDelete: Cascade`
  - `createdAt`
  - `takenAt DateTime?`
  - `takenByUserId Int?`, related `onDelete: SetNull`
  - `copyEventId String?`, related `onDelete: SetNull`
  - `@@index([senderUserId])`
  
  Write the migration by hand: `prisma migrate dev` needs a TTY.
- [ ] **Step 4: Run it until it passes.** Then run `npx tsc --noEmit`, plus `smoke-prisma-client`, `smoke-alerts-gate-writers` (add `offers.ts` to `OPENS` if the scan lists it) and the store's own smokes. Expected: all pass.
- [ ] **Step 5: Commit** with `feat(copy): single-use copy offers, the copy write, and the store takes skipped days and the birth year`.

### Task 2: The card and the route that prepares it

**Files:**
- Create: `src/services/event-copy/card.ts`.
- Create: `app/api/calendar/copy/route.ts`.
- Modify: `messages/{en,he,ru}.json`, adding `bot.eventCopy.cardButton` ("Copy to my calendar" and the he and ru words above).
- Test: extend `scripts/smoke-event-copy.ts`.

**Interfaces:**
- Consumes: `createCopyOffer` and `copyDeepLink` from Task 1.
- Produces:
  - `copyWhen(source: NativeEvent, locale: Locale, zone: string, weekStart: WeekStart): string`:
    - a one-off gets its date and time in `zone`, or its date and "all day";
    - a repeating series gets its repeat in the item sheet's words plus its usual time.
    
    Reuse the sheet's helpers (`app/[locale]/(app)/dashboard/repeat-words.ts`, `hebrew-repeat-words.ts`, `src/lib/calendar-view/format.ts`) through `createTranslator({ locale, messages, namespace: 'calendarHome' })`, as `src/services/zmanim/api-view.ts` does.
  - `copyCardText(source: NativeEvent, locale: Locale, zone: string, weekStart: WeekStart): string` returns `<title>\n<when>`.
  - `copyArticle(text: string, button: string, url: string): InlineQueryResultArticle`: built like `guestAnswerArticle`, with the link preview off.
  - `prepareCopyCard(senderTelegramId: number, article): Promise<string | null>`: `savePreparedInlineMessage` with `allow_user_chats` and `allow_group_chats` true. It returns the id, or null after logging the refusal through `telegramErrorInfo`.
  - `POST /api/calendar/copy`, body `{ user_id, key, initData }`. It answers 200 `{ preparedId: string | null, link: string, text: string }`; 400 `invalid` for a key that isn't FamCal; 404 `not_found` for a missing event or one the person can't see; 409 `not_event` for a reminder; 409 `no_telegram` for an account with no Telegram id.

- [ ] **Step 1: Write the failing checks.** Use a fake `getBot()` Api that records `savePreparedInlineMessage`:
  - The route refuses each case above with its status.
  - A FamCal event answers 200, and the article's button URL is the offer's deep link.
  - The article's text is `copyCardText` in the sender's locale and zone:
    - en one-off: "Dentist\nTue 1 Dec, 10:00–11:00";
    - he Hebrew yearly: "<title>\nכל שנה ב־<date>…";
    - ru all-day.
  - A prepare failure answers 200 with `preparedId: null` and the link and text.
  - `user_id` is the sender's Telegram id.
  - No log line holds the token or the title.
- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement `card.ts` and the route.** Use `verifyUserAuth(request, userId, initData, <rate limiter>, 'calendar-copy')`, `requestInitData`, `parseItemKey` (FamCal keys only), and `loadItem`/access as `itemInfoFor` does. Wrap everything in try/catch with `captureError`.
- [ ] **Step 4: Run it until it passes,** plus `npx tsc --noEmit`.
- [ ] **Step 5: Commit** with `feat(copy): the card and the route that prepares it`.

### Task 3: "Send a copy" on the sheet

**Files:**
- Modify: `src/types/telegram-webapp.d.ts`, adding `shareMessage(msgId: string, callback?: (sent: boolean) => void): void`.
- Create: `src/lib/calendar-view/copy-client.ts`.
- Modify: `app/[locale]/(app)/dashboard/ItemSheet.tsx`, `app/[locale]/(app)/dashboard/CalendarHome.tsx` and `messages/{en,he,ru}.json` (`calendarHome.sheet.sendCopy`, `calendarHome.sheet.sendCopyFailed`).
- Test: `scripts/smoke-calendar-home-render.ts`, new numbered checks.

**Interfaces:**
- Consumes: `POST /api/calendar/copy` from Task 2.
- Produces: `sendEventCopy(userId: string, key: string): Promise<'sent' | 'closed' | 'link' | 'failed'>`.
  - With a `preparedId`, a WebApp at version 8.0 or later (`isVersionAtLeast('8.0')`) and `shareMessage`: call it, and answer from its callback (`sent` or `closed`).
  - A `shareMessageFailed` event with error `UNSUPPORTED` falls through to the link.
  - Otherwise: `openTelegramLink('https://t.me/share/url?url=' + enc(link) + '&text=' + enc(text))`, answering `link`.
  - A failed request answers `failed` and logs.
  - The sheet gets an optional `onSendCopy` on `SheetEditing`. `CalendarHome` passes it only for `item.source === 'famcal' && item.kind === 'event'` and only inside Telegram (`isInTelegram()`).

- [ ] **Step 1: Write the failing render checks:**
  - The button (lucide `Forward`, labelled with `sheet.sendCopy` in each language) shows for a FamCal event in Telegram. It doesn't show for a reminder, a Google event or a browser session.
  - A tap POSTs `{ user_id, key, initData }` with the init-data header.
  - With `preparedId`, `shareMessage` gets that id.
  - Without `shareMessage`, or with a null `preparedId`, `openTelegramLink` gets the share URL, carrying the encoded link and text.
  - A `false` callback shows no note.
  - A 500 shows `sheet.sendCopyFailed`.
  - The button is disabled while busy.
- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement it.** Its place is beside the sheet's edit and delete buttons, styled as they are.
- [ ] **Step 4: Run** `smoke-calendar-home-render`, `smoke-calendar-home-copy` (add the new keys to its `KEYS`), `smoke-app-ui` and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** with `feat(copy): Send a copy on a FamCal event's sheet`.

### Task 4: The receiver's side and the notice to the sender

**Files:**
- Create: `src/services/event-copy/bot.ts`.
- Modify:
  - `src/services/telegram/commands.ts`: a `cp_` branch beside `invite_`, after `getOrCreateUser`, ending with `links` and `askAddress()`.
  - `src/services/webhook-handlers.ts`: a `cp:` prefix in the callback chain, with a lazy import.
  - `messages/{en,he,ru}.json`: `bot.eventCopy.*`.
  - `scripts/smoke-pause.ts`, `scripts/smoke-alerts-gate-writers.ts` and `CLAUDE.md` (one rule line: a copy of an event is made only by `copyEventFor` on a claimed offer).
- Test: extend `scripts/smoke-event-copy.ts`.

**Interfaces:**
- Consumes: Task 1's offers, `copyEventFor` and `recordCopy`; Task 2's `copyCardText`.
- Produces:
  - `handleCopyStart(chatId: number, user: UserConfig, payload: string, locale: Locale, footer: string): Promise<void>`
  - `handleCopyPress(chatId: number, messageId: number, queryId: string, telegramId: number, data: string): Promise<void>`
  - The callback data is `cp:<token>:<calendarCuid>`, at most 64 bytes, checked by a regex.

- [ ] **Step 1: Write the failing checks.** Use a fake messaging service and bot that record sends, edits and callback answers:
  - `/start cp_<token>` answers each state with its `bot.eventCopy` line, in the receiver's language:
    - `invalid`;
    - `mine`;
    - `taken`;
    - `yours`, naming the calendar;
    - `gone`;
    - `open`: the card text in the receiver's language and zone, plus one button per writable calendar, own first and main first. A user with none gets their main one made.
  - Every button's data is ≤ 64 bytes, using a real 25-character cuid.
  - A new Telegram user gets the question, then the address question.
  - A press:
    - answers the callback first;
    - claims the offer, copies the event and records it;
    - edits the message to "Copied to <calendar>" with the card line and "<sender name> was told";
    - sends the sender `bot.eventCopy.notice` in the SENDER's language, with `disable_notification: true`, naming the receiver (or "Someone" for no name) and the title.
  - A second press answers taken, and nothing more is copied.
  - Two presses at once give one copy.
  - A store failure releases the claim, answers "try again" and calls `captureError`.
  - A calendar no longer writable is refused, and the offer stays open.
  - The sender's press is `mine`, with no claim.
  - `smoke-pause` and `smoke-alerts-gate-writers` pass with the new files listed.
  - No log line holds the token, the title or a name.
- [ ] **Step 2: Run it and see it fail.**
- [ ] **Step 3: Implement it.** Follow `address-choice.ts` (`gd:`) for the press, and `pair-handler.ts` for the `/start` reply. The copy goes through `getMessagingService()`. The notice goes to the sender's Telegram chat (`sender.telegramId`); a failure is logged, and the copy stands.
- [ ] **Step 4: Run the smoke,** plus `smoke-pause`, `smoke-alerts-gate-writers`, `smoke-telegram-wire`, `smoke-calendar-home-copy` (if it checks `bot` keys) and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** with `feat(copy): the receiver copies into a calendar they pick, and the sender is told who`.

### Task 5: The Privacy Policy and Terms (only after the owner's "legal ok")

**Files:**
- Modify: `messages/{en,he,ru}.json` (`legal.privacy.*`, `legal.terms.*`) with exactly the owner-approved lines.
- Modify: `src/site/legal.ts`, setting `LEGAL_UPDATED` to the ship date for both documents.

- [ ] **Step 1: Insert the approved lines** where the draft placed them (keep › Your calendar; processors › Telegram; partner; rights › what stays; terms › service list, account responsibility, the Telegram-only list).
- [ ] **Step 2: Run** `smoke-terms-plans`, the legal and site smokes (`grep -l "legal" scripts/smoke-*.ts`) and `npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 3: Commit** with `docs(legal): the Privacy Policy and Terms cover sending a copy of an event (owner-approved wording)`.
