# FamCal

> An AI family-calendar assistant that lives in your chat app — morning and evening briefings, voice-note and photo event capture, and shared couple calendars, across Telegram and WhatsApp.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js%2016-000?style=flat-square&logo=next.js&logoColor=white)
![React](https://img.shields.io/badge/React%2019-20232A?style=flat-square&logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node%2022-339933?style=flat-square&logo=node.js&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-2D3748?style=flat-square&logo=prisma&logoColor=white)
![Postgres](https://img.shields.io/badge/Neon%20Postgres-336791?style=flat-square&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Upstash%20Redis-DC382D?style=flat-square&logo=redis&logoColor=white)
![Railway](https://img.shields.io/badge/Railway-0B0D0E?style=flat-square&logo=railway&logoColor=white)
[![demo · live](https://img.shields.io/badge/demo-live-2ea44f?style=flat-square)](https://famcal.bot)

**🔗 Live demo:** https://famcal.bot  <!-- the public site is reachable directly; the personal dashboard (settings, calendars, pairing) opens from inside the bot, or at famcal.bot/signin for an existing account (Telegram, Google or an email code); the admin panel opens only inside Telegram -->

FamCal is a multi-platform, multilingual calendar assistant for individuals and families. Use the built-in FamCal calendar, optionally connect Google Calendar too, and the bot writes personalized morning and evening briefings, week-ahead previews, weather, and reminders — and turns voice notes and photos of invitations into calendar events. It runs as one persistent Node process on Railway, and every AI call goes through a single provider layer on Google Gemini.

<!-- Screenshot placeholder: leave exactly this HTML comment so the owner can drop an image in later:
     ![screenshot](docs/screenshot.png) -->

## ✨ Features

- **AI daily briefings** — natural-language morning summaries and optional evening "tomorrow" previews, personalized per user with time-of-day greetings, conflict warnings, and grouped drop-off/pickup times.
- **Week-ahead and next-week previews** — culture-aware week boundaries (e.g., Sunday-start weeks) rendered as AI prose on demand.
- **Voice-note to event** — send a voice message; Gemini transcribes and parses it into a structured event, with confidence-gated auto-create and quick inline corrections.
- **Photo-to-event** — forward or snap a photo of an invitation or flyer and the bot extracts the event details into your calendar.
- **Natural voice replies** — optional spoken summaries via Gemini TTS in the user's language, with selectable voices and styles.
- **FamCal calendar, with Google as an optional connection** — everyone has the built-in recurring FamCal calendar; connect Google and its calendars appear beside the FamCal ones. Move an event between FamCal and Google from its Calendar row (whole series only). Copy any FamCal calendar you own to Google as its own "FamCal · <name>" calendar, kept up to date one way.
- **Couple pairing** — invite a partner to share calendars, with an auditable pairing lifecycle.
- **Multilingual** — Hebrew, English, and Russian throughout, including a right-to-left dashboard, Hebrew dates/holidays (Hebcal), and localized voice.
- **Weather in context** — MET Norway forecasts woven into the daily briefing, with Copernicus dust-storm and regional heatwave (sharav) awareness.
- **Event reminders** — pre-event nudges that respect each event's own reminder settings, including separate start and pickup reminders for kids' events.
- **Zmanim** — a reminder's time can be a zman plus an offset ("10 min before sof zman Shema (GRA)"), worked out daily at each person's own place, in the Sephardi (Zmanei Yosef), Ashkenazi or Chabad set; one switch pauses every scheduled message on Shabbat and Yom Tov. The bot makes the same reminder from a voice note or typed text ("remind me 10 minutes before sof zman Shema"); when the zman has several opinions in the person's set and none was said, the card offers a button per opinion with its time. For the Jewish calendar, a sun button in the home's header opens the day's zmanim at the person's place (with candle lighting and the end of Shabbat or Yom Tov on their days, and the halachic hour), a day at a time.
- **Subscriptions and usage limits** — trials, plans, and usage counters billed in-app through Telegram Stars; one month per payment, never renewing by itself; every payment kept with its Telegram charge id, so an admin can refund any of the last 14 days from the admin panel.
- **Public website** — famcal.bot in Hebrew, English and Russian, in the app's own look (light and dark follow the device): the landing shows the bot's confirm card and the calendar home's real Agenda with a sample family, plus the plans (read from the plan table), the blog, Privacy and Terms. It has its own root layout (`app/[locale]/(site)`): static pages, no Telegram SDK, one cached style sheet built from the app's colour tokens (`components/app-ui/tokens.ts`).
- **Public zmanim pages** — `famcal.bot/zmanim` and a page per city (135 cities, 51 of them in Israel) in Hebrew, English and Russian, with no account: the day's zmanim by Sephardi, Ashkenazi or Chabad custom, the coming Shabbat and Yom Tov times, and the month with Hebrew dates, holidays and the parasha (two-day Yom Tov abroad). Each page is computed when it is opened, by the bot's own zmanim code (`zmanDayForPlace`), with no database and no call to anyone; the day and the custom travel in the URL. "Near me" finds the nearest listed city in the browser, and the position never leaves it. The proxy allows one address 60 city pages a minute (`src/lib/page-limit.ts`), so a scraper can't slow the bot that shares the process.
- **Web dashboard** — the Mini App's pages (`app/[locale]/(app)`, their own root layout with the Telegram SDK) for settings, calendar selection, pairing, and an admin panel with moderation, a persistent blocklist, and analytics. Outside Telegram, a person signs in at famcal.bot/signin with Telegram, Google or an email code (see [Web sign-in](#web-sign-in)), and a new person can create an account there and use FamCal in the browser with no messenger (see [Web sign-up](#web-sign-up)), and gets its reminders and briefings there as browser notifications (see [Notifications in the browser](#notifications-in-the-browser)); the admin panel stays in Telegram.

## 🏗️ How it works

**One AI interface.** `src/services/ai-provider.ts` puts every text call behind a single `generateAICompletion` call. Every call runs on one model, Gemini 3.8 Flash, fixed in a typed model registry (`src/config/ai-models.ts`), so changing the model is a one-line code change. The layer adds its own retry/backoff (SDK retries are disabled in favor of explicit control), 25-second client timeouts, token accounting (including cache and thinking tokens), and admin alerting when a response hits its output-token ceiling.

**Streaming UX.** User-invoked summaries use a sibling streaming path (`src/services/streaming/text-stream.ts`) that emits text deltas as the model writes, which the Telegram adapter renders as an animated, progressively-updating message draft with live HTML tag-balancing so partial markup never breaks Telegram's parser. Because a partial stream can't be safely retried mid-flight, the streaming path deliberately drops the retry wrapper and callers fall back to the buffered path on failure.

**Adapter/factory messaging.** `src/services/messaging/` defines an `IMessagingService` interface implemented by a `TelegramAdapter` and a `WhatsAppAdapter`, created through a small factory with per-platform singletons. Platform detection routes inbound webhooks and enables cross-platform notifications, so the summary, reminder, and event-capture logic is written once against the interface rather than per channel.

**A calendar model that stands on its own.** The Prisma schema (~370 lines) models a native recurring calendar with RFC-5545 `RRULE` strings, per-instance overrides and cancellations, and series-level exdates; `src/services/native-calendar/recurrence.ts` expands series into virtual instances for any date range using `rrule`. The same schema carries couple pairing with invites and status history, subscriptions/trials/usage counters, and a blocklist that persists across account deletion for moderation.

**Delivery correctness.** Scheduled jobs (daily and tomorrow summaries, reminders) run in-process on node-cron, and Upstash Redis dedup keys and locks keep a retried or duplicated run from double-sending, with Upstash rate limiting on hot paths. Auth spans the Mini App's signed init data, one session cookie for every web sign-in (the WhatsApp link, Telegram and Google through OpenID Connect, email codes), webhook secret validation, and a `CRON_SECRET` guarding internal endpoints. Every call to Google goes through one retry policy (`src/services/google-retry.ts`): a rate limit, a timeout or a 5xx is retried with jittered backoff and Google's `Retry-After`, and a create is never repeated on a failure that may have gone through. Errors flow to Sentry and to admin alerts. Voice replies and the two-host voice show are synthesized in-process with Gemini TTS and encoded from PCM to OGG/Opus.

**City data, built once.** `src/site/cities.ts` holds each city's GeoNames id, coordinates and IANA zone (from [GeoNames](https://www.geonames.org/), CC BY 4.0), and for an Israeli city its height. `scripts/build-city-heights.ts` makes the heights on a developer machine, once (`npx tsx scripts/build-city-heights.ts`): for each Israeli city it asks OpenStreetMap's Nominatim for the town's outline (one request a second; © OpenStreetMap contributors, ODbL), runs the bot's own `elevationGrid` over it (`src/services/zmanim/elevation-grid.ts`), reads the 25 heights from the Copernicus DEM GLO-90 tiles in AWS's public bucket (produced using Copernicus WorldDEM™-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved) and keeps the highest. The values are committed: nothing reads these sources at runtime or in CI, and the zmanim pages credit all three.

## 🛠️ Tech stack

- **Frontend:** Next.js 16 (App Router), React 19, Tailwind CSS v4, next-intl (he/en/ru, RTL), lucide-react, MDX blog, Satori + resvg for generated share/weather images.
- **Backend/API:** TypeScript on Node 22, Next.js route handlers, node-telegram-bot-api, WhatsApp Business Cloud API, node-cron.
- **Data:** Prisma ORM, Neon Postgres, Upstash Redis (distributed locks, caching, rate limiting).
- **AI:** Google Gemini behind a unified provider layer, for text, voice transcription, photo parsing, and TTS.
- **Integrations:** Google Calendar API, Web Push (the `web-push` library, VAPID: browser notifications), MET Norway (forecast), Copernicus CAMS via Open-Meteo's open data on S3 (dust; read with `@openmeteo/file-reader`, GPL-2.0, server only), `geo-tz` (time zones, © OpenStreetMap contributors, ODbL), the Copernicus DEM GLO-90 (heights in Israel, `data/israel-heights-3s.i16.br`, rebuilt with `scripts/build-israel-heights.ts`), Hebcal (Hebrew dates/holidays, zmanim), `rrule` (RFC-5545 recurrence); GeoNames, OpenStreetMap and Copernicus DEM for the public pages' city table (built once, never called at runtime).
- **Infra:** Railway hosting, node-cron for scheduled work, Sentry monitoring.

## 🚀 Getting started

### Prerequisites

- Node.js 22.x
- A PostgreSQL database (Neon recommended; the schema uses `DATABASE_URL` + `DIRECT_URL`)
- An Upstash Redis instance
- A Telegram bot token (via BotFather); WhatsApp Business API credentials are optional
- Google OAuth credentials for Google Calendar access
- A Gemini API key (the text and voice models are both Gemini)

### Environment variables

Copy `.env.example` (production) or `.env.local.example` (local dev) and fill in your own values. Names only — never commit real secrets.

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Telegram bot auth and webhook verification |
| `TELEGRAM_BOT_USERNAME`, `WHATSAPP_PHONE_NUMBER` | The bot's username and the WhatsApp number (digits only) behind the t.me and wa.me links, such as the Google connect finish buttons; unset, they fall back to the public bot and number in `src/lib/gate-links.ts` |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | WhatsApp Business Cloud API (optional) |
| `WHATSAPP_APP_SECRET` | Required. The Meta app secret, which verifies WhatsApp webhook signatures (`X-Hub-Signature-256`); unset, every WhatsApp webhook is refused (500) and production startup logs an error |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar OAuth (the connect client; web sign-in has its own, below) |
| `TELEGRAM_LOGIN_CLIENT_ID`, `TELEGRAM_LOGIN_CLIENT_SECRET` | Optional. Telegram sign-in on famcal.bot (OpenID Connect): the Client ID and Client Secret from @BotFather → the bot → Login Widget (the secret is not the bot token); unset, the Telegram way is hidden and production startup logs a warning |
| `GOOGLE_SIGNIN_CLIENT_ID`, `GOOGLE_SIGNIN_CLIENT_SECRET` | Optional. Google sign-in on famcal.bot: a Web client of its own in the Calendar's Google Cloud project, never `GOOGLE_CLIENT_ID`'s, with the redirect URI `https://famcal.bot/api/auth/google/callback`; unset, or the Calendar client's, the Google way is hidden and production startup logs a warning |
| `GEMINI_API_KEY` | Gemini API key for text and voice |
| `AI_MAX_TOKENS`, `AI_MAX_RETRIES` | Optional output-token and retry overrides |
| `DATABASE_URL`, `DIRECT_URL` | Postgres connection (pooled + direct for migrations) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Redis for locks, caching, rate limiting |
| `RESEND_API_KEY` | Optional. Resend's API key for the email sign-in codes (from `FamCal <signin@famcal.bot>`, replies to `privacy@famcal.bot`); unset, email sign-in is not offered, its routes answer 503 and production startup logs a warning |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | Optional. Cloudflare Turnstile on the email-code form (Cloudflare → Turnstile → widget "FamCal sign-in", hostname `famcal.bot`, Managed): the site key reaches the page at request time (never at build), the secret checks each code request with Cloudflare. With both set every code request needs a pass, and an address with no account gets a sign-up code; unset, email sign-up is off, email sign-in works as before and production startup logs a warning |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Optional. The key pair that signs FamCal's browser notifications (VAPID), made once with `npx web-push generate-vapid-keys` and never changed: new keys cut every device off until each turns notifications on again. The public key reaches the page at request time (never at build); the private key stays on the server. Unset, browser notifications are off (no switch or banner action, the push routes answer 503, the senders skip) and production startup logs a warning |
| `CRON_SECRET` | Shared secret guarding internal cron/usage endpoints |
| `SESSION_SECRET` | Required, no fallback: its own random value (`openssl rand -hex 32`), never `CRON_SECRET`'s. The web session cookie (every web sign-in), the sign-in hashes (email codes, limit counters, the calendar accounts' keys) and the share-story image links use keys derived from it; unset, they are refused and production startup logs an error. Changing it signs every web user out once, and the next boot re-keys the calendar accounts (one Google call each) |
| `ENCRYPTION_KEY` | Encrypts the stored Google tokens: 64 hex characters (`openssl rand -hex 32`). See [Rotating `ENCRYPTION_KEY`](#rotating-encryption_key) |
| `ENCRYPTION_KEY_PREVIOUS` | Optional and decrypt-only: the old `ENCRYPTION_KEY` while a rotation runs; delete it once the key sweep logs SAFE |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Error reports only (`src/lib/sentry-errors-only.ts`: no traces, sessions or replays) |
| `NODE_ENV` | Runtime environment |

The models are not configurable: text and TTS are fixed in `src/config/ai-models.ts` and `src/config/tts-models.ts`, and the voices per language in `src/services/voice-generator.ts`.

### Rotating `ENCRYPTION_KEY`

`ENCRYPTION_KEY` encrypts every stored Google token. **Never replace `ENCRYPTION_KEY` without setting `ENCRYPTION_KEY_PREVIOUS` to the old value in the same deploy.** Without it, every Google-connected user counts as not connected until the old key is back.

Before rotating, the previous deploy's `[key-sweep] baseline:` line must show `unreadable=0` for users and links. A token that neither key opens blocks SAFE for good; find out why first (the ids are in the `[key-sweep] N stored tokens decrypt with neither key (ids only)` line logged right after the baseline, and in the admin alert).

1. Generate the new key with `openssl rand -hex 32`.
2. In one deploy, set `ENCRYPTION_KEY_PREVIOUS` to the current key and `ENCRYPTION_KEY` to the new one. The startup log prints both fingerprints (`[startup] ENCRYPTION_KEY fp …; ENCRYPTION_KEY_PREVIOUS fp …`). The PREVIOUS fingerprint must equal the `ENCRYPTION_KEY` fingerprint the deploy before printed.
3. The key sweep (`src/services/key-rotation.ts`) runs every 10 minutes and is idle for the first 10 minutes of uptime. It logs a `[key-sweep] baseline:` line first. Then it re-encrypts every stored token under the new key with compare-and-set writes and rebuilds the reminder cache.
4. Once nothing needs the old key, after at least 30 minutes of uptime, it logs this line once per process and tells the admins on Telegram once:

   `[key-sweep] SAFE: every stored token is under ENCRYPTION_KEY (fp XXXXXXXX); nothing needs ENCRYPTION_KEY_PREVIOUS. You can remove it at the next deploy.`

5. Delete `ENCRYPTION_KEY_PREVIOUS` at a later deploy. If it is removed before SAFE, the tokens not yet converted can't be read; put it back and they read again.

To roll back, swap the two values: the sweep converts back. The sweep stops reading the database until the next deploy once SAFE is logged, or, with no `ENCRYPTION_KEY_PREVIOUS`, once nothing is left to encrypt. That way Neon can still scale to zero.

### Web sign-in

An existing account signs in on famcal.bot at `/signin` with Telegram, Google or a 6-digit email code, and gets the same web app as the Mini App (spec `docs/superpowers/specs/2026-11-02-web-sign-in-design.md`). A person who started FamCal in Telegram or WhatsApp adds Google or an email address under Settings → Sign in on the web; a new person creates an account on the web (see [Web sign-up](#web-sign-up)). The Google account a person's Google Calendar is connected from signs in without being added, once it is on: a connection made from now on is on at connect, and one made before this (or keyed under another `SESSION_SECRET`) is on after its owner presses Turn on in Settings → Sign in on the web (nothing keys connections at startup). FamCal keeps a keyed hash of its address (never the address) and confirms it live with Google at sign-in.

- **Telegram:** OpenID Connect through `openid-client`; the account is found by the token's Telegram `id`, never its `sub`.
- **Google:** a Web client of its own (`openid email`); the account is found by Google's `sub`, never by the address.
- **Email:** a code mailed through Resend from `FamCal <signin@famcal.bot>` to the address stored on the account, with limits per address, per IP and per day in Upstash.

Every way, the WhatsApp link too, ends in `finishSignIn` (`src/lib/web-session.ts`), which refuses a suspended or banned account and sets `__Host-famcal_session`: 30 days, renewed by `/api/page-data` while the web app is used; a WhatsApp link's session lasts 24 hours and is never renewed. Sign out on all devices, removing a way, a suspension and a ban end every session by moving `User.sessionsValidAfter`. Each way stays hidden until its variables are set, and production startup logs `[startup] web sign-in with … is off` for each one that isn't.

One-time setup:

1. **Telegram:** @BotFather → the bot → Login Widget → Switch to OpenID Connect Login; redirect URI `https://famcal.bot/api/auth/telegram/callback`, trusted origin `https://famcal.bot`. Its Client ID and Client Secret go in `TELEGRAM_LOGIN_CLIENT_ID` and `TELEGRAM_LOGIN_CLIENT_SECRET`.
2. **Google:** Google Auth Platform (the Calendar's project) → Clients → Create client → Web application "FamCal sign-in", redirect URI `https://famcal.bot/api/auth/google/callback`. Its ID and secret go in `GOOGLE_SIGNIN_CLIENT_ID` and `GOOGLE_SIGNIN_CLIENT_SECRET`; never the Calendar client's.
3. **Resend:** add the domain `famcal.bot` in region eu-west-1 and let it write its records to Cloudflare (`send.famcal.bot` MX and SPF, `resend._domainkey` DKIM). The apex MX and SPF stay Cloudflare Email Routing's, so mail to privacy@famcal.bot keeps arriving, and Resend's Receiving stays off. An API key with sending access to famcal.bot goes in `RESEND_API_KEY`.

### Web sign-up

A new person creates a FamCal account on famcal.bot with Google or an email code and uses it in any browser, with no Telegram and no WhatsApp (spec `docs/superpowers/specs/2026-11-03-web-sign-up-design.md`). Sign-up is the end of a sign-in that found no account: the proved identity waits 10 minutes in a one-time `signup` record behind `famcal_signin`, and `/signup` takes a name and the consent (18 or older, the Terms and the Privacy Policy). The account is made by `createAccount` (`src/services/user-service.ts`), the same step /start and a first WhatsApp message use: the ban check, the user and its way in one transaction, the first FamCal calendar.

- **Email:** with `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` set, every code request needs Cloudflare Turnstile's pass, and an address on no account gets a sign-up code (30 a UTC day inside the 90 codes, 3 a day per IP address). Without them email sign-up is off and email sign-in works as before.
- **Google:** a Google account that no account holds in any way (no Google way with its `sub`, no calendar key for its address) is offered sign-up, while `RESEND_API_KEY` is set too: a browser-only account's security notices go only by email. Without it Google signs in as before and a Google account with no FamCal gets the no-account page.
- **Where it shows:** /signin's "new people can create an account" lines, the start buttons' **Use in the browser** (the landing, a blog post's end, a zmanim city page), the invite page's "Sign in or create an account to accept" (else "Sign in to accept") and /signup itself (else it goes to /signin; its "start again" line names only the open ways) show only while a way is open (`openSignUpWays`, `src/services/web-signin/signup-open.ts`, the one condition the Google callback reads too). The landing and the blog posts are built static, so they follow a variable change on the redeploy it brings; the zmanim city pages and /signin read it per request.
- **Stopped or warned:** a proved address that already signs in another way gets that way's guidance and no form (`findWayByAddress`); the sign-up page warns a Telegram or WhatsApp user not to make a second account.
- **Limits:** 5 new accounts a day per IPv4 address or IPv6 /48; security notices by email have their own 10 a day.
- **No chat:** a browser-only account sees nothing that needs a chat. **Connect Telegram** (a one-time `w_` bot link, 10 minutes, made within an hour of signing in: the cookie's proved-at, which a renewal or a Remove carries over and never restarts) writes the Telegram id onto it. An accidental second account is joined into the first only after Add Google or Add email proves its way (`mergePlan`, one rule set for the question and the merge). The Google Calendar finish page offers **Finish here** to the session of the account that started the consent.

One-time setup: Cloudflare → Turnstile → Add widget "FamCal sign-in", hostname `famcal.bot`, widget mode Managed, pre-clearance off; its site key goes in `TURNSTILE_SITE_KEY` and its secret key in `TURNSTILE_SECRET`. Production startup logs `[startup] web sign-up with an email code is off` until both are set, and `web sign-up with Google is off` until `RESEND_API_KEY` is. Run 6b's `x-real-ip` probe before announcing sign-up: the per-address limits count by that header. Also before announcing: a family whose Google Calendar was connected before 6b has no `googleAccountKey`, so "Continue with Google" offers them sign-up (with the second-account warning) until they press **Turn on** in Settings; ask them to press it once.

### Notifications in the browser

An account made on famcal.bot with no Telegram and no WhatsApp gets its reminders, event alerts, a short morning and evening line listing the day, and the partner notices as web push notifications on each phone or computer where it turned them on (spec `docs/superpowers/specs/2026-11-05-web-push-design.md`). Telegram and WhatsApp accounts change nothing, so nobody is notified twice: an account that connects a chat has its devices deleted and gets everything in the chat.

- **Turning on:** Settings → Notifications on this device, or the home banner's **Turn on**, in a real browser (never inside Telegram) and within an hour of signing in. The first tap installs `/sw.js` (`public/sw.js`: it shows a notification and opens the app when one is tapped, with no fetch handler and no cache), asks the browser's permission and stores the browser's subscription as one `PushDevice` row: at most 10 an account, an 11th replaces the oldest. iPhone and iPad need FamCal added to the Home Screen first (iOS 16.4 or later); the card shows the steps.
- **Sending:** every notification goes through `sendWebPush` (`src/services/web-push/send.ts`), which builds the request with the `web-push` library and sends it through the third-party retry loop. A payload is Apple's declarative format, at most 2 KB, encrypted for the one browser. Reminders and event alerts are Pro; the briefing line is built from the day's items (no AI) and isn't counted against the plan's briefings. The Shabbat and Yom Tov pause holds the scheduled ones, and a notification waiting at the push service expires before the next pause window and within 24 hours.
- **Ending a device:** turning it off in Settings, signing out on that device, the push service answering 404 or 410, Sign out on all devices, removing a sign-in way (the device it was pressed on stays), a suspension, a ban, and the account getting a chat all delete it.

One-time setup:

1. Make the key pair once: `npx web-push generate-vapid-keys`.
2. Put the public key in `VAPID_PUBLIC_KEY` and the private key in `VAPID_PRIVATE_KEY` on Railway. The contact claim is `mailto:privacy@famcal.bot` (`vapidSubject`, `src/services/web-push/config.ts`). Until both are set the feature is hidden: no switch or banner action, the push routes answer 503, the senders skip, and production startup logs `[startup] Browser notifications are off: …` naming the unset variable.
3. Never change the keys, also across a hosting move: new keys cut every device off until each turns notifications on again.
4. Cloudflare must not cache `/sw.js`. After the deploy, `curl -sI https://famcal.bot/sw.js` shows `cache-control: no-cache, no-store, must-revalidate` and a `cf-cache-status` of `DYNAMIC` or `BYPASS`, never `HIT`.

Before announcing it, check on real devices (spec §6): on an iPhone, installing FamCal, signing in inside the installed app, turning notifications on, receiving each kind (a newer reminder replaces the older one) and a tap opening the home, and connecting Google Calendar from the installed app; on Android Chrome, the permission prompt left unanswered.

### Install & run

```bash
# install dependencies
npm install

# local development: runs the Next.js app and the bot in polling mode together
npm run dev

# (optional) the Next.js dashboard only
npm run dev:next

# type-check
npm run type-check

# CI (GitHub Actions) runs type-check, lint, the smoke tests and `next build` on every push;
# run the smokes locally with fake env:
bash scripts/ci-smokes.sh

# production build (generates Prisma client, applies migrations, builds Next.js)
npm run build
npm run start
```

Helper scripts handle one-time setup: `npm run get-google-token` (obtain a Google refresh token) and `npm run setup-webhook` (register the Telegram webhook).

Dev-only data scripts: `scripts/build-israel-heights.ts` (the height map), `scripts/build-city-heights.ts` (the public cities), `scripts/record-cams-fixture.ts` (the dust smoke's recording); none runs in CI. MET Norway and the dust data need no env var.

## 📦 Deployment

Deployed on Railway as one persistent Next.js (Node) process, with zero-downtime deploys. `npm run build` runs `prisma generate && prisma migrate deploy && next build`, so database migrations are applied on each deploy. Scheduled work (daily/tomorrow summaries, reminders, setup reminders, the Google copy worker, a nightly health check, the encryption-key sweep) runs in-process on node-cron, started from `instrumentation.ts` into `src/cron/scheduler.ts` (the job logic is in `src/cron/handlers.ts`); the health check and the key sweep run only on the schedule; every other job also has an API endpoint for manual runs, guarded by `CRON_SECRET` sent as `Authorization: Bearer <CRON_SECRET>` (a `?secret=` query is refused). Cron times are UTC (node-cron follows the server process's zone, which the startup log names) except the setup-reminder nudge, which keeps 10:00 Israel time summer and winter (an hourly UTC job that acts when Israel's hour is 10; node-cron's own `timezone` option skips the day the clocks spring forward). Local wall times become instants in one function, `src/utils/wall-time.ts`: a time the clocks skip moves forward by the jump, a repeated one is its first occurrence, whatever zone the server runs in.

## 📄 License

MIT for FamCal's own code — shared publicly as a portfolio project. The third-party data listed in [NOTICE](NOTICE) (the height map, the city table and two test recordings) keeps its own licence and is not under MIT.
