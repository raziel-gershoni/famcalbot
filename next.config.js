const withNextIntl = require('next-intl/plugin')();

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transpile Heroicons to avoid build issues
  transpilePackages: ['@heroicons/react'],

  // Enable experimental features for App Router
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
    // Optimize barrel file imports (fixes build hanging with icon libraries)
    optimizePackageImports: ['@heroicons/react'],
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

module.exports = withNextIntl(nextConfig);
