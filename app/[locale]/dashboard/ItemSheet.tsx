'use client';

// An item's details (spec §7.5): a view-only bottom sheet with the title and time range,
// the calendar (masked for a partner's private calendar), the location, the description
// as plain text, whose it is or who set it, and the reminder's state. Google items add
// "Open in Google Calendar" (Telegram's openLink, through D4's openExternalLink).
//
// Telegram's BackButton closes it: the container owns the button (useTelegramBackButton)
// and the selection, so this sheet only renders. In a browser, the Close button, a tap on
// the scrim and Escape do the same.

import { useLocale, useTranslations } from 'next-intl';
import type { AgendaRow } from '@/src/lib/calendar-view/agenda';
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
import { PersonChip, ReminderIcon, useItemTitle } from './ItemRow';

/** A calendar's colour is only an accent (Ruling R7), and only a plain hex one is drawn. */
const HEX_COLOUR = /^#[0-9a-f]{3,8}$/i;

export interface ItemSheetProps {
  row: AgendaRow;
  today: DayKey;
  tz: string;
  onClose: () => void;
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

export function ItemSheet({ row, today, tz, onClose }: ItemSheetProps) {
  const t = useTranslations('calendarHome');
  const { item, whose, mark } = row;
  const title = useItemTitle(item);
  const state = useReminderState(item, mark, today, tz);

  const tags: string[] = [];
  if (item.kind === 'reminder') tags.push(t('row.reminder'));
  if (item.birthday) tags.push(t('row.birthday'));
  if (item.repeatsDaily) tags.push(t('sheet.everyDay'));
  else if (item.recurring) tags.push(t('sheet.repeats'));

  // A masked calendar (a partner's private one) has no id; the DTO puts the partner's name in its name.
  const calendarName =
    item.calendar.id === null
      ? t('sheet.partnerCalendar', { name: item.calendar.name })
      : item.source === 'google'
        ? t('row.googleCalendar', { calendar: item.calendar.name })
        : item.calendar.name;
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
        </h2>
      </div>
      <When item={item} tz={tz} />
      {tags.length > 0 || whose.person ? (
        <p className="ch-sheet-tags">
          {tags.length > 0 ? <span>{tags.join(' · ')}</span> : null}
          <PersonChip whose={whose} />
        </p>
      ) : null}
      {state ? <p className="ch-sheet-state">{state}</p> : null}
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
            <dd className="ch-notes" dir="auto">
              {notes}
            </dd>
          </div>
        ) : null}
      </dl>
      {googleLink ? (
        <button type="button" className="ch-btn ch-btn-primary ch-sheet-action" onClick={() => openExternalLink(googleLink)}>
          {t('sheet.openInGoogle')}
        </button>
      ) : null}
    </BottomSheet>
  );
}
