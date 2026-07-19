# Phase 5 风险登记

- 状态：`ACTIVE`
- 评估日期：2026-07-19
- 分级：概率 `1–5` × 影响 `1–5`；`1–7 低`、`8–14 中`、`15–24 高`、`25 严重`
- owner 角色：Product、Engineering、Security/Privacy、Quality/Release

`OPEN` 表示尚无充分证据；`CONTROLLED` 表示自动化或实机证据覆盖；`ACCEPTED RISK` 只能用于可豁免风险，
且必须有 owner、用户影响和复审日期。不可豁免项失败时保持 `NOT ACCEPTED`。

| ID | 风险 | 初始分 | 主要控制与证据 | 当前状态 / owner |
|---|---|---:|---|---|
| P5-R-001 | 计时/样本选择使性能假绿 | 20 高 | benchmark spec 先冻结；nearest-rank；三轮；不删 outlier | OPEN / Engineering + Quality |
| P5-R-002 | metrics 泄露正文、窗口、路径或凭据 | 25 严重 | default-off、字段 allowlist、schema negative tests、artifact privacy scan | CONTROLLED DEVELOPMENT, FINAL EVIDENCE PENDING / Security/Privacy |
| P5-R-003 | 优化破坏 latest-wins、取消、fail-closed、退出或 Native 稳定性 | 20 高 | Phase 4 严格超集；每项 before/after 正确率与并发回归；Native Windows tests；失败优化立即撤回 | CONTROLLED DEVELOPMENT, FORMAL PERF-09 NOT RUN / Engineering |
| P5-R-004 | 8 小时后内存、handle、timer、fetch 或进程累积 | 20 高 | 完整进程树 5 秒采样、双轨 soak、WER/残留扫描 | OPEN / Engineering + Quality |
| P5-R-005 | installer 漏 Host/migrations/licenses、接受开发路径或把 dirty source 误绑定为 HEAD | 20 高 | 固定 extraResources、clean-source binding、clean VM、解包白名单和 packaged negative tests | DEVELOPMENT PACKAGE CONTROLLED, CLEAN SOURCE/VM OPEN / Quality/Release |
| P5-R-006 | OCR/runtime 清单与真实交付不一致 | 15 高 | D2 Windows OCR；SBOM 把 language pack 标作 OS dependency | OPEN / Engineering + Security |
| P5-R-007 | 签名 secret 暴露给 PR/fork | 25 严重 | protected environment、fork 零 secret、tag-only signing | OPEN / Security + Release |
| P5-R-008 | Main/Host/protocol/resources 部分更新 | 20 高 | 原子 installer、manifest/hash、覆盖安装与回滚 | OPEN / Engineering + Release |
| P5-R-009 | 只扫压缩包而漏 ASAR/安装目录内容 | 20 高 | 解包逐文件 scan，复扫 installed/update cache | OPEN / Security + Quality |
| P5-R-010 | 公网 Provider 波动污染本地性能 | 12 中 | deterministic perf 使用 fake；真实 Provider 独立 smoke | OPEN / Quality |
| P5-R-011 | 发布承诺超过 OS/DPI/多屏/应用证据 | 20 高 | 兼容矩阵、Case ID、LIMITED/UNSUPPORTED 口径 | OPEN / Product + Quality |
| P5-R-012 | source map、测试或本地路径进入正式包 | 16 高 | package whitelist、top-files、bundle/privacy scan | CONTROLLED DEVELOPMENT, FINAL PACKAGE NOT RUN / Security + Release |
| P5-R-013 | MSVC 动态 CRT 导致 clean VM 无法启动 | 16 高 | D9 `/MT`，dumpbin/clean VM 与 SBOM 复核 | OPEN / Engineering |
| P5-R-014 | 普通卸载/清除语义导致密文丢失或残留 | 16 高 | D8、升级/修复/卸载/清除矩阵与 canary | OPEN / Product + Quality |
| P5-R-015 | model schedule/release-equivalent Lane A 被误写为真实产品或 signed RC 证据 | 20 高 | Lane A 绑定实际普通文件并前后复算 hash/size；拒绝 legacy hash、同文件/同内容/symlink；模型 smoke 固定 `acceptance=false`；Lane B 只验独立下载的签名 RC exact bundle | IDENTITY CONTROLLED, PRODUCT RUNNER NOT_IMPLEMENTED_BLOCKER / Quality/Release |
| P5-R-016 | 缺少证书却把 unsigned artifact 发布为 RC | 25 严重 | package/release workflow 对缺少受保护签名身份 fail closed；状态固定 RELEASE BLOCKED | ACTIVE BLOCKER / Release |
| P5-R-017 | Phase 4 未测真实故障与兼容矩阵被错误继承为通过 | 20 高 | 复用 Phase 4 accepted-risk 清单，Phase 5 重新执行或明确 NOT RUN | OPEN / Quality |
| P5-R-018 | 基线被 Phase 5 改动、不同构建模式污染，或当前环境重验失败被错误解释 | 16 高 | 独立 `4ea65dc` worktree、instrumentation-only patch、dev/package 分栏；历史验收与当前重验分别记录 | STRICT-SUPERSET DEVELOPMENT PASS, FROZEN BASELINE PENDING / Engineering + Quality |

