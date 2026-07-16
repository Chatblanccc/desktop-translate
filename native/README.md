# Desktop Translate Native Host (Phase 1)

This directory contains the Windows x64/C++20 system-capability boundary. It
does not contain Phase 2 UI code.

## Targets

- `selection-host.exe`: private child process started by Electron Main.
- `selection-host-probe.exe`: independently runnable UIA, DXGI, and OCR probes.
- `dt_native_core_tests`: dependency-free tests for framing, envelope parsing,
  the host state machine, and the bounded SPSC queue. The core test target is
  portable even though the host itself is Windows-only.

Configure and run with Visual Studio 2022 Build Tools plus the Windows 10/11
SDK installed:

```powershell
cmake --preset windows-x64-debug
cmake --build --preset windows-x64-debug
ctest --preset windows-x64-debug
```

The portable core can instead use any C++20 compiler and Ninja:

```powershell
cmake --preset portable-core-debug
cmake --build --preset portable-core-debug
ctest --preset portable-core-debug
```

## Process and thread model

- The process main thread owns the single-client Named Pipe request loop.
- A dedicated message-loop thread owns `WH_MOUSE_LL`. Its callback records
  fixed-size down/up events in a bounded SPSC queue, coalesces mouse-move floods
  out of that critical queue, increments a gesture generation, signals an event,
  and immediately calls `CallNextHookEx`.
- A dedicated COM MTA thread owns UI Automation. Requests are capped at one
  outstanding operation so a hung provider cannot grow an unbounded queue.
  Deadline/stop checks surround provider calls, and a 3.5-second process-level
  fail-safe prevents a defective provider from hanging this stateless child
  forever during shutdown.
- The selection consumer applies the 80 ms settle delay, waits at most 350 ms
  for UIA, and falls back to bounded ROI capture/OCR. It checks the current
  gesture generation and stop token after each stage, so a late result is never
  emitted after a newer mouse interaction or after listening has stopped.
- A parent-process monitor terminates this transient child if Electron Main
  exits. This deliberately prioritizes orphan prevention over teardown of a
  potentially hung third-party UIA provider.

## IPC boundary

The host is the Named Pipe server. Electron passes:

```text
selection-host.exe --pipe <full-name> --parent-pid <pid> --nonce <hex>
```

The pipe name must start with
`\\.\pipe\desktop-translate.selection-host.<parentPid>.<nonce>` exactly. The
nonce is 32-256 hexadecimal characters (at least 128 bits). The server uses:

- a DACL granting access only to the current user;
- `FILE_FLAG_FIRST_PIPE_INSTANCE` and `PIPE_REJECT_REMOTE_CLIENTS`;
- `GetNamedPipeClientProcessId` equality with `--parent-pid`;
- an exact `sessionNonce` match in the first `hello` request.

Frames are `uint32 little-endian length + UTF-8 JSON`, with a maximum payload of
1,048,576 bytes. The envelope is:

```text
{v, kind, id|seq, method, timestamp, payload}
```

Protocol v1 implements `hello -> ready`, `health`, `start`, `stop`, `shutdown`,
`selection/result`, and `host/error`.

## Probes

Coordinates are physical desktop pixels, including negative coordinates on
monitors left/above the primary display.

```powershell
selection-host-probe.exe --uia 800 500
selection-host-probe.exe --dxgi 720 440 320 120
selection-host-probe.exe --ocr 720 440 320 120
selection-host-probe.exe --all
```

The DXGI probe keeps pixels in memory and reports dimensions only. It never
writes a screenshot. The UIA probe prints selected text because running it is an
explicit diagnostic action.

## OCR boundary and honest capability reporting

`IOcrEngine` isolates the selection pipeline from a concrete OCR runtime.
`IPaddleOcrRuntime` is the only future PaddleOCR-specific adapter boundary. No
Paddle binaries or models are bundled in Phase 1, so the default adapter reports
`available() == false`, `ready.capabilities` omits `ocr`, health reports OCR as
degraded, and OCR probes return `ocr_unavailable`. It never fabricates an empty
successful recognition.

`DT_NATIVE_ENABLE_PADDLE_OCR` is reserved for the build that supplies a concrete
`IPaddleOcrRuntime`; changing that flag alone does not claim runtime availability.

## Known Phase 1 constraints

- DXGI probe capture currently rejects rotated outputs rather than returning
  incorrectly oriented pixels.
- A capture ROI that spans monitors is clipped to the single output with the
  largest intersection. Multi-output compositing is deferred; callers must not
  treat the clipped bitmap as the full cross-monitor ROI.
- UIA calls run off the Hook/Main threads, have a 350 ms result deadline, and
  configure UI Automation connection/transaction timeouts to 2 seconds. The
  one-outstanding cap prevents queue growth. If a defective provider ignores
  both timeout and cancellation, the dedicated host terminates itself after the
  bounded shutdown grace period rather than remaining orphaned.
- The hook queue contains only fixed-size down/up events (moves are coalesced)
  and has 1,023 usable slots. Physical input cannot normally saturate it during
  the bounded UIA stage, but overflow is counted and drops the newest control
  event; production telemetry/recovery policy remains Phase 5 work.
- A future concrete OCR runtime must honor the `timeoutMs` passed through
  `IOcrEngine::Recognize`; native inference threads are never force-killed.
- Elevated targets, secure desktop, protected capture, OCR low-confidence, and
  cross-integrity accessibility failures require later semantic detection and
  compatibility testing. They are not reported as implemented in Phase 1.
