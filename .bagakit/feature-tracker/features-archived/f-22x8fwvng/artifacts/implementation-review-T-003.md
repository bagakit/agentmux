# f-22x8fwvng 独立实现审查（T-003 收尾）

日期：2026-08-29
审查者：主 session
方法：对着工作树真实代码核对 + 实测变异验证

## 背景：这个缺陷曾经卡住四个 feature 的门禁

用户原话：「Scratch 里一个 Topic 应该能容纳多个 Agent，而不是每创建一个 Agent 就变成一个 Topic」。

缺陷根因是 `topicId ?? tabId` 的派生：因为 `launcher:<uuid>` / `view:<uuid>` 这类 Tab id
在结构上恰好满足 Scratch Topic-id 的文法，这个 `??` 会**静默地为每次启动铸出一个新 Topic**。

审计时发现，固化了该缺陷的断言（`workspace-selection.test.ts:587` 断言
`scratchTopicId === tabId`）是当时全仓**唯一**的失败测试，并因此让
`pnpm check` 长期红着，连带卡住 f-22v8frrxw、f-22z8fapnn、f-22r8feyju、f-22y8fh4jr
四个 feature 的统一门禁——它们各自的代码其实早就好了。

## T-001 停止用 tabId 当 topicId —— 通过

两条启动路径都已收敛为「只读 View 的显式绑定，缺失即不绑定」：

- `store.ts:1268` （control 路径）：`plan.tabs[plan.tabId]?.topicId`，无 `?? plan.tabId`
- `store.ts:2170` （launchAgent 路径）：`targetTab.topicId`，无 `?? targetTab.id`
- 两处都保留 `isScratchTopicId` 校验：非法 topicId 仍 fail closed，不静默降级为无 topic。
- 没有为旧行为留 fallback——按项目原则，缺陷直接删。

**注意 `createScratchTopic`（store.ts:1939）仍有 `targetTab.topicId ?? targetTab.id`，
这不是缺陷**：那条路径是「新建一个 Topic 并让当前 View 成为它的 owner」，
Topic id 与 owner Tab id 同值是该设计的有意选择（durable owner View），
与「启动 Agent 时凭空铸 Topic」是两回事。审查确认后不动它。

## 修正被固化的错误断言

`workspace-selection.test.ts` 那条测试的**意图**（"binds a launched Agent to its View Topic"）
仍然有效，问题在于它的 setup 从一个**未绑定 Topic** 的 View 启动，却断言 Topic 被铸出来。
已改为：先 `createScratchTopic()` 得到真实绑定，再断言启动携带该 Topic id；
并**新增**一条反向用例——从未绑定 View 启动时 `scratchTopicId` 必须缺席，Tab 也不得获得 topicId。

## T-002 Topic 面板 —— 通过

`surface-tool-dock.ts:126 topicsWithAgents` 把每个 Topic 的 Agent 投影为
「磁盘 collaborators ∪ 活跃 Session 投影」，按 sessionId 去重。

- **Topic 列表是文件系统快照，Session 只被匹配上去**，绝不用于反推或发明 Topic。
  `scratch-topic-agents.test.ts` 有一条专门的负向断言：快照未列出的 Topic 目录里跑着的
  Agent（"ghost"）不会让那个 Topic 出现在结果里。
- 零 Agent 的 Topic 保留空列表而非消失。
- 切换复用既有 `openScratchTopic`，不新建第二条导航路径。

## 变异验证（实测）

把两条启动路径的 `?? tabId` 派生**注入回去**：

```
npx vitest run workspace-selection.test.ts scratch-topic-agents.test.ts
→ Tests  3 failed | 22 passed (25)
```

3 条断言变红，跨两个测试文件。变异后已还原并确认第 1268/2170 行回到正确形态。
这证明这些断言能守住不变量，不是空测试。

## 门禁

`pnpm check` 实测全绿：typecheck + 1208 passed / 0 failed / 3 skipped + build 成功。
（这正是修掉本缺陷后才达成的状态。）

## 结论

无 blocking 发现。未出现第二份 Topic Registry，无从 View 反推 Topic 的残留，
测试能在 topicId 被重新派生时变红。
