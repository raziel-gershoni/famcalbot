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
import { getWeatherIcon } from './weather-icons';

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

function getWindArrow(degrees: number): string {
  return ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][Math.round(degrees / 45) % 8];
}

function getSharavBg(severity: string): string | undefined {
  if (severity === 'moderate') return 'rgba(255, 140, 0, 0.18)';
  if (severity === 'severe') return 'rgba(255, 60, 0, 0.25)';
  return undefined;
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
  windArrow: string;
  windSpeed: string;
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
    windArrow: d.windSpeedMax > 25 ? getWindArrow(d.windDirection) : '',
    windSpeed: d.windSpeedMax > 25 ? `${Math.round(d.windSpeedMax)}` : '',
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

  return (
    <div
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
          padding: '60px 40px',
          position: 'relative',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: 20,
          }}
        >
          <div style={{ display: 'flex', fontSize: 42, fontWeight: 700, marginBottom: 12 }}>
            {config.weather.location}
          </div>
          <div style={{ display: 'flex', fontSize: 28, opacity: 0.85 }}>
            {config.dateStr}
          </div>
          {config.hebrewDateStr && (
            <div style={{ display: 'flex', fontSize: 26, opacity: 0.75, marginTop: 8 }}>
              {config.hebrewDateStr}
            </div>
          )}
        </div>

        {/* Forecast rows */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            justifyContent: 'space-evenly',
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
                  padding: '12px 24px',
                  ...(sharavBg ? { background: sharavBg } : {}),
                }}
              >
                {/* Day label + optional sharav flame */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    width: 160,
                    fontSize: 28,
                    fontWeight: 700,
                    gap: 4,
                  }}
                >
                  {!isRTL && row.sharavSeverity && getWeatherIcon(-1, 22, '#ff6b35')}
                  <div style={{ display: 'flex' }}>{row.label}</div>
                  {isRTL && row.sharavSeverity && getWeatherIcon(-1, 22, '#ff6b35')}
                </div>

                {/* Weather icon */}
                <div style={{ display: 'flex', width: 56, justifyContent: 'center' }}>
                  {getWeatherIcon(row.weatherCode, 40)}
                </div>

                {/* Annotations (rain %, wind) */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    width: 90,
                    fontSize: 20,
                    opacity: 0.8,
                    alignItems: 'center',
                  }}
                >
                  {row.rain
                    ? <div style={{ display: 'flex', color: '#64b5f6' }}>{row.rain}</div>
                    : <div style={{ display: 'flex' }}>{' '}</div>}
                  {row.windArrow
                    ? <div style={{ display: 'flex' }}>{row.windArrow} {row.windSpeed}</div>
                    : <div style={{ display: 'flex' }}>{' '}</div>}
                </div>

                {/* Temperature bar */}
                <div
                  style={{
                    display: 'flex',
                    flex: 1,
                    height: 24,
                    borderRadius: 12,
                    background: 'rgba(255, 255, 255, 0.1)',
                    position: 'relative',
                    margin: '0 16px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      position: 'absolute',
                      left: `${barLeftPct}%`,
                      width: `${barWidthPct}%`,
                      height: '100%',
                      borderRadius: 12,
                      background: 'linear-gradient(90deg, #4fc3f7, #ff8a65)',
                    }}
                  />
                </div>

                {/* Temperature range */}
                <div
                  style={{
                    display: 'flex',
                    width: 140,
                    fontSize: 26,
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
  try {
    const condition = getWeatherDescription(weatherCode);
    const result = await Promise.race([
      getGemini().models.generateContent({
        model: GEMINI_IMAGE_MODEL,
        contents: `Generate a dark, moody atmospheric background for a ${condition} weather day. Abstract, no text, no icons, no data. Subtle gradient, dark tones suitable for white text overlay. Portrait orientation.`,
        config: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '9:16' },
        },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);

    const parts = result.candidates?.[0]?.content?.parts;
    if (!parts) return null;

    for (const part of parts) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('image/')) {
        return Buffer.from(part.inlineData.data, 'base64');
      }
    }
    return null;
  } catch (err) {
    console.log('[Infographic] Gemini background failed/timed out:', err instanceof Error ? err.message : 'unknown');
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

    // Start Gemini background in parallel with gradient satori render
    const bgPromise = generateGeminiBackground(config.weather.current.weatherCode);
    const gradientJsx = buildInfographicJsx(config, rows, globalMin, globalMax, false);
    const gradientSvg = await satori(gradientJsx, { width: WIDTH, height: HEIGHT, fonts });

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
    const resvg = new Resvg(finalSvg, {
      fitTo: { mode: 'width', value: WIDTH },
    });
    const pngBuffer = resvg.render().asPng();

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
