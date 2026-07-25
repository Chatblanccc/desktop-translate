# Phase 7 开发计划：First Signed Limited Beta

- 文档状态：`FROZEN TO USER-APPROVED SEQUENCE`
- 当前执行位置：M3 第三版真实 custom-root fresh install、第五版 fresh-directory/marker 与第六版
  committed-stage handle-relative identity gates，以及当前候选默认 CurrentUser registered rerun +
  interactive/Quiet uninstall、10-state durable checkpoint crash/recovery、canonical product-key
  `Deny Delete` pre-mutation fail-closed 已通过；partial registry/其余 ACL/path/process fault、
  跨版本升级、正常 installed-app 退出、物理输入与 clean VM 待补 /
  M4 PWS v3、blind v2 与 candidate-generation 交叉绑定工具已加固
  （真实 candidate generation、formal run 与人工盲评尚未通过）
- 当前验收状态：`NOT YET ACCEPTED`
- 最终交付上限：Windows x64 signed limited beta
- 明确禁止的口径：public V1、GA、production-ready
- 更新日期：2026-07-25

Phase 7 在现有划词、UIA/OCR、source-only 卡片、BYOK 在线翻译和 Phase 6 UI 基线上，
完成发布前的首轮产品迭代：可选安装目录、悬浮球自由拖动、离线模型、本地教程和首版手动更新。

本计划有两个必须由用户作出选择的暂停点：

- **Gate A 是模型路线决策**：先提交真实许可证、体积、质量、延迟和内存数据；用户确认后才能做完整集成。
- **Gate B 是产品身份与发布资源决策**：用户确认产品/发布者身份，并安全提供 Authenticode 能力以及
  阿里云 OSS 或腾讯云 COS 之一；确认前不得连接真实发布基础设施。

Gate A/B 都不是最终发布验收。`SIGNED LIMITED BETA` 只能在 M8–M10 的真实签名、国内 feed、clean VM、
完整 QA、8 小时 signed-candidate soak、8 名受邀用户和最终收口全部完成后使用。

## 1. 目标

1. 标准用户可在首次安装时选择应用目录。
2. 悬浮球支持吸附边缘和自由位置两种模式，并可靠恢复跨 DPI/显示变化后的相对位置。
3. 用隔离 POC 先量化本地模型，再由用户选择模型、语言方向和存储路线。
4. Gate A 后才实现本地翻译 Host、模型管理和 `划词 → 本地翻译 → 结果卡`。
5. 提供五步本地教程和一次真实 Notepad 划词练习。
6. 首版更新采用用户主动检查、完整 installer、手动安装，不做静默自动更新。
7. Gate B 后才接入真实 Authenticode 与国内对象存储，最终形成 signed limited beta。

## 2. 全阶段不可退让约束

- **source-only fail-closed**：翻译、模型或更新失败时保留原文；不得空白、退出或自动联网兜底。
- **latest-wins**：`selectionId + requestId` 决定唯一可见结果；取消后的旧结果必须丢弃。
- **no content persistence**：原文、译文、截图和 Provider body 不进入数据库、history、cache、日志、
  metrics、crash、更新请求或验收 artifact。
- **Main-only orchestration/network**：Renderer 与 Selection Host 不访问 Provider、模型 feed 或更新 feed；
  Local Translation Host 只做离线推理，不联网、不读取凭据。
- **普通用户权限**：不新增服务、驱动、注入、`uiAccess` 或管理员权限依赖。
- **显式联网**：在线翻译、模型下载和应用更新检查都由独立用户动作触发。
- **证据先于结论**：未执行项保持 `NOT RUN`；开发自动化不能冒充实机、用户决策或最终发布证据。

## 3. 范围

### 3.1 必须交付

- per-user assisted installer 的首次安装目录选择；
- 悬浮球 `edge/free` 模式、自由拖动、持久化相对位置和真实鼠标/触控板验证；
- 离线模型 POC 与 Gate A 用户决策包；
- Gate A 后的独立 Local Translation Host、model manager 和离线翻译闭环；
- 默认模型路径、真实占用、删除入口；是否允许自定义模型路径由 Gate A 决定；
- 五步本地教程、Notepad 练习、结果/错误/恢复体验；
- fake feed 驱动的首版手动 updater；
- Gate B 用户身份/资源确认；
- Gate B 后的真实签名、阿里 OSS/腾讯 COS feed、clean VM；
- 最终签名候选 8 小时验证、8 名受邀用户和 M10 收口。

