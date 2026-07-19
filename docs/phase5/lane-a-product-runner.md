# Phase 5 Lane A product runner

`pnpm phase5:lane-a:product` is the formal entry point for the product-process Lane A gate. It requires independently acquired test/public artifacts, both attested build manifests, both GitHub attestation bundles, an independently acquired trusted root, and the exact repository/ref/workflow/Git identity.

The formal preflight delegates identity verification to `phase5-lane-a-identity.mjs`. Inputs must be regular files outside the checkout, the checkout must be clean, both artifacts must bind the same source and toolchain, the test/public bytes must differ, and the fake/test-hook delta must match both manifests. Caller-supplied hashes are not accepted.

## Current boundary

The runner currently returns `NOT_IMPLEMENTED_BLOCKER` after a successful identity preflight and never launches a product process. This is intentional and fail closed:

- the attested manifest does not bind an artifact extraction format, product executable, control endpoint, protocol version, or response evidence path;
- the current Main-process test API and fake translation transport explicitly reject packaged Electron (`app.isPackaged`);
- no restricted packaged control plane can deliver the frozen selection, translation, fault and lifecycle schedule and confirm both Main and Renderer outcomes.

`PASS` is schema- and policy-gated on the complete eight-hour schedule and every assertion being true: attested identity, fake/public isolation, product process execution, four action families, Main/Renderer confirmations, resource, residual process, WER, privacy, and graceful exit. Development selftests cannot claim acceptance:

```powershell
pnpm phase5:lane-a:product:selftest
```

The next implementation must add a reviewed, attested runtime-control contract and a test-artifact-only packaged endpoint. The public artifact must continue to exclude that endpoint. Only then may the runner extract the exact test artifact, start its Electron product process, send the 8h/30s deterministic schedule, run `phase5-product-resource-acceptance.ps1` in its default acceptance mode in parallel, and attach exit/residual/WER/privacy evidence.
