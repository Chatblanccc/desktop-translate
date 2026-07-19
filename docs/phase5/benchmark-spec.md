# Phase 5 Benchmark Spec

- 状态：`FROZEN FOR IMPLEMENTATION`；候选阈值须在 WP2 基线后复审
- schema version：`phase5-metrics-v1`
- 基线代码：`4ea65dcd5c5ef7c56127fe419127d48e0573a65d`
- 目标版本：`0.5.0-phase5`

## 1. 证据等级

| 等级 | 允许结论 |
|---|---|
| Harness smoke | 只证明采集、统计、schema、脱敏和退出码正确 |
| Instrumentation baseline | 证明同设备、同构建模式下的 Phase 4/5 相对变化 |
| Fixed-lab benchmark | 可判断 PERF/RES 绝对预算 |
| Release-equivalent Lane A | 可判断 Main/Renderer/translation 编排长稳，不代表真实 Native |
| Signed-RC Lane B | 可判断真实 Hook/UIA/DXGI/Windows OCR 长稳 |

报告必须带 `evidenceLevel`；低等级证据不得被升级解释。

## 2. 当前候选环境

2026-07-19 本机仅记录为 **B 类候选环境**，只覆盖单屏开发样本；它尚未进入 Git 跟踪的 formal device
registry，最新 PERF-09 证据明确记录 `deviceRegistrationId=unregistered-development-device` 与
`formalMetadataComplete=false`，因此不能称为已登记 fixed-lab 设备：

| 字段 | 值 |
|---|---|
| OS | Windows 11 x64 build `26200` |
| CPU | Intel Core i5-1340P，12 cores / 16 logical processors |
| RAM | 16 GiB |
| GPU | Intel Iris Xe；另存在 GameViewer/Oray 虚拟显示适配器，报告必须披露 |
| 显示 | 单屏物理 `2160×1440`，150% DPI，对应逻辑 `1440×960`，底部任务栏 |
| 电源 | Balanced；正式绝对测量前必须接电并固定一致模式 |
| 当前开发 Node | `24.18.0`；正式 CI/固定实验室仍须使用冻结的 `22.23.1` |

该设备不覆盖 A 类 4-core/8-GiB 低配预算，也不覆盖 C 类双物理屏、负坐标、混合 DPI 和旋转。缺失设备
只能记录 `NOT RUN`，不能用虚拟显示器或 fixture 代替物理矩阵。

### 2.1 当前开发观察值（非正式验收）

- [PERF-03 packaged 1×1](../../artifacts/phase5/local/perf03-host-ready-lease-dev-20260719T060500404Z/summary.json)
  为 `DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE`：Main 启动真实 Host 到 authenticated Pipe ready 的
  p50/p95/max 均为 `118.648ms`，failure=0、forced termination=0，postflight/privacy PASS。计时完成后的
  cleanup 精确绑定同 PID 唯一 Ball 与同 PID 菜单，并以 UIA Invoke 调用唯一启用的 Exit 项；该运行只有
  1 轮 1 样本、使用 unsigned package 和未登记设备，不能代替 formal signed fixed-lab 3×100。formal entry
  在 protected-run receipt、认证指标通道、预先冻结 publisher policy 与完整 namespace trust controller
  实现前固定返回 `FORMAL_PERF03_TRUST_CONTROLLER_NOT_IMPLEMENTED`。
- [PERF-09 final combined 2×5](../../artifacts/phase5/local/perf09-final-combined-2x5-20260719-0302/summary.json)
  为 `DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE`：Round 1 p50 `281.413ms`、p95/max `368.937ms`；
  Round 2 p50 `339.670ms`、p95/max `393.163ms`；10/10 成功、failure=0、forced cleanup=0，privacy PASS。
- [产品 idle 15 秒 final hardened 开发自测](../../artifacts/phase5/local/product-idle-final-hardened-dev-20260719-0326/summary.json)
  记录 15 samples / 90 role rows；UI command issued、root exit `0`、forced=false，residual、WER、evidence
  privacy、final binary privacy 与 isolated cleanup 全 PASS。它不是正式 900 秒/5 秒采样证据。
