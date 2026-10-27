'use client';

// The blocked: Telegram ids and WhatsApp numbers that cannot sign up again (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md,
// Design > Blocked). A row is the id or number (always left to right), what kind it is and why; a tap opens a sheet with the
// reason and the date and one button, Unblock, which works at once. A failure is said in the sheet, which stays; success closes it
// and the list says so. (Blocking someone is done from their profile.)

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Notice } from '@/components/app-ui/Notice';
import { ScreenHeader } from '@/components/app-ui/ScreenHeader';
import { FormCard } from '@/components/app-ui/form-kit';
import { ListRow } from '@/components/app-ui/ListRow';
import { isBusy } from '../data/admin-api';
import { dateTime24 } from '../data/format';
import type { BlocklistEntry } from '../data/types';
import type { useBlocklist } from '../data/use-blocklist';
import { ConfirmSheet } from '../sheets';
import { LoadFailed, Waiting } from './parts';

/** What the entry blocks: the Telegram id, else the WhatsApp number (a ban of both is two entries). */
const identifierOf = (entry: BlocklistEntry): string => (entry.telegramId !== null ? String(entry.telegramId) : (entry.whatsappPhone ?? ''));

export function BlockedView({ blocklist, onBack }: { blocklist: ReturnType<typeof useBlocklist>; onBack: () => void }) {
  const t = useTranslations('admin');
  const ui = useTranslations('ui');
  const locale = useLocale();
  const { load, unban } = blocklist;
  const [open, setOpen] = useState<BlocklistEntry | null>(null);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    void load();
  }, [load]);

  const kind = (entry: BlocklistEntry) => (entry.telegramId !== null ? t('blocked.telegram') : t('blocked.whatsapp'));
  const reasonOf = (entry: BlocklistEntry) => entry.bannedReason?.trim() || t('blocked.reasonNone');
  const working = open !== null && blocklist.unbanning === open.id;

  const close = () => {
    if (working) return;
    setOpen(null);
    setFailed(false);
  };
  const confirm = async () => {
    if (!open) return;
    setFailed(false);
    const outcome = await unban(open);
    if (outcome.ok) {
      setOpen(null);
      setDone(true);
    } else if (!isBusy(outcome)) {
      setFailed(true);
    }
  };

  return (
    <>
      <ScreenHeader title={t('blocked.title')} backLabel={ui('back')} onBack={onBack} />
      <div className="ch-form-page ch-form-page-grouped">
        {done ? <Notice>{t('blocked.unblocked')}</Notice> : null}
        <p className="ch-form-fixed">{t('blocked.intro')}</p>
        {blocklist.status === 'failed' ? <LoadFailed onRetry={() => void load()} /> : null}
        {blocklist.status === 'loading' ? <Waiting /> : null}
        {blocklist.status === 'ready' && blocklist.entries.length === 0 ? <p className="ch-form-fixed">{t('blocked.empty')}</p> : null}
        {blocklist.entries.length > 0 ? (
          <FormCard>
            {blocklist.entries.map((entry) => (
              <ListRow
                key={entry.id}
                title={<bdi dir="ltr">{identifierOf(entry)}</bdi>}
                meta={
                  <>
                    <span className="ch-admin-line">{kind(entry)}</span>
                    <span className="ch-admin-line ch-admin-clamp" dir="auto">
                      {reasonOf(entry)}
                    </span>
                  </>
                }
                onClick={() => {
                  setDone(false);
                  setFailed(false);
                  setOpen(entry);
                }}
              />
            ))}
          </FormCard>
        ) : null}
      </div>

      {open ? (
        <ConfirmSheet
          title={identifierOf(open)}
          body={kind(open)}
          confirmLabel={t('blocked.unblock')}
          cancelLabel={ui('cancel')}
          working={working}
          error={failed ? t('errors.unban') : null}
          onConfirm={() => void confirm()}
          onClose={close}
        >
          <p className="ch-admin-text" dir="auto">
            {reasonOf(open)}
          </p>
          <p className="ch-form-fixed">{t('blocked.blockedOn', { date: dateTime24(open.createdAt, locale) })}</p>
        </ConfirmSheet>
      ) : null}
    </>
  );
}
