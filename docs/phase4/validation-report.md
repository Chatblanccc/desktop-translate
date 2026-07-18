# Phase 4 验证报告

> 本报告只记录已经取得的可复现证据。`PENDING`、`NOT RUN` 和未签字项目均不得解释为通过。

## 0. 报告状态

| 项目 | 值 |
|---|---|
| 当前状态 | `LOCAL AUTOMATION PASS / RELEASE BLOCKED` |
| 目标版本 | `0.4.0-phase4` |
| 开发基线 | `1fe45d3c5959b1e45170df21e790d61b69f3f38b` |
| 被测代码 | `codex/phase4-online-translation` 未提交工作区；最终提交 SHA `PENDING` |
| 验证日期 | `2026-07-18` |
| 执行方式 | Windows 本地自动化 + 用户真实鼠标 Chrome/Notepad smoke + Main-only 脱敏传输审计 + Notepad UIA 诊断探针 |
| 最终结论 | `NOT ACCEPTED` |

阻断最终验收的项目：真实错误凭据/撤销凭据/断网与超时恢复场景、目标提交远程 Windows CI/artifact/
fork 边界、剩余 DPI/多屏/兼容性矩阵、风险处置以及四方验收签字。

## 1. 已知环境与未覆盖环境

| 项目 | 值 |
|---|---|
| 操作系统 | Windows 11 Home x64 build `26200`，本地 workspace |
| Node.js / pnpm | Node `24.15.0`；Corepack pnpm `10.32.1`（Codex PATH pnpm `11.9.0`） |
| Electron | `43.1.1` |
| Native Host | 本地 configure/build/CTest 已通过；CTest `2/2` |
| 显示环境 | 单屏 `1440×960`、工作区 `1440×912`、`150%` / 144 DPI、底部任务栏；其余矩阵 `PENDING` |
| GPU、OCR 语言包 | 尚未形成完整人工验收清单，`PENDING` |
| 网络 | fake Main transport、真实 Chrome/Notepad 翻译、单请求固定探针 attestation 与 OS TCP 元数据均已验证 |
| 百度测试凭据 | 已由用户在应用内本地配置；报告未读取或记录任何 APP ID、密钥或签名 |

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
| Desktop unit/component/integration | PASS | Vitest `25` files / `198` tests；SettingsApp 定向 `11/11`，包含在该总数中 |
| Core package tests | PASS | application `13`、contracts `39`、storage `15`、translation `22` |
| `pnpm test:coverage` | PASS | workspace 串行 coverage；核心 packages 使用 Node 原生阈值，Desktop 使用 Vitest 阈值 |
| `pnpm build` | PASS | Main/Preload/Renderer production build 退出码 `0` |
| `pnpm native:configure` / `native:build` / `native:test` | PASS | Native CTest `2/2` |
| `pnpm phase4:smoke` | PASS | fake Provider，零真实网络与零真实 secret |
| Phase 1/2/3 smoke | PASS | 完整 `phase4:verify` 中全部退出码 `0` |
| `pnpm test:e2e` | PASS | 单轮完整 Playwright `6/6`；translated chain 定向 repeat `5/5`；完整套件 repeat `18/18`，repeat 不计为新增用例 |
| `pnpm privacy:scan` | PASS | 最终门禁扫描 `99` production / `86` artifact files；真实 userData canary 复核为 `99` / `120` |
| `git diff --check` | PASS | 当前变更无 whitespace error |
| `pnpm audit --registry=https://registry.npmjs.org` | PASS | AJV 升级至 `8.18.0` 后全量依赖审计为 `No known vulnerabilities found` |
| `pnpm phase4:verify` | PASS | 加入真实传输 attestation、网络观察工具和最终验收文档后的最新完整运行退出码 `0`，耗时 `185.2s`；包含 Native 强制重建、完整 E2E `6/6`、隐私扫描与结束进程残留扫描 |
| 远程 `.github/workflows/phase4-windows.yml` | PENDING | workflow 已编写，尚无目标提交上的远程运行证据 |

Desktop Vitest 覆盖率：

| 指标 | 结果 | 门槛 |
|---|---:|---:|
| Statements | `93.86%` | 全局 `80%`；Main `90%` |
| Branches | `85.59%` | 全局 `75%`；Main `85%` |
| Functions | `94.04%` | 全局 `80%`；Main `90%` |
| Lines | `95.94%` | 全局 `80%`；Main `90%` |

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

