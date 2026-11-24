// Contract test for the `od lint` CLI surface. Keeps the UI / API / CLI
// triple wired together (AGENTS.md "Capability exposure"): the CLI must
// drive the same POST /api/artifacts/lint endpoint the web layer uses,
// with --json support for headless agents.
//
// Same stub-server process harness as cli-templates.test.ts /
// cli-deploy.test.ts: we prove SUBCOMMAND_MAP routes `lint`, parseFlags
// accepts the documented flags, the right HTTP call is emitted, and the
// exit code follows the --fail-on threshold — without booting the daemon.

import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ArtifactLintFinding } from '@open-design/contracts';

import { lintArtifact, renderFindingsForAgent } from '../src/lint-artifact.js';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

const P0_FINDING: ArtifactLintFinding = {
  severity: 'P0',
  id: 'ai-default-indigo',
  message: 'Found a default LLM accent color (#6366f1).',
  fix: 'Replace with var(--accent).',
  snippet: '#6366f1',
};
const P1_FINDING: ArtifactLintFinding = {
  severity: 'P1',
  id: 'slide-rhythm',
  message: 'Three same-theme slides in a row.',
  fix: 'Swap the middle slide theme.',
};
const P2_FINDING: ArtifactLintFinding = {
  severity: 'P2',
  id: 'advisory-example',
  message: 'Advisory finding.',
  fix: 'Optional.',
};

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

interface StubServer {
  baseUrl: string;
  requests: CapturedRequest[];
  setResponder: (
    fn: (req: CapturedRequest) => { status: number; body: unknown } | null,
  ) => void;
  close: () => Promise<void>;
}

async function startStubServer(): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  let responder:
    | ((req: CapturedRequest) => { status: number; body: unknown } | null)
    | null = null;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw,
      };
      requests.push(captured);
      const response = responder?.(captured) ?? { status: 200, body: { findings: [], agentMessage: '' } };
      res.statusCode = response.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response.body));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub server has no address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    requests,
    setResponder: (fn) => {
      responder = fn;
    },
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

async function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
  };
  delete env.NODE_OPTIONS;
  return await new Promise((resolveRun) => {
    const child = execFile(
      process.execPath,
      [TSX_CLI, CLI_SRC, ...args],
      {
        cwd: DAEMON_ROOT,
        env,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const failed = err as { code?: number | null } | null;
        resolveRun({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: failed ? failed.code ?? 1 : 0,
        });
      },
    );
    if (options.stdin != null) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
  });
}

// Reserve a port the OS says is free, then close it, so connections fail
// with ECONNREFUSED (same rationale as cli-templates.test.ts #2428 fix:
// a `port + 1` heuristic can silently hit an unrelated server).
async function reserveAndReleasePort(): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    const probe = http.createServer();
    probe.unref();
    probe.once('error', rejectListen);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (!addr || typeof addr === 'string') {
        probe.close();
        rejectListen(new Error('probe server has no address'));
        return;
      }
      const { port } = addr;
      probe.close((err) => (err ? rejectListen(err) : resolveListen(port)));
    });
  });
}

