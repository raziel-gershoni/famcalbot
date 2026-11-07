# B features (trial-ended push, "Address me as" at sign-up, Delete account) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An account with no chat hears that its Pro trial ended (browser notification), every new account picks "Address me as" when it is made (web, Telegram, WhatsApp), and a person can delete their own account from Settings through the admin's one delete path; plus the WhatsApp adapter moves onto the one third-party retry loop.

**Architecture:** B1 adds a `plan-ended` push kind and a no-chat branch to `expireTrialSubscription`. B2 adds one shared `isGender`, a `gender` field on the web sign-up, a `{ user, created }` answer from `getOrCreateUser`, and one small module (`src/services/address-choice.ts`) that asks and saves the choice on Telegram and WhatsApp. B3 gives `hardDeleteUser` an actor (`{ admin } | 'self'`), a new guarded route `POST /api/account/delete`, and a Settings row + sheet built like Disconnect Google. Legal text changes land in one task with a new `LEGAL_UPDATED`. The last task moves `whatsapp-adapter.ts` onto `fetchWithRetry` / `fetchAndReadWithRetry`.

**Tech Stack:** Next.js 16 route handlers, Prisma, Upstash Redis, next-intl messages, React client components on the app kit (`components/app-ui`), the site kit (`src/site/site-css.ts`), offline smoke scripts run with tsx.

**Spec:** `docs/superpowers/specs/2026-11-07-b-features-design.md` (approved by the owner 2026-11-07, every decision as recommended, legal wording included). Research maps (pre-spec, line numbers may have drifted): scratchpad `bfeat/map-plan-ended.md`, `bfeat/map-address-me-as.md`, `bfeat/map-delete-account.md`.

## Global Constraints

- Work only in the worktree `/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/wt-b`, branch `feat/b-features`. Every path below is relative to it.
- One smoke runs as (from the worktree root): `bash -c 'source /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/fake-env.sh; env $E npx tsx scripts/smoke-<name>.ts'`. Below this is written `RUN smoke-<name>`.
- Typecheck: `npx tsc --noEmit -p .`. Lint the files you touched: `npx eslint <files>`. Never `npm run build` (it migrates prod), never `scripts/setup-webhook.ts`, never read `.env*` files (grep with `--exclude='.env*'`).
- A parallel branch (`feat/calm-voice`) edits `messages/{en,he,ru}.json`, `app/[locale]/(app)/settings/SettingsClient.tsx`, `app/api/settings/route.ts`, `src/lib/page-data.ts` and `src/services/account-linking.ts`. In those files add keys and lines only; never reorder, reformat or rewrite a JSON file (no `JSON.stringify` round trip: the Russian file holds raw U+00A0 and ` ` escapes that a round trip would rewrite). Edit JSON with the Edit tool at the anchors given, or with the exact-replacement script of Task 2.
- Every user-facing string is in `messages/{en,he,ru}.json`. Hebrew is natively written and gender-neutral (plural address: אתם, לכם). Russian is formal (вы), and binds every one-letter word (в, с, к, о, у, и, а, я) to the next word with a no-break space; in JSON write it as ` ` (it decodes to the same character).
- The legal texts (`legal.*`) change only to the spec's approved wording, in all three languages at once, with `LEGAL_UPDATED` (src/site/legal.ts) set to `'2026-11-07'` for both pages (the controller moves it if the ship day differs).
- No console line or Sentry field holds an email address, a code, a token, a name, a push endpoint, a key, or a notification's title or body. Log user ids, kinds, statuses and counts.
- A send nobody asked for asks `isPaused(user, at, '<kind>')` first (CLAUDE.md); a reply to the person's own action does not. Every file that sends is classified in `scripts/smoke-pause.ts`.
- UI: mobile first, no hover-only UI, 16 px inputs, logical CSS properties, lucide icons only (no emoji), kit components only (`components/app-ui/form-kit.tsx`, `Notice`, `BottomSheet`). UI tasks start by invoking the frontend-design skill.
- Commit after each task with this trailer, exactly:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
```

## Review Focus

1. A Telegram button `gd:f` pressed by a Telegram id that has no account (deleted, or a forwarded message): nothing is created or saved, the spinner is answered, one line is logged. Pinned in Task 5 (C5).
2. Delete account pressed twice, or in a second tab, after the first went through: the second answers 404 with the cookie cleared, and the sheet says "already deleted" instead of an error. Pinned in Task 6 (D8) and Task 7 (U7).
3. A trial that ends for an account whose stored language is empty or unknown: the notification is in English, never a raw key. Pinned in Task 1 (user 6 in the no-chat check).
4. A sign-up body whose `gender` is the wrong case or type (`'Female'`, `['male']`, `null`, `1`): 400 `gender`, the sign-up record untouched, nothing made. Pinned in Task 3 (S22).
5. A self-delete while Redis refuses the disconnect marker: the account is still deleted (the marker is best effort), the failure is logged and reported. Pinned in Task 6 (the bug-batch-safety check).

---

### Task 1: B1, the trial-ended notice by browser notification

**Files:**
- Modify: `src/services/web-push/send.ts` (the kind, its lifetime, urgency, PAUSED_KINDS)
- Modify: `src/services/subscription-service.ts` (imports at the top; `expireTrialSubscription`; a new private `sendTrialEndedPush` right after it)
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (`bot.push.planEndedTitle`, `bot.push.planEndedBody`)
- Modify: `scripts/smoke-web-push-send.ts` (W2's pinned objects)
- Modify: `scripts/smoke-pause-subscription.ts` (the push stub, the no-chat checks)
- Modify: `scripts/smoke-pause.ts` (the PAUSED reason of subscription-service.ts only)
- Modify: `docs/superpowers/specs/2026-11-05-web-push-design.md` (the kind table, §3.6), `CLAUDE.md` (the web push rule's list of scheduled callers), `README.md` (Notifications in the browser)

**Interfaces:**
- Produces: `PushKind` gains `'plan-ended'` (lifetime 86 400 s, urgency `'normal'`, in `PAUSED_KINDS`). Messages `bot.push.planEndedTitle`, `bot.push.planEndedBody`.
- Consumes: `canReachByPush`, `PUSH_DEVICE_COUNT`, `pushDeviceCountOf` (`src/services/web-push/reach.ts`), `sendWebPush` (`src/services/web-push/send.ts`), `getBotMessage` (`src/lib/bot-messages.ts`), `buildUrl` (`src/config/urls.ts`), `normalizeLocale` (`src/utils/locale.ts`).

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke-web-push-send.ts`, check W2, replace the three pinned lines and the asks line:

```ts
    assert(show(send.PUSH_LIFETIME_S) === show({ reminder: 3600, alert: 86400, briefing: 10800, 'partner-accepted': 86400, 'partner-done': 86400, reconnect: 86400, 'plan-ended': 86400, test: 600 }), `lifetimes ${show(send.PUSH_LIFETIME_S)}`);
    assert(show(send.PUSH_URGENCY) === show({ reminder: 'high', alert: 'high', briefing: 'normal', 'partner-accepted': 'normal', 'partner-done': 'low', reconnect: 'normal', 'plan-ended': 'normal', test: 'normal' }), `urgency ${show(send.PUSH_URGENCY)}`);
    assert(show(send.PAUSED_KINDS) === show(['reminder', 'alert', 'briefing', 'reconnect', 'plan-ended']), `paused kinds ${show(send.PAUSED_KINDS)}`);
```

and

```ts
    assert(show(pauseAsks.map((a) => [a.withinMs, a.from])) === show([[3_600_000, T0.toISOString()], [86_400_000, T0.toISOString()], [10_800_000, T0.toISOString()], [86_400_000, T0.toISOString()], [86_400_000, T0.toISOString()]]), `asked ${show(pauseAsks)}`);
```

In W2's title, change `the notices 24 h` to `the notices and the trial-ended notice 24 h` and `(reminder, alert, briefing, reconnect)` to `(reminder, alert, briefing, reconnect, plan-ended)`.

In `scripts/smoke-pause-subscription.ts`:

1. Add `import fs from 'node:fs';` under `import path from 'node:path';`, and right after the `const ROOT = ...` line:

```ts
// Browser notifications are set up (reach.ts asks pushConfigured): fake keys, never real ones; sendWebPush is a recorder
process.env.VAPID_PUBLIC_KEY = 'smoke-vapid-public';
process.env.VAPID_PRIVATE_KEY = 'smoke-vapid-private';
const PUSH_WORDS = Object.fromEntries(['en', 'he'].map(l => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8')).bot.push])) as Record<'en' | 'he', Record<string, string>>;
```

2. Next to `let trialNotices: number[] = [];` add:

```ts
let pushes: { user: Row; input: Row }[] = [];
const earlyAdopters = new Set<number>();
```

3. Replace `userFeatureOverride: { findUnique: async () => null },` in `fakePrisma` with:

```ts
  userFeatureOverride: { findUnique: async ({ where }: { where: { userId: number } }) => (earlyAdopters.has(where.userId) ? { userId: where.userId, earlyAdopter: true } : null) },
```

4. In `installStubs()`, after the `src/services/telegram/index.ts` stub:

```ts
  stub('src/services/web-push/send.ts', {
    sendWebPush: async (user: Row, input: Row) => { pushes.push({ user, input }); return { sent: 1, total: 1, retriable: false }; },
  });
```

5. In `reset()`, after `trialNotices = [];`: `pushes = [];` and `earlyAdopters.clear();`.

6. Update the header comment's "And a person with no Telegram" paragraph to:

```ts
// And a person with no chat (web sign-up plan, Task 12; B features plan, Task 1): the trial-expired notice goes to Telegram,
// or, for an account with no chat (made on famcal.bot) and a browser with notifications on, as one browser notification
// (kind plan-ended, the plan page, the account's language). The pause holds it as it holds Telegram's. An account with no
// device, and a WhatsApp-only one (WhatsApp alone reaches nobody here), is skipped with one line naming the send and the
// user id (`[trial-expired notice] skipped user <id>: no Telegram and no device with notifications on`); the trial ends
// all the same. An early adopter is told nothing. The renewal and expiry passes keep their guards and their own skip lines.
```

7. Replace the whole check `'no Telegram: the trial-expired notice to an account with no Telegram is skipped with one line, and its trial ends all the same'` with:

```ts
  const trialOver = (userId: number): Row => ({ userId, plan: 'FREE', status: 'TRIALING', compedBy: null, trialEndsAt: new RealDate(at('2026-10-10T00:00:00Z')), currentPeriodEnd: null });

  await check('no chat: the trial-expired notice reaches an account with no chat and a device as one browser notification (kind plan-ended, tag plan-ended, the plan page, its language; an empty language reads as English); one with no device, and a WhatsApp-only one, is skipped with one line; Telegram still gets Telegram\'s; every trial ends', async () => {
    reset();
    clock = at(TUESDAY);
    noChat(3, { language: 'he', _count: { pushDevices: 2 } });
    noChat(4, { _count: { pushDevices: 0 } });
    noChat(5, { whatsappPhone: '+972500000005', _count: { pushDevices: 1 } });
    noChat(6, { language: '', _count: { pushDevices: 1 } });
    subscriptions = [trialOver(2), trialOver(3), trialOver(4), trialOver(5), trialOver(6)];
    for (const id of [2, 3, 4, 5, 6]) await service.getSubscriptionWithUsage(id);
    assert(subscriptions.every(s => s.status === 'EXPIRED' && s.plan === 'FREE'), `trials: ${show(subscriptions.map(s => [s.userId, s.status]))}`);
    assert(trialNotices.join(',') === '1002', `Telegram notices: ${trialNotices.join(',') || '(nothing)'}`);
    assert(show(pushes.map(p => [p.user.id, p.input.kind, p.input.tag, p.input.lang])) === show([[3, 'plan-ended', 'plan-ended', 'he'], [6, 'plan-ended', 'plan-ended', 'en']]), `pushes ${show(pushes.map(p => p.input))}`);
    const [he, en] = pushes;
    assert(he.input.title === PUSH_WORDS.he.planEndedTitle && he.input.body === PUSH_WORDS.he.planEndedBody && String(he.input.url).endsWith('/he/subscription?user_id=3'), `Hebrew push ${show(he.input)}`);
    assert(en.input.title === PUSH_WORDS.en.planEndedTitle && en.input.body === PUSH_WORDS.en.planEndedBody && String(en.input.url).endsWith('/en/subscription?user_id=6'), `English push ${show(en.input)}`);
    assert(skips.join('|') === '[trial-expired notice] skipped user 4: no Telegram and no device with notifications on|[trial-expired notice] skipped user 5: no Telegram and no device with notifications on', `logged: ${skips.join('|') || '(nothing)'}`);
  });

  await check('no chat, paused: a trial found over inside Shabbat sends no browser notification to an account whose switch is on (the pause line), and the trial ends', async () => {
    reset();
    clock = at(SATURDAY);
    noChat(7, { pauseOnShabbat: true, _count: { pushDevices: 1 } });
    subscriptions = [trialOver(7)];
    await service.getSubscriptionWithUsage(7);
    assert(subscriptions[0].status === 'EXPIRED' && pushes.length === 0, `trial ${show(subscriptions[0])}, pushes ${show(pushes)}`);
    assert(logs.join('|') === '[pause] skipped trial-expired notice for 7', `logged: ${logs.join('|') || '(nothing)'}`);
  });

  await check('no chat, early adopter: the trial ends and nothing is sent or logged as skipped', async () => {
    reset();
    clock = at(TUESDAY);
    noChat(8, { _count: { pushDevices: 1 } });
    earlyAdopters.add(8);
    subscriptions = [trialOver(8)];
    await service.getSubscriptionWithUsage(8);
    assert(subscriptions[0].status === 'EXPIRED' && pushes.length === 0 && skips.length === 0, `trial ${show(subscriptions[0])}, pushes ${show(pushes)}, skips ${skips.join('|')}`);
  });
```

