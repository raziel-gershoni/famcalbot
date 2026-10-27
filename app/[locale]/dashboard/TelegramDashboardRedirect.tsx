'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { NoCredentialCard, PageLoader, startMiniApp } from '../PageGate';
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

      // MUST call ready() first thing; full height before the dashboard loads. The dashboard's own look,
      // the app's: no colour of ours on Telegram's header (its AppScreen takes the theme's bg_color).
      startMiniApp('app');

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
    return <NoCredentialCard look="app" inTelegram={gate === 'telegram'} links={links} />;
  }

  // The dashboard's own loader, the one PageGate shows while the home loads
  return <PageLoader look="app" />;
}
