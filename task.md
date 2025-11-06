# Family Calendar Telegram Bot - Build Instructions

## Overview
Private Telegram bot that sends daily calendar summaries to 2 users (me and wife). Fetches from Google Calendar, generates summary via Claude API, delivers via Telegram at 7 AM daily.

## Tech Stack
- **Runtime:** Node.js/TypeScript
- **Bot:** node-telegram-bot-api
- **APIs:** Google Calendar API, Claude API (Anthropic)
- **Deployment:** Vercel serverless function + cron-job.org for scheduling
- **Timezone:** Asia/Jerusalem

## Core Requirements

### Security
- Whitelist 2 Telegram user IDs only
- User config in separate file (not hardcoded)
- Environment variables for all secrets

### Functionality
- Fetch events from multiple calendars per user
- Generate natural language summary using Claude API (claude-sonnet-4-5-20250929)
- Send personalized messages (different greeting per user)
- Daily automated delivery at 7 AM
- Manual trigger via `/summary` command

### User Config Structure
```typescript
{
  telegramId: number,
  name: string,
  calendars: string[],  // Google Calendar IDs
  greeting: string,
  googleRefreshToken: string  // from env
}
```

## Architecture
```
cron-job.org (7 AM trigger)
  ↓ (HTTP GET with secret token)
Vercel Function /api/daily-summary
  ↓
Fetch Google Calendar events → Claude API summary → Telegram bot send
```

## Environment Variables
```
TELEGRAM_BOT_TOKEN
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET  
GOOGLE_REFRESH_TOKEN_USER1
GOOGLE_REFRESH_TOKEN_USER2
ANTHROPIC_API_KEY
CRON_SECRET
```

## Commands
- `/start` - Welcome message
- `/summary` - Get summary now
- `/help` - Show commands

## Key Points
- Google Calendar: Use OAuth refresh tokens, query "today" in user timezone
- Claude: Brief, friendly summaries highlighting family members' schedules
- Telegram: Private chat only, user ID whitelist
- Vercel: Serverless function, protected by secret token
- External cron: cron-job.org hits Vercel function daily

Build a working implementation. Ask if you need clarification on credentials or setup.