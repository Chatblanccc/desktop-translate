from __future__ import annotations

import argparse
import collections
import ctypes
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import re
import socket
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


SCRIPT_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_ROOT.parents[1]
DEFAULT_MANIFEST = SCRIPT_ROOT / "candidates.json"
DEFAULT_FIXTURE = SCRIPT_ROOT / "fixtures" / "quality-samples.jsonl"
ARTIFACT_ROOT = REPOSITORY_ROOT / "artifacts" / "phase7" / "offline-poc"
MANIFEST_SCHEMA_VERSION = "phase7-offline-poc-candidates-v1"
POC_AUTHORIZATION_SCHEMA_VERSION = "phase7-offline-poc-authorization-v1"
MEASUREMENT_SCHEMA_VERSION = "phase7-offline-poc-measurement-v1"
POC_RESEARCH_SCOPE = "POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION"

URL_PATTERN = re.compile(r"https?://[^\s]+", re.IGNORECASE)
DIGIT_PATTERN = re.compile(r"\d+(?:[./,:-]\d+)*")
PLACEHOLDER_PATTERN = re.compile(
    r"\{\{[^{}\r\n]+\}\}|\$\{[^{}\r\n]+\}|%\w|\{[A-Za-z_][^{}\r\n]*\}"
)


class PocError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class ProcessMemoryCountersEx(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


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
) -> None:
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
        == [candidate["license"]["observedMetadataExpression"]]
        and unique_sorted(authorization.get("acknowledgedRiskCodes", []))
        == selected_research_risk_codes(manifest, candidate["id"])
        and isinstance(authorization.get("authorizationRecordId"), str)
        and authorization["authorizationRecordId"] not in ("", "UNASSIGNED")
        and isinstance(authorization.get("authorizedAt"), str)
    )
    if not valid:
        raise PocError("POC_AUTHORIZATION_INVALID_OR_STALE")


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


def tree_identity(root: Path) -> dict[str, Any]:
    files = sorted(
        (path for path in root.rglob("*") if path.is_file()),
        key=lambda path: path.relative_to(root).as_posix(),
    )
    digest = hashlib.sha256()
    total_bytes = 0
    for path in files:
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                total_bytes += len(chunk)
                digest.update(chunk)
        digest.update(b"\0")
    return {
        "sha256": digest.hexdigest(),
        "bytes": total_bytes,
        "fileCount": len(files),
    }


