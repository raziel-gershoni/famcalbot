'use client';

// The Settings screen, in the home's design (spec 2026-10-19 §4, §5; plan W1a): an AppScreen on the
// grouped ground, a header with its back, five sections of cards (language and place, summaries, when
// summaries arrive, events and reminders, Google), and a Save bar that stays at the bottom.
//
// - Save stays on the page: the bar says "Saved" or what failed, and what was just saved becomes the
//   baseline the page compares against, so Save is on only while something differs. A save that changes the
//   language reloads this page in the new one. The request is /api/settings, as it has always been
//   (settings-body.ts).
// - The location is a sheet (LocationSheet): a changed place is checked after the sheet closes, and Save
//   waits for the check and refuses a place that is not one.
// - What the alerts rows show follows the saved platform, not the one picked in the list: the list
//   changes the section only once it is saved.
// - Back has one owner, AppScreen (Telegram's BackButton, and the header's own back in a browser). It
//   closes the sheet that is open, else returns to the calendar in the saved language.

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { REMINDER_TIME_STEP_MINUTES } from '@/src/lib/reminder-time';
import { WEEKDAY_IDS_BY_INDEX } from '@/src/lib/calendar-view/repeat-model';
import { readInitData } from '@/src/lib/read-init-data';
import { useTelegramVerticalSwipes } from '@/src/lib/telegram-ui';
import { AppScreen } from '@/components/app-ui/AppScreen';
import { DayChips, type DayChip } from '@/components/app-ui/DayChips';
import { FORM_CSS, FormCard, SaveBar, SwitchRow, ButtonRow, ValueRow } from '@/components/app-ui/form-kit';
import { Notice } from '@/components/app-ui/Notice';
import { ScreenHeader, SectionLabel } from '@/components/app-ui/ScreenHeader';
import { TimePickerSheet } from '../dashboard/TimePickerSheet';
import GoogleDisconnect from './GoogleDisconnect';
import { LocationSheet, type LocationProblem } from './LocationSheet';
import { validateLocation } from './location-lookup';
import { buildSettingsBody, daysForCulture, sameSettings, toggleSummaryDay, valuesOf, type SettingsValues } from './settings-body';

interface SubscriptionInfo {
  effectivePlan: string;
  textSummariesUsed: number;
  textSummariesLimit: number; // -1 means unlimited
  voiceSummariesUsed: number;
  voiceSummariesLimit: number; // -1 means unlimited
  remindersAllowed: boolean;
  isTrialing: boolean;
}

interface SettingsClientProps {
  userId: number;
  currentSettings: {
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
    dailySummaryDays: number[];
    tomorrowSummaryDays: number[];
    remindersEnabled: boolean;
    defaultReminderMinutes: number | null;
    reminderTime: string; // HH:mm
    pickupRemindersEnabled: boolean;
    voiceInputEnabled: boolean;
  };
  remindersGloballyEnabled: boolean;
  /** A Google token is stored: the Google section (Disconnect Google) shows. */
  googleConnected: boolean;
  /** FamCal reminders can be used (the native switch, Telegram, the plan): the reminder time applies. */
  nativeRemindersSupported: boolean;
  subscriptionInfo: SubscriptionInfo;
}

/** The language names are each language's own, whatever language the page is in. */
const LANGUAGES = [
  { value: 'he', text: 'עברית' },
  { value: 'en', text: 'English' },
  { value: 'ru', text: 'Русский' },
];

const HOURS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), text: `${String(hour).padStart(2, '0')}:00` }));

const ALERT_LEADS = [5, 10, 15, 30, 60];

/** One summary's days: the chips under its time, and the line that says why the last one cannot go. */
function SummaryDays({ label, days, onToggle }: { label: string; days: number[]; onToggle: (day: number) => void }) {
  const t = useTranslations('settings');
  const names = useTranslations('calendarHome');
  const hintId = useId();
  const last = days.length === 1;
  // Sunday first, as the days are numbered (0 = Sunday): in Hebrew the row starts on the right.
  const chips: DayChip[] = WEEKDAY_IDS_BY_INDEX.map((weekday, index) => ({
    id: String(index),
    short: names('editor.repeat.dayShort', { weekday }),
    full: names('editor.repeat.dayLong', { weekday }),
    on: days.includes(index),
    pinned: last && days.includes(index),
  }));
  return (
    <div className="ch-form-chips">
      <span className="ch-form-hint">{label}</span>
      <DayChips label={label} days={chips} describedBy={hintId} onToggle={(id) => onToggle(Number(id))} />
      {last ? (
        <p id={hintId} className="ch-form-fixed">
          {t('oneDayStays')}
        </p>
      ) : null}
    </div>
  );
}

