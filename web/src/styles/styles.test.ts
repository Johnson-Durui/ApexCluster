import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Shell and base stylesheet guarantees (BUILD-SPEC-B §2 contrast, §3.4 status bar, §3.7 focus, §7 reduced motion).
// Read from disk: Vitest serves CSS imports (even ?raw) as empty strings.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = { base: read('./base.css'), compat: read('./compat.css'), tokens: read('./tokens.css'), shell: read('../components/shell/shell.css'), composer: read('../pages/chat/composer.css') };

interface Rule { media: string; selector: string; decls: Record<string, string> }

/** A small CSS reader: flat rules with their @media prelude; @keyframes are skipped. Last declaration wins. */
function rules(source: string, media = ''): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open < 0) break;
    let depth = 1;
    let close = open + 1;
    while (close < text.length && depth) { if (text[close] === '{') depth += 1; else if (text[close] === '}') depth -= 1; close += 1; }
    const prelude = text.slice(index, open).trim();
    const body = text.slice(open + 1, close - 1);
    if (prelude.startsWith('@media')) out.push(...rules(body, prelude));
    else if (!prelude.startsWith('@')) {
      const decls: Record<string, string> = {};
      for (const part of body.split(';')) {
        const colon = part.indexOf(':');
        if (colon > 0) decls[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
      }
      out.push({ media, selector: prelude.replace(/\s+/g, ' '), decls });
    }
    index = close;
  }
  return out;
}

const tokenRoot = css.tokens.slice(css.tokens.indexOf(':root{'), css.tokens.indexOf('}', css.tokens.indexOf(':root{')));
function resolve(value: string): string {
  const name = /^var\(--([\w-]+)/.exec(value)?.[1];
  if (!name) return value;
  const match = new RegExp('--' + name + ':\\s*([^;]+);').exec(tokenRoot);
  if (!match) throw new Error('token --' + name + ' missing');
  return resolve(match[1].trim());
}
function luminance(color: string) {
  const hex = /^#[0-9a-f]{3}$/i.test(color) ? '#' + [...color.slice(1)].map(digit => digit + digit).join('') : color;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('not a hex colour: ' + color);
  const [r, g, b] = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(channel => channel <= .03928 ? channel / 12.92 : Math.pow((channel + .055) / 1.055, 2.4));
  return .2126 * r + .7152 * g + .0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + .05) / (lo + .05);
}

describe('reduced motion never scales', () => {
  const REDUCE = ':root[data-motion=reduce] ';
  const own = [...rules(css.base), ...rules(css.shell)];
  const scaled = (rule: Rule) => /scale\(/.test(rule.decls.transform ?? '') && !rule.selector.includes('[data-motion=reduce]');
  const neutralised = (rule: Rule, pool: Rule[]) => rule.selector.includes(':not([data-motion=reduce])')
    || pool.some(other => other.selector === REDUCE + rule.selector && other.decls.transform === 'none');

  it('gates or overrides every scale transform in the base and shell sheets (Modal recede, button press)', () => {
    const offenders = own.filter(scaled).filter(rule => !neutralised(rule, own)).map(rule => rule.selector);
    expect(offenders).toEqual([]);
    expect(own.some(rule => rule.selector === REDUCE + '.app[data-receded] :is(.app-main,.app-side)' && rule.decls.transform === 'none')).toBe(true);
  });

  it('overrides the composer send-button press scale under reduced motion', () => {
    const press = rules(css.composer).filter(rule => scaled(rule) && rule.selector.includes(':active'));
    expect(press.length).toBeGreaterThan(0);
    for (const rule of press) expect(neutralised(rule, own), rule.selector).toBe(true);
  });
});

describe('seat badge text contrast', () => {
  const compat = rules(css.compat);
  const surface = resolve('var(--surface)');
  const applies = (selector: string, seat: string) => selector === '.badge' || selector === `.badge.${seat}` || (selector.startsWith('.badge:is(') && new RegExp(`\\.${seat}\\b`).test(selector));
  // Same-specificity rules: the last one in the file wins; .badge (0,1,0) loses to both seat selectors (0,2,0).
  const used = (seat: string, property: string) => {
    const matching = compat.filter(rule => !rule.media && applies(rule.selector, seat) && rule.decls[property]);
    const strong = matching.filter(rule => rule.selector !== '.badge');
    return (strong.at(-1) ?? matching.at(-1))?.decls[property];
  };

  for (const seat of ['claude', 'astra', 'sol', 'grok']) {
    it(`draws the ${seat} badge text at 4.5:1 or more and keeps the seat ink as its 3px rule`, () => {
      const ink = resolve(used(seat, 'color')!);
      const paper = resolve(used(seat, 'background')!);
      expect(paper).toBe(surface);
      expect(contrast(ink, paper)).toBeGreaterThanOrEqual(4.5);
      expect(used(seat, '--ink-s')).toBe(`var(--s-${seat})`);
      expect(used(seat, 'box-shadow')).toMatch(/^inset 3px 0 0 var\(--ink-s/);
    });
  }
});

describe('focus survives forced colours', () => {
  const all = [...rules(css.base), ...rules(css.shell)];
  const forced = all.filter(rule => rule.media.includes('forced-colors:active'));

  it('never removes the outline of a :focus-visible rule in the base and shell sheets', () => {
    const removed = all.filter(rule => !rule.media && rule.selector.includes(':focus-visible') && /^none\b/.test(rule.decls.outline ?? '')).map(rule => rule.selector);
    expect(removed).toEqual([]);
  });

  it('gives every keyboard focus a system-coloured outline that beats page-level outline:none', () => {
    const global = forced.find(rule => rule.selector === ':focus-visible');
    expect(global?.decls.outline).toMatch(/^2px solid (Highlight|CanvasText) ?!important$/);
    const inset = forced.find(rule => rule.selector.includes('.chat-messages') && rule.selector.includes('.hq-list'));
    expect(inset?.decls['outline-offset']).toBe('-2px');
  });

  it('keeps the splitter line and its focus visible', () => {
    const line = forced.find(rule => rule.selector === '.splitter::before');
    expect(line?.decls).toMatchObject({ 'forced-color-adjust': 'none', background: 'CanvasText' });
    expect(forced.find(rule => rule.selector === '.splitter:focus-visible::before')?.decls.background).toBe('Highlight');
    expect(all.find(rule => !rule.media && rule.selector === '.splitter:focus-visible')?.decls.outline).toBe('2px solid transparent');
  });
});

describe('status bar keeps page and usage cells on screen', () => {
  const shell = rules(css.shell);
  it('lets only the sandbox cell shrink, with the ellipsis on its inner span', () => {
    expect(shell.find(rule => rule.selector === '.sb-cell')?.decls.flex).toBe('none');
    const cell = shell.find(rule => rule.selector === '.sb-cell.sb-sandbox')?.decls;
    expect(cell).toMatchObject({ flex: '0 1 auto', 'min-width': '0', overflow: 'hidden' });
    expect(cell?.['max-width']).toBeTruthy();
    expect(shell.find(rule => rule.selector === '.sb-sandbox>span')?.decls).toMatchObject({ 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
  });
});
