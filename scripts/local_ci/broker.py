# localci:reads .agents/security-scanner-data.json,.agents/tiered-ci-plan.json,.github/config/scopes.json,pnpm-lock.yaml
"""Topology A Thin Local Handoff Broker, Sealed Plan Validator, and Clean-Container Runner."""

from __future__ import annotations

from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
from typing import Any, Callable, Mapping, Sequence

from . import HANDOFF_PLAN_SCHEMA, HANDOFF_RECEIPT_SCHEMA, TIERED_PLAN_SCHEMA
from .common import (
    DEFAULT_SECURITY_DOCTOR_SCRIPT,
    DEFAULT_VALIDATE_PLAN_SCRIPT,
    PODMAN_COMMAND_PREFIX,
    SHA1_RE,
    LocalCiError,
    atomic_write_json,
    cleanup_temp_dir,
    compute_candidate_identity,
    ensure_rootless_podman,
    git_common_dir,
    hermetic_subprocess_env,
    inspect_local_image_id,
    pinned_scanner_image,
    repo_root,
    resolve_git_oid,
    resolve_tool_script,
    resolved_node24_bin,
    rootless_podman_environment,
    run_id_nonce,
    run_with_process_group,
    runtime_dir,
    sha256_bytes,
)

ALLOWED_PLAN_KEYS = frozenset({
    "schema",
    "run_id",
    "profile",
    "commit_oid",
    "tree_oid",
    "base_oid",
    "lanes",
    "container_mode",
    "allow_upstream_cve_drift",
    "max_heavy_workers",
})
FORBIDDEN_PLAN_KEYS = frozenset({
    "command",
    "commands",
    "shell",
    "script",
    "scripts",
    "argv",
    "cmd",
    "exec",
    "callback_url",
    "webhook",
    "notify_url",
    "remote_url",
    "hook_url",
})
CONTAINER_MODES = frozenset({"auto", "required", "host"})
TERMINAL_STATUSES = frozenset({"pass", "fail", "timeout", "cancelled", "unavailable"})
LOAD1_OPT_OUT_ENV = "OPEN_DESIGN_LOCAL_CI_DISABLE_LOAD1_CAP"
DEFAULT_MAX_LOAD1 = 6.0


@dataclass(frozen=True)
class LaneSpec:
    name: str
    kind: str  # "python" | "host_cmd" | "container_cmd"
    needs_node_workspace: bool
    needs_prebuild: bool
    package_lock: str
    heavy: bool
    timeout_s: int
    zero_output_markers: tuple[str, ...]
    command: tuple[str, ...] = ()
    internal_fn: str = ""


