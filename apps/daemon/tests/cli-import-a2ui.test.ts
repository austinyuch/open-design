// Contract test for `od import a2ui`: the CLI half of POST
// /api/a2ui/import. Same stub-server process harness as cli-lint.test.ts:
// we prove SUBCOMMAND_MAP routes `import`, the documented flags parse, the
// request carries the raw stream and design system id, and exit codes
// follow the typed result — without booting the daemon.

import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { A2uiImportFailure, A2uiImportSuccess } from '@open-design/contracts';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

const SUCCESS: A2uiImportSuccess = {
  ok: true,
  a2uiVersion: '1.0',
  designSystemId: 'agentic',
  html: '<!doctype html><main data-a2ui-version="1.0"><p data-a2ui-id="root">Hi</p></main>',
  surfaces: [{ surfaceId: 's1', catalogId: 'basic', deleted: false, componentIds: ['root'] }],
  warnings: [],
};
const FAILURE: A2uiImportFailure = {
  ok: false,
  a2uiVersion: '1.0',
  designSystemId: 'agentic',
  errors: [{ code: 'A2UI-V1-COMPONENT-UNKNOWN', path: '$[1].updateComponents.components[0].component', message: 'component "Carousel" is not defined' }],
  warnings: [],
};
const STREAM = '{"version":"1.0","createSurface":{"surfaceId":"s1"}}\n';

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

describe('od import a2ui CLI entrypoint', () => {
  let stub: StubServer;
  let fixtureDir: string;
  let streamFile: string;

  beforeAll(async () => {
    stub = await startStubServer();
    fixtureDir = mkdtempSync(join(tmpdir(), 'od-cli-import-a2ui-'));
    streamFile = join(fixtureDir, 'ui.a2ui.jsonl');
    writeFileSync(streamFile, STREAM);
  });

  afterAll(async () => {
    await stub.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('POSTs the raw stream and design system to /api/a2ui/import and prints the --json envelope', async () => {
    stub.setResponder(() => ({ status: 200, body: SUCCESS }));
    const before = stub.requests.length;
    const run = await runCli(['import', 'a2ui', streamFile, '--design-system', 'agentic', '--json', '--daemon-url', stub.baseUrl]);
    expect(run.code).toBe(0);
    const req = stub.requests[before];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/api/a2ui/import');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ stream: STREAM, designSystemId: 'agentic' });
    expect(JSON.parse(run.stdout)).toEqual(SUCCESS);
  });

  it('reads stdin when the file is `-` and prints the HTML without --json', async () => {
    stub.setResponder(() => ({ status: 200, body: SUCCESS }));
    const before = stub.requests.length;
    const run = await runCli(['import', 'a2ui', '-', '--design-system', 'agentic', '--daemon-url', stub.baseUrl], { stdin: STREAM });
    expect(run.code).toBe(0);
    expect(JSON.parse(stub.requests[before]?.body ?? '{}').stream).toBe(STREAM);
    expect(run.stdout).toContain('data-a2ui-id="root"');
  });

  it('writes the HTML to --out', async () => {
    stub.setResponder(() => ({ status: 200, body: SUCCESS }));
    const out = join(fixtureDir, 'out.html');
    const run = await runCli(['import', 'a2ui', streamFile, '--design-system', 'agentic', '--out', out, '--daemon-url', stub.baseUrl]);
    expect(run.code).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(SUCCESS.html);
    expect(run.stdout).toContain(out);
  });

  it('exits 1 with the typed errors when the daemon rejects the stream', async () => {
    stub.setResponder(() => ({ status: 422, body: FAILURE }));
    const json = await runCli(['import', 'a2ui', streamFile, '--design-system', 'agentic', '--json', '--daemon-url', stub.baseUrl]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual(FAILURE);
    const human = await runCli(['import', 'a2ui', streamFile, '--design-system', 'agentic', '--daemon-url', stub.baseUrl]);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain('A2UI-V1-COMPONENT-UNKNOWN');
  });

  it('exits 2 on usage errors', async () => {
    expect((await runCli(['import'])).code).toBe(2);
    expect((await runCli(['import', 'figma', streamFile, '--design-system', 'x', '--daemon-url', stub.baseUrl])).code).toBe(2);
    expect((await runCli(['import', 'a2ui', streamFile, '--daemon-url', stub.baseUrl])).code).toBe(2);
    expect((await runCli(['import', 'a2ui', '--design-system', 'agentic', '--daemon-url', stub.baseUrl])).code).toBe(2);
    const missing = await runCli(['import', 'a2ui', join(fixtureDir, 'nope.jsonl'), '--design-system', 'agentic', '--daemon-url', stub.baseUrl]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('cannot read');
  });

  it('exits 3 when the daemon is unreachable', async () => {
    const port = await reserveAndReleasePort();
    const run = await runCli(['import', 'a2ui', streamFile, '--design-system', 'agentic', '--daemon-url', `http://127.0.0.1:${port}`]);
    expect(run.code).toBe(3);
  });

  it('is discoverable from the root help output', async () => {
    const run = await runCli(['--help']);
    expect(run.stdout).toContain('od import a2ui <file|->');
  });
});
