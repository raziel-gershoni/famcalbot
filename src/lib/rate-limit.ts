/**
 * Rate Limiting with Upstash Redis
 */

import { Ratelimit } from '@upstash/ratelimit';
import { redis } from '@/src/utils/redis';

// Rate limiters for different endpoints
// execute-command: 5 requests per minute (expensive operations)
export const commandRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '1 m'),
  prefix: 'ratelimit:command',
});

// settings/calendars: 10 requests per minute
export const settingsRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '1 m'),
  prefix: 'ratelimit:settings',
});

// General API: 30 requests per minute
export const generalRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '1 m'),
  prefix: 'ratelimit:general',
});

// check-token-refresh: 60 requests per minute, on a budget of its own. /refresh-token polls
// it every 2 s while Google is open, which alone would use up the general limit, and with it
// the select-calendars page-data load that follows the commit
export const tokenPollRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, '1 m'),
  prefix: 'ratelimit:token-poll',
});

// calendar/range: 60 requests per minute, on a budget of its own. The calendar home asks
// for each source's days on every open and every return to the foreground, and the Month
// tab fetches the month on screen and the ones next to it, which would soon use up the
// general limit
export const calendarRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, '1 m'),
  prefix: 'ratelimit:calendar',
});

// calendar/reminder: 30 requests per minute, on a budget of its own. Done, undo and
// snooze are single taps, but a run through a list of reminders is bursty, and the
// home's other reads must not be starved by it
export const reminderActionRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '1 m'),
  prefix: 'ratelimit:reminder-action',
});

// calendar/items: 20 writes per minute, on a budget of its own. A person adds, edits or
// deletes one thing at a time; the budget is for a slip of the thumb or a stuck retry,
// and keeps a script from filling a calendar
export const calendarWriteRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '1 m'),
  prefix: 'ratelimit:calendar-write',
});

// push/devices (subscribe, check, unsubscribe): 20 requests per minute per account, on a budget of its own. A person turns
// a device on or off one tap at a time, and the app's open checks the browser's own endpoint once; the budget is for a
// stuck retry, and it keeps a script from walking endpoints through the check route
export const pushDeviceRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '1 m'),
  prefix: 'ratelimit:push-device',
});

// Ask FamCal in a chat (Guest Mode): 10 questions a minute per Telegram id, on a budget of its own. Each one is a model
// call and a calendar read; a person asks one at a time, and the budget keeps a script from running up either
export const askInChatRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '1 m'),
  prefix: 'ratelimit:ask-in-chat',
});

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  reset: number;
}

/**
 * Check rate limit for a user
 */
export async function checkRateLimit(
  limiter: Ratelimit,
  identifier: string | number
): Promise<RateLimitResult> {
  try {
    const result = await limiter.limit(String(identifier));
    return {
      success: result.success,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch (error) {
    console.error('[RateLimit] Error checking rate limit:', error);
    // Fail closed - deny request if Redis is down
    return { success: false, remaining: 0, reset: 0 };
  }
}

/**
 * Get rate limit headers for response
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.reset),
  };
}
