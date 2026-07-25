# Phase 7 风险登记

- 状态：`ACTIVE`
- 评估日期：2026-07-25
- 分级：概率 `1–5` × 影响 `1–5`；`1–7 低`、`8–14 中`、`15–24 高`、`25 严重`
- owner：User/Product、Engineering、Security/Privacy、Quality/Release；不要求 Phase 5 式四角色强制签字

`OPEN` 表示没有充分证据；`CONTROLLED DEVELOPMENT` 只表示开发控制有效；`ACCEPTED RISK` 必须记录
用户影响、owner、复审日和回滚。Gate A/B 的用户决策不能把技术风险自动改成 PASS。

| ID | 风险 | 初始分 | 主要控制与所需证据 | 当前状态 / owner |
|---|---|---:|---|---|
| P7-R-001 | M4 实测前就完成集成，锁死错误模型/runtime | 20 高 | 隔离 POC；Gate A 提交真实数据；未获用户确认禁止 M5 | OPEN / User + Engineering |
| P7-R-002 | 模型许可证、来源或再分发条件不允许 beta 分发 | 25 严重 | 上游 revision、license/notice、再分发审查作为 Gate A 输入 | OPEN / User + Engineering |
| P7-R-003 | 质量样本过少或不盲测，使模型路线假绿 | 20 高 | 每方向 ≥200 blind evaluation、原始记录、失败分类与实际分数 | OPEN / Quality |
| P7-R-004 | 体积/延迟/PWS 超预算，用户仍被隐藏真实成本 | 20 高 | 150/300/400 MiB、3s/1.5s、1.1 GiB 门槛和原始 benchmark | OPEN / Engineering + Quality |
| P7-R-005 | core pack 未实测就提前实现/承诺自定义模型路径 | 12 中 | Gate A 根据 `>300 MiB` 与用户偏好选择；此前只显示默认路径/大小/删除 | OPEN / User + Engineering |
| P7-R-006 | 自由拖动只过合成坐标测试，真实鼠标/触控板不可用 | 16 高 | edge/free、horizontalRatio、重启/DPI/多屏及两种真实输入证据 | OPEN / Quality |
| P7-R-007 | Ball anchor 迁移或显示变化使悬浮球丢失/越界 | 16 高 | 旧 edge 规范化、ratio clamp、display fallback、负坐标/热插拔测试 | OPEN / Engineering |
| P7-R-008 | Renderer、Selection Host 或 Local Host 绕过 Main 联网 | 25 严重 | 角色化 IPC、固定 Host、无 Host 网络、进程 egress 审计 | OPEN / Security/Privacy |
| P7-R-009 | 原文/译文进入 DB、日志、crash、feed、artifact 或反馈 | 25 严重 | no-content schema、UTF-8/UTF-16 canary、目录/网络复扫 | OPEN / Security/Privacy + Quality |
| P7-R-010 | stale 本地结果覆盖新 selection，或取消/退出后回写 | 20 高 | 双 ID、cancel、Main/Renderer 复核、kill/timeout/race 测试 | OPEN / Engineering |
| P7-R-011 | 模型包篡改、路径穿越或迁移/删除逃逸产品根 | 25 严重 | 签名 manifest、exact set、同卷 staging、reparse/路径负测 | OPEN / Engineering + Security |
| P7-R-012 | M7 fake feed 被误接 production 或被当成发布通过 | 20 高 | production 拒绝 fake/test key；状态固定 DEVELOPMENT PASS | OPEN / Engineering + Release |
| P7-R-013 | Gate B 前连接真实证书/OSS/COS，或 secret 进入聊天/仓库/日志 | 25 严重 | 身份占位、用户确认、protected environment、secret 扫描 | OPEN / User + Security/Release |
| P7-R-014 | Gate B 确认被误写为候选已签名或 limited beta 已验收 | 20 高 | Gate B 仅授权 M8；M8–M10 与最终 go/no-go 独立 | OPEN / User + Release |
| P7-R-015 | 手动更新 manifest 被篡改、重放、降级或指向错 publisher | 25 严重 | signed metadata、channel/version/subject 约束、完整 installer 复验 | OPEN / Security + Release |
| P7-R-016 | 五步教程隐式联网、读取 selection 或产生遥测 | 20 高 | 本地合成资产、最小枚举状态、Notepad 人工输入、零 analytics | OPEN / Security/Privacy |
| P7-R-017 | 最终签名候选短测代替 8 小时或开发包代替最终字节 | 20 高 | M9 exact signed candidate 8h、进程/隐私/资源完整记录 | OPEN / Quality |
| P7-R-018 | 8 名用户样本被跳过，或反馈收集泄露用户正文 | 16 高 | 同一候选、受邀同意、最小化反馈 schema、正文禁止项 | OPEN / User + Quality |
| P7-R-019 | signed limited beta 被扩大宣称为 public V1/GA | 20 高 | 固定状态词、受邀范围、发布文案扫描、V1 单独阶段 | OPEN / User + Release |
| P7-R-020 | 自定义目录或被篡改 registry/marker/shortcut 字段让重装、升级、卸载覆盖未知路径 | 25 严重 | fresh 空目录/空 shortcut registry；pre-Phase 7 fail closed 并显式卸载/重装；registered exact HKCU uninstall + shortcut fields、stable marker、递归 exact 产品树；Phase 7 recovery marker；全树/祖先 reparse 拒绝；仅 fixed NTFS；按用户 SID 的 Global mutex；native exact process 检查及 whole-root Rename 后竞态复核；同父目录 whole-root staging；Apps & Features 外 `RegCopyTreeW` 双备份和 rollback checkpoints；direct enumeration allowlist + marker-last + 非递归清根；`committed-postcleanup` 可重放；唯一递归删除限 exact AppData 直属叶目录；D:/E:、network/removable/ReFS、shortcut traversal、忙碌/任意层级未知文件与空目录、ACL/marker/cleanup/进程崩溃故障和 clean-VM 快照负测 | CONTROLLED DEVELOPMENT / Engineering + Quality |

