/**
 * Accessibility checks for generated HTML artifacts (WCAG 2.2).
 *
 * Companion to `lint-artifact.ts`, which calls `lintAccessibility()` after
 * its anti-slop rules and appends the findings to the same envelope. Like
 * the rest of the linter this is deliberately greppy and static: it reads
 * `<style>` rules and inline `style=""` attributes, resolves CSS custom
 * properties through the artifact's own theme scopes, and never builds a
 * DOM or a cascade. Its limits are explicit rather than silent:
 *
 *  - `low-contrast-text` (SC 1.4.3, P0) judges a rule only when it pairs a
 *    foreground `color` with its own background. A rule that sets only one
 *    side inherits the other from an ancestor this linter cannot see, so it
 *    is not judged at all.
 *  - `low-contrast-ui` (SC 1.4.11, P0) judges form controls that are
 *    identified by their boundary (input / select / textarea and the
 *    checkbox, switch, radio, textbox, combobox and slider roles) against
 *    the page backdrop; text buttons and links are identified by their
 *    label, which SC 1.4.3 covers. The control's border
 *    or fill must reach 3:1 against the `body`/`html` background. With no
 *    declared page background the CSS initial canvas (white) is used,
 *    unless the page opts into `color-scheme: dark`.
 *  - Any colour that cannot be resolved to an opaque sRGB value — an
 *    undefined `var()`, `color-mix()`, `currentColor`, a gradient or image,
 *    a translucent background — is reported as `contrast-unresolved` (P1).
 *    It is never treated as passing.
 *  - `missing-accessible-name` (P0) requires interactive elements to carry
 *    text content, `aria-label`, a resolvable `aria-labelledby`, `title`,
 *    image `alt`, or an associated `<label>`. A placeholder is not a name.
 *  - `target-size-min` (SC 2.5.8, P1) flags interactive rules or inline
 *    styles that declare a width or height below 24 CSS px without a
 *    `min-width` / `min-height` that lifts it back to 24.
 *
 * Each rule emits at most one finding per artifact (with a count and the
 * first offending snippet), matching the single-corrective-signal style of
 * the anti-slop rules.
 */

import type { ArtifactLintFinding } from '@open-design/contracts';

export type Rgba = { r: number; g: number; b: number; a: number };

type Decl = { prop: string; value: string };
type CssRule = { selector: string; body: string; tag: string | null; attrs: string };
type Verdict = { kind: 'pass' } | { kind: 'fail'; ratio: number } | { kind: 'unresolved'; reason: string };

export type ResolveVars = (body: string, tokens: Map<string, string>) => string;

const NAMED_COLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', maroon: '#800000', olive: '#808000', lime: '#00ff00', aqua: '#00ffff',
  cyan: '#00ffff', teal: '#008080', navy: '#000080', fuchsia: '#ff00ff', magenta: '#ff00ff',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
  dimgray: '#696969', dimgrey: '#696969', gainsboro: '#dcdcdc', whitesmoke: '#f5f5f5',
  snow: '#fffafa', ivory: '#fffff0', beige: '#f5f5dc', linen: '#faf0e6', crimson: '#dc143c',
  tomato: '#ff6347', coral: '#ff7f50', gold: '#ffd700', khaki: '#f0e68c', indigo: '#4b0082',
  violet: '#ee82ee', pink: '#ffc0cb', brown: '#a52a2a', tan: '#d2b48c', salmon: '#fa8072',
  darkblue: '#00008b', darkgreen: '#006400', darkred: '#8b0000', lightblue: '#add8e6',
  lightgreen: '#90ee90', skyblue: '#87ceeb', steelblue: '#4682b4', slategray: '#708090',
  slategrey: '#708090', royalblue: '#4169e1', midnightblue: '#191970', firebrick: '#b22222',
  forestgreen: '#228b22', seagreen: '#2e8b57', chocolate: '#d2691e', sienna: '#a0522d',
  orchid: '#da70d6', plum: '#dda0dd', lavender: '#e6e6fa', mintcream: '#f5fffa',
  aliceblue: '#f0f8ff', ghostwhite: '#f8f8ff', honeydew: '#f0fff0', seashell: '#fff5ee',
  floralwhite: '#fffaf0', oldlace: '#fdf5e6', cornsilk: '#fff8dc', antiquewhite: '#faebd7',
};

