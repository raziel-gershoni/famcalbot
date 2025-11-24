# Family Calendar Telegram Bot

A private Telegram bot that sends intelligent, personalized daily calendar summaries using Google Calendar and AI (Claude/OpenAI).

## Features

- **Multi-calendar support**: Fetches events from multiple Google Calendars with shared authentication
- **Multi-provider AI**: Supports both Claude (Anthropic) and OpenAI GPT models with easy switching
- **AI model testing**: `/testmodels` command for side-by-side model comparison with performance metrics
- **Voice messages**: Admin can receive audio summaries using OpenAI TTS (6 voices available)
- **Smart event categorization**: Pre-categorizes events by ownership (user, spouse, kids) for accurate attribution
- **Personalized views**: Each user gets summaries personalized to their calendars with spouse name integration
- **Time-based greetings**: Contextual greetings (Good morning/afternoon/evening) based on current time
- **Hebrew date support**: Displays Hebrew dates with Gematria (Hebrew numerals) using Hebcal
- **Rosh Chodesh awareness**: Automatically adjusts dismissal times for Rosh Chodesh
- **Intelligent formatting**: Grouped start/pickup times, chronologically sorted, with conflict warnings
- **Automated scheduling**: Daily morning summaries (7 AM) and optional evening summaries for tomorrow
- **Proactive monitoring**: Daily health checks with admin alerts for token issues
- **Admin notifications**: Comprehensive error notification system for all critical failures
- **Telegram HTML formatting**: Proper bold, italic, and underline rendering
- **Security**: Whitelist-based access control and CRON secret protection
- **Distributed locking**: Redis-based duplicate prevention for serverless environment

## Available AI Models

### Claude (Anthropic)
- **Claude Sonnet 4.5** (DEFAULT) - Latest model (Sep 2025), 64K tokens, best coding
- **Claude Sonnet 4** - Previous version (May 2025), still very capable

### OpenAI GPT-5.1 (Latest - Nov 2025)
- **GPT-5.1** - Adaptive reasoning (defaults to none), fast and efficient
- **GPT-5.1 Instant** - Fast mode with 128K context

### OpenAI GPT-5 (Current Flagship)
- **GPT-5** - Flagship with minimal reasoning enabled
- **GPT-5 Mini** - Balanced variant, great for most tasks
- **GPT-5 Nano** - Cheapest option, excellent for summaries

**Switch models** by setting the `AI_MODEL` environment variable. All models use intelligent token management and provider-specific optimizations.

## Project Structure

```
famcalbot/
├── src/
│   ├── config/
│   │   ├── ai-models.ts       # AI model catalog with 7 models
│   │   ├── constants.ts       # App constants, timezone, admin ID
│   │   ├── messages.ts        # Telegram message templates
│   │   └── users.ts           # User configuration
│   ├── services/
│   │   ├── ai-provider.ts     # Unified Claude & OpenAI abstraction
│   │   ├── calendar.ts        # Google Calendar integration
│   │   ├── claude.ts          # Summary generation with metrics
│   │   ├── model-tester.ts    # Multi-model testing service
│   │   ├── telegram.ts        # Telegram bot handlers
│   │   └── voice-generator.ts # OpenAI TTS voice generation
│   ├── utils/
│   │   ├── error-notifier.ts  # Admin error notifications
│   │   ├── event-formatter.ts # Event formatting for prompts
│   │   └── redis-lock.ts      # Upstash Redis distributed locks
│   ├── prompts/
│   │   └── calendar-summary.ts # Prompt template
│   ├── types.ts               # TypeScript types
│   └── index.ts               # Local dev entry point (polling mode)
├── api/
│   ├── daily-summary.ts       # Vercel cron: morning summaries
│   ├── tomorrow-summary.ts    # Vercel cron: evening summaries
│   ├── health-check.ts        # Vercel cron: token validation
│   └── webhook.ts             # Telegram webhook endpoint
├── scripts/
│   ├── get-google-token.ts    # OAuth token generation
│   └── setup-webhook.ts       # Webhook registration tool
├── .env.example               # Environment variables template
├── vercel.json                # Vercel deployment config
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

**Required variables:**
```env
# Telegram
TELEGRAM_BOT_TOKEN=<from @BotFather>

# Google Calendar
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
GOOGLE_REFRESH_TOKEN=<OAuth refresh token>

# AI Providers (at least one required)
ANTHROPIC_API_KEY=<from Anthropic Console>
OPENAI_API_KEY=<from OpenAI Console>

# API Protection
CRON_SECRET=<random secret string>

