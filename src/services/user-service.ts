import { User as PrismaUser } from '@prisma/client';
import { UserConfig, convertPrismaUserToConfig } from '../types';
import { prisma, withRetry } from '../utils/prisma';
import { encrypt, safeDecrypt } from '../utils/encryption';

/**
 * Get user by Telegram ID
 * Drop-in replacement for getUserByTelegramId() in config/users.ts
 */
export async function getUserByTelegramId(telegramId: number | bigint): Promise<UserConfig | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) }
  });

  return user ? convertPrismaUserToConfig(user) : null;
}

/**
 * Get user by DB primary key (platform-agnostic)
 * Used by magic link auth for WhatsApp users
 */
export async function getUserById(id: number): Promise<UserConfig | null> {
  const user = await prisma.user.findUnique({
    where: { id }
  });

  return user ? convertPrismaUserToConfig(user) : null;
}

/**
 * Get user by WhatsApp phone
 */
export async function getUserByWhatsAppPhone(phone: string): Promise<UserConfig | null> {
  const user = await prisma.user.findUnique({
    where: { whatsappPhone: phone }
  });

  return user ? convertPrismaUserToConfig(user) : null;
}

/**
 * Get user by WhatsApp Business-Scoped User ID (BSUID)
 */
export async function getUserByWhatsAppBsuid(bsuid: string): Promise<UserConfig | null> {
  const user = await prisma.user.findUnique({
    where: { whatsappBsuid: bsuid }
  });

  return user ? convertPrismaUserToConfig(user) : null;
}

/**
 * Get user by any WhatsApp identifier (BSUID first, then phone)
 */
export async function getUserByWhatsAppId(identifier: string): Promise<UserConfig | null> {
  // Try BSUID first (starts with non-digit, e.g., "BR.xxx")
  const isBsuid = !identifier.match(/^\+?\d+$/);
  if (isBsuid) {
    return await getUserByWhatsAppBsuid(identifier);
  }
  return await getUserByWhatsAppPhone(identifier);
}

/**
 * Update a user's WhatsApp BSUID (backfill for existing phone-based users)
 */
export async function updateWhatsAppBsuid(userId: number, bsuid: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { whatsappBsuid: bsuid }
  });
  console.log(`[User] Backfilled BSUID for user ${userId}: ${bsuid.substring(0, 10)}...`);
}

/**
 * Get the correct WhatsApp chat ID for sending messages
 * Prefers BSUID (future-proof), falls back to phone
 */
export function getWhatsAppChatId(user: UserConfig): string | null {
  return user.whatsappBsuid || user.whatsappPhone || null;
}

/**
 * Get user by identifier (Telegram ID or WhatsApp phone/BSUID)
 */
export async function getUserByIdentifier(id: number | bigint | string): Promise<UserConfig | null> {
  if (typeof id === 'number' || typeof id === 'bigint') {
    return await getUserByTelegramId(id);
  } else {
    return await getUserByWhatsAppId(id);
  }
}

/**
 * Get all users
 * Replacement for allUsers array and users export in config/users.ts
 */
export async function getAllUsers(): Promise<UserConfig[]> {
  const users = await withRetry(() => prisma.user.findMany());
  return users.map(convertPrismaUserToConfig);
}

/**
 * Get whitelisted Telegram IDs (for security/authorization)
 * Replacement for getWhitelistedIds() in config/users.ts
 */
export async function getWhitelistedIds(): Promise<number[]> {
  const users = await prisma.user.findMany({
    select: { telegramId: true }
  });

  return users
    .filter(u => u.telegramId !== null)
    .map(u => Number(u.telegramId));
}

/**
 * Update user settings
 */
export async function updateUser(telegramId: number | bigint, data: Partial<PrismaUser>): Promise<UserConfig> {
  // Encrypt Google refresh token if provided
  const encryptedData = { ...data };
  if (data.googleRefreshToken) {
    encryptedData.googleRefreshToken = encrypt(data.googleRefreshToken);
  }

  // Remove immutable fields that shouldn't be in update
  const { id, createdAt, updatedAt, ...updateData } = encryptedData;

  const updatedUser = await prisma.user.update({
    where: { telegramId: BigInt(telegramId) },
    data: updateData as any // Type assertion needed for JSON fields
  });

  return convertPrismaUserToConfig(updatedUser);
}

/**
 * Update Google refresh token for a user
 */
export async function updateGoogleRefreshToken(
  telegramId: number | bigint,
  refreshToken: string
): Promise<UserConfig> {
  const updatedUser = await prisma.user.update({
    where: { telegramId: BigInt(telegramId) },
    data: {
      googleRefreshToken: encrypt(refreshToken),
      updatedAt: new Date()
    }
  });

  return convertPrismaUserToConfig(updatedUser);
}

