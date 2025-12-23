const withNextIntl = require('next-intl/plugin')();

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable experimental features for App Router
  experimental: {
    serverActions: true,
  },

  // Disable type checking during build (we'll do it separately)
  typescript: {
    ignoreBuildErrors: false,
  },

  // Disable ESLint during build (run separately)
  eslint: {
    ignoreDuringBuilds: false,
  },

  // Environment variables available to the client
  env: {
    NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME,
  },

  // Vercel-specific settings
  poweredByHeader: false,

  // Redirect old API routes if needed
  async rewrites() {
    return [
      // Keep existing API routes working
      {
        source: '/api/:path*',
        destination: '/api/:path*',
      },
    ];
  },
};

module.exports = withNextIntl(nextConfig);
