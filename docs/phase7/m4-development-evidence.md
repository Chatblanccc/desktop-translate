# Phase 7 M4 development evidence

- Evidence date: 2026-07-26
- Status: `DEVELOPMENT PARTIAL / COLD-PWS INPUT COMPLETE / GATE A INPUT INCOMPLETE`
- Product integration: `NOT AUTHORIZED / NOT IMPLEMENTED`
- Formal 20-by-2 cold run:
  `R8 COMPLETE / 40 OF 40 SUCCESSFUL / CANDIDATE-BOUND V3`
- AI blind quality evaluation:
  `400 AI REVIEWED / 0 PENDING / EXPLICITLY NOT HUMAN`
- Core pack sizing:
  `PREPARED / 72.450 MiB ARCHIVE / 72.536 MiB INSTALLED / PRIMARY BINDING PENDING`
- Legal review:
  `CANDIDATE-BOUND PREPARATION COMPLETE / QUALIFIED APPROVAL NOT RECORDED`
- OS-level external-network observation:
  `FAIL-CLOSED COLLECTOR READY / CURRENT SESSION NOT ADMINISTRATOR / NOT RUN`

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

## Candidate generation and fixed source set

The current self-authored synthetic source snapshot is
`phase7-self-authored-20260725-v2`. It contains 200 unique items per direction,
includes real `proper-noun` and `long-sentence` content, declares no user
history, clipboard, private corpus or personal data, and is authorized only
for Phase 7 human evaluation.

| Direction | Dataset artifact SHA-256 | Source-set identity | Generation run | Generation artifact SHA-256 |
|---|---|---|---|---|
| en→zh | `50069077fa5eda70a798679b0375bcf693dfc3d282a5effb885e344a5a20cf7f` | `bd6a800a93f4c0b0e8647dfc15d146e6c7295c5052451dda336d6a53fab09f3d` | `bergamot-en-zh-20260725-r3` | `062ae23e5d095527a040a90e8e4daef46e2eebc08380605c55f92f7517178a12` |
| zh→en | `29d5f0ff51d5e155ec954f7db60cc991536a4e179077fa54365e5c686ea9b8d8` | `4378395c396275f1a068440082c9413889501d19609e54dd27f454376336cd72` | `bergamot-zh-en-20260725-r3` | `b951e6e003da4918913bf3d508077cf687cb1b9853db33cfd319dfb174a69f47` |

Both runs executed the same pinned model/runtime used by the cold runner,
generated 200 private outputs, emitted no source/translation text in their
public evidence, observed zero external or unknown-loopback requests, and
completed renderer/session/server cleanup. Their exact authorization,
manifest, model trees, materialized/served runtime trees and fixed cold
workload identities produce candidate-binding-set SHA-256
`c349854382823f1782d3b455af62b515cda86d493bb189efbd38071c9a4741f6`.
This remains research-only and does not authorize integration or distribution.

## Fresh-process Windows Private Working Set

The development runner measures every active member of a non-breakaway Windows
Job with `QueryWorkingSet`. PID and creation time remain internal; raw evidence
uses anonymous process ordinals and executable hashes.

### Successful candidate-bound formal run

The ignored formal artifact is:

```text
artifacts/phase7/offline-poc/measurements/
  bergamot-cold-pws-formal-20260725-r8-completion-port.json
```

- schema: `phase7-offline-cold-pws-v3`;
- artifact SHA-256:
  `5c2bcb8dd7111a28e3b5683af204a8926eebb90fbc1b38f3d068e3a721c12a4b`;
- artifact bytes: `12,724,473`;
- status: `PARTIAL_M4_COLD_PWS_EVIDENCE_COMPLETE`;
- candidate-binding-set SHA-256:
  `c349854382823f1782d3b455af62b515cda86d493bb189efbd38071c9a4741f6`;
- six-file harness-set SHA-256:
  `e87e527c7bea636934004102d95b98be05bdb0fe63d9c538fb065bb3451c535d`.

