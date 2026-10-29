// The landing's plan cards (spec 2026-10-28-public-website §3.2.5, §6.3), built from src/config/plans.ts so a change to
// a plan's price or limits changes its card. The words are messages (landing.plans.*), never PLAN_CONFIGS' English
// `features`; a limit of Infinity reads as its "unlimited" words and is never printed as a number. No early access.
//
// Which bullets a card shows (copy deck §2.5):
// - the summaries: both limits unlimited is one bullet; otherwise each limit is its own (a count, or unlimited);
// - the calendars: up to N, or unlimited;
// - a plan that holds everything of the plan below it (Pro over Basic) says so first, then only what it adds;
// - one bullet for each feature the plan turns on: reminders, adding events by voice (and photo or PDF on
//   Telegram), Copy to Google.
// Client-safe: it imports only the plan table, which imports nothing.

import { PLAN_CONFIGS, type PlanConfig, type PlanId, type PlanLimits } from '@/src/config/plans';

export interface PlanCard {
  id: PlanId;
  name: string;
  /** "No payment", or the Stars price a month in the locale's digits. */
  price: string;
  /** The price as a screen reader says it ("2,500 Telegram Stars a month"); null for the free plan. */
  priceA11y: string | null;
  bullets: string[];
  /** The plan with everything (Pro): its card is outlined. */
  top: boolean;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

const ORDER: PlanId[] = ['FREE', 'BASIC', 'PRO'];
/** The plan a card sums up as "Everything in <plan>": Pro over Basic. */
const INCLUDES: Partial<Record<PlanId, PlanId>> = { PRO: 'BASIC' };
const FLAGS = [
  ['reminders', 'reminders'],
  ['voiceEvents', 'voiceEvents'],
  ['googleSync', 'googleCopy'],
] as const;
const COUNTS = ['textSummaries', 'voiceSummaries', 'calendars'] as const;

function summaryBullets(t: Translate, limits: PlanLimits): string[] {
  const { textSummaries: text, voiceSummaries: voice } = limits;
  if (text === Infinity && voice === Infinity) return [t('landing.plans.bullets.summariesUnlimited')];
  return [
    text === Infinity ? t('landing.plans.bullets.textUnlimited') : t('landing.plans.bullets.textSummaries', { count: text }),
    voice === Infinity ? t('landing.plans.bullets.voiceUnlimited') : t('landing.plans.bullets.voiceSummaries', { count: voice }),
  ];
}

const calendarBullet = (t: Translate, limits: PlanLimits) =>
  limits.calendars === Infinity ? t('landing.plans.bullets.calendarsUnlimited') : t('landing.plans.bullets.calendars', { count: limits.calendars });

/** Whether `plan` holds at least everything `base` does. */
function covers(plan: PlanLimits, base: PlanLimits): boolean {
  return COUNTS.every((k) => plan[k] >= base[k]) && FLAGS.every(([flag]) => plan[flag] || !base[flag]);
}

export function planCards(t: Translate, configs: Record<PlanId, PlanConfig> = PLAN_CONFIGS): PlanCard[] {
  return ORDER.map((id) => {
    const { limits, priceStars } = configs[id];
    const key = id.toLowerCase();
    const base = INCLUDES[id] ? configs[INCLUDES[id]] : null;
    const bullets: string[] = [];
    if (base && covers(limits, base.limits)) {
      bullets.push(t('landing.plans.bullets.everythingInBasic'));
      const summaryChanged = limits.textSummaries !== base.limits.textSummaries || limits.voiceSummaries !== base.limits.voiceSummaries;
      if (summaryChanged) bullets.push(...summaryBullets(t, limits));
      if (limits.calendars !== base.limits.calendars) bullets.push(calendarBullet(t, limits));
      for (const [flag, word] of FLAGS) if (limits[flag] && !base.limits[flag]) bullets.push(t(`landing.plans.bullets.${word}`));
    } else {
      bullets.push(...summaryBullets(t, limits), calendarBullet(t, limits));
      for (const [flag, word] of FLAGS) if (limits[flag]) bullets.push(t(`landing.plans.bullets.${word}`));
    }
    return {
      id,
      name: t(`landing.plans.${key}.name`),
      price: priceStars === 0 ? t('landing.plans.free.price') : t('landing.plans.price', { price: priceStars }),
      priceA11y: priceStars === 0 ? null : t('landing.plans.priceA11y', { price: priceStars }),
      bullets,
      top: id === ORDER[ORDER.length - 1],
    };
  });
}
