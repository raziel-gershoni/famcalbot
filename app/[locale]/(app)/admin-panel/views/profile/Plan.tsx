'use client';

// The person's plan (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > User profile 2): what they are on
// (the plan line, with a tag for a trial, a paid plan or free Pro), how much of each limit they have used, and giving or stopping Pro
// for free, and refunding a payment. All ask first; giving takes an optional reason. Each payment still inside the 14 days of the
// refund rule (src/lib/refund-eligibility.ts) has its own Refund row, with its plan, its Stars and the day it was paid, newest
// first; its sheet names the plan and the day. When early access is on for everyone, a note says Pro is theirs anyway.

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { FormCard, FormRow, TextField } from '@/components/app-ui/form-kit';
import { Meter } from '@/components/app-ui/Meter';
import { Notice } from '@/components/app-ui/Notice';
import { SectionLabel } from '@/components/app-ui/ScreenHeader';
import { Tag } from '@/components/app-ui/Tag';
import { holdsPaidPlan } from '@/src/lib/comp-eligibility';
import { refundableNow } from '@/src/lib/refund-eligibility';
import { dateOnly, planLine, planName, type AdminTranslate } from '../../data/format';
import type { RefundablePayment, UserOverrideDetails } from '../../data/types';
import { ActionSheet, type Message, type SectionProps } from './shared';

type Kind = 'comped' | 'trial' | 'paid' | 'free';

function kindOf(sub: UserOverrideDetails['subscription'], now: Date): Kind {
  if (!sub) return 'free';
  if (sub.comped) return 'comped';
  if (sub.status === 'TRIALING' && sub.trialDaysRemaining) return 'trial';
  const periodEnd = sub.currentPeriodEnd ? Date.parse(sub.currentPeriodEnd) : NaN;
  if (sub.plan !== 'FREE' && (sub.status === 'ACTIVE' || (sub.status === 'CANCELED' && periodEnd > now.getTime()))) return 'paid';
  return 'free';
}

/** Whether Pro can be given for free: not while they hold a paid plan, the one rule the route enforces too (a free trial is replaced by the gift). */
function canGive(sub: UserOverrideDetails['subscription'], now: Date): boolean {
  return !!sub && !sub.comped && !holdsPaidPlan(sub, now);
}

