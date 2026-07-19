# Phase 5 开发与验收总计划

- 状态：已冻结并执行；`IN DEVELOPMENT`
- 计划日期：2026-07-18
- 执行快照：2026-07-19；`NOT YET ACCEPTED / RELEASE BLOCKED`
- 已验收代码基线：Phase 4 合并提交 `4ea65dcd5c5ef7c56127fe419127d48e0573a65d`
- 建议目标版本：`0.5.0-phase5`
- 交付口径：Windows x64 签名 Release Candidate；是否升级为公开 V1 由发布评审单独决定
- 目标平台：受支持的 Windows 11 x64；Windows 10 22H2 x64 仅保留 best-effort 兼容口径

本文用于在任何 Phase 5 行为改动之前冻结范围、测量方法、开发顺序、验收证据和发布责任。Phase 5
不是新增产品功能的阶段；它把已经验收的本地取词与在线翻译闭环提升为可测量、可长时间运行、可打包、
可审计和可签字发布的候选版本。

截至 2026-07-19，Phase 4 已在 GitHub 合并 SHA `4ea65dc` 上完成历史验收。Phase 5 实现提交
`a08cc6ca53727b446d7d10f5fbd0e1ae26e657ea` 的 clean-HEAD `phase5:verify` 已完整退出 `0`，状态为
`DETERMINISTIC_GATE_PASS_NOT_ACCEPTANCE`、`strictPhase4Superset=true`、`worktreeDirty=false`、
`acceptance=false`；同次 clean unsigned Dir package 的 build/package/startup/supply-chain 门禁通过，但应用与
Host 均为 `NotSigned`，release 仍为 `RELEASE BLOCKED`。Desktop 308/308、Electron E2E 6/6、Native 2/2
和 coverage 同次通过；远程 PR CI 仍待执行。

[PERF-09 final combined 2×5](../../artifacts/phase5/local/perf09-final-combined-2x5-20260719-0302/summary.json)、
[15 秒产品 idle final hardened](../../artifacts/phase5/local/product-idle-final-hardened-dev-20260719-0326/summary.json)
与 [PERF-03 packaged 1×1](../../artifacts/phase5/local/perf03-host-ready-lease-dev-20260719T060500404Z/summary.json)
开发运行均通过；PERF-03 单样本为 `118.648ms`、failure/forced termination 为 `0`。这些缩减运行仍为
unsigned/non-acceptance，formal PERF-03 trust controller 与 approval receipt verifier 当前均 fail closed。
正式签名、attestation/clean-download、fixed-lab PERF-01–09、PERF-03 3×100、
PERF-09 3×50、900 秒 idle、Lane A/B 8 小时、clean VM、兼容矩阵、真实 Provider 与签字仍未完成。

## 1. 阶段目标与范围

Phase 5 的仓库既定核心是性能、长稳、资源、包体、供应链、签名与发布门禁；本计划建议把可安装、可升级、
可卸载的签名 RC 冻结为这些门禁的实际载体。完整建议范围为：

1. 启动、UIA、OCR、结果卡和翻译编排的 p50/p95 性能；
2. 8 小时 soak、故障注入、Host 重启与退出长稳；
3. Electron Main、Renderer、Native Host 的 CPU、内存、句柄和残留进程门禁；
4. installer、unpacked 目录、Native Host 和运行资源的包体门禁；
5. 实际交付依赖的 SBOM、许可证、hash、来源和漏洞审计；
6. Windows installer 的安装、升级、卸载、签名、发布和回滚门禁；
7. Phase 1–4 的严格超集回归以及遗留兼容性风险复评。

### 1.1 明确不进入 Phase 5 的内容

- 历史、收藏、持久翻译缓存、账号和跨设备同步；
- 词典、音标、发音、例句、术语库和富文本；
- 第二家 Provider、自动 Provider 切换、自有代理或公共生产密钥；
- 云 OCR、截图上传、剪贴板轮询或模拟 `Ctrl+C`；
- 提权、`uiAccess`、驱动、服务、注入或规避 DRM/反作弊；
- 没有独立产品规格和 ADR 的 PaddleOCR/runtime/model 引入。

范围外项目不得以“顺手优化”为由进入 Phase 5。确需新增时先变更产品规格、风险登记、包体预算和验收
清单，再决定是否仍属于 Phase 5。

## 2. 启动前必须冻结的决策

Phase 4 已以 `PASS WITH ACCEPTED RISKS` 验收，Phase 5 可以开始；但以下决策必须在首个行为改动 PR
之前完成并写入产品规格或 ADR：

| ID | 决策 | 本计划建议 | 冻结证据 |
|---|---|---|---|
| D1 | Phase 5 发布口径 | 先交付签名 RC，四方发布签字后再决定是否称为公开 V1 | Phase 5 product spec |
| D2 | OCR runtime | V1 继续使用系统 `Windows.Media.Ocr`，不随安装包携带 Paddle/OpenCV/model | 更新 OCR 供应链记录；必要时 ADR |
| D3 | Installer | 优先验证 per-user、无需管理员权限的 NSIS x64 installer | packaging spike + ADR/config review |
| D4 | 自动更新 | kickoff 二选一：RC 仅提供签名手动更新；公开 V1 则必须纳入 HTTPS、签名 manifest、原子回滚 | 发布 ADR |
| D5 | 签名身份 | installer、项目自有 Electron PE/Host/DLL 使用同一发布身份；第三方二进制保留上游签名并锁定 hash；更新 manifest 使用受保护的发布签名 | 密钥保管与 release environment 记录 |
| D6 | 支持平台 | Windows 11 为发布基线；Windows 10 保持 best-effort 且不作安全支持承诺 | 兼容性规格 |
| D7 | 性能实验室 | 固定低配参考机、主参考机和显示矩阵；记录硬件、OS build、DPI、OCR language pack | benchmark spec |
| D8 | 数据卸载语义 | 明确普通卸载、清除全部本地数据和重装时对 settings/secrets 的处理 | 产品文案 + packaged E2E |
| D9 | MSVC runtime | 二选一并验证：项目自有 Native 二进制使用 `/MT`，或 installer 安装并审计所需 VC Runtime | toolchain config + clean VM evidence |

