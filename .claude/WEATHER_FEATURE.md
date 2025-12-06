# Weather Forecast Feature - Implementation Plan

**Status:** ✅ IMPLEMENTED
**Last Updated:** 2025-12-06

---

## Executive Summary

Add weather forecasts to daily summaries using multiple data sources with AI-powered synthesis to determine the most accurate forecast. Weather will be included automatically in all scheduled summaries, with optional detailed view via commands.

---

## User Decisions

1. **Location:** Shared for all users (reduces API calls)
2. **Display:** Always include weather in summaries (scheduled and manual)
3. **Synthesis Reasoning:** Show AI reasoning only when invoked via command, not in scheduled summaries
4. **Caching:** No caching needed - 1 API call per cron job is acceptable (2 calls/day total)

---

## Enhanced Bot Commands

### Current Commands
```
/summary         → Today's summary
/tomorrow        → Tomorrow's summary
```

### New Command Structure
```
/summary         → Today's summary (default, backwards compatible)
/summary today   → Today's summary (explicit)
/summary tomorrow→ Tomorrow's summary
/weather         → Today's weather (detailed view with reasoning)
/weather today   → Today's weather (detailed view with reasoning)
/weather tomorrow→ Tomorrow's weather (detailed view with reasoning)
```

**Command Behavior:**
- `/summary` and `/summary today` - Include weather in summary (no reasoning shown)
- `/summary tomorrow` - Include tomorrow's weather in summary (no reasoning shown)
- `/weather` and `/weather today` - Show ONLY weather with synthesis reasoning
- `/weather tomorrow` - Show ONLY tomorrow's weather with synthesis reasoning
- Scheduled cron summaries - Include weather (no reasoning shown)

---

## Architecture

### File Structure
```
src/services/weather/
├── index.ts              # Main weather service - getWeatherForecast()
├── providers/
│   ├── openweathermap.ts # OpenWeatherMap API client
│   ├── weatherapi.ts     # WeatherAPI.com client
│   └── open-meteo.ts     # Open-Meteo client (FREE, no API key)
├── synthesizer.ts        # AI-powered forecast synthesis
└── formatter.ts          # Format weather for display (HTML for Telegram)
```

### Data Structure

```typescript
// src/types.ts

export interface WeatherForecast {
  source: string;           // 'openweathermap' | 'weatherapi' | 'open-meteo' | 'ai-synthesis'
  location: string;         // 'Tel Aviv, Israel'
  date: Date;
  temperature: {
    current?: number;       // Current temp (for today only)
    high: number;
    low: number;
    unit: 'C' | 'F';
  };
  conditions: string;       // 'Partly cloudy', 'Rain', etc.
  precipitation: {
    probability: number;    // 0-100%
    amount?: number;        // mm
  };
  wind: {
    speed: number;          // km/h
    direction?: string;     // 'NE', 'SW', etc.
  };
  humidity: number;         // 0-100%
  uvIndex?: number;
}

export interface WeatherSynthesis {
  consensus: WeatherForecast;   // AI-synthesized "best guess"
  sources: WeatherForecast[];   // Individual source forecasts
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;            // AI explanation of synthesis
}
```

### Configuration

```typescript
// src/config/weather.ts (NEW FILE)

export interface WeatherConfig {
  location: {
    city: string;           // 'Tel Aviv'
    country: string;        // 'Israel'
    coordinates: {
      lat: number;          // 32.0853
      lon: number;          // 34.7818
    };
    timezone: string;       // 'Asia/Jerusalem'
  };
  unit: 'C' | 'F';
  enabled: boolean;         // Feature flag
}

export const WEATHER_CONFIG: WeatherConfig = {
  location: {
    city: process.env.WEATHER_CITY || 'Tel Aviv',
    country: process.env.WEATHER_COUNTRY || 'Israel',
    coordinates: {
      lat: parseFloat(process.env.WEATHER_LAT || '32.0853'),
      lon: parseFloat(process.env.WEATHER_LON || '34.7818'),
    },
    timezone: process.env.WEATHER_TIMEZONE || 'Asia/Jerusalem',
  },
  unit: (process.env.WEATHER_UNIT as 'C' | 'F') || 'C',
  enabled: process.env.ENABLE_WEATHER !== 'false', // Enabled by default
};
```

