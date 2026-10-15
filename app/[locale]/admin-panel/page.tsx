import { AlertTriangle } from 'lucide-react';
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

  // The same shell for every id: no lookup here, so the HTML carries no stats or toggles
  // and doesn't tell an admin's id from anyone else's. AdminPanelClient loads its data
  // from the admin-only APIs (/api/admin/settings, /api/admin/stats).
  return <AdminPanelClient userId={userId} locale={locale} />;
}
