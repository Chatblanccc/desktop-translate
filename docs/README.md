# Desktop Translate 文档索引

状态：Phase 1（架构与可行性验证）
目标平台：Windows 10/11 x64
最后更新：2026-07-16

本目录是 V1 的架构基线。Phase 1 只确认边界、协议和可行性，不包含悬浮球或其他 Phase 2 产品功能。

## 文档

- [系统架构](architecture/system-architecture.md)
- [ADR-0001：独立 Selection Host 与 Named Pipe](adr/0001-selection-host-and-named-pipe.md)
- [ADR-0002：划词获取流水线](adr/0002-selection-acquisition-pipeline.md)
- [ADR-0003：坐标、DPI 与权限边界](adr/0003-coordinate-and-privilege-boundaries.md)
- [Native IPC 协议](protocols/native-ipc.md)
- [安全与隐私策略](privacy/security-and-privacy.md)
- [V1 兼容性矩阵](compatibility/v1-matrix.md)
- [Phase 1 验收清单](phase1/acceptance-checklist.md)
- [Phase 1 风险登记](phase1/risk-register.md)

## 约定

文档中的“必须”“禁止”是验收要求；“应”是默认实现要求，如偏离必须新增 ADR；“可以”表示可选实现。

Phase 1 的代码只能用于协议、进程隔离和 Windows 能力探针。以下内容明确不在本阶段：悬浮球、翻译卡片、设置页、翻译服务接入、正式历史/收藏 UI。
