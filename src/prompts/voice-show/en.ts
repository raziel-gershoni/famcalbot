/**
 * English two-host show prompt: a script for two sports-commentator hosts, as JSON turns.
 *
 * Same content rules as the Hebrew show (./he.ts) and the English narrator
 * (../voice-condenser/en.ts): every event kept, every time in words, weather right
 * after the date, birthday names, the user's own rules. English needs no grammatical
 * gender for the listener, so personal address is the name and "you".
 */

import { sanitizeForPrompt } from '../shared-builders';
import { buildRulesSection } from '../voice-condenser/template';
import { MAX_SOUNDS_PER_SHOW, SOUND_TAGS } from '../../services/voice-show/types';
import type { ShowPerson, ShowPromptContext } from './types';

const SOUND_LIST = SOUND_TAGS.map(sound => `<${sound}>`).join(' ');

// The digests mark built-in calendar reminders with ⏰; only a summary that has one gets this rule.
const REMINDERS_RULE =
  'Reminders (marked ⏰ in the summary) go in too, one quick line each and never a segment of their own: the task, and its time if it has one. One the summary calls still open is said as still open (e.g. "still open since Tuesday"), never as one of the day\'s events.';

function personLine(label: string, person: ShowPerson): string {
  const name = sanitizeForPrompt(person.name);
  if (person.gender === 'male') return `${label}: ${name} (he/him)`;
  if (person.gender === 'female') return `${label}: ${name} (she/her)`;
  return `${label}: ${name} (gender unknown: don't guess. Use the name, never "he" or "she", e.g. "${name} has...", "pickup is on ${name}")`;
}

interface KindRules {
  goal: string;
  content: string[];
  length: string;
  /** Turn count asked for in the output line. */
  turns: [min: number, max: number];
}

// The hosts speak about 2.9 words a second (eval, gaps included).
function kindRules(context: ShowPromptContext): KindRules {
  if (context.kind === 'weekly') {
    const weekRef = context.isNextWeek ? 'next week' : 'this week';
    return {
      goal: `what's coming up for the listener ${weekRef}`,
      content: [
        `Open with a quick overview (e.g. "Here's what's waiting for you ${weekRef}").`,
        context.culture === 'jewish'
          ? 'Use dates the way the summary gives them, with the Hebrew date if it has one, but never say a year, Hebrew or Gregorian.'
          : 'Use dates the way the summary gives them, without the year.',
        'Go day by day with relative days ("on Tuesday", "on Thursday") and highlight the big events.',
        'Every event in the summary goes in, with its day and time. Several events on the same day may share one turn.',
        "For family events, say naturally whose event it is.",
        "A week with no events: say the calendar is clear. Never invent events.",
      ],
      length: 'about 45-60 seconds of speech (roughly 130-170 words). A busy week may run longer, but never at the cost of events.',
      turns: [6, 20],
    };
  }

  // /weather sends the whole forecast text: today and tomorrow, the week, and a 16-day
  // outlook, written around the time it was asked for.
  if (context.kind === 'weather') {
    return {
      goal: 'the whole weather forecast: now, tomorrow and the days ahead',
      content: [
        "Greeting: the same one the forecast opens with. If it has no time-of-day greeting, don't invent one.",
        'Weather only: temperatures, rain, wind, and air quality if the forecast mentions it.',
        'First now and the rest of today, then tomorrow. If the forecast was written in the evening (it opens with "Good evening" or talks about tonight), flip the order: lead with tomorrow, and keep tonight to one short sentence.',
        'The week: a turn or two, only the trend and the notable changes. Here you may group days.',
        'The extended outlook: at most one sentence, hedged ("likely", "expected").',
        'End with one practical tip (umbrella, sunscreen, an extra layer).',
      ],
      length: 'about 35-50 seconds of speech (roughly 85-115 words), 6-10 turns.',
      turns: [6, 10],
    };
  }

  // The tomorrow summary goes out in the evening; without these rules the Hebrew writer
  // opened with "good morning" and "today" even when the summary said "tomorrow".
  if (context.kind === 'tomorrow') {
    return {
      goal: "what's waiting for the listener tomorrow",
      content: [
        'An evening greeting: the same one the summary opens with (usually "Good evening"). Never "Good morning": if the summary opens with one, open with the name and no time-of-day greeting.',
        'Say "tomorrow" in the very first sentence: this is tomorrow\'s schedule. Then tomorrow\'s date with the weekday, e.g. "Tomorrow, Monday, ...", never with a year.',
        'Everything in the summary happens tomorrow. Never call it "today": not "today is Monday", not "later today", not "tonight" for tomorrow evening. Say "tomorrow", "tomorrow morning", "tomorrow evening".',
        "Tomorrow's weather comes right after the date, before the schedule: a sentence or two with a practical tip.",
        'Every event in the summary goes in, with its time. Several small events may share one turn.',
        'Kids: brief and natural (e.g. "pick up Danny at two").',
        'A look at the week, if the summary has one: brief, only the main events.',
        "Nothing on tomorrow: say tomorrow's calendar is clear and celebrate it. Never invent events.",
        'A closing that fits the evening and gets the listener ready for tomorrow.',
      ],
      length: 'about 45-60 seconds of speech (roughly 130-170 words). A busy day may run longer, but never at the cost of events.',
      turns: [6, 20],
    };
  }

  return {
    goal: "the listener's day",
    content: [
      'Greeting: the same one the summary opens with ("Good morning", "Good afternoon" or "Good evening"). If it has none, don\'t invent a time-of-day greeting.',
      context.culture === 'jewish'
        ? 'Say the date with the weekday the way the summary gives it, with the Hebrew date if it has one, but never say a year, Hebrew or Gregorian.'
        : 'Say the date with the weekday the way the summary gives it, without the year.',
      'The weather comes right after the date, before the schedule: a sentence or two with a practical tip.',
      'Every event in the summary goes in, with its time. Several small events may share one turn.',
      'Kids: brief and natural (e.g. "pick up Danny at two").',
      'A look at the week, if the summary has one: brief, only the main events.',
      'A day with no events: say the calendar is clear and celebrate it. Never invent events.',
    ],
    length: 'about 45-60 seconds of speech (roughly 130-170 words). A busy day may run longer, but never at the cost of events.',
    turns: [6, 20],
  };
}

