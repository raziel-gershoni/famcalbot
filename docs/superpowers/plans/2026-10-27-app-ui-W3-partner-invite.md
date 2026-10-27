# W3: Partner and Invite on the shared layer, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the Partner screen (`/pair`) and the invite landing (`/invite/[token]`) are rebuilt in the home's design on `components/app-ui`, with a copy-link field and an unlink confirm sheet.

**Architecture:**
- **Task 1** adds a kit `CopyField`, then rebuilds PairClient on AppScreen, with:
  - the grouped ground;
  - ScreenHeader;
  - FormCard rows;
  - Notice;
  - a BottomSheet to confirm the unlink.

  `LOOK.pair` becomes `'app'`.
- **Task 2** rebuilds the public invite landing (server page plus InviteClient) on AppScreen and StateCard. It stays outside PageGate, because anyone with the link may see it.

**Tech Stack:** Next.js 16; inline CSS strings; next-intl; tsx smokes with `scripts/lib/fake-dom.ts` (loud on unknown selectors) and `scripts/lib/fake-markup.ts` (hydration).

**Spec:** `docs/superpowers/specs/2026-10-19-screens-and-colours-design.md` §4–§5 (W3: "headers, a copy-link field, a confirm sheet for unlink"). The "about 120 strings moved into messages" part is already done: both screens read `pair.*` and `invite.*` today. No mockup was drawn for W3; the screens use the W1 kit and Settings' layout.

## Global Constraints

**Kit and screen rules** (as W1):
- `components/app-ui` stays client-safe. Kit components take translated strings.
- AppScreen is the only `useTelegramBackButton` caller. After this plan, smoke-app-ui #5's allow-list is `CalendarsClient`, `AppScreen` and `telegram-ui`.
- Logical CSS only. No `:hover`. Font sizes of at least 11 px; targets of at least 44 px.
- No hex outside token blocks. New class names must be free; grep first.
- No emoji in the UI; icons come from lucide.

**Requests are unchanged:**
- `/api/pair/invite` POST and DELETE, `/api/pair` DELETE and `/api/pair/accept` POST keep their URLs and bodies (`initData` in the body).
- Pair reads `initData` with `readInitData()`.
- The invite page keeps the Telegram user id it reads today as `user_id`. Never swap `user.id` and `telegramId`.
- `getInviteByToken`, the deep links (`t.me/<bot>?start=invite_<token>`, `wa.me/<n>?text=accept <token>`) and page-data's `pair()` props are unchanged.

**Times:**
- Shown dates and times use 24-hour `HH:mm` (`hourCycle: 'h23'`), in the device's zone as today.
- Today's English `timeStyle: 'short'` shows "3:45 PM"; that goes.
- First grep `src/` for an existing 24-hour date-time formatter and reuse it.

**Copy:**
- The existing `pair.*` and `invite.*` copy stays except for the changes in the table below.
- New strings are in en/he/ru, with gender-neutral Hebrew and formal Russian.
- smoke-pair-invite-copy's rules keep holding, including the pinned ru `invite.title`.

**Gate:** `npx prisma generate && npx tsc --noEmit && npx eslint . && bash scripts/ci-smokes.sh && npx tsx scripts/check-i18n-parity.ts`. Never run a build.

**Tests:** every new check is shown to fail with its fix removed.

## Owner decisions (defaults)
1. **No mockup:** the two screens are built from the same pieces as Settings. Sketches:
   - **Partner, paired:** header "Partner sharing"; a card with the partner's name and "Since 3 Oct 2026"; a red "Unlink" row.
   - **Partner, not paired:** header; the intro line; when a link exists, a card holding the link (LTR) with a Copy button, "Expires …", and a "Revoke link" row; then the "Generate invite link" button.
   - **Invite:** a centred card with the title, the subtitle and the Accept button (in Telegram), or "Open in Telegram" and then "Open in WhatsApp" (outside it); the expiry line under it.
2. **Unlink:** asks in a bottom sheet instead of the browser's confirm pop-up. The sheet says that both people stop seeing each other's calendars and that shared calendars go back to private, as the server already does.
3. **Copy button:** it shows a check mark and says "Copied" (to screen readers too). If copying is blocked, the link text is selected so a long-press copies it.
4. **Emoji:** 🤝, 🎉 and ⌛ go, with no icon in their place. The copy carries it.
5. **Times:** shown 24-hour.
6. **Invite after accepting:** a "You are now paired with {name}" card with Close. "You two are already paired" shows as information, not as an error, and the Accept button goes, as today.

