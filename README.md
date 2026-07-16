# Desktop Translate

Windows 桌面划词翻译助手。当前版本为 **`0.2.0-phase2` 内部开发预览**，已交付可运行的 Electron 桌面壳层：常驻悬浮球、系统托盘、最小设置窗口、安全 IPC、Native 健康状态和 SQLite 设置持久化。

## 当前能力边界

- 启动后创建一个 56 DIP 悬浮球和一个系统 Tray；设置窗口关闭时隐藏，应用继续常驻。
- 悬浮球支持拖动、工作区夹紧、左右边缘吸附、显示器恢复和位置重置。
- Ball 与 Settings 使用隔离的 React Renderer 和角色限定 Preload API；Renderer 无 Node/Electron 原始能力。
- Electron Main 只与 `selection-host.exe` 执行 `hello → ready → health`，Phase 2 不发送 `start`，不会安装全局 Hook 或消费选区。
- 缺少 Host、OCR 或 Host 故障只更新 `unavailable/degraded/faulted` 状态，不会拖垮桌面 UI。
- 设置通过 Main-only `node:sqlite` 持久化；主题支持 `system/light/dark`。

Phase 2 不包含翻译卡、Provider、OCR 模型、历史收藏、安装器、签名、自动更新或正式发布能力。完整设计从 [文档索引](docs/README.md) 开始，协议以 [JSON Schema](protocol/native-ipc.schema.json) 为单一事实来源。

## 环境

- Windows 10/11 x64
- Node.js `22.23.1`（见 `.node-version`）
- pnpm `10.32.1`
- CMake `>=3.24`
- Native 正式工具链：Visual Studio 2022 Build Tools（Desktop development with C++ / x64）和 Windows 10/11 SDK

## 运行与验收

运行已构建的开发应用：

```powershell
pnpm install --frozen-lockfile
pnpm start:phase2
```

完整 Phase 2 门禁：

```powershell
pnpm phase2:verify
```

门禁依次运行 lint、TypeScript、单元/组件/集成测试、覆盖率、生产构建、Electron E2E，以及完整 Phase 1 Native 回归。也可以分步执行：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm test:e2e
pnpm phase2:smoke
pnpm phase1:verify
```

## 目录

```text
apps/desktop/        Electron Main、双 Preload、双 Renderer 与 E2E
native/              Windows C++ Host、探针和核心测试
packages/contracts/  Native IPC、UI Shell 与翻译领域契约
packages/application/纯应用状态机
packages/translation/翻译 Provider 抽象
packages/storage/    SQLite migration 与 repository
protocol/            Native IPC v1 canonical JSON Schema
docs/                架构、ADR、安全、兼容性、风险与验收文档
tooling/             Phase 1/2 构建和验收脚本
```
