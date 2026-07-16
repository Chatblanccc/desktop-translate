# Phase 3 OCR 运行时与供应链记录

## 运行时选择

Phase 3 使用 Windows 系统 API `Windows.Media.Ocr`，通过 C++/WinRT 从内存
`SoftwareBitmap` 识别文字。它离线使用当前 Windows 已安装的 OCR language pack，应用不携带、
下载或更新模型。运行环境缺少可用 OCR 语言时，Host 诚实降级但 UIA 取词仍可工作。

`IOcrEngine` 是可替换边界；仓库中的 Paddle adapter 在 Phase 3 构建中关闭，未打包 Paddle
runtime 或模型。

## 固定构建依赖

| NuGet package | 固定版本 | SHA-256 | 用途 |
|---|---|---|---|
| `Microsoft.Windows.CppWinRT` | `3.0.260520.1` | `D22E2E26133D63217AE26E91B1685FB024B03A508A78AF645F8347A3126C8435` | 生成 C++/WinRT projection；MIT |
| `Microsoft.Windows.SDK.Contracts` | `10.0.26100.8249` | `0E1C25793ED1265D49ED5846F1F9DD5A5A32FD44D3E9C16E74B7FDA018E5FBD8` | WinRT metadata；Windows SDK license |

`tooling/prepare-winrt.ps1` 仅在构建时从 NuGet 官方 flat-container 下载缺失包，下载后先校验
SHA-256，失败即停止。运行 `selection-host.exe` 不访问网络。

## 已知边界

- `Windows.Media.Ocr` 不公开逐词置信度。Phase 3 对成功的系统 OCR 结果标记中性置信度
  `0.75`，只作为来源提示，不将它解释为统计校准概率。
- 识别语言由系统 language pack 决定；真实语言矩阵必须记录 OS build 与语言包。
- 若未来改为随应用分发第三方 runtime/model，必须新建 ADR、许可证/SBOM 条目和模型质量门禁，
  不能沿用本记录声称已验收。
