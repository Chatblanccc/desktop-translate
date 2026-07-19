# Phase 5 验收清单

- 当前状态：`NOT YET ACCEPTED / RELEASE BLOCKED`
- 证据更新：2026-07-19
- Phase 4 基线：`4ea65dcd5c5ef7c56127fe419127d48e0573a65d`
- 目标版本：`0.5.0-phase5`
- 规则：只有实际执行且结论范围与证据一致的项目才能勾选。开发期 smoke、模型调度、dirty-source artifact、
  unsigned package 及未绑定最终候选 hash 的报告，均不得冒充正式性能、长稳、安装、签名或发布证据。

## 当前证据快照

| 项目 | 当前状态 | 验收含义 |
|---|---|---|
| Phase 4 历史验收 | `HISTORICAL PASS` | 项目负责人确认已验收并在 GitHub 合并；当前环境重验不推翻历史结论 |
| 隔离 `4ea65dc` instrumentation-only 基线 | `BASELINE GAP` | 旧的隔离重验曾在 graceful quit 阶段超时；当前 dirty Phase 5 严格超集通过不替代同 buildMode、同 harness 的独立 Phase 4 性能基线 |
| 当前 Phase 2 product-trigger smoke | `DEVELOPMENT PASS` | 2026-07-19 全套 3/3 通过；它支持当前开发回归，不替代 fixed-lab、签名包或正式 PERF-09 |
| Desktop tests / coverage | `DEVELOPMENT PASS` | Desktop 34 files / 298 tests 通过，行覆盖率 95.53%；workspace coverage 通过；最终发布前仍需在 clean-source run 中归档 |
| 全仓 typecheck / lint | `DEVELOPMENT PASS` | 全仓 typecheck 与 lint 通过；最终发布前仍需在 clean-source run 中归档 |
| Native tests | `DEVELOPMENT PASS` | Native Windows tests 2/2 通过 |
| 当前 Phase 5 `phase4:verify` 严格超集 | `DEVELOPMENT PASS` | 2026-07-19 完整退出 `0`，Electron E2E 6/6，其中 Phase 2 为 3/3；当前证据属于 dirty worktree 开发快照，不是 Phase 5 acceptance |
| `phase5:verify` deterministic gate | `DEVELOPMENT_GATE_PASS_NOT_ACCEPTANCE` | [归档 summary](../../artifacts/phase5/local/acceptance-verify-rerun2-20260718-2300/verify-summary.json) 为 `strictPhase4Superset=true`、`acceptance=false`、`worktreeDirty=true` |
| 本轮唯一执行目标 | `FIELD-DRIVEN RESULT` | 使用 `artifacts/phase5/local/final-current-verify-20260719-0350` 与 `artifacts/phase5/local/final-current-installer-20260719-0350`；结论只读取实际生成的 summary/manifest 字段，不预写 PASS 或固定状态 |
| PERF-09 产品退出 | `DEV 2×5 PASS / FORMAL NOT RUN` | 10/10 成功、failure=0、forced cleanup=0、privacy PASS；正式 signed artifact 3×50 未运行 |
| 产品 idle 资源 | `DEV 15s PASS / FORMAL NOT RUN` | 产品 UI 正常退出且 residual/WER/privacy/cleanup 通过；正式 900s/5s 未运行 |
| Phase 5 正式结论 | `NOT YET ACCEPTED / RELEASE BLOCKED` | fixed-lab、真实产品 8h、签名 RC、实机与签字均未完成 |

详细证据边界见[验证报告](validation-report.md)。

## G0 / G1：基线与规格

- [x] Phase 4 已由项目负责人确认历史验收通过并在 GitHub 合并。
- [x] Phase 4 历史状态与 accepted risks 已在 Phase 4 文档归档。
- [ ] 独立 `4ea65dc` instrumentation-only baseline 完成同 buildMode、同 harness 的完整回归与三轮采样；旧隔离运行失败，当前 dirty Phase 5 严格超集通过不填补该 baseline gap。
- [x] D1–D9 已在[产品规格](product-spec.md)冻结。
- [x] [Benchmark Spec](benchmark-spec.md)冻结时钟、统计、证据等级和候选预算。
- [x] [风险登记](risk-register.md)已建立 owner、停止条件和外部依赖。
- [x] 本清单和[验证报告](validation-report.md)已建立。
- [ ] 四角色完成 M0 Scope Review 并记录身份/日期。

