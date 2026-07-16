# Desktop Translate 文档索引

状态：Phase 2（桌面壳层开发基线，尚未验收）
目标平台：Windows 10/11 x64
最后更新：2026-07-16

本目录是 V1 的架构与阶段验收基线。Phase 1 已确认协议、进程隔离和 Windows Native 可行性；Phase 2 的文档冻结悬浮球、系统托盘、设置窗口、安全 IPC 和持久化边界，但清单保持未验收，不能据此声称实现已通过。

## 文档

- [系统架构](architecture/system-architecture.md)
- [ADR-0001：独立 Selection Host 与 Named Pipe](adr/0001-selection-host-and-named-pipe.md)
- [ADR-0002：划词获取流水线](adr/0002-selection-acquisition-pipeline.md)
- [ADR-0003：坐标、DPI 与权限边界](adr/0003-coordinate-and-privilege-boundaries.md)
- [ADR-0004：Electron UI Shell、角色化 IPC 与窗口安全](adr/0004-electron-ui-shell-security.md)
- [Native IPC 协议](protocols/native-ipc.md)
- [安全与隐私策略](privacy/security-and-privacy.md)
- [V1 兼容性矩阵](compatibility/v1-matrix.md)
- [Phase 1 验收清单](phase1/acceptance-checklist.md)
- [Phase 1 风险登记](phase1/risk-register.md)
- [Phase 2 产品规格](phase2/product-spec.md)
- [Phase 2 风险登记](phase2/risk-register.md)
- [Phase 2 验收清单](phase2/acceptance-checklist.md)

## 约定

文档中的“必须”“禁止”是验收要求；“应”是默认实现要求，如偏离必须新增 ADR；“可以”表示可选实现。

Phase 2 只交付桌面壳层。真实划词、全局 Hook 启动、翻译卡片、翻译服务、OCR runtime/model、正式历史/收藏 UI、安装签名与自动更新仍不在本阶段。Phase 2 结论以未跳过关键项的自动门禁、Windows 实机证据和验收签字为准。
