# Desktop Translate 文档索引

状态：Phase 4 已以 `PASS WITH ACCEPTED RISKS` 验收；Phase 5 为 `NOT YET ACCEPTED / RELEASE BLOCKED`
目标平台：Windows 10/11 x64
最后更新：2026-07-19

本目录是 V1 的架构与阶段验收基线。Phase 1 已确认协议、进程隔离和 Windows Native 可行性；Phase 2 已完成桌面壳层并以 `PASS WITH ACCEPTED RISKS` 验收；Phase 3 已完成 Native 划词、UIA/OCR 回退和 source-only 结果卡闭环，并以 `PASS WITH ACCEPTED RISKS` 完成本地验收。Phase 4 在此基线上完成默认关闭、BYOK、Main-only 网络的百度通用文本翻译，并于 2026-07-18 在 GitHub 合并提交 `4ea65dc` 上以 `PASS WITH ACCEPTED RISKS` 验收。未执行的真实故障与兼容性矩阵仍保持未勾选，作为明确接受风险继承到 Phase 5，不能描述为已经执行。

Phase 5 当前已有 dirty-source deterministic/Phase 4 严格超集、unsigned package、PERF-09 2×5 和短时产品
idle 开发通过证据；这些证据均为 non-acceptance。正式 fixed-lab、PERF-09 3×50、900 秒 idle、Lane A/B
8 小时、签名/attestation/clean-download、clean VM、兼容矩阵、真实 Provider 与角色签字仍未完成。

当前 PERF-09 与 idle 开发基准分别引用 `perf09-final-combined-2x5-20260719-0302` 和
`product-idle-final-hardened-dev-20260719-0326`；本轮 Installer/verify 只写入
`final-current-installer-20260719-0350` 与 `final-current-verify-20260719-0350`，结论以实际 manifest/summary
字段为准。

## 文档

- [系统架构](architecture/system-architecture.md)
- [ADR-0001：独立 Selection Host 与 Named Pipe](adr/0001-selection-host-and-named-pipe.md)
- [ADR-0002：划词获取流水线](adr/0002-selection-acquisition-pipeline.md)
- [ADR-0003：坐标、DPI 与权限边界](adr/0003-coordinate-and-privilege-boundaries.md)
- [ADR-0004：Electron UI Shell、角色化 IPC 与窗口安全](adr/0004-electron-ui-shell-security.md)
- [ADR-0005：Phase 5 打包、签名与更新边界](adr/0005-phase5-packaging-signing-and-update.md)
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
- [Phase 4 产品规格](phase4/product-spec.md)
- [Phase 4 风险登记](phase4/risk-register.md)
- [Phase 4 验收清单](phase4/acceptance-checklist.md)
- [Phase 4 验证报告](phase4/validation-report.md)
- [Phase 5 开发与验收总计划](phase5/development-and-acceptance-plan.md)
- [Phase 5 产品规格](phase5/product-spec.md)
- [Phase 5 Benchmark Spec](phase5/benchmark-spec.md)
- [Phase 5 风险登记](phase5/risk-register.md)
- [Phase 5 验收清单](phase5/acceptance-checklist.md)
- [Phase 5 验证报告](phase5/validation-report.md)

## 约定

文档中的“必须”“禁止”是验收要求；“应”是默认实现要求，如偏离必须新增 ADR；“可以”表示可选实现。

Phase 4 只交付百度通用文本翻译的 translation-only 闭环：用户自带凭据、显式 opt-in、源语言默认自动检测、源/目标语言可在 Phase 4 支持列表内配置，网络与凭据仅限 Main。历史、收藏、持久缓存、词典/发音、第二家 Provider、安装签名与自动更新仍不在本阶段。Phase 4 结论以 Phase 3 严格超集门禁、fake/真实 Provider 证据、Electron E2E、隐私扫描、风险复评和验收签字为准。
