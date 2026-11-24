# Design system authoring guide

**Parent:** [`spec.md`](spec.md) · **Siblings:** [`architecture.md`](architecture.md) · [`skills-protocol.md`](skills-protocol.md) · [`agent-adapters.md`](agent-adapters.md)

This guide describes the current design-system package consumed by the daemon,
picker, prompt composer, importers, and repository guards. Read it together with
[`design-systems/README.md`](../design-systems/README.md) and the contract notes
in [`design-systems/_schema/AGENTS.md`](../design-systems/_schema/AGENTS.md).

## 1. Package contract

A new design system is a package, not a standalone Markdown file. Its minimum
machine-readable shape is:

```text
design-systems/<slug>/
├── manifest.json  ← discovery metadata and declared package files
├── DESIGN.md      ← canonical design prose for agents
└── tokens.css     ← canonical compiled CSS custom properties
```

All three files are present in the bundled catalog. The daemon retains a
`DESIGN.md`-only discovery path for legacy or user-installed folders, but that is
a compatibility fallback, not the authoring target for new repository content.

The v1 manifest uses fixed canonical file names:

```json
{
  "schemaVersion": "od-design-system-project/v1",
  "id": "acme",
  "name": "Acme",
  "category": "Productivity & SaaS",
  "description": "A concise English catalog summary.",
  "source": {
    "type": "bundled",
    "origin": "OpenDesign curated bundled fixture"
  },
  "files": {
    "design": "DESIGN.md",
    "tokens": "tokens.css"
  }
}
```

- The folder and `manifest.id` must use the same normalized ASCII slug.
- `files.design` is `DESIGN.md`; `files.tokens` is `tokens.css`.
- `name`, `category`, and `description` are the primary catalog copy for a
  packaged system.
- `source` records whether the package is bundled, local, GitHub, or shadcn and
  carries the source-specific provenance fields.
- Every declared path must be safe, relative, and present. The schema in
  [`manifest.schema.ts`](../design-systems/_schema/manifest.schema.ts) is the
  source of truth for allowed keys and values.

### Rich package files

The migrated package profile can also declare:

```text
USAGE.md                     agent-facing read-order and usage guide
components.html              standalone component fixture
components.manifest.json     derived component/token index
design-tokens.json           derived Design Tokens JSON
tailwind-v4.css               derived Tailwind v4 mapping
assets/                       optional static assets
fonts/                        optional webfonts
preview/                      indexed preview pages
source/                       importer evidence and token reports
```

Declare these through the corresponding manifest fields (`usage`,
`files.components`, `componentsManifest`, `files.designTokens`,
`files.tailwind`, `assetsDir`, `fonts`, `preview`, and `sourceFiles`). Do not add
undeclared alternate canonical files.

Once a package opts into the rich profile, the package-quality guard expects a
complete profile: `USAGE.md`; `components.html` plus its derived manifest; and
at least three preview pages covering colors, typography, and spacing. Imported
`hybrid` and `verbatim` packages also have source-evidence requirements enforced
by the manifest guard.

Derived files are caches, not competing sources of truth:

- `components.manifest.json` is regenerated from `components.html` and
  `tokens.css`.
- `design-tokens.json` is regenerated from the token-contract report and must
  agree with `tokens.css`.
- `tailwind-v4.css` is regenerated from `tokens.css`.

## 2. Catalog metadata precedence

Packaged systems should put stable display metadata in `manifest.json`. The
daemon resolves catalog fields in this order:

| Field | Precedence |
| --- | --- |
| Title | user `metadata.json` override → `manifest.name` → Markdown H1 → frontmatter `name` → folder id |
| Category | user `metadata.json` override → `manifest.category` → Markdown `> Category:` → frontmatter `category` → `Uncategorized` |
| Summary | non-empty `manifest.description` → first Markdown summary paragraph → frontmatter `description` |
| Surface | user `metadata.json` override → Markdown surface metadata → frontmatter `surface` → `web` |

The H1 and `> Category:` convention therefore remains useful for readable prose
and legacy fallback, but it does not override manifest metadata in a packaged
system. Complete frontmatter color metadata wins over Markdown-derived swatches;
otherwise the daemon uses Markdown swatches and finally any partial frontmatter
row.

## 3. Writing `DESIGN.md`

`DESIGN.md` explains intent, decisions, and usage to an agent. It is not a
fixed nine-section numbered schema. For a migrated package, the quality guard
requires at least seven H2 headings (`## ...`); it does not require
specific numbers, titles, or ordering.

A useful document normally covers at least:

- visual theme and atmosphere;
- color roles and contrast intent;
- typography families, scale, leading, and tracking;
- spacing, layout, and composition;
- components and interaction states;
- motion behavior and reduced-motion handling;
- accessibility expectations;
- concrete anti-patterns.

