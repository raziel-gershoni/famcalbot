'use client';

// Everyone's activity log (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > Activity): the action filter
// (fed by the route's counts per action), the rows newest first (who, what, the detail, how long ago), and Show more in pages of
// 20. A tap on a row opens that person's profile. The list is asked for once when the screen opens (useActivity).

import { useLocale, useTranslations } from 'next-intl';
import { ScreenHeader } from '@/components/app-ui/ScreenHeader';
import { FormCard, ValueRow } from '@/components/app-ui/form-kit';
import { ListRow } from '@/components/app-ui/ListRow';
import { activityDetail } from '@/src/lib/admin-activity';
import { relativeTime } from '../data/format';
import type { ActivityItem } from '../data/types';
import { useActivity } from '../data/use-activity';
import { LoadFailed, ShowMore, Waiting } from './parts';
import { Notice } from '@/components/app-ui/Notice';

/** One row's quiet text: how long ago, then the action (a code, always left to right) and its detail. */
export function ActivityMeta({ item, locale }: { item: ActivityItem; locale: string }) {
  const detail = activityDetail(item.action, item.metadata);
  return (
    <>
      <span className="ch-admin-line">{relativeTime(item.createdAt, locale)}</span>
      <span className="ch-admin-line">
        <bdi dir="ltr">{item.action}</bdi>
        {detail ? (
          <>
            {' · '}
            <bdi dir="auto">{detail}</bdi>
          </>
        ) : null}
      </span>
    </>
  );
}

export function ActivityView({ onBack, onOpenUser }: { onBack: () => void; onOpenUser: (targetUserId: number) => void }) {
  const t = useTranslations('admin');
  const ui = useTranslations('ui');
  const locale = useLocale();
  const log = useActivity();
  const options = [{ value: '', text: t('activity.allActions') }, ...log.stats.map((stat) => ({ value: stat.action, text: `${stat.action} (${stat.count})` }))];

  return (
    <>
      <ScreenHeader title={t('activity.title')} backLabel={ui('back')} onBack={onBack} />
      <div className="ch-form-page ch-form-page-grouped">
        {log.status === 'failed' ? <LoadFailed onRetry={log.retry} /> : null}
        <FormCard>
          <ValueRow label={t('activity.filter')} value={log.filter} options={options} onChange={log.setFilter} />
        </FormCard>
        {log.status === 'loading' ? <Waiting /> : null}
        {log.status === 'ready' && log.items.length === 0 ? <p className="ch-form-fixed">{t('activity.noActivity')}</p> : null}
        {log.items.length > 0 ? (
          <FormCard>
            {log.items.map((item) => (
              <ListRow key={item.id} title={item.userName} meta={<ActivityMeta item={item} locale={locale} />} onClick={() => onOpenUser(item.userId)} />
            ))}
          </FormCard>
        ) : null}
        {log.moreFailed ? <Notice tone="error">{t('errors.generic')}</Notice> : null}
        {log.hasMore ? <ShowMore busy={log.loadingMore} onClick={() => void log.loadMore()} /> : null}
      </div>
    </>
  );
}
