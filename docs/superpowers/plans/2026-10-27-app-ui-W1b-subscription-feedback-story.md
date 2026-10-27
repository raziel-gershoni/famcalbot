# W1b: Subscription, Feedback and share-story on the shared layer, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subscription, Feedback and share-story are rebuilt in the home's design on `components/app-ui`. This finishes W1.

**Architecture:**
- Task 1 adds the last kit pieces W1 needs:
  - Tag (the "Current" chip);
  - Meter;
  - a padded Panel card and an outlined button;
  - a near-limit colour;
  - a shared CSS lint helper.
- Task 2 rebuilds SubscriptionClient on AppScreen and the kit:
  - the page gains two server props, a calendar count and whether Telegram is linked;
  - the upgrade request and the prices are unchanged.
- Task 3 rebuilds FeedbackClient on AppScreen. It stays outside PageGate.
- Task 4 moves share-story onto the app loader, with translated alerts.

**Builds on:** W1a, which must be on main first: ScreenHeader, SectionLabel, Notice, the grouped ground, SaveBar `sticky`/`disabled`, and `ui.back/save/saved/done`.

**Tech Stack:** Next.js 16 client components; inline `<style>` CSS strings; next-intl; tsx smoke scripts with the fake DOM in `scripts/lib/fake-dom.ts`.

**Spec:** `docs/superpowers/specs/2026-10-19-screens-and-colours-design.md` §1, §4, §5 (W1). The approved mockup is `Subscription.dc.html` on https://claude.ai/artifact/KJQjWZ7MFRRCr3A4raAQos; a copy is in the scratchpad at `w1-mockups/project/`. The spec's default 4 also applies: Basic is outlined, Pro highlighted with a filled button.

## Global Constraints

**Unchanged, besides formatting:**
- `PLAN_CONFIGS` prices (2500 / 5000 Stars), `payment-handler.ts`, and the upgrade route and its contract;
- the bot's keys: `subscription.features.*`, `invoice*`, `plans.*.name`, `reminders.*`, `paymentSuccess`/`paymentError`, `viewSubscription`, `*LimitReached`, `*Required` and `upgradeButton`;
- `/api/feedback` and `/api/weather-image/*`, and the share-story URL shape `/{lang}/share-story?user_id&source[&msg]`.

**Requests:**
- **Upgrade:** POST `/api/subscription/upgrade`, body `{ user_id, plan, initData, recurring: false }`, with `initData` in the body.
  - `user_id` is the `userId` prop. page-data passes the URL's `user_id` through, so the value is the one the page parses today.
  - `initData` is read with `readInitData()`.
- **Feedback:** POST `/api/feedback`, body `{ text, user_id, initData }`, with the same `text` as today and `initData` from `readInitData()`.

**Kept fixes:**
- d1b90de: Pro users are never offered Basic, and the reminders row uses its own translated key, never the `subscription.reminders` object.
- `user.id` and `telegramId` are never swapped.

**Kit rules:** the same as W1a.
- `components/app-ui` is client-safe and never imports `src/config/plans`.
- Kit components take translated strings.
- AppScreen is the only BackButton caller.
- Logical CSS, no `:hover`, font sizes in px of at least 11, targets of at least 44.
- No hex or rgb outside token blocks.
- New class names must be free; grep first. Taken: `.ch-badge`, `.ch-chip`, `.ch-card*`, `.ch-empty*`, `.ch-state*`, `.ch-banner*`, `.ch-day`, `.ch-days`.

**Icons:** lucide only. The mockup's ⭐ is a lucide `Star`. No emoji anywhere on these screens.

**Copy:**
- en/he/ru exactly as in the tables: gender-neutral Hebrew, formal Russian.
- Brand words stay Latin: Telegram, WhatsApp, FamCal, Pro.
- Every plural is ICU with each language's forms (en one/other, he one/two/other, ru one/few/many/other).
- A key lands with its first use. Dead keys are deleted after a grep of `app components src scripts`.

**Numbers:**
- Counts and prices are wrapped in `<bdi dir="ltr">`.
- Prices are formatted with `Intl.NumberFormat(locale)`: en and he "2,500", ru "2 500".

**Gate:** `npx prisma generate && npx tsc --noEmit && npx eslint . && bash scripts/ci-smokes.sh && npx tsx scripts/check-i18n-parity.ts`. Never run `npm run build` or `next build`.

**Tests:** every new check is shown to fail with its fix removed.

## Owner decisions in this plan (defaults taken; the owner may override at review)
1. **Plan cards:**
   - only Basic and Pro get a card, as in the mockup. Free appears only as the current-plan card;
   - the card of the user's paid plan shows "Current" and no button;
   - a Pro user sees no buttons at all, which keeps the fix.
