# Desktop Translate

Windows 桌面划词助手。当前版本为 **`0.3.0-phase3` 内部开发预览**：在 Phase 2
安全桌面壳层基础上，接入真实全局鼠标 Hook、UI Automation 优先取词、本机 OCR 回退，
并在选区附近展示只含原文的结果卡。

## 当前能力边界

- 启动后创建 56 DIP 悬浮球和系统 Tray；设置窗口关闭后应用继续常驻。
- 划词监听可在 Settings/Tray 即时启停并持久化，Host 重连后恢复最新配置。
- Native Host 优先读取 UIA 真选区；失败时按 `fallback` 或 `alt-drag` 策略使用
  Windows 本机离线 OCR。
- OCR 截图仅存在 Native Host 内存；不跨 Named Pipe、不上传、不落盘。
- 原文结果卡使用独立、沙箱化 Renderer/Preload，单例替换且不抢目标应用焦点。
- 密码元素、安全桌面、提权目标、排除进程、受保护内容与跨屏 OCR 在捕获前拒绝。
- Ball、Settings、Card 均无 Node/Electron 原始能力；设置通过 Main-only `node:sqlite` 持久化。

Phase 3 不包含翻译 Provider、译文、历史收藏、凭据、云 OCR、安装器、签名、自动更新或
正式发布。完整范围从[文档索引](docs/README.md)开始，协议以
[JSON Schema](protocol/native-ipc.schema.json)为单一事实来源。

## 环境

- Windows 10/11 x64（主要验收平台为 Windows 11）
- Node.js `22.23.1`（见 `.node-version`）
- pnpm `10.32.1`
- CMake `>=3.24`
- Visual Studio 2022 Build Tools x64 C++，或仓库验证过的 portable llvm-mingw
- 已安装所需语言的 Windows OCR language pack

## 运行与验收

```powershell
pnpm install --frozen-lockfile
pnpm start:phase3
```

完整 Phase 3 本地门禁：

```powershell
pnpm phase3:verify
```

门禁包含 lint、TypeScript、全部单元/组件/契约/集成测试、覆盖率、生产构建、Native
配置/构建/测试、Phase 1 Named Pipe 回归、Phase 2 Shell 回归、真实 Host 启停和 Electron
E2E。关键步骤也可独立运行：

```powershell
pnpm native:configure
pnpm native:build
pnpm native:test
pnpm phase3:smoke
pnpm test:e2e
```

## 目录

```text
apps/desktop/        Electron Main、三套角色化 Preload/Renderer 与 E2E
native/              Windows C++ Host、Windows OCR、探针和 Native 测试
packages/contracts/  Native IPC、UI Shell、结果卡与领域契约
packages/application/纯应用状态机
packages/translation/后续阶段 Provider 抽象（Phase 3 未调用）
packages/storage/    SQLite migration 与 repository
protocol/            Native IPC v1 canonical JSON Schema
docs/                架构、安全、兼容性、风险、规格与验收文档
tooling/             Native 工具链准备和 Phase 1/2/3 验收脚本
```
