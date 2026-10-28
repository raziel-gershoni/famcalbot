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
 * - dashboard's trial end date travels as an ISO string, and its props are the calendar
 *   home's own wire type (DashboardPageProps), with the home's hints.
 * The props are otherwise exactly what each page passed to its client component.
 */

import type { ComponentProps } from 'react';
import type SettingsClient from '@/app/[locale]/settings/SettingsClient';
import type SelectCalendarsClient from '@/app/[locale]/select-calendars/SelectCalendarsClient';
import type CalendarsClient from '@/app/[locale]/calendars/CalendarsClient';
import type PairClient from '@/app/[locale]/pair/PairClient';
import type SubscriptionClient from '@/app/[locale]/subscription/SubscriptionClient';
import { calendarTotal, countCalendars, getSubscriptionWithUsage, getTrialStatus, checkEarlyAdopterAccess, peekFeatureAccess } from '@/src/services/subscription-service';
import { canReceiveReminderPings, getReminderSupport } from '@/src/services/native-reminders/support';
import { trackActivityAsync } from '@/src/services/analytics-service';
import { captureError } from '@/src/lib/error-capture';
import { TZ_LOOKUP_MS, timezoneWithin } from '@/src/lib/timezone';
import { listUserCalendars, scrubbedGoogleError } from '@/src/services/calendar';
import { classifyGoogleError } from '@/src/services/calendar-read/google-map';
import { sourcesFor } from '@/src/services/calendar-read';
import { googleStateOf, liveGoogleChoices, type GoogleState } from '@/src/lib/google-state';
import { listVisibleCalendars } from '@/src/services/native-calendar/event-store';
import { ensurePrimaryNativeCalendar } from '@/src/services/native-calendar/onboarding';
import { getActivePartner, getActiveInvite } from '@/src/services/pairing-service';
import { getPlanLimits } from '@/src/config/plans';
import { buildUrl } from '@/src/config/urls';
import { normalizeLocale } from '@/src/utils/locale';
import { tzKnownFor, weekStartOfUser } from '@/src/utils/locale-rules';
import { TIMEZONE } from '@/src/config/constants';
import { prisma } from '@/src/utils/prisma';
import type { CalendarAssignment, CalendarLabel, UserConfig } from '@/src/types';
import type { HomeHints } from '@/src/lib/calendar-view/home-props';
import type { SourceName, WeekStart } from '@/src/lib/calendar-view/types';
import { reminderTimeOf } from '@/src/lib/reminder-time';
import { channelsOf, deliveryPlatformFor } from '@/src/lib/delivery-platform';
import { googleColoursOnScreen } from '@/src/services/native-calendar/colour';

export const PAGE_NAMES = ['dashboard', 'settings', 'select-calendars', 'calendars', 'pair', 'subscription'] as const;
export type PageName = (typeof PAGE_NAMES)[number];

export function isPageName(value: unknown): value is PageName {
  return typeof value === 'string' && (PAGE_NAMES as readonly string[]).includes(value);
}

/** A static notice the page renders instead of its client component. */
export type PageNotice = 'noGoogleToken' | 'error';

type SelectCalendarsProps = ComponentProps<typeof SelectCalendarsClient>;

/**
 * Dashboard props on the wire: what PageGate hands the calendar home (calendarHomeProps),
 * with the trial end date as an ISO string. The home's empty-state hints (Ruling R10) and
 * the user's always-7-days setting (for the Send sheet's week dates) ride along.
 */
export interface DashboardPageProps {
  user: { id: number; name: string; location: string; isAdmin: boolean };
  locale: string;
  /** The sources the home reads (the server's sourcesFor): FamCal for everyone, Google when there is a token. */
  sources: SourceName[];
  /** A Google token is stored (the location banner reads it: Google tells the zone). */
  googleConnected: boolean;
  /** Where the user is with Google: the banners, the menu and the nudges follow it (googleStateOf). */
  googleState: GoogleState;
  trial: { isTrialing: boolean; daysRemaining: number; trialEndsAt: string | null };
  isEarlyAdopter: boolean;
  hints: HomeHints;
  lookahead7: boolean;
  /** The calendar setting is Jewish: the home shows the zmanim button. */
  jewish: boolean;
}

/**
 * Select-calendars props on the wire: Sets and Maps as arrays. famcalPrimaryName is the
 * user's FamCal calendar labelled primary, if any: ticking primary on a Google calendar
 * moves the default from it, so the page says "New events will go to <name>" (spec §3).
 */