---

## Implementation Details

### 1. Weather Data Sources

**Selected Sources:**
- **Open-Meteo** (free, no API key, European weather service) - Baseline
- **OpenWeatherMap** (free tier: 1000 calls/day)
- **WeatherAPI.com** (free tier: 1M calls/month)

**API Calls Per Day:**
- Morning cron (today): 3 sources = 3 calls
- Evening cron (tomorrow): 3 sources = 3 calls
- **Total: 6 calls/day** (well within free tier limits)

### 2. Main Weather Service

```typescript
// src/services/weather/index.ts

import { fetchOpenWeatherMap } from './providers/openweathermap';
import { fetchWeatherAPI } from './providers/weatherapi';
import { fetchOpenMeteo } from './providers/open-meteo';
import { synthesizeForecasts } from './synthesizer';
import { WEATHER_CONFIG } from '../../config/weather';

/**
 * Get weather forecast from multiple sources with AI synthesis
 * @param date - Date to fetch forecast for (today or tomorrow)
 * @returns Synthesized weather forecast with all source data
 */
export async function getWeatherForecast(date: Date): Promise<WeatherSynthesis> {
  if (!WEATHER_CONFIG.enabled) {
    throw new Error('Weather feature is disabled');
  }

  // Fetch from multiple sources in parallel
  const [openMeteo, openWeather, weatherApi] = await Promise.allSettled([
    fetchOpenMeteo(WEATHER_CONFIG.location, date),
    fetchOpenWeatherMap(WEATHER_CONFIG.location, date),
    fetchWeatherAPI(WEATHER_CONFIG.location, date),
  ]);

  // Extract successful forecasts
  const sources: WeatherForecast[] = [
    openMeteo.status === 'fulfilled' ? openMeteo.value : null,
    openWeather.status === 'fulfilled' ? openWeather.value : null,
    weatherApi.status === 'fulfilled' ? weatherApi.value : null,
  ].filter(Boolean) as WeatherForecast[];

  if (sources.length === 0) {
    throw new Error('All weather sources failed');
  }

  // Use AI to synthesize best forecast
  const consensus = await synthesizeForecasts(sources, WEATHER_CONFIG.location, date);
  const confidence = calculateConfidence(sources);

  return {
    consensus,
    sources,
    confidence,
    reasoning: consensus.reasoning || 'Synthesized from available sources',
  };
}

/**
 * Calculate confidence based on agreement between sources
 */
function calculateConfidence(sources: WeatherForecast[]): 'high' | 'medium' | 'low' {
  if (sources.length < 2) return 'low';
  if (sources.length === 2) return 'medium';

  // Check temperature agreement (within 3°C)
  const avgHigh = sources.reduce((sum, s) => sum + s.temperature.high, 0) / sources.length;
  const tempVariance = sources.every(s => Math.abs(s.temperature.high - avgHigh) <= 3);

  // Check precipitation agreement (within 20%)
  const avgPrecip = sources.reduce((sum, s) => sum + s.precipitation.probability, 0) / sources.length;
  const precipVariance = sources.every(s => Math.abs(s.precipitation.probability - avgPrecip) <= 20);

  return tempVariance && precipVariance ? 'high' : 'medium';
}
```

### 3. AI Synthesis

```typescript
// src/services/weather/synthesizer.ts

import { generateAICompletion } from '../ai-provider';
import { WeatherForecast } from '../../types';
import { formatDateHebrew } from '../../utils/date-formatter';

/**
 * Use AI to synthesize multiple weather forecasts into one consensus
 * Uses cheap model (gpt-4.1-nano) since this is a simple task
 */
export async function synthesizeForecasts(
  sources: WeatherForecast[],
  location: { city: string; country: string },
  date: Date
): Promise<WeatherForecast & { reasoning: string }> {
  const prompt = `You are a meteorologist analyzing weather forecasts from multiple sources.

Location: ${location.city}, ${location.country}
Date: ${formatDateHebrew(date)}

FORECASTS FROM DIFFERENT SOURCES:

