// Accessibility rules in the artifact linter (WP9): WCAG 2.2 contrast,
// accessible names and target size. Each rule has a positive fixture (the
// defect fires) and a negative fixture (the compliant variant stays quiet).
// Colours the linter cannot resolve statically must surface as
// `contrast-unresolved` — never as a silent pass.

import { readFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  A11Y_COMPLIANCE_LEVELS,
  A11Y_RULE_IDS,
  formatWcagCriterionUrl,
} from '@open-design/contracts';
import { describe, expect, it } from 'vitest';

import { contrastRatio, lintAccessibility, parseCssColor } from '../src/lint-a11y.js';
import { lintArtifact, type LintFinding } from '../src/lint-artifact.js';

function ids(findings: LintFinding[]): string[] {
  return findings.map((f) => f.id);
}

function finding(findings: LintFinding[], id: string): LintFinding {
  const hit = findings.find((f) => f.id === id);
  if (!hit) throw new Error(`expected lint finding ${id}, got ${ids(findings).join(', ')}`);
  return hit;
}

describe('colour math', () => {
  it('parses hex, rgb(), hsl() and named colours', () => {
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('#00000080')?.a).toBeCloseTo(0.5, 2);
    expect(parseCssColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseCssColor('rgb(10 20 30 / 50%)')?.a).toBeCloseTo(0.5, 5);
    expect(parseCssColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseCssColor('White')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('color-mix(in oklab, red, blue)')).toBeNull();
    expect(parseCssColor('var(--fg)')).toBeNull();
    expect(parseCssColor('currentColor')).toBeNull();
  });

  it('computes the WCAG contrast ratio', () => {
    const white = parseCssColor('#ffffff')!;
    const black = parseCssColor('#000000')!;
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
    expect(contrastRatio(parseCssColor('#777777')!, white)).toBeCloseTo(4.48, 2);
  });
});

describe('low-contrast-text (SC 1.4.3)', () => {
  it('fires P0 on grey-on-white body text below 4.5:1', () => {
    const html = `<style>.note { color: #999999; background-color: #ffffff; }</style><p class="note">Saved</p>`;
    const hit = finding(lintArtifact(html), 'low-contrast-text');
    expect(hit.severity).toBe('P0');
    expect(hit.message).toContain('4.5:1');
    expect(hit.snippet).toContain('.note');
  });

  it('does not fire on #595959 on white (7:1)', () => {
    const html = `<style>.note { color: #595959; background: #fff; }</style><p class="note">Saved</p>`;
    expect(ids(lintArtifact(html))).not.toContain('low-contrast-text');
  });

  it('resolves design tokens from :root before comparing', () => {
    const fail = `<style>:root { --fg: #aaaaaa; --bg: #ffffff; } .card { color: var(--fg); background: var(--bg); }</style>`;
    expect(ids(lintArtifact(fail))).toContain('low-contrast-text');
    const pass = `<style>:root { --fg: #1a1a1a; --bg: #ffffff; } .card { color: var(--fg); background: var(--bg); }</style>`;
    expect(ids(lintArtifact(pass))).not.toContain('low-contrast-text');
  });

  it('fails when any theme variant is below the threshold', () => {
    const html = `<style>
      :root { --fg: #111111; --bg: #ffffff; }
      [data-theme="dark"] { --fg: #444444; --bg: #111111; }
      .card { color: var(--fg); background: var(--bg); }
    </style>`;
    expect(ids(lintArtifact(html))).toContain('low-contrast-text');
  });

  it('applies the 3:1 large-text threshold to 24px text and to bold 18.66px text', () => {
    // #949494 on white is ~3.03:1 — fails normal text, passes large text.
    const large = `<style>.hero { color: #949494; background: #fff; font-size: 24px; }</style>`;
    expect(ids(lintArtifact(large))).not.toContain('low-contrast-text');
    const bold = `<style>.hero { color: #949494; background: #fff; font-size: 19px; font-weight: 700; }</style>`;
    expect(ids(lintArtifact(bold))).not.toContain('low-contrast-text');
    const normal = `<style>.hero { color: #949494; background: #fff; font-size: 19px; }</style>`;
    expect(ids(lintArtifact(normal))).toContain('low-contrast-text');
  });

  it('checks inline style pairs', () => {
    const html = `<span style="color: #bbbbbb; background-color: white">Low</span>`;
    expect(ids(lintArtifact(html))).toContain('low-contrast-text');
  });

  it('composites a translucent foreground over an opaque background', () => {
    const html = `<style>.ghost { color: rgba(0, 0, 0, 0.3); background: #ffffff; }</style>`;
    expect(ids(lintArtifact(html))).toContain('low-contrast-text');
  });
});

describe('contrast-unresolved', () => {
  it('reports colours it cannot resolve instead of passing them', () => {
    const html = `<style>.btn { color: var(--missing); background: color-mix(in oklab, red, blue); }</style>`;
    const findings = lintArtifact(html);
    expect(ids(findings)).not.toContain('low-contrast-text');
    const hit = finding(findings, 'contrast-unresolved');
    expect(hit.message).toContain('unresolved');
    expect(hit.snippet).toContain('.btn');
  });

  it('treats a gradient or translucent background as unresolved', () => {
    const grad = `<style>.hero { color: #fff; background: linear-gradient(#000, #333); }</style>`;
    expect(ids(lintArtifact(grad))).toContain('contrast-unresolved');
    const alpha = `<style>.hero { color: #fff; background: rgba(0, 0, 0, 0.5); }</style>`;
    expect(ids(lintArtifact(alpha))).toContain('contrast-unresolved');
  });

  it('stays quiet when a rule does not pair a foreground with a background', () => {
    const html = `<style>.lead { color: #333; } .panel { background: #fafafa; } .tab { color: #999; background: transparent; }</style>`;
    const found = ids(lintArtifact(html));
    expect(found).not.toContain('contrast-unresolved');
    expect(found).not.toContain('low-contrast-text');
  });
});

