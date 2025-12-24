'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';

interface TelegramDashboardRedirectProps {
  locale: string;
}

export default function TelegramDashboardRedirect({ locale }: TelegramDashboardRedirectProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Call ready() IMMEDIATELY to remove Telegram's loading screen
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;

      // MUST call ready() first thing
      tg.ready();

      // Set theme colors
      try {
        tg.setHeaderColor('secondary_bg_color');
        tg.setBackgroundColor('#ffffff');
      } catch (e) {
        console.error('Could not set Telegram colors:', e);
      }

      // Get user ID from initData
      const userId = tg.initDataUnsafe?.user?.id;

      if (userId) {
        // Redirect to dashboard with user ID
        router.push(`/${locale}/dashboard?user_id=${userId}`);
      } else {
        // Fallback: User ID not available
        console.error('User ID not found in Telegram initDataUnsafe');
        setError('Please open this app from Telegram');
      }
    } else {
      // Not opened from Telegram - wait for SDK to load
      let attempts = 0;
      const checkInterval = setInterval(() => {
        attempts++;

        if (window.Telegram?.WebApp) {
          clearInterval(checkInterval);
          window.location.reload(); // Reload to re-run useEffect with SDK available
        } else if (attempts >= 10) {
          clearInterval(checkInterval);
          setError('This app must be opened from Telegram');
        }
      }, 200);

      return () => clearInterval(checkInterval);
    }
  }, [router, locale]);

  if (error) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        padding: '20px',
        textAlign: 'center',
        fontFamily: 'Rubik, -apple-system, BlinkMacSystemFont, sans-serif'
      }}>
        <div style={{
          background: 'rgba(255, 255, 255, 0.95)',
          padding: '30px',
          borderRadius: '16px',
          maxWidth: '400px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1)'
        }}>
          <div style={{ marginBottom: '20px' }}><AlertTriangle size={48} color="#f59e0b" /></div>
          <h2 style={{ color: '#333', marginBottom: '10px', fontSize: '20px' }}>{error}</h2>
          <p style={{ color: '#666', fontSize: '14px' }}>Type /start in your Telegram chat to begin</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      fontFamily: 'Rubik, -apple-system, BlinkMacSystemFont, sans-serif'
    }}>
      <div style={{
        textAlign: 'center',
        color: 'white'
      }}>
        <div style={{
          fontSize: '48px',
          marginBottom: '20px',
          animation: 'pulse 1.5s ease-in-out infinite'
        }}>
          🚀
        </div>
        <h2 style={{ fontSize: '24px', fontWeight: '500' }}>Loading Dashboard...</h2>
      </div>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.8; transform: scale(1.1); }
        }
      `}</style>
    </div>
  );
}
