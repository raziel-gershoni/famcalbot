'use client';

// The calendar home's header (spec §7.2, the approved layout A): the day and, when the
// route says so, its Hebrew date ("Thursday, 15 October" over "4 Cheshvan 5787"), both
// from the server's today, never the device's clock; "Times in <zone>" when the device
// is in another zone (§7.1); and 44 px buttons: "+" (add an event or a reminder, only
// when the user can add one, home editing spec §2), Send to chat (only for an account with a chat, 6c-1), the sun (today's zmanim, only for the Jewish
// calendar) and the ⋯ menu. Under the buttons, at the header's end edge, the weather at the person's place: the place as
// they typed it, today (the icon, the temperature now and the low-high) and, as many as fit, the next days (the weekday,
// the icon and the high); nothing where there is none. Until the first answer the day is a placeholder bar.
// Under the date lines, two lines at the person's place: the zman that passed last ("Sunset 16:42", "Yesterday: Midnight
// 23:24" before today's first) over the next one still ahead ("Tzeit 16:58", "Tomorrow: Dawn 05:01" once today's are
// past); zmanWindowOf in zmanim-list.ts picks both from the sun sheet's own lists. One quiet button that opens the sun
// sheet, each time in the accent for the candle lighting and the end of Shabbat or Yom Tov, as in the sheet.

import { useLocale, useTranslations } from 'next-intl';
import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudRainWind, CloudSnow, CloudSun, Flame, MapPin, Snowflake, Sun, type LucideIcon } from 'lucide-react';
import { daysBetween, formatDayLong, formatForecastWeekday, formatTime, formatWeekdayLong, shabbatOf } from '@/src/lib/calendar-view/format';
import { hebrewFullDate } from '@/src/lib/calendar-view/hebrew-date';
import { hasChag, holidayTitles, isPortion, monthLanded, useHolidays, useNextHoliday } from '@/src/lib/calendar-view/holidays-client';
import { zoneLabel } from '@/src/lib/calendar-view/home-client';
import type { HomeWeather } from '@/src/lib/calendar-view/home-weather';
import type { DayKey } from '@/src/lib/calendar-view/types';
import { zmanRowName } from '@/src/lib/calendar-view/zman-words';
import { WINDOW_ROW_KEYS, type ZmanAt, type ZmanWindow } from '@/src/lib/calendar-view/zmanim-list';

export interface HomeHeaderProps {
  /** The server's today; null until the first answer. */
  today: DayKey | null;
  hebrewDates: boolean;
  /** The zone the times are in, only when the device's zone differs; else null. */
  zone: string | null;
  sendOpen: boolean;
  menuOpen: boolean;
  /** Opens the Send sheet; absent for an account with no chat (no Telegram, no WhatsApp), and there is no Send button. */
  onSend?: () => void;
  onMenu: () => void;
  /** Opens the editor for a new item; absent when the user can add neither kind, and there is no "+". */
  onAdd?: () => void;
  addOpen?: boolean;
  /** Opens the zmanim sheet; absent for anyone but the Jewish calendar (and before the first answer), and there is no sun. */
  onZmanim?: () => void;
  zmanimOpen?: boolean;
  /** Today's weather under the buttons: 'loading' is a placeholder; null or absent (no place, no forecast) shows nothing. */
  weather?: HomeWeather | 'loading' | null;
  /** The zman that passed last and the next one under the date lines, a tap away from the sun sheet; null or absent (or no sun) shows nothing. */
  zmanWindow?: ZmanWindow | null;
}

/** The icon names the server sends (weatherIconName), as lucide icons; a name this build does not know is a cloud. */
const WEATHER_ICONS: Record<string, LucideIcon> = {
  sun: Sun,
  cloudSun: CloudSun,
  cloudFog: CloudFog,
  cloudDrizzle: CloudDrizzle,
  cloudRain: CloudRain,
  cloudSnow: CloudSnow,
  cloudRainWind: CloudRainWind,
  snowflake: Snowflake,
  cloudLightning: CloudLightning,
  flame: Flame,
};

/**
 * The weather at the person's place, not tappable: one image to a screen reader (the label says it all: the place, today and
 * each day), its parts hidden. The days are in the answer's order, tomorrow first; the strip shows as many as fit (CSS).
 */