describe('low-contrast-ui (SC 1.4.11)', () => {
  it('fires P1 when a control boundary is below 3:1 against the page', () => {
    const html = `<style>
      body { background: #ffffff; }
      input { border: 1px solid #dddddd; background: #ffffff; }
    </style><label>Email <input type="email"></label>`;
    const hit = finding(lintArtifact(html), 'low-contrast-ui');
    expect(hit.severity).toBe('P1');
    expect(hit.message).toContain('3:1');
  });

  it('passes when the border reaches 3:1', () => {
    const html = `<style>
      body { background: #ffffff; }
      input { border: 1px solid #767676; background: #ffffff; }
    </style><label>Email <input type="email"></label>`;
    expect(ids(lintArtifact(html))).not.toContain('low-contrast-ui');
  });

  it('passes when the control fill alone reaches 3:1', () => {
    const html = `<style>body { background: #fff; } select { background: #1f4fbf; color: #fff; border: 0; }</style>`;
    expect(ids(lintArtifact(html))).not.toContain('low-contrast-ui');
  });

  it('does not judge text buttons, whose label identifies them (SC 1.4.3 covers the text)', () => {
    const html = `<style>body { background: #fff; } .btn { background: #f4f4f4; color: #111; border: 1px solid #eee; }</style>
      <button class="btn">Save</button>`;
    expect(ids(lintArtifact(html))).not.toContain('low-contrast-ui');
  });

  it('judges a border-color declared without the border shorthand', () => {
    const html = `<style>body { background: #fff; } textarea { border-color: #e5e5e5; }</style>`;
    expect(ids(lintArtifact(html))).toContain('low-contrast-ui');
  });

  it('reports an unresolvable page backdrop as contrast-unresolved', () => {
    const html = `<style>body { background: url(paper.png); } input { border: 1px solid #ddd; }</style>`;
    const found = ids(lintArtifact(html));
    expect(found).not.toContain('low-contrast-ui');
    expect(found).toContain('contrast-unresolved');
  });

  it('counts a crisp outer box-shadow focus ring toward 3:1 boundary contrast', () => {
    const html = `<style>
      body { background: #f5f1e8; }
      input:focus { border-color: #ffef5a; box-shadow: 0 0 0 4px #000000, 0 0 0 8px #ffef5a; }
    </style>`;
    const found = ids(lintArtifact(html));
    expect(found).not.toContain('low-contrast-ui');
    expect(found).not.toContain('contrast-unresolved');
  });

  it('parses multi-layer box-shadow rings containing rgba() commas', () => {
    const html = `<style>
      body { background: #ffffff; }
      input:focus { border-color: #eeeeee; box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.1), 0 0 0 4px #000000; }
    </style>`;
    const found = ids(lintArtifact(html));
    expect(found).not.toContain('low-contrast-ui');
    expect(found).not.toContain('contrast-unresolved');
  });

  it('does not let a blurred drop shadow rescue a low-contrast border', () => {
    const html = `<style>
      body { background: #ffffff; }
      input { border: 1px solid #dddddd; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.7); }
    </style>`;
    expect(ids(lintArtifact(html))).toContain('low-contrast-ui');
  });

  it('does not let an inset ring shadow rescue a low-contrast border', () => {
    const html = `<style>
      body { background: #ffffff; }
      input { border: 1px solid #dddddd; box-shadow: inset 0 0 0 2px #000000; }
    </style>`;
    expect(ids(lintArtifact(html))).toContain('low-contrast-ui');
  });

  it('evaluates borderless controls that draw their boundary with a crisp ring shadow', () => {
    const pass = `<style>body { background: #ffffff; } input { border: none; box-shadow: 0 0 0 1px #767676; }</style>`;
    expect(ids(lintArtifact(pass))).not.toContain('low-contrast-ui');
    const fail = `<style>body { background: #ffffff; } input { border: none; box-shadow: 0 0 0 1px #dddddd; }</style>`;
    expect(ids(lintArtifact(fail))).toContain('low-contrast-ui');
  });

  it('ignores standalone focus-visible ring rules that do not declare a border or fill', () => {
    const html = `<style>
      body { background: #000000; }
      input { border: 1px solid #cccccc; }
      input:focus-visible { box-shadow: 0 0 0 3px rgba(0, 112, 204, 0.3); }
    </style>`;
    const found = ids(lintArtifact(html));
    expect(found).not.toContain('low-contrast-ui');
    expect(found).not.toContain('contrast-unresolved');
  });

  it('reports an unresolvable crisp ring with a low-contrast border as contrast-unresolved', () => {
    const html = `<style>
      body { background: #ffffff; }
      input:focus-visible { border-color: #dddddd; box-shadow: 0 0 0 3px color-mix(in oklab, #0099ff, transparent 70%); }
    </style>`;
    const found = ids(lintArtifact(html));
    expect(found).not.toContain('low-contrast-ui');
    expect(found).toContain('contrast-unresolved');
  });

  it('composites translucent rgba() borders against the opaque page backdrop', () => {
    const low = `<style>body { background: #ffffff; } input { border: 1px solid rgba(0, 0, 0, 0.08); background: #ffffff; }</style>`;
    const lowFindings = lintArtifact(low);
    expect(finding(lowFindings, 'low-contrast-ui').severity).toBe('P1');
    expect(ids(lowFindings)).not.toContain('contrast-unresolved');

    const ok = `<style>body { background: #ffffff; } input { border: 1px solid rgba(0, 0, 0, 0.55); background: #ffffff; }</style>`;
    const okIds = ids(lintArtifact(ok));
    expect(okIds).not.toContain('low-contrast-ui');
    expect(okIds).not.toContain('contrast-unresolved');
  });
});

describe('missing-accessible-name', () => {
  it('fires P0 on an icon-only button with no label', () => {
    const html = `<button class="icon"><svg viewBox="0 0 10 10"><path d="M0 0h10"/></svg></button>`;
    const hit = finding(lintArtifact(html), 'missing-accessible-name');
    expect(hit.severity).toBe('P0');
    expect(hit.snippet).toContain('<button');
  });

  it('fires on an unlabelled text input and an empty link', () => {
    expect(ids(lintArtifact(`<input type="text" name="q">`))).toContain('missing-accessible-name');
    expect(ids(lintArtifact(`<a href="/next"></a>`))).toContain('missing-accessible-name');
    expect(ids(lintArtifact(`<div role="button"></div>`))).toContain('missing-accessible-name');
  });

  it('accepts text content, aria-label, aria-labelledby, title, alt and <label>', () => {
    const html = `
      <button>Save</button>
      <button aria-label="Close"><svg></svg></button>
      <button aria-labelledby="t"><svg></svg></button><span id="t">Close</span>
      <a href="/x"><img src="x.png" alt="Home"></a>
      <input id="email" type="email"><label for="email">Email</label>
      <label>Search <input type="search"></label>
      <input type="text" title="Filter">
      <input type="hidden" name="csrf">
      <input type="submit">
      <select aria-label="Country"><option>A</option></select>
      <textarea aria-labelledby="t"></textarea>
    `;
    expect(ids(lintArtifact(html))).not.toContain('missing-accessible-name');
  });

  it('does not count a placeholder or an empty aria-label as a name', () => {
    expect(ids(lintArtifact(`<input type="text" placeholder="Search">`))).toContain('missing-accessible-name');
    expect(ids(lintArtifact(`<button aria-label=""></button>`))).toContain('missing-accessible-name');
  });
});

describe('target-size-min (SC 2.5.8)', () => {
  it('fires P1 on a 16×16 px button', () => {
    const html = `<style>.icon-btn { width: 16px; height: 16px; }</style><button class="icon-btn" aria-label="x"></button>`;
    const hit = finding(lintArtifact(html), 'target-size-min');
    expect(hit.severity).toBe('P1');
    expect(hit.message).toContain('24');
  });

  it('accepts 24 px targets, min-size overrides and non-interactive selectors', () => {
    const ok = `<style>
      .icon-btn { width: 24px; height: 24px; }
      button.tiny { width: 16px; height: 16px; min-width: 24px; min-height: 24px; }
      .dot { width: 8px; height: 8px; }
    </style>`;
    expect(ids(lintArtifact(ok))).not.toContain('target-size-min');
  });

  it('ignores pseudo-elements, which are not targets', () => {
    const html = `<style>.btn-loading::before { width: 12px; height: 12px; } a[aria-current]::after { height: 2px; }</style>`;
    expect(ids(lintArtifact(html))).not.toContain('target-size-min');
  });

  it('checks inline sizes on interactive elements', () => {
    const html = `<a href="/x" style="display:inline-block;width:12px;height:12px" aria-label="x"></a>`;
    expect(ids(lintArtifact(html))).toContain('target-size-min');
  });
});

describe('existing rules are unchanged by the a11y pass', () => {
  it('still reports the anti-slop findings with their original severity', () => {
    const html = `<style>.cta { background: #6366f1; }</style><h2>✨ Fast</h2><p>lorem ipsum</p>`;
    const found = lintArtifact(html);
    expect(finding(found, 'ai-default-indigo').severity).toBe('P0');
    expect(finding(found, 'emoji-icon').severity).toBe('P0');
    expect(finding(found, 'filler-copy').severity).toBe('P0');
  });

  it('emits no a11y finding on a compliant artifact', () => {
    const html = `<!doctype html><html lang="en"><head><title>Pricing Plan</title><style>
      :root { --bg: #ffffff; --fg: #1a1a1a; --accent: #1f4fbf; }
      body { background: var(--bg); color: var(--fg); }
      .btn { background: var(--accent); color: #ffffff; min-height: 44px; padding: 0 16px; }
    </style></head><body><main><h1>Plan</h1><img src="chart.png" alt="Summary chart"><button class="btn">Continue</button></main></body></html>`;
    const a11y = Object.values(A11Y_RULE_IDS) as string[];
    expect(ids(lintArtifact(html)).filter((id) => a11y.includes(id))).toEqual([]);
  });
});

