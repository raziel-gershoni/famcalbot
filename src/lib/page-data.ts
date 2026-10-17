/**
 * Page data for the [locale] Mini App pages (server only).
 *
 * The pages used to load this during SSR for whatever ?user_id was in the URL, with no
 * credential, so the HTML carried the user's private data (the pair page even carried
 * the live invite token). Now a page renders no user data: PageGate posts to
 * /api/page-data, which proves the user with verifyUserAuth and calls loadPageData.
 *
 * The bodies below moved here unchanged from the six page.tsx files, except:
 * - select-calendars hands its Sets and Maps over as arrays (JSON); PageGate revives them;
 * - its insufficient-scopes path clears the Google token by DB id, not by telegramId;
 * - dashboard's trial end date travels as an ISO string; PageGate revives the Date;
 * - dashboard adds calendarHome and, when it is on, the calendar home's hints. PageGate
 *   picks the home with them and hands DashboardClient the rest.
 * The props are otherwise exactly what each page passed to its client component.
 */

import type { ComponentProps } from 'react';
import type DashboardClient from '@/app/[locale]/dashboard/DashboardClient';
import type SettingsClient from '@/app/[locale]/settings/SettingsClient';
import type SelectCalendarsClient from '@/app/[locale]/select-calendars/SelectCalendarsClient';
import type CalendarsClient from '@/app/[locale]/calendars/CalendarsClient';
import type PairClient from '@/app/[locale]/pair/PairClient';
import type SubscriptionClient from '@/app/[locale]/subscription/SubscriptionClient';
import { updateUserById } from '@/src/services/user-service';
import { getSubscriptionWithUsage, getTrialStatus, checkEarlyAdopterAccess, checkFeatureAccess } from '@/src/services/subscription-service';
import { isCalendarHomeOn } from '@/src/services/calendar-read/rollout';
import { getReminderSupport } from '@/src/services/native-reminders/support';
import { trackActivityAsync } from '@/src/services/analytics-service';
import { captureError } from '@/src/lib/error-capture';
import { listUserCalendars } from '@/src/services/calendar';
import { listVisibleCalendars } from '@/src/services/native-calendar/event-store';
import { getActivePartner, getActiveInvite } from '@/src/services/pairing-service';
import { getPlanLimits } from '@/src/config/plans';
import { buildUrl } from '@/src/config/urls';
import { normalizeLocale } from '@/src/utils/locale';
import { prisma } from '@/src/utils/prisma';
import type { CalendarAssignment, CalendarLabel, UserConfig } from '@/src/types';
import type { HomeHints } from '@/src/lib/calendar-view/home-props';

export const PAGE_NAMES = ['dashboard', 'settings', 'select-calendars', 'calendars', 'pair', 'subscription'] as const;
export type PageName = (typeof PAGE_NAMES)[number];

export function isPageName(value: unknown): value is PageName {
  return typeof value === 'string' && (PAGE_NAMES as readonly string[]).includes(value);
}

/** A static notice the page renders instead of its client component. */
export type PageNotice = 'notNative' | 'noGoogleToken' | 'error';

type DashboardProps = ComponentProps<typeof DashboardClient>;
type SelectCalendarsProps = ComponentProps<typeof SelectCalendarsClient>;

/**
 * Dashboard props on the wire: the trial end date is an ISO string, and calendarHome says
 * which home PageGate renders (calendar-home spec §7.1). DashboardClient never gets the
 * two new fields.
 */
export type DashboardPageProps = Omit<DashboardProps, 'trial'> & {
  trial: Omit<DashboardProps['trial'], 'trialEndsAt'> & { trialEndsAt: string | null };
  /** isCalendarHomeOn(user): CalendarHome instead of DashboardClient. */
  calendarHome: boolean;
  /** Set exactly when calendarHome is true: the empty state's how-to-add hints (Ruling R10). */
  hints?: HomeHints;
};

/** Select-calendars props on the wire: Sets and Maps as arrays. */
export type SelectCalendarsPageProps = Omit<SelectCalendarsProps, 'currentSelections'> & {
  currentSelections: {
    selectedCalendars: string[];
    calendarLabels: [string, CalendarLabel[]][];
    spouseInfo: SelectCalendarsProps['currentSelections']['spouseInfo'];
    calendarRules: [string, string][];
    globalRules: string[];
  };
};

export interface PagePropsMap {
  dashboard: DashboardPageProps;
  settings: ComponentProps<typeof SettingsClient>;
  'select-calendars': SelectCalendarsPageProps;
  calendars: ComponentProps<typeof CalendarsClient>;
  pair: ComponentProps<typeof PairClient>;
  subscription: ComponentProps<typeof SubscriptionClient>;
}

