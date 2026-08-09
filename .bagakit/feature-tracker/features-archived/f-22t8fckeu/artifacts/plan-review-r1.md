# f-22t8fckeu 计划评审

Feature: `f-22t8fckeu` — Readable Agent Output and Reachable Panes
计划修订: 1 · 评审结论: **approved**
依据: 用户两条要求 ——「对话模式中应该支持渲染 markdown，但注意多级标题不要有字号上的区别」，
以及「现在我让 Agent 在右边打开一个东西的时候，它好像不知道自己可以打开一个页面」。

## 核实结果一：分栏能力**早就有了**，缺的是发现

`agentmux-cli-help.ts` 已经文档化 `open terminal`、`open browser --url`、以及 `arrange`；
`agent-launch-prompt.ts` 也在启动时注入了「涉及 tab、split、方向时先跑 `--skill`」。

所以用户的抱怨不是"不支持分栏"，而是 **Agent 发现不了自己有这套工具**。这改变了工作的性质：
要做的是可发现性（提示与 skill 文本），不是新增 surface 或新框架。

## 核实结果二：markdown 该改的是 Turn，不是 Row

对抗复核指出原 scoping 搞错了寄存器，**我逐行核实后确认它对**：

- `ActivityView.tsx:273` 的路由：`isTurn(...)` 的走 `Turn`
- `Turn` 的正文在 **`:200` 的 `log-turn__body`**
- `:177` 的 `log-row__prose` 是**机器行**路径

照原 scoping 做会把 markdown 加到机器行上，而对话回合仍是纯文本。**只改 `:200`。**

## 核实结果三：仓库**没有任何** markdown 或 sanitiser 依赖

`package.json` 三处全查：无 marked / markdown-it / react-markdown / remark / dompurify。这决定了
安全设计——agent 输出是**不可信文本**，绝不能变成 live HTML。

因此选择**自己实现受限子集**而非引入依赖：需要的构造很少（代码块与行内代码、列表、强调、标题、链接），
而引入一个 markdown 库就同时引入了"必须正确 sanitise 它的 HTML 输出"这份责任。受限子集直接产出
React 元素，从不经过 `dangerouslySetInnerHTML`，风险面因此为零而不是"已被清理"。

## 标题不靠字号分级——这与既有合同一致

`agentmux-surface-density.md` 已有规则：字号下限 10–12px、不用极小字号冒充密度、Activity Turn Row
的正文是 13px/1.6。用户的约束正好与之相合：**标题用字重、颜色与上下留白分级，不用字号**。

## 链接必须走既有出网 seam

Agent 输出里的 http 链接是真实的逃逸口。必须经既有的 `openExternal` / external-url 通路，
不得渲染成裸 `<a href>`。

## 一条被我判定不成立的挑战

对抗复核称 T-001 的 gate（断言 skill 文本包含某字符串）"改动前也可能通过，故无用"。**这条成立**，
已据此改掉：可发现性的 gate 不断言文本包含什么，而断言**注入的启动提示确实到达每个 provider 的
启动路径**——那是一个改动前必红的行为断言。

## 明确不做

- 不引入 markdown 依赖，不用 `dangerouslySetInnerHTML`，不渲染 raw HTML passthrough
- 不给标题分配不同字号
- 不为"agent 驱动 UI"新建框架：`open`/`arrange` 已经是那套接口
- 不改机器行（`log-row__prose`）的渲染：那里是 payload，不是给人读的散文
