import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const LOCAL_VERIFY = path.join(REPO_ROOT, "scripts", "local-verify.py");
const VALIDATE_PLAN = path.join(
  homedir(),
  ".gemini",
  "config",
  "skills",
  "async-local-ci-handoff",
  "scripts",
  "validate_tiered_ci_plan.py",
);
const SECURITY_DOCTOR = path.join(
  homedir(),
  ".gemini",
  "config",
  "skills",
  "shared-security-scanner-data",
  "scripts",
  "doctor.py",
);
const KEV_CORRELATE = path.join(
  homedir(),
  ".gemini",
  "config",
  "skills",
  "kev-sbom-correlation",
  "scripts",
  "security_cve_kev_correlate.py",
);
const HAS_HOST_SKILL_SCRIPTS =
  existsSync(VALIDATE_PLAN) && existsSync(SECURITY_DOCTOR) && existsSync(KEV_CORRELATE);
const HAS_ROOTLESS_PODMAN =
  spawnSync("podman", ["--remote=false", "info", "--format", "{{.Host.Security.Rootless}}"], {
    encoding: "utf8",
    timeout: 10_000,
  }).stdout?.trim().toLowerCase() === "true";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runPython(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) {
  return spawnSync("python3", args, {
    cwd: options?.cwd ?? REPO_ROOT,
    env: options?.env ?? process.env,
    input: options?.input,
    encoding: "utf8",
    timeout: 90_000,
  });
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Bot",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test Bot",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      ...env,
    },
    encoding: "utf8",
  }).trim();
}

async function listPythonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") continue;
      results.push(...(await listPythonFiles(full)));
    } else if (entry.name.endsWith(".py")) {
      results.push(full);
    }
  }
  return results;
}

