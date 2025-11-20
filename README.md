# Family Calendar Telegram Bot

A private Telegram bot that sends intelligent, personalized daily calendar summaries using Google Calendar and Claude AI.

## Features

- **Multi-calendar support**: Fetches events from multiple Google Calendars with shared authentication
- **AI-powered summaries**: Natural language summaries in Hebrew using Claude AI (Sonnet 4.5)
- **Smart event categorization**: Pre-categorizes events by ownership (user, spouse, kids) for accurate attribution
- **Personalized views**: Each user gets summaries personalized to their calendars with spouse name integration
- **Time-based greetings**: Contextual greetings (Good morning/afternoon/evening) based on current time
- **Hebrew date support**: Displays Hebrew dates with Gematria (Hebrew numerals)
- **Rosh Chodesh awareness**: Automatically adjusts dismissal times for Rosh Chodesh
- **Intelligent formatting**: Grouped start/pickup times, chronologically sorted, with conflict warnings
- **Automated scheduling**: Daily morning summaries (7 AM) and optional evening summaries for tomorrow
- **Proactive monitoring**: Daily health checks with admin alerts for token issues (single alert per error)
- **Telegram HTML formatting**: Proper bold, italic, and underline rendering
- **Security**: Whitelist-based access control and CRON secret protection

## Project Structure

