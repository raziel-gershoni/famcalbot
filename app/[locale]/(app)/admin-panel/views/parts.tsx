'use client';

// The small parts the panel's screens share: the spinner while a list loads, the notice with its retry when it didn't, and the
// button under a list that asks for the next page.

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Notice } from '@/components/app-ui/Notice';

/** A list is on its way. */
export function Waiting() {
  const pageGate = useTranslations('pageGate');
  return (
    <div className="ch-admin-wait" role="status">
      <Loader2 size={24} className="ch-spin" aria-hidden="true" />
      <span className="ch-visually-hidden">{pageGate('loading')}</span>
    </div>
  );
}

/** A list could not be loaded: what happened, and a way to try again. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('admin');
  const pageGate = useTranslations('pageGate');
  return (
    <Notice tone="error" action={{ label: pageGate('retry'), onClick: onRetry }}>
      {t('errors.load')}
    </Notice>
  );
}

/** "Show more" under a list: busy while the next page is on its way. */
export function ShowMore({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const t = useTranslations('admin');
  return (
    <button type="button" className="ch-btn ch-btn-outline ch-save" disabled={busy} aria-busy={busy || undefined} onClick={onClick}>
      {busy ? <span className="ch-form-spinner" aria-hidden="true" /> : null}
      {t('common.showMore')}
    </button>
  );
}

/** The first non-empty line of a text. */
export function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}