LANE_TABLE: dict[str, LaneSpec] = {
    "tiered_plan_validate": LaneSpec(
        name="tiered_plan_validate",
        kind="python",
        needs_node_workspace=False,
        needs_prebuild=False,
        package_lock="contract-tiered-plan",
        heavy=False,
        timeout_s=60,
        zero_output_markers=('"status": "pass"',),
        internal_fn="lane_tiered_plan_validate",
    ),
    "scanner_contract_doctor": LaneSpec(
        name="scanner_contract_doctor",
        kind="python",
        needs_node_workspace=False,
        needs_prebuild=False,
        package_lock="contract-scanner-data",
        heavy=False,
        timeout_s=60,
        zero_output_markers=('"status": "ready"',),
        internal_fn="lane_scanner_contract_doctor",
    ),
    "gitleaks_tree": LaneSpec(
        name="gitleaks_tree",
        kind="python",
        needs_node_workspace=False,
        needs_prebuild=False,
        package_lock="security-gitleaks",
        heavy=False,
        timeout_s=240,
        zero_output_markers=('"schema": "open-design-gitleaks-receipt/v1"',),
        internal_fn="lane_gitleaks_tree",
    ),
    "gitleaks_range": LaneSpec(
        name="gitleaks_range",
        kind="python",
        needs_node_workspace=False,
        needs_prebuild=False,
        package_lock="security-gitleaks",
        heavy=False,
        timeout_s=240,
        zero_output_markers=('"schema": "open-design-gitleaks-receipt/v1"',),
        internal_fn="lane_gitleaks_range",
    ),
    "sbom_kev": LaneSpec(
        name="sbom_kev",
        kind="python",
        needs_node_workspace=False,
        needs_prebuild=False,
        package_lock="security-sbom-kev",
        heavy=True,
        timeout_s=360,
        zero_output_markers=('"schema": "open-design-sbom-kev-receipt/v1"',),
        internal_fn="lane_sbom_kev",
    ),
    "static_gate": LaneSpec(
        name="static_gate",
        kind="python",
        needs_node_workspace=False,
        needs_prebuild=False,
        package_lock="static-gate",
        heavy=False,
        timeout_s=120,
        zero_output_markers=("static_gate passed",),
        internal_fn="lane_static_gate",
    ),
    "pnpm_guard": LaneSpec(
        name="pnpm_guard",
        kind="host_cmd",
        needs_node_workspace=True,
        needs_prebuild=True,
        package_lock="repo-guard",
        heavy=False,
        timeout_s=240,
        zero_output_markers=("Residual JavaScript check passed:", "Package dependency spec check passed:"),
        command=("pnpm", "guard"),
    ),
    "pnpm_i18n_check": LaneSpec(
        name="pnpm_i18n_check",
        kind="host_cmd",
        needs_node_workspace=True,
        needs_prebuild=False,
        package_lock="repo-i18n",
        heavy=False,
        timeout_s=120,
        zero_output_markers=("i18n P0 check passed",),
        command=("pnpm", "i18n:check"),
    ),
    "pnpm_typecheck": LaneSpec(
        name="pnpm_typecheck",
        kind="host_cmd",
        needs_node_workspace=True,
        needs_prebuild=True,
        package_lock="repo-typecheck",
        heavy=True,
        timeout_s=600,
        zero_output_markers=("Scope:",),
        command=("pnpm", "typecheck"),
    ),
    "script_contract_tests": LaneSpec(
        name="script_contract_tests",
        kind="host_cmd",
        needs_node_workspace=True,
        needs_prebuild=False,
        package_lock="e2e-scripts",
        heavy=False,
        timeout_s=300,
        zero_output_markers=("Test Files", "passed"),
        command=("pnpm", "--filter", "@open-design/e2e", "exec", "vitest", "run", "tests/scripts/local-ci-fork.test.ts"),
    ),
    "preflight": LaneSpec(
        name="preflight",
        kind="host_cmd",
        needs_node_workspace=True,
        needs_prebuild=True,
        package_lock="repo-preflight",
        heavy=True,
        timeout_s=900,
        zero_output_markers=("i18n P0 check passed",),
        command=(
            "bash",
            "-lc",
            "pnpm -r --filter '!open-design' --workspace-concurrency=1 --if-present run typecheck "
            "&& pnpm exec tsc -p scripts/tsconfig.json --noEmit "
            "&& pnpm guard "
            "&& pnpm i18n:check",
        ),
    ),
    "workspace_unit_tests": LaneSpec(
        name="workspace_unit_tests",
        kind="host_cmd",
        needs_node_workspace=True,
        needs_prebuild=True,
        package_lock="workspace-pkgs",
        heavy=True,
        timeout_s=900,
        zero_output_markers=("Test Files", "passed"),
        command=(
            "bash",
            "-lc",
            "for pkg in @open-design/contracts @open-design/host @open-design/launcher-proto "
            "@open-design/launcher @open-design/sidecar @open-design/sidecar-proto "
            "@open-design/tools-dev @open-design/desktop @open-design/packaged @open-design/tools-pack; do "
            "pnpm --filter \"$pkg\" test || exit 1; done",
        ),
    ),
    "e2e_vitest": LaneSpec(
        name="e2e_vitest",
        kind="container_cmd",
        needs_node_workspace=True,
        needs_prebuild=True,
        package_lock="pkg-e2e",
        heavy=True,
        timeout_s=1200,
        zero_output_markers=("Test Files", "passed"),
        command=("pnpm", "--filter", "@open-design/e2e", "test"),
    ),
    "playwright_critical": LaneSpec(
        name="playwright_critical",
        kind="container_cmd",
        needs_node_workspace=True,
        needs_prebuild=True,
        package_lock="pkg-playwright",
        heavy=True,
        timeout_s=1800,
        zero_output_markers=("passed",),
        command=("bash", "-lc", "pnpm -C e2e exec tsx scripts/playwright.ts clean && pnpm -C e2e exec playwright test -c playwright.config.ts --grep '@critical'"),
    ),
}

for _shard in range(1, 5):
    LANE_TABLE[f"daemon_unit_{_shard}"] = LaneSpec(
        name=f"daemon_unit_{_shard}",
        kind="container_cmd",
        needs_node_workspace=True,
        needs_prebuild=True,
        package_lock=f"pkg-daemon-{_shard}",
        heavy=True,
        timeout_s=1200,
        zero_output_markers=("Test Files", "passed"),
        command=("pnpm", "--filter", "@open-design/daemon", "test", f"--shard={_shard}/4"),
    )

for _shard in range(1, 3):
    LANE_TABLE[f"web_workspace_{_shard}"] = LaneSpec(
        name=f"web_workspace_{_shard}",
        kind="host_cmd",
        needs_node_workspace=True,
        needs_prebuild=True,
        package_lock=f"pkg-web-{_shard}",
        heavy=True,
        timeout_s=900,
        zero_output_markers=("Test Files", "passed"),
        command=("pnpm", "--filter", "@open-design/web", "exec", "vitest", "run", "-c", "vitest.config.ts", "--maxWorkers=2", f"--shard={_shard}/2"),
    )

for _ui_shard in (
    "entry-settings",
    "project-workspace",
    "project-workspace-editor",
    "project-collab",
    "project-runtime",
    "workspace-restoration",
):
    _lname = f"ui_p0_{_ui_shard.replace('-', '_')}"
    LANE_TABLE[_lname] = LaneSpec(
        name=_lname,
        kind="container_cmd",
        needs_node_workspace=True,
        needs_prebuild=True,
        package_lock=f"pkg-ui-{_ui_shard}",
        heavy=True,
        timeout_s=1800,
        zero_output_markers=("passed",),
        command=("bash", "-lc", f"pnpm -C e2e exec tsx scripts/playwright.ts clean && pnpm -C e2e exec tsx scripts/playwright.ts run-ui-group {_ui_shard}"),
    )

PROFILES = ("fast", "security", "pr-scoped", "upstream-sync", "full")


