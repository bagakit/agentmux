# Message Tools 触发：/ 与 @ 已统一到一个候选菜单，$ 技能触发尚未接线

Contract: `bagakit.feature-goal.v1`
Feature: `f-2548fr8qc`

## 状态：部分落地（2026-09-14 逐条核对）

**这份 Feature 停在 `in_progress`、`T-001 in_progress`。它的候选菜单机制、方向键/Enter/Escape 导航、
紧凑不挤压工具栏——这三样已在生产代码里并有真测试守着；缺的只有一件：内建 `$` 技能触发没有接到那个
统一菜单。**本文档的作用是挡住"整条重写"，同时把还没接的那一半说清楚，免得有人以为全没做、推倒重来。

统一触发的组件机制落在 `AgentComposer.tsx`：一个正则 `(?:^|\s)([\/$@][^\s]*)$` 抓行尾触发词，
`suggestionKind` 把 `/ $ @` 分别映射成 `command / skill / reference`，`source` 据此选
`commands / skills / references` 三份候选之一，同一个 `.composer__suggestions` 浮层渲染、
同一套键盘处理器导航。机制是"通用三路"，落在提交 `88d147c5 feat(desktop): unify composer trigger suggestions`。

唯一的生产 `<AgentComposer>` 渲染点是 `AgentSessionComposer.tsx:212`。它给菜单喂了 `commands`
（Provider 命令）和 `references`（当前打开的文件），**没有**喂 `skills`——组件里 `skills = []` 是默认空，
没有任何生产调用方覆盖它。所以今天用户键入 `$` 时那个统一菜单是空的；技能仍然只能从工具条上那个
**另一个** `AgentComposerTools` 下拉里选（`loadSkills={() => api.ui.listAgentSkills(sessionId)}`），
那正是本 Feature 要"收敛"掉的旧入口。

判别命令（问 git，不问工作区。source 用参数数组调 git，字面量 `"git status --porcelain"` 匹配不到——
这里的判据都直接 grep 源码里真实存在的字符串）：

### 已落地的一半

| 原文要的东西 | 判别命令 |
| --- | --- |
| `/ $ @` 统一到一个触发词→kind 的映射 | `git grep -n "trigger.startsWith('/') ? 'command'" HEAD -- apps/desktop/src/renderer/src/components/AgentComposer.tsx` |
| 三类候选复用同一个可访问浮层 | `git grep -n "className=\"composer__suggestions\" role=\"listbox\"" HEAD -- apps/desktop/src/renderer/src/components/AgentComposer.tsx` |
| 方向键在候选间导航 | `git grep -n "event.key === 'ArrowDown' \|\| event.key === 'ArrowUp'" HEAD -- apps/desktop/src/renderer/src/components/AgentComposer.tsx` |
| Escape 关闭菜单 | `git grep -n "event.key === 'Escape' && suggestions.length" HEAD -- apps/desktop/src/renderer/src/components/AgentComposer.tsx` |
| 菜单高度受限、不推动底部工具栏 | `git grep -n ".composer-menu { max-height" HEAD -- apps/desktop/src/renderer/src/styles/composer.css` |
| `/` 命令与 `@` 引用已接到生产 composer | `git grep -n "references={activeFile ?" HEAD -- apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx` |

### 还没落地的一半（`$` 技能触发）

| 缺口 | 判别命令 | 期望结果 |
| --- | --- | --- |
| 生产 composer 没给统一菜单喂 skills | `git grep -n "skills=" HEAD -- apps/desktop/src/renderer/src/components` | **零命中**（没有任何 `<AgentComposer skills=…>`） |
| 组件 skills 参数是默认空、无生产覆盖 | `git grep -n "skills = \[\]," HEAD -- apps/desktop/src/renderer/src/components/AgentComposer.tsx` | 命中默认空——证明 `$` 菜单在生产里恒为空 |
| 技能仍活在被收敛的旧下拉里 | `git grep -n "loadSkills={() => api.ui.listAgentSkills" HEAD -- apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx` | 命中——旧入口还在，说明"收敛"未完成 |

