"""Build a pinned, network-disabled Argos research runtime from local ZIPs.

The builder never invokes pip, resolves dependencies, imports model runtimes,
or writes outside the ignored Phase 7 artifact root.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import uuid
import zipfile
from typing import Any, Iterable


SCRIPT_ROOT = Path(__file__).parent
REPOSITORY_ROOT = SCRIPT_ROOT.parents[1]
ARTIFACT_ROOT = REPOSITORY_ROOT / "artifacts" / "phase7" / "offline-poc"
SUPPLY_ROOT = ARTIFACT_ROOT / "argos" / "supply"
RUNTIME_PARENT = ARTIFACT_ROOT / "argos" / "runtime" / "materialized"
RUNTIME_ROOT = RUNTIME_PARENT / "argos-cp313-win-x64-v1"
RECEIPT_NAME = ".argos-runtime-receipt.json"
RECEIPT_SCHEMA = "phase7-argos-runtime-materialization-receipt-v1"
SCOPE = "POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION"
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 20_000
MAX_ENTRY_BYTES = 256 * 1024 * 1024
MAX_TOTAL_EXTRACTED_BYTES = 768 * 1024 * 1024
MAX_COMPRESSION_RATIO = 500
MAX_RECORD_BYTES = 8 * 1024 * 1024
SHA256_PATTERN = __import__("re").compile(r"^[a-f0-9]{64}$")
WINDOWS_RESERVED_NAMES = {
    "AUX",
    "CLOCK$",
    "CON",
    "NUL",
    "PRN",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}
EXCLUDED_WHEEL_FILES = {
    "distutils-precedence.pth",
}
EXCLUDED_WHEEL_PREFIXES = (
    "_distutils_hack/tests/",
    "pkg_resources/tests/",
    "setuptools/tests/",
)


class RuntimeBuildFailure(Exception):
    """Stable public failure code without user-controlled values."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class SanitizedArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        raise RuntimeBuildFailure("ARGOS_RUNTIME_ARGUMENTS_INVALID")


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


def load_direct_module() -> Any:
    path = SCRIPT_ROOT / "argos-direct-poc.py"
    spec = importlib.util.spec_from_file_location(
        "phase7_argos_direct_poc",
        path,
    )
    if spec is None or spec.loader is None:
        raise RuntimeBuildFailure("ARGOS_RUNTIME_COMMON_MODULE_UNAVAILABLE")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def lexical_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def is_within(root: Path, path: Path) -> bool:
    try:
        lexical_absolute(path).relative_to(lexical_absolute(root))
        return True
    except ValueError:
        return False


def assert_no_reparse(path: Path) -> os.stat_result:
    try:
        status = path.lstat()
    except OSError as error:
        raise RuntimeBuildFailure(
            "ARGOS_RUNTIME_PATH_INSPECTION_FAILED"
        ) from error
    attributes = getattr(status, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x0400)
    if stat.S_ISLNK(status.st_mode) or attributes & reparse_flag:
        raise RuntimeBuildFailure("ARGOS_RUNTIME_REPARSE_POINT_REJECTED")
    return status


def assert_path_chain_safe(path: Path, root: Path) -> None:
    root = lexical_absolute(root)
    path = lexical_absolute(path)
    if not is_within(root, path):
        raise RuntimeBuildFailure("ARGOS_RUNTIME_PATH_OUTSIDE_ARTIFACT_ROOT")
    current = root
    assert_no_reparse(current)
    for segment in path.relative_to(root).parts:
        current /= segment
        if not current.exists() and not current.is_symlink():
            break
        assert_no_reparse(current)


def assert_safe_supply_file(path: Path, expected: dict[str, Any]) -> bytes:
    assert_path_chain_safe(path, ARTIFACT_ROOT)
    status = assert_no_reparse(path)
    if (
        not stat.S_ISREG(status.st_mode)
        or status.st_nlink != 1
        or status.st_size != expected["size"]
        or status.st_size > MAX_ARCHIVE_BYTES
    ):
        raise RuntimeBuildFailure("ARGOS_RUNTIME_SUPPLY_FILE_UNSAFE")
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise RuntimeBuildFailure(
            "ARGOS_RUNTIME_SUPPLY_READ_FAILED"
        ) from error
    if (
        len(raw) != expected["size"]
        or sha256_bytes(raw) != expected["sha256"]
    ):
        raise RuntimeBuildFailure("ARGOS_RUNTIME_SUPPLY_DIGEST_MISMATCH")
    return raw


