import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * DEPRECATED: This endpoint is no longer used.
 * OAuth flow now redirects to /[locale]/select-calendars
 * which uses /api/select-calendars endpoint instead.
 */
export async function POST(request: NextRequest) {
  return NextResponse.json(
    {
      error: 'This endpoint is deprecated. Please use /api/select-calendars instead.',
      redirect: '/select-calendars'
    },
    { status: 410 } // 410 Gone - resource no longer available
  );
}