## Review Focus
1. **The unlink sheet:**
   - Telegram's back closes only the sheet, and does nothing while the unlink is working;
   - a failure keeps the sheet open with the error;
   - a success shows the not-paired view.

   (Task 1, P3.)
2. **Copy blocked** (no clipboard API, or a reject): no "Copied", the field's text is selected, and the error is logged. (Task 1, K1.)
3. **Link lifecycle:**
   - generate when one exists: the new link replaces the old one, as the server revokes it;
   - revoke: back to "Generate";
   - `INVITER_ALREADY_PAIRED` gives its message;
   - each button is busy only while its own request runs, and every action is disabled while any request runs.

   (Task 1, P2, P4.)
4. **The invite landing's states:**
   - in Telegram, Accept;
   - in a browser, the two deep links, Telegram first;
   - an expired or invalid token gives the crash card with its home link;
   - already paired together: information, no Accept;
   - each other error code gives its own message.

   No hydration mismatch: the Telegram check runs after mount. (Task 2, V1–V4.)
5. **Hebrew and dark:**
   - the URL field stays LTR, and dates are 24-hour;
   - the grouped ground in light Telegram uses `secondary_bg_color`, and Pair's loader is grouped too (`GROUND.pair`);
   - the new contrast pairs hold.

   (Tasks 1–2, render checks.)

---

### Task 1: CopyField and the Partner screen

**Files:**
- Create:
  - `components/app-ui/CopyField.tsx`;
  - `scripts/smoke-pair-render.ts`.
- Modify:
  - `components/app-ui/form-kit.tsx`: `.ch-copy-field*` CSS in FORM_CSS;
  - `app/[locale]/pair/PairClient.tsx`: rewritten, with props unchanged;
  - `app/[locale]/PageGate.tsx`: `LOOK.pair = 'app'`, `GROUND.pair = 'grouped'`, Pair's `dynamic()` uses the grouped app loader, and the header comment (only select-calendars and calendars keep old looks);
  - `messages/{en,he,ru}.json`: the `pair` changes below, plus `ui.cancel`;
  - smokes: smoke-app-ui #5 (drop PairClient), smoke-miniapp-gate #18 (`['pair','app']`, `GROUND.pair`), smoke-pair-invite-copy (keep intents) and any other smoke that pins the old Pair markup.

**Interfaces (produced):**
```ts
// CopyField.tsx
export function CopyField(props: { label: string; value: string; copyLabel: string; copiedLabel: string }): JSX.Element
// <div class="ch-copy-field">
//   <input class="ch-copy-field-input" readOnly dir="ltr" aria-label={label} value={value} />
//   <button type="button" class="ch-icon-btn ch-copy-field-btn" aria-label={copied ? copiedLabel : copyLabel}>
//     {copied ? <Check aria-hidden/> : <Copy aria-hidden/>}</button>
//   <span class="ch-visually-hidden" role="status">{copied ? copiedLabel : ''}</span></div>
// Tap: navigator.clipboard.writeText(value). On success, "copied" for 2 s. On a missing API or a reject:
// console.warn('[copy] clipboard unavailable:', error), then select the input's text. Never throws.
```

**CopyField CSS** (FORM_CSS, tokens only):
- `.ch-copy-field`: flex, center, gap 8, `padding: 8px 8px 8px 14px` (logical), at least 44 px.
- `.ch-copy-field-input`: `flex: 1`, `min-inline-size: 0`, transparent, no border, 15 px `--ch-text`, `text-overflow: ellipsis`.
- `.ch-copy-field-btn`: the kit's 44 px icon button, in `--ch-accent`.

**Screen:**
- **Root:** `<AppScreen ground="grouped" onBack={back}>`, then `<style>{FORM_CSS}</style>`, then `<ScreenHeader title={pair.title} backLabel={ui.back} onBack={back}>`, then `<div class="ch-form-page">`.
- **`back`:** the unlink sheet's closer if it is open (a no-op while working); otherwise `router.push('/{locale}/dashboard?user_id={userId}')`.
- **Errors:** `<Notice tone="error">` at the top of the page (`errorGeneric` / `errorAlreadyPaired`).
- **Paired:**
  - a FormCard with a `FormRow` (label = `pairedWith {name}`, hint = `pairedSince {when}` when known);
  - then `<button class="ch-form-row ch-danger-row">{unlink}</button>`;
  - it opens `<BottomSheet label={unlinkTitle} closeLabel={ui.cancel} closeDisabled={working}>` with:
    - `<h2 class="ch-sheet-heading">{unlinkTitle {name}}</h2>`;
    - `<p>{unlinkBody}</p>`;
    - an error Notice;
    - `<button class="ch-btn ch-btn-danger">{working ? unlinking : unlink}</button>`.
  - A success clears the partner and closes the sheet.
