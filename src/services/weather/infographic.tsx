/**
 * Weather Infographic Generator
 * Uses satori (JSX -> SVG) + resvg (SVG -> PNG) for deterministic rendering.
 */

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AirQualityData, WeatherData } from '../../types';
import { detectDustStorm } from './dust-storm';
import { detectSharav } from './sharav';
import { getLocalizedLocationName } from './geocoding';
import { getWeatherIcon, getWindArrowIcon, getWindCalmIcon, getUvIcon, getHumidityIcon, getUmbrellaIcon } from './weather-icons';
import { describeWeather, FORECAST_DAYS, getWindDirectionLabel } from './forecast';
import { formatNumber, formatRainAmount } from './rain';
import { getBotMessages, type BotMessages } from '../../lib/bot-messages';
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();
const WIDTH = 1080;
const HEIGHT = 1920;

export interface InfographicConfig {
  weather: WeatherData;
  airQuality?: AirQualityData | null;
  language: string;
  dateStr: string;
  hebrewDateStr?: string;
  timezone: string;
}

// ---------------------------------------------------------------------------
// Font loading (cached for process lifetime)
// ---------------------------------------------------------------------------

type Weight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
type FontEntry = { name: string; data: Buffer; weight: Weight; style: 'normal' | 'italic'; lang?: string };
let cachedFonts: FontEntry[] | null = null;

function loadFonts(): FontEntry[] {
  if (cachedFonts) return cachedFonts;
  const dir = join(process.cwd(), 'public', 'fonts');
  const regular = readFileSync(join(dir, 'NotoSans-Regular.ttf'));
  const bold = readFileSync(join(dir, 'NotoSans-Bold.ttf'));
  cachedFonts = [
    { name: 'Noto Sans', data: regular, weight: 400, style: 'normal' },
    { name: 'Noto Sans', data: bold, weight: 700, style: 'normal' },
  ];
  try {
    const hebrewRegular = readFileSync(join(dir, 'NotoSansHebrew-Regular.ttf'));
    const hebrewBold = readFileSync(join(dir, 'NotoSansHebrew-Bold.ttf'));
    cachedFonts.push(
      { name: 'Noto Sans', data: hebrewRegular, weight: 400, style: 'normal', lang: 'he-IL' },
      { name: 'Noto Sans', data: hebrewBold, weight: 700, style: 'normal', lang: 'he-IL' },
    );
  } catch {
    console.warn('[Infographic] Hebrew font not found, Hebrew may not render correctly');
  }
  return cachedFonts;
}

// ---------------------------------------------------------------------------
// Background gradient by WMO weather code
// ---------------------------------------------------------------------------

