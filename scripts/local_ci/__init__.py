# localci:reads none
"""Additive Local CI, DevSecOps, and upstream-sync helpers for austinyuch/open-design."""

from __future__ import annotations

SCHEMA_VERSION = "1"
CONSUMER_ID = "open-design"
TIERED_PLAN_SCHEMA = "tiered-ci-plan/v1"
SECURITY_CONTRACT_SCHEMA = "aclab-shared-security-scanner-data-consumer/v2"
HANDOFF_PLAN_SCHEMA = "ci-handoff-plan/v1"
HANDOFF_RECEIPT_SCHEMA = "ci-handoff-receipt/v1"
GITLEAKS_RECEIPT_SCHEMA = "open-design-gitleaks-receipt/v1"
SBOM_KEV_RECEIPT_SCHEMA = "open-design-sbom-kev-receipt/v1"
UPSTREAM_CHECK_SCHEMA = "open-design-upstream-check/v1"
UPSTREAM_SYNC_RECEIPT_SCHEMA = "open-design-upstream-sync-receipt/v1"