测试（从仓库根跑，剥掉环境）：
`env -u AGENTMUX_AGENT_SESSION_STORE -u AGENTMUX_HOOK_URL -u AGENTMUX_HOOK_TOKEN -u AGENTMUX_HOOK_EVENT -u AGENTMUX_AGENT_SESSION_ID pnpm exec vitest run apps/desktop/test/composer-tools.test.ts apps/desktop/test/composer-file-reference.test.ts apps/desktop/test/markdown-file-reference.test.tsx`
→ **Test Files 3 passed, Tests 26 passed**。
**注意**：这三个是 tasks.json T-001 verification 里点名的文件，但它们测的是技能发现、文件引用解析等**周边**，
**没有一个**直接断言 `.composer__suggestions` 这个内联触发菜单的三路行为。所以"测试全绿"证明不了触发菜单
被守着——机制在场靠上表的 grep 判据证明，而不是靠这三个测试。要收口 T-001，缺的正是给 `$` 接线 + 一个
真断言内联菜单三路（`/ $ @`）都出候选的测试。

## 原文四条验收，各自的落点

原文（state.json goal）：「让 /、$、@ 触发统一可访问候选菜单，支持方向键且不挤压工具栏。」
tasks.json T-001 的三条 acceptance：

1. **「/、$、@ 均能打开正确候选并选择」——机制齐，`$` 数据源缺。**
   三路映射与浮层都在（`suggestionKind` + `source`）；`/`（命令）和 `@`（引用）在生产里有数据喂进去、
   点选经 `onSelectSuggestion` 回调；`$`（技能）在生产里数据源为空，键入 `$` 打不开非空候选。
2. **「方向键、Enter、Escape 可用」——已落地。** ArrowDown/Up 在 `.composer__suggestions button` 间
   循环聚焦（且让 IME 组字键先走，见 #609）、Escape 收起、Enter 的提交/入队语义与候选导航分离。
3. **「菜单高度受限且不推动底部工具栏」——已落地。** `.composer-menu` 有 `max-height: min(50vh, 360px)`
   且 `overflow-y: auto`；内联候选浮层 `.composer__suggestions` 在 DOM 里位于 `.composer__toolbar`
   之后、`</details>` 之前，作为浮层出现而不撑开工具条那一行。

## 既定决策

- **候选导航必须让 IME 组字先提交。** 方向键与 Enter 的处理器都过 `isImeCompositionKeyDown` 四路谓词
  （#609）：只标记其中两路会把半转换草稿提交上去。这是既有约束，`$` 接线时不得绕过。
- **Enter 的"提交/入队"与"候选导航"是两个轴，别用一个 flag 兼管。** 运行中的 Agent 显示 Stop 仍可被
  steer，所以候选浮层的方向键处理必须先于历史回溯、且都不碰 `canSubmit`。

## 边界

- 这个 Feature 只管**消息输入框里 `/ $ @` 的内联触发候选菜单**：触发识别、三类数据源接线、浮层的键盘
  可达性与紧凑布局。它**不**拥有：技能的发现与解析（`api.ui.listAgentSkills` / `listWorkspaceSkills`
  是既有能力，本 Feature 只是把它接到 `$` 触发）；Provider 命令目录的来源（`composerOptions.commands`
  另有归属）；文件引用的实际插入语义（`addFileReference` / `insertReference`）。
- **收口 T-001 的最小动作**：在 `AgentSessionComposer.tsx` 给 `<AgentComposer>` 传 `skills={…}`
  （从 `api.ui.listAgentSkills` 派生 `{text:'$'+name, description}` 列表）并在 `onSelectSuggestion`
  的 `kind === 'skill'` 分支落地选择，然后加一个直接断言内联菜单三路的测试。旧的 `AgentComposerTools`
  技能下拉是否同时移除，属"菜单收敛"的范围，需按当时设计再定——但那不影响本 Feature 的核心：`$` 要能在
  统一菜单里出候选。
