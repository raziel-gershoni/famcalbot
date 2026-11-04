/**
 * Whether an account has a chat FamCal can write to (web sign-up spec §3.11): Telegram, or WhatsApp by its phone or its
 * BSUID. An account made on famcal.bot has none until it connects Telegram. One rule for the server and the pages.
 *
 * A row from the database has null for a missing id; a UserConfig (convertPrismaUserToConfig) has undefined for the
 * WhatsApp ones. Both count as missing. Client-safe: no import.
 */
export function hasChat(user: {
  telegramId: number | bigint | null | undefined;
  whatsappPhone?: string | null;
  whatsappBsuid?: string | null;
}): boolean {
  return user.telegramId != null || hasWhatsApp(user);
}

/** Whether an account has a WhatsApp id, its phone or its BSUID: the one place that rule is written. */
export function hasWhatsApp(user: { whatsappPhone?: string | null; whatsappBsuid?: string | null }): boolean {
  return Boolean(user.whatsappPhone) || Boolean(user.whatsappBsuid);
}
