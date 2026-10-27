'use client';

// The admin panel, once it has loaded (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design): an AppScreen on the
// grouped ground that shows one view of an in-page stack, with no routes of its own. It owns what outlives a view: the five
// switches, the people list with its search and filter (so coming back from a profile finds them), and the feedback and
// blocklist lists the Overview counts.
//
// - Back has one owner, AppScreen (Telegram's BackButton, and the header's own back in a browser). It closes the sheet that is
//   open first (a sheet registers its closer, ./navigation.tsx, and one that is working registers none that acts), then pops
//   the view; at the root it returns to the calendar in the page's language, with the VIEWER's Telegram id, which is the one
//   place that id is used besides telling the viewer's own profile (every request about a person carries that person's database id).
// - Each view asks for its data when it opens; the root asks for the feedback and blocklist counts.
// - A person that was deleted is said once, on the people list the panel goes back to: the notice goes with the next move.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { FORM_CSS } from '@/components/app-ui/form-kit';
import { ADMIN_CSS } from './admin-css';
import { useAdminSettings } from './data/use-admin-settings';
import { useBlocklist } from './data/use-blocklist';
import { useFeedback } from './data/use-feedback';
import { useUsers } from './data/use-users';
import type { AdminFlags, AdminStats } from './data/types';
import { SheetBackContext, useSheetBackRegistry, useViewStack, type AdminView } from './navigation';
import { ActivityView } from './views/ActivityView';
import { BlockedView } from './views/BlockedView';
import { FeedbackView } from './views/FeedbackView';
import { Overview } from './views/Overview';
import { UserProfile } from './views/UserProfile';
import { UsersView } from './views/UsersView';

export interface AdminPanelProps {
  /** The page's ?user_id: the viewer's Telegram id. The way back to the calendar, and who the viewer's own profile is. */
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
  const users = useUsers();
  const feedback = useFeedback();
  const blocklist = useBlocklist();
  /** The name of the person just deleted, until the next move. */
  const [deleted, setDeleted] = useState<string | null>(null);
  const view = stack.current;
  const { push, pop, depth } = stack;
  const { load: loadFeedback } = feedback;
  const { load: loadBlocklist } = blocklist;
  const { load: loadUsers } = users;

  // The Overview shows how many messages and blocked entries there are
  const atRoot = view.kind === 'root';
  useEffect(() => {
    if (!atRoot) return;
    void loadFeedback();
    void loadBlocklist();
  }, [atRoot, loadFeedback, loadBlocklist]);

  const open = (next: AdminView) => {
    setDeleted(null);
    push(next);
  };
  const back = () => {
    if (sheets.closeTop()) return;
    if (depth > 1) {
      setDeleted(null);
      pop();
    } else {
      router.push(`/${locale}/dashboard?user_id=${viewerTelegramId}`);
    }
  };
  const openUser = (targetUserId: number) => open({ kind: 'user', id: targetUserId });

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
            onOpen={open}
            onBack={back}
          />
        );
      case 'users':
        return <UsersView users={users} deleted={deleted} onBack={back} onOpenUser={openUser} />;
      case 'user':
        return (
          <UserProfile
            key={current.id}
            targetUserId={current.id}
            viewerTelegramId={viewerTelegramId}
            earlyAccessOn={settings.flags.earlyAdoptionMode}
            onUsersChanged={loadUsers}
            onBack={back}
            onDeleted={(name) => {
              pop();
              setDeleted(name);
            }}
          />
        );
      case 'activity':
        return <ActivityView onBack={back} onOpenUser={openUser} />;
      case 'feedback':
        return <FeedbackView feedback={feedback} onBack={back} />;
      case 'blocked':
        return <BlockedView blocklist={blocklist} onBack={back} />;
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