- no-`SkipBuild` unsigned package 开发测量为：Dir installed `322.146 MiB`；Installer installed
  `322.249 MiB`、installer `87.741 MiB`；Host+non-Electron resources `0.74 MiB`。早期两份 manifest 为
  dirty `HEAD+WORKTREE`；[`3443d875…` clean verify](../../artifacts/phase5/3443d87598d15b697468b0b66755c7e808b76607/clean-verify-local-20260719-rerun1/package/release/evidence-manifest.json)
  已重建 clean unsigned Dir package，但仍为 `acceptanceEligible=false`、`NotSigned`。

以上数据只证明当前 harness 与 development artifact 的可运行性；正式结论仍要求最终候选 clean/signed/attested
artifact、登记设备、完整 run metadata、独占交互会话及冻结样本数。当前机器只有 Profile B 的单物理屏
150% DPI，不覆盖 A 类低配、C 类双屏或 Win10 矩阵。

## 3. 时钟与事件契约

1. 同进程 duration 使用 monotonic clock：C++ `steady_clock`，Node/Electron `performance.now()`；
2. 不跨进程直接相减 timestamp。Native→Main→Renderer 端到端只能由 ETW/QPC controller 或明确校准协议计算；
3. 没有统一时间域时只报告 Native duration、IPC RTT、Main orchestration 和 Main→Renderer ack 四段；
4. Renderer ack 在 React commit 后等待两个 `requestAnimationFrame`，由 Main 同一 monotonic clock测量发送→ack；
5. ack 只表示提交到合成管线，不等于物理像素已可见；实机可见性另验；
6. 每个 sample 使用随机、不含业务含义的 `sampleId`，禁止正文、窗口、坐标、PID/HWND 和路径。

## 4. 样本与统计

- 百分位使用 nearest-rank：排序后取 `ceil(p × N)`；
- 每项报告 `N/p50/p95/max/failureCount`，不静默删除 outlier；
- 每个关键场景三轮独立运行，三轮都需通过；
- 预热样本单独计数且不进入正式分布；
- 污染轮次必须整轮废弃，记录 OS update、杀毒、人工操作或电源变化原因；
- 真实 Provider `N=10` 的 p95 等于 max，报告必须明确；
- Phase 4 与 Phase 5 只有在同设备、同 buildMode、同 harness/schema 时才应用相对 `≤10%` 回归预算。

## 5. PERF 门禁

| ID | 起止点 | 正式样本 | 候选预算 |
|---|---|---:|---:|
| PERF-01 | Electron process create → Ball 2×RAF ack | 30 cold | p50 ≤1.8s；p95 ≤3.0s |
| PERF-02 | warm process create → Ball 2×RAF ack | 10 warmup + 50 | p50 ≤1.0s；p95 ≤1.8s |
| PERF-03 | Main starts Host → Pipe `ready` | 100 | p50 ≤700ms；p95 ≤1.5s |
| PERF-04 | qualified mouse-up → UIA source card ack | 20 warmup + 200 | p50 ≤250ms；p95 ≤500ms |
| PERF-05 | qualified mouse-up → OCR source card ack | 100/fixture group | p50 ≤1.5s；p95 ≤3.0s |
| PERF-06 | Main sends card view model → Renderer 2×RAF ack | 200 | p50 ≤50ms；p95 ≤100ms |
| PERF-07 | fake Provider 100ms → translated card ack | 20 warmup + 200 | total p95 ≤300ms；local overhead p95 ≤200ms |
| PERF-08 | real Provider，独立 smoke | ≥10/target language | successes ≤8s；failure stable；仅报告 |
| PERF-09 | normal product UI exit request → bound root process tree/Host empty | 每轮 50，独立 3 轮 | 每轮 failure=0、p50 ≤2s、p95 ≤5s、max ≤10s |

### 5.1 PERF-09 runner 与证据边界

