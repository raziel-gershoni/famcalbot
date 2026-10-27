// Public landing for a pair invite. No auth required to LOAD — anyone with the
// link can preview the inviter's display name. Acceptance happens in one of:
//   - In-app via Telegram initData (one-tap), POST /api/pair/accept.
//   - Out-of-app: tap "Open in Telegram" deep link → /start invite_<token>.
//   - WhatsApp-only users: tap "Open in WhatsApp" → wa.me with prefilled "accept <token>".
//
// Token validation lives in pairing-service.getInviteByToken — the page just
// renders preview state from that result. The acceptance routes (TG /start,
// API POST, WA accept text) all converge on pairing-service.acceptInvite.

import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { StateCard } from '@/components/app-ui/StateCard';
import { getInviteByToken } from '@/src/services/pairing-service';
import InviteClient from './InviteClient';
import { normalizeLocale } from '@/src/utils/locale';

interface PageProps {
  params: Promise<{ locale: string; token: string }>;
}

export default async function InvitePage({ params }: PageProps) {
  const { locale: rawLocale, token } = await params;
  const locale = normalizeLocale(rawLocale);

  const result = await getInviteByToken(token);
  const t = await getTranslations({ locale, namespace: 'invite' });

  if (!result) {
    return (
      <AppScreen>
        <StateCard tone="crash" title={t('invalid.title')} body={t('invalid.body')} action={{ label: t('invalid.home'), href: `/${locale}` }} />
      </AppScreen>
    );
  }

  const { invite, inviter } = result;
  const inviterDisplayName = inviter.name || inviter.englishName || t('someone');

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || '';
  const waNumber = process.env.WHATSAPP_PHONE_NUMBER || '';
  const tgDeepLink = botUsername ? `https://t.me/${botUsername}?start=invite_${token}` : '';
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
