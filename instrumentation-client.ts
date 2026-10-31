// The browser's Sentry init. Next 16 builds on Turbopack, which loads this file (and ignores
// the old sentry.client.config.ts). The DSN is the NEXT_PUBLIC_SENTRY_DSN env var, inlined at build.
import * as Sentry from '@sentry/nextjs';
import { browserIntegrations } from './src/lib/sentry-errors-only';
import { scrubBreadcrumb, scrubBrowserEvent } from './src/lib/sentry-scrub';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Only enable in production
  enabled: process.env.NODE_ENV === 'production',

  // Error reports only (src/lib/sentry-errors-only.ts; the Privacy Policy says error reports): no tracesSampleRate or
  // tracesSampler, no tracer or session among the integrations, no count-only client reports, no replay
  sendClientReports: false,
  integrations: browserIntegrations,

  // Filter out noisy errors
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'Non-Error promise rejection captured',
  ],

  // No launch fragment (#tgWebAppData=<initData>) in URLs
  beforeSend: (event) => scrubBrowserEvent(event),
  // A transaction is scrubbed too, should tracing ever be turned back on
  beforeSendTransaction: (event) => scrubBrowserEvent(event),
  beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
});
