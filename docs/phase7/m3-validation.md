# Phase 7 M3 development validation

- 状态：`DEVELOPMENT PASS WITH REAL FRESH-INSTALL + CURRENT-CANDIDATE DEFAULT INTERACTIVE/QUIET-UNINSTALL EVIDENCE; REGISTERED UPGRADE/CLEAN-VM/PHYSICAL INPUT OPEN`
- 日期：2026-07-25
- 基线 HEAD：`d117e4b1b4989157826aad1febc59bf49ee17539`
- 分支：`codex/phase7-first-beta`
- 证据对象：
  - 第三版 unsigned development installer 的真实 custom-root fresh install，绑定
    `HEAD+WORKTREE:9dc2086ba44b7048fbd6d7b7b91e8549e71e4d44003488822277cfad96547a3e`；
  - 第四版 unsigned development installer 的 package/evidence gates，绑定
    `HEAD+WORKTREE:801529a0ccccd7b9d7176214471013b3b3f0e2b02abfeb486195458a1cb77493`。
  - 第五版 unsigned development installer 的 fresh-directory/marker identity-bound package/evidence
    gates，绑定
    `HEAD+WORKTREE:2eb074a29b2b5e9019d1385d4cf504fea12a27e82d0db0595be69a4afeb0974c`。
  - 当前修复候选的默认 CurrentUser 安装、两轮 Quiet 卸载与一轮普通交互安装/卸载，绑定
    `HEAD+WORKTREE:f75885a3d738dbfc7f5cc46a697366bf55bf49dab5aea26d0c3bef6f0dd406ee`。
- 明确不代表：签名候选、clean VM、registered 升级、物理鼠标或物理触控板验收

## 1. Installer implementation

当前 assisted NSIS 配置：

- `oneClick: false`
- `perMachine: false`
- `allowElevation: false`
- `packElevateHelper: false`
- `allowToChangeInstallationDirectory: true`
- `directories.buildResources: build`
- 唯一 include 为 `build/installer.nsh`

audited include 现在提供完整的 fresh/registered/recovering fail-closed 状态机：

1. `phase7InitCurrentUser` 显式拒绝 `/allusers` 和既有 HKLM 安装，只允许 CurrentUser；
2. fresh install 才显示目录页；registered 重跑固定复用 HKCU `InstallLocation`，拒绝 `/D`；
   `/S /D` 在任何 fresh silent 路径都拒绝，不能静默搬家；
3. fresh 选择目录时只比较完整末段；末段不等于 `APP_FILENAME` 才追加，因此名称子串不会误判；
4. fresh 目标必须不存在或为空，并在 `CHECK_APP_RUNNING`、旧版卸载和产品写入前完成
   directory/reparse/writable 检查；
5. registered 目标必须同时匹配 HKCU `InstallLocation`、exact `UninstallString`、exact
   `QuietUninstallString`、`KeepShortcuts=true`、exact `ShortcutName`、exact/empty `MenuDirectory`、
   固定内容 stable marker、递归 exact 产品树清单、全树/祖先无 reparse 和可写检查；
   不再存在 Phase 5 N-1 自动迁移例外。任何 pre-Phase 7 已登记安装都 fail closed，并要求用户先运行
   其原卸载程序，再执行一次 Phase 7 fresh install；
6. 安装事务在任何 `SetOutPath $INSTDIR` 或产品写入前创建并回读固定 recovery marker；stable marker、
   HKCU registry 与落地 uninstaller 全部复验成功后才删除 recovery marker。中断后的非空目录只有在
   recovery marker、递归 exact 产品树清单、registry/path（如存在）和无 reparse 检查全部通过时才能恢复；
7. 安装与卸载从第一次 `CHECK_APP_RUNNING` 前开始持有按当前用户 SID 命名的 Global lifecycle mutex。
   升级调用旧卸载器时只在 `ExecWait` 边界释放，返回后立即重新获取并复核 canonical transaction/backup
   key；卸载器从 onInit 到进程退出均持有同一 mutex；
8. 应用进程检查使用 Toolhelp + `QueryFullProcessImageNameW` 的 native exact canonical path 比较，
   不调用 PowerShell/WMI、`taskkill` 或前缀匹配。成功终止后等待同一 process handle signaled；权限、
   枚举、路径解析和等待异常一律 fail closed。根目录完成 whole-root rename 后，再对 source/stage 两种
   image path 做一次 exact find；若应用在窗口中重启，则先回滚目录再失败；
9. 自定义安装目录目前只支持本机 fixed NTFS。UNC/network、removable、ReFS 和其他文件系统在产品
   mutation 前明确拒绝；这是 Phase 7 已实现并可验证的边界，不宣称跨文件系统原子性；
10. 卸载器在关闭应用前、删除节开始和 staging 前重复 registry + stable marker + 递归 exact 产品树清单 +
    全树/祖先无 reparse 检查。事务 claim 持久化后，只执行一次同父目录 whole-root
    `Rename(source, random-sibling-stage)`；没有逐文件搬运，也不递归删除 `$INSTDIR`；
11. 普通 product registry 原键保持可见，直到 HKCU Apps & Features 树之外的两个 `RegCopyTreeW`
    完整快照完成，并依次持久化 `registry-backups-ready` 与 `registry-delete-started`。原键删除后才写
    `committed-cleanup`。回滚重建并复验两个原键后，先持久化 `rollback-registry-restored`，再分别删除
    两个备份，因此进程崩溃可安全重放；
12. committed staging 按 direct Win32 enumeration 逐项删除 exact allowlist 内容，复验只剩 stable
    marker 后最后删除 marker，再证明空目录并执行非递归 `RMDir`。唯一 `RMDir /r` 只允许用于用户明确
    请求删除数据时的 APPDATA 精确直属叶目录，且删除前验证 parent/leaf、类型和全树无 reparse；
13. root 与 registry cleanup 完成后先持久化 `committed-postcleanup`，再重放 shortcut、AppUserModelId、
    shell notify 与可选 AppData cleanup，最后清 transaction。shortcut/AppData 以路径不存在回读为成功；
    AppUserModelId、空 Start Menu 目录和 shell notify 是幂等 best-effort，必须由 clean VM 观察验证。
    `fileAssociations` 当前未启用；启用前必须纳入 durable transaction，否则编译直接拒绝。

