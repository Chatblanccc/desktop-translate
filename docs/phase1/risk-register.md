# Phase 1 风险登记

评分：可能性（L）与影响（I）各 1–5，初始分 `L × I`；15–25 为高，8–14 为中，1–7 为低。残余风险须在验证后更新，不能以“已记录”代替处置。

| ID | 风险与触发信号 | L×I | 预防/缓解 | Owner | 残余/状态 |
|---|---|---:|---|---|---|
| R-001 | UIA Provider 缺失、返回旧选区或应用升级后行为变化；兼容回归增加 | 4×4=16 高 | 真 selection 严格校验；按应用测试矩阵；UIA 失败转局部 OCR；保留排除/降级开关 | Windows Native | 12 中；开放 |
| R-002 | OCR 中文/小字号/复杂背景误识别或低置信仍展示 | 4×4=16 高 | 本地固定模型；按语言/字号 fixture；置信策略；低置信不猜测；显式标记 OCR 来源 | OCR | 12 中；开放 |
| R-003 | Paddle/OpenCV/runtime/模型使安装包过大、启动慢或许可证不适合分发 | 4×4=16 高 | Phase 1 测量冷启动/体积；固定 CPU 最小模型；SBOM、hash、许可证评审；Adapter 允许替换 | Release/OCR | 12 中；开放 |
| R-004 | 混合 DPI、负坐标、旋转或热插拔导致截错区域/卡片错位 | 4×5=20 高 | PerMonitorV2；协议只用 physical px；monitor 快照；显示变化取消；系统矩阵自动/人工验证 | Windows Native | 10 中；开放 |
| R-005 | Hook 回调超时被 Windows 静默移除，用户以为功能开启 | 3×5=15 高 | 专用 message loop；回调仅入有界队列；压力测试；健康信号与可恢复重装策略 | Windows Native | 8 中；开放 |
| R-006 | UIA/OCR/原生库阻塞或崩溃导致全应用退出/重启风暴 | 3×5=15 高 | 独立 Host；worker deadline；父进程 watchdog；有限退避、熔断、late-result 丢弃 | Platform | 8 中；开放 |
| R-007 | OCR 捕获密码、聊天或财务内容并落入日志/历史/崩溃包 | 3×5=15 高 | `IsPassword`/敏感/排除目标先拒绝且禁 OCR；截图仅内存；日志脱敏；隐私 artifact 扫描 | Security | 8 中；开放 |
| R-008 | Named Pipe 被抢占/越权连接、畸形 JSON 导致命令执行或内存耗尽 | 3×5=15 高 | 随机名、FIRST_PIPE_INSTANCE、拒绝远程、用户 DACL、PID+nonce、1 MiB/深度限制、fuzz | Security/Native | 6 低；开放 |
| R-009 | 管理员应用/UAC/安全桌面不可取词被用户视为缺陷 | 4×3=12 中 | 标准权限边界和稳定错误；不自动提权；设置/帮助明确说明；产品文案不夸大 | Product | 8 中；接受待签字 |
| R-010 | 游戏/反作弊把 Hook/捕获视为可疑行为 | 3×5=15 高 | 不注入、不驱动、不绕过；游戏只显式 OCR 尝试；可按进程排除；发布前抽样主流反作弊环境 | Security/Product | 10 中；开放 |
| R-011 | 在线翻译把敏感原文泄露给供应商，或 secret 被打包/记录 | 3×5=15 高 | 仅 Main 联网；上线前明示外传；HTTPS allowlist；safeStorage/服务端代理；secret scan；无 body 日志 | Backend/Security | 8 中；Phase 4 门禁 |
| R-012 | IPC Schema、TS 类型和 C++ 结构漂移，出现双方解释不同 | 3×4=12 中 | 单一 JSON Schema；golden fixtures 跨语言；未知字段拒绝；协议变更评审和 major 协商 | Platform | 4 低；开放 |
| R-013 | 选择任务竞态：旧 OCR/翻译结果覆盖新选区 | 4×4=16 高 | UUID `selectionId`、单 active/latest-wins、event seq、stop barrier、late-result discard 测试 | Platform | 4 低；开放 |
| R-014 | UIA 恶意/异常 Provider 返回超长文本或永久 COM 调用 | 3×5=15 高 | 长度/数组上限；隔离 MTA worker；deadline 后失效；必要时重启 Host；fuzz/故障注入 | Windows Native | 8 中；开放 |
| R-015 | Windows/Electron/应用更新导致兼容性或安全回归 | 4×4=16 高 | 固定已测版本；持续升级窗口；核心兼容抽样；签名发布；SBOM/依赖审计和可回滚更新 | Release | 8 中；开放 |
| R-016 | 阶段范围混淆，把 Phase 3/5 的兼容性与性能任务误报为 Phase 1 已完成，或反向阻塞 Phase 2 | 3×4=12 中 | Phase 1 清单只验工程边界；兼容矩阵保留“待验证”；每阶段独立证据和签字 | Architect | 3 低；开放 |
| R-017 | 本机便携 Clang 构建通过，但 MSVC/Windows SDK 正式工具链尚未在远端 CI 实际执行 | 2×4=8 中 | Windows CI 使用 VS 2022 C++ workload 执行同一 `phase1:verify`；[run 29475175846](https://github.com/Chatblanccc/desktop-translate/actions/runs/29475175846) 已通过 | Release/Native | 2 低；关闭（2026-07-16） |

## 风险处理规则

- 高风险必须在其对应实施阶段结束前降级、规避或由明确 owner 签字接受。
- “接受”必须说明用户影响、为何当前不修、监控信号和复审日期。
- 触发信号出现时，将状态改为 `发生`，关联缺陷/证据并更新 L/I；不得覆盖原始判断。
- 新增权限、云 OCR、常驻截图、驱动/服务、`uiAccess`、跨会话或持久原文遥测，一律新增高风险项并重新做安全评审。

## Phase 关口

- Phase 2 前：R-006、R-008、R-012、R-013、R-016 必须有工程边界证据；R-017 必须由审核人明确接受或用 MSVC CI 关闭。
- Phase 3 完成前：R-001、R-002、R-004、R-005、R-007、R-010、R-014 必须有真实应用/多屏 DPI/OCR 证据并重新评分。
- Phase 4 前：R-011 必须完成供应商隐私/凭据/限额设计。
- 每次 Electron、Windows SDK、OCR 模型或主要目标应用升级：复审 R-001、R-002、R-003、R-015。
