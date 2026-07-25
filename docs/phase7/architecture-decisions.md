# Phase 7 架构决策

- 状态：`FROZEN FOR IMPLEMENTATION`
- 当前实现证据：`M3 DEVELOPMENT EVIDENCE RECORDED SEPARATELY; FINAL ACCEPTANCE OPEN`
- 更新日期：2026-07-23

本文只冻结已批准的实现顺序与边界，不声明代码、模型、签名或发布端点已经验收。

## AD7-001：两个 Gate 是用户决策，不是发布验收

### Gate A

M4 只做隔离离线模型 POC。Engineering 必须向用户提交真实许可证、来源、体积、质量、延迟和内存数据；
用户选择模型/runtime、支持方向和模型存储路线后，状态才可写 `GATE A CONFIRMED`。确认前禁止实现完整
Local Translation Host、model manager 或产品翻译闭环。

### Gate B

M7 只做 fake feed 手动 updater。用户确认最终产品/发布者身份，并通过安全渠道提供 Authenticode 能力以及
阿里云 OSS 或腾讯云 COS 之一后，状态才可写 `GATE B CONFIRMED`。确认前禁止创建、上传或连接真实发布 feed，
也不得把 test key/本地 server 当作真实基础设施。

Gate A/B 只解除下一阶段前置条件。最终 `SIGNED LIMITED BETA` 仍取决于 M8–M10 的完整证据与用户最终
go/no-go。

## AD7-002：M2 只记录身份占位，Gate B 才冻结真实身份

M2 文档使用以下逻辑字段，不把现有开发值描述成最终发布身份：

| 字段 | M2 状态 | Gate B 需要的用户输入 |
|---|---|---|
| Product display name | `P7_PRODUCT_NAME_TBD` | 最终显示名 |
| App/upgrade identity | `P7_APP_ID_TBD` | appId 与升级兼容决定 |
| Installer artifact name | `P7_INSTALLER_NAME_TBD` | 最终 beta 文件名 |
| Authenticode publisher | `P7_PUBLISHER_SUBJECT_TBD` | 证书 exact subject |
| Release channel | `P7_BETA_CHANNEL_TBD` | limited-beta channel |
| Domestic origin | `P7_DOMESTIC_ORIGIN_TBD` | 阿里 OSS 或腾讯 COS HTTPS origin/prefix |

开发构建可继续使用现有开发身份，但不得把它写进最终 release manifest。真实证书、私钥、密码和云密钥
只进入受保护发布环境，禁止进入聊天、仓库、`.env`、命令行、日志或证据 artifact。

## AD7-003：M3 同时交付 assisted installer 路径与 Ball 自由拖动

### 安装路径

- 保持严格 per-user、`oneClick: false`、`perMachine: false`、`allowElevation: false`、
  `packElevateHelper: false`。
- 唯一 audited `build/installer.nsh` 定义 fresh/registered/recovering 状态机：拒绝 `/allusers`、
  HKLM 遗留和不完整 HKCU；registered 固定复用 `InstallLocation` 并拒绝 `/D`，fresh silent
  拒绝 `/S /D`。
- fresh 目录只按完整末段匹配 `APP_FILENAME`，并在应用运行检查、旧版卸载和产品写入前验证目标
  不存在/为空、可写且无 reparse。registered 必须同时匹配 HKCU `InstallLocation`、exact
  `UninstallString`、exact `QuietUninstallString`、`KeepShortcuts=true`、exact `ShortcutName`、
  exact/empty `MenuDirectory`、固定 stable marker、递归 exact 产品树清单、全树/祖先无 reparse 且可写；
  fresh 要求这些 shortcut registry 字段为空，recovering 只接受缺失或 exact partial values，防止上游
  link cleanup 被 registry traversal 重定向。pre-Phase 7 已登记安装一律 fail closed；用户必须先显式
  运行旧版卸载，再进行一次 Phase 7 fresh install，不通过默认路径或文件指纹自动接管。
- installer 在 `SetOutPath $INSTDIR` 和产品写入前创建并回读固定 recovery marker；只有 stable marker、
  HKCU registry、exact uninstall commands 和落地 uninstaller 全部复验成功后才提交并删除 recovery
  marker。recovery 只允许恢复 Phase 7 自己中断的事务，且必须重新通过 path、marker、递归 exact 产品树清单、
  writable 和无 reparse 检查。
- 锁定的 pnpm patch 对 `app-builder-lib@26.15.3` 的 assisted installer、installer、install
  section、uninstaller、`include/extractAppPackage.nsh` 与 `include/installUtil.nsh` 六个模板做定点
  hook；强制 `differentialPackage: false` + `useZip: true`，正式载荷只走返回明确状态的 `nsisunz`，
  解压失败 nonzero 退出；`installUtil` 只使用预检缓存的 CurrentUser registry snapshot。不使用
  `nsis.script`，从而保留 electron-builder
  标准两遍 uninstaller 生成、独立签名、嵌入和最终 installer 校验流程。
