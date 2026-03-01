/**
 * Sync QStash schedules from config to Upstash
 *
 * Usage:
 *   QSTASH_BASE_URL=https://famcal.bot npm run sync-schedules
 *
 * Requires env vars: QSTASH_TOKEN (from .env or environment)
 */

import 'dotenv/config';
import { Client } from '@upstash/qstash';
import { QSTASH_SCHEDULES, SCHEDULE_ID_PREFIX } from '../src/config/qstash-schedules';

async function main() {
  const token = process.env.QSTASH_TOKEN;
  if (!token) {
    console.log('[sync-schedules] QSTASH_TOKEN not set, skipping schedule sync');
    return;
  }

  // QSTASH_BASE_URL explicit, or derive from Vercel's auto-provided URL
  const baseUrl = process.env.QSTASH_BASE_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined);

  if (!baseUrl) {
    console.log('[sync-schedules] No base URL available, skipping schedule sync');
    return;
  }

  const client = new Client({ token });

  console.log(`\nSyncing ${QSTASH_SCHEDULES.length} schedules to QStash...`);
  console.log(`Base URL: ${baseUrl}\n`);

  // Upsert each schedule
  for (const schedule of QSTASH_SCHEDULES) {
    const destination = `${baseUrl}${schedule.path}`;

    try {
      await client.schedules.create({
        scheduleId: schedule.scheduleId,
        destination,
        cron: schedule.cron,
      });
      console.log(`  ✓ ${schedule.scheduleId} → ${schedule.cron} → ${schedule.path}`);
    } catch (error) {
      console.error(`  ✗ ${schedule.scheduleId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Check for orphaned schedules
  console.log('\nChecking for orphaned schedules...');
  try {
    const existing = await client.schedules.list();
    const configIds = new Set(QSTASH_SCHEDULES.map(s => s.scheduleId));

    const orphaned = existing.filter(
      s => s.scheduleId?.startsWith(SCHEDULE_ID_PREFIX) && !configIds.has(s.scheduleId)
    );

    if (orphaned.length > 0) {
      console.log(`\n  ⚠ Found ${orphaned.length} orphaned schedule(s) with prefix "${SCHEDULE_ID_PREFIX}":`);
      for (const s of orphaned) {
        console.log(`    - ${s.scheduleId} (cron: ${s.cron}, destination: ${s.destination})`);
      }
      console.log('  Consider deleting these manually in the Upstash dashboard.');
    } else {
      console.log('  No orphaned schedules found.');
    }
  } catch (error) {
    console.warn('  Could not check for orphaned schedules:', error instanceof Error ? error.message : error);
  }

  console.log('\nDone!');
}

main();