| Direction | Cold N / failures | Cold p50 / p95 / max | Warm N / failures | Warm p50 / p95 / max | PWS p50 / p95 / max |
|---|---:|---:|---:|---:|---:|
| en→zh | 20 / 0 | 1,116.460 / 1,211.970 / 1,271.590 ms | 100 / 0 | 41.100 / 50.075 / 62.490 ms | 993,198,080 / 998,436,864 / 999,534,592 bytes |
| zh→en | 20 / 0 | 1,252.120 / 1,400.865 / 1,504.220 ms | 100 / 0 | 47.015 / 55.485 / 74.100 ms | 1,009,631,232 / 1,013,321,728 / 1,013,395,456 bytes |

All 40 trials completed their fixed cold and five-warm workloads, validated
their child report and completion marker, exited normally with code zero,
closed an empty Job after three consecutive zero-member polls, and recorded
`KnownProcessIdentities == TotalProcesses`. There were two recovered transient
Job-query retries, zero retry failures, zero forced kills, zero incomplete
samples, zero budget failures and zero residual Electron processes. The cold
p95, warm p95 and PWS peaks satisfy the frozen 3.0 s, 1.5 s and 1.1 GiB
thresholds.

The completion-port watcher was added after preserved r6 showed that a
short-lived fifth Electron child could start and exit entirely between two
100 ms polls. The watcher binds every Job new-process notification to creation
time, executable path and Job membership; polling remains the source of every
PWS sample. A dedicated native self-test proves final `Known == Total` after a
child starts and exits before the first history query. A 5×2 real smoke then
completed 10/10 with zero retry failures before r8 was started. No model run or
self-test overlapped the r8 formal window.

This completes only the M4 cold/warm/PWS component. At r8 creation time,
`gateA.status` remained `INCOMPLETE` because OS-level network observation,
human review, legal approval and core/model-pack sizing were absent. The
separate sizing preparation below now closes the raw size measurement, but
could not create the final cross-bound sizing document until the then-required human report
makes the primary evidence-set SHA-256 available.

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

### Preserved failed formal attempts

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

Two later v3 attempts are also preserved. The first completed all 40 model
runs but rejected the evidence because candidate generation had incorrectly
included its later task mode in the fixed cold-workload hash; no formal JSON
was written. That mismatch was fixed by separating task mode from workload
identity and generating new `r3` candidates. Candidate-bound r6 then wrote
SHA-256
`444181ed3b6e2e4a23f92fcd284fccf4077dc22f1d0dc87fcac6e6f9006bd51d`:
34/40 trials passed, all 200 warm translations completed, and 6 trials failed
strict sampling history after 127 Job queries could not recover one
short-lived lifetime identity. It used zero forced kills and cleaned every
Job, but remains permanently `BLOCKED / GATE-A-INELIGIBLE`.

The producer was then hardened with completion-port lifetime identity capture.
It still refuses to start without both directional candidate-generation
artifacts and binds their raw hashes, candidate/run identities, authorization,
manifest, model/runtime trees and exact cold workload identity. The successful
r8 report does not repair or supersede any failed attempt; it is a separate
create-new artifact.

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

node tooling/phase7-offline-poc/bergamot-generation-selftest.mjs
SELF_TEST_PASS

node tooling/phase7-offline-poc/assemble-blind-eval-input-selftest.mjs
SELF_TEST_PASS / 400 RECORDS / TAMPER REJECTED

node tooling/phase7-offline-poc/bergamot-core-pack-selftest.mjs
SELF_TEST_PASS / DETERMINISTIC DATA-ONLY ARCHIVE / MODEL PAYLOAD REJECTED

powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass
  -File tooling/phase7-offline-poc/bergamot-cold-pws-runner.ps1 -SelfTest
SELF_TEST_PASS / COMPLETION-PORT SHORT-LIVED HISTORY PASS

