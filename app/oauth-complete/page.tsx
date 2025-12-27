import OAuthCompleteClient from './OAuthCompleteClient';
import enMessages from '@/messages/en.json';
import heMessages from '@/messages/he.json';

interface PageProps {
  searchParams: Promise<{
    locale?: string;
  }>;
}

export default async function OAuthCompletePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const locale = params.locale || 'en';
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'family_calendar_telegram_bot';

  const messages = locale === 'he' ? heMessages : enMessages;
  const t = messages.oauthComplete;

  return <OAuthCompleteClient locale={locale} botUsername={botUsername} translations={t} />;
}
