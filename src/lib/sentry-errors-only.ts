// Sentry gets error reports and nothing else, from the Mini App, the public site, the API and the jobs alike (Privacy
// Policy: "Sentry: error reports"). A performance trace carries the page's or the request's address, and a session the
// browser's user agent, so:
//
// - No trace: no init sets tracesSampleRate or tracesSampler, so the SDK records no span, and the browser drops its
//   page-load and navigation tracer (BrowserTracing) from the defaults.
// - No session: the browser's defaults include BrowserSession, which sends a session (with the user agent) on each page
//   load and navigation once a release is set (it is, on Railway), so the browser drops it; the server's Http
//   integration counts each request into a session aggregate, so the server init turns that off.
// - No client report (the SDK's counts of what it dropped): every init sets sendClientReports false.
// - No replay: no init adds Sentry's replay integration.
// Pure: no import, so the browser config can take it.

/** The browser's default integrations that send something other than an error: the session tracker and the tracer. */
export const BROWSER_NON_ERROR_INTEGRATIONS = ['BrowserSession', 'BrowserTracing'];

/** The browser's integrations: the SDK's defaults, without the ones that send anything but errors. */
export function browserIntegrations<T extends { name: string }>(defaults: T[]): T[] {
  return defaults.filter((integration) => !BROWSER_NON_ERROR_INTEGRATIONS.includes(integration.name));
}