2026-07-17 继续审查并修复了四组边界：凭据替换期间读取旧密文、Host shutdown/dispose 期间迟到 selection、
运行期解密失败后重复尝试，以及 Provider 成功响应未绑定请求源文本。最终数据库提交现已串行化并在 mutation 期间拒绝读取；
安全存储加密若挂起，删除仍可用新 generation 抢占，迟到保存不能复活凭据；
停止态在 Supervisor 与 Shell 双层丢弃迟到 selection；运行期凭据失效会在内存中立即禁用并尝试持久化禁用；响应
`trans_result[].src` 按保留换行位置的分段语义整体关联请求。开发启动器同时会查找或构建 Native Host，
完整门禁直接通过 `start-phase4.ps1 -PrepareOnly -ForceNativeBuild` 覆盖该准备链路，并把实际构建出的 Host 路径
传给后续 smoke。AJV 已升级到修复 ReDoS 公告的 `8.18.0`，依赖审计无已知漏洞；该检查点代码完整
`phase4:verify` 耗时 `122.8s`、退出码 `0`。

2026-07-18 继续修复了四个收尾问题：复用卡片丢失 TopMost 状态时，每次展示重新执行
`showInactive → moveTop → setAlwaysOnTop('floating')` 且不抢焦点；Native 构建脚本可发现实际
`.tools/cmake-portable-*` 并校验 CMake `>=3.24`；Windows 高负载下 Electron 仍坚持 graceful close，
但 E2E 等待预算由 10 秒调整为 30 秒；selection 受控复选框增加与 translation toggle 一致的 optimistic
状态及失败回滚，避免旧 Main snapshot 瞬时回画。translated chain 定向 repeat `5/5`、完整套件 repeat
`18/18` 后，完整 `phase4:verify` 耗时 `96.9s`、退出码 `0`。真实传输审计随后新增 7 个 Desktop tests
和 1 个 Translation test；最新定向总数为 Desktop `25/198`、Translation `22`。加入 attestation、
Windows 网络观察工具和本轮验收文档后的最终完整 `phase4:verify` 再次以 `185.2s`、退出码 `0` 通过。

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
| Provider 响应源文本关联 | PASS | 整体 `src` 回显绑定；伪造、遗漏、重复、重排、换行移位与空源译文注入均拒绝；CRLF/LF 和 NFC 等价通过 |
| latest-wins、迟到 success/failure、手动重试和双击重试 | PASS | translation session/controller tests |
| disable/delete/pause/unhealthy/restarting/fatal/display/dispose 取消 | PASS | ShellController active-request Abort 矩阵 |
| 凭据替换与退出竞态 | PASS | mutation 期间旧凭据不可读；挂起保存不阻塞删除；Host/Shell 停止态不处理迟到 selection |

这些证据验证的是确定性的 fake transport 和本地实现；真实百度固定探针已另由同请求 attestation 与
Windows TCP 元数据补证。由于 TLS 加密且证据禁止保留正文/凭据，未保存原始 body 或 pcap。

## 5. Electron E2E 证据

当前完整 Playwright 单轮运行 `6/6`；同一完整套件 repeat `18/18`，translated chain 定向 repeat
`5/5`。repeat 是稳定性证据，不增加独立用例数：

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
| Settings opt-in/凭据/语言/连接测试 | PASS（component） | SettingsApp 定向 `11/11`；包含在 Desktop `198` tests 中 |
| 卡片可见性与焦点 | PASS（当前本机样本） | Z-order 自动化覆盖；Chrome 与 Notepad 真实鼠标复测可见且翻译正常 |
| rapid selection、迟到结果、取消矩阵 | PASS（integration） | 有可复现 Vitest 证据；未为每一项复制 Electron 用例 |
| 恶意 HTML/URL 纯文本与长文滚动 | PASS（component） | React DOM/CSS 自动化；未做真实 Provider 富文本输入 |
| 100/125/150/200% DPI、任务栏四边、物理多屏 | PARTIAL / PENDING | 本机仅覆盖 Win11 build 26200、单屏 1440×960、150%、底部任务栏；其余矩阵未完成 |

## 6. 凭据、数据与隐私证据

