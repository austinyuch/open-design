/**
 * Anti-slop linter for generated HTML artifacts.
 *
 * Runs grep-style checks against an artifact body and returns a list of
 * structured findings. P0 findings indicate the artifact is regressing
 * to AI-slop tropes (purple gradients, emoji feature icons, sans-serif
 * display, invented metrics, lorem-style filler) and are surfaced back
 * to the agent as a system message so it can self-correct on the next
 * turn. P1/P2 findings are advisories.
 *
 * The linter is deliberately greppy: cheap, deterministic, and trivial
 * to extend. It does NOT parse HTML — false positives are tolerable
 * because each finding includes a snippet so the agent can verify.
 *
 * Wired into the artifact save flow (POST /api/artifacts/save) and
 * exposed standalone at POST /api/artifacts/lint for the chat UI to
 * surface badges next to each saved artifact.
 */

import {
  formatArtifactLintCompliance,
  resolveA11yComplianceProfile,
  type A11yComplianceLevel,
  type A11yComplianceProfileOverrides,
  type ArtifactLintFinding,
} from '@open-design/contracts';

import {
  ROOT_FONT_PX,
  findLastDeclaration,
  foldAsciiLower,
  parseCssDeclarations,
  sanitizeLintText,
  scanCssLeafRules,
  scanHtmlDocument,
  splitCssStatements,
  stripCssComments,
  stripHtmlComments,
  stripLintControls,
  type CssDeclaration,
  type StyleBlock,
} from './artifacts/lint-css-utils.js';
import { lintAccessibility } from './lint-a11y.js';

export type LintFinding = ArtifactLintFinding;

type CssTokenScope = {
  selectors: string[];
  tokens: Map<string, string>;
  isDefault: boolean;
  themeKeys: Set<string>;
};

const PURPLE_HEXES = [
  // Tailwind violet / purple — the original AI-slop palette.
  '#a855f7', '#9333ea', '#7c3aed', '#6d28d9', '#581c87',
  '#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe', '#ede9fe',
  // Tailwind indigo — Refero's #1 reported AI tell. Common solid uses
  // (button fill, accent badge), not just gradients, are flagged
  // separately by `ai-default-indigo` below.
  '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#312e81',
  '#818cf8', '#a5b4fc', '#c7d2fe', '#e0e7ff', '#eef2ff',
];

// Blue / cyan stops used in the documented "blue→cyan two-stop trust
// gradient" cardinal sin. The purple-gradient rule above only catches
// gradients that contain a violet/indigo hex or the literal
// `purple`/`violet` keyword, so an artifact emitting
// `linear-gradient(90deg, #3b82f6, #06b6d4)` (or the keyword form
// `linear-gradient(90deg, blue, cyan)`) slipped past P0 even though
// `craft/anti-ai-slop.md` explicitly flags it. The `trust-gradient`
// rule below pairs these against each other to close the gap.
const TRUST_GRADIENT_BLUE_HEXES = [
  // Tailwind blue 500–900 + 400/300/200.
  '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a',
  '#60a5fa', '#93c5fd', '#bfdbfe',
  // Tailwind sky 400–700 — the same blue→cyan ramp under a different name.
  '#0ea5e9', '#0284c7', '#0369a1', '#38bdf8', '#7dd3fc',
];
const TRUST_GRADIENT_CYAN_HEXES = [
  // Tailwind cyan 500–900 + 400/300/200.
  '#06b6d4', '#0891b2', '#0e7490', '#155e75', '#164e63',
  '#22d3ee', '#67e8f9', '#a5f3fc',
];

// Subset of PURPLE_HEXES that constitute the canonical "default LLM
// accent" — even a single solid use is a tell. The DESIGN.md provides
// `var(--accent)`; if a brief truly needs indigo, the design system
// should encode it explicitly so we know it's intentional.
//
// Keep this in sync with the explicit list in `craft/anti-ai-slop.md`'s
// "Default Tailwind indigo as accent" cardinal-sin entry — the prompt
// contract documents the exact set the lint enforces.
const AI_DEFAULT_INDIGO = [
  '#6366f1', '#4f46e5', '#4338ca', '#3730a3',
  '#8b5cf6', '#7c3aed', '#a855f7',
];

const SLOP_EMOJI = [
  '✨', '🚀', '🎯', '⚡', '🔥', '💡', '📈', '🎨', '🛡️', '🌟',
  '💪', '🎉', '👋', '🙌', '✅', '⭐', '🏆',
];

// Simple sentinel words for invented-metric copy. Catching every claim is
// hopeless; we look for the canonical AI-startup phrasings.
const INVENTED_METRIC_PATTERNS = [
  /\b10×\s+(faster|better|easier)\b/i,
  /\b100×\s+(faster|better)\b/i,
  /\b99\.\d+%\s+uptime\b/i,
  /\bzero[- ]downtime\b/i,
  /\b3×\s+more\s+(productive|efficient)\b/i,
];

const FILLER_PATTERNS = [
  /\bfeature\s+(one|two|three|1|2|3)\b/i,
  /\blorem\s+ipsum\b/i,
  /\bdolor\s+sit\s+amet\b/i,
  /\bplaceholder\s+text\b/i,
  /\bsample\s+content\b/i,
];

