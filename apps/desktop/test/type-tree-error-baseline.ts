/**
 * 「桌面测试树的类型错误上限」——一份被冻结的基线，由 type-tree-typecheck 守卫消费。
 *
 * 来由：`apps/desktop/tsconfig.json` 的 `include` 是 `["src/**\/*.ts", "src/**\/*.tsx", "*.ts"]`，
 * 整个 `test/` 从不被编译。后果不是「测试跑不过」，而是**写在测试里的编译期判据永远不被执行**——
 * 形如 `const T: Record<SomeUnion, true> = {…}` 的穷举表、`satisfies` 校验，全是死代码；提交信息
 * 反复拿「tsc exit 0」给纯 `test/` 下的改动背书，而那句话什么都没证明；删掉一个生产字段会在测试里
 * 留下悬空引用而无人看见。相邻的 `packages/core` 的 `include` 是 `["src/**\/*.ts", "test/**\/*.ts"]`，
 * 它的测试树 tsc 干净——这份不对称本身就是缺陷。
 *
 * 这份基线不是「零错误」：把 `test/` 纳入检查那一刻，历史积累的错误一起显形。首测（2026-09-07）377 个、
 * 横跨 100 个文件；随即用「`AppConfig` fixture 的 `version` 字段对齐 SSOT `CONFIG_VERSION`（7→9）」清掉
 * 45 个，落到 332 个、82 个文件。落地前又按下面那条维护约定复测了一遍实测值——三条已经被别的改动顺手
 * 修好却还留着数字（`git-bridge-convergence` 2→0、`topic-agent-disconnected` 2→0、`runtime-controller`
 * 20→18），于是当场收紧，交付基线是 **326 个、80 个文件**，零松弛。工程标志与 `tsconfig.json` 完全一致
 * （`exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` 皆开，经 `tsconfig.test.json` extends 继承）。
 * 一次清完既不安全（有的要动 `src/` 或改 union）也不该阻塞守卫落地，于是守卫走**棘轮**：冻结当前每文件的
 * 错误条数，**要求实测值与这里的数字逐条相等**，且不允许基线外的文件开始报错。这样「新加的编译期判据落在
 * 未检查文件里」「测试 fixture 相对生产类型漂移」这一整族缺陷从此会当场变红。
 *
 * 维护约定：修好某个文件的错误后，把它的数字改成新的实测值；降到 0 的文件从表里删除，之后它再冒出任何
 * 错误都会被「不在基线里的新报错文件」这条判据逮住。**绝不允许**用调高数字的方式让守卫变绿——那正是本
 * 守卫要消灭的「把信号改成沉默」。
 *
 * 为什么判相等而不是判上限：上限式棘轮对「调高数字」这个动作在定义上就是放行的，而那恰恰是上面这条约定
 * 明令禁止的唯一动作——规则写在散文里、判据却不执行它。曾经还有一条 `totalErrors <= TOTAL` 兜底，但那个
 * TOTAL 是从本表 `.reduce()` 出来的，改一条数字两边一起动，不等式恒成立（实测：13 改成 40，三条断言全绿），
 * 于是连同那个只有它一个消费者的导出一起删掉了。判相等还顺带消灭反向的松弛：错误被别的改动顺手修掉而
 * 基线没跟着降，空出来的额度就是一道无人看守的门。
 *
 * 路径是仓根 `apps/desktop/` 相对路径（即 tsconfig 的 rootDir 相对形式），与 tsc 诊断行前缀一致。
 */
