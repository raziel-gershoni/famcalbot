'use client';

// The Month tab (spec §7.4, §7.5, §7.6; Rulings R11 and R12; Plan E Rulings 4 and 6):
// the browse layout (E6's MonthBrowse) or the picked one (E7's MonthPicked), as the
// container's MonthUi says. Presentational: CalendarHome owns the store, the fetches, the
// layout and its memory, and Telegram's BackButton and swipes. This file only turns the
// views' taps into the next MonthUi (month.ts's helpers) and hands it to onUi.
//
// - "N calendars aren't available · Choose again" shows once, above either layout
//   (Ruling 4), as the Agenda's state row does. In browse its styles come with it; in
//   picked MonthPicked already renders D's AGENDA_CSS.
// - Browse is mounted only while it shows, and again each time it comes back (back from
//   picked, a tab switch): MonthBrowse reads `start` and measures the page on mount.
// - Picked is one MonthPicked for as long as picked shows, never keyed by month or day:
//   a chevron must not scroll the page to the top again.
// - A row tapped under the picked day opens D's ItemSheet, as in AgendaView: the
//   container holds the selection (its BackButton closes the sheet), and the sheet shows
//   the row as the latest answer has it, else as it was tapped.
// - Until a month has a model (a store drop at midnight, or a model drawn under another
//   week start), picked draws it as loading, so a day never looks free before it is
//   answered (§5); browse does the same for each of its months.

import { useTranslations } from 'next-intl';
import type { AgendaRow } from '@/src/lib/calendar-view/agenda';
import { monthGrid, type MonthKey } from '@/src/lib/calendar-view/grid';
import { backToBrowse, canStep, loadingMonth, pickDay, pickToday, stepMonth, type MonthModel, type MonthUi } from '@/src/lib/calendar-view/month';
import type { DayStatus } from '@/src/lib/calendar-view/store';
import type { DayKey, SourceName, WeekStart } from '@/src/lib/calendar-view/types';
import { AGENDA_CSS } from './AgendaView';
import { ItemSheet, type SheetActions } from './ItemSheet';
import { MonthBrowse } from './MonthBrowse';
import { MonthPicked } from './MonthPicked';

export interface MonthViewProps {
  /** The facts the Month draws with: the pinned ones, or the last ones through a store drop. */
  today: DayKey;
  tz: string;
  weekStart: WeekStart;
  hebrewDates: boolean;
  /** The window, oldest first: monthSpan(today), memoized. */
  months: readonly MonthKey[];
  /** monthModels(store): a month's model, or null (it then draws as loading). */
  getMonth: (month: MonthKey) => MonthModel | null;
  /** Where the Month is: the layout, its month and, in picked, the selected day. */
  ui: MonthUi;
  /** Where browse opens when it mounts (MonthBrowse reads it then only). */
  start: { month: MonthKey; peek: boolean };
  /** The picked day's list: dayRows(store, day) and dayStatus(store, day). null in browse. */
  dayRows: { rows: AgendaRow[]; status: DayStatus } | null;
  /** homeNotices(store).unavailableCalendars: chosen Google calendars that are gone. */
  unavailableCalendars: number;
  /** The row whose item sheet is open (picked only), or null. The container holds it. */
  selected: AgendaRow | null;
  /** A tap on a row: open its sheet (the row), or close it (null). */
  onSelect: (row: AgendaRow | null) => void;
  /** The open sheet's reminder actions (the container owns the request). */
  sheetActions?: SheetActions;
  /** The next MonthUi: a day picked, a chevron, Today, "All months". */
  onUi: (ui: MonthUi) => void;
  /** MonthBrowse's near months and month in view, for the container's wantedMonths. */
  onNearMonths: (months: MonthKey[]) => void;
  onMonthInView: (month: MonthKey) => void;
  /** Retry on a month's notice: the container asks that month's window again. */
  onRetryMonth: (month: MonthKey, source: SourceName) => void;
  /** "Choose again": the existing select-calendars page. */
  onChooseCalendars: () => void;
}

