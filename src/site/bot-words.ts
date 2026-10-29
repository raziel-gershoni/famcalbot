// The bot's own words on the site (copy deck §3.1): the live parts reuse the bot's message keys (bot.voice.*,
// bot.nativeReminders.*) rather than copies that would drift. Those strings carry Telegram's HTML and a leading emoji;
// the site shows the words alone and puts a lucide icon where it needs one. Client-safe: no import.

/** A bot string as the site shows it: no HTML tags, no leading emoji (or the space after it). */
export function botWords(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*(?:\p{Extended_Pictographic}|️|‍)+\s*/u, '')
    .trim();
}
