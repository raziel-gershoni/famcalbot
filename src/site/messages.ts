// What the public site hands its client components (spec 2026-10-28-public-website §6.1): only the namespaces they read,
// never the whole catalogue the Mini App needs. The pages read everything else on the server.
// Client-safe: no import.

/** The message namespaces the site's client components read with useTranslations. */
export const SITE_CLIENT_NAMESPACES = ['site'] as const;

type Messages = Record<string, unknown>;

/** The named namespaces of a message catalogue, and nothing else. A namespace the catalogue lacks is left out. */
export function pickMessages(messages: Messages, namespaces: readonly string[]): Messages {
  return Object.fromEntries(namespaces.filter((ns) => ns in messages).map((ns) => [ns, messages[ns]]));
}
