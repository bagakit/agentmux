# Provider、身份与 Agent 消息

本文集中本主题的交互与行为要求。已确认约束定义必须成立的结果，不代表当前实现通过验收；提案、历史与当轮授权状态按正文的明确范围阅读。

[返回交互合同](../agentmux-desktop-interaction.md) · [同主题视觉](../presentation/agent-capabilities-and-messaging.md)

**本页章节**

- [AgentMux 消息与分享格式](#agentmux-消息与分享格式)
- [AgentMux 注入上下文](#agentmux-注入上下文)
- [启动握手与自命名](#启动握手与自命名)
- [交出去与派出去](#交出去与派出去)
- [持久消息的显式消费与派发等待](#持久消息的显式消费与派发等待)
- [Agent 已经这样多久了](#agent-已经这样多久了)
- [Provider Launch Option](#provider-launch-option)
- [Provider 能力对齐与移植边界](#provider-能力对齐与移植边界)
- [注意力处理与结果审查闭环](#注意力处理与结果审查闭环)
- [Agents 入口与 Activity 详情归一](#agents-入口与-activity-详情归一)
- [Agents、队列与 Message Tools](#agents队列与-message-tools)
- [Provider 与人机交互的分层收敛](#provider-与人机交互的分层收敛)
- [Steer 与 Provider 输入能力](#steer-与-provider-输入能力)
- [Executor 标识的归属](#executor-标识的归属)
- [插件扩展边界](#插件扩展边界)
- [状态投影、Browser 页面与 Scratch Topic 工作面](#状态投影browser-页面与-scratch-topic-工作面)
- [Executor 身份组件与信息面板](#executor-身份组件与信息面板)
- [工作状态与 Executor 叠加标记](#工作状态与-executor-叠加标记)
- [Agents 全局层级与拓扑图](#agents-全局层级与拓扑图)
- [Claude Prompt 提交](#claude-prompt-提交)
- [P0 的共同交付边界](#p0-的共同交付边界)
- [跨重启的 Prompt 投递凭据](#跨重启的-prompt-投递凭据)
- [Hook 配置隔离与非 AgentMux 会话](#hook-配置隔离与非-agentmux-会话)
- [A2A 身份信封与持久化全局消息队列](#a2a-身份信封与持久化全局消息队列)
- [A2A 消息要让人一眼看懂](#a2a-消息要让人一眼看懂)
- [按 amux id 搜索 Agent](#按-amux-id-搜索-agent)

## AgentMux 消息与分享格式

AgentMux 提供的对话与分享外框在此集中导航：平台说明、对象分享与跨 Session 消息来源各有用途，具体合同仍由下列专题唯一持有。本文的格式导航不改变原消息角色、内容归属、寻址身份或授权；外部 Skill 声明包、Provider 原生消息与机器回执沿各自 owner。

| 可读格式 | 用途 | 唯一合同 | 当前公共出口 |
| --- | --- | --- | --- |
| `<amux from="amux">…</amux>` | 随请求附带或独立投递的平台说明 | [AgentMux 注入上下文](#agentmux-注入上下文) | [Core `composeAgentPrompt` / `composeOutboundMessage`](../../../packages/core/src/agent-outbound-message.ts) |
| `--- amux : IDCard/Region/Tab/File/Browser ---` … `-----` | 可复制的对象地址与内容分享 | [寻址与复制](spaces-and-layout.md#寻址与复制) | [Core `formatAmuxSharing` 及对象格式器](../../../packages/core/src/sharing.ts) |
| `[Message from Agent <canonical Session ID>]` 加原正文 | Core 核验作者后的跨 Session 消息可读来源 | [A2A 身份信封与持久化全局消息队列](#a2a-身份信封与持久化全局消息队列) | [Core `renderAgentMuxMessageEnvelope`](../../../packages/core/src/agent-message-render.ts)，作者核验与持久投递仍归 Core |

## AgentMux 注入上下文

原《AgentMux 对 Agent 说的话》中平台自身生成的内容在此统一为注入上下文规范；跨 Session 通信继续由原 A2A owner 定义。

**AgentMux 注入上下文（AgentMux Injected Context）**指 AgentMux 自身生成、通过 User message 送给 Agent 的内容，用来明确平台说明与原请求的边界。这是内容归属，不改变 Provider 的消息角色，不另造运行时协议。外部 Skill 或作者声明包、Provider 原生注入、A2A 结构化记录及 RPC 回执不属于此规范；它们沿各自 owner，不能因正文看起来相似而合并。

- **用途与投递形式分别表达。** 启动引导、运行上下文和提醒是用途；独立发送、附加在原请求前是投递形式。同一用途不只限首条或独立发送，同一形式也不代表用途、触发频率或优先级。提醒列为用途不证明已有周期调度；默认与本次选择、未确认语义仍见[《System Reminder 的默认与单次选择》](conversation-input.md#system-reminder-的默认与单次选择)。本规范不新增独立持续提醒、开关或调度功能；已有自动推进只按下文在原发送时刻附带共享消息规则。
- **共享行为规则按职责单处定义。** 启动引导、运行时提醒与随请求附带的上下文按需复用同一职责 owner 的规则，不在各入口复制维护多份正文，避免语义漂移。这里只确定内容归属与复用边界，不新增规则注册表、配置层或调度设计。
- **只使用现有统一包装 `<amux from="amux">…</amux>`。** 平台自身生成的说明共用一个组装 owner，不按用途另造包装；`amux:xxx`、`type`、`topic` 等命名空间或额外属性不是当前规范。原始用户或发起 Agent 的正文保持独立且逐字节不被包装改写，不塞入属性、不被转义成另一种形状；普通用户 prompt 无需因此包裹。跨 Session 的来源头与作者核验只见[《A2A 身份信封与持久化全局消息队列》](#a2a-身份信封与持久化全局消息队列)，`from="amux"` 不能代替发起 Agent 的身份。
- **平台内容与原请求通过同一 Core 通路分开提交。** 启动和既有会话都由实际 producer 显式交出平台内容与原请求，Core 统一生成实际输入并沿既有记录分别保留平台内容与原正文；客户端不先拼混合信封再要求 Core 从标签恢复归属。原内容与格式化后的输入各有明确边界，普通正文、用户复制或编辑后的内容不能自称为受信平台记录。公开通路沿既有 Host、权限及 A2A 作者边界，不新增信任模型、规则 Store 或消息账本。
- **组合与读取必须解释同一边界。** 独立发送可以只有完整平台上下文；附加发送时上下文在原请求前，多个完整前导上下文按实际组装顺序保留。生成、实际输入、阅读展开与完整 Copy 必须一致，真实尾文不能被吞掉或补造；平台内容中的尖括号、实体或标记不能破坏包装边界或改变内容。本项定义一致性结果，不把尚未修复的生成与读取失配写成已满足。原记录内的阅读、引用与代码边界以及完整复制只见[《完整前导声明上下文的同记录阅读》](terminal-reading.md#terminal-连续向上阅读历史)。
- **文本声明不是已核来源。** `from="amux"` 可被用户、Agent 或其他输入伪造，不是认证、权限或信任凭据。平台归属来自实际 producer 与受信提交记录，不能从标签、首条位置、时间或旧混合正文反推 System。平台注入、Topic/Wiki 等历史内容也不能覆盖当前用户指令、权限或权威 Runtime、Session、Run、Project、Task 事实。声明阅读不创建消息或身份台账，不改变原作者、parts、顺序或 recorded time；未识别、不完整或含糊的声明保持全文可读，不扫描正文猜来源。
- **业务上下文与用户审批正文分开。** Goal/PMO 和 Goals 探索生成的职责、项目及执行上下文通过同一平台通路附带，用户选择或填写的请求保留原正文；平台说明引用的 Goal 描述、项目文字或外部内容不因此获得权限或当前事实资格。Browser 元素／批注分享仍沿[《寻址与复制》](spaces-and-layout.md#寻址与复制)的共用分享外框进入可编辑草稿，由用户审批后作为其正文提交；不解析分享外框或编辑后的 amux 文本来补造平台来源，也不因此自动发送。
- **Progress 保留用户 prompt，平台提醒复用共享消息规则。** 自动推进仍按原条件与原发送时刻提交用户配置的 continuation prompt，逐字节保留为用户正文；同次附带的消息使用要求来自上述共享职责 owner，作为平台内容走同一通路，不在自动推进入口复制规则。没有新周期、开关或独立 Reminder 任务；用户输入、草稿、暂停、停止及原 completion／input fence 继续决定是否发送，不因附带说明放宽资格。
- **组合内容跟随原投递身份恢复。** 同一 operation 的平台内容、原正文、来源分界和实际输入沿首次准入后的原冻结意图续做，重试或冷恢复不根据变化后的 Goal、规则正文或当前 Run 重组输入，也不重新发送未知正文。即使实际输入字节相同，后一次调用也不能将原用户正文重新声明成平台内容；无法确认原来源分界时保留未知，不从 wire 反推。新的内容冲突不能冒充原操作继续；保存、Native Input 接受、Provider 消费和阅读记录各自按原 receipt 表达，平台记录缺失或保存失败不能反推未投递或另建第二份消息。
- **注入失败不阻断健康 Agent。** 保存或投递未确认沿原 receipt 与服务窗如实说明，不假报送达、不自动重发，不取消已有可用输入、启动或健康 Run。阅读识别失败不等于未投递；本规范不增加恢复前置门，不改原 Session、布局、阅读位置或草稿。字节层的 bracketed paste 继续负责终端输入定界，不替代这层内容归属。

以下是当前源码机制与已知缺口；规范约束不代表实现已经满足。

| 当前路径 | 实际 owner 与状态 |
| --- | --- |
| 启动 guide、Scratch Topic/Wiki/SOUL | [Core `composeAgentLaunchPrompt`](../../../packages/core/src/agent-outbound-message.ts) 将 guide 与 `agentMuxNote` 放在同一 amux 包装；[Desktop `RuntimeController`](../../../apps/desktop/src/main/runtime-controller.ts) 提供 Topic note，[Core Client](../../../packages/core/src/client.ts) 从实际 producer 保留独立 `systemContext` 记录。 |
| Goal/PMO 任务上下文 | [Desktop `openGoalPmo`](../../../apps/desktop/src/renderer/src/store.ts) 将职责、项目与执行上下文作为显式 `agentMuxNote`，与原用户请求分开交给 Core；队列与同 Region 启动器分别保留原 note 和可编辑正文，重试不重算已冻结上下文，正文中的 amux 标签不升级为平台来源。 |
| Goals 探索与 Browser annotations | [Goals `startGoalExploration`](../../../apps/desktop/src/renderer/src/lib/goals-entry-actions.ts) 在原请求发起时冻结项目说明，以显式 `agentMuxNote` 沿原 Region 草稿与启动通路交给 Core，原正文独立保留；缺 Executor 或准备未确认时两者仍留在同一启动器。[Browser context formatter](../../../apps/desktop/src/renderer/src/lib/browser-annotations.ts) 沿共用分享外框，经 [Browser Tools Panel](../../../apps/desktop/src/renderer/src/components/BrowserToolsPanel.tsx) 加入可编辑草稿，用户编辑、审批后的整段仍按用户正文发送。两者均不新增专用信封或从正文标签恢复平台来源。 |
| Core 的普通提交、恢复与 Host 通路 | [Core `composeAgentPrompt`](../../../packages/core/src/agent-outbound-message.ts) 统一组合显式平台内容与原用户正文，启动引导委托同一组合 owner；独立热上下文不附加启动等待语。公开 SDK、Hosted RPC、Main 和 Preload 显式传递 `agentMuxNote`，Core 分别记录平台与原正文来源。首次 Input 的完整 wire、原来源分界与作者冻结在既有持久意图中；同一 operation 的相同 wire 不允许变更来源，缺原来源事实明确未知，保留原 Input 与健康 Run。原生 resume 保留用户空白与换行。 |
| Mailbox Progress | [Desktop Loop Manager](../../../apps/desktop/src/main/continuous-progress-loop-manager.ts) 在原符合资格的发送首次 claim 时保存原 `loop.prompt` 与 Core 同源共享消息规则；[Desktop `deliverContinuousProgress`](../../../apps/desktop/src/main/continuous-progress-delivery.ts) 将冻结的原正文与显式平台说明分开提交。同一次重试或冷恢复沿原 operation、condition 与内容；缺原内容事实明确未知，保留健康 Run 与手动输入。规则只伴随既有自动发送，无新增 Reminder 周期、任务或配置，用户 continuation prompt 不升级为平台自产内容。 |
| System Reminder | 目前为 proposal-only，尚无 AgentMux 主动持续注入；默认与单次覆盖关系已确认，正文、触发与兑现范围未定。状态与未决范围见上述 Reminder owner。 |
| 平台包装的生成与读取 | [Core `composeOutboundMessage`](../../../packages/core/src/agent-outbound-message.ts) 将平台内容序列化为 XML 文本节点；[共享 reader `parseAgentMuxMessagePrefix`](../../../packages/core/src/agent-message-render.ts) 读取精确 amux 开头、仅 `from` 属性及 XML 文本节点。真实启动 guide 的字面 `<canonical Session ID>`、平台 note 的尖括号与实体保持文本语义，完整包装可识别；原用户正文保持独立，阅读保留原声明 span 与尾文，完整 Copy 沿原输入。 |

## 启动握手与自命名

- **Agent 启动时应当先认识自己所处的环境**。今天的启动提示只在"需要分屏时"指向 `--skill`，于是 Agent 直到真的想开分屏那一刻才知道自己在 AgentMux 里——在此之前它既不知道自己是谁（Session/Region/Topic/Workspace），也不知道有哪些能力可用。因此启动时先做一次握手，让 Agent 从第一步就拿到自己的坐标与可用能力，而不是等到需要时才发现。
- **握手要一次问答就够，且不与 skill 争夺唯一真相**。返回坐标与能力清单，而不把完整 CLI 语法抄进提示（与上文同源：抄进去会在语法演进时立刻过期）。验收沿用同一条行为断言口径——证明启动路径确实携带并执行了握手，而不是断言提示文本里含某个字符串。
- `whoami`、启动引导与 `--skill` 的消息使用要求只见[《A2A 身份信封与持久化全局消息队列》](#a2a-身份信封与持久化全局消息队列)，不各自定义一套协作协议。
- **等命名能力齐备后，让 Agent 给自己起名**。名字的优先级链里已有"从成员/首条 prompt 派生"这一档（见[《显示名与身份》](spaces-and-layout.md#显示名与身份)），Agent 自命名是同一档上更好的一个来源：它比从首条 prompt 截一段更贴近这个 Agent 实际在做的事。它仍然**低于用户手改**——自动命名绝不覆盖用户意图这条不因来源变成 Agent 而松动。这条**排在命名链落地之后**，否则会先造出一个没有归属的名字字段。

## 交出去与派出去

- **"交接"必须是一个原子动作，不是一段靠措辞表达意图的普通消息**。Core 早就区分了两件事：**Handoff**（交出去，`originAwaits: false`，责任跟着工作走）与 **Dispatch**（派出去，原 Owner 仍要接问题、接升级、接收工）。唯一的分界就是 `originAwaits`，它留在 Core，命令面不复述也不重实现。用普通消息模拟交接的后果是"我以为你在管、你以为我交出去了"的悬空工作。
- **交接的发起者始终是人**。不引入 Agent 自主把任务派给另一个 Agent 的回路，因此 handoff **不夹带消息投递**——一旦它同时"转移所有权"和"投递指令"，那条被否决的回路就有了雏形。要送文本走 send/discuss，那是另一件事。
- **交接的目标用与位置无关的 Session 身份寻址**。多态寻址（Region/Tab）要过 Control 面解析成 Session，把一个原子动作拆成两跳，还让它依赖 Desktop 活着——而交出所有权不该有这个前提。
- **今天这条能力的语义前提尚未建立，界面不得假装它已建立**。`handOff()` 返回一个 frozen 的结果对象，**没有任何持久化落点、没有第二个读者**；更根本的是 **Core 没有 Task 实体**，`taskId` 是一个不指向任何东西的自由字符串。所以此刻能诚实展示的，只有那一次调用返回的事实（`ownerAgentSessionId` / `originAwaits`），**不能显示成"这个任务现在归谁"**——系统事后回答不了这个问题。补这个缺口要先有一个可被指向的实体，那是独立决策；在那之前，加一个 owner 字段存进去的是无人能验证有效性、无人知道何时算完成的自由文本，**比不存更糟，因为它看起来像事实**。

## 持久消息的显式消费与派发等待

- Core、默认 Provider 与非历史 CLI 的启动不得激活当前操作无关的原生读取依赖；未执行的读取不得以副作用污染当前结构化回执。真实历史读取仍保留原协议、只读与失败表达。
- 受管 Agent 应能实际“检查这一批消息，处理后明确确认”，不同进程在确认前拿到同一批身份和顺序；只能检查自己的收件，不能指定别人的消费游标。读取和确认不等于已投递、接受、回复、用户已读或需求完成，也不自动发送正文、创建、停止或恢复 Agent。
- 当前 Run 的凭证、Session 身份和持久消费批次必须相符。换 Run 后，新 Run 接管未确认批次，不丢原消息；旧 Run 的迟到确认或检查不能覆盖新绑定。失败说清是哪一步不可用，健康 Agent 仍可工作，不为消费增加生命周期门禁。
- 消息的消费、投递和监督等待都引用同一份持久消息身份与正文。队列由 Core 唯一持有，宿主和其受管 CLI 选择同一来源；明确注入的现有队列来源有权威，默认队列保持 durable，不能随 ctxmux 的临时版本端点回收。来源之间不猜测、合并、搬迁或静默宣称旧历史已纳入。
- Dispatch 监督的是针对真实消息的通信等待：发起者仍须接问题、升级、明确收工和收尾。不同问题消息分别保留，同一消息重放幂等；投递或游标确认不能解除该等待。只有经过参与者、当前 Run 和对话归属核验的明确收工报告才解除通信等待，不能据此显示“任务归谁”或把 Demand/Tracker 标成完成。Core 没有 Task 实体的边界仍见[《交出去与派出去》](#交出去与派出去)。

## Agent 已经这样多久了

- 用户需要知道“这个 Agent 已经这样多久了”：干了多久、等我多久、完成后闲置多久。Activity 明细采用 Core 已确认的当前语义状态起点；最后一次观察不等于状态起点，重复同状态的观察不得重置时长。
- 已确认的工作状态显示持续时长，并保留真实上下文压力；等待、完成和语义错误也各显示对应状态的持续时长。起点缺失、已失效、无法确认、来源不符或当前状态已衰减时，明确显示起点未知；进程活着、退出或断开本身不能证明空闲从何时开始。
- 完整 Session 更新必须忠实表达已有语义事实的新增和清除，包括观察时刻未变而旧起点已被清除的情况。时长不改变状态新鲜度、断开状态或输入可用性，不为显示时长生成第二份起点。
- 单 Agent 工作线在现有摘要行直接展示状态时长和上下文，不要求用户展开一张不能展开的列表。只有完成态 Agent 的项目仍保留 Activity 的紧凑入口，用户可以查看完成后的闲置时长；完成数量不升级为待处理告警。
- 静默等待的时长在打开且可见的 Activity 菜单中继续前进，关闭或窗口不可见后停止显示刷新；菜单内所有 Agent 使用同一时刻，不为每个 Agent 启动常驻计时或 Runtime 轮询。
- 注意力跳转保留现有“最早观察到待办”的顺序；该顺序不冒称等待最久。状态持续时长与最后活动时刻分开表达。
- 新状态观察到达时，时长必须使用该次实际渲染的当前时间；不能因菜单的秒钟还停在上一拍，把有效起点闪成未知。未来或不可信的来源时刻仍如实拒绝。

## Provider Launch Option

- Provider 以数据形式声明自己可供选择的启动项（例如 model、权限或沙箱模式）。每个 choice 把 UI 展示的标签与兑现它的 argv 写在同一处，两者不可能漂移。
- 契约分成两半：describe 半边是纯数据，跨 IPC 供 Renderer 渲染；argv 半边只留在 Core。**Renderer 永远看不到命令行**，Launcher 也永远不知道 Provider 的名字——任何调用点都不得按 `providerId` 分支决定启动项。
- 未声明即不渲染。Provider 落地速度不同是常态，没有声明的启动项在界面上完全不出现，而不是显示一个禁用控件。给某个 Provider 后补一项能力，不需要改动 Renderer 任何一行。
- 作用域是**启动时**，这不是过渡方案而是运行时的全部事实：Agent 是经 PTY 驱动的真实 CLI 进程，当前没有 Provider 走 ACP，不存在能让运行中进程改换 model 的通道。把选择编码进 spawn 时的 argv 是运行时唯一能兑现的形式，类型系统据实表达这一点，不得用暗示"运行中可切换"的控件掩盖它。将来某个 Provider 具备 ACP 后，实时能力作为**并列**的另一项能力加入，启动时这一条不被拆除。
- 只声明对着真实二进制核实过的 flag。核实不了的一律不声明——这正是部分 Provider 目前不提供任何启动项的原因。核实的对象是 Provider 真正的可执行文件（如 cursor 是 `cursor-agent` 而非 `cursor`），拿错二进制核实等于没核实。
- **不声明自由字符串 model**。gemini / grok / traex / hermes / antigravity 以及 codex / cursor 的 `--model` 都收任意字符串、无枚举，手写一张模型名清单会在厂商改动阵容时立刻过期，故一律不声明、依"未声明即不渲染"保持无按钮，绝不为对称而编造一张会过期的清单；只有当 CLI 自身 `--help` 给出可声明的取值才声明，且据实区分它给取值的两种方式——claude 的 `--model` 是**例举式**（`--help` 以 e.g. 举出 fable / opus / sonnet，并非严格 possible-values），我们只把这组指向"最新模型"的**稳定别名**据实声明（它同时也接受模型全名，但**全名不声明**，出自同一条会过期的理由），措辞按"稳定别名"表述、绝不写成一份穷举清单；claude 的 `--effort` 则是**严格 possible-values 枚举** low / medium / high / xhigh / max。核实到的是**枚举**才落一个选项：gemini `--approval-mode`、grok/claude/traex `--permission-mode`、codex/traex `--sandbox` 都是显式 possible-values；hermes `--yolo`、antigravity `--sandbox` 是布尔开关，落成两档 choice（保守档贡献空 argv，激进档贡献 flag）。每档 tier 据实标注：绕过审批或沙箱为 `danger`，收窄一类为 `caution`，保守默认为 `safe`（agy 的 `--sandbox` 是**加**限制，故开启档才是 `safe`，无沙箱的默认档为 `caution`）。
- **model 与 effort 不带 tier**。claude 的 model 与 effort 是仅有的两处按**能力**（而非权限）据实声明的启动项。RiskTier 分级的是审批/沙箱姿态的危险程度，而选模型或选推理深度既不放宽也不收紧任何权限——给它标一档 tier，会在名册行上打出一个无人记录过的假风险标记。claude 的启动项里只有 permission-mode 真正移动权限姿态，故只有它带 tier。
- Permission option 是并列的一套按 Provider 声明（见 `packages/core/src/agent-interaction.ts` 的 `TerminalPermissionOption`）：与 launch option 同构地拆成 describe/contribute 两半——DESCRIBE 半边（id/label/kind/description/tier）跨 IPC，CONTRIBUTE 半边（回答提示的 PTY 按键 `input`）只留在 Core，于 reply 时解析。两者的区别在于作用时机：launch option 作用在 spawn 的 argv，permission option 作用在运行中 Provider 自己的编号提示上；同样只声明位置稳定、对真实 CLI 核实过的行。
- Posture control 是第三套并列声明（见 `packages/core/src/agent-interaction.ts` 的 `PostureControlDeclaration` 与 `createPostureControl`），是 Composer 上"这些权限设置也要能在聊天框上设"这一诉求唯一诚实的兑现方式。它专治运行时的 live 权限姿态：与 permission option 同处 Provider 的 interaction protocol 声明，同样拆成 DESCRIBE 半边（`AgentPostureControl`：control 的 id/label + 每个 mode 的 id/label/description/tier）跨 IPC，CONTRIBUTE 半边（每个 mode 的 in-band 按键 `input`）只留在 Core，由 `planPostureSet(modeId)` 在 set 时解析、经既有 PTY-input 通道（`setAgentPosture` → `writeAgentInput`）写入。诚实性由结构强制：一个 posture control **必须**声明 ≥2 个 mode，每个 mode 的按键**非空且互异**——因此一个只有盲态 Shift+Tab cycle（一枚按键在读不到的状态间轮转）的 Provider 结构上无法被表达成 set-mode 控件，绝不会伪装成"切到 mode X"。**盲发按键是真实风险，故只声明效果确定、可寻址的控件**：仅当存在能指名目标态的 slash 命令时才声明。据此对着真实二进制复核后，只有 grok 合格——它的 `/always-approve [on|off]`（clap ValueEnum 核实）给出 Ask / Auto-approve 两个各由独立 slash 命令 SET 的具名 mode；claude、gemini、codex 只有盲态 cycle（codex 另有无法盲导航的 `/approvals` 弹窗），一律不声明，Composer 对它们不画任何控件（未声明即不渲染）。控件是 fire-and-forget 的 SET，不是有状态开关：Composer 从不标记"当前 mode"，因为 live 姿态活在读不到的 CLI TUI 里，标一个 active mode 就是谎称掌握了它——菜单只提供可寻址的目标态，当前落点归 CLI 自己。

## Provider 能力对齐与移植边界

- 用户要求「很多 Provider 的实现不完整」，全面分析后对照最新参考实现逐家完善，尤其是 Agent 的 Session 分析、对话模式与 trace 观察。每个 Provider 的能力闭环必须分别可验证：原生 Session 身份与记录解析、完整对话与资源顺序、工具与推理等观察事实、恢复与交互能力不能只凭启动成功或 Hook 存在宣称完成。已有参考实现的能力应核验并复用；缺少协议依据时如实保留未知或不支持，不能把观察缺口变成健康 Agent 的阻断。完善任务按 Provider 分开验收，共享协议与展示只有一个 owner。
- 用户进一步要求「实现达到成熟产品级别，且交互体验和性能远超竞品，所有功能你自己也要测试后满意」。Provider 完善必须经实际使用链与独立复核验收，覆盖真实身份接入、重启后原 Session 与工作面、对话阅读、trace 展开与完整复制；测试通过不替代交互验收。阅读与刷新只处理目标 Session 的有界记录，不因其他健康会话增加扫描或轮询工作。竞品比较须在相同输入、数据规模与观测条件下有实测证据，不能将结构更简单或合成测试更快直接称为领先。终端连续阅读及成本底线仍以[《Terminal 连续向上阅读历史》](terminal-reading.md#terminal-连续向上阅读历史)为唯一合同。
- 外部对照只提供对照证据，不是 AgentMux 的第二份 Provider 注册表。每个 AgentMux Provider 必须以真实可执行文件与真实运行回执为准，分别声明 launch、ready、Hook、permission、status、resume 与 reply-correlation 能力；未核实的能力保持未声明，不用 UI 对称性或终端字节推断补齐。
- 现有 Provider 的 parity 工作按能力闭环推进：Grok 与 Gemini 若二进制支持 native resume，就必须同时接通可信 native handle、resume argv、managed Hook 与事件字段归一化；Pi 的 resume 与扩展部署是两件事，不能只做 locator；Claude、Hermes、Cursor 的事件/信任细节分别按各自 CLI 合同接入。Cursor 没有 native resume 时必须明确保持 unsupported，不伪造恢复入口。
- Hook 入口同时接受厂商的 camelCase 与 snake_case 字段，但在 Core 内收敛到同一 canonical event；`sessionId` 等 provider-native handle 只能由对应 Provider 解释，不能由 ctxmux 或 Desktop 猜测。流程探测或 Hook 安装失败属于非阻断降级，必须在服务窗说明当前状态与恢复动作。
- 尚未纳入的 Agent 分成三类：具备完整 Hook/session/resume 证据的优先纳入；只有 status/Hook 的按实际需要纳入；只有 launch 配置或宿主专属 wrapper 的明确记录为暂不纳入。**同名不等于同身份**：TraeX (`traex`) 与 Trae CLI (`traecli`) 是两个不同 Provider，二进制与合同都不同，不得合并身份。
- 所有 Provider、Agent Session、Hook 与 semantic resume 逻辑归 `packages/core`；ctxmux 只持有 Run、PTY、ordered bytes、Replay、Gap、Attachment 与进程事实。Provider parity 不得在 ctxmux 复制第二套实现。
- 原生会话切换后，旧会话晚到的 Hook 只能保留为原始观察，不能覆盖当前会话身份、状态、用量、交互或工具记录。当前已知 native handle 与真实协议中的转换引用共同决定归属；缺少引用时不能按到达顺序、时间或正文猜。真实 native ID 已知而新记录文件尚未落盘时，身份与可恢复性分别表达，不能沿用旧会话的路径或阻断同一健康 Run 的普通输入。已核子任务对主轮的聚合结束语义保留；没有真实 turn 身份时，同会话旧轮与 ABA 仍明确未知，不伪造完成。
- 原生 reasoning 的空文本、缺失文本与被遮蔽文本要分清：合法空记录仍可查看，未知结构原样保留，不能借别家字段补正文。协议确有的 opaque signature 与 redacted 事实沿公共内容记录保全，不当可读正文或混入普通消息复制；只有可读复制内容时才提供 Copy，空或仅遮蔽的记录仍能展开，不能通过复制空字符串清空用户剪贴板。对话与历史仍复用原有 trace 折叠，工具结果只有图像时也保留真实调用关联与失败事实。

原生对话内容和身份确认不得以 Hook 送达为前提；公开说明、正式回答、工具及思考沿 Provider 原生记录读取，Hook 只可提供刷新线索。健康 active Agent 缺少已记录的原生身份时，可由对应 Provider 基于同 Host、同一当前 Run 的可信只读进程及开放记录事实确认唯一主会话；不得按 cwd、正文、时间、目录位置或子会话猜身份。确认结果保存在现有原生身份中，旧 Run 的迟到结果、并发不同身份与含糊事实不覆盖当前绑定。已有权威原生身份的读取仍不依赖 Runtime；身份确认、保存或读取失败保留原工作面、已读内容和健康输入，明确失败步骤及恢复动作，不新增另一份 Runtime、来源台账、历史 reader 或轮询。

当前健康运行会话的原生来源与已保存的历史来源分别核验；已有原生句柄不证明它仍是当前 CLI 的主会话。获取当前观察或明确刷新当前来源时，Core 可基于同 Host、同一当前 Run 的可信 Provider 事实有界核对并在原身份中原子确认唯一当前源；普通同源读页和历史分页不因此反复探测进程。观察资源存活期间，已确认但尚未保存成功的当前来源与其见证沿这份既有资源供同身份读页复用，不能让观察与正文退回不同来源，资源释放后不称耐久事实。同一已确认当前源已登记在另一 Session 时，读取权限不等于身份转移：核对唯一索引与耐久原记录一致后，沿既有观察资源及当前 Run／进程／开放记录见证只读复用，两个 Session 的原身份与来源都保留，不抢占或删除绑定。来源失效、任一确切绑定改变或消费者释放后停止该次临时读取；刷新通知也须通过同一当前见证，迟到结果不发布，不能因后来出现相同耐久句柄就把临时共享提升为身份归属。缺少当前事实、含糊来源或预算失败保留可读原记录、工作面与健康输入，明确核对步骤和重试动作，不把旧记录空页当成没有回复；确切 Host、Run、进程、原记录或并发绑定发生冲突时拒绝该次错误重绑定。离线、退役与 Runtime 暂不可用时，已保存来源仍沿原只读历史能力读取。真实来源改变不混用旧游标、身份或正文，不增加另一份来源台账、历史 Reader 或轮询。

原生对话读取必须持续采用 Provider 已记录的新输入，不能在过程窗口达到保留上限后永久停更；终端、Message Tool 或其他来源的原生输入都沿同一读取 owner，捕获投递记录仍保其独立来源。过程记录与对话发言分开控制保留，密集工具调用不能把仍在当前对话保留范围内的输入挤掉。保留原记录 ID、来源与实际顺序，重复正文的独立输入不能合并；被淘汰的旧窗口仍从原生 History 的 opaque 分页可达，不把有界窗口冒充完整会话或重建旧 Hook。当前同身份已有正文、选区与草稿在重读失败、覆盖或暂停时保留；隐藏消费者停止新增读取，迟到旧身份结果不得覆盖当前会话。客户端隔离上下文之间的取消订阅必须保留真实生命周期；跨桥接线不得使已保存原生消息的自动观察失效。取消仅释放本次 pending／live 观察资源，不能清空已读正文或阻断健康输入。

原生公开说明的阶段与协作结构只由 Provider 的正式记录解释，并沿同一公共 History item 保全；阶段缺失或未知不从正文、位置或时间猜。公开进度说明与正式回答可区分，但不等同隐藏推理、任务完成或作者认证。原生协作保原步骤 ID、sender／receiver native 引用、操作状态与目标最后已知状态，彼此不替代；native Agent 引用不能冒 AgentMux Session／Run 或当前 Runtime 状态。未知结构和附带内容仍完整可读、可复制，不增加另一套来源、身份 registry、记录缓存或轮询。阶段与协作的共同呈现只见[《可复用对话与 Workflow 表面组件》](conversation-input.md#可复用对话与-workflow-表面组件)。

## 注意力处理与结果审查闭环

- 用户能以更少操作完成「发现需要我 → 做决定 → 检查结果 → 继续运行」，并保持原来的工作区和 Session 上下文。
- Needs you 的集中入口应能直接显示具体 Session、请求内容和可执行回答；处理后可以继续进入下一项，并能回到原工作面。它复用 Core 的 typed interaction 和已有通知/Session 定位，不建立第二套 Inbox 或 Session Registry。
- Agent 完成后，结果附近应能直接进入工作区变更、已确认的开发预览或同一 Session 的后续对话。完成、变更存在、预览可用和任务成功必须分别表达，不能把停机或进程退出当成成功。
- 预览只能使用已确认的通用开发服务事实；没有端口、发现失败或服务状态未知时保留工作面并说明当前事实，不猜测 URL。
- 终端、对话、审批和审查切换时保留同一 Agent Session、草稿、附件和待回答交互；重连失败不能清空工作面或删除健康 Session。
- 移动端、语音、Watch、Push 和 Remote/SSH 不属于本轮闭环，后续必须基于 Core/ctxmux 的公开能力另立需求。

- Needs you 不保证一定有可回答的结构化请求；没有 typed request 时只提供定位原 Session 和真实状态，不能猜允许/拒绝按钮。聚合入口中的回答属于显式交互入口，不改变 Board 观察 Region 禁止发送和生命周期修改的约束。
- 请求以 Core 当前 Session、Run 与 request 身份为准。提交中禁止重复点击；失败保留问题与用户选择，不自动重发或跳过；旧请求已被替换时刷新投影，不把旧回答送给新请求。成功按 Core 确认收敛后才进入下一项；到末项返回空状态和稳定焦点，不自动批准下一项。 在 Focus 中关闭请求面板时，原请求入口仍可见就归还焦点；最后一项确认后入口已收起，则回到当前可见的检索控件。用户随后已转到其他控件时，关闭回调不得抢回焦点。
- 查看变更展示所属工作区的 Git 事实，明确它可能包含其他人或其他 Agent 的改动；无仓库、无变更、读取失败是不同状态。继续追问只聚焦同一 Session 的既有 Composer，不自动发送、创建新 Session 或暗中 resume。
- 明确的 HTTP/HTTPS 地址可以由用户输入或从当前 Session 的链接中明确选择，再使用既有 Browser 打开能力；地址合法不等于服务在线。多个地址由用户选择，不能挑最近端口或从其他 Session 借用地址。没有服务观测时显示尚未验证可用；自动扫描端口、自动启动服务不属于本闭环。
- 显示投影的失败不停止健康 Run；旧请求、无效地址等动作仍须拒绝错误目标，拒绝该次动作不等于阻断整个 Agent。切换可恢复原焦点和草稿；只有 Core 确认终局事实才允许移除对应 Session 投影。

## Agents 入口与 Activity 详情归一

- Activity 工作线展开的每个 Agent 必须显示所属 Project/Workspace、Provider、执行状态、最近活动与等待/停止时长；统计至少区分总数、running、needs you、error，缺失事实显示 unknown。
- Agents 列表只有一个主入口。左侧 Projects/Agents 工具作为统一入口，右侧重复的 Agents roster 不再单独占位；原有定位、筛选和状态统计能力并入统一入口。

## Agents、队列与 Message Tools

- Agents 二级菜单优先呈现对象、当前动作和下一步，不堆叠 provider、配置名、路径和重复状态；详细信息在展开或 hover 中补充。
- `running` 表示 Agent 已打开可交互，`working` 表示已打开且正在输出；两者在图标、文案和动态上必须有稳定区分。最近动作可得时优先显示动作，未知时才退回状态词。
- Agent 的用户显示名、Provider 名和配置名必须分别标注，不能把 Provider/配置名伪装成用户给 Agent 起的名字。
- 消息队列项必须可展开后删除或立即发送，保留原消息和失败原因，发件列表逐条表达受阻与失败，未读提醒通过统一邮箱红点表达。**「自动发送失败后停止重试」只对真的失败成立，不对「我们没看清」成立。** 这条原先写成无条件停止重试，那是把 AGENTS.md 第 11 条的第 2 类写成了第 1 类：readiness 还没观察到（`epoch-missing`）时 Agent 进程活着、PTY 照收字节，停止重试等于我们自己的观测没走通就把用户的消息判了死刑。用户原话：「即使当时发不出去，它也应该还是在队列里面一直等着，对吗？」——对。因此：Agent 仍可工作时，条目**留在队列里并继续等下一次可投递时机**，同时如实说明当前没投出去和原因。这里「如实说明」是硬约束而不是补充：投递受阻必须是一个**与正常排队并列的独立状态**，不能复用「排队中」那一档。只有两档（排队中／失败）时，受阻只能借「排队中」的文案，数量标识会**肯定地**说「N messages queued for delivery」，而真相是此刻投不出去——那是第 11 条的另一侧边界：不许静默降级。反过来也不许借「失败」那一档：Agent 好着，画成报错样子是往第 1 类说谎。所以三档各说各的话，且各自要求另外两档的说法**不在场**；受阻这一档要说清三件事——哪一步没走通、现在什么状态、要不要用户动手（不需要，会自动重试）。同一条受阻**只在第一次发现时上报一次**：用户刚敲完回车那次必须说（邮箱红点与收件通知让真正原因可发现），之后的自动重试保持安静——已读后的驻留状态由邮箱中的当前问题表达，不靠反复弹窗。只有 Agent 真的不能再工作（Run 已退出、进程已死、payload 从未被接受）才进终局并停止重试。
- **一个未投出的条目不得堵住它后面能投的条目。** 保序是「按作者顺序投递」，不是「卡在第一个上」。一个条目进了终局，队列不能因此整条停摆——那会让一次失败升级成整个 Session 再也发不出消息。
- Message Tools 使用独立于队列的图标和三态点击，三态改变的是**输入区自身的形态**：收起成一行（只留输入行与主动作，工具整排隐藏）、两行常态（输入行 + 一排工具）、大输入框（输入区放高供长文编辑，工具排仍在）。用户原话：「最左下角的 message tool 按钮才需要支持三态点击（收起成一行，支持展开两行可输入格式和大输入框）」。
- **三态的触发入口只有一个**，即工具行最左侧那枚键。用户原话：「而不是右边那个 collapse」——曾经并存的第二个入口（绝对定位在左下角、与这枚键共用同一枚图标的 disclosure）已废止：同一枚图标出现在两处，用户无法从图标区分两者管的是不同的事，而它们管的本就是同一件事。此后新增任何收起/展开手势都必须并入这一枚键，不得再长出第二个入口。
- **三档必须有真实可见的形态差异，切换入口始终留在左边。** 用户补充：「第三次切换好像没有变化」「换个更一看就懂的图标，且保持在左边」。空草稿和短文字切到大输入框也必须立即变高，不能只增加生长上限；回到一行时草稿、引用和编辑能力保留。唯一切换键用展开工具行、放大输入框、收回一行的动作图形与可访问名称说明下一步，不再用设置滑杆暗示它是参数设置。该键在三档里都在输入组件左侧，不随工具数目或分屏宽度漂到右边。
- **一行态里任何东西都不许叠在另一样东西上。** 用户原话：「现在 messagetools 收成一行的时候会叠在一起」。两行态下有两处不参与文档流、靠绝对定位待在输入框上方空白里的元素（Region 名水印）以及一排允许折行的工具按钮；收成一行之后，那片空白不存在了，绝对定位的元素正好落在工具条与主操作的位置上，而允许折行的按钮排在窄宽度下会叠成两层。约束是：**可读宽度足够时，一行态保持真正的一行**——没有安放位置的装饰性元素在该形态下不显示（其信息在别处仍可得，例如 Region 名在标签页上），控件排不折行。窄工作面不能为保持物理一行把草稿挤成两三个字一行；保留同一紧凑模式、编辑器、草稿与全部原动作，由密度 SSOT[《PMO Teams 浮窗的参考驱动简约规则》](../presentation/motes-and-coordination.md#pmo-teams-浮窗的参考驱动简约规则)定义输入与控件的让位。判据不是 z-index 谁在上面：叠在可点击控件上的装饰即使不吃点击，读起来也是糊成一团。
- 输入中的 skill/component/subcommand 以带下划线的语义 token 呈现，显示短名，hover 显示完整引用，点击打开对应交互或预置 prompt。
- **启动页的 message tool 与页面其余块同一条列居中，不许偏左。** 用户原话：「初始页面上 message tool 偏左」。启动页（Launcher / NewTabSurface）里标题、Agent 目录、命名输入与页脚都在同一条 640px 列内居中；message tool 是同一列的一员，必须与紧邻其上的 Agent 目录、其下的命名输入左右对齐。它复用会话 Composer 的表面样式，但会话 Composer 那份贴着 Region 边缘的侧向 inset 只属于 Region 内，不得让启动页这一块被钉到左缘。
- **启动页的 message tool 整个可见框都必须能打字。** 用户原话：「而且无法输入」。用户看到的输入框有多高，可编辑区就有多高——不许出现「上面一行能输入、下面一片是死区」：点击可见框的任何位置都落在可编辑元素上并放置光标，而不是点空、把已聚焦的编辑器 blur 掉。约束落在**可编辑元素自身**的高度上，不靠撑高它外层那个不可编辑的包裹容器（那正是死区的来源）。


## Provider 与人机交互的分层收敛

- AgentMux 接入多个 harness，不自行接管各 harness 的模型循环、工具执行、上下文压缩或内部任务真值。Provider 负责协议差异；Core 负责跨 Provider 的 Session、投递、交互与恢复语义；Client 负责呈现和用户手势；ctxmux 继续独占 Run/PTY/Replay 等运行时事实。
- 观测必须区分运行时存活、Provider 执行状态、输入可消费状态、等待用户和业务任务状态。缺失、过期、互相矛盾的证据有来源与时间，不能合并为一个 busy 布尔值，也不能以进程输出或 CPU 代替语义。Provider 特有的工具、goal 或 workflow 事件只按已声明能力呈现。
- 人机交互由 AgentMux 统一承接：Provider 描述原生权限/问题及可回答选项，Core 绑定精确 Session、Run 与 request 身份并维护其生命周期，Client 复用对应交互面。普通消息、排队、steer、回答权限/问题、interrupt 当前轮、stop 执行、pause loop 的意图必须区分；共享身份、投递与回执规则不等于共用一种写入语义。
- 用户消息从草稿到已入队、Host 已接收、Provider 已消费的证据必须区分；未知回执不冒充成功，也不自动重复发送。尚未成功生效的内容应保持可取回；草稿编辑状态由 Client 持有，提交后的投递事实由 Core 持有，不能把草稿硬搬成 Runtime 真值。
- 原生 typed 回答首次可能输入前，Provider 必须确认准确请求对应的原生输入目标可接纳该回答。受信 Hook 证明请求的归属，不单独证明输入目标已经就绪；直接协议或完整原生画面的证据均由 Provider 绑定当前 Session／Run／request，Core 消费这一事实，client 不猜厂商文案、数字选项或输入目标。准备只观察相关请求，不能借等待占住健康 Agent 的普通输入；目标、请求或来源改变时拒绝该次回答，保留原请求、所选回答、工作面和准确原因。
- 回答的字节 ACK 只确认原 Runtime 输入受据。Core 在现 pending 保留原 response、operation、内容、冻结范围与 ACK；只有 Provider 对准确原生调用及同一 Run 的 completion 才允许结算该请求。ACK 先到或 completion 先到均沿同一 owner 收敛，已有输入不重发，新请求不被旧 ACK 或迟到 completion 覆盖。丢回执、部分输入或消费未确认保留原 tuple 与待核实事实，不猜未发生、不新认领原回答。
- 原生回答或其他客户端已确证处理的请求不再显示为需要再次回答；已确认输入而原生完成仍未知时，显示回答受据与待核实原因，保留原生交互入口和健康输入。旧 Run/request 的迟到回复不得作用于新请求；不自动选择选项，不用普通 prompt 绕过权限问题。
- Agent 活着但我们的握手、探测或观察失败时，保留其已有可用操作并呈现服务窗；不通过盲发、猜选项或伪装 ready 来“恢复”。完全损坏才诚实阻断，未知如实标未知。
- 人机交互反馈分为：当前输入组件内的操作结果、Session 的待答请求/持续服务窗、跨工作区的注意力摘要。每一层消费同一个请求或结果身份；已关闭 transient 提示不因重放复活，尚未解决的持久问题仍可找到并定位原对象。
- 同一请求在 Session 与注意力面板中必须显示相同的可回答性和终端确认原因；其他视图处理后，不再保留“Needs you”的旧文案。回答失败保留当前选择和请求，原因留在回答处，允许明确重试；旧 Session、Run 或 request 的迟到结果不得写到替换后的卡片。Session 的持续问题可从全局告示定位，阅读或收起告示不能抹掉未解决事实。

 用户要求：Agent 需要用户确认一些选项时，聊天视图当中应出现对应选项，并用清楚的样式表示需要用户交互。当前待答请求在同一 Session 的对话阅读面内可见：显示真实问题、Core 已验证的原选项及“需要你回答”，选择仍只走上述 typed response；没有请求就不占位。Terminal 与聊天复用同一请求 owner，不制造第二份可回答请求或把当前请求写成历史消息。只读聊天可观察问题和待处理事实，但不能回答；历史记录中的旧问题只作阅读，不重新获得回应按钮。unsupported 或无法确认投递/结束时，保原问题事实及准确原终端出口，不从正文、时间、toolInput 或状态猜选项、答案或完成。提交中不重复投递，失败保原问题与选择，只经用户明确重试；切换 Activity/History/Terminal、当前请求/Run 替换与迟到结果保持原阅读正文、选区、展开、滚动与草稿，不把旧回答或本地错误绑定给新请求。

- 重启/重装/暂时空快照后先恢复 durable Tab、Tab Group、Region、焦点和布局，再按原 Session 身份自动 reattach/resume；流程超时、旧 lease 和 Provider 探测失败不能删除投影。只有 Core 明确 retired/unknown 终局事实允许移除。交互与投递恢复不能串到替换后的 Run。
- 此次收敛以现有状态、interaction、delivery queue、continuous-progress scheduler 与持久化接口为起点；消除重复 owner 和重复判断，不要求将所有状态改成事件溯源，不新增自演化引擎、通用 Job/Workflow/插件平台或平行兼容实现。已有 loop 复用统一观察与投递边界，任务完成真值仍归任务来源。

- 架构可发现性也是本次分层收敛的约束：公共文档与 API 入口应能引导维护者找到既有能力的唯一 owner、真实消费者与行为证据，区分已有实现、可选 Provider 能力和待实现需求；分析遗漏须先核对来源，不以未经查证的“能力缺失”新增平行实现。

## Steer 与 Provider 输入能力

用户反馈工作中的 steer 被“composer readiness epoch already consumed”拒绝。Provider 负责具体 CLI 的可用输入方式及就绪证据，Core 负责同一 Run 的并发提交、去重和交付。不能把 turn 完成信号当成所有输入的唯一机会，使本可接受 steer 的健康 Agent 被内部纪元卡住；也不能绕过尚未完成的提交或把未知输入状态猜成安全。已入队未投出的消息必须保留；提示准确说清当前等待对象，不能承诺永远等不到的自动恢复，也不能建议结束健康 Session 来修复流程。

显式立即 steer 要沿 Provider 声明的立即输入／执行语义提交，不能把仅完成普通输入提交或进入 Provider 待处理队列当作这条消息的立即 steer 已兑现。Provider 负责在自身边界内解释并选择已声明的原生输入能力，Core 保留这次准确输入意图、目标 Run、并发与去重边界，Client 通过同一公共能力提出意图，不增加厂商按键或协议分支。能力不支持或当前无法确认时，说明实际能力、提交状态与原因，保留原消息和健康 Agent 的可用输入；不静默改用另一种语义冒充成功。Runtime 接受字节、消息出现在 CLI 记录与 Provider 按该立即意图接纳分别表达，前两项不能单独证明立即输入／执行语义已兑现。用户操作、快捷键及单条授权范围只见[《Composer 静息形态与主操作》](conversation-input.md#composer-静息形态与主操作)。

原生准备如需刷新屏幕观测，只能由 Provider 声明并证明该动作不提交、清空或重排草稿与既有待处理输入；授权限定在这次显式立即执行及原 Run。Core 沿原持久投递保留该准备阶段的唯一身份与实际受据，丢回执或重启不重复执行。resize、重新接入或来源变化后，旧尺寸下的完成帧和 checkpoint 合成绘制不能证明当前原生准备已完成；当前画面必须由对应的真实输出与尺寸事实确认，保真终端恢复也不能以随后重绘代替。

原生恢复后的输入证据必须属于当前 Run。历史创建版本不能代替当前原生进程的能力，已结束或丢失 Run 的 working 尾部也不能直接成为新 Run 的当前回合；Core 持有准确的恢复与 Run 关联，Provider 在该边界内解释原生来源。新的 working、待答交互或草稿仍按当前事实处理，缺失或变化的来源保持未知，不从时间、正文或画面猜空闲。无法读取恢复边界不阻断健康原生恢复，保留可用输入并持续说明未确认步骤；同一消息的投递身份与未知结果不因恢复而重置。

Readiness 是 Provider 输入框的观测证据，不是健康 Run 的永久发送许可证。一次未观测到、超时、已消费的旧证据不得阻断后续人工发送或 steer；事务冲突、未完成投递、错 Run 和待回答交互仍由各自权威 owner 处理。缺少屏幕确认时必须明确告知，后续真实验证成功才清除不确定性。

自动续跑以当前 Run 的实际 turn 完成事实作为触发机会，每个完成事实最多推进一次；working、待回答交互、未知完成状态仍不自动发送。其去重必须由持久化调度 owner 持有，不靠屏幕 readiness 恰好成功或被消费来间接阻止重复。

自动推进的认领和发送确认必须分开：在认领之后、确认之前重启，显示结果未知并保留原投递标识供显式继续；不得伪装为已完成，也不得默默重复投递。暂停、停止、新一轮开始或 Run 更换后，旧完成事实不得再触发发送。通知已读记录不能因重启过程尚未载入 Session 事实而丢失。

人工消息先于 Provider 的开始工作事件被接收时，旧 done 事实也已经被该次输入使用，不能让自动推进再借它发送一条；这个事实由 Core 在输入认领时原子记录，适用于单阶段和两阶段 Provider。人工 steer 不受已使用完成事实的限制；同一已认领操作仍可取回原回执。

## Executor 标识的归属

- 用户明确：固定 Icon 直接在 Executor／Execution 配置里，这不算显示配置，而是为了标识 Executor。颜色叠加与左上 Icon 和该 Executor 一起编辑、保存；外观设置不再另放一份入口或配置。
- 所有代表具体 Agent 的图标都显示其 Executor 标识，不再只显示 Provider 标识；同 Provider 不同 Executor 可区分。Provider 图形作为未自定义时的默认底图。纯 Provider 能力目录仍表示 Provider，不凭空关联 Executor。
- 菜单、Tab／Region、Topic、列表、消息工具与设置预览消费同一 Executor 标识；状态角标与身份保持独立。此约束取代此前放在显示设置下的方案，视觉轮廓仍遵循密度 SSOT。

## 插件扩展边界

- Provider、Skill 和命令通过 `packages/core` 暴露的类型化插件合同发现和注册。宿主先读取清单，再按用户选择激活；编辑器只消费统一目录和能力，不为某个厂商写分支。
- 插件拥有自己的声明和生命周期投影，但 Run、PTY、ordered bytes、Replay、Gap 与 Session 权威事实仍归 Core/ctxmux；插件不能复制一套进程或终端状态。流程探测失败作为服务窗提示，不阻断健康 Agent。

## 状态投影、Browser 页面与 Scratch Topic 工作面

- Agent 的进程已经停止、正常退出或退出原因未知时，不能因为流程告警或投递检查失败而显示成红色错误。只有 Core 给出真实崩溃、非零退出或明确故障事实时才进入 error；连接丢失单独显示为 disconnected。左侧 Project 树继续显示 idle Session 数量，头像和 Executor 角标不因此常驻亮起。
- Browser 的控制权提示只是页面旁边的辅助信息。`Browser ready`、`You have control` 之类的提示不能替代、覆盖或把真实页面变成空白控制面；没有进行中的操作或控制权交接时不显示占位提示，页面仍由 Main-owned Browser surface 承载。
- Topic 是 Space 导航的一等内容，按[《Space、Folder 与 Topic》](spaces-and-layout.md#spacefolder-与-topic)的 Topics 分类进入；Scratch 保留底层共享布局含义，不再作为另一份产品父行。Topic 与既有知识目录、原工作面和 Session 的关系可追踪，重启后仍保持；选中、hover、空列表、新建和恢复状态沿同一合同给出一致反馈，不能依赖一张已经失效的装饰卡片。

## Executor 身份组件与信息面板

- 所有显示 Executor/Provider 身份的地方，包括顶部 Tab、Project/Topic 列表、Session、Board 和 Browser 操作条，都必须使用同一个可复用 Executor identity 组件。Provider 图标、较小的 Executor 自定义图标、珐琅式外轮廓和状态标记只能由这一组件组合，不能在调用方各自画点、描边或叠加。
- Executor 面板在 hover 或键盘 focus 时以统一的 tooltip 信息面板出现，展示可读名称、Provider、当前状态和可用的上下文；不要求先点击才能看见。面板的字号、内边距、颜色和动作区与其他信息面板一致，不能因为来源不同出现另一套密度。
- 自定义头像属于 Executor 配置，不属于 Appearance。面板只提供一个小型设置入口；点击后进入该 Executor 对应的模板设置，不能跳到 Appearance，也不能在信息面板内复制一套配置表单。身份 ID、Session 绑定和工作区事实保持稳定。
- 头像编辑归属 Executor 模板；移动设置入口不能改变已有身份外观、丢弃已存头像，或因头像问题阻断应用启动。仍存在的 Appearance 头像按原 Executor ID 继续显示，新的 Executor 编辑写入其稳定配置；未匹配的旧记录保留原样，不猜测新身份。

## 工作状态与 Executor 叠加标记

- `working` 必须有一个明确的活动字形，表达 Agent 正在产出；普通 `running`／idle 只表示进程仍可用，不在头像右上角放常驻标记。
- 等待用户、阻塞、断联和真实错误属于需要用户知道的特殊事实，保留各自的提醒形状；错误行优先显示 Runtime 提供的具体原因，无法取得详情时才使用短的事实说明。
- Executor 自定义图标与 Provider 图标先合成一个身份图，再应用共享的珐琅外轮廓。Executor 图标应小而紧，叠在 Provider 图标内部，不得成为围在外面的第二圈。
- 状态语义只通过右上角的小型标记或活动字形表达；普通身份不使用外描边制造状态。
- 活动菜单必须保留可读的原因、项目和 Provider 信息；长内容在有界菜单内换行或滚动，不能被固定宽度裁成看不懂的尾巴。

## Agents 全局层级与拓扑图

Focus 与 Space、Goals 位于同一组全局工作面。Focus 打开时 Project Rail 被遮挡，Project 只作为 Agent 的归属事实和未来拓扑图的分组边界，不再在左侧重复出现。Agents 当前先保留可用的分组/详情表面；引力图是独立 Feature：活跃 Agent 居中，不活跃 Agent 灰度保留；同一 Project 或 Demand 的 Agent 距离更近，Project 关联范围形成多边形区域。图中的节点、边和状态必须复用现有 Session/Project/Demand 事实，不能建立第二套 Agent registry。

## Claude Prompt 提交

从 Message Tool 发送给 Claude 的文字必须完成一次真实的 Prompt 提交：文字进入 Claude 输入区后，终端要收到该 Provider 当前输入模式对应的提交键，并能从后续终端字节或状态观察到已离开编辑态。不能把“文字已写入输入框”当成发送成功；发送失败或 readiness 尚未完成时要保留草稿并给出可诊断提示，不静默清空或假装执行。

## P0 的共同交付边界

零输入字节只能证明当前失败尝试没有写入，不能证明更早一轮已结束。原 operationId 的恢复继续走幂等路径；换成另一条消息且回合仍未知时，必须有这条消息自己的明确继续选择，不能借用上一条消息的批准。

用户要求完成当前六项 P0 的设计与实现，包括此前只规划的可读 A2A 协议。各项约束仍归其所属章节；“代码已有”不能代表交付，必须证明真实入口、失败分支和重启后的恢复。发送与恢复的检查失败不能拿走健康 Agent 的工作能力；无法确认的事实保持未知，并在原工作面持续说明恢复动作。Browser 批准只授权被确认的目标和操作；Demand 详情保留原需求身份与编辑能力。

## 跨重启的 Prompt 投递凭据

- Prompt 两阶段投递的持久化 claim 是去重与恢复记录，不是把下一条 Prompt 永久挡在门外的许可闸。应用重启后重新接入同一个仍为 `running` 的 Run 时，旧 claim 未确认本身不得触发 Resume、Retire 或删除健康 Session。
- 两个公开 `AgentMuxClient` 实例共享同一受支持 Session Store/Run，以及两个 Control/Renderer 经同一 Core owner 发送，都必须保有唯一在途 Prompt 投递 owner。另一 Client 看不到本实例内存记录，不代表旧 owner 已结束；活跃 claim 不能被替换。投递前须重新读取当前 Session/Run 与待答边界，普通 Prompt 不冒充交互回答。精确绑定当前 Session/Run/request 的人类回答不等待可选的 Prompt 渲染观察；结束该观察不取消已派发的 Native Input，也不替请求补完成或批准。
- Core 投递 scope 释放或进程退出，不代表 Native Input 已终结；游标仍在旧 claim 起点也不能证明旧输入将来不会写入。首次投递前须在现 admission 保存原始 bytes、key、range、daemon incarnation 与两阶段意图，冷恢复只按原 tuple 接续既有 recoverableInput，不能从 digest 或变化后的 Provider 计划重建输入。unknown/partial 保留原 operation、内容、工作面与原生输入能力，并说明待核实原因；缺 tuple 如实 unknown。不同消息接管须有真实 not_applied 或其他终局事实，证明旧请求已无未来写资格；不能猜 TTL、PID 或语义状态，不能留下无法自行恢复的永久 BUSY。
- 两阶段 Prompt 的正文已接受、提交未派发时，人工输入可能占用旧提交范围。恢复须核对原提交的终局；不能把正文已接受改成整条消息未投递，也不能因为已终结的提交阶段让后续消息永久卡住。无法确认的部分仍保留原消息与原生输入能力。
- 新的提交建立自己的两阶段字节范围与 readiness 观察；同一 `submissionId` 和相同内容按原冻结输入幂等续做，冲突内容拒绝。旧 ACK 只属于原 Session/Run/operation，不清新 claim、请求或草稿；Host accepted 不冒充 Provider consumed。任何恢复流程失败都要保留可见工作面和健康 Session。
- Run 终局可以清除当前 Prompt readiness 与临时提交投影；已确认输入仍按原 Session/Run/operation 的持久受据表达。验收不得要求已退出 Run 保有可再次提交的 readiness，也不得因其缺席抹掉已确认交付。
- 人工在上一回合结束尚未确认时明确继续的事实属于这次持久投递；只有首次准入确实遇到回合边界未知才保留这项事实，不能把每次显式允许继续都说成未知回合。丢回执、重试或冷恢复不能遗失这次选择与回合说明，也不能借给另一条消息。恢复原 Input 回执只确认投递，不确认此前回合已经结束：投递得到确认后消除投递未知，仍保留同一消息尚未确认的回合风险；只有对应的真实边界或新的明确当前事实才能更新说明。可选的说明持久化失败不阻断仍能接受输入的 Agent，并明确保留失败步骤与当前状态。
- 普通 Prompt 的意图在首次可能执行的 RPC 前，从 exact Core Session/Run 事实捕获显式 admission 前驱条件，与 operationId、原正文和原 Run 一起先保存，再发送；未派发的 queue tail 不在 enqueue 时提前绑定。`null` 仅表示已确认没有 admission，缺字段、不可读事实或现记录缺逻辑身份均是 unknown。重试、丢 ACK、冷恢复和跨客户端不换前驱或 Run；MessageTool/CLI 也在现有消息 journal 中保留第一次条件，不能由 Main 每次发送时补最新值。
- 首次条件读取只刷新精确目标 Session 的持久事实，不以进程状态代替 admission，不顺带探测、投影或恢复其它 Session。Mote 浮窗和任务入口的消息复用现发件列表；入队表示保留意图，不能把它称为 Agent 已经收到或执行。 浮窗交接被拒时保留未交接文字及原因，只报告一次，不因重渲染反复交接或修改焦点。 目标事实读取的等待不得占住全局消息写通道，阻挡其它 Session 的消息；两个客户端准备同一消息时，只有首次保存的条件有效。
- 消息回执只有已成立的状态转换才能写入 durable journal；被拒的转换不得留下无法重放的记录，也不得覆盖该消息已有的投递事实。
- 控制链路报错或丢回执只说明该次投递无法确认，不据此把消息标为终局 failed。消息保留最后已确认的状态及未确认原因；取得真实回执后消除该提醒。迟到的报错不能降低另一客户端已确认的投递事实。 未确认原因是普通文本，保留换行；诊断时间必须有效，不能改写最后已确认状态的时间。同状态回执保持原值，不因重试刷新时间或原因。
- Core 在现同 Session 独占 scope 中，先核条件再写 claim：当前是本 operation 且原 tuple 完整时继续恢复；当前仍是捕获的前驱时才允许首次 admission；已是其它后续 operation 则具名 unknown，零新派发、不改后续事实。只有真实证明该意图尚未 admission 且没有原在途执行，才能重新准备首次条件；timeout、丢 ACK、unknown 和零游标均不证明这一点。某个旧操作 unknown 不禁用整个健康 Session，新显式意图与 raw 仍可用。
- 一个仍能接受输入的 Agent 必须有明确可达的发送路径。回合结束回执缺失不能把 readiness 变成永久许可闸；无法确认回合边界时说明风险，人工显式发送按「Cmd+Enter 直接 steer」执行；自动消费仍不能猜测空输入框等于回合已结束。已被接受但未确认的 Prompt 使用原 operation identity 续做，不重新发送正文；排队消息不因无关 Runtime 事件反复提交。
- Message Tool「先前能发，长运行后又发不进」的复发必须单独核对：消息进入 mailbox 只说明意图已保留，点「直接发送」也不等于 Agent 已收到。手动 Terminal 打字正常时，不能把消息投递流程失败说成整个 Run 或共享 owner 已停止；必须就原消息说明卡在哪一步、哪些字节已确认、哪些送达仍未知，保留原消息、草稿与工作面。已绑定当前 Run 的显式发送不能因为展示工作面的保存未确认而被挡，保存失败仍持续说明；发送受据与界面保存分别确认，不因此放开后台队尾、未绑定恢复或退出／更新的保存资格。运行时长或相邻 OUTPUT_GAP 不证明根因；恢复原投递仍遵守原身份与受据边界，不能用新 operation 重发未知正文，也不能把这条消息的未知变成健康 Session 永久无法显式发送。

## Hook 配置隔离与非 AgentMux 会话

原生恢复身份与会话记录必须属于当前 Agent Session。下属 Agent 的普通工具、权限与生命周期事件及其记录位置不能覆盖主 Agent 的原生会话句柄，也不能把主身份与下属记录路径拼成一个貌似有效的句柄。Provider 已声明的下属事件继续提供状态、活动和在途事实；记录归属不清时如实保留未知，不阻断主 Agent 的工作。合法主会话事件仍可建立或更新主会话句柄，不靠目录扫描、标题或最近文件猜测身份。

Hook 对原生主会话的解释同时使用当前已校验的 Session／Run／Provider 关联和已持久原生身份；这些已知事实只来自 Core，事件正文不能自称可信身份。恢复后仍沿同一事实识别主会话，不能靠上一次内存中的归属替代持久身份，也不能因生成恢复命令就改变关联。Provider 解释原生 Session 的明确父系与主／子事实；主身份未知或父系事实不足时，保留原始 trace 和未知，不能将同目录、Message 的引用父级或界面选择猜成主 Session。

- AgentMux Hook 的安装、读取、更新和卸载必须只作用于 AgentMux 自己的受管配置作用域；Provider 的共享配置文件仍保留用户和项目已有条目，不能把 AgentMux Hook 当成共享默认值。
- Hook 事件必须携带并校验 AgentMux Session/Run 关联身份。没有该关联、关联不匹配或无法确认来源的 Provider 事件不得触发 AgentMux ingress；应记录可诊断的降级事实，不影响外部 Provider 会话继续工作。
- Hook 探测、合并或安装失败属于流程问题时，健康 Agent 继续可用；服务窗说明哪一步未完成、当前按什么能力运行和恢复动作。只有 Agent/进程本身明确终止才允许阻断。
- Doctor 必须逐 Provider 如实报告 Hook 安装策略，包括不受管与无 Hook 的情况；Runtime 不可达也不能把这些策略改成全局默认值。策略声明不代表磁盘配置已安装，实际磁盘安装状态是另一项事实，不能混在同一字段中。
- **Hook 安装状态按这次实际检查判定**。公开 Core 在明确 Provider、Workspace 和执行环境作用域内新读受管配置，报告 installed、not_installed、partial、error 或 skipped，以及检查时刻、范围、原因和恢复动作。文件存在、过去回执、安装策略、整文件格式差异或未核实的原生 enabled 都不能代替完整且当前的受管定义及必要加载/信任事实；已写入受管配置与原生入口已加载分别表达；只有文件或恢复参数事实时不能宣称已激活，明确禁用保持禁用，加载未确认如实说明未知。未查成不能叫未安装。检查不注册安装 intent、不修配置、不执行 Hook，不复制 Provider 的路径/事件/所有权事实。
- **Doctor 不能先修好再冒充原本已安装**。其真实 CLI 入口先做连接前的只读点时检查，再保留普通连接及明确执行环境下的启动／恢复修复；明确标注检查阶段，后续修复不能倒填结果。Runtime 不可达或一家 Provider 失败仍保留其他逐 Provider 检查，健康 Session 和输入继续可用；输出不含配置原文、完整命令或凭证。

## A2A 身份信封与持久化全局消息队列

- 用户反馈「其他 agent 给这个 agent 发消息，但是没有遵循协议，没有带 message from 的头」，并授权「优化吧」。**所有由 AgentMux 管理的跨 Session Agent 消息，包括 `send`、`discuss` 及受管 Agent 发起 `agent open --prompt` 的首条消息，都必须由 Core 核验真实作者与双方已知 Session/Run，保留同一份 durable 消息身份，并由 Core 统一生成 `[Message from Agent <canonical Session ID>]` 加原正文。** 不得把裸正文加一个作者字段当成已完成 A2A 投递，不保留无 envelope 的 A2A send 分支或兼容 fallback；客户端不能另行组装另一份来源头。人类原输入仍逐字节保持，来源头不会改写消息正文。
- **新 Agent 的首条消息不补造尚未存在的 Run。** 已确定的目标 Session 与启动前仍未知的 recipient Run 分别保留；实际 Run 确定后，沿同一持久消息的原投递事实记录其关联，不重写消息、不增第二份账本。原单次 creation 与 first delivery 身份继续有效，同一 operation 恢复不重发首条、不另建或恢复替代 Session；普通人工 create/submit 仍保持原字节与原生命周期。
- **Agent 首次认识环境时就应知道怎样跨 Session 发消息。** `whoami` 的真实返回携带简短明确的消息使用要求，启动引导与 `--skill` 指向同一要求。它们须区分同一运行时内的原生 subagent collaboration 与跨独立 AgentMux Session：前者沿原生协作能力，后者通过 `$AGENTMUX_CLI send` 投递，不能借直接输入、终端注入或 Provider 原生协作队列冒充 AgentMux A2A。来源头由 Core 自动产生，不要求 Agent 手写声明来冒充认证；确切命令语法仍以技能输出为准。
- **未经 AgentMux 消息投递入口的输入不补造身份。** 看见没有来源头的原生输入、查不到对应 durable 消息，或正文声称来自某个 Agent，都不能据此确认发送者、发送通道或认证事实；保留原记录与可读正文，作者未核就明确未知，不倒填 A2A 队列、不猜作者或补上看似已核的来源头。
- **验收修正：发送成功必须意味着收件 Agent 实际收到可读来源和原始正文，且 Core 已按真实 Session/Run 与已解析目标核验身份。** CLI 环境变量只是身份线索，不是权威；Desktop 不得忽略结构化来源后只投递裸正文。可读表达归下节约束，目标的完整关联留在持久事实中。Control requestId 仍只作请求关联；同一消息的重试必须复用稳定的消息身份。
- **持久队列的唯一写入权属于 AgentMux Core。** 同一路径即使遇到多个进程或多个对象并发，也必须保持全局唯一、递增的顺序号和可重放的完整记录；队列所在位置不得受 ctxmux 版本化临时端点回收影响。失去持久写入确认时明确拒绝入队并告知状态，不能宣称已投递或判定健康 Agent 死亡。
- **身份授权必须在 Core 里完成，不能把 `AGENTMUX_AGENT_SESSION_ID` 或 Control caller 字段当凭证。** 受管 Agent 的 send 必须携带当前 Run 的 invocation capability，由 Core 核对 capability hash、Session 和 Run；没有 capability 或 capability 属于旧 Run 的请求必须拒绝，健康 Agent 仍可继续工作。
- **队列写入必须能从写入者崩溃中恢复，且回收不能碰掉新写入者。** 同一路径的跨进程排他性以系统可随进程退出释放的事务锁为准；遗留的孤儿 `.lock` 文件不得阻断新写入。并发恢复后每条消息仍只能占一个唯一、连续的顺序号，健康 Agent 不能永久收到 backpressure。
- **相同 `messageId` 是重试的幂等身份，跨新的 Control request/operation 与 createdAt 仍返回原 receipt；冲突正文、目标或来源必须拒绝。** Region/Tab 只是寻址输入，落盘 envelope 和收件信封必须写入解析后的真实 recipient Session/Run。
- `agentmux send` 的消息必须带可验证的来源、目标和 AgentMux Session/Run 关联事实；这些事实来自 Core 凭证和会话上下文，不得从 View、Region、标题或正文猜出。`requestId` 只标识 Control request，不能充当 `messageId`。
- 全局消息队列由 AgentMux Core 独占持有。消息记录 append-only 且不可变，至少保留 `messageId`、版本化 A2A envelope、`createdAt`、sender/recipient、workspace/session/run 关联、thread/correlation/replyTo、顺序号，以及独立的投递状态变更和失败原因；消息本体和投递状态不能因空快照、握手超时或重启被清空。
- 队列重启后必须可 reopen/replay。consumer 游标与 ack 带 generation fence；重复检查可安全重放，迟到或旧 generation 的 ack 必须失败而不能推进新一代游标。相同 `messageId`/operation 的重试必须幂等。
- 队列必须有界并明确背压或拒绝码。无法确认 durable append 时不得返回已入队；Store 短暂故障按服务窗降级，不能把健康 Agent 误判为死亡，也不能静默丢正文。正文原样保留，可读来源只是展示，不是认证。

## A2A 消息要让人一眼看懂

- 用户原话：「`from="local-cli" to="765ae7ef-b886-4681-b9b5-0bbc561e8f1a"`，from 和 to 的语义完全不同；amux 中包 JSON 太奇怪了；冗余信息也多；人类完全不可读」「现在的 agent id 设计太长了，非常浪费」。消息里表示发送者和收件者时，两端必须是同一层的参与者身份；`local-cli` 是进入系统的通道，不是一个人或 Agent 的身份，不能占据 `from`。通道、已核验身份与未核验来源必须分开表达；无法核实发送者时如实标未知，不能猜成某个 Agent。
- Core 的持久消息事实与投递回执供机器审计和重试；投递给 Agent 的文本只保留完成交流所需的来源、正文，以及确有回复需要时的简短引用。不得把整个回执 JSON、`requestId`、`queueId`、Run ID 或一串重复的 Session ID 自动塞进可读消息。正文若本来就是发送者写的 JSON，仍按原文保留，并明确它是正文，不让它看起来像 AgentMux 协议层。
- 用户明确选择「持久地址也缩短，从防撞目标出发，不用这么长；还要支持类似 Git 的部分 hash 寻址」。新建 Agent Session 的**持久 ID 本身**应缩短，而不是给长 UUID 再套一层别名；长度由明确的碰撞概率目标决定，不靠“看起来够短”。同一完整 ID 重启后仍指向同一 Session，已存在的长 ID 保持原身份并可恢复，不为缩短地址重写它们。
- 防撞目标是在一千万个 Session 下，任意两个新 ID 碰撞的概率低于万亿分之一；字符必须能直接用作 CLI 参数与持久引用。新 ID 的前缀同样不能被误当作另一项命令选项。
- 新建 Agent 的每一个短 ID 都必须符合创建、持久化、浏览器客户端与 CLI 的同一套合法地址约束，不能因为随机生成了某个首字符就偶发创建失败。地址本身满足约束，不要求调用者修饰、改写或重试地址；已有身份不改写。
- 所有以 Agent Session ID 寻址的 CLI 动词都应接受唯一前缀：只在当前权威 Session 集合中恰好命中一个 ID 时解析；零命中或多命中明确报错，绝不能按最近活跃、标题、View 或位置猜一个。前缀是便捷输入，不是另一个持久身份；新 Session 出现后旧前缀可能变成歧义，但不能静默改指向。Core 拥有铸造、查找和碰撞判定，Renderer 只展示权威结果。
- Demand 的关联 Session 和 PMO 的混合 Session 筛选可以包含普通 Terminal，归现有通用 Session 入口所有；不得拿 Core 的 Agent 集合拒绝这些完整引用。只有领域明确要求 Agent 的入口才做 Agent 前缀解析。
- 一条消息在收件 Agent 和人类阅读面上只有一份简洁的表达；机器回执留在命令结果/审计入口，不作为消息正文再转发。可读信封只是展示，不是认证；发送授权仍按上节的 capability 与 Session/Run 事实核验。

## 按 amux id 搜索 Agent

- 用户原话：「加个功能快速合入 main: 支持按 amux id 搜索 agent」。Focus 的既有上下文搜索与快速切换的既有搜索都应能找到当前入口已提供的 Agent，按 Core 权威 Agent Session ID 检索；Run ID、Provider 原生会话 ID 和普通 Terminal 的身份不是这里的 amux Agent ID。
- ID 输入去除首尾空白后按原大小写连续匹配，支持完整 ID、前缀和中间连续片段；不把散落字符的模糊匹配用于 ID。前缀或片段命中多个 Agent 时展示全部匹配，由用户明确选择，不静默猜一个；这是一组现有行的搜索结果，不改变 CLI 唯一前缀寻址的合同。
- 原名称、上下文、Provider 等已有文本搜索规则与排序保持；快速切换的 ID-only 命中使用中性匹配权重，原注意力、文本质量与观察时间排序不另设 ID 优先级。Focus 原项目、状态与 PMO 可见性边界保持；只添加已有可见 Agent 行的 ID 匹配，不扩展候选集合。
- 选中结果沿原 Focus 或快速切换动作进入同一 Agent 工作面；搜索本身不创建或恢复 Session，不改变原焦点、布局或健康 Run。匹配依现有已加载事实完成，不另建 Core 索引、轮询或第二份身份。
