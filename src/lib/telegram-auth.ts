/**
 * Telegram Web App Authentication
 * Validates initData from Telegram Web Apps to verify user identity
 *
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

import crypto from 'crypto';

/**
 * How long a Mini App launch's initData stays valid. Telegram signs it once, when the
 * Mini App opens, so this is how long a user can keep the page open and still save.
 * 24h matches the session cookie's TTL. Applies to every initData check, admin APIs too.
 */
export const INIT_DATA_MAX_AGE_SEC = 24 * 3600;

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
  [key: string]: unknown;
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

    // Check auth_date is not too old (INIT_DATA_MAX_AGE_SEC)
    const authDate = parseInt(params.auth_date, 10);
    const now = Math.floor(Date.now() / 1000);

    if (now - authDate > INIT_DATA_MAX_AGE_SEC) {
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

    // Use timing-safe comparison to prevent timing attacks
    const hashBuffer = Buffer.from(hash, 'hex');
    const calculatedBuffer = Buffer.from(calculatedHash, 'hex');
    if (hashBuffer.length !== calculatedBuffer.length || !crypto.timingSafeEqual(hashBuffer, calculatedBuffer)) {
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
