# AgentMux Surface Memory Baseline

这是 T-001 的正式可复现分阶段 receipt（`agentmux.t001-desktop-resources.v2`），绑定在最终候选
commit `7deb81d81f7a429a729d64a5405b862fdd9f1a79`。原始探针通过
`pnpm --filter @agentmux/desktop measure:desktop` 生成；对应的结构化摘要见
[`agentmux-surface-memory-baseline.json`](./agentmux-surface-memory-baseline.json)。

## 身份与复现边界

- 测量时间：2026-08-30T19:57:11.931Z
- 平台：`darwin-arm64`；Node `v24.18.1`；Electron `43.3.0`
- AgentMux source/end commit：`7deb81d81f7a429a729d64a5405b862fdd9f1a79`
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
| idle | 575,600 | 1/1 (1) | 1 | 0/0 | 0 | 238,845 / 175,667 / 115,712 / 45,376 |
| single hidden Workspace | 576,557 | 2/2 (2) | 2 | 0/0 | 0 | 228,314 / 186,944 / 115,923 / 45,376 |
| multiple hidden Workspaces/Tabs | 596,883 | 4/4 (4) | 4 | 0/0 | 0 | 231,779 / 201,440 / 118,240 / 45,424 |
| Terminal | 595,985 | 4/4 (3) | 3 | 0/0 | 0 | 230,410 / 205,101 / 115,130 / 45,344 |
| Monaco | 868,170 | 4/4 (3) | 3 | 1/1 | 0 | 233,456 / 469,901 / 119,261 / 45,552 |
| Browser | 1,061,767 | 11/11 (3) | 2 | 0/0 | 1 | 299,741 / 596,810 / 119,136 / 46,080 |
| Browser released | 979,686 | 11/11 (3) | 3 | 0/0 | 0 | 299,488 / 515,056 / 119,062 / 46,080 |

每个阶段同时记录了 `terminalAddons`、`terminalListeners`、`documents`、`fileWatchers`、
`sessionAttachmentOwners`、`sessionAttachmentLeases`、renderer `heapUsedAfterGc` 与完整进程
列表；完整 owner map 和 attribution 在 JSON 摘要中保留。隐藏拓扑为 2 个隐藏 Workspace，活动
Workspace 有 2 个 Terminal Tabs。

## Release cycles 与解释

释放/重新创建循环的总 working set（KiB）依次为：`897,475`、`933,412`、`948,048`、
`973,764`、`993,852`、`973,891`、`977,961`。七次样本及 `browser-released` 的 owner
都收敛到 `browserWebContents=0`、`monacoEditors=0`、`monacoModels=0`、`documents=0`、
`fileWatchers=0`、`terminalViews=3`、`sessionAttachmentOwners=3`、`sessionAttachmentLeases=3`。
`rendererMemory` 在本次运行可用 `--expose-gc`，`heapUsedAfterGc=14,844 KiB`；这与 working-set
高水位必须分开解读。

探针把 Terminal、Monaco、Browser 的增量以及 release drift 与参考值一起记录为
`diagnostic-only`。本次实际增量分别为 Terminal `452 KiB`、Monaco `272,637 KiB`、Browser
`164,292 KiB`，Browser release 后 `82,211 KiB`，steady release drift `45,804 KiB`；最大
released working set 增量为 `96,377 KiB`。参考值不是产品 SLO，也不会因为一次 Chromium helper
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
