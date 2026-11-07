/**
 * Whose lines a guest answer has, and which of them a question asked about (spec
 * docs/superpowers/specs/2026-11-08-ask-in-chat-people-design.md §3). Pure: no database, no model.
 *
 * The people come from the labels the calendars already carry (getCalendarsWithOwners): the caller, the partner, each
 * kid by the person named on their calendar, and the family (a calendar with no label). The model never gets these
 * names: it says who was asked as a kind, and a person's name as the messages write it, and the name is matched here.
 */

import type { CalendarAssignment } from '../../types';
import type { Locale } from '../../utils/locale';
import type { AskGroup, AskWho } from './window';

export type PersonKind = 'me' | 'partner' | 'kid' | 'family';

export interface Person {
  /** One line each: 'me', 'partner', 'family', or 'kid:<folded name>' ('kid:' for the kids' calendars with no name). */
  key: string;
  kind: PersonKind;
  /** The name the line starts with; null is the language's word for them (bot.askInChat.people). */
  name: string | null;
  /** The names a question may call them by, folded (foldName): each whole name and its first word. */
  aliases: string[];
  /** The calendars whose events are theirs, in the list's order. */
  calendarIds: string[];
}

/** The names a user row carries: the caller's UserConfig, or the partner's getActivePartnerSummary. */
export interface NamedUser {
  name?: string | null;
  englishName?: string | null;
}

export interface PeopleInput {
  /** The calendars the summary reads (getCalendarsWithOwners), labelled from the caller's side. */
  assignments: readonly CalendarAssignment[];
  /** The FamCal calendars the partner owns, by id. */
  partnerOwned: ReadonlySet<string>;
  me: NamedUser;
  /** The ACTIVE partner, or null. */
  partner: NamedUser | null;
  locale: Locale;
}

/** Google's public holiday calendars: never busy (ruling 12 of the 2026-11-07 spec), so no one's. */
export const HOLIDAY_CALENDAR = /#holiday@group\.v\.calendar\.google\.com$/;

