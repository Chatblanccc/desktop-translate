# Phase 3 工程与实机验收清单

- 验收日期：2026-07-16
- 版本：`0.3.0-phase3`
- 基线：Phase 2 验收提交 `5d2cf770de224ce0670cde4088db084df6e0ac62`
- 最终结论：`PASS WITH ACCEPTED RISKS`
- 详细证据：[Phase 3 验证报告](validation-report.md)

标记说明：`[x]` 表示已由本地自动化或本机实测验证；未勾选项必须在验证报告和风险登记中明确记录，不能被描述为已经执行。

## A. 基线与范围

- [x] Phase 3 从指定 Phase 2 验收提交开发。
- [x] 根 workspace、Desktop 应用和可见版本统一为 `0.3.0-phase3`。
- [x] README、文档索引、产品规格和阶段边界一致。
- [x] 未接入翻译 Provider、历史、收藏、凭据、云 OCR 或正式发布能力。

## B. 启停与生命周期

- [x] enabled 状态在 Host ready 后发送 `start`，health 为 `listening=true`。
- [x] disabled 状态不安装 Hook，health 为 `listening=false`。
- [x] Settings 与 Tray 启停即时同步并跨重启持久化。
- [x] Host 重启后恢复最新期望状态和配置，不重复 listener。
- [x] 停止、断线、显示变化和退出均清理 active selection 与结果卡。
- [x] OCR unavailable 只降级 OCR，UIA 仍可监听。

## C. 识别结果卡与坐标

- [x] Card 使用独立、安全、沙箱化的 Preload/Renderer。
- [x] 原文仅通过 Card 专用 view model 传递，不进入 `UiShellSnapshot`。
- [x] UIA/OCR 结果显示原文、来源；OCR 明确显示中性置信度语义。
- [x] 新 selection 替换旧卡；旧 selection/seq/result 不能覆盖新卡。
- [x] 100/125/150/200% DPI、负坐标、窄工作区和任务栏四边 fixture 全部通过。
- [x] 卡片上下翻转并 clamp 到正确显示器 `workArea`。
- [x] 显示热插拔或缩放变化使旧结果失效。

## D. Native UIA/OCR 与安全边界

- [x] 普通点击和短拖忽略；合格拖拽或双击只生成一个 selection。
- [x] UIA 真选区有效时不调用 Capture/OCR。
- [x] UIA unavailable/no-selection/timeout 按配置回退本地 OCR。
- [x] 自身窗口、排除进程、密码、安全桌面和受保护内容在 OCR 前 fail closed。
- [x] 管理员目标返回稳定 `TARGET_ELEVATED`，应用不提权。
- [x] DXGI access-lost 可重建；旋转归一化与 GDI 内存回退有 Native 测试。
- [x] 跨屏 OCR 返回 `CROSS_MONITOR_UNSUPPORTED`，不截错屏。
- [x] C++/WinRT 依赖固定版本与 SHA-256；系统 OCR 运行时不联网下载模型。
- [x] OCR no-text/low-confidence/timeout 不发布猜测结果。
- [x] stop/newer selection 后 late UIA/OCR 结果被丢弃。

## E. 自动化门禁

- [x] Contracts、Storage、Application、Desktop、Native 测试全部通过。
- [x] `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:coverage` 通过。
- [x] `pnpm build`、`pnpm test:e2e`、`pnpm phase3:smoke` 通过。
- [x] Phase 1/Phase 2 完整回归通过。
- [x] 本地 `pnpm phase3:verify` 退出码为 `0`。
- [ ] 新增 Windows CI workflow 尚未推送运行；作为 P3-R-015 的发布前复审项接受，不影响本地内部预览验收。
- [x] 无关键测试 skip；Statements/Branches/Functions/Lines 均高于门槛。
- [x] E2E、日志与 artifact 精确扫描无原文、截图、nonce、完整 Pipe 名、绝对用户路径或 secret。

## F. 真实应用矩阵

- [x] 记事本普通文本：UIA 精确返回选区。
- [x] Chrome 普通 HTML：UIA 精确返回选区。
- [ ] Edge 未重复验证；用户指定 Chrome 为本轮浏览器，记录为 P3-R-001 接受风险。
- [ ] Word 未安装，未执行；记录为 P3-R-001 接受风险。
- [ ] Edge/Acrobat 文本 PDF：Acrobat 未安装且本轮未执行；记录为 P3-R-001 接受风险。
- [x] VS Code：Monaco 返回 `uia_no_selection`，真实前台 OCR 精确包含测试选区，按设计完成有限支持回退。
- [ ] Windows Terminal：因桌面自动化安全边界未驱动终端，明确标记 limited；记录为 P3-R-001 接受风险。
- [x] 本地 OCR：Windows.Media.Ocr synthetic probe 与真实前台回退均返回精确测试文本。
- [x] Chrome 密码框：四个点位均返回 `uia_password_field`；修复了 TextPattern 子节点绕过祖先密码属性的问题。
- [ ] 管理员应用、安全桌面和 DRM 受保护内容未做破坏性实机测试；fail-closed 分支由 Native/契约测试覆盖，记录为 P3-R-007 接受风险。

## G. 系统实机矩阵

- [x] Windows 11 x64 当前系统完成 Host、Hook、UIA、OCR、Card 全链路。
- [x] 当前物理环境 `1920 × 1080`、96 DPI / 100% 缩放完成验证。
- [x] 100/125/150/200% DPI、负坐标、任务栏四边和热插拔状态转换完成自动化 fixture。
- [ ] 物理双屏、上下布局、负坐标、0°/90°旋转和额外 DPI 未改变用户系统执行；记录为 P3-R-004/P3-R-015 接受风险。
- [x] Tray 退出和完整门禁后无 Electron 或 `selection-host.exe` 残留。

## H. 风险与签字

- [x] P3-R-001/002/004/005/007/010/014 均有关联自动化或实机证据并完成复评。
- [x] 无未处置 P0/P1 代码缺陷。
- [x] 接受风险记录影响、owner、补救、监控和复审日期。
- [x] 架构/安全、Windows Native、Desktop UI 和产品范围已由本轮实现与验证报告联合审计。
- [x] 最终结论为 `PASS WITH ACCEPTED RISKS`。

## 验收签字

| 角色 | 结论 | 日期 |
|---|---|---|
| 架构与安全审计 | 通过，保留 P3-R-007/P3-R-010 | 2026-07-16 |
| Windows Native | 通过，保留 P3-R-002/P3-R-004/P3-R-014 | 2026-07-16 |
| Desktop UI | 通过，Card 与生命周期全绿 | 2026-07-16 |
| 产品范围 | 通过，source-only 内部预览 | 2026-07-16 |

这些签字代表本地交付审计，不替代远端 CI、发布负责人或额外硬件实验室签字。
