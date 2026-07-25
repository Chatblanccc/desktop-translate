# Phase 7 M4 development evidence

- Evidence date: 2026-07-25
- Status: `DEVELOPMENT PARTIAL / FORMAL EVIDENCE BLOCKED / GATE A INPUT INCOMPLETE`
- Product integration: `NOT AUTHORIZED / NOT IMPLEMENTED`
- Formal 20-by-2 cold run:
  `ATTEMPTED THREE TIMES / ALL BLOCKED / NO GATE-A-ELIGIBLE RESULT`
- Human blind evaluation: `NOT RUN`
- OS-level external-network observation: `NOT RUN`

This note records reproducible development observations only. It cannot select
a model, authorize redistribution, satisfy Gate A, or start M5.

## Firefox/Bergamot compatibility track

The research manifest binds 12 Mozilla model/runtime supply files:

- manifest SHA-256:
  `ba597cf31464543bfef3d2ac6b3a470d9e0ca6f4567405388354250d402bb6e9`;
- supply size: `77,924,371` bytes;
- supply tree SHA-256:
  `09f82c55a118449862441af825f21966ccb4cdfe22ffb1f941a5d6a7a28d1626`;
- runtime: unmodified `@browsermt/bergamot-translator@0.4.9`;
- execution boundary: hidden sandboxed Electron renderer over an
  exact-allowlist IPv4 loopback origin.

One compatibility run completed both en→zh and zh→en routes in the pinned
Electron runtime. It proved that the unmodified browser Worker path can execute
locally. It did not prove translation quality, release licensing, product
integration, OS-level network absence, or a Gate A performance distribution.
The observed zh→en sample degenerated into a punctuation-dominated output, so
no quality PASS is claimed. The raw synthetic source/output is not copied into
this evidence note.

The Electron development binary used for the experiment is `NotSigned`.
Its SHA-256 is
`12b61e817329db7db8e74d99a42e552e1a1f68db7ba3d4c2d4fb6441a3b07d26`.

## Fresh-process Windows Private Working Set

The development runner measures every active member of a non-breakaway Windows
Job with `QueryWorkingSet`. PID and creation time remain internal; raw evidence
uses anonymous process ordinals and executable hashes.

The ignored no-regression smoke is:

```text
artifacts/phase7/offline-poc/measurements/
  bergamot-cold-pws-smoke-v2-complete-recovery-20260723-r1.json
```

Artifact SHA-256:
`11ded84c05a44ad4553f68fcc34d7dee7b25838625daf5ee0be015749ff9abc6`.

| Direction | Complete samples | Verified transition | PWS peak | Development result |
|---|---:|---:|---:|---|
| en→zh | 51 | none | 997,875,712 bytes / 951.648 MiB | `PASS_CONTINUOUS_SAMPLING` |
| zh→en | 56 | one exact-set gap, 189.809 ms | 1,015,906,304 bytes / 968.844 MiB | `PASS_WITH_TRANSITION_RESERVE` |

Both trials had zero discarded samples, zero measurement failures, normal root
exit, zero forced cleanup, three verified zero-member Job polls, and zero
residual Electron processes. The zh→en gap remained below the frozen 500 ms
exact-membership-change limit and its peak remained below the frozen 1.0 GiB
transition-reserve limit.

This `1×2` run is not the required `20×2` distribution. It also did not
encounter the new
`EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES` discovery mode. That branch is
covered by native/static positive and fail-closed fixtures, not by this one
real run.

### Failed formal attempts

Three distinct `20×2` attempts were executed and their ignored raw artifacts
remain preserved. Each artifact requested 40 cold trials, reports
`status=BLOCKED`, and uses the old direct-runner schema
`phase7-bergamot-cold-pws-v2`. None may be relabelled, overwritten, or used as
Gate A evidence.

| Attempt | Preserved artifact and SHA-256 | Result | Permanent evidence disposition |
|---|---|---|---|
| r1 | `artifacts/phase7/offline-poc/measurements/bergamot-cold-pws-formal-20260724-r1.json`<br>`58def2d8ec0aa5a8907570a8bb1cad27e848563587ac8b87e721506e418678f5`<br>`20,666,233` bytes | 29/40 successful; 11 failed, comprising 9 incomplete-sampling failures and 2 marker-process exit timeouts; 3 forced kills | `FAILED / CONTAMINATED / GATE-A-INELIGIBLE`. An M4 self-test ran concurrently for about 48.2 seconds during the formal window (approximately 01:50:19–01:51:08), so this run is permanently contaminated in addition to its trial failures. |
| r2 isolated | `artifacts/phase7/offline-poc/measurements/bergamot-cold-pws-formal-20260724-r2-isolated.json`<br>`30680cda7a12f64b55b0b4e674694a22b7837034dc1526d5001ca36bc72f526c`<br>`18,554,359` bytes | 27/40 successful; 13 incomplete-sampling failures; 0 forced kills | `BLOCKED / GATE-A-INELIGIBLE`. The isolated run exposed terminal-boundary producer defects, cadence failures, and discarded Job queries. |
| r3 terminal-zero | `artifacts/phase7/offline-poc/measurements/bergamot-cold-pws-formal-20260724-r3-terminal-zero.json`<br>`5688fcd155397afe2f244484bab26d55b768c589ee93fbed62afd0fd43b03dad`<br>`28,904,741` bytes | 23/40 successful; 17 failed, comprising 16 incomplete-sampling failures and 1 post-exit Job-query failure; 1 forced kill. All 200/200 requested warm measurements completed. | `BLOCKED / GATE-A-INELIGIBLE`. It exposed missing terminal `BOUND_PROCESS_EXIT_ACCOUNTING_LAG` support, transient exact-empty handling, and post-root-exit query fail-fast defects. |

