from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import socket
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any


SCRIPT_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_ROOT.parents[1]
DEFAULT_MANIFEST = SCRIPT_ROOT / "candidates.json"
ARTIFACT_ROOT = REPOSITORY_ROOT / "artifacts" / "phase7" / "offline-poc"
MANIFEST_SCHEMA_VERSION = "phase7-offline-poc-candidates-v1"
POC_AUTHORIZATION_SCHEMA_VERSION = "phase7-offline-poc-authorization-v1"
POC_RESEARCH_SCOPE = "POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION"


class PocError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def manifest_sha256(manifest: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(manifest).encode("utf-8")).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise PocError("JSON_OBJECT_REQUIRED")
    return value


def unique_sorted(values: list[str]) -> list[str]:
    return sorted(set(values))


def selected_research_risk_codes(
    manifest: dict[str, Any], candidate_id: str
) -> list[str]:
    candidate_set_ids = {
        item["id"]
        for item in manifest["candidateSets"]
        if candidate_id in item["candidateIds"]
    }
    subjects = {candidate_id, "ctranslate2-transformers-toolchain", *candidate_set_ids}
    return unique_sorted(
        [
            blocker["code"]
            for blocker in manifest["gateA"]["blockers"]
            if any(subject in subjects for subject in blocker["appliesTo"])
        ]
    )


def verify_poc_authorization(
    authorization: dict[str, Any],
    manifest: dict[str, Any],
    candidate: dict[str, Any],
) -> dict[str, str]:
    expected_risks = selected_research_risk_codes(manifest, candidate["id"])
    expected_observed_licenses = [
        candidate["license"]["observedMetadataExpression"]
    ]
    valid = (
        authorization.get("schemaVersion") == POC_AUTHORIZATION_SCHEMA_VERSION
        and authorization.get("authorization")
        == "AUTHORIZED_FOR_POC_RESEARCH_ONLY"
        and authorization.get("scope") == POC_RESEARCH_SCOPE
        and authorization.get("basis") == "PHASE7_M0_USER_AUTHORIZATION"
        and authorization.get("manifestSha256") == manifest_sha256(manifest)
        and unique_sorted(authorization.get("candidateIds", []))
        == [candidate["id"]]
        and unique_sorted(
            authorization.get("observedLicenseMetadataExpressions", [])
        )
        == unique_sorted(expected_observed_licenses)
        and unique_sorted(authorization.get("acknowledgedRiskCodes", []))
        == expected_risks
        and isinstance(authorization.get("authorizationRecordId"), str)
        and authorization["authorizationRecordId"] not in ("", "UNASSIGNED")
        and isinstance(authorization.get("authorizedAt"), str)
    )
    if not valid:
        raise PocError("POC_AUTHORIZATION_INVALID_OR_STALE")
    return {
        "authorizationRecordId": authorization["authorizationRecordId"],
        "authorizedAt": authorization["authorizedAt"],
    }


def assert_artifact_child(path: Path) -> Path:
    root = ARTIFACT_ROOT.resolve(strict=False)
    target = path.resolve(strict=False)
    try:
        relation = target.relative_to(root)
    except ValueError as error:
        raise PocError("PATH_MUST_BE_INSIDE_PHASE7_ARTIFACT_ROOT") from error
    if not relation.parts:
        raise PocError("ARTIFACT_ROOT_ITSELF_IS_NOT_A_VALID_TARGET")
    current = root
    for segment in relation.parts:
        current = current / segment
        if not current.exists():
            break
        is_junction = bool(getattr(os.path, "isjunction", lambda _: False)(current))
        if current.is_symlink() or is_junction:
            raise PocError("ARTIFACT_REPARSE_POINT_REJECTED")
    return target


def create_expected_hash(file_pin: dict[str, Any]) -> Any:
    if file_pin["digestAlgorithm"] == "sha256":
        return hashlib.sha256()
    if file_pin["digestAlgorithm"] == "git-blob-sha1":
        digest = hashlib.sha1()
        digest.update(f"blob {file_pin['size']}\0".encode("utf-8"))
        return digest
    raise PocError("UNSUPPORTED_DIGEST_ALGORITHM")


