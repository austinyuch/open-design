// Artifact lint — the anti-slop linter's wire contract.
//
// The daemon has served POST /api/artifacts/lint (and returned the same
// findings inline from POST /api/artifacts/save) since the linter landed,
// but the shape only ever existed as a private type in
// apps/daemon/src/lint-artifact.ts. This file makes it a shared DTO so the
// CLI (`od lint`) and web surfaces parse one contract instead of
// re-declaring the daemon's internals.

export type ArtifactLintSeverity = 'P0' | 'P1' | 'P2';

export type A11yStandard = 'WCAG-2.0' | 'WCAG-2.1' | 'WCAG-2.2';
export type A11yWcagLevel = 'A' | 'AA' | 'AAA';

/** Slot-keyed rule identifiers emitted by the accessibility artifact linter. */
export const A11Y_RULE_IDS = Object.freeze({
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
} as const);

export type A11yRuleSlot = keyof typeof A11Y_RULE_IDS;
export type A11yRuleId = (typeof A11Y_RULE_IDS)[A11yRuleSlot];

export const A11Y_RULE_SLOTS: readonly A11yRuleSlot[] = Object.freeze(
  Object.keys(A11Y_RULE_IDS) as A11yRuleSlot[],
);

export const A11Y_COMPLIANCE_LEVELS = Object.freeze([
  'wcag-a',
  'wcag20-aa',
  'wcag21-aa',
  'wcag22-aa',
  'wcag22-aaa',
  'off',
] as const);

export type A11yComplianceLevel = (typeof A11Y_COMPLIANCE_LEVELS)[number];

export const DEFAULT_A11Y_COMPLIANCE_LEVEL: A11yComplianceLevel = 'wcag22-aa';

const A11Y_SEVERITY_SET: ReadonlySet<string> = new Set<ArtifactLintSeverity>(['P0', 'P1', 'P2']);
const A11Y_STANDARD_SET: ReadonlySet<string> = new Set<A11yStandard>(['WCAG-2.0', 'WCAG-2.1', 'WCAG-2.2']);
const A11Y_WCAG_LEVEL_SET: ReadonlySet<string> = new Set<A11yWcagLevel>(['A', 'AA', 'AAA']);
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** Authoritative W3C WCAG 2.2 Recommendation fragment slugs keyed by Success Criterion number. */
const WCAG_22_CRITERION_SLUGS: ReadonlyMap<string, string> = new Map<string, string>([
  ['1.1.1', 'non-text-content'],
  ['1.4.3', 'contrast-minimum'],
  ['1.4.6', 'contrast-enhanced'],
  ['1.4.11', 'non-text-contrast'],
  ['2.4.2', 'page-titled'],
  ['2.4.7', 'focus-visible'],
  ['2.4.13', 'focus-appearance'],
  ['2.5.5', 'target-size-enhanced'],
  ['2.5.8', 'target-size-minimum'],
  ['3.1.1', 'language-of-page'],
  ['4.1.2', 'name-role-value'],
]);

export function isA11yComplianceLevel(value: unknown): value is A11yComplianceLevel {
  return typeof value === 'string' && (A11Y_COMPLIANCE_LEVELS as readonly string[]).includes(value);
}

/** Format an accessibility compliance reference consistently across `<artifact-lint>` and CLI text output. */
export function formatArtifactLintCompliance(ref: ArtifactLintComplianceRef): string {
  return `${ref.standard.replace('-', ' ')} SC ${ref.sc}, ${ref.level}`;
}

/** Resolve an authoritative W3C WCAG 2.2 Recommendation anchor URL for a compliance reference, or `null`. */
export function formatWcagCriterionUrl(ref?: ArtifactLintComplianceRef | null): string | null {
  try {
    if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) return null;
    const desc = Object.getOwnPropertyDescriptor(ref, 'sc');
    if (!desc || !('value' in desc) || typeof desc.value !== 'string') return null;
    const slug = WCAG_22_CRITERION_SLUGS.get(desc.value);
    return slug ? `https://www.w3.org/TR/WCAG22/#${slug}` : null;
  } catch {
    return null;
  }
}