Use headings that describe the actual system. A source-derived brand may add
sections for provenance, imagery, data visualization, editorial voice, or
platform-specific behavior. Avoid empty headings added only to meet the count.

Keep prose and compiled values synchronized. If `DESIGN.md` names an accent,
type scale, spacing rhythm, or motion duration, the corresponding binding in
`tokens.css` must express the same decision.

## 4. Authoring `tokens.css`

`tokens.css` is the canonical compiled token stylesheet that agents can consume
without translating prose into ad hoc values. Put shared declarations in a
`:root { ... }` block:

```css
:root {
  --bg: #ffffff;
  --fg: #18181b;
  --accent: #625df5;
  --font-display: "Inter", system-ui, sans-serif;
  --font-body: "Inter", system-ui, sans-serif;
}
```

The current token contract lives in
[`packages/contracts/src/design-systems/token-schema.ts`](../packages/contracts/src/design-systems/token-schema.ts)
and is re-exported through `design-systems/_schema/`. The repository guard
checks required A1, A2, and B-slot tokens, default parity, fixture synchronization,
and unknown-token allowlists. A final `tokens.css` must contain every required
shared slot; brand-specific extensions must use the documented extension
allowlist rather than silently inventing cross-brand tokens.

Use semantic variables in component CSS instead of repeating raw colors:

```css
.button-primary {
  background: var(--accent);
  color: var(--accent-on);
}
```

When the system supports a dark variant, override semantic tokens under a
theme selector rather than copying unrelated component rules:

```css
[data-theme="dark"] {
  --bg: #111113;
  --fg: #fafafa;
}
```

## 5. Component fixtures and usage guides

For a rich package, `components.html` is the executable proof that the tokens
compose into real controls and layouts. It should cover at least four component
groups and use declared tokens. The quality guard currently requires at least
10 fixture selectors and 8 referenced tokens. The derived component manifest
must not contain undeclared token references.

`USAGE.md` is the agent-facing router. It must contain the H2 sections `Read
Order`, `Design Highlights`, `Do`, and `Avoid`. Keep it concise: direct the agent
to the relevant package files and call out decisions that would otherwise be
easy to miss.

## 6. Accessibility

