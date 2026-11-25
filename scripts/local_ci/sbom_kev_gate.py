# localci:reads .agents/security-scanner-data.json,pnpm-lock.yaml
"""Offline governed CycloneDX SBOM generation and CVE/KEV correlation gate."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Mapping

from . import CONSUMER_ID, SBOM_KEV_RECEIPT_SCHEMA
from .common import (
    DEFAULT_KEV_CORRELATE_SCRIPT,
    DEFAULT_PROVIDER_REGISTRY,
    IMAGE_ID_RE,
    PODMAN_COMMAND_PREFIX,
    SHA256_RE,
    LocalCiError,
    atomic_write_json,
    ensure_rootless_podman,
    git_blob_sha1,
    inspect_local_image_id,
    load_consumer_contract,
    pinned_scanner_image,
    resolve_git_oid,
    resolve_tool_script,
    rootless_podman_environment,
    run_id_nonce,
    runtime_dir,
    safe_extract_git_archive,
    sha256_file,
)

PROVIDER_ROOT_ENV = "ACLAB_SECURITY_DATA_PROVIDER_ROOT"
PROVIDER_ADAPTER_REL = Path("scripts") / "security_data_adapter.py"
PROVIDER_SOURCE_NAMES = (
    "security_data_adapter.py",
    "security_data_cache.py",
    "security_data_contract.py",
    "security_data_binding_contract.py",
)
TRIVY_CACHE_VOLUME = "local-ci-trivy-cache"
TRIVY_CACHE_MOUNT = "/trivy-cache"
TRIVY_BINDING_SCHEMA = "aclab-security-data-trivy-binding/v1"
PROVIDER_STATE_SCHEMA = "aclab-security-data-state/v1"
MAX_FUTURE_SKEW_SECONDS = 300
BINDING_MAX_AGE_SECONDS = 26 * 3600
PROVIDER_DB_MAX_AGE_SECONDS = 26 * 3600
IMAGE_ATTESTATION_MAX_AGE_SECONDS = 7 * 24 * 3600
SCOPE_EXCLUDED_DIRS = frozenset({".git", ".tmp", "node_modules", ".worktrees", "dist", ".next"})
MAX_FILE_READ_BYTES = 16 * 1024 * 1024


def _read_regular_bytes(directory: Path, name: str) -> bytes:
    path = directory / name
    try:
        info = path.lstat()
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise LocalCiError(f"Provider source unavailable: {path}", code="PROVIDER_INVALID") from exc
    if path.is_symlink() or resolved != path or not stat.S_ISREG(info.st_mode):
        raise LocalCiError(f"Provider source is unsafe or symlinked: {path}", code="PROVIDER_INVALID")
    if info.st_size > MAX_FILE_READ_BYTES:
        raise LocalCiError(f"Provider source too large: {path}", code="PROVIDER_INVALID")
    return path.read_bytes()


def _provider_registry_info() -> dict[str, Any]:
    reg_path = Path.home() / DEFAULT_PROVIDER_REGISTRY
    if not reg_path.is_file():
        return {}
    try:
        data = json.loads(reg_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _resolve_provider_root(env: Mapping[str, str] | None = None) -> Path:
    values = os.environ if env is None else env
    raw_root = values.get(PROVIDER_ROOT_ENV, "").strip()
    if not raw_root:
        reg = _provider_registry_info()
        reg_root = reg.get("checkout_root")
        if isinstance(reg_root, str):
            raw_root = reg_root.strip()
    if not raw_root:
        raise LocalCiError(
            f"{PROVIDER_ROOT_ENV} is unset and machine provider registry is unavailable; shared provider required",
            code="PROVIDER_UNAVAILABLE",
        )
    root = Path(raw_root)
    if not root.is_absolute():
        raise LocalCiError(f"{PROVIDER_ROOT_ENV} must be an absolute path", code="PROVIDER_INVALID")
    return root


def _provider_python() -> str:
    if sys.version_info < (3, 15):
        return sys.executable
    reg = _provider_registry_info()
    tools = reg.get("consumer_tool_paths")
    if isinstance(tools, dict):
        raw_py = tools.get("python")
        if isinstance(raw_py, str) and raw_py.strip():
            cand = Path(raw_py.strip())
            if cand.is_file() and os.access(cand, os.X_OK):
                return str(cand)
    return sys.executable


def _validate_provider_and_sources(contract: Mapping[str, Any], provider_root: Path) -> Path:
    adapter = provider_root / PROVIDER_ADAPTER_REL
    try:
        st = adapter.lstat()
        resolved = adapter.resolve(strict=True)
    except OSError as exc:
        raise LocalCiError(f"Security data provider adapter unavailable: {adapter}", code="PROVIDER_UNAVAILABLE") from exc
    if adapter.is_symlink() or resolved != adapter or not stat.S_ISREG(st.st_mode):
        raise LocalCiError(f"Security data provider adapter must be a non-symlink regular file: {adapter}", code="PROVIDER_INVALID")

    binding = contract.get("trivy_binding")
    release = binding.get("release") if isinstance(binding, Mapping) else None
    pins = release.get("sources") if isinstance(release, Mapping) else None
    if not isinstance(binding, Mapping) or not isinstance(release, Mapping) or not isinstance(pins, Mapping):
        raise LocalCiError("consumer contract trivy_binding release pins missing", code="INVALID_CONTRACT")
    if set(pins) != set(PROVIDER_SOURCE_NAMES):
        raise LocalCiError("consumer contract trivy_binding source set mismatch", code="INVALID_CONTRACT")

    for name in PROVIDER_SOURCE_NAMES:
        raw_bytes = _read_regular_bytes(adapter.parent, name)
        pin = pins.get(name)
        if not isinstance(pin, Mapping):
            raise LocalCiError(f"Missing source pin for {name}", code="INVALID_CONTRACT")
        if hashlib.sha256(raw_bytes).hexdigest() != pin.get("sha256") or git_blob_sha1(raw_bytes) != pin.get("git_blob_sha1"):
            raise LocalCiError(
                f"Provider source '{name}' does not match tracked v3.0.6 pin in .agents/security-scanner-data.json",
                code="PROVIDER_PIN_MISMATCH",
            )
    return adapter


def compute_scope_sha256(root: Path) -> str:
    """Compute canonical deterministic SHA-256 over immutable scan source tree."""
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise LocalCiError("Trivy scan scope must be a directory", code="INVALID_SCOPE")
    digest = hashlib.sha256(b"open-design-trivy-scope/v1\0")
    for item in sorted(root.rglob("*"), key=lambda p: p.relative_to(root).as_posix()):
        rel = item.relative_to(root)
        if any(part in SCOPE_EXCLUDED_DIRS for part in rel.parts):
            continue
        encoded = rel.as_posix().encode("utf-8")
        mode = item.lstat().st_mode
        if stat.S_ISLNK(mode):
            target_text = os.readlink(item)
            target = (item.parent / target_text).resolve(strict=True)
            if target != root and root not in target.parents:
                raise LocalCiError("Scan scope contains escaping symlink", code="UNSAFE_SCOPE")
            digest.update(b"L\0" + encoded + b"\0" + target_text.encode("utf-8") + b"\0")
        elif stat.S_ISREG(mode):
            digest.update(b"F\0" + encoded + b"\0" + str(mode & 0o777).encode("ascii") + b"\0")
            digest.update(bytes.fromhex(sha256_file(item)))
        elif stat.S_ISDIR(mode):
            digest.update(b"D\0" + encoded + b"\0")
        else:
            raise LocalCiError("Scan scope contains unsupported special file", code="UNSAFE_SCOPE")
    return digest.hexdigest()


def _parse_rfc3339_epoch(raw: str) -> int:
    text = raw.strip().replace("Z", "+00:00")
    if "." in text:
        head, _, tail = text.partition(".")
        digits = ""
        while tail and tail[0].isdigit():
            digits += tail[0]
            tail = tail[1:]
        text = f"{head}.{digits[:6]}{tail}" if digits else head + tail
    from datetime import datetime

    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("Timezone required")
    return int(parsed.timestamp())


def _adapter_env(base_env: Mapping[str, str] | None = None) -> dict[str, str]:
    values = os.environ if base_env is None else base_env
    keep = ("PATH", "HOME", "TMPDIR", "TEMP", "TMP", PROVIDER_ROOT_ENV)
    return {k: values[k] for k in keep if k in values}


def _run_adapter_json(cmd: list[str], *, cwd: Path, env: Mapping[str, str]) -> tuple[int, dict[str, Any]]:
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        env=dict(env),
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    raw = proc.stdout.strip()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise LocalCiError(
            f"Security data adapter returned invalid JSON (exit={proc.returncode}): {proc.stderr.strip()}",
            code="PROVIDER_INVALID",
        ) from exc
    if not isinstance(payload, dict):
        raise LocalCiError("Security data adapter response must be a JSON object", code="PROVIDER_INVALID")
    return proc.returncode, payload


def _validate_trivy_binding(
    payload: Mapping[str, Any],
    *,
    scope_sha: str,
    pinned_image: str,
    contract: Mapping[str, Any],
) -> dict[str, Any]:
    tracked = contract["trivy_binding"]
    if payload.get("schema") != TRIVY_BINDING_SCHEMA or payload.get("result") != "PASS":
        raise LocalCiError(
            f"Trivy provider binding refused: {payload.get('error', payload.get('error_code', 'unknown'))}",
            code="TRIVY_BINDING_DENIED",
        )
    consumer = payload.get("consumer")
    binding = payload.get("binding")
    provider = payload.get("provider")
    db = payload.get("db")
    receipt = payload.get("receipt")
    issued_at = payload.get("issued_at_epoch")
    if not all(isinstance(x, Mapping) for x in (consumer, binding, provider, db, receipt)):
        raise LocalCiError("Trivy provider binding response incomplete", code="TRIVY_BINDING_INVALID")
    if consumer.get("id") != CONSUMER_ID or consumer.get("scope_sha256") != scope_sha:
        raise LocalCiError("Trivy binding consumer/scope mismatch", code="TRIVY_BINDING_INVALID")
    if (
        binding.get("runtime") != "podman"
        or binding.get("image") != pinned_image
        or binding.get("cache_volume") != TRIVY_CACHE_VOLUME
        or binding.get("cache_mount") != TRIVY_CACHE_MOUNT
        or not isinstance(binding.get("image_id"), str)
        or not IMAGE_ID_RE.fullmatch(binding["image_id"])
    ):
        raise LocalCiError("Trivy binding runtime/image/volume authority mismatch", code="TRIVY_BINDING_INVALID")
    if (
        provider.get("state_schema") != PROVIDER_STATE_SCHEMA
        or provider.get("contract_schema") != tracked["contract_schema"]
        or provider.get("contract_version") != tracked["contract_version"]
        or provider.get("contract_sha256") != tracked["semantic_sha256"]
        or provider.get("read_only") is not True
    ):
        raise LocalCiError("Trivy provider contract authority mismatch", code="TRIVY_BINDING_INVALID")
    if type(issued_at) is not int or not isinstance(db.get("NextUpdate"), str):
        raise LocalCiError("Trivy binding timestamps missing", code="TRIVY_BINDING_INVALID")
    for field in ("refreshed_at_epoch", "image_attested_at_epoch", "next_update_epoch"):
        if type(receipt.get(field)) is not int:
            raise LocalCiError(f"Trivy binding missing {field}", code="TRIVY_BINDING_INVALID")

    now = int(time.time())
    try:
        next_update = _parse_rfc3339_epoch(db["NextUpdate"])
    except ValueError as exc:
        raise LocalCiError(f"Invalid db.NextUpdate: {exc}", code="TRIVY_BINDING_INVALID") from exc
    if (
        issued_at > now + MAX_FUTURE_SKEW_SECONDS
        or now - issued_at > BINDING_MAX_AGE_SECONDS
        or now - receipt["refreshed_at_epoch"] > PROVIDER_DB_MAX_AGE_SECONDS
        or now - receipt["image_attested_at_epoch"] > IMAGE_ATTESTATION_MAX_AGE_SECONDS
        or next_update <= now
        or receipt["next_update_epoch"] != next_update
    ):
        raise LocalCiError("Trivy binding freshness window expired or invalid", code="TRIVY_BINDING_STALE")

    actual_image_id = inspect_local_image_id(pinned_image)
    if actual_image_id != binding["image_id"]:
        raise LocalCiError(
            f"Local Podman Trivy image ID {actual_image_id} != provider attested {binding['image_id']}",
            code="TRIVY_IMAGE_ATTESTATION_MISMATCH",
        )
    return {
        "image": binding["image"],
        "image_id": actual_image_id,
        "cache_volume": binding["cache_volume"],
        "next_update": db["NextUpdate"],
        "contract_sha256": provider["contract_sha256"],
    }


def _extract_catalog_feed(status_payload: Mapping[str, Any], feed_name: str) -> dict[str, str]:
    if status_payload.get("schema") != PROVIDER_STATE_SCHEMA or status_payload.get("result") != "PASS":
        raise LocalCiError("Security data provider status check failed", code="CATALOG_UNAVAILABLE")
    feeds = status_payload.get("feeds")
    if not isinstance(feeds, list):
        raise LocalCiError("Security data provider status missing feeds", code="CATALOG_UNAVAILABLE")
    item = next((f for f in feeds if isinstance(f, Mapping) and f.get("feed") == feed_name), None)
    if not isinstance(item, Mapping):
        raise LocalCiError(f"Feed '{feed_name}' missing from provider status", code="CATALOG_UNAVAILABLE")
    if item.get("freshness") != "fresh":
        raise LocalCiError(
            f"Feed '{feed_name}' freshness is '{item.get('freshness')}' (provider refresh required)",
            code="CATALOG_STALE",
        )
    receipt = item.get("receipt")
    if not isinstance(receipt, Mapping):
        raise LocalCiError(f"Feed '{feed_name}' receipt missing", code="CATALOG_UNAVAILABLE")
    snap_raw = receipt.get("snapshot")
    expected_sha = receipt.get("sha256")
    entry_count = receipt.get("entry_count")
    if (
        not isinstance(snap_raw, str)
        or not snap_raw
        or not isinstance(expected_sha, str)
        or not SHA256_RE.fullmatch(expected_sha)
        or type(entry_count) is not int
        or entry_count <= 0
    ):
        raise LocalCiError(f"Feed '{feed_name}' receipt metadata invalid", code="CATALOG_INVALID")
    snap_path = Path(snap_raw)
    if not snap_path.is_absolute() or not snap_path.is_file():
        raise LocalCiError(f"Feed '{feed_name}' snapshot missing: {snap_path}", code="CATALOG_UNAVAILABLE")
    actual_sha = sha256_file(snap_path)
    if actual_sha != expected_sha:
        raise LocalCiError(f"Feed '{feed_name}' snapshot SHA-256 mismatch", code="CATALOG_PIN_MISMATCH")
    return {
        "snapshot": str(snap_path),
        "sha256": expected_sha,
        "catalog_version": str(receipt.get("catalog_version", "")),
        "date_released": str(receipt.get("date_released", "")),
    }


def _generate_cyclonedx_for_snapshot(
    *,
    repo: Path,
    snap_dir: Path,
    adapter: Path,
    py_exec: str,
    adapter_env: Mapping[str, str],
    pinned_image: str,
    contract: Mapping[str, Any],
    label: str,
) -> tuple[Path, dict[str, Any], dict[str, Any]]:
    scope_sha = compute_scope_sha256(snap_dir)
    rc, binding_payload = _run_adapter_json(
        [
            py_exec,
            str(adapter),
            "trivy-binding",
            "--consumer-id",
            CONSUMER_ID,
            "--consumer-scope-sha256",
            scope_sha,
            "--trivy-image",
            pinned_image,
            "--trivy-volume",
            TRIVY_CACHE_VOLUME,
            "--trivy-runtime",
            "podman",
        ],
        cwd=adapter.parent,
        env=adapter_env,
    )
    if rc != 0:
        raise LocalCiError(
            f"Trivy binding denied ({rc}): {binding_payload.get('error', binding_payload.get('error_code', 'unknown'))}",
            code="TRIVY_BINDING_DENIED",
        )
    binding_meta = _validate_trivy_binding(
        binding_payload,
        scope_sha=scope_sha,
        pinned_image=pinned_image,
        contract=contract,
    )

    store_dir = runtime_dir(repo) / "sbom"
    store_dir.mkdir(parents=True, exist_ok=True)
    nonce = secrets.token_hex(8)
    run_dir = store_dir / f"run-{label}-{nonce}"
    run_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(run_dir, 0o700)

    cand_path = run_dir / "candidate.cdx.json"
    cmd = [
        *PODMAN_COMMAND_PREFIX,
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--userns=keep-id",
        "-v",
        f"{snap_dir.resolve()}:/src:ro",
        "-v",
        f"{run_dir.resolve()}:/out:rw",
        "-v",
        f"{TRIVY_CACHE_VOLUME}:{TRIVY_CACHE_MOUNT}",
        pinned_image,
        "fs",
        "/src",
        "--scanners",
        "vuln",
        "--cache-dir",
        TRIVY_CACHE_MOUNT,
        "--skip-db-update",
        "--skip-java-db-update",
        "--offline-scan",
        "--skip-dirs",
        "node_modules,.git,.tmp,.worktrees,dist,.next",
        "--format",
        "cyclonedx",
        "--output",
        "/out/candidate.cdx.json",
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=240,
        env=rootless_podman_environment(),
        check=False,
    )
    if proc.returncode != 0:
        raise LocalCiError(
            f"Trivy offline CycloneDX generation failed ({proc.returncode}): {(proc.stderr or proc.stdout).strip()}",
            code="TRIVY_SCAN_FAILED",
        )
    if compute_scope_sha256(snap_dir) != scope_sha:
        raise LocalCiError("Source snapshot changed during bound Trivy scan (TOCTOU)", code="SCOPE_DRIFT")

    fd = os.open(cand_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
            raise LocalCiError("Generated SBOM custody validation failed", code="SBOM_CUSTODY_INVALID")
        with os.fdopen(os.dup(fd), "r", encoding="utf-8") as stream:
            sbom_obj = json.load(stream)
    finally:
        os.close(fd)

    if (
        not isinstance(sbom_obj, dict)
        or sbom_obj.get("bomFormat") != "CycloneDX"
        or not isinstance(sbom_obj.get("components"), list)
        or not sbom_obj["components"]
        or not isinstance(sbom_obj.get("vulnerabilities"), list)
    ):
        raise LocalCiError("Generated CycloneDX SBOM missing components or vulnerabilities", code="SBOM_INVALID")

    final_sbom = run_dir / f"{label}.cdx.json"
    os.link(cand_path, final_sbom)
    return final_sbom, sbom_obj, binding_meta


def _severity_breakdown(sbom_obj: Mapping[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = {"CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0, "UNKNOWN": 0}
    rank = {"CRITICAL": 4, "HIGH": 3, "MEDIUM": 2, "LOW": 1, "UNKNOWN": 0}
    for vuln in sbom_obj.get("vulnerabilities", []):
        if not isinstance(vuln, Mapping):
            continue
        best = "UNKNOWN"
        for rating in vuln.get("ratings", []):
            if not isinstance(rating, Mapping):
                continue
            sev = str(rating.get("severity", "")).upper()
            if sev in rank and rank[sev] > rank[best]:
                best = sev
        counts[best] += 1
    return counts


def _high_critical_ids(sbom_obj: Mapping[str, Any]) -> set[str]:
    result: set[str] = set()
    for vuln in sbom_obj.get("vulnerabilities", []):
        if not isinstance(vuln, Mapping):
            continue
        vid = str(vuln.get("id", "")).strip()
        if not vid:
            continue
        for rating in vuln.get("ratings", []):
            if isinstance(rating, Mapping) and str(rating.get("severity", "")).upper() in ("CRITICAL", "HIGH"):
                result.add(vid)
                break
    return result


def evaluate_correlation_gate(
    correlation_payload: Mapping[str, Any],
    *,
    new_high_critical_ids: set[str] | None = None,
    allow_upstream_cve_drift: bool = False,
) -> tuple[bool, int, str]:
    """Fail closed on any CISA KEV match or unwaived newly introduced CRITICAL/HIGH CVEs."""
    if correlation_payload.get("schema") != "security-cve-kev-correlation/v1":
        return False, 1, "Invalid correlation output schema"
    summary = correlation_payload.get("summary")
    if not isinstance(summary, Mapping):
        return False, 1, "Correlation summary missing"
    kev_listed = summary.get("kev_listed")
    if type(kev_listed) is not int or kev_listed < 0:
        return False, 1, "Correlation summary.kev_listed invalid"
    if kev_listed > 0:
        return False, 2, f"CISA KEV match detected ({kev_listed} KEV vulnerability/vulnerabilities listed)"
    if new_high_critical_ids and not allow_upstream_cve_drift:
        sample = ", ".join(sorted(new_high_critical_ids)[:8])
        return False, 2, f"New CRITICAL/HIGH CVEs introduced vs base: {sample}"
    return True, 0, "ok"


def run_sbom_kev(
    repo: Path,
    *,
    mode: str = "revision",
    revision: str = "HEAD",
    base_revision: str | None = None,
    allow_upstream_cve_drift: bool = False,
) -> dict[str, Any]:
    """Execute governed offline Trivy SBOM generation + CVE/KEV correlation."""
    ensure_rootless_podman()
    contract = load_consumer_contract(repo)
    pinned_image = pinned_scanner_image(repo, "trivy")
    provider_root = _resolve_provider_root()
    adapter = _validate_provider_and_sources(contract, provider_root)
    py_exec = _provider_python()
    adapter_env = _adapter_env()
    correlator = resolve_tool_script("ACLAB_KEV_CORRELATE_SCRIPT", DEFAULT_KEV_CORRELATE_SCRIPT, "security_cve_kev_correlate.py")

    rc_status, status_payload = _run_adapter_json([py_exec, str(adapter), "status"], cwd=adapter.parent, env=adapter_env)
    if rc_status != 0:
        raise LocalCiError(f"Security data provider status failed ({rc_status})", code="PROVIDER_UNAVAILABLE")
    kev_feed = _extract_catalog_feed(status_payload, "kev")
    cve_feed = _extract_catalog_feed(status_payload, "cve")

    commit_oid: str | None = None
    if mode == "revision":
        commit_oid = resolve_git_oid(repo, revision, obj_type="commit")

    with tempfile.TemporaryDirectory(prefix="od-sbom-src-") as src_tmp:
        snap_dir = Path(src_tmp) / "src"
        if mode == "revision":
            assert commit_oid is not None
            safe_extract_git_archive(repo, commit_oid, snap_dir)
            label = f"rev-{commit_oid[:12]}"
        elif mode == "staged":
            snap_dir.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                ["git", "checkout-index", "--all", f"--prefix={snap_dir}/"],
                cwd=repo,
                check=True,
                capture_output=True,
                timeout=60,
            )
            label = "staged"
        else:
            raise LocalCiError(f"Unsupported SBOM mode: {mode}", code="INVALID_MODE")

        sbom_path, sbom_obj, binding_meta = _generate_cyclonedx_for_snapshot(
            repo=repo,
            snap_dir=snap_dir,
            adapter=adapter,
            py_exec=py_exec,
            adapter_env=adapter_env,
            pinned_image=pinned_image,
            contract=contract,
            label=label,
        )

    new_high_crit: set[str] = set()
    base_checked = False
    if base_revision and commit_oid:
        base_oid = resolve_git_oid(repo, base_revision, obj_type="commit")
        diff_proc = subprocess.run(
            ["git", "diff", "--quiet", base_oid, commit_oid, "--", "pnpm-lock.yaml"],
            cwd=repo,
            check=False,
            timeout=15,
        )
        if diff_proc.returncode == 1:
            base_checked = True
            with tempfile.TemporaryDirectory(prefix="od-sbom-base-") as base_tmp:
                base_snap = Path(base_tmp) / "src"
                safe_extract_git_archive(repo, base_oid, base_snap)
                _, base_sbom_obj, _ = _generate_cyclonedx_for_snapshot(
                    repo=repo,
                    snap_dir=base_snap,
                    adapter=adapter,
                    py_exec=py_exec,
                    adapter_env=adapter_env,
                    pinned_image=pinned_image,
                    contract=contract,
                    label=f"base-{base_oid[:12]}",
                )
            new_high_crit = _high_critical_ids(sbom_obj) - _high_critical_ids(base_sbom_obj)

    corr_proc = subprocess.run(
        [
            sys.executable,
            str(correlator),
            f"{CONSUMER_ID}={sbom_path}",
            "--cve-catalog",
            cve_feed["snapshot"],
            "--expect-cve-sha256",
            cve_feed["sha256"],
            "--kev-catalog",
            kev_feed["snapshot"],
            "--expect-kev-sha256",
            kev_feed["sha256"],
            "--format",
            "json",
        ],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if corr_proc.returncode != 0:
        raise LocalCiError(
            f"CVE/KEV correlator failed ({corr_proc.returncode}): {(corr_proc.stderr or corr_proc.stdout).strip()}",
            code="KEV_CORRELATOR_FAILED",
        )
    try:
        corr_payload = json.loads(corr_proc.stdout)
    except json.JSONDecodeError as exc:
        raise LocalCiError(f"CVE/KEV correlator returned invalid JSON: {exc}", code="KEV_CORRELATOR_INVALID") from exc

    gate_ok, gate_exit, gate_reason = evaluate_correlation_gate(
        corr_payload,
        new_high_critical_ids=new_high_crit,
        allow_upstream_cve_drift=allow_upstream_cve_drift,
    )

    kev_routes = [r for r in corr_payload.get("routes", []) if r.get("kev_status") == "listed"]
    receipt = {
        "schema": SBOM_KEV_RECEIPT_SCHEMA,
        "mode": mode,
        "commit_oid": commit_oid,
        "sbom_path": str(sbom_path),
        "sbom_sha256": sha256_file(sbom_path),
        "component_count": len(sbom_obj.get("components", [])),
        "vulnerability_count": len(sbom_obj.get("vulnerabilities", [])),
        "severity_counts": _severity_breakdown(sbom_obj),
        "trivy_binding": binding_meta,
        "cve_catalog": {
            "version": cve_feed["catalog_version"],
            "date_released": cve_feed["date_released"],
            "sha256": cve_feed["sha256"],
            "completeness": "not-asserted-by-source-schema",
        },
        "kev_catalog": {
            "version": kev_feed["catalog_version"],
            "date_released": kev_feed["date_released"],
            "sha256": kev_feed["sha256"],
            "completeness": "not-asserted-by-source-schema",
        },
        "correlation_summary": corr_payload.get("summary"),
        "kev_matches": kev_routes,
        "base_lockfile_compared": base_checked,
        "new_high_critical_cves": sorted(new_high_crit),
        "allow_upstream_cve_drift": allow_upstream_cve_drift,
        "status": "pass" if gate_ok else "fail",
        "gate_reason": gate_reason,
        "exit_code": gate_exit,
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt_path = runtime_dir(repo) / "sbom" / f"{run_id_nonce('sbom-kev')}.receipt.json"
    atomic_write_json(receipt_path, receipt)
    receipt["receipt_path"] = str(receipt_path)
    return receipt
