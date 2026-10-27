// What the Settings page holds and what it posts to /api/settings (app/api/settings/route.ts).
//
// SettingsValues is every setting the page edits, as one object: the page keeps the values it shows and the
// values last saved (its baseline), and a change is a difference between the two. buildSettingsBody is the
// request's JSON, kept exactly as the page has always posted it: the same keys, the same values for the same
// choices. No imports: pure, so a smoke can hold it to the letter.

export interface SettingsValues {
  language: string;
  location: string;
  messagingPlatform: string;
  culture: string;
  textSummaryEnabled: boolean;
  voiceSummaryEnabled: boolean;
  weatherEnabled: boolean;
  includeLookaheadInTomorrow: boolean;
  lookaheadAlways7Days: boolean;
  preferredMorningHour: number;
  preferredEveningHour: number;
  /** 0 = Sunday .. 6 = Saturday. Never empty. */
  dailySummaryDays: number[];
  tomorrowSummaryDays: number[];
  remindersEnabled: boolean;
  /** The alert lead picked in the list; the server keeps its own value when none is sent. */
  defaultReminderMinutes: number;
  /** HH:mm */
  reminderTime: string;
  pickupRemindersEnabled: boolean;
  voiceInputEnabled: boolean;
}

/** The values a page's props carry (the server's saved ones): a user with no alert lead yet starts the list on 15. */
export function valuesOf(current: Omit<SettingsValues, 'defaultReminderMinutes'> & { defaultReminderMinutes: number | null }): SettingsValues {
  return { ...current, defaultReminderMinutes: current.defaultReminderMinutes ?? 15 };
}

/** The request body. `initData` rides in it (a WhatsApp user, with the session cookie, has none). */
export function buildSettingsBody(values: SettingsValues, nativeRemindersSupported: boolean, initData: string | undefined) {
  return {
    language: values.language,
    location: values.location,
    messagingPlatform: values.messagingPlatform,
    culture: values.culture,
    textSummaryEnabled: values.textSummaryEnabled,
    voiceSummaryEnabled: values.voiceSummaryEnabled,
    weatherEnabled: values.weatherEnabled,
    includeLookaheadInTomorrow: values.includeLookaheadInTomorrow,
    lookaheadAlways7Days: values.lookaheadAlways7Days,
    preferredMorningHour: values.preferredMorningHour,
    preferredEveningHour: values.preferredEveningHour,
    dailySummaryDays: values.dailySummaryDays,
    tomorrowSummaryDays: values.tomorrowSummaryDays,
    remindersEnabled: values.remindersEnabled,
    defaultReminderMinutes: values.remindersEnabled ? values.defaultReminderMinutes : null,
    // Only where the row shows (FamCal reminders allowed): elsewhere it stays as it was.
    ...(nativeRemindersSupported ? { reminderTime: values.reminderTime } : {}),
    pickupRemindersEnabled: values.pickupRemindersEnabled,
    voiceInputEnabled: values.voiceInputEnabled,
    initData,
  };
}

const sameDays = (a: number[], b: number[]) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));

/** Whether two sets of values are the same setting for setting (the days compared as sets). */
export function sameSettings(a: SettingsValues, b: SettingsValues): boolean {
  return (
    a.language === b.language &&
    a.location === b.location &&
    a.messagingPlatform === b.messagingPlatform &&
    a.culture === b.culture &&
    a.textSummaryEnabled === b.textSummaryEnabled &&
    a.voiceSummaryEnabled === b.voiceSummaryEnabled &&
    a.weatherEnabled === b.weatherEnabled &&
    a.includeLookaheadInTomorrow === b.includeLookaheadInTomorrow &&
    a.lookaheadAlways7Days === b.lookaheadAlways7Days &&
    a.preferredMorningHour === b.preferredMorningHour &&
    a.preferredEveningHour === b.preferredEveningHour &&
    sameDays(a.dailySummaryDays, b.dailySummaryDays) &&
    sameDays(a.tomorrowSummaryDays, b.tomorrowSummaryDays) &&
    a.remindersEnabled === b.remindersEnabled &&
    a.defaultReminderMinutes === b.defaultReminderMinutes &&
    a.reminderTime === b.reminderTime &&
    a.pickupRemindersEnabled === b.pickupRemindersEnabled &&
    a.voiceInputEnabled === b.voiceInputEnabled
  );
}

/** A day of a summary turned on or off. The last day that is on cannot be turned off. */
export function toggleSummaryDay(days: number[], day: number): number[] {
  if (days.includes(day)) return days.length <= 1 ? days : days.filter((d) => d !== day);
  return [...days, day].sort((a, b) => a - b);
}

/** Choosing a culture resets the days: the Jewish one skips Shabbat in the morning and Friday in the evening. */
export function daysForCulture(culture: string): { dailySummaryDays: number[]; tomorrowSummaryDays: number[] } {
  return culture === 'jewish'
    ? { dailySummaryDays: [0, 1, 2, 3, 4, 5], tomorrowSummaryDays: [0, 1, 2, 3, 4, 6] }
    : { dailySummaryDays: [0, 1, 2, 3, 4, 5, 6], tomorrowSummaryDays: [0, 1, 2, 3, 4, 5, 6] };
}
