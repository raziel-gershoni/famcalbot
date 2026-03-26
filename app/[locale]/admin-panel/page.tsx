import { notFound } from 'next/navigation';
import { getUserByTelegramId, getUserById } from '@/src/services/user-service';
import { normalizeLocale } from '@/src/utils/locale';
import { prisma } from '@/src/utils/prisma';
import { Prisma } from '@prisma/client';
import { AlertTriangle, Lock } from 'lucide-react';
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
          <div style={{ marginBottom: '20px' }}><AlertTriangle size={64} color="#f59e0b" /></div>
          <h1 style={{ color: '#ef4444', margin: '0 0 10px 0' }}>Missing Parameter</h1>
          <p style={{ color: '#666' }}>user_id parameter is required</p>
        </div>
      </div>
    );
  }

  const user = await getUserByTelegramId(userId) ?? await getUserById(userId);

  if (!user) {
    notFound();
  }

  // Check if URL locale matches user's language preference
  // normalizeLocale handles legacy values like 'Hebrew' -> 'he'
  const userLocale = normalizeLocale(user.language);
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
          <div style={{ marginBottom: '20px' }}><Lock size={64} color="#ef4444" /></div>
          <h1 style={{ color: '#ef4444', margin: '0 0 10px 0' }}>Unauthorized</h1>
          <p style={{ color: '#666' }}>This area is restricted to administrators only.</p>
        </div>
      </div>
    );
  }

  // Get statistics (with retry for Neon cold start)
  const [totalUsers, usersWithOAuth, usersWithCalendars, adminSettings] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({
      where: { NOT: { googleRefreshToken: '' } }
    }),
    prisma.user.count({
      where: { calendarAssignments: { not: Prisma.JsonNull } }
    }),
    prisma.adminSettings.findUnique({
      where: { id: 'global' }
    }).catch(() => null) // Handle missing table gracefully
  ]);

  return (
    <AdminPanelClient
      userId={userId}
      locale={locale}
      stats={{
        totalUsers,
        usersWithOAuth,
        usersWithCalendars,
        needSetup: totalUsers - usersWithOAuth
      }}
      remindersEnabled={adminSettings?.remindersEnabled ?? false}
      earlyAdoptionMode={adminSettings?.earlyAdoptionMode ?? false}
      defaultAiModel={adminSettings?.defaultAiModel ?? null}
      geminiThinkingLevel={adminSettings?.geminiThinkingLevel ?? null}
    />
  );
}
