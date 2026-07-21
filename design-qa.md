# Phase6 Design QA

## Final evidence

- Source visual truth: user-provided reference, incorporated into `docs/phase6/evidence/comparison-final-full.png`.
- Final settings capture: `docs/phase6/evidence/settings-final.png`
- Original Phase6 result-card capture: `docs/phase6/evidence/card-webcontents-capture-final-3.png`
- Same-state full comparison: `docs/phase6/evidence/comparison-final-full.png`
- Original focused result-card comparison: `docs/phase6/evidence/card-comparison-final-3.png`
- Header-divider correction capture: `docs/phase6/evidence/settings-header-divider-removed.png`
- Header-divider focused comparison: `docs/phase6/evidence/header-divider-comparison.png`
- Current card source truth: user-provided reference, incorporated into the focused card comparisons below.
- Current source-card crop: `docs/phase6/evidence/card-compact-source-crop.png`
- Current translated-card capture: `docs/phase6/evidence/card-compact-translated.png`
- Current translated-card comparison: `docs/phase6/evidence/card-compact-comparison.png`
- Minimal translated-card capture: `docs/phase6/evidence/card-minimal-translated.png`
- Minimal translated-card comparison: `docs/phase6/evidence/card-minimal-comparison.png`
- Floating-ball shadow source truth: user-provided reference, incorporated into `docs/phase6/evidence/ball-shadow-comparison.png`.
- Floating-ball no-shadow capture: `docs/phase6/evidence/ball-shadow-after-white.png`
- Floating-ball focused comparison: `docs/phase6/evidence/ball-shadow-comparison.png`
- Source dimensions: 1487 × 1058 px
- Implementation settings capture: 1003 × 723 px
- Original result-card renderer capture: 450 × 375 physical px (300 × 250 DIP at 150% scaling)
- Current translated-card capture: 450 × 300 physical px (300 × 200 DIP at 150% scaling)
- Comparison canvas: both settings views normalized to 1003 × 714 px; the implementation's 9 px empty bottom edge is excluded.
- State: light theme, “划词取词” selected, selection enabled, native service ready/running, source-only result card visible.
- Focused divider state: light theme, “划词取词” selected; only the title-bar/content boundary is evaluated.

The source image is internally contradictory: its switch is off while both the settings status and result card show an enabled/running selection flow. The implementation preserves truthful product state, so the switch is on in the equivalent running state. This is an intentional state correction, not a visual defect.

## Closed findings

- [closed] Window frame and density now match the source composition: one 50 DIP title bar, 200 DIP navigation rail, bounded content surface, and source-aligned information density.
- [closed] “划词取词” is the selected navigation item and each navigation item opens an independent settings view.
- [closed] Heading, body, label, icon, spacing, and neutral-surface scales are aligned to the source.
- [closed] The two-row selection status panel and sidebar service/version group match the source structure and semantic coloring.
- [closed] OCR controls use the source's continuous three-column frame, column proportions, single internal divider, and local-processing assurance.
- [closed] The prior 300 × 250 DIP card established the source hierarchy, close control, footer, border, radius, and shadow; translated success now intentionally uses 300 × 200 DIP while source-only, translating, and failed states retain the original-text fallback and scroll behavior.
- [closed] The first two missing horizontal dividers were restored and aligned with the OCR/status divider.
- [closed] Runtime theme changes now resynchronize the native title-bar overlay and window background.
- [closed] Every independent settings view has a level-one heading and retains the existing business actions.
- [closed] The redundant full-width title-bar bottom border was removed; the content panel keeps its own rounded top boundary.

## Comparison history

### Iteration 1 — invalid pass withdrawn

- The earlier report incorrectly treated shared visual language as sufficient fidelity.
- User-provided evidence demonstrated unresolved P1/P2 frame, navigation, density, status, and result-card differences.
- The pass was withdrawn and the QA gate was changed to same-state, same-size side-by-side comparison.

### Iteration 2 — blocked

- The major layout was corrected, but independent review still found P2 differences in the result-card title/close control, two missing dividers, and the sidebar footer position/copy.
- Those findings were fixed before the final comparison was regenerated.

### Final independent review

- P0: 0
- P1: 0
- P2: 0
- Remaining P3 only: 1–7 px spacing offsets, platform font antialiasing, and 1–2 px border/radius brightness differences.