/**
 * Parse a CSS colour literal into 0–255 sRGB channels plus alpha. Returns
 * `null` for anything that is not a literal colour this linter can resolve
 * statically (`var()`, `color-mix()`, `currentColor`, keywords, …).
 */
export function parseCssColor(raw: string): Rgba | null {
  const value = raw.trim().toLowerCase().replace(/\s*!important$/, '');
  if (!value) return null;
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED_COLORS[value];
  if (named) return parseCssColor(named);
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? hex.split('').map((c) => c + c).join('') : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? round(n(6) / 255) : 1 };
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(value);
  if (!fn) return null;
  const kind = fn[1] ?? '';
  const args = (fn[2] ?? '').replace(/\s*\/\s*/, ' / ').split(/\s*,\s*|\s+/).filter((p) => p && p !== '/');
  if (args.length < 3 || args.length > 4) return null;
  const alpha = args[3] === undefined ? 1 : parseAlpha(args[3]);
  if (alpha === null) return null;
  if (kind.startsWith('rgb')) {
    const ch = args.slice(0, 3).map(parseRgbChannel);
    if (ch.some((c) => c === null)) return null;
    const [r, g, b] = ch as number[];
    return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: alpha };
  }
  const h = parseFloat(String(args[0]).replace(/deg$/, ''));
  const s = parsePercent(String(args[1]));
  const l = parsePercent(String(args[2]));
  if (!Number.isFinite(h) || s === null || l === null) return null;
  const [r, g, b] = hslToRgb(h, s, l);
  return { r, g, b, a: alpha };
}