| 检查 | 结果 | 证据与限制 |
|---|---|---|
| `safeStorage` 密文、损坏/不可用 fail closed、密钥轮换 | PASS | credential-store unit/integration tests；运行期失效立即禁用并阻止重复尝试 |
| E2E SQLite/WAL 中不出现测试凭据明文 | PASS | 跨重启 E2E 对 UTF-8/UTF-16LE 字节检查；损坏密文重启保持 unavailable 且零出站 |
| unavailable 凭据恢复 | PASS | UI 允许删除/重配；删除损坏密文后再次重启为 missing，定向 repeat `3/3` |
| 迟到 load/key-rotation 隔离 | PASS | generation + 写提交队列 + SQLite 原值 CAS；挂起保存可被删除抢占；删除不复活、新保存不覆盖、队列失败可恢复 |
| history/favorites/cache 零写入 | PASS | SQLite integration canary：三表 `0` 行，数据库字节无原文/译文 canary |
| production source、bundle 与现有 artifact 字节扫描 | PASS | `pnpm privacy:scan`；真实 Notepad canary 复核为 `99` production / `120` artifact files |
| Renderer CSP 与批准 endpoint | PASS | scan 固定验证 `connect-src 'none'` 与 HTTPS endpoint |
| 真实 userData、Temp、crash/WER 复核 | PASS（本轮窗口） | 应用退出后扫描真实 userData、workspace artifacts 与存在的 `desktop-translate-*` Temp roots；公开原文/译文 UTF-8/UTF-16LE 均无命中，当天匹配 CrashDump 与 Application Error/WER 事件为 `0` |
| 真实请求脱敏传输审计 | PASS（fixed public probe） | 同一真实 `FetchBaiduTransport` 前置 attestation 仅记录派生元数据；OS TCP 观察关联同一 Main PID、百度 DNS 与 443，Renderer/Native Host 零 Provider 连接 |

扫描与 attestation 证据不得包含 canary 值、APP ID、密钥、salt、签名、正文、响应或 body；本报告也不
记录这些值。原始 TLS body/pcap 不保存，证据由同请求字段 attestation 与 OS 连接元数据组合而成。

## 7. 真实百度 Provider 与脱敏传输审计

