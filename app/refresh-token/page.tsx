import { redirect } from 'next/navigation';
import { getUserByTelegramId, getUserById } from '@/src/services/user-service';
import { NextIntlClientProvider } from 'next-intl';
import { MissingParameterCard } from '@/components/app-ui/StateCard';
import { googleStateOf } from '@/src/lib/google-state';
import RefreshTokenClient from './RefreshTokenClient';
import enMessages from '@/messages/en.json';
import heMessages from '@/messages/he.json';
import ruMessages from '@/messages/ru.json';

interface PageProps {
  searchParams: Promise<{
    code?: string;
    state?: string;
    user_id?: string;
  }>;
}

export default async function RefreshTokenPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { code, state, user_id } = params;

  // If OAuth callback → redirect to dedicated handler
  if (code && state) {
    redirect(`/oauth-callback?code=${code}&state=${state}`);
  }

  // Otherwise → show auth initiation page
  if (!user_id) {
    // This page sits outside app/[locale]: it brings the provider the card reads its text from, in English
    // (no user, no language yet). The card formats no date, so the zone is only there to be set.
    return (
      <NextIntlClientProvider locale="en" messages={{ ui: enMessages.ui }} timeZone="UTC">
        <MissingParameterCard />
      </NextIntlClientProvider>
    );
  }

  // Get user's language preference (already normalized to 'he'/'ru'/'en')
  const user = await getUserByTelegramId(parseInt(user_id)) ?? await getUserById(parseInt(user_id));
  const locale = user?.language || 'en';
  const messages = { en: enMessages, he: heMessages, ru: ruMessages }[locale] ?? enMessages;
  // A user who never connected Google (the menu's Connect entry) is asked to connect; everyone
  // else is reconnecting, so the page says their access expired.
  const rt = messages.refreshToken;
  const connecting = !!user && googleStateOf(user) === 'none';
  const copy = connecting ? { ...rt, title: rt.connectTitle, subtitle: rt.connectSubtitle, step3: rt.connectStep3 } : rt;
  // With no credential the page says what the gate on the [locale] pages says
  const t = { ...copy, gate: messages.pageGate };

  // No OAuth state here: the client asks POST /api/oauth/start for the Google URL with
  // its credential (initData or the WhatsApp session), and the state is bound to the
  // user that credential proves, not to this URL's user_id.
  return <RefreshTokenClient userId={user_id} locale={locale} translations={t} />;
}
