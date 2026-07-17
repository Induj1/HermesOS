/**
 * A small HTML parser and CSS-subset selector engine.
 *
 * This is the part of the fake browser that has real logic, so it lives on its
 * own as pure functions of strings and trees — parsed once, queried many times,
 * and tested exhaustively (`dom.test.ts`) without a browser or a network. It is
 * deliberately a *subset*: enough of HTML and CSS selectors to drive the forms,
 * links, and elements an agent interacts with, and no more. A page that needs a
 * full HTML5 parser or `:nth-child(2n+1)` is out of scope, and the RFC says so.
 *
 * ## What the parser handles
 *
 * Tags, attributes (quoted, unquoted, and boolean), text, comments, the doctype,
 * void elements (`<img>`, `<input>`, …), and raw-text elements (`<script>`,
 * `<style>`, `<textarea>`) whose contents are taken verbatim. Malformed HTML is
 * parsed leniently — an unclosed tag is closed at its parent's end — because a
 * test fixture that is slightly wrong should still be usable, the way a browser
 * would.
 *
 * ## What the selector engine handles
 *
 * Compound selectors — `input#name.klass[type="text"]` — joined by the descendant
 * combinator (whitespace). Attribute matches support presence (`[disabled]`) and
 * equality (`[name="q"]`). Plus one Playwright-ism: a leading `text=` selector
 * matches by trimmed text content, which is how a model most naturally points at
 * a button.
 */

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

export interface DomElement {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly children: DomElement[];
  /** Direct text content (text nodes are folded into their parent element). */
  text: string;
  parent: DomElement | undefined;
}

/** Create a detached element. Exported so the fake can synthesise DOM on mutation. */
export function element(tag: string, attrs: Record<string, string> = {}): DomElement {
  return { tag: tag.toLowerCase(), attrs, children: [], text: '', parent: undefined };
}

/**
 * Parse an HTML string into a root element (`<#document>`), leniently.
 *
 * The root is a synthetic element holding the top-level nodes, so a caller always
 * has a single tree to query regardless of how many roots the fragment had.
 */
export function parseHtml(html: string): DomElement {
  const root = element('#document');
  const stack: DomElement[] = [root];
  let i = 0;

  const current = (): DomElement => stack[stack.length - 1] ?? root;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      appendText(current(), html.slice(i));
      break;
    }
    if (lt > i) appendText(current(), html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    const gt = findTagEnd(html, lt + 1);
    if (gt === -1) {
      appendText(current(), html.slice(lt));
      break;
    }
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      // Pop to the nearest matching open tag; ignore a stray close.
      const idx = findOpen(stack, name);
      if (idx !== -1) stack.length = idx;
      continue;
    }

    const { tag, attrs, selfClosing } = parseTag(raw);
    const el = element(tag, attrs);
    const parent = current();
    el.parent = parent;
    parent.children.push(el);

    if (selfClosing || VOID_TAGS.has(tag)) continue;

    if (RAW_TEXT_TAGS.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      const end = close === -1 ? html.length : close;
      el.text = html.slice(i, end);
      const after = html.indexOf('>', end);
      i = after === -1 ? html.length : after + 1;
      continue;
    }
    stack.push(el);
  }

  return root;
}

function appendText(el: DomElement, text: string): void {
  el.text += text;
}

/** Find the `>` that closes a tag opened at `from`, skipping quoted attributes. */
function findTagEnd(html: string, from: number): number {
  let quote = '';
  for (let j = from; j < html.length; j += 1) {
    const ch = html[j];
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return j;
    }
  }
  return -1;
}

function findOpen(stack: DomElement[], name: string): number {
  for (let i = stack.length - 1; i > 0; i -= 1) {
    if (stack[i]?.tag === name) return i;
  }
  return -1;
}

function parseTag(raw: string): {
  tag: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
} {
  let body = raw.trim();
  const selfClosing = body.endsWith('/');
  if (selfClosing) body = body.slice(0, -1).trim();

  const space = body.search(/\s/);
  const tag = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const attrs: Record<string, string> = {};
  if (space === -1) return { tag, attrs, selfClosing };

  const attrRe = /([^\s=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s]+)))?/g;
  let m: RegExpExecArray | null;
  const rest = body.slice(space);
  while ((m = attrRe.exec(rest)) !== null) {
    const name = m[1]?.toLowerCase();
    if (name === undefined || name === '') continue;
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    attrs[name] = value;
  }
  return { tag, attrs, selfClosing };
}

// ── querying ──────────────────────────────────────────────────────────────────

interface Compound {
  readonly tag?: string;
  readonly id?: string;
  readonly classes: readonly string[];
  readonly attrs: readonly { name: string; value?: string }[];
}