export type SelectCalendarsPageProps = Omit<SelectCalendarsProps, 'currentSelections'> & {
  famcalPrimaryName: string | null;
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
  | { kind: 'notice'; notice: PageNotice }
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
  // Google is a connection beside FamCal (spec "Google as a connection" §2), so the home
  // gets facts, not a source: what it reads, whether a token is stored, and the state the
  // banners and the menu follow. A legacy Google user's cleared token with calendars stored is
  // 'reconnect': sourcesFor drops Google then, so the range answer cannot say it.

  // The trial and early-adopter lines, and the home's hints. getSubscriptionWithUsage's
  // answer isn't on the wire; it runs for its side effect: an open after the trial's end
  // expires it (clearing the feature caches and sending the notice), as the old home's did.
  const [trialStatus, isEarlyAdopter, home] = await Promise.all([
    getTrialStatus(user.id),
    checkEarlyAdopterAccess(user.id),
    homeHintsFor(user),
    getSubscriptionWithUsage(user.id).catch(() => null),
  ]);

  const props: DashboardPageProps = {
    user: {
      id: userId,
      name: user.name,
      location: user.location,
      isAdmin: user.isAdmin || false,
    },
    locale,
    sources: sourcesFor(user),
    googleConnected: Boolean(user.googleRefreshToken),
    googleState: googleStateOf(user),
    trial: { ...trialStatus, trialEndsAt: trialStatus.trialEndsAt?.toISOString() ?? null },
    isEarlyAdopter,
    jewish: user.culture === 'jewish',
    ...home,
  };
  // One open of the calendar home (spec §7.1), under the DB id like every activity
  trackActivityAsync(user.id, 'webapp_opened');
  return { kind: 'props', props };
}

/**
 * The calendar home's empty state's how-to-add hints (spec §7.3, Ruling R10) and the
 * user's always-7-days setting. Both checks are cheap: the feature checks are cached
 * for 24 h in Redis, and the native-reminders switch is read through Redis.
 * getReminderSupport already fails closed; a failed voice-events check does too, so a
 * hint never promises what the plan may lack and never fails the page.
 */
async function homeHintsFor(user: UserConfig): Promise<{ hints: HomeHints; lookahead7: boolean }> {
  const [reminders, voiceEvents] = await Promise.all([
    getReminderSupport(user, { quiet: true }).then((support) => support.supported),
    peekFeatureAccess(user.id, 'voice_events').then(
      (access) => access.allowed,
      (error) => {
        captureError(error, 'calendar-home-hints', { user_id: user.id }, 'warning');
        return false;
      }
    ),
  ]);
  return { hints: { reminders, voiceEvents }, lookahead7: user.lookaheadAlways7Days === true };
}

/**
 * Where the person's week starts, for the Settings day chips: the home's rule (weekStartOfUser)
 * over the home's zone lookup, with the home's 2 s ceiling (TZ_LOOKUP_MS). A late or failed
 * lookup costs the chips their zone, never the page: the order then follows the language, as the
 * home's does (tzKnown false), and a failure is captured. The lookup carries on and caches the zone.
 */
async function weekStartForSettings(user: UserConfig): Promise<WeekStart> {
  let resolved: string | null = null;
  try {
    resolved = await timezoneWithin(user, TZ_LOOKUP_MS);
    if (resolved === null) {
      captureError(new Error(`The timezone lookup took over ${TZ_LOOKUP_MS} ms`), 'settings-timezone', { user_id: user.id }, 'warning');
    }
  } catch (error) {
    captureError(error, 'settings-timezone', { user_id: user.id }, 'warning');
  }
  return weekStartOfUser(user, resolved ?? TIMEZONE, resolved !== null && tzKnownFor(user));
}

