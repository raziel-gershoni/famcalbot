import { cookies } from 'next/headers';

/**
 * Validates admin authentication via cookie
 * Throws error if not authenticated
 */
export async function requireAdminAuth() {
  const cookieStore = await cookies();
  const token = cookieStore.get('admin_auth')?.value;

  if (token !== process.env.CRON_SECRET) {
    throw new Error('Unauthorized');
  }

  return token;
}

/**
 * Checks if user is authenticated (non-throwing)
 * Returns true if authenticated, false otherwise
 */
export async function isAdminAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get('admin_auth')?.value;

  return token === process.env.CRON_SECRET;
}