def safe_zip_relative_path(value: str) -> str:
    if (
        not value
        or "\x00" in value
        or "\\" in value
        or ":" in value
        or value.startswith("/")
    ):
        raise RuntimeBuildFailure("ARGOS_RUNTIME_ZIP_PATH_REJECTED")
    normalized = value[:-1] if value.endswith("/") else value
    if not normalized:
        raise RuntimeBuildFailure("ARGOS_RUNTIME_ZIP_PATH_REJECTED")
    pure = PurePosixPath(normalized)
    parts = pure.parts
    if any(
        part in ("", ".", "..")
        or part.endswith((" ", "."))
        or part.split(".", 1)[0].upper() in WINDOWS_RESERVED_NAMES
        for part in parts
    ):
        raise RuntimeBuildFailure("ARGOS_RUNTIME_ZIP_PATH_REJECTED")
    return "/".join(parts)


def inspect_zip(
    raw: bytes,
    *,
    wheel: bool,
) -> tuple[zipfile.ZipFile, list[tuple[zipfile.ZipInfo, str]]]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw), "r")
        infos = archive.infolist()
    except (OSError, zipfile.BadZipFile) as error:
        raise RuntimeBuildFailure("ARGOS_RUNTIME_ZIP_INVALID") from error
    if not 1 <= len(infos) <= MAX_ARCHIVE_ENTRIES:
        archive.close()
        raise RuntimeBuildFailure("ARGOS_RUNTIME_ZIP_ENTRY_COUNT_INVALID")
    total = 0
    names: set[str] = set()
    folded: set[str] = set()
    inspected: list[tuple[zipfile.ZipInfo, str]] = []
    for info in infos:
        relative = safe_zip_relative_path(info.filename)
        folded_name = relative.casefold()
        if relative in names or folded_name in folded:
            archive.close()
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_ZIP_PATH_COLLISION"
            )
        names.add(relative)
        folded.add(folded_name)
        unix_type = (info.external_attr >> 16) & 0xF000
        if unix_type not in (0, stat.S_IFREG, stat.S_IFDIR):
            archive.close()
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_ZIP_SPECIAL_FILE_REJECTED"
            )
        if info.flag_bits & 0x1 or info.compress_type not in (
            zipfile.ZIP_STORED,
            zipfile.ZIP_DEFLATED,
        ):
            archive.close()
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_ZIP_FLAGS_OR_METHOD_REJECTED"
            )
        if info.file_size > MAX_ENTRY_BYTES:
            archive.close()
            raise RuntimeBuildFailure("ARGOS_RUNTIME_ZIP_ENTRY_TOO_LARGE")
        total += info.file_size
        if total > MAX_TOTAL_EXTRACTED_BYTES:
            archive.close()
            raise RuntimeBuildFailure("ARGOS_RUNTIME_ZIP_TOTAL_TOO_LARGE")
        if (
            info.file_size > 0
            and info.compress_size == 0
            or info.compress_size > 0
            and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO
        ):
            archive.close()
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_ZIP_COMPRESSION_RATIO_REJECTED"
            )
        if wheel and info.is_dir():
            continue
        inspected.append((info, relative))
    if wheel:
        verify_wheel_record(archive, inspected)
    return archive, inspected