node tooling/phase7-offline-poc/selftest.mjs
STATIC_SCHEMA_SELF_TEST_PASS
```

## Current base-installer development observation

The latest unsigned base-installer candidate was rebuilt after the M3
uninstall/crash/ACL hardening:

- source identity:
  `a5da4ea70f4ba44bc15903fdb6bfbd3561d9b37c`;
- installer bytes: `130,711,786` / `124.656 MiB`;
- installer SHA-256:
  `ed7b27731fbaa0f823dd82b3c351b8a6e24e604ec3cfd35f5e1bdb73b19107c8`;
- installed bytes: `337,876,713` / `322.224 MiB`;
- evidence root:
  `artifacts/phase5/9870bbdf1f509e5270bdc72d10a13e658f9d9358/local-20260725T1411226132501Z-90df4218af3a4d0da613d9cb3f8bd855`;
- compile-chain, package allowlist/ASAR/resources/hash/size, startup smoke,
  SBOM and evidence-traceability gates: `PASS`;
- model-like file scan in `win-unpacked`: `0`;
- package/product residual process count: `0`;
- Authenticode: application, Native Host and installer all `NotSigned`.

This proves the present base package stays below the 150-MiB threshold and
does not contain an offline model. It is not a signed release candidate: it
predates the `r3` generation identity and independent
attestation/clean-download verification has not run.

## Candidate-bound core-pack sizing preparation

The isolated pack builder re-hashed the base installer and every file in its
exact `win-unpacked` manifest, rejected model-like paths and all pinned model
hashes, then staged the two r3 directions as one deterministic ustar+gzip
archive. The archive contains only a canonical research manifest, model
weights/vocabularies/shortlists/metadata and the observed repository-license
evidence. It contains no runtime, executable, DLL, script or plugin.

- candidate-binding-set SHA-256:
  `c349854382823f1782d3b455af62b515cda86d493bb189efbd38071c9a4741f6`;
- pack SHA-256:
  `9a75c1afa12bd49fdbc942cbcc923a85f3b8df8df9797b8b41941ea71df629d8`;
- archive bytes: `75,969,829` / `72.450 MiB`;
- installed bytes: `76,059,631` / `72.536 MiB`;
- installed tree SHA-256:
  `79c3faa1f1873ab11f601b7696d4f66b95a3f02eda39b0f45b8b4db228e6f8d3`;
- entry count: `11`, all mode `0444`, timestamp `0`, uid/gid `0`, and all
  `11` entries independently re-read and hash-verified after archive creation;
- sizing receipt SHA-256:
  `7f8627fb79de76e18df94728277127b9d492fa8cd1a3128dd0fab33c190731e6`.

An independent second build produced the same pack SHA-256 and byte count.
The 72.450-MiB archive passes both the 300-MiB target and 400-MiB hard limit,
so pack size alone does not require an M5 custom model path. The receipt
deliberately remains
`PACKAGE_SIZING_PREPARED_AWAITING_PRIMARY_EVIDENCE_SET`: a final
`phase7-gate-a-package-sizing-v1` cannot be emitted until the completed AI
review is incorporated into the primary evidence-set hash. This preparation does
not complete legal review or authorize integration/distribution.

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

This `1×2` smoke was compatibility evidence, not a quality or performance
distribution. At that checkpoint there was no eligible human comparison or
formal fresh-process PWS. The later candidate-bound r8 run below supersedes the
performance gap; OS-level network observation, final packaging measurement,
complete license/NOTICE/SBOM approval, redistribution approval, and human
review remain open. The model-license conclusion remains
`NOASSERTION / LEGAL_REVIEW_REQUIRED`.

## Blind-evaluation readiness

The local harness originally enforced:

- at least 200 unique public or self-authored synthetic items per direction;
- candidate-anonymous HMAC randomization and a withheld private answer key;
- human-only structured review with no free-text notes (historical compatibility
  path, superseded for current Gate A quality evidence on 2026-07-26);
- duplicate, tamper, candidate-remap and privacy fail-closed checks;
- no source, reference or translated text in the summary report.

The v1 development summarizer remains available for old evidence. A new
`summarize-v2` path now derives the required v2 report only after it binds all
counted candidate/run identities to the same two raw
`phase7-gate-a-candidate-generation-v1` artifacts and M0 authorization used
by the cold runner. The binding also includes source-set identity/count and
private candidate-output/item-set hashes; v2 recomputes the reviewed item set
from the verified private answer key. Synthetic positive, candidate-remapping
and substituted-item-set negative tests pass.

The real `r3` inputs were assembled into a private ignored 400-item JSONL with
SHA-256
`c31c2a8d13da83dcab700b5566a982e7dac2826946c59e65b344d86a41d31123`.
The assembler independently verified both public generation artifacts, private
candidate-output hashes, source-set identities, item/source hashes,
candidate/run contracts, 200-item minima, provenance, privacy and phenomenon
coverage. The blind harness then prepared run `run-8bb927b09228c5bd`:
200 items per direction, one anonymous candidate per direction, initially 400
pending evaluations, randomization commitment
`6a993a6f320b02e1bd89abf427102c0edda60bdeaca93b362808b13848ff4977`
and manifest SHA-256
`31f1e898e1077c9a818c3cd54347372160868b46876b259ae0072ce0221e6a34`.
The private answer key remained withheld from the assessor while candidate
identity was not viewed.

The read-only `status` command first revalidated the real run on 2026-07-26 without
opening `private-answer-key.json` or emitting source, reference or candidate
text. It reported exactly `0` valid human reviews and `400` pending records,
with no score snapshot and no active lock. The static test also covers complete
snapshots and preserves the rule that a status inspection cannot authorize
integration, distribution or Gate A.

## AI quality-review replacement and completed 400-item result

On 2026-07-26 the user explicitly changed the frozen M4 acceptance contract:
AI item-level scoring formally replaces the 400 human reviews. The minimum
remains 200 unique items per direction. The new path emits
`phase7-ai-blind-eval-report-v1` and labels the assessor and every raw score as
AI; it emits no `humanReviewAttestation` and makes no human-preference claim.
The historical human-only harness remains available only for compatibility.

The AI assessor reviewed source, reference and anonymous candidate output for
all 400 records without viewing candidate identity. The compact decision
artifact was expanded into 400 raw AI score records and bound through the
private answer key to the exact r3 candidate generations. Structural binding
also exposed and fixed an old v2 audit mismatch: generation item-set hashes
include candidate ID and generation run ID, so the summarizer now recomputes
the same complete identity tuple instead of hashing only item/direction/source.

Formal ignored report:

- logical name: `report-0b1f18444433363e-ai-v1.json`;
- SHA-256:
  `24be0a34186621a47f90c818c0a8b25f4efc98b7ea291634dbf1b42bf4765624`;
- candidate binding set:
  `c349854382823f1782d3b455af62b515cda86d493bb189efbd38071c9a4741f6`;
- count: `400 AI reviewed / 0 pending`;
- en→zh: `191/200` acceptable (`95.5%`), adequacy mean `3.925`,
  fluency mean `3.025`;
- zh→en: `179/200` acceptable (`89.5%`), adequacy mean `3.835`,
  fluency mean `3.195`;
- no human attestation fields: verified count `0`.

This completes only the revised AI quality-review component. It does not
constitute legal approval, OS-level network proof, package authorization,
Gate A confirmation or permission to start M5.

## Legal-review preparation

The non-authorizing legal preparation command now binds:

- the exact candidate binding set
  `c349854382823f1782d3b455af62b515cda86d493bb189efbd38071c9a4741f6`;
- both candidate repositories/revisions and generation identities;
- all `12` verified supply files and supply tree
  `09f82c55a118449862441af825f21966ccb4cdfe22ffb1f941a5d6a7a28d1626`;
- both pinned MPL-2.0 repository license files;
- the actual seven-entry npm tarball, whose `package.json` declares MPL-2.0
  but whose tarball contains no license-like file; and
- the generation-bound core-pack sizing preparation receipt.

The ignored preparation artifact has SHA-256
`efc594385f657346a6e7ff064e930d8dd9c38afa9ea734098220e91a7a724cd1`.
Its status is fixed to `LEGAL_REVIEW_PREPARED_NOT_APPROVED`; commercial use,
model-weight scope, redistribution and release compliance remain
`NOT_ESTABLISHED`. It keeps these issues open:

- `MODEL_WEIGHT_LICENSE_SCOPE_REVIEW_REQUIRED`;
- `MPL_DISTRIBUTION_OBLIGATIONS_REVIEW_REQUIRED`;
- `NPM_TARBALL_LICENSE_FILE_MISSING`; and
- `ARCHIVED_MODEL_REPOSITORY_MAINTENANCE_RISK`.

The self-test verifies candidate/supply/tarball drift rejection and rejects a
premature approval claim. This packet reduces reviewer preparation work; it is
not legal advice or legal approval.

## OS-level network-capture readiness

`phase7-os-network-capture.ps1` now provides a read-only preflight and an
administrator-only collector. Capture mode requires an exact candidate binding
SHA-256, a repository-controlled Node/Electron workload, a new ignored output
directory, and the explicit isolated-clean-VM attestation. It snapshots all
Windows Firewall profiles, captures packet prefixes with `pktmon`, stops the
capture in `finally`, converts the ETL to private PCAPNG, verifies firewall
state did not change, and writes only a collection receipt.

Collection deliberately stops at
`OS_NETWORK_CAPTURE_COLLECTED_PENDING_MANUAL_ANALYSIS`: external-connection
count remains `null`, `osLevelVerified` remains false, and no
`phase7-gate-a-os-network-verification-v1` is created until the private capture
is independently analyzed and bound to the final primary evidence set.

The current desktop session is not elevated. The 2026-07-26 preflight found
`pktmon` installed and all Domain/Private/Public firewall profiles enabled, but
returned `ADMINISTRATOR_SESSION_REQUIRED`; it changed no system state and
performed no capture. The static test proves that the collector contains no
premature zero-external-traffic or Gate A PASS path.

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

- the candidate-bound v3 cold/PWS report is complete, but it is only one
  component of the Gate A input;
- the current quality artifact is the explicit
  `phase7-ai-blind-eval-report-v1` report with 400 item scores;
- matching `phase7-gate-a-candidate-generation-v1` artifacts and a prepared
  200×2 AI review batch and candidate-bound AI report exist; human scores are
  neither required by the revised frozen contract nor claimed;
- candidate-bound legal preparation exists but qualified approval remains
  absent; the fail-closed OS collector exists but the administrator clean-VM
  observation and manual capture analysis remain absent;
- exact base/core sizes and a generation-bound preparation receipt now exist,
  but the final package-sizing document still awaits the AI-report-derived
  primary evidence-set SHA-256.

Consequently M4 remains incomplete, Gate A input is not ready, Gate A has not
been crossed, and M5+ product integration remains unauthorized.

## Open blockers

1. Have a qualified legal/compliance owner review the prepared candidate-bound
   packet and resolve model-weight scope, attribution, NOTICE/SBOM and
   redistribution obligations; repository/package metadata is not commercial
   authorization.
2. Bind the completed 400-item AI report into the final Gate A evidence input;
   do not relabel it as human review.
3. After the AI report creates the primary evidence-set SHA-256, finalize
   the existing exact base/core sizing receipt into the cross-bound Gate A
   package-sizing document.
4. Run the prepared collector from an elevated isolated clean VM, manually
   analyze the private capture, and create the final primary-evidence-bound
   OS-network verification only if zero external traffic is actually observed.
5. Submit the complete cross-bound evidence to the user; only the user can
   confirm Gate A.

The repository-wide privacy scan currently also rejects preserved development
artifacts containing absolute local user paths. The hits are in old
electron-builder diagnostics, package logs and isolated Chromium user-data
diagnostics, not production source. Those artifacts remain evidence and were
not deleted; a Gate A evidence bundle must be freshly scoped and pass its own
zero-path/zero-content scan.
