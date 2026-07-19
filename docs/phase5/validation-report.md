# Phase 5 验证报告

- 报告状态：`IN PROGRESS`
- 日期：2026-07-19
- Phase 4 基线 SHA：`4ea65dcd5c5ef7c56127fe419127d48e0573a65d`
- 目标版本：`0.5.0-phase5`
- 当前结论：`NOT YET ACCEPTED / RELEASE BLOCKED`

## 1. 摘要

Phase 5 开发与开发期验证已经开始，但尚未满足正式验收条件。本报告严格区分以下四类结论：

1. Phase 4 的历史验收事实；
2. 当前 Phase 5 工作区的开发期回归；
3. 仅验证 harness、接口或打包链路的 smoke/spike；
4. 只有固定实验室、真实产品进程、签名 RC 和实机矩阵才能提供的正式验收证据。

Phase 4 已由项目负责人确认验收通过并在 GitHub 合并，验收代码为
`4ea65dcd5c5ef7c56127fe419127d48e0573a65d`。旧 SHA 的隔离重验失败只保留为 instrumentation-only
baseline gap，不推翻 Phase 4 历史验收，也不再阻塞当前 Phase 5 工作区的严格超集开发回归。

2026-07-19 当前 `pnpm phase4:verify` 完整退出 `0`，Electron E2E 6/6，其中 Phase 2 product-trigger 3/3。
归档的 `phase5:verify` deterministic run 同样未跳过 Phase 4 或 packaging，状态为
`DEVELOPMENT_GATE_PASS_NOT_ACCEPTANCE`、`strictPhase4Superset=true`。no-`SkipBuild` Dir/Installer、PERF-09
2×5 与 15 秒产品 idle 开发证据均通过；但这些证据全部来自 dirty worktree/unsigned development artifact，
明确 `acceptance=false` 或 `acceptanceEligible=false`，不具备发布资格。

本轮唯一执行目标为
`artifacts/phase5/local/final-current-installer-20260719-0350/release/evidence-manifest.json` 与
`artifacts/phase5/local/final-current-verify-20260719-0350/verify-summary.json`。不为目标目录预写 PASS 或永久
PENDING；命令结束后的结论只取实际生成 manifest/summary 的 status、identity、dirty 与 acceptance 字段。

## 2. 证据规则

- `PASS`：命令或场景实际执行成功，且证据范围与结论一致。
- `DEVELOPMENT PASS`：当前工作区的开发期结果；可用于继续开发，不能替代正式 Phase 5 验收。
- `SMOKE PASS NOT ACCEPTANCE`：只证明接口、harness 或短路径可运行。
- `BLOCKED`：已尝试但被明确条件阻塞，或缺少不可替代的外部条件。
- `NOT RUN`：未执行。
- 工作区为 dirty、artifact 未绑定真实源码状态、包未签名、只运行模型调度或短时 smoke 时，不得升级为正式验收通过。

## 3. Phase 4 历史验收与当前重验边界

| 项目 | 结果 | 证据与边界 |
|---|---|---|
| Phase 4 历史验收 | `HISTORICAL PASS` | 项目负责人确认 Phase 4 已验收并在 GitHub 合并；以 [Phase 4 验证报告](../phase4/validation-report.md)及已合并记录为历史依据 |
| 隔离旧 SHA instrumentation-only baseline | `BASELINE GAP` | 独立 checkout `4ea65dc` 的旧运行在 graceful quit 阶段超时；因此尚无同 buildMode、同 harness 的正式 Phase 4 三轮性能基线 |
| 对历史结论的影响 | `NONE` | 本机重验阻塞是当前环境/退出时序的待调查项，不回写或撤销 Phase 4 已完成的历史验收 |
| 对 Phase 5 的影响 | `BASELINE GAP, NOT CURRENT REGRESSION BLOCKER` | 当前 dirty Phase 5 严格超集已经通过；旧失败仍阻止 Phase 4→5 正式相对性能结论，但不再阻止开发回归继续 |

## 4. 当前工作区开发期验证

