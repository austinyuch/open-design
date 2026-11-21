// POST /api/a2ui/import — the daemon half of `od import a2ui`.

import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerA2uiRoutes } from '../src/routes/a2ui.js';

const here = dirname(fileURLToPath(import.meta.url));
const LOGIN_FORM = readFileSync(join(here, 'fixtures', 'a2ui', 'login-form.json'), 'utf8');

describe('POST /api/a2ui/import', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '4mb' }));
    registerA2uiRoutes(app, {
      designSystemsRoot: resolve(here, '../../../design-systems'),
      userDesignSystemsRoot: join(here, 'fixtures', 'a2ui', 'no-user-design-systems'),
    });
    server = await new Promise<Server>((ok) => {
      const s = app.listen(0, '127.0.0.1', () => ok(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((ok) => server.close(ok));
  });

  async function post(body: unknown) {
    const res = await fetch(`${base}/api/a2ui/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('imports a valid stream into HTML for a mapped design system', async () => {
    const { status, body } = await post({ stream: LOGIN_FORM, designSystemId: 'agentic' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.a2uiVersion).toBe('1.0');
    expect(String(body.html)).toContain('data-a2ui-id="login_btn"');
  });

  it('returns 422 with typed errors for an invalid stream', async () => {
    const { status, body } = await post({
      stream: [{ version: '1.0', updateComponents: { surfaceId: 'nope', components: [{ id: 'root', component: 'Text', text: 'x' }] } }],
      designSystemId: 'agentic',
    });
    expect(status).toBe(422);
    expect(body.ok).toBe(false);
    expect((body.errors as Array<{ code: string }>).map((e) => e.code)).toContain('A2UI-V1-SURFACE-UNKNOWN');
  });

  it('returns 422 with a typed error for an unknown or unmapped design system', async () => {
    const unknown = await post({ stream: LOGIN_FORM, designSystemId: 'user:missing' });
    expect(unknown.status).toBe(422);
    expect((unknown.body.errors as Array<{ code: string }>)[0]?.code).toBe('A2UI-V1-DESIGN-SYSTEM-UNKNOWN');
    const unmapped = await post({ stream: LOGIN_FORM, designSystemId: 'airbnb' });
    expect((unmapped.body.errors as Array<{ code: string }>)[0]?.code).toBe('A2UI-V1-MAPPING-MISSING');
  });

  it('returns 400 when the request is incomplete', async () => {
    expect((await post({ stream: LOGIN_FORM })).status).toBe(400);
    expect((await post({ designSystemId: 'agentic' })).status).toBe(400);
  });
});
