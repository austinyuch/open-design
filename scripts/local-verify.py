#!/usr/bin/env python3
# localci:reads .agents/security-scanner-data.json,.agents/tiered-ci-plan.json,.agents/gitleaks-baseline.json,.github/config/scopes.json,pnpm-lock.yaml
"""OS-agnostic Local CI, DevSecOps, and upstream-sync CLI for austinyuch/open-design."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import py_compile
import subprocess
import sys
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from local_ci import broker, gitleaks_gate, sbom_kev_gate, upstream_sync
from local_ci.common import (
    DEFAULT_PROVIDER_REGISTRY,
    DEFAULT_SECURITY_DOCTOR_SCRIPT,
    DEFAULT_VALIDATE_PLAN_SCRIPT,
    LocalCiError,
    ensure_rootless_podman,
    inspect_local_image_id,
    pinned_scanner_image,
    repo_root,
    resolve_tool_script,
    resolved_node24_bin,
    runtime_dir,
)


def _staged_files(repo: Path) -> list[str]:
    proc = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def cmd_t0_precommit(repo: Path) -> int:
    """Fast hermetic offline staged-index gate (<30s, zero network/LLM calls)."""
    staged = _staged_files(repo)
    leaked_tmp = [f for f in staged if f.startswith(".tmp/")]
    if leaked_tmp:
        print(f"ERROR: refusing to commit generated .tmp/ files: {leaked_tmp}", file=sys.stderr)
        return 1

    # Syntax-check staged Python files & require # localci:reads header under scripts/
    for rel in staged:
        p = repo / rel
        if rel.endswith(".py") and p.is_file():
            py_compile.compile(str(p), doraise=True)
            if rel.startswith("scripts/") and "# localci:reads " not in p.read_text(encoding="utf-8", errors="ignore")[:512]:
                print(f"ERROR: missing '# localci:reads <paths|none>' header in {rel}", file=sys.stderr)
                return 1
        if rel.startswith(".agents/") and rel.endswith(".json") and p.is_file():
            json.loads(p.read_text(encoding="utf-8"))

    gl = gitleaks_gate.run_staged(repo)
    if gl["status"] != "pass":
        print(json.dumps({"gate": "t0-precommit", "status": "fail", "gitleaks": gl}, indent=2, sort_keys=True))
        return 2
    print(f"t0-precommit PASS (staged_files={len(staged)}, gitleaks_findings=0)")
    return 0


def cmd_t0_prepush(repo: Path, explicit_ranges: list[str] | None = None) -> int:
    """Hermetic offline pushed-ref-range gate (`pushed-ref-range` binding, zero network/LLM)."""
    if explicit_ranges:
        gl = gitleaks_gate.run_range(repo, ranges=explicit_ranges)
    else:
        raw_stdin = sys.stdin.read()
        tuples = gitleaks_gate.parse_pre_push_stdin(raw_stdin)
        if not tuples:
            print("t0-prepush PASS (no refs to push)")
            return 0
        gl = gitleaks_gate.run_range(repo, tuples=tuples)

    if gl["status"] != "pass":
        print(json.dumps({"gate": "t0-prepush", "status": "fail", "gitleaks": gl}, indent=2, sort_keys=True))
        return 2

    tracked_tmp = subprocess.run(
        ["git", "ls-files", ".tmp/"],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    ).stdout.strip()
    if tracked_tmp:
        print(f"ERROR: tracked runtime artifacts under .tmp/: {tracked_tmp}", file=sys.stderr)
        return 1

    print(
        f"t0-prepush PASS (ref_binding=pushed-ref-range, scanned_commits={gl['scanned_commits']}, gitleaks_findings=0)"
    )
    return 0


def cmd_doctor(repo: Path) -> int:
    """Verify tiered CI plan, shared security provider, Podman pinned images, and Node 24."""
    checks: list[dict[str, Any]] = []
    ok_all = True

    def add_check(name: str, ok: bool, detail: Any) -> None:
        nonlocal ok_all
        if not ok:
            ok_all = False
        checks.append({"name": name, "ok": ok, "detail": detail})

    try:
        val_script = resolve_tool_script("ACLAB_VALIDATE_PLAN_SCRIPT", DEFAULT_VALIDATE_PLAN_SCRIPT, "validate_tiered_ci_plan.py")
        p = subprocess.run(
            [sys.executable, str(val_script), "--plan", str(repo / ".agents" / "tiered-ci-plan.json"), "--format", "json"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        res = json.loads(p.stdout)
        add_check("tiered-ci-plan", p.returncode == 0 and res.get("status") == "pass", res)
    except Exception as exc:
        add_check("tiered-ci-plan", False, str(exc))

    try:
        doc_script = resolve_tool_script("ACLAB_SECURITY_DOCTOR_SCRIPT", DEFAULT_SECURITY_DOCTOR_SCRIPT, "doctor.py")
        p = subprocess.run(
            [sys.executable, str(doc_script), "--repo", str(repo), "--format", "json"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        res = json.loads(p.stdout)
        add_check("security-scanner-contract", p.returncode == 0 and res.get("status") == "ready", res.get("status"))
    except Exception as exc:
        add_check("security-scanner-contract", False, str(exc))

    try:
        reg_path = Path.home() / DEFAULT_PROVIDER_REGISTRY
        reg_data = json.loads(reg_path.read_text(encoding="utf-8"))
        provider_root = Path(reg_data["checkout_root"])
        reg_chk = subprocess.run(
            [sys.executable, str(provider_root / "scripts" / "security_data_provider_registry.py"), "check", "--registry", str(reg_path)],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        add_check("security-provider-registry", reg_chk.returncode == 0, reg_chk.stdout.strip() or reg_chk.stderr.strip())
    except Exception as exc:
        add_check("security-provider-registry", False, str(exc))

    try:
        ensure_rootless_podman()
        img_ids = {}
        for key in ("gitleaks", "trivy", "playwright"):
            ref = pinned_scanner_image(repo, key)
            img_ids[key] = inspect_local_image_id(ref)
        add_check("podman-pinned-images", True, img_ids)
    except Exception as exc:
        add_check("podman-pinned-images", False, str(exc))

    node24 = resolved_node24_bin()
    add_check("node-24-toolchain", bool(node24), node24 or "not found")

    report = {
        "schema": "open-design-local-ci-doctor/v1",
        "repo": str(repo),
        "status": "ready" if ok_all else "fail",
        "checks": checks,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if ok_all else 1


def cmd_install_hooks(repo: Path) -> int:
    hooks_dir = repo / ".githooks"
    for name in ("pre-commit", "pre-push"):
        hp = hooks_dir / name
        if not hp.is_file():
            raise LocalCiError(f"Hook file missing: {hp}", code="HOOK_MISSING")
        os.chmod(hp, 0o755)
    subprocess.run(["git", "config", "core.hooksPath", ".githooks"], cwd=repo, check=True, timeout=15)
    print(json.dumps({"status": "installed", "hooksPath": ".githooks", "repo": str(repo)}, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, help="Repository root override (default: detected git root)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("t0-precommit", help="Offline hermetic staged-index pre-commit gate")
    prepush = sub.add_parser("t0-prepush", help="Offline hermetic pushed-ref-range pre-push gate")
    prepush.add_argument("--range", action="append", help="Explicit <old>..<new> commit range (otherwise reads git pre-push stdin)")

    gl = sub.add_parser("gitleaks", help="Run offline Podman Gitleaks secret scan")
    gl.add_argument("--mode", choices=("staged", "range", "tree"), default="tree")
    gl.add_argument("--range", action="append", help="Explicit <old>..<new> commit range for range mode")
    gl.add_argument("--revision", default="HEAD", help="Git revision for tree mode")

    sbom = sub.add_parser("sbom-kev", help="Generate offline Trivy CycloneDX SBOM and correlate CVE/KEV catalogs")
    sbom.add_argument("--mode", choices=("revision", "staged"), default="revision")
    sbom.add_argument("--revision", default="HEAD")
    sbom.add_argument("--base-revision", help="Optional base revision to compare new HIGH/CRITICAL CVEs on lockfile diff")
    sbom.add_argument("--allow-upstream-cve-drift", action="store_true")

    submit = sub.add_parser("submit", help="Submit async Topology A local CI handoff plan")
    submit.add_argument("--profile", choices=broker.PROFILES, default="fast")
    submit.add_argument("--revision", default="HEAD")
    submit.add_argument("--base-ref")
    submit.add_argument("--lanes", nargs="*", help="Explicit subset of lane IDs")
    submit.add_argument("--container-mode", choices=("auto", "required", "host"), default="auto")
    submit.add_argument("--allow-upstream-cve-drift", action="store_true")
    submit.add_argument("--max-heavy-workers", type=int, default=2)

    st = sub.add_parser("status", help="Inspect async local CI run status")
    st.add_argument("--run-id", required=True)

    wait = sub.add_parser("wait", help="Wait for async local CI run completion")
    wait.add_argument("--run-id", required=True)
    wait.add_argument("--timeout", type=int, default=1800)

    cancel = sub.add_parser("cancel", help="Cancel a queued or running local CI run")
    cancel.add_argument("--run-id", required=True)

    up_chk = sub.add_parser("upstream-check", help="Check official upstream drift and merge-tree conflicts")
    up_chk.add_argument("--fetch", action="store_true")
    up_chk.add_argument("--upstream-ref", default="upstream/main")
    up_chk.add_argument("--fork-ref", default="HEAD")
    up_chk.add_argument("--format", choices=("json", "text"), default="json")

    up_sync = sub.add_parser("upstream-sync", help="Prepare isolated upstream sync branch + async Local CI")
    up_sync.add_argument("--strategy", choices=("merge", "rebase"), default="merge")
    up_sync.add_argument("--upstream-ref", default="upstream/main")
    up_sync.add_argument("--base-ref", default="main")
    up_sync.add_argument("--no-fetch", action="store_true")
    up_sync.add_argument("--no-ci", action="store_true")
    up_sync.add_argument("--wait", action="store_true")
    up_sync.add_argument("--profile", choices=broker.PROFILES, default="upstream-sync")

    sub.add_parser("doctor", help="Check local CI contracts, provider health, and container images")
    sub.add_parser("install-hooks", help="Enable .githooks via git config core.hooksPath")

    worker = sub.add_parser("_worker", help=argparse.SUPPRESS)
    worker.add_argument("--run-id", required=True)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    repo = repo_root(args.repo if args.repo else Path(__file__))
    try:
        if args.command == "t0-precommit":
            return cmd_t0_precommit(repo)
        if args.command == "t0-prepush":
            return cmd_t0_prepush(repo, explicit_ranges=args.range)
        if args.command == "gitleaks":
            if args.mode == "staged":
                res = gitleaks_gate.run_staged(repo)
            elif args.mode == "range":
                res = gitleaks_gate.run_range(repo, ranges=args.range)
            else:
                res = gitleaks_gate.run_tree(repo, revision=args.revision)
            print(json.dumps(res, indent=2, sort_keys=True))
            return 0 if res["status"] == "pass" else 2
        if args.command == "sbom-kev":
            res = sbom_kev_gate.run_sbom_kev(
                repo,
                mode=args.mode,
                revision=args.revision,
                base_revision=args.base_revision,
                allow_upstream_cve_drift=args.allow_upstream_cve_drift,
            )
            print(json.dumps(res, indent=2, sort_keys=True))
            return int(res.get("exit_code", 0 if res["status"] == "pass" else 2))
        if args.command == "submit":
            res = broker.submit_run(
                repo,
                profile=args.profile,
                revision=args.revision,
                base_ref=args.base_ref,
                lanes=args.lanes,
                container_mode=args.container_mode,
                allow_upstream_cve_drift=args.allow_upstream_cve_drift,
                max_heavy_workers=args.max_heavy_workers,
            )
            print(json.dumps(res, indent=2, sort_keys=True))
            return 0
        if args.command == "status":
            res = broker.get_status(repo, args.run_id)
            print(json.dumps(res, indent=2, sort_keys=True))
            return 0
        if args.command == "wait":
            res = broker.wait_run(repo, args.run_id, timeout_s=args.timeout)
            print(json.dumps(res, indent=2, sort_keys=True))
            return 0 if res.get("status") == "pass" else 1
        if args.command == "cancel":
            res = broker.cancel_run(repo, args.run_id)
            print(json.dumps(res, indent=2, sort_keys=True))
            return 0
        if args.command == "upstream-check":
            res = upstream_sync.check_upstream(
                repo,
                fetch=args.fetch,
                upstream_ref=args.upstream_ref,
                fork_ref=args.fork_ref,
            )
            if args.format == "json":
                print(json.dumps(res, indent=2, sort_keys=True))
            else:
                print(
                    f"status={res['status']} fork_ahead={res['fork_ahead_commits']} "
                    f"upstream_behind={res['upstream_behind_commits']} "
                    f"overlaps={len(res['overlapping_files'])} merge_clean={res['merge_forecast']['merge_clean']}"
                )
            return 0
        if args.command == "upstream-sync":
            res = upstream_sync.prepare_sync(
                repo,
                strategy=args.strategy,
                upstream_ref=args.upstream_ref,
                base_ref=args.base_ref,
                fetch=not args.no_fetch,
                run_ci=not args.no_ci,
                wait_ci=args.wait,
                profile=args.profile,
            )
            print(json.dumps(res, indent=2, sort_keys=True))
            return 0
        if args.command == "doctor":
            return cmd_doctor(repo)
        if args.command == "install-hooks":
            return cmd_install_hooks(repo)
        if args.command == "_worker":
            return broker.execute_worker(repo, args.run_id)
        raise LocalCiError(f"Unknown command: {args.command}")
    except LocalCiError as exc:
        print(json.dumps({"status": "error", "code": exc.code, "error": str(exc)}, sort_keys=True))
        return exc.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
