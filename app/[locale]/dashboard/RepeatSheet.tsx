'use client';

// The Repeat sheet (editor upgrades spec §3, ruling 9): the Repeat row opens it, over the editor.
// A summary on top (also the row's value), then cards: the frequency (Never, Daily, Weekly,
// Monthly, Yearly, and the Hebrew date where the editor offers it; a stored rule the sheet
// can't say is a first, selected choice, "Current: <words>"), "Every [-] N [+] days" (hidden
// for Never), the weekday chips for Weekly (the week-start order; the start's day is on and
// can't be turned off), the monthly options (the day, the n-th weekday, the last one when the
// start is in its month's last seven days) and the end (Never, On <date>, After N times).
//
// Changes go to a draft: Done applies it and closes, Cancel, Escape and the BackButton close
// without it (the editor's cancel chain closes this sheet first, it owns no BackButton). The
// model is repeat-model.ts (pure); the words are repeat-words.ts. The date of "On <date>" is
// the part-1 date sheet through PillRow, whose open state the editor owns.

import { useId, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { REPEAT_COUNT_MAX, REPEAT_INTERVAL_MAX, type RepeatSpec } from '@/src/lib/calendar-view/editor-types';
import {
  codeOfDay,
  endKindOf,
  formRepeat,
  idOfCode,
  isHebrewForm,
  isSpec,
  monthlyOptions,
  pickFrequency,
  sameRepeat,
  toggleDay,
  weekOrder,
  withCount,
  withEnd,
  withInterval,
  withMonthly,
  withUntil,
  type CustomSeed,
  type EndKind,
  type RepeatForm,
  type RepeatFreq,
} from '@/src/lib/calendar-view/repeat-model';
import type { PickerMode } from '@/src/lib/calendar-view/picker-model';
import type { WeekStart } from '@/src/lib/calendar-view/types';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { FORM_CSS, FormCard, RadioCard, SaveBar, Segmented, StepperRow } from '@/components/app-ui/form-kit';
import { EDITOR_FORM_CSS, PillRow } from './form-kit';
import { monthOnNthText, repeatFormText, type WordsContext } from './repeat-words';

export const REPEAT_CSS = `
.ch-repeat-summary {
  margin: 0;
  padding: 4px 4px 2px;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.ch-days {
  display: flex;
  gap: 2px;
  padding: 4px;
}
.ch-day {
  flex: 1;
  min-inline-size: 0;
  min-block-size: 44px;
  padding: 0;
  border: 1.5px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--ch-text);
  font: inherit;
  font-size: 15px;
  cursor: pointer;
  touch-action: manipulation;
}
.ch-day[aria-pressed='true'] {
  border-color: var(--ch-button);
  background: var(--ch-mine-soft);
  color: var(--ch-mine-soft-text);
  font-weight: 600;
}
.ch-day[aria-disabled='true'] {
  cursor: default;
  opacity: 0.75;
}
.ch-day:focus-visible {
  outline: 2px solid var(--ch-accent);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: no-preference) {
  .ch-day {
    transition: background-color 120ms ease-out, border-color 120ms ease-out;
  }
}
`;

export interface RepeatSheetProps {
  /** The form's repeat when the sheet opened. */
  value: RepeatForm;
  /** The start's day (yyyy-MM-dd): the chips' pinned day, the monthly options, the first day of "On <date>". */
  startDay: string;
  weekStart: WeekStart;
  /** The Hebrew-date frequency is offered (with Hebrew dates on and a FamCal calendar). */
  hebrewOffered: boolean;
  /** A stored rule the sheet can't say: the first choice ("Current: <words>") and what the summary says for it. */
  custom: { choice: string; summary: string } | null;
  /** What the words are said against (the start, the week's first day, a Hebrew repeat's anchor). */
  words: WordsContext;
  /** The date sheet of "On <date>": which is open, owned by the editor. */
  picker: 'date' | 'time' | null;
  onPicker: (open: 'date' | 'time' | null) => void;
  pickerProps: { mode: PickerMode; minYear: number; hebrewDates: boolean; today: string; weekStart: WeekStart };
  /** What leaving a rule the sheet can't say carries into the spec that replaces it. */
  customSeed?: CustomSeed;
  onApply: (next: RepeatForm) => void;
  onClose: () => void;
}

const FREQS: RepeatFreq[] = ['daily', 'weekly', 'monthly', 'yearly'];

export function RepeatSheet({ value, startDay, weekStart, hebrewOffered, custom, customSeed, words, picker, onPicker, pickerProps, onApply, onClose }: RepeatSheetProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const hintId = useId();
  const [draft, setDraft] = useState<RepeatForm>(() => formRepeat(value, startDay));
  const spec: RepeatSpec | null = isSpec(draft) ? draft : null;
  const own = codeOfDay(startDay);

  const summary = draft === 'custom' && custom ? custom.summary : repeatFormText(t, locale, draft, words);
  const frequencies: { value: string; text: string }[] = [
    ...(custom ? [{ value: 'custom', text: custom.choice }] : []),
    { value: 'none', text: t('editor.repeat.freq.none') },
    ...FREQS.map((f) => ({ value: f, text: t(`editor.repeat.freq.${f}`) })),
    // The Hebrew date is offered where the editor offers it, and to a repeat that already is one.
    ...(hebrewOffered || isHebrewForm(value) || spec?.freq === 'hebrew' ? [{ value: 'hebrew', text: t('editor.repeat.freq.hebrew') }] : []),
  ];
  const chosen = draft === 'none' || draft === 'custom' ? draft : draft.freq;
  const pickFreq = (v: string) => {
    if (v === 'custom') setDraft('custom');
    else setDraft(pickFrequency(draft, v as RepeatFreq | 'none', startDay, customSeed));
  };

  const edit = (next: RepeatSpec) => setDraft(next);
  const unitFreq = spec ? (spec.freq === 'hebrew' ? 'yearly' : spec.freq) : 'daily';
  const options = monthlyOptions(startDay);
  const monthly: { value: string; text: string }[] =
    spec?.freq === 'monthly' && options && own
      ? [
          { value: 'day', text: t('editor.repeat.monthOnDay', { day: Number(startDay.slice(8, 10)) }) },
          { value: 'weekday', text: monthOnNthText(t, options.ordinal, idOfCode(own)) },
          ...(options.last ? [{ value: 'last', text: monthOnNthText(t, 'last', idOfCode(own)) }] : []),
        ]
      : [];
  const endKind: EndKind = spec ? endKindOf(spec) : 'never';
  const endOptions: { value: EndKind; text: string }[] = [
    { value: 'never', text: t('editor.repeat.endsNever') },
    { value: 'until', text: t('editor.repeat.endsOn') },
    { value: 'count', text: t('editor.repeat.endsAfter') },
  ];

  return (
    <BottomSheet label={t('editor.repeat.label')} closeLabel={t('editor.cancel')} onClose={onClose} variant="full">
      <style>{FORM_CSS}</style>
      <style>{EDITOR_FORM_CSS}</style>
      <style>{REPEAT_CSS}</style>
      <header className="ch-editor-head">
        <button type="button" className="ch-editor-cancel" onClick={onClose}>
          {t('editor.cancel')}
        </button>
        <h1 className="ch-editor-title">{t('editor.repeat.label')}</h1>
        <span aria-hidden="true" />
      </header>
      <div className="ch-editor-body">
        <div className="ch-form-page">
          <p className="ch-repeat-summary" dir="auto" aria-live="polite" data-repeat-summary="">
            {summary}
          </p>

          <RadioCard label={t('editor.repeat.frequencyLabel')} value={chosen} options={frequencies} onChange={pickFreq} />

          {spec ? (
            <FormCard>
              <StepperRow
                label={t('editor.repeat.everyLabel')}
                unit={t(`editor.repeat.unit.${unitFreq}`, { count: spec.interval })}
                value={spec.interval}
                min={1}
                max={REPEAT_INTERVAL_MAX}
                decLabel={t('editor.repeat.fewer')}
                incLabel={t('editor.repeat.more')}
                onChange={(n) => edit(withInterval(spec, n))}
              />
            </FormCard>
          ) : null}

          {spec?.freq === 'weekly' ? (
            <>
              <div className="ch-form-card">
                <div className="ch-days" role="group" aria-label={t('editor.repeat.daysLabel')}>
                  {weekOrder(weekStart).map((code) => {
                    const pinned = code === own;
                    const on = pinned || (spec.byDay ?? []).includes(code);
                    return (
                      <button
                        key={code}
                        type="button"
                        className="ch-day"
                        data-day={code}
                        aria-pressed={on}
                        aria-disabled={pinned || undefined}
                        aria-describedby={pinned ? hintId : undefined}
                        aria-label={t('editor.repeat.dayLong', { weekday: idOfCode(code) })}
                        onClick={() => {
                          if (!pinned) edit(toggleDay(spec, code, startDay));
                        }}
                      >
                        {t('editor.repeat.dayShort', { weekday: idOfCode(code) })}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p id={hintId} className="ch-form-fixed">
                {t('editor.repeat.startDayKept')}
              </p>
            </>
          ) : null}

          {monthly.length > 0 && spec ? <RadioCard label={t('editor.repeat.monthlyLabel')} value={spec.monthly ?? 'day'} options={monthly} onChange={(m) => edit(withMonthly(spec, m as NonNullable<RepeatSpec['monthly']>))} /> : null}

          {spec ? (
            <>
              <Segmented label={t('editor.repeat.endsLabel')} value={endKind} options={endOptions} onChange={(kind) => edit(withEnd(spec, kind, startDay))} />
              {endKind === 'until' ? (
                <FormCard>
                  <PillRow
                    label={t('editor.repeat.endsOnRow')}
                    dateLabel={t('editor.repeat.endsDate')}
                    timeLabel={t('editor.repeat.endsDate')}
                    day={spec.until ?? ''}
                    time=""
                    showTime={false}
                    onDay={(until) => edit(withUntil(spec, until))}
                    onTime={() => undefined}
                    {...pickerProps}
                    mode={spec.freq === 'hebrew' ? 'hebrew' : 'gregorian'}
                    min={startDay}
                    open={picker}
                    onOpen={onPicker}
                  />
                </FormCard>
              ) : null}
              {endKind === 'count' ? (
                <FormCard>
                  <StepperRow
                    label={t('editor.repeat.afterLabel')}
                    unit={t('editor.repeat.timesUnit', { count: spec.count ?? 1 })}
                    value={spec.count ?? 1}
                    min={1}
                    max={REPEAT_COUNT_MAX}
                    decLabel={t('editor.repeat.fewer')}
                    incLabel={t('editor.repeat.more')}
                    onChange={(n) => edit(withCount(spec, n))}
                  />
                </FormCard>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      <SaveBar label={t('editor.repeat.done')} busy={false} error={null} onSave={() => onApply(sameRepeat(draft, value, startDay) ? value : formRepeat(draft, startDay))} />
    </BottomSheet>
  );
}