const NIQQUD = /[֑-ׇ]/g;
const QUOTES = /['’`"׳״]/g;
/** One Hebrew prefix letter (ו, ב, כ, ל, מ, ש, ה) before at least two more letters: "למאיה". */
const HEBREW_PREFIX = /^[ובכלמשה](?=[א-ת]{2})/;

/** A name as both sides may write it: no niqqud, no apostrophe or geresh, ё as е, lower case, single spaces. */
export function foldName(name: string): string {
  return name
    .normalize('NFD')
    .replace(NIQQUD, '')
    .normalize('NFC')
    .replace(QUOTES, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A name as a line shows it: on one line, trimmed; empty is none. */
const tidy = (name?: string | null): string => (name ?? '').replace(/\s+/g, ' ').trim();
const firstWord = (name?: string | null): string => tidy(name).split(' ')[0];

/** Each name folded, whole and its first word, without empties or repeats. */
function aliasesOf(...names: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const folded = foldName(name ?? '');
    if (!folded) continue;
    out.add(folded);
    out.add(folded.split(' ')[0]);
  }
  return [...out];
}

/** A calendar's person in the answer's language: the English name in an English or Russian answer, when it is set. */
function personNameOf(a: CalendarAssignment, locale: Locale): string {
  const english = tidy(a.personEnglishName);
  return locale !== 'he' && english ? english : tidy(a.personName);
}

/**
 * The people of an answer, in its order: the caller, the partner, the kids (in calendar order), the family.
 * - A FamCal calendar the partner owns is the partner's; one the partner labelled spouse (about the caller: `yours` from
 *   the caller's side) is the caller's; labelled kids (labelsFromViewerSide keeps it) it is the kids'. A calendar with
 *   several labels counts for each.
 * - Any other calendar: primary or yours is the caller's, spouse the partner's, kids the kid its person names, and no
 *   label the family's. A calendar with several labels counts for each of them.
 * - A birthdays calendar and a Google holiday calendar are no one's: they are never busy.
 * Kids' calendars that name the same person (folded) are one line, and so are those that name no one ("Kids"). The
 * caller is there with no calendar when no calendar is anyone's, so an answer always has a line.
 * Names: the caller's first name (user.name); the partner's first name from the pairing, else the first spouse
 * calendar's person; a kid's person (personEnglishName in an English or Russian answer when set). None is null.
 */
export function peopleOf(input: PeopleInput): Person[] {
  const mine: string[] = [];
  const partners: string[] = [];
  const family: string[] = [];
  const kids = new Map<string, Person>();
  let spouseName = '';
  const spouseAliases: string[] = [];
  for (const a of input.assignments) {
    const labels = a.labels ?? [];
    if (labels.includes('birthdays') || HOLIDAY_CALENDAR.test(a.calendarId)) continue;
    const kid = labels.includes('kids');
    const partnersOwn = input.partnerOwned.has(a.calendarId);
    // labels are from the caller's side already (labelsFromViewerSide): on a calendar the partner owns, `yours` is one
    // the partner labelled spouse (about the caller), `spouse` is the partner's own; no other label makes it the partner's.
    const about = labels.includes('yours');
    const partner = partnersOwn ? labels.includes('spouse') || (!about && !kid) : labels.includes('spouse');
    const me = partnersOwn ? about : labels.includes('primary') || about;
    if (me) mine.push(a.calendarId);
    if (partner) {
      partners.push(a.calendarId);
      if (!spouseName) spouseName = personNameOf(a, input.locale);
      spouseAliases.push(...aliasesOf(a.personName, a.personEnglishName));
    }
    if (kid) {
      const name = personNameOf(a, input.locale);
      const key = `kid:${foldName(name)}`;
      const aliases = aliasesOf(a.personName, a.personEnglishName);
      const known = kids.get(key);
      if (known) {
        known.calendarIds.push(a.calendarId);
        known.aliases = [...new Set([...known.aliases, ...aliases])];
      } else {
        kids.set(key, { key, kind: 'kid', name: name || null, aliases, calendarIds: [a.calendarId] });
      }
    }
    if (!me && !partner && !kid) family.push(a.calendarId);
  }
  const meName = firstWord(input.me.name) || null;
  const meAliases = aliasesOf(input.me.name, input.me.englishName);
  const people: Person[] = [];
  if (mine.length > 0) people.push({ key: 'me', kind: 'me', name: meName, aliases: meAliases, calendarIds: mine });
  if (partners.length > 0) {
    people.push({
      key: 'partner',
      kind: 'partner',
      name: firstWord(input.partner?.name) || spouseName || null,
      aliases: [...new Set([...aliasesOf(input.partner?.name, input.partner?.englishName), ...spouseAliases])],
      calendarIds: partners,
    });
  }
  people.push(...kids.values());
  if (family.length > 0) people.push({ key: 'family', kind: 'family', name: null, aliases: [], calendarIds: family });
  if (people.length === 0) people.push({ key: 'me', kind: 'me', name: meName, aliases: meAliases, calendarIds: [] });
  return people;
}

/** Which lines the question asked for. */
export interface Asked {
  /** The lines asked for, by key, each shown busy or free; null: no one in particular (the caller's line and every busy one). */
  keys: ReadonlySet<string> | null;
  /** For the log, never a name: the kind asked, `<kind>-none` when no line is theirs, `none` when no one was asked. */
  log: string;
}

const GROUP_KIND: Record<Exclude<AskGroup, 'everyone'>, PersonKind> = { me: 'me', partner: 'partner', kids: 'kid', family: 'family' };

/** The ways an asked name may match, in order: as written, its first word, each without a Hebrew prefix letter. */
function askedForms(name: string): string[] {
  const folded = foldName(name);
  const first = folded.split(' ')[0];
  return [...new Set([folded, first, folded.replace(HEBREW_PREFIX, ''), first.replace(HEBREW_PREFIX, '')])].filter(Boolean);
}

/**
 * The lines a question asked for (spec §3.3): a group's lines, everyone's, or the lines one name matches (the first form
 * of it that any line answers; folded, so case, niqqud and ё don't matter). A group with no line, or a name no line
 * answers, is no one in particular.
 */
export function askedLines(who: AskWho | null, people: readonly Person[]): Asked {
  if (!who) return { keys: null, log: 'none' };
  let picked: readonly Person[] = [];
  if (who.kind === 'person') {
    for (const form of askedForms(who.name)) {
      picked = people.filter(p => p.aliases.includes(form));
      if (picked.length > 0) break;
    }
  } else if (who.kind === 'everyone') {
    picked = people;
  } else {
    const kind = GROUP_KIND[who.kind];
    picked = people.filter(p => p.kind === kind);
  }
  if (picked.length === 0) return { keys: null, log: `${who.kind}-none` };
  return { keys: new Set(picked.map(p => p.key)), log: who.kind };
}
