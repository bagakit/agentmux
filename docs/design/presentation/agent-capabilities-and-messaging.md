# Agent 身份与消息的呈现

本文保存本主题的视觉、密度与控件约束；行为、身份和动作资格引用交互合同，不在这里复制。原有未确认范围按正文状态阅读。

[返回视觉与密度合同](../agentmux-surface-density.md) · [同主题交互](../behavior/agent-capabilities-and-messaging.md)

**本页章节**

- [注意力与审查密度](#注意力与审查密度)
- [Agents、队列与语义 token 密度](#agents队列与语义-token-密度)
- [Executor 身份一致性](#executor-身份一致性)
- [状态标记与 Executor 叠加密度](#状态标记与-executor-叠加密度)
- [状态、Browser 与 Scratch / Topic 密度](#状态browser-与-scratch--topic-密度)
- [Executor identity 的统一密度](#executor-identity-的统一密度)
- [原生会话变化的就地提示](#原生会话变化的就地提示)
- [Claude Prompt 的提交反馈](#claude-prompt-的提交反馈)
- [Hook 隔离提示的密度](#hook-隔离提示的密度)
- [A2A 消息队列与身份信息密度](#a2a-消息队列与身份信息密度)
- [A2A 的可读消息与地址](#a2a-的可读消息与地址)

## 注意力与审查密度

- 行为、请求处理顺序和恢复边界只由 [交互合同](../behavior/agent-capabilities-and-messaging.md#注意力处理与结果审查闭环) 定义；本节只规定呈现。
- 全局 Needs you 入口和 Session 内交互卡使用同一套状态颜色、图标和文案；列表行优先显示 Agent/Session 身份、请求类型和摘要，数量放在聚合入口。
- 选中的请求复用现有交互卡和动作语言；提交中、失败、请求已过期与列表已空均有独立可读状态，不能只靠颜色表达。键盘焦点在下一项或入口按钮上可见。 入口收起后的焦点归还与较晚操作优先级遵循上述交互合同，不新增可见控件。
- Diff、Browser preview 和继续对话使用结果附近的一组紧凑动作；展开内容才占用详情或 Region，静息时不制造空右栏。
- Context、Usage、Needs you 和 Error 保持不同语义表达；既有未知值保持中性 unavailable/unknown，不能用绿色或 0% 代替未知。本 Feature 不新增 Usage 数据源或仪表盘。
- 预览和审查入口沿用当前 Surface、Region 和服务窗语言；窄屏时可以收进动作菜单，但不能依赖 hover 才能使用。

## Agents、队列与语义 token 密度

- Agents 菜单默认一行对象 + 一行最近动作；Provider/配置/路径降为次级信息，只有事实不足时才显示状态词。
- running 使用稳定静态 glyph，working 使用带节奏的动态 glyph；两者不能只靠颜色区分。
- 队列默认显示短消息、状态 glyph 和数量；展开后提供明确的删除/立即发送动作，失败项使用 warning/error surface，不自动反复闪烁。
- Message Tools 的 token 使用短名和下划线，不把完整 URL/引用文本直接塞进正文；不同 token 类型用形状/前缀/辅助色区分，完整引用只在 hover/详情中出现。
- 识别词命中沿用**同一套下划线语汇**，不新造第二种视觉：它与已插入的语义 token 的区别在于它仍是可编辑正文（尚未替换），故不取 token 的实心/前缀形态，只加下划线提示「这个词可以展开」。提示条与候选菜单复用 Message Tool 的既有浮层与紧凑菜单，不占用输入区的常驻行高。

## Executor 身份一致性

具体 Agent 的图标在各处保留同一 Executor 颜色／角标与默认底图，密度变化只调整尺寸，不丢身份定制。标识编辑控件嵌入该 Executor 配置，不归全局外观；行为归属见交互 SSOT 同名条目。

## 状态标记与 Executor 叠加密度

工作中的 Agent 使用小型活动字形，避免用一个小绿点承担“正在产出”的含义；idle／普通 running 保持无标记的身份图。等待、阻塞、断联和错误只在确有提醒价值时显示右上角标记。Executor 角标缩小到 Provider 图标内部的叠加层，保留一圈很窄的底色隔离，不向外扩张，不和 Provider 身份图分开排布。活动详情菜单使用有限宽度、可换行和最大高度滚动，原因文本与时间、Project 元数据仍能同时读到。
## 状态、Browser 与 Scratch / Topic 密度

- Project 树的 idle、running/working、error 统一为同一宽度的“小图标 + 数字”状态槽；只换 glyph 和语义色，不换控件结构。完整状态名称进入 tooltip/无障碍名称，避免长文案破坏树的列对齐。停止/退出态使用中性颜色，error 只使用于明确故障事实。
- working 与 idle 的计数口径归交互合同「活着和正在产出分开说」，本层只定义它们的视觉层级。
- Browser 页面优先于控制提示；操作、接管与交还的状态密度统一见[《Browser 任务工具与证据的紧凑呈现》](browser-workface.md#browser-任务工具与证据的紧凑呈现)，不另规定占用一行的控制条。
- Space 的 Topics 分类与成员沿[《Project Rail 与 Topic 行密度》](spaces-and-layout.md#project-rail-与-topic-行密度)共用当前导航节奏，不再显示另一个 Scratch 父行或伪造 Folder 层级。标题允许省略但操作和选中态完整；hover 与完整行选中 Surface 可辨。Topic 行的打开状态、更新时间或 Agent presence 用低对比度辅助信息表达，新增和空列表用明确但紧凑的引导；原 Topics 总览保持独立的已 polish 密度。

## Executor identity 的统一密度

- Executor identity 组件在 Tab、树、Session、Board 和 Browser rail 中共享同一图标盒、状态点尺寸、珐琅外轮廓和 hover/focus 信息面板；调用方只提供尺寸上下文，不重写内部间距。
- 自定义 Executor 图标是 Provider 图标内部的小型叠加，不能向外扩成第二圈。状态点只在 working、needs-user、blocked、disconnected 或明确 error 时显示，idle/正常停止不添加常驻装饰。
- 信息面板使用现有 tooltip 的 micro/compact 字号和边距，内容分成身份、状态和一个小型设置动作；设置动作进入 Executor 模板设置，不把 Appearance 的控件复制进面板。
- 既有头像的保留和 Reset 语义归交互合同「旧配置的 Executor 身份不能丢」；所有尺寸下的设置预览与实际身份图保持一致。

## 原生会话变化的就地提示

行为、原生来源资格与人工确认沿 [同一 Run 内的原生会话切换](../behavior/agent-capabilities-and-messaging.md#同一-run-内的原生会话切换)。该 Region 右上 Agent 信息入口用紧凑文字与轻量标记表达「来源变化」或「来源未确认」，不能只用颜色，也不将健康进程画成终局错误。完整旧／候选 ID、依据和确认范围放进原信息面，主工作面不堆机器字段或第二份身份卡。

核对与采用准确候选的动作和原因成组，鼠标及键盘均可达；失败保留选择和服务说明，取消不写入。窄 Region 下文字可换行、长 ID 可按需完整读取和复制，操作命中区不能被挤出或遮住。提示不抢输入、不遮挡终端连续阅读，不因无关刷新自动消失；正常完全确认后保持安静。候选实际宽窄画面与确认／失败动作沿既有独立看图评审验收，采图或源码字段存在不能代签。

## Claude Prompt 的提交反馈

发送动作保持与其它 Provider 同一枚主按钮和命中区；提交是否完成由运行事实或终端回显确认，不能只靠按钮瞬时禁用。Claude 仍在输入编辑态时，Message Tool 要保留文字并显示正在提交/需要重试的状态，避免用户误以为任务已开始而继续操作。

## Hook 隔离提示的密度

- 主会话与下属记录的归属以交互合同[《Hook 配置隔离与非 AgentMux 会话》](../behavior/agent-capabilities-and-messaging.md#hook-配置隔离与非-agentmux-会话)为准；不能在恢复或历史入口中把下属记录显示成主会话的完整记录。正常下属生命周期事件不增加主工作面的错误噪声。

- Hook 未安装、来源未关联、共享配置冲突或探测失败使用靠近受影响 Agent 的一行 warning/info 服务窗；文案说明步骤、当前降级能力和恢复动作，不展示 Provider 共享配置的内部路径作为常驻产品信息。
- Doctor 的逐 Provider 策略、磁盘安装与加载确认按交互文档[《Hook 配置隔离与非 AgentMux 会话》](../behavior/agent-capabilities-and-messaging.md#hook-配置隔离与非-agentmux-会话)区分表达，不用一个“已安装”标签代替不同事实；未知沿现有一行服务窗说明，不增加状态灯或阻断输入的提示。
- 磁盘检查沿用 Doctor 的逐 Provider 诊断呈现，状态、检查范围和行动紧邻；不增加常驻安装灯、全局汇总标签或另一套 Settings 状态缓存。只读点时检查与正常连接后修复的行为归同一交互合同。
- 非 AgentMux 会话被识别为无关联事件时只保留低干扰诊断，不弹出阻塞对话框、不禁用 Composer，也不把健康 Agent 标成错误终局。
- Hook 的 AgentMux 关联身份属于低频元信息，放入 tooltip、详情或诊断收据；主工作面只显示当前能力和可执行恢复入口。

## AgentMux 注入上下文的阅读

范围、唯一包装、用途与投递形式以及来源边界只见[《AgentMux 注入上下文》](../behavior/agent-capabilities-and-messaging.md#agentmux-注入上下文)。沿[完整前导声明的同记录阅读](../behavior/terminal-reading.md#terminal-连续向上阅读历史)保留可展开原文与真实尾文，不把声明画成认证徽章；正文密度沿[《用户消息气泡的内文密度》](conversation-input.md#用户消息气泡的内文密度)，不因规范统一新增视觉层。

## A2A 消息队列与身份信息密度

- 非历史 CLI 当前回执与无关原生读取依赖边界归交互合同[《持久消息的显式消费与派发等待》](../behavior/agent-capabilities-and-messaging.md#持久消息的显式消费与派发等待)，不另造提示或输出协议。
- 显式消费沿现有 CLI 结构化回执与可读信封表达批次、Run、消息身份和真实投递状态，不增加常驻界面入口或第二种已读徽章；通信语义唯一来源见交互合同[《持久消息的显式消费与派发等待》](../behavior/agent-capabilities-and-messaging.md#持久消息的显式消费与派发等待)。
- 本次跨 Session 消息来源优化沿既有一行来源与正文呈现，不新增视觉层或认证徽章；统一来源头、首条及 `whoami`／启动／技能的使用要求只引用交互合同[《A2A 身份信封与持久化全局消息队列》](../behavior/agent-capabilities-and-messaging.md#a2a-身份信封与持久化全局消息队列)。

- 发送回执与收件侧信封必须能对应同一条消息：首层明确显示已入队、已投递或失败，详情能核对稳定 `messageId` 和 Core 核验的双方 Session/Run；重试不得像一条新消息，队列暂不可写时不得出现虚假的“已送达”。交互行为以[《A2A 身份信封与持久化全局消息队列》](../behavior/agent-capabilities-and-messaging.md#a2a-身份信封与持久化全局消息队列)为准。
- 收件来源显示 Core 已解析的参与者身份；Region、Tab 和其他视觉位置不能冒充发送者或接收者。实际可读来源与机器消息字段的归属只见上述 A2A 交互合同，不沿用旧 XML 属性表达。
- Message Tools 的首层只显示发送者、接收者、当前投递状态和必要的失败/重试动作；`messageId`、receipt、generation、thread/correlation 和 workspace/session/run 关联进入详情或审计入口，不占用 Composer 主输入区。
- 队列重启、replay、背压或 Store 降级使用现有 Agent/Session 服务窗的一行状态提示，说明事实、当前能力和恢复动作；不清空消息列表、不覆盖 Composer，也不把健康 Agent 画成终局错误。
- 读取和审计入口支持按 thread、recipient、session 或 receipt 收窄范围；默认列表按 durable sequence 排序，不能用当前 Region 或视觉位置替代消息身份。

## A2A 的可读消息与地址

- 收件消息用一行来源与正文建立阅读顺序。已核验 Agent 与未核验来源以文字区分，通道只在详情出现；原文 JSON 也作为正文阅读。短地址沿用等宽元信息样式，完整持久地址可复制，机器回执不占正文。身份、碰撞与部分地址判定只按交互合同[《A2A 消息要让人一眼看懂》](../behavior/agent-capabilities-and-messaging.md#a2a-消息要让人一眼看懂)执行。
- 可复制地址直接使用权威身份，不为首字符另加显示前缀、转义标签或别名；合法地址的行为约束归交互合同。