```
famcalbot/
├── src/
│   ├── config/
│   │   └── users.ts          # User configuration
│   ├── services/
│   │   ├── calendar.ts       # Google Calendar integration
│   │   ├── claude.ts         # Claude AI integration
│   │   └── telegram.ts       # Telegram bot handlers
│   ├── types.ts              # TypeScript types
│   └── index.ts              # Local dev entry point (polling mode)
├── api/
│   ├── daily-summary.ts      # Vercel cron endpoint
│   └── webhook.ts            # Telegram webhook endpoint
├── scripts/
│   └── setup-webhook.ts      # Webhook registration tool
├── .env.example              # Environment variables template
├── vercel.json               # Vercel deployment config
└── package.json
```

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:
- `TELEGRAM_BOT_TOKEN` - Get from [@BotFather](https://t.me/botfather)
- `GOOGLE_CLIENT_ID` - From Google Cloud Console
- `GOOGLE_CLIENT_SECRET` - From Google Cloud Console
- `GOOGLE_REFRESH_TOKEN` - OAuth refresh token (shared across all calendars)
- `ANTHROPIC_API_KEY` - From Anthropic Console
- `CRON_SECRET` - Random secret string for API protection

### 3. Configure Users

Edit `src/config/users.ts` to add your Telegram user IDs and calendar settings:

```typescript
{
  telegramId: 123456789,  // Your Telegram user ID
  name: 'Raziel',
  spouseName: 'Yeshua',  // Spouse's name for personalization
  calendars: SHARED_CALENDARS,  // Array of calendar IDs
  googleRefreshToken: SHARED_REFRESH_TOKEN,
  primaryCalendar: 'your-personal@gmail.com',  // Your main personal calendar
  ownCalendars: [
    'your-personal@gmail.com',  // Personal calendar
    'your-work@company.com'      // Work calendar
  ],
  spouseCalendars: ['spouse@gmail.com'],
}
```

**Important fields:**
- `telegramId`: Your Telegram user ID (get from [@userinfobot](https://t.me/userinfobot))
- `name`: Your name (used in personalized summaries)
- `spouseName`: Spouse's name (used when displaying their events)
- `calendars`: Array of all Google Calendar IDs to fetch events from
- `primaryCalendar`: Your main personal calendar ID
- `ownCalendars`: All calendars that belong to you (personal + work)
- `spouseCalendars`: Calendar IDs belonging to your spouse
- `googleRefreshToken`: OAuth refresh token (typically shared across all users)

### 4. Set Up Google Calendar API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable Google Calendar API
4. Create OAuth 2.0 credentials
5. Generate refresh tokens for each user

### 5. Local Development

Run the bot with polling enabled:

```bash
npm run dev
```

Test commands:
- `/start` - Welcome message
- `/summary` - Get today's calendar summary
- `/help` - Show available commands

**Note:** Local development uses polling mode. Make sure the webhook is not set (see webhook setup below).

### 6. Deploy to Vercel

1. Install Vercel CLI:
```bash
npm i -g vercel
```

2. Deploy:
```bash
vercel
```

3. Add environment variables in Vercel dashboard:
   - Go to your project settings
   - Add all environment variables from `.env`

4. Note your deployment URL: `https://your-project.vercel.app`

5. **Register webhook with Telegram:**

Once deployed, register the webhook URL so Telegram sends updates to your Vercel function:

```bash
npm run setup-webhook set https://your-project.vercel.app/api/webhook
```

To check current webhook status:
```bash
npm run setup-webhook get
```

To delete webhook (for local development):
```bash
npm run setup-webhook delete
```

**Important:** Vercel uses webhooks for bot commands. Local development uses polling. You cannot run both at the same time. Delete the webhook when running locally, and set it when deploying to production.

### 7. Set Up Cron Jobs

1. Go to [cron-job.org](https://cron-job.org)
2. Create cron jobs for automated summaries:

**Morning Summary (Today's events):**
   - URL: `https://your-project.vercel.app/api/daily-summary?secret=YOUR_CRON_SECRET`
   - Schedule: `0 7 * * *` (daily at 7:00 AM)
   - Timezone: Asia/Jerusalem

**Evening Summary (Tomorrow's events):**
   - URL: `https://your-project.vercel.app/api/tomorrow-summary?secret=YOUR_CRON_SECRET`
   - Schedule: Set your preferred evening time (e.g., `0 20 * * *` for 8:00 PM)
   - Timezone: Asia/Jerusalem

**Health Check (Token monitoring):**
   - URL: `https://your-project.vercel.app/api/health-check?secret=YOUR_CRON_SECRET`
   - Schedule: `0 6 * * *` (daily at 6:00 AM, before morning summary)
   - Timezone: Asia/Jerusalem
   - Alerts admin via Telegram if Google token is invalid

## Commands

- `/start` - Welcome message and help
- `/summary` - Get calendar summary for today
- `/tomorrow` - Get calendar summary for tomorrow
- `/help` - Show available commands

## API Endpoints

### `GET /api/daily-summary`

Triggers daily summary for all users (today's events).

**Authentication:** Requires `secret` query parameter or `x-cron-secret` header matching `CRON_SECRET`.

Example:
```bash
curl "https://your-project.vercel.app/api/daily-summary?secret=YOUR_SECRET"
```

### `GET /api/tomorrow-summary`

Triggers tomorrow's summary for all users (tomorrow's events).

**Authentication:** Requires `secret` query parameter or `x-cron-secret` header matching `CRON_SECRET`.

Example:
```bash
curl "https://your-project.vercel.app/api/tomorrow-summary?secret=YOUR_SECRET"
```

### `GET /api/health-check`

Tests Google Calendar token validity and alerts admin if broken.

**Authentication:** Requires `secret` query parameter or `x-cron-secret` header matching `CRON_SECRET`.

**Purpose:** Run daily (e.g., 6 AM) to proactively detect token issues before users notice.

Example:
```bash
curl "https://your-project.vercel.app/api/health-check?secret=YOUR_SECRET"
```

### `POST /api/webhook`

Receives Telegram bot updates (commands from users).

**Authentication:** Handled by Telegram's webhook system. Only registered webhooks from Telegram servers are accepted.

**Supported commands:**
- `/start` - Welcome message
- `/help` - Show available commands
- `/summary` - Get today's calendar summary
- `/tomorrow` - Get tomorrow's calendar summary

This endpoint is automatically called by Telegram when users interact with the bot in production.

## Security

- Only whitelisted Telegram user IDs can use the bot
- API endpoint protected by secret token
- All credentials stored in environment variables
- No hardcoded secrets in code

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Bot Framework:** node-telegram-bot-api
- **APIs:** Google Calendar API, Claude API (Anthropic)
- **Deployment:** Vercel serverless functions
- **Scheduling:** cron-job.org

## License

MIT
