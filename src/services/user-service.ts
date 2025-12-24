import { User as PrismaUser } from '@prisma/client';
import { UserConfig, convertPrismaUserToConfig } from '../types';
import { prisma } from '../utils/prisma';
import { encrypt, safeDecrypt } from '../utils/encryption';

/**
 * Get user by Telegram ID
 * Drop-in replacement for getUserByTelegramId() in config/users.ts
 */
export async function getUserByTelegramId(telegramId: number): Promise<UserConfig | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) }
  });

  return user ? convertPrismaUserToConfig(user) : null;
}

/**
 * Get user by WhatsApp phone
 * Drop-in replacement for getUserByWhatsAppPhone() in config/users.ts
 */
export async function getUserByWhatsAppPhone(phone: string): Promise<UserConfig | null> {
  const user = await prisma.user.findUnique({
    where: { whatsappPhone: phone }
  });

  return user ? convertPrismaUserToConfig(user) : null;
}

/**
 * Get user by identifier (Telegram ID or WhatsApp phone)
 * Drop-in replacement for getUserByIdentifier() in config/users.ts
 */
export async function getUserByIdentifier(id: number | string): Promise<UserConfig | null> {
  if (typeof id === 'number') {
    return await getUserByTelegramId(id);
  } else {
    return await getUserByWhatsAppPhone(id);
  }
}

/**
 * Get all users
 * Replacement for allUsers array and users export in config/users.ts
 */
export async function getAllUsers(): Promise<UserConfig[]> {
  const users = await prisma.user.findMany();
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
export async function updateUser(telegramId: number, data: Partial<PrismaUser>): Promise<UserConfig> {
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
  telegramId: number,
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

// updateUserCalendars function removed - use /api/select-calendars endpoint instead