(`noChat` copies user 2, whose place is Jerusalem; `pick` honours `select`, so `_count` reaches the code only because `PUSH_DEVICE_COUNT` selects it.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `RUN smoke-web-push-send` — Expected: FAIL W2 (`lifetimes {... no plan-ended}`).
Run: `RUN smoke-pause-subscription` — Expected: FAIL the first no-chat check (`pushes []`, and the old skip line `... no Telegram`).

- [ ] **Step 3: The push kind**

In `src/services/web-push/send.ts`:

```ts
export type PushKind = 'reminder' | 'alert' | 'briefing' | 'partner-accepted' | 'partner-done' | 'reconnect' | 'plan-ended' | 'test';
```

In `PUSH_LIFETIME_S`, after `reconnect: 86_400,` add `'plan-ended': 86_400,`. In `PUSH_URGENCY`, after `reconnect: 'normal',` add `'plan-ended': 'normal',`. Then:

```ts
/** The scheduled kinds: their callers ask the pause, and their lifetime ends before the next window. */
export const PAUSED_KINDS: readonly PushKind[] = ['reminder', 'alert', 'briefing', 'reconnect', 'plan-ended'];
```

- [ ] **Step 4: The strings**

In `messages/en.json`, inside `bot.push`, after `"partnerIsDone": "{name} is done"` (add a comma to that line):

```json
      "partnerIsDone": "{name} is done",
      "planEndedTitle": "Your Pro trial has ended",
      "planEndedBody": "You're on the Free plan now, so reminders and event alerts have stopped. Your calendar stays as it is."
```

`messages/he.json`, same place (after `"partnerIsDone": "{name}: בוצע"`):

```json
      "partnerIsDone": "{name}: בוצע",
      "planEndedTitle": "תקופת הניסיון של Pro נגמרה",
      "planEndedBody": "עכשיו אתם במסלול החינמי, ולכן התזכורות וההתראות לפני אירועים נפסקו. היומן שלכם נשאר כמו שהוא."
```

`messages/ru.json`, same place (after `"partnerIsDone": "{name}: готово"`):

```json
      "partnerIsDone": "{name}: готово",
      "planEndedTitle": "Пробный период Pro закончился",
      "planEndedBody": "Теперь у вас бесплатный тариф, поэтому напоминания и уведомления о событиях больше не приходят. Ваш календарь остаётся без изменений."
```

- [ ] **Step 5: The sender**

In `src/services/subscription-service.ts`, replace `import { isPaused } from './zmanim/pause';` with:

```ts
import { isPaused, type PauseUser } from './zmanim/pause';
import { canReachByPush, PUSH_DEVICE_COUNT, pushDeviceCountOf } from './web-push/reach';
import { getBotMessage } from '../lib/bot-messages';
import { buildUrl } from '../config/urls';
import { normalizeLocale } from '../utils/locale';
```

In `expireTrialSubscription`, replace everything from the comment `// Send trial expired notification to user (non-blocking, skip for early adopters)` to the end of that `if (!await checkEarlyAdopterAccess(userId)) { ... }` block with:

```ts
  // The trial-ended notice (non-blocking, skipped for early adopters): in Telegram, or, for an account with no chat (made on
  // famcal.bot), as a browser notification on each device with notifications on (spec 2026-11-07-b-features §B1).
  if (!await checkEarlyAdopterAccess(userId)) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          telegramId: true, whatsappPhone: true, whatsappBsuid: true, language: true,
          // The Shabbat and Yom Tov pause (isPaused): the switch, and the place and community its windows are counted at
          location: true, pauseOnShabbat: true, zmanimCommunity: true, latitude: true, longitude: true, elevationM: true,
          // The browsers with notifications on, counted in the same statement (canReachByPush)
          ...PUSH_DEVICE_COUNT,
        },
      });
      // Shabbat and Yom Tov (the pause): the trial ends all the same, but the notice is not sent (it is sent once, by
      // whichever plan check first finds the trial over, so no later check would tell the person).
      // WhatsApp alone reaches nobody here (the notice is Telegram's, and push is for an account with no chat): skipped, logged.
      if (!user) {
        console.warn(`[trial-expired notice] skipped user ${userId}: no user row`);
      } else if (user.telegramId) {
        if (!(await isPaused({ ...user, id: userId }, new Date(), 'trial-expired notice'))) {
          const { sendTrialExpiredNotification } = await import('./telegram');
          await sendTrialExpiredNotification(Number(user.telegramId), user.language || 'en');
        }
      } else if (canReachByPush({ ...user, pushDeviceCount: pushDeviceCountOf(user) })) {
        if (!(await isPaused({ ...user, id: userId }, new Date(), 'trial-expired notice'))) await sendTrialEndedPush(userId, user);
      } else {
        console.log(`[trial-expired notice] skipped user ${userId}: no Telegram and no device with notifications on`);
      }
    } catch (error) {
      console.error(`[Subscription] Failed to send trial expired notification for user ${userId}:`, error);
      captureError(error, 'subscription-trial-expired-notify', { user_id: userId }, 'warning');
    }
  }
```

Right after the closing brace of `expireTrialSubscription`, add:

```ts
/**
 * The trial-ended notice as a browser notification (spec 2026-11-07-b-features §B1): the title and text in the account's
 * language (English for none or an unknown one), a tap opening the plan page, whose no-chat state offers Connect Telegram.
 * It says what changed and nothing about paying, so it stays true when other ways to pay arrive. A push no device takes
 * is logged and not sent again: the trial is EXPIRED already, so no later check sends it (as with a failed Telegram send).
 * The caller has asked the pause. sendWebPush never throws and logs its own "[push] user <id>: plan-ended sent to N of M".
 */
async function sendTrialEndedPush(userId: number, user: Omit<PauseUser, 'id'> & { language: string | null }): Promise<void> {
  const lang = normalizeLocale(user.language);
  const { sendWebPush } = await import('./web-push/send');
  const result = await sendWebPush({ ...user, id: userId }, {
    kind: 'plan-ended',
    title: await getBotMessage(lang, 'push.planEndedTitle'),
    body: await getBotMessage(lang, 'push.planEndedBody'),
    url: buildUrl(`/${lang}/subscription?user_id=${userId}`),
    tag: 'plan-ended',
    lang,
  });
  if (result.sent === 0) console.log(`[trial-expired notice] user ${userId}: no device took the notification; it is not sent again`);
}
```

- [ ] **Step 6: The pause table's reason**

In `scripts/smoke-pause.ts`, `PAUSED`:

```ts
  'src/services/subscription-service.ts': 'the trial-expired notice (in Telegram, or a browser notification for an account with no chat), sent when the first check after the trial finds it over',
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `RUN smoke-web-push-send` — Expected: every check OK.
Run: `RUN smoke-pause-subscription`, then `TZ=Asia/Jerusalem` the same (`bash -c 'source …/fake-env.sh; env $E TZ=Asia/Jerusalem npx tsx scripts/smoke-pause-subscription.ts'`) — Expected: all passed, under both zones.
Run: `RUN smoke-pause`, `RUN smoke-push-reach`, `RUN smoke-comp-subscription`, `RUN smoke-subscription-render` — Expected: all passed.
Run: `npx tsc --noEmit -p .` — Expected: no errors.

- [ ] **Step 8: Docs**

`docs/superpowers/specs/2026-11-05-web-push-design.md`:
- in the §2 "What" line (line 13), after `the partner notices (an invite accepted, a shared reminder marked Done)` add `, the notice that the trial ended (B features spec 2026-11-07 §B1)`;
- in the "Not sent as a notification" line (line 25), replace `trial and downgrade notices` with `downgrade notices (the trial-ended notice is sent since the B features, §B1)`;
- in the kind table, after the `| Google reconnect | … |` row add:

```markdown
| Trial ended | the first plan check after the trial ends, as on Telegram (B features spec §B1) | "Your Pro trial has ended" | "You're on the Free plan now, so reminders and event alerts have stopped. Your calendar stays as it is." (opens the plan page) |
```

- in the pause bullet under the table and in §3.6's "The pause" bullet, add `the trial-ended notice` to the list of scheduled ones; in §3.6's lifetimes, change `the partner notices and the reconnect message: 24 hours.` to `the partner notices, the reconnect message and the trial-ended notice: 24 hours.`

`CLAUDE.md`, the web push rule: change `each scheduled caller (the reminder pass, the event alerts, the briefings, the Google reconnect message) asks` to `each scheduled caller (the reminder pass, the event alerts, the briefings, the Google reconnect message, the trial-ended notice) asks`.

`README.md`, "Notifications in the browser" first paragraph: change `a short morning and evening line listing the day, and the partner notices` to `a short morning and evening line listing the day, the partner notices, and a notice when the trial ends`.

Run `RUN smoke-web-push-send` again (it reads CLAUDE.md's retry rules) — Expected: all OK.

- [ ] **Step 9: Commit**

```bash
git add src/services/web-push/send.ts src/services/subscription-service.ts messages/en.json messages/he.json messages/ru.json scripts/smoke-web-push-send.ts scripts/smoke-pause-subscription.ts scripts/smoke-pause.ts docs/superpowers/specs/2026-11-05-web-push-design.md CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
feat(push): the trial-ended notice reaches an account with no chat as a browser notification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

Not in scope (report only, spec B1): `expireSubscriptions` (src/services/subscription-reminders.ts) skips the downgrade for a paid account with no Telegram id; unreachable today.

---

### Task 2: The legal texts (B1's Terms clause, B3's Policy and Terms lines)

**Files:**
- Modify: `messages/en.json`, `messages/he.json`, `messages/ru.json` (legal.privacy rights, legal.terms service and suspension)
- Modify: `src/site/legal.ts` (`LEGAL_UPDATED`)
- Modify: `scripts/lib/legal-push.ts` (T2's `to` in three languages, the header line)
- Modify: `scripts/smoke-signin-legal.ts` (the three pinned Terms fragments; a new L7)
- Create (scratchpad only, never committed): `/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/bfeat/apply-legal-b.py`

**Interfaces:**
- Produces: the approved wording in the messages (Tasks 1, 6 and 7 rely on it existing; nothing reads it as code).
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-signin-legal.ts`, `SAYS_SIGNUP`, replace the last entry of each language:

```ts
    ['terms', 'You can stop using FamCal any time: block the bot if you use it, and delete your account in Settings, or ask us to delete it'],
```
```ts
    ['terms', 'אפשר להפסיק להשתמש ב־FamCal בכל עת: לחסום את הבוט, אם אתם משתמשים בו, ולמחוק את החשבון בהגדרות, או לבקש'],
```
```ts
    ['terms', 'заблокируйте бота, если вы им пользуетесь, и удалите аккаунт в «Настройках» или попросите нас его удалить'],
```

Above `async function main()`, add:

```ts
/**
 * What the B features (spec 2026-11-07-b-features §B1, §B3, approved by the owner 2026-11-07 with the wording) say, page by
 * page, and the sentences they replaced. Russian is written with plain spaces (text() reads U+00A0 as one).
 */
const SAYS_B: Record<Locale, [Doc, string][]> = {
  en: [
    ['privacy', 'You can also delete your account yourself in Settings. There’s no button yet to download your data. We make you a copy by hand when you ask.'],
    ['privacy', 'unlink your partner in the web app;'],
    ['privacy', 'delete your account in Settings. It can’t be undone: below is what we delete and what stays.'],
    ['terms', 'Reminders, event alerts, a short notification that lists the day’s events and a notice when your trial ends reach you on each phone or computer'],
    ['terms', 'and delete your account in Settings, or ask us to delete it (see the [Privacy Policy](/privacy)). Your plan ends with the account: to cancel a payment, ask us before you delete the account (see “Cancelling and refunds” above).'],
  ],
  he: [
    ['privacy', 'אפשר גם למחוק את החשבון בעצמכם, בהגדרות. עדיין אין כפתור להורדת המידע שלכם. כשמבקשים, אנחנו מכינים לכם עותק ידנית.'],
    ['privacy', 'לבטל את הקישור לבן או בת הזוג באפליקציית הרשת;'],
    ['privacy', 'למחוק את החשבון בהגדרות. אי אפשר לבטל את המחיקה: בהמשך מפורט מה אנחנו מוחקים ומה נשאר.'],
    ['terms', 'תזכורות, התראות לפני אירועים, התראה קצרה עם רשימת האירועים של היום והודעה כשתקופת הניסיון נגמרת מגיעות אליכם'],
    ['terms', 'ולמחוק את החשבון בהגדרות, או לבקש מאיתנו למחוק אותו (ראו [מדיניות הפרטיות](/privacy)). המסלול נגמר יחד עם החשבון: כדי לבטל תשלום, פנו אלינו לפני שמוחקים את החשבון (ראו ״ביטול והחזרים״ למעלה).'],
  ],
  ru: [
    ['privacy', 'Удалить аккаунт можно и самостоятельно, в «Настройках». Кнопки, чтобы скачать свои данные, пока нет. По вашей просьбе мы готовим копию вручную.'],
    ['privacy', 'разорвать связь с партнёром в веб-приложении;'],
    ['privacy', 'удалить аккаунт в «Настройках». Отменить удаление нельзя: ниже сказано, что мы удаляем и что остаётся.'],
    ['terms', 'Напоминания, уведомления о событиях, краткое уведомление со списком событий дня и сообщение об окончании пробного периода приходят'],
    ['terms', 'и удалите аккаунт в «Настройках» или попросите нас его удалить (см. [Политику конфиденциальности](/privacy)). Тариф заканчивается вместе с аккаунтом: чтобы отменить платёж, напишите нам до того, как удалите аккаунт (см. «Отмена и возврат» выше).'],
  ],
};
const GONE_B: Record<Locale, [Doc, string][]> = {
  en: [['privacy', 'There’s no button yet to delete your account or download your data.'], ['terms', 'and ask us to delete your account (see'], ['terms', 'Reminders, event alerts and a short notification']],
  he: [['privacy', 'עדיין אין כפתור למחיקת החשבון או להורדת המידע שלכם.'], ['terms', 'ולבקש מאיתנו למחוק את החשבון (ראו'], ['terms', 'תזכורות, התראות לפני אירועים והתראה קצרה']],
  ru: [['privacy', 'Кнопки, чтобы удалить аккаунт или скачать свои данные, пока нет.'], ['terms', 'и попросите нас удалить ваш аккаунт (см.'], ['terms', 'Напоминания, уведомления о событиях и краткое уведомление']],
};
```

After the L6 check (before `let failed = 0;`), add:

```ts
  await check('L7 each language says what the B features (spec 2026-11-07-b-features §B1, §B3) add: deleting the account in Settings (the rights paragraph and the "you can also" list), the trial-ended notice among the browser notifications, and the Terms\' closing line with the plan ending with the account; the sentences they replaced are gone', () => {
    const problems: string[] = [];
    for (const locale of LOCALES) {
      for (const [doc, want] of SAYS_B[locale]) if (!text(locale, doc).includes(want)) problems.push(`${locale} ${doc}: lacks "${want.slice(0, 70)}…"`);
      for (const [doc, old] of GONE_B[locale]) if (text(locale, doc).includes(old)) problems.push(`${locale} ${doc}: still "${old}"`);
    }
    assert(problems.length === 0, problems.join('\n'));
  });
```

Add `//  - L7 the B features' wording (spec 2026-11-07-b-features §B1, §B3): deleting the account in Settings, the trial notice, the plan ending with the account.` to the header list.

- [ ] **Step 2: Run the test to verify it fails**

Run: `RUN smoke-signin-legal` — Expected: FAIL L5 (the three new fragments missing) and L7.

- [ ] **Step 3: Apply the wording**

Write `/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/bfeat/apply-legal-b.py` (a tool input, not a repo file):

```python
"""The B features' legal edits (spec 2026-11-07-b-features §B1, §B3), as exact replacements. `~` is U+00A0 (Russian only).
Every old text must occur exactly once; the files are rewritten byte for byte apart from the replacements."""
import sys

ROOT = sys.argv[1]
NB = ' '
EDITS = {
    'en': [
        ('There’s no button yet to delete your account or download your data. We do both by hand when you ask.',
         'You can also delete your account yourself in Settings. There’s no button yet to download your data. We make you a copy by hand when you ask.'),
        ('"unlink your partner in the web app."',
         '"unlink your partner in the web app;",\n              "delete your account in Settings. It can’t be undone: below is what we delete and what stays."'),
        ('Reminders, event alerts and a short notification that lists the day’s events reach you',
         'Reminders, event alerts, a short notification that lists the day’s events and a notice when your trial ends reach you'),
        ('You can stop using FamCal any time: block the bot if you use it, and ask us to delete your account (see the [Privacy Policy](/privacy)).',
         'You can stop using FamCal any time: block the bot if you use it, and delete your account in Settings, or ask us to delete it (see the [Privacy Policy](/privacy)). Your plan ends with the account: to cancel a payment, ask us before you delete the account (see “Cancelling and refunds” above).'),
    ],
    'he': [
        ('עדיין אין כפתור למחיקת החשבון או להורדת המידע שלכם. כשמבקשים, אנחנו עושים את שניהם ידנית.',
         'אפשר גם למחוק את החשבון בעצמכם, בהגדרות. עדיין אין כפתור להורדת המידע שלכם. כשמבקשים, אנחנו מכינים לכם עותק ידנית.'),
        ('"לבטל את הקישור לבן או בת הזוג באפליקציית הרשת."',
         '"לבטל את הקישור לבן או בת הזוג באפליקציית הרשת;",\n              "למחוק את החשבון בהגדרות. אי אפשר לבטל את המחיקה: בהמשך מפורט מה אנחנו מוחקים ומה נשאר."'),
        ('תזכורות, התראות לפני אירועים והתראה קצרה עם רשימת האירועים של היום מגיעות אליכם',
         'תזכורות, התראות לפני אירועים, התראה קצרה עם רשימת האירועים של היום והודעה כשתקופת הניסיון נגמרת מגיעות אליכם'),
        ('אפשר להפסיק להשתמש ב־FamCal בכל עת: לחסום את הבוט, אם אתם משתמשים בו, ולבקש מאיתנו למחוק את החשבון (ראו [מדיניות הפרטיות](/privacy)).',
         'אפשר להפסיק להשתמש ב־FamCal בכל עת: לחסום את הבוט, אם אתם משתמשים בו, ולמחוק את החשבון בהגדרות, או לבקש מאיתנו למחוק אותו (ראו [מדיניות הפרטיות](/privacy)). המסלול נגמר יחד עם החשבון: כדי לבטל תשלום, פנו אלינו לפני שמוחקים את החשבון (ראו ״ביטול והחזרים״ למעלה).'),
    ],
    'ru': [
        ('Кнопки, чтобы удалить аккаунт или скачать свои данные, пока нет. По вашей просьбе мы делаем и~то и~другое вручную.',
         'Удалить аккаунт можно и~самостоятельно, в~«Настройках». Кнопки, чтобы скачать свои данные, пока нет. По вашей просьбе мы готовим копию вручную.'),
        ('"разорвать связь с~партнёром в~веб-приложении."',
         '"разорвать связь с~партнёром в~веб-приложении;",\n              "удалить аккаунт в~«Настройках». Отменить удаление нельзя: ниже сказано, что мы удаляем и~что остаётся."'),
        ('Напоминания, уведомления о~событиях и~краткое уведомление со списком событий дня приходят',
         'Напоминания, уведомления о~событиях, краткое уведомление со списком событий дня и~сообщение об окончании пробного периода приходят'),
        ('Вы можете перестать пользоваться FamCal в~любой момент: заблокируйте бота, если вы им пользуетесь, и~попросите нас удалить ваш аккаунт (см. [Политику конфиденциальности](/privacy)).',
         'Вы можете перестать пользоваться FamCal в~любой момент: заблокируйте бота, если вы им пользуетесь, и~удалите аккаунт в~«Настройках» или попросите нас его удалить (см. [Политику конфиденциальности](/privacy)). Тариф заканчивается вместе с~аккаунтом: чтобы отменить платёж, напишите нам до того, как удалите аккаунт (см. «Отмена и~возврат» выше).'),
    ],
}
for lang, edits in EDITS.items():
    path = f'{ROOT}/messages/{lang}.json'
    with open(path, encoding='utf-8', newline='') as f:
        text = f.read()
    for old, new in edits:
        if lang == 'ru':
            old, new = old.replace('~', NB), new.replace('~', NB)
        count = text.count(old)
        if count != 1:
            sys.exit(f'{lang}: expected the old text once, found it {count} times: {old[:60]}')
        text = text.replace(old, new)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    print(f'{lang}: {len(edits)} edits')
```

Run it: `python3 -I /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/bfeat/apply-legal-b.py "$PWD"` — Expected: `en: 4 edits`, `he: 4 edits`, `ru: 4 edits`. Then check the files still parse: `node -e "for (const l of ['en','he','ru']) JSON.parse(require('fs').readFileSync('messages/'+l+'.json','utf8')); console.log('ok')"` — Expected: `ok`. `git diff --stat messages/` — Expected: only the replaced lines and the 3 new list lines.

- [ ] **Step 4: The date and the push fixture**

`src/site/legal.ts`:

```ts
export const LEGAL_UPDATED = { privacy: '2026-11-07', terms: '2026-11-07' } as const;
```

`scripts/lib/legal-push.ts`, T2 of each language, change only the start of `to`:
- en: `to: 'Reminders, event alerts and a short notification that lists the day’s events reach you` → `to: 'Reminders, event alerts, a short notification that lists the day’s events and a notice when your trial ends reach you`
- he: `to: 'תזכורות, התראות לפני אירועים והתראה קצרה עם רשימת האירועים של היום מגיעות` → `to: 'תזכורות, התראות לפני אירועים, התראה קצרה עם רשימת האירועים של היום והודעה כשתקופת הניסיון נגמרת מגיעות`
- ru: `to: 'Напоминания, уведомления о событиях и краткое уведомление со списком событий дня приходят` → `to: 'Напоминания, уведомления о событиях, краткое уведомление со списком событий дня и сообщение об окончании пробного периода приходят`

and add to its header comment: `// T2 carries the trial-ended notice the B features added to that sentence (spec 2026-11-07-b-features §B1, approved 2026-11-07).`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `RUN smoke-signin-legal` — Expected: all passed (L1 parity, L3 the date, L5, L6, L7).
Run: `RUN smoke-site-truth` (T6 Russian typography over legal.*), `RUN smoke-terms-plans`, `RUN smoke-google-disconnect-ui` (its privacy patterns) — Expected: all passed.

- [ ] **Step 6: Commit**

```bash
git add messages/en.json messages/he.json messages/ru.json src/site/legal.ts scripts/lib/legal-push.ts scripts/smoke-signin-legal.ts
git commit -m "$(cat <<'EOF'
docs(legal): delete your account in Settings, the trial-ended notice, the plan ending with the account

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 3: B2 server core: one `isGender`, the web sign-up's choice, `getOrCreateUser`'s `created`

**Files:**
- Create: `src/lib/gender.ts`
- Modify: `app/api/settings/route.ts` (line 17 only, plus one import)
- Modify: `src/services/user-service.ts` (`NewAccount`, `accountData`, `getOrCreateUser`)
- Modify: `src/services/web-signin/signup.ts` (`SignUpBody`, the refusal, the check, the pass-through, the log line)
- Modify: `app/api/auth/signup/route.ts` (the header comment only)
- Modify: `src/services/telegram/commands.ts:134`, `src/services/webhook-handlers.ts:583-584` (destructure `{ user }`)
- Modify (tests): `scripts/smoke-account-create.ts`, `scripts/smoke-signup.ts`, `scripts/smoke-invite-web.ts`, `scripts/smoke-ban-web.ts`, and the `getOrCreateUser` stubs in `scripts/smoke-album-pdf.ts`, `scripts/smoke-week-commands.ts`, `scripts/smoke-weather-command.ts`, `scripts/smoke-native-reminder-typed.ts`

**Interfaces:**
- Produces: `type Gender = 'male' | 'female'` and `isGender(value: unknown): value is Gender` (`src/lib/gender.ts`); `NewAccount`'s web arm `{ via: 'web'; way; name: string; gender: Gender; language: Locale }`; `getOrCreateUser(telegramId: number, telegramUser?: TelegramUserInfo): Promise<{ user: UserConfig; created: boolean }>`; the sign-up refusal `{ ok: false, status: 'gender' }` (400); the body `{ name, gender, locale }`; the log line `[gender] user <id> chose via web`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

`scripts/smoke-account-create.ts`:
- In #3, replace the calls and their uses:

```ts
    const { user: dana, created } = await users.getOrCreateUser(5550001, { first_name: 'Dana', last_name: 'Levi', language_code: 'he-IL' });
    assert(created === true, 'a new Telegram id: created is not true');
```
```ts
    const again = await users.getOrCreateUser(5550001, { first_name: 'Other' });
    assert(again.created === false && again.user.id === dana.id && DB.user.length === 2 && calendarsOf(row.id).length === 1 && createdLines().length === 1, 'the same Telegram id made a second account, or said created');
```
- Give every `users.createAccount({ via: 'web', ...})` call a gender: run `python3 -I -c "import re,sys;p='scripts/smoke-account-create.ts';s=open(p,encoding='utf-8').read();s=s.replace(\"{ via: 'web', way:\",\"{ via: 'web', gender: 'male', way:\");open(p,'w',encoding='utf-8').write(s)"`, then in #5 change the first call (Dana by email) to `gender: 'female'` and its `want` to `{ ..., ...SHARED, gender: 'female' }` (keep the order of keys of `got`: put `gender: 'female'` after the `...SHARED` spread so it overrides). Add to #5's title: `, and the gender chosen at sign-up (female here)`.

`scripts/smoke-signup.ts`:
- Make the `create` helper send a gender unless the test gives one:

```ts
  /** Create account: the body as given, with "Address me as" set to male unless the body says (a key present with undefined sends none). */
  const create = (cookie: string | undefined, b: unknown, o: { ip?: string | null; origin?: string | null } = {}) =>
    need(signupRoute, 'POST /api/auth/signup').POST(request('/api/auth/signup', { body: b !== null && typeof b === 'object' && !Array.isArray(b) && !('gender' in b) ? { gender: 'male', ...b } : b, cookie, ...o }));
```

- Add after S21:

```ts
  await check('S22 "Address me as": Create account refuses a missing or unknown choice (absent, null, empty, another word, another case, a number, a list, an object) with status=gender (400) after the name and before the record is touched: the sign-up still answers and nothing is made; female and male are stored as chosen; the log names the user id and the way only', async () => {
    seed();
    const cookie = await signUpFlow();
    for (const bad of [undefined, null, '', 'other', 'Female', 'MALE', 1, ['female'], { v: 'male' }]) {
      const res = await create(cookie, { name: NAME, gender: bad });
      const answer = await body(res);
      assert(res.status === 400 && show(answer) === show({ ok: false, status: 'gender' }), `${show(bad)}: ${res.status} ${show(answer)}`);
    }
    assert(show(await body(await create(cookie, { name: '', gender: 'nope' }))) === show({ ok: false, status: 'name' }), 'the name is not checked first');
    assert(show(await view(cookie)) === show({ way: 'google', address: DANA.email }) && usersNamed(NAME).length === 0, 'a refused choice used the record or made an account');
    const made = await body(await create(cookie, { name: NAME, gender: 'female' }));
    assert(made.ok === true && usersNamed(NAME).length === 1 && usersNamed(NAME)[0].gender === 'female', `stored ${show(usersNamed(NAME).map((u: Row) => u.gender))}`);
    const line = logs.filter((l) => l.startsWith('[gender]'));
    assert(line.length === 1 && /^\[gender\] user \d+ chose via web$/.test(line[0]), `the gender line: ${show(line)}`);
    seed();
    assert((await body(await create(await signUpFlow({ way: 'email', subject: 'rivka@example.com', address: 'rivka@example.com' }), { name: 'Rivka', gender: 'male' }))).ok === true && usersNamed('Rivka')[0]?.gender === 'male', 'male is not stored');
  });
```

(`usersNamed`, `NAME`, `DANA`, `signUpFlow`, `view` and the `logs` import exist in this smoke already.)

`scripts/smoke-invite-web.ts` lines 242, 253, 319: `body: { name: 'Shira' }` → `body: { name: 'Shira', gender: 'female' }`, `{ name: 'Avi' }` → `{ name: 'Avi', gender: 'male' }` (both places).
`scripts/smoke-ban-web.ts` line 340: `body: { name: 'Gina' }` → `body: { name: 'Gina', gender: 'female' }`.

The stubs whose code under test may reach `getOrCreateUser` now answer the new shape:
- `scripts/smoke-album-pdf.ts:239` → `getOrCreateUser: async (telegramId: number) => ({ user: USERS[Number(telegramId)], created: false }),`
- `scripts/smoke-native-reminder-typed.ts:228` → the same.
- `scripts/smoke-week-commands.ts:157` and `scripts/smoke-weather-command.ts:257` → `getOrCreateUser: async () => ({ user, created: false }),`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `RUN smoke-account-create` — Expected: FAIL #3 (`created is not true`) and #5 (gender male).
Run: `RUN smoke-signup` — Expected: FAIL S22 (`undefined: 200 …` or the account made).

- [ ] **Step 3: The shared check**

Create `src/lib/gender.ts`:

```ts
/**
 * "Address me as" (User.gender): the closed set of two, for every input that sets it: Settings (app/api/settings), the
 * sign-up on famcal.bot (src/services/web-signin/signup.ts) and the question a new chat account gets
 * (src/services/address-choice.ts). Anything else (null, '', 'other', another case, a number) is refused, never stored.
 * Client-safe: no import.
 */
export type Gender = 'male' | 'female';

export const isGender = (value: unknown): value is Gender => value === 'male' || value === 'female';
```

In `app/api/settings/route.ts`, delete the line `const isGender = (value: unknown): value is 'male' | 'female' => value === 'male' || value === 'female';` and add after the last import (`import { channelsOf, platformAvailable } from '@/src/lib/delivery-platform';`):

```ts
import { isGender } from '@/src/lib/gender';
```

- [ ] **Step 4: The account**

In `src/services/user-service.ts`, add `import type { Gender } from '../lib/gender';` with the other imports, and:

```ts
  | { via: 'web'; way: { kind: IdentityKind; subject: string; address: string }; name: string; gender: Gender; language: Locale };
```

In `accountData`, the shared default's comment becomes:

```ts
    gender: 'male', // A chat account starts here and is asked once after its first reply (address-choice.ts); the web's sign-up asks first
```

and the web case:

```ts
    case 'web':
      // No chat. "Has a chat" is read from the ids (telegramId, whatsappPhone, whatsappBsuid), never from
      // messagingPlatform, which keeps the schema's default. "Address me as" is the one chosen on the sign-up form.
      return { ...shared, gender: input.gender, name: input.name, language: input.language, messagingPlatform: 'telegram' };
```

Replace `getOrCreateUser` with:

```ts
/**
 * Get or create user by Telegram ID. Auto-registers new users with minimal defaults from Telegram profile (createAccount).
 * `created`: this call made the account, so its first reply is followed by the "Address me as" question once
 * (src/services/address-choice.ts).
 */
export async function getOrCreateUser(
  telegramId: number,
  telegramUser?: TelegramUserInfo
): Promise<{ user: UserConfig; created: boolean }> {
  // Try to find existing user
  const existingUser = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) }
  });

  if (existingUser) {
    return { user: convertPrismaUserToConfig(existingUser), created: false };
  }

  return { user: await createAccount({ via: 'telegram', telegramId, profile: telegramUser }), created: true };
}
```

The two callers: `src/services/telegram/commands.ts:134` → `const { user } = await getOrCreateUser(userIdNum, telegramUser);`, and `src/services/webhook-handlers.ts:584` → `const { user } = await getOrCreateUser(textUserId, update.message.from);`.

- [ ] **Step 5: The sign-up**

In `src/services/web-signin/signup.ts`, add `import { isGender } from '../../lib/gender';` with the imports, and:

```ts
/** Create account's body: the name typed, "Address me as" (male or female, required), and the page's language. */
export type SignUpBody = { name?: unknown; gender?: unknown; locale?: unknown };

