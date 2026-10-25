'use client';

// The editor (home editing spec §2, §4; the mockups' NewEvent, NewReminder and Edit): a
// full-height sheet with Cancel and the title in a header, a scrolling body of grouped
// cards, and a sticky Save bar. One form for a new item and for an edit.
//
// - New: an Event | Reminder switch when both kinds apply; an event has title, location,
//   all day, starts, ends (moving the start keeps the duration), repeat, calendar and
//   notes; a reminder has title, when (a date, and a time with "At a set time"), repeat,
//   and For when the partner can be pinged.
// - Edit: the same fields prefilled from the item's edit info, with the Repeat row (the
//   stored rule selected; a rule the five can't say is a sixth, first choice; an end is
//   kept and named; with the home's Hebrew dates on and a FamCal calendar, also "every year on
//   <Hebrew date>", worded from the stored anchor or the form's start day), the
//   Calendar row (the item's move targets) and, for a reminder's
//   creator, the For row. Where the info doesn't allow a row, its value stays text. What a
//   Save applies to is editor-model's scopePlan: a repeat change is from this occurrence on
//   with no question, a calendar or recipient change on a series asks 'this one and the
//   ones after' or 'all', a day move on a set-weekdays series is this one's, or, when its
//   rule reads as one of the five, from this one on with that rule following the start.
//   A Calendar row pick of the other kind (FamCal and Google) is the cross-source move
//   ("Google as a connection" §5): its row says that alerts and colour follow the new calendar
//   (and that the partner will see it there), Save refuses it beside any other change ("Save
//   the move on its own first."), and a series asks only "All of them". An item that can't
//   cross says why under the row.
// - Cancel asks "Discard your changes?" only when something changed. The container's
//   BackButton calls the same thing through `cancelRef`: it closes a sheet on top first,
//   then cancels.
// - The container owns the request (`onSave`): this sheet validates first (the inline
//   errors, which stay live after the first tap on Save), and shows what the request came
//   to: an error above Save, or nothing, because on success the container closes it. Save
//   is disabled while a request is in flight.
// - Nothing is sent when an edit changed nothing: Save just closes.

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { DEFAULT_REMINDER_TIME } from '@/src/lib/reminder-time';
import {
  allOfThem,
  checkForm,
  crossesKinds,
  dayInZone,
  dayOfMonth,
  hebrewAnchorOf,
  isDirty,
  isHebrewRepeat,
  isNativeCalendar,
  isRealDay,
  moveStart,
  movesDay,
  repeatWords,
  scopePlan,
  setAllDay,
  setKind,
  spanOf,
  storedChoice,
  updateBody,
  weekdayId,
  type EditorForm,
  type FieldErrors,
  type FieldName,
  type RepeatWords,
  type ScopePlan,
} from '@/src/lib/calendar-view/editor-model';
import { minYearFor, MIN_YEAR_BIRTH } from '@/src/lib/calendar-view/year-limits';
import type { WeekStart } from '@/src/lib/calendar-view/types';
import type { EditScope, EditorCalendar, ItemEditInfoResponse, ItemKind, RepeatChoice, RuleChoice } from '@/src/lib/calendar-view/editor-types';
import { formatDayMonth } from '@/src/lib/calendar-view/format';
import { ALERT_LEADS, leadParts, type AlertChoice } from '@/src/lib/calendar-view/alert-leads';
import { BottomSheet } from './BottomSheet';
import { hebrewLabelOf, hebrewRepeatText } from './hebrew-repeat-words';
import { FORM_CSS, FormCard, FormRow, PillRow, preloadPickers, RadioPair, SaveBar, Segmented, SwitchRow, TextField, ValueRow, type SelectOption } from './form-kit';
import { ConfirmSheet, ScopeSheet, useErrorText, type SubmitError } from './ScopeSheet';

/** What the container's request came to. On `ok` the container closes the editor. */
export type SaveOutcome =
  | { kind: 'ok' }
  | { kind: 'error'; error: SubmitError; field?: FieldName; move?: MoveNote; fieldError?: 'errSeriesYear' };

