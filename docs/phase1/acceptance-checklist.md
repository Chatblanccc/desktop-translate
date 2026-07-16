# Phase 1 工程验收清单

本清单是进入 Phase 2（悬浮球）的工程门禁，只验收项目骨架、进程边界、跨语言契约和 Windows Native 可行性，不把 Phase 3 的真实应用划词兼容、Phase 4 的翻译供应商或 Phase 5 的性能优化提前作为阻塞项。

## A. 范围与架构

- [x] 系统架构、3 个 ADR、IPC、安全隐私、兼容性矩阵和风险登记已落地并互相链接。
- [x] 目标边界固定为 Windows 10/11 x64、标准用户权限；管理员应用、安全桌面、DRM/受保护内容不承诺绕过。
- [x] 方案不读取剪贴板、不模拟 `Ctrl+C`、不注入目标进程。
- [x] Phase 1 未实现悬浮球、翻译卡片、设置页或正式翻译 Provider。

## B. Workspace 与构建

- [x] pnpm workspace、TypeScript strict 配置、Electron Main/Preload 构建和 CMake x64/C++20 工程已建立。
- [x] Node/pnpm/Electron/TypeScript 版本由 `.node-version`、`package.json` 和 `pnpm-lock.yaml` 固定。
- [x] 构建产物、本机工具链、OCR 模型、数据库和本机 secret 配置均已忽略。
- [x] `pnpm phase1:verify` 会检查每个外部命令退出码并执行完整本地门禁。
- [x] Windows CI workflow 已配置为在 MSVC/Windows SDK 环境执行同一门禁。
- [x] 远端 Windows MSVC CI 已通过：[run 29475175846](https://github.com/Chatblanccc/desktop-translate/actions/runs/29475175846)，验证提交 `73762649f95fcefc4e46efc4a5eac28dcb188fb1`，无 check annotation。

## C. 契约与数据层

- [x] Native IPC v1 Schema 覆盖 12 种消息，并由 Draft 2020-12 validator 真正编译/验证。
- [x] TypeScript boundary guard 验证 envelope、RFC3339、nonce、UTF-16 text/range、physical-px、进程 basename 和未知字段。
- [x] 4-byte LE framing 覆盖拆包、合包、截断、0/超长、非法 UTF-8、重复 key 和嵌套上限。
- [x] TypeScript 与 C++ 对 32,768 UTF-16 code units、astral character 和 range end 采用同一语义。
- [x] 应用状态机覆盖 Native 重连、latest selection、翻译取消和 stale-result suppression。
- [x] 翻译 Provider 抽象已定义能力、取消和错误边界，未绑定具体厂商。
- [x] SQLite `0001_initial.sql` 会在测试中真实执行并验证表、migration 版本和外键状态。

## D. 进程隔离与 IPC

- [x] Electron Main 以唯一 pipe、parent PID 和 128-bit nonce 启动独立 Host，并核对 `ready.hostPid`。
- [x] Pipe server 使用当前用户 SID DACL、`FILE_FLAG_FIRST_PIPE_INSTANCE`、`PIPE_REJECT_REMOTE_CLIENTS` 和 client PID 校验。
- [x] Host 要求首帧 `hello`、恒定时间 nonce 比较、版本交集和严格 request payload。
- [x] Main 对响应 method、event seq、相关 `host/error`、断线、健康超时和敏感错误脱敏做 fail-closed 处理。
- [x] Supervisor 覆盖正常启停、缺失可执行文件、健康检查、早期连续崩溃的有限退避/熔断。
- [x] Parent watchdog 在 Main 消失后终止 Host；正常 shutdown 清理 Hook、Pipeline、Pipe 和子进程。
- [x] 真实 `hello → ready → health → shutdown` Named Pipe smoke 已通过。

## E. Windows Native 可行性

- [x] `WH_MOUSE_LL` 位于专用 message-loop thread，callback 只写有界 SPSC 事件并立即 `CallNextHookEx`。
- [x] Selection pipeline 使用 generation/latest-wins，在 settle、UIA、capture、OCR 各阶段丢弃旧结果。
- [x] UI Automation 位于 COM MTA worker，有单 outstanding 上限、deadline 和 provider timeout。
- [x] DXGI Desktop Duplication 只捕获有界 ROI，像素不跨 Pipe、不落盘；真实 128×128 probe 已通过。
- [x] OCR 通过 `IOcrEngine`/Paddle adapter 隔离；Phase 1 未捆绑 runtime 时诚实报告 `degraded: ["ocr"]`。
- [x] Native Host、probe 和 C++ core tests 已在 Windows x64 便携 Clang/MinGW 工具链全量构建运行。

## F. 安全与阶段边界

- [x] Main/Host 日志和连接错误不输出 nonce、完整 Pipe 名、原文、截图或供应商 secret。
- [x] Preload 不暴露通用 `send/on/invoke`；Phase 1 因无 Renderer，仅暴露静态 build info。
- [x] SQLite schema 不含截图字段；secret repository 只接受 `safeStorage` 密文边界。
- [x] 在线翻译尚未接入，Native/Renderer 不会把 selection/OCR 数据发往网络。
- [x] CI、文档和源码均未加入 Phase 2 UI 实现。

## 后续阶段明确延期项

- Phase 2：悬浮球、托盘和窗口安全配置。
- Phase 3：Chrome、Edge、Word、PDF、IDE、图片/游戏的真实 UIA/OCR 兼容矩阵，多屏/DPI 实测。
- Phase 4：百度等国内翻译 Provider、safeStorage 凭据和网络策略。
- Phase 5：p50/p95、长稳、资源占用、OCR 模型/许可证/SBOM、签名与发布门禁。

## 审核签字

- [x] 架构/产品负责人确认 Phase 1 范围：Chatblanccc（会话确认） 日期：2026-07-16
- [x] Windows Native 工程门禁：GitHub Actions run 29475175846 日期：2026-07-16
- [x] 结论：`PASS`

只有审核结论为 `PASS`，或明确记录风险后的 `PASS WITH ACCEPTED RISKS`，才开始 Phase 2。
