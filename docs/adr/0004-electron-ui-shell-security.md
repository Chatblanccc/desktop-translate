# ADR-0004：Electron UI Shell、角色化 IPC 与窗口安全

- 状态：已接受
- 日期：2026-07-16
- 决策人：Phase 2 架构评审

## 背景

Phase 2 首次引入长期驻留的 Renderer、透明置顶窗口、系统托盘和用户设置。悬浮球与设置页具有不同权限，Native Host 又可能缺失或崩溃。如果窗口直接掌握 Electron API、共享一个宽泛 Preload，或把 UI 生命周期绑定到 Native Host，单个 Renderer 漏洞或 Host 故障就可能扩大为本机权限滥用或整个产品退出。

## 决策

Electron Main 中建立单一、幂等的 Shell Controller，作为所有窗口、Tray、设置、悬浮球位置和 Native UI 状态的权威源。Ball 与 Settings 使用独立 Renderer HTML 入口和独立 Preload，按窗口角色授予最小能力。

### 窗口工厂

所有 BrowserWindow 必须通过统一的安全工厂创建，固定启用：

```ts
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webviewTag: false,
}
```

同时执行以下策略：

- 只加载应用打包的本地页面；生产构建拒绝任意导航和新窗口。
- CSP 至少为 `default-src 'self'; connect-src 'none'`，仅按构建所需最小化开放本地 script/style/image/font。
- 所有权限请求和权限检查默认拒绝；禁止下载、`<webview>` 和 Renderer 直接打开外链。
- 生产环境默认关闭 DevTools；开发开关不得改变其余安全策略。
- Ball 使用透明无框窗口，Settings 使用标准窗口；共享安全策略但不共享角色权限。

### 角色化 Preload API

Ball 只暴露：

```ts
interface BallApi {
  getSnapshot(): Promise<UiShellSnapshot>;
  openSettings(): Promise<void>;
  openContextMenu(): Promise<void>;
  onSnapshotChanged(listener: (snapshot: UiShellSnapshot) => void): () => void;
}
```

Settings 只暴露：

```ts
interface SettingsApi {
  getSnapshot(): Promise<UiShellSnapshot>;
  setBallVisible(visible: boolean): Promise<UiShellSnapshot>;
  setEdgeSnap(enabled: boolean): Promise<UiShellSnapshot>;
  setTheme(theme: ThemeMode): Promise<UiShellSnapshot>;
  resetBallPosition(): Promise<UiShellSnapshot>;
  onSnapshotChanged(listener: (snapshot: UiShellSnapshot) => void): () => void;
}
```

Preload 禁止暴露 `ipcRenderer`、Electron event、channel 字符串或通用 `send/on/invoke`。订阅包装器只传递经运行时校验和结构化克隆的快照，并返回只移除该 listener 的 unsubscribe。

### Main 端授权

Main 不能把“知道 channel 名称”视为授权。每个请求同时验证：

1. `event.sender.id` 属于已注册、尚未销毁的目标窗口。
2. sender 的角色允许该操作；Ball 不得调用 Settings 写接口。
3. 请求来自主 frame，不接受子 frame。
4. frame URL 是预期本地页面；开发服务器只能在显式开发模式下接受固定 origin。
5. payload 的类型、枚举、大小和未知字段符合对应运行时 Schema。

任何一项失败都拒绝请求，并只记录稳定错误码和角色，不记录 payload。Main 发布状态时必须按当前窗口集合发送，不保留指向已销毁 webContents 的 listener。

### 数据与 Native 边界

- SQLite 迁移和设置 repository 只存在于 Main；Renderer 只能通过白名单方法修改四个 Phase 2 设置键。
- Native Host 与 UI 壳层解耦。Shell/Tray 先创建，Host 缺失或失败只改变 `NativeUiStatus`。
- Phase 2 只执行握手、health 和 shutdown；不得发送 `start`，不得安装 Hook。
- 开发态可以使用显式 `SELECTION_HOST_PATH`；packaged 应用只允许从 `process.resourcesPath` 下的固定相对路径启动预期 Host，禁止任意环境路径。

## 结果

优点：

- XSS 或 Renderer 依赖问题只能触达该窗口明确拥有的少量动作。
- Host 故障不会拖垮 UI，用户始终能从 Tray 恢复窗口或完全退出。
- Main-only 状态和持久化避免跨窗口竞态及多个真相源。
- 安全配置、IPC 越权和生命周期可以通过独立测试断言。

代价：

- 需要两个 Preload、多个构建入口和角色注册表。
- IPC DTO 需要运行时校验，不能只依赖 TypeScript。
- 透明窗口的拖动区、键盘区和显示器恢复需要额外几何测试。

## 未选择方案

| 方案 | 不采用原因 |
|---|---|
| 单个通用 Preload | Ball 会获得设置写入等不需要的权限，channel 误用难以审计 |
| Renderer 直接使用 Electron/SQLite | 破坏沙箱与最小权限，扩大 XSS 影响面 |
| 每个窗口自行保存状态 | 产生多真相源、Tray 同步竞态和损坏恢复差异 |
| Host 启动成功后再创建 UI | Host 缺失或熔断会让用户失去状态、恢复和退出入口 |
| 整个悬浮球设为 CSS drag 区 | drag 区忽略指针事件，无法同时提供可靠按钮和键盘操作 |
| 透明窗口 click-through | 容易造成用户无法恢复点击，且不符合 Phase 2 的操作模型 |

## 复审触发条件

- 新增翻译卡片、远程内容、外链、文件选择、剪贴板或其他 Renderer 权限。
- 需要在 Renderer 联网，或把 `connect-src` 从 `none` 放开。
- 引入第三种窗口角色或通用插件机制。
- packaged Host 路径、签名/更新模型或 AppContainer 约束改变。
- 任意 IPC 需要承载选区原文、截图、密钥或其他敏感数据。
