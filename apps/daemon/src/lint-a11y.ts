/**
 * Accessibility checks for generated HTML artifacts (WCAG 2.x).
 *
 * Companion to `lint-artifact.ts`, which resolves a declarative
 * `A11yComplianceProfile` (from `@open-design/contracts`) and calls
 * `lintAccessibility()` after its anti-slop rules. Every enabled check,
 * numeric threshold, severity (`P0`/`P1`/`P2`), and compliance provenance
 * (`{ standard, sc, level }`) comes from that profile rather than being
 * hardcoded here. Like the rest of the linter this is deliberately greppy
 * and static: it reads `<style>` rules and inline `style=""` attributes,
 * resolves CSS custom properties through the artifact's own theme scopes,
 * and never builds a DOM or a cascade. Its limits are explicit rather than
 * silent:
 *
 *  - `low-contrast-text` (SC 1.4.3 / 1.4.6) judges a rule only when it pairs a
 *    foreground `color` with its own background, using the active profile's
 *    `normalRatio` / `largeRatio` thresholds. A rule that sets only one side
 *    inherits the other from an ancestor this linter cannot see, so it is
 *    not judged at all.
 *  - `low-contrast-ui` (SC 1.4.11) judges form controls that are
 *    identified by their boundary (input / select / textarea and the
 *    checkbox, switch, radio, textbox, combobox and slider roles) against
 *    the opaque page backdrop; text buttons and links are identified by their
 *    label, which text contrast covers. The control's border, crisp outer ring
 *    `box-shadow` (`0 0 0 <spread> <color>`), or fill must reach the active
 *    profile's `minRatio` against the `body`/`html` background (translucent
 *    control colours are alpha-composited over that opaque backdrop, matching
 *    `low-contrast-text`). With no declared page background the CSS initial
 *    canvas (white) is used, unless the page opts into `color-scheme: dark`.
 *  - Any colour that cannot be resolved to an opaque sRGB value — an
 *    undefined `var()`, `color-mix()`, `currentColor`, a gradient or image,
 *    a translucent page or text background — is reported as
 *    `contrast-unresolved` when enabled by the profile. It is never treated as
 *    passing.
 *  - `missing-accessible-name` (SC 4.1.2) requires interactive elements to
 *    carry text content, `aria-label`, a resolvable `aria-labelledby`,
 *    `title`, image `alt`, or an associated `<label>`. A placeholder is not
 *    a name.
 *  - `target-size-min` (SC 2.5.8 / 2.5.5) flags interactive rules or inline
 *    styles that declare a width or height below the profile's `minPx`
 *    without a `min-width` / `min-height` that lifts it back to `minPx`.
 *
 * Each rule emits at most one finding per artifact (with a count and the
 * first offending snippet), matching the single-corrective-signal style of
 * the anti-slop rules.
 */

import {
  A11Y_COMPLIANCE_PROFILES,
  A11Y_RULE_IDS,
  DEFAULT_A11Y_COMPLIANCE_LEVEL,
  type A11yComplianceProfile,
  type A11yFocusAppearanceRuleSpec,
  type A11yFocusOutlineRuleSpec,
  type A11yHtmlLangRuleSpec,
  type A11yImgAltRuleSpec,
  type A11yPageTitleRuleSpec,
  type A11yTargetSizeRuleSpec,
  type A11yTextContrastRuleSpec,
  type A11yUiContrastRuleSpec,
  type ArtifactLintComplianceRef,
  type ArtifactLintFinding,
} from '@open-design/contracts';
import {
  IMPORTANT_SUFFIX_RE,
  ROOT_FONT_PX,
  advanceCssString,
  findLastDeclaration,
  parseCssDeclarations,
  sanitizeLintText,
  scanHtmlDocument,
  stripCssComments,
  type CssDeclaration,
  type HtmlDocumentScanResult,
  type HtmlScannedTag,
} from './artifacts/lint-css-utils.js';

export type Rgba = { r: number; g: number; b: number; a: number };

type Decl = CssDeclaration;
type CssRule = { selector: string; body: string; tag: string | null; attrs: Map<string, string> | null };
type Verdict = { kind: 'pass' } | { kind: 'fail'; ratio: number } | { kind: 'unresolved'; reason: string };

export type ResolveVars = (body: string, tokens: ReadonlyMap<string, string>) => string;

const WCAG_LARGE_TEXT_PX = 24;
const WCAG_LARGE_BOLD_TEXT_PX = 18.66;
const MAX_UNRESOLVED_DETAIL_LEN = 120;

const NAMED_COLORS: ReadonlyMap<string, string> = new Map<string, string>(
  Object.entries({
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
  }),
);

/**
 * Parse a CSS colour literal into 0–255 sRGB channels plus alpha. Returns
 * `null` for anything that is not a literal colour this linter can resolve
 * statically (`var()`, `color-mix()`, `currentColor`, keywords, …).
 */
export function parseCssColor(raw: string): Rgba | null {
  const trimmed = raw.trim();
  const value = (trimmed.includes('!') ? trimmed.replace(IMPORTANT_SUFFIX_RE, '').trim() : trimmed).toLowerCase();
  if (!value) return null;
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED_COLORS.get(value);
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
  const args = (fn[2] ?? '').replace('/', ' ').split(/[\s,]+/).filter(Boolean);
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

function compositeIfTranslucent(fg: Rgba, bg: Rgba): Rgba {
  return fg.a < 1 ? composite(fg, bg) : fg;
}

// ── CSS collection ────────────────────────────────────────────────────

const KEYFRAMES_AT_RULE_RE = /^\s*@(?:-[a-z-]+-)?keyframes\b/i;

type StyleStackFrame =
  | { kind: 'wrapper' }
  | { kind: 'rule'; selector: string; bodyStart: number; nested: boolean };

function collectStyleRules(css: string, out: CssRule[]): void {
  const clean = stripCssComments(css);
  const stack: StyleStackFrame[] = [];
  let skipDepth = 0;
  let quote: '\'' | '"' | null = null;
  let parenDepth = 0;
  let headerStart = 0;
  let i = 0;

  while (i < clean.length) {
    const ch = clean[i];
    if (quote !== null) {
      const step = advanceCssString(clean, i, quote);
      i = step.nextIndex;
      quote = step.nextQuote;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '(') {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      if (parenDepth > 0) parenDepth -= 1;
      i += 1;
      continue;
    }
    if (ch === ';' && parenDepth === 0) {
      headerStart = i + 1;
      i += 1;
      continue;
    }
    if (ch === '{') {
      if (skipDepth > 0) {
        skipDepth += 1;
        i += 1;
        continue;
      }
      const header = clean.slice(headerStart, i).trim();
      headerStart = i + 1;
      parenDepth = 0;
      if (KEYFRAMES_AT_RULE_RE.test(header)) {
        skipDepth = 1;
      } else if (header.startsWith('@')) {
        stack.push({ kind: 'wrapper' });
      } else {
        const parent = stack[stack.length - 1];
        if (parent && parent.kind === 'rule') parent.nested = true;
        stack.push({ kind: 'rule', selector: header, bodyStart: i + 1, nested: false });
      }
      i += 1;
      continue;
    }
    if (ch === '}') {
      headerStart = i + 1;
      parenDepth = 0;
      if (skipDepth > 0) {
        skipDepth -= 1;
        i += 1;
        continue;
      }
      const frame = stack.pop();
      if (frame && frame.kind === 'rule' && !frame.nested && frame.selector) {
        out.push({ selector: frame.selector, body: clean.slice(frame.bodyStart, i), tag: null, attrs: null });
      }
      i += 1;
      continue;
    }
    i += 1;
  }
}

function collectRules(html: string, doc: HtmlDocumentScanResult): CssRule[] {
  const rules: CssRule[] = [];
  for (const block of doc.styleBlocks) {
    collectStyleRules(block.css, rules);
  }
  for (const entry of doc.inlineStyleTags) {
    const style = entry.attrs.get('style');
    if (!style) continue;
    const rawTag = html.slice(entry.start, entry.end);
    const rawAttrs = rawTag.slice(1 + entry.tagName.length, entry.selfClosing ? -2 : -1).trim();
    const clippedAttrs = sanitizeLintText(rawAttrs, 120);
    rules.push({
      selector: `<${entry.tagName}${clippedAttrs ? ` ${clippedAttrs}` : ''}>`,
      body: style,
      tag: entry.tagName,
      attrs: entry.attrs,
    });
  }
  return rules;
}

function parseDecls(body: string): Decl[] {
  return parseCssDeclarations(body, { stripImportant: true });
}

function lastDecl(decls: Decl[], props: string[]): Decl | undefined {
  return findLastDeclaration(decls, props);
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

// Split a comma-separated value list on top-level commas (outside quotes, parens, and brackets).
function splitTopLevelCommas(value: string): string[] {
  const out: string[] = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: '\'' | '"' | null = null;
  let chunkStart = 0;
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (quote !== null) {
      const step = advanceCssString(value, i, quote);
      i = step.nextIndex;
      quote = step.nextQuote;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
    } else if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (ch === '[') {
      bracketDepth += 1;
    } else if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      const segment = value.slice(chunkStart, i).trim();
      if (segment) out.push(segment);
      chunkStart = i + 1;
    }
    i += 1;
  }
  const tail = value.slice(chunkStart).trim();
  if (tail) out.push(tail);
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

const ZERO_LENGTH_TOKEN_RE = /^-?(?:0(?:\.0+)?|\.0+)(?:[a-z%]+)?$/i;
const LENGTH_TOKEN_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|pt|em|vh|vw|vmin|vmax|ch|ex|%)?$/i;
const CSS_MATH_FN_RE = /^(?:calc|min|max|clamp)\(/i;
const UNIT_LENGTH_RE = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|pt)$/i;

