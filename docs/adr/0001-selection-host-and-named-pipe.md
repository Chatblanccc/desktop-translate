# ADR-0001：独立 Selection Host 与私有 Named Pipe

- 状态：已接受
- 日期：2026-07-16
- 决策人：项目架构评审

## 背景

全局 Hook、COM/UIA、DXGI 和本地 OCR 都可能阻塞、崩溃或依赖与 Electron 不同的原生运行时。若把它们放入 Electron Main 的 `.node` 模块，原生内存错误会直接终止整个桌面应用，并增加 Electron/Node ABI 升级成本。

## 决策

原生能力实现为与 Electron 同包、同签名的独立 x64 进程 `selection-host.exe`。Electron Main 负责启动、监督和停止 Host；Renderer 不得直接连接 Host。

Host 是 Named Pipe server，Main 是唯一 client。每次启动使用：

```text
selection-host.exe \
  --pipe \\.\pipe\desktop-translate.selection-host.<mainPid>.<nonce> \
  --parent-pid <electron-main-pid> \
  --nonce <random-hex>
```

`<mainPid>` 是 Electron Main PID 的十进制表示，`<nonce>` 至少包含 128 bits 的 CSPRNG 随机值并用 hex 编码。PID 只用于关联和诊断，鉴权仍必须同时依赖 DACL、`GetNamedPipeClientProcessId` 与 nonce。

安全要求：

1. 名称中的 nonce 每次启动重新生成，禁止复用或写日志。
2. Host 使用 `PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE`，防止静默连接已被抢占的同名实例。
3. Pipe 使用 `PIPE_REJECT_REMOTE_CLIENTS`。
4. Host 显式构造 DACL，只允许当前登录用户 SID 访问；禁止使用 Windows 默认 Named Pipe DACL。
5. 客户端连接后，Host 调用 `GetNamedPipeClientProcessId`，结果必须等于 `--parent-pid`。
6. 第一帧必须是 `hello`，且 `payload.sessionNonce` 与启动 nonce 做恒定时间比较；否则立即断开。
7. 帧长、JSON 深度、字符串和数组长度都必须在分配/处理前校验。
8. Host 监控父进程；父进程消失后自行退出，不成为后台孤儿。

微软说明默认 Pipe DACL 会给 Everyone 和 Anonymous 读权限，因此此处必须指定安全描述符；文档也建议用登录 SID 隔离会话：[Named Pipe 安全和访问权限](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)。仅本机 Pipe 还应拒绝网络访问：[Named Pipes](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes)。

## 生命周期

- `hello → ready` 成功前，Main 不发送业务命令。
- Main 使用 `health` 检测活性，正常退出用 `shutdown`。
- Pipe 断开即取消所有在途 selection；不得重放旧请求。
- 异常退出采用有上限的指数退避（建议 1 s、2 s、4 s；5 分钟内最多 3 次）。超过阈值进入熔断，由用户显式重试或应用重启恢复。
- 更新时 Main、Host、OCR runtime 和协议版本作为一个原子版本发布；禁止混用未知二进制。

## 结果

优点：

- 原生崩溃与 Electron UI 隔离。
- UIA/OCR 依赖和线程模型可独立控制。
- 可用进程级超时、watchdog 和有限重启恢复。
- IPC 边界强制结构化、可版本化、可模糊测试。

代价：

- 需要处理 Pipe 鉴权、协议演进和进程监督。
- 文本和矩形需要序列化。
- 安装、签名与升级必须覆盖多个二进制和 OCR 资源。

## 未选择方案

| 方案 | 不采用原因 |
|---|---|
| 单体 `.node` Native Module | 原生崩溃会带崩 Main；需处理 Electron 原生模块重建和 ABI 兼容 |
| Renderer 直接加载 Native Module | 破坏 Renderer 沙箱和最小权限边界 |
| stdin/stdout JSON | 可做原型，但缺少本机对象 ACL/客户端 PID 校验；stdout 也易与诊断输出混用 |
| localhost TCP | 扩大网络攻击面，还需端口管理和独立认证 |
| 仅 Electron `utilityProcess` | 适合 Node 子进程，但不能消除 C++ ABI/崩溃与原生依赖封装问题 |

## 复审触发条件

- Windows AppContainer/商店分发成为硬要求。
- 需要跨用户会话或服务态运行。
- Pipe 无法满足吞吐或安全审计要求。
- Electron 提供能满足本项目隔离要求的稳定原生服务承载机制。
