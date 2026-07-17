# @hermes/tools-browser

Drive a web browser from an agent — backend-independent, and fully testable
without a real browser.

- **Design record:** [RFC-0012](../../docs/rfcs/RFC-0012-browser-automation.md).
- **Depends on:** `@hermes/tools`, `@hermes/kernel`, and `@hermes/tools-http`
  (its `HttpClient` is the injected transport for navigation).

## Two ideas

- **The backend is swappable.** The tools depend only on a Playwright-shaped
  port (`Browser` → `BrowserContext` → `Page`). `FakeBrowser` implements it with
  no real browser; a real Playwright/Chromium driver is just another `Browser`.
- **Navigation goes through the HTTP layer.** A page's content is fetched over
  an injected `@hermes/tools-http` `HttpClient`, so redirects, timeouts, the
  SSRF policy, and network failures all flow through the shared, hardened
  networking. Wrap the client in `guarded` and the browser inherits SSRF
  protection.

## Usage

```ts
import { browserToolset, FakeBrowser } from '@hermes/tools-browser';
import { FetchHttpClient, guarded } from '@hermes/tools-http';
import { PermissionSet } from '@hermes/tools';

const http = guarded(new FetchHttpClient(), {
  policy: { allowHosts: ['example.com'] },
});

runtime.use(
  browserToolset({
    browser: new FakeBrowser({ http }),
    granted: PermissionSet.none()
      .grant('browser:read')
      .grant('browser:navigate')
      .grant('browser:interact'),
  }),
);
```

`granted` defaults to **read + navigate**; interaction (clicking, typing,
uploading) is `browser:interact`, an explicit escalation.

## The tools

| Permission         | Tools                                                                            |
| ------------------ | -------------------------------------------------------------------------------- |
| `browser:read`     | `content` `title` `text` `attribute` `visible` `waitFor` `screenshot` `listTabs` |
| `browser:navigate` | `navigate` `back` `reload` `newTab` `switchTab`                                  |
| `browser:interact` | `click` `fill` `type` `press` `select` `check` `upload`                          |

All the tools share one `BrowserSession`, so a mission's navigate → fill → click
sequence acts on the same live page.

## Testing against the fake

`FakeBrowser` simulates a browser with no JS engine: a small HTML parser and
selector engine, navigation over the injected `HttpClient`, and a `data-fk-*`
attribute protocol for behaviours a real browser drives with JavaScript.

```ts
import { FakeBrowser } from '@hermes/tools-browser';
import { FakeHttpClient, guarded } from '@hermes/tools-http';

const http = guarded(
  new FakeHttpClient({
    handle: (req) => ({
      status: 200,
      body: pageFor(req.url),
      headers: { 'content-type': 'text/html' },
    }),
  }),
  { policy: { blockPrivate: false } },
);
const browser = new FakeBrowser({ http });
const page = await (await browser.newContext()).newPage();
await page.goto('https://example.com');
await page.fill('#q', 'hello');
await page.click('button[type=submit]');
```

The `data-fk-*` fixture protocol:

- `data-fk-dialog="confirm:Delete?"` — a click raises that dialog.
- `data-fk-appear-after="500"` — the element becomes visible after 500 (virtual)
  ms, for exercising `waitForSelector` deterministically.
- `data-fk-add-on-click="<p>hi</p>"` / `data-fk-remove-on-click="#gone"` — an
  in-place DOM mutation (an SPA update).
- `download` on an `<a>` — a click downloads the href instead of navigating.

Waits use a **virtual clock**: no real timers, so a delayed-appearance test is
instant and never flaky.

## What needs a real browser

Everything above works against the fake. Live verification needs a real runtime:
a `PlaywrightBrowser` implementing the same `Browser` port over Chromium, to
confirm the port matches Playwright and that real pages (real CSS visibility,
real JS-driven updates, real dialogs/downloads) behave as the fake models them.
That backend is the whole of the remaining work — see RFC-0012 §8 and STATUS.md.