export const DESKTOP_TEST_TYPE_ERROR_BASELINE: Readonly<Record<string, number>> = {
  "test/active-workspace-reseat.test.ts": 1,
  "test/activity-view-wiring.test.tsx": 4,
  "test/agent-address.test.ts": 4,
  "test/agent-composer.test.tsx": 3,
  "test/agent-markdown.test.ts": 4,
  "test/agent-session-composer.test.tsx": 1,
  "test/agent-usage-display.test.ts": 2,
  "test/attention-notifier.test.ts": 8,
  "test/branch-agent-presence.test.ts": 2,
  "test/browser-toolbar.test.tsx": 3,
  "test/browser-view-manager.test.ts": 2,
  "test/bundle-id-user-data.test.ts": 3,
  "test/changes-panel.test.tsx": 1,
  "test/commit-fix-guard-coupling.test.ts": 3,
  "test/commit-message-anchor-provenance.test.ts": 2,
  "test/continuity-failure-notice.test.ts": 3,
  "test/control.test.ts": 13,
  "test/create-note-wiring.test.tsx": 3,
  "test/dependency-tree-inside-repo.test.ts": 2,
  "test/desktop-agent-continuity.integration.test.ts": 10,
  "test/editor-copy-wiring.test.tsx": 2,
  "test/editor-pane-reveal.test.tsx": 3,
  "test/editor-save-wiring.test.tsx": 5,
  "test/fanout-request.test.ts": 2,
  "test/fanout-run.test.ts": 1,
  "test/file-explorer-foundations.test.ts": 1,
  "test/file-observation-registry.test.ts": 1,
  "test/git-diff.test.ts": 13,
  "test/git-remote-error.test.ts": 1,
  "test/launch-option-controls.test.tsx": 4,
  "test/launcher-draft-binding.test.ts": 2,
  "test/lib-export-reachability.test.ts": 2,
  "test/login-shell-path.test.ts": 3,
  "test/monaco-register-astro.test.ts": 6,
  "test/monaco-register-svelte.test.ts": 5,
  "test/monaco-register-vue.test.ts": 5,
  "test/move-session-view.test.ts": 2,
  "test/new-tab-resource-contract.test.ts": 1,
  "test/open-http-link-store.test.ts": 1,
  "test/package-identity.test.ts": 1,
  "test/package-install-path.test.ts": 1,
  "test/package-install-restart.test.ts": 1,
  "test/package-report-preflight.test.ts": 3,
  "test/pr-launch.test.tsx": 3,
  "test/project-board.test.ts": 1,
  "test/project-rail.test.tsx": 3,
  "test/renderer-connection-state.test.ts": 1,
  "test/renderer-state-owners.test.ts": 33,
  "test/resource-probe-behavior.test.ts": 34,
  "test/runtime-config-transaction.test.ts": 1,
  "test/runtime-controller.test.ts": 18,
  "test/scratch-topic-agents.test.ts": 1,
  "test/scratch-topic-layout.test.ts": 1,
  "test/service-window-notice.test.ts": 1,
  "test/session-launch-lifecycle.test.ts": 30,
  "test/session-pane-composer.test.tsx": 2,
  "test/shortcut-help-affordance.test.tsx": 2,
  "test/status-axis-reachability.test.ts": 2,
  "test/store-persistence.test.ts": 2,
  "test/surface-memory-budget-coordinator.test.ts": 1,
  "test/surface-tool-dock.test.ts": 1,
  "test/tab-placement-loudness.test.ts": 3,
  "test/terminal-link-provider-coverage.test.ts": 1,
  "test/terminal-replay-reflow-recovery.test.ts": 1,
  "test/terminal-reveal.test.ts": 3,
  "test/terminal-theme.test.ts": 8,
  "test/topic-agent-status.test.ts": 5,
  "test/topic-tab-inheritance.test.ts": 1,
  "test/tracked-imports-resolve-in-index.test.ts": 5,
  "test/warm-terminal-ownership.test.ts": 1,
  "test/window-geometry.test.ts": 2,
  "test/workbench-persist-version-bump.test.ts": 2,
  "test/workbench-persisted-region-drift.test.ts": 1,
  "test/workbench-persistence.test.ts": 1,
  "test/workbench-surface-kind-exhaustiveness.test.ts": 3,
  "test/workbench-surface-kind-failure-modes.test.ts": 1,
  "test/workbench-view-close.test.ts": 5,
  "test/workspace-row-context-menu.test.tsx": 2,
  "test/workspace-selection.test.ts": 1,
  "test/worktree-removal.test.ts": 3
}
