/**
 * Cron Handler Wrapper
 * Provides error handling for cron job API routes
 * Routes can be triggered manually via HTTP for debugging
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
  handler: (request: NextRequest, searchParams: URLSearchParams, body?: string) => Promise<CronResult>;
}

/**
 * Wraps a cron job handler with error handling and auth
 * Cron jobs are triggered by the in-process scheduler or manually via HTTP.
 * Requires CRON_SECRET via Authorization header or query parameter.
 */
export async function withCronHandler(
  request: NextRequest,
  options: CronHandlerOptions
): Promise<NextResponse> {
  const { jobName, handler } = options;
  const { searchParams } = new URL(request.url);

  // Validate CRON_SECRET
  const secret = request.headers.get('authorization')?.replace('Bearer ', '') ||
    searchParams.get('secret');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: string | undefined;
  try {
    body = await request.text();
  } catch {
    // No body is fine for GET requests
  }

  try {
    const result = await handler(request, searchParams, body);

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