export type PageDataResult =
  | { kind: 'props'; props: PagePropsMap[PageName] }
  | { kind: 'redirect'; to: string }
  | { kind: 'notice'; notice: PageNotice; detail?: string }
  | { kind: 'notFound' };

/**
 * What the page shows for this user. `user` is the row verifyUserAuth proved;
 * `urlUserId` is the page's own ?user_id (a telegramId, or a DB id), which the client
 * components and the locale redirect keep using exactly as before.
 */
export async function loadPageData(
  page: PageName,
  user: UserConfig,
  urlUserId: number,
  locale: string
): Promise<PageDataResult> {
  // Check if URL locale matches user's language preference
  // normalizeLocale handles legacy values like 'Hebrew' -> 'he'
  const userLocale = normalizeLocale(user.language);
  if (locale !== userLocale) {
    // User's language was updated but they're using an old URL - redirect to correct locale
    return { kind: 'redirect', to: `/${userLocale}/${page}?user_id=${urlUserId}` };
  }

  switch (page) {
    case 'dashboard':
      return dashboard(user, urlUserId, locale);
    case 'settings':
      return settings(user, urlUserId, userLocale);
    case 'select-calendars':
      return selectCalendars(user, urlUserId, userLocale);
    case 'calendars':
      return calendars(user, urlUserId, userLocale);
    case 'pair':
      return pair(user, urlUserId, userLocale);
    case 'subscription':
      return subscription(user, urlUserId, locale);
  }
}

async function dashboard(user: UserConfig, userId: number, locale: string): Promise<PageDataResult> {
  // Check setup status. OAuth and calendar selection are GOOGLE-only — for
  // NATIVE users the calendar is auto-bootstrapped at signup, so the only
  // setup gap is location (handled in SettingsClient, not here).
  const isNative = user.calendarSource === 'NATIVE';
  const needsOAuth = !isNative && !user.googleRefreshToken;
  const needsCalendars = !isNative && (!user.calendarAssignments || user.calendarAssignments.length === 0);

  // Fetch subscription data, and whether the calendar home covers this user
  const [subWithUsage, trialStatus, isEarlyAdopter, home] = await Promise.all([
    getSubscriptionWithUsage(user.id),
    getTrialStatus(user.id),
    checkEarlyAdopterAccess(user.id),
    calendarHomeFor(user),
  ]);

  const subscription = subWithUsage ? {
    plan: subWithUsage.subscription.plan,
    status: subWithUsage.subscription.status,
    effectivePlan: subWithUsage.effectivePlan,
  } : null;

  const props: DashboardPageProps = {
    user: {
      id: userId,
      name: user.name,
      location: user.location,
      calendarsCount: user.calendarAssignments?.length || 0,
      isAdmin: user.isAdmin || false,
    },
    calendarAssignments: user.calendarAssignments || [],
    locale,
    calendarSource: user.calendarSource,
    needsOAuth,
    needsCalendars,
    subscription,
    trial: { ...trialStatus, trialEndsAt: trialStatus.trialEndsAt?.toISOString() ?? null },
    isEarlyAdopter,
    ...home,
  };
  // One open of the calendar home (spec §7.1), under the DB id like every activity
  if (home.calendarHome) trackActivityAsync(user.id, 'webapp_opened');
  return { kind: 'props', props };
}

/**
 * Whether the calendar home covers this user (the rollout switch, spec §1) and, only
 * then, its empty state's how-to-add hints (spec §7.3, Ruling R10). Users the switch
 * doesn't cover never run the two checks. Both are cheap: the feature checks are cached
 * for 24 h in Redis, and the native-reminders switch is read through Redis.
 * getReminderSupport already fails closed; a failed voice-events check does too, so a
 * hint never promises what the plan may lack and never fails the page.
 */
async function calendarHomeFor(
  user: UserConfig
): Promise<{ calendarHome: false } | { calendarHome: true; hints: HomeHints }> {
  if (!(await isCalendarHomeOn(user))) return { calendarHome: false };
  const [reminders, voiceEvents] = await Promise.all([
    getReminderSupport(user).then((support) => support.supported),
    checkFeatureAccess(user.id, 'voice_events').then(
      (access) => access.allowed,
      (error) => {
        captureError(error, 'calendar-home-hints', { user_id: user.id }, 'warning');
        return false;
      }
    ),
  ]);
  return { calendarHome: true, hints: { reminders, voiceEvents } };
}

