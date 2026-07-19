# Desktop Translate

Windows 桌面划词助手。Phase 4 在线文本翻译闭环已于 2026-07-18 在合并提交
`4ea65dcd5c5ef7c56127fe419127d48e0573a65d` 上以 `PASS WITH ACCEPTED RISKS` 验收；
当前正在按已冻结计划执行 Phase 5 的测量、长稳、打包与发布门禁开发。仓库版本已切换为
**`0.5.0-phase5` 开发候选**。实现提交 `a08cc6ca53727b446d7d10f5fbd0e1ae26e657ea` 已完成 clean-HEAD
本地 deterministic 严格超集验证，结果为 `DETERMINISTIC_GATE_PASS_NOT_ACCEPTANCE`；Desktop 308/308、
Electron E2E 6/6、Native 2/2、coverage 及同次 clean unsigned Dir package 的构建、启动、供应链和隐私门禁通过。
应用与 Native Host 均为 `NotSigned`，不具备发布资格；远程 PR CI 仍待执行。Phase 5 总状态仍为
`NOT YET ACCEPTED / RELEASE BLOCKED`，在签名 RC、正式性能/长稳、clean VM、
实机矩阵与发布签字完成前仍不是公开版本。

当前开发观察还包括 PERF-09 2×5、15 秒产品 idle，以及 PERF-03 packaged 1×1：最新 PERF-03 样本为
`118.648ms`、failure/forced termination 均为 `0`，但这些缩减运行均为 unsigned/non-acceptance；formal
PERF-03 在 protected-run receipt、认证指标通道、publisher policy 与完整 namespace trust controller
实现前固定阻断。
Windows 实机 UI 快检确认 Ball、Settings、Native service 与 `0.5.0-phase5` 版本面可用，并修正了设置页残留的
Phase 4 副标题；该会话观察不替代签名 RC、clean VM 或完整兼容矩阵。产品退出由 Ball UI 命令进入 Electron
quit lifecycle；失败后的 exact-identity harness cleanup 只用于测试隔离，不代表产品正常退出。

## 当前能力边界

- 启动后创建 56 DIP 悬浮球和系统 Tray；设置窗口关闭后应用继续常驻。
- 划词监听可在 Settings/Tray 即时启停并持久化，Host 重连后恢复最新配置。
- Native Host 优先读取 UIA 真选区；失败时按 `fallback` 或 `alt-drag` 策略使用
  Windows 本机离线 OCR。
- OCR 截图仅存在 Native Host 内存；不跨 Named Pipe、不上传、不落盘。
- 原文结果卡使用独立、沙箱化 Renderer/Preload，单例替换且不抢目标应用焦点。
- 密码元素、安全桌面、提权目标、排除进程、受保护内容与跨屏 OCR 在捕获前拒绝。
- Ball、Settings、Card 均无 Node/Electron 原始能力；设置通过 Main-only `node:sqlite` 持久化。
- Phase 4 在线翻译默认关闭；只有用户完成隐私告知、配置 BYOK 凭据并显式启用后才联网。
- Phase 4 首发仅接入百度通用文本翻译；源语言默认 `auto`、目标语言默认 `zh-CN`，两者均可在受支持选项内配置。
- 翻译网络与凭据只存在于 Electron Main；Provider 失败保留原文并降级，不影响 Native 取词。

Phase 5 仍不包含历史、收藏、持久翻译缓存、词典、音标、发音、例句、第二家 Provider、云 OCR 或
自动更新；installer、签名和供应链门禁正在开发验收。完整范围从[文档索引](docs/README.md)开始，协议以
[JSON Schema](protocol/native-ipc.schema.json)为单一事实来源。

## 环境

- Windows 10/11 x64（主要验收平台为 Windows 11）
- Node.js `22.23.1`（见 `.node-version`）
- pnpm `10.32.1`
- CMake `>=3.24`
- Visual Studio 2022 Build Tools x64 C++，或仓库验证过的 portable llvm-mingw
- 已安装所需语言的 Windows OCR language pack

若 `.tools/llvm-mingw-*-ucrt-x86_64` 中存在仓库验证过的便携工具链，Native 脚本会优先使用它；
否则使用已安装的 Visual Studio 2022 C++ 工具链。

## 运行与验收

```powershell
pnpm install --frozen-lockfile
pnpm start:phase5
```

`start:phase5` 会优先使用当前 `SELECTION_HOST_PATH` 或已有 Native Host 产物；首次运行若未找到产物，
会先执行 Native configure/build，再把解析出的 `selection-host.exe` 仅传给本次 Electron 进程。
只准备并检查 Native Host、不启动界面时可运行 `pnpm prepare:phase5`。显式配置的
`SELECTION_HOST_PATH` 无效时启动会直接失败，不会静默退回到不可用状态。

完整 Phase 4 本地门禁：

```powershell
pnpm phase4:verify
```

门禁包含 lint、TypeScript、全部单元/组件/契约/集成测试、覆盖率、生产构建、Native
配置/构建/测试、Phase 1 Named Pipe 回归、Phase 2 Shell 回归、Phase 3 真实 Host 回归、
Phase 4 fake Provider smoke、完整 Electron E2E 和隐私扫描。阶段门禁或不依赖 Native 构建路径的步骤也可独立运行：

```powershell
pnpm phase1:verify
pnpm phase3:verify
pnpm phase4:smoke
pnpm test:e2e
pnpm privacy:scan
```

Phase 5 的确定性开发门禁、环境预检、专项 runner 自测、供应链审计和无签名包可分别运行：

```powershell
pnpm phase5:verify
pnpm phase5:environment:selftest
pnpm phase5:environment:preflight
pnpm phase5:perf03:selftest
pnpm phase5:perf03:dev
pnpm phase5:provider-smoke:selftest
pnpm phase5:acceptance-decision:selftest
pnpm phase5:audit
pnpm phase5:package
pnpm phase5:package:installer
```

这些命令退出 `0` 只表示相应开发、自测或无签名门禁通过，不等于 Phase 5 正式验收。正式发布仍要求
受保护环境中的 Authenticode 签名与时间戳、GitHub artifact attestation、独立下载复核、
固定实验室性能/资源测试、完整 Lane A/Lane B、clean VM/兼容性矩阵和角色签字。

真实 Provider 验收可显式设置 `DESKTOP_TRANSLATE_PHASE4_AUDIT_FILE`，启用 Main-only 的脱敏 JSONL
attestation；默认不构造该 wrapper，也不写文件或日志。记录只包含 endpoint、方法、header/field 名称、
长度和布尔校验，不包含正文、APP ID、密钥、salt、签名、响应或 body。Windows 连接元数据可用
`tooling/phase4-network-observe.ps1` 在短验证窗口内单独采集；原始 TLS body/pcap 不应进入仓库或 artifact。

## 目录

```text
apps/desktop/        Electron Main、三套角色化 Preload/Renderer 与 E2E
native/              Windows C++ Host、Windows OCR、探针和 Native 测试
packages/contracts/  Native IPC、UI Shell、结果卡与领域契约
packages/application/纯应用状态机
packages/translation/Provider 抽象、网络边界与百度适配器
packages/storage/    SQLite migration 与 repository
protocol/            Native IPC v1 canonical JSON Schema
docs/                架构、安全、兼容性、风险、规格与验收文档
tooling/             Native 工具链准备和 Phase 1–5 开发/验收脚本
```