function lengthToPx(value: string): number | null {
  const trimmed = value.trim();
  if (ZERO_LENGTH_TOKEN_RE.test(trimmed)) return 0;
  const m = UNIT_LENGTH_RE.exec(trimmed);
  if (!m) return null;
  const v = parseFloat(m[1] ?? '');
  if (!Number.isFinite(v)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  return unit === 'rem' ? v * ROOT_FONT_PX : unit === 'pt' ? (v * 4) / 3 : v;
}

function readBorder(decls: Decl[]): { color: ColorRead | null; cleared: boolean } {
  let present = false;
  let cleared = false;
  let zeroWidth = false;
  let noneStyle = false;
  let color: ColorRead | null = null;
  for (const d of decls) {
    if (d.prop === 'border') {
      const tokens = splitTopLevel(d.value.toLowerCase());
      if (tokens.some((t) => t === 'none' || t === 'hidden') || tokens.some((t) => ZERO_LENGTH_TOKEN_RE.test(t))) {
        present = false;
        cleared = true;
        zeroWidth = tokens.some((t) => ZERO_LENGTH_TOKEN_RE.test(t));
        noneStyle = tokens.some((t) => t === 'none' || t === 'hidden');
        color = null;
        continue;
      }
      present = true;
      cleared = false;
      zeroWidth = false;
      noneStyle = false;
      const found = splitTopLevel(d.value).map(parseCssColor).find((c) => c !== null);
      color = found ? { kind: 'color', color: found } : { kind: 'unresolved', value: d.value };
    } else if (d.prop === 'border-color') {
      if (!zeroWidth && !noneStyle) {
        present = true;
        cleared = false;
      }
      const c = parseCssColor(d.value);
      color = c ? { kind: 'color', color: c } : { kind: 'unresolved', value: d.value };
    } else if (d.prop === 'border-width') {
      if (ZERO_LENGTH_TOKEN_RE.test(d.value.trim())) {
        present = false;
        cleared = true;
        zeroWidth = true;
      } else {
        zeroWidth = false;
        if (color && !noneStyle) {
          present = true;
          cleared = false;
        }
      }
    } else if (d.prop === 'border-style') {
      if (/^(none|hidden)$/i.test(d.value.trim())) {
        present = false;
        cleared = true;
        noneStyle = true;
      } else {
        noneStyle = false;
        if (color && !zeroWidth) {
          present = true;
          cleared = false;
        }
      }
    }
  }
  const resolved = !present || zeroWidth || noneStyle || !color || (color.kind === 'color' && color.color.a === 0)
    ? null
    : color;
  return { color: resolved, cleared };
}

type BoxShadowLayer = {
  inset: boolean;
  lengths: string[];
  spreadPx: number | null;
  isOuterRing: boolean;
  hasNonZeroLength: boolean;
  color: ColorRead;
  hasUnresolvedVar: boolean;
};

function parseBoxShadowLayers(decls: Decl[]): BoxShadowLayer[] {
  const d = lastDecl(decls, ['box-shadow']);
  if (!d) return [];
  const trimmed = d.value.trim();
  if (/^none$/i.test(trimmed)) return [];

  const layers: BoxShadowLayer[] = [];
  for (const rawLayer of splitTopLevelCommas(trimmed)) {
    const tokens = splitTopLevel(rawLayer);
    if (tokens.length === 0 || tokens.every((t) => t.toLowerCase() === 'none')) continue;

    const inset = tokens.some((t) => t.toLowerCase() === 'inset');
    const nonInsetTokens = tokens.filter((t) => t.toLowerCase() !== 'inset');
    const hasUnresolvedVar = tokens.some((t) => /\bvar\(/i.test(t));

    const lengths: string[] = [];
    const colorTokens: string[] = [];
    for (const token of nonInsetTokens) {
      if (LENGTH_TOKEN_RE.test(token) || CSS_MATH_FN_RE.test(token)) lengths.push(token);
      else colorTokens.push(token);
    }

    let color: ColorRead;
    if (colorTokens.length === 0) {
      color = { kind: 'unresolved', value: 'box-shadow currentColor' };
    } else if (colorTokens.length > 1) {
      color = { kind: 'unresolved', value: colorTokens.join(' ') };
    } else {
      const c = parseCssColor(colorTokens[0]!);
      color = !c
        ? { kind: 'unresolved', value: colorTokens[0]! }
        : c.a === 0
          ? { kind: 'none' }
          : { kind: 'color', color: c };
    }

    const hasNonZeroLength = lengths.some((tok) => lengthToPx(tok) !== 0);
    let spreadPx: number | null = null;
    let isOuterRing = false;
    if (!inset && lengths.length === 4) {
      const [ox, oy, blur, spread] = lengths;
      if (
        ox &&
        oy &&
        blur &&
        spread &&
        lengthToPx(ox) === 0 &&
        lengthToPx(oy) === 0 &&
        lengthToPx(blur) === 0
      ) {
        const parsedSpread = lengthToPx(spread);
        const rawNum = parseFloat(spread);
        if ((parsedSpread !== null && parsedSpread > 0) || (parsedSpread === null && rawNum > 0)) {
          spreadPx = parsedSpread;
          isOuterRing = true;
        }
      }
    }

    layers.push({
      inset,
      lengths,
      spreadPx,
      isOuterRing,
      hasNonZeroLength,
      color,
      hasUnresolvedVar,
    });
  }
  return layers;
}

function readRingShadows(decls: Decl[]): ColorRead[] {
  return parseBoxShadowLayers(decls)
    .filter((layer) => layer.isOuterRing && layer.color.kind !== 'none')
    .map((layer) => layer.color);
}

const VISIBLE_TEXT_DECORATION_LINES = new Set(['underline', 'overline', 'line-through']);

function readVisibleTextDecoration(decls: Decl[]): boolean {
  const lineDecl = lastDecl(decls, ['text-decoration', 'text-decoration-line']);
  if (!lineDecl) return false;
  const lineTokens = splitTopLevel(lineDecl.value.toLowerCase());
  if (!lineTokens.some((t) => VISIBLE_TEXT_DECORATION_LINES.has(t))) return false;

  let color: Rgba | null = null;
  for (const d of decls) {
    if (d.prop === 'text-decoration') {
      color = splitTopLevel(d.value).map(parseCssColor).find((c) => c !== null) ?? null;
    } else if (d.prop === 'text-decoration-color') {
      color = parseCssColor(d.value);
    }
  }
  return !(color && color.a === 0);
}

function hasVisibleFocusCompensation(decls: Decl[]): boolean {
  if (readBorder(decls).color !== null) return true;
  const bg = readBackground(decls);
  if (bg !== null && bg.kind !== 'none') return true;
  const layers = parseBoxShadowLayers(decls);
  if (layers.some((layer) => layer.hasUnresolvedVar || (layer.hasNonZeroLength && layer.color.kind !== 'none'))) {
    return true;
  }
  return readVisibleTextDecoration(decls);
}

type OutlineState = {
  declared: boolean;
  style: 'unset' | 'none' | 'hidden' | 'auto' | 'visible';
  widthPx: number | null;
  color: ColorRead | null;
  suppressed: boolean;
};

const OUTLINE_VISIBLE_STYLES = new Set([
  'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset',
]);
const OUTLINE_WIDTH_KEYWORDS: Readonly<Record<string, number>> = {
  thin: 1,
  medium: 3,
  thick: 5,
};

function parseOutlineWidthToken(token: string): number | null {
  const lower = token.trim().toLowerCase();
  if (Object.hasOwn(OUTLINE_WIDTH_KEYWORDS, lower)) return OUTLINE_WIDTH_KEYWORDS[lower]!;
  return lengthToPx(lower);
}

function readOutlineState(decls: Decl[]): OutlineState {
  let declared = false;
  let style: OutlineState['style'] = 'unset';
  let widthPx: number | null = null;
  let color: ColorRead | null = null;

  for (const d of decls) {
    if (d.prop === 'outline') {
      declared = true;
      style = 'unset';
      widthPx = null;
      color = null;
      for (const token of splitTopLevel(d.value)) {
        const lower = token.toLowerCase();
        if (lower === 'none' || lower === 'hidden') {
          style = lower;
        } else if (lower === 'auto') {
          style = 'auto';
        } else if (OUTLINE_VISIBLE_STYLES.has(lower)) {
          style = 'visible';
        } else {
          const w = parseOutlineWidthToken(token);
          if (w !== null) {
            widthPx = w;
          } else if (LENGTH_TOKEN_RE.test(token) || CSS_MATH_FN_RE.test(token)) {
            // Width in relative/math CSS units (`0.2em`, `calc(...)`): leave parsed color intact.
          } else if (lower === 'invert') {
            color = null;
          } else {
            const c = parseCssColor(token);
            if (c) {
              color = c.a === 0 ? { kind: 'none' } : { kind: 'color', color: c };
            } else if (color === null) {
              color = { kind: 'unresolved', value: token };
            }
          }
        }
      }
    } else if (d.prop === 'outline-style') {
      declared = true;
      const lower = d.value.trim().toLowerCase();
      if (lower === 'none' || lower === 'hidden') style = lower;
      else if (lower === 'auto') style = 'auto';
      else if (OUTLINE_VISIBLE_STYLES.has(lower)) style = 'visible';
      else style = 'unset';
    } else if (d.prop === 'outline-width') {
      declared = true;
      widthPx = parseOutlineWidthToken(d.value);
    } else if (d.prop === 'outline-color') {
      declared = true;
      const trimmed = d.value.trim();
      const lower = trimmed.toLowerCase();
      if (lower === 'invert') {
        color = { kind: 'unresolved', value: 'invert' };
      } else {
        const c = parseCssColor(trimmed);
        color = c
          ? (c.a === 0 ? { kind: 'none' } : { kind: 'color', color: c })
          : { kind: 'unresolved', value: trimmed };
      }
    }
  }

  const suppressed =
    declared && (style === 'none' || style === 'hidden' || widthPx === 0 || color?.kind === 'none');
  return { declared, style, widthPx, color, suppressed };
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

const INTERACTIVE_ROLE_SET = new Set([
  'button', 'link', 'checkbox', 'switch', 'tab', 'menuitem', 'radio', 'option', 'textbox', 'combobox', 'slider',
]);
const BOUNDARY_ROLE_SET = new Set(['checkbox', 'switch', 'radio', 'textbox', 'combobox', 'slider']);

function hasAttrRole(attrs: Map<string, string>, roleSet: ReadonlySet<string>): boolean {
  const raw = attrs.get('role');
  if (!raw) return false;
  return raw.trim().toLowerCase().split(/\s+/).some((r) => roleSet.has(r));
}

/** Any interactive element: the target of SC 2.5.8. */
function isInteractiveRule(rule: CssRule): boolean {
  if (rule.tag && rule.attrs) {
    if (rule.tag === 'button' || rule.tag === 'select' || rule.tag === 'textarea') return true;
    if (rule.tag === 'a') return rule.attrs.has('href');
    if (rule.tag === 'input') return (rule.attrs.get('type') ?? '').trim().toLowerCase() !== 'hidden';
    return hasAttrRole(rule.attrs, INTERACTIVE_ROLE_SET);
  }
  return rule.selector.split(',').some((sel) => {
    const last = lastCompound(sel.trim());
    if (PSEUDO_ELEMENT_RE.test(last)) return false;
    return INTERACTIVE_TAG_RE.test(last) || INTERACTIVE_ROLE_RE.test(last) || INTERACTIVE_CLASS_RE.test(last);
  });
}

/** Form controls identified by their boundary: the subject of SC 1.4.11. */
function isBoundaryControlRule(rule: CssRule): boolean {
  if (rule.tag && rule.attrs) {
    if (rule.tag === 'select' || rule.tag === 'textarea') return true;
    if (rule.tag === 'input') {
      const t = (rule.attrs.get('type') ?? '').trim().toLowerCase();
      return t !== 'hidden' && t !== 'submit' && t !== 'reset' && t !== 'button' && t !== 'image';
    }
    return hasAttrRole(rule.attrs, BOUNDARY_ROLE_SET);
  }
  return rule.selector.split(',').some((sel) => {
    const last = lastCompound(sel.trim());
    if (PSEUDO_ELEMENT_RE.test(last)) return false;
    if (/\[type\s*=\s*["']?(?:hidden|submit|reset|button|image)\b/i.test(last)) return false;
    return BOUNDARY_TAG_RE.test(last) || BOUNDARY_ROLE_RE.test(last);
  });
}

const FOCUS_PSEUDO_RE = /(?<!:):focus(?![a-z0-9_-])/i;
const FOCUS_VISIBLE_PSEUDO_RE = /(?<!:):focus-visible(?![a-z0-9_-])/i;
const SINGLE_COLON_PSEUDO_ELEMENT_RE = /^:(?:before|after|first-line|first-letter)(?![a-z0-9_-])/i;

function maskAttributeBrackets(selector: string): string {
  const out: string[] = [];
  let bracketDepth = 0;
  let quote: '\'' | '"' | null = null;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i]!;
    if (bracketDepth > 0) {
      if (quote !== null) {
        if (ch === '\\') {
          i += 1;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '\'' || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === ']') {
        bracketDepth -= 1;
        if (bracketDepth === 0) out.push(']');
      }
      continue;
    }
    if (ch === '[') {
      bracketDepth = 1;
      out.push('[');
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

function hasTopLevelPseudoElement(masked: string): boolean {
  let parenDepth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(') {
      parenDepth += 1;
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (parenDepth !== 0) continue;
    if (ch === ':' && masked[i + 1] === ':') return true;
    if (ch === ':' && SINGLE_COLON_PSEUDO_ELEMENT_RE.test(masked.slice(i))) return true;
  }
  return false;
}

function extractBalancedNotArgs(masked: string): { outer: string; notArgs: string[] } {
  const outerParts: string[] = [];
  const notArgs: string[] = [];
  let i = 0;
  while (i < masked.length) {
    if (
      masked[i] === ':' &&
      masked.slice(i, i + 5).toLowerCase() === ':not(' &&
      (i === 0 || masked[i - 1] !== ':')
    ) {
      let depth = 1;
      let j = i + 5;
      while (j < masked.length && depth > 0) {
        if (masked[j] === '(') depth += 1;
        else if (masked[j] === ')') depth -= 1;
        j += 1;
      }
      notArgs.push(masked.slice(i + 5, depth === 0 ? j - 1 : j));
      outerParts.push(' ');
      i = j;
      continue;
    }
    outerParts.push(masked[i]!);
    i += 1;
  }
  return { outer: outerParts.join(''), notArgs };
}

type FocusSelectorClassification = {
  hasDirectFocus: boolean;
  hasFocusVisibleCompanionTarget: boolean;
  hasClickOnly: boolean;
};

function classifyFocusSelector(rule: CssRule): FocusSelectorClassification {
  if (rule.tag !== null) {
    return { hasDirectFocus: false, hasFocusVisibleCompanionTarget: false, hasClickOnly: false };
  }
  let hasDirectFocus = false;
  let hasFocusVisibleCompanionTarget = false;
  let hasClickOnly = false;

  for (const item of splitTopLevelCommas(rule.selector)) {
    const masked = maskAttributeBrackets(item);
    if (hasTopLevelPseudoElement(masked)) continue;
    const { outer, notArgs } = extractBalancedNotArgs(masked);
    const hasFocusVisibleOutsideNot = FOCUS_VISIBLE_PSEUDO_RE.test(outer);
    const hasFocusOutsideNot = FOCUS_PSEUDO_RE.test(outer);
    const hasNotFocusVisible = notArgs.some((arg) => FOCUS_VISIBLE_PSEUDO_RE.test(arg));

    if ((hasFocusOutsideNot || hasFocusVisibleOutsideNot) && !hasNotFocusVisible) {
      hasDirectFocus = true;
    }
    if (hasFocusVisibleOutsideNot && !hasNotFocusVisible) {
      hasFocusVisibleCompanionTarget = true;
    }
    if (hasFocusOutsideNot && hasNotFocusVisible) {
      hasClickOnly = true;
    }
  }

  return { hasDirectFocus, hasFocusVisibleCompanionTarget, hasClickOnly };
}

function isHeadingDefaultLarge(rule: CssRule): boolean {
  const target = rule.tag ?? rule.selector.split(',').map((s) => lastCompound(s.trim())).join(',');
  return target.split(',').every((t) => /^h[12](?=$|[.#:[])/i.test(t.trim()));
}

function isLargeText(rule: CssRule, decls: Decl[], headingDefaultLarge?: boolean): boolean {
  const fsDecl = lastDecl(decls, ['font-size']);
  const weightDecl = lastDecl(decls, ['font-weight']);
  const w = weightDecl?.value.trim().toLowerCase();
  const bold = w === 'bold' || w === 'bolder' || (w !== undefined && Number(w) >= 700);
  if (fsDecl) {
    const px = lengthToPx(fsDecl.value);
    if (px === null) return false;
    return px >= WCAG_LARGE_TEXT_PX || (bold && px >= WCAG_LARGE_BOLD_TEXT_PX);
  }
  // UA defaults: h1 = 2em (32px), h2 = 1.5em (24px) on a 16px root.
  return headingDefaultLarge ?? isHeadingDefaultLarge(rule);
}

// ── Rules ─────────────────────────────────────────────────────────────

type Hit = { snippet: string; detail: string };

function snippetOf(rule: CssRule): string {
  const raw = rule.tag ? `${rule.selector}` : `${rule.selector} { ${rule.body} }`;
  return sanitizeLintText(raw, 200);
}

function worst(verdicts: Verdict[]): Verdict {
  const fail = verdicts.find((v) => v.kind === 'fail');
  if (fail) return fail;
  return verdicts.find((v) => v.kind === 'unresolved') ?? { kind: 'pass' };
}

function textVerdict(
  rule: CssRule,
  decls: Decl[],
  spec: A11yTextContrastRuleSpec,
  headingDefaultLarge?: boolean,
): Verdict | null {
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
  const fg = compositeIfTranslucent(fgRaw, bg.color);
  const ratio = contrastRatio(fg, bg.color);
  const min = isLargeText(rule, decls, headingDefaultLarge) ? spec.largeRatio : spec.normalRatio;
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

function uiVerdict(decls: Decl[], backdrop: Backdrop, spec: A11yUiContrastRuleSpec): Verdict | null {
  const fill = readBackground(decls);
  const border = readBorder(decls);
  const rings = readRingShadows(decls);
  const indicators: ColorRead[] = [];
  if (fill && fill.kind !== 'none') indicators.push(fill);
  if (border.color) indicators.push(border.color);
  if (indicators.length > 0 || border.cleared) {
    indicators.push(...rings);
  }
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
    const effective = compositeIfTranslucent(ind.color, backdrop.color);
    best = Math.max(best, contrastRatio(effective, backdrop.color));
  }
  if (best + 1e-9 >= spec.minRatio) return { kind: 'pass' };
  if (unresolved) return { kind: 'unresolved', reason: unresolved };
  return { kind: 'fail', ratio: best };
}

function targetVerdict(decls: Decl[], spec: A11yTargetSizeRuleSpec): Verdict | null {
  const axis = (size: string, min: string): number | null => {
    const s = lastDecl(decls, [size]);
    const px = s ? lengthToPx(s.value) : null;
    if (px === null) return null;
    const m = lastDecl(decls, [min]);
    const minPx = m ? lengthToPx(m.value) : null;
    return Math.max(px, minPx ?? 0);
  };
  const w = axis('width', 'min-width');
  const h = axis('height', 'min-height');
  const smallest = Math.min(w ?? Infinity, h ?? Infinity);
  if (smallest === Infinity) return null;
  return smallest + 1e-9 >= spec.minPx ? { kind: 'pass' } : { kind: 'fail', ratio: smallest };
}

function evaluateFocusAppearanceTheme(
  decls: Decl[],
  backdrop: Backdrop,
  spec: A11yFocusAppearanceRuleSpec,
): string | null {
  const outline = readOutlineState(decls);
  if (outline.style === 'auto') return null;

  if (outline.declared && !outline.suppressed) {
    if (outline.widthPx !== null && outline.widthPx + 1e-9 < spec.minPx) {
      return `outline ${outline.widthPx}px < ${spec.minPx}px`;
    }
    if (backdrop.kind === 'color' && outline.color?.kind === 'color') {
      const ratio = contrastRatio(
        compositeIfTranslucent(outline.color.color, backdrop.color),
        backdrop.color,
      );
      if (ratio + 1e-9 < spec.minRatio) {
        return `outline ${ratio.toFixed(2)}:1 < ${spec.minRatio}:1`;
      }
    }
    return null;
  }

  const rings = parseBoxShadowLayers(decls).filter((l) => l.isOuterRing && l.color.kind !== 'none');
  if (rings.length === 0) return null;
  if (!rings.every((r) => r.spreadPx !== null)) return null;

  let maxSpread = 0;
  for (const r of rings) {
    if (r.spreadPx! > maxSpread) maxSpread = r.spreadPx!;
  }
  if (maxSpread + 1e-9 < spec.minPx) {
    return `ring spread ${maxSpread}px < ${spec.minPx}px`;
  }

  const wideRings = rings.filter((r) => r.spreadPx! + 1e-9 >= spec.minPx);
  if (wideRings.length === 0 || backdrop.kind !== 'color') return null;
  if (!wideRings.every((r) => r.color.kind === 'color')) return null;

  let bestRatio = 0;
  for (const r of wideRings) {
    if (r.color.kind !== 'color') continue;
    const ratio = contrastRatio(compositeIfTranslucent(r.color.color, backdrop.color), backdrop.color);
    if (ratio > bestRatio) bestRatio = ratio;
  }
  if (bestRatio + 1e-9 < spec.minRatio) {
    return `ring ${bestRatio.toFixed(2)}:1 < ${spec.minRatio}:1`;
  }
  return null;
}

// ── Accessible names & Level A structure rules ────────────────────────

const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const NAMED_ROLE_SET = new Set([
  'button', 'link', 'checkbox', 'switch', 'tab', 'menuitem', 'radio', 'option',
]);

function hasAriaOrTitleName(attrs: Map<string, string>, elementIds: ReadonlySet<string>): boolean {
  const label = attrs.get('aria-label');
  if (label && label.trim()) return true;
  const by = attrs.get('aria-labelledby');
  if (by && by.split(/\s+/).some((id) => id.length > 0 && elementIds.has(id))) return true;
  const title = attrs.get('title');
  return Boolean(title && title.trim());
}

function mergeRanges(ranges: Array<readonly [number, number]>): Array<readonly [number, number]> {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [[sorted[0]![0], sorted[0]![1]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const [s, e] = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (s < last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

function lowerBound(arr: readonly number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function hasOffsetInRange(offsets: readonly number[], loOffset: number, hiOffset: number): boolean {
  if (loOffset >= hiOffset || offsets.length === 0) return false;
  const idx = lowerBound(offsets, loOffset);
  return idx < offsets.length && offsets[idx]! < hiOffset;
}

function findStrictInnerRange(
  mergedRanges: ReadonlyArray<readonly [number, number]>,
  pos: number,
): boolean {
  let lo = 0;
  let hi = mergedRanges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const range = mergedRanges[mid]!;
    if (pos <= range[0]) hi = mid - 1;
    else if (pos >= range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function filterOffsetsOutsideRanges(
  offsets: readonly number[],
  mergedExcluded: ReadonlyArray<readonly [number, number]>,
): readonly number[] {
  if (mergedExcluded.length === 0 || offsets.length === 0) return offsets;
  const out: number[] = [];
  let rIdx = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    const off = offsets[i]!;
    while (rIdx < mergedExcluded.length && mergedExcluded[rIdx]![1] <= off) {
      rIdx += 1;
    }
    if (rIdx < mergedExcluded.length && off >= mergedExcluded[rIdx]![0]) {
      continue;
    }
    out.push(off);
  }
  return out;
}

function missingNames(html: string, doc: HtmlDocumentScanResult): Hit[] {
  const openStacks = new Map<string, HtmlScannedTag[]>();
  const labelFor = new Set<string>();
  const rawLabelCandidates: Array<{
    textStart: number;
    textEnd: number;
    rangeStart: number;
    rangeEnd: number;
  }> = [];
  const selectRanges: Array<readonly [number, number]> = [];
  const pairedButtons: Array<{ open: HtmlScannedTag; close: HtmlScannedTag }> = [];
  const pairedLinks: Array<{ open: HtmlScannedTag; close: HtmlScannedTag }> = [];
  const pairedRoles: Array<{ open: HtmlScannedTag; close: HtmlScannedTag }> = [];
  const formControls: HtmlScannedTag[] = [];

  for (const tag of doc.tags) {
    if (!tag.isClose) {
      if (tag.tagName === 'label') {
        const target = tag.attrs.get('for')?.trim();
        if (target) labelFor.add(target);
      }
      if (tag.tagName === 'input' || tag.tagName === 'select' || tag.tagName === 'textarea') {
        formControls.push(tag);
      }
      if (!tag.selfClosing && !VOID_HTML_TAGS.has(tag.tagName)) {
        let stack = openStacks.get(tag.tagName);
        if (!stack) {
          stack = [];
          openStacks.set(tag.tagName, stack);
        }
        stack.push(tag);
      }
      continue;
    }

    const stack = openStacks.get(tag.tagName);
    const open = stack?.pop();
    if (!open) continue;

    if (open.tagName === 'label') {
      rawLabelCandidates.push({
        textStart: open.end,
        textEnd: tag.start,
        rangeStart: open.start,
        rangeEnd: tag.end,
      });
    } else if (open.tagName === 'select') {
      selectRanges.push([open.start, tag.end]);
    } else if (open.tagName === 'button') {
      pairedButtons.push({ open, close: tag });
    } else if (open.tagName === 'a') {
      pairedLinks.push({ open, close: tag });
    } else if (hasAttrRole(open.attrs, NAMED_ROLE_SET)) {
      pairedRoles.push({ open, close: tag });
    }
  }

  const mergedSelectRanges = mergeRanges(selectRanges);
  const nonFormTextOffsets = filterOffsetsOutsideRanges(doc.nonEmptyTextOffsets, mergedSelectRanges);
  const labelRanges: Array<readonly [number, number]> = [];
  for (const cand of rawLabelCandidates) {
    if (hasOffsetInRange(nonFormTextOffsets, cand.textStart, cand.textEnd)) {
      labelRanges.push([cand.rangeStart, cand.rangeEnd]);
    }
  }
  const mergedLabelRanges = mergeRanges(labelRanges);

  pairedButtons.sort((a, b) => a.open.start - b.open.start);
  pairedLinks.sort((a, b) => a.open.start - b.open.start);
  pairedRoles.sort((a, b) => a.open.start - b.open.start);

  const insideLabel = (pos: number) => findStrictInnerRange(mergedLabelRanges, pos);
  const hits: Hit[] = [];
  const push = (snippet: string, detail: string) =>
    hits.push({ snippet: sanitizeLintText(snippet, 200), detail: sanitizeLintText(detail, 200) });
  const boundedSlice = (start: number, end: number) => html.slice(start, Math.min(end, start + 2048));

  for (const { open, close } of pairedButtons) {
    if (
      !hasAriaOrTitleName(open.attrs, doc.elementIds) &&
      !hasOffsetInRange(doc.nonEmptyTextOffsets, open.end, close.start)
    ) {
      push(boundedSlice(open.start, close.end), '<button> has no text or label');
    }
  }
  for (const { open, close } of pairedLinks) {
    if (!open.attrs.has('href')) continue;
    if (
      !hasAriaOrTitleName(open.attrs, doc.elementIds) &&
      !hasOffsetInRange(doc.nonEmptyTextOffsets, open.end, close.start)
    ) {
      push(boundedSlice(open.start, close.end), 'link has no text or label');
    }
  }
  for (const { open, close } of pairedRoles) {
    if (
      !hasAriaOrTitleName(open.attrs, doc.elementIds) &&
      !hasOffsetInRange(doc.nonEmptyTextOffsets, open.end, close.start)
    ) {
      push(boundedSlice(open.start, close.end), `role element <${open.tagName}> has no text or label`);
    }
  }
  for (const tag of formControls) {
    if (tag.tagName === 'input') {
      const type = (tag.attrs.get('type') ?? 'text').trim().toLowerCase() || 'text';
      if (type === 'hidden' || type === 'submit' || type === 'reset') continue;
      if (type === 'button' && (tag.attrs.get('value') ?? '').trim()) continue;
      if (type === 'image' && (tag.attrs.get('alt') ?? '').trim()) continue;
    }
    const id = tag.attrs.get('id')?.trim();
    if (hasAriaOrTitleName(tag.attrs, doc.elementIds) || (id && labelFor.has(id)) || insideLabel(tag.start)) {
      continue;
    }
    push(boundedSlice(tag.start, tag.end), `<${tag.tagName}> has no associated label`);
  }
  return hits;
}

function missingImgAlts(html: string, doc: HtmlDocumentScanResult): Hit[] {
  const hits: Hit[] = [];
  for (const tag of doc.tags) {
    if (tag.isClose || tag.tagName !== 'img') continue;
    const roles = (tag.attrs.get('role') ?? '').trim().toLowerCase().split(/\s+/);
    if (roles.some((r) => r === 'presentation' || r === 'none')) continue;
    if ((tag.attrs.get('aria-hidden') ?? '').trim().toLowerCase() === 'true') continue;
    if ((tag.attrs.get('aria-label') ?? '').trim().length > 0) continue;
    const labelledBy = tag.attrs.get('aria-labelledby');
    if (labelledBy && labelledBy.split(/\s+/).some((id) => id.length > 0 && doc.elementIds.has(id))) {
      continue;
    }
    const hasAlt = tag.attrs.has('alt');
    const altVal = tag.attrs.get('alt') ?? '';
    if (!hasAlt) {
      hits.push({ snippet: sanitizeLintText(html.slice(tag.start, tag.end), 200), detail: 'missing alt attribute' });
    } else if (altVal.length > 0 && altVal.trim().length === 0) {
      hits.push({
        snippet: sanitizeLintText(html.slice(tag.start, tag.end), 200),
        detail: 'whitespace-only alt attribute',
      });
    }
  }
  return hits;
}

function missingPageTitle(html: string, doc: HtmlDocumentScanResult): Hit | null {
  let firstHtml: HtmlScannedTag | null = null;
  let firstHeadIdx = -1;
  for (let i = 0; i < doc.tags.length; i += 1) {
    const t = doc.tags[i]!;
    if (!t.isClose && t.tagName === 'html' && !firstHtml) firstHtml = t;
    if (!t.isClose && t.tagName === 'head' && firstHeadIdx === -1) firstHeadIdx = i;
  }
  const firstHead = firstHeadIdx >= 0 ? doc.tags[firstHeadIdx]! : null;
  if (!firstHtml && !firstHead) return null;

  const hasNonEmptyTitle = (fromIdx: number, stopAtHeadBoundary: boolean): boolean => {
    for (let i = fromIdx; i < doc.tags.length; i += 1) {
      const t = doc.tags[i]!;
      if (stopAtHeadBoundary && ((t.isClose && t.tagName === 'head') || (!t.isClose && t.tagName === 'body'))) {
        break;
      }
      if (!t.isClose && t.tagName === 'title') {
        const next = doc.tags[i + 1];
        if (next && next.isClose && next.tagName === 'title' && html.slice(t.end, next.start).trim().length > 0) {
          return true;
        }
      }
    }
    return false;
  };

  if (firstHead) {
    if (hasNonEmptyTitle(firstHeadIdx + 1, true)) return null;
  } else if (hasNonEmptyTitle(0, false)) {
    return null;
  }

  const anchor = firstHead ?? firstHtml!;
  return {
    snippet: sanitizeLintText(html.slice(anchor.start, anchor.end), 200),
    detail: 'missing non-empty <title>',
  };
}

function missingHtmlLang(html: string, doc: HtmlDocumentScanResult): Hit | null {
  const firstHtml = doc.tags.find((t) => !t.isClose && t.tagName === 'html');
  if (!firstHtml) return null;
  const hasLang = firstHtml.attrs.has('lang');
  const rawLang = firstHtml.attrs.get('lang') ?? '';
  if (hasLang && rawLang.trim().length > 0) return null;
  return {
    snippet: sanitizeLintText(html.slice(firstHtml.start, firstHtml.end), 200),
    detail: hasLang && rawLang.length > 0 ? '<html> tag has blank lang attribute' : '<html> tag has no lang attribute',
  };
}

// ── Entry point ───────────────────────────────────────────────────────

/** Embedded prose SC reference (distinct from `formatArtifactLintCompliance` bracket provenance). */
function formatComplianceMessageRef(ref: ArtifactLintComplianceRef): string {
  return `${ref.standard.replace('-', ' ')} SC ${ref.sc}`;
}

function sanitizeDetail(raw: string): string {
  return sanitizeLintText(raw, MAX_UNRESOLVED_DETAIL_LEN);
}

function emitImgAltFinding(
  html: string,
  doc: HtmlDocumentScanResult,
  spec: A11yImgAltRuleSpec | null,
  out: ArtifactLintFinding[],
): void {
  if (!spec) return;
  const hits = missingImgAlts(html, doc);
  if (hits.length === 0) return;
  const first = hits[0]!;
  out.push({
    severity: spec.severity,
    id: A11Y_RULE_IDS.imgAlt,
    message: `${hits.length} <img> element(s) missing alternative text (${formatComplianceMessageRef(spec.compliance)}); first: ${first.detail}.`,
    fix: 'Add a descriptive alt="..." attribute describing the image purpose (no whitespace-only alt="   "), or mark decorative images with alt="" (or role="presentation" / role="none" / aria-hidden="true").',
    snippet: first.snippet,
    compliance: spec.compliance,
  });
}

function emitPageTitleFinding(
  html: string,
  doc: HtmlDocumentScanResult,
  spec: A11yPageTitleRuleSpec | null,
  out: ArtifactLintFinding[],
): void {
  if (!spec) return;
  const hit = missingPageTitle(html, doc);
  if (!hit) return;
  out.push({
    severity: spec.severity,
    id: A11Y_RULE_IDS.pageTitle,
    message: `HTML document is missing a non-empty <title> element (${formatComplianceMessageRef(spec.compliance)}).`,
    fix: 'Add a concise, descriptive <title>...</title> inside <head> (create <head><title>Page Title</title></head> inside <html> if omitted).',
    snippet: hit.snippet,
    compliance: spec.compliance,
  });
}

function emitHtmlLangFinding(
  html: string,
  doc: HtmlDocumentScanResult,
  spec: A11yHtmlLangRuleSpec | null,
  out: ArtifactLintFinding[],
): void {
  if (!spec) return;
  const hit = missingHtmlLang(html, doc);
  if (!hit) return;
  out.push({
    severity: spec.severity,
    id: A11Y_RULE_IDS.htmlLang,
    message: `Document <html> root element is missing a non-empty lang attribute (${formatComplianceMessageRef(spec.compliance)}): ${hit.detail}.`,
    fix: 'Declare the primary document language with a valid BCP 47 tag on the root element, e.g. <html lang="en"> or <html lang="zh-Hant">.',
    snippet: hit.snippet,
    compliance: spec.compliance,
  });
}

function emitFocusOutlineFinding(
  directFails: readonly string[],
  standaloneClickFails: readonly string[],
  spec: A11yFocusOutlineRuleSpec | null,
  out: ArtifactLintFinding[],
): void {
  if (!spec) return;
  if (directFails.length > 0) {
    out.push({
      severity: spec.severity,
      id: A11Y_RULE_IDS.focusOutline,
      message: `${directFails.length} focus selector rule(s) suppress outline without a visible replacement indicator (${formatComplianceMessageRef(spec.compliance)}).`,
      fix: 'Restore the focus outline or provide a visible replacement (crisp outer ring box-shadow, high-contrast background/border, or inline :root --focus-ring definition if using tokens). To suppress mouse focus rings safely, pair :focus:not(:focus-visible) { outline: none } with a visible :focus-visible rule.',
      snippet: directFails[0]!,
      compliance: spec.compliance,
    });
    return;
  }
  if (standaloneClickFails.length > 0) {
    out.push({
      severity: spec.severity,
      id: A11Y_RULE_IDS.focusOutline,
      message: `${standaloneClickFails.length} standalone :focus:not(:focus-visible) rule(s) suppress focus outline with no companion visible :focus-visible rule (${formatComplianceMessageRef(spec.compliance)}).`,
      fix: 'Add a visible :focus-visible rule (for example, outline: 2px solid currentColor; outline-offset: 2px or a crisp box-shadow ring) alongside :focus:not(:focus-visible) { outline: none } so keyboard focus stays visible.',
      snippet: standaloneClickFails[0]!,
      compliance: spec.compliance,
    });
  }
}

function emitFocusAppearanceFinding(
  fails: readonly Hit[],
  spec: A11yFocusAppearanceRuleSpec | null,
  out: ArtifactLintFinding[],
): void {
  if (!spec || fails.length === 0) return;
  const first = fails[0]!;
  out.push({
    severity: spec.severity,
    id: A11Y_RULE_IDS.focusAppearance,
    message: `${fails.length} focus indicator(s) below ${formatComplianceMessageRef(spec.compliance)} (min ${spec.minPx} CSS px, ${spec.minRatio}:1 contrast); first: ${first.detail}.`,
    fix: `Use at least a ${spec.minPx}px solid outline or outer box-shadow focus ring whose contrast against the page background reaches ${spec.minRatio}:1.`,
    snippet: first.snippet,
    compliance: spec.compliance,
  });
}

/**
 * Run the accessibility rules enabled by `profile`. `themes` are the
 * per-theme token maps the anti-slop linter already derives from global
 * theme scopes, and `resolveVars` is its `var()` resolver, so both linters
 * agree on what a token renders as in every theme.
 */
const EXTRACT_VAR_NAME_RE = /var\(\s*(--[\w-]+)/g;

function extractReferencedVarNames(cssText: string): string[] {
  if (!cssText.includes('var(')) return [];
  const names = new Set<string>();
  EXTRACT_VAR_NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXTRACT_VAR_NAME_RE.exec(cssText)) !== null) {
    const name = m[1];
    if (name) names.add(name);
  }
  return Array.from(names);
}

type LayeredTokenMapLike = ReadonlyMap<string, string> & {
  readonly layerBase?: ReadonlyMap<string, string>;
  readonly layerOwn?: ReadonlyMap<string, string>;
};

function addReverseVarDeps(
  entries: Iterable<readonly [string, string]>,
  reverseDeps: Map<string, Set<string>>,
): void {
  for (const [k, v] of entries) {
    if (!v.includes('var(')) continue;
    for (const ref of extractReferencedVarNames(v)) {
      let holders = reverseDeps.get(ref);
      if (!holders) {
        holders = new Set<string>();
        reverseDeps.set(ref, holders);
      }
      holders.add(k);
    }
  }
}

function computeVaryingTokens(themeMaps: readonly ReadonlyMap<string, string>[]): Set<string> {
  const varying = new Set<string>();
  if (themeMaps.length <= 1) return varying;

  const reverseDeps = new Map<string, Set<string>>();
  const queue: string[] = [];
  const sharedBase = (themeMaps[0] as LayeredTokenMapLike).layerBase;
  const allShareLayeredBase =
    sharedBase !== undefined &&
    themeMaps.every((m) => {
      const lm = m as LayeredTokenMapLike;
      return lm.layerBase === sharedBase && lm.layerOwn !== undefined;
    });

  if (allShareLayeredBase) {
    addReverseVarDeps(sharedBase.entries(), reverseDeps);
    const ownCount = new Map<string, number>();
    const firstOwnVal = new Map<string, string>();
    for (const map of themeMaps) {
      const own = (map as LayeredTokenMapLike).layerOwn!;
      addReverseVarDeps(own.entries(), reverseDeps);
      for (const [k, v] of own) {
        ownCount.set(k, (ownCount.get(k) ?? 0) + 1);
        const prev = firstOwnVal.get(k);
        if (prev === undefined && !firstOwnVal.has(k)) {
          firstOwnVal.set(k, v);
        } else if (prev !== v && !varying.has(k)) {
          varying.add(k);
          queue.push(k);
        }
      }
    }
    const totalThemes = themeMaps.length;
    for (const [key, count] of ownCount) {
      if (!varying.has(key) && count < totalThemes && firstOwnVal.get(key) !== sharedBase.get(key)) {
        varying.add(key);
        queue.push(key);
      }
    }
  } else {
    const allKeys = new Set<string>();
    for (const map of themeMaps) {
      addReverseVarDeps(map.entries(), reverseDeps);
      for (const k of map.keys()) {
        allKeys.add(k);
      }
    }

    const base = themeMaps[0]!;
    for (const key of allKeys) {
      const expected = base.get(key);
      for (let i = 1; i < themeMaps.length; i += 1) {
        if (themeMaps[i]!.get(key) !== expected) {
          varying.add(key);
          queue.push(key);
          break;
        }
      }
    }
  }

  while (queue.length > 0) {
    const ref = queue.pop()!;
    const holders = reverseDeps.get(ref);
    if (!holders) continue;
    for (const holder of holders) {
      if (!varying.has(holder)) {
        varying.add(holder);
        queue.push(holder);
      }
    }
  }

  return varying;
}

type ThemePartitionGroup = {
  repIdx: number;
  indices: number[];
};

function filterPageScopeRules(rules: readonly CssRule[]): CssRule[] {
  return rules.filter((rule) => {
    if (rule.tag) return false;
    const sels = rule.selector.split(',').map((s) => s.trim());
    return sels.includes('body') || sels.includes('html') || sels.includes(':root');
  });
}

function backdropKey(b: Backdrop): string {
  return b.kind === 'color'
    ? `c:${b.color.r},${b.color.g},${b.color.b},${b.color.a}`
    : `u:${b.reason}`;
}

type ThemePartitioner = (relevantVars: readonly string[]) => ThemePartitionGroup[] | null;

type ClickOnlyFocusCandidate = {
  snippet: string;
  allThemes?: boolean;
  suppressedByTheme?: boolean[];
};

interface RuleEvaluationContext {
  profile: A11yComplianceProfile;
  themeCount: number;
  uniqueBackdrops: readonly Backdrop[];
  themeToBackdropIdx: Int32Array;
  themeHasCompanionFocusVisible: boolean[];
  clickOnlyCandidates: ClickOnlyFocusCandidate[];
  textWorstCache: Map<string, Verdict | null>;
  targetWorstCache: Map<string, Verdict | null>;
  textFails: Hit[];
  uiFails: Hit[];
  targetFails: Hit[];
  unresolved: Hit[];
  focusDirectFails: string[];
  focusAppearanceFails: Hit[];
}

/** Build a memoized theme partitioner keyed by relevant varying token signatures. */
function createThemePartitioner(themeMaps: readonly ReadonlyMap<string, string>[]): ThemePartitioner {
  const themeCount = themeMaps.length;
  const partitionCache = new Map<string, ThemePartitionGroup[]>();
  return (relevantVars: readonly string[]): ThemePartitionGroup[] | null => {
    if (relevantVars.length === 0) return null;
    const cacheKey = relevantVars.join('\u0000');
    const cached = partitionCache.get(cacheKey);
    if (cached) return cached;
    const groupsMap = new Map<string, ThemePartitionGroup>();
    for (let i = 0; i < themeCount; i += 1) {
      const t = themeMaps[i]!;
      let sig = '';
      for (let j = 0; j < relevantVars.length; j += 1) {
        const val = t.get(relevantVars[j]!);
        sig += j === 0 ? (val ?? '\u0001') : `\u0000${val ?? '\u0001'}`;
      }
      let group = groupsMap.get(sig);
      if (!group) {
        group = { repIdx: i, indices: [] };
        groupsMap.set(sig, group);
      }
      group.indices.push(i);
    }
    const groups = Array.from(groupsMap.values());
    partitionCache.set(cacheKey, groups);
    return groups;
  };
}

/** Deduplicate resolved page backdrops across theme partitions for UI contrast and focus appearance checks. */
function resolveUniquePageBackdrops(
  rules: readonly CssRule[],
  themeMaps: readonly ReadonlyMap<string, string>[],
  varyingTokens: ReadonlySet<string>,
  getPartition: ThemePartitioner,
  resolveVars: ResolveVars,
): { uniqueBackdrops: Backdrop[]; themeToBackdropIdx: Int32Array } {
  const themeCount = themeMaps.length;
  const uniqueBackdrops: Backdrop[] = [];
  const themeToBackdropIdx = new Int32Array(themeCount);
  const pageRules = filterPageScopeRules(rules);
  const pageVarsSet = new Set<string>();
  for (const pr of pageRules) {
    for (const v of extractReferencedVarNames(pr.body)) {
      if (varyingTokens.has(v)) pageVarsSet.add(v);
    }
  }
  const pageVars = Array.from(pageVarsSet).sort();
  const backdropMap = new Map<string, number>();
  const registerBackdrop = (b: Backdrop): number => {
    const k = backdropKey(b);
    const existing = backdropMap.get(k);
    if (existing !== undefined) return existing;
    const idx = uniqueBackdrops.length;
    uniqueBackdrops.push(b);
    backdropMap.set(k, idx);
    return idx;
  };
  const pagePartition = getPartition(pageVars);
  if (!pagePartition) {
    const b = pageBackdrop(pageRules, (body) =>
      body.includes('var(') ? resolveVars(body, themeMaps[0]!) : body,
    );
    registerBackdrop(b);
    themeToBackdropIdx.fill(0);
  } else {
    for (const grp of pagePartition) {
      const t = themeMaps[grp.repIdx]!;
      const b = pageBackdrop(pageRules, (body) => resolveVars(body, t));
      const bIdx = registerBackdrop(b);
      for (const ti of grp.indices) themeToBackdropIdx[ti] = bIdx;
    }
  }
  return { uniqueBackdrops, themeToBackdropIdx };
}

/** Evaluate a CSS rule whose declarations do not vary across theme partitions. */
function evaluateUniformRule(rule: CssRule, decls: Decl[], ctx: RuleEvaluationContext): void {
  const { textContrast, uiContrast, targetSize, focusOutline, focusAppearance } = ctx.profile;

  if (textContrast) {
    const v = textVerdict(rule, decls, textContrast);
    if (v?.kind === 'fail') ctx.textFails.push({ snippet: snippetOf(rule), detail: `${v.ratio.toFixed(2)}:1` });
    else if (v?.kind === 'unresolved') ctx.unresolved.push({ snippet: snippetOf(rule), detail: `text: ${v.reason}` });
  }
  if (uiContrast && isBoundaryControlRule(rule)) {
    const ui: Verdict[] = [];
    for (const b of ctx.uniqueBackdrops) {
      const v = uiVerdict(decls, b, uiContrast);
      if (v) ui.push(v);
    }
    if (ui.length > 0) {
      const v = worst(ui);
      if (v.kind === 'fail') ctx.uiFails.push({ snippet: snippetOf(rule), detail: `${v.ratio.toFixed(2)}:1` });
      else if (v.kind === 'unresolved') ctx.unresolved.push({ snippet: snippetOf(rule), detail: `control: ${v.reason}` });
    }
  }
  if (targetSize && isInteractiveRule(rule)) {
    const v = targetVerdict(decls, targetSize);
    if (v?.kind === 'fail') ctx.targetFails.push({ snippet: snippetOf(rule), detail: `${v.ratio}px` });
  }
  if (focusOutline || focusAppearance) {
    const cls = classifyFocusSelector(rule);
    if (focusOutline && (cls.hasDirectFocus || cls.hasFocusVisibleCompanionTarget || cls.hasClickOnly)) {
      const outlineState = readOutlineState(decls);
      const compensated = outlineState.suppressed ? hasVisibleFocusCompensation(decls) : false;
      if (cls.hasFocusVisibleCompanionTarget && (!outlineState.suppressed || compensated)) {
        ctx.themeHasCompanionFocusVisible.fill(true);
      }
      if (cls.hasDirectFocus && outlineState.suppressed && !compensated) {
        ctx.focusDirectFails.push(snippetOf(rule));
      }
      if (cls.hasClickOnly && outlineState.suppressed && !compensated) {
        ctx.clickOnlyCandidates.push({ snippet: snippetOf(rule), allThemes: true });
      }
    }
    if (focusAppearance && cls.hasDirectFocus) {
      for (const b of ctx.uniqueBackdrops) {
        const failDetail = evaluateFocusAppearanceTheme(decls, b, focusAppearance);
        if (failDetail !== null) {
          ctx.focusAppearanceFails.push({ snippet: snippetOf(rule), detail: failDetail });
          break;
        }
      }
    }
  }
}

/** Evaluate focus-outline suppression and focus-appearance across theme partitions for a single rule. */
function evaluatePartitionedFocus(
  rule: CssRule,
  partition: readonly ThemePartitionGroup[],
  declsByGroup: Decl[][],
  ctx: RuleEvaluationContext,
): void {
  const { focusOutline, focusAppearance } = ctx.profile;
  if (!focusOutline && !focusAppearance) return;

  const cls = classifyFocusSelector(rule);
  if (focusOutline && (cls.hasDirectFocus || cls.hasFocusVisibleCompanionTarget || cls.hasClickOnly)) {
    let ruleDirectFailed = false;
    const suppressedByTheme = cls.hasClickOnly ? new Array<boolean>(ctx.themeCount).fill(false) : null;
    let anyClickSuppressed = false;
    for (let gIdx = 0; gIdx < partition.length; gIdx += 1) {
      const grp = partition[gIdx]!;
      const decls = declsByGroup[gIdx]!;
      const outlineState = readOutlineState(decls);
      const compensated = outlineState.suppressed ? hasVisibleFocusCompensation(decls) : false;
      if (cls.hasFocusVisibleCompanionTarget && (!outlineState.suppressed || compensated)) {
        for (const ti of grp.indices) ctx.themeHasCompanionFocusVisible[ti] = true;
      }
      if (!ruleDirectFailed && cls.hasDirectFocus && outlineState.suppressed && !compensated) {
        ruleDirectFailed = true;
        ctx.focusDirectFails.push(snippetOf(rule));
      }
      if (suppressedByTheme && outlineState.suppressed && !compensated) {
        anyClickSuppressed = true;
        for (const ti of grp.indices) suppressedByTheme[ti] = true;
      }
    }
    if (suppressedByTheme && anyClickSuppressed) {
      ctx.clickOnlyCandidates.push({ snippet: snippetOf(rule), suppressedByTheme });
    }
  }

  if (focusAppearance && cls.hasDirectFocus) {
    let failDetail: string | null = null;
    for (let gIdx = 0; gIdx < partition.length && failDetail === null; gIdx += 1) {
      const grp = partition[gIdx]!;
      const decls = declsByGroup[gIdx]!;
      if (ctx.uniqueBackdrops.length === 1) {
        failDetail = evaluateFocusAppearanceTheme(decls, ctx.uniqueBackdrops[0]!, focusAppearance);
        continue;
      }
      const seenBackdrops = new Set<number>();
      for (const ti of grp.indices) {
        const bIdx = ctx.themeToBackdropIdx[ti]!;
        if (seenBackdrops.has(bIdx)) continue;
        seenBackdrops.add(bIdx);
        failDetail = evaluateFocusAppearanceTheme(decls, ctx.uniqueBackdrops[bIdx]!, focusAppearance);
        if (failDetail !== null) break;
      }
    }
    if (failDetail !== null) {
      ctx.focusAppearanceFails.push({ snippet: snippetOf(rule), detail: failDetail });
    }
  }
}

/** Evaluate a CSS rule across theme partitions, preserving per-body text and target worst-case caches. */
function evaluatePartitionedRule(
  rule: CssRule,
  partition: readonly ThemePartitionGroup[],
  declsByGroup: Decl[][],
  ruleBodyKey: string,
  ctx: RuleEvaluationContext,
): void {
  const { textContrast, uiContrast, targetSize } = ctx.profile;

  if (textContrast) {
    const headingLarge = isHeadingDefaultLarge(rule);
    const textKey = `${headingLarge ? '1' : '0'}\u0000${ruleBodyKey}`;
    let worstText: Verdict | null;
    if (ctx.textWorstCache.has(textKey)) {
      worstText = ctx.textWorstCache.get(textKey)!;
    } else {
      worstText = null;
      for (let gIdx = 0; gIdx < declsByGroup.length; gIdx += 1) {
        const v = textVerdict(rule, declsByGroup[gIdx]!, textContrast, headingLarge);
        if (!v) continue;
        if (v.kind === 'fail') {
          worstText = v;
          break;
        }
        if (!worstText || (worstText.kind === 'pass' && v.kind === 'unresolved')) {
          worstText = v;
        }
      }
      ctx.textWorstCache.set(textKey, worstText);
    }
    if (worstText?.kind === 'fail') {
      ctx.textFails.push({ snippet: snippetOf(rule), detail: `${worstText.ratio.toFixed(2)}:1` });
    } else if (worstText?.kind === 'unresolved') {
      ctx.unresolved.push({ snippet: snippetOf(rule), detail: `text: ${worstText.reason}` });
    }
  }

  if (uiContrast && isBoundaryControlRule(rule)) {
    const ui: Verdict[] = [];
    for (let gIdx = 0; gIdx < partition.length; gIdx += 1) {
      const grp = partition[gIdx]!;
      const decls = declsByGroup[gIdx]!;
      if (ctx.uniqueBackdrops.length === 1) {
        const v = uiVerdict(decls, ctx.uniqueBackdrops[0]!, uiContrast);
        if (v) ui.push(v);
        continue;
      }
      const seenBackdrops = new Set<number>();
      for (const ti of grp.indices) {
        const bIdx = ctx.themeToBackdropIdx[ti]!;
        if (seenBackdrops.has(bIdx)) continue;
        seenBackdrops.add(bIdx);
        const v = uiVerdict(decls, ctx.uniqueBackdrops[bIdx]!, uiContrast);
        if (v) ui.push(v);
      }
    }
    if (ui.length > 0) {
      const v = worst(ui);
      if (v.kind === 'fail') ctx.uiFails.push({ snippet: snippetOf(rule), detail: `${v.ratio.toFixed(2)}:1` });
      else if (v.kind === 'unresolved') ctx.unresolved.push({ snippet: snippetOf(rule), detail: `control: ${v.reason}` });
    }
  }

  if (targetSize && isInteractiveRule(rule)) {
    let worstTarget: Verdict | null;
    if (ctx.targetWorstCache.has(ruleBodyKey)) {
      worstTarget = ctx.targetWorstCache.get(ruleBodyKey)!;
    } else {
      worstTarget = null;
      for (let gIdx = 0; gIdx < declsByGroup.length; gIdx += 1) {
        const v = targetVerdict(declsByGroup[gIdx]!, targetSize);
        if (!v) continue;
        if (v.kind === 'fail') {
          worstTarget = v;
          break;
        }
        if (!worstTarget || (worstTarget.kind === 'pass' && v.kind === 'unresolved')) {
          worstTarget = v;
        }
      }
      ctx.targetWorstCache.set(ruleBodyKey, worstTarget);
    }
    if (worstTarget?.kind === 'fail') {
      ctx.targetFails.push({ snippet: snippetOf(rule), detail: `${worstTarget.ratio}px` });
    }
  }

  evaluatePartitionedFocus(rule, partition, declsByGroup, ctx);
}

/** Collect `:focus:not(:focus-visible)` suppressions lacking a visible `:focus-visible` companion in any theme. */
function collectStandaloneClickFocusFails(
  clickOnlyCandidates: readonly ClickOnlyFocusCandidate[],
  themeHasCompanionFocusVisible: readonly boolean[],
): string[] {
  const fails: string[] = [];
  for (const cand of clickOnlyCandidates) {
    if (cand.allThemes) {
      if (themeHasCompanionFocusVisible.some((hasComp) => !hasComp)) {
        fails.push(cand.snippet);
      }
    } else if (
      cand.suppressedByTheme?.some((sup, i) => sup && !themeHasCompanionFocusVisible[i])
    ) {
      fails.push(cand.snippet);
    }
  }
  return fails;
}

export function lintAccessibility(
  html: string,
  themes: readonly ReadonlyMap<string, string>[],
  resolveVars: ResolveVars,
  profile: A11yComplianceProfile = A11Y_COMPLIANCE_PROFILES[DEFAULT_A11Y_COMPLIANCE_LEVEL],
  preScannedDoc?: HtmlDocumentScanResult,
): ArtifactLintFinding[] {
  const {
    textContrast,
    uiContrast,
    accessibleName,
    targetSize,
    unresolvedContrast,
    imgAlt,
    pageTitle,
    htmlLang,
    focusOutline,
    focusAppearance,
  } = profile;
  if (
    !textContrast &&
    !uiContrast &&
    !accessibleName &&
    !targetSize &&
    !imgAlt &&
    !pageTitle &&
    !htmlLang &&
    !focusOutline &&
    !focusAppearance
  ) {
    return [];
  }

  const doc = preScannedDoc ?? scanHtmlDocument(html);
  const out: ArtifactLintFinding[] = [];
  const textFails: Hit[] = [];
  const uiFails: Hit[] = [];
  const targetFails: Hit[] = [];
  const unresolved: Hit[] = [];
  const focusDirectFails: string[] = [];
  let focusStandaloneClickFails: string[] = [];
  const focusAppearanceFails: Hit[] = [];

  if (textContrast || uiContrast || targetSize || focusOutline || focusAppearance) {
    const rules = collectRules(html, doc);
    const themeMaps = themes.length > 0 ? themes : [new Map<string, string>()];
    const themeCount = themeMaps.length;
    const varyingTokens = computeVaryingTokens(themeMaps);
    const getPartition = createThemePartitioner(themeMaps);
    const { uniqueBackdrops, themeToBackdropIdx } =
      uiContrast || focusAppearance
        ? resolveUniquePageBackdrops(rules, themeMaps, varyingTokens, getPartition, resolveVars)
        : { uniqueBackdrops: [] as Backdrop[], themeToBackdropIdx: new Int32Array(themeCount) };

    const themeHasCompanionFocusVisible = new Array<boolean>(themeCount).fill(false);
    const clickOnlyCandidates: ClickOnlyFocusCandidate[] = [];
    const parsedDeclsCache = new Map<string, Decl[]>();
    const getDecls = (cssBody: string): Decl[] => {
      let cached = parsedDeclsCache.get(cssBody);
      if (!cached) {
        cached = parseDecls(cssBody);
        parsedDeclsCache.set(cssBody, cached);
      }
      return cached;
    };
    const resolvedBodyCache = new Map<string, string>();
    const resolveForRep = (rawBody: string, repIdx: number): string => {
      const key = `${repIdx}\u0000${rawBody}`;
      let resolved = resolvedBodyCache.get(key);
      if (resolved === undefined) {
        resolved = resolveVars(rawBody, themeMaps[repIdx]!);
        resolvedBodyCache.set(key, resolved);
      }
      return resolved;
    };

    const ctx: RuleEvaluationContext = {
      profile,
      themeCount,
      uniqueBackdrops,
      themeToBackdropIdx,
      themeHasCompanionFocusVisible,
      clickOnlyCandidates,
      textWorstCache: new Map<string, Verdict | null>(),
      targetWorstCache: new Map<string, Verdict | null>(),
      textFails,
      uiFails,
      targetFails,
      unresolved,
      focusDirectFails,
      focusAppearanceFails,
    };
    const partitionDeclsCache = new Map<string, Decl[][]>();

    for (const rule of rules) {
      const hasVar = rule.body.includes('var(');
      const relevantVars = hasVar
        ? extractReferencedVarNames(rule.body).filter((v) => varyingTokens.has(v)).sort()
        : [];
      const partition = hasVar ? getPartition(relevantVars) : null;

      if (!partition) {
        const resolvedBody = hasVar ? resolveForRep(rule.body, 0) : rule.body;
        evaluateUniformRule(rule, getDecls(resolvedBody), ctx);
        continue;
      }

      const partitionKey = relevantVars.join('\u0000');
      const ruleBodyKey = `${partitionKey}\u0000${rule.body}`;
      let declsByGroup = partitionDeclsCache.get(ruleBodyKey);
      if (!declsByGroup) {
        declsByGroup = partition.map((grp) => getDecls(resolveForRep(rule.body, grp.repIdx)));
        partitionDeclsCache.set(ruleBodyKey, declsByGroup);
      }
      evaluatePartitionedRule(rule, partition, declsByGroup, ruleBodyKey, ctx);
    }

    if (focusOutline) {
      focusStandaloneClickFails = collectStandaloneClickFocusFails(
        clickOnlyCandidates,
        themeHasCompanionFocusVisible,
      );
    }
  }

  if (textContrast && textFails.length > 0) {
    const first = textFails[0]!;
    out.push({
      severity: textContrast.severity,
      id: A11Y_RULE_IDS.textContrast,
      message: `${textFails.length} text colour pair(s) below ${formatComplianceMessageRef(textContrast.compliance)} (${textContrast.normalRatio}:1 normal, ${textContrast.largeRatio}:1 large text); first is ${first.detail}.`,
      fix: `Darken the foreground or lighten the background token until the pair reaches ${textContrast.normalRatio}:1 (${textContrast.largeRatio}:1 for text at least ${WCAG_LARGE_TEXT_PX}px, or ${WCAG_LARGE_BOLD_TEXT_PX}px bold). Fix the design token, not the single rule, when the pair comes from tokens.`,
      snippet: first.snippet,
      compliance: textContrast.compliance,
    });
  }
  if (uiContrast && uiFails.length > 0) {
    const first = uiFails[0]!;
    out.push({
      severity: uiContrast.severity,
      id: A11Y_RULE_IDS.uiContrast,
      message: `${uiFails.length} interactive control(s) whose border and fill are both below ${formatComplianceMessageRef(uiContrast.compliance)} (${uiContrast.minRatio}:1 against the page background); best is ${first.detail}.`,
      fix: `Give the control a border, crisp ring box-shadow, or fill that reaches ${uiContrast.minRatio}:1 against the page background. Keep decorative hairline --border tokens for cards and dividers, and bind form controls to a high-contrast token (such as --muted, --fg-2, or --fg), a dedicated ≥${uiContrast.minRatio}:1 control border colour, a crisp outer ring box-shadow, or a higher-contrast fill.`,
      snippet: first.snippet,
      compliance: uiContrast.compliance,
    });
  }
  if (accessibleName) {
    const names = missingNames(html, doc);
    if (names.length > 0) {
      const first = names[0]!;
      out.push({
        severity: accessibleName.severity,
        id: A11Y_RULE_IDS.accessibleName,
        message: `${names.length} interactive element(s) without an accessible name; first: ${first.detail}.`,
        fix: 'Give every interactive element visible text, or an aria-label / aria-labelledby, or an associated <label for>. Icon-only buttons need aria-label; a placeholder is not a label.',
        snippet: first.snippet,
        compliance: accessibleName.compliance,
      });
    }
  }
  if (targetSize && targetFails.length > 0) {
    const first = targetFails[0]!;
    const comfortNote = targetSize.minPx < 44 ? ' (44px is the comfortable touch size)' : '';
    out.push({
      severity: targetSize.severity,
      id: A11Y_RULE_IDS.targetSize,
      message: `${targetFails.length} interactive target(s) declared smaller than ${targetSize.minPx}×${targetSize.minPx} CSS px (${formatComplianceMessageRef(targetSize.compliance)}); smallest side ${first.detail}.`,
      fix: `Raise width/height to at least ${targetSize.minPx}px, or add min-width/min-height: ${targetSize.minPx}px${comfortNote}.`,
      snippet: first.snippet,
      compliance: targetSize.compliance,
    });
  }
  emitImgAltFinding(html, doc, imgAlt, out);
  emitPageTitleFinding(html, doc, pageTitle, out);
  emitHtmlLangFinding(html, doc, htmlLang, out);
  emitFocusOutlineFinding(focusDirectFails, focusStandaloneClickFails, focusOutline, out);
  emitFocusAppearanceFinding(focusAppearanceFails, focusAppearance, out);
  if (unresolvedContrast && unresolved.length > 0) {
    const first = unresolved[0]!;
    out.push({
      severity: unresolvedContrast.severity,
      id: A11Y_RULE_IDS.unresolvedContrast,
      message: `${unresolved.length} colour pair(s) could not be resolved statically, so their contrast is unresolved (not passed); first: ${sanitizeDetail(first.detail)}.`,
      fix: 'Use literal colours or design tokens that resolve to opaque colours (no color-mix(), currentColor, gradients or translucent backgrounds behind text), or verify the contrast in a rendered check.',
      snippet: first.snippet,
    });
  }
  return out;
}