function buildSyntheticToken(): string {
  // Dynamically constructed so this test file contains zero literal secret patterns.
  const prefix = ["g", "h", "p", "_"].join("");
  const body = ["A1b2C3d4", "E5f6G7h8", "I9j0K1l2", "M3n4O5p6", "Q7r8"].join("");
  return `${prefix}${body}`;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("governed contracts and script I/O closure", () => {
  test.skipIf(!HAS_HOST_SKILL_SCRIPTS)("validates .agents/tiered-ci-plan.json against all 15 invariants", () => {
    const res = runPython([VALIDATE_PLAN, "--plan", path.join(REPO_ROOT, ".agents", "tiered-ci-plan.json"), "--format", "json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.status).toBe("pass");
    expect(parsed.findings).toEqual([]);
  });

  test.skipIf(!HAS_HOST_SKILL_SCRIPTS)("validates .agents/security-scanner-data.json via shared-security-scanner-data doctor", () => {
    const res = runPython([SECURITY_DOCTOR, "--repo", REPO_ROOT, "--format", "json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.status).toBe("ready");
  });

  test("requires # localci:reads header annotation on every Python script under scripts/", async () => {
    const files = await listPythonFiles(path.join(REPO_ROOT, "scripts"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const content = await readFile(file, "utf8");
      const head = content.slice(0, 512);
      expect(head, `${path.relative(REPO_ROOT, file)} must declare # localci:reads`).toContain("# localci:reads ");
    }
  });
});

describe("Topology A broker sealed plan and zero-output invariants", () => {
  const dummyOid = "a".repeat(40);
  const dummyTree = "b".repeat(40);
  const dummyBase = "c".repeat(40);

  function checkPlanPayload(payload: unknown): { ok: boolean; code?: string } {
    const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, "scripts"))})
from local_ci.broker import validate_handoff_plan
from local_ci.common import LocalCiError
payload = json.loads(sys.argv[1])
try:
    validate_handoff_plan(payload, verify_git=False)
    print(json.dumps({"ok": True}))
except LocalCiError as exc:
    print(json.dumps({"ok": False, "code": exc.code, "error": str(exc)}))
`;
    const res = runPython(["-c", script, JSON.stringify(payload)]);
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout);
  }

  test("accepts valid sealed handoff plan and rejects command/callback/mutable payloads", () => {
    const basePlan = {
      schema: "ci-handoff-plan/v1",
      run_id: "ci-test-001",
      profile: "security",
      commit_oid: dummyOid,
      tree_oid: dummyTree,
      base_oid: dummyBase,
      lanes: ["gitleaks_tree", "sbom_kev"],
      container_mode: "auto",
      allow_upstream_cve_drift: false,
      max_heavy_workers: 2,
    };
    expect(checkPlanPayload(basePlan).ok).toBe(true);

    for (const forbiddenKey of ["command", "shell", "script", "callback_url", "webhook"]) {
      const bad = checkPlanPayload({ ...basePlan, [forbiddenKey]: "evil" });
      expect(bad.ok).toBe(false);
      expect(bad.code).toBe("FORBIDDEN_PLAN_FIELD");
    }

    const mutable = checkPlanPayload({ ...basePlan, commit_oid: "HEAD" });
    expect(mutable.ok).toBe(false);
    expect(mutable.code).toBe("MUTABLE_OR_INVALID_OID");

    const badLane = checkPlanPayload({ ...basePlan, lanes: ["rm-rf-lane"] });
    expect(badLane.ok).toBe(false);
    expect(badLane.code).toBe("UNKNOWN_LANE");
  });

  test("rejects zero-output false green on test lanes", () => {
    const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, "scripts"))})
from local_ci.broker import validate_zero_output
print(json.dumps({
    "empty": validate_zero_output("", ["passed"]),
    "missing_marker": validate_zero_output("done ok", ["Test Files", "passed"]),
    "valid": validate_zero_output("Test Files  1 passed (1)\\n", ["Test Files", "passed"]),
}))
`;
    const res = runPython(["-c", script]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.empty[0]).toBe(false);
    expect(parsed.missing_marker[0]).toBe(false);
    expect(parsed.valid[0]).toBe(true);
  });
});

describe("Gitleaks staged-index and pushed-ref-range offline enforcement", () => {
  async function initTempConsumerRepo(): Promise<string> {
    const repo = await makeTempDir("od-gl-test-");
    git(repo, ["init", "-b", "main"]);
    await mkdir(path.join(repo, ".agents"), { recursive: true });
    await cp(
      path.join(REPO_ROOT, ".agents", "security-scanner-data.json"),
      path.join(repo, ".agents", "security-scanner-data.json"),
    );
    await writeFile(path.join(repo, "README.md"), "# temp test repo\n", "utf8");
    git(repo, ["add", "-f", ".agents/security-scanner-data.json", "README.md"]);
    git(repo, ["commit", "--no-verify", "-m", "initial clean commit"]);
    return repo;
  }

  test.skipIf(!HAS_ROOTLESS_PODMAN)("t0-precommit passes clean staged file and blocks staged synthetic token without printing secret", async () => {
    const repo = await initTempConsumerRepo();
    await writeFile(path.join(repo, "clean.ts"), "export const ok = 42;\n", "utf8");
    git(repo, ["add", "clean.ts"]);

    const cleanRes = runPython([LOCAL_VERIFY, "--repo", repo, "t0-precommit"]);
    expect(cleanRes.status).toBe(0);
    expect(cleanRes.stdout).toContain("t0-precommit PASS");

    const token = buildSyntheticToken();
    await writeFile(path.join(repo, "leak.ts"), `export const tok = "${token}";\n`, "utf8");
    git(repo, ["add", "leak.ts"]);

    const leakRes = runPython([LOCAL_VERIFY, "--repo", repo, "t0-precommit"]);
    expect(leakRes.status).toBe(2);
    expect(leakRes.stdout).toContain("REDACTED");
    expect(leakRes.stdout).not.toContain(token);
    expect(leakRes.stderr).not.toContain(token);
  });

  test.skipIf(!HAS_ROOTLESS_PODMAN)("t0-prepush binds exact pushed-ref-range and catches committed synthetic token", async () => {
    const repo = await initTempConsumerRepo();
    const baseOid = git(repo, ["rev-parse", "HEAD"]);
    const token = buildSyntheticToken();
    await writeFile(path.join(repo, "pushed-leak.ts"), `export const secret = "${token}";\n`, "utf8");
    git(repo, ["add", "pushed-leak.ts"]);
    git(repo, ["commit", "--no-verify", "-m", "commit containing secret"]);
    const newOid = git(repo, ["rev-parse", "HEAD"]);

    const stdinPayload = `refs/heads/main ${newOid} refs/heads/main ${baseOid}\n`;
    const res = runPython([LOCAL_VERIFY, "--repo", repo, "t0-prepush"], { input: stdinPayload });
    expect(res.status).toBe(2);
    expect(res.stdout).toContain("pushed-ref-range");
    expect(res.stdout).toContain("REDACTED");
    expect(res.stdout).not.toContain(token);
  });
});

describe("SBOM-CVE/KEV fail-closed governance", () => {
  test.skipIf(!HAS_ROOTLESS_PODMAN)("fails closed when security-data provider root is missing or invalid", () => {
    const res = runPython([LOCAL_VERIFY, "--repo", REPO_ROOT, "sbom-kev", "--mode", "revision", "--revision", "HEAD"], {
      env: { ...process.env, ACLAB_SECURITY_DATA_PROVIDER_ROOT: "/nonexistent-provider-root-test" },
    });
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain("PROVIDER");
  });

  test.skipIf(!HAS_HOST_SKILL_SCRIPTS)("correlator fails on mismatched expected KEV sha256 and gate blocks kev_listed > 0", async () => {
    const tmp = await makeTempDir("od-kev-neg-");
    const sbomPath = path.join(tmp, "sbom.cdx.json");
    const cvePath = path.join(tmp, "cve.json");
    const kevPath = path.join(tmp, "kev.json");
    await writeFile(
      sbomPath,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        components: [{ type: "library", name: "pkg", version: "1.0.0", "bom-ref": "pkg@1.0.0" }],
        vulnerabilities: [{ id: "CVE-2025-99999", affects: [{ ref: "pkg@1.0.0" }] }],
      }),
    );
    await writeFile(
      cvePath,
      JSON.stringify({
        schema: "cve-catalog-snapshot/v1",
        catalog_version: "test",
        date_released: "2026-11-25T00:00:00Z",
        complete: false,
        completeness: "not-asserted-by-source-schema",
        count: 1,
        records: [{ cveID: "CVE-2025-99999" }],
      }),
    );
    await writeFile(
      kevPath,
      JSON.stringify({
        catalogVersion: "test",
        dateReleased: "2026-11-25T00:00:00Z",
        count: 1,
        vulnerabilities: [
          {
            cveID: "CVE-2025-99999",
            vendorProject: "vendor",
            product: "prod",
            vulnerabilityName: "name",
            dateAdded: "2026-01-01",
            shortDescription: "desc",
            requiredAction: "patch",
            dueDate: "2026-02-01",
          },
        ],
      }),
    );

    const corrMismatch = runPython([
      KEV_CORRELATE,
      `open-design=${sbomPath}`,
      "--cve-catalog",
      cvePath,
      "--kev-catalog",
      kevPath,
      "--expect-kev-sha256",
      "0".repeat(64),
      "--format",
      "json",
    ]);
    expect(corrMismatch.status).toBe(2);
    expect(corrMismatch.stdout).toContain("pin-mismatch");

    const corrOk = runPython([
      KEV_CORRELATE,
      `open-design=${sbomPath}`,
      "--cve-catalog",
      cvePath,
      "--kev-catalog",
      kevPath,
      "--format",
      "json",
    ]);
    expect(corrOk.status).toBe(0);
    const gateScript = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, "scripts"))})