| Gate | 当前结果 | 证据等级与限制 |
|---|---|---|
| 当前 Phase 2 product-trigger Playwright smoke | `DEVELOPMENT PASS` | 2026-07-19 全套 3/3 通过；随完整 `phase4:verify` 归档的 Electron E2E 总计 6/6 |
| Desktop tests / coverage | `DEVELOPMENT PASS` | Desktop 34 files / 298 tests 通过，行覆盖率 95.53%；workspace coverage 通过；最终发布前仍需随 clean-source run 归档 |
| 全仓 typecheck | `DEVELOPMENT PASS` | 全仓通过；本轮终端执行结果，最终发布前仍需随 clean-source run 归档 |
| Lint | `DEVELOPMENT PASS` | 本轮通过 |
| 当前 Phase 5 `phase4:verify` 前置 gates | `DEVELOPMENT PASS` | lint、全仓 typecheck、全部单元测试、workspace coverage 与 build 通过 |
| 当前 Phase 5 `phase4:verify` Native gate | `DEVELOPMENT PASS AFTER REVERT` | 快速 OCR availability 探测在 `[windows-tests] OCR availability` 后触发 LLVM-MinGW SegFault，因此该优化已撤回并恢复原始探测；`dt_native_windows_tests` 独立通过，随后 `phase4:verify` Native 2/2 通过 |
| 当前 Phase 5 退出路径 | `DEVELOPMENT PASS / FORMAL NOT RUN` | 产品退出实现释放 `releaseSingleInstanceLock`，进入 Electron app quit lifecycle，并在 quit listener 中调用 `app.exit` 收口尾部进程；Phase 2 3/3，PERF-09 2×5 使用 Ball 真实退出命令，10/10 成功、failure=0、forced cleanup=0。正式 signed artifact 3×50 未运行 |
| Metrics instrumentation | `DEVELOPMENT PASS` | 50 样本 smoke 通过；只证明 default-off instrumentation 测试路径可用，不提供 fixed-lab 三轮性能结论 |
| PERF-09 runner | `DEV 2×5 PASS / FORMAL NOT RUN` | 正式模式 fail closed 到 clean HEAD、signed + `acceptanceEligible` artifact、attested final manifest、独立 trusted root/clean-download PASS、Git 跟踪设备登记和 3×50；最新开发运行两轮均通过且 privacy PASS，但为未登记设备、dirty unsigned artifact，永远不是 acceptance |
| 产品 idle runner | `DEV 15s PASS / FORMAL NOT RUN` | DPI-aware 枚举唯一 Ball，绑定同 PID popup 的 geometry/foreground/point 后用 `SendInput` click；exact process handle 读取 root exit code 并约束后置 cleanup。最新运行 UI command issued、root exit `0`、forced=false；正式口径固定为 900 秒/5 秒 |
| Process/privacy/release hardening | `DEVELOPMENT PASS` | process/privacy 与 release hardening selftests 通过；只证明门禁实现，不替代 clean-source artifact、clean VM 或签名验证 |
| Lane identity/policy selftests | `DEVELOPMENT PASS` | 7/7 通过；证明 Lane A policy 与 attested artifact identity、Lane B clean-download preflight 的 fail-closed 实现，不能替代两条正式 lane |
| 完整 Phase 4 strict-superset gate | `DEVELOPMENT PASS` | 2026-07-19 `pnpm phase4:verify` 完整退出 `0`；Electron E2E 6/6、Phase 2 3/3、Native 2/2。仍需 clean-source/远程 CI 归档供正式发布使用 |
| 完整 Phase 5 deterministic gate | `DEVELOPMENT_GATE_PASS_NOT_ACCEPTANCE` | [summary](../../artifacts/phase5/local/acceptance-verify-rerun2-20260718-2300/verify-summary.json) 为 `strictPhase4Superset=true`、`worktreeDirty=true`、`acceptance=false`；只证明该 dirty-source snapshot |

idle/退出报告中的产品正常退出只由已绑定 UI command、exact process handle 观察到的 root exit code `0` 与
`forcedTerminationUsed=false` 构成；失败或收尾阶段的 exact-identity harness cleanup 只证明测试环境被清理，
不得写成正常产品退出、成功性能样本或产品自清理能力。

完整 evidence roots 复扫曾暴露 canonical privacy report 的 `findingCounts.absolutePath` 自引用假阳性；scanner 现仅精确豁免 schema-valid 且内部一致的 `1.1.0` canonical 计数器，普通或伪造 `absolutePath` 仍 fail closed。修复后 [privacy-meta rescan](../../artifacts/phase5/local/privacy-meta-rescan-20260719-0348/privacy-evidence.json) 为 4 roots / 46 files / 0 findings，`PASS`。

## 5. 已生成 artifact 的证据等级

