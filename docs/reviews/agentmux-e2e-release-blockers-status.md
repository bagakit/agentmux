# 2026-09-06 E2E release-blocker worktree comment

更新时间：2026-09-06

- Browser `New Browser`：fixed。`SurfaceToolDock` 不再在无焦点时静默早退；聚焦非 launcher
  Pane 的 renderer store 回归确认原 Tab 保留、新 Browser Tab/Region、`browserId`、URL 与
  active Tab 均可见。验证：
  `pnpm --filter @agentmux/desktop exec vitest run test/workspace-selection.test.ts test/surface-tool-dock.test.tsx`
  （通过）。
- Config authored Host：fixed。升级逻辑按 `host.id !== 'local'` 统计 authored Host；全丢失
  回填场景会拒绝启动。验证：
  `pnpm --filter @agentmux/desktop exec vitest run test/config-store.test.ts`
  （通过，52 tests）。
- `report:package`：blocked on release candidate。命令现在在候选缺失/产物不完整时输出缺少
  路径与 `pnpm --filter @agentmux/desktop package:mac` 下一步，不再泄露 `ENOENT` 栈；但当前
  checkout 既没有 `apps/desktop/release/mac/AgentMux.app`，且工作树仍有其他并行未提交改动，
  所以不能宣称 package ready；packaging Feature `f-2458fbphz/T-001` 已记录 external blocker。
  验证：
  `pnpm --filter @agentmux/desktop report:package`（预期 exit 1，诊断可行动）；
  `pnpm --filter @agentmux/desktop exec vitest run test/package-report-preflight.test.ts`
  （通过，3 tests）。
  另行尝试 `pnpm --filter @agentmux/desktop package:mac` 在 clean-source 前置校验处以 exit 1
  停止；未生成候选，也未改动现有安装副本。

当前并行工作树仍有其他未提交改动；本评论只记录上述三项，不代表那些改动已审阅或可发布。

变异证据：临时恢复 `browserOpenError` 的静默返回时 Browser Tools 测试变为 1 failed；临时把
`authoredHostsCarried` 改回 `host.id === 'local'` 时 config-store 变为 51 passed / 1 failed；
临时跳过 package preflight 检查时 package-report-preflight 变为 3 failed。三处均已恢复。
