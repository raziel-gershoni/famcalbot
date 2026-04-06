/**
 * Subscription Plan Configuration
 * Defines limits and features for each subscription tier
 */

export type PlanId = 'FREE' | 'BASIC' | 'PRO';

export interface PlanLimits {
  textSummaries: number;      // per month (Infinity = unlimited)
  voiceSummaries: number;     // per month
  calendars: number;          // max calendars
  reminders: boolean;         // feature enabled
  voiceEvents: boolean;       // voice event creation
}

export interface PlanConfig {
  id: PlanId;
  name: string;
  priceStars: number;         // Telegram Stars price (0 = free)
  priceUsd: number;           // Approximate USD price
  limits: PlanLimits;
  features: string[];         // Marketing feature list
}

export const PLAN_CONFIGS: Record<PlanId, PlanConfig> = {
  FREE: {
    id: 'FREE',
    name: 'Free',
    priceStars: 0,
    priceUsd: 0,
    limits: {
      textSummaries: 10,
      voiceSummaries: 3,
      calendars: 3,
      reminders: false,
      voiceEvents: false,
    },
    features: [
      '10 text summaries/month',
      '3 voice summaries/month',
      'Up to 3 calendars',
    ],
  },
  BASIC: {
    id: 'BASIC',
    name: 'Basic',
    priceStars: 1500,
    priceUsd: 30,
    limits: {
      textSummaries: Infinity,
      voiceSummaries: Infinity,
      calendars: 5,
      reminders: false,
      voiceEvents: false,
    },
    features: [
      'Unlimited text summaries',
      'Unlimited voice summaries',
      'Up to 5 calendars',
    ],
  },
  PRO: {
    id: 'PRO',
    name: 'Pro',
    priceStars: 2500,
    priceUsd: 50,
    limits: {
      textSummaries: Infinity,
      voiceSummaries: Infinity,
      calendars: Infinity,
      reminders: true,
      voiceEvents: true,
    },
    features: [
      'Unlimited text summaries',
      'Unlimited voice summaries',
      'Unlimited calendars',
      'Event reminders',
      'Voice event creation',
    ],
  },
};

// Trial duration in days
export const TRIAL_DURATION_DAYS = 14;

/**
 * Get plan configuration by ID
 */
export function getPlanConfig(planId: PlanId): PlanConfig {
  return PLAN_CONFIGS[planId];
}

/**
 * Get plan limits by ID
 */
export function getPlanLimits(planId: PlanId): PlanLimits {
  return PLAN_CONFIGS[planId].limits;
}

/**
 * Check if a plan has a specific feature
 */
export function planHasFeature(
  planId: PlanId,
  feature: keyof Pick<PlanLimits, 'reminders' | 'voiceEvents'>
): boolean {
  return PLAN_CONFIGS[planId].limits[feature];
}

/**
 * Get limit for a usage type
 */
export function getPlanLimit(
  planId: PlanId,
  limitType: keyof Pick<PlanLimits, 'textSummaries' | 'voiceSummaries' | 'calendars'>
): number {
  return PLAN_CONFIGS[planId].limits[limitType];
}
