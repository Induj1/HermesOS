# RFC-0034: Telegram Interface

| Field         | Value                                    |
| ------------- | ---------------------------------------- |
| Status        | Implemented (🔑 live verification)       |
| Date          | 2026-07-18                               |
| Scope         | `packages/telegram` (`@hermes/telegram`) |
| Depends on    | `@hermes/tools-http`, `@hermes/kernel`   |
| Supersedes    | —                                        |
| Superseded by | —                                        |

Design record for the Telegram interface: Bot API client, long-poll dispatcher,
webhook verification, and a fake server.

Covered by 32 tests in `packages/telegram/tests`.

---

## 1. Context

Telegram is a chat interface to Hermes, alongside REST (#24) and the CLI (#25).
It is **credential-gated**: it needs a bot token from @BotFather to talk to the
real API. Following the same discipline as GitHub (#12) and the browser (#13),
the entire subsystem is built and tested against a **high-fidelity fake** — only
the live round-trip is deferred, and it needs only a token.

The package has four parts: a typed **client** over the Bot API, a **bot**
dispatcher that routes messages to handlers and drives the long-poll loop,
**webhook** verification for the push alternative, and the **fake server** the
whole thing is tested on.

## 2. The client

`TelegramClient` speaks the Bot API — `POST {baseUrl}/bot{token}/{method}` with
a JSON body, answering `{ ok, result }` or
`{ ok: false, error_code, description }` — over an **injected `HttpClient`**
(from `@hermes/tools-http`). Injecting the transport is what makes it testable
against `FakeHttpClient`; it also means the SSRF-guarded, size-capped shared
client is reused rather than a second HTTP path.

Two failures are handled deliberately: a non-`ok` body becomes a `TelegramError`
carrying the API `error_code`, and a transport failure becomes a `TelegramError`
with code `0`. Critically, **the error message never contains the request URL**
— which holds the bot token — so a logged error cannot leak the credential (a
test asserts the token never appears in the message).

## 3. The bot

`TelegramBot` maps an incoming message to a **command** handler (`/name`, or
`/name@thisbot` in a group — the bot's own username is stripped, and a command
addressed to a different bot is ignored) or a **text** fallback. The dispatch
(`processUpdates`) is a plain function of the updates it is given, so a test
drives it directly with no polling.

The offset is the load-bearing detail: after processing update _N_, the next
`getUpdates` uses `offset = N+1`, which acknowledges everything up to _N_ so it
is never redelivered — and the bot advances the offset for **every** update,
handled or not, so an unrouted message does not wedge the loop by being fetched
forever. `run(clock, { signal })` layers the loop on top, sleeping between polls
via the injected `Clock` so a test advances a `TestClock` instead of waiting and
aborts through the signal.

## 4. Webhooks

For the push alternative, `verifyWebhook(headers, secret)` checks the
`X-Telegram-Bot-Api-Secret-Token` header Telegram echoes on every delivery,
**constant-time** (so the check does not leak the secret through timing) and
case-insensitively. `parseUpdate` turns a delivery body into a typed update, or
`undefined` for anything malformed, so a bad POST is rejected rather than
throwing.

## 5. The fake server

`FakeTelegramServer` exposes a `handler` for `FakeHttpClient` and behaves like
the real API over the wire: it routes `/bot{token}/{method}`, rejects a wrong
token with a `401`, answers `getMe`/`sendMessage`/`getUpdates` with the real
envelope, and honours the `offset` acknowledgement. Tests enqueue inbound
messages and assert on `sent`, so a whole conversation — including a bad token
and an unknown method — runs deterministically with no network.

## 6. Live verification (🔑)

What needs a real **bot token** to confirm: a live `getMe`/`sendMessage`/
`getUpdates` round-trip against `api.telegram.org` (wire shape and error
bodies), and a real signed **webhook** delivery. None are code gaps — supply a
`FetchHttpClient` and a token. See STATUS.md.

## 7. Non-goals

- **No rich message types.** Text messages in and out; photos, keyboards, and
  inline queries are additive fields on the same client, not part of this core.
- **No conversation state.** The bot routes each message independently; a
  stateful conversation (a wizard) is an application concern layered on
  handlers.
- **No webhook HTTP server.** `verifyWebhook`/`parseUpdate` are the pieces a
  `@hermes/rest` route composes; standing up the endpoint is the host's job.

## 8. Testing

32 tests: the client's `getMe`/`sendMessage`/`getUpdates` (incl. optional params
and offset), and its error handling (bad token with code, token never leaked,
transport failure incl. non-`Error`, non-JSON body, trailing-slash base URL);
the bot's command routing, arg parsing, `@username` targeting, text fallback,
no-text and lone-`/` messages, offset non-redelivery, and the `run` loop
(abort-during-sleep, sleep-completes-then-poll, already-aborted); webhook verify
and parse; and the fake server's own edge cases. 99% branch coverage (100%
lines/functions).
