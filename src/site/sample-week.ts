// The landing's sample family (spec 2026-10-28-public-website §4, §5.3; copy deck §3.2): the week the hero's live app
// parts show, built on the server in the visitor's language. The people are made up per language (landing.sample.*),
// never a real user. The days are relative to the day the page is rendered, so the weekdays and the Hebrew dates are
// always right: the coming Thursday (never today) and the Friday after it.
//
// - Thursday 16:00-17:00: the dentist, on the kids' calendar: the event the voice note makes.
// - Thursday 17:30-18:15: swimming, on the kids' calendar, every week.
// - Thursday 20:00-21:00: the parents' evening, on the viewer's own calendar.
// - Friday, all day: Grandma's birthday, every year on the Hebrew date, its 72nd (the agenda shows the count).
// - Friday 12:00: the Shabbat-flowers reminder for both of them, each marking Done; the partner already has.
//
// Wall times become instants only through wallTimeToInstant, in Israel's zone (CLAUDE.md), so the server's own zone
// changes nothing. The rows are the calendar home's own model (AgendaModel), which the real AgendaView draws.

import type { AgendaDay, AgendaModel, AgendaRow } from '@/src/lib/calendar-view/agenda';
import { addDaysToKey } from '@/src/lib/calendar-view/store';
import type { DayKey, ItemDTO } from '@/src/lib/calendar-view/types';
import { instantToWallTime, wallTimeToInstant } from '@/src/utils/wall-time';

export const SAMPLE_TZ = 'Asia/Jerusalem';
/** The original Hebrew year of Grandma's birthday is this many years back: the agenda's count. */
export const SAMPLE_BIRTHDAY_COUNT = 72;

/** The calendars' colours (Google's palette, as a FamCal calendar has them): the kids', the viewer's, the birthdays'. */
const COLOURS = { kids: '#F4511E', self: '#7986CB', birthdays: '#8E24AA' } as const;

export interface SampleWords {
  dentist: string;
  swimming: string;
  parents: string;
  birthday: string;
  reminder: string;
  self: string;
  partner: string;
  kids: string;
  birthdays: string;
}

type Translate = (key: string) => string;

export function sampleWords(t: Translate): SampleWords {
  return {
    dentist: t('landing.sample.events.dentist'),
    swimming: t('landing.sample.events.swimming'),
    parents: t('landing.sample.events.parents'),
    birthday: t('landing.sample.events.birthday'),
    reminder: t('landing.sample.reminder'),
    self: t('landing.sample.calendars.self'),
    partner: t('landing.sample.calendars.partner'),
    kids: t('landing.sample.calendars.kids'),
    birthdays: t('landing.sample.calendars.birthdays'),
  };
}

export interface SampleWeek {
  agenda: AgendaModel;
  thursday: DayKey;
  /** The dentist's start and end as instants, for the bot's card. */
  dentist: { start: string; end: string; calendar: string };
}

/** The coming Thursday after `today` (a week on when today is Thursday). */
export function comingThursday(today: DayKey): DayKey {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDaysToKey(today, (4 - weekday + 7) % 7 || 7);
}

const at = (day: DayKey, hhmm: string) => wallTimeToInstant(`${day}T${hhmm}`, SAMPLE_TZ).toISOString();

function item(over: Partial<ItemDTO> & Pick<ItemDTO, 'key' | 'title' | 'start' | 'end' | 'calendar'>): ItemDTO {
  return {
    source: 'famcal',
    readOnly: false,
    id: over.key,
    seriesId: null,
    originalStart: null,
    kind: 'event',
    allDay: false,
    tz: SAMPLE_TZ,
    recurring: false,
    repeatsDaily: false,
    repeatsEveryDay: false,
    canEdit: false,
    span: null,
    location: null,
    description: null,
    ...over,
  };
}

const mine = { mine: true, person: null, relation: null } as const;

export function buildSampleWeek(words: SampleWords, now: Date = new Date()): SampleWeek {
  const today = instantToWallTime(now, SAMPLE_TZ).slice(0, 10);
  const thursday = comingThursday(today);
  const friday = addDaysToKey(thursday, 1);
  const cal = (name: string, color: string) => ({ id: `sample:${color}`, name, color, mine: true, inLegend: true });
  const kids = cal(words.kids, COLOURS.kids);

  const dentist = item({ key: 'sample-dentist', title: words.dentist, start: at(thursday, '16:00'), end: at(thursday, '17:00'), calendar: kids });
  const thursdayRows: AgendaRow[] = [
    { item: dentist, whose: mine, mark: null },
    { item: item({ key: 'sample-swimming', title: words.swimming, start: at(thursday, '17:30'), end: at(thursday, '18:15'), calendar: kids, recurring: true }), whose: mine, mark: null },
    { item: item({ key: 'sample-parents', title: words.parents, start: at(thursday, '20:00'), end: at(thursday, '21:00'), calendar: cal(words.self, COLOURS.self) }), whose: mine, mark: null },
  ];
  const fridayRows: AgendaRow[] = [
    {
      item: item({ key: 'sample-birthday', title: words.birthday, start: friday, end: addDaysToKey(friday, 1), allDay: true, recurring: true, anniversary: SAMPLE_BIRTHDAY_COUNT, calendar: cal(words.birthdays, COLOURS.birthdays) }),
      whose: mine,
      mark: null,
    },
    {
      item: item({
        key: 'sample-flowers',
        kind: 'reminder',
        title: words.reminder,
        start: at(friday, '12:00'),
        end: at(friday, '12:00'),
        calendar: cal(words.self, COLOURS.self),
        reminder: {
          done: false,
          doneAt: null,
          snoozedUntil: null,
          open: false,
          openSince: null,
          ownerIsViewer: true,
          creatorIsViewer: true,
          forBoth: true,
          eachMarksDone: true,
          partnerDone: true,
          partnerName: words.partner,
        },
      }),
      whose: { mine: true, person: null, relation: 'both' },
      mark: 'later',
    },
  ];
  const day = (date: DayKey, rows: AgendaRow[]): AgendaDay => ({ type: 'day', date, relative: null, status: 'answered', rows });

  return {
    thursday,
    dentist: { start: dentist.start, end: dentist.end, calendar: words.kids },
    agenda: {
      today,
      tz: SAMPLE_TZ,
      weekStart: 0,
      hebrewDates: true,
      weeks: 1,
      end: addDaysToKey(friday, 1),
      stateRows: [],
      partial: false,
      unavailableCalendars: 0,
      stillOpen: null,
      entries: [day(thursday, thursdayRows), day(friday, fridayRows)],
      empty: false,
    },
  };
}
