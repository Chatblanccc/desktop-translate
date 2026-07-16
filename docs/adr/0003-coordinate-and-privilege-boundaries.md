# ADR-0003：物理坐标、Per-Monitor V2 与普通权限边界

- 状态：已接受
- 日期：2026-07-16

## 背景

Windows 多显示器允许负原点、不同 DPI 和独立旋转。Hook、UIA、DXGI 与 Electron 对坐标单位的约定不同；若隐式换算，会导致 OCR 裁剪偏移和卡片出现在错误显示器。与此同时，标准用户进程受 UIPI、UAC、安全桌面和受保护内容限制。

## 坐标决策

Native Host 的协议边界只输出虚拟桌面的 **physical pixel**：

- `releasePoint` 为 `{x, y}`，数值单位是物理像素。
- `physicalRects` 为 `{x, y, width, height}`，满足 `width > 0`、`height > 0`。
- 坐标可以为负；禁止钳制到主显示器。
- 多行 selection 可返回多个矩形，保持 UIA/OCR 的阅读顺序；另可计算 union 作为降级锚点。
- `monitor.id` 标识本次锚点所在输出，附带 `handle`、`dpiX`、`dpiY`、`scaleFactor` 和物理 `bounds`/`workArea` 快照。
- PID 在 JSON 中编码为十进制字符串；`HWND`/monitor handle 编码为十进制或 `0x` 十六进制字符串，避免 JavaScript number 精度问题。句柄只在该结果生命周期内有效。

Host 可在内部接收不同坐标空间，但在发出事件前必须归一化并标记 `coordinateSpace: "physical-px"`。OCR 的 crop、UIA 的 rectangles 和 Hook 点必须在同一物理空间相交校验。

Electron Main 是唯一的 physical px → DIP 转换点。它依据结果携带的 monitor/DPI 快照和 Electron `screen` API 计算 UI 锚点，随后再按当前 `workArea` 做上下翻转和边缘避让；Renderer 不自行猜测比例。显示配置变化后，旧结果不重新换算，直接作废并等待新 selection。

## DPI 决策

`selection-host.exe` 的 manifest 必须声明 `PerMonitorV2`，且在任何 DPI 相关 API 或窗口/COM 工作前生效。微软建议通过 manifest 设置进程默认 DPI awareness，而不是运行时 API：[设置进程默认 DPI 感知](https://learn.microsoft.com/en-us/windows/win32/hidpi/setting-the-default-dpi-awareness-for-a-process)。`PER_MONITOR_AWARE_V2` 的语义见 [DPI_AWARENESS_CONTEXT](https://learn.microsoft.com/en-us/windows/win32/hidpi/dpi-awareness-context)。

Phase 1 必须覆盖：

- 主屏 100%，副屏 125%/150%/200%；
- 副屏位于主屏左侧或上方（负坐标）；
- selection 跨显示器边界；
- 竖屏旋转；
- 运行时调整缩放、分辨率、主屏或热插拔。

跨显示器 selection 需按 output 分片捕获；V1 若 OCR 不能可靠合并，可明确拒绝跨屏 OCR，但不得截错屏或默默返回错位结果。

## 权限决策

V1 的 Electron 与 Native Host 都以当前用户的标准权限运行：

- 不请求管理员权限。
- 不声明 `uiAccess=true`。
- 不安装 Windows 服务、驱动或向其他进程注入代码。
- 不读取其他用户会话。

因此以下边界是产品约束，不是待绕过的缺陷：

| 场景 | V1 行为 |
|---|---|
| 同权限普通桌面应用 | 正常尝试 UIA，失败后按策略 OCR |
| 以管理员身份运行的目标应用 | UIA/Hook 交互可能受 UIPI 限制；返回 `TARGET_ELEVATED`，不自动提权 |
| UAC consent、Winlogon、安全桌面、锁屏 | 禁止采集，返回 `SECURE_DESKTOP` 或保持静默 |
| 密码/受保护 UIA 元素 | 返回 `PROTECTED_CONTENT`，禁止 OCR 回退 |
| DRM/受保护视频或系统返回黑帧 | 返回 `CAPTURE_PROTECTED`，禁止绕过 |
| 其他用户/远程会话 | 不支持；Host 与 Pipe 限定当前 logon session |
| 独占全屏、反作弊游戏 | 不承诺支持；不得注入、驱动级 Hook 或规避反作弊 |

微软的 UI 自动化产品文档说明，普通权限进程与高权限应用交互会受到 Windows 安全保护；启用 UI Access 会扩大低权限程序自动化高权限程序的能力和风险：[UI Access 与高权限应用](https://learn.microsoft.com/en-us/power-automate/desktop-flows/how-to/enable-ui-access)。本项目 V1 明确不启用它。

## 敏感目标判定

在触发 OCR 前必须完成最低限度的目标分类：自身窗口、排除列表、密码元素、已知凭据/密码管理器窗口、安全桌面和系统保护目标。UIA 的 `IsPassword=true` 表示内容受保护：[IsPassword 属性](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.ispasswordproperty)。一旦命中，禁止以“OCR 也许能读到”为理由回退。

目标 PID/HWND 只是诊断与关联元数据，不写普通日志，不用于跨进程注入。窗口标题和进程命令行不进入协议的默认结果。

## 结果

统一物理像素可让 Hook/UIA/DXGI 在原生侧直接校验，DIP 转换集中在 Main，减少多屏错位。普通权限边界牺牲了高权限应用和安全桌面的覆盖率，但显著降低安装、签名和攻击面，也符合 V1 的消费者桌面工具定位。

任何未来的提权、`uiAccess`、服务/驱动、跨会话能力或对受保护内容的处理变化，都必须单独安全评审并新建 ADR，不能作为本 ADR 的实现细节悄然加入。
