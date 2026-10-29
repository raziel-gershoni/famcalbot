'use client';

// One person's profile: what GET user-overrides?user_id= answers, their recent activity, and every action an admin takes on them.
//
// - `targetUserId` is the database id (a list row's `id`). Every request here carries it, and only it: the page's ?user_id
//   (the viewer's Telegram id) never comes in. An action reads the person it is for when it starts and finishes for that
//   person, so a tap on one person can never change another.
// - `load(id)` is guarded: a newer load makes an older answer stale, so two quick opens show the last one's data only.
//   The activity list has its own guard, and "Show more" ignores a tap while a page is on its way.
// - An action answers an Outcome and, when it worked, reloads the profile (kept on screen meanwhile) and the people list
//   (`onUsersChanged`) before it returns; `working` names the action until then. A failed action changes nothing and is
//   not reloaded. The caller words the failure in the page's language; the request helper has logged it.
// - Deleting the person reloads the list only, with the profile and `working` still there until it has answered; then the profile
//   is cleared, and the caller (which has the answer in the same turn) leaves the screen.

import { useCallback, useEffect, useRef, useState } from 'react';
import { adminDelete, adminGet, adminPost, BUSY, outcomeOf, type AdminFailure, type AdminResult, type Outcome } from './admin-api';
import type { LoadStatus } from './use-users';
import type { ActivityAnswer, ActivityItem, OverrideInput, ReminderType, UserDetailAnswer, UserOverrideDetails } from './types';

export const ACTIVITY_PAGE = 20;

export type ProfileAction = 'saveOverrides' | 'grantComp' | 'revokeComp' | 'refund' | 'sendReminder' | 'resetReminders' | 'switchToWhatsApp' | 'suspend' | 'unsuspend' | 'hardDelete' | 'ban';

export interface ProfileActivity {
  items: ActivityItem[];
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
}
const NO_ACTIVITY: ProfileActivity = { items: [], hasMore: false, loading: false, failed: false };

/** No person is open, or the one asked for is not (an action came after the profile went). */
export const NO_TARGET: AdminFailure = { ok: false, status: 0, code: 'NO_TARGET' };
/** A ban asked for no identifier the person has. */
export const NO_IDENTIFIER: AdminFailure = { ok: false, status: 0, code: 'NO_IDENTIFIER' };

const orNull = (text: string | null | undefined): string | null => (text && text.trim() ? text : null);

