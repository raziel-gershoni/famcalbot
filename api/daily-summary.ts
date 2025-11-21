import { createCronHandler } from './shared/cron-handler';
import { sendDailySummaryToAll } from '../src/services/telegram';

/**
 * Daily Summary Cron Endpoint
 * Sends today's calendar summary to all users
 * Triggered by cron job at 7 AM daily
 */
export default createCronHandler(
  sendDailySummaryToAll,
  'Daily summaries sent successfully'
);
