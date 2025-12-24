'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DashboardRedirectPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<string[]>([]);

  useEffect(() => {
    const debugLog = (message: string) => {
      console.log(message);
      setDebug(prev => [...prev, message]);
    };

    debugLog('🔍 Dashboard page loaded');

    // CRITICAL: Call ready() IMMEDIATELY to remove loading screen
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;

      debugLog('✅ Telegram WebApp found');

      // MUST call ready() first thing - this removes black loading screen
      tg.ready();
      debugLog('📞 Called tg.ready()');

      // Set theme colors to ensure visibility
      try {
        tg.setHeaderColor('secondary_bg_color');
        tg.setBackgroundColor('#ffffff');
        debugLog('🎨 Set theme colors');
      } catch (e) {
        debugLog(`⚠️ Could not set colors: ${e}`);
      }

      // Get user ID from initData
      const userId = tg.initDataUnsafe?.user?.id;
      const languageCode = tg.initDataUnsafe?.user?.language_code;

      debugLog(`👤 User ID: ${userId || 'NOT FOUND'}`);
      debugLog(`🌍 Language: ${languageCode || 'NOT FOUND'}`);
      debugLog(`📊 Full initDataUnsafe: ${JSON.stringify(tg.initDataUnsafe || {})}`);
      debugLog(`📱 Platform: ${tg.platform || 'unknown'}`);
      debugLog(`🔢 Version: ${tg.version || 'unknown'}`);

      if (userId) {
        // Determine locale (default to 'en' if not Hebrew)
        const locale = languageCode === 'he' ? 'he' : 'en';
        debugLog(`🔀 Redirecting to: /${locale}/dashboard?user_id=${userId}`);

        // Redirect to localized dashboard with user ID
        router.push(`/${locale}/dashboard?user_id=${userId}`);
      } else {
        // Fallback: User ID not available in initData
        setError('❌ User ID not available in initData');
        debugLog('❌ User ID not found in initDataUnsafe');
      }
    } else {
      // Not opened from Telegram - wait a bit for SDK to load
      debugLog('⏳ Waiting for Telegram WebApp SDK...');

      let attempts = 0;
      const checkInterval = setInterval(() => {
        attempts++;
        debugLog(`🔄 Attempt ${attempts}/10 to find Telegram WebApp`);

        if (window.Telegram?.WebApp) {
          clearInterval(checkInterval);
          debugLog('✅ Telegram WebApp loaded after waiting');
          window.location.reload(); // Reload to re-run useEffect with SDK available
        } else if (attempts >= 10) {
          clearInterval(checkInterval);
          setError('❌ Not opened from Telegram (SDK not loading)');
          debugLog('❌ window.Telegram.WebApp not available after 10 attempts');
        }
      }, 200);

      return () => clearInterval(checkInterval);
    }
  }, [router]);

  return (
    <div style={{
      padding: '20px',
      backgroundColor: '#ffffff',
      minHeight: '100vh',
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#000000'
    }}>
      <h2 style={{ color: '#667eea', fontSize: '24px', marginBottom: '20px' }}>🔍 Dashboard Debug</h2>

      {error && (
        <div style={{
          padding: '15px',
          background: '#fee',
          border: '2px solid #f00',
          borderRadius: '8px',
          marginBottom: '20px'
        }}>
          <h3 style={{ color: '#c00', margin: '0 0 10px 0' }}>{error}</h3>
          <p>Type /start in your Telegram chat to begin</p>
        </div>
      )}

      <div style={{
        background: '#f0f0f0',
        padding: '15px',
        borderRadius: '8px',
        border: '2px solid #333',
        color: '#000'
      }}>
        <h3 style={{ margin: '0 0 10px 0', color: '#000', fontSize: '18px' }}>Debug Log:</h3>
        {debug.map((log, i) => (
          <div key={i} style={{
            padding: '8px',
            borderBottom: '1px solid #ccc',
            fontSize: '14px',
            color: '#000',
            backgroundColor: i % 2 === 0 ? '#fff' : '#f5f5f5'
          }}>
            {log}
          </div>
        ))}
        {debug.length === 0 && (
          <div style={{ fontSize: '16px', color: '#000', padding: '10px' }}>
            ⏳ Waiting for logs...
          </div>
        )}
      </div>

      <div style={{ marginTop: '20px', color: '#666' }}>
        <p>If you see this screen, the page is loading but something is preventing the redirect.</p>
        <p>Check the debug log above to see what's happening.</p>
      </div>
    </div>
  );
}