## G2：版本与构建来源

- [ ] workspace、Desktop 与所有 workspace packages 均为 `0.5.0-phase5`，并在最终 clean-source evidence 中复核。
- [ ] Native 使用单一版本来源，Host hello 报告 `0.5.0-phase5`。
- [ ] VERSIONINFO `FILEVERSION/PRODUCTVERSION=0.5.0.0`，字符串 ProductVersion 为 `0.5.0-phase5`。
- [ ] installer、release manifest 与最终候选版本一致。
- [ ] Node `22.23.1`、pnpm `10.32.1`、Electron、lockfile、Windows SDK、CMake/编译器写入 environment evidence。
- [ ] MSVC x64 Release 使用 `/MT`，并在 clean VM 证明无额外 VC Runtime 依赖。

## WP1 / WP2：测量与基线

- [ ] MetricsSink 默认关闭，启用必须是显式测试/验收路径；待最终 clean-source test evidence 归档后勾选。
- [ ] allowlist 与 negative tests 拒绝正文、译文、窗口、坐标、PID/HWND、路径、Pipe/nonce、凭据和 body；待最终归档。
- [ ] JSON schema、nearest-rank 统计器和三轮聚合测试通过；当前测试通过但正式三轮数据尚未运行。
- [ ] 跨进程 timestamp 不直接相减；无 ETW/QPC 时只报告分段 duration，并由最终证据复核。
- [ ] Renderer 2×RAF ack 是专用、受限、default-off 通道，并由最终证据复核。
- [ ] 独立 `4ea65dc` instrumentation-only baseline 完整 Phase 4 回归通过；当前为退出超时 `BLOCKED`。
- [ ] development 基线按冻结口径完成 3 轮。
- [ ] unsigned packaged 基线按冻结口径完成 3 轮。
- [ ] Product/Engineering/Quality 冻结最终 PERF/RES/package 预算。

## 开发期自动化（不替代正式验收）

- [x] 2026-07-19 当前 Phase 2 product-trigger Playwright smoke 全套 3/3 通过。
- [x] 当前 Desktop 34 files / 298 tests 通过，行覆盖率 95.53%；workspace coverage 通过。
- [x] 当前全仓 typecheck 通过。
- [x] 当前 lint 通过。
- [x] 当前 `phase4:verify` 的 lint、全仓 typecheck、全部单元测试、workspace coverage 与 build 前置门禁通过。
- [x] 撤回快速 OCR availability 探测并恢复原始探测后，`dt_native_windows_tests` 独立通过，随后
  `phase4:verify` Native 2/2 通过。
- [x] 2026-07-19 当前 `pnpm phase4:verify` 从头完整退出 `0`；Electron E2E 6/6，Phase 2 为 3/3。
- [x] 当前产品退出实现释放 `releaseSingleInstanceLock`，进入 Electron app quit lifecycle，并由 quit listener
  调用 `app.exit` 收口退出尾部；失败证据落盘后的 harness cleanup 不计产品正常退出。
- [x] 50 样本 metrics instrumentation smoke 通过；它只验证 instrumentation 路径，不替代 fixed-lab 三轮性能。
- [x] PERF-09 正式/开发双模式 runner 与静态负测已实现：正式模式强制 clean + signed/
  `acceptanceEligible` artifact、final manifest/四制品 attestation + 独立 trusted root/clean-download PASS、
  Git 跟踪设备登记、完整设备/run metadata、3×50、真实产品 UI 退出、逐轮 nearest-rank
  和失败先落盘后精确清理；实现通过不代表 fixed-lab PERF-09 已运行或通过。
