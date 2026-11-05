'use client';

// Settings' "Sign in on the web" group (spec docs/superpowers/specs/2026-11-02-web-sign-in-design.md §4, §2.9, §2.13,
// §2.17), in the Mini App and in the web app. It reads its own rows (GET /api/signin-methods) and saves each change by
// itself: it is not part of the Save bar.
//
// - Telegram shows as on for a Telegram account, only while Telegram sign-in is configured (view.providers.telegram): a
//   row that says "on" for a way /signin doesn't offer would mislead. Telegram and WhatsApp can't be removed here.
// - An account with no chat (view.chat false, made on famcal.bot; 6c-1) sees the browser hint and a Telegram row with
//   Connect Telegram (the shared helper, telegram-connect-client.ts), whatever Telegram sign-in's configuration.
// - Google: Add asks for a one-time link (POST /api/auth/google/add-link, 5 minutes) to famcal.bot's add-Google page.
//   Google refuses in-app browsers, so inside Telegram a sheet opens it in the browser with Telegram's openLink on the tap
//   itself (a link opened after an await may be refused, as on the Calendars screen); in a browser this tab goes there.
//   Once added, the row is the address. Before its first use, the Google account the calendar is connected from shows
//   as on, with no address (FamCal keeps none), when its key is current and no other FamCal account holds it; as off,
//   with a Turn on button (POST /api/signin-methods/calendar-on: one live read of the calendar's account, the press is
//   the consent), when it has no usable key yet. Add Google shows whenever that row is not on. Removing either asks
//   first ('google' or 'calendar-google').
// - Email: Add asks for the address, mails a code, then asks for the code; an address on another account is refused
//   only after its code is right ('taken'). Remove asks first. When that other account was made on famcal.bot and has
//   no chat, the right code asks instead whether to join it into this one (web sign-up spec §2.9), listing what moves
//   (joinLines); Join posts /api/signin-methods/join.
// - Every removal signs out the other browsers (the server moves sessionsValidAfter; this device keeps a fresh cookie).
// - The account's only durable way (view.lastWay, web sign-up spec 2026-11-03 §2.12) shows with no Remove, and says
//   why; the server refuses it too ('last-way'), which the remove sheet words the same.
// - The notice for a way added goes to the chat, or by email with no chat (view.chat): the success line says which.
// - Sign out (only on a web session: there is a cookie to clear) goes to /signin; Sign out on all devices goes there too
//   on the web, and says it is done in the Mini App.
// - Adding a way from a browser needs a sign-in from the last hour (6c-1 follow-ups, src/lib/recent-sign-in.ts): the routes
//   answer 403 stale-sign-in to an older cookie, never to the Mini App. The page learns of it on the press (no field in
//   the GET): Add Google, Add email, Turn on and the Join question then read "Sign in again to ...", with a note, and the
//   next press signs this browser out and opens /signin (sign-in-again.ts, as Connect Telegram does). A WhatsApp-link
//   session can't sign in again here: it keeps its buttons and shows the WhatsApp hint (pageGate.browserBody) instead.
// - The requests are signin-methods-client.ts; each failure is said here in words and logged there with its status.
// - `onSheet` tells the screen what Back should do while a sheet is open (its closer, a no-op while its request is out),
//   and null once it is closed, as GoogleDisconnect does.
//
// Strings: settings.signIn.*. Lucide icons only.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { ButtonRow, FormCard, FormRow, TextField } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { SectionLabel } from '@/components/app-ui/ScreenHeader';
import { isInTelegram, openExternalLink } from '@/src/lib/telegram-ui';
import type { SignInMethodsView } from '@/src/services/web-signin/identities';
import { joinDateText, joinLines, type JoinSummary } from '@/src/lib/join-summary';
import { signInHref } from '@/src/site/signin';
import { signInAgain } from '@/src/lib/sign-in-again';
import { connectButtonKey, connectLineKey, useTelegramConnect } from '@/src/lib/telegram-connect-client';
import { addEmail, confirmEmail, joinAccount, loadMethods, removeMethod, requestGoogleLink, signOutAll, signOutHere, turnOnCalendar, type AddEmailError, type ConfirmEmailError, type JoinError, type MethodsView, type RemoveError, type RemoveWhich, type TurnOnError } from './signin-methods-client';

