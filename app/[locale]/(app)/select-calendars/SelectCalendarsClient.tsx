'use client';

// The Google calendars screen (the Google calendars a person shows in FamCal), in the home's design (spec 2026-10-19 §4, §5;
// plan W4-2; one compact list since the menu revamp, spec 2026-11-24 §4): an AppScreen on the grouped ground, a header with its
// back, and cards drawn with the form kit (components/app-ui) and this screen's own row rules (CALENDAR_ROW_CSS).
//
// - Not in your Google list (first, only when there are any): the chosen calendars Google no longer lists (deleted, unshared or
//   removed from the list; the home's "N calendars aren't available · Choose again" lands here). Each is its saved name and
//   colour and a Remove row, which saves at once as a switch does. They are no switch and no row of the list, and a save keeps
//   the ones left with their saved name and colour.
// - Show in FamCal: one row per calendar Google lists, a dot in Google's colour and the name (Google's description is not drawn).
//   - A shown calendar's row is two sibling buttons, never one inside the other: its text (the dot, the name, a quiet line with
//     its role or "No category", and the Main tag) opens its sheet: the main-calendar switch, the category, a note for the AI
//     and, for a spouse calendar, the one set of spouse details; the switch at the row's end turns it off.
//   - A hidden calendar's whole row is its switch: there is nothing to edit until it is shown.
//   - A switch saves at once (owner decision 2026-10-28: instant save, with a Saved note and a rollback). The switch button keeps
//     its place when its row changes shape, so it keeps the focus.
// - Notes for all calendars: one row (the count) that opens the sheet of up to three notes.
// - A Google account with no calendars shows a state card instead of those sections.
// - Google account (last, always: the list loads only with a stored token): Reconnect Google, an accent row that is a full page
//   load of /refresh-token?user_id=… (which comes back here after Google's consent), with its hint; then Disconnect Google
//   (./GoogleDisconnect.tsx, moved here from Settings with its words), whose result goes to the Calendars screen.
//   A token Google refuses never reaches this screen: page-data answers the googleReconnect notice (./GoogleReconnectNotice.tsx).
//
// Every save is the whole selection (selection.ts builds the body; the request is POST /api/select-calendars?user_id=… as it has
// always been, with the credential in the X-Telegram-Init-Data header). A tap on a switch applies at once and is undone if the
// save fails; a sheet's Save applies on success only, and a refusal keeps the sheet open with what was typed. The status line
// (Saved, "new events will go to …", or what went wrong) is a bar fixed to the bottom of the screen, so a tap anywhere on a long
// list shows its result: Saved and the note go by themselves after NOTE_MS, like a toast; a refusal stays until the next save. Two refusals have their own words, from the server's codes: the last calendar
// can't be turned off and one calendar must stay marked as yours; the plan's limit has See plans.
// - One request at a time (the Calendars screen's pattern): the one that runs shows a spinner and the other controls are off.
//   Every failure is logged and said in the page's language; the server's own text is never shown.
// - Back has one owner, AppScreen (Telegram's BackButton, and the header's own back in a browser). It closes the open sheet
//   (the disconnect sheet's own closer first, which does nothing while that request runs), does nothing while a save runs,
//   else goes to the Calendars screen, this screen's parent, whoever opened it (the OAuth return, a banner, a bot button).

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { initDataHeaders } from '@/src/lib/read-init-data';
import { isInTelegram, useTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import { sessionEndedKey, signInAgain } from '@/src/lib/sign-in-again';
import type { CalendarLabel } from '@/src/types';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { ButtonRow, FORM_CSS, FormCard, RadioCard, RadioPair, SaveBar, SwitchRow, TextField } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { ScreenHeader, SectionLabel } from '@/components/app-ui/ScreenHeader';
import { StateCard } from '@/components/app-ui/StateCard';
import { Tag } from '@/components/app-ui/Tag';
import { isolate } from '@/src/lib/isolate';
import GoogleDisconnect from './GoogleDisconnect';
import {
  CATEGORIES, applyCalendar, categoriesOf, categoryOf, noteCount, paddedNotes, saveBody, selectionFrom, toggleShown, withCategory, withNotes, withPrimary,
  type CalendarDraft, type ListedCalendar, type Selection, type SpouseInfo,
} from './selection';

interface SelectCalendarsClientProps {
  userId: number;
  availableCalendars: ListedCalendar[];
  /** The chosen calendars Google no longer lists, with their saved name and colour (unlistedChoices, selection.ts). */
  unlistedCalendars?: ListedCalendar[];
  currentSelections: {
    selectedCalendars: Set<string>;
    calendarLabels: Map<string, Set<CalendarLabel>>;
    spouseInfo: SpouseInfo | null;
    calendarRules: Map<string, string>;
    globalRules: string[];
  };
  locale: string;
  /**
   * The name of the user's FamCal calendar that is the default for new events (labelled
   * primary), or null. Ticking primary here moves the default off it, so the page says so.
   */
  famcalPrimaryName?: string | null;
}

const HEX = /^#[0-9a-f]{3,8}$/i;

/**
 * Why a save did not go through. `limit` is the plan's room (the shared calendar total), when the server said it.
 * `noneSelected` and `noYours` are the server's two refusals the person can act on: the last calendar can't be turned off,
 * and one calendar must stay marked as theirs. `generic` is any other refusal (a 4xx): the server wrote nothing, so a switch
 * that went back is "undone". `retry` is a 5xx or no answer: the server may have written the change, so it only says to try again
 * (the switch still goes back, and the next save, which is always the whole selection, puts both right).
 */
type Failure = 'tooMany' | 'reopen' | 'limit' | 'noneSelected' | 'noYours' | 'generic' | 'retry';
interface SaveFailure {
  failure: Failure;
  limit: number | null;
}

/** What a refused save means: the server's code first, then its status. A 401 or 403 is a session that ended. */
function failureOf(status: number, data: { error?: unknown; code?: unknown; limit?: unknown } | null): SaveFailure {
  if (status === 400 && data?.code === 'none_selected') return { failure: 'noneSelected', limit: null };
  if (status === 400 && data?.code === 'no_yours') return { failure: 'noYours', limit: null };
  if (data?.error === 'calendar_limit_reached') return typeof data.limit === 'number' ? { failure: 'limit', limit: data.limit } : { failure: status >= 500 ? 'retry' : 'generic', limit: null };
  if (status === 429) return { failure: 'tooMany', limit: null };
  if (status === 401 || status === 403) return { failure: 'reopen', limit: null };
  return { failure: status >= 500 ? 'retry' : 'generic', limit: null };
}

/** How long Saved and the new-events note stay. A refusal stays until the next save: it may carry its way on (See plans, Sign in). */
export const NOTE_MS = 4000;

/** The status bar: what the last save came to. */
type Status = { id: number; kind: 'saved' } | { id: number; kind: 'newEvents'; name: string } | { id: number; kind: 'failed'; why: SaveFailure };

type Sheet = { kind: 'calendar'; id: string } | { kind: 'notes' };

/** The one request that runs: a switch's save (which row shows it) or a sheet's. */
type Busy = { kind: 'switch'; id: string } | { kind: 'sheet' };

/**
 * The row of a shown calendar, beside the kit's (FORM_CSS) and after it: the row holds a text button that takes the room and
 * can shrink (a long name wraps) and a switch button that never does (at least 44 px). The row itself has no padding, so each
 * button is its own whole target; a hidden calendar's switch is the kit's own row (.ch-form-row) that fills it.
 */
export const CALENDAR_ROW_CSS = `
.ch-form-row.ch-cal-row {
  align-items: stretch;
  gap: 0;
  padding: 0;
}
.ch-cal-row > .ch-cal-open,
.ch-cal-row > .ch-cal-whole {
  flex: 1 1 0;
  min-inline-size: 0;
}
.ch-cal-row > .ch-cal-open {
  padding-inline-end: 8px;
}
button.ch-cal-switch {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-inline-size: 44px;
  padding-block: 0;
  padding-inline: 8px 14px;
  border: 0;
  background: transparent;
  color: var(--ch-text);
  font-family: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
button.ch-cal-switch:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: -2px;
}
button.ch-cal-switch:disabled {
  opacity: 0.6;
  cursor: default;
}
`;

/** The dot of a calendar's colour, in a row's title. */
function Dot({ colour }: { colour: string }) {
  return <span className="ch-swatch-dot is-lg" style={HEX.test(colour) ? { background: colour } : undefined} aria-hidden="true" />;
}

/**
 * A Google calendar's row in "Show in FamCal". Shown: its text (the dot, the name, `role` and the Main tag) is a button that
 * opens its sheet, and the switch beside it (named by the name) turns it off; the two are siblings, never nested. Hidden: the
 * whole row is the switch, the dot and the name. The switch is keyed, so it stays the same element when the row changes shape.
 */
function CalendarRow({ calendar, on, role, main, busy, locked, onOpen, onToggle }: { calendar: ListedCalendar; on: boolean; role: string; main: string | null; busy: boolean; locked: boolean; onOpen: () => void; onToggle: () => void }) {
  const nameId = `${useId()}-name`;
  const name = (
    <span id={nameId} className="ch-list-title">
      <Dot colour={calendar.backgroundColor} />
      <bdi dir="auto">{calendar.name}</bdi>
    </span>
  );
  const spinner = busy ? <span className="ch-form-spinner" aria-hidden="true" /> : null;
  return (
    <div className="ch-form-row ch-cal-row">
      {on ? (
        <button key="open" type="button" className="ch-form-row ch-list-row ch-cal-open" disabled={locked} onClick={onOpen}>
          <span className="ch-form-label">
            {name}
            <span className="ch-form-hint">{role}</span>
            {main ? (
              <span className="ch-list-tags">
                <Tag tone="accent">{main}</Tag>
              </span>
            ) : null}
          </span>
        </button>
      ) : null}
      <button
        key="switch"
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={nameId}
        aria-busy={busy || undefined}
        disabled={locked}
        className={on ? 'ch-cal-switch' : 'ch-form-row ch-cal-whole'}
        onClick={onToggle}
      >
        {on ? null : <span className="ch-form-label">{name}</span>}
        {spinner}
        <span className={on ? 'ch-switch is-on' : 'ch-switch'} aria-hidden="true" />
      </button>
    </div>
  );
}

/** A chosen calendar Google no longer lists: its dot and saved name, then Remove (described by the name), which saves at once. */
function UnlistedCalendar({ calendar, busy, locked, removeLabel, onRemove }: { calendar: ListedCalendar; busy: boolean; locked: boolean; removeLabel: string; onRemove: () => void }) {
  const nameId = `${useId()}-name`;
  return (
    <>
      <div className="ch-form-row">
        <span className="ch-form-label">
          <span id={nameId} className="ch-list-title">
            <Dot colour={calendar.backgroundColor} />
            <bdi dir="auto">{calendar.name}</bdi>
          </span>
        </span>
      </div>
      <button type="button" className="ch-form-row ch-danger-row" aria-describedby={nameId} aria-busy={busy || undefined} disabled={locked} onClick={onRemove}>
        {busy ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
        {removeLabel}
      </button>
    </>
  );
}

export default function SelectCalendarsClient({ userId, availableCalendars, unlistedCalendars = [], currentSelections, locale, famcalPrimaryName = null }: SelectCalendarsClientProps) {
  const t = useTranslations('selectCalendars');
  const page = useTranslations('calendarsPage');
  const categories = useTranslations('calendars.categories');
  const ui = useTranslations('ui');
  const gate = useTranslations('pageGate');
  const router = useRouter();
  const noteHintId = useId();
  const notesHintId = useId();
  const reconnectHintId = useId();

  const [sel, setSel] = useState<Selection>(() => selectionFrom(currentSelections));
  /** The same, readable in a handler that runs right after another one (the value a failed save puts back). */
  const selRef = useRef(sel);
  const commit = (next: Selection) => {
    selRef.current = next;
    setSel(next);
  };

  const [status, setStatus] = useState<Status | null>(null);
  const statusIds = useRef(0);
  const say = (next: { kind: 'saved' } | { kind: 'newEvents'; name: string } | { kind: 'failed'; why: SaveFailure }) => setStatus({ ...next, id: ++statusIds.current });
  // Saved and the note go by themselves; a newer status (another save) clears the wait and starts its own
  useEffect(() => {
    if (!status || status.kind === 'failed') return;
    const shown = status.id;
    const timer = setTimeout(() => setStatus((now) => (now?.id === shown ? null : now)), NOTE_MS);
    return () => clearTimeout(timer);
  }, [status]);
  // The FamCal calendar that holds the default today. The first primary tick here takes it away (the server clears it on save), so the note shows once.
  const [famcalPrimary, setFamcalPrimary] = useState<string | null>(famcalPrimaryName);

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [draft, setDraft] = useState<CalendarDraft>({ labels: new Set(), note: '', spouse: { name: '', englishName: '', gender: '' } });
  const [notesDraft, setNotesDraft] = useState<string[]>(() => paddedNotes(currentSelections.globalRules));
  const [sheetError, setSheetError] = useState<SaveFailure | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  /** The same as `busy`, readable in the handler that runs right after another (two taps in one frame). */
  const running = useRef(false);
  const locked = busy !== null;
  // The disconnect sheet's closer while it is open (GoogleDisconnect reports it), for Back
  const [googleClose, setGoogleClose] = useState<(() => void) | null>(null);
  // A swipe down in a sheet must not minimize the app.
  useTelegramVerticalSwipes(sheet !== null || googleClose !== null);

  /** One request at a time: `kind` is busy while `work` runs; a throw is logged and `fail` tells the person. */
  const run = async (kind: Busy, work: () => Promise<void>, fail: () => void) => {
    if (running.current) return;
    running.current = true;
    setBusy(kind);
    try {
      await work();
    } catch (error) {
      console.error('[select-calendars] save failed:', error);
      fail();
    } finally {
      running.current = false;
      setBusy(null);
    }
  };

  // Google's list and the chosen calendars it no longer has: a save names each with what is known of it (the saved name and colour for those).
  const listedIds = new Set(availableCalendars.map((c) => c.id));
  const unlisted = unlistedCalendars.filter((c) => !listedIds.has(c.id));
  const unlistedIds = new Set(unlisted.map((c) => c.id));
  const known = [...availableCalendars, ...unlisted];

  /** The whole selection to the server: null when it went through, else why not (a refusal is logged). */
  const post = async (next: Selection): Promise<SaveFailure | null> => {
    const res = await fetch(`/api/select-calendars?user_id=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...initDataHeaders() },
      body: JSON.stringify(saveBody(next, known)),
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown; limit?: unknown } | null;
    console.error(`[select-calendars] save refused: ${res.status} ${typeof data?.code === 'string' ? data.code : typeof data?.error === 'string' ? data.error : ''}`.trim());
    return failureOf(res.status, data);
  };

  const nameOf = (id: string) => known.find((c) => c.id === id)?.name ?? id;

  // ---- A switch: the calendar shown in FamCal, or not ----

  const toggle = (id: string) => {
    if (running.current) return;
    const before = selRef.current;
    const next = toggleShown(before, id, unlistedIds);
    return run(
      { kind: 'switch', id },
      async () => {
        setStatus(null);
        commit(next);
        const why = await post(next);
        if (why) {
          commit(before);
          say({ kind: 'failed', why });
          return;
        }
        say({ kind: 'saved' });
      },
      () => {
        commit(before);
        say({ kind: 'failed', why: { failure: 'retry', limit: null } });
      },
    );
  };

  // ---- The sheets ----

  const closeSheet = () => {
    if (running.current) return;
    setSheet(null);
    setSheetError(null);
  };

  const openCalendar = (id: string) => {
    if (running.current) return;
    const now = selRef.current;
    setDraft({
      labels: new Set(now.labels.get(id)),
      note: now.rules.get(id) ?? '',
      spouse: { name: now.spouse?.personName ?? '', englishName: now.spouse?.personEnglishName ?? '', gender: now.spouse?.personGender ?? '' },
    });
    setSheetError(null);
    setSheet({ kind: 'calendar', id });
  };

  const openNotes = () => {
    if (running.current) return;
    setNotesDraft(paddedNotes(selRef.current.globalRules));
    setSheetError(null);
    setSheet({ kind: 'notes' });
  };

  /**
   * A sheet's Save: the selection with its change goes out; it applies, closes and says Saved only once the server has it.
   * `tookPrimary` names the calendar that has just become the main one here, if this save made one.
   */
  const saveSheet = (next: Selection, tookPrimary: string | null) =>
    run(
      { kind: 'sheet' },
      async () => {
        setSheetError(null);
        const why = await post(next);
        if (why) {
          setSheetError(why);
          return;
        }
        commit(next);
        setSheet(null);
        if (tookPrimary !== null && famcalPrimary !== null) {
          // Spec "Google as a connection" §3: the default moves off the FamCal calendar.
          say({ kind: 'newEvents', name: tookPrimary });
          setFamcalPrimary(null);
        } else {
          say({ kind: 'saved' });
        }
      },
      () => setSheetError({ failure: 'retry', limit: null }),
    );

  const saveCalendar = () => {
    if (sheet?.kind !== 'calendar') return;
    const before = selRef.current;
    const tookPrimary = draft.labels.has('primary') && !before.labels.get(sheet.id)?.has('primary');
    return saveSheet(applyCalendar(before, sheet.id, draft), tookPrimary ? nameOf(sheet.id) : null);
  };

  const saveNotes = () => saveSheet(withNotes(selRef.current, notesDraft), null);

  // ---- Back: the open sheet, else the Calendars screen ----

  const toCalendars = () => router.push(`/${locale}/calendars?user_id=${userId}`);
  // Reconnect Google: Google's consent again, which returns here (the Calendars screen's Connect does the same)
  const reconnect = () => {
    if (running.current) return;
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load on purpose: /refresh-token has its own root layout, (connect)
    window.location.assign(`/refresh-token?user_id=${userId}`);
  };
  const back = () => {
    if (googleClose) googleClose();
    else if (running.current) return;
    else if (sheet) closeSheet();
    else toCalendars();
  };

  // ---- Drawing ----

  /**
   * What a refusal says. A refused tap on a switch was undone ("so the change was undone"); a 5xx or no answer only says to
   * try again (the server may have it). In a sheet nothing was applied either way: "couldn't save, try again".
   */
  const failureText = (e: SaveFailure, inSheet = false) => {
    if (e.failure === 'limit') return t('errors.limit', { limit: e.limit ?? 0 });
    if (e.failure === 'noneSelected' || e.failure === 'noYours') return t(`errors.${e.failure}`);
    if (e.failure === 'retry' || (e.failure === 'generic' && inSheet)) return t('errors.retry');
    if (e.failure === 'generic') return t('errors.save');
    // A session that ended: the bot's words inside Telegram, "Sign in again" in a browser (6c-1)
    if (e.failure === 'reopen') return page(sessionEndedKey(isInTelegram()));
    return page(`errors.${e.failure}`);
  };
  const seePlans = { label: page('seePlans'), onClick: () => router.push(`/${locale}/subscription?user_id=${userId}`) };
  const signIn = { label: gate('signIn'), onClick: () => void signInAgain(locale) };
  // The one being removed stays, with its spinner, until the server has it (the selection already dropped it)
  const stillUnlisted = unlisted.filter((c) => sel.selected.has(c.id) || (busy?.kind === 'switch' && busy.id === c.id));

  const statusLine = () => {
    if (!status) return null;
    if (status.kind === 'failed') {
      const way = status.why.failure === 'limit' ? seePlans : status.why.failure === 'reopen' && !isInTelegram() ? signIn : undefined;
      return (
        <Notice key={status.id} tone="error" action={way}>
          {failureText(status.why)}
        </Notice>
      );
    }
    return <Notice key={status.id}>{status.kind === 'saved' ? ui('saved') : t('newEventsGoTo', { name: isolate(status.name) })}</Notice>;
  };

  /** A sheet's refusal: the plan's limit is a notice with its way on, the rest a line above Save. */
  const sheetFailure = () =>
    sheetError?.failure === 'limit' ? (
      <Notice tone="error" action={seePlans}>
        {failureText(sheetError, true)}
      </Notice>
    ) : null;
  const sheetSaveError = () => (sheetError && sheetError.failure !== 'limit' ? failureText(sheetError, true) : null);

  /** A shown calendar's quiet line: its role (the categories), or "No category". */
  const roleOf = (id: string) => {
    const names = categoriesOf(sel.labels.get(id)).map((k) => categories(k));
    return names.length > 0 ? names.join(', ') : t('noCategory');
  };

  const calendarSheet = (calendar: ListedCalendar) => {
    const primary = draft.labels.has('primary');
    const category = categoryOf(draft.labels);
    // The main calendar is one-way, as it has always been here: once saved it is changed by turning primary on for another calendar
    const savedMain = sel.labels.get(calendar.id)?.has('primary') === true;
    const edit = (change: Partial<CalendarDraft>) => setDraft((d) => ({ ...d, ...change }));
    const editSpouse = (change: Partial<CalendarDraft['spouse']>) => setDraft((d) => ({ ...d, spouse: { ...d.spouse, ...change } }));
    return (
      <BottomSheet label={calendar.name} closeLabel={ui('cancel')} closeDisabled={locked} onClose={closeSheet}>
        <div className="ch-sheet-stack is-roomy">
          <h2 className="ch-sheet-heading">
            <bdi dir="auto">{calendar.name}</bdi>
          </h2>

          <FormCard>
            <SwitchRow
              label={categories('primary')}
              hint={savedMain ? t('mainHowToChange') : page('categoryHint.primary')}
              checked={primary}
              disabled={locked || savedMain}
              onChange={(on) => edit({ labels: withPrimary(draft.labels, on) })}
            />
          </FormCard>

          <div className="ch-form-group">
            <SectionLabel>{t('category')}</SectionLabel>
            <RadioCard
              label={t('category')}
              value={category ?? 'none'}
              options={[
                { value: 'none', text: t('noCategory'), disabled: primary },
                ...CATEGORIES.map((k) => ({ value: k, text: categories(k), hint: page(`categoryHint.${k}`), disabled: primary && k !== 'yours' })),
              ]}
              onChange={(value) => edit({ labels: withCategory(draft.labels, value === 'none' ? null : (value as (typeof CATEGORIES)[number])) })}
              disabled={locked}
            />
            {primary ? <p className="ch-form-fixed">{t('mainIsYours')}</p> : null}
          </div>

          <div className="ch-form-group">
            <SectionLabel>{t('note')}</SectionLabel>
            <FormCard>
              <TextField label={t('note')} value={draft.note} onChange={(note) => edit({ note })} placeholder={t('notePlaceholder')} multiline maxLength={200} describedBy={noteHintId} disabled={locked} />
            </FormCard>
            <p id={noteHintId} className="ch-form-fixed">
              {t('noteHint')}
            </p>
          </div>

          {category === 'spouse' ? (
            <div className="ch-form-group">
              <SectionLabel>{t('spouse')}</SectionLabel>
              <div className="ch-sheet-stack">
                <div className="ch-form-group">
                  <span className="ch-form-group-label">{t('spouseName')}</span>
                  <FormCard>
                    <TextField label={t('spouseName')} value={draft.spouse.name} onChange={(name) => editSpouse({ name })} placeholder={t('spouseNamePlaceholder')} maxLength={50} disabled={locked} />
                  </FormCard>
                </div>
                <div className="ch-form-group">
                  <span className="ch-form-group-label">{t('spouseEnglishName')}</span>
                  <FormCard>
                    <TextField label={t('spouseEnglishName')} value={draft.spouse.englishName} onChange={(englishName) => editSpouse({ englishName })} maxLength={50} disabled={locked} />
                  </FormCard>
                </div>
                <RadioPair<'male' | 'female' | ''>
                  label={t('spouseGender')}
                  value={draft.spouse.gender}
                  options={[
                    { value: 'male', text: t('male') },
                    { value: 'female', text: t('female') },
                  ]}
                  onChange={(gender) => {
                    if (!locked) editSpouse({ gender: draft.spouse.gender === gender ? '' : gender });
                  }}
                />
              </div>
              <p className="ch-form-fixed">{t('spouseHint')}</p>
            </div>
          ) : null}

          {sheetFailure()}
          <SaveBar label={ui('save')} busy={busy?.kind === 'sheet'} disabled={locked} error={sheetSaveError()} onSave={() => void saveCalendar()} />
        </div>
      </BottomSheet>
    );
  };

  const notesSheet = () => (
    <BottomSheet label={t('notes')} closeLabel={ui('cancel')} closeDisabled={locked} onClose={closeSheet}>
      <div className="ch-sheet-stack is-roomy">
        <h2 className="ch-sheet-heading">{t('notes')}</h2>
        <FormCard>
          {notesDraft.map((note, i) => (
            <TextField
              key={i}
              label={t('notesPlaceholder', { number: i + 1 })}
              value={note}
              onChange={(value) => setNotesDraft((list) => list.map((x, j) => (j === i ? value : x)))}
              placeholder={t('notesPlaceholder', { number: i + 1 })}
              maxLength={200}
              describedBy={notesHintId}
              disabled={locked}
            />
          ))}
        </FormCard>
        <p id={notesHintId} className="ch-form-fixed">
          {t('notesHint')}
        </p>
        {sheetFailure()}
        <SaveBar label={ui('save')} busy={busy?.kind === 'sheet'} disabled={locked} error={sheetSaveError()} onSave={() => void saveNotes()} />
      </div>
    </BottomSheet>
  );

  const openCalendarOf = sheet?.kind === 'calendar' ? availableCalendars.find((c) => c.id === sheet.id) : undefined;

  return (
    <AppScreen ground="grouped" onBack={back}>
      <style>{FORM_CSS}</style>
      <style>{CALENDAR_ROW_CSS}</style>
      <ScreenHeader title={t('title')} backLabel={ui('back')} onBack={back} />
      <div className="ch-form-page ch-form-page-grouped">
        <p className="ch-form-fixed">{t('intro')}</p>

        {stillUnlisted.length > 0 ? (
          <>
            <SectionLabel>{t('unavailable.title')}</SectionLabel>
            <FormCard>
              {stillUnlisted.map((c) => (
                <UnlistedCalendar
                  key={c.id}
                  calendar={c}
                  busy={busy?.kind === 'switch' && busy.id === c.id}
                  locked={locked}
                  removeLabel={t('unavailable.remove')}
                  onRemove={() => void toggle(c.id)}
                />
              ))}
            </FormCard>
            <p className="ch-form-fixed">{t('unavailable.hint')}</p>
          </>
        ) : null}

        {availableCalendars.length === 0 ? (
          <StateCard title={t('empty.title')} body={t('empty.body')} />
        ) : (
          <>
            <SectionLabel>{t('show')}</SectionLabel>
            <FormCard>
              {availableCalendars.map((c) => (
                <CalendarRow
                  key={c.id}
                  calendar={c}
                  on={sel.selected.has(c.id)}
                  role={roleOf(c.id)}
                  main={sel.labels.get(c.id)?.has('primary') ? categories('primary') : null}
                  busy={busy?.kind === 'switch' && busy.id === c.id}
                  locked={locked}
                  onOpen={() => openCalendar(c.id)}
                  onToggle={() => void toggle(c.id)}
                />
              ))}
            </FormCard>

            <SectionLabel>{t('notes')}</SectionLabel>
            <FormCard>
              <ButtonRow label={t('notes')} value={t('notesCount', { count: noteCount(sel) })} disabled={locked} onClick={openNotes} />
            </FormCard>
            <p className="ch-form-fixed">{t('notesHint')}</p>
          </>
        )}

        {/* The Google account, last: Reconnect Google (a full page load: /refresh-token sits outside [locale] and returns here), then Disconnect Google */}
        <SectionLabel>{t('account.title')}</SectionLabel>
        <FormCard>
          <button type="button" className="ch-form-row ch-action-row" aria-describedby={reconnectHintId} disabled={locked} onClick={reconnect}>
            {t('account.reconnect')}
          </button>
        </FormCard>
        <p id={reconnectHintId} className="ch-form-fixed">
          {t('account.reconnectHint')}
        </p>
        <GoogleDisconnect userId={userId} connected onDisconnected={toCalendars} onSheet={(close) => setGoogleClose(() => close)} />
      </div>

      {/* The status line is a bar fixed to the bottom of the screen (the kit's sticky save-bar container, with no button of its own): a tap anywhere on a long list shows its result */}
      {status ? <div className="ch-save-bar ch-save-bar-sticky">{statusLine()}</div> : null}

      {openCalendarOf ? calendarSheet(openCalendarOf) : null}
      {sheet?.kind === 'notes' ? notesSheet() : null}
    </AppScreen>
  );
}
