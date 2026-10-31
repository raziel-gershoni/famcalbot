/**
 * The forecast: MET Norway's Locationforecast 2.0, `complete` (https://docs.api.met.no/doc/locationforecast/HowTO),
 * NLOD 2.0 and CC BY 4.0, commercial use allowed. It replaced Open-Meteo's free API, which forbids commercial use. Spec
 * docs/superpowers/specs/2026-10-31-open-meteo-replacement-design.md §5; plan Task 3.
 *
 *   fetchWeather     the one way the app gets a forecast: the place (geocodeLocation), MET (cached), the mapper
 *   mapMetForecast   MET's UTC steps onto WeatherData on the place's wall clock: the units, the days in the place's own
 *                    zone, the 41 symbols as the WMO codes the icons, texts and gradients read, the rain stretches
 *   getWeatherDescription, describeWeather, getWindDirectionLabel, getWeatherEmoji   the WMO helpers (moved unchanged)
 *
 * MET's terms, kept here: a User-Agent naming the app (MET_USER_AGENT); at most 4 decimals (we send 2, about 1 km:
 * roundedCoordinate; MET's model grid is about 9 km); no request before the answer's Expires; If-Modified-Since on a
 * refetch (one Redis key per rounded place). Failure: no timeout of our own; 429, 5xx and no answer retried with backoff
 * by the shared loop (src/utils/fetch-retry.ts: Retry-After honoured; one over 10 s gives up at once); every failure
 * logged; fetchWeather throws and each caller does as before (a summary without weather, /weather's error reply).
 *
 * MET sends no rain chance outside the Nordic countries and no visibility: a day carries its rain amount and the hours
 * it rains. It sends UTC and no past hours: today covers the hours left in it. Server only.
 */

import type { RainSpell, WeatherData, WeatherDay } from '../../types';
import { geocodeLocation } from './geocoding';
import type { BotMessages } from '../../lib/bot-messages';
import { redis } from '../../utils/redis';
import { REDIS_KEYS } from '../../config/redis-keys';
import { captureError, captureWarning } from '../../lib/error-capture';
import { instantToWallTime, wallTimeToInstant } from '../../utils/wall-time';
import { addDaysToDate } from '../../utils/day-events';
import { fetchWithRetry, HttpStatusError } from '../../utils/fetch-retry';
import { seaLevelSun } from '../zmanim/compute';

export const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
/** MET refuses a request without a User-Agent that names the app and a contact. */
export const MET_USER_AGENT = 'FamCal/1.0 (+https://famcal.bot)';
/** Days in the forecast, today included: MET forecasts about nine days ahead. */
export const FORECAST_DAYS = 9;
/** How long a place's answer stays in Redis after a fetch: past its Expires, for If-Modified-Since. */
const CACHE_KEEP_S = 12 * 60 * 60;
/** Used only when MET sends no Expires we can read (it always does): its own half hour. */
const FALLBACK_FRESH_MS = 30 * 60 * 1000;
const HOUR_MS = 3_600_000;
const LOG = '[weather-forecast]';

// ---- MET's answer ----

type MetDetails = Partial<Record<string, number>>;
interface MetPeriod {
  summary?: { symbol_code?: string };
  details?: MetDetails;
}
export interface MetStep {
  time: string;
  data: { instant: { details: MetDetails }; next_1_hours?: MetPeriod; next_6_hours?: MetPeriod; next_12_hours?: MetPeriod };
}
export interface MetForecast {
  properties: { timeseries: MetStep[] };
}
interface CachedForecast {
  body: MetForecast;
  /** Epoch ms of the answer's Expires: no request before it. */
  expiresAt: number;
  lastModified: string | null;
}

// ---- The test seam: the clock (the waits and the jitter are fetch-retry.ts's) ----

interface Seam {
  now: () => number;
}
const seamState = globalThis as { __metForTests?: Partial<Seam> | null };
/** Tests only: replaces the clock. */
export function __useMetForTests(seam: Partial<Seam> | null): void {
  seamState.__metForTests = seam;
}
const seam = (): Seam => ({ now: () => Date.now(), ...seamState.__metForTests });

// ---- The symbols ----

/**
 * MET's symbol codes (github.com/metno/weathericons, weather/legend.csv; the _day, _night and _polartwilight forms cut)
 * as the WMO codes FamCal draws. MET has no drizzle, freezing drizzle, snow grains or hail; sleet takes the freezing
 * rain codes and sleet showers the snow-shower ones.
 */