export type ParseA11yLevelResult<T extends A11yComplianceLevel | undefined> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** Validate raw `a11yLevel` inputs using fixed non-echoing error messages. */
export function parseA11yComplianceLevel(
  raw: unknown,
  options: { defaultLevel: A11yComplianceLevel; label?: string | undefined },
): ParseA11yLevelResult<A11yComplianceLevel>;
export function parseA11yComplianceLevel(
  raw: unknown,
  options?: { defaultLevel?: undefined; label?: string | undefined },
): ParseA11yLevelResult<A11yComplianceLevel | undefined>;
export function parseA11yComplianceLevel(
  raw: unknown,
  options?: { defaultLevel?: A11yComplianceLevel | undefined; label?: string | undefined },
): ParseA11yLevelResult<A11yComplianceLevel | undefined> {
  const expected = A11Y_COMPLIANCE_LEVELS.join(' | ');
  if (options?.defaultLevel !== undefined && !isA11yComplianceLevel(options.defaultLevel)) {
    throw new RangeError(`invalid defaultLevel (expected ${expected})`);
  }
  if (raw === undefined) {
    return { ok: true, value: options?.defaultLevel };
  }
  if (isA11yComplianceLevel(raw)) {
    return { ok: true, value: raw };
  }
  const label = options?.label ?? 'a11yLevel';
  return { ok: false, error: `invalid ${label} (expected ${expected})` };
}

/** Standard / Success Criterion traceability for accessibility findings. */
export interface ArtifactLintComplianceRef {
  standard: A11yStandard;
  sc: string;
  level: A11yWcagLevel;
}

export interface A11yTextContrastRuleSpec {
  severity: ArtifactLintSeverity;
  normalRatio: number;
  largeRatio: number;
  compliance: ArtifactLintComplianceRef;
}

export interface A11yUiContrastRuleSpec {
  severity: ArtifactLintSeverity;
  minRatio: number;
  compliance: ArtifactLintComplianceRef;
}

export interface A11yComplianceRuleSpec {
  severity: ArtifactLintSeverity;
  compliance: ArtifactLintComplianceRef;
}

export type A11yAccessibleNameRuleSpec = A11yComplianceRuleSpec;
export type A11yImgAltRuleSpec = A11yComplianceRuleSpec;
export type A11yPageTitleRuleSpec = A11yComplianceRuleSpec;
export type A11yHtmlLangRuleSpec = A11yComplianceRuleSpec;
export type A11yFocusOutlineRuleSpec = A11yComplianceRuleSpec;

export interface A11yTargetSizeRuleSpec {
  severity: ArtifactLintSeverity;
  minPx: number;
  compliance: ArtifactLintComplianceRef;
}

export interface A11yFocusAppearanceRuleSpec {
  severity: ArtifactLintSeverity;
  minPx: number;
  minRatio: number;
  compliance: ArtifactLintComplianceRef;
}

export interface A11yUnresolvedContrastRuleSpec {
  severity: ArtifactLintSeverity;
}

/**
 * Declarative accessibility compliance profile consumed by the artifact linter.
 * Setting any rule slot to `null` omits that check for the profile.
 */
export interface A11yComplianceProfile {
  id: A11yComplianceLevel;
  label: string;
  textContrast: A11yTextContrastRuleSpec | null;
  uiContrast: A11yUiContrastRuleSpec | null;
  accessibleName: A11yAccessibleNameRuleSpec | null;
  targetSize: A11yTargetSizeRuleSpec | null;
  unresolvedContrast: A11yUnresolvedContrastRuleSpec | null;
  imgAlt: A11yImgAltRuleSpec | null;
  pageTitle: A11yPageTitleRuleSpec | null;
  htmlLang: A11yHtmlLangRuleSpec | null;
  focusOutline: A11yFocusOutlineRuleSpec | null;
  focusAppearance: A11yFocusAppearanceRuleSpec | null;
}

export type A11yRuleSlotMap = Omit<A11yComplianceProfile, 'id' | 'label'>;

export type A11yRuleSpecOverride<T> = { [K in keyof T]?: T[K] | undefined };