async function settings(user: UserConfig, userId: number, userLocale: string): Promise<PageDataResult> {
  // Fetch admin settings and subscription data in parallel
  const [adminSettings, subWithUsage] = await Promise.all([
    prisma.adminSettings.findUnique({
      where: { id: 'global' }
    }).catch(() => null),
    getSubscriptionWithUsage(user.id).catch(() => null),
  ]);

  // Build subscription info for the client
  const effectivePlan = subWithUsage?.effectivePlan || 'FREE';
  const limits = getPlanLimits(effectivePlan);
  const isTrialing = subWithUsage?.subscription.status === 'TRIALING'
    && new Date() < subWithUsage.subscription.trialEndsAt;

  const subscriptionInfo = {
    effectivePlan,
    textSummariesUsed: subWithUsage?.usage.textSummariesUsed ?? 0,
    textSummariesLimit: limits.textSummaries === Infinity ? -1 : limits.textSummaries,
    voiceSummariesUsed: subWithUsage?.usage.voiceSummariesUsed ?? 0,
    voiceSummariesLimit: limits.voiceSummaries === Infinity ? -1 : limits.voiceSummaries,
    remindersAllowed: limits.reminders,
    isTrialing,
  };

  const props: PagePropsMap['settings'] = {
    userId,
    currentSettings: {
      language: userLocale,  // Pass normalized locale
      location: user.location,
      messagingPlatform: user.messagingPlatform,
      culture: user.culture || 'default',
      textSummaryEnabled: user.textSummaryEnabled,
      voiceSummaryEnabled: user.voiceSummaryEnabled,
      weatherEnabled: user.weatherEnabled,
      includeLookaheadInTomorrow: user.includeLookaheadInTomorrow,
      lookaheadAlways7Days: user.lookaheadAlways7Days,
      preferredMorningHour: user.preferredMorningHour,
      preferredEveningHour: user.preferredEveningHour,
      dailySummaryDays: user.dailySummaryDays,
      tomorrowSummaryDays: user.tomorrowSummaryDays,
      remindersEnabled: user.remindersEnabled,
      defaultReminderMinutes: user.defaultReminderMinutes ?? null,
      pickupRemindersEnabled: user.pickupRemindersEnabled ?? true,
      voiceInputEnabled: user.voiceInputEnabled
    },
    remindersGloballyEnabled: adminSettings?.remindersEnabled ?? false,
    subscriptionInfo,
  };
  return { kind: 'props', props };
}

// Convert calendarAssignments to state format (arrays here; PageGate makes the Sets and Maps)
function convertAssignmentsToSelections(
  assignments: CalendarAssignment[],
  userGlobalRules?: string[]
): SelectCalendarsPageProps['currentSelections'] {
  const selectedCalendars: string[] = [];
  const calendarLabels: [string, CalendarLabel[]][] = [];
  const calendarRules: [string, string][] = [];

  // Find spouse info from any spouse calendar that has it
  let spouseInfo: SelectCalendarsPageProps['currentSelections']['spouseInfo'] = null;

  for (const assignment of assignments) {
    // Same semantics as the Set and Map the page used to build: one entry per calendar,
    // the last assignment wins
    if (!selectedCalendars.includes(assignment.calendarId)) selectedCalendars.push(assignment.calendarId);
    setEntry(calendarLabels, assignment.calendarId, [...new Set(assignment.labels)]);

    // Extract spouse info from any spouse calendar (single source of truth)
    if (assignment.labels.includes('spouse') && !spouseInfo) {
      if (assignment.personName || assignment.personEnglishName || assignment.personGender) {
        spouseInfo = {
          personName: assignment.personName,
          personEnglishName: assignment.personEnglishName,
          personGender: assignment.personGender,
        };
      }
    }

    // Store calendar rule if present
    if (assignment.rules && assignment.rules.length > 0) {
      setEntry(calendarRules, assignment.calendarId, assignment.rules[0]);
    }
  }

  return { selectedCalendars, calendarLabels, spouseInfo, calendarRules, globalRules: userGlobalRules || [] };
}

/** Map.set on an entries array. */
function setEntry<V>(entries: [string, V][], key: string, value: V): void {
  const existing = entries.find(([k]) => k === key);
  if (existing) existing[1] = value;
  else entries.push([key, value]);
}

