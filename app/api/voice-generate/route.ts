import { NextRequest } from 'next/server';
import { withCronHandler } from '@/src/lib/cron-handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Voice Generate',
    handler: async (_request, _searchParams, body) => {
      if (!body) {
        return { success: false, message: 'No body provided' };
      }

      const { telegramId, text, voiceType, isNextWeek } = JSON.parse(body) as {
        telegramId: number;
        text: string;
        voiceType: 'daily' | 'weekly' | 'weather';
        isNextWeek?: boolean;
      };

      if (!telegramId || !text || !voiceType) {
        return { success: false, message: 'Missing required fields' };
      }

      const { getUserByTelegramId } = await import('@/src/services/user-service');
      const user = await getUserByTelegramId(telegramId);

      if (!user) {
        return { success: false, message: `User ${telegramId} not found` };
      }

      if (user.voiceSummaryEnabled === false) {
        return { success: true, message: `Voice disabled for user ${telegramId}, skipping` };
      }

      const { sendVoiceMessage, sendWeeklyVoiceMessage } = await import('@/src/services/telegram/voice');

      if (voiceType === 'weekly') {
        await sendWeeklyVoiceMessage(telegramId, text, user, isNextWeek ?? false);
      } else {
        await sendVoiceMessage(telegramId, text, user);
      }

      return { success: true, message: `Voice ${voiceType} sent to user ${telegramId}` };
    },
  });
}
