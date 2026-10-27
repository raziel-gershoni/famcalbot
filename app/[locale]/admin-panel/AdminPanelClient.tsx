'use client';

// The admin panel's entry (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md): it asks the admin-only routes for
// the switches and the counts, and shows the loader (the app's, on the grouped ground), the denied card, the error card with its
// retry, or the panel (./AdminPanel.tsx).
//
// - The server HTML carries none of it: the page renders this same shell for every user_id and looks no one up. 401/403
//   (no initData, or not an admin) is 'denied'.
// - The panel works only inside Telegram, as it always has: the admin routes read the launch data, which is the only credential.
// - `userId` is the page's ?user_id: the viewer's Telegram id. It goes on as `viewerTelegramId` and is used only for the way
//   back to the calendar.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { StateCard } from '@/components/app-ui/StateCard';
import { PageLoader, startMiniApp } from '../PageGate';
import AdminPanel from './AdminPanel';
import { adminGet } from './data/admin-api';
import type { AdminFlags, AdminStats, SettingsAnswer, StatsAnswer } from './data/types';

interface AdminPanelClientProps {
  /** The page's ?user_id: the viewer's Telegram id, for the link back to the dashboard. */
  userId: number;
  locale: string;
}

/** What the panel starts from: the switches and the user counts. */
type AdminPanelInitial = AdminFlags & { stats: AdminStats };

export type AdminPanelLoad =
  | { kind: 'ready'; initial: AdminPanelInitial }
  | { kind: 'denied' }
  | { kind: 'error' };

/**
 * The panel's starting data, from the admin-only APIs with initData in the header. The
 * server HTML carries none of it: the page renders this same shell for every user_id.
 * 401/403 (no initData, or not an admin) is 'denied'.
 */
export async function loadAdminPanel(): Promise<AdminPanelLoad> {
  const [settings, stats] = await Promise.all([adminGet<SettingsAnswer>('settings'), adminGet<StatsAnswer>('stats')]);
  if ([settings, stats].some((result) => !result.ok && (result.status === 401 || result.status === 403))) return { kind: 'denied' };
  if (!settings.ok || !stats.ok) return { kind: 'error' };
  return {
    kind: 'ready',
    initial: {
      stats: stats.data.stats,
      remindersEnabled: settings.data.remindersEnabled ?? false,
      earlyAdoptionMode: settings.data.earlyAdoptionMode ?? false,
      voiceAutoCreateHighConf: settings.data.voiceAutoCreateHighConf ?? false,
      voiceTtsOutcome: settings.data.voiceTtsOutcome ?? false,
      nativeRemindersEnabled: settings.data.nativeRemindersEnabled ?? true,
    },
  };
}

/** What a non-admin gets: a card in the app's look, in the page's language. */
export function AdminUnauthorized() {
  const t = useTranslations('admin');
  return (
    <AppScreen>
      <StateCard tone="crash" title={t('unauthorized.title')} body={t('unauthorized.body')} />
    </AppScreen>
  );
}

/** The data could not be loaded: the app's error card, with its retry. */
function AdminLoadError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('pageGate');
  return (
    <AppScreen>
      <StateCard tone="crash" title={t('errorTitle')} body={t('errorBody')} action={{ label: t('retry'), onClick: onRetry }} />
    </AppScreen>
  );
}

export default function AdminPanelClient({ userId, locale }: AdminPanelClientProps) {
  const viewerTelegramId = userId;
  const [load, setLoad] = useState<AdminPanelLoad | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Full height at mount while the data loads; the app's look sets no colour of its own on Telegram's chrome
  useEffect(() => {
    startMiniApp('app');
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadAdminPanel().then((next) => {
      if (!cancelled) setLoad(next);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (!load) return <PageLoader look="app" ground="grouped" />;
  if (load.kind === 'denied') return <AdminUnauthorized />;
  if (load.kind === 'error') {
    return (
      <AdminLoadError
        onRetry={() => {
          setLoad(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  const { stats, ...flags } = load.initial;
  return <AdminPanel viewerTelegramId={viewerTelegramId} locale={locale} stats={stats} flags={flags} />;
}
