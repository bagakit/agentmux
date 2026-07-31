# AgentMux Surface Memory：T-003 独立审计

状态：`pass-with-residual`（P0=0，P1=0）
范围：Browser WebContentsView 与 Monaco editor/model 的独立预算、释放、重建和接线。

## 审计结论

T-003 的实现满足当前 Feature 的关闭边界：Browser 与 Monaco 使用分开的候选和预算，
释放只作用于各自的 native owner，Region、文档和 Browser 身份仍由既有投影保留；Terminal
cold-park 没有被复用成另一套判据。Main 侧 Browser release/restore 经 typed IPC 与 preload
桥接，Renderer 只提交 URL/Profile/Viewport 等重建输入。

资源探针与实现共同把 RSS/working-set 定义为观测，不把 allocator 或 Chromium helper 的高水位
直接称为泄漏。正式 receipt 已在最终 Feature commit `7deb81d81f7a429a729d64a5405b862fdd9f1a79`
上重跑，并验证 `sourceCommitStable=true`、`worktreeStable=true`。

## 正确性与生命周期边界

- `surface-memory-budget.ts` 将 Browser、Monaco 分桶，各自计算 TTL、hot-retain 数量和 release
  deadline；不可见、导航上下文有效、owner 存在、可重建且未受保护才可释放。
- `surface-memory-budget-candidates.ts` 从现有 Workbench/Region 投影收集候选。Monaco 以
  Store 中的 document 作为重建输入，并在 dirty/saving 时保护；Browser 以 Region 的
  `browserId`、URL、Profile、Viewport 作为 Main restore 合同，loading 时保护。
- `BrowserViewManager.release()` 删除的是 Main-owned `WebContentsView`，不发 `closed`，也不
  删除 Renderer Region。`restore()` 先校验 Profile/Viewport，再创建新 owner；失败会恢复 retained
  descriptor，允许重试。
- release 与进行中导航竞态已收敛到 `entry.requestedUrl`：`did-start-navigation` 先更新请求目标，
  不使用可能滞后的 `webContents.getURL()`。EditorPane 在 released/document 缺失时清空 editor
  ref，并用 `onDidDispose` 的 identity fence 防止旧 Monaco owner 清掉新 owner 的引用。
- Browser parked 时由 `BrowserPane.tsx:172-182` 的 source-contract guard 跳过 annotation marker
  写入，并由相邻 bounds 生命周期 guard 跳过 bounds 更新，避免把已释放 owner 当成仍可调用的
  WebContents；回访由 token fence 防止过期 restore 提交。当前这条证据是源码契约测试，不冒充
  一条真实 Electron annotation integration test。

## Authority 与复杂度

Core/ctxmux 继续拥有 Session、Run、Replay、Gap、Attachment 等事实；本实现没有复制这些对象，
也没有新增缓存池或第二套 Browser/Terminal 生命周期。Renderer 只保留 Region/document 投影，
Main 只持有 WebContentsView 及其最小 restore descriptor。Terminal policy 与 Browser/Monaco
policy 是并列模块，避免跨 surface 的隐式预算耦合。

## 证据

### 行为与回归

定向测试（当前候选）：

```text
pnpm --filter @agentmux/desktop exec vitest run --maxWorkers=1 \
  test/resource-probe-contract.test.ts \
  test/surface-memory-budget-contract.test.ts \
  test/surface-memory-budget.test.ts \
  test/surface-memory-budget-coordinator.test.ts \
  test/browser-view-manager.test.ts \
  test/browser-toolbar.test.tsx \
  test/editor-pane-reveal.test.tsx
→ 7 files, 66 tests passed

pnpm --filter @agentmux/desktop typecheck
→ passed
```

### 变异测试

故意移除 Monaco dirty/saving 保护，`surface-memory-budget`/coordinator 合同测试按预期变红；
恢复后全绿。故意移除 Browser `releasedEntries.delete(id)` 的 restore 提交步骤，Browser
view-manager 测试按预期变红；恢复后全绿。另对 release 期间滞后 URL、Editor dispose identity
fence 做了竞态/源码契约验证，均通过。

### 零调用者检查

对新增公开能力执行了非测试调用者检查（排除定义文件）：

```text
useSurfaceMemoryBudget       → App.tsx
useMonacoSurfaceReleased     → WorkspaceWorkbench.tsx
useBrowserSurfaceReleased    → WorkspaceWorkbench.tsx
collectSurfaceMemoryCandidates → surface-memory-budget-coordinator.tsx
Browser release/restore      → BrowserPane.tsx → typed IPC/preload → Main
EditorReleasedState          → EditorPane.tsx
```

仅内部 helper 保持非公开；没有把只被测试引用的 symbol 当作交付能力。

## 资源基线审计关联

`agentmux-surface-memory-baseline.json/.md` 记录 idle、单隐藏 Workspace、多个隐藏
Workspace/Tab、Terminal、Monaco、Browser 与 Browser released 阶段，并逐阶段记录
Main/Renderer/GPU/Utility working-set、Terminal/Monaco/Browser/attachment owner counts、
AgentMux commit、Electron、ctxmux manifest、平台、隔离目录清理和 receiptless daemon 清理。
探针使用 `--expose-gc` 报告 `heapUsedAfterGc`，并明确 RSS 高水位是 diagnostic-only；只有非有限
数据、owner 不收敛或清理失败会阻断。

正式 receipt（绑定最终提交）显示：

| 阶段 | 总 working set KiB | Browser owner | Monaco editor/model | Terminal views |
| --- | ---: | ---: | ---: | ---: |
| idle | 575,600 | 0 | 0/0 | 1 |
| single hidden Workspace | 576,557 | 0 | 0/0 | 2 |
| multiple hidden Workspaces/Tabs | 596,883 | 0 | 0/0 | 4 |
| Terminal | 595,985 | 0 | 0/0 | 3 |
| Monaco | 868,170 | 0 | 1/1 | 3 |
| Browser | 1,061,767 | 1 | 0/0 | 2 |
| Browser released | 979,686 | 0 | 0/0 | 3 |

这组数只能说明同条件下的观测与 owner 收敛，不构成产品 RSS 承诺，也不单独证明泄漏。

## 残余风险（P2）

1. `browserWebContents` 当前按“除主 Renderer 外的全部 WebContents”计数，口径可能包含共享或
   其他 Chromium helper；报告已注明该限制，后续可按 Browser manager owner 做更窄的归因。
2. Coordinator 的真实异步 integration test 仍较少；纯策略、候选收集和 Main manager 行为已有
   覆盖，但完整 React timer → IPC → restore 链路主要由源码契约与定向测试守护。
3. Browser restore 保留 URL/Profile/Viewport，不承诺历史滚动位置、页面内临时 JS 状态或完整
   navigation history；这是当前可验证重建合同的明确边界。
4. worktree 稳定性以起止 porcelain 内容指纹和 commit 身份判断；并发 Agent 若在 receipt 窗口
   修改工作树，receipt 会标记 `worktreeStable=false`，该次测量不得晋升为正式基线。
5. 应用重启或异常关闭时，released descriptor 与 Renderer Region 的恢复仍依赖既有布局持久化
   生命周期；这不是本轮新增的跨重启缓存合同。

## 处置

以上均不阻断当前 T-003：没有 P0/P1，且不改变本 Feature 的 acceptance。正式 receipt 已同步到
baseline JSON/Markdown；可继续执行 Feature Tracker gates 与 closeout。
