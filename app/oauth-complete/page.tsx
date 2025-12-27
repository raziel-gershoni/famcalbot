import OAuthCompleteClient from './OAuthCompleteClient';

interface PageProps {
  searchParams: Promise<{
    locale?: string;
  }>;
}

export default async function OAuthCompletePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const locale = params.locale || 'en';

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'family_calendar_telegram_bot';

  return (
    <OAuthCompleteClient
      locale={locale}
      botUsername={botUsername}
    />
  );
}
