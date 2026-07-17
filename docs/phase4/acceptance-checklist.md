# Phase 4 工程与实机验收清单

- 当前状态：`LOCAL AUTOMATION PASS / RELEASE BLOCKED`
- 目标版本：`0.4.0-phase4`
- 开发基线：`1fe45d3c5959b1e45170df21e790d61b69f3f38b`
- 详细证据：[Phase 4 验证报告](validation-report.md)
- 风险跟踪：[Phase 4 风险登记](risk-register.md)

只有当前工作区中已有可复现自动化或实机证据的项目才标记 `[x]`。`PENDING` 项不得用 fake Provider、
源码审计或本地单元测试替代真实账号、人工抓包、远程 CI 或签字。

## A. 基线、版本与范围

- [x] Phase 4 从指定 Phase 3 验收提交开发，继承风险未被隐式关闭。
- [x] workspace、Desktop 与核心 packages 版本统一为 `0.4.0-phase4`。
- [x] README、文档索引、产品规格与实现范围明确只有 `baidu` 一个 Provider。
- [x] 未内置公共生产凭据，也没有自动切换供应商。
- [x] 未实现历史、收藏、持久缓存、词典、发音、例句或云 OCR。
- [x] 未新增 migration；自动化证明 `translation_history`、`favorites`、`translation_cache` 为零写入。

## B. 默认关闭、同意与设置

- [x] 新安装/Phase 3 数据库升级默认 `translation.enabled=false`，E2E fetch trace 为零。
- [x] 缺凭据或同意时启用、测试连接和 selection 翻译均 fail closed。
- [x] Settings 显示原文出站告知、BYOK、官方隐私与服务链接。
- [x] Provider 固定为百度；源语言默认 `auto`，目标语言默认 `zh-CN`。
- [x] 语言选项有严格 allowlist，并通过存储与跨重启 E2E 恢复。
- [x] 关闭在线翻译立即 Abort 活动请求，后续 selection 走 source-only。
- [x] 测试连接只发送固定非用户探针并受同意门禁约束。

## C. 凭据生命周期

- [x] Settings 支持保存、全量替换和删除 APP ID/密钥，保存后不回显明文。
- [x] Renderer 只接收 `missing/configured/unavailable`，IPC 没有读取 secret 的接口。
- [x] Ball/Card 凭据写入被拒绝；sender、角色与 payload 均有负向测试。
- [x] `safeStorage` 不可用、超时、加密/解密失败或密文损坏时 fail closed，不明文回退。
- [x] `credentialStatus=unavailable` 时 UI 仍允许删除/重配；Renderer 回归和损坏密文跨重启 E2E repeat `3/3`。
- [x] 密钥轮换、删除与重新配置路径有自动化覆盖。
- [x] 超时的旧 `getStatus`/key-rotation 不能在删除后复活凭据或覆盖新保存；mutation generation、
  SQLite 原值 CAS 及其正/反路径测试均通过；superseded load 在重加密/返回旧凭据前直接失败。
- [x] 替换或删除凭据先取消使用旧凭据的活动请求。
- [x] 跨完整 Electron 重启后凭据状态恢复，数据库/WAL 不含测试凭据明文。

## D. Provider、网络与错误映射

- [x] 翻译 transport 只存在于 Electron Main；Renderer CSP 为 `connect-src 'none'`。
- [x] transport 固定批准的 HTTPS endpoint，拒绝 HTTP、非 exact-host、端口/认证混淆和 redirect。
- [x] outbound body 逐字段证明只含文本、语言与鉴权必要字段。
- [x] 请求不携带截图、窗口/进程、坐标、OCR 置信度或 selection 元数据。
- [x] 8 秒总超时与 256 KiB 响应上限生效，取消后不发布迟到结果。
- [x] 32768 UTF-16 与 6000 UTF-8 bytes 双上限生效且不静默截断。
- [x] 远端不能伪造 request/selection ID、时间、归属或 cache 状态。
- [x] 认证、配额、限流、网络、超时、5xx、非法 JSON/UTF-8、缺字段与超大响应映射稳定。
- [x] 没有后台自动重试；手动重试使用新 `requestId`，双击不会并发重复发送。
- [ ] `PENDING`：真实百度流量的 allowlist 与最小字段仍需人工脱敏抓包确认。

## E. 翻译状态、并发与降级

- [x] `source-only`、`translating`、`translated`、`failed` 使用判别契约和运行时 guard。
- [x] selection 立即显示原文/loading；成功卡显示译文、目标语言与百度归属。
- [x] 失败卡保留原文，Renderer 不接收 Provider body、凭据或调试 cause。
- [x] 新 selection、dismiss、disable、删除/替换凭据、暂停取词、Host unhealthy/restarting/fatal、
  display change 和 dispose 均取消活动请求。
- [x] 迟到 success/failure 不覆盖新卡；rapid selection latest-wins 有自动化覆盖。
- [x] Provider 故障不把 Native selection lifecycle 置为 `faulted`。
- [x] Phase 4 没有进程内或持久翻译 cache，因此不存在跨凭据/语言复用。

