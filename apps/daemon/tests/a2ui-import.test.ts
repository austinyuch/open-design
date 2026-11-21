// A2UI 1.0 import (WP9): a validated A2UI message stream becomes a
// design-system-styled HTML artifact. Fixtures cover every importable
// message type (createSurface, updateComponents, updateDataModel,
// deleteSurface) in valid and invalid form; invalid streams must fail
// with typed error codes and never produce HTML.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  A2UI_BASIC_CATALOG_ID,
  A2UI_SCHEMA_PIN,
  importA2ui,
  loadA2uiDesignSystem,
  parseA2uiStream,
  type A2uiDesignSystem,
} from '../src/a2ui/import.js';
import type { A2uiComponentMapping, A2uiImportResult } from '@open-design/contracts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'a2ui');
const REPO_DESIGN_SYSTEMS = resolve(here, '../../../design-systems');
const LOGIN_FORM = readFileSync(join(FIXTURES, 'login-form.json'), 'utf8');

const ALL_BASIC = [
  'Text', 'Image', 'Icon', 'Video', 'AudioPlayer', 'Row', 'Column', 'List', 'Card',
  'Tabs', 'Modal', 'Divider', 'Button', 'TextField', 'CheckBox', 'ChoicePicker',
  'Slider', 'DateTimeInput',
];

function testDesignSystem(overrides: Record<string, A2uiComponentMapping> = {}): A2uiDesignSystem {
  const components: A2uiDesignSystem['mapping']['components'] = {};
  for (const name of ALL_BASIC) components[name] = { class: `ds-${name.toLowerCase()}` };
  components.Button = { class: 'btn', variants: { primary: 'btn btn-primary' } };
  return {
    id: 'test-ds',
    mapping: {
      schema: 'open-design/a2ui-mapping/v1',
      a2uiVersion: '1.0',
      catalogId: A2UI_BASIC_CATALOG_ID,
      components: { ...components, ...overrides },
    },
    tokensCss: ':root { --bg: #ffffff; --fg: #111111; }',
    componentsCss: '.btn { color: var(--fg); }',
  };
}

const CREATE = (extra: Record<string, unknown> = {}) => ({
  version: '1.0',
  createSurface: { surfaceId: 's1', catalogId: A2UI_BASIC_CATALOG_ID, ...extra },
});
const UPDATE = (components: unknown[], surfaceId = 's1') => ({
  version: '1.0',
  updateComponents: { surfaceId, components },
});
const TEXT = (id: string, text: unknown) => ({ id, component: 'Text', text });

function errorCodes(result: A2uiImportResult): string[] {
  return result.ok ? [] : result.errors.map((e) => e.code);
}

function a2uiIds(html: string): Set<string> {
  return new Set(Array.from(html.matchAll(/data-a2ui-id="([^"]*)"/g), (m) => m[1] ?? ''));
}

function okHtml(result: A2uiImportResult): string {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  return result.html;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseA2uiStream', () => {
  it('reads a JSON array, a {messages} sample object and JSON Lines', () => {
    const msgs = [CREATE(), UPDATE([TEXT('root', 'Hi')])];
    expect(parseA2uiStream(JSON.stringify(msgs))).toEqual({ ok: true, messages: msgs });
    expect(parseA2uiStream(JSON.stringify({ messages: msgs }))).toEqual({ ok: true, messages: msgs });
    expect(parseA2uiStream(msgs.map((m) => JSON.stringify(m)).join('\n'))).toEqual({ ok: true, messages: msgs });
  });

  it('rejects input that is neither JSON nor JSON Lines with a typed error', () => {
    const out = parseA2uiStream('{"version": "1.0",\nnot json');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('A2UI-V1-STREAM-MALFORMED');
    const empty = parseA2uiStream('   ');
    expect(empty.ok).toBe(false);
  });
});

