'use client';

// Settings' "Sign in on the web" group (spec docs/superpowers/specs/2026-11-02-web-sign-in-design.md §4, §2.9, §2.13,
// §2.17), in the Mini App and in the web app. It reads its own rows (GET /api/signin-methods) and saves each change by
// itself: it is not part of the Save bar.
//
// - Telegram shows as on for a Telegram account, only while Telegram sign-in is configured (view.providers.telegram): a
//   row that says "on" for a way /signin doesn't offer would mislead. Telegram and WhatsApp can't be removed here.
// - Google: Add asks for a one-time link (POST /api/auth/google/add-link, 5 minutes) to famcal.bot's add-Google page.
//   Google refuses in-app browsers, so inside Telegram a sheet opens it in the browser with Telegram's openLink on the tap
//   itself (a link opened after an await may be refused, as on the Calendars screen); in a browser this tab goes there.
//   Once added, the row is the address. Before its first use, the Google account the calendar is connected from shows
//   as on, with no address (FamCal keeps none), when its key is current and no other FamCal account holds it; as off,
//   with a Turn on button (POST /api/signin-methods/calendar-on: one live read of the calendar's account, the press is
//   the consent), when it has no usable key yet. Add Google shows whenever that row is not on. Removing either asks
//   first ('google' or 'calendar-google').
// - Email: Add asks for the address, mails a code, then asks for the code; an address on another account is refused
//   only after its code is right ('taken'). Remove asks first.
// - Every removal signs out the other browsers (the server moves sessionsValidAfter; this device keeps a fresh cookie).
// - Sign out (only on a web session: there is a cookie to clear) goes to /signin; Sign out on all devices goes there too
//   on the web, and says it is done in the Mini App.
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
import { signInHref } from '@/src/site/signin';
import { addEmail, confirmEmail, loadMethods, removeMethod, requestGoogleLink, signOutAll, signOutHere, turnOnCalendar, type AddEmailError, type ConfirmEmailError, type MethodsView, type RemoveWhich, type RequestError, type TurnOnError } from './signin-methods-client';

type Phase = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; view: MethodsView };
type EmailError = AddEmailError | ConfirmEmailError;
type EmailSheet = { kind: 'email'; step: 'address' | 'code'; address: string; code: string; error: EmailError | null; busy: boolean };
type RemoveSheet = { kind: 'remove'; which: RemoveWhich; address: string | null; error: RequestError | null; busy: boolean };
type GoogleSheet = { kind: 'google'; url: string };
type Sheet = EmailSheet | RemoveSheet | GoogleSheet;
type Working = 'google' | 'turnOn' | 'signOut' | 'signOutAll';
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
};

/** Turn on's failures: shared and reconnect have words of their own, the rest are the group's plain ones. */
const TURN_ON_KEY: Record<TurnOnError, string> = { failed: 'failed', busy: 'busy', shared: 'turnOnShared', reconnect: 'turnOnReconnect' };

const noop = () => {};

export default function SignInMethods({ userId, onSheet }: { userId: number; onSheet?: (close: (() => void) | null) => void }) {
  const t = useTranslations('settings.signIn');
  const locale = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [working, setWorking] = useState<Working | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

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

  const addGoogle = async () => {
    if (working) return;
    setWorking('google');
    setStatus(null);
    const result = await requestGoogleLink(userId);
    setWorking(null);
    if (result.kind === 'error') {
      setStatus({ tone: 'error', text: t(ERROR_KEY[result.code]) });
      return;
    }
    const url = new URL(result.url, window.location.origin).href;
    if (isInTelegram()) setSheet({ kind: 'google', url });
    else window.location.assign(url);
  };

  const turnOn = async () => {
    if (working) return;
    setWorking('turnOn');
    setStatus(null);
    const result = await turnOnCalendar(userId);
    setWorking(null);
    if (result.kind === 'ok') {
      showMethods(result.methods);
      setStatus({ tone: 'info', text: t('turnedOn') });
      return;
    }
    setStatus({ tone: 'error', text: t(TURN_ON_KEY[result.code]) });
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
    else setSheet({ kind: 'email', step: 'address', address, code: '', error: result.code, busy: false });
  };

  const checkCode = async (address: string, code: string) => {
    setSheet({ kind: 'email', step: 'code', address, code, error: null, busy: true });
    const result = await confirmEmail(userId, code);
    if (result.kind === 'ok') {
      setSheet(null);
      showMethods(result.methods);
      setStatus({ tone: 'info', text: t('added', { kind: 'email' }) });
      return;
    }
    if (result.code === 'restart') {
      setSheet({ kind: 'email', step: 'address', address, code: '', error: 'restart', busy: false });
      return;
    }
    setSheet({ kind: 'email', step: 'code', address, code, error: result.code, busy: false });
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
              <span className="ch-form-hint">{t('hint')}</span>
            </div>
            {view.telegram && view.providers.telegram ? (
              <FormRow label={t('telegram')} hint={t('telegramHint')}>
                <span className="ch-form-value">
                  <span className="ch-form-value-text">{t('on')}</span>
                </span>
              </FormRow>
            ) : null}
            {view.google ? (
              <ButtonRow label={t('google')} value={view.google.address} valueDir="ltr" disabled={off} onClick={() => openRemove('google', view.google?.address ?? null)} />
            ) : null}
            {!view.google && view.providers.google && view.googleFromCalendar === 'on' ? (
              <ButtonRow label={t('google')} hint={t('googleFromCalendar')} value={t('on')} disabled={off} onClick={() => openRemove('calendar-google', null)} />
            ) : null}
            {!view.google && view.providers.google && view.googleFromCalendar === 'off' ? (
              <>
                <FormRow label={t('googleFromCalendar')} hint={t('calendarOffHint')} />
                <button type="button" className="ch-form-row ch-action-row" disabled={off} aria-busy={working === 'turnOn' || undefined} onClick={() => void turnOn()}>
                  {working === 'turnOn' ? (
                    <>
                      {spin} {t('turningOn')}
                    </>
                  ) : (
                    t('turnOn')
                  )}
                </button>
              </>
            ) : null}
            {!view.google && view.providers.google && view.googleFromCalendar !== 'on' ? (
              <button type="button" className="ch-form-row ch-action-row" disabled={off} aria-busy={working === 'google' || undefined} onClick={() => void addGoogle()}>
                {working === 'google' ? (
                  <>
                    {spin} {t('googlePreparing')}
                  </>
                ) : (
                  t('googleAdd')
                )}
              </button>
            ) : null}
            {view.email ? (
              <ButtonRow label={t('email')} value={view.email.address} valueDir="ltr" disabled={off} onClick={() => openRemove('email', view.email?.address ?? null)} />
            ) : view.providers.email ? (
              <button type="button" className="ch-form-row ch-action-row" disabled={off} onClick={openEmail}>
                {t('emailAdd')}
              </button>
            ) : null}
          </FormCard>
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
            {sheet.error ? <Notice tone="error">{t(ERROR_KEY[sheet.error])}</Notice> : null}
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
