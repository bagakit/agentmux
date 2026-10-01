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
- [Agent-first 的 Space 工作入口](#agent-first-的-space-工作入口)
- [私网手机版首个闭环](#私网手机版首个闭环)

## AgentMux 自操作与 Computer Use 边界

- Agent 操作 AgentMux 自身时，必须使用 AgentMux 自有的 typed Control 协议与语义 CLI；`inspect`、`list`、`open`、`send`、`focus`、`arrange`、Demand/PMO 操作都走同一条 Control owner。不得通过截图、坐标点击、macOS Accessibility 或其他通用 Computer Use 旁路完成本产品已有的操作。
- AgentMux 的产品运行、Session/Run 生命周期、Board/PMO 管理和发布验收不得把外部 Computer Use 工具作为前置条件。外部工具不可用、权限过期或观察失败时，保留产品自身的真实状态并给出诊断，不得阻断健康 Agent。
- 内嵌 Browser 的网页操作继续使用已有 CDP/Browser Control；它是页面语义通道，不是 macOS 辅助功能，也不复制一套桌面自动化 Runtime。
- 用户确认：「agentmux 应该有自己的 computer use 方案」。AgentMux 应向 Agent 提供自己拥有的 Computer Use 能力入口与真实执行反馈，用于桌面观察和操作；这是一条独立需求，不能把开发者临时调用外部工具算成已经交付。
- AgentMux 的 Computer Use 与已有自操作 Control、Browser CDP 各有清晰职责：已有产品语义操作仍走其现有 owner；系统桌面能力的实际执行属于 Desktop／平台适配边界，不把 Electron、系统窗口或辅助功能实现带入无 UI 的 Core，也不复制 Agent／Run 生命周期。
- 桌面权限缺失、目标窗口消失或操作失败必须如实反馈，不能冒充成功；该能力不可用不能阻断健康 Agent 的输入、启动与恢复。外部桌面自动化工具仍可用于独立开发验收，但不是产品启动或发布的前置条件。

## Agent 操作桌面主画面与保留对话输入

用户希望「Agent CLI 能操作 AgentMux 桌面应用本身」，Agent 和用户交流时能切换界面；理想情况下，Mote 在浮窗里交流的同时，可以改变主画面当前聚焦的 Space 或某个 Goal，也方便 Agent 自行迭代、调试和观察。该能力沿本产品既有 typed Control 与 `focus`／`inspect.client` owner 接入，是桌面产品的语义导航；不把系统桌面 Computer Use、Browser 操作或 Agent／Run 生命周期并成另一条 Runtime。

- **主画面与对话输入分别成立。** 选中主画面目标不等于真实 caret 已转移。默认导航保留仍在交流的 Mote 浮窗、同一对象／Tab／Region、原 View、真实 caret、草稿与组字，不关闭、重新创建、重选或自动发送其内容。只有调用者明确要求把输入交给精确目标时才尝试输入焦点转移；不能为证明主面导航成功先 blur 浮窗再恢复或挑一个编辑框。
  用户继续点击或输入浮窗，选择该原 Tab 内的精确 Region、原输入与逻辑 lane；浮窗自己的活动 Region、焦点标记与观察须跟随这次局部选择，主面保留的源焦点即使来自同一 Tab 也不能覆盖浮窗的局部选择。固定浮窗仍保留原有的输入与人工操作能力。不能因此清掉主面精确 Space／Zone 地址、改变无关 Workspace／Group 或保留的源焦点，或重新授权另一处 launcher 自动激活。人工在主面明确导航或新建 Tab 仍按原交互执行。
- **用真实身份导航。** Space／Zone／Tab／Region 只沿[《统一概念与空间寻址》](spaces-and-layout.md#统一概念与空间寻址)的真实来源，Goal 使用既有 Demand 持久 ID。精确子目标可反推父层，父子不一致或多候选不能猜最近、第一张 Tab 或别人的 Agent。导航仅改变既有展示选择；不创建 worktree、Tab、AgentSession、任务或 PMO，不移动 Region，不改执行 cwd／Run／原生句柄，不停止健康 Session。
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

拆成三件事，其中只有前两件是新的：

- **快速操作**：已有 Control 协议（`packages/core/src/control.ts`，schema v5）覆盖 inspect/open/send/focus/arrange/list/interrupt/resume/stop，Agent 通过 socket 发结构化请求，本来就不必点。**缺的不是通道，是可观测性**——Agent 发完一个请求，只拿到一张 receipt，看不到界面变成了什么样。
- **回看结果**：操作之后要能拿到 AgentMux 自己的元信息与截图。这是新增的能力，也是架构风险最高的一件。
- **不做的**：不为自举新开第二条控制通道。Control 协议已经是 Owner 边界上唯一的入口，再加一条"调试专用"的路，等于让 AgentMux 有两套关于"现在是什么状态"的说法。

三条硬边界，逐条都有它防的具体坏事：

- **观测走 Control 协议自己的 operation，不新建旁路**。新增的是 `inspect.*` 家族里的成员（截图、元信息），复用同一套 caller 校验、同一套错误码、同一份 receipt 形状。旁路会绕开 caller 身份校验——一个 Agent 就能观测另一个 Agent 的界面。
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
- **进度是一条独立的长连接路径，不是把一问一答那条放宽。** 现有操作全都是"读一条→回一条→关闭"，
  且拒绝尾随数据；为了流式而放宽那条检查会让全部操作的 framing 假设一起松掉。所以订阅是新增的
  一支：开场一帧交代当下事实（那条操作、以及有没有缺口），之后每条事件一帧。事件游标只在**一个
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
- **原权威 owner 不变。** Core 保持无 Electron／React 依赖；Provider、AgentSession、权限、Hook 与语义恢复仍归 AgentMux 公共能力；ctxmux 独占 Run、PTY、ordered bytes、Replay、Gap 与 Attachment。Desktop 展示、配置、文件／Topic 与空间 handlers 由 Client 持有，通过同一服务接入；不新增一套 Runtime、Topic／Project／Space／Session registry、持久状态镜像或 CLI 专用业务判断。
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
- **Topic 与资料来自真实文件系统。** 全局 Topic／Mote 及其资料的发现复用原目录／文件 owner，身份和修订来源明确；宿主或范围不可用时显式 unknown／不可用，不补一个全局 registry，不借当前项目、默认 Mote 或另一份 Session 列表补齐事实。部分来源失败保留其他已经观察到的结果与原工作面，不宣称全局资料已经完整。
- **PMO 从别处也能执行真实工作流。** 人或 PMO 位于其他 Workspace，显式指定真实项目资源及目标 Space 位置，通过同一 RPC 业务编排选择或创建 Git／目录 Zone、建立首张 Tab、打开指定 Executor 的 Agent 并交付首任务，取得精确 AgentSession／Run 与空间地址，随后可发送、观察和操作。Project 的资源身份／Host／目录与显示 Space／Zone 地址分别指定、校验和返回，不能从 Space、调用者 cwd 或焦点猜资源；目标没有现成 Tab 仍可开始，不要求锚点。资源创建、Workspace 登记、展示放置、Core 创建与首句投递分别保留真实事实；部分失败保留已建资源与健康 Agent，投递 confirmed 不抬升为 Agent 接受／开始／完成任务。新 Zone 的资源 input 须携带显式 Project 身份，沿原配置的 Host 与仓库／目录事实解析；展示 Space 可为 Folder、Topic 或 Mote，不限为资源目录 Space。已有 Zone 使用本 Zone 的真实资源，不要求重选 Project。回执分别给出 Project、资源来源 Workspace、Host／目录与展示地址；同一业务操作不能更换资源后复做。具体 carrier 沿下述已评审派生合同，不把尚未实施语法当成已可用。
- **`mote playbook pmo` 只读。** 它是说明 PMO 方法、分工、目标与完成标准确认、发现资源、编排已有能力、回读事实及未知恢复方式的工作手册，引用实际公开 CLI 及其真实边界，不启动 Agent、不自动执行步骤、不投递任务、不改变角色注册；已存在的 SOUL／Wiki 与用户资料保持原样，不机械改写。能力尚未落地时明确说明，不把目标命令写成已经可用的操作承诺。
- **展示导航沿原合同。** `app focus` 表达主 Surface 的选择，`space focus` 与 `goal focus` 表达精确对象导航；选择、真实呈现和输入 caret 仍分开报告，默认保原 Mote 对话输入、草稿和组字，不改执行 cwd、不关闭健康 Session。原展示 owner 及对象间职责唯一见[《Agent 操作桌面主画面与保留对话输入》](#agent-操作桌面主画面与保留对话输入)，不因命令归域再造 router 或 caret owner。

- **Host 的公开运行能力沿同一公共服务。** 长期无 UI Host 借原 Core，以 `runtime.bootstrap`、`runtime.invoke`、`runtime.events`、`runtime.history-watch`、`runtime.release-consumer` 提供有限、从原 SDK 类型派生的调用与观察；不复制 Provider、Session Store、Run Runtime、方法白名单或 wire codec。缺少 Host 端口时明确不可用，不隐式创建另一个 Core。五个 SDK 方法只接受传输 owner 实际认证／批准的用户或设备 principal；Agent capability 不能提升为用户输入权限，managed Agent 继续原 `agent.*` 语义与 A2A owner，调用 `runtime.*` 明确拒绝。真实连接的 signal 与 GUI 转发原 Agent caller 必须到达原业务 owner，不能由自由参数伪造；消费身份绑定稳定 principal，另一设备不能写入或释放它的观察。Unix 私有用户 endpoint、共享 HTTP 用户授权与实际设备授权分别如实表达，共享 token 不冒每设备身份，跨请求不以随机连接 ID 代稳定身份。原 SDK 参数、事件与 ordered bytes 保真，普通业务数据不能被当成连接控制字段剥除或协议 tag 重新解释，不同来源的事件不能因同名而丢失。GUI 转发保原业务 code 与 detail／details／candidates 字段，取消只收相关消费者，不停止健康 Run。 HTTP 认证明确拒绝与认证流程未完成必须区分：设备观察容量不足或认证服务暂不可用保持繁忙／不可用事实，不能冒凭证失效、撤销原授权或要求重新配对；原凭证、durable 状态与健康工作保留，未知回执不自动重试。`agent.output` 的初始事实必须来自同一次原 Attachment，保留真实 `terminal` continuation、`resizeRevision` 与 Run 字节边界；未知不能填零，不能另读一次状态冒同一快照。实际 Mac 用户批准设备的权限不能由 Unix 同用户、共享 token、普通设备身份或自由 JSON 参数代替，须沿原设备 Authority 的真实本机确认来源。Node 与浏览器共用无 Node-only 运行依赖的 frame/parser 与 HTTP fetch/SSE 入口，支持真实 cookie credentials，并公开复用同一纯 value codec 保留原 bytes 与 tuple；浏览器有限 SDK adapter、TLS 与设备授权沿各自 Client owner，接入同一公共传输，不能另造 wire，未验收时不宣称可用。

- **设备管理保真实本机批准。** `device ls/invite/approve/reject/revoke` 沿同一公共服务借原长期 Host 的设备 Authority，只传管理意图和精确设备／码，不复制 issuer、pending、reader 或认证 wire。配置界面与本机 CLI 使用同一端口，秘密字段不公开。实际接收端的 transport、原 caller 与 signal 由传输 owner 提供，不能由 JSON 自称；managed Agent、普通 device、HTTP、未确认来源不能调用管理 owner。Unix 同用户只允许提出请求，变更仍须该次真实本机原生确认，默认取消并在提交前核原目标与有效期；确认失败保健康 Core／Run。现 SSH stdio 会桥到 Unix，最后接收端不能冒原始来源；公开非 Unix client 与标准 stdio 转发明确拒绝设备管理请求，不能借桥进入本机管理。失回执先回读原 deviceId 的事实，不能自动重做批准、撤销或邀请；未验原生确认与真实 UI caller 不宣称可用。

**当前实现与未实现范围。** `f-2j28fqcvt` 已交付严格 JSON-RPC 2.0 公共服务、对象化 CLI、Unix／显式 HTTP 与 SSH stdio 转发、只读 PMO 手册、真实全局发现，以及显式 Project 资源与 Space 落点的首 Tab／首任务编排。公开 wire 不再使用旧 schema5 信封；内部 Client DTO 仍由原业务 owner 持有。三传输的权限与独立观察者释放、真实 Client 调用和私有普通进程重启恢复已有对应证据。五个 `runtime.*` 有限公共端口、原 Host SDK 派生类型、真实上下文与权限隔离，以及 Node／浏览器共用的纯 HTTP/SSE 入口已完成公共 producer 的 Source 验收与 main 发布。实际长期 Host 组合、浏览器完整 SDK adapter、TLS、设备管理与实际本机批准仍须各自接线和验收，不能由公共接口完成代签。

**已评审的派生合同与实施边界。** 新 Zone 以 `--project`／typed `projectId` 显式选择资源，既有 Zone 不需要该项；Project 由原 Workspace 配置的 Host 与仓库根／目录同一性派生，不添加第二 registry。新 Zone 可用 `--source-workspace` 明确选择该 Project 内的执行来源；未指定时仅接受唯一根目录来源或唯一已登记来源，多工作区且没有根目录时明确要求消歧，不从第一个工作区或当前 HEAD 猜分支起点。一个 `--endpoint` descriptor 只定位同一公共服务，不承担资源或空间身份；HTTP 显式启用且同权，SSH stdio 只转发远端原 Unix 服务，不意味着 ctxmux 远程 Run 已实现。Unix／SSH 保持有界换行 framing，内容须为严格 JSON-RPC 2.0，不保原自定义 wire 或兼容别名。`--operation-id` 是沿原 owner 对账的业务操作身份，JSON-RPC `id` 只关联一次 wire 请求；订阅只有一次响应，先响应再通知，取消／断线只释放相应 reader，不停健康 Agent 或原业务 operation。完整命令树、原业务保留和第一方指引须一起落地，Toolkit 原 add／remove 能力改为 create／delete，update／action 保留；具体过滤与载体实现仍受上述真实来源和 typed 合同约束。少量独立端到端切片可并行推进，最终验收消费同一候选的公共 RPC、完整对象 CLI 与 Project／Space PMO 工作流，不以纯文档或 helper 通过交付。

## Agent-first 的 Space 工作入口

用户要的流程是：「人在别的 Workspace，指定一个项目，给它创建 worktree，在这个 worktree 上开出第一张 tab，拉起指定 Agent，并把第一句任务交给它执行。」随后明确「还是要 agent first，所以命令是同等重要，但是必须完全满足 pmo 视角」。人和 PMO 使用同一套控制命令，PMO 无需切换当前工作面即可发现别处的 Space、Zone、Tab 与 Region，创建目标的首张 Tab，取得新 AgentSession 的精确 ID 并发送后续任务；不能要求目标已经有锚点 Tab。

最新主干是 `agentmux agent open ...` 与 `agentmux space mv ...`，空间目标使用[《统一概念与空间寻址》](spaces-and-layout.md#统一概念与空间寻址)的 **Space / Zone / Tab / Region**。`agent open` 能显式选择已有 Zone 或创建新 Zone，并在首张/新 Tab、已有空 Region 或明确分屏位置打开指定 Agent、交付首句。worktree 只是新 Zone 的一种资源来源，Topic/Mote 和非 Git 目录沿相同空间模型可用；Project 与 Workspace 作为真实绑定事实返回，不能冒充 Space/Zone 身份。精确子目标应能反推其上层，不强迫每次逐层填写四个 ID。新 Tab 的落点表达目标 Zone，`--new-tab-after` 不再承担落点语义；不引入旧命令兼容层或焦点 fallback。

用户要求把「在某处打开的 agent 移动到别处」，并确认「不改变执行目录，只改变在agentmux里的空间位置」。`space mv` 绑定源 Region 及其预期 Session，使用同一目标层级；多投影时不得凭 Session 猜来源，目标占用时不得静默替换健康 Agent。落地结果须明确源投影移除、目标位置保留，同一 Session/Run/cwd/原生句柄与其他投影保留；不能复制、合并到第一块同 Session 投影或把关闭源 Region 当成停止 Agent。跨 Zone 目标如实显示原执行目录。源与目标的持久化恢复一致，未知提交不能报告已移动或盲目重移。

动作回执分别表达资源/Git checkout、Workspace 登记、工作面放置、Core Session 创建与首句投递的真实事实。启动成功、PTY 接收字节、Core 既有协议投递确认和 Agent 接受/开始/完成任务不能相互代签。后续流程失败保留已创建资源、持久工作面与健康 Session；回执丢失或进程重启后能按精确身份查询已发生、未发生与未知的事实，未知不得触发重复创建或重投。恢复先保留原 durable Tab/Group/Region/布局/焦点及空间绑定，再尝试同 Session reattach/resume；Session 执行目录与展示 Zone 不同不能成为删除投影的理由，移除仍须 Core 的真实终局事实。流程握手、观察或布局失败不能停止健康 Run。

布局已应用、localStorage 写入、宿主 flush 已请求与磁盘耐久性未确认分别报告；当前 flush 请求没有磁盘 ACK，不能因为 await IPC 就声称已经落盘，也不能因没有 ACK 阻断健康 Agent。源移除与目标落点沿同一持久工作面快照保存；真实私有普通进程重启后读回同一空间绑定、布局与 Session 引用，才证明恢复验收。CLI 回执保持现有 JSON 输出，身份可原样用于后续命令。

具体 grammar、缺省规则、失败保留、请求对账及真实私有重启验收见 [Agent-first 的 Space 工作入口](#agent-first-的-space-工作入口)；CLI 合同与推荐方案（本机过程资料：`docs/plans/pmo-cross-workspace-worktree-cli-design.md`）。上一版 `worktree create/start` 主流程不再是当前方案；技术文档或 proposal 状态不能冒充功能交付。


## 私网手机版首个闭环

用户先确认「我们先完成这一步」并要求创建或整理 Feature Tracker，随后授权彻底实现同一私网首个闭环：在 worktree 推进，基于最新 main rebase 后线性集成，main 保持单亲，并发变更与未保存工作完整保全。前文“尚未批准”及仅整理计划不启动的记录只表达其当轮状态；本次执行仍沿已评审的同一目标、约束与验收边界。

手机先认证直连当前 Mac Host，继续同一已有AgentSession的对话、后续Prompt和确切交互请求，并让同一Run终端、连续阅读、手机输入和断线/重启恢复可用。公网relay、Linux发行、新建Agent/工作区、diff、商店发布和系统推送不属于本批。

分层与远端身份沿[《联邦 Runtime 与远端恢复边界》](session-recovery.md#联邦-runtime-与远端恢复边界)，同公共方法沿[《对象优先 CLI 与统一公共业务服务》](#对象优先-cli-与统一公共业务服务)，原工作面与健康Run沿[《Session Attach 与 Runtime Projection 的边界》](session-recovery.md#session-attach-与-runtime-projection-的边界)，终端字节、阅读与成本沿[《Terminal 连续向上阅读历史》](terminal-reading.md#terminal-连续向上阅读历史)。长期无UI Host采用原Core/Hook/Store/Provider handle与ctxmux namespace，同时服务Desktop和Mobile；手机网络Client不冒充ctxmux Remote或另一Runtime。切换必须保持原Desktop可用，不先拆正常流程或新建空Store。

共享既有Conversation消息/历史、结构化请求和Composer组成；设备外壳、焦点、剪贴板、overlay与键盘沿明确平台owner。手机独立导航、草稿、阅读和布局共用Session事实，观看不搬桌面Region。认证与私网可达性是两件事：设备有独立授权和撤销，HTTPS或已验证可信私网里的受保护认证通道鉴别Host并保护credential；浏览器不自行绕过证书或承诺JS pinning。撤销终止该设备已连请求/订阅，只收相关消费者，不停止健康Run。Host睡眠/离线如实说明，不伪称Agent退出或手机能唤醒关机电脑。

设备以短时一次邀请和Mac本机实际确认授权，远端或managed Agent不能自授或撤销本机授权；长期秘密不进入普通存储、URL或日志。服务端将活请求、订阅和Runtime consumer绑定已认证设备，客户端身份字段不能窃听或释放另一设备。可选私网接入的TLS、授权状态或监听流程失败只说明该入口不可用，不停止或阻断原健康Host、Desktop或Run，也不覆盖原身份材料。

浏览器的同源HttpOnly／Secure Cookie与原生授权通道分别核实，不能拿浏览器Cookie冒系统秘密库已实现。原生长期设备秘密由Keychain／Keystore等平台系统owner保管，JS只得公有状态，不能读取、导出或在普通存储中保有秘密；Host鉴别使用系统TLS信任，不绕证书。一次claim的结果未知时不盲重发，系统秘密保存未确认不能伪称原生设备已可用；失败保留原身份与明确恢复动作。

证书材料准备与设备系统信任分开：生成和导出不自动修改Mac/iPhone信任或激活服务，签发私钥保留在Mac，仅导出公开证书。既有签发身份或材料损坏时保留原件并说明，不静默换新；只有实际设备的OS信任和Host鉴别验证后才称连接可信，设备授权仍独立成立。

观看与控制可辨。被动阅读不resize，不发鼠标输入或DA/DSR/颜色查询回写，checkpoint/replay不触发输入、通知或剪贴板；设备policy不伪造ctxmux排他输入/尺寸lease。发送和request响应保原业务身份，失联未知不盲重发。前台恢复先保原工作面，再核验连接、Session/Run、语义与字节cursor；只有Core终局事实移除引用。

durable工作面明确保存位置和回读来源。设备进程重启与重新安装存储条件不同；不依靠普通缓存或假定秘密跨卸载必存宣称重装恢复。首闭环提供可保全的工作面来源、凭证丢失后的重新授权与明确恢复入口；未确认保原Host Session和服务说明，不创建替代对象。

iPhone 与 Android 两类真机均可用，优先交付 iPhone 并完成其真机验收，Android 保留后续同能力范围；已评审的两类设备 oracle 与保护约束保持。当前已确认 iPhone 与这台 Mac 在「同一 Wi-Fi / 局域网」，这是本轮 iPhone 连接验收环境；网络可达性不代替本节的设备授权、Host 鉴别与受保护认证要求。