export const MET_SYMBOLS: Readonly<Record<string, number>> = {
  clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45,
  lightrain: 61, rain: 63, heavyrain: 65,
  lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82,
  lightsleet: 66, sleet: 66, heavysleet: 67,
  lightsleetshowers: 85, sleetshowers: 85, heavysleetshowers: 86,
  lightsnow: 71, snow: 73, heavysnow: 75,
  lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86,
  lightrainandthunder: 95, rainandthunder: 95, heavyrainandthunder: 95,
  lightrainshowersandthunder: 95, rainshowersandthunder: 95, heavyrainshowersandthunder: 95,
  lightsleetandthunder: 95, sleetandthunder: 95, heavysleetandthunder: 95,
  lightsleetshowersandthunder: 95, sleetshowersandthunder: 95, heavysleetshowersandthunder: 95,
  lightsnowandthunder: 95, snowandthunder: 95, heavysnowandthunder: 95,
  lightsnowshowersandthunder: 95, snowshowersandthunder: 95, heavysnowshowersandthunder: 95,
};

/** The WMO code of a MET symbol ('rainshowers_day'); MET's two "lightss…" spellings read as "lights…". An unknown one is logged and shown as overcast (3). */
export function wmoForSymbol(symbol: string, warn: (message: string) => void): number {
  const base = symbol.replace(/_(day|night|polartwilight)$/, '').replace(/^lightss/, 'lights');
  const code = MET_SYMBOLS[base];
  if (code !== undefined) return code;
  warn(`MET sent the symbol "${symbol}", which FamCal does not know: shown as overcast`);
  return 3;
}

// ---- The mapper ----

/** The day's sea-level sunrise and sunset at the place, as wall times ('yyyy-MM-ddTHH:mm'), '' where there is none. */
export type SunOf = (date: string) => { sunrise: string; sunset: string };

/** The one source of the forecast's sun times: compute.ts's sea-level sunrise and sunset, on the place's clock. */
export function sunFor(latitude: number, longitude: number, timezone: string): SunOf {
  return date => {
    const { sunrise, sunset } = seaLevelSun(date, { latitude, longitude, timeZone: timezone });
    const wall = (at: Date | null) => (at ? instantToWallTime(at, timezone).slice(0, 16) : '');
    return { sunrise: wall(sunrise), sunset: wall(sunset) };
  };
}

/** A MET step read once. */
interface Step {
  at: number;
  /** 'yyyy-MM-ddTHH:mm' at the place. */
  wall: string;
  /** The step's length in hours: 1 for an hourly step, else up to the next step (at most 6). */
  hours: number;
  temperature: number;
  feelsLike: number;
  humidity: number;
  windKmh: number;
  windFrom: number;
  uv: number | undefined;
  code: number;
  /** Millimetres in the step: next_1_hours, or next_6_hours prorated to the step's length. */
  mm: number;
  /** A 6-hour step's own highest and lowest temperature. */
  max: number | undefined;
  min: number | undefined;
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round1 = (value: number) => Math.round(value * 10) / 10;

/** MET's steps that FamCal can read, in order. A step missing a core field is dropped (one warning); a last step with no period is expected. */
function readSteps(series: readonly MetStep[], timezone: string, warn: (message: string) => void): Step[] {
  const steps: Step[] = [];
  let dropped = 0;
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const at = Date.parse(s?.time ?? '');
    const d = s?.data?.instant?.details ?? {};
    const period = s?.data?.next_1_hours ?? s?.data?.next_6_hours;
    const symbol = period?.summary?.symbol_code;
    if (!symbol) continue; // the answer's last step has no period: nothing to show for it
    if (!Number.isFinite(at) || !isNumber(d.air_temperature) || !isNumber(d.relative_humidity) || !isNumber(d.wind_speed) || !isNumber(d.wind_from_direction)) {
      dropped++;
      continue;
    }
    const hourly = s.data.next_1_hours !== undefined;
    const nextAt = i + 1 < series.length ? Date.parse(series[i + 1].time) : NaN;
    const hours = hourly ? 1 : Math.min(6, Math.max(1, Number.isFinite(nextAt) ? (nextAt - at) / HOUR_MS : 6));
    const amount = period?.details?.precipitation_amount;
    const six = s.data.next_6_hours?.details;
    steps.push({
      at,
      wall: instantToWallTime(new Date(at), timezone).slice(0, 16),
      hours,
      temperature: d.air_temperature,
      feelsLike: isNumber(d.apparent_air_temperature) ? d.apparent_air_temperature : d.air_temperature,
      humidity: d.relative_humidity,
      windKmh: d.wind_speed * 3.6,
      windFrom: d.wind_from_direction,
      uv: isNumber(d.ultraviolet_index_clear_sky) ? d.ultraviolet_index_clear_sky : undefined,
      code: wmoForSymbol(symbol, warn),
      mm: isNumber(amount) ? (hourly ? amount : (amount * hours) / 6) : 0,
      max: hourly || !isNumber(six?.air_temperature_max) ? undefined : six.air_temperature_max,
      min: hourly || !isNumber(six?.air_temperature_min) ? undefined : six.air_temperature_min,
    });
  }
  if (dropped > 0) warn(`${dropped} step${dropped === 1 ? '' : 's'} of MET's answer lacked a temperature, humidity or wind: skipped`);
  return steps;
}

