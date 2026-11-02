// A fetch answer's JSON body for the browser's request helpers (the sign-in form on the site, Settings' sign-in ways):
// read once, as an object, or null. A body that is not one is logged with the caller's tag, the status and the error's
// name only: never the body, which may echo what was sent. Client-safe: no import.

/** The answer's body as a JSON object, or null (logged) when it has none. */
export async function readJsonBody(res: Response, tag: string): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
    console.warn(`${tag}: the answer (${res.status}) is not a JSON object`);
    return null;
  } catch (error) {
    console.warn(`${tag}: the answer (${res.status}) is not JSON (${error instanceof Error ? error.name : typeof error})`);
    return null;
  }
}
