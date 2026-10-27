'use client';

// The error boundary around the calendar home (spec §5): a render error shows a calm
// card with Reload instead of a blank Mini App. A failed chunk load (a deploy replaced
// the files while the app was open) reloads the page once by itself, letting Telegram's
// BackButton and vertical swipes go first (releaseTelegramControls); the guard in
// sessionStorage keeps that from looping. The fallback carries the home's own look,
// hides a Telegram BackButton the client kept from before and turns vertical swipes back
// on, which a reload in the Month's browse can leave off (Plan E Ruling 9). The home's
// own chunk failing to load is PageGate's boundary's (D7): this one lives inside that
// chunk.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CHUNK_RELOAD_KEY, isChunkLoadError, reloadOnce } from '@/src/lib/calendar-view/reload-guard';
import { APP_SCREEN_CSS } from '@/components/app-ui/screen';
import { APP_THEME_CSS } from '@/components/app-ui/theme';
import { releaseTelegramControls, useTelegramBackButton, useTelegramTheme, useTelegramVerticalSwipes } from '@/src/lib/telegram-ui';

/** The guard's sessionStorage key for the chunk-load reload (reload-guard's, shared with PageGate's boundary). */
export { CHUNK_RELOAD_KEY };

const noop = () => {};

function reloadPage() {
  try {
    window.location.reload();
  } catch {
    // Nothing else to do; the card stays.
  }
}

/** The boundary's card, in the home's look and the page's language. */
export function HomeCrash() {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const scheme = useTelegramTheme();
  useTelegramBackButton(false, noop);
  useTelegramVerticalSwipes(false);
  return (
    <div className="ch-app ch-screen ch-home" data-theme={scheme} dir={locale === 'he' ? 'rtl' : 'ltr'} lang={locale}>
      <style>{APP_THEME_CSS}</style>
      <style>{APP_SCREEN_CSS}</style>
      <div className="ch-home-card ch-crash" role="alert">
        <h1 className="ch-home-card-title">{t('errorBoundary.title')}</h1>
        <p className="ch-home-card-body">{t('errorBoundary.body')}</p>
        <button type="button" className="ch-btn ch-btn-primary ch-home-card-action" onClick={reloadPage}>
          {t('actions.reload')}
        </button>
      </div>
    </div>
  );
}

interface State {
  failed: boolean;
}

export class HomeErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[calendar-home] The home failed to render:', error, info.componentStack);
    if (isChunkLoadError(error)) reloadOnce(CHUNK_RELOAD_KEY, Date.now(), releaseTelegramControls);
  }

  render() {
    return this.state.failed ? <HomeCrash /> : this.props.children;
  }
}