## F. UI、IPC 与安全渲染

- [x] Settings 的 opt-in、凭据、状态、语言和连接测试有 component/E2E 覆盖。
- [x] 翻译卡通过 `showInactive()` 路径展示，不抢目标应用焦点。
- [x] 恶意 HTML、script、事件属性与 URL 按纯文本渲染且不会生成可导航元素。
- [x] 长文正文区域可聚焦滚动，source-only 与 translated 布局有自动化覆盖。
- [x] Ball、Settings、Card 保持 sandbox/context isolation/no node integration。
- [x] Preload 只暴露白名单方法，不暴露原始 `ipcRenderer` 或通用 send/invoke。
- [ ] `PENDING`：100/125/150/200% DPI、任务栏四边、旋转和物理多屏人工矩阵未完成。

## G. fake Provider 自动化

- [x] 成功、自动源语言、en/ja/ko 目标映射与 Provider 归属通过。
- [x] 缺/错凭据、配额、限流、断网、超时、5xx 与不可重试错误通过。
- [x] 取消、迟到 success/failure、双击重试与 rapid-selection latest-wins 通过。
- [x] allowlist/redirect、非法 UTF-8/JSON、缺字段、超长与 256 KiB 超限通过。
- [x] outbound request 逐字段断言没有多余上下文。
- [x] `pnpm phase4:smoke` 使用 fake Provider，退出码 `0`，不使用真实网络或 secret。

## H. 本地自动门禁与回归

- [x] `pnpm lint` 通过。
- [x] workspace `pnpm typecheck` 通过，`5/5` 项目。
- [x] Desktop Vitest `24` files / `182` tests 通过；application `13`、contracts `39`、storage `15`、
  translation `19` tests 通过。
- [x] workspace coverage 通过；最新 Desktop 定向结果为 Statements `94.38%`、Branches `86.57%`、
  Functions `94.33%`、Lines `96.30%`，核心 packages 的 Node coverage 阈值也通过。
- [x] production build 与 Native configure/build/CTest 通过，CTest `2/2`。
- [x] Phase 1/2/3 smoke 在完整门禁中全部通过。
- [x] `pnpm test:e2e` 已完成本地 `6/6`；损坏密文恢复 repeat `3/3`，竞态修复后 repeat `5/5`。
- [x] `pnpm privacy:scan` 退出码 `0`。
- [x] `git diff --check` 通过。
- [x] 第一次 `phase4:verify` 的 E2E 复选框竞态已修复；第二次完整运行 `98.8s` 通过；迟到凭据
  写回 P1 修复后第三次完整运行 `95.4s` 通过；generation 提前失效加固后的最终代码再次完整运行
  `97.8s`、退出码 `0`。
- [x] 完整门禁结束后的 workspace process residual scan 通过。
- [ ] `PENDING`：`.github/workflows/phase4-windows.yml` 尚无目标提交上的远程运行链接。

## I. 真实 Provider 与人工验收（全部阻断）

- [ ] `PENDING`：使用专门百度测试账号完成 Notepad `selection → loading → translated`。
- [ ] `PENDING`：使用专门百度测试账号完成 Chrome `selection → loading → translated`。
- [ ] `PENDING`：真实 `auto → zh-CN` 与至少一个非中文目标语言结果及归属正确。
- [ ] `PENDING`：真实错误凭据、撤销凭据、断网/超时和恢复场景。
- [ ] `PENDING`：人工脱敏抓包证明只访问 allowlist 且只发送允许字段。
- [x] 2026-07-16 实际渲染复核百度 `/doc/23`：endpoint、POST form、UTF-8、签名顺序、6000 bytes、
  `auto/zh/en/jp/kor` 与错误码均和实现范围一致；`/doc/6` 服务协议及隐私页可访问。
- [ ] `PENDING`：全机器日志、crash dump 与临时目录人工隐私复核。

## J. 回滚、CI、报告与签字

- [x] 自动化证明关闭在线翻译无需数据库回滚即可恢复 source-only。
- [x] 自动化证明删除凭据后 fail closed，Provider 故障不破坏 Native lifecycle。
- [ ] `PENDING`：Phase 3 二进制读取当前数据库的降级实测。
- [ ] `PENDING`：远程 Windows CI、artifact 上传与 fork secret 边界的运行证据。
- [ ] `PENDING`：人工 DPI/多屏验收记录。
- [ ] `PENDING`：Windows 10/11、管理员/受保护桌面及代表性真实应用兼容性矩阵。
- [ ] `PENDING`：风险接受项的 Owner/复审日期与最终处置签字。
- [ ] `PENDING`：Product、Engineering、Security/Privacy、Quality/Release 四方验收签字。

当前最终结论保持 `NOT ACCEPTED`，不得因本地自动化为绿色而提前改为 `PASS`。
