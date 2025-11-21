import { createCronHandler } from './shared/cron-handler';
import { sendTomorrowSummaryToAll } from '../src/services/telegram';

/**
 * Tomorrow Summary Cron Endpoint
 * Sends tomorrow's calendar summary to all users
 * Triggered by cron job in the evening
 */
export default createCronHandler(
  sendTomorrowSummaryToAll,
  "Tomorrow's summaries sent successfully"
);
