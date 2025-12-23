import { redirect } from 'next/navigation';
import { requireAdminAuth } from '../_lib/auth';
import { getUserByTelegramId } from '@/src/services/user-service';
import EditUserClient from './EditUserClient';

interface PageProps {
  searchParams: Promise<{
    id?: string;
  }>;
}

export default async function EditUserPage({ searchParams }: PageProps) {
  // Require authentication
  try {
    await requireAdminAuth();
  } catch (error) {
    redirect('/admin');
  }

  const params = await searchParams;
  const userId = params.id ? parseInt(params.id) : null;

  if (!userId) {
    return (
      <div style={{ padding: '40px', textAlign: 'center' }}>
        <h2>Missing user ID</h2>
        <a href="/admin">← Back to Admin</a>
      </div>
    );
  }

  const user = await getUserByTelegramId(userId);

  if (!user) {
    return (
      <div style={{ padding: '40px', textAlign: 'center' }}>
        <h2>User not found</h2>
        <a href="/admin">← Back to Admin</a>
      </div>
    );
  }

  return <EditUserClient user={user} />;
}
