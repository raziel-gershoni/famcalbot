'use client';

// What an admin can do to the account itself (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > User profile 7),
// last on the page and none of it without asking:
// - Suspend (optional reason, asks first), or Unsuspend (it works at once and says so);
// - Block their Telegram id and/or WhatsApp number so they cannot sign up again (a sheet with a switch for each, a reason, a confirm);
// - Delete for good: a sheet in which the person types DELETE, which is what the server requires (so it is Latin in every language).
//   While it works nothing closes the sheet. When it is done the profile is gone and the panel goes back to the people list, which says
//   whose account was deleted.
// The viewer's own account offers none of these (the routes refuse them), and says so.

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { FormCard, SwitchRow, TextField } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { SectionLabel } from '@/components/app-ui/ScreenHeader';
import { isBusy } from '../../data/admin-api';
import { dateTime24 } from '../../data/format';
import { ActionSheet, failureText, type Message, type SectionProps } from './shared';

/** The word the route requires before it deletes a person. */
const CONFIRMATION = 'DELETE';
/** A Latin id or number inside a Hebrew line keeps its own order. */
const isolate = (text: string) => `⁦${text}⁩`;

export function Account({ person, profile, isSelf, onDeleted }: SectionProps & { onDeleted: (name: string) => void }) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const [sheet, setSheet] = useState<'suspend' | 'block' | 'delete' | null>(null);
  const [reason, setReason] = useState('');
  const [blockTelegram, setBlockTelegram] = useState(true);
  const [blockWhatsapp, setBlockWhatsapp] = useState(true);
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState<Message | null>(null);

  const open = (which: 'suspend' | 'block' | 'delete') => {
    setMessage(null);
    setReason('');
    setTyped('');
    setBlockTelegram(true);
    setBlockWhatsapp(true);
    setSheet(which);
  };
  const close = () => setSheet(null);
  const done = (text: string) => {
    setSheet(null);
    setMessage({ tone: 'info', text });
  };

  const unsuspend = async () => {
    setMessage(null);
    const outcome = await profile.unsuspend();
    if (outcome.ok) setMessage({ tone: 'info', text: t('profile.account.unsuspended', { name: person.name }) });
    else if (!isBusy(outcome)) setMessage({ tone: 'error', text: failureText(t as unknown as (key: string) => string, 'unsuspend', outcome) });
  };

  const hasTelegram = person.telegramId !== null;
  const hasWhatsapp = person.whatsappPhone !== null;
  const nothingToBlock = !(hasTelegram && blockTelegram) && !(hasWhatsapp && blockWhatsapp);

  return (
    <>
      <SectionLabel>{t('profile.account.title')}</SectionLabel>
      {isSelf ? (
        <Notice>{t('profile.self')}</Notice>
      ) : (
        <FormCard>
          {person.suspendedAt ? (
            <>
              <div className="ch-form-row">
                <span className="ch-form-label">
                  <span>{t('profile.account.suspendedOn', { date: dateTime24(person.suspendedAt, locale) })}</span>
                  {person.suspendedReason ? (
                    <span className="ch-form-hint" dir="auto">
                      {t('profile.account.suspendedReason', { reason: person.suspendedReason })}
                    </span>
                  ) : null}
                </span>
              </div>
              <button type="button" className="ch-form-row ch-action-row" disabled={profile.working !== null} aria-busy={profile.working === 'unsuspend' || undefined} onClick={() => void unsuspend()}>
                <span className="ch-form-label">{t('profile.account.unsuspend')}</span>
                {profile.working === 'unsuspend' ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
              </button>
            </>
          ) : (
            <button type="button" className="ch-form-row ch-action-row" aria-haspopup="dialog" onClick={() => open('suspend')}>
              <span className="ch-form-label">{t('profile.account.suspend')}</span>
            </button>
          )}
          {hasTelegram || hasWhatsapp ? (
            <button type="button" className="ch-form-row ch-action-row" aria-haspopup="dialog" onClick={() => open('block')}>
              <span className="ch-form-label">{t('profile.account.block')}</span>
            </button>
          ) : null}
          <button type="button" className="ch-form-row ch-danger-row" aria-haspopup="dialog" onClick={() => open('delete')}>
            {t('profile.account.delete')}
          </button>
        </FormCard>
      )}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {sheet === 'suspend' ? (
        <ActionSheet
          action="suspend"
          title={t('profile.account.suspendTitle', { name: person.name })}
          body={t('profile.account.suspendBody')}
          confirmLabel={t('profile.account.suspendConfirm')}
          tone="danger"
          run={() => profile.suspend(reason)}
          onDone={() => done(t('profile.account.suspended', { name: person.name }))}
          onClose={close}
        >
          <FormCard>
            <TextField label={t('profile.account.reason')} placeholder={t('profile.account.reason')} value={reason} onChange={setReason} />
          </FormCard>
        </ActionSheet>
      ) : null}
      {sheet === 'block' ? (
        <ActionSheet
          action="ban"
          title={t('profile.account.blockTitle', { name: person.name })}
          body={t('profile.account.blockBody')}
          confirmLabel={t('profile.account.blockConfirm')}
          tone="danger"
          confirmDisabled={nothingToBlock}
          run={() => profile.ban({ telegram: hasTelegram && blockTelegram, whatsapp: hasWhatsapp && blockWhatsapp, reason })}
          onDone={() => done(t('profile.account.blockedDone'))}
          onClose={close}
        >
          <FormCard>
            {hasTelegram ? <SwitchRow label={t('profile.account.blockTelegram')} hint={isolate(String(person.telegramId))} checked={blockTelegram} onChange={setBlockTelegram} /> : null}
            {hasWhatsapp ? <SwitchRow label={t('profile.account.blockWhatsapp')} hint={isolate(person.whatsappPhone ?? '')} checked={blockWhatsapp} onChange={setBlockWhatsapp} /> : null}
            <TextField label={t('profile.account.reason')} placeholder={t('profile.account.reason')} value={reason} onChange={setReason} />
          </FormCard>
        </ActionSheet>
      ) : null}
      {sheet === 'delete' ? (
        <ActionSheet
          action="hardDelete"
          title={t('profile.account.deleteTitle', { name: person.name })}
          body={t('profile.account.deleteBody')}
          confirmLabel={t('profile.account.deleteConfirm')}
          tone="danger"
          confirmDisabled={typed !== CONFIRMATION}
          run={() => profile.hardDelete(typed)}
          onDone={() => onDeleted(person.name)}
          onClose={close}
        >
          <p className="ch-form-fixed">{t('profile.account.deleteType')}</p>
          <FormCard>
            <TextField label={t('profile.account.deleteType')} placeholder={CONFIRMATION} value={typed} onChange={setTyped} />
          </FormCard>
        </ActionSheet>
      ) : null}
    </>
  );
}
