/**
 * Telegram Web App Authentication
 * Validates initData from Telegram Web Apps to verify user identity
 *
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

import crypto from 'crypto';

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramInitData {
  user?: TelegramUser;
  auth_date: number;
  hash: string;
  query_id?: string;
  [key: string]: any;
}

/**
 * Parse initData string into object
 */
function parseInitData(initData: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pairs = initData.split('&');

  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    params[decodeURIComponent(key)] = decodeURIComponent(value);
  }

  return params;
}

/**
 * Validate Telegram Web App initData
 * Returns the user if valid, null if invalid
 */
export function validateInitData(initData: string): TelegramUser | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    console.error('[TelegramAuth] BOT_TOKEN not configured');
    return null;
  }

  try {
    const params = parseInitData(initData);
    const hash = params.hash;

    if (!hash) {
      console.warn('[TelegramAuth] No hash in initData');
      return null;
    }

    // Check auth_date is not too old (5 minutes max)
    const authDate = parseInt(params.auth_date, 10);
    const now = Math.floor(Date.now() / 1000);
    const maxAge = 5 * 60; // 5 minutes

    if (now - authDate > maxAge) {
      console.warn('[TelegramAuth] initData expired');
      return null;
    }

    // Build data-check-string (sorted alphabetically, excluding hash)
    const checkString = Object.keys(params)
      .filter(key => key !== 'hash')
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('\n');

    // Calculate secret key: HMAC-SHA256(bot_token, "WebAppData")
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    // Calculate hash: HMAC-SHA256(data_check_string, secret_key)
    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(checkString)
      .digest('hex');

    if (calculatedHash !== hash) {
      console.warn('[TelegramAuth] Hash mismatch');
      return null;
    }

    // Parse user data
    if (params.user) {
      const user = JSON.parse(params.user) as TelegramUser;
      return user;
    }

    return null;
  } catch (error) {
    console.error('[TelegramAuth] Validation error:', error);
    return null;
  }
}

/**
 * Verify that the authenticated user matches the requested user_id
 */
export function verifyUserAccess(initData: string | null, requestedUserId: number): boolean {
  if (!initData) {
    return false;
  }

  const user = validateInitData(initData);
  if (!user) {
    return false;
  }

  return user.id === requestedUserId;
}

/**
 * Extract user ID from initData (for logging purposes, doesn't validate)
 */
export function extractUserId(initData: string): number | null {
  try {
    const params = parseInitData(initData);
    if (params.user) {
      const user = JSON.parse(params.user) as TelegramUser;
      return user.id;
    }
    return null;
  } catch {
    return null;
  }
}