/** The day's wet stretches: back-to-back steps with rain, 'HH:mm' at the place; one that runs past midnight ends at 24:00. */
function rainSpells(steps: readonly Step[], dayEnd: number, timezone: string): RainSpell[] {
  const spells: RainSpell[] = [];
  let open: { start: string; endAt: number; mm: number } | null = null;
  const close = (): void => {
    if (open) spells.push({ start: open.start, end: open.endAt >= dayEnd ? '24:00' : instantToWallTime(new Date(open.endAt), timezone).slice(11, 16), mm: round1(open.mm) });
    open = null;
  };
  for (const step of steps) {
    if (step.mm <= 0) {
      close();
      continue;
    }
    const endAt = step.at + step.hours * HOUR_MS;
    if (open !== null && open.endAt === step.at) {
      open.endAt = endAt;
      open.mm += step.mm;
    } else {
      close();
      open = { start: step.wall.slice(11, 16), endAt, mm: step.mm };
    }
  }
  close();
  return spells;
}

/** The day's main wind direction: the speed-weighted mean of its steps' directions (350° and 10° make 0°, not 180°). */
function mainDirection(steps: readonly Step[]): number {
  let east = 0;
  let north = 0;
  for (const s of steps) {
    const rad = (s.windFrom * Math.PI) / 180;
    east += s.windKmh * Math.sin(rad);
    north += s.windKmh * Math.cos(rad);
  }
  if (east === 0 && north === 0) return Math.round(steps[0]?.windFrom ?? 0);
  return Math.round(((Math.atan2(east, north) * 180) / Math.PI + 360) % 360);
}

/** One day from its steps (all on the place's clock): highs and lows, rain, the most severe code, wind, humidity, UV, sun. */
function buildDay(date: string, steps: readonly Step[], timezone: string, sun: SunOf): WeatherDay {
  const temps = steps.flatMap(s => [s.temperature, s.max, s.min]).filter(isNumber);
  const uv = steps.map(s => s.uv).filter(isNumber);
  const dayEnd = wallTimeToInstant(`${addDaysToDate(date, 1)}T00:00`, timezone).getTime();
  const { sunrise, sunset } = sun(date);
  return {
    date,
    tempMax: Math.round(Math.max(...temps)),
    tempMin: Math.round(Math.min(...temps)),
    precipitation: round1(steps.reduce((sum, s) => sum + s.mm, 0)),
    rainHours: rainSpells(steps, dayEnd, timezone),
    // Open-Meteo's daily code was the day's most severe; the WMO codes rise with severity, so it is the highest.
    weatherCode: Math.max(...steps.map(s => s.code)),
    sunrise,
    sunset,
    uvIndexMax: uv.length > 0 ? round1(Math.max(...uv)) : null,
    windSpeedMax: Math.round(Math.max(...steps.map(s => s.windKmh))),
    windDirection: mainDirection(steps),
    humidity: Math.round(steps.reduce((sum, s) => sum + s.humidity, 0) / steps.length),
  };
}

export interface MapInput {
  location: string;
  forecast: MetForecast;
  timezone: string;
  now: Date;
  sun: SunOf;
  warn: (message: string) => void;
}

/**
 * MET's answer as WeatherData at the place: the current step (the last one not after `now`), today and up to eight more
 * days as the place's clock divides them, and every step on the place's wall clock. Throws when the answer has no
 * timeseries or no step for today at the place (the caller logs it): never another day shown as today.
 */