${sources.map((f, i) => `
Source ${i + 1} (${f.source}):
- Temperature: ${f.temperature.low}°-${f.temperature.high}°${f.temperature.unit}
${f.temperature.current ? `- Current: ${f.temperature.current}°${f.temperature.unit}` : ''}
- Conditions: ${f.conditions}
- Precipitation: ${f.precipitation.probability}% chance${f.precipitation.amount ? `, ${f.precipitation.amount}mm` : ''}
- Wind: ${f.wind.speed} km/h ${f.wind.direction || ''}
- Humidity: ${f.humidity}%
${f.uvIndex ? `- UV Index: ${f.uvIndex}` : ''}
`).join('\n')}

Task: Synthesize these forecasts into ONE consensus forecast. Consider:
1. Where sources agree, trust that data more
2. Where sources disagree, prefer conservative predictions (e.g., higher rain chance)
3. Regional accuracy (some sources are better for certain locations)
4. Outliers (if one source differs drastically, investigate why)

Output ONLY valid JSON (no markdown, no backticks, no explanation outside JSON):
{
  "temperature": {
    "current": <number or null>,
    "low": <number>,
    "high": <number>,
    "unit": "C"
  },
  "conditions": "<brief description>",
  "precipitation": {
    "probability": <0-100>,
    "amount": <mm or null>
  },
  "wind": {
    "speed": <number>,
    "direction": "<direction or null>"
  },
  "humidity": <0-100>,
  "uvIndex": <number or null>,
  "reasoning": "<1-2 sentences explaining your synthesis and any disagreements between sources>"
}`;

  const result = await generateAICompletion(prompt, 'gpt-4.1-nano'); // Cheap model
  const synthesis = JSON.parse(result.text.trim());

  return {
    source: 'ai-synthesis',
    location: `${location.city}, ${location.country}`,
    date,
    ...synthesis,
  };
}
```

### 4. Weather Formatter

```typescript
// src/services/weather/formatter.ts

import { WeatherForecast, WeatherSynthesis } from '../../types';

/**
 * Format weather for inline display in summary
 */
export function formatWeatherInline(forecast: WeatherForecast): string {
  const emoji = getWeatherEmoji(forecast.conditions);
  return `${emoji} ${forecast.temperature.low}°-${forecast.temperature.high}°${forecast.temperature.unit}, ${forecast.conditions}${forecast.precipitation.probability >= 30 ? ` (${forecast.precipitation.probability}% rain)` : ''}`;
}

/**
 * Format detailed weather for /weather command
 * Includes synthesis reasoning and all sources
 */
export function formatWeatherDetailed(synthesis: WeatherSynthesis): string {
  const { consensus, sources, confidence, reasoning } = synthesis;

  let message = `🌤️ <b>Weather Forecast - ${consensus.location}</b>\n\n`;

  // Consensus (AI synthesis)
  message += `<b>📊 Consensus Forecast</b> (${confidence} confidence)\n`;
  message += `${getWeatherEmoji(consensus.conditions)} <b>${consensus.conditions}</b>\n`;
  message += `🌡️ ${consensus.temperature.low}°-${consensus.temperature.high}°${consensus.temperature.unit}`;
  if (consensus.temperature.current) {
    message += ` (now: ${consensus.temperature.current}°${consensus.temperature.unit})`;
  }
  message += `\n`;
  message += `💧 Rain: ${consensus.precipitation.probability}%`;
  if (consensus.precipitation.amount) {
    message += ` (~${consensus.precipitation.amount}mm)`;
  }
  message += `\n`;
  message += `💨 Wind: ${consensus.wind.speed} km/h${consensus.wind.direction ? ` ${consensus.wind.direction}` : ''}\n`;
  message += `💦 Humidity: ${consensus.humidity}%\n`;
  if (consensus.uvIndex) {
    message += `☀️ UV Index: ${consensus.uvIndex}\n`;
  }

  // AI Reasoning
  message += `\n<i>🤖 ${reasoning}</i>\n`;

  // Individual sources
  message += `\n<b>📡 Individual Sources</b>\n`;
  sources.forEach((source) => {
    message += `\n<b>${source.source}</b>\n`;
    message += `  • ${source.temperature.low}°-${source.temperature.high}°${source.temperature.unit}, ${source.conditions}\n`;
    message += `  • Rain: ${source.precipitation.probability}%\n`;
  });

  return message;
}

/**
 * Get emoji based on weather conditions
 */
function getWeatherEmoji(conditions: string): string {
  const lower = conditions.toLowerCase();
  if (lower.includes('clear') || lower.includes('sunny')) return '☀️';
  if (lower.includes('partly cloudy') || lower.includes('partial')) return '⛅';
  if (lower.includes('cloudy') || lower.includes('overcast')) return '☁️';
  if (lower.includes('rain') || lower.includes('drizzle')) return '🌧️';
  if (lower.includes('thunder') || lower.includes('storm')) return '⛈️';
  if (lower.includes('snow')) return '❄️';
  if (lower.includes('fog') || lower.includes('mist')) return '🌫️';
  return '🌤️';
}
```

