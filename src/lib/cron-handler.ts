/**
 * Cron Handler Wrapper
 * Provides QStash signature verification and error handling for all cron jobs
 */

import { NextRequest, NextResponse } from 'next/server';
import { Receiver } from '@upstash/qstash';

interface CronResult {
  success: boolean;
  message: string;
  [key: string]: unknown;
}

interface CronHandlerOptions {
  /** Name of the cron job for logging and error notifications */
  jobName: string;
  /** Handler function that executes the cron job logic */
  handler: (request: NextRequest, searchParams: URLSearchParams) => Promise<CronResult>;
}

let receiver: Receiver | null = null;

function getReceiver(): Receiver | null {
  if (receiver) return receiver;

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentSigningKey || !nextSigningKey) {
    return null;
  }

  receiver = new Receiver({ currentSigningKey, nextSigningKey });
  return receiver;
}

/**
 * Wraps a cron job handler with QStash signature verification and error handling
 *
 * @example
 * ```typescript
 * export async function GET(request: NextRequest) {
 *   return withCronHandler(request, {
 *     jobName: 'Daily Summary',
 *     handler: async () => {
 *       await sendDailySummaryToAll();
 *       return { success: true, message: 'Daily summaries sent' };
 *     }
 *   });
 * }
 * ```
 */
export async function withCronHandler(
  request: NextRequest,
  options: CronHandlerOptions
): Promise<NextResponse> {
  const { jobName, handler } = options;
  const { searchParams } = new URL(request.url);

  // Verify QStash signature
  const qstashReceiver = getReceiver();

  if (!qstashReceiver) {
    console.error(`[${jobName}] QStash signing keys not configured`);
    return NextResponse.json(
      { error: 'Server configuration error' },
      { status: 500 }
    );
  }

  const signature = request.headers.get('upstash-signature');
  if (!signature) {
    console.error(`[${jobName}] Missing upstash-signature header`);
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    const body = await request.text();
    const url = request.url;

    await qstashReceiver.verify({
      signature,
      body,
      url,
    });
  } catch (error) {
    console.error(`[${jobName}] QStash signature verification failed:`, error);
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    const result = await handler(request, searchParams);

    return NextResponse.json({
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[${jobName}] Error in cron handler:`, error);

    // Notify admin of cron job failures
    try {
      const { notifyAdminError } = await import('@/src/utils/error-notifier');
      await notifyAdminError('Cron Job', error, `Job: ${jobName}`);
    } catch (notifyError) {
      console.error(`[${jobName}] Failed to notify admin:`, notifyError);
    }

    return NextResponse.json({
      success: false,
      error: `Failed to execute ${jobName}`,
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
