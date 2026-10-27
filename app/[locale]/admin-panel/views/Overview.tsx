'use client';

// The panel's first screen (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > Root): four counts, the
// ways into people, feedback, the blocked and the activity log, the five app switches, and the reset of everyone's setup
// reminders.
//
// - The counts card: People and Still setting up open the Users list (the list carries no setup state, so the second opens
//   it unfiltered); Google connected and With calendars only count, so they are not buttons. "Setup done" is the share of
//   people who are not still setting up, and is left out at 0 people.
// - The switches: Early access asks first, in both directions, in a sheet (turning it on gives everyone Pro, turning it off
//   takes it away); the other four switch at once. A switch that fails goes back and a notice says so.
// - Reset everyone still setting up is a danger row: it asks, then says how many people it reset.
// - Every failure is logged by the request helper and said here in the page's language.

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Notice } from '@/components/app-ui/Notice';
import { ScreenHeader, SectionLabel } from '@/components/app-ui/ScreenHeader';
import { Chevron, FormCard, SwitchRow } from '@/components/app-ui/form-kit';
import { ListRow } from '@/components/app-ui/ListRow';
import { isBusy, type Outcome } from '../data/admin-api';
import type { AdminFlag, AdminFlags, AdminStats } from '../data/types';
import { resetAllSetupReminders } from '../data/use-users';
import type { AdminView } from '../navigation';
import { ConfirmSheet } from '../sheets';

/** The switches in the order they show: the flag, and the messages of its label and its line under it (admin.features.*). */
const SWITCHES: { flag: AdminFlag; label: string; hint: string }[] = [
  { flag: 'remindersEnabled', label: 'reminders', hint: 'remindersDescription' },
  { flag: 'nativeRemindersEnabled', label: 'nativeReminders', hint: 'nativeRemindersDescription' },
  { flag: 'earlyAdoptionMode', label: 'earlyAdoption', hint: 'earlyAdoptionDescription' },
  { flag: 'voiceAutoCreateHighConf', label: 'voiceAutoCreate', hint: 'voiceAutoCreateDescription' },
  { flag: 'voiceTtsOutcome', label: 'voiceTtsOutcome', hint: 'voiceTtsOutcomeDescription' },
];

interface Count {
  key: string;
  value: number;
  label: string;
  /** Where a tap goes; a count with none is not a button. */
  open?: AdminView;
}

export interface OverviewProps {
  stats: AdminStats;
  flags: AdminFlags;
  saving: AdminFlags;
  setFlag: (flag: AdminFlag, value: boolean) => Promise<Outcome>;
  /** How many messages / blocked entries there are, once known. */
  feedbackCount: number | null;
  blockedCount: number | null;
  onOpen: (view: AdminView) => void;
  onBack: () => void;
}

type Message = { tone: 'info' | 'error'; text: string };

