/**
 * A2UI 1.0 import: an agent-to-renderer message stream in, a
 * design-system-styled HTML artifact out.
 *
 * Pipeline:
 *   1. parse   — JSON array, `{ messages: [...] }` sample object, or JSON Lines.
 *   2. check   — per message: protocol version, importable message kind,
 *                catalog and component names (typed errors, never guessed),
 *                then full JSON Schema validation against the pinned A2UI 1.0
 *                schemas vendored in ./vendor/a2ui-v1_0 (offline).
 *   3. replay  — createSurface / updateComponents / updateDataModel /
 *                deleteSurface applied in order to per-surface state.
 *   4. tree    — every live surface: `root` present, no dangling child, no
 *                cycle; unreachable components are a warning.
 *   5. render  — the flat adjacency list (root, children by id) becomes
 *                semantic HTML. Element semantics are fixed here (a Button
 *                is a <button>, a TextField a labelled <input>); classes
 *                come from the design system's declared `a2ui.mapping.json`,
 *                and its tokens.css + component styles are inlined. Every
 *                component keeps its id as `data-a2ui-id`, and actions keep
 *                their target as `data-a2ui-action` / `data-a2ui-function`.
 *
 * No step performs I/O except `loadA2uiDesignSystem`, which reads the design
 * system's own files from disk. Nothing is fetched over the network.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  A2uiDesignSystemMapping,
  A2uiImportErrorCode,
  A2uiImportIssue,
  A2uiImportResult,
  A2uiImportWarningCode,
  A2uiImportedSurface,
} from '@open-design/contracts';

import basicCatalog from './vendor/a2ui-v1_0/catalogs/basic/v1/catalog.json' with { type: 'json' };
import agentToRenderer from './vendor/a2ui-v1_0/specification/v1_0/json/agent_to_renderer.json' with { type: 'json' };
import commonTypes from './vendor/a2ui-v1_0/specification/v1_0/json/common_types.json' with { type: 'json' };
import { SchemaRegistry } from './json-schema.js';

export const A2UI_VERSION = '1.0' as const;
export const A2UI_BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
/** Upstream pin of the vendored schemas; keep in sync with vendor/a2ui-v1_0/provenance.json. */
export const A2UI_SCHEMA_PIN = {
  a2uiVersion: A2UI_VERSION,
  repository: 'https://github.com/a2ui-project/a2ui',
  commit: '172cf31e1acbce31c4e60d82b2edbd923b279dd8',
} as const;
export const A2UI_MAPPING_FILE = 'a2ui.mapping.json';

const SPEC_BASE = 'https://a2ui.org/specification/v1_0/';
const MESSAGE_SCHEMA = `${SPEC_BASE}agent_to_renderer.json`;
const IMPORTABLE = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'] as const;
const NOT_IMPORTABLE = ['callRendererFunction', 'agentFunctionResponse'];
type MessageKind = (typeof IMPORTABLE)[number];

export interface A2uiDesignSystem {
  id: string;
  mapping: A2uiDesignSystemMapping;
  tokensCss: string;
  componentsCss: string;
}

type Issue = A2uiImportIssue;
type Warning = A2uiImportIssue<A2uiImportWarningCode>;
type Component = Record<string, unknown> & { id: string; component: string };
type ChildSlot = { prop: string; kind: 'child' | 'children' | 'items'; itemKey?: string };

interface CatalogInfo {
  id: string;
  components: Map<string, ChildSlot[]>;
}

interface Surface {
  id: string;
  catalogId: string;
  components: Map<string, Component>;
  where: Map<string, string>;
  dataModel: unknown;
  deleted: boolean;
  createdAt: string;
}

// ── Catalog + schema registry ─────────────────────────────────────────

const BASIC_CATALOG = describeCatalog(basicCatalog as Record<string, unknown>);

function describeCatalog(doc: Record<string, unknown>): CatalogInfo {
  const components = new Map<string, ChildSlot[]>();
  const defs = (doc.components ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, schema] of Object.entries(defs)) {
    const parts = [schema, ...(((schema.allOf as unknown[]) ?? []) as Record<string, unknown>[])];
    const slots: ChildSlot[] = [];
    for (const part of parts) {
      const props = (part.properties ?? {}) as Record<string, Record<string, unknown>>;
      for (const [prop, ps] of Object.entries(props)) {
        const ref = typeof ps.$ref === 'string' ? ps.$ref : '';
        if (ref.endsWith('/$defs/Child')) slots.push({ prop, kind: 'child' });
        else if (ref.endsWith('/$defs/ChildList')) slots.push({ prop, kind: 'children' });
        else if (ps.type === 'array' && typeof ps.items === 'object' && ps.items) {
          const itemProps = ((ps.items as Record<string, unknown>).properties ?? {}) as Record<string, Record<string, unknown>>;
          for (const [key, sub] of Object.entries(itemProps)) {
            if (typeof sub.$ref === 'string' && sub.$ref.endsWith('/$defs/Child')) slots.push({ prop, kind: 'items', itemKey: key });
          }
        }
      }
    }
    components.set(name, slots);
  }
  return { id: String(doc.catalogId ?? doc.$id ?? ''), components };
}

