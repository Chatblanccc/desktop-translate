# Phase 4 风险登记

- 状态：本地自动化、真实成功路径、脱敏传输、隐私 canary 与降级复评完成；真实故障、兼容性、远程 CI 与签字仍未完成
- 评分：可能性（L）与影响（I）各 1–5，初始分为 `L × I`
- 基线：Phase 3 验收提交 `1fe45d3c5959b1e45170df21e790d61b69f3f38b`

状态含义：

- `自动化已控制`：当前工作区存在可复现测试/扫描证据；不代表已经签字接受风险。
- `部分控制 / PENDING`：已有自动化控制，但真实故障、硬件、远程 CI 或验收证据仍缺失。
- `开放 / BLOCKER`：完成定义要求的关键证据尚未取得，阻断最终验收。

## Phase 4 风险复评

| ID | 风险 | 初始分 | 已取得证据 | 当前状态 |
|---|---|---:|---|---|
| P4-R-001 | APP ID/密钥进入源码、SQLite 明文、Renderer、日志、命令行或产物 | 25 严重 | Main-only vault；safeStorage 不可用/损坏/轮换测试；跨重启 E2E 数据库/WAL 检查；真实 userData/Temp/artifact canary 无命中；当天匹配 crash/WER 为 `0` | 当前本机运行窗口已控制；待 Security/Privacy 签字 |
| P4-R-002 | 请求携带截图、窗口/进程、坐标或 selection 元数据 | 25 严重 | fake transport 逐字段断言；真实固定探针 attestation 字段严格为 `appid/from/q/salt/sign/to`，`forbiddenFields=[]` | 已控制；待 Security/Privacy 签字 |
| P4-R-003 | 旧请求或重试的迟到结果覆盖新 selection | 20 高 | `selectionId + requestId` latest-wins；迟到 success/failure、rapid selection、双击 retry 测试 | 自动化已控制 |
| P4-R-004 | 升级、启动、缺同意或缺凭据时意外联网 | 20 高 | 默认 `enabled=false`；consent/credential fail-closed；E2E fetch trace 零请求 | 自动化已控制 |
| P4-R-005 | redirect、host 混淆或错误 transport 向非允许地址发送文本/凭据 | 20 高 | HTTPS exact-host/port/auth allowlist；负向矩阵；真实单请求 Main PID 命中批准的百度 DNS/443，Renderer/Native Host 为 `0` | 已控制；待 Security/Privacy 签字 |
| P4-R-006 | 认证、配额、限流、网络或 5xx 导致卡死或全局取词故障 | 16 高 | 稳定错误矩阵、8 秒截止、无自动重试、source-only 降级、Native lifecycle 隔离；2026-07-18 真实连接与 Chrome 成功路径通过 | 部分控制；真实百度故障 smoke `PENDING` |
| P4-R-007 | 畸形/超长响应或富文本造成崩溃、内存放大或 Renderer 注入 | 20 高 | 256 KiB 分块上限、非法 UTF-8/JSON/缺字段测试；恶意 HTML/URL 纯文本渲染；CSP | 自动化已控制 |
| P4-R-008 | safeStorage 不可用、密文损坏或用户上下文变化导致凭据无法恢复 | 16 高 | fail closed、超时、key rotation；unavailable 状态允许删除/重配；运行期解密失败立即禁用、持久化禁用并阻止重复尝试；“损坏密文 → 重启 unavailable/零出站 → 删除 → 再重启 missing”E2E repeat `3/3` | 自动化已控制 |
| P4-R-009 | 未取消的 fetch/timer/Provider promise 阻塞退出并残留进程 | 15 高 | Abort/停止态矩阵；30 秒 graceful E2E 退出预算；2026-07-18 最新 `185.2s` 完整 `phase4:verify` residual scan 与真实审计实例结束残留均为 `0` | 自动化已控制 |
| P4-R-010 | 双语卡在小工作区/高 DPI/任务栏边缘出屏、被遮挡或抢焦点 | 12 中 | workArea clamp、长文滚动；每次展示 `showInactive → moveTop → setAlwaysOnTop('floating')` 且不 focus；Chrome/Notepad 在 Win11 build 26200、单屏 1440×960、150%/底部任务栏复测成功 | 部分控制；100/125/200%、其余任务栏方向、旋转/物理多屏 `PENDING` |
| P4-R-011 | CI 依赖真实密钥、泄露 secret 或因外部波动不确定失败 | 20 高 | 本地 CI workflow 仅运行 fake Provider；本地门禁无真实 secret | 开放 / BLOCKER：远程 CI、artifact 与 fork 权限证据 `PENDING` |
| P4-R-012 | Provider endpoint、语言、配额、条款或隐私政策变化 | 15 高 | adapter 隔离和稳定降级；2026-07-16 实际渲染复核 [`/doc/23`](https://fanyi-api.baidu.com/doc/23)、[`/doc/6`](https://fanyi-api.baidu.com/doc/6)与[隐私页](https://fanyi-app.baidu.com/static/agreement/privacy.html)，endpoint/POST/UTF-8/签名/6000 bytes/语言/错误码一致；协议要求客户端不缓存，当前实现无缓存/历史 | 已控制；下次发布重新复核 |
| P4-R-013 | UTF-16 字符数与 UTF-8 请求字节不一致导致超限或截断 | 12 中 | 32768 UTF-16 + 6000 UTF-8 双重校验；emoji/CJK/孤立代理项边界；不截断 | 自动化已控制 |
| P4-R-014 | 测试连接或手动重试绕过同意并重复发送用户文本 | 16 高 | 固定非用户探针受 consent 门禁；重试只来自当前失败卡且使用新 ID；无后台 retry | 自动化已控制 |
| P4-R-015 | 误用预留 history/cache 表导致原文/译文落盘 | 20 高 | SQLite integration canary：history/favorites/cache 均 `0` 行，数据库字节无原文/译文；privacy scan PASS | 自动化已控制 |
| P4-R-016 | 超时的旧 getStatus/load/key-rotation 在删除或新保存后迟到返回或写回，泄露旧凭据、复活旧凭据或覆盖新凭据 | 20 高 | generation + 短写提交队列在 mutation 期间拒绝旧读取；挂起加密不阻塞删除；SQLite 原值 CAS 限制轮换写回；迟到失败归类 superseded；2026-07-18 最新完整 `phase4:verify` `185.2s`/exit `0` | 自动化已控制 |

## 当前验收阻断项

以下项目仍然阻断 Phase 4 的最终 `PASS` 或 `PASS WITH ACCEPTED RISKS`：

1. 真实错误凭据、撤销凭据、断网/超时与恢复尚未形成当前凭据/网络环境下的人工证据；
2. `.github/workflows/phase4-windows.yml` 尚无目标提交的远程运行、artifact 与 fork 权限证据；
3. 除本机 150%/底部任务栏单屏 Chrome/Notepad 样本外，剩余 DPI、任务栏方向、旋转、物理多屏、
   Windows 10、权限边界及代表性应用矩阵未完成；
4. 剩余风险 Owner、复审日期、最终处置及 Product、Engineering、Security/Privacy、Quality/Release
   签字尚未完成。

## 继承的 Phase 3 风险

Phase 4 继续继承且不得隐式关闭：

- `P3-R-001 / P3-R-002`：真实应用与 OCR 语言/图像矩阵不完整；
- `P3-R-004 / P3-R-015`：物理多屏、旋转、额外 DPI 与远程 CI 证据缺口；
- `P3-R-007 / P3-R-010`：管理员、安全桌面、DRM、游戏/反作弊场景；
- `P3-R-014`：8 小时长稳尚未完成。

新增网络能力的本地自动化没有扩大 Native 捕获或 Renderer 网络权限，但上述继承风险仍需按 Phase 3
原处置继续管理。

## 立即阻断与回滚条件

出现以下任一情况必须停止发布、关闭 `translation.enabled` 并回到 Phase 3 source-only：

- 明文密钥、签名、用户原文/译文进入日志、非 secret 表、bundle 或 artifact；
- 缺 opt-in 时产生 Provider 网络请求；
- 请求到达非 allowlist host，或 Renderer/Native Host 直接联网；
- stale translation 覆盖新卡，或 Provider 故障把 Native lifecycle 置为 faulted；
- 取消/退出后请求继续活跃并阻塞退出；
- Provider 内容被当作 HTML 执行或触发导航；
- 数据库变化使 Phase 3 二进制无法读取现有数据。

## 最终接受记录

当前没有完成最终风险接受；剩余分、Owner 接受和复审日期必须由验收角色填写。

| ID/范围 | 剩余 L | 剩余 I | 剩余分 | 最终处置 | Owner | 复审日期 |
|---|---:|---:|---:|---|---|---|
| P4-R-001/002/005：隐私与真实流量 | `PENDING` | `PENDING` | `PENDING` | 证据完成，待签字 | `PENDING` | `PENDING` |
| P4-R-006：真实故障/恢复 | `PENDING` | `PENDING` | `PENDING` | 保持开放 | `PENDING` | `PENDING` |
| P4-R-010 + 继承兼容性风险 | `PENDING` | `PENDING` | `PENDING` | accepted-risk 候选，尚未接受 | `PENDING` | `PENDING` |
| P4-R-011：远程 CI/fork/artifact | `PENDING` | `PENDING` | `PENDING` | BLOCKER | `PENDING` | `PENDING` |
| P4-R-012：Provider 漂移 | `PENDING` | `PENDING` | `PENDING` | 下次发布复核，待 Owner | `PENDING` | `PENDING` |
| 其余自动化已控制项 | `PENDING` | `PENDING` | `PENDING` | 待最终签字 | `PENDING` | `PENDING` |
