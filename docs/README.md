# Desktop Translate 文档索引

状态：Phase 3（本地划词取词闭环已完成，`PASS WITH ACCEPTED RISKS`）
目标平台：Windows 10/11 x64
最后更新：2026-07-16

本目录是 V1 的架构与阶段验收基线。Phase 1 已确认协议、进程隔离和 Windows Native 可行性；Phase 2 已完成桌面壳层并以 `PASS WITH ACCEPTED RISKS` 验收；Phase 3 已完成 Native 划词、UIA/OCR 回退和 source-only 结果卡闭环，并以 `PASS WITH ACCEPTED RISKS` 完成本地验收。未执行的应用、硬件与远端 CI 矩阵保留在风险登记中，不能描述为已经执行。

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
- [Phase 2 验证报告](phase2/validation-report.md)
- [Phase 3 产品规格](phase3/product-spec.md)
- [Phase 3 风险登记](phase3/risk-register.md)
- [Phase 3 验收清单](phase3/acceptance-checklist.md)
- [Phase 3 验证报告](phase3/validation-report.md)
- [Phase 3 OCR 运行时与供应链记录](phase3/ocr-runtime.md)

## 约定

文档中的“必须”“禁止”是验收要求；“应”是默认实现要求，如偏离必须新增 ADR；“可以”表示可选实现。

Phase 3 只交付本地取词与原文结果卡。在线翻译 Provider、历史/收藏、凭据、安装签名与自动更新仍不在本阶段。Phase 3 结论以未跳过关键项的自动门禁、真实 UIA/OCR、兼容矩阵、多屏/DPI 实机证据和验收签字为准。