def validate_zero_output(output: str, required_markers: Sequence[str]) -> tuple[bool, str | None]:
    """Ensure a zero exit code did not hide empty or zero-test execution."""
    stripped = output.strip()
    if not stripped:
        return False, "zero_output_false_green: command produced empty output"
    for marker in required_markers:
        if marker not in output:
            return False, f"zero_output_false_green: missing expected output marker {marker!r}"
    return True, None


def validate_handoff_plan(
    plan: Any,
    *,
    repo: Path | None = None,
    verify_git: bool = True,
) -> dict[str, Any]:
    """Fail-closed validation for sealed Topology A `ci-handoff-plan/v1` documents."""
    if not isinstance(plan, dict):
        raise LocalCiError("Handoff plan must be a JSON object", code="INVALID_HANDOFF_PLAN")
    if plan.get("schema") != HANDOFF_PLAN_SCHEMA:
        raise LocalCiError(f"Handoff plan schema must be '{HANDOFF_PLAN_SCHEMA}'", code="INVALID_HANDOFF_PLAN")

    keys = set(plan)
    forbidden = sorted(keys & FORBIDDEN_PLAN_KEYS)
    if forbidden:
        raise LocalCiError(
            f"Handoff plan forbids command/callback keys: {', '.join(forbidden)}",
            code="FORBIDDEN_PLAN_FIELD",
        )
    unknown = sorted(keys - ALLOWED_PLAN_KEYS)
    if unknown:
        raise LocalCiError(
            f"Handoff plan contains unknown keys: {', '.join(unknown)}",
            code="UNKNOWN_PLAN_FIELD",
        )

    for req in ("run_id", "profile", "commit_oid", "tree_oid", "base_oid", "lanes"):
        if req not in plan:
            raise LocalCiError(f"Handoff plan missing required key '{req}'", code="INVALID_HANDOFF_PLAN")

    if not isinstance(plan["run_id"], str) or not plan["run_id"].strip():
        raise LocalCiError("Handoff plan run_id must be non-empty", code="INVALID_HANDOFF_PLAN")
    if plan["profile"] not in PROFILES:
        raise LocalCiError(f"Unsupported profile: {plan['profile']!r}", code="INVALID_PROFILE")

    for oid_key in ("commit_oid", "tree_oid", "base_oid"):
        val = plan[oid_key]
        if not isinstance(val, str) or not SHA1_RE.fullmatch(val):
            raise LocalCiError(
                f"Handoff plan '{oid_key}' must be an immutable 40-hex Git OID (got {val!r})",
                code="MUTABLE_OR_INVALID_OID",
            )

    lanes = plan["lanes"]
    if not isinstance(lanes, list) or not lanes or any(not isinstance(x, str) for x in lanes):
        raise LocalCiError("Handoff plan lanes must be a non-empty list of lane IDs", code="INVALID_LANES")
    if len(set(lanes)) != len(lanes):
        raise LocalCiError("Handoff plan lanes contains duplicates", code="INVALID_LANES")
    unknown_lanes = [x for x in lanes if x not in LANE_TABLE]
    if unknown_lanes:
        raise LocalCiError(f"Unknown lane identifier(s): {', '.join(unknown_lanes)}", code="UNKNOWN_LANE")

    container_mode = plan.get("container_mode", "auto")
    if container_mode not in CONTAINER_MODES:
        raise LocalCiError(f"Invalid container_mode: {container_mode!r}", code="INVALID_CONTAINER_MODE")

    max_workers = plan.get("max_heavy_workers", 2)
    if type(max_workers) is not int or max_workers < 1 or max_workers > 8:
        raise LocalCiError("max_heavy_workers must be an integer between 1 and 8", code="INVALID_CONCURRENCY")

    if verify_git and repo is not None:
        actual_tree = resolve_git_oid(repo, plan["commit_oid"], obj_type="tree")
        if actual_tree != plan["tree_oid"]:
            raise LocalCiError(
                f"commit_oid tree {actual_tree} != declared tree_oid {plan['tree_oid']}",
                code="TREE_OID_MISMATCH",
            )
        resolve_git_oid(repo, plan["base_oid"], obj_type="commit")

    return dict(plan)


