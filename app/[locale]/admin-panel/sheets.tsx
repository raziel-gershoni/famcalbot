'use client';

// The panel's sheets (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md): the kit's BottomSheet with what every
// sheet of the panel does, and the confirmation most of them are.
//
// - AdminSheet: Back closes it (the shell's registry, ./navigation.tsx), and does nothing while `working`; the Close button,
//   Escape and the scrim are disabled meanwhile (BottomSheet's closeDisabled). A swipe down in it must not minimize the app.
// - ConfirmSheet: a heading, a line of what will happen, what the caller puts in between (a reason field), the failure if the
//   last try failed, and the one button that does it. `tone="danger"` is the red button of a step that cannot be undone
//   or takes something away. Cancel is the sheet's own Close button; it sends nothing.
//
// Strings come in already translated.

import type { ReactNode } from 'react';
import { useTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import { BottomSheet } from '@/components/app-ui/BottomSheet';
import { Notice } from '@/components/app-ui/Notice';
import { useBackClose } from './navigation';

const noop = () => {};

export interface AdminSheetProps {
  /** The dialog's accessible name. */
  label: string;
  closeLabel: string;
  onClose: () => void;
  /** A request runs: nothing closes the sheet, Back included. */
  working?: boolean;
  children: ReactNode;
}

export function AdminSheet({ label, closeLabel, onClose, working = false, children }: AdminSheetProps) {
  useBackClose(working ? noop : onClose);
  useTelegramVerticalSwipes(true);
  return (
    <BottomSheet label={label} closeLabel={closeLabel} closeDisabled={working} onClose={onClose}>
      {children}
    </BottomSheet>
  );
}

export interface ConfirmSheetProps {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  /** The Close button's text (Cancel). */
  cancelLabel: string;
  tone?: 'primary' | 'danger';
  working?: boolean;
  /** Why the last try failed, in the page's language. */
  error?: string | null;
  /** The confirm button waits (a field is not filled in yet). */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}

export function ConfirmSheet({ title, body, confirmLabel, cancelLabel, tone = 'primary', working = false, error = null, confirmDisabled = false, onConfirm, onClose, children }: ConfirmSheetProps) {
  return (
    <AdminSheet label={title} closeLabel={cancelLabel} working={working} onClose={onClose}>
      <h2 className="ch-sheet-heading" dir="auto">
        {title}
      </h2>
      {body ? <p className="ch-sheet-sub">{body}</p> : null}
      <div className="ch-sheet-stack">
        {children}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <button
          type="button"
          className={tone === 'danger' ? 'ch-btn ch-btn-primary ch-btn-danger ch-save' : 'ch-btn ch-btn-primary ch-save'}
          disabled={working || confirmDisabled}
          aria-busy={working || undefined}
          onClick={onConfirm}
        >
          {working ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
          {confirmLabel}
        </button>
      </div>
    </AdminSheet>
  );
}
