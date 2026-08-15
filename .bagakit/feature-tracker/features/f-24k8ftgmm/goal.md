# 文件树目录「作为项目打开」与展开分组的结构线

Contract: `bagakit.feature-goal.v1`
Feature: `f-24k8ftgmm`

## 状态：已落地（2026-09-14 逐条核对）

**这份 Feature 停在 `ready`、`tasks: 2 done / 1 todo`，但它要的两项行为都已在生产代码里，并有真测试守着。**
照着原文再做一遍等于重写一个已经在跑的机制。本文档的作用就是挡住那次重写。
唯一还是 `todo` 的 T-003 是打包/发布检查（`pnpm typecheck && pnpm package:mac`），**不是**功能实现——
它是候选打包关口，与本 Feature 的两项用户可见能力无关，别把它读成"功能没做完"。

落点：
- **目录「Open as Project」**：右键项由 `FileTreeContextMenu.tsx` 只在目录上渲染；点击经
  `FileExplorer.tsx` 的 `openDirectoryAsProject()` 调纯 seam `open-directory-as-project.ts` 的
  `createDirectoryProjectInput()` 派生 host/path，再走 `api.workspaces.add`。
- **展开分组的结构线**：`WorkspaceSidebar.tsx` 只给"有名且展开"的分组挂 `project-rail-group--expanded`，
  该类的 `::before` 竖线（`chrome.css`）才画出来；折叠或无名分组不挂类、不画线。

判别命令（问 git，不问工作区——文件在本机磁盘上恒在，那证明不了它入了库）：

| 原文要的东西 | 判别命令 |
| --- | --- |
| 目录菜单有「Open as Project」入口，且只在目录上 | `git grep -n "Open as Project" HEAD -- apps/desktop/src/renderer/src/components/file-tree/FileTreeContextMenu.tsx` |
| 路径/命名派生收在一个可单测的纯 seam 里 | `git grep -n "export function createDirectoryProjectInput" HEAD -- apps/desktop/src` |
| 入口真接到生产调用路径（不是只活在定义里） | `git grep -n "onOpenAsProject={() => void openDirectoryAsProject" HEAD -- apps/desktop/src` |
| 已注册目录不重复添加：由 main 侧同一位置权威判重 | `git grep -n "insertOrGetWorkspace(config" HEAD -- apps/desktop/src/main/ipc.ts` |
| 仅"有名 + 展开"的分组画结构线 | `git grep -n "group.label && key !== null && !collapsed ? 'project-rail-group--expanded'" HEAD -- apps/desktop/src/renderer/src/components/WorkspaceSidebar.tsx` |
| 结构线本身（竖线 `::before`）存在 | `git grep -n "project-rail-group--expanded::before" HEAD -- apps/desktop/src/renderer/src/styles/chrome.css` |
| 折叠后连注意力一起卷上来，不只是成员数 | `git grep -n "rowAttention(groupSessions)" HEAD -- apps/desktop/src/renderer/src/components/WorkspaceSidebar.tsx` |

判重那一条最容易写错：renderer 里 `FileExplorer.tsx` 有一段 `workspaces.find(... item.path === projectInput.path)`
的**快路径**，但它自己注释写明那只是 best-effort、看不到尾斜杠/`.` 后缀的拼写差异；真正的权威判重在 main 侧
`workspace-location.ts` 的 `insertOrGetWorkspace` / `workspaceLocationKey`，`workspaces:add` 路由经过它，
命中即返回既有记录而不追加重复。所以判据钉的是 main 侧那处，不是 renderer 的快路径——照着 renderer 那行去
理解会以为判重靠裸 `===`，那是错的。

测试（从仓库根跑，剥掉环境）：
`env -u AGENTMUX_AGENT_SESSION_STORE -u AGENTMUX_HOOK_URL -u AGENTMUX_HOOK_TOKEN -u AGENTMUX_HOOK_EVENT -u AGENTMUX_AGENT_SESSION_ID pnpm exec vitest run apps/desktop/test/file-explorer-open-as-project.integration.test.tsx apps/desktop/test/project-rail.test.tsx`
→ **Test Files 2 passed, Tests 29 passed**。
（T-001 的 gate 曾指向不存在的 `test/file-tree-open-project.test.tsx`，vitest 对不存在的路径静默退 0，
那个 gate 永远不可能真验收；现已改指 `file-explorer-open-as-project.integration.test.tsx`，见 tasks.json T-001 的
verification 修正说明。）

## 原文里的两个能力点，各自怎么落的

1. **「目录右键菜单提供作为项目打开」——只在目录上给入口，文件不给。**
   `FileTreeContextMenu.tsx` 用 `isDirectory ? <Open as Project> : null` 收口；`openDirectoryAsProject`
   进函数也先 `if (!workspace || !node.isDirectory) return`，纯 seam `createDirectoryProjectInput` 再
   `if (!input.isDirectory) return null`——三处同一判据，文件不可能长出这个入口。注册用的 host/path 由
   `createDirectoryProjectInput` 把 workspace 的 hostId 和 `joinWorkspacePath(workspace.path, relativePath)`
   组出来，命名默认取目录名。

2. **「保持目录分组视觉清晰」——结构线只画在"有名 + 展开"的分组上，且不与项目名抢左缘。**
   用户报告分组头与项目行"太接近"。修法不是加字号（密度合同禁止父目录名比项目名更响），而是让
   分组头成为一个 disclosure 控件（chevron 落在缩进槽、项目名左缘仍是唯一读取线），并只在展开时用
   `project-rail-group--expanded::before` 的一条竖线把成员归拢。折叠或无名分组不挂 `--expanded` 类，
   于是"无分组、折叠"都不画空线。分组内成员的缩进是**加**一级（`node.depth + (group.groupPath ? 1 : 0)`，
   再 clamp 到 `PROJECT_RAIL_MAX_DEPTH`），路径派生的更深嵌套仍然叠在这一级之上。

## 既定决策

- **判重的权威在 main 侧，renderer 只有快路径。** renderer 沙箱没有 `node:path`，看不到尾斜杠/`.`
  等价拼写；所以它 miss 时**必须**落到 `api.workspaces.add`，由 `insertOrGetWorkspace` 用
  `workspaceLocationKey` 归一化判重、命中返回既有记录。不要把 main 侧归一化器 import 进 renderer——
  会打断无 node 内建的 renderer/web 构建（源码注释已写明）。
- **折叠头必须自己答出身份和注意力。** 成员一藏，这一行就是那几个项目在界面上唯一的痕迹：它补出
  地址（尾三段）、成员数，并用 `rowAttention(groupSessions)` 把**每个**成员（含缩进子孙）的
  Session 注意力卷上来。只显示成员数会重犯"一个 Agent 正在里面等你的折叠项看起来和空闲的一样"那个洞。
- **分组是从磁盘路径派生的，不是可命名实体。** 因此分组头上唯一说得通的操作是折叠，不给它挂
  "重命名分组/删除分组"——那等于凭空发明一个注册表。

## 边界

- 这个 Feature 只管**文件树目录 → 注册成 project** 这一步的入口、派生与判重接线，以及**分组展开时的
  结构线呈现**。它**不**拥有：workspace 的持久化与 same-location 归一化规则本身（那在 main 侧
  `workspace-location.ts`，本 Feature 只是其调用方）；worktree 的创建与仓库卫生（另有 Feature，
  见 `f-25f8ffrme`）；项目行本身的注意力投影语义（`rowAttention` 是既有共享件，本 Feature 复用不改）。
- T-003 的打包/发布检查是候选关口，不改变以上两项能力；它 `todo` 不代表功能未落地。
