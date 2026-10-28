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

**🔗 Live demo:** https://famcal.bot  <!-- the public site is reachable directly; the personal dashboard (settings, calendars, pairing, admin) opens from inside the bot via a magic link, so most in-app screens are reached by chatting with the Telegram bot first -->

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
- **Weather in context** — Open-Meteo forecasts woven into the daily briefing, with air-quality and regional dust-storm (Sharav) awareness.
- **Event reminders** — pre-event nudges that respect each event's own reminder settings, including separate start and pickup reminders for kids' events.
- **Zmanim** — a reminder's time can be a zman plus an offset ("10 min before sof zman Shema (GRA)"), worked out daily at each person's own place, in the Sephardi (Zmanei Yosef), Ashkenazi or Chabad set; one switch pauses every scheduled message on Shabbat and Yom Tov. For the Jewish calendar, a sun button in the home's header opens the day's zmanim at the person's place (with candle lighting and the end of Shabbat or Yom Tov on their days, and the halachic hour), a day at a time.
- **Subscriptions and usage limits** — trials, plans, and usage counters billed in-app through Telegram Stars.
- **Web dashboard** — Next.js app for settings, calendar selection, pairing, a blog, and an admin panel with moderation, a persistent blocklist, and analytics.

## 🏗️ How it works

**One AI interface.** `src/services/ai-provider.ts` puts every text call behind a single `generateAICompletion` call. Every call runs on one model, Gemini 3.8 Flash, fixed in a typed model registry (`src/config/ai-models.ts`), so changing the model is a one-line code change. The layer adds its own retry/backoff (SDK retries are disabled in favor of explicit control), 25-second client timeouts, token accounting (including cache and thinking tokens), and admin alerting when a response hits its output-token ceiling.

**Streaming UX.** User-invoked summaries use a sibling streaming path (`src/services/streaming/text-stream.ts`) that emits text deltas as the model writes, which the Telegram adapter renders as an animated, progressively-updating message draft with live HTML tag-balancing so partial markup never breaks Telegram's parser. Because a partial stream can't be safely retried mid-flight, the streaming path deliberately drops the retry wrapper and callers fall back to the buffered path on failure.

**Adapter/factory messaging.** `src/services/messaging/` defines an `IMessagingService` interface implemented by a `TelegramAdapter` and a `WhatsAppAdapter`, created through a small factory with per-platform singletons. Platform detection routes inbound webhooks and enables cross-platform notifications, so the summary, reminder, and event-capture logic is written once against the interface rather than per channel.

**A calendar model that stands on its own.** The Prisma schema (~370 lines) models a native recurring calendar with RFC-5545 `RRULE` strings, per-instance overrides and cancellations, and series-level exdates; `src/services/native-calendar/recurrence.ts` expands series into virtual instances for any date range using `rrule`. The same schema carries couple pairing with invites and status history, subscriptions/trials/usage counters, and a blocklist that persists across account deletion for moderation.

**Delivery correctness.** Scheduled jobs (daily and tomorrow summaries, reminders) run in-process on node-cron, and Upstash Redis dedup keys and locks keep a retried or duplicated run from double-sending, with Upstash rate limiting on hot paths. Auth spans magic-link/session flows for the dashboard, Telegram login verification, webhook secret validation, and a `CRON_SECRET` guarding internal endpoints. Every call to Google goes through one retry policy (`src/services/google-retry.ts`): a rate limit, a timeout or a 5xx is retried with jittered backoff and Google's `Retry-After`, and a create is never repeated on a failure that may have gone through. Errors flow to Sentry and to admin alerts. Voice replies and the two-host voice show are synthesized in-process with Gemini TTS and encoded from PCM to OGG/Opus.

## 🛠️ Tech stack

- **Frontend:** Next.js 16 (App Router), React 19, Tailwind CSS v4, next-intl (he/en/ru, RTL), lucide-react, MDX blog, Satori + resvg for generated share/weather images.
- **Backend/API:** TypeScript on Node 22, Next.js route handlers, node-telegram-bot-api, WhatsApp Business Cloud API, node-cron.
- **Data:** Prisma ORM, Neon Postgres, Upstash Redis (distributed locks, caching, rate limiting).
- **AI:** Google Gemini behind a unified provider layer, for text, voice transcription, photo parsing, and TTS.
- **Integrations:** Google Calendar API, Open-Meteo (weather/air quality), Hebcal (Hebrew dates/holidays), `rrule` (RFC-5545 recurrence).
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
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar OAuth |
| `GEMINI_API_KEY` | Gemini API key for text and voice |
| `AI_MAX_TOKENS`, `AI_MAX_RETRIES` | Optional output-token and retry overrides |
| `DATABASE_URL`, `DIRECT_URL` | Postgres connection (pooled + direct for migrations) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Redis for locks, caching, rate limiting |
| `CRON_SECRET` | Shared secret guarding internal cron/usage endpoints |
| `SESSION_SECRET` | Required, no fallback: its own random value (`openssl rand -hex 32`), never `CRON_SECRET`'s. The WhatsApp session cookie and the share-story image links are signed with keys derived from it; unset, both are refused and production startup logs an error. Changing it signs WhatsApp web users out once |
| `ENCRYPTION_KEY` | Encrypts the stored Google tokens: 64 hex characters (`openssl rand -hex 32`). See [Rotating `ENCRYPTION_KEY`](#rotating-encryption_key) |
| `ENCRYPTION_KEY_PREVIOUS` | Optional and decrypt-only: the old `ENCRYPTION_KEY` while a rotation runs; delete it once the key sweep logs SAFE |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Error tracking |
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

## 📦 Deployment

Deployed on Railway as one persistent Next.js (Node) process, with zero-downtime deploys. `npm run build` runs `prisma generate && prisma migrate deploy && next build`, so database migrations are applied on each deploy. Scheduled work (daily/tomorrow summaries, reminders, setup reminders, the Google copy worker, a nightly health check, the encryption-key sweep) runs in-process on node-cron, started from `instrumentation.ts` into `src/cron/scheduler.ts` (the job logic is in `src/cron/handlers.ts`); the health check and the key sweep run only on the schedule; every other job also has an API endpoint for manual runs, guarded by `CRON_SECRET` sent as `Authorization: Bearer <CRON_SECRET>` (a `?secret=` query is refused). Cron times are UTC (node-cron follows the server process's zone, which the startup log names) except the setup-reminder nudge, which keeps 10:00 Israel time summer and winter (an hourly UTC job that acts when Israel's hour is 10; node-cron's own `timezone` option skips the day the clocks spring forward). Local wall times become instants in one function, `src/utils/wall-time.ts`: a time the clocks skip moves forward by the jump, a repeated one is its first occurrence, whatever zone the server runs in.

## 📄 License

MIT — shared publicly as a portfolio project.