2026-07-24 证据更新：第三版 exact unsigned development installer 已在 Windows Shell broker 真实宿主
环境完成 custom-root fresh install，stable marker、HKCU product/uninstall keys、Start Menu shortcut 与零
残留进程复核一致。P7-R-020 仍保持 `CONTROLLED DEVELOPMENT`，因为真实 registered 同版本升级、卸载、
故障注入、完整目录矩阵和 clean VM 尚未完成；packaged-app 虚拟化运行不计解除证据。

2026-07-24 第四版更新：default `Programs` 只按 exact conventional path 延迟计划并在
`CHECK_APP_RUNNING` 后 exclusive 创建；preparation recovery marker 与 writable probe 已改为
exclusive handle ownership/handle-based failure cleanup。package、隔离烟测和证据门通过不解除剩余 P2：
`phase7CleanupCreatedFreshDirectories` 在 pathname/type/no-reparse 校验与非递归 `RMDir` 之间仍有同用户
rename/reparse replacement 窗口，stable/recovery marker 的成功提交生命周期也仍含 pathname 操作。
该窗口要求同一用户恶意进程命中 transaction-preparation 故障清理竞态，且非递归删除不会删除非空树；
这只说明第四版可继续 unsigned development validation，不是 `PASS` 或可接受的发布风险。该定向缺口
由下述第五版证据取代。

2026-07-25 第五版更新：fresh parent/root 现在由 held existing parent 上的 relative
`NtCreateFile(FILE_CREATE)` 原子创建，并持有 no-delete-share handle；rollback 复验 volume/file ID 后只对
原始 handle 设置 `FileDispositionInfo`。Stable/recovery marker 从创建或 recovery open 到最终 commit
始终使用同一 exclusive handle，不再 pathname reopen/delete。标准用户 runtime selftest 7/7、x86 NSIS
marshalling probe、pathname/early-close 负向 mutations、完整 package/evidence gates 均通过，exact
installer 绑定 `HEAD+WORKTREE:2eb074a29b2b5e9019d1385d4cf504fea12a27e82d0db0595be69a4afeb0974c`。
这关闭的是 fresh-directory/marker lifecycle 的定向 P2，不解除 `P7-R-020`：committed uninstall staging
仍以 pathname 枚举/删除 allowlist tree、stable marker 和 empty root，且真实 registered 升级、普通/Quiet
卸载、故障注入、完整目录矩阵与 clean VM 尚未完成。P7-R-020 因此继续为
`CONTROLLED DEVELOPMENT`，不能因第五版 package gate 或一次成功卸载改成 PASS。

