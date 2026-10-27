# W1a: the kit pieces and Settings on the shared layer, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings is rebuilt in the home's design from the approved mockup, on `components/app-ui`. The kit pieces it needs are built beside it.

**Architecture:**
- Task 1 adds kit pieces with no visible change to the home or the editor, apart from the switch's off outline:
  - ScreenHeader and SectionLabel;
  - Notice;
  - DayChips, lifted from the Repeat sheet;
  - a grouped ground on AppScreen;
  - a sticky SaveBar with a "Saved" status, plus small prop additions.
- Task 2 moves Settings' Google section onto the kit.
- Task 3 rebuilds SettingsClient on AppScreen and the kit:
  - it saves on the page;
  - its copy is rewritten in en/he/ru;
  - its PageGate look becomes `'app'`;
  - AppScope and PickerScope lose their last user and go.

**Tech Stack:** Next.js 16 client components; inline `<style>` CSS strings; next-intl; tsx smoke scripts with the fake DOM in `scripts/lib/fake-dom.ts`.

**Spec:** `docs/superpowers/specs/2026-10-19-screens-and-colours-design.md` §4, §5 (W1). The approved mockup is the canvas artboard `Settings.dc.html` (https://claude.ai/artifact/KJQjWZ7MFRRCr3A4raAQos); a copy is in the scratchpad at `w1-mockups/project/Settings.dc.html`. W1b (Subscription, Feedback, share-story) is a separate plan.

## Global Constraints

**Visual baseline:** no visible change on the home, the editor, the Repeat sheet or the pickers, except the switch's off track. It gains a 3:1 outline (spec §4: "an off track at 3:1"). Proof: the F1 screenshot harness, BASE against branch.

**Kit rules:**
- `components/app-ui` stays client-safe (smoke-app-ui #6).
- Kit components take already-translated strings; there is no `useTranslations` inside the kit.
- AppScreen is the only caller of `useTelegramBackButton` in a moved screen. ScreenHeader never calls it.

**CSS:**
- Logical properties only. No `:hover`. Font sizes in px, at least 11. Targets at least 44 px.
- No hex or rgb outside token blocks in any kit CSS string. The two named page-paint fallbacks are the exception (Task 1).
- New class names must be free. Grep before using one. Taken: `.ch-badge`, `.ch-empty*`, `.ch-state*`, `.ch-card*`, `.ch-banner*`, `.ch-chip`, `.ch-day`, `.ch-days`.

**Copy and i18n:**
- Strings in en/he/ru: Hebrew gender-neutral, Russian formal вы. Copy exactly as in the tables below.
- i18n parity passes. A key lands with its first use. Dead keys are deleted after a grep of `app components src scripts`.
- Brand words stay Latin in he/ru: Telegram, WhatsApp, Google, Pro, FamCal. The language endonyms "עברית", "English" and "Русский" are fixed option labels.

**Times and requests:**
- Times are 24-hour `HH:mm`, wrapped as `<bdi dir="ltr">` or in `dir="ltr"`.
- The `/api/settings` request is unchanged:
  - same route, same JSON keys and values for the same choices;
  - `initData` still rides in the body, now read with `readInitData()` (`src/lib/read-init-data.ts`).

**Gate:** `npx prisma generate && npx tsc --noEmit && npx eslint . && bash scripts/ci-smokes.sh && npx tsx scripts/check-i18n-parity.ts`. Never run `npm run build` or `next build`; the controller runs the build.

**Tests:** every new check is shown to fail with its fix removed, using file-backup mutations.

## Owner decisions in this plan (defaults taken; the owner may override at review)
1. **Location:**
   - the row opens a sheet, as in the mockup: a field, "Use my current location", and the checking or error line under it;
   - a detected place fills the field directly, replacing today's separate "Is this your location?" pop-up;
   - the sheet's close button reads "Done".
2. **Saving:**
   - Save stays on the page and shows "Saved", or the error, in the bar;
   - a save that changes the language reloads Settings in the new language: `router.replace('/{lang}/settings?user_id=…')`;
   - Back always returns to the calendar in the saved language.
3. **Day chips:** they keep the editor's shipped Repeat-chip look, because "mirror existing patterns" wins. The mockup's outline on days that are off is not drawn.
4. **Privacy note:** it is dropped from Settings. Its claim ("Your calendar data is never stored") is no longer true now that FamCal calendars are stored, and the privacy page covers the topic.
5. **Section order:**
   - Language and place;
   - Summaries;
   - When summaries arrive, with each time row followed by its own day chips;
   - Events and reminders, which also holds "Add events by voice";
   - Google Calendar.
6. **Kept settings:** every setting the mockup does not draw is kept, in the matching section.

## Review Focus
1. **Save with the location still checking or invalid:** Save stays disabled, and no request is sent. (Task 3, S5.)
2. **Language change:** saving reloads Settings in the new language. Back after an unsaved language pick goes to the calendar in the saved language. (Task 3, S4, S6.)
3. **Telegram back with a sheet open:** it closes only that sheet (location, time or disconnect). During the disconnect's "working" phase it does nothing. (Task 2, G3; Task 3, S6.)
4. **WhatsApp-only user** (saved platform `whatsapp`): the section shows only "Add events by voice" and the reminder-time row. After switching platform and saving, the section follows the saved value. (Task 3, S2.)
5. **Hebrew RTL and dark Telegram themes:**
   - chevrons flip, times stay LTR, the chip order mirrors;
   - with the light theme, the grouped ground paints Telegram's `secondary_bg_color`; with the dark theme, its `bg_color`;
   - all new contrast pairs hold. (Task 1, K5, K9; Task 3, S1.)

---

### Task 1: Kit pieces (no visible change except the switch's off outline)

**Files:**
- Create:
  - `components/app-ui/ScreenHeader.tsx` (ScreenHeader, SectionLabel);
  - `components/app-ui/Notice.tsx`;
  - `components/app-ui/DayChips.tsx`.
- Modify:
  - `components/app-ui/form-kit.tsx`: SwitchRow `disabled`; ButtonRow `valueDir`; SaveBar `sticky`/`status`/`disabled`; the off-track outline; FORM_CSS literals moved to tokens; the DayChips CSS;
  - `components/app-ui/screen.ts`: ScreenHeader, SectionLabel, Notice and grouped-ground CSS; the grouped html paint;
  - `components/app-ui/theme.ts`: tokens `--ch-switch-thumb`, `--ch-switch-thumb-shadow`;
  - `components/app-ui/AppScreen.tsx`: `ground` prop;
  - `components/app-ui/BottomSheet.tsx`: `closeDisabled`;
  - `src/lib/telegram-ui.ts`: `useTelegramTheme(ground)` and `applyTelegramColours(key)`;
  - `app/[locale]/dashboard/RepeatSheet.tsx`: adopts DayChips; its `.ch-day*` CSS is deleted;
  - `scripts/lib/css-resolve.ts`: new pairs.
- Test:
  - `scripts/smoke-app-ui.ts` (#2 lint over FORM_CSS too; #3 html rules; new K1–K9);
  - `scripts/smoke-calendar-home-render.ts` S10 and #86 (the renamed chip class);
  - any smoke that queries `.ch-day` in the Repeat sheet (grep first).

**Interfaces (produced, exact):**
```ts
// ScreenHeader.tsx
export function ScreenHeader(props: { title: string; backLabel: string; onBack?: (() => void) | null }): JSX.Element
// <header class="ch-screen-head"> [in-page back: <button type="button" class="ch-icon-btn ch-icon-btn-plain" aria-label={backLabel}>
//   <svg class="ch-flip" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>] <h1 class="ch-screen-title">{title}</h1></header>
// The in-page back renders only when onBack is set and NOT (isInTelegram() && telegramSupports('6.1')).
// It uses useSyncExternalStore; the server snapshot is "in Telegram" (no in-page back).
export function SectionLabel(props: { children: ReactNode }): JSX.Element   // <h2 class="ch-section-label">

// Notice.tsx
export function Notice(props: { tone?: 'info' | 'error'; children: ReactNode; action?: { label: string; onClick: () => void } }): JSX.Element
// <div class="ch-notice [ch-notice-error]" role={tone==='error' ? 'alert' : 'status'}><p class="ch-notice-text">…</p>
//  [<button type="button" class="ch-notice-action">{label}</button>]</div>

// DayChips.tsx
export interface DayChip { id: string; short: string; full: string; on: boolean; pinned?: boolean }
export function DayChips(props: { label: string; days: DayChip[]; onToggle: (id: string) => void; describedBy?: string }): JSX.Element
// <div class="ch-daychips" role="group" aria-label={label}>
//   <button type="button" class="ch-daychip" data-day={id} aria-pressed={on} aria-disabled={pinned || undefined}
//           aria-describedby={pinned ? describedBy : undefined} aria-label={full}>{short}</button>…
// A click on a pinned chip does nothing.

// form-kit.tsx (added props; existing call sites unchanged)
SwitchRow({ label, hint, checked, onChange, disabled? })   // disabled → aria-disabled="true", click ignored, no dimming
ButtonRow({ label, hint, value, onClick, error, valueDir? }) // valueDir 'ltr' → value as <bdi dir="ltr">
SaveBar({ label, busy, error, onSave, status?, disabled?, sticky? })
// status → <p class="ch-save-status" role="status">; disabled → button disabled; sticky → adds class ch-save-bar-sticky

// AppScreen.tsx
AppScreen({ className, onBack, rootRef, ground?: 'plain' | 'grouped', children }) // grouped → root class ch-grouped
// BottomSheet.tsx
BottomSheet({ label, closeLabel, onClose, variant, closeDisabled?, children }) // closeDisabled → the close button disabled; Escape and the scrim ignored
// telegram-ui.ts
export function applyTelegramColours(key: 'bg_color' | 'secondary_bg_color' = 'bg_color'): void
export function useTelegramTheme(ground: 'plain' | 'grouped' = 'plain'): ColorScheme
// grouped and light → 'secondary_bg_color'; otherwise 'bg_color'; re-applied on themeChanged with the scheme of that moment
```

**CSS (values from the mockup, on tokens):**
- `.ch-screen-head`: flex, center, gap 4px; padding 12px 16px 8px; with the in-page back, `padding-inline-start: 8px`.
- `.ch-screen-title`: 22px/600, margin 0.
- `.ch-icon-btn-plain`: transparent background, with `.ch-icon-btn` geometry (44×44).
- `.ch-section-label`: 13px/600 `--ch-muted`; `margin-block: 14px 6px`; `padding-inline: 4px`. The first one in a page has `margin-block-start: 4px`.
- `.ch-notice`:
  - radius 14, padding 12px 14px, `--ch-section` background, `--ch-text`, 14px;
  - `.ch-notice-error` text is `--ch-danger`;
  - `.ch-notice-action`: accent 14px/600, min-block-size 44, transparent, `padding-inline: 0`.
- `.ch-grouped`:
  - `.ch-screen.ch-grouped { background: var(--ch-surface) }`;
  - `.ch-app.ch-grouped[data-theme='dark'] { background: var(--ch-bg) }`.
- Html paint rules, in this order:
  1. `html:has(.ch-screen)`;
  2. `html:has(.ch-screen.ch-grouped) { background: var(--tg-theme-secondary-bg-color, #f3f2f8) }`;
  3. `html:has(.ch-screen[data-theme='dark'])`.

  The dark rule then wins for a dark grouped screen.
- DayChips: the Repeat sheet's `.ch-days` / `.ch-day` rules, unchanged in value, renamed to `.ch-daychips` / `.ch-daychip`, moved to FORM_CSS. Keep the `prefers-reduced-motion: no-preference` transition guard.
- Switch:
  - `.ch-switch` (off) gains `box-shadow: inset 0 0 0 1.5px var(--ch-done)`;
  - `.ch-switch.is-on` sets `box-shadow: none`;
  - `::after` uses `--ch-switch-thumb` (#ffffff in both themes) and `--ch-switch-thumb-shadow` (`0 1px 3px rgba(0, 0, 0, 0.25)`, a literal-text token).
- `.ch-save-bar-sticky`: `position: sticky; inset-block-end: 0; border-block-start: 1px solid var(--ch-separator)`. `.ch-save-bar { flex: none }` stays (#86).
- `.ch-save-status`: 13px `--ch-muted`, centered.

- [ ] **Step 1: Write the failing checks in `scripts/smoke-app-ui.ts`:**
  - K1 ScreenHeader:
    - in a browser (no initData), the in-page back has `aria-label`; a tap calls `onBack`; the svg has `ch-flip`;
    - in Telegram 7.7 there is no in-page back;
    - in Telegram 6.0 the in-page back renders;
    - there is no `useTelegramBackButton(` in the file.
  - K2 SectionLabel is an `h2.ch-section-label`.
  - K3 Notice: role `status` by default, `alert` for error; the action button calls `onClick`.
  - K4 DayChips: the group label; `aria-pressed`; `aria-label` = full name; a pinned chip carries `aria-disabled` and `aria-describedby`, and a click on it calls nothing; a click on another chip calls `onToggle(id)`.
  - K5 AppScreen `ground="grouped"`:
    - the root class has `ch-grouped`;
    - light, Telegram 7.7: `setHeaderColor('secondary_bg_color')` and `setBackgroundColor('secondary_bg_color')`;
    - dark: `bg_color`;
    - a `themeChanged` event to dark re-applies `bg_color`;
    - plain screens are unchanged (#4).
  - K6 SwitchRow `disabled`: `aria-disabled="true"`, and a click does not call `onChange`.
  - K7 ButtonRow `valueDir="ltr"` renders `<bdi dir="ltr">09:15</bdi>`.
  - K8 SaveBar: `status` renders `role="status"`; `disabled` disables the button; `sticky` adds the class.
  - K9 BottomSheet `closeDisabled`: the close button is disabled, and Escape does not call `onClose`.
  - Extend #2's `CSS` to `APP_THEME_CSS + APP_SCREEN_CSS + FORM_CSS`. Exempt exactly two declarations: the dark paint and the grouped paint. Assert their fallbacks equal the dark `--ch-bg` and light `--ch-surface` fallbacks.
  - Extend #3's html-rule list to the three selectors above, in that order.
  - Append contrast pairs:
    - TEXT_PAIRS: `--ch-muted/--ch-surface`, `--ch-text/--ch-section`, `--ch-muted/--ch-section`, `--ch-danger/--ch-section`, `--ch-danger/--ch-surface`, `--ch-accent/--ch-section`, `--ch-text/--ch-surface`;
    - MARK_PAIRS: `--ch-done/--ch-section` (the off outline), `--ch-button/--ch-section` (the on track).
- [ ] **Step 2: Run** `bash <S>/run-smoke.sh scripts/smoke-app-ui.ts`. Expected: FAIL on K1–K9, #2 and #3.
- [ ] **Step 3: Implement** the interfaces and CSS above. RepeatSheet renders `<DayChips>` with its own strings and pinned rule; its markup is otherwise the same.
- [ ] **Step 4: Run** smoke-app-ui, smoke-calendar-home-render (S10 and #86 updated to `.ch-daychip` in FORM_CSS) and every smoke that greps the Repeat chips. Expected: PASS.
- [ ] **Step 5: Screenshot proof.**
  - Use the F1 harness (`<S>/f1-proof/proof.ts`) with a BASE checkout at this plan's BASE. Render all 80 pairs.
  - Expected: identical, except pairs that show an off switch (the editor sheets).
  - For those, install `pngjs` in the scratch folder and report that every differing pixel lies inside a switch track's box.
  - Remove the BASE checkout.
- [ ] **Step 6: Mutations.** Each must fail its check:
  - ScreenHeader shows the in-page back in Telegram 7.7 (K1);
  - DayChips calls `onToggle` for a pinned chip (K4);
  - grouped uses `bg_color` in light (K5);
  - remove the off outline (the `--ch-done` pair cannot pass);
  - a hex in FORM_CSS (#2);
  - SaveBar ignores `disabled` (K8);
  - BottomSheet ignores `closeDisabled` on Escape (K9).
- [ ] **Step 7: Gate, then commit** `feat(app-ui): ScreenHeader, SectionLabel, Notice, DayChips, a grouped ground and a sticky SaveBar; the switch's off track at 3:1`.

### Task 2: The Google section on the kit

**Files:**
- Modify: `app/[locale]/settings/GoogleDisconnect.tsx`. The `GoogleDisconnectView` / `GoogleDisconnect` split, its props, and `google-disconnect-client.ts` are kept; `GOOGLE_DISCONNECT_CSS` and every `gd-*` class are deleted.
- Test: `scripts/smoke-google-disconnect-ui.ts`.

**Interfaces:**
- Consumes: SectionLabel, FormCard, SwitchRow, Notice, BottomSheet (`closeDisabled`), `.ch-btn`.
- Produces:
  - `GoogleDisconnect({ userId, connected, onDisconnected, onSheet? })`;
  - `onSheet?: (close: (() => void) | null) => void` is called with the sheet's closer while the sheet is open (a no-op closer during `working`) and with `null` when it closes;
  - `GoogleDisconnectView` gains no new props. The parent's back handling comes through `onSheet`.

**Markup:**
- **Section:** `<SectionLabel>{sectionTitle}</SectionLabel>`, then a FormCard holding:
  - a hint row (`.ch-form-row` with a `.ch-form-hint`, text `sectionHint`);
  - one `<button type="button" class="ch-form-row ch-danger-row">`, label `button`, text in `--ch-danger`.
- **Not connected and idle:** returns `null`, so the render is `''`.
- **The dialog** is `<BottomSheet label={confirmTitle or doneTitle} closeLabel={cancel, or close when done} closeDisabled={phase==='working'}>`:
  - **confirm and working:**
    - `<h2 class="ch-sheet-heading">`, `confirmBody`, `confirmShared`;
    - a FormCard with `<SwitchRow label={copiesLabel} hint={copiesHint} checked={deleteCopies} disabled={working}>`;
    - `copiesKeptNote` as `.ch-form-fixed`;
    - an error, if any, as `<Notice tone="error">`;
    - while working, a `.ch-loader`-style line with `.ch-spin` and `working`;
    - a primary danger button `confirm`, disabled while working. The sheet's own close button is the Cancel.
  - **done:** the heading `doneTitle`, then `doneBody`. With leftovers, `leftoverIntro` and `<ul>` of `<li dir="auto">`. The close button reads `close`.
- `.ch-danger-row` and `.ch-btn-danger` (danger text, and a danger fill with `--ch-button-text`) go into FORM_CSS. Contrast pair: `--ch-button-text/--ch-danger` (TEXT).

- [ ] **Step 1: Rewrite the checks in `scripts/smoke-google-disconnect-ui.ts`.** Content stays; markup moves to the kit.
  - G1 section: the title, the hint, exactly one button with `button`'s text. Not connected and idle renders `''`.
  - G2 confirm:
    - `role="dialog"` and `aria-modal`;
    - all six texts;
    - a `role="switch"` with `aria-checked="true"` by default, `false` after a toggle;
    - Cancel (the sheet close) and Disconnect buttons;
    - the copy rule on `errorFailed` stays.
  - G3 working:
    - the `working` text and `.ch-spin`;
    - the switch has `aria-disabled`;
    - Disconnect is disabled; the close button is disabled;
    - `onSheet`'s closer does nothing.
  - G4 done: as today, with `close` as the close label.
  - G5 look:
    - every class is a `ch-*` kit class;
    - no `gd-` anywhere in `app/`;
    - no raw key, no emoji, every svg `aria-hidden`.
  - The client checks and the wiring check stay. Update the source regex if the prop list changes.
  - Delete the old `gd-` CSS and contrast checks, and replace them with the danger pair in smoke-app-ui #2b.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it and smoke-app-ui. Expected: PASS.
- [ ] **Step 5: Mutations:**
  - the close stays enabled while working (G3);
  - `onSheet` is never called (G3);
  - a leftover `gd-` class (G5).
- [ ] **Step 6: Gate, then commit** `feat(settings): the Google section and its confirm sheet on the kit`.

### Task 3: Settings on AppScreen and the kit

Invoke the `frontend-design:frontend-design` skill once before this task. The direction is fixed: the approved mockup, the home's tokens and the kit. No new visual language.

**Files:**
- Create:
  - `app/[locale]/settings/settings-body.ts`: `buildSettingsBody(state, nativeRemindersSupported, initData)`, the exact JSON the page posts today;
  - `app/[locale]/settings/location-lookup.ts`: `MAX_LOCATION_PLACE_RANK`, `VALID_LOCATION_TYPES`, `buildPlaceName`, `validateLocation(query)` and `reverseLookup(lat, lon)`, moved verbatim from SettingsClient. The silent `catch {}` gets a `console.warn('[settings] location check failed:', error)`;
  - `app/[locale]/settings/LocationSheet.tsx`;
  - `scripts/smoke-settings-render.ts`.
- Modify:
  - `app/[locale]/settings/SettingsClient.tsx`: rewritten; props unchanged, so `page-data.ts` is untouched;
  - `app/[locale]/PageGate.tsx`: `LOOK.settings: 'app'`; the Settings `dynamic()` uses `appLoader`; the header comment says only select-calendars, calendars and pair keep the old looks;
  - `app/[locale]/dashboard/TimePickerSheet.tsx`: the `standalone` prop is deleted;
  - `app/[locale]/dashboard/picker-kit.tsx`: `PickerScope` is deleted;
  - `components/app-ui/AppScreen.tsx`: `AppScope` is deleted;
  - `src/lib/telegram-ui.ts`: `useColorScheme` is deleted if it has no caller left (grep);
  - `messages/{en,he,ru}.json`: the `settings` namespace replaced by the table below (`googleDisconnect.*` kept as is); `ui.back`, `ui.save`, `ui.saved` and `ui.done` added.
- Test (updated):
  - `scripts/smoke-date-picker-render.ts`: the Settings checks become the new pill check; the PickerScope and AppScope checks are deleted;
  - `scripts/smoke-app-ui.ts`: #5 loses SettingsClient; #4c is deleted;
  - `scripts/smoke-miniapp-gate.ts`: #18 `['settings','app']`;
  - `scripts/smoke-reminder-time.ts`: keys kept.

**Screen structure:**
- **Root:** `<AppScreen ground="grouped" onBack={backHandler}>`, then `<style>{FORM_CSS}</style>`, then `<ScreenHeader title backLabel={ui.back} onBack={backHandler}>`, then `<div class="ch-form-page">` with the sections, then `<SaveBar sticky …>`.
- **Back handler:** `backHandler` = the open sheet's closer (time, location, or the Google sheet via `onSheet`). Otherwise it is `() => router.push('/{saved.language}/dashboard?user_id={userId}')`.
- **Language and place** (FormCard):
  - Language: ValueRow, hint `language.hint`, options in endonyms;
  - Location: ButtonRow, value = location or `location.notSet`, hint `location.hint`, error = the location error. It opens LocationSheet;
  - Calendar culture: ValueRow, hint `culture.hint`, options `culture.general` / `culture.jewish`. On change it keeps today's day reset: jewish gives daily `[0,1,2,3,4,5]` and tomorrow `[0,1,2,3,4,6]`, otherwise both `[0..6]`;
  - Send messages to: ValueRow; the options are Telegram, WhatsApp and `platform.both`.
- **Summaries** (FormCard):
  - SwitchRows for text, voice, weather, week ahead and seven days;
  - text and voice add the hint `usage` with `{used, limit}` when their limit is above 0.
- **When summaries arrive** (FormCard):
  - Morning summary: ValueRow, 24 options `HH:00`;
  - a day-chips block: a 13px muted label `morning.days`, then DayChips over `dailySummaryDays`;
  - Evening summary: ValueRow;
  - a day-chips block over `tomorrowSummaryDays`.
  - Chips are Sunday-first. The labels are `calendarHome.editor.repeat.dayShort` / `dayLong` with the weekday id (sun…sat ↔ 0…6).
  - The last day that is on is pinned and described by `<p id class="ch-form-fixed">oneDayStays</p>`; the hint shows only while one day is left.
- **Events and reminders** (FormCard; the alerts rows key off the SAVED platform):
  - Add events by voice: SwitchRow (every platform);
  - not WhatsApp:
    - the Event alerts SwitchRow, `disabled` unless globally enabled and the plan allows. Its hint is `alerts.hint`, or `alerts.comingSoon` when not globally enabled;
    - when globally enabled but not allowed, a `<Notice action={{label: alerts.seePlans, onClick: push('/{saved.language}/subscription?user_id=…')}}>alerts.proOnly</Notice>` under the card;
    - when alerts are on, allowed and globally enabled, Default alert (ValueRow, options 5/10/15/30/60 as `defaultAlert.option`) and Pickup alerts (SwitchRow);
  - if `nativeRemindersSupported`: a ButtonRow with `reminderTime`, value `HH:mm`, `valueDir="ltr"` and hint `reminderTimeHelp`. It opens `TimePickerSheet` with step `REMINDER_TIME_STEP_MINUTES`, keeping the static import line.
- **Google section:** `<GoogleDisconnect … onSheet={…}>` from Task 2.
- **Save bar:**
  - label `ui.save`;
  - `disabled` when there is no change against the saved baseline, or while the location is checking or has an error;
  - `busy` while the save is in flight;
  - `status={ui.saved}` after a save until the next change;
  - `error={saveFailed}` after a failure. The controls stay usable.
- **State:**
  - a `saved` baseline, starting from props and replaced on success with the posted values;
  - `isDirty` compares against `saved`;
  - the 2-second redirect and the full-page success view are gone.
- **LocationSheet** (`<BottomSheet label={location.label} closeLabel={ui.done}>`):
  - a TextField with `location.placeholder`;
  - a `ch-btn` "Use my current location";
  - a `role="status"` line for `location.checking`, and a FieldError for `location.notFound`, `location.checkFailed`, `location.noDeviceLocation` or `location.deviceFailed`;
  - closing validates a changed value with `validateLocation` and stores the normalized name;
  - device location calls `reverseLookup`, then fills the field. No `window.alert` remains anywhere.
- **Telegram:**
  - the effect that set `#667eea` / `#ffffff` is deleted, and `TelegramLayout` and styled-jsx are gone;
  - `useTelegramVerticalSwipes(sheetOpen)` stays.

**Copy:** `settings` namespace (exact; `googleDisconnect.*` unchanged).

| Key | en | he | ru |
|---|---|---|---|
| title | Settings | הגדרות | Настройки |
| saveFailed | Couldn't save. Try again. | לא הצלחנו לשמור. כדאי לנסות שוב. | Не получилось сохранить. Попробуйте ещё раз. |
| sections.place | Language and place | שפה ומיקום | Язык и место |
| sections.summaries | Summaries | סיכומים | Сводки |
| sections.timing | When summaries arrive | מתי מגיעים הסיכומים | Когда приходят сводки |
| sections.events | Events and reminders | אירועים ותזכורות | События и напоминания |
| language.label | Language | שפה | Язык |
| language.hint | For the app, the bot and your summaries | לאפליקציה, לבוט ולסיכומים | Для приложения, бота и сводок |
| location.label | Location | מיקום | Местоположение |
| location.hint | For the weather and your time zone | למזג האוויר ולאזור הזמן | Для погоды и часового пояса |
| location.notSet | Not set | לא הוגדר | Не указано |
| location.placeholder | For example, Tel Aviv | למשל, תל אביב | Например, Тель-Авив |
| location.useCurrent | Use my current location | להשתמש במיקום הנוכחי | Использовать текущее местоположение |
| location.checking | Checking… | בודקים… | Проверяем… |
| location.notFound | We couldn't find this place. Check the spelling. | לא מצאנו את המקום הזה. כדאי לבדוק את האיות. | Не нашли такое место. Проверьте написание. |
| location.checkFailed | We couldn't check this place right now. Try again. | לא הצלחנו לבדוק את המקום כרגע. אפשר לנסות שוב. | Сейчас не получилось проверить место. Попробуйте ещё раз. |
| location.noDeviceLocation | This device doesn't share its location. Type the place instead. | המכשיר לא משתף מיקום. אפשר להקליד את המקום. | Устройство не передаёт местоположение. Введите место вручную. |
| location.deviceFailed | We couldn't tell where you are. Type the place instead. | לא הצלחנו לזהות את המיקום. אפשר להקליד אותו. | Не удалось определить местоположение. Введите его вручную. |
| culture.label | Calendar culture | לוח שנה | Календарь |
| culture.hint | Jewish adds Hebrew dates and holidays to your summaries | ״יהודי״ מוסיף לסיכומים תאריכים עבריים וחגים | «Еврейский» добавляет в сводки еврейские даты и праздники |
| culture.general | General | כללי | Обычный |
| culture.jewish | Jewish | יהודי | Еврейский |
| platform.label | Send messages to | לאן לשלוח הודעות | Куда присылать сообщения |
| platform.both | Both | לשניהם | В оба |
| text.label | Text summary | סיכום בטקסט | Текстовая сводка |
| text.hint | Your schedule as a chat message | הלו״ז בהודעה בצ׳אט | Расписание сообщением в чате |
| voice.label | Voice summary | סיכום קולי | Голосовая сводка |
| voice.hint | A short radio show with two hosts | תוכנית רדיו קצרה עם שני מגישים | Короткое радиошоу с двумя ведущими |
| weather.label | Weather | מזג אוויר | Погода |
| weather.hint | Add the forecast to your summary | התחזית בתוך הסיכום | Прогноз погоды в сводке |
| weekAhead.label | The week ahead | השבוע הקרוב | Неделя вперёд |
| weekAhead.hint | Upcoming events in the evening summary | אירועים קרובים בסיכום של הערב | Ближайшие события в вечерней сводке |
| sevenDays.label | Always 7 days ahead | תמיד 7 ימים קדימה | Всегда на 7 дней вперёд |
| sevenDays.hint | Not just until the end of the week | לא רק עד סוף השבוע | А не только до конца недели |
| usage | {used} of {limit} used this month | נוצלו {used} מתוך {limit} החודש | В этом месяце: {used} из {limit} |
| morning.label | Morning summary | סיכום הבוקר | Утренняя сводка |
| morning.days | Morning summary on | סיכום הבוקר בימים | Утренняя сводка по дням |
| evening.label | Evening summary | סיכום הערב | Вечерняя сводка |
| evening.days | Evening summary on | סיכום הערב בימים | Вечерняя сводка по дням |
| oneDayStays | At least one day stays on | לפחות יום אחד נשאר מסומן | Хотя бы один день остаётся выбранным |
| voiceInput.label | Add events by voice | הוספת אירועים בקול | Добавлять события голосом |
| voiceInput.hint | Send the bot a voice message and the event is added | שולחים לבוט הודעה קולית, והאירוע נוסף | Отправьте боту голосовое сообщение, и событие добавится |
| alerts.label | Event alerts | התראות לפני אירועים | Уведомления о событиях |
| alerts.hint | A Telegram message before an event starts | הודעה בטלגרם לפני שאירוע מתחיל | Сообщение в Telegram перед началом события |
| alerts.comingSoon | Coming soon | בקרוב | Скоро |
| alerts.proOnly | Event alerts come with Pro. | התראות לפני אירועים כלולות ב־Pro. | Уведомления о событиях входят в тариф Pro. |
| alerts.seePlans | See plans | למסלולים | Посмотреть тарифы |
| defaultAlert.label | Default alert | התראה כברירת מחדל | Уведомление по умолчанию |
| defaultAlert.hint | For events without an alert of their own | לאירועים שאין להם התראה משלהם | Для событий без своего уведомления |
| defaultAlert.option | {minutes} min before | {minutes} דק׳ לפני | За {minutes} мин |
| pickup.label | Pickup alerts | התראות איסוף | Когда забирать детей |
| pickup.hint | For kids' calendars, an alert when an event ends | ביומנים של הילדים, התראה גם כשאירוע נגמר | Сообщение, когда событие в детском календаре заканчивается |
| reminderTime | Reminders without a time | תזכורות בלי שעה | Напоминания без времени |
| reminderTimeHelp | They arrive at this time, and so do reminders put off to tomorrow | הן מגיעות בשעה הזאת, וגם תזכורות שנדחו למחר | Приходят в это время, как и напоминания, отложенные на завтра |

`ui` additions: `back` Back | חזרה | Назад · `save` Save | שמירה | Сохранить · `saved` Saved | נשמר | Сохранено · `done` Done | סיום | Готово.

Every other key in the old `settings` namespace is deleted, including the 19 dead keys, `privacyNote` and `days.*`, after a grep.

- [ ] **Step 1: Write `scripts/smoke-settings-render.ts`**, using smoke-app-ui's helpers: `inIntl`, `mount`, `fakeTelegram`, a router stub, and a fake `fetch` that records requests.
  - S1 render, en/he/ru × light/dark:
    - root `ch-app ch-screen ch-grouped` with `dir` and `lang`;
    - the four section labels in order;
    - no raw key (`/settings\.|ui\./`), no emoji;
    - he/ru carry no Latin letters outside the brand words and endonyms;
    - time values in `dir="ltr"` or `<bdi dir="ltr">`.
  - S2 the state matrix:
    - Telegram with alerts allowed: alerts, default alert, pickup and reminder time;
    - not allowed: `proOnly` plus `seePlans`, which pushes `/{lang}/subscription?user_id=1`;
    - not globally enabled: `comingSoon`, and the switch is `aria-disabled`;
    - saved platform `whatsapp`: only voice input and reminder time;
    - `nativeRemindersSupported` false: no reminder-time row;
    - Google connected: the Google section;
    - the usage hint appears only when the limit is above 0;
    - switching the platform select does not change the section until a save succeeds.
  - S3 `buildSettingsBody` deep-equals today's body for two fixtures (alerts on and off; reminder time supported and not). The expected objects are written out in the test.
  - S4 save:
    - Save is disabled while clean;
    - a change enables it; a tap posts once to `/api/settings?user_id=1`;
    - an OK answer shows the `ui.saved` status, and Save is disabled again;
    - a 500 shows `saveFailed` as `role="alert"` and the controls stay enabled;
    - a saved language change calls `router.replace('/ru/settings?user_id=1')`.
  - S5 location:
    - an invalid place gives the error under the row, Save stays disabled, and no request is sent;
    - while checking, Save stays disabled;
    - no geolocation gives `noDeviceLocation`, and `window.alert` is never called.
  - S6 back:
    - AppScreen is the only BackButton caller;
    - with the time sheet, the location sheet or the Google sheet open, a back tap closes only that sheet;
    - otherwise it pushes `/{saved language}/dashboard?user_id=1`, even after an unsaved language pick.
  - S7 chips:
    - a toggle changes the chips;
    - the last day that is on is pinned and described by `oneDayStays`;
    - culture → jewish resets the days as specified.
  - S8 ScreenHeader: in a browser the in-page back calls the same handler; in Telegram 7.7 there is none.
  - S9 no React warnings.
- [ ] **Step 2: Run** it. Expected: FAIL. The old client has no grouped root and different markup.
- [ ] **Step 3: Implement.** Files, PageGate, messages and the deletions as listed. Update the smokes named under Test.
- [ ] **Step 4: Run** the new smoke, smoke-date-picker-render, smoke-app-ui, smoke-miniapp-gate, smoke-google-disconnect-ui, smoke-reminder-time and i18n parity. Expected: PASS.
- [ ] **Step 5: Screenshots for the controller** (scratch, not committed):
  - Settings at 360×780: he light, en dark, ru light, he dark with Telegram's dark params;
  - plus the location sheet open (he light) and the Google confirm (en dark).
  - Save the PNGs and list the paths in the report.
- [ ] **Step 6: Mutations.** Each must fail its check:
  - Save enabled while checking (S5);
  - Back uses the unsaved language (S6);
  - the alerts section keyed to the platform state (S2);
  - `buildSettingsBody` sends `defaultReminderMinutes` when alerts are off (S3);
  - a leftover `window.alert` (S5);
  - LOOK.settings back to `'telegram'` (gate #18).
- [ ] **Step 7: Gate, then commit** `feat(settings): Settings in the home's design on the kit; saves on the page; copy rewritten in en/he/ru; the app look`.

## After the build (controller)
- One Opus whole-branch review against this plan and spec §4–§5.
- One fix round.
- Mutation spot checks.
- The fresh-clone CI mirror.
- Fast-forward main, push, then CI and Railway, a notification and the memory.
- The owner's phone checks:
  - Settings in he and en, light and dark;
  - change the language and save;
  - the location sheet;
  - switches and day chips;
  - Telegram's back with a sheet open.
