/**
 * QStash schedule definitions
 * All cron schedules are defined here and synced to Upstash QStash via `npm run sync-schedules`
 *
 * Times are in UTC. Israel is UTC+2 (winter) / UTC+3 (summer).
 */

export interface QStashSchedule {
  /** Stable ID for idempotent upserts (prefix: famcalbot-) */
  scheduleId: string;
  /** Cron expression (UTC) */
  cron: string;
  /** API route path (will be appended to base URL) */
  path: string;
  /** Human-readable description */
  description: string;
}

export const QSTASH_SCHEDULES: QStashSchedule[] = [
  {
    scheduleId: 'famcalbot-health',
    cron: '0 3 * * *',
    path: '/api/health',
    description: 'Health check (UTC 3:00 = Israel ~6:00)',
  },
  {
    scheduleId: 'famcalbot-reminders',
    cron: '*/5 * * * *',
    path: '/api/reminders?window=5',
    description: 'Event reminders (every 5 minutes)',
  },
  {
    scheduleId: 'famcalbot-setup-reminders',
    cron: '0 7 * * *',
    path: '/api/setup-reminders',
    description: 'Setup reminders (UTC 7:00 = Israel ~10:00)',
  },
  {
    scheduleId: 'famcalbot-daily-summary',
    cron: '0 * * * *',
    path: '/api/daily-summary',
    description: 'Daily summary (hourly, filters by user preferred hour)',
  },
  {
    scheduleId: 'famcalbot-tomorrow-summary',
    cron: '0 * * * *',
    path: '/api/tomorrow-summary',
    description: 'Tomorrow summary (hourly, filters by user preferred hour)',
  },
];

export const SCHEDULE_ID_PREFIX = 'famcalbot-';