export function mapMetForecast({ location, forecast, timezone, now, sun, warn }: MapInput): WeatherData {
  const series = forecast?.properties?.timeseries;
  if (!Array.isArray(series)) throw new Error('MET sent no timeseries');
  const steps = readSteps(series, timezone, warn);
  const today = instantToWallTime(now, timezone).slice(0, 10);
  const byDay = new Map<string, Step[]>();
  for (const step of steps) {
    const date = step.wall.slice(0, 10);
    if (date < today) continue;
    if (!byDay.has(date)) {
      if (byDay.size === FORECAST_DAYS) break;
      byDay.set(date, []);
    }
    byDay.get(date)!.push(step);
  }
  if (!byDay.has(today)) throw new Error("MET's forecast has no step for today at the place");
  const daily = [...byDay].map(([date, daySteps]) => buildDay(date, daySteps, timezone, sun));
  const nowMs = now.getTime();
  const current = steps.reduce((found, step) => (step.at <= nowMs ? step : found), steps[0]);
  // MET's UV reaches about 60 hours ahead, which always covers today and tomorrow: 0 only for a gap in the answer.
  const summary = (day: WeatherDay) => ({
    tempMax: day.tempMax, tempMin: day.tempMin, precipitation: day.precipitation, rainHours: day.rainHours,
    weatherCode: day.weatherCode, sunrise: day.sunrise, sunset: day.sunset, uvIndexMax: day.uvIndexMax ?? 0,
  });
  return {
    location,
    current: {
      temperature: Math.round(current.temperature),
      feelsLike: Math.round(current.feelsLike),
      humidity: Math.round(current.humidity),
      weatherCode: current.code,
      windSpeed: Math.round(current.windKmh),
      windDirection: Math.round(current.windFrom),
      uvIndex: round1(current.uv ?? 0),
    },
    today: summary(daily[0]),
    tomorrow: daily[1]?.date === addDaysToDate(today, 1) ? summary(daily[1]) : undefined,
    hourly: {
      time: steps.map(s => s.wall),
      temperature: steps.map(s => round1(s.temperature)),
      precipitation: steps.map(s => round1(s.mm)),
      weatherCode: steps.map(s => s.code),
      windSpeed: steps.map(s => round1(s.windKmh)),
      humidity: steps.map(s => Math.round(s.humidity)),
      windDirection: steps.map(s => Math.round(s.windFrom)),
    },
    daily,
  };
}

// ---- MET's requests ----

/** Coordinates as MET gets them and the cache keys them: 2 decimals (about 1 km), never "-0.00". */
export function roundedCoordinate(value: number): string {
  return (Math.round(value * 100) / 100 + 0).toFixed(2);
}

/**
 * One request to MET with the retries (the shared loop): 429, 5xx and no answer are retried up to 3 times after
 * max(Retry-After, full-jitter backoff from 500 ms); a Retry-After over 10 s, a 403 or another refusal fails at once.
 * Answers a 2xx or a 304; a failure is logged once (status and retries, never the place) and thrown. No timeout of our own.
 */
function metRequest(url: string, headers: Record<string, string>): Promise<Response> {
  return fetchWithRetry(url, { headers }, {
    okStatuses: [304],
    label: LOG,
    onGiveUp: (error, { retried, why }) =>
      captureError(error, 'weather-forecast', { service: 'weather', status: error instanceof HttpStatusError ? error.status : undefined, retried, why }, 'warning'),
  });
}

/** The answer's Expires as epoch ms; MET always sends it, and a missing one is logged and read as its half hour. */
function expiresOf(response: Response, now: number): number {
  const at = Date.parse(response.headers.get('expires') ?? '');
  if (Number.isFinite(at)) return at;
  console.warn(`${LOG} MET sent no Expires FamCal can read: the answer is kept for 30 minutes`);
  return now + FALLBACK_FRESH_MS;
}

