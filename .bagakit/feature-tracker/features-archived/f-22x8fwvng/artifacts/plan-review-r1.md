# f-22x8fwvng 计划评审

Feature: `f-22x8fwvng` — Topic Holds Many Agents
计划修订: 1 · 评审结论: **approved**

## 用户原话

> 「Scratch 界面并不是每创建一个 agent 都是一个 topic 的。一个 topic 应该支持多个 agent，然后 topic
> 的切换主要是靠 Topic 自己的面板」

## 核实结果：数据模型**已经支持**一 topic 多 agent，是 UI 层把它绑成了一对一

**磁盘侧本来就是一对多**（`apps/desktop/src/main/scratch-topics.ts:227` `prepareAgent`）：
每个 agent 写成 `.agents/<providerId>.<sessionId>.identity.md`，并**追加**进 `snapshot.collaborators`
数组。也就是说一个 topic 目录容纳多个 agent 的身份文件，是既有设计。

**根因在 renderer**（`apps/desktop/src/renderer/src/store.ts:1258`）：

```ts
const scratchTopicId = isScratchWorkspaceId(workspace.id)
  ? (plan.kind === 'tab' ? plan.tabId : plan.tabs[plan.tabId]?.topicId)
  : undefined
```

开新 tab 时 **topicId 直接取了 tabId**。于是"新开一个 agent"必然产生一个新 topic——不是因为模型不支持，
而是因为启动路径没给用户选现有 topic 的机会。

这与 markdown、分栏那两条是同一类问题：**能力在，界面没接**。

## 设计合同已站在用户这边

`agentmux-desktop-interaction.md:22-24` 写明 Topic 来自**文件系统**、不从打开的 View 反推；
`topic--*` 目录与 `topicId` 保持稳定。用 tabId 当 topicId 恰恰是"从 View 反推 Topic"——正是合同禁止的
方向。所以这次修正是让实现回到合同，不是新增例外。

## 明确不做

- **不引入第二份 Topic Registry**：Topic 的唯一真相是 Scratch 文件系统（合同 Owner 边界表）
- **不改 `topic--*` 目录名或 `topicId` 的稳定性**：Agent cwd 与 View 绑定依赖它们稳定
- **不自动把已有 agent 重新归组到别的 topic**：那是猜测；本 Feature 只解决"新建时能选"与"切换靠面板"
- **不为兼容旧行为留 fallback**：用 tabId 当 topicId 是缺陷，直接删
