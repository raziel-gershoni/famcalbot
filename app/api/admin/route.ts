import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET handler - redirect to new admin page
export async function GET(request: NextRequest) {
  return NextResponse.redirect(new URL('/admin', request.url));
}

// POST handler - handle login
export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const password = formData.get('password');

  const response = NextResponse.redirect(new URL('/admin', request.url));

  if (password === process.env.CRON_SECRET) {
    // Set secure cookie
    response.cookies.set('admin_auth', password as string, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 3600 // 1 hour
    });
  }

  return response;
}
