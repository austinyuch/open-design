// A2UI import — wire contract for POST /api/a2ui/import and `od import a2ui`.
//
// The daemon turns an A2UI 1.0 agent-to-renderer message stream into a
// design-system-styled HTML artifact. Only A2UI 1.0 is supported; the
// stream is validated against the pinned A2UI 1.0 JSON Schemas vendored
// under apps/daemon/src/a2ui/vendor/a2ui-v1_0 (see its provenance.json).

/** Typed failure codes. Unknown input is rejected, never guessed. */
export type A2uiImportErrorCode =
  | 'A2UI-V1-STREAM-MALFORMED'
  | 'A2UI-V1-VERSION'
  | 'A2UI-V1-SCHEMA'
  | 'A2UI-V1-MESSAGE-UNSUPPORTED'
  | 'A2UI-V1-SURFACE-UNKNOWN'
  | 'A2UI-V1-SURFACE-DUPLICATE'
  | 'A2UI-V1-CATALOG-UNKNOWN'
  | 'A2UI-V1-COMPONENT-UNKNOWN'
  | 'A2UI-V1-ID-DUPLICATE'
  | 'A2UI-V1-ROOT-MISSING'
  | 'A2UI-V1-CHILD-DANGLING'
  | 'A2UI-V1-CYCLE'
  | 'A2UI-V1-DESIGN-SYSTEM-UNKNOWN'
  | 'A2UI-V1-MAPPING-MISSING'
  | 'A2UI-V1-MAPPING-INVALID'
  | 'A2UI-V1-MAPPING-UNMAPPED';

/** Non-fatal observations; the import still succeeds. */
export type A2uiImportWarningCode = 'A2UI-V1-UNREACHABLE' | 'A2UI-V1-URL-REJECTED';

export interface A2uiImportIssue<Code extends string = A2uiImportErrorCode> {
  code: Code;
  /** Location in the stream, e.g. `$[1].updateComponents.components[0].text`. */
  path: string;
  message: string;
}

export interface A2uiImportedSurface {
  surfaceId: string;
  catalogId: string;
  deleted: boolean;
  /** Sorted ids of every component the surface held at the end of the stream. */
  componentIds: string[];
}

export interface A2uiImportRequest {
  /** The message stream: JSON array, `{ messages: [...] }`, or JSON Lines text. */
  stream: string | unknown[];
  designSystemId: string;
}

export interface A2uiImportSuccess {
  ok: true;
  a2uiVersion: '1.0';
  designSystemId: string;
  html: string;
  surfaces: A2uiImportedSurface[];
  warnings: A2uiImportIssue<A2uiImportWarningCode>[];
}

export interface A2uiImportFailure {
  ok: false;
  a2uiVersion: '1.0';
  designSystemId: string;
  errors: A2uiImportIssue[];
  warnings: A2uiImportIssue<A2uiImportWarningCode>[];
}

export type A2uiImportResult = A2uiImportSuccess | A2uiImportFailure;

/**
 * Per-design-system mapping, declared in `<design-system>/a2ui.mapping.json`.
 * The importer owns element semantics (a Button is a <button>, a TextField
 * is a labelled <input>); the mapping supplies the design system's classes.
 */
export interface A2uiComponentMapping {
  class: string;
  /** Class override per A2UI `variant` value. */
  variants?: Record<string, string>;
}

export interface A2uiDesignSystemMapping {
  schema: 'open-design/a2ui-mapping/v1';
  a2uiVersion: '1.0';
  catalogId: string;
  components: Record<string, A2uiComponentMapping>;
}
