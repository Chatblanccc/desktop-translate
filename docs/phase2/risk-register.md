# Phase 2 风险登记

状态：已复评。16 项实现风险关闭；1 项低风险验收证据缺口已接受。无 P0/P1 缺陷。

评分：可能性（L）与影响（I）各 1–5，分值为 `L × I`。关闭风险均关联自动化、CI 或 Windows 11 实机证据；接受风险必须记录影响、owner、补救方案与复审日期。

| ID | 风险 | 初始分 | 处置与证据 | Owner | 最终状态 |
|---|---|---:|---|---|---|
| P2-R-001 | Native 缺失/握手/熔断拖垮 UI | 20 高 | 无 Host E2E 与实机启动；Host 仅更新快照 | Platform | 关闭，2026-07-16 |
| P2-R-002 | Phase 2 误发 `start` 或安装 Hook | 15 高 | fixture 精确记录 hello/health/shutdown；Named Pipe 为 `listening=false` | Platform/Security | 关闭，2026-07-16 |
| P2-R-003 | Ball、子 frame 或伪造来源越权 IPC | 15 高 | 双 Preload；角色/webContents/frame/URL/payload 负向集成测试 | Security | 关闭，2026-07-16 |
| P2-R-004 | Renderer 通过远程资源/导航获得能力 | 15 高 | sandbox、CSP、权限/导航/下载/window.open 拒绝与 E2E 安全断言 | Security | 关闭，2026-07-16 |
| P2-R-005 | 拖动区覆盖按钮或窗口永久穿透 | 12 中 | 44 DIP no-drag、56 DIP drag frame、点击/键盘实机与组件测试；独立物理拖动证据转 P2-R-017 | Desktop UI | 关闭，2026-07-16 |
| P2-R-006 | 负坐标/DPI/任务栏/显示器移除导致出屏 | 16 高 | logical anchor、workArea clamp、显示器增删与 100/150/200% fixture | Desktop UI | 关闭，2026-07-16 |
| P2-R-007 | 损坏 SQLite 设置阻止启动 | 12 中 | 事务 migration、逐键校验、损坏/非法值故障注入 | Storage | 关闭，2026-07-16 |
| P2-R-008 | Ball/Settings/Tray 状态竞态 | 12 中 | Main 单一快照、幂等命令、广播与 listener 清理测试 | Platform | 关闭，2026-07-16 |
| P2-R-009 | 第二实例重复 Tray/窗口/Host/listener | 12 中 | single-instance 生命周期测试与生产 E2E 计数 | Platform | 关闭，2026-07-16 |
| P2-R-010 | 关闭到 Tray 后无法恢复或退出 | 12 中 | Tray 常驻、关闭仅隐藏、原生菜单与实机恢复/退出 | Product | 关闭，2026-07-16 |
| P2-R-011 | 退出竞态留下 Electron/Host | 15 高 | 单一 quit barrier、启动中取消、Supervisor join/kill、实机进程扫描 | Platform | 关闭，2026-07-16 |
| P2-R-012 | 日志/artifact 泄露路径、Pipe、nonce 或原值 | 15 高 | allowlist 诊断、脱敏断言、提交与 artifact 扫描 | Security | 关闭，2026-07-16 |
| P2-R-013 | 主题/高对比/焦点/无障碍不可用 | 9 中 | 语义控件、系统强调色、forced-colors、reduced-motion 测试与实机主题检查 | Desktop UI | 关闭，2026-07-16 |
| P2-R-014 | Windows CI/Tray/E2E 随机失败或假绿 | 12 中 | [Phase 2 run 29493975306](https://github.com/Chatblanccc/desktop-translate/actions/runs/29493975306) 全步骤通过并上传 artifact | Quality | 关闭，2026-07-16 |
| P2-R-015 | Phase 1 被 UI 重构破坏 | 15 高 | phase2 gate 内回归与独立 [Phase 1 run 29493975265](https://github.com/Chatblanccc/desktop-translate/actions/runs/29493975265) | Quality | 关闭，2026-07-16 |
| P2-R-016 | 内部预览被误称正式发布 | 8 中 | 版本、README、规格与报告统一为 `0.2.0-phase2`/内部开发预览 | Product/Release | 关闭，2026-07-16 |
| P2-R-017 | 当前同屏自动化无法生成原生窗口拖动，缺少独立物理拖动录像 | 1×2=2 低 | 工具在临时解除遮挡后仍不能移动 Ball，也不能移动标准 Settings 标题栏；未观察到 Ball 特有故障。拖动 region、moved 回调、左右吸附与几何均由测试覆盖。补救：下次独立桌面会话补录物理拖动，不改动本阶段代码 | Desktop UI | 接受；复审 2026-08-15 |

## 接受风险 P2-R-017

- 用户影响：仅影响验收证据完整性；未发现运行时崩溃、出屏、状态损坏或 Ball 特有的拖动失败信号。
- 接受原因：当前 Codex 桌面自动化的 drag 输入不能驱动任何 Windows 原生窗口移动，继续重复不会增加产品证据。
- 监控信号：后续独立桌面手工拖动无法移动 Ball，或 moved/吸附行为与几何测试不一致。
- 补救方案：在不被 Codex 占用的独立 Windows 会话补录左右物理拖动；若复现产品缺陷，立即重新打开 P2-R-005/P2-R-017 并阻塞后续发布。
- Owner：Desktop UI。
- 复审日期：2026-08-15，或 Phase 3 首次涉及 Ball 交互变更时，以较早者为准。

## 最终关口

- 高风险 P2-R-001/002/003/004/006/009/011/012/015 均有自动化与 CI 证据。
- P2-R-005/010/013 均有 Windows 11 实机证据。
- P2-R-014 由真实 Windows CI 关闭。
- 剩余风险为低分证据缺口，不包含 P0/P1 缺陷，不扩大 Phase 2 产品权限或运行能力。