def load_fixture(path: Path) -> tuple[list[dict[str, Any]], bytes]:
    raw = path.read_bytes()
    samples: list[dict[str, Any]] = []
    ids: set[str] = set()
    for line_number, raw_line in enumerate(raw.decode("utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        try:
            item = json.loads(raw_line)
        except json.JSONDecodeError as error:
            raise PocError("FIXTURE_JSONL_INVALID") from error
        required = ("id", "direction", "source", "reference", "tags")
        if (
            not isinstance(item, dict)
            or any(key not in item for key in required)
            or item["direction"] not in ("en-zh", "zh-en")
            or not isinstance(item["source"], str)
            or not item["source"]
            or not isinstance(item["reference"], str)
            or not item["reference"]
            or not isinstance(item["tags"], list)
            or item["id"] in ids
        ):
            raise PocError(f"FIXTURE_RECORD_INVALID_LINE_{line_number}")
        ids.add(item["id"])
        samples.append(item)
    if not samples:
        raise PocError("FIXTURE_EMPTY")
    return samples, raw


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


def enable_offline_environment(environment: dict[str, str]) -> dict[str, str]:
    result = dict(environment)
    result.update(
        {
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "DO_NOT_TRACK": "1",
            "HTTP_PROXY": "http://127.0.0.1:9",
            "HTTPS_PROXY": "http://127.0.0.1:9",
            "ALL_PROXY": "http://127.0.0.1:9",
            "NO_PROXY": "",
            "PYTHONDONTWRITEBYTECODE": "1",
            "TOKENIZERS_PARALLELISM": "false",
        }
    )
    return result


def install_python_socket_guard() -> dict[str, int]:
    state = {"attemptedCalls": 0}

    def blocked(*_args: Any, **_kwargs: Any) -> Any:
        state["attemptedCalls"] += 1
        raise PocError("NETWORK_ACCESS_BLOCKED_DURING_BENCHMARK")

    socket.create_connection = blocked  # type: ignore[assignment]
    socket.getaddrinfo = blocked  # type: ignore[assignment]
    socket.socket.connect = blocked  # type: ignore[method-assign]
    socket.socket.connect_ex = blocked  # type: ignore[method-assign]
    return state


def process_memory() -> dict[str, int]:
    if os.name != "nt":
        return {
            "loadedWorkingSetBytes": 0,
            "peakWorkingSetBytes": 0,
            "privateUsageBytes": 0,
        }
    counters = ProcessMemoryCountersEx()
    counters.cb = ctypes.sizeof(counters)
    success = ctypes.windll.psapi.GetProcessMemoryInfo(
        ctypes.windll.kernel32.GetCurrentProcess(),
        ctypes.byref(counters),
        counters.cb,
    )
    if not success:
        raise PocError("PROCESS_MEMORY_QUERY_FAILED")
    return {
        "loadedWorkingSetBytes": int(counters.WorkingSetSize),
        "peakWorkingSetBytes": int(counters.PeakWorkingSetSize),
        "privateUsageBytes": int(counters.PrivateUsage),
    }


def percentile(sorted_values: list[float], quantile: float) -> float:
    if not sorted_values:
        return 0.0
    position = (len(sorted_values) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return sorted_values[lower]
    weight = position - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


def latency_summary(values: list[float]) -> dict[str, Any]:
    if not values:
        return {
            "n": 0,
            "minMs": 0.0,
            "p50Ms": 0.0,
            "p95Ms": 0.0,
            "maxMs": 0.0,
            "meanMs": 0.0,
        }
    ordered = sorted(values)
    return {
        "n": len(values),
        "minMs": round(ordered[0], 3),
        "p50Ms": round(percentile(ordered, 0.5), 3),
        "p95Ms": round(percentile(ordered, 0.95), 3),
        "maxMs": round(ordered[-1], 3),
        "meanMs": round(statistics.fmean(values), 3),
    }


def exact_multiset_preserved(pattern: re.Pattern[str], source: str, target: str) -> bool:
    expected = collections.Counter(pattern.findall(source))
    if not expected:
        return True
    observed = collections.Counter(pattern.findall(target))
    return all(observed[token] >= count for token, count in expected.items())


def sample_summary(sample: dict[str, Any], translated: str, target_tokens: int) -> dict[str, Any]:
    return {
        "id": sample["id"],
        "sourceChars": len(sample["source"]),
        "targetChars": len(translated),
        "targetTokens": target_tokens,
        "digitsPreserved": exact_multiset_preserved(
            DIGIT_PATTERN, sample["source"], translated
        ),
        "urlsPreserved": exact_multiset_preserved(
            URL_PATTERN, sample["source"], translated
        ),
        "placeholdersPreserved": exact_multiset_preserved(
            PLACEHOLDER_PATTERN, sample["source"], translated
        ),
        "nonEmpty": bool(translated.strip()),
    }


def relevant_rate(
    samples: list[dict[str, Any]],
    summaries: list[dict[str, Any]],
    source_pattern: re.Pattern[str],
    summary_key: str,
) -> float:
    relevant = [
        summary[summary_key]
        for sample, summary in zip(samples, summaries, strict=True)
        if source_pattern.search(sample["source"])
    ]
    if not relevant:
        return 1.0
    return round(sum(1 for value in relevant if value) / len(relevant), 6)


def translate_once(
    translator: Any,
    tokenizer: Any,
    architecture: str,
    direction: str,
    text: str,
    beam_size: int,
) -> tuple[str, int]:
    source_language, target_language = direction.split("-")
    if architecture == "M2M100":
        tokenizer.src_lang = source_language
    source_ids = tokenizer.encode(text)
    source_tokens = tokenizer.convert_ids_to_tokens(source_ids)
    options: dict[str, Any] = {
        "beam_size": beam_size,
        "max_input_length": 512,
        "max_decoding_length": 256,
    }
    if architecture == "M2M100":
        target_prefix = [tokenizer.lang_code_to_token[target_language]]
        result = translator.translate_batch(
            [source_tokens], target_prefix=[target_prefix], **options
        )
        target_tokens = result[0].hypotheses[0][1:]
    else:
        result = translator.translate_batch([source_tokens], **options)
        target_tokens = result[0].hypotheses[0]
    target_ids = tokenizer.convert_tokens_to_ids(target_tokens)
    translated = tokenizer.decode(target_ids, skip_special_tokens=True)
    return translated, len(target_tokens)


def benchmark_worker(config: dict[str, Any]) -> dict[str, Any]:
    os.environ.update(enable_offline_environment(os.environ))
    socket_state = install_python_socket_guard()
    from sacrebleu.metrics import CHRF  # pylint: disable=import-outside-toplevel
    import ctranslate2  # pylint: disable=import-outside-toplevel
    import transformers  # pylint: disable=import-outside-toplevel

    load_start = time.perf_counter()
    translator = ctranslate2.Translator(
        config["modelDir"],
        device="cpu",
        compute_type="int8",
        inter_threads=config["interThreads"],
        intra_threads=config["intraThreads"],
    )
    tokenizer = transformers.AutoTokenizer.from_pretrained(
        config["tokenizerDir"],
        local_files_only=True,
        trust_remote_code=False,
    )
    model_load_ms = (time.perf_counter() - load_start) * 1000
    loaded_memory = process_memory()

    samples = config["samples"]
    first_start = time.perf_counter()
    translate_once(
        translator,
        tokenizer,
        config["architecture"],
        config["direction"],
        samples[0]["source"],
        config["beamSize"],
    )
    first_translation_ms = (time.perf_counter() - first_start) * 1000

    warm_latencies: list[float] = []
    quality_outputs: dict[str, tuple[str, int]] = {}
    total_source_chars = 0
    total_target_tokens = 0
    total_translation_seconds = 0.0
    for iteration in range(config["iterations"]):
        for sample in samples:
            start = time.perf_counter()
            translated, token_count = translate_once(
                translator,
                tokenizer,
                config["architecture"],
                config["direction"],
                sample["source"],
                config["beamSize"],
            )
            elapsed = time.perf_counter() - start
            warm_latencies.append(elapsed * 1000)
            total_translation_seconds += elapsed
            total_source_chars += len(sample["source"])
            total_target_tokens += token_count
            if iteration == 0:
                quality_outputs[sample["id"]] = (translated, token_count)

    hypotheses = [quality_outputs[sample["id"]][0] for sample in samples]
    references = [sample["reference"] for sample in samples]
    summaries = [
        sample_summary(
            sample,
            quality_outputs[sample["id"]][0],
            quality_outputs[sample["id"]][1],
        )
        for sample in samples
    ]
    chrf2 = CHRF(word_order=2).corpus_score(hypotheses, [references]).score
    memory = process_memory()
    memory["loadedWorkingSetBytes"] = loaded_memory["loadedWorkingSetBytes"]
    denominator = total_translation_seconds if total_translation_seconds > 0 else 1.0
    return {
        "direction": config["direction"],
        "status": "MEASURED",
        "modelLoadMs": round(model_load_ms, 3),
        "firstTranslationMs": round(first_translation_ms, 3),
        "warmLatency": latency_summary(warm_latencies),
        "throughput": {
            "sourceCharsPerSecond": round(total_source_chars / denominator, 3),
            "targetTokensPerSecond": round(total_target_tokens / denominator, 3),
        },
        "memory": memory,
        "quality": {
            "chrf2Score": round(chrf2, 4),
            "digitsPreservedRate": relevant_rate(
                samples, summaries, DIGIT_PATTERN, "digitsPreserved"
            ),
            "urlsPreservedRate": relevant_rate(
                samples, summaries, URL_PATTERN, "urlsPreserved"
            ),
            "placeholdersPreservedRate": relevant_rate(
                samples, summaries, PLACEHOLDER_PATTERN, "placeholdersPreserved"
            ),
            "nonEmptyRate": round(
                sum(1 for item in summaries if item["nonEmpty"]) / len(summaries),
                6,
            ),
        },
        "samples": summaries,
        "networkAttemptedCalls": socket_state["attemptedCalls"],
        "supportedCpuComputeTypes": sorted(
            ctranslate2.get_supported_compute_types("cpu")
        ),
    }


def empty_route(direction: str, status: str) -> dict[str, Any]:
    return {
        "direction": direction,
        "status": status,
        "modelLoadMs": None,
        "firstTranslationMs": None,
        "warmLatency": latency_summary([]),
        "throughput": {
            "sourceCharsPerSecond": 0.0,
            "targetTokensPerSecond": 0.0,
        },
        "memory": {
            "loadedWorkingSetBytes": 0,
            "peakWorkingSetBytes": 0,
            "privateUsageBytes": 0,
        },
        "quality": {
            "chrf2Score": None,
            "digitsPreservedRate": 0.0,
            "urlsPreservedRate": 0.0,
            "placeholdersPreservedRate": 0.0,
            "nonEmptyRate": 0.0,
        },
        "samples": [],
        "networkAttemptedCalls": 0,
        "supportedCpuComputeTypes": [],
    }


def incomplete_gate_a_completeness(directions: list[str]) -> dict[str, Any]:
    unmet = [
        "MODEL_RUNTIME_LICENSE_AND_REDISTRIBUTION_EVIDENCE_INCOMPLETE",
        "BASE_INSTALLER_AND_CORE_PACK_SIZING_INCOMPLETE",
        "RAW_MEASUREMENT_RESULTS_NOT_ATTACHED",
        "WINDOWS_PRIVATE_WORKING_SET_MEASUREMENT_INCOMPLETE",
    ]
    for direction in sorted(set(directions)):
        unmet.extend(
            [
                f"MULTI_COLD_FRESH_PROCESS_MEASUREMENT_INCOMPLETE:{direction}",
                f"WARM_MEASUREMENT_INCOMPLETE:{direction}",
                f"HUMAN_BLIND_EVALUATION_INCOMPLETE:{direction}",
            ]
        )
    return {
        "inputStatus": "GATE_A_INPUT_INCOMPLETE",
        "ready": False,
        "gateAStatus": "BLOCKED_INCOMPLETE_M4_EVIDENCE",
        "requirements": {
            "minimumColdTrialsPerDirection": 20,
            "coldTrialsRequireFreshProcess": True,
            "privateWorkingSetMetric": "WINDOWS_PRIVATE_WORKING_SET",
            "minimumHumanBlindReviewsPerDirection": 200,
        },
        "unmetConditions": unmet,
    }


def classify_partial_measurement_status(
    route_results: list[dict[str, Any]],
) -> str:
    return (
        "PARTIAL_M4_MEASUREMENT"
        if route_results
        and all(route.get("status") == "MEASURED" for route in route_results)
        else "BLOCKED"
    )


def run_route_worker(config: dict[str, Any], timeout_seconds: float) -> tuple[dict[str, Any], bool]:
    command = [sys.executable, str(Path(__file__).resolve()), "--worker"]
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        completed = subprocess.run(
            command,
            input=json.dumps(config, ensure_ascii=False),
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
            env=enable_offline_environment(os.environ),
            creationflags=creation_flags,
        )
    except subprocess.TimeoutExpired:
        return empty_route(config["direction"], "TIMEOUT"), True
    if completed.returncode != 0:
        return empty_route(config["direction"], "BLOCKED"), False
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return empty_route(config["direction"], "BLOCKED"), False
    if not isinstance(value, dict) or value.get("status") != "MEASURED":
        return empty_route(config["direction"], "BLOCKED"), False
    return value, False


def benchmark_controller(args: argparse.Namespace) -> dict[str, Any]:
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
    verify_poc_authorization(authorization, manifest, candidate)
    packages = installed_versions(manifest)

    model_dir = assert_artifact_child(Path(args.model_dir))
    tokenizer_dir = assert_artifact_child(Path(args.tokenizer_dir))
    if not model_dir.is_dir() or not tokenizer_dir.is_dir():
        raise PocError("LOCAL_MODEL_OR_TOKENIZER_DIRECTORY_MISSING")
    model_identity = tree_identity(model_dir)
    samples, fixture_raw = load_fixture(Path(args.fixture))
    allowed_directions = {
        f"{route['source']}-{route['target']}" for route in candidate["routes"]
    }
    fixture_directions = {sample["direction"] for sample in samples}
    selected_directions = sorted(allowed_directions & fixture_directions)
    if not selected_directions:
        raise PocError("NO_FIXTURE_SAMPLES_FOR_CANDIDATE_ROUTES")

    route_results: list[dict[str, Any]] = []
    hard_kill_count = 0
    for direction in selected_directions:
        route_samples = [
            sample for sample in samples if sample["direction"] == direction
        ]
        config = {
            "architecture": candidate["architecture"],
            "direction": direction,
            "modelDir": str(model_dir),
            "tokenizerDir": str(tokenizer_dir),
            "samples": route_samples,
            "iterations": args.iterations,
            "beamSize": manifest["policy"]["benchmarkBeamSize"],
            "interThreads": manifest["policy"]["benchmarkInterThreads"],
            "intraThreads": manifest["policy"]["benchmarkIntraThreads"],
        }
        result, timed_out = run_route_worker(config, args.route_timeout_seconds)
        route_results.append(result)
        hard_kill_count += int(timed_out)

    status = classify_partial_measurement_status(route_results)
    supported_types = unique_sorted(
        [
            compute_type
            for route in route_results
            for compute_type in route.get("supportedCpuComputeTypes", [])
        ]
    )
    report = {
        "schemaVersion": MEASUREMENT_SCHEMA_VERSION,
        "status": status,
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scope": POC_RESEARCH_SCOPE,
        "manifest": {
            "schemaVersion": manifest["schemaVersion"],
            "sha256": manifest_sha256(manifest),
        },
        "candidate": {
            "id": candidate["id"],
            "repository": candidate["repository"],
            "revision": candidate["revision"],
            "architecture": candidate["architecture"],
            "licenseExpression": candidate["license"]["expression"],
            "observedLicenseMetadataExpression": candidate["license"][
                "observedMetadataExpression"
            ],
            "commercialUseConclusion": candidate["license"][
                "commercialUseConclusion"
            ],
            "pocAuthorizationScope": POC_RESEARCH_SCOPE,
            "gateAStatus": "BLOCKED_INCOMPLETE_M4_EVIDENCE",
        },
        "environment": {
            "os": f"{platform.system()} {platform.release()} {platform.version()}",
            "architecture": platform.machine(),
            "cpu": platform.processor() or "unknown",
            "logicalCpuCount": os.cpu_count() or 1,
            "python": platform.python_version(),
            "packages": packages,
            "supportedCpuComputeTypes": supported_types,
        },
        "networkIsolation": {
            "mode": "PROCESS_LEVEL_OFFLINE_GUARD",
            "pythonSocketGuard": True,
            "offlineEnvironment": True,
            "attemptedCalls": sum(
                route.get("networkAttemptedCalls", 0) for route in route_results
            ),
            "externalNetworkAccess": "NOT_VERIFIED",
            "osFirewallVerified": False,
        },
        "artifacts": {
            "convertedModelBytes": model_identity["bytes"],
            "convertedModelTreeSha256": model_identity["sha256"],
            "fixtureBytes": len(fixture_raw),
            "fixtureSha256": hashlib.sha256(fixture_raw).hexdigest(),
        },
        "routes": [
            {
                key: value
                for key, value in route.items()
                if key not in ("networkAttemptedCalls", "supportedCpuComputeTypes")
            }
            for route in route_results
        ],
        "quality": {
            "metric": "sacreBLEU-chrF2++",
            "sampleCount": sum(
                len(route.get("samples", [])) for route in route_results
            ),
            "humanReviewStatus": "NOT_PERFORMED",
            "rawTextEmitted": False,
        },
        "gateACompleteness": incomplete_gate_a_completeness(
            [route["direction"] for route in route_results]
        ),
        "timeouts": {
            "routeBudgetMs": round(args.route_timeout_seconds * 1000),
            "hardKillCount": hard_kill_count,
        },
        "limitations": [
            "The socket guard and offline environment are process-level controls; an OS firewall or packet capture has not been verified.",
            "Quality uses a small synthetic fixture and has no human bilingual review.",
            "Results cover one Windows CPU environment and are not production acceptance.",
            "M0 POC research authorization does not approve redistribution, packaging, or production integration; this measurement is input to the later Gate A route decision.",
        ],
    }
    assert_report_contains_no_raw_text(report, samples)
    if args.output:
        output = assert_artifact_child(Path(args.output))
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    return report


def assert_report_contains_no_raw_text(
    report: dict[str, Any], samples: list[dict[str, Any]]
) -> None:
    serialized = json.dumps(report, ensure_ascii=False)
    forbidden = [
        text
        for sample in samples
        for text in (sample["source"], sample["reference"])
        if len(text) >= 8
    ]
    if any(text in serialized for text in forbidden):
        raise PocError("RAW_QUALITY_TEXT_LEAKED_TO_MEASUREMENT")
    home_name = Path.home().name
    if home_name and home_name.lower() in serialized.lower():
        raise PocError("LOCAL_USER_IDENTITY_LEAKED_TO_MEASUREMENT")


def run_self_test() -> dict[str, Any]:
    samples = [
        {
            "id": "selftest-preserve",
            "direction": "en-zh",
            "source": "Open https://example.invalid/{name}?v=2.7.1",
            "reference": "Open https://example.invalid/{name}?v=2.7.1",
            "tags": ["selftest"],
        }
    ]
    summary = sample_summary(samples[0], samples[0]["reference"], 8)
    if not all(
        summary[key]
        for key in (
            "digitsPreserved",
            "urlsPreserved",
            "placeholdersPreserved",
            "nonEmpty",
        )
    ):
        raise PocError("INVARIANT_SELF_TEST_FAILED")
    stats = latency_summary([1.0, 2.0, 3.0, 4.0])
    if stats["n"] != 4 or stats["p50Ms"] != 2.5 or stats["p95Ms"] <= 3.0:
        raise PocError("LATENCY_STATISTICS_SELF_TEST_FAILED")
    timeout_observed = False
    try:
        subprocess.run(
            [sys.executable, "-c", "import time; time.sleep(0.2)"],
            check=False,
            timeout=0.02,
            capture_output=True,
            env=enable_offline_environment(os.environ),
        )
    except subprocess.TimeoutExpired:
        timeout_observed = True
    if not timeout_observed:
        raise PocError("HARD_TIMEOUT_SELF_TEST_FAILED")
    if classify_partial_measurement_status(
        [{"status": "TIMEOUT"}]
    ) != "BLOCKED":
        raise PocError("TIMEOUT_MUST_FAIL_CLOSED_SELF_TEST_FAILED")

    fixture_bytes = b"phase7-self-test"
    route = {
        "direction": "en-zh",
        "status": "STATIC_FIXTURE_ONLY",
        "modelLoadMs": 1.0,
        "firstTranslationMs": 2.0,
        "warmLatency": stats,
        "throughput": {
            "sourceCharsPerSecond": 100.0,
            "targetTokensPerSecond": 20.0,
        },
        "memory": {
            "loadedWorkingSetBytes": 1,
            "peakWorkingSetBytes": 2,
            "privateUsageBytes": 1,
        },
        "quality": {
            "chrf2Score": 100.0,
            "digitsPreservedRate": 1.0,
            "urlsPreservedRate": 1.0,
            "placeholdersPreservedRate": 1.0,
            "nonEmptyRate": 1.0,
        },
        "samples": [
            {
                key: value
                for key, value in summary.items()
                if key
                in (
                    "id",
                    "sourceChars",
                    "targetChars",
                    "targetTokens",
                    "digitsPreserved",
                    "urlsPreserved",
                    "placeholdersPreserved",
                    "nonEmpty",
                )
            }
        ],
    }
    report = {
        "schemaVersion": MEASUREMENT_SCHEMA_VERSION,
        "status": "NO_MODEL_STATIC_SELF_TEST_PASS",
        "measuredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scope": POC_RESEARCH_SCOPE,
        "manifest": {
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "sha256": hashlib.sha256(b"selftest-manifest").hexdigest(),
        },
        "candidate": {
            "id": "selftest",
            "repository": "local/selftest",
            "revision": "0" * 40,
            "architecture": "FAKE",
            "licenseExpression": "NOASSERTION",
            "observedLicenseMetadataExpression": "SELF_TEST_ONLY",
            "commercialUseConclusion": "NOT_ESTABLISHED",
            "pocAuthorizationScope": POC_RESEARCH_SCOPE,
            "gateAStatus": "SELF_TEST_ONLY",
        },
        "environment": {
            "os": platform.system() or "unknown",
            "architecture": platform.machine() or "unknown",
            "cpu": "redacted-selftest",
            "logicalCpuCount": os.cpu_count() or 1,
            "python": platform.python_version(),
            "packages": {},
            "supportedCpuComputeTypes": [],
        },
        "networkIsolation": {
            "mode": "PROCESS_LEVEL_OFFLINE_GUARD",
            "pythonSocketGuard": True,
            "offlineEnvironment": True,
            "attemptedCalls": 0,
            "externalNetworkAccess": "NOT_VERIFIED",
            "osFirewallVerified": False,
        },
        "artifacts": {
            "convertedModelBytes": 0,
            "convertedModelTreeSha256": hashlib.sha256(b"").hexdigest(),
            "fixtureBytes": len(fixture_bytes),
            "fixtureSha256": hashlib.sha256(fixture_bytes).hexdigest(),
        },
        "routes": [route],
        "quality": {
            "metric": "sacreBLEU-chrF2++",
            "sampleCount": 1,
            "humanReviewStatus": "NOT_PERFORMED",
            "rawTextEmitted": False,
        },
        "gateACompleteness": incomplete_gate_a_completeness(["en-zh"]),
        "timeouts": {
            "routeBudgetMs": 20,
            "hardKillCount": 1,
        },
        "limitations": [
            "Self-test uses a deterministic fake translation and does not execute a model."
        ],
    }
    assert_report_contains_no_raw_text(report, samples)
    return report


def worker_main() -> int:
    try:
        config = json.load(sys.stdin)
        report = benchmark_worker(config)
        sys.stdout.write(json.dumps(report, ensure_ascii=False))
        return 0
    except PocError as error:
        sys.stdout.write(json.dumps({"status": "BLOCKED", "errorCode": error.code}))
        return 1
    except Exception:
        sys.stdout.write(
            json.dumps({"status": "BLOCKED", "errorCode": "UNEXPECTED_WORKER_FAILURE"})
        )
        return 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Measure one locally converted CTranslate2 candidate on CPU."
    )
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    parser.add_argument("--candidate")
    parser.add_argument("--model-dir")
    parser.add_argument("--tokenizer-dir")
    parser.add_argument("--poc-authorization")
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--route-timeout-seconds", type=float, default=180.0)
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.worker or args.self_test:
        return args
    required = {
        "--candidate": args.candidate,
        "--model-dir": args.model_dir,
        "--tokenizer-dir": args.tokenizer_dir,
        "--poc-authorization": args.poc_authorization,
    }
    if any(value is None for value in required.values()):
        parser.error("candidate, model-dir, tokenizer-dir, and poc-authorization are required")
    if args.iterations < 1 or args.iterations > 100:
        parser.error("iterations must be between 1 and 100")
    if args.route_timeout_seconds <= 0 or args.route_timeout_seconds > 3600:
        parser.error("route-timeout-seconds must be in (0, 3600]")
    return args


def main() -> int:
    args = parse_args()
    if args.worker:
        return worker_main()
    try:
        report = run_self_test() if args.self_test else benchmark_controller(args)
        sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        return 0
    except PocError as error:
        sys.stderr.write(
            json.dumps(
                {
                    "status": "BLOCKED",
                    "errorCode": error.code,
                    "rawPathsEmitted": False,
                    "rawTextEmitted": False,
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
                    "errorCode": "UNEXPECTED_BENCHMARK_FAILURE",
                    "rawPathsEmitted": False,
                    "rawTextEmitted": False,
                }
            )
            + "\n"
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
