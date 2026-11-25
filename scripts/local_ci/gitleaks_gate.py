# localci:reads .agents/security-scanner-data.json,.agents/gitleaks-baseline.json
"""Offline digest-pinned Podman Gitleaks gate for staged-index, pushed-range, and tree modes."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from typing import Any, Sequence

from . import GITLEAKS_RECEIPT_SCHEMA
from .common import (
    PODMAN_COMMAND_PREFIX,
    SHA1_RE,
    LocalCiError,
    atomic_write_json,
    ensure_rootless_podman,
    git_common_dir,
    inspect_local_image_id,
    pinned_scanner_image,
    resolve_git_oid,
    rootless_podman_environment,
    run_id_nonce,
    runtime_dir,
    safe_extract_git_archive,
    sha256_bytes,
    sha256_file,
)

ZERO_OID = "0" * 40


def parse_pre_push_stdin(raw_stdin: str) -> list[dict[str, str]]:
    """Parse exact (local_ref, local_oid, remote_ref, remote_oid) tuples supplied by git pre-push."""
    tuples: list[dict[str, str]] = []
    for line in raw_stdin.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.split()
        if len(parts) != 4:
            raise LocalCiError(f"Malformed git pre-push tuple: {line!r}", code="INVALID_PREPUSH_TUPLE")
        local_ref, local_oid, remote_ref, remote_oid = parts
        if not SHA1_RE.fullmatch(local_oid) or not SHA1_RE.fullmatch(remote_oid):
            raise LocalCiError(f"Invalid SHA-1 OID in pre-push tuple: {line!r}", code="INVALID_PREPUSH_TUPLE")
        tuples.append(
            {
                "local_ref": local_ref,
                "local_oid": local_oid,
                "remote_ref": remote_ref,
                "remote_oid": remote_oid,
            }
        )
    return tuples


def _redact_findings(raw_findings: Any, *, repo_prefix: str = "/repo/") -> list[dict[str, Any]]:
    if not isinstance(raw_findings, list):
        return []
    redacted: list[dict[str, Any]] = []
    for item in raw_findings:
        if not isinstance(item, dict):
            continue
        file_path = str(item.get("File", ""))
        if file_path.startswith(repo_prefix):
            file_path = file_path[len(repo_prefix):]
        commit = str(item.get("Commit", ""))
        redacted.append(
            {
                "RuleID": str(item.get("RuleID", "unknown")),
                "File": file_path,
                "StartLine": item.get("StartLine"),
                "EndLine": item.get("EndLine"),
                "Commit": commit[:12] if commit else "",
                "Fingerprint": str(item.get("Fingerprint", "")),
                "Secret": "REDACTED",
            }
        )
    return redacted


def _verified_gitleaks_image(repo: Path) -> tuple[str, str]:
    ensure_rootless_podman()
    image = pinned_scanner_image(repo, "gitleaks")
    image_id = inspect_local_image_id(image)
    return image, image_id


def _container_git_mounts(repo: Path) -> list[str]:
    repo_resolved = repo.resolve()
    common_dir = git_common_dir(repo_resolved)
    mounts = ["-v", f"{repo_resolved}:{repo_resolved}:ro"]
    if not common_dir.is_relative_to(repo_resolved):
        mounts.extend(["-v", f"{common_dir}:{common_dir}:ro"])
    return mounts


def _run_gitleaks_podman(
    *,
    image: str,
    mounts: Sequence[str],
    workdir: str,
    args: Sequence[str],
    out_dir: Path,
) -> tuple[int, list[dict[str, Any]], str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "gitleaks-report.json"
    cmd = [
        *PODMAN_COMMAND_PREFIX,
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--userns=keep-id",
        "-e",
        "GIT_CONFIG_COUNT=1",
        "-e",
        "GIT_CONFIG_KEY_0=safe.directory",
        "-e",
        "GIT_CONFIG_VALUE_0=*",
        *mounts,
        "-v",
        f"{out_dir.resolve()}:/out:rw",
        "-w",
        workdir,
        image,
        *args,
        "--no-banner",
        "--redact=100",
        "--exit-code",
        "2",
        "--report-format",
        "json",
        "--report-path",
        "/out/gitleaks-report.json",
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=180,
        env=rootless_podman_environment(),
        check=False,
    )
    findings: list[dict[str, Any]] = []
    if report_path.is_file():
        try:
            parsed = json.loads(report_path.read_text(encoding="utf-8") or "[]")
            findings = _redact_findings(parsed, repo_prefix=f"{workdir.rstrip('/')}/")
        except (OSError, json.JSONDecodeError) as exc:
            raise LocalCiError(f"Gitleaks produced malformed JSON report: {exc}", code="GITLEAKS_INVALID_REPORT") from exc
    if proc.returncode not in (0, 2):
        detail = (proc.stderr or proc.stdout or "").strip()
        raise LocalCiError(
            f"Gitleaks exited unexpectedly ({proc.returncode}): {detail}",
            code="GITLEAKS_RUNTIME_ERROR",
        )
    return proc.returncode, findings, proc.stderr or ""


def _write_receipt(repo: Path, mode: str, payload: dict[str, Any]) -> Path:
    out_dir = runtime_dir(repo) / "gitleaks"
    out_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = out_dir / f"{run_id_nonce(f'gitleaks-{mode}')}.json"
    atomic_write_json(receipt_path, payload)
    return receipt_path


def run_staged(repo: Path) -> dict[str, Any]:
    """Scan strictly the exact Git staged index (`T0 pre_commit` `staged-index` binding)."""
    staged_list = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    staged_files = [line for line in staged_list.stdout.splitlines() if line]
    image, image_id = _verified_gitleaks_image(repo)
    findings: list[dict[str, Any]] = []
    if staged_files:
        repo_resolved = repo.resolve()
        mounts = _container_git_mounts(repo_resolved)
        with tempfile.TemporaryDirectory(prefix="od-gl-staged-") as tmp_dir:
            rc, findings, _ = _run_gitleaks_podman(
                image=image,
                mounts=mounts,
                workdir=str(repo_resolved),
                args=["git", "--staged", "."],
                out_dir=Path(tmp_dir),
            )
            passed = rc == 0 and not findings
    else:
        passed = True

    receipt = {
        "schema": GITLEAKS_RECEIPT_SCHEMA,
        "mode": "staged",
        "ref_binding": "staged-index",
        "image": image,
        "image_id": image_id,
        "staged_file_count": len(staged_files),
        "findings_count": len(findings),
        "findings": findings,
        "status": "pass" if passed else "fail",
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt_path = _write_receipt(repo, "staged", receipt)
    receipt["receipt_path"] = str(receipt_path)
    return receipt


def _resolve_range_log_opts(repo: Path, local_oid: str, remote_oid: str) -> tuple[str | None, int]:
    """Determine exact commit range log-opts for a pushed ref tuple."""
    if remote_oid != ZERO_OID:
        check_remote = subprocess.run(
            ["git", "cat-file", "-e", f"{remote_oid}^{{commit}}"],
            cwd=repo,
            capture_output=True,
            timeout=10,
            check=False,
        )
        if check_remote.returncode == 0:
            spec = f"{remote_oid}..{local_oid}"
            cnt = subprocess.run(
                ["git", "rev-list", "--count", spec],
                cwd=repo,
                capture_output=True,
                text=True,
                timeout=15,
                check=True,
            )
            return spec, int(cnt.stdout.strip() or "0")

    for base_candidate in ("origin/main", "main"):
        mb = subprocess.run(
            ["git", "merge-base", base_candidate, local_oid],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if mb.returncode == 0 and SHA1_RE.fullmatch(mb.stdout.strip()):
            base_oid = mb.stdout.strip()
            if base_oid != local_oid:
                spec = f"{base_oid}..{local_oid}"
                cnt = subprocess.run(
                    ["git", "rev-list", "--count", spec],
                    cwd=repo,
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=True,
                )
                return spec, int(cnt.stdout.strip() or "0")

    parent_chk = subprocess.run(
        ["git", "rev-parse", "--verify", f"{local_oid}^"],
        cwd=repo,
        capture_output=True,
        timeout=10,
        check=False,
    )
    if parent_chk.returncode == 0:
        return f"-n 1 {local_oid}", 1
    # Initial root commit in repository
    return f"{local_oid}", 1


def run_range(
    repo: Path,
    *,
    ranges: Sequence[str] | None = None,
    tuples: Sequence[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Scan strictly every commit range specified by pushed-ref-range tuples or explicit ranges."""
    image, image_id = _verified_gitleaks_image(repo)
    repo_resolved = repo.resolve()
    mounts = _container_git_mounts(repo_resolved)

    specs: list[dict[str, Any]] = []
    if tuples is not None:
        for item in tuples:
            if item["local_oid"] == ZERO_OID:
                specs.append({**item, "skipped_delete": True, "log_opts": None, "commit_count": 0})
                continue
            resolve_git_oid(repo_resolved, item["local_oid"], obj_type="commit")
            log_opts, count = _resolve_range_log_opts(repo_resolved, item["local_oid"], item["remote_oid"])
            specs.append({**item, "skipped_delete": False, "log_opts": log_opts, "commit_count": count})
    elif ranges:
        for rng in ranges:
            if ".." not in rng:
                raise LocalCiError(f"Range must use '<old>..<new>' syntax: {rng}", code="INVALID_RANGE")
            old_ref, _, new_ref = rng.partition("..")
            old_oid = resolve_git_oid(repo_resolved, old_ref, obj_type="commit")
            new_oid = resolve_git_oid(repo_resolved, new_ref, obj_type="commit")
            log_opts, count = _resolve_range_log_opts(repo_resolved, new_oid, old_oid)
            specs.append(
                {
                    "local_ref": new_ref,
                    "local_oid": new_oid,
                    "remote_ref": old_ref,
                    "remote_oid": old_oid,
                    "skipped_delete": False,
                    "log_opts": log_opts,
                    "commit_count": count,
                }
            )
    else:
        raise LocalCiError("run_range requires explicit pushed tuples or --range", code="MISSING_RANGE")

    all_findings: list[dict[str, Any]] = []
    total_commits = 0
    for spec in specs:
        if spec["skipped_delete"] or spec["commit_count"] == 0 or not spec["log_opts"]:
            continue
        total_commits += spec["commit_count"]
        with tempfile.TemporaryDirectory(prefix="od-gl-range-") as tmp_dir:
            _, findings, _ = _run_gitleaks_podman(
                image=image,
                mounts=mounts,
                workdir=str(repo_resolved),
                args=["git", f"--log-opts={spec['log_opts']}", "."],
                out_dir=Path(tmp_dir),
            )
            all_findings.extend(findings)

    receipt = {
        "schema": GITLEAKS_RECEIPT_SCHEMA,
        "mode": "range",
        "ref_binding": "pushed-ref-range",
        "image": image,
        "image_id": image_id,
        "tuples": specs,
        "scanned_commits": total_commits,
        "findings_count": len(all_findings),
        "findings": all_findings,
        "status": "pass" if not all_findings else "fail",
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt_path = _write_receipt(repo, "range", receipt)
    receipt["receipt_path"] = str(receipt_path)
    return receipt


def run_tree(repo: Path, *, revision: str = "HEAD") -> dict[str, Any]:
    """Scan immutable `git archive <revision>` snapshot against tracked baseline."""
    image, image_id = _verified_gitleaks_image(repo)
    commit_oid = resolve_git_oid(repo, revision, obj_type="commit")
    tree_oid = resolve_git_oid(repo, commit_oid, obj_type="tree")
    baseline_path = repo / ".agents" / "gitleaks-baseline.json"
    baseline_sha256 = sha256_file(baseline_path) if baseline_path.is_file() else None

    with tempfile.TemporaryDirectory(prefix="od-gl-tree-") as tmp_dir:
        tmp_root = Path(tmp_dir)
        src_dir = tmp_root / "src"
        out_dir = tmp_root / "out"
        safe_extract_git_archive(repo, commit_oid, src_dir)
        mounts = ["-v", f"{src_dir.resolve()}:/repo:ro"]
        args = ["dir", "."]
        if baseline_path.is_file():
            mounts.extend(["-v", f"{baseline_path.resolve()}:/baseline/gitleaks-baseline.json:ro"])
            args.extend(["--baseline-path", "/baseline/gitleaks-baseline.json"])
        rc, findings, _ = _run_gitleaks_podman(
            image=image,
            mounts=mounts,
            workdir="/repo",
            args=args,
            out_dir=out_dir,
        )

    receipt = {
        "schema": GITLEAKS_RECEIPT_SCHEMA,
        "mode": "tree",
        "commit_oid": commit_oid,
        "tree_oid": tree_oid,
        "image": image,
        "image_id": image_id,
        "baseline_sha256": baseline_sha256,
        "findings_count": len(findings),
        "findings": findings,
        "status": "pass" if rc == 0 and not findings else "fail",
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt_path = _write_receipt(repo, "tree", receipt)
    receipt["receipt_path"] = str(receipt_path)
    return receipt
