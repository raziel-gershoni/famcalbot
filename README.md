# Family Calendar Bot

A private messaging bot that sends intelligent, personalized daily calendar summaries using Google Calendar and AI (Claude/OpenAI). Supports both Telegram and WhatsApp.

## Features

- **Multi-platform support**: Works on both Telegram and WhatsApp with platform-specific routing and cross-platform notifications
- **Multi-language support**: Summaries and voice messages in Hebrew, English, Spanish, French, German with AI translation
- **Multi-calendar support**: Fetches events from multiple Google Calendars with shared authentication
- **Multi-provider AI**: Supports both Claude (Anthropic) and OpenAI GPT models with easy switching
- **AI model testing**: `/testmodels` command for side-by-side model comparison with performance metrics
- **Voice messages**: Natural, fluent audio summaries using Google Cloud TTS in user's preferred language
- **Weather integration**: AI-powered weather summaries integrated with daily schedule
- **Smart event categorization**: Pre-categorizes events by ownership (user, spouse, kids) for accurate attribution
- **Personalized views**: Each user gets summaries personalized to their calendars with spouse name integration
- **Time-based greetings**: Contextual greetings (Good morning/afternoon/evening) based on current time
- **Hebrew date support**: Displays Hebrew dates with Gematria (Hebrew numerals) for Hebrew, standard for other languages
- **Rosh Chodesh awareness**: Automatically adjusts dismissal times for Rosh Chodesh
- **Intelligent formatting**: Grouped start/pickup times, chronologically sorted, with conflict warnings
- **Week lookahead**: AI-rendered "Week Ahead" summary showing remaining events until end of week (culture-aware boundaries)
- **Next week preview**: AI-rendered "Next Week" summary for planning the following week
- **Event reminders**: Telegram notifications before events based on Google Calendar reminder settings
  - Respects event-specific reminders or falls back to user's default
  - Kids' events get both start AND pickup (end time) reminders
  - Redis-based tracking prevents duplicate notifications
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

### OpenAI GPT-5.2 (Latest - Dec 2025)
- **GPT-5.2** - Latest standard model with improved reasoning and efficiency

### OpenAI GPT-5.1
- **GPT-5.1** - Adaptive reasoning (defaults to none), fast and efficient
- **GPT-5.1 Instant** - Fast mode with 128K context

### OpenAI GPT-5
- **GPT-5** - Flagship with minimal reasoning enabled
- **GPT-5 Mini** - Balanced variant, great for most tasks
- **GPT-5 Nano** - Cheapest option, excellent for summaries

### Google Gemini
- **Gemini 3 Pro** - Latest Gemini (Nov 2025), best multimodal reasoning, 1M context
- **Gemini 2.5 Flash** - Best price-performance, advanced reasoning
- **Gemini 2.5 Flash-Lite** - Ultra-cheap, fastest flash model

**Switch models** by setting the `AI_MODEL` environment variable. All models use intelligent token management and provider-specific optimizations.

## Project Structure

