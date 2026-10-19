'use client';

// The small sheets of editing (home editing spec §2): which occurrences a change or a
// delete applies to, for a repeating item (ScopeSheet, the mockups' "This event repeats"),
// and a yes-or-no (ConfirmSheet): "Delete «title»?" for a single item, and "Discard your
// changes?" when the editor is cancelled after an edit.
//
// Both are BottomSheets: the Cancel button is the sheet's own Close, with the Cancel text.
// The container (the editor or the home) owns the request and the BackButton; these only
// draw. While a request is in flight every button is disabled, and an error that came
// back shows above the buttons. The title in the copy is the item's own, in a bdi. A
// change that moves the day of a series whose rule fixes its days (the bot's "every
// Tuesday") can apply to this one alone: the sheet offers only that, and says why.

import { useLocale, useTranslations } from 'next-intl';
import type { EditScope, ItemKind } from '@/src/lib/calendar-view/editor-types';
import type { allOfThem } from '@/src/lib/calendar-view/editor-model';
import { formatDayShort } from '@/src/lib/calendar-view/format';
import { BottomSheet } from './BottomSheet';
import { FORM_CSS } from './form-kit';

export type SubmitError = 'notAllowed' | 'changed' | 'failed' | 'busy';

/** The error line for an outcome (calendarHome.editor.err*). */
export function useErrorText(error: SubmitError | null): string | null {
  const t = useTranslations('calendarHome');
  if (!error) return null;
  return t(`editor.submitErrors.${error}`);
}

export interface ScopeSheetProps {
  kind: ItemKind;
  /** Save a change, or delete. */
  mode: 'save' | 'delete';
  title: string;
  /** The occurrence's day (yyyy-MM-dd), for "Only this one (Tue 20 Oct)". */
  day: string;
  /** What "all of them" is called: every day, every <weekday>, or all of them. */
  all: ReturnType<typeof allOfThem>;
  /** Only "Only this one", with a line on how to move them all: a day move on a rule with fixed days. */
  singleOnly?: boolean;
  busy: boolean;
  error: SubmitError | null;
  onPick: (scope: EditScope) => void;
  onClose: () => void;
}

export function ScopeSheet({ kind, mode, title, day, all, singleOnly = false, busy, error, onPick, onClose }: ScopeSheetProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const errorText = useErrorText(error);
  const heading = t(`scope.${mode}.${kind}`);
  const allText = all.key === 'weekday' ? t('scope.everyWeekday', { weekday: all.weekday }) : all.key === 'daily' ? t('scope.everyDay') : t('scope.all');
  const choices: [EditScope, string][] = [['single', t('scope.single', { date: formatDayShort(day, locale) })]];
  if (!singleOnly) choices.push(['following', t('scope.following')], ['all', allText]);
  return (
    <BottomSheet label={heading} closeLabel={t('scope.cancel')} onClose={onClose}>
      <style>{FORM_CSS}</style>
      <div className="ch-scope">
        <h2 className="ch-scope-title">{heading}</h2>
        <p className="ch-scope-body">
          <bdi className="ch-scope-name">{title}</bdi>
          <span>{t(`scope.${mode}.ask`)}</span>
        </p>
        {choices.map(([scope, text], i) => (
          <button
            key={scope}
            type="button"
            className={`ch-btn ch-scope-choice${mode === 'delete' ? ' is-danger' : i === 0 ? ' ch-btn-primary' : ''}`}
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => onPick(scope)}
          >
            {text}
          </button>
        ))}
        {singleOnly ? <p className="ch-form-fixed">{t('scope.dayMoveNote')}</p> : null}
        {errorText ? (
          <p className="ch-form-error" role="alert">
            {errorText}
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}

export interface ConfirmSheetProps {
  /** The question, also the dialog's name. */
  heading: string;
  confirmLabel: string;
  cancelLabel: string;
  /** The confirm button is a destructive one (Delete), not the primary. */
  danger?: boolean;
  busy: boolean;
  error: SubmitError | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmSheet({ heading, confirmLabel, cancelLabel, danger, busy, error, onConfirm, onClose }: ConfirmSheetProps) {
  const errorText = useErrorText(error);
  return (
    <BottomSheet label={heading} closeLabel={cancelLabel} onClose={onClose}>
      <style>{FORM_CSS}</style>
      <div className="ch-scope">
        <h2 className="ch-scope-title" dir="auto">
          {heading}
        </h2>
        <button type="button" className={`ch-btn ch-scope-choice${danger ? ' is-danger' : ' ch-btn-primary'}`} disabled={busy} aria-busy={busy || undefined} onClick={onConfirm}>
          {confirmLabel}
        </button>
        {errorText ? (
          <p className="ch-form-error" role="alert">
            {errorText}
          </p>
        ) : null}
      </div>
    </BottomSheet>
  );
}