describe('declarative compliance profiles', () => {
  const mixedA11yHtml = `<!doctype html><html lang="en"><head><title>Mixed A11y Fixture</title><style>
    body { background: #ffffff; }
    .note { color: #777777; background: #ffffff; }
    input { border: 1px solid #dddddd; background: #ffffff; }
    .icon-btn { width: 20px; height: 20px; }
    .badge { color: #111111; background: color-mix(in oklab, #16a34a, transparent 90%); }
  </style></head><body>
    <p class="note">Muted</p>
    <input type="text" placeholder="Search">
    <button class="icon-btn" aria-label="Close"></button>
    <span class="badge">Live</span>
  </body></html>`;

  it('disables a11y checks under off while preserving anti-slop rules', () => {
    const html = `<style>.cta { background: #6366f1; } .note { color: #999999; background: #ffffff; }</style><button></button>`;
    expect(ids(lintArtifact(html, { a11yLevel: 'off' }))).toEqual(['ai-default-indigo']);
  });

  it('scopes rules and compliance metadata per WCAG preset (wcag-a, wcag20-aa, wcag21-aa, wcag22-aa)', () => {
    const levelA = lintArtifact(mixedA11yHtml, { a11yLevel: 'wcag-a' });
    expect(ids(levelA)).toEqual(['missing-accessible-name']);
    expect(finding(levelA, 'missing-accessible-name').compliance).toEqual({
      standard: 'WCAG-2.2',
      sc: '4.1.2',
      level: 'A',
    });

    const wcag20 = lintArtifact(mixedA11yHtml, { a11yLevel: 'wcag20-aa' });
    expect(ids(wcag20)).toEqual(['low-contrast-text', 'missing-accessible-name', 'contrast-unresolved']);
    expect(finding(wcag20, 'low-contrast-text').compliance).toEqual({
      standard: 'WCAG-2.0',
      sc: '1.4.3',
      level: 'AA',
    });

    const wcag21 = lintArtifact(mixedA11yHtml, { a11yLevel: 'wcag21-aa' });
    expect(ids(wcag21)).toEqual(['low-contrast-text', 'low-contrast-ui', 'missing-accessible-name', 'contrast-unresolved']);
    expect(finding(wcag21, 'low-contrast-ui').compliance).toEqual({
      standard: 'WCAG-2.1',
      sc: '1.4.11',
      level: 'AA',
    });

    const wcag22 = lintArtifact(mixedA11yHtml, { a11yLevel: 'wcag22-aa' });
    expect(ids(wcag22)).toEqual([
      'low-contrast-text',
      'low-contrast-ui',
      'missing-accessible-name',
      'target-size-min',
      'contrast-unresolved',
    ]);
    expect(finding(wcag22, 'target-size-min').compliance).toEqual({
      standard: 'WCAG-2.2',
      sc: '2.5.8',
      level: 'AA',
    });
  });

  it('enforces 7:1 / 4.5:1 contrast (SC 1.4.6) and 44px targets (SC 2.5.5) under wcag22-aaa', () => {
    // #707070 on #ffffff is ~4.95:1 (passes AA 4.5:1, fails AAA 7:1).
    // 24px #949494 on #ffffff is ~3.03:1 (passes AA large text 3:1, fails AAA large text 4.5:1).
    // 32px button passes AA 24px, fails AAA 44px.
    const aaOnlyHtml = `<style>
      .body-copy { color: #707070; background: #ffffff; }
      .hero { color: #949494; background: #ffffff; font-size: 24px; }
      .btn { width: 32px; height: 32px; }
    </style><button class="btn">Go</button>`;

    expect(ids(lintArtifact(aaOnlyHtml, { a11yLevel: 'wcag22-aa' }))).toEqual([]);

    const aaa = lintArtifact(aaOnlyHtml, { a11yLevel: 'wcag22-aaa' });
    const textHit = finding(aaa, 'low-contrast-text');
    expect(textHit.severity).toBe('P0');
    expect(textHit.message).toContain('7:1');
    expect(textHit.compliance).toEqual({ standard: 'WCAG-2.2', sc: '1.4.6', level: 'AAA' });

    const targetHit = finding(aaa, 'target-size-min');
    expect(targetHit.severity).toBe('P1');
    expect(targetHit.message).toContain('44');
    expect(targetHit.compliance).toEqual({ standard: 'WCAG-2.2', sc: '2.5.5', level: 'AAA' });

    const aaaCompliantHtml = `<style>
      .body-copy { color: #595959; background: #ffffff; }
      .hero { color: #767676; background: #ffffff; font-size: 24px; }
      .btn { width: 44px; height: 44px; }
    </style><button class="btn">Go</button>`;
    expect(ids(lintArtifact(aaaCompliantHtml, { a11yLevel: 'wcag22-aaa' }))).toEqual([]);
  });

  it('supports declarative partial overrides via options.a11yProfile', () => {
    const found = lintArtifact(mixedA11yHtml, {
      a11yLevel: 'wcag22-aa',
      a11yProfile: {
        uiContrast: {
          severity: 'P0',
          minRatio: 3,
          compliance: { standard: 'WCAG-2.2', sc: '1.4.11', level: 'AA' },
        },
        targetSize: null,
      },
    });
    expect(finding(found, 'low-contrast-ui').severity).toBe('P0');
    expect(ids(found)).not.toContain('target-size-min');
  });

  it('reactivates a disabled null slot cleanly and throws RangeError on invalid a11yLevel', () => {
    const html = `<style>.icon-btn { width: 16px; height: 16px; }</style><button class="icon-btn" aria-label="Close"></button>`;
    const onlyTarget = lintArtifact(html, {
      a11yLevel: 'off',
      a11yProfile: {
        targetSize: {
          severity: 'P1',
          minPx: 24,
          compliance: { standard: 'WCAG-2.2', sc: '2.5.8', level: 'AA' },
        },
      },
    });
    expect(ids(onlyTarget)).toEqual(['target-size-min']);

    let err: unknown;
    try {
      lintArtifact(html, { a11yLevel: 'wcag99\u001b[31m' as never });
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).not.toContain('wcag99');
  });
});

