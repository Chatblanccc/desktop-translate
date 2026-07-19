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
| 隔离 `4ea65dc` instrumentation-only 基线 | `BASELINE GAP` | 旧的隔离重验曾在 graceful quit 阶段超时；当前 clean Phase 5 严格超集通过不替代同 buildMode、同 harness 的独立 Phase 4 性能基线 |
| 当前 Phase 2 product-trigger smoke | `DEVELOPMENT PASS` | 2026-07-19 全套 3/3 通过；它支持当前开发回归，不替代 fixed-lab、签名包或正式 PERF-09 |
| Desktop tests / coverage | `CLEAN-HEAD DEVELOPMENT PASS` | `3443d875…` clean run 中 Desktop 34 files / 298 tests、行覆盖率 95.53% 与 workspace coverage 通过；当前后续修改仍需新 clean run |
| 全仓 typecheck / lint | `CLEAN-HEAD DEVELOPMENT PASS` | `3443d875…` clean run 中全仓 typecheck 与 lint 通过；当前后续修改仍需新 clean run |
| Native tests | `DEVELOPMENT PASS` | Native Windows tests 2/2 通过 |
| `phase5:verify` deterministic gate | `CLEAN-HEAD PASS NOT ACCEPTANCE` | [`3443d875…` summary](../../artifacts/phase5/3443d87598d15b697468b0b66755c7e808b76607/clean-verify-local-20260719-rerun1/verify-summary.json) 为 `DETERMINISTIC_GATE_PASS_NOT_ACCEPTANCE`、`strictPhase4Superset=true`、`worktreeDirty=false`、`acceptance=false` |
| 环境预检 | `DEVELOPMENT PREFLIGHT BLOCKED` | Profile B 的 Win11/CPU/RAM/单屏 150% DPI/`gh 2.96.0` 通过；独占会话、签名身份、self-hosted runners、protected environments 与 Actions role context 阻断 |
| PERF-03 Host ready | `DEV 1×1 PASS / FORMAL BLOCKED` | 最新 packaged unsigned 样本 `118.648ms`，failure/forced termination 为 `0`；formal trust controller 未实现且未运行 signed fixed-lab 3×100 |
| Provider runner | `DEVELOPMENT SELFTEST PASS / FORMAL BLOCKED` | health 路径可开发验证；fault/aggregate 在可信受控故障控制器实现前固定返回 `formal-fault-controller-not-implemented`，不会生成验收证据 |
| PERF-09 产品退出 | `DEV 2×5 PASS / FORMAL NOT RUN` | 10/10 成功、failure=0、forced cleanup=0、privacy PASS；正式 signed artifact 3×50 未运行 |
| 产品 idle 资源 | `DEV 15s PASS / FORMAL NOT RUN` | 产品 UI 正常退出且 residual/WER/privacy/cleanup 通过；正式 900s/5s 未运行 |
| Windows UI 快检 | `MANUAL DEVELOPMENT QA PASS` | Ball/Settings/Native service/版本面可用，设置页 Phase 4 副标题已修为 Phase 5；不替代签名 RC、clean VM 或兼容矩阵 |
| 验收决议 source validators | `0/43 TRUSTED / 43 BLOCKED` | 43/43 registry fail closed；全部生产 gate 返回 `GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED`，当前不可能形成批准 |
| Phase 5 正式结论 | `NOT YET ACCEPTED / RELEASE BLOCKED` | fixed-lab、真实产品 8h、签名 RC、实机、可信 validator/approval receipt 与签字均未完成 |

详细证据边界见[验证报告](validation-report.md)。

## G0 / G1：基线与规格

- [x] Phase 4 已由项目负责人确认历史验收通过并在 GitHub 合并。
- [x] Phase 4 历史状态与 accepted risks 已在 Phase 4 文档归档。
- [ ] 独立 `4ea65dc` instrumentation-only baseline 完成同 buildMode、同 harness 的完整回归与三轮采样；旧隔离运行失败，当前 clean Phase 5 严格超集通过不填补该 baseline gap。
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
- [x] 当前 Desktop 34 files / 308 tests 通过；行覆盖率 95.53% 与 workspace coverage 来自 `3443d875…`
  clean 归档，当前提交仍需 clean coverage 重跑。
