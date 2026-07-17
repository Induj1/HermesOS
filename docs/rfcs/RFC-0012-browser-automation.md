# RFC-0012: Browser Automation

| Field         | Value                                                         |
| ------------- | ------------------------------------------------------------- |
| Status        | Implemented (fake backend complete; real browser gated)       |
| Date          | 2026-07-17                                                    |
| Scope         | `packages/tools-browser` (`@hermes/tools-browser`)            |
| Depends on    | RFC-0001 (kernel), RFC-0006 (tool framework), RFC-0009 (HTTP) |
| Supersedes    | —                                                             |
| Superseded by | —                                                             |

Design record for browser automation. Like the GitHub integration, this is a
credential-/runtime-gated subsystem built to be **fully verifiable without the
gated dependency** — here, a real browser. The whole thing runs against a
high-fidelity fake, and the line to live verification (§8) is exactly one
backend swap.

Covered by 99 tests in `packages/tools-browser/tests`.

---

## 1. Context

An autonomous engineer needs to use the web the way a person does: open a page,
read it, fill a form, click through, wait for something to load, upload a file,
handle a dialog, work across tabs. That is what a browser-automation driver
(Playwright, Puppeteer) provides — and it is heavyweight: a real Chromium, a
native protocol, a runtime this build cannot assume is present.

So the subsystem is designed around a constraint: **it must be complete and
testable without a real browser**, with a real browser as a drop-in backend for
live use. Two decisions make that work.

## 2. The organising principles

> **The backend is swappable, and navigation goes through the shared HTTP
> layer.**

**Swappable backend.** The tools depend only on a Playwright-shaped port
(`Browser` → `BrowserContext` → `Page`). {@link FakeBrowser} implements it; a
future `PlaywrightBrowser` implements the same interface. Nothing above the port
knows which is underneath, so the fake is not a mock of the real thing — it _is_
a backend, and the real one is just another (§6).

**HTTP through the shared layer.** A page's content is fetched over an injected
`@hermes/tools-http` `HttpClient`. So navigation is not a second network stack —
it inherits the HTTP package's timeout, response-size cap, redirect handling,
and, when wrapped in `guarded`, its SSRF policy. A `goto` to an internal address
is refused by the same policy that guards `http.get`, and a navigation redirect
is followed and re-checked on every hop. This is why "the browser preserves the
HTTP guarantees" is a tested fact: the tests navigate through a real `guarded`
client.

## 3. The port

`Browser.newContext()` opens an isolated `BrowserContext` (its own cookies and
pages); `context.newPage()` opens a `Page`. `Page` carries the operations an
agent needs: `goto`/`reload`/`goBack`,
`content`/`title`/`textContent`/`getAttribute`/ `isVisible`,
`click`/`fill`/`type`/`press`/`selectOption`/`check`/`setInputFiles`,
`waitForSelector`, `onDialog`/`waitForDownload`, and `screenshot`. Every method
is `Promise`-based and `signal`-aware, because cancellation is real in a driver
and a tool must be able to abandon a hung page.

## 4. The fake browser and its DOM protocol

{@link FakeBrowser} simulates a browser with no JS engine:

- **DOM.** A small, pure HTML parser and CSS-subset selector engine (`dom.ts`)
  parse fetched HTML and answer `querySelector`. The selector engine supports
  compound selectors, the descendant combinator, selector lists, and a `text=`
  selector. It is a documented _subset_ — no HTML5 implicit-close, no
  `:nth-child` — and the parser is lenient (unclosed tags close at their
  parent).
- **Behaviours a real browser drives with JavaScript** are expressed with
  `data-fk-*` attributes the fake interprets, so a fixture is self-contained:
  `data-fk-dialog="confirm:…"` (a click raises a dialog), `data-fk-appear-after`
  (an element becomes visible after N virtual ms, for `waitForSelector`),
  `data-fk-add-on-click` / `data-fk-remove-on-click` (an in-place DOM mutation),
  and `download` on a link (a download rather than a navigation). A real backend
  ignores these and uses actual JS; the tools work against either.