/** WCAG 2.x contrast ratio between two opaque colours. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function relativeLuminance(c: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function parseAlpha(s: string): number | null {
  const v = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

function parseRgbChannel(s: string): number | null {
  const v = s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s);
  return Number.isFinite(v) ? Math.round(Math.min(255, Math.max(0, v))) : null;
}

function parsePercent(s: string): number | null {
  if (!s.endsWith('%')) return null;
  const v = parseFloat(s) / 100;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

// ── CSS collection ────────────────────────────────────────────────────

function collectRules(html: string): CssRule[] {
  const rules: CssRule[] = [];
  for (const block of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = (block[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const selector = (m[1] ?? '').trim();
      if (!selector || selector.startsWith('@')) continue;
      rules.push({ selector, body: m[2] ?? '', tag: null, attrs: '' });
    }
  }
  const markup = stripNonRendered(html);
  for (const m of markup.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const style = /(?:^|\s)style\s*=\s*(["'])([\s\S]*?)\1/i.exec(m[2] ?? '');
    if (!style) continue;
    const tag = (m[1] ?? '').toLowerCase();
    rules.push({ selector: `<${tag}${clipAttrs(m[2] ?? '')}>`, body: style[2] ?? '', tag, attrs: m[2] ?? '' });
  }
  return rules;
}

function clipAttrs(attrs: string): string {
  const t = attrs.replace(/\s+/g, ' ').trim();
  return t ? ` ${t.length > 120 ? t.slice(0, 117) + '…' : t}` : '';
}

function stripNonRendered(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<template[^>]*>[\s\S]*?<\/template>/gi, '');
}

function parseDecls(body: string): Decl[] {
  const out: Decl[] = [];
  for (const raw of body.split(';')) {
    const idx = raw.indexOf(':');
    if (idx < 0) continue;
    const prop = raw.slice(0, idx).trim().toLowerCase();
    if (!prop || prop.startsWith('--')) continue;
    const value = raw.slice(idx + 1).replace(/!important\s*$/i, '').trim();
    if (value) out.push({ prop, value });
  }
  return out;
}

function lastDecl(decls: Decl[], props: string[]): Decl | undefined {
  for (let i = decls.length - 1; i >= 0; i--) {
    const d = decls[i];
    if (d && props.includes(d.prop)) return d;
  }
  return undefined;
}

// Split a shorthand value on top-level whitespace (not inside parens).
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

type ColorRead = { kind: 'color'; color: Rgba } | { kind: 'none' } | { kind: 'unresolved'; value: string };

function readBackground(decls: Decl[]): ColorRead | null {
  const d = lastDecl(decls, ['background', 'background-color']);
  if (!d) return null;
  const v = d.value.toLowerCase();
  if (v === 'none' || v === 'transparent') return { kind: 'none' };
  if (/gradient\(|url\(|image-set\(/.test(v)) return { kind: 'unresolved', value: d.value };
  if (d.prop === 'background-color') {
    const c = parseCssColor(d.value);
    return c ? (c.a === 0 ? { kind: 'none' } : { kind: 'color', color: c }) : { kind: 'unresolved', value: d.value };
  }
  for (const token of splitTopLevel(d.value)) {
    const c = parseCssColor(token);
    if (c) return c.a === 0 ? { kind: 'none' } : { kind: 'color', color: c };
  }
  return { kind: 'unresolved', value: d.value };
}

function readBorder(decls: Decl[]): ColorRead | null {
  let present = false;
  let color: ColorRead | null = null;
  for (const d of decls) {
    if (d.prop === 'border') {
      const tokens = splitTopLevel(d.value.toLowerCase());
      if (tokens.some((t) => t === 'none' || t === 'hidden') || tokens.every((t) => /^0(px|rem|em)?$/.test(t))) {
        present = false;
        color = null;
        continue;
      }
      present = true;
      const found = splitTopLevel(d.value).map(parseCssColor).find((c) => c !== null);
      color = found ? { kind: 'color', color: found } : { kind: 'unresolved', value: d.value };
    } else if (d.prop === 'border-color') {
      present = true;
      const c = parseCssColor(d.value);
      color = c ? { kind: 'color', color: c } : { kind: 'unresolved', value: d.value };
    } else if (d.prop === 'border-width' && /^0(px|rem|em)?$/.test(d.value.trim())) {
      present = false;
    } else if (d.prop === 'border-style' && /^(none|hidden)$/i.test(d.value.trim())) {
      present = false;
    }
  }
  if (!present || !color) return null;
  if (color.kind === 'color' && color.color.a === 0) return null;
  return color;
}

function toPx(value: string): number | null {
  const m = /^(-?\d*\.?\d+)(px|rem|pt)$/i.exec(value.trim());
  if (!m) return null;
  const v = parseFloat(m[1] ?? '');
  const unit = (m[2] ?? '').toLowerCase();
  return unit === 'rem' ? v * 16 : unit === 'pt' ? (v * 4) / 3 : v;
}

// ── Selector classification ───────────────────────────────────────────

function lastCompound(selector: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i] ?? '';
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[\s>+~]/.test(ch)) start = i + 1;
  }
  return selector.slice(start).trim();
}

const INTERACTIVE_TAG_RE = /^(?:button|input|select|textarea|a)(?=$|[.#:[])/i;
const INTERACTIVE_ROLE_RE = /\[role\s*[~|^$*]?=\s*["']?(?:button|link|checkbox|switch|tab|menuitem|radio|option|textbox|combobox|slider)\b/i;
const INTERACTIVE_CLASS_RE = /\.(?:[\w-]*[-_])?(?:btn|button)(?:[-_][\w-]*)?(?=$|[.#:[])/i;
// Controls whose boundary is what identifies them (SC 1.4.11). A button or
// link with a visible text label is identified by that text, which SC 1.4.3
// already covers, so its border/fill is not judged here.
const BOUNDARY_TAG_RE = /^(?:input|select|textarea)(?=$|[.#:[])/i;
const BOUNDARY_ROLE_RE = /\[role\s*[~|^$*]?=\s*["']?(?:checkbox|switch|radio|textbox|combobox|slider)\b/i;
const PSEUDO_ELEMENT_RE = /::?(?:before|after|placeholder|marker|selection|first-line|first-letter)\b|::/i;

function roleSelector(attrs: string): string {
  return `[${attrs.match(/\brole\s*=\s*["']?[\w-]+/i)?.[0] ?? ''}]`;
}

/** Any interactive element: the target of SC 2.5.8. */
function isInteractiveRule(rule: CssRule): boolean {
  if (rule.tag) {
    if (/^(?:button|select|textarea)$/.test(rule.tag)) return true;
    if (rule.tag === 'a') return /\bhref\s*=/.test(rule.attrs);
    if (rule.tag === 'input') return !/\btype\s*=\s*["']?hidden/i.test(rule.attrs);
    return INTERACTIVE_ROLE_RE.test(roleSelector(rule.attrs));
  }
  return rule.selector.split(',').some((sel) => {
    const last = lastCompound(sel.trim());
    if (PSEUDO_ELEMENT_RE.test(last)) return false;
    return INTERACTIVE_TAG_RE.test(last) || INTERACTIVE_ROLE_RE.test(last) || INTERACTIVE_CLASS_RE.test(last);
  });
}

/** Form controls identified by their boundary: the subject of SC 1.4.11. */
function isBoundaryControlRule(rule: CssRule): boolean {
  if (rule.tag) {
    if (rule.tag === 'select' || rule.tag === 'textarea') return true;
    if (rule.tag === 'input') {
      return !/\btype\s*=\s*["']?(?:hidden|submit|reset|button|image)\b/i.test(rule.attrs);
    }
    return BOUNDARY_ROLE_RE.test(roleSelector(rule.attrs));
  }
  return rule.selector.split(',').some((sel) => {
    const last = lastCompound(sel.trim());
    if (PSEUDO_ELEMENT_RE.test(last)) return false;
    if (/\[type\s*=\s*["']?(?:hidden|submit|reset|button|image)\b/i.test(last)) return false;
    return BOUNDARY_TAG_RE.test(last) || BOUNDARY_ROLE_RE.test(last);
  });
}

function isLargeText(rule: CssRule, decls: Decl[]): boolean {
  const fsDecl = lastDecl(decls, ['font-size']);
  const weightDecl = lastDecl(decls, ['font-weight']);
  const w = weightDecl?.value.trim().toLowerCase();
  const bold = w === 'bold' || w === 'bolder' || (w !== undefined && Number(w) >= 700);
  if (fsDecl) {
    const px = toPx(fsDecl.value);
    if (px === null) return false;
    return px >= 24 || (bold && px >= 18.66);
  }
  // UA defaults: h1 = 2em (32px), h2 = 1.5em (24px) on a 16px root.
  const target = rule.tag ?? rule.selector.split(',').map((s) => lastCompound(s.trim())).join(',');
  return target.split(',').every((t) => /^h[12](?=$|[.#:[])/i.test(t.trim()));
}

// ── Rules ─────────────────────────────────────────────────────────────

type Hit = { snippet: string; detail: string };

function snippetOf(rule: CssRule): string {
  const body = rule.body.replace(/\s+/g, ' ').trim();
  const s = rule.tag ? `${rule.selector}` : `${rule.selector} { ${body} }`;
  return s.length > 200 ? s.slice(0, 197) + '…' : s;
}

function worst(verdicts: Verdict[]): Verdict {
  const fail = verdicts.find((v) => v.kind === 'fail');
  if (fail) return fail;
  return verdicts.find((v) => v.kind === 'unresolved') ?? { kind: 'pass' };
}

function textVerdict(rule: CssRule, body: string): Verdict | null {
  const decls = parseDecls(body);
  const fgDecl = lastDecl(decls, ['color']);
  const bg = readBackground(decls);
  if (!fgDecl || !bg) return null;
  // A transparent background shows an ancestor's backdrop, exactly like a
  // rule that sets no background: not a pair this linter can judge.
  if (bg.kind === 'none') return null;
  if (bg.kind === 'unresolved') return { kind: 'unresolved', reason: `background ${bg.value}` };
  if (bg.color.a < 1) return { kind: 'unresolved', reason: 'background is translucent' };
  const fgRaw = parseCssColor(fgDecl.value);
  if (!fgRaw) return { kind: 'unresolved', reason: `color ${fgDecl.value}` };
  const fg = fgRaw.a < 1 ? composite(fgRaw, bg.color) : fgRaw;
  const ratio = contrastRatio(fg, bg.color);
  const min = isLargeText(rule, decls) ? 3 : 4.5;
  return ratio + 1e-9 >= min ? { kind: 'pass' } : { kind: 'fail', ratio };
}

type Backdrop = { kind: 'color'; color: Rgba } | { kind: 'unresolved'; reason: string };

function pageBackdrop(rules: CssRule[], resolve: (body: string) => string): Backdrop {
  let bodyBg: ColorRead | null = null;
  let rootBg: ColorRead | null = null;
  let dark = false;
  for (const rule of rules) {
    if (rule.tag) continue;
    const sels = rule.selector.split(',').map((s) => s.trim());
    const isBody = sels.includes('body');
    const isRoot = sels.includes('html') || sels.includes(':root');
    if (!isBody && !isRoot) continue;
    const decls = parseDecls(resolve(rule.body));
    const bg = readBackground(decls);
    if (bg && isBody) bodyBg = bg;
    else if (bg && isRoot) rootBg = bg;
    const scheme = lastDecl(decls, ['color-scheme']);
    if (scheme && /\bdark\b/i.test(scheme.value)) dark = true;
  }
  const chosen = bodyBg && bodyBg.kind !== 'none' ? bodyBg : rootBg && rootBg.kind !== 'none' ? rootBg : null;
  if (!chosen) {
    return dark
      ? { kind: 'unresolved', reason: 'page opts into color-scheme: dark without a declared background' }
      : { kind: 'color', color: { r: 255, g: 255, b: 255, a: 1 } };
  }
  if (chosen.kind === 'unresolved') return { kind: 'unresolved', reason: `page background ${chosen.value}` };
  if (chosen.kind === 'color' && chosen.color.a < 1) return { kind: 'unresolved', reason: 'page background is translucent' };
  return chosen as Backdrop;
}

function uiVerdict(body: string, backdrop: Backdrop): Verdict | null {
  const decls = parseDecls(body);
  const fill = readBackground(decls);
  const border = readBorder(decls);
  const indicators: ColorRead[] = [];
  if (fill && fill.kind !== 'none') indicators.push(fill);
  if (border) indicators.push(border);
  if (indicators.length === 0) return null;
  if (backdrop.kind === 'unresolved') return { kind: 'unresolved', reason: backdrop.reason };
  let best = 0;
  let unresolved: string | null = null;
  for (const ind of indicators) {
    if (ind.kind === 'unresolved') {
      unresolved = ind.value;
      continue;
    }
    if (ind.kind !== 'color') continue;
    if (ind.color.a < 1) {
      unresolved = 'translucent control colour';
      continue;
    }
    best = Math.max(best, contrastRatio(ind.color, backdrop.color));
  }
  if (best + 1e-9 >= 3) return { kind: 'pass' };
  if (unresolved) return { kind: 'unresolved', reason: unresolved };
  return { kind: 'fail', ratio: best };
}

function targetVerdict(body: string): Verdict | null {
  const decls = parseDecls(body);
  const axis = (size: string, min: string): number | null => {
    const s = lastDecl(decls, [size]);
    const px = s ? toPx(s.value) : null;
    if (px === null) return null;
    const m = lastDecl(decls, [min]);
    const minPx = m ? toPx(m.value) : null;
    return Math.max(px, minPx ?? 0);
  };
  const w = axis('width', 'min-width');
  const h = axis('height', 'min-height');
  const smallest = Math.min(w ?? Infinity, h ?? Infinity);
  if (smallest === Infinity) return null;
  return smallest >= 24 ? { kind: 'pass' } : { kind: 'fail', ratio: smallest };
}

// ── Accessible names ──────────────────────────────────────────────────

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? '';
}

function hasAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|$)`, 'i').test(attrs);
}

function textFromContent(inner: string): string {
  return inner
    .replace(/<img\b[^>]*>/gi, (img) => ` ${attr(img, 'alt') ?? ''} `)
    .replace(/<[^>]+\baria-label\s*=\s*(["'])([^"']*)\1[^>]*>/gi, (_m, _q, label: string) => ` ${label} `)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function missingNames(html: string): Hit[] {
  const markup = stripNonRendered(html);
  const ids = new Set(Array.from(markup.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi), (m) => m[1] ?? ''));
  const labelFor = new Set(
    Array.from(markup.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi), (m) => m[1] ?? ''),
  );
  const labelRanges = Array.from(markup.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi))
    .filter((m) => textFromContent((m[1] ?? '').replace(/<(?:input|select|textarea)\b[\s\S]*?(?:>|<\/(?:select|textarea)>)/gi, ' ')).length > 0)
    .map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const);
  const insideLabel = (pos: number) => labelRanges.some(([s, e]) => pos > s && pos < e);
  const named = (attrs: string): boolean => {
    const label = attr(attrs, 'aria-label');
    if (label && label.trim()) return true;
    const by = attr(attrs, 'aria-labelledby');
    if (by && by.split(/\s+/).some((id) => id && ids.has(id))) return true;
    const title = attr(attrs, 'title');
    return Boolean(title && title.trim());
  };
  const hits: Hit[] = [];
  const push = (snippet: string, detail: string) =>
    hits.push({ snippet: snippet.replace(/\s+/g, ' ').trim().slice(0, 200), detail });

  for (const m of markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    if (!named(m[1] ?? '') && !textFromContent(m[2] ?? '')) push(m[0], '<button> has no text or label');
  }
  for (const m of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1] ?? '';
    if (!hasAttr(attrs, 'href')) continue;
    if (!named(attrs) && !textFromContent(m[2] ?? '')) push(m[0], 'link has no text or label');
  }
  for (const m of markup.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\brole\s*=\s*["']?(?:button|link|checkbox|switch|tab|menuitem|radio|option)\b[^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const tag = (m[1] ?? '').toLowerCase();
    if (tag === 'button' || tag === 'a') continue;
    if (!named(m[2] ?? '') && !textFromContent(m[3] ?? '')) push(m[0], `role element <${tag}> has no text or label`);
  }
  for (const m of markup.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const tag = (m[1] ?? '').toLowerCase();
    const attrs = m[2] ?? '';
    if (tag === 'input') {
      const type = (attr(attrs, 'type') ?? 'text').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'reset') continue;
      if (type === 'button' && (attr(attrs, 'value') ?? '').trim()) continue;
      if (type === 'image' && (attr(attrs, 'alt') ?? '').trim()) continue;
    }
    const id = attr(attrs, 'id');
    if (named(attrs) || (id && labelFor.has(id)) || insideLabel(m.index ?? 0)) continue;
    push(m[0], `<${tag}> has no associated label`);
  }
  return hits;
}

// ── Entry point ───────────────────────────────────────────────────────

/**
 * Run the accessibility rules. `themes` are the per-theme token maps the
 * anti-slop linter already derives from global theme scopes, and
 * `resolveVars` is its `var()` resolver, so both linters agree on what a
 * token renders as in every theme.
 */
export function lintAccessibility(
  html: string,
  themes: Map<string, string>[],
  resolveVars: ResolveVars,
): ArtifactLintFinding[] {
  const out: ArtifactLintFinding[] = [];
  const rules = collectRules(html);
  const themeMaps = themes.length > 0 ? themes : [new Map<string, string>()];
  const backdrops = themeMaps.map((t) => pageBackdrop(rules, (b) => resolveVars(b, t)));

  const textFails: Hit[] = [];
  const uiFails: Hit[] = [];
  const targetFails: Hit[] = [];
  const unresolved: Hit[] = [];

  for (const rule of rules) {
    const bodies = themeMaps.map((t) => resolveVars(rule.body, t));
    const text = bodies.map((b) => textVerdict(rule, b)).filter((v): v is Verdict => v !== null);
    if (text.length > 0) {
      const v = worst(text);
      if (v.kind === 'fail') textFails.push({ snippet: snippetOf(rule), detail: `${v.ratio.toFixed(2)}:1` });
      else if (v.kind === 'unresolved') unresolved.push({ snippet: snippetOf(rule), detail: `text: ${v.reason}` });
    }
    if (isBoundaryControlRule(rule)) {
      const ui = bodies
        .map((b, i) => uiVerdict(b, backdrops[i] ?? backdrops[0]!))
        .filter((v): v is Verdict => v !== null);
      if (ui.length > 0) {
        const v = worst(ui);
        if (v.kind === 'fail') uiFails.push({ snippet: snippetOf(rule), detail: `${v.ratio.toFixed(2)}:1` });
        else if (v.kind === 'unresolved') unresolved.push({ snippet: snippetOf(rule), detail: `control: ${v.reason}` });
      }
    }
    if (!isInteractiveRule(rule)) continue;
    const target = bodies.map(targetVerdict).filter((v): v is Verdict => v !== null);
    if (target.length > 0) {
      const v = worst(target);
      if (v.kind === 'fail') targetFails.push({ snippet: snippetOf(rule), detail: `${v.ratio}px` });
    }
  }

  if (textFails.length > 0) {
    const first = textFails[0]!;
    out.push({
      severity: 'P0',
      id: 'low-contrast-text',
      message: `${textFails.length} text colour pair(s) below WCAG 2.2 SC 1.4.3 (4.5:1 normal, 3:1 large text); first is ${first.detail}.`,
      fix: 'Darken the foreground or lighten the background token until the pair reaches 4.5:1 (3:1 for text at least 24px, or 18.66px bold). Fix the design token, not the single rule, when the pair comes from tokens.',
      snippet: first.snippet,
    });
  }
  if (uiFails.length > 0) {
    const first = uiFails[0]!;
    out.push({
      severity: 'P0',
      id: 'low-contrast-ui',
      message: `${uiFails.length} interactive control(s) whose border and fill are both below WCAG 2.2 SC 1.4.11 (3:1 against the page background); best is ${first.detail}.`,
      fix: 'Give the control a border or fill that reaches 3:1 against the page background (for example a darker --border token on inputs, or a solid accent fill on buttons).',
      snippet: first.snippet,
    });
  }
  const names = missingNames(html);
  if (names.length > 0) {
    const first = names[0]!;
    out.push({
      severity: 'P0',
      id: 'missing-accessible-name',
      message: `${names.length} interactive element(s) without an accessible name; first: ${first.detail}.`,
      fix: 'Give every interactive element visible text, or an aria-label / aria-labelledby, or an associated <label for>. Icon-only buttons need aria-label; a placeholder is not a label.',
      snippet: first.snippet,
    });
  }
  if (targetFails.length > 0) {
    const first = targetFails[0]!;
    out.push({
      severity: 'P1',
      id: 'target-size-min',
      message: `${targetFails.length} interactive target(s) declared smaller than 24×24 CSS px (WCAG 2.2 SC 2.5.8); smallest side ${first.detail}.`,
      fix: 'Raise width/height to at least 24px, or add min-width/min-height: 24px (44px is the comfortable touch size).',
      snippet: first.snippet,
    });
  }
  if (unresolved.length > 0) {
    const first = unresolved[0]!;
    out.push({
      severity: 'P1',
      id: 'contrast-unresolved',
      message: `${unresolved.length} colour pair(s) could not be resolved statically, so their contrast is unresolved (not passed); first: ${first.detail}.`,
      fix: 'Use literal colours or design tokens that resolve to opaque colours (no color-mix(), currentColor, gradients or translucent backgrounds behind text), or verify the contrast in a rendered check.',
      snippet: first.snippet,
    });
  }
  return out;
}
