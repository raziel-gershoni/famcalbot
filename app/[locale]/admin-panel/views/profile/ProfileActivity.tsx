'use client';

// The person's recent activity (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > User profile 6): 20 rows (the
// action, its detail, how long ago), then "Show more". The lines are plain blocks that read in the page's direction (the action code and
// the detail are isolated inside them, as in the log's rows), so a Hebrew row starts on the right. The list belongs to the profile hook, which asks for it with the profile and
// drops a page that comes for another person. The page is as long as it needs to be: nothing clips it, so Account is always reachable.

import { useLocale, useTranslations } from 'next-intl';
import { FormCard } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { SectionLabel } from '@/components/app-ui/ScreenHeader';
import { activityDetail } from '@/src/lib/admin-activity';
import { relativeTime } from '../../data/format';
import { LoadFailed, ShowMore, Waiting } from '../parts';
import type { ProfileHook } from './shared';

export function ProfileActivity({ profile }: { profile: ProfileHook }) {
  const t = useTranslations('admin');
  const locale = useLocale();
  const { activity } = profile;

  return (
    <>
      <SectionLabel>{t('activity.userTitle')}</SectionLabel>
      {activity.failed && activity.items.length === 0 ? <LoadFailed onRetry={() => void profile.loadMoreActivity()} /> : null}
      {activity.loading && activity.items.length === 0 ? <Waiting /> : null}
      {!activity.loading && !activity.failed && activity.items.length === 0 ? <p className="ch-form-fixed">{t('activity.noActivity')}</p> : null}
      {activity.items.length > 0 ? (
        <FormCard>
          {activity.items.map((item) => {
            const detail = activityDetail(item.action, item.metadata);
            return (
              <div key={item.id} className="ch-form-row">
                <span className="ch-form-label">
                  <span className="ch-admin-line">
                    <bdi dir="ltr">{item.action}</bdi>
                  </span>
                  {detail ? (
                    <span className="ch-form-hint">
                      <bdi dir="auto">{detail}</bdi>
                    </span>
                  ) : null}
                </span>
                <span className="ch-form-value">{relativeTime(item.createdAt, locale)}</span>
              </div>
            );
          })}
        </FormCard>
      ) : null}
      {activity.failed && activity.items.length > 0 ? <Notice tone="error">{t('errors.generic')}</Notice> : null}
      {activity.hasMore ? <ShowMore busy={activity.loading} onClick={() => void profile.loadMoreActivity()} /> : null}
    </>
  );
}