### 5. Integration into Summary

```typescript
// src/services/claude.ts

import { getWeatherForecast } from './weather';
import { formatWeatherInline } from './weather/formatter';

// Update PromptData interface
interface PromptData {
  userName: string;
  userHebrewName: string;
  spouseName: string;
  spouseHebrewName: string;
  dateInfo: string;
  primaryCalendar: string;
  todayEvents: string;
  tomorrowEvents: string;
  weather?: string;  // NEW: Inline weather string
}

function buildCalendarSummaryPrompt(data: PromptData): string {
  return `${CALENDAR_SUMMARY_SYSTEM_PROMPT}

USER: ${data.userName} (${data.userHebrewName})
SPOUSE: ${data.spouseName} (${data.spouseHebrewName})
DATE: ${data.dateInfo}
PRIMARY_CALENDAR: ${data.primaryCalendar}

${data.weather ? `WEATHER: ${data.weather}\n` : ''}
TODAY_EVENTS:
${data.todayEvents}

TOMORROW_EVENTS:
${data.tomorrowEvents}

Generate a personalized summary in Hebrew. Include weather information naturally in the greeting if provided.`;
}

export async function generateSummary(
  userEvents: CalendarEvent[],
  spouseEvents: CalendarEvent[],
  otherEvents: CalendarEvent[],
  userName: string,
  userHebrewName: string,
  spouseName: string,
  spouseHebrewName: string,
  primaryCalendar: string,
  date: Date = new Date(),
  includeModelInfo: boolean = false,
  modelId?: string
): Promise<string> {
  // Fetch weather (non-blocking - continue without it if fails)
  let weatherString: string | undefined;
  try {
    const synthesis = await getWeatherForecast(date);
    weatherString = formatWeatherInline(synthesis.consensus);
  } catch (error) {
    console.error('Failed to fetch weather:', error);
    // Don't block summary generation - weather is optional

    // Only notify admin if ALL sources failed (not just one)
    if (error.message?.includes('All weather sources failed')) {
      const { notifyAdminWarning } = await import('../utils/error-notifier');
      await notifyAdminWarning('Weather Service', `All weather sources unavailable for ${date.toISOString()}`);
    }
  }

  const promptData: PromptData = {
    userName,
    userHebrewName,
    spouseName,
    spouseHebrewName,
    dateInfo: formatDateHebrew(date),
    primaryCalendar,
    todayEvents: formatEvents(userEvents, 'today'),
    tomorrowEvents: formatEvents(tomorrowEvents, 'tomorrow'),
    weather: weatherString,
  };

  const prompt = buildCalendarSummaryPrompt(promptData);
  return await callAI(prompt, includeModelInfo, modelId);
}
```

### 6. New Bot Commands

