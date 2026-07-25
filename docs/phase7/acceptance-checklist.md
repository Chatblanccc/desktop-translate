# Phase 7 验收清单

- 当前状态：`NOT YET ACCEPTED`
- 当前计划位置：M3 第三版真实 custom-root fresh install、第五版 fresh-directory/marker
  identity-bound exact package gates，以及当前候选默认 CurrentUser interactive + Quiet uninstall 已通过；
  registered 升级、committed-stage pathname
  identity、物理输入与 clean VM 待补 / M4 POC 基础设施开发
- Gate A：`NOT REACHED`
- Gate B：`NOT REACHED`
- 最终发布：`NOT AUTHORIZED`
- 交付上限：`SIGNED LIMITED BETA`，不是 public V1/GA
- 更新日期：2026-07-25

本清单创建时没有任何实现或运行项被标记通过。`[x]` 只能在同一候选的真实证据存在后填写；每条证据需绑定
git SHA、binary/model hash、设备/环境、命令或操作步骤、退出码/结果和 artifact 路径，且不得含用户正文。

## M0：用户确认

- [x] 用户于 2026-07-23 明确确认 Phase 7 目标、范围、M0–M10 顺序和 limited-beta 口径。
- [x] 用户确认 Gate A 是模型路线选择，Gate B 是身份/发布资源输入，二者都不是最终验收。
- [x] 用户确认 public V1、GA、静默/强制更新、任意模型导入等范围外项目。

## M1：同步 Main、分支与基线

- [x] [M1 基线记录](m1-baseline.md) 包含 `git ls-remote origin refs/heads/main` 的 live main SHA。
- [x] 本地基线与 live main 同步，并创建/切换 `codex/phase7-first-beta`。
- [x] 已记录 branch、HEAD/tree SHA、起始 clean 状态和无无关本地改动。
- [x] 基线 commit 的 Phase 1–5 live Windows CI 全绿；本地 clean prechange 未建立的边界已明确保留。
- [x] 已记录当前 installer、Ball、Phase 6 UI、source-only/online 和数据边界。

## M2：文档与身份占位

- [x] [计划](README.md)、[架构决策](architecture-decisions.md)、[风险登记](risk-register.md) 与本清单完成一致性评审。
- [x] `P7_PRODUCT_NAME_TBD`、`P7_APP_ID_TBD`、`P7_INSTALLER_NAME_TBD` 已记录为占位而非最终身份。
- [x] `P7_PUBLISHER_SUBJECT_TBD`、`P7_BETA_CHANNEL_TBD`、`P7_DOMESTIC_ORIGIN_TBD` 已记录。
- [x] 文档明确 Gate A 前禁止完整模型集成，Gate B 前禁止真实签名/feed 接入。
- [x] 文档明确所有未运行项、当前 blocker 和变更控制。

## M3：安装目录与悬浮球

### Installer