describe('createSurface', () => {
  it('imports inline components and data model', () => {
    const stream = [
      CREATE({
        components: [
          { id: 'root', component: 'Column', children: ['title', 'name'] },
          TEXT('title', '## Profile'),
          TEXT('name', { '@path': '/user/name' }),
        ],
        dataModel: { user: { name: 'Ada' } },
      }),
    ];
    const result = importA2ui(stream, testDesignSystem());
    const html = okHtml(result);
    expect(html).toContain('data-a2ui-surface="s1"');
    expect(html).toMatch(/<h2[^>]*data-a2ui-id="title"[^>]*>Profile<\/h2>/);
    expect(html).toContain('>Ada<');
    expect(html).toContain('class="ds-column"');
    expect(html).toContain(':root { --bg: #ffffff; --fg: #111111; }');
    if (result.ok) expect(result.surfaces).toEqual([
      { surfaceId: 's1', catalogId: A2UI_BASIC_CATALOG_ID, deleted: false, componentIds: ['name', 'root', 'title'] },
    ]);
  });

  it('fails without a surfaceId (schema), with an unknown catalogId, or on a duplicate surface', () => {
    expect(errorCodes(importA2ui([{ version: '1.0', createSurface: {} }], testDesignSystem()))).toContain('A2UI-V1-SCHEMA');
    const unknownCatalog = importA2ui([{ version: '1.0', createSurface: { surfaceId: 's1', catalogId: 'example.com:mine' } }], testDesignSystem());
    expect(errorCodes(unknownCatalog)).toContain('A2UI-V1-CATALOG-UNKNOWN');
    expect(errorCodes(importA2ui([CREATE(), CREATE()], testDesignSystem()))).toContain('A2UI-V1-SURFACE-DUPLICATE');
  });

  it('rejects a stream whose version is not 1.0', () => {
    const result = importA2ui([{ version: '0.9', createSurface: { surfaceId: 's1' } }], testDesignSystem());
    expect(errorCodes(result)).toContain('A2UI-V1-VERSION');
    expect(result.ok).toBe(false);
    if (!result.ok) expect('html' in result).toBe(false);
  });
});

describe('updateComponents', () => {
  it('imports the upstream login-form example and keeps every component id', () => {
    const result = importA2ui(LOGIN_FORM, testDesignSystem());
    const html = okHtml(result);
    const sample = JSON.parse(LOGIN_FORM) as { messages: Array<{ updateComponents?: { components: Array<{ id: string }> } }> };
    const inputIds = sample.messages.flatMap((m) => m.updateComponents?.components.map((c) => c.id) ?? []);
    expect(inputIds.length).toBeGreaterThan(10);
    const outputIds = a2uiIds(html);
    for (const id of inputIds) expect(outputIds, `missing data-a2ui-id="${id}"`).toContain(id);
    expect(html).toMatch(/<button[^>]*data-a2ui-id="login_btn"[^>]*data-a2ui-action="login"[^>]*><span data-a2ui-id="login_btn_text"[^>]*>Sign in<\/span><\/button>/);
    expect(html).toMatch(/<label[^>]*data-a2ui-id="email_field"[^>]*>[\s\S]*?Email[\s\S]*?<input/);
    expect(html).toMatch(/data-a2ui-id="password_field"[\s\S]*?<input[^>]*type="password"/);
  });

  it('merges later updates by id', () => {
    const result = importA2ui([
      CREATE(),
      UPDATE([{ id: 'root', component: 'Column', children: ['a'] }, TEXT('a', 'first')]),
      UPDATE([TEXT('a', 'second')]),
    ], testDesignSystem());
    const html = okHtml(result);
    expect(html).toContain('second');
    expect(html).not.toContain('first');
  });

  it('rejects unknown components with a typed error instead of guessing', () => {
    const result = importA2ui([CREATE(), UPDATE([{ id: 'root', component: 'Carousel', items: [] }])], testDesignSystem());
    expect(errorCodes(result)).toContain('A2UI-V1-COMPONENT-UNKNOWN');
  });

  it('rejects a mistyped property against the pinned JSON Schema', () => {
    const result = importA2ui([CREATE(), UPDATE([TEXT('root', 5)])], testDesignSystem());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const schema = result.errors.find((e) => e.code === 'A2UI-V1-SCHEMA');
      expect(schema?.path).toBe('$[1].updateComponents.components[0].text');
      expect(schema?.message).toContain('string');
    }
  });

  it('reports a missing required property and an unknown property from the catalog schema', () => {
    const missing = importA2ui([CREATE(), UPDATE([{ id: 'root', component: 'Button', child: 'root' }])], testDesignSystem());
    expect(missing.ok ? [] : missing.errors).toContainEqual(expect.objectContaining({
      code: 'A2UI-V1-SCHEMA', message: expect.stringContaining('action'),
    }));
    const extra = importA2ui([CREATE(), UPDATE([{ id: 'root', component: 'Text', text: 'a', bogus: 1 }])], testDesignSystem());
    expect(extra.ok ? [] : extra.errors).toContainEqual(expect.objectContaining({
      code: 'A2UI-V1-SCHEMA', message: expect.stringContaining('bogus'),
    }));
  });

  it('rejects an update for a surface that was never created', () => {
    expect(errorCodes(importA2ui([UPDATE([TEXT('root', 'x')], 'nope')], testDesignSystem()))).toContain('A2UI-V1-SURFACE-UNKNOWN');
  });

  it('rejects a missing root, a dangling child and a cycle', () => {
    expect(errorCodes(importA2ui([CREATE(), UPDATE([TEXT('a', 'x')])], testDesignSystem()))).toContain('A2UI-V1-ROOT-MISSING');
    expect(errorCodes(importA2ui([CREATE(), UPDATE([{ id: 'root', component: 'Card', child: 'ghost' }])], testDesignSystem())))
      .toContain('A2UI-V1-CHILD-DANGLING');
    expect(errorCodes(importA2ui([CREATE(), UPDATE([
      { id: 'root', component: 'Card', child: 'a' },
      { id: 'a', component: 'Card', child: 'root' },
    ])], testDesignSystem()))).toContain('A2UI-V1-CYCLE');
  });

  it('rejects a duplicate id inside one components list', () => {
    expect(errorCodes(importA2ui([CREATE(), UPDATE([TEXT('root', 'a'), TEXT('root', 'b')])], testDesignSystem())))
      .toContain('A2UI-V1-ID-DUPLICATE');
  });

  it('rejects a component that the design system does not map', () => {
    const ds = testDesignSystem();
    delete ds.mapping.components.Slider;
    const result = importA2ui([CREATE(), UPDATE([{ id: 'root', component: 'Slider', max: 10, value: 3 }])], ds);
    expect(errorCodes(result)).toContain('A2UI-V1-MAPPING-UNMAPPED');
  });
});