def _scopes_lanes_for_diff(repo: Path, base_oid: str, commit_oid: str, *, full: bool = False) -> list[str]:
    scopes_py = repo / ".github" / "scripts" / "scopes.py"
    if not scopes_py.is_file():
        return ["preflight"]
    if full:
        proc = subprocess.run(
            [sys.executable, str(scopes_py), "plan", "--context", "full"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
    else:
        diff = subprocess.run(
            ["git", "diff", "--name-only", f"{base_oid}..{commit_oid}"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        files = [line for line in diff.stdout.splitlines() if line.strip()]
        proc = subprocess.run(
            [sys.executable, str(scopes_py), "plan", "--context", "pr", "--files-from", "-"],
            cwd=repo,
            input="\n".join(files) + "\n",
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
    parsed = json.loads(proc.stdout)
    enabled = parsed.get("enabled", {})
    selected = [k for k, v in enabled.items() if v is True and k in LANE_TABLE]
    return selected


def select_lanes(
    repo: Path,
    *,
    profile: str,
    commit_oid: str,
    base_oid: str,
    explicit_lanes: Sequence[str] | None = None,
) -> list[str]:
    if explicit_lanes:
        return list(dict.fromkeys(explicit_lanes))
    if profile == "security":
        return ["scanner_contract_doctor", "tiered_plan_validate", "gitleaks_tree", "sbom_kev"]
    if profile == "fast":
        return ["scanner_contract_doctor", "tiered_plan_validate", "gitleaks_tree", "static_gate", "pnpm_i18n_check"]
    if profile == "pr-scoped":
        scoped = _scopes_lanes_for_diff(repo, base_oid, commit_oid, full=False)
        return list(dict.fromkeys(["scanner_contract_doctor", "gitleaks_tree", "sbom_kev", *scoped]))
    if profile == "upstream-sync":
        scoped = _scopes_lanes_for_diff(repo, base_oid, commit_oid, full=False)
        return list(dict.fromkeys(["scanner_contract_doctor", "gitleaks_range", "sbom_kev", *scoped]))
    if profile == "full":
        scoped = _scopes_lanes_for_diff(repo, base_oid, commit_oid, full=True)
        return list(dict.fromkeys(["scanner_contract_doctor", "tiered_plan_validate", "gitleaks_tree", "sbom_kev", *scoped]))
    raise LocalCiError(f"Unsupported profile: {profile!r}", code="INVALID_PROFILE")


def _materialize_run_tiered_plan(
    repo: Path,
    *,
    run_dir: Path,
    cid: Mapping[str, Any],
    workers: Sequence[Mapping[str, Any]],
    max_heavy_workers: int,
    output_digest: str,
) -> Path:
    base_plan = json.loads((repo / ".agents" / "tiered-ci-plan.json").read_text(encoding="utf-8"))
    base_plan["schema"] = TIERED_PLAN_SCHEMA
    base_plan["candidate"] = {
        "base_oid": cid["base_oid"],
        "tree_oid": cid["tree_oid"],
        "policy_digest": cid["policy_digest"],
        "lockfile_digest": cid["lockfile_digest"],
    }
    base_plan["receipt"]["tree_oid"] = cid["tree_oid"]
    base_plan["receipt"]["base_oid"] = cid["base_oid"]
    base_plan["receipt"]["policy_digest"] = cid["policy_digest"]
    base_plan["receipt"]["lockfile_digest"] = cid["lockfile_digest"]
    base_plan["receipt"]["output_digest"] = output_digest
    base_plan["receipt"]["content_hashing"]["bound_tree_oid"] = cid["tree_oid"]
    base_plan["receipt"]["content_hashing"]["precomputed_cid"] = cid["precomputed_cid"]
    base_plan["receipt"]["vcs_metadata_binding"]["head_oid"] = cid["head_oid"]
    base_plan["receipt"]["vcs_metadata_binding"]["ref_or_detached"] = cid["ref_or_detached"]
    base_plan["receipt"]["vcs_metadata_binding"]["sorted_exact_tags"] = cid["sorted_exact_tags"]
    base_plan["workers"] = list(workers)
    base_plan["concurrency_control"]["max_heavy_workers"] = max_heavy_workers

    plan_path = run_dir / "tiered-ci-plan.json"
    atomic_write_json(plan_path, base_plan)
    return plan_path


def submit_run(
    repo: Path,
    *,
    profile: str = "fast",
    revision: str = "HEAD",
    base_ref: str | None = None,
    lanes: Sequence[str] | None = None,
    container_mode: str = "auto",
    allow_upstream_cve_drift: bool = False,
    max_heavy_workers: int = 2,
    spawn_worker: bool = True,
) -> dict[str, Any]:
    """Create a sealed Topology A handoff plan and launch its detached async worker."""
    repo = repo.resolve()
    cid = compute_candidate_identity(repo, revision=revision, base_ref=base_ref)
    selected = select_lanes(
        repo,
        profile=profile,
        commit_oid=cid["head_oid"],
        base_oid=cid["base_oid"],
        explicit_lanes=lanes,
    )
    run_id = run_id_nonce("ci")
    plan = validate_handoff_plan(
        {
            "schema": HANDOFF_PLAN_SCHEMA,
            "run_id": run_id,
            "profile": profile,
            "commit_oid": cid["head_oid"],
            "tree_oid": cid["tree_oid"],
            "base_oid": cid["base_oid"],
            "lanes": selected,
            "container_mode": container_mode,
            "allow_upstream_cve_drift": bool(allow_upstream_cve_drift),
            "max_heavy_workers": max_heavy_workers,
        },
        repo=repo,
        verify_git=True,
    )

    run_dir = runtime_dir(repo) / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    plan_path = run_dir / "plan.json"
    state_path = run_dir / "state.json"
    receipt_path = run_dir / "receipt.json"
    atomic_write_json(plan_path, plan)
    atomic_write_json(
        state_path,
        {
            "schema": HANDOFF_RECEIPT_SCHEMA,
            "run_id": run_id,
            "status": "queued",
            "profile": profile,
            "commit_oid": cid["head_oid"],
            "tree_oid": cid["tree_oid"],
            "lanes": selected,
            "queued_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "worker_pid": None,
            "worker_pgid": None,
            "receipt_path": str(receipt_path),
        },
    )

    if spawn_worker:
        worker_log = run_dir / "worker-bootstrap.log"
        log_fh = worker_log.open("w", encoding="utf-8")
        try:
            proc = subprocess.Popen(
                [sys.executable, "-I", str(repo / "scripts" / "local-verify.py"), "_worker", "--run-id", run_id],
                cwd=str(repo),
                stdin=subprocess.DEVNULL,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        finally:
            log_fh.close()
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["worker_pid"] = proc.pid
        state["worker_pgid"] = proc.pid
        atomic_write_json(state_path, state)

    return {
        "schema": HANDOFF_RECEIPT_SCHEMA,
        "run_id": run_id,
        "status": "queued",
        "profile": profile,
        "commit_oid": cid["head_oid"],
        "tree_oid": cid["tree_oid"],
        "lanes": selected,
        "plan_path": str(plan_path),
        "state_path": str(state_path),
        "receipt_path": str(receipt_path),
    }


def _emit_heartbeat(run_dir: Path, lane: str, phase: str) -> float:
    try:
        load1 = float(os.getloadavg()[0])
    except (AttributeError, OSError):
        load1 = 0.0
    hb_path = run_dir / "heartbeats.jsonl"
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lane": lane,
        "phase": phase,
        "load1": round(load1, 2),
        "opt_out": bool(os.environ.get(LOAD1_OPT_OUT_ENV)),
    }
    with hb_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")
    return load1


def _acquire_package_lock(repo: Path, lock_name: str):
    lock_dir = runtime_dir(repo) / "locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_file = lock_dir / f"{lock_name}.lock"
    fh = lock_file.open("a+", encoding="utf-8")
    fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
    return fh


def _load1_throttle(run_dir: Path, lane: str, *, max_load1: float = DEFAULT_MAX_LOAD1) -> None:
    if os.environ.get(LOAD1_OPT_OUT_ENV, "").strip():
        _emit_heartbeat(run_dir, lane, "load1_opt_out")
        return
    for _ in range(6):
        load1 = _emit_heartbeat(run_dir, lane, "load1_probe")
        if load1 <= max_load1:
            return
        time.sleep(2.0)


def _resolved_pnpm_tool_dir() -> Path | None:
    env_dir = os.environ.get("OPEN_DESIGN_PNPM_DIR", "").strip()
    candidates = [Path(env_dir)] if env_dir else []
    candidates.append(Path.home() / ".proto" / "tools" / "pnpm" / "10.33.2")
    for cand in candidates:
        if (cand / "shims" / "pnpm").is_file():
            return cand.resolve()
    return None


def _jq_lib_mounts() -> list[str]:
    """Resolve host libjq / libonig shared libraries so bind-mounted /usr/bin/jq runs in container."""
    jq_bin = Path("/usr/bin/jq")
    if not jq_bin.is_file():
        return []
    mounts: list[str] = ["-v", f"{jq_bin}:{jq_bin}:ro"]
    proc = subprocess.run(["ldd", str(jq_bin)], capture_output=True, text=True, timeout=10, check=False)
    if proc.returncode != 0:
        return mounts
    seen_targets: set[str] = {str(jq_bin)}
    for line in proc.stdout.splitlines():
        if "=>" not in line:
            continue
        _, _, rhs = line.partition("=>")
        lib_raw = rhs.strip().split(" ", 1)[0].strip()
        if not lib_raw.startswith("/"):
            continue
        base = Path(lib_raw).name
        if not (base.startswith("libjq") or base.startswith("libonig")):
            continue
        resolved = Path(lib_raw).resolve()
        if not resolved.is_file():
            continue
        # Ubuntu merged-/usr containers symlink /lib -> /usr/lib; mount to /usr/lib/... if /lib/...
        target = f"/usr{lib_raw}" if lib_raw.startswith("/lib/") else lib_raw
        if target not in seen_targets:
            seen_targets.add(target)
            mounts.extend(["-v", f"{resolved}:{target}:ro"])
    return mounts


def _container_cmd_for_lane(
    repo: Path,
    wt_dir: Path,
    spec: LaneSpec,
    *,
    tmp_dir: Path,
) -> list[str]:
    ensure_rootless_podman()
    pw_image = pinned_scanner_image(repo, "playwright")
    inspect_local_image_id(pw_image)
    node_bin = resolved_node24_bin()
    if not node_bin:
        raise LocalCiError("Node 24 toolchain directory missing for Playwright container", code="NODE24_UNAVAILABLE")

    node_root = Path(node_bin).parent
    wt_resolved = wt_dir.resolve()
    repo_resolved = repo.resolve()
    common_dir = git_common_dir(repo_resolved)
    path_parts = [str(node_root / "bin")]
    mounts: list[str] = [
        "-v",
        f"{wt_resolved}:{wt_resolved}:rw",
        "-v",
        f"{node_root.resolve()}:{node_root.resolve()}:ro",
    ]
    if common_dir != repo_resolved and not common_dir.is_relative_to(wt_resolved):
        mounts.extend(["-v", f"{common_dir}:{common_dir}:ro"])
    pnpm_dir = _resolved_pnpm_tool_dir()
    if pnpm_dir is not None:
        path_parts.append(str(pnpm_dir / "shims"))
        mounts.extend(["-v", f"{pnpm_dir}:{pnpm_dir}:ro"])
    path_parts.extend(["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"])

    cmd = [
        *PODMAN_COMMAND_PREFIX,
        "run",
        "--rm",
        "--init",
        "--pull=never",
        "--userns=keep-id",
        "--shm-size=2g",
        "--tmpfs",
        "/tmp:rw,exec,nosuid,size=8g",
        "-e",
        "HOME=/tmp/ci-home",
        "-e",
        "TMPDIR=/tmp",
        "-e",
        "SHELL=/bin/bash",
        "-e",
        "CI=1",
        "-e",
        "OPEN_DESIGN_LOCAL_CI=1",
        "-e",
        "GIT_CONFIG_COUNT=1",
        "-e",
        "GIT_CONFIG_KEY_0=safe.directory",
        "-e",
        "GIT_CONFIG_VALUE_0=*",
        "-e",
        f"PATH={':'.join(path_parts)}",
        *mounts,
        "-w",
        str(wt_resolved),
    ]
    pw_cache = Path.home() / ".cache" / "ms-playwright"
    if pw_cache.is_dir():
        cmd.extend(["-e", "PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-cache", "-v", f"{pw_cache.resolve()}:/tmp/pw-cache:ro"])
    cmd.extend(_jq_lib_mounts())
    if Path("/usr/bin/xdg-open").is_file():
        cmd.extend(["-v", "/usr/bin/xdg-open:/usr/bin/xdg-open:ro"])

    inner = " ".join(shlex.quote(arg) for arg in spec.command)
    cmd.extend([pw_image, "bash", "-lc", f"umask 0022 && mkdir -p /tmp/ci-home && {inner}"])
    return cmd


def _execute_lane(
    *,
    repo: Path,
    wt_dir: Path,
    run_dir: Path,
    plan: Mapping[str, Any],
    spec: LaneSpec,
    env: Mapping[str, str],
    tmp_dir: Path,
) -> dict[str, Any]:
    start = time.monotonic()
    log_path = run_dir / f"lane-{spec.name}.log"
    lock_fh = _acquire_package_lock(repo, spec.package_lock)
    try:
        if spec.heavy:
            _load1_throttle(run_dir, spec.name)
        else:
            _emit_heartbeat(run_dir, spec.name, "running")

        if spec.kind == "python":
            return _run_python_lane(repo=repo, wt_dir=wt_dir, run_dir=run_dir, plan=plan, spec=spec, log_path=log_path, start=start)

        use_container = False
        mode = plan.get("container_mode", "auto")
        if spec.kind == "container_cmd":
            if mode == "host":
                use_container = False
            elif mode == "required":
                use_container = True
            else:
                try:
                    ensure_rootless_podman()
                    inspect_local_image_id(pinned_scanner_image(repo, "playwright"))
                    use_container = True
                except LocalCiError:
                    raise LocalCiError(
                        f"Lane '{spec.name}' requires clean Playwright Podman container (--container-mode=host to override)",
                        code="CONTAINER_UNAVAILABLE",
                    )

        if use_container:
            cmd = _container_cmd_for_lane(repo, wt_dir, spec, tmp_dir=tmp_dir)
            cmd_env = rootless_podman_environment(env)
        else:
            cmd = list(spec.command)
            cmd_env = dict(env)

        rc, output, timed_out = run_with_process_group(
            cmd,
            cwd=wt_dir,
            env=cmd_env,
            timeout_s=spec.timeout_s,
            log_path=log_path,
        )
        elapsed = round(time.monotonic() - start, 2)
        if timed_out:
            return {
                "lane": spec.name,
                "status": "timeout",
                "claim_pass": False,
                "exit_code": 124,
                "duration_s": elapsed,
                "log_path": str(log_path),
                "detail": f"Timed out after {spec.timeout_s}s",
            }
        if rc != 0:
            return {
                "lane": spec.name,
                "status": "failed",
                "claim_pass": False,
                "exit_code": rc,
                "duration_s": elapsed,
                "log_path": str(log_path),
                "detail": f"Exited with code {rc}",
            }
        ok_zero, zero_reason = validate_zero_output(output, spec.zero_output_markers)
        if not ok_zero:
            return {
                "lane": spec.name,
                "status": "failed",
                "claim_pass": False,
                "exit_code": 1,
                "duration_s": elapsed,
                "log_path": str(log_path),
                "detail": zero_reason,
            }
        return {
            "lane": spec.name,
            "status": "pass",
            "claim_pass": True,
            "exit_code": 0,
            "duration_s": elapsed,
            "log_path": str(log_path),
            "output_sha256": sha256_bytes(output.encode("utf-8")),
        }
    except LocalCiError as exc:
        elapsed = round(time.monotonic() - start, 2)
        log_path.write_text(f"{exc.code}: {exc}\n", encoding="utf-8")
        return {
            "lane": spec.name,
            "status": "unavailable" if "UNAVAILABLE" in exc.code else "failed",
            "claim_pass": False,
            "exit_code": exc.exit_code,
            "duration_s": elapsed,
            "log_path": str(log_path),
            "detail": str(exc),
        }
    finally:
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)
        lock_fh.close()


def _run_python_lane(
    *,
    repo: Path,
    wt_dir: Path,
    run_dir: Path,
    plan: Mapping[str, Any],
    spec: LaneSpec,
    log_path: Path,
    start: float,
) -> dict[str, Any]:
    from . import gitleaks_gate, sbom_kev_gate

    fn = spec.internal_fn
    payload: dict[str, Any] = {}
    rc = 0
    if fn == "lane_scanner_contract_doctor":
        doc_script = resolve_tool_script("ACLAB_SECURITY_DOCTOR_SCRIPT", DEFAULT_SECURITY_DOCTOR_SCRIPT, "doctor.py")
        proc = subprocess.run(
            [sys.executable, str(doc_script), "--repo", str(wt_dir), "--format", "json"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        log_path.write_text(proc.stdout + proc.stderr, encoding="utf-8")
        rc = proc.returncode
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError:
            payload = {}
        ok = rc == 0 and payload.get("status") == "ready"
    elif fn == "lane_tiered_plan_validate":
        val_script = resolve_tool_script("ACLAB_VALIDATE_PLAN_SCRIPT", DEFAULT_VALIDATE_PLAN_SCRIPT, "validate_tiered_ci_plan.py")
        proc = subprocess.run(
            [sys.executable, str(val_script), "--plan", str(wt_dir / ".agents" / "tiered-ci-plan.json"), "--format", "json"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        log_path.write_text(proc.stdout + proc.stderr, encoding="utf-8")
        rc = proc.returncode
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError:
            payload = {}
        ok = rc == 0 and payload.get("status") == "pass"
    elif fn == "lane_gitleaks_tree":
        payload = gitleaks_gate.run_tree(repo, revision=plan["commit_oid"])
        text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
        log_path.write_text(text, encoding="utf-8")
        ok = payload.get("status") == "pass"
        rc = 0 if ok else 2
    elif fn == "lane_gitleaks_range":
        payload = gitleaks_gate.run_range(repo, ranges=[f"{plan['base_oid']}..{plan['commit_oid']}"])
        text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
        log_path.write_text(text, encoding="utf-8")
        ok = payload.get("status") == "pass"
        rc = 0 if ok else 2
    elif fn == "lane_sbom_kev":
        payload = sbom_kev_gate.run_sbom_kev(
            repo,
            mode="revision",
            revision=plan["commit_oid"],
            base_revision=plan["base_oid"],
            allow_upstream_cve_drift=bool(plan.get("allow_upstream_cve_drift")),
        )
        text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
        log_path.write_text(text, encoding="utf-8")
        ok = payload.get("status") == "pass"
        rc = int(payload.get("exit_code", 0 if ok else 2))
    elif fn == "lane_static_gate":
        tracked = subprocess.run(["git", "ls-files"], cwd=wt_dir, capture_output=True, text=True, timeout=20, check=True)
        tracked_files = tracked.stdout.splitlines()
        py_files = [wt_dir / rel for rel in tracked_files if rel.endswith(".py") and rel.startswith("scripts/")]
        missing_headers = [
            str(p.relative_to(wt_dir))
            for p in py_files
            if "# localci:reads " not in p.read_text(encoding="utf-8", errors="ignore")[:512]
        ]
        leaked_tmp = [rel for rel in tracked_files if rel.startswith(".tmp/")]
        ok = not missing_headers and not leaked_tmp
        rc = 0 if ok else 1
        out_txt = (
            f"static_gate passed (checked {len(py_files)} python scripts)"
            if ok
            else f"static_gate failed: missing_headers={missing_headers}, leaked_tmp={leaked_tmp}"
        )
        log_path.write_text(out_txt + "\n", encoding="utf-8")
    else:
        raise LocalCiError(f"Unknown internal lane handler: {fn}", code="UNKNOWN_LANE")

    elapsed = round(time.monotonic() - start, 2)
    return {
        "lane": spec.name,
        "status": "pass" if ok else "failed",
        "claim_pass": bool(ok),
        "exit_code": rc,
        "duration_s": elapsed,
        "log_path": str(log_path),
        "output_sha256": sha256_bytes(log_path.read_bytes()),
    }


def execute_worker(repo: Path, run_id: str) -> int:
    """Worker entrypoint executing a validated sealed plan in an isolated detached worktree."""
    repo = repo.resolve()
    run_dir = runtime_dir(repo) / "runs" / run_id
    plan_path = run_dir / "plan.json"
    state_path = run_dir / "state.json"
    receipt_path = run_dir / "receipt.json"

    plan = validate_handoff_plan(json.loads(plan_path.read_text(encoding="utf-8")), repo=repo, verify_git=True)
    cid = compute_candidate_identity(repo, revision=plan["commit_oid"], base_ref=plan["base_oid"])

    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["status"] = "running"
    state["started_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    atomic_write_json(state_path, state)

    wt_dir = runtime_dir(repo) / "worktrees" / run_id
    tmp_dir = Path("/tmp") / f"odci-{run_id[-8:]}"
    results: list[dict[str, Any]] = []
    boot_ok = True
    boot_err: str | None = None

    try:
        wt_dir.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["git", "worktree", "add", "--detach", str(wt_dir), plan["commit_oid"]],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=90,
            check=True,
        )
        # Copy tracked-or-worktree untracked/force-tracked configs? No: strictly immutable commit_oid!
        specs = [LANE_TABLE[name] for name in plan["lanes"]]
        needs_node = any(s.needs_node_workspace for s in specs)
        needs_prebuild = any(s.needs_prebuild for s in specs)
        env = hermetic_subprocess_env(tmp_dir)

        if needs_node:
            rc_inst, out_inst, to_inst = run_with_process_group(
                ["bash", "-lc", "pnpm install --offline --frozen-lockfile --ignore-scripts && OD_POSTINSTALL_INTENT=workspace pnpm bootstrap"],
                cwd=wt_dir,
                env=env,
                timeout_s=600,
                log_path=run_dir / "bootstrap-node.log",
            )
            if to_inst or rc_inst != 0:
                boot_ok = False
                boot_err = f"Offline workspace bootstrap failed ({rc_inst}): {out_inst[-400:]}"

        if boot_ok and needs_prebuild:
            rc_pre, out_pre, to_pre = run_with_process_group(
                ["bash", "-lc", "pnpm --filter @open-design/desktop build && pnpm --filter @open-design/web build:sidecar"],
                cwd=wt_dir,
                env=env,
                timeout_s=600,
                log_path=run_dir / "bootstrap-prebuild.log",
            )
            if to_pre or rc_pre != 0:
                boot_ok = False
                boot_err = f"Prebuild desktop/web sidecar failed ({rc_pre}): {out_pre[-400:]}"

        if boot_ok:
            for spec in specs:
                res = _execute_lane(
                    repo=repo,
                    wt_dir=wt_dir,
                    run_dir=run_dir,
                    plan=plan,
                    spec=spec,
                    env=env,
                    tmp_dir=tmp_dir,
                )
                results.append(res)
                if res["status"] != "pass":
                    # continue running remaining non-dependent diagnostic/security lanes cleanly? Keep going so receipt is complete!
                    pass
    finally:
        subprocess.run(
            ["git", "worktree", "remove", "--force", str(wt_dir)],
            cwd=repo,
            capture_output=True,
            timeout=60,
            check=False,
        )
        cleanup_temp_dir(tmp_dir)

    overall_ok = boot_ok and bool(results) and all(r.get("status") == "pass" and r.get("claim_pass") is True for r in results)
    final_status = "pass" if overall_ok else ("unavailable" if not boot_ok else "fail")
    agg_digest = sha256_bytes(json.dumps(results, sort_keys=True).encode("utf-8"))
    live_plan_path = _materialize_run_tiered_plan(
        repo,
        run_dir=run_dir,
        cid=cid,
        workers=[{"name": r["lane"], "status": r["status"], "claim_pass": r["claim_pass"]} for r in results],
        max_heavy_workers=plan["max_heavy_workers"],
        output_digest=agg_digest,
    )

    val_script = resolve_tool_script("ACLAB_VALIDATE_PLAN_SCRIPT", DEFAULT_VALIDATE_PLAN_SCRIPT, "validate_tiered_ci_plan.py")
    val_proc = subprocess.run(
        [sys.executable, str(val_script), "--plan", str(live_plan_path), "--format", "json"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    val_ok = val_proc.returncode == 0
    if not val_ok:
        overall_ok = False
        final_status = "fail"

    receipt = {
        "schema": HANDOFF_RECEIPT_SCHEMA,
        "run_id": run_id,
        "profile": plan["profile"],
        "status": final_status,
        "candidate": cid,
        "bootstrap_error": boot_err,
        "lanes": results,
        "tiered_ci_plan_path": str(live_plan_path),
        "tiered_ci_plan_valid": val_ok,
        "output_digest": agg_digest,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    atomic_write_json(receipt_path, receipt)
    state["status"] = final_status
    state["finished_at"] = receipt["finished_at"]
    state["receipt_path"] = str(receipt_path)
    atomic_write_json(state_path, state)
    return 0 if overall_ok else 1


def get_status(repo: Path, run_id: str) -> dict[str, Any]:
    run_dir = runtime_dir(repo.resolve()) / "runs" / run_id
    state_path = run_dir / "state.json"
    receipt_path = run_dir / "receipt.json"
    if not state_path.is_file():
        raise LocalCiError(f"Unknown run_id: {run_id}", code="RUN_NOT_FOUND", exit_code=3)
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if receipt_path.is_file():
        state["receipt"] = json.loads(receipt_path.read_text(encoding="utf-8"))
    hb_path = run_dir / "heartbeats.jsonl"
    if hb_path.is_file():
        lines = [ln for ln in hb_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
        if lines:
            state["latest_heartbeat"] = json.loads(lines[-1])
    return state


def wait_run(repo: Path, run_id: str, *, timeout_s: int = 1800, poll_interval_s: float = 0.5) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        st = get_status(repo, run_id)
        if st.get("status") in TERMINAL_STATUSES:
            return st.get("receipt", st)
        time.sleep(poll_interval_s)
    raise LocalCiError(f"Timed out waiting for run_id={run_id} after {timeout_s}s", code="WAIT_TIMEOUT", exit_code=124)


def cancel_run(repo: Path, run_id: str) -> dict[str, Any]:
    run_dir = runtime_dir(repo.resolve()) / "runs" / run_id
    state_path = run_dir / "state.json"
    if not state_path.is_file():
        raise LocalCiError(f"Unknown run_id: {run_id}", code="RUN_NOT_FOUND", exit_code=3)
    state = json.loads(state_path.read_text(encoding="utf-8"))
    pgid = state.get("worker_pgid")
    if isinstance(pgid, int) and os.name != "nt":
        import signal
        try:
            os.killpg(pgid, signal.SIGTERM)
        except OSError:
            pass
    state["status"] = "cancelled"
    state["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    atomic_write_json(state_path, state)
    return state