当前实际 OCR 使用 `Windows.Media.Ocr`，Paddle adapter 关闭且不打包模型。Phase 5 的 SBOM 必须描述真实
交付物，不能照抄早期 Paddle/OpenCV 占位清单。若 D2 改为捆绑第三方模型，必须新增 ADR、模型精度矩阵、
最低 CPU 能力、runtime/model hash、许可证、冷启动和新包体预算；该变更不得与普通性能优化混在同一 PR。

## 3. 开发门禁与基线管理

### G0：Phase 4 验收归档

- 固定基线 SHA 为 `4ea65dcd5c5ef7c56127fe419127d48e0573a65d`；
- 归档 [PR #2](https://github.com/Chatblanccc/desktop-translate/pull/2) 与
  [Phase 4 Windows run 29634271260](https://github.com/Chatblanccc/desktop-translate/actions/runs/29634271260)；
- GitHub artifact `phase4-verification-29634271260-1` 将于 2026-08-01 到期；到期前保存非敏感 evidence
  manifest、大小 `213,037` bytes 与服务端 digest
  `sha256:a70659c854a169c8352f4602c8840bd19fce3b582032ac8b64e7995b58862937`，不能把短期下载链接当长期档案；
- 保留未执行项为接受风险，不把 fake Provider 或 fixture 证据冒充实机证据；
- Phase 5 验收时重新复评真实故障、外部 fork、DPI、多屏、旋转、应用和权限矩阵。
- Phase 4 验收文档已修订为 GitHub merged SHA `4ea65dc` 的历史通过结论；可追溯 acceptance tag 当前仍
  `PENDING`，这是归档追溯缺口，不推翻历史验收。`4ea65dc` 是被验收的代码 SHA，不声称它本身已包含
  随后补写的验收记录。

### G1：Phase 5 规格冻结

在优化前新增并评审：

- `docs/phase5/product-spec.md`；
- `docs/phase5/benchmark-spec.md`；
- `docs/phase5/risk-register.md`；
- `docs/phase5/acceptance-checklist.md`；
- `docs/phase5/validation-report.md`；
- packaging/signing/update 发生架构变化时的 ADR。

G1 同时修订全局架构与隐私基线：Windows OCR 是当前真实 runtime；未实现的 history/favorites/cache
标为 `N/A + 零写入证明`；SBOM 只列真实交付物。不得让早期 Paddle、历史或缓存设想继续冒充现状。

### G2：版本与构建来源统一

- 根 workspace、Desktop、installer 和 release manifest 的产品版本统一为 `0.5.0-phase5`；Windows
  VERSIONINFO 使用合法数字元组（建议 `0.5.0.0`），并另以字符串字段保存 `0.5.0-phase5`；
- 修复 Native 仍报告 `0.3.0-phase3` 的版本漂移，改为单一可审计版本来源；
- Node、pnpm、Electron、Windows SDK、CMake、编译器和 lockfile 固定；
- Release Native 构建以 MSVC x64 为正式基线；便携 llvm-mingw 继续作为开发/交叉验证路径；按 D9 明确
  `/MT` 或 VC Runtime 安装策略，禁止只在已有开发工具的机器上偶然可运行；
- 所有性能结果绑定 git SHA、构建配置和二进制 SHA-256。

## 4. 工作包、依赖与退出条件

建议依赖链：`WP0 → WP1 → WP2 → WP3`；随后 `WP4 开发长稳` 与 `WP5 打包/供应链` 可并行，二者都完成
后进入 `WP6 CI/发布集成`，最后由 `WP7` 对最终候选包执行完整实机矩阵和最终 RC 长稳。WP4 的开发长稳
用于提前发现泄漏，不代替 WP7 对最终签名 RC 的 8 小时证据。

| 工作包 | 主要开发 | 交付物 | 退出条件 | 估算 |
|---|---|---|---|---:|
| WP0 规格与风险冻结 | D1–D9、版本、指标、owner、ADR | Phase 5 五份文档与 issue/task 清单 | 无未决范围歧义；指标可复现 | 1–2 人日 |
| WP1 脱敏测量基础设施 | monotonic timing、MetricsSink、进程树资源采样、统计器 | instrumentation-only baseline commit、perf/resource 脚本、JSON Schema、privacy tests | default-off 行为等价；样本不含敏感内容；重复运行一致 | 2–3 人日 |
| WP2 基线与预算冻结 | 在固定机器采集三轮 instrumentation-only Phase 4 基线，并建立首个 unsigned packaged 基线 | dev/package 两套 baseline JSON/summary、ETW 摘要、最终预算 | 四方确认阈值；禁止先优化后补基线；不同构建模式不互比 | 2 人日 |
| WP3 性能优化 | 启动、Host ready、UIA/OCR、卡片首绘、翻译编排、退出 | 每项 before/after 报告和回归测试 | 达到预算；无正确率、隐私或行为退化 | 4–6 人日 |
| WP4 开发长稳与故障恢复 | 双轨 8h workload、Host kill、断网、超时、显示变化、sleep/resume | soak/fault harness、趋势报告、WER/残留扫描 | 开发构建两条 8h lane 通过；无泄漏和重启风暴 | 3–4 人日 + 2×8h 运行 |
| WP5 打包与供应链 | installer、extraResources、ASAR、SBOM、licenses、manifest、签名/更新 | unsigned/signed RC、SBOM、notices、checksums | 干净 VM 安装；签名/包体/隐私门禁通过 | 4–6 人日 |
| WP6 CI 与发布门禁 | PR、性能/长稳、protected release 三类 workflow | `phase5-windows.yml` 与 evidence manifest | fork 零 secret；同 SHA 证据可追溯 | 2–3 人日 |
| WP7 RC 验收与签字 | 实机矩阵、installer 升级/回滚、release-equivalent Lane A、最终 signed-RC Lane B、风险复评 | validation report、签字表、release bundle | 两条 8h lane 按 7.3 的制品边界通过，且完成定义全部满足 | 2–3 人日 + 2×8h 运行 |

单工程师串行预计 `20–29` 人日，即约 4–6 周；Release/QA 可并行时约 3–4 周。估算不包含签名证书采购、
外部安全评审排期和缺少物理多屏设备造成的等待。

## 5. 性能测量契约

### 5.1 统一规则

1. 各进程内部使用 monotonic clock：Native 用 `std::chrono::steady_clock`，Main/Renderer 用
   `performance.now()`/等价 monotonic API。不同进程的 clock origin 不得直接相减。跨 Native/Main/Renderer
   的端到端指标使用 ETW/QPC 统一时间域的 benchmark controller；若该 controller 不可用，只报告各进程
   分段 duration 和 IPC round-trip，不得伪造跨进程总耗时。禁止用墙钟或 ISO 时间计算延迟。
2. 百分位采用 nearest-rank：排序后 `ceil(p × N)` 的样本；报告 `N/p50/p95/max/failureCount`。
3. 不静默删除 outlier。若 Windows Update、杀毒扫描或人工操作污染一轮，废弃并重跑整轮，报告原因。
4. 每个关键场景执行 3 个独立轮次；三个轮次都必须同时满足绝对阈值与相对回归预算。
5. 绝对性能门禁只在固定实验室或自托管 Windows runner 执行；共享 GitHub runner 只验证 harness、统计器和
   明显回归，不对硬件相关 p95 作发布结论。
6. 真实 Provider 的公网耗时与本地编排开销分开。真实网络 p50/p95只报告，不作为 deterministic PR gate，
   也不混入 `phase5:perf:smoke` 或 PERF-09。`phase5:provider-smoke` formal runner 已暴露，并将真实百度
   health、timeout、network、malformed-response、recovery 与 aggregate 拆成 append-never 证据；当前只有
   runner/selftest 通过，没有受控账号的正式证据。8 秒总截止、source-only 首显和 UI 可用性仍是硬门禁。
7. 指标 artifact 只允许 git/binary hash、角色、场景、来源、稳定错误码、字符数桶、耗时与资源数值；禁止
   原文、译文、截图、窗口标题、精确坐标、PID/HWND、完整路径、Pipe、nonce、凭据、签名或 body。
8. WP1 从 `4ea65dc` 建立仅含 default-off instrumentation 的基线提交，必须先跑完整 Phase 4 门禁并证明
   默认路径行为等价。开发态与 packaged 态分别建立基线；`10%` 相对回归只在相同构建模式、相同 harness
   schema/version 和相同设备间比较，不能拿未打包的 Phase 4 与 ASAR/installer Phase 5 直接相减。

当前 clean-HEAD Phase 5 严格超集回归通过不填补第 8 条：独立 `4ea65dc` instrumentation-only 三轮 baseline
仍是明确 gap，因此当前开发数据不得用于 Phase 4→5 的正式 `≤10%` 相对回归结论。

Native IPC v1 拒绝未知字段。不得为了方便给 `selection/result` 偷加 timing 字段；优先使用受控 benchmark
probe、显式 metrics channel 或脱敏 stderr JSONL。若确需改协议，必须同步 JSON Schema、TS/C++ 契约、
golden frames、协议版本和 ADR。

### 5.2 参考设备

kickoff 必须登记具体硬件资产；至少覆盖：

| 设备 | 最低要求 | 用途 |
|---|---|---|
| A 低配参考机 | 4 核 CPU、8 GiB RAM、SSD、Windows 11 x64、100% DPI | 候选低配基线；是否成为最低支持配置由 D7/Product 冻结 |
| B 参考机 | 8 核 CPU、16 GiB RAM、SSD、Windows 11 x64、150% DPI | 主报告与日常优化 |
| C 显示矩阵 | 双物理屏、负坐标、混合 DPI，至少一屏可旋转 | 布局、DXGI、热插拔与长稳 |

每次报告记录 OS build、电源模式、CPU、RAM、GPU、显示布局/DPI、OCR language pack、Node/Electron/Host
版本。笔记本必须接电并固定电源模式；测量期间关闭调试器和不相关前台任务。

### 5.3 候选性能预算

以下是开发启动预算。WP2 完成后可以基于未修改的 Phase 4 基线收紧；任何放宽都必须在实现前由
Product、Engineering、Quality 共同记录原因，不能为了让现有结果变绿而临时改数值。

| ID | 指标与起止点 | 样本 | 候选门槛 |
|---|---|---:|---:|
| PERF-01 | 冷启动：创建 Electron 进程 → Ball 首次完成绘制 | 每设备 30 次 | p50 ≤ 1.8s；p95 ≤ 3.0s |
| PERF-02 | 热启动：OS cache 热 → Ball 首次完成绘制 | 10 次预热 + 50 次 | p50 ≤ 1.0s；p95 ≤ 1.8s |
| PERF-03 | Main 启动 Host → Named Pipe `ready` | 100 次 | p50 ≤ 700ms；p95 ≤ 1.5s |
| PERF-04 | UIA：合格鼠标抬起 → source card 首次绘制 | 20 次预热 + 200 次 | p50 ≤ 250ms；p95 ≤ 500ms |
| PERF-05 | OCR：合格鼠标抬起 → source card 首次绘制 | 每 fixture 组 100 次 | p50 ≤ 1.5s；p95 ≤ 3.0s |
| PERF-06 | Main 发布卡片状态 → Renderer paint ack | 200 次 | p50 ≤ 50ms；p95 ≤ 100ms |
| PERF-07 | fake Provider 固定 100ms 延迟 → translated card | 20 次预热 + 200 次 | 总 p95 ≤ 300ms；本地额外开销 p95 ≤ 200ms |
| PERF-08 | 真实 Provider（独立 `provider-smoke`，不属于 deterministic perf gate） | 每目标语言至少 10 次公开固定文本 | 健康场景必须有成功样本且全部 ≤ 8s；故障场景稳定降级；只报告 p50/p95 |
| PERF-09 | 真实产品 UI 正常退出请求 → 绑定 Electron/Host/Renderer 进程树归零 | 每轮 50 次，独立 3 轮 | 每轮 failure=0、p50 ≤ 2s、p95 ≤ 5s、硬上限 10s |

除绝对预算外，同一设备、同一场景相对 Phase 4 冻结基线不得回退超过 `10%`。OCR 性能必须与文本
正确率、no-text 和错误率一起报告，禁止通过缩小图片、少识别文本、降低质量门槛或绕过 OCR 制造绿色结果。

退出实现的产品边界为：释放 `releaseSingleInstanceLock`，进入 Electron app quit lifecycle，并由 quit listener
调用 `app.exit` 收口退出尾部。PERF-09 的通过路径只计算真实 UI command 到绑定进程集合自然归零；失败证据
落盘后的 exact-identity harness cleanup 仅用于恢复测试环境，不能记为产品正常退出或成功样本。
PERF-08 的 `N=10` 时 nearest-rank p95 等于最大值，报告必须注明这一统计含义，不能把它解释为稳定 SLA。

## 6. 资源、长稳与包体预算

### 6.1 资源候选门槛

| ID | 场景 | 门槛 |
|---|---|---|
| RES-01 | 启动后空闲 900 秒、每 5 秒采样，整个进程树 | 平均 CPU ≤ 1%；p95 ≤ 3% |
| RES-02 | 同一 900 秒窗口，Main + Renderer + Electron GPU/utility/crashpad + Host private working set | 总量 ≤ 350 MiB；Host ≤ 100 MiB |
| RES-03 | 8 小时混合负载内存趋势 | 结束相对稳定基线增长同时满足 ≤ 50 MiB 且 ≤ 20%；无持续单调增长 |
| RES-04 | handle/GDI/USER object | 结束相对稳定基线增长同时满足 ≤ 10% 且 ≤ 100；任意连续 60 分钟不单调上升 |
| RES-05 | Host 重启 | 故障按现有上限退避并熔断；不形成无限重启；UI 始终可退出 |
| RES-06 | 退出 | Electron/Node/selection-host 残留进程为 0；临时 metrics 文件句柄为 0 |

### 6.2 包体候选门槛

包体必须同时报告，不允许只选择最小数字：

- 压缩 installer；
- unpacked/安装后目录；
- Electron ASAR 与 unpacked 文件；
- `selection-host.exe`、migrations、licenses 和其他 `extraResources`；
- 若实现更新：全量更新包和增量更新包；
- top 30 最大文件及与基线的差异。

候选上限：installer `≤ 150 MiB`，安装后目录 `≤ 350 MiB`，Windows OCR 路线下 Native Host 与非 Electron
运行资源合计 `≤ 25 MiB`。冻结后任一口径增长超过 `10%` 必须有 owner 审批。正式包禁止包含 source map、
测试、coverage、Playwright、开发脚本、未使用 locale、绝对本地路径、真实凭据或调试截图；受控调试符号只
能作为独立、限权 CI artifact 保存。

当前 no-`SkipBuild` unsigned development package 已满足候选绝对体积：Dir installed `322.146 MiB`；Installer
installed `322.249 MiB`、installer `87.741 MiB`；Host+non-Electron resources `0.74 MiB`。早期 Installer/Dir
测量来自 dirty `HEAD+WORKTREE`；`a08cc6c…` 的 clean verify 已重新生成 clean unsigned Dir package，
`developmentDirty=false`，但仍为 `acceptanceEligible=false`、`NotSigned`。这些结果只证明开发包预算与链路，
不是最终 RC；clean signed Installer、attestation、clean-download 与 clean VM 仍未取得。

资源采样器以启动根进程和 Windows Job/process ancestry 跟踪完整进程树，不能靠进程名猜测或漏掉 Electron
GPU、utility、crashpad 子进程。PID 只用于本次采样关联，写入 artifact 前删除或替换为稳定角色标识。

产品 idle runner 以 DPI-aware 坐标绑定唯一 Ball，并要求同 PID 新 popup 同时满足 geometry、foreground 与
click point 约束后才发出 `SendInput` click；随后通过 exact process handle 读取 root exit code。UI command
issued、root exit `0`、forced=false 才证明产品正常退出；后置 exact cleanup 只证明隔离环境已收净。
容量门禁使用 Windows `Private Working Set`；泄漏趋势同时报告 `Private Bytes`，二者禁止混称。CPU 百分比
按整个进程树处理器时间除以墙钟时间与逻辑处理器数归一为“整机容量百分比”。采样间隔为 5 秒，启动后
Lane A/B 长稳资源分析的前 5 分钟只作 warmup；900 秒 idle 的全部样本均进入测量窗口，若需要预热必须在
idle 计时开始前完成并单独记录。子进程重启后以 role + generation 续接统计，不能把新 PID 当作资源归零。

## 7. 8 小时 soak 与故障注入设计

### 7.1 双轨主长稳

一条 fake fixture 不能证明真实 Hook/UIA/DXGI/OCR 长稳；Phase 5 必须执行两条独立的 8 小时 lane：

**Lane A：确定性产品编排长稳（release-equivalent test artifact）**

- 使用 fake Native Host 与 fake Provider，避免真实凭据、配额和公网波动污染 Electron/Main/Renderer、
  translation、credential、latest-wins 与退出结论；
- 该 lane 只能运行于同一 git SHA、lockfile、toolchain 和 production optimization 构建出的专用测试制品；
  它可以开放受编译门禁约束的 fake 注入，但该门禁和 fake 依赖必须从公开 installer/正式 ASAR 排除。证据
  manifest 记录测试制品 hash、正式制品 hash、构建参数差异和排除扫描，因此不得声称它就是最终签名包；
- 总时长不少于 8 小时；每 30 秒注入一次结构化 selection，目标约 960 次；
- acquisition fixture 分布：模拟 UIA result 70%、模拟 OCR result 30%；它们只验证消费和编排，不声称
  执行了真实 UIA/DXGI/OCR；
- translation 分布独立统计：source-only 20%、成功 60%、recoverable failure + manual retry 15%、
  non-recoverable failure 5%；不得把采集来源和翻译状态混成一个相加百分比；
- 每 30 分钟注入 Pipe disconnect、Provider timeout/malformed response、凭据删除/替换、translation
  disable/enable、display change 或 shutdown race；每 2 小时执行卡片 dismiss、暂停/恢复和设置窗口开关。

**Lane B：真实 Native acquisition 长稳**

- 在专用交互式 Windows 会话安装并启动最终签名 RC，使用真实 `selection-host.exe`、真实
  Hook/UIA/DXGI/Windows OCR；Provider 关闭，避免把公网因素混入 acquisition 结论。fake transport 不得
  注入 packaged app；签名 RC 的真实 Provider 成功/故障恢复另作限定 smoke；
- 使用公开、固定的本地 Notepad/HTML/图片 fixture，并由真实系统鼠标事件驱动合格选区；仓库专用的
  test-only input helper 可以在自有 fixture 上调用 `SendInput` 产生鼠标手势，但必须从正式包排除，且不得
  用于读取任意目标或模拟复制；代表性真实应用矩阵仍使用人工物理鼠标。禁止只向 Pipe 伪造
  `selection/result` 冒充真实采集；
- 总时长不少于 8 小时；目标至少 600 次 UIA 与 300 次 OCR，另含 no-text、timeout、protected/black
  frame 等拒绝场景；
- 每 60 分钟注入 Host kill/restart、display change 或 DXGI access-lost/rebuild 场景；独立记录 Hook
  health、UIA/OCR latency、queue drop、restart/backoff 和资源趋势；
- sleep/resume、锁屏/解锁、主屏切换、DPI/分辨率变化和物理多屏热插拔单独执行并记入最终报告，
  不与 deterministic percentile 混算。

Renderer paint 结束点通过 default-off metrics 模式下的专用 Preload/Renderer paint acknowledgement 采集：
React 状态提交后，在窗口 visible 且未被 background throttling 的前提下等待两个 `requestAnimationFrame`，
再返回稳定 sample ID。Main 用自己的 monotonic clock 测量“发送 view model → 收到 ack”的 duration；ack
不携带 Renderer 本地时间戳，不开放通用 IPC，也不进入普通生产日志。该指标表示已提交到合成管线，不等同
物理像素可见；真实可见性仍由 Playwright screenshot/实机观察单独验收。

### 7.2 独立压力场景

- rapid selection：短时 5–10 Hz，验证 latest-wins、bounded queue 和旧结果丢弃；
- restart storm：连续终止 Host，验证有限退避、熔断、稳定运行后恢复计数与零孤儿进程；
- 网络风暴：fake transport 在成功、超时、5xx、限流、畸形响应间切换，验证无自动重试；
- 退出风暴：翻译、OCR、凭据加密或 display restart 挂起时连续执行退出；
- 数据风暴：重复保存/替换/删除凭据，验证 generation/CAS、SQLite/WAL 和明文零泄漏。

### 7.3 8 小时通过条件

- `0` crash、hang、unhandled rejection、stale result、敏感落盘和残留进程；
- source-only 路径始终可用，Provider 故障不把 Native lifecycle 置为 faulted；
- 无无限重启、无无限自动重试、无失控队列、timer 或 fetch；
- RES-03/04 全部通过；Windows WER/Application Error 与相关 crash dump 为 `0`；
- 结束后对 userData、Temp、artifact、数据库/WAL、crash/WER 做 UTF-8/UTF-16LE 隐私 canary 扫描；
- WP4 先对开发候选执行两条 lane；WP7 在同一 git SHA 上重跑 Lane A 的 release-equivalent test artifact，
  并在完成 PE/installer 签名后直接对最终签名 RC 重跑 Lane B。两者由同一 evidence manifest 关联，但明确
  记录不同 artifact hash；Lane A 不得冒充生产包证据。最终 RC 的 PE、ASAR、Host、installer 或运行资源
  任何 bit 发生变化（包括重新签名），Lane B、packaged smoke 与安装证据全部失效；若改动触及源码、依赖、
  构建参数或编排逻辑，Lane A 证据也失效。只更换独立、非运行时的发布说明时执行完整 release smoke 并
  更新 evidence manifest。

## 8. 打包、SBOM、签名与更新计划

### 8.1 Packaged app

打包 spike 比较维护成本、NSIS per-user、ASAR、`extraResources`、签名和更新能力；建议优先验证 NSIS
per-user，以保持 Native Host 普通权限运行。最终配置必须：

- Electron Main/Preload/Renderer 进入生产 ASAR；
- `selection-host.exe` 固定放到 packaged code 已限定的 `resources/selection-host/`；
- migrations 固定放到 `resources/migrations/`；
- licenses/notices、版本 manifest 和 hash manifest 随包提供；
- packaged 模式拒绝 `SELECTION_HOST_PATH` 等任意开发路径覆盖；
- clean VM 覆盖非 ASCII 用户目录、标准用户、无 OCR language pack、断网首次启动；
- 最终生产 artifact 的 packaged E2E 覆盖 install → Ball/Tray/Settings → Host ready → source-only →
  translation disabled → exit；fake translation 只在 release-equivalent test artifact 验证，最终签名 RC
  另执行最小化真实 Provider smoke，二者不得混写为同一证据；
- Phase 4 没有旧 installer，因此首次升级验证分两部分：读取现有 Phase 4 userData/SQLite，以及首个
  Phase 5 beta installer → RC 的覆盖升级。不得声称存在从未发布 installer 的升级证据。

### 8.2 SBOM 与许可证

- 生成 CycloneDX JSON 或 SPDX JSON，并固定格式版本；
- runtime redistribution 与 build-only dependency 分栏；
- 覆盖 Electron/Node、全部 production NPM 包、Native 编译器 runtime、WinRT 构建依赖、Host、SQLite、
  installer toolchain 以及实际随包文件；
- 系统 `Windows.Media.Ocr` 与系统 language pack 标记为 OS dependency，不虚构为应用携带模型；
- 每个 redistributable 记录名称、版本、来源、SHA-256、license、notice 和用途；
- `THIRD_PARTY_NOTICES` 与 SBOM 必须由脚本校验完整性；未知许可证或缺失 notice 阻断发布；
- release gate 要求无未处置 Critical/High 漏洞；Medium 必须有 owner、影响、缓解与到期日。

### 8.3 签名与供应链

- 签名凭据只能存在于受保护 GitHub Environment 或等效 HSM/KSP，不进入 PR、fork、日志或 artifact；
- PR/fork 只产出 unsigned artifact；只有受保护 tag/release workflow 可以签名；
- installer 与项目自有 Electron PE、Host、DLL 的 publisher identity 必须一致；第三方 PE/DLL 保留有效的
  上游签名或由 SBOM/hash manifest 明确约束，不得为了“同一发布者”破坏上游签名；
- 对每个要求签名的 PE 执行 Authenticode chain、subject、timestamp 和 post-download 验证；更新 manifest
  使用对应更新方案的独立签名验证，不把普通 JSON 错当成 PE 执行 Authenticode；
- 固定发布顺序：构建项目自有 PE → 签名项目自有 PE → 组装 installer → 签名 installer → 对最终文件计算
  SHA-256 → 生成并签名 release/update manifest → 在 clean download 路径复验；
- 生成最终 SHA-256 checksums、组件 manifest、构建 provenance 和 release evidence manifest；
- Authenticode 信任根使用 Windows 受信代码签名链；更新 manifest 必须固定/分发独立验证公钥或由已评审
  更新框架建立等价信任根。checksum 本身不是信任根，必须由签名 manifest 或受保护发布渠道认证；
- 篡改任一 PE、installer、manifest 或 checksum 必须在安装/更新前失败；
- `main` 当前没有 branch protection、tag 或 GitHub Release。Phase 5 发布前必须配置必需状态检查、
  protected release environment、tag 规则和最小权限。

### 8.4 自动更新二选一

若 D4 选择“签名 RC + 手动更新”，应用不得出现不可用或未验收的自动更新入口，发布说明提供签名下载与
checksum 验证。若选择“公开 V1 + 自动更新”，则增加以下硬门禁：

- 仅 HTTPS 与签名 manifest；
- Main/Host/protocol/resources 作为一个原子版本单元更新；
- N-1 → RC、无更新、断网、下载损坏、manifest 篡改、安装中断、磁盘不足和回滚；
- 更新失败后旧版本与数据库仍可用，不产生半更新组件组合；
- 更新缓存接受同一隐私扫描和生命周期清理门禁。

## 9. 测试矩阵与验收证据

| 验收面 | 必测内容 | 通过标准 | 主要证据 |
|---|---|---|---|
| 功能 | 安装、启动、Tray/Ball、Settings、UIA、OCR、翻译四态、重试、禁用、删凭据、退出 | 核心用例全过；零 P0/P1 | packaged E2E、实机记录 |
| 性能 | PERF-01–09，三轮、固定设备 | 绝对阈值与相对回归均通过 | 原始脱敏 JSON + summary |
| 资源 | CPU、Private Working Set 容量、Private Bytes 趋势、handle/GDI/USER、完整进程树 | RES-01–06 全过 | 5 秒采样时序与摘要 |
| 长稳 | 8h 混合负载、故障注入、restart/exit storm | 0 crash/hang/leak/stale/privacy hit | soak report、WER、scan |
| 正确率 | UIA/OCR fixture 与真实应用 | 不因性能优化降低既有正确率或扩大误识别 | 文本对比、error distribution |
| 隐私 | secret、正文、截图、Provider body、userData/Temp/crash/update cache | 全部 canary 零命中；默认关闭指标与联网 | 解包 scan、网络观察 |
| 安全 | IPC、CSP、sender/role、Host path、签名、篡改 | fail closed；Renderer/Host Provider 连接为 0 | negative tests、signature report |
| 兼容 | DPI 100/125/150/200、任务栏四边、多屏/负坐标/混合 DPI/旋转/热插拔 | 发布承诺项通过；其余明确 LIMITED/UNSUPPORTED | 兼容矩阵与设备记录 |
| 应用 | Notepad、Chrome、Edge、Word、PDF、VS Code、Terminal、图片 OCR | 核心路径通过或稳定降级 | Case ID + 版本 + evidence path |
| 权限边界 | 标准用户、管理员目标、密码框、安全桌面、DRM/保护内容 | 不提权、不绕过；敏感目标稳定拒绝 | 实机/隔离环境记录 |
| Provider | 百度成功、错误/撤销凭据、断网、超时、恢复 | 保留原文、零 secret、无自动重试、恢复可用 | fake CI + 限定真实 smoke |
| 包体 | installer/unpacked/ASAR/Host/resources/update | 预算通过；无 dev/source map/secret | size manifest、解包白名单 |
| 供应链 | frozen install、SBOM、licenses、audit、provenance | 完整；Critical/High 无未处置项 | SBOM/notices/audit report |
| 安装升级 | clean install、userData 读取、beta→RC、修复、卸载、重装、回滚 | 不损坏设置/密文/数据库；清除语义符合 D8 | clean VM 脱敏事件日志、manifest、hash；视频仅本地忽略且不得上传 |
| 回归 | Phase 1–4 全量、数据库与 source-only 回退 | `phase5:verify` 严格超集全绿 | 本地 + 远程 CI artifact |

兼容性记录继续使用仓库现有 Case ID 模板，并增加 git SHA、installer hash、Host hash、OCR language pack、
电源模式和签名状态。任何 `LIMITED/FAIL` 都必须链接风险 ID、owner、复审日期和发布口径。

## 10. 命令与 CI 设计

### 10.1 当前已暴露的 package scripts

每次执行必须使用新的 append-never evidence root；以下命令中的路径仅为示例，运行后的结论以实际生成的
manifest/summary 字段为准，不预写 PASS：

```powershell
pnpm phase5:package:installer -- -EvidenceRoot ./artifacts/phase5/local/<new-installer-run>
pnpm phase5:verify -- -EvidenceRoot ./artifacts/phase5/<git-sha>/<new-verify-run>
```

| 命令 | 当前职责与证据边界 |
|---|---|
| `pnpm phase5:verify` | `phase4:verify` 严格超集、unsigned Dir package、packaged startup/D8、SBOM/audit、秒级 Lane A/resource interface smoke、residual 与 privacy；退出 `0` 仍是 development gate，不包含 900 秒 idle 或 8 小时 soak |
| `pnpm phase5:audit` | 官方 dependency audit 候选证据；必须重新绑定最终 clean source、lockfile、SBOM 与 signed RC |
| `pnpm phase5:package` | no-`SkipBuild` unsigned Dir build/package/supply-chain gate |
| `pnpm phase5:package:installer` | no-`SkipBuild` unsigned Installer build/package/supply-chain gate |
| `pnpm phase5:perf:smoke` | metrics instrumentation smoke，不提供 fixed-lab PERF-01–07 结论 |
| `pnpm phase5:environment:selftest` | 环境预检 schema、隐私与 fail-closed 负向自测，不证明 formal 环境就绪 |
| `pnpm phase5:environment:preflight` | 采集 Windows/硬件/交互会话、`gh` 能力、签名身份、runner 与 protected environment readiness；输出 `PASS` 也只表示环境就绪 |
| `pnpm phase5:perf03:selftest` | PERF-03 3×100、nearest-rank、身份、签名/attestation 与隐私 contract 静态自测 |
| `pnpm phase5:perf03:dev` | 最多 2×5 的真实 packaged Host-ready 开发运行；永远为 non-acceptance |
| `pnpm phase5:perf03` | formal PERF-03 3×100 entry；当前在可信 protected-run receipt、认证指标通道、publisher policy 与完整 namespace trust controller 实现前固定阻断，不生成 formal PASS |
| `pnpm phase5:perf09:selftest` | PERF-09 frozen counts/statistics/privacy/fail-closed 静态自测，不启动产品 |
| `pnpm phase5:perf09:dev` | 最多 2×5 的 packaged development 产品退出自测，永远为 non-acceptance |
| `pnpm phase5:perf09` | formal 3×50 entry；要求 clean/signed/attested package、独立 trusted root/clean-download、登记设备和完整 metadata |
| `pnpm phase5:resources:product-idle` | 正式 900 秒/5 秒产品 idle entry；显式 development selftest 可用更短时长，但永远为 non-acceptance |
| `pnpm phase5:lane-identity:selftest` | Lane A/B artifact identity 与 policy 自测 |
| `pnpm phase5:lane-a:product:selftest` | 证明 Lane A product policy fail closed |
| `pnpm phase5:lane-a:product` | formal Lane A entry；当前因 runtime-control contract、packaged endpoint 与 action driver 未实现而返回 `NOT_IMPLEMENTED_BLOCKER` |
| `pnpm phase5:provider-smoke:selftest` | real/fake 边界、脱敏与开发 fault/recovery 负向自测；不调用真实 Provider，固定 `NOT ACCEPTANCE` |
| `pnpm phase5:provider-smoke` | PERF-08 CLI；formal health 只允许真实百度 product provider，formal fault/aggregate 在可信故障控制器实现前固定 fail closed |
| `pnpm phase5:acceptance-decision:selftest` | 冻结 43-gate exact set、候选绑定、canonical digest、角色权限、source validator 与 approval receipt fail-closed 自测；当前生产 validator 为 1/43 implemented，42/43 fail-closed blocked |
| `pnpm phase5:acceptance-decision -- --input <draft.json> --output <new-decision.json>` | append-never 正式决议入口；`G2-CLEAN-SOURCE` 已实现 evaluator-time Git cleanliness 交叉验证，其余 42 个 gate 无可信 source validator，且非 PENDING 签字没有可信 receipt verifier，会稳定阻断批准 |
| `pnpm phase5:process-privacy:selftest` | 进程身份、残留与证据隐私负向自测 |
| `pnpm phase5:release:selftest` | release evidence/identity fail-closed 自测，不签名或发布 artifact |

### 10.2 尚未暴露为 package script 的正式工作

仓库当前仍没有统一的 `phase5:perf`、`phase5:soak`、`phase5:package:verify`、`phase5:sbom:verify`、
`phase5:sign:verify`、`phase5:installer-upgrade:verify`、`phase5:auto-update:verify` 或
`phase5:release:verify` package script。PERF-03 与 PERF-08 已有独立 formal entry，但没有正式运行证据；
PERF-01/02/04–07、两条 8 小时 lane、签名、安装升级和 release 收口仍须形成受评审的可执行入口及
fail-closed evidence contract，再在清单中勾选。

`.github/workflows/phase5-windows.yml` 暴露四组 fail-closed entry：

1. **PR deterministic gate**：frozen install、lint/typecheck/test/coverage、Phase 4 回归、Native Release、
   unsigned package、packaged E2E、解包扫描、SBOM、短稳、tracked mutation 和残留进程；
2. **Lane A harness gate**：固定自托管 Windows 会话执行开发期调度；当前 product runtime-control contract
   未实现，不能冒充 8 小时产品 soak；
3. **tag-only performance gate**：登记实验室 runner 上接收外部签名 bundle，预检后执行 formal PERF-03 3×100
   与 900 秒资源 entry；当前 PERF-03 trust controller 会在采样前明确阻断；
4. **protected Lane B/release gate**：仅受保护 tag，执行独立下载预检、签名、安装/升级/回滚、签名验证、上传 immutable release
   bundle、SBOM、notices、checksums 和 provenance。

真实百度 secret 与签名 secret 不进入普通 PR。真实外部 fork PR 必须取得一次运行证据，证明 workflow 不读取
secret、只使用 fake Provider 且仍可完成安全的 deterministic gate。

## 11. 证据目录与追溯

建议 evidence root：`artifacts/phase5/<git-sha>/<run-id>/`，默认 Git ignore。每次运行包含：

```text
environment.json
binary-manifest.json
perf/raw.jsonl
perf/summary.json
resources/raw.csv
resources/summary.json
soak/events.jsonl
soak/summary.json
package/size-manifest.json
package/file-manifest.sha256
security/privacy-scan.json
security/signature-report.json
supply-chain/sbom.cdx.json
supply-chain/third-party-notices.txt
release/evidence-manifest.json
release/acceptance-decision.json
```

`release/evidence-manifest.json` 记录版本、git SHA、workflow/run、installer/ASAR/Host/SBOM/checksum hash、
各门禁结果与签字状态。报告引用相对 evidence path，不把真实凭据、正文、用户绝对路径或原始 TLS body/pcap
放入仓库和 CI artifact。

最终 `release/acceptance-decision.json` 由
[`phase5-acceptance-decision.mjs`](../../tooling/phase5-acceptance-decision.mjs) 从模板生成。其 canonical payload
仅包含 schema/phase、候选 Git SHA + `0.5.0-phase5`、final release manifest hash、clean-download hash、exact
artifact-set digest 与固定顺序的 43 项 gate 路径/hash/status；签字不进入 payload 本体，而必须逐条引用该 payload
SHA-256。相同自然人可以合并签四个角色，但必须对重复 signer 使用 `MERGED_PROJECT_OWNER`。该权限声明不替代
Authenticode、attestation、fixed-lab、Provider、clean VM 或硬件证据。当前 registry 覆盖全部 43 个 gate，
其中 `G2-CLEAN-SOURCE` 已实现 exact workspace-state 与 evaluator 独立 Git 状态交叉验证；其余 42 个生产 source validator
仍明确返回 `GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED`；非 PENDING 角色记录也会
返回 `APPROVAL_RECEIPT_VERIFIER_NOT_IMPLEMENTED`。已有结构解析、阈值重算
和哈希绑定代码不能授予生产信任；必须再接入受保护运行证明、系统 Authenticode 验签、离线 DSSE/Sigstore 验证、
独立下载与真实故障控制证明。因此 selftest 通过只证明决议工具 fail closed，不能形成
Phase 5 `APPROVE`。

## 12. 主要风险与立即停止条件

| ID | 风险 | 预防与验收 |
|---|---|---|
| P5-R-001 | 指标定义或样本筛选使 p95 假绿 | 先冻结 benchmark spec；不删 outlier；三轮同过 |
| P5-R-002 | 性能指标泄露文本、窗口或凭据 | default-off MetricsSink、字段 allowlist、artifact privacy scan |
| P5-R-003 | 优化破坏 latest-wins、取消或 fail-closed | 每个优化 PR 执行 Phase 4 严格超集回归 |
| P5-R-004 | 8 小时后内存、handle、timer、fetch 或 Host 重启累积 | 5 秒采样、趋势门禁、故障注入与残留扫描 |
| P5-R-005 | installer 漏 Host/migrations/licenses 或接受开发路径 | clean VM packaged E2E、解包白名单、固定资源路径 |
| P5-R-006 | Paddle/model 临近发布引入体积与许可证失控 | D2 默认 Windows OCR；变更需独立 ADR 和预算 |
| P5-R-007 | 签名 secret 暴露给 PR/fork | protected tag/environment、最小权限、真实 fork 负向证据 |
| P5-R-008 | Main/Host/协议被部分更新 | 原子版本单元、签名 manifest、N-1/中断/回滚测试 |
| P5-R-009 | 只扫描压缩包字节而漏掉 ASAR/installer 内容 | 解包后逐文件扫描，并复扫安装目录和更新缓存 |
| P5-R-010 | 公网 Provider 波动污染性能结论 | fake deterministic gate；真实服务分层报告 |
| P5-R-011 | 发布承诺超过兼容性证据 | 核心矩阵实测；其余 LIMITED/UNSUPPORTED + 风险接受 |
| P5-R-012 | sourcemap、调试符号或本地路径进入正式包 | package whitelist、bundle scan、符号独立限权存储 |

出现以下任一情况立即停止 RC 并禁止签名/发布。打包或纯性能回归回到最近已验收代码；翻译隐私、越权
联网、Provider 数据边界或 stale-result 问题必须立即关闭 `translation.enabled` 并回到 Phase 3
source-only 安全路径，不能仅回退到仍包含在线翻译的 Phase 4：

- 原文、译文、截图、凭据、salt、签名或 body 进入日志、数据库、包、artifact 或 crash/update cache；
- 未 opt-in 时联网，或 Renderer/Native Host 直接访问 Provider；
- stale result 覆盖新 selection，Provider 故障破坏 Native lifecycle，或退出后仍有活跃请求/残留进程；
- installer/更新缺失或混用 Main、Host、protocol、migrations；
- 签名无效、publisher 不一致、manifest/hash 篡改未被拒绝；
- 数据库升级/回滚导致已有设置、密文或 source-only 路径不可用；
- 8 小时出现 crash/hang、无限重启、持续资源增长或隐私 canary 命中；
- 任一未处置 P0/P1 缺陷。

## 13. 验收节奏与签字

### 阶段评审

- **M0 / Scope Review**：Product + Engineering 冻结 D1–D9、范围、版本和成功指标；
- **M1 / Baseline Review**：Engineering + Quality 确认测量契约、Phase 4 基线和最终预算；
- **M2 / Performance Review**：Engineering + Quality 审查 before/after、正确率与完整回归；
- **M3 / Security & Release Review**：Security/Privacy + Release 审查包、SBOM、签名、fork 与更新；
- **M4 / RC Acceptance**：四方在同一 RC evidence manifest 上签字。

签字角色：

| 角色 | 必须确认 |
|---|---|
| Product | 范围、体验、兼容承诺、接受风险和发布文案 |
| Engineering | 架构、性能、正确率、长稳、回归和回滚 |
| Security/Privacy | 数据边界、指标脱敏、网络、SBOM、漏洞、签名和密钥边界 |
| Quality/Release | 实机矩阵、CI 证据、installer、版本、artifact、发布与恢复 |

单人项目可以由项目负责人代行多个角色，但报告必须明确这是合并式签字；公开发布前仍建议至少做一次独立
Security/Privacy 与 Quality/Release 复核。

## 14. Phase 5 完成定义

只有以下条件全部满足，Phase 5 才能标记为 `PASS` 或 `PASS WITH ACCEPTED RISKS`：

1. Phase 5 产品规格、benchmark spec、风险登记、验收清单、验证报告和必要 ADR 已冻结；
2. canonical SemVer `0.5.0-phase5` 在 workspace、Electron、installer 与 manifest 一致；Native
   VERSIONINFO 数字元组为 `0.5.0.0` 且字符串 ProductVersion 为 `0.5.0-phase5`；
3. `pnpm phase5:verify` 是 Phase 4 严格超集，本地和远程 CI 均无关键 skip 且退出码为 `0`；
4. PERF-01–09 在固定参考环境完成三轮，绝对预算与相对回归预算全部通过；
5. 同一 acceptance-eligible artifact 的完整进程树完成 900 秒/5 秒 idle；同一 git SHA 的
   release-equivalent test artifact 完成 Lane A，最终签名 RC 完成 Lane B；两条 lane 均完成 8 小时 soak、
   对应资源趋势、故障注入、WER/残留和隐私扫描，并由 evidence manifest 明确关联且不混同 hash；
6. clean VM 的安装、现有 userData 读取、beta→RC 升级、修复、卸载、重装和回滚通过；
7. installer/unpacked/ASAR/Host/resources 的体积、文件白名单和解包隐私扫描通过；
8. SBOM、许可证、notices、hash、漏洞处置和 provenance 完整；
9. 签名 RC 是 Phase 5 `PASS` 的必需交付；所有要求文件的 Authenticode 身份、chain 和 timestamp 通过；
   若启用自动更新，更新与原子回滚矩阵全部通过；
10. Windows 11、DPI、多屏/旋转和代表性应用核心矩阵通过；Windows 10 与系统边界按实际证据表述；
11. 真实百度成功与故障/恢复 smoke 完成，fake/真实证据严格分层；
12. 无未处置 P0/P1；所有 P2/未执行项都有剩余分、owner、缓解、复审日和用户影响；
13. Product、Engineering、Security/Privacy、Quality/Release 对同一 canonical acceptance payload digest 完成签字。

以下风险不可通过普通 `ACCEPTED RISK` 豁免：敏感数据泄露、未同意联网、签名/更新完整性失败、任意代码
执行、数据库不可恢复损坏、stale result 安全边界失效、可复现 crash/hang 或无限重启。出现这些问题时
最终结论必须保持 `NOT ACCEPTED`。

若性能、长稳与 packaged 功能已通过，但签名证书、受保护发布环境或签名验证尚未完成，只能记录为
`PERFORMANCE ACCEPTED / RELEASE BLOCKED`，不能把 Phase 5 标记为 `PASS` 或发布 RC。