Baseline authoring expectations and static enforcement follow the [W3C WCAG 2.2 Recommendation](https://www.w3.org/TR/WCAG22/):

- Verify normal text at 4.5:1 contrast and large text at 3:1 against the actual
  paired background.
- Give every interactive control a visible `:focus-visible` treatment.
- Preserve native semantics and keyboard behavior in component fixtures.
- Do not claim conformance without checking every foreground/background pair
  used by the fixture.
- Scope reduced-motion overrides to the elements and properties that animate.
- `od lint` checks the statically resolvable subset of WCAG 2.2 via declarative
  compliance profiles in `@open-design/contracts` (`A11Y_COMPLIANCE_PROFILES` on
  frozen `A11Y_COMPLIANCE_LEVELS`): `wcag-a`, `wcag20-aa`, `wcag21-aa`,
  `wcag22-aa` (default), `wcag22-aaa`, and `off`. Pass `--a11y-level <tier>` to
  `od lint`, `a11yLevel` in the request body of `POST /api/artifacts/lint` /
  `POST /api/artifacts/save`, or field-level partial `a11yProfile` overrides to
  `lintArtifact()` to tune enabled rule fields (while re-enabling a `null` rule
  slot requires a complete rule spec) without changing linter logic.
- Wire DTOs preserve the structured 3-field provenance shape
  `compliance: { standard, sc, level }` on every tiered finding (`contrast-unresolved`
  omits `compliance`). Consumers needing authoritative W3C anchor URLs can call
  `formatWcagCriterionUrl(finding.compliance)` from `@open-design/contracts`
  (returns `https://www.w3.org/TR/WCAG22/#<criterion-slug>` or `null` for
  unrecognized/non-object inputs). CLI plain-text output and `<artifact-lint>`
  agent blocks render `[WCAG X.Y SC Z, Level]`, and CLI `--json` / HTTP `/lint`
  and `/save` responses disclose the active `a11yLevel`.
- `low-contrast-ui` remains P0 under WCAG 2.1/2.2 AA and AAA presets (`wcag20-aa`
  omits `uiContrast` by default); decorative hairline `--border` tokens used for
  cards and dividers typically sit below 3:1, so form controls (`input`,
  `select`, `textarea`) should bind a ≥ 3:1 high-contrast token (such as
  `--muted`, `--fg-2`, or `--fg`), an explicit ≥ 3:1 control border colour, a
  crisp outer ring `box-shadow`, or a ≥ 3:1 fill rather than reusing a hairline
  `--border` token.

### Static Linter Matrix (10 Rule Slots)

| Rule ID | Slot | Active Tiers | Severity | Thresholds | W3C WCAG 2.2 Anchor | Static Coverage & Limits |
|---|---|---|---|---|---|---|
| `low-contrast-text` | `textContrast` | `wcag20-aa`..`wcag22-aaa` | P0 | `4.5:1` / `3:1` AA; `7:1` / `4.5:1` AAA (`24px`, bold `18.66px`) | [SC 1.4.3](https://www.w3.org/TR/WCAG22/#contrast-minimum) / [SC 1.4.6](https://www.w3.org/TR/WCAG22/#contrast-enhanced) | Evaluates rules pairing foreground `color` and an opaque background across theme scopes; inherited single-sided rules are skipped. |
| `low-contrast-ui` | `uiContrast` | `wcag21-aa`..`wcag22-aaa` | P0 | `3:1` vs page backdrop | [SC 1.4.11](https://www.w3.org/TR/WCAG22/#non-text-contrast) | Evaluates boundary form controls (`input` except hidden/button/submit/reset/image, `select`, `textarea`, checkbox/switch/radio/textbox/combobox/slider roles) over `pageBackdrop`. |
| `missing-accessible-name` | `accessibleName` | `wcag-a`..`wcag22-aaa` | P0 | Non-empty name | [SC 4.1.2](https://www.w3.org/TR/WCAG22/#name-role-value) | Linearly scans buttons, links (`href`), 8 ARIA widget roles (`button`, `link`, `checkbox`, `switch`, `tab`, `menuitem`, `radio`, `option` — excluding `textbox`, `combobox`, and `slider`), and native form fields (`input` except hidden/submit/reset/button-with-value/image-with-alt, `select`, `textarea`) for text, `<img alt>`, `aria-label`, resolvable `aria-labelledby`, `title`, or `<label>`. |
| `target-size-min` | `targetSize` | `wcag22-aa`..`wcag22-aaa` | P1 | `24×24` CSS px AA; `44×44` CSS px AAA | [SC 2.5.8](https://www.w3.org/TR/WCAG22/#target-size-minimum) / [SC 2.5.5](https://www.w3.org/TR/WCAG22/#target-size-enhanced) | Checks static `width`/`height` + `min-*` (`px`/`rem`/`pt`); skips pseudo-elements; cannot compute rendered boxes or `2.5.8` spacing exceptions. |
| `contrast-unresolved` | `unresolvedContrast` | `wcag20-aa`..`wcag22-aaa` | P1 | — | — | Surfaces unresolvable `color-mix()`, `currentColor`, gradients, translucent backgrounds behind text, or undefined tokens so ambiguity never silently passes (`compliance` omitted). |
| `missing-img-alt` | `imgAlt` | `wcag-a`..`wcag22-aaa` | P0 | Non-whitespace `alt` or explicit decorative / ARIA marking | [SC 1.1.1](https://www.w3.org/TR/WCAG22/#non-text-content) | Checks HTML `<img>` elements (quote-aware, excluding comments/`<template>`/raw-text/`<svg>`); exempts `alt=""`, `role="presentation"\|"none"`, `aria-hidden="true"`, valid `aria-label`/`aria-labelledby`. `<input type="image">` stays under `missing-accessible-name`; `<svg role="img">` and CSS `background-image` are unchecked here. |
| `missing-page-title` | `pageTitle` | `wcag-a`..`wcag22-aaa` | P1 | Non-empty `<title>` in `<head>` (or under `<html>`) | [SC 2.4.2](https://www.w3.org/TR/WCAG22/#page-titled) | **Fragment-safe**: stays quiet on partial artifacts without `<html>`/`<head>` (e.g. `<!doctype html><main>...</main>`). Ignores `<svg><title>` subtrees. |
| `missing-html-lang` | `htmlLang` | `wcag-a`..`wcag22-aaa` | P1 | Non-whitespace `lang` on `<html>` | [SC 3.1.1](https://www.w3.org/TR/WCAG22/#language-of-page) | **Fragment-safe**: checks only when a root `<html>` tag exists (`<!doctype html><main>...</main>` and `<head>`-only snippets stay quiet); verifies presence, not BCP 47 subtag validity. |
| `focus-outline-suppressed` | `focusOutline` | `wcag20-aa`..`wcag22-aaa` | P0 | Visible `:focus` / `:focus-visible` indicator or paired `:focus:not(:focus-visible)` | [SC 2.4.7](https://www.w3.org/TR/WCAG22/#focus-visible) | Checks focus pseudo-class rules (`:not()`-aware; ignores `:focus-within`, pseudo-elements, `@keyframes`, and non-pseudo base rules); accepts visible border/background/text-decoration/non-zero shadow, and treats unexpanded external `var(--focus-ring)` as external tokens without false-positive P0 (while flagging `:root { --focus-ring: none }` and unpaired `:focus:not(:focus-visible)`). |
| `low-focus-appearance` | `focusAppearance` | `wcag22-aaa` only | P1 | `≥ 2px` width/spread and `≥ 3:1` vs `pageBackdrop` | [SC 2.4.13](https://www.w3.org/TR/WCAG22/#focus-appearance) | Static perimeter-width & contrast proxy against `pageBackdrop` (supports Forced-Colors outer `box-shadow` rings when `outline` is transparent/suppressed; skips `outline: auto` / `currentColor` / dark-mode unknown backdrops with zero `contrast-unresolved`). **Heads-up**: low-alpha `--focus-ring` shadows that pass `2.4.7` often fall below `3:1` under `wcag22-aaa`. |

### Criteria Requiring Browser, DOM, or Interactive Verification (Out of Static Scope)

Static HTML/CSS linting cannot measure live layout, scroll occlusion, pointer gestures, or multi-screen flows. Verify these WCAG 2.2 criteria separately in browser/interactive reviews:

- **SC 2.4.11 / 2.4.12** (*Focus Not Obscured — Minimum / Enhanced*): sticky headers, drawers, toasts, and overlays obscuring focused elements depend on runtime bounding rects and scroll position.
- **SC 2.5.7** (*Dragging Movements*): single-pointer alternatives to drag-and-drop interactions require DOM event & behavior testing.
- **SC 3.2.6** (*Consistent Help*): cross-page relative placement of help mechanisms spans multi-route navigation.
- **SC 3.3.7 / 3.3.8 / 3.3.9** (*Redundant Entry*, *Accessible Authentication — Minimum / Enhanced*): multi-step form state, paste-friendly credential inputs, and cognitive function test alternatives depend on runtime application flows.
- **SC 2.5.8 target spacing exceptions** (*24px spacing circles*) and **SC 1.3.1 / keyboard tab order** (*DOM nesting, landmark semantics, runtime focus order*): cannot be inferred from isolated CSS declarations alone.

## 7. Motion and interaction

The repository UI motion convention is a strong ease-out:

```css
:root {
  --ease-standard: cubic-bezier(0.23, 1, 0.32, 1);
  --motion-enter: 200ms;
  --motion-exit: 140ms;
}
```

Use about 200ms for entry and 140ms for exit. Do not use `ease-in` for UI
elements, and do not animate from `scale(0)`; start at `scale(0.9)` or higher
with opacity when scale is appropriate. Continuous data or progress motion may
remain linear. A brand may bind different token values when motion is genuinely
part of its identity, but the behavior must still be accessible and documented.

## 8. Localized catalog copy

English fallback metadata comes from the package. Built-in localized catalog
copy is keyed by design-system id in `apps/web/src/i18n/content.ts` and its
language modules.

There are currently 17 direct non-English content bundles:

`de`, `fr`, `ru`, `zh-CN`, `ja`, `id`, `es-ES`, `pt-BR`, `ar`, `fa`, `ko`,
`pl`, `hu`, `uk`, `tr`, `th`, and `it`.

`zh-TW` intentionally reuses the `zh-CN` built-in-content bundle when a
dedicated entry is unavailable. When adding or renaming bundled catalog copy,
update the same id in all 17 direct `*_DESIGN_SYSTEM_SUMMARIES` maps and keep
category mappings aligned. The runtime still falls back to the package summary
or category, but that fallback is not a substitute for the repository's full
localized-content coverage.

## 9. Review checklist

- [ ] Folder slug and `manifest.id` match and are normalized.
- [ ] `manifest.json`, `DESIGN.md`, and `tokens.css` are present and consistent.
- [ ] Every declared manifest path exists; source and license provenance are clear.
- [ ] `DESIGN.md` has at least seven substantive H2 sections without relying on a fixed numbered template.
- [ ] `tokens.css` satisfies the shared token schema and agrees with the prose.
- [ ] Rich-package usage, component, preview, and source-evidence files are complete.
- [ ] Derived component, Design Tokens, and Tailwind outputs are regenerated rather than hand-edited.
- [ ] Component fixtures use declared semantic tokens and include keyboard, focus, contrast, and reduced-motion behavior.
- [ ] All 17 direct non-English catalog maps are updated for bundled copy changes.
- [ ] `pnpm guard` and `pnpm typecheck` pass.

The executable guard inventory is owned by [`scripts/guard.ts`](../scripts/guard.ts).
Read it and the scripts it invokes instead of relying on a copied list of checks.
