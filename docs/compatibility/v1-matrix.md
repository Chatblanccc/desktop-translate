# V1 兼容性矩阵

状态：目标矩阵；实测栏必须在 Phase 1 探针运行后填写
目标：Windows 10 22H2 / Windows 11 x64，当前用户标准权限

Windows 10 22H2 在本项目中是兼容性目标，不等于操作系统安全支持承诺。其常规支持已于 2025-10-14 结束；正式发布必须把无 ESU/LTSC 的 Windows 10 标为 best-effort，并以仍受支持的 Windows 11 作为安全基线：[Microsoft 生命周期公告](https://learn.microsoft.com/en-us/lifecycle/announcements/windows-10-end-of-support)。

## 1. 支持等级

| 等级 | 定义 |
|---|---|
| A | UIA 真选区为主；自动触发目标 |
| B | UIA 不稳定时自动局部 OCR；结果可能受字体/背景影响 |
| C | 仅 `Alt + 拖动` 等显式 OCR 模式；不承诺自动语义选区 |
| U | V1 明确不支持或不绕过系统限制 |

“计划等级”不是已验证承诺。每个应用必须记录版本、文档类型、缩放、权限、来源、耗时和失败码后，才能把实测状态改为通过。

## 2. 应用/内容矩阵

| 场景 | 计划等级 | 首选 | 回退 | V1 预期与边界 | Phase 1 实测 |
|---|---:|---|---|---|---|
| Windows 记事本纯文本 | A | UIA TextPattern | OCR | 基准真选区、矩形和多行 | 待验证 |
| Chrome 普通 HTML 文本 | A | UIA | OCR | 普通段落/链接/多行；Canvas 不走 UIA | 待验证 |
| Edge 普通 HTML 文本 | A | UIA | OCR | 同 Chrome | 待验证 |
| Word 桌面版 `.docx` | A | UIA | OCR | 普通正文；复杂浮动对象另测 | 待验证 |
| Edge 文本型 PDF | A/B | UIA | OCR | 取决于 PDF 文本层和 Provider | 待验证 |
| Adobe Acrobat 文本型 PDF | A/B | UIA | OCR | 版本与保护设置会影响 UIA | 待验证 |
| 扫描 PDF | B/C | 无 | OCR | 只识别框选像素，不恢复隐藏版面语义 | 待验证 |
| VS Code 编辑器 | A/B | UIA | OCR | Electron/accessibility 配置和版本可能影响 Provider | 待验证 |
| JetBrains IDE 编辑器 | A/B | UIA | OCR | JBR accessibility 与自绘区域需实测 | 待验证 |
| Windows Terminal/PowerShell | A/B | UIA | OCR | 多行、等宽字体、selection 状态需实测 | 待验证 |
| 普通图片查看器 | C | 无 | 显式 OCR | 没有语义选区 | 待验证 |
| 网页 Canvas/远程桌面画面 | C | 无 | 显式 OCR | 只处理本机可见像素；不控制远端 | 待验证 |
| 窗口化/无边框游戏 | C | 无 | 显式 OCR | 不注入；反作弊可能阻止 | 待验证 |
| 独占全屏/反作弊游戏 | U | 无 | 无承诺 | 禁止驱动、注入或规避反作弊 | 不适用 |
| 以管理员身份运行的应用 | U | 可能受 UIPI 阻止 | 不提权 | 返回 `TARGET_ELEVATED` | 待验证边界 |
| 密码框/密码管理器 | U | 拒绝 | 禁止 OCR | `IsPassword`/排除规则命中即终止 | 待验证边界 |
| UAC、安全桌面、锁屏 | U | 拒绝 | 禁止 OCR | 不捕获、不绕过 | 待验证边界 |
| DRM/受保护视频 | U | 无 | 禁止绕过 | 黑帧/访问拒绝即失败 | 待验证边界 |

## 3. 系统矩阵

| 维度 | 必测组合 | 通过标准 | 实测 |
|---|---|---|---|
| OS | Windows 10 22H2 x64；Windows 11 当前受支持版本 x64 | 安装/启动、Pipe、Hook、UIA、DXGI 探针无系统级崩溃 | 待验证 |
| 权限 | Main/Host 均普通权限；普通目标；管理员目标 | 普通目标可测；管理员目标明确失败且不提权 | 待验证 |
| DPI | 100%、125%、150%、200% | Hook 点、UIA rect、OCR crop 和显示器快照一致 | 待验证 |
| 多屏 | 左/右/上布局、负坐标、不同 DPI | 不钳制负坐标；锚点/裁剪落在正确 output | 待验证 |
| 旋转 | 0°、90°（最低要求） | DXGI crop 方向与屏幕可见内容一致 | 待验证 |
| 显示变化 | 热插拔、改主屏、改缩放/分辨率 | 旧任务取消，duplication 重建，无错屏截图 | 待验证 |
| 输入 | 鼠标单击、短拖、长拖、双击、触控板模拟鼠标 | 单击/短拖不误触；合格手势只生成一个 selection | 待验证 |
| 会话 | 本地交互会话；锁定/解锁；RDP 仅观察 | 锁定时不采集；恢复后可重建或明确降级 | 待验证 |

## 4. 测试记录模板

每条证据至少包含：

```text
Case ID:
Date / tester:
OS build:
App + exact version:
Document/content type:
Privilege level:
Monitor layout + DPI:
Gesture:
Expected source:
Actual source:
Text correctness:
Rect/crop correctness:
UIA ms / OCR ms:
Error code:
Result: pass / limited / fail
Evidence path:
```

任何“limited/fail”必须链接 [风险登记](../phase1/risk-register.md) 或缺陷编号。版本升级后，Chrome/Edge/Word/PDF/VS Code 的核心用例应重新抽样；兼容性结论不可永久继承。

## 5. 对外表述

允许：

> 支持多数提供 Windows 可访问文本的应用；图片、扫描 PDF 与部分游戏画面可通过本地 OCR 尝试识别。

禁止：

> 任意软件、任意文字、100% 自动准确取词。

UIA 能力取决于目标控件是否提供对应 pattern，参见 [Microsoft UI Automation Fundamentals](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiautocore-overview)。DXGI 对受保护内容有系统边界，参见 [Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api)。
