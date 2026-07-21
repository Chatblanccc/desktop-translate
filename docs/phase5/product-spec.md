# Phase 5 产品规格：可发布候选版本

- 状态：`IN DEVELOPMENT`
- 启动日期：2026-07-18
- 代码基线：Phase 4 验收 SHA `4ea65dcd5c5ef7c56127fe419127d48e0573a65d`
- 目标版本：`0.5.0-phase5`
- 交付口径：Windows 11 x64 签名 Release Candidate；不自动等同公开 V1

## 1. 阶段目标

Phase 5 不扩展翻译产品功能。它把 Phase 4 已验收的 UIA/OCR 取词、source-only 与 BYOK 在线翻译闭环，
提升为可测量、可长时间运行、可安装、可审计、可回滚并可由发布角色签字的候选版本。

完成后的用户路径必须是：从受信渠道取得 installer，校验发布者后以标准用户安装，首次启动默认不联网，
用户可以继续使用 source-only；只有完成 Phase 4 的明确同意和 BYOK 配置后才会联网翻译。

## 2. 冻结决策 D1–D9

| ID | 冻结决定 | 验收含义 |
|---|---|---|
| D1 | Phase 5 交付签名 RC；是否公开为 V1 另开发布评审 | 无签名证书时只能是 `RELEASE BLOCKED`，不得把 unsigned artifact 称为 RC |
| D2 | 继续使用系统 `Windows.Media.Ocr`；不携带 Paddle/OpenCV/model | 缺少系统 OCR language pack 时稳定降级，UIA/source-only 仍可用 |
| D3 | Windows x64、per-user、无需管理员权限的 NSIS installer | 不安装服务/驱动，不请求 `uiAccess`，Host 保持标准权限 |
| D4 | Phase 5 RC 仅提供签名手动更新；自动更新明确不在本阶段 | 应用不显示不可用的更新入口；公开 V1 若需要自动更新必须另建 ADR 和完整矩阵 |
| D5 | 项目自有 PE 与 installer 使用同一 Authenticode 身份；确切 subject 由受保护发布环境注入并精确匹配 | 当前工作区没有证书或已批准 subject，签名门禁保持阻断；PR/fork 永不接触签名 secret |
| D6 | Windows 11 x64 是发布支持基线；Windows 10 22H2 x64 仅 best-effort | 不把已结束常规支持的 Windows 10 表述为安全支持承诺 |
| D7 | 固定登记设备后才作绝对性能结论；当前机器仅作为 B 类候选参考机 | A 低配机、C 物理多屏矩阵未取得证据时不得宣称通过 |
| D8 | 普通卸载默认保留当前用户的 userData，便于修复/重装；应用内“清除全部本地数据”必须先禁用翻译、删除凭据与设置后再退出 | installer 不用静默删除用户数据；清除动作必须显式确认并可验证零残留 |
| D9 | MSVC x64 Release 使用静态 CRT `/MT`；不随包安装 VC Redistributable | Native Host 在 clean VM 不依赖开发机已有 VC Runtime；二进制和 SBOM 必须复核该事实 |

D5 的发布者名称不是可由仓库猜测的产品值。签名 workflow 必须要求受保护配置中的 expected subject，缺失时
fail closed，并在验证报告写明外部依赖；不得为让测试变绿而生成自签名证书冒充发布签名。

## 3. 功能范围

### 3.1 必须交付

1. Phase 1–4 行为保持不变，默认 `translation.enabled=false`；
2. 产品、Desktop、Native VERSIONINFO、installer 与 release manifest 版本映射一致；
3. default-off、脱敏的性能与资源测量通道；
4. 可重复的性能、短稳、8 小时 Lane A 和实机 Lane B 入口；
5. per-user NSIS 安装、覆盖安装、修复、卸载和重装；
6. production ASAR 与固定的 Host/migrations/licenses 资源布局；
7. SBOM、第三方 notices、逐文件 hash、包体与隐私扫描；
8. PR unsigned、固定机器性能/长稳和受保护 tag 签名三类发布门禁；
9. source-only 安全回退与打包/性能回滚说明。