describe('@keyframes exclusion, linear scanning, and prototype safety', () => {
  it('excludes top-level, vendor-prefixed, multi-stop, comma-stop, and at-rule-nested keyframes', () => {
    const html = `<style>
      @keyframes fade {
        0%, 50% { color: #bbbbbb; background: #ffffff; }
        100% { color: var(--missing); background: color-mix(in oklab, red, blue); }
      }
      @-webkit-keyframes pulse {
        from { color: #cccccc; background: #ffffff; }
        to { color: #111111; background: linear-gradient(#000, #333); }
      }
      @-moz-keyframes glow { from, 50% { color: #bbbbbb; background: #fff; } }
      @-o-keyframes slide { 0% { color: #bbbbbb; background: #fff; } }
      @media screen {
        @keyframes nestedMedia { from { color: #aaaaaa; background: #ffffff; } }
      }
      @supports (display: grid) {
        @keyframes nestedSupports { to { color: color-mix(in oklab, red, blue); background: #fff; } }
      }
      @layer motion {
        @keyframes nestedLayer { from { color: #999999; background: #ffffff; } }
      }
    </style><p>Safe</p>`;
    const found = ids(lintArtifact(html));
    expect(found).not.toContain('low-contrast-text');
    expect(found).not.toContain('contrast-unresolved');
  });

  it('catches normal rules immediately after keyframes, both at top level and inside wrappers', () => {
    const topAfter = `<style>
      @keyframes fade { from { color: #aaaaaa; background: #ffffff; } to { color: #111111; background: #ffffff; } }
      .after { color: #999999; background: #ffffff; }
    </style><p class="after">Visible</p>`;
    expect(finding(lintArtifact(topAfter), 'low-contrast-text').snippet).toContain('.after');

    const wrappedAfter = `<style>
      @media screen {
        @keyframes spin { from { color: #aaaaaa; background: #ffffff; } }
        .after-media { color: #999999; background: #ffffff; }
      }
    </style><p class="after-media">Visible</p>`;
    expect(finding(lintArtifact(wrappedAfter), 'low-contrast-text').snippet).toContain('.after-media');
  });

  it('preserves rules both before and after keyframes with exact pair count', () => {
    const html = `<style>
      .before { color: #999999; background: #ffffff; }
      @keyframes shimmer { 50% { color: #bbbbbb; background: #ffffff; } }
      .after { color: #888888; background: #ffffff; }
    </style><p class="before">A</p><p class="after">B</p>`;
    const hit = finding(lintArtifact(html), 'low-contrast-text');
    expect(hit.message).toContain('2 text colour pair(s)');
  });

  it('recovers from semicolon at-rules, escaped strings, stray closing braces, unclosed blocks, and deep braces', () => {
    const malformed = `<style>
      @import url("theme.css");
      @layer base, theme;
      @keyframes anim { from { content: "x \\" }"; color: #bbbbbb; background: #ffffff; } }
      }}}
      .real-after { color: #999999; background: #ffffff; }
    </style><p class="real-after">Recovered</p>`;
    expect(finding(lintArtifact(malformed), 'low-contrast-text').snippet).toContain('.real-after');

    const deep = `<style>${'{'.repeat(20000)} .deep-ok { color: #111111; background: #fff; } ${'}'.repeat(20000)}
      @keyframes broken { from { color: #bbbbbb; background: #fff; }`;
    expect(lintArtifact(deep).filter((f) => f.id === 'low-contrast-text')).toEqual([]);
  });

  it('flags all 3+ consecutive elements missing an accessible name (non-global RegExp safety)', () => {
    const html = `<a href="/a"></a><a href="/b"></a><a href="/c"></a>`;
    const hit = finding(lintArtifact(html), 'missing-accessible-name');
    expect(hit.message).toContain('3 interactive element(s)');
  });

  it('ignores script and template content linearly while scanning real style blocks and Turkish uppercase offsets', () => {
    const html = `
      \u0130\u0130\u0130
      <script>const html = '<button></button><style>.fake{color:#bbbbbb;background:#ffffff}</style>';</script>
      <template><a href="/hidden"></a><style>.tpl{color:#bbbbbb;background:#ffffff}</style></template>
      <stylesheet>.kept{}</stylesheet>
      <style>.quoted::before { content: "<script>"; } .real { color: #999999; background: #ffffff; }</style>
      <p class="real">Visible</p>
      <script>const unclosed = '<style>.nohang';</script>
    `;
    const found = lintArtifact(html);
    expect(finding(found, 'low-contrast-text').snippet).toContain('.real');
    expect(ids(found)).not.toContain('missing-accessible-name');
  });

  it('guards NAMED_COLORS against Object.prototype keys and strips control sequences in unresolved details', () => {
    expect(parseCssColor('white ! important')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    const longExpr = `color-mix(in\n\u001b[31m oklab, ${'red '.repeat(50)}, blue)`;
    const html = `<style>
      .proto1 { color: constructor; background: #ffffff; }
      .proto2 { color: #111111; background: __proto__; }
      .long { color: ${longExpr}; background: #ffffff; }
    </style>`;
    const hit = finding(lintArtifact(html), 'contrast-unresolved');
    expect(hit.message).toContain('3 colour pair(s)');
    expect(hit.message.length).toBeLessThan(280);
    expect(hit.message).not.toContain('\n');
    expect(hit.message).not.toContain('\u001b');
    expect(hit.snippet).not.toContain('\n');
    expect(hit.snippet).not.toContain('\u001b');

    const longFirst = `<style>.long { color: ${longExpr}; background: #ffffff; }</style>`;
    const longHit = finding(lintArtifact(longFirst), 'contrast-unresolved');
    const detail = longHit.message.split('; first: ')[1] ?? '';
    expect(detail.length).toBeLessThanOrEqual(121);
    expect(detail).not.toContain('\u001b');
  });

  it('supports !important values across color and non-color properties, rem units, and high-contrast UI fix text', () => {
    const impFail = `<style>.imp { color: #bbbbbb ! important; background: white !important; }</style>`;
    const hit = finding(lintArtifact(impFail), 'low-contrast-text');
    expect(hit.fix).toContain('24px');
    expect(hit.fix).toContain('18.66px');

    const remPass = `<style>.hero { color: #949494; background: #fff; font-size: 1.5rem ! important; }</style>`;
    expect(ids(lintArtifact(remPass))).not.toContain('low-contrast-text');

    const remFail = `<style>.body { color: #949494; background: #fff; font-size: 1rem !important; }</style>`;
    expect(ids(lintArtifact(remFail))).toContain('low-contrast-text');

    const boundary239 = `<style>.b { color: #949494; background: #fff; font-size: 23.9px; }</style>`;
    expect(ids(lintArtifact(boundary239))).toContain('low-contrast-text');

    const boldPass = `<style>.b { color: #949494; background: #fff; font-size: 18.66px !important; font-weight: 700 ! important; }</style>`;
    expect(ids(lintArtifact(boldPass))).not.toContain('low-contrast-text');

    const boldFail = `<style>.b { color: #949494; background: #fff; font-size: 18.65px; font-weight: 700 !important; }</style>`;
    expect(ids(lintArtifact(boldFail))).toContain('low-contrast-text');

    const importantNonColorPass = `<style>
      body { background: #ffffff; }
      button { width: 24px !important; height: 24px ! important; background: #ffffff; color: #111111; }
      input { background: #ffffff; border: 1px solid #eeeeee; box-shadow: 0 0 0 4px #000000 !important; }
    </style><button>Save</button><input aria-label="Name">`;
    const nonColorIds = ids(lintArtifact(importantNonColorPass));
    expect(nonColorIds).not.toContain('target-size-min');
    expect(nonColorIds).not.toContain('low-contrast-ui');
    expect(nonColorIds).not.toContain('contrast-unresolved');

    const importantTargetFail = `<style>button { width: 16px !important; height: 16px ! important; }</style><button>Go</button>`;
    expect(ids(lintArtifact(importantTargetFail))).toContain('target-size-min');

    const uiFail = lintArtifact(`<style>body{background:#ffffff;} input{border:1px solid #dddddd;}</style><input aria-label="Email">`);
    const uiHit = finding(uiFail, 'low-contrast-ui');
    expect(uiHit.fix).not.toContain('--border-control');
    expect(uiHit.fix).toContain('--fg-2');
  });
});

describe('Level A rules: missing-img-alt (SC 1.1.1), missing-page-title (SC 2.4.2), missing-html-lang (SC 3.1.1)', () => {
  it('flags missing and whitespace-only <img> alt attributes with WCAG 2.2 SC 1.1.1 metadata', () => {
    const missing = lintArtifact(`<img src="a.png" data-note="x\u001b[31m"><img src="b.png" alt="  ">`, {
      a11yLevel: 'wcag-a',
    });
    const hit = finding(missing, 'missing-img-alt');
    expect(hit.severity).toBe('P0');
    expect(hit.compliance).toEqual({ standard: 'WCAG-2.2', sc: '1.1.1', level: 'A' });
    expect(hit.message).toContain('2 <img> element(s)');
    expect(hit.message).toContain('missing alt attribute');
    expect(hit.snippet).not.toContain('\u001b');

    const blankOnly = lintArtifact(`<img src="b.png" alt="   ">`, { a11yLevel: 'wcag-a' });
    expect(finding(blankOnly, 'missing-img-alt').message).toContain('whitespace-only alt attribute');

    expect(ids(lintArtifact(`<img title=" alt " src="x.png">`, { a11yLevel: 'wcag-a' }))).toContain('missing-img-alt');
    expect(ids(lintArtifact(`<img aria-labelledby="missing" src="x.png">`, { a11yLevel: 'wcag-a' }))).toContain('missing-img-alt');
    expect(ids(lintArtifact(`<img aria-label="   " src="x.png">`, { a11yLevel: 'wcag-a' }))).toContain('missing-img-alt');
    expect(ids(lintArtifact(`<img aria-hidden="false" src="x.png">`, { a11yLevel: 'wcag-a' }))).toContain('missing-img-alt');
  });

  it('exempts valid alt, decorative semantics, ARIA labels, and non-<img> boundaries', () => {
    const compliantImgs = `
      <img src="d1.png" alt="">
      <img src="d2.png" alt>
      <img src="d3.png" alt/>
      <img src="d4.png" alt="a > b">
      <img src="d5.png" role="presentation">
      <img src="d6.png" role="none">
      <img src="d7.png" role="button" alt="Close">
      <img src="d8.png" aria-hidden="true">
      <img src="d9.png" aria-label="Revenue trend">
      <img src="d10.png" aria-labelledby="img-cap"><span id="img-cap">Forecast</span>
      <IMG ALT="Hero" SRC="hero.png">
      <svg role="img" aria-label="Logo"><circle r="4"></circle></svg>
      <div style="background-image: url(bg.png)"></div>
    `;
    expect(ids(lintArtifact(compliantImgs, { a11yLevel: 'wcag-a' }))).not.toContain('missing-img-alt');

    // elementIds resolution still works when accessibleName slot is disabled and imgAlt is enabled alone
    const imgAltOnly = lintArtifact(`<img src="x.png" aria-labelledby="cap"><span id="cap">Ok</span>`, {
      a11yLevel: 'off',
      a11yProfile: {
        imgAlt: { severity: 'P0', compliance: { standard: 'WCAG-2.2', sc: '1.1.1', level: 'A' } },
      },
    });
    expect(ids(imgAltOnly)).toEqual([]);

    const imgAltOnlyFail = lintArtifact(`<img src="x.png">`, {
      a11yLevel: 'off',
      a11yProfile: {
        imgAlt: { severity: 'P0', compliance: { standard: 'WCAG-2.2', sc: '1.1.1', level: 'A' } },
      },
    });
    expect(ids(imgAltOnlyFail)).toEqual(['missing-img-alt']);

    // <input type="image"> stays under missing-accessible-name, not missing-img-alt
    const imageInput = lintArtifact(`<input type="image" src="go.png">`, { a11yLevel: 'wcag-a' });
    expect(ids(imageInput)).toContain('missing-accessible-name');
    expect(ids(imageInput)).not.toContain('missing-img-alt');

    expect(ids(lintArtifact(`<img src="x.png">`, { a11yLevel: 'off' }))).toEqual([]);
  });

  it('enforces missing-page-title (SC 2.4.2) and missing-html-lang (SC 3.1.1) while remaining fragment-safe', () => {
    const fragments = [
      '<header>Brand</header>',
      '<html-card>Card</html-card>',
      '<title-card>Card</title-card>',
      '<!doctype html><html-card><title-card></title-card></html-card>',
      '<!doctype html><main><h1>Section</h1></main>',
    ];
    for (const frag of fragments) {
      const found = ids(lintArtifact(frag, { a11yLevel: 'wcag-a' }));
      expect(found).not.toContain('missing-page-title');
      expect(found).not.toContain('missing-html-lang');
    }

    // <head> without <html> triggers pageTitle only
    const headOnly = lintArtifact(`<head id="h" data-x="a\u001b[31m"></head><body></body>`, { a11yLevel: 'wcag-a' });
    expect(ids(headOnly)).toEqual(['missing-page-title']);
    const titleHit = finding(headOnly, 'missing-page-title');
    expect(titleHit.severity).toBe('P1');
    expect(titleHit.compliance).toEqual({ standard: 'WCAG-2.2', sc: '2.4.2', level: 'A' });
    expect(titleHit.snippet).toContain('<head');
    expect(titleHit.snippet).not.toContain('\u001b');

    // <svg><title> cannot satisfy document <title>; <title> in <body> after empty <head> fails
    expect(ids(lintArtifact(`<html><body><svg><title>Icon</title></svg></body></html>`, { a11yLevel: 'wcag-a' }))).toEqual([
      'missing-page-title',
      'missing-html-lang',
    ]);
    expect(
      ids(lintArtifact(`<html lang="en"><head></head><body><title>Wrong</title></body></html>`, { a11yLevel: 'wcag-a' })),
    ).toEqual(['missing-page-title']);

    // No <head> fallback passes when <html> directly contains <title>
    expect(ids(lintArtifact(`<html lang="en"><title>Ok</title></html>`, { a11yLevel: 'wcag-a' }))).toEqual([]);

    // Omitted </head> positive and negative cases
    expect(ids(lintArtifact(`<html lang="en"><head><title>Open</title><body><p>Hi</p></body></html>`, { a11yLevel: 'wcag-a' }))).toEqual([]);
    expect(ids(lintArtifact(`<html lang="en"><head><body><title>Late</title></body></html>`, { a11yLevel: 'wcag-a' }))).toEqual(['missing-page-title']);
    expect(ids(lintArtifact(`<html lang="en"><head><title>   </title></head></html>`, { a11yLevel: 'wcag-a' }))).toEqual(['missing-page-title']);

    // missing-html-lang: quotes, valueless, blank, case-insensitivity, off
    const quotedAttrNoLang = lintArtifact(`<html data-note="lang='en'"><head><title>Doc</title></head></html>`, {
      a11yLevel: 'wcag-a',
    });
    const langHit = finding(quotedAttrNoLang, 'missing-html-lang');
    expect(langHit.severity).toBe('P1');
    expect(langHit.compliance).toEqual({ standard: 'WCAG-2.2', sc: '3.1.1', level: 'A' });
    expect(langHit.message).toContain('no lang');

    expect(finding(lintArtifact(`<html lang><head><title>Doc</title></head></html>`, { a11yLevel: 'wcag-a' }), 'missing-html-lang').message).toContain('no lang attribute');
    expect(finding(lintArtifact(`<html lang="  "><head><title>Doc</title></head></html>`, { a11yLevel: 'wcag-a' }), 'missing-html-lang').message).toContain('blank lang attribute');
    expect(ids(lintArtifact(`<html LANG="zh-Hant"><head><title>Doc</title></head></html>`, { a11yLevel: 'wcag-a' }))).toEqual([]);
    expect(ids(lintArtifact(`<html><head></head></html>`, { a11yLevel: 'off' }))).toEqual([]);
  });

  it('supports direct lintAccessibility() calls, single-slot activation, quoted inline style=, and linear DoS bounds', () => {
    const noopResolve = (b: string) => b;
    const directFail = lintAccessibility(
      `<html><head></head><body><script>const x="<!--";</script><!-- ignored --><img src="x.png"></body></html>`,
      [],
      noopResolve,
    );
    expect(ids(directFail)).toEqual(['missing-img-alt', 'missing-page-title', 'missing-html-lang']);

    const directIgnore = lintAccessibility(
      `<!-- <img src="a.png"><html> --><script>const s="<html ><img src='x'>";</script><style>.x{}</style><template><img src="t.png"></template>`,
      [],
      noopResolve,
    );
    expect(directIgnore).toEqual([]);

    const pageTitleOnly = lintArtifact(`<html><head></head></html>`, {
      a11yLevel: 'off',
      a11yProfile: {
        pageTitle: { severity: 'P1', compliance: { standard: 'WCAG-2.2', sc: '2.4.2', level: 'A' } },
      },
    });
    expect(ids(pageTitleOnly)).toEqual(['missing-page-title']);

    const htmlLangOnly = lintArtifact(`<html><head></head></html>`, {
      a11yLevel: 'off',
      a11yProfile: {
        htmlLang: { severity: 'P1', compliance: { standard: 'WCAG-2.2', sc: '3.1.1', level: 'A' } },
      },
    });
    expect(ids(htmlLangOnly)).toEqual(['missing-html-lang']);

    const quotedStyle = lintArtifact(`<button title="a > b" style="width:10px;height:10px">Save</button>`);
    expect(ids(quotedStyle)).toContain('target-size-min');

    const dosVectors = [
      '<title>'.repeat(20_000),
      '<button '.repeat(20_000),
      '<img src="'.repeat(10_000),
      `<html><head><title>Ok</title></head>${'<svg>'.repeat(500)}${'</svg>'.repeat(500)}</html>`,
    ];
    for (const vec of dosVectors) {
      expect(() => lintAccessibility(vec, [], noopResolve)).not.toThrow();
      expect(() => lintArtifact(vec)).not.toThrow();
    }
  });
});

describe('focus-outline-suppressed (SC 2.4.7 Level AA)', () => {
  it('flags direct outline suppressions, cascade resets, tokenized suppressions, and multi-rule counts', () => {
    const suppressions = [
      'button:focus { outline: none; }',
      'button:focus { outline: 0; }',
      'button:focus { outline: 0rem; }',
      'button:focus { outline: 0em; }',
      'button:focus { outline: 0pt; }',
      'button:focus { outline: .0px; }',
      'button:focus { outline-style: hidden; }',
      'button:focus { outline-color: transparent; }',
      'button:focus { outline-color: rgba(0, 0, 0, 0); }',
      'button:focus { outline: none !important; }',
      ':root { --o: none; } button:focus { outline: var(--o); }',
      'button:focus { outline: 0; outline-style: solid; }',
      'button:focus { outline: 2px solid #2563eb; outline-color: transparent; }',
    ];
    for (const css of suppressions) {
      const hit = finding(lintArtifact(`<style>${css}</style>`), 'focus-outline-suppressed');
      expect(hit.severity, css).toBe('P0');
      expect(hit.compliance, css).toEqual({ standard: 'WCAG-2.2', sc: '2.4.7', level: 'AA' });
    }

    const passes = [
      'button:focus { outline: var(--ext); }',
      'button:focus { outline: none; outline: 2px solid #2563eb; }',
      'button:focus { outline-width: 0; outline: 2px solid #2563eb; }',
    ];
    for (const css of passes) {
      expect(ids(lintArtifact(`<style>${css}</style>`)), css).not.toContain('focus-outline-suppressed');
    }

    const multi = lintArtifact(`<style>button:focus { outline: none; } a:focus-visible { outline: 0; }</style>`);
    expect(finding(multi, 'focus-outline-suppressed').message).toContain('2 focus selector rule(s)');
  });

  it('matches pseudo-class focus selectors accurately without false positives on wrappers or pseudo-elements', () => {
    for (const sel of ['&:focus', ':is(:focus, .active)', 'button:not(:disabled):focus', '.card:focus-within button:focus']) {
      expect(ids(lintArtifact(`<style>${sel} { outline: none; }</style>`)), sel).toContain('focus-outline-suppressed');
    }

    const silentCss = `
      .card:focus-within { outline: none; }
      [data-state=":focus"] { outline: none; }
      button:not(:focus) { outline: none; }
      button::focus { outline: none; }
      button:focus::after { outline: none; }
      @keyframes k { from { outline: none; } }
    `;
    expect(ids(lintArtifact(`<style>${silentCss}</style>`))).not.toContain('focus-outline-suppressed');
  });

  it('distinguishes real visible compensations from non-visible zero/transparent fallbacks', () => {
    const compensated = [
      'button:focus { outline: none; border: 2px solid #2563eb; }',
      'button:focus { outline: none; background: #1d4ed8; }',
      'button:focus { outline: none; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4); }',
      ':root { --focus-ring: 0 0 0 3px #2563eb; } button:focus { outline: none; box-shadow: var(--focus-ring); }',
      'button:focus { outline: none; box-shadow: var(--focus-ring); }',
      'a:focus { outline: none; text-decoration: underline; }',
      'a:focus { outline: none; text-decoration-line: underline; }',
    ];
    for (const css of compensated) {
      expect(ids(lintArtifact(`<style>${css}</style>`)), css).not.toContain('focus-outline-suppressed');
    }

    const fakeCompensations = [
      'button:focus { outline: none; border: 0 solid #000; }',
      'button:focus { outline: none; border-width: 0; border-color: #000; }',
      'button:focus { outline: none; border: 2px solid transparent; }',
      'button:focus { outline: none; background: transparent; }',
      'button:focus { outline: none; background: none; }',
      'button:focus { outline: none; background: rgba(0, 0, 0, 0); }',
      'button:focus { outline: none; box-shadow: inset 0 0 0 2px transparent; }',
      'button:focus { outline: none; box-shadow: 0 0 0 0 #000; }',
      'button:focus { outline: none; box-shadow: 0 0 0 3px transparent; }',
      ':root { --focus-ring: none; } button:focus { outline: none; box-shadow: var(--focus-ring); }',
      'a:focus { outline: none; text-decoration: initial; }',
      'a:focus { outline: none; text-decoration: transparent; }',
      'a:focus { outline: none; text-decoration: underline transparent; }',
      'a:focus { outline: none; text-decoration: underline; text-decoration-color: transparent; }',
      'a:focus { outline: none; text-decoration: underline; text-decoration: none; }',
    ];
    for (const css of fakeCompensations) {
      expect(ids(lintArtifact(`<style>${css}</style>`)), css).toContain('focus-outline-suppressed');
    }
  });

  it('handles paired vs standalone :focus:not(:focus-visible), multi-theme companion checks, presets, and priority', () => {
    const pairedMixed = `<style>
      .btn:focus-visible, .card:focus:not(:focus-visible) { outline: 2px solid #000; }
      .card:focus:not(:focus-visible) { outline: none; }
    </style>`;
    expect(ids(lintArtifact(pairedMixed))).not.toContain('focus-outline-suppressed');

    const suppressedMixed = `<style>
      .btn:focus-visible, .card:focus:not(:focus-visible) { outline: none; }
    </style>`;
    expect(ids(lintArtifact(suppressedMixed))).toContain('focus-outline-suppressed');

    const standalone = `<style>.card:focus:not(:focus-visible) { outline: none; }</style>`;
    const standaloneHit = finding(lintArtifact(standalone), 'focus-outline-suppressed');
    expect(standaloneHit.message).toContain('standalone :focus:not(:focus-visible)');
    expect(standaloneHit.fix).toContain(':focus-visible');

    const directHit = finding(lintArtifact(`<style>button:focus-visible { outline: none; }</style>`), 'focus-outline-suppressed');
    expect(directHit.message).toContain('focus selector rule(s)');

    const both = lintArtifact(`<style>
      .card:focus:not(:focus-visible) { outline: none; }
      button:focus-visible { outline: none; }
    </style>`);
    const bothHit = finding(both, 'focus-outline-suppressed');
    expect(bothHit.message).toContain('focus selector rule(s)');
    expect(bothHit.snippet).toContain('button:focus-visible');

    const multiThemeBroken = `<style>
      :root { --ring-style: solid; }
      [data-theme="dark"] { --ring-style: none; }
      button:focus-visible { outline: 2px var(--ring-style) #000; }
      button:focus:not(:focus-visible) { outline: none; }
    </style>`;
    expect(ids(lintArtifact(multiThemeBroken))).toContain('focus-outline-suppressed');

    const sample = `<style>button:focus { outline: none; }</style>`;
    expect(ids(lintArtifact(sample, { a11yLevel: 'wcag-a' }))).not.toContain('focus-outline-suppressed');
    expect(finding(lintArtifact(sample, { a11yLevel: 'wcag20-aa' }), 'focus-outline-suppressed').compliance).toEqual({
      standard: 'WCAG-2.0',
      sc: '2.4.7',
      level: 'AA',
    });
    const aaa = finding(lintArtifact(sample, { a11yLevel: 'wcag22-aaa' }), 'focus-outline-suppressed');
    expect(aaa.severity).toBe('P0');
    expect(aaa.compliance).toEqual({ standard: 'WCAG-2.2', sc: '2.4.7', level: 'AA' });

    const singleSlot = lintArtifact(sample, {
      a11yLevel: 'off',
      a11yProfile: {
        focusOutline: { severity: 'P0', compliance: { standard: 'WCAG-2.2', sc: '2.4.7', level: 'AA' } },
      },
    });
    expect(ids(singleSlot)).toEqual(['focus-outline-suppressed']);
  });
});

describe('low-focus-appearance (SC 2.4.13 Level AAA)', () => {
  it('activates by default only on wcag22-aaa and ignores click-only / focus-within / pseudo-element selectors', () => {
    const weakFocus = `<style>body { background: #fff; } button:focus { outline: 1px solid #999999; }</style>`;
    for (const tier of ['wcag-a', 'wcag20-aa', 'wcag21-aa', 'wcag22-aa'] as const) {
      expect(ids(lintArtifact(weakFocus, { a11yLevel: tier })), tier).not.toContain('low-focus-appearance');
    }

    const hit = finding(lintArtifact(weakFocus, { a11yLevel: 'wcag22-aaa' }), 'low-focus-appearance');
    expect(hit.severity).toBe('P1');
    expect(hit.compliance).toEqual({ standard: 'WCAG-2.2', sc: '2.4.13', level: 'AAA' });

    const nonTarget = `<style>
      body { background: #fff; }
      .card:focus-within { outline: 1px solid #999999; }
      .card:focus:not(:focus-visible) { outline: 1px solid #999999; }
      button:focus::after { outline: 1px solid #999999; }
    </style>`;
    expect(ids(lintArtifact(nonTarget, { a11yLevel: 'wcag22-aaa' }))).not.toContain('low-focus-appearance');
  });

  it('checks outline width, outline contrast against pageBackdrop, and outer-ring box-shadow indicators', () => {
    const aaa = { a11yLevel: 'wcag22-aaa' } as const;

    expect(finding(lintArtifact(`<style>body{background:#fff} button:focus{outline:1.9px solid #000}</style>`, aaa), 'low-focus-appearance').message).toContain('1.9px < 2px');
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid #000}</style>`, aaa))).not.toContain('low-focus-appearance');

    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid #999999}</style>`, aaa))).toContain('low-focus-appearance');
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid #949494}</style>`, aaa))).not.toContain('low-focus-appearance');

    for (const thinWidth of ['0.1rem', '1.4pt', 'thin']) {
      expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:${thinWidth} solid #000}</style>`, aaa)), thinWidth).toContain('low-focus-appearance');
    }
    for (const thickWidth of ['0.125rem', '1.5pt', 'medium']) {
      expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:${thickWidth} solid #000}</style>`, aaa)), thickWidth).not.toContain('low-focus-appearance');
    }

    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid rgba(0,0,0,0.3)}</style>`, aaa))).toContain('low-focus-appearance');
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid rgba(0,0,0,0.6)}</style>`, aaa))).not.toContain('low-focus-appearance');

    // Evaluates against pageBackdrop even when the button itself has a dark background
    expect(ids(lintArtifact(`<style>body{background:#fff} button{background:#111} button:focus{outline:2px solid #ffffff}</style>`, aaa))).toContain('low-focus-appearance');

    // Outer-ring box-shadow failure and pass cases
    const ringSpreadFail = lintArtifact(`<style>body{background:#fff} button:focus{outline:none;box-shadow:0 0 0 1px #000}</style>`, aaa);
    expect(finding(ringSpreadFail, 'low-focus-appearance').message).toContain('ring spread 1px < 2px');

    const ringContrastFail = lintArtifact(`<style>body{background:#fff} button:focus{outline:none;box-shadow:0 0 0 2px #999999}</style>`, aaa);
    expect(finding(ringContrastFail, 'low-focus-appearance').message).toContain('< 3:1');

    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:none;box-shadow:0 0 0 1px #000, 0 0 0 3px #999999}</style>`, aaa))).toContain('low-focus-appearance');
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:none;box-shadow:0 0 0 1px #999999, 0 0 0 3px #000}</style>`, aaa))).not.toContain('low-focus-appearance');

    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:none;box-shadow:0 0 0 2px rgba(0,0,0,0.3)}</style>`, aaa))).toContain('low-focus-appearance');
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:none;box-shadow:0 0 0 2px rgba(0,0,0,0.6)}</style>`, aaa))).not.toContain('low-focus-appearance');

    // Forced-Colors high-contrast pattern passes both 2.4.7 and 2.4.13, while weak/thin rings still fail 2.4.13
    const forcedColors = lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid transparent;box-shadow:0 0 0 3px #000}</style>`, aaa);
    expect(ids(forcedColors)).not.toContain('focus-outline-suppressed');
    expect(ids(forcedColors)).not.toContain('low-focus-appearance');

    const forcedColorsThinFail = lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid transparent;box-shadow:0 0 0 1px #000}</style>`, aaa);
    expect(finding(forcedColorsThinFail, 'low-focus-appearance').message).toContain('ring spread 1px < 2px');

    const forcedColorsContrastFail = lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid transparent;box-shadow:0 0 0 3px #999999}</style>`, aaa);
    expect(finding(forcedColorsContrastFail, 'low-focus-appearance').message).toContain('< 3:1');

    const forcedColorsThinTransparentPass = lintArtifact(`<style>body{background:#fff} button:focus{outline:1px solid transparent;box-shadow:0 0 0 3px #000}</style>`, aaa);
    expect(ids(forcedColorsThinTransparentPass)).not.toContain('focus-outline-suppressed');
    expect(ids(forcedColorsThinTransparentPass)).not.toContain('low-focus-appearance');

    // Relative width token (`0.2em`) preserves already-parsed outline color for 2.4.13 contrast check
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:#999999 solid 0.2em}</style>`, aaa))).toContain('low-focus-appearance');

    // Quote/bracket-aware top-level comma split ignores commas inside attribute strings
    expect(ids(lintArtifact(`<style>button[data-states="hover, :focus"] { outline: none; }</style>`, aaa))).not.toContain('focus-outline-suppressed');

    // Visible outline takes priority over wide outer ring
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:1px solid #000;box-shadow:0 0 0 4px #000}</style>`, aaa))).toContain('low-focus-appearance');
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid #999999;box-shadow:0 0 0 4px #000}</style>`, aaa))).toContain('low-focus-appearance');

    // Tolerates unresolvable units or unexpanded var(--ring) alongside weak ring without false positives
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:none;box-shadow:0 0 0 2px #999999, 0 0 0 0.2em #000}</style>`, aaa))).not.toContain('low-focus-appearance');
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:none;box-shadow:0 0 0 2px #999999, 0 0 0 3px var(--ring)}</style>`, aaa))).not.toContain('low-focus-appearance');
  });

  it('handles color-scheme: dark without contrast-unresolved, multi-theme backdrops, overrides, and large :is() selectors', () => {
    const aaa = { a11yLevel: 'wcag22-aaa' } as const;

    const darkThin = lintArtifact(`<style>:root { color-scheme: dark; } button:focus { outline: 1px solid #fff; }</style>`, aaa);
    expect(ids(darkThin)).toContain('low-focus-appearance');
    expect(ids(darkThin)).not.toContain('contrast-unresolved');

    const darkWide = lintArtifact(`<style>:root { color-scheme: dark; } button:focus { outline: 2px solid #111; }</style>`, aaa);
    expect(ids(darkWide)).not.toContain('low-focus-appearance');
    expect(ids(darkWide)).not.toContain('contrast-unresolved');

    expect(ids(lintArtifact(`<style>button:focus { outline: auto; }</style>`, aaa))).not.toContain('low-focus-appearance');
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus { outline: 2px solid currentColor; }</style>`, aaa))).not.toContain('low-focus-appearance');

    const multiThemeFail = `<style>
      :root { --bg: #ffffff; }
      [data-theme="dark"] { --bg: #777777; }
      body { background: var(--bg); }
      button:focus { outline: 2px solid #949494; }
    </style>`;
    expect(ids(lintArtifact(multiThemeFail, aaa))).toContain('low-focus-appearance');

    // Single-slot activation from off with uiContrast null still computes backdrops
    const singleSlot = lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid #999999}</style>`, {
      a11yLevel: 'off',
      a11yProfile: {
        uiContrast: null,
        focusAppearance: { severity: 'P1', minPx: 2, minRatio: 3, compliance: { standard: 'WCAG-2.2', sc: '2.4.13', level: 'AAA' } },
      },
    });
    expect(ids(singleSlot)).toEqual(['low-focus-appearance']);

    // Partial wcag22-aaa overrides
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid #000}</style>`, {
      a11yLevel: 'wcag22-aaa',
      a11yProfile: { focusAppearance: { minPx: 3 } },
    }))).toContain('low-focus-appearance');
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid #777777}</style>`, {
      a11yLevel: 'wcag22-aaa',
      a11yProfile: { focusAppearance: { minRatio: 4.5 } },
    }))).toContain('low-focus-appearance');
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:2px solid #767676}</style>`, {
      a11yLevel: 'wcag22-aaa',
      a11yProfile: { focusAppearance: { minRatio: 4.5 } },
    }))).not.toContain('low-focus-appearance');
    expect(ids(lintArtifact(`<style>body{background:#fff} button:focus{outline:1px solid #999999}</style>`, {
      a11yLevel: 'wcag22-aaa',
      a11yProfile: { focusAppearance: null },
    }))).not.toContain('low-focus-appearance');

    // T09: 2,000-item :is(...) selector linear bound
    const hugeSelector = `:is(${Array.from({ length: 2000 }, (_, i) => `.c${i}:focus`).join(', ')}) { outline: none; }`;
    expect(() => lintArtifact(`<style>${hugeSelector}</style>`, aaa)).not.toThrow();
    expect(ids(lintArtifact(`<style>${hugeSelector}</style>`, aaa))).toContain('focus-outline-suppressed');

    // SVG <title>, whitespace-padded id, wrapping label excluding <select> options, and O(n) scaling guarantees
    expect(ids(lintArtifact(`<button><svg><title>Close</title></svg></button>`, { a11yLevel: 'wcag-a' }))).not.toContain('missing-accessible-name');
    expect(ids(lintArtifact(`<button><svg aria-hidden="true"><title>Close</title></svg></button>`, { a11yLevel: 'wcag-a' }))).toContain('missing-accessible-name');
    expect(ids(lintArtifact(`<label for="email">Email</label><input id="email ">`, { a11yLevel: 'wcag-a' }))).not.toContain('missing-accessible-name');
    expect(ids(lintArtifact(`<label><select><option>US</option></select><input type="text"></label>`, { a11yLevel: 'wcag-a' }))).toContain('missing-accessible-name');

    const nestedButtons = `${'<button>'.repeat(8_000)}${'</button>'.repeat(8_000)}`;
    const manyLabels = Array.from({ length: 8_000 }, (_, i) => `<label>F${i}<input type="text"></label>`).join('');
    const nestedSelectLabels =
      `${'<label>'.repeat(2_000)}${'<select><option>a</option></select>'.repeat(2_000)}${'</label>'.repeat(2_000)}<input type="text">`;
    const svgScriptAttack = `${'<svg><script></svg>'.repeat(2_000)}<button></button>`;
    const manyThemes = [
      '<style>',
      ':root { --fg: #111; --bg: #fff; }',
      ...Array.from({ length: 1_000 }, (_, i) => `--k${i}: ${i};`),
      ...Array.from({ length: 1_000 }, (_, i) => `[data-theme="t${i}"] { --t${i}: #000; }`),
      ...Array.from({ length: 1_000 }, (_, i) => `.c${i} { color: var(--fg); background: var(--bg); }`),
      '</style>',
    ].join('');
    const varyingThemes = [
      '<style>',
      ':root { --bg: #fff; }',
      ...Array.from({ length: 1_000 }, (_, i) => `[data-theme="t${i}"] { --a: #${String(i).padStart(3, '0')}; }`),
      ...Array.from({ length: 1_000 }, (_, i) => `.c${i} { color: var(--a); background: var(--bg); }`),
      '</style>',
    ].join('');
    expect(ids(lintArtifact(nestedButtons, { a11yLevel: 'wcag-a' }))).toContain('missing-accessible-name');
    expect(ids(lintArtifact(manyLabels, { a11yLevel: 'wcag-a' }))).not.toContain('missing-accessible-name');
    expect(ids(lintArtifact(nestedSelectLabels, { a11yLevel: 'wcag-a' }))).toContain('missing-accessible-name');
    expect(ids(lintArtifact(svgScriptAttack, { a11yLevel: 'wcag-a' }))).toContain('missing-accessible-name');
    expect(ids(lintArtifact(manyThemes, { a11yLevel: 'wcag22-aa' }))).not.toContain('low-contrast-text');
    expect(ids(lintArtifact(varyingThemes, { a11yLevel: 'wcag22-aa' }))).toContain('low-contrast-text');
  });
});

