# W4-3: the Google connect pages in the app's design — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the three pages a person passes through to connect Google — `/refresh-token` (start), `/oauth-callback` (Google's return, in the browser) and `/oauth-complete` (one more tap back to Telegram or WhatsApp) — move onto the app kit: light and dark, every word translated (no English-only error pages, no "state token", no raw error text), a retry where today there is none, and no empty card before the page loads.

**Architecture:** the three pages live outside `[locale]` (the proxy skips them, `proxy.ts`), so they get one shared shell: a server component that renders the document (`<html lang dir>`, `<body>`), the app's global CSS, a `NextIntlClientProvider` with the namespaces the page needs, and the Telegram SDK only where the page runs inside Telegram (`/refresh-token`). Each page then draws `AppScreen` + kit pieces (`StateCard`, `Notice`, `FormCard`, `ScreenHeader`). The flow itself does not change: the same requests, the same polling, the same redirects, the same fragment-only pending id.

**Tech Stack:** Next.js 16 app router (server components for oauth-callback, client components for the rest), next-intl, the kit in `components/app-ui`, smoke scripts with `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-10-19-screens-and-colours-design.md` §4–§5; the connect flow is `docs/superpowers/specs/2026-10-19-google-connection-design.md` (unchanged here). Survey: `/private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/web/w4-inventory.md` §3, §4, §5, §7.1 (read §7.1 before designing the shell).

## Global Constraints

- W4-1's constraints apply unchanged (read them: `git show ab9ebeea^:docs/superpowers/plans/2026-10-29-w4-1-calendars.md`): kit pieces and `--ch-*` tokens only, `lintCss`, 44 px targets, logical properties, dark mode from the kit (outside Telegram: `prefers-color-scheme`), lucide icons, no inline strings, gender-neutral Hebrew, formal Russian, mutation checks, fake-env smokes, textual message edits, local commits only with the trailers `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_017Qxen88HvHhmznBZG7Yo31`.
- **The flow does not change.** Keep exactly: `POST /api/oauth/start` and its use; `GET /api/check-token-refresh` with its header credential, `since`, 2 s polling for 3 minutes, the visibility re-check and the mount check; `famcalbot_oauth_pending` in localStorage; opening Google with Telegram's `openLink` in the Mini App and a new tab elsewhere; the URL refresh (`URL_FRESH_MS`); the move to `/${locale}/select-calendars?user_id=…` once the token landed; the callback's state checks, exchange, scope check, pending token and redirect to `/oauth-complete?locale=…#p=…&n=…&b=…`; the fragment-only pending id; `finishLinks` and the three claim channels. No locale prefix on these three paths.
- **Exports the smokes call stay** with their signatures, or the smokes change in the same commit: `startErrorLines`, `attemptFromStart`, `attemptSince` (RefreshTokenClient), `parseFinishFragment`, `finishLinks`, `FinishButtons` (OAuthCompleteClient), the oauth-callback page's default export run as a function (`runCallback` in `scripts/smoke-google-connect.ts`). Update `scripts/smoke-google-connect.ts` (#3, #4, #5, #15, #15b, #25, #27, #49, #50, #50b, #52), `scripts/smoke-miniapp-gate.ts` #20, `scripts/smoke-key-rotation.ts` (~:460) and `scripts/smoke-auth-leftovers.ts` where they read markup or props.
- No raw error text reaches a person: an exception's message is logged (and already sent to Sentry) and the page says a translated sentence.
- Remove the `refreshToken` and `oauth` exemptions from `scripts/smoke-he-neutral.ts` (the last ones).
- Building: you may run `npx next build` (it does not migrate; never `npm run build`) or the CI mirror `bash /private/tmp/claude-501/-Users-razielgershoni-development-famcalbot/0d239296-a217-49f9-8833-757c9d9a2df6/scratchpad/ci-local.sh <sha>` on your last commit, because the layout change must be proved to build.

## Review Focus

