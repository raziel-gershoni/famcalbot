'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * Minimal Mini App page that calls shareToStory and closes.
 * Opened via inline keyboard button under the weather photo.
 *
 * ?source=cached → use cached image from Redis (inline button)
 * ?source=fresh  → generate new image (dashboard button)
 */
export default function ShareStoryPage() {
  const searchParams = useSearchParams();
  const userId = searchParams.get('user_id');
  const source = searchParams.get('source') || 'fresh';
  const msg = searchParams.get('msg');

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;

    tg.ready();

    if (!tg.shareToStory) {
      tg.showAlert('Update Telegram to share stories');
      tg.close();
      return;
    }

    const initData = tg.initData;
    const signUrl = `/api/weather-image/sign?user_id=${userId}&initData=${encodeURIComponent(initData)}&source=${source}${msg ? `&msg=${msg}` : ''}`;

    fetch(signUrl)
      .then(async res => {
        const data = await res.json();
        if (res.ok && data.url) {
          tg.shareToStory(data.url, {
            widget_link: { url: 'https://famcal.bot', name: 'FamCal' },
          });
        } else {
          tg.showAlert(data.error || 'Failed to load image');
          tg.close();
        }
      })
      .catch(() => {
        tg.showAlert('Failed to share');
        setTimeout(() => tg.close(), 500);
      });
  }, [userId, source, msg]);

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      height: '100vh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      color: 'white',
      fontFamily: 'system-ui',
      fontSize: '16px',
    }}>
      Loading...
    </div>
  );
}