def verify_wheel_record(
    archive: zipfile.ZipFile,
    entries: list[tuple[zipfile.ZipInfo, str]],
) -> None:
    record_entries = [
        (info, path)
        for info, path in entries
        if path.endswith(".dist-info/RECORD") and path.count("/") == 1
    ]
    if len(record_entries) != 1:
        raise RuntimeBuildFailure("ARGOS_RUNTIME_WHEEL_RECORD_MISSING")
    record_info, record_path = record_entries[0]
    if record_info.file_size > MAX_RECORD_BYTES:
        raise RuntimeBuildFailure("ARGOS_RUNTIME_WHEEL_RECORD_TOO_LARGE")
    try:
        record_text = archive.read(record_info).decode("utf-8")
        rows = list(csv.reader(io.StringIO(record_text, newline="")))
    except (KeyError, OSError, UnicodeDecodeError, csv.Error) as error:
        raise RuntimeBuildFailure(
            "ARGOS_RUNTIME_WHEEL_RECORD_INVALID"
        ) from error
    records: dict[str, tuple[str, str]] = {}
    for row in rows:
        if len(row) != 3:
            raise RuntimeBuildFailure("ARGOS_RUNTIME_WHEEL_RECORD_INVALID")
        path = safe_zip_relative_path(row[0])
        if path in records:
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_WHEEL_RECORD_DUPLICATE"
            )
        records[path] = (row[1], row[2])
    entry_paths = {path for _info, path in entries}
    if set(records) != entry_paths:
        raise RuntimeBuildFailure(
            "ARGOS_RUNTIME_WHEEL_RECORD_SET_MISMATCH"
        )
    for info, path in entries:
        digest_record, size_record = records[path]
        if path == record_path:
            if digest_record or size_record:
                raise RuntimeBuildFailure(
                    "ARGOS_RUNTIME_WHEEL_RECORD_SELF_PIN_INVALID"
                )
            continue
        try:
            data = archive.read(info)
        except (KeyError, OSError, zipfile.BadZipFile) as error:
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_WHEEL_ENTRY_READ_FAILED"
            ) from error
        expected_digest = (
            base64.urlsafe_b64encode(hashlib.sha256(data).digest())
            .decode("ascii")
            .rstrip("=")
        )
        if (
            digest_record != f"sha256={expected_digest}"
            or size_record != str(len(data))
            or len(data) != info.file_size
        ):
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_WHEEL_RECORD_DIGEST_MISMATCH"
            )


def write_zip_entries(
    archive: zipfile.ZipFile,
    entries: Iterable[tuple[zipfile.ZipInfo, str]],
    destination: Path,
    *,
    tree_root: Path,
    global_paths: set[str],
    exclude: set[str] | None = None,
) -> list[str]:
    excluded: list[str] = []
    for info, relative in entries:
        if info.is_dir():
            continue
        if exclude and (
            relative in exclude
            or relative.startswith(EXCLUDED_WHEEL_PREFIXES)
        ):
            excluded.append(relative)
            continue
        target = destination.joinpath(*relative.split("/"))
        global_relation = target.relative_to(tree_root).as_posix().casefold()
        if global_relation in global_paths:
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_MATERIALIZATION_PATH_COLLISION"
            )
        global_paths.add(global_relation)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with archive.open(info, "r") as source:
                descriptor = os.open(
                    target,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                with os.fdopen(descriptor, "wb") as output:
                    digest = hashlib.sha256()
                    size = 0
                    while chunk := source.read(1024 * 1024):
                        size += len(chunk)
                        if size > info.file_size:
                            raise RuntimeBuildFailure(
                                "ARGOS_RUNTIME_ZIP_ENTRY_SIZE_MISMATCH"
                            )
                        digest.update(chunk)
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
        except RuntimeBuildFailure:
            raise
        except (OSError, zipfile.BadZipFile) as error:
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_ZIP_EXTRACTION_FAILED"
            ) from error
        if size != info.file_size:
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_ZIP_ENTRY_SIZE_MISMATCH"
            )
        _ = digest
    return excluded