- **Not paired:**
  - `<p class="ch-form-fixed">{notPairedSubtitle}</p>`;
  - when a link exists: `<SectionLabel>{linkLabel}</SectionLabel>`, then a FormCard holding:
    - CopyField;
    - a hint row `activeLink`;
    - `expires {when}`;
    - a `<button class="ch-form-row ch-danger-row">{revoke}</button>`;
  - then `<button class="ch-btn ch-btn-primary">` with the lucide Link icon and `generateInvite` (`creating` while busy).
  - While any request runs, every action is disabled.
- **Deleted:** Tailwind classes, the emoji, `window.confirm`, the direct `useTelegramBackButton` call, and the X-icon revoke button.

**Copy changes** (`pair`; every other key stays as it is):

| Key | en | he | ru |
|---|---|---|---|
| unlinkTitle (new) | Unlink from {name}? | לנתק את החיבור עם {name}? | Разорвать связь с {name}? |
| unlinkBody (replaces unlinkConfirm) | You'll stop seeing each other's calendars right away, and every shared calendar goes back to private. | היומנים יפסיקו להיות גלויים לשניכם מיד, וכל יומן משותף יחזור להיות פרטי. | Вы сразу перестанете видеть календари друг друга, и все общие календари снова станут приватными. |
| linkLabel (new) | Invite link | קישור ההזמנה | Ссылка-приглашение |
| copied (new) | Copied | הועתק | Скопировано |
| errorGeneric (changed) | Something went wrong. Try again. | משהו השתבש. כדאי לנסות שוב. | Что-то пошло не так. Попробуйте ещё раз. |

`ui.cancel` (new): Cancel | ביטול | Отмена.

- [ ] **Step 1: Write the failing checks.**
  - smoke-app-ui K17, CopyField:
    - renders the parts above;
    - a tap writes the value and shows `copiedLabel` in the status for 2 s;
    - with no `navigator.clipboard`, or with a rejecting one: no "copied", a `console.warn`, and the input's `select()` is called.
  - `scripts/smoke-pair-render.ts`:
    - **P1 render,** en/he/ru × light/dark × paired/not paired/with link:
      - root `ch-app ch-screen ch-grouped`;
      - no raw key, no emoji;
      - he/ru carry no Latin outside brand words and the URL;
      - the URL input has `dir="ltr"`;
      - dates are 24-hour (a fixture at 15:45 shows "15:45", never "PM").
    - **P2 link lifecycle:**
      - generate posts once, and the new link shows;
      - generate again replaces the link;
      - revoke sends DELETE once and goes back to Generate;
      - `INVITER_ALREADY_PAIRED` gives `errorAlreadyPaired`;
      - a 500 gives `errorGeneric`;
      - every action is disabled while a request runs.
    - **P3 unlink:**
      - the row opens the sheet, and `window.confirm` is never called;
      - Telegram's back closes the sheet;
      - while working, back and close do nothing;
      - a 500 keeps the sheet open with the error;
      - an OK answer shows the not-paired view.
    - **P4 requests:** each body deep-equals today's (`{ initData }`, read with `readInitData()`) and goes to the same URL.
    - **P5 back:** AppScreen is the only BackButton caller. With no sheet, back pushes `/{locale}/dashboard?user_id=1`.
    - **P6** no React warnings.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** CopyField, the CSS, PairClient, PageGate and messages. Update the listed smokes, keeping their intent.
- [ ] **Step 4: Run** the new smoke, smoke-app-ui, smoke-miniapp-gate, smoke-pair-invite-copy, smoke-page-auth and parity. Expected: PASS.
- [ ] **Step 5: Screenshots** at 360×780 into `<S>/w3-shots/`:
  - paired, he light;
  - with a link, en dark;
  - not paired, ru light;
  - the unlink sheet, he dark (Telegram params).