```
famcalbot/
├── src/
│   ├── config/
│   │   ├── ai-models.ts       # AI model catalog with 11 models
│   │   ├── constants.ts       # App constants, timezone, admin ID
│   │   ├── messages.ts        # Telegram message templates
│   │   └── users.ts           # User configuration
│   ├── services/
│   │   ├── ai-provider.ts     # Unified Claude & OpenAI abstraction
│   │   ├── calendar.ts        # Google Calendar integration
│   │   ├── claude.ts          # Summary generation with metrics
│   │   ├── model-tester.ts    # Multi-model testing service
│   │   ├── reminders.ts       # Event reminder notifications
│   │   ├── telegram.ts        # Telegram bot handlers
│   │   ├── voice-generator.ts # Google Cloud TTS voice generation
│   │   └── week-lookahead.ts  # Week ahead/next week event aggregation
│   ├── utils/
│   │   ├── error-notifier.ts  # Admin error notifications
│   │   ├── event-formatter.ts # Event formatting for prompts
│   │   └── redis-lock.ts      # Upstash Redis distributed locks
│   ├── prompts/
│   │   ├── calendar-summary/   # Calendar summary prompts (per language)
│   │   ├── week-lookahead/     # Week lookahead prompts (per language)
│   │   └── voice-condenser/    # Voice condenser prompts
│   │       ├── en.ts           # English daily voice
│   │       ├── he.ts           # Hebrew daily voice
│   │       ├── ru.ts           # Russian daily voice
│   │       ├── week-en.ts      # English weekly voice
│   │       ├── week-he.ts      # Hebrew weekly voice
│   │       └── week-ru.ts      # Russian weekly voice
│   ├── types.ts               # TypeScript types
│   └── index.ts               # Local dev entry point (polling mode)
├── api/
│   ├── daily-summary.ts       # Vercel cron: morning summaries
│   ├── tomorrow-summary.ts    # Vercel cron: evening summaries
│   ├── reminders.ts           # Vercel cron: event reminders
│   ├── health.ts              # Vercel cron: token validation
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
  language: 'Hebrew',  // Preferred language: 'Hebrew', 'English', 'Spanish', 'French', 'German'
  location: 'Tel Aviv, Israel',  // Location for weather forecasts
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
- `whatsappPhone`: (Optional) Your WhatsApp phone in E.164 format (e.g., "+972501234567")
- `messagingPlatform`: (Optional) Where to send automated summaries - `'telegram'` (default), `'whatsapp'`, or `'all'`
- `name`: Your name (used in personalized summaries)
- `hebrewName`: Your Hebrew name (for Hebrew summaries)
- `spouseName`: Spouse's name (used when displaying their events)
- `spouseHebrewName`: Spouse's Hebrew name
- `language`: Preferred language for summaries and voice messages (defaults to English if not set)
- `location`: Location for weather forecasts (optional)
- `calendars`: Array of all Google Calendar IDs to fetch events from
- `primaryCalendar`: Your main personal calendar ID
- `ownCalendars`: All calendars that belong to you (personal + work)
- `spouseCalendars`: Calendar IDs belonging to your spouse
- `googleRefreshToken`: OAuth refresh token (typically shared across all users)

### 5. Set Up WhatsApp Business API (Optional)

The bot supports WhatsApp Business Cloud API for multi-platform messaging. This is completely optional - the bot works perfectly with just Telegram.

#### Prerequisites
- Meta Business account
- WhatsApp Business App
- Verified business phone number

#### Setup Steps

1. **Create Meta Business App**
   - Go to [Meta for Developers](https://developers.facebook.com/apps)
   - Create a new app → Select "Business" type
   - Add "WhatsApp" product to your app

2. **Get WhatsApp Credentials**
   - Go to WhatsApp → API Setup
   - Copy **Phone Number ID** (found under "Phone number")
   - Generate **Permanent Access Token**:
     - Go to Business Settings → System Users
     - Create system user with admin rights
     - Generate permanent token with `whatsapp_business_messaging` permission

3. **Configure Environment Variables**
   ```env
   WHATSAPP_ACCESS_TOKEN=your_permanent_access_token
   WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
   WHATSAPP_WEBHOOK_VERIFY_TOKEN=random_secret_string
   ```

4. **Configure Webhook** (after deploying to Vercel)
   - Go to WhatsApp → Configuration
   - Set Webhook URL: `https://your-project.vercel.app/api/webhook`
   - Set Verify Token: Same as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
   - Subscribe to webhook field: `messages`

5. **Add WhatsApp Phone to User Config**
   ```typescript
   {
     telegramId: 123456789,
     whatsappPhone: '+972501234567',  // E.164 format
     messagingPlatform: 'telegram',   // or 'whatsapp' or 'all'
     // ... other fields
   }
   ```

#### Platform Behavior
- **Command responses**: Sent to the platform where the command was received
- **Service messages** (errors, alerts): Always sent to Telegram
- **Cron job summaries**: Controlled by `messagingPlatform` field
  - `'telegram'`: Telegram only (default)
  - `'whatsapp'`: WhatsApp only
  - `'all'`: Both platforms
- **Cross-platform notifications**: When you send a command via WhatsApp, you get a notification on Telegram

#### Command Differences
- **Telegram**: Use slash commands (`/summary`, `/weather`, `/help`)
- **WhatsApp**: Use keywords without slash (`summary`, `weather`, `help`)
- **Limitations**: WhatsApp doesn't support inline keyboards (use text arguments instead)

