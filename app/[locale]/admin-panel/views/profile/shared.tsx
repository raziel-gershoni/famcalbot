'use client';

// What the sections of a person's profile share (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > User
// profile): the props every section takes, the words for a failed action in the page's language (never the route's), and the sheet
// that runs one action and says why it failed.
//
// - Every action of the profile (useUserProfile) answers an Outcome. A section opens a sheet to ask first; the sheet's button runs
//   the action, shows the failure inside the sheet (which stays open, with its button usable again), and on success hands over to
//   the section, which closes the sheet and says what happened in a notice under its card. The request helper has already logged
//   a failure.
// - Nothing in a section knows the viewer's Telegram id: `isSelf` is decided once, in the profile, by comparing the person's
//   Telegram id with the viewer's.

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { isBusy, type AdminFailure, type Outcome } from '../../data/admin-api';
import type { UserOverrideDetails } from '../../data/types';
import type { ProfileAction, useUserProfile } from '../../data/use-user-profile';
import { ConfirmSheet } from '../../sheets';

export type ProfileHook = ReturnType<typeof useUserProfile>;

export interface SectionProps {
  person: UserOverrideDetails;
  profile: ProfileHook;
  /** The person is the viewer: nothing that locks them out is offered. */
  isSelf: boolean;
}

/** What a section says under its card after an action: the result, or why it did not work. */
export interface Message {
  tone: 'info' | 'error';
  text: string;
}

type Translate = (key: string) => string;

/** The failure of an action, in the page's language: the cases the routes answer with a reason, then "that didn't work". */
export function failureText(t: Translate, action: ProfileAction, failure: AdminFailure): string {
  const { status, code } = failure;
  if (code === 'SELF_BAN') return t('errors.selfBan');
  if (action === 'switchToWhatsApp' && status === 400) return t('errors.invalidPhone');
  if (action === 'switchToWhatsApp' && status === 409) return t('errors.phoneTaken');
  if (action === 'grantComp' && status === 409) return t('errors.compGrant');
  if (action === 'revokeComp' && status === 409) return t('errors.compRevoke');
  if (action === 'refund' && code === 'REFUND_REFUSED') return t('profile.refund.failed');
  if ((action === 'suspend' || action === 'unsuspend' || action === 'hardDelete') && status === 400) return t('errors.selfModerate');
  return t('errors.generic');
}

export interface ActionSheetProps {
  action: ProfileAction;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** The confirm button waits (a field is not filled in yet). */
  confirmDisabled?: boolean;
  /** Send the action; it answers its Outcome. */
  run: () => Promise<Outcome>;
  /** It worked: the section closes the sheet and says so. */
  onDone: () => void;
  /** Cancel, Back, the scrim: the section closes the sheet. Not while the action works. */
  onClose: () => void;
  children?: ReactNode;
}

export function ActionSheet({ action, title, body, confirmLabel, tone, confirmDisabled, run, onDone, onClose, children }: ActionSheetProps) {
  const t = useTranslations('admin');
  const ui = useTranslations('ui');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    const outcome = await run();
    setWorking(false);
    if (outcome.ok) onDone();
    else if (!isBusy(outcome)) setError(failureText(t as unknown as Translate, action, outcome));
  };

  return (
    <ConfirmSheet
      title={title}
      body={body}
      confirmLabel={confirmLabel}
      cancelLabel={ui('cancel')}
      tone={tone}
      working={working}
      error={error}
      confirmDisabled={confirmDisabled}
      onConfirm={() => void go()}
      onClose={() => {
        if (!working) onClose();
      }}
    >
      {children}
    </ConfirmSheet>
  );
}
