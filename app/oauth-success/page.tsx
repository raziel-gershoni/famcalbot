import { getUserByTelegramId } from '@/src/services/user-service';
import SuccessClient from './SuccessClient';

interface PageProps {
  searchParams: Promise<{
    user_id?: string;
  }>;
}

export default async function OAuthSuccessPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const userId = params.user_id;

  if (!userId) {
    return (
      <div style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: 0,
        padding: '20px'
      }}>
        <div style={{
          background: 'white',
          padding: '40px',
          borderRadius: '15px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
          maxWidth: '400px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '64px', marginBottom: '20px' }}>❌</div>
          <h2 style={{ margin: '0 0 20px 0', color: '#333' }}>Missing Parameter</h2>
          <p style={{ color: '#666', lineHeight: '1.6' }}>
            Missing user_id parameter.
          </p>
        </div>
      </div>
    );
  }

  const user = await getUserByTelegramId(parseInt(userId));

  if (!user) {
    return (
      <div style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif',
        background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: 0,
        padding: '20px'
      }}>
        <div style={{
          background: 'white',
          padding: '40px',
          borderRadius: '15px',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
          maxWidth: '400px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: '64px', marginBottom: '20px' }}>❌</div>
          <h2 style={{ margin: '0 0 20px 0', color: '#333' }}>User Not Found</h2>
          <p style={{ color: '#666', lineHeight: '1.6' }}>
            Could not find user with ID {userId}.
          </p>
        </div>
      </div>
    );
  }

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'family_calendar_telegram_bot';

  return <SuccessClient userName={user.name || 'User'} botUsername={botUsername} />;
}
