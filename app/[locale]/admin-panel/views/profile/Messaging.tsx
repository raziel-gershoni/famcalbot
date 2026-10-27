'use client';

// Where the person is messaged (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > User profile 5): their platform
// and, for someone with no WhatsApp number yet, "Move to WhatsApp…": a sheet with the number (E.164, left to right) that asks first. The
// route checks the number; its refusals are said in the page's language (a malformed number, a number someone else has).

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FormCard, FormRow, TextField } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { SectionLabel } from '@/components/app-ui/ScreenHeader';
import { ActionSheet, type Message, type SectionProps } from './shared';

export function Messaging({ person, profile }: SectionProps) {
  const t = useTranslations('admin');
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState<Message | null>(null);
  const platform = person.messagingPlatform === 'whatsapp' ? t('profile.messaging.whatsapp') : person.messagingPlatform === 'all' ? t('profile.messaging.both') : t('profile.messaging.telegram');

  const close = () => {
    setOpen(false);
    setPhone('');
  };

  return (
    <>
      <SectionLabel>{t('profile.messaging.title')}</SectionLabel>
      <FormCard>
        <FormRow label={t('profile.messaging.platform')}>
          <span className="ch-form-value">{platform}</span>
        </FormRow>
        {person.whatsappPhone === null ? (
          <button
            type="button"
            className="ch-form-row ch-action-row"
            aria-haspopup="dialog"
            onClick={() => {
              setMessage(null);
              setOpen(true);
            }}
          >
            <span className="ch-form-label">{t('profile.messaging.move')}</span>
          </button>
        ) : null}
      </FormCard>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {open ? (
        <ActionSheet
          action="switchToWhatsApp"
          title={t('profile.messaging.moveTitle', { name: person.name })}
          body={t('profile.messaging.moveBody')}
          confirmLabel={t('profile.messaging.moveConfirm')}
          confirmDisabled={phone.trim() === ''}
          run={() => profile.switchToWhatsApp(phone)}
          onDone={() => {
            close();
            setMessage({ tone: 'info', text: t('profile.messaging.moved') });
          }}
          onClose={close}
        >
          <FormCard>
            <TextField label={t('profile.messaging.phone')} placeholder={t('profile.messaging.phonePlaceholder')} value={phone} onChange={setPhone} />
          </FormCard>
        </ActionSheet>
      ) : null}
    </>
  );
}