- [x] 当前全仓 typecheck 通过。
- [x] 当前 lint 通过。
- [x] `3443d875…` 的 `phase4:verify` lint、全仓 typecheck、全部单元测试、workspace coverage 与 build 前置门禁通过。
- [x] 撤回快速 OCR availability 探测并恢复原始探测后，`dt_native_windows_tests` 独立通过，随后
  `phase4:verify` Native 2/2 通过。
- [x] 2026-07-19 `3443d875…` 的 `pnpm phase4:verify` 从头完整退出 `0`；Electron E2E 6/6，Phase 2 为 3/3。
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
- [x] [`3443d875…` clean-HEAD deterministic verify](../../artifacts/phase5/3443d87598d15b697468b0b66755c7e808b76607/clean-verify-local-20260719-rerun1/verify-summary.json)
  完整退出 `0`，状态为 `DETERMINISTIC_GATE_PASS_NOT_ACCEPTANCE`，并明确记录
  `strictPhase4Superset=true`、`worktreeDirty=false`、`acceptance=false`。它证明该提交的 clean 本地门禁，
  不替代后续修改的新 clean run、远程 CI 或 Phase 5 acceptance。
- [x] 环境 preflight runner/selftest 已实现；[最新本机 + GitHub inventory](../../artifacts/phase5/local/environment-preflight-20260719-postfix-nobom.json)
  以无 BOM、append-never JSON 诚实输出 `BLOCKED`。Win11/CPU/RAM/单物理屏 150% DPI 与 `gh 2.96.0` 能力通过；
  签名身份、独占会话、required runners、具备 reviewer/防自审/wait timer/tag policy/secrets 的 protected
  environments，以及绑定实际 run/job/runner/workflow SHA 的 Actions role context 未满足。
- [x] package output 不再递归删除或失败回滚：旧 `dist` 在 stable repository lock、目录 file-ID lease 与逐文件
  no-share lease 下同卷原子移入 `.phase5-package-quarantine`，完整保留；新包在唯一 staging 中构建后再原子发布。
  所有 package/sign/evidence gate 通过后才发布；Dir/Installer 根 exact-set 与 live 全树 hash 会再次复核，失败发布
  原子移入 `.phase5-failed-*` 保留。Confirm/Exit 复核旧树 exact entry set 与逐文件 SHA-256；并发、删除、写入、
  执行、parent rename、注入与 retention 双错误负测通过。
- [x] Windows packaged UI 开发快检确认 Ball、Settings、Native service 与 `0.5.0-phase5` 版本面可用，正常
  UI 退出后 exact package process 为 `0`；发现并修正设置页 `Phase 4 · 内部开发预览` 残留标签，定向测试通过。
  该会话观察尚非 signed-RC/clean-VM/兼容矩阵证据。
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

- [x] PERF-03 development runner 与 fail-closed selftest 已实现；formal 参数仍冻结为 3×100、p50 ≤700ms、
  p95 ≤1.5s，但在 protected-run receipt、认证指标通道、预先冻结 publisher policy 与完整 namespace trust controller
  实现前固定返回 `FORMAL_PERF03_TRUST_CONTROLLER_NOT_IMPLEMENTED`，不会生成 formal PASS。
- [x] [PERF-03 packaged 1×1 最新开发运行](../../artifacts/phase5/local/perf03-host-ready-lease-dev-20260719T060500404Z/summary.json)
  为 `DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE`：p50/p95/max `118.648ms`、failure=0、forced termination=0、
  postflight residual/privacy PASS。计时结束后的 cleanup 精确绑定同 PID 唯一 Ball 与同 PID 菜单，并通过
  UIA Invoke 调用唯一启用的 Exit 项；未登记设备、unsigned 与 1×1 均不能代替 formal 3×100。
- [x] PERF-08 Provider 开发 selftest 已实现，formal health 只允许真实百度 product provider。
- [ ] 实现并独立证明 PERF-08 受控故障控制器；在此之前 timeout、network、malformed-response、recovery 与
  aggregate 稳定返回 `formal-fault-controller-not-implemented`，不能靠切换场景标签或自报 `faultControlId` 冒充。
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
- [x] `3443d875…` clean worktree 的 Phase 1–4 正确率、latest-wins、取消、退出与隐私严格超集开发回归通过；
  Electron E2E 6/6、Phase 2 3/3、Native 2/2。当前后续修改的新 clean-source run 与远程 CI 仍属发布缺口。

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
- [x] [`3443d875…` clean unsigned Dir package](../../artifacts/phase5/3443d87598d15b697468b0b66755c7e808b76607/clean-verify-local-20260719-rerun1/package/release/evidence-manifest.json)
  记录 `developmentDirty=false`，build/package/startup/supply-chain PASS；应用与 Host 为 `NotSigned`，
  `acceptanceEligible=false`、release `RELEASE BLOCKED`。
