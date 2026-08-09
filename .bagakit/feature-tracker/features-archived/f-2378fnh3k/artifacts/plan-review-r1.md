# 寻址与复制：设计方案（f-2378fnh3k 计划审阅证据）

日期：2026-08-29
状态：**approved**（用户在对话中确认了设计理念与推进顺序）

## 用户原话（逐字保留）

> 我发现现在有复制 tab id, 但是 tab 里的多个分屏可能是不同的 agent 或进程,
> 所以, 应该也支持通过 tab 内的 id 来寻址?

> 这些应该加进 Tracker 里头一起做，而且要好好设计一下。
> 因为从目标出发的话，**copy 一个信息其实是 copy 一个寻址方式**，所以要确保 copy 出去以后，
> **通过这一次 copy，就能够让接收方把寻址方式弄清楚**

> 然后这个功能也要加入到在某一个分屏上右键点击的菜单里面，对吧？

> 或者不叫分屏的菜单吧，可能就叫做 **region 的右键菜单**

> 所以你提到的这些，包括分屏上的按钮、Tab 上的按钮、Handoff 里的信息，以及 Tab 的概念、
> Session 的概念，可能还有一个分屏（或者叫 region）的概念，**都需要统一**。
> 这应该是一个完整的东西：从一个完整的设计理念到设计架构，到具体的方案（**要做到 SSOT**），
> 然后再到最终的实现。

## 现状审计（只读，含 file:line）

### Region 是一等概念，但 UI 层被整个跳过

三处都把 Region 当一等寻址目标：

- **设计合同**：`docs/design/agentmux-desktop-interaction.md:32` 正式定义
  "`Region` 是 View 内的内容 leaf"。
- **CLI**：`send --to-region` / `inspect --region` / `focus --region` / `open --left-of <region-id>`
  全部可用（`packages/core/src/agentmux.ts:255-262, 135, 273, 170-176`）。
- **skill 文本**：`agentmux-cli-help.ts:157-159` 明写四种身份边界并强调
  "Never treat these identities as aliases"。

**唯独 UI 没有任何 Region 入口**：全仓 6 处 clipboard 写入中，面向 Agent 寻址的只有 3 处，
全在 Tab 右键菜单，**没有一处能产出 Region 地址**。

### 三个复制入口的自足性评估

| 入口 | 复制内容 | 接收方能自足吗 | 多 Agent 分屏下 |
|---|---|---|---|
| Copy Tab ID（`WorkbenchTabContextMenu.tsx:121-124`） | 裸 `session:abc` / `view:uuid` | **否**——没说是哪层身份、该配哪个 flag | tabId 有效但 `--to-tab` 歧义失败 |
| Copy Session ID（`:129-134`） | 裸 uuid | **否**——同上 | **该项直接不出现**（`copyableAgentSessionIdForTab` 多 Agent 返回 null，`tab-control-handoff.ts:17-22`） |
| Copy Agent Handoff（`:125-128`） | 多行文本带命令 | 基本能 | 见下 |

### 最能说明问题的一处

`formatAgentMuxTabHandoff`（`tab-control-handoff.ts:3-15`）产出的文本里写着：

> Send to its Agent **when the Tab has exactly one Agent Session**...
> If send returns `MESSAGE_TARGET_NOT_UNIQUE`, choose an agentSessionId from the error candidates,
> then use `--to-session`

即：**我们已经知道 Tab 地址在分屏下有歧义，而解决办法是让接收方自己再跑一次 inspect 去消歧。**

按用户的标准（"通过这一次 copy 就能让接收方把寻址方式弄清楚"），这不合格：
歧义被转嫁给了接收方，而能消除歧义的那个地址（regionId）**明明存在、CLI 明明支持，就是复制不出来**。

### 事实：Region 地址技术上完全可行

- regionId 稳定：Tab 首个 Region 为 `region:${tabId}`（确定性，`workbench-tabs.ts:77-79`），
  split 新增为 `region:${uuid}`（`store.ts:883-885`）。
- 持久化：随整个 workbench 写入 localStorage，恢复时**不重新生成 id**
  （`workbench-persistence.ts:126-167`）；存活条件等价于其 Session 存活。
- 解析路径已存在：`send --to-region` 在 store 侧解析，非 Agent Region 报
  `MESSAGE_TARGET_NOT_AGENT`（`store.ts:1303-1306`）。

## 设计

### 一条原则

**复制出去的是一个寻址方式，不是一个 id。** 成品必须让接收方仅凭这一次复制完成寻址。

### 三级地址各司其职

| 地址 | 回答的问题 | 何时是正确的地址 |
|---|---|---|
| **Session** | 哪个 Agent | 跨 View 稳定；一个 Session 可投影到多个 Region/Tab |
| **Region** | 屏幕上哪一格 | **分屏下唯一无歧义** |
| **Tab/View** | 哪张完整工作面 | 仅当该 View 承载唯一 Agent 时可用于 Agent 寻址 |

### 歧义在源头消除

复制发生时我们知道用户点的是哪一格，接收方不知道。因此多 Agent 分屏时直接产出
**Region 地址**，而不是一段"先 inspect 再挑 candidate"的操作指引。

### 入口按其能消除的歧义就近放置

- **Region 右键菜单**（新增）：点哪格就是哪格，**不依赖当前聚焦**——
  想寻址的那一格往往恰恰不是聚焦的那一格。
- **Tab 右键菜单**（保留）：语义收敛为"整张 View"。

同一 Session 在两处产出的地址必须**逐字一致**：同一份真相的两个入口，不是两套格式。

### 不发明第二套语法

只使用 CLI 与 Control 面已接受的 flag；id 一律按 shell 语义转义（复用既有转义写法）。

## SSOT 落点

已写入 `docs/design/agentmux-desktop-interaction.md` 的
**「寻址与复制」**一节（紧随 Session/Run/View 身份边界之后，与之同源）。
实现若与条款冲突，改条款而不是让实现偏离。

## 任务拆解

T-001 地址纯函数（唯一 formatter）→ T-002 Region 右键菜单 → T-003 Tab 菜单同源收敛
→ T-004 统一门禁 + skill 一致性 + 独立 Reviewer。

T-002 与 T-003 都只依赖 T-001，文件面互不相交，可并行。
