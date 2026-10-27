'use client';

// "Send to chat" (spec §7.2, Ruling R5, the approved SendSheet mockup): a bottom sheet
// with Today's summary, Tomorrow's summary, This week, Next week and Weather. A tap asks
// the bot to post it in the user's chat (D4's sendToChat), one send at a time:
// - Telegram, 2xx: the app closes, so the spinner stays until it does;
// - a 2xx where the page stays: "Sent to WhatsApp" in a browser, or "Sent. Check your
//   chat" when Telegram couldn't close the app;
// - 429: try again in a minute; 401/403: reopen from the chat; no answer: no connection;
//   anything else: couldn't send. The sheet stays open and says so.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDateSpan } from '@/src/lib/calendar-view/format';
import { sendWeekRanges } from '@/src/lib/calendar-view/send-weeks';
import type { DayKey, WeekStart } from '@/src/lib/calendar-view/types';
import { SEND_ITEMS, sendToChat, type SendItem, type SendResult } from '@/src/lib/command-client';
import { BottomSheet } from '@/components/app-ui/BottomSheet';

export interface SendSheetProps {
  /** The page's own user_id, as CalendarHomeProps carries it (never swapped). */
  userId: number;
  locale: string;
  /** The home's pinned today and week start; null before the first answer: no dates. */
  today?: DayKey | null;
  weekStart?: WeekStart | null;
  /** The always-7-days setting; absent means unknown: This week shows no dates. */
  lookahead7?: boolean;
  onClose: () => void;
}

/** Each item's copy, under calendarHome.send. */
const COPY: Record<SendItem, { title: string; hint: string }> = {
  today: { title: 'send.today', hint: 'send.todayHint' },
  tomorrow: { title: 'send.tomorrow', hint: 'send.tomorrowHint' },
  thisWeek: { title: 'send.thisWeek', hint: 'send.thisWeekHint' },
  nextWeek: { title: 'send.nextWeek', hint: 'send.nextWeekHint' },
  weather: { title: 'send.weather', hint: 'send.weatherHint' },
};

/** The line the sheet shows for an answer, or null while the app is closing. */
export function sendResultKey(result: SendResult): { key: string; problem: boolean } | null {
  switch (result.outcome) {
    case 'closing':
      return null;
    case 'sent':
      return { key: result.chat === 'whatsapp' ? 'send.sentWhatsApp' : 'send.sent', problem: false };
    case 'busy':
      return { key: 'send.busy', problem: true };
    case 'failed':
      if (result.status === null) return { key: 'send.offline', problem: true };
      if (result.status === 401 || result.status === 403) return { key: 'send.signedOut', problem: true };
      return { key: 'send.failed', problem: true };
  }
}

function ItemIcon({ item }: { item: SendItem }) {
  if (item === 'weather') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="ch-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M12 3a9 9 0 1 1-9 9" />
    </svg>
  );
}

export function SendSheet({ userId, locale, today, weekStart, lookahead7, onClose }: SendSheetProps) {
  const t = useTranslations('calendarHome');
  // The bot's week bounds (week-lookahead.ts), as a short range after the title.
  const weeks = today && weekStart !== null && weekStart !== undefined ? sendWeekRanges(today, weekStart, lookahead7) : null;
  const spanOf = (item: SendItem): string => {
    const span = item === 'thisWeek' ? weeks?.thisWeek : item === 'nextWeek' ? weeks?.nextWeek : null;
    return span ? formatDateSpan(span.first, span.last, locale) : '';
  };
  const [sending, setSending] = useState<SendItem | null>(null);
  const [result, setResult] = useState<{ key: string; problem: boolean } | null>(null);

  const send = async (item: SendItem) => {
    // One send at a time: the other options are aria-disabled meanwhile (they keep focus).
    if (sending) return;
    setSending(item);
    setResult(null);
    const answer = await sendToChat(userId, item, locale);
    const line = sendResultKey(answer);
    // Closing: keep the spinner; the app is going away.
    if (line === null) return;
    setSending(null);
    setResult(line);
  };

  return (
    <BottomSheet label={t('send.title')} closeLabel={t('actions.close')} onClose={onClose}>
      <h2 className="ch-sheet-heading">{t('send.title')}</h2>
      <p className="ch-sheet-sub">{t('send.subtitle')}</p>
      <ul className="ch-options" role="list">
        {SEND_ITEMS.map((item) => {
          const busy = sending === item;
          return (
            <li key={item} className="ch-option-li">
              <button
                type="button"
                className="ch-option ch-tap"
                data-send={item}
                aria-disabled={sending !== null && !busy ? true : undefined}
                aria-busy={busy || undefined}
                onClick={() => void send(item)}
              >
                <span className="ch-option-icon">{busy ? <Spinner /> : <ItemIcon item={item} />}</span>
                <span className="ch-option-text">
                  <span className="ch-option-title">
                    {t(COPY[item].title)}
                    {spanOf(item) ? (
                      <>
                        {' · '}
                        <bdi>{spanOf(item)}</bdi>
                      </>
                    ) : null}
                  </span>
                  <span className="ch-option-hint">{busy ? t('send.sending') : t(COPY[item].hint)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className={result ? `ch-send-result${result.problem ? ' is-problem' : ''}` : 'ch-visually-hidden'} role="status">
        {result ? t(result.key) : ''}
      </p>
    </BottomSheet>
  );
}
