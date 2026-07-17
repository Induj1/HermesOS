/**
 * The host policy — the SSRF boundary, and the pure, testable core of it.
 *
 * ## The threat
 *
 * An HTTP tool fetches a URL *chosen by a model*, and a model can be steered by a
 * prompt-injected document. The danger is not a wrong page — it is the model
 * asking for `http://169.254.169.254/latest/meta-data/iam/` (the cloud metadata
 * endpoint that hands out credentials), `http://localhost:6379` (an unauthed
 * internal Redis), or `http://10.0.0.5/admin`. That is Server-Side Request
 * Forgery, and it is the HTTP equivalent of the shell package's command
 * injection: the request runs from *inside* the trust boundary the host lives in.
 *
 * ## The boundary
 *
 * {@link checkUrl} decides whether a URL may be fetched, and it is a **pure
 * function of the URL string and the policy** — no network, no DNS — so the whole
 * SSRF argument reduces to something testable with no server. Three gates:
 *
 * 1. **Scheme.** Only `http` and `https`. `file://`, `ftp://`, `gopher://` are
 *    refused — they are SSRF's favourite protocol-smuggling vectors.
 * 2. **Allowlist**, when set: only these hosts. This is the *strong* guarantee,
 *    and the one to use for untrusted input, because it is immune to DNS
 *    rebinding — a hostname not on the list cannot be reached whatever it
 *    resolves to.
 * 3. **Private-range block**, on by default: loopback, private, and link-local
 *    address *literals*, plus `localhost`. This is the *weaker* guarantee — it
 *    cannot see that a public hostname resolves to a private IP (§ limitation in
 *    RFC-0009) — so it is a safety net, not the primary defence.
 *
 * Redirects are re-checked against this same policy on every hop (see
 * `client.ts`), because a request to an allowed host that redirects to a blocked
 * one would otherwise walk straight through the boundary.
 */

/** Whether a URL is allowed, and if not, why — the "why" is what a caller acts on. */
export type PolicyVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface HostPolicy {
  /**
   * The only hosts allowed, when set. Exact hostname match, case-insensitive.
   *
   * The strong SSRF defence. An empty array allows nothing; an absent allowlist
   * means "any host the other gates permit". Prefer setting it for anything that
   * fetches a URL a model produced.
   */
  readonly allowlist?: readonly string[];
  /**
   * Block loopback, private, and link-local addresses. Default true.
   *
   * The safety net. Turn it off only for a context that genuinely needs to reach
   * a private address *and* has decided the SSRF risk is acceptable — a
   * localhost-only development tool, say. It is on by default because the failure
   * of forgetting it is a credential leak.
   */
  readonly blockPrivate?: boolean;
}

/**
 * May this URL be fetched under this policy?
 *
 * Pure. The one function the SSRF safety of the package rests on, so it takes no
 * client, does no I/O, and is a function of two values that a test can enumerate.
 */
export function checkUrl(rawUrl: string, policy: HostPolicy): PolicyVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `"${rawUrl}" is not a valid URL` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reason: `the "${url.protocol}" scheme is not allowed; only http and https are`,
    };
  }

  const host = url.hostname.toLowerCase();

  if (policy.allowlist !== undefined) {
    const allowed = policy.allowlist.map((h) => h.toLowerCase());
    if (!allowed.includes(host)) {
      return {
        ok: false,
        reason:
          allowed.length === 0
            ? 'no hosts are allowed in this context'
            : `host "${host}" is not on the allowlist (${allowed.join(', ')})`,
      };
    }
  }

  if (policy.blockPrivate !== false && isPrivateHost(host)) {
    return {
      ok: false,
      reason: `host "${host}" is a private or loopback address, which is not allowed`,
    };
  }

  return { ok: true };
}

/**
 * Is this hostname a private, loopback, or link-local address literal?
 *
 * Exported because it is the piece most worth testing on its own — the ranges are
 * a table (RFC 1918, RFC 4193, RFC 3927, …) and a table is exactly what is easy
 * to get one bit wrong in.
 *
 * It recognises *literals* only. `internal.corp.example` that resolves to
 * `10.0.0.1` is not caught here — that needs DNS, which a pure function cannot do,
 * and which is why the allowlist is the real defence for untrusted input.
 */
export function isPrivateHost(host: string): boolean {
  // Named loopback and the various spellings of "this machine".
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (
    host === '' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host === '[::1]'
  ) {
    return true;
  }

  // IPv6 in brackets, or bare. Loopback and unique-local/link-local prefixes.
  const v6 = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (v6.includes(':')) {
    const lower = v6.toLowerCase();
    // `::1` is already handled by the named check above, so it is not repeated
    // here. fc00::/7 (unique local) and fe80::/10 (link local):
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8'))
      return true;
    if (lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'))
      return true;
    return false;
  }

  const octets = host.split('.');
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
    const [a, b] = octets.map(Number) as [number, number, number, number];
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata!)
    if (a === 0) return true; // 0.0.0.0/8
  }

  return false;
}