# Redis (for distributed locking)
UPSTASH_REDIS_REST_URL=<from Upstash Console>
UPSTASH_REDIS_REST_TOKEN=<from Upstash Console>
```

**Optional variables:**
```env
AI_MODEL=claude-sonnet-4.5    # Default model
AI_MAX_TOKENS=<number>        # Override model defaults
DISABLE_TESTMODELS=false      # Emergency kill switch
NODE_ENV=production           # development = test user only
```

### 3. Set Up Redis (Upstash)

1. Go to [Upstash Console](https://console.upstash.com/)
2. Create a new Redis database (free tier: 500K commands/month)
3. Copy REST URL and token to environment variables
4. Used for: Preventing duplicate `/testmodels` executions from Telegram retries

### 4. Configure Users

Edit `src/config/users.ts` to add your Telegram user IDs and calendar settings:

```typescript
{
  telegramId: 123456789,  // Your Telegram user ID
  name: 'Raziel',
  hebrewName: 'רזיאל',  // Your Hebrew name
  spouseName: 'Yeshua',
  spouseHebrewName: 'ישועה',
  calendars: SHARED_CALENDARS,  // Array of calendar IDs
  googleRefreshToken: SHARED_REFRESH_TOKEN,
  primaryCalendar: 'your-personal@gmail.com',
  ownCalendars: [
    'your-personal@gmail.com',
    'your-work@company.com'
  ],
  spouseCalendars: ['spouse@gmail.com'],
}
```

**Important fields:**
- `telegramId`: Your Telegram user ID (get from [@userinfobot](https://t.me/userinfobot))
- `name`: Your name (used in personalized summaries)
- `hebrewName`: Your Hebrew name (for Hebrew summaries)
- `spouseName`: Spouse's name (used when displaying their events)
- `spouseHebrewName`: Spouse's Hebrew name
- `calendars`: Array of all Google Calendar IDs to fetch events from
- `primaryCalendar`: Your main personal calendar ID
- `ownCalendars`: All calendars that belong to you (personal + work)
- `spouseCalendars`: Calendar IDs belonging to your spouse
- `googleRefreshToken`: OAuth refresh token (typically shared across all users)

### 5. Set Up Google Calendar API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable Google Calendar API
4. Create OAuth 2.0 credentials
5. Generate refresh token:
   ```bash
   npm run get-google-token
   ```
6. Add token to `.env` as `GOOGLE_REFRESH_TOKEN`

### 6. Local Development

Run the bot with polling enabled:

```bash
npm run dev
```

Test commands:
- `/start` - Welcome message
- `/summary` - Get today's calendar summary
- `/tomorrow` - Get tomorrow's calendar summary
- `/help` - Show available commands

**Note:** Local development uses polling mode. Make sure the webhook is not set (see webhook setup below).

### 7. Deploy to Vercel

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

### 8. Set Up Cron Jobs

1. Go to [cron-job.org](https://cron-job.org)
2. Create cron jobs for automated summaries:

**Health Check (Token monitoring):**
   - URL: `https://your-project.vercel.app/api/health-check?secret=YOUR_CRON_SECRET`
   - Schedule: `0 6 * * *` (daily at 6:00 AM, before morning summary)
   - Timezone: Asia/Jerusalem
   - Alerts admin via Telegram if Google token is invalid

