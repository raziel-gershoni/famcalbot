import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');

    // No secret value reaches the logs (a Telegram error prints the bot token in its request path): every console line is scrubbed
    const { installConsoleScrub } = await import('./src/lib/console-scrub');
    installConsoleScrub();

    // Start in-process cron scheduler (replaces QStash)
    const { startScheduler } = await import('./src/cron/scheduler');
    startScheduler();

    const { captureError } = await import('./src/lib/error-capture');

    // Startup never throws: a crash-looping container would take the bot down for everyone
    let missing: string[] = [];
    try {
      // The server's zone and whether it observes summer/winter time (cron jobs without a zone follow it)
      const { processZoneLine } = await import('./src/lib/startup-checks');
      console.info(`[startup] ${processZoneLine()}`);

      // Which encryption keys this process holds, by fingerprint only (every environment)
      const { describeKeys } = await import('./src/utils/encryption');
      console.log(describeKeys());

      // Name a missing or reused secret (production only), never its value
      if (process.env.NODE_ENV === 'production') {
        const { startupSecretProblems } = await import('./src/lib/startup-checks');
        const problems = startupSecretProblems(process.env);
        for (const problem of problems) {
          console.error(`[startup] ${problem.message}`);
          captureError(new Error(problem.message), 'startup-secret', { variable: problem.name });
        }
        missing = problems.filter(p => p.missing).map(p => p.name);
      }
    } catch (err) {
      captureError(err, 'startup-checks');
    }

    // Notify admins of deploy (production only), naming any missing secret
    if (process.env.NODE_ENV === 'production' && process.env.RAILWAY_GIT_COMMIT_SHA) {
      const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
      const missingLine = missing.length ? `\nmissing: ${missing.join(', ')}` : '';
      import('./src/utils/error-notifier').then(({ getAdminUserIds }) =>
        import('./src/services/telegram/bot').then(({ getBot }) =>
          getAdminUserIds().then(adminIds => {
            const bot = getBot();
            for (const adminId of adminIds) {
              bot.sendMessage(adminId, `🚀 FamCal <code>${commitSha}</code> deployed${missingLine}`, { parse_mode: 'HTML' })
                .catch(err => captureError(err, 'deploy-notify-send', { admin_id: adminId }));
            }
          })
        )
      ).catch(err => captureError(err, 'deploy-notify'));
    }
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