/** MET's answer for a rounded place: the stored one while it is fresh, else asked again (If-Modified-Since when one is stored). */
async function metForecast(lat: string, lon: string): Promise<MetForecast> {
  const key = REDIS_KEYS.metForecast(lat, lon);
  let cached: CachedForecast | null = null;
  try {
    cached = await redis.get<CachedForecast>(key);
  } catch (error) {
    captureError(error, 'weather-forecast', { service: 'weather', step: 'cache-read' }, 'warning');
  }
  const now = seam().now();
  if (cached && now < cached.expiresAt) return cached.body;

  const headers: Record<string, string> = { 'User-Agent': MET_USER_AGENT };
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
  const response = await metRequest(`${MET_URL}?lat=${lat}&lon=${lon}`, headers);
  const expiresAt = expiresOf(response, now);
  let fresh: CachedForecast;
  if (response.status === 304) {
    if (!cached) throw new Error('MET answered 304 to a request with no If-Modified-Since');
    fresh = { ...cached, expiresAt };
  } else {
    const body = (await response.json()) as MetForecast;
    if (!Array.isArray(body?.properties?.timeseries)) throw new Error('MET answered 200 with no timeseries');
    fresh = { body, expiresAt, lastModified: response.headers.get('last-modified') };
  }
  try {
    await redis.set(key, fresh, { ex: CACHE_KEEP_S });
  } catch (error) {
    captureError(error, 'weather-forecast', { service: 'weather', step: 'cache-write' }, 'warning');
  }
  return fresh.body;
}

/**
 * The forecast for a location in its zone (`timezone`, the place's own: getTimezone's): MET's answer for the rounded
 * place, mapped. Throws when the place, MET or the mapping fails; each caller logs it and does as before.
 */
export async function fetchWeather(location: string, timezone: string): Promise<WeatherData> {
  const { latitude, longitude } = await geocodeLocation(location);
  const forecast = await metForecast(roundedCoordinate(latitude), roundedCoordinate(longitude));
  const weather = mapMetForecast({
    location,
    forecast,
    timezone,
    now: new Date(seam().now()),
    sun: sunFor(latitude, longitude, timezone),
    warn: message => captureWarning(message, 'weather-forecast', { service: 'weather' }),
  });
  console.log(`${LOG} forecast ready: ${weather.daily?.length ?? 0} days in ${timezone}`);
  return weather;
}

/**
 * Weather code descriptions in English (WMO Weather interpretation codes)
 * WMO 4677 codes, the subset the forecast maps MET's symbols onto
 *
 * For text the MODEL reads (the forecast prompts) only. Anything the person reads gets its condition from
 * describeWeather, which takes the name from the messages in their language.
 */
export function getWeatherDescription(code: number): string {
  const descriptions: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail'
  };

  return descriptions[code] || 'Unknown';
}

/** The bot message key of each WMO weather code's name (bot.weatherConditions.<key>). */
const WEATHER_CONDITION_KEYS: Record<number, string> = {
  0: 'clear', 1: 'mainlyClear', 2: 'partlyCloudy', 3: 'overcast', 45: 'fog', 48: 'rimeFog',
  51: 'drizzleLight', 53: 'drizzleModerate', 55: 'drizzleDense', 56: 'freezingDrizzleLight', 57: 'freezingDrizzleDense',
  61: 'rainSlight', 63: 'rainModerate', 65: 'rainHeavy', 66: 'freezingRainLight', 67: 'freezingRainHeavy',
  71: 'snowSlight', 73: 'snowModerate', 75: 'snowHeavy', 77: 'snowGrains',
  80: 'showersSlight', 81: 'showersModerate', 82: 'showersViolent', 85: 'snowShowersSlight', 86: 'snowShowersHeavy',
  95: 'thunderstorm', 96: 'thunderstormHail', 99: 'thunderstormHeavyHail',
};

/**
 * The name of a weather condition, in the language of the bot messages given. The one source for a condition's name
 * in anything the person reads: the infographic, the weather-only message and the fallback forecast.
 */
export function describeWeather(code: number, t: BotMessages): string {
  const key = WEATHER_CONDITION_KEYS[code];
  return (key && t.weatherConditions[key]) || t.weatherConditions.unknown;
}

/**
 * Get 8-point compass label for wind direction in degrees
 */
export function getWindDirectionLabel(degrees: number, language?: string): string {
  const directionsByLang: Record<string, string[]> = {
    en: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
    he: ['צ׳', 'צמ״ז', 'מז׳', 'דמ״ז', 'ד׳', 'דמ״ע', 'מע׳', 'צמ״ע'],
    ru: ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'],
  };
  const directions = directionsByLang[language || 'en'] || directionsByLang.en;
  const index = Math.round(degrees / 45) % 8;
  return directions[index];
}

/**
 * Get emoji for weather code
 */
export function getWeatherEmoji(code: number): string {
  if (code === 0) return '☀️';
  if (code <= 3) return '⛅';
  if (code <= 48) return '🌫️';
  if (code <= 57) return '🌧️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌧️';
  if (code <= 86) return '❄️';
  if (code >= 95) return '⛈️';
  return '🌤️';
}
