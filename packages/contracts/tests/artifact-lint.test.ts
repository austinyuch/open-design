import { describe, expect, it } from 'vitest';

import {
  A11Y_COMPLIANCE_LEVELS,
  A11Y_COMPLIANCE_PROFILES,
  A11Y_RULE_IDS,
  A11Y_RULE_SLOTS,
  DEFAULT_A11Y_COMPLIANCE_LEVEL,
  formatArtifactLintCompliance,
  formatWcagCriterionUrl,
  isA11yComplianceLevel,
  parseA11yComplianceLevel,
  resolveA11yComplianceProfile,
  type A11yAccessibleNameRuleSpec,
  type A11yComplianceProfileOverrides,
  type A11yComplianceRuleSpec,
  type A11yFocusAppearanceRuleSpec,
  type A11yFocusOutlineRuleSpec,
  type A11yHtmlLangRuleSpec,
  type A11yImgAltRuleSpec,
  type A11yPageTitleRuleSpec,
  type A11yRuleSlot,
  type A11yRuleSlotMap,
  type ArtifactLintFinding,
} from '../src/api/artifact-lint';

// Compile-time bidirectionality lock between A11yRuleSlot and keyof A11yRuleSlotMap
type _AssertSlotParity = [A11yRuleSlot] extends [keyof A11yRuleSlotMap]
  ? ([keyof A11yRuleSlotMap] extends [A11yRuleSlot] ? true : never)
  : never;
const _slotParityCheck: _AssertSlotParity = true;

