import express from 'express';
import * as fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { A11Y_COMPLIANCE_LEVELS } from '@open-design/contracts';

import { lintArtifact, renderFindingsForAgent } from '../src/lint-artifact.js';
import {
  registerProjectArtifactRoutes,
  type RegisterProjectArtifactRoutesDeps,
} from '../src/routes/project/index.js';

describe('project artifact routes (/api/artifacts/lint & /api/artifacts/save)', () => {
  let artifactsDir: string;
  let server: http.Server;
  let baseUrl: string;
  let shouldThrowLint = false;

  beforeAll(async () => {
    artifactsDir = fs.mkdtempSync(path.join(tmpdir(), 'od-routes-lint-'));
    const app = express();
    app.use(express.json({ limit: '4mb' }));

    const deps = {
      uploads: {
        upload: {
          array: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
        },
      },
      paths: { ARTIFACTS_DIR: artifactsDir },
      node: { path, fs },
      artifacts: {
        sanitizeSlug: (raw: string) =>
          raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'artifact',
        lintArtifact: (rawHtml: unknown, opts?: Parameters<typeof lintArtifact>[1]) => {
          if (shouldThrowLint) throw new Error('secret-db-path-xyz');
          return lintArtifact(rawHtml, opts);
        },
        renderFindingsForAgent,
      },
    } as unknown as RegisterProjectArtifactRoutesDeps;

    registerProjectArtifactRoutes(app, deps);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  beforeEach(() => {
    shouldThrowLint = false;
    for (const entry of fs.readdirSync(artifactsDir)) {
      fs.rmSync(path.join(artifactsDir, entry), { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('POST /api/artifacts/lint defaults to wcag22-aa and enforces explicit tiers', async () => {
    const html = `<style>.cta { color: #707070; background: #ffffff; }</style><button class="cta">Go</button>`;
    const defRes = await fetch(`${baseUrl}/api/artifacts/lint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html }),
    });
    expect(defRes.status).toBe(200);
    const defJson = (await defRes.json()) as { a11yLevel: string; findings: Array<{ id: string }>; agentMessage: string };
    expect(defJson.a11yLevel).toBe('wcag22-aa');
    expect(defJson.findings.map((f) => f.id)).not.toContain('low-contrast-text');

    const aaaRes = await fetch(`${baseUrl}/api/artifacts/lint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html, a11yLevel: 'wcag22-aaa' }),
    });
    expect(aaaRes.status).toBe(200);
    const aaaJson = (await aaaRes.json()) as { a11yLevel: string; findings: Array<{ id: string }>; agentMessage: string };
    expect(aaaJson.a11yLevel).toBe('wcag22-aaa');
    expect(aaaJson.findings.map((f) => f.id)).toContain('low-contrast-text');
    expect(aaaJson.agentMessage).toContain('[WCAG 2.2 SC 1.4.6, AAA]');

    const levelARes = await fetch(`${baseUrl}/api/artifacts/lint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: `<style>.c { color: #a3a3a3; background: #ffffff; }</style><button></button>`, a11yLevel: 'wcag-a' }),
    });
    expect(levelARes.status).toBe(200);
    const levelAJson = (await levelARes.json()) as { a11yLevel: string; findings: Array<{ id: string }> };
    expect(levelAJson.a11yLevel).toBe('wcag-a');
    expect(levelAJson.findings.map((f) => f.id)).toEqual(['missing-accessible-name']);
  });

  it('POST /api/artifacts/save validates a11yLevel before touching ARTIFACTS_DIR and isolates off vs wcag22-aa', async () => {
    const expectedMsg = `invalid a11yLevel (expected ${A11Y_COMPLIANCE_LEVELS.join(' | ')})`;

    for (const badLevel of [null, '', 22, 'bogus\u001b[31m\n']) {
      const res = await fetch(`${baseUrl}/api/artifacts/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'bad', html: '<p>Hi</p>', a11yLevel: badLevel }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body).toEqual({ error: expectedMsg });
      expect(body.error).not.toContain('bogus');
      expect(body.error).not.toContain('\u001b');
      expect(fs.readdirSync(artifactsDir)).toEqual([]);
    }

    const emptyHtmlRes = await fetch(`${baseUrl}/api/artifacts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '' }),
    });
    expect(emptyHtmlRes.status).toBe(400);
    expect(await emptyHtmlRes.json()).toEqual({ error: 'html required' });
    expect(fs.readdirSync(artifactsDir)).toEqual([]);

    const saveOk = await fetch(`${baseUrl}/api/artifacts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'my-card',
        html: '<style>.cta { background: #6366f1; }</style><button></button>',
        a11yLevel: 'off',
      }),
    });
    expect(saveOk.status).toBe(200);
    const saved = (await saveOk.json()) as {
      path: string;
      url: string;
      a11yLevel: string;
      lint: Array<{ id: string }>;
    };
    expect(saved.a11yLevel).toBe('off');
    expect(saved.lint.map((f) => f.id)).toEqual(['ai-default-indigo']);
    expect(fs.existsSync(saved.path)).toBe(true);

    const saveDefault = await fetch(`${baseUrl}/api/artifacts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'my-card-default',
        html: '<style>.cta { color: #bbbbbb; background: #ffffff; }</style><button></button>',
      }),
    });
    expect(saveDefault.status).toBe(200);
    const savedDefault = (await saveDefault.json()) as {
      a11yLevel: string;
      lint: Array<{ id: string; compliance?: { sc: string } }>;
    };
    expect(savedDefault.a11yLevel).toBe('wcag22-aa');
    expect(savedDefault.lint.map((f) => f.id)).toEqual(
      expect.arrayContaining(['low-contrast-text', 'missing-accessible-name']),
    );
    expect(savedDefault.lint.find((f) => f.id === 'low-contrast-text')?.compliance?.sc).toBe('1.4.3');
  });

  it('rejects bad /lint inputs with fixed 400 errors and suppresses internal details on 500', async () => {
    const expectedMsg = `invalid a11yLevel (expected ${A11Y_COMPLIANCE_LEVELS.join(' | ')})`;

    for (const badLevel of [null, '', 22, 'bogus\u001b[31m']) {
      const res = await fetch(`${baseUrl}/api/artifacts/lint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html: '<p>Hi</p>', a11yLevel: badLevel }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expectedMsg });
    }

    const emptyRes = await fetch(`${baseUrl}/api/artifacts/lint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '' }),
    });
    expect(emptyRes.status).toBe(400);
    expect(await emptyRes.json()).toEqual({ error: 'html required' });

    shouldThrowLint = true;
    const lint500 = await fetch(`${baseUrl}/api/artifacts/lint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>Hi</p>' }),
    });
    expect(lint500.status).toBe(500);
    expect(await lint500.json()).toEqual({ error: 'internal error' });

    const save500 = await fetch(`${baseUrl}/api/artifacts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'err', html: '<p>Hi</p>' }),
    });
    expect(save500.status).toBe(500);
    expect(await save500.json()).toEqual({ error: 'internal error' });
  });

  it('covers all 5 WCAG 2.2 static rules across presets and leaves ARTIFACTS_DIR untouched on /lint and invalid /save', async () => {
    const html = [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<style>',
      'body { background: #ffffff; }',
      'button:focus { outline: none; }',
      'a:focus { outline: 1px solid #999999; }',
      '</style>',
      '</head>',
      '<body><main><img src="hero.png"><button>Go</button><a href="/more">More</a></main></body>',
      '</html>',
    ].join('');

    const postLint = async (a11yLevel?: unknown) => {
      const res = await fetch(`${baseUrl}/api/artifacts/lint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(a11yLevel === undefined ? { html } : { html, a11yLevel }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        a11yLevel: string;
        findings: Array<{ id: string; severity: string; compliance?: { standard: string; sc: string; level: string } }>;
        agentMessage: string;
      };
    };

    const wcagA = await postLint('wcag-a');
    expect(wcagA.a11yLevel).toBe('wcag-a');
    expect(wcagA.findings.map((f) => f.id)).toEqual([
      'missing-img-alt',
      'missing-page-title',
      'missing-html-lang',
    ]);
    expect(wcagA.findings.find((f) => f.id === 'missing-img-alt')?.compliance).toEqual({
      standard: 'WCAG-2.2',
      sc: '1.1.1',
      level: 'A',
    });
    expect(wcagA.findings.find((f) => f.id === 'missing-page-title')?.compliance).toEqual({
      standard: 'WCAG-2.2',
      sc: '2.4.2',
      level: 'A',
    });
    expect(wcagA.findings.find((f) => f.id === 'missing-html-lang')?.compliance).toEqual({
      standard: 'WCAG-2.2',
      sc: '3.1.1',
      level: 'A',
    });

    const wcag20 = await postLint('wcag20-aa');
    expect(wcag20.a11yLevel).toBe('wcag20-aa');
    expect(wcag20.findings.map((f) => f.id)).toContain('focus-outline-suppressed');
    expect(wcag20.findings.find((f) => f.id === 'focus-outline-suppressed')?.compliance).toEqual({
      standard: 'WCAG-2.0',
      sc: '2.4.7',
      level: 'AA',
    });
    expect(wcag20.findings.map((f) => f.id)).not.toContain('low-focus-appearance');

    const wcag22 = await postLint('wcag22-aa');
    expect(wcag22.a11yLevel).toBe('wcag22-aa');
    expect(wcag22.findings.find((f) => f.id === 'focus-outline-suppressed')?.compliance).toEqual({
      standard: 'WCAG-2.2',
      sc: '2.4.7',
      level: 'AA',
    });
    expect(wcag22.findings.map((f) => f.id)).not.toContain('low-focus-appearance');

    const wcag22Aaa = await postLint('wcag22-aaa');
    expect(wcag22Aaa.a11yLevel).toBe('wcag22-aaa');
    expect(wcag22Aaa.findings.map((f) => f.id)).toEqual([
      'missing-img-alt',
      'missing-page-title',
      'missing-html-lang',
      'focus-outline-suppressed',
      'low-focus-appearance',
    ]);
    expect(wcag22Aaa.findings.find((f) => f.id === 'low-focus-appearance')?.compliance).toEqual({
      standard: 'WCAG-2.2',
      sc: '2.4.13',
      level: 'AAA',
    });
    expect(fs.readdirSync(artifactsDir)).toEqual([]);

    const badSave = await fetch(`${baseUrl}/api/artifacts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'bad-tier', html, a11yLevel: 'invalid-tier' }),
    });
    expect(badSave.status).toBe(400);
    expect(fs.readdirSync(artifactsDir)).toEqual([]);

    const goodSave = await fetch(`${baseUrl}/api/artifacts/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'wcag22-card', html, a11yLevel: 'wcag22-aaa' }),
    });
    expect(goodSave.status).toBe(200);
    const saved = (await goodSave.json()) as {
      path: string;
      a11yLevel: string;
      lint: Array<{ id: string; compliance?: { standard: string; sc: string; level: string } }>;
    };
    expect(saved.a11yLevel).toBe('wcag22-aaa');
    expect(saved.lint.map((f) => f.id)).toEqual(wcag22Aaa.findings.map((f) => f.id));
    expect(fs.existsSync(saved.path)).toBe(true);
  });
});
