# f-2378fnh3k 独立实现审查（T-004 收尾）

日期：2026-08-29
审查者：主 session
方法：对着工作树真实代码核对 + 实测变异验证

## 用户的判据

> copy 一个信息其实是 copy 一个寻址方式，所以要确保 copy 出去以后，
> **通过这一次 copy，就能够让接收方把寻址方式弄清楚**

审查就按这一条展开：接收方拿到复制内容，能不能不问人、不查文档完成寻址。

## 一、复制出的文本能否让接收方自足 —— 通过

三级地址各自产出的文本都包含：**目标是哪一层身份 + 目标 id + 可直接粘贴执行的命令**。

改造前后对照：

| 入口 | 改造前 | 改造后 |
|---|---|---|
| Tab 菜单 | `Copy Tab ID` → 裸 `view:uuid` | `Copy View Address` → 自带 `send --to-tab` / `inspect --tab`，并声明"exactly one Agent"前提 |
| Tab 菜单 | `Copy Session ID` → 裸 uuid | `Copy Session Address` → 自带 `send --to-session` / `inspect --session` |
| Tab 菜单 | `Copy Agent Handoff` → 含甩锅指引 | **已删**（见下） |
| Region 菜单 | **不存在** | `Copy Region Address` / `Copy Session Address` |

## 二、歧义是否在源头消除 —— 通过（这是本 feature 的核心）

旧 `formatAgentMuxTabHandoff` 的文本里写着：

> If send returns `MESSAGE_TARGET_NOT_UNIQUE`, choose an agentSessionId from
> the error candidates, then use `--to-session`

即：**我们已知 Tab 地址在分屏下有歧义，解决办法是让接收方自己再跑一次 inspect 去消歧。**

现在：多 Agent 时 View 地址直接引导去那一格右键取 Region 地址；
`formatAgentMuxTabHandoff` 已**整个删除**（零引用后删，不留兼容层）。

断言覆盖：View 地址不含 `MESSAGE_TARGET_NOT_UNIQUE`、不含 `candidates`。

**注意区分**：`agentmux-cli-help.ts:105,238` 里的 `MESSAGE_TARGET_NOT_UNIQUE` **保留且正确**——
那是运行时的错误契约（用户手工敲 `--to-tab` 撞上多 Agent 时确实该报这个错），
删掉的只是**复制文本**里把消歧转嫁给接收方的那段指引。两者不矛盾。

## 三、Region 菜单是否真的不依赖聚焦 —— 通过

`WorkspaceWorkbench.tsx:378` 把 `RegionContextMenu` 包在 leaf 的 `<section>` 外，
`regionId={node.regionId}` 直接来自**被右键的那个节点**，不读 `tab.layout.activeRegionId`。

断言：聚焦在 pane-1 而右键 pane-9 时，复制内容含 `pane-9` 且不含 `pane-1`。

这正是 Region 菜单存在的理由——想寻址的那一格往往恰恰不是聚焦的那一格。

## 四、两入口同源 —— 通过（变异验证）

同一个 Session 从 Tab 菜单与 Region 菜单复制出的地址**逐字相同**，有断言证明。

变异：让 Tab 菜单自行拼字符串（脱离唯一 formatter）→ **2 failed | 4 passed**。已还原并 diff 确认。

## 五、其余变异验证

| 注入的缺陷 | 结果 |
|---|---|
| View 地址不再声明"唯一 Agent"前提 | **2 failed** |
| shell 转义不再处理内嵌单引号 | **2 failed** |
| Tab 菜单脱离唯一 formatter | **2 failed** |

均已还原并 diff 确认逐字节一致。

## 六、零调用者检查 —— 通过

- `RegionContextMenu` → `WorkspaceWorkbench.tsx:37, 378, 425`（真挂在 Region 上）
- `formatRegionAddress` / `formatSessionAddress` / `formatViewAddress` → 两个菜单组件均调用

全仓 grep `agentmux send --to-` / `agentmux inspect --`（排除 `agent-address.ts`）：
**零命中**——不存在第二处拼装地址文本的代码。

## 七、非 Agent Region 的处置 —— 通过

承载 file / browser / launcher 的一格没有 Agent 语义身份，
因此**不提供** Session 地址项（缺席表达，不画禁用的假按钮）；
但仍提供 Region 地址——inspect 它能知道这一格显示的是什么。

## 八、门禁

`pnpm test:fast` **1320 passed / 0 failed / 3 skipped**；
`pnpm --filter @agentmux/desktop typecheck` 通过。

## 一处必须记录的自查失误

改造过程中我曾用 `git checkout --` 回退一批文件，**误删了本轮已归档 feature
f-22y8fh4jr 的「Move to Workspace」交付**（组件那半被退回 HEAD，调用点还在，
表现为 typecheck 报两个错）。已完整恢复并跑 `move-session-view.test.ts` 确认无回归。

教训：回退时若目标文件同时承载了别的已交付改动，`git checkout --` 会一并抹掉；
应先确认该文件相对 HEAD 的 diff 里有哪些是别人的东西。

## 结论

无 blocking 发现。用户提出的判据——"通过这一次 copy 就能让接收方把寻址方式弄清楚"——
在三级地址上均已成立，且歧义在源头消除而非转嫁给接收方。
