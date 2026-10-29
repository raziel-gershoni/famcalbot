import OAuthCompleteClient from './OAuthCompleteClient';
import { ConnectShell } from '../ConnectShell';
import { normalizeLocale } from '@/src/utils/locale';
import { DEFAULT_BOT_USERNAME, DEFAULT_WA_NUMBER } from '@/src/lib/gate-links';
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
  // Never empty: these links are the only way to finish, and the token waits 15 minutes
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME;
  const waNumber = process.env.WHATSAPP_PHONE_NUMBER || DEFAULT_WA_NUMBER;

  const title = { en: enMessages, he: heMessages, ru: ruMessages }[locale].oauthComplete.title;

  // The words come from the shell's provider (oauthComplete, pageGate's loading)
  return (
    <ConnectShell locale={locale} namespaces={['oauthComplete']} title={title}>
      <OAuthCompleteClient botUsername={botUsername} waNumber={waNumber} />
    </ConnectShell>
  );
}
