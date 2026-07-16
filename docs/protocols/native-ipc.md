# Native IPC 协议 v1

规范状态：Phase 1 基线
Canonical Schema：[protocol/native-ipc.schema.json](../../protocol/native-ipc.schema.json)

本文定义 Electron Main 与 `selection-host.exe` 之间的本机协议。Schema 决定字段形状；本文补充 framing、顺序、跨字段约束、安全和错误语义。二者冲突时必须停止集成并修订，不能任意选择一方。

## 1. 传输与角色

- Native Host 是 Windows Named Pipe server，Electron Main 是唯一 client。
- 完整名称：`\\.\pipe\desktop-translate.selection-host.<mainPid>.<nonce>`；mainPid 为 Electron Main PID 的十进制表示，nonce 至少 128 bits CSPRNG 随机值。
- Host 以 `FILE_FLAG_FIRST_PIPE_INSTANCE`、`PIPE_REJECT_REMOTE_CLIENTS` 和当前用户 SID 专属 DACL 创建 Pipe。
- 连接后 Host 校验 client PID 等于启动参数 `--parent-pid`。
- 单连接、双向、按序传输；断线后本次会话失效，不支持在旧实例上重连或恢复在途请求。

### Framing

每帧为：

```text
+----------------------+------------------------------+
| uint32 little-endian | N bytes UTF-8 JSON document  |
| payloadLength = N    | no BOM, no trailing newline  |
+----------------------+------------------------------+
```

要求：

- v1 单帧最大 `1,048,576` bytes；读到长度前缀后、分配 payload 前先校验。
- `N=0`、超限、非法 UTF-8、重复 JSON key、非对象根节点或 Schema 不匹配均为协议错误。
- 读取必须支持长度前缀和 payload 被拆成多次 read；一次 read 也可能包含多帧。
- 写入端必须串行化 frame，禁止两个线程交错写入。
- 解析器应限制嵌套深度和总节点数；v1 合法消息无需深层嵌套。
- JSON number 不得为 `NaN`/`Infinity`；时间为 ISO 8601/RFC 3339 `date-time` 字符串。

## 2. Envelope

所有消息字段固定为：

```json
{
  "v": 1,
  "kind": "request",
  "id": "req-01",
  "method": "health",
  "timestamp": "2026-07-16T08:30:00.000Z",
  "payload": {}
}
```

| 字段 | 语义 |
|---|---|
| `v` | 协议 major，v1 固定为数字 `1` |
| `kind` | `request`、`response` 或 `event` |
| `id` | request 必填；对应 response 原样回显；在当前连接内不可复用 |
| `seq` | event 必填；Host 生命周期内单调递增，不能因 `start/stop` 清零 |
| `method` | 下表中的精确方法名，大小写敏感 |
| `timestamp` | 该 envelope 创建时间，建议 UTC |
| `payload` | 始终是对象；不允许 `null` |

Request/response 不带 `seq`；event 不带 `id`。未知字段按 Schema 拒绝，避免客户端与 Host 对同一消息产生不同解释。

## 3. 鉴权与握手

Main 连接后发送的第一帧必须是 `hello`：

```json
{
  "v": 1,
  "kind": "request",
  "id": "bootstrap-1",
  "method": "hello",
  "timestamp": "2026-07-16T08:30:00.000Z",
  "payload": {
    "desktopVersion": "0.1.0",
    "supportedVersions": [1],
    "sessionNonce": "7f4c7c8d4a7e4f76861e8e4cb3a6d901",
    "requestedCapabilities": ["mouse-hook", "uia-selection", "desktop-capture", "ocr"]
  }
}
```

Host 只有在以下条件都满足时返回 `ready`：client PID 正确、nonce 与启动参数恒等、版本有交集、请求能力可解释。`ready` 使用同一 `id`，但 method 为 `ready`：

```json
{
  "v": 1,
  "kind": "response",
  "id": "bootstrap-1",
  "method": "ready",
  "timestamp": "2026-07-16T08:30:00.004Z",
  "payload": {
    "selectedVersion": 1,
    "hostVersion": "0.1.0",
    "hostPid": "14240",
    "sessionNonce": "7f4c7c8d4a7e4f76861e8e4cb3a6d901",
    "capabilities": ["mouse-hook", "uia-selection", "desktop-capture", "ocr"]
  }
}
```

