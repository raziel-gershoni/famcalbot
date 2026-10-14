import { AlertTriangle, XCircle } from 'lucide-react';
import PageGate, { NoticeDetail } from '../PageGate';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ user_id?: string }>;
}

export default async function SelectCalendarsPage({ params, searchParams }: PageProps) {
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

  // No user data in the server HTML: PageGate loads it through /api/page-data
  // (src/lib/page-data.ts), which proves the user first. The notices are static.
  return (
    <PageGate
      page="select-calendars"
      userId={userId}
      locale={locale}
      notices={{
        noGoogleToken: (
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
              <h1 style={{ color: '#ef4444', margin: '0 0 10px 0' }}>No Google Token</h1>
              <p style={{ color: '#666' }}>Please refresh your token first.</p>
            </div>
          </div>
        ),
        // Generic error fallback; the message comes from the server
        error: (
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
              <div style={{ marginBottom: '20px' }}><XCircle size={64} color="#ef4444" /></div>
              <h1 style={{ color: '#ef4444', margin: '0 0 10px 0' }}>Error</h1>
              <p style={{ color: '#666' }}>
                <NoticeDetail fallback="Unknown error" />
              </p>
              <a href={`/select-calendars?user_id=${userId}`} style={{ color: '#667eea' }}>
                Try Again
              </a>
            </div>
          </div>
        ),
      }}
    />
  );
}