`pnpm phase5:perf09` 是 PERF-09 正式 runner。正式模式固定为同一 package artifact 的 3 个独立 round，
每轮 50 次；计时从 Ball 右键菜单最后一个已启用的真实“退出”命令发出前开始，到该次启动绑定的根进程树
与 Host 全部归零为止。通过路径禁止调用 `Stop-Process`/`taskkill`；失败 sample 必须先以稳定错误码和
`durationMs` 落盘，之后才允许按该次 PID + creation time + executable hash/path + 隔离 userData
内存绑定做精确强清理。原始 sample 不保存 PID、路径、HWND、窗口标题或异常正文。

产品正常退出实现先调用 `releaseSingleInstanceLock`，再进入 Electron app quit lifecycle，并由 quit listener
调用 `app.exit` 收口退出尾部。通过路径只接受真实产品 UI command 与绑定进程集合自然归零，禁止把 runner
在失败证据落盘后的 exact-identity cleanup 计作产品正常退出或性能成功样本。

正式运行还必须同时满足：

- clean worktree，package manifest 的 `gitSha/sourceIdentity` 与 HEAD 一致，且
  `developmentDirty=false`、`acceptanceEligible=true`；
- manifest 的 package/startup/supply-chain/signature gates 均为 `PASS`，应用、Host、installer
  属于同一 Authenticode subject；现行应用、Host、ASAR、installer 与完整 package file manifest
  都必须通过 exact-set/hash 复验；此外必须用独立 trusted root 离线复验 final release manifest 与四个
  artifact 的 GitHub/Sigstore attestation，并绑定独立 clean-download `PASS`；
- `phase5-perf09-run-metadata-v1` 元数据完整，且 OS build/architecture、CPU/core、RAM、GPU、
  显示分辨率/DPI/方向/任务栏、活动电源方案/接电状态、Node/Electron/Host 版本与实时设备一致；
  另需登记 SSD 类型、OCR language packs、设备/run/workflow ID，并确认独占交互会话、前台输入、
  debugger/无关任务、杀毒扫描和 OS update 干扰控制；
- `deviceRegistrationId` 必须命中 clean HEAD 中 Git 跟踪的 `phase5-perf09-device-registry-v1` 活跃记录，
  且登记的固件身份摘要与实时设备一致；仅填写一个看似合法的 ID 不构成登记；
- 每个 round 独立计算 nearest-rank，三轮逐轮满足 p50/p95/max/failure 门槛；任一轮失败即整体失败。

正式元数据可从 [严格字段模板](perf09-run-metadata.template.json) 复制并逐项替换；设备登记表可参考
[故意无效的登记模板](perf09-device-registry.template.json)，但实际登记表必须在 RC 构建前进入受评审的
clean HEAD。模板中的 `replace-*`
和数值 `0` 故意无法通过正式校验，禁止把模板本身当成设备记录。顶层只允许
`schemaVersion/run/environment`。`run` 固定包含
`runId/workflowName/workflowRunId/operatorRole/deviceRegistrationId/buildMode/evidenceLevel/
dedicatedInteractiveSession/foregroundInputExclusive/debuggerClosed/unrelatedForegroundTasksClosed`；
`environment` 固定包含上述硬件、显示、工具链和干扰控制字段，未知字段 fail closed。

开发态必须显式使用小样本，且永远输出 `DEVELOPMENT_SELFTEST_PASS_NOT_ACCEPTANCE`：

~~~powershell
pnpm phase5:perf09:selftest
pnpm phase5:perf09:dev -- -RoundCount 2 -SamplesPerRound 5 -PackageDirectory <win-unpacked>
pnpm phase5:perf09 -- -PackageDirectory <signed-win-unpacked> -PackageEvidenceManifest <evidence-manifest.json> -InstallerPath <signed-setup.exe> -FinalReleaseManifest <final-release-manifest.json> -CleanDownloadVerification <clean-download-verification.json> -IndependentTrustedRoot <independent-trusted-root.jsonl> -DeviceRegistry <tracked-device-registry.json> -RunMetadata <run-metadata.json>
~~~

PERF-04/05 的正式输入只能来自仓库自有 fixture 上的测试专用 `SendInput` helper，或代表性应用上的人工物理
鼠标。仅向 Pipe 写 `selection/result` 的测试不属于 PERF-04/05。

## 6. 资源门禁