**Morning Summary (Today's events):**
   - URL: `https://your-project.vercel.app/api/daily-summary?secret=YOUR_CRON_SECRET`
   - Schedule: `0 7 * * *` (daily at 7:00 AM)
   - Timezone: Asia/Jerusalem

**Evening Summary (Tomorrow's events):**
   - URL: `https://your-project.vercel.app/api/tomorrow-summary?secret=YOUR_CRON_SECRET`
   - Schedule: Set your preferred evening time (e.g., `0 20 * * *` for 8:00 PM)
   - Timezone: Asia/Jerusalem

## Commands

### User Commands
- `/start` - Welcome message and help
- `/summary` - Get calendar summary for today
- `/tomorrow` - Get calendar summary for tomorrow
- `/help` - Show available commands

### Admin Commands
- `/testmodels [filter]` - Test multiple AI models side-by-side
- `/testvoices` - Test all 6 OpenAI TTS voices with Hebrew sample

**Test model filters:**
```bash
/testmodels              # Test recommended models (5 models)
/testmodels all          # Test all 7 available models
/testmodels claude       # Test all Claude models
/testmodels openai       # Test all OpenAI models
/testmodels gpt-5-mini   # Test single specific model
```

**Test output includes:**
- Hebrew summary for today and tomorrow
- Execution time (seconds)
- Token usage (input → output)
- Estimated cost
- Stop reason (end_turn, length, etc.)

Example output:
```
🧪 GPT-5 Mini - TODAY

[Hebrew summary...]

⏱️ 2.3s | 🔢 1407→256 tokens | 💰 $0.004 | end_turn
```

## Voice Messages

**Current status**: Admin-only feature for `/summary` command (Phase 1)

The bot can generate voice versions of calendar summaries using OpenAI Text-to-Speech API.

**Features:**
- 6 available voices: alloy, echo, fable, onyx, nova (default), shimmer
- High-quality tts-1-hd model
- Opus format optimized for Telegram
- HTML tag stripping for clean pronunciation
- Automatic cleanup of temporary files
- Non-blocking: voice errors don't affect text summary delivery

**Commands:**
- `/summary` - Admin users automatically receive voice message after text summary
- `/testvoices` - Test all 6 voices with Hebrew sample to choose your favorite

**Configuration** (all optional):
```env
VOICE_MODEL=tts-1-hd              # tts-1 (fast) or tts-1-hd (quality)
VOICE_DEFAULT=nova                # alloy, echo, fable, onyx, nova, shimmer
VOICE_SPEED=1.0                   # 0.25 to 4.0 (1.0 = normal)
```

**Cost**: ~$0.015-0.025 per summary (~$0.90-1.50/month for daily summaries)

**Future plans**: See `.claude/VOICE_MESSAGES_FEATURE.md` for full roadmap including per-user preferences and Google Cloud TTS evaluation.

## API Endpoints

### `GET /api/health-check`

Tests Google Calendar token validity and alerts admin if broken.

**Authentication:** Requires `secret` query parameter or `x-cron-secret` header matching `CRON_SECRET`.

**Purpose:** Run daily (e.g., 6 AM) to proactively detect token issues before users notice.

Example:
```bash
curl "https://your-project.vercel.app/api/health-check?secret=YOUR_SECRET"
```

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

### `POST /api/webhook`

Receives Telegram bot updates (commands from users).

**Authentication:** Handled by Telegram's webhook system. Only registered webhooks from Telegram servers are accepted.

**Supported commands:**
- `/start` - Welcome message
- `/help` - Show available commands
- `/summary` - Get today's calendar summary
- `/tomorrow` - Get tomorrow's calendar summary
- `/testmodels [filter]` - Test AI models (admin only)

This endpoint is automatically called by Telegram when users interact with the bot in production.

## Admin Notifications

The bot automatically notifies the admin user via Telegram for:

- **Token expiration** - Google refresh token invalid (with fix instructions)
- **Health check failures** - Daily token validation fails
- **Token ceiling hit** - AI response truncated (suggests increasing max tokens)
- **Webhook errors** - Telegram command processing failed
- **Cron job failures** - Summary generation failed
- **TestModels errors** - Model testing failed

All notifications include error context, message, stack trace (first 3 lines), and timestamp.

## Error Handling

- **Automatic retries**: Up to 3 retries with exponential backoff (1s, 2s, 4s delays)
- **Graceful degradation**: On Redis error, allows execution instead of blocking
- **Single-alert-per-error**: Prevents notification spam
- **Comprehensive logging**: All errors logged with context and stack traces
- **Token monitoring**: Proactive daily checks before scheduled summaries

## Security

- Only whitelisted Telegram user IDs can use the bot
- API endpoints protected by secret token
- All credentials stored in environment variables
- No hardcoded secrets in code
- Redis-based distributed locks prevent duplicate executions

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Bot Framework:** node-telegram-bot-api
- **APIs:**
  - Google Calendar API
  - Claude API (Anthropic)
  - OpenAI GPT API
- **Database:** Upstash Redis (distributed locking)
- **Deployment:** Vercel serverless functions
- **Scheduling:** cron-job.org
- **Date/Time:** date-fns with timezone support
- **Hebrew Calendar:** Hebcal

## Performance & Costs

### Model Performance (typical calendar summary)

| Model | Speed | Tokens | Cost | Quality |
|-------|-------|--------|------|---------|
| Claude Sonnet 4.5 | ~5-10s | ~2500 | ~$0.04 | Excellent |
| GPT-5.1 | ~3-8s | ~2800 | ~$0.03 | Excellent |
| GPT-5.1 Instant | ~2-5s | ~2500 | ~$0.03 | Very Good |
| GPT-5 (minimal) | ~20-40s | ~4000 | ~$0.05 | Excellent |
| GPT-5 Mini | ~15-30s | ~3800 | ~$0.01 | Very Good |
| GPT-5 Nano | ~10-20s | ~3000 | <$0.01 | Good |

**Monthly costs (2 users, daily summaries):**
- Claude Sonnet 4.5: ~$2.40/month
- GPT-5.1: ~$1.80/month
- GPT-5 Nano: ~$0.30/month

## Troubleshooting

### Webhook issues
```bash
# Check webhook status
npm run setup-webhook get

# Delete webhook (for local dev)
npm run setup-webhook delete

# Set webhook (for production)
npm run setup-webhook set https://your-project.vercel.app/api/webhook
```

### Google token expired
```bash
# Generate new token
npm run get-google-token

# Update in Vercel dashboard or .env
```

### Test models not working
- Check Redis credentials in environment variables
- Verify DISABLE_TESTMODELS is not set to 'true'
- Ensure user is admin (ADMIN_USER_ID in constants.ts)

### Bot not responding
- Check Vercel deployment logs
- Verify webhook is set correctly
- Test health-check endpoint
- Confirm environment variables are set

## Development Scripts

```bash
npm run dev              # Start polling bot locally
npm run build            # Compile TypeScript
npm run type-check       # Check types without building
npm run get-google-token # Generate Google OAuth token
npm run setup-webhook    # Manage Telegram webhook
```

## License

MIT
