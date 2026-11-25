# localci:reads .agents/security-scanner-data.json,.agents/tiered-ci-plan.json,pnpm-lock.yaml
"""Shared OS-agnostic utilities, process-group isolation, Podman custody, and VCS identity."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
from typing import Any, Mapping, Sequence

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SHA1_RE = re.compile(r"^[0-9a-f]{40}$")
PINNED_IMAGE_RE = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

PODMAN_COMMAND_PREFIX = ("podman", "--remote=false")
PODMAN_REMOTE_ENV_KEYS = (
    "CONTAINER_HOST",
    "CONTAINER_CONNECTION",
    "CONTAINER_SSHKEY",
    "CONTAINER_CERT_PATH",
    "DOCKER_HOST",
    "PODMAN_HOST",
)
SCRUBBED_SUBPROCESS_ENV_PREFIXES = (
    "CLAUDE",
    "CODEX",
    "ANTHROPIC_",
    "OPENAI_",
    "GEMINI_",
)
SCRUBBED_SUBPROCESS_ENV_KEYS = frozenset({
    *PODMAN_REMOTE_ENV_KEYS,
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NPM_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
})

NODE24_DEFAULT_BIN = Path("/home/ac/.proto/tools/node/24.22.3/bin")
DEFAULT_PROVIDER_REGISTRY = Path(".config") / "aclab" / "security-data-provider.json"
DEFAULT_VALIDATE_PLAN_SCRIPT = (
    Path.home()
    / ".gemini"
    / "config"
    / "skills"
    / "async-local-ci-handoff"
    / "scripts"
    / "validate_tiered_ci_plan.py"
)
DEFAULT_SECURITY_DOCTOR_SCRIPT = (
    Path.home()
    / ".gemini"
    / "config"
    / "skills"
    / "shared-security-scanner-data"
    / "scripts"
    / "doctor.py"
)
DEFAULT_KEV_CORRELATE_SCRIPT = (
    Path.home()
    / ".gemini"
    / "config"
    / "skills"
    / "kev-sbom-correlation"
    / "scripts"
    / "security_cve_kev_correlate.py"
)


class LocalCiError(RuntimeError):
    """Fail-closed operational or validation error."""

    def __init__(self, message: str, *, code: str = "LOCAL_CI_ERROR", exit_code: int = 1) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def repo_root(start: Path | None = None) -> Path:
    anchor = (start or Path(__file__)).resolve()
    if anchor.is_dir():
        top = _git_toplevel(anchor)
        if top is not None:
            return top
    return Path(__file__).resolve().parents[2]


def _git_toplevel(cwd: Path) -> Path | None:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return Path(proc.stdout.strip()).resolve()
    except (OSError, subprocess.TimeoutExpired):
        return None
    return None


def runtime_dir(repo: Path) -> Path:
    return repo / ".tmp" / "local-ci"


def git_common_dir(repo: Path) -> Path:
    proc = subprocess.run(
        ["git", "rev-parse", "--git-common-dir"],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    raw = proc.stdout.strip()
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = (repo / candidate).resolve()
    else:
        candidate = candidate.resolve()
    return candidate


def load_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise LocalCiError(f"{label} is unavailable at {path}: {exc}", code="FILE_UNAVAILABLE") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise LocalCiError(f"{label} contains invalid JSON ({path}): {exc}", code="INVALID_JSON") from exc
    if not isinstance(data, dict):
        raise LocalCiError(f"{label} must be a JSON object ({path})", code="INVALID_JSON")
    return data


def atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(encoded)
            temp_path = Path(handle.name)
        os.replace(temp_path, path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_blob_sha1(data: bytes) -> str:
    return hashlib.sha1(f"blob {len(data)}\0".encode("utf-8") + data).hexdigest()


def load_consumer_contract(repo: Path) -> dict[str, Any]:
    contract = load_json_object(repo / ".agents" / "security-scanner-data.json", "security-scanner-data contract")
    if contract.get("schema") != "aclab-shared-security-scanner-data-consumer/v2":
        raise LocalCiError("Unsupported security-scanner-data schema", code="INVALID_CONTRACT")
    return contract


def pinned_scanner_image(repo: Path, scanner: str) -> str:
    contract = load_consumer_contract(repo)
    images = contract.get("scanner_images")
    if not isinstance(images, dict):
        raise LocalCiError("consumer contract scanner_images missing", code="INVALID_CONTRACT")
    image = images.get(scanner)
    if not isinstance(image, str) or not PINNED_IMAGE_RE.fullmatch(image):
        raise LocalCiError(f"scanner image '{scanner}' is not sha256 digest-pinned", code="UNPINNED_IMAGE")
    return image


def rootless_podman_environment(base_env: Mapping[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base_env is None else base_env)
    for key in PODMAN_REMOTE_ENV_KEYS:
        env.pop(key, None)
    return env


def ensure_rootless_podman(env: Mapping[str, str] | None = None) -> None:
    try:
        proc = subprocess.run(
            [*PODMAN_COMMAND_PREFIX, "info", "--format", "{{.Host.Security.Rootless}}"],
            capture_output=True,
            text=True,
            timeout=20,
            env=rootless_podman_environment(env),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise LocalCiError(f"Rootless Podman check failed: {exc}", code="PODMAN_UNAVAILABLE") from exc
    if proc.returncode != 0 or proc.stdout.strip().lower() != "true":
        detail = (proc.stderr or proc.stdout or "").strip()
        raise LocalCiError(
            f"Rootless Podman is required for local container gates ({detail or 'not rootless'})",
            code="PODMAN_UNAVAILABLE",
        )


def inspect_local_image_id(image_ref: str, *, env: Mapping[str, str] | None = None) -> str:
    try:
        proc = subprocess.run(
            [*PODMAN_COMMAND_PREFIX, "image", "inspect", "--format", "{{.Id}}", image_ref],
            capture_output=True,
            text=True,
            timeout=20,
            env=rootless_podman_environment(env),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise LocalCiError(f"Failed to inspect local image {image_ref}: {exc}", code="IMAGE_UNAVAILABLE") from exc
    raw_id = proc.stdout.strip().lower()
    if raw_id and not raw_id.startswith("sha256:") and SHA256_RE.fullmatch(raw_id):
        raw_id = f"sha256:{raw_id}"
    if proc.returncode != 0 or not IMAGE_ID_RE.fullmatch(raw_id):
        raise LocalCiError(
            f"Pinned local container image is unavailable offline (--pull=never): {image_ref}",
            code="IMAGE_UNAVAILABLE",
        )
    return raw_id


def resolved_node24_bin() -> str | None:
    env_bin = os.environ.get("OPEN_DESIGN_NODE24_BIN", "").strip()
    candidates = [Path(env_bin)] if env_bin else []
    candidates.append(NODE24_DEFAULT_BIN)
    for candidate in candidates:
        if candidate.is_dir() and (candidate / "node").is_file():
            return str(candidate)
    return None


def hermetic_subprocess_env(
    tmp_dir: Path,
    extra_env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    env: dict[str, str] = {}
    for key, val in os.environ.items():
        if key in SCRUBBED_SUBPROCESS_ENV_KEYS:
            continue
        if any(key.startswith(pfx) for pfx in SCRUBBED_SUBPROCESS_ENV_PREFIXES):
            continue
        env[key] = val

    node24 = resolved_node24_bin()
    if node24:
        current_path = env.get("PATH", "")
        parts = [p for p in current_path.split(os.pathsep) if p and p != node24]
        env["PATH"] = os.pathsep.join([node24, *parts])

    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_str = str(tmp_dir)
    env["TMPDIR"] = tmp_str
    env["TEMP"] = tmp_str
    env["TMP"] = tmp_str
    env["CI"] = "1"
    env["OPEN_DESIGN_LOCAL_CI"] = "1"
    env["NO_COLOR"] = "1"
    if extra_env:
        env.update(extra_env)
    return env


def run_with_process_group(
    cmd: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str] | None = None,
    timeout_s: int = 900,
    log_path: Path | None = None,
    stdin_text: str | None = None,
) -> tuple[int, str, bool]:
    """Run subprocess in its own process group; kill entire group on timeout."""
    if log_path is not None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        list(cmd),
        cwd=str(cwd),
        env=dict(env) if env is not None else None,
        stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        start_new_session=True,
    )
    timed_out = False
    output = ""
    try:
        stdout_data, _ = proc.communicate(input=stdin_text, timeout=timeout_s)
        output = stdout_data or ""
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        partial = exc.stdout
        if isinstance(partial, bytes):
            output = partial.decode("utf-8", errors="replace")
        elif isinstance(partial, str):
            output = partial
        _terminate_process_group(proc.pid)
        try:
            rem, _ = proc.communicate(timeout=5)
            if rem:
                output += rem
        except subprocess.TimeoutExpired:
            pass
    if log_path is not None:
        log_path.write_text(output, encoding="utf-8")
    return proc.returncode if proc.returncode is not None else 124, output, timed_out


def _terminate_process_group(pid: int) -> None:
    if os.name == "nt":
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        return
    try:
        pgid = os.getpgid(pid)
        os.killpg(pgid, signal.SIGTERM)
    except OSError:
        return
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        try:
            os.killpg(pgid, 0)
        except OSError:
            return
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except OSError:
        pass


def batched_git_object_oids(
    repo: Path,
    rel_paths: Sequence[str],
    *,
    revision: str = "HEAD",
) -> dict[str, str | None]:
    """Resolve multiple Git object OIDs in a single `git cat-file --batch-check` call."""
    unique_paths = sorted(set(rel_paths))
    if not unique_paths:
        return {}
    stdin_payload = "".join(f"{revision}:{p}\n" for p in unique_paths)
    proc = subprocess.run(
        ["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
        cwd=repo,
        input=stdin_payload,
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    lines = proc.stdout.splitlines()
    if len(lines) != len(unique_paths):
        raise LocalCiError("git cat-file --batch-check returned unexpected line count", code="GIT_ERROR")
    result: dict[str, str | None] = {}
    for path_key, line in zip(unique_paths, lines):
        if line.endswith(" missing") or " missing" in line:
            result[path_key] = None
        else:
            oid = line.split(" ", 1)[0].strip()
            result[path_key] = oid if SHA1_RE.fullmatch(oid) else None
    return result


def resolve_git_oid(repo: Path, rev: str, *, obj_type: str = "commit") -> str:
    proc = subprocess.run(
        ["git", "rev-parse", "--verify", f"{rev}^{{{obj_type}}}"],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    oid = proc.stdout.strip()
    if proc.returncode != 0 or not SHA1_RE.fullmatch(oid):
        raise LocalCiError(f"Cannot resolve Git {obj_type} for '{rev}'", code="GIT_REVISION_INVALID")
    return oid


def compute_candidate_identity(
    repo: Path,
    *,
    revision: str = "HEAD",
    base_ref: str | None = None,
) -> dict[str, Any]:
    """Compute canonical VCS + tree + policy + lockfile candidate identity."""
    head_oid = resolve_git_oid(repo, revision, obj_type="commit")
    tree_oid = resolve_git_oid(repo, head_oid, obj_type="tree")

    resolved_base_oid: str | None = None
    if base_ref:
        mb = subprocess.run(
            ["git", "merge-base", base_ref, head_oid],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if mb.returncode == 0 and SHA1_RE.fullmatch(mb.stdout.strip()):
            resolved_base_oid = mb.stdout.strip()
        else:
            resolved_base_oid = resolve_git_oid(repo, base_ref, obj_type="commit")
    else:
        parent = subprocess.run(
            ["git", "rev-parse", "--verify", f"{head_oid}^^{{commit}}"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        resolved_base_oid = parent.stdout.strip() if parent.returncode == 0 and SHA1_RE.fullmatch(parent.stdout.strip()) else head_oid

    cur_head_oid = None
    try:
        cur_head_oid = resolve_git_oid(repo, "HEAD", obj_type="commit")
    except LocalCiError:
        cur_head_oid = None
    ref_or_detached = "detached"
    if cur_head_oid == head_oid:
        sym = subprocess.run(
            ["git", "symbolic-ref", "-q", "HEAD"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if sym.returncode == 0 and sym.stdout.strip():
            ref_or_detached = sym.stdout.strip()

    tags_proc = subprocess.run(
        ["git", "tag", "--points-at", head_oid],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    sorted_exact_tags = sorted({line.strip() for line in tags_proc.stdout.splitlines() if line.strip()})

    manifest_paths = [
        ".agents/security-scanner-data.json",
        ".agents/gitleaks-baseline.json",
        ".agents/tiered-ci-plan.json",
        ".github/config/scopes.json",
        "pnpm-lock.yaml",
    ]
    batched_oids = batched_git_object_oids(repo, manifest_paths, revision=head_oid)

    policy_file = repo / ".agents" / "security-scanner-data.json"
    lock_file = repo / "pnpm-lock.yaml"
    policy_digest = sha256_file(policy_file) if policy_file.is_file() else sha256_bytes(b"")
    lockfile_digest = sha256_file(lock_file) if lock_file.is_file() else sha256_bytes(b"")

    cid_payload = json.dumps(
        {
            "head_oid": head_oid,
            "tree_oid": tree_oid,
            "base_oid": resolved_base_oid,
            "policy_digest": policy_digest,
            "lockfile_digest": lockfile_digest,
            "batched_oids": batched_oids,
        },
        sort_keys=True,
    ).encode("utf-8")

    return {
        "head_oid": head_oid,
        "tree_oid": tree_oid,
        "base_oid": resolved_base_oid,
        "ref_or_detached": ref_or_detached,
        "sorted_exact_tags": sorted_exact_tags,
        "policy_digest": policy_digest,
        "lockfile_digest": lockfile_digest,
        "batched_oids": batched_oids,
        "precomputed_cid": sha256_bytes(cid_payload),
    }


def safe_extract_git_archive(repo: Path, revision: str, dest_dir: Path) -> None:
    """Materialize an immutable Git revision without working-tree contamination."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix="od-archive-", suffix=".tar", delete=False) as tmp_tar:
        tar_path = Path(tmp_tar.name)
    try:
        subprocess.run(
            ["git", "archive", "--format=tar", f"--output={tar_path}", revision],
            cwd=repo,
            check=True,
            capture_output=True,
            timeout=120,
        )
        root = dest_dir.resolve()
        with tarfile.open(tar_path) as bundle:
            for member in bundle.getmembers():
                target = (dest_dir / member.name).resolve()
                if target != root and root not in target.parents:
                    raise LocalCiError("git archive contains unsafe traversal path", code="UNSAFE_ARCHIVE")
            bundle.extractall(dest_dir, filter="data")
    finally:
        tar_path.unlink(missing_ok=True)


def run_id_nonce(prefix: str = "run") -> str:
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    return f"{prefix}-{ts}-{secrets.token_hex(4)}"


def resolve_tool_script(env_var: str, default_path: Path, label: str) -> Path:
    override = os.environ.get(env_var, "").strip()
    candidate = Path(override) if override else default_path
    if not candidate.is_file():
        raise LocalCiError(f"{label} script not found at {candidate}", code="SKILL_SCRIPT_UNAVAILABLE")
    return candidate


def cleanup_temp_dir(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
