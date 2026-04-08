/**
 * Summary Card Image Generator
 * Generates a 1080x1920 PNG card from summary text for Telegram Story sharing.
 * Uses satori (JSX → SVG) + resvg (SVG → PNG), same pipeline as weather infographic.
 */

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();
const WIDTH = 1080;
const HEIGHT = 1920;

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
    // Hebrew font optional
  }
  return cachedFonts;
}

/**
 * Strip HTML tags and clean up text for card rendering
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*📊.*$/s, '') // Strip admin footer (metrics line)
    .trim();
}

/**
 * Convert logical-order Hebrew text to visual order for satori.
 * Satori doesn't support bidi — we must reorder characters ourselves.
 */
function toVisualOrder(text: string, lang: string): string {
  if (lang !== 'he') return text;
  try {
    const embeddingLevels = bidi.getEmbeddingLevels(text, 'rtl');
    return bidi.getReorderedString(text, embeddingLevels);
  } catch {
    return text;
  }
}

/**
 * Pre-break long lines at word boundaries, then bidi each segment.
 * Simulates what browsers do: line-break first, then apply bidi per visual line.
 * Short lines pass through untouched.
 */
function wrapAndBidi(text: string, lang: string, maxChars: number): string {
  return text.split('\n').map(line => {
    if (line.length <= maxChars) return toVisualOrder(line, lang);
    const words = line.split(' ');
    const segments: string[] = [];
    let current = '';
    for (const word of words) {
      if (current && (current.length + 1 + word.length) > maxChars) {
        segments.push(toVisualOrder(current, lang));
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    if (current) segments.push(toVisualOrder(current, lang));
    return segments.join('\n');
  }).join('\n');
}

export interface SummaryCardConfig {
  text: string;       // HTML summary text
  language: string;   // en, he, ru
  userName?: string;
}

/**
 * Generate a summary card PNG image for story sharing
 */
export async function generateSummaryCard(config: SummaryCardConfig): Promise<Buffer> {
  const t0 = Date.now();
  const { text, language, userName } = config;
  const isRtl = language === 'he';
  const plainText = stripHtml(text);

  const lineCount = plainText.split('\n').length;
  const fontSize = lineCount > 25 ? 28 : lineCount > 18 ? 32 : 36;
  const charsPerLine = Math.floor((WIDTH - 216) / (fontSize * 0.52));

  const jsx = (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      width: WIDTH,
      height: HEIGHT,
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      padding: '80px 60px',
      fontFamily: 'Noto Sans',
      color: 'white',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: isRtl ? 'flex-end' : 'flex-start',
        alignItems: 'center',
        gap: '20px',
        marginBottom: '40px',
      }}>
        {!isRtl && (
          <div style={{ display: 'flex', fontSize: '48px', fontWeight: 700, letterSpacing: '-1px' }}>
            FamCal
          </div>
        )}
        {userName && (
          <div style={{ display: 'flex', fontSize: '32px', opacity: 0.8 }}>
            {toVisualOrder(userName, language)}
          </div>
        )}
        {isRtl && (
          <div style={{ display: 'flex', fontSize: '48px', fontWeight: 700, letterSpacing: '-1px' }}>
            FamCal
          </div>
        )}
      </div>

      {/* Summary content */}
      <div style={{
        flexGrow: 1,
        background: 'rgba(255, 255, 255, 0.1)',
        borderRadius: '24px',
        padding: '48px',
        overflow: 'hidden',
        fontSize: `${fontSize}px`,
        lineHeight: 1.6,
        textAlign: isRtl ? 'right' : 'left',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {isRtl ? wrapAndBidi(plainText, language, charsPerLine) : plainText}
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        marginTop: '40px',
        fontSize: '28px',
        opacity: 0.6,
      }}>
        famcal.bot
      </div>
    </div>
  );

  const fonts = loadFonts();
  const svg = await satori(jsx, { width: WIDTH, height: HEIGHT, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } });
  const png = resvg.render().asPng();

  console.log(`[SummaryCard] Generated in ${Date.now() - t0}ms (${lineCount} lines, ${png.length} bytes)`);
  return Buffer.from(png);
}
