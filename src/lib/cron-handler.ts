/**
 * Cron Handler Wrapper
 * Provides consistent auth verification and error handling for all cron jobs
 */

import { NextRequest, NextResponse } from 'next/server';

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

/**
 * Wraps a cron job handler with standard auth verification and error handling
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

  // Verify the secret token
  const providedSecret = searchParams.get('secret') || request.headers.get('x-cron-secret');
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret) {
    console.error(`[${jobName}] CRON_SECRET is not configured`);
    return NextResponse.json(
      { error: 'Server configuration error' },
      { status: 500 }
    );
  }

  if (providedSecret !== expectedSecret) {
    console.error(`[${jobName}] Invalid secret token provided`);
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