type SignUpRefusal = 'name' | 'gender' | 'restart' | 'blocked' | 'limit' | 'taken' | 'failed';
```

In `completeSignUp`, right after the name refusal's `return refuse('name', 400); }`:

```ts
  // "Address me as" (spec 2026-11-07-b-features §B2): required, one of two, refused before the record is touched
  const gender = body.gender;
  if (!isGender(gender)) {
    console.log('[signup] an "Address me as" that is missing or not male or female was refused');
    return refuse('gender', 400);
  }
```

pass it on: `createAccount({ via: 'web', way: { … }, name, gender, language: languageOf(body, flow) })`, and after `console.log(\`[signup] user ${user.id} was made on the web with ${flow.way}\`);` add:

```ts
  console.log(`[gender] user ${user.id} chose via web`);
```

If the file's header comment lists the order of the checks, add "then Address me as" after the name there. In `app/api/auth/signup/route.ts`, the POST comment: `POST /api/auth/signup { name, gender, locale }`.

- [ ] **Step 6: Run the tests to verify they pass**

Run each: `RUN smoke-account-create`, `RUN smoke-signup`, `RUN smoke-signup-email`, `RUN smoke-invite-web`, `RUN smoke-ban-web`, `RUN smoke-address-me-as`, `RUN smoke-account-merge`, `RUN smoke-telegram-connect`, `RUN smoke-bug-batch-words`, `RUN smoke-native-reminder-typed`, `RUN smoke-album-pdf`, `RUN smoke-week-commands`, `RUN smoke-weather-command` — Expected: all passed.
Run: `npx tsc --noEmit -p .` — Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/gender.ts app/api/settings/route.ts src/services/user-service.ts src/services/web-signin/signup.ts app/api/auth/signup/route.ts src/services/telegram/commands.ts src/services/webhook-handlers.ts scripts/smoke-account-create.ts scripts/smoke-signup.ts scripts/smoke-invite-web.ts scripts/smoke-ban-web.ts scripts/smoke-album-pdf.ts scripts/smoke-week-commands.ts scripts/smoke-weather-command.ts scripts/smoke-native-reminder-typed.ts
git commit -m "$(cat <<'EOF'
feat(signup): Address me as is required at web sign-up; getOrCreateUser says when it made the account

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 4: B2 the sign-up form's "Address me as" (UI)

Implementer invokes the frontend-design skill first, and stays inside the site kit (`src/site/site-css.ts` tokens and the sign-in page's classes).

**Files:**
- Modify: `app/[locale]/(site)/signup/SignUpClient.tsx`
- Modify: `src/site/site-css.ts` (three rules after `.site-signup-wait`)
- Modify: `messages/{en,he,ru}.json` (`site.signup.addressLabel`, `addressMale`, `addressFemale`, `addressHint`, `addressMissing`)
- Modify (tests): `scripts/smoke-signin-page.ts` (S2, S3, the CSS check near line 489)

**Interfaces:**
- Consumes: `type Gender` (`src/lib/gender.ts`, Task 3); the server's `{ ok: false, status: 'gender' }` (Task 3).
- Produces: the POST body `{ name, gender, locale }`; buttons `.site-signup-gender-option` with `aria-pressed`.

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke-signin-page.ts`, add near the other helpers (after `formOf`):

```ts
const genderOptions = (m: Mounted) => byClass(m, 'site-signup-gender-option');
```

In S2, after `m.input(inputOf(m), '  Dana Levi ');` insert:

```ts
        const options = genderOptions(m);
        assert(options.length === 2 && show(options.map((o) => flat(o))) === show([u.addressMale, u.addressFemale]) && options.every((o) => o.getAttribute('type') === 'button' && o.getAttribute('aria-pressed') === 'false'), `${locale}: the choices ${show(options.map((o) => [flat(o), o.getAttribute('aria-pressed')]))}`);
        const legend = elements(m.container).find((e) => e.localName === 'legend');
        assert(legend && flat(legend) === u.addressLabel && flat(m.container).includes(u.addressHint), `${locale}: the label or the hint`);
        assert(submit().hasAttribute('disabled'), `${locale}: Create account is on with a name and no choice`);
        m.click(genderOptions(m)[1]);
        await settle();
        assert(genderOptions(m)[1].getAttribute('aria-pressed') === 'true' && genderOptions(m)[0].getAttribute('aria-pressed') === 'false' && !submit().hasAttribute('disabled'), `${locale}: female not chosen`);
```

and change the posted-body assertion to `show(posted.body) === show({ name: 'Dana Levi', gender: 'female', locale })`. Add to S2's title: `, the "Address me as" pair (two buttons, none chosen, Create account off until one is)`.

In S3's `afterCreate`, after `m.input(inputOf(m), 'Rivka');` add `m.click(genderOptions(m)[0]);` and add to `kept`: `[() => json({ ok: false, status: 'gender' }, 400), u.addressMissing],`.

In the CSS check near line 489, add `'.site-signup-gender', '.site-signup-genders', '.site-signup-gender-option'` to the selector list, and:

```ts
    assert(/\.site-signup-gender-option \{[^}]*min-block-size: 48px;[^}]*font-size: 16px;/.test(SITE_CSS), 'a choice is smaller than a finger, or zooms on iOS');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `RUN smoke-signin-page` — Expected: FAIL S2 (`the choices []`), S3, the CSS check.

- [ ] **Step 3: The strings**

In `messages/en.json`, the `signup` block inside `site` (the one with `"taken"`), after its last key `"taken": …` (add a comma there):

```json
      "addressLabel": "Address me as",
      "addressMale": "Male",
      "addressFemale": "Female",
      "addressHint": "Used for the grammar of your summaries and the voice show. You can change it in Settings.",
      "addressMissing": "Choose how FamCal should address you."
```

`messages/he.json`, same place:

```json
      "addressLabel": "לשון פנייה",
      "addressMale": "לשון זכר",
      "addressFemale": "לשון נקבה",
      "addressHint": "כך ייכתבו הסיכומים והתוכנית הקולית. אפשר לשנות בהגדרות.",
      "addressMissing": "בחרו באיזו לשון לפנות אליכם."
```

`messages/ru.json`, same place:

```json
      "addressLabel": "Как к вам обращаться",
      "addressMale": "В мужском роде",
      "addressFemale": "В женском роде",
      "addressHint": "От этого зависит грамматика сводок и радиошоу. Изменить можно в «Настройках».",
      "addressMissing": "Выберите, как к вам обращаться."
```

- [ ] **Step 4: The form**

In `SignUpClient.tsx`:
- import `import type { Gender } from '@/src/lib/gender';`;
- `type Problem = 'nameLong' | 'nameInvalid' | 'addressMissing' | 'limit' | 'requestFailed';`
- state and ids next to the others: `const [gender, setGender] = useState<Gender | null>(null);` and `const genderHintId = useId();`
- in `create`, after the `nameLong` line: `if (gender === null) return void setProblem('addressMissing');`
- the body: `body: JSON.stringify({ name: typed, gender, locale }),`
- after `if (status === 'name') return void setProblem('nameInvalid');`: `if (status === 'gender') return void setProblem('addressMissing');`
- in the form, between the name note `<p id={noteId} …>` and the problem paragraph:

```tsx
          <fieldset className="site-signup-gender" disabled={busy} aria-describedby={genderHintId}>
            <legend className="site-field-label">{t('addressLabel')}</legend>
            <div className="site-signup-genders">
              {(['male', 'female'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="site-signup-gender-option"
                  aria-pressed={gender === value}
                  onClick={() => {
                    setGender(value);
                    if (problem === 'addressMissing') setProblem(null);
                  }}
                >
                  {value === 'male' ? t('addressMale') : t('addressFemale')}
                </button>
              ))}
            </div>
            <p id={genderHintId} className="site-signin-note">
              {t('addressHint')}
            </p>
          </fieldset>
```

- Create account: `disabled={busy || name.trim() === '' || gender === null}`.
- The header comment: after the name field's description add `"Address me as" (two buttons, male or female, none chosen: Create account waits for one; spec 2026-11-07-b-features §B2),` and change `Create account posts { name, locale }` to `Create account posts { name, gender, locale }`.

In `src/site/site-css.ts`, after the `.site-signup-wait { … }` rule:

```css
.site-signup-gender {
  margin: 0;
  margin-block-start: 18px;
  padding: 0;
  border: 0;
  min-inline-size: 0;
}
.site-signup-genders {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.site-signup-gender-option {
  min-block-size: 48px;
  padding-inline: 12px;
  border: 1px solid var(--ch-hint);
  border-radius: 12px;
  background: var(--ch-bg);
  color: var(--ch-text);
  font-family: inherit;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
}
.site-signup-gender-option[aria-pressed='true'] {
  border-color: var(--ch-button);
  background: var(--ch-button);
  color: var(--ch-button-text);
}
.site-signup-gender-option:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
.site-signup-gender:disabled .site-signup-gender-option {
  opacity: 0.6;
  cursor: default;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `RUN smoke-signin-page`, `RUN smoke-site-truth` (T6 over `site.signup`), `RUN smoke-signup` — Expected: all passed.
Run: `npx tsc --noEmit -p .` and `npx eslint "app/[locale]/(site)/signup/SignUpClient.tsx" src/site/site-css.ts` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add "app/[locale]/(site)/signup/SignUpClient.tsx" src/site/site-css.ts messages/en.json messages/he.json messages/ru.json scripts/smoke-signin-page.ts
git commit -m "$(cat <<'EOF'
feat(signup): the sign-up form asks Address me as (male or female, required)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 5: B2 the question in Telegram and WhatsApp

**Files:**
- Create: `src/services/address-choice.ts`
- Modify: `src/services/telegram/commands.ts` (`handleStartCommand`)
- Modify: `src/services/webhook-handlers.ts` (the `accept <token>` branch, the callback chain, the WhatsApp routing)
- Modify: `src/services/whatsapp-onboarding.ts` (after the CTA)
- Modify: `messages/{en,he,ru}.json` (`bot.onboarding.address*`)
- Modify: `scripts/smoke-pause.ts` (NOT_PAUSED gains address-choice.ts)
- Create: `scripts/smoke-address-choice.ts`
- Modify: `README.md` (Web sign-up section: one line)

**Interfaces:**
- Consumes: `getOrCreateUser(...): Promise<{ user, created }>` and `isGender`/`Gender` (Task 3); `updateUserById`, `getUserByTelegramId` (`src/services/user-service.ts`).
- Produces (address-choice.ts): `genderOfCallback(data: string): Gender | null`, `genderOfWhatsAppButton(text: string): Gender | null`, `saveAddressChoice(userId: number, gender: Gender, via: 'telegram' | 'whatsapp'): Promise<void>`, `sendAddressQuestion(chatId: number | string, userId: number, locale: string): Promise<void>`, `handleAddressPress(chatId: number, messageId: number | undefined, queryId: string, telegramId: number, data: string): Promise<void>`, `sendAddressQuestionWhatsApp(to: string, userId: number, locale: string): Promise<void>`, `answerAddressWhatsApp(to: string, userId: number, gender: Gender, locale: string): Promise<void>`. Callback data `gd:m` / `gd:f`; WhatsApp button ids `gender_m` / `gender_f`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-address-choice.ts`:

```ts
// Smoke test for "Address me as" asked once in the chats (spec docs/superpowers/specs/2026-11-07-b-features-design.md §B2;
// plan docs/superpowers/plans/2026-11-07-b-features.md Task 5): src/services/address-choice.ts and its callers.
//  - C1 a new account's /start gets the welcome, then the question with two buttons (gd:m, gd:f) in its language; a
//    returning /start gets the welcome only; /start connect never asks; the feedback deep link of a new account asks after it
//  - C2 gd:f saves female for the presser's own account, answers the spinner and turns the question into the one-line
//    confirmation in the account's language; pressing again, or the other button, saves again
//  - C3 a stray value (gd:x, gd:) saves nothing and is answered and logged
//  - C4 the webhook sends gd: to the handler, and the WhatsApp routing reads the two button ids
//  - C5 a press from a Telegram id with no account makes no account and saves nothing (answered, logged)
//  - C6 WhatsApp: the language step ends with the question (gender_m, gender_f) after the set-up link; a tap saves and
//    is confirmed; other text is not a choice
//  - C7 the [gender] lines name the user id and the platform only (no name, no Telegram id, no phone)
// Real: address-choice, commands, welcome, whatsapp-onboarding, user-service, createAccount. Faked at the boundaries
// (scripts/lib/signin-world.ts): Prisma and Redis in memory, Telegram and WhatsApp (recorded), error capture, analytics,
// the magic link. No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh: $RUN smoke-address-choice

import fs from 'fs';
import path from 'path';
import {
  assert, baseUser, callbackAnswers, check, DB, everyLog, installSigninWorld, load, logs, redisStore, report, resetWorld, ROOT, sent, show, stubModule, type Row,
} from './lib/signin-world';

const MSG: Record<string, Row> = Object.fromEntries(['en', 'he', 'ru'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))]));
const words = (lang: string): Row => MSG[lang].bot.onboarding;
const NEW_TG = 880000001;
const OLD_TG = 880000002;
const OLD = 12;
const WA_USER = 13;
const WA_PHONE = '+972500000013';
const buttonsOf = (message: Row | undefined): Row[] => message?.options?.replyMarkup?.inline_keyboard?.[0] ?? [];
const edits: Row[] = [];

function seed(): void {
  resetWorld();
  DB.user = [
    baseUser({ id: OLD, name: 'Dana Levi', language: 'ru', telegramId: BigInt(OLD_TG), location: 'Haifa' }),
    baseUser({ id: WA_USER, name: 'Avi', language: 'en', messagingPlatform: 'whatsapp', whatsappPhone: WA_PHONE }),
  ];
  DB.nativeCalendar = [];
  edits.length = 0;
}
const userRow = (id: number): Row | undefined => DB.user.find((u) => u.id === id);

async function main() {
  await installSigninWorld();
  stubModule('src/services/analytics-service.ts', {
    addBreadcrumb: () => undefined, setUserContext: () => undefined, trackActivityAsync: () => undefined, trackActivity: async () => undefined,
    ACTIVITY_RETENTION_DAYS: 90, ACTIVITY_PURGE_BATCH: 5000, purgeOldActivity: async () => 0,
  });
  stubModule('src/services/magic-link.ts', { generateMagicLink: async () => 'https://famcal.bot/m/smoke-link' });
  const bot = (await load('src/services/telegram/bot.ts')).getBot() as Row;
  bot.editMessageText = async (text: string, o: Row) => { edits.push({ text, ...o }); return true; };
  const { handleStartCommand } = await load('src/services/telegram/commands.ts');
  const choice = await load('src/services/address-choice.ts');
  const onboarding = await load('src/services/whatsapp-onboarding.ts');
  const { REDIS_KEYS } = await load('src/config/redis-keys.ts');
  const start = (tg: number, args?: string, languageCode = 'he') =>
    handleStartCommand(tg, tg, 'telegram', { id: tg, first_name: 'Noa', language_code: languageCode }, args, 'private');

  await check('C1 a new account\'s /start: the welcome, then the question with two buttons (gd:m, gd:f) in its language; a returning /start: the welcome only; /start connect of a new account never asks; the feedback deep link of a new account asks after its reply', async () => {
    seed();
    await start(NEW_TG);
    const made = DB.user.find((u) => String(u.telegramId) === String(NEW_TG));
    assert(made, 'no account was made');
    const mine = sent.filter((m) => m.platform === 'telegram' && m.chatId === String(NEW_TG));
    assert(mine.length === 2, `messages ${show(mine.map((m) => m.text.slice(0, 40)))}`);
    const question = mine[1];
    assert(question.text === words('he').addressQuestion, `the question ${show(question.text)}`);
    assert(show(buttonsOf(question).map((b) => [b.text, b.callback_data])) === show([[words('he').addressMale, 'gd:m'], [words('he').addressFemale, 'gd:f']]), `buttons ${show(buttonsOf(question))}`);
    sent.length = 0;
    await start(NEW_TG);
    assert(sent.length === 1 && buttonsOf(sent[0]).every((b) => !String(b.callback_data ?? '').startsWith('gd:')), `a returning /start: ${show(sent.map((m) => m.text.slice(0, 40)))}`);
    sent.length = 0;
    await start(NEW_TG + 1, 'connect', 'en');
    assert(sent.every((m) => buttonsOf(m).every((b) => !String(b.callback_data ?? '').startsWith('gd:'))), `/start connect asked: ${show(sent.map((m) => m.text.slice(0, 40)))}`);
    sent.length = 0;
    await start(NEW_TG + 2, 'feedback', 'ru');
    const feedback = sent.filter((m) => m.chatId === String(NEW_TG + 2));
    assert(feedback.length === 2 && feedback[1].text === words('ru').addressQuestion, `feedback: ${show(feedback.map((m) => m.text.slice(0, 40)))}`);
  });

  await check('C2 gd:f saves female for the presser\'s own account, answers the spinner and edits the question into the confirmation in the account\'s language; the other button, or the same again, saves again', async () => {
    seed();
    await choice.handleAddressPress(OLD_TG, 501, 'q-1', OLD_TG, 'gd:f');
    assert(userRow(OLD)?.gender === 'female', `gender ${userRow(OLD)?.gender}`);
    assert(callbackAnswers.includes('q-1'), `answers ${show(callbackAnswers)}`);
    assert(show(edits) === show([{ text: words('ru').addressSavedFemale, chat_id: OLD_TG, message_id: 501 }]), `edits ${show(edits)}`);
    await choice.handleAddressPress(OLD_TG, 501, 'q-2', OLD_TG, 'gd:m');
    await choice.handleAddressPress(OLD_TG, 501, 'q-3', OLD_TG, 'gd:m');
    assert(userRow(OLD)?.gender === 'male' && edits.at(-1)?.text === words('ru').addressSavedMale && callbackAnswers.includes('q-3'), `again: ${userRow(OLD)?.gender} ${show(edits.at(-1))}`);
  });

  await check('C3 a stray value (gd:x, gd:, gd:female) saves nothing, is answered and logged', async () => {
    seed();
    for (const [i, data] of ['gd:x', 'gd:', 'gd:female'].entries()) await choice.handleAddressPress(OLD_TG, 502, `s-${i}`, OLD_TG, data);
    assert(userRow(OLD)?.gender === 'male' && edits.length === 0, `saved ${userRow(OLD)?.gender} ${show(edits)}`);
    assert(['s-0', 's-1', 's-2'].every((q) => callbackAnswers.includes(q)), `answers ${show(callbackAnswers)}`);
    assert(logs.filter((l) => l.startsWith('[gender] refused a button')).length === 3, `logs ${show(logs.filter((l) => l.startsWith('[gender]')))}`);
  });

  await check('C4 the webhook sends a gd: press to handleAddressPress, a new account\'s "accept <token>" asks after its reply, and the WhatsApp routing reads the two button ids before the accept handler', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/services/webhook-handlers.ts'), 'utf8');
    assert(/data\.startsWith\('gd:'\)[\s\S]{0,400}handleAddressPress\(/.test(source), 'no gd: branch');
    const wa = source.indexOf('genderOfWhatsAppButton(text)');
    assert(wa > 0 && wa < source.indexOf('const acceptToken = parseAcceptCommand(text)'), 'the WhatsApp buttons are not read before the accept handler');
    assert(/const \{ user, created \} = await getOrCreateUser\(textUserId/.test(source) && /if \(created\)[\s\S]{0,200}sendAddressQuestion\(/.test(source), 'accept <token> does not ask a new account');
    assert(choice.genderOfCallback('gd:m') === 'male' && choice.genderOfCallback('gd:f') === 'female' && choice.genderOfCallback('gd:x') === null, 'genderOfCallback');
  });

  await check('C5 a press from a Telegram id with no account makes no account and saves nothing: answered and logged', async () => {
    seed();
    const before = DB.user.length;
    await choice.handleAddressPress(990000009, 503, 'n-1', 990000009, 'gd:f');
    assert(DB.user.length === before && edits.length === 0 && callbackAnswers.includes('n-1'), `users ${DB.user.length}, edits ${show(edits)}`);
    assert(logs.some((l) => l === '[gender] a button from a Telegram id with no account was refused'), `logs ${show(logs.filter((l) => l.startsWith('[gender]')))}`);
  });

  await check('C6 WhatsApp: the language step ends with the question (gender_m, gender_f) after the set-up link, in the chosen language; a tap saves and is confirmed; other text is not a choice', async () => {
    seed();
    redisStore.set(REDIS_KEYS.waOnboard(WA_PHONE), JSON.stringify({ step: 'language', userId: WA_USER }));
    assert((await onboarding.handleOnboardingMessage(WA_PHONE, 'lang_he')) === true, 'not handled');
    const mine = sent.filter((m) => m.platform === 'whatsapp' && m.chatId === WA_PHONE);
    const last = mine.at(-1);
    assert(last?.text === words('he').addressQuestion && show(last.options.whatsappButtons) === show([{ id: 'gender_m', title: words('he').addressMale }, { id: 'gender_f', title: words('he').addressFemale }]), `the last message ${show(last)}`);
    assert(mine.at(-2)?.options?.whatsappUrlButton?.url === 'https://famcal.bot/m/smoke-link', 'the question is not after the set-up link');
    assert(choice.genderOfWhatsAppButton('gender_f') === 'female' && choice.genderOfWhatsAppButton(' gender_m ') === 'male' && choice.genderOfWhatsAppButton('gender_x') === null && choice.genderOfWhatsAppButton('hello') === null, 'genderOfWhatsAppButton');
    await choice.answerAddressWhatsApp(WA_PHONE, WA_USER, 'female', 'he');
    assert(userRow(WA_USER)?.gender === 'female' && sent.at(-1)?.text === words('he').addressSavedFemale, `saved ${userRow(WA_USER)?.gender} ${show(sent.at(-1))}`);
    for (const title of [words('en').addressMale, words('he').addressFemale, words('ru').addressFemale]) assert(Array.from(title as string).length <= 20, `a WhatsApp button title over 20 characters: ${title}`);
  });

  await check('C7 the [gender] lines name the user id and the platform only: no name, no Telegram id, no phone', () => {
    const lines = everyLog.filter((l) => l.startsWith('[gender]'));
    assert(lines.some((l) => l === `[gender] user ${OLD} chose via telegram`) && lines.some((l) => l === `[gender] user ${WA_USER} chose via whatsapp`), `lines ${show(lines)}`);
    const leaks = lines.filter((l) => ['Dana', 'Noa', 'Avi', String(OLD_TG), String(NEW_TG), WA_PHONE, '972500000013'].some((s) => l.includes(s)));
    assert(leaks.length === 0, `leaks ${show(leaks)}`);
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

(signin-world keeps every console level in `logs` (this check's lines) and `everyLog` (the run's), so the `console.warn` refusals are there.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `RUN smoke-address-choice` — Expected: FAIL at load (`src/services/address-choice.ts` not found).

- [ ] **Step 3: The strings**

`messages/en.json`, `bot.onboarding`, after `"nativeLocationButton": "📍 Set my location"` (add a comma there):

```json
      "addressQuestion": "How should FamCal address you? It sets the grammar of your summaries and the voice show. You can change it in Settings.",
      "addressMale": "Male",
      "addressFemale": "Female",
      "addressSavedMale": "Saved: FamCal will use male forms for you. You can change it in Settings.",
      "addressSavedFemale": "Saved: FamCal will use female forms for you. You can change it in Settings."
```

`messages/he.json`, same place:

```json
      "addressQuestion": "באיזו לשון לפנות אליכם? כך ייכתבו הסיכומים והתוכנית הקולית. אפשר לשנות בהגדרות.",
      "addressMale": "לשון זכר",
      "addressFemale": "לשון נקבה",
      "addressSavedMale": "נשמר: נפנה אליכם בלשון זכר. אפשר לשנות בהגדרות.",
      "addressSavedFemale": "נשמר: נפנה אליכם בלשון נקבה. אפשר לשנות בהגדרות."
```

`messages/ru.json`, same place:

```json
      "addressQuestion": "Как к вам обращаться? От этого зависит грамматика сводок и радиошоу. Изменить можно в «Настройках».",
      "addressMale": "В мужском роде",
      "addressFemale": "В женском роде",
      "addressSavedMale": "Сохранено: к вам будут обращаться в мужском роде. Изменить можно в «Настройках».",
      "addressSavedFemale": "Сохранено: к вам будут обращаться в женском роде. Изменить можно в «Настройках»."
```

- [ ] **Step 4: The module**

Create `src/services/address-choice.ts`:

```ts
/**
 * "Address me as", asked once when an account is made in a chat (spec docs/superpowers/specs/2026-11-07-b-features-design.md
 * §B2). The web's sign-up asks it on its form (src/services/web-signin/signup.ts); a chat account starts as male and gets
 * this question after its first reply:
 *   - Telegram: after the first reply to /start (the welcome, a deep link's reply, a partner's invite) or to a first
 *     "accept <token>", for an account that call made (getOrCreateUser's `created`); never on /start connect, whose new
 *     account merges into a WhatsApp one that was asked. Two buttons, gd:m and gd:f; a press saves the choice for the
 *     presser's own account (by the press's Telegram id) and turns the question into a one-line confirmation.
 *   - WhatsApp: the last message of the language step (whatsapp-onboarding.ts), two reply buttons gender_m and gender_f,
 *     read by the webhook whenever they come (the onboarding state is gone by then). Anything else goes on as normal.
 * Not answering leaves male; Settings' row changes it any time. Every choice is checked by isGender's closed set.
 * A reply to the person's own action, never a scheduled send: scripts/smoke-pause.ts lists this file as not paused.
 * One log line per saved choice, `[gender] user <id> chose via <telegram|whatsapp>`: never a name, a Telegram id or a phone.
 */

import type { Gender } from '../lib/gender';
import { getBotMessages } from '../lib/bot-messages';
import { captureError } from '../lib/error-capture';
import { getUserByTelegramId, updateUserById } from './user-service';

const CALLBACK: Record<Gender, string> = { male: 'gd:m', female: 'gd:f' };
const WA_BUTTON: Record<Gender, string> = { male: 'gender_m', female: 'gender_f' };

const why = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** The choice a Telegram button carries, or null for anything but gd:m and gd:f. */
export function genderOfCallback(data: string): Gender | null {
  if (data === CALLBACK.male) return 'male';
  if (data === CALLBACK.female) return 'female';
  return null;
}

/** The choice a WhatsApp reply button carries (its id arrives as the message text), or null for anything else. */
export function genderOfWhatsAppButton(text: string): Gender | null {
  const id = text.trim();
  if (id === WA_BUTTON.male) return 'male';
  if (id === WA_BUTTON.female) return 'female';
  return null;
}

/** Saves the choice through the user update and logs it (the user id and the platform only). */
export async function saveAddressChoice(userId: number, gender: Gender, via: 'telegram' | 'whatsapp'): Promise<void> {
  await updateUserById(userId, { gender });
  console.log(`[gender] user ${userId} chose via ${via}`);
}

/** The Telegram question with its two buttons. Never throws: the welcome went already, and a failure is logged and reported. */
export async function sendAddressQuestion(chatId: number | string, userId: number, locale: string): Promise<void> {
  try {
    const t = (await getBotMessages(locale)).onboarding;
    const { getMessagingService } = await import('./telegram/bot');
    await getMessagingService().sendMessage(chatId, t.addressQuestion, {
      replyMarkup: { inline_keyboard: [[{ text: t.addressMale, callback_data: CALLBACK.male }, { text: t.addressFemale, callback_data: CALLBACK.female }]] },
    });
  } catch (error) {
    console.error(`[gender] user ${userId}: the Telegram question could not be sent (${why(error)})`);
    captureError(error, 'address-choice', { user_id: userId, platform: 'telegram', step: 'ask' }, 'warning');
  }
}

/** A press of gd:m or gd:f: the spinner is answered first, then the presser's own account saves it and the question becomes the confirmation. */
export async function handleAddressPress(chatId: number, messageId: number | undefined, queryId: string, telegramId: number, data: string): Promise<void> {
  const { getBot } = await import('./telegram/bot');
  const bot = getBot();
  await bot.answerCallbackQuery(queryId).catch((error: unknown) => console.error(`[gender] could not answer an address button (${why(error)})`));
  const gender = genderOfCallback(data);
  if (!gender) {
    console.warn('[gender] refused a button that is not gd:m or gd:f');
    return;
  }
  let userId: number | undefined;
  try {
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      console.warn('[gender] a button from a Telegram id with no account was refused');
      return;
    }
    userId = user.id;
    await saveAddressChoice(user.id, gender, 'telegram');
    const t = (await getBotMessages(user.language || 'en')).onboarding;
    if (messageId !== undefined) await bot.editMessageText(gender === 'female' ? t.addressSavedFemale : t.addressSavedMale, { chat_id: chatId, message_id: messageId });
  } catch (error) {
    console.error(`[gender] user ${userId ?? 'unknown'}: saving the Telegram choice failed (${why(error)})`);
    captureError(error, 'address-choice', { user_id: userId, platform: 'telegram', step: 'save' });
  }
}

