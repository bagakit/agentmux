# amux 可读协议

本文是 AgentMux 可读信封、业务标记、内容分享外框与对象链接的唯一格式合同，供 Core producer、共享 reader 和客户端维护者使用。它定义字节怎样组合、读取和保留；身份、权限、投递与恢复条件由各业务 owner 定义。规范和源码存在不代表每个运行实例或客户端已经验收。

[文档导航](../README.md) · [A2A 业务行为](../design/behavior/a2a-collaboration.md) · [共同对话协议](conversation-protocol.md#readable-agentmux-envelopes) · [当前阅读机制](../architecture/conversation.md#可读信封与原输入)

## 格式与业务归属

| 形式 | 表达的内容 | 业务 owner |
| --- | --- | --- |
| `<amux>…</amux>` | 平台说明或本页定义的 A2A 子项容器，可独立或随原请求投递 | [注入上下文](../design/behavior/agent-capabilities-and-messaging.md#agentmux-注入上下文)与[A2A 通知](../design/behavior/a2a-collaboration.md#a2a-引用通知与主动取信) |
| `<amux:a2a …>` | 容器中唯一一个 `a2a` 子项的简写；成对标签携带原信，自闭合标签引用原信 | [A2A 原信与队列](../design/behavior/a2a-collaboration.md#a2a-身份信封与持久化全局消息队列) |
| `<amux:continue />` | 原恢复流程选择的默认接续文本 | [Session 恢复](../design/behavior/session-recovery.md) |
| `<amux:reaction CODE />` | 用户选定快捷回复的含义标记 | [reaction 快捷回复](../design/behavior/conversation-input.md#回复卡片的-reaction-快捷回复) |
| `--- amux : File/Browser ---` … `-----` | 原文件或 Browser 上下文的内容分享 | [对象地址与分享](../design/behavior/public-control.md#对象地址分享与方向) |
| `amux://KIND/ID` | 一个准确对象的地址 | [对象地址与导航](../design/behavior/public-control.md#对象地址分享与方向) |

这些形式共享可发现的名称，各有适用边界。它们不是一个通用 XML namespace、RPC 或可执行指令语言；不能把所有形式交给同一个 XML DOM 或扫描器来推断控制行为。Provider 原生协议、结构化消息记录、操作回执和外部 Skill 声明包保留其原合同。

## 共同边界

- **文本声明不认证来源。** `amux`、`from`、对象 ID 或 reminder 可以出现在任意作者的正文里。真实作者、平台 producer、权限与 Input 采用来自原结构化事实；可读格式不替代这些事实，也不扩大用户授权。
- **读取不执行。** 识别、折叠、展开、复制、取回正文和导航建议都不因此发送消息、触发接续、确认消费或批准权限。实际操作沿其原公开入口与回执。
- **原文和阅读投影分开。** 原 wire、正文、平台内容和原记录身份保留原边界。完整 Copy 取原 parts、资源或 journal 正文；不能从解码后的展示文字重组原文。其他作者写的同形标签不会取得平台来源。
- **格式变化不重写原操作。** 已冻结 Input 的原 wire、producer 分界、消息和 operation 身份沿原输入 owner 保留；重试和恢复不按新版 formatter、提醒或当前对象位置重组、改投或自动重发。具体准入与对账归 [A2A 行为](../design/behavior/a2a-collaboration.md#a2a-身份信封与持久化全局消息队列)。

## 平台说明

```text
<amux>
平台说明
</amux>

原用户请求
```

平台包装的起止是无属性的 `<amux>`、`</amux>`。纯说明形态的内容只有 XML 文本节点；producer 转义文本中的 `&`、`<`、`>` 并以字符引用保留 CR，不把原用户请求塞入属性或平台文本。当前 formatter 在平台文本两端加 LF，独立原请求通过两个 LF 接在包装外；内容是否构成一次请求仍由原提交 owner 决定。

共享 reader 只从输入开头读取完整平台声明。多个完整前导声明按原顺序保留，声明之间可以有换行；缩进和真实尾文不被吞掉。纯说明节点不接受属性或子元素；本页明确的 `a2a` 子项按后文合同读取，不能把它们误作普通平台说明文字。未知子项、DOCTYPE、processing instruction、不完整边界或含糊的前导序列不升级为平台说明，原输入保持可读。reader 保留每个原声明 span，不能通过正文中的另一个标签猜来源。

平台说明可以承载简短发现入口，不要求常驻整段操作手册。启动引导、当前身份、模块 Skill 与消息提醒各自披露什么，归[启动握手](../design/behavior/agent-capabilities-and-messaging.md#启动握手与自命名)和[同源指引](../design/behavior/a2a-collaboration.md#a2a-指引与通信礼节)；按需读取不需要增加包装属性或新的执行标签。

## A2A 容器与简写

`amux` 容器可表达纯平台说明、一封完整 A2A 原信，或一批 A2A 引用。完整原信使用成对 `a2a` 标签；引用使用带固定取信入口的自闭合 `a2a` 标签。批量通知只含引用，不混装多个完整正文；完整原信容器只持有这一封原信。未知节点不取得业务或执行含义。

容器中只有一个 `a2a` 子项且无其他容器内容时，可以写成 `amux:a2a` 简写。长式和简写生成同一可读语义，保留各自原始 span、wire 和 Copy，不通过字符串展开重写原输入。这是本页为 `a2a` 明确规定的语法，不自动推广为任意 `amux:NAME` 的解释或控制分发规则。

## A2A 原信

单封原信的简写为：

```text
<amux:a2a from="SID" msg-id="MID">
发送方原始正文
<reminder>Core 附带的简短指引</reminder>
</amux:a2a>
```

其长式为：

```text
<amux>
<a2a from="SID" msg-id="MID">
发送方原始正文
<reminder>Core 附带的简短指引</reminder>
</a2a>
</amux>
```

`from` 是原作者的 canonical Agent Session ID，`msg-id` 是同一原信的稳定消息 ID。原 Host、双方 Run、线程、operation 与投递回执继续由[结构化原信类型](../../packages/core/src/agent-message-envelope.ts)和原队列持有，不自动重复塞入可读信封。发送方只交原正文，Core 核验身份后生成信封；格式正确本身不证明该核验发生。

### 精确文本边界

简写的开头固定为 `<amux:a2a from="SID" msg-id="MID">` 后接一个 LF；属性顺序、双引号和空格按该形式生成。结尾固定为一个 LF、完整 `<reminder>…</reminder>`、一个 LF 和 `</amux:a2a>`。长式的开头固定为 `<amux>`、LF、`<a2a from="SID" msg-id="MID">`、LF；结尾为 LF、同样的完整 reminder、LF、`</a2a>`、LF、`</amux>`。结束标签之后没有尾文。Core reminder 是无属性、无子元素的 XML 文本节点。成对标签不携带 `read-via`。

正文是开头与最后一个完整 reminder 尾段之间的原始文本。A2A 格式不解析或转义这段正文来寻找嵌套信封；正文里的代码、换行、实体、先前 reminder 或完整信封示例都保留。不能把整个 A2A 文本当作 XML 文档解析，也不能用遇到的第一个 reminder 裁正文。提醒中的保留字符由 Core 转义，不能用未转义的标签让提醒穿透边界。

属性值按下表进行 canonical 编码，再从同一编码准确读回；其他字符保持原值，不能 trim、大小写归一化或按新 ID 分配规则重建旧身份。

| 原字符 | 属性中的编码 |
| --- | --- |
| `&` | `&amp;` |
| `<` | `&lt;` |
| `"` | `&quot;` |
| TAB | `&#9;` |
| CR | `&#13;` |
| LF | `&#10;` |

例如 `thread:0` 仍可直接阅读；语义相同但不符合该 canonical 编码的另一种实体写法不作为此信封识别。正文不套用属性或平台文本的转义。身份是否允许某个值由原业务类型判断，文本格式不新增另一份 ID 校验政策。

### 阅读与原文

完整、从输入开头出现的 A2A 信封可以和前导平台声明组合读取。共享 reader 提供声明、正文阅读区和独立提醒；普通消息首 text part 与显式展开的完整文本资源消费同一解释。A2A 定界不赋予正文里的外部声明包身份；既有外部 packet 的引用呈现仍沿其原格式，原 wire 和 Copy 不被其阅读投影替换。

**已经从 journal 或 producer 取得的正文不得再次按 wire 解析。** 即使正文恰好是一个完整 amux 示例，它仍是该作者写的内容。客户端须传递原来的 wire／body 边界，不能通过“看起来像信封”改变正文含义。记录、资源和作者归属由[共同对话协议](conversation-protocol.md#reading-and-projection)持有。

无效、不完整、位于引用或代码内、存在含糊尾文或旧式来源头的内容保持原文可读，不补伪认证，不增加旧格式解析层。原历史记录不会因此被删除、重写或重新投递。

## A2A 引用通知

```text
<amux>
<a2a from="SID-1" msg-id="MID-1" read-via="message --skill" />
<a2a from="SID-2" msg-id="MID-2" read-via="message --skill" />
</amux>
```

引用只含原作者 `from`、原信 `msg-id` 与固定发现入口 `read-via="message --skill"`，不携带正文、摘要或预览。自闭合表示原文没有在此展开，不能解释成一封空正文原信。Agent 需要处理时，先通过 `"$AGENTMUX_CLI" message --skill` 发现取信用法，再按原 `msg-id` 主动读取；这不要求处理每封无关来信，也不表示已经读取、理解、接单或完成。

`read-via` 的值固定为上述发现入口，由 Core 生成；它不是任意命令、URL 或授权载体。reader 只提供发现提示，不自动执行属性值、取信或确认消费。空闲投递、steer 资格、通知与原信的独立身份及实际回执由[通知行为合同](../design/behavior/a2a-collaboration.md#a2a-引用通知与主动取信)持有，不增加为可读属性。合并通知不新建 A2A 原信，每个 `msg-id` 继续引用原 journal 中的同一原信。

### 精确文本边界

容器以 `<amux>`、LF 开始，包含一条或多条引用，每条固定为 `<a2a from="SID" msg-id="MID" read-via="message --skill" />` 并以 LF 分隔；最后一条后接 LF、`</amux>`，结束标签后没有尾文。属性顺序、双引号及自闭合前的一个空格固定；`from`、`msg-id` 复用原信的 canonical 属性编码，不 trim 或重建身份。

Core 可在引用列表后、关闭容器前附一个完整 `<reminder>…</reminder>`，前后各以 LF 分隔。提醒只承载按平台说明规则转义的文本，不包含原正文，也不逐项重复完整手册；有此容器提醒时不使用单项简写。

只有一个引用且无容器提醒时，其简写固定为 `<amux:a2a from="SID" msg-id="MID" read-via="message --skill" />`。两种写法都只表达引用；成对原信里的同形标签仍属于不透明原正文，不被提升为新的引用。无固定入口、未知属性或节点、不完整和含糊的文本保持原文可读，不据此触发操作或猜授权。

## 业务标记

### continue

`<amux:continue />` 是原 continuity owner 使用的默认接续文本。它没有新增属性或控制参数；具体发送条件仍由原恢复合同定义。只有原恢复流程和真实用户意图决定是否提交，阅读这个文本不触发恢复，也不替代原 Session、Run、operation 或 completion 条件。

当前常量为 [`DEFAULT_AGENT_CONTINUITY_CONTINUATION`](../../packages/core/src/agent-session-continuity.ts)。共享可读信封 reader 不以该标记派发恢复操作。

### reaction

标记形式为 `<amux:reaction CODE />`，其中 `CODE` 是选定 Prompt 的 keyword，满足 `[a-z][a-z0-9-]{0,47}`。keyword 是裸标记内容，不是 `code="…"` 属性，也不是一份通用 XML schema。

[`promptReactionMessage`](../../packages/core/src/prompt-reaction.ts) 将标记、选定含义快照和原回复来源放进 `agentMuxNote`，把选定 `definition.body` 作为独立原 prompt。note 进入平台包装时，标记的尖括号按平台文本转义，例如 `&lt;amux:reaction ok /&gt;`；不能把这个内部说明误写成一个新 A2A 信封或独立入站控制协议。实际选择、发送与含义冻结归原[快捷回复 owner](../design/behavior/conversation-input.md#回复卡片的-reaction-快捷回复)，文字不认证用户点击、不批准权限、不确认原生 turn 关联。

## 内容分享外框

```text
--- amux : File ---
原文件上下文
-----
```

Browser 使用同样定界，将首行的 `File` 换成 `Browser`。准确拼接为首行、LF、原 owner 提供的完整正文、LF、`-----`；正文不 trim、不转义、不从中解析新的身份。外框不是 XML，也不是 A2A 来源证明。

[`formatAmuxSharing`](../../packages/core/src/sharing.ts) 是纯格式器，不读文件或页面。路径、行号、代码围栏、元素和批注顺序、内容预算及复制失败处理仍由[原分享 owner](../design/behavior/public-control.md#对象地址分享与方向)持有；增加外框不能绕过原内容上限，最终定界仍须完整。

## 对象链接

形式固定为 `amux://KIND/ID`。`KIND` 区分大小写，只取 `agent`、`region`、`tab`、`space`、`zone`；`ID` 是该类型的一个非空原身份，以 `encodeURIComponent` 编为单个 path segment。没有 query、fragment、父对象路径或自动执行参数，不能从名字、Run 或当前位置替换原 ID。

解析必须将 segment 准确解码，并通过同一 formatter 编码为完全相同的原链接；非 canonical 转义、额外路径或尾斜杠不接受。不进行 URL 路径归一化；编码后的斜杠可以属于 ID，不能因此拆成对象层级。原 ID 的分配规则和耐久身份保全仍归[空间身份 owner](../design/behavior/spaces-and-layout.md#产品实体-id-分配)。

[`formatAmuxObjectLink` / `parseAmuxObjectLink`](../../packages/core/src/sharing.ts) 持有公共生成与严格解析。格式有效只说明引用形式有效；对象存在、健康、可达、展示位置、输入资格和操作授权须从原对象核对。复制、打开、发送、导航与多候选消歧归[原行为合同](../design/behavior/public-control.md#对象地址分享与方向)。

## 实现与消费入口

| 职责 | 当前源码入口 |
| --- | --- |
| 平台文本与原请求的组合 | [`composeOutboundMessage` / `composeAgentPrompt` / `composeAgentLaunchPrompt`](../../packages/core/src/agent-outbound-message.ts) |
| 已核 A2A 的可读生成与共同解析 | [`renderAgentMuxMessageEnvelope` / `renderAgentMuxMessageReferences` / `parseAgentMuxMessagePrefix`](../../packages/core/src/agent-message-render.ts) |
| 提醒和协作规则的同源投影 | [`agent-messaging-guidance`](../../packages/core/src/agent-messaging-guidance.ts) |
| 原消息身份与队列 | [`agent-message-envelope`](../../packages/core/src/agent-message-envelope.ts)、[`agent-global-message-queue`](../../packages/core/src/agent-global-message-queue.ts) |
| 引用通知与原输入 | [`agent-message-notification`](../../packages/core/src/agent-message-notification.ts)、[`agent-message-notifications`](../../packages/core/src/agent-message-notifications.ts)、[`client`](../../packages/core/src/client.ts) |
| 当前接续、快捷回复、分享和链接 | 上述各节的原 producer／parser；不另造统一控制分发器 |
| 普通与完整资源阅读、原始 Copy | [对话机制](../architecture/conversation.md#可读信封与原输入)与[共同阅读合同](conversation-protocol.md#readable-agentmux-envelopes) |

表中源码是核对生产与读取边界的入口；具体候选的真实调用、采用和客户端消费须分别验收，不能用格式识别或规范更新代替产品交付。

增加或修改一种表示时，先在本页明确格式和原内容边界，再沿原 producer、共同 reader、资源阅读、Copy 和实际消费者核对；涉及公共能力时按[公共能力贡献约定](../guides/public-capability-contributions.md)判断 CLI／RPC 影响。可读格式不持有另一份运行状态、消息 Store 或业务生命周期。