### Iteration 3 — header-divider annotation

- The user identified one redundant horizontal divider at the bottom of the title bar.
- Removed only `.app-header`'s bottom border; content-panel borders and all section dividers remain unchanged.
- Post-fix focused evidence: `docs/phase6/evidence/header-divider-comparison.png`.
- P0: 0; P1: 0; P2: 0.

### Iteration 4 — compact translated result and outside-click dismissal

- User-directed change: translated success no longer repeats the original text; source-only, translating, and failed states still retain it as the only result or failure fallback.
- The translated card is reduced from 300 × 250 DIP to 300 × 200 DIP. The same-width comparison confirms the removed block and scrollbar reclaim 50 DIP of vertical space without changing the established visual language.
- The close button remains as an accessible fallback, but an outside-card pointer-down now dismisses the card. Inside-card clicks remain available for selecting/copying the translation and using retry controls.
- Scroll position resets whenever `selectionId` or card `kind` changes, so a long translating/source state cannot leave the translated result scrolled into the middle.
- Translated success is exposed as an atomic polite status for assistive technology.
- Automated evidence covers strict pointer-event parsing, capability negotiation, concurrent event-sequence ordering, outside-bounds dismissal, inside-bounds preservation, and subsequent selection presentation. Injected desktop automation is intentionally filtered by the Native Host, so the final physical `WH_MOUSE_LL` gesture remains a manual check in the running app.
- Visual review: P0: 0; P1: 0; P2: 0.

### Iteration 5 — remove provenance block and restore floating-ball visibility

- User-directed change: removed the complete “应用文字 / 识别来源” provenance block from every result-card state.
- The translated success card now contains only its title, translation, provider footer, and accessible close control; its height is reduced from 300 × 200 DIP to 300 × 160 DIP.
- Source-only, translating, and failed states retain original text as functional fallback content, but no longer repeat provenance metadata.
- Translating and failed states place progress/error actions before fallback source text, keeping loading feedback and retry controls in the first viewport at the compact height.
- The floating ball now initializes and resets on the display containing the current pointer when no saved anchor exists; existing custom anchors and visibility settings remain untouched.
- The missing-ball report was reproduced as a visible but transparent stale Renderer window. After rebuilding and restarting the real profile, the same floating-ball window renders its icon and online indicator again.
- Same-state combined comparison: `docs/phase6/evidence/card-minimal-comparison.png`.
- Visual review: P0: 0; P1: 0; P2: 0.

### Iteration 6 — flat floating-ball surface

- User-directed change: removed the broad gray outer halo that made the floating ball look muddy on white surfaces.
- Root cause was the ball button's default and interaction-state box shadows, not Electron's native window shadow or the translation-mark asset.
- Default, hover, and active states now remain shadow-free. The accent border, hover color shift, pressed scale, keyboard focus ring, drag region, and online status dot are preserved.
- Focused white-background comparison: `docs/phase6/evidence/ball-shadow-comparison.png`.
- Fonts/typography, icon asset, copy, component dimensions, and spacing remain unchanged. The only token-level visual change is elevation: the ball surface is now flat.
- Visual review: P0: 0; P1: 0; P2: 0.

### Iteration 7 — saved credential readback

- User-directed change: when Baidu credentials already exist, the settings page now restores the saved APP ID as plaintext and represents the saved secret with a fixed-length mask.
- The fixed mask is a placeholder only; the secret input value remains empty, the real secret and its length never cross the Main-to-Renderer boundary, and replacing the secret still requires entering a new value.
- Credential summary access is restricted to the Settings renderer. The floating ball cannot call the new IPC route, and malformed or secret-bearing responses are rejected by the preload boundary.
- Existing encrypted credentials require no migration because the current envelope already contains both fields.
- Source request: user-provided credential-settings reference; no local temporary path or credential value is retained in the repository.
- Real-profile verification after a production rebuild and application restart confirmed that the APP ID is restored, the secret remains masked, and the native selection service remains running.
- Automated evidence: contracts 42/42, desktop 329 passed with 1 skipped, focused credential/settings suite 98/98, and both credential save/restart/delete Playwright scenarios passed.
- Security/functional review: P0: 0; P1: 0; P2: 0.

## Final result

passed
