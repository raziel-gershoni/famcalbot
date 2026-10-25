// Smoke test for the calendar reader's pure Google rules (spec §2.5):
// src/services/calendar-read/google-map.ts (classifyGoogleError, keepGoogleEvent,
// mapGoogleEvent) and htmlToText in src/utils/html.ts.
//
// The errors are real: the installed Google client (@googleapis/calendar with its own
// google-auth-library and gaxios) runs for real, and only its HTTP adapter is replaced,
// so every error below is what that library throws for that answer from Google. The
// mapping is held to what calendar.ts's day read (the summaries' Google read before the
// shared reader) made of the same items. No network: a request to anything but the fake
// fails the smoke.
//
// Run under both clocks; the output must not depend on the server's timezone:
//   TZ=UTC npx tsx scripts/smoke-google-map.ts
//   TZ=Asia/Jerusalem npx tsx scripts/smoke-google-map.ts

import { createRequire } from 'module';
import type { calendar_v3 } from '@googleapis/calendar';

type Result = { name: string; ok: boolean; reason?: string };
const results: Result[] = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, reason: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function assertEq(got: unknown, want: unknown, what: string) {
  assert(JSON.stringify(got) === JSON.stringify(want), `${what}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
}

// ---- The fake Google: the library's own HTTP adapter, replaced ----------------------

type GaxiosOpts = Record<string, unknown> & { url?: unknown };
type Answer = { status: number; data: unknown };
type Route = (opts: GaxiosOpts, real: (opts: GaxiosOpts) => Promise<unknown>) => Answer | Promise<Answer>;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_OK: Answer = { status: 200, data: { access_token: 'fake-access', expires_in: 3600, token_type: 'Bearer' } };
const calls: string[] = [];
let route: Route = () => {
  throw new Error('no route set');
};

/** Google's JSON error body for a Calendar API call. */
const apiBody = (code: number, reason: string, message: string) => ({
  error: { code, message, errors: [{ domain: 'global', reason, message }] },
});

const calendarRequire = createRequire(require.resolve('@googleapis/calendar'));
const gaxiosModule = calendarRequire('gaxios') as {
  Gaxios: { prototype: { _defaultAdapter: (this: unknown, opts: GaxiosOpts) => Promise<unknown> } };
};
const nodeFetch = createRequire(calendarRequire.resolve('gaxios'))('node-fetch') as {
  FetchError: new (message: string, type: string, systemError?: { code: string }) => Error;
};

function installFakeGoogle(): void {
  // The calendar client, its auth library and their transports must all share the one
  // gaxios whose adapter is replaced; otherwise a request could reach the network.
  const authGaxios = createRequire(calendarRequire.resolve('google-auth-library'))('gaxios');
  const commonGaxios = createRequire(calendarRequire.resolve('googleapis-common'))('gaxios');
  if (authGaxios !== gaxiosModule || commonGaxios !== gaxiosModule) {
    console.error('FAIL  the Google client loads more than one gaxios; refusing to run without the fake');
    process.exit(1);
  }
  const real = gaxiosModule.Gaxios.prototype._defaultAdapter;
  gaxiosModule.Gaxios.prototype._defaultAdapter = async function (this: unknown, opts: GaxiosOpts) {
    const url = String(opts.url);
    calls.push(url);
    const answer = await route(opts, (o) => real.call(this, o));
    return { config: opts, data: answer.data, headers: {}, status: answer.status, statusText: String(answer.status), request: { responseURL: url } };
  };
}

async function main() {
  installFakeGoogle();

  const { auth, calendar: googleCalendar } = await import('@googleapis/calendar');
  const { classifyGoogleError, googleErrorFacts, keepGoogleEvent, mapGoogleEvent } = await import('../src/services/calendar-read/google-map');
  const { htmlToText } = await import('../src/utils/html');

  const newAuth = () => {
    const client = new auth.OAuth2('fake-client-id', 'fake-client-secret');
    client.setCredentials({ refresh_token: 'fake-refresh-token' });
    return client;
  };

  /** What the token step (auth.getAccessToken) throws when the token endpoint answers `answer`. */
  async function tokenStepError(answer: Answer | ((opts: GaxiosOpts) => never)): Promise<unknown> {
    route = (opts) => {
      if (String(opts.url) !== TOKEN_URL) throw new Error(`unexpected URL ${String(opts.url)}`);
      return typeof answer === 'function' ? answer(opts) : answer;
    };
    try {
      await newAuth().getAccessToken();
    } catch (e) {
      return e;
    }
    throw new Error('the token step did not fail');
  }

  /** What events.list throws when the token is fine and the Calendar API answers `api`. */
  async function listError(api: Route): Promise<unknown> {
    route = (opts, real) => (String(opts.url) === TOKEN_URL ? TOKEN_OK : api(opts, real));
    const cal = googleCalendar({ version: 'v3', auth: newAuth() });
    try {
      await cal.events.list(
        { calendarId: 'family@group.calendar.google.com', timeMin: '2026-10-16T00:00:00Z', timeMax: '2026-10-17T00:00:00Z', singleEvents: true },
        { retryConfig: { retry: 1, noResponseRetries: 0 } },
      );
    } catch (e) {
      return e;
    }
    throw new Error('events.list did not fail');
  }

  type Shape = {
    constructor?: { name?: string };
    message?: string;
    status?: number;
    code?: unknown;
    response?: { status?: number; data?: { error?: unknown } };
    error?: { name?: string; type?: string };
  };
  const shape = (e: unknown) => e as Shape;

  // ---- classifyGoogleError on the token step ------------------------------------------

  await check('token step: invalid_grant (HTTP 400) is a dead token', async () => {
    const e = await tokenStepError({ status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } });
    const s = shape(e);
    assert(s.constructor?.name === 'GaxiosError' && s.message === 'invalid_grant' && s.status === 400 && s.code === undefined, `shape ${JSON.stringify({ name: s.constructor?.name, message: s.message, status: s.status, code: s.code })}`);
    assertEq(classifyGoogleError(e), 'token', 'class');
  });

  await check('token step: invalid_grant needing re-auth (message rewritten to JSON) is a dead token', async () => {
    const e = await tokenStepError({ status: 400, data: { error: 'invalid_grant', error_description: 'reauth related error (invalid_rapt)' } });
    assert(shape(e).message?.startsWith('{') === true, `message ${shape(e).message}`);
    assertEq(classifyGoogleError(e), 'token', 'class');
  });

  await check('token step: admin_policy_enforced is a dead token', async () => {
    const e = await tokenStepError({ status: 400, data: { error: 'admin_policy_enforced', error_description: 'Blocked by the Workspace admin.' } });
    assertEq(classifyGoogleError(e), 'token', 'class');
  });

  for (const oauth of ['invalid_client', 'unauthorized_client']) {
    await check(`token step: ${oauth} (HTTP 401) is our server config, not the user's token`, async () => {
      const e = await tokenStepError({ status: 401, data: { error: oauth, error_description: 'Unauthorized' } });
      const s = shape(e);
      assert(s.status === 401 && s.response?.status === 401 && s.response?.data?.error === oauth, `shape ${JSON.stringify({ status: s.status, response: s.response?.status, error: s.response?.data?.error })}`);
      assertEq(classifyGoogleError(e), 'config', 'class');
    });
  }

  await check('token step: a bare 401 with no OAuth error string is a dead token', async () => {
    const e = await tokenStepError({ status: 401, data: 'Unauthorized' });
    assertEq(classifyGoogleError(e), 'token', 'class');
  });

  await check('token step: a network error on the /token URL is transient (the old check read "token" in the URL as a dead token)', async () => {
    const e = await tokenStepError((opts) => {
      throw new nodeFetch.FetchError(`request to ${String(opts.url)} failed, reason: getaddrinfo ENOTFOUND oauth2.googleapis.com`, 'system', { code: 'ENOTFOUND' });
    });
    const s = shape(e);
    assert(s.message?.includes('/token') === true && s.code === 'ENOTFOUND' && s.response === undefined, `shape ${JSON.stringify({ message: s.message, code: s.code })}`);
    assertEq(classifyGoogleError(e), 'transient', 'class');
  });

  // ---- classifyGoogleError on events.list ---------------------------------------------

  await check('events.list: a bare 401 (invalid credentials) is a dead token', async () => {
    const e = await listError(() => ({ status: 401, data: apiBody(401, 'authError', 'Invalid Credentials') }));
    assert(shape(e).status === 401 && shape(e).code === 401, `status ${shape(e).status} code ${String(shape(e).code)}`);
    assertEq(classifyGoogleError(e), 'token', 'class');
  });

  for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']) {
    await check(`events.list: a 403 ${reason} is transient`, async () => {
      const e = await listError(() => ({ status: 403, data: apiBody(403, reason, 'Rate Limit Exceeded') }));
      assertEq(classifyGoogleError(e), 'transient', 'class');
    });
  }

  await check('events.list: a 403 for missing permissions is scopes', async () => {
    const e = await listError(() => ({ status: 403, data: apiBody(403, 'insufficientPermissions', 'Insufficient Permission') }));
    assertEq(classifyGoogleError(e), 'scopes', 'class');
  });

  await check('events.list: any other 403 is forbidden (a read-only calendar, not the organizer), not a dead token', async () => {
    const e = await listError(() => ({ status: 403, data: apiBody(403, 'forbidden', 'Forbidden') }));
    assertEq(classifyGoogleError(e), 'forbidden', 'class');
    const ro = await listError(() => ({ status: 403, data: apiBody(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.') }));
    assertEq(classifyGoogleError(ro), 'forbidden', 'read-only');
  });

  for (const [status, reason] of [[404, 'notFound'], [410, 'deleted']] as const) {
    await check(`events.list: ${status} means the calendar is gone`, async () => {
      const e = await listError(() => ({ status, data: apiBody(status, reason, 'Not Found') }));
      assertEq(classifyGoogleError(e), 'gone', 'class');
    });
  }

  for (const [status, data] of [
    [408, apiBody(408, 'requestTimeout', 'Request Timeout')],
    [429, apiBody(429, 'rateLimitExceeded', 'Rate Limit Exceeded')],
    [500, apiBody(500, 'backendError', 'Backend Error')],
    [503, '<html><body>Service Unavailable</body></html>'],
  ] as const) {
    await check(`events.list: ${status} is transient`, async () => {
      const e = await listError(() => ({ status, data }));
      assertEq(classifyGoogleError(e), 'transient', 'class');
    });
  }

  await check('events.list: ECONNRESET (no response, a string code) is transient', async () => {
    const e = await listError((opts) => {
      throw new nodeFetch.FetchError(`request to ${String(opts.url)} failed, reason: socket hang up`, 'system', { code: 'ECONNRESET' });
    });
    assert(shape(e).code === 'ECONNRESET' && shape(e).response === undefined, `code ${String(shape(e).code)}`);
    assertEq(classifyGoogleError(e), 'transient', 'class');
  });

  await check('events.list: a node-fetch request-timeout is transient', async () => {
    const e = await listError((opts) => {
      throw new nodeFetch.FetchError(`network timeout at: ${String(opts.url)}`, 'request-timeout');
    });
    assert(shape(e).error?.type === 'request-timeout' && shape(e).code === undefined, `error.type ${shape(e).error?.type}`);
    assertEq(classifyGoogleError(e), 'transient', 'class');
  });

  await check('events.list: an aborted request (node-fetch AbortError) is transient', async () => {
    // The real fetch, with a signal already aborted: it rejects before opening a socket
    // (and the URL is pointed at the local discard port all the same).
    const e = await listError(async (opts, real) => {
      await real({ ...opts, url: 'http://127.0.0.1:9/', agent: undefined, signal: AbortSignal.abort() });
      throw new Error('the aborted fetch answered');
    });
    assert(shape(e).error?.name === 'AbortError', `error.name ${shape(e).error?.name}`);
    assertEq(classifyGoogleError(e), 'transient', 'class');
  });

  await check('non-Google errors are unknown; a plain { code } object is read by its code', () => {
    assertEq(classifyGoogleError(new Error('boom')), 'unknown', 'Error');
    assertEq(classifyGoogleError(null), 'unknown', 'null');
    assertEq(classifyGoogleError(undefined), 'unknown', 'undefined');
    assertEq(classifyGoogleError('invalid_grant'), 'unknown', 'a string');
    assertEq(classifyGoogleError({ code: 403, message: 'Insufficient Permission' }), 'scopes', '{ code: 403 } scopes');
    assertEq(classifyGoogleError({ code: 503, message: 'Backend Error' }), 'transient', '{ code: 503 }');
  });

  // ---- keepGoogleEvent ----------------------------------------------------------------

  const timed = { dateTime: '2026-10-16T09:00:00+03:00' };
  const base = (extra: calendar_v3.Schema$Event = {}): calendar_v3.Schema$Event =>
    ({ id: 'e1', status: 'confirmed', summary: 'Dentist', start: timed, end: { dateTime: '2026-10-16T10:00:00+03:00' }, ...extra });

  await check('keepGoogleEvent: drops working location, out of office and focus time; keeps every other type', () => {
    for (const t of ['workingLocation', 'outOfOffice', 'focusTime']) assert(!keepGoogleEvent(base({ eventType: t })), `kept ${t}`);
    for (const t of ['default', 'birthday', 'fromGmail', 'someTypeGoogleAddsLater']) assert(keepGoogleEvent(base({ eventType: t })), `dropped ${t}`);
    assert(keepGoogleEvent(base()), 'dropped an event with no eventType');
  });

  await check('keepGoogleEvent: drops cancelled; keeps confirmed and tentative', () => {
    assert(!keepGoogleEvent(base({ status: 'cancelled' })), 'kept cancelled');
    assert(keepGoogleEvent(base({ status: 'tentative' })), 'dropped tentative');
    assert(keepGoogleEvent(base({ status: undefined })), 'dropped no status');
  });

  await check('keepGoogleEvent: drops an event with no start; keeps all-day and timed', () => {
    assert(!keepGoogleEvent(base({ start: undefined })), 'kept no start');
    assert(!keepGoogleEvent(base({ start: {} })), 'kept a start with neither date nor dateTime');
    assert(keepGoogleEvent(base({ start: { date: '2026-10-16' }, end: { date: '2026-10-17' } })), 'dropped all-day');
  });

  await check('keepGoogleEvent: drops what the calendar\'s owner declined, only that', () => {
    assert(!keepGoogleEvent(base({ attendees: [{ self: true, responseStatus: 'declined' }] })), 'kept declined by self');
    assert(keepGoogleEvent(base({ attendees: [{ self: true, responseStatus: 'accepted' }, { responseStatus: 'declined' }] })), 'dropped declined by another attendee');
    assert(keepGoogleEvent(base({ attendees: [{ responseStatus: 'declined' }] })), 'dropped a decline that is not self');
    for (const r of ['tentative', 'needsAction', 'accepted']) assert(keepGoogleEvent(base({ attendees: [{ self: true, responseStatus: r }] })), `dropped self ${r}`);
  });

  await check('keepGoogleEvent (google-sync S2): drops FamCal\'s own copies (private famcalSync); keeps the move\'s famcalMovedFrom, a shared famcalSync and other private properties', () => {
    assert(!keepGoogleEvent(base({ extendedProperties: { private: { famcalSync: 'link-1', famcalSeries: 's1' } } })), 'kept a FamCal copy');
    assert(!keepGoogleEvent(base({ extendedProperties: { private: { famcalSync: 'link-1' } } })), 'kept a FamCal copy without its series');
    assert(keepGoogleEvent(base({ extendedProperties: { private: { famcalMovedFrom: 's1' } } })), 'dropped a moved event (famcalMovedFrom is no copy)');
    assert(keepGoogleEvent(base({ extendedProperties: { shared: { famcalSync: 'link-1' } } })), 'dropped a shared property (only private marks a copy)');
    assert(keepGoogleEvent(base({ extendedProperties: { private: { other: 'x' } } })), 'dropped another private property');
  });

  // ---- htmlToText ---------------------------------------------------------------------

  await check('htmlToText: a missing description is empty', () => {
    assertEq([htmlToText(undefined), htmlToText(null), htmlToText('')], ['', '', ''], 'empty');
  });

  await check('htmlToText: plain text passes through unchanged', () => {
    for (const s of ['Bring the cake\n\n\n\nand candles  ', 'a < b and c > d', 'Tom & Jerry', 'AT&T; call first', 'שלום, Привет 🎂']) assertEq(htmlToText(s), s, 'plain');
  });

  await check('htmlToText: entities are decoded once', () => {
    assertEq(htmlToText('Tom &amp; Jerry'), 'Tom & Jerry', '&amp;');
    assertEq(htmlToText('&lt;b&gt;not bold&lt;/b&gt;'), '<b>not bold</b>', 'escaped tags stay text');
    assertEq(htmlToText('&amp;lt;'), '&lt;', 'double-escaped');
    assertEq(htmlToText('&quot;Hi&quot; &apos;there&#39;'), '"Hi" \'there\'', 'quotes');
    assertEq(htmlToText('&#1513;&#1500;&#1493;&#1501; &#x1F382;'), 'שלום 🎂', 'numeric');
    assertEq(htmlToText('a&nbsp;b &ndash; c&hellip;'), 'a b – c…', 'named');
    assertEq(htmlToText('<b>x</b> &bogus; &#0; &#xD800;'), 'x &bogus; &#0; &#xD800;', 'unknown and invalid kept');
  });

  await check('htmlToText: a javascript: link keeps its URL as text, never as a link', () => {
    assertEq(htmlToText('<a href="javascript:alert(1)">click</a>'), 'click (javascript:alert(1))', 'javascript');
    assertEq(htmlToText('<a href="data:text/html,x">go</a>'), 'go (data:text/html,x)', 'data');
  });

  await check('htmlToText: line tags become newlines, list items bullets', () => {
    assertEq(htmlToText('One<br>Two<br/>Three<BR />Four'), 'One\nTwo\nThree\nFour', 'br');
    assertEq(htmlToText('<p>First</p><p>Second</p>'), 'First\nSecond', 'p');
    assertEq(htmlToText('<div>a</div><div><br></div><div>b</div>'), 'a\n\nb', 'div with a blank line');
    assertEq(htmlToText('<ul><li>milk</li><li>eggs</li></ul>'), '• milk\n• eggs', 'li');
  });

  await check('htmlToText: links keep their address', () => {
    assertEq(htmlToText('<a href="https://zoom.us/j/1">Join Zoom</a>'), 'Join Zoom (https://zoom.us/j/1)', 'text and address');
    assertEq(htmlToText('<a href="https://x.com/a?b=1&amp;c=2">https://x.com/a?b=1&amp;c=2</a>'), 'https://x.com/a?b=1&c=2', 'text is the address');
    assertEq(htmlToText("<a href='https://x.com'>https://x.com</a>"), 'https://x.com', 'single quotes');
    assertEq(htmlToText('<a href="https://x.com"><b>Site</b></a>'), 'Site (https://x.com)', 'tags inside the text');
    assertEq(htmlToText('<a href="https://x.com"></a>'), 'https://x.com', 'no text');
    assertEq(htmlToText('<a name="top">Top</a>'), 'Top', 'no href');
    assertEq(htmlToText('<a href="mailto:dana@example.com">dana@example.com</a>'), 'dana@example.com', 'mailto with the address as text');
  });

  await check('htmlToText: other tags are stripped, blank lines collapse, ends are trimmed', () => {
    assertEq(htmlToText('<b>Bold</b> and <span style="color:red">red</span>'), 'Bold and red', 'inline tags');
    assertEq(htmlToText('<style>p { color: red }</style><!-- note -->Hi'), 'Hi', 'style block and comment');
    assertEq(htmlToText('a<br><br><br><br>b'), 'a\n\nb', 'blank lines');
    assertEq(htmlToText('<br>Hi<br>'), 'Hi', 'trimmed');
    assertEq(htmlToText('<br>'), '', 'nothing left');
  });

  await check('htmlToText: spaces and tabs go at the edges of each line and stay inside it', () => {
    assertEq(htmlToText('<p>  one  </p>\t two \t<br> \t <br>three'), 'one\ntwo\n\nthree', 'line edges');
    assertEq(htmlToText('<b>a   b</b>\t\tc'), 'a   b\t\tc', 'inside a line');
    assertEq(htmlToText('<b>a</b> &#13; b &#8232; c'), 'a\rb\u2028c', 'a decoded line break is a line edge too');
  });

  await check('htmlToText: a Google Calendar description reads as text', () => {
    const html = '<b>Agenda</b><br><ul><li>Budget</li><li>Trip</li></ul><br>Join: <a href="https://meet.google.com/abc-defg-hij">https://meet.google.com/abc-defg-hij</a>';
    assertEq(htmlToText(html), 'Agenda\n• Budget\n• Trip\n\nJoin: https://meet.google.com/abc-defg-hij', 'description');
  });

  await check('htmlToText: <…> around a link, an address or a word is text, not a tag (Teams, Outlook and Zoom invites)', () => {
    const teams = 'Click here to join the meeting<https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc>\nOrganizer: Dana Levi <dana@corp.com>';
    assertEq(htmlToText(teams), teams, 'a plain-text Teams invite');
    assertEq(htmlToText('Use the <Back> door'), 'Use the <Back> door', 'a word in angle brackets');
    const zoom = 'Zoom: <https://zoom.us/j/123?pwd=abc>\nHosts: Bo Levi <b.levi@corp.com>, Li Wang <li.wang@corp.com>, <a.cohen@corp.com>';
    assertEq(htmlToText(zoom), zoom, 'addresses that start like a tag name');
    assertEq(htmlToText('<p>Join: &lt;https://x.y&gt;</p>'), 'Join: <https://x.y>', 'an escaped link in HTML decodes to text');
    assertEq(
      htmlToText('<b>Microsoft Teams</b><br>Join<https://teams.microsoft.com/l/x><br>Li Wang <li.wang@corp.com>'),
      'Microsoft Teams\nJoin<https://teams.microsoft.com/l/x>\nLi Wang <li.wang@corp.com>',
      'raw <…> inside HTML stays',
    );
    assertEq(htmlToText('<html-blob><u>Notes</u><o:p></o:p></html-blob><H1>Agenda</H1>'), 'Notes\nAgenda', 'Google\'s and Outlook\'s own tags still go, and a heading starts its line');
  });

  await check('htmlToText: blocks (headings, paragraphs, tables, lists, quotes, pre, hr) start and end a line, a table cell is set apart, and a block next to a line break adds no second one', () => {
    assertEq(htmlToText('<h1>Agenda</h1><p>Budget</p>'), 'Agenda\nBudget', 'a heading');
    assertEq(htmlToText('<table><tr><td>Agenda</td><td>Budget</td></tr><tr><th>Q1</th><th>Q2</th></tr></table><h2>Join</h2><p>Room 4</p>'), 'Agenda Budget\nQ1 Q2\nJoin\nRoom 4', 'an Outlook table, a heading, a paragraph');
    assertEq(htmlToText('Agenda:<ul><li>Budget<li>Hiring</ul>Bring laptops'), 'Agenda:\n• Budget\n• Hiring\nBring laptops', 'a list whose items are not closed');
    assertEq(htmlToText('<ul><li><p>First</p></li><li><p>Second</p></li></ul>'), '• First\n\n• Second', 'a bullet keeps its paragraph');
    assertEq(htmlToText('One<hr>Two<blockquote>Quoted</blockquote>Three<pre>line 1\nline 2</pre>after'), 'One\nTwo\nQuoted\nThree\nline 1\nline 2\nafter', 'a rule, a quote, pre');
    assertEq(htmlToText('Hi<p>There</p>Intro<div>Body</div>'), 'Hi\nThere\nIntro\nBody', 'paragraphs and divs where they open');
    assertEq(htmlToText('<p>Agenda:</p><ul><li>Budget</li></ul><p>Next</p>'), 'Agenda:\n• Budget\nNext', 'a block next to </p> adds no second line break');
  });

  await check('htmlToText: the cut is 500 code points and never splits an emoji', () => {
    const cut = htmlToText('a'.repeat(499) + '😀😀');
    assertEq(cut, 'a'.repeat(499) + '😀', 'emoji at the edge');
    assertEq(Array.from(htmlToText('ש'.repeat(600))).length, 500, 'plain text is cut too');
    assertEq(htmlToText('<b>' + 'é'.repeat(600) + '</b>'), 'é'.repeat(500), 'the cut counts the text, not the tags');
    assertEq(htmlToText('abcdefghij', 5), 'abcde', 'max');
  });

  // ---- mapGoogleEvent -----------------------------------------------------------------

  const FAMILY = 'family@group.calendar.google.com';
  const DANA = 'dana@example.com';
  const LISTS: Record<string, { summary?: string; items: calendar_v3.Schema$Event[] }> = {
    [FAMILY]: {
      summary: 'Family',
      items: [
        { id: 'ev-dentist', summary: 'Dentist', start: { dateTime: '2026-10-16T09:00:00+03:00' }, end: { dateTime: '2026-10-16T10:00:00+03:00' }, location: 'Haifa', description: 'Bring the forms', htmlLink: 'https://www.google.com/calendar/event?eid=1' },
        { id: 'ev-trip', summary: 'Trip', start: { date: '2026-10-16' }, end: { date: '2026-10-19' }, description: '' },
        { id: 'ev-untitled', start: { dateTime: '2026-10-16T12:00:00+03:00' }, end: { dateTime: '2026-10-16T12:30:00+03:00' } },
        { id: 'ev-swim_20261016T150000Z', summary: 'Swim', recurringEventId: 'ev-swim', originalStartTime: { dateTime: '2026-10-16T18:00:00+03:00' }, start: { dateTime: '2026-10-16T18:30:00+03:00' }, end: { dateTime: '2026-10-16T19:30:00+03:00' }, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] } },
      ],
    },
    [DANA]: {
      items: [
        { id: 'ev-bday', summary: 'Noa', eventType: 'birthday', recurringEventId: 'ev-bday-series', originalStartTime: { date: '2026-10-16' }, start: { date: '2026-10-16' }, end: { date: '2026-10-17' } },
        { id: 'ev-holiday', summary: 'Sukkot', eventType: 'default', start: { date: '2026-10-16' }, end: { date: '2026-10-17' }, reminders: { useDefault: true } },
      ],
    },
  };
  const calendarNameOf = (id: string) => LISTS[id].summary || id;

  /** Sorted keys, so the comparison is about values only. */
  const canon = (o: object) => JSON.stringify(o, Object.keys(o).sort());

  /**
   * What calendar.ts's day read (fetchTodayEvents, in Israel) made of each item, plus
   * provider, minus reminders: taken from it before it was removed.
   */
  const DAY_READ: Record<string, Record<string, string>> = {
    'ev-dentist': { calendarId: FAMILY, calendarName: 'Family', description: 'Bring the forms', end: '2026-10-16T10:00:00+03:00', eventId: 'ev-dentist', location: 'Haifa', provider: 'google', start: '2026-10-16T09:00:00+03:00', summary: 'Dentist' },
    'ev-trip': { calendarId: FAMILY, calendarName: 'Family', end: '2026-10-19', eventId: 'ev-trip', provider: 'google', start: '2026-10-16', summary: 'Trip' },
    'ev-untitled': { calendarId: FAMILY, calendarName: 'Family', end: '2026-10-16T12:30:00+03:00', eventId: 'ev-untitled', provider: 'google', start: '2026-10-16T12:00:00+03:00', summary: 'No title' },
    'ev-swim_20261016T150000Z': { calendarId: FAMILY, calendarName: 'Family', end: '2026-10-16T19:30:00+03:00', eventId: 'ev-swim_20261016T150000Z', provider: 'google', recurringEventId: 'ev-swim', start: '2026-10-16T18:30:00+03:00', summary: 'Swim' },
    'ev-bday': { calendarId: DANA, calendarName: DANA, end: '2026-10-17', eventId: 'ev-bday', eventType: 'birthday', provider: 'google', recurringEventId: 'ev-bday-series', start: '2026-10-16', summary: 'Noa' },
    'ev-holiday': { calendarId: DANA, calendarName: DANA, end: '2026-10-17', eventId: 'ev-holiday', eventType: 'default', provider: 'google', start: '2026-10-16', summary: 'Sukkot' },
  };

  await check('mapGoogleEvent: event is what the summaries\' old day read (calendar.ts fetchTodayEvents) made of the same items, plus provider, minus reminders', () => {
    const mapped: string[] = [];
    for (const [calendarId, list] of Object.entries(LISTS)) {
      for (const raw of list.items) {
        const want = DAY_READ[raw.id ?? ''];
        assert(want !== undefined, `nothing pinned for ${raw.id}`);
        const got = mapGoogleEvent(raw, calendarId, calendarNameOf(calendarId)).event;
        assert(canon(got) === canon(want), `${raw.id}\n     got  ${canon(got)}\n     want ${canon(want)}`);
        mapped.push(raw.id ?? '');
      }
    }
    assertEq(mapped.sort(), Object.keys(DAY_READ).sort(), 'the items mapped');
  });

  await check('mapGoogleEvent: the reader fields', () => {
    const [dentist, , untitled, swim] = LISTS[FAMILY].items;
    const [bday] = LISTS[DANA].items;
    const d = mapGoogleEvent(dentist, FAMILY, 'Family');
    assertEq(
      { source: d.source, key: d.key, title: d.title, kind: d.kind, seriesId: d.seriesId, originalStart: d.originalStart, recurring: d.recurring, rrule: d.rrule, google: d.google },
      { source: 'google', key: 'google|family@group.calendar.google.com|ev-dentist', title: 'Dentist', kind: 'event', seriesId: null, originalStart: null, recurring: false, rrule: null, google: { birthday: false, htmlLink: 'https://www.google.com/calendar/event?eid=1', editable: true } },
      'a one-off',
    );
    assert(!('calendar' in d) && !('state' in d), 'calendar or state set');
    const u = mapGoogleEvent(untitled, FAMILY, 'Family');
    assertEq([u.title, u.event.summary, u.google?.htmlLink], [null, 'No title', null], 'no title: raw null, the summary keeps "No title"');
    const s = mapGoogleEvent(swim, FAMILY, 'Family');
    assertEq([s.seriesId, s.originalStart, s.recurring], ['ev-swim', '2026-10-16T18:00:00+03:00', true], 'a moved recurring instance');
    const b = mapGoogleEvent(bday, DANA, DANA);
    assertEq([b.google?.birthday, b.originalStart, b.event.eventType, b.event.calendarName], [true, '2026-10-16', 'birthday', DANA], 'a birthday');
  });

  await check('mapGoogleEvent: google.editable is the home\'s rule on the listed event (a plain event, or one the viewer organizes alone; not other guests, guests left out, a lock, or another type; a birthday never)', () => {
    const editable = (extra: calendar_v3.Schema$Event) => mapGoogleEvent({ id: 'x', summary: 'X', start: timed, ...extra }, FAMILY, 'Family').google?.editable;
    assertEq(
      [
        editable({}),
        editable({ eventType: 'default' }),
        editable({ organizer: { self: true }, attendees: [{ self: true, responseStatus: 'accepted' }] }),
        editable({ attendees: [{ responseStatus: 'accepted' }] }),
        editable({ organizer: { self: true }, attendees: [{ self: true }, { responseStatus: 'needsAction' }] }),
        editable({ attendees: [{ self: true }], organizer: { self: false } }),
        editable({ attendeesOmitted: true }),
        editable({ locked: true }),
        editable({ eventType: 'birthday' }),
        editable({ eventType: 'outOfOffice' }),
      ],
      [true, true, true, false, false, false, false, false, false, false],
      'editable',
    );
  });

  await check('mapGoogleEvent: an HTML description becomes text; one with no text is dropped', () => {
    const html = mapGoogleEvent({ id: 'h', summary: 'Call', start: timed, description: 'Dial in:<br><a href="https://meet.google.com/x">Meet</a>' }, FAMILY, 'Family');
    assertEq(html.event.description, 'Dial in:\nMeet (https://meet.google.com/x)', 'description');
    const empty = mapGoogleEvent({ id: 'h2', summary: 'Call', start: timed, description: '<br>' }, FAMILY, 'Family');
    assert(empty.event.description === undefined, `got ${JSON.stringify(empty.event.description)}`);
  });

  await check('mapGoogleEvent: an 8,192-character description with one long space run maps in well under 50 ms', () => {
    const description = '<b>x</b>' + ' '.repeat(8192 - 9) + '.';
    assertEq(description.length, 8192, 'length');
    const started = performance.now();
    const long = mapGoogleEvent({ id: 'long', summary: 'Call', start: timed, description }, FAMILY, 'Family');
    const ms = performance.now() - started;
    assertEq(long.event.description, 'x' + ' '.repeat(499), 'the run is inside the line, so it stays (cut at 500)');
    assert(ms < 50, `took ${ms.toFixed(1)} ms`);
  });

  await check('mapGoogleEvent: each crafted 32,768-character description (opens with no end after them) maps in well under 50 ms', () => {
    const size = 32768;
    /** head, then unit repeated, then tail: `size` characters. */
    const fill = (unit: string, tail = '', head = '') =>
      head + unit.repeat(Math.ceil(size / unit.length)).slice(0, size - head.length - tail.length) + tail;
    const shapes: Record<string, string> = {
      '"<b " repeated': fill('<b '),
      '"<br " repeated': fill('<br '),
      '"<li " repeated': fill('<li ', '', '<b>x</b>'),
      '"<a " repeated, one ">", no </a>': fill('<a ', '>' + 'x'.repeat(size / 2 - 1)),
      '"<a>" repeated, no </a>': fill('<a>'),
      '"<a href=x>" repeated, then text': fill('<a href=x>', 'x'.repeat(size / 2)),
      '"<script>" repeated, no closer': fill('<script>'),
      '"<style " repeated': fill('<style '),
      '"<!--" repeated': fill('<!--'),
      '"<!-- <script>" repeated': fill('<!-- <script>'),
      '"</a " repeated': fill('</a '),
      '"href=\\"" repeated in one <a>': fill('href="', '>x</a>', '<a '),
      '"<b " repeated inside a link': fill('<b ', '</a>', '<a href=x>'),
      '<b>, then spaces': '<b>' + ' '.repeat(size - 4) + '.',
      '"<h1 " repeated': fill('<h1 ', '', '<b>x</b>'),
      '"<td " repeated': fill('<td ', '', '<b>x</b>'),
      '"<p " repeated': fill('<p ', '', '<b>x</b>'),
    };
    const slow: string[] = [];
    for (const [name, description] of Object.entries(shapes)) {
      assertEq(description.length, size, `${name}: length`);
      const started = performance.now();
      mapGoogleEvent({ id: 'crafted', summary: 'Call', start: timed, description }, FAMILY, 'Family');
      const ms = performance.now() - started;
      if (ms >= 50) slow.push(`${name} took ${ms.toFixed(1)} ms`);
    }
    assert(slow.length === 0, slow.join('; '));
  });

  // What a log line says about a failure (googleErrorFacts): which request failed, without its
  // query or ids, and the token endpoint's own words, which gaxios leaves out of the message.
  await check('facts: a refused token refresh names Google\'s OAuth error with its description, and the request', async () => {
    const e = await tokenStepError({ status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } });
    const facts = googleErrorFacts(e);
    assertEq({ status: facts.status, oauth: facts.oauth, request: facts.request }, { status: 400, oauth: 'invalid_grant: Token has been expired or revoked.', request: 'POST oauth2.googleapis.com/token' }, 'facts');
  });

  await check('facts: a failed Calendar API call names its method and path, the calendar id masked and the query (times) dropped', async () => {
    const e = await listError(() => ({ status: 401, data: apiBody(401, 'authError', 'Invalid Credentials') }));
    const facts = googleErrorFacts(e);
    assertEq({ status: facts.status, oauth: facts.oauth, request: facts.request }, { status: 401, oauth: undefined, request: 'GET www.googleapis.com/calendar/v3/calendars/:id/events' }, 'facts');
  });

  await check('facts: ids after calendars, calendarList, events and acl are masked (a URL object or a string); the primary keyword is kept', () => {
    const at = (method: string | undefined, url: unknown) => googleErrorFacts({ config: { method, url }, response: { status: 401 } }).request;
    assertEq(at('patch', new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList/x9f%40group.calendar.google.com?alt=json')), 'PATCH www.googleapis.com/calendar/v3/users/me/calendarList/:id', 'calendarList.patch');
    assertEq(at(undefined, 'https://www.googleapis.com/calendar/v3/calendars/primary?fields=id'), 'GET www.googleapis.com/calendar/v3/calendars/primary', 'calendars.get primary');
    assertEq(at('DELETE', 'https://www.googleapis.com/calendar/v3/calendars/fam%40group.calendar.google.com/events/ev1_20261020T090000Z'), 'DELETE www.googleapis.com/calendar/v3/calendars/:id/events/:id', 'events.delete');
    assertEq(at('POST', 'https://www.googleapis.com/calendar/v3/calendars/c1/acl/user%3Aa%40b.c'), 'POST www.googleapis.com/calendar/v3/calendars/:id/acl/:id', 'acl');
    assertEq(googleErrorFacts(new Error('plain')).request, undefined, 'an error with no request');
  });

  await check('the fake answered every request (nothing went past it)', () => {
    assert(calls.length > 0 && calls.every((u) => u === TOKEN_URL || u.startsWith('https://www.googleapis.com/calendar/v3/') || u === 'http://127.0.0.1:9/'), `calls ${JSON.stringify(calls)}`);
  });

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'OK' : 'FAIL'}  ${r.name}${r.ok ? '' : ` — ${r.reason}`}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed (process TZ=${process.env.TZ ?? 'unset'})`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL  smoke crashed:', err);
  process.exit(1);
});
