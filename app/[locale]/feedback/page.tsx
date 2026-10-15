import { AlertTriangle } from 'lucide-react';
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