def runtime_supply(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    runtime = manifest["runtime"]
    entries = [runtime["python"]["distribution"]]
    entries.extend(
        (
            runtime["ctranslate2"]["wheel"],
            runtime["sentencepiece"]["wheel"],
        )
    )
    entries.extend(
        dependency["wheel"]
        for dependency in runtime["dependencyWheels"]
    )
    if len(entries) != 6:
        raise RuntimeBuildFailure("ARGOS_RUNTIME_SUPPLY_LOCK_INVALID")
    paths = [entry["localPath"] for entry in entries]
    if len(set(paths)) != len(paths):
        raise RuntimeBuildFailure("ARGOS_RUNTIME_SUPPLY_PATH_DUPLICATE")
    return entries


def supply_set_sha256(entries: list[dict[str, Any]]) -> str:
    pins = [
        {
            "filename": entry["filename"],
            "localPath": entry["localPath"],
            "size": entry["size"],
            "sha256": entry["sha256"],
        }
        for entry in entries
    ]
    pins.sort(key=lambda item: item["localPath"])
    return hashlib.sha256(canonical_json(pins).encode("utf-8")).hexdigest()


def enumerate_runtime_tree(root: Path) -> tuple[list[dict[str, Any]], str]:
    records: list[dict[str, Any]] = []
    folded_paths: set[str] = set()
    for directory, directories, files in os.walk(
        root,
        topdown=True,
        followlinks=False,
    ):
        directory_path = Path(directory)
        assert_no_reparse(directory_path)
        directories.sort()
        files.sort()
        for name in directories:
            assert_no_reparse(directory_path / name)
        for name in files:
            path = directory_path / name
            if path.name == RECEIPT_NAME:
                continue
            status = assert_no_reparse(path)
            if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
                raise RuntimeBuildFailure(
                    "ARGOS_RUNTIME_TREE_FILE_UNSAFE"
                )
            relative = path.relative_to(root).as_posix()
            safe_zip_relative_path(relative)
            folded = relative.casefold()
            if folded in folded_paths:
                raise RuntimeBuildFailure(
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
                raise RuntimeBuildFailure(
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
    tree_sha256 = hashlib.sha256(
        canonical_json(records).encode("utf-8")
    ).hexdigest()
    return records, tree_sha256


def rewrite_python_path_file(stage: Path) -> None:
    path_file = stage / "python313._pth"
    assert_no_reparse(path_file)
    try:
        original = path_file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise RuntimeBuildFailure(
            "ARGOS_RUNTIME_PYTHON_PATH_FILE_INVALID"
        ) from error
    if "python313.zip" not in original or "import site" in [
        line.strip()
        for line in original.splitlines()
        if not line.lstrip().startswith("#")
    ]:
        raise RuntimeBuildFailure(
            "ARGOS_RUNTIME_PYTHON_PATH_FILE_UNEXPECTED"
        )
    replacement = "python313.zip\n.\nLib/site-packages\n"
    try:
        path_file.write_text(
            replacement,
            encoding="utf-8",
            newline="\n",
        )
    except OSError as error:
        raise RuntimeBuildFailure(
            "ARGOS_RUNTIME_PYTHON_PATH_FILE_WRITE_FAILED"
        ) from error


def build_runtime(
    manifest: dict[str, Any],
    manifest_sha256: str,
    authorization: dict[str, Any],
    authorization_sha256: str,
) -> dict[str, Any]:
    if manifest["runtime"].get("executionTreeStatus") not in (
        "PENDING_PIN_AFTER_CONTROLLED_MATERIALIZATION",
        "PINNED_CONTROLLED_MATERIALIZATION_V1",
    ):
        raise RuntimeBuildFailure("ARGOS_RUNTIME_TREE_STATUS_INVALID")
    assert_path_chain_safe(RUNTIME_PARENT, ARTIFACT_ROOT)
    RUNTIME_PARENT.mkdir(parents=True, exist_ok=True)
    assert_path_chain_safe(RUNTIME_PARENT, ARTIFACT_ROOT)
    if RUNTIME_ROOT.exists() or RUNTIME_ROOT.is_symlink():
        raise RuntimeBuildFailure("ARGOS_RUNTIME_TARGET_ALREADY_EXISTS")
    stage = RUNTIME_PARENT / f".runtime.partial-{uuid.uuid4()}"
    stage.mkdir()
    renamed = False
    try:
        entries = runtime_supply(manifest)
        raw_supply: dict[str, bytes] = {}
        for entry in entries:
            path = SUPPLY_ROOT.joinpath(*entry["localPath"].split("/"))
            raw_supply[entry["localPath"]] = assert_safe_supply_file(
                path,
                entry,
            )
        global_paths: set[str] = set()
        python_entry = manifest["runtime"]["python"]["distribution"]
        python_archive, python_infos = inspect_zip(
            raw_supply[python_entry["localPath"]],
            wheel=False,
        )
        try:
            write_zip_entries(
                python_archive,
                python_infos,
                stage,
                tree_root=stage,
                global_paths=global_paths,
            )
        finally:
            python_archive.close()
        site_packages = stage / "Lib" / "site-packages"
        site_packages.mkdir(parents=True)
        excluded: list[str] = []
        wheel_entries = entries[1:]
        for entry in wheel_entries:
            archive, infos = inspect_zip(
                raw_supply[entry["localPath"]],
                wheel=True,
            )
            try:
                skipped = write_zip_entries(
                    archive,
                    infos,
                    site_packages,
                    tree_root=stage,
                    global_paths=global_paths,
                    exclude=EXCLUDED_WHEEL_FILES,
                )
                excluded.extend(skipped)
            finally:
                archive.close()
        if (
            not EXCLUDED_WHEEL_FILES.issubset(excluded)
            or any(
                path not in EXCLUDED_WHEEL_FILES
                and not path.startswith(EXCLUDED_WHEEL_PREFIXES)
                for path in excluded
            )
        ):
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_EXPECTED_WHEEL_EXCLUSION_MISSING"
            )
        rewrite_python_path_file(stage)
        records, tree_sha256 = enumerate_runtime_tree(stage)
        runtime = manifest["runtime"]
        if runtime["executionTreeStatus"] == (
            "PINNED_CONTROLLED_MATERIALIZATION_V1"
        ):
            if (
                runtime.get("executionTreeSha256") != tree_sha256
                or runtime.get("executionTreeFileCount") != len(records)
                or runtime.get("executionTreeBytes")
                != sum(record["size"] for record in records)
            ):
                raise RuntimeBuildFailure(
                    "ARGOS_RUNTIME_TREE_MANIFEST_PIN_MISMATCH"
                )
        receipt = {
            "schemaVersion": RECEIPT_SCHEMA,
            "scope": SCOPE,
            "manifestSha256": manifest_sha256,
            "authorizationRecordId":
                authorization["authorizationRecordId"],
            "authorizationSha256": authorization_sha256,
            "candidateIds": authorization["candidateIds"],
            "runtimeSupplySetSha256": supply_set_sha256(entries),
            "executionTreeSha256": tree_sha256,
            "fileCount": len(records),
            "totalBytes": sum(record["size"] for record in records),
            "excludedWheelFiles": sorted(excluded),
            "files": records,
            "networkAccess": "NOT_PERFORMED",
            "runtimeImported": False,
            "modelExecuted": False,
            "productIntegrationAuthorized": False,
        }
        receipt_path = stage / RECEIPT_NAME
        receipt_path.write_text(
            json.dumps(
                receipt,
                ensure_ascii=False,
                indent=2,
                allow_nan=False,
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
        os.rename(stage, RUNTIME_ROOT)
        renamed = True
        return {
            "status": "ARGOS_CONTROLLED_RUNTIME_MATERIALIZED",
            "scope": SCOPE,
            "manifestSha256": manifest_sha256,
            "authorizationRecordId":
                authorization["authorizationRecordId"],
            "authorizationSha256": authorization_sha256,
            "runtimeSupplySetSha256": receipt[
                "runtimeSupplySetSha256"
            ],
            "executionTreeSha256": tree_sha256,
            "fileCount": receipt["fileCount"],
            "totalBytes": receipt["totalBytes"],
            "excludedWheelFileCount": len(excluded),
            "networkAccess": "NOT_PERFORMED",
            "runtimeImported": False,
            "modelExecuted": False,
            "rawPathsEmitted": False,
            "rawTextEmitted": False,
            "gateAStatus": "BLOCKED",
        }
    except Exception:
        if not renamed:
            cleanup_stage(stage)
        raise


def cleanup_stage(stage: Path) -> None:
    if not is_within(RUNTIME_PARENT, stage):
        raise RuntimeBuildFailure(
            "ARGOS_RUNTIME_STAGE_QUARANTINE_REQUIRED"
        )
    try:
        status = stage.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        raise RuntimeBuildFailure(
            "ARGOS_RUNTIME_STAGE_QUARANTINE_REQUIRED"
        ) from error
    if not stat.S_ISDIR(status.st_mode) or stat.S_ISLNK(status.st_mode):
        raise RuntimeBuildFailure(
            "ARGOS_RUNTIME_STAGE_QUARANTINE_REQUIRED"
        )
    try:
        shutil.rmtree(stage)
    except OSError as error:
        raise RuntimeBuildFailure(
            "ARGOS_RUNTIME_STAGE_QUARANTINE_REQUIRED"
        ) from error


def static_self_test() -> dict[str, Any]:
    safe = safe_zip_relative_path("package/module.py")
    if safe != "package/module.py":
        raise RuntimeBuildFailure("ARGOS_RUNTIME_STATIC_SELF_TEST_FAILED")
    for rejected in (
        "../escape",
        "C:/escape",
        "folder\\escape",
        "NUL.txt",
        "folder/trailing.",
    ):
        try:
            safe_zip_relative_path(rejected)
        except RuntimeBuildFailure:
            continue
        raise RuntimeBuildFailure("ARGOS_RUNTIME_STATIC_SELF_TEST_FAILED")
    return {
        "status": "ARGOS_RUNTIME_BUILDER_STATIC_SELF_TEST_PASS",
        "checks": [
            "artifact-root-boundary",
            "pinned-supply-digest",
            "zip-path-and-link-policy",
            "wheel-record-digest-policy",
            "case-insensitive-collision-policy",
            "atomic-new-target-materialization",
            "runtime-tree-receipt",
        ],
        "networkAccess": "NOT_PERFORMED",
        "runtimeImported": False,
        "modelExecuted": False,
    }


def parser() -> argparse.ArgumentParser:
    value = SanitizedArgumentParser(
        description=(
            "Build the pinned Phase 7 Argos research runtime without pip "
            "or network access."
        )
    )
    value.add_argument("--build", action="store_true")
    value.add_argument("--self-test", action="store_true")
    value.add_argument("--poc-authorization")
    return value


def main() -> None:
    options = parser().parse_args()
    if options.self_test:
        if options.build or options.poc_authorization:
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_ACTIONS_MUTUALLY_EXCLUSIVE"
            )
        result = static_self_test()
    elif options.build:
        if not options.poc_authorization:
            raise RuntimeBuildFailure(
                "ARGOS_RUNTIME_AUTHORIZATION_REQUIRED"
            )
        common = load_direct_module()
        manifest, manifest_sha256 = common.load_manifest()
        authorization, authorization_sha256 = common.verify_authorization(
            lexical_absolute(Path(options.poc_authorization)),
            manifest,
            manifest_sha256,
            sorted(
                candidate["id"]
                for candidate in manifest["candidates"]
            ),
        )
        result = build_runtime(
            manifest,
            manifest_sha256,
            authorization,
            authorization_sha256,
        )
    else:
        raise RuntimeBuildFailure("ARGOS_RUNTIME_ACTION_REQUIRED")
    sys.stdout.write(
        json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
        + "\n"
    )


if __name__ == "__main__":
    try:
        main()
    except (RuntimeBuildFailure, Exception) as error:
        code = (
            error.code
            if isinstance(error, RuntimeBuildFailure)
            else "UNEXPECTED_ARGOS_RUNTIME_BUILD_FAILURE"
        )
        sys.stderr.write(
            json.dumps(
                {
                    "status": "BLOCKED",
                    "errorCode": code,
                    "rawPathsEmitted": False,
                    "rawTextEmitted": False,
                },
                separators=(",", ":"),
            )
            + "\n"
        )
        raise SystemExit(1) from None