- [x] [PERF-09 final combined 2×5 开发运行](../../artifacts/phase5/local/perf09-final-combined-2x5-20260719-0302/summary.json)
  为 `DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE`：Round 1 p50 `281.413ms`、p95/max `368.937ms`；
  Round 2 p50 `339.670ms`、p95/max `393.163ms`；10/10 成功、failure=0、forced cleanup=0，
  [privacy scan](../../artifacts/phase5/local/perf09-final-combined-2x5-20260719-0302/privacy-scan.json) 通过。
- [x] process/privacy 与 release-hardening 自测通过；它们只验证 fail-closed 控制实现，不替代 clean VM、签名或长稳。
- [x] Lane identity/policy 共 7/7 selftests 通过；Lane A/B 正式运行仍为 `NOT RUN/BLOCKED`。
- [x] 官方 npm audit 返回 Critical=0、High=0；仍需绑定最终 clean source、lockfile、SBOM 与签名候选。
- [x] [开发期 verify summary](../../artifacts/phase5/4ea65dcd5c5ef7c56127fe419127d48e0573a65d/verify-local-20260718T080235704Z/verify-summary.json)
  明确写入 `worktreeDirty=true`、`strictPhase4Superset=false`、`acceptance=false`。
- [x] [最新归档 deterministic verify](../../artifacts/phase5/local/acceptance-verify-rerun2-20260718-2300/verify-summary.json)
  未跳过 Phase 4 或 packaging，状态为 `DEVELOPMENT_GATE_PASS_NOT_ACCEPTANCE`；summary 明确记录
  `strictPhase4Superset=true`、`worktreeDirty=true`、`acceptance=false`，只支持该 dirty-source 开发快照。
- [ ] 本轮唯一 deterministic evidence 目标为
  `artifacts/phase5/local/final-current-verify-20260719-0350/verify-summary.json`；结论以实际生成文件的
  status、strict-superset、dirty 与 acceptance 字段为准，不在运行前预写结果。
- [x] [Lane A 模型调度 smoke](../../artifacts/phase5/local/lane-a-identity-smoke/summary.json)明确写入
  `SMOKE_PASS_NOT_ACCEPTANCE`、`fullScheduleComplete=false`、`productProcessExercised=false` 与未绑定 artifact 身份。
- [x] [Lane B not-run 记录](../../artifacts/phase5/local/lane-b-not-run-hardened/not-run.json)明确写入 `NOT RUN`，
  并要求独立下载、attestation、冻结 publisher subject 与最终签名 RC，未制造通过结论。
- [x] Lane identity selftest 通过：Lane A full schedule 只接受实际 test/release 普通文件路径，运行前后复算
  SHA-256 与 size，绑定实际 checkout Git SHA 与 pnpm lock hash，并拒绝 legacy caller-supplied SHA、同文件、
  同内容和 symlink；当前 smoke 仍保持 `UNBOUND`、`acceptance=false`。
- [x] Lane B Preflight 已改为 separately downloaded exact bundle 的 clean-download 验证，要求 GitHub
  attestation、独立 trusted root、exact app/Host/ASAR/installer、publisher subject、timestamp、source tag 与 SHA。
- [ ] 使用上述 hardened identity 门禁实际完成 Lane A full schedule 与 Lane B signed-RC 场景；实现自测不计正式运行。
- [ ] Lane A product runner 补齐受 attestation 约束的 runtime-control contract、test-artifact-only packaged endpoint
  与 action driver；当前仍为 [`NOT_IMPLEMENTED_BLOCKER`](lane-a-product-runner.md)，不会启动产品进程。
- [x] [开发期 WinRT/SBOM provenance](../../artifacts/phase5/local/wp5-provenance/supply-chain/build-provenance.json)
  已记录固定来源与 hash，并明确写入 `developmentDirty=true`；不会冒充最终 release provenance。

## WP3：性能与正确率