pnpm `patchedDependencies` 对锁定的 `app-builder-lib@26.15.3` 六个上游模板
`assistedInstaller.nsh`、`installer.nsi`、`installSection.nsh`、`uninstaller.nsh`、
`include/extractAppPackage.nsh`、`include/installUtil.nsh` 做定点 hook。配置强制
`differentialPackage: false` + `useZip: true`，使用会返回明确状态的 `nsisunz`，并让解压失败
nonzero 退出；正式载荷不再走会吞掉错误的 `Nsis7z`。`installUtil` 只消费预检缓存的 CurrentUser
uninstall/path/shortcut snapshot，不在 mutation 前重新读取 HKCU。
它仍不是完整自定义 `nsis.script`，继续保留 electron-builder 标准两遍 uninstaller 生成、独立签名、
嵌入和 installer 大小校验。

policy 按 electron-builder 26.15.3 的真实资源解析顺序审计 include，并绑定根 `package.json`、
`pnpm-workspace.yaml`、`pnpm-lock.yaml`、两个 patch 的 raw/normalized SHA-256、
electron-builder/app-builder-lib 的完整 package-owned 文件树及六个物理模板 SHA-256。根
`package.json` 不得覆盖 workspace patch policy；Fluent Icons 的补丁、安装后 `LICENSE` 和
runtime-license-to-notice generator 同样是 fail-closed gate。配置显式设置 `extends: null`，禁止
electron-builder 根据 app dependencies
隐式继承配置；`buildResources` exact set 只允许 audited `installer.nsh`，从而同时拒绝默认
messages/icon/license/sidebar 和 user NSIS plugin 注入。打包脚本直接执行已审计的根 CLI，不经 app cwd
的 `.bin`/PATH 查找，并在真正启动 builder 前第二次运行完整 policy。

policy 还拒绝 project fallback、`build/build/installer.nsh` shadow、symlink、隐式
`build/installer.nsi`、自定义 script/NSIS binary、app-local builder shadow、额外 target/architecture、
生命周期/sign hook 和安装权限覆盖。负向自检覆盖 config/include、patch、lock、依赖身份、完整文件树、
六个模板、plugin/messages 资源和 CLI 篡改。

当前新 hardening 源已完成的证据：

```text
NSIS 3.04 isolated installer/uninstaller macros against the installed patched templates
PASS

pnpm install --offline --lockfile-only
PASS

pnpm install --offline --frozen-lockfile --reporter=silent
PASS

Installed app-builder-lib physical package tree
PASS: 520 files / 75deec9892aee18ebea9b60157e39cc530bb1ff9de13d5ba787297b0d722cdb0

node tooling/packaging/phase5-electron-builder-policy.mjs --config apps/desktop/electron-builder.yml
PASS

node tooling/supply-chain/phase5-release-evidence-selftest.mjs
PASS

powershell -NoProfile -ExecutionPolicy Bypass -File tooling/packaging/phase7-installer-identity-selftest.ps1
PASS: 7/7; fail=0; notRun=0

pnpm phase7:installer-atomic-directory:selftest
PASS: MakeNSIS v3.04; probe exit=0; temp leaks=0

Six-template patch header/LF/apply check
PASS (exact six headers; CR=0; clean original apply-check exit 0)

Native exact-process runtime harness
BLOCKED: Microsoft Defender denied the unsigned NSIS harness; compile success is not runtime evidence

pnpm phase5:release:selftest
PARTIAL: embedded release-evidence selftest PASS; suite then stopped because this standard-user machine
cannot create the symlink required by the existing safe-delete negative harness
```

当前冻结的 source/overlay 身份：

```text
installer.nsh normalized sha256:
fcaf26d3407d2eb6244fce5411181985ac8877e9e0128cbc09df760f9e240448

app-builder-lib patch raw/normalized sha256:
94967619809c29ba46e4738c08bd5e0390e0c5df0dbf86e713d3ff8f319f44f7

installed app-builder-lib tree:
520 files / 75deec9892aee18ebea9b60157e39cc530bb1ff9de13d5ba787297b0d722cdb0
```

下列旧 spike 发生在本轮 P1 hardening 之前，只是历史记录，不能证明当前六模板 patch：

```text
Desktop-Translate-0.5.0-phase5-x64-setup.exe
size:   318,303,212 bytes
sha256: 1bb16cbe09d6e98d97004900647cfa8d9344cd8d1a80ec5179d76440ee8e19c0
```

该历史 spike 使用 `compression=store`、关闭 differential package 并排除了正式
`extraResources`。构建日志到达标准生成 uninstaller 的签名阶段，且没有完整自定义 script 导致的
`uninstaller is not signed by electron-builder` 警告；依赖收集明确记录 `pm=pnpm`。输出在记录哈希后
已从受控临时目录删除。它只证明旧标准模板和旧两行 patch 曾能完整编译，不代表当前六模板 hardening。
当前开发安装证据已经由下述第三版 exact installer 取代；历史字节仍不代表 Authenticode 或可发布候选。

## 2. Installer packages and real fresh-install evidence

第三版开发安装包：

```text
path:
artifacts/phase5/package/dist/Desktop-Translate-0.5.0-phase5-x64-setup.exe

size:
130,639,803 bytes / 124.59 MiB

sha256:
031968d94e2f0b73a2bffae38843806881940d919e10842ac76f31bb0906eaab

Authenticode:
NotSigned

source:
HEAD+WORKTREE:9dc2086ba44b7048fbd6d7b7b91e8549e71e4d44003488822277cfad96547a3e

formal package evidence:
artifacts/phase5/d117e4b1b4989157826aad1febc59bf49ee17539/
local-20260724T0948490501384Z-191f9979946b4a6d91f686f7583073d6

real fresh-install snapshot:
docs/phase7/evidence/m3-real-fresh-install-20260724.json
```

