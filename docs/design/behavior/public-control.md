# 公共控制与跨客户端接入

本文集中本主题的交互与行为要求。已确认约束定义必须成立的结果，不代表当前实现通过验收；提案、历史与当轮授权状态按正文的明确范围阅读。

[返回交互合同](../agentmux-desktop-interaction.md) · [同主题视觉](../presentation/public-control.md)

**本页章节**

- [AgentMux 自操作与 Computer Use 边界](#agentmux-自操作与-computer-use-边界)
- [Agent 操作桌面主画面与保留对话输入](#agent-操作桌面主画面与保留对话输入)
- [Agent 通过 CLI 打开文件与控制原工作面](#agent-通过-cli-打开文件与控制原工作面)
- [自举：在 AgentMux 里开一个 Agent 优化 AgentMux](#自举在-agentmux-里开一个-agent-优化-agentmux)
- [Browser 通用能力协议与 CLI/Skill 接入](#browser-通用能力协议与-cliskill-接入)
- [本地页面托管](#本地页面托管)
- [对象优先 CLI 与统一公共业务服务](#对象优先-cli-与统一公共业务服务)
- [统一全局搜索](#统一全局搜索)
- [Topics 知识库的公共接入](#topics-知识库的公共接入)
- [Agent-first 的 Space 工作入口](#agent-first-的-space-工作入口)
- [手机版 Relay 连接](#手机版-relay-连接)
- [对象地址、分享与方向](#对象地址分享与方向)
- [Agent 自助创建与空间操作](#agent-自助创建与空间操作)

## AgentMux 自操作与 Computer Use 边界

- Agent 操作 AgentMux 自身时，必须使用 AgentMux 自有的 typed Control 协议与语义 CLI；Agent、空间、Goal 与应用操作按[对象命令](#对象优先-cli-与统一公共业务服务)接入同一公共业务服务，由各自原 owner 执行。不得通过截图、坐标点击、macOS Accessibility 或其他通用 Computer Use 旁路完成本产品已有的操作。
- AgentMux 的产品运行、Session/Run 生命周期、Board/PMO 管理和发布验收不得把外部 Computer Use 工具作为前置条件。外部工具不可用、权限过期或观察失败时，保留产品自身的真实状态并给出诊断，不得阻断健康 Agent。
- 内嵌 Browser 的网页操作继续使用已有 CDP/Browser Control；它是页面语义通道，不是 macOS 辅助功能，也不复制一套桌面自动化 Runtime。
- 用户确认：「agentmux 应该有自己的 computer use 方案」。AgentMux 应向 Agent 提供自己拥有的 Computer Use 能力入口与真实执行反馈，用于桌面观察和操作；这是一条独立需求，不能把开发者临时调用外部工具算成已经交付。
- AgentMux 的 Computer Use 与已有自操作 Control、Browser CDP 各有清晰职责：已有产品语义操作仍走其现有 owner；系统桌面能力的实际执行属于 Desktop／平台适配边界，不把 Electron、系统窗口或辅助功能实现带入无 UI 的 Core，也不复制 Agent／Run 生命周期。
- 桌面权限缺失、目标窗口消失或操作失败必须如实反馈，不能冒充成功；该能力不可用不能阻断健康 Agent 的输入、启动与恢复。外部桌面自动化工具仍可用于独立开发验收，但不是产品启动或发布的前置条件。

## Agent 操作桌面主画面与保留对话输入

Agent CLI 能操作 AgentMux 桌面应用本身：Agent 和用户交流时能切换界面；理想情况下，Mote 在浮窗里交流的同时，可以改变主画面当前聚焦的 Space 或某个 Goal，也方便 Agent 自行迭代、调试和观察。该能力沿同一公共业务服务的 `app focus`／`app inspect`、`space focus` 与 `goal focus` 接入，具体呈现与输入仍由原 Client owner 执行；不把系统桌面 Computer Use、Browser 操作或 Agent／Run 生命周期并成另一条 Runtime。

Work、Survey、Recall 与左下 Mote 面板的导航范围，以及明确跨上下文动作的一次带入语义，只见[Work、Survey、Recall 与 Mote 的导航上下文](spaces-and-layout.md#worksurveyrecall-与-mote-的导航上下文)。本节公共动作继续分别报告选择、呈现和输入，不因入口或共享实体合并各上下文的目标。

- **主画面与对话输入分别成立。** 选中主画面目标不等于真实 caret 已转移。默认导航保留仍在交流的 Mote 浮窗、同一对象／Tab／Region、原 View、真实 caret、草稿与组字，不关闭、重新创建、重选或自动发送其内容。只有调用者明确要求把输入交给精确目标时才尝试输入焦点转移；不能为证明主面导航成功先 blur 浮窗再恢复或挑一个编辑框。
  用户继续点击或输入浮窗，选择该原 Tab 内的精确 Region、原输入与逻辑 lane；浮窗自己的活动 Region、焦点标记与观察须跟随这次局部选择，主面保留的源焦点即使来自同一 Tab 也不能覆盖浮窗的局部选择。固定浮窗仍保留原有的输入与人工操作能力。不能因此清掉主面精确 Space／Zone 地址、改变无关 Workspace／Group 或保留的源焦点，或重新授权另一处 launcher 自动激活。人工在主面明确导航或新建 Tab 仍按原交互执行。
- **用真实身份导航。** Space／Zone／Tab／Region 只沿[《统一概念与空间寻址》](spaces-and-layout.md#统一概念与空间寻址)的真实来源，Goal 沿用原持久 ID。精确子目标可反推父层，父子不一致或多候选不能猜最近、第一张 Tab 或别人的 Agent。导航仅改变既有展示选择；不创建 worktree、Tab、AgentSession、任务或 PMO，不移动 Region，不改执行 cwd／Run／原生句柄，不停止健康 Session。
- **Focus 的列表与地图沿同一导航 owner。** 原 `app focus` 可显式选择 Focus 的 `list` 或 `map`，首次默认列表，省略视图时保留上次选择；其他主 Surface 不接受 Focus 视图参数。Space 始终展示原工作面，准确区域继续沿原 `space focus` 选择。Space 的就近定位动作以当前准确区域或 Agent 的原身份进入同一 Focus 地图，不能复用另一项任务留下的定位目标，也不恢复 Space 的地图模式。`app inspect` 与导航回执分别报告实际所选的 `focusView`、对应视图的真实呈现及原输入；非 Focus 的 `focusView` 为 null。模式切换保留同一地图实例、相机、阅读和原工作面，不以重新定位或重建代替切换；明确定位 Agent 才沿原准确身份改变地图阅读位置。地图保留原 Space／Zone／Tab／Region 选择作为上下文，不把这些保留地址报成已呈现的 Region，也不接受原工作面的输入转移。地图不新建 Surface、Agent、空间或关系事实；是否已可见由原 client 唯一实际可见的对应 Focus 视图确认，不能只看 Store 选择或命令受理。离开 Focus 保留已选模式，明确打开原工作面成功后才离开地图。原输入被隐藏后即使仍连接也不得称为已保留可用输入；保草稿、不 focus／blur 与输入当前可用性分别成立。
- **准确 Agent 可直接在 Focus 中显露。** 原 `app focus` 接受带准确 `hostId`／`agentSessionId` 的 Focus Agent 目标，CLI 沿 `app focus --surface focus --host HOST --session SID` 表达，固定进入列表且保留输入，不接受地图视图或输入转移。目标沿原 Session 展示索引与上下文 owner 解析，不凭同名 SID、标题、MRU 或最近 Region 猜目标。回执和 `app inspect` 报告准确目标及实际可见、隐藏或未确认的阅读状态，不以切到 Focus、设置选择或受理请求代签卡片可见；临时显露和跨视图导航行为见[协作图导航](a2a-collaboration.md#工作区域与-agent-协作图)，执行、历史与协调上下文继续沿[原 Focus owner](focus-context.md#focus-执行上下文项目泳道与底部时间音轨)。
- **选择、呈现、输入三种事实分开。** 回执与只读观察分别说明主 Surface、所选 Space／Zone／Tab／Region 或 Goal、实际可见／借到浮窗／受遮挡／等待恢复的呈现位置，以及真实输入所在位置；执行与 PMO 逻辑 lane 不能冒充 DOM caret。Mote 的临时悬停、固定开合、精确目标与真实输入状态来自原 owner，不复制浮窗状态或内容实例；同一 View 借到浮窗时，不能用主面选中 ID 代签主面正文已经可见。
  主面选中的原 View 正在 Mote 浮窗中时，原位置须持续就地说明已选中的位置、视图当前所在及关闭浮窗后的返回方式；不能只留下空白、底栏红点或默认收起的通知列表。说明不关闭、重新选择或复制浮窗，不抢原输入。
  用户确认关闭所选投影后，当前子选择沿真实布局在同一 Space／Zone 内更新；没有同父落点时保留父地址与空子选择，不能跳到别的 Topic。Runtime 暂缺或快照为空不等于投影已关闭，原 durable 引用仍须保留。
  后台搬迁当前 Region 仍遵守原空间移动的源面与逻辑焦点保护；主面地址保留源 Space／Zone，失去的子投影不能冒充仍在源面，也不能借机选中邻居。
- **观察不改工作。** Agent 可只读取得准确主面与浮窗状态，输出能用于后续精确命令；不触发切换、聚焦、启动／停止、重投、refresh、展开或收起。观察仅含语义身份和呈现／输入状态，不读取草稿正文、终端输入、选区文字或剪贴板；缺事实明确 unknown，不能按配置或记忆填成已观察。
- **失败保留原能力。** 目标不存在、关联未知、渲染尚未确认、overlay 阻挡或输入不可达分别报告，已应用的展示选择与未确认的真实结果不能混同；服务窗说明失败步骤和现有可用状态，不遮住原工作面、不抢输入，也不因流程观察失败关闭健康 Agent。普通进程重启先恢复原 durable 选择、工作面、浮窗固定目标与 Session 引用，继续原恢复路径；瞬时 caret 不冒充持久化事实。

本项与 Agent 创建／空间移动、Mote 快捷面 hover 各有独立交付边界，复用各自已有 owner，不重做它们的生命周期。精确参数与缺省值以当前执行版本的 `amux app focus --help`、`amux space focus --help` 与 `amux goal focus --help` 为准，回执类型从[公共能力来源导航](../../specs/public-capabilities.md#按能力找到定义与消费者)的展示导航一行进入。

Settings 是原主画面之上的覆盖面，`app focus` 可按原 Settings catalog 的准确 section ID 打开分节，`app inspect` 发现候选并报告实际已选分节；不把 Settings 另造为主 Surface，不复制配置、页面草稿或目录。默认 preserve 只保留仍可用的真实输入，不能通过 Panel 自动聚焦搜索或关闭复焦破坏它；原主面输入因覆盖而不可用时如实报告，Mote 浮窗的可用输入继续保留。未知分节只拒绝本次导航并保留原页面与草稿。显式关闭 Settings 也沿原覆盖面 owner，保留未保存编辑与仍可用输入，不用关闭后重新创建页面或强制复焦来伪造保全。

自举像素观察和可停止录制沿[工作面自截图与录制](capture-and-recording.md#工作面自截图与录制)，原语义操作、像素和权限决定各自沿原 owner。

### 对话消费者的只读观察

`app.inspect` 可带 `conversation` 查询，CLI 以 `app inspect --input` 消费同一参数：准确 Host／Session、可选预期 Run／consumer，以及带来源身份的原记录引用。不带查询继续返回原客户端观察；带查询返回独立的 `agentmux.conversation-consumer-observation.v1`，只读取已挂载消费者。没有消费者返回空集合，身份或文档来源未知保持 unknown，不冒充 Session 不存在或记录缺失。

观察沿现有 Main／Renderer 通道返回已加载 owner、实际 DOM 所属窗口与文档代次、原消费者的读取资格、已接受和因阅读保护暂缓提交的窗口、checkpoint／来源覆盖、在途与订阅状态，以及准确记录是否在原窗口中。挂载消息卡、正文是否被折叠／隐藏，以及原记录展开控件分别表达；正文未隐藏不证明处于屏幕可视范围或像素已经绘制。记录成员关系不证明原生采用、消息送达或正文已完整读到。

查询不挂载、激活、重读、刷新或重试，不解除阅读保护，不改变焦点、草稿、Run 或输入资格。只保留挂载回调，不复制正文、窗口、来源账本或持久状态；DOM 扫描只随被查询消费者及准确引用发生，不新增 Reader、轮询或无关 Session 的工作。对话读取与重试行为仍由[同一对话阅读面](conversation-mode.md#连续统一的对话列表)约束。

## Agent 通过 CLI 打开文件与控制原工作面

Agent 能用本产品既有 CLI 打开文件／Editor、切换 Region 展示模式和交换 Region，操作原工作面。文件资源、Agent 的 Session 展示偏好与 Region 的空间表现必须按原 owner 分清，不复制文件服务、catalog、布局或 Runtime。

- 文件按精确 Zone 的真实目录与字面目录相对路径打开，再沿原资源关系映射到既有 filesAPI 的 Workspace 相对路径；Topic 目录不能偷换成隐藏容器根。显示落点使用原 Space／Zone／display Workspace／group 身份，不能按 caller cwd、标题或当前主面猜位置。目录与原资源根映射未确认时如实未知，不改执行事实。文件入口打开或复用原 canonical File Tab／Region；零 Tab 的已有 Zone 可打开第一张 File Tab，不新建 Zone、Agent／Run，不替换 Launcher 或别人的内容。显式显示落点不能把资源根改成显示目录，也不能静默重归属已有 File Tab。
- 文件默认后台放置，显式导航也默认保留仍合资格的现有 Mote／Terminal／Editor 输入、草稿和组字；旧输入因显示变化失去资格须如实未确认，不能 focus／blur 后恢复来补签。资源创建、读取、实际格式、精确落点与导航是否仍获授权分别说明；异步读取完成前用户已经导航，不能抢回主面或把晚回执指向替换者。文件面已建立但读取失败仍保留原面与准确原因，不能从未获导航授权推断未打开。目录不作为 File 打开，书签源码不顺带开 Browser；媒体和二进制沿真实预览，不冒可编辑 Editor。
- Terminal／Activity 是 exact SID 的展示偏好，影响该 SID 的全部原投影；File 的 source／diff／preview 是 exact Region 的互斥模式，影响同一 Region 的全部呈现，不影响另一 Region 的同文件视图。合法 opaque ID 按原 own-entry 读取，不把继承属性当实际覆盖。暂缺 Core 快照不能阻断原 durable AgentRegion 的显示选择，不探测 readiness、不猜另一个 Session。CLI 改展示偏好不改主面选择、逻辑 lane、Session／Run 或 cwd，不隐式授权 caret 转移；输入资格变化如实未确认，原 GUI 明确操作保持其既有行为。
- File 模式由同一个原 Region owner 决定真正正文与菜单状态，不能同时保留 local preview 与 diff 让明确选择被遮盖。File 的实际格式与预览范围唯一遵循[《本地文件预览与按格式编辑》](files-and-git.md#本地文件预览与按格式编辑)：HTML 的同 Region 隔离预览与源码分别表达，不能把 HTML 源码显示冒充已经提供预览；普通文本不冒 HTML，媒体与已知二进制只读预览。支持范围来自实际格式与读取事实，未知如实未知；模式已应用与 preview／diff 数据可用分别说明。切换保同一原文档、未保存内容及每 Region view state，projection 模型沿原生命周期可释放／重建；仍合资格的原输入不被抢，失去资格如实未确认，不保存文件或阻断健康 Run。
- 交换只换同一 Tab entity 内两个 exact Region 在原分割树中的位置，比例、逻辑活动 ID、内容身份及其执行事实保持。同一实体的所有显示 occurrences 共用该布局，回执明确共同作用范围，不因多个位置误报实体歧义，也不宣称只改其中一次呈现。主面保留的源焦点与借出浮窗的局部选择仍按原 presentation 事实，不以复制 surface／内容身份或新建 Run 换位。DOM 与模型依原呈现生命周期，仍合资格输入不被抢；不以 Store ID 代签同 DOM／caret，未知如实未知。
- 只读模式查询与观察不触发读取、diff、持久写、refresh、Launcher 预热或生命周期。操作回执分别给出已应用、未确认和真实 save 事实；掉回执不能按未执行自动重放，尤其交换不能再执行一次。保存失败保已应用工作面与健康内容，持续服务窗说明哪步失败、当前状态和恢复动作；flush request 不能冒充磁盘 ACK。
- 普通进程重启先恢复原 File／Agent Region、Tab／group／布局与 Session 引用。Agent 展示偏好沿原持久 owner；File Region 模式沿原临时策略恢复到格式默认，不另建持久模式 Map。读取与握手失败保原面，不把缺快照当已关闭。现有内容的观测与消费成本只随相关实体／occurrences 增长，不读取全量终端输出或为无关会话增加工作。

## 自举：在 AgentMux 里开一个 Agent 优化 AgentMux

目标是在 AgentMux 里开一个 Agent 调试和优化 AgentMux 本身：它要能快速操作 AgentMux，而不是只靠 Computer Use 点击界面；操作之后能取得相关元信息和截图来加速迭代。用户提醒这对代码架构的挑战较高，需要深思熟虑。

自举沿产品公共能力完成三个环节：

- **快速操作**：Agent 通过[对象优先公共服务](#对象优先-cli-与统一公共业务服务)调用原业务 owner；CLI 与各公开传输（见[服务传输与接入层](../../specs/public-capabilities.md#服务传输与接入层)）共用同一 JSON-RPC 2.0 方法。具体命令、参数及可用能力来自实际注册与运行时发现。`control.ts` 的内部 typed Client port 不充当另一种公开 wire。
- **回看结果**：`app inspect` 观察真实展示选择、呈现和输入事实，`app snapshot` 聚合跨对象事实；各对象的 inspect 读取该对象。截图能力仍由 Desktop Main 持有，按下述目标和观察时刻合同扩展；暂不可用的观测如实报告。
- **共同入口**：自举操作与观察复用同一公开服务、caller 校验、业务错误和权威事实，沿 Core 与 Client 原 owner 分工。

自举还必须守住四条边界，每条都对应一种具体的错误结果：

- **观测归原对象的公共方法。** 应用观察与对象 inspect 按[统一对象语言](#对象优先-cli-与统一公共业务服务)分域；截图与元信息扩展仍复用同一 caller 校验、错误事实及回执合同，保持原观察权限边界。
- **截图由 Desktop Main 持有，并标明拍摄时刻与目标。** 原生窗口能力只有 Main 持有（见[Owner 边界表](shared-rules.md#owner-边界)）。截图必须带 `observedAt` 与目标 Region 身份；缺少它们时，Agent 可能拿操作前的旧图判断操作已经成功。这一刻取不到截图时如实说明取不到，沿[健康能力与未知状态](../../../AGENTS.md#健康能力与未知状态)，不用时刻不明的图代替。
- **元信息只投影既有事实，不为自举新建注册表。** 布局树、Session 投影、Region 绑定已有唯一 owner；观测接口读取它们，不另存一份“给 Agent 看的状态”。两份状态会分叉，分叉后 Agent 会依据错误的副本修改代码。
- **自举 Agent 不享有特权。** 它和其他 Agent 使用同一套授权：能做什么由其 Run 的调用凭据（capability）、原任务授权及启动时确定的 Provider 权限选项决定，不因“正在优化 AgentMux 自身”放宽任何限制；这类后门是本功能最危险的失败方式。

## Browser 通用能力协议与 CLI/Skill 接入

本节持有 Browser 能力的协议层，以及 CLI、Skill 与其他客户端怎样接入这一层。操作记录、人工接管与交还、历史入口和重复 `operationId` 的行为归[Browser 工作面](browser-workface.md#browser-工作面-1)，本节只引用。

- **协议层是 Browser 能力的唯一事实入口。** 能力清单、权限、身份、requestId、operationId、事件与进度、取消、历史、回放和 indeterminate 结果都从这一层给出。CLI、编辑器自身以及后来的 MCP／HTTP 适配器都是这一层之上的平级客户端，不绕过它直接驱动 Browser，也不各自保留第二份语义。编辑器现有的停止、历史与回放入口与协议重叠，必须收口到同一入口；与能力无关的视口、截图、DevTools 等本地控制不在此列。
- **协议放宽的类型只在一处收窄。** 协议不持有 Desktop 的步骤语义，也不为 Desktop 多一档状态而发版本，所以 phase 与 step 在协议中放宽。Desktop 收窄这些值时只经过一个入口：两个入口就是两份词表，新增一档时漏改一处会让这一档在其中一条路径上静默降级。认不出的状态落到“不确定”，不改写成一个看起来相近的已知档位。
- **CLI 只做适配，不做判断。** CLI 把命令与 stdin 转成协议请求，按稳定信封打印回执。“什么算合法请求”只在协议层判断（通用规则见[公共业务协议先于 CLI](#对象优先-cli-与统一公共业务服务)）：既不在 CLI 与协议各写一遍，也不只写在 CLI，否则直连协议的客户端会得到 CLI 客户端得不到的不确定结局。
- **面向 Agent 的能力说明从协议与运行时能力生成。** 页面能力名、签名和错误码这类机械部分只有一个来源，由它渲染 Skill 文本。手抄一份再用扫描测试对齐不算满足：扫描只对齐名字，不对齐签名与错误信息，并且会在锚点消失时静默恒真。意图说明仍由人维护，但不与机械清单争夺事实。
- **页面能力清单作为数据跨层流动，不作为协议操作。** 协议表面保持 `browser` 命名空间下的少量操作；`snapshot`、`click`、`js`、`cdp` 这类页面能力属于库层词汇，提升为协议操作会让每次增删能力都变成一次协议版本变更。观察—行动—验证闭环写在脚本里，`js` 与 `cdp` 两个逃生口是必须项。
- **operation 的寿命长于任何一条连接。** 一次操作从可被引用的那一刻起就有稳定身份，运行期间可被其他连接查询、订阅进度和取消。CLI 断开、daemon 重启或客户端换连接都不能让操作事实消失或变成“没有这回事”；无法继续的操作沿[Browser 工作面](browser-workface.md#browser-工作面-1)的历史合同表达为中断或不确定。operation 身份只有一个铸造点，重复提交由同一唯一日志 owner 裁决。
- **取消针对 operation，不针对请求。** 判据是那次操作是否停下，而不是某条请求是否被放弃。对已经结束的操作取消是幂等成功，并返回它的终局。
- **人工控制期间的拒绝必须机器可判。** 人工接管与交还的行为归[Browser 工作面](browser-workface.md#browser-工作面-1)。协议层要求：人在控制中时，Agent 的驱动请求被拒绝且带类型化原因，使协议客户端能区分“人在用这一页”与故障，而不是只收到一句说明文字；Agent 不能靠重试夺回页面。
- **协议自身的流程失败不拿走 Browser 已有的能力。** 订阅建立失败、进度流中断、查不到某条 operation、版本协商不一致都属于流程状态：操作照常执行、页面照常可用，同时用服务窗说明哪一步没有走通、当前按什么状态运行、怎样恢复完整能力。只有能力本身不可用（页面已不存在、进程已退出、注入清单无法读取）才阻断。进度有缺口时说明缺口，不静默丢事件。
- **事件游标只在一个进程生命周期内有效。** 普通响应与订阅的通用帧合同见[传输、业务回执与持续读取](#传输业务回执与持续读取)。Browser 事件落盘时不带序号，重启后用旧游标续读没有意义：客户端从头读取，或接受一个明确说明的缺口。
- **外部客户端能接入这条协议。** 端点位置与协议版本必须可以从产品自身问出（`system endpoint`），不要求对方复算内部派生规则；目标是让另一种语言写的客户端能接入，而不是服务某个具体客户端。
- **全链路与站点、厂商无关。** 协议、CLI、生成的能力说明与公共测试只依赖通用事实（页面能力名、通用逃生口、URL scheme、导航事件、人工输入）。实现分支、公共测试和验收条件不预设具体站点、按钮文案或厂商协议；真实站点只作黑盒验证输入。

## 本地页面托管

独立模块、内容托管、隔离／注入模式、稳定身份、对象链接及 HITL 的唯一需求正文见[持久交互页面 PRD](local-page-hosting.md)。页面模块的 CLI、skill 与客户端沿下述公共业务服务接入同一领域 owner；准确接口与运行时支持范围仍由原协议及实际能力发现提供。

## 对象优先 CLI 与统一公共业务服务

### 完整业务链与公共扩展

CLI 的完整性以用户或 Agent 能完成的原业务为单位：从原对象与能力发现，取得准确参数和预期修订，经唯一 owner 执行，再读原结果或当前事实。公共方法有命令名、help 非空或 GUI 已可用，都不代签这条链已接通；需要逐层核实际 Host／Desktop composition 与真实消费者。

扩展沿现有业务对象和 typed 公共合同，不提供任意 SDK invoke、shell trampoline 或配置 JSON path setter。GUI 与 CLI 消费同一 owner，必要协调在原边界提炼，不复制状态、Provider 输入规则或文件系统实现。Core 仍无 UI 依赖，ctxmux 仍持有 Run／PTY／bytes；已存在的成熟 Git／GitHub 工具继续承担通用资源操作，AgentMux 持有自己的资源身份、工作面与 Runtime 事实。

普通已知配置以准确对象、完整 CAS 和当前只读查询闭合；当前值不是历史保存 ACK。产生新身份或有不可重放效果的动作须在原业务 owner 绑定原 actor、operation、冻结请求与结果。已有业务 journal 直接复用；不得为统一名字给每个标量增加操作数据库或通用授权平台。未知原效果可持续只读查询并保留请求，不能要求所有 unknown 自动变确定，也不能用重调 mutator 冒充 inspect。

复杂 JSON 载荷的 leaf help 给出完整准确字段、合法值与最小可运行形状，示例经原 domain parser 核对；不让使用者必须读源码才能构造正常调用。共享 `--flag=value` 转义在准确参数语法边界一致成立，positional IDs、路径和 JSON／stdin 正文仍是字面数据；解析失败不能被报告成 Host 或 Run 故障。

相关业务约束各归原专题：Provider 声明与模式意图见[Provider 能力](agent-capabilities-and-messaging.md#provider-能力对齐与移植边界)，raw Terminal 读写与控制见[终端公开字节边界](terminal-reading.md#ordered-bytes-的公开传输边界)，工作面关闭见[Session、Run 与 View](session-recovery.md#sessionrun-与-view)，资源文件和 Git 见[Folder 与项目树](spaces-and-layout.md#folder-与项目树)，Profile 创建见[Profile 管理](browser-workface.md#profile-管理环境与指纹编辑)，Notes 原操作见[笔记目录与搬迁](knowledge-workflows.md#笔记目录设置与搬迁)。这些约束不证明某构建或安装实例已完成。

公开 CLI 按业务对象组织，`agent open` 与 `space mv` 是创建 Agent 与移动展示位置的主入口。PMO 仍是协调工作方法／角色，不把原 PMO 查询改名为 Mote 查询；跨对象观察归 `app snapshot`，各对象的 inspect 归其对象，原 PMO activity 来自 Goal 的活动事实，归 `goal activity`。公开词汇以 Goal 取代 Demand，旧顶层动词与原 Demand 词汇不保留兼容别名。

**主公开 CLI 的可执行名统一为 `amux`。** 命令发现与帮助、版本输出、skill／运行时指引、复制与错误恢复动作、`AGENTMUX_CLI` 注入的可执行路径、默认远端 CLI 调用及打包安装产物必须使用同一真实 `amux` 入口，不依赖 shell alias 或保留另一主 CLI 名作为兼容用法。源码、编译产物、安装入口与实际消费分别核对，不能只改展示文本或用别名可执行代签一致。

`AGENTMUX_CLI` 环境变量键名保持不变，其值仍须指向实际 `amux`。产品品牌 `AgentMux`、包作用域 `@agentmux`、内部文件与符号、环境变量、schema、协议及独立 helper 的身份各有原 owner，不随主 CLI 拼写机械替换。用户已保存的显式 command／path 保持原值；统一默认入口不改写这些配置，不停止、重启或替换健康 Run，也不更改原 Session、持久数据或工作面。

- **公共业务协议先于 CLI。** 所有产品业务先由一套公开、类型化的 JSON-RPC 服务合同定义；CLI 与各公开传输共用同一方法、授权、业务结果和错误事实。传输只承担请求／响应与流的输送，CLI 只解析参数、调用服务并呈现回执，不直接读写本机 Store 决定 Session、角色、Goal、消息或空间业务。公共方法不能要求调用者是 Electron／React 客户端，也不能要求当前 UI 焦点或本地目录才能解释精确目标。
- **权威职责与空间来源。** Core 保持无 Electron／React 依赖，持有 Provider、AgentSession、权限、Hook、readiness、语义恢复，以及前端独立的持久空间身份、拓扑、布局、选择与全部绑定；空间与执行身份的含义见[《统一概念与空间寻址》](spaces-and-layout.md#统一概念与空间寻址)。ctxmux 独占 Run、PTY、ordered bytes、Replay、Gap 与 Attachment。Client 消费 Core 空间事实，负责屏幕呈现与真实输入焦点；配置、编辑、文件／Topic 目录、Git 与 Browser 资源能力仍由原 Host／Client owner 提供，经同一公共服务接入。不新增一套 Runtime、Topic／Project／Space／Session registry、持久空间镜像或 CLI 专用业务判断。
- **请求关联与业务操作身份分开。** JSON-RPC 关联 ID 只匹配一次 wire 请求与它的响应，换连接或重发时就会改变；业务 `operationId`（CLI `--operation-id`）跨连接、跨进程重启保持不变，丢回执后据此沿原 owner 对账。因此 JSON-RPC ID 不冒充 AgentSession／Run、持久创建身份或 Browser／Toolkit 等 operation ID。现有 operation 级查询、停止与输出流是业务能力，可由 JSON-RPC 方法调用，不因采用 RPC 而取消或混为 transport cancellation；取消或断线只释放相应 reader，不停止健康 Agent 或原业务 operation。丢回执时按原 owner 的准确业务身份对账；未知不当作从未发生，不重复启动、移动或重投首句。健康 Agent 保留、重启恢复和流程降级继续沿原合同，不以 wire／握手失败关闭健康 Run。
- **业务错误经传输保真。** Core 已区分的错误类型（例如“另一条消息正在投递”与“Session Store 读取未确认”）经过公开 Control、RPC 与 CLI 后仍保留原类型、detail、候选与 unknown；消息与原 Session／Run 保持，未确认不等于退休或进程故障。提示只给真实可执行的下一步，不指示重新创建、停止健康 Run 或盲目重放未知投递。错误码由同一协议来源给出，不在 CLI 另抄清单；协议回执通过不替代 Desktop IPC 错误字段传输的实际证明。
- **同一公开表达。** 对象命令树约束实际 CLI、help、技能输出、运行时指引、复制内容、错误恢复命令与 RPC 方法语义；不能只换 help 或把原本跨域能力藏到另一个别名。对象发现的结果须可原样用于准确输入，AgentSession、执行资源与展示位置分开返回；公开 Goal 词汇替换 Demand 时沿用同一个原持久身份、已保存内容及关联，不造新 Goal、不改 ID 或用户数据。
- **展示导航沿原合同。** `app focus` 表达主 Surface 的选择，`space focus` 与 `goal focus` 表达精确对象导航；选择、真实呈现和输入 caret 仍分开报告，默认保原 Mote 对话输入、草稿和组字，不改执行 cwd、不关闭健康 Session。原展示 owner 及对象间职责唯一见[《Agent 操作桌面主画面与保留对话输入》](#agent-操作桌面主画面与保留对话输入)，不因命令归域再造 router 或 caret owner。

### 命令按业务对象归域

对象入口回答“操作哪一类业务对象”，动作回答“对它做什么”。以下几项只是说明归属的例子，不是完整清单：`agent` 承担 Agent Session 的发现、输入、对话与生命周期；`space` 承担持久空间身份、布局与准确导航；`goal` 承担 Goal 范围、执行责任与巡查；`app` 承担跨对象观察、全局搜索与主画面导航；`settings` 承担 Host、Executor 等配置；`system` 承担端点、诊断与指标；`device` 承担手机设备的接入与撤销。

- 完整模块、动作与参数只以当前执行版本的 `amux --help`、`amux <对象> --help`、`--skill` 及其注册来源 [`AGENTMUX_CLI_COMMANDS`](../../../packages/core/src/agentmux-cli-commands.ts) 为准；本页不手抄模块或动作清单。
- 新能力优先归入其业务对象已有的入口；只有出现新的业务对象时才新增对象入口。不按 Feature 名新增顶层域、兼容别名或通用任意执行入口。
- 每个动作仍服从其原业务 owner 的权限、只读／副作用与恢复边界；命令已注册不等于能力已验收。

### PMO 的发现与跨工作区工作流

- **PMO 全局发现完整保留。** `app snapshot` 聚合原 PMO 跨对象观察：真实 Project 资源、Workspace、Topic／Mote／Space／Zone、配置 Executor、活动 Agent、Core Session、Goal、决策与活动事实；按各自来源保留已知、不可用和 unknown，不把不可用伪装成空列表。对象发现必须覆盖原 `list projects/active-agents/sessions` 与 PMO 全局观察的事实，不能只剩调用者的当前 Space／Workspace。配置 Executor 由 `settings executors` 发现，Agent 与 Session 由 `agent` 发现，空间与其资源绑定由 `space` 发现，各项 inspect 按对象提供；Project／Workspace 资源发现由原权威来源供给聚合及关联观察，不能从 Space 名称或单条 Workspace ID 伪造 Project。`goal activity` 只取原 Goal 活动来源，不把 Runtime 日志或跨域 snapshot 当成 Goal 已发生的活动。
- **分类、Topic 与资料沿原事实发现。** 全局 Category／Topic／Mote 及其资料的发现复用原目录／文件 owner，分类描述、正文与修订来源明确；Topic 对应原 Zone，主分类关系只取 Core 空间图，不把当前活动 Tab、目录路径或调用者 cwd 当归属。未分类与局部 unknown 分别表达，宿主或范围不可用时显式 unknown／不可用，不补一个全局 registry，不借当前项目、默认 Mote 或另一份 Session 列表补齐事实。部分来源失败保留其他已经观察到的结果与原工作面，不宣称全局资料已经完整。知识对象的公共接入见[《Topics 知识库的公共接入》](#topics-知识库的公共接入)。
- **PMO 从别处也能执行真实工作流。** 人或 PMO 位于其他 Workspace 时，经同一 RPC 业务编排完成下列流程；目标还没有 Tab 也能开始，不要求锚点：
  1. 显式指定真实 Project 资源与目标显示位置。Project 的资源身份、Host 与目录，和显示用的 Space／Zone 地址分别指定、校验和返回，不从 Space、调用者 cwd 或焦点猜资源。
  2. 选择已有 Zone，或创建 Git／目录 Zone。新 Zone 的资源输入须携带显式 Project 身份，规则见[《新 Zone 的资源来源》](#新-zone-的资源来源)；已有 Zone 使用本 Zone 的真实资源，不要求重选 Project。展示 Space 可以是 Folder、Mote 或知识库 Category，不限于资源目录 Space；具体 Topic 对应目标 Zone，层级只见[《Topics 知识库的层级与沉淀》](spaces-and-layout.md#topics-知识库的层级与沉淀)。
  3. 建立首张 Tab，打开指定 Executor 的 Agent 并交付首句任务，取得准确 AgentSession／Run 与空间地址，随后可以发送、观察和操作。

  回执分别给出 Project、资源来源 Workspace、Host／目录与展示地址，以及资源创建、Workspace 登记、展示放置、Core 创建与首句投递各自的真实事实。部分失败保留已建资源与健康 Agent；首句投递 confirmed 不抬升为 Agent 已接受、开始或完成任务。同一业务操作不能更换资源后再做一次。精确参数以当前 `amux agent open --help` 为准。
- **`mote playbook pmo` 只读。** 它是说明 PMO 方法、分工、目标与完成标准确认、发现资源、编排已有能力、回读事实及未知恢复方式的工作手册，引用实际公开 CLI 及其真实边界，不启动 Agent、不自动执行步骤、不投递任务、不改变角色注册；已存在的 SOUL／Wiki 与用户资料保持原样，不机械改写。能力尚未落地时明确说明，不把目标命令写成已经可用的操作承诺。

### 长期 Host 的公开运行能力

长期无 UI Host 借原 Core，通过 `runtime.*` 方法族提供有限、从原 SDK 类型派生的调用与观察：会话消费者的建立、调用、事件、对话／历史／Attachment／Replay 观察与释放，以及 owner 身份、网络与 profile 等只读入口。准确方法表以 [`AGENTMUX_HOSTED_RPC_METHODS`](../../../packages/core/src/hosted-client-contract.ts) 为准；下列约束适用于该方法族全部方法，消费身份一条适用于其中带 consumer 的方法。

- **不复制原 owner。** 不复制 Provider、Session Store、Run Runtime、方法白名单或 wire codec。缺少 Host 端口时明确不可用，不隐式创建另一个 Core。
- **只接受用户或设备 principal。** `runtime.*` 只接受传输 owner 实际认证或批准的用户或设备 principal。Agent capability 不能提升为用户输入权限；managed Agent 继续使用原 `agent.*` 语义与 A2A owner，调用 `runtime.*` 明确拒绝。Unix 私有用户 endpoint、共享 HTTP 用户授权与实际设备授权分别如实表达；共享 token 不冒充每设备身份，跨请求不以随机连接 ID 代替稳定身份。
- **消费身份与转发主体保真。** 消费身份绑定稳定 principal：同一 consumer 名在不同 principal 下是不同消费者，另一设备不能写入或释放它的观察。真实连接的取消信号与 GUI 转发的原 Agent caller 必须到达原业务 owner，不能由自由参数伪造；GUI 转发保留原业务 code 与 detail／details／candidates 字段，取消只收回相关消费者，不停止健康 Run。
- **数据按原样输送。** 原 SDK 参数、事件与 ordered bytes 保真：普通业务数据不被当成连接控制字段剥除，也不被协议 tag 重新解释；不同来源的事件不因同名而丢失。`agent.output` 的初始事实来自同一次原 Attachment，保留真实 `terminal` continuation、`resizeRevision` 与 Run 字节边界；未知不填零，不另读一次状态冒充同一快照。
- **认证拒绝与暂不可用分开。** HTTP 认证明确拒绝与认证流程未完成必须区分：设备观察容量不足或认证服务暂不可用保持繁忙／不可用事实，不冒充凭证失效、撤销原授权或要求重新配对；原凭证、durable 状态与健康工作保留，未知回执不自动重试。手机设备的鉴别与管理权限沿本页[《手机版 Relay 连接》](#手机版-relay-连接)。
- **Node 与浏览器共用同一传输。** Node 与浏览器共用无 Node-only 运行依赖的 frame／parser 与 HTTP fetch／SSE 入口，支持真实 cookie credentials，并公开复用同一纯 value codec 保留原 bytes 与 tuple。浏览器有限 SDK adapter、TLS 与设备授权沿各自 Client owner 接入同一公共传输，不另造 wire；未验收时不宣称可用。

- **设备管理沿原 Host Authority。** 接入、真实设备 principal、管理方法和撤销边界唯一沿[《手机版 Relay 连接》](#手机版-relay-连接)。传输来源和取消信号由实际 owner 提供，客户端参数不提升权限，未知副作用不自动重放。

**当前实现与验收边界。** 公共类型、CLI、传输和第一方消费链见[公共能力来源导航](../../specs/public-capabilities.md#cli-与服务的当前来源)。源码合同、构建、安装与实际运行分别核对；源码不代替各传输的权限与独立观察者释放、真实 Client 调用或私有普通进程重启恢复的行为证据。内部 Client DTO 仍由原业务 owner 持有。验收消费同一候选的公共 RPC、对象 CLI 与 Project／Space PMO 工作流，不以纯文档或 helper 通过交付；手机 Host 组合、Relay、有限浏览器 SDK 和设备管理的构建不代替真实设备验收。

### 基础 skill、模块发现与渐进加载

AgentMux 的基本 skill 是简短能力目录：说明身份与按需发现入口，列出当前版本实际提供的模块、用途／触发场景及准确读取入口。已知任务域直接加载对应模块，不强制经过总目录。模块目录必须覆盖实际提供的公共业务范围，名称和读取路径沿同一注册来源维护；不能保留只有目录项而无正文的空模块，也不能让总入口继续内联全部模块手册、完整通信合同和命令细节。

系统使用指南以 Core 包内 `guides/` 的 Markdown 为唯一正文来源，既能作为项目文档直接阅读，也由 `amux --skill`、模块 skill、相关叶子 help 和原注入消费者按各自用途读取同一内容。入口、模块、操作指南与共享片段按实际消费组织；只有确有多个消费者的内容才提取共享片段，一条规则不在文档与代码中各写一份。系统指南随 Core 提供，不依赖用户当前项目的 `AGENTS.md` 或另加项目规则。指南解释用法与行为边界；命令可用性、准确参数、能力名和协议目录等机器事实仍由原代码注册表、类型与 parser 持有，构建时沿原来源组装，不在 Markdown 手抄一套清单。

新增或调整指南须闭合实际发现入口与消费路径，文件存在或生成成功不代替真实读取。维护步骤与检查能力边界由 [Core 指南维护入口](../../../packages/core/guides/README.md#maintaining-system-guides)统一说明；本专题只定义行为约束。

构建将 Markdown 生成现有消费者可直接使用的内容，生成产物须标明来源且不手工修改。静态依赖沿实际消费者裁剪，读取 A2A 或 Goal 的浏览器入口不因无关模块指南增长而扩大。CLI 与 Core 的指南读取保持离线、只读和宿主无关，不在运行时查找项目目录、仓库源码或网络资源；发布后的 CLI 从任意 cwd 均可读取，浏览器共享模块不引入 Node 文件系统依赖。内容资源化沿现有版本发布，不据此新增独立资源包、热更新或另一套权限机制。

每个模块提供自己的只读 skill，按模块语义说明对象与唯一 owner、当前旅程所需职责、回执边界及进一步读取入口。基础 `amux --skill` 与目录声明的模块级读取入口，例如 `amux goal --skill`，沿实际注册来源生成。具体参数由同一版本叶子 `--help`/parser 持有；详细 Browser program、原生恢复、空间 opening playbook 等仅在相关任务入口披露，其他域引用准确入口，不内联整本相邻手册。总 help 与对象 help 提供下一层操作发现，叶子 help 保全参数、合法值和本次操作的权限、失败／未知及回执说明，不对每个叶子机械附完整共同指南。完整能力及必要说明仍须按链接到达，不以精简为由删除。模块读取与 help 一样不启动 Run、连接 Runtime、投递任务或注册角色；不存在、不可用和版本/Provider 范围如实说明。

Goal 模块同时面向管理者和执行者，沿[执行责任、停滞告警与 PMO 巡查](goals-and-demand.md#执行责任停滞告警与-pmo-巡查)说明接单绑定、进展/阻塞/交付回报、核查回收、状态流转、停滞处理和 PMO 巡查。默认 PMO 上岗手册引用同一模块合同及真实公共入口；其他模块按其业务边界提供完整指引，不为渐进加载新建第二套业务 owner、调度框架或任务账本。

注入 prompt 只携带本次准确身份、已知 Goal/岗位、必要责任和必读模块的发现入口；Agent 按任务直接加载相关模块，不知道能力归属时再读取基本目录。新 Agent、明确复用的 Goal 讨论、委派/巡查实际输入与原生接续均能找到本次角色所需模块，保持原授权、用户正文和应用署名上下文分离。默认上岗手册、注入说明及模块正文引用同一规则来源，避免三份副本漂移，不覆盖用户 SOUL/Wiki 或假称热更新现有 live 上下文。读取回执与实际采用分别表达，AgentMux 业务模块 skill 不冒充 Provider 自身 skill catalog 或模型内部采用证明。

精简以当前阶段所需的信息和实际读取总量为准，不把整份启动说明平移到下一次必读返回。后置详细规则前，须确认原模块完整承载且相应动作前有可发现的读取触发；当前岗位、准确来源、原授权、未知结果和恢复责任不能因移入模块而失去。平台只整理自己生成的重复说明与可读表示，不按默认 fixture 删除或改写用户 AGENTS／SOUL／BEHAVIOR／MEMORY／Wiki 原文；材料的版本、作用域、已加载、禁用、未知和省略状态分别保留。同包入口去重以原入口确实完整保留为条件，原材料未加载或正文变化时不能假定副本仍在。可读表示从原 typed 事实派生，不反向解析散文来重建身份、权限或控制事实。

指南源文件、构建产物、已安装 CLI 与运行中 Agent 的实际读取／采用分别表达。修改 Markdown 不证明生成产物已更新，构建通过不证明安装副本已更新，安装或指南读取成功也不证明既有 live 模型已采用；验证与交付说明须绑定实际消费的版本和范围。

发现与模块读取经过当前实际 CLI/公共能力闭合，GUI 与 Agent 操作使用同一业务事实。验收覆盖非空模块目录、每个目录项的可读取正文及边界、至少 Goal 与另一模块的真实按需消费、管理/执行角色实际收到的入口，以及从执行停滞到巡查回填的同一产品旅程；不能以帮助输出有字符串或只有文档拆分证明完成。

### 新 Zone 的资源来源

新 Zone 以 `--project`／typed `projectId` 显式选择资源，既有 Zone 不需要该项；Project 由原 Workspace 配置的 Host 与仓库根／目录同一性派生，不添加第二 registry。

新 Zone 可用 `--source-workspace` 明确选择该 Project 内的执行来源；未指定时仅接受唯一根目录来源或唯一已登记来源，多工作区且没有根目录时明确要求消歧，不从第一个工作区或当前 HEAD 猜分支起点。

### Endpoint、Host 路由与源身份

一个 `--endpoint` descriptor 只定位同一公共服务，不承担资源或空间身份。普通 CLI 的 `system endpoint` 只描述选中地址，返回 `connection: "not-attempted"`，不连接、不证明可达；真正 RPC 的同名方法返回 `connection: "responded"`，只确认该次服务响应。

CLI 的显式 `--source-host ID` 复用本机原 Unix 配置 owner 已保存的 SSH Host，和 `--endpoint` 互斥。配置只读一次，以准确 ID 取得完整连接目标和原绑定 Runtime；不注册、测试、安装或自动修复连接。私钥路径属于配置 owner 的机器，因此该选择只支持本机配置服务，不借远端配置中的路径读取本机密钥；本地 Host 和未绑定 Runtime 不猜目标，保留原默认与显式 endpoint 入口。传输使用原 SSH／Tailcat 转换与调用者凭据，Source 不承认原主体时明确拒绝，不能剥离 caller 或冒充 person。

同机仍不代表同 cwd：保存的 SSH identityFile 使用绝对路径或 OpenSSH 自有的 `~` home 引用时原样交传输；其他相对路径没有已确认的配置 owner 目录基准，只在此新 selector 表达路径来源未确认，保原配置与其他连接入口。不从 CLI cwd 猜测、不读密钥验证；Tailcat 原命名 key 语义不变。

同一调用固定保存目标与原 Runtime，再从该 Source 取得本次 owner instance；普通调用、前置读取及各类订阅都携带同一 fence。业务参数中的 Host／空间／资源仍属于 Source 命名空间，配置 alias 不替代它们。配置后来改变不重解析或改投；已取得的原回执继续交还原请求，未知结果保留原 operationId，不自动重发。help、skill、version 不连接服务；本地分析、静态输出和原 Unix stdio 桥不借此选择冒充远端执行。

该 selector 取得身份后，CLI 成功及错误信封保留本次 `source: {configuredHostId,runtimeId,ownerInstanceId}`，不放连接 descriptor 或凭据，不修改原业务 result。输出原 JSON-RPC 帧的 reader 先给一条独立 CLI Source 关联记录，再保原帧；特殊 reader 的 CLI 信封同样保关联。配置 alias 后来改变时，查旧操作须重新定位同一 Runtime，不能由当前 alias 的新 Runtime 代查；原 instance 只是这次捕获事实，跨重启可在同一 Runtime 取得 fresh instance 后查原操作，不把旧 instance 变成永久恢复门禁。取身份前的失败不补造 Source instance。

`local` 指接收业务调用的 Core 服务本机，直接连接远端时不指 CLI 所在机器。聚合发现与检查保留原 Session 的 `hostId`，另返回该服务内可复用的 `routeHostId`，用于后续按 Host 范围准确读取；配置 Host ID 不是 SSH 地址或跨 endpoint 的全局机器 ID。`agent context` 的 `hostId` 是本次路由，`sourceHostId` 与 descriptor 保留源服务身份。发现结果只在同一 endpoint 范围续用，未知或多 owner 不按首项猜测。

`agent context` 完整读取原 Store 已保留的 history metadata，包括创建来源、fork 祖先与分端工具执行绑定；公开解码复用原领域投影与 parser，严格拒绝未知字段、畸形结构及与本次已确认来源冲突的回包，不通过删除合法元数据绕过校验。创建时的 Run 与祖先身份仅表示原始来源，不能据此推断当前 Run／Session 或输入资格；Hook、能力秘密与生命周期控制不进入该只读投影。

Context 某个来源暂不可读不表示已经读完：保留该来源的原位置、本页其他来源已消费的进度和具名 `unavailable`，调用者可沿返回的 `nextCursor` 明确续读，不隐式重试或重开首窗。只有所有来源均已完成才返回 `nextCursor: null`；续读仍绑定原 Host／Session、路由及来源。

默认 Host 入口的 `agent ls` 消费其已连接 Client 的多 Host 聚合，不能因本地清单非空而遗漏远端。聚合连接不可用时仍返回可用的本地事实，并在 `errors` 明示聚合观察缺失；Client 已明确返回的业务拒绝不改为本地成功。准确 Session 的 `agent inspect` 与 `agent output` 优先读取本 Core 已知 owner；只有本地明确查无目标时，才沿既有 Client 聚合通路继续定位。来源认证与请求校验先于委托，歧义、存储未确认或读取中故障不冒充查无目标。输出委托保持原 opening response、ordered bytes、Gap 与 reader 取消，开始观察后不自动换源或重订阅；已知本地 Session 的读取不以 Client 可用为前提。

### 传输、业务回执与持续读取

HTTP 显式启用且与 Unix 同权；SSH 与 Tailcat stdio 只转发远端原 Unix 服务，不意味着 ctxmux 远程 Run 已实现。Unix／SSH 保持有界换行 framing，内容须为严格 JSON-RPC 2.0，不保留旧 schema5 信封、原自定义 wire 或兼容别名。

一条公开连接可承载多个关联请求：每个普通请求只有对应的一次响应；订阅先以一次响应回应原操作与缺口事实，再以独立 notification 传递后续事件。HTTP 由同一公开服务输送响应与事件，不为流式需要放宽普通帧的合法性。业务身份与取消语义见上文《请求关联与业务操作身份分开》。

## 统一全局搜索

全局搜索由无 UI 依赖的同一 Core 公共能力提供，公开为 `app.search`／`amux app search`，Focus 与其他 Client 消费同一查询语义、结果身份、续读与覆盖回执。Core 提供浏览器可复用的纯 metadata 查询与原事实构建合同，以及组合原只读来源的统一 reader；不能只共用类型或函数名，却由 GUI、CLI 各自匹配、拼接来源、调度历史及判定完整性。本节定义已确认目标，不代签当前源码、安装或验收。

- **两种模式，明确范围。** metadata 查询原对象身份及已确认的名称、活动、已加载摘录、状态、Provider、资源路径、项目／分支／Topic 等资料；普通文字不区分大小写，原 ID 按准确大小写连续匹配，支持完整、前缀和中间片段。完整 `amux://` 对象链接（种类与编码见[amux 协议的对象链接](../../specs/amux-protocol.md#对象链接)）只沿[原严格 parser 合同](#对象地址分享与方向)按原种类和完整身份匹配，无效链接不降为名称查询。history 查询已保留会话中输入、回复及可读 reasoning／工具调用与结果等区分大小写的连续原文字，复用原 `agent.history kind:text` reader、文字资源与 Provider 语义，保原记录；缺省 user-message 查询的输入历史含义不变。两模式共用 typed request／result、cursor 与 coverage 合同，模式和实际范围明确，不将 metadata、标题、预览或已读窗口冒成历史全文。全局指所声明的原对象与已保留会话来源，不承诺任意项目文件、未发现的外部会话、知识库全文或图片 OCR。
- **对象与关联保真。** 支持已保留的 AgentSession、Run、Provider 原生会话、Tab、Region、Workspace、Group、Project、Space、Zone、Topic 与 Capsule ID，以及上述对象链接。沿[概念词典](spaces-and-layout.md#统一概念与空间寻址)区分对象种类、执行身份、资源和展示位置；Workspace 不冒 Project。原 Session 身份不因查询、改名、位置变化或恢复观察缺口改变；Run 不以当前执行回填未记录的旧引用。跨 Host 的相同 SID、不同 Provider 的原生 ID、同名对象及同正文的不同记录不合并。原生句柄的已确认、已观察与此前保留阶段可辨，不将命中提升为当前绑定、恢复或输入资格。资源 Host 与 execution Host 分开，未知 execution Host 不从 Zone、显示 Workspace、cwd 或名称补猜。Session 的多个展示、Zone 的多 Space 绑定及准确展示位置全部保留；普通 Terminal 仍按原 Run／Region 和原上下文可查，不因名称或同字段 ID 获得 AgentSession 身份或命中 `amux://agent/`。没有位置只表达未确认，不冒对象已终局。
- **原 owner 供事实，Core 统一查询。** Session／Run 引用、空间图及全部绑定、Project／Workspace 资源、Topic 内容和原历史继续各由既有 owner 持有；统一能力通过原 typed 只读端口取得事实，不另建 registry、持久镜像、全文索引或历史 Store。Client 可提供沿准确原对象引用的已加载名字、recap、访问观察与呈现补充，明确其来源与范围，不将补充资料冒作权威 membership、活动或授权。无 Desktop 端口时仍可查询 Core 自身可用的原身份、空间及历史，缺少的 Host／Client 来源明确不可用或未确认，不能要求 UI 选中或挂载后才成立。精确来源、路由和续用范围沿[Endpoint、Host 路由与源身份](#endpointhost-路由与源身份)，不能以一个 endpoint 内的 Host ID 冒跨服务全局身份。
- **覆盖与成本有界。** 来源发现、原记录扫描、匹配返回和字节各有明确的有限批次；metadata 不隐式读取全部正文，history 不由输入变化、无关输出或时间窗口变化触发全来源后台扫描。回执分开说明已查范围、尚未查完及 continuation、来源目录尚未确认、不可用／不支持／未记录和已确认无匹配；来源发现不完整时，已知来源全部查完仍不冒全局完成。结果保准确 Host／Session、原 Source、记录种类与 ID、原生来源及可继续寻址的对象和位置，未知作者、时间和归属不补造；不能按名字、正文或最近位置去重。原资源只经准确 reader 查询与读取，不把预览当完整文字；redacted、未知资源种类或不能完整查询的来源如实表达覆盖缺口。
- **续读与取消属于本次读取。** cursor 绑定原查询模式、文字、范围、endpoint 内路由及准确来源／版本；换模式、换目标、失效、过期或源变化均明确拒绝该次续读并给原范围重查方式，不静默换源、跳页或从头重读后冒续读。原 reader 的预算回执可驱动对同一位置的准确只读重试，不截断完整原记录或伪造完成。取消信号从公共 API、RPC／CLI 与 Client 到达相关原 reader，取消或断线只释放这次消费，不停止健康 Run；Client 丢弃已过期查询的迟到结果，不覆盖后来的输入、焦点或工作面。
- **查找不授予控制。** 查询、复制与只读查看不创建、恢复、停止、发送、移动或自动选择对象。明确选择结果才沿原准确导航或阅读 owner，身份与关联未知不能猜第一候选；历史无原位置时仍可只读，不以命中恢复 Run。来源失败保已读结果、原 Session、草稿和健康能力。Core API、公共授权与严格回执、实际 CLI 及 Focus 同源消费须形成完整交付，不能以 GUI 已接通或 help 已生成代签其他入口。

Focus 的显式发起、即时筛选与原阅读窗只见[Focus 搜索交互](focus-context.md#搜索上下文对象身份与历史正文)，结果层级与紧凑覆盖只见[Focus 搜索呈现](../presentation/focus-context.md#搜索范围与结果)；两者不再持一套通用匹配规则或跨来源调度。精确参数、错误类型与命令发现由实际 Core 公共类型、严格 parser 和 CLI 注册唯一持有，具体实现来源沿[公共能力来源导航](../../specs/public-capabilities.md#cli-与服务的当前来源)。

## Topics 知识库的公共接入

Category／Topic／Chat／Thread 的对象、默认「未分类」、来源知识、整 Topic 转移及本地承接结果唯一见[《Topics 知识库的层级与沉淀》](spaces-and-layout.md#topics-知识库的层级与沉淀)；本节定义人与 Agent 共用的公共入口，不把业务正文复制为第二份知识库。

- **发现与操作使用同一准确对象。** CUI 提供分类发现、创建、查看与改名，以及 Topic 发现、创建、查看，按明确范围读取／搜索／写入／修订知识、转移 Topic 分类，以及层级承接的预演、应用与结果核对。GUI、IPC、CLI 和其他 Client 接到同一 typed 公共业务服务及原 Host 内容／Core 空间 owner。返回稳定内容 ID、Category Space／Topic Zone 与相关源引用，供后续精确输入；不从标题、cwd、活动 Tab 或默认 Mote 猜目标。全局发现继续保留，具体对象读取沿自身范围，Mote 不混入普通 Topic。
- **内容修订与空间提交各有原 revision。** 分类描述与知识正文保存沿原文件／内容修订，主归属转移沿 Core 的 exact-revision 空间提交；回执分别表达实际目标、应用事实、持久确认与局部未知。陈旧目标或 revision 明确拒绝该次动作，原内容与健康工作继续；部分读取保已确认结果，歧义保真实候选。创建／迁移的未知回执沿同一原对象与操作核读，不因失去回执盲建或重放。普通知识读写不隐式启动、发送、续跑 Agent，也不默认注入整库内容。
- **承接预演是实际数据的准确差异。** 公共预演说明受影响的旧空间节点、保留内容身份与原 Zone/Tab/Region、目标分类及原图 revision；应用沿同一 owner，返回备份、预演与实际保存事实。较新数据或原目标变化后重新核对，不以旧预演覆盖用户后来工作；未知结果保原引用与恢复入口。完整迁移的保全约束仍由知识库合同持有。

某个安装副本是否具备这些入口，以其实际 `amux topic --help` 为准；准确 method、参数、codec、命令与 help／skill 从[公共能力来源](../../specs/public-capabilities.md)及实际候选取得；当前 `space` 导航或 `file view` 不能代签完整 CUI，协议／help 存在也不代签真实 Host、GUI／CLI 消费、保存或迁移验收。

## Agent-first 的 Space 工作入口

人在别的 Workspace 时，可以指定一个项目，为它创建 worktree（或选用其他资源来源），在新 Zone 上开出第一张 Tab，拉起指定 Agent 并交付第一句任务。入口保持 Agent-first：命令与 GUI 同等重要，并且必须完全满足 PMO 视角。人和 PMO 使用同一套控制命令，PMO 无需切换当前工作面即可发现别处的 Space、Zone、Tab 与 Region，创建目标的首张 Tab，取得新 AgentSession 的精确 ID 并发送后续任务；不能要求目标已经有锚点 Tab。

创建与移动的入口是 `amux agent open` 与 `amux space mv`，空间目标使用[《统一概念与空间寻址》](spaces-and-layout.md#统一概念与空间寻址)的 **Space / Zone / Tab / Region**。`agent open` 能显式选择已有 Zone 或创建新 Zone，并在首张/新 Tab、已有空 Region 或明确分屏位置打开指定 Agent、交付首句。worktree 只是新 Zone 的一种资源来源，Topic/Mote 和非 Git 目录沿相同空间模型可用；Project 与 Workspace 作为真实绑定事实返回，不能冒充 Space/Zone 身份。精确子目标应能反推其上层，不强迫每次逐层填写四个 ID。新 Tab 的落点只由目标 Zone 表达，不从相邻 Tab 或当前焦点推断；不引入旧命令兼容层或焦点 fallback。

`space mv` 把已打开的 Agent 移到别处时，只改变它在 AgentMux 中的空间位置，不改变执行目录。`space mv` 绑定源 Region 及其预期 Session，使用同一目标层级；多投影时不得凭 Session 猜来源，目标占用时不得静默替换健康 Agent。落地结果须明确源投影移除、目标位置保留，同一 Session/Run/cwd/原生句柄与其他投影保留；不能复制、合并到第一块同 Session 投影或把关闭源 Region 当成停止 Agent。跨 Zone 目标如实显示原执行目录。源与目标的持久化恢复一致，未知提交不能报告已移动或盲目重移。

普通本机后台创建由原 Host 承担配置与上下文策略，沿 Core 的同一空间锁登记原操作与准确 Tab／Region／Session 关联，再交原 Core 创建 owner；不依赖 Desktop 是否在线。范围由原请求语义及原 Zone 的真实执行 Host 决定，既有远端、原生接续、资源创建或前台聚焦流程继续沿自己的准确 owner，不能按客户端品牌或观察失败切换。桌面和手机消费同一后台能力，不把手机当前支持范围变成桌面已有能力的限制。

创建回执不明时，读取原 `space.inspect` 操作只观察、核对及补齐已确认的空间投影，不启动 Agent 或重投首句。明确「继续原创建」保留同一输入、操作和 Session，交回原 Core 的幂等创建 owner；由原创建记录、在途 claim 与实际 Runtime 回执决定取回原结果或继续原准备。空间已登记但 Core 是否已准备仍未知，不能把 unknown 或错误文案当成尚未执行的证明，也不能另造 Session 绕过恢复。原位置已被明确移动、关闭或替换时保留现有布局，创建恢复不重新占据它。

动作回执分别表达资源/Git checkout、Workspace 登记、工作面放置、Core Session 创建与首句投递的真实事实。启动成功、PTY 接收字节、Core 既有协议投递确认和 Agent 接受/开始/完成任务不能相互代签。后续流程失败保留已创建资源、持久工作面与健康 Session；回执丢失或进程重启后能按精确身份查询已发生、未发生与未知的事实，未知不得触发重复创建或重投。恢复先保留原 durable Tab/Group/Region/布局/焦点及空间绑定，再尝试同 Session reattach/resume；Session 执行目录与展示 Zone 不同不能成为删除投影的理由，移除仍须 Core 的真实终局事实。流程握手、观察或布局失败不能停止健康 Run。

布局已应用、客户端偏好已写入、宿主 flush 已请求与磁盘耐久性已确认分别报告；耐久性只能由 Core 的[持久空间状态 owner](../../architecture/spatial-state.md)完成耐久写入后确认，不能因为 localStorage 写入或 await IPC 就声称已经落盘。未取得确认时如实报告 unconfirmed，保留原工作面、未保存改动与健康 Agent；客户端偏好、草稿或呈现快照不能替代、覆盖 Core 的空间状态。源移除与目标落点沿同一次 Core 空间提交保存；真实私有普通进程重启后读回同一空间绑定、布局与 Session 引用，才证明恢复验收。CLI 回执保持现有 JSON 输出，身份可原样用于后续命令。

精确语法、缺省规则与错误以当前 `amux agent open --help`、`amux space mv --help` 为准；技术文档或 proposal 状态不能冒充功能交付。

## 手机版 Relay 连接

本节持有手机等设备经 Relay 接入原 Host 的连接、设备身份、授权、撤销与重连，以及桌面退出后的 Host 可用性。手机客户端的导航、目录、对话与输入、附件、设备工作面保全和网页更新行为见[手机客户端](mobile-client.md)；手机界面的尺度、控件、文案、状态与动效见[手机客户端的呈现](../presentation/mobile-client.md)。

Mac 设置与手机连接 Toolkit 消费同一 Host 设备 owner 的连接事实和完整链接，不各自维护地址、offer 或设备状态。Toolkit 的结果传递与呈现失败须明确说明并保留原结果及恢复入口，不能静默停在没有二维码的扫码提示；机器结果与终端诊断的边界沿[Toolkit 合同](settings-and-observation.md#toolkit-与官方-performance-工具)。

手机在同一局域网扫描 Mac 设置页或右下角手机 Toolkit 的二维码，或打开其中复制的完整链接，即可继续同一已有 AgentSession 的对话、Prompt、交互请求和终端。正常接入不手输地址、配对码，不回 Mac 二次批准，不弹系统确认。Mac 自带手机网页与局域网 Relay，无公网服务或部署前置条件；公网部署、Linux 发行、新建工作区、商店发布和系统推送不在本连接范围内。

连接沿成熟 Relay V2 的稳定 Host ID、公钥 offer、端到端加密握手、多设备通道、心跳与自动重连。前台可见的手机工作面应能持续观察原连接，空闲不应人为造成周期性断连；实际断连时如实说明并接回原观察，保留原工作面、草稿、健康 Run 和未知操作，不凭载入成功或旧观察冒充当前连接健康。Relay 只转发密文，不持有业务语义、Agent Session 或 Runtime。

Host 身份与地址分离：监听通配网卡地址，读取连接链接时取得当前可用局域网地址；地址变化不换身份或删除设备记录。Mac 同时有多个局域网地址（例如网线与 Wi-Fi）时，链接默认用默认路由所在网卡的地址，连接结果同时列出全部候选地址及其网卡；用户可在设置中选择手机所在网络的地址，CLI 可用同一读取指定地址。指定的地址不是当前候选时明确拒绝，不改用另一个地址；候选只说明本机网卡，不证明手机可达。旧 IP 链接在原地址失效后需从 Mac 重新取得，局域网方案不承诺跨网络寻址。

手机 Toolkit 按[《Toolkit 展示时求值》](settings-and-observation.md#toolkit-展示时求值)取得原 device.ls/link 的当前设备事实和 offer URL；读取链接不创建邀请或变更授权。二维码、复制与完整原文查看使用同一次已确认结果中的同一个完整 URL，不改写地址、参数或公有 offer，保留完整 fragment；复制原结果不再次求值。连接链接采用紧凑格式：页面地址后的 fragment 一次编码版本、Mac 的完整公钥与准确 Host 身份，Relay 端点与页面地址相同时省略，让二维码点阵更稀、复制更短；公钥是手机核验对方与建立端到端加密的唯一依据，不能为缩短链接而截短、改用短码或助记词向 Mac 换取，也不因此新增配对确认步骤。格式只有一种，解析严格，旧格式不再接受；手机已保存的连接记录是解析后的身份，不受链接格式变化影响。历史链接保留结果时间和未重新核实的范围，明确刷新可取得当前地址。求值失败或回执未知不把更早链接充当本次成功，旧 action 的未知与恢复仍沿原普通执行合同；二维码呈现失败保留完整链接查看与复制。局域网网页与 WS 可用 HTTP，公网入口须 HTTPS/WSS；页面地址的可信来源仍是用户从原 Mac 取得的链接。

链接承载公有 offer，不携带长期私钥或一次连接码；打开后从页面地址清除并保留公有连接信息。Host 私钥持久保存在原 Store 旁的受保护文件，损坏时保留原件；设备持久加密密钥沿设备拥有的存储保留，浏览器使用同源 IndexedDB，不进入 URL、日志、普通 localStorage 或工作面导出。链接不是限时单设备邀请；完成加密握手的设备按真实公钥登记独立身份，撤销立即终止该公钥的请求与订阅。旧设备、操作记录、Host 身份和工作面数据保留；旧固定 IP/TLS manifest、邀请、claim、OS 批准和原生 Cookie 传输实现删除。

分层与远端身份沿[《联邦 Runtime 与远端恢复边界》](session-recovery.md#联邦-runtime-与远端恢复边界)，公共方法沿[《对象优先 CLI 与统一公共业务服务》](#对象优先-cli-与统一公共业务服务)，原工作面与健康 Run 沿[《Session Attach 与 Runtime Projection 的边界》](session-recovery.md#session-attach-与-runtime-projection-的边界)，终端字节、阅读与成本沿[《Terminal 连续向上阅读历史》](terminal-reading.md#terminal-连续向上阅读历史)。长期无 UI Host 使用原 Core/Hook/Store/Provider 与 ctxmux namespace，同时服务 Desktop 和 Mobile；加密连接接原公共 JSON-RPC dispatcher 与有限 Hosted SDK，不复制 Runtime。网络或手机入口故障只影响该入口，保留健康 Desktop、Unix、Agent 和 Run。

**桌面退出后，手机访问不打断。** 已连接的手机可以继续原工作，新打开的手机可以连接原 Host、发现并打开原工作面与会话。目录、原名称和对象关系、Agent 创建与恢复、对话和输入、文件与笔记、Topics、Mote、Goals 以及手机已有的配置读取，由原 Core 或 Host 领域 owner 提供；不能因为 Desktop 退出而隐藏入口、清空目录、另建替代 Session，或要求回桌面才能继续。Desktop 返回后消费同一持久空间图和领域事实，不能用退出前的快照覆盖手机期间的更新。屏幕呈现、窗口、真实输入焦点和 Native Browser 控制仍由 Desktop 提供；这些能力离线只影响对应操作，原手机工作面、草稿、未确认操作及健康 Agent 保留，并明确说明不可用的 owner 与恢复动作。

Host 的服务生命周期独立于展示客户端，并由执行环境的唯一服务管理者负责持续运行与退出后的恢复；持有 Core 的 Host 不在 Core 内监督自身，也不复制 ctxmux 的 Run Runtime。原 Host 恢复继续同一持久 namespace、设备授权和会话，具体身份与恢复边界沿[长期 Host 与客户端生命周期](session-recovery.md#长期-host-与客户端生命周期)。Relay 的部署位置与 Host 执行环境分开：Relay 继续只转发密文，不能取得业务语义、设备授权或 Session owner 身份。桌面退出后的可用性为独立 Relay 部署提供基础，不自动授权公网部署，也不承诺执行机器关机、注销或网络不可达时在线。

跨进程转发保留原认证主体及授权来源。Host 借 Desktop 的文件、窗口或其他能力时，接收方必须从可信传输边界取得准确主体，并在原业务 owner 需要授权的执行点复核；不能把设备请求改记为本机用户，也不能从业务参数接受调用者自报的身份、授权或回调。转发中的原 method、目标、参数、operation 和接收 owner 保持绑定，业务回执与原归因原样返回；凭据失效或授权未知只影响这次操作，不能退回更高权限的本机身份。

原始终端按键、粘贴与高阶输入都保留本次调用的可信授权有效期。原始字节输入在排队、异步准备后及实际字节派发前检查原授权、准确 Session／Run 和原 owner 有效期；设备撤销、已取消且尚未派发的原始字节调用或已结束的 owner 不能在后续重连时发送旧输入，也不能取消另一项健康输入的观察。本次远端操作所需的原授权无法核实则保留原意图并明确不可用，不冒撤销或准许执行；已由语义 owner 接受的持久输入仍沿其原等待与恢复合同。字节已经派发后，观察中断不撤销已发生业务、不将未知回执冒成未执行、不自动重放；原 operation、输入回执与已保存内容保持。授权检查不依赖展示文案，也不阻断无关本地输入或停止健康 Run。

公共设备方法只借原 Host Authority：`device.ls/revoke` 由本机用户读取状态及撤销设备，managed Agent 和远端设备不能调用；`device.link` 的本机用户入口和受管 Agent 只读边界见[手机连接链接的只读读取](#手机连接链接的只读读取)。`device.hello` 仅允许已认证 Relay 设备命名自己的身份，目标由真实加密握手 principal 确定，不能由 JSON 选择。GUI、SDK、CLI、方法发现和回执共用这些方法；原邀请、approve、reject、intent 方法删除。请求或订阅只能观察、释放自己的 Runtime consumer。

Toolkit 的设备列表只列原 Host 已确认连接中的设备，不铺离线设备；未确认或读取失败不伪装成离线或空结果，原展示及时间和旧请求 unknown 的独立服务窗保持。设置保留已登记设备与撤销能力，其设备记录只呈最近 connected/disconnected 及发生时间，不铺逐次业务操作日志；原授权、设备身份与已有操作记录保全。`device.ls` 每台设备只带最新一段操作记录；更早的记录由原 Host 设备 owner 在本机只追加地保存，不因展示窗口或写入次数删除。当前连接状态、最近连接事实与授权状态分别表达，失联不冒撤销。同一公钥的多个已认证通道只计一台；设备连接从零变为非零、最后一个通道释放时沿原 owner 记录连接／断开，重复释放不制造事件或影响其他通道。

设备辨认使用原稳定 deviceId、名称与已确认加密 peer 公钥的指纹，并保留同一实际接入连接观察到的 IP 与来源时间。指纹口径可核对；旧记录没有已确认密钥来源时保持未知，不能把历史 credential 摘要、名称或短 ID 当公钥指纹。IP 沿原 client socket 与准确连接身份取得，在完成加密身份确认后关联设备，不借 daemon 的 Relay loopback、转发 header 或业务参数补猜；浏览器声明只作辨认线索，不授予身份或权限。最近地址在断开后只作带时间的历史。记录保存或观察失败保留原事实、授权和健康连接，说明未确认步骤并提供原读取／恢复路径，不建立第二设备、授权或活动 Store。

对话用户输入与交互操作继续沿 Host 认证上下文与 Core 公共事实辨认来源设备，名称不代替身份；未知历史不按当前设备补猜，不把 Agent 回复归为发起设备。设置与 Toolkit 消费同一原设备和连接 owner；折叠及呈现规则只见[手机连接与设备活动](../presentation/settings-and-observation.md#手机连接与设备活动)。

网络中断、休眠与后台返回自动重连，原工作面、Session 引用、草稿、阅读位置与未确认操作保留。恢复沿原 SDK 重新核验原 Host 与 Session/Run、接回事件和字节 cursor；副作用不自动重放，只有 Core 终局事实允许移除 Session 引用。相同 Host ID 的地址变化允许更新地址；不同 Host 不得接收原会话输入。连接步骤失败就地显示当前未知/不可用事实与恢复动作，不将协议失败猜成 Agent 退出。

连接已由原 consumer 确认不可自动恢复时，如实说明自动重连已暂停，并保留核对原连接与授权后显式重检的入口；不继续声称正在重试，也不以 Native 观察故障代替手机到 Host 的语义连接状态。

### 手机连接链接的只读读取

本机用户可从原 Unix 入口读取链接。受管 Agent 可沿原 `device.link` 一次读取其已认证执行 Host 的手机网页入口、完整公有连接链接、已有 Relay 端点及当前连接状态。结构化地址来自同一次原链接观察，不重新推算另一份地址；原端点是域名或 IP 时原样保留，不以 DNS 猜测、外部探测或新公网部署补造地址。已知地址的读取不要求 Relay 此刻已连接，未就绪或断连状态单独表达；尚无地址时明确不可用，健康 Agent 及其他入口继续可用。读取链接不登记设备、不授予管理权限；设备列表、接入握手与撤销继续沿各自原主体和授权边界。聚合或远端调用不允许用另一个 Host 的 Agent 资格读取本机地址；SSH/stdio 仅转发带原 caller 的链接读取，由原服务核实身份，不把无 caller 的远端请求提升为本机用户。

## 对象地址、分享与方向

- **分享对象地址时，复制的是一个寻址方式。** 接收方（人或另一个 Agent）仅凭这份分享就能识别对象身份并执行准确命令，无须猜 ID 层级、flag 或回头问人。普通路径、URL、代码选区、终端输出与分支名的直接复制仍按其原任务生成内容，不包成身份名片；明确面向 Agent 的上下文分享按本节共用外框呈现。

- **不同种类的对象地址不互为别名。** 对象链接的种类与编码只见 [amux 协议的对象链接](../../specs/amux-protocol.md#对象链接)。Space、Zone 与 Capsule 链接分别指向持久空间、Zone 与持久页面；与发送和导航消歧直接相关的是下面三类：
  - **Agent（Session）** 回答“哪个 Agent”：Core 语义身份，跨 Tab 稳定，一个 Session 可同时投影到多个 Region 与多个 Tab；
  - **Region** 回答“哪一格内容”：Tab 内的准确内容 leaf；物理位置命令必须使用已知准确 Region 与原展示上下文，不从一个 SID 猜唯一位置；
  - **Tab** 回答“哪张完整工作面”：只有其中恰好一个不同的 Agent Session ID 时才可用于语义发送；同一 SID 的多个 Region 投影仍是一个 Agent。既有 View 用语不形成另一层身份，Session、Run 与 View 的身份边界见[Session、Run 与 View](session-recovery.md#sessionrun-与-view)。

- **对象分享直接复制 `amux://` 链接。** 对象类型与准确编码只见 [amux 协议的对象链接](../../specs/amux-protocol.md#对象链接)；每份只包含原对象类型与一个准确身份，不再复制身份名片、执行器资料或重复命令说明。Agent 链接始终指向 Core SID，不以原生会话 ID、显示名、执行器、Run 或空间位置替代。右键菜单按真实动作命名 Copy Agent/Region/Tab/Category/Topic Link，同一目标只保一个复制入口；复制本身不发送、不导航、不改变焦点、展示、草稿或健康 Run。
  - 新 ID 的等长 Base58 规则见[产品实体 ID 分配](spaces-and-layout.md#产品实体-id-分配)，Session 既有 ID／持久创建重试保全见[Session、Run 与 View](session-recovery.md#sessionrun-与-view)；链接仍准确引用原对象身份，不增加分享别名或另一种地址格式。
  - 生成与严格解析来自无 UI 依赖的同一 Core 公共出口，消费上述唯一格式合同；不附带正文、命令、父位置暗示或自动执行参数。格式有效不证明对象存在、健康、已呈现、跨设备可达或内容作者可信。非法 URI 只拒绝这次打开，保留工作面与其他健康能力，并明确原因和重取链接的恢复动作。
  - Desktop 的系统协议、正文、Terminal 与 Browser 对象链接入口共用同一 Main 打开编排，再沿原对象发现与导航 owner 执行；各入口不另写 URI 解析器、对象名册或位置选择规则。应用内已获准的对象打开直接汇入该编排，不经系统协议绕回本应用；入口可信性与授权仍由原来源核对，Browser 网页的询问与拒绝沿[应用链接边界](browser-workface.md#browser-工作面)，不能因内部路由跳过。
  - Agent 链接定位为唯一现有 Region 时，原 focus owner 在提交导航前按预期 SID 原子核对该格当前 Agent，导航回执保留该条件。位置已更换只拒绝这次导航，后续异步呈现或持久确认期间变化只报告未确认、保留用户后来工作面，不回滚或操作替换者。相同条件由已有 `space focus --region … --expect-session …` 可用，空间身份与 Agent 身份仍分开。
  - 接收 Agent 在既有启动引导中知道 `amux://` 是对象引用，遇到链接先查 `amux --skill`，再按类型和原 ID 使用已有公开 inspect、send 或 focus 能力。用法在原 skill 按需发现，不在每次分享附带一份命令；可执行名及入口一致性只见[对象优先 CLI 与统一公共业务服务](#对象优先-cli-与统一公共业务服务)。当前能力以实际构建的 `--help`／`--skill` 为准，没有相关工具或引导的外部 Agent 不被假定自动知道用法。
  - Core 持有 Session、耐久空间组成与全部 bindings，client 只消费原事实，不另建对象或位置名册。Agent 链接的语义收件人始终唯一；其多个展示不是多个 Agent，也不能据 SID 猜唯一 Region。打开时沿原空间发现与导航通路解析准确现有展示，多候选完整可辨并要求明确位置，无已知展示时说明本次位置未确认并提供原对象检查／打开／恢复入口，不把观察缺口冒成 Session 终局或创建替代 Agent。
  - Desktop/client 负责系统协议注册、外部冷／热启动接收、屏幕呈现与输入焦点。冷启动沿[原恢复合同](session-recovery.md#冷启动按需恢复p0-末位)先保全工作面并承接定位请求，不能因初始化未完成丢请求或猜目标不存在。热启动进入原对象的真实展示，导航与输入分别表达、默认保留输入；不更改 Session、健康 Run、执行 cwd、空间组成或草稿。未知、不可读、未找到与明确终局分别表达，失败保留原能力并提供具体原因与恢复入口。

- **Mote 对象和 thread 沿原身份打开。** Mote 地址的 ID 是原稳定 Space 身份，thread 另保该 Mote 内的原工作事件 ID；准确格式见[对象链接](../../specs/amux-protocol.md#对象链接)。原 `app focus --mote SPACE [--thread EVENT]` 与 Main 对象链接接收共用同一 typed focus 和 Mote 导航，不把当前成员当逻辑 Main，不猜 thread 执行者；原 Session、健康 Run、草稿、未知输入及原工作面保持。身份未确认只拒绝本次准确打开并保原引用，不创建替代对象或改投。

- **对象链接在对话中的富呈现不改变地址语义。** 行内 Agent 名片只消费同一原 SID，消息与复制仍保原 URI；识别、当前资料和只读边界唯一见[对话正文中的 Agent 对象引用](conversation-mode.md#对话正文中的-agent-对象引用)，打开动作仍沿本节原导航与身份条件。
- **已有的 Agent 上下文分享复用同一外框。** 编辑器的 Copy as Agent Context 和 Browser 的元素／批注上下文消费 [amux 协议的内容分享外框](../../specs/amux-protocol.md#内容分享外框)。它们是内容与来源分享，不冒称 Agent 身份，不强加 `ID`、`Exe` 或无关发送命令；外框只包原 owner 已产出的正文。
  - File 保留原工作区相对路径、起止行、语言围栏和所选代码；Browser 保留真实页面、元素／选区与批注来源、原顺序和原内容上限。格式器不读取文件或页面，不解析正文、不改原文或提升正文中的声明为身份、授权和可执行指引；范围、内容预算、复制失败反馈与重试继续由原 owner 执行，正文上限不能靠增加外框被绕过，最终外框须完整闭合。

- **歧义在源头消除，不甩给接收方。**一张 Tab 承载多个不同 SID 时，整张 Tab 不能唯一指定消息收件人。右键已知某个 Agent 的那一格时，Agent 链接直接给出其语义 SID；准确 Region 通过独立 Region 链接分享；不能让接收方先撞 `MESSAGE_TARGET_NOT_UNIQUE` 再挑候选。同一 SID 的多个投影不构成语义发送歧义；精确位置查询、导航和移动仍不能据此猜成唯一位置。

- **复制入口按其能消除的歧义就近放置。**Region 菜单的 Copy Region Link 指向准确 Region，Copy Agent Link 指向该格的 SID，不取当前焦点。Tab Link 用于检查整张工作面；只有唯一不同 SID 时才给 Agent Link，不取首格。同一 Session 从 Region、Tab、Roster、Focus、终端入口产出相同 Agent Link；准确位置通过独立空间链接分享。

- **Tab 发送消歧与精确回执同源。** 消息按不同 SID 聚合，一个 SID 的所有 Region 候选完整保留；同 SID 多投影只入队和提交一次。多个不同 SID 或零 Agent 时给出合法 typed candidates，不能让错误回执自身成为协议错误。已捕获的收件人、Run 条件与消息身份保持，后来位置变化不能改投替换者、自动重发或谎称当前呈现已确认。

- **复制入口清楚表达对象与动作。** Agent Link 分享语义身份，Region／Tab Link 分享准确空间对象；发送、检查与导航由 skill 可发现。不能把复制链接冒称已经发送消息或打开目标。

- **每一处能看见某个 Agent 的地方都能寻址到它，终端画布也算。**终端画布自己的右键菜单知道这一格的准确 Session，应与 Region／Tab／Roster／Focus 共用 Copy Agent Link 和同一 Core 格式化出口，同一 SID 的链接逐字一致；不另查执行器 metadata，也不从焦点或 SID 猜空间位置。准确 Region 由独立 Region Link 分享。
  - 只有这一格是 Agent 时才出现 Agent Link；普通终端没有 Agent 语义身份，不显示灰掉的虚假入口。
  - 原有终端 Copy 仍复制选区／可视区／回滚；Agent Link 复制语义对象身份，两者沿既有分隔线分组，不能让用户误以为链接是终端内容或已发送消息。

- **失败结果自带可执行的下一步，而不只是候选清单。** `MESSAGE_TARGET_NOT_UNIQUE` 已带 `candidates`，但只给候选仍要求接收方自己拼命令，违背“歧义在源头消除”。这类寻址失败额外返回可直接执行的恢复命令；stale View、目标不是 Agent、Agent 当前未被观察到各给自己的恢复入口。
  - **恢复命令来自同一 Core 命令格式化出口。** 客户端不为错误路径另写拼接，否则两份拼接会各自演进且漂移时没有测试变红。命令只使用公开对象 CLI 接受的寻址方式（例如 `agent send --to-session`、`agent inspect --session` 与 `space inspect` 的空间选择器）；其中的 id 按 shell 语义转义，带空格、引号或像 option 的 id 粘贴即可执行，且不改变原值。
  - **恢复文本挂在控制错误离开 client 的唯一出口，不挂在各抛出点。** 同一失败码往往有多个抛出点（例如 `TAB_NOT_OPEN` 与 `REGION_NOT_OPEN`），在每处各拼一份会随时间各自演进。哪些码算寻址失败由地址恢复模块唯一判定，出口层不另列一份码表；不属于寻址失败的码不附加恢复文本，避免一句泛泛的“再试一次”盖住原始原因。
  - **只用已通过校验的候选。** 未校验的 id 可能带换行或保留字，会把恢复文本切成无法执行甚至误导人的命令。
  - **每一行命令都必须能被实际 CLI parser 执行；给不出就不写命令。** 按对象、动词与必填项逐行校验：`agent inspect`／`space inspect` 带准确选择器，`agent send` 除选择器外还必须带 `--text`，列出实际 Session 用 `agent ls`。不同动词的必填项不同，不能共用一条形状判断，也不能只匹配一段看似正确的前缀。看起来像命令却跑不通的文字会把用户引向第二次失败。
  - **文案方向与失败的真实到达路径一致。** 判断依据是抛出点所在分支的条件，不是错误码的名字。例如 `AMBIGUOUS_TAB_TARGET` 只在 `self` 解析中出现，含义是“发起方自己同时显示在多处”，下一步是改用与位置无关的 Session 身份，而不是修改地址；方向错的下一步会让用户去改一个没有问题的地址。同一错误码有多条到达路径而文案只适用其中一条时，须确认其余路径在生产中不可达；一旦可达，应拆分错误码，而不是把文案写得含糊。当前判定见 [`addressingRecovery`](../../../apps/desktop/src/renderer/src/lib/agent-address.ts)。
  - **缺少准确目标时不给猜出的恢复命令。** 失败结果没有足够的 Tab／Region 身份时，提供原位置的重取地址动作；已有准确 Session 身份时，可提供能操作同一 Agent 的稳定 Session 旁路。Tab／Region 的持久身份仍沿[空间模型](spaces-and-layout.md#空间模型)，暂未取得地址不表示身份失效。
  - **列实际 Agent Session 与列已配置 Executor 是不同动作。** 前者用 `agent ls`，后者归 `settings executors ls`；unknown／unavailable 保持真实，列表不擅称全部仍活着。两者即使命令都能跑，也必须校验下一步与错误原因的语义对应。

- **方向词在创建时表示分栏，在查看时也能落到相邻 Tab。** 创建与方向查询（`space resolve`）各消费原公开能力，遵循以下共同方向语义。
  - **创建与查看的默认落点不同。** 创建一个方向只有一种解释：用户要多一格，即 split；新开 Tab 不叫“在右边”。查看一个方向时，屏幕上“右边”的东西可能是同一 View 里的另一格 Region，也可能在没有分栏时是 Tab 条上相邻的 Tab；查看端不能因为没有分栏就回答没有右边。
  - **先 Region 后 Tab。** 同一 View 内有分栏时，方向解析落在用户视线里紧挨着的 Region；该方向上没有兄弟 Region 时才退到 Tab 邻接。先 Tab 会让分了栏的 View 把用户指向另一张 Tab，与所见不符。
  - **上下方向对 Tab 不成立。** Tab 条是一维水平序列，此时如实回答该方向没有邻居，不把 up／down 折成 prev／next；否则 Agent 以为拿到了上方的对象，实际拿到的是左边那张。
  - **轴向解释只有一处定义。** split 是在 Region 树上劈开一个节点，查看是在已排好的版面上找邻居，两者是不同动作；但 left／right／up／down 的轴向（横向轴属 left／right，纵向轴属 up／down）来自同一处。方向查询写成纯函数，从既有版面几何（Region 的归一化 bounds）与 Tab 序列推导，不另建一份布局事实；否则漂移时只表现为 Agent 偶尔寻址到隔壁，且没有测试会变红。
  - **方向结果不形成新的身份或地址层级。** 解析结果仍是既有的 Region 或 Tab 地址，沿其原公开选择器，不新增 surface kind。

- 后台 Agent 由 Agents 工具重新发现和打开，不建立第二份 Session Registry。

- **Agent 能把 Terminal、Browser 或文件开到指定方向的分栏。** 入口是既有的 `open`／`arrange` CLI，不新建第二条通路，也不新增 surface kind。需要补的是发现：启动时注入的提示让每个 Agent 知道这项能力存在、去哪里查确切用法，但不把完整 CLI 语法抄进提示，以免与 skill 争夺唯一事实并在语法演进时过期。验收证明启动路径确实携带该提示，而不是断言 skill 文本含某个字符串——后者在改动前也会通过。

## Agent 自助创建与空间操作

- **自定义 Executor 与内置 Executor 走同一创建路径。** 自定义 Executor 要能开出 Agent，并带完整元信息。发现结果必须区分用户名称和稳定 Executor ID，并以当前配置为准；按名称指定时，唯一名称可解析到稳定 ID，重名须返回候选而不猜。未找到名称不能被描述为“这个 Provider 不支持自定义 Agent”，也不能擅自用默认 Executor 代替用户选中的配置。
- **新建 Agent 的执行工作区与展示目标可分别选择。** 明确选择的执行工作区须是已登记的资源 Workspace，由原 owner 解析准确 Host 与目录；展示仍沿原 Space/Zone/Tab/Region 定位，因此本地分屏可承载远端新会话。未另选执行工作区时沿原创建上下文；显式引用不存在、未知或歧义时拒绝本次创建并保原工作面，不猜目标或顺便登记资源。此独立选择只用于新会话，不覆盖已有 Session 或 fork/resume 的执行事实，也不与本次新建 Zone 资源并用；一项创建只有一个执行资源来源。请求与回执分别保留执行资源和实际展示位置，资源登记不替代 Runtime 或来源作者授权。
- **元信息足以发现、启动和核验同一个 Agent。**创建前可见 Executor ID、名称、Provider 与目标 Host 的探测状态；创建后可关联 Session、Run、Host、Workspace、View、Region 和能力。Session/Run/能力来自 Core，布局坐标来自布局 Owner；配置里的环境值与凭据不是发现元信息。未探测、探测失败与确认缺失必须可区分，不把“未探测”说成“不能启动”。
- **“在右边新开一个”不是“查找右边已有的”。**旁边已有 Agent 不满足新建请求，也不构成空间已满。Tab 条相邻只表达导航关系，不能被当作当前 View 中可见的分屏占用；空间判断取同一次 View 几何与内容快照，不按 Tab 标题、列表次序或树深度猜。
- **技能中的空间原则保持简短、通用。**先看当前视图，优先复用符合方向意图的空位；需要拆分时，选择能让新旧内容都清晰可用且扰动最小的区域；保留现有工作，完成后核对实际落点。由 Agent 根据可见空间决定具体拆哪格，不枚举窄/宽/左右的特例，不要求面积相等；用户明确给定的目标与方向优先。
- **成功以提交后的实际归属为准。**创建、拆分、移动与重排不能用过时计划的 Tab/Region 身份宣称成功；源、目标、树叶、内容索引和焦点必须一致。异步创建期间布局变化不得覆盖较新的布局；Agent 已经健康启动但展示目标失效时，保留其 Session 可发现性并明确说明当前落点或未展示状态，不因为布局流程失败停止它。
- **独立布局包必须是真正的唯一实现。**通用树结构、几何、方向、分割、移动和不变量属于可独立使用、无 React/Electron/Agent 依赖的布局包；Desktop 用它的公开 API 绑定内容、渲染与持久化。Workspace 的 Tab Group 树与 View 的 Region 树保持不同身份，复用同一套布局代数；不把 Session、Provider 或 Run 生命周期装进布局包，也不在 Desktop 保留第二份树实现。是否完成以独立包消费验证和产品调用为准。
