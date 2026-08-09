# Plan Review r1 — Reveal an Unopenable File in Finder (f-2328fmmvk)

Meta: 本文件是 `f-2328fmmvk` reviewed task plan (revision 1) 的评审依据。
作者与评审者同为接手本轮 goal 的实现 Agent（`agentmux-1d`），因此**这是作者自审，不是独立评审**。
计划的 T-002 明确要求交付前必须经一个未参与实现的独立 Reviewer 审查——那一道关不由本文件代替。

## 用户原始诉求（逐字）

> 需求: 打不开的文件，现在只显示"无法加载文件"，应该在它这里再加上"Reveal in Finder"之类的操作

## 解读

用户描述的是一个**死胡同界面**：面板报告失败，但没有给任何可执行的下一步。
"之类的操作"说明重点不在"必须是 Reveal in Finder 这个具体动作"，而在**失败态要有出口**。
Reveal 是这个场景下最直接的出口，因为用户想确认的正是"这文件到底还在不在、是不是权限/符号链接问题"——
那是文件管理器能回答、而编辑器回答不了的问题。

## 核实过的现状（每条附证据）

| 事实 | 证据 |
|---|---|
| Reveal 能力**已存在**，不需要新建 | `apps/desktop/src/preload/index.ts:67` → `apps/desktop/src/main/ipc.ts:234` → `apps/desktop/src/main/workspace-files.ts:756` |
| 文件树右键已有 "Reveal in Finder" 并且能用 | `apps/desktop/src/renderer/src/components/file-tree/FileTreeContextMenu.tsx:64` |
| 编辑器失败态是死胡同：只有文案，没有动作 | `apps/desktop/src/renderer/src/components/EditorPane.tsx:53-60`（"File is no longer available" + "Refresh the explorer and open it again."） |
| 打开失败时连 tab 都不会建，只弹一条 toast | `apps/desktop/src/renderer/src/store.ts:1889-1891`（catch 里只 `reportError` 然后 return false） |
| `localPathForReveal` **要求目标存在** | `apps/desktop/src/main/workspace-files.ts:759` 调 `localExistingPathWithin` |
| 非 local host 下 reveal 必然抛错 | `apps/desktop/src/main/workspace-files.ts:758` |

## 计划里最要紧的一条判断

**已删除的文件是"打不开"的头号成因，而恰好是 reveal 会失败的情形。**

`localPathForReveal` 经 `localExistingPathWithin` 解析（`workspace-files.ts:759`），目标不存在就抛错。
如果直接把 reveal 接上去而不处理这一点，用户点了按钮只会换来第二条错误——
一个把「无法加载」变成「无法加载 + 无法揭示」的改动，比不做更糟。

正确行为是**回退到最近的存在的祖先目录**：揭示父目录仍然回答了用户的问题（文件不在那儿了），
而报二次错误没有回答任何问题。这条写进了 T-001 的验收，并要求测试覆盖。

## 明确不做

- 不新增第二条 reveal IPC 或第二套路径解析——两处入口共用既有通路。
- 不改动文件树右键菜单里已经能用的那一个。
- 非 local workspace 下不画一个禁用的假按钮：缺席即表达（既有设计语汇）。

## 已知遗留

- `apps/desktop/src/renderer/src/lib/api.ts:444` 的 `reveal: async () => {}` 是 web 兜底的空实现。
  本 feature 不改它（web 形态下没有 Finder），但实现者应确认失败态在 web 形态下不呈现该动作。
