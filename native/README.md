# Desktop Translate Native Host (Phase 3)

本目录是 Windows x64/C++20 系统能力与隐私边界。`selection-host.exe` 由 Electron Main
私有拉起，负责全局鼠标手势、UI Automation、内存屏幕捕获和本机 OCR；原始像素不会跨进程。

## 构建与测试

仓库脚本会下载并校验固定版本的 C++/WinRT 构建依赖、生成 projection，再配置 Native：

```powershell
pnpm native:configure
pnpm native:build
pnpm native:test
pnpm phase3:smoke
```

目标包括：

- `selection-host.exe`：Electron Main 的私有子进程。
- `selection-host-probe.exe`：UIA、DXGI/GDI 和 Windows OCR 实机探针。
- `dt_native_core_tests`：协议、状态机、队列与边界单测。
- `dt_native_windows_tests`：真实 Windows OCR 与 `WH_MOUSE_LL` 安装/卸载测试。

## 运行模型

- Main 线程拥有单客户端 Named Pipe 请求循环。
- 专用消息线程拥有 `WH_MOUSE_LL`；Hook callback 仅写入固定容量 SPSC 队列并立即
  `CallNextHookEx`，注入事件会被忽略。
- 专用 COM MTA 线程拥有 UIA；最多一个 outstanding 操作，并受 deadline/stop/generation
  约束。
- Consumer 在手势稳定后先读 UIA；无真选区时按策略捕获单显示器 ROI 并 OCR。
- stop、新手势、Host 重启或父进程退出会使旧 generation 失效，late result 不发布。

## OCR 与捕获

Phase 3 使用 Windows 内置 `Windows.Media.Ocr`，离线调用系统已安装的 OCR language pack；
运行时不下载模型。`IOcrEngine` 仍保留替换边界，Paddle adapter 未启用。

捕获优先使用 Desktop Duplication。若驱动/当前会话返回完全黑帧，或输出处于旋转方向，
则对同一单显示器 ROI 使用内存 GDI `BitBlt` 回退；两条路径都不写文件。跨显示器 ROI
明确返回 `CROSS_MONITOR_UNSUPPORTED`，不会静默裁剪。

构建依赖版本、hash 和许可证边界见
[Phase 3 OCR 运行时记录](../docs/phase3/ocr-runtime.md)。

## 安全边界

- Named Pipe 仅当前用户可访问，并校验 first-instance、remote-client rejection、父 PID 与
  session nonce。
- 密码元素、安全桌面、提权目标、排除进程、受保护内容在 OCR 前拒绝。
- 不提权、不启用 `uiAccess`、不注入、不安装服务/驱动。
- Host 只发布结构化文本、物理矩形、来源、置信度及有限目标元数据。

## 探针

坐标均为 physical desktop pixels，可为负数：

```powershell
selection-host-probe.exe --uia 800 500
selection-host-probe.exe --dxgi 720 440 320 120
selection-host-probe.exe --ocr 720 440 320 120
selection-host-probe.exe --ocr-synthetic
selection-host-probe.exe --uia-foreground
selection-host-probe.exe --ocr-foreground
selection-host-probe.exe --all
```

DXGI/OCR 探针不写截图；UIA/OCR 文本只在显式诊断命令中输出。
