'use client';

// The "Still open" card (spec §7.3): today's past-due reminders and the carry-overs, as
// buildAgenda orders them. It shows 5, then "N more", which opens the rest in place. Each
// row says since when it is open, and who set it when that wasn't the viewer ("From
// Noa"), or whom the viewer set it for ("For Noa"). A tap opens the item sheet.

import { useEffect, useRef, useState, type Ref } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { AgendaRow, StillOpenCard as StillOpenModel, StillOpenRow } from '@/src/lib/calendar-view/agenda';
import type { DayKey } from '@/src/lib/calendar-view/types';
import { daysBetween, formatDayMonth, formatTime, weekdayOf } from '@/src/lib/calendar-view/format';
import { CalendarStripe, PersonChip, ReminderIcon, useItemTitle } from './ItemRow';

export interface StillOpenCardProps {
  card: StillOpenModel;
  today: DayKey;
  tz: string;
  onOpen: (row: AgendaRow) => void;
}

/** "Since 13:00" (today's), "Since yesterday", "Since Tuesday" (2–6 days), "Since 6 Oct" (older). */
function useSinceText(row: StillOpenRow, today: DayKey, tz: string): string {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  if (!row.carriedOver) {
    return row.item.allDay ? t('agenda.today') : t('stillOpen.sinceTime', { time: formatTime(row.item.start, tz, locale) });
  }
  const ago = daysBetween(row.since, today);
  if (ago === 1) return t('stillOpen.sinceYesterday');
  const weekday = weekdayOf(row.since);
  if (ago >= 2 && ago <= 6 && weekday) return t('stillOpen.sinceWeekday', { weekday });
  return t('stillOpen.sinceDate', { date: formatDayMonth(row.since, locale) });
}

function OpenRow({ row, today, tz, onOpen, buttonRef }: { row: StillOpenRow; buttonRef?: Ref<HTMLButtonElement> } & Omit<StillOpenCardProps, 'card'>) {
  const title = useItemTitle(row.item);
  const since = useSinceText(row, today, tz);
  const mark = row.mark ?? 'open';
  return (
    <li className="ch-row-li">
      <button ref={buttonRef} type="button" className="ch-row ch-tap ch-row-open" onClick={() => onOpen(row)}>
        <CalendarStripe color={row.item.calendar.color} mine={row.whose.mine} />
        <span className="ch-body">
          <span className="ch-title-line">
            <ReminderIcon mark={mark} />
            <span className="ch-title" dir="auto">
              {title}
            </span>
          </span>
          <span className="ch-meta ch-indent">
            <span className="ch-meta-text">{since}</span>
            <PersonChip whose={row.whose} />
          </span>
        </span>
      </button>
    </li>
  );
}

export function StillOpenCard({ card, today, tz, onOpen }: StillOpenCardProps) {
  const t = useTranslations('calendarHome');
  const [expanded, setExpanded] = useState(false);
  // "N more" goes away when it is pressed; focus moves to the first row it revealed
  const firstRevealed = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (expanded) firstRevealed.current?.focus({ preventScroll: true });
  }, [expanded]);
  const rows = expanded ? [...card.shown, ...card.more] : card.shown;
  const total = card.shown.length + card.more.length;
  return (
    <section className="ch-card" aria-labelledby="ch-still-open">
      <div className="ch-card-head">
        <h2 id="ch-still-open" className="ch-card-title">
          {t('stillOpen.title')}
        </h2>
        <span className="ch-card-count">{t('stillOpen.count', { count: total })}</span>
      </div>
      <ul className="ch-list" role="list">
        {rows.map((row, i) => (
          <OpenRow key={row.item.key} row={row} today={today} tz={tz} onOpen={onOpen} buttonRef={i === card.shown.length ? firstRevealed : undefined} />
        ))}
      </ul>
      {!expanded && card.more.length > 0 ? (
        <button type="button" className="ch-btn ch-card-more" aria-expanded="false" onClick={() => setExpanded(true)}>
          {t('stillOpen.more', { count: card.more.length })}
        </button>
      ) : null}
    </section>
  );
}