/** The WhatsApp question with its two reply buttons, the last message of onboarding. Never throws (logged and reported). */
export async function sendAddressQuestionWhatsApp(to: string, userId: number, locale: string): Promise<void> {
  try {
    const t = (await getBotMessages(locale)).onboarding;
    const { getWhatsAppService } = await import('./messaging');
    await getWhatsAppService().sendMessage(to, t.addressQuestion, {
      whatsappButtons: [{ id: WA_BUTTON.male, title: t.addressMale }, { id: WA_BUTTON.female, title: t.addressFemale }],
    });
  } catch (error) {
    console.error(`[gender] user ${userId}: the WhatsApp question could not be sent (${why(error)})`);
    captureError(error, 'address-choice', { user_id: userId, platform: 'whatsapp', step: 'ask' }, 'warning');
  }
}

/** A tap of gender_m or gender_f on WhatsApp: saved, then confirmed in one line. Never throws (logged and reported). */
export async function answerAddressWhatsApp(to: string, userId: number, gender: Gender, locale: string): Promise<void> {
  try {
    await saveAddressChoice(userId, gender, 'whatsapp');
    const t = (await getBotMessages(locale)).onboarding;
    const { getWhatsAppService } = await import('./messaging');
    await getWhatsAppService().sendMessage(to, gender === 'female' ? t.addressSavedFemale : t.addressSavedMale);
  } catch (error) {
    console.error(`[gender] user ${userId}: saving the WhatsApp choice failed (${why(error)})`);
    captureError(error, 'address-choice', { user_id: userId, platform: 'whatsapp', step: 'save' });
  }
}
```

- [ ] **Step 5: The callers**

`src/services/telegram/commands.ts`, `handleStartCommand`: replace `const { user } = await getOrCreateUser(userIdNum, telegramUser);` (Task 3's line) with:

```ts
  const { user, created } = await getOrCreateUser(userIdNum, telegramUser);
```

after `const links = policyLinks(t.policy, locale, 'html');` add:

```ts
  // "Address me as" (address-choice.ts): an account this /start made is asked once, after its first reply. Never on
  // /start connect, whose new account merges into a WhatsApp account that was asked already.
  const askAddress = async () => {
    if (!created || platform !== MessagingPlatform.TELEGRAM) return;
    const { sendAddressQuestion } = await import('../address-choice');
    await sendAddressQuestion(chatId, user.id, locale);
  };
```

then call `await askAddress();` right before `return;` in the feedback branch (after its `sendMessage`), after `await handlePairStart(…);` in the invite branch (before its `return;`), and after the final `await sendWelcome(chatId, user, platform);`. The `connect` branch does not call it.

`src/services/webhook-handlers.ts`:
- the `accept <token>` branch: `const { user, created } = await getOrCreateUser(textUserId, update.message.from);` and after `await handlePairAccept(chatId, user.id, token, locale, MessagingPlatform.TELEGRAM, links);`:

```ts
      if (created) {
        // A first message that made the account: "Address me as" once, after its reply (address-choice.ts)
        const { sendAddressQuestion } = await import('./address-choice');
        await sendAddressQuestion(chatId, user.id, locale);
      }
