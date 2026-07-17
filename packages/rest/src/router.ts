/**
 * The router — match a method and path to a handler, capturing path parameters.
 *
 * Patterns are segment-based: a literal segment matches itself, `:name` captures
 * one segment into `params.name`, and a trailing `*` captures the rest of the
 * path into `params['*']` (for a proxy or a file route). Matching is pure — a
 * `(method, path) → { handler, params } | undefined` — so the whole routing table
 * is testable without a request.
 *
 * Routes are tried in registration order, first match wins; a static route
 * registered before a `:param` one therefore takes precedence, which is the
 * predictable behaviour (no "most specific wins" magic that surprises).
 */

import type { Handler, HttpMethod } from './types.js';

interface Route {
  readonly method: HttpMethod;
  readonly segments: readonly Segment[];
  readonly handler: Handler;
}

type Segment =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'param'; readonly name: string }
  | { readonly kind: 'wildcard' };

export interface RouteMatch {
  readonly handler: Handler;
  readonly params: Record<string, string>;
}

export class Router {
  readonly #routes: Route[] = [];

  /** Register a handler for a method and path pattern. */
  add(method: HttpMethod, pattern: string, handler: Handler): this {
    this.#routes.push({ method, segments: compile(pattern), handler });
    return this;
  }

  /**
   * Find the handler for a request, or undefined.
   *
   * Also reports whether the path matched *any* method — so the application can
   * answer `405 Method Not Allowed` (path exists, wrong verb) distinctly from
   * `404` (no such path).
   */
  match(method: HttpMethod, path: string): RouteMatch | undefined {
    const segments = splitPath(path);
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, segments);
      if (params !== undefined) return { handler: route.handler, params };
    }
    return undefined;
  }

  /** Whether any route (any method) matches the path — for a 404-vs-405 decision. */
  pathExists(path: string): boolean {
    const segments = splitPath(path);
    return this.#routes.some(
      (route) => matchSegments(route.segments, segments) !== undefined,
    );
  }

  /** The methods registered for a path — for an `Allow` header on a 405. */
  allowedMethods(path: string): readonly HttpMethod[] {
    const segments = splitPath(path);
    const methods = new Set<HttpMethod>();
    for (const route of this.#routes) {
      if (matchSegments(route.segments, segments) !== undefined)
        methods.add(route.method);
    }
    return [...methods];
  }
}

function compile(pattern: string): Segment[] {
  return splitPath(pattern).map((part) => {
    if (part === '*') return { kind: 'wildcard' };
    if (part.startsWith(':')) return { kind: 'param', name: part.slice(1) };
    return { kind: 'literal', value: part };
  });
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

/** Match compiled segments against a path's segments, returning captured params or undefined. */
function matchSegments(
  segments: readonly Segment[],
  path: readonly string[],
): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === undefined) return undefined;
    if (segment.kind === 'wildcard') {
      params['*'] = path.slice(i).join('/');
      return params;
    }
    const part = path[i];
    if (part === undefined) return undefined;
    if (segment.kind === 'literal') {
      if (segment.value !== part) return undefined;
    } else {
      params[segment.name] = decodeURIComponent(part);
    }
  }
  // Every pattern segment consumed; the path must be exactly as long.
  return path.length === segments.length ? params : undefined;
}