1. A Hebrew person who reconnects inside Telegram in dark mode: the page is RTL, readable, the steps are in order, Connect opens Google, and the page moves on by itself when the token lands.
2. A Russian person whose consent link was already used or expired (reloaded the Google page, tapped an old link): a translated "link expired" card with a way back, never English, never a raw error.
3. A person who denies on Google's screen (Google returns `error=access_denied`, no `code`): today `/api/refresh-token` answers raw JSON `{"error":"Missing code or state parameter"}` (inventory §A7); they get a translated card instead with a way back.
4. The finish page before it has read its fragment: a loader, never an empty white card; a link missing its fragment: the translated "incomplete" card.
5. WhatsApp-only person in a browser: the start page works with the session cookie, opens a tab, and the waiting text says "Finish in WhatsApp".

---

### Task 1: The words

Rewrite these namespaces in `messages/{en,he,ru}.json` (verbatim; keys not listed keep their current text):

| key | en | he | ru |
|---|---|---|---|
| `refreshToken.title` | Reconnect Google Calendar | חיבור מחדש ליומן Google | Повторное подключение Google Календаря |
| `refreshToken.subtitle` | Google stopped sharing your calendars with FamCal. Connect again to see them here and in your summaries. | Google הפסיק לשתף את היומנים שלכם עם FamCal. אפשר להתחבר שוב כדי לראות אותם כאן ובסיכומים. | Google перестал передавать FamCal ваши календари. Подключитесь снова, чтобы видеть их здесь и в сводках. |
| `refreshToken.stepsTitle` | How it goes | איך זה עובד | Как это работает |
| `refreshToken.step1` | Sign in to Google | נכנסים לחשבון Google | Войдите в Google |
| `refreshToken.step2` | Allow access to your calendar, ticking every box | מאשרים גישה ליומן ומסמנים את כל התיבות | Разрешите доступ к календарю, отметив все пункты |
| `refreshToken.step3` | Your calendars are back in FamCal | היומנים חוזרים ל־FamCal | Календари снова появятся в FamCal |
| `refreshToken.connectStep3` | Choose the calendars to show | בוחרים אילו יומנים להציג | Выберите, какие календари показывать |
| `refreshToken.button` | Continue to Google | להמשיך ל־Google | Перейти в Google |
| `refreshToken.preparing` (new) | Getting Google ready… | מכינים את החיבור ל־Google… | Готовим вход в Google… |
| `refreshToken.checking` | Checking the connection… | בודקים את החיבור… | Проверяем подключение… |
| `refreshToken.retry` (new) | Try again | לנסות שוב | Попробовать снова |
| `refreshToken.checkAgain` (new) | Check again | לבדוק שוב | Проверить снова |
| `refreshToken.stillWaiting` (new) | Still waiting? If you finished in Google, tap Check again. | עדיין מחכים? אם סיימתם ב־Google, אפשר להקיש על "לבדוק שוב". | Всё ещё ждёте? Если вы закончили в Google, нажмите «Проверить снова». |
| `oauth.expired.title` (new) | This link has expired | הקישור הזה כבר לא בתוקף | Срок действия ссылки истёк |
| `oauth.expired.body` (new) | Each Google connection needs a fresh link. Start again from FamCal. | כל חיבור ל־Google צריך קישור חדש. אפשר להתחיל מחדש מתוך FamCal. | Для каждого подключения Google нужна новая ссылка. Начните заново в FamCal. |
| `oauth.denied.title` (new) | Google wasn't connected | Google לא חובר | Google не подключён |
| `oauth.denied.body` (new) | You can connect it any time from FamCal's menu. | אפשר לחבר אותו בכל זמן מהתפריט של FamCal. | Подключить его можно в любой момент из меню FamCal. |
| `oauth.generic.title` (new) | Couldn't connect Google | לא הצלחנו לחבר את Google | Не удалось подключить Google |
| `oauth.generic.body` (new) | Something went wrong on our side. Start again from FamCal in a minute. | משהו השתבש אצלנו. אפשר להתחיל מחדש מתוך FamCal בעוד דקה. | Что-то пошло не так на нашей стороне. Через минуту начните заново в FamCal. |
| `oauth.noRefreshToken.title` (new) | Connect again | צריך להתחבר שוב | Подключитесь снова |
| `oauth.noRefreshToken.body` (new) | Google didn't finish giving access. Start again from FamCal and allow access on Google's screen. | Google לא סיים לתת גישה. אפשר להתחיל מחדש מתוך FamCal ולאשר גישה במסך של Google. | Google не завершил выдачу доступа. Начните заново в FamCal и разрешите доступ на экране Google. |
| `oauth.backToFamcal` (new) | Back to FamCal | חזרה ל־FamCal | Вернуться в FamCal |
| `oauth.insufficientScopes.title` | Tick both boxes | צריך לסמן את שתי התיבות | Отметьте оба пункта |
| `oauth.insufficientScopes.description` | FamCal needs <b>both</b> permissions. | FamCal צריך את <b>שתי</b> ההרשאות. | FamCal нужны <b>оба</b> разрешения. |
| `oauth.insufficientScopes.checkAll` | On Google's screen, tick every box: | במסך של Google מסמנים את כל התיבות: | На экране Google отметьте все пункты: |
| `oauth.insufficientScopes.viewCalendarDesc` | for your summaries | לסיכומים | для сводок |
| `oauth.insufficientScopes.editEventsDesc` | to add events by voice | כדי להוסיף אירועים בקול | чтобы добавлять события голосом |
| `oauth.insufficientScopes.footnote` | Without both, FamCal can't show your Google calendars or add events to them. | בלי שתיהן FamCal לא יכול להציג את יומני Google או להוסיף להם אירועים. | Без обоих разрешений FamCal не сможет показывать календари Google и добавлять в них события. |
| `oauth.insufficientScopes.tryAgain` | Try again | לנסות שוב | Попробовать снова |

