// Accessibility rules in the artifact linter (WP9): WCAG 2.2 contrast,
// accessible names and target size. Each rule has a positive fixture (the
// defect fires) and a negative fixture (the compliant variant stays quiet).
// Colours the linter cannot resolve statically must surface as
// `contrast-unresolved` — never as a silent pass.

import { describe, expect, it } from 'vitest';

import { contrastRatio, parseCssColor } from '../src/lint-a11y.js';
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
  it('fires P0 when a control boundary is below 3:1 against the page', () => {
    const html = `<style>
      body { background: #ffffff; }
      input { border: 1px solid #dddddd; background: #ffffff; }
    </style><label>Email <input type="email"></label>`;
    const hit = finding(lintArtifact(html), 'low-contrast-ui');
    expect(hit.severity).toBe('P0');
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
    const html = `<!doctype html><html><head><style>
      :root { --bg: #ffffff; --fg: #1a1a1a; --accent: #1f4fbf; }
      body { background: var(--bg); color: var(--fg); }
      .btn { background: var(--accent); color: #ffffff; min-height: 44px; padding: 0 16px; }
    </style></head><body><main><h1>Plan</h1><button class="btn">Continue</button></main></body></html>`;
    const a11y = ['low-contrast-text', 'low-contrast-ui', 'missing-accessible-name', 'target-size-min', 'contrast-unresolved'];
    expect(ids(lintArtifact(html)).filter((id) => a11y.includes(id))).toEqual([]);
  });
});
