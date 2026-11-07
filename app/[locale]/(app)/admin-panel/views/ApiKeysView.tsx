'use client';

// The keys of the owner's other apps for the Jewish times API (spec docs/superpowers/specs/2026-11-07-zmanim-api-design.md
// §2.1): one row per key (the app, the key's first characters, the websites it may be called from or "Any caller", the day it
// was made; a revoked one dimmed, with the day it was revoked), New key, and Revoke on each active key.
//
// - New key: a sheet with the app's name and, optionally, the allowed websites, one per line. Create shows the key once with
//   Copy and "Copy it now: it is not shown again."; Done, Cancel and Back forget it (it lives in this sheet's state only).
// - Revoke asks first, names the app, and works at once; MIRROR_FAILED has its own line ("Revoked, but the cache was not
//   updated"), and a retry is safe (revoking again succeeds).
// - A failure is said in the sheet, which stays; a success closes it and the list says so. The request helper logs failures.

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CopyField } from '@/components/app-ui/CopyField';
import { Notice } from '@/components/app-ui/Notice';
import { ScreenHeader } from '@/components/app-ui/ScreenHeader';
import { FormCard, TextField } from '@/components/app-ui/form-kit';
import { ListRow } from '@/components/app-ui/ListRow';
import { isBusy } from '../data/admin-api';
import { dateOnly } from '../data/format';
import type { ApiKeyItem } from '../data/types';
import type { useApiKeys } from '../data/use-api-keys';
import { AdminSheet, ConfirmSheet } from '../sheets';
import { LoadFailed, Waiting } from './parts';

/** The create refusals the sheet words by their code; anything else is the generic line. */
const CREATE_ERRORS = { INVALID_NAME: 'apiKeys.errors.name', INVALID_ORIGIN: 'apiKeys.errors.origin', TOO_MANY_KEYS: 'apiKeys.errors.tooMany' } as const;
type CreateError = (typeof CREATE_ERRORS)[keyof typeof CREATE_ERRORS] | 'apiKeys.errors.create';
const createError = (code: string | undefined): CreateError => (code !== undefined && code in CREATE_ERRORS ? CREATE_ERRORS[code as keyof typeof CREATE_ERRORS] : 'apiKeys.errors.create');
type RevokeError = 'apiKeys.errors.mirror' | 'apiKeys.errors.revoke';

