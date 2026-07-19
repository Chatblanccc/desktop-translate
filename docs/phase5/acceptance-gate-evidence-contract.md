# Phase 5 acceptance gate evidence contract

`phase5:acceptance-decision` 为 43 个冻结 gate 同时登记 envelope policy 和 source-validator disposition。
决议中的每个 `PASS` gate 必须引用一份
独立的 JSON envelope；普通报告、只含 `status: PASS` 的 JSON、开发 smoke 或另一 gate 的 envelope 都会
fail closed。

每份 envelope 必须精确包含：

- `schemaVersion: 1`、`phase: 5`；
- 与冻结项完全一致的 `gateId`、`evidenceClass`、`externalEvidence`；
- `status: PASS`、`acceptance: true`；
- 与候选完全一致的 `candidate.gitSha` 和 `candidate.artifactSetDigest`；
- 该 gate 唯一的 `validator.id`、`version: 1`；
- 该 gate 策略要求的精确 `claims`，不得缺字段或增加字段；
- 按冻结顺序列出的 `sources`；每个 source 精确包含 `role`、`mediaType`、workspace 内相对 `path` 和
  小写 SHA-256。

工具会拒绝 workspace 外路径、链接/reparse 路径、非普通文件、hash 不匹配和媒体类型不匹配；先读取并验证
所有 envelope/source，再对相同路径与 hash 做第二次复核。验收开始前和全部证据读取完成后还会分别从真实
Git 仓库读取 `HEAD` 与完整 worktree 状态。两次都必须等于 `candidate.gitSha` 且干净；CLI 不提供覆盖或
跳过 Git 检查的参数。

envelope 验证通过后仍不能直接形成 PASS。结构解析、source 字段重算、阈值和候选 hash 比对只能发现不一致，
不能证明报告来自真实运行、系统验签或独立密码学验证。当前 43 个冻结 gate 的生产 source validator 均明确产生
`GATE_SOURCE_VALIDATOR_NOT_IMPLEMENTED`；满足 envelope claims、相互 hash 绑定甚至内容完全自洽的 synthetic JSON
也不能被用作正式批准证据。测试专用 override 只存在于进程内单元测试，CLI 不暴露绕过参数。

未来接入 `WP3-PERF-03` 可信 validator 时，除正式 `phase5-perf03-summary-v1`、固定实验室 3×100、候选
final manifest/clean-download hash 外，还必须独立验证终态 summary 隐私扫描、受保护运行来源和 exact artifact。
未来接入 `WP3-PERF-08` 可信 validator 时，必须验证真实 Provider、每类故障的实际控制机制与时间窗、恢复边界，
而不能只信 aggregate child digest、场景字符串、`faultControlId` 或 run metadata 自报字段。

五个 `CRYPTOGRAPHIC` gate 未来必须在结构绑定之外，针对 exact artifact bytes 调用操作系统 Authenticode/链与
时间戳验证，并对 artifact/manifest DSSE bundle 使用独立获取的 trusted material 做离线验签，再从独立下载
复算整个 artifact set。角色合并签字只批准 canonical payload，不能替代上述密码学、fixed-lab、Provider、
clean VM 或硬件证据。