### 3.2 明确不交付

- public V1、公开推广、GA 或企业 SLA；
- 静默安装、强制更新、差分 patch 或后台自动下载；
- 云 OCR、剪贴板轮询、模拟复制、屏幕录制、教程遥测；
- history、favorites、持久翻译 cache、账号、同步或用户正文反馈上传；
- 任意模型/插件导入、训练、云推理代理；
- machine-wide installer、Windows 服务、提权、驱动或注入；
- macOS、Linux、移动端和 Windows on ARM。

## 4. 严格里程碑顺序

| 里程碑 | 工作内容 | 必须退出条件 |
|---|---|---|
| M0 用户确认 | 确认 Phase 7 目标、范围、两道用户 Gate 和 limited-beta 口径 | 用户明确批准方案；未确认不开始 M1 |
| M1 同步与基线 | 同步 live `main`、创建 `codex/phase7-first-beta`、记录 SHA/clean 状态并跑基线 | 分支与基线证据可追溯；不覆盖无关本地改动 |
| M2 文档与身份占位 | 冻结本目录四份文档；列出产品名、appId、publisher、feed 等待确认字段 | 文档一致；身份仍是占位，不接真实证书/存储 |
| M3 安装目录 + Ball | 开启 assisted installer 目录选择；实现 `edge/free`、拖动与 anchor 迁移 | 自动化回归及真实鼠标、触控板证据完成 |
| M4 离线模型 POC | 在隔离 harness 中比较候选，不接完整产品和真实发布 feed | 提交许可证、体积、200/方向盲测、延迟、PWS 报告 |
| **Gate A 用户模型决策** | 用户审阅 M4 实测并选择模型、语言方向与模型存储路线 | 用户明确选择；未确认禁止 M5 完整集成 |
| M5 Local Host + Model Manager | 仅按 Gate A 路线实现 Host、模型包、下载/校验/回滚/删除 | 离线闭环、故障回退、latest-wins、隐私与退出通过 |
| M6 教程 + 结果 + 错误 | 五步教程、Notepad 练习、本地结果状态和可恢复错误 | 本地资产、零遥测、真实教程走查通过 |
| M7 Fake Feed 手动 Updater | 用 fake feed 完成“检查 → 展示 → 用户确认下载 → 重启安装/稍后” | 无后台检查、无自动下载/静默安装；升级/错误状态可测 |
| **Gate B 用户发布输入** | 用户确认产品/发布者身份，并提供真实 Authenticode 与 OSS/COS 其一 | 用户明确确认；未确认禁止接真实发布基础设施 |
| M8 签名国内 Feed + Clean VM | 使用 Gate B 输入签最终字节，接国内 feed，执行独立下载和 clean VM | exact 签名/hash/feed/安装/升级/回滚证据通过 |
| M9 QA + 候选试用 | 完整 QA、最终签名候选 8 小时 soak、8 名受邀用户 | 零不可豁免缺陷；反馈与已知问题已复评 |
| M10 收口 | 修复/重跑、文档/风险/manifest、用户最终 go/no-go 和受控发布 | 完整验收后才标记 `SIGNED LIMITED BETA` |

顺序固定为：

`M0 → M1 → M2 → M3 → M4 → Gate A → M5 → M6 → M7 → Gate B → M8 → M9 → M10`

不得把 Gate A/B 移到发布验收尾部，也不得在用户确认前“先把完整集成或真实基础设施做完再说”。

## 5. M4 POC 固定报告口径

POC 使用公开、可再分发或自建合成语料，不读取用户历史。每个候选必须交付原始数据和摘要：

| 指标 | Phase 7 口径 |
|---|---|
| Base installer | 不含模型，目标 `≤150 MiB` |
| Core model pack | 目标 `≤300 MiB`；`>300 MiB` 必须在 Gate A 决定是否增加自定义模型路径；硬上限 `≤400 MiB` |
| Cold translation p95 | `≤3.0 s` |
| Warm translation p95 | `≤1.5 s` |
| POC runtime process PWS | `≤1.1 GiB` |
| 质量样本 | 每个拟支持方向至少 `200` 条 blind evaluation |

质量不预填虚假的 PASS 分数。报告必须展示实际正确率/人工偏好、严重错译、未译、乱码、专名和长句失败，
并同时提交模型来源、revision、许可证、再分发条件、runtime/CPU 要求及原始/解包体积。

Gate A 由用户从真实报告中选择：

