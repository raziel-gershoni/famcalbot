'use client';

// The ⋯ menu (spec §7.2, Ruling R6; menu revamp 2026-11-24): a bottom sheet with five entries at most,
// in order: Settings; Calendars and Partner for everyone (FamCal is everyone's); Refresh (fresh=1 on
// every visible window); and Admin panel for admins inside Telegram (the admin panel is Telegram-only,
// so a browser never lists it). Google (connect, choose, reconnect, disconnect) lives on the Calendars
// hub and the Google calendars screen, and Plan and Feedback are rows in Settings; their routes and the
// bot's and the banners' ways in stay as they were. Calendars and Partner open the existing pages.

import { useTranslations } from 'next-intl';
import { BottomSheet } from '@/components/app-ui/BottomSheet';

export type MenuEntryId = 'settings' | 'calendars' | 'partner' | 'refresh' | 'admin';

export interface MenuEntry {
  id: MenuEntryId;
  /** Where it goes; null for Refresh, which stays on the home. */
  href: string | null;
}

/** The menu's entries, in order. `userId` is the page's own user_id (never swapped). */
export function menuEntries(o: { isAdmin: boolean; inTelegram: boolean; locale: string; userId: number }): MenuEntry[] {
  const page = (name: string) => `/${o.locale}/${name}?user_id=${o.userId}`;
  const out: MenuEntry[] = [{ id: 'settings', href: page('settings') }, { id: 'calendars', href: page('calendars') }, { id: 'partner', href: page('pair') }, { id: 'refresh', href: null }];
  if (o.isAdmin && o.inTelegram) out.push({ id: 'admin', href: page('admin-panel') });
  return out;
}

const ICONS: Record<MenuEntryId, string[]> = {
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ],
  calendars: ['M6 5h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z', 'M3 10h18M8 3v4M16 3v4'],
  partner: ['M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M17 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M17 14.5a5 5 0 0 1 4.5 5'],
  refresh: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v5h-5'],
  admin: ['M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z', 'M9 12l2 2 4-4'],
};

const LABELS: Record<MenuEntryId, string> = {
  settings: 'menu.settings',
  calendars: 'menu.calendars',
  partner: 'menu.partner',
  refresh: 'menu.refresh',
  admin: 'menu.admin',
};

export interface MenuSheetProps {
  isAdmin: boolean;
  /** readInitData() is non-empty: the admin entry shows only inside Telegram. */
  inTelegram: boolean;
  locale: string;
  userId: number;
  /** A page: the container closes the sheet and moves there. */
  onNavigate: (href: string) => void;
  /** Refresh: fresh=1 on every visible window. */
  onRefresh: () => void;
  onClose: () => void;
}

export function MenuSheet({ isAdmin, inTelegram, locale, userId, onNavigate, onRefresh, onClose }: MenuSheetProps) {
  const t = useTranslations('calendarHome');
  const entries = menuEntries({ isAdmin, inTelegram, locale, userId });
  return (
    <BottomSheet label={t('header.menu')} closeLabel={t('actions.close')} onClose={onClose} card>
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