## 当前证据边界

- Phase 4 已由项目负责人确认历史验收通过并在 GitHub 合并，验收 SHA 为 `4ea65dc`。旧 SHA 的隔离
  instrumentation-only 重验失败仍构成相对性能 baseline gap，但不推翻历史结论，也不再阻塞当前 dirty
  Phase 5 严格超集开发回归。
- 当前 lint、全仓 typecheck、workspace coverage、Desktop 34 files / 298 tests（行覆盖率 95.53%）与
  Native 2/2 通过；官方 npm audit 为 Critical=0、High=0，50 样本 metrics instrumentation smoke、
  process/privacy、release hardening 与 Lane identity/policy 7/7 selftests 通过。这些均是开发期证据。
- 快速 OCR availability 探测触发 Native Windows test SegFault，已撤回并恢复原始探测；退出侧不稳定试验也已
  撤回。2026-07-19 当前 `pnpm phase4:verify` 完整退出 `0`，Electron E2E 6/6、Phase 2 3/3、Native 2/2。
  [最新归档 deterministic verify](../../artifacts/phase5/local/acceptance-verify-rerun2-20260718-2300/verify-summary.json)
  为 `DEVELOPMENT_GATE_PASS_NOT_ACCEPTANCE`、`strictPhase4Superset=true`、`worktreeDirty=true`、`acceptance=false`。
- 本轮唯一重跑目标改为 `artifacts/phase5/local/final-current-verify-20260719-0350/verify-summary.json` 与
  `artifacts/phase5/local/final-current-installer-20260719-0350/release/evidence-manifest.json`；风险结论只读取
  实际生成字段，不预写 PASS 或永久 PENDING。
- 完整 evidence roots 复扫曾暴露 canonical privacy report 的 `findingCounts.absolutePath` 自引用假阳性；scanner
  仅精确豁免 schema-valid 且内部一致的 `1.1.0` canonical 计数器，普通或伪造 `absolutePath` 仍 fail closed。
  修复后 [privacy-meta rescan](../../artifacts/phase5/local/privacy-meta-rescan-20260719-0348/privacy-evidence.json)
  为 4 roots / 46 files / 0 findings，`PASS`。
- 产品退出实现先释放 `releaseSingleInstanceLock`，进入 Electron app quit lifecycle，再由 quit listener 中的
  `app.exit` 收口退出尾部。正常退出证据必须来自真实 UI command、exact handle 观察的 exit code 与零强制终止，
  不能把失败后的 harness cleanup 当成产品退出。
- [PERF-09 final combined 2×5](../../artifacts/phase5/local/perf09-final-combined-2x5-20260719-0302/summary.json)
  两轮逐轮通过：R1 p50 `281.413ms`、p95/max `368.937ms`；R2 p50 `339.670ms`、p95/max `393.163ms`；
  10/10 成功、failure=0、forced cleanup=0、privacy PASS；但使用 dirty unsigned development
  artifact、未登记设备且不是独占交互会话，正式 signed artifact 3×50 仍为 `NOT RUN`。
- [15 秒产品 idle final hardened 开发自测](../../artifacts/phase5/local/product-idle-final-hardened-dev-20260719-0326/summary.json)
  记录 15 samples / 90 role rows，UI command issued、root exit `0`、forced=false，residual/WER/evidence privacy/
  final binary privacy/isolated cleanup 全 PASS。runner 以 DPI-aware 唯一 Ball、同 PID popup geometry/foreground/
  point 与 `SendInput` click 绑定用户动作；isolated cleanup 只证明测试隔离。该运行不替代正式 900 秒/5 秒采样。
