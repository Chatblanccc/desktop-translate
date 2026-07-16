# Phase 1 native validation snapshot

Date: 2026-07-16

## Verified toolchain

This workstation does not have Visual Studio Build Tools/MSVC installed. The
complete Windows x64 host was therefore built and executed with the
workspace-local portable toolchain:

- CMake 4.4.0
- clang 22.1.8, target `x86_64-w64-windows-gnu`
- llvm-mingw `20260616`, UCRT distribution
- C++20, Release configuration, PaddleOCR integration disabled

The build produced and linked all three Phase 1 targets:

- `selection-host.exe`
- `selection-host-probe.exe`
- `dt_native_core_tests.exe`

MSVC/Visual Studio compilation remains a release gate; this snapshot must not
be read as an MSVC ABI or packaging validation.

## Automated results

The latest source snapshot was rebuilt after the strict UTF-8, RFC3339,
method-payload, nonce-comparison, UIA deadline, and shutdown changes.

```text
repository phase1:verify: exit 0
TypeScript typecheck: passed across all workspace packages
contract tests: 14/14 passed
desktop Native Host client/supervisor tests: 18/18 passed
Electron Main/Preload production build: passed
ctest: 1/1 passed (dt_native_core_tests)
direct core test: all native core tests passed
Named Pipe smoke: hello -> ready -> health -> shutdown passed
health: status=degraded, listening=false, degradedCapabilities=[ocr]
```

The Named Pipe smoke launched the real `selection-host.exe` through the
Electron Main supervisor, authenticated the per-session pipe, decoded framed
messages, checked health, and shut the child down.

Core coverage includes partial/coalesced and invalid frames, the 1 MiB limit,
strict envelope shape/version/IDs/timestamps, malformed and invalid UTF-8 JSON,
Unicode escapes, UTF-16-safe text truncation, constant-time nonce comparison,
host state transitions, and bounded SPSC queue behavior.

## Live probe results

The probes were executed from the built Windows binary on this workstation:

```text
DXGI 0 0 128 128:
  ok=true, width=128, height=128, stride=512, bytes=65536, exit=0

OCR 0 0 128 128:
  ok=false, error=ocr_unavailable,
  detail="PaddleOCR runtime is not linked; OCR was not attempted", exit=7

UIA 0 0:
  ok=false, error=uia_no_selection,
  detail="selection is empty or collapsed", exit=5

host/probe with no arguments:
  usage rejected, exit=2
```

The DXGI probe retains pixels only in memory and reports metadata. The expected
OCR failure confirms honest capability reporting; Phase 1 does not bundle a
PaddleOCR runtime or models. The neutral-point UIA result confirms that the live
COM/UIA path executes, but does not establish compatibility across Chrome,
Edge, Word, PDF readers, IDEs, games, elevated applications, or secure desktop.

## Reproduction

The repository-level commands auto-select MSVC when present and otherwise the
workspace-local llvm-mingw toolchain:

```powershell
pnpm native:configure
pnpm native:build
pnpm native:test
pnpm phase1:smoke
```

For the Visual Studio release gate:

```powershell
cd native
cmake --preset windows-x64-debug
cmake --build --preset windows-x64-release
ctest --test-dir out/build/windows-x64-debug -C Release --output-on-failure
```

## Open verification gates

- Compile and link with Visual Studio 2022 x64 plus a supported Windows SDK.
- Exercise real selection in representative UIA providers and elevated targets.
- Exercise negative-coordinate, mixed-DPI, rotated-output, protected-content,
  and ROI-spanning-multiple-monitor cases.
- Link a deliberately selected PaddleOCR runtime/models, then validate timeout,
  confidence, language, licensing, package size, and cold-start behavior.
