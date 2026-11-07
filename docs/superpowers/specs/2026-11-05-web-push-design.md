# Notifications in the browser (item 6c-2) — design

Status: shipped 2026-11-06; approved by the owner 2026-11-06. Reviewed against the code (an Opus review, 1 blocker and 15 should-fix folded in) and drafted legally (an Opus lawyer and an adversarial check, §8).
Follows 6c-1 (`2026-11-03-web-sign-up-design.md`), which made accounts on famcal.bot with no chat and deferred their notifications to this item.

## 1. Goal and decisions

An account made on famcal.bot, with no Telegram and no WhatsApp, gets FamCal's reminders, event alerts, a morning and evening list of the day, and the partner notices as notifications on the phone or computer where it turned them on.

The owner, 2026-11-05:

1. **Who:** only accounts with no chat (`hasChat` false). Telegram and WhatsApp accounts change nothing, so nobody gets a message twice.
2. **What:** reminders when due, event alerts, the morning and evening briefing as a short line built from the day's items (no AI), the partner notices (an invite accepted, a shared reminder marked Done), the notice that the trial ended (B features spec 2026-11-07 §B1) and the Google reconnect message. A tap opens the app.
3. **No buttons:** no Done or Snooze on a notification, on any device. A tap opens the home, where a due reminder has its Done (the Still open card).

My rulings, which the owner approved on 2026-11-06:

4. **The lock screen shows what Telegram's notification shows:** a reminder's or event's title and an event's place. The phone's own setting decides whether previews show there.
5. **A day with nothing on it sends no briefing** (one log line), so FamCal doesn't buzz to say there is nothing.
6. **A briefing notification isn't counted** against the plan's monthly briefings: it uses no AI, and a scheduled briefing isn't stopped by that count on Telegram either.
7. **Event alerts stay off until turned on in Settings**, as for every account today.
8. **No security notice when a device turns notifications on:** turning on needs a sign-in from the last hour, as adding a sign-in way does.
9. **Up to 10 devices per account:** an 11th replaces the oldest.

Not sent as a notification: voice, the setup nudges, plan renewal, downgrade notices (the trial-ended notice is sent since the B features, §B1), sign-in notices (they stay email), the kid-name question, the weather-only message, and the summary's own reconnect notice (the Google reconnect message covers it).

## 2. What the person sees

### 2.1 Turning it on

