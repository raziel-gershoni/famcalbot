// Public landing for a pair invite. No auth required to LOAD — anyone with the
// link can preview the inviter's display name. Acceptance happens in one of:
//   - In-app via Telegram initData (one-tap), POST /api/pair/accept.
//   - Out-of-app: tap "Open in Telegram" deep link → /start invite_<packed token> (src/lib/invite-link.ts).
//   - WhatsApp-only users: tap "Open in WhatsApp" → wa.me with prefilled "accept <token>".
//
// Token validation lives in pairing-service.getInviteByToken — the page just
// renders preview state from that result. The acceptance routes (TG /start,
// API POST, WA accept text) all converge on pairing-service.acceptInvite.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { StateCard } from '@/components/app-ui/StateCard';
import { getInviteByToken } from '@/src/services/pairing-service';
import InviteClient from './InviteClient';
import { INVITE_CSS } from './invite-css';
import { normalizeLocale } from '@/src/utils/locale';
import { inviteStartParam } from '@/src/lib/invite-link';
import { SITE_URL } from '@/src/site/config';
import { OG_SIZE } from '@/src/site/seo';

interface PageProps {
  params: Promise<{ locale: string; token: string }>;
}

/**
 * The link's preview where it is pasted (a chat, a group): the invite's title and words, and the site's share image in
 * the page's language. Nothing about the inviter, and still kept out of search, as every page in the app is.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = normalizeLocale(rawLocale);
  const t = await getTranslations({ locale, namespace: 'invite' });
  const share = await getTranslations({ locale, namespace: 'landing.meta' });
  const title = t('metaTitle');
  const description = t('subtitle');
  const image = { url: `${SITE_URL}/og/${locale}.png`, ...OG_SIZE, alt: share('ogImageAlt') };
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: { type: 'website', siteName: 'FamCal', title, description, images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

export default async function InvitePage({ params }: PageProps) {
  const { locale: rawLocale, token } = await params;
  const locale = normalizeLocale(rawLocale);

  const result = await getInviteByToken(token);
  const t = await getTranslations({ locale, namespace: 'invite' });

  if (!result) {
    return (
      <AppScreen>
        <style>{INVITE_CSS}</style>
        <div className="ch-invite-page">
          <StateCard tone="crash" title={t('invalid.title')} body={t('invalid.body')} action={{ label: t('invalid.home'), href: `/${locale}` }} />
        </div>
      </AppScreen>
    );
  }

  const { invite, inviter } = result;
  const inviterDisplayName = inviter.name || inviter.englishName || t('someone');

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || '';
  const waNumber = process.env.WHATSAPP_PHONE_NUMBER || '';
  const startParam = botUsername ? inviteStartParam(token) : null;
  const tgDeepLink = startParam ? `https://t.me/${botUsername}?start=${startParam}` : '';
  const waDeepLink = waNumber ? `https://wa.me/${waNumber}?text=${encodeURIComponent(`accept ${token}`)}` : '';

  return (
    <InviteClient
      token={token}
      inviterName={inviterDisplayName}
      locale={locale}
      tgDeepLink={tgDeepLink}
      waDeepLink={waDeepLink}
      expiresAt={invite.expiresAt.toISOString()}
    />
  );
}

// Defensive: if the App Router ever asks for a static dynamic, fall back.
void notFound;
