import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/admin', request.url));

  // Clear admin_auth cookie
  response.cookies.set('admin_auth', '', {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 0
  });

  return response;
}