describe('updateDataModel', () => {
  it('applies whole-model and path updates before rendering', () => {
    const result = importA2ui([
      CREATE(),
      UPDATE([
        { id: 'root', component: 'Column', children: ['greeting', 'city'] },
        TEXT('greeting', { '@path': '/user/name' }),
        TEXT('city', { '@path': '/user/city' }),
      ]),
      { version: '1.0', updateDataModel: { surfaceId: 's1', value: { user: { name: 'Ada', city: 'London' } } } },
      { version: '1.0', updateDataModel: { surfaceId: 's1', path: '/user/city', value: 'Paris' } },
    ], testDesignSystem());
    const html = okHtml(result);
    expect(html).toContain('>Ada<');
    expect(html).toContain('>Paris<');
    expect(html).not.toContain('London');
  });

  it('fails without a value (schema) or for an unknown surface', () => {
    expect(errorCodes(importA2ui([CREATE(), { version: '1.0', updateDataModel: { surfaceId: 's1' } }], testDesignSystem())))
      .toContain('A2UI-V1-SCHEMA');
    expect(errorCodes(importA2ui([{ version: '1.0', updateDataModel: { surfaceId: 'zz', value: {} } }], testDesignSystem())))
      .toContain('A2UI-V1-SURFACE-UNKNOWN');
  });
});

describe('deleteSurface', () => {
  it('drops a deleted surface from the output and reports it', () => {
    const result = importA2ui([
      CREATE(),
      UPDATE([TEXT('root', 'gone')]),
      { version: '1.0', createSurface: { surfaceId: 's2', catalogId: A2UI_BASIC_CATALOG_ID, components: [TEXT('root', 'kept')] } },
      { version: '1.0', deleteSurface: { surfaceId: 's1' } },
    ], testDesignSystem());
    const html = okHtml(result);
    expect(html).not.toContain('data-a2ui-surface="s1"');
    expect(html).toContain('data-a2ui-surface="s2"');
    if (result.ok) expect(result.surfaces.find((s) => s.surfaceId === 's1')?.deleted).toBe(true);
  });

  it('fails for an unknown surface or an extra member', () => {
    expect(errorCodes(importA2ui([{ version: '1.0', deleteSurface: { surfaceId: 'zz' } }], testDesignSystem())))
      .toContain('A2UI-V1-SURFACE-UNKNOWN');
    expect(errorCodes(importA2ui([CREATE(), { version: '1.0', deleteSurface: { surfaceId: 's1', force: true } }], testDesignSystem())))
      .toContain('A2UI-V1-SCHEMA');
  });
});