from local_ci.sbom_kev_gate import evaluate_correlation_gate
payload = json.loads(sys.argv[1])
ok, exit_code, reason = evaluate_correlation_gate(payload, allow_upstream_cve_drift=True)
print(json.dumps({"ok": ok, "exit_code": exit_code, "reason": reason}))
`;
    const gateRes = runPython(["-c", gateScript, corrOk.stdout]);
    expect(gateRes.status).toBe(0);
    const gateParsed = JSON.parse(gateRes.stdout);
    expect(gateParsed.ok).toBe(false);
    expect(gateParsed.exit_code).toBe(2);
  });
});

describe("upstream drift and conflict prediction", () => {
  test("predicts clean merges vs real conflicts without mutating main and prepares isolated sync branch", async () => {
    const tmp = await makeTempDir("od-upsync-test-");
    const upRepo = path.join(tmp, "upstream");
    const forkRepo = path.join(tmp, "fork");
    await mkdir(upRepo);
    await mkdir(forkRepo);

    git(upRepo, ["init", "-b", "main"]);
    await writeFile(path.join(upRepo, ".gitignore"), ".tmp/\n", "utf8");
    await writeFile(path.join(upRepo, "shared.txt"), "base line\n", "utf8");
    git(upRepo, ["add", ".gitignore", "shared.txt"]);
    git(upRepo, ["commit", "-m", "base commit"]);
    const baseOid = git(upRepo, ["rev-parse", "HEAD"]);

    git(forkRepo, ["clone", upRepo, "."]);
    git(forkRepo, ["remote", "add", "upstream", upRepo]);
    await writeFile(path.join(forkRepo, "fork-only.txt"), "fork addition\n", "utf8");
    git(forkRepo, ["add", "fork-only.txt"]);
    git(forkRepo, ["commit", "-m", "fork additive change"]);

    // Upstream adds non-overlapping file
    await writeFile(path.join(upRepo, "upstream-only.txt"), "upstream feature\n", "utf8");
    git(upRepo, ["add", "upstream-only.txt"]);
    git(upRepo, ["commit", "-m", "upstream clean feature"]);
    const cleanUpstreamOid = git(upRepo, ["rev-parse", "HEAD"]);
    git(forkRepo, ["fetch", "upstream", "main"]);

    const checkClean = runPython([
      LOCAL_VERIFY,
      "--repo",
      forkRepo,
      "upstream-check",
      "--upstream-ref",
      cleanUpstreamOid,
      "--fork-ref",
      "HEAD",
      "--format",
      "json",
    ]);
    expect(checkClean.status).toBe(0);
    const cleanParsed = JSON.parse(checkClean.stdout);
    expect(cleanParsed.status).toBe("clean_merge_ready");
    expect(cleanParsed.merge_forecast.merge_clean).toBe(true);
    expect(cleanParsed.overlapping_files).toEqual([]);
    expect(cleanParsed.merge_base).toBe(baseOid);

    // Prepare isolated sync branch without mutating fork main
    const forkMainBefore = git(forkRepo, ["rev-parse", "main"]);
    const syncRes = runPython([
      LOCAL_VERIFY,
      "--repo",
      forkRepo,
      "upstream-sync",
      "--no-fetch",
      "--no-ci",
      "--upstream-ref",
      cleanUpstreamOid,
      "--base-ref",
      "main",
    ]);
    expect(syncRes.status).toBe(0);
    const syncParsed = JSON.parse(syncRes.stdout);
    expect(syncParsed.status).toBe("ready_for_review");
    expect(syncParsed.sync_branch).toMatch(/^sync\/upstream-/);
    expect(git(forkRepo, ["rev-parse", "main"])).toBe(forkMainBefore);

    // Now test real textual conflict on shared.txt
    await writeFile(path.join(forkRepo, "shared.txt"), "fork conflict edit\n", "utf8");
    git(forkRepo, ["add", "shared.txt"]);
    git(forkRepo, ["commit", "-m", "fork touches shared"]);

    await writeFile(path.join(upRepo, "shared.txt"), "upstream conflict edit\n", "utf8");
    git(upRepo, ["add", "shared.txt"]);
    git(upRepo, ["commit", "-m", "upstream touches shared"]);
    const conflictUpstreamOid = git(upRepo, ["rev-parse", "HEAD"]);
    git(forkRepo, ["fetch", "upstream", "main"]);

    const checkConflict = runPython([
      LOCAL_VERIFY,
      "--repo",
      forkRepo,
      "upstream-check",
      "--upstream-ref",
      conflictUpstreamOid,
      "--fork-ref",
      "HEAD",
      "--format",
      "json",
    ]);
    expect(checkConflict.status).toBe(0);
    const conflictParsed = JSON.parse(checkConflict.stdout);
    expect(conflictParsed.status).toBe("conflict_manual_resolution_required");
    expect(conflictParsed.merge_forecast.merge_clean).toBe(false);
    expect(conflictParsed.merge_forecast.conflicting_files).toContain("shared.txt");
    expect(git(forkRepo, ["status", "--short"])).toBe("");
  });
});

describe("daily-audit and fail-closed CLI flags", () => {
  test("parses upstream-sync --wait-timeout CLI flag", () => {
    const helpRes = runPython([LOCAL_VERIFY, "upstream-sync", "--help"]);
    expect(helpRes.status).toBe(0);
    expect(helpRes.stdout).toContain("--wait-timeout");
  });

  test.skipIf(!HAS_ROOTLESS_PODMAN)("fails closed on daily-audit without provider", () => {
    const auditRes = runPython([LOCAL_VERIFY, "--repo", REPO_ROOT, "daily-audit", "--no-fetch", "--format", "json"], {
      env: { ...process.env, ACLAB_SECURITY_DATA_PROVIDER_ROOT: "/nonexistent-provider-root-test" },
    });
    expect(auditRes.status).not.toBe(0);
    expect(auditRes.stdout).toMatch(/PROVIDER|PODMAN/);
  });
});
