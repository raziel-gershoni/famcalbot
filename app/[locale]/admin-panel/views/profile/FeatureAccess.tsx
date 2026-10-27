'use client';

// The features this person has switched on by hand, whatever their plan (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md,
// Design > User profile 4): five switches, a reason, and a Save button that is on only while something differs from what is saved.
//
// - A feature their paid plan already includes shows on and cannot be switched, with the note "Included in their plan". Early access
//   is never locked. Reminders are Telegram's, so a person with no Telegram id has no such switch.
// - The switches are drafts until Save: the request carries the draft's values, a switch left off as null (as the route has always
//   read it). A failure is said under the button, and the draft stays as it was.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FormCard, SaveBar, SwitchRow, TextField } from '@/components/app-ui/form-kit';
import { SectionLabel } from '@/components/app-ui/ScreenHeader';
import { isBusy } from '../../data/admin-api';
import type { OverrideInput, UserOverrideDetails } from '../../data/types';
import { failureText, type SectionProps } from './shared';

type Switch = keyof Omit<OverrideInput, 'reason'>;

/** What is saved for the person now, as a draft starts. */
const savedOf = (person: UserOverrideDetails): OverrideInput => ({
  unlimitedSummaries: person.override?.unlimitedSummaries === true,
  remindersEnabled: person.override?.remindersEnabled === true,
  voiceEventsEnabled: person.override?.voiceEventsEnabled === true,
  unlimitedCalendars: person.override?.unlimitedCalendars === true,
  earlyAdopter: person.override?.earlyAdopter === true,
  reason: person.override?.reason ?? '',
});

const same = (a: OverrideInput, b: OverrideInput) => a.unlimitedSummaries === b.unlimitedSummaries && a.remindersEnabled === b.remindersEnabled && a.voiceEventsEnabled === b.voiceEventsEnabled && a.unlimitedCalendars === b.unlimitedCalendars && a.earlyAdopter === b.earlyAdopter && a.reason === b.reason;

export function FeatureAccess({ person, profile }: SectionProps) {
  const t = useTranslations('admin');
  const saved = savedOf(person);
  const [draft, setDraft] = useState<OverrideInput>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = !same(draft, saved);

  const rows: { key: Switch; label: string; hint: string; locked: boolean; shown: boolean }[] = [
    { key: 'unlimitedSummaries', label: t('profile.access.unlimitedSummaries'), hint: t('profile.access.unlimitedSummariesHint'), locked: person.paidFeatures.unlimitedSummaries, shown: true },
    { key: 'remindersEnabled', label: t('profile.access.reminders'), hint: t('profile.access.remindersHint'), locked: person.paidFeatures.remindersEnabled, shown: person.telegramId !== null },
    { key: 'voiceEventsEnabled', label: t('profile.access.voiceEvents'), hint: t('profile.access.voiceEventsHint'), locked: person.paidFeatures.voiceEventsEnabled, shown: true },
    { key: 'unlimitedCalendars', label: t('profile.access.unlimitedCalendars'), hint: t('profile.access.unlimitedCalendarsHint'), locked: person.paidFeatures.unlimitedCalendars, shown: true },
    { key: 'earlyAdopter', label: t('profile.access.earlyAccess'), hint: t('profile.access.earlyAccessHint'), locked: false, shown: true },
  ];

  const edit = (change: Partial<OverrideInput>) => {
    setDraft((d) => ({ ...d, ...change }));
    setJustSaved(false);
    setError(null);
  };

  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    setJustSaved(false);
    const outcome = await profile.saveOverrides(draft);
    setBusy(false);
    if (outcome.ok) setJustSaved(true);
    else if (!isBusy(outcome)) setError(failureText(t as unknown as (key: string) => string, 'saveOverrides', outcome));
  };

  return (
    <>
      <SectionLabel>{t('profile.access.title')}</SectionLabel>
      <p className="ch-form-fixed">{t('profile.access.hint')}</p>
      <FormCard>
        {rows
          .filter((row) => row.shown)
          .map((row) => (
            <SwitchRow
              key={row.key}
              label={row.label}
              hint={row.hint}
              note={row.locked ? t('profile.access.locked') : undefined}
              checked={row.locked || draft[row.key]}
              disabled={row.locked}
              onChange={(on) => edit({ [row.key]: on })}
            />
          ))}
        <TextField label={t('profile.access.reason')} placeholder={t('profile.access.reason')} value={draft.reason} onChange={(reason) => edit({ reason })} />
      </FormCard>
      <SaveBar label={t('profile.access.save')} busy={busy} disabled={!dirty} error={error} status={justSaved && !dirty ? t('profile.access.saved') : null} onSave={() => void save()} />
    </>
  );
}
