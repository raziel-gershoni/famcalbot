/**
 * Reusable message templates for Telegram alerts and user responses
 */

export const ALERT_MESSAGES = {
  TOKEN_EXPIRED: `🚨 <b>URGENT: Google Calendar Token Expired!</b>

The Google refresh token is no longer valid.

<b>To fix:</b>
1. Run: <code>npm run get-google-token</code>
2. Update GOOGLE_REFRESH_TOKEN in .env and Vercel
3. Redeploy`,

  HEALTH_CHECK_FAILED: (error: string) => `🚨 <b>Health Check Failed!</b>

Google Calendar token test failed.

<b>Error:</b> ${error}

<b>Action needed:</b>
1. Run: <code>npm run get-google-token</code>
2. Update GOOGLE_REFRESH_TOKEN in .env and Vercel
3. Redeploy`,
} as const;

