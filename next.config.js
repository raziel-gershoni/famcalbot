// eslint-disable-next-line @typescript-eslint/no-require-imports -- next.config.js is a CommonJS config file
const { withSentryConfig } = require('@sentry/nextjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- next.config.js is a CommonJS config file
const withNextIntl = require('next-intl/plugin')();

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',

  // Exclude opusscript from bundling — it loads a .wasm binary from disk at runtime
  serverExternalPackages: ['opusscript', '@resvg/resvg-js'],

  // Enable experimental features for App Router
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },

  // Disable type checking during build (we'll do it separately)
  typescript: {
    ignoreBuildErrors: false,
  },

  // Environment variables available to the client
  env: {
    NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME,
  },

  poweredByHeader: false,

  // The old How it works page is now the landing's section (public website spec 2026-10-28 §3.3): a permanent redirect
  // in the visitor's language, in one hop (English unprefixed). Before the proxy, so no locale redirect comes first.
  // The locales are i18n/routing.ts's; scripts/smoke-site-pages.ts keeps this list equal to them.
  async redirects() {
    return [
      { source: '/how-it-works', destination: '/#how', permanent: true },
      { source: '/en/how-it-works', destination: '/#how', permanent: true },
      { source: '/:locale(he|ru)/how-it-works', destination: '/:locale#how', permanent: true },
    ];
  },
};

const sentryWebpackPluginOptions = {
  // Suppresses source map uploading logs during build
  silent: true,
  // Upload source maps to Sentry (only in production)
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
};

const sentryOptions = {
  // Hides source maps from generated client bundles
  hideSourceMaps: true,
  // Disable Sentry build-time features in development
  disableLogger: true,
  // Automatically tree-shake Sentry SDK in production
  widenClientFileUpload: true,
};

module.exports = withSentryConfig(
  withNextIntl(nextConfig),
  sentryWebpackPluginOptions,
  sentryOptions
);
