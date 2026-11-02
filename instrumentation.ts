import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');

    // No secret value reaches the logs (a Telegram error prints the bot token in its request path): every console line is scrubbed
    // (guarded: startup never throws, see below)
    try {
      const { installConsoleScrub } = await import('./src/lib/console-scrub');
      installConsoleScrub();
    } catch (err) {
      console.error('[startup] the console scrub could not be installed; secrets may reach the logs', err);
      Sentry.captureException(err);
    }

    // Start in-process cron scheduler (replaces QStash)
    const { startScheduler } = await import('./src/cron/scheduler');
    startScheduler();

    const { captureError } = await import('./src/lib/error-capture');

    // The Google account a calendar is connected from signs in on the web (web sign-in spec §2.17): give connections made
    // before it, or keyed under another SESSION_SECRET, their account key. Only once Google sign-in is set up (until then
    // the way is hidden and the pass would ask Google about every connected calendar for nothing; the deploy that sets
    // the GOOGLE_SIGNIN_CLIENT_* variables runs it). One select per boot, one Google call per connection still without a
    // key; never awaited, never throws (a failure is logged and left for the next boot).
    Promise.all([import('./src/services/web-signin/oidc'), import('./src/services/web-signin/calendar-account')])
      .then(([{ providerConfigured }, { fillGoogleAccountKeys }]) =>
        providerConfigured('google')
          ? fillGoogleAccountKeys()
          : console.log('[google-account] Google sign-in is off: the calendar accounts are not keyed yet'))
      .catch(err => captureError(err, 'google-account-fill'));

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
        const { startupSecretProblems, signInSetupWarnings } = await import('./src/lib/startup-checks');
        const problems = startupSecretProblems(process.env);
        for (const problem of problems) {
          console.error(`[startup] ${problem.message}`);
          captureError(new Error(problem.message), 'startup-secret', { variable: problem.name });
        }
        missing = problems.filter(p => p.missing).map(p => p.name);
        // A web sign-in way without its variables stays hidden: a warning in the log, never an error, a capture or "missing"
        for (const warning of signInSetupWarnings(process.env)) console.warn(`[startup] ${warning}`);
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