Main 必须核对 nonce、`hostPid` 和选定版本。握手完成前除 `hello` 外的消息均非法；握手失败时 Host 不返回包含诊断细节的业务 payload，直接断开并在本地写入脱敏错误。

能力枚举：`mouse-hook`、`uia-selection`、`uia-point-approximation`、`desktop-capture`、`ocr`。`ready.capabilities` 是实际可用能力，不保证等于请求列表；Main 不得调用/假设未声明能力。

## 4. 请求与响应

| Request | 成功 Response | 用途 |
|---|---|---|
| `hello` | `ready` | 鉴权与版本/能力协商；每连接只允许一次 |
| `health` | `health` | 返回 Host 状态、监听状态、运行时长和降级能力 |
| `start` | `start` | 应用配置并开始监听；幂等调用应返回当前有效配置 |
| `stop` | `stop` | 停止监听并取消任务；Host 和 Pipe 继续存活 |
| `shutdown` | `shutdown` | 停止接收新任务、尽力清理并退出 |

同一 request 必须至多得到一个 response。Main 为每个 request 设置本地 deadline；超时后不可复用其 `id`。v1 不做 request pipeline 恢复，断线时所有 pending request 失败。

### `start` 配置

| 字段 | 默认 | 允许范围/语义 |
|---|---:|---|
| `enableUia` | `true` | 是否启用 UIA 快速路径 |
| `enableOcrFallback` | `true` | 是否允许 OCR |
| `ocrActivation` | `fallback` | `fallback` 或仅 `alt-drag` |
| `settleDelayMs` | `80` | `0..500` ms |
| `minDragDistancePx` | `4` | `2..64` physical px |
| `uiaTimeoutMs` | `350` | `50..2000` ms |
| `ocrTimeoutMs` | `2500` | `250..10000` ms |
| `excludedProcessNames` | `[]` | 最多 256 个进程 basename；不接受路径或通配符 |

Host 返回 `effectiveConfig`，Main 以它作为实际配置来源。缺失字段采用 Schema 默认值；未知字段拒绝。

## 5. Event

v1 只有两个 event method：

### `selection/result`

```json
{
  "v": 1,
  "kind": "event",
  "seq": 12,
  "method": "selection/result",
  "timestamp": "2026-07-16T08:30:02.145Z",
  "payload": {
    "selectionId": "d52a6501-01e1-4ac6-97a3-84a7d664216e",
    "source": "uia",
    "text": "architecture",
    "ranges": [{"start": 0, "end": 12}],
    "confidence": 1,
    "physicalRects": [{"x": 640, "y": 420, "width": 118, "height": 24}],
    "releasePoint": {"x": 758, "y": 438},
    "monitor": {
      "id": "DISPLAY1",
      "handle": "0x10001",
      "bounds": {"x": 0, "y": 0, "width": 2560, "height": 1440},
      "workArea": {"x": 0, "y": 0, "width": 2560, "height": 1400},
      "dpiX": 144,
      "dpiY": 144,
      "scaleFactor": 1.5
    },
    "target": {"pid": "8204", "hwnd": "0x30A9C", "processName": "chrome.exe"},
    "coordinateSpace": "physical-px",
    "timestamp": "2026-07-16T08:30:02.130Z"
  }
}
```

跨字段语义：

- `selectionId` 是一次合格手势的 UUID；Main 只接受当前 active selection。
- `source` 为 `uia`、`uia-point-approx` 或 `ocr`。近似结果不得在 UI 中伪装为真实 UIA selection。
- `text` 长度上限 32768；不得包含未配对 surrogate 或 NUL。
- `ranges[].start/end` 是 `text` 的 UTF-16 code-unit offset，满足 `0 <= start < end <= text.length`，按 start 非递减且不得重叠。
- `ranges[].text` 如存在，必须与对应 slice 规范化后一致。
- `confidence` 为 `0..1`；它只在相同 source/模型内可比较，不是跨引擎统一概率。
- `physicalRects` 和 range 内 rectangles 最多各 256 个，可为空；为空时 Main 使用 `releasePoint` 锚定。
- rect 使用 `{x,y,width,height}` 物理像素；允许负 `x/y`，`width/height` 必须为正。
- `monitor.bounds/workArea` 是结果产生时的快照；显示配置已变化时 Main 丢弃结果。
- `target.pid` 是十进制字符串；`hwnd`/handle 是十进制或 `0x` 字符串。`processName` 如存在只允许 basename。
- payload `timestamp` 是 selection 取得时间；envelope `timestamp` 是 event 创建时间，后者不得早于前者。

