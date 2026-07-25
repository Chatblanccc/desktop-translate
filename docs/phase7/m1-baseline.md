# Phase 7 M1 基线记录

- 记录日期：2026-07-23
- 基线分支：`origin/main`
- 基线 commit：`d117e4b1b4989157826aad1febc59bf49ee17539`
- 基线 tree：`850aa5f6c9f33a3b741b6834884651f860f4f63d`
- Phase 7 分支：`codex/phase7-first-beta`
- Phase 7 分支起点：与上述 live `origin/main` 完全一致
- M1 结论：`REMOTE WINDOWS BASELINE PASS / LOCAL CLEAN PRECHANGE PASS NOT ESTABLISHED`

## Git 边界

开始 M1 时，工作区位于 `codex/phase4-online-translation` 且 `git status --short --branch` 无文件改动。
只读祖先检查确认该分支 HEAD 已包含在 live `origin/main` 后，才从 live main 创建
`codex/phase7-first-beta`。没有 stash、reset、覆盖或带入无关本地文件。

以下命令在分支创建时返回同一个完整 SHA：

```text
git ls-remote origin refs/heads/main
git show -s --format=%H d117e4b1b4989157826aad1febc59bf49ee17539
```

## Live main Windows CI

以下 GitHub Actions 均精确绑定基线 commit，而不是本地 tracking ref 推断：

| Workflow | Run | 结论 |
|---|---|---|
| Phase 1 Windows | [29847408989](https://github.com/Chatblanccc/desktop-translate/actions/runs/29847408989) | `success` |
| Phase 2 Windows | [29847408716](https://github.com/Chatblanccc/desktop-translate/actions/runs/29847408716) | `success` |
| Phase 3 Windows | [29847408920](https://github.com/Chatblanccc/desktop-translate/actions/runs/29847408920) | `success` |
| Phase 4 Windows | [29847410259](https://github.com/Chatblanccc/desktop-translate/actions/runs/29847410259) | `success` |
| Phase 5 Windows | [29847409051](https://github.com/Chatblanccc/desktop-translate/actions/runs/29847409051) | `success` |

## 本地基线边界

第一次本地 `phase5:verify` 在 TypeScript 阶段因切换分支后本机 `node_modules` 仍缺少锁文件已经声明的
`@fluentui/react-icons` 而停止。`pnpm install --frozen-lockfile` 后依赖恢复，但此时 M2/M3 的并行开发已经
开始，因此没有把后续 dirty-worktree 验证冒充成“改动前 clean local baseline PASS”。

基线 commit 的正式 Windows 自动化依据是上表五条 live CI。Phase 7 工作树上的验证单独记录，不反向改写
M1 基线结论。

## 继承边界

- Selection Host 继续负责 UIA-first / Windows OCR fallback，不负责翻译或 Provider 网络。
- Electron Main 继续是 Provider 唯一编排和网络边界。
- 在线翻译默认关闭；缺 consent、凭据或 Provider 时 fail closed 到 source-only。
- `selectionId + requestId` 继续执行 latest-wins。
- 原文、译文、截图、Provider body 不进入持久化、日志或验收 artifact。
- Phase 5 public-release 未关闭项没有因 Phase 7 启动而自动转为 PASS。
