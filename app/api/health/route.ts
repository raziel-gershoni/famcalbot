import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { handleHealth } = await import('@/src/cron/handlers');
  const result = await handleHealth();

  return NextResponse.json(
    {
      status: result.status,
      checks: result.checks,
      timestamp: new Date().toISOString(),
    },
    { status: result.success ? 200 : 503 }
  );
}
