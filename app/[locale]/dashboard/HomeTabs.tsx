'use client';

// The calendar home's tab bar (spec §7.1, §7.7; Plan E Rulings 1 and 2; the approved
// Main.dc.html): Agenda and Month as one segmented control under the header.
// Presentational: the container (CalendarHome) holds the tab, remembers it
// (home-storage's readHomeTab / writeHomeTab) and decides when the bar shows (Ruling 1).
//
// - A tablist named by tabs.label, then two tabs. Each tab has its id (TAB_IDS),
//   aria-selected, and aria-controls naming its panel (PANEL_IDS). The container gives
//   each panel role="tabpanel", that id and aria-labelledby. Only the selected tab is in
//   the Tab order (a roving tabIndex).
// - The arrow keys follow the reading direction: the next tab is to the right in
//   English and Russian, and to the left in Hebrew. Both wrap. Home and End go to the
//   first and the last tab. Focus moves there, and the key selects that tab (automatic
//   activation): both panels are in-page state, so a switch shows at once.
// - A tap on the other tab selects it; a tap on the selected one does nothing.
// - Each tab is a full 44 px tall. The mockup's segmented look is an inset pill inside
//   it. The selected tab's label is also semibold, so the state never rests on colour
//   alone.
// - No hover styles (touch only), logical properties only, nothing under 11 px.

import { useRef, type KeyboardEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { HomeTab } from '@/src/lib/calendar-view/home-storage';

/** Each tab's element id. */
export const TAB_IDS = { agenda: 'ch-tab-agenda', month: 'ch-tab-month' } as const;
/** Each panel's element id, for the tab's aria-controls (the container renders the panels). */
export const PANEL_IDS = { agenda: 'ch-panel-agenda', month: 'ch-panel-month' } as const;

export interface HomeTabsProps {
  /** The tab on screen. */
  tab: HomeTab;
  /** The user picked another tab (a tap, or a key). Never called with the tab already on screen. */
  onTab: (tab: HomeTab) => void;
}

/** The tabs in reading order. */
const ORDER: readonly HomeTab[] = ['agenda', 'month'];

export function HomeTabs({ tab, onTab }: HomeTabsProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const rtl = locale === 'he';
  const buttons = useRef<Partial<Record<HomeTab, HTMLButtonElement | null>>>({});

  const pick = (next: HomeTab) => {
    if (next !== tab) onTab(next);
  };

  /** A key on the tab `from` (the focused one; with the roving tabIndex, normally the selected one). */
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, from: HomeTab) => {
    const at = ORDER.indexOf(from);
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: HomeTab | null = null;
    if (event.key === forward) next = ORDER[(at + 1) % ORDER.length];
    else if (event.key === backward) next = ORDER[(at + ORDER.length - 1) % ORDER.length];
    else if (event.key === 'Home') next = ORDER[0];
    else if (event.key === 'End') next = ORDER[ORDER.length - 1];
    if (!next) return;
    event.preventDefault();
    buttons.current[next]?.focus();
    pick(next);
  };

  return (
    <>
      <style>{TABS_CSS}</style>
      <div className="ch-tabs" role="tablist" aria-label={t('tabs.label')} dir={rtl ? 'rtl' : 'ltr'}>
        {ORDER.map((id) => {
          const selected = id === tab;
          return (
            <button
              key={id}
              ref={(el) => {
                buttons.current[id] = el;
              }}
              type="button"
              role="tab"
              id={TAB_IDS[id]}
              className="ch-tab"
              aria-selected={selected}
              aria-controls={PANEL_IDS[id]}
              tabIndex={selected ? 0 : -1}
              onClick={() => pick(id)}
              onKeyDown={(event) => onKeyDown(event, id)}
            >
              <span className="ch-tab-pill">{id === 'agenda' ? t('tabs.agenda') : t('tabs.month')}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * The tab bar's styles. They read the tokens APP_THEME_CSS (components/app-ui/theme.ts) puts on
 * .ch-app: --ch-tab-track behind both tabs, --ch-tab-on / --ch-tab-on-text /
 * --ch-tab-shadow for the selected one, D's --ch-muted (the contrast floor) for the other
 * label and --ch-accent for the focus ring. The 16 px side gutter matches the header's.
 * The pill sits 4 px inside the track, with 4 px between the two pills, as in the mockup.
 */
export const TABS_CSS = `
.ch-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-block: 0 4px;
  margin-inline: 16px;
  border-radius: 12px;
  background: var(--ch-tab-track);
}
.ch-tab {
  display: flex;
  align-items: stretch;
  min-width: 0;
  min-height: 44px;
  margin: 0;
  padding-block: 4px;
  padding-inline: 4px 2px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--ch-muted);
  font-family: inherit;
  font-size: 15px;
  font-weight: 500;
  line-height: 1.2;
  text-align: center;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-tab + .ch-tab {
  padding-inline: 2px 4px;
}
.ch-tab-pill {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding-inline: 8px;
  border-radius: 9px;
}
.ch-tab[aria-selected='true'] {
  color: var(--ch-tab-on-text);
  font-weight: 600;
}
.ch-tab[aria-selected='true'] .ch-tab-pill {
  background: var(--ch-tab-on);
  box-shadow: var(--ch-tab-shadow);
}
.ch-tab:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 2px;
}
`;