`phase5-package.ps1 -Mode Installer -SkipBuild -ManagedSandboxCompatibility` 对该 exact installer
完成开发打包门；evidence manifest 与 signature report 仍明确为 `RELEASE BLOCKED`，因为三个二进制均
未签名，且 managed-sandbox smoke 不能替代正常 Chromium sandbox 或 clean VM。

第三版修复了真实安装过程中暴露出的三个 installer runtime 问题：

1. fresh 目标叶目录尚不存在时，不再直接对完整 `$INSTDIR` 调用 `GetFullPathName`；先规范化已存在父目录，
   再重建 exact `APP_FILENAME` 叶目录；
2. writable probe 在使用 scratch register 前先保存调用者目录，避免进程 ID 覆盖被探测路径；
3. app 载荷尚未解压时，exact process image path 直接由已规范化安装根构造；文件存在后才尝试
   `GetLongPathName`，避免 pre-extraction 检查得到空路径。

同时，release-evidence selftest fixture 现在在每个隔离工程中创建 exact audited
`tooling/phase5-after-extract.mjs`，自检重新通过：

```text
[phase5:release-evidence:selftest]
exact-set, stale-hash, and strict CurrentUser assisted NSIS negative cases PASS
```

### 2.1 Real host fresh install

直接从 Codex packaged-app 子进程启动 installer 会落入 Windows packaged-app 文件/注册表虚拟化，因此该
路径只作为环境诊断，不计真实安装证据。有效流程改由 Windows Shell broker 启动同一 exact installer，
并在真实宿主环境完成：

1. assisted directory page 正常出现；
2. 选择父目录 `<USERPROFILE>\Desktop` 后，最终 exact 安装根为
   `<USERPROFILE>\Desktop\desktop-translate`；
3. 安装完成页明确报告成功；
4. 真实安装根存在 app、uninstaller 与固定 stable marker；
5. 当前只读复核得到：

   ```text
   marker:
   DesktopTranslate.InstallRoot.v1|5baab977-0efe-5c82-9f9c-b3786aa388e3

   HKCU product key:
   Software\5baab977-0efe-5c82-9f9c-b3786aa388e3
     InstallLocation = <USERPROFILE>\Desktop\desktop-translate
     KeepShortcuts = true
     ShortcutName = Desktop Translate

   HKCU Apps & Features key:
   Software\Microsoft\Windows\CurrentVersion\Uninstall\
     5baab977-0efe-5c82-9f9c-b3786aa388e3
     UninstallString =
       "<USERPROFILE>\Desktop\desktop-translate\Uninstall desktop-translate.exe" /currentuser
     QuietUninstallString =
       "<USERPROFILE>\Desktop\desktop-translate\Uninstall desktop-translate.exe" /currentuser /S

   Start Menu:
   Desktop Translate.lnk exists

   exact installed-root process count after diagnostic cleanup:
   0
   ```

这证明第三版的真实标准用户 custom-root fresh install 主路径已工作，但不扩大为以下未执行项：

- 默认目录、空格/中文目录、`D:`/`E:`、不可写目录和其他 filesystem 负测；
- registered 同版本重跑、升级、普通/Quiet 卸载、重装与 userData 语义；
- signed candidate、clean VM、已提权启动和 machine-wide/HKLM 负测。

一次较早的 packaged-app 虚拟化重跑曾在关闭旧进程/调用旧卸载器时失败；由于其 registry/root 不属于真实
宿主安装状态，不能作为 registered 升级结论。下一步必须针对上述真实 HKCU 安装，通过 Shell broker
重跑同一 installer，单独验证“跳过目录页并复用 exact `InstallLocation`”。

### 2.2 Installed-app startup boundary

真实安装根的应用可以创建 exact `桌面翻译悬浮球` 窗口，但本机 Codex managed Chromium 环境下，正常
`--enable-sandbox` Renderer 呈透明/不可命中；仅诊断性 `--no-sandbox --disable-gpu` 启动能看到 Ball。
后者不是可接受的生产启动方式，也不计正常 installed-app startup PASS。

诊断窗口又被 Codex/ChatGPT 顶层窗口遮挡，Computer Use 的安全 hit-test 将拖动落点判给 ChatGPT，而不是
Ball，因此没有注入点击或拖动。物理输入和 Computer Use 拖动继续保持 `NOT RUN`；不得用开发态
`SendInput` 证据替代。

### 2.3 Fourth installer package; registered upgrade not run

第四版开发安装包已经完成正式 package pipeline，但尚未启动真实 registered 升级：

```text
path:
artifacts/phase5/package/dist/Desktop-Translate-0.5.0-phase5-x64-setup.exe

size:
130,645,193 bytes / 124.593 MiB

sha256:
b9386b7bcfcffb8bf8e7e007986cd935e4f1ded02a5c5c7993bc8b57edbc04b3

Authenticode:
NotSigned

source:
HEAD+WORKTREE:801529a0ccccd7b9d7176214471013b3b3f0e2b02abfeb486195458a1cb77493

formal package evidence:
artifacts/phase5/d117e4b1b4989157826aad1febc59bf49ee17539/
local-20260724T1125328407951Z-221009c1c32c4654a5c5b39c63617f8f

installer.nsh normalized sha256:
77bd978d56c089c155be47b00a4e6787e64ba1edd403aad0d5e27e8cd4591ebf

app-builder-lib patch raw/normalized sha256:
94967619809c29ba46e4738c08bd5e0390e0c5df0dbf86e713d3ff8f319f44f7

installed app-builder-lib physical tree:
520 files / 75deec9892aee18ebea9b60157e39cc530bb1ff9de13d5ba787297b0d722cdb0
```

第四版针对第三版真实安装后发现的默认路径与 transaction-preparation 边界继续加固：

1. 仅当完整目标严格等于 canonical `$LOCALAPPDATA\Programs\${APP_FILENAME}`，且 `Programs` 以
   `ERROR_FILE_NOT_FOUND`/`ERROR_PATH_NOT_FOUND` 缺失时，记录 `create-default-programs` 计划；
   任意缺失的自定义 parent 仍 fail closed；
2. 目录页/preflight 不创建目录；只有 `CHECK_APP_RUNNING`、旧版卸载和 lifecycle boundary 通过后，
   才用 exclusive `CreateDirectoryW` 创建 exact 默认 `Programs` 与产品根；