export type A11yComplianceProfileOverrides = {
  [K in keyof A11yRuleSlotMap]?: A11yRuleSpecOverride<NonNullable<A11yRuleSlotMap[K]>> | null | undefined;
};

type _AssertSlotKeyParity = [A11yRuleSlot] extends [keyof A11yRuleSlotMap]
  ? ([keyof A11yRuleSlotMap] extends [A11yRuleSlot] ? true : never)
  : never;
const _enforceSlotKeyParity: _AssertSlotKeyParity = true;
void _enforceSlotKeyParity;

function cloneRuleSpec<T extends A11yRuleSlotMap[keyof A11yRuleSlotMap]>(rule: T): T {
  if (rule === null) return rule;
  if ('compliance' in rule) {
    return { ...rule, compliance: { ...rule.compliance } };
  }
  return { ...rule };
}

function buildProfile(
  id: A11yComplianceLevel,
  label: string,
  pickSlot: <K extends A11yRuleSlot>(slot: K) => A11yRuleSlotMap[K],
): A11yComplianceProfile {
  const slots = {} as A11yRuleSlotMap;
  for (const slot of A11Y_RULE_SLOTS) {
    (slots as Record<A11yRuleSlot, A11yRuleSlotMap[A11yRuleSlot]>)[slot] = pickSlot(slot);
  }
  return { id, label, ...slots };
}

function cloneProfile(profile: A11yComplianceProfile): A11yComplianceProfile {
  return buildProfile(profile.id, profile.label, (slot) => cloneRuleSpec(profile[slot]));
}

function withRuleStandard<T extends A11yRuleSlotMap[A11yRuleSlot]>(
  rule: T,
  standard: A11yStandard,
): T {
  const cloned = cloneRuleSpec(rule);
  if (cloned !== null && 'compliance' in cloned) {
    cloned.compliance.standard = standard;
  }
  return cloned;
}

function withStandard(
  profile: A11yComplianceProfile,
  id: A11yComplianceLevel,
  label: string,
  standard: A11yStandard,
): A11yComplianceProfile {
  return buildProfile(id, label, (slot) => withRuleStandard(profile[slot], standard));
}

function extendProfile(
  base: A11yComplianceProfile,
  id: A11yComplianceLevel,
  label: string,
  patch: Partial<A11yRuleSlotMap>,
): A11yComplianceProfile {
  return buildProfile(id, label, (slot) => {
    if (Object.hasOwn(patch, slot)) {
      const val = patch[slot];
      if (val !== undefined) {
        return cloneRuleSpec(val) as A11yRuleSlotMap[typeof slot];
      }
    }
    return cloneRuleSpec(base[slot]);
  });
}

function deepFreezeProfile(profile: A11yComplianceProfile): A11yComplianceProfile {
  for (const slot of A11Y_RULE_SLOTS) {
    const rule = profile[slot];
    if (rule) {
      if ('compliance' in rule) {
        Object.freeze(rule.compliance);
      }
      Object.freeze(rule);
    }
  }
  return Object.freeze(profile);
}

const OFF_PROFILE: A11yComplianceProfile = {
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
};

const WCAG_A_PROFILE = extendProfile(OFF_PROFILE, 'wcag-a', 'WCAG Level A', {
  accessibleName: {
    severity: 'P0',
    compliance: { standard: 'WCAG-2.2', sc: '4.1.2', level: 'A' },
  },
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
});

const WCAG_20_AA_PROFILE = withStandard(
  extendProfile(WCAG_A_PROFILE, 'wcag20-aa', 'WCAG 2.0 Level AA', {
    textContrast: {
      severity: 'P0',
      normalRatio: 4.5,
      largeRatio: 3,
      compliance: { standard: 'WCAG-2.0', sc: '1.4.3', level: 'AA' },
    },
    focusOutline: {
      severity: 'P0',
      compliance: { standard: 'WCAG-2.0', sc: '2.4.7', level: 'AA' },
    },
    unresolvedContrast: { severity: 'P1' },
  }),
  'wcag20-aa',
  'WCAG 2.0 Level AA',
  'WCAG-2.0',
);

