import { NextRequest, NextResponse } from 'next/server';
import { updateUser } from '@/src/services/user-service';

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('user_id');

    if (!userId) {
      return NextResponse.json(
        { error: 'Missing user_id parameter' },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { language, location, messagingPlatform } = body;

    await updateUser(parseInt(userId), {
      language: language || undefined,
      location: location || undefined,
      messagingPlatform: messagingPlatform || undefined
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error updating settings:', error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}