describe('docs/design-systems.md §6 WCAG 2.2 documentation contract', () => {
  it('documents W3C WCAG 2.2 Recommendation link, all 11 SC anchors, all 10 rule IDs, all compliance levels, and unchecked runtime boundaries', () => {
    const repoRoot = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const doc = readFileSync(pathResolve(repoRoot, 'docs/design-systems.md'), 'utf8');
    const sectionStart = doc.indexOf('## 6. Accessibility');
    expect(sectionStart).toBeGreaterThan(-1);
    const nextSection = doc.indexOf('\n## ', sectionStart + 1);
    const section6 = nextSection === -1 ? doc.slice(sectionStart) : doc.slice(sectionStart, nextSection);

    expect(section6).toContain('https://www.w3.org/TR/WCAG22/');
    for (const lvl of A11Y_COMPLIANCE_LEVELS) {
      expect(section6, `§6 missing compliance level ${lvl}`).toContain(lvl);
    }

    const coveredCriteria = [
      '1.1.1', '1.4.3', '1.4.6', '1.4.11', '2.4.2', '2.4.7', '2.4.13', '2.5.5', '2.5.8', '3.1.1', '4.1.2',
    ] as const;
    for (const sc of coveredCriteria) {
      const url = formatWcagCriterionUrl({ standard: 'WCAG-2.2', sc, level: 'AA' });
      expect(url, `missing anchor URL for SC ${sc}`).toBeTruthy();
      expect(section6, `§6 missing anchor URL for SC ${sc}`).toContain(url!);
    }

    for (const ruleId of Object.values(A11Y_RULE_IDS)) {
      expect(section6, `§6 missing rule ID ${ruleId}`).toContain(ruleId);
    }
    for (const checkedRole of ['button', 'link', 'checkbox', 'switch', 'tab', 'menuitem', 'radio', 'option']) {
      expect(section6, `§6 missing checked role ${checkedRole}`).toContain(checkedRole);
    }

    for (const runtimeSc of ['2.4.11', '2.4.12', '2.5.7', '3.2.6', '3.3.7', '3.3.8', '3.3.9']) {
      expect(section6, `§6 missing non-static SC ${runtimeSc}`).toContain(runtimeSc);
    }

    expect(section6).toContain('<!doctype html><main>');
    expect(section6).toContain('formatWcagCriterionUrl');
    expect(section6).toContain('{ standard, sc, level }');
  });
});
