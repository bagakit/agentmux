# Goals 与 Demand 闭环

本文集中本主题的交互与行为要求。已确认约束定义必须成立的结果，不代表当前实现通过验收；提案、历史与当轮授权状态按正文的明确范围阅读。

[返回交互合同](../agentmux-desktop-interaction.md) · [同主题视觉](../presentation/goals-and-demand.md)

**本页章节**

- [Goals 的 Grill 与 Grounding](#goals-的-grill-与-grounding)
- [Agents / Session / Board 与注意力闭环](#agents--session--board-与注意力闭环)
- [Board 与 Settings](#board-与-settings)
- [Demand 文件事实与独立包](#demand-文件事实与独立包)
- [Demand 的完整业务闭环](#demand-的完整业务闭环)
- [全局 Board 的成熟产品界面](#全局-board-的成熟产品界面)
- [全局 Board 的三栏任务闭环](#全局-board-的三栏任务闭环)
- [Task 详情中的 Session Region 投影](#task-详情中的-session-region-投影)
- [Board 交接缺口的闭合](#board-交接缺口的闭合)
- [Agents、Session 与 Board 的全局入口](#agentssession-与-board-的全局入口)
- [Board Demand 与 Session 关联边界](#board-demand-与-session-关联边界)
- [Agents 看板与 Board 需求流转](#agents-看板与-board-需求流转)
- [Demand 命名合同](#demand-命名合同)
- [Demand 管理闭环](#demand-管理闭环)
- [Demand 的专属 PMO Tab](#demand-的专属-pmo-tab)

## Goals 的 Grill 与 Grounding

用户指出：「需求讨论的关键还是 grill 对齐目标，和 grounding 对齐结果，但是现在感觉看不出来，容易堆垃圾」，并认为「需求详情面板则更像是一个老旧的系统，非常糟糕，一点都不现代化，没必要的东西也都让用户自己填」。用户要求主要参考本地 Multica，做出更好的设计并彻底优化。Goals 必须让人首先看懂要达到什么、还有什么关键取舍、接下来该对齐目标还是核验结果；持续 Goal 与执行 Session/Run 的身份保持分离。

用户在实际更新后补充：「goals 面板有点看不懂了」。用户不应先学习 Grill、Grounding、Mote 或版本协议，才能使用目标工作面；这些方法和身份继续支撑行为，主界面用普通语言回答目标是什么、怎样算成功、还有什么待决定、已有结果怎样以及接下来可以做什么。

用户进一步明确主要困惑：「不知道该从哪里开始、下一步点什么」。每个阶段必须有可找到的真实入口，并让人预期点击后会打开原讨论、发送整理/核验请求，还是确认/接受所读内容；不能只替换方法名而仍让用户寻找入口。目标已确认而尚无结果时，原讨论是可继续推进的明确入口，已有的关联工作面也可达；结果检查留作有实际结果后主动请求的次级动作，不伪装成开始执行。

用户随后反馈：「已经全部优化完了? 感觉初始画面太差了, 是不是在顶部放一些 CTA ?」。初始入口仍需让人看懂从哪里开始；上一轮 Goals 流程与下一步的收尾不代表全部产品入口已优化。本轮在 Goals 入口实施用户随后确认的三句起步请求；调研、被否定文案与本轮实施范围见 Goals 起手入口 proposal（本机过程资料：`docs/plans/goals-entry-start-area-proposal.md`）。

用户进一步明确：CTA 必须点一下就发出请求、进入流程；零项目也能用「我有一些点子，我们开始尝试一个项目」，至少开启过项目时可用「根据最近的项目情况，建议我下一步应该做什么」。此前只强调 New Goal、点击后仍须填写再发送的起步方向已被替代。探索入口不要求先有 Goal、项目或具体点子，不先生成占位 Goal/项目；有项目的入口在点击前明确所依据的真实项目，没有可信项目上下文就不显示该条件入口。请求、发送目标和保留状态清楚可读；准备、入队和实际送达不能混称完成。一次在途点击不重复创建或投递，失败与未知保留原请求及已存在的工作面，原健康 Run、执行焦点和布局继续保留。起步探索与显式 New Goal 的草稿创建是不同动作，原人工确认/结果接受边界不变；具体上下文解析与工作面方案仍须经本轮设计评审。

用户此前补充：「这些默认的 CTA 包含一些普适的和一些和角色（学生、工程师……）有关的」，并给出零项目时的基本入口：「我还不知道能做什么，可以了解我并给我建议吗？」。用户随后评价上一批默认 CTA：「质量远远不如我跟你说的这些」。该批文案未获用户认可；这条反馈否定其质量，并未确认具体原因或替代文案。角色候选与文案审查保留为历史，当前范围以下述最新确认为准。

用户最新确认：「最后两个去掉吧，先实现前三个，我们把 CTA 的架子搭出来」。当前只实施「我还不知道能做什么，可以了解我并给我建议吗？」「我有一些点子，我们开始尝试一个项目」「根据最近的项目情况，建议我下一步应该做什么」三个入口，学生、工程师入口移出本轮范围，不要求角色档案或角色配置。首两条不要求已有 Goal、Project 或具体点子；第三条只在可靠 Project 上下文存在时可用，点击前可见准确项目名，所发送上下文与之为同一对象。只有 current 来源时明确称当前项目，不假称最近。可见完整句子就是首发消息，点击一次即发出请求并进入真实对话，不在短标签后藏另一套问卷或多阶段指令。了解用户从轻量对话开始，不先要求填写兴趣、技能或身份字段；后续目标讨论继续由原对话 owner 承担。一次在途请求、失败与未知保留、原健康 Run/焦点/布局以及不先造空 Goal/Project 继续沿上述合同；本轮已授权实施，精确陈列由实施设计评审收紧，不扩大为角色系统。

用户在三句起步入口落地后进一步反馈：「CTA 按钮在设计上太挫了，和设置页完全比不了」。初始页必须让人马上看懂从哪里开始；起步按钮的整体完成度至少与当前 Settings 的控件语言一致。此次独立改进闭环是已批准三句请求的可见品质：排版、主次、边界、操作反馈和宽窄窗口的可读性。三句范围、一键首发、可信项目／current-only、原对话 owner、失败与重启保全继续沿上述合同；具体视觉约束唯一见 surface-density[《Goals 的目标正文与对齐密度》](../presentation/goals-and-demand.md#goals-的目标正文与对齐密度)。

用户进一步反馈：「这个设计还是追不上设置界面，设置界面上是有图的，现在布局/设计不够现代，交互不够高级；应该包装成常用操作，也支持用户自定义一下，要不然 CTA 未来不好收」。Goals 的起步入口应成为可持续整理的常用操作：保留上述默认完整请求与可靠项目条件，支持用户以一句指令新增、引用已有指令、修改正文、排序、移出常用及收起更多操作。自定义正文仍由原 Settings Prompts 指令实体唯一持有，常用操作只持引用与排列/显隐；修改同一正文会影响其他使用入口，应清楚说明，移出常用不等于删除指令库内容。新增只需正文，名称可辅助生成，高级属性按需；管理编辑与排序不能发起 Agent。已展开或准备执行的完整正文在发送前可读，名称不能代替真实请求；一次点击发送所见正文并进入原对话，不暗附问卷、第二次提交或多阶段流程。适用 Agent 与实际匹配执行者必须诚实可见，实际执行者先沿本节主 Mote 原 bot 的已确认归属，符合指令适用范围时复用其真实配置；没有已知原 bot 时才沿既有启动选择规则，并明确显示实际名称；不匹配不静默代换。没有可用匹配执行者时管理仍可用、请求保持而不猜选。更多操作与模块本身可收起，返回、取消、移除及重排保留明确焦点，增加数量不能吞掉连续目标清单；不自动恢复已移除项或复活被删正文。视觉与图形角色唯一见 surface-density[《Goals 的目标正文与对齐密度》](../presentation/goals-and-demand.md#goals-的目标正文与对齐密度)，原 Mote、保存冲突、服务窗及健康工作面继续由既有 owner 承担。

用户报告从「我有一些点子」启动的 Mote 自己包办了非常细的设计，却没有主动推进项目建立、初始指令、Demand 绑定和执行 Agent 指派，并明确要求 Mote 可以持续讨论需求，同时在过程中能建立项目、绑定需求并指派执行者。这是实际行为反例；不以额外三次首回复实验作为记录前置。Mote 默认承担协调职责：意图或授权未明确时继续轻量讨论，不早建空项目/需求、不强制每轮创建；当一个可检验尝试、实际位置与授权足够时，先检查并复用已有项目和 Agent，需要新项目时建立真实目录及最小初始指令，通过原公开 owner 注册项目、建立或绑定 Demand，并把包含原意、真实上下文、交付与证据标准的任务实际投递给可用执行 Agent、记录同一真实 Session 关联。细设计和实现默认由执行 Agent 承担，Mote 继续讨论、组织、跟进与取证；用户明确要求亲自执行时按该授权。通用协调职责由 Mote 原署名启动 Notes 的单一 owner 持有，不能暗改可见 CTA 原句、只为某个按钮补隐藏流程、覆盖用户 SOUL/Wiki，或把普通 Topic/执行 Agent 改成协调者。项目注册不冒充目录/指令已创建，指派/记录/进程退出不冒充任务已送达或目标达成；用户仍决定目标与关键取舍，Grill/Grounding 的提案、人的确认及结果证据沿下述合同。能力、保存或投递未确认时保留讨论、实体及健康工作面，如实说明步骤，不能猜 API、身份或成功，也不能用直接配置写入代替未确认的公开能力。

本次协调职责必须在新讨论与复用已有 Goal 会话的实际请求中都可用，沿同一应用署名指令 owner，不只留在新会话启动时或要求用户重建 Mote。用户显式 New Goal 已保存的待定义实例应持续更新同一 Demand 的标题、原意与目标提案，不因「探索不早建空需求」拒绝该已存实例或另造一份。意图、实际位置和既有授权足够时，Mote 持续讨论并推进真实项目位置及初始指令、注册或复用、同一 Demand 绑定与其他执行 Agent 的实际任务；仅一轮 Grill 提案或自己包办细设计不算协调交付。公开帮助和实际请求应说明已支持的更新与发现、绑定、派发和回读入口，并按真实执行 owner 区分会启动/投递的 Desktop demand start 与仅写领域元数据的命令；一次未确认结果先读原回执与实体，不重复 create、start 或发送。用户的明确新建/实施授权与目标确认、结果接受仍是分别可读的事实，不借后两者反复索取已给的有限授权，也不替人认可。

真实行为取证进一步确认：公开帮助必须完整说明现有 Project 身份、需求写入的风险与授权参数及回执含义，不能让 Agent 按帮助仍无法完成已授权的项目/需求绑定。项目注册返回的 workspace 身份不能冒充 Project 身份，所绑定的 Project 必须来自当前公开发现事实；未知风险、待确认授权与用户已经给出的授权要清楚区分。补齐帮助不得放宽原风险/授权判据、替用户确认目标或接受结果，也不得靠隐藏 CTA 指令、直接配置写入或临时绕路弥补公开能力说明缺口。

用户在常用操作完成后要求：「这个完成后，对 goal 页面的成熟度打分，提升一轮成熟度和视觉效果，参考设置页面」。这是初始页、目标清单与目标详情的整页质量闭环；常用操作的局部验收继续保留其原范围。用户进入页面、打开一个目标及返回清单时，都能沿同一目标读懂当前事实、下一步和动作结果：清单结论在详情里有对应的正文与实际入口，打开目标、继续讨论、发出对齐/核验请求和人的认可各有清楚语义。当前工作状态、目标确认与结果接受仍沿下述同一 owner 和边界，既有未知、差距、旧报告与恢复动作继续可读。已有目标的阅读与探索入口保持主次，进入详情后的临时收纳与返回不改变用户常用目录、未保存正文、搜索/筛选、目标身份与原健康工作面；收纳后出现的新在途、未保存、失败或回执不明事实仍有可见摘要，并可回到保留原草稿的同一入口。确认前成功标准与真实未决问题保持展开可读，不能让人认可未读内容；关键决定尚未解决与可确认保持互斥的真实状态。成熟度以产品语义、视觉和交互分别按十分制说明具体问题及本轮改善，绑定实际观察范围和候选；评分是可复核的设计判断，当前安装、模型行为及未观察场景分别如实说明。视觉约束唯一归 surface-density[《Goals 的目标正文与对齐密度》](../presentation/goals-and-demand.md#goals-的目标正文与对齐密度)。

用户看到最新 Goals 页面后反馈「有点难看，而且浪费空间」。用户进一步明确最浪费的是「顶部常用操作区域」。这一轮优先减少该区无意义的占位，相邻清单与详情仅做同一工作面的有限对齐和边距：常用起步操作、目标扫描与正在阅读的正文各有明确主次，不因装饰、重复说明或固定空栏牺牲可见的目标与结果。保留三句原始一击即发请求及其可靠项目条件、同一常用操作指令与未保存草稿、搜索筛选和原目标选择；排列变化不增加提交、不自动发送、确认或接受，也不重建讨论、工作面或健康 Run。成功标准、重要未决问题、结果依据、差距、未知和认可回执不明仍沿本节真实人类确认边界可读可操作。具体密度、对齐与图形角色唯一见 surface-density[《Goals 的目标正文与对齐密度》](../presentation/goals-and-demand.md#goals-的目标正文与对齐密度)；本轮结果以实际宽窄整页中的阅读和操作改善说明，旧图通过或评分不代签这次反馈。

- **Project 关系沿同一真实身份**。Goals 的项目筛选、属性选择与明确创建/修改使用同一公开 Project 身份，不能把内部 Workspace 身份当成 Project。一个项目及其 worktree 只形成一个项目选项，跨 host 的同名路径保持不同身份。已绑定但当前无法找到的 Project 保留原 ID、已有名称及关系，并清楚说明暂不可用，不自动换绑、清空或显示成未分配；用户仍可明确改选或清除。结果的本地证据沿所绑定项目的真实 Workspace 与原文件打开入口定位，不解码 Project ID 猜目录、不越过原路径边界，也不改动已有执行 Session、确认/接受及健康工作面。Project/Workspace 分层与分组真值继续归[《Project 与 Workspace》](spaces-and-layout.md#project-与-workspace)。

- **显式新建直接开始目标讨论**。用户最新要求：「new goal出来那个对话框太难看，交互差，不如直接新建一个虚线边框的goal，直接打开一个pmo」。New Goal 一次明确点击就保存真实待定义的 Goal 草稿并进入它的专属 PMO，不再事前要求填写意图表单；这条最新方向替代此前「空白/取消不创建、先填再提交」的新建合同。草稿不虚构意图、完成标准或人的确认，以当前明确选择的真实 Project 作上下文，没有选择就保持未分配；普通常用探索 CTA 仍不先造 Goal/Project。讨论只整理和更新这同一个 Goal，不再创建第二个实例或项目，不启动目标的执行 Run。一次在途新建、短暂离开/返回及保存回执不明都保留原创建身份，不能重复造目标；只在 owner 已确认保存后进入 PMO，未知先读取同一目标。保存或 PMO 准备/投递失败就地说明实际失败步骤、已保留事实及恢复动作；已有 Goal、已建立的专属 Tab/launcher 和原请求保持，再试仍指向它们，不误称尚未建立的 Tab 已存在，也不停止健康 Run。优先级、日期、标签、批次、执行者与 Session 仍不是创建必填项。Agent 整理真实目标和标准，不虚构用户未表达的要求或查证不到的 Context，人工确认与结果接受继续沿原合同。

- **Goal 在主 Mote 中有专属 Tab**。用户进一步明确：「项目里有主 mote 的对吧? 我们创建 goal 的时候, 应该去主 mote 里创建 tab, 而不是创建一个新的 mote」。主 Mote 的固定默认身份唯一见[《Mote 头像与主 Mote》](motes-and-coordination.md#mote-头像与主-mote)；New Goal 在这同一个主 Mote 内建立该 Goal 的专属讨论 Tab，各 Goal 保持各自独立的 Agent 上下文，不能把新 Tab、Region 或 AgentSession 说成新 Mote。原主 Mote 名称、目录、SOUL、头像、Wiki 与资料保留，不按 Goal 或 Project 复制 Mote 实体或人格；Goal 所关联 Project 只提供该目标的真实上下文，不决定另一个主 Mote 身份。已有 Goal 继续指向原专属 Tab，重入、重试与重启先保留并恢复同一 Goal/Tab/Region/Session 关系，恢复未知沿原服务窗说明，不借其他 Goal 的讨论冒充恢复。 用户继续实际使用后指出 Goal 启动仍未复用主 bot，且 Agent 没有理解要更新 Demand、在合适的位置建立项目并让其他 Agent 执行；同一个 Mote 目录不足以证明已经复用主 bot。常用探索、New Goal 与已有 Goal 的讨论都归原主 Mote：探索只在其中建立独立讨论 Tab，不新建 Mote，不提前造空 Goal/Project；New Goal 和已有 Goal 沿各自专属 Tab 与同一 Goal ID。新讨论沿原明确目标及已知 bot 的真实 Executor/Provider 配置，保原名称、SOUL、Wiki 和资料，不因配置顺序、产品名或活动项目静默换一个 bot；既有映射的 Session 继续原上下文，不能以复用 bot 为由让不同 Goal 共用会话。明确指令的适用 Provider 限制仍成立，不匹配须可见，不另建每 Mote 偏好或身份名册。

已知主 bot 的事实尚未确认时，原主 Mote 的 launcher 内明确说明原 bot 未确认、请求未发送、完整草稿仍在同一 Region，以及手动选择 Agent 后启动的下一步。不能只把说明留在浮窗后，也不能把另一配置的默认选中态说成已复用原 bot；没有既有 bot 的首次选择和非主 Mote 的普通 launcher 沿各自原用途。已在运行的 Session 继续原上下文，不受新讨论的配置选择阻断。

同一浮窗内的主 Mote 卡片也沿已经保留的 Agent Region 表达事实：原 Agent 引用仍在、快照尚未确认时显示状态待确认，不能一边保原上下文、一边写「No Agent yet」。只有真正没有原 Agent 引用的冷启动才表示尚无 Agent；这条呈现不改变任何 Session、Run 或恢复动作。

用户同时反馈：「另外发给pmo的prompt，链接没有按项目设置，比如home path替换」。PMO 请求必须使用所关联的真实 Project 与具体 Workspace 的身份、Host 和路径；Project 身份、Workspace 身份和 PMO 自身运行目录不能混称。所见项目与发出的上下文一致，未知、已删除或来源含糊时如实说明，不猜另一项目；用户原文保持。尚未分配 Project 是正常目标状态，不冒充关联失败或要求重试；项目相对文件引用保持原文，不借 Scratch 或活动项目代替其根。已经分配但被删除、失效或含糊的实际 Project 关联仍诚实说明。项目文件引用按原宿主、路径及项目根边界解析，`~/` 只有获得该 Host 的真实 home 才能展开，本机 home 不代替远程事实。没有既有变量 owner 时不许诺通用模板替换，也不对正文盲目替换 home 字符串；具体用户坏链接仍需按实际原句核验，不把尚未查证的原因写成已修复。

- **Grill 对齐目标**。一个目标的当前 Grill 结果是可阅读的目标摘要、稳定身份的成功标准与少量真正影响选择的未决问题；用户看过当前内容后明确确认，不能用完整 transcript、空模板或系统属性替代目标协议。Agent 可以从对话提出和更新方案；用户只提供意图、关键取舍和确认，不承担整理成表单的工作。来源对话仍可追溯，当前目标正文不重复堆历史聊天。没有标准或尚有关键未决问题时，如实说明尚未对齐，仍可继续讨论和使用原执行工作面。
- **Grounding 对齐结果**。每条当前成功标准都能对照真实结果、可打开或定位的证据与差距。Agent 自报完成、命令成功、Session/Run 退出、已有 done 状态与证据数量都不等于目标达成。缺项、未知、失效版本和没有依据各自如实呈现；未知不画成通过。普通「接受结果」只面向当前已确认且非空的标准、完整的当前检查和有依据的结果。已核实的差距可以由用户明确选择「接受结果，保留差距」；差距保留为差距，不改写成全部达成。缺项、unknown、空标准或无依据不能用这条动作绕过核验。旧目标已有 done 但没有对齐或证据时，保留旧实体与状态，同时明示缺失事实，不能伪装成已经接受。
- **确认绑定用户看过的内容**。目标内容或标准发生语义变化后，旧确认失效，旧 Grounding 标明针对旧目标；结果提案变化后旧接受失效。同内容重报不产生新版本或清除有效确认。确认与接受必须核对当前目标版本及结果身份；并发替换后不得认可用户没看过的新提案。只有显式用户动作记录确认/接受，Agent 通用更新和 CLI 只能提交提案，不能自填认可时间或版本来冒充人已确认。认可时间与版本身份由 Demand owner 生成。
- **认可回执不明时先读当前事实**。确认或接受的保存回执不明时，唯一主要恢复入口是读取持久 owner 的当前提案；不能同时让正常确认、接受、保留差距接受或重试认可成为可操作捷径。清单与详情的当前下一步都指向读取当前提案；点击清单整行仍只打开 Goal，不直接读取或认可。读回后仍由用户看过当前内容再明确选择，不自动认可或读后重试。其他阶段动作不与恢复争抢主强调，讨论、核查请求与原工作面继续可用；目标、草稿和失败说明保留。回执不明不能被说成保存已失败或 Agent 已坏，也不依据错误文案猜分类。
- **少噪音、可收敛**。默认扫描当前目标的连续列表；可切换同一数据与筛选的横向看板，看板不能把状态列折成两层巨大空格。完成与取消按需查看，筛选可清除，选择和详情身份不因投影变化丢失。列表或卡片优先呈现目标、当前对齐事实和下一步；Project、执行状态等只表达真实次级事实。不保留一份左侧 Branch Board 清单再复制中心目标列表。
- **正文优先、属性渐进**。详情首屏是目标标题、意图/目标正文和 Grill/Grounding 的当前结论与明确动作。优先级、Project、负责人、标签、日期、父子关系、批次和关联 Session 继续可查看/编辑，但低频属性按需展开，空字段不制造填写义务；执行拓扑、活动和决策在相应区域可达，不挤成首屏系统字段墙。详情的视觉层级与密度只定义在密度 SSOT[《Goals 的目标正文与对齐密度》](../presentation/goals-and-demand.md#goals-的目标正文与对齐密度)。
- **普通语言说明当前事实与动作**。目标、成功标准、待决定事项和结果使用直接可懂的名称；Grill/Grounding 是整理与核验的方法，不作为阅读或操作的前置知识。尚无目标提案时，用户原始意图与一个澄清入口即可说明下一步，不把尚无提案、尚无结果画成两块失败区域；已有报告即使目标提案缺失仍可阅读材料，并明确无法按当前目标接受。目标已确认但尚无结果报告时，说明目标已达成共识、仍可继续当前工作，有实际结果后再对照标准核验；不能从确认推断工作已经完成，也不能把结果未提交说成失败。工作状态已是 done 但没有报告时，无论目标是否已确认都明确结果尚未核验。已有结果的差距、未知、缺项和旧版事实保持直接可见。
- **工作状态、人的认可与执行事实各有名称**。Backlog/Todo/Done 等是可编辑的工作状态，不代表当前目标已确认或结果已接受；默认清单优先一个当前待办或结论，工作状态在看板、筛选与属性中明确可达。正常阅读不要求比对版本号；只有目标变化、并发拒绝或查看历史时才需要解释版本所影响的内容。版本和结果身份仍由原 owner 持有，确认与接受仍精确绑定用户看过的内容。打开已有讨论与发送澄清/核验请求必须明确区分；简化文案不能把未投递说成已执行，也不能把澄清动作包装成开始执行。
- **对话入口必须真实送达目标上下文**。Grill 与 Grounding 都复用该 Goal 专属 Mote/PMO 工作面，携带当前意图、目标版本、标准及相关结果。已有 Agent 时也必须通过既有公开输入/队列入口提交本次真实指令；只打开旧 Tab 或改按钮文案不算进入对齐流程。没有收到、正在等待或投递未知时明示事实，不虚构 Agent 已整理。跨面切换、Mote 打开/关闭和重启继续沿既有 durable Tab/Region/Session 恢复约束。

默认 Goals 扫描和详情的工作量随当前可见目标、实际关联 Session 和相关新事实增长；不为每张目标挂载完整终端/拓扑，不因无关 Run 输出重算全部目标或重挂载原工作面。相关消费者成本与连续阅读的 P0 边界继续归[《Terminal 连续向上阅读历史》](terminal-reading.md#terminal-连续向上阅读历史)，本轮只验证新增表面的放大边界。

Grill/Grounding 的领域事实属于独立 Demand 文件系统包，同一份公开 API/CLI、Main 与 Renderer 投影可读；UI 只持有草稿和展示状态。Provider 与 Core/ctxmux 的生命周期事实保持原 owner，Goals 不新增第二套 Runtime、流程引擎或转录库。本轮不扩展复杂任务依赖、自定义字段、甘特图、自动审批或自动结果验收。

## Agents / Session / Board 与注意力闭环

- 主导航的入口、顺序、位置和名称见[《左下角导航、Space 与 Goals》](spaces-and-layout.md#左下角导航space-与-goals)；顶行不重复平级导航，Session 表示工作面中的 Agent/Terminal 生命周期。
- Agents 是全局注意力收件箱：先显示 Needs you，再显示工作中、已完成和错误的 Agent；卡片选中后在同屏右侧显示该 Session 的观察工作区，明确的“打开 Session”动作才导航到原工作台。Needs you 的 typed request 从同一详情区进入既有回答面板，不能在这里复制一份 Session 或 Runtime 状态。
- Session 是具体 Agent Session 的 terminal/workbench；Agent 的请求、回复和恢复动作在同一 Session 内完成，处理后仍留在原 Session。
- Board 的主实体是 Demand。Demand 卡片第一层显示 Demand ID、Project 和状态，关联 Session 只作为执行事实；没有选中 Demand 时不渲染 DemandWorkspace，也不保留空右栏。
- 一个决定完成后，Agents 面要能把用户带到同一 Session 的结果审查入口：已有 Diff 或 Browser preview 可直接打开，缺少结果时明确显示“等待结果”，不得用猜测替代 Runtime 事实。
- 单工作面保持连续全宽。只有真实存在多个 Region 时才使用 arrangement；不能因为没有详情而把内容视觉上推到左侧、保留空右栏或播放方向性重排动画。
- 进程重启先恢复 durable 的面、Tab、Region 与焦点，再尝试 reattach/resume Session。恢复探测、握手或 Provider 流程失败时保留原工作面并显示服务窗提醒；只有 Core 的终局事实允许移除投影。

## Board 与 Settings

- Board 是 `行 × Inbox/Working/Needs You/Done` 的二维矩阵。状态变化只在同一行内移动。
- **行的身份取决于 Workspace 是什么，不是另一种 Board**。Git 项目的行是 Branch/Worktree；Scratch 的行是 Topic。两者共用同一套列、同一套状态归类、同一个 Inbox 语义——**一个 Board 组件按行来源参数化，不是两个 Board**。理由与 `Files + Branches` / `Files + Topics` 同源：Topic 与 Branch 都是"一条并行的工作线"，只是承载物一个是 worktree、一个是 topic 目录。为 Topic 复制一份 Board 会让状态归类、列定义、Inbox 入口各出现第二份，日后必然漂移。
- **Topic 与 Branch 一样有 Inbox**。Inbox 是矩阵第一列和带上下文的创建入口，不是 Tools 中的重复页面——Branch Inbox 带 Branch 上下文，Topic Inbox 带 Topic 上下文，走同一个创建路径。
- **Board 工具的次级面板是工作清单，不是说明页**。它列出当前 Board 的行与行内 Agent，可展开、可点击定位——用户来这里是找一条具体的工作线，不是读一段介绍 Board 是什么的文案。图例式的静态说明只在没有任何行时作为空态出现。清单的行与 Agent 状态点复用共享状态语汇，不发明第二套。**行必须与 Board 主视图同源**：一份行来源分叉（Scratch 出 Topic 行、Git 项目出 Branch 行）、一份排序，由 `useBoardRows` 持有，两处都调它。让面板自己再查一遍 topics/branches，就等于给"这个 Board 有哪些行"开第二份答案——两处会在筛选、排序、加载时序上各自漂移，而漂移时谁都不会响。行数超出时其余折叠为可展开的一条，不无限撑长也不截断丢弃。守护：`surface-tool-dock.test.tsx`。
- Settings 的分区、主次与默认入口统一归[《设置页的信息架构》](settings-and-observation.md#设置页的信息架构)，不在此另设资源优先顺序。
- **Settings 是一个控制工作面，不是卡片墙。** 左侧只承担搜索和分区导航，条目保持单行、标题优先；当前分区的说明只在主区头部出现一次。主区先给出当前上下文和可用动作，再进入设置内容，避免同一标题/描述在侧栏和正文重复。
- **可操作内容与只读说明分层。** 能修改配置的区块使用抬起的 Surface；运行时说明、来源和隐私提示落在页面底色上，用留白和发丝线分隔，不使用装饰性品牌图标格伪装成主操作。
- Settings 的关闭动作始终可见；Escape 先清搜索，再关闭。窄窗口必须完整发现全部分区并用键盘选择，不能依赖用户发现屏外的横向条目，也不能牺牲正文与保存区。
- Agent Detection 以 Host 为键，由 Core discovery 统一投影到 Settings、Launcher 和状态面。
- 资源检索、常用/高级配置与身份约束统一归[《设置页的信息架构》](settings-and-observation.md#设置页的信息架构)。

## Demand 文件事实与独立包

Demand 是与 Project、Session 平级的长期产品事实，不属于 Core 的 Agent Runtime，也不属于 Desktop Store 的临时 UI 状态。Demand 管理能力放在一个与 `packages/core` 平行的独立包中，包同时提供宿主无关的 TypeScript API 与 CLI；它以文件系统作为唯一持久化事实，负责 Demand 的创建、读取、状态流转、关联 Project / Session / Attempt、索引和原子写入。

Leader Topic 默认通过该包的 CLI/API 访问 Demand。Leader Topic 可以分析、建议和提交 Demand，但不能在 Topic 目录或 Renderer 中另存一套任务记录；Board 读取同一份文件事实并投影状态。Core 继续只拥有 Provider、Session、Run、PTY 和 ordered bytes 的生命周期事实，Demand 包不得启动或管理 Agent 进程。

Demand 包的文件格式、锁、原子替换、损坏恢复和 CLI 输出协议必须独立可测试，未来其他 Client 也能在不依赖 Electron、React 或 AgentMux Desktop 的情况下使用。Demand 与 Session 的关联保存稳定 ID 和可验证引用；不存在的 Session 只能显示为历史关联或 unknown，不能伪造成当前运行状态。

## Demand 的完整业务闭环

Demand 不能只是一张标题卡。完整闭环至少包括四条可从 UI 和 CUI 重放的流程：

1. **提出需求**：用户显式点击 `New Goal` 直接保存待定义 Goal 并进入同一目标的专属 Mote 讨论；创建、Grill 确认与 Grounding 接受边界唯一见[《Goals 的 Grill 与 Grounding》](#goals-的-grill-与-grounding)。常用探索仍从原对话开始，不先生成 Goal/Project，不要求用户补全系统属性才能开始。
2. **分配执行上下文**：用户或 Leader Agent 从可见 Project/活跃 Agent 摘要中选择目标 Project，并把零个、一个或多个已有 Session 关联到 Demand；Project 归属和 Session 关联是两个独立动作，不能用当前选中 Session 猜测。
3. **管理与推进**：Board 详情可以编辑标题、描述、优先级、状态、Project、Executor 和 Session 关联，能查看 Activity/Decision receipt；删除 Demand 是显式、可确认、可审计的动作，删除不能删掉 Session 或 Project。
4. **恢复与审计**：重启或 CLI 跨进程读取后，Demand、描述、Project、状态、Session IDs 和 receipt 仍一致；文件/Runtime 查询失败时保留已读内容并显示服务窗，不把 Demand 变成空卡。

Demand 卡片的执行摘要必须能读出实际工作拓扑：关联 Agent 的 Topic/Branch 上下文、所有打开的 Tab、每个 Tab 的分栏/Region，以及每个分栏当前运行的 Agent。不能只显示“n 个 Session”后要求用户再去猜 Session 在哪个工作面；没有 Tab、分栏或 Agent 时明确显示缺失事实。该拓扑摘要由统一的可复用组件提供，Demand、Agents、Session 和详情面板只传入投影数据，不各自重建一套卡片结构。

UI 和 CUI 必须共享同一组语义动作：`demand.list/show/create/update/delete/link-project/unlink-project/link-session/unlink-session/decision-log/activity`。UI 不得拥有 CUI 没有的第二套写入逻辑；CUI 也不能绕过 UI 使用的确认、稳定 ID、权限和 receipt 约束。

## 全局 Board 的成熟产品界面

全局 Board 是长期工作的产品界面，不是介绍概念的落地页。首屏不放营销式大标题、说明性 hero 或为了展示原型而存在的页面分组；用户进入后直接看到任务工作面、筛选和当前选择。任务总览、Task Inspector 和 Default Session 是同一工作流中的状态，不在页面底部另造一组“01/02/03”导航。

顶部只保留全局范围、搜索/筛选、Board 操作和默认 Session 入口。按钮优先使用紧凑的图标按钮、文字图标组合和分段控件；只有创建、确认、进入项目等明确动作使用文字按钮。任何分组都必须回答一个稳定的问题（任务状态、当前选择、执行来源或下一步），不能用装饰性卡片、彩色边框或标题制造层级。

Board 的第一视觉层是任务卡和任务状态，第二层是 Project、优先级、下一步和执行事实。卡片使用中性 Surface、细分隔线和单一选中信号；颜色只表示状态或 Project 身份，不作为大面积渐变、发光边框或装饰性线框。Default Session 以可收纳的工作面/浮窗出现，Task Inspector 以 Board 内的右侧面板出现；二者不占用独立的演示页。

选中 Task、展开详情或查看 Session Region 都不能改变当前页面路由；Board 保持可见，右侧 drawer 只更新当前 Task 的投影。Session Region 必须复用当前 Agent 会话的既有承载方式和生命周期事实，不能把一个 Session 拆成新的页面、第二个终端或第二个 Agent surface。详情里的 Region 只做同一 Session 的观察投影，需要输入、编辑或调整终端尺寸时，用户显式进入原工作面并交还唯一控制权。

这里的“右侧 drawer”在产品实现上是 Board 同屏的右半边 Task 工作区，不是覆盖在 Board 上方的弹层。Task 工作区占用稳定的右侧面，中心区域直接承载多个 Session Region 和对应 terminal；左侧仍保留任务列和当前筛选。关闭 Task 工作区只恢复 Board 宽度，不改变页面路由或创建新页面。

默认 Session 的浮动入口打开的是默认 Topic 的原生 Tab/Region 工作面，不打开一套独立的聊天产品。Topic 的 tab、region、Agent 身份、输出面和 composer 沿用 AgentMux 现有工作台；Task 草案、确认策略和知识库回执只作为工作面中的轻量状态行或原生消息出现。用户需要输入时直接使用同一个 Session 的 composer，不能再叠加一层自定义对话 header、消息卡和人工确认流程。

每个 Topic 都支持一份可编辑的 Wiki 注入，注入属于 Topic 的知识边界，不属于 Provider、Executor 或某个临时 Session。Topic 打开时，Core/Client 按稳定版本加载该 Wiki 注入并向 Agent 明示来源和版本；编辑、启用、停用和恢复都写入 Topic 的持久状态，重启后仍然可见。注入内容和工作区文件、Agent 对话、全局决策知识库分开显示，不能把一段聊天默认为 Wiki。

默认 Topic 自带一份默认注入，至少说明：如何使用 AgentMux 的 Project、Workspace、Branch/Topic、Session、Task、Attempt 和 ctxmux 能力；如何依据项目目录、Topic 关联和历史决策判断需求应落在哪个 Project；何时把相近需求合并到已有 Task，何时拆成独立 Task；哪些信息不足时必须先追问用户；哪些写入操作需要遵守当前确认策略。默认注入是可查看、可编辑、可恢复的 Wiki 初始内容，不是不可见的系统提示。

Topic 注入的优先级必须可解释：平台安全与运行时事实高于 Topic Wiki，用户当前指令高于默认建议，权威 Project/Task 状态高于历史推断。Wiki 可以提供规则和例子，不能伪造 Session、Run、Project 或 Task 事实；当注入和权威状态冲突时，Agent 必须说明冲突并追问或降级为待确认，而不是默默覆盖事实。

## 全局 Board 的三栏任务闭环

全局 Board 是一个完整的任务界面，不是 Agents 面板的放大版。中间是按少量稳定 Task 状态组织的任务卡，右侧是当前任务的固定详情面板；左侧“来源与依据”不是默认常驻栏，只在选中任务确实有来源、路由依据、外部引用、待确认项或用户主动打开时按需出现。人工批注仅在用户主动添加时进入该范围。点击任务卡只更新右侧详情，不离开 Board 总览；右侧至少能在同一任务上下文中切换详情、文件、变更、Activity 和 Agent 对话。

任务卡优先表达任务结果和归属：稳定 Task ID、标题、目标 Project、状态、优先级/标签、更新时间和进度可快速扫描；多个 Attempt、Agent Session、Agent 活动和关联 Task 聚合在卡片或详情内，不把 Session 复制成多条主卡。复杂的 running、needs-user、blocked、停止原因等执行语义属于 Attempt/Session 事实，在卡片内以来源明确的次级信息表达。

看板顶部提供全局筛选和搜索，至少能按 Project、Task 状态、优先级、标签、Agent/Session 和归档状态切片；当前筛选可复制或由 CLI 重现。看板负责计划、分拣和预览，工作台负责完整编辑与执行；只读或预览能力的边界必须在入口附近说明，不能让用户误以为看板中的文本编辑已经写入项目。

默认 Session 创建或更新任务后，任务卡和右侧详情必须能即时显示分析依据、目标 Project、创建的 Task 以及关联 Attempt/Session。来源与依据抽屉中的原始需求、路由理由、引用对象和待确认项都锚定任务；完整评论和 Agent Activity 留在右侧，不能让需求分析漂移成无法定位的全局聊天。

编排调度 Agent 与执行任务的 Agent 使用不同的展开语义。编排 Agent 是全局入口，保持浮窗对话；它创建或更新任务后只在对话中给出可点击的 Task receipt，不把整段编排对话塞进任务详情。任务有正在执行的 Agent 时，点击任务默认在右侧打开任务执行面板，展示 Attempt、Agent Activity、最近对话和下一步动作，同时保留 Board 上下文。只有用户明确选择“进入工作台／打开 Agent 所在项目”时，才跳转到对应 Project、Workspace、Branch/Topic 和 Session；查看执行进度不能隐式改变当前工作面。

任务执行面板在没有可达 Workspace、Session 恢复未知或目标存在歧义时仍保留任务事实和失败步骤，并提供显式恢复/定位动作；不能因为跳转流程失败而清空详情或删除任务。

## Task 详情中的 Session Region 投影

Task 关联一个或多个具体 Agent Session 时，选中 Task 在右侧打开同一批 Session 的 Region 投影。一个 Session 使用一个 Region；多个 Session 使用现有的分屏/网格 arrangement 原语自动排布，用户可以在详情面板内切换已支持的排列方式。这个 arrangement 是 Task 详情的临时投影，不修改任何 Project 的持久 Tab/Region 布局，也不创建新的 Agent Session。

每个投影 Region 都显示稳定的 Project、Workspace、Branch/Topic 和 Session 身份，并提供明确的“进入项目/打开工作台”动作。该动作按精确 Session 与 Project 上下文聚焦或打开原有工作面；不能根据当前焦点、最近顺序或终端标题猜目标。返回 Board 时保留原 Task 选中状态和详情位置。

投影 Region 复用既有 Session/Terminal/Agent surface 和 ctxmux Run 的观察事实。渲染投影可以建立额外的 attachment lease，但底层 Run、PTY、ordered bytes、Replay、Gap 和输入/生命周期 owner 只有一份；不能为详情面板启动第二个进程、复制一份终端缓冲或让 Renderer 自己重建 ctxmux 事实。

Task 详情中的 Session 默认是观察投影：可以查看实时输出、Activity、状态和可归属的控制动作；PTY 输入、编辑器写入和终端尺寸控制仍由原工作台拥有。若未来允许在投影中接管交互，必须显式转移唯一交互 owner，并在原工作台留下清晰的控制权变化；多个 Region 不能同时争夺同一个 Run 的输入或尺寸。

## Board 交接缺口的闭合

- Task 中的观察 Region 必须同时禁止 PTY 输入、Agent composer 发送、生命周期修改和主动尺寸控制；只禁止 resize 不构成观察模式。进入项目仍定位原 Session。
- Topic Wiki 的启用状态、内容版本和更新时间必须可见且可持久恢复；禁用不注入，恢复默认不重建 Topic 或 Session。Wiki 注入明示来源和版本，并服从用户当前指令与 Runtime 权威事实。
- Board 暂时缺少 Session 快照时仍保留选择和关联身份，区分“尚未恢复”和“从未关联”；不能在加载阶段清除用户工作面。
- 本轮交付包含真实安装包、安装重启和恢复验证。未通过对照的 Runtime 升级不能捆绑进入正常产品安装。

## Agents、Session 与 Board 的全局入口

- 当前产品明确区分三种全局工作面：**Agents** 展示 Agent/Executor 的聚合与状态，**Session** 展示具体会话与它们的上下文，**Board** 展示 Demand 计划与执行关联。Demand 卡不能因为带有 Session 就改名成 Agent，Session 也不能作为 Board 的隐含主实体。
- 三种工作面使用同一组全局切换入口，切换只改变中心工作面的投影，不改变当前 Project、Workspace 或 Session 的持久身份。主切换的位置归[《左下角导航、Space 与 Goals》](spaces-and-layout.md#左下角导航space-与-goals)；右上角不再放一套平级导航。 这条约束同样覆盖 Session 的单 Tab Group 标签栏与多 Tab Group 分屏顶栏，两者都不得再渲染主视图切换。
- Board 选中 Demand 后可以在右侧展开关联 Session Region；这只是 Demand 的执行投影。Agents 与 Session 选中对象的详情沿用同一右侧工作区语义，不能通过“把右面板搬到左面板”来表达未分屏状态。
- 没有分屏时，左右栏只表达真实存在的内容：没有右侧详情就保持主工作面全宽，不能把右侧内容视觉上推到左侧或反向滑入，造成方向与焦点错觉。分屏布局只在存在两个可见 Region 时启用对应的 arrangement。
- 切换入口必须可键盘操作、保留当前选中项和可恢复焦点；重启恢复后先恢复三种工作面的选择，再尝试恢复其中引用的 Session/Demand 投影。

## Board Demand 与 Session 关联边界

- Board 的主实体是 Demand。Demand 可以在没有任何 Session 时创建和持久存在，也可以关联多个 Session；Session 只是 Demand 的执行上下文，不是 Demand 卡片的身份。
- 没有显式关联的 Session 不得自动生成 `session:*` Board 卡片。Agents 和 Session 工作面负责展示这些 Session；Board 只展示持久化 Demand。
- Demand 详情显示零个、一个或多个关联 Session。Session 暂时不可见时保留 Demand 和关联 ID，区分“尚未恢复”和“从未关联”，不能把 Demand 降级成 Session 卡片。

## Agents 看板与 Board 需求流转

- 用户确认「把 board 的设计照搬替换掉 Agents，同时 board 先照抄 multica 的业务逻辑」。Agents 使用原 Board 的紧凑工具栏、卡片、状态列和同屏右侧会话工作区，替换简单列表；主实体是 Agent Session，按 Needs you、Working、Results、Error 展示，普通终端归 Session。
- Agents 卡片换成 Board 语言后，注意力动作仍然必须在同一张卡片的工作区内可达：选中 Needs you 的 Agent 后，固定详情区提供“在这里查看请求”；typed request 由同一个 Session 身份交给既有交互卡和 Core respond API。没有 typed request 时只能提供“打开 Session”定位动作，不能伪造回答控件。卡片、详情和请求面板都不得复制 Session、Run 或 pending request 真相。
- Board 是与 Project、Session 平级的最高级全局工作面；进入 Board 时 Project Rail 被工作面覆盖，不显示左侧 Project 导航。Board 内主实体不是泛意义的 task，而是 Demand（需求），按 Backlog、Todo、In progress、In review、Blocked、Done、Cancelled 流转。状态由显式操作维护，不从 Session 是否需要我、退出或报错推断完成。负责人、Project、优先级、描述与活动记录属于 Demand；负责人可以未分配，分配 Executor 与关联 Session 是不同操作。
- Backlog 可以先指定负责人而不启动；用户明确执行需求时通过既有 Core 启动路径创建并关联 Session，每次执行保留关联，失败保留需求与说明。需求可编辑、跨列流转、评论、关联或解除关联已有 Session，重启后仍成立。
- Demand 可以在没有 Session 时创建和持久存在，也可以关联多个 Session。没有显式关联的 Session 不自动生成 Board 卡片。快照缺失保留 Demand、关联 ID 与当前选择，并区分尚未恢复和从未关联。

## Demand 命名合同

- Board 领域的代码名称统一使用 `Demand`：持久化字段、类型、选择器、组件、文件名和控制协议都以 `demand` 表达。Board 的 `Task` 只保留在泛义任务或其他独立领域的上下文中。
- Demand 的控制操作使用 `demand.*`，请求与回执使用 `demandId`、`demands` 和 `demand`；CLI 入口使用 `agentmux demand`。不保留同一语义的 `task.*` 别名或兼容层，避免代码和用户模型继续把需求误读成 Session 任务。

- **Terminal 中的系统文件路径必须保持系统文件语义。** 终端输出的工作区内 `.app`、`.dmg`、`.pkg`、`.exe`、`.msi`、`.deb`、`.rpm`、`.AppImage` 与常见压缩包等可由系统处理的文件，点击后交给当前操作系统打开，不得误送进编辑器或 Browser Tab。路径仍必须先经过既有 Workspace 根约束；远端 Workspace 没有本机系统打开出口，因此只提供可用的文件管理器揭示能力，不能画一个点击后必然失败的假按钮。
- **终端路径的右键菜单要回答“去哪里找它”。** 指针停在已识别的文件路径上时，右键菜单提供平台对应的 `Reveal in Finder`、`Reveal in File Explorer` 或 `Reveal in File Manager`；系统可处理的文件额外提供打开动作。右键普通输出、拖选文本或无法归一化的路径不显示这些动作。揭示和打开都复用 Main 的 Workspace 文件安全边界，不能把绝对路径直接从 Renderer 交给系统。
- **文件路径和 HTTP 链接是两条不同的出口。** HTTP(S) 仍进入 Browser 的目的地选择；只有归一化成功的本地 Workspace 文件路径才进入系统文件动作。系统动作失败必须以可读错误浮现，不能静默退回编辑器 Tab。

## Demand 管理闭环

Demand 保留目标、背景、验收、负责人、状态和讨论；每次 Agent 执行、失败、重试或取消作为独立的 Demand 工作记录和既有 Session/Run 事实挂在 Demand 上。执行结束不能直接推断 Demand 完成，`done` 由显式确认或明确的外部事实推进。

Demand 需要同时支持未分配、只分配不启动、明确开始执行和重新分配。负责人（谁跟进）与 Project（共享目标和资源）与 Session（一次执行上下文）是三个独立关系；一个 Demand 可以没有 Session，也可以有多个 Session，改负责人或状态不会隐式停止已经开始的 Session。`backlog` 只表示暂不启动，离开它时才出现是否开始的明确动作。

Demand 详情与卡片共享同一组可编辑属性：标题、描述、状态、优先级、Project、负责人、标签、计划起止日期、父 Demand/推进批次和活动记录。父子 Demand 的状态不互相伪造；推进批次只用于解释一批子 Demand 的推进。活动、决策、评论和执行日志按来源区分，并在详情内按时间顺序可追踪。

Board 必须有一个可恢复的路由队列入口，用于查看无 Project、无负责人、未确认或需要用户处理的 Demand；路由队列不改变 Demand 的生命周期状态。顶部搜索、状态、Project、负责人、优先级、标签、日期和 Session/Agent 筛选作用于同一批 Demand，当前筛选可以清除、复制或由 CUI 重放。看板、列表或表格只是同一 Demand 集合的不同投影，不得各自维护数据。

Demand 卡只展示足以扫描和路由的摘要：稳定 ID、标题、状态、优先级、Project/负责人、标签、日期、子 Demand 进度和关联 Session/Agent 摘要。完整描述、活动、决策、评论、执行日志、重试/停止和删除确认在固定详情工作区中完成；删除是明确的危险动作，取消优先于删除以保留历史。AgentMux 的 Demand 文件系统包、Core Runtime 和 ctxmux 事实边界保持不变。
> 命名更新：历史讨论中的 “Leader Topic” 与 “PMO Teams Topic” 现称 **Mote**；PMO 仍表达默认协调角色，其固定身份、快捷面和职责约束继续有效。

## Demand 的专属 PMO Tab

- Board 的 `New Demand` 每次都创建一个新的 PMO Teams Tab，并为该 Tab 启动一个全新的 PMO Agent 上下文。不同 Demand 不能共享同一个 PMO 对话来澄清、分配或跟进，避免上下文串线。
- Demand 与专属 PMO Tab 的绑定是可恢复的编辑器投影。Demand 文件仍只保存 Demand 领域事实；绑定关系和 Tab/Region 继续由编辑器工作面状态持久化，重启后先恢复原 Tab，再尝试恢复其中的 Session。
- Demand 详情必须提供明确的“打开 PMO”动作。点击后打开 PMO Teams 浮窗并聚焦该 Demand 的专属 Tab；如果原 Tab 已被关闭或不可恢复，动作先为该 Demand 建立新的专属 PMO Tab，再打开它，不能悄悄切到另一个 Demand 的上下文。
- New Demand 的初始提示词必须带上稳定 Demand ID、标题、描述和当前路由事实，并明确 PMO 只负责澄清、分配和跟进，不直接冒充执行 Agent。PMO 对话创建 Demand 的路径仍由 PMO 自己决定是否写入，不因为专属 Tab 规则自动新建空 Demand。
- New Demand 打开的浮窗如果带有明确目标 Tab，浮窗只能等待并展示这张 Tab 的 Agent；目标 Agent 尚未挂上时不能先展示旧 PMO Session，也不能在目标标记清除后回退到其他 Demand 的 PMO。

### Goal 与原持续推进的连接

确认的 Goal 可以由明确关联的准确执行 Session 持续推进。原 `goal.start` 通过可选 continuation 授权绑定已确认 alignment revision 与同一业务 operationId；未提供 continuation 仍是原有限开始。原 `goal.inspect` 按该 Goal 投影原续跑 Manager 的准确目标、状态与原操作回执，读不创建调度或复制 Goal 账本。原 `goal.continuation-action` 以准确 Goal/loop、预期 revision 与业务 operationId 沿同一 Manager 执行暂停、恢复、停止或检查；普通日历 `schedule.*` 不承载 interval 续跑。RPC/CLI/GUI 与连接设备对同一操作、版本和结果使用一致语义。

Goal 完成/取消仅停止相应 loop；blocked、待决定、确认失效或读取未知暂停自动动作并保留健康 Agent。loop 与 Goal grounding 的人类接受各自成立，自动推进不替用户确认目标、接受成果或宣告成功。交互与 Mote 入口唯一见[《目标、持续推进与成果回报》](motes-and-coordination.md#目标持续推进与成果回报)。