/** The month's model when it fits this week start, else the loading one. */
function modelFor(getMonth: MonthViewProps['getMonth'], month: MonthKey, weekStart: WeekStart, today: DayKey): MonthModel {
  const model = getMonth(month);
  const first = monthGrid(month, weekStart)[0]?.[0];
  return model && first !== undefined && model.weeks[0]?.[0]?.day === first ? model : loadingMonth(month, weekStart, today);
}

/** The open sheet's item as the picked day's latest rows have it (a refetch may have changed it), else as it was tapped. */
function latestRow(rows: readonly AgendaRow[], selected: AgendaRow): AgendaRow {
  return rows.find((row) => row.item.key === selected.item.key) ?? selected;
}

function StateIcon() {
  return (
    <svg className="ch-icon ch-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </svg>
  );
}

/** "N calendars aren't available · Choose again", once above the Month (Ruling 4). */
function UnavailableRow({ count, withStyles, onChooseCalendars }: { count: number; withStyles: boolean; onChooseCalendars: () => void }) {
  const t = useTranslations('calendarHome');
  return (
    <>
      {withStyles ? <style>{AGENDA_CSS}</style> : null}
      <div className="ch-states">
        <div className="ch-state" role="status">
          <StateIcon />
          <span className="ch-state-text">{t('state.unavailable', { count })}</span>
          <button type="button" className="ch-btn ch-state-action" onClick={onChooseCalendars}>
            {t('actions.chooseAgain')}
          </button>
        </div>
      </div>
    </>
  );
}

export function MonthView({
  today,
  tz,
  weekStart,
  hebrewDates,
  months,
  getMonth,
  ui,
  start,
  dayRows,
  unavailableCalendars,
  selected,
  onSelect,
  sheetActions,
  onUi,
  onNearMonths,
  onMonthInView,
  onRetryMonth,
  onChooseCalendars,
}: MonthViewProps) {
  const picked = ui.layout === 'picked' && ui.selected !== null ? ui.selected : null;
  const unavailable =
    unavailableCalendars > 0 ? <UnavailableRow count={unavailableCalendars} withStyles={picked === null} onChooseCalendars={onChooseCalendars} /> : null;

  if (picked === null) {
    return (
      <>
        {unavailable}
        <MonthBrowse
          months={months}
          today={today}
          weekStart={weekStart}
          hebrewDates={hebrewDates}
          getMonth={getMonth}
          start={start}
          onNearMonths={onNearMonths}
          onMonthInView={onMonthInView}
          onPickDay={(day) => onUi(pickDay(ui, day))}
          onRetryMonth={onRetryMonth}
          onChooseCalendars={onChooseCalendars}
        />
      </>
    );
  }

  const list = dayRows ?? { rows: [], status: 'loading' as const };
  const sheetRow = selected ? latestRow(list.rows, selected) : null;
  return (
    <>
      {unavailable}
      <MonthPicked
        model={modelFor(getMonth, ui.month, weekStart, today)}
        selected={picked}
        today={today}
        tz={tz}
        weekStart={weekStart}
        hebrewDates={hebrewDates}
        canPrev={canStep(ui, -1, today)}
        canNext={canStep(ui, 1, today)}
        rows={list.rows}
        dayStatus={list.status}
        onSelectDay={(day) => onUi(pickDay(ui, day))}
        onPrev={() => onUi(stepMonth(ui, -1, today))}
        onNext={() => onUi(stepMonth(ui, 1, today))}
        onToday={() => onUi(pickToday(ui, today))}
        onAllMonths={() => onUi(backToBrowse(ui))}
        onOpenItem={onSelect}
        onRetryMonth={onRetryMonth}
        onChooseCalendars={onChooseCalendars}
      />
      {sheetRow ? <ItemSheet row={sheetRow} today={today} tz={tz} onClose={() => onSelect(null)} actions={sheetActions} /> : null}
    </>
  );
}