```

- the callback chain, before the `} else if (data.startsWith('nr:')) {` branch:

```ts
      } else if (data.startsWith('gd:')) {
        // "Address me as" (address-choice.ts): saved for the presser's own account; the handler answers the spinner
        const { handleAddressPress } = await import('./address-choice');
        await handleAddressPress(chatId, callbackQuery.message?.message_id, queryId, callbackUserId, data);
```

- the WhatsApp routing, right before the `// Free-text "accept <token>"` block:

```ts
    // "Address me as" (address-choice.ts): the two buttons that end onboarding, read whenever they are tapped
    {
      const { genderOfWhatsAppButton, answerAddressWhatsApp } = await import('./address-choice');
      const chosen = genderOfWhatsAppButton(text);
      if (chosen) {
        await answerAddressWhatsApp(from, user.id, chosen, locale);
        res.status(200).json({ ok: true });
        return;
      }
    }
```

`src/services/whatsapp-onboarding.ts`: add `import { sendAddressQuestionWhatsApp } from './address-choice';` and after the "Message 2" `sendMessage(…)` call, before `return true;`:

```ts
    // Message 3: "Address me as", the last one (address-choice.ts; the webhook reads the two buttons whenever they come)
    await sendAddressQuestionWhatsApp(phone, state.userId, language);
```

Update the file's header line to `Simple state machine for basic setup (language) via WhatsApp messages, ending with the "Address me as" question.`

`scripts/smoke-pause.ts`, `NOT_PAUSED`, under "Replies to the person's own action":

```ts
  'src/services/address-choice.ts': '"Address me as": the question after a new account\'s first reply (/start, a first "accept", the WhatsApp language step) and the answer to the person\'s own button',
```

`README.md`, the "Web sign-up" section, one bullet:

```markdown
- **Address me as:** the sign-up form asks male or female (required), and an account made in Telegram (/start) or WhatsApp (the first message) is asked once after its first reply, with two buttons (`src/services/address-choice.ts`). Not answering in a chat leaves male; Settings changes it.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `RUN smoke-address-choice`, `RUN smoke-pause`, `RUN smoke-telegram-connect`, `RUN smoke-bug-batch-words`, `RUN smoke-native-reminder-typed`, `RUN smoke-account-create` — Expected: all passed.
Run: `npx tsc --noEmit -p .` and `npx eslint src/services/address-choice.ts src/services/telegram/commands.ts src/services/webhook-handlers.ts src/services/whatsapp-onboarding.ts scripts/smoke-address-choice.ts` — Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/services/address-choice.ts src/services/telegram/commands.ts src/services/webhook-handlers.ts src/services/whatsapp-onboarding.ts messages/en.json messages/he.json messages/ru.json scripts/smoke-pause.ts scripts/smoke-address-choice.ts README.md
git commit -m "$(cat <<'EOF'
feat(bot): a new Telegram or WhatsApp account is asked Address me as once, with two buttons

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 6: B3 server: one delete path with an actor, and `POST /api/account/delete`

**Files:**
- Modify: `src/lib/user-moderation.ts` (`hardDeleteUser`; keep it right before `personalCacheKeys`)
- Modify: `app/api/admin/users/moderation/route.ts:63`
- Create: `app/api/account/delete/route.ts`
- Create: `scripts/smoke-account-delete.ts`
- Modify (tests): `scripts/smoke-recent-sign-in.ts` (CALLS, GUARDED, EXEMPT, the audit's title), `scripts/smoke-bug-batch-safety.ts` (5 calls, the worker fake, one new check), `scripts/smoke-account-merge.ts` (its `hardDeleteUser(W, 1)` calls, one new check)
- Modify: `CLAUDE.md` (the sign-in rule's hour list), `README.md` (a short "Deleting an account" section)

**Interfaces:**
- Produces: `type DeletedBy = { admin: number } | 'self'`; `hardDeleteUser(userId: number, by: DeletedBy): Promise<void>`. The route: `POST /api/account/delete?user_id=<id>` with JSON `{ confirm: true }` (initData in the `X-Telegram-Init-Data` header or the body, or the session cookie). Answers: `200 { ok: true }` + cleared session cookie; `400 { error: 'bad_request' | 'confirm_required' }`; `403 { error: 'cross_site' }` / `{ ok: false, error: 'stale-sign-in'[, whatsapp: true] }` / `{ error: 'admin' }` / suspended (verifyUserAuth); `404` when the account is gone (cookie cleared); `429`; `500 { error: 'failed' }`. Log line `[account-delete] user <id> deleted their account (<telegram|session>)`.
- Consumes: `refuseCrossSite`, `verifyUserAuth`, `requestInitData`, `settingsRateLimiter`, `refuseStaleSignIn`, `clearSessionCookie`, `captureError`, `markDisconnecting` (google-sync/worker.ts).

- [ ] **Step 1: Write the failing tests**

Create `scripts/smoke-account-delete.ts`:

```ts
// Smoke test for Settings' Delete account, the route (spec docs/superpowers/specs/2026-11-07-b-features-design.md §B3; plan
// docs/superpowers/plans/2026-11-07-b-features.md Task 6): POST /api/account/delete.
//  - D1 from another site, or with no Origin: 403 before anything is read; nothing is deleted
//  - D2 a browser session proved over an hour ago: 403 stale-sign-in (a WhatsApp link's says whatsapp: true); nothing deleted
//  - D3 Telegram initData is never asked the hour, and deletes
//  - D4 no confirm, or one that is not exactly true: 400, nothing deleted
//  - D5 a suspended account: 403 (verifyUserAuth) with its cookie cleared, nothing deleted
//  - D6 an admin account: 403 admin, nothing deleted
//  - D7 a fresh session: the account goes (the row, its sign-in way by the cascade, its calendars), the partner is unlinked
//    with no unlinker recorded and their calendars turn private, the session cookie is cleared, one log line names the
//    user id and the way in
//  - D8 pressed again (a second tab): 404, with the cookie cleared
//  - D9 no console line or Sentry report holds an address or a name
// Real: the route, api-auth, recent-sign-in, same-origin, session-auth, user-moderation's hardDeleteUser (the copy worker
// finds no copies). Faked at the boundaries (scripts/lib/signin-world.ts): Prisma and Redis in memory, error capture, the
// chats, fetch. No network, no DB.
//
// Run with the fake env of scripts/ci-smokes.sh: $RUN smoke-account-delete

import {
  assert, baseUser, body, check, DB, everyCapture, everyLog, identityRow, initDataFor, installSigninWorld, load, logs, report, request, resetWorld, sessionCookie, show, type Row,
} from './lib/signin-world';

const ADMIN = 1;
const ADMIN_TG = 111111111;
const DANA = 7;
const DANA_TG = 700000007;
const NOA = 8;
const ZOE = 9;
const HOUR = 3_600_000;
const urlOf = (id: number) => `/api/account/delete?user_id=${id}`;
const cleared = (res: Response) => /__Host-famcal_session=(;|$)/.test(res.headers.get('set-cookie') ?? '');

function seed(): void {
  resetWorld();
  const tenDays = new Date(Date.now() - 10 * 24 * HOUR);
  DB.user = [
    baseUser({ id: ADMIN, name: 'Admin', telegramId: BigInt(ADMIN_TG), isAdmin: true }),
    baseUser({ id: DANA, name: 'Dana Levi', telegramId: BigInt(DANA_TG), pairingId: 'pair-dn' }),
    baseUser({ id: NOA, name: 'Noa Cohen', pairingId: 'pair-dn' }),
    baseUser({ id: ZOE, name: 'Zoe', suspendedAt: new Date(Date.now() - HOUR) }),
  ];
  DB.signInIdentity = [
    identityRow({ userId: DANA, kind: 'email', subject: 'dana@example.com', address: 'dana@example.com' }),
    identityRow({ userId: ZOE, kind: 'email', subject: 'zoe@example.com', address: 'zoe@example.com' }),
  ];
  DB.pairing = [{ id: 'pair-dn', status: 'ACTIVE', inviterUserId: NOA, inviteeUserId: DANA, acceptedAt: tenDays, unlinkedAt: null, unlinkedByUserId: null, createdAt: tenDays }];
  DB.nativeCalendar = [
    { id: 'cal-dana', ownerUserId: DANA, name: 'Dana', privacy: 'SHARED_EDITOR', isDeleted: false },
    { id: 'cal-noa', ownerUserId: NOA, name: 'Noa', privacy: 'SHARED_EDITOR', isDeleted: false },
  ];
  for (const table of ['nativeEvent', 'googleSyncLink', 'userActivity', 'userFeedback', 'usageCounter', 'payment', 'subscription', 'userFeatureOverride', 'oAuthState', 'pushDevice', 'pairingInvite']) DB[table] = [];
}
const there = (id: number) => DB.user.some((u) => u.id === id);

async function main() {
  await installSigninWorld();
  const route = await load('app/api/account/delete/route.ts');
  const post = (id: number, o: { body?: unknown; cookie?: string; initData?: string; origin?: string | null } = {}) =>
    route.POST(request(urlOf(id), { body: o.body ?? { confirm: true }, cookie: o.cookie, initData: o.initData, origin: o.origin }));

  await check('D1 from another site, or with no Origin: 403 before anything is read; nothing is deleted', async () => {
    seed();
    const cookie = await sessionCookie(DANA, 'email');
    for (const origin of ['https://evil.example', null]) {
      const res = await post(DANA, { cookie, origin });
      assert(res.status === 403 && (await body(res)).error === 'cross_site', `${origin}: ${res.status} ${show(await body(res))}`);
    }
    assert(there(DANA), 'the account went');
  });

  await check('D2 a browser session proved over an hour ago: 403 stale-sign-in, a WhatsApp link\'s with whatsapp: true; nothing deleted', async () => {
    seed();
    const email = await post(DANA, { cookie: await sessionCookie(DANA, 'email', Date.now() - 2 * HOUR) });
    assert(email.status === 403 && show(await body(email)) === show({ ok: false, error: 'stale-sign-in' }), `email: ${email.status} ${show(await body(email))}`);
    const wa = await post(DANA, { cookie: await sessionCookie(DANA, 'wa', Date.now() - 2 * HOUR) });
    assert(wa.status === 403 && show(await body(wa)) === show({ ok: false, error: 'stale-sign-in', whatsapp: true }), `wa: ${wa.status} ${show(await body(wa))}`);
    assert(there(DANA), 'the account went');
  });

  await check('D3 Telegram initData is never asked the hour, and deletes', async () => {
    seed();
    const res = await post(DANA_TG, { initData: initDataFor(DANA_TG) });
    assert(res.status === 200 && (await body(res)).ok === true && !there(DANA), `${res.status} ${show(await body(res))}`);
    assert(logs.includes(`[account-delete] user ${DANA} deleted their account (telegram)`), `logs ${show(logs.filter((l) => l.startsWith('[account-delete]')))}`);
  });

  await check('D4 no confirm, or one that is not exactly true: 400, nothing deleted', async () => {
    seed();
    const cookie = await sessionCookie(DANA, 'email');
    for (const b of [{}, { confirm: 'true' }, { confirm: 1 }, { confirm: false }, { confirm: null }]) {
      const res = await post(DANA, { cookie, body: b });
      assert(res.status === 400 && (await body(res)).error === 'confirm_required', `${show(b)}: ${res.status} ${show(await body(res))}`);
    }
    assert(there(DANA), 'the account went');
  });

  await check('D5 a suspended account: 403, its cookie cleared, nothing deleted', async () => {
    seed();
    const res = await post(ZOE, { cookie: await sessionCookie(ZOE, 'email') });
    assert(res.status === 403 && cleared(res) && there(ZOE), `${res.status} cleared ${cleared(res)}`);
  });

  await check('D6 an admin account: 403 admin, nothing deleted', async () => {
    seed();
    const res = await post(ADMIN_TG, { initData: initDataFor(ADMIN_TG) });
    assert(res.status === 403 && (await body(res)).error === 'admin' && there(ADMIN), `${res.status} ${show(await body(res))}`);
  });

  await check('D7 a fresh session: the account goes (the row, its sign-in way, its calendar), the partner is unlinked with no unlinker and their calendar turns private, the cookie is cleared, one log line', async () => {
    seed();
    const res = await post(DANA, { cookie: await sessionCookie(DANA, 'email') });
    assert(res.status === 200 && show(await body(res)) === show({ ok: true }) && cleared(res), `${res.status} ${show(await body(res))} cleared ${cleared(res)}`);
    assert(!there(DANA) && !DB.signInIdentity.some((i) => i.userId === DANA) && !DB.nativeCalendar.some((c) => c.ownerUserId === DANA), 'something of the account stayed');
    const pairing = DB.pairing.find((p) => p.id === 'pair-dn') as Row | undefined;
    const noa = DB.user.find((u) => u.id === NOA) as Row;
    assert(pairing?.status === 'UNLINKED' && pairing.unlinkedByUserId === null && noa.pairingId === null, `pairing ${show(pairing)}, Noa ${noa.pairingId}`);
    assert(DB.nativeCalendar.find((c) => c.id === 'cal-noa')?.privacy === 'PRIVATE', 'the partner\'s calendar is still shared');
    assert(logs.filter((l) => l.startsWith('[account-delete]')).join('|') === `[account-delete] user ${DANA} deleted their account (session)`, `logs ${show(logs.filter((l) => l.startsWith('[account-delete]')))}`);
  });

  await check('D8 pressed again (a second tab): 404, with the cookie cleared', async () => {
    seed();
    const cookie = await sessionCookie(DANA, 'email');
    assert((await post(DANA, { cookie })).status === 200, 'the first press');
    const again = await post(DANA, { cookie });
    assert(again.status === 404 && cleared(again), `${again.status} cleared ${cleared(again)}`);
  });

  await check('D9 no console line or Sentry report holds an address or a name', () => {
    const secrets = ['dana@example.com', 'zoe@example.com', 'Dana Levi', 'Noa Cohen'];
    const leaks = [...everyLog, ...everyCapture.map((c) => `${c.context} ${c.message} ${show(c.extra)}`)].filter((l) => secrets.some((s) => l.includes(s)));
    assert(leaks.length === 0, `leaks ${show(leaks)}`);
  });

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

`scripts/smoke-recent-sign-in.ts`:
- `CALLS`: add `hardDeleteUser` to the alternation: `/\b(?:createAddGoogleLink|takeAddGoogleToken|issueCode|addIdentity|addDevice|createGoogleConsent|claimPendingGoogleToken|turnOnCalendarAccount|runJoin|mergeAccounts|offerJoin|commitGoogleToken|createPendingGoogleToken|writeIdentityInTx|hardDeleteUser)\(/`
- `GUARDED`: `'app/api/account/delete/route.ts': 'Delete account: an account is deleted from a browser only for a sign-in from the last hour (refuseStaleSignIn; Mini App initData passes; spec 2026-11-07-b-features §B3)',`
- `EXEMPT`: `'src/lib/user-moderation.ts': 'defines hardDeleteUser (every caller is listed: the admin route and Delete account)',` and `'app/api/admin/users/moderation/route.ts': 'the admin\'s Delete, proved by the admin\'s Telegram initData only (verifyAdminAccess), never a browser cookie',`
- the audit check's title: `'the audit: every file under src/ and app/ that adds a sign-in way, connects Google or deletes an account from a browser is in GUARDED …'` (the rest unchanged), and the matching header comment line.

`scripts/smoke-bug-batch-safety.ts`:
- every `hardDeleteUser(GOOGLE_USER, 1)` → `hardDeleteUser(GOOGLE_USER, { admin: 1 })`;
- next to `carried` declare `const deleteSteps: string[] = [];` and `let markFails = false;`, and the worker fake becomes (the existing `carried` stays as it is; `deleteSteps` records the order):

```ts
  [`${SRC}/services/google-sync/worker.ts`]: (real: Record<string, unknown>) => fakeOver(real, {
    markDisconnecting: async (userId: number) => {
      if (markFails) throw new Error('Redis refused the marker (smoke)');
      deleteSteps.push(`mark ${userId}`);
    },
    carryOutCopiesBeforeDelete: async (userId: number) => { carried.push(userId); deleteSteps.push(`carry ${userId}`); },
  }),
```

and after the last `'2: …'` hard delete check:

```ts
  await check('2: the hard delete marks the Google disconnect before it carries out the copies (a copy run under way stops), and a marker Redis refuses is logged and reported while the delete goes on', async () => {
    addGoogleUser('');
    deleteSteps.length = 0;
    markFails = false;
    const { hardDeleteUser } = await import('../src/lib/user-moderation');
    await withLogs(() => hardDeleteUser(GOOGLE_USER, 'self'));
    assertSame(deleteSteps, [`mark ${GOOGLE_USER}`, `carry ${GOOGLE_USER}`], 'the order');
    assert(!DB.user.some(u => u.id === GOOGLE_USER), 'the person was not deleted');
    addGoogleUser('');
    markFails = true;
    try {
      await withLogs(() => hardDeleteUser(GOOGLE_USER, 'self'));
    } finally {
      markFails = false;
    }
    assert(!DB.user.some(u => u.id === GOOGLE_USER), 'a refused marker stopped the delete');
    assert(captured.some(c => c.startsWith('google-sync-hard-delete-marker')), `not captured: ${show(captured)}`);
    assert(logs.some(l => l.includes('marking the Google disconnect failed') && l.includes(`user ${GOOGLE_USER}`)), `not logged: ${show(logs)}`);
  });
```

`scripts/smoke-account-merge.ts`: every `hardDeleteUser(W, 1)` → `hardDeleteUser(W, { admin: 1 })`, and after #13:

```ts
  await check('#13b hardDeleteUser by the person (\'self\'): the pairing the deleted person was invited into is unlinked with no unlinker recorded, the partner keeps their calendar (now private); by an admin the admin is recorded', async () => {
    for (const [by, want] of [['self', null], [{ admin: 1 }, 1]] as const) {
      seed();
      DB.pairing.push(pairing('pair-pw', P, W));
      userRow(W).pairingId = 'pair-pw';
      userRow(P).pairingId = 'pair-pw';
      const { hardDeleteUser } = await load('src/lib/user-moderation.ts');
      await hardDeleteUser(W, by);
      const pr = rowOf('pairing', 'pair-pw');
      assert(!userRow(W) && pr?.status === 'UNLINKED' && pr.unlinkedByUserId === want && userRow(P).pairingId === null, `${show(by)}: pairing ${show(pr)}`);
      assert(rowOf('nativeCalendar', 'cal-p')?.ownerUserId === P, `${show(by)}: P's calendar is gone`);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `RUN smoke-account-delete` — Expected: FAIL at load (the route does not exist).
Run: `RUN smoke-bug-batch-safety` — Expected: FAIL the new marker check (`the marker []`).
Run: `RUN smoke-account-merge` — Expected: FAIL #13b (`self: pairing … unlinkedByUserId: "self"` or similar).
Run: `RUN smoke-recent-sign-in` — Expected: FAIL the audit (`listed, but it no longer calls any of them: app/api/account/delete/route.ts`).

- [ ] **Step 3: The delete path**

In `src/lib/user-moderation.ts`, extend the doc comment of `hardDeleteUser` with: `\`by\`: an admin (the admin panel's Delete) or the person ('self', Settings' Delete account, app/api/account/delete). One code path for both; only the unlinker recorded on the pairing and the log line differ. First of all it marks the Google disconnect (markDisconnecting), so a copy-to-Google run already under way stops writing and messaging and makes no copy calendar after the Remove pass; best effort like the Google steps.` Then:

```ts
/** Who deletes the account: an admin from the admin panel, or the person from Settings (app/api/account/delete). */
export type DeletedBy = { admin: number } | 'self';

export async function hardDeleteUser(userId: number, by: DeletedBy): Promise<void> {
  // First: a copy-to-Google run under way stops writing and messaging (the worker's assertConnected), so it makes no copy
  // calendar after the Remove pass below. Best effort: a Redis that refuses the marker is logged and reported, and the
  // delete goes on (the person asked for it; the run then fails on the rows that are gone).
  try {
    const { markDisconnecting } = await import('../services/google-sync/worker');
    await markDisconnecting(userId);
  } catch (error) {
    console.error(`[Moderation] Hard delete of user ${userId}: marking the Google disconnect failed; the delete goes on`, error);
    captureError(error, 'google-sync-hard-delete-marker', { user_id: userId }, 'warning');
  }

  try {
```

(the rest of the body is unchanged except:)

```ts
        data: { status: 'UNLINKED', unlinkedAt: new Date(), unlinkedByUserId: by === 'self' ? null : by.admin },
```

and the last line:

```ts
  // The person's own delete is logged by its route, with the way they came in (app/api/account/delete)
  if (by !== 'self') console.log(`[Moderation] Admin ${by.admin} hard-deleted user ${userId}`);
```

`personalCacheKeys` stays the next export after `hardDeleteUser` (scripts/smoke-signin-data.ts #8 cuts the text between them).

`app/api/admin/users/moderation/route.ts:63`: `await hardDeleteUser(user_id, { admin: auth.adminId! });`

- [ ] **Step 4: The route**

Create `app/api/account/delete/route.ts`:

```ts
// Settings' "Delete account" (spec docs/superpowers/specs/2026-11-07-b-features-design.md §B3).
//
// POST /api/account/delete?user_id=…  — body { confirm: true }: deletes the proved user's own account with the admin's
//   one delete path (hardDeleteUser(id, 'self'): the copies in Google carried out (Keep honoured), the Google grant
//   revoked, the partner unlinked, every row of the account gone, the caches cleared). Answers { ok: true } and clears this
//   browser's session cookie; a session in another browser then finds no account (404, its cookie cleared).
//
// In order: the same-origin check (an irreversible write a session cookie can make), the proof (Telegram initData, or the
// session cookie, with the settings limiter), a sign-in from the last hour for a browser (refuseStaleSignIn; initData is
// never asked), the explicit { confirm: true }, and never an admin account (the owner's own). A suspended account is
// refused by verifyUserAuth (403); a banned one may delete itself, and its ban rows stay. The route acts only on
// auth.user.id. Logs and Sentry hold the user id only.

import { NextRequest, NextResponse } from 'next/server';
import { refuseCrossSite } from '@/src/lib/same-origin';
import { verifyUserAuth } from '@/src/lib/api-auth';
import { requestInitData } from '@/src/lib/request-init-data';
import { settingsRateLimiter } from '@/src/lib/rate-limit';
import { refuseStaleSignIn } from '@/src/lib/recent-sign-in';
import { clearSessionCookie } from '@/src/lib/session-auth';
import { captureError } from '@/src/lib/error-capture';
import { hardDeleteUser } from '@/src/lib/user-moderation';

export const dynamic = 'force-dynamic';

const TAG = 'account-delete';

export async function POST(request: NextRequest) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // Not the error's message: V8 quotes the start of the text it couldn't parse
    console.warn(`[${TAG}] refused: the body is not JSON`);
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const auth = await verifyUserAuth(request, request.nextUrl.searchParams.get('user_id'), requestInitData(request, body), settingsRateLimiter, TAG);
  if (!auth.success) return auth.response;
  const stale = refuseStaleSignIn(auth, TAG);
  if (stale) return stale;

  const userId = auth.user.id;
  if (body.confirm !== true) {
    console.warn(`[${TAG}] user ${userId}: refused a request without confirm: true`);
    return NextResponse.json({ error: 'confirm_required' }, { status: 400 });
  }
  if (auth.user.isAdmin) {
    console.warn(`[${TAG}] user ${userId}: refused: an admin account is not deleted from Settings`);
    return NextResponse.json({ error: 'admin' }, { status: 403 });
  }

  try {
    await hardDeleteUser(userId, 'self');
  } catch (error) {
    captureError(error, TAG, { user_id: userId });
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
  console.log(`[${TAG}] user ${userId} deleted their account (${auth.via})`);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
```

- [ ] **Step 5: Docs**

`CLAUDE.md`, the sign-in rule: change `… Finish here) need a sign-in from the last hour` to `… Finish here), and deleting one's own account in Settings (\`POST /api/account/delete\`, which also asks the same-origin check and \`{ confirm: true }\` and refuses an admin), need a sign-in from the last hour`.

`README.md`, after the "Web sign-up" section:

```markdown
### Deleting an account

Settings → **Delete account** (the Mini App or a browser) deletes the person's own account with the admin's one delete path, `hardDeleteUser(id, 'self')` (`src/lib/user-moderation.ts`), through `POST /api/account/delete` (spec `docs/superpowers/specs/2026-11-07-b-features-design.md` §B3). The copy calendars in Google are removed except those turned off with Keep, the Google grant is revoked, the partner is unlinked and loses the calendars the person owned (events the person added to the partner's calendars stay theirs), and every row of the account goes, payments included. A browser needs a sign-in from the last hour; an admin account can't delete itself, a suspended one gets 403, a banned one may (its ban rows stay). The sheet warns when a paid month is still running: a refund has to be asked for before the delete.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `RUN smoke-account-delete`, `RUN smoke-recent-sign-in`, `RUN smoke-bug-batch-safety`, `RUN smoke-account-merge`, `RUN smoke-signin-data`, `RUN smoke-alerts-gate-writers`, `RUN smoke-pause`, `RUN smoke-push-session-end` — Expected: all passed.
Run: `npx tsc --noEmit -p .` and `npx eslint app/api/account/delete/route.ts src/lib/user-moderation.ts app/api/admin/users/moderation/route.ts scripts/smoke-account-delete.ts` — Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/user-moderation.ts app/api/admin/users/moderation/route.ts app/api/account/delete/route.ts scripts/smoke-account-delete.ts scripts/smoke-recent-sign-in.ts scripts/smoke-bug-batch-safety.ts scripts/smoke-account-merge.ts CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
feat(account): POST /api/account/delete deletes the person's own account through hardDeleteUser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 7: B3 the Settings row and sheet (UI)

Implementer invokes the frontend-design skill first, and stays inside the app kit (`FormCard`, `BottomSheet`, `Notice`, the `ch-*` classes GoogleDisconnect uses, lucide `Trash2` and `Loader2`).

**Files:**
- Create: `app/[locale]/(app)/settings/AccountDelete.tsx`, `app/[locale]/(app)/settings/account-delete-client.ts`
- Modify: `app/[locale]/(app)/settings/SettingsClient.tsx` (one import, one prop, one state, three small lines)
- Modify: `src/lib/comp-eligibility.ts` (`paidMonthRunning`)
- Modify: `src/lib/page-data.ts` (one prop in `settings()`)
- Modify: `messages/{en,he,ru}.json` (`settings.accountDelete.*`)
- Create: `scripts/smoke-account-delete-ui.ts`
- Modify: `scripts/smoke-settings-render.ts` (S10's own-smoke list)

**Interfaces:**
- Consumes: the route of Task 6 and its answers; `turnOffPush(null)` (`src/lib/web-push-client.ts`); `signInAgain(locale)` (`src/lib/sign-in-again.ts`); `initDataHeaders`, `readInitData` (`src/lib/read-init-data.ts`); `localeHref` (`src/site/zmanim/links.ts`); `holdsPaidPlan` (same file as `paidMonthRunning`).
- Produces: `paidMonthRunning(sub: { status: string; plan: string; compedBy: number | null; currentPeriodEnd: Date | string | null }, now: Date): boolean`; SettingsClient prop `accountDelete?: { paidMonthRunning: boolean } | null` (null or absent: no row); `requestAccountDelete(userId: number): Promise<AccountDeleteResult>`; `AccountDeleteView` and the default `AccountDelete({ userId, paidMonthRunning, onSheet })`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-account-delete-ui.ts`:

```ts
// Smoke test for Settings' Delete account, the screen side (spec docs/superpowers/specs/2026-11-07-b-features-design.md §B3;
// plan docs/superpowers/plans/2026-11-07-b-features.md Task 7): AccountDelete.tsx, account-delete-client.ts, paidMonthRunning.
//  - U1 the row: one red row of a card, the trash icon (hidden from readers) and "Delete account", no dialog
//  - U2 the sheet: what goes (data, the partner, Google) and "can't be undone", Delete my account (red) and Cancel; the
//    paid-month line and its Terms link only when a paid month runs
//  - U3 working: the spinner line, Delete and the sheet's close disabled
//  - U4 the answers: failed and busy say so; a stale browser sign-in shows its note and Sign in again in place of Delete;
//    a WhatsApp link's says to ask for a new link, with no Delete
//  - U5 done and gone: their heading and Close only
//  - U6 the words: the same keys in en, he and ru, no emoji
//  - U7 the container: the press posts { confirm: true } once, the sheet can't be closed while it waits, done after 200,
//    "already deleted" after 404, and Close leaves the app (the home page in a browser)
//  - U8 the client: each answer becomes its result; the status only is logged
//  - U9 paidMonthRunning: a paid plan whose month is still ahead, never a trial, a gift, Free, or a month that ended
//  - U10 the wiring: Settings shows the row only from its accountDelete prop, which page-data fills (null for an admin)
// Real React on the small fake DOM (scripts/lib/fake-dom.ts) and renderToString. Faked: fetch. No network.
//
// Run: $RUN smoke-account-delete-ui

import fs from 'fs';
import path from 'path';
import { act, createElement, type ComponentProps, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import AccountDelete, { AccountDeleteView, type AccountDeleteViewProps } from '../app/[locale]/(app)/settings/AccountDelete';
import { requestAccountDelete } from '../app/[locale]/(app)/settings/account-delete-client';
import { paidMonthRunning } from '../src/lib/comp-eligibility';
import { localeHref } from '../src/site/zmanim/links';
import { elements, installWindow, mount } from './lib/fake-dom';

type Row = Record<string, unknown>;
type Locale = 'en' | 'he' | 'ru';
const ROOT = path.resolve(__dirname, '..');
const LOCALES: Locale[] = ['en', 'he', 'ru'];
const messages = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${l}.json`), 'utf8'))])) as Record<Locale, Row>;
const ad = (l: Locale) => (messages[l].settings as Row).accountDelete as Record<string, string>;