def verify_source_files(source_dir: Path, candidate: dict[str, Any]) -> dict[str, Any]:
    total_bytes = 0
    for file_pin in candidate["sourceFiles"]:
        path = source_dir.joinpath(*file_pin["path"].split("/"))
        if not path.is_file() or path.is_symlink():
            raise PocError("PINNED_SOURCE_FILE_MISSING")
        if path.stat().st_size != file_pin["size"]:
            raise PocError("PINNED_SOURCE_FILE_SIZE_MISMATCH")
        digest = create_expected_hash(file_pin)
        observed_size = 0
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                observed_size += len(chunk)
                digest.update(chunk)
        if observed_size != file_pin["size"] or digest.hexdigest() != file_pin["digest"]:
            raise PocError("PINNED_SOURCE_FILE_DIGEST_MISMATCH")
        total_bytes += observed_size
    return {
        "fileCount": len(candidate["sourceFiles"]),
        "sourceBytes": total_bytes,
        "allPinsMatched": True,
    }


def tree_identity(root: Path) -> dict[str, Any]:
    files = sorted(
        (path for path in root.rglob("*") if path.is_file()),
        key=lambda path: path.relative_to(root).as_posix(),
    )
    digest = hashlib.sha256()
    total_bytes = 0
    for path in files:
        relative_path = path.relative_to(root).as_posix()
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                total_bytes += len(chunk)
                digest.update(chunk)
        digest.update(b"\0")
    return {
        "algorithm": "sha256-tree-v1",
        "sha256": digest.hexdigest(),
        "fileCount": len(files),
        "bytes": total_bytes,
    }


def installed_versions(manifest: dict[str, Any]) -> dict[str, str]:
    expected = {
        manifest["runtime"]["id"]: manifest["runtime"]["version"],
        **{item["id"]: item["version"] for item in manifest["toolchain"]},
    }
    observed: dict[str, str] = {}
    for distribution, expected_version in expected.items():
        try:
            version = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError as error:
            raise PocError("FROZEN_TOOLCHAIN_PACKAGE_MISSING") from error
        if version != expected_version:
            raise PocError("FROZEN_TOOLCHAIN_VERSION_MISMATCH")
        observed[distribution] = version
    return observed


def enable_offline_environment() -> None:
    offline_values = {
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_DATASETS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "DO_NOT_TRACK": "1",
        "HTTP_PROXY": "http://127.0.0.1:9",
        "HTTPS_PROXY": "http://127.0.0.1:9",
        "ALL_PROXY": "http://127.0.0.1:9",
        "NO_PROXY": "",
    }
    os.environ.update(offline_values)


def install_python_socket_guard() -> dict[str, int]:
    state = {"attemptedCalls": 0}

    def blocked(*_args: Any, **_kwargs: Any) -> Any:
        state["attemptedCalls"] += 1
        raise PocError("NETWORK_ACCESS_BLOCKED_DURING_CONVERSION")

    socket.create_connection = blocked  # type: ignore[assignment]
    socket.getaddrinfo = blocked  # type: ignore[assignment]
    socket.socket.connect = blocked  # type: ignore[method-assign]
    socket.socket.connect_ex = blocked  # type: ignore[method-assign]
    return state


