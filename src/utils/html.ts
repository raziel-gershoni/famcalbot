/**
 * HTML escaping for Telegram's parse_mode 'HTML'. Every user-supplied string (titles,
 * names, places) goes through escapeHtml before it is put into a message.
 *
 * A leaf module with no imports, so the cron passes (event alerts, native reminder
 * pings) can escape text without loading the voice confirmation chain.
 */

/** Escapes &, < and > for parse_mode 'HTML'. A missing value (a create with no title) is ''. */
export function escapeHtml(text: string | null | undefined): string {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