export default function SettingsClient({ userId, currentSettings, remindersGloballyEnabled, googleConnected: googleConnectedProp, nativeRemindersSupported, subscriptionInfo }: SettingsClientProps) {
  const t = useTranslations('settings');
  const ui = useTranslations('ui');
  const router = useRouter();

  // What the page shows, and what was last saved (the server's values, then each save's).
  const [form, setForm] = useState<SettingsValues>(() => valuesOf(currentSettings));
  const [saved, setSaved] = useState<SettingsValues>(() => valuesOf(currentSettings));
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [googleConnected, setGoogleConnected] = useState(googleConnectedProp);

  // The sheets: one is open at a time, and Back closes it. The Google section reports its own.
  const [timeOpen, setTimeOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [locationDraft, setLocationDraft] = useState('');
  const [googleClose, setGoogleClose] = useState<(() => void) | null>(null);
  // A wheel dragged down in a sheet must not minimize the app.
  useTelegramVerticalSwipes(timeOpen || locationOpen || googleClose !== null);

  // The check of a changed place. Save waits for it; a later edit makes an earlier answer stale.
  const [locationChecking, setLocationChecking] = useState(false);
  const [locationProblem, setLocationProblem] = useState<LocationProblem | null>(null);
  const lastCheck = useRef(0);

  const set = <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => setForm((f) => ({ ...f, [key]: value }));

  const dirty = !sameSettings(form, saved);

  const openLocation = () => {
    setLocationDraft(form.location);
    setLocationOpen(true);
  };

  /**
   * Closing the sheet: a changed place is shown at once and checked; the check may normalize it. A place that
   * carries a problem is checked again even when it is unchanged (a check that could not be made is retried by
   * closing the sheet again, and the same bad name typed again is not let through). Save never turns on for a
   * place that failed its check: the problem stays until a check clears it.
   */
  const closeLocation = async () => {
    setLocationOpen(false);
    const place = locationDraft;
    if (place === form.location && locationProblem === null) return;
    set('location', place);
    const check = ++lastCheck.current;
    setLocationProblem(null);
    setLocationChecking(true);
    const result = await validateLocation(place);
    if (check !== lastCheck.current) return;
    setLocationChecking(false);
    if (result.kind === 'valid') {
      if (result.normalized !== place) set('location', result.normalized);
    } else {
      setLocationProblem(result.kind);
    }
  };

  const backHandler = () => {
    if (timeOpen) setTimeOpen(false);
    else if (locationOpen) void closeLocation();
    else if (googleClose) googleClose();
    else router.push(`/${saved.language}/dashboard?user_id=${userId}`);
  };

  const save = async () => {
    if (busy || !dirty || locationChecking || locationProblem) return;
    const posting = form;
    setBusy(true);
    setSaveFailed(false);
    setJustSaved(false);
    try {
      const response = await fetch(`/api/settings?user_id=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSettingsBody(posting, nativeRemindersSupported, readInitData() || undefined)),
      });
      if (!response.ok) throw new Error(`Failed to save settings (${response.status})`);
      setSaved(posting);
      setJustSaved(true);
      // The page is in the language it was opened in: a new one reloads it.
      if (posting.language !== saved.language) router.replace(`/${posting.language}/settings?user_id=${userId}`);
    } catch (error) {
      console.error('[settings] save failed:', error);
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const alertsAllowed = remindersGloballyEnabled && subscriptionInfo.remindersAllowed;
  const alertsOn = form.remindersEnabled && alertsAllowed;
  // The alerts rows follow the saved platform: picking another one changes them once it is saved.
  const telegramReaches = saved.messagingPlatform !== 'whatsapp';
  const usage = (used: number, limit: number) => (limit > 0 ? t('usage', { used, limit }) : undefined);

  return (
    <AppScreen ground="grouped" onBack={backHandler}>
      <style>{FORM_CSS}</style>
      <ScreenHeader title={t('title')} backLabel={ui('back')} onBack={backHandler} />
      <div className="ch-form-page ch-form-page-grouped">
        <SectionLabel>{t('sections.place')}</SectionLabel>
        <FormCard>
          <ValueRow label={t('language.label')} hint={t('language.hint')} value={form.language} options={LANGUAGES} onChange={(value) => set('language', value)} />
          <ButtonRow
            label={t('location.label')}
            hint={locationChecking ? t('location.checking') : t('location.hint')}
            value={form.location || t('location.notSet')}
            error={locationProblem ? t(locationProblem === 'notFound' ? 'location.notFound' : 'location.checkFailed') : null}
            onClick={openLocation}
          />
          <ValueRow
            label={t('culture.label')}
            hint={t('culture.hint')}
            value={form.culture}
            options={[
              { value: 'default', text: t('culture.general') },
              { value: 'jewish', text: t('culture.jewish') },
            ]}
            onChange={(value) => setForm((f) => ({ ...f, culture: value, ...daysForCulture(value) }))}
          />
          <ValueRow
            label={t('platform.label')}
            value={form.messagingPlatform}
            options={[
              { value: 'telegram', text: 'Telegram' },
              { value: 'whatsapp', text: 'WhatsApp' },
              { value: 'all', text: t('platform.both') },
            ]}
            onChange={(value) => set('messagingPlatform', value)}
          />
        </FormCard>

        <SectionLabel>{t('sections.summaries')}</SectionLabel>
        <FormCard>
          <SwitchRow
            label={t('text.label')}
            hint={t('text.hint')}
            note={usage(subscriptionInfo.textSummariesUsed, subscriptionInfo.textSummariesLimit)}
            checked={form.textSummaryEnabled}
            onChange={(on) => set('textSummaryEnabled', on)}
          />
          <SwitchRow
            label={t('voice.label')}
            hint={t('voice.hint')}
            note={usage(subscriptionInfo.voiceSummariesUsed, subscriptionInfo.voiceSummariesLimit)}
            checked={form.voiceSummaryEnabled}
            onChange={(on) => set('voiceSummaryEnabled', on)}
          />
          <SwitchRow label={t('weather.label')} hint={t('weather.hint')} checked={form.weatherEnabled} onChange={(on) => set('weatherEnabled', on)} />
          <SwitchRow label={t('weekAhead.label')} hint={t('weekAhead.hint')} checked={form.includeLookaheadInTomorrow} onChange={(on) => set('includeLookaheadInTomorrow', on)} />
          <SwitchRow label={t('sevenDays.label')} hint={t('sevenDays.hint')} checked={form.lookaheadAlways7Days} onChange={(on) => set('lookaheadAlways7Days', on)} />
        </FormCard>

        <SectionLabel>{t('sections.timing')}</SectionLabel>
        <FormCard>
          <ValueRow label={t('morning.label')} value={String(form.preferredMorningHour)} options={HOURS} valueDir="ltr" onChange={(value) => set('preferredMorningHour', Number(value))} />
          <SummaryDays label={t('morning.days')} days={form.dailySummaryDays} onToggle={(day) => set('dailySummaryDays', toggleSummaryDay(form.dailySummaryDays, day))} />
          <ValueRow label={t('evening.label')} value={String(form.preferredEveningHour)} options={HOURS} valueDir="ltr" onChange={(value) => set('preferredEveningHour', Number(value))} />
          <SummaryDays label={t('evening.days')} days={form.tomorrowSummaryDays} onToggle={(day) => set('tomorrowSummaryDays', toggleSummaryDay(form.tomorrowSummaryDays, day))} />
        </FormCard>

        <SectionLabel>{t('sections.events')}</SectionLabel>
        <FormCard>
          <SwitchRow label={t('voiceInput.label')} hint={t('voiceInput.hint')} checked={form.voiceInputEnabled} onChange={(on) => set('voiceInputEnabled', on)} />
          {telegramReaches ? (
            <>
              <SwitchRow
                label={t('alerts.label')}
                hint={remindersGloballyEnabled ? t('alerts.hint') : t('alerts.comingSoon')}
                checked={alertsOn}
                disabled={!alertsAllowed}
                onChange={(on) => set('remindersEnabled', on)}
              />
              {alertsOn ? (
                <>
                  <ValueRow
                    label={t('defaultAlert.label')}
                    hint={t('defaultAlert.hint')}
                    value={String(form.defaultReminderMinutes)}
                    options={ALERT_LEADS.map((minutes) => ({ value: String(minutes), text: t('defaultAlert.option', { minutes }) }))}
                    onChange={(value) => set('defaultReminderMinutes', Number(value))}
                  />
                  <SwitchRow label={t('pickup.label')} hint={t('pickup.hint')} checked={form.pickupRemindersEnabled} onChange={(on) => set('pickupRemindersEnabled', on)} />
                </>
              ) : null}
            </>
          ) : null}
          {nativeRemindersSupported ? <ButtonRow label={t('reminderTime')} hint={t('reminderTimeHelp')} value={form.reminderTime} valueDir="ltr" onClick={() => setTimeOpen(true)} /> : null}
        </FormCard>
        {telegramReaches && remindersGloballyEnabled && !subscriptionInfo.remindersAllowed ? (
          <Notice action={{ label: t('alerts.seePlans'), onClick: () => router.push(`/${saved.language}/subscription?user_id=${userId}`) }}>{t('alerts.proOnly')}</Notice>
        ) : null}

        <GoogleDisconnect userId={userId} connected={googleConnected} onDisconnected={() => setGoogleConnected(false)} onSheet={(close) => setGoogleClose(() => close)} />
      </div>

      <SaveBar
        sticky
        label={ui('save')}
        busy={busy}
        disabled={!dirty || locationChecking || locationProblem !== null}
        status={justSaved && !dirty ? ui('saved') : null}
        error={saveFailed ? t('saveFailed') : null}
        onSave={save}
      />

      {/* Not lazy: there is no error boundary on this page, so a chunk that failed to load would take the whole screen with it. */}
      {timeOpen ? (
        <TimePickerSheet
          label={t('reminderTime')}
          value={form.reminderTime}
          step={REMINDER_TIME_STEP_MINUTES}
          onPick={(time) => {
            setTimeOpen(false);
            set('reminderTime', time);
          }}
          onClose={() => setTimeOpen(false)}
        />
      ) : null}
      {locationOpen ? <LocationSheet draft={locationDraft} onDraft={setLocationDraft} checking={locationChecking} problem={locationProblem} onClose={() => void closeLocation()} /> : null}
    </AppScreen>
  );
}