async function selectCalendars(user: UserConfig, userId: number, userLocale: string): Promise<PageDataResult> {
  if (!user.googleRefreshToken) {
    return { kind: 'notice', notice: 'noGoogleToken' };
  }

  try {
    const [availableCalendars, subWithUsage] = await Promise.all([
      listUserCalendars(user.googleRefreshToken),
      getSubscriptionWithUsage(user.id).catch(() => null),
    ]);

    const effectivePlan = subWithUsage?.effectivePlan || 'FREE';
    const limits = getPlanLimits(effectivePlan);
    const calendarLimit = limits.calendars === Infinity ? -1 : limits.calendars;

    // Convert user's current selections to new state format
    const currentSelections = user.calendarAssignments && user.calendarAssignments.length > 0
      ? convertAssignmentsToSelections(user.calendarAssignments, user.globalRules)
      : { selectedCalendars: [], calendarLabels: [], spouseInfo: null, calendarRules: [], globalRules: user.globalRules || [] };

    const props: SelectCalendarsPageProps = {
      userId,
      userName: user.name,
      availableCalendars,
      currentSelections,
      locale: userLocale,
      calendarLimit,
    };
    return { kind: 'props', props };
  } catch (error) {
    console.error('Error listing calendars:', error);

    // Handle insufficient scopes - clear token and redirect to re-authorize
    if (error instanceof Error && error.message === 'GOOGLE_INSUFFICIENT_SCOPES') {
      await updateUserById(user.id, { googleRefreshToken: '' });
      // /refresh-token lives outside [locale] and picks the language itself; a /he or /ru prefix 404s.
      return { kind: 'redirect', to: `/refresh-token?user_id=${userId}` };
    }

    // Generic error fallback
    return { kind: 'notice', notice: 'error', detail: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function calendars(user: UserConfig, userId: number, userLocale: string): Promise<PageDataResult> {
  // Native-only page: GCal users keep using select-calendars/. We render an
  // explanation rather than redirecting because the page may be reachable via
  // a stale link.
  if (user.calendarSource !== 'NATIVE') {
    return { kind: 'notice', notice: 'notNative' };
  }

  const visible = await listVisibleCalendars(user.id, user.pairingId ?? null);

  // Serialize for the client component (Date → ISO).
  const initial = visible.map((c) => ({
    rawId: c.id,
    name: c.name,
    color: c.color,
    labels: c.labels,
    privacy: c.privacy,
    ownerUserId: c.ownerUserId,
    isOwner: c.ownerUserId === user.id,
    personName: c.personName,
    personEnglishName: c.personEnglishName,
    personGender: c.personGender,
    rules: c.rules,
    createdAt: c.createdAt.toISOString(),
  }));

  const props: PagePropsMap['calendars'] = { userId, locale: userLocale, initialCalendars: initial };
  return { kind: 'props', props };
}

async function pair(user: UserConfig, userId: number, userLocale: string): Promise<PageDataResult> {
  if (user.calendarSource !== 'NATIVE') {
    return { kind: 'notice', notice: 'notNative' };
  }

  const [partnerInfo, activeInvite] = await Promise.all([
    getActivePartner(user.id),
    getActiveInvite(user.id),
  ]);

  const inviteUrl = activeInvite ? buildUrl(`/${userLocale}/invite/${activeInvite.token}`) : null;

  const props: PagePropsMap['pair'] = {
    userId,
    locale: userLocale,
    initial: {
      partner: partnerInfo
        ? {
            name: partnerInfo.partner.name,
            acceptedAt: partnerInfo.pairing.acceptedAt?.toISOString() ?? null,
          }
        : null,
      invite: activeInvite
        ? {
            token: activeInvite.token,
            url: inviteUrl!,
            expiresAt: activeInvite.expiresAt.toISOString(),
          }
        : null,
    },
  };
  return { kind: 'props', props };
}

async function subscription(user: UserConfig, userId: number, locale: string): Promise<PageDataResult> {
  // Get subscription data (use internal DB user.id, not Telegram userId)
  const [subWithUsage, trialStatus, isEarlyAdopter] = await Promise.all([
    getSubscriptionWithUsage(user.id),
    getTrialStatus(user.id),
    checkEarlyAdopterAccess(user.id),
  ]);

  if (!subWithUsage) {
    return { kind: 'notFound' };
  }

  const props: PagePropsMap['subscription'] = {
    userId,
    locale,
    subscription: {
      plan: subWithUsage.subscription.plan,
      status: subWithUsage.subscription.status,
      effectivePlan: subWithUsage.effectivePlan,
      currentPeriodEnd: subWithUsage.subscription.currentPeriodEnd?.toISOString() || null,
      cancelAtPeriodEnd: subWithUsage.subscription.cancelAtPeriodEnd,
    },
    usage: {
      textSummaries: subWithUsage.usage.textSummariesUsed,
      voiceSummaries: subWithUsage.usage.voiceSummariesUsed,
      voiceEvents: subWithUsage.usage.voiceEventsCreated,
      reminders: subWithUsage.usage.remindersTriggered,
      cycleStartDate: subWithUsage.usage.cycleStartDate.toISOString(),
    },
    trial: {
      isTrialing: trialStatus.isTrialing,
      daysRemaining: trialStatus.daysRemaining,
      trialEndsAt: trialStatus.trialEndsAt?.toISOString() || null,
    },
    isEarlyAdopter,
  };
  return { kind: 'props', props };
}
