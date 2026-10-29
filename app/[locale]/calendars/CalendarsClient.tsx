'use client';

// The Calendars screen, in the home's design (spec 2026-10-19 §4, §5; plan W4-1): an AppScreen on the grouped ground, a
// header with its back, and four sections of cards, all drawn with the form kit (components/app-ui).
//
// - Your calendars: one list row per own calendar (a dot in the colour it is drawn in, the name, who sees it, its
//   categories as tags) and a "New calendar" row. A tap on a calendar opens its sheet; the row opens the create sheet.
// - Copy to Google (google-sync spec §1): once /api/google-sync says the copies apply (Google connected, or a copy on),
//   a switch row per own calendar (GoogleCopyRow) and the notes. The rows refresh while a copy is being made or a consent
//   waits, and when the page comes back to the foreground. Turning a copy off asks Remove or Keep in a sheet.
// - The partner's calendars (only when there are any): read-only rows; only their owner can copy them.
// - Google Calendar: one row that leads to where the person is with Google (choose calendars, connect, reconnect).
//
// The edit sheet holds the name, colour, categories and who sees the calendar; Delete turns the same sheet into its confirm
// step (named for the calendar), which, when the calendar's Google copy is on, asks about the copy and answers with two
// buttons that say both halves (delete here and in Google, delete here and keep it in Google). No browser pop-up.
//
// - One request at a time (the Partner screen's pattern): the one that runs shows a spinner and the other actions are off.
//   Every failure is said in the page's language, in the sheet whose request it was (a sheet covers the page), and logged.
//   A refused save, create or delete keeps its sheet open with what the person entered.
// - Back has one owner, AppScreen (Telegram's BackButton, and the header's own back in a browser). It closes the sheet that
//   is open (a confirm step goes back to the edit step), does nothing while a request runs, else returns to the calendar.
// - The requests are /api/native-calendars (POST, PATCH, DELETE) and /api/google-sync, as they have always been.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { initDataHeaders, readInitData } from '@/src/lib/read-init-data';
import { CALENDAR_PALETTE, displayColours } from '@/src/lib/calendar-colours';
import type { GoogleState } from '@/src/lib/google-state';
import { openExternalLink, useTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { Chevron, ColorSwatches, FORM_CSS, FieldError, FormCard, RadioCard, SaveBar, SwitchRow, TextField } from '@/components/app-ui/form-kit';
import { ListRow } from '@/components/app-ui/ListRow';
import { Notice } from '@/components/app-ui/Notice';
import { ScreenHeader, SectionLabel } from '@/components/app-ui/ScreenHeader';
import { Tag } from '@/components/app-ui/Tag';
import type { CopiesView, CopyRow } from '@/src/services/google-sync/view';
import type { UnlinkChoice } from '@/src/services/google-sync/marks';
import { GoogleCopyNotes, GoogleCopyRow, NonOwnerCopyLine, isolate } from './GoogleCopyRow';
import {
  consentWait, copyAction, deleteCalendarBody, loadCopies, needsPolling, recreateCopy, startCopy, stopCopy, waitExpired, waitHolds,
  type ConsentWait, type CopyErrorCode,
} from './google-copy-client';

/** How often the copy rows are asked again while a copy is being made or a consent waits. */
const COPY_POLL_MS = 10_000;

interface Calendar {
  rawId: string;
  name: string;
  color: string;
  labels: string[];
  privacy: 'PRIVATE' | 'SHARED_VIEWER' | 'SHARED_EDITOR';
  ownerUserId: number;
  isOwner: boolean;
  personName?: string | null;
  personEnglishName?: string | null;
  personGender?: string | null;
  rules: string[];
  createdAt: string;
}

interface Props {
  userId: number;
  locale: string;
  initialCalendars: Calendar[];
  /** The user's chosen Google calendars with their colours as Google's app shows them: on screen beside the FamCal ones. */
  googleColors: string[];
  /** Where the person is with Google and how many calendars they chose: the Google section's one row follows it. */
  google: { state: GoogleState; chosen: number };
  /** The active partner's name, for the heading of the calendars they share; null when not paired. */
  partnerName: string | null;
}

const VALID_LABELS = ['primary', 'yours', 'spouse', 'kids', 'birthdays'] as const;
const PRIVACIES: Calendar['privacy'][] = ['PRIVATE', 'SHARED_VIEWER', 'SHARED_EDITOR'];
const PRIVACY_KEY: Record<Calendar['privacy'], string> = { PRIVATE: 'privacyPrivate', SHARED_VIEWER: 'privacyViewer', SHARED_EDITOR: 'privacyEditor' };

function getInitData(): string {
  return readInitData();
}

/** What the person is changing in the edit sheet. */
interface Draft {
  name: string;
  color: string;
  labels: string[];
  privacy: Calendar['privacy'];
}

/**
 * The sheet that is open. Edit and delete hold the calendar as it was when the sheet opened: a calendar that was deleted
 * elsewhere (and so leaves the list) does not take its sheet, and the error it caused, away.
 */
type Sheet =
  | { kind: 'create' }
  | { kind: 'edit'; calendar: Calendar }
  | { kind: 'delete'; calendar: Calendar }
  | { kind: 'copyOff'; calendar: Calendar };

/** The one request that runs. The delete and turn-off kinds say which button was pressed. */
type Busy = 'create' | 'save' | 'load' | 'copy' | 'delete-plain' | 'delete-remove' | 'delete-keep' | 'off-remove' | 'off-keep';

type Action = 'save' | 'create' | 'delete';
type Failure = 'notFound' | 'tooMany' | 'reopen' | 'limit' | 'onlyOne' | 'generic';
interface SheetError {
  action: Action;
  failure: Failure;
}

/** What a refused write means: by the server's code first, then by its status. A 401 or 403 is a session that ended. */
function failureOf(action: Action, status: number, code: unknown): Failure {
  if (action === 'create' && code === 'calendar_limit_reached') return 'limit';
  if (action === 'delete' && code === 'cannot_delete_last') return 'onlyOne';
  if (action !== 'create' && (status === 404 || code === 'not_found')) return 'notFound';
  if (status === 429) return 'tooMany';
  if (status === 401 || status === 403) return 'reopen';
  return 'generic';
}

const HEX = /^#[0-9a-f]{3,8}$/i;

/** A private-use character that stands for the name while a message is formatted. */
const NAME_MARK = '\uE000';

/** A message that has {name} in it, with the name in a <bdi>: it keeps its own direction inside a sentence of either. */
function sentenceWithName(message: (name: string) => string, name: string): ReactNode {
  const [before, after] = message(NAME_MARK).split(NAME_MARK);
  return (
    <>
      {before}
      <bdi dir="auto">{name}</bdi>
      {after}
    </>
  );
}

/** The dot of a calendar's colour, in a list row's title or beside a partner's calendar. */
function Dot({ colour }: { colour: string }) {
  return <span className="ch-swatch-dot is-lg" style={HEX.test(colour) ? { background: colour } : undefined} aria-hidden="true" />;
}

function Spinner() {
  return <span className="ch-form-spinner" aria-hidden="true" />;
}

export default function CalendarsClient(props: Props) {
  const { userId, locale, initialCalendars, googleColors, google, partnerName } = props;
  const t = useTranslations('calendarsPage');
  const tc = useTranslations('googleCopy');
  const categories = useTranslations('calendars.categories');
  const sharedAccess = useTranslations('calendarsPage.sharedAccess');
  const ui = useTranslations('ui');
  const router = useRouter();
  const deleteErrorId = useId();

  const [calendars, setCalendars] = useState<Calendar[]>(initialCalendars);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: '', color: '', labels: [], privacy: 'PRIVATE' });
  const [newName, setNewName] = useState('');
  const [sheetError, setSheetError] = useState<SheetError | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  /** The same as `busy`, readable in the handler that runs right after another (two taps in one frame). */
  const running = useRef(false);
  // A swipe down in a sheet must not minimize the app.
  useTelegramVerticalSwipes(sheet !== null);

  // The colours as drawn on every screen (displayColours): a FamCal calendar too close to
  // another is shifted here too. The saved colour, and the picker below, stay as saved.
  const drawn = displayColours([
    ...calendars.map((c) => ({ id: c.rawId, color: c.color, native: true })),
    ...googleColors.map((color, i) => ({ id: `google:${i}`, color, native: false })),
  ]);

  const owned = calendars.filter((c) => c.isOwner);
  const shared = calendars.filter((c) => !c.isOwner);

  /** One request at a time: `kind` is busy while `work` runs; a throw is logged and `fail` tells the person. */
  const run = async (kind: Busy, work: () => Promise<void>, fail: (error: unknown) => void) => {
    if (running.current) return;
    running.current = true;
    setBusy(kind);
    try {
      await work();
    } catch (error) {
      console.error(`[calendars] ${kind} failed:`, error);
      fail(error);
    } finally {
      running.current = false;
      setBusy(null);
    }
  };

  // ---- Copy to Google ----
  const [copies, setCopies] = useState<CopiesView | null>(null);
  const [copyLoadFailed, setCopyLoadFailed] = useState(false);
  const [copyBusy, setCopyBusy] = useState<Record<string, 'on' | 'off' | 'working'>>({});
  /** Calendars whose consent was started and can still be used: Google's URL, opened by the row's Open Google tap. */
  const [waiting, setWaiting] = useState<Record<string, ConsentWait>>({});
  const [copyErrors, setCopyErrors] = useState<Record<string, CopyErrorCode>>({});
  const loading = useRef(false);
  /** A refresh asked while one was in flight: that one may have read the rows before a change, so one more runs after it. */
  const refreshAgain = useRef(false);
  // Each copy-rows GET's number, in the order sent: a consent wait keeps the last one asked when it began.
  const asks = useRef(0);

  const copyOf = (calendarId: string): CopyRow | undefined => copies?.rows.find((r) => r.calendarId === calendarId);
  const setBusyFor = (calendarId: string, value: 'on' | 'off' | 'working' | null) =>
    setCopyBusy((b) => {
      const next = { ...b };
      if (value) next[calendarId] = value;
      else delete next[calendarId];
      return next;
    });
  const setErrorFor = (calendarId: string, code: CopyErrorCode | null) =>
    setCopyErrors((e) => {
      const next = { ...e };
      if (code) next[calendarId] = code;
      else delete next[calendarId];
      return next;
    });

  const refreshCopies = useCallback(async (): Promise<void> => {
    if (loading.current) {
      refreshAgain.current = true;
      return;
    }
    loading.current = true;
    try {
      do {
        refreshAgain.current = false;
        try {
          const ask = ++asks.current;
          const view = await loadCopies(userId);
          setCopies(view);
          setCopyLoadFailed(false);
          // A wait ends once its consent can't be used (landed, used, expired): the row shows its own action again.
          const now = Date.now();
          setWaiting((w) => Object.fromEntries(Object.entries(w).filter(([id, wait]) => waitHolds(wait, view.rows.find((r) => r.calendarId === id), ask, now))));
        } catch (err) {
          console.error('[calendars] loading the Google copies failed:', err);
          setCopyLoadFailed(true);
        }
      } while (refreshAgain.current);
    } finally {
      loading.current = false;
    }
  }, [userId]);

  useEffect(() => {
    void refreshCopies();
    // Back from Google's consent or the bot's link: the copy may be on now.
    const onVisible = () => { if (!document.hidden) void refreshCopies(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshCopies]);

  const polling = needsPolling(copies?.rows ?? [], Object.keys(waiting).length);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => { void refreshCopies(); }, COPY_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, refreshCopies]);

  /** Turn a copy on, or start Google's consent when the permission is missing. */
  const turnOn = (calendarId: string, busyAs: 'on' | 'working') =>
    run(
      'copy',
      async () => {
        setBusyFor(calendarId, busyAs);
        setErrorFor(calendarId, null);
        try {
          const result = await startCopy(userId, calendarId);
          if (result.kind === 'consent') {
            const wait = consentWait(result.oauthUrl, copyOf(calendarId), Date.now(), asks.current);
            setWaiting((w) => ({ ...w, [calendarId]: wait }));
          } else if (result.kind === 'error') setErrorFor(calendarId, result.code);
          else await refreshCopies();
        } finally {
          setBusyFor(calendarId, null);
        }
      },
      () => setErrorFor(calendarId, 'failed'),
    );

  const copyActionFor = (row: CopyRow) => {
    const action = copyAction(row.status);
    if (action === 'consent') return turnOn(row.calendarId, 'working');
    if (action === 'reconnect') {
      // /refresh-token gives Google's token back; it can't grant calendar.app.created (that is 'approve').
      window.location.assign(`/refresh-token?user_id=${userId}`);
      return;
    }
    if (action === 'recreate' && row.linkId) {
      const linkId = row.linkId;
      return run(
        'copy',
        async () => {
          setBusyFor(row.calendarId, 'working');
          setErrorFor(row.calendarId, null);
          try {
            const result = await recreateCopy(userId, linkId);
            if (result.kind === 'error') setErrorFor(row.calendarId, result.code);
            else await refreshCopies();
          } finally {
            setBusyFor(row.calendarId, null);
          }
        },
        () => setErrorFor(row.calendarId, 'failed'),
      );
    }
  };

  const openGoogle = (calendarId: string) => {
    const wait = waiting[calendarId];
    if (wait && waitExpired(wait, Date.now())) {
      // Its URL would only lead to "expired": the row offers its own action again.
      setWaiting((w) => Object.fromEntries(Object.entries(w).filter(([id]) => id !== calendarId)));
      return;
    }
    if (!wait || !openExternalLink(wait.url)) setErrorFor(calendarId, 'openFailed');
  };

  /** The answer to "Delete the calendar … from Google too?" for a copy being turned off: the sheet closes whatever the answer. */
  const turnOff = (c: Calendar, choice: UnlinkChoice) =>
    run(
      choice === 'remove' ? 'off-remove' : 'off-keep',
      async () => {
        setBusyFor(c.rawId, 'off');
        setErrorFor(c.rawId, null);
        try {
          const result = await stopCopy(userId, c.rawId, choice);
          if (result.kind === 'error') setErrorFor(c.rawId, result.code);
          else await refreshCopies();
        } finally {
          setBusyFor(c.rawId, null);
          setSheet(null);
        }
      },
      () => setErrorFor(c.rawId, 'failed'),
    );

  const copyRowFor = (c: Calendar): ReactNode => {
    const row = copyOf(c.rawId);
    if (!copies?.shown || !row) return null;
    return (
      <GoogleCopyRow
        key={c.rawId}
        calendarName={c.name}
        row={row}
        busy={copyBusy[c.rawId] ?? null}
        waiting={Boolean(waiting[c.rawId])}
        locked={busy !== null}
        error={copyErrors[c.rawId] ?? null}
        onToggle={() => {
          if (running.current) return;
          if (row.on) setSheet({ kind: 'copyOff', calendar: c });
          else void turnOn(c.rawId, 'on');
        }}
        onAction={() => void copyActionFor(row)}
        onOpenGoogle={() => openGoogle(c.rawId)}
      />
    );
  };

  // ---- The calendars ----

  /** The list as the server has it. False when it could not be asked: the page then keeps what it shows. */
  const reload = async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/native-calendars?user_id=${userId}`, { headers: initDataHeaders() });
      if (!res.ok) {
        console.error('[calendars] reloading the list answered', res.status);
        return false;
      }
      const data = await res.json();
      if (!Array.isArray(data?.calendars)) {
        console.error('[calendars] reloading the list answered with no calendars');
        return false;
      }
      setCalendars(data.calendars);
      return true;
    } catch (error) {
      console.error('[calendars] reloading the list failed:', error);
      return false;
    }
  };

  /** A write to the calendars API: whether it went through (with the body it answered) or why not. A refusal is logged. */
  const write = async (action: Action, method: 'POST' | 'PATCH' | 'DELETE', path: string, payload: Record<string, unknown>): Promise<{ failure: Failure | null; data: Record<string, unknown> | null }> => {
    const res = await fetch(`${path}?user_id=${userId}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { failure: null, data };
    const code = data?.error;
    console.error(`[calendars] ${action} refused: ${res.status} ${typeof code === 'string' ? code : ''}`.trim());
    return { failure: failureOf(action, res.status, code), data };
  };

  const closeSheet = () => {
    if (running.current) return;
    setSheet(null);
    setSheetError(null);
  };

  const openEdit = (c: Calendar) => {
    if (running.current) return;
    setDraft({ name: c.name, color: c.color, labels: c.labels, privacy: c.privacy });
    setSheetError(null);
    setSheet({ kind: 'edit', calendar: c });
  };

  const openCreate = () => {
    if (running.current) return;
    setNewName('');
    setSheetError(null);
    setSheet({ kind: 'create' });
  };

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    return run(
      'create',
      async () => {
        setSheetError(null);
        const { failure, data } = await write('create', 'POST', '/api/native-calendars', { name, initData: getInitData() });
        if (failure) {
          setSheetError({ action: 'create', failure });
          return;
        }
        setSheet(null);
        if (!(await reload())) {
          // The calendar exists; the list could not be asked, so the page adds what the server answered with
          const made = data?.calendar as Partial<Calendar> | undefined;
          if (made?.rawId) {
            setCalendars((list) => [...list, {
              rawId: made.rawId as string, name: made.name ?? name, color: made.color ?? '', labels: made.labels ?? [], privacy: made.privacy ?? 'PRIVATE',
              ownerUserId: list.find((c) => c.isOwner)?.ownerUserId ?? 0, isOwner: true, rules: [], createdAt: new Date().toISOString(),
            }]);
          }
        }
      },
      () => setSheetError({ action: 'create', failure: 'generic' }),
    );
  };

  const save = () => {
    if (sheet?.kind !== 'edit' || !draft.name.trim()) return;
    const c = sheet.calendar;
    const changes = { name: draft.name.trim(), color: draft.color, labels: draft.labels, privacy: draft.privacy };
    return run(
      'save',
      async () => {
        setSheetError(null);
        const { failure } = await write('save', 'PATCH', `/api/native-calendars/${c.rawId}`, { ...changes, initData: getInitData() });
        if (failure) {
          setSheetError({ action: 'save', failure });
          // Deleted somewhere else: the list is asked again, the sheet keeps what the person entered
          if (failure === 'notFound') await reload();
          return;
        }
        setCalendars((list) => list.map((x) => (x.rawId === c.rawId ? { ...x, ...changes } : x)));
        setSheet(null);
        // Another calendar may have lost its primary label to this one: the server's list is the truth
        await reload();
      },
      () => setSheetError({ action: 'save', failure: 'generic' }),
    );
  };

  /** Delete asks what happens to a Google copy first: the copy rows are loaded when they are not yet, and the confirm step follows. */
  const startDelete = (c: Calendar) => {
    if (running.current) return;
    setSheetError(null);
    // A delete never goes without googleCopy (the server's Keep) unless a loaded view says the copy is off
    if (copies && !copyLoadFailed) {
      setSheet({ kind: 'delete', calendar: c });
      return;
    }
    return run(
      'load',
      async () => {
        try {
          const view = await loadCopies(userId);
          setCopies(view);
          setCopyLoadFailed(false);
        } catch (err) {
          console.error('[calendars] loading the Google copies before a delete failed:', err);
          setCopyLoadFailed(true);
          setSheetError({ action: 'delete', failure: 'generic' });
          return;
        }
        setSheet({ kind: 'delete', calendar: c });
      },
      () => setSheetError({ action: 'delete', failure: 'generic' }),
    );
  };

  // A calendar whose copy is on asks what happens to its Google calendar (spec §1) before
  // the delete; googleCopy goes in the body only then.
  const deleteCalendar = (c: Calendar, choice: UnlinkChoice | null) =>
    run(
      choice ? (choice === 'remove' ? 'delete-remove' : 'delete-keep') : 'delete-plain',
      async () => {
        setSheetError(null);
        const { failure } = await write('delete', 'DELETE', `/api/native-calendars/${c.rawId}`, deleteCalendarBody(choice, getInitData()));
        if (failure) {
          setSheetError({ action: 'delete', failure });
          if (failure === 'notFound') await reload();
          return;
        }
        // Gone from the list at once; the server's list follows (and is the truth if it differs)
        setCalendars((list) => list.filter((x) => x.rawId !== c.rawId));
        setSheet(null);
        await reload();
        if (choice) await refreshCopies();
      },
      () => setSheetError({ action: 'delete', failure: 'generic' }),
    );

  // ---- Back ----

  const back = () => {
    if (running.current) return;
    if (sheet?.kind === 'delete') {
      setSheet({ kind: 'edit', calendar: sheet.calendar });
      setSheetError(null);
    } else if (sheet) {
      closeSheet();
    } else {
      router.push(`/${locale}/dashboard?user_id=${userId}`);
    }
  };

  // ---- Drawing ----

  const failureText = (e: SheetError) => (e.failure === 'onlyOne' ? t('onlyOne') : e.failure === 'generic' ? t(`errors.${e.action}`) : t(`errors.${e.failure}`));
  const colourName = (name: string) => (t.has(`colors.${name.toLowerCase()}`) ? t(`colors.${name.toLowerCase()}`) : t('colors.unknown'));
  const locked = busy !== null;
  const copyRows = copies?.shown ? owned.filter((c) => copyOf(c.rawId)) : [];

  const calendarRow = (c: Calendar) => {
    // The row names the calendar's categories in the screen's language. "Yours" goes unsaid (the section above says it).
    const shownLabels = c.labels.filter((l) => l !== 'yours' && (VALID_LABELS as readonly string[]).includes(l));
    return (
      <ListRow
        key={c.rawId}
        title={
          <>
            <Dot colour={drawn.get(c.rawId) ?? c.color} />
            <bdi dir="auto">{c.name}</bdi>
          </>
        }
        meta={t(PRIVACY_KEY[c.privacy])}
        tags={shownLabels.length > 0 ? shownLabels.map((l) => <Tag key={l} tone={l === 'primary' ? 'accent' : 'muted'}>{categories(l)}</Tag>) : undefined}
        onClick={() => openEdit(c)}
      />
    );
  };

  const googleRow = () => {
    const toSelect = () => router.push(`/${locale}/select-calendars?user_id=${userId}`);
    // /refresh-token lives outside [locale] (proxy.ts skips that path): no language prefix
    const toGoogle = () => window.location.assign(`/refresh-token?user_id=${userId}`);
    const go = google.state === 'connected' || google.state === 'choose' ? toSelect : toGoogle;
    const label = google.state === 'connected' ? t('googleChosen') : google.state === 'choose' ? t('googleChoose') : google.state === 'reconnect' ? t('googleReconnect') : t('googleConnect');
    return (
      <button type="button" className="ch-form-row" onClick={go}>
        <span className="ch-form-label">
          <span>{label}</span>
        </span>
        {google.state === 'connected' ? (
          <span className="ch-form-value">
            <span className="ch-form-value-text" dir="auto">{t('googleChosenCount', { count: google.chosen })}</span>
          </span>
        ) : null}
        <Chevron />
      </button>
    );
  };

  /** The Remove / Keep question, for a copy being turned off and for a calendar being deleted with its copy on. */
  const question = (c: Calendar, onChoose: (choice: UnlinkChoice) => void, pending: { remove: boolean; keep: boolean }) => (
    <div className="ch-sheet-stack">
      <h2 className="ch-sheet-heading">{tc('unlink.question', { name: isolate(c.name) })}</h2>
      <button type="button" className="ch-btn ch-btn-primary ch-btn-danger ch-save" disabled={locked} aria-busy={pending.remove || undefined} onClick={() => onChoose('remove')}>
        {pending.remove ? <Spinner /> : null}
        {tc('unlink.remove')}
      </button>
      <button type="button" className="ch-btn ch-btn-primary ch-save" disabled={locked} aria-busy={pending.keep || undefined} onClick={() => onChoose('keep')}>
        {pending.keep ? <Spinner /> : null}
        {tc('unlink.keep')}
      </button>
    </div>
  );

  const editSheet = (c: Calendar) => {
    const onlyOne = owned.length <= 1;
    const toggle = (label: string) => setDraft((d) => ({ ...d, labels: d.labels.includes(label) ? d.labels.filter((l) => l !== label) : [...d.labels, label] }));
    return (
      <BottomSheet label={c.name} closeLabel={ui('cancel')} closeDisabled={locked} onClose={closeSheet}>
        <div className="ch-sheet-stack is-roomy">
          <div className="ch-form-group">
            <SectionLabel>{t('name')}</SectionLabel>
            <FormCard>
              <TextField label={t('name')} value={draft.name} onChange={(name) => setDraft((d) => ({ ...d, name }))} maxLength={60} />
            </FormCard>
          </div>

          <div className="ch-form-group">
            <SectionLabel>{t('color')}</SectionLabel>
            <FormCard>
              <ColorSwatches
                label={t('color')}
                value={draft.color.toLowerCase()}
                options={CALENDAR_PALETTE.map(({ hex, name }) => ({ value: hex, color: hex, text: colourName(name) }))}
                onChange={(color) => setDraft((d) => ({ ...d, color }))}
              />
            </FormCard>
          </div>

          <div className="ch-form-group">
            <SectionLabel>{t('categories')}</SectionLabel>
            <FormCard>
              {VALID_LABELS.map((label) => (
                <SwitchRow key={label} label={categories(label)} hint={t(`categoryHint.${label}`)} checked={draft.labels.includes(label)} onChange={() => toggle(label)} />
              ))}
            </FormCard>
          </div>

          <div className="ch-form-group">
            <SectionLabel>{t('privacy')}</SectionLabel>
            <RadioCard
              label={t('privacy')}
              value={draft.privacy}
              options={PRIVACIES.map((p) => ({ value: p, text: t(PRIVACY_KEY[p]) }))}
              onChange={(privacy) => setDraft((d) => ({ ...d, privacy: privacy as Calendar['privacy'] }))}
            />
          </div>

          <SaveBar
            label={ui('save')}
            busy={busy === 'save'}
            disabled={locked || !draft.name.trim()}
            error={sheetError?.action === 'save' ? failureText(sheetError) : null}
            onSave={() => void save()}
          />

          <FormCard>
            {onlyOne ? (
              <button type="button" className="ch-form-row ch-danger-row" disabled>
                <span className="ch-form-label">
                  <span>{t('delete')}</span>
                  <span className="ch-form-hint">{t('onlyOne')}</span>
                </span>
              </button>
            ) : (
              <button type="button" className="ch-form-row ch-danger-row" disabled={locked} aria-busy={busy === 'load' || undefined} onClick={() => void startDelete(c)}>
                {t('delete')}
                {busy === 'load' ? <Spinner /> : null}
              </button>
            )}
          </FormCard>
          {sheetError?.action === 'delete' ? <FieldError id={deleteErrorId} error={failureText(sheetError)} /> : null}
        </div>
      </BottomSheet>
    );
  };

  const deleteSheet = (c: Calendar) => {
    // What is deleted comes first; a calendar whose Google copy is on then asks the Google question, and each answer is a button that says both halves
    const copyOn = copyOf(c.rawId)?.on === true;
    return (
      <BottomSheet label={t('deleteTitle', { name: isolate(c.name) })} closeLabel={ui('cancel')} closeDisabled={locked} onClose={closeSheet}>
        <h2 className="ch-sheet-heading">{sentenceWithName((name) => t('deleteTitle', { name }), c.name)}</h2>
        <p className="ch-sheet-sub">{t('deleteBody')}</p>
        <div className="ch-sheet-stack">
          {copyOn ? <p className="ch-sheet-question">{tc('unlink.question', { name: isolate(c.name) })}</p> : null}
          {sheetError ? <Notice tone="error">{failureText(sheetError)}</Notice> : null}
          {copyOn ? (
            <>
              <button type="button" className="ch-btn ch-btn-primary ch-btn-danger ch-save" disabled={locked} aria-busy={busy === 'delete-remove' || undefined} onClick={() => void deleteCalendar(c, 'remove')}>
                {busy === 'delete-remove' ? <Spinner /> : null}
                {t('deleteBoth')}
              </button>
              <button type="button" className="ch-btn ch-btn-outline ch-save" disabled={locked} aria-busy={busy === 'delete-keep' || undefined} onClick={() => void deleteCalendar(c, 'keep')}>
                {busy === 'delete-keep' ? <Spinner /> : null}
                {t('deleteKeepGoogle')}
              </button>
            </>
          ) : (
            <button type="button" className="ch-btn ch-btn-primary ch-btn-danger ch-save" disabled={locked} aria-busy={busy === 'delete-plain' || undefined} onClick={() => void deleteCalendar(c, null)}>
              {busy === 'delete-plain' ? <Spinner /> : null}
              {t('delete')}
            </button>
          )}
        </div>
      </BottomSheet>
    );
  };

  const createSheet = () => (
    <BottomSheet label={t('newCalendar')} closeLabel={ui('cancel')} closeDisabled={locked} onClose={closeSheet}>
      <h2 className="ch-sheet-heading">{t('newCalendar')}</h2>
      <div className="ch-sheet-stack">
        <FormCard>
          <TextField label={t('name')} value={newName} onChange={setNewName} placeholder={t('namePlaceholder')} maxLength={60} />
        </FormCard>
        {sheetError?.failure === 'limit' ? (
          <Notice tone="error" action={{ label: t('seePlans'), onClick: () => router.push(`/${locale}/subscription?user_id=${userId}`) }}>
            {failureText(sheetError)}
          </Notice>
        ) : null}
        <SaveBar
          label={t('create')}
          busy={busy === 'create'}
          disabled={locked || !newName.trim()}
          error={sheetError && sheetError.failure !== 'limit' ? failureText(sheetError) : null}
          onSave={() => void create()}
        />
      </div>
    </BottomSheet>
  );

  return (
    <AppScreen ground="grouped" onBack={back}>
      <style>{FORM_CSS}</style>
      <ScreenHeader title={t('title')} backLabel={ui('back')} onBack={back} />
      <div className="ch-form-page ch-form-page-grouped">
        {copyLoadFailed ? <Notice tone="error">{tc('errors.load')}</Notice> : null}

        <SectionLabel>{t('yours')}</SectionLabel>
        <FormCard>
          {owned.map(calendarRow)}
          <button type="button" className="ch-form-row ch-action-row" disabled={locked} onClick={openCreate}>
            <Plus size={18} aria-hidden="true" />
            {t('newCalendar')}
          </button>
        </FormCard>

        {copyRows.length > 0 ? (
          <>
            <SectionLabel>{tc('title')}</SectionLabel>
            <FormCard>{copyRows.map(copyRowFor)}</FormCard>
            <GoogleCopyNotes />
          </>
        ) : null}

        {shared.length > 0 ? (
          <>
            <SectionLabel>{partnerName ? t('sharedBy', { name: isolate(partnerName) }) : t('sharedByPartner')}</SectionLabel>
            <FormCard>
              {shared.map((c) => (
                <div key={c.rawId} className="ch-form-row">
                  <span className="ch-form-label">
                    <span className="ch-list-title">
                      <Dot colour={drawn.get(c.rawId) ?? c.color} />
                      <bdi dir="auto">{c.name}</bdi>
                    </span>
                    <span className="ch-form-hint">{sharedAccess(c.privacy === 'SHARED_EDITOR' ? 'edit' : 'view')}</span>
                  </span>
                </div>
              ))}
            </FormCard>
            {copies?.shown && copies.ownerName ? <NonOwnerCopyLine owner={copies.ownerName} /> : null}
          </>
        ) : null}

        <SectionLabel>{t('google')}</SectionLabel>
        <FormCard>{googleRow()}</FormCard>
        <p className="ch-form-fixed">{t('googleHint')}</p>
      </div>

      {sheet?.kind === 'create' ? createSheet() : null}
      {sheet?.kind === 'edit' ? editSheet(sheet.calendar) : null}
      {sheet?.kind === 'delete' ? deleteSheet(sheet.calendar) : null}
      {sheet?.kind === 'copyOff' ? (
        <BottomSheet label={tc('unlink.question', { name: isolate(sheet.calendar.name) })} closeLabel={ui('cancel')} closeDisabled={locked} onClose={closeSheet}>
          {question(sheet.calendar, (choice) => void turnOff(sheet.calendar, choice), { remove: busy === 'off-remove', keep: busy === 'off-keep' })}
        </BottomSheet>
      ) : null}
    </AppScreen>
  );
}
