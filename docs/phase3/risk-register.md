# Phase 3 风险登记

状态：已复评。核心取词闭环和本地门禁通过；剩余项均为兼容/硬件/发布证据缺口。无未处置 P0/P1 代码缺陷。

评分：可能性（L）与影响（I）各 1–5，分值为 `L × I`。接受项必须记录用户影响、Owner、监控、补救和复审日期。

| ID | 风险 | 初始分 | 处置与证据 | Owner | 最终状态 |
|---|---|---:|---|---|---|
| P3-R-001 | UIA Provider 缺失、旧选区或应用升级回归 | 16 高 | Notepad/Chrome UIA 实测；VS Code `uia_no_selection` 后真实 OCR 回退；Word/PDF/Terminal 未覆盖 | Native/Quality | 降为 6 中，接受至 2026-08-15 |
| P3-R-002 | OCR 中文/小字/复杂背景误识别且系统 API 无校准置信度 | 16 高 | Windows.Media.Ocr synthetic 与真实前台 OCR 精确通过；无文本/超时拒绝，中性置信度文案 | OCR | 降为 6 中，接受至 2026-08-15 |
| P3-R-003 | OCR 语言包差异或 WinRT 供应链不可复现 | 16 高 | 系统能力探测；CppWinRT/SDK Contracts 固定版本和 SHA-256；运行时不下载模型 | OCR/Release | 关闭，2026-07-16 |
| P3-R-004 | physical-px/DIP、多屏、旋转、热插拔导致卡片或截图错位 | 20 高 | Main 单点转换、display epoch、100/125/150/200%、负坐标与任务栏四边 fixture；当前 100% 单屏实测 | Desktop/Native | 降为 6 中，接受至 2026-08-15 |
| P3-R-005 | Hook 安装失败、队列过载或状态假监听 | 15 高 | 真实 Host smoke 验证 start/listening/stop；Hook install/stop、overflow 和 health CTest | Native | 关闭，2026-07-16 |
| P3-R-006 | Host 重启后 listener/config 未恢复 | 15 高 | Supervisor clientReady、generation 与 ShellController 重启集成测试 | Platform | 关闭，2026-07-16 |
| P3-R-007 | 密码、财务像素或受保护内容经 OCR/artifact 泄露 | 20 高 | Chrome 密码框四点实测拒绝；祖先密码属性与 mask-only fail closed；OCR 前目标分类；产物敏感标识扫描干净 | Security | 降为 5 中，接受至 2026-08-15 |
| P3-R-008 | 结果卡被自身 Hook 再次取词形成循环 | 12 中 | Main 将自身 PID/窗口加入排除；Native 分类与生命周期测试 | Native/Desktop | 关闭，2026-07-16 |
| P3-R-009 | 旧 UIA/OCR 结果覆盖新 selection | 16 高 | generation、selectionId、seq 与 Main latest-wins 单元/集成测试 | Platform | 关闭，2026-07-16 |
| P3-R-010 | 游戏/反作弊把 Hook/捕获视为可疑行为 | 15 高 | 不注入、不驱动、不提权、不使用 `uiAccess`；未执行游戏/反作弊矩阵 | Security/Product | 规避并接受，复审 2026-08-15 |
| P3-R-011 | Renderer 获得原文以外的本机权限或原文进入全局快照 | 15 高 | Card 专用 Preload/契约、sender/URL/role 校验、负向 E2E | Security | 关闭，2026-07-16 |
| P3-R-012 | no-text/low-confidence 被当成全局故障频繁提示 | 9 中 | 稳定错误分类、selection-scoped 静默失败和 Shell 状态测试 | Product | 关闭，2026-07-16 |
| P3-R-013 | 把原文伪装为译文或偷偷接入 Provider | 12 中 | source-only 卡片、无 Provider/网络/凭据依赖；代码和范围文档审计 | Architect | 关闭，2026-07-16 |
| P3-R-014 | UIA/OCR 调用超时、卡死或退出拖垮 UI | 15 高 | Host 进程隔离、deadline、late-result discard、Supervisor 熔断；未完成长时间 soak | Native/Platform | 降为 5 中，接受至 2026-08-15 |
| P3-R-015 | 真实应用、多屏硬件或远端 CI 证据不完整导致假通过 | 12 中 | 未测项在清单保持未勾选；本地完整门禁通过；新增 Windows CI workflow 但尚未推送运行 | Quality/Release | 接受，复审 2026-08-15 或发布前 |

## 接受风险说明

### P3-R-001 / P3-R-002：应用与 OCR 兼容范围

- 用户影响：未覆盖的 Word、PDF、Terminal 或复杂中文图像可能无结果或识别不准，但不会伪造翻译结果。
- 接受原因：本阶段是 Windows 内部开发预览；Notepad、Chrome、VS Code 和本地 OCR 已覆盖主路径，失败会稳定降级或静默拒绝。
- 监控信号：支持矩阵应用出现 UIA 空结果且 OCR 也无文本，或 golden/真实文本不一致。
- 补救：在装有 Office/Acrobat 的独立 Windows 会话补齐矩阵，并扩充中文、小字、复杂背景 fixture。
- Owner：Native/Quality、OCR；复审：2026-08-15。

### P3-R-004 / P3-R-015：物理显示与发布证据

- 用户影响：未实测的双屏、旋转或额外缩放组合可能出现卡片错位或 OCR 被明确拒绝。
- 接受原因：不修改用户显示配置；几何、display epoch、跨屏拒绝已有自动化覆盖，当前单屏 100% 实机通过。
- 监控信号：卡片离开 workArea、选区与截图不一致、显示变化后仍发布旧结果，或远端 workflow 失败。
- 补救：在独立硬件会话补录双屏/旋转/125–200% 矩阵；推送后必须运行 `.github/workflows/phase3-windows.yml`。
- Owner：Desktop/Native、Quality/Release；复审：2026-08-15 或发布前。

### P3-R-007 / P3-R-010：安全边界

- 用户影响：未知 Provider 或安全边界应用可能被拒绝取词；游戏/反作弊环境不提供兼容承诺。
- 接受原因：安全策略选择 fail closed；不为兼容性增加提权、注入、驱动、服务或 `uiAccess`。
- 监控信号：密码/受保护目标返回文本、artifact 出现原文/截图，或安全软件告警。
- 补救：立即禁用 OCR 路径并重新打开安全风险；在隔离环境补测管理员、安全桌面和 DRM 内容。
- Owner：Security/Product；复审：2026-08-15。

### P3-R-014：长稳

- 用户影响：极端慢 Provider 或长期运行可能触发 Host 重启，当前选区会丢失但 UI 不应卡死。
- 接受原因：隔离、deadline、熔断和 late-result 丢弃均已实现；正式长稳和 p95 属于后续性能阶段。
- 监控信号：Electron UI 卡顿、Host 重启风暴、退出后进程残留。
- 补救：增加 8 小时 soak、故障注入和重启退避指标后再进入正式发布候选。
- Owner：Native/Platform；复审：2026-08-15。

## 最终关口

- 本地 `pnpm phase3:verify` 完整通过，无关键 skip。
- 真实 Hook、Named Pipe、UIA、OCR、Chrome 密码拒绝和 Electron Card 路径均有证据。
- 仅接受兼容矩阵、物理硬件、长稳与远端 CI 证据缺口，不接受任何已知 P0/P1 代码缺陷。
- 结论：`PASS WITH ACCEPTED RISKS`。