| Artifact / Gate | 状态 | 可支持的结论 | 不可支持的结论 |
|---|---|---|---|
| `final-current-verify-20260719-0350/verify-summary.json` | `EXECUTION TARGET / READ ACTUAL FIELDS` | 实际文件生成并校验后用于本轮最新 deterministic 结论 | 在运行前预写 PASS、strict-superset 或 acceptance 结论 |
| `final-current-installer-20260719-0350/release/evidence-manifest.json` | `EXECUTION TARGET / READ ACTUAL FIELDS` | 实际文件生成并校验后用于本轮最新 no-SkipBuild Installer 结论 | 在运行前预写 package、signature 或 release 结论 |
| [开发期 verify summary](../../artifacts/phase5/4ea65dcd5c5ef7c56127fe419127d48e0573a65d/verify-local-20260718T080235704Z/verify-summary.json) | `DEVELOPMENT_SMOKE_PASS_NOT_ACCEPTANCE` | metrics/resource 接口、短 Lane A 调度、残留与隐私扫描链路可运行 | Phase 4 严格超集、正式 PERF/RES、Lane A 真实产品 8h 或 Phase 5 验收；该文件明确记录 `worktreeDirty=true`、`strictPhase4Superset=false`、`acceptance=false` |
| [最新归档 deterministic verify](../../artifacts/phase5/local/acceptance-verify-rerun2-20260718-2300/verify-summary.json) | `DEVELOPMENT_GATE_PASS_NOT_ACCEPTANCE` | 未跳过 Phase 4 或 packaging；strict superset、unsigned package、audit、process/privacy、residual 与证据隐私链路退出 `0` | Phase 5 acceptance；summary 明确记录 `strictPhase4Superset=true`、`worktreeDirty=true`、`acceptance=false` |
| [PERF-09 final combined 2×5](../../artifacts/phase5/local/perf09-final-combined-2x5-20260719-0302/summary.json) | `DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE` | R1 p50 `281.413ms`、p95/max `368.937ms`；R2 p50 `339.670ms`、p95/max `393.163ms`；10/10 成功、failure=0、forced cleanup=0、privacy PASS | 正式 PERF-09；设备未登记、非独占会话、dirty unsigned artifact、2×5 不能代替 signed artifact 3×50 |
| [15 秒产品 idle final hardened](../../artifacts/phase5/local/product-idle-final-hardened-dev-20260719-0326/summary.json) | `DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE` | 15 samples / 90 role rows；UI command issued、root exit `0`、forced=false；residual、WER、evidence privacy、final binary privacy 与 isolated cleanup 全 PASS | 正式 RES-01/02；15 秒/1 秒采样不等于冻结的 900 秒/5 秒采样，且未绑定 acceptance-eligible manifest |
| [Lane A 短时模型调度](../../artifacts/phase5/local/lane-a-identity-smoke/summary.json) | `SMOKE_PASS_NOT_ACCEPTANCE` | deterministic orchestration harness 能消费模拟结果，并拒绝把 unbound 开发 smoke 写成完整调度 | 真实产品进程、UIA/DXGI/OCR、900 秒 idle、8 小时长稳或资源验收；该文件明确记录 `fullScheduleComplete=false`、`productProcessExercised=false`、artifact identity `UNBOUND` |
| [Lane B not-run 记录](../../artifacts/phase5/local/lane-b-not-run-hardened/not-run.json) | `NOT RUN` | 清楚记录独立下载、attestation、publisher subject、签名 RC 和专用会话等缺失条件 | 任何 signed-RC、真实采集、8 小时或恢复能力结论 |
| 初始 unsigned Dir package spike | `SPIKE ONLY / INVALID FOR ACCEPTANCE` | 可用于发现尺寸、路径和打包脚本问题 | 正式包、发布候选或来源可追溯结论；该包未签名，且生成时 dirty Phase 5 源码被错误标为 HEAD `4ea65dc`，必须由 hardened 流程重建 |
| 首次不带 `-SkipBuild` 的 unsigned Installer run | `BUILD GATES PASS / PACKAGED D8 SMOKE FAILED` | installer、ASAR、Host、SBOM、exact hash 与体积链路已真实构建 | 完整 package 或 release；D8 helper 超时由 harness 持有父进程句柄造成，该次整条命令非零。harness 已修复为先释放句柄，但原失败结果不升级为 PASS |
| [no-SkipBuild Dir 开发包](../../artifacts/phase5/local/acceptance-dir-rerun-20260718-2240/release/evidence-manifest.json) | `DEVELOPMENT PACKAGE PASS / RELEASE BLOCKED` | production build、startup/D8、SBOM/provenance、ASAR/资源白名单、exact hash 与体积门禁通过；installed 322.146 MiB、runtime resources 0.74 MiB | clean-source/signed RC 或 clean VM；manifest 为 dirty `HEAD+WORKTREE`、`acceptanceEligible=false`，应用/Host `NotSigned` |
| [no-SkipBuild Installer 开发包](../../artifacts/phase5/local/acceptance-installer-rerun-20260718-2245/release/evidence-manifest.json) | `DEVELOPMENT PACKAGE PASS / RELEASE BLOCKED` | 完整构建与 package gates 通过；installed 322.249 MiB、installer 87.741 MiB、runtime resources 0.74 MiB | clean-source/signed RC、attestation/clean-download 或 clean VM；应用/Host/installer 均 `NotSigned` |
| prepared package startup/D8 smoke [1](../../artifacts/phase5/local/clean-package-smoke-fixed-20260718-r1/package/startup-smoke.json) / [2](../../artifacts/phase5/local/clean-package-smoke-fixed-20260718-r2/package/startup-smoke.json) / [3](../../artifacts/phase5/local/clean-package-smoke-fixed-20260718-r3/package/startup-smoke.json) | `3/3 SMOKE PASS NOT ACCEPTANCE` | isolated non-ASCII userData、固定 Host 路径、marker-bound clear-data helper 与 sibling-preservation 可重复通过 | graceful exit 或 clean VM；三份证据均明确 `gracefulExitVerified=false`、`cleanVmInstallVerified=false` |
| [依赖审计候选报告](../../artifacts/phase5/local/wp5-supply-chain-audit/dependency-audit.json) | `DEVELOPMENT PASS / FINAL BINDING PENDING` | 官方 npm registry 查询返回 Critical/High 为 0，且 endpoint fail-closed 路径已记录 | 最终 release artifact 的完整供应链验收；仍需与最终 clean source、lockfile、SBOM 和签名 RC 绑定 |
| [WinRT/SBOM provenance 候选](../../artifacts/phase5/local/wp5-provenance/supply-chain/build-provenance.json) | `DEVELOPMENT PASS / DIRTY SOURCE` | 固定 NuGet 来源、包 hash、`cppwinrt.exe` hash、1358 个投影文件整树 hash、Native `/MT` 元数据均已生成并交叉验证 | 最终 release provenance；报告明确记录 `developmentDirty=true` 和 `HEAD+WORKTREE` source identity，必须在 clean source/最终候选上重建 |