const WCAG_21_AA_PROFILE = withStandard(
  extendProfile(WCAG_20_AA_PROFILE, 'wcag21-aa', 'WCAG 2.1 Level AA', {
    uiContrast: {
      severity: 'P1',
      minRatio: 3,
      compliance: { standard: 'WCAG-2.1', sc: '1.4.11', level: 'AA' },
    },
  }),
  'wcag21-aa',
  'WCAG 2.1 Level AA',
  'WCAG-2.1',
);

const WCAG_22_AA_PROFILE = withStandard(
  extendProfile(WCAG_21_AA_PROFILE, 'wcag22-aa', 'WCAG 2.2 Level AA', {
    targetSize: {
      severity: 'P1',
      minPx: 24,
      compliance: { standard: 'WCAG-2.2', sc: '2.5.8', level: 'AA' },
    },
  }),
  'wcag22-aa',
  'WCAG 2.2 Level AA',
  'WCAG-2.2',
);

const WCAG_22_AAA_PROFILE = extendProfile(WCAG_22_AA_PROFILE, 'wcag22-aaa', 'WCAG 2.2 Level AAA', {
  textContrast: {
    severity: 'P0',
    normalRatio: 7,
    largeRatio: 4.5,
    compliance: { standard: 'WCAG-2.2', sc: '1.4.6', level: 'AAA' },
  },
  targetSize: {
    severity: 'P1',
    minPx: 44,
    compliance: { standard: 'WCAG-2.2', sc: '2.5.5', level: 'AAA' },
  },
  focusAppearance: {
    severity: 'P1',
    minPx: 2,
    minRatio: 3,
    compliance: { standard: 'WCAG-2.2', sc: '2.4.13', level: 'AAA' },
  },
});

