'use client';

// The Agenda (spec §7.3, §5, §7.5, §7.7; Rulings R8 and R10): the whole calendar home in
// Plan D, under D6's header. Presentational: CalendarHome (D6) owns the store, the
// fetches and the number of weeks, builds the model with buildAgenda (D3) and hands it
// here. From top to bottom:
// - the state rows (§5 States): a source that failed with no earlier data, a partial
//   Google answer, chosen calendars that are gone; each with Retry or Choose again;
// - the "Still open" card;
// - the days and fold lines (DayList), or Ruling R10's empty state, with only the hints
//   this user's plan allows;
// - "Show next week", which adds 7 days (Ruling R8).
// Until the first answer (agenda null) it shows placeholders. A Google user who hasn't
// finished the setup (no connection, or no calendars chosen) gets none of it: HomeBanners'
// Connect or Choose card is the call to action, and an Agenda read with nothing chosen
// would only say "Nothing planned".
//
// A tap on any row opens the item sheet. The container holds the selection (`selected`,
// `onSelect`), because it owns the home's one Telegram BackButton (spec §7.6), which
// closes this sheet and the send and menu sheets alike. AgendaView never touches it.

import { useCallback } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { sameItemRow, type AgendaModel, type AgendaRow } from '@/src/lib/calendar-view/agenda';
import type { HomeHints } from '@/src/lib/calendar-view/home-props';
import type { SourceName } from '@/src/lib/calendar-view/types';
import { DayList, PlaceholderRows } from './DayList';
import { ItemSheet, type SheetActions } from './ItemSheet';
import { StillOpenCard } from './StillOpenCard';

export interface AgendaViewProps {
  /** buildAgenda(store, weeks); null until the first answer pins the facts (placeholders). */
  agenda: AgendaModel | null;
  /** CalendarHomeProps.hints: which ways of adding things the empty state may name (Ruling R10). */
  hints: HomeHints;
  /** The row whose item sheet is open, or null. The container holds it (its BackButton closes the sheet). */
  selected: AgendaRow | null;
  /** A tap on a row: open its sheet (the row), or close it (null). */
  onSelect: (row: AgendaRow | null) => void;
  /** The open sheet's reminder actions (the container owns the request). */
  sheetActions?: SheetActions;
  /** "Show next week": the container adds a week and fetches agendaWeekWindow(today, weeks). */
  onShowNextWeek: () => void;
  /** Retry on a state row or the partial row: refetch that source's visible windows. */
  onRetry: (source: SourceName) => void;
  /** "Choose again" (calendars gone or unavailable): the existing select-calendars page. */
  onChooseCalendars: () => void;
}

function StateIcon() {
  return (
    <svg className="ch-icon ch-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </svg>
  );
}

