# W4-2: Select calendars (the Google calendars screen) in the app's design — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the Select calendars screen (`/[locale]/select-calendars`, the Google calendars a person shows in FamCal) moves onto the app kit: light and dark, the five category icons become named settings, the glued feedback ("נוסף ל ילדים") becomes real sentences, a failed save is undone and said, and the old purple look leaves the app.

**Architecture:** `SelectCalendarsClient` becomes an `AppScreen` on the grouped ground, built from `components/app-ui` only, like W4-1's Calendars screen (`app/[locale]/calendars/CalendarsClient.tsx`: read it first, it is the closest pattern). Three sections: switch rows that choose the calendars (each tap saves at once, owner decision 2026-10-28: "keep instant save, with a Saved note and rollback"), the chosen calendars as rows that open a settings sheet (category, main calendar, note for the AI, spouse details), and the notes for all calendars in a sheet. The request stays exactly the same. PageGate then draws every page in the 'app' look, so the 'telegram' look and its leftovers are deleted.

**Tech Stack:** Next.js 16 client components, next-intl, the kit in `components/app-ui`, smoke scripts with `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-10-19-screens-and-colours-design.md` §4–§5, the owner's W4 decisions (2026-10-28: Calendars and Select calendars stay two screens, cross-linked; no mockups; instant save with a Saved note and rollback), and "Google as a connection" `docs/superpowers/specs/2026-10-19-google-connection-design.md` §3 (one primary across both lists, the "New events will go to …" note, the shared calendar limit). Survey: `/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/web/w4-inventory.md` §1 and §6.

## Global Constraints