- [ ] **Step 6: Mutations:**
  - `window.confirm` back (P3);
  - back ignores the open sheet (P3);
  - CopyField throws on a reject (K17);
  - `hourCycle` dropped (P1);
  - `LOOK.pair` back to `'light'` (#18).
- [ ] **Step 7: Gate, then commit** `feat(pair): the Partner screen in the home's design: a copy-link field, an unlink confirm sheet, the app look`.

### Task 2: The invite landing

**Files:**
- Modify:
  - `app/[locale]/invite/[token]/page.tsx`: the invalid branch becomes `<AppScreen><StateCard tone="crash" title={invalid.title} body={invalid.body} action={{ label: invalid.home, href: '/{locale}' }} /></AppScreen>`. Its data, deep links and `getInviteByToken` are unchanged.
  - `app/[locale]/invite/[token]/InviteClient.tsx`: rewritten, with props unchanged.
  - `messages/{en,he,ru}.json`: `invite.errors.alreadyPairedTogether` without the emoji: en "You two are already paired.", he "שניכם כבר מחוברים.", ru "Вы уже связаны друг с другом.".
  - smoke-pairing-accept #17 moves to the kit markup, with the same intent: the news shows outside the error notice, and there is no Accept button.
- Create: `scripts/smoke-invite-render.ts`.

**Screen:**
- **Root:** `<AppScreen>` (plain ground).
- **Card:** a centred `.ch-home-card` (StateCard-like) holding:
  - `<h1 class="ch-home-card-title">{title {name}}</h1>`;
  - `<p class="ch-home-card-body">{subtitle}</p>`;
  - the action area;
  - `<p class="ch-form-fixed">{expires {when}}</p>`, 24-hour.
- **Action area:**
  - in Telegram (initData with a user, read after mount as today): `ch-btn ch-btn-primary` showing `accept` (`accepting` while pending), with the body unchanged;
  - otherwise: `<p>{notInApp}</p>`, then `<a class="ch-btn ch-btn-primary" href={tgDeepLink}>{openTg}</a>`, then `<a class="ch-btn" href={waDeepLink}>{openWa}</a>`. Each shows only when its link is set.
- **Outcomes:**
  - an error code gives `<Notice tone="error">` with that code's message (`errorGeneric` otherwise; a network failure is still reported with `captureError`);
  - `ALREADY_PAIRED_TOGETHER` gives `<Notice>` (info) with the message, and the Accept button goes;
  - success gives `<StateCard title={success {name}} action={{ label: closeApp, onClick: () => window.Telegram?.WebApp?.close?.() }} />`.
- **Deleted:** Tailwind, the emoji and the gradients.

- [ ] **Step 1: Write `scripts/smoke-invite-render.ts`:**
  - **V1 render,** en/he/ru × light/dark: no raw key, no emoji, a 24-hour expiry, the `ch-app ch-screen` root. Hydrating the server markup gives no warnings; use `scripts/lib/fake-markup.ts` and `hydrateRoot`.
  - **V2 in Telegram:**
    - Accept posts once to `/api/pair/accept?user_id=<telegram id>` with `{ token, initData }`;
    - pending disables it;
    - each of the 8 error codes shows its own message in an error Notice;
    - `ALREADY_PAIRED_TOGETHER` shows an info Notice and no Accept;
    - success shows the card, and Close calls `WebApp.close`.
  - **V3 in a browser** (the SDK present, no initData): no Accept; Telegram first, then WhatsApp, with the exact hrefs; each is hidden when its link is empty; no request.
  - **V4 the invalid token:** the server page renders the crash card with `href="/{locale}"`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement,** and update #17.
- [ ] **Step 4: Run** the new smoke, smoke-pairing-accept, smoke-pair-invite-copy and parity. Expected: PASS.
- [ ] **Step 5: Screenshots:** the browser view in he light, Telegram in en dark, success in ru light, invalid in he light.
- [ ] **Step 6: Mutations:**
  - already-paired shown as an error (V2);
  - WhatsApp before Telegram (V3);
  - the accept body with `user.id`-style data or no initData (V2);
  - the emoji put back (V1).
- [ ] **Step 7: Gate, then commit** `feat(invite): the invite landing in the home's design`.

## After the build (controller)
- One Opus review, one fix round, mutation spot checks, the fresh-clone CI mirror.
- Push, then CI and Railway, a notification and the memory.
- The spec's status line says W3 is done, and this plan file is deleted.
- **The owner's phone checks:**
  - Partner, paired and not paired, in he and en;
  - generate, copy and revoke a link;
  - open someone's invite;
  - unlink, if a test pair exists.