2026-07-25 第六版更新：committed uninstall transaction 升级为 v2，在 staging 前持久化 source
volume/file identity；cleanup 对 stage root 与 stable marker 持有 no-delete-share handle，所有固定
allowlist entry 只通过 pinned parent-relative `NtCreateFile` 打开并按 exact handle disposition，
marker-last 与 final empty-root 不再调用 pathname delete/RMDir。9/9 runtime、x86 probes、九类负向
mutations、完整 package、真实默认目录已登记同版本重跑、未知 file/empty-directory fail-closed 与正常
Quiet uninstall 均通过。NSIS 原始 launcher 的外层退出码只表示 Temp self-copy 成功，事务退出码由 exact
Temp copy + `_?=<INSTALL_ROOT>` 取得；负测 inner exit 为 `1` 且现场完整保留。
真实 post-commit delete-share 注入也已取得 `committed-cleanup` + partial stage + durable backup，
释放 handle 后由 exact installer 重放清理并 fresh install，最终 transaction/backup/stage 为零。
2026-07-25 第七版更新：外部 watchdog 已在真实 unsigned candidate 上逐一捕获并终止 10 个 durable
state 的 exact uninstaller/installer-recovery PID；每个状态均由同一 installer 恢复到七项 registry、
三项 installed-file hash 与 userData hash 一致，transaction/backup/stage/相关进程为零，production
include 不含 fault hook。`P7-R-020` 仍保持 `CONTROLLED DEVELOPMENT`：同一状态内部的 partial registry
copy/delete 与 ACL/marker/shortcut 故障、volume/reparse、进程竞态、delete-AppData、跨版本升级、
clean VM、签名候选和正常 installed-app 退出仍未完成。
2026-07-25 ACL 更新：真实 canonical product key current-user `Deny Delete` 曾证明旧 `RegCopyTreeW`
会把受限 ACL 复制进 backup，导致 rollback 后 cleanup 不自动收敛；现场未丢数据，恢复原 ACL 后由同一
installer 收净。修复后两个 canonical key 都在 `un.checkAppRunning` 及任何 mutation 前探测完整
lifecycle access（`0xF023F`/`0xF013F`）。最终同源候选的故障卸载 exit `1`，registry/files/userData
逐字不变且 transaction/backup/stage/进程为零，恢复 ACL 后正常卸载 exit `0`。仅此排列关闭；其余
registry/marker/shortcut ACL 与 partial copy/delete 矩阵仍开放，故风险状态不变。

2026-07-25 M4 交叉绑定更新：formal cold/PWS producer 升级到 v3，blind summarizer 增加 v2；
两者必须绑定同一两方向 authorization、generation raw hash、candidate/run、manifest、model/runtime、
cold workload、source-set、private candidate-output 和 canonical item-identity set。缺失 generation
artifact 的 Windows preflight、candidate remap、authorization candidate-set mismatch 与 reviewed-item-set
substitution 均 fail-closed。真实 200×2 generation/review、20×2 formal run、legal、OS network capture
和 cross-bound package sizing 尚未完成，P7-R-001/002/003/004/005 保持 OPEN。

## Gate 相关停止条件

- M4 报告缺许可证、真实体积、每方向 200 盲测、延迟或 PWS 时，不得请求 Gate A 决策。
- Gate A 未记录用户模型/语言/存储路线时，不得开始 M5 完整集成。
- Gate B 未记录用户确认的产品/发布者身份、真实 Authenticode 和 OSS/COS 选择时，不得开始 M8。
- Gate B 确认、签名成功或对象上传成功均不得直接写成 `SIGNED LIMITED BETA`。

## 不可豁免的产品/发布停止条件

- 原文、译文、截图、凭据或 Provider body 进入持久化、日志、crash、artifact、feed 或反馈；
- Renderer、Selection Host 或 Local Translation Host 直接访问 Provider/update 网络；
- local 故障触发未获同意的 online fallback；
- stale result 覆盖新 selection，或退出后仍有请求/产品残留进程；
- 未签名、错签、被撤销、hash 不符或不兼容的 installer/model 被作为发布候选分发或激活；受控的
  unsigned development validation 必须保持明确隔离且不得宣称发布通过；
- 路径穿越、reparse 或删除/迁移范围逃逸产品根；
- fake feed/test key 进入 production；
- 最终候选未完成 8 小时，或不足 8 名受邀用户就尝试 M10 发布；
- beta 页面、installer 或应用宣称 public V1、GA 或 production-ready。

触发任一停止条件时回到 source-only，并停止相应模型/更新/发布入口。性能或质量不足不能通过放宽隐私、
签名、latest-wins 或用户 Gate 来解决。

## 外部输入与解除证据

| 输入/依赖 | 所在 Gate/里程碑 | 解除所需证据 |
|---|---|---|
| 模型/runtime/语言/存储路线 | Gate A | 用户对完整 M4 报告作出明确选择 |
| 产品名、appId、installer 名、beta channel | Gate B | 用户确认 exact values |
| Authenticode 发布能力 | Gate B/M8 | 安全提供；M8 exact subject/chain/timestamp 独立验证 |
| 阿里 OSS 或腾讯 COS | Gate B/M8 | 用户选择；M8 真实上传、国内 HTTPS 下载和签名/hash 复验 |
| 固定 Windows 11 设备/clean VM | M4/M8/M9 | 设备清单、OS/CPU/RAM/DPI 和 exact candidate 运行记录 |
| 8 名受邀用户 | M9 | 同一签名候选、同意记录、最小反馈和问题复评 |

本阶段不要求四角色密码学签字。最终证据必须能由 Engineering/Quality 复核，并由用户作出路线与发布决定。