- [x] 第三版 exact unsigned development installer 的 assisted NSIS fresh install 显示安装目录选择，并在
  Windows Shell broker 真实宿主路径安装至
  `<USERPROFILE>\Desktop\desktop-translate`；exact size/hash、registry、marker 与边界见
  [M3 开发验证](m3-validation.md#21-real-host-fresh-install)与
  [结构化证据快照](evidence/m3-real-fresh-install-20260724.json)。
- [x] 当前修复候选以普通 CurrentUser host 进程完成两轮默认目录 `/S /currentuser` install 与
  `/currentuser /S` Quiet uninstall，并经 Windows Shell broker 完成一轮普通交互安装/卸载；
  canonical product/uninstall registry、whole-root stage、durable backup/transaction、NSIS Temp
  self-copy 运行映像、shortcut、userData retention 与零残留产品/卸载进程证据见
  [M3 开发验证](m3-validation.md#26-current-candidate-registry-durability-and-interactivequiet-uninstall)和
  [结构化证据](evidence/m3-registry-quiet-uninstall-fix-20260725.json)。
- [ ] 标准用户默认/自定义目录、空格、中文路径安装、启动和退出通过，不请求管理员权限。
- [ ] clean VM 分别以标准方式和已提权方式启动 installer；两者都固定 CurrentUser、无 all-users
  选项、无 machine-wide 注册，且包内不含 elevate helper。
- [ ] 覆盖安装复用原 `InstallLocation`，不重复注册、不静默搬家。
- [x] 普通交互卸载、同用户重装与 userData 保留语义已在当前默认目录候选上验证。
- [x] 第六版 exact unsigned candidate 已在默认 CurrentUser 根完成两次已登记同版本 installer 重跑；
  七项 registry snapshot 逐字不变、复用原 `InstallLocation`，无 transaction/backup/stage/残留进程。
  证据见 [第六版 handle-relative uninstall](m3-validation.md#27-sixth-candidate-handle-relative-committed-uninstall)。
- [ ] 跨版本升级语义已验证。
- [ ] 受保护/不可写路径安全失败，且不留下半安装和残留进程。
- [ ] fresh/registered/recovering、uninstall staging 只接受本机 fixed NTFS；UNC/network、removable、
  ReFS、reparse 与未知文件/目录在首次 mutation 前 fail closed。
- [ ] 按当前用户 SID 命名的 Global lifecycle mutex 覆盖 installer/uninstaller；旧卸载器
  `ExecWait` 边界释放、重新获取与 transaction owner 复核通过。
- [ ] Toolhelp + `QueryFullProcessImageNameW` exact canonical image 检查覆盖主 Electron 与子进程；
  权限不足、路径不可解析、等待失败和同名非产品进程均按设计处理。
- [ ] 在应用检查与 whole-root Rename 竞态窗口反复重启主 Electron 时，source/staging 二次检查能先回滚
  再失败；Selection Host 无残留。
- [ ] 卸载只做同父目录 whole-root Rename；任意 pre-commit 故障恢复安装根和两个 product registry 原键，
  且 `rollback-registry-restored` checkpoint 可在逐个备份删除间安全重放。
- [ ] commit 后 direct Win32 enumeration 只删除 allowlist；stable marker 最后删除、根为空后非递归
  `RMDir`，未知项、类型变化或删除失败不越界。
- [x] `phase7CleanupCreatedFreshDirectories` 与 stable/recovery marker transaction lifecycle 已改为
  held-parent relative `NtCreateFile`、volume/file ID 复验和 exact-handle disposition；标准用户 7/7
  runtime selftest、x86 MakeNSIS probe、四类 pathname/early-close 负向 mutation 及第五版 exact package
  gates 通过。证据见 [M3 开发验证](m3-validation.md#24-fifth-installer-identity-package)。
- [x] committed uninstall staging 已绑定 transaction v2 durable volume/file identity；stage root 与
  stable marker 全程持有 no-delete-share handle，固定 allowlist 只通过 pinned parent-relative
  `NtCreateFile` 打开并按 exact handle disposition，marker-last 与 empty-root cleanup 不再使用
  pathname delete/RMDir。9/9 runtime、x86 NSIS probes、九类负向 policy mutations、完整 package、
  已登记重跑、未知 file/empty-directory fail-closed、busy-file pre-commit failure、正常 Quiet
  uninstall 与 stage-file delete-share post-commit failure/recovery 通过。
- [x] `prepared`、`staged-uncommitted`、`registry-backups-ready`、`registry-delete-started`、
  `committed-cleanup`、`committed-postcleanup`、`rollback-pending`、`rollback-backups-ready`、
  `rollback-rebuild-ready`、`rollback-registry-restored` 10 个 durable state 均由外部 watcher
  精确终止真实 uninstaller/installer-recovery PID，并由同一候选恢复到 registry/hash/userData 一致、
  transaction/backup/stage/进程为零；production installer 无 fault hook。证据见
  [durable checkpoint crash matrix](evidence/m3-durable-checkpoint-crash-matrix-20260725.json)。
- [x] canonical product key 注入 current-user `Deny Delete` 后，exact inner uninstaller 在
  app-stop/transaction/backup/stage/file mutation 前 exit `1`；registry、installed files 与 userData
  snapshot 不变，全部残留为零。恢复 ACL 后 normal inner uninstall exit `0` 并收净。证据见
  [registry ACL fail-closed](evidence/m3-registry-acl-fail-closed-20260725.json)。
- [ ] 同一 durable state 内的 partial registry copy/delete、其余 registry/marker/shortcut ACL 故障
  及路径/进程竞态完整矩阵通过。
- [ ] `committed-postcleanup` 可重放 shortcut、AppUserModelId、shell notify 与用户选择的 exact AppData
  cleanup；默认 retain-userData 路线已通过 `committed-cleanup → recovery → fresh install` 真实重放，
  普通 product registry 已删除且 transaction 只在 root/postcleanup 完成后清除；用户选择
  delete-AppData 的 exact leaf 路线仍未实测。
- [ ] unsigned NSIS harness 的 Defender 拦截不作为安全通过；最终签名 exact candidate 在 clean VM
  完成扫描、运行、两遍 uninstaller 生成及落地 uninstaller Authenticode 验证。

### Ball

- [x] anchor 支持 `edge` 与 `free`；旧无 mode anchor 迁移为 `edge`。
- [x] free 模式持久化 `horizontalRatio + verticalRatio`，edge 模式持久化 `edge + verticalRatio`。
- [x] 自动化回归证明重启、DPI/分辨率/任务栏变化、displayId 失效、负坐标和多屏时恢复/clamp 正确；
  真实混合 DPI、多屏与热插拔仍在 M3 实机矩阵中开放。
- [x] 开发自动化证明拖动把手不误触发 Ball 单击动作，点击/键盘原行为不回归；物理输入仍未验收。
- [x] 自动化坐标、契约、持久化和回归测试通过。
- [ ] 真实鼠标完成 edge/free 拖动、重启恢复并记录证据。
- [ ] 真实触控板完成 edge/free 拖动、重启恢复并记录证据。

## M4：离线模型 POC

POC 不接完整 Electron 产品、真实发布证书或真实 OSS/COS。

- [x] formal PWS v3 与 blind report v2 已通过同一组两方向 candidate-generation raw hash、
  authorization、manifest、model/runtime、workload 和 candidate/run identity 交叉绑定；静态正负测通过，
  但真实生成 artifact、formal run 与人工评审仍未执行。
- [ ] 至少一个候选记录 model/runtime ID、上游 revision、许可证和再分发条件。
- [ ] base installer 不含模型且 `≤150 MiB`。
- [ ] core pack 目标 `≤300 MiB`，硬上限 `≤400 MiB`，同时记录 archive/解包体积。
- [ ] cold translation p95 `≤3.0 s`，报告 N/p50/p95/max/failure。
- [ ] warm translation p95 `≤1.5 s`，报告 N/p50/p95/max/failure。
- [ ] POC runtime process PWS `≤1.1 GiB`，记录测量工具、采样与设备。
- [ ] 每个拟支持方向完成至少 200 条 blind evaluation。
- [ ] 报告实际质量、严重错译、未译、乱码、专名/长句问题，不预填虚假 PASS。
- [ ] benchmark 只使用公开/合成语料，artifact privacy scan 零正文泄露。
- [ ] Gate A 决策包包含原始结果、摘要、推荐路线和已知限制。

### POC 结果表

| 指标 | 门槛 | 实际值 | 状态/证据 |
|---|---:|---:|---|
| Base installer | `≤150 MiB` | `130,711,602` bytes / `124.656 MiB` | `DEVELOPMENT OBSERVATION`; unsigned dirty-worktree package gates PASS, Gate A cross-binding not complete |
| Core pack | target `≤300 MiB`; hard `≤400 MiB` | `NOT RUN` | `NOT RUN` |
| Cold p95 | `≤3.0 s` | `NOT RUN` | `NOT RUN` |
| Warm p95 | `≤1.5 s` | `NOT RUN` | `NOT RUN` |
| POC runtime process PWS | `≤1.1 GiB` | `NOT RUN` | `NOT RUN` |
| Blind quality | `≥200`/direction | `NOT RUN` | `NOT RUN` |

## Gate A：用户模型路线决策

- [ ] M4 许可证、体积、质量、延迟、PWS 和原始数据完整提交给用户。
- [ ] 用户选择模型/runtime 与支持语言方向，或明确要求换模型/停止路线。
- [ ] 用户确认质量/资源取舍和 beta 已知限制。
- [ ] 用户选择模型存储路线：
  - 固定当前用户 LocalAppData 默认路径；或
  - 因 core pack `>300 MiB`/用户偏好，在 M5 增加自定义路径与安全迁移。
- [ ] 决策记录含日期、选项、例外和后续边界。

只有以上项目全部有证据时才可写 `GATE A CONFIRMED` 并开始 M5。Gate A 不是发布验收。

## M5：Local Translation Host 与 Model Manager

- [ ] 只实现 Gate A 选择的模型/runtime、语言方向与存储路线。
- [ ] Main 从 production 固定路径启动独立 Local Translation Host。
- [ ] Renderer、Selection Host 不读取模型/feed；Local Host 无网络/凭据/DB 入口。
- [ ] 私有 IPC exact schema、大小上限、unknown/malformed/version 拒绝通过。
- [ ] `translate/cancel/health/shutdown` 与 timeout/crash/restart/Job Object 清理通过。
- [ ] Main/Renderer 双重校验 `selectionId + requestId`；迟到 success/failure 不覆盖最新卡片。
- [ ] 模型缺失、损坏、ABI 不兼容、OOM、超时和 Host fault 均回到 source-only。
- [ ] local 失败不自动转 online，online 失败也不自动转 local。
- [ ] 模型 manifest/signature/hash、staging、原子切换、last-known-good 和回滚负测通过。
- [ ] 默认模型路径、下载/安装体积、版本/方向和删除动作可见。
- [ ] 仅在 Gate A 选择后实现并验证自定义模型路径/迁移；否则标记 `N/A BY USER DECISION`。
- [ ] DB、日志、stderr、metrics、crash、Temp、staging、feed 和 artifact canary 零正文。

## M6：五步教程、结果与错误

- [ ] 第 1 步解释 source-only/local/online-BYOK 和默认不联网。
- [ ] 第 2 步演示 Ball `edge/free` 与拖动把手。
- [ ] 第 3 步展示默认模型路径、许可证、下载/安装大小、显式下载和删除语义。
- [ ] 第 4 步由用户打开 Notepad、自行输入合成练习句并完成真实划词。
- [ ] 第 5 步解释 local/source-only 结果、错误恢复、暂停、退出和手动检查更新。
- [ ] 教程资产全部本地，无远程字体/图片/脚本/视频/iframe。
- [ ] 教程不读 selection/剪贴板/屏幕/history，不自动启用监听/online/下载/更新。
- [ ] 仅持久化教程版本/步骤/完成枚举；无自由文本、设备 ID 或 analytics。
- [ ] local translating/translated/failed/source-only 状态和稳定错误文案完成自动化与实机走查。

## M7：Fake Feed 手动 Updater

- [ ] 只有用户点击“检查更新”才读取 feed；无后台轮询。
- [ ] fake feed 覆盖 no-update/update-available/网络失败/损坏/错签/降级/取消/重复点击。
- [ ] UI 展示版本、大小、publisher、release notes 和完整 installer。
- [ ] `autoDownload=false`；用户明确点击下载后，Main 才在应用内下载完整 installer。
- [ ] `autoInstallOnAppQuit=false`；下载完成后用户选择“重启并安装”或“稍后”，普通退出不静默安装。
- [ ] Renderer 只能发起类型化 check/download/cancel/install，不能提供 URL、路径或版本。
- [ ] 不使用 blockmap、差分、强制更新、自动降级或无人确认安装。
- [ ] production 构建拒绝 localhost、fixture、fake feed 和 test key。
- [ ] M7 证据明确标记 `DEVELOPMENT PASS`，不称 signed/feed/release PASS。

## Gate B：用户身份与发布资源输入

- [ ] 用户确认最终 product display name。
- [ ] 用户确认 appId/升级身份、installer 文件名和 limited-beta channel。
- [ ] 用户确认预期 Authenticode exact publisher subject。
- [ ] 用户通过受保护方式提供可用 Authenticode 签名能力；secret 未进入聊天/仓库/命令行/日志。
- [ ] 用户选择并提供阿里云 OSS 或腾讯云 COS 之一。
- [ ] 用户确认 HTTPS origin/object prefix、下载页和 limited-beta 产品口径。
- [ ] Engineering 记录 M8 可用的最小权限发布环境，不提前上传真实对象。

全部完成后只能写 `GATE B CONFIRMED` 并开始 M8。它不证明签名有效、国内 feed 可用、clean VM 通过或
limited beta 已验收。

## M8：真实签名、国内 Feed 与 Clean VM

- [ ] 使用 Gate B exact identity 构建最终候选；source SHA/worktree 与 final binary hash 已绑定。
- [ ] app、Selection Host、Local Translation Host 和 installer 的 Authenticode subject/chain/timestamp 有效。
- [ ] update/model manifest 使用受保护 release key；tamper/replay/downgrade/revoke 负测通过。
- [ ] installer、manifest/signature、model package 上传到用户选择的 OSS/COS immutable versioned objects。
- [ ] 从国内 HTTPS endpoint 独立下载并复算 exact size/hash/signature。
- [ ] clean VM 标准用户完成自定义应用目录安装、模型下载、断网翻译和正常退出。
- [ ] N-1 → N 应用内下载、显式重启安装的完整 installer 更新保留设置、安装目录、safeStorage 和可用模型。
- [ ] 修复/重跑、普通卸载、同用户重装、应用回滚和模型回滚通过。
- [ ] feed URL/query/access log、安装目录和 artifacts 的 privacy scan 零正文/secret。
- [ ] M8 结论仍标记 signed release candidate，不提前写 `SIGNED LIMITED BETA`。

## M9：完整 QA、8 小时 Signed Candidate 与 8 名用户

- [ ] 对 M8 exact signed candidate 重跑 Phase 1–7 自动化与完整 Windows 实机矩阵。
- [ ] 同一签名候选连续运行 8 小时产品 soak。
- [ ] 8 小时内覆盖真实选择、本地翻译、source-only、Host kill/restart、断网、更新检查和正常退出。
- [ ] 8 小时结果为零 crash/hang/stale/privacy hit/无限重启/强制 cleanup/残留进程。
- [ ] CPU、PWS、handle、磁盘和模型失败趋势在已批准预算内。
- [ ] 至少 8 名知情受邀用户安装并使用同一候选。
- [ ] 8 名用户至少覆盖安装、Ball 拖动、Notepad 教程、本地翻译、错误恢复和手动更新理解。
- [ ] 反馈 schema 不收集原文/译文/截图/凭据；问题均有严重度、owner 和处置。
- [ ] 阻断缺陷修复后，对最终重新签名字节重跑受影响证据，不复用旧 soak。

## M10：收口与最终决定

- [ ] M0–M9 和两道 Gate 的证据、N/A 决策及开放风险可追溯。
- [ ] release manifest 精确绑定 source、installer、app、两个 Host、model、SBOM/licenses 和国内 objects。
- [ ] 已知问题、隐私说明、模型许可证/体积、手动更新、卸载/删除、回滚手册已完成。
- [ ] 下载页、installer、应用和文档只称 limited beta，不称 public V1/GA/production-ready。
- [ ] Engineering/Quality 对必要工程与质量证据完成复核；不要求四角色强制签字。
- [ ] 用户审阅完整证据、8 名用户反馈和开放风险后作出最终 go/no-go。
- [ ] go 决定只授权受邀 signed limited beta；公开 V1 另开阶段。

## 最终判定

只有 M0–M10、Gate A、Gate B 和所有不可豁免项对同一最终候选完成，且用户作出最终 go，才能写：

`FINAL ACCEPTANCE PASS / SIGNED LIMITED BETA`

当前所有实现、POC、用户 Gate、真实签名/feed、clean VM、8 小时和 8 用户证据在本清单中均为未验收状态，
不得由文档存在、历史 Phase PASS、test key、fake feed 或 unsigned package 推断为通过。