以上 smoke/spike 可以证明开发进展，但不得填写为正式性能、资源、安装或发布验收通过。
此前失败的 PERF-09/idle 探针与 package 证据继续原样保留；它们 fail closed 捕获了旧退出时序、UI surface
绑定和 cleanup 竞态，不因后续开发运行通过而删除或改写为 PASS。
Lane identity selftest 同样只证明 fail-closed 门禁实现；由于没有运行 full schedule 或 separately downloaded
signed RC，Lane A 与 Lane B 的正式状态仍分别为 `NOT RUN` 和 `BLOCKED/NOT RUN`。
Lane A 的 formal product entry point 还存在仓库内实现阻塞：当前 manifest 没有绑定 runtime-control contract，
packaged test endpoint 与 action driver 未实现，因此 runner 正确返回 [`NOT_IMPLEMENTED_BLOCKER`](lane-a-product-runner.md)。

## 6. 正式验收缺口

| 正式 gate | 状态 | 缺失证据 |
|---|---|---|
| Phase 4 strict-superset rerun | `DEVELOPMENT PASS / CLEAN CI PENDING` | 当前 dirty worktree 完整退出 `0`；仍需 clean-source 本地与远程无关键 skip 归档。独立 instrumentation-only Phase 4 baseline 仍是另一项 gap |
| PERF-01–07/09 fixed-lab | `NOT RUN` | 登记设备上按冻结口径执行 3 轮；PERF-09 最新 2×5 仅为开发自测，正式仍须同一签名 package artifact 的 3×50，逐轮满足 failure=0、p50 ≤2s、p95 ≤5s、max ≤10s |
| Lane A 真实产品 8h | `BLOCKED / NOT IMPLEMENTED` | 先实现受 attestation 约束的 runtime-control contract、test-only packaged endpoint 与 action driver，再用 release-equivalent test artifact 运行真实产品进程和完整 8 小时报告 |
| Lane B 最终签名 RC 8h | `BLOCKED` | 已批准 subject 的签名 RC、专用交互会话、真实 UIA/OCR、UIA ≥600、OCR ≥300 |
| 900 秒 idle 资源门禁 | `NOT RUN` | 最新 15 秒开发自测通过；正式仍须产品完整进程树按 5 秒间隔采样 900 秒并满足 CPU/内存/handle 阈值 |
| 8 小时资源趋势 | `NOT RUN` | 产品完整进程树的 8 小时 CPU/内存/handle、WER、残留与趋势报告 |
| no-SkipBuild package | `DEVELOPMENT PASS / FINAL-CURRENT RERUN PENDING` | 上一份 Dir 与 Installer 均已通过，但本轮 `final-current-*` 唯一目录尚待生成；所有已知 source identity 均为 dirty `HEAD+WORKTREE`、`acceptanceEligible=false` 且未签名 | clean-source 重建、签名、attestation、clean-download 和 clean VM |
| Authenticode 与发布绑定 | `BLOCKED` | 项目自有 PE/installer 的 subject、chain、timestamp、签名后 exact-set/hash 和 clean-download 验证 |
| clean VM 安装/升级/卸载 | `NOT RUN` | 标准用户 per-user NSIS 安装、启动、修复、覆盖升级、普通卸载保留数据、重装与显式清除 |
| 硬件/兼容矩阵 | `NOT RUN` | A 类低配、C 类双物理屏、DPI 100/125/150/200%、任务栏四边、旋转与热插拔 |
| 真实 Provider smoke | `NOT RUN` | 受控测试账号的脱敏成功、超时、断网、无效响应与恢复记录 |
| 四角色签字 | `PENDING` | Product、Engineering、Security/Privacy、Quality/Release 对同一最终 evidence manifest 签字 |

