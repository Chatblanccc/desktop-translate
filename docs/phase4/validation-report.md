# Phase 4 验证报告

> 本报告只记录已经取得的可复现证据。`PENDING`、`NOT RUN` 和未签字项目均不得解释为通过。

## 0. 报告状态

| 项目 | 值 |
|---|---|
| 当前状态 | `LOCAL AUTOMATION PASS / RELEASE BLOCKED` |
| 目标版本 | `0.4.0-phase4` |
| 开发基线 | `1fe45d3c5959b1e45170df21e790d61b69f3f38b` |
| 被测代码 | `codex/phase4-online-translation` 未提交工作区；最终提交 SHA `PENDING` |
| 验证日期 | `2026-07-17` |
| 执行方式 | Windows 本地 Codex 自动化 |
| 最终结论 | `NOT ACCEPTED` |

阻断最终验收的项目：真实百度测试账号 smoke、人工脱敏抓包、远程 Windows CI、Phase 3 二进制
降级实测、人工 DPI/多屏/兼容性矩阵以及四方验收签字。

## 1. 已知环境与未覆盖环境

| 项目 | 值 |
|---|---|
| 操作系统 | Windows，本地 workspace |
| Node.js / pnpm | Node `24.14.0`；pnpm `10.32.1` |
| Electron | `43.1.1` |
| Native Host | 本地 configure/build/CTest 已通过；CTest `2/2` |
| 显示器、GPU、OCR 语言包 | 未形成人工验收矩阵，`PENDING` |
| 网络 | fake Main transport 已验证；真实百度网络未运行 |
| 百度测试账号 | 未提供，`PENDING`；报告未记录任何账号或密钥 |

## 2. 变更范围审计

- Provider：新增唯一 `baidu` adapter、固定 HTTPS endpoint、exact-host allowlist、8 秒总截止时间、
  256 KiB 响应上限和稳定错误映射。
- 凭据：Main-only `ProviderCredentialStore`，Electron `safeStorage` 加密后复用 `secrets` 表；Renderer 仅见状态。
- 编排：判别式卡片状态、latest-wins、手动重试、新旧请求隔离以及集中取消。
- UI/IPC：Settings opt-in/BYOK/语言/凭据管理；Card 四状态；显式角色化 IPC 与 Preload 白名单。
- 数据：没有新增 migration；Phase 4 不调用 history、favorites 或 persistent cache repository。
- 明确未实现：第二 Provider、自动重试、历史、收藏、持久缓存、词典、发音、例句和云 OCR。

## 3. 本地自动门禁证据

以下分项及完整超集门禁均在当前工作区取得退出码 `0`。

| 命令/门禁 | 结果 | 可复现证据 |
|---|---|---|
| `pnpm lint` | PASS | `oxlint . --deny-warnings` |
| `pnpm typecheck` | PASS | workspace `5/5` 项目通过 |
| Desktop unit/component/integration | PASS | Vitest `24` files / `182` tests |
| Core package tests | PASS | application `13`、contracts `39`、storage `15`、translation `19` |
| `pnpm test:coverage` | PASS | workspace 串行 coverage；核心 packages 使用 Node 原生阈值，Desktop 使用 Vitest 阈值 |
| `pnpm build` | PASS | Main/Preload/Renderer production build 退出码 `0` |
| `pnpm native:configure` / `native:build` / `native:test` | PASS | Native CTest `2/2` |
| `pnpm phase4:smoke` | PASS | fake Provider，零真实网络与零真实 secret |
| Phase 1/2/3 smoke | PASS | 完整 `phase4:verify` 中全部退出码 `0` |
| `pnpm test:e2e` | PASS | Playwright `6/6`；新增损坏密文恢复路径定向 repeat `3/3`，复选框竞态修复后 repeat `5/5` |
| `pnpm privacy:scan` | PASS | `98` 个 production files 与 `76` 个 artifact files 按字节扫描 |
| `git diff --check` | PASS | 当前变更无 whitespace error |
| `pnpm phase4:verify` | PASS | 最终代码最新完整运行退出码 `0`，耗时 `97.8s`；包含结束进程残留扫描 |
| 远程 `.github/workflows/phase4-windows.yml` | PENDING | workflow 已编写，尚无目标提交上的远程运行证据 |

Desktop Vitest 覆盖率：

| 指标 | 结果 | 门槛 |
|---|---:|---:|
| Statements | `94.38%` | 全局 `80%`；Main `90%` |
| Branches | `86.57%` | 全局 `75%`；Main `85%` |
| Functions | `94.33%` | 全局 `80%`；Main `90%` |
| Lines | `96.30%` | 全局 `80%`；Main `90%` |

application、contracts、storage、translation 的 Node 原生 coverage 门禁为 lines/functions `80%`、branches
`75%`，分包运行均已通过。没有以调低阈值或把 `phase4-smoke.ts` 计入覆盖率的方式制造绿色结果。

