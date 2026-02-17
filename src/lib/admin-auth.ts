/**
 * Shared admin authentication helper
 * Verifies Telegram initData and checks admin privileges
 */

import { verifyUserAccess, extractUserId } from './telegram-auth';
import { getUserByTelegramId } from '../services/user-service';

interface AdminAuthResult {
  authorized: boolean;
  adminId?: number;
  error?: string;
}

/**
 * Verify admin access from Telegram initData
 * Used by all admin API routes
 */
export async function verifyAdminAccess(initData: string | undefined): Promise<AdminAuthResult> {
  if (!initData) {
    return { authorized: false, error: 'Missing initData' };
  }

  const userId = extractUserId(initData);
  if (userId === null) {
    return { authorized: false, error: 'Invalid initData' };
  }

  // Verify Telegram authentication
  if (!verifyUserAccess(initData, userId)) {
    console.warn(`[admin-auth] Unauthorized access attempt for user ${userId}`);
    return { authorized: false, error: 'Unauthorized' };
  }

  // Check if user is admin
  const user = await getUserByTelegramId(userId);
  if (!user?.isAdmin) {
    console.warn(`[admin-auth] Non-admin user ${userId} attempted admin access`);
    return { authorized: false, error: 'Admin access required' };
  }

  return { authorized: true, adminId: user.id };
}