- [x] prepared package 的 isolated startup/D8 smoke 连续
  [1](../../artifacts/phase5/local/clean-package-smoke-fixed-20260718-r1/package/startup-smoke.json) /
  [2](../../artifacts/phase5/local/clean-package-smoke-fixed-20260718-r2/package/startup-smoke.json) /
  [3](../../artifacts/phase5/local/clean-package-smoke-fixed-20260718-r3/package/startup-smoke.json) 三次通过；
  这些记录明确 `gracefulExitVerified=false`、`cleanVmInstallVerified=false`，不得扩大解释。
- [ ] 将上述包提升为发布证据；早期 Installer/Dir 为 dirty，`3443d875…` Dir 虽为 clean source，仍
  `acceptanceEligible=false` 且 `NotSigned`，不能证明 clean VM、签名、attestation、clean-download 或发布资格。
- [ ] 在最终候选 clean source 上重建 package/installer，并完成签名、attestation 与 clean-download 验证。

## WP6：CI 与发布门禁

- [x] `3443d875…` 的 `pnpm phase5:verify` 是 Phase 4 严格超集并在 clean source 本地退出 `0`；
  `DETERMINISTIC_GATE_PASS_NOT_ACCEPTANCE` 不等于正式验收。
- [ ] 当前后续修改形成新提交后，在最终候选 clean source 本地重跑同一完整门禁。
- [ ] PR deterministic workflow 在 fresh runner 退出 `0`，不读取真实 Provider/签名 secret。
- [ ] 真实 external fork 取得零 secret 证据。
- [ ] fixed-lab performance/soak workflow 绑定登记设备与实际 artifact hash。
- [ ] protected tag/release environment、required checks、tag 规则和最小权限已配置；当前 inventory 为 runners=0、
  `phase5-lane-b`/`phase5-release` environments 不存在、rulesets=0 且 `main` 未保护。
- [ ] verification 不修改 tracked files、不残留产品进程。
- [x] 验收决议 fail-closed scaffold 已实现：[`acceptance-decision.schema.json`](../../schemas/phase5/acceptance-decision.schema.json)
  固定 43 个 exact gate ID、候选身份、canonical payload 与角色权限，registry 为 43/43。
- [ ] 完成全部 43 个 gate 的可信 source validator；当前生产路径为 `0/43`，全部 43 个稳定返回
  `GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED`。PERF、Authenticode、DSSE、manifest 与 clean-download 的结构解析器
  不能替代系统验签、离线 attestation 验证、受保护运行证明或独立下载，因此正式决议必然阻断。
- [ ] 实现四角色 domain-separated cryptographic signature 或受保护平台 approval receipt verifier；在此之前任何
  非 `PENDING` 角色记录均额外返回 `APPROVAL_RECEIPT_VERIFIER_NOT_IMPLEMENTED`，项目负责人合并承担角色也不能绕过。

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

签字记录使用 `Product`、`Engineering`、`SecurityPrivacy`、`QualityRelease` 四个固定角色。项目负责人可以合并承担
四个角色，但重复 signer 的每条记录必须声明 `authorityMode=MERGED_PROJECT_OWNER`，且四条 `APPROVE` 必须绑定
同一 canonical payload SHA-256。角色签字只批准已通过的 exact gate set；不能把缺失的 Authenticode、GitHub/Sigstore
attestation、clean-download、fixed-lab/硬件、clean VM 或真实 Provider 证据变成 `PASS`。填写入口见
[`acceptance-decision.template.json`](acceptance-decision.template.json)。

## 最终结论

当前结论：`NOT YET ACCEPTED / RELEASE BLOCKED`。

Phase 5 `PASS` 至少需要固定机三轮性能、产品进程 900 秒/5 秒采样 idle、真实产品 Lane A 8 小时、最终签名 RC Lane B、
clean VM、硬件/应用兼容矩阵、真实 Provider smoke 及四角色签字。当前任何 smoke、模型调度或 unsigned spike
均不满足这些条件；在正式性能数据完成前，也不得提升为 `PERFORMANCE ACCEPTED`。