const results: { name: string; ok: boolean; reason?: string }[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);
const provider = (locale: Locale) => ({ locale, messages: messages[locale], timeZone: 'Asia/Jerusalem' }) as ComponentProps<typeof NextIntlClientProvider>;
const render = (locale: Locale, element: ReactElement) => renderToString(createElement(NextIntlClientProvider, { ...provider(locale), children: element } as ComponentProps<typeof NextIntlClientProvider>));
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({ tag: m[0].slice(0, m[0].indexOf('>') + 1), text: textOf(m[1]) }));
/** The paid-month line's words as they render: the sentence before the link, and the link's own words. */
const paidParts = (s: string): [string, string] => [s.split('<terms>')[0].trim(), /<terms>(.*)<\/terms>/.exec(s)?.[1] ?? s];
const noop = () => undefined;
const view = (o: Partial<AccountDeleteViewProps> = {}) =>
  createElement(AccountDeleteView, { phase: 'idle', paidMonthRunning: false, error: null, termsHref: '/terms#cancel', onOpen: noop, onConfirm: noop, onCancel: noop, onSignInAgain: noop, onClose: noop, ...o });
const html = (l: Locale, o: Partial<AccountDeleteViewProps> = {}) => render(l, view(o));
const EMOJI = /\p{Extended_Pictographic}/u;

