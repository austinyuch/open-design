// @vitest-environment node

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { createSmokeSuite } from '@/vitest/suite';

const odBin = fileURLToPath(new URL('../../apps/daemon/bin/od.mjs', import.meta.url));
const lowContrastFixture = fileURLToPath(
  new URL('../../apps/daemon/tests/fixtures/a11y/low-contrast.html', import.meta.url),
);

type LintCliReport = {
  a11yLevel?: string;
  counts: { p0: number; p1: number; p2: number };
  failOn: string;
  findings: Array<{
    compliance?: { standard: string; sc: string; level: string };
    id: string;
    severity: string;
  }>;
  ok: boolean;
};

describe('artifact lint CLI end-to-end', () => {
  test('[P1] real od lint uses the running daemon for files, stdin, JSON, and exit thresholds', async () => {
    const suite = await createSmokeSuite('artifact-lint-cli');

    await suite.with.toolsDev(async ({ runtime }) => {
      const daemonUrl = `http://127.0.0.1:${runtime.daemonPort}`;
      const artifactPath = join(suite.scratchDir, 'default-indigo.html');
      await writeFile(
        artifactPath,
        '<!doctype html><main style="color:#6366f1"><h1>Generated artifact</h1></main>',
        'utf8',
      );

      const rejected = await odLint(
        daemonUrl,
        ['lint', artifactPath, '--json'],
      );
      expect(rejected.code, rejected.stderr || rejected.stdout).toBe(1);
      const report = parseReport(rejected);
      expect(report).toMatchObject({
        ok: false,
        failOn: 'p0',
        counts: { p0: expect.any(Number), p1: expect.any(Number), p2: expect.any(Number) },
      });
      expect(report.counts.p0).toBeGreaterThan(0);
      expect(report.findings).toContainEqual(expect.objectContaining({
        id: 'ai-default-indigo',
        severity: 'P0',
      }));

      const clean = await odLint(
        daemonUrl,
        ['lint', '-', '--json'],
        '<!doctype html><main><h1>Deliberate artifact</h1></main>',
      );
      expect(clean.code, clean.stderr || clean.stdout).toBe(0);
      expect(parseReport(clean)).toMatchObject({
        ok: true,
        failOn: 'p0',
        counts: { p0: 0 },
      });
    });
  }, 180_000);

  test('[P1] real od lint reports WCAG 2.2 contrast, focus-ring, rgba border, and accessible-name rules', async () => {
    const suite = await createSmokeSuite('artifact-lint-cli-a11y');

    await suite.with.toolsDev(async ({ runtime }) => {
      const daemonUrl = `http://127.0.0.1:${runtime.daemonPort}`;

      const fixtureRes = await odLint(
        daemonUrl,
        ['lint', lowContrastFixture, '--json', '--fail-on', 'p0'],
      );
      expect(fixtureRes.code, fixtureRes.stderr || fixtureRes.stdout).toBe(1);
      const fixtureReport = parseReport(fixtureRes);
      expect(fixtureReport.ok).toBe(false);
      expect(fixtureReport.findings).toContainEqual(expect.objectContaining({
        id: 'low-contrast-text',
        severity: 'P0',
      }));

      const failingControl = await odLint(
        daemonUrl,
        ['lint', '-', '--json', '--fail-on', 'p0'],
        '<!doctype html><style>body{background:#fff}input{border:1px solid rgba(0,0,0,0.08);background:#fff}</style><main><input type="text" placeholder="Email"></main>',
      );
      expect(failingControl.code, failingControl.stderr || failingControl.stdout).toBe(1);
      const controlReport = parseReport(failingControl);
      expect(controlReport.ok).toBe(false);
      expect(controlReport.findings).toContainEqual(expect.objectContaining({
        id: 'low-contrast-ui',
        severity: 'P0',
      }));
      expect(controlReport.findings).toContainEqual(expect.objectContaining({
        id: 'missing-accessible-name',
        severity: 'P0',
      }));
      expect(controlReport.findings.map((f) => f.id)).not.toContain('contrast-unresolved');

      const passingControl = await odLint(
        daemonUrl,
        ['lint', '-', '--json', '--fail-on', 'p1'],
        '<!doctype html><style>body{background:#ffffff;color:#111111}input{border:1px solid rgba(0,0,0,0.55);background:#ffffff;color:#111111}input:focus{border-color:#ffef5a;box-shadow:0 0 0 4px #000000}</style><main><section data-od-id="form"><label>Email <input type="email"></label></section></main>',
      );
      expect(passingControl.code, passingControl.stderr || passingControl.stdout).toBe(0);
      expect(parseReport(passingControl)).toMatchObject({
        ok: true,
        counts: { p0: 0, p1: 0 },
      });

      const unresolvedHtml =
        '<!doctype html><style>.badge{color:#111;background:color-mix(in oklab,#16a34a,transparent 90%)}</style><main><span class="badge">Live</span></main>';

      const unresolvedP0 = await odLint(
        daemonUrl,
        ['lint', '-', '--json', '--fail-on', 'p0'],
        unresolvedHtml,
      );
      expect(unresolvedP0.code, unresolvedP0.stderr || unresolvedP0.stdout).toBe(0);
      const unresolvedP0Report = parseReport(unresolvedP0);
      expect(unresolvedP0Report.ok).toBe(true);
      expect(unresolvedP0Report.counts.p0).toBe(0);
      expect(unresolvedP0Report.findings).toContainEqual(expect.objectContaining({
        id: 'contrast-unresolved',
        severity: 'P1',
      }));

      const unresolvedP1 = await odLint(
        daemonUrl,
        ['lint', '-', '--json', '--fail-on', 'p1'],
        unresolvedHtml,
      );
      expect(unresolvedP1.code, unresolvedP1.stderr || unresolvedP1.stdout).toBe(1);
      const unresolvedP1Report = parseReport(unresolvedP1);
      expect(unresolvedP1Report.ok).toBe(false);
      expect(unresolvedP1Report.findings).toContainEqual(expect.objectContaining({
        id: 'contrast-unresolved',
        severity: 'P1',
      }));

      // Declarative compliance tier switching on the live daemon.
      expect(fixtureReport.a11yLevel).toBe('wcag22-aa');
      expect(fixtureReport.findings).toContainEqual(expect.objectContaining({
        id: 'low-contrast-text',
        compliance: { standard: 'WCAG-2.2', sc: '1.4.3', level: 'AA' },
      }));

      const levelARes = await odLint(
        daemonUrl,
        ['lint', lowContrastFixture, '--a11y-level', 'wcag-a', '--json', '--fail-on', 'p0'],
      );
      expect(levelARes.code, levelARes.stderr || levelARes.stdout).toBe(0);
      expect(parseReport(levelARes)).toMatchObject({
        ok: true,
        a11yLevel: 'wcag-a',
        counts: { p0: 0 },
      });

      const offRes = await odLint(
        daemonUrl,
        ['lint', lowContrastFixture, '--a11y-level', 'off', '--json', '--fail-on', 'p2'],
      );
      expect(offRes.code, offRes.stderr || offRes.stdout).toBe(0);
      expect(parseReport(offRes)).toMatchObject({
        ok: true,
        a11yLevel: 'off',
        findings: [],
      });

      const aaOnlyHtml =
        '<!doctype html><style>body{background:#fff}.copy{color:#707070;background:#fff}.btn{width:32px;height:32px}</style><main><p class="copy">Ok</p><button class="btn">Go</button></main>';
      const aaPass = await odLint(
        daemonUrl,
        ['lint', '-', '--a11y-level', 'wcag22-aa', '--json', '--fail-on', 'p1'],
        aaOnlyHtml,
      );
      expect(aaPass.code, aaPass.stderr || aaPass.stdout).toBe(0);
      expect(parseReport(aaPass)).toMatchObject({
        ok: true,
        a11yLevel: 'wcag22-aa',
        counts: { p0: 0, p1: 0, p2: 0 },
      });

      const aaaFail = await odLint(
        daemonUrl,
        ['lint', '-', '--a11y-level', 'wcag22-aaa', '--json', '--fail-on', 'p0'],
        aaOnlyHtml,
      );
      expect(aaaFail.code, aaaFail.stderr || aaaFail.stdout).toBe(1);
      const aaaReport = parseReport(aaaFail);
      expect(aaaReport.a11yLevel).toBe('wcag22-aaa');
      expect(aaaReport.findings).toContainEqual(expect.objectContaining({
        id: 'low-contrast-text',
        severity: 'P0',
        compliance: { standard: 'WCAG-2.2', sc: '1.4.6', level: 'AAA' },
      }));
      expect(aaaReport.findings).toContainEqual(expect.objectContaining({
        id: 'target-size-min',
        severity: 'P1',
        compliance: { standard: 'WCAG-2.2', sc: '2.5.5', level: 'AAA' },
      }));

      for (const badLevel of ['bogus', '', 'bad\u001b[31m\n']) {
        for (const endpoint of ['/api/artifacts/lint', '/api/artifacts/save']) {
          const badLevelResp = await fetch(`${daemonUrl}${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ html: '<main><h1>Hi</h1></main>', a11yLevel: badLevel }),
          });
          expect(badLevelResp.status).toBe(400);
          const errBody = (await badLevelResp.json()) as { error: string };
          expect(errBody.error).toBe(
            'invalid a11yLevel (expected wcag-a | wcag20-aa | wcag21-aa | wcag22-aa | wcag22-aaa | off)',
          );
          expect(errBody.error).not.toContain('bogus');
          expect(errBody.error).not.toContain('\u001b');
        }
      }

      const plainAgent = await odLint(
        daemonUrl,
        ['lint', lowContrastFixture, '--agent-message'],
      );
      expect(plainAgent.code, plainAgent.stderr || plainAgent.stdout).toBe(1);
      expect(plainAgent.stdout).toContain('[P0] low-contrast-text [WCAG 2.2 SC 1.4.3, AA]');
      expect(plainAgent.stdout).not.toContain('((');
      expect(plainAgent.stdout).toContain('a11y: wcag22-aa)');
      expect(plainAgent.stdout).toContain(
        'The artifact you just produced has the following anti-slop / design-token / accessibility issues.',
      );
      expect(plainAgent.stdout).toContain('**[P0] low-contrast-text** [WCAG 2.2 SC 1.4.3, AA]');

      const plainLevelA = await odLint(
        daemonUrl,
        ['lint', lowContrastFixture, '--a11y-level', 'wcag-a'],
      );
      expect(plainLevelA.code, plainLevelA.stderr || plainLevelA.stdout).toBe(0);
      expect(plainLevelA.stdout).toContain('clean — 0 findings (P0 0 · P1 0 · P2 0 · a11y: wcag-a)');

      // WCAG 2.2 static expansion: Level A (1.1.1 + fragment safety for 2.4.2/3.1.1), 2.4.7, and 2.4.13.
      const imgAltRes = await odLint(
        daemonUrl,
        ['lint', '-', '--a11y-level', 'wcag-a', '--json', '--fail-on', 'p0'],
        '<!doctype html><html lang="en"><head><title>Image Check</title></head><body><main><img src="chart.png"></main></body></html>',
      );
      expect(imgAltRes.code, imgAltRes.stderr || imgAltRes.stdout).toBe(1);
      const imgAltReport = parseReport(imgAltRes);
      expect(imgAltReport.findings).toContainEqual(expect.objectContaining({
        id: 'missing-img-alt',
        severity: 'P0',
        compliance: { standard: 'WCAG-2.2', sc: '1.1.1', level: 'A' },
      }));

      const cleanFragmentRes = await odLint(
        daemonUrl,
        ['lint', '-', '--a11y-level', 'wcag22-aa', '--json', '--fail-on', 'p1'],
        '<!doctype html><main><h1>Fragment Section</h1></main>',
      );
      expect(cleanFragmentRes.code, cleanFragmentRes.stderr || cleanFragmentRes.stdout).toBe(0);
      const fragmentIds = parseReport(cleanFragmentRes).findings.map((f) => f.id);
      expect(fragmentIds).not.toContain('missing-page-title');
      expect(fragmentIds).not.toContain('missing-html-lang');

      const focusSuppressedRes = await odLint(
        daemonUrl,
        ['lint', '-', '--a11y-level', 'wcag22-aa', '--json', '--fail-on', 'p0'],
        '<!doctype html><style>button:focus{outline:none}</style><main><button>Save</button></main>',
      );
      expect(focusSuppressedRes.code, focusSuppressedRes.stderr || focusSuppressedRes.stdout).toBe(1);
      expect(parseReport(focusSuppressedRes).findings).toContainEqual(expect.objectContaining({
        id: 'focus-outline-suppressed',
        severity: 'P0',
        compliance: { standard: 'WCAG-2.2', sc: '2.4.7', level: 'AA' },
      }));

      const focusPairedRes = await odLint(
        daemonUrl,
        ['lint', '-', '--a11y-level', 'wcag22-aa', '--json', '--fail-on', 'p0'],
        '<!doctype html><style>.btn:focus-visible{outline:2px solid #000}.card:focus:not(:focus-visible){outline:none}</style><main><button class="btn">Save</button></main>',
      );
      expect(focusPairedRes.code, focusPairedRes.stderr || focusPairedRes.stdout).toBe(0);
      expect(parseReport(focusPairedRes).findings.map((f) => f.id)).not.toContain('focus-outline-suppressed');

      const weakFocusHtml =
        '<!doctype html><style>body{background:#fff}button:focus{outline:1px solid #999999}</style><main><button>Save</button></main>';
      const focusAaPass = await odLint(
        daemonUrl,
        ['lint', '-', '--a11y-level', 'wcag22-aa', '--json', '--fail-on', 'p1'],
        weakFocusHtml,
      );
      expect(focusAaPass.code, focusAaPass.stderr || focusAaPass.stdout).toBe(0);
      expect(parseReport(focusAaPass).findings.map((f) => f.id)).not.toContain('low-focus-appearance');

      const focusAaaFail = await odLint(
        daemonUrl,
        ['lint', '-', '--a11y-level', 'wcag22-aaa', '--json', '--fail-on', 'p1'],
        weakFocusHtml,
      );
      expect(focusAaaFail.code, focusAaaFail.stderr || focusAaaFail.stdout).toBe(1);
      expect(parseReport(focusAaaFail).findings).toContainEqual(expect.objectContaining({
        id: 'low-focus-appearance',
        severity: 'P1',
        compliance: { standard: 'WCAG-2.2', sc: '2.4.13', level: 'AAA' },
      }));

      const docShellRes = await odLint(
        daemonUrl,
        ['lint', '-', '--a11y-level', 'wcag-a', '--json', '--fail-on', 'p1'],
        '<!doctype html><html><head></head><body><main><p>Check</p></main></body></html>',
      );
      expect(docShellRes.code, docShellRes.stderr || docShellRes.stdout).toBe(1);
      const docShellFindings = parseReport(docShellRes).findings;
      expect(docShellFindings).toContainEqual(expect.objectContaining({
        id: 'missing-page-title',
        severity: 'P1',
        compliance: { standard: 'WCAG-2.2', sc: '2.4.2', level: 'A' },
      }));
      expect(docShellFindings).toContainEqual(expect.objectContaining({
        id: 'missing-html-lang',
        severity: 'P1',
        compliance: { standard: 'WCAG-2.2', sc: '3.1.1', level: 'A' },
      }));
    });
  }, 180_000);
});

function parseReport(result: { stdout: string }): LintCliReport {
  return JSON.parse(result.stdout) as LintCliReport;
}

async function odLint(
  daemonUrl: string,
  args: string[],
  stdin?: string,
): Promise<{ code: number; stderr: string; stdout: string }> {
  return await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [odBin, ...args],
      {
        env: { ...process.env, OD_DAEMON_URL: daemonUrl },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        const failure = error as { code?: number } | null;
        resolve({
          code: typeof failure?.code === 'number' ? failure.code : error ? 1 : 0,
          stderr: stderr ?? '',
          stdout: stdout ?? '',
        });
      },
    );
    child.stdin?.end(stdin);
  });
}
