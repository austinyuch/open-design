# localci:reads .agents/security-scanner-data.json,.github/config/scopes.json
"""Read-only official upstream drift/conflict forecast and isolated sync worktree helper."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any

from . import UPSTREAM_CHECK_SCHEMA, UPSTREAM_SYNC_RECEIPT_SCHEMA
from .common import (
    SHA1_RE,
    LocalCiError,
    atomic_write_json,
    resolve_git_oid,
    run_id_nonce,
    runtime_dir,
)

UPSTREAM_REMOTE = "upstream"
UPSTREAM_URL = "https://github.com/nexu-io/open-design.git"
UPSTREAM_BRANCH = "main"
FORK_AUTHOR_NAME = "Austin Chang"
FORK_AUTHOR_EMAIL = "7184588+austinyuch@users.noreply.github.com"


def ensure_upstream_remote(repo: Path, *, url: str = UPSTREAM_URL) -> dict[str, str]:
    """Ensure read-only `upstream` remote exists with pushes explicitly disabled."""
    cur = subprocess.run(
        ["git", "remote", "get-url", UPSTREAM_REMOTE],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if cur.returncode != 0:
        subprocess.run(
            ["git", "remote", "add", UPSTREAM_REMOTE, url],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
    subprocess.run(
        ["git", "remote", "set-url", "--push", UPSTREAM_REMOTE, "DISABLED"],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    final_url = subprocess.run(
        ["git", "remote", "get-url", UPSTREAM_REMOTE],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    ).stdout.strip()
    return {"remote": UPSTREAM_REMOTE, "fetch_url": final_url, "push_url": "DISABLED"}


def _diff_files(repo: Path, base_oid: str, tip_oid: str) -> list[str]:
    if base_oid == tip_oid:
        return []
    proc = subprocess.run(
        ["git", "diff", "--name-only", f"{base_oid}..{tip_oid}"],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    return sorted({line.strip() for line in proc.stdout.splitlines() if line.strip()})


def _pending_commits(repo: Path, base_oid: str, upstream_oid: str) -> list[dict[str, str]]:
    if base_oid == upstream_oid:
        return []
    proc = subprocess.run(
        [
            "git",
            "log",
            "--format=%H\x1f%h\x1f%an\x1f%ad\x1f%s",
            "--date=short",
            f"{base_oid}..{upstream_oid}",
        ],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    commits: list[dict[str, str]] = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\x1f")
        if len(parts) == 5:
            commits.append(
                {
                    "oid": parts[0],
                    "short": parts[1],
                    "author": parts[2],
                    "date": parts[3],
                    "subject": parts[4],
                }
            )
    return commits


def _merge_tree_forecast(repo: Path, fork_oid: str, upstream_oid: str) -> dict[str, Any]:
    """Zero-mutation in-memory merge conflict forecast using `git merge-tree --write-tree`."""
    proc = subprocess.run(
        ["git", "merge-tree", "--write-tree", "--name-only", fork_oid, upstream_oid],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    lines = proc.stdout.splitlines()
    if proc.returncode == 0:
        tree_oid = lines[0].strip() if lines else ""
        return {
            "merge_clean": True,
            "merge_tree_oid": tree_oid if SHA1_RE.fullmatch(tree_oid) else None,
            "conflicting_files": [],
            "messages": [],
        }
    if proc.returncode == 1:
        tree_oid = lines[0].strip() if lines else ""
        conflicts: list[str] = []
        messages: list[str] = []
        in_messages = False
        for line in lines[1:]:
            if not line.strip():
                in_messages = True
                continue
            if not in_messages:
                conflicts.append(line.strip())
            else:
                messages.append(line.strip())
        return {
            "merge_clean": False,
            "merge_tree_oid": tree_oid if SHA1_RE.fullmatch(tree_oid) else None,
            "conflicting_files": sorted(set(conflicts)),
            "messages": messages,
        }
    raise LocalCiError(
        f"git merge-tree failed unexpectedly ({proc.returncode}): {proc.stderr.strip()}",
        code="UPSTREAM_MERGE_TREE_ERROR",
    )


def _scopes_preview(repo: Path, files: list[str]) -> dict[str, Any] | None:
    scopes_py = repo / ".github" / "scripts" / "scopes.py"
    if not scopes_py.is_file():
        return None
    if not files:
        return {"file_count": 0, "enabled_workloads": ["static_gate", "preflight"]}
    proc = subprocess.run(
        [sys.executable, str(scopes_py), "plan", "--context", "pr", "--files-from", "-"],
        cwd=repo,
        input="\n".join(files) + "\n",
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if proc.returncode != 0:
        return {"error": proc.stderr.strip()}
    try:
        parsed = json.loads(proc.stdout)
        enabled = sorted(k for k, v in parsed.get("enabled", {}).items() if v is True)
        return {
            "file_count": len(files),
            "enabled_workloads": enabled,
            "escalations": parsed.get("trace", {}).get("escalations", []),
        }
    except json.JSONDecodeError:
        return None


def check_upstream(
    repo: Path,
    *,
    fetch: bool = False,
    upstream_ref: str = f"{UPSTREAM_REMOTE}/{UPSTREAM_BRANCH}",
    fork_ref: str = "HEAD",
) -> dict[str, Any]:
    """Inspect fork vs upstream drift, file overlaps, and conflict forecast without modifying state."""
    remote_info = None
    if fetch:
        remote_info = ensure_upstream_remote(repo)
        if upstream_ref.startswith(f"{UPSTREAM_REMOTE}/"):
            branch = upstream_ref.split("/", 1)[1]
            subprocess.run(
                ["git", "fetch", "--no-tags", UPSTREAM_REMOTE, branch],
                cwd=repo,
                capture_output=True,
                text=True,
                timeout=60,
                check=True,
            )

    fork_oid = resolve_git_oid(repo, fork_ref, obj_type="commit")
    upstream_oid = resolve_git_oid(repo, upstream_ref, obj_type="commit")
    mb_proc = subprocess.run(
        ["git", "merge-base", fork_oid, upstream_oid],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    )
    merge_base = mb_proc.stdout.strip()

    counts_proc = subprocess.run(
        ["git", "rev-list", "--left-right", "--count", f"{fork_oid}...{upstream_oid}"],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    )
    fork_ahead_s, upstream_behind_s = counts_proc.stdout.strip().split()
    fork_ahead = int(fork_ahead_s)
    upstream_behind = int(upstream_behind_s)

    fork_files = _diff_files(repo, merge_base, fork_oid)
    upstream_files = _diff_files(repo, merge_base, upstream_oid)
    overlapping = sorted(set(fork_files) & set(upstream_files))
    pending = _pending_commits(repo, merge_base, upstream_oid)
    forecast = _merge_tree_forecast(repo, fork_oid, upstream_oid)
    scope_plan = _scopes_preview(repo, upstream_files)

    if upstream_behind == 0:
        status = "up_to_date"
    elif forecast["merge_clean"] and not overlapping:
        status = "clean_merge_ready"
    elif forecast["merge_clean"]:
        status = "overlap_clean_merge_review_recommended"
    else:
        status = "conflict_manual_resolution_required"

    return {
        "schema": UPSTREAM_CHECK_SCHEMA,
        "status": status,
        "remote": remote_info,
        "fork_ref": fork_ref,
        "fork_oid": fork_oid,
        "upstream_ref": upstream_ref,
        "upstream_oid": upstream_oid,
        "merge_base": merge_base,
        "fork_ahead_commits": fork_ahead,
        "upstream_behind_commits": upstream_behind,
        "fork_touched_files_count": len(fork_files),
        "upstream_touched_files_count": len(upstream_files),
        "upstream_touched_files": upstream_files,
        "overlapping_files": overlapping,
        "pending_upstream_commits": pending,
        "merge_forecast": forecast,
        "local_ci_scope_preview": scope_plan,
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def prepare_sync(
    repo: Path,
    *,
    strategy: str = "merge",
    upstream_ref: str = f"{UPSTREAM_REMOTE}/{UPSTREAM_BRANCH}",
    base_ref: str = "main",
    fetch: bool = True,
    run_ci: bool = True,
    wait_ci: bool = False,
    profile: str = "upstream-sync",
) -> dict[str, Any]:
    """Create an isolated sync branch in a temp worktree and optionally hand off to Local CI."""
    if strategy not in ("merge", "rebase"):
        raise LocalCiError(f"Unsupported sync strategy: {strategy}", code="INVALID_STRATEGY")

    check_report = check_upstream(repo, fetch=fetch, upstream_ref=upstream_ref, fork_ref=base_ref)
    if check_report["upstream_behind_commits"] == 0:
        return {
            "schema": UPSTREAM_SYNC_RECEIPT_SCHEMA,
            "status": "up_to_date",
            "upstream_oid": check_report["upstream_oid"],
            "base_oid": check_report["fork_oid"],
            "message": "Already up to date with upstream.",
        }

    upstream_oid = check_report["upstream_oid"]
    base_oid = check_report["fork_oid"]
    short = upstream_oid[:9]
    sync_root = runtime_dir(repo) / "upstream-sync"
    sync_root.mkdir(parents=True, exist_ok=True)
    nonce = run_id_nonce(f"sync-{short}")
    sync_branch = f"sync/upstream-{short}"
    existing = subprocess.run(
        ["git", "show-ref", "--verify", "--quiet", f"refs/heads/{sync_branch}"],
        cwd=repo,
        check=False,
    )
    if existing.returncode == 0:
        sync_branch = f"sync/upstream-{short}-{nonce.split('-')[-1]}"

    wt_dir = sync_root / f"wt-{nonce}"
    git_env = {
        **os.environ,
        "GIT_AUTHOR_NAME": FORK_AUTHOR_NAME,
        "GIT_AUTHOR_EMAIL": FORK_AUTHOR_EMAIL,
        "GIT_COMMITTER_NAME": FORK_AUTHOR_NAME,
        "GIT_COMMITTER_EMAIL": FORK_AUTHOR_EMAIL,
    }

    subprocess.run(
        ["git", "worktree", "add", "-b", sync_branch, str(wt_dir), base_oid],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    merged_oid: str | None = None
    ci_submission: dict[str, Any] | None = None
    try:
        cmd = (
            ["git", "merge", "--no-ff", "-m", f"chore(sync): merge upstream/{UPSTREAM_BRANCH} ({short})", upstream_oid]
            if strategy == "merge"
            else ["git", "rebase", upstream_oid]
        )
        proc = subprocess.run(
            cmd,
            cwd=wt_dir,
            env=git_env,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if proc.returncode != 0:
            abort_cmd = ["git", "merge", "--abort"] if strategy == "merge" else ["git", "rebase", "--abort"]
            subprocess.run(abort_cmd, cwd=wt_dir, capture_output=True, check=False)
            receipt = {
                "schema": UPSTREAM_SYNC_RECEIPT_SCHEMA,
                "status": "conflict",
                "strategy": strategy,
                "base_oid": base_oid,
                "upstream_oid": upstream_oid,
                "sync_branch": None,
                "conflicting_files": check_report["merge_forecast"]["conflicting_files"],
                "detail": (proc.stderr or proc.stdout).strip(),
                "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            receipt_path = sync_root / f"{nonce}.receipt.json"
            atomic_write_json(receipt_path, receipt)
            receipt["receipt_path"] = str(receipt_path)
            raise LocalCiError(
                f"Upstream {strategy} conflicted cleanly aborted (see {receipt_path})",
                code="UPSTREAM_SYNC_CONFLICT",
                exit_code=2,
            )

        merged_oid = resolve_git_oid(wt_dir, "HEAD", obj_type="commit")
    finally:
        subprocess.run(
            ["git", "worktree", "remove", "--force", str(wt_dir)],
            cwd=repo,
            capture_output=True,
            timeout=60,
            check=False,
        )
        if merged_oid is None:
            subprocess.run(["git", "branch", "-D", sync_branch], cwd=repo, capture_output=True, check=False)

    if run_ci and merged_oid is not None:
        from .broker import submit_run, wait_run

        ci_submission = submit_run(
            repo,
            profile=profile,
            revision=merged_oid,
            base_ref=base_oid,
            allow_upstream_cve_drift=True,
        )
        if wait_ci:
            ci_submission = wait_run(repo, ci_submission["run_id"])

    receipt = {
        "schema": UPSTREAM_SYNC_RECEIPT_SCHEMA,
        "status": "ready_for_review",
        "strategy": strategy,
        "base_oid": base_oid,
        "upstream_oid": upstream_oid,
        "sync_branch": sync_branch,
        "merged_commit_oid": merged_oid,
        "upstream_behind_commits": check_report["upstream_behind_commits"],
        "ci_handoff": ci_submission,
        "next_manual_merge_command": f"git checkout {base_ref} && git merge --ff-only {sync_branch}",
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt_path = sync_root / f"{nonce}.receipt.json"
    atomic_write_json(receipt_path, receipt)
    receipt["receipt_path"] = str(receipt_path)
    return receipt
