'use client';

// Everyone (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > Users): a search field (a name or a Telegram id), a
// "Show" row (everyone, on trial, paid, free, with overrides) and the people, each a row with their name, their plan in a line (and
// WhatsApp, for someone who is only there) and tags (suspended, early access, overrides). A tap opens their profile.
//
// - The search text and the filter live in the shell (useUsers), so they are as you left them when you come back from a profile.
// - The list is asked for when the screen opens, and stays on screen while it is asked for again. It has no setup state per person
//   (the route does not send it), so the Overview's "Still setting up" opens this list unfiltered.
// - When the person you were looking at was deleted, a notice says whose account it was; the shell clears it as soon as you go anywhere.

import { useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Notice } from '@/components/app-ui/Notice';
import { ScreenHeader } from '@/components/app-ui/ScreenHeader';
import { FormCard, TextField, ValueRow } from '@/components/app-ui/form-kit';
import { ListRow } from '@/components/app-ui/ListRow';
import { Tag } from '@/components/app-ui/Tag';
import { planLine, type AdminTranslate } from '../data/format';
import type { FilterType, UserListItem } from '../data/types';
import type { useUsers } from '../data/use-users';
import { LoadFailed, Waiting } from './parts';

/** The filters in the order they show, by the message of each (admin.users.filters.*). */
const FILTERS: { value: FilterType; label: string }[] = [
  { value: 'all', label: 'users.filters.all' },
  { value: 'trial', label: 'users.filters.trial' },
  { value: 'paid', label: 'users.filters.paid' },
  { value: 'free', label: 'users.filters.free' },
  { value: 'override', label: 'users.filters.override' },
];

export interface UsersViewProps {
  users: ReturnType<typeof useUsers>;
  /** The name of the person just deleted: the notice says so, once. */
  deleted: string | null;
  onBack: () => void;
  /** A tap on a row: the person's database id. */
  onOpenUser: (targetUserId: number) => void;
}

export function UsersView({ users, deleted, onBack, onOpenUser }: UsersViewProps) {
  const t = useTranslations('admin');
  const ui = useTranslations('ui');
  const locale = useLocale();
  const { load } = users;
  useEffect(() => {
    void load();
  }, [load]);

  const line = (user: UserListItem) => [planLine(user, t as unknown as AdminTranslate, locale), user.telegramId === null ? t('users.whatsapp') : null].filter(Boolean).join(' · ');

  return (
    <>
      <ScreenHeader title={t('users.title')} backLabel={ui('back')} onBack={onBack} />
      <div className="ch-form-page ch-form-page-grouped">
        {deleted ? <Notice>{t('users.deleted', { name: deleted })}</Notice> : null}
        {users.status === 'failed' ? <LoadFailed onRetry={() => void load()} /> : null}
        <FormCard>
          <TextField label={t('users.search')} placeholder={t('users.search')} value={users.search} onChange={users.setSearch} />
        </FormCard>
        <FormCard>
          <ValueRow label={t('users.filter')} value={users.filter} options={FILTERS.map((f) => ({ value: f.value, text: t(f.label) }))} onChange={(value) => users.setFilter(value as FilterType)} />
        </FormCard>
        {users.status === 'loading' ? <Waiting /> : null}
        {users.status === 'ready' && users.filtered.length > 0 ? <p className="ch-form-fixed">{t('users.count', { count: users.filtered.length })}</p> : null}
        {users.status === 'ready' && users.filtered.length === 0 ? <p className="ch-form-fixed">{t('users.empty')}</p> : null}
        {users.filtered.length > 0 ? (
          <FormCard>
            {users.filtered.map((user) => (
              <ListRow
                key={user.id}
                title={user.name}
                meta={line(user)}
                tags={
                  user.suspendedAt || user.earlyAdopter || user.hasOverride ? (
                    <>
                      {user.suspendedAt ? <Tag tone="danger">{t('users.suspended')}</Tag> : null}
                      {user.earlyAdopter ? <Tag>{t('users.earlyAccess')}</Tag> : null}
                      {user.hasOverride ? <Tag tone="muted">{t('users.overrides')}</Tag> : null}
                    </>
                  ) : undefined
                }
                onClick={() => onOpenUser(user.id)}
              />
            ))}
          </FormCard>
        ) : null}
      </div>
    </>
  );
}
