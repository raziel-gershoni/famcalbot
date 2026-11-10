// Sentry gets error reports and nothing else, from the Mini App, the public site, the API and the jobs alike (Privacy
// Policy: "Sentry: error reports"). A performance trace carries the page's or the request's address, and a session the
// browser's user agent, so:
//
// - No trace: no init sets tracesSampleRate or tracesSampler, so the SDK records no span, and the browser drops its
//   page-load and navigation tracer (BrowserTracing) from the defaults.
// - No session: the browser's defaults include BrowserSession, which sends a session (with the user agent) on each page
//   load and navigation once a release is set (it is, on Railway), so the browser drops it. On the server, ProcessSession
//   sends the process's session with its first error (with the user agent and the id of the person on the scope), so the
//   server drops it, and the Http integration counts each request into a session aggregate, so the server's turns that off.
// - No client report (the SDK's counts of what it dropped): every init sets sendClientReports false.
// - No replay: no init adds Sentry's replay integration.
// Pure: no import, so the browser and the server configs can both take it.

/** The browser's default integrations that send something other than an error: the session tracker and the tracer. */
export const BROWSER_NON_ERROR_INTEGRATIONS = ['BrowserSession', 'BrowserTracing'];

/** The browser's integrations: the SDK's defaults, without the ones that send anything but errors. */
export function browserIntegrations<T extends { name: string }>(defaults: T[]): T[] {
  return defaults.filter((integration) => !BROWSER_NON_ERROR_INTEGRATIONS.includes(integration.name));
}

/** The server's default integrations that send something other than an error: the process session. */
export const SERVER_NON_ERROR_INTEGRATIONS = ['ProcessSession'];

/**
 * The server's integrations: the SDK's defaults (as @sentry/nextjs builds them) without the process session, and `http`
 * (the server init's Http integration, request sessions off) in place of the default one.
 */
export function serverIntegrations<H extends { name: string }>(http: H): <T extends { name: string }>(defaults: T[]) => (T | H)[] {
  return (defaults) => [...defaults.filter((integration) => integration.name !== http.name && !SERVER_NON_ERROR_INTEGRATIONS.includes(integration.name)), http];
}
