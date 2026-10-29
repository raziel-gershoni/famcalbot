'use client';

// The Select calendars screen (the Google calendars a person shows in FamCal), in the home's design (spec 2026-10-19 §4, §5;
// plan W4-2): an AppScreen on the grouped ground, a header with its back, and cards drawn with the form kit (components/app-ui).
//
// - Show in FamCal: one switch row per calendar Google lists (a dot in Google's colour, the name, the description as its hint).
//   A tap saves at once (owner decision 2026-10-28: instant save, with a Saved note and a rollback).
// - Chosen calendars: a list row per chosen calendar (its category, and a tag on the main one). A tap opens its sheet: the
//   main-calendar switch, the category, a note for the AI and, for a spouse calendar, the one set of spouse details.
// - Notes for all calendars: one row (the count) that opens the sheet of up to three notes.
// - A Google account with no calendars shows a state card instead of the sections.
//
// Every save is the whole selection (selection.ts builds the body; the request is POST /api/select-calendars?user_id=… as it has
// always been, with the credential in the X-Telegram-Init-Data header). A tap on a switch applies at once and is undone if the
// save fails; a sheet's Save applies on success only, and a refusal keeps the sheet open with what was typed. The page's status
// line says Saved (or "new events will go to …"), or what went wrong, until the next save.
// - One request at a time (the Calendars screen's pattern): the one that runs shows a spinner and the other controls are off.
//   Every failure is logged and said in the page's language; the server's own text is never shown.
// - Back has one owner, AppScreen (Telegram's BackButton, and the header's own back in a browser). It closes the open sheet,
//   does nothing while a request runs, else returns to the calendar.

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { initDataHeaders } from '@/src/lib/read-init-data';
import { useTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import type { CalendarLabel } from '@/src/types';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { ButtonRow, FORM_CSS, FormCard, RadioCard, RadioPair, SaveBar, SwitchRow, TextField } from '@/components/app-ui/form-kit';
import { ListRow } from '@/components/app-ui/ListRow';
import { Notice } from '@/components/app-ui/Notice';
import { ScreenHeader, SectionLabel } from '@/components/app-ui/ScreenHeader';
import { StateCard } from '@/components/app-ui/StateCard';
import { Tag } from '@/components/app-ui/Tag';
import { isolate } from '../calendars/GoogleCopyRow';
import {
  CATEGORIES, applyCalendar, categoriesOf, categoryOf, noteCount, paddedNotes, saveBody, selectionFrom, toggleShown, withCategory, withNotes, withPrimary,
  type CalendarDraft, type ListedCalendar, type Selection, type SpouseInfo,
} from './selection';

interface SelectCalendarsClientProps {
  userId: number;
  userName: string;
  availableCalendars: ListedCalendar[];
  currentSelections: {
    selectedCalendars: Set<string>;
    calendarLabels: Map<string, Set<CalendarLabel>>;
    spouseInfo: SpouseInfo | null;
    calendarRules: Map<string, string>;
    globalRules: string[];
  };
  locale: string;
  calendarLimit: number; // -1 means unlimited
  /**
   * The name of the user's FamCal calendar that is the default for new events (labelled
   * primary), or null. Ticking primary here moves the default off it, so the page says so.
   */
  famcalPrimaryName?: string | null;
}

const HEX = /^#[0-9a-f]{3,8}$/i;

/** Why a save did not go through. `limit` is the plan's room (the shared calendar total), when the server said it. */
type Failure = 'tooMany' | 'reopen' | 'limit' | 'generic';
interface SaveFailure {
  failure: Failure;
  limit: number | null;
}

/** What a refused save means: the server's code first, then its status. A 401 or 403 is a session that ended. */
function failureOf(status: number, data: { error?: unknown; limit?: unknown } | null): SaveFailure {
  if (data?.error === 'calendar_limit_reached') return typeof data.limit === 'number' ? { failure: 'limit', limit: data.limit } : { failure: 'generic', limit: null };
  if (status === 429) return { failure: 'tooMany', limit: null };
  if (status === 401 || status === 403) return { failure: 'reopen', limit: null };
  return { failure: 'generic', limit: null };
}

/** The line under the intro: what the last save came to. It stays until the next save. */
type Status = { id: number; kind: 'saved' } | { id: number; kind: 'newEvents'; name: string } | { id: number; kind: 'failed'; why: SaveFailure };

type Sheet = { kind: 'calendar'; id: string } | { kind: 'notes' };

/** The one request that runs: a switch's save (which row shows it) or a sheet's. */
type Busy = { kind: 'switch'; id: string } | { kind: 'sheet' };

/** The dot of a calendar's colour, in a row's title. */
function Dot({ colour }: { colour: string }) {
  return <span className="ch-swatch-dot is-lg" style={HEX.test(colour) ? { background: colour } : undefined} aria-hidden="true" />;
}

/** A Google calendar's switch row: the dot and the name, its description under it, the switch at the end. */
function CalendarSwitch({ calendar, on, busy, locked, onToggle }: { calendar: ListedCalendar; on: boolean; busy: boolean; locked: boolean; onToggle: () => void }) {
  const id = useId();
  const nameId = `${id}-name`;
  const hintId = `${id}-hint`;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={nameId}
      aria-describedby={calendar.description ? hintId : undefined}
      aria-busy={busy || undefined}
      disabled={locked}
      className="ch-form-row"
      onClick={onToggle}
    >
      <span className="ch-form-label">
        <span id={nameId} className="ch-list-title">
          <Dot colour={calendar.backgroundColor} />
          <bdi dir="auto">{calendar.name}</bdi>
        </span>
        {calendar.description ? (
          <span id={hintId} className="ch-form-hint">
            <bdi dir="auto">{calendar.description}</bdi>
          </span>
        ) : null}
      </span>
      {busy ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
      <span className={on ? 'ch-switch is-on' : 'ch-switch'} aria-hidden="true" />
    </button>
  );
}

export default function SelectCalendarsClient({ userId, availableCalendars, currentSelections, locale, famcalPrimaryName = null }: SelectCalendarsClientProps) {
  const t = useTranslations('selectCalendars');
  const page = useTranslations('calendarsPage');
  const categories = useTranslations('calendars.categories');
  const ui = useTranslations('ui');
  const router = useRouter();
  const noteHintId = useId();
  const notesHintId = useId();

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
  // A swipe down in a sheet must not minimize the app.
  useTelegramVerticalSwipes(sheet !== null);

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

  /** The whole selection to the server: null when it went through, else why not (a refusal is logged). */
  const post = async (next: Selection): Promise<SaveFailure | null> => {
    const res = await fetch(`/api/select-calendars?user_id=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...initDataHeaders() },
      body: JSON.stringify(saveBody(next, availableCalendars)),
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => null)) as { error?: unknown; limit?: unknown } | null;
    console.error(`[select-calendars] save refused: ${res.status} ${typeof data?.error === 'string' ? data.error : ''}`.trim());
    return failureOf(res.status, data);
  };

  const nameOf = (id: string) => availableCalendars.find((c) => c.id === id)?.name ?? id;

  // ---- A switch: the calendar shown in FamCal, or not ----

  const toggle = (id: string) => {
    if (running.current) return;
    const before = selRef.current;
    const next = toggleShown(before, id);
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
        say({ kind: 'failed', why: { failure: 'generic', limit: null } });
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
      () => setSheetError({ failure: 'generic', limit: null }),
    );

  const saveCalendar = () => {
    if (sheet?.kind !== 'calendar') return;
    const before = selRef.current;
    const tookPrimary = draft.labels.has('primary') && !before.labels.get(sheet.id)?.has('primary');
    return saveSheet(applyCalendar(before, sheet.id, draft), tookPrimary ? nameOf(sheet.id) : null);
  };

  const saveNotes = () => saveSheet(withNotes(selRef.current, notesDraft), null);

  // ---- Back ----

  const back = () => {
    if (running.current) return;
    if (sheet) closeSheet();
    else router.push(`/${locale}/dashboard?user_id=${userId}`);
  };

  // ---- Drawing ----

  const failureText = (e: SaveFailure) => (e.failure === 'limit' ? t('errors.limit', { limit: e.limit ?? 0 }) : e.failure === 'generic' ? t('errors.save') : page(`errors.${e.failure}`));
  const seePlans = { label: page('seePlans'), onClick: () => router.push(`/${locale}/subscription?user_id=${userId}`) };
  const chosen = availableCalendars.filter((c) => sel.selected.has(c.id));

  const statusLine = () => {
    if (!status) return null;
    if (status.kind === 'failed') {
      return (
        <Notice key={status.id} tone="error" action={status.why.failure === 'limit' ? seePlans : undefined}>
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
        {failureText(sheetError)}
      </Notice>
    ) : null;
  const sheetSaveError = () => (sheetError && sheetError.failure !== 'limit' ? failureText(sheetError) : null);

  const chosenRow = (c: ListedCalendar) => {
    const labels = sel.labels.get(c.id);
    const names = categoriesOf(labels).map((k) => categories(k));
    return (
      <ListRow
        key={c.id}
        title={
          <>
            <Dot colour={c.backgroundColor} />
            <bdi dir="auto">{c.name}</bdi>
          </>
        }
        meta={names.length > 0 ? names.join(', ') : t('noCategory')}
        tags={labels?.has('primary') ? <Tag tone="accent">{categories('primary')}</Tag> : undefined}
        disabled={locked}
        onClick={() => openCalendar(c.id)}
      />
    );
  };

  const calendarSheet = (calendar: ListedCalendar) => {
    const primary = draft.labels.has('primary');
    const category = categoryOf(draft.labels);
    const edit = (change: Partial<CalendarDraft>) => setDraft((d) => ({ ...d, ...change }));
    const editSpouse = (change: Partial<CalendarDraft['spouse']>) => setDraft((d) => ({ ...d, spouse: { ...d.spouse, ...change } }));
    return (
      <BottomSheet label={calendar.name} closeLabel={ui('cancel')} closeDisabled={locked} onClose={closeSheet}>
        <div className="ch-sheet-stack is-roomy">
          <h2 className="ch-sheet-heading">
            <bdi dir="auto">{calendar.name}</bdi>
          </h2>

          <FormCard>
            <SwitchRow label={categories('primary')} hint={page('categoryHint.primary')} checked={primary} disabled={locked} onChange={(on) => edit({ labels: withPrimary(draft.labels, on) })} />
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
              <FormCard>
                <TextField label={t('spouseName')} value={draft.spouse.name} onChange={(name) => editSpouse({ name })} placeholder={t('spouseNamePlaceholder')} maxLength={50} disabled={locked} />
                <TextField label={t('spouseEnglishName')} value={draft.spouse.englishName} onChange={(englishName) => editSpouse({ englishName })} placeholder={t('spouseEnglishName')} maxLength={50} disabled={locked} />
              </FormCard>
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
      <ScreenHeader title={t('title')} backLabel={ui('back')} onBack={back} />
      <div className="ch-form-page ch-form-page-grouped">
        <p className="ch-form-fixed">{t('intro')}</p>
        {statusLine()}

        {availableCalendars.length === 0 ? (
          <StateCard title={t('empty.title')} body={t('empty.body')} />
        ) : (
          <>
            <SectionLabel>{t('show')}</SectionLabel>
            <FormCard>
              {availableCalendars.map((c) => (
                <CalendarSwitch
                  key={c.id}
                  calendar={c}
                  on={sel.selected.has(c.id)}
                  busy={busy?.kind === 'switch' && busy.id === c.id}
                  locked={locked}
                  onToggle={() => void toggle(c.id)}
                />
              ))}
            </FormCard>

            {chosen.length > 0 ? (
              <>
                <SectionLabel>{t('chosen')}</SectionLabel>
                <FormCard>{chosen.map(chosenRow)}</FormCard>
                <p className="ch-form-fixed">{t('chosenHint')}</p>
              </>
            ) : null}

            <SectionLabel>{t('notes')}</SectionLabel>
            <FormCard>
              <ButtonRow label={t('notes')} value={t('notesCount', { count: noteCount(sel) })} onClick={openNotes} />
            </FormCard>
            <p className="ch-form-fixed">{t('notesHint')}</p>
          </>
        )}
      </div>

      {openCalendarOf ? calendarSheet(openCalendarOf) : null}
      {sheet?.kind === 'notes' ? notesSheet() : null}
    </AppScreen>
  );
}