3. preparation recovery marker 使用 `CreateFileW(CREATE_NEW, shareMode=0)`，写入、flush 和失败清理由
   同一 exclusive handle 完成；registry commit 失败后保留已提交 marker/root 供下次恢复；
4. preflight writable probe 也改为 exclusive handle ownership 与
   `SetFileInformationByHandle(FileDispositionInfo)` 清理，不再 `FileOpen w` 或 pathname delete；
   transaction root 中重复的固定路径 probe 已删除，由随后 exclusive recovery marker 提供更强写入证明。

本轮实际门禁：

```text
electron-builder policy: PASS
release-evidence negative selftest: PASS
NSIS compile + package allowlist/ASAR/resources/hashes/budgets: PASS
isolated managed-sandbox startup/resource smoke: PASS
lint: PASS
typecheck: PASS
tests: 432/432 PASS; desktop 34/34 files

package status:
UNSIGNED DEVELOPMENT PACKAGE PASS / RELEASE BLOCKED

REAL REGISTERED UPGRADE:
NOT RUN

UNINSTALL:
NOT RUN

RENAME/PATH-DELETE RACE:
NOT RUN / OPEN P2
```

结构化 package 快照见
[m3-fourth-installer-package-20260724.json](evidence/m3-fourth-installer-package-20260724.json)。

### 2.4 Fifth installer identity package

第五版仅关闭 fresh-directory/marker lifecycle 的定向 identity P2，不宣称 registered upgrade、
uninstall 或最终发布通过：

```text
path:
artifacts/phase5/package/dist/Desktop-Translate-0.5.0-phase5-x64-setup.exe

size:
130,650,207 bytes / 124.598 MiB

sha256:
25a87d19ad7d2d2e5c887d94216f14de10ee61971deac3cbdded72b5a27eaa7a

Authenticode:
NotSigned

source:
HEAD+WORKTREE:2eb074a29b2b5e9019d1385d4cf504fea12a27e82d0db0595be69a4afeb0974c

formal package evidence:
artifacts/phase5/d117e4b1b4989157826aad1febc59bf49ee17539/
local-20260725T0205184365724Z-2f1e3f67329f49919b60bd7f5a9fe531

installer.nsh sha256:
fcaf26d3407d2eb6244fce5411181985ac8877e9e0128cbc09df760f9e240448

package status:
UNSIGNED DEVELOPMENT PACKAGE PASS / RELEASE BLOCKED
```

第五版 identity-bound 实现与证据：

1. existing parent 以 `FILE_SHARE_READ|FILE_SHARE_WRITE`、不含 `FILE_SHARE_DELETE` 的 directory handle
   持有；leaf 只由 parent-relative `NtCreateFile(FILE_CREATE|FILE_DIRECTORY_FILE|
   FILE_OPEN_REPARSE_POINT)` 原子创建；
2. fresh parent/root 保存 volume serial 与 file-index；failure rollback 在原始 handle 上复验 identity，
   再用 `SetFileInformationByHandle(FileDispositionInfo)` 非递归删除，不再 pathname `RMDir`；
3. stable marker 使用 `OPEN_ALWAYS` 的同一 exclusive handle 区分新建/既有，既有内容不截断；recovery
   marker 以 `CREATE_NEW` 或 recovery `OPEN_EXISTING` 的同一 exclusive handle 持有到 commit，失败与
   commit 都只对该 handle disposition；
4. policy/evidence 负向 mutation 明确拒绝 transaction/recovery failure wrapper 中的 pathname
   `Delete/RMDir`，以及 registry/extraction 或 installed-identity verification 前的 marker early close；
5. 标准用户 runtime selftest 7/7：directory lease、child recovery marker 阻止 whole-root
   rename/replacement、empty/nonempty disposition、exclusive marker、hardlink 与 reparse exact-name
   语义全部通过；child marker 持有时 whole-root rename/replacement 精确拒绝为 Win32 `5/5`，关闭后
   控制组 rename 成功；
6. checked-in x86 MakeNSIS probe 以 v3.04 `/WX` 编译并在标准用户 token 运行，验证
   `UNICODE_STRING`/`OBJECT_ATTRIBUTES`/`IO_STATUS_BLOCK`/4-byte `PHANDLE` marshalling、relative
   `NtCreateFile` collision/no-delete-share 和 handle disposition：47,447 bytes，
   sha256 `5d2f54620cd637895403e732a0d0291fc10242775a7934804d78f1406f990c3d`，
   exit `0`，probe/runner temp leaks `0`；
7. `lint`、`typecheck`、432/432 tests、electron-builder policy、release-evidence negative selftest、
   NSIS compile、package allowlist/ASAR/resources/hashes/budgets、供应链、隔离 packaged startup/resource
   smoke 与零残留产品进程通过。

结构化 package 快照见
[m3-fifth-installer-package-20260725.json](evidence/m3-fifth-installer-package-20260725.json)。

第五版没有把 committed uninstall staging 改成 handle-relative tree protocol。该路径仍以 pathname
枚举/删除 allowlist tree、stable marker 和 empty root；它与真实 registered/ordinary/Quiet uninstall、
故障注入和 clean VM 一起继续保留在 `P7-R-020`，不能由本节的 fresh/marker PASS 代替。

### 2.5 Old-install recovery and absent-stage transaction-path fix

2026-07-25 的真实宿主状态先出现两棵正常 HKCU 身份键缺失，而旧安装根、stable marker、uninstaller
与 Start Menu shortcut 仍完整。按第三版 fresh-install 证据恢复 exact 五个值并回读一致后，旧
uninstaller 已越过 “installation registry is missing” 检查，但在 root staging 前确定性失败：

```text
The Phase 7 uninstall transaction paths are invalid.
```

根因是 `GetFullPathName` 被用于尚未创建的随机 staging 目录；NSIS v3.04 对不存在的最终 path 返回空。
同一 validator 还会在 atomic rename 后错误要求已不存在的 source 可被完整路径规范化。现在
`phase7PrepareAtomicRootStage` 只规范化 verified registered source 与现存共同父目录，validator 从
canonical parent 重建并比较 exact source/stage leaf，同时单独处理 `GetParent(C:\leaf) -> C:`，
不再对可能不存在的 transaction root 调用 `GetFullPathName`。

