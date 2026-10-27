'use client';

// How far the person is with setting up (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > User profile 3): a
// row per step (location; and, once they have touched Google, the calendars and the connection), each with whether it is done and how
// many of its reminders were sent and are overdue, as a bar and as words. Under them: send a setup reminder (it sends a REAL message,
// so it asks first and names the person, with the reminder to pick), and reset the reminders (asks first).

import { useState } from 'react';
import { Check, Circle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { FormCard, FormRow, RadioCard } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { SectionLabel } from '@/components/app-ui/ScreenHeader';
import { REMINDER_TYPES, type ReminderType, type SetupAttempts } from '../../data/types';
import { ActionSheet, type Message, type SectionProps } from './shared';

interface Step {
  key: string;
  label: string;
  done: boolean;
  attempts: SetupAttempts;
}

/** The reminders a person can be sent, by the message that names each (admin.profile.setup.types.*). */
const TYPE_LABELS: Record<ReminderType, string> = {
  calendars: 'profile.setup.types.calendars',
  reconnect: 'profile.setup.types.reconnect',
  location: 'profile.setup.types.location',
};

export function Setup({ person, profile }: SectionProps) {
  const t = useTranslations('admin');
  const [sheet, setSheet] = useState<'send' | 'reset' | null>(null);
  const [type, setType] = useState<ReminderType>('location');
  const [message, setMessage] = useState<Message | null>(null);
  const status = person.registrationStatus;
  const reminders = person.setupReminders;
  // The Google steps only matter once the person has touched Google: it is optional.
  const google = status.googleState !== 'none';
  const steps: Step[] = [
    { key: 'location', label: t('profile.setup.location'), done: status.hasLocation, attempts: reminders.location },
    ...(google
      ? [
          { key: 'calendars', label: t('profile.setup.calendars'), done: status.hasCalendars, attempts: reminders.calendars },
          { key: 'google', label: t('profile.setup.google'), done: status.hasOAuth, attempts: reminders.reconnect },
        ]
      : []),
  ];
  const offered = REMINDER_TYPES.filter((candidate) => candidate === 'location' || google);

  const openSend = () => {
    setMessage(null);
    setType(status.applicableReminder && offered.includes(status.applicableReminder) ? status.applicableReminder : offered[0]);
    setSheet('send');
  };
  const openReset = () => {
    setMessage(null);
    setSheet('reset');
  };
  const done = (text: string) => {
    setSheet(null);
    setMessage({ tone: 'info', text });
  };

  return (
    <>
      <SectionLabel>{t('profile.setup.title')}</SectionLabel>
      <FormCard>
        {reminders.wasReset ? <FormRow label={t('profile.setup.restarted', { count: reminders.daysSinceStart })} /> : null}
        {steps.map((step) => {
          const sent = step.attempts.filter((a) => a.sent).length;
          const overdue = step.attempts.filter((a) => a.due && !a.sent).length;
          return (
            <div key={step.key} className="ch-form-row ch-admin-step">
              {step.done ? <Check className="ch-admin-step-icon is-done" aria-hidden="true" /> : <Circle className="ch-admin-step-icon" aria-hidden="true" />}
              <span className="ch-form-label">
                <span>
                  {step.label}
                  <span className="ch-visually-hidden">{`: ${step.done ? t('profile.setup.done') : t('profile.setup.todo')}`}</span>
                </span>
                <span className="ch-form-hint">
                  {t('profile.setup.sent', { sent, total: step.attempts.length })}
                  {overdue > 0 ? ` · ${t('profile.setup.overdue', { count: overdue })}` : ''}
                </span>
                <span className="ch-admin-bar" aria-hidden="true">
                  {step.attempts.map((a, i) => (
                    <span key={i} className={a.sent ? 'ch-admin-seg is-sent' : a.due ? 'ch-admin-seg is-due' : 'ch-admin-seg'} />
                  ))}
                </span>
              </span>
            </div>
          );
        })}
        {status.applicableReminder ? (
          <button type="button" className="ch-form-row ch-action-row" aria-haspopup="dialog" onClick={openSend}>
            <span className="ch-form-label">{t('profile.setup.send')}</span>
          </button>
        ) : (
          <div className="ch-form-row">
            <span className="ch-form-hint">{t('profile.setup.allDone')}</span>
          </div>
        )}
        <button type="button" className="ch-form-row ch-action-row" aria-haspopup="dialog" onClick={openReset}>
          <span className="ch-form-label">{t('profile.setup.reset')}</span>
        </button>
      </FormCard>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {sheet === 'send' ? (
        <ActionSheet
          action="sendReminder"
          title={t('profile.setup.sendTitle', { name: person.name })}
          body={t('profile.setup.sendBody')}
          confirmLabel={t('profile.setup.sendConfirm')}
          run={() => profile.sendReminder(type)}
          onDone={() => done(t('profile.setup.sentTo', { name: person.name }))}
          onClose={() => setSheet(null)}
        >
          <RadioCard label={t('profile.setup.send')} value={type} options={offered.map((value) => ({ value, text: t(TYPE_LABELS[value]) }))} onChange={(value) => setType(value as ReminderType)} />
        </ActionSheet>
      ) : null}
      {sheet === 'reset' ? (
        <ActionSheet
          action="resetReminders"
          title={t('profile.setup.resetTitle', { name: person.name })}
          body={t('profile.setup.resetBody')}
          confirmLabel={t('profile.setup.resetConfirm')}
          tone="danger"
          run={() => profile.resetReminders()}
          onDone={() => done(t('profile.setup.resetDone'))}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}
