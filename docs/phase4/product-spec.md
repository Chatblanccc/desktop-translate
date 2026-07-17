# Phase 4 产品规格：在线文本翻译闭环

- 状态：开发基线已冻结；实现与验收进行中
- 目标版本：`0.4.0-phase4`
- 开发基线：Phase 3 验收提交 `1fe45d3c5959b1e45170df21e790d61b69f3f38b`
- 目标平台：Windows 11 x64；Windows 10 22H2 x64 为 best-effort 兼容目标
- 发布口径：内部开发预览，不是正式安装包

## 1. 阶段目标

Phase 4 在已经验收的 Phase 3 本地取词链路上增加真实在线翻译：Main 接收 UIA/OCR
最终文本后，在用户明确启用并配置自己的凭据时调用百度通用文本翻译 Provider，并在同一结果卡中展示
翻译中、译文或可恢复失败状态。

本阶段的核心不是扩大采集范围，而是建立一个可替换、可取消、可降级且默认不联网的 Provider 边界。
任何 Provider、网络或凭据错误都不得破坏 Phase 3 的 source-only 路径。

## 2. 已冻结的产品决策

| 项目 | Phase 4 决策 |
|---|---|
| Provider | 仅接入百度通用文本翻译，稳定标识为 `baidu` |
| 凭据 | BYOK；用户提供百度 APP ID 与密钥，不内置公共生产凭据 |
| 默认联网 | `translation.enabled=false`；升级与全新安装均默认关闭 |
| 同意 | 首次启用前明确说明原文将发送给百度，并记录同意版本 |
| 源语言 | 默认 `auto`，Phase 4 暴露 `auto / zh-CN / en / ja / ko` |
| 目标语言 | 默认 `zh-CN`，Phase 4 暴露 `zh-CN / en / ja / ko` |
| 能力 | 仅文本翻译；不承诺词典、音标、发音、例句或富文本 |
| 重试 | 不自动重试；只允许用户明确点击重试，且产生新 `requestId` |
| 缓存 | 不作为完成条件；禁止持久缓存。若实现，只能是有界 Main 内存缓存，退出即清空 |
| 历史数据 | 不写翻译历史、不提供收藏，也不写 `translation_history`、`favorites`、`translation_cache` |
| 网络 | 只有 Electron Main 的 Provider 层可以访问翻译服务 |
| 失败策略 | 保留原文并降级为 source-only/失败卡；Native 取词生命周期不进入 faulted |

