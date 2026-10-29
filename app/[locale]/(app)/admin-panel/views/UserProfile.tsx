'use client';

// One person (plan docs/superpowers/plans/2026-10-27-app-ui-A-admin-panel.md, Design > User profile): a screen of its own, titled with
// their name, in seven parts: who they are, their plan, their setup, the features switched on for them, how they are messaged, their
// recent activity, and what can be done to the account.
//
// - `targetUserId` is the person's database id (the row that was tapped); every request on this screen carries it. The viewer's Telegram
//   id is used for one thing only: to know the person is the viewer, who then gets no way to lock themselves out.
// - The shell keys this screen by the person, so another person is a new screen with nothing of the last one on it (no notice, no
//   draft); the profile hook drops an answer that comes for someone else as well.
// - An action that works reloads the profile (kept on screen meanwhile) and the people list. A delete goes back to the list.

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { ScreenHeader } from '@/components/app-ui/ScreenHeader';
import { useUserProfile } from '../data/use-user-profile';
import { LoadFailed, Waiting } from './parts';
import { Account } from './profile/Account';
import { FeatureAccess } from './profile/FeatureAccess';
import { Messaging } from './profile/Messaging';
import { Plan } from './profile/Plan';
import { ProfileActivity } from './profile/ProfileActivity';
import { Setup } from './profile/Setup';
import { Who } from './profile/Who';

export interface UserProfileProps {
  targetUserId: number;
  viewerTelegramId: number;
  /** Early access is on for everyone (the Overview's switch). */
  earlyAccessOn: boolean;
  /** The people list changed (an action worked): ask for it again. */
  onUsersChanged: () => unknown;
  onBack: () => void;
  /** The account was deleted: go back to the list and say whose it was. */
  onDeleted: (name: string) => void;
}

export function UserProfile({ targetUserId, viewerTelegramId, earlyAccessOn, onUsersChanged, onBack, onDeleted }: UserProfileProps) {
  const t = useTranslations('admin');
  const ui = useTranslations('ui');
  const profile = useUserProfile(onUsersChanged);
  const { load } = profile;
  useEffect(() => {
    void load(targetUserId);
  }, [load, targetUserId]);

  const person = profile.profile;
  const isSelf = person !== null && person.telegramId !== null && person.telegramId === viewerTelegramId;

  return (
    <>
      <ScreenHeader title={person?.name ?? t('profile.title')} backLabel={ui('back')} onBack={onBack} />
      <div className="ch-form-page ch-form-page-grouped">
        {profile.status === 'failed' ? <LoadFailed onRetry={() => void load(targetUserId)} /> : null}
        {profile.status === 'loading' ? <Waiting /> : null}
        {person ? (
          <>
            <Who person={person} />
            <Plan person={person} profile={profile} isSelf={isSelf} earlyAccessOn={earlyAccessOn} />
            <Setup person={person} profile={profile} isSelf={isSelf} />
            <FeatureAccess person={person} profile={profile} isSelf={isSelf} />
            <Messaging person={person} profile={profile} isSelf={isSelf} />
            <ProfileActivity profile={profile} />
            <Account person={person} profile={profile} isSelf={isSelf} onDeleted={onDeleted} />
          </>
        ) : null}
      </div>
    </>
  );
}