/** A move to the other kind of calendar the server refused: saved with other changes, or what can't cross ("Google as a connection" §5). */
export type MoveNote = 'moveAlone' | 'moveMeet' | 'moveHebrew' | 'moveRepeat';

export interface EditorSheetProps {
  mode: 'create' | 'edit';
  initial: EditorForm;
  /** The kinds that apply (new), the writable calendars (new, and the names of an edit's move targets) and the partner. */
  kinds?: { event: boolean; reminder: boolean };
  calendars?: EditorCalendar[];
  partner?: { name: string; canRemind: boolean } | null;
  /** The home shows Hebrew dates: with a FamCal calendar, the Repeat row offers the Hebrew choice (hebrew-repeats spec §4). */
  hebrewDates?: boolean;
  /** The user's reminder time (HH:mm), which a date-only reminder pings at; 09:00 until the editor info arrives. */
  reminderTime?: string;
  /** An alert can reach the user (EditorInfoResponse.alertsOn): the Alert row shows only then. */
  alertsOn?: boolean;
  /** The user's default lead in minutes, which the Alert row's "Default" names. */
  defaultLead?: number;
  /** The server's today and the week's first day, for the date sheet. */
  today?: string;
  weekStart?: WeekStart;
  /** A date or time sheet opened or closed: the container locks Telegram's vertical swipes while one is open. */
  onPickerChange?: (open: boolean) => void;
  /** Edit: the item's edit info and key. */
  info?: ItemEditInfoResponse;
  itemKey?: string;
  onSave: (form: EditorForm, scope: EditScope) => Promise<SaveOutcome>;
  /** Closes the editor, with no save. */
  onClose: () => void;
  /** The container's BackButton asks the editor to cancel through this. */
  cancelRef: MutableRefObject<(() => void) | null>;
}

/** The copy of each inline note under the Save button. */
const INLINE_NOTE_KEY = {
  dayMove: 'scope.dayMoveNote',
  dayMoveAlone: 'editor.dayMoveAlone',
  moveAlone: 'editor.moveAlone',
  moveMeet: 'editor.move.reasons.meet',
  moveHebrew: 'editor.move.reasons.hebrew',
  moveRepeat: 'editor.move.reasons.repeat',
} as const;
type InlineNote = keyof typeof INLINE_NOTE_KEY;

const REPEATS: RepeatChoice[] = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