type Phase = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; view: MethodsView };
type EmailError = AddEmailError | ConfirmEmailError;
type EmailSheet = { kind: 'email'; step: 'address' | 'code'; address: string; code: string; error: EmailError | null; busy: boolean };
type RemoveSheet = { kind: 'remove'; which: RemoveWhich; address: string | null; error: RemoveError | null; busy: boolean };
type GoogleSheet = { kind: 'google'; url: string };
type JoinSheet = { kind: 'join'; joinId: string; summary: JoinSummary; error: JoinError | null; busy: boolean };
type Sheet = EmailSheet | RemoveSheet | GoogleSheet | JoinSheet;
type Working = 'google' | 'turnOn' | 'signOut' | 'signOutAll' | 'leaving';
type Status = { tone: 'info' | 'error'; text: string };

/** Each failure's words: a key of settings.signIn. */
const ERROR_KEY: Record<EmailError, string> = {
  failed: 'failed',
  busy: 'busy',
  invalid: 'emailInvalid',
  limit: 'emailLimit',
  'has-one': 'emailHasOne',
  wrong: 'codeWrong',
  taken: 'codeTaken',
  restart: 'codeRestart',
  codeLimit: 'codeLimit',
  stale: 'staleNote',
};

/** Join's failures: a key of settings.signIn. */
const JOIN_ERROR_KEY: Record<JoinError, string> = { failed: 'failed', busy: 'busy', expired: 'join.expired', refused: 'join.refused', stale: 'staleNote' };

/** Turn on's failures: shared and reconnect have words of their own, the rest are the group's plain ones. */
const TURN_ON_KEY: Record<TurnOnError, string> = { failed: 'failed', busy: 'busy', shared: 'turnOnShared', reconnect: 'turnOnReconnect', stale: 'staleNote' };

const noop = () => {};

