# 安全与隐私策略

状态：V1 架构基线（非法律文本）
适用范围：Electron 应用、`selection-host.exe`、本地 OCR、SQLite、翻译 Provider

## 1. 基本原则

1. **按动作采集**：只有合格划词手势或用户明确的 OCR 框选才读取内容；禁止常驻录屏、剪贴板轮询和后台扫描窗口。
2. **语义优先**：UIA 成功时不截图；OCR 只处理必要的局部区域。
3. **截图留在 Host 内存**：不跨 IPC、不上传、不落盘、不写日志，任务结束或取消后立即释放。
4. **最少外传**：在线翻译只接收最终规范化文本和必要语言参数，不接收截图、窗口标题、进程路径、坐标或 selection 元数据。
5. **本地默认**：现阶段只有设置、排除列表和加密 Provider 凭据保存在当前用户本机，不做账号同步；Phase 4/5 未实现历史、收藏和翻译缓存。
6. **敏感目标拒绝**：密码/受保护元素、安全桌面、排除应用命中后禁止 UIA 取文和 OCR 回退。
7. **可退出、可暂停、可清除**：用户必须能暂停取词、完全退出、重置已实现的本地设置并删除 Provider 凭据；若未来实现历史、收藏或缓存，必须同步提供关闭与清除能力。

## 2. 威胁模型

当前保护资产：选中文字、OCR 像素、本地设置、供应商凭据、Native IPC 控制权、应用更新完整性。若未来实现历史、收藏或缓存，它们必须在启用前纳入同等级保护。

主要威胁：

- Renderer XSS 或依赖被污染后请求特权操作；
- 其他进程抢占/连接 Named Pipe 或发送畸形帧；
- 恶意/异常 UIA Provider 返回超长、畸形或卡死数据；
- 截图/OCR 把密码、财务或私密对话带入日志/崩溃转储；
- 翻译供应商、网络代理或错误请求携带多余上下文；
- 模型、DLL、自动更新或 NPM 依赖供应链被篡改；
- 管理员应用、安全桌面、DRM 与反作弊场景诱使产品绕过系统边界。

V1 不承诺抵御已经控制当前用户会话、管理员权限、操作系统内核或翻译供应商服务端的攻击者。这个边界不能用来省略最小权限、签名、校验和日志脱敏。

## 3. 数据清单与生命周期

| 数据 | 产生位置 | 去向 | 默认保留 | 控制 |
|---|---|---|---|---|
| 鼠标点/选区矩形 | Host | Main（结果元数据） | 内存；结果失效即释放 | 暂停/退出 |
| UIA 原文 | Host | Main；仅显式 opt-in 后发给翻译 Provider | 仅当前 Main/Card 生命周期内存 | 关闭翻译/关闭卡片/退出 |
| OCR crop 像素 | Host | 仅本地 OCR | 仅任务内存 | 不落盘、不上传 |
| OCR 文本 | Host | 与 UIA 原文相同 | 仅当前 Main/Card 生命周期内存 | 同上 |
| 译文 | Main | 当前结果卡 UI | 仅当前 Main/Card 生命周期内存 | 关闭卡片/退出 |
| 翻译历史 | 预留 SQLite 表 | `N/A`：Phase 4/5 未实现、零写入 | `N/A` | 零写入证明 |
| 收藏 | 预留 SQLite 表 | `N/A`：Phase 4/5 未实现、零写入 | `N/A` | 零写入证明 |
| 翻译缓存 | 预留 SQLite 表 | `N/A`：Phase 4/5 未实现、零写入 | `N/A` | 零写入证明 |
| 用户设置/排除列表 | SQLite | 本机 | 卸载或重置前 | 重置 |
| Provider API secret | Main/safeStorage | Provider 请求签名 | 用户删除前 | 删除/替换 |
| Phase 5 性能指标 | 显式验收 MetricsSink | 默认关闭、不上传 | 仅本次脱敏验收 artifact；按 CI 保留策略 | 不启用/删除 artifact |

如果未来实现历史、收藏、缓存或常驻诊断日志，必须在开发前更新本表、设置文案、保留期限、清除语义和
测试，不能把预留表或早期设计当作现有功能，也不能只改代码。

## 4. 屏幕与敏感内容

- UIA 元素 `IsPassword=true`、已知凭据控件、应用自身窗口、用户排除列表、UAC/安全桌面和锁屏必须在 OCR 前短路拒绝。
- 命中受保护元素时不得因为 UIA 无文本而切换 OCR。`IsPassword` 为 true 表示内容受保护：[Microsoft IsPassword](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.ispasswordproperty)。
- OCR crop 只包含拖拽矩形和有上限的上下文边距；不得截取整个虚拟桌面后再长期持有。
- 捕获 API 返回黑帧、访问拒绝或受保护内容时，按失败处理，不尝试规避 DRM、UAC 或反作弊。
- 内存释放不能保证对物理 RAM 做安全擦除，但实现应及时释放并避免多余拷贝；任何调试导出截图功能不得进入发布构建。

## 5. Electron 边界

所有 Renderer：

- `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`；
- 只加载打包本地内容，设置 `default-src 'self'` 为基础的严格 CSP；
- 禁止 `<webview>`、任意导航和未校验的 `window.open`；
- Preload 逐方法暴露 API，校验参数并剥离 Electron event；禁止暴露通用 `send/on/invoke`；
- Main 验证每个 IPC sender、来源窗口和 payload Schema；
- 外链只允许 HTTPS allowlist，并在系统浏览器打开；不把远端页面加载到有权限的 Renderer。

