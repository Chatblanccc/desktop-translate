# Phase 7 offline translation POC

This directory implements the evidence-gathering work authorized in Phase 7
M0. Download, conversion, and benchmark happen **before Gate A**. Gate A then
uses the completed measurements and license audit to choose or reject a model
route.

The authorization scope is exactly:

`POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION`

It permits an isolated experiment. It never permits production integration,
packaging, publication, redistribution, or commercial use. Gate A remains
`BLOCKED` throughout the POC. Default commands do not request network access
and download no weights. That control is not OS-level evidence: reports use
`externalNetworkAccess: "NOT_VERIFIED"` until firewall logging or packet
capture proves the runtime observation.

## Frozen candidates

| Route | Repository revision | Pinned source bytes | Weight-license conclusion |
| --- | --- | ---: | --- |
| Priority en→zh | `Helsinki-NLP/opus-mt-en-zh@408d9bc410a388e1d9aef112a2daba955b945255` | 315,321,723 | `NOASSERTION`; HF metadata says Apache-2.0 |
| Priority zh→en | `Helsinki-NLP/opus-mt-zh-en@cf109095479db38d6df799875e34039d4938aaa6` | 315,322,500 | `NOASSERTION`; HF metadata says CC-BY-4.0 |
| Comparison en↔zh | `facebook/m2m100_418M@55c2e61bbf05dfb8d7abccdc3fae6fc8512fd636` | 1,941,935,615 | `NOASSERTION`; HF metadata says MIT |

The metadata expressions are observations, not commercial authorization:

