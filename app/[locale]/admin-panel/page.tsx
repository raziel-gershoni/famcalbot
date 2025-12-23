import { notFound } from 'next/navigation';
import { getUserByTelegramId } from '@/src/services/user-service';
import { prisma } from '@/src/utils/prisma';
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
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        padding: '20px'
      }}>
        <div style={{
          background: 'white',
          padding: '40px',
          borderRadius: '15px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
          textAlign: 'center',
          maxWidth: '400px'
        }}>
          <div style={{ fontSize: '64px', marginBottom: '20px' }}>⚠️</div>
          <h1 style={{ color: '#ef4444', margin: '0 0 10px 0' }}>Missing Parameter</h1>
          <p style={{ color: '#666' }}>user_id parameter is required</p>
        </div>
      </div>
    );
  }

  const user = await getUserByTelegramId(userId);

  if (!user) {
    notFound();
  }

  // Check if URL locale matches user's language preference
  const userLocale = user.language === 'Hebrew' ? 'he' : 'en';
  if (locale !== userLocale) {
    const { redirect } = await import('next/navigation');
    redirect(`/${userLocale}/admin-panel?user_id=${userId}`);
  }

  // Check admin access
  if (!user.isAdmin) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        padding: '20px'
      }}>
        <div style={{
          background: 'white',
          padding: '40px',
          borderRadius: '15px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
          textAlign: 'center',
          maxWidth: '400px'
        }}>
          <div style={{ fontSize: '64px', marginBottom: '20px' }}>🔒</div>
          <h1 style={{ color: '#ef4444', margin: '0 0 10px 0' }}>Unauthorized</h1>
          <p style={{ color: '#666' }}>This area is restricted to administrators only.</p>
        </div>
      </div>
    );
  }

  // Get statistics
  const totalUsers = await prisma.user.count();
  const usersWithOAuth = await prisma.user.count({
    where: {
      NOT: {
        googleRefreshToken: ''
      }
    }
  });
  const usersWithCalendars = await prisma.user.count({
    where: {
      calendars: {
        isEmpty: false
      }
    }
  });

  // Get recent users
  const recentUsers = await prisma.user.findMany({
    orderBy: {
      createdAt: 'desc'
    },
    take: 5,
    select: {
      name: true,
      createdAt: true,
      language: true,
      messagingPlatform: true
    }
  });

  return (
    <AdminPanelClient
      userId={userId}
      stats={{
        totalUsers,
        usersWithOAuth,
        usersWithCalendars,
        needSetup: totalUsers - usersWithOAuth
      }}
      recentUsers={recentUsers.map(u => ({
        name: u.name,
        createdAt: u.createdAt.toISOString(),
        language: u.language,
        messagingPlatform: u.messagingPlatform
      }))}
    />
  );
}
