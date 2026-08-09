# f-2398feb76 独立实现审查（T-003 收尾）

日期：2026-08-29
审查者：主 session
方法：读代码 + 实测变异验证

## 用户原话

> Topic 的 item UI, AI 味儿有点太重了
> 且 Topic 的 listitem 上应该要显示所有 Agent 的运行状态
> Topic 的 itemlist 也支持拖拽改变顺序吧

## 一、"AI 味"的来源与处置

改造前一行塞了**四层**信息：

```
标题 + [Current] 标签
摘要 · 2 agents
[图标 codex-abc] [图标 claude-def]     ← 每个 Agent 一枚全名胶囊
```

问题不是排版，是**把同一件事说了两遍**：

- `2 agents` 与其下逐个 Agent 胶囊说的是同一件事；
- `Current` 文字标签与整行高亮说的是同一件事。

两处冗余都已删除。这是这类列表读起来机械的主要来源——不是字体或间距的问题。

## 二、显示 Agent 运行状态 —— 通过

改造前 `workspace-topic-agent` 只有一个 `live` 布尔，**看不出在等你还是出错了**。

现在每个 Agent 一枚状态点，经纯函数 `topicAgentPresentation`
（`surface-tool-dock.ts`）投影，**复用既有 `categoryFor` 与 `status--<state>` 语汇**，
与 Tab 角、名册行、注意力栏同源——不发明第三套。

没有 live Session 的协作者如实报 `disconnected`：它在磁盘留了记录但此刻没在跑，
假装它在运行会让整行的状态失去意义。

行内 CSS 只管排布不定义颜色，颜色仍来自共享 status 语汇（改一处三面一起改）。

## 三、拖拽排序 —— 通过

**复用 `@dnd-kit/sortable`**（Tab 条已在用同一套，依赖早在 `package.json`），
不引新库、不自写拖拽。键盘 sensor 一并挂上，重排不因为"改成拖拽"而只剩鼠标一条路。

关键设计：**用户顺序是一份偏好，不是真相来源**。

今天的顺序来自 `scratch-topics.ts:165` 的目录名字典序——`topicId` 由时间戳派生，
约等于创建序：稳定，但用户改不了。拖拽引入用户意图后，它必须与
"文件系统随时可能多出或少掉一个 Topic"共存：

- 磁盘上没有的 Topic **不会**因为排过就凭空出现；
- 没排过的 Topic 保持**彼此之间**的既有次序落在后面——新建一个不该跳到不可预期的位置。

顺序纳入既有 `partialize` 持久化，拖过的顺序重开仍在。

## 四、变异验证

| 注入的缺陷 | 结果 |
|---|---|
| 偏好里已删除的 Topic 会凭空出现 | **1 failed** |
| 没排过的 Topic 直接消失 | **4 failed** |

均已还原并 diff 确认逐字节一致。

## 五、零调用者检查

- `orderTopics` → `SurfaceToolDock.tsx:378`（列表渲染前排序）
- `reorderTopics` → `:506`（`onDragEnd` 写回顺序）
- `topicAgentPresentation` → Topic 行的状态点渲染
- `SortableTopicItem` / `DndContext` → 6 处引用，真挂在列表上

均有生产读写，非死代码。

## 六、门禁

`pnpm test:fast` **1343 passed / 0 failed / 3 skipped**；
`pnpm --filter @agentmux/desktop typecheck` 通过。

## 结论

无 blocking 发现。未新建第三套状态语汇（复用 `categoryFor` + `status--<state>`），
拖拽后顺序持久且与文件系统变化共存，两条边界均有在被破坏时变红的断言。