/** The trimmed, whitespace-collapsed text of an element and its descendants. */
export function textContent(el: DomElement): string {
  let out = el.text;
  for (const child of el.children) out += ' ' + textContent(child);
  return out.replace(/\s+/g, ' ').trim();
}

export function getAttribute(el: DomElement, name: string): string | undefined {
  return el.attrs[name.toLowerCase()];
}

/** All elements under `root` matching the selector, in document order. */
export function querySelectorAll(root: DomElement, selector: string): DomElement[] {
  const groups = splitList(selector);
  if (groups.length > 1) {
    // A selector list (`a, b, c`): union the matches, deduplicated and in
    // document order.
    const matched = new Set<DomElement>();
    for (const group of groups) {
      for (const el of querySelectorAll(root, group)) matched.add(el);
    }
    return descendants(root).filter((el) => matched.has(el));
  }

  const trimmed = selector.trim();
  if (trimmed.startsWith('text=')) {
    const wanted = unquote(trimmed.slice(5)).trim();
    // The *innermost* elements whose text equals — an ancestor wrapping only this
    // element has the same text, and matching it too would return the wrapper
    // first. So exclude an element if a child already matches.
    return descendants(root).filter(
      (el) =>
        textContent(el) === wanted &&
        !el.children.some((c) => textContent(c) === wanted),
    );
  }

  const parts = splitDescendant(trimmed).map(parseCompound);
  if (parts.length === 0) return [];
  const last = parts[parts.length - 1];
  if (last === undefined) return [];

  return descendants(root).filter(
    (el) => matchesCompound(el, last) && matchesAncestors(el, parts),
  );
}

/** Split a selector list on top-level commas (not inside `[...]`). */
function splitList(selector: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of selector) {
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      if (buf.trim() !== '') groups.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim() !== '') groups.push(buf.trim());
  return groups;
}

/** The first element matching the selector, or undefined. */
export function querySelector(
  root: DomElement,
  selector: string,
): DomElement | undefined {
  return querySelectorAll(root, selector)[0];
}

function descendants(root: DomElement): DomElement[] {
  const out: DomElement[] = [];
  const walk = (el: DomElement): void => {
    for (const child of el.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function matchesAncestors(el: DomElement, parts: Compound[]): boolean {
  let i = parts.length - 2;
  let node = el.parent;
  while (i >= 0 && node !== undefined) {
    const part = parts[i];
    if (part !== undefined && matchesCompound(node, part)) i -= 1;
    node = node.parent;
  }
  return i < 0;
}

function matchesCompound(el: DomElement, c: Compound): boolean {
  if (c.tag !== undefined && c.tag !== '*' && el.tag !== c.tag) return false;
  if (c.id !== undefined && getAttribute(el, 'id') !== c.id) return false;
  const classes = (getAttribute(el, 'class') ?? '')
    .split(/\s+/)
    .filter((x) => x !== '');
  for (const klass of c.classes) {
    if (!classes.includes(klass)) return false;
  }
  for (const attr of c.attrs) {
    const value = getAttribute(el, attr.name);
    if (value === undefined) return false;
    if (attr.value !== undefined && value !== attr.value) return false;
  }
  return true;
}

/** Split on descendant whitespace, but not inside `[...]`. */
function splitDescendant(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of selector) {
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (buf !== '') parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf !== '') parts.push(buf);
  return parts;
}

function parseCompound(part: string): Compound {
  let tag: string | undefined;
  let id: string | undefined;
  const classes: string[] = [];
  const attrs: { name: string; value?: string }[] = [];

  const re = /([.#]?)([a-zA-Z0-9_*-]+)|\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(part)) !== null) {
    if (m[3] !== undefined) {
      const eq = m[3].indexOf('=');
      if (eq === -1) attrs.push({ name: m[3].trim().toLowerCase() });
      else
        attrs.push({
          name: m[3].slice(0, eq).trim().toLowerCase(),
          value: unquote(m[3].slice(eq + 1).trim()),
        });
      continue;
    }
    const prefix = m[1];
    const name = m[2];
    if (name === undefined) continue;
    if (prefix === '#') id = name;
    else if (prefix === '.') classes.push(name);
    else tag = name.toLowerCase();
  }
  return {
    ...(tag === undefined ? {} : { tag }),
    ...(id === undefined ? {} : { id }),
    classes,
    attrs,
  };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Serialize an element back to HTML — used by screenshots and debugging. */
export function serialize(el: DomElement): string {
  if (el.tag === '#document') return el.children.map(serialize).join('');
  const attrs = Object.entries(el.attrs)
    .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${v}"`))
    .join('');
  if (VOID_TAGS.has(el.tag)) return `<${el.tag}${attrs}>`;
  const inner = el.text + el.children.map(serialize).join('');
  return `<${el.tag}${attrs}>${inner}</${el.tag}>`;
}