### `host/error`

错误 payload 包含：稳定 `code`、供开发者理解的 `message`、`scope`、`recoverable`，以及可选 `relatedRequestId`、`selectionId`、标量 `details`。`message/details` 禁止包含原文、OCR 图像、窗口标题、nonce、Pipe 名或密钥。

Phase 3 Host 当前错误码（内部 snake_case 在协议边界转为以下大写形式）：

| Scope | Code | 典型处理 |
|---|---|---|
| protocol | `INVALID_ARGUMENT`、`FRAME_TOO_LARGE`、`MALFORMED_FRAME`、`MALFORMED_JSON`、`UNSUPPORTED_PROTOCOL`、`HANDSHAKE_REQUIRED`、`NONCE_MISMATCH`、`UNAUTHORIZED_CLIENT` | 通常断开；不得自动重放 |
| hook | `HOOK_INSTALL_FAILED`、`HOOK_QUEUE_OVERFLOW` | 降级/停止监听或取消本次任务；提示重试 |
| uia | `UIA_UNAVAILABLE`、`UIA_PASSWORD_FIELD`、`UIA_NO_SELECTION`、`UIA_TIMEOUT` | 仅 unavailable/no-selection/timeout 可按策略 OCR；密码目标禁止绕过 |
| capture | `CAPTURE_UNAVAILABLE`、`CAPTURE_TIMEOUT`、`CAPTURE_ACCESS_LOST`、`CAPTURE_PROTECTED`、`CROSS_MONITOR_UNSUPPORTED` | 结束本次任务；下一任务可在安全边界内重建 capture |
| ocr | `OCR_UNAVAILABLE`、`OCR_TIMEOUT`、`OCR_NO_TEXT`、`OCR_LOW_CONFIDENCE` | 结束本次任务；不猜测文本 |
| host | `SELECTION_CANCELLED`、`TARGET_ELEVATED`、`SECURE_DESKTOP`、`PROTECTED_CONTENT`、`INVALID_STATE`、`PIPE_ERROR`、`PARENT_EXITED`、`INTERNAL_ERROR` | 安全边界拒绝、请求失败、断开或触发有限重启 |

以上稳定 code 已在 Phase 3 Native Host 中落地。新增 code 仍需同步 C++/TS fixtures 和本文，
不得用 `INTERNAL_ERROR` 长期掩盖预期分支。

预期的“没有选中文字”不应刷屏为全局错误；实现可以静默结束该 selection。若发送 error，带 `selectionId` 以便 Main 关联。

## 6. 顺序、取消与背压

- Event `seq` 严格递增；Main 发现倒退或重复即视为协议错误。允许跳号，例如某些诊断事件未对外转发。
- 新 selection 使旧 selection 失效；v1 没有显式 cancel method，由 Host 的 latest-wins 状态机和 `stop` 完成取消。
- Pipe 输出队列必须有界。不能因 Main 读取过慢而阻塞 Hook；无法保持边界时 Host 先停止监听并发出 `HOST_BACKPRESSURE`，随后可断开。
- `stop` 成功响应之后，不得再发布 stop 前任务的 `selection/result`。
- `shutdown` 成功响应只表示已接受关闭；Main 仍需等待进程退出，并设置 grace deadline。

## 7. 版本演进

- `v` 是 major；破坏性变化使用 v2，并在 `hello.supportedVersions` 协商。
- v1 对未知字段采取拒绝策略，因此不得偷偷追加“可忽略字段”。新增字段需要同步更新 Schema、TS/C++ contract 和兼容测试，并评估是否仍属于 v1。
- 进程版本与协议版本独立；`desktopVersion`/`hostVersion` 用于诊断，不能替代协议协商。
- Golden frame、分片读取、合并多帧、超限、畸形 UTF-8、未知字段、顺序错误和 fuzz case 必须进入契约测试。

## 8. 安全说明

Pipe DACL、远程拒绝、client PID 和 nonce 是纵深防御；它们不能防御已完全控制当前用户会话的恶意进程。IPC 两端仍必须把对方数据视为不可信并执行 Schema 与语义校验。Named Pipe 的 Windows ACL 行为见 [微软官方文档](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)。
