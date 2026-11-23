'use client';

// Who the person is (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > User profile 1): the tags that say how
// they stand (suspended, early access, overrides), their Telegram id and WhatsApp number (left to right, each copyable) and how long
// ago they signed up.
//
// A way to reach them (menu-revamp spec §6): "Open in Telegram" under a Telegram id posts /api/admin/open-profile with the profile's
// database id (the busy button ignores a second tap): a `link` answer (their public t.me address) is opened with Telegram's
// openTelegramLink, a `sent` answer (no public username: the bot put a mention in the admin's own chat) says so under the card, and
// any other answer, or a link that will not open, says it could not. "Open in WhatsApp" under a number opens wa.me with its digits
// and asks nothing of the server. An answer that comes after the admin moved to another person shows nowhere.

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CopyField } from '@/components/app-ui/CopyField';
import { FormCard, FormRow } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { Tag } from '@/components/app-ui/Tag';
import { openExternalLink, openTelegramLink } from '@/src/lib/telegram-ui';
import { adminPost } from '../../data/admin-api';
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

/** What the open-profile route answers when it worked. */
interface OpenProfileAnswer {
  kind?: string;
  url?: string;
}

/** A button under an id, in the card's own row style. */
function OpenRow({ label, busy, onClick }: { label: string; busy?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="ch-form-row ch-action-row" disabled={busy} aria-busy={busy || undefined} onClick={onClick}>
      <span className="ch-form-label">{label}</span>
    </button>
  );
}

export function Who({ person }: { person: UserOverrideDetails }) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const [opening, setOpening] = useState(false);
  const [outcome, setOutcome] = useState<{ id: number; tone: 'info' | 'error'; text: string } | null>(null);
  // The person shown now, and whether a request is out: read after an await, where a render's own values are stale
  const shown = useRef(person.id);
  const running = useRef(false);
  useEffect(() => {
    shown.current = person.id;
  }, [person.id]);

  const openTelegram = async () => {
    if (running.current) return;
    running.current = true;
    setOpening(true);
    setOutcome(null);
    const id = person.id;
    try {
      const result = await adminPost<OpenProfileAnswer>('open-profile', { userId: id });
      if (shown.current !== id) return;
      if (result.ok && result.data.kind === 'sent') setOutcome({ id, tone: 'info', text: t('profile.who.sentToChat') });
      else if (result.ok && result.data.kind === 'link' && typeof result.data.url === 'string' && openTelegramLink(result.data.url)) setOutcome(null);
      else setOutcome({ id, tone: 'error', text: t('profile.who.openFailed') });
    } finally {
      running.current = false;
      setOpening(false);
    }
  };
  const whatsappDigits = person.whatsappPhone ? person.whatsappPhone.replace(/\D/g, '') : '';
  const message = outcome && outcome.id === person.id ? outcome : null;
  const tags = [
    person.suspendedAt ? <Tag key="suspended" tone="danger">{t('users.suspended')}</Tag> : null,
    person.override?.earlyAdopter ? <Tag key="early">{t('users.earlyAccess')}</Tag> : null,
    person.override ? <Tag key="overrides" tone="muted">{t('users.overrides')}</Tag> : null,
  ].filter(Boolean);

  return (
    <>
      <FormCard>
        {tags.length > 0 ? (
          <div className="ch-form-row">
            <span className="ch-list-tags">{tags}</span>
          </div>
        ) : null}
        {person.telegramId !== null ? (
          <>
            <IdField label={t('profile.who.telegram')} value={String(person.telegramId)} copyLabel={t('profile.who.copy')} copiedLabel={t('profile.who.copied')} />
            <OpenRow label={t('profile.who.openTelegram')} busy={opening} onClick={openTelegram} />
          </>
        ) : (
          <FormRow label={t('profile.who.telegram')}>
            <span className="ch-form-value">{t('profile.who.noTelegram')}</span>
          </FormRow>
        )}
        {person.whatsappPhone ? (
          <>
            <IdField label={t('profile.who.whatsapp')} value={person.whatsappPhone} copyLabel={t('profile.who.copy')} copiedLabel={t('profile.who.copied')} />
            {whatsappDigits ? <OpenRow label={t('profile.who.openWhatsapp')} onClick={() => void openExternalLink(`https://wa.me/${whatsappDigits}`)} /> : null}
          </>
        ) : (
          <FormRow label={t('profile.who.whatsapp')}>
            <span className="ch-form-value">{t('profile.who.noWhatsapp')}</span>
          </FormRow>
        )}
        <FormRow label={t('profile.who.signedUp', { count: person.setupReminders.daysSinceCreated })} hint={dateOnly(person.createdAt, locale)} />
      </FormCard>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
    </>
  );
}