`description` is read with `t.rich` (`b: (chunks) => <b>{chunks}</b>`); `dangerouslySetInnerHTML` goes. `oauthComplete.*` keep their text.

- [ ] Add/replace the keys; parity, `smoke-he-neutral.ts` (with the `refreshToken`/`oauth` exemptions removed), `smoke-ru-formal.ts`. Commit `feat(google-connect): the connect pages' words in natural Hebrew and formal Russian`.

### Task 2: The shared shell

**Files:** create the shell (e.g. `app/(connect)/…` route group with one root layout, or a `ConnectShell` server component the three pages render — choose after reading inventory §7.1 and Next 16's root-layout rules; route groups don't change URLs, so `proxy.ts` and `app/robots.ts` need no change); replace `app/refresh-token/layout.tsx` and the hand-made `<html>` documents of `app/oauth-callback/page.tsx` and `app/oauth-complete/OAuthCompleteClient.tsx`.

The shell must: set `lang` and `dir` on `<html>` for the page's language (refresh-token: the user's language as today; oauth-callback: the user's language once known, else the `Accept-Language` header through `normalizeLocale`, else English; oauth-complete: `?locale`); load the app's global CSS (`app/globals.css`, which defines the `--bg-white`/`--text-primary` fallbacks the kit's tokens use outside Telegram — or give the kit literal fallbacks, inventory §7.1); provide `NextIntlClientProvider` with `ui`, `pageGate` and the page's own namespaces; load `telegram-web-app.js` only for `/refresh-token` (`beforeInteractive`, as today), not on the two browser pages; keep `robots` noindex as today.

- [ ] Test first (`scripts/smoke-connect-screens.ts`, new): each page's document has the right `lang`/`dir` in en/he/ru, the globals are loaded, the Telegram script is on refresh-token only. Then build the shell; run `npx next build` once to prove the layout tree builds. Commit `feat(google-connect): one shell for the connect pages`.

### Task 3: The three pages

**`/refresh-token`** (`RefreshTokenClient.tsx`, `page.tsx`): `AppScreen` (plain ground) with `ScreenHeader` (back: Telegram's BackButton and the header's back go to `/${locale}/dashboard?user_id=…` with a full page load; drop `window.history.back()` and the English `aria-label="Go back"`), a hero (a lucide icon, the title, the subtitle: the connect or reconnect copy as `page.tsx` picks today), a `FormCard` with the three steps as a numbered list (`stepsTitle` as its `SectionLabel`; they are a sequence, so numbers are right), then one primary `ch-btn` `button` (disabled with a spinner and `preparing` while the Google URL is being made). States:
- start failed on first load: `Notice tone="error"` with `startErrorLines`' text and the action `retry` (calls `/api/oauth/start` again; today there is no retry);
- waiting: `Notice` (status) with `waitingTelegram`/`waitingWhatsApp` and the action `checkAgain` (one immediate check); when the 3-minute poll window ends without a token, the notice adds `stillWaiting` (today polling just stops silently);
- checking: the app's loader with `checking` (no white overlay);
- success: navigates as today.
Keep the `translations` prop contract or move to `useTranslations` and update #15/#15b in the same commit.

**`/oauth-callback`** (server page): every non-success state is one `StateCard` page in the shell (the app look, translated, with an action link):
- missing/invalid state, state not found, reused or expired, user not found → `oauth.expired` (one card: it is the same situation for the person), action `backToFamcal` → the retry target `retryHrefFor` gives today (Telegram owner: the bot link; WhatsApp-only: `/refresh-token?user_id=…`; unknown user: the bot link);
- token exchange threw, saving the token failed → `oauth.generic` (the exception logged as today; never `error.message` on the page), action `backToFamcal`;
- Google refused the code → `oauth.exchangeFailed` (as today, now in the kit);
- missing scopes → the scopes card: `StateCard` title + `t.rich` description + a `FormCard` with the two permissions as rows (label + hint) + `footnote` + the action `tryAgain`;
- no refresh token → `oauth.noRefreshToken` with `backToFamcal` (replacing the English-only page);
- success → the redirect to `/oauth-complete` exactly as today.

**`/api/refresh-token`** (Google's redirect URI): when `code` is missing — Google's deny (`?error=access_denied&state=…`) or any other — redirect to `/oauth-callback?error=<google's error or 'missing_code'>&state=…` instead of answering JSON, and the callback shows `oauth.denied` for `access_denied` (else `oauth.expired`), with `backToFamcal`.

**`/oauth-complete`** (`OAuthCompleteClient.tsx`): `AppScreen`; before the fragment is read, the app loader (not an empty card); ready: a success icon (lucide `CircleCheck`), `title`, `subtitle`, the owner line as a `Notice` (info), then the buttons — Telegram as the primary `ch-btn`, WhatsApp as `ch-btn-outline` with `whatsappHint` under it — each shown per `b=` as today; incomplete: `StateCard` `incompleteTitle`/`incompleteBody`. `{name}` through next-intl's ICU (no hand `.replace`).

Steps:
- [ ] **Step 1:** extend `scripts/smoke-connect-screens.ts` with the review-focus cases and each state above in en/he/ru, light and dark: no English in he/ru, no raw error text (feed the callback an exception whose message is "secret-detail" and assert it is absent), the deny redirect and card, the loader before the fragment, the retry and check-again actions, the poll timeout line, Back's target. Run it: it fails.
- [ ] **Step 2:** build the pages and the API change; update the smokes named in Global Constraints in the same commits.
- [ ] **Step 3:** run the new smoke, `smoke-google-connect.ts`, `smoke-miniapp-gate.ts`, `smoke-auth-leftovers.ts`, `smoke-key-rotation.ts`, `smoke-auth-identity.ts`, `smoke-app-ui.ts`, parity, he-neutral, ru-formal, tsc, eslint, `bash scripts/ci-smokes.sh`, and the CI mirror on your last commit (it runs `next build`).
- [ ] **Step 4:** screenshots (`scratchpad/w4-3-shots/`): refresh-token reconnect he dark (inside-Telegram look) and connect en light (browser), the waiting state with Check again, the expired card ru light, the scopes card he dark, the deny card en dark, oauth-complete ready en light and he dark.
- [ ] **Step 5:** mutation-check the main behaviours; commit.

### Task 4: Clean-up and docs

- [ ] Delete what nothing uses any more (grep first): the old hand-made error-page components in oauth-callback, any `telegram-web-app.js` tags on the two browser pages, keys left unread.
- [ ] Update the status line of `docs/superpowers/specs/2026-10-19-screens-and-colours-design.md`: W4 done, every Mini App and connect page is in the app design. Commit `docs(google-connect): …`.
