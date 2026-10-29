'use client';

// The "Copy to Google" row of an own calendar, the non-owner line under a partner's calendars, and the notes under the
// list (google-sync spec §1 Where it lives, §5 Copy). Presentational: CalendarsClient owns the requests and passes the
// row's state in. Drawn with the app's form kit (components/app-ui/form-kit.tsx: ch-form-row, ch-switch, ch-form-hint,
// FieldError), so it follows the tokens, the device's scheme and the page's direction, and every tap is a kit row.
//
// - A row is the calendar's name with a switch; under the name it says what the copy is doing: the busy line (with a
//   spinner), the wait for Google's consent, or the status; a status that needs the person is in the danger colour. A
//   second line counts the events that can't be copied. When the state has one action (Approve in Google, Reconnect
//   Google, Create it again, Copy again; Open Google while a consent waits) it is a row of its own under the switch row.
//   An error from the last request sits under both.
// - The Remove / Keep question is not part of the row: the page asks it in a sheet (turning a copy off, and deleting a
//   calendar whose copy is on), so `unlink` words are the page's.

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarSync } from 'lucide-react';
import { FieldError } from '@/components/app-ui/form-kit';
import type { CopyRow, CopyStatus } from '@/src/services/google-sync/view';
import { copyAction, type CopyErrorCode } from './google-copy-client';

export interface GoogleCopyRowProps {
  calendarName: string;
  row: CopyRow;
  /** A request in flight for this row: turning on, turning off, or its action. */
  busy: 'on' | 'off' | 'working' | null;
  /** Google's consent was started and waits for the user (the Open Google row). */
  waiting: boolean;
  /** Another request of the page is running: this row waits (its own busy line is `busy`). */
  locked?: boolean;
  error: CopyErrorCode | null;
  onToggle: () => void;
  onAction: () => void;
  onOpenGoogle: () => void;
}

/** First-strong isolation, so a Hebrew name keeps its place inside a sentence of either direction. */
export const isolate = (name: string) => `⁨${name}⁩`;

const LINE_NEEDS_USER = new Set<CopyStatus>(['approve', 'reconnect', 'gone', 'otherAccount', 'error']);
const STATUS_LINE: Partial<Record<CopyStatus, string>> = {
  copied: 'copied', approve: 'approve', reconnect: 'reconnect', plan: 'plan', gone: 'gone', otherAccount: 'otherAccount', error: 'error',
};
const ACTION_LABEL = { consent: 'approve', reconnect: 'reconnect' } as const;

export function GoogleCopyRow(props: GoogleCopyRowProps) {
  const t = useTranslations('googleCopy');
  const errorId = useId();
  const { row, busy, waiting, locked, error } = props;

  const action = copyAction(row.status);
  const actionLabel = action === 'recreate' ? (row.status === 'gone' ? t('actions.recreate') : t('actions.copyAgain')) : action ? t(`actions.${ACTION_LABEL[action]}`) : null;

  let line: string | null = null;
  if (row.status === 'copying') line = row.total > 0 ? t('status.copyingCount', { copied: row.copied, total: row.total }) : t('status.copying');
  else if (STATUS_LINE[row.status]) line = t(`status.${STATUS_LINE[row.status]}`);

  return (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={row.on}
        aria-label={t('switchLabel', { name: props.calendarName })}
        aria-busy={busy !== null || undefined}
        disabled={busy !== null || locked}
        className="ch-form-row"
        onClick={props.onToggle}
      >
        <span className="ch-form-label">
          <bdi dir="auto">{props.calendarName}</bdi>
          {busy ? (
            <span className="ch-form-hint ch-working">
              <span className="ch-form-spinner" aria-hidden="true" />
              {t(`busy.${busy}`)}
            </span>
          ) : (
            <>
              {waiting ? (
                <span className="ch-form-hint">{t('status.waiting')}</span>
              ) : line ? (
                <span className={LINE_NEEDS_USER.has(row.status) ? 'ch-form-hint is-danger' : 'ch-form-hint'}>{line}</span>
              ) : null}
              {row.unsupported > 0 && row.on ? <span className="ch-form-hint">{t('status.unsupported', { count: row.unsupported })}</span> : null}
            </>
          )}
        </span>
        <span className={row.on ? 'ch-switch is-on' : 'ch-switch'} aria-hidden="true" />
      </button>
      {!busy && (waiting || actionLabel) ? (
        <button type="button" className="ch-form-row ch-action-row" disabled={locked} onClick={waiting ? props.onOpenGoogle : props.onAction}>
          {waiting ? t('actions.openGoogle') : actionLabel}
        </button>
      ) : null}
      {error ? <FieldError id={errorId} error={t(`errors.${error}`)} /> : null}
    </div>
  );
}

/** On a partner's calendars: only their owner can copy them (spec §1, Not copied). */
export function NonOwnerCopyLine({ owner }: { owner: string }) {
  const t = useTranslations('googleCopy');
  return (
    <p className="ch-form-fixed ch-working">
      <CalendarSync size={14} aria-hidden="true" />
      {t('nonOwner', { owner })}
    </p>
  );
}

/** Once under the own calendars' copy rows: one way, alerts from FamCal, Hebrew dates as dates (spec §1). */
export function GoogleCopyNotes() {
  const t = useTranslations('googleCopy');
  return (
    <div className="ch-form-group">
      <p className="ch-form-fixed">{t('notes.oneWay')}</p>
      <p className="ch-form-fixed">{t('notes.alerts')}</p>
      <p className="ch-form-fixed">{t('notes.hebrew')}</p>
    </div>
  );
}
