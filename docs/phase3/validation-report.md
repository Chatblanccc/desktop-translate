# Phase 3 验证报告

- 验证日期：2026-07-16
- 版本：`0.3.0-phase3`
- 发布口径：内部开发预览
- 当前结论：`PASS WITH ACCEPTED RISKS`
- 开发分支：`codex/phase3-selection-loop`
- Phase 2 基线：`5d2cf770de224ce0670cde4088db084df6e0ac62`

> Phase 3 的 source-only 划词闭环、真实 Windows Host/Hook、UIA、Windows.Media.Ocr、Electron 结果卡和完整本地门禁均通过。接受风险只覆盖未安装应用、额外物理显示矩阵、长稳和尚未运行的远端 CI，不包含已知 P0/P1 代码缺陷。

## 1. 验证环境

| 项目 | 实际值 |
|---|---|
| 操作系统 | Windows 11 x64 |
| 显示器 | 当前单屏，`1920 × 1080` |
| DPI / 缩放 | `96 DPI` / `100%` |
| GPU | NVIDIA GeForce RTX 3060，另有 Oray/MuMu 虚拟显示适配器 |
| 浏览器 | Google Chrome |
| Native Host | `selection-host.exe`，版本 `0.3.0-phase3` |
| OCR | Windows.Media.Ocr，本机系统语言能力 |

本轮不改变用户显示设置，不安装 Office/Acrobat，也不驱动管理员、安全桌面、DRM 或游戏/反作弊场景。

## 2. 完整门禁

执行：

```powershell
pnpm phase3:verify
```

结果：退出码 `0`，最新完整运行约 `91.2s`。该门禁覆盖 lint、typecheck、全部 JS/TS 测试、覆盖率、生产构建、Native configure/build/CTest、Phase 1 Named Pipe、Phase 2 Electron smoke、Phase 3 真实 Host smoke 和完整 Electron E2E。

| 测试组 | 结果 |
|---|---:|
| Contracts | `19 passed` |
| Storage | `10 passed` |
| Desktop | `141 passed` |
| Native CTest | `2 / 2 passed` |
| Phase 2 Electron smoke | `3 / 3 passed` |
| Full Electron E2E | `3 / 3 passed` |

覆盖率：

| 指标 | 结果 |
|---|---:|
| Statements | `94.17%` |
| Branches | `86.01%` |
| Functions | `92.28%` |
| Lines | `96.14%` |

无关键测试 skip。`git diff --check` 通过；换行提示仅为工作区 CRLF 转换提示，不是 diff 错误。

## 3. 真实 Host、Hook 与生命周期

Phase 3 smoke 连接真实 Named Pipe 和仓库构建的 Host，返回：

```text
hostVersion = 0.3.0-phase3
capabilities = mouse-hook, desktop-capture, uia-selection, ocr
before start: listening=false
after start:  listening=true
after stop:   listening=false
```

Native CTest 同轮覆盖 Hook install/stop、selection queue、UIA/OCR 回退、跨屏拒绝、旋转/黑屏捕获回退、timeout、late result 和稳定错误码。完整门禁结束后进程扫描未发现 Electron 或 `selection-host.exe` 残留。

## 4. 真实应用矩阵

| 场景 | 结果 | 证据 |
|---|---|---|
| 记事本普通文本 | PASS | UIA 精确返回 `Phase Three Notepad UIA Validation 67890` |
| Chrome 普通 HTML | PASS | UIA 精确返回 `Phase Three Chrome UIA Validation 13579` |
| Chrome 密码框 | PASS | 四个点位均返回 `uia_password_field`，没有回退 OCR |
| VS Code Monaco | PASS / limited | UIA 返回 `uia_no_selection`；前台 Windows OCR 精确包含 `Phase Three VS Code UIA Validation 97531` |
| Windows OCR synthetic | PASS | 精确返回 `Phase Three OCR Validation 12345` |
| Word | 未执行 | 本机未安装；P3-R-001 |
| Acrobat / 文本 PDF | 未执行 | 本机未安装 Acrobat，本轮未重复 Edge；P3-R-001 |
| Windows Terminal | limited | 桌面自动化安全边界不驱动终端；P3-R-001 |
| 管理员/安全桌面/DRM | 未做破坏性实测 | fail-closed 分支由 Native 测试覆盖；P3-R-007 |

密码实测暴露并修复了一个真实边界：Chrome 的 TextPattern 可能来自密码元素的普通子节点。实现现在沿 UIA 祖先链检查密码属性，并拒绝常见 mask-only 字符串；新增 Native 回归测试后四个实测点位全部拒绝。

## 5. Electron 结果卡与隐私

- Card 是独立 Renderer/Preload 角色，`sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`。
- Main 只向 Card 发送白名单 view model；原文不进入全局 `UiShellSnapshot` 或 SQLite。
- 单例卡片按 selection generation/seq 执行 latest-wins；stop、Host 重启、显示变化和退出会隐藏并失效旧结果。
- 100/125/150/200% DPI、负坐标、窄工作区、任务栏四边、上下翻转和 workArea clamp fixture 全部通过。
- 运行产物精确扫描未发现用户绝对路径、完整 Pipe 标识、nonce、测试 secret 或三段真实应用测试原文。
- Native 截图只存在内存；本轮未生成 Phase 3 桌面截图证据。

## 6. OCR 与供应链

- 使用 Windows.Media.Ocr，不上传截图、不在运行时联网下载模型。
- C++/WinRT `3.0.260520.1` 固定 SHA-256：`D22E2E26133D63217AE26E91B1685FB024B03A508A78AF645F8347A3126C8435`。
- Windows SDK Contracts `10.0.26100.8249` 固定 SHA-256：`0E1C25793ED1265D49ED5846F1F9DD5A5A32FD44D3E9C16E74B7FDA018E5FBD8`。
- 系统 API 不提供可校准的统计置信度，产品以明确的中性来源提示呈现；no-text/timeout 不猜测结果。

## 7. 接受风险与发布边界

| 风险 | 接受范围 | 补救与复审 |
|---|---|---|
| P3-R-001 / 002 | Word、PDF、Terminal 和复杂语言/图像矩阵不完整 | 独立装机补测；2026-08-15 |
| P3-R-004 / 015 | 物理双屏、旋转、额外 DPI 和远端 CI 未执行 | 独立硬件补测；推送后运行 Windows workflow；发布前或 2026-08-15 |
| P3-R-007 / 010 | 管理员、安全桌面、DRM、游戏/反作弊未做破坏性实测 | 保持 fail closed；隔离环境补测；2026-08-15 |
| P3-R-014 | 未做 8 小时长稳和重启风暴压力 | 后续性能阶段增加 soak 与指标；2026-08-15 |

这些风险不会扩大 Phase 3 权限或产品范围。当前交付仍是本地 source-only 内部预览，不包含翻译 Provider、凭据、历史/收藏、安装器、签名、自动更新或正式发布。

## 8. 最终结论

Phase 3 核心完成定义已满足：实现、完整本地门禁、真实 Host/Hook/UIA/OCR、Chrome 密码拒绝、Electron Card、生命周期与隐私扫描均通过。未执行项已保留为明确、可追踪的接受风险，未被伪装成已通过。

最终结论：`PASS WITH ACCEPTED RISKS`。