- 此前失败的 PERF-09/idle/package artifacts 原样保留；其 fail-closed 错误证明旧退出时序、UI 绑定与 cleanup
  竞态被捕获，后续开发 PASS 不覆盖或删除这些历史证据。
- 当前 Lane A 仅有短时 deterministic model schedule，未运行产品进程；formal product runner 因缺少
  attested runtime-control contract、test-artifact-only packaged endpoint 与 action driver 而返回
  [`NOT_IMPLEMENTED_BLOCKER`](lane-a-product-runner.md)。该 fail-closed 状态不能降低正式 P5-R-015 风险。
- Lane identity selftest 已覆盖实际文件前后 hash/size、checkout/lockfile 绑定及 legacy hash、同文件/同内容、
  symlink 拒绝；Lane B 也已要求 independently downloaded exact bundle 的 attestation/trusted-root/签名验证。
  这些控制降低了误绑定风险，但正式 Lane A/B 未运行，因此 P5-R-015 不能关闭为已验收。
- no-`SkipBuild` [Dir](../../artifacts/phase5/local/acceptance-dir-rerun-20260718-2240/release/evidence-manifest.json)
  与 [Installer](../../artifacts/phase5/local/acceptance-installer-rerun-20260718-2245/release/evidence-manifest.json)
  开发包均已通过 production build、startup/D8、SBOM/provenance、ASAR/资源白名单、exact hash 与体积门禁；
  prepared package startup/D8 smoke 另有连续 3/3 通过。所有 manifest 仍为 dirty `HEAD+WORKTREE`、
  `acceptanceEligible=false`，应用/Host/installer 为 `NotSigned`，并且 startup smoke 明确不证明 graceful exit
  或 clean VM。P5-R-005 因而只在开发包范围受控；P5-R-016、clean VM、attestation 和 clean-download 仍阻塞发布。

## 不可豁免的停止条件

- 原文、译文、截图、凭据或 Provider body 进入日志、数据库、包、artifact、crash 或 update cache；
- 未 opt-in 联网，或 Renderer/Native Host 直接访问 Provider；
- stale result 覆盖新 selection，或退出后仍有请求/残留进程；
- 签名、publisher、manifest/hash 篡改未被拒绝；
- 数据库不可恢复损坏、可复现 crash/hang、无限重启或高危任意代码执行。

发生翻译隐私/联网/stale-result 问题立即禁用 `translation.enabled` 并回到 Phase 3 source-only。纯性能或打包
回归可以回到 Phase 4 验收代码。两类回滚不得混写。

## 当前外部依赖

| 依赖 | 当前事实 | 发布影响 | 下一证据 |
|---|---|---|---|
| Authenticode 证书/subject | 本机有 `signtool`，没有发布证书配置 | `RELEASE BLOCKED` | 受保护环境中的真实签名与下载后验证 |
| GitHub attestation CLI | 本机 `gh 2.92.0`，低于正式门禁要求的 `2.93.0` | 本机 formal attestation verification `BLOCKED` | 在受保护/独立复核环境固定 `gh >=2.93.0` 并归档版本能力检查 |
| GitHub release controls | protected ruleset/environment、OIDC release context 与 required checks 尚未形成正式证据 | `RELEASE BLOCKED` | 在受保护 tag 上完成签名、attestation 与 clean-download workflow |
| Phase 4 acceptance tag | GitHub merge SHA 已确认，但本地没有指向/包含 `4ea65dc` 的 acceptance tag | 追溯缺口，不推翻历史验收 | 对已批准的验收记录创建可追溯 tag 并归档 |
| A 类低配机 | 未登记 | 低配绝对预算 `NOT RUN` | 固定 4-core/8-GiB Windows 11 设备 |
| C 类物理多屏 | 当前只有单屏 | 多屏/DPI/旋转 `NOT RUN` | 双物理屏、负坐标、混合 DPI、旋转 |
| Windows 10 | 当前无环境 | best-effort 兼容 `NOT RUN` | 隔离 VM/设备记录 |
| 百度测试账号 | 不从环境名推断凭据有效 | PERF-08/真实恢复 `NOT RUN` | 受控账号的脱敏 provider smoke |