旧 uninstaller 本身无法完成卸载后，按用户明确要求，在重新验证 exact root/leaf、stable marker、
known entries、全树无 reparse、零相关进程和 shortcut exact target 后，将旧安装根与 shortcut 移入
Windows 回收站。最终只读快照为：root/shortcut/正常 registry/transaction/backup/stage/process 全部
不存在；userData SQLite 仍存在，前后 SHA-256 均为
`C271733515016181C06EBDC011E96BFA6223F1F24AB9B0625BA3C11B44A45420`。updater cache 保留，未扩大
为用户数据清理。

定向修复门禁：

```text
pnpm phase7:installer-transaction-path:selftest
PASS: exact validator macro; MakeNSIS v3.04; valid 4; rejected 11; exit 0

electron-builder policy
PASS

installer compile-chain
6/6 PASS

release-evidence negative selftest
PASS

pnpm phase5:release:selftest
PASS; signing/release remains BLOCKED
```

本轮遵从用户指示，没有构建或运行新的第七版 candidate。现场五个恢复值在 path error 后再次消失，
但静态调用图证明该 error 分支本身不会删除它们；写入者仍未归因，因此不得把它记录为已解释的产品行为。
本节也不把 recovery removal 误记为普通/Quiet uninstaller PASS。完整结构化记录见
[old-install recovery/path-fix evidence](evidence/m3-old-install-recovery-and-path-fix-20260725.json)。

### 2.6 Current candidate registry durability and interactive/Quiet uninstall

当前候选
`Desktop-Translate-0.5.0-phase5-x64-setup.exe`（130653975 bytes，
SHA-256 `2912D3CC60AA521EE71A92BCCACF51713F96CF41EFF5000CEA08CB714B69BAE9`）
先通过完整 package pipeline、embedded current-uninstaller compile-chain、allowlist/ASAR/resources、
isolated startup 与 evidence gates。最终仍因未签名保持 `RELEASE BLOCKED`。

Computer Use 从 Codex packaged app 直接启动 installer 的路径再次表现出已记录的 packaged-app
filesystem/registry virtualization：文件与 marker 可见，但该子进程结束后 canonical host HKCU 身份
不可见。该路径继续拒绝作为产品安装证据。随后使用普通 CurrentUser host 进程执行
`/S /currentuser`，连续两轮均得到 installer exit `0`，并在 canonical host HKCU 读回：

```text
InstallLocation = <USERPROFILE>\AppData\Local\Programs\desktop-translate
KeepShortcuts = true
ShortcutName = Desktop Translate
UninstallString = "...Uninstall desktop-translate.exe" /currentuser
QuietUninstallString = "...Uninstall desktop-translate.exe" /currentuser /S
```

第二轮使用落地 uninstaller 执行 `/currentuser /S`，精确源码命名的 transaction/stage 采样为：

```text
0 ms    product=1 uninstall=1 transaction=0 backup=0 source=1 stage=0
1720 ms product=1 uninstall=1 transaction=1 backup=0 source=0 stage=1
2314 ms product=1 uninstall=1 transaction=1 backup=1 source=0 stage=1
2327 ms product=0 uninstall=0 transaction=1 backup=1 source=0 stage=1
2521 ms product=0 uninstall=0 transaction=1 backup=0 source=0 stage=0
2667 ms product=0 uninstall=0 transaction=0 backup=0 source=0 stage=0
```

original uninstaller exit 为 `0`。最终 canonical product/uninstall/scratch/transaction/claim/backup
registry、source root、stage、Start Menu shortcut、Desktop shortcut 与相关进程全部不存在。
userData SQLite 在第二轮 Quiet uninstall 前后 SHA-256 均为
`8238256649C22CC231D60860C61D52FC5651A2CFD27C535D33C202D5DECD8EE2`。

随后通过普通 Windows Shell broker 启动同一 exact candidate，并只在其正常 process-backed
窗口出现后使用可访问性快捷键操作。安装向导明确显示“已安装在你的系统”；完成页仍打开时，默认
install root、stable marker、两个 canonical host HKCU key、五个注册值及落地 uninstaller
`203933 bytes / 68EB7AE43BB22CE920B5A2D19810AE6B3E2E954FE1021AE20CF49E194D93040A`
全部复验一致。再由 Shell broker 启动落地 uninstaller，实际卸载窗口映像为
`<USERPROFILE_8DOT3>\AppData\Local\Temp\~nsu.tmp\Un_A.exe`，即 NSIS Temp self-copy；其字节与
落地 uninstaller 完全一致。向导明确显示“已从你的计算机解除安装”。关闭向导后，安装根、两个
canonical registry identity、scratch/transaction/claim/backup、stage、快捷方式及产品/卸载进程均
不存在，userData SQLite 前后 SHA-256 仍为上述值。NSIS Temp self-copy 文件本身在进程退出后仍留在
`%TEMP%\~nsu.tmp\Un_A.exe`，因此不把它误记为 NSIS 自动清理。host 拒绝永久删除后，对该无 reparse、
只含停止且 hash-matched 文件的 exact Temp 目录做了二次验证，并将其移入 Windows 回收站；最终原路径
不存在且可从回收站恢复。它不是安装根、注册项、快捷方式、事务、stage、backup 或运行进程。

完整结构化记录见
[registry/interactive-and-Quiet-uninstall evidence](evidence/m3-registry-quiet-uninstall-fix-20260725.json)。

仍未完成：

- 最终 signed installer 的 clean-VM 标准用户 fresh install、中文/空格自定义目录、不可写目录安全失败；
- 自定义 `D:`/`E:` 目录的安装、真实 registered 重跑、升级，以及同父目录 whole-root staging/rollback；
- 注入未知文件/空目录、忙碌文件、恶意 `ShortcutName`/`MenuDirectory` traversal、registry ACL、
  marker 写入/删除失败、whole-root rename/marker-last cleanup 失败后的零越界删除、进程崩溃恢复、
  外置 registry snapshot 状态与目录/注册表快照对比；