const DISPLAY_SANS_FONT_RE =
  /^["']?(?:Inter|Roboto|Arial|-apple-system|system-ui|SF\s+Pro)/i;
const DISPLAY_SANS_SELECTOR_RE =
  /(?:^|[\s,>+~])(?:h[1-3]|\.h-?(?:hero|xl|lg|md))(?=$|[\s,>+~.:#[])/i;
const DISPLAY_SANS_CLASS_RE = /\bh-?(?:hero|xl|lg|md)\b/i;

export interface LintArtifactOptions {
  /** Declarative accessibility compliance preset (defaults to `wcag22-aa`). */
  a11yLevel?: A11yComplianceLevel | undefined;
  /** Partial rule overrides applied on top of `a11yLevel`. */
  a11yProfile?: A11yComplianceProfileOverrides | undefined;
}

/**
 * Run all checks against an HTML artifact body. Returns an array of
 * findings. The checks are intentionally independent so adding a new
 * one only means appending to this function.
 */
export function lintArtifact(rawHtml: unknown, options?: LintArtifactOptions): LintFinding[] {
  const out: LintFinding[] = [];
  if (typeof rawHtml !== 'string' || rawHtml.length === 0) return out;

  // Strip HTML comments before any pattern matching — comments often contain
  // pedagogical examples ("paste a `<section class="slide">` here") that
  // would otherwise fire false positives for the section / slide checks.
  const html = stripHtmlComments(rawHtml);
  const doc = scanHtmlDocument(html);
  const gradients = findLinearGradients(html);
  const lowerGradients = gradients.map((g) => foldAsciiLower(g));

  // ── P0-1: purple gradient backgrounds ─────────────────────────────
  for (const hex of PURPLE_HEXES) {
    const hexLower = hex.toLowerCase();
    const matchIdx = lowerGradients.findIndex((g) => g.includes(hexLower));
    if (matchIdx !== -1) {
      out.push({
        severity: 'P0',
        id: 'purple-gradient',
        message: `Found a violet/purple gradient using ${hex} — anti-slop list says no.`,
        fix: 'Replace the gradient with a flat surface (var(--bg) or var(--surface)) or use the active accent at a single intensity, not in a gradient.',
        snippet: clip(gradients[matchIdx]!),
      });
      break;
    }
  }
  // Also catch the literal "purple"/"violet" keyword in a linear-gradient.
  if (out.find((f) => f.id === 'purple-gradient') === undefined) {
    for (const grad of gradients) {
      const m = /(?:^|[^a-z0-9_-])(purple|violet)(?=[^a-z0-9_-]|$)/i.exec(grad);
      if (m) {
        out.push({
          severity: 'P0',
          id: 'purple-gradient',
          message: `Found a "${m[1]}" keyword inside a gradient — anti-slop.`,
          fix: 'Remove the gradient or swap to a single solid color from the active design tokens.',
          snippet: clip(grad),
        });
        break;
      }
    }
  }

  // ── P0-1c: blue→cyan "trust" two-stop gradient ─────────────────────
  // craft/anti-ai-slop.md documents three flavours of the two-stop
  // "trust" gradient — purple→blue, blue→cyan, indigo→pink. The first
  // and third are caught by `purple-gradient` above because the
  // relevant indigo/violet hex appears in PURPLE_HEXES, but a pure
  // blue→cyan gradient has no overlap with that list and slipped
  // past unflagged. Detect a `linear-gradient(...)` whose stop list
  // contains both a blue token (hex or keyword) and a cyan token
  // (hex or keyword). Skip if the purple-gradient rule already fired
  // so we emit a single corrective signal per artifact.
  if (out.find((f) => f.id === 'purple-gradient') === undefined) {
    const tg = detectBlueCyanTrustGradient(gradients);
    if (tg) {
      out.push({
        severity: 'P0',
        id: 'trust-gradient',
        message: `Found a blue→cyan two-stop "trust" gradient — anti-slop list says no.`,
        fix: 'Replace the gradient with a flat surface (var(--bg) or var(--surface)) or use a single design-token color. Two-stop blue→cyan trust gradients are a SaaS hero cliché.',
        snippet: clip(tg),
      });
    }
  }

  // ── P0-1b: solid AI-default indigo as accent ──────────────────────
  // Even outside a gradient, a single use of #6366f1 et al. is the
  // textbook LLM tell. We only fire if the existing purple-gradient
  // check didn't already, since they overlap in spirit. Strip
  // token-definition blocks first: a brief whose accent is
  // intentionally indigo declares it as `--accent: #6366f1` inside
  // a selector list containing `:root` (or another known global
  // theme scope like `html` / bare `[data-theme="..."]`) and uses
  // var(--accent) downstream. That is the design system speaking,
  // not the model defaulting, and must not fire. Component-local
  // variables (e.g. `.cta { --cta-bg: #6366f1; }`) stay in scope so
  // the lint still catches indigo laundered through a local var.
  if (out.find((f) => f.id === 'purple-gradient') === undefined) {
    const htmlForIndigo = stripTokenBlocks(html, doc.styleBlocks);
    for (const hex of AI_DEFAULT_INDIGO) {
      const re = new RegExp(escapeRe(hex), 'i');
      const m = re.exec(htmlForIndigo);
      if (m) {
        out.push({
          severity: 'P0',
          id: 'ai-default-indigo',
          message: `Found a default LLM accent color (${hex}) — this is the most-reported AI design tell.`,
          fix: 'Replace with var(--accent) from the active DESIGN.md. If the brief truly requires indigo, encode it as the design system\'s accent so it reads as intentional, not default.',
          snippet: clip(m[0]),
        });
        break;
      }
    }
  }

  // ── P0-2: emoji used as feature/UI icons ──────────────────────────
  const presentEmoji = SLOP_EMOJI.filter((e) => html.includes(e));
  if (presentEmoji.length > 0) {
    const emojiHostTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'button', 'li']);
    outerEmoji: for (const e of presentEmoji) {
      for (const tag of doc.tags) {
        if (tag.isClose) continue;
        const isIconSpan =
          tag.tagName === 'span' && (tag.attrs.get('class') ?? '').toLowerCase().includes('icon');
        if (!emojiHostTags.has(tag.tagName) && !isIconSpan) continue;
        const nextLt = html.indexOf('<', tag.end);
        const textEnd = nextLt === -1 ? html.length : nextLt;
        const inner = html.slice(tag.end, textEnd);
        if (inner.includes(e)) {
          out.push({
            severity: 'P0',
            id: 'emoji-icon',
            message: `Emoji "${e}" used as a UI icon — anti-slop list says SVG monoline only.`,
            fix: 'Replace with a small inline SVG icon (1.6–1.8px stroke, currentColor) or remove the icon entirely.',
            snippet: clip(html.slice(tag.start, Math.min(textEnd, tag.start + 512))),
          });
          break outerEmoji;
        }
      }
    }
  }

  const scannedStyleRules = doc.styleBlocks.map((block) => scanCssLeafRules(stripCssComments(block.css)));

  // ── P0-3: rounded card with left-border accent ────────────────────
  outerLeftAccent: for (const rules of scannedStyleRules) {
    for (const rule of rules) {
      if (!/\.[a-z-]+/i.test(rule.selector)) continue;
      const decls = parseCssDeclarations(rule.body, { stripImportant: true });
      const leftBorder = findLastDeclaration(decls, 'border-left');
      const radius = findLastDeclaration(decls, 'border-radius');
      if (
        leftBorder &&
        /^\d+px\s+solid\s+\S/i.test(leftBorder.value) &&
        radius &&
        /^[1-9]/.test(radius.value)
      ) {
        out.push({
          severity: 'P0',
          id: 'left-accent-card',
          message: 'Rounded card with a coloured left border — the canonical AI-slop card pattern.',
          fix: 'Drop either the border-radius (set 0px) or the border-left. Cards in the OD seed use hairline borders all-round, no left accent.',
          snippet: clip(`${rule.selector} { ${rule.body.trim()} }`),
        });
        break outerLeftAccent;
      }
    }
  }

  // ── P0-4: sans-serif display face ─────────────────────────────────
  // Skill seeds bind --font-display to a serif. Catch the case where a
  // generated artifact reverts this on h1/h2/h3 to system-sans.
  let sansDisplayFound = false;
  outerSansDisplay: for (const rules of scannedStyleRules) {
    for (const rule of rules) {
      if (!DISPLAY_SANS_SELECTOR_RE.test(rule.selector)) continue;
      const ff = findLastDeclaration(parseCssDeclarations(rule.body, { stripImportant: true }), 'font-family');
      if (ff && DISPLAY_SANS_FONT_RE.test(ff.value)) {
        out.push({
          severity: 'P0',
          id: 'sans-display',
          message: 'A heading rule uses Inter / Roboto / system-sans as the display face — not the serif the seed binds.',
          fix: 'Use `font-family: var(--font-display)` on h1/h2/h3 and let the active design system pick the serif. Override only if the active direction is "tech / utility" or "modern minimal".',
          snippet: clip(`${rule.selector} { ${rule.body.trim()} }`),
        });
        sansDisplayFound = true;
        break outerSansDisplay;
      }
    }
  }
  if (!sansDisplayFound) {
    for (const tag of doc.inlineStyleTags) {
      const isHeading = tag.tagName === 'h1' || tag.tagName === 'h2' || tag.tagName === 'h3';
      const hasDisplayClass = DISPLAY_SANS_CLASS_RE.test(tag.attrs.get('class') ?? '');
      if (!isHeading && !hasDisplayClass) continue;
      const styleText = tag.attrs.get('style') ?? '';
      const ff = findLastDeclaration(parseCssDeclarations(styleText, { stripImportant: true }), 'font-family');
      if (ff && DISPLAY_SANS_FONT_RE.test(ff.value)) {
        out.push({
          severity: 'P0',
          id: 'sans-display',
          message: 'A heading rule uses Inter / Roboto / system-sans as the display face — not the serif the seed binds.',
          fix: 'Use `font-family: var(--font-display)` on h1/h2/h3 and let the active design system pick the serif. Override only if the active direction is "tech / utility" or "modern minimal".',
          snippet: clip(styleText.trim()),
        });
        break;
      }
    }
  }

  // ── P0-5: invented metric phrasing ────────────────────────────────
  for (const re of INVENTED_METRIC_PATTERNS) {
    const m = re.exec(html);
    if (m) {
      out.push({
        severity: 'P0',
        id: 'invented-metric',
        message: `Suspected invented metric: "${m[0]}". Anti-slop list says: no numbers without a real source.`,
        fix: 'Either remove the claim or replace with a placeholder (— or a labelled stub) until the user supplies a real number.',
        snippet: clip(m[0]),
      });
      break;
    }
  }

  // ── P0-6: filler / lorem text ─────────────────────────────────────
  for (const re of FILLER_PATTERNS) {
    const m = re.exec(html);
    if (m) {
      out.push({
        severity: 'P0',
        id: 'filler-copy',
        message: `Filler copy detected: "${m[0]}". Pages should ship with real, brief-derived copy.`,
        fix: 'Replace with copy specific to the brief or delete the section entirely. An empty section is a design problem to solve with composition, not by inventing words.',
        snippet: clip(m[0]),
      });
      break;
    }
  }

  // ── P0-7: scrollIntoView (breaks iframe preview) ──────────────────
  if (/\.scrollIntoView\s*\(/.test(html)) {
    out.push({
      severity: 'P0',
      id: 'scroll-into-view',
      message: 'Element.scrollIntoView() detected — yanks the host page when an iframe boundary is crossed.',
      fix: 'Use `scrollTo({ left, top, behavior: "smooth" })` on the actual scroller (see simple-deck seed for the proven pattern).',
    });
  }

  // ── P1-0: ALL-CAPS without letter-spacing ─────────────────────────
  // Refero's typography rules: any `text-transform: uppercase` rule
  // must pair with `letter-spacing: >= 0.06em` (or an absolute px
  // equivalent). Iterate every <style> block (artifacts often emit
  // a reset block followed by a tokens/components block) and scan
  // each CSS body for an uppercase declaration whose selector body
  // is missing letter-spacing or sets it visibly too low.
  // Token-aware tracking: collect per-scope `--name: value` declarations
  // from global theme scopes once, then pass them to the tracking helper
  // so a rule like `letter-spacing: var(--caps-tracking)` is judged by
  // the token's literal value in every applicable theme instead of being
  // treated as missing.
  const tokenScopes = extractCssTokens(doc.styleBlocks);
  const resolvedThemes = buildResolvedThemes(tokenScopes);
  outer: for (const rules of scannedStyleRules) {
    for (const rule of rules) {
      if (!/text-transform\s*:\s*uppercase/i.test(rule.body)) continue;
      const selector = rule.selector;
      const body = rule.body;
      if (!hasAdequateUppercaseTracking(body, resolvedThemes)) {
        out.push({
          severity: 'P1',
          id: 'all-caps-no-tracking',
          message: `Selector \`${sanitizeLintText(selector, 60)}\` sets text-transform: uppercase without sufficient letter-spacing (≥0.06em).`,
          fix: 'Add `letter-spacing: 0.08em` (typical) to the same rule. ALL CAPS without tracking looks cramped — Refero\'s typography rules call this out as a top-tier amateur tell.',
          snippet: clip(`${selector} { ${body.trim()} }`),
        });
        break outer;
      }
    }
  }

  // ── P1-0b: ALL-CAPS in inline style attributes ────────────────────
  // The <style>-block scan above misses inline declarations such as
  // `<span style="text-transform: uppercase">NEW</span>`, which the
  // browser still renders ALL CAPS. craft/typography.md treats the
  // tracking floor as having no exceptions, so the inline form runs
  // through the same `hasAdequateUppercaseTracking` check used by the
  // <style>-block branch — no separate threshold. Only fire if the
  // <style>-block scan above didn't already produce this id, so the
  // agent gets a single corrective signal per artifact.
  if (out.find((f) => f.id === 'all-caps-no-tracking') === undefined) {
    for (const tag of doc.inlineStyleTags) {
      const decl = tag.attrs.get('style') ?? '';
      if (!/text-transform\s*:\s*uppercase/i.test(decl)) continue;
      if (!hasAdequateUppercaseTracking(decl, resolvedThemes)) {
        out.push({
          severity: 'P1',
          id: 'all-caps-no-tracking',
          message:
            'Inline style sets text-transform: uppercase without sufficient letter-spacing (≥0.06em).',
          fix: 'Add `letter-spacing: 0.08em` (typical) to the same inline style. ALL CAPS without tracking looks cramped — Refero\'s typography rules call this out as a top-tier amateur tell.',
          snippet: clip(decl.trim()),
        });
        break;
      }
    }
  }

  // ── P1-1: external image URLs (CDN / unsplash / placehold.co) ─────
  // Allow data: urls and same-origin paths.
  for (const tag of doc.tags) {
    if (tag.isClose || tag.tagName !== 'img') continue;
    const src = tag.attrs.get('src')?.trim() ?? '';
    if (
      src &&
      /^https?:\/\/(?:images\.unsplash\.com|placehold\.co|placekitten\.com|via\.placeholder\.com|picsum\.photos|loremflickr\.com)/i.test(
        src,
      )
    ) {
      out.push({
        severity: 'P1',
        id: 'external-image',
        message: 'External placeholder image CDN detected — fragile, looks fake when it 404s.',
        fix: 'Use the .ph-img placeholder class shipped in the seed templates instead.',
        snippet: clip(html.slice(tag.start, Math.min(tag.end, tag.start + 512))),
      });
      break;
    }
  }

  // ── P1-2: raw hex outside :root ───────────────────────────────────
  // Heuristic: count `#xxxxxx` occurrences inside the first <style> block,
  // outside the `:root{...}` declaration. Many is suspicious.
  const firstStyle = doc.styleBlocks[0];
  if (firstStyle) {
    const css = firstStyle.css;
    const rootRe = /:root\s*\{[^}]*\}/g;
    const cssWithoutRoot = css.replace(rootRe, '');
    const hexes = cssWithoutRoot.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    // Allow up to ~12 raw hex values outside :root. Device chrome
    // (mobile-app frame: bezel gradient, side rails, status icons) has
    // legitimate hardware-specific values in the 8–10 range; raise the
    // threshold so seed templates pass without ceremony. More than ~12
    // signals tokens weren't honoured by the agent's generation.
    if (hexes.length > 12) {
      out.push({
        severity: 'P1',
        id: 'raw-hex',
        message: `${hexes.length} raw hex values found outside :root — design tokens probably not honoured.`,
        fix: 'Move every color into the :root token block (--bg / --surface / --fg / --muted / --border / --accent) and reference via var(). Use color-mix() for derived tones.',
        snippet: hexes.slice(0, 6).join(' '),
      });
    }
  }

  // ── P1-3: too many accent uses in the rendered body ───────────────
  // Approximation: count `var(--accent)` references that appear OUTSIDE
  // the <style> block — i.e. inline styles in the rendered DOM, not the
  // class system definitions. The seed's <style> block defines the
  // accent on many class selectors that won't all render on one page;
  // the body is what the user actually sees.
  let styleStripped = html;
  if (doc.styleBlocks.length > 0) {
    const chunks: string[] = [];
    let styleCursor = 0;
    for (const block of doc.styleBlocks) {
      if (block.start > styleCursor) chunks.push(html.slice(styleCursor, block.start));
      styleCursor = block.end;
    }
    if (styleCursor < html.length) chunks.push(html.slice(styleCursor));
    styleStripped = chunks.join('');
  }
  const accentUsesInBody = (styleStripped.match(/var\(--accent\)/g) ?? []).length;
  if (accentUsesInBody > 6) {
    out.push({
      severity: 'P1',
      id: 'accent-overuse',
      message: `var(--accent) used ${accentUsesInBody} times inline in the body — likely overused per screen.`,
      fix: 'Cap accent usage at 2 visible uses per screen (one eyebrow + one CTA, OR one accent card + one tab). Demote the rest to var(--fg) or var(--muted).',
    });
  }

  // ── P2-1: missing comment-mode anchor on <section> ────────────────
  // Either `data-od-id` (web/mobile prototypes) or `data-screen-label`
  // (decks) counts. Whichever the artifact uses, every <section> should
  // carry one so the chat layer can target it.
  const sectionTags = doc.tags.filter((t) => !t.isClose && t.tagName === 'section');
  const tagged = sectionTags.filter(
    (s) => s.attrs.has('data-od-id') || s.attrs.has('data-screen-label'),
  ).length;
  if (sectionTags.length > 0 && tagged < sectionTags.length) {
    out.push({
      severity: 'P2',
      id: 'missing-section-anchor',
      message: `${sectionTags.length - tagged} of ${sectionTags.length} <section>s lack data-od-id (or data-screen-label).`,
      fix: 'Add data-od-id="kebab-slug" (or data-screen-label="01 Cover" for slides) to every top-level <section> so comment mode can target it.',
    });
  }

  // ── P2-2: missing slide theme classes (deck specifically) ──────────
  // Triggered only if the artifact looks deck-shaped (has .slide).
  const slideSections = sectionTags.filter((s) => /\bslide\b/.test(s.attrs.get('class') ?? ''));
  if (slideSections.length > 0) {
    const themed = slideSections.filter((s) =>
      /\b(light|dark|hero\s+light|hero\s+dark)\b/.test(s.attrs.get('class') ?? ''),
    ).length;
    if (themed < slideSections.length) {
      out.push({
        severity: 'P0',
        id: 'slide-theme-missing',
        message: `${slideSections.length - themed} of ${slideSections.length} slides lack a theme class (light / dark / hero light / hero dark).`,
        fix: 'Every <section class="slide"> must include exactly one theme class. Audit your slide list and add light/dark/hero modifiers.',
      });
    }
    // Theme rhythm: no 3+ same-theme in a row.
    const themeSeq = slideSections
      .map((s) => {
        const cls = s.attrs.get('class') ?? '';
        if (/hero\s+dark/.test(cls)) return 'HD';
        if (/hero\s+light/.test(cls)) return 'HL';
        if (/\bdark\b/.test(cls)) return 'D';
        if (/\blight\b/.test(cls)) return 'L';
        return '?';
      })
      .filter((t) => t !== '?');
    for (let i = 0; i < themeSeq.length - 2; i++) {
      const a = themeSeq[i];
      const isLight = (t: string | undefined) => t === 'L' || t === 'HL';
      const isDark = (t: string | undefined) => t === 'D' || t === 'HD';
      if (
        (isLight(a) && isLight(themeSeq[i + 1]) && isLight(themeSeq[i + 2])) ||
        (isDark(a) && isDark(themeSeq[i + 1]) && isDark(themeSeq[i + 2]))
      ) {
        out.push({
          severity: 'P1',
          id: 'slide-rhythm',
          message: `Three same-theme slides in a row at position ${i + 1}–${i + 3} — visual fatigue.`,
          fix: 'Swap the middle slide to the opposite theme (light → dark, or dark → light). For 8+ slides, mix in at least one hero light AND one hero dark.',
        });
        break;
      }
    }
  }

  // ── Accessibility (WCAG 2.x): declarative profile-driven checks ───────
  // Appended after the anti-slop rules so their ids, severities and order
  // are unchanged. Tokens resolve through the same per-theme maps the
  // tracking rule uses, so both passes agree on what a token renders as.
  const a11yProfile = resolveA11yComplianceProfile(options?.a11yLevel, options?.a11yProfile);
  out.push(...lintAccessibility(html, resolvedThemes, resolveCssVars, a11yProfile, doc));

  return out;
}

/**
 * Format findings as a Markdown block ready to splice into a system
 * reminder back to the agent. P0 findings appear first.
 *
 * @param {LintFinding[]} findings
 * @returns {string}
 */
const PROMPT_DELIMITER_TAG_RE =
  /<(\/?)(artifact-lint|artifact|system|instructions)(?=[\t\n\f\r >/]|$)/gi;

function sanitizePromptText(raw: string, options?: { preserveBackticks?: boolean }): string {
  const withoutControls = stripLintControls(raw).replace(/\s+/g, ' ').trim();
  const neutralizedTag = withoutControls.replace(PROMPT_DELIMITER_TAG_RE, '&lt;$1$2');
  return options?.preserveBackticks ? neutralizedTag : neutralizedTag.replace(/`/g, '\'');
}

export function renderFindingsForAgent(findings: LintFinding[]): string {
  if (findings.length === 0) return '';
  const sorted = [...findings].sort((a, b) => severity(a) - severity(b));
  const lines = [
    '<artifact-lint>',
    'The artifact you just produced has the following anti-slop / design-token / accessibility issues.',
    `${findings.filter((f) => f.severity === 'P0').length} P0 (must fix), ${findings.filter((f) => f.severity === 'P1').length} P1 (should fix), ${findings.filter((f) => f.severity === 'P2').length} P2 (nice to have).`,
    'Re-emit a corrected `<artifact>` in your next turn — do not write a separate explanation; the user has the previous version already.',
    '',
  ];
  for (const f of sorted) {
    const safeSeverity = sanitizePromptText(String(f.severity));
    const safeId = sanitizePromptText(String(f.id));
    const provenance = f.compliance
      ? ` [${sanitizePromptText(formatArtifactLintCompliance(f.compliance))}]`
      : '';
    lines.push(`**[${safeSeverity}] ${safeId}**${provenance} — ${sanitizePromptText(f.message)}`);
    lines.push(`  Fix: ${sanitizePromptText(f.fix, { preserveBackticks: true })}`);
    if (f.snippet) lines.push(`  Snippet: \`${sanitizePromptText(f.snippet)}\``);
    lines.push('');
  }
  lines.push('</artifact-lint>');
  return lines.join('\n');
}