已保留首次整链失败：第一次 `phase4:verify` 在 E2E 凭据保存后的受控复选框状态同步处出现竞态，不能记为
整链通过。实现修复后该用例 repeat `5/5`，随后第二次完整 `phase4:verify` 在 `98.8s` 内退出码 `0`。
独立审查还发现 `credentialStatus=unavailable` 时 UI 无法删除/重配凭据的 P1；现已允许恢复操作，并由
Renderer 回归以及“损坏密文 → 重启 unavailable/零出站 → 删除 → 再重启 missing”E2E repeat `3/3` 验证。
后续独立复核又发现超时的旧 `getStatus`/key-rotation 可能在删除或新保存后迟到写回的 P1；现以
mutation generation 使旧异步读取失效，并以 SQLite 原值 compare-and-swap 限制轮换写回。删除后不复活、
新保存不被覆盖、CAS 正/反路径均有自动化测试；修复后第三次完整 `phase4:verify` 在 `95.4s` 内再次
退出码 `0`。最终加固把 generation 失效检查前移：superseded load 会在执行重加密或向调用方返回旧凭据
之前直接失败；最终代码再次完整 `phase4:verify`，耗时 `97.8s`、退出码 `0`。

## 4. fake Provider、契约和编排证据

| 场景 | 结果 | 自动化证据 |
|---|---|---|
| 成功、`auto → zh-CN`、en/ja/ko 映射和 Provider 归属 | PASS | `tests/translation/baidu-provider.test.ts`、`phase4:smoke` |
| 默认关闭、未同意、缺凭据与 safeStorage 不可用 | PASS | Shell/State/Provider credential tests；E2E 零 fetch trace |
| 认证、配额、限流、断网、HTTP 5xx 与不可重试错误 | PASS | Baidu adapter 错误矩阵 |
| 8 秒总超时，包括凭据仍在解析 | PASS | Provider 与 TranslationController fake-timer tests |
| 256 KiB、分块超限、非法 UTF-8/JSON、缺字段 | PASS | transport bounded-stream 与 malformed-response tests |
| 32768 UTF-16 / 6000 UTF-8 bytes 边界 | PASS | runtime contract 与 adapter 边界测试；不静默截断 |
| exact-host allowlist、HTTP/端口/认证信息/redirect 拒绝 | PASS | transport 负向矩阵 |
| 最小请求字段 | PASS | outbound body 逐字段断言；不含窗口、进程、坐标和 selection 元数据 |
| latest-wins、迟到 success/failure、手动重试和双击重试 | PASS | translation session/controller tests |
| disable/delete/pause/unhealthy/restarting/fatal/display/dispose 取消 | PASS | ShellController active-request Abort 矩阵 |

这些证据验证的是确定性的 fake transport 和本地实现，不替代真实百度账号或人工抓包。

## 5. Electron E2E 证据

当前完整 Playwright 本地运行 `6/6`：

1. Phase 2 Shell 在无 Native Host 时可用并跨重启保留 UI 设置；
2. degraded OCR fixture 不影响 UIA listening；
3. Native selection 打开 sandboxed source-only 卡且 Main fetch trace 为空；
4. 缺凭据/同意时翻译 fail closed，保存凭据后状态不可逆读取；
5. 设置和加密凭据跨完整重启恢复，删除后保持 fail closed；
6. fake allowlisted Main transport 完成 `selection → translating → translated` 链路。

| 验收面 | 结果 | 边界 |
|---|---|---|
| 默认关闭、opt-in、凭据保存/重启/删除 | PASS | fake transport，非真实百度账号 |
| source-only、translating、translated | PASS | failed 卡由 component/integration 自动化覆盖，未单独做真实网络 E2E |
| sandbox、Preload 白名单、Renderer 零网络 | PASS | Electron E2E + CSP 检查 |
| rapid selection、迟到结果、取消矩阵 | PASS（integration） | 有可复现 Vitest 证据；未为每一项复制 Electron 用例 |
| 恶意 HTML/URL 纯文本与长文滚动 | PASS（component） | React DOM/CSS 自动化；未做真实 Provider 富文本输入 |
| 100/125/150/200% DPI、任务栏四边、物理多屏 | PENDING | 几何 fixture 已通过，但人工硬件矩阵未完成 |

## 6. 凭据、数据与隐私证据

