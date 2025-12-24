'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DashboardRedirectPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check if running in Telegram WebApp
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.ready();

      // Get user ID from initData
      const userId = tg.initDataUnsafe?.user?.id;
      const languageCode = tg.initDataUnsafe?.user?.language_code;

      if (userId) {
        // Determine locale (default to 'en' if not Hebrew)
        const locale = languageCode === 'he' ? 'he' : 'en';

        // Redirect to localized dashboard with user ID
        router.push(`/${locale}/dashboard?user_id=${userId}`);
      } else {
        // Fallback: User ID not available in initData
        setError('Please open this bot in Telegram and type /start');
      }
    } else {
      // Not opened from Telegram
      setError('This app must be opened from Telegram');
    }
  }, [router]);

  if (error) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <h1>{error}</h1>
        <p>Type /start in your Telegram chat to begin</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', textAlign: 'center' }}>
      <p>Loading your dashboard...</p>
    </div>
  );
}