function severity(f: LintFinding): number {
  return f.severity === 'P0' ? 0 : f.severity === 'P1' ? 1 : 2;
}

function clip(s: string): string {
  return sanitizeLintText(s, 200);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Scan balanced `linear-gradient(...)` expressions in a single O(n) pass. */
function findLinearGradients(html: string): string[] {
  const lower = foldAsciiLower(html);
  const prefix = 'linear-gradient(';
  const first = lower.indexOf(prefix);
  if (first === -1) return [];

  const gradients: string[] = [];
  const stack: Array<{ start: number; closeDepth: number }> = [];
  let parenDepth = 0;
  let quote: '\'' | '"' | null = null;
  let i = first;

  while (i < html.length) {
    if (stack.length === 0 && quote === null) {
      const next = lower.indexOf(prefix, i);
      if (next === -1) break;
      i = next;
    }

    const ch = html[i]!;
    if (quote !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote || ch === '\n' || ch === '\r') {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (lower.startsWith(prefix, i)) {
      stack.push({ start: i, closeDepth: parenDepth });
      parenDepth += 1;
      i += prefix.length;
      continue;
    }

    if (ch === '\'' || ch === '"') {
      quote = ch;
    } else if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      if (parenDepth > 0) parenDepth -= 1;
      const top = stack[stack.length - 1];
      if (top && top.closeDepth === parenDepth) {
        stack.pop();
        if (stack.length === 0) {
          gradients.push(html.slice(top.start, i + 1));
          quote = null;
        }
      }
    }
    i += 1;
  }

  return gradients;
}

// Scan every `linear-gradient(...)` body for a blue→cyan two-stop
// trust gradient. Returns the first matching gradient text or `null`.
// The check accepts either Tailwind blue/sky/cyan hex stops or the
// literal `blue`/`cyan` keywords, so both
// `linear-gradient(90deg, #3b82f6, #06b6d4)` and
// `linear-gradient(90deg, blue, cyan)` fire P0.
function detectBlueCyanTrustGradient(gradients: readonly string[]): string | null {
  for (const rawGrad of gradients) {
    const grad = foldAsciiLower(rawGrad);
    const hasBlue =
      TRUST_GRADIENT_BLUE_HEXES.some((h) => grad.includes(h.toLowerCase())) ||
      /\bblue\b/.test(grad);
    const hasCyan =
      TRUST_GRADIENT_CYAN_HEXES.some((h) => grad.includes(h.toLowerCase())) ||
      /\bcyan\b/.test(grad);
    if (hasBlue && hasCyan) return rawGrad;
  }
  return null;
}

// True when the declaration body has letter-spacing satisfying the
// craft rule: `letter-spacing >= 0.06em` of the element's own font.
//
// `em` maps directly to the 0.06 floor — it is relative to the
// element's own font-size, which is what the rule measures against.
//
// `rem` and `px` are absolute relative to the element: `rem` resolves
// against the root font-size (assumed 16px — the browser default and
// the value all OD seed templates use), so `0.06rem` on a 48px heading
// is `0.96px`, only `0.02em` of the element. Treating `rem` like `em`
// (the previous behaviour) accepts that as compliant when the rule
// it enforces is the per-element em floor; convert `rem` to absolute
// px and reuse the same px-vs-element-font-size resolution.
//
// px (and the converted-rem path) resolve in three steps:
//   1. If the same rule body declares `font-size` in `px` or `rem`
//      (after `var()` resolution), convert it to absolute px and
//      compare px tracking against `fs * 0.06` — exact translation
//      of the em rule. `rem` font sizes resolve via the same root
//      assumption used for tracking, so a `font-size: 3rem` heading
//      enforces a 2.88px floor instead of the lenient body fallback.
//   2. If the rule explicitly declares a `font-size` in a unit we
//      can't resolve (`em`, `%`, `calc(...)`, an unresolved var,
//      etc.), refuse the lenient fallback: the heading might be
//      arbitrarily large, in which case 1px tracking is well below
//      0.06em. Treat as missing tracking — the agent can either
//      switch to `em` letter-spacing or declare an explicit px/rem
//      font-size we can verify.
//   3. Otherwise (no font-size declared at all, font-size inherited),
//      use a conservative `>= 1px` absolute fallback. That stays
//      correct for the typical body-text default of 16px (1px / 16px
//      ≈ 0.0625em, just over the floor) and for any smaller label
//      (1px / 14px ≈ 0.071em, 1px / 12px ≈ 0.083em).
//
// `scopes` (optional) is the array of per-scope token records
// harvested from global theme scopes elsewhere in the artifact (see
// `extractCssTokens`). Each record carries the scope's per-scope
// last-write-wins token map plus enough metadata to identify which
// themes the scope applies to. Per-theme effective maps are built
// here via `buildResolvedThemes` so simple `var(--name)` (and
// `var(--name, fallback)`) references in the body resolve to the
// value the browser would render in that theme — keeping values
// declared in the same scope paired together. References without a
// matching token but with an inline fallback (`var(--x, 0.08em)`)
// resolve to the fallback; unresolved references with no fallback
// stay in place so the existing "no numeric value" path returns
// false.
//
// When a token resolves to different values in different themes
// (e.g. `:root { --caps-tracking: 0.02em }` overridden by
// `[data-theme="dark"] { --caps-tracking: 0.08em }`), the helper is
// conservative: it walks every per-theme map produced by
// `buildResolvedThemes` and returns true only if EVERY theme satisfies
// the 0.06em floor. A theme-scoped override that lifts the value
// above the floor must not silently rescue a default value that
// renders below it. Crucially, theme maps preserve the scope-internal
// relationship between tokens, so a paired declaration such as
// `:root { --display-size: 16px; --caps-tracking: 1px }` is judged
// against (16px, 1px) — never against the impossible cross-theme
// pairing (48px, 1px) that an independent per-token cartesian would
// emit.
function hasAdequateUppercaseTracking(body: string, themes: ReadonlyMap<string, string>[]): boolean {
  if (!body.includes('var(')) {
    return isResolvedTrackingAdequate(body);
  }
  for (const themeMap of themes) {
    const resolved = resolveCssVars(body, themeMap);
    if (!isResolvedTrackingAdequate(resolved)) return false;
  }
  return true;
}

// Single-resolution tracking check. Parses the declaration list with
// exact property names (so token-name declarations such as
// `--letter-spacing: 0.08em` cannot satisfy the rule) and selects the
// LAST matching `letter-spacing` and `font-size` declarations to model
// CSS source-order cascade — `.eyebrow { letter-spacing: 0.08em;
// letter-spacing: 0.02em }` renders the noncompliant `0.02em` value,
// so the lint must judge against the last declaration, not the first.
function isResolvedTrackingAdequate(body: string): boolean {
  const decls = parseCssDeclarations(body, { stripImportant: true });
  const ls = findLastDeclaration(decls, 'letter-spacing');
  if (!ls) return false;
  const lsMatch = /^(-?\d*\.?\d+)\s*(em|px|rem)$/i.exec(ls.value);
  if (!lsMatch) return false;
  const valueText = lsMatch[1];
  const unitText = lsMatch[2];
  if (valueText == null || unitText == null) return false;
  const v = parseFloat(valueText);
  const unit = unitText.toLowerCase();
  if (unit === 'em') return v >= 0.06;
  const trackingPx = unit === 'rem' ? v * ROOT_FONT_PX : v;
  const fsPx = resolveFontSizePx(decls);
  if (fsPx != null) {
    return fsPx > 0 && trackingPx >= fsPx * 0.06;
  }
  if (decls.some((d) => d.prop === 'font-size')) return false;
  return trackingPx >= 1;
}

// Build per-theme effective token maps from the per-scope records
// produced by `extractCssTokens`. A "theme" is the default rendering
// (no theme attribute set) plus one entry per distinct theme-attribute
// selector seen across scopes. Default-applying scopes (whose selector
// list contains a bare `:root` / `html` / `body`) apply to every theme
// as a baseline; variant scopes apply only to the themes their
// selector targets. Within a single theme, scopes are applied in
// source order so the final value reflects the cascade the browser
// would render.
//
// Returned as an array — one map per theme. The lint passes only when
// every theme map satisfies the rule, so a default-theme value below
// the floor flags even if a variant overrides it above the floor (and
// vice versa). Building per-theme maps preserves the scope-internal
// relationship between tokens, so values declared together in the
// same scope (e.g. `--display-size` and `--caps-tracking` both on
// `:root`) stay paired during evaluation. The previous design merged
// values by token name across scopes and then took an independent
// per-token cartesian product, which generated impossible cross-theme
// pairings such as `(default-size, dark-track)` and emitted false
// positives on legitimate light/dark theme variants.
class LayeredTokenMap implements ReadonlyMap<string, string> {
  readonly layerBase: ReadonlyMap<string, string>;
  readonly layerOwn: Map<string, string>;

  constructor(layerBase: ReadonlyMap<string, string>, layerOwn = new Map<string, string>()) {
    this.layerBase = layerBase;
    this.layerOwn = layerOwn;
  }

  get size(): number {
    let extra = 0;
    for (const key of this.layerOwn.keys()) {
      if (!this.layerBase.has(key)) extra += 1;
    }
    return this.layerBase.size + extra;
  }

  has(key: string): boolean {
    return this.layerOwn.has(key) || this.layerBase.has(key);
  }

  get(key: string): string | undefined {
    return this.layerOwn.has(key) ? this.layerOwn.get(key) : this.layerBase.get(key);
  }

  private merged(): Map<string, string> {
    const out = new Map(this.layerBase);
    for (const [k, v] of this.layerOwn) out.set(k, v);
    return out;
  }

  forEach(
    callbackfn: (value: string, key: string, map: ReadonlyMap<string, string>) => void,
    thisArg?: unknown,
  ): void {
    for (const [k, v] of this.entries()) {
      callbackfn.call(thisArg, v, k, this);
    }
  }

  entries(): ReturnType<ReadonlyMap<string, string>['entries']> {
    return this.merged().entries();
  }

  keys(): ReturnType<ReadonlyMap<string, string>['keys']> {
    return this.merged().keys();
  }

  values(): ReturnType<ReadonlyMap<string, string>['values']> {
    return this.merged().values();
  }

  [Symbol.iterator](): ReturnType<ReadonlyMap<string, string>[typeof Symbol.iterator]> {
    return this.merged()[Symbol.iterator]();
  }
}

function buildResolvedThemes(scopes: CssTokenScope[]): ReadonlyMap<string, string>[] {
  const baseTokens = new Map<string, string>();
  const themeKeys = new Set(['default']);
  for (const scope of scopes) {
    for (const k of scope.themeKeys) themeKeys.add(k);
  }
  const themes = new Map<string, LayeredTokenMap>();
  for (const k of themeKeys) themes.set(k, new LayeredTokenMap(baseTokens));
  const keyHolders = new Map<string, Set<Map<string, string>>>();

  for (const scope of scopes) {
    if (scope.isDefault) {
      for (const [k, v] of scope.tokens) {
        baseTokens.set(k, v);
        const holders = keyHolders.get(k);
        if (holders) {
          for (const ownMap of holders) ownMap.delete(k);
          holders.clear();
        }
      }
    } else {
      for (const themeKey of scope.themeKeys) {
        const map = themes.get(themeKey);
        if (!map) continue;
        for (const [k, v] of scope.tokens) {
          map.layerOwn.set(k, v);
          let holders = keyHolders.get(k);
          if (!holders) {
            holders = new Set();
            keyHolders.set(k, holders);
          }
          holders.add(map.layerOwn);
        }
      }
    }
  }
  return Array.from(themes.values());
}

function isBareGlobalSelector(s: string): boolean {
  return /^(?::root|html|body)$/.test(s);
}

// Resolve a same-rule `font-size` declaration to absolute px. Returns
// the px value when font-size is declared in `px` or `rem` (rem maps
// via the root font-size assumption shared with tracking); returns
// `null` when font-size is absent OR present in an unresolvable unit
// (`em`, `%`, `calc(...)`, an unresolved `var(--...)`). The caller
// distinguishes those two `null` cases by re-checking the parsed
// declarations for an exact `font-size` property.
//
// Selects the LAST `font-size` declaration in source order so that a
// rule like `.display { font-size: 48px; font-size: 1em }` is judged
// against the noncompliant `1em` the browser actually renders, not the
// stale earlier `48px`. CSS cascade is last-write-wins on conflicting
// declarations within a single rule body.
function resolveFontSizePx(decls: CssDeclaration[]): number | null {
  const fs = findLastDeclaration(decls, 'font-size');
  if (!fs) return null;
  const m = /^(-?\d*\.?\d+)\s*(px|rem)$/i.exec(fs.value);
  if (!m) return null;
  const valueText = m[1];
  const unitText = m[2];
  if (valueText == null || unitText == null) return null;
  const v = parseFloat(valueText);
  const unit = unitText.toLowerCase();
  return unit === 'rem' ? v * ROOT_FONT_PX : v;
}

// Collect CSS custom properties (`--name: value`) declared in global
// theme scopes (`:root`, `html`, theme-attribute selectors) from every
// `<style>` block in the artifact. Tokens declared on component
// selectors are intentionally ignored: the lint must still catch
// indigo / under-tracking laundered through a local var, and the
// tracking helper resolves only the global-scope tokens artifacts use
// to express design intent.
//
// Returns an array of per-scope records:
//   `{ selectors, tokens, isDefault, themeKeys }`
// where `tokens` is the per-scope last-write-wins map of CSS custom
// properties, `selectors` lists the parsed selectors from the rule,
// `isDefault` is true if any selector is a bare global
// (`:root` / `html` / `body` without an attribute suffix), and
// `themeKeys` is the set of theme-attribute selector strings the rule
// targets. Per-theme effective maps are derived downstream from these
// records by `buildResolvedThemes`, which preserves the scope-internal
// relationship between values so a paired declaration like
// `:root { --display-size: 16px; --caps-tracking: 1px }` is judged
// as `(16px, 1px)` together, not against the impossible cross-theme
// pairing `(48px, 1px)` that an independent per-token cartesian over
// distinct values would emit.
//
// Within a single rule body, CSS cascade is last-write-wins: a block
// like `:root { --caps-tracking: 0.02em; --caps-tracking: 0.08em; }`
// renders the second value, and the first never reaches any element.
// Per-scope, we keep only the LAST value declared for each token
// name; cross-scope merging happens later in `buildResolvedThemes`,
// where the same source-order cascade is applied between scopes that
// target the same theme.
function extractCssTokens(styleBlocks: readonly StyleBlock[]): CssTokenScope[] {
  const scopes: CssTokenScope[] = [];
  for (const styleBlock of styleBlocks) {
    const css = stripCssComments(styleBlock.css);
    for (const rule of scanCssLeafRules(css)) {
      const sel = rule.selector;
      if (!selectorListIsGlobalThemeScope(sel)) continue;
      const selectors = sel.split(',').map((s) => s.trim()).filter(Boolean);
      const isDefault = selectors.some(isBareGlobalSelector);
      const themeKeys = new Set(
        selectors.filter((s) => !isBareGlobalSelector(s)),
      );
      const tokens = new Map();
      for (const decl of splitCssStatements(rule.body).map((d) => d.trim()).filter(Boolean)) {
        const dm = /^(--[\w-]+)\s*:\s*(.+)$/.exec(decl);
        if (dm) {
          const tokenName = dm[1];
          const tokenValue = dm[2];
          if (tokenName != null && tokenValue != null) tokens.set(tokenName, tokenValue.trim());
        }
      }
      if (tokens.size === 0) continue;
      scopes.push({ selectors, tokens, isDefault, themeKeys });
    }
  }
  return scopes;
}

// Replace simple `var(--name)` (and `var(--name, fallback)`) references
// in a CSS declaration body with the literal token value. Iterates a
// few times so a token whose value is itself another `var(--...)`
// resolves through one or two hops; bounded depth and incremental
// expansion size so cyclic or Billion-Laughs definitions terminate
// before allocating past `maxLen`.
const VAR_RESOLVE_MAX_DEPTH = 4;
const VAR_RESOLVE_MIN_OUTPUT_CAP = 16_384;
const VAR_REF_RE = /var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g;

function resolveCssVars(body: string, tokens: ReadonlyMap<string, string>): string {
  const maxLen = Math.max(body.length * 4, VAR_RESOLVE_MIN_OUTPUT_CAP);
  let out = body;
  for (let i = 0; i < VAR_RESOLVE_MAX_DEPTH; i++) {
    VAR_REF_RE.lastIndex = 0;
    const chunks: string[] = [];
    let cursor = 0;
    let nextLen = 0;
    let changed = false;
    let exceeded = false;
    let m: RegExpExecArray | null;
    while ((m = VAR_REF_RE.exec(out)) !== null) {
      const full = m[0];
      const name = m[1] ?? '';
      const fallback = m[2];
      const v = tokens.get(name);
      const replacement = v != null ? v : fallback != null ? fallback.trim() : full;
      if (replacement !== full) changed = true;
      const prefixLen = m.index - cursor;
      nextLen += prefixLen + replacement.length;
      if (nextLen > maxLen) {
        exceeded = true;
        break;
      }
      if (prefixLen > 0) chunks.push(out.slice(cursor, m.index));
      chunks.push(replacement);
      cursor = m.index + full.length;
    }
    if (exceeded || !changed) break;
    nextLen += out.length - cursor;
    if (nextLen > maxLen) break;
    if (cursor < out.length) chunks.push(out.slice(cursor));
    out = chunks.join('');
  }
  return out;
}

// Remove CSS rule blocks that look like design-token definitions.
// Operates only on CSS extracted from <style> blocks — running the
// rule-shaped regex against the full HTML string makes the first
// selector capture include leading text like `<style>`, which then
// fails the `:root` selector test.
//
// A rule is treated as a token block only when ALL THREE conditions hold:
//   1. every selector in the list is a global theme-scope selector
//      (`:root`, `:root[data-theme="..."]`, `html`, `body`, or a bare
//      attribute selector for a known global-theme switch —
//      `data-theme`, `data-color-scheme`, `data-mode`). Selector lists
//      that mix in a component selector — e.g.
//      `:root, .cta { --cta-bg: #6366f1 }` — or that target an
//      arbitrary component/state attribute like `[data-variant="primary"]`
//      or `[aria-current="page"]` fail this test, so indigo laundered
//      through a local var or rule still trips the lint.
//   2. its body is token-shaped: only CSS custom properties
//      (`--name: value`), with a small allowlist for global-theme
//      metadata such as `color-scheme` that legitimately accompanies
//      tokens in `:root` and cannot smuggle a visible color.
//      A non-token declaration on `:root` (e.g.
//      `:root { background: #6366f1 }`) keeps the rule in scope so
//      the indigo check fires.
//   3. no token in the body launders an indigo hex through a
//      non-`--accent` name. The craft contract's escape hatch is to
//      encode indigo as the active design system's `--accent` token;
//      anything else (`:root { --primary: #6366f1 }`,
//      `:root { --button-bg: #4f46e5 }`) is still the LLM-default
//      color hidden behind an arbitrary token name and must stay in
//      scope of the indigo scan.
function stripTokenBlocks(input: string, styleBlocks: readonly StyleBlock[]): string {
  if (styleBlocks.length === 0) return input;
  const parts: string[] = [];
  let cursor = 0;
  for (const block of styleBlocks) {
    if (block.start > cursor) parts.push(input.slice(cursor, block.start));
    parts.push(`${block.open}${stripTokenBlocksFromCss(block.css)}${block.close}`);
    cursor = block.end;
  }
  if (cursor < input.length) parts.push(input.slice(cursor));
  return parts.join('');
}

function stripTokenBlocksFromCss(css: string): string {
  // Strip CSS comments before any structural matching: a block like
  // `:root { /* brand accent */ --accent: #6366f1; }` would otherwise
  // produce a declaration fragment that begins with the comment,
  // fail `isTokenShapedDeclaration`, and leave a legitimate token
  // definition in scope of the indigo scan.
  const cleaned = stripCssComments(css);
  // Scan innermost leaf rules linearly so nested token scopes inside
  // `@media (...) { :root { --accent: #6366f1 } }`, preceding
  // `@import ...;` declarations, and braces inside quoted values keep
  // accurate rule spans without corrupting surrounding wrappers.
  const out: string[] = [];
  let cursor = 0;
  for (const rule of scanCssLeafRules(cleaned)) {
    if (!selectorListIsGlobalThemeScope(rule.selector)) continue;
    const decls = splitCssStatements(rule.body)
      .map((d: string) => d.trim())
      .filter(Boolean);
    if (decls.length === 0) continue;
    if (!decls.every(isTokenShapedDeclaration)) continue;
    // The `--accent` escape hatch is for `--accent` only. Any other
    // global token whose value carries an AI-default indigo hex is
    // still laundering the LLM-default color through an arbitrary
    // name (`--primary: #6366f1`, `--button-bg: #4f46e5`, …). Keep
    // the rule in scope so the indigo lint fires on the literal hex.
    if (decls.some(declarationLaundersIndigo)) continue;
    if (rule.start > cursor) out.push(cleaned.slice(cursor, rule.start));
    cursor = rule.end;
  }
  if (cursor < cleaned.length) out.push(cleaned.slice(cursor));
  return out.join('');
}

function declarationLaundersIndigo(decl: string): boolean {
  const m = /^(--[\w-]+)\s*:\s*(.+)$/.exec(decl);
  if (!m) return false;
  const tokenName = m[1];
  const tokenValue = m[2];
  if (tokenName == null || tokenValue == null) return false;
  if (tokenName.toLowerCase() === '--accent') return false;
  const value = tokenValue.toLowerCase();
  for (const hex of AI_DEFAULT_INDIGO) {
    if (value.includes(hex.toLowerCase())) return true;
  }
  return false;
}

function isTokenShapedDeclaration(decl: string): boolean {
  // CSS custom property — the canonical token shape.
  if (/^--[\w-]+\s*:/.test(decl)) return true;
  // Global-theme metadata that legitimately accompanies tokens in
  // `:root` / `html` / `[data-theme="..."]` and whose values are
  // keywords, so they cannot smuggle a hardcoded color.
  if (/^color-scheme\s*:/i.test(decl)) return true;
  return false;
}

function selectorListIsGlobalThemeScope(selector: string): boolean {
  const parts = selector.split(',').map((s: string) => s.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every(isGlobalThemeScopeSelector);
}

// Attribute selectors — bare or attached to `:root`/`html`/`body` —
// are exempted only when the attribute is one of the known
// global-theme switches. A broader exemption would also strip
// arbitrary component/state attribute rules
// (e.g. `[data-variant="primary"] { --button-bg: #6366f1; }`,
// `:root[data-variant="primary"] { --button-bg: #6366f1; }`, or
// `html[aria-current="page"] { --nav-accent: #6366f1; }`), which
// is the exact component-local indigo laundering this lint is
// meant to catch.
const GLOBAL_THEME_ATTRIBUTES = new Set([
  'data-theme',
  'data-color-scheme',
  'data-mode',
]);

function isGlobalThemeScopeSelector(s: string): boolean {
  // :root / html / body, optionally suffixed with a single attribute
  // selector. The bare form (no attribute) is always a global theme
  // scope; the prefixed form is only a theme scope when the attribute
  // names one of GLOBAL_THEME_ATTRIBUTES. A component/state attribute
  // suffix (`:root[data-variant="primary"]`, `html[aria-current="page"]`)
  // must keep the rule in scope of the indigo lint.
  const tagAttr = /^(?::root|html|body)(?:\[([a-zA-Z-]+)(?:[*^$|~]?=[^\]]*)?\])?$/.exec(s);
  if (tagAttr) {
    const attrName = tagAttr[1];
    if (!attrName) return true;
    return GLOBAL_THEME_ATTRIBUTES.has(attrName.toLowerCase());
  }
  // Bare attribute selector restricted to known global-theme switches.
  const bareAttr = /^\[([a-zA-Z-]+)(?:[*^$|~]?=[^\]]*)?\]$/.exec(s);
  const bareAttrName = bareAttr?.[1];
  if (bareAttrName && GLOBAL_THEME_ATTRIBUTES.has(bareAttrName.toLowerCase())) {
    return true;
  }
  return false;
}