| 场景 | 结果 | 原因/所需证据 |
|---|---|---|
| 真实凭据固定探针连接测试 | PASS（2026-07-18） | Settings 显示“凭据已配置 · 连接测试成功”；全新审计实例恰好记录 `1` 次非选区固定公开探针 |
| Notepad `selection → loading → translated` | PASS（2026-07-18） | Notepad `11.2605.34.0` 用户真实鼠标选中公开文本 `桌面翻译测试`；结果卡显示 “Desktop Translation Test”、`EN` 与“百度翻译”，截图保存在本地忽略目录 `artifacts/phase4/real-provider-20260718T124321415/manual-notepad-en.png` |
| Chrome `selection → loading → translated` | PASS（2026-07-18） | Chrome `150.0.7871.101` 用户真实鼠标选中公开固定文本 `Example Domain`；结果卡显示“示例域名”、`ZH-CN` 与“百度翻译”，Z-order 修复后再次复测可见 |
| `auto → zh-CN` | PASS（2026-07-18） | 上述 Chrome 真实服务结果与归属正确 |
| 非中文目标语言 | PASS（2026-07-18） | 上述 Notepad `auto → en` 真实服务结果、`EN` 标识与 Provider 归属正确 |
| 错误/撤销凭据、断网/超时与恢复 | PENDING | 需要人工网络场景记录 |
| allowlist 与最小字段脱敏审计 | PASS（2026-07-18） | `1` 次 POST 到 exact HTTPS endpoint；字段恰为 `appid/from/q/salt/sign/to`，无 forbidden field、无密钥字面量；同一 Main PID 命中百度 DNS/443，Renderer/Native Host 为 `0` |
| 真实 userData/Temp/crash/WER canary | PASS（2026-07-18） | 应用退出后公开 Notepad 原文/译文在真实 userData、现有 Temp roots 与 artifacts 中无字节命中；匹配 crash/WER 计数为 `0` |
| 官方 endpoint、语言、限制、条款和隐私链接复核 | PASS（2026-07-16） | 实际渲染复核[通用文本翻译文档](https://fanyi-api.baidu.com/doc/23)、[服务协议](https://fanyi-api.baidu.com/doc/6)与[隐私政策](https://fanyi-app.baidu.com/static/agreement/privacy.html) |

2026-07-16 官方资料复核确认：HTTPS endpoint 为
`https://fanyi-api.baidu.com/api/trans/vip/translate`，请求为 POST form、UTF-8；签名为
`MD5(appid + q + salt + secret)`，其中 `q` 在参与签名前不做 URL encode；FAQ 限制为 6000 bytes；
`auto/zh/en/jp/kor` 映射存在，错误码覆盖与实现一致。服务协议明确客户端不得缓存百度翻译数据，当前
实现没有翻译缓存或历史。隐私政策页面可访问，标示更新/生效日期为 2023-10-09。

Chrome `auto → zh-CN`、Notepad `auto → en`、真实固定探针和脱敏传输审计均已取得证据。真实错误凭据、
撤销凭据、断网/超时与恢复仍为 `PENDING`；fake Provider 的完整错误矩阵不冒充这些人工场景。

## 8. 回归、CI 与产物

| 项目 | 结果 | 说明 |
|---|---|---|
| Phase 1/2/3 单元、smoke 与 Electron 回归 | PASS | 完整 `phase4:verify` 退出码 `0` |
| Native configure/build/CTest | PASS | `2/2` |
| Phase 3 二进制读取当前数据库 | PASS（2026-07-18） | 已验收提交 `1fe45d3c...` 的 `0.3.0-phase3` 在一致性数据库副本上启动、读取旧设置并完成 source-only fake selection；零 HTTP(S)，副本与真实数据库哈希均未变化 |
| 门禁后 Electron/Node/selection-host 残留扫描 | PASS | 2026-07-18 最新 `185.2s` 完整 `phase4:verify` 的 workspace residual scan 通过；真实审计实例结束后也为 `0` |
| 远程 Windows CI | PENDING | 尚未提交/推送，无法提供远程 run URL |
| CI artifact 上传与保留策略 | PENDING | 等待远程 workflow 实际运行 |
| fork/PR 不注入真实 Provider secret | PENDING（remote evidence） | workflow 设计不使用真实 secret；尚无远程运行证据 |

## 9. 回滚证据

| 检查 | 结果 | 证据 |
|---|---|---|
| 关闭在线翻译立即取消并恢复 source-only | PASS（automated） | Controller/Shell cancellation 与 source-only tests |
| 删除凭据立即 fail closed、后续零出站 | PASS（automated） | Shell tests + 跨重启 E2E fetch trace |
| Provider 故障不破坏 Native lifecycle | PASS（automated） | ShellController host/provider 隔离 tests |
| Phase 3 二进制降级读取 | PASS（isolated copy） | `node:sqlite backup()` 副本上旧 Electron 启动/读取/退出通过；Phase 4 键、1 条加密 secret、三张预留表与数据库字节前后不变；真实 DB 未由旧进程打开 |

## 10. 最终结论与签字

结论：`NOT ACCEPTED`。

本地自动化总门禁、Chrome/Notepad 真实百度成功路径、非中文目标、脱敏传输审计、真实 userData 隐私复核
与 Phase 3 降级读取均已通过。仍阻断提交后最终验收声明的项目是：真实错误凭据/撤销凭据/断网与超时恢复、
目标提交远程 CI/artifact/fork 边界、剩余 DPI/多屏/兼容性矩阵、剩余风险处置和签字。

Phase 3 降级实测使用系统 Temp 下的隔离 `git archive` 和数据库副本。锁文件离线冷安装因本地 store
缺少一个 tarball 而安全失败（`downloaded 0`），随后仅链接本机与历史版本一致的 Vite `8.1.4`、
React `19.2.7`、Playwright `1.61.1` 和 Electron `43.1.1` 完成构建；该边界不影响旧代码读取当前
数据库的兼容性结论，但完全独立冷安装仍可由远程 CI 另行补证。

| 角色 | 姓名/标识 | 结论 | 日期 |
|---|---|---|---|
| Product | `PENDING` | `NOT SIGNED` | `PENDING` |
| Engineering | `PENDING` | `NOT SIGNED` | `PENDING` |
| Security/Privacy | `PENDING` | `NOT SIGNED` | `PENDING` |
| Quality/Release | `PENDING` | `NOT SIGNED` | `PENDING` |