2. **Calendars meter:** added, as in the mockup. The count comes from `countCalendars`, the same count that enforces the limit.
3. **Near the limit:** a meter turns orange at 80% or more, as in the mockup. This replaces today's green, amber and red bars. Over the limit, the bar stays full and orange, and the count reads, for example, "12 of 10".
4. **Trial and early access:** both fold into the current-plan card as a chip ("Trial" or "Early access") and one line, such as "9 days left in your trial". The two coloured banners and the 🎉 go.
5. **No Telegram linked** (a WhatsApp-only user): there are no Choose buttons. A note says that paying needs Telegram. Today the button fails silently for them.
6. **After a Choose tap:**
   - in Telegram, today's pop-up and close stay (the invoice waits in the chat), with the copy rewritten;
   - in a browser, the same message shows inline;
   - errors show inline in the user's language, never the server's English text;
   - while one request is in flight, every Choose button is disabled.
7. **Feedback** stays outside PageGate. Its page deliberately does no user lookup (smoke-auth-leftovers #7). A sign-in failure on send says "open this from your FamCal chat" instead of "try again".
8. **share-story:**
   - it shows the app loader;
   - its alerts are translated, never the server's text, and the window closes after the person taps OK, not before;
   - opened outside Telegram, it shows a "Telegram only" card instead of an endless spinner.
9. **Missing `user_id`:** Subscription keeps answering 404 (smoke-miniapp-gate #20). Feedback and share-story show the shared Missing parameter card.
10. **What waits for its first user (W3):** empty states and the `ui` keys Close and Retry. The other gate looks stay with the screens that use them: `'telegram'` with select-calendars, and `'light'` with calendars and pair.

## Review Focus
1. **Each plan state:** Free, trial, Basic, Pro, comped Pro (no period end), early access (no plans section) and a WhatsApp-only user each get exactly the buttons decision 1 allows. (Task 2, U2.)
2. **A double tap on Choose,** or a tap on the other plan while the first request is in flight: exactly one request is sent. (Task 2, U4.)
3. **Meters at the edges:**
   - 0 of 3;
   - 8 of 10, which is near;
   - 12 of 10, which is over;
   - unlimited, with no track;
   - `aria-valuenow` capped at the max, and `aria-valuetext` as shown. (Task 1, K2; Task 2, U3.)
4. **Feedback text with spaces:** "   short   " counts as 5, so Send stays disabled. A 401 gives the open-from-chat message. A 429 gives the daily-limit message. (Task 3, F3, F4.)
5. **share-story in an old Telegram** (no `shareToStory`) and outside Telegram: one translated alert, then close; or the Telegram-only card. The page never sends a fetch with `user_id=null`. (Task 4, H2, H3.)

---

### Task 1: Tag, Meter, Panel, the outlined button and the near-limit colour

**Files:**
- Create:
  - `components/app-ui/Tag.tsx`;
  - `components/app-ui/Meter.tsx`;
  - `scripts/lib/css-lint.ts`.
- Modify:
  - `components/app-ui/screen.ts`: `.ch-tag`, `.ch-meter*`, `.ch-panel*`, `.ch-btn-outline`;
  - `components/app-ui/theme.ts`: `--ch-warn` and `--ch-warn-text` in both themes;
  - `scripts/lib/css-resolve.ts`: the new pairs;
  - `scripts/smoke-app-ui.ts`: #2 calls `lintCss`; new K-checks.

**Interfaces (produced, exact):**
```ts
// Tag.tsx
export function Tag(props: { children: ReactNode }): JSX.Element      // <span class="ch-tag">
// Meter.tsx
export const NEAR_LIMIT = 0.8;
export function Meter(props: { label: string; used: number; limit: number | null; valueText: string }): JSX.Element
// limit null = unlimited: label and valueText, no track, no role="meter".
// Otherwise:
// <div class="ch-meter [is-near]"><div class="ch-meter-head"><span class="ch-meter-label">{label}</span>
//   <span class="ch-meter-value"><bdi dir="ltr">{valueText}</bdi></span></div>
//   <div class="ch-meter-track" role="meter" aria-label={label} aria-valuemin="0" aria-valuemax={limit}
//        aria-valuenow={Math.min(used, limit)} aria-valuetext={valueText}>
//     <div class="ch-meter-fill" style={{ inlineSize: `${Math.min(used / limit, 1) * 100}%` }} /></div></div>
// is-near when limit > 0 and used / limit >= NEAR_LIMIT.
// scripts/lib/css-lint.ts
export function lintCss(css: string, opts?: { exempt?: string[] }): string[]   // problems found; [] = clean
```

**`lintCss`** checks what smoke-app-ui #2 checks today:
- px font sizes of at least 11;
- `.ch-btn` and `.ch-icon-btn` at 44 or more;
- logical properties only;
- no `:hover`;
- no hex or rgb outside token blocks, except the exempt declarations.

#2 then calls it. Its exemptions and its results do not change.

**CSS (values from the mockup, on tokens):**
- `.ch-tag`: 12px/600, `--ch-accent` on `--ch-accent-soft`, `padding: 4px 10px`, radius 10, `white-space: nowrap`.
- `.ch-panel`:
  - `--ch-section` background, radius 16, padding 16;
  - flex column with gap 10;
  - `.ch-panel-ring` adds `box-shadow: inset 0 0 0 1.5px var(--ch-button)`.
- `.ch-meter`:
  - flex column, gap 6;
  - `.ch-meter-head` is flex baseline with gap 8;
  - `.ch-meter-label` is 15px with `flex: 1`;
  - `.ch-meter-value` is 14px `--ch-muted`.
- `.ch-meter-track`: block-size 6, radius 3, `--ch-separator`, overflow hidden.
- `.ch-meter-fill`: block-size 6, radius 3, `--ch-accent`.
- `.ch-meter.is-near`: the fill is `--ch-warn`, and the value is `--ch-warn-text`.
- `.ch-btn-outline`: transparent, `box-shadow: inset 0 0 0 1.5px var(--ch-button)`, text `--ch-accent`, 15px/600, at least 44.
- Tokens:

  | Token | light | dark |
  |---|---|---|
  | `--ch-warn` | `#c4580a` | `#ffb27a` |
  | `--ch-warn-text` | `#8a3d00` | `#ffc796` |

  If a pair below fails, darken the light value or lighten the dark value in small steps until it passes, and report the final values.

- [ ] **Step 1: Failing checks in `scripts/smoke-app-ui.ts`:**
  - K1 Tag is a `span.ch-tag` with its text.
  - K2 Meter:
    - 7 of 10: `role="meter"`, `aria-valuenow="7"`, `aria-valuemax="10"`, `aria-valuetext` equal to `valueText`, fill `inline-size:70%`, not near;
    - 8 of 10 is near;
    - 12 of 10: `aria-valuenow="10"`, fill 100%, near;
    - 0 of 3: fill 0%;
    - limit null: no `role="meter"`, no track, and the text shows.
  - K3 `.ch-panel-ring` and `.ch-btn-outline` exist in the CSS, and the button is at least 44.
  - #2 runs through `lintCss`, with unchanged results.
  - New pairs:
    - TEXT_PAIRS: `--ch-accent/--ch-accent-soft`, `--ch-warn-text/--ch-section`, `--ch-muted/--ch-section` (skip it if W1a already added it);
    - MARK_PAIRS: `--ch-warn/--ch-section`, `--ch-accent/--ch-section` (the fill), `--ch-button/--ch-section` (the ring; skip it if W1a already added it).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** smoke-app-ui. Expected: PASS.
- [ ] **Step 5: Mutations:**
  - `aria-valuenow` not capped (K2);
  - near at 0.7 (K2);
  - a hex in `.ch-tag` (#2 through `lintCss`).
- [ ] **Step 6: Gate, then commit** `feat(app-ui): Tag, Meter, Panel, an outlined button and a near-limit colour`.

### Task 2: Subscription on AppScreen and the kit

Invoke the `frontend-design:frontend-design` skill once before this task. The direction is fixed: the mockup, the home's tokens and the kit.

**Files:**
- Modify:
  - `app/[locale]/subscription/SubscriptionClient.tsx`: rewritten;
  - `src/lib/page-data.ts` `subscription()`: adds `calendarsUsed` (`calendarTotal(c.famcal, c.google)` from `countCalendars(user.id)`, in the same `Promise.all`) and `telegramLinked` (`user.telegramId !== null`);
  - `app/[locale]/PageGate.tsx`: `LOOK.subscription: 'app'`; the Subscription `dynamic()` uses `appLoader`; the header comment;
  - `messages/{en,he,ru}.json`: the `subscription.screen` table below; screen-only keys deleted after a grep.
- Delete: `components/UI/Section.tsx`, plus its export in `components/UI/index.ts` (delete the folder if nothing else is in it). Grep first: Subscription is its last user.
- Create:
  - `app/[locale]/subscription/subscription-css.ts`: `SUBSCRIPTION_CSS` for the screen's own layout (`.ch-plan-*`);
  - `scripts/smoke-subscription-render.ts`.
- Test (updated):
  - `scripts/smoke-miniapp-gate.ts` #18: `['subscription','app']`;
  - `scripts/smoke-activity-log.ts`: the `subscription-service` stub gains `countCalendars` and `calendarTotal`;
  - `scripts/smoke-native-reminder-support.ts`: the check "the plans name both things the reminders feature gates" moves to `subscription.screen.proReminders`, keeping `features.reminders` and its words;
  - any smoke that pins a deleted key, updated with the same intent.

**Screen structure:**
- **Root:** `<AppScreen ground="grouped" onBack={back}>`, then `<style>{SUBSCRIPTION_CSS}</style>`, then `<ScreenHeader title={screen.title} backLabel={ui.back} onBack={back}>`, then `<div class="ch-plan-page">`.
- **Back:** `back` = `router.push('/{locale}/dashboard?user_id={userId}')`.
- **Current plan** (`.ch-panel`):
  - **Head:** the plan name of `effectivePlan` from `subscription.plans.{free|basic|pro}.name` (20px/600), then a Tag:
    - early access → `badge.earlyAccess`;
    - trialing → `badge.trial`;
    - otherwise `badge.current`.
  - **One status line** (13px muted), only one of:
    - early access → `earlyAccessNote`;
    - trialing → `trialLeft` with `{days}`;
    - a paid plan with a `currentPeriodEnd` → `activeUntil` with today's `toLocaleDateString(he-IL|ru-RU|en-US, { day: 'numeric', month: 'long', year: 'numeric' })`.
  - **The caption** `thisMonth`.
  - **Meters,** with limits from `PLAN_CONFIGS[effectivePlan].limits`, where Infinity means `limit={null}` and `valueText={unlimited}`:
    - text summaries, voice summaries, calendars (`calendarsUsed`), each with `valueText` `usageOf {used, limit}`;
    - when `limits.voiceEvents`, a `voiceEvents` row, unlimited;
    - when `limits.reminders`, a `reminders` row, unlimited.
- **Plans** (hidden for early access): `<SectionLabel>{plansLabel}</SectionLabel>`, then a Basic `.ch-panel` and a Pro `.ch-panel ch-panel-ring`.
  - **Head:** the localized plan name (18px/600), then the price.
    - The price is a lucide `Star` (filled, `aria-hidden`), then `<bdi dir="ltr">{Intl.NumberFormat(locale).format(priceStars)}</bdi>`, then `perMonth` in 13px muted. This visual part is `aria-hidden`.
    - Beside it, a `.ch-visually-hidden` `priceA11y {price}`.
    - When the card is the user's paid plan (`subscription.plan === id`, not trialing), a Tag `badge.current` follows.
  - **Bullets** (`<ul class="ch-plan-list">`, 14px):
    - Basic: `basicSummaries`; `calendarsUpTo {count: PLAN_CONFIGS.BASIC.limits.calendars}`;
    - Pro: `proEverything`; `proVoice`; `proReminders`.
  - **Button,** only when `canUpgrade(id)` and `telegramLinked`:
    - `canUpgrade(id)` is today's rule: not current, and `PLAN_ORDER.indexOf(subscription.plan) < PLAN_ORDER.indexOf(id)`;
    - Basic: `ch-btn ch-btn-outline`; Pro: `ch-btn ch-btn-primary`, 48px;
    - label `choose {plan}`;
    - the tapped button shows `.ch-form-spinner` and `aria-busy`. Every Choose button is disabled while a request is in flight.
  - **Under the cards:**
    - a Notice for the outcome (`invoiceSent` as info in a browser; `upgradeFailed` as an error);
    - then, when any button shows, `starsNote` (12px muted);
    - when `telegramLinked` is false and an upgrade exists, `<Notice>{needsTelegram}</Notice>` instead of the buttons and the note.
- **Upgrade flow:**
  - **Request:** as in Global Constraints.
  - **Success** (`ok && data.success`):
    - in Telegram, `showAlert(invoiceSent, () => close())`;
    - otherwise, the info Notice.
  - **Not OK or not success:** `console.warn('[subscription] upgrade refused:', status)`, then the error Notice. In Telegram, `showAlert(upgradeFailed)` as well.
  - **Throw:** `console.error('[subscription] upgrade failed:', error)`, then the same.
  - **Afterwards:** `finally` clears the busy state. Server `error` text is never shown.
- **Deleted:** `TelegramLayout`, `Header`, `Section`, styled-jsx, `Crown`/`Sparkles`/`Clock`, and every hard-coded English string.

**Copy:** `subscription.screen` (new; exact).

| Key | en | he | ru |
|---|---|---|---|
| title | Subscription | מנוי | Подписка |
| badge.current | Current | נוכחי | Текущий |
| badge.trial | Trial | תקופת ניסיון | Пробный период |
| badge.earlyAccess | Early access | גישה מוקדמת | Ранний доступ |
| trialLeft | {days, plural, one {# day left in your trial} other {# days left in your trial}} | {days, plural, one {נשאר יום אחד לתקופת הניסיון} two {נשארו יומיים לתקופת הניסיון} other {נשארו # ימים לתקופת הניסיון}} | {days, plural, one {До конца пробного периода # день} few {До конца пробного периода # дня} many {До конца пробного периода # дней} other {До конца пробного периода # дня}} |
| earlyAccessNote | Every feature is open to you as one of our first users. | כל התכונות פתוחות, כחלק מהמשתמשים הראשונים שלנו. | Вам доступны все функции: вы среди наших первых пользователей. |
| activeUntil | Active until {date} | פעיל עד {date} | Действует до {date} |
| thisMonth | This month so far | החודש עד עכשיו | В этом месяце |
| usageOf | {used} of {limit} | {used} מתוך {limit} | {used} из {limit} |
| unlimited | Unlimited | ללא הגבלה | Без ограничений |
| textSummaries | Text summaries | סיכומים בטקסט | Текстовые сводки |
| voiceSummaries | Voice summaries | סיכומים קוליים | Голосовые сводки |
| calendars | Calendars | יומנים | Календари |
| voiceEvents | Events added by voice | אירועים שנוספו בקול | События, добавленные голосом |
| reminders | Reminders and alerts | תזכורות והתראות | Напоминания и уведомления |
| plansLabel | Plans | מסלולים | Тарифы |
| perMonth | / month | לחודש | в месяц |
| priceA11y | {price, number} Telegram Stars a month | {price, number} כוכבים של Telegram לחודש | {price, number} звёзд Telegram в месяц |
| basicSummaries | Unlimited text and voice summaries | סיכומים בטקסט ובקול ללא הגבלה | Безлимитные текстовые и голосовые сводки |
| calendarsUpTo | Up to {count} calendars | עד {count} יומנים | До {count} календарей |
| proEverything | Everything in Basic, with unlimited calendars | כל מה שבמסלול בסיסי, ויומנים ללא הגבלה | Всё из тарифа «Базовый» и безлимит календарей |
| proVoice | Add events by voice | הוספת אירועים בקול | Добавление событий голосом |
| proReminders | Reminders and event alerts | תזכורות והתראות לפני אירועים | Напоминания и уведомления о событиях |
| choose | Choose {plan} | לעבור למסלול {plan} | Перейти на «{plan}» |
| starsNote | You pay with Telegram Stars in your chat with FamCal. | התשלום בכוכבים של Telegram, בצ׳אט עם FamCal. | Оплата звёздами Telegram в чате с FamCal. |
| invoiceSent | The invoice is in your Telegram chat with FamCal. Pay there to switch plans. | החשבונית נשלחה לצ׳אט עם FamCal ב־Telegram. משלמים שם ועוברים מסלול. | Счёт отправлен в чат с FamCal в Telegram. Оплатите его там, чтобы сменить тариф. |
| upgradeFailed | Couldn't send the invoice. Try again. | לא הצלחנו לשלוח את החשבונית. כדאי לנסות שוב. | Не получилось отправить счёт. Попробуйте ещё раз. |
| needsTelegram | Paying with Telegram Stars needs Telegram. Open FamCal in Telegram to change your plan. | התשלום בכוכבים של Telegram אפשרי רק ב־Telegram. כדי לעבור מסלול, פותחים את FamCal ב־Telegram. | Оплата звёздами Telegram возможна только в Telegram. Чтобы сменить тариф, откройте FamCal в Telegram. |

**Deleted after a grep** (screen-only today):
- `page.*`, `currentPlan`, `usage`, `textSummaries`, `voiceSummaries`, `voiceEvents`, `usageReminders`, `calendars`, `unlimited`, `of`, `usageDisplay`;
- `trialBanner`, `trialEndsIn`, `earlyAdopterBanner`, `earlyAdopterDescription`;
- `planFeatures.*`, `plans.*.description` and `plans.*.price` (the stale 150/300 copy);
- `cancelPlan`, if nothing reads it.

Every bot-read key in Global Constraints stays.

- [ ] **Step 1: Write `scripts/smoke-subscription-render.ts`.** Use smoke-app-ui's helpers, a router stub, a fake `fetch`, and a fake Telegram with `showAlert` and `close`.
  - U1 render, en/he/ru × light/dark:
    - root `ch-app ch-screen ch-grouped`;
    - no raw key, no emoji;
    - he/ru carry no Latin outside the brand words;
    - counts and prices in `<bdi dir="ltr">`;
    - ru shows "2 500" (with the locale's group separator);
    - the `Star` svg is `aria-hidden`;
    - `lintCss(SUBSCRIPTION_CSS)` returns `[]`.
  - U2 the state matrix. Each case lists the Choose buttons; this pins d1b90de.

    | State | Choose buttons | Also |
    |---|---|---|
    | Free | Basic, Pro | |
    | Trial | Basic, Pro | the `trialLeft` line (1 and 2 days in he) |
    | Basic | Pro | Basic's card has the Current tag |
    | Pro | none | |
    | Comped Pro | none | no `activeUntil` line |
    | Early access | none | no Plans section |
    | Free, `telegramLinked` false | none | `needsTelegram` |

    The reminders row's label is `screen.reminders`, never the raw `subscription.reminders`. `PLAN_CONFIGS.BASIC.priceStars === 2500` and `PRO === 5000`, so a price edit fails here.
  - U3 meters:
    - Free 7/10 text, 3/3 voice (near), 2/3 calendars;
    - 12/10 is over;
    - Pro shows unlimited rows with no `role="meter"`.
  - U4 upgrade:
    - a tap posts once with the exact body. Use `{ user_id: 1, plan: 'PRO', initData: '<fake>', recurring: false }` and deep-equal it;
    - a second tap, on either button, while in flight sends nothing;
    - success in Telegram calls `showAlert(invoiceSent)`, and its callback calls `close`;
    - in a browser it shows the info Notice;
    - a 500 response with `{error: 'Failed to send invoice'}` shows `upgradeFailed`, and the English text appears nowhere;
    - a throw does the same and logs.
  - U5 back: AppScreen is the only BackButton caller. Back pushes `/{locale}/dashboard?user_id=1`.
  - U6 no React warnings.
  - Also: `loadPageData('subscription', …)` with stubs returns `calendarsUsed` (famcal 1 + google 2 → 3) and `telegramLinked`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Update the smokes listed under Test.
- [ ] **Step 4: Run** the new smoke, smoke-miniapp-gate, smoke-activity-log, smoke-native-reminder-support, smoke-auth-identity (#14–#16, upgrade unchanged), smoke-app-ui and parity. Expected: PASS.
- [ ] **Step 5: Screenshots for the controller:** Free he light, trial en dark, Pro ru light, Free near the limit he dark (Telegram params), a WhatsApp-only user en light.
- [ ] **Step 6: Mutations:**
  - offer Basic to Pro (U2);
  - drop the in-flight guard (U4);
  - show `data.error` (U4);
  - meter near at 0.7 (U3);
  - `LOOK.subscription` back to `'telegram'` (#18);
  - remove `calendarsUsed` from the loader (the loader check).
- [ ] **Step 7: Gate, then commit** `feat(subscription): Subscription in the home's design on the kit: meters, plan cards with Stars prices, inline outcomes; the app look`.

### Task 3: Feedback on AppScreen

**Files:**
- Modify:
  - `app/[locale]/feedback/FeedbackClient.tsx`: rewritten, with props unchanged. `page.tsx` is untouched, so smoke-auth-leftovers #7 stays;
  - `components/app-ui/form-kit.tsx`: TextField gains `maxLength?`, `rows?` (default 3) and `describedBy?` (joined with the error id);
  - `app/api/feedback/route.ts`: reads its 10 / 1000 / 3-per-day from the shared constant. Values and behaviour are unchanged;
  - `messages/{en,he,ru}.json`: `dashboard.feedback.*` moves to a top-level `feedback` namespace with the copy below. The `dashboard` namespace is deleted; it holds only `feedback` today (grep first).
- Create:
  - `src/lib/feedback-limits.ts`: `export const FEEDBACK_LIMITS = { minLength: 10, maxLength: 1000, perDay: 3 } as const`;
  - `scripts/smoke-feedback-render.ts`.

**Screen structure:**
- **Root:** `<AppScreen ground="grouped" onBack={back}>`, then FORM_CSS, then ScreenHeader `title`, then `<div class="ch-form-page">`.
- **Intro** paragraph `intro`.
- **Field:** a FormCard with `<TextField multiline rows={8} label={fieldLabel} placeholder={placeholder} maxLength={1000} describedBy={countId}>`.
- **Count line** (13px muted, flex with space-between):
  - the start side shows `moreNeeded {count}` while 0 < trimmed length < 10;
  - the end side shows `<bdi dir="ltr">{length} / 1000</bdi>`.
- **Send:** `<SaveBar sticky label={send} busy={sending} disabled={trimmed.length < 10} error={error}>`.
- **Outcomes:**
  - 429, or `rateLimit` → `rateLimit`;
  - 401, 403 or 404 → `openFromChat`;
  - `tooShort` → `tooShort {min}`;
  - `tooLong` → `tooLong {max}`;
  - anything else, or a throw (logged) → `failed`.
- **Success:** the form gives way to `<StateCard title={thanksTitle} body={thanksBody} action={{ label: backToCalendar, onClick: back }}>` inside the same AppScreen and ScreenHeader.
- **Telegram:**
  - `startMiniApp('app')` once on mount (imported from PageGate, as TelegramDashboardRedirect does);
  - the effect that set `#667eea` / `#ffffff` is deleted, along with `TelegramLayout` and styled-jsx.
- **Back:** `back` = `router.push('/{locale}/dashboard?user_id={userId}')`.

**Copy:** `feedback` (exact).

| Key | en | he | ru |
|---|---|---|---|
| title | Feedback | משוב | Обратная связь |
| intro | Tell us what works, what doesn't, and what you'd like FamCal to do. | מה עובד, מה לא, ומה הייתם רוצים ש־FamCal יעשה? נשמח לשמוע. | Расскажите, что работает, что нет и чего вам не хватает в FamCal. |
| fieldLabel | Your feedback | המשוב | Ваш отзыв |
| placeholder | Write here | אפשר לכתוב כאן | Напишите здесь |
| moreNeeded | {count, plural, one {# more character to go} other {# more characters to go}} | {count, plural, one {עוד תו אחד} two {עוד שני תווים} other {עוד # תווים}} | {count, plural, one {Ещё # символ} few {Ещё # символа} many {Ещё # символов} other {Ещё # символа}} |
| send | Send | שליחה | Отправить |
| rateLimit | You've reached today's limit. You can send more tomorrow. | המכסה היומית נוצלה. אפשר לשלוח שוב מחר. | На сегодня лимит исчерпан. Отправить ещё можно завтра. |
| openFromChat | Open this page from your FamCal chat to send feedback. | כדי לשלוח משוב, פותחים את הדף מהצ׳אט עם FamCal. | Чтобы отправить отзыв, откройте эту страницу из чата с FamCal. |
| tooShort | Write at least {min} characters. | צריך לכתוב לפחות {min} תווים. | Напишите хотя бы {min} символов. |
| tooLong | Keep it to {max} characters. | אפשר לכתוב עד {max} תווים. | Не больше {max} символов. |
| failed | Couldn't send. Try again. | לא הצלחנו לשלוח. כדאי לנסות שוב. | Не получилось отправить. Попробуйте ещё раз. |
| thanksTitle | Thanks, it's on its way | תודה, המשוב נשלח | Спасибо, отзыв отправлен |
| thanksBody | We read every message. | אנחנו קוראים כל הודעה. | Мы читаем каждое сообщение. |
| backToCalendar | Back to the calendar | חזרה ליומן | Вернуться в календарь |

- [ ] **Step 1: Write `scripts/smoke-feedback-render.ts`:**
  - F1 render, en/he/ru × light/dark:
    - grouped root;
    - no raw key or emoji;
    - he/ru carry no Latin outside FamCal;
    - the count is in `<bdi dir="ltr">`;
    - the textarea has `maxlength="1000"` and `aria-describedby` pointing at the count line.
  - F2 counter and Send:
    - empty: Send disabled, no `moreNeeded`;
    - "abc": `moreNeeded` 7 (he "עוד 7 תווים");
    - "   short   ": counted as 5 and disabled;
    - 10 characters: enabled.
  - F3 the request: one POST to `/api/feedback`, body deep-equal to today's, with `initData` from `readInitData()`.
  - F4 outcomes: 429 → `rateLimit`; 401 → `openFromChat`; a 400 `tooShort` → `tooShort` with 10; a 500 → `failed`; a throw → `failed` plus a log.
  - F5 success:
    - the StateCard with `thanksTitle`;
    - its button pushes `/{locale}/dashboard?user_id=5`;
    - `startMiniApp('app')` ran once (a fake Telegram 7.7: ready, expand, swipes).
  - F6 TextField: the new props render. Existing call sites are unchanged (the editor notes field markup is byte-identical).
  - F7 no React warnings.
  - smoke-auth-leftovers #7 and #8 still pass, unchanged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new smoke, smoke-auth-leftovers, smoke-app-ui, smoke-calendar-home-render (the editor notes field) and parity. Expected: PASS.
- [ ] **Step 5: Screenshots for the controller:** he light empty, en dark with "abc", ru light success.
- [ ] **Step 6: Mutations:**
  - count the untrimmed length (F2);
  - map 401 to `failed` (F4);
  - send `window.Telegram.WebApp.initData` directly (F3);
  - drop `startMiniApp` (F5).
- [ ] **Step 7: Gate, then commit** `feat(feedback): Feedback in the home's design on the kit; copy rewritten in en/he/ru; clear outcomes`.

### Task 4: share-story on the app loader

**Files:**
- Modify: `app/[locale]/share-story/page.tsx`. It stays a `'use client'` default export reading `user_id`, `source` and `msg`.
- Modify: `messages/{en,he,ru}.json`, adding a new `shareStory` namespace.
- Create: `scripts/smoke-share-story.ts`.

**Behaviour:**
- **No `user_id`:** `<MissingParameterCard />`, and no fetch.
- **First render and while working:** `<PageLoader look="app" />`.
- **After mount, not in Telegram** (`!isInTelegram()`): `<AppScreen><StateCard tone="crash" title={telegramOnlyTitle} body={telegramOnlyBody} /></AppScreen>`, and no fetch.
- **In Telegram:**
  - `tg.ready()` stays a literal call, and there is no `expand(` (smoke-miniapp-gate #3);
  - no `startMiniApp`.
- **Older Telegram** (no `shareToStory`): `showAlert(updateTelegram, () => tg.close())`.
- **The fetch:** GET `/api/weather-image/sign?user_id=…&source=…[&msg=…]` with `initDataHeaders()`, unchanged.
  - **OK with a url:** `shareToStory(url, { widget_link: { url: 'https://famcal.bot', name: 'FamCal' } })`, then `setTimeout(close, 5000)` as today.
  - **Not OK:** `console.warn('[share-story] image link refused:', status)`, then `showAlert(loadFailed, close)`. Server text is never shown.
  - **Throw:** `console.error('[share-story] share failed:', error)`, then `showAlert(shareFailed, close)`.

**Copy:** `shareStory` (exact).

| Key | en | he | ru |
|---|---|---|---|
| telegramOnlyTitle | Open this in Telegram | הדף הזה נפתח ב־Telegram | Откройте это в Telegram |
| telegramOnlyBody | Sharing to a story works from your FamCal chat in Telegram. | שיתוף לסטורי עובד מהצ׳אט עם FamCal ב־Telegram. | Поделиться в истории можно из чата с FamCal в Telegram. |
| updateTelegram | Update Telegram to share stories. | כדי לשתף בסטורי, צריך לעדכן את Telegram. | Чтобы делиться историями, обновите Telegram. |
| loadFailed | Couldn't prepare the image. Try again. | לא הצלחנו להכין את התמונה. כדאי לנסות שוב. | Не получилось подготовить картинку. Попробуйте ещё раз. |
| shareFailed | Couldn't share. Try again. | לא הצלחנו לשתף. כדאי לנסות שוב. | Не получилось поделиться. Попробуйте ещё раз. |

- [ ] **Step 1: Write `scripts/smoke-share-story.ts`.** Fake Telegram with `ready`, `showAlert(msg, cb)`, `close`, `shareToStory`; a fake fetch; fake timers. Cover en/he/ru.
  - H1 the happy path: one fetch with the exact URL and the `X-Telegram-Init-Data` header; `shareToStory` called with the URL and the exact `widget_link`; `close` after 5000 ms, not before.
  - H2 old Telegram: one alert, `updateTelegram` in the page's locale; `close` only from the alert's callback.
  - H3 outside Telegram: the Telegram-only card; no fetch.
  - H3b no `user_id`: the Missing parameter card; no fetch.
  - H4 a 404 with `{error:'No location set'}` gives `loadFailed`, and the English text appears nowhere. A throw gives `shareFailed` plus a log.
  - H5 the loader is the app loader (`.ch-loader` in a `ch-app ch-screen` root). No emoji. smoke-miniapp-gate #3 still passes.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new smoke, smoke-miniapp-gate, smoke-weather-command (the URL shape) and parity. Expected: PASS.
- [ ] **Step 5: Mutations:**
  - close right after the alert (H2);
  - show `data.error` (H4);
  - fetch with no `user_id` (H3b).
- [ ] **Step 6: Gate, then commit** `feat(share-story): the app loader and translated alerts that close after OK; a Telegram-only card in a browser`.

## After the build (controller)
- One Opus whole-branch review against this plan and spec §4–§5.
- One fix round.
- Mutation spot checks.
- The fresh-clone CI mirror.
- Fast-forward main, push, then CI and Railway, a notification and the memory.
- Update the spec's status line: W1 is done. Delete the W1a and W1b plan files.
- The owner's phone checks:
  - Subscription as a Free and a trial user, he and en, light and dark;
  - tap Choose Pro and see the invoice arrive in the chat;
  - Feedback: send one, then see the thanks card;
  - share a weather story from `/weather`.