function StateRow({ text, action, onAction }: { text: string; action: string; onAction: () => void }) {
  return (
    <div className="ch-state" role="status">
      <StateIcon />
      <span className="ch-state-text">{text}</span>
      <button type="button" className="ch-btn ch-state-action" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

function StateRows({ agenda, onRetry, onChooseCalendars }: { agenda: AgendaModel } & Pick<AgendaViewProps, 'onRetry' | 'onChooseCalendars'>) {
  const t = useTranslations('calendarHome');
  const rows = agenda.stateRows.map(({ source, failure }) => {
    if (failure.kind === 'calendarsGone') {
      return <StateRow key="calendars-gone" text={t('state.calendarsGone')} action={t('actions.chooseAgain')} onAction={onChooseCalendars} />;
    }
    const text = failure.kind === 'busy' ? t('state.busy') : source === 'famcal' ? t('state.famcalError') : t('state.googleError');
    return <StateRow key={`${failure.kind}-${source}`} text={text} action={t('actions.retry')} onAction={() => onRetry(source)} />;
  });
  if (agenda.partial) {
    rows.push(<StateRow key="partial" text={t('state.partial')} action={t('actions.retry')} onAction={() => onRetry('google')} />);
  }
  if (agenda.unavailableCalendars > 0) {
    rows.push(
      <StateRow
        key="unavailable"
        text={t('state.unavailable', { count: agenda.unavailableCalendars })}
        action={t('actions.chooseAgain')}
        onAction={onChooseCalendars}
      />,
    );
  }
  return rows.length > 0 ? <div className="ch-states">{rows}</div> : null;
}

/** Ruling R10: "Nothing planned", and only the ways of adding things this user can use. */
function EmptyState({ hints }: { hints: HomeHints }) {
  const t = useTranslations('calendarHome');
  return (
    <div className="ch-empty">
      <svg className="ch-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </svg>
      <h2 className="ch-empty-title">{t('empty.title')}</h2>
      {hints.voiceEvents ? <p className="ch-empty-hint">{t('empty.hintEvents')}</p> : null}
      {hints.reminders ? <p className="ch-empty-hint">{t('empty.hintReminders')}</p> : null}
    </div>
  );
}

/** The open sheet's item as the latest model has it (a refetch may have changed it), else as it was tapped. */
function latestRow(agenda: AgendaModel, selected: AgendaRow): AgendaRow {
  const days = agenda.entries.flatMap((entry) => (entry.type === 'day' ? entry.rows : []));
  const open = agenda.stillOpen ? [...agenda.stillOpen.shown, ...agenda.stillOpen.more] : [];
  return sameItemRow([...days, ...open], selected) ?? selected;
}

/** Before the first answer: placeholders, never free days (§5 States). */
function AgendaLoading() {
  const t = useTranslations('calendarHome');
  return (
    <div className="ch-loading" role="status">
      <span className="ch-visually-hidden">{t('shell.loading')}</span>
      <div className="ch-ghost-head" aria-hidden="true" />
      <PlaceholderRows count={3} />
      <div className="ch-ghost-head" aria-hidden="true" />
      <PlaceholderRows count={2} />
    </div>
  );
}

export function AgendaView({ agenda, hints, selected, onSelect, sheetActions, onShowNextWeek, onRetry, onChooseCalendars }: AgendaViewProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const openSheet = useCallback((row: AgendaRow) => onSelect(row), [onSelect]);
  const closeSheet = useCallback(() => onSelect(null), [onSelect]);
  // No model (before the first answer, or after a store drop): no sheet. The container
  // clears the selection on a drop, so the sheet doesn't open again by itself.
  const sheetRow = agenda && selected ? latestRow(agenda, selected) : null;

  return (
    <section className="ch-agenda" dir={locale === 'he' ? 'rtl' : 'ltr'} aria-busy={agenda === null || undefined}>
      <style>{AGENDA_CSS}</style>
      {agenda === null ? (
        <AgendaLoading />
      ) : (
        <>
          <StateRows agenda={agenda} onRetry={onRetry} onChooseCalendars={onChooseCalendars} />
          {agenda.stillOpen ? <StillOpenCard card={agenda.stillOpen} today={agenda.today} tz={agenda.tz} onOpen={openSheet} /> : null}
          {agenda.empty ? (
            <EmptyState hints={hints} />
          ) : (
            <DayList entries={agenda.entries} tz={agenda.tz} hebrewDates={agenda.hebrewDates} onOpen={openSheet} />
          )}
          <button type="button" className="ch-btn ch-more" onClick={onShowNextWeek}>
            {t('agenda.showNextWeek')}
          </button>
        </>
      )}
      {agenda && sheetRow ? <ItemSheet row={sheetRow} today={agenda.today} tz={agenda.tz} onClose={closeSheet} actions={sheetActions} /> : null}
    </section>
  );
}

/**
 * The Agenda's own styles. They read the tokens APP_THEME_CSS (components/app-ui/theme.ts) puts on
 * the home's root. Logical properties only; nothing under 11 px; taps at least 44 px.
 */
export const AGENDA_CSS = `
.ch-agenda {
  padding-block-end: calc(24px + max(env(safe-area-inset-bottom, 0px), var(--tg-safe-area-inset-bottom, 0px)));
}
.ch-states {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 16px 0;
}
.ch-state {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding-block: 4px;
  padding-inline: 12px 4px;
  border-radius: 12px;
  background: var(--ch-surface);
  font-size: 14px;
  line-height: 1.35;
}
.ch-state-icon {
  color: var(--ch-danger);
}
.ch-state-text {
  flex: 1;
  min-width: 0;
}
.ch-state-action {
  flex: none;
  background: transparent;
}
.ch-card {
  margin: 12px 16px 0;
  padding: 4px 14px;
  border-radius: 16px;
  background: var(--ch-card);
}
.ch-card-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding: 10px 0 2px;
}
.ch-card-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.ch-card-count {
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-card .ch-list {
  padding: 0;
}
.ch-card .ch-row-li {
  border-block-end: 1px solid var(--ch-card-separator);
}
.ch-card .ch-row-li:last-child {
  border-block-end: 0;
}
.ch-card-more {
  display: flex;
  inline-size: 100%;
  margin: 0 0 6px;
  background: transparent;
}
.ch-day-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 8px;
  margin: 22px 16px 2px;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.35;
}
.ch-day-label {
  font-weight: 600;
}
.ch-day-hebrew {
  color: var(--ch-muted);
}
.ch-list {
  list-style: none;
  margin: 0;
  padding: 0 16px;
}
.ch-row-li {
  border-block-end: 1px solid var(--ch-separator);
}
.ch-row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  inline-size: 100%;
  min-height: 44px;
  margin: 0;
  padding: 11px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 16px;
  text-align: start;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-stripe {
  flex: none;
  align-self: stretch;
  inline-size: 4px;
  border-radius: 2px;
  background: var(--ch-dot-mine);
}
.ch-stripe.is-partner {
  border: 1.5px solid var(--ch-dot-partner);
  background: transparent;
}
.ch-stripe.has-cal {
  background: var(--cal-line);
}
.ch-stripe.has-cal.is-partner {
  border-color: var(--cal-line);
  background: transparent;
}
.ch-cal-chip.has-cal {
  border-color: var(--cal-fill);
  background: var(--cal-fill);
  color: var(--cal-text);
  font-weight: 500;
}
.ch-cal-chip.has-cal.is-partner {
  border-color: var(--cal-line);
  background: transparent;
}
.ch-time {
  flex: none;
  inline-size: 56px;
  font-size: 14px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: break-word;
}
.ch-time-main,
.ch-time-sub {
  display: block;
}
.ch-time-sub {
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-body {
  display: block;
  flex: 1;
  min-width: 0;
}
.ch-title-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.ch-icon {
  flex: none;
  inline-size: 20px;
  block-size: 20px;
}
.ch-icon-open {
  color: var(--ch-accent);
}
.ch-icon-done,
.ch-icon-later {
  color: var(--ch-muted);
}
.ch-title {
  display: block;
  min-width: 0;
  font-size: 16px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.ch-count {
  display: inline-block;
  margin-inline-start: 6px;
  padding-inline: 6px;
  border-radius: 10px;
  background: var(--ch-surface);
  color: var(--ch-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  vertical-align: 1px;
}
.is-done .ch-title,
.is-done .ch-sheet-title {
  color: var(--ch-done);
  text-decoration: line-through;
}
.ch-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin-block-start: 3px;
  font-size: 13px;
  line-height: 18px;
  color: var(--ch-muted);
}
.ch-indent {
  padding-inline-start: 28px;
}
.ch-meta-text {
  min-width: 0;
  max-inline-size: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-open {
  color: var(--ch-accent);
  font-weight: 600;
}
.ch-badge {
  padding: 0 6px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 18px;
  background: var(--ch-surface);
  color: var(--ch-text);
}
.ch-nothing {
  margin: 0 16px;
  padding: 10px 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-fold {
  margin: 18px 16px 0;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--ch-surface);
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-ghosts {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 16px 0;
}
.ch-ghost,
.ch-ghost-head {
  border-radius: 12px;
  background: var(--ch-surface);
  animation: ch-pulse 1.4s ease-in-out infinite;
}
.ch-ghost {
  block-size: 48px;
}
.ch-ghost-head {
  block-size: 18px;
  inline-size: 40%;
  margin: 22px 16px 0;
  border-radius: 6px;
}
@keyframes ch-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
.ch-empty {
  margin: 24px 16px 0;
  padding: 24px 16px;
  border-radius: 16px;
  background: var(--ch-surface);
  text-align: center;
}
.ch-empty-icon {
  inline-size: 32px;
  block-size: 32px;
  color: var(--ch-accent);
}
.ch-empty-title {
  margin: 8px 0 0;
  font-size: 17px;
  font-weight: 600;
}
.ch-empty-hint {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-more {
  display: flex;
  inline-size: calc(100% - 32px);
  min-height: 48px;
  margin: 24px 16px 8px;
  border: 1px solid var(--ch-outline);
  background: transparent;
}
.ch-sheet-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.ch-sheet-head .ch-icon {
  margin-block-start: 4px;
}
.ch-sheet-head .ch-sheet-title {
  flex: 1;
  min-inline-size: 0;
}
.ch-sheet-head .ch-sheet-edit {
  flex: none;
  margin-block-start: -6px;
  color: var(--ch-accent);
}
.ch-sheet-delete {
  display: flex;
  inline-size: 100%;
  margin-block-start: 12px;
  background: transparent;
  color: var(--ch-danger);
}
.ch-sheet-delete:disabled {
  opacity: 0.6;
  cursor: default;
}
.ch-sheet-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.ch-when {
  margin: 8px 0 0;
  font-size: 15px;
}
.ch-when-date,
.ch-when-time {
  display: block;
}
.ch-when-time {
  color: var(--ch-muted);
}
.ch-sheet-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
.ch-sheet-state {
  margin: 10px 0 0;
  font-size: 14px;
  font-weight: 500;
}
.ch-facts {
  margin: 14px 0 0;
}
.ch-fact {
  padding: 10px 0;
  border-block-start: 1px solid var(--ch-separator);
}
.ch-fact dt {
  font-size: 12px;
  color: var(--ch-muted);
}
.ch-fact dd {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 0;
  font-size: 15px;
  overflow-wrap: anywhere;
}
.ch-fact dd.ch-notes {
  display: block;
  white-space: pre-wrap;
}
.ch-swatch {
  flex: none;
  inline-size: 10px;
  block-size: 10px;
  border-radius: 50%;
}
.ch-sheet-action {
  display: flex;
  inline-size: 100%;
  min-height: 48px;
  margin-block-start: 16px;
}
.ch-actions {
  margin-block-start: 4px;
}
.ch-actions .ch-sheet-action {
  margin-block-start: 12px;
}
.ch-snooze {
  margin-block-start: 12px;
}
.ch-snooze-label {
  display: block;
  margin-block-end: 6px;
  font-size: 13px;
  color: var(--ch-muted);
}
.ch-snooze-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.ch-actions .ch-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.ch-spinner {
  flex: none;
  inline-size: 14px;
  block-size: 14px;
  border: 2px solid currentColor;
  border-inline-end-color: transparent;
  border-radius: 50%;
  animation: ch-spin 0.8s linear infinite;
}
@keyframes ch-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ch-spinner {
    animation-duration: 3s;
  }
}
.ch-sheet-note {
  margin: 12px 0 0;
  font-size: 14px;
  color: var(--ch-muted);
}
`;