function WeatherBlock({ weather }: { weather: HomeWeather | 'loading' }) {
  const t = useTranslations('calendarHome.header');
  const locale = useLocale();
  if (weather === 'loading') {
    return (
      <div className="ch-head-weather-ghost" aria-hidden="true">
        <span className="ch-head-weather-ghost-place" />
        <span className="ch-head-weather-ghost-now" />
        <span className="ch-head-weather-ghost-range" />
      </div>
    );
  }
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const now = number.format(weather.now);
  const low = number.format(weather.low);
  const high = number.format(weather.high);
  const Icon = WEATHER_ICONS[weather.icon] ?? Cloud;
  const label = [
    t('weather', { place: weather.place, condition: weather.condition, now, low, high }),
    ...weather.days.map((day) => t('weatherDay', { weekday: formatWeekdayLong(day.date, locale), condition: day.condition, high: number.format(day.high) })),
  ].join(' ');
  return (
    <div className="ch-head-weather" role="img" aria-label={label}>
      {weather.place ? (
        <span className="ch-head-weather-place" aria-hidden="true">
          <MapPin size={14} aria-hidden="true" focusable="false" />
          <bdi>{weather.place}</bdi>
        </span>
      ) : null}
      <div className="ch-head-weather-row" aria-hidden="true">
        <div className="ch-head-weather-today">
          <span className="ch-head-weather-now">
            <Icon size={22} aria-hidden="true" focusable="false" />
            <bdi dir="ltr">{t('weatherNow', { now })}</bdi>
          </span>
          <span className="ch-head-weather-range">
            <bdi dir="ltr">{t('weatherRange', { low, high })}</bdi>
          </span>
        </div>
        <div className="ch-head-weather-days">
          {weather.days.map((day) => {
            const DayIcon = WEATHER_ICONS[day.icon] ?? Cloud;
            return (
              <span key={day.date} className="ch-head-weather-day">
                <span className="ch-head-weather-day-name">{formatForecastWeekday(day.date, locale)}</span>
                <DayIcon size={16} aria-hidden="true" focusable="false" />
                <bdi dir="ltr" className="ch-head-weather-day-high">{t('weatherNow', { now: number.format(day.high) })}</bdi>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function SendIcon() {
  return (
    <svg className="ch-flip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** One of the two lines: the name (with "Yesterday:" or "Tomorrow:" when it is that day's) and the time. */
function ZmanLine({ zman, className }: { zman: ZmanAt; className: string }) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const name = zmanRowName(t, zman.row);
  const shown = zman.when === 'yesterday' ? t('header.lastZmanYesterday', { name }) : zman.when === 'tomorrow' ? t('header.nextZmanTomorrow', { name }) : name;
  return (
    <span className={WINDOW_ROW_KEYS.includes(zman.row.key) ? `${className} is-key` : className} aria-hidden="true">
      <span className="ch-head-zman-name">{shown}</span>
      <bdi dir="ltr" className="ch-head-zman-time">{formatTime(zman.row.at, zman.tz, locale)}</bdi>
    </span>
  );
}

/** The zman that passed last over the next one: one button that opens the sun sheet, its label both lines in words. */
function ZmanWindowLines({ lines, open, onOpen }: { lines: ZmanWindow; open: boolean; onOpen: () => void }) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  const words = (zman: ZmanAt) => ({ name: zmanRowName(t, zman.row), time: formatTime(zman.row.at, zman.tz, locale) });
  const { last, next } = lines;
  const label = [
    last ? (last.when === 'yesterday' ? t('header.lastZmanLabelYesterday', words(last)) : t('header.lastZmanLabel', words(last))) : null,
    next ? (next.when === 'tomorrow' ? t('header.nextZmanLabelTomorrow', words(next)) : t('header.nextZmanLabel', words(next))) : null,
  ].filter(Boolean).join('. ');
  return (
    <button type="button" className="ch-head-zman" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={onOpen}>
      {last ? <ZmanLine zman={last} className="ch-head-zman-row is-last" /> : null}
      {next ? <ZmanLine zman={next} className="ch-head-zman-row is-next" /> : null}
    </button>
  );
}

export function HomeHeader({ today, hebrewDates, zone, sendOpen, menuOpen, onSend, onMenu, onAdd, addOpen, onZmanim, zmanimOpen, weather, zmanWindow }: HomeHeaderProps) {
  const t = useTranslations('calendarHome');
  const locale = useLocale();
  // calendarHome.hebrewMonthGenitive: only Russian reads it (Ruling R9).
  const genitive = locale === 'ru' ? (t.raw('hebrewMonthGenitive') as string[]) : undefined;
  const title = today ? formatDayLong(today, locale) : '';
  const hebrew = today && hebrewDates ? hebrewFullDate(today, locale, genitive) : '';
  // This week's parasha (and its special Shabbat) on the Hebrew date's line, all week: the portions of
  // the first Saturday on or after today, which may fall in next month. They are no holiday: they
  // never make the holiday line and never hide the countdown.
  const shabbat = today ? shabbatOf(today) : null;
  const months = today ? [...new Set([today.slice(0, 7), (shabbat ?? today).slice(0, 7)])] : [];
  const loaded = useHolidays(months, locale, hebrewDates);
  const todays = loaded[today ?? ''];
  const holidays = todays?.filter((h) => !isPortion(h));
  const portions = (shabbat ? loaded[shabbat] : undefined)?.filter(isPortion) ?? [];
  // On a day with no holiday line (known once the month has landed), a muted countdown to the next
  // holiday worth naming, counted in whole days from the server's today, on the Hebrew date's line.
  const quiet = !!today && monthLanded(today.slice(0, 7), locale) && !(holidays && holidays.length > 0);
  const next = useNextHoliday(today, locale, hebrewDates && quiet);
  const away = today && next ? daysBetween(today, next.day) : Number.NaN;
  const countdown = !holidays?.length && away >= 1 && next
    ? (away === 1 ? t('header.nextHolidayTomorrow', { name: next.name }) : t('header.nextHoliday', { name: next.name, count: away }))
    : '';

  return (
    <header className="ch-head">
      <div className="ch-head-text">
        {title ? (
          <h1 className="ch-head-title">{title}</h1>
        ) : (
          <div className="ch-head-ghost" aria-hidden="true">
            <span className="ch-head-ghost-title" />
            <span className="ch-head-ghost-sub" />
          </div>
        )}
        {hebrew ? (
          <p className="ch-head-sub ch-head-line">
            {hebrew}
            {portions.map((portion) => <span key={portion.kind} className="ch-head-next"><bdi>{portion.title}</bdi></span>)}
            {countdown ? <span className="ch-head-next"><bdi>{countdown}</bdi></span> : null}
          </p>
        ) : null}
        {holidays && holidays.length > 0 ? (
          <p className={hasChag(holidays) ? 'ch-head-sub ch-day-holiday is-chag' : 'ch-head-sub ch-day-holiday'}>
            <bdi>{holidayTitles(holidays)}</bdi>
          </p>
        ) : null}
        {zmanWindow && onZmanim ? <ZmanWindowLines lines={zmanWindow} open={zmanimOpen ?? false} onOpen={onZmanim} /> : null}
        {zone ? <p className="ch-head-zone">{t('shell.timesIn', { zone: zoneLabel(zone, locale) })}</p> : null}
      </div>
      <div className="ch-head-side">
        <div className="ch-head-buttons">
          {onAdd ? (
            <button type="button" className="ch-icon-btn ch-icon-btn-accent" aria-label={t('header.add')} aria-haspopup="dialog" aria-expanded={addOpen ?? false} onClick={onAdd}>
              <PlusIcon />
            </button>
          ) : null}
          {onSend ? (
            <button
              type="button"
              className="ch-icon-btn ch-icon-btn-accent"
              aria-label={t('header.send')}
              aria-haspopup="dialog"
              aria-expanded={sendOpen}
              onClick={onSend}
            >
              <SendIcon />
            </button>
          ) : null}
          {onZmanim ? (
            <button type="button" className="ch-icon-btn" aria-label={t('header.zmanim')} aria-haspopup="dialog" aria-expanded={zmanimOpen ?? false} onClick={onZmanim}>
              <SunIcon />
            </button>
          ) : null}
          <button
            type="button"
            className="ch-icon-btn"
            aria-label={t('header.menu')}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={onMenu}
          >
            <MoreIcon />
          </button>
        </div>
        {weather ? <WeatherBlock weather={weather} /> : null}
      </div>
    </header>
  );
}
