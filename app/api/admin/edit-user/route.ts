import { NextRequest, NextResponse } from 'next/server';
import { updateUser } from '@/src/services/user-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const userId = formData.get('id');

  if (!userId) {
    return NextResponse.redirect(new URL('/admin', request.url));
  }

  try {
    await updateUser(parseInt(userId as string), {
      name: formData.get('name') as string,
      hebrewName: formData.get('hebrewName') as string,
      location: formData.get('location') as string,
      whatsappPhone: (formData.get('whatsappPhone') as string) || null,
      messagingPlatform: formData.get('messagingPlatform') as string
    });
  } catch (error) {
    console.error('Error updating user:', error);
  }

  return NextResponse.redirect(new URL('/admin', request.url));
}