百度当前产品页说明通用文本翻译支持源语言自动检测；能力与配额可能变化，发布前必须按
[百度通用文本翻译接入文档](https://fanyi-api.baidu.com/doc/23)复核，不把营销口径固化为应用 SLA。

## 3. 用户路径

### 3.1 首次配置

1. Settings 展示 Provider 为“百度通用文本翻译”、源/目标语言、凭据状态、
   [百度翻译隐私政策](https://fanyi-app.baidu.com/static/agreement/privacy.html)与
   [开放平台服务协议](https://fanyi-api.baidu.com/doc/6)。
2. 用户输入 APP ID 与密钥；Renderer 只能提交替换请求，保存后不能读取或回显密钥。
3. 用户勾选/确认“选中的文本将发送给百度翻译”，随后显式启用在线翻译。
4. Main 保存非敏感设置和同意版本，并通过 `safeStorage` 加密后保存凭据。
5. “测试连接”使用固定、非用户文本探针；它同样要求已完成隐私同意，并明确产生一次网络请求。

只有 `enabled=true`、同意版本有效、Provider 匹配、凭据可解密且文本通过边界校验时，划词才可发起
Provider 请求。任一条件不满足时必须零出站并继续展示原文。

### 3.2 正常翻译

1. Phase 3 产生新的、已验证的 `selectionId` 和原文。
2. Main 立即发布 `translating` 卡片，原文无需等待网络即可见。
3. Main 为该次翻译生成独立 `requestId`，建立可取消的 8 秒总截止时间。
4. Provider 返回后，Main 校验响应并仅在 `selectionId + requestId` 仍为当前任务时发布译文。
5. 卡片显示原文、译文、目标语言和“百度翻译”归属，不显示凭据或请求细节。

### 3.3 失败与重试

- 缺凭据、解密失败、认证失败、配额/限流、断网、超时、5xx、畸形响应和不支持语言均映射为稳定错误码。
- 卡片始终保留原文，错误提示必须可理解且不得包含 Provider 原始响应、请求 body、APP ID 或密钥。
- 只有明确可重试的错误显示“重试”；点击后产生新 `requestId`，不得复用已经取消的任务。
- 应用不自动重发选中文本，不因 Provider 故障自动切换到其他供应商。

## 4. 设置与凭据

非敏感设置至少包括：

- `translation.enabled`：布尔值，默认 `false`；
- `translation.providerId`：固定为 `baidu`；
- `translation.sourceLanguage`：默认 `auto`；
- `translation.targetLanguage`：默认 `zh-CN`；
- `translation.consentVersion`：用户接受的隐私告知版本；未接受时为空。

凭据由 Main-only Credential Vault 管理，逻辑上包含 APP ID 与密钥：

- 使用 Electron `safeStorage` 的异步接口加密后写入 `secrets` 表；
- Renderer、Preload、Native Host、日志和错误对象不得获得明文；
- Renderer 只接收 `missing`、`configured` 或 `unavailable` 状态；
- 保存操作是全量替换，删除操作清除整组凭据并立即取消活动请求；
- `safeStorage` 不可用、密文损坏或解密失败时 fail closed，不回退明文存储；
- 本阶段优先复用现有 `settings` 与 `secrets` 表，不新增 migration。

Windows 上 `safeStorage` 使用 DPAPI，但不承诺抵御已控制同一用户会话的恶意进程；相关边界见
[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。

## 5. Provider 与网络策略

### 5.1 请求边界

- 只允许 HTTPS 且 host 精确匹配 `fanyi-api.baidu.com`；拒绝 HTTP、其他 host 和跨 host 重定向。
- 调用通用文本翻译 endpoint 时使用 POST；原文与密钥不得写入 URL、命令行或日志。
- 请求只包含规范化原文、源/目标语言、APP ID、随机盐值、签名等 Provider 必需字段。
- 禁止发送截图、窗口标题、进程、PID/HWND、坐标、selection 元数据、OCR 置信度或本地路径。
- `TranslationRequest.text` 先受契约的 `32768` UTF-16 code unit 上限约束；百度适配器再执行
  `6000` UTF-8 bytes 的内部防护上限。该值是本产品的安全上限，不声明为 Provider 配额。
- 每次请求总超时为 8 秒；响应 body 上限为 256 KiB；达到任一上限立即取消并返回稳定错误。
- Phase 4 禁止自动重试；限流响应可提供等待提示，但仍需用户重新触发。

### 5.2 响应边界

- Provider body 是不可信输入，必须在 Main/Provider 边界校验状态码、JSON 类型、数组长度和文本长度。
- `requestId`、`selectionId`、接收时间、Provider 归属和缓存标记由可信编排层生成，不信任远端同名字段。
- Provider 错误详情只用于本地稳定错误映射，不进入 Renderer；未知响应按 `malformed-response` 或
  `provider-unavailable` fail closed。
- 译文以纯文本渲染；禁止 `innerHTML`、远端脚本、远端图片、富文本和可点击远端音频。

## 6. 翻译状态与并发

结果卡使用判别状态表达，不用可选字段拼出隐式状态：

- `source-only`：在线翻译关闭、缺少同意/凭据，或本次请求未启动；
- `translating`：显示原文和加载状态；
- `translated`：显示原文、译文和 Provider 归属；
- `failed`：显示原文、稳定错误文案和按策略出现的手动重试。

以下事件必须取消活动 Provider 请求并使迟到结果失效：

- 新 selection；
- 用户关闭卡片；
- 关闭在线翻译或删除/替换凭据；
- 暂停划词、Host 断线/重启；
- 显示配置变化导致当前 selection 失效；
- 应用退出。

无论取消是否及时抵达网络栈，success、failure 和可选 cache hit 都必须同时匹配当前
`selectionId + requestId`；迟到结果不得重开或覆盖当前卡片。

## 7. UI 与 IPC

- Settings 增加 Provider 说明、源/目标语言、在线翻译开关、同意状态、凭据保存/替换/删除和测试连接。
- Card 只通过专用白名单 view model 接收原文和翻译状态；敏感 Provider 错误不得下沉。
- Settings IPC 必须校验 sender、角色和 payload；Ball/Card 不能调用凭据写接口。
- 所有 Renderer 继续保持 `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`，CSP 继续
  禁止 Renderer 网络（`connect-src 'none'`）。
- 翻译内容增高时卡片仍需 clamp 到当前显示器 `workArea`，正文区域滚动且不抢焦点。

## 8. 数据保留与可观测性

- 原文与译文仅存在于当前 Main/Card 生命周期，不写 SQLite、普通日志、诊断 artifact 或 crash artifact。
- 本阶段不读写 `translation_history`、`favorites`、`translation_cache`。
- 若实现进程内缓存，必须限容量、不得落盘、不得跨凭据/Provider/语言配置复用，并在退出时清空。
- 可记录 Provider ID、稳定错误码、耗时桶、字符数桶、是否取消；禁止记录正文、凭据、签名、盐值和请求/响应 body。

## 9. 阶段外内容

- 第二家 Provider、自动 Provider 切换、自有服务端代理或公共应用密钥；
- 词典、音标、发音、例句、术语库和富文本；
- 历史、收藏、持久翻译缓存、账号同步和跨设备设置；
- 云 OCR、截图上传、剪贴板轮询或模拟 `Ctrl+C`；
- 安装器、代码签名、自动更新、正式发布、完整 SBOM；
- Phase 5 的 p50/p95、8 小时 soak、资源和包体性能门禁。

## 10. 完成定义

Phase 4 只有在以下条件全部满足时才能标记为 `PASS` 或 `PASS WITH ACCEPTED RISKS`：

1. `pnpm phase4:verify` 无关键 skip 且退出码为 `0`；
2. fake Provider 覆盖成功、错误、超时、取消、超大和畸形响应；
3. Electron E2E 覆盖 opt-in、设置、卡片四态、手动重试和 latest-wins；
4. 隐私扫描证明凭据、测试原文、请求/响应 body 未进入仓库产物或 artifact；
5. 使用专门测试账号完成真实百度 Provider smoke，证据不得包含凭据或真实敏感文本；
6. Phase 1/2/3 完整回归通过，Native Host 与 Renderer 没有新增联网能力；
7. 回滚开关与 source-only 降级通过；
8. 无未处置 P0/P1 缺陷，所有未执行项都在验证报告和风险登记中明确记录。