依据：[Electron 安全清单](https://www.electronjs.org/docs/latest/tutorial/security)、[Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)、[Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)。

## 6. Native IPC 与进程

- Pipe 每启动唯一、拒绝远程、当前用户 SID 专属 DACL，并校验 client PID、nonce 和首帧 `hello`。
- Host 与 Main 双向执行 JSON Schema、语义和大小校验；Native 不信任 Main，Main 也不信任 Native。
- Host 标准权限运行，不声明 `uiAccess`，不注入目标进程，不安装驱动/服务。
- Host 父进程 watchdog、有限重启和熔断，避免孤儿进程与崩溃循环。
- Hook 回调不记录原始事件或文本；UIA/OCR 错误不能携带敏感 payload。

详细要求见 [ADR-0001](../adr/0001-selection-host-and-named-pipe.md) 和 [Native IPC](../protocols/native-ipc.md)。

## 7. 本地存储与密钥

- SQLite 位于当前用户应用数据目录，目录 ACL 不得主动放宽；Renderer/Host 无数据库访问接口。
- SQLite 默认不是静态加密数据库，产品文案不得声称“历史已加密”。若未来要求数据库静态加密，需单独选型和密钥恢复设计。
- Provider secret 使用 Electron `safeStorage` 异步 API；Windows 使用 DPAPI，主要隔离其他用户，不能防御同一用户上下文中的恶意进程：[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。
- 不在源码、Renderer bundle、安装包配置、命令行、环境日志或错误消息中放公共 Provider secret。
- 面向普通用户发布时优先由自有国内服务端代理短期凭证，或允许用户提供自己的凭据；两者都需限额与吊销。
- 数据库 migration 必须事务化；删除历史/收藏后同时清理关联 FTS、缓存和 WAL 可回收内容，并在合理时机 checkpoint/vacuum。

## 8. 网络与翻译供应商

- 只有 Main/Provider 层可联网；Native Host 与 Renderer 禁止直接调用翻译服务。
- 只使用 HTTPS，固定供应商 host allowlist，设置连接/总超时、响应上限和重试预算。
- 请求 body 只含原文、源/目标语言、鉴权所需字段；禁止在 URL query 或日志记录原文和 secret。
- 重试只对明确可重试错误生效，不能把同一敏感文本无限重发。
- 设置页在用户启用 Provider 前展示其隐私政策链接和“文本将发送给该供应商”的明确说明。
- 发音 URL 和富文本响应视为不可信；限制协议/域名/MIME/大小，解释内容按纯文本渲染。

## 9. 日志、遥测与崩溃

默认允许记录：应用/协议版本、错误码、能力状态、耗时桶、字符数桶、source、是否 recoverable。默认禁止记录：原文、译文、截图、窗口标题、完整路径/命令行、PID/HWND、精确坐标、Pipe 名、nonce、API key、请求/响应 body。

- 日志本地滚动，默认最多 7 天并设总大小上限。
- V1 遥测默认关闭；若以后加入，必须 opt-in，且只上传聚合/脱敏字段。
- 发布构建不生成包含完整进程内存的 dump。若启用 minidump，必须验证不包含 OCR buffer/文本，并在上传前取得明确同意。
- 面向客服的“导出诊断”先生成清单预览，继续执行前二次确认，始终排除文本和图像。

## 10. 供应链与发布

- Electron、Node/NPM、C++ runtime、installer toolchain 和实际重新分发的全部组件均锁定版本并生成
  SBOM/许可证清单。当前系统 `Windows.Media.Ocr`/language pack 记为 OS dependency，不虚构 Paddle、
  OpenCV 或应用模型；未来实际引入时再纳入。
- 安装包与项目自有 Main/Host/DLL 使用同一发布身份签名；第三方二进制保留上游签名并由 SBOM/hash
  manifest 约束。启动 Host 前核对预期路径，发布/更新时核对 hash/签名。
- 若启用自动更新，只走 HTTPS 和签名 manifest；更新必须原子替换协议配套组件，失败时可安全回滚。
  若 Phase 5 只交付手动更新 RC，则不得暴露未验收的自动更新入口。
- CI 执行依赖审计、secret scan、Schema contract test、Native 静态分析和打包后签名验证。

## 11. 发布前隐私验收

- 用测试密码控件证明命中后没有 DXGI 调用和 `selection/result`。
- 搜索日志、数据库、临时目录、crash artifact，确认没有截图、原文或 secret。
- 抓取网络请求，确认在线 Provider 只收到允许字段，Native/Renderer 无翻译网络流量。
- 对 Phase 4/5 未实现的历史、收藏和缓存执行 `N/A + 预留表零写入 + 数据库/WAL canary` 证明；未来
  实现后再增加关闭、期限、清空、收藏删除与缓存/WAL 回收测试。
- 测试 Pipe 越权 client、PID/nonce 错误、畸形帧、超长 UIA/OCR 文本。
- 检查安装包中无生产 secret；当前 Windows OCR 路线必须证明未夹带应用 OCR 模型。若未来分发模型，
  再验证 model/runtime hash、来源、最低 CPU、许可证和 SBOM 完整性。