async function main() {
  await check('U1 the row: one red row of a card with the trash icon (hidden from readers) and "Delete account", in en, he and ru; no dialog', () => {
    for (const l of LOCALES) {
      const h = html(l);
      const b = buttons(h);
      assert(b.length === 1 && b[0].text === ad(l).button && /class="ch-form-row ch-danger-row"/.test(b[0].tag) && /aria-haspopup="dialog"/.test(b[0].tag), `${l}: ${show(b)}`);
      assert(/<svg[^>]*aria-hidden="true"/.test(h) && !/role="dialog"/.test(h), `${l}: the icon or a dialog`);
    }
  });

  await check('U2 the sheet: the title, what goes (data, the partner, Google), "can\'t be undone", Delete my account (red) and the sheet\'s Cancel; the paid-month line with its Terms link only when a paid month runs', () => {
    for (const l of LOCALES) {
      const t = ad(l);
      const h = html(l, { phase: 'confirm' });
      const text = textOf(h);
      for (const key of ['confirmTitle', 'goesData', 'goesPartner', 'goesGoogle', 'undone']) assert(text.includes(t[key]), `${l}: no ${key}`);
      const [sentence, linkWords] = paidParts(t.paidMonth);
      assert(!text.includes(sentence) && !h.includes('href="/terms#cancel"'), `${l}: the paid-month line with no paid month`);
      const b = buttons(h);
      assert(b.some((x) => x.text === t.confirm && /ch-btn-danger/.test(x.tag)) && b.at(-1)?.text === t.cancel, `${l}: buttons ${show(b)}`);
      const paid = html(l, { phase: 'confirm', paidMonthRunning: true });
      const link = /<a\b[^>]*href="\/terms#cancel"[^>]*>([\s\S]*?)<\/a>/.exec(paid);
      assert(textOf(paid).includes(sentence) && link && textOf(link[1]) === linkWords && /target="_blank"/.test(link[0]), `${l}: no paid-month line or link`);
    }
  });

  await check('U3 working: the spinner line, Delete and the sheet\'s close disabled', () => {
    const h = html('en', { phase: 'working' });
    assert(textOf(h).includes(ad('en').working) && /ch-spin/.test(h), 'no spinner line');
    const b = buttons(h);
    assert(b.filter((x) => x.text === ad('en').confirm || x.text === ad('en').cancel).every((x) => /disabled=""/.test(x.tag)), `buttons ${show(b)}`);
  });

  await check('U4 the answers: failed and busy say so (an alert); a stale browser sign-in shows its note and Sign in again in place of Delete; a WhatsApp link\'s says to ask for a new link, with no Delete', () => {
    const t = ad('en');
    assert(textOf(html('en', { phase: 'confirm', error: 'failed' })).includes(t.errorFailed) && /role="alert"/.test(html('en', { phase: 'confirm', error: 'failed' })), 'failed');
    assert(textOf(html('en', { phase: 'confirm', error: 'busy' })).includes(t.errorBusy), 'busy');
    const stale = html('en', { phase: 'confirm', error: 'stale' });
    assert(textOf(stale).includes(t.staleNote) && buttons(stale).some((b) => b.text === t.signInAgain) && !buttons(stale).some((b) => b.text === t.confirm), `stale ${show(buttons(stale))}`);
    const link = html('en', { phase: 'confirm', error: 'staleLink' });
    assert(textOf(link).includes(t.staleLink) && !buttons(link).some((b) => b.text === t.confirm || b.text === t.signInAgain), `staleLink ${show(buttons(link))}`);
  });

  await check('U5 done and gone: their heading and Close only', () => {
    for (const [phase, key] of [['done', 'doneTitle'], ['gone', 'goneTitle']] as const) {
      const h = html('he', { phase });
      const b = buttons(h);
      assert(textOf(h).includes(ad('he')[key]) && b.length === 2 && b[1].text === ad('he').close, `${phase}: ${show(b)}`);
    }
  });

  await check('U6 the words: the same accountDelete keys in en, he and ru, every one a non-empty string, no emoji', () => {
    const keys = (l: Locale) => Object.keys(ad(l)).sort();
    for (const l of LOCALES) {
      assert(show(keys(l)) === show(keys('en')), `${l}: keys ${show(keys(l))}`);
      for (const [k, v] of Object.entries(ad(l))) assert(typeof v === 'string' && v.length > 0 && !EMOJI.test(v), `${l}.${k}`);
    }
  });

  await check('U7 the container: the press posts { confirm: true } once to /api/account/delete?user_id=7; the sheet can\'t be closed while it waits; done after 200, "already deleted" after 404; Close leaves for the home page in a browser', async () => {
    installWindow();
    const w = globalThis as unknown as { window: Row; fetch: typeof fetch };
    const assigned: string[] = [];
    (w.window as Row).location = { href: 'https://famcal.bot/en/settings', hash: '', assign: (u: string) => void assigned.push(u) };
    const origFetch = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    for (const [status, want] of [[200, ad('en').doneTitle], [404, ad('en').goneTitle]] as const) {
      calls.length = 0;
      assigned.length = 0;
      let release: (r: Response) => void = noop;
      globalThis.fetch = ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Promise<Response>((resolve) => void (release = resolve));
      }) as unknown as typeof fetch;
      const sheets: (null | (() => void))[] = [];
      const m = mount(createElement(NextIntlClientProvider, { ...provider('en'), children: createElement(AccountDelete, { userId: 7, paidMonthRunning: false, onSheet: (c: (() => void) | null) => void sheets.push(c) }) } as ComponentProps<typeof NextIntlClientProvider>));
      try {
        const byText = (text: string) => elements(m.container).find((e) => e.localName === 'button' && e.textContent?.trim() === text);
        m.click(byText(ad('en').button)!);
        m.click(byText(ad('en').confirm)!);
        await act(async () => undefined);
        assert(calls.length === 1 && calls[0].url === '/api/account/delete?user_id=7' && calls[0].init.method === 'POST' && calls[0].init.body === JSON.stringify({ confirm: true }) && calls[0].init.credentials === 'same-origin', `calls ${show(calls)}`);
        const closer = sheets.at(-1);
        assert(typeof closer === 'function', 'no closer while working');
        closer!();
        assert(elements(m.container).some((e) => e.getAttribute('role') === 'dialog'), 'the sheet closed while working');
        await act(async () => release(new Response(JSON.stringify(status === 200 ? { ok: true } : { error: 'User not found' }), { status })));
        await act(async () => undefined);
        assert((m.container.textContent ?? '').includes(want), `${status}: ${(m.container.textContent ?? '').slice(0, 200)}`);
        m.click(byText(ad('en').close)!);
        assert(show(assigned) === show([localeHref('en', '/')]), `${status}: left for ${show(assigned)}`);
      } finally {
        m.unmount();
      }
    }
    globalThis.fetch = origFetch;
  });

  await check('U8 the client: 200 ok is deleted, 404 gone, 403 stale-sign-in stale (whatsapp told), 429 busy, 500 and no answer failed; the request carries the init data header only when there is one', async () => {
    const origFetch = globalThis.fetch;
    const answer = (status: number, b: Row) => (async () => new Response(JSON.stringify(b), { status })) as unknown as typeof fetch;
    const cases: [typeof fetch, string][] = [
      [answer(200, { ok: true }), show({ kind: 'deleted' })],
      [answer(404, { error: 'User not found' }), show({ kind: 'gone' })],
      [answer(403, { ok: false, error: 'stale-sign-in' }), show({ kind: 'stale', whatsapp: false })],
      [answer(403, { ok: false, error: 'stale-sign-in', whatsapp: true }), show({ kind: 'stale', whatsapp: true })],
      [answer(429, { error: 'Too many requests' }), show({ kind: 'error', code: 'busy' })],
      [answer(500, { error: 'failed' }), show({ kind: 'error', code: 'failed' })],
      [(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch, show({ kind: 'error', code: 'failed' })],
    ];
    try {
      for (const [f, want] of cases) {
        globalThis.fetch = f;
        const got = show(await requestAccountDelete(7));
        assert(got === want, `${want}: got ${got}`);
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await check('U9 paidMonthRunning: an ACTIVE or CANCELED paid plan whose month is still ahead; never a trial, a gift, Free, EXPIRED, or a month that ended', () => {
    const now = new Date('2026-11-07T10:00:00Z');
    const ahead = new Date('2026-11-20T10:00:00Z');
    const past = new Date('2026-11-01T10:00:00Z');
    const sub = (o: Row) => ({ status: 'ACTIVE', plan: 'PRO', compedBy: null, currentPeriodEnd: ahead, ...o }) as Parameters<typeof paidMonthRunning>[0];
    assert(paidMonthRunning(sub({}), now) && paidMonthRunning(sub({ status: 'CANCELED' }), now) && paidMonthRunning(sub({ plan: 'BASIC', currentPeriodEnd: ahead.toISOString() }), now), 'a paid month');
    for (const o of [{ status: 'TRIALING' }, { compedBy: 1 }, { plan: 'FREE' }, { status: 'EXPIRED' }, { currentPeriodEnd: past }, { currentPeriodEnd: null }]) assert(!paidMonthRunning(sub(o), now), `not paid: ${show(o)}`);
  });

  await check('U10 the wiring: Settings renders the row only from its accountDelete prop, which page-data fills from the plan (null for an admin)', () => {
    const client = fs.readFileSync(path.join(ROOT, 'app/[locale]/(app)/settings/SettingsClient.tsx'), 'utf8');
    const pageData = fs.readFileSync(path.join(ROOT, 'src/lib/page-data.ts'), 'utf8');
    assert(/accountDelete\?: \{ paidMonthRunning: boolean \} \| null/.test(client) && /\{accountDelete \? <AccountDelete\b/.test(client), 'SettingsClient does not render the row from its prop');
    assert(/accountDelete: user\.isAdmin \? null : \{ paidMonthRunning: /.test(pageData), 'page-data does not fill accountDelete');
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n     ${r.reason}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

(The clicks follow smoke-google-disconnect-ui.ts's container check, which drives GoogleDisconnect's sheet the same way around its line 135; wrap a click in `await act(async () => …)` as it does when React has state to flush.)

In `scripts/smoke-settings-render.ts`, S10: `const OWN_SMOKE = ['GoogleDisconnect.tsx', 'SignInMethods.tsx', 'signin-methods-client.ts', 'AccountDelete.tsx', 'account-delete-client.ts'];`, the `own` filter also drops `k.startsWith('accountDelete.')`, the read check also allows `key.startsWith('accountDelete.')`, and the title says `(googleDisconnect, signIn and accountDelete are their own sections')`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `RUN smoke-account-delete-ui` — Expected: FAIL at load (`AccountDelete` not found).

- [ ] **Step 3: The strings**

`messages/en.json`, inside `settings`, right after the closing `},` of `"googleDisconnect": { … }`:

```json
    "accountDelete": {
      "button": "Delete account",
      "confirmTitle": "Delete your account?",
      "goesData": "Your calendars and events, settings, plan and sign-in ways are deleted.",
      "goesPartner": "Your partner is unlinked and loses the calendars you own and their events. Events you added to their calendars stay with them.",
      "goesGoogle": "FamCal’s copy calendars are removed from your Google account, except those you chose to keep, and FamCal’s access to Google is revoked.",
      "undone": "This can’t be undone.",
      "paidMonth": "Your paid plan ends with your account. To cancel a payment, ask us before you delete (<terms>Terms, Cancelling and refunds</terms>).",
      "confirm": "Delete my account",
      "cancel": "Cancel",
      "working": "Deleting your account…",
      "errorFailed": "Your account couldn’t be deleted. Try again.",
      "errorBusy": "Too many tries. Wait a minute and try again.",
      "staleNote": "For your safety, deleting your account needs a sign-in from the last hour.",
      "signInAgain": "Sign in again",
      "staleLink": "For your safety, ask for a new link in the WhatsApp chat, then delete your account from it.",
      "doneTitle": "Your account is deleted.",
      "goneTitle": "This account was already deleted.",
      "close": "Close"
    },
```

`messages/he.json`, same place:

```json
    "accountDelete": {
      "button": "מחיקת החשבון",
      "confirmTitle": "למחוק את החשבון?",
      "goesData": "היומנים והאירועים, ההגדרות, המסלול ודרכי הכניסה שלכם יימחקו.",
      "goesPartner": "הקישור לבן או בת הזוג יבוטל, והיומנים שבבעלותכם יימחקו גם אצלם, עם האירועים שבהם. אירועים שהוספתם ליומנים שלהם יישארו אצלם.",
      "goesGoogle": "יומני העותק של FamCal יוסרו מחשבון ה־Google שלכם, חוץ מאלה שבחרתם להשאיר, והגישה של FamCal ל־Google תבוטל.",
      "undone": "אי אפשר לבטל את המחיקה.",
      "paidMonth": "המסלול בתשלום נגמר יחד עם החשבון. כדי לבטל תשלום, פנו אלינו לפני המחיקה (<terms>התנאים, ״ביטול והחזרים״</terms>).",
      "confirm": "למחוק את החשבון שלי",
      "cancel": "ביטול",
      "working": "מוחקים את החשבון…",
      "errorFailed": "לא הצלחנו למחוק את החשבון. נסו שוב.",
      "errorBusy": "יותר מדי ניסיונות. חכו דקה ונסו שוב.",
      "staleNote": "מטעמי אבטחה, מחיקת החשבון דורשת כניסה מהשעה האחרונה.",
      "signInAgain": "להיכנס שוב",
      "staleLink": "מטעמי אבטחה, בקשו קישור חדש בצ׳אט בוואטסאפ, ומחקו את החשבון דרכו.",
      "doneTitle": "החשבון נמחק.",
      "goneTitle": "החשבון הזה כבר נמחק.",
      "close": "סגירה"
    },
```

`messages/ru.json`, same place:

```json
    "accountDelete": {
      "button": "Удалить аккаунт",
      "confirmTitle": "Удалить аккаунт?",
      "goesData": "Ваши календари и события, настройки, тариф и способы входа будут удалены.",
      "goesPartner": "Связь с партнёром будет разорвана, и партнёр потеряет ваши календари вместе с их событиями. События, которые вы добавили в календари партнёра, останутся там.",
      "goesGoogle": "Календари-копии FamCal будут удалены из вашего аккаунта Google, кроме тех, что вы решили оставить, а доступ FamCal к Google будет отозван.",
      "undone": "Отменить удаление будет нельзя.",
      "paidMonth": "Оплаченный тариф закончится вместе с аккаунтом. Чтобы отменить платёж, напишите нам до удаления (<terms>Условия, «Отмена и возврат»</terms>).",
      "confirm": "Удалить мой аккаунт",
      "cancel": "Отмена",
      "working": "Удаляем аккаунт…",
      "errorFailed": "Не удалось удалить аккаунт. Попробуйте ещё раз.",
      "errorBusy": "Слишком много попыток. Подождите минуту и попробуйте снова.",
      "staleNote": "Для безопасности удалить аккаунт можно только в течение часа после входа.",
      "signInAgain": "Войти снова",
      "staleLink": "Для безопасности запросите новую ссылку в чате WhatsApp и удалите аккаунт по ней.",
      "doneTitle": "Аккаунт удалён.",
      "goneTitle": "Этот аккаунт уже удалён.",
      "close": "Закрыть"
    },
```

- [ ] **Step 4: The rule, the client, the component**

`src/lib/comp-eligibility.ts`, append:

```ts
/**
 * A paid month runs now: a plan paid for (ACTIVE, or CANCELED with its month ahead) that is not Free and not a gift
 * (compedBy), with its month's end still ahead. Settings' Delete account warns of it (spec 2026-11-07-b-features §B3).
 */
export function paidMonthRunning(sub: { status: string; plan: string; compedBy: number | null; currentPeriodEnd: Date | string | null }, now: Date): boolean {
  if (sub.plan === 'FREE' || sub.compedBy !== null || sub.currentPeriodEnd === null) return false;
  if (!holdsPaidPlan(sub, now)) return false;
  const end = typeof sub.currentPeriodEnd === 'string' ? Date.parse(sub.currentPeriodEnd) : sub.currentPeriodEnd.getTime();
  return end > now.getTime();
}
```

Create `app/[locale]/(app)/settings/account-delete-client.ts`:

```ts
// The Settings page's side of POST /api/account/delete (spec 2026-11-07-b-features §B3): delete the account. The initData
// goes in the header (initDataHeaders), never in the URL. Every answer comes back as a result the sheet words
// (settings.accountDelete.*), and a failure is logged with the status only.

import { initDataHeaders } from '@/src/lib/read-init-data';

export type AccountDeleteError = 'failed' | 'busy' | 'stale' | 'staleLink';
export type AccountDeleteResult =
  | { kind: 'deleted' }
  /** 404: the account is gone already (another tab or device deleted it); the server cleared the cookie. */
  | { kind: 'gone' }
  /** A browser's sign-in is over an hour old; `whatsapp`: a WhatsApp link's session, which asks for a new link. */
  | { kind: 'stale'; whatsapp: boolean }
  | { kind: 'error'; code: 'failed' | 'busy' };

const TAG = '[account-delete]';

export async function requestAccountDelete(userId: number): Promise<AccountDeleteResult> {
  try {
    const res = await fetch(`/api/account/delete?user_id=${userId}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...initDataHeaders() },
      body: JSON.stringify({ confirm: true }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: unknown; error?: unknown; whatsapp?: unknown };
    if (res.ok && body.ok === true) return { kind: 'deleted' };
    if (res.status === 404) return { kind: 'gone' };
    if (res.status === 403 && body.error === 'stale-sign-in') return { kind: 'stale', whatsapp: body.whatsapp === true };
    console.warn(`${TAG} the request answered ${res.status}`);
    return { kind: 'error', code: res.status === 429 ? 'busy' : 'failed' };
  } catch (error) {
    console.error(`${TAG} the request failed: ${error instanceof Error ? error.name : typeof error}`);
    return { kind: 'error', code: 'failed' };
  }
}
```

Create `app/[locale]/(app)/settings/AccountDelete.tsx`:

```tsx
'use client';

// Settings' "Delete account" (spec docs/superpowers/specs/2026-11-07-b-features-design.md §B3): a red row at the bottom of
// Settings, and a sheet that says what goes (the data, the partner, the copies in Google), that it can't be undone, and,
// while a paid month runs, that the plan ends with the account and a refund is asked for first (a link to the Terms).
// Delete my account posts { confirm: true } (account-delete-client.ts); the server deletes through the admin's one path.
// A browser whose sign-in is over an hour old learns it on the press: the sheet then offers Sign in again (signInAgain),
// or, for a WhatsApp link's session, asks for a new link in the chat. While it works the sheet can't be closed. Done (or
// already deleted, a 404): this browser's notifications are turned off (turnOffPush, locally: the devices went with the
// account), and Close leaves: the Mini App closes, a browser goes to famcal.bot's home page, signed out.
//
// AccountDeleteView is presentational (the smoke renders every phase); AccountDelete owns the state and the request.
// Drawn with the app's kit, like GoogleDisconnect. `onSheet` tells the screen what its Back should do while the sheet is open.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, Trash2 } from 'lucide-react';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { FormCard } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { readInitData } from '@/src/lib/read-init-data';
import { signInAgain } from '@/src/lib/sign-in-again';
import { turnOffPush } from '@/src/lib/web-push-client';
import { localeHref } from '@/src/site/zmanim/links';
import { requestAccountDelete, type AccountDeleteError } from './account-delete-client';

export type AccountDeletePhase = 'idle' | 'confirm' | 'working' | 'done' | 'gone';

export interface AccountDeleteViewProps {
  phase: AccountDeletePhase;
  /** A paid month runs (page-data, paidMonthRunning): the sheet says the plan ends with the account. */
  paidMonthRunning: boolean;
  error: AccountDeleteError | null;
  /** The Terms' "Cancelling and refunds" in the page's language. */
  termsHref: string;
  onOpen: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onSignInAgain: () => void;
  onClose: () => void;
}

export function AccountDeleteView(props: AccountDeleteViewProps) {
  const t = useTranslations('settings.accountDelete');
  const { phase, error } = props;
  const working = phase === 'working';
  const finished = phase === 'done' || phase === 'gone';
  const finishedTitle = phase === 'gone' ? t('goneTitle') : t('doneTitle');

  return (
    <>
      <FormCard>
        <button type="button" className="ch-form-row ch-danger-row" aria-haspopup="dialog" onClick={props.onOpen}>
          <Trash2 size={18} aria-hidden="true" />
          {t('button')}
        </button>
      </FormCard>
      {phase !== 'idle' && (
        <BottomSheet label={finished ? finishedTitle : t('confirmTitle')} closeLabel={finished ? t('close') : t('cancel')} closeDisabled={working} onClose={finished ? props.onClose : props.onCancel}>
          {finished ? (
            <h2 className="ch-sheet-heading">{finishedTitle}</h2>
          ) : (
            <>
              <h2 className="ch-sheet-heading">{t('confirmTitle')}</h2>
              <ul className="ch-sheet-list">
                <li>{t('goesData')}</li>
                <li>{t('goesPartner')}</li>
                <li>{t('goesGoogle')}</li>
              </ul>
              <p className="ch-sheet-sub">{t('undone')}</p>
              {props.paidMonthRunning && (
                <p className="ch-sheet-sub">
                  {t.rich('paidMonth', {
                    terms: (chunks: ReactNode) => (
                      <a href={props.termsHref} target="_blank" rel="noopener noreferrer">
                        {chunks}
                      </a>
                    ),
                  })}
                </p>
              )}
              <div className="ch-sheet-stack">
                {error === 'failed' || error === 'busy' ? <Notice tone="error">{t(error === 'busy' ? 'errorBusy' : 'errorFailed')}</Notice> : null}
                {error === 'stale' ? <p className="ch-form-fixed">{t('staleNote')}</p> : null}
                {error === 'staleLink' ? <Notice>{t('staleLink')}</Notice> : null}
                {working && (
                  <p className="ch-form-fixed ch-working">
                    <Loader2 size={16} className="ch-spin" aria-hidden="true" /> {t('working')}
                  </p>
                )}
                {error === 'stale' ? (
                  <button type="button" className="ch-btn ch-btn-primary ch-save" onClick={props.onSignInAgain}>
                    {t('signInAgain')}
                  </button>
                ) : error === 'staleLink' ? null : (
                  <button type="button" className="ch-btn ch-btn-primary ch-btn-danger ch-save" onClick={props.onConfirm} disabled={working}>
                    {t('confirm')}
                  </button>
                )}
              </div>
            </>
          )}
        </BottomSheet>
      )}
    </>
  );
}

interface AccountDeleteProps {
  userId: number;
  paidMonthRunning: boolean;
  /** What Back should do while the sheet is open: its closer (a no-op during the request, Leave when done), or null once closed. */
  onSheet?: (close: (() => void) | null) => void;
}

const noop = () => {};

export default function AccountDelete({ userId, paidMonthRunning, onSheet }: AccountDeleteProps) {
  const locale = useLocale();
  const [phase, setPhase] = useState<AccountDeletePhase>('idle');
  const [error, setError] = useState<AccountDeleteError | null>(null);

  // The account is gone: the Mini App closes; a browser (signed out by the answer's cleared cookie) goes to the home page
  const leave = useCallback(() => {
    const tg = readInitData() !== '' ? window.Telegram?.WebApp : undefined;
    if (tg) {
      tg.close();
      return;
    }
    window.location.assign(localeHref(locale, '/'));
  }, [locale]);

  // The closers run later than the render that made them: they read the parent's latest callback.
  const latest = useRef({ onSheet, leave });
  useEffect(() => {
    latest.current = { onSheet, leave };
  });
  useEffect(() => {
    const closer = phase === 'confirm' ? () => setPhase('idle') : phase === 'working' ? noop : phase === 'done' || phase === 'gone' ? () => latest.current.leave() : null;
    latest.current.onSheet?.(closer);
  }, [phase]);
  useEffect(() => () => latest.current.onSheet?.(null), []);

  const confirm = async () => {
    setError(null);
    setPhase('working');
    const result = await requestAccountDelete(userId);
    if (result.kind === 'deleted' || result.kind === 'gone') {
      // This browser drops its subscription; its device row went with the account, so no request is sent (turnOffPush logs a failure)
      await turnOffPush(null);
      setPhase(result.kind === 'deleted' ? 'done' : 'gone');
      return;
    }
    setError(result.kind === 'stale' ? (result.whatsapp ? 'staleLink' : 'stale') : result.code);
    setPhase('confirm');
  };

  return (
    <AccountDeleteView
      phase={phase}
      paidMonthRunning={paidMonthRunning}
      error={error}
      termsHref={`${localeHref(locale, '/terms')}#cancel`}
      onOpen={() => {
        setError(null);
        setPhase('confirm');
      }}
      onConfirm={() => void confirm()}
      onCancel={() => setPhase('idle')}
      onSignInAgain={() => void signInAgain(locale)}
      onClose={leave}
    />
  );
}
```

(`window.Telegram` is typed globally by src/types/telegram-webapp.d.ts, as PageGate.tsx uses it.)

- [ ] **Step 5: Wire it into Settings and page-data**

`app/[locale]/(app)/settings/SettingsClient.tsx`:
- after `import PushCard from './PushCard';`: `import AccountDelete from './AccountDelete';`
- in `SettingsClientProps`, after `push?: PushPageProps | null;`:

```ts
  /** Delete account (spec 2026-11-07-b-features §B3): the row and its sheet; null for an admin account, absent as before (no row). */
  accountDelete?: { paidMonthRunning: boolean } | null;
```

- add `accountDelete` to the destructured props of `SettingsClient`;
- after `const [signInClose, setSignInClose] = …`: `const [deleteClose, setDeleteClose] = useState<(() => void) | null>(null);`
- `useTelegramVerticalSwipes(timeOpen || locationOpen || googleClose !== null || signInClose !== null || deleteClose !== null);`
- in `backHandler`, after `else if (signInClose) signInClose();`: `else if (deleteClose) deleteClose();`
- after `<SignInMethods … />`:

```tsx
        {accountDelete ? <AccountDelete userId={userId} paidMonthRunning={accountDelete.paidMonthRunning} onSheet={(close) => setDeleteClose(() => close)} /> : null}
```

`src/lib/page-data.ts`: add `paidMonthRunning` to an import (`import { paidMonthRunning } from '@/src/lib/comp-eligibility';` on its own line next to the other `@/src/lib` imports), and in `settings()`'s `props`, after `push,`:

```ts
    // Delete account (B3): hidden for an admin account; the sheet warns while a paid month runs (not a trial, not a gift)
    accountDelete: user.isAdmin ? null : { paidMonthRunning: subWithUsage ? paidMonthRunning(subWithUsage.subscription, new Date()) : false },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `RUN smoke-account-delete-ui`, `RUN smoke-settings-render` (both zones as its header says), `RUN smoke-google-disconnect-ui`, `RUN smoke-web-push-ui`, `RUN smoke-browser-only-ui`, `RUN smoke-page-auth`, `RUN smoke-comp-subscription` — Expected: all passed.
Run: `npx tsc --noEmit -p .` and `npx eslint "app/[locale]/(app)/settings/AccountDelete.tsx" "app/[locale]/(app)/settings/account-delete-client.ts" "app/[locale]/(app)/settings/SettingsClient.tsx" src/lib/page-data.ts src/lib/comp-eligibility.ts scripts/smoke-account-delete-ui.ts` — Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add "app/[locale]/(app)/settings/AccountDelete.tsx" "app/[locale]/(app)/settings/account-delete-client.ts" "app/[locale]/(app)/settings/SettingsClient.tsx" src/lib/comp-eligibility.ts src/lib/page-data.ts messages/en.json messages/he.json messages/ru.json scripts/smoke-account-delete-ui.ts scripts/smoke-settings-render.ts
git commit -m "$(cat <<'EOF'
feat(settings): Delete account, a red row and a sheet that says what goes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

### Task 8: The WhatsApp adapter on the one third-party retry loop (owner-approved follow-up, no product change)

**Files:**
- Modify: `src/services/messaging/whatsapp-adapter.ts` (`makeRequest`, `downloadMedia`, `uploadMedia`, `sendTypingIndicator`; two exports at the top)
- Create: `scripts/smoke-whatsapp-retry.ts`
- Modify: `src/utils/fetch-retry.ts` (the header's list of callers), `CLAUDE.md` (the third-party retry rule's list and its smoke)

**Interfaces:**
- Consumes: `fetchWithRetry`, `fetchAndReadWithRetry`, `HttpStatusError`, `__useRetryForTests` (`src/utils/fetch-retry.ts`), `wholeJson` (`src/utils/whole-json.ts`).
- Produces: `export const WHATSAPP_REFUSALS: readonly number[]` (every 4xx but 429). `WhatsAppAdapter`'s public methods keep their signatures and their thrown messages, except a refused media GET now says `HTTP <status>` instead of quoting Graph's body.

Which statuses WhatsApp's Cloud API returns that must not be retried: every 4xx except 429. In practice 400 (Graph error 100 invalid parameter, 131008/131009 a missing or bad parameter, 131026 message undeliverable, 131047 re-engagement: outside the 24-hour window, 131051 unsupported message type, 131053 media upload error, 132000/132001 template parameters or template missing), 401 (190 the access token expired or is invalid), 403 (10 and 200 permission missing, 131031 business account locked), 404 (an unknown phone-number id or media id, or an expired media URL) and 413 (media too large). Retried by the loop: 429 (4 app rate limit, 80007 WABA rate limit, 130429 throughput, 131048 spam rate limit, 131056 pair rate limit), every 5xx (131000 something went wrong, 131016 service unavailable, 133004 server temporarily unavailable) and no answer, up to 3 times after max(Retry-After, a jitter from 500 ms); a Retry-After over 10 s fails at once. 131056 (too many messages to one number) may outlast the loop's short retries; the send then fails and is logged, as today.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-whatsapp-retry.ts`:

```ts
// Smoke test for WhatsApp's calls on the one third-party retry loop (src/services/messaging/whatsapp-adapter.ts over
// src/utils/fetch-retry.ts; CLAUDE.md: every third party other than Google's APIs; plan 2026-11-07-b-features Task 8).
//  - W1 a send that meets a 5xx is sent again and goes through (one wait)
//  - W2 a 429's Retry-After is honoured (the wait is the server's ask)
//  - W3 a Retry-After over 10 s fails at once
//  - W4 a refusal (400 with Graph's code, 401, 403, 404) is never sent again; the send throws with Graph's error, as before
//  - W5 no answer is tried 4 times, then the send throws, and the give-up is logged once
//  - W6 a voice note: the upload is retried with the same form, then the message goes with the media id
//  - W7 a media download: the metadata GET and the file GET are retried, a file body cut off on the way included
//  - W8 a refused metadata GET fails at once with its status
//  - W9 the typing indicator goes through the loop and never throws
//  - W10 the code: no fetch of its own, no sleep, no attempt counter; WHATSAPP_REFUSALS is every 4xx but 429
//  - W11 no console line holds the access token
// Real: whatsapp-adapter.ts, fetch-retry.ts (its waits recorded, not slept), whole-json.ts. Faked: fetch, error capture. No network.
//
// Run: $RUN smoke-whatsapp-retry

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const ROOT = path.resolve(__dirname, '..');

// Error capture reaches Sentry: a recorder, served to require() from its cache before the adapter loads
const captured: string[] = [];
{
  const filename = path.join(ROOT, 'src/lib/error-capture.ts');
  const ModuleClass = Module as unknown as new (id: string) => Record<string, unknown>;
  const mod = new ModuleClass(filename);
  Object.assign(mod, { filename, loaded: true, exports: { captureError: (_e: unknown, context: string) => void captured.push(context), captureWarning: () => undefined, captureInfo: () => undefined } });
  (Module as unknown as { _cache: Record<string, unknown> })._cache[filename] = mod;
}
/* eslint-disable @typescript-eslint/no-require-imports */
const retry = require('../src/utils/fetch-retry') as typeof import('../src/utils/fetch-retry');
const { WhatsAppAdapter, WHATSAPP_REFUSALS } = require('../src/services/messaging/whatsapp-adapter') as typeof import('../src/services/messaging/whatsapp-adapter');
/* eslint-enable @typescript-eslint/no-require-imports */

const results: { name: string; ok: boolean; reason?: string }[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const show = (v: unknown) => JSON.stringify(v);

type Answer = Response | Error;
let script: Answer[] = [];
const requests: { url: string; init?: RequestInit }[] = [];
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  requests.push({ url: String(input), init });
  const next = script.shift();
  if (!next) throw new Error('the smoke scripted no answer');
  if (next instanceof Error) throw next;
  return next;
}) as typeof fetch;
const waits: number[] = [];
retry.__useRetryForTests({ sleep: async (ms: number) => void waits.push(ms), random: () => 0.5, now: () => Date.parse('2026-11-07T10:00:00Z') });

/** The lines since the last reset, and every line of the run (W11). */
const lines: string[] = [];
const allLines: string[] = [];
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  console[level] = (...args: unknown[]) => {
    const line = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : show(a))).join(' ');
    lines.push(line);
    allLines.push(line);
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const SENT = () => json(200, { messages: [{ id: 'wamid.SMOKE' }] });
const TOKEN = 'wa-access-token-smoke-77';
const PHONE = '972500000077';
const wa = new WhatsAppAdapter(TOKEN, '1234567890');
function reset(answers: Answer[]): void {
  script = answers;
  requests.length = 0;
  waits.length = 0;
  lines.length = 0;
}
async function thrown(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function main() {
  await check('W1 a send that meets a 5xx is sent again and goes through, with one wait and the same request', async () => {
    reset([json(503, { error: { code: 131016 } }), SENT()]);
    const id = await wa.sendMessage(PHONE, 'hello');
    assert(id === 'wamid.SMOKE' && requests.length === 2 && waits.length === 1, `id ${id}, requests ${requests.length}, waits ${show(waits)}`);
    assert(requests[0].url === requests[1].url && requests[0].init?.body === requests[1].init?.body && requests[0].init?.method === 'POST', 'the second request differs');
  });

  await check('W2 a 429\'s Retry-After is honoured: the wait is the server\'s 2 s', async () => {
    reset([json(429, { error: { code: 130429 } }, { 'retry-after': '2' }), SENT()]);
    await wa.sendMessage(PHONE, 'hello');
    assert(requests.length === 2 && show(waits) === show([2000]), `waits ${show(waits)}`);
  });

  await check('W3 a Retry-After over 10 s fails at once', async () => {
    reset([json(429, { error: { code: 131056 } }, { 'retry-after': '30' })]);
    const error = await thrown(() => wa.sendMessage(PHONE, 'hello'));
    assert(error && requests.length === 1 && waits.length === 0, `requests ${requests.length}, waits ${show(waits)}, error ${error?.message}`);
  });

  await check('W4 a refusal (400 with Graph\'s code, 401, 403, 404) is never sent again; the send throws with Graph\'s error as before', async () => {
    for (const [status, code] of [[400, 131047], [401, 190], [403, 200], [404, 100]] as const) {
      reset([json(status, { error: { code, message: 'refused (smoke)' } })]);
      const error = await thrown(() => wa.sendMessage(PHONE, 'hello'));
      assert(error && requests.length === 1 && waits.length === 0 && error.message.includes(`"code":${code}`) && error.message.startsWith('WhatsApp API error'), `${status}: requests ${requests.length}, ${error?.message}`);
    }
  });

  await check('W5 no answer is tried 4 times, then the send throws, and the give-up is logged once', async () => {
    reset([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);
    const error = await thrown(() => wa.sendMessage(PHONE, 'hello'));
    assert(error && requests.length === 4 && waits.length === 3, `requests ${requests.length}, waits ${show(waits)}`);
    assert(lines.filter((l) => l.startsWith('[WhatsApp] send not delivered (gave up after 3 retries)')).length === 1, `lines ${show(lines)}`);
  });

  await check('W6 a voice note: the upload is retried with the same form, then the message goes with the media id', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-smoke-')), 'note.ogg');
    fs.writeFileSync(file, Buffer.from('OggS-smoke'));
    try {
      reset([json(500, { error: { code: 131000 } }), json(200, { id: 'media-1' }), SENT()]);
      await wa.sendVoice(PHONE, file);
      assert(requests.length === 3 && requests[0].url.endsWith('/media') && requests[1].url.endsWith('/media') && requests[2].url.endsWith('/messages'), `urls ${show(requests.map((r) => r.url))}`);
      assert(requests[0].init?.body instanceof FormData && requests[0].init?.body === requests[1].init?.body, 'the upload\'s form differs');
      assert(JSON.parse(String(requests[2].init?.body)).audio.id === 'media-1', 'the message has no media id');
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  await check('W7 a media download: the metadata GET and the file GET are retried, a file body cut off on the way included', async () => {
    const cutOff = new Response(new ReadableStream({ start(controller) { controller.error(new Error('terminated')); } }), { status: 200 });
    reset([json(502, {}), json(200, { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=smoke' }), cutOff, new Response(Buffer.from('audio-bytes'), { status: 200 })]);
    const bytes = await wa.downloadMedia('media-9');
    assert(bytes.toString() === 'audio-bytes' && requests.length === 4 && waits.length === 2, `bytes ${bytes.toString()}, requests ${requests.length}, waits ${show(waits)}`);
    assert(requests.every((r) => (r.init?.headers as Record<string, string>).Authorization === `Bearer ${TOKEN}`), 'a request without the token');
  });

  await check('W8 a refused metadata GET fails at once with its status', async () => {
    reset([json(404, { error: { code: 100 } })]);
    const error = await thrown(() => wa.downloadMedia('media-gone'));
    assert(error?.message === 'WhatsApp media metadata error: HTTP 404' && requests.length === 1, `${error?.message}, requests ${requests.length}`);
  });

  await check('W9 the typing indicator goes through the loop and never throws', async () => {
    reset([json(503, {}), json(200, { success: true })]);
    await wa.sendTypingIndicator(PHONE, 'wamid.IN');
    assert(requests.length === 2, `requests ${requests.length}`);
    reset([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);
    assert((await thrown(() => wa.sendTypingIndicator(PHONE, 'wamid.IN'))) === null, 'it threw');
  });

  await check('W10 the code: no fetch of its own, no sleep, no attempt counter, the loop imported; WHATSAPP_REFUSALS is every 4xx but 429', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/services/messaging/whatsapp-adapter.ts'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/(?<![\w.])fetch\(/.test(source), 'a fetch of its own');
    assert(!/setTimeout|retries\s*=|attempt\s*<=|Max retries/.test(source), 'a retry loop or sleep of its own');
    assert(/from '\.\.\/\.\.\/utils\/fetch-retry'/.test(source), 'fetch-retry is not imported');
    assert(WHATSAPP_REFUSALS.length === 99 && !WHATSAPP_REFUSALS.includes(429) && WHATSAPP_REFUSALS[0] === 400 && WHATSAPP_REFUSALS.at(-1) === 499, `refusals ${WHATSAPP_REFUSALS.length}`);
  });

  await check('W11 no console line holds the access token', () => {
    assert(allLines.length > 0 && !allLines.some((l) => l.includes(TOKEN)), 'the token was logged');
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) process.stdout.write(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}\n`);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `RUN smoke-whatsapp-retry` — Expected: FAIL W2 (the old loop waits 2000 ms by its own formula; W1 waits too), W3, W6/W7/W8 (no retry), W10 (`a fetch of its own`, `WHATSAPP_REFUSALS` undefined).

- [ ] **Step 3: Move the adapter onto the loop**

In `src/services/messaging/whatsapp-adapter.ts`, after the `captureError` import:

```ts
import { fetchAndReadWithRetry, fetchWithRetry, HttpStatusError } from '../../utils/fetch-retry';
import { wholeJson } from '../../utils/whole-json';

/**
 * The Cloud API's refusals: every 4xx except 429. They are answers, not failures: Graph puts its error (a code and a
 * message) in a JSON body the send reads and throws as before, and they are never sent again. Among them 400 (100 invalid
 * parameter, 131026 undeliverable, 131047 outside the 24-hour window, 131051 unsupported type, 132000 template
 * parameters), 401 (190 the token expired or is wrong), 403 (10 and 200 permission), 404 (an unknown phone-number or media
 * id) and 413 (media too large). The one third-party loop (src/utils/fetch-retry.ts, CLAUDE.md) retries 429 (4, 80007,
 * 130429, 131048, 131056), every 5xx (131000, 131016, 133004) and no answer, and honours Retry-After up to 10 s.
 */
export const WHATSAPP_REFUSALS: readonly number[] = Array.from({ length: 100 }, (_, i) => 400 + i).filter((status) => status !== 429);

const LOG = '[WhatsApp]';

/** The loop's give-up, told once: what, why, and the status or the error's message (never the token, the body or the URL). */
const logGiveUp = (what: string) => (error: unknown, info: { retried: number; why: string }) =>
  console.warn(`${LOG} ${what} not delivered (${info.why}): ${error instanceof HttpStatusError ? `HTTP ${error.status}` : error instanceof Error ? error.message : String(error)}`);
```

Replace the whole `makeRequest` method (with its doc comment) by:

```ts
  /**
   * A POST to the Cloud API through the one third-party retry loop. A refusal (WHATSAPP_REFUSALS) comes back as the
   * response, for the caller to read Graph's error as before; a 429, 5xx or no answer that outlasts the retries throws.
   */
  private post(url: string, body: string | FormData, what: string): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    if (typeof body === 'string') headers['Content-Type'] = 'application/json';
    return fetchWithRetry(url, { method: 'POST', headers, body }, { okStatuses: WHATSAPP_REFUSALS, label: `${LOG} ${what}`, onGiveUp: logGiveUp(what) });
  }

  /** A message to the Cloud API (JSON). */
  private makeRequest(url: string, body: unknown): Promise<Response> {
    return this.post(url, JSON.stringify(body), 'send');
  }
```

In `sendTypingIndicator`, replace `const response = await fetch(url, { method: 'POST', headers: {...}, body: JSON.stringify({...}) });` with:

```ts
      const response = await this.post(url, JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' }, // WA only supports 'text', no 'audio' variant
      }), 'typing indicator');
```

and its empty `catch { // Non-critical }` with:

```ts
    } catch (error) {
      // Non-critical: the reply still goes; the loop logged the give-up
      console.warn(`${LOG} Typing indicator failed: ${error instanceof Error ? error.message : String(error)}`);
    }
```

Replace the body of `downloadMedia` (keep its doc comment) with:

```ts
  async downloadMedia(mediaId: string): Promise<Buffer> {
    const headers = { Authorization: `Bearer ${this.accessToken}` };
    // Step 1: the media's URL. A GET read whole inside the attempt: an answer cut off on the way is retried like no answer.
    let meta: { url?: unknown };
    try {
      meta = await fetchAndReadWithRetry(`https://graph.facebook.com/v18.0/${mediaId}`, { headers }, async (response) => (await (await wholeJson(response)).json()) as { url?: unknown }, {
        label: `${LOG} media metadata`,
        onGiveUp: logGiveUp('media metadata'),
      });
    } catch (error) {
      if (error instanceof HttpStatusError) throw new Error(`WhatsApp media metadata error: HTTP ${error.status}`);
      throw error;
    }
    if (typeof meta.url !== 'string') throw new Error('WhatsApp media metadata error: no url in the answer');

    // Step 2: the file itself, read inside the attempt as well
    try {
      return await fetchAndReadWithRetry(meta.url, { headers }, async (response) => Buffer.from(await response.arrayBuffer()), {
        label: `${LOG} media download`,
        onGiveUp: logGiveUp('media download'),
      });
    } catch (error) {
      if (error instanceof HttpStatusError) throw new Error(`WhatsApp media download failed: ${error.status}`);
      throw error;
    }
  }
```

In `uploadMedia`, replace `const response = await fetch(url, { method: 'POST', headers: { 'Authorization': … }, body: formData });` with:

```ts
      const response = await this.post(url, formData, 'media upload');
```

(the `!response.ok` branch that reads Graph's error stays).

`src/utils/fetch-retry.ts`, header: change `MET Norway's forecast, Copernicus's dust files, and every browser push service (web-push/send.ts), FCM included` to `MET Norway's forecast, Copernicus's dust files, every browser push service (web-push/send.ts), FCM included, and WhatsApp's Cloud API (messaging/whatsapp-adapter.ts: sends, uploads, the typing indicator, media downloads)`.

`CLAUDE.md`, the third-party retry rule: change `(MET Norway's forecast, the dust files on S3, and every browser push service, FCM included: \`sendWebPush\`, src/services/web-push/send.ts)` to `(MET Norway's forecast, the dust files on S3, every browser push service, FCM included: \`sendWebPush\`, src/services/web-push/send.ts, and WhatsApp's Cloud API: src/services/messaging/whatsapp-adapter.ts, whose refusals, every 4xx but 429, come back as answers through \`okStatuses\` so Graph's error is read)`, and its last sentence `\`scripts/smoke-fetch-retry.ts\` pins it.` to `\`scripts/smoke-fetch-retry.ts\` pins it, and \`scripts/smoke-whatsapp-retry.ts\` the adapter.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `RUN smoke-whatsapp-retry`, `RUN smoke-fetch-retry`, `RUN smoke-web-push-send` (it reads CLAUDE.md's retry rules and fetch-retry.ts's header), `RUN smoke-pairing-accept`, `RUN smoke-pause` — Expected: all passed.
Run: `npx tsc --noEmit -p .` and `npx eslint src/services/messaging/whatsapp-adapter.ts src/utils/fetch-retry.ts scripts/smoke-whatsapp-retry.ts` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/messaging/whatsapp-adapter.ts src/utils/fetch-retry.ts scripts/smoke-whatsapp-retry.ts CLAUDE.md
git commit -m "$(cat <<'EOF'
fix(whatsapp): the adapter's calls go through the one third-party retry loop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31
EOF
)"
```

---

## After the tasks (the controller)

- Run the whole gate: `bash scripts/ci-smokes.sh` (fake env), `npx tsc --noEmit -p .`, `npx eslint .`, and `npx next build` (never `npm run build`).
- One whole-branch review (opus) against the spec, then fix every valid finding.
- On ship day, if it isn't 2026-11-07, move `LEGAL_UPDATED` (both) and re-run `RUN smoke-signin-legal`.
- Mark the spec's status as built, and report the latent bug (`expireSubscriptions` skips the downgrade of a paid account with no Telegram id) to the owner without fixing it.

## Self-review notes

- Spec coverage: B1 (kind, lifetime, urgency, PAUSED_KINDS, the no-chat branch with the device count in the same select, the skip line, the Terms clause, the web-push spec table, CLAUDE.md, README; tests for push, no device, paused, Telegram, WhatsApp-only, early adopter) — Tasks 1, 2. B2 (web required with nothing preselected, the Telegram pair after the first reply for a new account only, not on connect, gd: matched to the presser, the WhatsApp question last with ids read after the state expired, one shared isGender, NewAccount's web arm, the log line, smoke-pause NOT_PAUSED; tests for 400 on a missing or unknown choice, female stored, createAccount's web arm, the once-only question, connect, gd:f for the presser only, a stray value, WhatsApp after the CTA, account-create and account-merge still passing) — Tasks 3, 4, 5. B3 (hardDeleteUser's actor with markDisconnecting first and exports kept adjacent, the route's order, captureError with the id, clearSessionCookie, the sheet's lines, the paid-month line with the Terms link, Sign in again and the WhatsApp line, the spinner and closeDisabled, done/gone, Mini App close or the home page, turnOffPush, paidMonthRunning in the page data, the admin row hidden, the legal wording, GUARDED, the three pinned Terms fragments, CLAUDE.md and README; tests D1–D9, the self/admin unlinker, the marker order, the sheet's phases) — Tasks 2, 6, 7. The WhatsApp retry follow-up — Task 8.
- Types used across tasks: `Gender`/`isGender` (Task 3) in Tasks 4 and 5; `getOrCreateUser → { user, created }` (Task 3) in Task 5; `DeletedBy`/`hardDeleteUser(userId, by)` (Task 6) in Tasks 6's smokes; the route's answers (Task 6) in Task 7's client; `paidMonthRunning` defined and used in Task 7.
