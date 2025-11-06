# Family Calendar Telegram Bot

A private Telegram bot that sends daily calendar summaries using Google Calendar and Claude AI.

## Features

- Fetches events from multiple Google Calendars
- Generates natural language summaries using Claude AI
- Sends personalized daily messages at 7 AM (Asia/Jerusalem timezone)
- Manual summary via `/summary` command
- Whitelist-based security (only 2 authorized users)

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
│   └── index.ts              # Local dev entry point
├── api/
│   └── daily-summary.ts      # Vercel serverless function
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
- `GOOGLE_REFRESH_TOKEN_USER1` - OAuth refresh token for user 1
- `GOOGLE_REFRESH_TOKEN_USER2` - OAuth refresh token for user 2
- `ANTHROPIC_API_KEY` - From Anthropic Console
- `CRON_SECRET` - Random secret string for API protection

### 3. Configure Users

Edit `src/config/users.ts` to add your Telegram user IDs and calendar settings:

```typescript
{
  telegramId: 123456789,  // Your Telegram user ID
  name: 'Your Name',
  calendars: ['primary', 'calendar_id@group.calendar.google.com'],
  greeting: 'Good morning!',
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN_USER1 || '',
}
```

To get your Telegram user ID:
1. Message [@userinfobot](https://t.me/userinfobot)
2. It will reply with your user ID

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

### 7. Set Up Cron Job

1. Go to [cron-job.org](https://cron-job.org)
2. Create a new cron job:
   - URL: `https://your-project.vercel.app/api/daily-summary?secret=YOUR_CRON_SECRET`
   - Schedule: `0 7 * * *` (daily at 7:00 AM)
   - Timezone: Asia/Jerusalem

## Commands

- `/start` - Welcome message and help
- `/summary` - Get calendar summary for today
- `/help` - Show available commands

## API Endpoint

### `GET /api/daily-summary`

Triggers daily summary for all users.

**Authentication:** Requires `secret` query parameter or `x-cron-secret` header matching `CRON_SECRET`.

Example:
```bash
curl "https://your-project.vercel.app/api/daily-summary?secret=YOUR_SECRET"
```

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
