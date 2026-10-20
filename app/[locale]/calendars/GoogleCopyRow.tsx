'use client';

// The "Copy to Google" row on an own calendar's card, the non-owner line on a partner's, and
// the notes under the list (google-sync spec §1 Where it lives, §5 Copy). Presentational:
// CalendarsClient owns the requests and passes the row's state in. The look is the calendars
// page's own: white card, gray text, the blue-600 accent for the switch and the action, rose
// for what needs the user; lucide icons, hidden from screen readers; 44 px tap targets with
// no hover-only styling; logical properties only, so the row mirrors in Hebrew.

import { useTranslations } from 'next-intl';
import { CalendarSync, Loader2 } from 'lucide-react';
import type { CopyRow, CopyStatus } from '@/src/services/google-sync/view';
import type { UnlinkChoice } from '@/src/services/google-sync/marks';
import { copyAction, type CopyErrorCode } from './google-copy-client';

export interface GoogleCopyRowProps {
  calendarName: string;
  row: CopyRow;
  /** A request in flight for this row: turning on, turning off, or its action. */
  busy: 'on' | 'off' | 'working' | null;
  /** Google's consent was started and waits for the user (the Open Google button). */
  waiting: boolean;
  /** Turning off (or deleting the calendar): the Remove/Keep question replaces the row. */
  asking: boolean;
  error: CopyErrorCode | null;
  onToggle: () => void;
  onAction: () => void;
  onOpenGoogle: () => void;
  onChoose: (choice: UnlinkChoice) => void;
  onCancelAsk: () => void;
}

/** First-strong isolation, so a Hebrew name keeps its place inside a sentence of either direction. */
const isolate = (name: string) => `⁨${name}⁩`;

const LINE_NEEDS_USER = new Set<CopyStatus>(['approve', 'reconnect', 'gone', 'otherAccount', 'error']);
const STATUS_LINE: Partial<Record<CopyStatus, string>> = {
  copied: 'copied', approve: 'approve', reconnect: 'reconnect', plan: 'plan', gone: 'gone', otherAccount: 'otherAccount', error: 'error',
};
const ACTION_LABEL = { consent: 'approve', reconnect: 'reconnect' } as const;

const BUTTON = 'min-h-11 px-4 py-2 rounded-xl font-medium text-sm disabled:opacity-50';

export function GoogleCopyRow(props: GoogleCopyRowProps) {
  const t = useTranslations('googleCopy');
  const { row, busy, waiting, asking, error } = props;

  if (asking) {
    return (
      <div className="mt-3 pt-3 border-t border-gray-100">
        <p className="text-sm text-gray-800 mb-3">{t('unlink.question', { name: isolate(props.calendarName) })}</p>
        <div className="flex flex-wrap gap-2 justify-end">
          <button type="button" onClick={() => props.onChoose('remove')} disabled={busy !== null} className={`${BUTTON} bg-rose-600 text-white`}>
            {t('unlink.remove')}
          </button>
          <button type="button" onClick={() => props.onChoose('keep')} disabled={busy !== null} className={`${BUTTON} bg-blue-600 text-white`}>
            {t('unlink.keep')}
          </button>
          <button type="button" onClick={props.onCancelAsk} disabled={busy !== null} className={`${BUTTON} bg-gray-100 text-gray-700`}>
            {t('unlink.cancel')}
          </button>
        </div>
      </div>
    );
  }

  const action = copyAction(row.status);
  const actionLabel = action === 'recreate' ? (row.status === 'gone' ? t('actions.recreate') : t('actions.copyAgain')) : action ? t(`actions.${ACTION_LABEL[action]}`) : null;

  let line: string | null = null;
  if (row.status === 'copying') line = row.total > 0 ? t('status.copyingCount', { copied: row.copied, total: row.total }) : t('status.copying');
  else if (STATUS_LINE[row.status]) line = t(`status.${STATUS_LINE[row.status]}`);

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-center gap-3">
        <CalendarSync size={18} className="text-gray-500 shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-800">{t('title')}</p>
          {busy ? (
            <p className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5">
              <Loader2 size={12} className="animate-spin shrink-0" aria-hidden="true" /> {t(`busy.${busy}`)}
            </p>
          ) : (
            <>
              {waiting ? (
                <p className="text-xs text-gray-600 mt-0.5">{t('status.waiting')}</p>
              ) : line ? (
                <p className={`text-xs mt-0.5 ${LINE_NEEDS_USER.has(row.status) ? 'text-rose-700' : 'text-gray-500'}`}>{line}</p>
              ) : null}
              {row.unsupported > 0 && row.on && (
                <p className="text-xs text-gray-500 mt-0.5">{t('status.unsupported', { count: row.unsupported })}</p>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={row.on}
          aria-label={t('switchLabel', { name: props.calendarName })}
          aria-busy={busy !== null}
          disabled={busy !== null}
          onClick={props.onToggle}
          className="min-h-11 min-w-11 flex items-center justify-center shrink-0 disabled:opacity-50"
        >
          <span className={`w-11 h-6 rounded-full p-0.5 flex items-center transition-colors ${row.on ? 'bg-blue-600 justify-end' : 'bg-gray-300 justify-start'}`}>
            <span className="w-5 h-5 rounded-full bg-white shadow" />
          </span>
        </button>
      </div>
      {!busy && (waiting || actionLabel) && (
        <div className="flex justify-end mt-2">
          <button
            type="button"
            onClick={waiting ? props.onOpenGoogle : props.onAction}
            className={`${BUTTON} bg-blue-600 text-white`}
          >
            {waiting ? t('actions.openGoogle') : actionLabel}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-rose-700 mt-2">{t(`errors.${error}`)}</p>
      )}
    </div>
  );
}

/** On a partner's calendar: only its owner can copy it (spec §1, Not copied). */
export function NonOwnerCopyLine({ owner }: { owner: string }) {
  const t = useTranslations('googleCopy');
  return (
    <p className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500 flex items-center gap-1.5">
      <CalendarSync size={14} className="shrink-0" aria-hidden="true" /> {t('nonOwner', { owner })}
    </p>
  );
}

/** Once under the own calendars: one way, alerts from FamCal, Hebrew dates as dates (spec §1). */
export function GoogleCopyNotes() {
  const t = useTranslations('googleCopy');
  return (
    <div className="text-xs text-gray-500 space-y-1 px-1">
      <p>{t('notes.oneWay')}</p>
      <p>{t('notes.alerts')}</p>
      <p>{t('notes.hebrew')}</p>
    </div>
  );
}
