'use client';

// The ⋯ menu (spec §7.2, Ruling R6): a bottom sheet with Settings; Calendars and Partner
// for everyone (FamCal is everyone's); the Google entries by the user's Google state (spec
// "Google as a connection" §2): Connect Google Calendar for a user who never connected,
// Choose calendars and Reconnect Google with a token, Reconnect Google alone for a cleared
// token; Subscription; Refresh (fresh=1 on every visible window); Feedback; and Admin panel
// for admins. Calendars and Partner open the existing pages as they are.

import { useTranslations } from 'next-intl';
import type { GoogleState } from '@/src/lib/google-state';
import { BottomSheet } from './BottomSheet';

export type MenuEntryId = 'settings' | 'calendars' | 'partner' | 'connectGoogle' | 'chooseCalendars' | 'reconnectGoogle' | 'subscription' | 'refresh' | 'feedback' | 'admin';

export interface MenuEntry {
  id: MenuEntryId;
  /** Where it goes; null for Refresh, which stays on the home. */
  href: string | null;
}

/** The menu's entries, in order. `userId` is the page's own user_id (never swapped). */
export function menuEntries(o: { googleState: GoogleState; isAdmin: boolean; locale: string; userId: number }): MenuEntry[] {
  const page = (name: string) => `/${o.locale}/${name}?user_id=${o.userId}`;
  const token = `/refresh-token?user_id=${o.userId}`;
  const out: MenuEntry[] = [{ id: 'settings', href: page('settings') }, { id: 'calendars', href: page('calendars') }, { id: 'partner', href: page('pair') }];
  // Connecting and reconnecting are the same trip to Google's consent screen.
  if (o.googleState === 'none') out.push({ id: 'connectGoogle', href: token });
  else if (o.googleState === 'reconnect') out.push({ id: 'reconnectGoogle', href: token });
  else out.push({ id: 'chooseCalendars', href: page('select-calendars') }, { id: 'reconnectGoogle', href: token });
  out.push({ id: 'subscription', href: page('subscription') }, { id: 'refresh', href: null }, { id: 'feedback', href: page('feedback') });
  if (o.isAdmin) out.push({ id: 'admin', href: page('admin-panel') });
  return out;
}

const ICONS: Record<MenuEntryId, string[]> = {
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ],
  calendars: ['M6 5h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z', 'M3 10h18M8 3v4M16 3v4'],
  chooseCalendars: ['M6 5h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z', 'M3 10h18M8 3v4M16 3v4', 'M9 15l2 2 4-4'],
  connectGoogle: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  partner: ['M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M17 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M17 14.5a5 5 0 0 1 4.5 5'],
  reconnectGoogle: ['M21 12a9 9 0 0 1-15.4 6.4', 'M3 12a9 9 0 0 1 15.4-6.4', 'M18 2v4h-4', 'M6 22v-4h4'],
  subscription: ['M12 3l2.7 5.5 6 .9-4.3 4.2 1 6L12 16.8 6.6 19.6l1-6L3.3 9.4l6-.9z'],
  refresh: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v5h-5'],
  feedback: ['M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z'],
  admin: ['M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z', 'M9 12l2 2 4-4'],
};

const LABELS: Record<MenuEntryId, string> = {
  settings: 'menu.settings',
  calendars: 'menu.calendars',
  partner: 'menu.partner',
  connectGoogle: 'menu.connectGoogle',
  chooseCalendars: 'menu.chooseCalendars',
  reconnectGoogle: 'menu.reconnectGoogle',
  subscription: 'menu.subscription',
  refresh: 'menu.refresh',
  feedback: 'menu.feedback',
  admin: 'menu.admin',
};

export interface MenuSheetProps {
  googleState: GoogleState;
  isAdmin: boolean;
  locale: string;
  userId: number;
  /** A page: the container closes the sheet and moves there. */
  onNavigate: (href: string) => void;
  /** Refresh: fresh=1 on every visible window. */
  onRefresh: () => void;
  onClose: () => void;
}

export function MenuSheet({ googleState, isAdmin, locale, userId, onNavigate, onRefresh, onClose }: MenuSheetProps) {
  const t = useTranslations('calendarHome');
  const entries = menuEntries({ googleState, isAdmin, locale, userId });
  return (
    <BottomSheet label={t('header.menu')} closeLabel={t('actions.close')} onClose={onClose}>
      <ul className="ch-options" role="list">
        {entries.map(({ id, href }) => (
          <li key={id} className="ch-option-li">
            <button
              type="button"
              className="ch-option ch-option-compact ch-tap"
              data-menu={id}
              onClick={() => (href === null ? onRefresh() : onNavigate(href))}
            >
              <span className="ch-option-icon ch-option-icon-sm">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  {ICONS[id].map((d) => (
                    <path key={d} d={d} />
                  ))}
                </svg>
              </span>
              <span className="ch-option-title">{t(LABELS[id])}</span>
            </button>
          </li>
        ))}
      </ul>
    </BottomSheet>
  );
}