```typescript
// src/services/telegram.ts

import { getWeatherForecast } from './weather';
import { formatWeatherDetailed } from './weather/formatter';

/**
 * Handle /summary command with optional argument (today/tomorrow)
 */
export async function handleSummaryCommand(
  chatId: number,
  userId: number,
  args?: string
): Promise<void> {
  if (!isUserAuthorized(userId)) {
    await getBot().sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
    return;
  }

  // Parse argument: /summary, /summary today, /summary tomorrow
  const timeframe = args?.trim().toLowerCase();

  if (timeframe === 'tomorrow') {
    await sendTomorrowSummaryToUser(userId);
  } else {
    // Default to today (backwards compatible with /summary)
    await sendDailySummaryToUser(userId);
  }
}

/**
 * Handle /weather command with optional argument (today/tomorrow)
 */
export async function handleWeatherCommand(
  chatId: number,
  userId: number,
  args?: string
): Promise<void> {
  if (!isUserAuthorized(userId)) {
    await getBot().sendMessage(chatId, USER_MESSAGES.UNAUTHORIZED);
    return;
  }

  const timeframe = args?.trim().toLowerCase();
  const date = timeframe === 'tomorrow' ? getTomorrowDate() : new Date();

  try {
    await getBot().sendMessage(chatId, 'Fetching weather forecast...');

    const synthesis = await getWeatherForecast(date);
    const message = formatWeatherDetailed(synthesis);

    await getBot().sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error fetching weather:', error);
    await getBot().sendMessage(chatId, 'Sorry, could not fetch weather forecast at this time.');

    // Notify admin
    const { notifyAdminError } = await import('../utils/error-notifier');
    await notifyAdminError('Weather Command', error, `User: ${userId}, Date: ${date.toISOString()}`);
  }
}

function getTomorrowDate(): Date {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow;
}

// Update setupHandlers to include new commands
function setupHandlers(bot: TelegramBot) {
  // ... existing handlers

  // /summary command with optional argument
  bot.onText(/\/summary(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const args = match?.[1];
    if (userId) {
      await handleSummaryCommand(chatId, userId, args);
    }
  });

  // /weather command with optional argument (NEW)
  bot.onText(/\/weather(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const args = match?.[1];
    if (userId) {
      await handleWeatherCommand(chatId, userId, args);
    }
  });
}
```

### 7. Webhook Handler Updates

```typescript
// api/webhook.ts

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    await import('dotenv/config');
    const update = req.body;

    // Immediately respond 200 OK to Telegram
    res.status(200).json({ ok: true });

    if (!update.message || !update.message.text) {
      return;
    }

    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const text = update.message.text.trim();

    // Parse command and args
    const [command, ...argsParts] = text.split(/\s+/);
    const args = argsParts.join(' ');

    // Route to handlers
    if (command === '/start') {
      await handleStartCommand(chatId, userId);
    } else if (command === '/help') {
      await handleHelpCommand(chatId, userId);
    } else if (command === '/summary') {
      await handleSummaryCommand(chatId, userId, args);
    } else if (command === '/tomorrow') {
      // Keep backwards compatible
      await handleTomorrowCommand(chatId, userId);
    } else if (command === '/weather') {
      const { handleWeatherCommand } = await import('../src/services/telegram');
      await handleWeatherCommand(chatId, userId, args);
    } else if (text.startsWith('/testmodels')) {
      const testArgs = text.replace('/testmodels', '').trim();
      const { handleTestModelsCommand } = await import('../src/services/telegram');
      await handleTestModelsCommand(chatId, userId, testArgs || undefined);
    }
  } catch (error) {
    console.error('Error in webhook handler:', error);
    try {
      const { notifyAdminError } = await import('../src/utils/error-notifier');
      await notifyAdminError('Webhook Handler', error, `Update: ${JSON.stringify(req.body)}`);
    } catch (notifyError) {
      console.error('Failed to notify admin:', notifyError);
    }
  }
}
```

---

## Environment Variables

```env
# Weather Configuration
WEATHER_CITY=Tel Aviv
WEATHER_COUNTRY=Israel
WEATHER_LAT=32.0853
WEATHER_LON=34.7818
WEATHER_TIMEZONE=Asia/Jerusalem
WEATHER_UNIT=C

# Weather API Keys
OPENWEATHERMAP_API_KEY=your_key_here
WEATHERAPI_KEY=your_key_here
# Open-Meteo requires no API key

# Feature Flags
ENABLE_WEATHER=true  # Set to 'false' to disable weather feature
```

---

## Cost Analysis

### API Costs (All Free Tiers)
- **Open-Meteo:** FREE (no API key required)
- **OpenWeatherMap:** FREE tier = 1000 calls/day
- **WeatherAPI.com:** FREE tier = 1M calls/month

**Daily Usage:**
- Morning cron: 3 sources = 3 calls
- Evening cron: 3 sources = 3 calls
- Manual commands: ~2-4 calls/day (user testing)
- **Total: ~10 calls/day = 300 calls/month**

