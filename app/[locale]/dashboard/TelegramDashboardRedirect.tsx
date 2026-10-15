'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { NoCredentialCard } from '../PageGate';
import type { GateLinks } from '@/src/lib/gate-links';
import { readInitData } from '@/src/lib/read-init-data';

interface TelegramDashboardRedirectProps {
  locale: string;
  /** Where the no-credential card sends someone (gateLinks(), from the server's env). */
  links: GateLinks;
}

export default function TelegramDashboardRedirect({ locale, links }: TelegramDashboardRedirectProps) {
  const router = useRouter();
  // No Telegram user to send on: PageGate's card, in a browser or inside Telegram
  const [gate, setGate] = useState<'browser' | 'telegram' | null>(null);

  useEffect(() => {
    // Call ready() IMMEDIATELY to remove Telegram's loading screen
    if (typeof window !== 'undefined' && window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;

      // MUST call ready() first thing; full height before the dashboard loads
      tg.ready();
      tg.expand();

      // Set theme colors (the dashboard's purple header from the first frame)
      try {
        tg.setHeaderColor('#667eea');
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
        // No Telegram user: a browser (a stale or used WhatsApp magic link lands here),
        // or a launch without one. The SDK defines Telegram.WebApp in any browser.
        setGate(readInitData() ? 'telegram' : 'browser');
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
          setGate('browser');
        }
      }, 200);

      return () => clearInterval(checkInterval);
    }
  }, [router, locale]);

  if (gate) {
    return <NoCredentialCard look="telegram" inTelegram={gate === 'telegram'} links={links} />;
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
          marginBottom: '20px',
          animation: 'spin 1s linear infinite'
        }}>
          <Loader2 size={48} />
        </div>
        <h2 style={{ fontSize: '24px', fontWeight: '500' }}>Loading Dashboard...</h2>
      </div>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
