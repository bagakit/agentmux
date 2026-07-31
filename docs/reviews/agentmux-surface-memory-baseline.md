# AgentMux Surface Memory Baseline

这是 T-001 的正式可复现分阶段 receipt（`agentmux.t001-desktop-resources.v2`），绑定在最终候选
commit `c32a171cd9e1bf8ddb3d039ba9fccec484cae8ef`。原始探针通过
`pnpm --filter @agentmux/desktop measure:desktop` 生成；对应的结构化摘要见
[`agentmux-surface-memory-baseline.json`](./agentmux-surface-memory-baseline.json)。

## 身份与复现边界

- 测量时间：2026-08-30T20:12:01.652Z
- 平台：`darwin-arm64`；Node `v24.18.1`；Electron `43.3.0`
- AgentMux source/end commit：`c32a171cd9e1bf8ddb3d039ba9fccec484cae8ef`
- `sourceCommitStable=true`，`worktreeStable=true`，`trackedDiffClean=true`；起止 porcelain 均为空，状态摘要 SHA-256 均为
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- ctxmux source commit：`073e206407ce28331aa882c2c80e9354cfe2879a`
- ctxmux source tree：`3ddf0706c35517c0dd6bdf4d4f7fa251d88c0e0a`
- ctxmux protocol：`13`；daemon SHA-256：`cb9ce8c9d1a43ec3e314c424e5fb46ad8978b780cae2f608ec746375319eb98b`
- 探针使用隔离的 userData、runtime、三个 workspace 和临时报告；退出时验证路径删除，并额外验证精确清理无 receipt 的 ctxmuxd owner。`harness` 中 `daemonCleanup=true`、`receiptlessDaemonCleanup=true`。

## 阶段结果

`totalWorkingSetKiB` 是五次 `app.getAppMetrics()` 按 pid 平均后的总和；下面的进程列按
Main/Renderer/GPU/Utility 分桶。Core/ctxmux 列是 Session/Run/Attachment 事实，不是内存归属。

| 阶段 | 总 working set (KiB) | Core sessions/runs (running) | Terminal views | Monaco editors/models | Browser WebContents | Main / Renderer / GPU / Utility (KiB) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| idle | 546,260 | 1/1 (1) | 1 | 0/0 | 0 | 219,546 / 169,130 / 112,522 / 45,062 |
| single hidden Workspace | 498,941 | 2/2 (2) | 2 | 0/0 | 0 | 176,371 / 172,093 / 113,053 / 37,424 |
| multiple hidden Workspaces/Tabs | 517,021 | 4/4 (4) | 4 | 0/0 | 0 | 181,018 / 186,189 / 112,390 / 37,424 |
| Terminal | 510,809 | 4/4 (3) | 3 | 0/0 | 0 | 184,976 / 183,526 / 104,883 / 37,424 |
| Monaco | 759,133 | 4/4 (3) | 3 | 1/1 | 0 | 186,138 / 429,034 / 105,654 / 38,307 |
| Browser | 693,707 | 11/11 (3) | 2 | 0/0 | 1 | 222,179 / 336,533 / 95,629 / 39,366 |
| Browser released | 672,461 | 11/11 (3) | 3 | 0/0 | 0 | 217,117 / 318,966 / 97,018 / 39,360 |

每个阶段同时记录了 `terminalAddons`、`terminalListeners`、`documents`、`fileWatchers`、
`sessionAttachmentOwners`、`sessionAttachmentLeases`、renderer `heapUsedAfterGc` 与完整进程
列表；完整 owner map 和 attribution 在 JSON 摘要中保留。隐藏拓扑为 2 个隐藏 Workspace，活动
Workspace 有 2 个 Terminal Tabs。

## Release cycles 与解释

释放/重新创建循环的总 working set（KiB）依次为：`762,256`、`806,791`、`764,576`、
`791,386`、`805,891`、`761,056`、`596,957`。七次样本及 `browser-released` 的 owner
都收敛到 `browserWebContents=0`、`monacoEditors=0`、`monacoModels=0`、`documents=0`、
`fileWatchers=0`、`terminalViews=3`、`sessionAttachmentOwners=3`、`sessionAttachmentLeases=3`。
`rendererMemory` 在本次运行可用 `--expose-gc`，`heapUsedAfterGc=12,402 KiB`；这与 working-set
高水位必须分开解读。

探针把 Terminal、Monaco、Browser 的增量以及 release drift 与参考值一起记录为
`diagnostic-only`。本次实际增量分别为 Terminal `7,398 KiB`、Monaco `255,722 KiB`、Browser
`-68,549 KiB`，Browser release 后 `-89,795 KiB`，steady release drift `41,315 KiB`；最大
released working set 增量为 `44,535 KiB`（峰值 `806,791 KiB`）。参考值不是产品 SLO，也不会因为一次 Chromium helper
或 macOS allocator 保留页而使命令失败；只有非有限数据、owner 不收敛或生命周期契约失败才阻断。
不能据此宣称存在或不存在泄漏，后续比较必须使用同条件、重复 steady-state 样本和 owner/heap/GC
事实。

## 运行命令

```bash
AGENTMUX_DESKTOP_RESOURCE_TIMEOUT_MS=240000 CI=true \
  pnpm --filter @agentmux/desktop measure:desktop
```

探针本身不写源工作树；若并发编辑在运行期间发生，receipt 会把 `worktreeStable` 标为 `false`，
该次结果不应作为正式基线。