- Neither pinned OPUS Hugging Face repository contains a model `LICENSE` or
  `NOTICE`. Both cards point into Tatoeba-Challenge; its fixed upstream root
  [LICENSE](https://github.com/Helsinki-NLP/Tatoeba-Challenge/blob/480fcbe0ee1bf4774bcbe6226ad9f58e63f6c535/LICENSE)
  is CC-BY-NC-SA-4.0, conflicting with the HF metadata tags. Which terms apply
  to the checkpoint weights is unresolved.
- The pinned M2M100 Hugging Face repository also has no model license file.
  Fairseq's fixed root
  [MIT license](https://github.com/facebookresearch/fairseq/blob/3d262bb25690e4eb2e7d3c1309b1e9c406ca4b99/LICENSE)
  is evidence to review, but its coverage of this checkpoint has not been
  established.
- All three snapshots use pickle `pytorch_model.bin` weights. Conversion stays
  isolated and always uses `trust_remote_code=False`.

Therefore `WEIGHT_LICENSE_SCOPE_UNRESOLVED` blocks integration and
distribution. It does not prevent M0-authorized research measurements.

The inference runtime itself is CTranslate2 `v4.8.1`, source commit
`0d8bcd362ac75ef860ef161d6f0efad0ae439ff0`, MIT. Its Windows CPython
3.13 wheel is pinned to SHA-256
`d52499f05a60a791aeadee28d609efa130142f376d1ea76b2b1c593bb01f8827`.
The core license is confirmed; a transitive wheel lock, local license bundle,
and CycloneDX SBOM are still required before any product decision.

## Safe commands available now

Frozen local audit, no network:

```powershell
node tooling/phase7-offline-poc/audit.mjs
```

Windows/Python/CPU preflight, no installation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tooling/phase7-offline-poc/preflight.ps1
```

Download plans, no writes and no network:

```powershell
node tooling/phase7-offline-poc/prepare.mjs --candidate-set marian-opus-zh-en-bidirectional
node tooling/phase7-offline-poc/prepare.mjs --candidate m2m100-418m
```

All static/schema and no-model harness tests:

```powershell
node tooling/phase7-offline-poc/selftest.mjs
```

These tests validate fail-closed control flow, schemas, aggregate calculations,
timeouts, and privacy guards. They do not claim a model was loaded, a
translation ran, runtime performance was measured, or external network absence
was observed.

Optional metadata-only drift check:

```powershell
node tooling/phase7-offline-poc/audit.mjs --refresh-remote --allow-network
```

Both remote-audit flags are required. This reads official metadata JSON only,
does not alter `candidates.json`, and never downloads weights.

## Record the existing M0 POC authorization

Create a **pending** research-authorization template under ignored artifacts:

```powershell
node tooling/phase7-offline-poc/prepare.mjs --candidate opus-mt-en-zh `
  --authorization-template artifacts/phase7/offline-poc/authorizations/opus-en-zh.json
```

The command does not create an approved record. To execute the already
authorized M0 research, bind that authorization to the canonical manifest
SHA-256 and exact candidate set by recording:

- `authorization: "AUTHORIZED_FOR_POC_RESEARCH_ONLY"`
- `basis: "PHASE7_M0_USER_AUTHORIZATION"`
- a non-placeholder `authorizationRecordId`
- a real `authorizedAt`

The listed risk codes are acknowledged as unresolved research risks, not
accepted licenses. A stale or differently scoped authorization is rejected.

## Gate-A-before integration, POC-before Gate A

With the research-only record, explicitly allow the first large network action:

```powershell
node tooling/phase7-offline-poc/prepare.mjs --candidate opus-mt-en-zh `
  --download --allow-network `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/opus-en-zh.json
```

The downloader streams into ignored `artifacts/`, verifies exact size and
digest, never sends credentials, and never overwrites a mismatched file.

Provision an isolated CPython 3.13 environment whose top-level versions match
`candidates.json`. Installation is intentionally not automated because the
transitive lock and SBOM are unfinished. The 2026-07-23 preflight found
Transformers 4.57.3 and Torch 2.9.1, but not CTranslate2 4.8.1,
SentencePiece 0.2.1, or sacreBLEU 2.5.1.

Convert one verified snapshot to CTranslate2 INT8:

```powershell
python -B tooling/phase7-offline-poc/convert.py `
  --candidate opus-mt-en-zh `
  --source-dir artifacts/phase7/offline-poc/sources/opus-mt-en-zh/408d9bc410a388e1d9aef112a2daba955b945255 `
  --output-dir artifacts/phase7/offline-poc/converted/opus-mt-en-zh-int8 `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/opus-en-zh.json
```

Collect a partial single-process cold observation, first translation, warm
p50/p95, throughput, process memory, chrF2++, non-empty output, and
digit/URL/placeholder preservation:

```powershell
python -B tooling/phase7-offline-poc/benchmark.py `
  --candidate opus-mt-en-zh `
  --model-dir artifacts/phase7/offline-poc/converted/opus-mt-en-zh-int8 `
  --tokenizer-dir artifacts/phase7/offline-poc/sources/opus-mt-en-zh/408d9bc410a388e1d9aef112a2daba955b945255 `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/opus-en-zh.json `
  --iterations 3 `
  --route-timeout-seconds 180 `
  --output artifacts/phase7/offline-poc/measurements/opus-mt-en-zh.json
```

Each direction runs in a child process with a hard route timeout. Measurement
JSON emits IDs and aggregate metrics, not source/reference/output text,
usernames, PIDs, or absolute paths. The process-level socket guard is not
OS-level proof; later evidence still needs firewall or packet capture,
bilingual human review, representative Windows hardware, and packaging/SBOM
checks.

The current benchmark can only emit `PARTIAL_M4_MEASUREMENT` and
`GATE_A_INPUT_INCOMPLETE`. It cannot emit `MEASURED_GATE_A_INPUT`.
`GATE_A_INPUT_READY` is allowed only when the completeness evaluator receives
all of the following:

- complete model/runtime/license/redistribution identity and installer/core
  pack sizing;
- attached raw results;
- at least 20 fresh-process cold trials per direction with p50/p95/max and
  failures;
- warm p50/p95/max and failures per direction;
- Windows **Private Working Set** evidence with tool, device, samples, and peak;
- at least 200 human blind reviews per direction, including raw scores and
  severe-error classification.

Only that complete report may be submitted for the user's Gate A choice. The
current small synthetic fixture, one cold observation, RSS/process-memory
fields, and non-human quality checks remain insufficient. Even a future
quality/performance winner remains blocked from integration and distribution
while `WEIGHT_LICENSE_SCOPE_UNRESOLVED` is open.

`gate-a-completeness.mjs` is a **non-authorizing raw-artifact reader**. It
accepts only exact raw bytes paired with their SHA-256 values, then derives
cold-trial count, successful/failed attempts, warm failures, Private Working
Set samples, normal exit, residual cleanup, forced cleanup, and
human-blind-review counts from known schemas. It also hashes the supplied
runner, native helper, Electron main/library/renderer sources, candidate-binding
helper and the raw POC authorization record. Their individual digests and canonical six-file-set
digest must match the identities emitted by the raw measurement. The reader
recomputes every logical sample's per-process PWS sum, peak, cadence, span,
query skew, coverage, discarded count, pre/post Job membership, Job
lifetime/active counts, bounded transition episodes, reserve-adjusted 1.1-GiB
budget status, final `Known == Total` history, completion-marker binding, and
cleanup result; producer summary fields cannot replace those records.
Convenience flags such as `candidateIdentityComplete`,
`artifactSizingComplete`, and `rawResultsAttached` are ignored.

The cross-bound input contract uses the formal producer versions below:

- formal cold/PWS must use `phase7-offline-cold-pws-v3`;
- the human report must use `phase7-blind-eval-report-v2`;
- each direction must attach one
  `phase7-gate-a-candidate-generation-v1` raw artifact matching the exact
  candidate, generation run, candidate manifest, M0 authorization, model tree,
  materialized/served runtime trees, fixed cold workload identity and
  minimum-200-item source-set identity;
- cold, blind and generation artifacts must contain the same two-direction
  candidate binding set. Missing, duplicate, remapped, stale-schema or
  hash-rewritten bindings fail closed;
- each binding also carries the source-set identity/count, private candidate
  output hash and item-identity-set hash. Blind v2 recomputes the latter from
  the already-verified private answer key, so reviews of a substituted item
  set cannot satisfy the generation evidence;
- a valid M0 authorization must cover exactly that manifest and candidate set;
- legal/NOTICE/SBOM review, an attached OS-level Windows firewall plus packet
  capture record, and final base-installer/core-pack sizing must bind to the
  same primary evidence-set SHA-256. The size reader enforces 150-MiB base and
  400-MiB core hard limits and derives the over-300-MiB custom-path decision.

The document schemas are in
`schemas/gate-a-cross-bound-evidence.schema.json`. A complete structural set
returns `GATE_A_INPUT_READY` only as
`NON_AUTHORIZING_EVIDENCE_INPUT_COMPLETE`, with
`AWAITING_EXPLICIT_USER_DECISION` and
`integrationOrDistributionAuthorized: false`. It never records the user's
Gate A choice and never authorizes M5, packaging or redistribution.

All currently recorded development artifacts remain ineligible: the preserved
cold/PWS artifacts are v2, the preserved blind report is v1, and no formal
20-by-2 candidate-matched run or 200-by-2 human report exists. The current
runner emits v3 only after validating two exact candidate-generation
artifacts; `summarize-v2` similarly binds the human score report to those same
artifacts. Neither bridge creates the missing candidate generations, human
reviews, legal approval, OS-level network capture, or final package-size
evidence. The positive completeness self-test uses only in-memory, explicitly
synthetic fixtures; it writes no authorization, measurement, legal, network
or size evidence.

Do not add downloaded wheels, weights, converted models, authorization records,
or measurements to Git. Their default locations are already ignored under
`.tools/` and `artifacts/`.

## Firefox/Bergamot Gate A track

The archived `mozilla/firefox-translations-models` Git LFS links are not used
for model downloads: their media redirects currently return `404`. The
candidate manifest instead uses immutable generation-pinned objects from
Mozilla's official successor Google Cloud Storage bucket. Every recovered
object must still match the exact archived size and SHA-256 pin before it can
be materialized or executed.

The separate `bergamot-candidates.json` track pins the archived
`mozilla/firefox-translations-models` revision
`e7957fc407441a5e3e35bbcbf9d60d9b35764618` for both en→zh and zh→en.
Its 76,038,846 compressed model bytes and every individual model, vocabulary,
shortlist, metadata, and license file have exact size and SHA-256 pins.

The official BrowserMT runtime is pinned as
`@browsermt/bergamot-translator@0.4.9`. Its npm tarball is 1,852,075 bytes with
SHA-256
`9011be93222d839d7448ffdf00549d53ce8f541fd782ffc79779d1756397c41f`.
The unmodified package remains blocked on the current Node 23.11.1 path:
its worker is interpreted as ESM and calls `require`, producing the sanitized
blocker `NODE_ESM_WORKER_REQUIRE_UNDEFINED`. That result is specific to the
package's Node compatibility branch. The Electron/Chromium POC below exercises
the package's native browser Worker branch without patching the package.

Safe default plan, no writes or network:

```powershell
node tooling/phase7-offline-poc/bergamot-prepare.mjs
```

Create a pending authorization template:

```powershell
node tooling/phase7-offline-poc/bergamot-prepare.mjs `
  --authorization-template artifacts/phase7/offline-poc/authorizations/bergamot.json
```

After recording the existing M0 research authorization, a runtime-only
download or the full model download still requires both explicit network flags:

```powershell
node tooling/phase7-offline-poc/bergamot-prepare.mjs `
  --runtime-only --download --allow-network `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/bergamot.json
```

Verify already materialized supply artifacts without network:

```powershell
node tooling/phase7-offline-poc/bergamot-prepare.mjs `
  --runtime-only --verify
```

The runtime spike and benchmark remain research-only and authorization-bound:

```powershell
node tooling/phase7-offline-poc/bergamot-runtime-spike.mjs `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/bergamot.json `
  --output artifacts/phase7/offline-poc/measurements/bergamot-runtime-spike.json

node tooling/phase7-offline-poc/bergamot-benchmark.mjs `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/bergamot.json `
  --output artifacts/phase7/offline-poc/measurements/bergamot-benchmark.json
```

Static Electron harness self-test:

```powershell
node tooling/phase7-offline-poc/bergamot-electron-poc-selftest.mjs
node tooling/phase7-offline-poc/bergamot-cold-pws-selftest.mjs
```

Run the research-only BrowserMT compatibility POC with the repository's pinned
Electron:

```powershell
pnpm exec electron tooling/phase7-offline-poc/bergamot-electron-poc.mjs `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/bergamot.json `
  --output artifacts/phase7/offline-poc/measurements/bergamot-electron-poc.json
```

This command verifies the canonical manifest, bound M0 authorization, complete
model/runtime supply tree, and materialized unmodified npm package before
starting Chromium. It then:

- creates a hidden sandboxed `BrowserWindow` with Node integration disabled;
- binds a minimal HTTP server only to IPv4 `127.0.0.1`;
- gives every run a random 256-bit URL path prefix and exact path allowlist;
- applies CSP, COEP, COOP, same-origin resource policy, and permission,
  navigation, redirect, popup, download, and external-request denial;
- verifies each compressed model part's size and SHA-256 again in the renderer;
- waits for `translator.delete()` and a renderer cleanup handshake for both
  directions, then destroys the window, clears session state, closes session
  connections, and closes the loopback server;
- emits only statuses, character lengths, hashes, timings, and aggregate
  diagnostics. Source and translated text are never emitted.

For one fresh-process direction trial, add exactly one route:

```powershell
pnpm exec electron tooling/phase7-offline-poc/bergamot-electron-poc.mjs `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/bergamot.json `
  --direction en-zh `
  --output artifacts/phase7/offline-poc/measurements/bergamot-electron-en-zh.json
```

`--direction` accepts only `en-zh` or `zh-en`. Such a process loads one model,
performs one cold first translation, then the manifest-frozen five same-route
warm translations. The report keeps cold `firstTranslationMs` separate from
warm translation-only observations. Warm observations contain only elapsed
milliseconds, character counts, and SHA-256 values; they do not contain source
or translated text. Omitting `--direction` retains the two-route compatibility
mode and is not a cold-trial substitute.

For the fixed self-authored Gate A source set, create both direction files
under the ignored artifact root:

```powershell
node tooling/phase7-offline-poc/create-gate-a-dataset.mjs `
  --snapshot-id phase7-self-authored-20260725-v2 `
  --en-zh-output artifacts/phase7/offline-poc/gate-a/source-en-zh.json `
  --zh-en-output artifacts/phase7/offline-poc/gate-a/source-zh-en.json
```

The dataset contains exactly 200 unique items per direction and real
`proper-noun` and `long-sentence` coverage. Run each direction with all four
generation arguments to create a private candidate-output artifact plus a
text-free `phase7-gate-a-candidate-generation-v1` binding. Candidate
generation uses the same loaded model only after the fixed cold and five-warm
workload; the generation task mode is deliberately excluded from that fixed
workload identity.

After both directions exist, create the human-review input without copying
text to stdout:

```powershell
node tooling/phase7-offline-poc/assemble-blind-eval-input.mjs `
  --dataset-en-zh artifacts/phase7/offline-poc/gate-a/source-en-zh.json `
  --dataset-zh-en artifacts/phase7/offline-poc/gate-a/source-zh-en.json `
  --candidate-output-en-zh artifacts/phase7/offline-poc/gate-a/private/bergamot-en-zh.json `
  --candidate-output-zh-en artifacts/phase7/offline-poc/gate-a/private/bergamot-zh-en.json `
  --generation-en-zh artifacts/phase7/offline-poc/gate-a/generation-en-zh.json `
  --generation-zh-en artifacts/phase7/offline-poc/gate-a/generation-zh-en.json `
  --output artifacts/phase7/offline-poc/blind-eval-input/m4-bergamot.jsonl
```

The assembler recomputes raw artifact, source-set, item-set, candidate,
generation-run and per-item source hashes, then invokes the blind harness's
full 200-per-direction, provenance, phenomenon-coverage and privacy
validation. Its output remains private and ignored. Its summary contains only
counts, IDs and hashes and always records `humanReviewStatus=NOT_STARTED`.

The Windows fresh-process runner defaults to 20 independent Electron processes
per direction and writes only under the ignored Phase 7 artifact root:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File tooling/phase7-offline-poc/bergamot-cold-pws-runner.ps1 `
  -PocAuthorizationPath artifacts/phase7/offline-poc/authorizations/bergamot.json `
  -CandidateGenerationEnZhPath artifacts/phase7/offline-poc/gate-a/generation-en-zh.json `
  -CandidateGenerationZhEnPath artifacts/phase7/offline-poc/gate-a/generation-zh-en.json `
  -TrialsPerDirection 20 `
  -SampleIntervalMilliseconds 100 `
  -OutputPath artifacts/phase7/offline-poc/measurements/bergamot-cold-pws-formal-20260723.json
```

The formal command must use a new output filename. The runner uses Windows
`CREATE_NEW`, rejects an existing file, symlink, hardlink, reparse parent, or
final-path mismatch, and never overwrites prior evidence. Use
`-TrialsPerDirection 1` only for a development smoke.

The runner creates the repository-fixed Electron executable suspended, assigns
it to a non-breakaway Job with `KILL_ON_JOB_CLOSE`, and only then resumes its
primary thread. This removes the launch-before-observation window. Every Job
member must resolve to a file in the pre-hashed Electron `dist` tree. Its PID
and creation time remain internal; the report retains only an anonymous
process ordinal and executable SHA-256.

Before assignment, the runner also associates a private Windows I/O completion
port with the Job and starts a bounded notification watcher. Every
`JOB_OBJECT_MSG_NEW_PROCESS` is opened immediately, creation-time/path/Job
membership bound, and added to a concurrent lifetime identity set. This
preserves the identity of a process that starts and exits entirely between two
100 ms PWS samples. A watcher, completion-key, process-open, identity, path or
Job-binding failure remains fail-closed. Polling snapshots still define each
PWS sample; completion notifications only close the lifetime-history gap and
cannot substitute for per-sample `QueryWorkingSet`.

Each approximately 100 ms logical sample freezes current Job membership and
queries each member sequentially with Windows `QueryWorkingSet`. The same
native process handle is checked for active state and exact creation time both
before and after QWS, and `IsProcessInJob` must remain true on that handle.
Windows can temporarily return an incomplete or header-inconsistent
`JOBOBJECT_BASIC_PROCESS_ID_LIST`. Such a result is never interpreted as an
empty Job. Recovery is permitted only when all identities ever seen in a
complete list exactly equal `BasicAccounting.TotalProcesses`, their currently
active same-handle/creation-time/Job-bound subset exactly equals the reported
`ActiveProcesses`, pre/post accounting is stable, and the exact active identity
set is unchanged after all PWS queries. Reports label this ordinary recovery
`ACCOUNTING_BOUND_KNOWN_IDENTITIES` or
`HEADER_INCONSISTENT_ACCOUNTING_BOUND`. Only pages whose working-set `Shared`
bit is clear are summed.

Windows Job accounting can also lag after a bound process exits. That state is
a complete PWS sample, not a sampling gap, only when `Known == Total`, two Job
accounting reads are stable, two independent enumerations of every known
identity produce the same exact active set, every active handle still has the
expected creation time and Job membership and a verified executable path, and
reported accounting active is strictly greater than actual active. The report
labels this discovery `EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES` and records
actual active and reported accounting active separately. The exited known
identities contribute zero; QWS is required to complete for every member of the
full actual-active set, and the pre/post active ordinal sets must remain equal.
An unknown identity, active-set change, Job/path failure, QWS failure, or
reported-active value less than or equal to actual active fails this recovery.

A normal Electron member start/exit is not relabeled as a zero-member discard.
It is recorded separately as
`VERIFIED_MEMBERSHIP_TRANSITION_GAP` only when either (a) the pre/post
snapshots each have complete accounting/history and their anonymous exact
active-identity ordinal sets differ, or (b) `KnownProcessIdentities ==
TotalProcesses`, accounting is stable, no unknown child can have appeared, and
the same-handle bound-active subset is below `ActiveProcesses` while a bound
process exit is being reflected but the complete double-enumeration recovery
could not be recorded. Case (b) is a failure-recovery fallback only. The raw
sample records which proof applied and all pre/post or accounting counts. A QWS
failure is accepted inside that exit-only fallback only when its ordinal is
absent from the re-opened,
same-handle/creation-time, Job-bound active set and its status proves the
process became inactive; every remaining active record is re-bound to the
pre-hashed Electron distribution. Every other membership, identity, Job query,
or QWS failure remains an unverified discard and fails the trial.

The direction child also creates a unique warm-complete marker after the fixed
five warm translations. Its hashed identity/timing binding must match the final
child report. The runner stops PWS sampling at that marker, but still requires
the bound final report, normal exit, three zero-member Job polls, and empty
handle cleanup. An early, malformed, reused, or mismatched marker cannot make a
trial pass.

Each raw logical sample records start, end, span, membership-query duration,
discovery/revalidation mode, Job lifetime count, actual active count, reported
accounting active count, anonymous per-process query timing/status, and maximum
query skew.

At the default configuration a trial requires at least 10 complete PWS samples
and 1,000 ms valid coverage; launch-to-first-sample, raw sampling cadence, and
maximum logical-sample span must each be at most 250 ms; maximum per-process
query skew within one logical sample is also capped at 250 ms. A trial may
contain at most eight verified transition samples, every transition episode
must be bounded by complete PWS samples, and a real exact membership-set change
keeps the 500 ms maximum adjacent-complete-sample start gap. Only the
failure-recovery exit-accounting fallback may have at most 1,250 ms between
adjacent complete sample starts, including the preceding sample's allowed
250 ms span; a successfully recovered
`EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES` sample consumes neither limit.
The sum of all uncovered episode durations remains 1,000 ms. Reports list each
episode's reasons, duration, and sample count and label such evidence
`BOUNDED_TRANSITION_GAPS_NOT_CONTINUOUS`.

The frozen Private Working Set ceiling remains 1.1 GiB
(1,181,116,006 bytes). With any verified transition gap, a peak at or below
1.0 GiB (1,073,741,824 bytes) is
`PASS_WITH_TRANSITION_RESERVE`; a peak above 1.0 GiB through 1.1 GiB is
`INCONCLUSIVE_TRANSITION_GAP_NEAR_BUDGET`, and a peak above 1.1 GiB fails.
Without a transition, a peak at or below 1.1 GiB is
`PASS_CONTINUOUS_SAMPLING`. One unverified discard, one non-transition
identity/query failure, an incomplete final `Known == Total` history, or one
forced Job termination makes the trial fail. Electron `app.getAppMetrics()`,
`privateBytes`, and ordinary working set are explicitly ineligible substitutes.

The aggregate contains per-direction N/p50/p95/max and failure counts for cold
first translation, fresh-process wall time, Private Working Set peak, and all
warm translation-only observations. Per-trial records contain timings,
lengths, hashes, sampling counts, cleanup status, and failure codes, but no
PID, executable path, command line, username, source, or translation. Normal
exit must be followed by three consecutive zero-member Job polls and all Job
handles must close from an empty state. Timeout cleanup terminates the complete
Job and is counted as non-passing. Child stdout/stderr are redirected to
bounded `CREATE_NEW` files, never unbounded pipes, and are read with byte and
deadline limits.

The preceding diagnostic smoke is the ignored artifact
`bergamot-cold-pws-smoke-v2-exit-only-proof-20260723-r2.json`. Its zh→en trial
completed. Its en→zh trial validated normal exit and cleanup and measured a
999,395,328-byte peak, but remained `BLOCKED`: one real exact-set transition
plus ten otherwise fully bound exit-accounting-lag observations produced 11
transition samples (limit 8) and 1,241.619 ms total uncovered duration (limit
1,000 ms). Those ten observations had no discarded sample and every surviving
active record was Job/path bound; they exposed that stable accounting lag was
being classified as a gap before the complete recovery above existed. The
artifact is unchanged and diagnostic only, not formal Gate A evidence.

After the complete recovery source change, one new two-direction development
smoke was written to the ignored artifact
`bergamot-cold-pws-smoke-v2-complete-recovery-20260723-r1.json` (SHA-256
`11ded84c05a44ad4553f68fcc34d7dee7b25838625daf5ee0be015749ff9abc6`).
The en→zh trial had 51 continuous complete samples, zero discarded samples,
zero measurement failures, normal exit, zero forced cleanup, zero residual
processes, and a 997,875,712-byte PWS peak. The zh→en trial had 56 complete
samples plus one 189.809 ms exact active-set transition gap, zero discarded
samples, zero measurement failures, normal exit, zero forced cleanup, zero
residual processes, and a 1,015,906,304-byte PWS peak. The first trial was
`PASS_CONTINUOUS_SAMPLING`; the second was
`PASS_WITH_TRANSITION_RESERVE`. This run did not encounter the new
`EXIT_ACCOUNTING_LAG_BOUND_ACTIVE_IDENTITIES` discovery mode, so it is only a
no-regression development smoke; the native/static positive and negative
fixtures remain the evidence for that branch. No 20-by-2 formal run was
executed.

The first successful Windows compatibility run completed one en→zh and one
zh→en first translation in 4,880.465 ms total. The per-direction first-call
times, including local model fetch/decompression/load, were 2,171.950 ms and
2,485.205 ms. All 16 Chromium requests matched both the session allowlist and
the loopback server allowlist; no external or unknown-loopback request was
observed. This is a single-run compatibility result, not Gate A evidence.

`electronMemoryDiagnostics` uses Electron's `app.getAppMetrics()` values in
KiB. It is explicitly marked `gateAEligible: false`: `privateBytes` is private
commit and working-set values include shared pages. Gate A still requires an
external, PID-and-creation-time-bound Windows `QueryWorkingSet` private-page
measurement and 20 fresh-process cold trials per direction. A zero external
request counter is also not independent firewall or packet-capture evidence,
and in-process cleanup cannot prove post-exit residual-process count.

Even a clean 20-by-2 runner report remains
`PARTIAL_M4_COLD_PWS_EVIDENCE_COMPLETE`, with Gate A `INCOMPLETE`: OS-level
firewall or packet-capture evidence, 200 human blind evaluations per direction,
legal review, and core/model-pack sizing are separate required inputs.

Model-weight license scope, MPL distribution obligations, the runtime tarball's
missing license file, maintenance of the archived model repository, 200 human
blind evaluations per direction, formal Windows PWS, and final core-pack sizing
all remain Gate A blockers. This POC does not authorize product integration,
packaging, redistribution, or commercial use.

## Argos direct CTranslate2 comparison track

This is a separate research-only comparison candidate. It does not install or
import the `argostranslate` package and it does not change the product provider
boundary. The direct POC uses only the package's `sentencepiece.model` and
CTranslate2 `model/` directory:

- canonical manifest SHA-256
  `627eb2b7ed1b9f50e10226f03e475587a30e00272a029d90eaa7132244a7d645`;
- Argos package index revision
  `ff90de60728f7c1338ff6b75974e4c89b2442d22`;
- Argos Translate source revision
  `c72ec9040a580bc5f9ad4272f2c8a685d9bc66dd`;
- `translate-en_zh-1_9.argosmodel`: 70,743,021 compressed bytes,
  85,640,765 unpacked bytes, SHA-256
  `433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab`;
- `translate-zh_en-1_9.argosmodel`: 74,481,402 compressed bytes,
  86,137,496 unpacked bytes, SHA-256
  `62e7af5a3a48b530e47b7b3e5c78c2de79073ecd815750d2bf3ab35b4a67da2d`;
- CTranslate2 4.8.1 CPython 3.13 Windows x64 wheel: 19,220,784
  bytes, SHA-256
  `d52499f05a60a791aeadee28d609efa130142f376d1ea76b2b1c593bb01f8827`;
- SentencePiece 0.2.1 CPython 3.13 Windows x64 wheel: 1,054,669
  bytes, SHA-256
  `10ed3dab2044c47f7a2e7b4969b0c430420cdd45735d78c8f853191fa0e3148b`;
- CPython 3.13.10 Windows x64 embeddable distribution: 10,924,998
  bytes, SHA-256
  `e0780912ee37496035bfc81120cc18a0d93921842012d5e83a71b42110452965`;
- NumPy 2.2.6, PyYAML 6.0.3, and setuptools 80.9.0 wheels:
  13,966,461 bytes in total, with every filename, size, hash, and source URL
  pinned in the manifest.

The two archives total 145,224,423 bytes (138.497 MiB) compressed and
171,778,261 bytes (163.821 MiB) unpacked. The complete eight-file POC supply
set is 190,391,335 download bytes (181.571 MiB). Controlled, network-free
materialization produces a 1,435-file isolated execution tree of 132,513,327
bytes (126.375 MiB), SHA-256
`161fdea29bd9910a7c9e33d64a8c733099bbdee0829e921adeb951c45268147c`.
These values are POC supply/runtime sizes, not final installer or model-pack
sizes.

The README embedded in each pinned package says that the original OPUS model
from which the packaged model derives is CC-BY-4.0. That statement is recorded
only as a package-README observation. It does **not** establish which terms
cover the complete Argos archive, converted weights, training data, or
commercial redistribution. The canonical conclusion therefore remains
`NOASSERTION` with `LEGAL_REVIEW_REQUIRED`; integration, packaging,
redistribution, and commercial-use conclusions remain blocked.

Static manifest, schema, ZIP-safety, privacy, and batch-contract verification:

```powershell
node tooling/phase7-offline-poc/argos-selftest.mjs
```

This test uses only a small generated ZIP fixture. It verifies central and
local ZIP header binding, flags, optional data descriptors, entry count,
unpacked size, exact-root paths, Windows case-insensitive collisions, Zip Slip,
reserved paths, symlink/special-file attributes, compression limits, CRC,
atomic materialization, post-materialization tree binding, and rejection after
an attacker rewrites both a model file and its receipt without changing the
manifest pin. The self-test itself downloads no archive or wheel, imports no
model runtime, executes no model, and creates no candidate-output artifact.

Default preparation is a zero-write, zero-network plan:

```powershell
node tooling/phase7-offline-poc/argos-prepare.mjs
```

Create a pending authorization record for the exact bidirectional download:

```powershell
node tooling/phase7-offline-poc/argos-prepare.mjs `
  --authorization-template artifacts/phase7/offline-poc/authorizations/argos-bidirectional.json
```

The pending template is not an approval. Recording the existing Phase 7 M0
research authorization still requires
`AUTHORIZED_FOR_POC_RESEARCH_ONLY`, a real record ID and timestamp, and exact
manifest/candidate/risk binding. Only then can the explicitly double-gated
network action run:

```powershell
node tooling/phase7-offline-poc/argos-prepare.mjs `
  --download --allow-network `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/argos-bidirectional.json
```

Both flags are mandatory. Redirects remain inside the exact `argos-net.com`
and `files.pythonhosted.org` host allowlist, response bytes stream into
`CREATE_NEW` partial files, and exact length/SHA-256 pins are checked before
atomic rename. A mismatched existing file is never overwritten. This command
downloads but does not install either wheel.

Verify already-downloaded bytes and ZIP structure without network:

```powershell
node tooling/phase7-offline-poc/argos-prepare.mjs --verify
```

Materialization is a separate authorization-bound, network-free action.
Materialize one direction at a time into a new ignored directory:

```powershell
node tooling/phase7-offline-poc/argos-prepare.mjs `
  --materialize --candidate argos-opus-en-zh-1.9 `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/argos-en-zh.json
```

The single-direction authorization must be created with the same `--candidate`
selection. The extractor accepts only the pinned archive digest, its exact
13-entry central directory, methods 0/8, and the manifest-frozen flag set. It
rejects encryption, ZIP64, multi-disk ZIPs, prefix/trailing bytes, local versus
central header drift, unbound data-descriptor bytes, path traversal, Windows
device names, case-fold collisions, reparse/symlink/special-file attributes,
overlapping data, oversized entries, and excessive compression ratios.
Extraction uses CRC-checked streams in a same-parent random stage directory,
verifies the pinned embedded `metadata.json` and `README.md`, writes a
file-by-file tree receipt, and atomically renames only after the complete tree
passes. Existing targets are never replaced.

The runtime builder does not invoke `pip`, import user/global site packages, or
access the network. It verifies the pinned local CPython ZIP and all five wheel
RECORD sets, rejects unsafe paths/links, removes 79 explicitly accounted test
or executable-`.pth` files, writes the isolated `_pth` policy, and emits a
complete file receipt before atomic publication. The direct runner rehashes
that execution tree and the separately pinned model tree before every run.
This is reproducible POC materialization, not redistribution approval: the
complete license/NOTICE/SBOM conclusion remains open, including legal review
of native files bundled in the CTranslate2 wheel.

After that isolated tree and one exact per-direction authorization exist, a
one-record smoke emits only lengths, hashes, capture counts, and statuses:

```powershell
& artifacts/phase7/offline-poc/argos/runtime/materialized/argos-cp313-win-x64-v1/python.exe `
  -I -B tooling/phase7-offline-poc/argos-direct-poc.py `
  --candidate argos-opus-en-zh-1.9 `
  --generation-run-id argos-en-zh-smoke-001 `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/argos-en-zh.json
```

The direct boundary runs SentencePiece encode, then
`CTranslate2.Translator.translate_batch` with `beam_size=4`,
`replace_unknowns=true`, and `length_penalty=0.2`, then SentencePiece decode.
It installs a process-level socket guard before importing the runtime. That
guard is defense in depth, not OS-level proof of no network access.
Process standard handles are redirected and drained with a one-MiB limit while
runtime import, model load, and translation execute. Only stdout/stderr byte
counts are published; captured bytes are discarded. This does not capture
independent child processes and is not the formal Windows Job/PWS or OS-level
network boundary.

On 2026-07-23, one built-in development smoke completed per direction against
the pinned runtime and materialized trees. en→zh produced one 7-character
result and zh→en one 16-character result; only aggregate hashes and lengths
were emitted. Both captured stdout and stderr byte counts were zero. This is
`1×2` compatibility evidence only: no quality PASS, latency/PWS distribution,
OS-level network proof, or Gate A readiness is claimed.

For controlled blind-evaluation generation, input must be JSON or JSONL below
`artifacts/phase7/offline-poc/blind-eval-input/`. Every item uses
`phase7-argos-generation-input-item-v1`, declares public/self-authored
evaluation use, contains no personal/user-history/clipboard/private-corpus
material, and is limited to 12,000 characters, 48,000 UTF-8 bytes, and 4,096
SentencePiece tokens. Duplicate IDs/sources, privacy patterns, mixed
directions, more than 1,000 items, or more than 4,000,000 total source
characters fail closed.

```powershell
& artifacts/phase7/offline-poc/argos/runtime/materialized/argos-cp313-win-x64-v1/python.exe `
  -I -B tooling/phase7-offline-poc/argos-direct-poc.py `
  --candidate argos-opus-en-zh-1.9 `
  --generation-run-id argos-en-zh-blind-001 `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/argos-en-zh.json `
  --input artifacts/phase7/offline-poc/blind-eval-input/en-zh.jsonl `
  --output-dir artifacts/phase7/offline-poc/argos/generations/argos-en-zh-blind-001
```

The reusable runtime function is `translate_batch_direct`. Candidate and
`generationRunId` are bound on every output item. Standard output and the run
manifest contain no source or translation text. The only translation-bearing
file is the explicitly requested private
`candidate-output.jsonl` inside the new ignored generation directory; it never
echoes source text and is labelled for blind evaluation only. A built-in smoke
never writes full translation text anywhere.

The generated candidate file is a staging contract, not a completed human
evaluation. It must still be joined with eligible source/reference/provenance
records and the other anonymous candidates before the existing blind harness
can randomize identity. No automated score is produced, and the requirement
for at least 200 independent human-reviewed items per direction is unchanged.

This direct route also bypasses Argos/Stanza sentence-boundary behavior, so its
quality is not assumed to equal the full Argos library. Model-package legal
review, complete license/NOTICE/SBOM approval, bidirectional quality, formal
fresh-process PWS, OS-level network evidence, signing, and final pack sizing
all remain open Gate A inputs.

## Human blind-evaluation harness

The separate [blind-evaluation guide](blind-eval-README.md) defines the
research-only `prepare`, interactive `review`, and audited `summarize` flow.
It requires at least 200 unique public or self-authored synthetic items in
each direction, randomizes candidate identity with a private HMAC answer key,
rejects duplicate or non-human scores, and reports structured aggregates
without source, reference, translated text, paths, usernames, or free-form
notes.

Static verification:

```powershell
node tooling/phase7-offline-poc/blind-eval-selftest.mjs
```

Candidate-generation cross-binding static verification:

```powershell
node tooling/phase7-offline-poc/gate-a-candidate-bindings-selftest.mjs
```

The self-tests do not run a model or a human review. A real v2
blind-evaluation report remains unavailable until an eligible
200-item-per-direction dataset, two matching
`phase7-gate-a-candidate-generation-v1` artifacts, candidate outputs, and
independent bilingual reviewers exist. Even a complete quality component
deliberately leaves the overall Gate A input incomplete until the other M4
evidence and the user's decision are present.

## Controlled QVAC/Bare alternative

`qvac-runtime-candidate.json` records a separate alternative; it does not
replace or erase the BrowserMT failure:

- `@qvac/translation-nmtcpp@8.1.0`, source commit
  `dfd1fd7eb0e1e3da70b68d5c8c2cca0c5c8875a7`, declares Apache-2.0 and includes
  pinned `LICENSE` and `NOTICE` files.
- Its npm tarball is 177,006,150 compressed bytes and 546,237,344 unpacked
  bytes, SHA-256
  `fd05f5ebdd97872e89d35086e47cf72be0dfafb866562eac8db979b1b1511c86`.
- The Windows x64 native addon is 96,493,056 bytes, SHA-256
  `8a058f85166574b08ac8d89847a2fb6a1fd8f36c2b96400309c6bc67269cf3b9`,
  and is not Authenticode signed.
- The package requires Bare `>=1.19.0`. The controlled probe pins Bare
  `1.30.3` and its Windows x64 executable SHA-256
  `61d7f0d40cbc061f657b126d2deb3a74e38ed46cd73f86da0163d7e613ec3962`.
- Bare package/platform source revisions, their npm tarball size/SHA-256, and
  pinned local license evidence have not been verified. The pinned
  `bare.exe` is also not Authenticode signed.
- Direct Node 23.11.1 import fails with `BARE_GLOBAL_NOT_DEFINED`. Bare 1.30.3
  was previously observed importing the package and constructing an unloaded
  Bergamot object, but that observation was not bound to an exact verified
  dependency tree. It is historical diagnostic context, not eligible runtime
  evidence. No real model load or first translation has run.

Offline static audit:

```powershell
node tooling/phase7-offline-poc/qvac-runtime-audit.mjs
```

Create a pending QVAC authorization template bound to the exact canonical
manifest SHA, candidate ID, observed license metadata, and complete blocker
set:

```powershell
node tooling/phase7-offline-poc/qvac-runtime-audit.mjs `
  --authorization-template artifacts/phase7/offline-poc/authorizations/qvac.json
```

As with the other M0 records, the template must be changed to
`AUTHORIZED_FOR_POC_RESEARCH_ONLY` with a real record ID and timestamp before
any future probe is eligible.

If the ignored probe supply already exists, verify the pinned tarball, license,
notice, Windows prebuilds, and Bare executable:

```powershell
node tooling/phase7-offline-poc/qvac-runtime-audit.mjs `
  --verify-artifacts artifacts/phase7/offline-poc/qvac-probe
```

The controlled probe contract only measures process launch, import, and
constructor behavior. It neither loads weights nor translates text. It
requires the bound M0 authorization:

```powershell
node tooling/phase7-offline-poc/qvac-runtime-probe.mjs `
  --probe-root artifacts/phase7/offline-poc/qvac-probe `
  --poc-authorization artifacts/phase7/offline-poc/authorizations/qvac.json `
  --acknowledge-poc-scope POC_RESEARCH_ONLY_NO_INTEGRATION_OR_DISTRIBUTION `
  --output artifacts/phase7/offline-poc/measurements/qvac-runtime-probe.json
```

This command currently fails closed with
`QVAC_RUNTIME_EXECUTION_TREE_NOT_BOUND` before launching Node or Bare because
`runtime/node_modules` has not been proven to be an exact verified dependency
tree. A future manifest revision must pin and verify that complete tree before
setting `probeExecutionAllowed: true`; an authorization alone cannot bypass
this blocker. Any older ignored measurement whose manifest SHA differs, lacks
the bound authorization record, or omits the explicit network-verification
status is stale diagnostic material and must not be reused as current evidence.

QVAC accepts materialized `.bin` models and `.spm` vocabularies, not the
repository's `.gz` files. Its bundled helper also asks for nonexistent
`srcvocab.zhen.spm` and `trgvocab.zhen.spm`; the controlled zh→en route must
bypass that helper and pass the pinned `vocab.zhen.spm` as both source and
target vocabulary. The helper is forbidden because it can access Firefox
Remote Settings and does not enforce this POC's fixed file hashes.

Gate A remains blocked by the Bare-sidecar product boundary, unverified runtime
tree, incomplete Bare provenance/license/tarball evidence, incomplete
transitive lock/SBOM, unsigned Bare executable and native addon, package size,
very recent runtime release, zh→en helper mismatch, `.gz` materialization,
unresolved shortlist contract, model license review, and missing real
bidirectional benchmark.
