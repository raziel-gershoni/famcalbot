# FamCal

> An AI family-calendar assistant that lives in your chat app — morning and evening briefings, voice-note and photo event capture, and shared couple calendars, across Telegram and WhatsApp.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js%2016-000?style=flat-square&logo=next.js&logoColor=white)
![React](https://img.shields.io/badge/React%2019-20232A?style=flat-square&logo=react&logoColor=61DAFB)
![Node.js](https://img.shields.io/badge/Node%2022-339933?style=flat-square&logo=node.js&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-2D3748?style=flat-square&logo=prisma&logoColor=white)
![Postgres](https://img.shields.io/badge/Neon%20Postgres-336791?style=flat-square&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Upstash%20Redis-DC382D?style=flat-square&logo=redis&logoColor=white)
![Vercel](https://img.shields.io/badge/Vercel-000?style=flat-square&logo=vercel&logoColor=white)
[![demo · live](https://img.shields.io/badge/demo-live-2ea44f?style=flat-square)](https://famcal.bot)

**🔗 Live demo:** https://famcal.bot  <!-- the public site is reachable directly; the personal dashboard (settings, calendars, pairing, admin) opens from inside the bot via a magic link, so most in-app screens are reached by chatting with the Telegram bot first -->

FamCal is a multi-platform, multilingual calendar assistant for individuals and families. Connect a Google Calendar (or use the built-in native calendar) and the bot writes personalized morning and evening briefings, week-ahead previews, weather, and reminders — and turns voice notes and photos of invitations into calendar events. It runs entirely on serverless infrastructure and switches transparently between Claude, GPT, and Gemini behind a single provider abstraction.

<!-- Screenshot placeholder: leave exactly this HTML comment so the owner can drop an image in later:
     ![screenshot](docs/screenshot.png) -->

## ✨ Features

- **AI daily briefings** — natural-language morning summaries and optional evening "tomorrow" previews, personalized per user with time-of-day greetings, conflict warnings, and grouped drop-off/pickup times.
- **Week-ahead and next-week previews** — culture-aware week boundaries (e.g., Sunday-start weeks) rendered as AI prose on demand.
- **Voice-note to event** — send a voice message; Gemini transcribes and parses it into a structured event, with confidence-gated auto-create and quick inline corrections.
- **Photo-to-event** — forward or snap a photo of an invitation or flyer and the bot extracts the event details into your calendar.
- **Natural voice replies** — optional spoken summaries via Gemini TTS in the user's language, with selectable voices and styles.
- **Google Calendar or native calendar** — read across multiple Google calendars, or use the built-in recurring calendar with no Google account required.
- **Couple pairing** — invite a partner to share calendars, with an auditable pairing lifecycle.
- **Multilingual** — Hebrew, English, and Russian throughout, including a right-to-left dashboard, Hebrew dates/holidays (Hebcal), and localized voice.
- **Weather in context** — Open-Meteo forecasts woven into the daily briefing, with air-quality and regional dust-storm (Sharav) awareness.
- **Event reminders** — pre-event nudges that respect each event's own reminder settings, including separate start and pickup reminders for kids' events.
- **Subscriptions and usage limits** — trials, plans, and usage counters billed in-app through Telegram Stars.
- **Web dashboard** — Next.js app for settings, calendar selection, pairing, a blog, and an admin panel with moderation, a persistent blocklist, and analytics.

## 🏗️ How it works

**One AI interface, three providers.** `src/services/ai-provider.ts` wraps Anthropic, OpenAI, and Google Gemini behind a single `generateAICompletion` call. The active model is chosen by the `AI_MODEL` env var and resolved through a typed model registry (`src/config/ai-models.ts`), so switching from Claude to GPT to Gemini is a one-line config change. The layer adds its own retry/backoff (SDK retries are disabled in favor of explicit control), 25-second client timeouts, per-provider token accounting (including cache and thinking tokens), and admin alerting when a response hits its output-token ceiling.

**Streaming UX inside serverless.** User-invoked summaries use a sibling streaming path (`src/services/streaming/text-stream.ts`) that emits text deltas as the model writes, which the Telegram adapter renders as an animated, progressively-updating message draft with live HTML tag-balancing so partial markup never breaks Telegram's parser. Because a partial stream can't be safely retried mid-flight, the streaming path deliberately drops the retry wrapper and callers fall back to the buffered path on failure.

**Adapter/factory messaging.** `src/services/messaging/` defines an `IMessagingService` interface implemented by a `TelegramAdapter` and a `WhatsAppAdapter`, created through a small factory with per-platform singletons. Platform detection routes inbound webhooks and enables cross-platform notifications, so the summary, reminder, and event-capture logic is written once against the interface rather than per channel.

**A calendar model that stands on its own.** The Prisma schema (~370 lines) models a native recurring calendar with RFC-5545 `RRULE` strings, per-instance overrides and cancellations, and series-level exdates; `src/services/native-calendar/recurrence.ts` expands series into virtual instances for any date range using `rrule`. The same schema carries couple pairing with invites and status history, subscriptions/trials/usage counters, and a blocklist that persists across account deletion for moderation.

**Serverless correctness.** Cron-triggered jobs (daily and tomorrow summaries, reminders, token-refresh checks) run behind Upstash Redis distributed locks so a retried or duplicated invocation can't double-send, with Upstash rate limiting on hot paths. Auth spans magic-link/session flows for the dashboard, Telegram login verification, webhook secret validation, and a `CRON_SECRET` guarding internal endpoints. Errors flow to Sentry and to admin alerts. A separate `tts-service/` microservice (its own `vercel.json`, 60-second function budget) generates speech and converts PCM to OGG/Opus for voice replies.

## 🛠️ Tech stack

- **Frontend:** Next.js 16 (App Router), React 19, Tailwind CSS v4, next-intl (he/en/ru, RTL), lucide-react, MDX blog, Satori + resvg for generated share/weather images.
- **Backend/API:** TypeScript on Node 22, Next.js route handlers, node-telegram-bot-api, WhatsApp Business Cloud API, node-cron.
- **Data:** Prisma ORM, Neon Postgres, Upstash Redis (distributed locks, caching, rate limiting).
- **AI:** Anthropic Claude, OpenAI GPT, and Google Gemini SDKs behind a unified provider layer; Gemini for voice transcription, photo parsing, and TTS.
- **Integrations:** Google Calendar API, Open-Meteo (weather/air quality), Hebcal (Hebrew dates/holidays), `rrule` (RFC-5545 recurrence).
- **Infra:** Vercel hosting, QStash for scheduled triggers, Sentry monitoring; standalone `tts-service` Vercel deployment.

## 🚀 Getting started

### Prerequisites

- Node.js 22.x
- A PostgreSQL database (Neon recommended; the schema uses `DATABASE_URL` + `DIRECT_URL`)
- An Upstash Redis instance
- A Telegram bot token (via BotFather); WhatsApp Business API credentials are optional
- Google OAuth credentials for Google Calendar access
- At least one AI provider key (Anthropic, OpenAI, or Gemini) matching your chosen `AI_MODEL`

### Environment variables

Copy `.env.example` (production) or `.env.local.example` (local dev) and fill in your own values. Names only — never commit real secrets.

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` | Telegram bot auth and webhook verification (username used in local dev) |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | WhatsApp Business Cloud API (optional) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_REDIRECT_URI` | Google Calendar OAuth |
| `AI_MODEL` | Selects the active model/provider from the model registry |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | AI provider keys (provide at least one) |
| `AI_MAX_TOKENS`, `AI_MAX_RETRIES` | Optional output-token and retry overrides |
| `DATABASE_URL`, `DIRECT_URL` | Postgres connection (pooled + direct for migrations) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Redis for locks, caching, rate limiting |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Scheduled job triggering / signature verification |
| `CRON_SECRET` | Shared secret guarding internal cron/usage endpoints |
| `GEMINI_TTS_VOICE_HE`, `GEMINI_TTS_VOICE_EN`, `GEMINI_TTS_VOICE_RU`, `GEMINI_TTS_MODEL` | Optional voice/model overrides for TTS |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Error tracking |
| `NODE_ENV` | Runtime environment |

### Install & run

```bash
# install dependencies
npm install

# local development: runs the Next.js app and the bot in polling mode together
npm run dev

# (optional) run each process separately
npm run dev:next   # Next.js dashboard only
npm run dev:bot    # Telegram bot only (polling)

# type-check
npm run type-check

# production build (generates Prisma client, applies migrations, builds Next.js)
npm run build
npm run start
```

Helper scripts handle one-time setup: `npm run get-google-token` (obtain a Google refresh token) and `npm run setup-webhook` (register the Telegram webhook).

## 📦 Deployment

Deployed on Vercel. `npm run build` (aliased as `vercel-build`) runs `prisma generate && prisma migrate deploy && next build`, so database migrations are applied on each deploy. Scheduled work (daily/tomorrow summaries, reminders, token-refresh checks) is driven by external cron via QStash hitting authenticated API endpoints guarded by `CRON_SECRET`. The `tts-service/` directory deploys as its own Vercel project with a dedicated `vercel.json` (60-second function budget) for voice generation.

## 📄 License

MIT — shared publicly as a portfolio project.
