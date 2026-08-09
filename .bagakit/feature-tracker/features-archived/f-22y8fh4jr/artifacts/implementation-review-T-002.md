# f-22y8fh4jr T-002 收尾：补上缺失的用户入口

日期：2026-08-29
执行者：主 session
起因：实现 agent 在 openConcerns 中**如实上报**了自己没做完的部分

## 实现者上报的缺口（诚实，值得记录）

负责本 feature 的实现 agent 在自述里明确写道：

> DOM entry point (context-menu item) is intentionally NOT wired — it is outside my declared
> file surface. ... `grep` confirms no component consumes either symbol yet.

即：纯 reducer（`move-session-view.ts`）、菜单模型（`moveSessionViewTargets`）、
store action（`moveSessionViewToWorkspace`）三者都完成且有测试，但**没有任何 .tsx 调用它们**。
用户无法发起这次搬移——这正是本 feature 的全部意义。

这与本轮在扇出 feature 上发现的是同一种模式：单元齐备、竖切未闭合。

## 处置：先补测试（红），再接线（绿），最后变异验证

1. **先写红测试**。在 `move-session-view.test.ts` 加了一条断言，要求
   `WorkspaceWorkbench.tsx` 真的调用 `moveSessionViewTargets(` 与
   `moveSessionViewToWorkspace(`，且 `WorkbenchTabContextMenu.tsx` 消费该模型。
   接线前实测 **1 failed | 15 passed**。

2. **接线**（复用既有惯例，不新建第二条导航路径）：
   - `WorkbenchTabContextMenu.tsx`：新增 `moveSessionViewTargets` / `onMoveSessionView` 两个 prop，
     照搬既有 "Move Tab to New Group" 的 `ContextMenu.Sub` 子菜单形状渲染目标列表。
   - `WorkspaceWorkbench.tsx`：由 `titleWorkbenchSurface(tab)` 得到 `movableSessionRegionId`
     —— **只有 agent / terminal 投影可搬**，file/launcher View 没有 Session 身份可搬，
     因此**不提供目标（缺席即表达），而不是给一个禁用的假按钮**。
   - 目标列表一律来自纯模型 `moveSessionViewTargets(workspaces, currentWorkspaceId)`，
     组件不自行重算（模型已排除当前 workspace——搬过去是 no-op）。

3. **接线后** 16 passed。

4. **变异验证**：把 `moveSessionViewTargets={...}` 改成恒定 `[]`（即入口消失），
   实测 **1 failed | 15 passed**。断言确实守得住这条接线，不是空测试。
   变异后已还原并 diff 确认逐字节一致。

## 仍需注意

`moveSessionViewToWorkspace` 的诚实性保证（搬投影不搬 cwd）此前也已由主 session 单独变异验证：
向 store action 注入"把 session.workspacePath 改成目标 workspace 路径"的缺陷后，
`keeps the moved Session showing its own workspacePath` 一条变红。
即 tooltip 里的 `Working directory:` 始终来自 Core 的 `session.workspacePath`，
不会被所在 View 的 workspace 名字顶替——这是本 feature 唯一的数据误导风险，已被守住。
