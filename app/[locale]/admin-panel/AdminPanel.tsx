'use client';

// The admin panel, once it has loaded (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design): an AppScreen on the
// grouped ground that shows one view of an in-page stack, with no routes of its own. It owns what outlives a view: the five
// switches, the people list with its search and filter (so coming back from a profile finds them), and the feedback and
// blocklist lists the Overview counts.
//
// - Back has one owner, AppScreen (Telegram's BackButton, and the header's own back in a browser). It closes the sheet that is
//   open first (a sheet registers its closer, ./navigation.tsx, and one that is working registers none that acts), then pops
//   the view; at the root it returns to the calendar in the page's language, with the VIEWER's Telegram id, which is the one
//   place that id is used (every request about a person carries that person's database id).
// - Each view asks for its data when it opens; the root asks for the feedback and blocklist counts.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { FORM_CSS } from '@/components/app-ui/form-kit';
import { ADMIN_CSS } from './admin-css';
import { useAdminSettings } from './data/use-admin-settings';
import { useBlocklist } from './data/use-blocklist';
import { useFeedback } from './data/use-feedback';
import type { AdminFlags, AdminStats } from './data/types';
import { SheetBackContext, useSheetBackRegistry, useViewStack, type AdminView } from './navigation';
import { ActivityView } from './views/ActivityView';
import { BlockedView } from './views/BlockedView';
import { FeedbackView } from './views/FeedbackView';
import { Overview } from './views/Overview';

export interface AdminPanelProps {
  /** The page's ?user_id: the viewer's Telegram id. Only the way back to the calendar uses it. */
  viewerTelegramId: number;
  locale: string;
  stats: AdminStats;
  flags: AdminFlags;
}

export default function AdminPanel({ viewerTelegramId, locale, stats, flags: initialFlags }: AdminPanelProps) {
  const router = useRouter();
  const stack = useViewStack();
  const sheets = useSheetBackRegistry();
  const settings = useAdminSettings(initialFlags);
  const feedback = useFeedback();
  const blocklist = useBlocklist();
  const view = stack.current;
  const { push, pop, depth } = stack;
  const { load: loadFeedback } = feedback;
  const { load: loadBlocklist } = blocklist;

  // The Overview shows how many messages and blocked entries there are
  const atRoot = view.kind === 'root';
  useEffect(() => {
    if (!atRoot) return;
    void loadFeedback();
    void loadBlocklist();
  }, [atRoot, loadFeedback, loadBlocklist]);

  const back = () => {
    if (sheets.closeTop()) return;
    if (depth > 1) pop();
    else router.push(`/${locale}/dashboard?user_id=${viewerTelegramId}`);
  };
  const openUser = (targetUserId: number) => push({ kind: 'user', id: targetUserId });

  const show = (current: AdminView) => {
    switch (current.kind) {
      case 'root':
        return (
          <Overview
            stats={stats}
            flags={settings.flags}
            saving={settings.saving}
            setFlag={settings.setFlag}
            feedbackCount={feedback.total}
            blockedCount={blocklist.status === 'ready' ? blocklist.entries.length : null}
            onOpen={push}
            onBack={back}
          />
        );
      case 'activity':
        return <ActivityView onBack={back} onOpenUser={openUser} />;
      case 'feedback':
        return <FeedbackView feedback={feedback} onBack={back} />;
      case 'blocked':
        return <BlockedView blocklist={blocklist} onBack={back} />;
      case 'users':
      case 'user':
        return null;
    }
  };

  return (
    <AppScreen ground="grouped" onBack={back}>
      <style>{FORM_CSS}</style>
      <style>{ADMIN_CSS}</style>
      <SheetBackContext value={sheets}>{show(view)}</SheetBackContext>
    </AppScreen>
  );
}
