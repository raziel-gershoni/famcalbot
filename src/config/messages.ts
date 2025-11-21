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

export const USER_MESSAGES = {
  NO_EVENTS_TODAY: "אין לך אירועים מתוכננים להיום. תהנה מיום פנוי!",
  NO_EVENTS_TOMORROW: "אין לך אירועים מתוכננים למחר. תהנה מיום פנוי!",
  FETCHING_CALENDAR: 'Fetching your calendar...',
  FETCHING_TOMORROW: "Fetching tomorrow's calendar...",
  ERROR_GENERIC: 'Sorry, there was an error fetching your calendar. Please try again later.',
  ERROR_TOMORROW: "Sorry, there was an error fetching tomorrow's calendar. Please try again later.",
  UNAUTHORIZED: 'Sorry, you are not authorized to use this bot.',
  WELCOME: (name: string) => `Hello ${name}! 👋

I'm your family calendar bot. I'll send you personalized daily summaries automatically:
• Morning at 7 AM (today's schedule)
• Evening (tomorrow's schedule)

You can also request summaries anytime with /summary or /tomorrow.

Need help? Use /help to see all commands.`,
  HELP: `📋 Available Commands:

/summary - Get today's calendar summary
/tomorrow - Get tomorrow's calendar summary
/help - Show this help message
/start - About this bot

You'll also receive automatic summaries:
• Morning at 7 AM (today)
• Evening (tomorrow)`,
} as const;