describe('artifact lint a11y compliance profiles', () => {
  it('defines slot-keyed frozen A11Y_RULE_IDS, A11Y_RULE_SLOTS, frozen levels, and uniform compliance formatting', () => {
    expect(_slotParityCheck).toBe(true);
    expect(Object.isFrozen(A11Y_RULE_IDS)).toBe(true);
    expect(Object.isFrozen(A11Y_RULE_SLOTS)).toBe(true);
    expect(Object.isFrozen(A11Y_COMPLIANCE_LEVELS)).toBe(true);
    expect(() => (A11Y_COMPLIANCE_LEVELS as unknown as string[]).push('custom')).toThrow(TypeError);

    expect(A11Y_RULE_SLOTS).toEqual(Object.keys(A11Y_RULE_IDS));
    expect(A11Y_RULE_IDS).toEqual({
      textContrast: 'low-contrast-text',
      uiContrast: 'low-contrast-ui',
      accessibleName: 'missing-accessible-name',
      targetSize: 'target-size-min',
      unresolvedContrast: 'contrast-unresolved',
      imgAlt: 'missing-img-alt',
      pageTitle: 'missing-page-title',
      htmlLang: 'missing-html-lang',
      focusOutline: 'focus-outline-suppressed',
      focusAppearance: 'low-focus-appearance',
    });

    expect(
      formatArtifactLintCompliance({ standard: 'WCAG-2.0', sc: '1.4.3', level: 'AA' }),
    ).toBe('WCAG 2.0 SC 1.4.3, AA');
    expect(
      formatArtifactLintCompliance({ standard: 'WCAG-2.1', sc: '1.4.11', level: 'AA' }),
    ).toBe('WCAG 2.1 SC 1.4.11, AA');
    expect(
      formatArtifactLintCompliance({ standard: 'WCAG-2.2', sc: '4.1.2', level: 'A' }),
    ).toBe('WCAG 2.2 SC 4.1.2, A');
    expect(
      formatArtifactLintCompliance({ standard: 'WCAG-2.2', sc: '2.4.13', level: 'AAA' }),
    ).toBe('WCAG 2.2 SC 2.4.13, AAA');
  });

  it('defines a declarative profile for every declared level', () => {
    expect(DEFAULT_A11Y_COMPLIANCE_LEVEL).toBe('wcag22-aa');
    for (const level of A11Y_COMPLIANCE_LEVELS) {
      expect(A11Y_COMPLIANCE_PROFILES[level].id).toBe(level);
      expect(A11Y_COMPLIANCE_PROFILES[level].label.length).toBeGreaterThan(0);
    }
  });

  it('validates compliance level names with isA11yComplianceLevel', () => {
    for (const level of A11Y_COMPLIANCE_LEVELS) {
      expect(isA11yComplianceLevel(level)).toBe(true);
    }
    expect(isA11yComplianceLevel('wcag30')).toBe(false);
    expect(isA11yComplianceLevel('')).toBe(false);
    expect(isA11yComplianceLevel(null)).toBe(false);
    expect(isA11yComplianceLevel(22)).toBe(false);
  });

  it('parses optional vs defaulted a11yLevel without echoing untrusted values', () => {
    expect(parseA11yComplianceLevel(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseA11yComplianceLevel(undefined, { defaultLevel: 'off' })).toEqual({
      ok: true,
      value: 'off',
    });
    expect(parseA11yComplianceLevel('wcag21-aa')).toEqual({
      ok: true,
      value: 'wcag21-aa',
    });

    for (const bad of [null, '', 22, 'wcag30', 'bogus\u001b[31m\n']) {
      const res = parseA11yComplianceLevel(bad, {
        defaultLevel: 'wcag22-aa',
        label: '--a11y-level',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe(
          `invalid --a11y-level (expected ${A11Y_COMPLIANCE_LEVELS.join(' | ')})`,
        );
        expect(res.error).not.toContain('bogus');
        expect(res.error).not.toContain('\u001b');
      }
    }

    const defaultLabelErr = parseA11yComplianceLevel(null);
    expect(defaultLabelErr).toEqual({
      ok: false,
      error: `invalid a11yLevel (expected ${A11Y_COMPLIANCE_LEVELS.join(' | ')})`,
    });

    expect(() =>
      parseA11yComplianceLevel(undefined, { defaultLevel: 'bogus' as never }),
    ).toThrow(RangeError);
  });

  it('matches hardcoded 6x10 golden snapshots and deep freezes all six preset profiles', () => {
    const golden = {
      off: {
        id: 'off',
        label: 'Accessibility checks disabled',
        textContrast: null,
        uiContrast: null,
        accessibleName: null,
        targetSize: null,
        unresolvedContrast: null,
        imgAlt: null,
        pageTitle: null,
        htmlLang: null,
        focusOutline: null,
        focusAppearance: null,
      },
      'wcag-a': {
        id: 'wcag-a',
        label: 'WCAG Level A',
        textContrast: null,
        uiContrast: null,
        accessibleName: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.2', sc: '4.1.2', level: 'A' },
        },
        targetSize: null,
        unresolvedContrast: null,
        imgAlt: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.2', sc: '1.1.1', level: 'A' },
        },
        pageTitle: {
          severity: 'P1',
          compliance: { standard: 'WCAG-2.2', sc: '2.4.2', level: 'A' },
        },
        htmlLang: {
          severity: 'P1',
          compliance: { standard: 'WCAG-2.2', sc: '3.1.1', level: 'A' },
        },
        focusOutline: null,
        focusAppearance: null,
      },
      'wcag20-aa': {
        id: 'wcag20-aa',
        label: 'WCAG 2.0 Level AA',
        textContrast: {
          severity: 'P0',
          normalRatio: 4.5,
          largeRatio: 3,
          compliance: { standard: 'WCAG-2.0', sc: '1.4.3', level: 'AA' },
        },
        uiContrast: null,
        accessibleName: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.0', sc: '4.1.2', level: 'A' },
        },
        targetSize: null,
        unresolvedContrast: { severity: 'P1' },
        imgAlt: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.0', sc: '1.1.1', level: 'A' },
        },
        pageTitle: {
          severity: 'P1',
          compliance: { standard: 'WCAG-2.0', sc: '2.4.2', level: 'A' },
        },
        htmlLang: {
          severity: 'P1',
          compliance: { standard: 'WCAG-2.0', sc: '3.1.1', level: 'A' },
        },
        focusOutline: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.0', sc: '2.4.7', level: 'AA' },
        },
        focusAppearance: null,
      },
      'wcag21-aa': {
        id: 'wcag21-aa',
        label: 'WCAG 2.1 Level AA',
        textContrast: {
          severity: 'P0',
          normalRatio: 4.5,
          largeRatio: 3,
          compliance: { standard: 'WCAG-2.1', sc: '1.4.3', level: 'AA' },
        },
        uiContrast: {
          severity: 'P0',
          minRatio: 3,
          compliance: { standard: 'WCAG-2.1', sc: '1.4.11', level: 'AA' },
        },
        accessibleName: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.1', sc: '4.1.2', level: 'A' },
        },
        targetSize: null,
        unresolvedContrast: { severity: 'P1' },
        imgAlt: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.1', sc: '1.1.1', level: 'A' },
        },
        pageTitle: {
          severity: 'P1',
          compliance: { standard: 'WCAG-2.1', sc: '2.4.2', level: 'A' },
        },
        htmlLang: {
          severity: 'P1',
          compliance: { standard: 'WCAG-2.1', sc: '3.1.1', level: 'A' },
        },
        focusOutline: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.1', sc: '2.4.7', level: 'AA' },
        },
        focusAppearance: null,
      },
      'wcag22-aa': {
        id: 'wcag22-aa',
        label: 'WCAG 2.2 Level AA',
        textContrast: {
          severity: 'P0',
          normalRatio: 4.5,
          largeRatio: 3,
          compliance: { standard: 'WCAG-2.2', sc: '1.4.3', level: 'AA' },
        },
        uiContrast: {
          severity: 'P0',
          minRatio: 3,
          compliance: { standard: 'WCAG-2.2', sc: '1.4.11', level: 'AA' },
        },
        accessibleName: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.2', sc: '4.1.2', level: 'A' },
        },
        targetSize: {
          severity: 'P1',
          minPx: 24,
          compliance: { standard: 'WCAG-2.2', sc: '2.5.8', level: 'AA' },
        },
        unresolvedContrast: { severity: 'P1' },
        imgAlt: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.2', sc: '1.1.1', level: 'A' },
        },
        pageTitle: {
          severity: 'P1',
          compliance: { standard: 'WCAG-2.2', sc: '2.4.2', level: 'A' },
        },
        htmlLang: {
          severity: 'P1',
          compliance: { standard: 'WCAG-2.2', sc: '3.1.1', level: 'A' },
        },
        focusOutline: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.2', sc: '2.4.7', level: 'AA' },
        },
        focusAppearance: null,
      },
      'wcag22-aaa': {
        id: 'wcag22-aaa',
        label: 'WCAG 2.2 Level AAA',
        textContrast: {
          severity: 'P0',
          normalRatio: 7,
          largeRatio: 4.5,
          compliance: { standard: 'WCAG-2.2', sc: '1.4.6', level: 'AAA' },
        },
        uiContrast: {
          severity: 'P0',
          minRatio: 3,
          compliance: { standard: 'WCAG-2.2', sc: '1.4.11', level: 'AA' },
        },
        accessibleName: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.2', sc: '4.1.2', level: 'A' },
        },
        targetSize: {
          severity: 'P1',
          minPx: 44,
          compliance: { standard: 'WCAG-2.2', sc: '2.5.5', level: 'AAA' },
        },
        unresolvedContrast: { severity: 'P1' },
        imgAlt: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.2', sc: '1.1.1', level: 'A' },
        },
        pageTitle: {
          severity: 'P1',
          compliance: { standard: 'WCAG-2.2', sc: '2.4.2', level: 'A' },
        },
        htmlLang: {
          severity: 'P1',
          compliance: { standard: 'WCAG-2.2', sc: '3.1.1', level: 'A' },
        },
        focusOutline: {
          severity: 'P0',
          compliance: { standard: 'WCAG-2.2', sc: '2.4.7', level: 'AA' },
        },
        focusAppearance: {
          severity: 'P1',
          minPx: 2,
          minRatio: 3,
          compliance: { standard: 'WCAG-2.2', sc: '2.4.13', level: 'AAA' },
        },
      },
    } as const;

    expect(Object.isFrozen(A11Y_COMPLIANCE_PROFILES)).toBe(true);
    for (const level of A11Y_COMPLIANCE_LEVELS) {
      const profile = A11Y_COMPLIANCE_PROFILES[level];
      expect(profile).toEqual(golden[level]);
      expect(Object.isFrozen(profile)).toBe(true);
      for (const slot of A11Y_RULE_SLOTS) {
        const rule = profile[slot];
        if (rule) {
          expect(Object.isFrozen(rule)).toBe(true);
          if ('compliance' in rule) {
            expect(Object.isFrozen(rule.compliance)).toBe(true);
            expect(Object.keys(rule.compliance)).toEqual(['standard', 'sc', 'level']);
          }
        }
      }
    }
  });

  it('preserves strict subset off c wcag-a c wcag20-aa c wcag21-aa c wcag22-aa c wcag22-aaa and threshold monotonicity', () => {
    const enabledSlots = (profile: (typeof A11Y_COMPLIANCE_PROFILES)[keyof typeof A11Y_COMPLIANCE_PROFILES]) =>
      A11Y_RULE_SLOTS.filter((slot) => profile[slot] !== null);

    const tiers = ['off', 'wcag-a', 'wcag20-aa', 'wcag21-aa', 'wcag22-aa', 'wcag22-aaa'] as const;
    for (let i = 0; i < tiers.length - 1; i += 1) {
      const prev = new Set(enabledSlots(A11Y_COMPLIANCE_PROFILES[tiers[i]!]));
      const next = new Set(enabledSlots(A11Y_COMPLIANCE_PROFILES[tiers[i + 1]!]));
      for (const slot of prev) {
        expect(next.has(slot)).toBe(true);
      }
      expect(next.size).toBeGreaterThan(prev.size);
    }

    const aa22 = A11Y_COMPLIANCE_PROFILES['wcag22-aa'];
    const aaa22 = A11Y_COMPLIANCE_PROFILES['wcag22-aaa'];
    expect(aaa22.textContrast!.normalRatio).toBeGreaterThan(aa22.textContrast!.normalRatio);
    expect(aaa22.textContrast!.largeRatio).toBeGreaterThan(aa22.textContrast!.largeRatio);
    expect(aaa22.targetSize!.minPx).toBeGreaterThan(aa22.targetSize!.minPx);
    expect(aaa22.uiContrast!.minRatio).toBeGreaterThanOrEqual(aa22.uiContrast!.minRatio);
    expect(aa22.uiContrast!.minRatio).toBeGreaterThanOrEqual(A11Y_COMPLIANCE_PROFILES['wcag21-aa'].uiContrast!.minRatio);
  });

  it('maps W3C WCAG 2.2 Recommendation anchors safely via formatWcagCriterionUrl', () => {
    const expectedUrls: Record<string, string> = {
      '1.1.1': 'https://www.w3.org/TR/WCAG22/#non-text-content',
      '1.4.3': 'https://www.w3.org/TR/WCAG22/#contrast-minimum',
      '1.4.6': 'https://www.w3.org/TR/WCAG22/#contrast-enhanced',
      '1.4.11': 'https://www.w3.org/TR/WCAG22/#non-text-contrast',
      '2.4.2': 'https://www.w3.org/TR/WCAG22/#page-titled',
      '2.4.7': 'https://www.w3.org/TR/WCAG22/#focus-visible',
      '2.4.13': 'https://www.w3.org/TR/WCAG22/#focus-appearance',
      '2.5.5': 'https://www.w3.org/TR/WCAG22/#target-size-enhanced',
      '2.5.8': 'https://www.w3.org/TR/WCAG22/#target-size-minimum',
      '3.1.1': 'https://www.w3.org/TR/WCAG22/#language-of-page',
      '4.1.2': 'https://www.w3.org/TR/WCAG22/#name-role-value',
    };

    for (const [sc, url] of Object.entries(expectedUrls)) {
      expect(formatWcagCriterionUrl({ standard: 'WCAG-2.0', sc, level: 'A' })).toBe(url);
      expect(formatWcagCriterionUrl({ standard: 'WCAG-2.2', sc, level: 'AA' })).toBe(url);
    }

    for (const level of A11Y_COMPLIANCE_LEVELS) {
      const profile = A11Y_COMPLIANCE_PROFILES[level];
      for (const slot of A11Y_RULE_SLOTS) {
        const rule = profile[slot];
        if (rule && 'compliance' in rule) {
          expect(formatWcagCriterionUrl(rule.compliance)).toMatch(/^https:\/\/www\.w3\.org\/TR\/WCAG22\/#[a-z-]+$/);
        }
      }
    }

    const findingWithOptional: ArtifactLintFinding = {
      severity: 'P0',
      id: 'low-contrast-text',
      message: 'msg',
      fix: 'fix',
      compliance: { standard: 'WCAG-2.2', sc: '1.4.3', level: 'AA' },
    };
    const findingWithoutCompliance: ArtifactLintFinding = {
      severity: 'P1',
      id: 'contrast-unresolved',
      message: 'msg',
      fix: 'fix',
    };
    expect(formatWcagCriterionUrl(findingWithOptional.compliance)).toBe('https://www.w3.org/TR/WCAG22/#contrast-minimum');
    expect(formatWcagCriterionUrl(findingWithoutCompliance.compliance)).toBeNull();

    // Hostile runtime, prototype, getter, and Proxy inputs return null without throwing
    const throwingGetter = Object.defineProperty({}, 'sc', {
      enumerable: true,
      get() {
        throw new Error('getter trap');
      },
    });
    const hostileProxy = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error('proxy trap');
      },
    });
    const arrayWithSc = Object.assign(['1.1.1'], { sc: '1.1.1' });

    for (const badRef of [
      null,
      undefined,
      '1.1.1',
      42,
      ['1.1.1'],
      arrayWithSc,
      {},
      { standard: 'WCAG-2.2', sc: '9.9.9', level: 'AA' },
      { standard: 'WCAG-2.2', sc: '   ', level: 'AA' },
      { standard: 'WCAG-2.2', sc: 'low-contrast-text', level: 'AA' },
      { standard: 'WCAG-2.2', sc: 'toString', level: 'AA' },
      { standard: 'WCAG-2.2', sc: '__proto__', level: 'AA' },
      { standard: 'WCAG-2.2', sc: 'constructor', level: 'AA' },
      Object.create({ sc: '1.1.1' }),
      throwingGetter,
      hostileProxy,
    ]) {
      expect(() => formatWcagCriterionUrl(badRef as never)).not.toThrow();
      expect(formatWcagCriterionUrl(badRef as never)).toBeNull();
    }
  });

  it('merges field-level overrides, honors exactOptionalPropertyTypes undefined keys, and clones isolated copies', () => {
    const resolvedBase = resolveA11yComplianceProfile('wcag22-aa');
    expect(resolvedBase).toEqual(A11Y_COMPLIANCE_PROFILES['wcag22-aa']);
    resolvedBase.textContrast!.normalRatio = 99;
    resolvedBase.textContrast!.compliance.sc = '9.9.9';
    resolvedBase.imgAlt!.compliance.sc = '9.9.9';
    resolvedBase.focusOutline!.severity = 'P2';
    expect(A11Y_COMPLIANCE_PROFILES['wcag22-aa'].textContrast!.normalRatio).toBe(4.5);
    expect(A11Y_COMPLIANCE_PROFILES['wcag22-aa'].imgAlt!.compliance.sc).toBe('1.1.1');
    expect(A11Y_COMPLIANCE_PROFILES['wcag22-aa'].focusOutline!.severity).toBe('P0');
    expect(resolveA11yComplianceProfile('wcag22-aa').imgAlt!.compliance.sc).toBe('1.1.1');

    const overrides: A11yComplianceProfileOverrides = {
      textContrast: { normalRatio: 5, largeRatio: undefined },
      uiContrast: undefined,
      imgAlt: { severity: undefined },
    };
    const partial = resolveA11yComplianceProfile('wcag22-aa', overrides);
    expect(partial.textContrast).toEqual({
      severity: 'P0',
      normalRatio: 5,
      largeRatio: 3,
      compliance: { standard: 'WCAG-2.2', sc: '1.4.3', level: 'AA' },
    });
    expect(partial.imgAlt).toEqual({
      severity: 'P0',
      compliance: { standard: 'WCAG-2.2', sc: '1.1.1', level: 'A' },
    });
    expect(partial.uiContrast).toEqual(A11Y_COMPLIANCE_PROFILES['wcag22-aa'].uiContrast);

    const callerCompliance = { standard: 'WCAG-2.1' as const, sc: '1.4.6', level: 'AAA' as const };
    const complianceReplaced = resolveA11yComplianceProfile('wcag22-aa', {
      imgAlt: { compliance: callerCompliance },
    });
    expect(complianceReplaced.imgAlt?.severity).toBe('P0');
    expect(complianceReplaced.imgAlt?.compliance).toEqual(callerCompliance);
    callerCompliance.sc = 'mutated';
    expect(complianceReplaced.imgAlt?.compliance.sc).toBe('1.4.6');

    const accessibleSpec: A11yAccessibleNameRuleSpec = { severity: 'P0', compliance: { standard: 'WCAG-2.2', sc: '4.1.2', level: 'A' } };
    const imgAltSpec: A11yImgAltRuleSpec = { severity: 'P0', compliance: { standard: 'WCAG-2.2', sc: '1.1.1', level: 'A' } };
    const pageTitleSpec: A11yPageTitleRuleSpec = { severity: 'P1', compliance: { standard: 'WCAG-2.2', sc: '2.4.2', level: 'A' } };
    const htmlLangSpec: A11yHtmlLangRuleSpec = { severity: 'P1', compliance: { standard: 'WCAG-2.2', sc: '3.1.1', level: 'A' } };
    const focusOutlineSpec: A11yFocusOutlineRuleSpec = { severity: 'P0', compliance: { standard: 'WCAG-2.2', sc: '2.4.7', level: 'AA' } };
    const focusAppearanceSpec: A11yFocusAppearanceRuleSpec = {
      severity: 'P1',
      minPx: 3,
      minRatio: 4.5,
      compliance: { standard: 'WCAG-2.2', sc: '2.4.13', level: 'AAA' },
    };
    const basicRef: A11yComplianceRuleSpec = imgAltSpec;
    expect(basicRef.severity).toBe('P0');

    const reactivatedAllNew = resolveA11yComplianceProfile('off', {
      accessibleName: accessibleSpec,
      imgAlt: imgAltSpec,
      pageTitle: pageTitleSpec,
      htmlLang: htmlLangSpec,
      focusOutline: focusOutlineSpec,
      focusAppearance: focusAppearanceSpec,
    });
    expect(reactivatedAllNew.imgAlt).toEqual(imgAltSpec);
    expect(reactivatedAllNew.pageTitle).toEqual(pageTitleSpec);
    expect(reactivatedAllNew.htmlLang).toEqual(htmlLangSpec);
    expect(reactivatedAllNew.focusOutline).toEqual(focusOutlineSpec);
    expect(reactivatedAllNew.focusAppearance).toEqual(focusAppearanceSpec);

    const enabledFromAa = resolveA11yComplianceProfile('wcag22-aa', {
      focusAppearance: focusAppearanceSpec,
      imgAlt: null,
    });
    expect(enabledFromAa.focusAppearance).toEqual(focusAppearanceSpec);
    expect(enabledFromAa.imgAlt).toBeNull();

    const tunedAaa = resolveA11yComplianceProfile('wcag22-aaa', {
      focusAppearance: { minPx: 3, minRatio: undefined },
    });
    expect(tunedAaa.focusAppearance).toEqual({
      severity: 'P1',
      minPx: 3,
      minRatio: 3,
      compliance: { standard: 'WCAG-2.2', sc: '2.4.13', level: 'AAA' },
    });
  });

  it('rejects invalid runtime levels, non-plain containers, incomplete null-slot activations, control-char sc, and invalid thresholds', () => {
    let thrownLevelErr: unknown;
    try {
      resolveA11yComplianceProfile('wcag30\u001b[31m' as never);
    } catch (err) {
      thrownLevelErr = err;
    }
    expect(thrownLevelErr).toBeInstanceOf(RangeError);
    expect((thrownLevelErr as Error).message).not.toContain('wcag30');
    expect((thrownLevelErr as Error).message).not.toContain('\u001b');

    expect(() => resolveA11yComplianceProfile(Object.create(null) as never)).toThrow(RangeError);

    for (const badOverrides of [[], 'str', 123, () => ({}), null]) {
      expect(() =>
        resolveA11yComplianceProfile('wcag22-aa', badOverrides as never),
      ).toThrow(TypeError);
    }

    expect(() =>
      resolveA11yComplianceProfile('wcag22-aa', { textContrast: [] as never }),
    ).toThrow(TypeError);

    // Enabling null rule slots without full required fields throws TypeError
    expect(() =>
      resolveA11yComplianceProfile('off', {
        textContrast: { severity: 'P0', normalRatio: 4.5 },
      }),
    ).toThrow(TypeError);
    expect(() =>
      resolveA11yComplianceProfile('off', { unresolvedContrast: {} }),
    ).toThrow(TypeError);
    for (const slot of ['imgAlt', 'pageTitle', 'htmlLang', 'focusOutline'] as const) {
      expect(() =>
        resolveA11yComplianceProfile('off', { [slot]: { severity: 'P0' } }),
      ).toThrow(TypeError);
    }
    expect(() =>
      resolveA11yComplianceProfile('wcag22-aa', {
        focusAppearance: {
          severity: 'P1',
          minPx: 2,
          compliance: { standard: 'WCAG-2.2', sc: '2.4.13', level: 'AAA' },
        },
      }),
    ).toThrow(TypeError);

    // Numeric bounds and types
    expect(resolveA11yComplianceProfile('wcag22-aa', { textContrast: { normalRatio: 1.01, largeRatio: 21 } }).textContrast?.normalRatio).toBe(1.01);
    expect(resolveA11yComplianceProfile('wcag22-aa', { targetSize: { minPx: 0.5 } }).targetSize?.minPx).toBe(0.5);

    for (const badRatio of [1, 21.1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        resolveA11yComplianceProfile('wcag22-aa', { textContrast: { normalRatio: badRatio } }),
      ).toThrow(RangeError);
      expect(() =>
        resolveA11yComplianceProfile('wcag22-aa', { textContrast: { largeRatio: badRatio } }),
      ).toThrow(RangeError);
      expect(() =>
        resolveA11yComplianceProfile('wcag22-aa', { uiContrast: { minRatio: badRatio } }),
      ).toThrow(RangeError);
      expect(() =>
        resolveA11yComplianceProfile('wcag22-aaa', { focusAppearance: { minRatio: badRatio } }),
      ).toThrow(RangeError);
    }
    expect(() =>
      resolveA11yComplianceProfile('wcag22-aa', { textContrast: { normalRatio: '4.5' as never } }),
    ).toThrow(TypeError);
    expect(() =>
      resolveA11yComplianceProfile('wcag22-aaa', { focusAppearance: { minRatio: '3' as never } }),
    ).toThrow(TypeError);

    for (const badPx of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        resolveA11yComplianceProfile('wcag22-aa', { targetSize: { minPx: badPx } }),
      ).toThrow(RangeError);
      expect(() =>
        resolveA11yComplianceProfile('wcag22-aaa', { focusAppearance: { minPx: badPx } }),
      ).toThrow(RangeError);
    }
    expect(() =>
      resolveA11yComplianceProfile('wcag22-aa', { targetSize: { minPx: '24' as never } }),
    ).toThrow(TypeError);
    expect(() =>
      resolveA11yComplianceProfile('wcag22-aaa', { focusAppearance: { minPx: '2' as never } }),
    ).toThrow(TypeError);

    // Control characters in compliance.sc are rejected without echo
    for (const badSc of ['1.1.1\n', '1.1.1\r', '1.1.1\u0000', '1.1.1\u001b[31m', '1.1.1\u007f', '1.1.1\u009f']) {
      let scErr: unknown;
      try {
        resolveA11yComplianceProfile('wcag22-aa', {
          imgAlt: { compliance: { standard: 'WCAG-2.2', sc: badSc, level: 'A' } },
        });
      } catch (err) {
        scErr = err;
      }
      expect(scErr).toBeInstanceOf(RangeError);
      expect((scErr as Error).message).not.toContain('1.1.1');
      expect((scErr as Error).message).not.toContain('\u001b');
    }

    // Severity & compliance type vs enum/range checks
    expect(() =>
      resolveA11yComplianceProfile('wcag22-aa', { unresolvedContrast: { severity: 123 as never } }),
    ).toThrow(TypeError);
    expect(() =>
      resolveA11yComplianceProfile('wcag22-aa', { unresolvedContrast: { severity: 'warn' as never } }),
    ).toThrow(RangeError);

    expect(() =>
      resolveA11yComplianceProfile('wcag22-aa', { accessibleName: { compliance: null as never } }),
    ).toThrow(TypeError);
    expect(() =>
      resolveA11yComplianceProfile('wcag22-aa', {
        accessibleName: { compliance: { standard: 'WCAG-2.2', sc: 412 as never, level: 'A' } },
      }),
    ).toThrow(TypeError);
    expect(() =>
      resolveA11yComplianceProfile('wcag22-aa', {
        accessibleName: { compliance: { standard: 'WCAG-3.0' as never, sc: '4.1.2', level: 'A' } },
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveA11yComplianceProfile('wcag22-aa', {
        accessibleName: { compliance: { standard: 'WCAG-2.2', sc: '   ', level: 'A' } },
      }),
    ).toThrow(RangeError);
    expect(() =>
      resolveA11yComplianceProfile('wcag22-aa', {
        accessibleName: { compliance: { standard: 'WCAG-2.2', sc: '4.1.2', level: 'AAAA' as never } },
      }),
    ).toThrow(RangeError);

    const nullProtoOverrides = Object.assign(Object.create(null), {
      targetSize: null,
      focusOutline: null,
    });
    const resolvedNullProto = resolveA11yComplianceProfile('wcag22-aa', nullProtoOverrides);
    expect(resolvedNullProto.targetSize).toBeNull();
    expect(resolvedNullProto.focusOutline).toBeNull();

    const parsedProto = JSON.parse('{"__proto__": {"admin": true}}');
    expect(resolveA11yComplianceProfile('wcag-a', parsedProto)).toEqual(A11Y_COMPLIANCE_PROFILES['wcag-a']);
  });
});