## 7. 外部与实机矩阵

| 项目 | 状态 | 说明 |
|---|---|---|
| A 类低配机 | `NOT RUN` | 当前机器不符合 4-core/8-GiB 口径 |
| C 类物理多屏 | `NOT RUN` | 当前只有单屏；虚拟适配器不代替物理矩阵 |
| Windows 10 | `NOT RUN` | 仅 best-effort，尚无隔离环境 |
| DPI 100/125/200 | `NOT RUN` | 当前样本仅 150% |
| 任务栏四边/旋转/热插拔 | `NOT RUN` | 待设备矩阵 |
| 真实百度成功/故障恢复 | `NOT RUN` | 必须使用专用测试账号并保持证据脱敏 |
| clean VM 安装/升级/卸载 | `NOT RUN` | unsigned 本机 spike 不替代最终签名 RC 的 clean VM 结果 |

## 8. 签字状态

| 角色 | 状态 | 说明 |
|---|---|---|
| Product | `PENDING` | 待 M0/M4 记录 |
| Engineering | `PENDING` | 待完整回归、性能与实现证据收口 |
| Security/Privacy | `PENDING` | 待 metrics、package、secret、provenance 与 signature 复核 |
| Quality/Release | `PENDING` | 待 CI、实机、installer、signed RC 与 release manifest |

## 9. 当前判定

当前判定为 `NOT YET ACCEPTED / RELEASE BLOCKED`。

开发期的 lint、全仓 typecheck、workspace coverage、Desktop 298 tests / 95.53% 行覆盖、Native 2/2、
Phase 2 3/3、Electron E2E 6/6、严格 Phase 4 超集、50 样本 metrics smoke、process/privacy/release hardening、
Lane identity/policy、no-SkipBuild Dir/Installer、最新 PERF-09 2×5 和 15 秒 final hardened 产品 idle 支持继续开发。它们全部属于
dirty/non-acceptance 证据，仍不满足 clean-source/远程 deterministic gate、固定机 PERF-01–09 三轮、PERF-09
正式 3×50、900 秒 idle、真实产品 Lane A 8 小时、最终签名 RC Lane B、clean VM、硬件/应用矩阵、
真实 Provider、attestation/clean-download 和四角色签字要求。
在这些正式证据齐备前，Phase 5 不得标记为 `PASS`，也不得标记为 `PERFORMANCE ACCEPTED`。