def convert_candidate(args: argparse.Namespace) -> dict[str, Any]:
    manifest = load_json(Path(args.manifest))
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        raise PocError("MANIFEST_SCHEMA_VERSION_INVALID")
    candidate = next(
        (item for item in manifest["candidates"] if item["id"] == args.candidate),
        None,
    )
    if candidate is None:
        raise PocError("UNKNOWN_CANDIDATE")
    authorization = load_json(Path(args.poc_authorization))
    authorization_summary = verify_poc_authorization(
        authorization, manifest, candidate
    )

    source_dir = assert_artifact_child(Path(args.source_dir))
    output_dir = assert_artifact_child(Path(args.output_dir))
    if output_dir.exists():
        raise PocError("CONVERTED_OUTPUT_ALREADY_EXISTS")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    source_verification = verify_source_files(source_dir, candidate)
    package_versions = installed_versions(manifest)

    enable_offline_environment()
    socket_state = install_python_socket_guard()
    from ctranslate2.converters import (  # pylint: disable=import-outside-toplevel
        TransformersConverter,
    )

    staging = output_dir.parent / f".{output_dir.name}.staging-{uuid.uuid4().hex}"
    assert_artifact_child(staging)
    start = time.perf_counter()
    converter = TransformersConverter(
        str(source_dir),
        copy_files=candidate["conversion"]["copyFiles"],
        trust_remote_code=False,
    )
    converter.convert(
        str(staging),
        quantization=manifest["policy"]["conversionQuantization"],
        force=False,
    )
    conversion_ms = round((time.perf_counter() - start) * 1000, 3)
    provenance = {
        "schemaVersion": "phase7-offline-poc-conversion-provenance-v1",
        "scope": POC_RESEARCH_SCOPE,
        "manifestSha256": manifest_sha256(manifest),
        "candidateId": candidate["id"],
        "repository": candidate["repository"],
        "revision": candidate["revision"],
        "sourcePinsVerified": True,
        "runtimeVersion": manifest["runtime"]["version"],
        "quantization": manifest["policy"]["conversionQuantization"],
        "trustRemoteCode": False,
        "networkMode": "PROCESS_LEVEL_OFFLINE_GUARD",
        "gateAStatus": "BLOCKED_PENDING_POC_EVIDENCE",
    }
    with (staging / "phase7-poc-conversion.json").open("x", encoding="utf-8") as stream:
        json.dump(provenance, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")
    converted = tree_identity(staging)
    staging.rename(output_dir)
    return {
        "schemaVersion": "phase7-offline-poc-conversion-result-v1",
        "status": "CONVERTED_FOR_POC_NOT_PRODUCT_ACCEPTANCE",
        "scope": POC_RESEARCH_SCOPE,
        "convertedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "manifestSha256": manifest_sha256(manifest),
        "pocAuthorizationRecordId": authorization_summary[
            "authorizationRecordId"
        ],
        "gateAStatus": "BLOCKED_PENDING_POC_EVIDENCE",
        "candidate": {
            "id": candidate["id"],
            "repository": candidate["repository"],
            "revision": candidate["revision"],
            "licenseExpression": candidate["license"]["expression"],
            "observedLicenseMetadataExpression": candidate["license"][
                "observedMetadataExpression"
            ],
            "commercialUseConclusion": candidate["license"][
                "commercialUseConclusion"
            ],
        },
        "source": source_verification,
        "toolchain": package_versions,
        "conversion": {
            "quantization": manifest["policy"]["conversionQuantization"],
            "trustRemoteCode": False,
            "durationMs": conversion_ms,
            "output": converted,
        },
        "networkIsolation": {
            "mode": "PROCESS_LEVEL_OFFLINE_GUARD",
            "pythonSocketGuard": True,
            "attemptedCalls": socket_state["attemptedCalls"],
            "externalNetworkAccess": "NOT_VERIFIED",
            "osFirewallVerified": False,
        },
    }


def run_self_test() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="phase7-offline-poc-convert-") as raw:
        root = Path(raw)
        (root / "a.txt").write_bytes(b"alpha")
        (root / "nested").mkdir()
        (root / "nested" / "b.bin").write_bytes(b"\x00\x01\x02")
        first = tree_identity(root)
        second = tree_identity(root)
        if first != second or first["fileCount"] != 2 or first["bytes"] != 8:
            raise PocError("TREE_HASH_SELF_TEST_FAILED")
        pin = {
            "size": 5,
            "digestAlgorithm": "git-blob-sha1",
        }
        digest = create_expected_hash(pin)
        digest.update(b"alpha")
        if digest.hexdigest() != hashlib.sha1(b"blob 5\0alpha").hexdigest():
            raise PocError("GIT_BLOB_HASH_SELF_TEST_FAILED")
    return {
        "schemaVersion": "phase7-offline-poc-conversion-selftest-v1",
        "status": "NO_MODEL_STATIC_SELF_TEST_PASS",
        "checks": [
            "canonical-manifest-sha256",
            "sha256-tree-v1",
            "git-blob-sha1",
        ],
        "networkActivityVerification": "NOT_PERFORMED_STATIC_SELFTEST",
        "modelWeightsDownloaded": False,
        "modelExecution": "NOT_RUN",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert one locally pinned model snapshot without network access."
    )
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--candidate")
    parser.add_argument("--source-dir")
    parser.add_argument("--output-dir")
    parser.add_argument("--poc-authorization")
    args = parser.parse_args()
    if not args.self_test:
        required = {
            "--candidate": args.candidate,
            "--source-dir": args.source_dir,
            "--output-dir": args.output_dir,
            "--poc-authorization": args.poc_authorization,
        }
        missing = [name for name, value in required.items() if not value]
        if missing:
            parser.error("required arguments missing for conversion")
    return args


def main() -> int:
    args = parse_args()
    try:
        report = run_self_test() if args.self_test else convert_candidate(args)
        sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        return 0
    except PocError as error:
        sys.stderr.write(
            json.dumps(
                {
                    "status": "BLOCKED",
                    "errorCode": error.code,
                    "rawPathsEmitted": False,
                }
            )
            + "\n"
        )
        return 1
    except Exception:
        sys.stderr.write(
            json.dumps(
                {
                    "status": "BLOCKED",
                    "errorCode": "UNEXPECTED_CONVERSION_FAILURE",
                    "rawPathsEmitted": False,
                }
            )
            + "\n"
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
