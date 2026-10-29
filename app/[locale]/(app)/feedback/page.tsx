import { MissingParameterCard } from '@/components/app-ui/StateCard';
import FeedbackClient from './FeedbackClient';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

export default async function FeedbackPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const searchParamsData = await searchParams;
  const userId = searchParamsData.user_id ? parseInt(searchParamsData.user_id) : null;

  if (!userId) {
    return <MissingParameterCard />;
  }

  // No lookup of the URL's user_id: with no credential it told anyone whether that user
  // exists and their language. Both entry points (/start feedback, the dashboard) put the
  // user's locale in the URL, and /api/feedback proves the user before saving.
  return (
    <FeedbackClient
      userId={userId}
      locale={locale}
    />
  );
}