- installer 与 uninstaller 从第一次应用运行检查前持有按当前用户 SID 命名的 Global lifecycle mutex；
  调用旧卸载器时只在 `ExecWait` 边界释放并在返回后立即重新获取。应用检查使用 Toolhelp +
  `QueryFullProcessImageNameW` 比较 canonical exact image path；枚举、权限、路径解析或等待错误都 fail
  closed。卸载 whole-root Rename 后还要分别检查 source/staging image path；发现竞态重启时先回滚再失败。
- fresh/registered/recovering 目标与卸载 staging 只允许本机 fixed NTFS；UNC/network、removable、ReFS
  和其他文件系统在 mutation 前拒绝。卸载器在关闭应用前、删除节开始及 staging 前重复 exact registry +
  stable marker + 递归 exact 产品树清单 + 全树/祖先无 reparse 验证，并禁止 `RMDir /r $INSTDIR`。
- 事务 claim 后只执行一次同父目录 whole-root `Rename(source, random-sibling-stage)`，不逐文件搬运。
  HKCU Apps & Features 树之外先用 `RegCopyTreeW` 建立 Install/Uninstall 两个快照，再持久化
  `registry-backups-ready` 与 `registry-delete-started`；两个原键删除后才进入 `committed-cleanup`。
  commit 前失败恢复 whole root 和 registry；回滚重建并复验两个原键后，必须先持久化
  `rollback-registry-restored` 才能删除备份。
- committed cleanup 使用 direct Win32 enumeration 删除 exact allowlist，复验只剩 stable marker 后
  最后删除 marker，再证明根为空并非递归 `RMDir` staging。之后持久化 `committed-postcleanup` 并可重放
  shortcut、AppUserModelId、shell notify 与用户明确选择的 AppData cleanup，最后才清 transaction。
  唯一允许的 `RMDir /r` 是已验证 parent/leaf、类型和全树无 reparse 的 exact AppData 直属叶目录。
  CurrentUser/asInvoker 不依赖 `/REBOOTOK`；commit 前故障必须回滚，commit 后故障必须保留 canonical
  transaction 并在下次启动继续 cleanup，且均以 nonzero 失败。