export default function SignInMethods({ userId, onSheet }: { userId: number; onSheet?: (close: (() => void) | null) => void }) {
  const t = useTranslations('settings.signIn');
  const locale = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [working, setWorking] = useState<Working | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const c = useTranslations('telegramConnect');
  const gate = useTranslations('pageGate');
  // A route refused for a sign-in over an hour old (set only on a browser's session, never in the Mini App)
  const [stale, setStale] = useState(false);
  // No chat (view.chat false, Task 8): Telegram connects here (6c-1)
  const connect = useTelegramConnect(userId, locale);
  const connecting = connect.phase === 'busy' || connect.phase === 'leaving';
  const connectLine = connectLineKey(connect.phase);

  useEffect(() => {
    let live = true;
    void loadMethods(userId).then((result) => {
      if (live) setPhase(result.kind === 'ok' ? { kind: 'ready', view: result.view } : { kind: 'error' });
    });
    return () => {
      live = false;
    };
  }, [userId, attempt]);

  // The closers run later than the render that made them: they read the screen's latest callback
  const latest = useRef(onSheet);
  useEffect(() => {
    latest.current = onSheet;
  });
  const sheetOpen = sheet !== null;
  const sheetBusy = sheet !== null && sheet.kind !== 'google' && sheet.busy;
  useEffect(() => {
    latest.current?.(!sheetOpen ? null : sheetBusy ? noop : () => setSheet(null));
  }, [sheetOpen, sheetBusy]);
  useEffect(() => () => latest.current?.(null), []);

  const view = phase.kind === 'ready' ? phase.view : null;
  /** New rows from a change: the session this page was opened with stays (a removal gives this device a fresh cookie of the same kind). */
  const showMethods = (methods: SignInMethodsView) => setPhase((p) => ({ kind: 'ready', view: { ...methods, session: p.kind === 'ready' ? p.view.session : null } }));
  const editEmail = (patch: Partial<EmailSheet>) => setSheet((s) => (s && s.kind === 'email' ? { ...s, ...patch } : s));
  const retry = () => {
    setPhase({ kind: 'loading' });
    setAttempt((n) => n + 1);
  };

  // A browser's session can sign in again; a WhatsApp-link one asks for a new link in the chat instead
  const asksSignIn = stale && view?.session != null && view.session !== 'wa';
  const asksLink = stale && view?.session === 'wa';
  const staleLine = asksLink ? gate('browserBody') : t('staleNote');
  /** A stale answer on a browser's session: remembered, the buttons change. False in the Mini App, which the server never asks. */
  const markStale = (): boolean => {
    if (!view?.session) return false;
    setStale(true);
    return true;
  };
  const leave = async () => {
    if (working) return;
    setWorking('leaving');
    setStatus(null);
    if (await signInAgain(locale)) return;
    setWorking(null);
    setStatus({ tone: 'error', text: t('failed') });
  };

  const addGoogle = async () => {
    if (working) return;
    if (asksSignIn) return void leave();
    setWorking('google');
    setStatus(null);
    const result = await requestGoogleLink(userId);
    setWorking(null);
    if (result.kind === 'error') {
      if (result.code === 'stale' && markStale()) return;
      setStatus({ tone: 'error', text: t(result.code === 'stale' ? 'failed' : ERROR_KEY[result.code]) });
      return;
    }
    const url = new URL(result.url, window.location.origin).href;
    if (isInTelegram()) setSheet({ kind: 'google', url });
    else window.location.assign(url);
  };

  const turnOn = async () => {
    if (working) return;
    if (asksSignIn) return void leave();
    setWorking('turnOn');
    setStatus(null);
    const result = await turnOnCalendar(userId);
    setWorking(null);
    if (result.kind === 'ok') {
      showMethods(result.methods);
      setStatus({ tone: 'info', text: t('turnedOn') });
      return;
    }
    if (result.code === 'stale' && markStale()) return;
    setStatus({ tone: 'error', text: t(result.code === 'stale' ? 'failed' : TURN_ON_KEY[result.code]) });
  };

  const openGoogle = (url: string) => {
    setSheet(null);
    if (openExternalLink(url)) {
      setStatus({ tone: 'info', text: t('googleOpened') });
      return;
    }
    console.warn('[signin-methods] the browser could not be opened for Add Google');
    setStatus({ tone: 'error', text: t('failed') });
  };

  const sendCode = async (address: string, from: EmailSheet['step']) => {
    setSheet({ kind: 'email', step: from, address, code: '', error: null, busy: true });
    const result = await addEmail(userId, address);
    if (result.kind === 'ok') setSheet({ kind: 'email', step: 'code', address, code: '', error: null, busy: false });
    else if (result.code === 'stale' && markStale()) setSheet(null);
    else setSheet({ kind: 'email', step: 'address', address, code: '', error: result.code === 'stale' ? 'failed' : result.code, busy: false });
  };

  const checkCode = async (address: string, code: string) => {
    setSheet({ kind: 'email', step: 'code', address, code, error: null, busy: true });
    const result = await confirmEmail(userId, code);
    if (result.kind === 'ok') {
      setSheet(null);
      showMethods(result.methods);
      setStatus({ tone: 'info', text: t(result.methods.chat ? 'added' : 'noticeSentEmail', { kind: 'email' }) });
      return;
    }
    if (result.kind === 'join') {
      setSheet({ kind: 'join', joinId: result.joinId, summary: result.summary, error: null, busy: false });
      return;
    }
    if (result.code === 'restart') {
      setSheet({ kind: 'email', step: 'address', address, code: '', error: 'restart', busy: false });
      return;
    }
    if (result.code === 'stale' && markStale()) {
      setSheet(null);
      return;
    }
    setSheet({ kind: 'email', step: 'code', address, code, error: result.code === 'stale' ? 'failed' : result.code, busy: false });
  };

  const join = async (question: JoinSheet) => {
    setSheet({ ...question, error: null, busy: true });
    const result = await joinAccount(userId, question.joinId);
    if (result.kind === 'ok') {
      setSheet(null);
      showMethods(result.methods);
      setStatus({ tone: 'info', text: t('join.done') });
      return;
    }
    if (result.code === 'stale') markStale();
    setSheet({ ...question, error: result.code === 'stale' && !view?.session ? 'failed' : result.code, busy: false });
  };

  const remove = async (which: RemoveWhich, address: string | null) => {
    setSheet({ kind: 'remove', which, address, error: null, busy: true });
    const result = await removeMethod(userId, which);
    if (result.kind === 'ok') {
      setSheet(null);
      showMethods(result.methods);
      setStatus({ tone: 'info', text: t('removed') });
      return;
    }
    setSheet({ kind: 'remove', which, address, error: result.code, busy: false });
  };

  const signOut = async () => {
    if (working) return;
    setWorking('signOut');
    setStatus(null);
    const result = await signOutHere(userId);
    if (result.kind === 'ok') {
      window.location.assign(signInHref(locale));
      return;
    }
    setWorking(null);
    setStatus({ tone: 'error', text: t(ERROR_KEY[result.code]) });
  };

  const signOutEverywhere = async () => {
    if (working || !view) return;
    setWorking('signOutAll');
    setStatus(null);
    const result = await signOutAll(userId);
    if (result.kind === 'ok' && view.session) {
      window.location.assign(signInHref(locale));
      return;
    }
    setWorking(null);
    setStatus(result.kind === 'ok' ? { tone: 'info', text: t('signedOutAll') } : { tone: 'error', text: t(ERROR_KEY[result.code]) });
  };

  const openRemove = (which: RemoveWhich, address: string | null) => {
    setStatus(null);
    setSheet({ kind: 'remove', which, address, error: null, busy: false });
  };
  const openEmail = () => {
    if (asksSignIn) {
      void leave();
      return;
    }
    setStatus(null);
    setSheet({ kind: 'email', step: 'address', address: '', code: '', error: null, busy: false });
  };

  const spin = <Loader2 size={16} className="ch-spin" aria-hidden="true" />;
  const workingLine = (text: string) => (
    <p className="ch-form-fixed ch-working">
      {spin} {text}
    </p>
  );
  const off = working !== null;
  /** A Sign in again label: with the spinner once the press is on its way to /signin. */
  const leaveLabel = (label: string) =>
    working === 'leaving' ? (
      <>
        {spin} {label}
      </>
    ) : (
      label
    );

  return (
    <>
      <SectionLabel>{t('title')}</SectionLabel>
      {phase.kind === 'loading' ? (
        <FormCard>
          <div className="ch-form-row">
            <p className="ch-form-fixed ch-working" role="status">
              {spin} {t('loading')}
            </p>
          </div>
        </FormCard>
      ) : phase.kind === 'error' || !view ? (
        <Notice tone="error" action={{ label: t('retry'), onClick: retry }}>
          {t('loadFailed')}
        </Notice>
      ) : (
        <>
          <FormCard>
            <div className="ch-form-row">
              <span className="ch-form-hint">{view.chat ? t('hint') : t('hintNoChat')}</span>
            </div>
            {!view.chat ? (
              <>
                <FormRow label={t('telegram')} hint={t('telegramConnectHint')} />
                <button type="button" className="ch-form-row ch-action-row" disabled={off || connecting} aria-busy={connecting || undefined} onClick={connect.press}>
                  {connecting ? (
                    <>
                      {spin} {c(connectButtonKey(connect.phase))}
                    </>
                  ) : (
                    c(connectButtonKey(connect.phase))
                  )}
                </button>
              </>
            ) : view.telegram && view.providers.telegram ? (
              <FormRow label={t('telegram')} hint={t('telegramHint')}>
                <span className="ch-form-value">
                  <span className="ch-form-value-text">{t('on')}</span>
                </span>
              </FormRow>
            ) : null}
            {view.google && view.lastWay === 'google' ? (
              <FormRow label={t('google')} hint={t('lastWay')}>
                <span className="ch-form-value">
                  <span className="ch-form-value-text" dir="auto">
                    <bdi dir="ltr">{view.google.address}</bdi>
                  </span>
                </span>
              </FormRow>
            ) : view.google ? (
              <ButtonRow label={t('google')} value={view.google.address} valueDir="ltr" disabled={off} onClick={() => openRemove('google', view.google?.address ?? null)} />
            ) : null}
            {!view.google && view.providers.google && view.googleFromCalendar === 'on' ? (
              <ButtonRow label={t('google')} hint={t('googleFromCalendar')} value={t('on')} disabled={off} onClick={() => openRemove('calendar-google', null)} />
            ) : null}
            {!view.google && view.providers.google && view.googleFromCalendar === 'off' ? (
              <>
                <FormRow label={t('googleFromCalendar')} hint={t('calendarOffHint')} />
                <button type="button" className="ch-form-row ch-action-row" disabled={off} aria-busy={working === 'turnOn' || (asksSignIn && working === 'leaving') || undefined} onClick={() => void turnOn()}>
                  {working === 'turnOn' ? (
                    <>
                      {spin} {t('turningOn')}
                    </>
                  ) : asksSignIn ? (
                    leaveLabel(t('turnOnSignInAgain'))
                  ) : (
                    t('turnOn')
                  )}
                </button>
              </>
            ) : null}
            {!view.google && view.providers.google && view.googleFromCalendar !== 'on' ? (
              <button type="button" className="ch-form-row ch-action-row" disabled={off} aria-busy={working === 'google' || (asksSignIn && working === 'leaving') || undefined} onClick={() => void addGoogle()}>
                {working === 'google' ? (
                  <>
                    {spin} {t('googlePreparing')}
                  </>
                ) : asksSignIn ? (
                  leaveLabel(t('googleSignInAgain'))
                ) : (
                  t('googleAdd')
                )}
              </button>
            ) : null}
            {view.email && view.lastWay === 'email' ? (
              <FormRow label={t('email')} hint={t('lastWay')}>
                <span className="ch-form-value">
                  <span className="ch-form-value-text" dir="auto">
                    <bdi dir="ltr">{view.email.address}</bdi>
                  </span>
                </span>
              </FormRow>
            ) : view.email ? (
              <ButtonRow label={t('email')} value={view.email.address} valueDir="ltr" disabled={off} onClick={() => openRemove('email', view.email?.address ?? null)} />
            ) : view.providers.email ? (
              <button type="button" className="ch-form-row ch-action-row" disabled={off} aria-busy={(asksSignIn && working === 'leaving') || undefined} onClick={openEmail}>
                {asksSignIn ? leaveLabel(t('emailSignInAgain')) : t('emailAdd')}
              </button>
            ) : null}
          </FormCard>
          {stale ? <Notice>{staleLine}</Notice> : null}
          <FormCard>
            {view.session ? (
              <button type="button" className="ch-form-row ch-action-row" disabled={off} aria-busy={working === 'signOut' || undefined} onClick={() => void signOut()}>
                {working === 'signOut' ? (
                  <>
                    {spin} {t('signingOut')}
                  </>
                ) : (
                  t('signOut')
                )}
              </button>
            ) : null}
            <button type="button" className="ch-form-row ch-action-row" disabled={off} aria-busy={working === 'signOutAll' || undefined} onClick={() => void signOutEverywhere()}>
              {working === 'signOutAll' ? (
                <>
                  {spin} {t('signingOut')}
                </>
              ) : (
                t('signOutAll')
              )}
            </button>
          </FormCard>
        </>
      )}
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {connectLine ? <Notice tone={connectLine.problem ? 'error' : 'info'}>{c(connectLine.key)}</Notice> : null}

      {sheet?.kind === 'remove' ? (
        <BottomSheet label={t('removeTitle', { kind: sheet.which === 'email' ? 'email' : 'google' })} closeLabel={t('cancel')} closeDisabled={sheet.busy} onClose={() => setSheet(null)}>
          <h2 className="ch-sheet-heading">{t('removeTitle', { kind: sheet.which === 'email' ? 'email' : 'google' })}</h2>
          {sheet.address ? (
            <p className="ch-sheet-sub">
              <bdi dir="ltr">{sheet.address}</bdi>
            </p>
          ) : null}
          <p className="ch-sheet-sub">{sheet.which === 'calendar-google' ? t('removeCalendarBody') : t('removeBody')}</p>
          <div className="ch-sheet-stack">
            {sheet.error ? <Notice tone="error">{t(sheet.error === 'last-way' ? 'lastWay' : ERROR_KEY[sheet.error])}</Notice> : null}
            {sheet.busy ? workingLine(t('removing')) : null}
            <button type="button" className="ch-btn ch-btn-primary ch-btn-danger ch-save" disabled={sheet.busy} onClick={() => void remove(sheet.which, sheet.address)}>
              {t('remove')}
            </button>
          </div>
        </BottomSheet>
      ) : null}

      {sheet?.kind === 'google' ? (
        <BottomSheet label={t('googleSheetTitle')} closeLabel={t('cancel')} onClose={() => setSheet(null)}>
          <h2 className="ch-sheet-heading">{t('googleSheetTitle')}</h2>
          <p className="ch-sheet-sub">{t('googleSheetBody')}</p>
          <div className="ch-sheet-stack">
            <button type="button" className="ch-btn ch-btn-primary ch-save" onClick={() => openGoogle(sheet.url)}>
              {t('googleOpen')}
            </button>
          </div>
        </BottomSheet>
      ) : null}

      {sheet?.kind === 'join' ? (
        <BottomSheet label={t('join.title')} closeLabel={t('cancel')} closeDisabled={sheet.busy} onClose={() => setSheet(null)}>
          <h2 className="ch-sheet-heading">{t('join.title')}</h2>
          <p className="ch-sheet-sub">{t('join.question', { kind: 'email', name: sheet.summary.name, date: joinDateText(sheet.summary.createdAt, locale) })}</p>
          <p className="ch-sheet-sub">{t('join.movesTitle')}</p>
          <ul className="ch-sheet-list">
            {joinLines(sheet.summary.plan).map((line) => (
              <li key={line.key}>{t(`join.${line.key}`, line.values)}</li>
            ))}
          </ul>
          <p className="ch-sheet-sub">{t('join.closes')}</p>
          <div className="ch-sheet-stack">
            {sheet.error ? <Notice tone="error">{sheet.error === 'stale' ? staleLine : t(JOIN_ERROR_KEY[sheet.error])}</Notice> : null}
            {sheet.busy ? workingLine(t('join.joining')) : null}
            <button type="button" className="ch-btn ch-btn-primary ch-save" disabled={sheet.busy || working === 'leaving' || sheet.error === 'expired' || sheet.error === 'refused'} onClick={() => (asksSignIn ? void leave() : void join(sheet))}>
              {asksSignIn ? t('joinSignInAgain') : t('join.join')}
            </button>
            <button type="button" className="ch-btn" disabled={sheet.busy} onClick={() => setSheet(null)}>
              {t('cancel')}
            </button>
          </div>
        </BottomSheet>
      ) : null}

      {sheet?.kind === 'email' ? (
        <BottomSheet label={t('emailSheetTitle')} closeLabel={t('cancel')} closeDisabled={sheet.busy} onClose={() => setSheet(null)}>
          <h2 className="ch-sheet-heading">{t('emailSheetTitle')}</h2>
          {sheet.step === 'address' ? (
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                const address = sheet.address.trim();
                if (!sheet.busy && address !== '') void sendCode(address, 'address');
              }}
              noValidate
            >
              <p className="ch-sheet-sub">{t('emailBody')}</p>
              <div className="ch-sheet-stack">
                <FormCard>
                  <TextField kind="email" label={t('emailLabel')} placeholder={t('emailLabel')} value={sheet.address} disabled={sheet.busy} error={sheet.error ? t(ERROR_KEY[sheet.error]) : null} onChange={(address) => editEmail({ address, error: null })} />
                </FormCard>
                {sheet.busy ? workingLine(t('emailSending')) : null}
                <button type="submit" className="ch-btn ch-btn-primary ch-save" disabled={sheet.busy || sheet.address.trim() === ''}>
                  {t('emailSend')}
                </button>
              </div>
            </form>
          ) : (
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                if (!sheet.busy && sheet.code.length === 6) void checkCode(sheet.address, sheet.code);
              }}
              noValidate
            >
              <p className="ch-sheet-sub">{t.rich('codeBody', { address: sheet.address, addr: (chunks) => <bdi dir="ltr">{chunks}</bdi> })}</p>
              <div className="ch-sheet-stack">
                <FormCard>
                  <TextField kind="code" label={t('codeLabel')} placeholder={t('codeLabel')} value={sheet.code} maxLength={6} disabled={sheet.busy} error={sheet.error ? t(ERROR_KEY[sheet.error]) : null} onChange={(code) => editEmail({ code: code.replace(/\D/g, '').slice(0, 6), error: null })} />
                </FormCard>
                {sheet.busy ? workingLine(t('codeChecking')) : null}
                <button type="submit" className="ch-btn ch-btn-primary ch-save" disabled={sheet.busy || sheet.code.length !== 6}>
                  {t('codeConfirm')}
                </button>
                <button type="button" className="ch-btn" disabled={sheet.busy} onClick={() => void sendCode(sheet.address, 'code')}>
                  {t('codeAgain')}
                </button>
              </div>
            </form>
          )}
        </BottomSheet>
      ) : null}
    </>
  );
}
