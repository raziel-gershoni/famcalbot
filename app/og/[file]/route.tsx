import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { getTranslations } from 'next-intl/server';
import { APP_TOKENS } from '@/components/app-ui/tokens';
import { routing } from '@/i18n/routing';
import { wrapAndBidi } from '@/src/lib/bidi-lines';
import { OG_SIZE } from '@/src/site/seo';
import { BRAND } from '@/src/site/site-css';

// The public site's share image, one per language (spec 2026-10-28-public-website §6.4): /og/en.png, /og/he.png,
// /og/ru.png, 1200 x 630, made with next/og at build time. It carries the app's icon, landing.meta.ogImageAlt (the
// image's alt text too) and the two apps' names in their buttons' colours. Hebrew is broken into lines and put in
// visual order first (satori knows no bidi). The fonts are the repo's Noto Sans, Latin, Cyrillic and Hebrew.
// A path with a dot, so the proxy adds no locale.

export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ file: `${locale}.png` }));
}

const fonts = () => {
  const dir = join(process.cwd(), 'public', 'fonts');
  return [
    { name: 'Noto Sans', data: readFileSync(join(dir, 'NotoSans-Bold.ttf')), weight: 700 as const, style: 'normal' as const },
    { name: 'Noto Sans', data: readFileSync(join(dir, 'NotoSansHebrew-Bold.ttf')), weight: 700 as const, style: 'normal' as const, lang: 'he-IL' },
  ];
};

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const locale = file.replace(/\.png$/, '');
  if (!routing.locales.includes(locale as (typeof routing.locales)[number])) {
    return new Response('Not found', { status: 404 });
  }
  const t = await getTranslations({ locale });
  const rtl = locale === 'he';
  const lines = wrapAndBidi(t('landing.meta.ogImageAlt'), locale, 30).split('\n');
  const logo = `data:image/png;base64,${readFileSync(join(process.cwd(), 'public', 'icon.png')).toString('base64')}`;
  const L = APP_TOKENS.light;
  const name = (word: string) => (rtl ? wrapAndBidi(word, locale, 40) : word);
  const pill = (word: string, background: string) => (
    <div style={{ display: 'flex', padding: '14px 28px', borderRadius: 18, background, color: BRAND.onBrand, fontSize: 30 }}>{name(word)}</div>
  );
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          alignItems: rtl ? 'flex-end' : 'flex-start',
          padding: '64px 80px',
          background: L.bg,
          color: L.text,
          fontFamily: 'Noto Sans',
          fontWeight: 700,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- satori draws a plain img */}
        <img src={logo} width={112} height={112} alt="" style={{ borderRadius: 26, border: `2px solid ${L.separator}` }} />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: rtl ? 'flex-end' : 'flex-start' }}>
          {lines.map((line) => (
            <div key={line} style={{ display: 'flex', fontSize: 66, lineHeight: 1.15, letterSpacing: rtl ? 0 : -1 }}>
              {line}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: rtl ? 'row-reverse' : 'row', gap: 16 }}>
          {pill(t('site.cta.telegramShort'), BRAND.telegram)}
          {pill(t('site.cta.whatsappShort'), BRAND.whatsapp)}
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts: fonts() },
  );
}