- policy 按 electron-builder 的 build-resources 解析顺序绑定实际 include，并同时绑定根
  `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、两个 patch 的 raw/normalized SHA-256、
  已安装 electron-builder/app-builder-lib 的 package-owned 完整文件树及六个物理模板 SHA-256；
  Fluent Icons `LICENSE` 与 runtime notice gate 同时绑定。配置必须显式 `extends: null`，build resources
  exact set 只允许 audited `installer.nsh`；禁止 project fallback、shadow include/app-local CLI、
  symlink、隐式 `installer.nsi`、默认资源/plugin 注入、生命周期/sign hook、其他 script 或
  install-scope override。
- 打包脚本不得从 app cwd 的 PATH 解析 builder；只执行根目录已审计 CLI，并在所有 build/native/
  supply-chain 前置步骤完成后、启动 builder 前再次运行完整 policy。
- 开启 `allowToChangeInstallationDirectory`，只在 fresh install 显示目录页。
- 标准用户正常启动 installer；“以管理员身份运行”不是支持流程，但 clean VM 必须显式验证即使
  installer 已被提权启动，也不会暴露或落入 all-users 安装。
- 覆盖安装复用已登记 `InstallLocation`；移动应用目录采用卸载后重新安装。
- 普通卸载保留 userData；重跑 installer 是修复路径，不宣称 Windows 原生 Modify/Repair。
- Phase 7 不迁移或删除历史 machine-wide 安装，也不自动接管 pre-Phase 7 HKCU 安装；两者都必须先由
  用户显式运行旧版卸载。当前旧未签名安装包只有开发者本人使用，因此采用一次性明确卸载/重装，而不是
  引入无法由外部 predecessor 基线证明的兼容指纹。
- `/S /allusers`、registry/marker/reparse 错误必须在 `un.checkAppRunning` 前拒绝，不得先关闭应用、
  触发 UAC 或产生 HKLM 变更。

### Ball anchor

Ball 使用两个明确模式：

```text
edge: { mode, displayId, edge, verticalRatio }
free: { mode, displayId, horizontalRatio, verticalRatio }
```

- `edge` 将 x 吸附到最近左右边缘并持久化 `edge + verticalRatio`。
- `free` 将 x/y 限制在当前 work area，并持久化 `[0,1]` 的 `horizontalRatio + verticalRatio`。
- 新版本以 `ui.ball.anchor.v2` 保存 tagged anchor，同时继续原子写入旧
  `ui.ball.anchor` edge 形状。优先级不按 wall-clock 先后排序：只有两行 `updated_at` 完全相同且
  edge projection 一致时才证明来自同一次原子双写并使用 v2；否则视为 N-1 回滚后的 legacy
  改写并优先 legacy。
- 旧 anchor 无 `mode` 时规范化为 `edge`，不得丢失既有位置。
- DPI、分辨率、任务栏、显示热插拔或 displayId 失效时，用 ratio 在最近有效 work area 恢复并 clamp。
- cold start 若发现 displayId 已失效或 `edgeSnap` 与 anchor mode 分裂，立即持久化修复后的 anchor，
  不只修正本次内存位置。
- 拖动把手与单击翻译/菜单动作分离，防止拖动误触发按钮。
- shutdown 先停止接收 `moved`、采集最终 bounds 并 drain position-write tail，之后才销毁窗口和关闭 DB。
- 自动化覆盖坐标/持久化不等于真实交互通过；M3 必须分别取得真实鼠标和触控板拖动、重启恢复证据。

M3 不实现模型自定义路径；Ball 与 installer 工作不得被模型 POC 阻塞。

## AD7-004：M4 POC 先量化，Gate A 后才选模型

M4 harness 与产品集成隔离，使用公开/合成语料和候选 runtime。每个候选报告：

- 模型 ID、上游 revision、许可证、再分发条件、runtime/CPU 要求；
- 原始 archive、core pack 解包体积和不含模型的 base installer 体积；
- cold/warm 分开的 N、p50/p95/max、失败数和 POC runtime process PWS；
- 每个拟支持方向至少 200 条 blind evaluation，含原始评分与严重错译分类；
- 公开测试语料 ID/hash，不记录用户正文。

固定门槛：

- base installer `≤150 MiB`；
- core pack 目标 `≤300 MiB`、硬上限 `≤400 MiB`；
- cold translation p95 `≤3.0 s`；
- warm translation p95 `≤1.5 s`；
- POC runtime process PWS `≤1.1 GiB`；
- blind evaluation `≥200` 条/方向。

质量数据由用户在 Gate A 取舍，不预造统一 PASS 分数。core pack `>300 MiB` 时必须向用户说明默认盘占用并
提供“固定默认路径”与“在 M5 增加自定义路径/迁移”两条路线；`>400 MiB` 的候选不能进入现方案，需换模型
或重新取得用户批准。

## AD7-005：Gate A 后新增独立 Local Translation Host

Gate A 确认后，M5 新增项目自有 Local Translation Host，并与 Selection Host 分离：

| 组件 | 允许职责 | 禁止事项 |
|---|---|---|
| Selection Host | 鼠标选择、UIA、截图/Windows OCR，向 Main 返回原文 | 模型加载、翻译、Provider/feed 网络 |
| Electron Main | 路由、启动/监督 Host、取消、model manager、全部 Provider/feed 网络 | 将凭据交给 Renderer/Host |
| Local Translation Host | 从已验证模型目录只读加载 Gate A 模型并在内存推理 | 网络、凭据、UI、DB、history/cache、下载 |
| Preload/Renderer | 角色化 UI API 和结果展示 | Node/任意 IPC、模型文件、直接连接 Host/feed |

Main 从 production 固定路径启动 Host，通过私有继承句柄通信，不暴露 Renderer 可连接的监听 socket。
协议携带 `protocolVersion`、`requestId`、`selectionId`、model version、语言、deadline，以及
`translate/cancel/health/shutdown`。

Main 与 Renderer 都复核 `selectionId + requestId`。新 selection、暂停、切语言/模型、关闭翻译、模型切换、
display change、Host fault 和退出都取消旧请求；不能取消的迟到结果仍丢弃。Host 进入 kill-on-close Job Object，
崩溃/超时/协议错误只回到 source-only，不退出 UI、不无限重启、不自动改走百度。

## AD7-006：模型包与存储路线受 Gate A 约束

无论用户选择何种存储路线，模型包都必须：

- 数据-only，不含 exe、dll、脚本、插件或自定义代码；
- 使用 canonical manifest、manifest signature、archive 与逐文件 SHA-256；M5 只用明确 test key，
  M8 才换成受保护 release key；
- 记录 model/runtime ABI、语言方向、size、license、source、min app version；
- 在唯一 staging 中拒绝绝对路径、`..`、symlink/reparse 和额外文件；
- 校验完成后原子切换 active model，并保留一个 last-known-good；
- 下载/安装/回滚失败继续使用旧模型或 source-only。

Gate A 前只规划当前用户 LocalAppData 下的默认产品模型目录。UI 最低要求是显示：

1. 默认模型路径；
2. 下载大小与已安装实际占用；
3. 当前模型版本/语言方向；
4. “删除本地模型”及将回到 source-only 的明确结果。

仅当 Gate A 用户选择自定义路径路线时，M5 才增加目录选择、安全迁移和路径矩阵；否则 Phase 7 不实现该功能。
若进入自定义路线，只允许本机固定 NTFS、当前用户可写、非 reparse 的目录，并要求迁移失败原子回退。

模型正文处理只存在于内存。原文/译文不得进入 model manager、download URL、日志、metrics、crash、
SQLite、history、cache、staging 或验收 artifact。

## AD7-007：M6 教程固定为五步本地流程

首次教程固定五步：

1. **隐私与模式**：解释 source-only、local、online/BYOK，默认不替用户联网。
2. **放置悬浮球**：演示 `edge/free` 和拖动把手，不自动改变用户选择。
3. **准备本地模型**：展示 Gate A 路线下的默认路径、大小、许可证、下载动作和删除语义。
4. **Notepad 练习**：用户明确打开系统 Notepad，自行输入教程提供的合成句并真实划词；不注入剪贴板或读取其他窗口。
5. **结果、错误与下一步**：识别 local/source-only 状态、重试/恢复、暂停、退出和手动检查更新。

教程资产随应用本地交付，不引用远程字体、图片、脚本、视频或 iframe。只允许持久化教程版本、当前步骤、
完成状态等枚举；禁止 selection、剪贴板、截图、自由文本、设备 ID 和 analytics。打开教程不得自动启用监听、
在线翻译、模型下载、凭据或更新检查。

## AD7-008：M7 先做 Fake Feed 手动 Updater

首版应用更新不做后台轮询、自动下载、普通退出时自动安装、blockmap 或差分 patch：

1. 用户点击“检查更新”；
2. Main 读取并验证 manifest，UI 显示版本、大小、publisher、release notes 和完整 installer；
3. `autoDownload=false`，用户明确点击下载后 Main 才在应用内下载完整 installer；
4. `autoInstallOnAppQuit=false`，下载完成后用户选择“重启并安装”或“稍后”；
5. 只有“重启并安装”可触发受控退出和 installer 执行，普通退出不得静默安装。

M7 只允许仓库 fixture/localhost fake feed 和显式 test key，并在 production 构建中拒绝这些入口。测试覆盖
无更新、可更新、manifest 错签/损坏、网络失败、版本回退、用户取消和重复点击。fake feed 通过只形成
`DEVELOPMENT PASS`。Renderer 只可调用类型化的 check/download/cancel/install 动作，不能提供 URL、路径或
版本；生产 feed 不允许通过 Renderer、环境变量或命令行覆盖。

## AD7-009：Gate B 后才接真实签名和国内 Feed

M8 只能使用 Gate B 用户确认的 identity、Authenticode 和阿里 OSS/腾讯 COS：

- app、Selection Host、Local Translation Host、installer 使用 exact publisher subject 和可信 timestamp；
- update/model manifest 使用受保护 release key；对象存储和 SHA-256 不是独立信任根；
- immutable versioned object 存 installer、manifest/signature、model package，`latest` 只指向签名 metadata；
- 发布顺序为 build → inner PE sign → installer assembly/sign → final hash/manifest → upload → 独立下载复验；
- 国内 feed URL/query/log 不含正文、凭据或稳定设备 ID；
- app 更新仍遵守 AD7-008 的用户触发、应用内下载和显式重启安装流程。

M8 的签名/feed/clean-VM PASS 也不是最终 `SIGNED LIMITED BETA`；M9 还必须完成最终签名候选 8 小时 soak、
完整 QA 和 8 名受邀用户，M10 再由用户作最终 go/no-go。

## 被拒绝的方案

- Gate A 前完成本地翻译产品集成：会在用户看到实测前锁死模型路线，拒绝。
- Gate B 前连接真实证书或 OSS/COS：越过用户身份与资源决策，拒绝。
- 因可能的大模型提前实现自定义路径：是否需要由 `>300 MiB` 实测和用户选择决定，拒绝。
- Renderer/Selection Host 直连 runtime/feed：扩大内容和网络边界，拒绝。
- 自动从 local 切到 online：可能在用户不知情时上传正文，拒绝。
- 首版 silent auto-update：扩大供应链、执行和恢复风险，拒绝。
- 把 M8 签名成功或 Gate B 确认直接称为 signed limited beta：缺少 M9/M10，拒绝。
