# 认得出是哪一格、哪个 Agent 在干什么：四处身份与近况的补齐

Contract: `bagakit.feature-goal.v1`
Feature: `f-2688fn733`

## 目标

用户报的四件事，共同的病是「界面上有身份和近况，但没地方看」。四处各缺一块，但缺的是同一样
东西：一个共享的「session → 最近在做什么」派生，以及把它端到用户眼前的那个位置。

## 状态：四件事都已落地（2026-09-14 逐条核对）

**这份 goal 原来的描述已经过期**，下面每条都给了判别命令。它此前停在 `proposal`、`tasks: []`，
而四件事已经写完并挂进生产——照着原文再做一遍，等于重建四个已存在的模块。本文档的作用就是
挡住那次重建。

| 用户的诉求 | 落在哪 | 判别命令 |
| --- | --- | --- |
| (1) region 的名字没地方看，建议做成 Message Tools 水印 | `lib/region-display-name.ts` → `AgentComposer.tsx:174` 的 `composer__region` | `grep -n composer__region apps/desktop/src/renderer/src/components/AgentComposer.tsx` |
| (2) CPU · Memory 要看得出每个 agent 最近在改什么 | `lib/resource-usage-panel.ts` 的 `activity` 字段 → `resource-usage__activity` | `grep -n resource-usage__activity apps/desktop/src/renderer/src/components/ResourceUsagePanel.tsx` |
| (3) 左下角每一档都能点开，展示该状态下的项目-Agent 树 | `lib/agent-tree.ts` → `AgentRoster.tsx` 的 `AgentTreePanel` → `AgentStatusBar.tsx` 三档 | `grep -n AgentTreePanel apps/desktop/src/renderer/src/components/AgentStatusBar.tsx` |
| (4) 项目树 hover 菜单里每个 Agent 要体现最近在做什么 | `lib/project-activity-row.ts` → `ProjectActivity.tsx:136` | `grep -n projectActivityRow apps/desktop/src/renderer/src/components/ProjectActivity.tsx` |

## 原文里已经不成立的五条前提（**不要据此重新调研**）

1. **「AgentRoster 已完整写好但全仓无人挂载」——已挂载。** `App.tsx` 渲染 `AgentStatusBar`，后者在
   working / needs-you / error 三档各挂一个 `AgentTreePanel`，而它调 `buildAgentTree`。
2. **「projectSessionReason（未导出）是最接近的一份」——这个符号已不存在。**
   `grep -rn projectSessionReason apps/desktop/src` 只剩 `session-recency.ts` 的两行注释，
   记的是合并前的历史。今天唯一的派生是 `sessionRecentActivity`。
3. **「散成 projectSessionReason / stepSummary 两份且都不共享」——已收成一份。**
   `sessionRecentActivity` 是唯一入口，`stepTitle` 被它复用而不是并列的第二份判据；
   四个消费面都走它。
4. **「agent.css 已 398 行，400 行是强制上限，必须先拆样式表」——已拆完。** 现在 237 行，
   两个浮层样式搬进了 `overlays.css`。这条前提当时是对的，拆分也确实先做了。
5. **「region 根本没有 name 字段，只有 regionId」——字段层面仍然成立**，但结论变了：显示名不来自
   字段，而由 `regionDisplayNames(regions)` 从兄弟格集合里派生（同名才编号）。水印与换位菜单
   共用这一次派生，不存在第二份编号逻辑。

## 既定决策

- **「这一格叫什么」取决于兄弟格，所以取名函数收全集而不是单格。** `regionDisplayName(regions, id)`
  内部跑 `regionDisplayNames` 再挑一个出来——`(region) => name` 那种形状不可能正确（`Terminal`
  只有在另一格也叫 `Terminal` 时才成 `Terminal 2`），因此根本不提供。
- **近况派生不读时钟。** 新旧用 session 状态这个手上就有的粗信号判，不掐表：`streaming` 的工具调用
  任何状态下都算「此刻」，`complete/failed` 的只在 session 仍活跃时才算，否则它是历史。
- **时间轴缺席时如实退回状态答案，绝不谎报 `Idle`。** 时间轴是按需拉取的，绝大多数 session 多数
  时候没有——把「还没加载」画成「真的闲着」属于原则 11 的 class 3：判不出就别猜着当真。
- **仓根要一路传到 `stepTitle`。** 两个窄面板都再被 CSS `text-overflow: ellipsis` 截一刀，而 CSS
  永远吃尾巴——正是路径的识别位。实测 984 个源文件，236px 面板上文件名可读率 0%（不传根）；
  传根后 270 个文件的 JS 输出真的变短。这不是排版偏好，是这行字的识别力本身。

## 还没做的（有意的）

- **OSC 0/2 终端标题。** 参考实现会读终端自报的标题，我们只有 `Terminal 2` 这种位置编号。
  但多数 shell 默认吐 `user@host: ~/dir`，**每格都一样**——那和位置编号一样没有识别力，
  正撞上《控件语言》那条「一列全同的不是信息，是宽度」。要做得先定义「什么样的标题才算身份」，
  那是比接一个 handler 更大的决定。注意这条**不**受「绝不从终端字节推断语义活动」那条红线约束：
  显示名不是活动。
- **资源面板不做中段省略、不加宽。** 无损缩短已经解决大部分；那两条各有自己的取舍。

## 边界

这四处只表达**身份与近况**，不表达运行状态的裁决——「有几个在干活」仍然只有
`sessionBoardColumn` 一处裁决点，本 Feature 的新模块都委派给它，不自己判。