| 检查 | 结果 | 证据与限制 |
|---|---|---|
| `safeStorage` 密文、损坏/不可用 fail closed、密钥轮换 | PASS | credential-store unit/integration tests |
| E2E SQLite/WAL 中不出现测试凭据明文 | PASS | 跨重启 E2E 对 UTF-8/UTF-16LE 字节检查；损坏密文重启保持 unavailable 且零出站 |
| unavailable 凭据恢复 | PASS | UI 允许删除/重配；删除损坏密文后再次重启为 missing，定向 repeat `3/3` |
| 迟到 load/key-rotation 隔离 | PASS | mutation generation + SQLite 原值 CAS；superseded load 在重加密/返回旧凭据前失败；删除不复活、新保存不覆盖、CAS 正/反测试 |
| history/favorites/cache 零写入 | PASS | SQLite integration canary：三表 `0` 行，数据库字节无原文/译文 canary |
| production source、bundle 与现有 artifact 字节扫描 | PASS | `pnpm privacy:scan` |
| Renderer CSP 与批准 endpoint | PASS | scan 固定验证 `connect-src 'none'` 与 HTTPS endpoint |
| 全机器日志、crash dump、临时目录人工复核 | PENDING | 自动扫描只覆盖配置的 workspace/artifact roots |
| 真实请求/响应抓包 | PENDING | 未使用真实百度账号；不得以 fake request 断言替代 |

扫描证据不得包含 canary、APP ID、密钥、签名、正文或 body；本报告也不记录这些值。

## 7. 真实百度 Provider 与人工抓包

| 场景 | 结果 | 原因/所需证据 |
|---|---|---|
| Notepad `selection → loading → translated` | PENDING | 需要专门百度测试账号和无敏感固定文本 |
| Chrome `selection → loading → translated` | PENDING | 同上 |
| `auto → zh-CN` 和非中文目标语言 | PENDING | 需要真实服务结果与正确归属 |
| 错误/撤销凭据、断网/超时与恢复 | PENDING | 需要人工网络场景记录 |
| allowlist 与最小字段脱敏抓包 | PENDING | 必须人工复核且证据不得含正文、账号、密钥、签名或 body |
| 官方 endpoint、语言、限制、条款和隐私链接复核 | PASS（2026-07-16） | 实际渲染复核[通用文本翻译文档](https://fanyi-api.baidu.com/doc/23)、[服务协议](https://fanyi-api.baidu.com/doc/6)与[隐私政策](https://fanyi-app.baidu.com/static/agreement/privacy.html) |

2026-07-16 官方资料复核确认：HTTPS endpoint 为
`https://fanyi-api.baidu.com/api/trans/vip/translate`，请求为 POST form、UTF-8；签名为
`MD5(appid + q + salt + secret)`，其中 `q` 在参与签名前不做 URL encode；FAQ 限制为 6000 bytes；
`auto/zh/en/jp/kor` 映射存在，错误码覆盖与实现一致。服务协议明确客户端不得缓存百度翻译数据，当前
实现没有翻译缓存或历史。隐私政策页面可访问，标示更新/生效日期为 2023-10-09。

本节全部为阻断项。fake Provider、源码审计和自动化 allowlist 测试均不是人工抓包的等价替代。

## 8. 回归、CI 与产物

| 项目 | 结果 | 说明 |
|---|---|---|
| Phase 1/2/3 单元、smoke 与 Electron 回归 | PASS | 完整 `phase4:verify` 退出码 `0` |
| Native configure/build/CTest | PASS | `2/2` |
| Phase 3 二进制读取当前数据库 | PENDING | 没有新增 migration，但尚无旧二进制实测证据 |
| 门禁后 Electron/Node/selection-host 残留扫描 | PASS | 最终代码 `97.8s` 完整 `phase4:verify` 的 workspace residual scan 通过 |
| 远程 Windows CI | PENDING | 尚未提交/推送，无法提供远程 run URL |
| CI artifact 上传与保留策略 | PENDING | 等待远程 workflow 实际运行 |
| fork/PR 不注入真实 Provider secret | PENDING（remote evidence） | workflow 设计不使用真实 secret；尚无远程运行证据 |

## 9. 回滚证据

| 检查 | 结果 | 证据 |
|---|---|---|
| 关闭在线翻译立即取消并恢复 source-only | PASS（automated） | Controller/Shell cancellation 与 source-only tests |
| 删除凭据立即 fail closed、后续零出站 | PASS（automated） | Shell tests + 跨重启 E2E fetch trace |
| Provider 故障不破坏 Native lifecycle | PASS（automated） | ShellController host/provider 隔离 tests |
| Phase 3 二进制降级读取 | PENDING | 需要旧二进制实测 |

## 10. 最终结论与签字

结论：`NOT ACCEPTED`。

本地自动化总门禁已通过，但下列项目仍阻断提交后的最终验收声明：真实百度账号 smoke、人工脱敏
抓包、远程 CI、Phase 3 二进制降级实测、人工 DPI/多屏/兼容性矩阵和签字。

| 角色 | 姓名/标识 | 结论 | 日期 |
|---|---|---|---|
| Product | `PENDING` | `NOT SIGNED` | `PENDING` |
| Engineering | `PENDING` | `NOT SIGNED` | `PENDING` |
| Security/Privacy | `PENDING` | `NOT SIGNED` | `PENDING` |
| Quality/Release | `PENDING` | `NOT SIGNED` | `PENDING` |
