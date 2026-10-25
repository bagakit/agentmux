# amux 可读协议

本文是 AgentMux 可读信封、业务标记、内容分享外框与对象链接的唯一格式合同，供 Core producer、共享 reader 和客户端维护者使用。它定义字节怎样组合、读取和保留；身份、权限、投递与恢复条件由各业务 owner 定义。规范和源码存在不代表每个运行实例或客户端已经验收。

[文档导航](../README.md) · [A2A 业务行为](../design/behavior/a2a-collaboration.md) · [共同对话协议](conversation-protocol.md#readable-agentmux-envelopes) · [当前阅读机制](../architecture/conversation.md#可读信封与原输入)

## 格式与业务归属

当前支持的形式、名称、用途和实际 formatter 生成的完整 wire 示例由 Core 的[可读协议定义](../../packages/core/src/amux-protocol-definition.ts)与[阅读目录](../../packages/core/src/agent-message-render.ts)持有；设置的 **Message Tool → amux Protocols**、搜索与本地发现直接消费该目录，不维护第二份完整名单。下文分别定义格式不变量与业务归属。

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

## 场景数据

```text
<amux>
<context kind="browser" version="1">
{"kind":"browser","version":1,"capturedAt":100,"browser":{"hostId":"local","browserId":"B1","navigationId":"N4"},"page":{"url":"https://example.org/","title":"Page"},"activity":{"operationId":"O8","stepSequence":4,"phase":"running","observedAt":99}}
</context>
</amux>

原用户正文
```

容器只持有一个 `context` 子项，属性顺序与拼写固定为 `kind="browser" version="1"`；不与 A2A、reminder 或平台说明混装。开头、JSON、结束标签分别由单个 LF 分隔，外部正文由两个 LF 接上，正文逐字节保留。平台说明确有需要时使用其原独立前导容器。场景 JSON 由 [BrowserInputContext](../../packages/core/src/browser-input-context.ts) 严格解码后按该类型字段顺序编码；对象未知字段、未知版本或不完整格式保持原文可读。字符串中的 `<`、`>`、`&` 分别编码为 `\u003c`、`\u003e`、`\u0026`，控制字符使用 JSON escaping，不能用页面数据闭合标签。

场景只携数据，不携指令、作者、授权或投递回执，不进入 `systemContext`。Browser operation 与输入 operation 是不同身份；step 缺失用 `null`，不合成 0。selection 自持捕获来源和关联强度，外层较新场景不能覆盖它；图片只持宿主无关的持久资源引用，Core 不取图、不内联像素、不把像素矩形升级成 DOM ref。捕获跨边界时保留 observationEnd，无法证明准确步骤时不声明 exact-step。

`inputContextSource` 与 `inputContextCaptureProof` 不进入此 wire，也不接受为公共提交参数。公共调用附带的 context 是 `caller-declared`；可信捕获路径的 `host-capture` 来自原 Host 安装的非 wire reader 与 Core 保存的结构化 producer 事实，不能从标签、引用或摘要认证。用户手写完整示例仍是其正文，已取得 body 的 reader 不再次解析。完整 Copy 保留原 wire/parts；读取声明不提交、接管或批准。

原 prompt 的公开入口为 `agent.input.submit`／`amux agent input submit --session SID --operation-id ID --input FILE|-`，沿原 `submitAgentPrompt`、原输入 key 与查询回执，不建立 A2A 原信。managed Agent caller 必须使用 `agent.send`；普通本机 CLI 的操作主体不证明人工发送，不自动取得 Human 作者。未知提交使用原 key 查询，重启不按当前页面或新版 formatter 重组、改投或自动补发。

### 场景捕获来源与原输入

可信宿主输入通过 `inputContextCapture: {hostId, operationId}` 引用原捕获，与直接 `inputContext` 互斥；公共 `agent.input.submit` 不接受该引用。`hostId` 寻址捕获 owner，独立于目标 Agent 的执行 Host；`operationId` 是原输入 ID，独立于 Browser operation 和 Main 场景 captureId。普通 prompt 使用原提交 ID，continuity 使用原 `input.submissionId`；两者都保留恢复前的 `originRun`，不能以恢复后的 Run 或外层 continuity operation 替换。

[共享 record／proof 类型与摘要函数](../../packages/core/src/agent-input-context-capture.ts)持有准确合同。稳定摘要绑定引用、`binding` 中的执行 Host／AgentSession／`originRun`、原正文、原 note 和 typed context；不绑定 prompt／continuity carrier、外层恢复 operation、condition、execution／choice、preparationRetry 或作者／设备／渠道声明。精确输入选择、准备 fence、作者与权限继续由原输入／continuity owner 校验。Main 按原输入 ID 不可变保存场景；Core 将已核的 `inputContextCaptureProof: {reference, binding, intentDigest}`、context、source 和原 wire 随同原 journal／claim／launch input 冻结。proof 只证明历史场景 producer，不认证 Human 作者、不授输入或 Browser 控制权限，也不证明投递或采用。

Core 在首次冻结前通过原 Host 的非 wire reader 有界读取准确 Main owner；读取期间不占输入派发事务，回到原 owner 后核对同 ID 并发冻结。Main 仅有内存确认时如实返回磁盘未确认，不能冒称 durable，也不因此撤销真实 live 捕获。Core 已冻结后，同输入重试、stop／rejoin 和 continuity 恢复使用原 source／proof／context／wire，不再依赖 Main 在线或重新观察网页。合法 known-not-applied 后的显式 Resume & send 复用原输入 ID 与场景；unknown 或 launch-carried 不因此得到重新派发资格。

只读 `browser.input.inspect`／`amux browser input inspect --host-id HOST --operation-id ID` 返回原 reference、typed record 或缺失事实及 `diskDurability`，不返回正文、note、作者声明或投递结论。managed caller 仍经原 Core 鉴权，只能读准确执行 Host 上发给自身 Session 的捕获；知道引用不取得 participant 资格。当前 Host adapter 仅路由明确的 local capture owner 到 local 执行 Host，无准确远端来源时只报告本次引用未确认；普通无引用输入保持可用。定义与接线从[公共能力来源导航](public-capabilities.md#按能力找到定义与消费者)进入；这些合同不代签 Browser 浮窗、框选或安装交付。

## A2A 容器与简写

`amux` 容器可表达纯平台说明、一封完整 A2A 原信，或一批 A2A 引用。完整原信使用成对 `a2a` 标签；引用使用带固定取信入口的自闭合 `a2a` 标签。批量通知只含引用，不混装多个完整正文；完整原信容器只持有这一封原信。未知节点不取得业务或执行含义。

容器中只有一个 `a2a` 子项且无其他容器内容时，可以写成 `amux:a2a` 简写。长式和简写生成同一可读语义，保留各自原始 span、wire 和 Copy，不通过字符串展开重写原输入。这是本页为 `a2a` 明确规定的语法，不自动推广为任意 `amux:NAME` 的解释或控制分发规则。

## Channel 原信

```text
<amux:channel domain="chat.example" app-id="APP" id-type="user-id" user-id="USER" conversation-id="ROOM" message-id="MESSAGE" name="Display name" avatar-url="https://images.example/avatar.png" observed-at="1">
原消息正文
</amux:channel>
```

`amux:channel` 是外部原信的通用阅读声明。六个必需属性依次为原生应用 `domain`、`app-id`、发言人命名空间 `id-type`、`user-id`、原会话 `conversation-id` 与平台原消息 `message-id`；平台消息 ID 不替换 Core message／operation ID。可选资料属性依次为 `name`、`avatar-url`、`observed-at`；存在资料快照时必须有十进制非负安全整数 `observed-at`，名字和头像分别可以缺失。头像是无内嵌凭据的 HTTP(S) URL，不执行或查询该 URL 来验证作者。资料仅描述当次已观察字段，不能冒称始终最新、本人身份或权限。

开头是上述固定顺序、双引号和单个属性间空格的完整标签后接一个 LF，结尾是一个 LF 与完整 `</amux:channel>`；之后没有尾文。元数据的 XML 属性转义沿原 formatter，身份按原公开平台身份合同校验。正文是两边界之间的原字符串，保留空白、CR/LF、实体、代码和同形标签，不转义、不递归解释，也不交给 XML DOM。reader 只解释原消息开头的完整外层边界并保留原 wire；平台说明可以沿原独立前导声明组合，作者正文中的其他标签不取得来源资格。非法保留格式不进入通用声明分支，原文继续可读。整条 Copy 仍取原 wire，不从资料卡重组。

Core 的原 `AgentMuxMessageEnvelope` 在 external sender 之外持有可选 `channelProfile` 观察快照；完整 actor 命名空间必须与 sender 一致，资料不进入作者或 grant 的判断。耐久收件 owner 首次 claim 后保存同一快照，后续缓存刷新、重试与重启不替换它。原 prepared input 继续冻结精确 wire；新版 formatter、最新头像或资料缺口不重写可能已应用的输入。真实来源及当前输入资格始终由原 ingress claim、Binding／Grant 和执行 Host 核对，文本声明不携带这份权限。

生产、解析与目录沿 [Core message formatter／reader](../../packages/core/src/agent-message-render.ts) 和 [协议定义](../../packages/core/src/amux-protocol-definition.ts)；资料观察类型沿 [Channel profile](../../packages/core/src/channel-profile.ts)。原消息、Core 输入及查询复用既有公共能力，没有新增 send RPC、历史、Runtime 或输入队列。资料缓存的管理由原连接器 owner 提供独立能力，定义类型本身不证明管理接口或平台资料已经可用。

### Channel 对话记录引用

Channel 输入附带的前文以 amux 对话记录 quote 承载，与当前原请求及受信平台说明分别定界。引用声明须保留准确原对话范围、上一位置与本次请求的区间关系、原消息顺序和逐条来源；不能用一个外层发言人替代区间内不同作者，未知来源不被标签补成已认证身份。引用保留所选原消息的完整内容／资源关系，当前请求在引用外独立保留。同一接收 Session 已知的自身外发消息只按原准确投递映射排除，不改变连续范围、覆盖结论或推进位置的采用回执；具体选择与位置边界归[外部交流入口](../design/behavior/conversation-mode.md#共同对话协议与外部交流入口)。

原 envelope 的 `channelQuote` 采用 [ChannelTranscriptQuote](../../packages/core/src/channel-quote.ts) 严格合同。wire 按 `<amux:quote version="1">`、一行确定性 JSON、`</amux:quote>` 定界，随后另起原 `<amux:channel ...>` 当前请求；JSON 的 `<`、`>`、`&` 使用 Unicode 转义，解码后原内容不变。reader 只在完整的 quote 与后续当前请求应用、对话和消息 ID 一致时展示引用，不递归解释消息正文中的同形样例。

`range.from` 记录原消息 ID 与是否包含；`throughMessageId` 指向引用之外的当前请求，始终不包含。`first-observed` 仅命名首次可确认的起点，之前历史不在本区间；`admitted-input` 命名原已采用输入之后的位置。`coverage: complete` 只表示该次原生 API 可见范围内本区间完整，不声称已删除内容或编辑前的原版本仍可得；其它情况保留 `gaps`。每条记录保留原顺序、独立作者观察、原生内容类型与完整字符串、资源与回复关系，不持有历史成员输入 grant。

Channel 输入可以完整内联，也可以在原平台说明中给出同一消息 journal 的准确 MID、待读字段与 `message --skill` 读取入口。正文和 quote 分别选择：短正文继续作为独立当前请求，长 quote 仅指向原 `channelQuote`；长正文仅指向原 `body`。引用说明使用既有纯平台文本包装，不借 A2A 的 `from` 声称外部作者是 Agent，也不把原正文复制为平台指令。原 envelope 保留完整内容；公共读取选择原字段并有界续读，正文读取不夹带未请求的 quote，分片不能被当作完整消息。

所选表示在原 Core journal 首次准备输入时冻结 `promptWire` 及其原来源关系；等待时原 reader 与整条 Copy 读取实际冻结文本，重开或 rejoin 不调用新预算或 formatter 重建。既有未采用新表示的原消息保留其原承载与回执，不因升级切成引用或重新发送。公开对话正文仍是独立当前请求，引用说明和 quote 不随正常消息发布给其它受众。引用仅声明读取入口：其输入回执不证明原字段已取阅，公共读取也不 ACK、采用或接受任务；完整 quote 的位置推进沿[外部交流入口](../design/behavior/conversation-mode.md#共同对话协议与外部交流入口)核对实际承载。

quote 只表达引用记录，不能把其中的提及、命令、旧问题、答案或权限文字解释为本次请求、平台指令或新的授权。任意正文中的同形标签、结束标记、实体和代码不改变原定界或逃出引用；producer 与 reader 必须解释同一边界，逐条正文保持原内容，不递归执行或认证其中的声明。真实输入资格仍由当前请求的原 ingress、Binding／Grant 和执行 Host 核对，协议文本不携带这份权威。

原输入准备后，原 envelope 保留同一区间、原消息关系、完整引用内容与独立当前请求，wire 保留已选的内联或原 MID 引用表示；重试和恢复不以最新记录、资料、阈值或 formatter 重建已冻结输入。来源或区间有缺口时准确表达，不补造上一位置、作者或连续完整的对话。共同阅读与整条 Copy 保全同一原 wire 及引用／请求边界，不从卡片摘要重组，也不因折叠引用改变输入、采用或位置推进事实。

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

`read-via` 的值固定为上述发现入口，由 Core 生成；它不是任意命令、URL 或授权载体。普通声明的 reader 只提供发现提示，不自动执行属性值、取信或确认消费。已核 A2A 通知展开后的原信阅读沿[原信阅读行为](../design/behavior/conversation-mode.md#a2a-引用通知中的原信阅读)，只在原 Host／收件 Session 的准确范围内消费既有授权查询；语法识别和属性本身不授予该资格。空闲投递、steer 资格、通知与原信的独立身份及实际回执由[通知行为合同](../design/behavior/a2a-collaboration.md#a2a-引用通知与主动取信)持有，不增加为可读属性。合并通知不新建 A2A 原信，每个 `msg-id` 继续引用原 journal 中的同一原信。

### 精确文本边界

容器以 `<amux>`、LF 开始，包含一条或多条引用，每条固定为 `<a2a from="SID" msg-id="MID" read-via="message --skill" />` 并以 LF 分隔；最后一条后接 LF、`</amux>`，结束标签后没有尾文。属性顺序、双引号及自闭合前的一个空格固定；`from`、`msg-id` 复用原信的 canonical 属性编码，不 trim 或重建身份。

Core 可在引用列表后、关闭容器前附一个完整 `<reminder>…</reminder>`，前后各以 LF 分隔。提醒只承载按平台说明规则转义的文本，不包含原正文，也不逐项重复完整手册；有此容器提醒时不使用单项简写。

只有一个引用且无容器提醒时，其简写固定为 `<amux:a2a from="SID" msg-id="MID" read-via="message --skill" />`。两种写法都只表达引用；成对原信里的同形标签仍属于不透明原正文，不被提升为新的引用。无固定入口、未知属性或节点、不完整和含糊的文本保持原文可读，不据此触发操作或猜授权。

## 业务标记

### continue

`<amux:continue />` 是原 continuity owner 使用的默认接续文本。它没有新增属性或控制参数；具体发送条件仍由原恢复合同定义。只有原恢复流程和真实用户意图决定是否提交，阅读这个文本不触发恢复，也不替代原 Session、Run、operation 或 completion 条件。

当前常量为 [`DEFAULT_AGENT_CONTINUITY_CONTINUATION`](../../packages/core/src/agent-session-recovery/continuity-contract.ts)。共享可读信封 reader 不以该标记派发恢复操作。

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

形式固定为 `amux://KIND/ID`。`KIND` 区分大小写，只取 `agent`、`region`、`tab`、`space`、`zone`、`capsule`；`ID` 是该类型的一个非空原身份，以 `encodeURIComponent` 编为单个 path segment。`capsule` 引用原持久页面，而非 Browser、端口或展示位置。没有 query、fragment、父对象路径或自动执行参数，不能从名字、Run 或当前位置替换原 ID。

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

## 通用命名协议与阅读目录

完整独立的未知 `<amux:NAME … />` 或 `<amux:NAME …>正文</amux:NAME>` 可以生成通用只读声明卡。`NAME` 与属性名均匹配 `[a-z][a-z0-9-]*`；属性以空格分隔、值用双引号包裹，名称唯一。属性值按 XML 文本解码，不含原始尖括号、CR 或 LF。正文是不透明原文，不递归寻找协议，不交给 XML DOM 解释子协议；正文中的实体样例也保原文。纯卡片判定不吞前后空格、缩进、普通尾文或代码围栏。信封结构／属性中的 DOCTYPE、processing instruction、未知实体、不完整及含糊边界保持原文阅读。

Core 已注册命名格式是保留名，先沿其精确合同读取；非法保留格式不进入未知类型分支。reaction 的裸 keyword 只在该原格式解释，不推广成通用 XML 属性。通用展示只声明“文本含此协议”，不认证或采用其来源、业务含义和执行资格。原 wire、原 body、source span 与整条 Copy 保持。

目录是无状态编译期公开阅读能力，不是 Runtime 版本协商、控制派发器或消息账本。实际 producer／reader 复用同源标识和语法基元，目录示例调用原 formatter；已注册格式自动进入设置列表、搜索与原组件预览。格式、分享外框、对象链接按各自原阅读合同展示，不能为了卡片强制 XML 化。新增协议应在同一原定义追加，真实 producer 覆盖与 formatter／reader 验证守住遗漏；不从用户历史猜测支持清单。文档不手抄机器目录，业务行为仍归各原 owner。
