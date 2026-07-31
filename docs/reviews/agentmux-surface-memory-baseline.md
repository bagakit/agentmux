# AgentMux Surface Memory Baseline

这是 T-001 的一次可复现分阶段 receipt（`agentmux.t001-desktop-resources.v2`）。原始探针
通过 `pnpm --filter @agentmux/desktop measure:desktop` 生成；对应的结构化摘要见
[`agentmux-surface-memory-baseline.json`](./agentmux-surface-memory-baseline.json)。

## 身份与复现边界

- 测量时间：2026-08-30T19:04:26.200Z
- 平台：`darwin-arm64`；Node `v24.18.1`；Electron `43.3.0`
- AgentMux commit：`36a732561992aab56a2ed4fb89d3f2f37b8ad594`
- ctxmux source commit：`073e206407ce28331aa882c2c80e9354cfe2879a`
- ctxmux source tree：`3ddf0706c35517c0dd6bdf4d4f7fa251d88c0e0a`
- ctxmux protocol：`13`；daemon SHA-256：`cb9ce8c9d1a43ec3e314c424e5fb46ad8978b780cae2f608ec746375319eb98b`
- 起止 commit 相同，`sourceCommitStable=true`，`worktreeStable=true`。运行开始时工作树已有
  38 个并发编辑条目；起止状态摘要 SHA-256 都是
  `87ee827b962ca5415dfd0dfb2c7bf4a325b0f2ab0579888995d81c509a9f2d1a`，因此本次探针没有改动它们。
- 探针使用隔离的 userData、runtime、三个 workspace 和临时报告；退出时验证路径删除，并额外
  验证精确清理无 receipt 的 ctxmuxd owner。`harness` 中 `daemonCleanup=true`。

## 阶段结果

`totalWorkingSetKiB` 是五次 `app.getAppMetrics()` 按 pid 平均后的总和；下面的进程列按
Main/Renderer/GPU/Utility 分桶。Core/ctxmux 列是 Session/Run/Attachment 事实，不是内存归属。

| 阶段 | 总 working set (KiB) | Core sessions/runs (running) | Terminal views | Monaco editors/models | Browser WebContents | Main / Renderer / GPU / Utility (KiB) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| idle | 571,268 | 1/1 (1) | 1 | 0/0 | 0 | 238,029 / 173,933 / 114,074 / 45,232 |
| single hidden Workspace | 596,733 | 2/2 (2) | 2 | 0/0 | 0 | 233,542 / 195,178 / 122,771 / 45,242 |
| multiple hidden Workspaces/Tabs | 609,392 | 4/4 (4) | 4 | 0/0 | 0 | 236,784 / 204,854 / 122,474 / 45,280 |
| Terminal | 609,258 | 4/4 (3) | 3 | 0/0 | 0 | 235,312 / 209,504 / 119,194 / 45,248 |
| Monaco | 880,570 | 4/4 (3) | 3 | 1/1 | 0 | 238,640 / 473,232 / 123,226 / 45,472 |
| Browser | 1,085,111 | 11/11 (3) | 2 | 0/0 | 1 | 308,525 / 606,986 / 123,760 / 45,840 |
| Browser released | 1,002,077 | 11/11 (3) | 3 | 0/0 | 0 | 307,437 / 525,056 / 123,744 / 45,840 |

每个阶段同时记录了 `terminalAddons`、`terminalListeners`、`documents`、`fileWatchers`、
`sessionAttachmentOwners` 和 `sessionAttachmentLeases`；完整 owner map 在 JSON 摘要中保留。
隐藏拓扑为 2 个隐藏 Workspace，活动 Workspace 有 2 个 Terminal Tabs。

## Release cycles 与解释

释放/重新创建循环的总 working set（KiB）依次为：`911,699`、`943,162`、`972,323`、
`993,126`、`995,363`、`990,346`、`1,001,514`。七次样本及 `browser-released` 的 owner
都收敛到 `browserWebContents=0`、`monacoEditors=0`、`monacoModels=0`、`documents=0`、
`fileWatchers=0`、`terminalViews=3`、`sessionAttachmentOwners=3`、`sessionAttachmentLeases=3`。
`rendererMemory` 在本次运行可用 `--expose-gc`，`heapUsedAfterGc=14,844 KiB`；这与 working-set
高水位必须分开解读。

探针把 Terminal、Monaco、Browser 的增量以及 release drift 与参考值一起记录为
`diagnostic-only`。本次实际增量分别为 Terminal `-4,326 KiB`、Monaco `266,986 KiB`、
Browser `173,412 KiB`，Browser release 后相对 released 基线 `90,378 KiB`，steady release
drift `29,191 KiB`。参考值不是产品 SLO，也不会因为一次 Chromium helper 或 macOS allocator
保留页而使命令失败；只有非有限数据、owner 不收敛或生命周期契约失败才阻断。不能据此宣称
存在或不存在泄漏，后续比较必须使用同条件、重复 steady-state 样本和 owner/heap/GC 事实。

## 运行命令

```bash
AGENTMUX_DESKTOP_RESOURCE_TIMEOUT_MS=240000 \
  pnpm --filter @agentmux/desktop measure:desktop
```

探针本身不写源工作树；若并发编辑在运行期间发生，receipt 会把 `worktreeStable` 标为
`false`，该次结果不应作为正式基线。