/**
 * Clear Google refresh token for a user (used when token has insufficient scopes)
 * Sets to empty string since the field is required in the schema
 */
export async function clearGoogleRefreshToken(
  telegramId: number | bigint
): Promise<void> {
  await prisma.user.update({
    where: { telegramId: BigInt(telegramId) },
    data: {
      googleRefreshToken: '',
      updatedAt: new Date()
    }
  });
}

/**
 * Map Telegram language code to our supported locales
 */
function mapTelegramLanguage(code?: string): string {
  if (!code) return 'en';
  if (code.startsWith('he')) return 'he';
  if (code.startsWith('ru')) return 'ru';
  return 'en';
}

/**
 * Telegram user info for registration
 */
export interface TelegramUserInfo {
  first_name?: string;
  last_name?: string;
  language_code?: string;
}

/**
 * Get or create user by Telegram ID
 * Auto-registers new users with minimal defaults from Telegram profile
 */
export async function getOrCreateUser(
  telegramId: number,
  telegramUser?: TelegramUserInfo
): Promise<UserConfig> {
  // Try to find existing user
  const existingUser = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) }
  });

  if (existingUser) {
    return convertPrismaUserToConfig(existingUser);
  }

  // Map Telegram language code to our locale
  const language = mapTelegramLanguage(telegramUser?.language_code);

  // Build name from Telegram data
  const name = [telegramUser?.first_name, telegramUser?.last_name]
    .filter(Boolean).join(' ') || 'User';

  // Create new user with defaults
  const newUser = await prisma.user.create({
    data: {
      telegramId: BigInt(telegramId),
      name,
      englishName: '',
      gender: 'male',  // Default, user can change in settings
      language,
      location: '',
      culture: 'default',
      messagingPlatform: 'telegram',
      googleRefreshToken: '',  // Empty until OAuth
    }
  });

  console.log(`[User] Created new user: ${name} (Telegram ID: ${telegramId})`);
  return convertPrismaUserToConfig(newUser);
}

/**
 * Update user settings by DB primary key (platform-agnostic)
 * Used for WhatsApp-only users who don't have a telegramId
 */
export async function updateUserById(id: number, data: Partial<PrismaUser>): Promise<UserConfig> {
  const encryptedData = { ...data };
  if (data.googleRefreshToken) {
    encryptedData.googleRefreshToken = encrypt(data.googleRefreshToken);
  }

  const { id: _id, createdAt, updatedAt, ...updateData } = encryptedData;

  const updatedUser = await prisma.user.update({
    where: { id },
    data: updateData as any
  });

  return convertPrismaUserToConfig(updatedUser);
}

/**
 * Get or create user by WhatsApp identifier (phone or BSUID)
 * Auto-registers new WhatsApp users with minimal defaults
 */
export async function getOrCreateUserByWhatsApp(
  identifier: string,
  profileName?: string,
  bsuid?: string,
  phone?: string
): Promise<UserConfig> {
  // Try lookup by BSUID first, then phone
  if (bsuid) {
    const byBsuid = await prisma.user.findUnique({ where: { whatsappBsuid: bsuid } });
    if (byBsuid) return convertPrismaUserToConfig(byBsuid);
  }
  if (phone) {
    const byPhone = await prisma.user.findUnique({ where: { whatsappPhone: phone } });
    if (byPhone) return convertPrismaUserToConfig(byPhone);
  }
  // Also try the raw identifier
  const isBsuid = !identifier.match(/^\+?\d+$/);
  if (!isBsuid) {
    const byPhone = await prisma.user.findUnique({ where: { whatsappPhone: identifier } });
    if (byPhone) return convertPrismaUserToConfig(byPhone);
  } else if (!bsuid) {
    const byBsuid = await prisma.user.findUnique({ where: { whatsappBsuid: identifier } });
    if (byBsuid) return convertPrismaUserToConfig(byBsuid);
  }

  const name = profileName || 'User';

  const newUser = await prisma.user.create({
    data: {
      whatsappPhone: phone || (isBsuid ? undefined : identifier),
      whatsappBsuid: bsuid || (isBsuid ? identifier : undefined),
      name,
      englishName: '',
      gender: 'male',
      language: 'en',
      location: '',
      culture: 'default',
      messagingPlatform: 'whatsapp',
      googleRefreshToken: '',
    }
  });

  console.log(`[User] Created new WhatsApp user: ${name} (ID: ${identifier})`);
  return convertPrismaUserToConfig(newUser);
}

// updateUserCalendars function removed - use /api/select-calendars endpoint instead
