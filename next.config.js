const { withSentryConfig } = require('@sentry/nextjs');
const withNextIntl = require('next-intl/plugin')();

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Exclude opusscript from bundling — it loads a .wasm binary from disk at runtime
  // Without this, Vercel bundles the JS but not the WASM file, causing ENOENT at runtime
  serverExternalPackages: ['opusscript'],

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

  // Vercel-specific settings
  poweredByHeader: false,
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
