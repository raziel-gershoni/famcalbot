'use client';

// Who the person is (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > User profile 1): the tags that say how
// they stand (suspended, early access, overrides), their Telegram id and WhatsApp number (left to right, each copyable) and how long
// ago they signed up.

import { useLocale, useTranslations } from 'next-intl';
import { CopyField } from '@/components/app-ui/CopyField';
import { FormCard, FormRow } from '@/components/app-ui/form-kit';
import { Tag } from '@/components/app-ui/Tag';
import { dateOnly } from '../../data/format';
import type { UserOverrideDetails } from '../../data/types';

/** An id or a number with its label above it and a copy button: always left to right. */
function IdField({ label, value, copyLabel, copiedLabel }: { label: string; value: string; copyLabel: string; copiedLabel: string }) {
  return (
    <div>
      <span className="ch-admin-field-label">{label}</span>
      <CopyField key={value} label={label} value={value} copyLabel={copyLabel} copiedLabel={copiedLabel} />
    </div>
  );
}

export function Who({ person }: { person: UserOverrideDetails }) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const tags = [
    person.suspendedAt ? <Tag key="suspended" tone="danger">{t('users.suspended')}</Tag> : null,
    person.override?.earlyAdopter ? <Tag key="early">{t('users.earlyAccess')}</Tag> : null,
    person.override ? <Tag key="overrides" tone="muted">{t('users.overrides')}</Tag> : null,
  ].filter(Boolean);

  return (
    <FormCard>
      {tags.length > 0 ? (
        <div className="ch-form-row">
          <span className="ch-list-tags">{tags}</span>
        </div>
      ) : null}
      {person.telegramId !== null ? (
        <IdField label={t('profile.who.telegram')} value={String(person.telegramId)} copyLabel={t('profile.who.copy')} copiedLabel={t('profile.who.copied')} />
      ) : (
        <FormRow label={t('profile.who.telegram')}>
          <span className="ch-form-value">{t('profile.who.noTelegram')}</span>
        </FormRow>
      )}
      {person.whatsappPhone ? (
        <IdField label={t('profile.who.whatsapp')} value={person.whatsappPhone} copyLabel={t('profile.who.copy')} copiedLabel={t('profile.who.copied')} />
      ) : (
        <FormRow label={t('profile.who.whatsapp')}>
          <span className="ch-form-value">{t('profile.who.noWhatsapp')}</span>
        </FormRow>
      )}
      <FormRow label={t('profile.who.signedUp', { count: person.setupReminders.daysSinceCreated })} hint={dateOnly(person.createdAt, locale)} />
    </FormCard>
  );
}
