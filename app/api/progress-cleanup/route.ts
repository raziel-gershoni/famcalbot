import { NextRequest } from 'next/server';
import { Redis } from '@upstash/redis';
import { withCronHandler } from '@/src/lib/cron-handler';
import { REDIS_KEYS } from '@/src/config/redis-keys';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function POST(request: NextRequest) {
  return withCronHandler(request, {
    jobName: 'Progress Cleanup',
    handler: async (_request, _searchParams, body) => {
      if (!body) {
        return { success: false, message: 'No body provided' };
      }

      const { chatId, messageId, language } = JSON.parse(body) as {
        chatId: number | string;
        messageId: number | string;
        language: string;
      };

      if (!chatId || !messageId) {
        return { success: false, message: 'Missing chatId or messageId' };
      }

      // Check if the operation already completed normally
      const key = REDIS_KEYS.progressDone(chatId, messageId);
      const done = await redis.get(key);

      if (done) {
        // Clean up the flag
        await redis.del(key);
        return { success: true, message: 'Already completed, no cleanup needed' };
      }

      // Operation did not complete — Vercel likely killed the function.
      // Replace the stuck progress message with a friendly error.
      console.warn(`[ProgressCleanup] Dead-man's switch fired for chat=${chatId} msg=${messageId}`);

      const { getMessagingService } = await import('@/src/services/telegram/bot');
      const { getBotMessages } = await import('@/src/lib/bot-messages');
      const msgService = getMessagingService();
      const t = await getBotMessages(language || 'en');

      const errorText = t.errors?.voiceGenerationFailed
        || 'Voice message unavailable — your text summary is above.';

      try {
        await msgService.updateMessage(chatId, messageId, errorText);
      } catch (updateErr) {
        console.error('[ProgressCleanup] Failed to update stuck progress message:', updateErr);
      }

      return { success: true, message: `Cleaned up stuck progress for chat=${chatId}` };
    },
  });
}