let registry: SchemaRegistry | null = null;
function schemaRegistry(): SchemaRegistry {
  if (registry) return registry;
  const catalogUri = String((basicCatalog as { $id?: string }).$id ?? A2UI_BASIC_CATALOG_ID);
  registry = new SchemaRegistry()
    .add(MESSAGE_SCHEMA, agentToRenderer as Record<string, unknown>)
    .add(`${SPEC_BASE}common_types.json`, commonTypes as Record<string, unknown>)
    // `catalog.json` in the message schema is the placeholder for the
    // surface's active catalog; only the Basic Catalog is loaded.
    .add(`${SPEC_BASE}catalog.json`, basicCatalog as Record<string, unknown>)
    .add(catalogUri, basicCatalog as Record<string, unknown>)
    // The catalog's own `$id` moves relative refs under catalogs/basic/.
    .add(new URL('common_types.json', catalogUri).href, commonTypes as Record<string, unknown>);
  return registry;
}

const CATALOGS = new Map<string, CatalogInfo>([[A2UI_BASIC_CATALOG_ID, BASIC_CATALOG]]);

// ── Parse ─────────────────────────────────────────────────────────────

export function parseA2uiStream(
  text: string,
): { ok: true; messages: unknown[] } | { ok: false; error: Issue } {
  const malformed = (message: string) => ({
    ok: false as const,
    error: { code: 'A2UI-V1-STREAM-MALFORMED' as const, path: '$', message },
  });
  const trimmed = text.trim();
  if (!trimmed) return malformed('empty input');
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
    const messages: unknown[] = [];
    for (const [i, line] of lines.entries()) {
      try {
        messages.push(JSON.parse(line));
      } catch (err) {
        return malformed(`line ${i + 1} is neither JSON nor JSON Lines: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ok: true, messages };
  }
  if (isObject(value) && Array.isArray(value.messages)) return { ok: true, messages: value.messages };
  if (isObject(value)) return { ok: true, messages: [value] };
  if (Array.isArray(value)) return { ok: true, messages: value };
  return malformed('the stream is not a list of messages');
}

// ── Import ────────────────────────────────────────────────────────────

export function importA2ui(input: string | unknown[], designSystem: A2uiDesignSystem): A2uiImportResult {
  const base = { a2uiVersion: A2UI_VERSION, designSystemId: designSystem.id };
  const errors: Issue[] = [];
  const warnings: Warning[] = [];
  let messages: unknown[];
  if (typeof input === 'string') {
    const parsed = parseA2uiStream(input);
    if (!parsed.ok) return { ok: false, ...base, errors: [parsed.error], warnings };
    messages = parsed.messages;
  } else {
    messages = input;
  }

  const mappingProblem = checkMapping(designSystem.mapping);
  if (mappingProblem) return { ok: false, ...base, errors: [mappingProblem], warnings };

  const surfaces = new Map<string, Surface>();
  messages.forEach((message, i) => replay(message, `$[${i}]`, surfaces, errors));

  for (const surface of surfaces.values()) {
    if (surface.deleted) continue;
    checkTree(surface, errors, warnings);
    for (const [cid, comp] of surface.components) {
      if (!designSystem.mapping.components[comp.component]) {
        errors.push(issue('A2UI-V1-MAPPING-UNMAPPED', surface.where.get(cid) ?? '$',
          `${cid}: design system "${designSystem.id}" declares no mapping for A2UI component ${comp.component}`));
      }
    }
  }

  if (errors.length > 0) return { ok: false, ...base, errors, warnings };

  const summary: A2uiImportedSurface[] = Array.from(surfaces.values()).map((s) => ({
    surfaceId: s.id,
    catalogId: s.catalogId,
    deleted: s.deleted,
    componentIds: Array.from(s.components.keys()).sort(),
  }));
  const html = renderDocument(Array.from(surfaces.values()).filter((s) => !s.deleted), designSystem, warnings);
  return { ok: true, ...base, html, surfaces: summary, warnings };
}

function issue(code: A2uiImportErrorCode, path: string, message: string): Issue {
  return { code, path, message };
}

function checkMapping(mapping: unknown): Issue | null {
  const bad = (message: string) => issue('A2UI-V1-MAPPING-INVALID', '$mapping', message);
  if (!isObject(mapping)) return bad('mapping is not an object');
  if (mapping.schema !== 'open-design/a2ui-mapping/v1') return bad('mapping.schema must be "open-design/a2ui-mapping/v1"');
  if (mapping.a2uiVersion !== A2UI_VERSION) return bad(`mapping.a2uiVersion must be "${A2UI_VERSION}"`);
  if (typeof mapping.catalogId !== 'string' || !CATALOGS.has(mapping.catalogId)) {
    return bad(`mapping.catalogId ${JSON.stringify(mapping.catalogId)} is not a loaded catalog`);
  }
  if (!isObject(mapping.components)) return bad('mapping.components must be an object');
  const catalog = CATALOGS.get(mapping.catalogId)!;
  for (const [name, entry] of Object.entries(mapping.components)) {
    if (!catalog.components.has(name)) return bad(`mapping.components.${name} is not a component of ${catalog.id}`);
    if (!isObject(entry) || typeof entry.class !== 'string') return bad(`mapping.components.${name}.class must be a string`);
    if (entry.variants !== undefined) {
      if (!isObject(entry.variants) || Object.values(entry.variants).some((v) => typeof v !== 'string')) {
        return bad(`mapping.components.${name}.variants must map variant names to class strings`);
      }
    }
  }
  return null;
}

function replay(message: unknown, where: string, surfaces: Map<string, Surface>, errors: Issue[]): void {
  if (!isObject(message)) {
    errors.push(issue('A2UI-V1-STREAM-MALFORMED', where, 'a message is not an object'));
    return;
  }
  if (message.version !== A2UI_VERSION) {
    errors.push(issue('A2UI-V1-VERSION', `${where}.version`,
      `version ${JSON.stringify(message.version)} is not "${A2UI_VERSION}"; only A2UI ${A2UI_VERSION} is supported`));
    return;
  }
  const keys = Object.keys(message).filter((k) => k !== 'version');
  const unsupported = keys.find((k) => NOT_IMPORTABLE.includes(k));
  if (unsupported) {
    errors.push(issue('A2UI-V1-MESSAGE-UNSUPPORTED', `${where}.${unsupported}`,
      `${unsupported} is a runtime message; a static import supports ${IMPORTABLE.join(', ')}`));
    return;
  }
  const kind = keys.find((k): k is MessageKind => (IMPORTABLE as readonly string[]).includes(k));
  const body = kind ? message[kind] : undefined;
  const at = kind ? `${where}.${kind}` : where;
  const before = errors.length;

  // Catalog and component names first: a clear typed error beats the
  // schema's "matches no oneOf branch" for an unknown component.
  const surfaceId = isObject(body) && typeof body.surfaceId === 'string' ? body.surfaceId : null;
  const live = surfaceId !== null ? surfaces.get(surfaceId) : undefined;
  const liveSurface = live && !live.deleted ? live : undefined;
  let catalogId = A2UI_BASIC_CATALOG_ID;
  if (kind === 'createSurface' && isObject(body) && body.catalogId !== undefined) {
    if (typeof body.catalogId !== 'string' || !CATALOGS.has(body.catalogId)) {
      errors.push(issue('A2UI-V1-CATALOG-UNKNOWN', `${at}.catalogId`,
        `catalog ${JSON.stringify(body.catalogId)} is not loaded; supported: ${Array.from(CATALOGS.keys()).join(', ')}`));
    } else {
      catalogId = body.catalogId;
    }
  } else if (kind === 'updateComponents' && liveSurface) {
    catalogId = liveSurface.catalogId;
  }
  if ((kind === 'createSurface' || kind === 'updateComponents') && isObject(body) && Array.isArray(body.components)) {
    checkComponentNames(body.components, `${at}.components`, catalogId, errors);
  }
  if (errors.length === before) {
    for (const e of schemaRegistry().validate(MESSAGE_SCHEMA, message, where)) {
      errors.push(issue('A2UI-V1-SCHEMA', e.path, e.message));
    }
  }
  const valid = errors.length === before;
  if (!kind || !isObject(body) || surfaceId === null) return;

  switch (kind) {
    case 'createSurface': {
      if (liveSurface) {
        errors.push(issue('A2UI-V1-SURFACE-DUPLICATE', at, `surface ${JSON.stringify(surfaceId)} already exists`));
        return;
      }
      const surface: Surface = {
        id: surfaceId, catalogId, components: new Map(), where: new Map(),
        dataModel: {}, deleted: false, createdAt: at,
      };
      surfaces.set(surfaceId, surface);
      if (!valid) return;
      if (Array.isArray(body.components)) mergeComponents(surface, body.components, `${at}.components`, errors);
      if (isObject(body.dataModel)) surface.dataModel = structuredClone(body.dataModel);
      return;
    }
    case 'updateComponents':
    case 'updateDataModel':
    case 'deleteSurface': {
      if (!liveSurface) {
        errors.push(issue('A2UI-V1-SURFACE-UNKNOWN', `${at}.surfaceId`,
          `surface ${JSON.stringify(surfaceId)} was not created (or was deleted) before ${kind}`));
        return;
      }
      if (!valid) return;
      if (kind === 'updateComponents') mergeComponents(liveSurface, body.components as unknown[], `${at}.components`, errors);
      else if (kind === 'updateDataModel') {
        liveSurface.dataModel = setPointer(liveSurface.dataModel, typeof body.path === 'string' ? body.path : '/', body.value);
      } else liveSurface.deleted = true;
    }
  }
}

function checkComponentNames(components: unknown[], at: string, catalogId: string, errors: Issue[]): void {
  components.forEach((comp, i) => {
    if (!isObject(comp)) return;
    const where = `${at}[${i}]`;
    const own = comp['@catalogId'];
    const effective = typeof own === 'string' ? own : catalogId;
    const catalog = CATALOGS.get(effective);
    if (!catalog) {
      errors.push(issue('A2UI-V1-CATALOG-UNKNOWN', `${where}.@catalogId`, `catalog ${JSON.stringify(effective)} is not loaded`));
      return;
    }
    const name = comp.component;
    if (typeof name !== 'string' || name === 'Surface' || !catalog.components.has(name)) {
      errors.push(issue('A2UI-V1-COMPONENT-UNKNOWN', `${where}.component`,
        `component ${JSON.stringify(name)} is not defined by ${catalog.id}`));
    }
  });
}

function mergeComponents(surface: Surface, components: unknown[], at: string, errors: Issue[]): void {
  const seen = new Set<string>();
  components.forEach((comp, i) => {
    const c = comp as Component;
    const where = `${at}[${i}]`;
    if (seen.has(c.id)) {
      errors.push(issue('A2UI-V1-ID-DUPLICATE', `${where}.id`, `id ${JSON.stringify(c.id)} appears twice in one components list`));
      return;
    }
    seen.add(c.id);
    surface.components.set(c.id, c);
    surface.where.set(c.id, where);
  });
}

// ── Tree checks ───────────────────────────────────────────────────────

function childRefs(comp: Component): Array<{ slot: string; id: string; template: boolean }> {
  const slots = CATALOGS.get(effectiveCatalog(comp))?.components.get(comp.component) ?? [];
  const out: Array<{ slot: string; id: string; template: boolean }> = [];
  for (const slot of slots) {
    const value = comp[slot.prop];
    if (slot.kind === 'child' && typeof value === 'string') out.push({ slot: slot.prop, id: value, template: false });
    else if (slot.kind === 'children' && Array.isArray(value)) {
      value.forEach((v, i) => typeof v === 'string' && out.push({ slot: `${slot.prop}[${i}]`, id: v, template: false }));
    } else if (slot.kind === 'children' && isObject(value) && typeof value.componentId === 'string') {
      out.push({ slot: `${slot.prop}.componentId`, id: value.componentId, template: true });
    } else if (slot.kind === 'items' && Array.isArray(value) && slot.itemKey) {
      value.forEach((item, i) => {
        const id = isObject(item) ? item[slot.itemKey!] : undefined;
        if (typeof id === 'string') out.push({ slot: `${slot.prop}[${i}].${slot.itemKey}`, id, template: false });
      });
    }
  }
  return out;
}

function effectiveCatalog(comp: Component): string {
  return typeof comp['@catalogId'] === 'string' ? (comp['@catalogId'] as string) : A2UI_BASIC_CATALOG_ID;
}

function checkTree(surface: Surface, errors: Issue[], warnings: Warning[]): void {
  if (surface.components.size === 0) return;
  if (!surface.components.has('root')) {
    errors.push(issue('A2UI-V1-ROOT-MISSING', surface.createdAt, `surface ${JSON.stringify(surface.id)} has no component with id "root"`));
  }
  const edges = new Map<string, string[]>();
  for (const [cid, comp] of surface.components) {
    const list: string[] = [];
    for (const ref of childRefs(comp)) {
      if (!surface.components.has(ref.id)) {
        errors.push(issue('A2UI-V1-CHILD-DANGLING', `${surface.where.get(cid)}.${ref.slot}`,
          `${cid} references missing component ${JSON.stringify(ref.id)}`));
      } else {
        list.push(ref.id);
      }
    }
    edges.set(cid, list);
  }
  // Iterative DFS over every start node so cycles off the root are found too.
  const state = new Map<string, 1 | 2>();
  const reached = new Set<string>();
  const starts = surface.components.has('root') ? ['root', ...surface.components.keys()] : [...surface.components.keys()];
  for (const start of starts) {
    if (state.has(start)) continue;
    const fromRoot = start === 'root';
    state.set(start, 1);
    if (fromRoot) reached.add(start);
    const stack: Array<[string, string[]]> = [[start, [...(edges.get(start) ?? [])]]];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const next = top[1].shift();
      if (next === undefined) {
        state.set(top[0], 2);
        stack.pop();
      } else if (state.get(next) === 1) {
        errors.push(issue('A2UI-V1-CYCLE', surface.where.get(top[0]) ?? surface.createdAt, `${top[0]} -> ${next} closes a cycle`));
      } else if (!state.has(next)) {
        state.set(next, 1);
        if (fromRoot) reached.add(next);
        stack.push([next, [...(edges.get(next) ?? [])]]);
      }
    }
  }
  if (surface.components.has('root')) {
    for (const cid of surface.components.keys()) {
      if (!reached.has(cid)) {
        warnings.push({ code: 'A2UI-V1-UNREACHABLE', path: surface.where.get(cid) ?? '$', message: `${cid} is never reached from root` });
      }
    }
  }
}

// ── Data model ────────────────────────────────────────────────────────

function pointerTokens(p: string): string[] {
  return p.replace(/^\/+/, '').split('/').filter((t) => t !== '').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getPointer(model: unknown, p: string): unknown {
  let node = model;
  for (const t of pointerTokens(p)) {
    if (Array.isArray(node)) node = node[Number(t)];
    else if (isObject(node)) node = node[t];
    else return undefined;
  }
  return node;
}

function setPointer(model: unknown, p: string, value: unknown): unknown {
  const tokens = pointerTokens(p);
  if (tokens.length === 0) return value === null ? {} : structuredClone(value);
  const root = isObject(model) || Array.isArray(model) ? model : {};
  let node: Record<string, unknown> | unknown[] = root as Record<string, unknown>;
  for (const t of tokens.slice(0, -1)) {
    const container = node as Record<string, unknown>;
    if (!isObject(container[t]) && !Array.isArray(container[t])) container[t] = {};
    node = container[t] as Record<string, unknown>;
  }
  const last = tokens[tokens.length - 1]!;
  const target = node as Record<string, unknown>;
  if (value === null) delete target[last];
  else target[last] = structuredClone(value);
  return root;
}

// ── Render ────────────────────────────────────────────────────────────

interface Ctx {
  surface: Surface;
  ds: A2uiDesignSystem;
  warnings: Warning[];
  scope: string;
  /** Inside phrasing-only content (a <button>): text renders as <span>. */
  inline: boolean;
}

type Resolved = { text: string; path?: string; call?: string };

function resolveDynamic(value: unknown, ctx: Ctx): Resolved {
  if (typeof value === 'string') return { text: value };
  if (typeof value === 'number' || typeof value === 'boolean') return { text: String(value) };
  if (isObject(value) && typeof value['@path'] === 'string') {
    const raw = value['@path'];
    const abs = raw.startsWith('/') ? raw : `${ctx.scope}/${raw}`;
    const v = getPointer(ctx.surface.dataModel, abs);
    const text = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return { text, path: abs };
  }
  if (isObject(value) && typeof value['@call'] === 'string') return { text: '', call: value['@call'] };
  return { text: '' };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function attrs(list: Array<[string, string | number | boolean | null | undefined]>): string {
  return list
    .filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(String(v))}"`))
    .join('');
}

function safeUrl(raw: string, ctx: Ctx, where: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (/^(https?:|data:image\/|\/|\.\/|\.\.\/|#)/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  ctx.warnings.push({ code: 'A2UI-V1-URL-REJECTED', path: where, message: `URL scheme of ${JSON.stringify(url.slice(0, 40))} is not allowed; the attribute was dropped` });
  return null;
}

const JUSTIFY: Record<string, string> = {
  start: 'flex-start', center: 'center', end: 'flex-end', spaceBetween: 'space-between',
  spaceAround: 'space-around', spaceEvenly: 'space-evenly', stretch: 'stretch',
};
const ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };

function classFor(comp: Component, ds: A2uiDesignSystem): string {
  const entry = ds.mapping.components[comp.component];
  const variant = typeof comp.variant === 'string' ? entry?.variants?.[comp.variant] : undefined;
  return variant ?? entry?.class ?? '';
}

function baseAttrs(comp: Component, ctx: Ctx, extra: Array<[string, string | number | boolean | null | undefined]> = []) {
  const a11y = isObject(comp['@accessibility']) ? comp['@accessibility'] : {};
  const label = a11y.label !== undefined ? resolveDynamic(a11y.label, ctx).text : '';
  const description = a11y.description !== undefined ? resolveDynamic(a11y.description, ctx).text : '';
  const hidden = a11y.hidden === true;
  const live = typeof a11y.live === 'string' && a11y.live !== 'off' ? a11y.live : null;
  const styles: string[] = [];
  if (typeof comp.weight === 'number') styles.push(`flex-grow: ${comp.weight}`);
  const cls = classFor(comp, ctx.ds);
  return attrs([
    ['data-a2ui-id', comp.id],
    ['data-a2ui-component', comp.component],
    ['class', cls || null],
    ['aria-label', label || null],
    ['aria-description', description || null],
    ['aria-hidden', hidden ? 'true' : null],
    ['aria-live', live],
    ...extra,
    ['style', styles.length > 0 ? styles.join('; ') : null],
  ]);
}

function renderChild(id: unknown, ctx: Ctx, stack: Set<string>): string {
  if (typeof id !== 'string') return '';
  const comp = ctx.surface.components.get(id);
  if (!comp || stack.has(id)) return '';
  stack.add(id);
  try {
    return renderComponent(comp, ctx, stack);
  } finally {
    stack.delete(id);
  }
}

function renderChildren(value: unknown, ctx: Ctx, stack: Set<string>, wrap?: (html: string) => string): string {
  const w = wrap ?? ((h: string) => h);
  if (Array.isArray(value)) return value.map((id) => w(renderChild(id, ctx, stack))).join('');
  if (isObject(value) && typeof value.componentId === 'string' && typeof value.path === 'string') {
    const listPath = value.path.startsWith('/') ? value.path : `${ctx.scope}/${value.path}`;
    const list = getPointer(ctx.surface.dataModel, listPath);
    const items = Array.isArray(list) ? list : [];
    if (items.length === 0) {
      const tpl = renderChild(value.componentId, { ...ctx, scope: `${listPath}/0` }, stack);
      return `<template data-a2ui-template="${esc(value.componentId)}">${tpl}</template>`;
    }
    return items
      .map((_item, i) => w(renderChild(value.componentId, { ...ctx, scope: `${listPath}/${i}` }, stack)
        .replace(/^(<[a-z0-9]+)/i, `$1 data-a2ui-index="${i}"`)))
      .join('');
  }
  return '';
}

function renderComponent(comp: Component, ctx: Ctx, stack: Set<string>): string {
  const at = ctx.surface.where.get(comp.id) ?? '$';
  switch (comp.component) {
    case 'Text': {
      const r = resolveDynamic(comp.text, ctx);
      const heading = /^(#{1,6})\s+(.+)$/.exec(r.text.trim());
      const tag = ctx.inline ? 'span' : heading ? `h${heading[1]!.length}` : 'p';
      const body = heading ? heading[2]! : r.text;
      return `<${tag}${baseAttrs(comp, ctx, [['data-a2ui-path', r.path], ['data-a2ui-call', r.call]])}>${esc(body)}</${tag}>`;
    }
    case 'Image': {
      const src = safeUrl(resolveDynamic(comp.url, ctx).text, ctx, `${at}.url`);
      const alt = comp.description !== undefined ? resolveDynamic(comp.description, ctx).text : '';
      const fit = typeof comp.fit === 'string' ? comp.fit.replace('scaleDown', 'scale-down') : null;
      return `<img${baseAttrs(comp, ctx, [['src', src], ['alt', alt], ['data-a2ui-variant', comp.variant as string | undefined], ['data-a2ui-fit', fit]])}>`;
    }
    case 'Icon': {
      const name = comp.name;
      if (isObject(name) && name.svgPath !== undefined) {
        const d = resolveDynamic(name.svgPath, ctx).text;
        return `<span${baseAttrs(comp, ctx)}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${esc(d)}"/></svg></span>`;
      }
      const icon = resolveDynamic(name, ctx);
      return `<span${baseAttrs(comp, ctx, [['data-a2ui-icon', icon.text || null], ['data-a2ui-path', icon.path]])}></span>`;
    }
    case 'Video': {
      const src = safeUrl(resolveDynamic(comp.url, ctx).text, ctx, `${at}.url`);
      const poster = comp.posterUrl !== undefined ? safeUrl(resolveDynamic(comp.posterUrl, ctx).text, ctx, `${at}.posterUrl`) : null;
      return `<video${baseAttrs(comp, ctx, [['controls', true], ['src', src], ['poster', poster]])}></video>`;
    }
    case 'AudioPlayer': {
      const src = safeUrl(resolveDynamic(comp.url, ctx).text, ctx, `${at}.url`);
      const label = comp.description !== undefined ? resolveDynamic(comp.description, ctx).text : '';
      return `<audio${baseAttrs(comp, ctx, [['controls', true], ['src', src], ['title', label || null]])}></audio>`;
    }
    case 'Row':
    case 'Column': {
      const style = flexStyle(comp);
      return `<div${baseAttrs(comp, ctx, [['data-a2ui-layout', style || null]])}>${renderChildren(comp.children, ctx, stack)}</div>`;
    }
    case 'List': {
      const direction = comp.direction === 'horizontal' ? 'horizontal' : 'vertical';
      const inner = renderChildren(comp.children, ctx, stack, (h) => `<div role="listitem">${h}</div>`);
      return `<div${baseAttrs(comp, ctx, [['role', 'list'], ['data-a2ui-direction', direction], ['data-a2ui-align', comp.align as string | undefined]])}>${inner}</div>`;
    }
    case 'Card':
      return `<article${baseAttrs(comp, ctx)}>${renderChild(comp.child, ctx, stack)}</article>`;
    case 'Tabs': {
      const tabs = Array.isArray(comp.tabs) ? comp.tabs.filter(isObject) : [];
      const head = tabs.map((t, i) => `<button type="button" role="tab" id="${esc(`${comp.id}-tab-${i}`)}" aria-controls="${esc(`${comp.id}-panel-${i}`)}" aria-selected="${i === 0}">${esc(resolveDynamic(t.title, ctx).text)}</button>`).join('');
      const panels = tabs.map((t, i) => `<div role="tabpanel" id="${esc(`${comp.id}-panel-${i}`)}" aria-labelledby="${esc(`${comp.id}-tab-${i}`)}"${i === 0 ? '' : ' hidden'}>${renderChild(t.child, ctx, stack)}</div>`).join('');
      return `<div${baseAttrs(comp, ctx)}><div role="tablist">${head}</div>${panels}</div>`;
    }
    case 'Modal':
      return `<div${baseAttrs(comp, ctx)}>${renderChild(comp.trigger, ctx, stack)}<dialog data-a2ui-modal-content>${renderChild(comp.content, ctx, stack)}</dialog></div>`;
    case 'Divider':
      return `<hr${baseAttrs(comp, ctx, [['aria-orientation', comp.axis === 'vertical' ? 'vertical' : null]])}>`;
    case 'Button': {
      const action = isObject(comp.action) ? comp.action : {};
      const event = isObject(action.event) ? action.event : null;
      const fn = isObject(action.functionCall) ? action.functionCall : null;
      return `<button${baseAttrs(comp, ctx, [
        ['type', 'button'],
        ['data-a2ui-action', event && typeof event.name === 'string' ? event.name : null],
        ['data-a2ui-action-context', event && isObject(event.context) ? JSON.stringify(event.context) : null],
        ['data-a2ui-function', fn && typeof fn['@call'] === 'string' ? fn['@call'] : null],
        ['data-a2ui-variant', comp.variant as string | undefined],
      ])}>${renderChild(comp.child, { ...ctx, inline: true }, stack)}</button>`;
    }
    case 'TextField': {
      const label = resolveDynamic(comp.label, ctx).text;
      const value = resolveDynamic(comp.value, ctx);
      const placeholder = comp.placeholder !== undefined ? resolveDynamic(comp.placeholder, ctx).text : '';
      const variant = typeof comp.variant === 'string' ? comp.variant : 'shortText';
      const field = variant === 'longText'
        ? `<textarea${attrs([['placeholder', placeholder || null], ['data-a2ui-path', value.path]])}>${esc(value.text)}</textarea>`
        : `<input${attrs([
          ['type', variant === 'obscured' ? 'password' : variant === 'number' ? 'number' : 'text'],
          ['value', value.text || null],
          ['placeholder', placeholder || null],
          ['data-a2ui-path', value.path],
        ])}>`;
      return `<label${baseAttrs(comp, ctx)}><span>${esc(label)}</span>${field}</label>`;
    }
    case 'CheckBox': {
      const label = resolveDynamic(comp.label, ctx).text;
      const value = resolveDynamic(comp.value, ctx);
      return `<label${baseAttrs(comp, ctx)}><input${attrs([['type', 'checkbox'], ['checked', value.text === 'true'], ['data-a2ui-path', value.path]])}><span>${esc(label)}</span></label>`;
    }
    case 'ChoicePicker': {
      const label = comp.label !== undefined ? resolveDynamic(comp.label, ctx).text : '';
      const multiple = comp.variant === 'multipleSelection';
      const selected = selectedValues(comp.value, ctx);
      const options = (Array.isArray(comp.options) ? comp.options : []).filter(isObject).map((o) => {
        const v = typeof o.value === 'string' ? o.value : '';
        return `<label><input${attrs([['type', multiple ? 'checkbox' : 'radio'], ['name', comp.id], ['value', v], ['checked', selected.includes(v)]])}><span>${esc(resolveDynamic(o.label, ctx).text)}</span></label>`;
      }).join('');
      return `<fieldset${baseAttrs(comp, ctx, [['data-a2ui-display', comp.displayStyle as string | undefined]])}>${label ? `<legend>${esc(label)}</legend>` : ''}${options}</fieldset>`;
    }
    case 'Slider': {
      const label = comp.label !== undefined ? resolveDynamic(comp.label, ctx).text : '';
      const value = resolveDynamic(comp.value, ctx);
      const min = typeof comp.min === 'number' ? comp.min : 0;
      const max = typeof comp.max === 'number' ? comp.max : 100;
      const step = typeof comp.steps === 'number' && comp.steps > 0 ? (max - min) / comp.steps : null;
      const input = `<input${attrs([['type', 'range'], ['min', min], ['max', max], ['step', step], ['value', value.text || null], ['data-a2ui-path', value.path]])}>`;
      return `<label${baseAttrs(comp, ctx)}><span>${esc(label)}</span>${input}</label>`;
    }
    case 'DateTimeInput': {
      const label = comp.label !== undefined ? resolveDynamic(comp.label, ctx).text : '';
      const value = resolveDynamic(comp.value, ctx);
      const date = comp.enableDate !== false;
      const time = comp.enableTime === true || comp.enableDate === false;
      const type = date && time ? 'datetime-local' : time ? 'time' : 'date';
      const input = `<input${attrs([['type', type], ['value', value.text || null], ['data-a2ui-path', value.path]])}>`;
      return `<label${baseAttrs(comp, ctx)}><span>${esc(label)}</span>${input}</label>`;
    }
    default:
      return '';
  }
}

function selectedValues(value: unknown, ctx: Ctx): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (isObject(value) && typeof value['@path'] === 'string') {
    const raw = value['@path'];
    const v = getPointer(ctx.surface.dataModel, raw.startsWith('/') ? raw : `${ctx.scope}/${raw}`);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }
  return [];
}

function flexStyle(comp: Component): string {
  const parts: string[] = [];
  if (typeof comp.justify === 'string' && JUSTIFY[comp.justify]) parts.push(`justify-${comp.justify}`);
  if (typeof comp.align === 'string' && ALIGN[comp.align]) parts.push(`align-${comp.align}`);
  return parts.join(' ');
}

const LAYOUT_CSS = [
  '[data-a2ui-component="Row"] { display: flex; flex-direction: row; flex-wrap: wrap; gap: var(--space-3, 12px); }',
  '[data-a2ui-component="Column"] { display: flex; flex-direction: column; gap: var(--space-3, 12px); }',
  '[data-a2ui-component="List"] { display: flex; flex-direction: column; gap: var(--space-2, 8px); }',
  '[data-a2ui-component="List"][data-a2ui-direction="horizontal"] { flex-direction: row; }',
  '[data-a2ui-component="TextField"], [data-a2ui-component="Slider"], [data-a2ui-component="DateTimeInput"] { display: flex; flex-direction: column; gap: var(--space-2, 8px); }',
  ...Object.entries(JUSTIFY).map(([k, v]) => `[data-a2ui-layout~="justify-${k}"] { justify-content: ${v}; }`),
  ...Object.entries(ALIGN).map(([k, v]) => `[data-a2ui-layout~="align-${k}"] { align-items: ${v}; }`),
].join('\n');

function cssBlock(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

function renderDocument(surfaces: Surface[], ds: A2uiDesignSystem, warnings: Warning[]): string {
  const sections = surfaces.map((surface) => {
    const ctx: Ctx = { surface, ds, warnings, scope: '', inline: false };
    const root = surface.components.has('root') ? renderChild('root', ctx, new Set()) : '';
    const reached = new Set(Array.from(root.matchAll(/data-a2ui-id="([^"]*)"/g), (m) => m[1]));
    const orphans = Array.from(surface.components.values())
      .filter((c) => !reached.has(esc(c.id)))
      .map((c) => renderChild(c.id, ctx, new Set()))
      .join('');
    const sectionAttrs = attrs([
      ['data-od-id', `a2ui-surface-${surface.id}`],
      ['data-a2ui-surface', surface.id],
      ['data-a2ui-catalog', surface.catalogId],
    ]);
    return `<section${sectionAttrs}>${root}${orphans ? `<template data-a2ui-unreachable>${orphans}</template>` : ''}</section>`;
  });
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="open-design a2ui-import (A2UI ${A2UI_VERSION}, schemas ${A2UI_SCHEMA_PIN.commit.slice(0, 12)})">`,
    `<title>${esc(`A2UI import — ${ds.id}`)}</title>`,
    `<style data-a2ui-tokens>\n${cssBlock(ds.tokensCss)}\n</style>`,
    `<style data-a2ui-components>\n${cssBlock(ds.componentsCss)}\n</style>`,
    `<style data-a2ui-layout>\n${LAYOUT_CSS}\n</style>`,
    '</head>',
    `<body>`,
    `<main${attrs([['data-a2ui-version', A2UI_VERSION], ['data-design-system', ds.id]])}>`,
    ...sections,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ── Design system loader ──────────────────────────────────────────────

export type LoadA2uiDesignSystemResult = { ok: true; designSystem: A2uiDesignSystem } | { ok: false; error: Issue };

/**
 * Read a design system's A2UI mapping, tokens and component styles from
 * `<root>/<dirId>/`. The id is validated before it touches the filesystem.
 */
export async function loadA2uiDesignSystem(root: string, dirId: string, publicId = dirId): Promise<LoadA2uiDesignSystemResult> {
  const unknown = (message: string): LoadA2uiDesignSystemResult => ({
    ok: false,
    error: issue('A2UI-V1-DESIGN-SYSTEM-UNKNOWN', '$designSystem', message),
  });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dirId) || dirId.includes('..')) return unknown(`invalid design system id ${JSON.stringify(publicId)}`);
  const dir = path.join(root, dirId);
  try {
    if (!(await stat(dir)).isDirectory()) return unknown(`design system ${JSON.stringify(publicId)} not found`);
  } catch {
    return unknown(`design system ${JSON.stringify(publicId)} not found`);
  }
  let mappingText: string;
  try {
    mappingText = await readFile(path.join(dir, A2UI_MAPPING_FILE), 'utf8');
  } catch {
    return {
      ok: false,
      error: issue('A2UI-V1-MAPPING-MISSING', '$designSystem',
        `design system ${JSON.stringify(publicId)} declares no ${A2UI_MAPPING_FILE}; A2UI components are never mapped by guessing`),
    };
  }
  let mapping: unknown;
  try {
    mapping = JSON.parse(mappingText);
  } catch (err) {
    return { ok: false, error: issue('A2UI-V1-MAPPING-INVALID', '$mapping', `${A2UI_MAPPING_FILE} is not JSON: ${err instanceof Error ? err.message : String(err)}`) };
  }
  const problem = checkMapping(mapping);
  if (problem) return { ok: false, error: problem };
  const [tokensCss, fixtureHtml] = await Promise.all([
    readFile(path.join(dir, 'tokens.css'), 'utf8').catch(() => ''),
    readFile(path.join(dir, 'components.html'), 'utf8').catch(() => ''),
  ]);
  const componentsCss = Array.from(fixtureHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi), (m) => (m[1] ?? '').trim()).join('\n\n');
  return {
    ok: true,
    designSystem: { id: publicId, mapping: mapping as A2uiDesignSystemMapping, tokensCss, componentsCss },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