- `CHECK_APP_RUNNING` 完成瞬间反复启动 Electron 的并发压力测试，以及主 Electron 被终止后
  Selection Host 是否及时退出；已提权 exact app/同名不可检查进程必须 fail closed；
- update 确认运行映像为 electron-builder plugin copy；直接从安装根以 `_?=$INSTDIR` 禁止 self-copy 的
  负测必须 nonzero，并在 rollback 后保持 registry 与安装根快照完整；
- 已提权启动、`/allusers`、`/S /allusers`、`/S` + 预置 HKLM 的无 UAC/无 HKLM 验证；
- 升级、重复安装、无 `elevate.exe` 和零残留进程；
- 安装后落地 uninstaller 的 Authenticode（最终签名 RC 不能只验证 setup）；
- 最终字节签名与 clean VM。

已知边界：

- Phase 7 不迁移或删除历史 machine-wide 安装；旧 HKLM 安装若真实存在，需要用户先显式卸载；
- Phase 7 也不自动接管已登记的 pre-Phase 7 HKCU 安装。当前只有开发者本人使用过旧未签名安装包，
  因此首个 Phase 7 安装前执行一次明确的“旧版卸载 → Phase 7 fresh install”，不接受路径/文件指纹猜测；
- recovery marker 只恢复 Phase 7 自己已开始但未完成的安装事务，不是旧版迁移通道；
- committed staging 必须同步清理为 `clean`；标准用户路径不宣称或依赖重启后删除。commit 前失败会
  回滚完整安装与 registry；commit 后失败会保留 canonical transaction 并在下次启动重放，但普通
  product registry 已按 committed 语义删除；
- 文中的 “durable/replayable” 只表示进程崩溃边界。实现没有调用 `RegFlushKey`，不宣称突然断电后的
  掉电一致性；
- 早期把 registry backup 暂存在 Apps & Features 并写 `SystemComponent` 的原型已弃用。Defender
  历史仍包含对多个未签名 NSIS 测试体（包括新源码 harness）的 PUA/Access denied 记录；不得把源码编译
  当成安全扫描通过，必须对最终签名候选在 clean VM 重新扫描与运行；
- `/S /allusers`、registry/marker/reparse 错误必须在 `un.checkAppRunning` 前拒绝，不得先关闭应用、
  触发 UAC 或产生 machine-wide 变更。

### 2.7 Sixth candidate handle-relative committed uninstall

第六版把上一版仍开放的 committed staging pathname identity P2 改为独立 handle-relative
protocol。事务版本升级为 `DesktopTranslate.UninstallTransaction.v2`，在 whole-root rename 前捕获
source root 的 volume serial 与 file index，claim、canonical transaction、状态迁移、rollback 和 crash
read 全部回读同一 durable identity。Committed cleanup 只打开一次 stage root，禁止
`FILE_SHARE_DELETE`，并在该 root handle 上相对打开 stable marker、固定 allowlist 文件和目录；删除只对
已打开 handle 设置 `FileDispositionInfo`。Marker 始终持有 exclusive lease 并最后删除，root 只有在
exact empty 后才由原 handle disposition。该路径不再调用 pathname `Delete`、pathname `RMDir` 或递归
删除。

定向门禁结果：

```text
pnpm lint
PASS

pnpm typecheck
PASS

pnpm test
PASS: 432/432

pnpm phase5:release:selftest
PASS; release remains BLOCKED

pnpm phase7:installer-identity:selftest
PASS: 9/9

pnpm phase7:installer-atomic-directory:selftest
PASS: MakeNSIS 3.04; exit 0; leaks 0

pnpm phase7:installer-transaction-path:selftest
PASS: valid 4; rejected 11; exit 0

electron-builder two-pass NSIS compile and full package pipeline
PASS
```

Exact unsigned candidate：

```text
path:
artifacts/phase5/package/dist/Desktop-Translate-0.5.0-phase5-x64-setup.exe

bytes:
130711653

SHA-256:
A52C767FFFBEA90ACB884B56209FA741AADF982B473ED514DF69D91483A22FFA

source identity:
HEAD+WORKTREE:b4e26d0100abe40a1a3439acbd02f92ddadaae7bfcff8ebfe4ed0fe00b511f69

Authenticode:
NotSigned / RELEASE BLOCKED
```

普通 CurrentUser host 上的 fresh install、两次已登记同版本重跑和最终 Quiet uninstall 均为
installer/bootstrap exit `0`；每次重跑的 `InstallLocation`、`KeepShortcuts`、`ShortcutName`、
`MenuDirectory`、`UninstallString`、`QuietUninstallString`、`DisplayVersion` 快照逐字不变，且没有
transaction、backup、stage 或产品进程。最终正常卸载后 root、两个 canonical registry key、
transaction、backup、stage、shortcut 与产品/卸载进程均为零，userData SQLite 前后 hash 一致。

