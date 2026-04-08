/**
 * Kid Name Detection
 * Detects potential kid names from calendar events and prompts user to confirm
 */

import { CalendarEvent, UserConfig } from '../types';
import { redis } from '../utils/redis';
import { getBot } from './telegram/bot';
import { getBotMessages } from '../lib/bot-messages';

/** Stopwords by language — filtered out from potential name candidates */
const STOPWORDS: Record<string, Set<string>> = {
  he: new Set(['של', 'עם', 'ב', 'ה', 'ל', 'את', 'זה', 'זאת']),
  en: new Set(['at', 'for', 'with', 'the', 'and', 'or', 'in', 'on']),
  ru: new Set(['и', 'для', 'с', 'в', 'на', 'или']),
};

/** Conjunction patterns by language — used to split compound names */
const CONJUNCTIONS: Record<string, RegExp> = {
  he: / ו/,
  en: / and /i,
  ru: / и /,
};

export interface KidNameCandidate {
  name: string;
  eventTitle: string;
  calendarId: string;
  calendarName: string;
}

/**
 * Extract potential kid names from an event title
 * Looks for names after a dash separator, possessive patterns, etc.
 */
export function extractPotentialNames(title: string, language: string): string[] {
  const lang = language || 'en';
  const stopwords = STOPWORDS[lang] || STOPWORDS.en;
  const names: string[] = [];

  // Split on " - " (universal dash pattern) and take the part after the dash
  const dashParts = title.split(' - ');
  if (dashParts.length >= 2) {
    const afterDash = dashParts.slice(1).join(' - ').trim();

    // Split on conjunctions by language
    const conjunction = CONJUNCTIONS[lang] || CONJUNCTIONS.en;
    const parts = afterDash.split(conjunction);

    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length >= 2) {
        names.push(trimmed);
      }
    }
  }

  // Match Hebrew possessive: של (\S+)
  if (lang === 'he') {
    const shelMatch = title.match(/של\s+(\S+)/g);
    if (shelMatch) {
      for (const match of shelMatch) {
        const name = match.replace(/^של\s+/, '').trim();
        if (name.length >= 2) {
          names.push(name);
        }
      }
    }
  }

  // Match English possessive: (\S+)'s
  if (lang === 'en') {
    const possessiveMatch = title.match(/(\S+)'s/g);
    if (possessiveMatch) {
      for (const match of possessiveMatch) {
        const name = match.replace(/'s$/, '').trim();
        if (name.length >= 2) {
          names.push(name);
        }
      }
    }
  }

  // Filter: min 2 chars, no digits, not in stopword list
  return names.filter(name => {
    if (name.length < 2) return false;
    if (/\d/.test(name)) return false;
    if (stopwords.has(name.toLowerCase()) || stopwords.has(name)) return false;
    return true;
  });
}

/**
 * Detect an unknown kid name from other (non-personal, non-spouse) calendar events
 * Returns the first unasked candidate, or null if none found
 */
export async function detectUnknownKidName(
  otherEvents: CalendarEvent[],
  user: UserConfig
): Promise<KidNameCandidate | null> {
  const lang = user.language || 'en';

  // Get known kid names from calendarAssignments with label 'kids'
  const knownKidNames = new Set<string>();
  if (user.calendarAssignments) {
    for (const assignment of user.calendarAssignments) {
      if (assignment.labels.includes('kids')) {
        // The calendar `name` field is the kid's name
        knownKidNames.add(assignment.name.toLowerCase());
      }
    }
  }

  // Get spouse name to exclude
  const spouseNames = new Set<string>();
  if (user.calendarAssignments) {
    for (const assignment of user.calendarAssignments) {
      if (assignment.labels.includes('spouse')) {
        if (assignment.personName) spouseNames.add(assignment.personName.toLowerCase());
        if (assignment.personEnglishName) spouseNames.add(assignment.personEnglishName.toLowerCase());
        // Also use the calendar name
        spouseNames.add(assignment.name.toLowerCase());
      }
    }
  }

  // Collect user's own names to exclude
  const userNames = new Set<string>();
  if (user.name) userNames.add(user.name.toLowerCase());
  if (user.englishName) userNames.add(user.englishName.toLowerCase());

  for (const event of otherEvents) {
    const potentialNames = extractPotentialNames(event.summary, lang);

    for (const name of potentialNames) {
      const normalizedName = name.toLowerCase();

      // Skip known names
      if (knownKidNames.has(normalizedName)) continue;
      if (spouseNames.has(normalizedName)) continue;
      if (userNames.has(normalizedName)) continue;

      // Check Redis dedup: skip if already asked
      const dedupKey = `kidname:asked:${user.id}:${normalizedName}`;
      const alreadyAsked = await redis.get(dedupKey);
      if (alreadyAsked) continue;

      // Return first unasked candidate
      return {
        name,
        eventTitle: event.summary,
        calendarId: event.calendarId,
        calendarName: event.calendarName,
      };
    }
  }

  return null;
}

/**
 * Send a kid name follow-up question via Telegram
 * Non-blocking — intended to be called as fire-and-forget after summary delivery
 */
export async function sendKidNameFollowUp(
  telegramId: number | bigint,
  user: UserConfig,
  otherEvents: CalendarEvent[]
): Promise<void> {
  const candidate = await detectUnknownKidName(otherEvents, user);
  if (!candidate) return;

  const lang = user.language || 'en';
  const pendingId = `kn:${user.id}:${Date.now()}`;

  // Store pending data in Redis with 10 minute TTL
  await redis.set(`kidname:pending:${pendingId}`, JSON.stringify({
    name: candidate.name,
    calendarId: candidate.calendarId,
    userId: user.id,
  }), { ex: 600 });

  // Mark name as asked with 30 day TTL
  await redis.set(`kidname:asked:${user.id}:${candidate.name.toLowerCase()}`, '1', { ex: 30 * 24 * 60 * 60 });

  // Get localized strings
  const t = await getBotMessages(lang);
  const kd = t.kidNameDetection || {};

  const questionText = (kd.question || 'I noticed "{name}" in the event "{event}" on {calendar}. Is {name} your child?')
    .replace(/\{name\}/g, candidate.name)
    .replace(/\{event\}/g, candidate.eventTitle)
    .replace(/\{calendar\}/g, candidate.calendarName);

  const yesText = kd.yes || 'Yes';
  const noText = kd.no || 'No';

  const bot = getBot();
  await bot.sendMessage(Number(telegramId), questionText, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: yesText, callback_data: `kidname_yes:${pendingId}` },
        { text: noText, callback_data: `kidname_no:${pendingId}` },
      ]],
    },
  });
}