export function EditorSheet({ mode, initial, kinds, calendars = [], partner, hebrewDates = false, reminderTime = DEFAULT_REMINDER_TIME, alertsOn = false, defaultLead = 0, today = '', weekStart = 0, onPickerChange, info, itemKey, onSave, onClose, cancelRef }: EditorSheetProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const [start] = useState(initial);
  const [form, setForm] = useState<EditorForm>(initial);
  const [showErrors, setShowErrors] = useState(false);
  /** A field the server refused, and what its row says (errField unless the server named why). */
  const [serverField, setServerField] = useState<{ field: FieldName; key: 'errField' | 'errSeriesYear' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SubmitError | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  /** The date or time sheet that is open, and for which row: it closes before the scope sheet and the editor do. */
  const [picker, setPicker] = useState<{ row: 'start' | 'end'; which: 'date' | 'time' } | null>(null);
  const pickerIsOpen = picker !== null;
  // The first tap on a pill finds the sheets already loaded.
  useEffect(() => {
    preloadPickers();
  }, []);
  useEffect(() => {
    onPickerChange?.(pickerIsOpen);
    return () => onPickerChange?.(false);
  }, [pickerIsOpen, onPickerChange]);
  /** The inline line Save shows when it can't save as it is (a day move beside a calendar or recipient change). */
  const [inlineNote, setInlineNote] = useState<InlineNote | null>(null);
  const errorText = useErrorText(error);
  /** The last real start day: the repeat choices keep their words while a date is being typed. */
  const [lastDay, setLastDay] = useState(isRealDay(initial.startDay, MIN_YEAR_BIRTH) ? initial.startDay : '');
  if (isRealDay(form.startDay, MIN_YEAR_BIRTH) && form.startDay !== lastDay) setLastDay(form.startDay);
  /** The last real length: what a start typed through years that aren't real moves the end by. */
  const [heldSpan, setHeldSpan] = useState(() => spanOf(initial));
  const span = spanOf(form);
  if (span && (span.allDay !== heldSpan?.allDay || span.size !== heldSpan.size)) setHeldSpan(span);

  const edit = mode === 'edit';
  const reminder = form.kind === 'reminder';
  const errors: FieldErrors = showErrors ? checkForm(form) : {};
  if (serverField && !errors[serverField.field]) errors[serverField.field] = serverField.key;
  const errorOf = (field: FieldName): string | null => {
    const key = errors[field];
    return key ? t(`editor.errors.${key}`, { max: field === 'title' ? 200 : field === 'location' ? 200 : 2000 }) : null;
  };

  const change = (next: EditorForm) => {
    setForm(next);
    setError(null);
    setServerField(null);
    setInlineNote(null);
  };

  // Cancel: a sheet on top closes first, then the editor, asking only when something changed.
  const cancel = () => {
    if (saving) return;
    if (picker) setPicker(null);
    else if (scopeOpen) setScopeOpen(false);
    else if (discardOpen) setDiscardOpen(false);
    else if (isDirty(form, start)) setDiscardOpen(true);
    else onClose();
  };
  const cancelNow = useRef(cancel);
  useEffect(() => {
    cancelNow.current = cancel;
  });
  useEffect(() => {
    const ref = cancelRef;
    ref.current = () => cancelNow.current();
    return () => {
      ref.current = null;
    };
  }, [cancelRef]);

  const run = async (scope: EditScope) => {
    setSaving(true);
    setError(null);
    const outcome = await onSave(form, scope);
    setSaving(false);
    if (outcome.kind === 'error') {
      setScopeOpen(false);
      // The series would start outside its years: the start row says so (no day note, no "Couldn't save").
      if (outcome.fieldError) {
        setServerField({ field: outcome.field ?? 'start', key: outcome.fieldError });
        return;
      }
      // A refused day move for more than this one: the rule fixes the days (it changed after
      // the sheet opened, so the choices offered it), and retrying would fail the same way.
      if (edit && info && outcome.field === 'start' && scope !== 'single' && movesDay(form, start, info.tz, info.series.zone)) setInlineNote('dayMove');
      else if (outcome.move) setInlineNote(outcome.move);
      else setError(outcome.error);
      if (outcome.field) setServerField({ field: outcome.field, key: 'errField' });
    }
  };
  const save = () => {
    if (saving) return;
    setShowErrors(true);
    if (Object.keys(checkForm(form)).length > 0) return;
    if (!edit) {
      void run('single');
      return;
    }
    if (!itemKey || !info || updateBody(form, start, itemKey, 'single') === null) {
      onClose();
      return;
    }
    const decided: ScopePlan = scopePlan(form, start, info);
    if (decided.kind === 'refuse') setInlineNote(decided.note);
    else if (decided.kind === 'sheet') setScopeOpen(true);
    else void run(decided.kind === 'following' ? 'following' : 'single');
  };
  const plan: ScopePlan | null = edit && info ? scopePlan(form, start, info) : null;

  // The repeat choices, worded for the start day. On an edit the stored rule is selected; one
  // the five can't say is a first choice of its own, and a stored end is named on every choice
  // (picking another of the five keeps it, 3b spec §2.1).
  const day = lastDay;
  const weekday = weekdayId(day);
  const stored: RuleChoice = edit && info ? storedChoice(info) : 'none';
  const untilDay = edit && info ? (info.series.rule?.until ?? null) : null;
  /** The Hebrew date of a day, in the language's own form (gematriya in Hebrew); Russian reads its month genitives. */
  const hebrewLabel = (d: string): string => hebrewLabelOf(t, locale, d);
  const wordsOf = (w: RepeatWords): string | null => {
    switch (w.key) {
      case 'daily':
        return t('scope.everyDay');
      case 'weekday':
        return t('scope.everyWeekday', { weekday: w.weekday });
      case 'interval':
        return t(`editor.repeat.every.${w.unit}`, { count: w.count });
      case 'weekly':
        return t('editor.repeat.weeklyPlain');
      case 'monthly':
        return t('editor.repeat.monthlyPlain');
      case 'yearly':
        return t('editor.repeat.yearlyPlain');
      case 'hebrewEvery':
        return hebrewRepeatText(t, locale, w);
      default:
        return null;
    }
  };
  // The Hebrew choice (hebrew-repeats spec §4): offered with Hebrew dates and a FamCal calendar
  // (a reminder is always FamCal's); an item that already has one shows its words to anyone.
  const famcalTarget = edit ? info?.source !== 'google' : reminder || isNativeCalendar(form.calendarId);
  const hebrewOffered = hebrewDates && famcalTarget;
  /** Where a new part would be anchored: the form's start day, in the series' zone on an edit. */
  const startDayInZone = edit && info && day ? dayInZone(day, form.allDay ? '00:00' : form.startTime, info.tz, info.series.zone) : day;
  const storedAnchor = edit && info ? hebrewAnchorOf(info) : null;
  const dayMoved = edit && info ? movesDay(form, start, info.tz, info.series.zone) : false;
  /** The Hebrew choice's words: the stored anchor's date (never the opened occurrence's, which may be a rolled day) unless the start moved, else the start's. */
  const hebrewChoiceText = (): string => {
    const anchorDay = storedAnchor && (stored === 'hebrew' || !dayMoved) ? storedAnchor : startDayInZone;
    const when = hebrewLabel(anchorDay);
    return when ? t('editor.repeat.hebrew', { date: when }) : t('editor.repeat.hebrewPlain');
  };
  const date = day ? formatDayMonth(day, locale) : '';
  const dom = dayOfMonth(day) ?? 1;
  const until = untilDay ? formatDayMonth(untilDay, locale) : null;
  const withEnd = (text: string) => (until ? t('editor.repeat.until', { rule: text, date: until }) : text);
  const choiceText = (r: RepeatChoice): string => {
    if (r === 'none') return t('editor.repeat.none');
    if (r === 'daily') return t('editor.repeat.daily');
    if (r === 'weekly') return weekday ? t('editor.repeat.weekly', { weekday }) : t('editor.repeat.weeklyPlain');
    if (r === 'monthly') return day ? t('editor.repeat.monthly', { day: dom }) : t('editor.repeat.monthlyPlain');
    if (r === 'hebrew') return hebrewChoiceText();
    return day ? t('editor.repeat.yearly', { date }) : t('editor.repeat.yearlyPlain');
  };
  const choices: RepeatChoice[] = hebrewOffered ? [...REPEATS, 'hebrew'] : isHebrewRepeat(stored) ? [...REPEATS, stored] : REPEATS;
  const repeatOptions: SelectOption[] = choices.map((r): SelectOption => {
    if (r === 'none' || !until) return { value: r, text: choiceText(r) };
    const ended = withEnd(choiceText(r));
    return { value: r, text: stored === r ? t('editor.repeat.current', { words: ended }) : ended };
  });
  if (stored === 'custom' && info) {
    const own = info.series.rule?.words ?? wordsOf(repeatWords(info.series.repeat, info.series.start));
    repeatOptions.unshift({ value: 'custom', text: own === null ? t('editor.repeat.currentPlain') : t('editor.repeat.current', { words: withEnd(own) }) });
  }
  /** Under the Repeat row, once the rule is changed from a later occurrence: the earlier ones keep theirs. */
  const fromHereHint =
    edit && info && info.series.recurring && info.series.first === false && form.repeat !== 'custom' && form.repeat !== start.repeat
      ? t('editor.repeat.fromHere', { date: formatDayMonth(info.occurrence.start.slice(0, 10), locale) })
      : undefined;
  /** Under the Hebrew yearly choice: the count of years starts from the date entered, so it should be the original one. */
  const countHint = form.repeat === 'hebrew' ? t('editor.repeat.hebrewCountHint') : undefined;
  const repeatHint = [fromHereHint, countHint].filter(Boolean).join(' ') || undefined;

  const toOption = (c: EditorCalendar): SelectOption => ({
    value: c.id,
    text: c.mine || !c.ownerName ? c.name : t('editor.partnerCalendar', { calendar: c.name, name: c.ownerName }),
    color: c.color,
  });
  const calendarOptions: SelectOption[] = calendars.map(toOption);
  /** An edit's Calendar row: the calendars the item may be on, its own included; fewer than two and it stays text. */
  const moveOptions: SelectOption[] =
    edit && info?.canMoveCalendar && info.moveTargets
      ? info.moveTargets.flatMap((id) => {
          const c = calendars.find((x) => x.id === id);
          return c ? [toOption(c)] : [];
        })
      : [];

  const kindOptions: { value: ItemKind; text: string }[] = [
    { value: 'event', text: t('editor.kind.event') },
    { value: 'reminder', text: t('editor.kind.reminder') },
  ];
  const showKindSwitch = !edit && !!kinds && kinds.event && kinds.reminder;
  const canPartner = !edit && reminder && !!partner && partner.canRemind;
  /** An edit's For row, for the reminder's creator: Me | the partner (by the name the info or the editor gave). */
  const partnerName = edit && reminder && info?.canChangeRecipient ? (info.forName ?? partner?.name ?? null) : null;
  const showCalendarRow = !reminder && (edit ? moveOptions.length > 1 : calendarOptions.length > 0);
  // The move to the other kind of calendar ("Google as a connection" §5): picked, its row says
  // what follows the new calendar (and that the partner will see it, on a calendar they see);
  // not possible, it says why.
  const crossPicked = edit && crossesKinds(form, start);
  const moveReasonText = edit && info?.moveReason ? t(`editor.move.reasons.${info.moveReason}`) : null;
  const calendarHint = crossPicked
    ? [form.calendarId && info?.sharedTargets?.includes(form.calendarId) ? t('editor.move.partnerSees') : null, t('editor.move.alertsFollow')].filter(Boolean).join(' · ')
    : (moveReasonText ?? undefined);
  // The Alert row (editor upgrades spec §2): a timed event, when an alert can reach the user. A Google
  // event's own alert, or a new event on a Google calendar (it gets the default), is shown and not edited.
  const leadWords = (minutes: number, inline: boolean): string =>
    minutes === 0 ? t(inline ? 'editor.alert.atStartInline' : 'editor.alert.atStart') : t('editor.alert.before', leadParts(minutes));
  const choiceKey = (choice: AlertChoice): string => String(choice);
  const alertOptions: SelectOption[] = [
    { value: 'default', text: t('editor.alert.default', { lead: leadWords(defaultLead, true) }) },
    { value: 'none', text: t('editor.alert.none') },
    // A lead stored off the list (a migrated one) is its own option, kept until another is picked.
    ...[...ALERT_LEADS, ...(typeof form.alert === 'number' && !ALERT_LEADS.includes(form.alert) ? [form.alert] : [])].map((m) => ({ value: String(m), text: leadWords(m, false) })),
  ];
  const showAlertRow = alertsOn && !form.allDay; // the row sits in the event's card: a reminder has none
  const alertReadOnly = edit ? info?.alertReadOnly === true : !isNativeCalendar(form.calendarId);
  const readOnlyAlertText =
    edit && typeof form.alert === 'number'
      ? t('editor.alert.fromGoogle', { lead: leadWords(form.alert, true) })
      : t('editor.alert.default', { lead: leadWords(defaultLead, true) });
  const alertRow = !showAlertRow ? null : alertReadOnly ? (
    <FormRow label={t('editor.alert.label')}>
      <span className="ch-form-value">
        <span className="ch-form-value-text" dir="auto">
          {readOnlyAlertText}
        </span>
      </span>
    </FormRow>
  ) : (
    <ValueRow
      label={t('editor.alert.label')}
      value={choiceKey(form.alert)}
      options={alertOptions}
      onChange={(v) => change({ ...form, alert: v === 'default' || v === 'none' ? v : Number(v) })}
      error={errorOf('alert')}
    />
  );
  const heading = edit ? t('editor.titleEdit') : t('editor.titleNew');
  /** What a PillRow needs of the date sheet; a Hebrew yearly repeat opens it in Hebrew. */
  const pickerProps = {
    mode: form.repeat === 'hebrew' ? ('hebrew' as const) : ('gregorian' as const),
    minYear: minYearFor(form.repeat),
    hebrewDates,
    today,
    weekStart,
  };
  const rowPicker = (row: 'start' | 'end') => ({
    open: picker?.row === row ? picker.which : null,
    onOpen: (which: 'date' | 'time' | null) => setPicker(which ? { row, which } : null),
  });

  return (
    <>
      <BottomSheet label={heading} closeLabel={t('editor.cancel')} onClose={cancel} variant="full">
        <style>{FORM_CSS}</style>
        <header className="ch-editor-head">
          <button type="button" className="ch-editor-cancel" onClick={cancel}>
            {t('editor.cancel')}
          </button>
          <h1 className="ch-editor-title">{heading}</h1>
          <span aria-hidden="true" />
        </header>
        <div className="ch-editor-body">
          <div className="ch-form-page">
            {showKindSwitch ? <Segmented label={t('editor.kind.label')} value={form.kind} options={kindOptions} onChange={(kind) => change(setKind(form, kind))} /> : null}

            <FormCard>
              <TextField label={t('editor.fields.title')} value={form.title} large onChange={(title) => change({ ...form, title })} error={errorOf('title')} />
              {reminder ? null : <TextField label={t('editor.fields.location')} placeholder={t('editor.fields.location')} value={form.location} onChange={(location) => change({ ...form, location })} error={errorOf('location')} />}
            </FormCard>

            {reminder ? (
              <FormCard>
                <PillRow
                  label={t('editor.when')}
                  dateLabel={t('editor.whenDate')}
                  timeLabel={t('editor.whenTime')}
                  day={form.startDay}
                  time={form.startTime}
                  showTime={!form.allDay}
                  onDay={(startDay) => change(moveStart(form, { startDay }, heldSpan))}
                  onTime={(startTime) => change(moveStart(form, { startTime }, heldSpan))}
                  error={errorOf('start')}
                  {...pickerProps}
                  {...rowPicker('start')}
                />
                <SwitchRow label={t('editor.atTime')} hint={t('editor.atTimeHint', { time: reminderTime })} checked={!form.allDay} onChange={(on) => change(setAllDay(form, !on))} />
                <ValueRow label={t('editor.repeat.label')} hint={repeatHint} value={form.repeat} options={repeatOptions} onChange={(repeat) => change({ ...form, repeat: repeat as RuleChoice })} />
              </FormCard>
            ) : (
              <FormCard>
                <SwitchRow label={t('editor.allDay')} checked={form.allDay} onChange={(on) => change(setAllDay(form, on))} />
                <PillRow
                  label={t('editor.starts')}
                  dateLabel={t('editor.startsDate')}
                  timeLabel={t('editor.startsTime')}
                  day={form.startDay}
                  time={form.startTime}
                  showTime={!form.allDay}
                  onDay={(startDay) => change(moveStart(form, { startDay }, heldSpan))}
                  onTime={(startTime) => change(moveStart(form, { startTime }, heldSpan))}
                  error={errorOf('start')}
                  {...pickerProps}
                  {...rowPicker('start')}
                />
                <PillRow
                  label={t('editor.ends')}
                  dateLabel={t('editor.endsDate')}
                  timeLabel={t('editor.endsTime')}
                  day={form.endDay}
                  time={form.endTime}
                  showTime={!form.allDay}
                  onDay={(endDay) => change({ ...form, endDay })}
                  onTime={(endTime) => change({ ...form, endTime })}
                  error={errorOf('end')}
                  {...pickerProps}
                  // An end is never before its start.
                  min={form.startDay}
                  {...rowPicker('end')}
                />
                <ValueRow label={t('editor.repeat.label')} hint={repeatHint} value={form.repeat} options={repeatOptions} onChange={(repeat) => change({ ...form, repeat: repeat as RuleChoice })} />
                {alertRow}
              </FormCard>
            )}

            {showCalendarRow ? (
              <FormCard>
                <ValueRow
                  label={t('editor.calendar')}
                  hint={calendarHint}
                  value={form.calendarId ?? (edit ? moveOptions : calendarOptions)[0].value}
                  options={edit ? moveOptions : calendarOptions}
                  // A Google calendar can't hold a Hebrew-date repeat: the pick falls back to the Gregorian yearly one.
                  onChange={(calendarId) => change({ ...form, calendarId, repeat: isHebrewRepeat(form.repeat) && !calendarId.startsWith('native:') ? 'yearly' : form.repeat })}
                />
              </FormCard>
            ) : null}

            {partnerName !== null ? (
              <RadioPair
                label={t('editor.forLabel')}
                value={form.forPartner ? 'partner' : 'me'}
                options={[
                  { value: 'me', text: t('editor.forMe') },
                  { value: 'partner', text: partnerName },
                ]}
                onChange={(who) => change({ ...form, forPartner: who === 'partner' })}
              />
            ) : null}

            {canPartner && partner ? (
              <RadioPair
                label={t('editor.forLabel')}
                value={form.forPartner ? 'partner' : 'me'}
                options={[
                  { value: 'me', text: t('editor.forMe') },
                  { value: 'partner', text: partner.name },
                ]}
                onChange={(who) => change({ ...form, forPartner: who === 'partner' })}
              />
            ) : null}

            {reminder ? null : (
              <FormCard>
                <TextField label={t('editor.fields.notes')} placeholder={t('editor.fields.notes')} value={form.notes} multiline onChange={(notes) => change({ ...form, notes })} error={errorOf('notes')} />
              </FormCard>
            )}

            {edit && info && info.calendar.name && !reminder && !showCalendarRow ? (
              <p className="ch-form-fixed" dir="auto">
                {info.calendar.name}
              </p>
            ) : null}
            {moveReasonText && !reminder && !showCalendarRow ? <p className="ch-form-fixed">{moveReasonText}</p> : null}
            {edit && info?.forName && partnerName === null ? <p className="ch-form-fixed">{t('editor.forName', { name: info.forName })}</p> : null}
          </div>
        </div>
        <SaveBar label={t('editor.save')} busy={saving} error={errorText ?? (inlineNote ? t(INLINE_NOTE_KEY[inlineNote]) : null)} onSave={save} />
      </BottomSheet>
      {scopeOpen && info && itemKey ? (
        <ScopeSheet
          kind={info.kind}
          mode="save"
          title={form.title.trim() || info.occurrence.title}
          day={info.occurrence.start.slice(0, 10)}
          all={allOfThem(info.series.repeat, info.series.start)}
          {...(plan?.kind === 'sheet' ? { choices: plan.choices, ...(plan.note ? { note: plan.note } : {}) } : {})}
          busy={saving}
          error={error}
          onPick={(scope) => void run(scope)}
          onClose={() => setScopeOpen(false)}
        />
      ) : null}
      {discardOpen ? (
        <ConfirmSheet
          heading={t('editor.discard.title')}
          confirmLabel={t('editor.discard.confirm')}
          cancelLabel={t('editor.discard.keep')}
          danger
          busy={false}
          error={null}
          onConfirm={onClose}
          onClose={() => setDiscardOpen(false)}
        />
      ) : null}
    </>
  );
}