/** Declarative compliance presets mapped to WCAG standards and tiers. */
export const A11Y_COMPLIANCE_PROFILES: Readonly<Record<A11yComplianceLevel, A11yComplianceProfile>> = Object.freeze({
  off: deepFreezeProfile(OFF_PROFILE),
  'wcag-a': deepFreezeProfile(WCAG_A_PROFILE),
  'wcag20-aa': deepFreezeProfile(WCAG_20_AA_PROFILE),
  'wcag21-aa': deepFreezeProfile(WCAG_21_AA_PROFILE),
  'wcag22-aa': deepFreezeProfile(WCAG_22_AA_PROFILE),
  'wcag22-aaa': deepFreezeProfile(WCAG_22_AAA_PROFILE),
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ownDefined<T extends object>(obj: Record<string, unknown>, key: keyof T & string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function validateSeverity(value: unknown, slot: string): ArtifactLintSeverity {
  if (typeof value !== 'string') {
    throw new TypeError(`${slot}.severity must be a string`);
  }
  if (!A11Y_SEVERITY_SET.has(value)) {
    throw new RangeError(`invalid ${slot}.severity (expected P0 | P1 | P2)`);
  }
  return value as ArtifactLintSeverity;
}

function validateComplianceRef(value: unknown, slot: string): ArtifactLintComplianceRef {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${slot}.compliance must be a plain object`);
  }
  const standard = ownDefined<ArtifactLintComplianceRef>(value, 'standard');
  if (typeof standard !== 'string') {
    throw new TypeError(`${slot}.compliance.standard must be a string`);
  }
  if (!A11Y_STANDARD_SET.has(standard)) {
    throw new RangeError(`invalid ${slot}.compliance.standard (expected WCAG-2.0 | WCAG-2.1 | WCAG-2.2)`);
  }
  const sc = ownDefined<ArtifactLintComplianceRef>(value, 'sc');
  if (typeof sc !== 'string') {
    throw new TypeError(`${slot}.compliance.sc must be a string`);
  }
  if (sc.trim().length === 0) {
    throw new RangeError(`${slot}.compliance.sc must be a non-empty string`);
  }
  if (CONTROL_CHARS_RE.test(sc)) {
    throw new RangeError(`invalid ${slot}.compliance.sc (control characters are not allowed)`);
  }
  const level = ownDefined<ArtifactLintComplianceRef>(value, 'level');
  if (typeof level !== 'string') {
    throw new TypeError(`${slot}.compliance.level must be a string`);
  }
  if (!A11Y_WCAG_LEVEL_SET.has(level)) {
    throw new RangeError(`invalid ${slot}.compliance.level (expected A | AA | AAA)`);
  }
  return {
    standard: standard as A11yStandard,
    sc,
    level: level as A11yWcagLevel,
  };
}

function validateContrastRatio(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`${fieldPath} must be a number`);
  }
  if (!Number.isFinite(value) || value <= 1 || value > 21) {
    throw new RangeError(`${fieldPath} must be finite and within (1, 21]`);
  }
  return value;
}

function validateMinPx(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`${fieldPath} must be a number`);
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${fieldPath} must be finite and > 0`);
  }
  return value;
}

function resolveRuleSlot<T extends NonNullable<A11yRuleSlotMap[keyof A11yRuleSlotMap]>>(
  slot: string,
  baseRule: T | null,
  rawOverride: unknown,
  requiredKeys: readonly (keyof T & string)[],
  validateAndBuild: (merged: Record<string, unknown>) => T,
): T | null {
  if (rawOverride === undefined) {
    return cloneRuleSpec(baseRule);
  }
  if (rawOverride === null) {
    return null;
  }
  if (!isPlainRecord(rawOverride)) {
    throw new TypeError(`${slot} override must be a plain object, null, or undefined`);
  }

  const candidate = Object.assign(
    Object.create(null) as Record<string, unknown>,
    baseRule ? cloneRuleSpec(baseRule) : {},
  );
  for (const key of Object.keys(rawOverride)) {
    const val = rawOverride[key];
    if (val !== undefined) {
      candidate[key] = val;
    }
  }

  if (baseRule === null) {
    for (const reqKey of requiredKeys) {
      if (candidate[reqKey] === undefined) {
        throw new TypeError(`enabling ${slot} from a disabled baseline requires '${reqKey}'`);
      }
    }
  }

  return validateAndBuild(candidate);
}

type BasicComplianceSlot = 'accessibleName' | 'imgAlt' | 'pageTitle' | 'htmlLang' | 'focusOutline';

function resolveBasicComplianceRuleSlot(
  slot: BasicComplianceSlot,
  base: A11yComplianceProfile,
  overrides: Record<string, unknown>,
): A11yComplianceRuleSpec | null {
  return resolveRuleSlot(
    slot,
    base[slot],
    ownDefined<A11yComplianceProfileOverrides>(overrides, slot),
    ['severity', 'compliance'],
    (m) => ({
      severity: validateSeverity(m.severity, slot),
      compliance: validateComplianceRef(m.compliance, slot),
    }),
  );
}

/** Resolve a base compliance profile and apply optional field-level declarative overrides. */
export function resolveA11yComplianceProfile(
  level: A11yComplianceLevel = DEFAULT_A11Y_COMPLIANCE_LEVEL,
  overrides?: A11yComplianceProfileOverrides,
): A11yComplianceProfile {
  if (!isA11yComplianceLevel(level)) {
    throw new RangeError(`invalid a11yLevel (expected ${A11Y_COMPLIANCE_LEVELS.join(' | ')})`);
  }
  const base = A11Y_COMPLIANCE_PROFILES[level];
  if (overrides === undefined) {
    return cloneProfile(base);
  }
  if (!isPlainRecord(overrides)) {
    throw new TypeError('a11yProfile overrides must be a plain object');
  }

  return {
    id: base.id,
    label: base.label,
    textContrast: resolveRuleSlot(
      'textContrast',
      base.textContrast,
      ownDefined<A11yComplianceProfileOverrides>(overrides, 'textContrast'),
      ['severity', 'normalRatio', 'largeRatio', 'compliance'],
      (m) => ({
        severity: validateSeverity(m.severity, 'textContrast'),
        normalRatio: validateContrastRatio(m.normalRatio, 'textContrast.normalRatio'),
        largeRatio: validateContrastRatio(m.largeRatio, 'textContrast.largeRatio'),
        compliance: validateComplianceRef(m.compliance, 'textContrast'),
      }),
    ),
    uiContrast: resolveRuleSlot(
      'uiContrast',
      base.uiContrast,
      ownDefined<A11yComplianceProfileOverrides>(overrides, 'uiContrast'),
      ['severity', 'minRatio', 'compliance'],
      (m) => ({
        severity: validateSeverity(m.severity, 'uiContrast'),
        minRatio: validateContrastRatio(m.minRatio, 'uiContrast.minRatio'),
        compliance: validateComplianceRef(m.compliance, 'uiContrast'),
      }),
    ),
    accessibleName: resolveBasicComplianceRuleSlot('accessibleName', base, overrides),
    targetSize: resolveRuleSlot(
      'targetSize',
      base.targetSize,
      ownDefined<A11yComplianceProfileOverrides>(overrides, 'targetSize'),
      ['severity', 'minPx', 'compliance'],
      (m) => ({
        severity: validateSeverity(m.severity, 'targetSize'),
        minPx: validateMinPx(m.minPx, 'targetSize.minPx'),
        compliance: validateComplianceRef(m.compliance, 'targetSize'),
      }),
    ),
    unresolvedContrast: resolveRuleSlot(
      'unresolvedContrast',
      base.unresolvedContrast,
      ownDefined<A11yComplianceProfileOverrides>(overrides, 'unresolvedContrast'),
      ['severity'],
      (m) => ({
        severity: validateSeverity(m.severity, 'unresolvedContrast'),
      }),
    ),
    imgAlt: resolveBasicComplianceRuleSlot('imgAlt', base, overrides),
    pageTitle: resolveBasicComplianceRuleSlot('pageTitle', base, overrides),
    htmlLang: resolveBasicComplianceRuleSlot('htmlLang', base, overrides),
    focusOutline: resolveBasicComplianceRuleSlot('focusOutline', base, overrides),
    focusAppearance: resolveRuleSlot(
      'focusAppearance',
      base.focusAppearance,
      ownDefined<A11yComplianceProfileOverrides>(overrides, 'focusAppearance'),
      ['severity', 'minPx', 'minRatio', 'compliance'],
      (m) => ({
        severity: validateSeverity(m.severity, 'focusAppearance'),
        minPx: validateMinPx(m.minPx, 'focusAppearance.minPx'),
        minRatio: validateContrastRatio(m.minRatio, 'focusAppearance.minRatio'),
        compliance: validateComplianceRef(m.compliance, 'focusAppearance'),
      }),
    ),
  };
}

export interface ArtifactLintFinding {
  severity: ArtifactLintSeverity;
  /** Stable rule id, e.g. `purple-gradient`, `invented-metric`. */
  id: string;
  message: string;
  /** Actionable remediation, phrased for the generating agent. */
  fix: string;
  /** Offending excerpt when the rule can isolate one. */
  snippet?: string;
  /** Declarative compliance provenance attached by tiered a11y rules. */
  compliance?: ArtifactLintComplianceRef;
}

export interface LintArtifactRequest {
  html: string;
  /** Optional accessibility compliance tier (defaults to `wcag22-aa`). */
  a11yLevel?: A11yComplianceLevel;
}

export interface LintArtifactResponse {
  findings: ArtifactLintFinding[];
  /**
   * Findings pre-rendered as an `<artifact-lint>` block, formatted to be
   * spliced into the generating agent's next turn for self-correction.
   */
  agentMessage: string;
  /** Effective accessibility compliance tier applied by the daemon. */
  a11yLevel?: A11yComplianceLevel;
}

/** Severity threshold for `od lint`'s exit code. `none` never fails. */
export type LintFailOn = 'p0' | 'p1' | 'p2' | 'none';

export interface LintArtifactCliCounts {
  p0: number;
  p1: number;
  p2: number;
}

/** Machine envelope printed by `od lint --json`. */
export interface LintArtifactCliResultEnvelope {
  ok: boolean;
  file: string;
  failOn: LintFailOn;
  a11yLevel: A11yComplianceLevel;
  counts: LintArtifactCliCounts;
  findings: ArtifactLintFinding[];
  agentMessage: string;
}
