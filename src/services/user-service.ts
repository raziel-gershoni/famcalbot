import { Prisma, User as PrismaUser } from '@prisma/client';
import { UserConfig, convertPrismaUserToConfig } from '../types';
import { prisma, withRetry } from '../utils/prisma';
import { encrypt } from '../utils/encryption';
import { isIdentifierBlocked, type BlockArgs } from '../lib/user-moderation';
import { normalizeLocale, type Locale } from '../utils/locale';
import { normalizeEmail } from './web-signin/email-address';
import { captureSignInFailure } from './web-signin/safe-error';
import { trackActivityAsync } from './analytics-service';
import type { IdentityKind } from './web-signin/identities';

/** A new account was refused: one of its identifiers is on the admin blocklist. The message names none of them. */
export class AccountBlockedError extends Error {
  constructor() {
    super('An identifier of the new account is on the admin blocklist');
    this.name = 'AccountBlockedError';
  }
}

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
 * Get the correct WhatsApp chat ID for sending messages.
 *
 * Prefers phone, falls back to BSUID. Meta's outbound `to:` field is currently
 * unreliable for BSUIDs (we observed code 131026 "Message undeliverable" for
 * sends to BSUIDs like "IL.2683713448667645" while phone-based sends work).
 * Once the June 2026 username transition is complete and Meta fully supports
 * BSUID outbound, this preference can flip back.
 *
 * BSUID remains the fallback so username-only WA users (who don't expose a
 * phone) can still receive messages.
 */
