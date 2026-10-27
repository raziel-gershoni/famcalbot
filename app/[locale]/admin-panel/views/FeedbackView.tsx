'use client';

// What people sent through the feedback form (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > Feedback):
// the newest first, each as a row with the sender, the first lines of the message, how long ago and where it came from. A tap
// opens the whole message in a sheet, in its own direction, with its date. Show more when the route says there is more.

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ScreenHeader } from '@/components/app-ui/ScreenHeader';
import { FormCard } from '@/components/app-ui/form-kit';
import { ListRow } from '@/components/app-ui/ListRow';
import { Tag } from '@/components/app-ui/Tag';
import { dateTime24, relativeTime } from '../data/format';
import type { FeedbackItem } from '../data/types';
import type { useFeedback } from '../data/use-feedback';
import { AdminSheet } from '../sheets';
import { firstLine, LoadFailed, ShowMore, Waiting } from './parts';
import { Notice } from '@/components/app-ui/Notice';

export function FeedbackView({ feedback, onBack }: { feedback: ReturnType<typeof useFeedback>; onBack: () => void }) {
  const t = useTranslations('admin');
  const ui = useTranslations('ui');
  const locale = useLocale();
  const { load } = feedback;
  const [open, setOpen] = useState<FeedbackItem | null>(null);
  useEffect(() => {
    void load();
  }, [load]);

  const source = (item: FeedbackItem) => (item.source === 'telegram' ? t('feedback.telegram') : t('feedback.dashboard'));

  return (
    <>
      <ScreenHeader title={t('feedback.title')} backLabel={ui('back')} onBack={onBack} />
      <div className="ch-form-page ch-form-page-grouped">
        {feedback.status === 'failed' ? <LoadFailed onRetry={() => void load()} /> : null}
        {feedback.status === 'loading' ? <Waiting /> : null}
        {feedback.status === 'ready' && feedback.items.length === 0 ? <p className="ch-form-fixed">{t('feedback.noFeedback')}</p> : null}
        {feedback.items.length > 0 ? (
          <FormCard>
            {feedback.items.map((item) => (
              <ListRow
                key={item.id}
                title={item.userName}
                meta={
                  <>
                    <span className="ch-admin-line ch-admin-clamp">
                      <bdi dir="auto">{firstLine(item.text)}</bdi>
                    </span>
                    <span className="ch-admin-line">{relativeTime(item.createdAt, locale)}</span>
                  </>
                }
                tags={<Tag tone="muted">{source(item)}</Tag>}
                onClick={() => setOpen(item)}
              />
            ))}
          </FormCard>
        ) : null}
        {feedback.moreFailed ? <Notice tone="error">{t('errors.generic')}</Notice> : null}
        {feedback.hasMore ? <ShowMore busy={feedback.loadingMore} onClick={() => void feedback.loadMore()} /> : null}
      </div>

      {open ? (
        <AdminSheet label={open.userName} closeLabel={ui('done')} onClose={() => setOpen(null)}>
          <h2 className="ch-sheet-heading" dir="auto">
            {open.userName}
          </h2>
          <p className="ch-sheet-sub">
            {t('feedback.sentAt', { date: dateTime24(open.createdAt, locale) })} <Tag tone="muted">{source(open)}</Tag>
          </p>
          <p className="ch-admin-text" dir="auto">
            {open.text}
          </p>
        </AdminSheet>
      ) : null}
    </>
  );
}
