/**
 * Application-wide constants
 */

export const TIMEZONE = 'Asia/Jerusalem';
export const ADMIN_USER_ID = 762715667; // Raziel's Telegram ID for system alerts

export const CLAUDE_CONFIG = {
  MODEL: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929',
  MAX_TOKENS: 1500,
} as const;