function getBackgroundGradient(code: number): [string, string] {
  if (code === 0) return ['#1a1a3e', '#2d1b69'];       // Clear
  if (code <= 3) return ['#1e3a5f', '#2c5f8a'];        // Partly cloudy
  if (code <= 48) return ['#2a2a3a', '#3d3d5c'];       // Fog
  if (code <= 67) return ['#1a2a3e', '#2d4a6e'];       // Rain
  if (code <= 77) return ['#2a3a4a', '#4a5a6a'];       // Snow
  if (code >= 95) return ['#1a1a2e', '#3d1a5c'];       // Thunderstorm
  return ['#1a1a3e', '#2d1b69'];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDayLabel(index: number, date: string, language: string): string {
  if (index === 0) return language === 'he' ? 'היום' : language === 'ru' ? 'Сегодня' : 'Today';
  if (index === 1) return language === 'he' ? 'מחר' : language === 'ru' ? 'Завтра' : 'Tomorrow';
  // The day is a plain date: read it as the UTC day it names, not as the server's local day
  return new Date(date).toLocaleDateString(
    language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US',
    { weekday: 'short', timeZone: 'UTC' },
  );
}

function getSharavBg(severity: string): string | undefined {
  if (severity === 'mild') return 'rgba(255, 200, 50, 0.14)';
  if (severity === 'moderate') return 'rgba(255, 170, 0, 0.22)';
  if (severity === 'severe') return 'rgba(255, 60, 0, 0.25)';
  return undefined;
}

/** Get localized sharav label with optional break hour */
function getSharavLabel(language: string, breakHour?: number): string {
  const labels: Record<string, string> = { he: 'שרב', en: 'Sharav', ru: 'Шарав' };
  const label = labels[language] || labels.en;
  if (breakHour == null) return label;
  const time = `${breakHour}:00`;
  if (language === 'he') return `${label} עד ${time}`;
  if (language === 'ru') return `${label} до ${time}`;
  return `${label} till ${time}`;
}

function getDustStormBg(severity: string): string | undefined {
  if (severity === 'mild') return 'rgba(255, 200, 50, 0.14)';
  if (severity === 'moderate') return 'rgba(255, 170, 0, 0.22)';
  if (severity === 'severe') return 'rgba(255, 60, 0, 0.25)';
  return undefined;
}

/** Get localized dust storm label with optional clearing hour */
function getDustStormLabel(language: string, clearingHour?: number): string {
  const labels: Record<string, string> = { he: 'סופת אבק', en: 'Dust Storm', ru: 'Пылевая буря' };
  const label = labels[language] || labels.en;
  if (clearingHour == null) return label;
  const time = `${clearingHour}:00`;
  if (language === 'he') return `${label} עד ${time}`;
  if (language === 'ru') return `${label} до ${time}`;
  return `${label} till ${time}`;
}

/** UV index color by danger level (WHO scale) */
function getUvColor(uv: number): string {
  if (uv <= 2) return '#4caf50';   // Low — green
  if (uv <= 5) return '#f0c040';   // Moderate — yellow
  if (uv <= 7) return '#ff9800';   // High — orange
  if (uv <= 10) return '#f44336';  // Very high — red
  return '#9c27b0';                // Extreme — purple
}

/** Convert logical-order text to visual order for satori (which lacks bidi support) */
function toVisualOrder(text: string): string {
  const embeddingLevels = bidi.getEmbeddingLevels(text, 'rtl');
  return bidi.getReorderedString(text, embeddingLevels);
}

/** Map language code to BCP 47 lang attribute for satori bidi support */
function getLangAttr(language: string): string {
  if (language === 'he') return 'he-IL';
  if (language === 'ru') return 'ru-RU';
  return 'en-US';
}

// ---------------------------------------------------------------------------
// Current conditions i18n helpers
// ---------------------------------------------------------------------------

function getFeelsLikeLabel(language: string): string {
  if (language === 'he') return 'מרגיש כמו';
  if (language === 'ru') return 'Ощущается как';
  return 'Feels like';
}

function getWindUnitLabel(language: string): string {
  if (language === 'he') return 'קמ״ש';
  if (language === 'ru') return 'км/ч';
  return 'km/h';
}

// ---------------------------------------------------------------------------
// Compute render data
// ---------------------------------------------------------------------------

interface RowData {
  label: string;
  weatherCode: number;
  tempMin: number;
  tempMax: number;
  rain: string;
  windDeg: number;
  windSpeed: string;
  /** The UV as the person reads it ('5,1' in Russian); '' where MET gives none. */
  uvIndex: string;
  /** The UV as a number, for its colour; null where MET gives none. */
  uvValue: number | null;
  humidity: string;
  sharavSeverity?: string;
  sharavBreakHour?: number;
  dustStormSeverity?: string;
  dustClearingHour?: number;
}

/** The forecast's rows as the image draws them (exported for the smokes). */
export function computeRows(config: InfographicConfig, t: BotMessages): { rows: RowData[]; globalMin: number; globalMax: number } {
  const daily = (config.weather.daily || []).slice(0, FORECAST_DAYS);
  const sharavDays = detectSharav(config.weather);
  const sharavByDate = new Map(sharavDays.map(s => [s.date, s]));
  const dustDays = detectDustStorm(config.airQuality ?? null);
  const dustByDate = new Map(dustDays.map(d => [d.date, d]));

  const rows: RowData[] = daily.map((d, i) => ({
    label: getDayLabel(i, d.date, config.language),
    weatherCode: d.weatherCode,
    tempMin: d.tempMin,
    tempMax: d.tempMax,
    rain: d.precipitation > 0 ? formatRainAmount(d.precipitation, t, config.language) : '',
    windDeg: d.windDirection,
    windSpeed: `${Math.round(d.windSpeedMax)}`,
    uvIndex: d.uvIndexMax === null ? '' : formatNumber(d.uvIndexMax, config.language),
    uvValue: d.uvIndexMax,
    humidity: `${Math.round(d.humidity)}%`,
    sharavSeverity: sharavByDate.get(d.date)?.severity,
    sharavBreakHour: sharavByDate.get(d.date)?.sharavBreakHour,
    dustStormSeverity: dustByDate.get(d.date)?.severity,
    dustClearingHour: dustByDate.get(d.date)?.clearingHour,
  }));

  const globalMin = Math.min(...rows.map(r => r.tempMin)) - 2;
  const globalMax = Math.max(...rows.map(r => r.tempMax)) + 2;
  return { rows, globalMin, globalMax };
}

// ---------------------------------------------------------------------------
// Build satori JSX
// ---------------------------------------------------------------------------

/** The image's element tree (exported for the smokes, which walk it for the credit). */
export function buildInfographicJsx(
  config: InfographicConfig,
  rows: RowData[],
  globalMin: number,
  globalMax: number,
  conditionText: string,
  rainToday: string,
  credit: string,
): React.ReactElement {
  const [gradFrom, gradTo] = getBackgroundGradient(config.weather.current.weatherCode);
  const isRTL = config.language === 'he';
  const range = globalMax - globalMin;
  const lang = getLangAttr(config.language);

  return (
    <div
      lang={lang}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: WIDTH,
        height: HEIGHT,
        fontFamily: 'Noto Sans',
        color: 'white',
        position: 'relative',
      }}
    >
      {/* Background layer */}
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          top: 0,
          left: 0,
          width: WIDTH,
          height: HEIGHT,
          background: `linear-gradient(180deg, ${gradFrom}, ${gradTo})`,
        }}
      />

      {/* Content */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          padding: '40px 36px',
          position: 'relative',
          direction: isRTL ? 'rtl' : 'ltr',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <div style={{ display: 'flex', fontSize: 48, fontWeight: 700, marginBottom: 10 }}>
            {isRTL ? toVisualOrder(config.weather.location) : config.weather.location}
          </div>
          <div style={{ display: 'flex', fontSize: 38, opacity: 0.85 }}>
            {isRTL ? toVisualOrder(config.dateStr) : config.dateStr}
          </div>
          {config.hebrewDateStr && (
            <div style={{ display: 'flex', fontSize: 34, opacity: 0.75, marginTop: 6 }}>
              {isRTL ? toVisualOrder(config.hebrewDateStr) : config.hebrewDateStr}
            </div>
          )}
        </div>

        {/* Current conditions */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          {/* Hero: icon + temperature */}
          <div
            style={{
              display: 'flex',
              flexDirection: isRTL ? 'row-reverse' : 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 16,
            }}
          >
            {getWeatherIcon(config.weather.current.weatherCode, 80)}
            <div style={{ display: 'flex', fontSize: 72, fontWeight: 700 }}>
              {Math.round(config.weather.current.temperature)}°
            </div>
          </div>
          {/* Condition text */}
          <div style={{ display: 'flex', fontSize: 34, opacity: 0.85, marginTop: 4 }}>
            {isRTL ? toVisualOrder(conditionText) : conditionText}
          </div>
          {/* Feels like */}
          <div style={{ display: 'flex', fontSize: 32, opacity: 0.7, marginTop: 4 }}>
            {isRTL
              ? toVisualOrder(`${getFeelsLikeLabel(config.language)} ${Math.round(config.weather.current.feelsLike)}°`)
              : `${getFeelsLikeLabel(config.language)} ${Math.round(config.weather.current.feelsLike)}°`}
          </div>
          {/* Stats row: wind | humidity | UV */}
          <div
            style={{
              display: 'flex',
              flexDirection: isRTL ? 'row-reverse' : 'row',
              justifyContent: 'center',
              gap: 48,
              marginTop: 16,
            }}
          >
            {/* Wind */}
            <div style={{ display: 'flex', flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'center', gap: 6 }}>
              <div style={{ display: 'flex' }}>
                {config.weather.current.windSpeed === 0
                  ? getWindCalmIcon(28, 'white')
                  : getWindArrowIcon(config.weather.current.windDirection, 28, 'white')}
              </div>
              <div style={{ display: 'flex', fontSize: 30 }}>
                {isRTL
                  ? toVisualOrder(`${Math.round(config.weather.current.windSpeed)} ${getWindUnitLabel(config.language)} ${getWindDirectionLabel(config.weather.current.windDirection, config.language)}`)
                  : `${Math.round(config.weather.current.windSpeed)} ${getWindUnitLabel(config.language)} ${getWindDirectionLabel(config.weather.current.windDirection, config.language)}`}
              </div>
            </div>
            {/* Precipitation */}
            <div style={{ display: 'flex', flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'center', gap: 6 }}>
              <div style={{ display: 'flex' }}>{getUmbrellaIcon(28, '#64b5f6')}</div>
              <div style={{ display: 'flex', fontSize: 30 }}>{isRTL ? toVisualOrder(rainToday) : rainToday}</div>
            </div>
            {/* Humidity */}
            <div style={{ display: 'flex', flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'center', gap: 6 }}>
              <div style={{ display: 'flex' }}>{getHumidityIcon(28)}</div>
              <div style={{ display: 'flex', fontSize: 30 }}>{config.weather.current.humidity}%</div>
            </div>
            {/* UV */}
            <div style={{ display: 'flex', flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'center', gap: 6 }}>
              <div style={{ display: 'flex' }}>{getUvIcon(28, getUvColor(config.weather.current.uvIndex))}</div>
              <div style={{ display: 'flex', fontSize: 30, color: getUvColor(config.weather.current.uvIndex) }}>
                UV {formatNumber(config.weather.current.uvIndex, config.language)}
              </div>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div
          style={{
            display: 'flex',
            width: '100%',
            height: 1,
            background: 'rgba(255, 255, 255, 0.15)',
            marginBottom: 8,
          }}
        />

        {/* Forecast rows */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            justifyContent: 'space-around',
          }}
        >
          {rows.map((row, i) => {
            const barLeftPct = ((row.tempMin - globalMin) / range) * 100;
            const barWidthPct = Math.max(((row.tempMax - row.tempMin) / range) * 100, 3);
            const sharavBg = row.sharavSeverity ? getSharavBg(row.sharavSeverity) : undefined;
            const dustBg = row.dustStormSeverity ? getDustStormBg(row.dustStormSeverity) : undefined;
            const rowBg = sharavBg || dustBg;

            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  flexDirection: isRTL ? 'row-reverse' : 'row',
                  alignItems: 'center',
                  borderRadius: 16,
                  padding: '4px 20px',
                  ...(rowBg ? { background: rowBg } : {}),
                }}
              >
                {/* Day label + optional sharav badge below */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    width: 200,
                  }}
                >
                  <div style={{ display: 'flex', fontSize: 38, fontWeight: 700 }}>
                    {isRTL ? toVisualOrder(row.label) : row.label}
                  </div>
                  {row.sharavSeverity && (
                    <div style={{
                      display: 'flex',
                      fontSize: 20,
                      fontWeight: 700,
                      color: '#ff6b35',
                      marginTop: -2,
                    }}>
                      {isRTL
                        ? toVisualOrder(getSharavLabel(config.language, row.sharavBreakHour))
                        : getSharavLabel(config.language, row.sharavBreakHour)}
                    </div>
                  )}
                  {row.dustStormSeverity && (
                    <div style={{
                      display: 'flex',
                      fontSize: 20,
                      fontWeight: 700,
                      color: '#c4a035',
                      marginTop: -2,
                    }}>
                      {isRTL
                        ? toVisualOrder(getDustStormLabel(config.language, row.dustClearingHour))
                        : getDustStormLabel(config.language, row.dustClearingHour)}
                    </div>
                  )}
                </div>

                {/* Detail columns: condition | wind | UV */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: isRTL ? 'row-reverse' : 'row',
                    gap: 8,
                    margin: '0 8px',
                  }}
                >
                  {/* Condition column: icon + the day's rain in mm */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 84, gap: 2 }}>
                    <div style={{ display: 'flex' }}>
                      {getWeatherIcon(row.weatherCode, 44)}
                    </div>
                    <div style={{ display: 'flex', fontSize: 22, color: '#64b5f6' }}>
                      {row.rain ? (isRTL ? toVisualOrder(row.rain) : row.rain) : '\u00A0'}
                    </div>
                  </div>
                  {/* Wind column: arrow + speed */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 56, gap: 2, opacity: 0.8 }}>
                    <div style={{ display: 'flex', height: 44, alignItems: 'center', justifyContent: 'center' }}>
                      {row.windSpeed === '0' ? getWindCalmIcon(30, 'white') : getWindArrowIcon(row.windDeg, 30, 'white')}
                    </div>
                    <div style={{ display: 'flex', fontSize: 26 }}>
                      {row.windSpeed}
                    </div>
                  </div>
                  {/* Humidity column: droplet + % */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 56, gap: 2 }}>
                    <div style={{ display: 'flex', height: 44, alignItems: 'center', justifyContent: 'center' }}>
                      {getHumidityIcon(30, '#64b5f6')}
                    </div>
                    <div style={{ display: 'flex', fontSize: 26, color: '#64b5f6' }}>
                      {row.humidity}
                    </div>
                  </div>
                  {/* UV column: icon + index; empty where MET's UV does not reach (past about 2.5 days) */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 56, gap: 2 }}>
                    <div style={{ display: 'flex', height: 44, alignItems: 'center', justifyContent: 'center' }}>
                      {row.uvValue !== null ? getUvIcon(30, getUvColor(row.uvValue)) : null}
                    </div>
                    <div style={{ display: 'flex', fontSize: 26, color: row.uvValue !== null ? getUvColor(row.uvValue) : undefined }}>
                      {row.uvIndex || '\u00A0'}
                    </div>
                  </div>
                </div>

                {/* Temperature bar with labels at edges */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: isRTL ? 'row-reverse' : 'row',
                    flex: 1,
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', fontSize: 30, fontWeight: 600, width: 56, justifyContent: isRTL ? 'flex-start' : 'flex-end' }}>
                    {row.tempMin}°
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flex: 1,
                      height: 36,
                      borderRadius: 18,
                      background: 'rgba(255, 255, 255, 0.1)',
                      position: 'relative',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        position: 'absolute',
                        left: `${isRTL ? 100 - barLeftPct - barWidthPct : barLeftPct}%`,
                        width: `${barWidthPct}%`,
                        height: '100%',
                        borderRadius: 18,
                        background: isRTL
                          ? 'linear-gradient(270deg, #4fc3f7, #ff8a65)'
                          : 'linear-gradient(90deg, #4fc3f7, #ff8a65)',
                      }}
                    />
                  </div>
                  <div style={{ display: 'flex', fontSize: 30, fontWeight: 600, width: 56, justifyContent: isRTL ? 'flex-end' : 'flex-start' }}>
                    {row.tempMax}°
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* The data sources' credit (spec 2026-10-31-open-meteo-replacement, decision 3), small, at the foot */}
        <div style={{ display: 'flex', justifyContent: 'center', fontSize: 22, opacity: 0.55, marginTop: 12 }}>
          {isRTL ? toVisualOrder(credit) : credit}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateWeatherInfographic(config: InfographicConfig): Promise<Buffer | null> {
  const startMs = Date.now();

  console.log('[Infographic] Generating with satori+resvg:', {
    location: config.weather.location,
    language: config.language,
  });

  try {
    const fonts = loadFonts();
    const t = await getBotMessages(config.language);
    const { rows, globalMin, globalMax } = computeRows(config, t);

    // Localize location name (cached, non-blocking fallback to English)
    if (config.language !== 'en') {
      try {
        const localizedName = await getLocalizedLocationName(config.weather.location, config.language);
        config = { ...config, weather: { ...config.weather, location: localizedName } };
      } catch { /* keep English name */ }
    }

    const conditionText = describeWeather(config.weather.current.weatherCode, t);
    const rainToday = formatRainAmount(config.weather.today.precipitation, t, config.language);
    const jsx = buildInfographicJsx(config, rows, globalMin, globalMax, conditionText, rainToday, t.weatherCredit);
    const satoriStartMs = Date.now();
    const svg = await satori(jsx, { width: WIDTH, height: HEIGHT, fonts });
    console.log('[Infographic] Satori render:', { durationMs: Date.now() - satoriStartMs });

    // Render SVG -> PNG
    const resvgStartMs = Date.now();
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: WIDTH },
    });
    const pngBuffer = resvg.render().asPng();
    console.log('[Infographic] Resvg render:', { durationMs: Date.now() - resvgStartMs });

    const elapsed = Date.now() - startMs;
    console.log('[Infographic] Generated successfully:', {
      sizeKB: (pngBuffer.length / 1024).toFixed(1),
      durationMs: elapsed,
    });

    return Buffer.from(pngBuffer);
  } catch (error) {
    const elapsed = Date.now() - startMs;
    console.error('[Infographic] Generation failed:', { error, durationMs: elapsed });
    return null;
  }
}