export function getWhatsAppChatId(user: { whatsappPhone?: string | null; whatsappBsuid?: string | null }): string | null {
  return user.whatsappPhone || user.whatsappBsuid || null;
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
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...updateData } = encryptedData;

  const updatedUser = await prisma.user.update({
    where: { telegramId: BigInt(telegramId) },
    data: updateData as Prisma.UserUpdateInput // Type assertion needed for JSON fields
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

/** What a new account is made from: the bot's /start, a first WhatsApp message, or a sign-up on famcal.bot. */
export type NewAccount =
  | { via: 'telegram'; telegramId: number; profile?: TelegramUserInfo }
  | { via: 'whatsapp'; identifier: string; profileName?: string; bsuid?: string; phone?: string; initialLanguage?: Locale }
  | { via: 'web'; way: { kind: IdentityKind; subject: string; address: string }; name: string; language: Locale };

type WhatsAppAccount = Extract<NewAccount, { via: 'whatsapp' }>;

/** A WhatsApp sender's phone and BSUID: the ones given, else the identifier as whichever it looks like. */
function whatsAppIds(input: WhatsAppAccount): { phone: string | undefined; bsuid: string | undefined } {
  const isBsuid = !/^\+?\d+$/.test(input.identifier);
  return {
    phone: input.phone || (isBsuid ? undefined : input.identifier),
    bsuid: input.bsuid || (isBsuid ? input.identifier : undefined),
  };
}

/** How the account was made, for the one log line. */
function createdVia(input: NewAccount): 'telegram' | 'whatsapp' | 'web-google' | 'web-email' {
  return input.via === 'web' ? `web-${input.way.kind}` : input.via;
}

/**
 * The identifiers the blocklist is asked about: the Telegram id; the WhatsApp phone when one is known (the blocklist
 * holds no BSUID); a Google way's account id and its verified address (spec §2.8: a Google sign-up is checked against
 * the email bans too); an email way's address.
 */
function blockArgsOf(input: NewAccount): BlockArgs {
  switch (input.via) {
    case 'telegram':
      return { telegramId: input.telegramId };
    case 'whatsapp':
      return { whatsappPhone: whatsAppIds(input).phone ?? null };
    case 'web':
      return input.way.kind === 'google'
        ? { googleSub: input.way.subject, email: normalizeEmail(input.way.address) }
        : { email: input.way.subject };
  }
}

/** The row a new account starts with: the shared defaults (the person changes them in Settings) and what its way gives. */
function accountData(input: NewAccount): Prisma.UserCreateInput {
  const shared = {
    englishName: '',
    gender: 'male', // Where everyone starts; the person picks "Address me as" in Settings (app/api/settings)
    location: '',
    culture: 'default',
    // Empty until Google is connected. calendarSource defaults to NATIVE in the schema: a new account starts in FamCal's own calendar.
    googleRefreshToken: '',
  };
  switch (input.via) {
    case 'telegram':
      return {
        ...shared,
        telegramId: BigInt(input.telegramId),
        name: [input.profile?.first_name, input.profile?.last_name].filter(Boolean).join(' ') || 'User',
        language: mapTelegramLanguage(input.profile?.language_code),
        messagingPlatform: 'telegram',
      };
    case 'whatsapp': {
      const ids = whatsAppIds(input);
      return {
        ...shared,
        whatsappPhone: ids.phone,
        whatsappBsuid: ids.bsuid,
        name: input.profileName || 'User',
        language: normalizeLocale(input.initialLanguage),
        messagingPlatform: 'whatsapp',
      };
    }
    case 'web':
      // No chat. "Has a chat" is read from the ids (telegramId, whatsappPhone, whatsappBsuid), never from
      // messagingPlatform, which keeps the schema's default.
      return { ...shared, name: input.name, language: input.language, messagingPlatform: 'telegram' };
  }
}

/**
 * The one creation step (web sign-up spec §2.7, §3.5). Every new account is made here: the bot's /start
 * (getOrCreateUser), a first WhatsApp message (getOrCreateUserByWhatsApp) and a sign-up on famcal.bot (Task 5's
 * completeSignUp). In order:
 * 1. The blocklist, for that way's identifiers. A banned one throws AccountBlockedError. The webhook handlers gate the
 *    chat paths already; this is the defense in depth for every caller.
 * 2. One transaction: the user row with the shared defaults and, for the web, its sign-in way (writeIdentityInTx). A
 *    way someone took meanwhile throws P2002 out of here with nothing made; the caller answers 'taken'.
 * 3. Its first FamCal calendar (ensurePrimaryNativeCalendar), so the first event has somewhere to go. A failure is
 *    logged and reported by its kind only (an error message can hold the calendar's name, which is the person's), and
 *    the account stands: the calendar is made again on the next calendar use.
 * 4. One log line with the user id and how the account was made, never a name or an identifier; and web_signup for the web.
 */
export async function createAccount(input: NewAccount): Promise<UserConfig> {
  const via = createdVia(input);
  if (await isIdentifierBlocked(blockArgsOf(input))) {
    console.warn(`[account] a new account via ${via} was refused: an identifier is on the blocklist`);
    throw new AccountBlockedError();
  }

  // Loaded only for the web: the chat paths never need the sign-in module
  const writeWay = input.via === 'web' ? (await import('./web-signin/identities')).writeIdentityInTx : null;
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({ data: accountData(input) });
    if (input.via === 'web' && writeWay) await writeWay(tx, created.id, input.way.kind, input.way.subject, input.way.address);
    return created;
  });

  try {
    const { ensurePrimaryNativeCalendar } = await import('./native-calendar/onboarding');
    await ensurePrimaryNativeCalendar(user.id);
  } catch (err) {
    console.error(`[account] user ${user.id}: making the first FamCal calendar failed; it is made on the next calendar use`);
    captureSignInFailure(err, 'account-calendar', { user_id: user.id });
  }

  console.log(`[account] created user ${user.id} via ${via}`);
  if (input.via === 'web') trackActivityAsync(user.id, 'web_signup', { language: user.language, way: input.way.kind });
  return convertPrismaUserToConfig(user);
}

/**
 * Get or create user by Telegram ID
 * Auto-registers new users with minimal defaults from Telegram profile (createAccount)
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

  return createAccount({ via: 'telegram', telegramId, profile: telegramUser });
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

  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...updateData } = encryptedData;

  const updatedUser = await prisma.user.update({
    where: { id },
    data: updateData as Prisma.UserUpdateInput
  });

  return convertPrismaUserToConfig(updatedUser);
}

/**
 * Get or create user by WhatsApp identifier (phone or BSUID)
 * Auto-registers new WhatsApp users with minimal defaults (createAccount). `initialLanguage` is the language a new
 * user starts in (English when unset); a user who already exists keeps theirs.
 */
export async function getOrCreateUserByWhatsApp(
  identifier: string,
  profileName?: string,
  bsuid?: string,
  phone?: string,
  initialLanguage?: Locale
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

  return createAccount({ via: 'whatsapp', identifier, profileName, bsuid, phone, initialLanguage });
}

// updateUserCalendars function removed - use /api/select-calendars endpoint instead
