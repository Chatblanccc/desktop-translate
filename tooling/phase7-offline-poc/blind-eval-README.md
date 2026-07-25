# Phase 7 human blind evaluation harness

This harness prepares and audits the human-only quality evidence required by
M4. It does not run a translation model, download data, score automatically,
or make the Gate A decision.

## Non-negotiable data boundary

Input is JSONL and every item must be one of:

- `PUBLIC_DATASET`: a versioned public dataset with an HTTPS source locator,
  immutable snapshot identifier, and an allowed license expression; or
- `SELF_AUTHORED_SYNTHETIC`: deliberately written synthetic test content with
  the fixed research-use declaration.

User selection history, clipboard content, private corpora, ad-hoc/free-form
sources, personal data, credentials, email addresses, phone numbers, and local
home-directory paths are rejected. Put eligible input only under one of these
roots:

- `tooling/phase7-offline-poc/fixtures/blind-eval/` for reviewed, tracked
  public/synthetic fixtures; or
- `artifacts/phase7/offline-poc/blind-eval-input/` for ignored local research
  material.

The input schema is
`schemas/blind-evaluation-input.schema.json`. Both `en-zh` and `zh-en` must
contain at least 200 unique source items. Duplicate item IDs and duplicate
normalized sources are rejected. Every direction must include
`proper-noun` and `long-sentence` coverage tags. A candidate's ID and
generation-run ID must remain fixed across every item in its direction.

Example shape (one line, not a complete 200-item dataset):

```json
{"schemaVersion":"phase7-blind-eval-input-item-v1","itemId":"en-zh-public-001","direction":"en-zh","source":"The update is ready.","reference":"更新已准备好。","tags":["basic"],"provenance":{"kind":"SELF_AUTHORED_SYNTHETIC","datasetId":"phase7-synthetic-v1","snapshotId":"snapshot-2026-07-23","licenseExpression":"SELF-AUTHORED-FOR-PHASE7-RESEARCH","sourceLocator":"SELF_AUTHORED_SYNTHETIC","contentDeclaration":"NO_USER_HISTORY_NO_CLIPBOARD_NO_PRIVATE_CORPUS","derivedFromUserActivity":false,"containsPersonalData":false,"usageAuthorization":"AUTHORIZED_FOR_PHASE7_HUMAN_EVALUATION"},"candidates":[{"candidateId":"bergamot-poc","generationRunId":"bergamot-en-zh-run-001","translation":"更新准备好了。"}]}
```

## 1. Prepare a randomized, candidate-anonymous batch

```powershell
node tooling/phase7-offline-poc/blind-eval.mjs prepare `
  --input artifacts/phase7/offline-poc/blind-eval-input/m4-quality.jsonl
```

The command generates an opaque random run ID and creates a new,
non-overwriting ignored run directory such as:

`artifacts/phase7/offline-poc/blind-eval/run-0123456789abcdef/`

It contains:

- `review-batch.jsonl`: randomized source/reference/candidate output with
  per-item aliases only;
- `score-template.jsonl`: one pending score row for each item/candidate pair;
- `private-answer-key.json`: the committed seed and real candidate mapping;
  the reviewer must not open or receive this file; and
- `manifest.json`: exact hashes, counts, provenance boundary, and
  randomization commitment.

The HMAC-SHA-256 seed is random per run. The seed commitment is public in the
manifest; the seed and mapping stay in the private answer key so the
randomization can be audited after review.

## 2. Record human-only scores

The built-in terminal reviewer resumes safely from existing pending scores:

```powershell
node tooling/phase7-offline-poc/blind-eval.mjs review `
  --run-id run-0123456789abcdef
```

It requires an interactive terminal and an explicit `HUMAN-BLIND`
attestation. It never reads the private answer key. It displays the source,
reference, random candidate alias, and output, then records:

- acceptable / unacceptable;
- adequacy and fluency scores from 1 to 5;
- severe mistranslation;
- untranslated content;
- garbled/unreadable output;
- proper-noun error; and
- long-sentence handling error.

An unacceptable score must include at least one error class. An acceptable
score cannot include an error class. Scores contain no free-text notes and use
an opaque generated reviewer token rather than a name, account, email, or
username. Progress is saved to `scores.jsonl` after each item.

For a separate reviewer workstation, provide only the review batch, score
template, schema, and reviewer tool. Keep the private answer key with the
evaluation coordinator. Do not treat the mere presence of an attestation as
proof that the reviewer followed the process; retain the normal human
evaluation sign-off.

## 3. Create an audited summary

The summarizer generates a new opaque report ID on every attempt; existing
reports are never overwritten:

```powershell
node tooling/phase7-offline-poc/blind-eval.mjs summarize `
  --run-id run-0123456789abcdef
```

`summarize` intentionally emits the historical development-only v1 report.
Gate A evidence must use the cross-bound v2 command and supply the same raw
authorization and two candidate-generation artifacts used by the formal PWS
run:

```powershell
node tooling/phase7-offline-poc/blind-eval.mjs summarize-v2 `
  --run-id run-0123456789abcdef `
  --authorization artifacts/phase7/offline-poc/authorizations/bergamot.json `
  --generation-en-zh artifacts/phase7/offline-poc/gate-a/generation-en-zh.json `
  --generation-zh-en artifacts/phase7/offline-poc/gate-a/generation-zh-en.json
```

The authorization and generation files must be regular, non-link files below
the ignored Phase 7 artifact root. Candidate IDs and generation run IDs in
every counted score must match the direction-bound generation records;
missing, stale, duplicate or remapped identities fail closed. The v2
summarizer also recomputes each direction's canonical
`{direction,itemId,sourceSha256}` item-identity set from the verified private
answer key and requires it to match the candidate-output binding.

Before counting a score, the summarizer verifies the batch, template, private
key, randomization seed commitment, evaluation mapping, and raw-score record
set. An unknown evaluation, duplicate evaluation, candidate/item double
count, missing score row, changed hash, inconsistent acceptance/error
classification, or non-human attestation fails closed.

The report keeps normalized raw scores and aggregates, per candidate and
direction:

- `N`, `validN`, unique items, and pending count;
- acceptance count/rate;
- mean adequacy and fluency;
- count/rate for every severe-error category; and
- the exact hashes needed to audit the raw inputs.

The report never contains source, reference, translated text, filesystem
paths, usernames, or free-form reviewer notes. The human-blind component is
complete only when every candidate has at least 200 unique, valid human
reviews in both directions. Even then the report deliberately keeps
`gateA.inputStatus` at `GATE_A_INPUT_INCOMPLETE`: performance, Windows Private
Working Set, artifact sizing, license/redistribution review, the rest of M4,
and the user's Gate A decision remain separate requirements.

## Static self-test

```powershell
node tooling/phase7-offline-poc/blind-eval-selftest.mjs
```

The self-test uses generated synthetic records. It validates schemas,
candidate randomization, tamper detection, duplicate-count rejection,
human-only score invariants, the 200-per-direction boundary, privacy
fail-closed behavior, raw-score aggregation, and the permanent overall Gate A
block. It performs no network access, model load, translation, or human
review.