async function settings(user: UserConfig, userId: number, userLocale: string): Promise<PageDataResult> {
  // Fetch admin settings, subscription data and the week start in parallel
  const [nativeRemindersSupported, adminSettings, subWithUsage, weekStart] = await Promise.all([
    // quiet: a gate for one control, so a plan without reminders logs nothing
    canReceiveReminderPings(user, { quiet: true }),
    prisma.adminSettings.findUnique({
      where: { id: 'global' }
    }).catch(() => null),
    getSubscriptionWithUsage(user.id).catch(() => null),
    weekStartForSettings(user),
  ]);

  // Build subscription info for the client
  const effectivePlan = subWithUsage?.effectivePlan || 'FREE';
  const limits = getPlanLimits(effectivePlan);
  const isTrialing = subWithUsage?.subscription.status === 'TRIALING'
    && new Date() < subWithUsage.subscription.trialEndsAt;

  const channels = channelsOf(user);
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
      // "Address me as": a row that holds anything but the two values reads as male, as the voice show reads it
      gender: user.gender === 'female' ? 'female' : 'male',
      location: user.location,
      // Where the summaries really go: the saved choice narrowed to the channels the person has (delivery-platform.ts)
      messagingPlatform: deliveryPlatformFor(user) ?? user.messagingPlatform,
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
      reminderTime: reminderTimeOf(user),
      pickupRemindersEnabled: user.pickupRemindersEnabled ?? true,
      voiceInputEnabled: user.voiceInputEnabled,
      pauseOnShabbat: user.pauseOnShabbat,
      zmanimCommunity: user.zmanimCommunity
    },
    weekStart,
    remindersGloballyEnabled: adminSettings?.remindersEnabled ?? false,
    googleConnected: Boolean(user.googleRefreshToken),
    nativeRemindersSupported,
    subscriptionInfo,
    bothChannels: channels.telegram && channels.whatsapp,
  };
  // One open of the Settings screen
  trackActivityAsync(user.id, 'settings_viewed');
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
    const [availableCalendars, subWithUsage, ownFamcal] = await Promise.all([
      listUserCalendars(user.googleRefreshToken, user.id),
      getSubscriptionWithUsage(user.id).catch(() => null),
      prisma.nativeCalendar.findMany({
        where: { ownerUserId: user.id, isDeleted: false },
        select: { name: true, labels: true },
        orderBy: [{ createdAt: 'asc' }],
      }),
    ]);

    const effectivePlan = subWithUsage?.effectivePlan || 'FREE';
    const limits = getPlanLimits(effectivePlan);
    // The Google share of the shared total: the limit less the FamCal calendars that count
    // beside a Google choice (all but the main), at least 1 so the page always allows one.
    const counted = Math.max(0, ownFamcal.length - 1);
    const calendarLimit = limits.calendars === Infinity ? -1 : Math.max(1, limits.calendars - counted);

    // Convert user's current selections to new state format
    const chosen = liveGoogleChoices(user);
    const currentSelections = chosen.length > 0
      ? convertAssignmentsToSelections(chosen, user.globalRules)
      : { selectedCalendars: [], calendarLabels: [], spouseInfo: null, calendarRules: [], globalRules: user.globalRules || [] };

    const props: SelectCalendarsPageProps = {
      userId,
      userName: user.name,
      availableCalendars,
      currentSelections,
      locale: userLocale,
      calendarLimit,
      famcalPrimaryName: ownFamcal.find((c) => c.labels.includes('primary'))?.name ?? null,
    };
    return { kind: 'props', props };
  } catch (error) {
    // The list's reader captures nothing of its own: this reports it once, without Google's
    // raw error. A dead token or missing scopes is the user's to fix (a warning); the rest is ours.
    const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
    const cls = classifyGoogleError(cause);
    captureError(scrubbedGoogleError(cause, cls), 'select-calendars-list', { user_id: user.id }, cls === 'token' || cls === 'scopes' || cls === 'transient' ? 'warning' : 'error');

    // Missing permissions: re-authorize. The token is kept, so the choices stay a connection
    // (a cleared token made a FamCal user's choices stale relics, liveGoogleChoices): the reads
    // answer 'scopes' (the home's reconnect banner, the summary's line) and a reconnect replaces it.
    if (error instanceof Error && error.message === 'GOOGLE_INSUFFICIENT_SCOPES') {
      console.warn(`[select-calendars] user ${user.id}: the Google token lacks permissions; token kept, sent to /refresh-token`);
      // /refresh-token lives outside [locale] and picks the language itself; a /he or /ru prefix 404s.
      return { kind: 'redirect', to: `/refresh-token?user_id=${userId}` };
    }

    // Generic error fallback: captured above, and the message stays out of the page
    return { kind: 'notice', notice: 'error' };
  }
}

async function calendars(user: UserConfig, userId: number, userLocale: string): Promise<PageDataResult> {
  // The FamCal calendars page, for everyone (Google as a connection). A user with no FamCal
  // calendar of their own (a legacy Google user's were hidden by an old connect) gets the
  // main one made here, lazily, as reminders and the editor make it.
  let visible = await listVisibleCalendars(user.id, user.pairingId ?? null);
  if (!visible.some((c) => c.ownerUserId === user.id)) {
    await ensurePrimaryNativeCalendar(user.id);
    visible = await listVisibleCalendars(user.id, user.pairingId ?? null);
  }

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

  // Only the colours: the page never shifts a Google calendar, it only keeps FamCal ones apart from them.
  const googleColors = (await googleColoursOnScreen(user)).flatMap((c) => c.color ?? []);

  const props: PagePropsMap['calendars'] = { userId, locale: userLocale, initialCalendars: initial, googleColors };
  return { kind: 'props', props };
}

async function pair(user: UserConfig, userId: number, userLocale: string): Promise<PageDataResult> {
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
  const [subWithUsage, trialStatus, isEarlyAdopter, counts] = await Promise.all([
    getSubscriptionWithUsage(user.id),
    getTrialStatus(user.id),
    checkEarlyAdopterAccess(user.id),
    countCalendars(user.id),
  ]);

  if (!subWithUsage) {
    return { kind: 'notFound' };
  }

  // One open of the Subscription screen (after the notFound answer: only a rendered page counts)
  trackActivityAsync(user.id, 'subscription_page_viewed');

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
    // The calendars meter counts as the plan's limit does (calendarTotal); the upgrade is a Telegram Stars invoice, sent to the user's chat
    calendarsUsed: calendarTotal(counts.famcal, counts.google),
    telegramLinked: user.telegramId !== null,
  };
  return { kind: 'props', props };
}
