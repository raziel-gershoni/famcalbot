// The browser's Sentry init. Next 16 builds on Turbopack, which loads this file (and ignores
// the old sentry.client.config.ts). The DSN is the NEXT_PUBLIC_SENTRY_DSN env var, inlined at build.
import * as Sentry from '@sentry/nextjs';
import { browserIntegrations, browserTracesSampler } from './src/lib/sentry-sampling';
import { scrubBreadcrumb, scrubBrowserEvent } from './src/lib/sentry-scrub';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Only enable in production
  enabled: process.env.NODE_ENV === 'production',

  // Performance monitoring: 1% of the Mini App's page loads, none of the public site's pages, which carry
  // data-surface="site" on <html> (src/lib/sentry-sampling.ts; the Privacy Policy says error reports only)
  tracesSampler: browserTracesSampler,

  // No count-only client reports either (what the SDK dropped), and no session (the SDK's page-load tracker, with the
  // user agent) on the public site's pages: nothing is sent from one but an error (src/lib/sentry-sampling.ts)
  sendClientReports: false,
  integrations: browserIntegrations,

  // Session replay for debugging user issues
  replaysSessionSampleRate: 0.01,
  replaysOnErrorSampleRate: 1.0,

  // Filter out noisy errors
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'Non-Error promise rejection captured',
  ],

  // No launch fragment (#tgWebAppData=<initData>) in URLs
  beforeSend: (event) => scrubBrowserEvent(event),
  beforeSendTransaction: (event) => scrubBrowserEvent(event),
  beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
});

// Sentry's hook for client-side navigations in the App Router (Sentry's Next.js manual setup).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
