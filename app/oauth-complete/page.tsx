import OAuthCompleteClient from './OAuthCompleteClient';

interface PageProps {
  searchParams: Promise<{
    user_id?: string;
    locale?: string;
  }>;
}

export default async function OAuthCompletePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const userId = params.user_id;
  const locale = params.locale || 'en';

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'family_calendar_telegram_bot';

  return (
    <OAuthCompleteClient
      userId={userId}
      locale={locale}
      botUsername={botUsername}
    />
  );
}