- 以启动根进程和 ancestry/Job 跟踪 Main、Renderer、GPU、utility、crashpad 与 Host；不能按进程名漏算；
- 每 5 秒采样；正式 idle 的 900 秒全部进入测量窗口，不在该窗口内另扣 5 分钟 warmup。若实验需要 warmup，
  必须在 900 秒计时开始前完成并单独记录；
- 容量使用 `Private Working Set`，趋势使用 `Private Bytes`，禁止混称；
- CPU 为整个进程树 processor time / wall time / logical processor count；
- 子进程使用稳定 role + generation，PID 在落盘前移除；
- RES-01：空闲 900 秒、每 5 秒采样，CPU avg ≤1%、p95 ≤3%；
- RES-02：同一 900 秒窗口内进程树 Private Working Set ≤350 MiB，Host ≤100 MiB；
- RES-03：8 小时结束相对稳定基线增长同时 ≤50 MiB 且 ≤20%，无持续单调增长；
- RES-04：handle/GDI/USER 增长同时 ≤10% 且 ≤100，连续 60 分钟不单调上升；
- RES-05：Host 有限退避并熔断，无 restart storm；
- RES-06：退出后进程、metrics 文件句柄和临时 runner 为 0。

产品 idle runner 必须以 DPI-aware 坐标定位唯一 Ball，并把同 PID 新 popup 的 geometry、foreground 与 click
point 同时绑定后才允许 `SendInput` click；随后通过 exact process handle 读取 root exit code。UI command issued、
root exit `0` 与 `forcedTerminationUsed=false` 才构成产品正常退出；后置 isolated cleanup 仅构成测试环境清理证据。

## 7. 包体门禁

报告 installer、installed、ASAR、unpacked、Host/resources、top-30：

- installer ≤150 MiB；
- installed directory ≤350 MiB；
- Windows OCR 路线的 Host + 非 Electron runtime resources ≤25 MiB；
- 相同口径相对冻结 packaged baseline 增长 ≤10%；
- 正式包不得含 source map、test、coverage、fixture、fake transport、开发脚本、凭据或本地绝对路径。

首个 unsigned packaging spike 后可收紧候选值；放宽必须在实现前记录 Product/Engineering/Quality 批准。

## 8. Lane A / Lane B

### Lane A

- 同 git SHA、lockfile、toolchain、production optimization 的 release-equivalent test artifact；
- fake Native + fake Provider，8 小时，每 30 秒约一次 selection；
- acquisition mix 与 translation outcome mix 分开统计；
- 验证编排、latest-wins、取消、故障和退出，不声称真实 Hook/UIA/OCR；
- fake 注入必须从 production installer/ASAR 排除，并记录两种 artifact hash 和构建差异。

### Lane B

- 最终签名 RC、专用交互式 Windows 会话、Provider disabled；
- 真实 Host/Hook/UIA/DXGI/Windows OCR，8 小时；至少 600 UIA + 300 OCR 及拒绝场景；
- 每小时 Host kill/restart 或 display/DXGI 恢复；
- sleep/resume、锁屏、多屏/DPI/旋转另作离散记录；
- fake transport 不得注入 packaged app，真实 Provider 另作最小化 smoke。

## 9. 输出 schema 与隐私

允许字段：schema/version、git/binary hash、buildMode、evidenceLevel、role、scenario、sourceKind、stableErrorCode、
characterCountBucket、duration、resource values、round/sample counts、pass/fail。

禁止字段：原文、译文、截图、窗口标题、精确坐标、PID/HWND、完整路径、Pipe/nonce、APP ID、密钥、salt、
签名、request/response body 或原始异常。MetricsSink 默认关闭，未知字段必须拒绝而不是透传。

## 10. 基线流程

1. 在独立 worktree checkout `4ea65dc`；
2. 仅应用 default-off instrumentation patch，记录 patch/hash；
3. 运行完整 Phase 4 门禁，证明默认行为等价；
4. 分别采三轮 development 与 unsigned packaged baseline；
5. 冻结 summary、environment、binary manifest 和 harness schema；
6. Phase 5 优化后在相同条件复测；不同 buildMode 不互比。
