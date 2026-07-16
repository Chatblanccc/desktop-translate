# ADR-0002：WH_MOUSE_LL + UIA + DXGI + 可插拔本地 OCR

- 状态：已接受
- 日期：2026-07-16

## 背景

Windows 没有对所有应用都有效的“读取当前选中文字”接口：原生/网页文档控件通常可通过 UIA 获取语义选区，自绘控件、扫描 PDF、Canvas、图片和游戏则通常只能识别像素。剪贴板或模拟 `Ctrl+C` 会修改用户状态、触发目标应用行为，并违背无需复制的产品原则。

## 决策

采用一次手势、两级解析的流水线：

1. `WH_MOUSE_LL` 只识别左键按下、移动和抬起，形成候选拖拽。
2. 抬起后等待短暂稳定窗口，优先在 UIA MTA worker 中获取真实 selection。
3. UIA 不支持、返回空、超时或明确不适配时，对拖拽区域做一次 DXGI 局部截图并调用本地 OCR。
4. 输出统一的 `selection/result`，来源为 `uia`、`uia-point-approx` 或 `ocr`。

禁止通过剪贴板、`SendInput`、模拟快捷键或向目标窗口注入代码获取文字。

## Hook 约束

- Hook 安装线程必须有消息循环。
- 回调只复制必要的时间、坐标和事件类型到有界队列，然后立即调用 `CallNextHookEx`。
- 回调中禁止 COM、UIA、截图、OCR、Pipe I/O、日志 I/O、锁等待和堆积大对象。
- 移动事件可以合并；按下、抬起、停止和关闭事件不能被移动事件挤出队列。
- 必须检测 Host 健康，不能假设 Hook 永久存在。Windows 在 Hook 超时时可能静默移除它：[LowLevelMouseProc](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc)。

## UIA 快速路径

UIA worker 使用 `CoInitializeEx(..., COINIT_MULTITHREADED)`，且不拥有任何窗口。搜索顺序为：抬起点元素 → 焦点元素（限定同一目标进程/窗口）→ 可提供 Text pattern 的祖先文本容器。

有效结果必须满足：

- `GetSelection()` 返回非退化范围；
- 文本非空且不超过协议上限；
- 范围与本次目标窗口及抬起时间相符；
- 元素未标记 `IsPassword=true`，也不属于已知敏感/排除控件；
- 至少有有效 bounding rectangle，或能以抬起点形成明确的降级锚点。

`RangeFromPoint` 返回的是点附近的范围，不代表用户选区。它只能作为 `uia-point-approx` 低可信候选，并由上层策略决定是否展示，不能标为 `uia`。Text 控件只有在 Provider 正确实现 selection 时才能可靠读取：[Text 与 TextRange 模式](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-about-text-and-textrange-patterns)。UIA 必须位于独立 MTA worker：[UIA 线程模型](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)。

## OCR 回退

### 截图

- 只截取本次拖拽区域，可增加有上限的上下文边距；裁剪后不得超出目标显示器/虚拟桌面边界。
- 默认使用 DXGI Desktop Duplication 获取单帧；处理显示旋转、显示器热插拔和 `DXGI_ERROR_ACCESS_LOST` 后重建 duplication。
- 不持续录屏，不跨 Pipe 传像素，不写临时文件，不进入崩溃报告。
- 受保护内容、UAC/安全桌面、锁屏或系统策略拒绝时返回稳定错误，不尝试绕过。

DXGI 的帧以显示器为边界，并可能要求客户端处理旋转和指针元数据：[Desktop Duplication API](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api)。本产品的 OCR crop 不需要叠加鼠标指针。

### OCR Adapter

内部接口只表达：引擎初始化、支持语言、识别请求、取消、结果和健康状态。状态机不得依赖 Paddle 特有类型。首选基线是本地 PaddleOCR Windows x64 CPU runtime：[官方 Windows C++ 部署](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/local_inference/cpp/OCR_windows.html)。

每个引擎包必须固定：引擎版本、模型版本、SHA-256、语言列表、最低 CPU 能力、许可证清单和安装大小。模型不得在首次取词时临时联网下载。

## 取消、超时与顺序

- 每个合格手势生成唯一 `selectionId`。
- 任一时刻最多有一个 active selection；新手势使旧任务进入 cancelled。不可安全中断的底层调用完成后，其结果必须被丢弃。
- 默认 UIA 超时 `350 ms`、OCR 超时 `2500 ms`；超时通过协议返回错误，不阻塞 Hook。
- Event `seq` 在单次 Host 进程生命周期内单调增加；Main 同时检查 `selectionId` 和 `seq`。
- Host 不保证取消一定中断第三方推理，但保证取消后的结果不会被发布。

## 失败与隐私规则

| 条件 | 行为 |
|---|---|
| 小于拖动阈值的普通点击 | 忽略 |
| UIA 真选区有效 | 返回 `uia`，不截图 |
| UIA 不支持/空/超时 | 若目标允许，进入 OCR |
| `IsPassword=true` 或已知敏感控件 | 立即拒绝，禁止 OCR |
| 目标应用在排除列表 | 立即拒绝，禁止 UIA/OCR |
| 截图被系统拒绝/黑帧 | 返回 capture 错误，不绕过 |
| OCR 低于置信策略或无文本 | 返回 no-text/low-confidence，不猜测 |

## 结果

该决策覆盖语义文本和像素文本，同时保持低侵入和本地 OCR。代价是 OCR 成本、误识别、DXGI 生命周期复杂度，以及不同应用 UIA Provider 质量差异；必须通过兼容矩阵持续验证，而不能承诺“所有软件 100% 支持”。

## 未选择方案

- 剪贴板/模拟复制：会改变用户状态并可能执行目标应用命令。
- 只用 UIA：无法覆盖图片、扫描 PDF、Canvas 和大部分游戏。
- 只用 OCR：精度、功耗与延迟更差，也会不必要地接触像素。
- 云端 OCR：扩大敏感截图外传范围，不符合 V1 隐私基线。
- 常驻全屏捕获：超出按需取词目的并带来显著隐私/性能风险。
