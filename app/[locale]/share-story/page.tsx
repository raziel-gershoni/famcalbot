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
    const signUrl = `/api/weather-image/sign?user_id=${userId}&initData=${encodeURIComponent(initData)}&source=${source}`;

    fetch(signUrl)
      .then(res => res.json())
      .then(data => {
        if (data.url) {
          tg.shareToStory(data.url, {
            widget_link: { url: 'https://famcal.bot', name: 'FamCal' },
          });
        } else {
          tg.showAlert(data.message || 'Failed to load image');
        }
        // Close after a short delay to let the story editor open
        setTimeout(() => tg.close(), 1000);
      })
      .catch(() => {
        tg.showAlert('Failed to share');
        tg.close();
      });
  }, [userId, source]);

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