1. 模型/runtime 与支持语言方向；
2. 继续、换模型、缩小方向或停止本地模型路线；
3. 固定默认模型路径，或因 core pack `>300 MiB`/用户偏好而在 M5 加入自定义路径与迁移。

在 Gate A 前，产品只需展示规划中的默认模型路径、预计/实测体积和“可删除”语义；不得提前实现或承诺
自定义模型存储。

## 6. Gate B 输入与首版更新策略

Gate B 需要用户确认：

- 最终产品显示名、appId/升级身份、installer 名和 beta channel；
- 预期 Authenticode publisher subject，并通过受保护方式提供可用签名能力；
- 阿里云 OSS 或腾讯云 COS 之一，以及最终 HTTPS 域名/对象前缀；
- 下载页、隐私/许可证和有限测试范围所用的产品口径。

证书、私钥、密码和云密钥不得发到聊天、源代码、`.env`、命令行或日志；只能进入受保护发布环境。
Gate B 确认仅授权 M8 接真实资源，不等于候选已签名、feed 已验证或 limited beta 已验收。

首版 updater 固定为：

1. 不后台轮询；用户主动点击“检查更新”；
2. Main 获取并验证 manifest，展示版本、体积、publisher、release notes 与完整 installer；
3. `autoDownload=false`；用户明确点击下载后，Main 才在应用内下载完整 signed installer；
4. `autoInstallOnAppQuit=false`；下载完成后由用户选择“重启并安装”或“稍后”，不得因普通退出静默安装；
5. 不做 blockmap、差分、强制更新、无人确认安装或自动降级。

Renderer 只发出类型化的检查、下载、取消和安装动作，不得提供 URL、文件路径或版本；生产 feed 也不得由
Renderer、环境变量或命令行覆盖。M7 只使用 fake feed/test key 验证状态机，M8 才将同一契约连接到
Gate B 选择的国内对象存储和真实签名。

## 7. 最终 Signed Limited Beta 验收

Gate B 后仍必须完成：

- 对最终 signed candidate 的 clean VM 安装、更新、修复/重装、卸载和回滚；
- 对应用、Selection Host、Local Translation Host、installer、manifest 和模型包的 exact 签名/hash 验证；
- source-only、latest-wins、Main-only、no-content-persistence 和零残留进程复验；
- 最终签名候选连续 8 小时产品 soak；
- 8 名受邀用户使用同一候选并完成隐私安全的反馈闭环；
- 已知问题、风险、回滚、下载对象和 evidence manifest 收口；
- 用户基于完整工程/质量证据作出最终 go/no-go。

这里不设置 Phase 5 式四角色强制签字。Engineering/Quality 提供必要证据，Security/Privacy 门禁由相应测试
证明，产品路线和最终发布由用户决定。

## 8. 状态词

| 状态 | 含义 |
|---|---|
| `PLANNED` | 已列入范围，没有实现证据 |
| `IN DEVELOPMENT` | 正在实现，不能推断可用 |
| `NOT RUN` | 验证尚未执行 |
| `DEVELOPMENT PASS` | 开发/自动化证据通过，不等于用户 Gate 或最终验收 |
| `FAIL` | 已执行但不满足要求 |
| `BLOCKED` | 缺少前置输入、用户选择或不可豁免证据 |
| `GATE A INPUT READY` | M4 报告完整，可提交用户选择 |
| `GATE A CONFIRMED` | 用户已选择模型/语言/存储路线，允许进入 M5 |
| `GATE B INPUT READY` | 产品身份、证书和 OSS/COS 选项已准备，可提交用户确认 |
| `GATE B CONFIRMED` | 用户已确认并授权 M8 接真实基础设施；不是发布验收 |
| `FINAL ACCEPTANCE PASS` | M8–M10 对同一签名候选完成全部必要证据 |
| `SIGNED LIMITED BETA` | `FINAL ACCEPTANCE PASS` 后的受邀发布状态 |
| `ACCEPTED RISK` | 仅限可豁免项，记录用户影响、owner、复审日和回滚 |

## 9. 文档

- [M1 基线记录](m1-baseline.md)
- [M3 开发验证](m3-validation.md)
- [M4 开发证据](m4-development-evidence.md)
- [架构决策](architecture-decisions.md)
- [风险登记](risk-register.md)
- [验收清单](acceptance-checklist.md)

更改里程碑顺序、Gate A/B 含义、POC 数值、隐私边界、签名/国内 feed 或最终 limited-beta 条件，必须先
更新本目录并重新取得对应用户决策。
