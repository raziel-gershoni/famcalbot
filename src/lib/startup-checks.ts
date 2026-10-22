/**
 * Secrets the app refuses to work without, checked once at startup (instrumentation.ts)
 * so a missing or reused one is named in the deploy log, in Sentry and in the deploy
 * message, instead of failing quietly request by request. Pure: env in, problems out.
 * A message names the variable, never its value.
 */

export interface StartupProblem {
  /** The variable at fault */
  name: string;
  /** One log line, without the [startup] prefix */
  message: string;
}

export function startupSecretProblems(env: Record<string, string | undefined>): StartupProblem[] {
  const problems: StartupProblem[] = [];
  if (!env.SESSION_SECRET) {
    problems.push({ name: 'SESSION_SECRET', message: 'SESSION_SECRET is not set: WhatsApp sign-in and share-story image links are refused' });
  }
  if (!env.WHATSAPP_APP_SECRET) {
    problems.push({ name: 'WHATSAPP_APP_SECRET', message: 'WHATSAPP_APP_SECRET is not set: every WhatsApp webhook is refused (500)' });
  }
  // app/api/webhook/route.ts answers every Telegram update with a 500 while it is unset
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    problems.push({ name: 'TELEGRAM_WEBHOOK_SECRET', message: 'TELEGRAM_WEBHOOK_SECRET is not set: every Telegram update is refused (500)' });
  }
  if (env.SESSION_SECRET && env.SESSION_SECRET === env.CRON_SECRET) {
    problems.push({ name: 'SESSION_SECRET', message: 'SESSION_SECRET equals CRON_SECRET: give it its own value' });
  }
  return problems;
}
