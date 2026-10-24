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
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
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
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-rose-100 to-amber-100 p-6">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md text-center">
          <div className="text-5xl mb-4">⌛</div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">
            {t('invalid.title')}
          </h1>
          <p className="text-gray-600 mb-4">
            {t('invalid.body')}
          </p>
          <Link
            href={`/${locale}`}
            className="inline-block bg-blue-600 text-white px-6 py-3 rounded-xl font-medium hover:bg-blue-700 transition-colors"
          >
            {t('invalid.home')}
          </Link>
        </div>
      </div>
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
