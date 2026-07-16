# Desktop Translate

Windows 桌面划词翻译助手。当前仓库完成 **Phase 1 工程基线**：进程边界、跨语言契约、Native Host 可行性实现、翻译与存储抽象，以及可重复验收脚本。悬浮球、翻译卡片和设置页尚未开始，需在本阶段审核通过后进入 Phase 2。

## 当前能力边界

- Electron Main 监督独立的 Windows x64 `selection-host.exe`，原生崩溃不直接带崩主进程。
- 私有 Named Pipe 使用 4-byte little-endian 长度前缀和 Native IPC v1 JSON 契约。
- Native Host 已建立 `WH_MOUSE_LL`、UI Automation、DXGI 截屏和可替换 OCR adapter 的工程边界。
- 不读取剪贴板、不模拟 `Ctrl+C`、不向目标进程注入代码，截图像素不跨 Pipe、不落盘。
- 翻译 Provider、应用状态机、SQLite schema/repository 已抽象；Phase 1 不接入正式在线翻译服务或 OCR 模型。

完整设计从 [文档索引](docs/README.md) 开始，协议以 [JSON Schema](protocol/native-ipc.schema.json) 为字段形状的单一事实来源。

## 环境

- Windows 10/11 x64
- Node.js `22.23.1`（见 `.node-version`）
- pnpm `10.32.1`
- CMake `>=3.24`
- 正式工具链：Visual Studio 2022 Build Tools（Desktop development with C++ / x64）和 Windows 10/11 SDK

本地验收脚本也可检测忽略目录 `.tools/llvm-mingw-*-ucrt-x86_64` 中的便携 llvm-mingw；它只用于无管理员权限工作站的开发验证，正式发布仍以 MSVC/Windows SDK CI 为准。

## 验收命令

```powershell
pnpm install --frozen-lockfile
pnpm phase1:verify
```

该命令依次执行 TypeScript 类型检查、契约与桌面端测试、Electron Main/Preload 构建、C++ 配置/构建/测试，以及真实 `hello → ready → health → shutdown` Named Pipe smoke test。Phase 1 未捆绑 OCR runtime，因此健康结果允许且应明确显示 `degradedCapabilities: ["ocr"]`。

也可以分步执行：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm native:configure
pnpm native:build
pnpm native:test
pnpm phase1:smoke
```

## 目录

```text
apps/desktop/       Electron Main、Preload 与 Native Host supervisor
native/             Windows C++ Host、探针和核心测试
packages/contracts/ Native IPC 与翻译领域契约
packages/application/纯应用状态机
packages/translation/翻译 Provider 抽象
packages/storage/   SQLite migration 与 repository 接口
protocol/           Native IPC v1 canonical JSON Schema
docs/               架构、ADR、安全、兼容性和风险文档
tooling/            Phase 1 构建与验收脚本
```

Phase 2 前不得在本分支加入悬浮球、翻译卡片、设置页或正式翻译 Provider 实现。
