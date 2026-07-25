"""Phase 7 research-only direct Argos CTranslate2/SentencePiece POC.

This script never imports argostranslate, installs packages, accesses a package
index, or writes model output outside the ignored Phase 7 artifact root.
"""

from __future__ import annotations

import argparse
import ctypes
from datetime import datetime
import gc
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import sys
import threading
import unicodedata
import urllib.request
import uuid
from typing import Any, Sequence

try:
    import msvcrt
except ImportError:  # pragma: no cover - runtime execution is Windows-only.
    msvcrt = None


SCRIPT_ROOT = Path(__file__).parent
REPOSITORY_ROOT = SCRIPT_ROOT.parents[1]
ARTIFACT_ROOT = REPOSITORY_ROOT / "artifacts" / "phase7" / "offline-poc"
INPUT_ROOT = ARTIFACT_ROOT / "blind-eval-input"
MATERIALIZED_ROOT = ARTIFACT_ROOT / "argos" / "materialized"
GENERATION_ROOT = ARTIFACT_ROOT / "argos" / "generations"
RUNTIME_ROOT = (
    ARTIFACT_ROOT
    / "argos"
    / "runtime"
    / "materialized"
    / "argos-cp313-win-x64-v1"
)
DEFAULT_MANIFEST_PATH = SCRIPT_ROOT / "argos-candidates.json"
POC_SCOPE = "POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION"
MANIFEST_SCHEMA_VERSION = "phase7-argos-direct-poc-candidates-v1"
AUTHORIZATION_SCHEMA_VERSION = "phase7-offline-poc-authorization-v1"
RECEIPT_SCHEMA_VERSION = "phase7-argos-materialization-receipt-v1"
INPUT_ITEM_SCHEMA_VERSION = "phase7-argos-generation-input-item-v1"
OUTPUT_ITEM_SCHEMA_VERSION = (
    "phase7-argos-blind-eval-candidate-output-v1"
)
REPORT_SCHEMA_VERSION = "phase7-argos-direct-poc-report-v1"
MAX_RECORDS = 1000
MAX_SOURCE_CHARACTERS = 12_000
MAX_TOTAL_SOURCE_CHARACTERS = 4_000_000
MAX_SOURCE_UTF8_BYTES = 48_000
MAX_SOURCE_TOKENS = 4096
MAX_TRANSLATION_CHARACTERS = 24_000
MAX_INPUT_FILE_BYTES = 16 * 1024 * 1024
MAX_RECEIPT_BYTES = 4 * 1024 * 1024
MAX_RUNTIME_RECEIPT_BYTES = 16 * 1024 * 1024
MAX_RUNTIME_DIAGNOSTIC_BYTES = 1024 * 1024
RUNTIME_RECEIPT_NAME = ".argos-runtime-receipt.json"
RUNTIME_RECEIPT_SCHEMA_VERSION = (
    "phase7-argos-runtime-materialization-receipt-v1"
)
SLUG_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$")
AUTHORIZATION_RECORD_ID_PATTERN = SLUG_PATTERN
AUTHORIZATION_DATETIME_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"
    r"(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$"
)
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
FORBIDDEN_TEXT_PATTERNS = (
    re.compile(
        r"(?:^|[\s\"'(])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+)"
    ),
    re.compile(r"(?:^|[\s\"'(])/(?:home|Users)/[^/\s]+"),
    re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I),
    re.compile(r"(?:^|\D)1[3-9]\d{9}(?:\D|$)"),
    re.compile(
        r"\b(?:sk-(?:proj-)?|ghp_|github_pat_|AIza)"
        r"[A-Za-z0-9_-]{12,}"
    ),
    re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]"),
)
WINDOWS_RESERVED_LEAF_NAMES = {
    "AUX",
    "CLOCK$",
    "CON",
    "NUL",
    "PRN",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}
EXPECTED_POLICY_KEYS = {
    "scope",
    "defaultNetworkAccess",
    "downloadsRequireExplicitFlags",
    "downloadsRequireBoundResearchAuthorization",
    "artifactRoot",
    "globalPackageInstallationAllowed",
    "automaticPackageInstallationAllowed",
    "productIntegrationAllowed",
    "modelDistributionAllowed",
    "rawSourceOrTranslationTextInReportsAllowed",
    "privateBlindEvaluationCandidateOutputAllowed",
    "maximumArchiveCompressionRatio",
    "maximumSingleExtractedFileBytes",
}