export function Overview({ stats, flags, saving, setFlag, feedbackCount, blockedCount, onOpen, onBack }: OverviewProps) {
  const t = useTranslations('admin');
  const ui = useTranslations('ui');
  const locale = useLocale();
  const [message, setMessage] = useState<Message | null>(null);
  /** The value the early-access sheet asks about; null while it is closed. */
  const [earlyAsk, setEarlyAsk] = useState<boolean | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);

  const flip = async (flag: AdminFlag, value: boolean) => {
    setMessage(null);
    const outcome = await setFlag(flag, value);
    if (!outcome.ok && !isBusy(outcome)) setMessage({ tone: 'error', text: t('errors.switch') });
  };

  const confirmEarly = () => {
    if (earlyAsk === null) return;
    const value = earlyAsk;
    setEarlyAsk(null);
    void flip('earlyAdoptionMode', value);
  };

  const closeReset = () => {
    if (resetting) return;
    setResetOpen(false);
    setResetFailed(false);
  };
  const reset = async () => {
    if (resetting) return;
    setResetting(true);
    setResetFailed(false);
    const result = await resetAllSetupReminders();
    setResetting(false);
    if (result.ok) {
      setResetOpen(false);
      setMessage({ tone: 'info', text: t('reset.result', { count: result.data.usersReset ?? 0 }) });
    } else {
      setResetFailed(true);
    }
  };

  const number = new Intl.NumberFormat(locale);
  const counts: Count[] = [
    { key: 'people', value: stats.totalUsers, label: t('counts.people'), open: { kind: 'users' } },
    { key: 'google', value: stats.usersWithOAuth, label: t('counts.google') },
    { key: 'calendars', value: stats.usersWithCalendars, label: t('counts.calendars') },
    { key: 'setup', value: stats.needSetup, label: t('counts.setup'), open: { kind: 'users' } },
  ];
  const setupDone = stats.totalUsers > 0 ? Math.min(100, Math.max(0, Math.round(((stats.totalUsers - stats.needSetup) / stats.totalUsers) * 100))) : null;
  const titled = (name: string, count: number | null) => (count === null ? name : t('rows.withCount', { name, count: number.format(count) }));

  return (
    <>
      <ScreenHeader title={t('title')} backLabel={ui('back')} onBack={onBack} />
      <div className="ch-form-page ch-form-page-grouped">
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

        <FormCard>
          <div className="ch-admin-counts">
            {counts.map((count) => {
              const open = count.open;
              const inside = (
                <>
                  <span className="ch-admin-count-num">{number.format(count.value)}</span>
                  <span className="ch-admin-count-label">{count.label}</span>
                  {open ? <Chevron /> : null}
                </>
              );
              return open ? (
                <button key={count.key} type="button" className="ch-admin-count" onClick={() => onOpen(open)}>
                  {inside}
                </button>
              ) : (
                <div key={count.key} className="ch-admin-count">
                  {inside}
                </div>
              );
            })}
          </div>
          {setupDone !== null ? (
            <div className="ch-form-row">
              <span className="ch-form-hint">{t('counts.setupDone', { percent: setupDone })}</span>
            </div>
          ) : null}
        </FormCard>

        <SectionLabel>{t('sections.people')}</SectionLabel>
        <FormCard>
          <ListRow title={titled(t('rows.users'), stats.totalUsers)} onClick={() => onOpen({ kind: 'users' })} />
          <ListRow title={titled(t('rows.feedback'), feedbackCount)} onClick={() => onOpen({ kind: 'feedback' })} />
          <ListRow title={titled(t('rows.blocked'), blockedCount)} onClick={() => onOpen({ kind: 'blocked' })} />
        </FormCard>

        <SectionLabel>{t('sections.activity')}</SectionLabel>
        <FormCard>
          <ListRow title={t('rows.activity')} meta={t('rows.activityHint')} onClick={() => onOpen({ kind: 'activity' })} />
        </FormCard>

        <SectionLabel>{t('sections.switches')}</SectionLabel>
        <FormCard>
          {SWITCHES.map(({ flag, label, hint }) => (
            <SwitchRow
              key={flag}
              label={t(`features.${label}`)}
              hint={t(`features.${hint}`)}
              checked={flags[flag]}
              disabled={saving[flag]}
              onChange={(on) => (flag === 'earlyAdoptionMode' ? setEarlyAsk(on) : void flip(flag, on))}
            />
          ))}
        </FormCard>

        <SectionLabel>{t('sections.reminders')}</SectionLabel>
        <FormCard>
          <div className="ch-form-row">
            <span className="ch-form-hint">{t('reset.hint')}</span>
          </div>
          <button type="button" className="ch-form-row ch-danger-row" aria-haspopup="dialog" onClick={() => setResetOpen(true)}>
            {t('reset.row')}
          </button>
        </FormCard>
      </div>

      {earlyAsk !== null ? (
        <ConfirmSheet
          title={t(earlyAsk ? 'earlyAccess.onTitle' : 'earlyAccess.offTitle')}
          body={t(earlyAsk ? 'earlyAccess.onBody' : 'earlyAccess.offBody')}
          confirmLabel={t(earlyAsk ? 'earlyAccess.onConfirm' : 'earlyAccess.offConfirm')}
          cancelLabel={ui('cancel')}
          tone={earlyAsk ? 'primary' : 'danger'}
          onConfirm={confirmEarly}
          onClose={() => setEarlyAsk(null)}
        />
      ) : null}
      {resetOpen ? (
        <ConfirmSheet
          title={t('reset.title')}
          body={t('reset.body')}
          confirmLabel={t('reset.confirm')}
          cancelLabel={ui('cancel')}
          tone="danger"
          working={resetting}
          error={resetFailed ? t('errors.generic') : null}
          onConfirm={() => void reset()}
          onClose={closeReset}
        />
      ) : null}
    </>
  );
}