### 3.2 明确不交付

- 自动更新、账号、同步、历史、收藏、持久缓存；
- 第二 Provider、云 OCR、Paddle 模型或公共凭据；
- 管理员权限、服务、驱动、注入、`uiAccess` 或规避系统保护；
- 输入框翻译、剪贴板轮询、模拟 `Ctrl+C`、词典或 AI 功能。

## 4. 安装、更新与卸载体验

### 4.1 安装

- installer 必须展示产品名、版本和 Authenticode 发布者；发布验收不接受 Unknown Publisher；
- 默认安装到当前用户目录，不要求管理员权限；
- 安装完成后首次启动仍默认关闭在线翻译，不产生 Provider 出站；
- 非 ASCII 用户目录、离线环境和缺少 OCR language pack 必须稳定启动或给出明确降级状态。

### 4.2 手动更新

- Phase 5 RC 从受信 HTTPS 发布页下载完整签名 installer；
- 覆盖安装必须把 Main、Host、protocol、migrations 和 resources 作为同一版本单元；
- 读取现有 Phase 4 userData 与首个 Phase 5 beta → RC 分开验证，不能虚构 Phase 4 installer 升级路径；
- 更新失败时保留旧 userData，source-only 路径仍可恢复。

### 4.3 卸载与清除

- 普通卸载移除程序文件但保留 userData；重装后设置与 DPAPI 密文在同一 Windows 用户下可继续读取；
- “清除全部本地数据”是独立、显式确认动作：取消请求、禁用翻译、删除 Provider 凭据、关闭数据库、删除
  应用 userData 与已知临时 metrics，再退出；
- history/favorites/cache 在 Phase 5 仍为零写入；清除验证不能把预留空表描述为已交付功能。

## 5. 性能、长稳与资源

指标、时钟域、样本量、候选阈值、双轨 soak 与制品边界以
[benchmark spec](benchmark-spec.md)为唯一测量解释。共享 GitHub runner 只验证 harness，不作绝对性能结论。

任何性能优化都必须同时满足：

- Phase 4 严格超集回归通过；
- UIA/OCR 正确率不下降；
- latest-wins、取消、退出和 fail-closed 不变；
- 不通过减少文本、绕过 OCR、关闭安全检查或隐藏失败样本来达标。

## 6. 安全、隐私与供应链

- metrics 默认关闭，字段使用 allowlist，不记录正文、译文、凭据、坐标、窗口、PID/HWND 或完整路径；
- production artifact 必须排除 fake Host/Provider、E2E 注入、测试、source map、coverage 和调试截图；
- PR/fork 只能生成 unsigned artifact，真实 Provider 与签名凭据只存在于受保护环境；
- `Windows.Media.Ocr` 是 OS dependency，不伪造成随包模型；
- release manifest 在最终 PE/installer 签名并计算 hash 后生成；普通 checksum 不能替代可信签名根；
- Critical/High 运行时漏洞无未处置项，未知许可证或缺失 notice 阻断发布。

## 7. 发布状态机

| 状态 | 条件 |
|---|---|
| `IN DEVELOPMENT` | 任一 WP 尚未完成或只取得开发证据 |
| `PERFORMANCE ACCEPTED / RELEASE BLOCKED` | 功能、性能、长稳与 unsigned packaging 已过，但签名、clean VM、实机矩阵或发布签字不完整 |
| `PASS WITH ACCEPTED RISKS` | 签名 RC 的所有不可豁免门禁通过，仅剩有 owner/影响/复审日的可接受风险 |
| `PASS` | 所有目标矩阵与签名发布门禁通过且无剩余发布风险 |
| `NOT ACCEPTED` | 敏感泄露、未同意联网、签名/更新完整性失败、stale result、不可恢复数据损坏、crash/hang 或无限重启 |

## 8. 完成定义

Phase 5 以[开发与验收总计划](development-and-acceptance-plan.md)第 14 节和
[验收清单](acceptance-checklist.md)为准。unsigned 包、短时 smoke、fake Provider 或单屏机器证据都不能单独
把阶段标记为 `PASS`。