### 6. Set Up Google Calendar API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable Google Calendar API
4. Create OAuth 2.0 credentials
5. Generate refresh token:
   ```bash
   npm run get-google-token
   ```
6. Add token to `.env` as `GOOGLE_REFRESH_TOKEN`

### 7. Local Development

Run the bot with polling enabled:

```bash
npm run dev
```

Test commands:
- `/start` - Welcome message
- `/summary` - Get today's calendar summary
- `/summary tmrw` - Get tomorrow's calendar summary
- `/weather` - Get weather forecast
- `/help` - Show available commands

**Note:** Local development uses polling mode. Make sure the webhook is not set (see webhook setup below).

### 8. Deploy to Vercel

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

### 9. Set Up Cron Jobs

1. Go to [cron-job.org](https://cron-job.org)
2. Create cron jobs for automated summaries:

**Health Check (Optional):**
   - URL: `https://your-project.vercel.app/api/health`
   - Schedule: `*/5 * * * *` (every 5 minutes) or as needed
   - No authentication required
   - Checks database connection and environment variables

**Morning Summary (Today's events):**
   - URL: `https://your-project.vercel.app/api/daily-summary?secret=YOUR_CRON_SECRET`
   - Schedule: `0 7 * * *` (daily at 7:00 AM)
   - Timezone: Asia/Jerusalem

**Evening Summary (Tomorrow's events):**
   - URL: `https://your-project.vercel.app/api/tomorrow-summary?secret=YOUR_CRON_SECRET`
   - Schedule: Set your preferred evening time (e.g., `0 20 * * *` for 8:00 PM)
   - Timezone: Asia/Jerusalem

**Event Reminders (Optional):**
   - URL: `https://your-project.vercel.app/api/reminders?secret=YOUR_CRON_SECRET`
   - Schedule: `*/5 * * * *` (every 5 minutes) or `*/2 * * * *` (every 2 minutes)
   - Timezone: Asia/Jerusalem
   - For custom intervals, add `&window=N` where N matches your cron interval in minutes
   - Users must enable reminders in Settings to receive notifications

## Commands

### User Commands
- `/start` - Welcome message and help
- `/summary` - Get calendar summary for today
- `/summary tmrw` - Get calendar summary for tomorrow
- `/weather` - Get weather forecast (shows buttons for Standard/Detailed)
- `/help` - Show available commands

### Dashboard Buttons
The web dashboard provides quick access to summaries:
- **Today** - Today's calendar summary
- **Tomorrow** - Tomorrow's calendar summary
- **Week Ahead** - AI-rendered summary of remaining events until end of current week
- **Next Week** - AI-rendered summary of the entire next week
- **Weather** - Current weather forecast

Week boundaries are culture-aware:
- **Jewish culture**: Sunday through Saturday (Sunday starts next week)
- **Default culture**: Monday through Sunday (Monday starts next week)

### User Settings

The Settings page (accessible from dashboard) provides these options:

**General:**
- **Language** - Language for summaries and messages (Hebrew, English, Russian)
- **Location** - Your location for weather forecasts (with auto-detect option)
- **Messaging Platform** - Where to receive messages (Telegram, WhatsApp, or both)
- **Culture** - Default or Jewish (includes Hebrew dates and holiday context)

**Summary Preferences:**
- **Text Summary** - Receive daily summary as text message
- **Voice Summary** - Receive daily summary as voice message
- **Weather Forecast** - Include weather forecast in your summary
- **Week Lookahead** - Include upcoming week events in tomorrow's summary
- **Always 7 Days** - Show next 7 days instead of until end of week (for week lookahead)

**Event Reminders:**
- **Enable Reminders** - Receive Telegram notifications before events start
- **Default Reminder Time** - Time before event to send reminder (5/10/15/30/60 min)
  - Used when event has no reminder set in Google Calendar
  - Kids' events get both start AND pickup reminders

### Admin Commands
- `/testmodels [filter]` - Test multiple AI models side-by-side
- `/testai` - Test AI models with interactive buttons

**Test model filters:**
```bash
/testmodels              # Test recommended models (5 models)
/testmodels all          # Test all 11 available models
/testmodels claude       # Test all Claude models (2)
/testmodels openai       # Test all OpenAI models (6)
/testmodels gemini       # Test all Gemini models (3)
/testmodels gpt-5.2      # Test single specific model
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

**Current status**: Admin-only feature for `/summary` and weekly summaries

The bot generates natural, fluent voice versions of calendar summaries using **Google Cloud Text-to-Speech** with multi-language support.

**Features:**
- **Multi-language support**: Hebrew, English, Russian (and extensible)
- **Natural, conversational speech**: AI condenses summaries into brief, fluent spoken language
- **Language-specific voices**: Automatically uses appropriate voice for user's language
- **Daily summaries**: 30-45 second voice versions of today/tomorrow events
- **Weekly summaries**: Voice versions of Week Ahead and Next Week (groups by day, highlights key events)
- **Weather integration**: Includes weather in natural, flowing sentences
- **Opus format**: Optimized for Telegram
- **Automatic cleanup**: Temporary files cleaned up after sending
- **Non-blocking**: Voice errors don't affect text summary delivery
- **No events handling**: AI generates friendly "no events today" message with weather in user's language

**Supported TTS Voices:**
- Hebrew: he-IL-Wavenet-D (male, natural)
- English: en-US-Wavenet-D (male, neutral)
- Russian: ru-RU-Wavenet-D (male, natural)
- Spanish: es-ES-Wavenet-B (male, neutral)
- French: fr-FR-Wavenet-B (male, neutral)
- German: de-DE-Wavenet-B (male, neutral)

**Setup:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Enable **Cloud Text-to-Speech API**
3. Create a service account and download JSON key
4. Add to Vercel environment variables as `GOOGLE_TTS_CREDENTIALS` (single-line JSON string)

**Configuration** (all optional):
```env
GOOGLE_TTS_CREDENTIALS={"type":"service_account",...}  # Service account JSON key
VOICE_SPEED=1.0                                        # 0.25 to 4.0 (1.0 = normal)
```

**Cost**: Google Cloud TTS pricing
- Free tier: 0-4M characters/month
- After free tier: ~$0.016 per 1K characters
- Estimated: ~$0.30-0.60/month for daily summaries (well within free tier!)

**Future plans**: See `.claude/VOICE_MESSAGES_FEATURE.md` for full roadmap including per-user preferences.

## API Endpoints

### `GET /api/health`

Basic health check endpoint for monitoring.

**Authentication:** None required.

**Checks:**
- Database connection (runs `SELECT 1`)
- Required environment variables exist

**Response:**
```json
{
  "status": "healthy",
  "checks": { "database": "ok", "environment": "ok" },
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

Example:
```bash
curl "https://your-project.vercel.app/api/health"
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

### `GET /api/reminders`

Processes event reminders for all users with reminders enabled. Sends Telegram notifications for events starting within the configured time window.

**Authentication:** Requires `secret` query parameter or `x-cron-secret` header matching `CRON_SECRET`.

**Query Parameters:**
- `secret` (required): Your CRON_SECRET
- `window` (optional): Time window in minutes (default: 5). Should match your cron interval.

**Features:**
- Respects event-specific reminders from Google Calendar
- Falls back to user's `defaultReminderMinutes` setting if no reminder set
- Kids' events get both start AND pickup (end time) reminders
- Redis-based tracking prevents duplicate notifications

Example:
```bash
# Default 5-minute window
curl "https://your-project.vercel.app/api/reminders?secret=YOUR_SECRET"

# Custom 2-minute window (for 2-minute cron)
curl "https://your-project.vercel.app/api/reminders?secret=YOUR_SECRET&window=2"
```

### `POST /api/webhook`

Receives Telegram bot updates (commands from users).

**Authentication:** Handled by Telegram's webhook system. Only registered webhooks from Telegram servers are accepted.

**Supported commands:**
- `/start` - Welcome message
- `/help` - Show available commands
- `/summary` - Get today's calendar summary
- `/summary tmrw` - Get tomorrow's calendar summary
- `/weather` - Get weather forecast with interactive buttons
- `/testmodels [filter]` - Test AI models (admin only)
- `/testai` - Test AI models with interactive buttons (admin only)

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
- Ensure user has `isAdmin: true` in the database

### Bot not responding
- Check Vercel deployment logs
- Verify webhook is set correctly
- Test health endpoint
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
