import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');

    // Start in-process cron scheduler (replaces QStash)
    const { startScheduler } = await import('./src/cron/scheduler');
    startScheduler();

    // Notify admins of deploy (production only)
    if (process.env.NODE_ENV === 'production' && process.env.RAILWAY_GIT_COMMIT_SHA) {
      const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
      import('./src/utils/error-notifier').then(({ getAdminUserIds }) =>
        import('./src/services/telegram/bot').then(({ getBot }) =>
          getAdminUserIds().then(adminIds => {
            const bot = getBot();
            for (const adminId of adminIds) {
              bot.sendMessage(adminId, `🚀 FamCal <code>${commitSha}</code> deployed`, { parse_mode: 'HTML' }).catch(() => {});
            }
          })
        )
      ).catch(() => {});
    }
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
