# f-2388fkprc 独立实现审查（T-002 收尾）

日期：2026-08-29
审查者：主 session
方法：读代码 + 实测变异验证

## 用户原话

> Scratch 切换时 Topic 对应的 Tab 组也应该切换, 就像是项目的 Branch 选择切换一样

## 根因（值得记录）

切 Branch 之所以**天然**换掉整条 Tab 条，不是因为写了切换逻辑，而是因为
`layouts` 按 **workspaceId 键控**（`store.ts:210`），而每个 worktree 就是一个独立 workspace。

Scratch 的所有 Topic **共用同一个 workspace**，于是共用同一套 layout ——
切 Topic 时别的 Topic 的 Tab 仍留在条上。用户要的是同一种体验。

## 设计取舍：不新增数据维度

`tab.topicId` 已经存在（`workbench-tabs.ts:71`），因此**按它过滤即可**，
不必给 Scratch 造一套「每 Topic 一份 layout」。

- 布局仍只有一份，过滤发生在**渲染时**（`scratch-topic-layout.ts` 纯函数）；
- Topic 的真相仍在文件系统；
- **不建第二份 Tab 状态**——那正是需要互相同步的熵增。

## 两条边界（均被测试守住）

1. **未绑定任何 Topic 的 Tab 始终可见**。它不属于任何 Topic，藏起来就再也找不回了。
2. **活动 Tab 跟着 Topic 走**，判据是"它属于这个 Topic"而**不是**"它还看得见"。

第 2 条是写测试时逼出来的真实缺陷：初版判据是 `tabOrder.includes(activeTabId)`，
于是一个未绑定的 Tab（始终可见）会在切 Topic 后**继续当活动项**——
用户切过去却什么也没发生，看到的仍是刚才那一张。已修正为按 topicId 判定。

## 变异验证

| 注入的缺陷 | 结果 |
|---|---|
| 活动项退回"还看得见就保留"（即上面那个缺陷） | **1 failed** |
| 未绑定 Topic 的 Tab 也被藏起来 | **3 failed** |

均已还原并 diff 确认逐字节一致。

## 端到端可达

- 切 Topic 的动作写入状态：`store.ts:2150, 2159`（`openScratchTopic` 的两条分支——
  复用既有 View 与新建 launcher——都设置 `activeScratchTopicId`）。
- 渲染层真的经过纯函数：`WorkspaceWorkbench.tsx:819` 用 `useMemo` 包住
  `layoutForActiveTopic(storedLayout, tabs, activeScratchTopicId)`。

零调用者检查：`layoutForActiveTopic` 与 `activeScratchTopicId` 均有生产读写，非死代码。

## 门禁

`pnpm test:fast` **1327 passed / 0 failed / 3 skipped**；
`pnpm --filter @agentmux/desktop typecheck` 通过。

## 结论

无 blocking 发现。未出现第二份 Tab 状态，未绑定 Tab 不会丢失，
两条边界都有在被破坏时变红的断言。