describe('od lint CLI entrypoint', () => {
  let stub: StubServer;
  let fixtureDir: string;
  let cleanFile: string;

  beforeAll(async () => {
    stub = await startStubServer();
    fixtureDir = mkdtempSync(join(tmpdir(), 'od-cli-lint-'));
    cleanFile = join(fixtureDir, 'clean.html');
    writeFileSync(cleanFile, '<main><p>Hello</p></main>');
  });

  afterAll(async () => {
    await stub.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('POSTs the file body to /api/artifacts/lint and exits 0 on clean', async () => {
    stub.setResponder(() => ({ status: 200, body: { findings: [], agentMessage: '' } }));
    const before = stub.requests.length;
    const run = await runCli(['lint', cleanFile, '--daemon-url', stub.baseUrl]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('clean — 0 findings (P0 0 · P1 0 · P2 0 · a11y: wcag22-aa)');
    const req = stub.requests[before];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/api/artifacts/lint');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ html: '<main><p>Hello</p></main>' });
  });

  it('reads stdin when the file is `-` and sends it verbatim', async () => {
    stub.setResponder(() => ({ status: 200, body: { findings: [], agentMessage: '' } }));
    const before = stub.requests.length;
    const run = await runCli(['lint', '-', '--daemon-url', stub.baseUrl], {
      stdin: '<p>from stdin</p>',
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(stub.requests[before]?.body ?? '{}')).toEqual({ html: '<p>from stdin</p>' });
  });

  it('exits 1 on a P0 finding at the default threshold and prints it', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: { findings: [P0_FINDING], agentMessage: '<artifact-lint>x</artifact-lint>' },
    }));
    const run = await runCli(['lint', cleanFile, '--daemon-url', stub.baseUrl]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('[P0] ai-default-indigo');
    expect(run.stdout).toContain('fix: Replace with var(--accent).');
  });

  it('exits 0 on a P1-only response at the default p0 threshold', async () => {
    stub.setResponder(() => ({ status: 200, body: { findings: [P1_FINDING], agentMessage: '' } }));
    const run = await runCli(['lint', cleanFile, '--daemon-url', stub.baseUrl]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('[P1] slide-rhythm');
  });

  it('honors --fail-on p1 and p2 thresholds', async () => {
    stub.setResponder(() => ({ status: 200, body: { findings: [P1_FINDING], agentMessage: '' } }));
    expect((await runCli(['lint', cleanFile, '--fail-on', 'p1', '--daemon-url', stub.baseUrl])).code).toBe(1);

    stub.setResponder(() => ({ status: 200, body: { findings: [P2_FINDING], agentMessage: '' } }));
    expect((await runCli(['lint', cleanFile, '--fail-on', 'p1', '--daemon-url', stub.baseUrl])).code).toBe(0);
    expect((await runCli(['lint', cleanFile, '--fail-on', 'p2', '--daemon-url', stub.baseUrl])).code).toBe(1);
  });

  it('honors --fail-on none even with P0 findings', async () => {
    stub.setResponder(() => ({ status: 200, body: { findings: [P0_FINDING], agentMessage: '' } }));
    const run = await runCli(['lint', cleanFile, '--fail-on', 'none', '--daemon-url', stub.baseUrl]);
    expect(run.code).toBe(0);
  });

  it('prints a machine envelope with --json (counts, findings, agentMessage)', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: { findings: [P0_FINDING, P1_FINDING], agentMessage: '<artifact-lint>m</artifact-lint>' },
    }));
    const run = await runCli(['lint', cleanFile, '--json', '--daemon-url', stub.baseUrl]);
    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.failOn).toBe('p0');
    expect(envelope.a11yLevel).toBe('wcag22-aa');
    expect(JSON.parse(stub.requests.at(-1)?.body ?? '{}')).toEqual({ html: '<main><p>Hello</p></main>' });
    expect(envelope.counts).toEqual({ p0: 1, p1: 1, p2: 0 });
    expect(envelope.findings).toHaveLength(2);
    expect(envelope.agentMessage).toContain('<artifact-lint>');
  });

  it('appends the agent block to human output only with --agent-message', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: { findings: [P0_FINDING], agentMessage: '<artifact-lint>block</artifact-lint>' },
    }));
    const withFlag = await runCli(['lint', cleanFile, '--agent-message', '--daemon-url', stub.baseUrl]);
    expect(withFlag.stdout).toContain('<artifact-lint>block</artifact-lint>');
    const withoutFlag = await runCli(['lint', cleanFile, '--daemon-url', stub.baseUrl]);
    expect(withoutFlag.stdout).not.toContain('<artifact-lint>');
  });

  it('forwards --a11y-level in the request and reports it in the JSON envelope', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: { findings: [], agentMessage: '', a11yLevel: 'wcag22-aaa' },
    }));
    const before = stub.requests.length;
    const run = await runCli([
      'lint',
      cleanFile,
      '--a11y-level',
      'wcag22-aaa',
      '--json',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(run.code).toBe(0);
    expect(JSON.parse(stub.requests[before]?.body ?? '{}')).toEqual({
      html: '<main><p>Hello</p></main>',
      a11yLevel: 'wcag22-aaa',
    });
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, a11yLevel: 'wcag22-aaa' });

    const beforeFirstRun = await runCli([
      'lint',
      '--a11y-level',
      'wcag-a',
      cleanFile,
      '--json',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(beforeFirstRun.code).toBe(0);
    expect(JSON.parse(stub.requests.at(-1)?.body ?? '{}')).toEqual({
      html: '<main><p>Hello</p></main>',
      a11yLevel: 'wcag-a',
    });
    expect(JSON.parse(beforeFirstRun.stdout)).toMatchObject({ ok: true, a11yLevel: 'wcag22-aaa' });
  });

  it('exits 2 on usage errors: unknown flag, bad --fail-on, bad --a11y-level, missing file, empty input', async () => {
    expect((await runCli(['lint', cleanFile, '--bogus', '--daemon-url', stub.baseUrl])).code).toBe(2);
    expect((await runCli(['lint', cleanFile, '--fail-on', 'p9', '--daemon-url', stub.baseUrl])).code).toBe(2);
    expect((await runCli(['lint', cleanFile, '--a11y-level', 'bogus', '--daemon-url', stub.baseUrl])).code).toBe(2);
    expect((await runCli(['lint'])).code).toBe(2);
    const missing = await runCli(['lint', join(fixtureDir, 'nope.html'), '--daemon-url', stub.baseUrl]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('cannot read');
    const empty = join(fixtureDir, 'empty.html');
    writeFileSync(empty, '');
    const emptyRun = await runCli(['lint', empty, '--daemon-url', stub.baseUrl]);
    expect(emptyRun.code).toBe(2);
    expect(emptyRun.stderr).toContain('empty input');
  });

  it('surfaces an HTTP failure as a structured nonzero exit', async () => {
    stub.setResponder(() => ({ status: 500, body: { error: 'boom' } }));
    const run = await runCli(['lint', cleanFile, '--daemon-url', stub.baseUrl]);
    expect(run.code).toBe(64);
    expect(`${run.stdout}${run.stderr}`).toContain('boom');
  });

  it('exits 3 when the daemon is unreachable', async () => {
    const port = await reserveAndReleasePort();
    const run = await runCli(['lint', cleanFile, '--daemon-url', `http://127.0.0.1:${port}`]);
    expect(run.code).toBe(3);
  });

  it('fails `--json --fail-on p0` on the low-contrast fixture and respects `--a11y-level wcag-a`', async () => {
    // The stub answers with the daemon's own linter, so this exercises the
    // real low-contrast-text rule and compliance tier switching end to end.
    stub.setResponder((req) => {
      const { html, a11yLevel } = JSON.parse(req.body) as { html: string; a11yLevel?: any };
      const findings = lintArtifact(html, { a11yLevel });
      return {
        status: 200,
        body: { findings, agentMessage: renderFindingsForAgent(findings), a11yLevel: a11yLevel ?? 'wcag22-aa' },
      };
    });
    const fixture = join(__dirname, 'fixtures', 'a11y', 'low-contrast.html');
    expect(readFileSync(fixture, 'utf8')).toContain('#a3a3a3');
    const run = await runCli(['lint', fixture, '--json', '--fail-on', 'p0', '--daemon-url', stub.baseUrl]);
    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.a11yLevel).toBe('wcag22-aa');
    expect(envelope.counts.p0).toBeGreaterThanOrEqual(1);
    expect(envelope.findings).toContainEqual(expect.objectContaining({ id: 'low-contrast-text', severity: 'P0' }));

    const levelARun = await runCli([
      'lint',
      fixture,
      '--a11y-level',
      'wcag-a',
      '--json',
      '--fail-on',
      'p0',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(levelARun.code).toBe(0);
    expect(JSON.parse(levelARun.stdout)).toMatchObject({
      ok: true,
      a11yLevel: 'wcag-a',
      counts: { p0: 0 },
    });
  });

  it('is discoverable from the root help output and lint --help', async () => {
    const run = await runCli(['--help']);
    expect(run.stdout).toContain('od lint <file.html|->');
    expect(run.stdout).toContain('--fail-on');
    expect(run.stdout).toContain('--a11y-level <tier>');

    const lintHelp = await runCli(['lint', '--help']);
    expect(lintHelp.code).toBe(0);
    expect(lintHelp.stdout).toContain('--a11y-level <tier>');
    expect(lintHelp.stdout).toContain('wcag22-aa');
  });

  it('prints compliance provenance without double parens and discloses active a11yLevel in plain text and JSON', async () => {
    stub.setResponder(() => ({
      status: 200,
      body: {
        findings: [
          {
            severity: 'P0',
            id: 'missing-accessible-name',
            message: '1 interactive element(s) without an accessible name; first: <button> has no text or label.',
            fix: 'Add visible text or aria-label.',
            snippet: '<button></button>',
            compliance: { standard: 'WCAG-2.2', sc: '4.1.2', level: 'A' },
          },
        ],
        agentMessage: '<artifact-lint>block</artifact-lint>',
        a11yLevel: 'wcag21-aa',
      },
    }));
    const before = stub.requests.length;
    const plain = await runCli(['lint', cleanFile, '--daemon-url', stub.baseUrl]);
    expect(plain.code).toBe(1);
    expect(JSON.parse(stub.requests[before]?.body ?? '{}')).toEqual({ html: '<main><p>Hello</p></main>' });
    expect(plain.stdout).toContain('[P0] missing-accessible-name [WCAG 2.2 SC 4.1.2, A] — 1 interactive element(s)');
    expect(plain.stdout).not.toContain('((');
    expect(plain.stdout).toContain('1 finding (P0 1 · P1 0 · P2 0 · a11y: wcag21-aa)');

    const jsonOmit = await runCli(['lint', cleanFile, '--json', '--daemon-url', stub.baseUrl]);
    expect(jsonOmit.code).toBe(1);
    expect(JSON.parse(jsonOmit.stdout)).toMatchObject({ a11yLevel: 'wcag21-aa' });

    stub.setResponder(() => ({ status: 200, body: { findings: [], agentMessage: '' } }));
    const cleanEq = await runCli(['lint', cleanFile, '--a11y-level=off', '--daemon-url', stub.baseUrl]);
    expect(cleanEq.code).toBe(0);
    expect(cleanEq.stdout).toContain('clean — 0 findings (P0 0 · P1 0 · P2 0 · a11y: off)');
  });

  it('rejects empty/bad --fail-on and --a11y-level with fixed non-echoing stderr and handles HTTP 400', async () => {
    for (const badFailOn of ['', 'p9', 'bad\u001b[31m\n']) {
      const res = await runCli(['lint', cleanFile, '--fail-on', badFailOn, '--daemon-url', stub.baseUrl]);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('invalid --fail-on (expected p0 | p1 | p2 | none)');
      expect(res.stderr).not.toContain('p9');
      expect(res.stderr).not.toContain('bad');
      expect(res.stderr).not.toContain('\u001b');
    }

    for (const badLevel of ['', 'bogus', 'bad\u001b[31m\n']) {
      const res = await runCli(['lint', cleanFile, '--a11y-level', badLevel, '--daemon-url', stub.baseUrl]);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('invalid --a11y-level (expected');
      expect(res.stderr).not.toContain('bogus');
      expect(res.stderr).not.toContain('bad');
      expect(res.stderr).not.toContain('\u001b');
    }
    const danglingFlag = await runCli(['lint', cleanFile, '--daemon-url', stub.baseUrl, '--a11y-level']);
    expect(danglingFlag.code).toBe(2);
    expect(danglingFlag.stderr).toContain('flag --a11y-level requires a value');

    stub.setResponder(() => ({
      status: 200,
      body: { findings: [P0_FINDING], agentMessage: '', a11yLevel: 'wcag-a' },
    }));
    const runNone = await runCli([
      'lint',
      cleanFile,
      '--a11y-level',
      'wcag-a',
      '--fail-on',
      'none',
      '--json',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(runNone.code).toBe(0);
    expect(JSON.parse(runNone.stdout)).toMatchObject({ ok: true, failOn: 'none', a11yLevel: 'wcag-a' });

    stub.setResponder(() => ({
      status: 400,
      body: { error: 'invalid a11yLevel (expected wcag-a | wcag20-aa | wcag21-aa | wcag22-aa | wcag22-aaa | off)' },
    }));
    const http400 = await runCli(['lint', cleanFile, '--daemon-url', stub.baseUrl]);
    expect(http400.code).toBe(64);
    expect(`${http400.stdout}${http400.stderr}`).toContain('invalid a11yLevel');
  });

  it('exercises all 5 WCAG 2.2 rules end-to-end via real lintArtifact and renderFindingsForAgent across tiers and flags', async () => {
    stub.setResponder((req) => {
      const { html, a11yLevel } = JSON.parse(req.body) as { html: string; a11yLevel?: any };
      const resolvedTier = a11yLevel ?? 'wcag22-aa';
      const findings = lintArtifact(html, { a11yLevel: resolvedTier });
      return {
        status: 200,
        body: { findings, agentMessage: renderFindingsForAgent(findings), a11yLevel: resolvedTier },
      };
    });

    const wcag22File = join(fixtureDir, 'wcag22-all.html');
    writeFileSync(
      wcag22File,
      [
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
      ].join(''),
    );

    const levelAJson = await runCli([
      'lint',
      wcag22File,
      '--a11y-level',
      'wcag-a',
      '--fail-on',
      'p0',
      '--json',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(levelAJson.code).toBe(1);
    const levelAEnv = JSON.parse(levelAJson.stdout);
    expect(levelAEnv.a11yLevel).toBe('wcag-a');
    expect(levelAEnv.findings.map((f: { id: string }) => f.id)).toEqual([
      'missing-img-alt',
      'missing-page-title',
      'missing-html-lang',
    ]);

    const levelAImgOnlyP1File = join(fixtureDir, 'title-lang-only.html');
    writeFileSync(levelAImgOnlyP1File, '<!doctype html><html><head></head><body><main><p>Hi</p></main></body></html>');
    const p1PassOnP0 = await runCli([
      'lint',
      levelAImgOnlyP1File,
      '--a11y-level',
      'wcag-a',
      '--fail-on',
      'p0',
      '--json',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(p1PassOnP0.code).toBe(0);
    const p1FailOnP1 = await runCli([
      'lint',
      levelAImgOnlyP1File,
      '--a11y-level',
      'wcag-a',
      '--fail-on',
      'p1',
      '--json',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(p1FailOnP1.code).toBe(1);

    const aaAgent = await runCli([
      'lint',
      wcag22File,
      '--a11y-level',
      'wcag22-aa',
      '--agent-message',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(aaAgent.code).toBe(1);
    expect(aaAgent.stdout).toContain('[P0] missing-img-alt [WCAG 2.2 SC 1.1.1, A]');
    expect(aaAgent.stdout).toContain('[P1] missing-page-title [WCAG 2.2 SC 2.4.2, A]');
    expect(aaAgent.stdout).toContain('[P1] missing-html-lang [WCAG 2.2 SC 3.1.1, A]');
    expect(aaAgent.stdout).toContain('[P0] focus-outline-suppressed [WCAG 2.2 SC 2.4.7, AA]');
    expect(aaAgent.stdout).not.toContain('low-focus-appearance');
    expect(aaAgent.stdout).toContain('**[P0] focus-outline-suppressed** [WCAG 2.2 SC 2.4.7, AA]');

    const aaaAgent = await runCli([
      'lint',
      wcag22File,
      '--a11y-level',
      'wcag22-aaa',
      '--fail-on',
      'p1',
      '--agent-message',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(aaaAgent.code).toBe(1);
    expect(aaaAgent.stdout).toContain('[P1] low-focus-appearance [WCAG 2.2 SC 2.4.13, AAA]');
    expect(aaaAgent.stdout).toContain('**[P1] low-focus-appearance** [WCAG 2.2 SC 2.4.13, AAA]');
  });
});
