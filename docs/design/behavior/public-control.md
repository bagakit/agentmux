# 公共控制与跨客户端接入

本文集中本主题的交互与行为要求。已确认约束定义必须成立的结果，不代表当前实现通过验收；提案、历史与当轮授权状态按正文的明确范围阅读。

[返回交互合同](../agentmux-desktop-interaction.md) · [同主题视觉](../presentation/public-control.md)

**本页章节**

- [AgentMux 自操作与 Computer Use 边界](#agentmux-自操作与-computer-use-边界)
- [Agent 操作桌面主画面与保留对话输入](#agent-操作桌面主画面与保留对话输入)
- [Agent 通过 CLI 打开文件与控制原工作面](#agent-通过-cli-打开文件与控制原工作面)
- [自举：在 AgentMux 里开一个 Agent 优化 AgentMux](#自举在-agentmux-里开一个-agent-优化-agentmux)
- [Browser 通用能力协议与 CLI/Skill 接入](#browser-通用能力协议与-cliskill-接入)
- [对象优先 CLI 与统一公共业务服务](#对象优先-cli-与统一公共业务服务)
- [Topics 知识库的公共接入](#topics-知识库的公共接入)
- [Agent-first 的 Space 工作入口](#agent-first-的-space-工作入口)
- [手机版 Relay 连接](#手机版-relay-连接)

## AgentMux 自操作与 Computer Use 边界

- Agent 操作 AgentMux 自身时，必须使用 AgentMux 自有的 typed Control 协议与语义 CLI；Agent、空间、Goal 与应用操作按[对象命令](#对象优先-cli-与统一公共业务服务)接入同一公共业务服务，由各自原 owner 执行。不得通过截图、坐标点击、macOS Accessibility 或其他通用 Computer Use 旁路完成本产品已有的操作。
- AgentMux 的产品运行、Session/Run 生命周期、Board/PMO 管理和发布验收不得把外部 Computer Use 工具作为前置条件。外部工具不可用、权限过期或观察失败时，保留产品自身的真实状态并给出诊断，不得阻断健康 Agent。
- 内嵌 Browser 的网页操作继续使用已有 CDP/Browser Control；它是页面语义通道，不是 macOS 辅助功能，也不复制一套桌面自动化 Runtime。
- 用户确认：「agentmux 应该有自己的 computer use 方案」。AgentMux 应向 Agent 提供自己拥有的 Computer Use 能力入口与真实执行反馈，用于桌面观察和操作；这是一条独立需求，不能把开发者临时调用外部工具算成已经交付。
- AgentMux 的 Computer Use 与已有自操作 Control、Browser CDP 各有清晰职责：已有产品语义操作仍走其现有 owner；系统桌面能力的实际执行属于 Desktop／平台适配边界，不把 Electron、系统窗口或辅助功能实现带入无 UI 的 Core，也不复制 Agent／Run 生命周期。
- 桌面权限缺失、目标窗口消失或操作失败必须如实反馈，不能冒充成功；该能力不可用不能阻断健康 Agent 的输入、启动与恢复。外部桌面自动化工具仍可用于独立开发验收，但不是产品启动或发布的前置条件。

## Agent 操作桌面主画面与保留对话输入

用户希望「Agent CLI 能操作 AgentMux 桌面应用本身」，Agent 和用户交流时能切换界面；理想情况下，Mote 在浮窗里交流的同时，可以改变主画面当前聚焦的 Space 或某个 Goal，也方便 Agent 自行迭代、调试和观察。该能力沿同一公共业务服务的 `app focus`／`app inspect`、`space focus` 与 `goal focus` 接入，具体呈现与输入仍由原 Client owner 执行；不把系统桌面 Computer Use、Browser 操作或 Agent／Run 生命周期并成另一条 Runtime。

Work、Survey、Recall 与左下 Mote 面板的导航范围，以及明确跨上下文动作的一次带入语义，只见[Work、Survey、Recall 与 Mote 的导航上下文](spaces-and-layout.md#worksurveyrecall-与-mote-的导航上下文)。本节公共动作继续分别报告选择、呈现和输入，不因入口或共享实体合并各上下文的目标。

- **主画面与对话输入分别成立。** 选中主画面目标不等于真实 caret 已转移。默认导航保留仍在交流的 Mote 浮窗、同一对象／Tab／Region、原 View、真实 caret、草稿与组字，不关闭、重新创建、重选或自动发送其内容。只有调用者明确要求把输入交给精确目标时才尝试输入焦点转移；不能为证明主面导航成功先 blur 浮窗再恢复或挑一个编辑框。
  用户继续点击或输入浮窗，选择该原 Tab 内的精确 Region、原输入与逻辑 lane；浮窗自己的活动 Region、焦点标记与观察须跟随这次局部选择，主面保留的源焦点即使来自同一 Tab 也不能覆盖浮窗的局部选择。固定浮窗仍保留原有的输入与人工操作能力。不能因此清掉主面精确 Space／Zone 地址、改变无关 Workspace／Group 或保留的源焦点，或重新授权另一处 launcher 自动激活。人工在主面明确导航或新建 Tab 仍按原交互执行。
- **用真实身份导航。** Space／Zone／Tab／Region 只沿[《统一概念与空间寻址》](spaces-and-layout.md#统一概念与空间寻址)的真实来源，Goal 沿用原持久 ID。精确子目标可反推父层，父子不一致或多候选不能猜最近、第一张 Tab 或别人的 Agent。导航仅改变既有展示选择；不创建 worktree、Tab、AgentSession、任务或 PMO，不移动 Region，不改执行 cwd／Run／原生句柄，不停止健康 Session。
- **选择、呈现、输入三种事实分开。** 回执与只读观察分别说明主 Surface、所选 Space／Zone／Tab／Region 或 Goal、实际可见／借到浮窗／受遮挡／等待恢复的呈现位置，以及真实输入所在位置；执行与 PMO 逻辑 lane 不能冒充 DOM caret。Mote 的临时悬停、固定开合、精确目标与真实输入状态来自原 owner，不复制浮窗状态或内容实例；同一 View 借到浮窗时，不能用主面选中 ID 代签主面正文已经可见。
  主面选中的原 View 正在 Mote 浮窗中时，原位置须持续就地说明已选中的位置、视图当前所在及关闭浮窗后的返回方式；不能只留下空白、底栏红点或默认收起的通知列表。说明不关闭、重新选择或复制浮窗，不抢原输入。
  用户确认关闭所选投影后，当前子选择沿真实布局在同一 Space／Zone 内更新；没有同父落点时保留父地址与空子选择，不能跳到别的 Topic。Runtime 暂缺或快照为空不等于投影已关闭，原 durable 引用仍须保留。
  后台搬迁当前 Region 仍遵守原空间移动的源面与逻辑焦点保护；主面地址保留源 Space／Zone，失去的子投影不能冒充仍在源面，也不能借机选中邻居。
- **观察不改工作。** Agent 可只读取得准确主面与浮窗状态，输出能用于后续精确命令；不触发切换、聚焦、启动／停止、重投、refresh、展开或收起。观察仅含语义身份和呈现／输入状态，不读取草稿正文、终端输入、选区文字或剪贴板；缺事实明确 unknown，不能按配置或记忆填成已观察。
- **失败保留原能力。** 目标不存在、关联未知、渲染尚未确认、overlay 阻挡或输入不可达分别报告，已应用的展示选择与未确认的真实结果不能混同；服务窗说明失败步骤和现有可用状态，不遮住原工作面、不抢输入，也不因流程观察失败关闭健康 Agent。普通进程重启先恢复原 durable 选择、工作面、浮窗固定目标与 Session 引用，继续原恢复路径；瞬时 caret 不冒充持久化事实。

命令扩展、缺省建议、现有 source 缺口与实施验收见 [Agent 操作桌面主画面与保留对话输入](#agent-操作桌面主画面与保留对话输入)；桌面语义导航 CLI 合同（本机过程资料：`docs/plans/desktop-focus-navigation-cli-design.md`）。本项与 Agent 创建／空间移动、Mote 快捷面 hover 各有独立交付边界，复用各自已有 owner，不重做它们的生命周期。

## Agent 通过 CLI 打开文件与控制原工作面

用户要求继续补齐「文件／Editor 打开、Region 展示模式切换、Region 交换」，让 Agent 能用本产品既有 CLI 操作原工作面。文件资源、Agent 的 Session 展示偏好与 Region 的空间表现必须按原 owner 分清，不复制文件服务、catalog、布局或 Runtime。

- 文件按精确 Zone 的真实目录与字面目录相对路径打开，再沿原资源关系映射到既有 filesAPI 的 Workspace 相对路径；Topic 目录不能偷换成隐藏容器根。显示落点使用原 Space／Zone／display Workspace／group 身份，不能按 caller cwd、标题或当前主面猜位置。目录与原资源根映射未确认时如实未知，不改执行事实。文件入口打开或复用原 canonical File Tab／Region；零 Tab 的已有 Zone 可打开第一张 File Tab，不新建 Zone、Agent／Run，不替换 Launcher 或别人的内容。显式显示落点不能把资源根改成显示目录，也不能静默重归属已有 File Tab。
- 文件默认后台放置，显式导航也默认保留仍合资格的现有 Mote／Terminal／Editor 输入、草稿和组字；旧输入因显示变化失去资格须如实未确认，不能 focus／blur 后恢复来补签。资源创建、读取、实际格式、精确落点与导航是否仍获授权分别说明；异步读取完成前用户已经导航，不能抢回主面或把晚回执指向替换者。文件面已建立但读取失败仍保留原面与准确原因，不能从未获导航授权推断未打开。目录不作为 File 打开，书签源码不顺带开 Browser；媒体和二进制沿真实预览，不冒可编辑 Editor。
- Terminal／Activity 是 exact SID 的展示偏好，影响该 SID 的全部原投影；File 的 source／diff／preview 是 exact Region 的互斥模式，影响同一 Region 的全部呈现，不影响另一 Region 的同文件视图。合法 opaque ID 按原 own-entry 读取，不把继承属性当实际覆盖。暂缺 Core 快照不能阻断原 durable AgentRegion 的显示选择，不探测 readiness、不猜另一个 Session。CLI 改展示偏好不改主面选择、逻辑 lane、Session／Run 或 cwd，不隐式授权 caret 转移；输入资格变化如实未确认，原 GUI 明确操作保持其既有行为。
- File 模式由同一个原 Region owner 决定真正正文与菜单状态，不能同时保留 local preview 与 diff 让明确选择被遮盖。Markdown／SVG／Note 文本支持源码、diff 与预览，普通文本／HTML 源码不冒同 Region 的 HTML Browser 预览；媒体与已知二进制只读预览。支持范围来自实际格式与读取事实，未知如实未知；模式已应用与 preview／diff 数据可用分别说明。切换保同一原文档、未保存内容及每 Region view state，projection 模型沿原生命周期可释放／重建；仍合资格的原输入不被抢，失去资格如实未确认，不保存文件或阻断健康 Run。
- 交换只换同一 Tab entity 内两个 exact Region 在原分割树中的位置，比例、逻辑活动 ID、内容身份及其执行事实保持。同一实体的所有显示 occurrences 共用该布局，回执明确共同作用范围，不因多个位置误报实体歧义，也不宣称只改其中一次呈现。主面保留的源焦点与借出浮窗的局部选择仍按原 presentation 事实，不以复制 surface／内容身份或新建 Run 换位。DOM 与模型依原呈现生命周期，仍合资格输入不被抢；不以 Store ID 代签同 DOM／caret，未知如实未知。
- 只读模式查询与观察不触发读取、diff、持久写、refresh、Launcher 预热或生命周期。操作回执分别给出已应用、未确认和真实 save 事实；掉回执不能按未执行自动重放，尤其交换不能再执行一次。保存失败保已应用工作面与健康内容，持续服务窗说明哪步失败、当前状态和恢复动作；flush request 不能冒充磁盘 ACK。
- 普通进程重启先恢复原 File／Agent Region、Tab／group／布局与 Session 引用。Agent 展示偏好沿原持久 owner；File Region 模式沿原临时策略恢复到格式默认，不另建持久模式 Map。读取与握手失败保原面，不把缺快照当已关闭。现有内容的观测与消费成本只随相关实体／occurrences 增长，不读取全量终端输出或为无关会话增加工作。

## 自举：在 AgentMux 里开一个 Agent 优化 AgentMux

用户原话：「在 AgentMax 里面提供方便调试 AgentMax、并且能获取相关信息的基础设施，方便它自举」「我希望能在 AgentMax 里面开一个 Agent 去优化 AgentMax 本身。这就需要它有方法能够快速操作 AgentMax，而不是仅仅通过 Computer Use 去点击；而且在它操作之后，AgentMax 的一些相关元信息和截图也要能给它看，用来加速」「这个对代码架构的挑战可能会相对比较高，需要深思熟虑」。

自举沿产品公共能力完成三个环节：

- **快速操作**：Agent 通过[对象优先公共服务](#对象优先-cli-与统一公共业务服务)调用原业务 owner；CLI、Unix、HTTP 与 SSH stdio 共用 JSON-RPC 2.0 方法。具体命令、参数及可用能力来自实际注册与运行时发现。`control.ts` 的内部 typed Client port 不充当另一种公开 wire。
- **回看结果**：`app inspect` 观察真实展示选择、呈现和输入事实，`app snapshot` 聚合跨对象事实；各对象的 inspect 读取该对象。截图能力仍由 Desktop Main 持有，按下述目标和观察时刻合同扩展；暂不可用的观测如实报告。
- **共同入口**：自举操作与观察复用同一公开服务、caller 校验、业务错误和权威事实，沿 Core 与 Client 原 owner 分工。

三条硬边界，逐条都有它防的具体坏事：

- **观测归原对象的公共方法**。应用观察与对象 inspect 按[统一对象语言](#对象优先-cli-与统一公共业务服务)分域；截图与元信息扩展仍复用同一 caller 校验、错误事实及回执合同，保持原观察权限边界。
- **截图是 Desktop Main 的职责，且必须标注它拍到的是什么时刻**。原生窗口能力只有 Main 持有（见 Owner 边界表）。一张不带 `observedAt` 与目标 region 身份的截图，会让 Agent 拿一张操作前的旧图去判断操作成功了——**这比不给图更糟**，按[健康能力与未知状态](../../../AGENTS.md#健康能力与未知状态)，宁可如实说"这一刻抓不到"。
- **元信息只投影既有真相，不为自举新建注册表**。布局树、Session 投影、Region 绑定都已经有唯一 Owner；观测接口读它们，绝不另存一份"给 Agent 看的状态"——两份状态一定会分叉，而分叉时 Agent 会照着错的那份改代码。
- **自举 Agent 不享有特权**。它和任何 Agent 走同一套授权：能做什么由它启动时固定的 launch option 决定。一个"因为它在优化我们自己所以放开限制"的后门，是这个功能唯一真正危险的失败模式。



## Browser 通用能力协议与 CLI/Skill 接入

选型论证、现状缺口与竖切顺序见
[Browser 通用能力协议与 CLI/Skill 接入](#browser-通用能力协议与-cliskill-接入)；`browser-capability-protocol-and-cli-skill.md`（本机过程资料：`docs/reviews/browser-capability-protocol-and-cli-skill.md`）；
本节只记约束。

- **协议层是 Browser 能力的唯一事实入口。** 能力清单、权限、身份、requestId、operationId、
  事件与进度、取消、历史、回放和 indeterminate 结果都从这一层给出。任何客户端——CLI、编辑器
  自身、以及将来的 MCP/HTTP 适配器——都只能是这一层之上的平级客户端，不得绕过它直接驱动
  Browser，也不得为自己保留一份第二语义。编辑器现有的停止、历史与回放入口属于"与协议重叠"
  的那部分，必须收口到同一入口；与能力无关的视口、截图、DevTools 等本地控制不在此列。
- **协议刻意放宽的类型，收窄点只能有一个。** 协议不持有 Desktop 的步骤语义，也不该为了 Desktop 多
  一档状态就发一次版本，所以它把 phase 与 step 放宽。代价落在 Desktop：收窄必须只经一个门，两个门
  就是两份词表，加一档时漏改一处会让那一档在其中一条路上静默降级。认不出的状态只能落到"不确定"
  那一档，不得改写成一个眼熟的档位——那是拿一个我们没有的事实冒充。
- **CLI 只做适配，不做判断。** 它把命令与 stdin 转成协议请求、把回执按稳定信封打印出来。
  凡是"什么算合法请求"的判断都属于协议层：同一条规则不许在 CLI 与协议各写一遍，也不许只写在
  CLI 里——后者会让直连协议的客户端拿到一个 CLI 客户端拿不到的不确定结局。
  - Core 已区分的“另一条消息正在投递”与“Session Store 读取未确认”，经过公开 Control 与 CLI 后仍须保留对应错误类型；消息与原 Session/Run 保持，未确认不等于退休或进程故障。提示只给真实可执行的下一步，不指示重新创建、停止健康 Run 或盲重放未知投递。错误码由同一协议来源给出，不在 CLI 另抄清单；协议回执通过不替代 Desktop IPC 错误字段传输的实际证明。
- **Agent 面向的能力说明必须从协议与运行时能力生成。** 机械部分——能调哪些页面能力、签名、
  错误码——只能有一个来源，由它渲染出 Skill 文本。手抄一份再用扫描测试去对齐不算满足：
  那只对齐名字，不对齐签名与错误信息，且扫描自身会在锚点消失时静默恒真。散文式的意图说明
  仍由人维护，但不得与机械清单争夺真相。
- **页面能力清单作为数据跨层流动，不作为操作进协议。** 协议表面保持 `browser` 命名空间下
  那几个操作；`snapshot` / `click` / `js` / `cdp` 这类页面能力属于库层词汇，提升成协议操作会
  让每次增删能力都变成一次协议版本变更。观察—行动—验证闭环写在脚本里，`js` / `cdp` 两个
  逃生口是必须项。
- **operation 的寿命长于任何一条连接。** 一次操作从可被引用的那一刻起就有稳定 identity，
  并且要在操作还在跑的时候就能被别的连接查询、订阅进度和取消。CLI 断开、daemon 重启或
  客户端换一条连接都不得让操作事实消失或变成"没有这回事"；已经无法继续的操作按既有 durable
  历史表达为中断或不确定，不伪装成正在执行。operation identity 只能有一个铸造点。
- **取消是对 operation 的取消，不是对请求的取消。** 判据是"那次操作是否停下了"，
  而不是"我这条请求是否被放弃"。对一个已经结束的操作取消是幂等成功并答出它的终局，不是失败。
- **人工接管优先，且拒绝必须是机器可判的。** 人在控制中时，Agent 的驱动请求被拒绝，
  恢复只能由人明确发起；Agent 不得靠重试静默夺回页面。这条拒绝要带类型化的原因，
  让协议客户端能把"人在用这一页"与"出故障了"分开，而不是收到一句散文。
- **协议自身的流程失败不得拿走 Browser 已有的能力。** 订阅建立不成、进度流中断、查不到某条
  operation、版本协商不一致——这些都属于我们的流程状态：操作照跑、页面照用，同时用服务窗说清
  哪一步没走通、现在按什么状态在跑、要恢复完整能力该做什么。只有能力本身真的不可用
  （页面没了、进程死了、注入清单读不出来）才允许阻断。进度有缺口时明说缺口，不静默丢事件。
- **普通响应与进度订阅各守其合同。** 公开 JSON-RPC 连接可承载多个关联请求；每个普通请求只有对应响应，
  订阅先回应其原操作与缺口事实，再以独立 notification 传递后续进度。Unix／SSH 采用严格 newline framing，
  HTTP 由同一公开服务输送响应与事件，不能用流式需要放宽普通帧的合法性。事件游标只在**一个
  进程的生命周期内**有意义——事件落盘时不带号，重启后拿旧游标接着要没有意义，客户端要么从头要、
  要么接受一个明说的缺口。
- **外部客户端要够得着这条协议。** 端点位置与协议版本必须可以从产品自身问出来，
  而不是要求对方复算内部派生规则。这条服务的是"另一个语言写的客户端能接进来"，
  不是某个具体客户端。
- **全链站点/厂商无关。** 协议、CLI、生成出的能力说明与公共测试都只依赖通用事实
  （页面能力名、通用逃生口、URL scheme、导航事件、人工输入）。不得在实现分支、公共测试或
  验收条件里预设具体站点、按钮文案或厂商协议；真实站点只作黑盒验证输入。

## 对象优先 CLI 与统一公共业务服务

用户确认对象优先的统一 CLI，保留 `agent open` 和 `space mv`。PMO 仍是协调工作方法／角色，不把原 PMO 查询改名为 Mote 查询；跨对象观察归 `app snapshot`，各对象的 inspect 归其对象，原 PMO activity 来自 Goal 的活动事实，归 `goal activity`。本节定义新的统一目标；旧顶层动词与原公开 Demand 词汇在对应能力落地时直接替换，不留兼容别名。已有能力的当前来源不等于本目标已经实现。

- **公共业务协议先于 CLI。** 所有产品业务先由一套公开、类型化的 JSON-RPC 服务合同定义；CLI、HTTP 与 SSH 共用同一方法、授权、业务结果和错误事实。传输只承担请求／响应与流的输送，CLI 只解析参数、调用服务并呈现回执，不直接读写本机 Store 决定 Session、角色、Goal、消息或空间业务。公共方法不能要求调用者是 Electron／React 客户端，也不能要求当前 UI 焦点或本地目录才能解释精确目标。
- **权威职责与空间来源。** Core 保持无 Electron／React 依赖，持有 Provider、AgentSession、权限、Hook、readiness、语义恢复，以及前端独立的持久空间身份、拓扑、布局、选择与全部绑定；空间与执行身份的含义见[《统一概念与空间寻址》](spaces-and-layout.md#统一概念与空间寻址)。ctxmux 独占 Run、PTY、ordered bytes、Replay、Gap 与 Attachment。Client 消费 Core 空间事实，负责屏幕呈现与真实输入焦点；配置、编辑、文件／Topic 目录、Git 与 Browser 资源能力仍由原 Host／Client owner 提供，经同一公共服务接入。不新增一套 Runtime、Topic／Project／Space／Session registry、持久空间镜像或 CLI 专用业务判断。
- **请求关联与业务操作身份分开。** JSON-RPC 关联 ID 只匹配请求与响应，不冒充 AgentSession／Run、持久创建身份或 Browser／Toolkit 等 operation ID。现有 operation 级查询、停止与输出流是业务能力，可由 JSON-RPC 方法调用，不因采用 RPC 而取消或混为 transport cancellation。丢回执时按原 owner 的精确业务身份对账；未知不当从未发生，不重复启动、移动或重投首句。健康 Agent 保留、重启恢复和流程降级继续沿原合同，不以 wire／握手失败关闭健康 Run。
- **同一公开表达。** 下列对象命令树约束实际 CLI、help、技能输出、运行时指引、复制名片与 RPC 方法语义；不能只换 help 或把原本跨域能力藏到另一个别名。对象发现的结果须可原样用于精确输入，AgentSession、执行资源与展示位置分开返回；公开 Goal 词汇替换 Demand，沿用同一个原持久身份、已保存内容及关联，不造新 Goal、不改 ID 或用户数据。

统一命令树目标如下；表中每个动作仍须服从其原业务 owner 的权限、只读／副作用和恢复边界，是用户已授权实施的公开目标，不是当前已验收能力清单。

| 对象入口 | 统一动作 |
| --- | --- |
| `whoami` | 自身身份、空间位置与实际可用能力 |
| `agent` | `ls`、`inspect`、`open`、`rename`、`view`、`output`、`send`、`discuss`、`handoff`、`interrupt`、`resume`、`stop`；`role ls/register/resolve` |
| `space` | `ls`、`inspect`、`rename`、`mv`、`swap`、`bind`、`unbind`、`focus`、`promote`、`arrange` |
| `file` | `open`、`view` |
| `terminal` | `open` |
| `browser` | `open`、`run`、`history`、`inspect`、`stop`、`follow`、`replay` |
| `goal` | `ls`、`inspect`、`create`、`update`、`delete`、`assign`、`start`、`handoff`、`focus`、`link-session`、`link-project`、`decisions`、`activity` |
| `message` | `inbox check/ack`；`dispatch open/report/inspect` |
| `app` | `inspect`、`snapshot`、`focus` |
| `mote` | `playbook pmo` |
| `settings` | `inspect`、`set`；`executors ls/inspect/create/update/delete/refresh`；`prompts ls/inspect/create/update/delete`；`hosts ls/test`；`workspaces register`；`browser-links ls/forget` |
| `system` | `doctor`、`endpoint`；`crash-log inspect/reveal`；`metrics get/watch` |
| `device` | `ls`、`invite`、`approve`、`reject`、`revoke`；仅本机管理请求，变更必须有原设备 Authority 验证的实际用户确认 |
| `toolkit` | `ls`、`inspect`、`create`、`update`、`delete`、`action`、`script`、`run`、`stop`、`watch` |

- **PMO 全局发现完整保留。** `app snapshot` 聚合原 PMO 跨对象观察：真实 Project 资源、Workspace、Topic／Mote／Space／Zone、配置 Executor、活动 Agent、Core Session、Goal、决策与活动事实；按各自来源保留已知、不可用和 unknown，不把不可用伪装成空列表。对象发现必须覆盖原 `list projects/active-agents/sessions` 与 PMO 全局观察的事实，不能只剩调用者的当前 Space／Workspace。配置 Executor 由 `settings executors` 发现，Agent 与 Session 由 `agent` 发现，空间与其资源绑定由 `space` 发现，各项 inspect 按对象提供；Project／Workspace 资源发现由原权威来源供给聚合及关联观察，不能从 Space 名称或单条 Workspace ID 伪造 Project。`goal activity` 只取原 Goal 活动来源，不把 Runtime 日志或跨域 snapshot 当成 Goal 已发生的活动。
- **分类、Topic 与资料沿原事实发现。** 全局 Category／Topic／Mote 及其资料的发现复用原目录／文件 owner，分类描述、正文与修订来源明确；Topic 对应原 Zone，主分类关系只取 Core 空间图，不把当前活动 Tab、目录路径或调用者 cwd 当归属。未分类与局部 unknown 分别表达，宿主或范围不可用时显式 unknown／不可用，不补一个全局 registry，不借当前项目、默认 Mote 或另一份 Session 列表补齐事实。部分来源失败保留其他已经观察到的结果与原工作面，不宣称全局资料已经完整。知识对象的公共接入见[《Topics 知识库的公共接入》](#topics-知识库的公共接入)。
- **PMO 从别处也能执行真实工作流。** 人或 PMO 位于其他 Workspace，显式指定真实项目资源及目标 Space 位置，通过同一 RPC 业务编排选择或创建 Git／目录 Zone、建立首张 Tab、打开指定 Executor 的 Agent 并交付首任务，取得精确 AgentSession／Run 与空间地址，随后可发送、观察和操作。Project 的资源身份／Host／目录与显示 Space／Zone 地址分别指定、校验和返回，不能从 Space、调用者 cwd 或焦点猜资源；目标没有现成 Tab 仍可开始，不要求锚点。资源创建、Workspace 登记、展示放置、Core 创建与首句投递分别保留真实事实；部分失败保留已建资源与健康 Agent，投递 confirmed 不抬升为 Agent 接受／开始／完成任务。新 Zone 的资源 input 须携带显式 Project 身份，沿原配置的 Host 与仓库／目录事实解析；展示 Space 可为 Folder、Mote 或知识库 Category，不限为资源目录 Space；具体 Topic 对应目标 Zone，层级只见[《Topics 知识库的层级与沉淀》](spaces-and-layout.md#topics-知识库的层级与沉淀)。已有 Zone 使用本 Zone 的真实资源，不要求重选 Project。回执分别给出 Project、资源来源 Workspace、Host／目录与展示地址；同一业务操作不能更换资源后复做。具体 carrier 沿下述已评审派生合同，不把尚未实施语法当成已可用。
- **`mote playbook pmo` 只读。** 它是说明 PMO 方法、分工、目标与完成标准确认、发现资源、编排已有能力、回读事实及未知恢复方式的工作手册，引用实际公开 CLI 及其真实边界，不启动 Agent、不自动执行步骤、不投递任务、不改变角色注册；已存在的 SOUL／Wiki 与用户资料保持原样，不机械改写。能力尚未落地时明确说明，不把目标命令写成已经可用的操作承诺。
- **展示导航沿原合同。** `app focus` 表达主 Surface 的选择，`space focus` 与 `goal focus` 表达精确对象导航；选择、真实呈现和输入 caret 仍分开报告，默认保原 Mote 对话输入、草稿和组字，不改执行 cwd、不关闭健康 Session。原展示 owner 及对象间职责唯一见[《Agent 操作桌面主画面与保留对话输入》](#agent-操作桌面主画面与保留对话输入)，不因命令归域再造 router 或 caret owner。

- **Host 的公开运行能力沿同一公共服务。** 长期无 UI Host 借原 Core，以 `runtime.bootstrap`、`runtime.invoke`、`runtime.events`、`runtime.history-watch`、`runtime.release-consumer` 提供有限、从原 SDK 类型派生的调用与观察；不复制 Provider、Session Store、Run Runtime、方法白名单或 wire codec。缺少 Host 端口时明确不可用，不隐式创建另一个 Core。五个 SDK 方法只接受传输 owner 实际认证／批准的用户或设备 principal；Agent capability 不能提升为用户输入权限，managed Agent 继续原 `agent.*` 语义与 A2A owner，调用 `runtime.*` 明确拒绝。真实连接的 signal 与 GUI 转发原 Agent caller 必须到达原业务 owner，不能由自由参数伪造；消费身份绑定稳定 principal，另一设备不能写入或释放它的观察。Unix 私有用户 endpoint、共享 HTTP 用户授权与实际设备授权分别如实表达，共享 token 不冒每设备身份，跨请求不以随机连接 ID 代稳定身份。原 SDK 参数、事件与 ordered bytes 保真，普通业务数据不能被当成连接控制字段剥除或协议 tag 重新解释，不同来源的事件不能因同名而丢失。GUI 转发保原业务 code 与 detail／details／candidates 字段，取消只收相关消费者，不停止健康 Run。 HTTP 认证明确拒绝与认证流程未完成必须区分：设备观察容量不足或认证服务暂不可用保持繁忙／不可用事实，不能冒凭证失效、撤销原授权或要求重新配对；原凭证、durable 状态与健康工作保留，未知回执不自动重试。`agent.output` 的初始事实必须来自同一次原 Attachment，保留真实 `terminal` continuation、`resizeRevision` 与 Run 字节边界；未知不能填零，不能另读一次状态冒同一快照。手机设备鉴别与管理权限沿本页《手机版 Relay 连接》。Node 与浏览器共用无 Node-only 运行依赖的 frame/parser 与 HTTP fetch/SSE 入口，支持真实 cookie credentials，并公开复用同一纯 value codec 保留原 bytes 与 tuple；浏览器有限 SDK adapter、TLS 与设备授权沿各自 Client owner，接入同一公共传输，不能另造 wire，未验收时不宣称可用。

- **设备管理沿原 Host Authority。** 接入、真实设备 principal、管理方法和撤销边界唯一沿[《手机版 Relay 连接》](#手机版-relay-连接)。传输来源和取消信号由实际 owner 提供，客户端参数不提升权限，未知副作用不自动重放。

**当前实现与未实现范围。** 公共类型、CLI、传输和第一方消费链见[公共能力来源导航](../../specs/public-capabilities.md#cli-与服务的当前来源)。源码合同、构建、安装与实际运行分别核对；Source 不代替三传输的权限与独立观察者释放、真实 Client 调用或私有普通进程重启恢复的行为证据。内部 Client DTO 仍由原业务 owner 持有。五个 `runtime.*` 的有限端口、原 Host SDK 派生类型、真实上下文与权限隔离，以及 Node／浏览器共用的纯 HTTP/SSE 入口沿上文 Host 公开能力合同；手机 Host 组合、Relay、有限浏览器 SDK 和设备管理沿下述范围。构建不代替真实设备验收。

**已评审的派生合同与实施边界。**

### 新 Zone 的资源来源

新 Zone 以 `--project`／typed `projectId` 显式选择资源，既有 Zone 不需要该项；Project 由原 Workspace 配置的 Host 与仓库根／目录同一性派生，不添加第二 registry。

新 Zone 可用 `--source-workspace` 明确选择该 Project 内的执行来源；未指定时仅接受唯一根目录来源或唯一已登记来源，多工作区且没有根目录时明确要求消歧，不从第一个工作区或当前 HEAD 猜分支起点。

### Endpoint、Host 路由与源身份

一个 `--endpoint` descriptor 只定位同一公共服务，不承担资源或空间身份。普通 CLI 的 `system endpoint` 只描述选中地址，返回 `connection: "not-attempted"`，不连接、不证明可达；真正 RPC 的同名方法返回 `connection: "responded"`，只确认该次服务响应。

`local` 指接收业务调用的 Core 服务本机，直接连接远端时不指 CLI 所在机器。聚合发现与检查保留原 Session 的 `hostId`，另返回该服务内可复用的 `routeHostId`，用于后续按 Host 范围准确读取；配置 Host ID 不是 SSH 地址或跨 endpoint 的全局机器 ID。`agent context` 的 `hostId` 是本次路由，`sourceHostId` 与 descriptor 保留源服务身份。发现结果只在同一 endpoint 范围续用，未知或多 owner 不按首项猜测。

### 传输、业务回执与持续读取

HTTP 显式启用且同权，SSH stdio 只转发远端原 Unix 服务，不意味着 ctxmux 远程 Run 已实现。Unix／SSH 保持有界换行 framing，内容须为严格 JSON-RPC 2.0，不保旧 schema5 信封、原自定义 wire 或兼容别名。

`--operation-id` 是沿原 owner 对账的业务操作身份，JSON-RPC `id` 只关联一次 wire 请求。订阅只有一次响应，先响应再通知；取消／断线只释放相应 reader，不停健康 Agent 或原业务 operation。

### 对象命名与完整交付

完整命令树、原业务保留和第一方指引须一起落地，Toolkit 原 add／remove 能力改为 create／delete，update／action 保留；具体过滤与载体实现仍受上述真实来源和 typed 合同约束。

少量独立端到端切片可并行推进，最终验收消费同一候选的公共 RPC、完整对象 CLI 与 Project／Space PMO 工作流，不以纯文档或 helper 通过交付。

## Topics 知识库的公共接入

Category／Topic／Chat／Thread 的对象、默认「未分类」、来源知识、整 Topic 转移及本地承接结果唯一见[《Topics 知识库的层级与沉淀》](spaces-and-layout.md#topics-知识库的层级与沉淀)；本节定义人与 Agent 共用的公共入口，不把业务正文复制为第二份知识库。

- **发现与操作使用同一准确对象。** CUI 提供分类发现、创建、查看与改名，以及 Topic 发现、创建、查看，按明确范围读取／搜索／写入／修订知识、转移 Topic 分类，以及层级承接的预演、应用与结果核对。GUI、IPC、CLI 和其他 Client 接到同一 typed 公共业务服务及原 Host 内容／Core 空间 owner。返回稳定内容 ID、Category Space／Topic Zone 与相关源引用，供后续精确输入；不从标题、cwd、活动 Tab 或默认 Mote 猜目标。全局发现继续保留，具体对象读取沿自身范围，Mote 不混入普通 Topic。
- **内容修订与空间提交各有原 revision。** 分类描述与知识正文保存沿原文件／内容修订，主归属转移沿 Core 的 exact-revision 空间提交；回执分别表达实际目标、应用事实、持久确认与局部未知。陈旧目标或 revision 明确拒绝该次动作，原内容与健康工作继续；部分读取保已确认结果，歧义保真实候选。创建／迁移的未知回执沿同一原对象与操作核读，不因失去回执盲建或重放。普通知识读写不隐式启动、发送、续跑 Agent，也不默认注入整库内容。
- **承接预演是实际数据的准确差异。** 公共预演说明受影响的旧空间节点、保留内容身份与原 Zone/Tab/Region、目标分类及原图 revision；应用沿同一 owner，返回备份、预演与实际保存事实。较新数据或原目标变化后重新核对，不以旧预演覆盖用户后来工作；未知结果保原引用与恢复入口。完整迁移的保全约束仍由知识库合同持有。

以上是正在实现的新 Topics 公共能力合同，不声称当前已安装 CLI 已具备完整知识库、分类转移或迁移接口。准确 method、参数、codec、命令与 help／skill 从[公共能力来源](../../specs/public-capabilities.md)及实际候选取得；当前 `space` 导航或 `file view` 不能代签完整 CUI，协议／help 存在也不代签真实 Host、GUI／CLI 消费、保存或迁移验收。

## Agent-first 的 Space 工作入口

用户要的流程是：「人在别的 Workspace，指定一个项目，给它创建 worktree，在这个 worktree 上开出第一张 tab，拉起指定 Agent，并把第一句任务交给它执行。」随后明确「还是要 agent first，所以命令是同等重要，但是必须完全满足 pmo 视角」。人和 PMO 使用同一套控制命令，PMO 无需切换当前工作面即可发现别处的 Space、Zone、Tab 与 Region，创建目标的首张 Tab，取得新 AgentSession 的精确 ID 并发送后续任务；不能要求目标已经有锚点 Tab。

最新主干是 `agentmux agent open ...` 与 `agentmux space mv ...`，空间目标使用[《统一概念与空间寻址》](spaces-and-layout.md#统一概念与空间寻址)的 **Space / Zone / Tab / Region**。`agent open` 能显式选择已有 Zone 或创建新 Zone，并在首张/新 Tab、已有空 Region 或明确分屏位置打开指定 Agent、交付首句。worktree 只是新 Zone 的一种资源来源，Topic/Mote 和非 Git 目录沿相同空间模型可用；Project 与 Workspace 作为真实绑定事实返回，不能冒充 Space/Zone 身份。精确子目标应能反推其上层，不强迫每次逐层填写四个 ID。新 Tab 的落点表达目标 Zone，`--new-tab-after` 不再承担落点语义；不引入旧命令兼容层或焦点 fallback。

用户要求把「在某处打开的 agent 移动到别处」，并确认「不改变执行目录，只改变在agentmux里的空间位置」。`space mv` 绑定源 Region 及其预期 Session，使用同一目标层级；多投影时不得凭 Session 猜来源，目标占用时不得静默替换健康 Agent。落地结果须明确源投影移除、目标位置保留，同一 Session/Run/cwd/原生句柄与其他投影保留；不能复制、合并到第一块同 Session 投影或把关闭源 Region 当成停止 Agent。跨 Zone 目标如实显示原执行目录。源与目标的持久化恢复一致，未知提交不能报告已移动或盲目重移。

动作回执分别表达资源/Git checkout、Workspace 登记、工作面放置、Core Session 创建与首句投递的真实事实。启动成功、PTY 接收字节、Core 既有协议投递确认和 Agent 接受/开始/完成任务不能相互代签。后续流程失败保留已创建资源、持久工作面与健康 Session；回执丢失或进程重启后能按精确身份查询已发生、未发生与未知的事实，未知不得触发重复创建或重投。恢复先保留原 durable Tab/Group/Region/布局/焦点及空间绑定，再尝试同 Session reattach/resume；Session 执行目录与展示 Zone 不同不能成为删除投影的理由，移除仍须 Core 的真实终局事实。流程握手、观察或布局失败不能停止健康 Run。

布局已应用、客户端偏好已写入、宿主 flush 已请求与磁盘耐久性已确认分别报告；耐久性只能由 Core 的[持久空间状态 owner](../../architecture/spatial-state.md)完成耐久写入后确认，不能因为 localStorage 写入或 await IPC 就声称已经落盘。未取得确认时如实报告 unconfirmed，保留原工作面、未保存改动与健康 Agent；客户端偏好、草稿或呈现快照不能替代、覆盖 Core 的空间状态。源移除与目标落点沿同一次 Core 空间提交保存；真实私有普通进程重启后读回同一空间绑定、布局与 Session 引用，才证明恢复验收。CLI 回执保持现有 JSON 输出，身份可原样用于后续命令。

具体 grammar、缺省规则、失败保留、请求对账及真实私有重启验收见 [Agent-first 的 Space 工作入口](#agent-first-的-space-工作入口)；CLI 合同与推荐方案（本机过程资料：`docs/plans/pmo-cross-workspace-worktree-cli-design.md`）。上一版 `worktree create/start` 主流程不再是当前方案；技术文档或 proposal 状态不能冒充功能交付。


## 手机版 Relay 连接

手机是适合移动使用的 AgentMux 第一方 client。连通后的一级导航从左到右为 Goals、Topics、Mote、Focus、Space，Mote 位于正中；原会话内也可切换主工作面。Survey、连接与设备设置及其他辅助能力收进菜单，不重复五个主入口。Mote 只列原协调对象；Space 沿原 Space→Zone→Tab→Region 绑定导航；Focus 按原 Core 执行状态与待处理交互组织，已有 Session 继续可达。目录不可读不按 cwd 或 Session ID 猜归属，原会话、草稿与阅读引用保留。默认主页可在五个主入口中选择并保存在本设备，原有三项设置原样保留，未知记录不覆盖；连通后直接进入该主页，未连通时才默认显示接入页。连接恢复不抢走用户后来选择的工作面。

目录展示消费原 Focus 的名称、项目、状态与 recap，以及原 Mote 自定义头像。公共 carrier 保留这些 owner 的原展示值，不另加字段容量或再次截断摘要；类型、准确身份、权限和既有整条传输容量边界仍成立。正常中文与 emoji 展示数据不能使整份目录不可读。

手机在同一局域网打开 Mac 设置页或右下角手机 Toolkit 复制的完整链接，即可继续同一已有 AgentSession 的对话、Prompt、交互请求和终端。正常接入不手输地址、配对码，不回 Mac 二次批准，不弹系统确认。Mac 自带手机网页与局域网 Relay，无公网服务或部署前置条件；公网部署、Linux 发行、新建工作区、商店发布和系统推送不属于本批。

连接沿成熟 Relay V2 的稳定 Host ID、公钥 offer、端到端加密握手、多设备通道、心跳与自动重连。Relay 只转发密文，不持有业务语义、Agent Session 或 Runtime。Host 身份与地址分离：监听通配网卡地址，复制时读取当前可用局域网地址；地址变化不换身份或删除设备记录。旧 IP 链接在原地址失效后需从 Mac 重新复制，局域网方案不承诺跨网络寻址。Toolkit 结果中的完整 URL 是该次执行的历史事实，可继续查看；手机连接工具的结果区 Copy link 与 Generate & copy link 均显式调用原 Toolkit 动作取得当前 Host 链接，只在本次 invocation 确认成功后复制。失败或回执未知不复制历史 URL、不自动重做。局域网网页与 WS 可用 HTTP，公网入口须 HTTPS/WSS；页面地址的可信来源仍是用户从原 Mac 复制的链接。

链接承载公有 offer，不携带长期私钥或一次连接码；打开后从页面地址清除并保留公有连接信息。Host 私钥持久保存在原 Store 旁的受保护文件，损坏时保留原件；设备持久加密密钥沿设备拥有的存储保留，浏览器使用同源 IndexedDB，不进入 URL、日志、普通 localStorage 或工作面导出。链接不是限时单设备邀请；完成加密握手的设备按真实公钥登记独立身份，撤销立即终止该公钥的请求与订阅。旧设备、操作记录、Host 身份和工作面数据保留；旧固定 IP/TLS manifest、邀请、claim、OS 批准和原生 Cookie 传输实现删除。

分层与远端身份沿[《联邦 Runtime 与远端恢复边界》](session-recovery.md#联邦-runtime-与远端恢复边界)，公共方法沿[《对象优先 CLI 与统一公共业务服务》](#对象优先-cli-与统一公共业务服务)，原工作面与健康 Run 沿[《Session Attach 与 Runtime Projection 的边界》](session-recovery.md#session-attach-与-runtime-projection-的边界)，终端字节、阅读与成本沿[《Terminal 连续向上阅读历史》](terminal-reading.md#terminal-连续向上阅读历史)。长期无 UI Host 使用原 Core/Hook/Store/Provider 与 ctxmux namespace，同时服务 Desktop 和 Mobile；加密连接接原公共 JSON-RPC dispatcher 与有限 Hosted SDK，不复制 Runtime。网络或手机入口故障只影响该入口，保留健康 Desktop、Unix、Agent 和 Run。

公共 `device.ls/link/revoke` 只借原 Host Authority：本机用户读取状态、取得当前完整链接及撤销设备；managed Agent 和远端设备不能调用这些管理方法。`device.hello` 仅允许已认证 Relay 设备命名自己的身份，目标由真实加密握手 principal 确定，不能由 JSON 选择。GUI、SDK、CLI、方法发现和回执共用这些方法；原邀请、approve、reject、intent 方法删除。请求或订阅只能观察、释放自己的 Runtime consumer。

设置与 Toolkit 展示真实连接状态、当前在线数、已授权设备、最近活动与操作记录；同一公钥的多个请求或订阅只计一台。记录包含发生时间、操作、目标 Session/对象与结果，未知不冒成功，失联不冒撤销。操作来源沿 Host 认证上下文与 Core 公共事实保留，名称不代替身份。对话用户输入与交互操作可辨来源设备；未知历史不按当前设备补猜，不把 Agent 回复归为发起设备。两处共用同一设备和活动 owner。

网络中断、休眠与后台返回自动重连，原工作面、Session 引用、草稿、阅读位置与未确认操作保留。恢复沿原 SDK 重新核验原 Host 与 Session/Run、接回事件和字节 cursor；副作用不自动重放，只有 Core 终局事实允许移除 Session 引用。相同 Host ID 的地址变化允许更新地址；不同 Host 不得接收原会话输入。连接步骤失败就地显示当前未知/不可用事实与恢复动作，不将协议失败猜成 Agent 退出。

观看与控制可辨。手机终端默认沿原 Run 已确认网格显示，旋转或 viewport 变化不自动改变 PTY；用户明确进入控制并主动调整尺寸，才向原 owner 请求。被动阅读不 resize，不发鼠标输入或 DA/DSR/颜色查询回写，checkpoint/replay 不触发输入、通知或剪贴板，不伪造 ctxmux 排他 lease。

设备工作面采用明确的持久来源和可导出保全记录；重启与卸载后的存储条件分别说明，不假定密钥跨卸载必存。身份丢失后打开原 Mac 链接登记新设备，不创建替代 Host Session。iPhone 与 Android 保留同能力范围，未执行真机验收不得据构建成功宣称两类设备验收通过。

### 手机对象身份与工作面
手机 Send／Cmd+Enter 的单条输入语义沿[《Composer 消息队列与紧凑状态》](conversation-input.md#composer-消息队列与紧凑状态)，消费原 Core 的显式输入能力；普通 Enter 保持原常规输入，重连与读取不生成发送授权。输入前拒绝与已尝试投递的未知回执可辨，草稿、阅读和原 Run 保留；提示与恢复动作在输入区外完整可读，不因长诊断挤压正文或编辑器。

手机附件先由系统选择一张图片或普通文件，在原输入区就地预览、移除或明确上传；选择、上传和网络重连都不授权发送消息。附件字节沿公共 `file.upload` 送到准确原 Host／Session／Run，私有目的路径由 Host 决定，不接受调用者文件路径，也不覆盖已有操作。只有实际保存并读回、完整内容修订与原 operation 一致的回执，才沿共享 Composer 把文件引用加入原草稿；原 Send 再走 Core 单条输入。晚到回执不进入后来消息或另一会话，后来编辑的文字保留。未知回执保原 intent，通过 `file.upload.inspect` 核对同一操作，不自动重传；切连接、切会话和重启设备后保有准确原目标及核对入口。设备只持久化原 intent／回执，不把文件字节塞入工作面备份；未上传的系统选择随本次设备选择保留，离线不禁用正文输入。支持格式、单文件与传输上限由公共 codec 定义，不扩大 Relay／Hosted 原消息预算；超限或不可读取只拒绝本次附件，健康 Agent 与原草稿保持可用。

手机 Focus 行同时展示已确认的项目、Agent 名称与语义状态。项目关系消费公共事实，不以 cwd 猜空间归属；显示名沿原名称解析链；事实不可读时标记未确认并保留原工作面。Mote 使用原保存头像及动画；会话顶部仅呈头像，身份与状态按需查看，不以不透明标题栏遮挡对话。左上入口揭示侧栏并保留工作面；连接与设备设置位于侧栏。

`space.ls` / `space.inspect` 的只读 `presentation: true` 由 client 原呈现 owner 返回空间的 `catalog.appearance`，仅传有界 glyph、parts、图片引用版本与已选空间 PNG。Core 不解释头像外观，不保存新 identity。图片字节按选中 Space 的 inspect 读取；列表不批量传图片。现有 JSON-RPC／CLI raw RPC 可消费同一参数和回执，手机导航与头像为生产调用者。无新增写操作。

Mobile 的 Mote 外观沿原耐久身份 target，图片／图标／捏脸自定义及原动画完整消费；主身份默认龙不用于其他对象。Focus 的原显示名、项目、Executor头像、recap和状态分组由现有呈现owner返回，不能用手动名称override代替显示名，不能在手机复制分类推断。缺事实沿服务窗保原可用会话。只读 presentation catalog 传有界 agentPresentation 事实，RPC与CLI raw可消费，无新增写操作。

手机目录完整消费原呈现 owner 的名称、项目、详情和 recap，不另加任意字段长度限制或截断正常数据。传输容量沿既有公共消息预算，不用重复的更小字段预算阻断原可用目录。中文／emoji 不能导致整个 Focus、Mote 目录失效；验收包含原呈现生产者到实际公共 codec 的链路及原内容保真。

Mobile 消费原 Topic、Survey 与 Goals 的完整工作面及公共 owner，入口位置沿本节一级导航。Topic 保 Category、Topic、Chat 和知识来源身份；Survey 只显示原明确收集的研究 Zone、原名称和准确 Tab／Region，不能把全量空间当研究或复制内容。Goals 沿原公共目标 owner 保目标身份、状态、决策和操作回执，不维护手机独立目标系统。所选 File Region 以原目录元信息确定准确资源，通过既有 `file.read` 读取原内容与修订；列表不批量读取文件，不凭路径猜内容，不新增另一套文件读取接口。手机 Note 编辑和保存消费原共享 schema 与 revision-aware 文件写入 owner；冲突、未知写入和未保存草稿明确保全，未取得确认不冒保存成功。正文写入若缺公共入口，在同一交付中暴露原 owner 的最小 RPC／CLI 能力并验证实际手机消费，不停留只读占位。Browser 沿原 browserId 发现当前网页。原对话、Message Tools 与 Terminal 继续同源，自定义头像和动画保真，失败保原对象和草稿。
