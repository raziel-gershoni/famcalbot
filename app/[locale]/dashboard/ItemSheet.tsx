'use client';

// An item's details (spec §7.5): a view-only bottom sheet with the title and time range,
// the calendar (masked for a partner's private calendar), the location, the description
// as plain text, whose it is or who set it, and the reminder's state. Google items add
// "Open in Google Calendar" (Telegram's openLink, through D4's openExternalLink).
//
// A FamCal reminder the viewer may act on (its owner or its creator, from the DTO's
// flags) also shows its actions under the state line (reminder-actions spec §1): Done and
// Snooze while it is open, snoozed or not yet due (Done only before its time), Not done
// once it is done. The state line and the actions read the occurrence's own state now
// (reminderStateAt), never the per-day mark of the row it was opened from. The container owns the request (`actions`): this sheet only draws the
// buttons, disabled while one is in flight, and the note after a tap that could not apply.
//
// Editing (home editing spec §2): a FamCal item the viewer may change shows a pencil in the
// header, and one they may delete shows "Delete event" / "Delete reminder" at the bottom,
// both from `actions.editing`, which the container fills once the item's edit info has
// arrived (none before). A Google event on a calendar the viewer can write to but that
// only Google can change (guests, a special type) says so instead (3b spec §2.4). The sheet
// only draws them; the container opens the editor and asks before deleting.
//
// Telegram's BackButton closes it: the container owns the button (useTelegramBackButton)
// and the selection, so this sheet only renders. In a browser, the Close button, a tap on
// the scrim and Escape do the same.

import { useLocale, useTranslations } from 'next-intl';
import { reminderStateAt, type AgendaRow } from '@/src/lib/calendar-view/agenda';
import type { ItemKind } from '@/src/lib/calendar-view/editor-types';
import type { ReminderActionName } from '@/src/lib/calendar-view/reminder-client';
import type { DayKey, ItemDTO } from '@/src/lib/calendar-view/types';
import {
  allDayLastDay,
  formatDayRange,
  formatDayShort,
  formatDayTime,
  formatTime,
  formatWeekdayTime,
  instantDay,
} from '@/src/lib/calendar-view/format';
import { openExternalLink } from '@/src/lib/telegram-ui';
import { BottomSheet } from './BottomSheet';
import { hebrewRepeatText, type HebrewRepeat } from './hebrew-repeat-words';
import { AnniversaryCount, PersonChip, ReminderIcon, useItemTitle } from './ItemRow';

/** A calendar's colour is only an accent (Ruling R7), and only a plain hex one is drawn. */
const HEX_COLOUR = /^#[0-9a-f]{3,8}$/i;

/** Why a tap changed nothing (calendarHome.sheet.actionNotes). */
/** movedLeft: a cross-source move made its copy, but the original is still in a calendar (noteValues.calendar). */
export type SheetNote = 'changed' | 'alreadyDone' | 'notYours' | 'failed' | 'movedLeft';

/** What the container gives the sheet for editing: the viewer's rights on this item, from its edit info. */
export interface SheetEditing {
  canEdit: boolean;
  canDelete: boolean;
  /** A writable Google event that can only be changed in Google Calendar: the line says so. */
  googleOnly?: boolean;
  kind: ItemKind;
  onEdit: () => void;
  onDelete: () => void;
}

/** What the container gives the sheet for the reminder actions. Without it the sheet shows none. */
export interface SheetActions {
  /** A request is in flight (for any item): every button is disabled. */
  busy: boolean;
  /** The action in flight on this item, which shows the spinner. */
  pending: ReminderActionName | null;
  note: SheetNote | null;
  /** The note's values: the calendar of movedLeft. */
  noteValues?: { calendar: string };
  /** The clock (ms) the reminder's state is read at: due or not yet. */
  now: number;
  onAction: (action: ReminderActionName) => void;
  /** The viewer's editing rights on the open item, once known. */
  editing?: SheetEditing;
  /** The open item's Hebrew-date repeat (its interval and anchor), once its info is known: the repeat tag names it (hebrew-repeats spec §1, §4). */
  hebrewRepeat?: HebrewRepeat;
}

export interface ItemSheetProps {
  row: AgendaRow;
  today: DayKey;
  tz: string;
  onClose: () => void;
  actions?: SheetActions;
}

