/**
 * A JSON answer read to its end inside the caller's retry attempt, checked, and handed back as a fresh Response with the
 * same status, status text and headers. A body that breaks on the way throws here (the stream ends early), and so does
 * JSON that is cut off or broken: a compressed body that ends early can reach fetch with no network error (MET's
 * forecast on 2026-11-04, "Expected ':' after property name in JSON at position 36641"). The caller's retry treats the
 * throw like no answer: fetch-retry.ts's fetchAndReadWithRetry and google-retry.ts's googleFetch with `wholeJson`, for
 * a GET only (a POST that went through is never sent again for its body).
 *
 * The error gives the size and the encoding, never the body: it can hold a place's coordinates, a token or an address.
 * Server only.
 */

/** Statuses whose Response has no body. */
const NO_BODY = new Set([204, 205, 304]);

export async function wholeJson(response: Response): Promise<Response> {
  const bytes = await response.arrayBuffer();
  if (!NO_BODY.has(response.status)) {
    try {
      // TextDecoder drops a byte-order mark, as response.json() does
      JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      const sent = response.headers.get('content-length');
      throw new Error(`the ${response.status} answer's JSON is cut off or broken: ${bytes.byteLength} bytes (${response.headers.get('content-encoding') ?? 'not compressed'}${sent === null ? '' : `, ${sent} bytes sent`})`);
    }
  }
  // The bytes are already decoded: the copy keeps no encoding or length of the body on the wire
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(NO_BODY.has(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers });
}
