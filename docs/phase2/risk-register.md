# Phase 2 风险登记

状态：开放，待实现后复评

评分：可能性（L）与影响（I）各 1–5，初始分为 `L × I`；15–25 为高、8–14 为中、1–7 为低。关闭风险必须附验证证据；“已记录”不等于已处置。

| ID | 风险与触发信号 | L×I | 预防/缓解 | Owner | 当前状态 |
|---|---|---:|---|---|---|
| P2-R-001 | Native Host 缺失、握手失败或熔断导致整个 Electron 应用退出 | 4×5=20 高 | Tray/Ball 先于 Host 创建；Host 仅更新 UI 状态；无 Host E2E；退出路径独立 | Platform | 开放 |
| P2-R-002 | Phase 2 误发 `start`，提前安装全局 Hook 或处理选区 | 3×5=15 高 | 使用独立 UI Shell 状态；禁止 selection effect；Host fixture 断言仅出现 hello/health/shutdown 且 `listening=false` | Platform/Security | 开放 |
| P2-R-003 | Ball 获得 Settings 写权限，或恶意子 frame/伪造来源越权调用 IPC | 3×5=15 高 | 双 Preload；角色、webContents、main frame、来源和 payload 五重验证；负向集成测试 | Security | 开放 |
| P2-R-004 | Renderer XSS/导航/远程资源获得 Node、Electron 或网络能力 | 3×5=15 高 | 沙箱、隔离、禁 Node、严格 CSP、拒绝权限/导航/下载/window.open；生产 bundle 安全断言 | Security | 开放 |
| P2-R-005 | 透明拖动区覆盖按钮，悬浮球不可点击、不可键盘操作或永久穿透 | 3×4=12 中 | 外圈 drag、中央 no-drag；不启用 click-through；组件测试与实机点击/键盘验收 | Desktop UI | 开放 |
| P2-R-006 | 负坐标、多 DPI、任务栏换边或显示器移除使悬浮球出屏 | 4×4=16 高 | 保存逻辑锚点；所有结果按当前 workArea clamp；display fixture 覆盖热插拔与负坐标 | Desktop UI | 开放 |
| P2-R-007 | 损坏 SQLite 设置或迁移失败阻止应用启动 | 3×4=12 中 | 事务化迁移；逐键运行时校验；损坏值回退默认；故障注入测试 | Storage | 开放 |
| P2-R-008 | Ball、Settings 与 Tray 状态不同步，重复命令或关闭产生竞态 | 3×4=12 中 | Main 单一快照；幂等 reducer/controller；同步发布；重复调用和 listener 清理测试 | Platform | 开放 |
| P2-R-009 | 第二实例创建重复 Tray、窗口、Host 或 IPC listener | 3×4=12 中 | 进程启动时尽早获取 single-instance lock；second-instance 只聚焦既有窗口；E2E 计数 | Platform | 开放 |
| P2-R-010 | “关闭到托盘”让用户误以为已退出，或 Tray 丢失后无法退出 | 3×4=12 中 | Tray 常驻；关闭只隐藏；菜单提供明确“退出”；Explorer 重启列入人工后续矩阵 | Product | 开放 |
| P2-R-011 | 退出竞态留下 `selection-host.exe`、Electron 进程或 listener | 3×5=15 高 | 单一幂等 quit barrier；等待 supervisor shutdown；超时兜底；退出后进程扫描 | Platform | 开放 |
| P2-R-012 | 日志记录设置原值、完整路径、Pipe 名、nonce 或 Native stderr payload | 3×5=15 高 | 稳定错误码；按字段 allowlist；日志/测试 artifact 敏感内容扫描 | Security | 开放 |
| P2-R-013 | 主题/高对比/缩放下文字或焦点不可见，无障碍名称缺失 | 3×3=9 中 | 语义控件、系统色与强调色、focus-visible、高对比/reduced-motion 测试和实机检查 | Desktop UI | 开放 |
| P2-R-014 | CI 中 E2E 依赖 Tray/桌面会话而不稳定，出现假绿或随机失败 | 4×3=12 中 | Windows runner、确定性 fixture、失败时上传 trace/截图；关键测试禁止 skip 和静默重试 | Quality | 开放 |
| P2-R-015 | Phase 1 回归被 UI 构建或生命周期重构破坏 | 3×5=15 高 | `phase2:verify` 最后执行完整 `phase1:verify`；CI 使用 frozen lockfile | Quality | 开放 |
| P2-R-016 | 产品将内部工程预览误称为正式发布，遗漏签名/安装/更新边界 | 2×4=8 中 | 版本和文档固定 `0.2.0-phase2`/内部预览；验收明确排除发布能力 | Product/Release | 开放 |

## 处置规则

- 高风险必须在 Phase 2 签字前降级、规避或由明确 owner 书面接受；P0/P1 缺陷不得以风险接受替代修复。
- 接受风险必须记录用户影响、暂不修复原因、监控信号、补救方案和复审日期。
- 触发信号出现时将状态改为“发生”，关联缺陷和证据，并重新评估 L/I。
- 新增 Renderer 权限、远程内容、网络访问、文件系统桥、剪贴板或敏感数据 IPC 时，必须新增风险并复审 [ADR-0004](../adr/0004-electron-ui-shell-security.md)。

## Phase 2 关口

- P2-R-001、002、003、004、006、009、011、012 和 015 必须有自动化证据。
- P2-R-005、010 和 013 必须有 Windows 11 实机证据。
- P2-R-014 必须由真实 CI run 验证，不能仅以本地 E2E 关闭。
- 多屏、DPI、任务栏换边和 Explorer 重启的人工矩阵可延期，但 P2-R-006 的纯几何自动测试不得延期。
