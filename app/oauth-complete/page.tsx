import OAuthCompleteClient from './OAuthCompleteClient';
import { normalizeLocale } from '@/src/utils/locale';
import enMessages from '@/messages/en.json';
import heMessages from '@/messages/he.json';
import ruMessages from '@/messages/ru.json';

interface PageProps {
  searchParams: Promise<{
    locale?: string;
  }>;
}

/**
 * The finish page after Google's consent. The callback parked the token; the owner
 * commits it with one tap from their own Telegram or WhatsApp. The pendingId, the owner's
 * first name and the buttons to show are in the URL fragment, which only the client reads.
 */
export default async function OAuthCompletePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const locale = normalizeLocale(params.locale);
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || '';
  const waNumber = process.env.WHATSAPP_PHONE_NUMBER || '';

  const messages = { en: enMessages, he: heMessages, ru: ruMessages }[locale] ?? enMessages;
  const t = messages.oauthComplete;

  return <OAuthCompleteClient locale={locale} botUsername={botUsername} waNumber={waNumber} translations={t} />;
}