The latest PWS producer was hardened after r3. Its fail-closed changes include
strict terminal BOUND-only and EXACT→BOUND accounting, one root recheck for a
transient exact-empty snapshot, at most one immediate retry around each
pre/post `QueryJobProcesses` observation, immediate failure after a root-exit
query error, and explicit retry/pending/post-exit counters. Scoped self-tests
pass. An independent source/evidence review found no lost-peak path, threshold
relaxation, or hidden failure in those changes.

No formal run has been repeated with this latest producer. The current runner
now emits `phase7-offline-cold-pws-v3` and refuses to start without both
directional candidate-generation artifact paths. After the trials it binds
their raw hashes, candidate/run identities, authorization, manifest,
model/runtime trees and exact cold workload identity into the report. Therefore
the producer hardening is development evidence only; it does not repair or
supersede r1/r2/r3 and does not produce a formal Gate A result.

Current development self-tests:

```text
node tooling/phase7-offline-poc/bergamot-cold-pws-selftest.mjs
SELF_TEST_PASS

node tooling/phase7-offline-poc/gate-a-completeness-selftest.mjs
STATIC_COMPLETENESS_SELF_TEST_PASS
14 transition/recovery negative fixtures
16 cross-binding negative fixtures

node tooling/phase7-offline-poc/gate-a-candidate-bindings-selftest.mjs
CANDIDATE_BINDING_SELF_TEST_PASS

node tooling/phase7-offline-poc/selftest.mjs
STATIC_SCHEMA_SELF_TEST_PASS
```

## Current base-installer development observation

The dirty-worktree unsigned development snapshot was rebuilt after the M3
uninstall and M4 cross-binding code changes and before this evidence paragraph
was appended:

- source identity:
  `HEAD+WORKTREE:aaa93f5523b30713cfb65f66a6486276b0dd22cd4730743c2915de6046b215d7`;
- installer bytes: `130,711,602` / `124.656 MiB`;
- installer SHA-256:
  `d4f0e882a34fc49e3e11039d60dc9f9dd276b0b87f645d820d4b38795a2a7b35`;
- installed bytes: `337,876,713` / `322.224 MiB`;
- evidence root:
  `artifacts/phase5/8636fc0e542841e4689103c37a0588edfc6411f8/local-20260725T1250477361444Z-8903ae0b2bdb4e01ac819bea8686c7b6`;
- compile-chain, package allowlist/ASAR/resources/hash/size, startup smoke,
  SBOM and evidence-traceability gates: `PASS`;
- model-like file scan in `win-unpacked`: `0`;
- package/product residual process count: `0`;
- Authenticode: application, Native Host and installer all `NotSigned`.

This proves the present base package stays below the 150-MiB threshold and
does not contain an offline model. It is not the cross-bound Gate A package
sizing record: the worktree is dirty, the candidate is unsigned, no matching
candidate-generation set exists, and independent attestation/clean-download
verification has not run.

## Argos/CTranslate2 comparison track

The research-only Argos track is now represented by a pinned manifest,
controlled runtime/model materializers, and a direct-runtime harness. Its
canonical manifest SHA-256 is
`627eb2b7ed1b9f50e10226f03e475587a30e00272a029d90eaa7132244a7d645`.
The manifest fixes:

- Argos package-index revision
  `ff90de60728f7c1338ff6b75974e4c89b2442d22`;
- Argos Translate source revision
  `c72ec9040a580bc5f9ad4272f2c8a685d9bc66dd`;
- CTranslate2 `v4.8.1` source commit
  `0d8bcd362ac75ef860ef161d6f0efad0ae439ff0`;
- en→zh and zh→en model archive sizes and SHA-256 values;
- fixed direct-runtime options, including `beam_size=4`,
  `replace_unknowns=true`, and `length_penalty=0.2`.

The two model archives total `145,224,423` bytes / `138.497 MiB`; their pinned
unpacked contents total `171,778,261` bytes / `163.821 MiB`. CPython 3.13.10,
CTranslate2 4.8.1, SentencePiece 0.2.1, NumPy 2.2.6, PyYAML 6.0.3, and
setuptools 80.9.0 are pinned as local supply. The complete eight-file download
set is `190,391,335` bytes / `181.571 MiB`. Its controlled, network-free
materialization produced a `1,435`-file isolated execution tree of
`132,513,327` bytes / `126.375 MiB`, SHA-256
`161fdea29bd9910a7c9e33d64a8c733099bbdee0829e921adeb951c45268147c`.

