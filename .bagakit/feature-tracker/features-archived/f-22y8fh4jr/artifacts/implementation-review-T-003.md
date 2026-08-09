# f-22y8fh4jr 独立实现审查（T-003 收尾）

日期：2026-08-29
审查者：主 session
方法：对着工作树真实代码核对 + 实测变异验证

## 用户诉求

「让用户把一个窗口显式转移到另一个 worktree 的界面里去——常见情形是在某处创建了 worktree，
但发起创建的那个会话自己还留在原处，于是变得难管理。转移必须是显式动作：
不能假设创建 worktree 的那个 session 就该搬过去。」

## T-001 纯 reducer —— 通过

`lib/move-session-view.ts`：输入 tabs/layouts/regionId/sessionId/targetWorkspaceId，输出下一份布局。
不碰 Store、不碰 Electron、不触达 Core。

- **输出里没有 cwd**：有一条专门断言把整个结果 `JSON.stringify` 后检查不含 `workspacePath`，
  并逐个 surface 断言不具该属性。
- 目标 workspace 无可承载 View 时以 `createdView: true` 明确表达，而**不是静默丢弃**这次搬移。
- 同一 Session 投影到多个 View 时只搬被指定的那一个，其余不受影响。
- 目标同源 / region 不存在 / sessionId 不匹配 / 目标 workspace 不存在 → 返回 `unchanged`，不抛异常。
- 目标已有承载该 Session 的 View 时复用它，不铸重复 View。

## T-002 显式入口 + 诚实性 —— 通过（曾缺失，本轮补齐）

**实现 agent 主动上报**了自己没做完的部分：reducer、菜单模型、store action 三者齐备，
但**没有任何 .tsx 调用它们**，用户无法发起搬移。这与本轮在扇出上发现的是同一模式：
单元齐备、竖切未闭合。

补齐方式（先写红测试，再接线）：
- `WorkbenchTabContextMenu.tsx` 新增 `moveSessionViewTargets` / `onMoveSessionView` 两个 prop，
  照搬既有 "Move Tab to New Group" 的 `ContextMenu.Sub` 形状，**不新建第二条导航路径**。
- `WorkspaceWorkbench.tsx` 由 `titleWorkbenchSurface(tab)` 取 `movableSessionRegionId`：
  **只有 agent / terminal 投影可搬**；file / launcher View 没有 Session 身份可搬，
  因此**不提供目标（缺席即表达），不画禁用的假按钮**。
- 目标列表一律来自纯模型，组件不自行重算。

`store.ts:1676 moveSessionViewToWorkspace`：一次**原子**布局替换，随后走既有 `focusRegion`
导航；源 View 正在关闭时经既有 `reportError` 拒绝并**保持布局分毫不动**（有断言覆盖），
不产生半搬状态。

## 唯一的诚实性风险 —— 已守住（实测）

「搬投影不搬 cwd」是本 feature 唯一会导致真实误操作的地方：
若界面让人以为 Agent 换了工作目录，用户会以为自己在改新分支的文件。

`session-metadata.ts:13` 的 tooltip 逐字读 `session.workspacePath`（Core 的进程 cwd），
不继承所在 View 的 workspace 名字。

**变异验证**：向 store action 注入「把 session.workspacePath 改写成目标 workspace 路径」的缺陷：

```
npx vitest run apps/desktop/test/move-session-view.test.ts
→ Tests  1 failed | 14 passed (15)
```

`keeps the moved Session showing its own workspacePath` 变红。已还原并 diff 确认。

**入口的变异验证**：把菜单目标改成恒定 `[]`（入口消失）→ 1 failed。已还原。

## 创建 worktree 不自动搬移 —— 通过

按用户原话，无法假设创建 worktree 的那个 session 就该移过去。
搬移只有一条触发路径：Tab 右键菜单里的显式动作。全仓无自动调用点。

## 门禁

`pnpm check` 实测全绿：typecheck + 1208 passed / 0 failed / 3 skipped + build 成功。

## 结论

无 blocking 发现。无任何路径试图改 Agent 的 cwd；布局是原子替换故无半搬状态；
未出现第二份 Session Registry；界面不会让人误以为工作目录变了。
