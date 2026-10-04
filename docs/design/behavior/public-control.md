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
- File 模式由同一个原 Region owner 决定真正正文与菜单状态，不能同时保留 local preview 与 diff 让明确选择被遮盖。File 的实际格式与预览范围唯一遵循[《本地文件预览与按格式编辑》](files-and-git.md#本地文件预览与按格式编辑)：HTML 的同 Region 隔离预览与源码分别表达，不能把 HTML 源码显示冒充已经提供预览；普通文本不冒 HTML，媒体与已知二进制只读预览。支持范围来自实际格式与读取事实，未知如实未知；模式已应用与 preview／diff 数据可用分别说明。切换保同一原文档、未保存内容及每 Region view state，projection 模型沿原生命周期可释放／重建；仍合资格的原输入不被抢，失去资格如实未确认，不保存文件或阻断健康 Run。
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
| `device` | 本机用户管理：`ls`、`link`、`revoke`；已认证加密设备仅以 `hello` 命名自身。授权与撤销沿[手机版 Relay 连接](#手机版-relay-连接) |
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


## 对象地址、分享与方向

- **分享对象地址时，复制的是一个寻址方式。** 接收方（人或另一个 Agent）仅凭这份分享就能识别对象身份并执行准确命令，无须猜 ID 层级、flag 或回头问人。普通路径、URL、代码选区、终端输出与分支名的直接复制仍按其原任务生成内容，不包成身份名片；明确面向 Agent 的上下文分享按本节共用外框呈现。

- **三类地址回答三个不同的问题，绝不互为别名**（与上文 Session/Run/Tab 的身份边界同源）：
  - **Session** 回答"**哪个 Agent**"——Provider 语义身份，跨 Tab 稳定，一个 Session 可同时投影到多个 Region 与多个 Tab；
  - **Region** 回答"**哪一格内容**"——Tab 内的精确内容 leaf；物理位置命令必须使用已知准确 Region 与原展示上下文，不从一个 SID 猜唯一位置；
  - **Tab** 回答"**哪张完整工作面**"——只有其中恰好一个不同的 Agent Session ID 时才可用于语义发送；同一 SID 的多个 Region 投影仍是一个 Agent。既有 View 用语不形成另一层身份。

- **对象分享直接复制 `amux://` 链接。** Agent、Region、Tab、Space、Zone 分别使用 `amux://agent/<SID>`、`amux://region/<RID>`、`amux://tab/<TID>`、`amux://space/<ID>`、`amux://zone/<ID>`；每份只包含原对象类型与一个准确身份，不再复制身份名片、执行器资料或重复命令说明。Agent 链接始终指向 Core SID，不以原生会话 ID、显示名、执行器、Run 或空间位置替代。右键菜单按真实动作命名 Copy Agent/Region/Tab/Category/Topic Link，同一目标只保一个复制入口；复制本身不发送、不导航、不改变焦点、展示、草稿或健康 Run。
  - 新 Agent ID 的等长 Base58 生成与既有 ID／持久创建重试保全只定义在[Session、Run 与 View](session-recovery.md#sessionrun-与-view)；链接仍准确引用原 SID，不增加分享别名或另一种地址格式。
  - 生成与严格解析来自无 UI 依赖的同一 Core 公共出口；ID 按 URI path segment 编码并准确还原，不携带正文、命令、父位置暗示或自动执行参数。格式有效不证明对象存在、健康、已呈现、跨设备可达或内容作者可信。非法 URI 只拒绝这次打开，保留工作面与其他健康能力，并明确原因和重取链接的恢复动作。
  - Agent 链接定位为唯一现有 Region 时，原 focus owner 在提交导航前按预期 SID 原子核对该格当前 Agent，导航回执保留该条件。位置已更换只拒绝这次导航，后续异步呈现或持久确认期间变化只报告未确认、保留用户后来工作面，不回滚或操作替换者。相同条件由已有 `space focus --region … --expect-session …` 可用，空间身份与 Agent 身份仍分开。
  - 接收 Agent 在既有启动引导中知道 `amux://` 是对象引用，遇到链接先查 `amux --skill`，再按类型和原 ID 使用已有公开 inspect、send 或 focus 能力。用法在原 skill 按需发现，不在每次分享附带一份命令；短可执行名 `amux` 正式指向同一公开 CLI 程序，不依赖用户 shell alias。当前能力以实际构建的 `--help`／`--skill` 为准，没有相关工具或引导的外部 Agent 不被假定自动知道用法。
  - Core 持有 Session、耐久空间组成与全部 bindings，client 只消费原事实，不另建对象或位置名册。Agent 链接的语义收件人始终唯一；其多个展示不是多个 Agent，也不能据 SID 猜唯一 Region。打开时沿原空间发现与导航通路解析准确现有展示，多候选完整可辨并要求明确位置，无已知展示时说明本次位置未确认并提供原对象检查／打开／恢复入口，不把观察缺口冒成 Session 终局或创建替代 Agent。
  - Desktop/client 负责系统协议注册、外部冷／热启动接收、屏幕呈现与输入焦点。冷启动沿[原恢复合同](session-recovery.md#冷启动按需恢复p0-末位)先保全工作面并承接定位请求，不能因初始化未完成丢请求或猜目标不存在。热启动进入原对象的真实展示，导航与输入分别表达、默认保留输入；不更改 Session、健康 Run、执行 cwd、空间组成或草稿。未知、不可读、未找到与明确终局分别表达，失败保留原能力并提供具体原因与恢复入口。

- **对象链接在对话中的富呈现不改变地址语义。** 行内 Agent 名片只消费同一原 SID，消息与复制仍保原 URI；识别、当前资料和只读边界唯一见[对话正文中的 Agent 对象引用](conversation-input.md#对话正文中的-agent-对象引用)，打开动作仍沿本节原导航与身份条件。
- **已有的 Agent 上下文分享复用同一外框。** 编辑器的 Copy as Agent Context 以 `--- amux : File ---` 开头，Browser 的元素／批注上下文以 `--- amux : Browser ---` 开头，均以 `-----` 结束。它们是内容与来源分享，不冒称 Agent 身份，不强加 `ID`、`Exe` 或无关发送命令；外框只包原 owner 已产出的正文。
  - File 保留原工作区相对路径、起止行、语言围栏和所选代码；Browser 保留真实页面、元素／选区与批注来源、原顺序和原内容上限。格式器不读取文件或页面，不解析正文、不改原文或提升正文中的声明为身份、授权和可执行指引；范围、内容预算、复制失败反馈与重试继续由原 owner 执行，正文上限不能靠增加外框被绕过，最终外框须完整闭合。

- **歧义在源头消除，不甩给接收方**。一张 Tab 承载多个不同 SID 时，整张 Tab 不能唯一指定消息收件人。右键已知某个 Agent 的那一格时，Agent 链接直接给出其语义 SID；准确 Region 通过独立 Region 链接分享；不能让接收方先撞 `MESSAGE_TARGET_NOT_UNIQUE` 再挑候选。同一 SID 的多个投影不构成语义发送歧义；精确位置查询、导航和移动仍不能据此猜成唯一位置。

- **复制入口按其能消除的歧义就近放置**。Region 菜单的 Copy Region Link 指向准确 Region，Copy Agent Link 指向该格的 SID，不取当前焦点。Tab Link 用于检查整张工作面；只有唯一不同 SID 时才给 Agent Link，不取首格。同一 Session 从 Region、Tab、Roster、Focus、终端入口产出相同 Agent Link；准确位置通过独立空间链接分享。

- 复制的 CLI 指引**只使用公开对象 CLI 与 Control 面接受的寻址方式**（`agent send` 的 `--to-session` / `--to-region` / `--to-tab`、`agent inspect --session` 和 `space inspect` 的对应空间 flag），不为复制发明第二套语法。地址里的 id 一律按 shell 语义转义，使带空格、引号或像 option 的 id 粘贴即可执行，命令不得改变原值。

- **Tab 发送消歧与精确回执同源。** 消息按不同 SID 聚合，一个 SID 的所有 Region 候选完整保留；同 SID 多投影只入队和提交一次。多个不同 SID 或零 Agent 时给出合法 typed candidates，不能让错误回执自身成为协议错误。已捕获的收件人、Run 条件与消息身份保持，后来位置变化不能改投替换者、自动重发或谎称当前呈现已确认。

- **复制入口清楚表达对象与动作。** Agent Link 分享语义身份，Region／Tab Link 分享准确空间对象；发送、检查与导航由 skill 可发现。不能把复制链接冒称已经发送消息或打开目标。

- **每一处能看见某个 Agent 的地方都要能寻址到它，TUI 里面也算**。终端画布自己的右键菜单知道这一格的准确 Session，应与 Region／Tab／Roster／Focus 共用 Copy Agent Link 和同一 Core 格式化出口，同一 SID 的链接逐字一致；不另查执行器 metadata，也不从焦点或 SID 猜空间位置。准确 Region 由独立 Region Link 分享。
  - 只有这一格是 Agent 时才出现 Agent Link；普通终端没有 Agent 语义身份，不显示灰掉的虚假入口。
  - 原有终端 Copy 仍复制选区／可视区／回滚；Agent Link 复制语义对象身份，两者沿既有分隔线分组，不能让用户误以为链接是终端内容或已发送消息。

- **失败结果要自带下一步命令，而不只是候选清单**。`MESSAGE_TARGET_NOT_UNIQUE` 已经带 `candidates`，但候选清单仍要求接收方自己拼出命令——那正是"歧义不甩给接收方"这条原则在错误路径上的漏洞。因此这类失败要额外返回**可直接执行的恢复命令**；stale View、目标不是 Agent、Agent 已退出各自给自己的恢复入口。恢复命令与复制出去的地址**共用同一个格式化出口**，不为错误路径另写一份拼接（两份拼接会各自演进，且漂移时不会有测试变红）。
  - **恢复文本挂在控制错误的出口层，不挂在抛出点**。同一个失败码往往有多个抛出点（`TAB_NOT_OPEN` 与 `REGION_NOT_OPEN` 各三处），在每个抛出点拼一次恢复文本，必然随时间各自演进，而漂移的那天不会有任何测试变红。控制错误离开渲染进程只有一个出口，恢复文本要说服的正是**出口对面那个调用方**——所以那一层是它唯一该长出来的地方。
  - **哪些码算"寻址失败"由地址模块自己判定，出口层不列第二份码表**——两份码表同样会漂移。不属于寻址失败的码**不附加恢复文本**：一句放之四海的"再试一次"既没有信息，又会盖住原始 message 里真正的原因。
  - **恢复命令只用已通过校验的候选**。未校验的 id 可能带换行或保留字，会把恢复文本切成一段执行不了、甚至误导人的命令——那比不给恢复更糟。
  - **给出的每一行命令都必须真能跑；给不出就不写命令**。"下一步"的价值全在于粘贴即可执行，一条命令形状但跑不了的文字比不给更糟——它看起来像出路，用户照做撞的是第二次失败。判据不是"读起来像命令"，而是用实际 CLI parser 逐行校验对象、动词与必填项：`agent inspect`／`space inspect` 有准确选择器，`agent send` 除选择器外还必须带 `--text`，列实际 Session 用 `agent ls`。检查共用出口的命令，不能只匹配一段看似正确的前缀。
  - **守卫的粒度必须细过它要防的那个 bug**。上一条的裸 `inspect` 修好后，形状表把 `send` 与 `inspect` 合写成一条，于是漏掉 `--text` 的 `send` 又一次照样匹配——同一个洞换了个位置复发。凡是修"断言太粗"，都要回头检查同一条断言里还有没有第二个粗的地方；不同动词有不同必填项，就不能共用一条形状。
  - **写"下一步"之前，先证明这个失败是怎么到达的**。判据是抛出点外层的分支条件，不是错误码的名字。`AMBIGUOUS_REGION_TARGET` / `AMBIGUOUS_TAB_TARGET` 听起来像"你给的地址匹配到多个"，实际只从 `self` 分支抛，真实含义是"发起方自己同时显示在多处"——显式 id 走不到那里（Region id 是 UUID，全局唯一）。按名字直觉写出来的文案会让用户去改地址，而问题出在"我在哪"这个前提上：**一条方向错的下一步比没有下一步更糟**。这类文案要用语义断言钉住（必须点名 `self`，不许套用另一个码的说法），形状断言（"命令能跑"）对措辞错误一视同仁，抓不到张冠李戴。
  - **这条判据对复制侧与恢复侧同时成立**。"粘贴即可执行"本就是复制这件事的全部意义，而它一度只被施加在恢复文本上：改掉命令出口的 `--text`，三个地址的复制断言纹丝不动，因为它们只校验到 id 就收手了。共用出口的两侧，判据也要共用同一个校验函数，各自带"检查了几行"的下界防"一行都没检查"。
  - **缺少准确目标时不给猜出的恢复命令。** 失败结果没有足够的 Tab／Region 身份时，提供原位置的重取地址动作；已有准确 Session 身份时，可提供能操作同一 Agent 的稳定 Session 旁路。Tab／Region 的持久身份仍沿[空间模型](spaces-and-layout.md#空间模型)，暂未取得地址不表示身份失效。
  - **列实际 Agent Session 与列已配置 Executor 是不同动作。** 前者用 `agent ls`，后者归 `settings executors ls`；unknown／unavailable 保持真实，列表不擅称全部仍活着。两者即使命令都能跑，也必须校验下一步与错误原因的语义对应。

- **「左边/右边/上面/下面」在创建时表示分栏，在查看时也能落到相邻 Tab。** 创建与方向查询各消费原公开能力，遵循以下共同方向语义。
  - **创建与查看的默认落点不同，这是有意的，不是不一致**：创建一个方向只有一种诚实解释——用户要多一格，那就是 split（新开一个 Tab 不叫"在右边"）；而查看一个方向时，屏幕上"右边"的东西可能是同一 View 里的另一格 Region，**也可能在没有分栏时就是 Tab 条上相邻的那张 Tab**。查看端拒绝回答"没有分栏所以没有右边"，等于对着用户眼睛看得见的东西说不存在。
  - **优先级由"屏幕上更近"决定：先 Region 后 Tab**。同一 View 内有分栏时，方向解析必须落在 Region 上——那才是用户视线里紧挨着的那一格；只有当该方向上没有兄弟 Region 时，才退到 Tab 邻接。反过来（先 Tab）会让一个分了栏的 View 把用户指向另一张 Tab，与所见不符。
  - **上下方向对 Tab 不成立**。Tab 条是一维水平序列，"上面那张 Tab"没有所指；此时如实回答该方向没有邻居，**不许把 up/down 悄悄折成 prev/next**——那会让 Agent 以为自己拿到了上方的东西，实际拿到的是左边那张。
  - **"哪个算右边"只有一处定义**。创建与查看做的**不是**同一件事——split 是在 Region 树上劈开一个节点，查看是在已排好的版面上找邻居——但两者对 left/right/up/down 的**轴向解释**必须来自同一处（横向轴属 left/right，纵向轴属 up/down）。方向查询自身写成纯函数，从既有的版面几何（Region 的归一化 bounds）与既有的 Tab 序列推导，不为它另建一份布局真相；否则漂移时只表现为 Agent 偶尔寻址到隔壁，而没有测试会红。
  - **方向结果不形成新的身份或地址层级。** 解析结果仍是既有的 Region 或 Tab 地址，沿其原公开选择器，不新增 surface kind。

- 后台 Agent 由 Agents 工具重新发现和打开，不建立第二份 Session Registry。

- **Agent 自己就能把 terminal、browser 或文件开到某个方向的分栏里**，走的是既有的 `open` / `arrange` CLI——那已经是"Agent 驱动界面"的接口，**不新建第二条通路、不新增 surface kind**。缺的从来不是能力而是发现：因此由启动时注入的提示负责让每个 Agent 知道这件事存在、并知道去哪查确切用法，而**不把完整 CLI 语法抄进提示**（那会与 skill 争夺唯一真相，并在语法演进时立刻过期）。这条的验收是行为断言——证明启动路径确实携带了该提示，而不是断言 skill 文本里含某个字符串：后者在改动前也会通过，证明不了任何事。


## Agent 自助创建与空间操作

- **自定义 Executor 与内置 Executor 走同一创建路径**。用户说“应该要可以开出来，且也有完整的元信息”。发现结果必须区分用户名称和稳定 Executor ID，并以当前配置为准；按名称指定时，唯一名称可解析到稳定 ID，重名须返回候选而不猜。未找到名称不能被描述为“这个 Provider 不支持自定义 Agent”，也不能擅自用默认 Executor 代替用户选中的配置。
- **新建 Agent 的执行工作区与展示目标可分别选择。** 明确选择的执行工作区须是已登记的资源 Workspace，由原 owner 解析准确 Host 与目录；展示仍沿原 Space/Zone/Tab/Region 定位，因此本地分屏可承载远端新会话。未另选执行工作区时沿原创建上下文；显式引用不存在、未知或歧义时拒绝本次创建并保原工作面，不猜目标或顺便登记资源。此独立选择只用于新会话，不覆盖已有 Session 或 fork/resume 的执行事实，也不与本次新建 Zone 资源并用；一项创建只有一个执行资源来源。请求与回执分别保留执行资源和实际展示位置，资源登记不替代 Runtime 或来源作者授权。
- **元信息足以发现、启动和核验同一个 Agent**：创建前可见 Executor ID、名称、Provider 与目标 Host 的探测状态；创建后可关联 Session、Run、Host、Workspace、View、Region 和能力。Session/Run/能力来自 Core，布局坐标来自布局 Owner；配置里的环境值与凭据不是发现元信息。未探测、探测失败与确认缺失必须可区分，不把“未探测”说成“不能启动”。
- **“在右边新开一个”不是“查找右边已有的”**。旁边已有 Agent 不满足新建请求，也不构成空间已满。Tab 条相邻只表达导航关系，不能被当作当前 View 中可见的分屏占用；空间判断取同一次 View 几何与内容快照，不按 Tab 标题、列表次序或树深度猜。
- **技能中的空间原则保持简短、通用**：先看当前视图，优先复用符合方向意图的空位；需要拆分时，选择能让新旧内容都清晰可用且扰动最小的区域；保留现有工作，完成后核对实际落点。由 Agent 根据可见空间决定具体拆哪格，不枚举窄/宽/左右的特例，不要求面积相等；用户明确给定的目标与方向优先。
- **成功以提交后的实际归属为准**。创建、拆分、移动与重排不能用过时计划的 Tab/Region 身份宣称成功；源、目标、树叶、内容索引和焦点必须一致。异步创建期间布局变化不得覆盖较新的布局；Agent 已经健康启动但展示目标失效时，保留其 Session 可发现性并明确说明当前落点或未展示状态，不因为布局流程失败停止它。
- **独立布局包必须是真正的唯一实现**。通用树结构、几何、方向、分割、移动和不变量属于可独立使用、无 React/Electron/Agent 依赖的布局包；Desktop 用它的公开 API 绑定内容、渲染与持久化。Workspace 的 Tab Group 树与 View 的 Region 树保持不同身份，复用同一套布局代数；不把 Session、Provider 或 Run 生命周期装进布局包，也不在 Desktop 保留第二份树实现。是否完成以独立包消费验证和产品调用为准。