export function ApiKeysView({ apiKeys, onBack }: { apiKeys: ReturnType<typeof useApiKeys>; onBack: () => void }) {
  const t = useTranslations('admin');
  const ui = useTranslations('ui');
  const locale = useLocale();
  const { load, create, revoke } = apiKeys;
  const [revokedNotice, setRevokedNotice] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [createFailed, setCreateFailed] = useState<CreateError | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyItem | null>(null);
  const [revokeFailed, setRevokeFailed] = useState<RevokeError | null>(null);
  useEffect(() => {
    void load();
  }, [load]);

  const creating = apiKeys.working === 'create';
  const revokingNow = revoking !== null && apiKeys.working === revoking.id;

  const openNew = () => {
    setRevokedNotice(false);
    setName('');
    setOrigins('');
    setCreatedKey(null);
    setCreateFailed(null);
    setNewOpen(true);
  };
  const closeNew = () => {
    if (creating) return;
    setNewOpen(false);
    setCreatedKey(null);
    setName('');
    setOrigins('');
    setCreateFailed(null);
  };
  const submit = async () => {
    setCreateFailed(null);
    const result = await create(name, origins);
    if (result.ok) setCreatedKey(result.data.key);
    else if (!isBusy(result)) setCreateFailed(createError(result.code));
  };
  const closeRevoke = () => {
    if (revokingNow) return;
    setRevoking(null);
    setRevokeFailed(null);
  };
  const confirmRevoke = async () => {
    if (!revoking) return;
    setRevokeFailed(null);
    const outcome = await revoke(revoking);
    if (outcome.ok) {
      setRevoking(null);
      setRevokedNotice(true);
    } else if (!isBusy(outcome)) {
      setRevokeFailed(outcome.code === 'MIRROR_FAILED' ? 'apiKeys.errors.mirror' : 'apiKeys.errors.revoke');
    }
  };

  return (
    <>
      <ScreenHeader title={t('apiKeys.title')} backLabel={ui('back')} onBack={onBack} />
      <div className="ch-form-page ch-form-page-grouped">
        {revokedNotice ? <Notice>{t('apiKeys.revoked')}</Notice> : null}
        <p className="ch-form-fixed">{t('apiKeys.intro')}</p>
        {apiKeys.status === 'failed' ? <LoadFailed onRetry={() => void load()} /> : null}
        {apiKeys.status === 'loading' ? <Waiting /> : null}
        {apiKeys.status === 'ready' && apiKeys.keys.length === 0 ? <p className="ch-form-fixed">{t('apiKeys.empty')}</p> : null}
        {apiKeys.keys.length > 0 ? (
          <FormCard>
            {apiKeys.keys.map((item) => (
              <ListRow
                key={item.id}
                title={item.appName}
                disabled={item.revokedAt !== null}
                meta={
                  <>
                    <span className="ch-admin-line">
                      <bdi dir="ltr">{`${item.prefix}…`}</bdi>
                    </span>
                    <span className="ch-admin-line">{item.origins.length > 0 ? <bdi dir="ltr">{item.origins.join(', ')}</bdi> : t('apiKeys.anyCaller')}</span>
                    <span className="ch-admin-line">{item.revokedAt ? t('apiKeys.revokedOn', { date: dateOnly(item.revokedAt, locale) }) : t('apiKeys.createdOn', { date: dateOnly(item.createdAt, locale) })}</span>
                  </>
                }
                onClick={() => {
                  setRevokedNotice(false);
                  setRevokeFailed(null);
                  setRevoking(item);
                }}
              />
            ))}
          </FormCard>
        ) : null}
        <button type="button" className="ch-btn ch-btn-primary ch-save" aria-haspopup="dialog" onClick={openNew}>
          {t('apiKeys.newKey')}
        </button>
      </div>

      {newOpen ? (
        <AdminSheet label={t('apiKeys.sheetTitle')} closeLabel={ui('cancel')} working={creating} onClose={closeNew}>
          <h2 className="ch-sheet-heading">{createdKey ? t('apiKeys.createdTitle') : t('apiKeys.sheetTitle')}</h2>
          {createdKey ? (
            <div className="ch-sheet-stack">
              <FormCard>
                <CopyField label={t('apiKeys.keyLabel')} value={createdKey} copyLabel={t('apiKeys.copy')} copiedLabel={t('apiKeys.copied')} />
              </FormCard>
              <p className="ch-form-fixed">{t('apiKeys.copyNow')}</p>
              <button type="button" className="ch-btn ch-btn-primary ch-save" onClick={closeNew}>
                {ui('done')}
              </button>
            </div>
          ) : (
            <div className="ch-sheet-stack">
              <FormCard>
                <TextField label={t('apiKeys.appName')} placeholder={t('apiKeys.appNamePlaceholder')} value={name} onChange={setName} maxLength={40} disabled={creating} />
              </FormCard>
              <FormCard>
                <TextField label={t('apiKeys.origins')} placeholder={t('apiKeys.originsPlaceholder')} value={origins} onChange={setOrigins} multiline rows={3} disabled={creating} />
              </FormCard>
              <p className="ch-form-fixed">{t('apiKeys.originsHint')}</p>
              {createFailed ? <Notice tone="error">{t(createFailed)}</Notice> : null}
              <button type="button" className="ch-btn ch-btn-primary ch-save" disabled={creating || name.trim() === ''} aria-busy={creating || undefined} onClick={() => void submit()}>
                {creating ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
                {t('apiKeys.create')}
              </button>
            </div>
          )}
        </AdminSheet>
      ) : null}

      {revoking ? (
        <ConfirmSheet
          title={t('apiKeys.revokeTitle', { app: revoking.appName })}
          body={t('apiKeys.revokeBody')}
          confirmLabel={t('apiKeys.revoke')}
          cancelLabel={ui('cancel')}
          tone="danger"
          working={revokingNow}
          error={revokeFailed ? t(revokeFailed) : null}
          onConfirm={() => void confirmRevoke()}
          onClose={closeRevoke}
        />
      ) : null}
    </>
  );
}
