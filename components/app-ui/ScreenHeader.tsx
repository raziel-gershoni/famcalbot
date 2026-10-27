'use client';

// A screen's header and its section labels (spec 2026-10-19 §4; W1a).
//
// - ScreenHeader is the title (the screen's h1) and, in front of it, an in-page back button where
//   Telegram has no BackButton of its own: a browser, or a Telegram client older than Bot API 6.1.
//   Inside Telegram 6.1+ the BackButton is AppScreen's (components/app-ui/AppScreen.tsx owns it,
//   one per screen), so there is no second back here, and this file never calls
//   useTelegramBackButton. Both go to the same `onBack`, which the screen passes to AppScreen too.
// - The server renders what a Telegram client gets (no in-page back), and the client's snapshot
//   replaces it after hydration where it differs, so a Telegram page never hydrates against a
//   button that is not there.
// - SectionLabel is the h2 above a card or a group of cards.
//
// Client-safe: it reads only src/lib/telegram-ui.ts. The strings come in already translated.

import { useSyncExternalStore, type ReactNode } from 'react';
import { hasTelegramBackButton } from '@/src/lib/telegram-ui';

// What decides it (the SDK's presence and version) does not change while the page is open.
const subscribe = () => () => {};
const needsInPageBack = () => !hasTelegramBackButton();
const serverNeedsInPageBack = () => false;

export interface ScreenHeaderProps {
  /** The screen's title: its h1. */
  title: string;
  /** The in-page back button's accessible name. */
  backLabel: string;
  /** Where back goes. Absent or null: no back, in the page or in Telegram. */
  onBack?: (() => void) | null;
}

export function ScreenHeader({ title, backLabel, onBack }: ScreenHeaderProps) {
  const inPage = useSyncExternalStore(subscribe, needsInPageBack, serverNeedsInPageBack);
  return (
    <header className="ch-screen-head">
      {onBack && inPage ? (
        <button type="button" className="ch-icon-btn ch-icon-btn-plain" aria-label={backLabel} onClick={onBack}>
          <svg className="ch-flip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      ) : null}
      <h1 className="ch-screen-title">{title}</h1>
    </header>
  );
}

/** The label above a card or a group of cards. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="ch-section-label">{children}</h2>;
}
