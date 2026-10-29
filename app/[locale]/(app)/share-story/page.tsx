'use client';

// The Mini App page that calls shareToStory and closes (spec 2026-10-19 §5; plan W1b). Opened from the inline button under the
// weather photo and under a text summary, always from Telegram.
//
// ?source=cached  → the image cached in Redis (the inline button under the photo)
// ?source=summary → the image of the summary message in ?msg
// ?source=fresh   → generate a new image (the default; no button opens it today)
//
// - It has no screen of its own: the app loader shows while it works, and the story composer opens over it. The window closes
//   5 seconds after the composer opens.
// - It tells Telegram it is ready and never asks for the full height: the story composer needs the window as it is.
// - Opened outside Telegram (a browser with the link) it says so on a card instead of spinning for ever, and sends nothing.
//   The effect asks the window itself, never the rendered answer: the page is hydrated, and the first effect runs on the
//   server's guess ("inside") before React re-renders for the client's.
// - A client below Bot API 7.8 is told to update Telegram before anything is asked of the server: the live SDK always defines
//   shareToStory and throws inside it on an old client, so the method's presence says nothing.
// - What goes wrong is said in the page's language in Telegram's pop-up, never in the server's words (which are logged),
//   and the window closes once the person has dismissed it.

import { useEffect, useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { MissingParameterCard, StateCard } from '@/components/app-ui/StateCard';
import { initDataHeaders } from '@/src/lib/read-init-data';
import { isInTelegram, showTelegramAlert, telegramSupports } from '@/src/lib/telegram-ui';
import { PageLoader } from '../PageGate';

/** The first Bot API version with shareToStory. */
const STORY_VERSION = '7.8';

// Whether this page is inside Telegram with its SDK (what opening the composer needs) does not change while it is open.
const subscribe = () => () => {};
const insideTelegram = () => Boolean(window.Telegram?.WebApp) && isInTelegram();
// The server renders the loader (what a Telegram client gets); the client's own answer replaces it after hydration where it differs
const assumeInside = () => true;

export default function ShareStoryPage() {
  const searchParams = useSearchParams();
  const t = useTranslations('shareStory');
  const userId = searchParams.get('user_id');
  const source = searchParams.get('source') || 'fresh';
  const msg = searchParams.get('msg');
  const inside = useSyncExternalStore(subscribe, insideTelegram, assumeInside);
  // Read once per render and used by the effect as values, so it never re-runs (and shares again) for a new function
  const updateTelegram = t('updateTelegram');
  const loadFailed = t('loadFailed');
  const shareFailed = t('shareFailed');

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    // The live answer: `inside` is the server's guess during hydration, and a browser holding the SDK would pass it once
    if (!userId || !insideTelegram() || !tg) return;

    tg.ready();

    // The pop-up says it, and the window closes once it is dismissed (at once if the client can't show one)
    const sayAndClose = (message: string) => {
      if (!showTelegramAlert(message, () => tg.close())) tg.close();
    };

    if (!telegramSupports(STORY_VERSION)) {
      sayAndClose(updateTelegram);
      return;
    }

    const signUrl = `/api/weather-image/sign?user_id=${userId}&source=${source}${msg ? `&msg=${msg}` : ''}`;

    fetch(signUrl, { headers: initDataHeaders() })
      .then(async (res) => {
        const data = res.ok ? await res.json() : null;
        if (data?.url) {
          tg.shareToStory(data.url, {
            widget_link: { url: 'https://famcal.bot', name: 'FamCal' },
          });
          setTimeout(() => tg.close(), 5000);
          return;
        }
        console.warn('[share-story] image link refused:', res.status);
        sayAndClose(loadFailed);
      })
      .catch((error) => {
        console.error('[share-story] share failed:', error);
        sayAndClose(shareFailed);
      });
  }, [userId, source, msg, updateTelegram, loadFailed, shareFailed]);

  if (!userId) return <MissingParameterCard />;
  if (!inside) {
    return (
      <AppScreen>
        <StateCard tone="crash" title={t('telegramOnlyTitle')} body={t('telegramOnlyBody')} />
      </AppScreen>
    );
  }
  return <PageLoader />;
}