export function Plan({ person, profile, earlyAccessOn }: SectionProps & { earlyAccessOn: boolean }) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const [sheet, setSheet] = useState<'give' | 'stop' | 'refund' | null>(null);
  const [refunding, setRefunding] = useState<RefundablePayment | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<Message | null>(null);
  const now = new Date();
  const sub = person.subscription;
  const kind = kindOf(sub, now);
  const tag = { comped: t('profile.plan.tagComped'), trial: t('profile.plan.tagTrial'), paid: t('profile.plan.tagPaid'), free: null }[kind];

  const measure = (label: string, used: number, limit: number | null) =>
    limit === null ? <Meter label={label} used={used} limit={null} valueText={t('profile.plan.unlimited')} /> : <Meter label={label} used={used} limit={limit} valueText={t('profile.plan.usage', { used, limit })} />;

  const done = (text: string) => {
    setSheet(null);
    setReason('');
    setMessage({ tone: 'info', text });
  };
  const close = () => {
    setSheet(null);
    setReason('');
  };
  const open = (which: 'give' | 'stop' | 'refund', payment: RefundablePayment | null = null) => {
    setMessage(null);
    setRefunding(payment);
    setSheet(which);
  };

  const giveRow = canGive(sub, now);
  const blocked = kind !== 'comped' && !giveRow;
  // Each payment still inside the refund window (the server sends those; the page may have stayed open past one's end)
  const refundable = (person.payments ?? []).filter((p) => refundableNow(p.paidAt, now));

  return (
    <>
      <SectionLabel>{t('profile.plan.title')}</SectionLabel>
      <FormCard>
        <FormRow label={planLine(person, t as unknown as AdminTranslate, locale, now)}>{tag ? <Tag>{tag}</Tag> : null}</FormRow>
        <div className="ch-form-row">
          <div className="ch-admin-meter">{measure(t('profile.plan.textSummaries'), person.usage.textSummariesUsed, person.limits.textSummaries)}</div>
        </div>
        <div className="ch-form-row">
          <div className="ch-admin-meter">{measure(t('profile.plan.voiceSummaries'), person.usage.voiceSummariesUsed, person.limits.voiceSummaries)}</div>
        </div>
        <div className="ch-form-row">
          <div className="ch-admin-meter">{measure(t('profile.plan.calendars'), person.calendarsCount, person.limits.calendars)}</div>
        </div>
        <div className="ch-form-row">
          <div className="ch-admin-meter">
            <Meter label={t('profile.plan.voiceEvents')} used={person.usage.voiceEventsCreated} limit={null} valueText={String(person.usage.voiceEventsCreated)} />
          </div>
        </div>
        {kind === 'comped' && sub ? (
          <>
            <FormRow label={t('profile.comp.since', { date: sub.compedAt ? dateOnly(sub.compedAt, locale) : '' })} hint={sub.compReason ?? undefined} />
            <button type="button" className="ch-form-row ch-danger-row" aria-haspopup="dialog" onClick={() => open('stop')}>
              {t('profile.comp.stop')}
            </button>
          </>
        ) : null}
        {giveRow ? (
          <button type="button" className="ch-form-row ch-action-row" aria-haspopup="dialog" onClick={() => open('give')}>
            <span className="ch-form-label">{t('profile.comp.give')}</span>
          </button>
        ) : null}
        {blocked ? (
          <div className="ch-form-row">
            <span className="ch-form-hint">{t('profile.comp.blocked')}</span>
          </div>
        ) : null}
        {refundable.map((p) => (
          <button key={p.id} type="button" className="ch-form-row ch-danger-row" aria-haspopup="dialog" onClick={() => open('refund', p)}>
            <span className="ch-form-label">
              <span>{t('profile.refund.row', { plan: planName(p.plan, t as unknown as AdminTranslate), stars: p.amount })}</span>
              <span className="ch-form-hint">{t('profile.refund.paidOn', { date: dateOnly(p.paidAt, locale) })}</span>
            </span>
          </button>
        ))}
      </FormCard>
      {earlyAccessOn ? <Notice>{t('profile.plan.earlyOn')}</Notice> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {sheet === 'give' ? (
        <ActionSheet
          action="grantComp"
          title={t('profile.comp.giveTitle', { name: person.name })}
          body={t('profile.comp.giveBody')}
          confirmLabel={t('profile.comp.giveConfirm')}
          run={() => profile.grantComp(reason)}
          onDone={() => done(t('profile.comp.given', { name: person.name }))}
          onClose={close}
        >
          <FormCard>
            <TextField label={t('profile.comp.reason')} placeholder={t('profile.comp.reason')} value={reason} onChange={setReason} />
          </FormCard>
        </ActionSheet>
      ) : null}
      {sheet === 'refund' && refunding ? (
        <ActionSheet
          action="refund"
          title={t('profile.refund.confirmTitle', { plan: planName(refunding.plan, t as unknown as AdminTranslate), date: dateOnly(refunding.paidAt, locale) })}
          confirmLabel={t('profile.refund.confirm')}
          tone="danger"
          run={() => profile.refund(refunding.id)}
          onDone={() => done(t('profile.refund.done'))}
          onClose={close}
        />
      ) : null}
      {sheet === 'stop' ? (
        <ActionSheet
          action="revokeComp"
          title={t('profile.comp.stopTitle', { name: person.name })}
          body={t('profile.comp.stopBody')}
          confirmLabel={t('profile.comp.stopConfirm')}
          tone="danger"
          run={() => profile.revokeComp()}
          onDone={() => done(t('profile.comp.stopped'))}
          onClose={close}
        />
      ) : null}
    </>
  );
}