- Everything W4-1's plan (`docs/superpowers/plans/2026-10-29-w4-1-calendars.md`, Global Constraints) says about kit pieces, tokens, CSS lint, 44 px targets, logical properties, dark mode, lucide icons, no inline strings, Hebrew gender-neutral, Russian formal, the one-request-at-a-time lock, Back's single owner, mutation checks, smokes with the fake env, no `npm run build`, textual message edits and local commits only (trailers `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31`) applies here unchanged.
- The POST to `/api/select-calendars?user_id=…` keeps its exact body: `calendarAssignments` (each `{ calendarId, labels, name, color (Google's backgroundColor, default '#4285f4'), personName/personEnglishName/personGender on every spouse calendar, rules: [rule] when there is one }`) and `globalRules` (the non-empty ones). Only the credential moves: `initDataHeaders()` (`src/lib/read-init-data.ts`) as every other client sends it, not `window.Telegram.WebApp.initData` in the body; confirm `verifyUserAuth` reads the header and extend `scripts/smoke-initdata-header.ts` to this client.
- The label rules stay exactly as today (`handleLabelToggle`): a calendar has at most one of yours / spouse / kids / birthdays; primary is one calendar across the list (turning it on clears it elsewhere) and is always also yours (turning primary on adds yours; yours can't be removed while primary is on).
- `famcalPrimaryName`: the first time primary is turned on here while a FamCal calendar holds it, the page says `newEventsGoTo` once.
- Every save is the whole selection, as today. A save that fails restores the state from before the change (rollback) and says so; a save that succeeds says `ui.saved` in a status line. No debounce and no "save when a panel collapses": text is saved by its sheet's Save.

## Review Focus

1. Two quick taps on two different switches: one request at a time, the second waits or is refused visibly; the final state on screen matches what the server holds.
2. A save refused for the calendar limit (`calendar_limit_reached` with `limit`): the switch goes back, the notice names the limit with See plans; no client-side guess of the limit blocks a tap the server would allow.
3. Hebrew dark: the sheet's radio options, the switch rows with long Google calendar names and descriptions, the colour dots and the chevrons mirror and stay readable.
4. A WhatsApp person in a browser: the credential still reaches the route (the session cookie when there is no Telegram data) and Back works.
5. A Google account with no calendars, and a person whose choices include a calendar Google no longer lists: the empty state shows; a chosen calendar missing from the list is not lost from the saved selection by an unrelated tap.

---

### Task 1: The words

Rewrite the strings of this screen in a new namespace `selectCalendars` in `messages/{en,he,ru}.json` (verbatim below). Keep `calendars.categories.{primary,yours,spouse,kids,birthdays}` (W4-1 shows them too) and `calendars.noGoogle.*` (page.tsx's notice; make its Hebrew neutral if it is not). Delete every other `calendars.*` key once nothing reads it (`grep` app, components and src first: the inventory §1.5 lists the dead ones, and the `*Desc` keys are unused), and `common.header` once `components/Layout/Header.tsx` is deleted (Task 2). The category meanings reuse `calendarsPage.categoryHint.*`, and the errors reuse `calendarsPage.errors.tooMany`, `calendarsPage.errors.reopen` and `calendarsPage.seePlans`.

| key | en | he | ru |
|---|---|---|---|
| `title` | Google calendars | יומני Google | Календари Google |
| `intro` | Choose the Google calendars FamCal shows in your calendar and summaries. | בחרו אילו יומני Google יופיעו ב־FamCal, ביומן ובסיכומים. | Выберите, какие календари Google показывать в FamCal: в календаре и в сводках. |
| `show` | Show in FamCal | להציג ב־FamCal | Показывать в FamCal |
| `chosen` | Chosen calendars | היומנים שנבחרו | Выбранные календари |
| `chosenHint` | Tap a calendar to set its category and a note for the AI. | אפשר להקיש על יומן כדי לקבוע לו קטגוריה והערה לבינה המלאכותית. | Нажмите на календарь, чтобы указать категорию и заметку для ИИ. |
| `category` | Category | קטגוריה | Категория |
| `noCategory` | No category | בלי קטגוריה | Без категории |
| `mainIsYours` | The main calendar is always one of yours. | היומן הראשי תמיד מסומן כשלכם. | Основной календарь всегда относится к вашим. |
| `note` | Note for the AI | הערה לבינה המלאכותית | Заметка для ИИ |
| `notePlaceholder` | e.g. Early dismissal every Friday | למשל: יציאה מוקדמת בכל יום שישי | Например: по пятницам ранний уход |
| `noteHint` | Read with this calendar's events in your summaries. | נקראת יחד עם האירועים של היומן הזה בסיכומים. | Учитывается вместе с событиями этого календаря в сводках. |
| `noNote` | None | אין | Нет |
| `spouse` | Spouse details | פרטי בן או בת הזוג | О супруге |
| `spouseHint` | Used for every spouse calendar, so summaries name them. | משמשים לכל יומני בן או בת הזוג, כדי שהסיכומים יזכירו אותם בשם. | Используется для всех календарей супруга или супруги, чтобы сводки называли их по имени. |
| `spouseName` | Name | שם | Имя |
| `spouseNamePlaceholder` | e.g. Noa | למשל: נועה | Например: Анна |
| `spouseEnglishName` | Name in English (optional) | שם באנגלית (לא חובה) | Имя на английском (необязательно) |
| `spouseGender` | Gender | מין | Пол |
| `male` | Male | זכר | Мужской |
| `female` | Female | נקבה | Женский |
| `notes` | Notes for all calendars | הערות לכל היומנים | Заметки для всех календарей |
| `notesHint` | Up to three notes the AI reads with every summary, e.g. early dismissal on certain days. | עד שלוש הערות שהבינה המלאכותית קוראת עם כל סיכום, למשל יציאה מוקדמת בימים מסוימים. | До трёх заметок, которые ИИ учитывает в каждой сводке, например ранний уход в определённые дни. |
| `notesPlaceholder` | Note {number} | הערה {number} | Заметка {number} |
| `notesCount` | {count, plural, =0 {None} one {# note} other {# notes}} | {count, plural, =0 {אין} one {הערה אחת} two {שתי הערות} other {# הערות}} | {count, plural, =0 {Нет} one {# заметка} few {# заметки} many {# заметок} other {# заметки}} |
| `newEventsGoTo` | New events will go to {name} | מעכשיו אירועים חדשים יירשמו ב־{name} | Новые события теперь будут попадать в «{name}» |
| `errors.save` | Couldn't save, so the change was undone. | לא הצלחנו לשמור, והשינוי בוטל. | Не удалось сохранить, изменение отменено. |
| `errors.limit` | Your plan has room for {limit, plural, one {# calendar} other {# calendars}}, FamCal and Google together. | בתוכנית שלכם יש מקום ל־{limit} יומנים, של FamCal ושל Google יחד. | В вашем плане есть место для {limit, plural, one {# календаря} other {# календарей}} FamCal и Google вместе. |
| `empty.title` | No calendars in this Google account | אין יומנים בחשבון Google הזה | В этом аккаунте Google нет календарей |
| `empty.body` | Add a calendar in Google Calendar, then open this page again. | אפשר להוסיף יומן ב־Google Calendar ולפתוח את הדף הזה שוב. | Добавьте календарь в Google Календаре и откройте эту страницу снова. |

- [ ] Add the keys; run the parity check, `smoke-he-neutral.ts` and `smoke-ru-formal.ts`. Commit `feat(select-calendars): the screen's words in messages, in natural Hebrew and formal Russian`.

### Task 2: The screen

**Files:**
- Rewrite: `app/[locale]/select-calendars/SelectCalendarsClient.tsx` (keep the props `SelectCalendarsClientProps` as they are: PageGate revives the Sets and Maps)
- Modify: `app/[locale]/select-calendars/page.tsx` only if its two notices need the new look (they already use StateCard)
- Modify: `app/[locale]/PageGate.tsx`: `LOOK['select-calendars']` = 'app', `GROUND['select-calendars']` = 'grouped'; then delete the 'telegram' look and everything only it used (the `Look` type if every page is 'app', the purple loader, `GateCard`/`GateActions`/`GateAction` if only 'telegram' uses them, `startMiniApp`'s purple colour calls), keeping the exported API the other callers use or updating them together
- Delete: `components/Layout/TelegramLayout.tsx`, `components/Layout/Header.tsx`, `components/Layout/index.ts` (only this screen imports them; `SiteHeader`/`Footer` are imported by path and stay), `components/Forms/CategoryIcon.tsx` — `grep` first that nothing else imports them
- Test: new `scripts/smoke-select-calendars-screen.ts`; update `scripts/smoke-calendar-home-render.ts` #111a/#112, `scripts/smoke-miniapp-gate.ts` (#2, #2b, #7, #18), `scripts/smoke-app-ui.ts` (the CSS lint list, K12 loader), `scripts/smoke-initdata-header.ts`, and remove the `calendars` exemption from `scripts/smoke-he-neutral.ts` (keep `refreshToken` and `oauth` for W4-3)

**What the screen shows** (`AppScreen ground="grouped" onBack={back}`, `FORM_CSS`, `ScreenHeader title={selectCalendars.title}`, back to `/${locale}/dashboard?user_id=…`):

1. `intro` as `.ch-form-fixed` text.
2. The status line: `Notice` (info) `ui.saved` after a successful save, `newEventsGoTo` when it applies (it replaces "Saved" that once), `Notice tone="error"` for a failure (`errors.save` with rollback; `errors.limit` with the action `calendarsPage.seePlans` → `/${locale}/subscription?user_id=…`; 429 → `calendarsPage.errors.tooMany`; 401/403 → `calendarsPage.errors.reopen`). The line stays until the next save.
3. **Show in FamCal:** `SectionLabel` `show`, a `FormCard` of one switch row per Google calendar (`role="switch"`): a `.ch-swatch-dot`-style dot in Google's `backgroundColor` (or the kit's dot class as W4-1 named it), the name in `<bdi dir="auto">`, the description as the hint. A tap saves at once. Turning one off drops its labels and rule as today.
4. **Chosen calendars** (only when some are chosen): `SectionLabel` `chosen`, a `FormCard` of `ListRow`s (title = dot + name; meta = the category's name, or `noCategory`; tags = `Tag tone="accent"` with `calendars.categories.primary` on the primary), and `chosenHint` under the card. A tap opens the calendar's sheet.
5. **Notes for all calendars:** `SectionLabel` `notes`, a `FormCard` with one `ButtonRow` (label `notes`, value `notesCount`), `notesHint` under it; it opens the notes sheet.
6. **No calendars at all** (Google returned none): a `StateCard` with `empty.title` / `empty.body` instead of sections 3–5.

**The calendar's sheet** (`BottomSheet label={name}`), with a `SaveBar` (`ui.save`) that saves the whole selection with this calendar's new settings; a failure keeps the sheet open with the entered values and the error; success closes it and shows "Saved":
- a `SwitchRow` `calendars.categories.primary` with the hint `calendarsPage.categoryHint.primary`;
- `SectionLabel` `category`, a `RadioCard` with `noCategory`, yours, spouse, kids, birthdays (labels `calendars.categories.*`; each option's hint, if RadioCard supports hints, `calendarsPage.categoryHint.*`; otherwise none). While primary is on, only yours can be chosen: the other options are disabled and `mainIsYours` shows under the card;
- `SectionLabel` `note`, a `FormCard` with a multiline `TextField` (maxLength 200, `notePlaceholder`), `noteHint` under it;
- when the category is spouse: `SectionLabel` `spouse`, a `FormCard` with `TextField` `spouseName` (maxLength 50), `TextField` `spouseEnglishName` (maxLength 50), and a `Segmented` `spouseGender` (male / female, nothing chosen allowed as today), `spouseHint` under it (the spouse details are one set for every spouse calendar, as today).

**The notes sheet:** three `TextField`s (`notesPlaceholder` with 1–3, maxLength 200 each), `notesHint`, a `SaveBar`.

Steps:
- [ ] **Step 1:** write `scripts/smoke-select-calendars-screen.ts` (mount like #111a does today, with the fake DOM; en/he/ru, light and dark) with checks for: the three sections and the empty state; a switch tap sends the exact body (assignments in the list's order, the colour from Google, spouse fields on spouse calendars, rules) with the credential in the header; a refused save rolls the switch back and shows `errors.save`; `calendar_limit_reached` shows the limit sentence (ru plural for 3 and 5) and See plans; a second tap while a save runs does nothing; the primary rules (on clears it elsewhere and adds yours; other categories disabled while primary is on); the `newEventsGoTo` note once; the calendar sheet's Save sends its category, rule and spouse details and a failure keeps the typed values; the notes sheet; Back closes a sheet, else goes home; a he/ru render has no English left from the old copy ("Select Your Calendars", "Custom Rule", "Spouse Information", "Global Rules", "added to", "removed from") and no `title=`/`aria-label` in English.
- [ ] **Step 2:** run it; it fails on today's screen.
- [ ] **Step 3:** build; update the smokes listed above in the same commits; delete the dead components and keys.
- [ ] **Step 4:** run the new smoke, the updated ones, `smoke-calendar-connection.ts` (the route's E2/E3), `smoke-auth-identity.ts`, `smoke-key-rotation.ts`, the parity check, `smoke-he-neutral.ts`, `smoke-ru-formal.ts`, tsc, eslint, then `bash scripts/ci-smokes.sh`.
- [ ] **Step 5:** screenshots like W4-1's (`scratchpad/w4-2-shots/`): the screen in en light and he dark, a calendar's sheet with spouse details in he dark, the limit error in ru light, the empty state in en dark.
- [ ] **Step 6:** mutation-check the main behaviours (the body, the header credential, rollback, the primary rules, the limit, the lock); commit.

### Task 3: Docs

- [ ] Update the status line of `docs/superpowers/specs/2026-10-19-screens-and-colours-design.md` (W4-2: Select calendars in the app design; the 'telegram' look is gone). Commit `docs(select-calendars): …`.
