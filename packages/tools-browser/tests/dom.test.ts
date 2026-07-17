/**
 * The HTML parser and selector engine — pure, so tested directly and thoroughly.
 */

import { describe, expect, it } from 'vitest';
import {
  parseHtml,
  querySelector,
  querySelectorAll,
  textContent,
  getAttribute,
  serialize,
  element,
  type DomElement,
} from '../src/dom.js';

/** querySelector that throws instead of returning undefined — for test brevity. */
function one(root: DomElement, selector: string): DomElement {
  const el = querySelector(root, selector);
  if (el === undefined) throw new Error(`no element matches ${selector}`);
  return el;
}

describe('parseHtml', () => {
  it('parses nested elements into a tree', () => {
    const root = parseHtml('<div><p>hi</p></div>');
    const div = one(root, 'div');
    expect(div.tag).toBe('div');
    expect(div.children[0]?.tag).toBe('p');
    expect(textContent(div)).toBe('hi');
  });

  it('parses attributes: quoted, single-quoted, unquoted, and boolean', () => {
    const el = one(
      parseHtml('<input type="text" name=q data-x=\'y\' disabled>'),
      'input',
    );
    expect(getAttribute(el, 'type')).toBe('text');
    expect(getAttribute(el, 'name')).toBe('q');
    expect(getAttribute(el, 'data-x')).toBe('y');
    expect(getAttribute(el, 'disabled')).toBe('');
  });

  it('treats void elements as self-closing', () => {
    const root = parseHtml('<div><img src="a.png"><span>after</span></div>');
    const div = root.children[0];
    expect(div?.children.map((c) => c.tag)).toEqual(['img', 'span']);
  });

  it('handles an explicit self-closing tag', () => {
    const root = parseHtml('<br/><p>x</p>');
    expect(root.children.map((c) => c.tag)).toEqual(['br', 'p']);
  });

  it('takes raw-text elements verbatim', () => {
    const el = one(parseHtml('<script>if (a < b) {}</script>'), 'script');
    expect(el.text).toBe('if (a < b) {}');
  });

  it('tolerates an unclosed raw-text element at EOF', () => {
    const el = one(parseHtml('<title>Untitled'), 'title');
    expect(el.text).toBe('Untitled');
  });

  it('skips comments and the doctype', () => {
    const root = parseHtml('<!doctype html><!-- note --><p>x</p>');
    expect(root.children.map((c) => c.tag)).toEqual(['p']);
  });

  it('closes unclosed tags at the parent boundary, leniently', () => {
    // The parser does not implement HTML5 implicit `<p>` closing (a documented
    // subset limit), so the second <p> nests — but both are found, and the
    // enclosing </div> closes whatever is still open.
    const root = parseHtml('<div><p>one<p>two</div><section>after</section>');
    expect(querySelectorAll(one(root, 'div'), 'p')).toHaveLength(2);
    // The </div> popped back to the root, so <section> is a sibling of <div>.
    expect(root.children.map((c) => c.tag)).toEqual(['div', 'section']);
  });

  it('ignores a stray closing tag', () => {
    const root = parseHtml('</span><p>x</p>');
    expect(root.children.map((c) => c.tag)).toEqual(['p']);
  });

  it('parses plain text with no tags', () => {
    expect(textContent(parseHtml('just words'))).toBe('just words');
  });

  it('keeps trailing text after the last tag', () => {
    const root = parseHtml('<p>x</p> and more');
    // Text nodes fold into the parent's text (a documented simplification), so
    // both the child text and the trailing text are present.
    expect(textContent(root)).toContain('and more');
    expect(textContent(root)).toContain('x');
  });

  it('tolerates a tag that is never closed at EOF', () => {
    const root = parseHtml('<div>ok<span');
    // The unterminated `<span` is treated as trailing text, not a tag.
    expect(root.children[0]?.tag).toBe('div');
    expect(textContent(root)).toContain('ok');
  });

  it('tolerates an empty string', () => {
    expect(parseHtml('').children).toHaveLength(0);
  });
});

describe('querySelectorAll', () => {
  const root = parseHtml(`
    <body>
      <header><h1 id="title" class="big head">Welcome</h1></header>
      <main>
        <a href="/a" class="link">A</a>
        <a href="/b" class="link featured">B</a>
        <form><input type="text" name="q"><button type="submit">Go</button></form>
      </main>
    </body>`);

  it('matches by tag', () => {
    expect(querySelectorAll(root, 'a')).toHaveLength(2);
  });

  it('matches by id', () => {
    expect(getAttribute(one(root, '#title'), 'id')).toBe('title');
  });

  it('matches by class, requiring all listed classes', () => {
    expect(querySelectorAll(root, '.link')).toHaveLength(2);
    expect(querySelectorAll(root, '.link.featured')).toHaveLength(1);
  });

  it('matches a compound of tag, id, and class', () => {
    expect(querySelector(root, 'h1#title.big')).toBeDefined();
    expect(querySelector(root, 'h1#title.missing')).toBeUndefined();
  });

  it('matches by attribute presence and equality', () => {
    expect(querySelector(root, '[name]')).toBeDefined();
    expect(querySelector(root, 'input[type="text"]')).toBeDefined();
    expect(querySelector(root, "input[type='text']")).toBeDefined();
    expect(querySelector(root, 'input[type="password"]')).toBeUndefined();
  });

  it('returns nothing for an empty selector', () => {
    expect(querySelectorAll(root, '')).toEqual([]);
  });

  it('matches a descendant combinator', () => {
    expect(querySelectorAll(root, 'main a')).toHaveLength(2);
    expect(querySelectorAll(root, 'header a')).toHaveLength(0);
    expect(querySelector(root, 'form button')).toBeDefined();
  });

  it('matches by text=', () => {
    expect(querySelector(root, 'text=Welcome')?.tag).toBe('h1');
    expect(querySelector(root, 'text=Nope')).toBeUndefined();
  });

  it('returns matches in document order', () => {
    const texts = querySelectorAll(root, 'a').map((a) => textContent(a));
    expect(texts).toEqual(['A', 'B']);
  });
});

describe('serialize', () => {
  it('round-trips a simple tree', () => {
    expect(serialize(parseHtml('<div class="x"><span>hi</span></div>'))).toBe(
      '<div class="x"><span>hi</span></div>',
    );
  });

  it('renders a void element without a closing tag', () => {
    expect(serialize(parseHtml('<img src="a.png">'))).toBe('<img src="a.png">');
  });

  it('renders a boolean attribute bare', () => {
    expect(serialize(parseHtml('<input disabled>'))).toContain('<input disabled>');
  });
});

describe('element', () => {
  it('creates a detached element with lower-cased tag', () => {
    const el = element('DIV', { id: 'x' });
    expect(el.tag).toBe('div');
    expect(el.parent).toBeUndefined();
  });
});