export function useUserProfile(onUsersChanged: () => unknown) {
  const [profile, setProfile] = useState<UserOverrideDetails | null>(null);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [activity, setActivity] = useState<ProfileActivity>(NO_ACTIVITY);
  const [working, setWorking] = useState<ProfileAction | null>(null);

  // The person open now, the latest loads, and what the async code reads after an await
  const target = useRef<number | null>(null);
  const profileSeq = useRef(0);
  const activitySeq = useRef(0);
  const activityBusy = useRef(false);
  const itemsRef = useRef<ActivityItem[]>([]);
  const profileRef = useRef<UserOverrideDetails | null>(null);
  const acting = useRef<ProfileAction | null>(null);
  const usersChanged = useRef(onUsersChanged);
  useEffect(() => {
    usersChanged.current = onUsersChanged;
  });
  useEffect(
    () => () => {
      // Gone: nothing that is still on its way may land
      profileSeq.current++;
      activitySeq.current++;
    },
    [],
  );

  const loadActivity = useCallback(async (id: number, reset: boolean) => {
    if (!reset && activityBusy.current) return;
    const mine = reset ? ++activitySeq.current : activitySeq.current;
    activityBusy.current = true;
    setActivity((a) => ({ ...a, loading: true, failed: false }));
    const offset = reset ? 0 : itemsRef.current.length;
    const result = await adminGet<ActivityAnswer>('user-activity', { user_id: id, limit: ACTIVITY_PAGE, offset });
    if (mine !== activitySeq.current) return;
    activityBusy.current = false;
    if (!result.ok) {
      setActivity((a) => ({ ...a, loading: false, failed: true }));
      return;
    }
    const page = result.data.activities ?? [];
    const known = new Set(reset ? [] : itemsRef.current.map((item) => item.id));
    itemsRef.current = reset ? page : [...itemsRef.current, ...page.filter((item) => !known.has(item.id))];
    setActivity({ items: itemsRef.current, hasMore: result.data.pagination?.hasMore ?? false, loading: false, failed: false });
  }, []);

  const fetchProfile = useCallback(async (id: number, mine: number) => {
    const result = await adminGet<UserDetailAnswer>('user-overrides', { user_id: id });
    if (mine !== profileSeq.current) return;
    if (result.ok && result.data.user) {
      profileRef.current = result.data.user;
      setProfile(result.data.user);
      setStatus('ready');
    } else if (!profileRef.current) {
      setStatus('failed');
    }
  }, []);

  /** Open a person: nothing of the one before stays, and their profile and first page of activity are asked for. */
  const load = useCallback(
    async (targetUserId: number) => {
      target.current = targetUserId;
      const mine = ++profileSeq.current;
      profileRef.current = null;
      itemsRef.current = [];
      setProfile(null);
      setStatus('loading');
      setActivity(NO_ACTIVITY);
      await Promise.all([fetchProfile(targetUserId, mine), loadActivity(targetUserId, true)]);
    },
    [fetchProfile, loadActivity],
  );

  /** Forget the person (they are gone): the screen has nothing to show, and nothing on its way lands. */
  const clear = useCallback(() => {
    target.current = null;
    profileSeq.current++;
    activitySeq.current++;
    activityBusy.current = false;
    profileRef.current = null;
    itemsRef.current = [];
    setProfile(null);
    setStatus('idle');
    setActivity(NO_ACTIVITY);
  }, []);

  const loadMoreActivity = useCallback(async () => {
    if (target.current !== null) await loadActivity(target.current, false);
  }, [loadActivity]);

  /**
   * One action on the person open now. `run` sends it for `id`; a success reloads the profile and the list (or, for a
   * delete, the list alone) before this answers.
   */
  const act = useCallback(
    async (action: ProfileAction, run: (id: number) => Promise<AdminResult<unknown>>): Promise<Outcome> => {
      const id = target.current;
      if (id === null) return NO_TARGET;
      if (acting.current) return BUSY;
      acting.current = action;
      setWorking(action);
      try {
        const outcome = outcomeOf(await run(id));
        if (!outcome.ok) return outcome;
        if (action === 'hardDelete') {
          // The list first, with the profile (and the sheet's working lock) still on screen; only then is the person gone
          await usersChanged.current();
          if (target.current === id) clear();
        } else {
          await Promise.all([target.current === id ? fetchProfile(id, ++profileSeq.current) : undefined, usersChanged.current()]);
        }
        return outcome;
      } finally {
        acting.current = null;
        setWorking(null);
      }
    },
    [clear, fetchProfile],
  );

  const saveOverrides = (input: OverrideInput) =>
    act('saveOverrides', (id) =>
      adminPost('user-overrides', {
        user_id: id,
        unlimitedSummaries: input.unlimitedSummaries || null,
        remindersEnabled: input.remindersEnabled || null,
        voiceEventsEnabled: input.voiceEventsEnabled || null,
        unlimitedCalendars: input.unlimitedCalendars || null,
        earlyAdopter: input.earlyAdopter || false,
        reason: orNull(input.reason),
      }),
    );
  const grantComp = (reason: string) => act('grantComp', (id) => adminPost('subscription', { user_id: id, reason: orNull(reason) }));
  const revokeComp = () => act('revokeComp', (id) => adminDelete('subscription', { user_id: id }));
  /** Refund one payment at Telegram, by its row's id; it is recorded only when Telegram agrees (the route answers REFUND_REFUSED when it does not). */
  const refund = (paymentId: string) => act('refund', (id) => adminPost('subscription', { user_id: id, action: 'refund', payment_id: paymentId }));
  const sendReminder = (reminderType: ReminderType) => act('sendReminder', (id) => adminPost('send-reminder', { user_id: id, reminder_type: reminderType }));
  const resetReminders = () => act('resetReminders', (id) => adminPost('reset-reminders', { user_id: id }));
  const switchToWhatsApp = (phone: string) => act('switchToWhatsApp', (id) => adminPost('switch-platform', { user_id: id, whatsapp_phone: phone.trim() }));
  const suspend = (reason: string) => act('suspend', (id) => adminPost('users/moderation', { action: 'suspend', user_id: id, reason: orNull(reason) }));
  const unsuspend = () => act('unsuspend', (id) => adminPost('users/moderation', { action: 'unsuspend', user_id: id, reason: null }));
  /** `confirmation` is what the person typed; the route accepts only DELETE. */
  const hardDelete = (confirmation: string) => act('hardDelete', (id) => adminPost('users/moderation', { action: 'hard_delete', user_id: id, reason: null, confirmation }));
  /** Block the person's own Telegram id and/or WhatsApp number (read from the profile open now), so they cannot register again. */
  const ban = async (what: { telegram: boolean; whatsapp: boolean; reason: string }): Promise<Outcome> => {
    const open = profileRef.current;
    if (!open || open.id !== target.current) return NO_TARGET;
    const telegramId = what.telegram ? open.telegramId : null;
    const whatsappPhone = what.whatsapp ? open.whatsappPhone : null;
    if (telegramId === null && !whatsappPhone) return NO_IDENTIFIER;
    return act('ban', () => adminPost('users/blocklist', { action: 'ban', telegramId, whatsappPhone, reason: orNull(what.reason) }));
  };

  /** The profile as it is now (a reload that finished a moment ago, before the next render): what a draft is rebuilt from. */
  const current = () => profileRef.current;

  return { profile, status, activity, working, current, load, clear, loadMoreActivity, saveOverrides, grantComp, revokeComp, refund, sendReminder, resetReminders, switchToWhatsApp, suspend, unsuspend, hardDelete, ban };
}
