# ADR-0005：Phase 5 打包、签名与更新边界

- 状态：Accepted for implementation
- 日期：2026-07-18

## 背景

Phase 4 只交付开发态闭环，没有 installer、Authenticode、更新或完整 SBOM。Phase 5 需要一个实际可安装的
RC 作为性能、长稳、供应链和发布验收载体，同时不能让打包便利削弱 Phase 1–4 的普通权限、Main-only 网络、
固定 Host 路径和默认不联网边界。

## 决策

1. 使用 Electron production ASAR 和 per-user NSIS x64 installer；不请求管理员权限；
2. `selection-host.exe` 放在 `resources/selection-host/`，migrations 放在 `resources/migrations/`；
3. production 模式继续拒绝 `SELECTION_HOST_PATH`、fake Provider 和 E2E transport 注入；
4. Phase 5 RC 只支持从受信 HTTPS 页面下载完整签名 installer 的手动更新，不实现自动更新；
5. 普通卸载保留当前用户 userData；显式“清除全部本地数据”负责删除设置、凭据和临时 metrics；
6. MSVC x64 Release 使用 `/MT` 静态 CRT，不安装或随包分发 VC Redistributable；
7. 项目自有 Electron PE、Host/DLL 和 installer 使用同一 Authenticode 身份。确切 subject 来自受保护发布
   环境，并由验证脚本精确匹配；仓库不保存 PFX、密码、私钥或虚构 publisher；
8. 构建顺序固定为：clean HEAD 重建 inner PE → 签 inner PE → 组装 installer → 签 installer → 重算最终
   SHA-256 → GitHub/Sigstore artifact provenance → 生成最终 release manifest → 对 manifest 单独做 provenance →
   在独立 runner 下载后离线复验；
9. PR/fork 只产出 unsigned artifact。unsigned 包可用于布局、包体、隐私和部分 clean-VM 测试，但不能称为 RC；
10. 自动更新若进入公开 V1，必须另建 ADR，定义 HTTPS、签名 manifest、原子版本单元、N-1、损坏/断网/
    中断/磁盘不足和回滚矩阵；
11. `SignedRelease` 必须同时满足 tracked、staged、untracked 全部为空，并禁止 `SkipBuild`。unsigned/dirty
    开发包必须记录 `developmentDirty` 和内容派生的 `patchDigest`，不得冒充 HEAD 验收证据；
12. release 证据对 app、`selection-host.exe`、ASAR、installer 使用精确角色集合和当前文件重算 hash；签名集合
    精确为 app、Host、installer。任何漏项、增项、陈旧 report 或打包后变更均 fail closed；
13. 独立信任根采用 GitHub Artifact Attestations（`actions/attest` v4 系列、GitHub/Sigstore trusted root）。
    final manifest 自身必须有 companion attestation，且只有独立 `windows-2022` 下载任务产出的
    `clean-download-verification.json: PASS` 才关闭最终 blocker；无 OIDC、attestation API、trusted root、真实证书或
    远程环境时均保持 `RELEASE BLOCKED`；
14. 所有打包/证据脚本的递归删除在执行前必须拒绝目标、父路径或子树中的 reparse point/junction；
15. 每次 package run 必须独占创建一个此前不存在的 evidence root，禁止复用旧目录混入历史证据；打包启动
    smoke 先写 `PENDING`，只有进程树停止且临时 userData 安全删除完成后才可将 report/manifest 同步提升为 `PASS`；
16. `extraResources` 中的 Host 通过 electron-builder `win.signExts` 精确列出 `selection-host.exe`，并由仓库策略
    校验器拒绝缺失或扩大到通用 `.exe` 的配置。

## 选择 per-user NSIS 的理由

- 与 Host 标准用户权限和无服务/驱动的产品边界一致；
- 支持完整安装、覆盖安装、修复/重装和卸载验收；
- Electron 生态构建路径成熟，并可显式控制 ASAR、extraResources、签名和文件白名单；
- 相比便携压缩包，更能验证实际安装目录、卸载语义、publisher 和 clean VM 行为。

## 被拒绝方案

- **管理员级 machine-wide installer**：扩大权限和写入范围，当前没有业务必要；
- **便携 ZIP 作为 RC**：不能覆盖正式安装、卸载、publisher 和更新路径；
- **开发路径覆盖 packaged Host**：允许任意二进制替换，违反生产边界；
- **自签名证书作为发布通过证据**：不能建立真实用户信任链；只可用于脚本负向开发且必须标为 test-only；
- **Phase 5 同时实现自动更新**：扩大供应链和回滚范围，缺少独立产品需求。

## 安全与隐私后果

- installer/ASAR 必须解包逐文件扫描，不能只扫描压缩字节；
- source map、test、fixture、fake transport、coverage、secret 和绝对本地路径禁止进入正式包；
- third-party PE 保留上游签名或由 SBOM/hash manifest 约束，不重签破坏其 provenance；
- checksum 不是信任根，release manifest 必须有独立验证公钥或已评审发布框架的等价信任链；
- GitHub provenance 证明具体字节来自受保护 workflow/ref，但不能把受损的 self-hosted runner 变成可信环境；
  发布环境保护、最小化密钥暴露和独立 GitHub-hosted clean-download 复验仍是必要边界；
- 缺少真实证书时发布状态为 `RELEASE BLOCKED`，这是预期的 fail-closed 结果。

## 信任根实现依据

- workflow 固定到官方 [`actions/attest` v4.2.0](https://github.com/actions/attest/releases/tag/v4.2.0) 的 commit，
  并只在 protected release job 授予 `id-token: write`、`attestations: write`、`artifact-metadata: write`；
- release 与 clean-download runner 要求 GitHub CLI `>= 2.93.0`，并在运行时确认离线 bundle、trusted root、
  source ref/digest 和 signer workflow 约束参数均可用；
- clean-download 入口遵循 GitHub 官方
  [离线 attestation 验证流程](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline)：
  attestation bundle 与 `trusted_root.jsonl` 分开取得，再用 `gh attestation verify --bundle --custom-trusted-root`
  绑定 repository、workflow、source ref 和 source digest；
- 随发布证据携带的 trusted root 只用于 hash 绑定；独立下载任务会再次从 GitHub TUF 路径取得 trusted root，
  两者不一致即阻止发布，避免把候选包自带的“根”直接当作信任起点。
- Host 的额外签名入口采用 electron-builder 官方
  [`win.signExts`](https://www.electron.build/docs/win/#signexts) 配置；仓库只允许精确文件名
  `selection-host.exe`，最终是否实际签名仍由 exact-set Authenticode report 复核。

## 验收

- 标准用户 clean VM 的安装、启动、覆盖安装、修复、卸载、重装和回滚；
- 非 ASCII 用户目录、断网首次启动、无 OCR language pack；
- 固定资源路径、ASAR/extraResources 白名单、包体和 privacy scan；
- `/MT`/runtime 依赖复核；
- Authenticode subject、chain、timestamp、下载后复验和篡改负向测试；
- production 包中 fake/E2E 注入入口为零；
- release evidence manifest 绑定 version、clean git SHA、installer/app/ASAR/Host/SBOM/provenance/checksum hash；
- GitHub artifact bundle 与 trusted root 可按官方 `gh attestation verify --bundle --custom-trusted-root` 离线复验；
- 独立下载后的 exact-set、hash、Authenticode、artifact attestation、manifest attestation 全部通过。