describe('non-importable messages and safety', () => {
  it('rejects renderer function calls as unsupported for a static import', () => {
    const result = importA2ui([
      CREATE(),
      { version: '1.0', callRendererFunction: { functionCallId: 'c1', callFunction: { '@call': 'openUrl', catalogId: A2UI_BASIC_CATALOG_ID, args: { url: 'https://example.com' } } } },
    ], testDesignSystem());
    expect(errorCodes(result)).toContain('A2UI-V1-MESSAGE-UNSUPPORTED');
  });

  it('escapes text and drops non-http(s) media URLs with a warning', () => {
    const result = importA2ui([
      CREATE({ components: [
        { id: 'root', component: 'Column', children: ['t', 'img'] },
        TEXT('t', '<script>alert(1)</script>'),
        { id: 'img', component: 'Image', url: 'javascript:alert(1)', description: 'Logo' },
      ] }),
    ], testDesignSystem());
    const html = okHtml(result);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('javascript:');
    if (result.ok) expect(result.warnings.map((w) => w.code)).toContain('A2UI-V1-URL-REJECTED');
  });

  it('keeps unreachable components and template components addressable by id', () => {
    const result = importA2ui([
      CREATE({
        components: [
          { id: 'root', component: 'List', children: { componentId: 'row', path: '/items' } },
          TEXT('row', { '@path': 'name' }),
          TEXT('orphan', 'never reached'),
        ],
        dataModel: { items: [{ name: 'One' }, { name: 'Two' }] },
      }),
    ], testDesignSystem());
    const html = okHtml(result);
    expect(html).toContain('>One<');
    expect(html).toContain('>Two<');
    expect(a2uiIds(html)).toContain('orphan');
    if (result.ok) expect(result.warnings.map((w) => w.code)).toContain('A2UI-V1-UNREACHABLE');
  });

  it('makes no network call while validating and rendering', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    okHtml(importA2ui(LOGIN_FORM, testDesignSystem()));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records the pinned A2UI schema version', () => {
    expect(A2UI_SCHEMA_PIN).toEqual({
      a2uiVersion: '1.0',
      repository: 'https://github.com/a2ui-project/a2ui',
      commit: '172cf31e1acbce31c4e60d82b2edbd923b279dd8',
    });
  });
});

describe('loadA2uiDesignSystem', () => {
  it('loads the declared mapping, tokens and component styles of a built-in design system', async () => {
    const loaded = await loadA2uiDesignSystem(REPO_DESIGN_SYSTEMS, 'agentic');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.designSystem.mapping.catalogId).toBe(A2UI_BASIC_CATALOG_ID);
    expect(loaded.designSystem.tokensCss).toContain('--accent');
    expect(loaded.designSystem.componentsCss).toContain('.btn');
    for (const name of ALL_BASIC) expect(loaded.designSystem.mapping.components[name], name).toBeDefined();
    const html = okHtml(importA2ui(LOGIN_FORM, loaded.designSystem));
    expect(html).toContain('class="btn btn-secondary"');
  });

  it('returns typed errors for an unknown design system or one without a mapping', async () => {
    const unknown = await loadA2uiDesignSystem(REPO_DESIGN_SYSTEMS, 'no-such-system');
    expect(unknown.ok ? null : unknown.error.code).toBe('A2UI-V1-DESIGN-SYSTEM-UNKNOWN');
    const unmapped = await loadA2uiDesignSystem(REPO_DESIGN_SYSTEMS, 'airbnb');
    expect(unmapped.ok ? null : unmapped.error.code).toBe('A2UI-V1-MAPPING-MISSING');
    const traversal = await loadA2uiDesignSystem(REPO_DESIGN_SYSTEMS, '../apps');
    expect(traversal.ok ? null : traversal.error.code).toBe('A2UI-V1-DESIGN-SYSTEM-UNKNOWN');
  });
});
