# Phase 3 产品规格：本地划词取词闭环

- 状态：开发完成；本地验收 `PASS WITH ACCEPTED RISKS`
- 版本：`0.3.0-phase3`
- 基线：Phase 2 验收提交 `5d2cf770de224ce0670cde4088db084df6e0ac62`
- 目标平台：Windows 11 x64；Windows 10 22H2 x64 为 best-effort 兼容目标
- 发布口径：内部开发预览，不是正式安装包

## 1. 阶段目标

Phase 3 把已经验证的 Native 取词能力接入桌面产品交互。用户启用划词取词后，
`selection-host.exe` 安装全局鼠标 Hook，优先通过 UI Automation 读取真实选区；UIA 不可用、
返回空或超时时，按设置对拖拽区域执行本地 OCR。Electron Main 校验结果、完成 physical-px 到
DIP 的转换，并在选区附近展示只包含原文的识别结果卡。

本阶段不接入翻译供应商，不把原文伪装成译文，不上传或保存截图，也不把识别原文写入历史。

## 2. 用户路径

1. 应用启动并恢复持久化的“启用划词取词”状态。
2. Host 完成 `hello -> ready` 后，Main 在启用状态下发送 `start(config)`。
3. 用户在普通桌面应用中拖选文字或双击选词。
4. Host 先尝试 UIA 真选区；按策略失败后才执行局部 OCR。
5. Host 只发送结构化文本、物理矩形、来源、置信度和有限目标元数据。
6. Main 丢弃旧结果，在当前显示器工作区内定位识别结果卡。
7. 用户可关闭结果卡，或从 Settings/Tray 暂停划词取词。

## 3. 产品交互

### 3.1 启停与状态

- `selection.enabled` 默认 `true`，并持久化到 SQLite。
- Settings 和 Tray 都提供“启用划词取词”复选项，变更立即生效。
- 状态分为 `disabled`、`starting`、`listening`、`degraded`、`faulted`。
- OCR 缺失时仍允许 UIA 取词，状态为 `degraded`，不能把 UIA 一并禁用。
- Host 重启后自动恢复最新期望状态和完整配置。
- 悬浮球左键继续打开 Settings，不在本阶段改为启停按钮。

### 3.2 OCR 策略

- 默认 `ocrActivation="fallback"`：UIA 失败后自动本地 OCR。
- 用户可选择 `alt-drag`：只有按住 Alt 的拖拽才允许 OCR 回退。
- 普通点击和小于拖动阈值的手势不产生结果。
- OCR 无文本或超时不猜测文本；当前 Windows 系统 OCR 不提供校准置信度，成功结果使用明确
  标注的中性来源提示，不把它当成统计概率。

### 3.3 识别结果卡

- 卡片是第三个隔离的 Renderer/Preload 角色，只接收卡片专用白名单消息。
- 展示原文、来源（应用文字/本地 OCR）和 OCR 置信度，不展示 PID、HWND 或 monitor handle。
- 使用单例窗口，新选区替换旧选区；默认 `showInactive()`，不抢走目标应用焦点。
- 卡片宽度 380 DIP，内容高度限制在 320 DIP 内，超出滚动。
- 卡片默认位于选区下方；空间不足时翻到上方，并始终 clamp 到当前 `workArea`。
- 用户关闭、暂停取词、Host 断线/重启、显示配置变化或应用退出时隐藏卡片。

## 4. 安全与隐私

- Renderer 不得访问 Node、Electron 原始 API、任意 IPC 或网络。
- 原文只进入 Card 专用 view model，不进入全局 UI snapshot、SQLite、普通日志或诊断 artifact。
- 截图只存在于 Native Host 内存，不跨 Named Pipe、不落盘、不进入崩溃报告。
- 自身窗口、用户排除进程、密码元素、安全桌面、锁屏和受保护内容必须在 OCR 前拒绝。
- 普通权限边界保持不变：不提权、不启用 `uiAccess`、不注入、不安装服务/驱动。
- 跨显示器 OCR 本阶段明确拒绝并返回稳定错误，不能静默裁成一个屏幕。

## 5. 状态与持久化契约

UI Shell 快照只增加非敏感取词状态：

```ts
interface SelectionUiState {
  readonly enabled: boolean;
  readonly lifecycle: "disabled" | "starting" | "listening" | "degraded" | "faulted";
  readonly ocrActivation: "fallback" | "alt-drag";
}
```

新增设置键：

- `selection.enabled`
- `selection.ocrActivation`

进程排除列表复用 `app_exclusions` 表。协议当前只向 Host 发送启用项的 process basename；
`window_class` 保留为后续能力，不在 Phase 3 UI 中伪装成已生效条件。

## 6. Native 行为

- `health.listening` 必须反映 Hook/Pipeline 的真实运行状态。
- 新手势使旧 selection 失效；stop/shutdown 后不得发布 late result。
- UIA 有效结果直接发布且禁止截图。
- `UIA_PASSWORD_FIELD`、`PROTECTED_CONTENT`、`SECURE_DESKTOP` 禁止 OCR。
- 旋转输出必须正确归一化；无法可靠处理的跨屏 OCR 返回 `CROSS_MONITOR_UNSUPPORTED`。
- 预期失败使用稳定错误码，不长期用 `INTERNAL_ERROR` 掩盖。

## 7. 阶段外内容

- 在线翻译 Provider、目标语言、词典、音标、发音和例句。
- 历史、收藏、翻译缓存和 Provider 凭据。
- 云 OCR、截图上传、剪贴板轮询或模拟 `Ctrl+C`。
- 安装器、签名、自动更新、正式发布和完整 SBOM 门禁。
- Phase 5 的 p50/p95、长稳、资源占用和发布体积优化。

## 8. 完成定义

只有自动门禁、真实 Named Pipe/Hook/UIA/OCR、Electron E2E、真实应用兼容矩阵、多屏/DPI
实机步骤、安全隐私扫描和风险复评全部完成，且无未处置 P0/P1 缺陷，Phase 3 才能标记为
`PASS` 或 `PASS WITH ACCEPTED RISKS`。