真实负测另行区分 NSIS 两层退出语义。官方 NSIS
[Error Levels](https://nsis.sourceforge.io/Docs/AppendixD.html) 明确说明：落地 uninstaller 会先复制到
Temp，原始 launcher 的 error level 只表示复制启动是否成功；要取得事务本身的 error level，必须显式
复制 exact uninstaller 并以 `_?=<INSTALL_ROOT>` 运行。实测结果为：

- root 内直接添加未知 regular file：Temp inner exit `1`，未知文件、root、registry 全部保留；
- root 内直接添加未知空目录：Temp inner exit `1`，未知目录、root、registry 全部保留；
- 从 root 内以 `_?=<INSTALL_ROOT>` 禁止 self-copy：exit `1`，root entry count、marker/app/uninstaller
  hashes、registry、transaction 和 stage 全部不变；
- 已知 `version` 文件保持 read-only handle 且不允许 delete-share：Temp inner exit `1`，whole-root rename
  未发生，marker/file hashes 与两个 registry key 完整，transaction/backup/stage 为零；释放 handle 后以
  同一 Temp copy 重放 exit `0`，root/registry/transaction/backup/stage 全部收净且 userData hash 不变；
- 上述未知项负测直接启动注册的原始 launcher 时 outer exit `0`，但 inner exit `1` 且产品状态完整保留；
  这是 NSIS 固定 bootstrap 语义，不记录成产品事务 exit `0`。

同一候选安装后的 Ball 可访问性树报告“划词取词监听中”，startup 通过；但 Codex 点击命中仍落在
ChatGPT 窗口，未取得点击或 graceful UI exit 证据。进程通过 exact PID 强制收净，不能写成正常产品
退出。完整结构化记录见
[sixth handle-relative uninstall evidence](evidence/m3-sixth-handle-relative-uninstall-20260725.json)。

随后使用源码定义的正确 stage 前缀
`.desktop-translate-stage-5baab977-0efe-5c82-9f9c-b3786aa388e3-*` 做真实 post-commit fault replay：
whole-root rename 出现后立即打开 `stage\version`，允许 read 但拒绝 delete-share。Temp inner exit `1`；
source 与两个普通 registry key 已按 commit 语义消失，stage 保留 24 个尚未清理条目，
transaction=`committed-cleanup`，durable root identity 与外置 backup 完整。释放 handle 后，同一 exact
installer `/S /currentuser` exit `0`，先重放 root/postcleanup，再完成 fresh install；transaction、
backup、stage 清零，canonical registry、stable marker 和 userData hash 正常。最终 inner uninstall
exit `0`，正确前缀 stage count 为零。

初轮现场采样曾错误使用旧 pattern `.desktop-translate.phase7-uninstall-*`。结构化证据已删除由该 pattern
产生的逐步 count，并以源码常量重做最终 audit 与 post-commit replay；不得引用旧 pattern 的零计数。

该结果关闭 committed-stage pathname identity 定向实现项，并补齐默认目录已登记同版本重跑及一条真实
post-commit deletion-failure replay；当时仍未覆盖逐 checkpoint 的 process-kill crash。下一节已补齐
10 个 durable state 的真实进程终止/重放；下一节后的 canonical product-key `Deny Delete` 也已在
mutation 前 fail closed。`P7-R-020` 仍不解除，因为其余 ACL、mid-operation partial registry、
marker/shortcut、volume/reparse 完整矩阵、clean VM、签名落地 uninstaller、正常
installed-app 交互退出和物理输入仍开放。

### 2.8 Durable checkpoint process-kill crash matrix

新增
`tooling/packaging/phase7-installer-crash-matrix.ps1`，用外部 64-bit HKCU registry watcher 观察真实
transaction state；watchdog 只终止本轮明确启动的 exact PID，不修改 installer/uninstaller 源码，
production include 中也没有 fault hook。每轮从安装根复制 exact landed uninstaller 到自有 TEMP 目录，
以 `_?=<INSTALL_ROOT>` 运行，捕获状态后强制终止；随后由同一 exact installer
`/S /currentuser` 恢复并复验七项 registry snapshot、stable marker/app/uninstaller hash、userData
SQLite hash、transaction、backup、stage 与残留进程。

静态门禁与真实矩阵：

```text
pnpm phase7:installer-crash-matrix:selftest
PASS: 10 unique durable checkpoints; production fault hook absent

phase7-installer-crash-matrix.ps1 -MaxAttemptsPerCheckpoint 4 -RemoveFinalInstall
PASS: 10/10; committed-cleanup caught on attempt 2; all others on attempt 1
```

最终同源候选：`130,711,786` bytes，SHA-256
`ED7B27731FBAA0F823DD82B3C351B8A6E24E604EC3CFD35F5E1BDB73B19107C8`，Authenticode
`NotSigned`；formal package evidence 为
`artifacts/phase5/9870bbdf1f509e5270bdc72d10a13e658f9d9358/`
`local-20260725T1411226132501Z-90df4218af3a4d0da613d9cb3f8bd855`。

真实终止状态：

| checkpoint | 被终止进程 | crash 后权威布局 | 同候选恢复 |
|---|---|---|---|
| `prepared` | uninstaller | source + 两个 product registry；无 backup/stage | PASS |
| `staged-uncommitted` | uninstaller | stage + 两个 product registry；source absent | PASS |
| `registry-backups-ready` | uninstaller | stage + originals + complete backups | PASS |
| `registry-delete-started` | uninstaller | stage + complete backups；originals 可仍存在 | PASS |
| `committed-cleanup` | uninstaller | stage + backups；source/product registry absent | PASS |
| `committed-postcleanup` | uninstaller | root/registry/backups/stage absent；transaction final artifact | PASS |
| `rollback-pending` | installer recovery | source + product registry；无 backup/stage | PASS |
| `rollback-backups-ready` | installer recovery | stage + originals + backups | PASS |
| `rollback-rebuild-ready` | installer recovery | stage + rebuilt originals + backups | PASS |
| `rollback-registry-restored` | installer recovery | source + restored originals + backups | PASS |

每次恢复后 registry 与三项 installed-file hash 逐字一致，userData SQLite SHA-256 始终为
`8238256649C22CC231D60860C61D52FC5651A2CFD27C535D33C202D5DECD8EE2`，transaction/backup/stage/
相关进程均为零。矩阵结束后使用 exact inner uninstaller 正常收净；安装根和 product registry 不存在，
userData hash 不变。结构化摘要见
[durable checkpoint crash matrix](evidence/m3-durable-checkpoint-crash-matrix-20260725.json)。

这关闭的是 10 个已定义 durable state 的进程崩溃重放，不是掉电一致性，也不代替同一状态内部的
partial registry copy/delete、其余 ACL、marker/shortcut、volume/reparse、clean VM 和最终签名候选矩阵。

### 2.9 Canonical registry ACL fail-closed

真实 `Deny Delete` 故障最初暴露出一个可收敛性缺陷：旧实现先由 `RegCopyTreeW` 备份 canonical
product registry，受限 ACL 会随树复制到 backup；卸载回滚恢复该树后，backup cleanup 可能停在
`rollback-registry-restored`。现场未发生数据丢失，恢复原 ACL 后同一 installer 已收敛；随后将拒绝点
前移到任何 app-stop、transaction、backup、stage 或文件写入之前。

`phase7ProbeExistingRegistryKeyLifecycleAccess` 现在对两个既有 canonical key 以 `RegOpenKeyExW` 探测
完整生命周期权限：default build 使用 `0xF023F`，APP_64/ARM64 使用 `0xF013F`，随后立即
`RegCloseKey`，宏内禁止 mutation。`customUnInit` 的固定顺序为 root identity → product key ACL →
uninstall key ACL → `un.checkAppRunning`；policy 与 release-evidence negative selftest 同时锁定宏内容、
权限常量、无 mutation 和 pre-check-app-running 调用顺序。

最终同源 unsigned candidate
`ED7B27731FBAA0F823DD82B3C351B8A6E24E604EC3CFD35F5E1BDB73B19107C8` 的标准用户真机结果：

```text
install exact candidate: PASS
inject current-user Deny Delete on canonical product key: PASS
exact landed inner uninstaller exit: 1
registry snapshot equal: true
installed files + userData snapshot equal: true
transaction / backup / stage / related process: 0 / 0 / 0 / 0
restore original ACL + normal exact inner uninstall exit: 0
final install root / product registry / uninstall registry: absent / absent / absent
```

结构化摘要见
[registry ACL fail-closed](evidence/m3-registry-acl-fail-closed-20260725.json)。此结果只关闭 canonical
product key 的 current-user `Deny Delete` 排列；uninstall key、backup key、partial copy/delete、
marker/shortcut ACL、clean VM 与 signed candidate 仍开放。

## 3. Ball automated gates

实现结果：

- 旧 `{ displayId, edge, verticalRatio }` 读取时继续兼容；新版本原子双写 legacy
  `ui.ball.anchor` 与 tagged `ui.ball.anchor.v2`。读取优先级不再依赖可回拨 wall clock：
  只有两行 `updated_at` 完全相同且 legacy projection 一致时才证明来自同一原子双写并选择 v2；
  时间戳或 projection 任一不同都视为 N-1 的后续 legacy 改写并选择 legacy；
- `edge` 持久化 `edge + verticalRatio`；
- `free` 持久化 `horizontalRatio + verticalRatio`；
- 拖动只在 Windows `moved`（交互移动结束）后吸边/保存，不用连续 `move` 打断拖动；
- 启动时若发现 `edgeSnap` 与 anchor mode 分裂，或 displayId 已失效，会把归一化后的 anchor
  重新持久化，不只修正本次运行内存；
- 退出开始时先移除 native `moved` listener、采集最终 BrowserWindow bounds，再冻结移动输入并等待
  最终 position-write tail；数据库只在该 tail 和 Native Host shutdown 都 settled 后关闭；
- 显示器失效、负坐标、多屏和 ratio clamp 有定向回归；
- 56 DIP 窗口保留 44 DIP 按钮，并增加可见的 30×8 DIP 顶部拖动把手；按钮保持 `no-drag`。

仓库级验证：

```text
pnpm lint
PASS

pnpm typecheck
PASS

pnpm test
432/432 PASS
  application 13
  contracts 42
  storage 17
  translation 22
  desktop 338

pnpm --filter @desktop-translate/desktop phase2:smoke
3/3 PASS
```

## 4. Development-build Electron automation evidence

环境：

- Windows 11 Pro build 26200，x64
- 1920×1080，device scale factor 1
- Electron 43.1.1 development build
- Intel Core i3-10100F，16 GiB RAM

执行过程：

1. Computer Use 观察到真实 56×56 Electron Ball 窗口及“按住上方把手拖动悬浮球”的可访问结构；
2. 通过真实设置窗口关闭“自动吸附屏幕边缘”；
3. Windows `SendInput` 在 Ball 顶部 drag region 执行 mouse down → 连续 move → mouse up；
4. 原生窗口从 `(1600, 300)` 移至 `(1745, 445)`，随后再次移至 `(1803, 542)`；
5. SQLite 写入：

   ```json
   {
     "mode": "free",
     "displayId": "3865486607",
     "horizontalRatio": 0.9733695652173913,
     "verticalRatio": 0.5567226890756303
   }
   ```

6. 拖动后窗口列表仍只有 Ball，设置窗口没有被误触发；
7. 完整停止开发进程并重新启动，Ball 精确恢复至 `(1803, 542)`；
8. 重启后点击 Ball，设置窗口正常打开；
9. 测试结束后通过产品 UI 恢复 `edgeSnap: true` 并重置为右侧默认 anchor：

   ```json
   {
     "mode": "edge",
     "displayId": "3865486607",
     "edge": "right",
     "verticalRatio": 0.6
   }
   ```

10. 停止开发进程后，工作区 Electron residual process count 为 `0`。

后续一次 Computer Use 输入复核再次识别到 exact Ball 窗口，但透明 Electron 窗口的 hit-test 将点击/
拖动落点判给其后的 Codex 窗口，控制器按安全策略拒绝注入。该次运行只计“窗口/可访问结构观察”，
不计拖动 PASS，也没有替代上面的 Win32 `SendInput` 结果。

证据边界：

- `SendInput` 是操作系统级自动化输入，不是人的物理鼠标或触控板；
- 当前只有单显示器、100% DPI 的开发态实机结果；
- 物理鼠标、物理触控板、混合 DPI、负坐标多屏、热插拔仍保持未验收。

## 5. M3 exit status

代码、契约、持久化、开发态 Electron 自动化拖动、重启恢复、第三版真实宿主 custom-root fresh install、
第五版 fresh-directory/marker identity-bound gates、第六版 committed-stage handle-relative protocol，
以及当前候选默认 CurrentUser install、已登记同版本重跑、普通/Quiet uninstall 达到
`DEVELOPMENT PASS`。10 个 durable checkpoint 的 process-kill crash/recovery 与 canonical
product-key `Deny Delete` 的 pre-mutation fail-closed 已完成；M3 的最终退出条件尚未满足：同一
checkpoint 内的 partial registry/其余 ACL 故障、完整目录/volume/reparse/进程竞态矩阵、
delete-AppData、跨版本升级、clean VM、正常 installed-app 交互退出、物理鼠标和物理触控板证据仍然开放。