All well within free tier limits.

### AI Synthesis Costs
- Model: `gpt-4.1-nano` (cheapest)
- Cost: ~$0.0001 per synthesis
- Daily usage: 2 scheduled + 2-4 manual = ~4-6 synthesizations/day
- **Monthly cost: ~$0.01-0.02** (negligible)

---

## Testing Strategy

### Manual Testing
```bash
# Test weather command
/weather          # Today with detailed reasoning
/weather today    # Same as above
/weather tomorrow # Tomorrow with detailed reasoning

# Test summary integration
/summary          # Today's summary with weather
/summary today    # Same as above
/summary tomorrow # Tomorrow's summary with weather
```

### Testing with /testmodels
Could extend `/testmodels` to compare weather synthesis:
```bash
/testmodels weather
```
Would show how different AI models interpret the same multi-source weather data.

---

## Error Handling

### Graceful Degradation
```typescript
// Weather fetch failure NEVER blocks summary generation
try {
  const weather = await getWeatherForecast(date);
} catch (error) {
  console.error('Weather fetch failed:', error);
  // Continue without weather - summary still works
}
```

### Admin Notifications
- **Individual source failure:** Log only (don't spam admin)
- **ALL sources failed:** Notify admin via `notifyAdminWarning()`
- **Command failures:** Notify admin via `notifyAdminError()`

---

## Future Enhancements (Not in Scope)

1. **Historical Accuracy Tracking**
   - Store daily forecasts and actual weather
   - Track which source is most accurate over time
   - Adaptive weighting (trust more accurate sources more)

2. **Per-User Locations**
   - Support different locations per user (for travel)
   - Multiple location presets

3. **Severe Weather Alerts**
   - Push notifications for severe weather
   - Automatic alerts for high UV, storms, etc.

4. **Multi-Day Forecast**
   - 3-day or 7-day forecast display
   - Weather trends

5. **Weather-Aware Event Planning**
   - AI suggests indoor alternatives for outdoor events in rain
   - "Consider bringing umbrella" for specific events

---

## Implementation Checklist

When ready to implement:

- [ ] **Phase 1: Setup**
  - [ ] Create `src/config/weather.ts`
  - [ ] Add environment variables to `.env` and Vercel
  - [ ] Sign up for API keys (OpenWeatherMap, WeatherAPI.com)

- [ ] **Phase 2: Weather Providers**
  - [ ] Implement `src/services/weather/providers/open-meteo.ts`
  - [ ] Implement `src/services/weather/providers/openweathermap.ts`
  - [ ] Implement `src/services/weather/providers/weatherapi.ts`

- [ ] **Phase 3: Core Weather Service**
  - [ ] Implement `src/services/weather/index.ts` (main service)
  - [ ] Implement `src/services/weather/synthesizer.ts` (AI synthesis)
  - [ ] Implement `src/services/weather/formatter.ts` (display formatting)

- [ ] **Phase 4: Integration**
  - [ ] Update `src/types.ts` with weather interfaces
  - [ ] Update `src/services/claude.ts` to include weather in prompts
  - [ ] Add `/weather` command handler in `src/services/telegram.ts`
  - [ ] Update `/summary` command to support arguments
  - [ ] Update `api/webhook.ts` to route new commands
  - [ ] Update `USER_MESSAGES` in `src/config/messages.ts`

- [ ] **Phase 5: Testing**
  - [ ] Test each weather provider individually
  - [ ] Test AI synthesis with multiple sources
  - [ ] Test `/weather` command (today/tomorrow)
  - [ ] Test `/summary` with weather integration
  - [ ] Test scheduled crons with weather
  - [ ] Test error handling (API failures, synthesis failures)

- [ ] **Phase 6: Documentation**
  - [ ] Update `README.md` with new commands
  - [ ] Update `.env.example` with weather variables
  - [ ] Document API key setup process

---

## Notes

- Weather is OPTIONAL - if it fails, summaries still work
- AI synthesis reasoning only shown in `/weather` command, not scheduled summaries
- Shared location for all users reduces API calls
- No caching needed (1 API call per cron job is acceptable)
- Use `gpt-4.1-nano` for synthesis to minimize costs
- Always respond to webhook immediately (don't block on weather fetch)
