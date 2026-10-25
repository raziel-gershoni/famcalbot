'use client';

// The bar at the foot of the home after a drag (editor upgrades spec §4): "Moved to Thu 15 Oct" with
// Undo, "Moved back", the note for an item that can't move, or the editor's error copy when a drop
// failed. It stays six seconds (the container owns the timer); a newer drag replaces it. The region
// is always in the page and announces politely, so a screen reader hears each text as it comes.
//
// Tokens: the inverse pair the Month already uses for the selected day (--ch-selected on
// --ch-selected-text), so it reads on both themes without a new colour. The Undo button is a 44 px
// target. Logical properties only; nothing moves in.

import { useLocale, useTranslations } from 'next-intl';
import type { CantLift } from '@/src/lib/calendar-view/drag-model';
import type { EditScope } from '@/src/lib/calendar-view/editor-types';
import { formatDayShort } from '@/src/lib/calendar-view/format';
import type { DayKey } from '@/src/lib/calendar-view/types';
import { useErrorText, type SubmitError } from './ScopeSheet';

/** What Undo needs: the key the PATCH answered, the scope it used and how far the item moved. */
export interface UndoEntry {
  key: string;
  scope: EditScope;
  days: number;
}

/** What the bar says. */
export type BarContent =
  | { kind: 'moved'; day: DayKey; undo: UndoEntry | null }
  | { kind: 'undone' }
  | { kind: 'note'; note: CantLift }
  /**
   * error: the editor's copy for the failure: a message key under calendarHome (an inline error such as
   * editor.errors.errSeriesYear, or the day-move note), else a write's failure, else null for the drag's own ("Couldn't move it").
   */
  | { kind: 'error'; error: SubmitError | null; key?: string };

/** The bar's content with an `id` that is new for each, so a newer one restarts the timer. */
export type BarState = { id: number } & BarContent;

export interface DragBarProps {
  bar: BarState | null;
  /** The Undo request is running. */
  undoing: boolean;
  onUndo: (entry: UndoEntry) => void;
}

function BarText({ bar }: { bar: BarState }) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const errorText = useErrorText(bar.kind === 'error' && !bar.key ? bar.error : null);
  switch (bar.kind) {
    case 'moved':
      return <>{t('drag.moved', { date: formatDayShort(bar.day, locale) })}</>;
    case 'undone':
      return <>{t('drag.undone')}</>;
    case 'note':
      return <>{t(`drag.${bar.note}`)}</>;
    case 'error':
      return <>{bar.key ? t(bar.key) : (errorText ?? t('drag.failed'))}</>;
  }
}

export function DragBar({ bar, undoing, onUndo }: DragBarProps) {
  const t = useTranslations('calendarHome');
  const undo = bar && bar.kind === 'moved' ? bar.undo : null;
  return (
    <div className="ch-dbar-region" aria-live="polite">
      <style>{DRAG_BAR_CSS}</style>
      {bar ? (
        <div className="ch-dbar" key={bar.id}>
          <span className="ch-dbar-text" dir="auto">
            <BarText bar={bar} />
          </span>
          {undo ? (
            <button type="button" className="ch-dbar-undo" disabled={undoing} aria-busy={undoing || undefined} onClick={() => onUndo(undo)}>
              {t('drag.undo')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const DRAG_BAR_CSS = `
.ch-dbar-region {
  position: fixed;
  inset-inline: 12px;
  inset-block-end: calc(12px + max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)));
  z-index: 40;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.ch-dbar {
  display: flex;
  align-items: center;
  gap: 4px;
  max-inline-size: 100%;
  min-block-size: 48px;
  padding-block: 0;
  padding-inline: 16px 4px;
  border-radius: 14px;
  background: var(--ch-selected);
  color: var(--ch-selected-text);
  box-shadow: var(--ch-sheet-shadow);
  font-size: 15px;
  line-height: 1.3;
  pointer-events: auto;
}
.ch-dbar-text {
  padding-block: 10px;
  padding-inline-end: 8px;
}
.ch-dbar-undo {
  min-block-size: 44px;
  min-inline-size: 44px;
  padding-inline: 14px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.ch-dbar-undo:disabled {
  opacity: 0.6;
  cursor: default;
}
.ch-dbar-undo:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: -2px;
}
`;