- **Settings** gains a card, **Notifications on this device**, for an account with no chat, in a real browser (never inside Telegram). It sits above "Sign in on the web" and saves itself (it isn't part of the Save bar).
  - **Off:** a switch, **Turn on notifications**, and one line: "Reminders and your morning and evening list come here. Event alerts too, if you turn them on below."
  - **The tap:** with a sign-in older than an hour, the card shows the existing **Sign in again** action first and asks the browser nothing. Otherwise the tap installs FamCal's small notification program (§3.3), asks the browser's permission and subscribes, all in that tap. If the browser needs a second tap for its prompt, the switch says "Tap again to allow". Once allowed, the switch is on and one notification arrives: "Notifications are on".
  - **Not answered** (Chrome on Android lets its prompt time out): the switch stays off, with "Your browser didn't ask. Tap again, or allow notifications in the site settings."
  - **Blocked:** a notice saying how to allow FamCal in the browser's or the phone's settings. The switch stays off.
  - **Refused by the server** (the hour ran out during the prompt, the account just got a chat): the browser's subscription is undone at once and the card says why.
- **The home banner** for an account with no chat ("Connect Telegram", 6c-1) becomes **Get reminders on this device**, with **Turn on** (the same flow) and **Connect Telegram** as its second action. It hides once this device is on; closing it stays per user.
- **iPhone and iPad:** notifications work only in FamCal added to the Home Screen (iOS 16.4 or later). In a Safari tab (an iPad counts, though it reports itself as a Mac), the card and the banner show the steps instead of the switch:
  1. Tap Share, then **Add to Home Screen**, and keep **Open as Web App** on.
  2. Open FamCal from the icon and sign in there. The installed app keeps its own sign-in.
  3. Turn on notifications.
- **A browser without notifications** (no service workers or no push) shows one line: "This browser can't show FamCal's notifications."

### 2.2 What arrives

Every notification is in the account's language, with no emoji. A tap opens the home (today) for every kind, except the Google reconnect, which opens the page Telegram's button opens.

| Send | When | Title | Text |
|---|---|---|---|
| Reminder | its due time (a time, the person's reminder time, or a zman at their place), and again after a snooze made in the app | the reminder's title | the line Telegram adds ("For both of you", "From Dana", "Dana is done"), else "Reminder" |
| Event alert | the event's alert time | the event's title | Telegram's time line ("Starting at 10:00", "Tomorrow at 08:00"), and the place on a second line |
| Morning briefing | the person's morning hour and days | "Today" | "Dentist 09:00, Pickup 16:00 and 2 more" (all-day items first, up to three names) |
| Evening briefing | the person's evening hour and days | "Tomorrow" | the same line for tomorrow |
| Invite accepted | when the partner accepts | "Dana accepted your invite" | "You're paired now." |
| Partner's Done | when the partner marks a shared reminder Done | "Done by Dana" | the reminder's title (silent, as on Telegram) |
| Google reconnect | once per outage, as on Telegram | the reconnect message's title | its first sentence |
| Trial ended | the first plan check after the trial ends, as on Telegram (B features spec §B1) | "Your Pro trial has ended" | "You're on the Free plan now, so reminders and event alerts have stopped. Your calendar stays as it is." (opens the plan page) |

- **A newer notification of the same reminder replaces the older one** on the device (the notification's tag).
- **A notification can go stale:** a reminder marked Done, moved or deleted elsewhere keeps its notification until it's tapped or cleared (a push can't close one silently; Telegram edits its message). The tap shows the current state.
- **The Shabbat and Yom Tov pause** holds the scheduled ones (reminders, alerts, briefings, the reconnect message, the trial-ended notice), as it holds the chat's. One of them waiting at the push service never arrives inside a pause window (§3.6). The partner notices aren't paused, as on Telegram: they answer the partner's action.

### 2.3 What comes back in Settings, and reminders

- **With notifications on in at least one device,** a no-chat account gets back what 6c-1 hid and a notification can honour: the briefings' on/off, hours and days; event alerts, the default alert and pickup reminders; the reminder time; the Shabbat and Yom Tov pause. Voice input, the voice briefing, the weather, the week ahead and the delivery platform stay hidden.
- **The note card** "Briefings and reminders come in Telegram" becomes "Turn on notifications, or connect Telegram, to get reminders and briefings" while no device is on.
- **Reminders:** a no-chat account can make reminders while at least one of its devices is on. A reminder for a partner with no chat needs the partner's notifications on, as one for a partner on Telegram needs their Telegram. Every Telegram gate of reminders and alerts reads one rule, `canReachByPush` (§3.5).
- **The plan gates stay:** reminders and alerts are Pro; a web account has the 14-day Pro trial and pays after it connects Telegram.

### 2.4 Turning it off, and the inverse cases

- **Off in Settings:** unsubscribes this browser and deletes its device at once.
- **Blocked in the browser's settings, or dropped by the browser:** the push service answers "gone" (404 or 410) at the next send, and the device is deleted then.
- **Every app open checks** whether the browser's subscription is this account's. If it isn't (an old account's, on a shared browser), the browser unsubscribes it and the switch shows off. Nothing is added without the tap.
- **Sign out on this device:** the app unsubscribes this browser and deletes its device, then signs out.
- **Sign out on all devices, a suspension, a ban:** every device of the account is deleted in the same write that moves `sessionsValidAfter` (§3.7).
- **Removing a sign-in way:** the same, except the device it was pressed on, which stays.
- **Connect Telegram, or a Join into an account with a chat:** the account has a chat now, so its devices are deleted and Telegram carries everything. Settings shows the chat's cards on the next load.
- **A Join of a no-chat account into another one:** the joined account's devices go with it (they belonged to its sessions, which end with it). The person turns notifications on again, signed in to the account that stays.
- **Deleting the account:** its devices go with it.
- **The plan ends (trial over):** reminders and alerts stop with no notice (Telegram's downgrade notice isn't pushed). Briefings keep coming.

## 3. How it works

### 3.1 The device store

- New table `PushDevice`: `id`, `userId` (cascade), `endpoint` (unique), `p256dh`, `auth`, `createdAt`. One row per browser, at most 10 per account.
- Read and written only in `src/services/web-push/devices.ts`. The writers of §2.4 call it, and a smoke fences the table, as `smoke-signin-setup` fences `SignInIdentity`.
- The endpoint and keys never reach a log, Sentry, the cache or the admin panel.
- Hand-written idempotent migration, dated 20261105 or later.

### 3.2 Routes and page props

- **Page props** (Settings and the home, a no-chat account in a real browser): `push: { key, recentSignIn }`. `key` is the public VAPID key, read at request time and never `NEXT_PUBLIC_`; it is null while push is off. `recentSignIn` is the session's proved-at within the hour. So the tap needs no request before the browser's prompt.
- **`POST /api/push/devices`** (`{ endpoint, keys }`): subscribe this browser.
  - Needs a sign-in from the last hour (`refuseStaleSignIn`), except for an endpoint this account already has.
  - An endpoint held by another account moves to this one: the browser proved it holds it, with a recent sign-in.
  - Refused for an account with a chat.
  - After it, a reply-type notification "Notifications are on" goes to that device.
- **`POST /api/push/devices/check`** (`{ endpoint }`): `{ mine }`. Another account's endpoint and an unknown one get the same answer, so the route tells nothing.
- **`DELETE /api/push/devices`** (`{ endpoint }`): deletes only the caller's own device. It asks for no recent sign-in.
- **Remove a way** (`/api/signin-methods/remove`) gains the caller's endpoint, so its device stays (§2.4).
- **All three routes:** a real browser only (no initData), `refuseCrossSite` and the session (`verifyUserAuth`), 20 a minute per account. Every refusal logs one line with the user id and the reason. `smoke-recent-sign-in` lists the subscribe route as guarded.

### 3.3 Service worker and manifest

- **`public/sw.js`, scope `/`,** served with `Cache-Control: no-cache` (a route handler, as `app/site.css` is, if `public/` can't set the header).
  - It is installed in the tap that turns notifications on, never before. An app open only reads an existing registration.
  - It does three things:
    - shows a push (`showNotification` with title, body, tag, `lang`, `dir`, the icon, and the URL in `data`);
    - on a tap, focuses an open FamCal and navigates it (`clients.matchAll`), else opens one (`openWindow`);
    - takes control at once (`skipWaiting`, `clients.claim`), for iPhone's first launch.
  - No fetch handler and no cache: FamCal's pages work exactly as now.
- **One payload for every browser,** in Apple's declarative format (`web_push: 8030`, `notification: { title, body, navigate, lang, dir, tag, silent }`), so iOS 18.4+ shows it even if the worker was evicted. The worker reads the same JSON everywhere else.
  - The payload is at most 2 KB of plain JSON (Firefox for Android takes about 2.7 KB). The title and body are cut to fit.
  - It is never cached, logged or sent to Sentry.
- **`app/manifest.ts`:**
  - `name` FamCal, `start_url` `/dashboard`, `display: standalone`;
  - the icons (192, 512 and a maskable one, from `icon.png`) and theme colours from the app's tokens;
  - the apple-touch-icon in the page heads.

### 3.4 The sender

- **One module, `src/services/web-push/send.ts`:** `sendWebPush(user, notification)` never throws.
  - It reads the account's devices with one query at send time, which every sending pass can afford (§3.8).
  - It builds each request with the `web-push` library (3.6.7, pinned exact; `generateRequestDetails`, never its `sendNotification`), and sends it through `fetchWithRetry` (`src/utils/fetch-retry.ts`).
  - It returns how many devices took it.
- **One path for every push service:** Google's FCM goes through `fetchWithRetry` too, not the Google policy.
  - CLAUDE.md's Google bullet and its third-party bullet both say so.
  - A retried push that arrives twice replaces itself on the device (same tag).
- **Answers:**
  - any 2xx counts as sent;
  - 404 or 410 deletes the device;
  - 400 and 413 log an error with Sentry (a bug in our payload);
  - 401 or 403 log an error with Sentry, at most once a day per device (the keys don't match; §3.9);
  - 429 and 5xx are retried by the loop, and a give-up logs.
- **The VAPID header** is made once an hour per push service and kept on `globalThis` (Apple asks for no more than one new token an hour).
- **Headers:**
  - `TTL` (§3.6);
  - `Urgency`: high for reminders and alerts, low for the partner's Done, normal for the rest;
  - `Topic`: a SHA-256 of the tag, cut to 32 base64url characters, so a newer push of the same thing replaces one still waiting and the push service sees no FamCal id.
- **Logs:** one line per send, `[push] user <id>: <kind> sent to N of M devices`, with no endpoint, title or payload.
- **Sentry:** `src/lib/sentry-scrub.ts` drops the `endpoint`, `p256dh` and `auth` fields and the push services' URL paths (FCM's, Apple's, Mozilla's, WNS's). `scripts/smoke-sentry-scrub.ts` pins it.
- **The pause smoke:** `scripts/smoke-pause.ts` learns the call (`sendWebPush(`). The module is a transport whose callers ask the pause, as `telegram-adapter.ts` is. The routes' "Notifications are on" is a reply (`NOT_PAUSED`).

### 3.5 Each send

**Reminders** (`native-reminders/pass.ts`):
- A no-chat recipient with a device is pingable. Its ping goes through `sendWebPush` with the tag `nr-<stateId>`.
- A no-chat recipient with no device is claimed without a send, as a paused one is, with one line: `[native reminder ping] skipped user <id>: no chat and no device`. Turning notifications on later doesn't fire that day's earlier reminders (a date-only one stays eligible all day).
- The claim, the attempts and `releaseClaim` on a passing failure stay. A push that no device took is a passing failure only when a device answered 429 or 5xx.
- `pingChatId` and `pingMessageId` stay null for a push.
- `canReachByPush(user)` (no chat, a device on) is the one rule. It needs no extra query: the selects already there gain a `_count` of devices. Every Telegram gate reads it:
  - `getReminderSupport` (support.ts:94, the reason becomes `no_channel`) and `canReceiveReminderPings` (:121);
  - `isPingable` (ownership.ts:106);
  - `resolve.ts:136`'s partner target;
  - `event-store.ts:1156` (editing a reminder to be for the partner);
  - `item-info.ts:97` (the alert hint) and `:320` (`partnerCanRemind`);
  - `pass.ts:213`, `:240` and `:461` (the recipient type, the ping row, `isBlocked`);
  - `actions.ts:127` and `notifyDone`'s select;
  - the admin's `FeatureAccess.tsx:45`.

**Event alerts** (`handlers.ts`, `reminder-cache.ts`, `reminders.ts`):
- The alert cache admits a no-chat account with alerts on and a device. Its entry carries a has-device flag, never the devices. Both the rebuild's filter (`handlers.ts:57`) and `syncReminderCacheEntry` read that admission.
- `handlers.ts:247` stops parsing a missing Telegram id.
- `reminders.ts` pushes in the no-chat branch.
- Each device change re-syncs the account's entry.

**Briefings** (`telegram/summary.ts`):
- For a no-chat account with a device, the pass builds the short line from the day read the summary already makes. There is no Gemini call and no usage counted.
- It sends with the same dedup key, hours, days and pause.
- A day with no items sends nothing and logs one line.

**Invite accepted** (`telegram/pair-handler.ts`): the no-chat branch pushes. It isn't paused, as now.

**The partner's Done** (`native-reminders/actions.ts` `notifyDone`): it pushes only when the other person has no chat. A WhatsApp-only one stays unsent, as now.

**Google reconnect** (`google-sync/worker.ts`): the no-chat branch pushes. The outage is stamped as told only when a device took it (CLAUDE.md's "never marked sent").

**Copy:**
- The texts reuse the keys Telegram's messages already have where they carry no emoji or HTML (`bot.eventAlertWhen.*`, `bot.nativeReminders.ping.from` and `.forBoth`).
- A new `push.*` namespace holds the rest: the briefing line, "Reminder", the invite and Done titles, the reconnect title without its `<b>`.
- It is written natively in he and ru, and is never made by stripping Telegram's HTML.
- Telegram's own texts are unchanged.

### 3.6 Pause and lifetime

- **The pause:** each scheduled push (reminder, alert, briefing, reconnect, trial-ended notice) asks `isPaused` with its send's existing kind before it goes.
- **The lifetime (`TTL`)** is the shorter of the kind's own lifetime and the time to the person's next pause window, so a waiting push expires before the window opens.
- **Lifetimes:**
  - a reminder: 1 hour;
  - an event alert: until the event starts (at most 24 hours, the longest lead);
  - a briefing: 3 hours;
  - the partner notices, the reconnect message and the trial-ended notice: 24 hours.
- **The cap:** no push waits more than 24 hours (a smoke pins it).

### 3.7 When a session ends

- **The writers delete the devices.** The four writers that move `sessionsValidAfter` also delete the account's devices, in the same write:
  - sign out on all devices (`app/api/auth/signout-all`);
  - removing a way (`identities.ts`), keeping the device the caller named;
  - a suspension and a ban (`user-moderation.ts`).
- **Each one also re-syncs the alert cache entry.**
- **What this keeps:** no device outlives the sessions that could see it. The sender needs no session check. The sign-out route stays query-free, because the app deletes this device through `DELETE /api/push/devices` before it signs out.

### 3.8 Neon

- **Idle:** an idle FamCal makes no more database queries than today. Nothing here runs on a timer of its own, and the alert cache carries only a flag.
- **The passes:** the reminder and briefing passes already read the database when they send.
- **Alerts:** a sent alert already writes the database (`incrementUsage`), so reading the devices then adds no wake-up.

### 3.9 Setup and launch

- **Two Railway variables:** `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (the scrubber already hides `…PRIVATE_KEY`). The contact claim is FamCal's own contact address.
- **Hidden until both are set**, as 6b and 6c-1 are:
  - the props' key is null, so there is no card switch and no banner action;
  - the routes answer 503;
  - the senders skip with today's lines;
  - the log says `[startup] Browser notifications are off: VAPID_PUBLIC_KEY is not set`.
- **Setup files:** README rows, `.env.example` placeholders, and `smoke-signin-setup`'s list.
- **The keys are made once** (`npx web-push generate-vapid-keys`) at the owner's setup, with the hosting move if it comes, and are never changed: new keys would cut every device off until each subscribes again. I copy them to the clipboard for Railway, never printed, and the setup artifact gains a section.
- **Cloudflare:** a setup check that it doesn't cache `/sw.js`.
- **Order:** the legal texts (§8) ship with the code. Push stays off until the owner sets the keys, so no device is stored before the Policy says so.

## 4. Testing

Smokes run in the fake env, each one proved by a mutation:

- **The sender:**
  - statuses: 2xx; 404/410 delete; 400/413 and 401/403 once a day; 429/5xx through the loop;
  - the TTL to the pause window and its 24-hour cap;
  - the Topic hash (32 characters, no id), the tag, the payload cap;
  - the VAPID header kept an hour;
  - the log line with no endpoint, and the Sentry scrub.
- **The routes:**
  - a real browser only;
  - the hour for a new endpoint, none for one already the account's;
  - an endpoint moving between accounts;
  - refusal with a chat;
  - `check` giving one answer for unknown and other;
  - DELETE only the caller's;
  - the rate limit.
- **Each send:**
  - pushed with a device;
  - without one, the skip line, and the reminder claimed without a send;
  - the pause and the dedup;
  - an empty day's briefing not sent;
  - the reconnect stamped only when a device took it;
  - the partner's Done only to a no-chat account.
- **The gates:** every one listed in §3.5 accepts a push recipient and still refuses a person with no channel.
- **The session end:** the four writers delete the devices (Remove keeps the caller's) and re-sync the cache.
- **Connect Telegram and the Join:** devices deleted, or gone with the joined account.
- **The alerts pass:** an idle pass makes no query, and a Google event's alert to a push account is sent.
- **The worker:** a payload shown; a tap focusing an open FamCal or opening one.
- **The Settings card and banner (render smokes):** off, on, stale sign-in, a second tap, not answered, blocked, refused, an iPhone or iPad not installed, unsupported.
- **Copy:** every key in en/he/ru, no emoji, the he-neutral and ru-formal guards, Russian's no-break spaces.
- **Fences and pins:**
  - the device table fence;
  - the pause smoke's classification;
  - the legal pins (§8).

## 5. Non-goals

- Notifications for Telegram or WhatsApp accounts (decision 1).
- Done or Snooze buttons on notifications (decision 3).
- An AI-written briefing in a notification, voice, the setup nudges, plan notices.
- Opening a particular day or item from a notification (the home has no deep link).
- Offline pages or caching in the service worker.
- A device list in the admin panel or in Settings.
- The public website's copy ("Reminders … are on Telegram for now"): it stays until web sign-up is announced.

## 6. To check on a device before announcing

- **iPhone, the whole flow:**
  1. Install, and sign in inside the installed app. The email code stays in the app; Telegram and Google sign-ins leave for their pages and must come back signed in.
  2. Turn on, in one tap or two.
  3. Receive each kind; a newer reminder replaces the older one.
  4. A tap opens the home.
- **iPhone, Google Calendar:** connecting it from inside the installed app (its consent opens a new window, which may land in Safari without the session).
- **Android Chrome's timed prompt** (Chrome 155), left unanswered.
- **Cloudflare** serving `/sw.js` fresh.

## 7. Files touched (for the plan)

- **New:**
  - `src/services/web-push/{devices,send,payload}.ts`;
  - `app/api/push/devices/route.ts` and `check/route.ts`;
  - `public/sw.js` (or its route);
  - `app/manifest.ts`;
  - the Settings card and its client;
  - the migration;
  - the smokes.
- **Changed:**
  - the senders and gates in §3.5;
  - the four session writers (§3.7);
  - `telegram-connect.ts` and the Join (delete on gaining a chat);
  - `HomeBanners.tsx`, `SettingsClient.tsx`, page-data;
  - `sentry-scrub.ts`, `startup-checks.ts`;
  - README, `.env.example`, CLAUDE.md (a push bullet, and the retry bullets);
  - `messages/*.json` (`push.*`, `settings.*`, the legal texts);
  - `src/site/legal.ts`.

## 8. Privacy Policy and Terms

These are drafted by the lawyer and an adversarial check, then adjusted to this design: no last-sent date is kept, the worker is installed on the tap, the devices are deleted when sessions end, nothing goes in the cache, and briefings aren't counted. The owner approves them. They ship in all three languages at once, both `LEGAL_UPDATED` dates move to the ship day, and L3's floors rise with them.

Paths are `legal.<doc>.sections.<id>.blocks.N[.M]` in `messages/<lang>.json`. New items are appended to a list's end or inserted inside one; no block goes before an index-based pin, and no new section. Russian takes its no-break spaces in the files (smoke-site-truth T6).

The push services are named like Telegram and Meta: independent services under their own policies, not our processors. The EU/UK ground is our agreement with the person. Security notices stay in the chat or by email, and the sign-in sentences are untouched.

### Privacy Policy

**P1. `keep.blocks.1.6`** (new item, "Your account")
- en: "If you turn on notifications in a browser: for each phone or computer, the address its push service gave that browser for FamCal’s notifications, two keys that encrypt them so only that browser can read them, and when you turned them on there."
- he: "אם מפעילים התראות בדפדפן: לכל טלפון או מחשב, הכתובת ששירות ההתראות (push) של הדפדפן נתן לדפדפן הזה בשביל ההתראות של FamCal, שני מפתחות שמצפינים את ההתראות כך שרק הדפדפן הזה יכול לקרוא אותן, ומתי הפעלתם שם את ההתראות."
- ru: "Если вы включили уведомления в браузере: для каждого телефона или компьютера — адрес, который служба push-уведомлений выдала этому браузеру для FamCal, два ключа, которыми уведомления шифруются так, что прочитать их может только этот браузер, и когда вы включили там уведомления."

**P2. `notKeep.blocks.0.5`** (new item)
- en: "**Notifications in your browser.** We write each one when we send it, and don’t store it. It stays on your device until it’s cleared there, and your device’s settings decide whether it shows on the lock screen."
- he: "**התראות בדפדפן.** אנחנו מנסחים כל התראה ברגע השליחה, ולא שומרים אותה. היא נשארת במכשיר שלכם עד שהיא נמחקת ממנו, וההגדרות של המכשיר קובעות אם היא תוצג גם במסך הנעילה."
- ru: "**Уведомления в браузере.** Мы составляем каждое уведомление в момент отправки и не храним его. Оно остаётся на вашем устройстве, пока его оттуда не уберут. Показывать ли его на экране блокировки, решают настройки устройства."

**P3. `use.blocks.0.0`** (adds "notifications in your browser" after the voice show)
- en: "To run the features you use: your calendar, reminders, briefings and the voice show, notifications in your browser, weather, Hebrew dates and zmanim, the Shabbat and Yom Tov pause, sharing with your partner, and your Google connection."
- he: "כדי להפעיל את התכונות שבהן אתם משתמשים: היומן, התזכורות, הסיכומים והתוכנית הקולית, ההתראות בדפדפן, מזג האוויר, התאריכים העבריים וזמני היום, ההשהיה בשבת ובחג, השיתוף עם בן או בת הזוג, והחיבור ל־Google."
- ru: "Чтобы работали функции, которыми вы пользуетесь: календарь, напоминания, сводки и радиошоу, уведомления в браузере, погода, еврейские даты и зманим, пауза в Шаббат и праздники, общий доступ для партнёра и подключение Google."

**P4. `google.blocks.1.0.items.2`** ("Reading")
- en: "send event alerts on Telegram or in your browser;"
- he: "לשלוח התראות לפני אירועים בטלגרם או בדפדפן;"
- ru: "присылать уведомления о событиях в Telegram или в браузере;"

**P5. `google.blocks.1.3`** ("Sharing", one sentence appended)
- en, appended: "If you turn on notifications in your browser, an event’s title, time and place can be in a notification, encrypted on its way so that only your browser can read it, not the push service that carries it."
- he, appended: "אם מפעילים התראות בדפדפן, הכותרת, השעה והמקום של אירוע יכולים להופיע בהתראה. ההתראה מוצפנת בדרך, כך שרק הדפדפן שלכם יכול לקרוא אותה, ולא שירות ההתראות שמעביר אותה."
- ru, appended: "Если вы включили уведомления в браузере, название, время и место события могут оказаться в уведомлении. Оно передаётся в зашифрованном виде: прочитать его может только ваш браузер, а не служба push-уведомлений, которая его доставляет."

**P6. `processors.blocks.1.14`** (new item at the providers list's end)
- en: "**Your browser’s push service,** if you turn on notifications: the push service your browser uses (its maker picks it, for example Apple’s, Google’s, Mozilla’s or Microsoft’s) delivers FamCal’s notifications to your browser. For each notification, it gets your browser’s notification address, our server’s IP address, and the notification’s time, size and delivery settings, such as how long it may wait. The content is encrypted for your browser, so the push service can’t read it. Which service it is depends on your browser, and it runs under its operator’s own privacy policy."
- he: "**שירות ההתראות (push) של הדפדפן שלכם,** אם מפעילים התראות: את ההתראות של FamCal מעביר לדפדפן שלכם שירות ההתראות שהדפדפן משתמש בו, לפי בחירת החברה שיצרה אותו (למשל השירות של Apple, של Google, של Mozilla או של Microsoft). על כל התראה, השירות מקבל את כתובת ההתראות של הדפדפן שלכם, את כתובת ה־IP של השרת שלנו, ואת השעה, הגודל והגדרות המסירה של ההתראה, כמו כמה זמן היא יכולה לחכות. התוכן מוצפן בשביל הדפדפן שלכם, ולכן שירות ההתראות לא יכול לקרוא אותו. איזה שירות זה תלוי בדפדפן שלכם, והוא פועל לפי מדיניות הפרטיות של החברה שמפעילה אותו."
- ru: "**Служба push-уведомлений вашего браузера,** если вы включили уведомления: уведомления FamCal доставляет в ваш браузер служба, которую выбрал его разработчик (например, служба Apple, Google, Mozilla или Microsoft). О каждом уведомлении она получает адрес уведомлений вашего браузера, IP-адрес нашего сервера, время отправки, размер и параметры доставки, например сколько уведомление может ждать. Содержание зашифровано для вашего браузера, поэтому служба не может его прочитать. Какая это служба, зависит от вашего браузера; она работает по политике конфиденциальности компании, которая ею управляет."

**P7. `processors.blocks.3.3`** ("Where your data goes")
- en: "Telegram, Meta and Google run their own apps under their own privacy policies, and the push service your browser uses runs under its operator’s own."
- he: "טלגרם, Meta ו־Google מפעילות את האפליקציות שלהן לפי מדיניות הפרטיות שלהן, וגם שירות ההתראות שהדפדפן שלכם משתמש בו פועל לפי מדיניות הפרטיות של החברה שמפעילה אותו."
- ru: "Telegram, Meta и Google управляют собственными приложениями по своим политикам конфиденциальности, а служба push-уведомлений, которой пользуется ваш браузер, работает по политике конфиденциальности компании, которая ею управляет."

**P8. `cookies.blocks.1`** (two sentences before "All of these are needed", which stays word for word)
- en: "The web app also saves a few view choices in your browser, such as which tab you were on. If you turn notifications on, it also installs a small FamCal program in your browser (a service worker): it only shows FamCal’s notifications and opens the app when you tap one, and it saves no pages. Your browser then keeps the subscription its push service made for FamCal. All of these are needed for the site and the app to work. We use no ad or tracking cookies."
- he: "אפליקציית הרשת שומרת בדפדפן שלכם גם כמה העדפות תצוגה, כמו הלשונית שבה הייתם. אם מפעילים התראות, היא מתקינה בדפדפן גם תוכנה קטנה של FamCal (service worker), שרק מציגה את ההתראות של FamCal ופותחת את האפליקציה כשמקישים על אחת מהן, ולא שומרת דפים. הדפדפן שומר אז גם את המינוי ששירות ההתראות שלו יצר בשביל FamCal. כל אלה נחוצים כדי שהאתר והאפליקציה יעבדו. אנחנו לא משתמשים בעוגיות פרסום או מעקב."
- ru: "Веб-приложение также сохраняет в вашем браузере несколько настроек вида, например какая вкладка была открыта. Если вы включили уведомления, оно также устанавливает в браузер небольшую программу FamCal (service worker): она только показывает уведомления FamCal и открывает приложение, когда вы нажимаете на уведомление, и не сохраняет страниц. Тогда браузер также хранит подписку, которую его служба push-уведомлений создала для FamCal. Всё это нужно для работы сайта и приложения. Рекламных и отслеживающих cookie мы не используем."

**P9. `retention.blocks.0.9`** (new item)
- en: "**Notifications in your browser:** each device until you turn them off or sign out there; until you sign out on all devices, or remove a way to sign in (the device you remove it on stays); until your account gets a chat (Telegram or WhatsApp), is suspended or banned, or is deleted. If the browser or its push service ends them, we delete the device at the next notification. We keep up to 10 devices: turning on an 11th removes the oldest. A notification waiting at a push service for a device that’s off is dropped there within a day."
- he: "**התראות בדפדפן:** כל מכשיר נשמר עד שמכבים בו את ההתראות או יוצאים בו מהחשבון; עד שיוצאים מהחשבון בכל המכשירים, או מסירים דרך כניסה (המכשיר שבו מסירים אותה נשאר); עד שמחברים לחשבון צ׳אט (טלגרם או וואטסאפ), עד שהחשבון מושעה או נחסם, או עד שהוא נמחק. אם הדפדפן או שירות ההתראות שלו מבטלים את ההתראות, אנחנו מוחקים את המכשיר בהתראה הבאה. אנחנו שומרים עד 10 מכשירים: הפעלה במכשיר ה־11 מוחקת את הוותיק שבהם. התראה שמחכה בשירות ההתראות למכשיר כבוי נמחקת שם תוך יום לכל היותר."
- ru: "**Уведомления в браузере:** каждое устройство — пока вы не выключите на нём уведомления или не выйдете на нём из аккаунта; пока вы не выйдете из аккаунта на всех устройствах или не удалите способ входа (устройство, на котором вы его удаляете, остаётся); пока вы не подключите к аккаунту чат (Telegram или WhatsApp), пока аккаунт не будет приостановлен или заблокирован или пока он не будет удалён. Если браузер или его служба push-уведомлений отменит уведомления, мы удалим устройство при следующем уведомлении. Мы храним не больше 10 устройств: при включении на 11-м самое старое удаляется. Уведомление, которое ждёт выключенное устройство в службе push-уведомлений, удаляется там не позже чем через сутки."

**P10. `rights.blocks.5.1`** (one sentence before "You can also ask us to stop them")
- en, inserted: "To stop notifications in a browser, turn them off in Settings in that browser, or block FamCal’s notifications in your browser’s or device’s settings."
- he, inserted: "כדי להפסיק התראות בדפדפן, מכבים אותן בהגדרות באותו דפדפן, או חוסמים את ההתראות של FamCal בהגדרות של הדפדפן או של המכשיר."
- ru, inserted: "Чтобы прекратить уведомления в браузере, выключите их в «Настройках» в этом браузере или запретите уведомления FamCal в настройках браузера или устройства."

**P11. `rights.blocks.7.0`** (after the pinned "your plan,")
- en: "…your sign-in methods, your plan, the list of devices you get notifications on, your activity log and your feedback;"
- he: "…את דרכי הכניסה, את המסלול, את רשימת המכשירים שבהם הופעלו התראות, את רישום הפעילות ואת המשוב שלכם;"
- ru: "…способы входа, ваш тариф, список устройств, на которые приходят уведомления, журнал действий и отзывы;"

**P12. `rights.blocks.9.5`** (new item in "What stays after that"; the ban item moves to `.9.6`, payments to `.9.7`, and their pins match by text)
- en: "a notification still waiting at a push service for a device that’s off, until it’s delivered or dropped (within a day);"
- he: "התראה שעדיין מחכה בשירות ההתראות למכשיר כבוי, עד שהיא נמסרת או נמחקת (תוך יום לכל היותר);"
- ru: "уведомление, которое ещё ждёт выключенное устройство в службе push-уведомлений, — пока его не доставят или не удалят (не позже чем через сутки);"

**P13. `euUk.blocks.2.0`** (adds "notifications in your browser" after "briefings")
- en: "To run FamCal for you (your account and its sign-in methods, calendar, settings, Google connection, partner sharing, briefings, notifications in your browser, and reading what you send the bot): our agreement with you."
- he: "להפעלת FamCal בשבילכם (החשבון ודרכי הכניסה אליו, היומן, ההגדרות, החיבור ל־Google, השיתוף עם בן או בת הזוג, הסיכומים, ההתראות בדפדפן, וקריאת מה ששולחים לבוט): ההסכם שלנו איתכם."
- ru: "Чтобы FamCal работал для вас (ваш аккаунт и способы входа в него, календарь, настройки, подключение Google, общий доступ для партнёра, сводки, уведомления в браузере и распознавание того, что вы присылаете боту): наш договор с вами."

**P14. `security.blocks.0.5`** (new item)
- en: "Each notification to a browser is encrypted for that browser alone, so the push service that carries it can’t read it."
- he: "כל התראה לדפדפן מוצפנת בשביל הדפדפן הזה בלבד, כך ששירות ההתראות שמעביר אותה לא יכול לקרוא אותה."
- ru: "Каждое уведомление в браузер шифруется только для этого браузера, поэтому служба push-уведомлений, которая его доставляет, не может его прочитать."

**P15. `euUk.blocks.4`** ("Transfers", one sentence appended; we have no terms with the push services)
- en, appended: "A notification reaches your browser’s push service, wherever it is, because you turned notifications on, so that it can be delivered to you."
- he, appended: "התראה מגיעה לשירות ההתראות של הדפדפן שלכם, בכל מדינה שבה הוא נמצא, כי הפעלתם התראות, וכדי שתגיע אליכם."
- ru, appended: "Уведомление попадает в службу push-уведомлений вашего браузера, в какой бы стране она ни находилась, потому что вы включили уведомления, — чтобы его можно было вам доставить."

Left as they are: `who`, `required` ("Everything else is up to you" covers an optional feature), the sign-in sentences (`keep.blocks.1.3` and its after-line), the logs (`keep.blocks.19`), `processors.blocks.3.1` and `.5.0`, `changes`.

### Terms

**T1. `service.blocks.4.0`** (under "For now, some features work only on Telegram:")
- en: "reminders and event alerts (an account made on famcal.bot can get them as notifications in the browser until it connects Telegram);"
- he: "תזכורות והתראות לפני אירועים (חשבון שנפתח ב־famcal.bot יכול לקבל אותן כהתראות בדפדפן, עד שמחברים אליו את טלגרם);"
- ru: "напоминания и уведомления о событиях (аккаунт, созданный на famcal.bot, может получать их в браузере, пока к нему не подключён Telegram);"

**T2. `service.blocks.5`** (the last sentence replaced; a pin change, with the old sentence added to `GONE_SIGNUP`)
- en, replacing "Briefings and reminders reach you once you connect Telegram in Settings.": "Reminders, event alerts and a short notification that lists the day’s events reach you on each phone or computer where you turn notifications on (on iPhone and iPad, after you add FamCal to the Home Screen). Once you connect Telegram, they come in Telegram instead, and the notifications stop."
- he, replacing "סיכומים ותזכורות מגיעים אליכם אחרי שמחברים את טלגרם בהגדרות.": "תזכורות, התראות לפני אירועים והתראה קצרה עם רשימת האירועים של היום מגיעות אליכם בכל טלפון או מחשב שבו מפעילים התראות (באייפון ובאייפד, אחרי שמוסיפים את FamCal למסך הבית). אחרי שמחברים את טלגרם, הן מגיעות בטלגרם, וההתראות בדפדפן נפסקות."
- ru, replacing "Сводки и напоминания начнут приходить, когда вы подключите Telegram в «Настройках».": "Напоминания, уведомления о событиях и краткое уведомление со списком событий дня приходят на каждый телефон или компьютер, где вы включили уведомления (на iPhone и iPad — после того как вы добавите FamCal на экран «Домой»). Когда вы подключите Telegram, они начнут приходить в Telegram, а уведомления в браузере прекратятся."

**T3. `delivery.blocks.0`**
- en: "A reminder or a briefing can arrive late, or not at all, for example when Telegram, WhatsApp, your browser’s push service or one of our providers has a problem, or when your device is off or blocks notifications. A notification waiting for a device that’s off is dropped after a while (within a day) and isn’t sent again."
- he: "תזכורת או סיכום יכולים להגיע באיחור, או לא להגיע בכלל, למשל כשיש תקלה בטלגרם, בוואטסאפ, בשירות ההתראות של הדפדפן או אצל אחד הספקים שלנו, או כשהמכשיר כבוי או חוסם התראות. התראה שמחכה למכשיר כבוי נמחקת אחרי זמן מה (תוך יום לכל היותר), ולא נשלחת שוב."
- ru: "Напоминание или сводка могут прийти с опозданием или не прийти вовсе, например если у Telegram, WhatsApp, службы push-уведомлений вашего браузера или одного из наших поставщиков возникла проблема, а также если ваше устройство выключено или уведомления на нём запрещены. Уведомление, которое ждёт выключенное устройство, через некоторое время (не позже чем через сутки) удаляется и повторно не отправляется."

**T4. `account.blocks.0.5`** (new item)
- en: "Notifications show your reminders’ and events’ titles, times and places on each device where you turn them on and, depending on its settings, on its lock screen. Anyone who can see that device can read them, so turn them off on a device others use."
- he: "התראות מציגות את הכותרות, השעות והמקומות של התזכורות והאירועים שלכם בכל מכשיר שבו הפעלתם אותן, ולפי ההגדרות של המכשיר גם במסך הנעילה. כל מי שרואה את המכשיר יכול לקרוא אותן, ולכן כדאי לכבות אותן במכשיר שגם אחרים משתמשים בו."
- ru: "Уведомления показывают названия, время и место ваших напоминаний и событий на каждом устройстве, где вы их включили, а в зависимости от его настроек — и на экране блокировки. Их может прочитать любой, кто видит это устройство, поэтому на устройстве, которым пользуются и другие, их лучше выключить."

**T5. `liability.blocks.3`**
- en: "Telegram, WhatsApp, Google, your browser’s push service and our providers run their own services under their own terms, and we aren’t responsible for them."
- he: "טלגרם, וואטסאפ, Google, שירות ההתראות של הדפדפן שלכם והספקים שלנו מפעילים את השירותים שלהם לפי התנאים שלהם, ואנחנו לא אחראים להם."
- ru: "Telegram, WhatsApp, Google, служба push-уведомлений вашего браузера и наши поставщики управляют своими сервисами на собственных условиях, и мы за них не отвечаем."

Left as they are: `service.blocks.3` (true for the other items and for WhatsApp), `plans.*` (paying stays in Telegram; reminders stay Pro), `delivery.blocks.1` (the pause: a waiting push expires before the window), `delivery.blocks.2`, `suspension.*`, `eligibility.blocks.0`.
