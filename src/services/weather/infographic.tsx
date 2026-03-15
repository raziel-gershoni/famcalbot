/**
 * Weather Infographic Generator
 * Uses satori (JSX -> SVG) + resvg (SVG -> PNG) for deterministic rendering.
 * Optional Gemini atmospheric background with gradient fallback.
 */

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getGemini } from '../ai-provider';
import { WeatherData } from '../../types';
import { detectSharav } from './sharav';
import { getWeatherDescription } from './open-meteo';
import { getLocalizedLocationName } from './geocoding';
import { getWeatherIcon, getWindArrowIcon, getWindCalmIcon, getUvIcon } from './weather-icons';
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image-preview';
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
  sharavSeverity?: string;
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
    sharavSeverity: sharavByDate.get(d.date)?.severity,
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
  hasGeminiBg: boolean,
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
          background: hasGeminiBg
            ? 'rgba(0, 0, 0, 0.55)'
            : `linear-gradient(180deg, ${gradFrom}, ${gradTo})`,
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
                {/* Day label + optional sharav flame */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    width: 150,
                    fontSize: 38,
                    fontWeight: 700,
                    gap: 4,
                  }}
                >
                  {!isRTL && row.sharavSeverity && getWeatherIcon(-1, 28, '#ff6b35')}
                  <div style={{ display: 'flex' }}>{isRTL ? toVisualOrder(row.label) : row.label}</div>
                  {isRTL && row.sharavSeverity && getWeatherIcon(-1, 28, '#ff6b35')}
                </div>

                {/* Detail columns: condition | wind | UV */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: isRTL ? 'row-reverse' : 'row',
                    gap: 8,
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
                  {/* UV column: icon + index */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 56, gap: 2 }}>
                    <div style={{ display: 'flex', height: 44, alignItems: 'center', justifyContent: 'center' }}>
                      {getUvIcon(30, '#f0c040')}
                    </div>
                    <div style={{ display: 'flex', fontSize: 26, color: '#f0c040' }}>
                      {row.uvIndex}
                    </div>
                  </div>
                </div>

                {/* Temperature bar */}
                <div
                  style={{
                    display: 'flex',
                    flex: 1,
                    height: 36,
                    borderRadius: 18,
                    background: 'rgba(255, 255, 255, 0.1)',
                    position: 'relative',
                    margin: '0 14px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      position: 'absolute',
                      left: `${barLeftPct}%`,
                      width: `${barWidthPct}%`,
                      height: '100%',
                      borderRadius: 18,
                      background: 'linear-gradient(90deg, #4fc3f7, #ff8a65)',
                    }}
                  />
                </div>

                {/* Temperature range */}
                <div
                  style={{
                    display: 'flex',
                    width: 150,
                    fontSize: 36,
                    fontWeight: 600,
                    justifyContent: isRTL ? 'flex-start' : 'flex-end',
                  }}
                >
                  {row.tempMin}°–{row.tempMax}°
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
// Gemini atmospheric background (optional, with timeout + fallback)
// ---------------------------------------------------------------------------

async function generateGeminiBackground(weatherCode: number): Promise<Buffer | null> {
  const bgStartMs = Date.now();
  try {
    const condition = getWeatherDescription(weatherCode);
    console.log('[Infographic] Gemini background: requesting', { model: GEMINI_IMAGE_MODEL, condition });

    const result = await getGemini().models.generateContent({
      model: GEMINI_IMAGE_MODEL,
      contents: `Generate a dark, moody atmospheric background for a ${condition} weather day. Abstract, no text, no icons, no data. Subtle gradient, dark tones suitable for white text overlay. Portrait orientation.`,
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '9:16' },
      },
    });

    const candidate = result.candidates?.[0];
    const parts = candidate?.content?.parts;
    const finishReason = candidate?.finishReason;

    if (!parts || parts.length === 0) {
      console.warn('[Infographic] Gemini background: no parts in response', {
        finishReason,
        hasCandidates: !!result.candidates?.length,
        durationMs: Date.now() - bgStartMs,
      });
      return null;
    }

    for (const part of parts) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('image/')) {
        const buffer = Buffer.from(part.inlineData.data, 'base64');
        console.log('[Infographic] Gemini background: success', {
          sizeKB: (buffer.length / 1024).toFixed(1),
          mimeType: part.inlineData.mimeType,
          durationMs: Date.now() - bgStartMs,
        });
        return buffer;
      }
      if (part.text) {
        console.warn('[Infographic] Gemini background: got text instead of image', {
          textPreview: part.text.slice(0, 200),
          finishReason,
          durationMs: Date.now() - bgStartMs,
        });
      }
    }

    console.warn('[Infographic] Gemini background: no image data in parts', {
      partTypes: parts.map(p => p.inlineData ? `image/${p.inlineData.mimeType}` : p.text ? 'text' : 'unknown'),
      finishReason,
      durationMs: Date.now() - bgStartMs,
    });
    return null;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStatus = (err as { status?: number }).status;
    console.warn('[Infographic] Gemini background: failed', {
      error: errMsg,
      status: errStatus,
      durationMs: Date.now() - bgStartMs,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// SVG background injection
// ---------------------------------------------------------------------------

function injectBackground(svg: string, bgPng: Buffer): string {
  const b64 = bgPng.toString('base64');
  const imgTag = `<image href="data:image/png;base64,${b64}" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice" />`;
  // Insert after the first closing > of the <svg> tag
  const firstClose = svg.indexOf('>');
  return svg.slice(0, firstClose + 1) + imgTag + svg.slice(firstClose + 1);
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

    // Start Gemini background in parallel with gradient satori render
    const bgPromise = generateGeminiBackground(config.weather.current.weatherCode);
    const gradientJsx = buildInfographicJsx(config, rows, globalMin, globalMax, false);
    const satoriStartMs = Date.now();
    const gradientSvg = await satori(gradientJsx, { width: WIDTH, height: HEIGHT, fonts });
    console.log('[Infographic] Satori render:', { durationMs: Date.now() - satoriStartMs });

    // Wait for Gemini result
    const bgBuffer = await bgPromise;

    let finalSvg: string;
    if (bgBuffer) {
      // Re-render with transparent bg + dark overlay, then inject Gemini image
      const overlayJsx = buildInfographicJsx(config, rows, globalMin, globalMax, true);
      const overlaySvg = await satori(overlayJsx, { width: WIDTH, height: HEIGHT, fonts });
      finalSvg = injectBackground(overlaySvg, bgBuffer);
      console.log('[Infographic] Using Gemini background');
    } else {
      finalSvg = gradientSvg;
      console.log('[Infographic] Using gradient fallback');
    }

    // Render SVG -> PNG
    const resvgStartMs = Date.now();
    const resvg = new Resvg(finalSvg, {
      fitTo: { mode: 'width', value: WIDTH },
    });
    const pngBuffer = resvg.render().asPng();
    console.log('[Infographic] Resvg render:', { durationMs: Date.now() - resvgStartMs });

    const elapsed = Date.now() - startMs;
    console.log('[Infographic] Generated successfully:', {
      sizeKB: (pngBuffer.length / 1024).toFixed(1),
      durationMs: elapsed,
      hasGeminiBg: !!bgBuffer,
    });

    return Buffer.from(pngBuffer);
  } catch (error) {
    const elapsed = Date.now() - startMs;
    console.error('[Infographic] Generation failed:', { error, durationMs: elapsed });
    return null;
  }
}