class ArgosPocFailure(Exception):
    """A stable, text-free failure code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class SanitizedArgumentParser(argparse.ArgumentParser):
    """Avoid echoing user-controlled argument values on parse failures."""

    def error(self, _message: str) -> None:
        raise ArgosPocFailure("ARGOS_ARGUMENTS_INVALID")


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def parse_json_strict(value: str) -> Any:
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in pairs:
            if key in result:
                raise ArgosPocFailure("ARGOS_JSON_DUPLICATE_KEY_REJECTED")
            result[key] = item
        return result

    return json.loads(value, object_pairs_hook=unique_object)


def load_json_file(
    path: Path,
    *,
    maximum_bytes: int,
    safe_root: Path | None = None,
) -> tuple[dict[str, Any], bytes]:
    if safe_root is not None:
        assert_safe_existing_file(path, safe_root)
    try:
        size = path.stat().st_size
    except OSError as error:
        raise ArgosPocFailure("ARGOS_JSON_FILE_NOT_FOUND") from error
    if size < 2 or size > maximum_bytes:
        raise ArgosPocFailure("ARGOS_JSON_FILE_SIZE_INVALID")
    try:
        raw = path.read_bytes()
        value = parse_json_strict(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ArgosPocFailure("ARGOS_JSON_FILE_INVALID") from error
    if not isinstance(value, dict):
        raise ArgosPocFailure("ARGOS_JSON_ROOT_NOT_OBJECT")
    return value, raw


def load_manifest() -> tuple[dict[str, Any], str]:
    manifest, _raw = load_json_file(
        DEFAULT_MANIFEST_PATH,
        maximum_bytes=2 * 1024 * 1024,
    )
    policy = manifest.get("policy", {})
    runtime = manifest.get("runtime", {})
    if (
        manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION
        or not isinstance(policy, dict)
        or set(policy) != EXPECTED_POLICY_KEYS
        or policy.get("scope") != POC_SCOPE
        or policy.get("defaultNetworkAccess") is not False
        or policy.get("downloadsRequireExplicitFlags")
        != ["--download", "--allow-network"]
        or policy.get("downloadsRequireBoundResearchAuthorization")
        is not True
        or policy.get("artifactRoot")
        != "artifacts/phase7/offline-poc"
        or policy.get("globalPackageInstallationAllowed")
        is not False
        or policy.get("automaticPackageInstallationAllowed")
        is not False
        or policy.get("productIntegrationAllowed") is not False
        or policy.get("modelDistributionAllowed") is not False
        or policy.get("rawSourceOrTranslationTextInReportsAllowed")
        is not False
        or policy.get("privateBlindEvaluationCandidateOutputAllowed")
        is not True
        or runtime.get("executionTreeStatus")
        != "PINNED_CONTROLLED_MATERIALIZATION_V1"
        or not SHA256_PATTERN.fullmatch(
            str(runtime.get("runtimeSupplySetSha256", ""))
        )
        or not SHA256_PATTERN.fullmatch(
            str(runtime.get("executionTreeSha256", ""))
        )
        or runtime.get("executionTreeFileCount") != 1435
        or runtime.get("executionTreeBytes") != 132_513_327
        or runtime.get("excludedWheelFileCount") != 79
        or not SHA256_PATTERN.fullmatch(
            str(runtime.get("builderScriptSha256", ""))
        )
        or manifest.get("gateA", {}).get("status") != "BLOCKED"
        or manifest.get("gateA", {}).get("harnessMayDecide") is not False
    ):
        raise ArgosPocFailure("ARGOS_MANIFEST_POLICY_INVALID")
    return manifest, sha256_text(canonical_json(manifest))


def select_candidate(
    manifest: dict[str, Any], candidate_id: str
) -> dict[str, Any]:
    matches = [
        candidate
        for candidate in manifest.get("candidates", [])
        if candidate.get("id") == candidate_id
    ]
    if len(matches) != 1:
        raise ArgosPocFailure("ARGOS_CANDIDATE_UNKNOWN")
    candidate = matches[0]
    license_record = candidate.get("license", {})
    readme_observation = license_record.get(
        "packageReadmeObservation", {}
    )
    archive = candidate.get("archive", {})
    if (
        license_record.get("expression") != "NOASSERTION"
        or license_record.get("status") != "LEGAL_REVIEW_REQUIRED"
        or license_record.get("commercialUseConclusion")
        != "LEGAL_REVIEW_REQUIRED"
        or readme_observation.get("statementScope")
        != "ORIGINAL_OPUS_MODEL_FROM_WHICH_THE_PACKAGED_MODEL_DERIVES"
        or readme_observation.get("observedExpression") != "CC-BY-4.0"
        or readme_observation.get("coverageStatus")
        != "LEGAL_REVIEW_REQUIRED"
        or archive.get("extractedFileCount") != 8
        or not SHA256_PATTERN.fullmatch(
            str(archive.get("extractedTreeSha256", ""))
        )
    ):
        raise ArgosPocFailure("ARGOS_CANDIDATE_LICENSE_POLICY_INVALID")
    return candidate


def selected_risk_codes(
    manifest: dict[str, Any], candidate_ids: Sequence[str]
) -> list[str]:
    runtime_id = manifest["runtime"]["id"]
    selected = set(candidate_ids)
    return sorted(
        {
            blocker["code"]
            for blocker in manifest["gateA"]["blockers"]
            if selected.intersection(blocker["appliesTo"])
            or runtime_id in blocker["appliesTo"]
        }
    )


def verify_authorization(
    path: Path,
    manifest: dict[str, Any],
    manifest_sha256: str,
    candidate_id: str | Sequence[str],
) -> tuple[dict[str, Any], str]:
    authorization, raw = load_json_file(
        path,
        maximum_bytes=1024 * 1024,
        safe_root=ARTIFACT_ROOT,
    )
    candidate_ids = (
        [candidate_id]
        if isinstance(candidate_id, str)
        else sorted(candidate_id)
    )
    if (
        not candidate_ids
        or len(set(candidate_ids)) != len(candidate_ids)
        or any(
            not any(
                candidate.get("id") == selected
                for candidate in manifest.get("candidates", [])
            )
            for selected in candidate_ids
        )
    ):
        raise ArgosPocFailure(
            "ARGOS_POC_AUTHORIZATION_INVALID_OR_STALE"
        )
    expected_risks = selected_risk_codes(manifest, candidate_ids)
    acknowledged_risks = authorization.get("acknowledgedRiskCodes")
    expected_keys = {
        "schemaVersion",
        "authorization",
        "scope",
        "basis",
        "manifestSha256",
        "candidateIds",
        "observedLicenseMetadataExpressions",
        "acknowledgedRiskCodes",
        "authorizationRecordId",
        "authorizedAt",
    }
    if (
        set(authorization) != expected_keys
        or authorization.get("schemaVersion")
        != AUTHORIZATION_SCHEMA_VERSION
        or authorization.get("authorization")
        != "AUTHORIZED_FOR_POC_RESEARCH_ONLY"
        or authorization.get("scope") != POC_SCOPE
        or authorization.get("basis") != "PHASE7_M0_USER_AUTHORIZATION"
        or authorization.get("manifestSha256") != manifest_sha256
        or authorization.get("candidateIds") != candidate_ids
        or authorization.get("observedLicenseMetadataExpressions")
        != ["CC-BY-4.0"]
        or not isinstance(acknowledged_risks, list)
        or not all(isinstance(code, str) for code in acknowledged_risks)
        or sorted(acknowledged_risks)
        != expected_risks
        or len(set(acknowledged_risks)) != len(acknowledged_risks)
        or not AUTHORIZATION_RECORD_ID_PATTERN.fullmatch(
            str(authorization.get("authorizationRecordId", ""))
        )
        or not is_valid_datetime(authorization.get("authorizedAt"))
    ):
        raise ArgosPocFailure(
            "ARGOS_POC_AUTHORIZATION_INVALID_OR_STALE"
        )
    return authorization, sha256_bytes(raw)


def is_valid_datetime(value: Any) -> bool:
    if (
        not isinstance(value, str)
        or not AUTHORIZATION_DATETIME_PATTERN.fullmatch(value)
    ):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def verify_materialized_tree(
    model_root: Path,
    manifest_sha256: str,
    candidate: dict[str, Any],
    authorization_record_id: str,
    authorization_sha256: str,
) -> str:
    if (
        not AUTHORIZATION_RECORD_ID_PATTERN.fullmatch(
            authorization_record_id
        )
        or not SHA256_PATTERN.fullmatch(authorization_sha256)
    ):
        raise ArgosPocFailure(
            "ARGOS_MATERIALIZATION_AUTHORIZATION_CONTEXT_INVALID"
        )
    assert_safe_existing_directory(model_root, MATERIALIZED_ROOT)
    receipt_path = model_root / ".argos-materialization-receipt.json"
    receipt, _raw = load_json_file(
        receipt_path,
        maximum_bytes=MAX_RECEIPT_BYTES,
        safe_root=MATERIALIZED_ROOT,
    )
    extraction = receipt.get("extraction", {})
    if (
        receipt.get("schemaVersion") != RECEIPT_SCHEMA_VERSION
        or receipt.get("scope") != POC_SCOPE
        or receipt.get("manifestSha256") != manifest_sha256
        or receipt.get("candidateId") != candidate["id"]
        or receipt.get("authorizationRecordId")
        != authorization_record_id
        or receipt.get("authorizationSha256") != authorization_sha256
        or receipt.get("archive", {}).get("sha256")
        != candidate["archive"]["sha256"]
        or extraction.get("treeSha256")
        != candidate["archive"]["extractedTreeSha256"]
        or extraction.get("fileCount")
        != candidate["archive"]["extractedFileCount"]
        or extraction.get("safePathPolicy")
        != "WINDOWS_FAIL_CLOSED_V1"
        or extraction.get("symlinksOrReparsePointsCreated") is not False
        or not isinstance(extraction.get("files"), list)
        or not SHA256_PATTERN.fullmatch(
            str(extraction.get("treeSha256", ""))
        )
    ):
        raise ArgosPocFailure(
            "ARGOS_MATERIALIZATION_RECEIPT_INVALID_OR_STALE"
        )
    expected_paths: set[str] = set()
    actual_records: list[dict[str, Any]] = []
    for expected in extraction["files"]:
        if (
            not isinstance(expected, dict)
            or not is_safe_relative_path(expected.get("path"))
            or not isinstance(expected.get("size"), int)
            or expected["size"] < 1
            or not SHA256_PATTERN.fullmatch(
                str(expected.get("sha256", ""))
            )
            or expected["path"] in expected_paths
        ):
            raise ArgosPocFailure(
                "ARGOS_MATERIALIZATION_RECEIPT_FILE_INVALID"
            )
        expected_paths.add(expected["path"])
        file_path = lexical_absolute(
            model_root.joinpath(*expected["path"].split("/"))
        )
        assert_safe_existing_file(file_path, model_root)
        digest, size = hash_file(file_path, expected["size"])
        if digest != expected["sha256"] or size != expected["size"]:
            raise ArgosPocFailure("ARGOS_MATERIALIZED_FILE_MISMATCH")
        actual_records.append(
            {
                "path": expected["path"],
                "size": size,
                "sha256": digest,
            }
        )
    actual_paths = set()
    for directory, directories, files in os.walk(
        model_root, topdown=True, followlinks=False
    ):
        directory_path = Path(directory)
        assert_no_reparse(directory_path)
        for name in directories:
            assert_no_reparse(directory_path / name)
        for name in files:
            file_path = directory_path / name
            assert_no_reparse(file_path)
            relative = file_path.relative_to(model_root).as_posix()
            if relative != ".argos-materialization-receipt.json":
                actual_paths.add(relative)
    if actual_paths != expected_paths:
        raise ArgosPocFailure("ARGOS_MATERIALIZATION_EXTRA_OR_MISSING_FILE")
    tree_sha256 = sha256_text(canonical_json(actual_records))
    if (
        tree_sha256 != candidate["archive"]["extractedTreeSha256"]
        or tree_sha256 != extraction["treeSha256"]
        or len(actual_records) != extraction.get("fileCount")
        or sum(record["size"] for record in actual_records)
        != extraction.get("totalBytes")
    ):
        raise ArgosPocFailure("ARGOS_MATERIALIZATION_TREE_MISMATCH")
    for required in (
        "sentencepiece.model",
        "model/config.json",
        "model/model.bin",
        "model/shared_vocabulary.json",
    ):
        if required not in expected_paths:
            raise ArgosPocFailure("ARGOS_RUNTIME_MODEL_FILE_MISSING")
    return tree_sha256


def parse_generation_input(path: Path) -> tuple[list[dict[str, Any]], str]:
    assert_safe_existing_file(path, INPUT_ROOT)
    try:
        size = path.stat().st_size
    except OSError as error:
        raise ArgosPocFailure("ARGOS_GENERATION_INPUT_NOT_FOUND") from error
    if size < 2 or size > MAX_INPUT_FILE_BYTES:
        raise ArgosPocFailure("ARGOS_GENERATION_INPUT_SIZE_INVALID")
    try:
        raw = path.read_bytes()
        text = raw.decode("utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise ArgosPocFailure("ARGOS_GENERATION_INPUT_READ_FAILED") from error
    suffix = path.suffix.lower()
    try:
        if suffix == ".jsonl":
            lines = text.splitlines()
            if not lines or any(not line.strip() for line in lines):
                raise ArgosPocFailure(
                    "ARGOS_GENERATION_JSONL_BLANK_LINE_REJECTED"
                )
            records = [parse_json_strict(line) for line in lines]
        elif suffix == ".json":
            decoded = parse_json_strict(text)
            if isinstance(decoded, list):
                records = decoded
            elif (
                isinstance(decoded, dict)
                and decoded.get("schemaVersion")
                == "phase7-argos-generation-input-batch-v1"
                and isinstance(decoded.get("items"), list)
            ):
                records = decoded["items"]
            else:
                raise ArgosPocFailure(
                    "ARGOS_GENERATION_JSON_ROOT_INVALID"
                )
        else:
            raise ArgosPocFailure(
                "ARGOS_GENERATION_INPUT_EXTENSION_INVALID"
            )
    except json.JSONDecodeError as error:
        raise ArgosPocFailure("ARGOS_GENERATION_INPUT_PARSE_FAILED") from error
    validate_generation_records(records)
    return records, sha256_bytes(raw)


def validate_generation_records(records: Any) -> None:
    if (
        not isinstance(records, list)
        or not records
        or len(records) > MAX_RECORDS
    ):
        raise ArgosPocFailure("ARGOS_GENERATION_RECORD_COUNT_INVALID")
    item_ids: set[str] = set()
    source_hashes: set[tuple[str, str]] = set()
    total_characters = 0
    expected_keys = {
        "schemaVersion",
        "itemId",
        "direction",
        "source",
        "contentDeclaration",
        "containsPersonalData",
        "usageAuthorization",
    }
    for record in records:
        if not isinstance(record, dict) or set(record) != expected_keys:
            raise ArgosPocFailure("ARGOS_GENERATION_INPUT_SHAPE_INVALID")
        item_id = record.get("itemId")
        source = record.get("source")
        direction = record.get("direction")
        if (
            record.get("schemaVersion") != INPUT_ITEM_SCHEMA_VERSION
            or not isinstance(item_id, str)
            or not SLUG_PATTERN.fullmatch(item_id)
            or direction not in ("en-zh", "zh-en")
            or not isinstance(source, str)
            or not 1 <= len(source) <= MAX_SOURCE_CHARACTERS
            or len(source.encode("utf-8")) > MAX_SOURCE_UTF8_BYTES
            or record.get("contentDeclaration")
            != "NO_USER_HISTORY_NO_CLIPBOARD_NO_PRIVATE_CORPUS"
            or record.get("containsPersonalData") is not False
            or record.get("usageAuthorization")
            != "AUTHORIZED_FOR_PHASE7_HUMAN_EVALUATION"
        ):
            raise ArgosPocFailure("ARGOS_GENERATION_INPUT_POLICY_INVALID")
        assert_text_privacy_safe(source)
        if item_id in item_ids:
            raise ArgosPocFailure("ARGOS_GENERATION_DUPLICATE_ITEM_ID")
        item_ids.add(item_id)
        normalized_source = unicodedata.normalize(
            "NFKC", " ".join(source.split())
        ).casefold()
        normalized_digest = sha256_text(normalized_source)
        source_key = (direction, normalized_digest)
        if source_key in source_hashes:
            raise ArgosPocFailure("ARGOS_GENERATION_DUPLICATE_SOURCE")
        source_hashes.add(source_key)
        total_characters += len(source)
    if total_characters > MAX_TOTAL_SOURCE_CHARACTERS:
        raise ArgosPocFailure(
            "ARGOS_GENERATION_TOTAL_SOURCE_SIZE_EXCEEDED"
        )


def assert_text_privacy_safe(text: str) -> None:
    if any(pattern.search(text) for pattern in FORBIDDEN_TEXT_PATTERNS):
        raise ArgosPocFailure("ARGOS_GENERATION_TEXT_PRIVACY_REJECTED")


def install_process_socket_guard() -> None:
    def denied(*_args: Any, **_kwargs: Any) -> None:
        raise ArgosPocFailure("ARGOS_RUNTIME_NETWORK_ATTEMPT_REJECTED")

    class DeniedSocket(socket.socket):
        def connect(self, *_args: Any, **_kwargs: Any) -> None:
            denied()

        def connect_ex(self, *_args: Any, **_kwargs: Any) -> int:
            denied()
            return 1

    socket.socket = DeniedSocket
    socket.create_connection = denied
    urllib.request.urlopen = denied


def verify_runtime_tree(
    manifest: dict[str, Any],
    manifest_sha256: str,
) -> dict[str, Any]:
    runtime_root = lexical_absolute(Path(sys.executable).parent)
    if (
        os.name != "nt"
        or runtime_root != lexical_absolute(RUNTIME_ROOT)
        or lexical_absolute(Path(sys.executable))
        != lexical_absolute(RUNTIME_ROOT / "python.exe")
        or sys.version_info[:3] != (3, 13, 10)
        or sys.flags.isolated != 1
        or sys.flags.no_user_site != 1
    ):
        raise ArgosPocFailure(
            "ARGOS_PINNED_EMBEDDED_RUNTIME_REQUIRED"
        )
    assert_safe_existing_directory(runtime_root, RUNTIME_ROOT.parent)
    receipt, _raw = load_json_file(
        runtime_root / RUNTIME_RECEIPT_NAME,
        maximum_bytes=MAX_RUNTIME_RECEIPT_BYTES,
        safe_root=runtime_root,
    )
    runtime = manifest["runtime"]
    expected_keys = {
        "schemaVersion",
        "scope",
        "manifestSha256",
        "authorizationRecordId",
        "authorizationSha256",
        "candidateIds",
        "runtimeSupplySetSha256",
        "executionTreeSha256",
        "fileCount",
        "totalBytes",
        "excludedWheelFiles",
        "files",
        "networkAccess",
        "runtimeImported",
        "modelExecuted",
        "productIntegrationAuthorized",
    }
    if (
        set(receipt) != expected_keys
        or receipt.get("schemaVersion")
        != RUNTIME_RECEIPT_SCHEMA_VERSION
        or receipt.get("scope") != POC_SCOPE
        or receipt.get("manifestSha256") != manifest_sha256
        or not AUTHORIZATION_RECORD_ID_PATTERN.fullmatch(
            str(receipt.get("authorizationRecordId", ""))
        )
        or not SHA256_PATTERN.fullmatch(
            str(receipt.get("authorizationSha256", ""))
        )
        or receipt.get("candidateIds")
        != sorted(candidate["id"] for candidate in manifest["candidates"])
        or receipt.get("runtimeSupplySetSha256")
        != runtime["runtimeSupplySetSha256"]
        or receipt.get("executionTreeSha256")
        != runtime["executionTreeSha256"]
        or receipt.get("fileCount") != runtime["executionTreeFileCount"]
        or receipt.get("totalBytes") != runtime["executionTreeBytes"]
        or not isinstance(receipt.get("excludedWheelFiles"), list)
        or len(receipt["excludedWheelFiles"])
        != runtime["excludedWheelFileCount"]
        or not isinstance(receipt.get("files"), list)
        or receipt.get("networkAccess") != "NOT_PERFORMED"
        or receipt.get("runtimeImported") is not False
        or receipt.get("modelExecuted") is not False
        or receipt.get("productIntegrationAuthorized") is not False
    ):
        raise ArgosPocFailure(
            "ARGOS_RUNTIME_RECEIPT_INVALID_OR_STALE"
        )
    records: list[dict[str, Any]] = []
    folded_paths: set[str] = set()
    for directory, directories, files in os.walk(
        runtime_root,
        topdown=True,
        followlinks=False,
    ):
        directory_path = Path(directory)
        assert_no_reparse(directory_path)
        for name in directories:
            assert_no_reparse(directory_path / name)
        for name in files:
            path = directory_path / name
            if path.name == RUNTIME_RECEIPT_NAME:
                continue
            status = assert_no_reparse(path)
            if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
                raise ArgosPocFailure("ARGOS_RUNTIME_TREE_FILE_UNSAFE")
            relative = path.relative_to(runtime_root).as_posix()
            if (
                not is_safe_relative_path(relative)
                or relative.casefold().endswith(".pth")
                or "__pycache__" in relative.split("/")
                or relative.casefold().endswith(".pyc")
            ):
                raise ArgosPocFailure(
                    "ARGOS_RUNTIME_TREE_PATH_POLICY_INVALID"
                )
            folded = relative.casefold()
            if folded in folded_paths:
                raise ArgosPocFailure(
                    "ARGOS_RUNTIME_TREE_PATH_COLLISION"
                )
            folded_paths.add(folded)
            digest = hashlib.sha256()
            size = 0
            try:
                with path.open("rb") as file:
                    while chunk := file.read(1024 * 1024):
                        size += len(chunk)
                        digest.update(chunk)
            except OSError as error:
                raise ArgosPocFailure(
                    "ARGOS_RUNTIME_TREE_READ_FAILED"
                ) from error
            records.append(
                {
                    "path": relative,
                    "size": size,
                    "sha256": digest.hexdigest(),
                }
            )
    records.sort(key=lambda item: item["path"])
    tree_sha256 = sha256_text(canonical_json(records))
    if (
        records != receipt["files"]
        or tree_sha256 != runtime["executionTreeSha256"]
        or len(records) != runtime["executionTreeFileCount"]
        or sum(record["size"] for record in records)
        != runtime["executionTreeBytes"]
    ):
        raise ArgosPocFailure("ARGOS_RUNTIME_TREE_MISMATCH")
    path_file = runtime_root / "python313._pth"
    try:
        path_policy = path_file.read_bytes()
    except OSError as error:
        raise ArgosPocFailure(
            "ARGOS_RUNTIME_PYTHON_PATH_POLICY_INVALID"
        ) from error
    if path_policy != b"python313.zip\n.\nLib/site-packages\n":
        raise ArgosPocFailure(
            "ARGOS_RUNTIME_PYTHON_PATH_POLICY_INVALID"
        )
    expected_paths = {
        str(runtime_root),
        str(runtime_root / "python313.zip"),
        str(runtime_root / "Lib" / "site-packages"),
    }
    if {str(lexical_absolute(Path(path))) for path in sys.path} != {
        str(lexical_absolute(Path(path))) for path in expected_paths
    }:
        raise ArgosPocFailure("ARGOS_RUNTIME_SYS_PATH_INVALID")
    builder = SCRIPT_ROOT / "argos-runtime-build.py"
    status = assert_no_reparse(builder)
    if (
        not stat.S_ISREG(status.st_mode)
        or status.st_nlink != 1
        or status.st_size > 2 * 1024 * 1024
    ):
        raise ArgosPocFailure("ARGOS_RUNTIME_BUILDER_IDENTITY_INVALID")
    try:
        builder_sha256 = sha256_bytes(builder.read_bytes())
    except OSError as error:
        raise ArgosPocFailure(
            "ARGOS_RUNTIME_BUILDER_IDENTITY_INVALID"
        ) from error
    if builder_sha256 != runtime["builderScriptSha256"]:
        raise ArgosPocFailure("ARGOS_RUNTIME_BUILDER_IDENTITY_INVALID")
    return {
        "runtimeSupplySetSha256": runtime["runtimeSupplySetSha256"],
        "executionTreeSha256": tree_sha256,
        "builderScriptSha256": builder_sha256,
    }


def load_pinned_runtime() -> tuple[Any, Any]:
    if (
        sys.version_info[:3] != (3, 13, 10)
        or lexical_absolute(Path(sys.executable).parent)
        != lexical_absolute(RUNTIME_ROOT)
        or sys.flags.isolated != 1
        or sys.flags.no_user_site != 1
    ):
        raise ArgosPocFailure(
            "ARGOS_ISOLATED_CPYTHON_3_13_ENVIRONMENT_REQUIRED"
        )
    expected_versions = {
        "ctranslate2": "4.8.1",
        "sentencepiece": "0.2.1",
        "numpy": "2.2.6",
        "PyYAML": "6.0.3",
        "setuptools": "80.9.0",
    }
    try:
        observed_versions = {
            package: importlib.metadata.version(package)
            for package in expected_versions
        }
    except importlib.metadata.PackageNotFoundError as error:
        raise ArgosPocFailure("ARGOS_PINNED_RUNTIME_PACKAGE_MISSING") from error
    observed_distributions = {
        distribution.metadata["Name"]: distribution.version
        for distribution in importlib.metadata.distributions()
        if distribution.metadata["Name"]
    }
    if (
        observed_versions != expected_versions
        or observed_distributions != expected_versions
    ):
        raise ArgosPocFailure("ARGOS_PINNED_RUNTIME_VERSION_MISMATCH")
    install_process_socket_guard()
    try:
        import ctranslate2  # type: ignore[import-not-found]
        import numpy  # type: ignore[import-not-found]
        import sentencepiece  # type: ignore[import-not-found]
        import setuptools  # type: ignore[import-not-found]
        import yaml  # type: ignore[import-not-found]
    except Exception as error:
        raise ArgosPocFailure("ARGOS_PINNED_RUNTIME_IMPORT_FAILED") from error
    for module in (ctranslate2, numpy, sentencepiece, setuptools, yaml):
        module_path = lexical_absolute(Path(module.__file__))
        if not is_within(RUNTIME_ROOT, module_path):
            raise ArgosPocFailure("ARGOS_RUNTIME_MODULE_PATH_INVALID")
    return ctranslate2, sentencepiece


def capture_runtime_stdio(operation: Any) -> tuple[Any, dict[str, Any]]:
    if os.name != "nt" or msvcrt is None:
        raise ArgosPocFailure(
            "ARGOS_RUNTIME_STDIO_CAPTURE_REQUIRES_WINDOWS"
        )
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetStdHandle.argtypes = [ctypes.c_ulong]
    kernel32.GetStdHandle.restype = ctypes.c_void_p
    kernel32.SetStdHandle.argtypes = [ctypes.c_ulong, ctypes.c_void_p]
    kernel32.SetStdHandle.restype = ctypes.c_int
    stdout_code = ctypes.c_ulong(-11 & 0xFFFFFFFF)
    stderr_code = ctypes.c_ulong(-12 & 0xFFFFFFFF)
    old_stdout_handle = kernel32.GetStdHandle(stdout_code)
    old_stderr_handle = kernel32.GetStdHandle(stderr_code)
    saved_stdout = os.dup(1)
    saved_stderr = os.dup(2)
    stdout_read, stdout_write = os.pipe()
    stderr_read, stderr_write = os.pipe()
    totals = {"stdout": 0, "stderr": 0}
    overflow = threading.Event()

    def drain(descriptor: int, name: str) -> None:
        try:
            while chunk := os.read(descriptor, 64 * 1024):
                totals[name] += len(chunk)
                if totals[name] > MAX_RUNTIME_DIAGNOSTIC_BYTES:
                    overflow.set()
        finally:
            os.close(descriptor)

    stdout_thread = threading.Thread(
        target=drain,
        args=(stdout_read, "stdout"),
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=drain,
        args=(stderr_read, "stderr"),
        daemon=True,
    )
    stdout_thread.start()
    stderr_thread.start()
    failure: BaseException | None = None
    result: Any = None
    try:
        os.dup2(stdout_write, 1)
        os.dup2(stderr_write, 2)
        os.close(stdout_write)
        os.close(stderr_write)
        if (
            not kernel32.SetStdHandle(
                stdout_code,
                ctypes.c_void_p(msvcrt.get_osfhandle(1)),
            )
            or not kernel32.SetStdHandle(
                stderr_code,
                ctypes.c_void_p(msvcrt.get_osfhandle(2)),
            )
        ):
            raise ArgosPocFailure(
                "ARGOS_RUNTIME_STDIO_CAPTURE_SETUP_FAILED"
            )
        try:
            result = operation()
        except BaseException as error:
            failure = error
    finally:
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except Exception:
                pass
        try:
            ctypes.CDLL("ucrtbase").fflush(None)
        except Exception:
            pass
        kernel32.SetStdHandle(
            stdout_code,
            ctypes.c_void_p(old_stdout_handle),
        )
        kernel32.SetStdHandle(
            stderr_code,
            ctypes.c_void_p(old_stderr_handle),
        )
        os.dup2(saved_stdout, 1)
        os.dup2(saved_stderr, 2)
        os.close(saved_stdout)
        os.close(saved_stderr)
        stdout_thread.join(timeout=10)
        stderr_thread.join(timeout=10)
    if stdout_thread.is_alive() or stderr_thread.is_alive():
        raise ArgosPocFailure("ARGOS_RUNTIME_STDIO_CAPTURE_DRAIN_FAILED")
    if overflow.is_set():
        raise ArgosPocFailure("ARGOS_RUNTIME_DIAGNOSTIC_LIMIT_EXCEEDED")
    if failure is not None:
        raise failure
    return result, {
        "runtimeStdoutCaptured": True,
        "runtimeStderrCaptured": True,
        "runtimeStdoutBytes": totals["stdout"],
        "runtimeStderrBytes": totals["stderr"],
        "runtimeDiagnosticBytesPublished": 0,
        "runtimeDiagnosticRawTextPublished": False,
        "captureScope": "PROCESS_STANDARD_HANDLES_ONLY",
    }


def translate_batch_direct(
    translator: Any,
    sentencepiece_processor: Any,
    texts: Sequence[str],
) -> list[str]:
    """Reusable, text-in/text-out direct runtime boundary.

    Callers are responsible for enforcing artifact, privacy, authorization,
    model-tree, and logging policy before and after this function.
    """

    token_batches = [
        sentencepiece_processor.encode(text, out_type=str) for text in texts
    ]
    if any(
        not tokens or len(tokens) > MAX_SOURCE_TOKENS
        for tokens in token_batches
    ):
        raise ArgosPocFailure("ARGOS_SOURCE_TOKEN_COUNT_INVALID")
    try:
        results = translator.translate_batch(
            token_batches,
            beam_size=4,
            replace_unknowns=True,
            length_penalty=0.2,
        )
    except Exception as error:
        raise ArgosPocFailure("ARGOS_DIRECT_TRANSLATION_FAILED") from error
    if len(results) != len(texts):
        raise ArgosPocFailure("ARGOS_TRANSLATION_RESULT_COUNT_MISMATCH")
    outputs: list[str] = []
    for result in results:
        hypotheses = getattr(result, "hypotheses", None)
        if not hypotheses or not hypotheses[0]:
            raise ArgosPocFailure("ARGOS_TRANSLATION_EMPTY_HYPOTHESIS")
        try:
            translated = sentencepiece_processor.decode(hypotheses[0])
        except Exception as error:
            raise ArgosPocFailure("ARGOS_TRANSLATION_DECODE_FAILED") from error
        if (
            not isinstance(translated, str)
            or not translated.strip()
            or len(translated) > MAX_TRANSLATION_CHARACTERS
        ):
            raise ArgosPocFailure("ARGOS_TRANSLATION_OUTPUT_INVALID")
        assert_text_privacy_safe(translated)
        outputs.append(translated)
    return outputs


def run_direct_translation(
    model_root: Path,
    records: Sequence[dict[str, Any]],
    manifest: dict[str, Any],
    batch_size: int,
) -> list[str]:
    ctranslate2, sentencepiece = load_pinned_runtime()
    try:
        processor = sentencepiece.SentencePieceProcessor(
            model_file=str(model_root / "sentencepiece.model")
        )
        translator = ctranslate2.Translator(
            str(model_root / "model"),
            device=manifest["runtime"]["translationOptions"]["device"],
        )
    except Exception as error:
        raise ArgosPocFailure("ARGOS_DIRECT_RUNTIME_LOAD_FAILED") from error
    outputs: list[str] = []
    try:
        for start in range(0, len(records), batch_size):
            texts = [
                record["source"]
                for record in records[start : start + batch_size]
            ]
            outputs.extend(
                translate_batch_direct(
                    translator,
                    processor,
                    texts,
                )
            )
    finally:
        del translator
        del processor
        gc.collect()
    return outputs


def build_candidate_output_records(
    records: Sequence[dict[str, Any]],
    translations: Sequence[str],
    candidate_id: str,
    generation_run_id: str,
) -> list[dict[str, Any]]:
    if len(records) != len(translations):
        raise ArgosPocFailure("ARGOS_TRANSLATION_RESULT_COUNT_MISMATCH")
    return [
        {
            "schemaVersion": OUTPUT_ITEM_SCHEMA_VERSION,
            "itemId": record["itemId"],
            "direction": record["direction"],
            "candidateId": candidate_id,
            "generationRunId": generation_run_id,
            "sourceSha256": sha256_text(record["source"]),
            "translation": translation,
        }
        for record, translation in zip(records, translations, strict=True)
    ]


def build_sanitized_report(
    *,
    status: str,
    manifest_sha256: str,
    candidate_id: str,
    generation_run_id: str,
    authorization_record_id: str,
    authorization_sha256: str,
    materialized_tree_sha256: str,
    runtime_identity: dict[str, str],
    runtime_diagnostics: dict[str, Any],
    input_mode: str,
    input_count: int,
    input_sha256: str,
    output_records: Sequence[dict[str, Any]],
    candidate_output_created: bool,
) -> dict[str, Any]:
    translations = [record["translation"] for record in output_records]
    aggregate = "\n".join(sha256_text(text) for text in translations)
    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "status": status,
        "scope": POC_SCOPE,
        "manifestSha256": manifest_sha256,
        "candidateId": candidate_id,
        "generationRunId": generation_run_id,
        "authorizationRecordId": authorization_record_id,
        "authorizationSha256": authorization_sha256,
        "materializedTreeSha256": materialized_tree_sha256,
        "runtime": {
            "python": "3.13.10",
            "ctranslate2": "4.8.1",
            "sentencepiece": "0.2.1",
            "isolatedEnvironment": True,
            "runtimeIdentityVerified": True,
            "runtimeSupplySetSha256":
                runtime_identity["runtimeSupplySetSha256"],
            "executionTreeSha256":
                runtime_identity["executionTreeSha256"],
            "builderScriptSha256":
                runtime_identity["builderScriptSha256"],
            "globalSitePackagesUsed": False,
        },
        "translationOptions": {
            "beamSize": 4,
            "replaceUnknowns": True,
            "lengthPenalty": 0.2,
            "device": "cpu",
        },
        "input": {
            "mode": input_mode,
            "recordCount": input_count,
            "sha256": input_sha256,
            "rawTextEmitted": False,
        },
        "output": {
            "recordCount": len(output_records),
            "aggregateCharacterCount": sum(map(len, translations)),
            "aggregateSha256": sha256_text(aggregate),
            "candidateOutputArtifactCreated": candidate_output_created,
            "candidateOutputArtifactContainsTranslationText":
                candidate_output_created,
            "stdoutContainsTranslationText": False,
        },
        "privacy": {
            "sourceTextInReport": False,
            "translationTextInReport": False,
            "absolutePathsInReport": False,
            "usernamesInReport": False,
            "logsContainRawText": False,
            **runtime_diagnostics,
        },
        "networkIsolation": {
            "processSocketGuardInstalled": True,
            "externalNetworkAccess": "NOT_OS_LEVEL_VERIFIED",
        },
        "gateA": {
            "ready": False,
            "status": "BLOCKED_INCOMPLETE_M4_EVIDENCE",
            "productIntegrationAuthorized": False,
            "distributionAuthorized": False,
        },
    }


def write_generation_artifacts(
    output_directory: Path,
    generation_run_id: str,
    output_records: Sequence[dict[str, Any]],
    report: dict[str, Any],
    *,
    private_candidate_output_allowed: bool,
) -> None:
    if private_candidate_output_allowed is not True:
        raise ArgosPocFailure(
            "ARGOS_PRIVATE_CANDIDATE_OUTPUT_POLICY_NOT_AUTHORIZED"
        )
    expected = lexical_absolute(GENERATION_ROOT / generation_run_id)
    if lexical_absolute(output_directory) != expected:
        raise ArgosPocFailure(
            "ARGOS_OUTPUT_DIRECTORY_MUST_MATCH_GENERATION_RUN_ID"
        )
    ensure_safe_output_parent(GENERATION_ROOT)
    if output_directory.exists() or output_directory.is_symlink():
        raise ArgosPocFailure("ARGOS_GENERATION_RUN_ALREADY_EXISTS")
    stage = lexical_absolute(
        GENERATION_ROOT / f".{generation_run_id}.partial-{uuid.uuid4()}"
    )
    try:
        stage.mkdir(mode=0o700)
        output_content = "".join(
            json.dumps(
                record,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
            + "\n"
            for record in output_records
        )
        output_path = stage / "candidate-output.jsonl"
        write_new_file(output_path, output_content)
        manifest = {
            "schemaVersion":
                "phase7-argos-generation-artifact-manifest-v1",
            "scope": POC_SCOPE,
            "candidateId": report["candidateId"],
            "generationRunId": generation_run_id,
            "manifestSha256": report["manifestSha256"],
            "authorizationSha256": report["authorizationSha256"],
            "materializedTreeSha256":
                report["materializedTreeSha256"],
            "inputSha256": report["input"]["sha256"],
            "candidateOutput": {
                "logicalName": "candidate-output.jsonl",
                "sha256": sha256_text(output_content),
                "recordCount": len(output_records),
                "containsTranslationText": True,
                "containsSourceText": False,
                "purpose":
                    "PRIVATE_BLIND_EVALUATION_CANDIDATE_OUTPUT_ONLY",
            },
            "report": report,
        }
        write_new_file(
            stage / "manifest.json",
            json.dumps(
                manifest,
                ensure_ascii=False,
                indent=2,
                allow_nan=False,
            )
            + "\n",
        )
        os.rename(stage, output_directory)
    except Exception:
        cleanup_generation_stage(stage)
        raise


def cleanup_generation_stage(stage: Path) -> None:
    if not is_within(GENERATION_ROOT, stage):
        raise ArgosPocFailure(
            "ARGOS_GENERATION_STAGE_QUARANTINE_REQUIRED"
        )
    try:
        status = stage.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        raise ArgosPocFailure(
            "ARGOS_GENERATION_STAGE_QUARANTINE_REQUIRED"
        ) from error
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x0400)
    attributes = getattr(status, "st_file_attributes", 0)
    if (
        not stat.S_ISDIR(status.st_mode)
        or stat.S_ISLNK(status.st_mode)
        or attributes & reparse_flag
    ):
        raise ArgosPocFailure(
            "ARGOS_GENERATION_STAGE_QUARANTINE_REQUIRED"
        )
    try:
        shutil.rmtree(stage)
    except OSError as error:
        raise ArgosPocFailure(
            "ARGOS_GENERATION_STAGE_QUARANTINE_REQUIRED"
        ) from error


def write_new_file(path: Path, content: str) -> None:
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
    except OSError as error:
        raise ArgosPocFailure("ARGOS_GENERATION_ARTIFACT_WRITE_FAILED") from error


def run_static_self_test() -> dict[str, Any]:
    records = [
        {
            "schemaVersion": INPUT_ITEM_SCHEMA_VERSION,
            "itemId": "selftest-en-001",
            "direction": "en-zh",
            "source": "A public synthetic test sentence.",
            "contentDeclaration":
                "NO_USER_HISTORY_NO_CLIPBOARD_NO_PRIVATE_CORPUS",
            "containsPersonalData": False,
            "usageAuthorization":
                "AUTHORIZED_FOR_PHASE7_HUMAN_EVALUATION",
        }
    ]
    validate_generation_records(records)
    outputs = build_candidate_output_records(
        records,
        ["synthetic-output-placeholder"],
        "argos-opus-en-zh-1.9",
        "selftest-generation",
    )
    report = build_sanitized_report(
        status="ARGOS_BLIND_EVAL_CANDIDATE_GENERATION_COMPLETE",
        manifest_sha256="1" * 64,
        candidate_id="argos-opus-en-zh-1.9",
        generation_run_id="selftest-generation",
        authorization_record_id="selftest-authorization",
        authorization_sha256="4" * 64,
        materialized_tree_sha256="2" * 64,
        runtime_identity={
            "runtimeSupplySetSha256": "5" * 64,
            "executionTreeSha256": "6" * 64,
            "builderScriptSha256": "7" * 64,
        },
        runtime_diagnostics={
            "runtimeStdoutCaptured": True,
            "runtimeStderrCaptured": True,
            "runtimeStdoutBytes": 0,
            "runtimeStderrBytes": 0,
            "runtimeDiagnosticBytesPublished": 0,
            "runtimeDiagnosticRawTextPublished": False,
            "captureScope": "PROCESS_STANDARD_HANDLES_ONLY",
        },
        input_mode="CONTROLLED_BLIND_EVAL_BATCH",
        input_count=1,
        input_sha256="3" * 64,
        output_records=outputs,
        candidate_output_created=True,
    )
    serialized_report = canonical_json(report)
    if (
        records[0]["source"] in serialized_report
        or outputs[0]["translation"] in serialized_report
        or report["gateA"]["ready"] is not False
        or report["output"]["stdoutContainsTranslationText"] is not False
    ):
        raise ArgosPocFailure("ARGOS_STATIC_PRIVACY_SELF_TEST_FAILED")
    duplicate = [records[0], dict(records[0])]
    try:
        validate_generation_records(duplicate)
    except ArgosPocFailure as error:
        if error.code != "ARGOS_GENERATION_DUPLICATE_ITEM_ID":
            raise
    else:
        raise ArgosPocFailure("ARGOS_STATIC_DUPLICATE_SELF_TEST_FAILED")
    unsafe = [dict(records[0], itemId="selftest-en-002", source="x@y.example")]
    try:
        validate_generation_records(unsafe)
    except ArgosPocFailure as error:
        if error.code != "ARGOS_GENERATION_TEXT_PRIVACY_REJECTED":
            raise
    else:
        raise ArgosPocFailure("ARGOS_STATIC_PRIVACY_SELF_TEST_FAILED")
    if not callable(translate_batch_direct):
        raise ArgosPocFailure("ARGOS_STATIC_BATCH_BOUNDARY_SELF_TEST_FAILED")
    capture_check = "windows-process-stdio-capture-not-run"
    if os.name == "nt":
        stdout_sentinel = b"phase7-native-stdout-sentinel"
        stderr_sentinel = b"phase7-native-stderr-sentinel"

        def emit_native_sentinels() -> str:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetStdHandle.argtypes = [ctypes.c_ulong]
            kernel32.GetStdHandle.restype = ctypes.c_void_p
            kernel32.WriteFile.argtypes = [
                ctypes.c_void_p,
                ctypes.c_void_p,
                ctypes.c_ulong,
                ctypes.POINTER(ctypes.c_ulong),
                ctypes.c_void_p,
            ]
            kernel32.WriteFile.restype = ctypes.c_int
            for code, sentinel in (
                (-11, stdout_sentinel),
                (-12, stderr_sentinel),
            ):
                written = ctypes.c_ulong()
                buffer = ctypes.create_string_buffer(sentinel)
                if (
                    not kernel32.WriteFile(
                        kernel32.GetStdHandle(
                            ctypes.c_ulong(code & 0xFFFFFFFF)
                        ),
                        buffer,
                        len(sentinel),
                        ctypes.byref(written),
                        None,
                    )
                    or written.value != len(sentinel)
                ):
                    raise ArgosPocFailure(
                        "ARGOS_STATIC_STDIO_CAPTURE_SELF_TEST_FAILED"
                    )
            return "native-stdio-captured"

        capture_result, capture_diagnostics = capture_runtime_stdio(
            emit_native_sentinels
        )
        if (
            capture_result != "native-stdio-captured"
            or capture_diagnostics["runtimeStdoutBytes"]
            != len(stdout_sentinel)
            or capture_diagnostics["runtimeStderrBytes"]
            != len(stderr_sentinel)
            or capture_diagnostics["runtimeDiagnosticBytesPublished"] != 0
            or capture_diagnostics["runtimeDiagnosticRawTextPublished"]
            is not False
        ):
            raise ArgosPocFailure(
                "ARGOS_STATIC_STDIO_CAPTURE_SELF_TEST_FAILED"
            )
        capture_check = "windows-process-stdio-capture"
    try:
        parse_json_strict('{"duplicate":1,"duplicate":2}')
    except ArgosPocFailure as error:
        if error.code != "ARGOS_JSON_DUPLICATE_KEY_REJECTED":
            raise
    else:
        raise ArgosPocFailure("ARGOS_STATIC_DUPLICATE_KEY_SELF_TEST_FAILED")
    return {
        "status": "ARGOS_DIRECT_POC_STATIC_SELF_TEST_PASS",
        "checks": [
            "controlled-input-shape",
            "candidate-and-generation-run-binding",
            "duplicate-rejection",
            "privacy-pattern-rejection",
            "sanitized-report",
            "reusable-translate-batch-boundary",
            capture_check,
            "duplicate-json-key-rejection",
        ],
        "networkActivity": "NOT_PERFORMED",
        "modelArchivesDownloaded": False,
        "runtimeImported": False,
        "modelExecuted": False,
        "candidateOutputArtifactCreated": False,
    }


def execute(options: argparse.Namespace) -> dict[str, Any]:
    if not is_windows_safe_leaf_id(options.generation_run_id):
        raise ArgosPocFailure("ARGOS_GENERATION_RUN_ID_INVALID")
    if not 1 <= options.batch_size <= 32:
        raise ArgosPocFailure("ARGOS_BATCH_SIZE_INVALID")
    manifest, manifest_sha256 = load_manifest()
    candidate = select_candidate(manifest, options.candidate)
    authorization, authorization_sha256 = verify_authorization(
        lexical_absolute(Path(options.poc_authorization)),
        manifest,
        manifest_sha256,
        candidate["id"],
    )
    model_root = lexical_absolute(
        Path(options.model_root)
        if options.model_root
        else MATERIALIZED_ROOT / candidate["id"]
    )
    materialized_tree_sha256 = verify_materialized_tree(
        model_root,
        manifest_sha256,
        candidate,
        authorization["authorizationRecordId"],
        authorization_sha256,
    )
    runtime_identity = verify_runtime_tree(manifest, manifest_sha256)
    direction = (
        f"{candidate['route']['source']}-{candidate['route']['target']}"
    )
    if options.input:
        records, input_sha256 = parse_generation_input(
            lexical_absolute(Path(options.input))
        )
        if any(record["direction"] != direction for record in records):
            raise ArgosPocFailure(
                "ARGOS_GENERATION_DIRECTION_CANDIDATE_MISMATCH"
            )
        if not options.output_dir:
            raise ArgosPocFailure(
                "ARGOS_BATCH_GENERATION_OUTPUT_DIRECTORY_REQUIRED"
            )
        mode = "CONTROLLED_BLIND_EVAL_BATCH"
        status = "ARGOS_BLIND_EVAL_CANDIDATE_GENERATION_COMPLETE"
    else:
        if options.output_dir:
            raise ArgosPocFailure(
                "ARGOS_SMOKE_OUTPUT_DIRECTORY_NOT_ALLOWED"
            )
        source = (
            "The weather is good today."
            if direction == "en-zh"
            else "今天天气很好。"
        )
        records = [
            {
                "schemaVersion": INPUT_ITEM_SCHEMA_VERSION,
                "itemId": f"built-in-smoke-{direction}",
                "direction": direction,
                "source": source,
                "contentDeclaration":
                    "NO_USER_HISTORY_NO_CLIPBOARD_NO_PRIVATE_CORPUS",
                "containsPersonalData": False,
                "usageAuthorization":
                    "AUTHORIZED_FOR_PHASE7_HUMAN_EVALUATION",
            }
        ]
        input_sha256 = sha256_text(source)
        mode = "BUILT_IN_SMOKE"
        status = "ARGOS_DIRECT_SMOKE_COMPLETE"
    translations, runtime_diagnostics = capture_runtime_stdio(
        lambda: run_direct_translation(
            model_root,
            records,
            manifest,
            options.batch_size,
        )
    )
    output_records = build_candidate_output_records(
        records,
        translations,
        candidate["id"],
        options.generation_run_id,
    )
    report = build_sanitized_report(
        status=status,
        manifest_sha256=manifest_sha256,
        candidate_id=candidate["id"],
        generation_run_id=options.generation_run_id,
        authorization_record_id=authorization["authorizationRecordId"],
        authorization_sha256=authorization_sha256,
        materialized_tree_sha256=materialized_tree_sha256,
        runtime_identity=runtime_identity,
        runtime_diagnostics=runtime_diagnostics,
        input_mode=mode,
        input_count=len(records),
        input_sha256=input_sha256,
        output_records=output_records,
        candidate_output_created=bool(options.input),
    )
    if options.input:
        write_generation_artifacts(
            lexical_absolute(Path(options.output_dir)),
            options.generation_run_id,
            output_records,
            report,
            private_candidate_output_allowed=manifest["policy"][
                "privateBlindEvaluationCandidateOutputAllowed"
            ],
        )
    return report


def lexical_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def is_within(root: Path, path: Path) -> bool:
    root_absolute = lexical_absolute(root)
    path_absolute = lexical_absolute(path)
    try:
        path_absolute.relative_to(root_absolute)
        return True
    except ValueError:
        return False


def assert_no_reparse(path: Path) -> os.stat_result:
    try:
        status = path.lstat()
    except OSError as error:
        raise ArgosPocFailure("ARGOS_PATH_INSPECTION_FAILED") from error
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x0400)
    attributes = getattr(status, "st_file_attributes", 0)
    if stat.S_ISLNK(status.st_mode) or attributes & reparse_flag:
        raise ArgosPocFailure("ARGOS_REPARSE_POINT_REJECTED")
    return status


def assert_path_segments_no_reparse(root: Path, path: Path) -> None:
    root_absolute = lexical_absolute(root)
    path_absolute = lexical_absolute(path)
    if not is_within(root_absolute, path_absolute):
        raise ArgosPocFailure("ARGOS_PATH_OUTSIDE_ALLOWED_ROOT")
    current = root_absolute
    assert_no_reparse(current)
    for segment in path_absolute.relative_to(root_absolute).parts:
        current /= segment
        if not current.exists() and not current.is_symlink():
            break
        assert_no_reparse(current)


def assert_safe_existing_file(path: Path, root: Path) -> None:
    assert_path_segments_no_reparse(root, path)
    status = assert_no_reparse(path)
    if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
        raise ArgosPocFailure("ARGOS_REGULAR_SINGLE_LINK_FILE_REQUIRED")


def assert_safe_existing_directory(path: Path, root: Path) -> None:
    assert_path_segments_no_reparse(root, path)
    status = assert_no_reparse(path)
    if not stat.S_ISDIR(status.st_mode):
        raise ArgosPocFailure("ARGOS_SAFE_DIRECTORY_REQUIRED")


def ensure_safe_output_parent(root: Path) -> None:
    assert_path_segments_no_reparse(REPOSITORY_ROOT, root)
    root.mkdir(parents=True, exist_ok=True)
    assert_path_segments_no_reparse(REPOSITORY_ROOT, root)


def is_safe_relative_path(value: Any) -> bool:
    if (
        not isinstance(value, str)
        or not value
        or "\x00" in value
        or "\\" in value
        or ":" in value
        or value.startswith("/")
    ):
        return False
    return all(segment not in ("", ".", "..") for segment in value.split("/"))


def is_windows_safe_leaf_id(value: Any) -> bool:
    if (
        not isinstance(value, str)
        or not SLUG_PATTERN.fullmatch(value)
        or value.endswith(".")
    ):
        return False
    return value.split(".", 1)[0].upper() not in WINDOWS_RESERVED_LEAF_NAMES


def hash_file(path: Path, expected_size: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as file:
            while chunk := file.read(1024 * 1024):
                size += len(chunk)
                if size > expected_size:
                    raise ArgosPocFailure(
                        "ARGOS_MATERIALIZED_FILE_SIZE_EXCEEDED"
                    )
                digest.update(chunk)
    except OSError as error:
        raise ArgosPocFailure("ARGOS_MATERIALIZED_FILE_READ_FAILED") from error
    return digest.hexdigest(), size


def build_parser() -> argparse.ArgumentParser:
    parser = SanitizedArgumentParser(
        description=(
            "Phase 7 research-only direct Argos CTranslate2 POC. "
            "No package installation or network access."
        )
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run static checks without importing a model runtime.",
    )
    parser.add_argument(
        "--candidate",
        choices=("argos-opus-en-zh-1.9", "argos-opus-zh-en-1.9"),
    )
    parser.add_argument("--generation-run-id")
    parser.add_argument("--poc-authorization")
    parser.add_argument("--model-root")
    parser.add_argument(
        "--input",
        help=(
            "Controlled .json/.jsonl under "
            "artifacts/phase7/offline-poc/blind-eval-input."
        ),
    )
    parser.add_argument(
        "--output-dir",
        help=(
            "Must equal artifacts/phase7/offline-poc/argos/generations/"
            "<generation-run-id>; contains private candidate text."
        ),
    )
    parser.add_argument("--batch-size", type=int, default=8)
    return parser


def main() -> None:
    parser = build_parser()
    options = parser.parse_args()
    if options.self_test:
        forbidden = (
            options.candidate,
            options.generation_run_id,
            options.poc_authorization,
            options.model_root,
            options.input,
            options.output_dir,
        )
        if any(forbidden):
            raise ArgosPocFailure(
                "ARGOS_SELF_TEST_OPTIONS_MUTUALLY_EXCLUSIVE"
            )
        result = run_static_self_test()
    else:
        if not all(
            (
                options.candidate,
                options.generation_run_id,
                options.poc_authorization,
            )
        ):
            raise ArgosPocFailure("ARGOS_REQUIRED_RUNTIME_OPTION_MISSING")
        result = execute(options)
    sys.stdout.write(
        json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
        + "\n"
    )


if __name__ == "__main__":
    try:
        main()
    except ArgosPocFailure as error:
        sys.stderr.write(
            json.dumps(
                {
                    "status": "BLOCKED",
                    "errorCode": error.code,
                    "rawPathsEmitted": False,
                    "rawTextEmitted": False,
                },
                separators=(",", ":"),
            )
            + "\n"
        )
        raise SystemExit(1) from None
    except Exception:
        sys.stderr.write(
            json.dumps(
                {
                    "status": "BLOCKED",
                    "errorCode": "UNEXPECTED_ARGOS_DIRECT_POC_FAILURE",
                    "rawPathsEmitted": False,
                    "rawTextEmitted": False,
                },
                separators=(",", ":"),
            )
            + "\n"
        )
        raise SystemExit(1) from None