- [ ] PERF-01 cold start 在登记 fixed-lab 设备按冻结口径完成 3 轮。
- [ ] PERF-02 warm start 在登记 fixed-lab 设备按冻结口径完成 3 轮。
- [ ] PERF-03 Host ready 在登记 fixed-lab 设备按冻结口径完成 3 轮。
- [ ] PERF-04 真实 UIA mouse-up → card 在登记设备完成 3 轮。
- [ ] PERF-05 真实 OCR mouse-up → card 与正确率在登记设备完成 3 轮。
- [ ] PERF-06 Main → Renderer ack 在登记设备完成 3 轮。
- [ ] PERF-07 deterministic fake Provider 在登记设备完成 3 轮。
- [ ] PERF-08 真实 Provider 成功/故障 smoke 完成，且证据与 deterministic perf 分离。
- [ ] PERF-09 使用 `phase5:perf09` 对同一签名 package artifact 在登记设备完成 3×50；
  每轮 failure=0、p50 ≤2s、p95 ≤5s、max ≤10s。
- [ ] 相同设备/模式相对基线回归不超过 10%。
- [x] 当前 dirty worktree 的 Phase 1–4 正确率、latest-wins、取消、退出与隐私严格超集开发回归通过；
  `pnpm phase4:verify` 退出 `0`，Electron E2E 6/6、Phase 2 3/3、Native 2/2。clean-source/远程归档仍属正式发布缺口。

## WP4：资源、长稳与故障

- [x] [15 秒产品 idle final hardened 开发自测](../../artifacts/phase5/local/product-idle-final-hardened-dev-20260719-0326/summary.json)
  为 `DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE`：15 samples / 90 role rows，产品 UI command 已发出，root
  exit code `0`、`forcedTerminationUsed=false`；residual、WER、evidence privacy、final binary privacy 与
  isolated cleanup 全部 PASS。它仅为 15 秒/1 秒采样，不替代正式 900 秒/5 秒。
- [x] idle runner 的产品退出绑定为 DPI-aware 唯一 Ball、同 PID popup 的 geometry/foreground/point 校验、
  `SendInput` click 与 exact process handle exit code；后置 exact-identity cleanup 仅是测试隔离清理，不得写成
  产品正常退出路径。
- [ ] 产品完整进程树按正式冻结口径完成 900 秒 idle、每 5 秒采样，RES-01/02 CPU/内存/handle 门禁通过。
- [ ] 产品完整进程树完成 8 小时资源采样与 RES-03/04 趋势门禁；当前 `NOT RUN`。
- [ ] Lane A release-equivalent test artifact 运行真实产品进程并完整 8 小时通过；模型调度 smoke 不计。
- [ ] Lane A 的 fake Host/Provider 未进入 production package。
- [ ] 最终签名 RC Lane B 真实 UIA ≥600、OCR ≥300，完整 8 小时通过。
- [ ] Host kill/restart、display/DXGI recovery、断网/超时、退出风暴通过。
- [ ] sleep/resume、锁屏/解锁、主屏/DPI/分辨率/旋转/物理热插拔完成离散记录。
- [ ] RES-03/04 趋势通过，零 crash/hang/WER/stale/privacy hit/残留进程。
- [ ] userData/Temp/artifact/database/WAL/crash/update cache UTF-8 与 UTF-16LE canary 零命中。

## WP5：打包、SBOM 与签名

- [ ] per-user NSIS installer 在标准用户 clean VM 安装、启动、修复和卸载通过。
- [ ] production ASAR、Host、migrations、licenses 路径与白名单通过。
- [ ] 非 ASCII 用户目录、离线首次启动、无 OCR language pack 稳定工作/降级。
- [ ] installer ≤150 MiB；installed ≤350 MiB；Host+non-Electron resources ≤25 MiB。
- [ ] source map、test、fixture、fake transport、coverage、secret、本地路径在最终正式包中为零。
- [ ] CycloneDX/SPDX、THIRD_PARTY_NOTICES、hash、top-30、provenance 完整并绑定最终 clean source 与候选 hash。
- [ ] Critical/High 无未处置项；未知许可证和缺失 notice 为零。当前依赖审计仅为开发期候选证据。
- [ ] 项目自有 PE/installer Authenticode subject、chain、timestamp 一致且有效。
- [ ] 篡改 PE/installer/manifest/checksum 被拒绝。
- [x] 当前缺少正式证书，unsigned artifact 未被写成 RC，结论保持 `RELEASE BLOCKED`。
- [x] no-`SkipBuild` [Dir 开发包](../../artifacts/phase5/local/acceptance-dir-rerun-20260718-2240/release/evidence-manifest.json)
  全链通过：package/startup、packaged D8 helper、SBOM/provenance、ASAR/资源白名单、exact hash 与体积门禁
  均为 PASS；installed `322.146 MiB`、Host+non-Electron resources `0.74 MiB`。
