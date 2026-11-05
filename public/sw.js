// FamCal's service worker, the small program that shows its notifications (web push spec 2026-11-05 §3.3). It does three
// things and nothing else: shows a push, opens the app when the notification is tapped, and takes control at once. It has no
// fetch handler and no cache, so FamCal's pages work exactly as they do without it.
//
// - The payload is Apple's declarative JSON, the same one on every browser (src/services/web-push/payload.ts):
//   { web_push: 8030, notification: { title, body, navigate, lang, dir, tag, silent } }. A push whose payload cannot be read
//   still shows "FamCal": a browser that sees a push show nothing can cut the subscription off (Safari) or show its own
//   "updated in the background" line (Chrome).
// - The words of a notification are the person's own: nothing here logs a title, a body or a URL.
// - A tap closes the notification, then focuses a FamCal window that is open and navigates it to the notification's URL,
//   else opens a new window (the home, when the URL is not FamCal's own).
// - Plain JavaScript with no build step, served from /sw.js with Cache-Control: no-cache (next.config.js). The registration
//   is made in the tap that turns notifications on (src/lib/web-push-client.ts), never before. scripts/smoke-push-worker.ts
//   runs this very file.

const ICON = '/icon-192.png';
const HOME = '/dashboard';
const FALLBACK_TITLE = 'FamCal';

// The new worker does not wait for the old one's windows to close, and takes the open ones over: on an iPhone's first launch
// the page is otherwise not controlled by the worker that subscribes it
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

// The payload's `notification` object, or an empty one for a push with no data or data that is not our JSON
function readNotification(event) {
  try {
    const data = event.data ? event.data.json() : null;
    return data && typeof data === 'object' && data.notification && typeof data.notification === 'object' ? data.notification : {};
  } catch {
    console.warn('[sw] a push with a payload that is not JSON');
    return {};
  }
}

// An absolute URL on FamCal's own origin: what the payload says, else the home. Another origin, a bad URL or none opens the home.
function targetOf(value) {
  const home = new URL(HOME, self.location.origin).href;
  if (typeof value !== 'string' || value === '') return home;
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.href : home;
  } catch {
    return home;
  }
}

self.addEventListener('push', (event) => {
  const note = readNotification(event);
  const silent = note.silent === true;
  const tag = textOf(note.tag);
  const options = {
    body: textOf(note.body),
    icon: ICON,
    lang: textOf(note.lang),
    dir: note.dir === 'rtl' || note.dir === 'ltr' ? note.dir : 'auto',
    data: { url: targetOf(note.navigate) },
    silent,
  };
  // A newer notification with the tag of a shown one replaces it, and sounds again unless it is a silent one (the browser
  // refuses renotify on a silent notification)
  if (tag) {
    options.tag = tag;
    options.renotify = !silent;
  }
  event.waitUntil(self.registration.showNotification(textOf(note.title) || FALLBACK_TITLE, options));
});

function isOurs(client) {
  try {
    return new URL(client.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

async function openApp(target) {
  let windows = [];
  try {
    windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  } catch {
    console.warn('[sw] could not list the open windows');
  }
  const ours = windows.filter(isOurs);
  const open = ours.find((client) => client.focused) || ours.find((client) => client.visibilityState === 'visible') || ours[0];
  if (open) {
    try {
      const focused = await open.focus();
      await (focused || open).navigate(target);
      return;
    } catch {
      console.warn('[sw] could not focus or navigate the open window; opening a new one');
    }
  }
  try {
    await self.clients.openWindow(target);
  } catch {
    console.warn('[sw] could not open a window');
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openApp(targetOf(event.notification.data && event.notification.data.url)));
});
