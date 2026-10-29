import { MissingParameterCard } from '@/components/app-ui/StateCard';
import AdminPanelClient from './AdminPanelClient';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

export default async function AdminPanelPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const searchParamsData = await searchParams;
  const userId = searchParamsData.user_id ? parseInt(searchParamsData.user_id) : null;

  if (!userId) {
    return <MissingParameterCard />;
  }

  // The same shell for every id: no lookup here, so the HTML carries no stats or toggles
  // and doesn't tell an admin's id from anyone else's. AdminPanelClient loads its data
  // from the admin-only APIs (/api/admin/settings, /api/admin/stats).
  return <AdminPanelClient userId={userId} locale={locale} />;
}