- [x] no-`SkipBuild` [Installer 开发包](../../artifacts/phase5/local/acceptance-installer-rerun-20260718-2245/release/evidence-manifest.json)
  全链通过；installed `322.249 MiB`、installer `87.741 MiB`、Host+non-Electron resources `0.74 MiB`。
- [ ] 本轮唯一 no-`SkipBuild` Installer evidence 目标为
  `artifacts/phase5/local/final-current-installer-20260719-0350/release/evidence-manifest.json`；结论以实际生成
  manifest 的 build/package/signature/release 字段为准，不在运行前预写结果。
- [x] prepared package 的 isolated startup/D8 smoke 连续
  [1](../../artifacts/phase5/local/clean-package-smoke-fixed-20260718-r1/package/startup-smoke.json) /
  [2](../../artifacts/phase5/local/clean-package-smoke-fixed-20260718-r2/package/startup-smoke.json) /
  [3](../../artifacts/phase5/local/clean-package-smoke-fixed-20260718-r3/package/startup-smoke.json) 三次通过；
  这些记录明确 `gracefulExitVerified=false`、`cleanVmInstallVerified=false`，不得扩大解释。
- [ ] 将上述包提升为发布证据；它们均为 dirty `HEAD+WORKTREE`、`acceptanceEligible=false` 且应用/Host/installer
  为 `NotSigned`，不能证明 clean source、clean VM、签名、attestation、clean download 或发布资格。
- [ ] 在 clean source 上重建最终 package/installer，并完成签名、attestation 与 clean-download 验证。

## WP6：CI 与发布门禁

- [ ] `pnpm phase5:verify` 是 Phase 4 严格超集并在 clean source 本地退出 `0`；当前已有 dirty-source
  `DEVELOPMENT_GATE_PASS_NOT_ACCEPTANCE` 证据，但不满足本项 clean-source 条件。
- [ ] PR deterministic workflow 在 fresh runner 退出 `0`，不读取真实 Provider/签名 secret。
- [ ] 真实 external fork 取得零 secret 证据。
- [ ] fixed-lab performance/soak workflow 绑定登记设备与实际 artifact hash。
- [ ] protected tag/release environment、required checks、tag 规则和最小权限已配置。
- [ ] verification 不修改 tracked files、不残留产品进程。

## WP7：安装、升级、兼容与发布

- [ ] 现有 Phase 4 userData 可读取；Phase 5 beta → RC 覆盖安装通过。
- [ ] 修复、普通卸载保留数据、重装恢复、显式清除全部数据和回滚通过。
- [ ] Windows 11 100/125/150/200% DPI 与任务栏四边完成。
- [ ] 双物理屏、负坐标、混合 DPI、旋转、热插拔完成。
- [ ] Notepad、Chrome、Edge、Word、PDF、VS Code、Terminal、图片 OCR 完成 Case ID 记录。
- [ ] 标准用户、管理员目标、密码框、安全桌面、DRM 边界稳定且不提权。
- [ ] Windows 10 best-effort 结论按真实证据标记。
- [ ] release evidence manifest 关联 Lane A test hash 与 Lane B signed-RC hash，不混淆。
- [ ] Product、Engineering、Security/Privacy、Quality/Release 对同一最终 manifest 签字。

## 最终结论

当前结论：`NOT YET ACCEPTED / RELEASE BLOCKED`。

Phase 5 `PASS` 至少需要固定机三轮性能、产品进程 900 秒/5 秒采样 idle、真实产品 Lane A 8 小时、最终签名 RC Lane B、
clean VM、硬件/应用兼容矩阵、真实 Provider smoke 及四角色签字。当前任何 smoke、模型调度或 unsigned spike
均不满足这些条件；在正式性能数据完成前，也不得提升为 `PERFORMANCE ACCEPTED`。