- **Waits are deterministic.** There is no real timer. `waitForSelector`
  advances a _virtual_ clock to the next moment an element could appear, capped
  at the timeout — so a "wait 500ms then appear" test is instant and never
  flaky, and cancellation is checked each iteration.
- **Everything else is real state**: history (for `goBack`), form submission
  (GET → query string, POST → body, through the HTTP client), keyboard input
  (`fill`/`type`/`press`-to-submit), file attachments, multiple tabs
  (`target="_blank"` opens one), isolated contexts, and deterministic
  screenshots (a PNG signature plus a hash of the rendered HTML, so identical
  DOM yields identical bytes).

## 5. Sessions and tools

Kernel tools are stateless, but a browser is stateful: navigate, then click,
then read all act on one page. {@link BrowserSession} holds that state — it
lazily opens a context and first page, tracks tabs, and hands the active page to
each tool. The tools split three ways by permission:

- **`browser:read`** — content, text, attribute, title, visibility, waits,
  screenshots, tab listing.
- **`browser:navigate`** — navigate, back, reload, open/switch tabs. A URL an
  agent visits is a network request under the SSRF policy.
- **`browser:interact`** — click, fill, type, press, select, check, upload.

The default grant is `read` + `navigate`; interaction is an explicit escalation.

## 6. Swapping in a real browser

A real backend implements `Browser`/`BrowserContext`/`Page` over Playwright. The
one design question is navigation: Playwright has its own network stack, so it
would not fetch through the `HttpClient`. The intended answer is to route
Playwright through a proxy that applies the same host policy, or to enforce the
policy on the URLs the tools pass to `goto` before handing them over — so the
SSRF guarantee holds regardless of backend. The fake takes the simpler road (it
literally fetches over the `HttpClient`), which is the road that makes the
guarantee testable here.

## 7. Testing

- **`dom`** — the parser and selectors, pure, across quoting, void/raw-text
  elements, comments, lenient recovery, and every selector form.
- **`fake-browser`** — every simulated behaviour, with navigation through a real
  `guarded` HTTP client: navigation, redirects, network failure, history, links,
  in-place DOM updates, GET/POST forms, keyboard, waits (virtual time), dialogs,
  downloads, uploads, screenshots, tabs, contexts, and cancellation.
- **`tools` / `toolset`** — each tool through the port, and the permission split
  enforced on a real `Runtime`.

Branch coverage is 95.1%, above the enforced 95% floor. The few uncovered
branches are unreachable defensive guards.

## 8. What needs a real browser

The implementation is complete against the fake. What is unverified, and only
what is unverified, needs a real browser runtime:

- **A `PlaywrightBrowser` backend** implementing the port over real Chromium —
  to confirm the port shape matches Playwright's and that real pages behave as
  the fake models them (real CSS visibility, real JS-driven DOM updates, real
  dialogs and downloads).
- **JavaScript-driven behaviour** the fake approximates with `data-fk-*`
  directives — a real SPA's client-side rendering, real `waitForSelector`
  against a live mutation, real file-chooser and dialog events.

Neither is a code gap in the tools or the port. They are the parts whose
fidelity can only be confirmed against a browser. A `PlaywrightBrowser`
implementing the same `Browser` interface is the whole of the remaining work —
see STATUS.md.

## 9. Known limitations

- **The DOM/selector engine is a subset** (§4): no HTML5 implicit closing, a
  limited CSS grammar, and text nodes fold into their parent (interleaving order
  is not preserved). This is sufficient for form-and-link automation and
  documented as a limit, not a defect.
- **No JavaScript execution.** The fake cannot run page scripts; JS-driven
  behaviour is simulated via the `data-fk-*` protocol. A real backend removes
  this limit.
- **SSRF enforcement for a real backend is a wiring concern** (§6), not
  automatic the way it is for the fake.
