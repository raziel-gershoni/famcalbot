import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/utils/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  // Verify the secret token
  const { searchParams } = new URL(request.url);
  const providedSecret = searchParams.get('secret') || request.headers.get('x-cron-secret');
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret) {
    console.error('CRON_SECRET is not configured');
    return NextResponse.json(
      { error: 'Server configuration error' },
      { status: 500 }
    );
  }

  if (providedSecret !== expectedSecret) {
    console.error('Invalid secret token provided');
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    // Dynamically import to avoid build-time initialization
    const { sendDailySummaryToAll } = await import('@/src/services/telegram');

    // Execute the summary function
    await sendDailySummaryToAll();

    // Clean up expired OAuth state tokens
    try {
      const deleted = await prisma.oAuthState.deleteMany({
        where: {
          expiresAt: {
            lt: new Date()
          }
        }
      });
      console.log(`Cleaned up ${deleted.count} expired OAuth state tokens`);
    } catch (cleanupError) {
      console.error('Failed to clean up OAuth state tokens:', cleanupError);
      // Don't fail the cron job if cleanup fails
    }

    return NextResponse.json({
      success: true,
      message: 'Daily summaries sent successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in cron handler:', error);

    // Notify admin of cron job failures
    try {
      const { notifyAdminError } = await import('@/src/utils/error-notifier');
      await notifyAdminError('Cron Job', error, 'Job: Daily summaries sent successfully');
    } catch (notifyError) {
      console.error('Failed to notify admin:', notifyError);
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to send summaries',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