/** Whether the viewer can act on this item: a FamCal reminder that is theirs or that they made. */
function canAct(item: ItemDTO): boolean {
  const r = item.reminder;
  return item.source === 'famcal' && item.kind === 'reminder' && !!r && (r.ownerIsViewer || r.creatorIsViewer) && !!item.seriesId && !!item.originalStart;
}

const SNOOZES = [
  ['snooze15', 'sheet.actions.snooze15'],
  ['snooze60', 'sheet.actions.snooze60'],
  ['snoozeTomorrow', 'sheet.actions.snoozeTomorrow'],
] as const;

function Spinner() {
  return <span className="ch-spinner" aria-hidden="true" />;
}

function CheckIcon() {
  return (
    <svg className="ch-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M13.5 8.5l3 3" />
    </svg>
  );
}

/** Done / Snooze / Not done, by the reminder's state. */
function ReminderActions({ mark, actions }: { mark: AgendaRow['mark']; actions: SheetActions }) {
  const t = useTranslations('calendarHome');
  const { busy, pending, onAction } = actions;
  if (mark === 'done') {
    return (
      <div className="ch-actions">
        <button type="button" className="ch-btn ch-sheet-action ch-action-undo" disabled={busy} aria-busy={pending === 'undo' || undefined} onClick={() => onAction('undo')}>
          {pending === 'undo' ? <Spinner /> : null}
          {t('sheet.actions.undo')}
        </button>
      </div>
    );
  }
  return (
    <div className="ch-actions">
      <button type="button" className="ch-btn ch-btn-primary ch-sheet-action" disabled={busy} aria-busy={pending === 'done' || undefined} onClick={() => onAction('done')}>
        {pending === 'done' ? <Spinner /> : <CheckIcon />}
        {t('sheet.actions.done')}
      </button>
      {mark === 'later' ? null : (
        <div className="ch-snooze" role="group" aria-label={t('sheet.actions.snoozeLabel')}>
          <span className="ch-snooze-label">{t('sheet.actions.snoozeLabel')}</span>
          <div className="ch-snooze-row">
            {SNOOZES.map(([action, key]) => (
              <button key={action} type="button" className="ch-btn" disabled={busy} aria-busy={pending === action || undefined} onClick={() => onAction(action)}>
                {pending === action ? <Spinner /> : null}
                {t(key)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** When it happens: a date line, and a time line for a timed item that starts and ends on one day. */
function When({ item, tz }: { item: ItemDTO; tz: string }) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  if (item.allDay) {
    return (
      <p className="ch-when">
        <span className="ch-when-date">{formatDayRange(item.start, allDayLastDay(item), locale)}</span>
        <span className="ch-when-time">{t('row.allDay')}</span>
      </p>
    );
  }
  const startDay = instantDay(item.start, tz);
  const endDay = instantDay(item.end, tz);
  const hasEnd = Date.parse(item.end) > Date.parse(item.start);
  if (!hasEnd || startDay === endDay) {
    const range = hasEnd ? `${formatTime(item.start, tz, locale)} – ${formatTime(item.end, tz, locale)}` : formatTime(item.start, tz, locale);
    return (
      <p className="ch-when">
        <span className="ch-when-date">{startDay ? formatDayShort(startDay, locale) : ''}</span>
        <span className="ch-when-time" dir="ltr">
          {range}
        </span>
      </p>
    );
  }
  return (
    <p className="ch-when">
      <span className="ch-when-date">
        <bdi>{formatDayTime(item.start, tz, locale)}</bdi> – <bdi>{formatDayTime(item.end, tz, locale)}</bdi>
      </span>
    </p>
  );
}

/** The reminder's state, as text beside its icon. */
function useReminderState(item: ItemDTO, mark: AgendaRow['mark'], today: DayKey, tz: string): string | null {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const r = item.reminder;
  if (!r || !mark) return null;
  const timeAround = (value: string | null) =>
    instantDay(value, tz) === today ? formatTime(value, tz, locale) : formatWeekdayTime(value, tz, locale);
  if (mark === 'done') {
    return r.doneAt && instantDay(r.doneAt, tz) === today ? t('sheet.stateDoneAt', { time: formatTime(r.doneAt, tz, locale) }) : t('sheet.stateDone');
  }
  if (mark === 'snoozed') return t('sheet.stateSnoozed', { time: timeAround(r.snoozedUntil) });
  if (mark === 'open') return t('sheet.stateOpen');
  return t('sheet.stateLater');
}

export function ItemSheet({ row, today, tz, onClose, actions }: ItemSheetProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const { item, whose } = row;
  // A reminder's state as it is now; a row's own mark is for its day's list.
  const mark = actions ? reminderStateAt(item, actions.now, tz) : row.mark;
  const title = useItemTitle(item);
  const state = useReminderState(item, mark, today, tz);
  const editing = actions?.editing;

  const tags: string[] = [];
  if (item.kind === 'reminder') tags.push(t('row.reminder'));
  if (item.birthday) tags.push(t('row.birthday'));
  if (item.repeatsDaily) tags.push(t('sheet.everyDay'));
  else if (item.recurring) tags.push(actions?.hebrewRepeat ? hebrewRepeatText(t, locale, actions.hebrewRepeat) : t('sheet.repeats'));

  // A masked calendar (a partner's private one) has no id; the DTO puts the partner's name in its name,
  // which is blank when there is no partner. A blank name never reaches the sheet as an empty line.
  const rawName = item.calendar.name.trim();
  const calendarName =
    rawName === ''
      ? t('sheet.privateCalendar')
      : item.calendar.id === null
        ? t('sheet.partnerCalendar', { name: rawName })
        : item.source === 'google'
          ? t('row.googleCalendar', { calendar: rawName })
          : rawName;
  const location = item.location && item.location.trim() !== '' ? item.location.trim() : null;
  const notes = item.description && item.description.trim() !== '' ? item.description.trim() : null;
  const googleLink = item.source === 'google' && item.htmlLink ? item.htmlLink : null;
  const swatch = item.calendar.color && HEX_COLOUR.test(item.calendar.color) ? item.calendar.color : null;

  return (
    <BottomSheet label={t('sheet.label')} closeLabel={t('actions.close')} onClose={onClose}>
      <div className={`ch-sheet-head${mark === 'done' ? ' is-done' : ''}`}>
        {mark ? <ReminderIcon mark={mark} /> : null}
        <h2 className="ch-sheet-title" dir="auto">
          {title}
          <AnniversaryCount n={item.anniversary} />
        </h2>
        {editing?.canEdit ? (
          <button type="button" className="ch-icon-btn ch-sheet-edit" aria-label={t('sheet.edit')} onClick={editing.onEdit}>
            <PencilIcon />
          </button>
        ) : null}
      </div>
      <When item={item} tz={tz} />
      {tags.length > 0 || whose.person || whose.relation === 'both' ? (
        <p className="ch-sheet-tags">
          {tags.length > 0 ? <span>{tags.join(' · ')}</span> : null}
          <PersonChip whose={whose} />
        </p>
      ) : null}
      {state ? <p className="ch-sheet-state">{state}</p> : null}
      {actions && canAct(item) ? <ReminderActions mark={mark} actions={actions} /> : null}
      {actions?.note ? (
        <p className="ch-sheet-note" role="status">
          {t(`sheet.actionNotes.${actions.note}`, actions.noteValues)}
        </p>
      ) : null}
      {editing?.googleOnly ? <p className="ch-sheet-note">{t('sheet.googleOnly')}</p> : null}
      <dl className="ch-facts">
        <div className="ch-fact">
          <dt>{t('sheet.calendar')}</dt>
          <dd>
            {swatch ? <span className="ch-swatch" style={{ background: swatch }} aria-hidden="true" /> : null}
            <bdi>{calendarName}</bdi>
          </dd>
        </div>
        {location ? (
          <div className="ch-fact">
            <dt>{t('sheet.location')}</dt>
            <dd>
              <bdi>{location}</bdi>
            </dd>
          </div>
        ) : null}
        {notes ? (
          <div className="ch-fact">
            <dt>{t('sheet.notes')}</dt>
            {/* Plain text on purpose: a description is never linkified (a linkifier must allow only http, https, mailto, tel). */}
            <dd className="ch-notes" dir="auto">
              {notes}
            </dd>
          </div>
        ) : null}
      </dl>
      {editing?.canDelete ? (
        <button type="button" className="ch-btn ch-sheet-delete" disabled={actions?.busy} onClick={editing.onDelete}>
          {t(editing.kind === 'reminder' ? 'sheet.deleteReminder' : 'sheet.deleteEvent')}
        </button>
      ) : null}
      {googleLink ? (
        <button type="button" className="ch-btn ch-btn-primary ch-sheet-action" onClick={() => openExternalLink(googleLink)}>
          {t('sheet.openInGoogle')}
        </button>
      ) : null}
    </BottomSheet>
  );
}
