/**
 * Weather Infographic Generator
 * Uses satori (JSX -> SVG) + resvg (SVG -> PNG) for deterministic rendering.
 */

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { WeatherData } from '../../types';
import { detectSharav } from './sharav';
import { getLocalizedLocationName } from './geocoding';
import { getWeatherIcon, getWindArrowIcon, getWindCalmIcon, getUvIcon, getHumidityIcon, getUmbrellaIcon } from './weather-icons';
import { getWindDirectionLabel } from './open-meteo';
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();
const WIDTH = 1080;
const HEIGHT = 1920;

export interface InfographicConfig {
  weather: WeatherData;
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
  return new Date(date).toLocaleDateString(
    language === 'he' ? 'he-IL' : language === 'ru' ? 'ru-RU' : 'en-US',
    { weekday: 'short' },
  );
}

function getSharavBg(severity: string): string | undefined {
  if (severity === 'moderate') return 'rgba(255, 140, 0, 0.18)';
  if (severity === 'severe') return 'rgba(255, 60, 0, 0.25)';
  return undefined;
}

/** Get localized sharav label with optional break hour */
function getSharavLabel(language: string, breakHour?: number): string {
  const labels: Record<string, string> = { he: 'שרב', en: 'Sharav', ru: 'Шарав' };
  const label = labels[language] || labels.en;
  if (breakHour == null) return label;
  const time = `${breakHour}:00`;
  if (language === 'he') return `${label} (עד ${time})`;
  if (language === 'ru') return `${label} (до ${time})`;
  return `${label} (until ${time})`;
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

function getLocalizedWeatherDescription(code: number, language: string): string {
  const descriptions: Record<string, Record<number, string>> = {
    en: {
      0: 'Clear sky', 1: 'Partly cloudy', 45: 'Foggy', 51: 'Drizzle',
      61: 'Rain', 71: 'Snow', 80: 'Showers', 85: 'Snow showers', 95: 'Thunderstorm',
    },
    he: {
      0: 'שמיים בהירים', 1: 'מעונן חלקית', 45: 'ערפל', 51: 'טפטוף',
      61: 'גשם', 71: 'שלג', 80: 'ממטרים', 85: 'ממטרי שלג', 95: 'סופת רעמים',
    },
    ru: {
      0: 'Ясно', 1: 'Переменная облачность', 45: 'Туман', 51: 'Морось',
      61: 'Дождь', 71: 'Снег', 80: 'Ливень', 85: 'Снегопад', 95: 'Гроза',
    },
  };
  const lang = descriptions[language] || descriptions.en;
  // Map WMO code to grouped key
  let key: number;
  if (code === 0) key = 0;
  else if (code <= 3) key = 1;
  else if (code <= 48) key = 45;
  else if (code <= 57) key = 51;
  else if (code <= 67) key = 61;
  else if (code <= 77) key = 71;
  else if (code <= 82) key = 80;
  else if (code <= 86) key = 85;
  else key = 95;
  return lang[key] || descriptions.en[key] || 'Unknown';
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
  uvIndex: string;
  humidity: string;
  sharavSeverity?: string;
  sharavBreakHour?: number;
}

function computeRows(config: InfographicConfig): { rows: RowData[]; globalMin: number; globalMax: number } {
  const daily = (config.weather.daily || []).slice(0, 12);
  const sharavDays = detectSharav(config.weather);
  const sharavByDate = new Map(sharavDays.map(s => [s.date, s]));

  const rows: RowData[] = daily.map((d, i) => ({
    label: getDayLabel(i, d.date, config.language),
    weatherCode: d.weatherCode,
    tempMin: d.tempMin,
    tempMax: d.tempMax,
    rain: d.precipitationProbability > 20 ? `${d.precipitationProbability}%` : '',
    windDeg: d.windDirection,
    windSpeed: `${Math.round(d.windSpeedMax)}`,
    uvIndex: `${d.uvIndexMax}`,
    humidity: `${Math.round(d.humidity)}%`,
    sharavSeverity: sharavByDate.get(d.date)?.severity,
    sharavBreakHour: sharavByDate.get(d.date)?.sharavBreakHour,
  }));

  const globalMin = Math.min(...rows.map(r => r.tempMin)) - 2;
  const globalMax = Math.max(...rows.map(r => r.tempMax)) + 2;
  return { rows, globalMin, globalMax };
}

// ---------------------------------------------------------------------------
// Build satori JSX
// ---------------------------------------------------------------------------

function buildInfographicJsx(
  config: InfographicConfig,
  rows: RowData[],
  globalMin: number,
  globalMax: number,
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
            {isRTL
              ? toVisualOrder(getLocalizedWeatherDescription(config.weather.current.weatherCode, config.language))
              : getLocalizedWeatherDescription(config.weather.current.weatherCode, config.language)}
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
              <div style={{ display: 'flex', fontSize: 30 }}>{config.weather.today.precipitationProbability}%</div>
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
                UV {config.weather.current.uvIndex}
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

            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  flexDirection: isRTL ? 'row-reverse' : 'row',
                  alignItems: 'center',
                  borderRadius: 16,
                  padding: '4px 20px',
                  ...(sharavBg ? { background: sharavBg } : {}),
                }}
              >
                {/* Day label + optional sharav badge below */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    width: 150,
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
                  {/* Condition column: icon + rain % */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 60, gap: 2 }}>
                    <div style={{ display: 'flex' }}>
                      {getWeatherIcon(row.weatherCode, 44)}
                    </div>
                    <div style={{ display: 'flex', fontSize: 26, color: '#64b5f6' }}>
                      {row.rain || '\u00A0'}
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
                  {/* UV column: icon + index */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 56, gap: 2 }}>
                    <div style={{ display: 'flex', height: 44, alignItems: 'center', justifyContent: 'center' }}>
                      {getUvIcon(30, getUvColor(parseFloat(row.uvIndex)))}
                    </div>
                    <div style={{ display: 'flex', fontSize: 26, color: getUvColor(parseFloat(row.uvIndex)) }}>
                      {row.uvIndex}
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
    const { rows, globalMin, globalMax } = computeRows(config);

    // Localize location name (cached, non-blocking fallback to English)
    if (config.language !== 'en') {
      try {
        const localizedName = await getLocalizedLocationName(config.weather.location, config.language);
        config = { ...config, weather: { ...config.weather, location: localizedName } };
      } catch { /* keep English name */ }
    }

    const jsx = buildInfographicJsx(config, rows, globalMin, globalMax);
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
