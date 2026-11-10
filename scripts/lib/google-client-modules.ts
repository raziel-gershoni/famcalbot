// The Google client modules the app really loads, for the smokes that fake Google's transport.
//
// The app builds its OAuth2 client from `auth` of @googleapis/calendar, i.e. googleapis-common's own
// google-auth-library, whose gaxios is the one the Calendar calls run on. npm may hoist a different
// google-auth-library / gaxios (for example the one @google/genai needs) to the top of node_modules,
// so a smoke must resolve every module along the app's chain
// (calendar -> googleapis-common -> google-auth-library -> gaxios) and never from the top.
import { createRequire } from 'node:module';

export type GaxiosModule = {
  Gaxios: { prototype: { _defaultAdapter: (this: unknown, opts: Record<string, unknown> & { url?: unknown; method?: unknown; signal?: AbortSignal }) => Promise<unknown> } };
  GaxiosError: new (message: string, config: object, response?: object, error?: Error) => Error;
};

const fromHere = createRequire(__filename);
const calendarRequire = createRequire(fromHere.resolve('@googleapis/calendar'));
const commonRequire = createRequire(calendarRequire.resolve('googleapis-common'));
const authRequire = createRequire(commonRequire.resolve('google-auth-library'));

/** The gaxios googleapis-common (the Calendar calls) runs on. */
export const gaxiosModule = commonRequire('gaxios') as GaxiosModule;
/** The auth library googleapis-common loads, the one behind `auth.OAuth2`. */
export const googleAuthLibrary = commonRequire('google-auth-library') as {
  DefaultTransporter: new () => { processError(e: Error): Error };
};
/** The node-fetch the app's gaxios uses (its FetchError is what a network failure looks like). */
export const nodeFetch = createRequire(commonRequire.resolve('gaxios'))('node-fetch') as {
  FetchError: new (message: string, type: string, systemError?: { code: string }) => Error;
};

/** Exits when the auth library, its token helpers and googleapis-common do not share one gaxios whose adapter the fake replaces. */
export function assertOneGaxios(): void {
  const authGaxios = authRequire('gaxios');
  const tokenGaxios = createRequire(authRequire.resolve('gtoken'))('gaxios');
  const metadataGaxios = createRequire(authRequire.resolve('gcp-metadata'))('gaxios');
  if (authGaxios !== gaxiosModule || tokenGaxios !== gaxiosModule || metadataGaxios !== gaxiosModule) {
    console.error('FAIL  the Google client loads more than one gaxios; refusing to run without the fake');
    process.exit(1);
  }
}