export function buildShowPrompt(context: ShowPromptContext): string {
  const { goal, content, length, turns: [minTurns, maxTurns] } = kindRules(context);
  const listener = sanitizeForPrompt(context.listener.name);

  const family = [`The listener: ${listener}. Address them by name and as "you".`];
  if (context.spouse) family.push(personLine('Spouse or partner', context.spouse));
  for (const kid of context.kids) family.push(personLine('Child', kid));
  if (!context.kids.length && context.hasKidsCalendars) family.push("There are kids' calendars.");

  const rules = buildRulesSection(context.globalRules, "The user's own rules (apply these):");

  const allContent = [
    ...content,
    ...(context.summary.includes('⏰') ? [REMINDERS_RULE] : []),
    'Every time in full words, never digits, 12-hour, with the part of day whenever the hour alone could be morning or evening: "nine in the morning", "ten fifteen in the morning", "four thirty in the afternoon", "six forty-five in the evening".',
    'Other numbers in words too, e.g. temperatures ("twenty-eight degrees").',
    'Birthdays: take the person\'s name from the event ("it\'s John\'s birthday").',
    'Full names, no abbreviations.',
    'Keep what the summary says about midnight: an event that runs "past midnight" ends in the small hours after this day, and one that "started yesterday" is not starting today.',
    'The hype and the jokes never add or drop facts: no events, times, names or details that are not in the summary.',
  ];

  return `You are writing the script of a short English audio show about ${goal}: two excited hosts in the style of sports commentators.

**The family:**
${family.join('\n')}
${rules}
**The hosts:**
- A: the lead host. Warm, confident, late thirties.
- B: the young host. Energetic, in his twenties.
Both are men. They have no names; don't invent any.

**Content (required):**
${allContent.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

**Style:**
- Sports broadcast energy: pace, excitement, hand-offs between the hosts, "Let's go!", "What a day!". The energy is in the delivery, not the vocabulary: at most one sports metaphor per show, and no stock "game day" lines.
- Talk like live American radio: contractions everywhere ("it's", "here's", "you've got"), never "it is" or "here is".
- Personal: say ${listener}'s name in the opening and talk to ${listener} directly as "you". Not "you all" or "folks".
- Only ${listener} is "you". The hosts never say "you" or "your" to each other.
- Short turns: a sentence or two each. The hosts alternate and react to each other.
- Length: ${length}
- A short opening and a short, energetic close.

**Mood for each turn, one from the list:**
- hype: the default, a commentator's excitement
- triumph: celebration (good news, a winning day)
- suspense: tension before something big
- amused: amused
- surprised: surprised
- mock_disappointed: playful disappointment (rain, an early wake-up)
- secret: a secret or a hint of a surprise
- warm: warm and calm (the close, a touching moment)
Most turns are hype. Mix in 2-4 other moods where the content earns them.

**Sounds:**
- None by default: most shows have no sound at all, and that's fine.
- A sound is only ever a reaction to something concrete in the script: <laugh> or <chuckle> right after something that's actually funny, in the same turn or the one before; <sigh> at a genuinely heavy day; <gasp> at a real surprise; <whispers> to let the listener in on a real secret or surprise from the summary; <throat-clearing> right before a genuinely big announcement.
- Never as filler, never on a neutral line (just an event and its time), and never in the opening or closing turn.
- From this list only: ${SOUND_LIST}
- At most ${MAX_SOUNDS_PER_SHOW} in the whole show, and never in two consecutive turns.
- No other tags at all: no HTML, no emoji, no markdown, no stage directions like (laughs) or *sighs*.
- No interjections between bars like |wow|. A host's reaction is a short turn of his own, with words: a sound alone is not a turn.
- Don't write "A:" or "B:" inside the text.

**Output:** JSON only, ${minTurns} to ${maxTurns} turns:
{"turns":[{"host":"A","mood":"hype","text":"..."},{"host":"B","mood":"amused","text":"..."}]}

**The original summary (with formatting — ignore the formatting):**
${context.summary}`;
}