The static harness defaults to no network and requires both an exact
research-authorization record and an explicit network flag before downloading.
It validates archive headers, CRCs, path safety, Windows name collisions,
links, compression limits, atomic materialization, manifest-authoritative
model/runtime trees, and cross-runtime receipts. Its batch interface permits
translation text only in an explicitly requested private, ignored
blind-evaluation candidate file; reports and standard output remain text-free.
Runtime/model load and translation execute with process stdout/stderr captured
and discarded under a one-MiB bound; reports publish byte counts only.

Development self-test:

```text
node tooling/phase7-offline-poc/argos-selftest.mjs
ARGOS_STATIC_SCHEMA_AND_SAFETY_SELF_TEST_PASS
```

The pinned supply set was downloaded into the ignored research artifact root,
verified offline (`8/8`), materialized, and run once per direction on Windows.
Both runs used exact model/runtime tree pins and emitted only sanitized
length/hash reports:

| Direction | Output records | Aggregate characters | Captured stdout/stderr |
|---|---:|---:|---:|
| en→zh | 1 | 7 | 0 / 0 bytes |
| zh→en | 1 | 16 | 0 / 0 bytes |

This `1×2` smoke is compatibility evidence, not a quality or performance
distribution. No eligible human comparison, formal fresh-process PWS,
OS-level network observation, final packaging measurement, complete
license/NOTICE/SBOM approval, or redistribution approval exists. The
model-license conclusion remains `NOASSERTION / LEGAL_REVIEW_REQUIRED`.

## Blind-evaluation readiness

The local harness enforces:

- at least 200 unique public or self-authored synthetic items per direction;
- candidate-anonymous HMAC randomization and a withheld private answer key;
- human-only structured review with no free-text notes;
- duplicate, tamper, candidate-remap and privacy fail-closed checks;
- no source, reference or translated text in the summary report.

The v1 development summarizer remains available for old evidence. A new
`summarize-v2` path now derives the required v2 report only after it binds all
counted candidate/run identities to the same two raw
`phase7-gate-a-candidate-generation-v1` artifacts and M0 authorization used
by the cold runner. The binding also includes source-set identity/count and
private candidate-output/item-set hashes; v2 recomputes the reviewed item set
from the verified private answer key. Synthetic positive, candidate-remapping
and substituted-item-set negative tests pass. No eligible 200-item dataset,
real generation artifact, v2 report, or human review has been accepted as M4
evidence.

## Gate A cross-evidence binding

A strict cross-binding completeness contract and schema now exist in the
isolated M4 tooling. They fail closed unless the same primary evidence set
binds the cold workload, model/runtime identity, candidate-generation source
set and authorization, manifests and raw hashes, legal record, OS-network
observation, and final package sizing. Even a complete structurally valid
input can return only:

```text
GATE_A_INPUT_READY
AWAITING_EXPLICIT_USER_DECISION
```

It cannot authorize product integration or make the user's Gate A decision.
The cross-binding self-test covers complete input plus missing, mismatched,
duplicate, remapped, old-schema, legal, network, and sizing failures.

Current evidence is deliberately rejected by that contract:

- preserved Bergamot runs emit `phase7-bergamot-cold-pws-v2`; the hardened
  producer can emit v3 but no real v3 formal run exists;
- preserved blind reports emit `phase7-blind-eval-report-v1`; the hardened
  summarizer can emit v2 but no real v2 report exists;
- no matching `phase7-gate-a-candidate-generation-v1` raw artifact exists;
- no successful cross-bound `20×2` cold/PWS distribution or `200×2` blind
  evaluation exists;
- legal approval, OS-level external-network observation, and final exact
  installer/model sizing remain absent.

Consequently M4 remains incomplete, Gate A input is not ready, Gate A has not
been crossed, and M5+ product integration remains unauthorized.

## Open blockers

1. Resolve model-weight and complete runtime license scope, attribution and
   redistribution obligations; repository/package metadata is not commercial
   authorization.
2. Freeze an eligible fixed dataset, emit a bound
   `phase7-gate-a-candidate-generation-v1` artifact, and complete at least 200
   human blind reviews per proposed direction in the required v2 report.
3. Produce a successful, cross-bound `phase7-offline-cold-pws-v3` formal run
   with 20 fresh processes per proposed direction.
4. Measure final base-installer and exact packaged core-model sizes against the
   same candidate identity.
5. Record OS-level firewall or packet-capture evidence for that offline
   execution.
6. Submit the complete cross-bound evidence to the user; only the user can
   confirm Gate A.

The repository-wide privacy scan currently also rejects preserved development
artifacts containing absolute local user paths. The hits are in old
electron-builder diagnostics, package logs and isolated Chromium user-data
diagnostics, not production source. Those artifacts remain evidence and were
not deleted; a Gate A evidence bundle must be freshly scoped and pass its own
zero-path/zero-content scan.
