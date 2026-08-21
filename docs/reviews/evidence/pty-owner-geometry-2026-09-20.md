# 长命 View 的 PTY 尺寸事实接续

对应 root 已批准的 `f-2698f5kpc / T-001` 与 `docs/reviews/pty-size-authority-2026-09-20.md`。
本工作树 `/tmp/agentmux-region-topic-20260920`；不操作用户现有 Runtime、Agent 或安装包。

## 已安装与仍缺的区别

安装包 `~/Applications/AgentMux.app/Contents/Resources/app/package-identity.json` 标记
`9953705a95e35b4e7b98841958435efe03723533`。`git merge-base --is-ancestor` 证明原 attach/replay
几何修复 `3d3bd227` 已包含，且实际 main/renderer bundle 包含 `currentSize`、`beginReplay/endReplay`。
`bf064d75` 的 Stop-hook 取消/drain 修复不包含；不能把已修未安装与这次尺寸缺口混为一谈。

本次缺口是 Core `acceptKernelEvent` 丢弃 ctxmux `resized`。另一 Client 改为 132×45 后，长命 View
仍是 80×24，普通同尺寸 observe 不会纠正。隔离探针 `/tmp/resize-ownership-probe{,-red}.log` 显示
Core 事件数组为空、local=80×24/owner=132×45，要求传播与收敛的两条断言均失败。该现状刻画探针
不纳入正常回归集。

## 分层与闭环

- ctxmux 仍独占 PTY 尺寸。Core 公开 `terminal-resized` 事实，Main 原事件总线透传。
- TerminalView 只接受同 Host、同 Run 的事实，在现有有界输出队列中消费。字节批处理不能跨尺寸
  边界；丢弃旧字节前缀时保留后续字节所需的最后尺寸。连续无字节的尺寸事实合并，事件数另受上限约束。
- Synchronizer 只被动更新解析器，不申请 PTY resize。真实本地像素变化或 hidden→visible 才恢复本地
  fit/resize；不新增焦点策略、尺寸真相缓存、定时探测或 Runtime。
- 重连 snapshot 的已知尺寸先于 replay；未知尺寸不改网格、不阻断 Agent。原 pump 可能早于 attach
  resolve 发 live，因此在既有 adapter owner 增加同步 beforeLive 顺序点：验证本次 Run、发布尺寸与
  replay，随后才读取 live iterator。callback 失败会 detach，detach 失败仍 close 本地附件并报告两项错误。
  普通首次 attach 的返回合同不变，Renderer 原 pending 缓冲继续承接早到数据。

## 验证

先执行 `node -p 'process.cwd()'` 确认测试 cwd。使用自己的 Core dist 与 desktop workspace 依赖链接。

```sh
pnpm --config.verify-deps-before-run=false --filter @agentmux/core build
node node_modules/vitest/vitest.mjs run \
  packages/core/test/ctxmux-run-current-size.test.ts \
  packages/core/test/reconnect-live-stream-rebuild.test.ts \
  packages/core/test/ctxmux-reconnect.test.ts \
  apps/desktop/test/terminal-owner-geometry.test.ts \
  apps/desktop/test/terminal-viewport-sync.test.ts \
  apps/desktop/test/terminal-replay-reflow-recovery.test.ts \
  apps/desktop/test/terminal-live-output.test.ts \
  apps/desktop/test/terminal-viewport-memory.test.ts \
  apps/desktop/test/runtime-controller.test.ts \
  apps/desktop/test/desktop-agent-continuity.integration.test.ts \
  apps/desktop/test/sliced-scan-surface-not-empty.test.ts \
  apps/desktop/test/vacuous-on-empty-predicate.test.ts
pnpm --config.verify-deps-before-run=false --filter @agentmux/desktop typecheck
```

12 文件、165 tests 全绿，日志 `/tmp/owner-size-final.log`；Core build 与 Desktop production typecheck 通过。
真实 headless xterm 断言旧尺寸第24行 OLD 与新132×45第40行 WIDE_MARK 均完整，普通observe不发反向请求，
本地布局变化与重新可见才重申请。回连夹具在 attach resolve 前送 live resize/output，断言
`132×45 → REPLAY → 160×50 → LIVE`；未知尺寸为 `REPLAY → 160×50 → LIVE`，恢复成功且无Agent错误。
真实 adapter 的 iterator 调用次序与 callback失败cleanup另有行为断言，未仅靠假adapter自行保证。

既有独立 Runtime integration 重跑：首个 Node 进程退出后另一个进程仍见同 Run/PID/owner 尺寸；
Desktop controller dispose/recreate 后原 Agent 身份、回放与实时 I/O 保持。随后第三个独立Node client
把同一PTY改成160×50，保持附着的旧Desktop Renderer收到该尺寸事件且Run/PID不变；该加强版
integration 2/2通过，日志 `/tmp/owner-size-real-process.log`。未执行真实 Electron 安装/截图验收。

额外 `type-tree-typecheck.test.ts` 有3红：project-rail-density与semantic-icons旧测试新增类型错误，
continuity类型错误基线10而实测9。均不在本轮改动文件；没有修改其基线，交集成树最终校验。

## 变异与真实调用者

每次只改一处生产代码、运行对应测试再恢复。8项均由测试断言杀死（非编译失败）：
吞 Core 尺寸事件；pump抢在snapshot前；callback失败漏detach；不改parser网格；重新可见不refit；
batch越过尺寸边界；丢字节时丢其几何；TerminalView漏调用acceptOwnerSize。
日志 `/tmp/owner-size-mutant-*.log`。恢复后上述165条全部重跑通过。

零调用者检查排除定义文件：`acceptOwnerSize/applyOwnerGrid` 在 TerminalView 实际 drain/terminal.resize；
`beforeLive` 在 Client.attachAgentRun 接到 adapter、由 resumeLiveAttachment 发布snapshot；
`terminal-resized` 从 Client 经 RuntimeController.publish/IPC 到 TerminalView，Main真实调用测试确认
renderer.send收到原事件且没有resize请求。Store启动缓冲明确忽略此渲染事实，避免把高频几何当语义事件。

## 留给安装后的黑盒验收

用同一 Run 的两个 View，调整其中一格尺寸，另一格应跟随新解析网格且不反复跳宽；输出持续可读。
隐藏后重新显示恢复本格布局。真实重启后原 Tab/Region/Run 保留、尺寸恢复。历史跨尺寸回放没有完整
几何时间线，仍不宣称能复原所有历史布局。

另一个用户症状 Attach failed / Runtime host is being reconfigured 的退出gate仍需独立核对：
RuntimeController.dispose 在等待现有操作前设gate；旧operation不settle会使可见旧窗口继续报gate。
没有历史等待栈，不能声称本次尺寸修复或bf064已经证明解决全部历史Attach failed。
