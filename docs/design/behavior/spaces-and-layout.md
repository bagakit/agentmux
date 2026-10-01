# 空间、导航与工作面

本文集中本主题的交互与行为要求。已确认约束定义必须成立的结果，不代表当前实现通过验收；提案、历史与当轮授权状态按正文的明确范围阅读。

[返回交互合同](../agentmux-desktop-interaction.md) · [同主题视觉](../presentation/spaces-and-layout.md)

**本页章节**

- [左下角导航、Space 与 Goals](#左下角导航space-与-goals)
- [Zone→Tabs→Regions 的实体与展示绑定](#zonetabsregions-的实体与展示绑定)
- [Survey、临时 Zone 工作面与知识入口](#survey临时-zone-工作面与知识入口)
- [Topic 点击必须打开可见 Tabs](#topic-点击必须打开可见-tabs)
- [Scratch Topic 首次打开必须有可用 Terminal](#scratch-topic-首次打开必须有可用-terminal)
- [Scratch 的交互与组织](#scratch-的交互与组织)
- [Agent Region 关闭与身份入口](#agent-region-关闭与身份入口)
- [统一概念与空间寻址](#统一概念与空间寻址)
- [Space、Folder 与 Topic](#spacefolder-与-topic)
- [Project 与 Workspace](#project-与-workspace)
- [Agent 自助创建与空间操作](#agent-自助创建与空间操作)
- [少一步操作](#少一步操作)
- [Tab、Tab Group 与 Region](#tabtab-group-与-region)
- [单格临时铺满 Tab 后还原](#单格临时铺满-tab-后还原)
- [寻址与复制](#寻址与复制)
- [顶部与项目栏](#顶部与项目栏)
- [Tab 与 Pane](#tab-与-pane)
- [显示名与身份](#显示名与身份)
- [Projects 结构与状态可读性](#projects-结构与状态可读性)
- [Projects 状态与 Activity 菜单](#projects-状态与-activity-菜单)
- [Region 移位入口](#region-移位入口)
- [控件说明与对话完整性](#控件说明与对话完整性)
- [Project Rail、通知与 Topic presence](#project-rail通知与-topic-presence)
- [Topic 行的 Region 与 Agent 在场状态](#topic-行的-region-与-agent-在场状态)
- [Topic topology 的计数与浮层边界](#topic-topology-的计数与浮层边界)
- [Scratch Topic 打开后的工作面渲染](#scratch-topic-打开后的工作面渲染)
- [Topic Workbench topology 的可读层级](#topic-workbench-topology-的可读层级)
- [Topic topology 的 Tab 缩略图语言](#topic-topology-的-tab-缩略图语言)
- [Topic Tab 图标簇的交互](#topic-tab-图标簇的交互)
- [Topic Tab 缩略图导航与 hover 结构](#topic-tab-缩略图导航与-hover-结构)
- [全局工作面顶栏与名称](#全局工作面顶栏与名称)
- [浮层让位默认成立，而不是逐个接线](#浮层让位默认成立而不是逐个接线)
- [Topic 默认终端与可发现关闭](#topic-默认终端与可发现关闭)
- [初始 Launcher：紧凑、可定制的工作起点](#初始-launcher紧凑可定制的工作起点)

## 左下角导航、Space 与 Goals

用户确认：「把这一排页签切换的按钮改成这个顺序，然后把它们放到最左下角」。窗口只有一组主导航，固定顺序为 **Mote、Space、Focus、Goals、Survey**，在所有主工作面及 Project Rail 开合状态下都位于窗口左下角。Survey 的职责和 Browser 入口归属见[《Survey、临时 Zone 工作面与知识入口》](#survey临时-zone-工作面与知识入口)。

- **Mote** 是固定协调对象的快捷入口：打开或收起同一快捷面，保留当前主工作面的选中状态和执行焦点。Mote 排第一不意味着启动默认进入 Mote；启动仍恢复用户上一次工作面。PMO 是其初始化默认角色之一，产品身份见[《Space、Folder 与 Topic》](#spacefolder-与-topic)。
- **Space** 是实际工作现场，承载既有 Agent、Terminal、文件、Browser、Tab 与 Region；顶级入口、说明和可访问名称使用 Space。Space 作为更外层产品对象及其 Folder/Topic 两类定义见[《Space、Folder 与 Topic》](#spacefolder-与-topic)；Workspace 继续表达底层工作区对象。
- **Focus** 查看执行状态、最近上下文与需要用户处理的事项；进入已有 Session 时继续复用原 Tab/Region。
- **Goals** 是全局目标集合，单项显示为 Goal。标题、创建、搜索、详情、清单和统计使用同一名称；显式创建后记录真实 Goal 草稿，待澄清的想法由 Mote 整理目标与完成标准，具体闭环见[《Goals 的 Grill 与 Grounding》](goals-and-demand.md#goals-的-grill-与-grounding)。Goal 沿用原 Demand 的持久身份；原内部类型与存储名称不改变公开 Goal 词汇，Goal 状态与执行 Session 状态独立。
- **Survey** 先提供日常浏览，再承载明确创建的研究及成果整理；入口资格、与项目 Browser 的区分及到 Topic 的流转只见[《Survey、临时 Zone 工作面与知识入口》](#survey临时-zone-工作面与知识入口)。

PMO 作为独立协调入口，和 Space、Focus、Goals、Survey 的工作/功能导航分开；Settings 打开既有设置面，不改变当前工作面选中状态和执行焦点。Settings 的入口归属，以及 Toolkit、快捷键帮助与状态提醒的右侧工具排列，统一见[《Toolkit 与官方 Performance 工具》](settings-and-observation.md#toolkit-与官方-performance-工具)。窄窗口保留全部入口与需要用户处理的状态，长摘要可以收紧，控件不能重叠或被裁掉；这些规则不依赖 Project Rail 是否可见。底栏高度与局部尺寸约束只定义在密度 SSOT[《左下角导航与右下角工具组》](../presentation/spaces-and-layout.md#左下角导航与右下角工具组)。

## Zone→Tabs→Regions 的实体与展示绑定

用户明确要求同一个 Zone→Tabs→Regions 组件可在 Space、Focus、Survey、Mote 等位置灵活加载任一级。同一实体与其资源 Workspace／Host／目录、Session／Run，以及展示绑定各自可辨；一个实体可以有多个准确可枚举的位置，不从某个 surface、Topic 或 Group 重新铸身份或指定唯一归属。每次加载明确来源实体与本次绑定，复用原组成、内容和动作 owner，不复制布局或生命周期。某处收起、遮挡或取消绑定不搬走其它位置、不关闭实体、不改资源或后来焦点；显式关闭实体仍沿原确认与清理合同。位置查询、导航及关系增删消费同一全位置事实，不取首地址代替明确目标。 Focus 内明确选择文件、Browser、Launcher 或其他原内容时，只改变本次展示引用，原语义 Agent 与执行历史保持；展示位置独立于初始 Agent 定位，不另建选择字段。原持久关联必须保留，重启保原实体、所有持久绑定与选择，foreign 展示位置或暂缺恢复事实不构成删除理由。同实体多处实际显示须由真实呈现能力证明，引用、单宿主搬移、截图、重复新页面或 Run 都不能冒充实时并显；输入／尺寸与遮挡沿原权威 owner，隐藏或目录中未显示的绑定不新增页读、bytes 订阅或 fit。

用户要求“Focus 里标题行可以自定义，内部直接加载到 Tab 程度”。明确加载 Tab 时只呈现该 Tab 的原 Regions 工作面，不把其上层 Zone／Group 的整行页签、Split 与新增 Tab 入口再次带入。标题及操作带由本次展示位置提供，原 Region Provider、菜单、单格 Header 呈现与内容实例保持；Zone 级仍保原 Tab／Group 工具带，级别或精确位置未确认时保原地址与服务说明，不伪称完成下钻。

Focus 默认仍加载完整 Tab；用户明确选择“只看此 Region”时，只展示当前准确引用的原 Region，返回整个 Tab 则恢复原 Tab 工作面。该选择只决定本次临时呈现层级，不增设另一份地址或持久化选择；原完整位置引用、Tab 分割与其他 Regions、草稿、选区、Provider、菜单、脏文件关闭确认和 Session／Run 保持。收起这份展示使原内容返回原叶，不关闭实体；未知或迟到目标保原引用与可达说明。隐藏的兄弟内容不因单 Region 下钻被重新判为可见或增加读取、bytes 订阅及 fit。原内容改变展示位置后，正文阅读选区仍指向原节点与端点；用户后来主动选择或输入始终优先，不因恢复旧选区夺走新焦点。

用户反馈“Focus 里加载的 Browser 切 Settings 不消失，Space→Settings 正常”。沿用户最新“实体与工作面解耦、同一 Zone／Tab／Region 可多处显示”的约束，设置只遮住当前背景呈现绑定：该绑定的原生 Browser 画面与输入不可见／不可命中，其他合法可见绑定继续按其实际目标呈现。Focus、Space、Survey、Mote 不赋予实体独占归属；关闭设置返回原绑定，不销毁实体、不重建原页面、不改变共享 Tab／Region／布局、Session／Run、导航、页面输入或草稿。不通过 CSS 遮盖、全实体隐藏或把实体回迁唯一宿主代替局部遮挡；Mote 明确显示在设置之上的绑定继续可操作。

同一原生 Browser 的多处画面跟随其活体页面正常导航，媒体请求者 App 文档失效、原生来源资源替换／释放或最后可见绑定撤去时收其媒体资源，局部撤去不损其他合法绑定，媒体流程未确认时保原 Browser 可工作并明确说明，媒体撤销不解释为关闭实体。媒体预览不是原页面加载、导航或人工输入的前置条件；同一次采集失败、拒绝或超时后，保留原页面与持续服务窗，布局或尺寸变化不得自动反复申请采集或权限，沿原服务窗提供明确重试，由人显式发起。

用户从同一 Browser 的被动显示位置第一次点击原网页控件时，这一击应准确一次送到同一个原生页面；只迁画面、只换焦点或要求再点一次都不算完成。输入意图与本次准确展示位置、原页面及其当前可见范围绑定，旧页面、过期意图、隐藏位置或未确认坐标不能替用户点到另一个页面。查看、渲染与 hover 不接管输入；媒体可见不冒充原生可操作。输入交接未确认时保原 Browser 健康可工作，持续说明失败步骤、仍可使用的原位置和恢复动作，不停页、不销毁实体、不重建 Run，不静默补点或自动重放。

明确导航的公开回执按本次实际显示位置核对请求；请求中的显示 Workspace 与回执已确认显示 Workspace 即使字段名不同，也保同一含义。资源 Workspace 不代替显示位置，正确已应用导航不因字段对照失败被误判，真正不符的父位置仍拒绝；原工作面与健康输入保留。

在任一展示位置打开正文里的网页或项目文件，内容解析沿原资源，打开位置沿当前准确的展示 Workspace／Group／Tab／Region；跨工作区或同一 Tab 的非首位置不转到别处，也不从当前焦点猜落点。位置已改变或无法确认时保留原工作面并说明，系统打开不被工作面位置校验挡住；未实际挂入目标位置不能冒充打开成功。

## Survey、临时 Zone 工作面与知识入口

用户最新明确：「并不是所有的 Browser 打开都表示在 Survey」「Survey 到 Space、Topic 单向流动」「从项目 Browser 在 Survey 进一步研究，本质是一种创建行为」。Survey 的基础体验须让普通用户直接当日常浏览器使用，研究完成后可整理为 Topic 中的 Zone。此约束取代所有 Browser 自动发现入列及以多 Topic 勾选作为主流程的旧模型。单向是成果整理流程，不是实体单一归属；Zone／Tab／Region 的身份、多处展示与生命周期仍只见[《Zone→Tabs→Regions 的实体与展示绑定》](#zonetabsregions-的实体与展示绑定)。搜索和知识管理可继续扩展，不以未实现的知识库界面阻碍正常浏览。

Survey 的进入来自明确的浏览／研究创建意图，不来自某个项目存在 Browser 的事实。普通浏览不要求先建立研究 Item、选择项目或 Topic；Note 是可选的记录能力，Group／Region 和其他内容在研究中按需使用。底层复用现有 Zone 工作面，不要求用户先理解这些结构才能打开网页。

- **项目 Browser 不自动属于 Survey。** 其他项目、对话、Topic 中用户或 Agent 打开的 Browser 不因 Browser 存在、导航、操作、选择、目录或展示关系而自动入列。Survey 列表只消费明确在 Survey 创建或保存的浏览／研究入口；项目 Browser 是原项目的一块内容。纯 Agent、Terminal、File、Note 和 Mote 亦不因有内容或没有 Topic 自动成为研究。已明确保存的 Survey 内容及旧恢复引用保全；改变资格不清实体、草稿或健康 Run，不从发现事实补造创建记录。
- **研究入口与实体身份分开。** 已明确创建的研究沿原 Zone 引用承载原 Tab／Region；同一研究不因多个页面或位置重复入列。浏览页和研究入口按真实创建范围表达，不用标题、URL、路径或 Zone 类别猜身份。关闭最后一个 Browser 不删除该研究的 Note 或已保存内容。未知创建／保存事实保准确引用与恢复说明，不把全部 Browser 当成研究，也不把暂缺目录当作实体已删除。
- **项目的进一步研究是创建。** 项目 Browser 提供明确「在 Survey 进一步研究」动作，创建独立的 Survey 研究及其 Browser／Tab，以原网页的可确认上下文作为来源，不把原项目 Zone 改为 Survey 项或复用其页面身份冒新建。原项目页面、导航、布局与输入保留；后续两边不自动同步归属或操作。来源引用与实际复制内容可分辨，不声称复制完整表单、历史栈或原生现场；不自动发送、启动或续跑 Agent。失败或未知保原页、当前输入和原创建意图，已建但显示失败可恢复同一对象，不盲目重建。
- **研究工作面复用原组件。** 明确研究以准确 Zone／Tab／Region 和展示位置调用同一公共工作面，复用 Space 的 Tab 栏、Group／Region 分割、内容与控制；Browser 是默认起点，其他内容按需可达。不另造实体、布局或 Runtime；多处展示、遮挡与输入只遵守公共合同。
- **窄窗可显式查看原当前 Tab。** 默认呈现完整 Item；用户可明确「查看当前标签页」及「返回完整 Item」，只调整本工作面的可见范围，让原内容可读。目标必须是已确认的原 Tab 与准确展示位置，仍复用公共工作面；返回保同一原 Group／Region 的布局、选择和草稿，不另造树、修改持久分割、重发身份或改变内容生命周期。当前目标或所需呈现能力未确认时，保原 Item 与全部准确位置入口并说明未确认，不猜第一个目标、裁掉全部位置或以变更实体／布局代替呈现。公共实体与展示能力仍只见[《Zone→Tabs→Regions 的实体与展示绑定》](#zonetabsregions-的实体与展示绑定)。
- **日常浏览先完整可用。** 打开 Survey 可直接输入地址或搜索，不以选择项目、Topic 或理解 Zone 为前置。普通新标签页直接呈现 Browser 并让地址输入可达，不先强迫经过通用 Agent Launcher。沿原 Browser owner 完成导航、前进／后退、刷新、标签切换／关闭／重新打开、基础编辑与明确快捷键；日用的历史、书签、Profile、登录、弹窗、下载与权限按真实能力可达或诚实说明缺口。已有页在原 browserId／Region 内导航，不每次提交另开页或跳到 Space。普通重启先恢复原标签和布局，再恢复原 Browser；未知不清工作面。新的普通浏览沿 Main 已提供的 Scratch 资源上下文创建，已有研究沿其准确资源创建；不跟随当前项目或猜第一个目录，不能让“先去 Space 选项目”阻断正常起步。空白或取消不新增动作；失败保输入与原内容，迟到结果不抢后发选择，不按具体站点或厂商特判。
- **成果明确整理到 Topic。** Survey 的主要成果动作是「整理到 Topic…」：用户选择准确目标与明确的研究范围，让成果 Zone 在该 Topic 的 Space 中可见、可继续工作。复用原实体／关系 owner；已有研究从开始即可由 Zone 承载，整理不为更换入口重发 Zone／Tab／Region／Note／Block 身份，不复制 Runtime 或改执行 cwd、Profile 与无关绑定。保存与目标展示的真实结果可辨；取消无写入，失败或持久保存未确认保原研究与恢复入口，不提前移除内容。Topic 中打开、浏览或更新成果不会反向自动创建 Survey 研究。
- **单向工作流不改变公共多绑定能力。** 整理成果、打开目标 Topic、修改其展示绑定是不同动作；通用模型允许同一实体有多个合法绑定，但不据此让 Survey 成为所有位置的 Browser 汇总。目标 Scope 与已有关系完整可达，准确导航沿原位置引用，不取第一个位置或由 cwd 猜展示目标。来源项目跳转指向真实来源，进一步研究创建新的研究，二者不可混成返回／收集按钮。
- **位置选择展示可读信息并保准确目标。** 用户贴 Survey 运行截图询问「是不是bug」。需要在多个原位置中选择时，名称、位置与真实内容类别须让人区分目标；同名目标仍可分辨，不把 Group／Tab／Region 的原始 ID 串铺成主要可见文案。技术 ID 按需可达，选择仍使用原精确引用；未知名称或位置明确说明，保留选择与恢复入口，不猜第一个位置、用显示文字造身份或删掉消歧控件。文案变化不改变原动作 owner、实体、组成、保存分割、草稿或运行状态。
- **反馈保留当前工作。** 创建研究、整理到 Topic 和明确打开只改变各自动作的对象与绑定；无关引用、布局、选区与草稿保持。写入本地、请求刷新和磁盘保存未确认分别表达，不冒持久成功或为流程失败回滚原树。收起 Survey 展示或取消一绑定不删除成果、其他绑定或 Topic，不停止 Run。Browser 管理在所在工作面可达，打开工具不把项目原 Zone 导航成 Survey 研究。
- **当前操作按对象表达。** Browser 正由 Agent 操作只取 Main 确认的当前 driving 和可信操作者；人拥有控制时称「人可操作」，不猜正在输入。Agent 工作中只取 Core 已确认语义，Run 活着不等于 working。多对象摘要有明确范围，能到原 Region；混合、缺失、释放、不可用或恢复未确认如实说明，不画整 Zone 的虚假单一操作者。
- **相关成本与草稿连续。** 目录和关系数不增加内容消费者；只有公共接口确认实际显示的 Group 当前 Tab 或直接 Region 才消费相应内容。未选成员或仅存在的引用不新增 Terminal 字节、历史、fit / resize、Native 可见或保活工作。遮挡、焦点和实际尺寸消费同一公共事实，连续阅读遵守[《Terminal 连续向上阅读历史》](terminal-reading.md#terminal-连续向上阅读历史)。原 Browser bar、Profiles、标注和管理仍作用于确切 Browser / 资源 Workspace，显式保存、失败草稿、并发检查及不自动发送继续成立。
- **恢复原对象与入口。** 原持久化入口保存稳定实体、多个 Topic 关系、位置与各工作面的明确引用；真实二进程重启读回含非第一跨项目入口，不按资源 Workspace 剪掉展示关系。原组成、布局、草稿和空间焦点先恢复；Core / ctxmux 的续接与合法新 Run 按事实表达，Browser 瞬态能力由原 owner 重建。空快照、发现或握手未确认保对象、关系与服务窗，不跳到第一处、重播绑定或创建替代 Session；只有原 owner / Core 的终局事实移除对应投影。

- **列表宽度与开合属于本地呈现偏好。** 用户反馈左侧 Item 不能改宽度，完整界面重做须让窄窗优先保原内容。列表支持明确收起和恢复、有界指针与键盘调宽；开合与宽度沿原 UI 偏好持久化，切回与普通重启恢复。调宽或收起不改 Zone／Tab／Region 的实体、关系、原分割比例、当前选择或工作面布局，不导航、创建、关闭或启动内容。存储未知保当下呈现与原对象，原服务窗说明恢复动作；窄窗仍可到关键操作。紧凑信息与视觉层级唯一见[《Survey 的 Zone 工作面与液体玻璃》](../presentation/spaces-and-layout.md#survey-的-zone-工作面与液体玻璃)。
- **列表平铺，不按项目分组。** 用户最新反馈「很多冗余信息」「不要按项目分组」。Survey 平铺原 Item，保持原集合顺序与 Zone 身份，一 Zone 一项；不再按项目、Scratch 或未知来源加组头、重排或重复 Item。项目、host、路径与 worktree 沿原 Details 按需可达，明确打开来源仍指向准确资源 Workspace。来源未确认时保原 Item、选择、展示绑定与恢复引用，不猜归属、不删项。平铺只改变呈现，不改变明确创建／保存资格、Topic 关系、实体、布局、执行目录或 Run；标题、控件与持续说明的密度只见[《Survey 的 Zone 工作面与液体玻璃》](../presentation/spaces-and-layout.md#survey-的-zone-工作面与液体玻璃)。
- **探索名称与起手动作清楚。** 用户指出当前 Survey 根本看不明白、Note 难用，并要求直接修正不满意处。普通浏览以网页和标签导航表达；明确研究时，左侧研究入口与右侧内容标签的范围可辨。“新标签页”“新研究”与“在当前研究添加笔记”必须明确区分，不强迫普通新标签页先建立研究。探索可明确命名，名称沿原本地 UI 偏好保存，只是 Survey 展示名称，不改变 Zone 身份、资源、内容、其他展示绑定或 Run；未命名时使用确认内容的可辨名称或诚实的未命名提示，不把所有标签页／分屏名拼成长标题，也不选第一个成员冒充整次探索。中央网页输入继续保留，直接开始笔记与在当前探索添加笔记均可发现，沿原创建、文件、位置与恢复 owner 执行。新建失败、未知写入或已写但未显示时继续恢复同一创建意图，不再创建替代对象；后来选择与原工作始终优先。 唯一已确认的原位置可直接打开，即使该内容尚未在 Space 激活；多个、未知或不完整的位置仍明确选择，不以列表顺序、资源项目或第一个 Group 推断目标。

- **探索动作留在左侧。** 用户指出「tab 顶上放其他东西太出戏了」，要求 Organize 和 Add note 放在左边。整理与在当前探索添加笔记属于所选 Survey Item，入口位于左侧探索导航，与新探索／新笔记的创建范围可辨；Tab 上方不再承载这两项动作。左栏收起后仍有左侧可达入口，显示菜单或添加笔记沿同一原目标、创建与恢复 owner，不复制动作、不改变实体、布局、选择、草稿或 Run。右侧只保留本次内容呈现范围的控制，以及持续可发现的未知／失败恢复说明。
- **工作面从窗口顶边开始。** 用户要求 Survey「像 Space 的 UI 那样，把顶部的那一行也占掉」，并希望更加精致、紧凑。Survey 不保留独立的重复标题栏；原 Tab／Group 工作面与左侧导航直接使用顶部空间，必要的窗口控制沿共享窗口 chrome 可达。左栏展开、收起、调宽及多个 Group 时，都不能让系统窗口按钮遮住内容标签或动作。该调整只改变呈现，保原实体、准确位置、分割、选择、编辑草稿与 Run；返回 Space、Settings 遮挡和普通恢复仍沿原 owner。视觉与密度只见对应视觉合同的 Survey 章节。

### Survey 中的 Note 与块知识

浏览中的 Add note 先在左侧打开简短输入，网页与原选择保持；用户明确保存并打开后才进入完整 Note 编辑器。此输入只是原 Note 草稿的快捷入口，不是另一套内容或块编辑器。创建沿准确原 Region、资源与展示 Group，在原 Zone 中打开 Note，不创建多余空 Tab。收起、换 Item 或重启保草稿；未知写入检查同一 Note，不重复写入。后来的编辑与导航优先，成功也不能清掉新输入或切回旧页面。直接开始空白 Note 的入口继续可用。

用户提出「survey 和 note 如何结合也想想」，明确「我觉得 Note 可以是 survey 的一部分」，并希望完善创建、采用卡片／块、单独引用与双向链接。Survey 负责探索与整理，Note 是其中的笔记能力；一个 Survey Item 仍是原 Zone，浏览和记录共用原 Tab／Region 工作面。Note／Block 的内容身份、资源文件与 Zone 的展示关系可分辨；整理到 Topic 保 Note、Block 和原资源身份，只沿公共关系增加成果展示入口。

- **块是可独立引用的内容。** Note 与语义块有持久稳定身份，修改、排序、缩进、折叠、标题或路径改变不重发身份；复制正文与引用原块是明确不同动作。引用和嵌入只持准确目标，显示同一原内容；被引用块可返回原位置，修改在原内容 owner 生效。未知／重复身份、缺失目标或循环保原引用与内容并说明事实，不猜同名对象、自动回填副本或无限展开。
- **正文只有一个 owner。** 规范 Note 内容及其结构、身份和前向引用由原资源 Workspace 的文件 owner 唯一持有，块视图、源码、显式导出和索引消费同一事实。双向链接是前向引用的派生来源视图，不维护第二关系账本；展示在多处不重复计算内容关系，也不等于复制笔记。索引未确认表达读取／部分／未知，不假称零引用或改正文。
- **创建与保存结果诚实。** 一次新建意图保同一草稿、目标与身份；只有确认真实名字冲突才重试，权限、满盘、不可用或未知不自动换名重放。已创建而显示失败提供打开同一对象，未知保原创建目标和恢复入口，不当作不存在再建。迟到结果不清后来输入或抢后来选择；原文件的 revision-aware 保存、冲突、观察和显式确认继续成立。 创建目录消费原 owner 已确认的资源上下文：true home 保原 birth directory，临时 Zone 的 Topic 关联不改目录；未确认时保草稿与原对象并说明，不以 Scratch 根或当前展示目录替代。
- **探索、整理与返回保持原现场。** 在所选 Zone 新建／打开 Note、引用原块、返回来源或明确分割都沿准确原 Tab／Region 与资源作用域，默认留在当前 Survey 工作面。内容链接与 Topic／Zone 关联分开，来源网页链接不自动复制网页、生成笔记或成为内容关系；人和 Agent 沿同一内容与动作 owner，不自动发送或续跑。
- **恢复与相关成本沿原 owner。** 普通重启先恢复原对象、布局、所见块引用和未保存输入，再从同一持久内容恢复索引。各展示绑定的语义块选择分别恢复；只恢复准确块选择，不默认抢 DOM 焦点。未知目标保留原元信息和服务窗，不猜首块；发现／读取未确认保入口与服务窗，不删除原 Note 或重建替代内容。按相关 Note 的实际内容修订更新索引，不因左项、Topic 或引用数增加无关 Agent／Terminal 读取、订阅、fit 或 Run。知识的视觉与块交互层级唯一见[《Survey 的 Zone 工作面与液体玻璃》](../presentation/spaces-and-layout.md#survey-的-zone-工作面与液体玻璃)。

视觉、密度和玻璃唯一见[《Survey 的 Zone 工作面与液体玻璃》](../presentation/spaces-and-layout.md#survey-的-zone-工作面与液体玻璃)。公共展示能力与 Survey 调用分别按实际候选验收，未完成的能力保持为缺口；Survey 不另建公共绑定引擎、Runtime 生命周期、收藏数据库或内容索引引擎；明确收集只持原 UI 展示引用。

## Topic 点击必须打开可见 Tabs

- 用户点击 Topic 后，右侧必须显示该 Topic 已有的 Tabs、Region 和焦点；不能只改后台选中项而让工作面留在 Board 或 Agents。
- 已有持久化工作面应先可见；读取 Topic 元数据的流程不能挡住已存在 Tabs。文件读取失败必须明确展示，不能清空 Tabs 或另建 Session。
- Leader Topic 浮层的后台准备不能抢普通 Topic 的导航焦点，也不能重复挂载其他 Topic 的终端；重启后保留原工作面。

## Scratch Topic 首次打开必须有可用 Terminal

- 点击一个没有已绑定 Tab/Region 的 Scratch Topic 后，右侧必须进入该 Topic 的 Workbench，并在原来的落点启动一个 Terminal；只创建 Launcher 或只改变选中 Topic 都不算打开成功。
- 已有该 Topic 工作面的点击仍只聚焦并复用原 Tab、Region 和 Session，不重复启动 Terminal；后台准备的固定 Topic 仍可显式要求不抢当前工作面。
- Terminal 启动过程沿用统一的 launching/loading 反馈；启动失败必须保留 Topic 的可见工作面并显示原因与可重试动作，不能留下空白 Region。
- Topic 列表行和 Board 行的标题、摘要与主要内容区都必须可点击，并走同一条 Scratch Topic 导航；只有复制、定位、头像和右键菜单等独立动作阻止事件冒泡，不能让用户必须命中一个隐藏或孤立的小图标。

## Scratch 的交互与组织

用户确认：「每件事情自成 wiki 并记录 agent 铭牌，能力非常强大，但是当前的交互和组织，还是多少有点混乱」。Scratch 必须保留每件事情独立的 Wiki、资料、产出与 Agent 铭牌；改进交互和组织时不能丢失这套耐久上下文。

用户必须能清楚辨认当前在处理哪件事情、在哪里继续工作，以及资料、产出和参与 Agent 的归属。事情的存在与参与者铭牌不能依赖 Tab 是否打开；铭牌表达参与身份与耐久记忆，当前运行状态仍消费 Core 的权威事实。

Scratch 不再承担与其他工作上下文分离的一套产品组织方式。用户从「Scratch 放进 Projects 作为默认 Project」进一步提出更外层的 Space 抽象，当前产品对象方向见[《Space、Folder 与 Topic》](#spacefolder-与-topic)。

## Agent Region 关闭与身份入口

- 用户反馈：「右上角 Conversation history 好像占关闭位置，与画面中间按钮重复；这个位置应显示 Agent 名字和功能菜单」。首先必须恢复 Region 的基本关闭能力：多 Region 时，原 Region 关闭按钮始终可见、可点击且键盘可达；Terminal、显式 History、待恢复记录与流程告示都不能遮挡它的完整命中区。Tab 关闭成功不能代替 Region 关闭验收。
- History 只保留一个应用入口，使用现有记录阅读与返回 owner，不争用关闭位置。中间的 `Full-screen history` 是 TerminalView 的阅读边界状态告示，不是第二个手动入口，须保留其诚实边界。CLI 原生画面不冒充另一应用按钮，也不能靠遮盖正文掩饰重复内容 owner。
- Region 身份与动作沿同一个入口，消费现有 Agent 语义显示名与 Session 事实；用户名称、first prompt、Session label、Provider label 沿既有名字 owner 派生，完整名字与 Executor/Provider、Session 身份沿现 tooltip/可访问名称按需可读。Terminal、Activity、显式 History、冷态内联记录与只读观察共用这一位置；无 Agent 的 Terminal/File/Browser 不制造 Agent 身份。输入区不复制第二名称或身份条。固定 X 与显式 More 保留原完整命中区，长名字先收窄；只读状态仍可辨认。右上自适应角标与正文、命中区的呈现边界只见密度合同[《Agent Region 的关闭与动作密度》](../presentation/spaces-and-layout.md#agent-region-的关闭与动作密度)，原精确 Region 菜单、关闭与 Focus 合并入口仍消费同一 owner，不能以隐藏未知或流程服务窗的三事实换取紧凑。
- History 进入 More 单一应用入口，继续由原读取与返回 owner 控制；复制地址、分割、交换、移至新 Tab 复用原精确 Region 回调，菜单不从当前焦点猜目标、不另建动作注册表、地址格式、配置或后台查询。打开、悬停或关闭菜单/tooltip 不改变终端容器尺寸、权威 PTY 尺寸或 xterm 实例；工作量随本格相关事实增长。
- 从 Terminal 或 Activity 的同一 History 入口进入，原 Session 的记录都必须实际可读，并有明确返回进入前视图的动作；查看和返回不强切 Terminal，不重建原 Activity 或终端，不丢原内容、阅读位置、选区与草稿。返回后键盘能继续操作原视图，较晚主动焦点优先。阅读 History 时，被覆盖的原视图保留状态，但其不可见控件不能进入键盘焦点顺序；返回后原控件恢复可操作。隐藏后的读取和迟到结果沿现持久会话阅读合同处理，不能为入口另建 reader、缓存或消息账本。
- 交换目标中的 Agent 名称与该格当前的语义显示名一致，用户改名与首条 prompt 变化沿[《显示名与身份》](#显示名与身份)的同一优先级链反映。重名按同一 Tab 的视觉顺序区分，唯一名不无谓编号；名称、截断与编号只用于辨认，动作仍绑定原精确 Region 身份。
- 关闭继续走现有精确 Tab/Region、未保存确认与资源处理 owner；同一 Session 的视图切换、History、冷态内联记录及服务窗不另建 Terminal、Session 或 Run。正常与恢复状态、窄分屏、记录面和进程重启后都保持这一合同；无关 Session 不产生额外处理。

## 统一概念与空间寻址

用户要求「基于这套定义把项目里的概念定义统一」，随后「马上固化cli」。最新定义明确：「在cli上显示给出space概念，符合我们当前的设计，前面说的project/zone，其实也是space/zone更好。因为在我们的设定中，project不等同于space」。本节是产品文档、公开控制协议与 CLI 的唯一概念词典；源码旧字段的当前含义与需要修正的差异只作来源证据，不反过来改变产品定义。

| 概念 | 必须成立的含义与身份 | 权威事实归属 |
| --- | --- | --- |
| **Space** | 用户选择的持久工作上下文，包含 Folder、Topic 与 Mote。身份是 Host 与对象的绝对持久目录；名称、分类、当前 Session、是否打开 Tab 均不构成身份。Space 不等同于 Project。 | Folder 来自已有目录/项目记录，Topic/Mote 来自真实持久目录；发现复用这些来源，不建第二份 Space 注册表。 |
| **Zone** | Space 内的一条工作分区/上下文，承载 Tab。用户明确「cli用zone，这个语义更好，因为对项目是worktree，假设不用git，或者是对mote之类的，zone不一定是worktree」。worktree、普通目录和 Topic/Mote 的 home 上下文均可绑定 Zone，不能把 Zone 限定为 Git 或全量改名 Workspace。 | 已有 Folder 的分区从所属 Workspace 绑定派生；Topic/Mote 的 home 从真实 Topic 身份及其 Tab 绑定派生。确有新增分区关联时由既有 durable 工作面 owner 保存，不复制目录、Git 或 Session 真相。 |
| **Project** | 围绕项目目录组织的来源项目事实，可关联多个实际 checkout/Workspace；Git 能力按真实仓库事实提供。它是 Space 的可选项目上下文，不能冒充所有 Space，也不能用单个 worktree Workspace ID 冒充项目 ID。 | 已有 Host、项目根目录和 Workspace 分组来源；不另建项目注册表。 |
| **Workspace** | 宿主在特定 Host 上登记的实际工作目录记录。folder/worktree、路径、仓库根与分支是该记录的事实；Scratch Workspace 是既有 Topic 收纳和布局容器，不是每个 Topic 的身份。 | Main 配置/目录 owner；Git checkout 事实由现有 Git owner 提供。 |
| **Tab** | Zone 中的一张完整工作面，拥有持久身份、分割布局与多个 Region。首张 Tab 不以另一张 Tab 为存在前提。 | 唯一 durable Workbench/layout owner；Topic 绑定沿原 Tab.topicId 来源。 |
| **Region** | Tab 布局的一块精确 leaf 位置，承载 Agent/Terminal、文件、Browser 或启动面。它是空间位置，不是 Session 身份。 | 同一 durable layout owner；移动、分割和关闭绑定明确 Region。 |
| **AgentSession** | Core 持有的 Agent 语义会话，包含 Provider/Executor、原生会话身份、执行目录与恢复事实。它可以在多个 Region 展示；空间归属不能改写其执行事实。 | AgentMux Core 的公开 API。 |
| **Run** | ctxmux 持有的一次真实执行及其进程、PTY、ordered bytes、Replay 与 Attachment 事实。Session 与当前 Run 的绑定不把两个身份合并。 | ctxmux；client 只消费公开事实。 |

对外空间层级统一为 **Space / Zone / Tab / Region**。公开 discovery、inspect 与动作回执分别给出空间位置、可选 Project/Workspace 绑定及 Session/Run 执行事实，所有可寻址 ID 均可原样用作下一次输入。精确 Region 或 Tab 可反推其上层；额外给出的父层必须一致。目标不依赖调用者工作目录、当前 Workspace、焦点、标题或最近 Session；存在多个候选时返回真实候选，不猜唯一目标。

`space mv` 只改变 AgentMux 中的空间位置。用户明确「不改变执行目录，只改变在agentmux里的空间位置」；移动保留同一 AgentSession、Run、cwd 与原生句柄，不停止健康 Agent，也不复制所选投影。跨 Zone 时，目标空间归属与 Agent 原执行目录分别如实可读。Session 的额外展示与移动是两种明确动作，不能用创建副本或复用第一块同 Session Region 代替移动。

已有 Session 投影的进入动作（包括观察面里的 Open Session 与 Continue in Session）以该投影持久保存的 Workspace/Tab/Region 位置为导航事实。执行 cwd 只能为没有投影的 Session 提供新展示来源，不能在进入已有展示时把整个 Tab、Topic 或其他 Region 搬回执行目录所属 Workspace、重复加入另一个布局或改写额外投影。启动快照暂时没有 Session 事实时，仍可进入已保留的持久投影查看恢复状态；导航不能伪造新的 Session/Run 或触发重新启动。

Topic 多 Zone 的完整产品闭环不由本节代签；实际来源差异、命令语法与实施验收见 来源核对与差异清单（本机过程资料：`docs/reviews/space-zone-concept-unification-review.md`） 及 [Agent-first 的 Space 工作入口](public-control.md#agent-first-的-space-工作入口)；CLI 合同（本机过程资料：`docs/plans/pmo-cross-workspace-worktree-cli-design.md`）。既有 Renderer 文案与视觉不作全仓机械改名。

## Space、Folder 与 Topic

用户提出：「沿用 Space 的定义的话，那么这里我们可以拓展为两类 Space 定义，一类就是 Project（或者就叫 Folder），另一类就是 Topic，他们的特点不一样」，并确认这里要表达「一个更外层的抽象概念：space」。当前统一定义见[《统一概念与空间寻址》](#统一概念与空间寻址)：Space 是 Folder 与 Topic/Mote 共用的外层产品概念，Project 表达可选项目来源，不能与 Space 等同。两类 Space 的组织特点必须可辨认，不能因为共用入口而抹平差异。用户补充：「topic 和一般 folders 虽然底层行为一致，但视觉上还是区分开，目标是好懂好找」；共同工作能力不变，树中使用可读分组、类型图标和父子层级帮助定位。历史 Folder/Project 文案不能改变这两个对象的当前含义。

- Folder/Project 类围绕已有目录组织工作。Project 可以由普通目录承载，Git 能力按真实仓库事实提供；不因采用 Space 概念就要求目录使用 Topic 的 Wiki 脚手架。
- Topic 类围绕一件事情组织工作，保留独立 Wiki、资料、产出与 Agent 铭牌。Topic 的存在与耐久内容不依赖 Agent 或 Tab 是否仍打开。
- 两类 Space 共用既有 Agent、Terminal、Browser、文件与 Tab/Region 工作能力，遵守同一重启恢复与健康 Session 保留合同。Space 不复制 Core 的 Session/Agent 状态或 ctxmux 的 Run 事实，启动继续恢复用户上次工作面。

用户进一步要求：「在 space 树里他们显示不太一样，比如 topic 会自动根据规则去读 topic.md 来显示，且 topic 会自动识别和显示，不用手动绑定」，树上的 `+` 提供 `Open Folder As a Project` 与 `Create Another Topic` 两类入口。

- Space 树对 Folder/Project 与 Topic 使用各自适合的内容来源。Folder/Project 表达打开的目录与实际项目事实；Topic 按识别规则自动发现，从该目录的 `topic.md` 读取人类可读标题、摘要等显示信息。Topic 不要求用户手动注册或绑定，发现与显示不依赖当前 Tab、Region 或 Session。
- 用户进一步确认：「所有 Topic 默认就是 Space 树的一个默认一级节点，ICON 特殊；在 space 树中，每个 TOPIC 是其一个子节点」，并要求保留已经 polish 过的 Topics 列表页。Space 树默认提供一个用特殊图标识别的 Topics 一级节点，各 Topic 在其下自动显示为子节点；Topics 一级节点保留现有总览列表入口，树与列表使用同一 Topic 集合、选中与工作面事实。总览页的视觉与控件约束只定义在 surface-density[《Project Rail 与 Topic 行密度》](../presentation/spaces-and-layout.md#project-rail-与-topic-行密度)。
- 用户要求优化 Space 左侧树的交互体验。Mote、Topics 与 Folders 在同一导航滚动区内保持可达，顶部创建与侧栏动作共用一层固定控制行，密度动作紧邻就地查找；展开与收起只改变树的显示，不启动、停止或替换 Session。长标题可通过 hover 信息和可访问名称读全；名称打开对象，折叠动作与 Mote 人格编辑各自有完整命中区，键盘操作能清楚看到当前焦点。窄栏与短窗口继续保留原对象、选中、折叠和工作面事实。对齐、缩进及视觉节奏只定义在 surface-density[《Project Rail 与 Topic 行密度》](../presentation/spaces-and-layout.md#project-rail-与-topic-行密度)。
- 用户继续反馈：「现在继续优化左边树结构，当下显然没有达到顶尖水准」。树需要承担快速找 Space、辨认当前位置和继续操作的完整导航职责。就地查找只筛选已知的 Mote、Topic 和 Folder 名称、摘要、路径及 Host，不扫描磁盘、不启动 Agent；匹配项的祖先临时可见，清除查找后还原用户原有折叠与滚动位置。无结果必须明确可恢复，不能表现为对象被删除。键盘可沿当前可见对象连续移动、到达首尾、展开或收起分组，Enter 打开明确聚焦的对象；移动焦点本身不改变工作面。Topic 的 pin 等既有事实、原总览入口和 Folder 导航身份继续共用原 owner。状态摘要优先展示需要用户处理的情况，完整分类与准确数量仍在同一入口的提示、无障碍名称与展开面中可读；收敛常驻信息不能把未知当作正常，或隐藏待回答与错误。视觉层级与信息预算只定义在密度 SSOT 同节。
- 树上的 `+` 必须明确区分打开已有目录与创建新 Topic。打开目录进入 Folder/Project；创建 Topic 形成独立的持久目录与 Wiki、资料、产出、Agent 铭牌结构，创建后自动可见可进入。
- 显示信息读取失败属于流程状态：保留已有 Space 与工作面，在对应条目或服务窗明确说明问题。一个 Topic 的读取失败不能隐藏其他健康 Topic，也不能清空其已有 Tab/Region 或停止健康 Agent。

用户继续反馈：「现在树的最左边有个 padding 浪费空间，而且有很土的箭头和线，没有妥善的分区、热度、标记系统，而且缩进也有点看不出来，顶部 icon 位置也奇怪有两层，有多余的标题，目录和功能区没有 `+` 等」，要求理解底层模型后重新设计交互并优化。Space 导航必须同时回答「这是什么、在哪里、是否需要我、怎样继续」，顶栏、分区和对象动作各有明确作用域。

- 导航按 Motes、Topics 与 Folders 分区。Mote 是持久人格对象，Topic 是围绕事情的知识空间，Folder 是已打开的目录；这些类别只投影既有对象，不能为视觉分组新增注册表或改变对象归属。Topics 分类入口继续打开现有总览，具体对象打开自己的完整工作面。
- 各分区就地提供明确的 `+`：Motes 创建 Mote，Topics 创建 Topic，Folders 打开已有目录作为 Project。顶部通用创建保留跨类型菜单。分区的 `+` 不折叠分区、不切换到其他对象、不要求用户先进入默认 Topics；路径派生分组不是可创建、重命名或删除的实体，不给它伪造管理动作。
- 「热度」使用已有 Session 的真实 working、needs-you、error、idle 与 completed 事实。Topic/Mote 按 Host 与持久目录归属，相对显示目录锚定该 Space 的根目录，不与 Session 的绝对路径直接混比；Folder 沿现有 Workspace/Project 归属。名字相同、父目录相邻或属于另一个 Host 都不能串状态。需要回答与错误同时存在时都可见，展开面继续给出准确分类和原 Session 的进入动作；折叠分区或父目录时把所有被隐藏后代的注意力卷上来，同一 Session 不重复计数。没有真实活动不显示虚假热度，不以读取失败推断空闲，不新增后台轮询或状态账本；导航投影的工作量随已加载对象和相关 Session 增长，不允许每行重复扫描全部 Session。 活动控件只订阅其所属 Session 的时间线事实；空对象不增加活动消费者，无关 Session 的时间线更新不能唤醒这些控件。
- 标记由用户拥有。Topic/Mote 的 pin 操作与既有 Topics 总览复用同一 `pinnedItems` 与 toggle owner，标记必须在树上可读、可操作、可撤销；已有 Branch pin 仍从属于原 Folder。pin、选中与运行状态表达不同事实，不能相互冒充。热度变化不重新排序对象；沿用已有用户顺序和置顶规则，保持空间记忆。
- 分区开合、查找、pin、密度和人格入口不改写 Session/Run、Tab/Region 或布局；查找继续暂时显示命中上下文并在清除时恢复原折叠与滚动。进程重启后保留原对象、分区折叠、pin、密度、选中及工作面，并沿既有恢复路径继续原 Session；探测或显示信息失败按原服务窗合同保留健康工作面。顶部层数、左缘、折叠字形与无连线层级的视觉约束只定义在 surface-density[《Project Rail 与 Topic 行密度》](../presentation/spaces-and-layout.md#project-rail-与-topic-行密度)。

用户追问：「你自己满意了吗」。Space 导航已交付的对象、创建、查找、标记、真实注意力与恢复行为继续成立；本次视觉收敛只调整顶部开关的静息选中重量与三档分区节奏，不能借调整外观改写对象归属、工作面、焦点、Session/Run 或健康 Agent 的可用性。视觉约束唯一见 surface-density[《Project Rail 与 Topic 行密度》](../presentation/spaces-and-layout.md#project-rail-与-topic-行密度)，不扩展 Agents、Browser 主体或其他工作面。

用户继续反馈：「Mote 和 Topic 没有缩进」「Folders 与内部聚合组图标一样」「pin 图标过大不精致」「自动图标太跳，要低调精致」，并要求「手动图标对 Motes、Topics、Folders 共用做底层且优先自动」「目录连同 pins 要形成背景区域」。本次在已交付导航与视觉收敛之上补充对象身份与层级，不更改原行为验收事实。一级归属、身份槽、分类与聚合组的辨认、pin 尺度和目录背景的视觉约束唯一见 surface-density[《Project Rail 与 Topic 行密度》](../presentation/spaces-and-layout.md#project-rail-与-topic-行密度)。

- Mote、Topic、Folder 共用用户拥有的图标选择、恢复自动和显示规则。手动选择优先于已有自动项目图标或自动身份，树与 Topics 总览消费同一选择；自动图标稍后读到不能覆盖用户选择。恢复自动只撤销该对象的手动选择，不修改标题、Topic 内容或已有项目图标。
- 手动图标属于 Workbench 的持久界面身份元数据，沿用现有唯一保存与恢复 owner，不进入 Core/ctxmux、Runtime 配置或 Topic 内容。身份由 Host 与对象的绝对持久目录共同确定：Folder 围绕原 Project 目录，Topic/Mote 围绕其持久 Topic 目录；名称、分类、当前 Session 和工作面都不构成身份。改名、Topic 转为 Mote、进入同一 Project 的 worktree 不丢失选择；不同 Host 或不同持久根下的同名对象不串图标。
- 图标动作在已有对象菜单中可达，鼠标与键盘使用同一紧凑选择面；可预览、选择、恢复自动和取消。保存失败保留选择草稿与原工作面，明确指出失败步骤并可重试，不能假装保存成功后关闭。保存请求的成功不冒称磁盘确认；进程重启后的实际读回才证明该选择恢复。一次保存不覆盖另一个对象的选择，也不丢 pin、布局或并发工作面变更。
- 图标选择不改变导航、折叠、pin、真实注意力、排序、Session/Run、Tab/Region 或焦点恢复。没有手动选择时继续使用已有自动来源；不新增磁盘扫描、后台轮询、状态账本或无关 Session 的图标工作。重启保留对象选择及原工作面，显示与保存失败仍按既有服务窗合同保全健康 Agent。

用户继续反馈：「现在菜单样式不错」，希望前面的图标饱和度跟近期活跃程度。目标是 Space 中 Folder 行首的彩色自动项目图像与后续「优化吧」要求中的自动字母牌；Topic 字母牌、Mote 类型图形、手动线型图标和其他表面的项目身份沿原规则。三档视觉与时间边界唯一见 surface-density[《Folder 自动图像的近期活跃色调》](../presentation/spaces-and-layout.md#folder-自动图像的近期活跃色调)。

- 近期活跃依据本 Project 所属已加载 Agent 的最后确认语义观察，沿 Core 已保留的原生 Hook/ACP 活动事实，不在图像层重复判断语义状态。当前状态未知不否定一次真实工作观察；「近期未知」指缺少可信活动时间。进程健康、仅打开或切换、后台探测、终端字节、文件时间与显示刷新都不是该来源，重复快照不生成新活动。只有有限、正数且不超前的既有时刻可表达年龄；时间未知、无效或超前时不编造当前时间，也不把安静外观称作「从未活跃」或已证实超过某个时长。
- 同一 Project 的所有 worktree 共用所属 Session 的最近可信时刻；按现有 Host、Project 与 Workspace 归属，不能因同名、相邻目录或折叠而把独立子 Project 的活动算到父 Project 图像上。折叠后的尾部注意力仍沿原汇总规则，图像的近期程度不改变该规则。
- 色调只辅助表达最近确认观察的年龄，不代替当前选中、真实运行状态、需要回答或错误；图像来源、手动优先、对象顺序、导航、工作面和健康 Session/Run 保持原事实。不新增持久活跃时间、权限或状态 owner；显示更新只消费已有相关事实与时间边界，不增加后台轮询、时间线或终端扫描。

用户继续反馈：「没看到这个效果」「全是灰的」。近期色调必须在用户实际使用的 Space Folder 行上成立：已有彩色自动图像且所属 Agent 有近期可信观察时，该行必须消费该事实并可见对应色调，不能让安装版本、事实传递或呈现链的缺项把所有项目一律当成未知灰态。缺少图像、可信活动时间或显示读取失败时如实区分，不能伪造活动来染色，也不能以受控图像和受控 Session 的测试通过替代用户工作面上的实际结果。三档视觉与时间边界仍唯一见 surface-density[《Folder 自动图像的近期活跃色调》](../presentation/spaces-and-layout.md#folder-自动图像的近期活跃色调)，不改变原工作面或健康 Agent。

用户明确指向「Space 左侧 Folders」。已有项目图像的发现必须有界，隐藏与临时工具目录不能耗尽扫描预算、遮蔽正常项目目录中已有的图标，也不能让隐藏工具目录的图像冒充项目身份。不因单个项目或厂商增加专用路径分支；真正没有图像时保留字母牌或图形，不能为表现热度伪造项目图像。自动字母牌的身份色与近期程度遵守下述「优化吧」约束；没有可显示字素的图形仍保持中性。该来源约束不扩大到 Focus、Mote、Topic 或手动图标。

用户随后要求：「优化吧」。Space 左侧 Folders 即使确认没有原图，也要从自动字母图标看出近期活跃程度，并保持克制。已有项目图像仍优先；确认无图且名称提供可显示字素时，沿已有字母牌呈现稳定身份色，并消费与原图相同的可信活动时间和三档规则。身份色只辅助辨认项目，不能冒充当前状态、选中、需要回答或错误；未知活动仍明确未知，不因无图伪造活动。

- 身份色由原 Host 与 Project 的绝对持久根身份确定，不随名称、当前 worktree、所属 Session、渲染顺序、焦点或刷新改变；同一 Project 的各 worktree 共享身份，不同 Host 或根各按自身身份派生，不承诺有限颜色绝不重复。重启后仍从同一原身份得到同一颜色，不新增持久化配色配置或注册表。
- 只扩展 Space Folder 的自动字母牌；Topic/Mote 字母牌、手动图标、其他表面的项目身份与没有可显示字素的默认图形保留原规则。探测未完成时保留原未知呈现，不提前闪一枚彩色牌，图像稍后读到时仍优先显示原图。原手动优先、归属、名称、顺序、pin、导航、布局与健康 Session/Run 保留。
- 活跃字母牌沿原相关事实立即更新，实际时间越过边界也无需点击；隐藏或卸载停止无效唤醒，恢复可见校准当前年龄。原图与字母牌复用已有时间边界，不增加活动 owner、轮询、终端或磁盘扫描、每行全局 Session 遍历及无关 Session 消费者。视觉强度、主题可读性与正常/窄栏的约束只见 surface-density 同节。

用户进一步提出把 PMO Agent 这样的特殊 Topic 赋予特定类型，体验参考 muse 或 OpenAI dot，并明确：「这种 Agent 其实非常类似 Topic 的逻辑，和普通 folder 共享一套 space 管理逻辑，但是有自己的特殊预制」。

- PMO 等特殊 Agent 以带预制的 Topic 组织，复用 Topic 的耐久目录、Wiki、资料、产出与铭牌，以及 Folder/Topic 共用的 Space 管理能力。预制负责特殊身份、默认上下文与产品入口，不建立另一套 Space、Topic、Agent 或 Run 生命周期。
- 特殊 Agent 的入口、Space 树条目与已有工作面必须指向同一个持久 Space；打开、收起、恢复或切换入口不创建第二个 Topic 或 Session。现有 PMO 的身份、职责和执行焦点约束继续见[《PMO teams topic 名称与职责》](motes-and-coordination.md#pmo-teams-topic-名称与职责)与[《执行 Agent 焦点历史与 PMO 上下文隔离》](focus-context.md#执行-agent-焦点历史与-pmo-上下文隔离)。
- 普通 Topic 不继承特殊预制的角色。特殊身份属于产品预制，与执行它的 Provider/Executor 区分；实际 Agent Session 仍通过 Core 的公开能力启动与恢复。
- 用户补充：「现在 mote 的图标太过制式，一看就是 AI 生成，应该生成一个更有质感的 icon svg」，并希望项目其他地方用于表示 AI 的同类图标「都换掉」。Mote 的持久产品身份使用独立矢量标记；新建工作面、技能和权限动作按各自含义表达，不能把所有 AI 相关入口都替换成 Mote 身份。Provider 官方标识与真实运行状态继续沿原 owner；具体字形、尺寸与替换范围只定义在密度 SSOT[《控件语言》](../presentation/shared-rules.md#控件语言)。
- 用户确认：「每个 PMO 都有全局负责的能力，如果不是这样，用 topic 就够了」。这一类带持久人格的产品对象具有跨 Folder/Topic 全局负责的能力；其职责不被自身 Topic 目录或当前选中 Space 限定。用户同时确认「稳定身份和 session 不绑定」：产品身份在没有运行 Session、Session 结束、更换或恢复时仍然存在，不能用某一次 Session 的身份代替持久角色身份。

用户进一步明确：「就像 topic 创建时会带有知识管理结构，这种 agent 创建的时候可以带有 soul，甚至可以是 topic 的超集（当前 PMO Team 其实就是这么设计）」，随后澄清：「我说的 soul 是类似 openclaw 和 hermes 的 SOUL.md」。Agent Space 可以作为 Topic 的超集：保留 Topic 的知识管理与协作者结构，创建时额外带有具体可读、可编辑的 `SOUL.md` 等特殊预制。`SOUL.md` 表达这位 Agent 的持久人格、价值取向、沟通方式与行为边界，和当前执行它的 Session、Run、Provider/Executor 身份区分；更换或恢复执行会话不能把这些耐久内容丢掉，也不能用模板覆盖用户已经编辑的内容。

用户确认：「topic 就是在按照 topic 的知识管理来，Agent 的话让他自己决定」。普通 Topic 沿用已有知识管理结构；这类持久角色自行决定如何组织和维护自己的知识，产品提供创建预制和可读、可编辑的文件，不额外强制统一的记忆分类、文件集合或维护流程。`SOUL.md` 仍承载持久人格；已有 Wiki、资料、产出、铭牌和用户编辑内容继续保全，Session/Run 的权威事实仍由原 owner 持有。

PMO Team 是这种 Agent Space 的已有产品实例，继续复用原固定 Topic、Wiki、角色说明与工作面。`SOUL.md` 属于耐久上下文，不能覆盖用户当前指令、既有授权与 Core/ctxmux 的权威事实，也不能把设定了长期职责伪装成已经启动或完成了后台执行。文件存在与执行会话实际加载是两件事：启动、恢复和文件编辑后的生效情况必须按真实执行能力表达，不能仅因预制了文件就声称已加载，也不能为一个 Space 修改其他 Agent 的全局人格。加载方式与更新时机遵守本节下文的新会话与恢复约束。

用户要求补强 Mote 的默认人格与知识维护习惯：新建或补缺失的 Mote SOUL 默认先读相关已有资料，记录有来源、时间和作用域的确认偏好与决定，区分事实、推测、提案、承诺和完成；更正只更新相关耐久知识，保存后读回才声称记住。换 Session 通过原资料接续，不假称继承未见对话或运行工具；不知道、未读、写入未确认都如实说明。知识组织继续自主，不规定 MEMORY 文件集、统一分类、scheduler 或第二份 Goal/Task 状态。详细执行协调沿 app-owned MOTE_COORDINATION_ROLE 单一职责；主 Mote 的新默认或用户明确恢复默认 Wiki 只提供短知识／协作指南，不重复整段角色流程，非主 Mote／普通 Topic 的默认 Wiki 不改。已有磁盘 SOUL、Wiki 与用户资料原样保留，不做 migration、自动清洗或截取用户文本去重；仅新的 Session 按原人格加载合同生效，恢复不热替换。实际模板交付与模型是否执行、读写成功分别验证，不能用提示词内容承诺每轮遵守或自动长期记忆。

用户要求：「创建一个 feature-tracker 专门来做这个迭代吧，包括现在左下角的 PMO Teams 头像的交互，也可以借这次想的更加明白一些」。本轮迭代覆盖 Space 的统一组织、Topic 自动发现与创建、带 `SOUL.md` 的特殊预制，以及左下角现有 PMO Teams 头像与同一 Space 的交互关系。头像快捷入口、Space 树条目和完整工作面必须指向同一持久对象；讨论要明确点击、展开、收起、切换与原工作面焦点的关系。用户随后确认「现在可以始终指向 PMO」：本轮底部入口固定指向现有协调对象，不随当前 Space 自动换对象。快捷面、人格编辑入口与完整 Space 的往返遵守本节下文的确认；现行职责、焦点隔离与恢复约束继续成立。

用户进一步要求：「这个 Agent 在我们项目里最好有个不容易重复的名字」，并强调「Agent 毕竟太通用了」，随后明确「PMO 这名字也不好，得换一个，只是在初始化这类 Agent 的时候，默认角色中包含 PMO」。在比较并撤回 Giu 后，用户最终明确：「就用 mote 吧？」。这类有稳定身份、SOUL.md 和全局负责能力的持久产品对象统一叫 **Mote**，Space 树、创建入口和固定快捷入口采用同一含义；PMO 是初始化默认角色之一。命名不改变耐久目录、持久对象、Core Session 或 ctxmux Run 身份。候选历史只保留在 brainstorm 记录中，不作为当前产品文案。

用户要求「继续，彻底完成推进」。本次按以上确认落实完整迭代，不再停在提案：Space 树把默认 Topics 节点与 Folder/Project、Mote 放在同一导航面；Topics 子项和现有总览同源，Mote 使用独立的预制身份标识。默认 Topic 收纳目录仍是既有目录，文件和工作面身份保持连续；Topic 的发现规则只读取该目录的直接 Topic 子目录，不扫描无关项目或全盘。

- Space 的 `+` 提供 Open Folder As a Project、Create Another Topic 和 Create Mote；从任意当前 Space 创建 Topic/Mote 都进入其持久目录，不要求先切到默认 Topics。
- Mote 创建时提供可编辑的 SOUL.md 和默认 PMO 角色；普通 Topic 不继承人格。一个目录中的 SOUL.md 是该目录具有持久人格的文件事实，和有没有运行 Session 分开。Topic 的知识基础继续保留，Mote 自行组织后续知识。
- 左下角默认 Mote 仍打开已有协调对象的快捷面；入口的展开状态独立于 Working / Needs you 等真实 Session 状态，无障碍名称与描述可辨；树条目进入该对象的完整工作面。快捷面可打开完整 Space，完整面可编辑同一 SOUL.md。两条入口复用既有 Tab/Region/Session，不因面板开合新建对象；关闭快捷面恢复原执行上下文，进入完整 Space 则保留明确选择的新目标。同一 Mote 有多个会话时，快捷面与重启恢复保留已有目标 Tab 和 Mote 焦点，不能仅因它排在列表前面就换到另一个会话；浮层的目标选择不改写原主工作面的选中。
- 新 Mote 从没有运行 Session 的可用启动面开始，不凭打开或创建预制启动额外 Terminal。普通 Topic 的首次 Terminal 规则继续成立。
- SOUL.md 的内容在新执行会话启动时作为该 Mote 的人格上下文实际传入 Core；恢复已有会话保留其原上下文和持久目录。正在运行的会话不因文件保存而声称已热更新；文件编辑入口明确说明新会话使用更新后的内容。读取失败应给出可见原因，原目录、工作面和健康 Session 保留。
- Topic 升级成角色和复制是此前 Agent 提出的额外设想，不是本轮已确认需求；Mote 归档与恢复按本次用户反馈见[《Mote 归档与恢复》](motes-and-coordination.md#mote-归档与恢复)。

## Project 与 Workspace

- 导航围绕 Space 的工作上下文组织；Folder/Project 与 Topic 两类的产品归属见[《Space、Folder 与 Topic》](#spacefolder-与-topic)。当前 Project Rail 负责选择工作上下文、显示紧凑状态和进入 Settings/Hosts。
- Project Rail 的 `Projects` 只是分组标签，不是页面标题：它必须使用低于项目行标题的元信息层级，弱化字重与字距，不抢项目名称的注意力。
- **选中和运行是两件独立的事实**。选中项目只用中性的整行 Surface 与 `aria-current` 表达；项目下存在处于 Board `working` 列（`starting`/`running`/`working`）的 Agent 时，在该行的独立尾部状态槽显示运行标记。这个标记对所有有运行中 Agent 的项目都显示，不能因为项目未选中而隐藏，也不能因为项目选中而变亮。运行标记必须复用 `sessionBoardColumn` 的判定，不维护第二份 Session 状态。
- **“活着”和“正在产出”分开说**。`running` 表示进程可用但当前回合安静，只在 Project/Scratch 行显示为 muted 的 `idle` 数量；`starting`/`working` 才进入行内的 `Agent is working` 文案。独立的运行标记仍覆盖整个 Board working 列，让健康但安静的 Session 可被找到，却不能让同一 Agent 同时读成 working 和 idle。
- **Project tree 的行尾状态统一为小图标 + 数字。** idle、running/working 与 error 都占同一枚紧凑状态槽，数字表示该 Project 的对应 Session 数量；图标形状和语义色区分状态，不能让某一类变成一段长文案或另一种尺寸的徽章。没有数量时不占位，tooltip/读屏补充完整状态名称。
- **每个 Project 行行首显示这个项目自己的图标**。前提变了才改的：这条原先写的是"普通 Project 行不显示每行都相同的文件夹图标，行首留白"——那句在**每一行都是同一枚文件夹**时是对的（一列全同的图标不是信息，见密度合同[《控件语言》](../presentation/shared-rules.md#控件语言)「一列全同的图标」）。一旦主进程能从项目仓库里探到各自真实的图标文件（favicon、app icon 等），这一列就有了区分度：`agentmux` 与 `avatars` 各顶自己的标识，用户一眼认出哪行是哪个。此时**文件夹/仓库 glyph 退化成"未知"态**——只在探不到图标时兜底，而不再是唯一态。兜底必须是**统一的文件夹/仓库 glyph**，不用 name-derived 色点、不留空：实测用户 10 个项目只有 4 个有图标，混排留空会让左缘参差。图标只表达身份，不模拟运行状态（运行仍走独立尾部状态槽）。Scratch 仍用它自己的品牌图标。
- **多个 Project 之间的位置关系要看得见，用一种优雅的 UI 交互形式来展示**。用户原话：「假设两个 projects 在同一个目录下，就在界面中显示它们的分组」「如果某个 project 是在另一个 project 目录结构的子结构里面，就自然地把这两个排列到一起，并且把处于子目录的 project 向前缩进，形成一个树结构」。判据如下：
  - **分组的键是「同 host + 共同父目录」**，不是路径字面相同。`~/proj/agentmux` 与 `~/proj/bagakit` 归到 `~/proj` 一组；远程 host 上的 `~/proj` 与本机 `~/proj` **不同组**——路径字符串一样不代表是同一个地方，跨 host 混排会让用户点错机器。
  - **真嵌套才缩进**：一个 Project 位于另一个 Project 的目录内时，两者相邻排列、子项向前缩进成树。
  - **判断"在里面"必须按路径段边界，不能用裸字符串前缀**。`bagakit/agentmux-preview` 以 `bagakit/agentmux` 开头，但它不在 `agentmux` 里面，是它的兄弟。比较前给祖先补上分隔符（`ancestor + '/'`）才是"位于其目录内"。同理，一个 Project 嵌在多个 Project 里时**认最深的那个祖先**做父节点——挂到更浅的祖先上会让中间那层凭空消失。
  - **单例不成组**。一个分组里只有一个顶层 Project 时不显示分组头，它直接平铺。分组头的价值在于表达"这几个是一伙的"，只领一个成员时它不携带信息，只是又一行占位——与[《控件语言》](../presentation/shared-rules.md#控件语言)「一列全同的图标不是信息」同一条理由。实测用户真实的 10 个 Project 会派生出 6 个共同父目录，其中 4 个是单例：不设这条，一半的项目会各自顶着一个只领一人的标题。**数的是顶层成员，不是节点总数**：一个独苗项目底下挂着一串嵌套子项目时，那些子孙并不在这个父目录里（它们的归属由缩进表达），分组头同样只领一个成员。
  - **分组头不是可选中的行**。它是分组标签（`Projects` 那一档的元信息层级），不承担选中、不显示计数、不接收点击——它不是一个 Project，点它没有任何东西可以被激活。
  - **worktree 不进这棵树**。`defaultWorktreePath` 把 worktree 放在 `<repo>/.worktrees/<branch>`，它天然是子目录，但它已经是所属 Project 的一个 Workspace（在 Project 内部展开）。按路径包含关系再把它变成一个子节点，同一个东西就有了两套嵌套，用户无从判断该点哪个。**归属只有一种表达**：worktree 归它的 repo，树只表达 Project 之间的真实嵌套。
- 这里只是**呈现**变了。分组与缩进都从既有的 `WorkspaceRecord.path`/`hostId` 派生，不新增第二份 Project 注册表，也不把层级写进配置——路径是唯一真相，用户在磁盘上移动了目录，这棵树就该跟着变。
- 左侧 Project Rail 的项目行支持“从侧栏移除视图”。这只撤销该 Project 的 Workspace 注册与导航入口，不删除磁盘目录、文件、布局、Session 或正在运行的 Agent；移除当前项目后应落到仍可用的 Scratch/其他 Project，并保留 Runtime 中未被停止的事实。
- 当已登记的本地 Workspace 目录被移动、导致 Explorer 报 `Could not read workspace` 时，错误面必须提供“选择新目录/重设路径”出口。重设更新原 Workspace 的路径并保留 Workspace id、Session 归属与已有工作面；取消选择或选择失败不应清空原记录。仅把失败重试留给用户是不完整的恢复路径。
- 有分组头时，分组成员整体比未分组项目多一层轻微缩进；成员之间的真实嵌套在此基础上继续增加缩进。分组头仍是标签而不是项目行，不能与成员落在同一条左缘，也不能因此新增持久化层级。
- Workspace Tools 位于主工作区左侧，负责 Files + Branches、Agents 和 Browser Favorites。
- Scratch 使用同一工具槽，但内容是 Files + Topics。Topic 来自文件系统，不从打开的 View 反推。
- **一个 Topic 容纳多个 Agent，不是一 Agent 一 Topic**。同一 Topic 里的参与者关系在磁盘侧以 collaborators 表达（Scratch 文件系统是唯一真相），不另建 UI 侧的 Topic Registry；Topic 之间的切换归 Topic 面板，不靠 View 或 Tab 的开合暗中改绑。因此 `topicId` **绝不由 `tabId` 派生**——把当前 Tab 的 id 当作 topicId 会让每开一个 Tab 就凭空多出一个 Topic，与"一 Topic 多 Agent"直接矛盾；目标 Topic 由启动意图显式携带，缺失时不绑定任何 Topic 而非发明一个。
- Topic 条目的目录动作只在内置 Explorer 中展开、选中并滚动到对应目录，不调用 Finder 或其他系统文件管理器。
- Topic 条目的改名是对 `topic.md` 一级标题的语义编辑；`topic--*` 目录、`topicId`、Agent cwd 和 View 绑定保持稳定，Explorer 不向这些顶层目录暴露通用 Rename。
- **切 Topic 就换那一组 Tab，和项目里选 Branch 是同一种体验**。Branch 之所以天然换掉整条 Tab 条，是因为布局按 Workspace 键控、每个 worktree 就是一个 Workspace；而 Scratch 的所有 Topic 共用一个 Workspace，若不做处理，切过去会看到别的 Topic 遗留的 Tab。因此当前 Topic 是一个显式状态，Tab 条按它投影：**布局仍只有一份，过滤发生在渲染时，不建第二份 Tab 状态**（Topic 的真相仍在文件系统）。两条边界：**未绑定任何 Topic 的 Tab 始终可见**——它不属于任何 Topic，藏起来就再也找不回了；**活动 Tab 要跟着 Topic 走**，判据是"它属于这个 Topic"而不是"它还看得见"——让一个未绑定的 Tab 在切换后继续当活动项，等于切过去却什么也没发生。
- **选中一个 Topic 之后必须真的只看到它自己的 Tab**。上一条描述的投影只有在"当前 Topic"这个状态确实被设过时才生效——如果用户是通过点 Tab、恢复会话或任何 Topic 面板以外的路径进入某个 Topic 的，当前 Topic 仍是空，于是所有 Topic 的 Tab 一起摊在条上，这正是用户看到的混乱。**当前 Topic 必须从当前活动 Tab 的绑定派生，而不是只由 Topic 面板的点击设置**：活动 Tab 绑了哪个 Topic，当前就是哪个 Topic；活动 Tab 未绑定则不过滤。这样"选中 Topic"这件事无论从哪条路发生都成立，也不需要第二份状态去和它同步。
- **从当前工作线新建的 Tab 必须继承当前选中的 Topic 绑定**。点击 Tabbar 的 `+`、从当前 View 打开 Browser/Terminal/Agent，或由 Control/链接创建一个新 Tab 时，目标是当前活动 View 所属的 Topic；不能因为新建了一个 `WorkbenchTab` 就退回成未绑定 Tab。未选中 Topic 时仍保持未绑定，显式指定另一个 Topic 或已有 Agent Session 时以显式目标为准。这个继承发生在创建边界，不新增每 Topic 一份 layout、全局 Topic 注册表或第二份当前状态。
- Topic 面板与文件树共用内容槽时，**默认高度偏向 Topic 面板**：Topic 是 Scratch 的一等对象，文件树是它的底料。文件树默认占更小的一份。
- Topic 行的动作按频次分层：**定位到该 Topic 的目录**是高频、留在行上（图标要表达"聚焦定位"而不是"打开文件夹"，因为它不离开 AgentMux）；**改名**是低频，收进行的右键菜单，不在行上常驻一个图标——每多一个常驻图标，行的可读宽度就少一分。
- Topic 行**不用左侧竖条表达选中**。选中态是单一几何信号（干净的 Surface 填充），与全局控件语言一致；行首也不放没有区分意义的装饰图标——一列全同的图标不携带任何信息，只在消耗宽度。
- **Topic 行的 Agent 呈现为一组头像**，不是一排抽象的点。每个 Agent 用缩小的 Provider 图标（用户据此一眼看出这一行里跑着谁）；头像**默认不画常驻边框**，只有确实处于 `working`/`running` 的 Agent 才显示外描边/发光，其他状态用灰度处理，避免把静态身份误读成正在运行。悬停有轻量抬升与 tooltip 给出名字与状态，点击直接定位到该 Agent。这三件事——身份、状态、导航——过去要用户读完整行文字才知道，头像列把它们压进一个可点的小方块里。
- **Topic 行必须能看懂它的工作面结构。** presence 组件在一行内给出该 Topic 当前可见的 Tab 数量；hover 时显示每个 Tab 的顺序/标题、Region 的分屏结构，以及每个 Region 当前绑定的 Executor。每个 Region 的摘要必须能定位到对应 Tab，不把多个 Tab 的内容压成一个无法操作的总数。
- **Region hover 要回答“最近在做什么”。** Agent Region 使用最近一条可读的用户/Agent活动摘要；没有可读摘要时明确显示 `No recent activity`，不能编造或用 Session id 冒充工作内容。摘要来源复用已有 timeline/first prompt 投影，Topic 行只负责呈现，不维护第二份活动状态。
- Topic presence 的 Tab/Region 结构由一个可复用组件渲染，Branch/Topic 等同形列表只注入数据与定位动作；组件必须保留键盘可达的等价信息，hover 只是加速阅读，不是唯一入口。
- Topic presence 的交付态以真实工作面投影为准：打开 Tab 的 Agent 身份嵌在对应 Region 结构中，健康但未挂载到可见 Region 的后台 Agent 保留在同一行，已结束 Agent 不占用在场名额；Tab 顺序、Region 边界、Executor、最近活动与焦点状态都来自现有 Workspace/Session/Timeline 事实，不创建第二份布局或 Session 状态。
- **旧配置的 Executor 身份不能丢**。头像设置迁移到 Executor 后，旧 `Appearance` 中按 Executor ID 保存的 tint/badge 仍先显示在对应模板与所有头像簇/Tab 标记中；用户明确点击 Reset 才写入一个空的 Executor 覆盖，不能静默删除旧记录或把它误认成默认 Provider。
- Project Rail 与 Workspace Tools 分别开关，不能共享状态或互相改变布局身份。

## Agent 自助创建与空间操作

- **自定义 Executor 与内置 Executor 走同一创建路径**。用户说“应该要可以开出来，且也有完整的元信息”。发现结果必须区分用户名称和稳定 Executor ID，并以当前配置为准；按名称指定时，唯一名称可解析到稳定 ID，重名须返回候选而不猜。未找到名称不能被描述为“这个 Provider 不支持自定义 Agent”，也不能擅自用默认 Executor 代替用户选中的配置。
- **元信息足以发现、启动和核验同一个 Agent**：创建前可见 Executor ID、名称、Provider 与目标 Host 的探测状态；创建后可关联 Session、Run、Host、Workspace、View、Region 和能力。Session/Run/能力来自 Core，布局坐标来自布局 Owner；配置里的环境值与凭据不是发现元信息。未探测、探测失败与确认缺失必须可区分，不把“未探测”说成“不能启动”。
- **“在右边新开一个”不是“查找右边已有的”**。旁边已有 Agent 不满足新建请求，也不构成空间已满。Tab 条相邻只表达导航关系，不能被当作当前 View 中可见的分屏占用；空间判断取同一次 View 几何与内容快照，不按 Tab 标题、列表次序或树深度猜。
- **技能中的空间原则保持简短、通用**：先看当前视图，优先复用符合方向意图的空位；需要拆分时，选择能让新旧内容都清晰可用且扰动最小的区域；保留现有工作，完成后核对实际落点。由 Agent 根据可见空间决定具体拆哪格，不枚举窄/宽/左右的特例，不要求面积相等；用户明确给定的目标与方向优先。
- **成功以提交后的实际归属为准**。创建、拆分、移动与重排不能用过时计划的 Tab/Region 身份宣称成功；源、目标、树叶、内容索引和焦点必须一致。异步创建期间布局变化不得覆盖较新的布局；Agent 已经健康启动但展示目标失效时，保留其 Session 可发现性并明确说明当前落点或未展示状态，不因为布局流程失败停止它。
- **独立布局包必须是真正的唯一实现**。通用树结构、几何、方向、分割、移动和不变量属于可独立使用、无 React/Electron/Agent 依赖的布局包；Desktop 用它的公开 API 绑定内容、渲染与持久化。Workspace 的 Tab Group 树与 View 的 Region 树保持不同身份，复用同一套布局代数；不把 Session、Provider 或 Run 生命周期装进布局包，也不在 Desktop 保留第二份树实现。是否完成以独立包消费验证和产品调用为准。

## 少一步操作

- **能一下解决的，就不要让用户多点一下。** 顶部 Split 和同类仅用于展开选项的下拉入口，鼠标悬停即显示菜单，选择动作只需点击一次；不要求先点开再点选。悬停本身只展示选项，不执行命令。
- 指针从触发器移进菜单（包括间隙与子菜单）时菜单保持可用，离开后收起；禁用入口不展开。悬停不抢走编辑器或终端的输入焦点，Escape、外部点击和选择后正常关闭；点击、键盘与触屏仍能完整操作。同一时刻只显示正在使用的菜单。
- 直接执行的按钮仍直接执行；右键菜单、编辑弹窗与需要确认的动作不改成悬停执行。悬停菜单继续使用既有原生 Browser 让位与资源订阅的开关，不留隐藏遮挡或后台采样。
- Settings 窄窗分类入口同样遵守少点一步。鼠标悬停触发器、分类项，跨项和间隙到离开，全程只展示选项，不切换分类、不保存，也不夺正在编辑的输入与光标；自然收起或 hover Escape 保留原输入。鼠标明确选择不同分类后关闭；没有用户或动作已建立的新焦点时，焦点回到连接且可见的分类入口，键盘开启后的 Escape 同样返回该入口。外部点击或动作已经建立的新焦点不被拉回。分类切换保留已访问页的未保存草稿和阅读位置；禁用、搜索筛选及点击、键盘、触屏的完整操作仍成立。

## Tab、Tab Group 与 Region

- `View` 是用户认知里的一张完整工作视图，在 Desktop 中表现为一个 Tab。
- `Tab Group` 用来整理整张 View；移动 Tab 不改变 View 内部内容布局。
- `Region` 是 View 内的内容 leaf，可展示 Agent、Terminal、File、Browser 或 Launcher。
- `split-left|right|up|down` 只修改当前 View 的 Region 树；`placement=tab` 只在用户明确要求时创建新 View。
- Workspace 保存 Tab Group 树，每个 View 保存自己的 Region 树。两个树使用不同 ID、焦点、resize 状态和操作入口。
- **眼前的分屏比例必须与已保存布局一致。** 用户或公开 Control 追加、重排及改变分屏比例后，已打开的原 Region 立即按同一布局显示；不能只写持久树、等重启才变成真实尺寸。拖动仍由原分隔条表达当前意图，不被过时投影拉回。同步尺寸保留 Tab、Group、Region、焦点、原内容实例与健康 Run；普通重启在同窗口尺寸与字体条件下恢复同一最终比例和终端网格。
- **应用重启必须先恢复持久化的 Tab Group/Region 拓扑，再恢复其中的 Session 投影**。Tab、分组、Region、焦点和 split ratio 是用户工作面的 durable 索引，不能因为 Runtime 首次快照暂时为空、恢复探测超时或恢复流程报错而被写回空布局；健康 Agent 的流程故障只留下可见服务窗告示并保留原 Region。只有 Core 明确报告 Session 已退休，才能移除该 Region。
- **正常退出、重装与重新打开必须继续读取原工作面的实际持久化归属**。既有工作面的存储记录或物理目录未确认时，不能把新建的空数据库称为原工作面已经恢复；路径配置、内存里的工作面与跨进程可读的持久记录分别核实，保存或恢复缺口持续说明且不拿走健康 Run 的能力。原始备份与真实拓扑的有限恢复保留草稿、身份和未知输入，不自动补发；从旧备份取不到的较新编辑明确未知，找回工作面不能代签原存储缺失的根因已经修复。
- **重开应用不能仅凭旧“未认领”标记停止原本健康的 Terminal**。持久化的未展示／归属待查记录不是新的用户停止意图；启动时已观察到的 Run 保持可查、可接回，已退出和状态未知分别如实说明，不把它们统统隐藏，也不凭标记新建工作视图。当前用户明确取消本次刚创建对象时，清理只针对本次已经确认的精确 Run；旧标记不能替代这个归属与意图。
- **恢复不能把旧进程的生命周期租约当成仍在运行**。启动新进程时必须回收 owner PID 已退出、租约已过期或属于本次重启的未完成 lifecycle reservation；只有能证明旧 owner 仍活着的租约才报告“运行在其他进程”。判断不清时保留 Session/Region，并明确提示正在等待归属核验，不得静默丢失或伪造新 Session。
- **退役 Run 记满了，不能把整次启动判死。** 用户原话：「刚才打包以后启动就失败了」。新进程回收未完成的停止租约时，必须把这次停止落进账本：该 Session 记成用户退役，它的 Run 进入有上限的退役 Run 环。环满时丢掉最旧的 Run，并同时丢掉只指向这些 Run 的退役 Session——这是容量到顶，不是账本损坏。刚刚停下的这条 Session 的退役记录必须留下。不得因为挤掉了旧记录就让停止落账失败、整窗退出。同一身份仍在当前 Session 里，才是真冲突，继续拒绝。
- **界面就绪握手只证明新页面已挂上。** 用户原话：重启电脑后还是报 `Updated interface did not become ready`。打包启动要等渲染进程回报就绪，这个回报只表示页面已加载且 IPC 可用。恢复 Session、重绘终端这些启动工作在握手之后继续。不得把「全部恢复跑完」当作启动放行条件；恢复慢或超时走服务窗，不整窗退出。
- **关闭当前格、按序号切 Tab、分屏、切换焦点格都必须能纯键盘完成**，不该只有鼠标一条路。窗口级只补这四个高价值动作，**不建 action catalog、不做用户改键**——那是预防性抽象，与"最简实现"相悖。键位跟随成熟终端/编辑器的既有惯例而非自创：关闭当前 Region 用平台的关闭键（mac `Cmd+W`／其他平台 `Ctrl+Shift+W`），按序号切 Tab 用 `Cmd/Ctrl+1..9`（第 9 键恒指最后一张），分屏用 mac `Cmd+D`（右）/`Cmd+Shift+D`（下）、其他平台 `Ctrl+Shift+E`（右）/`Ctrl+Shift+O`（下），切换焦点格用 `Cmd/Ctrl+Alt+方向键`。**平台底线：非 macOS 绝不接管裸 `Ctrl+字母`**——那些是 shell/readline 的地盘（`Ctrl+W` 删词、`Ctrl+D` 是 EOF），接管会让用户在终端里丢掉肌肉记忆；数字与 `Ctrl+Alt+方向` 不落在 readline 键上，可安全使用。新键位不得与终端作用域键（`Cmd+F/C/K`、`Shift+Enter`）冲突，冲突判断按键位比对、不靠猜。判定与落点解析写成纯函数、组件只做注册与 `preventDefault`（本仓库 `renderToStaticMarkup` 不跑 effect，写进组件的分支断言够不着）；只测判定不够，**必须有接线测试**——删掉注册调用要让断言变红。焦点格的"相邻"按屏幕几何（Region 归一化 bounds）判定，不按分屏树的父子深度，与上文「哪个算右边」同一处轴向定义。

## 单格临时铺满 Tab 后还原

- 用户读终端或 diff 时，可把当前一格临时铺满所在 Tab 的内容区，再恢复原分屏；其他 Tab Group 和窗口工具区不受影响。只有一格的 Tab 不提供无意义的铺满动作。
- 原分屏树、比例、Region 身份和内容保持原样，铺满不是关掉其他格或重新打开终端。未保存文件、草稿、历史、Session 与 Run 仍归原 owner；隐藏格不可交互，并沿既有可见性约束暂停原生表面及尺寸同步，不把零尺寸写给健康 PTY。
- 铺满跟随该 Tab 的现有焦点，不再保存另一份目标或旧焦点。切到另一格时它成为铺满格；还原保留当前焦点。铺满期间方向导航仍按原分屏几何定位；显式新增、删除、换位、重排或拖动比例先退出铺满。
- 原树、比例、焦点与铺满状态一起耐久保存；普通重启后先恢复工作面，再接回原 Session/Run。变成单格时不保留无意义的铺满状态，未知 Runtime 事实不能删原 Region。
- 按钮、Region 右键菜单、既有快捷键入口和 typed Control 表达同一操作。inspect 区分原布局几何与 Tab 内当前呈现几何：铺满格占整 Tab，隐藏格当前 bounds 为 null；null 只表示在该 Tab 内隐藏，不表示 Region/Session 不存在。布局结构缩略图明确展示原结构。
- 局部显示或尺寸握手失败留下范围明确的服务窗，健康 Agent 仍能输入；铺满/还原不启动、恢复、停止或替换 Run。

## 寻址与复制

- 用户要求「包括 hover 在内，出现项目路径的地方」都遵守设置中的路径转换。所有客户端自行呈现的项目／工作区路径，包括 hover，其正文、摘要、tooltip、菜单与复制同时遵守现有路径样式设置，范围包括 Explorer／Git、相邻 Sidebar／Launcher 和其他确实呈现该路径的 typed metadata；同一准确资源在这些入口采用同一偏好，不再出现正文已缩写而 hover 又露出另一套路径风格。只改变表示，资源身份、原始路径、Host、文件事务、执行 argv 与 Runtime 字节保持；相对路径仍保其真实坐标，不为视觉拼成另一资源。不对文档、Markdown、终端或任意系统字符串猜路径。缩写继续只依据所属主机与真实 home，本机其他用户、未知 home 和远程路径不猜；原边界见本节路径缩写条目。Explorer 的去重与视觉唯一见密度文档[《Explorer 与快捷输入区》](../presentation/conversation-input.md#explorer-与快捷输入区)。

- **终端的每一档复制范围，读的必须是真能回答它的那个缓冲区。** 全屏 TUI 会把终端切到 alternate
  buffer（DECSET ?1049），那里按定义只有一屏、没有回滚；滚出去的历史留在 normal buffer 里，而
  `buffer.active` 此刻并不指向它。所以「复制可见输出」读 active——它问的就是"现在屏幕上有什么"；
  「复制全部输出」读 normal——它问的是"这个会话到现在输出过什么"，这个答案不该因为某个程序占用了
  alternate buffer 就缩水成一屏。判据只能是终端自己的缓冲区模型，不能是"哪个 Agent 在跑"：同一条
  规则必须对任何占用 alternate buffer 的程序都成立，实现和测试里都不得出现具体 Provider 名。
  这是 #638 的补全——那次正确地从选区服务换到了缓冲区数据 API，但没察觉 active 这个指针在同一条件下
  本身就是残缺的，于是修好了不吃满 alternate buffer 的那些 Agent，留下了真·全屏 TUI 的那些。
- **取不到内容就要说出来，不能静默返回。** 复制路取到空字符串时，既不写空剪贴板，也不假装什么都没
  发生——说清哪一档范围是空的、另一档还能用。Agent 是好的、字节是全的，坏的是我们这一步取值，按
  [健康能力与未知状态：流程降级](../../../AGENTS.md#健康能力与未知状态)，它必须可见而不阻断。
- **分享对象地址时，复制的是一个寻址方式。** 接收方（人或另一个 Agent）仅凭这份分享就能识别对象身份并执行准确命令，无须猜 ID 层级、flag 或回头问人。普通路径、URL、代码选区、终端输出与分支名的直接复制仍按其原任务生成内容，不包成身份名片；明确面向 Agent 的上下文分享按本节共用外框呈现。
- **三类地址回答三个不同的问题，绝不互为别名**（与上文 Session/Run/Tab 的身份边界同源）：
  - **Session** 回答"**哪个 Agent**"——Provider 语义身份，跨 Tab 稳定，一个 Session 可同时投影到多个 Region 与多个 Tab；
  - **Region** 回答"**哪一格内容**"——Tab 内的精确内容 leaf；物理位置命令必须使用已知准确 Region 与原展示上下文，不从一个 SID 猜唯一位置；
  - **Tab** 回答"**哪张完整工作面**"——只有其中恰好一个不同的 Agent Session ID 时才可用于语义发送；同一 SID 的多个 Region 投影仍是一个 Agent。既有 View 用语不形成另一层身份。
- **amux sharing 使用紧凑、共用的对象卡片。** Agent 名片以 `--- amux : IDCard ---` 开头，Region／Tab 地址分别以 `--- amux : Region ---`／`--- amux : Tab ---` 开头，统一以 `-----` 结束。`ID: <原对象 ID>` 是准确身份；Agent 的 ID 始终是 Core SID，显示名与执行选择只作为真实 metadata 展示，不能参与寻址或替代原 ID。未知 metadata 不猜，展示文字中的换行与控制字符不能伪造额外字段或命令。名片中的声明不认证作者，发送身份继续由 Core 校验。
  - `Exe: <原生 Session ID> | <Executor 名> (<Provider 名>)` 展示执行器内的原生会话身份与实际执行选择，顺序固定。原生 ID 只取同一 Core Session 已确认的 `nativeHandle.sessionId`，Provider 与 ACP handle 均适用；合法绑定由 Core 持有，client 不另加 Provider 协议判断。缺少已确认 handle 只写 `?`，不以 Core SID、Run ID 或 Agent alias 补位。Executor 名来自原配置，Provider 名来自原 catalog；缺名称但已知原 ID 时显示原 ID，未知项写 `?`。Core SID 仍是 amux 寻址身份，`Exe` 不替代它；字段值转义且不改原值，不声明进程健康、作者认证或授权。
  - 每条指引占一行，以 `# ` 开头，给出完整公开命令而非 `to ...` 等自创缩写。Agent 名片只保留按 SID 的 `amux agent send --to-session='<SID>' --text "..."` 和 `amux --skill` 两条指引；查看 Agent 及其他能力由 skill 按需发现，不常驻长篇身份解释。短可执行名 `amux` 必须正式指向同一公开 CLI 程序，命令树、权限与错误事实只有一份，不依赖用户另配 shell alias。当前可用性以实际构建的 `--help`／`--skill` 为准。
  - Region／Tab 卡片只给出对应的 `space inspect` 和 `--skill` 两条指引。空间卡片不默认提供语义发送命令，避免把会更换内容的格或含多个 SID 的工作面冒充某个 Agent；显式空间发送能力与消歧规则保持。
  - 已知准确点击 Region 时，Agent 名片可增加 `Region: <原 Region ID>`；没有准确 Region 就省略，不从 SID 猜投影。空间检查、导航、移动与目标选择由 `--skill` 按需展开，不在每张名片复制动作清单或移动模板。复制本身不发送、不导航、不改变焦点、展示或健康 Run；后来导航仍沿公开默认保留输入与原 SID 校验移动合同。
  - 对象卡片骨架、命令格式和 shell 转义来自无 UI 依赖的同一公共出口，Desktop 菜单、其他 client 与寻址失败恢复均可复用；各入口只提供原 owner 已确认的事实，不另查位置、造 registry 或重拼命令。剪贴板写入仍归 client，路径表示、代码上下文和终端 bytes 仍归各自原出口。
- **已有的 Agent 上下文分享复用同一外框。** 编辑器的 Copy as Agent Context 以 `--- amux : File ---` 开头，Browser 的元素／批注上下文以 `--- amux : Browser ---` 开头，均以 `-----` 结束。它们是内容与来源分享，不冒称 Agent 身份，不强加 `ID`、`Exe` 或无关发送命令；外框只包原 owner 已产出的正文。
  - File 保留原工作区相对路径、起止行、语言围栏和所选代码；Browser 保留真实页面、元素／选区与批注来源、原顺序和原内容上限。格式器不读取文件或页面，不解析正文、不改原文或提升正文中的声明为身份、授权和可执行指引；范围、内容预算、复制失败反馈与重试继续由原 owner 执行，正文上限不能靠增加外框被绕过，最终外框须完整闭合。
- **歧义在源头消除，不甩给接收方**。一张 Tab 承载多个不同 SID 时，整张 Tab 不能唯一指定消息收件人。右键已知某个 Agent 的那一格时，Agent 名片直接给出其语义 SID，并把已知准确 Region 作为独立空间位置提供；不能让接收方先撞 `MESSAGE_TARGET_NOT_UNIQUE` 再挑候选。同一 SID 的多个投影不构成语义发送歧义；精确位置查询、导航和移动仍不能据此猜成唯一位置。
- **复制入口按其能消除的歧义就近放置**。显式“复制 Region 地址”仍产出物理 Region 地址；Region 菜单的“给这个 Agent 发消息”名片同时提供该 Agent 的 SID 和已知准确 Region，不取当前焦点。Tab 菜单的显式 Tab 地址用于检查整张工作面；只有唯一不同 SID 时才给 Agent 名片，没有准确 Region 就不取首格。同一 Session 的语义命令从 Region、Tab、Roster、终端入口产出一致，已知位置另行标明。
- **复制出来的路径默认用 `~` 表示当前用户的家目录，可切回绝对路径。** 用户原话：「现在我复制路径的时候，经常会复制出这样的 `home/proj/github/pi`，但是前面的其实就是 user 嘛，就是我当前的 user 嘛，所以这种情况下复制出来是波浪线就更好……但这是一个风格上的选择。我个人喜欢波浪线，所以我们可以把它弄成一个设置项：默认是波浪线，但也可以支持用户配置这种绝对地址」。它与本节第一条同源：复制出去的东西要**便于人和 Agent 直接用**，而家目录前缀对双方都是机器记法——`pi` 在任何 shell 里都成立，且不把用户名带进被粘贴的文本。默认缩写、开关可关，用户原话即判据。
  - **缩写只在"这确实是当前用户的家目录"时发生，判据是真实 home 值而不是路径长相。** 不得用形如 `任意用户目录前缀` 的正则去猜（那会把**别人的**家目录也改写成 `~`，粘给对方时指向错的地方）。边界必须是 `home` 本身或 `home + '/'`，不是 `startsWith(home)`——否则 `${USER_HOME}OTHER/x` 会被剥成 `~OTHER/x`，一个看起来合法、实则不存在的路径。这条与 Terminal 路径识别那侧的根内判据同源，两侧不得各写一份边界。
  - **远程主机的路径绝不套用本机家目录。** Workspace 可以挂在 SSH 主机上，而"我的 home"是本机事实；把本机 home 从远程路径上剥掉会产出一个在对面根本不存在的路径。所以缩写以**该路径所属主机是本机**为前置条件；非本机一律原样给绝对路径。这属于"分不清就如实说"的同一条纪律：宁可长，不可错。
  - **一个概念一个出口。** 今天"复制路径"有多处各自拼接（其中若干直接把绝对路径递给剪贴板，绕过了既有的路径格式化出口），这条能力**必须先把它们收成一处**再实现缩写；分散实现意味着开关只对一部分入口生效，而用户看到的是"有时缩写有时不缩写"。已知的相邻事实：剪贴板写入本身已经只有一个出口，但它同时承载终端选区与分支名等非路径文本，**不是**缩写该发生的层——缩写属于"路径怎么表示"，不属于"文本怎么写进剪贴板"。
- 复制的地址**只使用公开对象 CLI 与 Control 面接受的寻址方式**（`agent send` 的 `--to-session` / `--to-region` / `--to-tab`、`agent inspect --session` 和 `space inspect` 的对应空间 flag），不为复制发明第二套语法。地址里的 id 一律按 shell 语义转义，使带空格、引号或像 option 的 id 粘贴即可执行，命令不得改变原值。
- **Tab 发送消歧与精确回执同源。** 消息按不同 SID 聚合，一个 SID 的所有 Region 候选完整保留；同 SID 多投影只入队和提交一次。多个不同 SID 或零 Agent 时给出合法 typed candidates，不能让错误回执自身成为协议错误。已捕获的收件人、Run 条件与消息身份保持，后来位置变化不能改投替换者、自动重发或谎称当前呈现已确认。

- **按意图给入口命名，而不是按地址种类。** Agent 名片按 SID 给出准确发送命令，检查能力由 skill 可达；已知点击 Region 按本节紧凑格式附其准确位置。显式 Region／Tab 地址用于空间操作和分享／检查工作面，不代替语义身份。不同名称的名片入口仍消费同一对象格式，不能把复制文案冒称已经发送。
- **每一处能看见某个 Agent 的地方都要能寻址到它，TUI 里面也算**。用户原话：「现在右键 TUI 上，实际也没有办法复制出某个 agent 自己的身份，这样就不方便和他通信」。Region / Tab / Roster 三处右键已经有「给这个 Agent 发消息」与「复制 Session 地址」，而**终端画布自己的右键菜单没有**——于是用户正在跟这个 Agent 对话、光标就在它的 TUI 里，却必须先离开这块画布去别的菜单里找它的身份。这不是缺一种地址，是同一份真相少接了一个入口：终端画布上的右键**知道自己是哪个 Session**（那一格就是它），因此它是最不该缺的那个入口。
  - 入口按上一条的意图命名规则呈现，复用本节同一个公共格式化出口，不为终端另拼文本。同一 Session 从终端、Region、Tab、Roster 等入口复制出的语义身份与寻址命令逐字一致；已知 Region 另行标明，没有准确位置就不猜投影，显示 metadata 取原 owner 的同一解析结果。
  - **终端菜单里这一项只在这一格是 Agent 时在场**。终端 Session 没有 Agent 身份可寻址，给它画一个灰掉的「给这个 Agent 发消息」是在承诺一件不存在的事；缺席即如实。
  - 终端菜单原有的三个 Copy 回答的是「**画面上有什么**」（选区／可视区／回滚），这一项回答的是「**这是谁**」。两者不是一族，因此**分隔线分组**，不混在复制文本那一簇里——否则用户会以为它复制的是终端内容。
- **多个 Agent 并排且只有图标时，必须有一个不靠颜色的判别器**。用户原话：「我们那个 agents 的图标可以根据 provider 的图标做一些色彩、正片叠底、追加角标之类的操作……要不然有点难以辨认不同的 agent alias」。这条与上文「颜色在同 provider 的 A2A 下不足以区分身份，判别器必须是名字」同源，但补的是它没覆盖的那一半：**那条结论假设名字在场**（`aria-label` 与 hover 面板），而叠压头像簇里名字只在 tooltip 里——肉眼扫过去时三个通道（形状、颜色、名字）**一个都不可用**，因为同 provider 共用一枚品牌图标、颜色会撞、名字要 hover 才出。
  - **判别器是名字的可见投影，不是第二种配色**：取显示名的首个字素簇画成字母牌，与 provider 图标**同时在场**（图标答「哪家」，字母答「哪一个」）。字母来自名字，所以它继承了名字作为判别器的全部理由，而不新增一个会撞的通道。
  - **取的是显示名，不是 executor label**。用户拍板：「跟你看到的那个名字一致」。判据是**牌面与用户在 Tab 上读到的那个字必须是同一个**——牌子的全部价值在于「我认得这个名字」，而显示名才是用户脑子里那个名字；重命名一个 Agent，牌面立刻跟着变（身份没变但**称呼**变了，而牌子画的正是称呼）。取 executor label 会让牌面与 Tab 上的名字对不上，那是两个真相。
  - **前置条件：名字要先到得了这枚头像，而这是一条独立的、优先级更高的缺陷。** 上一条不是偏好，它是这条能力的**前提**，而今天这个前提不成立——叠压簇拿到的 `label` 是 `session.label`（Main 建的 `executorLabel · workspaceLabel`，即优先级链**最低**那一档），不是链求值后的显示名。于是把字母接上去会同时踩中两件事：它取的正是上一条明令禁止的 executor label；而对「同 provider 多个 Agent 同一目录」这个**唯一要解的场景**，两段串完全相同，每一枚都画同一个字母——用户报的「难以辨认」一字未动。
    - **这条缺陷不止于字母，它现在就在伤人**：那串兜底名同时是头像的 `aria-label` 与 tooltip，所以**读屏与悬停也读不出是哪一个**。即使最终决定不画字母，这一处也必须修——它比"没有字母"更基础。
    - **绕过命名链的不只这一处**（Agents 工具栏列表、快速切换器、Board 均直接用 `session.label`）。逐处修不是本条的要求，但**新增任何显示 Agent 名的表面都必须经那条链**，不得再添一处绕过。
    - 顺序因此是：**先让显示名到达这枚头像**（经既有 `resolveAgentName`，不在面板里重拼），再谈画不画字母。**不接受「先按 label 画着、以后再换成显示名」**——那正是本文档反对的临时方案，且它交付的是一个看起来在场、实则判别力为零的通道。
  - **牌面与 provider 图标同处一格是取位问题，不是尺寸问题。** 曾在此写过「字母受 10px 下限约束、18px 格子塞不下、须先整体放大」——实测推翻：10px 就是字号刻度的最小合法值（`--fs-micro`），而低于 10px 的具名例外被一条恒等断言冻结在 7px、且每条都必须真画 `content` 字形，所以字母**走不到也不需要**那条豁免；`.project-rail-row__icon[data-monogram]` 正是在 **16px** 格子里画 10px 字母，一直合规。头像格因此不必为字母放大。真正要解的是**一格之内两个记号怎么共存**，而本仓对「第二个记号」的既有答案是**角标溢出格外**（注意力那枚 `?`/`!`：8px 见方、`top/right: -3px`），它不以牺牲品牌图标为代价。若字母取这个位置，须先处置与注意力角标的同位冲突——那是取位裁决，不是密度裁决。
  - **正片叠底与「给品牌图标染色」明确否决**。品牌图标里有两家是硬编码品牌色而非 `currentColor`，叠底会把它们染歪；而它解决的正是那个已被实测判定为不足的颜色通道。色相**继续只做扫视分组线索**，沿用既有派生（让开语义色的那套），不新造调色板。
  - **角标位要先数清空位再占，且要按样式表数、不按注释数**。叠压簇里头像四角的实占情况：**右缘**被右邻座压掉（`.slot + .slot` 的负 `margin-left` 配合 z-index 左→右递增，是**右压左**，所以被盖住的是自己的右缘、左缘反而画在上面）。dock.css 里那句「叠压是右压左」与「左缘被邻座压掉」自相矛盾，**以样式表为准**——这类几何断言必须从规则反推，照注释抄会把方向记反。
    - **此前这里把记号数成三种，漏了一种，于是"两条左缘都空闲"是错的**：用户自定义徽标（`.agent-avatar__badge`）一直占着左上。可见角只有左上、左下**两个**，而记号有**四种**（注意力、归并计数、自定义徽标、字母牌）。分配裁决与排序理由见[密度合同](../agentmux-surface-density.md)那条"叠压头像簇的角位分配"，不在此复述。
    - 对字母牌的结论因此不变且更强：它**不是第五枚角标**，可见角本就不够分。真正的出路是上一条说的换载体或另给尺寸，而不是找一个还没被占的角——右下角那个位置只是登记占位，它恰好是字母牌最需要被看见时（簇里有多枚）必然被盖住的那一角。
- **失败结果要自带下一步命令，而不只是候选清单**。`MESSAGE_TARGET_NOT_UNIQUE` 已经带 `candidates`，但候选清单仍要求接收方自己拼出命令——那正是"歧义不甩给接收方"这条原则在错误路径上的漏洞。因此这类失败要额外返回**可直接执行的恢复命令**；stale View、目标不是 Agent、Agent 已退出各自给自己的恢复入口。恢复命令与复制出去的地址**共用同一个格式化出口**，不为错误路径另写一份拼接（两份拼接会各自演进，且漂移时不会有测试变红）。
  - **恢复文本挂在控制错误的出口层，不挂在抛出点**。同一个失败码往往有多个抛出点（`TAB_NOT_OPEN` 与 `REGION_NOT_OPEN` 各三处），在每个抛出点拼一次恢复文本，必然随时间各自演进，而漂移的那天不会有任何测试变红。控制错误离开渲染进程只有一个出口，恢复文本要说服的正是**出口对面那个调用方**——所以那一层是它唯一该长出来的地方。
  - **哪些码算"寻址失败"由地址模块自己判定，出口层不列第二份码表**——两份码表同样会漂移。不属于寻址失败的码**不附加恢复文本**：一句放之四海的"再试一次"既没有信息，又会盖住原始 message 里真正的原因。
  - **恢复命令只用已通过校验的候选**。未校验的 id 可能带换行或保留字，会把恢复文本切成一段执行不了、甚至误导人的命令——那比不给恢复更糟。
  - **给出的每一行命令都必须真能跑；给不出就不写命令**。"下一步"的价值全在于粘贴即可执行，一条命令形状但跑不了的文字比不给更糟——它看起来像出路，用户照做撞的是第二次失败。判据不是"读起来像命令"，而是用实际 CLI parser 逐行校验对象、动词与必填项：`agent inspect`／`space inspect` 有准确选择器，`agent send` 除选择器外还必须带 `--text`，列实际 Session 用 `agent ls`。检查共用出口的命令，不能只匹配一段看似正确的前缀。
  - **守卫的粒度必须细过它要防的那个 bug**。上一条的裸 `inspect` 修好后，形状表把 `send` 与 `inspect` 合写成一条，于是漏掉 `--text` 的 `send` 又一次照样匹配——同一个洞换了个位置复发。凡是修"断言太粗"，都要回头检查同一条断言里还有没有第二个粗的地方；不同动词有不同必填项，就不能共用一条形状。
  - **写"下一步"之前，先证明这个失败是怎么到达的**。判据是抛出点外层的分支条件，不是错误码的名字。`AMBIGUOUS_REGION_TARGET` / `AMBIGUOUS_TAB_TARGET` 听起来像"你给的地址匹配到多个"，实际只从 `self` 分支抛，真实含义是"发起方自己同时显示在多处"——显式 id 走不到那里（Region id 是 UUID，全局唯一）。按名字直觉写出来的文案会让用户去改地址，而问题出在"我在哪"这个前提上：**一条方向错的下一步比没有下一步更糟**。这类文案要用语义断言钉住（必须点名 `self`，不许套用另一个码的说法），形状断言（"命令能跑"）对措辞错误一视同仁，抓不到张冠李戴。
  - **这条判据对复制侧与恢复侧同时成立**。"粘贴即可执行"本就是复制这件事的全部意义，而它一度只被施加在恢复文本上：改掉命令出口的 `--text`，三个地址的复制断言纹丝不动，因为它们只校验到 id 就收手了。共用出口的两侧，判据也要共用同一个校验函数，各自带"检查了几行"的下界防"一行都没检查"。
  - **有些失败本来就没有对应的命令，如实承认**。恢复层只拿得到错误码，拿不到 tabId、regionId（抛出点没带过来）；而 View / Region id 本就是界面上的临时身份，关掉即失效，CLI 无从重建。这类失败的诚实下一步是**界面里的动作**（在那一格上右键重取地址），外加一条真能跑的旁路：Session 跨 View 稳定，用它照样够得到同一个 Agent。
  - **列实际 Agent Session 与列已配置 Executor 是不同动作。** 前者用 `agent ls`，后者归 `settings executors ls`；unknown／unavailable 保持真实，列表不擅称全部仍活着。两者即使命令都能跑，也必须校验下一步与错误原因的语义对应。
- **「左边/右边/上面/下面」在创建时是分栏，在查看时也能落到 Tab**。用户原话：「当描述"右边"、"左边"的时候，除了识别 region，也可以去识别 tab（也就是 tab 的关系也应该能查到）」「如果要创建一个"左边、右边、上面、下面"，那应该就是 split」「但如果让他去查看"左边、右边、上面、下面"的时候，如果没有 split，tab 应该也要能识别」。今天方向只存在于 `open` 的 `destination`（`{kind:'split', region, direction}`），`inspect` 一侧根本没有方向这个概念——于是 Agent 能造出一个右边，却问不出"我右边是什么"，除非那一格恰好是它已知 id 的 Region。
  - **创建与查看的默认落点不同，这是有意的，不是不一致**：创建一个方向只有一种诚实解释——用户要多一格，那就是 split（新开一个 Tab 不叫"在右边"）；而查看一个方向时，屏幕上"右边"的东西可能是同一 View 里的另一格 Region，**也可能在没有分栏时就是 Tab 条上相邻的那张 Tab**。查看端拒绝回答"没有分栏所以没有右边"，等于对着用户眼睛看得见的东西说不存在。
  - **优先级由"屏幕上更近"决定：先 Region 后 Tab**。同一 View 内有分栏时，方向解析必须落在 Region 上——那才是用户视线里紧挨着的那一格；只有当该方向上没有兄弟 Region 时，才退到 Tab 邻接。反过来（先 Tab）会让一个分了栏的 View 把用户指向另一张 Tab，与所见不符。
  - **上下方向对 Tab 不成立**。Tab 条是一维水平序列，"上面那张 Tab"没有所指；此时如实回答该方向没有邻居，**不许把 up/down 悄悄折成 prev/next**——那会让 Agent 以为自己拿到了上方的东西，实际拿到的是左边那张。
  - **"哪个算右边"只有一处定义**。创建与查看做的**不是**同一件事——split 是在 Region 树上劈开一个节点，查看是在已排好的版面上找邻居——但两者对 left/right/up/down 的**轴向解释**必须来自同一处（横向轴属 left/right，纵向轴属 up/down）。方向查询自身写成纯函数，从既有的版面几何（Region 的归一化 bounds）与既有的 Tab 序列推导，不为它另建一份布局真相；否则漂移时只表现为 Agent 偶尔寻址到隔壁，而没有测试会红。
  - 这是**寻址能力的补齐，不是新身份**：解析结果仍然是既有的 Region 地址或 Tab 地址，走既有的 `--to-region` / `--to-tab`，不发明第四级地址，也不新增 surface kind。
- 后台 Agent 由 Agents 工具重新发现和打开，不建立第二份 Session Registry。
- **Agent 自己就能把 terminal、browser 或文件开到某个方向的分栏里**，走的是既有的 `open` / `arrange` CLI——那已经是"Agent 驱动界面"的接口，**不新建第二条通路、不新增 surface kind**。缺的从来不是能力而是发现：因此由启动时注入的提示负责让每个 Agent 知道这件事存在、并知道去哪查确切用法，而**不把完整 CLI 语法抄进提示**（那会与 skill 争夺唯一真相，并在语法演进时立刻过期）。这条的验收是行为断言——证明启动路径确实携带了该提示，而不是断言 skill 文本里含某个字符串：后者在改动前也会通过，证明不了任何事。

## 顶部与项目栏

- 左侧状态汇总的 running/error 数量采用紧凑语义图标与短数字；hover activity 面板展示 Provider 图标、最近活动摘要与停止时长，信息密度优先，不重复完整会话正文。
- 左侧项目菜单使用较轻字重与明确的层级、状态和图标语义，降低装饰性重复信息；Status Bar 内的 Agent 状态采用低调的语义图标与短标签，不再使用“点+数量”作为唯一表达。
- **最左侧 Projects 栏支持拖拽调宽**。用户可从项目栏与主工作区的边界拖拽改变宽度，拖拽过程中项目内容即时适配，松开后保留最终宽度；边界提供可发现的 resize affordance、键盘焦点与可访问名称。调宽只影响 Projects 栏，不改变 Workspace Tools 或主工作区布局；收起和恢复沿用同一份宽度状态。
- **文件树目录是可操作的项目入口**。目录右键菜单提供“作为项目打开”：把该目录注册为新项目并立即切换到该项目；动作只对目录显示，复用既有 Workspace 创建/选择 seam。失败时保留当前项目，并用持续可见的服务窗提示说明恢复动作。
- 用户对 Space「顶部 icon 有两层、有多余标题、目录和功能区没有 `+`」的反馈同时约束 Workspace tools：工具选择和工具创建必须各有清楚作用域。Agents 的就地 `+` 打开已有 Launcher 让用户选择 Executor；Files 已有 New File、New Folder 和刷新动作继续在文件工具的原上下文生效。不为所有工具发明一个无定义的通用 `+`，不因收敛标题重写文件树，没有可用创建动作的工具不显示假按钮。Browser 的创建、导航与管理在所在工作面就地可达，各入口复用同一 Browser 动作与配置 owner；不以管理操作强制进入 Survey。项目 Browser 的「在 Survey 进一步研究」创建及成果整理只见[《Survey、临时 Zone 工作面与知识入口》](#survey临时-zone-工作面与知识入口)。工具切换、菜单开合和创建失败保留原工作面与健康 Session。视觉层数和重复标签约束归密度 SSOT[《顶行与 Tabbar》](../presentation/spaces-and-layout.md#顶行与-tabbar)。

- macOS 红绿灯之后固定放 Projects 与 Workspace tools 两个开关，顺序和位置不随面板状态变化。
- Session 的顶层 Tab 组始终直接占据窗口最上方的 Tabbar。单 Pane 时它与窗口顶行合并；分屏时也不再额外预留一条空的全局 chrome 行，由左上方的首个 Pane 承载一次必要的窗口 chrome，其余 Pane 只保留自己的紧凑 Tabbar。
- Project Rail 底部并排放 Settings 与键盘帮助，展开和收起时均可直接访问。
- **项目行回答三件事：哪个 Project、在跑几个 Agent、要不要你**。尾部的数字是**当前在跑的 Agent 数**，不是这个项目有几个 worktree——用户扫这一栏是在找"哪儿还有活在动"，仓库有几个 worktree 属于结构事实，答的不是同一个问题，进 tooltip。零不显示数字，只有真在跑才占位。Host 同理：本机是绝大多数情况，每行都写一遍 `This Mac` 不携带信息，只有远程 Host 才值得占一个位置。
- **Branch/Worktree 条与 Topic 条是同一种交互，但不是同一份真相**。两者都是"挑一个条目 → 进到一组 Tab、每个 Tab 是一套 Region 分屏"，因此**表现层共用**（见密度合同[《控件语言》](../presentation/shared-rules.md#控件语言)）。但选中真相不同且必须保持不同：Branch 切换换掉的是 `activeWorkspaceId`——一个 worktree 本身就是一个 Workspace，天然拥有自己那份 layout；Topic 全部共享 Scratch 这一个 Workspace 的同一份 layout，切 Topic 是把它**投影**成只含该 Topic 的那组 Tab。不得为了"看起来统一"把 Topic 也提升成真实 store 字段，或把 Branch 降成投影——那会给同一件事造出第二份真相。
- 窗口底部有且仅有一条**跨会话注意力汇总栏**，横跨整宽。窗口里其余每个状态指示都是**有作用域**的——Tab 状态点只讲一个 Session，Board 列只讲一个 Project，Agents 工具的总数只讲一个 Workspace 且只在其工具坞打开时。这条栏回答它们都不回答的那一个问题：这整个窗口里（含折叠的 Pane、其他 Tab Group、其他 Workspace），现在有没有 Agent 需要你。它只在窗口至少投影一个 Agent Session 时出现，否则完全不占位。它是聚合而非某一个 Session，因此没有诚实的 `status.source`/`observedAt` 可交给 StatusDot——绝不伪造证据，只复用共享状态语汇（同一套点与颜色），使这里的一个点与 Tab 上的点含义完全一致；计数为零时保持中性灰。"需要你" 与 "错误" 两段是动作：点击跳到该注意力类别里 `status.observedAt` 最早、即最早观察到该待办的 Session；聚合计数写进这两段按钮自己的可访问名，让读屏得到事实而不只是"跳转"。它只读 Store 里已有的 Session 投影，不新增任何管线。
- 汇总栏的**总数段是名册的展开入口**。栏回答"有没有需要你"并跳到最早观察到待办的那一个；名册回答"都有哪些"。二者是同一份聚合的两个尺寸，不是两个数字：折叠态只占那枚本已存在的计数，展开才付出空间，且关闭时展开内容不驻留 DOM。名册**只读**既有 Session 投影与 Core 已有的 pending interaction 事实，不新增 Core 合同、不建第二条消息状态机、不为待处理请求另开一个列表——待答的行就是这张表里的行。排序复用全窗口同一套语汇：needs-you 优先于 error 优先于 working，同一类内 `status.observedAt` 最早者在前，与汇总栏"跳到最早观察到的待办"的落点一致。
- 名册的每一行显示该 Agent **启动时固定的授权范围**。它来自 Core Session 记录里已持久化的 launch-option 选择，经 DESCRIBE 半边（仅 choice id）跨 IPC，标签由 Renderer 用 Provider 自己的 catalog 声明解析——argv 仍然不出 Core。两条诚实规则：创建时未收窄任何一项则**什么也不显示**，绝不写"默认"（那是无人记录过的事实）；选择所对应的 option 或 choice 若 Provider 已不再声明，该项**丢弃**而非渲染裸 id（一个 `bypass-all` 当标签显示，会像一个已核实的授权，实际却无从解析）。行上最多一枚风险标记，取该行诸范围中最宽的那一档；Provider 未声明 tier 的选项不被补成 `safe`。
- **注意力沿导航树上卷**：某一层内有 Agent 需要你时，该层的折叠行也必须表达出来，否则折起来的项目与空闲项目无法区分，"先处理谁"就退化成逐层展开去找。上卷复用同一份 Session 投影与共享状态语汇，不建第二个聚合管线；needs-you 与 error 同时存在时保留两类准确 icon+count，其他安静活动按[《Space、Folder 与 Topic》](#spacefolder-与-topic)的预算渐进展示，不靠颜色猜状态。`done` 不升级为待处理告警，`disconnected` 保持中性。
- **窗口外也能看到有几个 Agent 在等你**：macOS Dock 徽标持续显示已有全窗口 `needsYou` 汇总的当前数量，为零清除。窗口聚焦不等于请求已解决，前台也按真实数量更新；这不是未读消息或通知次数，不能另存一份待办。启动即投影当前事实，只在相关 Session 变化时更新，其他平台没有原生 Dock 时安静跳过。系统徽标更新失败通过已有非阻塞提醒说明，可在后续相关变化重试同一数量，不能影响 Agent 输入、状态和草稿。
- **通知要说清是谁、什么状态、在聊什么**。一句"Agent needs you"不足以让用户决定要不要放下手上的事——他需要知道是哪个 Agent、现在什么状态、Agent 最近说了什么、自己最近问的是什么。通知正文因此带上最近一轮对话的摘要（Agent 最近回复 + 用户最近提问），而不只是一个名字加一句泛化描述。内容从既有的 Session 投影与 Activity 时间线派生，不为通知另建一份对话记录；取不到时如实略去那一段，不填占位文字。
- **停留时长是一条滑轨，从关闭到"等待用户确认"**。用户看到通知时往往正在别处，一闪而过的提示等于没发。这条设置是一个连续的量级选择——`关闭` → 若干档停留时长 → `等待用户确认`（不自动消失，用户点过才走）——而不是一个"开/关"加一个隐藏的时长输入。默认档要足够长到用户能读完带对话摘要的正文。滑轨的取值只有一处定义，通知投递与设置界面共用它，不各写一份档位表。
- **后台 Agent 主动出声**：完成、需要你、失败三类状态跃迁在用户看不到该 Session 时升起系统通知。原生通知能力只由 Desktop Main 持有并经 typed IPC 暴露，Renderer 不直接触达 OS，也不持有第二份通知状态；点击由 Main 聚焦窗口，去哪个 View/Region 仍由 Renderer 决定。"是否值得打扰"是一个**纯判定**，由通知、上卷与名册三面共用，绝不各自从状态字段重新推导：同一状态重复上报不算跃迁（Provider 会重播状态）；首次见到不算跃迁（否则挂载到一屏早已完成的 Agent 上会炸出一串通知，教会用户忽略这个通道）；用户正在看的那一个不打扰（点与 Activity 已经在讲了）。可见与否是**派生**的而非猜测——某 Session 占据某个 Tab Group 当前活动 Tab 的一个 Region 才算在屏上，因此窗口聚焦时仍会为背后 Tab 里的 Agent 发通知。投递结果是 typed 的：`shown` 与 `unsupported` 必须可区分，平台或用户系统设置拒绝时**明确降级并只报一次**（会拒绝的系统每次都会拒绝，重复上报会把一次诚实失败变成噪音），此时窗口内的点与 Board 仍照常承载该事实。关闭通知期间发生的跃迁只推进基线、不排队，重新打开不回放积压。

## Tab 与 Pane

- Agent/Terminal 内容上方只保留一行 Tabbar，不再显示第二条 Session Info Bar。
- Agent Tab 使用 Provider 图标并叠加语义状态点；Terminal Tab 使用 Terminal 图标，不能用同形状态点同时表达内容身份。
- 语义状态点是全窗口共享语汇（StatusDot 与 Attention Bar 的 StatusCount 同源）：`waiting`/`blocked`（"需要你"）带 `?` 字形而非仅靠颜色，`disconnected` 用中性空心环从琥珀让出，使琥珀唯一表示"需要你"；字形只在全尺寸点上浮现，Tab 角与 Rail 行的 5px 角标仍只用颜色加位置区分。详见 `agentmux-surface-density.md`「响应式与可访问性」。
- Tab 保持稳定可读宽度和单行名称；窄 Pane 使用自身横向 overflow、左右导航和自动滚入可见区。
- Active Run 的 Stop 是 Tabbar 内的图标动作，继续使用统一确认和 Core stop owner。
- `Split` 表示拆分当前 View 内容；移动整张 Tab 使用独立命令和拖拽落点，两种预览和结果不能混用。
- **切回一个开过的 Tab 不重来一遍**。用户的说法是"现在切换是都会 restoring terminal"。恢复态每次
  切换都亮，根子在一个决定：把"不可见"实现为"不渲染"。只挂活动 Tab 时，切走即卸载整棵子树、
  xterm 实例随之销毁，切回时只能从头重放全部 scrollback——恢复态不是慢，是必然发生。因此
  **非活动 Tab 留在 DOM 里、用 CSS 隐藏**：实例活着，就没有东西需要恢复。修法在保住实例，不在
  把重放做快。三条边界：
  - **保住实例的代价必须为零**，这是首要约束不是优化项。不可见的 Region 里终端与原生表面一律
    停工——不 fit、不 resize、不渲染，且不新增常驻定时器或监听；否则开十个 Tab 就是十份持续开销，
    等于拿一种卡顿换另一种。这类退化不会让任何行为测试变红（画面仍然正确），必须显式断言。
  - **实例的存活边界严格等于 Region 的存活边界**：关闭 Region 即销毁实例。**不建终端实例缓存池**
    ——那会造出第二套终端生命周期，谁回收、何时回收都无人负责，与 Region 是展示身份 SSOT 直接冲突。
  - **恢复态本身不删**。真的没有内容可显示时——首次 attach、断连重连、replay 有缺口——仍要如实说
    正在恢复。删掉它会更安静，但那是拿谎报换安静：用户会盯着一个空白终端不知道在等什么。
  - 隐藏用 `visibility` 而非 `display:none`：后者的子树量不到尺寸，切回时得先重新 fit 一次才显示对的
    行列数，那正是要消掉的那一帧。隐藏格必须 absolute 叠放，留在文档流里会把活动格挤变形。
- **切换 Project/Workspace 也遵守同一条保活合同**。所有已打开 Workspace 的 Workbench 由窗口级 owner 保持挂载；非当前 Workspace 只隐藏并停工，不卸载其 Session Region。切换回来不得重新 attach、重新 loading TUI 或从 replay 起点重放一遍。Workbench 真的关闭、Region 被删除或 Session 被用户明确停止时，才释放对应实例与 attachment。
- **保活不等于无限常驻重资源**。活动 Workspace 与近期访问的工作面保持 warm，确保回访不触发恢复态；长期隐藏、超出明确 hot-retain 数量的 Terminal/Monaco/Browser surface 可以进入 cold-park，但只能在该 surface 有可验证的重建或 replay 路径、且不切断 Core Session/Run 事实时进行。cold-park 必须有 TTL、数量上限与 cooldown，避免在项目来回切换时反复卸载/挂载；语义 Session、Topic/Region 布局和可恢复的 attachment 归属不得因内存预算被删除。
- **项目切换本身不得触发 cold-park**。非当前 Workspace 的 Workbench 虽然隐藏，仍受保活合同保护；只有当前 Workspace 内长期隐藏且满足重建条件的非活动 Tab 才能进入 cold-park。这样切换项目后立即回来不会因为 30 秒计时器卸载 TerminalView/attachment，因而不会凭空制造 replay gap；真正关闭 Workbench/Region 或用户明确停止 Session 的释放边界不变。
- **内存归因必须按进程和 owner 分层**。比较 AgentMux 与其他客户端时，不能把 Chromium helper 的 RSS、共享页或 V8 保留容量直接相加后称为“应用泄漏”；至少要分别记录 Main、Renderer、GPU/Utility、Browser target，以及 Terminal/Monaco/Browser/attachment owner。只有在同一场景的 working-set 与 owner count 同时收敛时，才把 cold-park 记为有效回收；没有证据的数值不得写成产品承诺。

## 显示名与身份

- **显示名与身份严格分离**。名字只用于显示，绝不进入 id、寻址 key 或持久化路径。改名因此永远不会破坏引用——这条不是优化，是前置约束：一旦名字进了 key，后面就只能靠别名表和"已删名不复用"打补丁。
- **Agent 与 Tab 各有自己的名字，因为它们是两级身份**。Tab 比 Agent 所在的 Region 高一级（与上文 Tab/Region 的层级同源）：Agent 名回答"**这个 Agent 在做什么**"，Tab 名回答"**这张工作面是什么**"。把两者合成一个字段，就等于假设一张 View 永远只有一个 Agent——而分屏恰恰是常态。
- **Tab 名的默认策略随 Region 数量变化，这正是分开存的价值**：
  - **一个 Agent 时，Tab 名默认对齐该 Agent 的名字**——此时两级身份指向同一件事，让用户填一次名字就够。
  - **再开 Region 之后，Tab 名要体现这是一个 Agent 家族**，而不是继续显示其中某一个 Agent 的名字（那会让另外几个 Agent 在这张 View 上失去表示，也会让 Tab 名随"哪个 Region 是 title region"而跳变）。家族名从成员派生，不要求用户手填。
  - 用户显式改过 Tab 名之后，上面两条自动策略对这个 Tab 永久停手——它变成一个手改名，不再随成员增减而变。
- **名字有一条统一的优先级链**，只有一处定义：`用户手改 > 启动时指定 > 从成员/首条 prompt 派生 > Provider·Workspace 派生`。任何展示名字的地方都经这条链求值，不各自拼一份。
- **自动命名绝不覆盖用户意图**。派生名只在当前名仍是系统生成时才更新；用户手改过一次之后，自动机制对这个名字永久停手。
- **CLI 改名沿同一显示身份。** Agent 改名只针对精确 Session ID；Tab 改名只针对精确 Tab ID，改名或清除都不改变执行目录、Session／Run、工作面位置、焦点或草稿。Tab 的名字属于该实体，跨显示工作区时仍按它自己的 ID 修改，不由当前项目或资源归属猜目标；这不是 Space、Zone 或 Topic 标题改名。当前客户端尚未观察到 Agent 事实时如实报告未知，不能称为已退休。回执给出实际覆盖名或清除、这次是否改动和已观察到的保存结果；保存失败保留已应用名字并说明部分完成，不回滚原工作面或假称已经确认磁盘持久。 Agent 可按同一精确 Session ID 只读当前桌面显示覆盖；这个读取不改变名字或触发恢复，也不声称先前请求成功、Agent 健康或 Session 已不存在。此前 Core 的会话事实查询不冒充该显示名读取。Tab 名继续沿已有工作面查询可读。


## Projects 结构与状态可读性

- Projects 必须能区分项目、路径自动聚合分组与实际目录；父子关系可扫读。有项目自身图标时优先使用，缺失时按项目／目录类型显示图标。分组仍是路径派生事实，不新增实体。
- 活动提示应直接说明正在运行的 Agent；通知必须能解释哪个 Agent 在等什么或出了什么问题，悬停显示明细，点击直达对应会话。已读提醒可消退，但尚待回答的请求不可伪装成已解决；查看后继续显示明确的待处理原因，处理后由 Session 事实自动消失。

## Projects 状态与 Activity 菜单
- Projects 栏的 running/error 计数保持可见，但采用紧凑的图标与短标签，避免挤占目录树空间。
- Activity hover 菜单每行必须提供 provider 图标、最近活动摘要与停止/空闲时长；信息按单行优先、紧凑间距呈现。
- Composer 的展开/收起入口与底部快捷工具行保持同一布局行，不得覆盖或压住输入文字。
- Claude 与 Codex 的 Executor 设置提供一个明确的“一键 YOLO”操作；它写入该 Provider 已验证的无人值守启动参数，并立即保存。该操作只影响后续启动或恢复的 Run，不伪装成运行中进程的实时开关。
- Activity 默认按已有的 Topic / Branch / Worktree 工作线聚合，而不是把每个 Run 平铺成一行。聚合键必须从 Workspace、Host 和 Scratch collaborators 等既有事实派生，不增加 UI 侧注册表或第二份 Runtime 状态。
- 每个聚合行只回答一件事：这条工作线里有哪些 Agent、最需要处理的状态是什么、最近发生了什么。行内显示 context 名称、Provider 头像簇与数量、最紧要状态与短摘要；点击聚合行定位到该组中最需要处理的 Agent，展开后仍可查看并选择具体 Session。
- 聚合行的 context 身份必须在悬停面板中明说（`Topic` / `Branch` / `Worktree` / `Unassigned`），不能只放一个裸标题让用户猜它是什么；路径或非本机 Host 作为次级元信息出现。聚合行的主点击直达该组中最需处理的 Agent，折叠/展开是独立的 disclosure 操作，不得让用户先逐个试 Agent 才知道这一行在表达什么。
- 不同 context 必须能被区分：Topic、Branch、Worktree 名称和必要的 host 元信息不能被一条泛化的“Agent activity”标题取代；没有 context 的 Session 进入明确的“未分组”组，而不是凭空猜 Topic。
- 全局 transient `reportError` 不得固定在工作区底部遮挡内容。它应停靠在不覆盖主工作面的 notice 区，带清晰的关闭按钮和可访问名称；关闭只隐藏当前展示，不删除 Runtime/Session 事实，并保留从状态或诊断入口重新查看的路径。持久服务窗的事实保留、收起与复查统一沿[《我们的流程坏了，不等于 Agent 坏了》](session-recovery.md#我们的流程坏了不等于-agent-坏了)，不另设不可关闭的例外。
- Run 的权威 lifecycle 已进入 stopped/exited/done 后，所有 pending composer readiness 必须失效或被清理；Desktop 不得继续把它翻译成“Run is still running / wait”。此时 Composer 给出 resume/restart 等可执行恢复出口；真正仍在运行但尚未观察到 readiness 的 Run 继续 fail-closed，不能为消灭提示而绕过 Core readiness 门。

## Region 移位入口
Region 的右键菜单必须提供“移位”入口，允许在当前工作面把 Region 与目标位置交换/移动；动作使用统一布局 owner，执行后保留 Session 与 Region 身份，不通过标题或视觉位置猜测目标。

## 控件说明与对话完整性
所有图标或模式切换按钮必须在 hover 附近提供简短用途说明，并在存在快捷键时一并展示；同时提供可访问名称。对话视图必须按时间顺序显示用户消息与 Agent 回复，不能只呈现 Agent 一侧。

## Project Rail、通知与 Topic presence

- Project Rail 的分组父节点和树节点都支持收起；收起不改变路径归属、焦点或选中项目，重新展开后保留原来的树顺序。
- 分组标题、项目、嵌套项目和 pinned 子项使用同一条缩进计算，不因某组收起而改变其他组的左缘。
- Pinned 子项仍是所属 Project 的可点击导航入口，但必须读作从属内容：标题比普通项目小一档，悬停只加下划线、不铺普通项目的背景高亮；它与所属 Project 之间保留一条低对比虚线连接，连接只表达归属，不承担选中、运行或错误语义。
- 没有品牌图标的节点使用低对比、低饱和的 monogram；字母只是识别辅助，不能用高饱和背景抢过项目名。
- 右侧运行/错误通知默认只显示语义 icon 和数量；hover、focus 或明确交互时再展开文案，展开不能遮挡项目名或改变列表跳动。
- Pinned item 必须是可点击的导航入口；Topic 的 pin 标记贴近标题并保持在标题行的视觉轨道内，不漂浮到整行中央。
- Scratch Topic 只展示当前打开的 Agent，顺序沿用真实 Tab 顺序；Agent 图标、状态和对应 Tab/Region 信息必须在同一行内成组表达。
- Project Rail 的密度由用户在 Projects 标题行就地切换（加号旁），不进设置页；提供默认、紧凑、更紧凑三档，按同一个入口循环。切换只改变行高、行图标尺寸与每层缩进，**不改变树结构、归属、选中项或滚动位置**——密度是看法，不是数据。默认档的树缩进也要保持克制，避免切换后仍把项目标题推得太远；该选择重启后仍然有效（视觉档位见 DEN「Project Rail 与 Topic 行密度」）。
- running 与 working 必须**同时**在字形与动势上可分：`running`（进程活着、未在产出）保持静态 glyph，`working`（正在产出）带节奏动势。只换提示文字、只换颜色、或两者都静态都不满足这条；reduced-motion 下动势退化为静态但**字形差异必须保留**（约束原文见 DEN「Agents、队列与语义 token 密度」，此处只补「哪一个是哪一个」）。

## Topic 行的 Region 与 Agent 在场状态

用户要求「topic 的 region 表示和 agent 图标融合到一起」「已经关闭的 agents 就不要再显示在那边」。Topic 行在 Region 缩略格内显示属于该 Region 的小 Agent 图标，不再将同一 Agent 另列一枚重复头像。没有打开 Region 的后台健康 Agent 仍应可见可达；关闭 Tab 不等于结束 Agent。已明确结束的进程不再占 Topic 行头像位，未知/断连不伪装成关闭；历史 Session 与协作者文件保持原状。视觉约束见 surface-density 的同名段。
## Topic topology 的计数与浮层边界

Topic 行默认横向列出所有 Tab，每个 Tab 以一个紧凑图标位快速扫读，当前 Tab 有明确的选中边界；总的 Tab/Region 计数不再单独占一个摘要块。用户 hover 或键盘 focus 某个 Tab 时，展开同一个顶层 topology inspector，只展示该 Tab 的真实 Region 几何、Executor、surface 类型和最近活动，并保留 Tab 标题与上下文。Inspector 不能被 Topic 列表、滚动面板或工作区工具容器的 overflow 裁掉；靠近边缘时在锚点上方或下方选择可见位置。Topic 行原有的点击打开动作保持不变。

## Scratch Topic 打开后的工作面渲染

点击 Scratch Topic 后，Scratch workspace 的 Workbench 必须和普通 workspace 一样进入窗口级 registry 并显示对应 Tab/Region；Topic 只改变导航和绑定，不得因为 Scratch 是 wiki 工作区而留下空白右侧工作面。未准备完成时显示共享的 loading/失败服务窗，工作面本身不能被错误地过滤掉。

## Topic Workbench topology 的可读层级

Topic 行的工作面摘要必须明确区分三层事实：Tab 数量、每个 Tab 的 Region 布局、Region 内的 Executor 与最近活动。收起态横向列出所有 Tab，让用户第一眼看到工作面；单 Region 用该 Region 的身份图标，多 Region 用真实分栏网格。hover 或键盘 focus 后展开同一个 topology inspector，按选中的 Tab 展示真实 Region 几何、Executor、surface 类型和最近活动。已有 Tab 内的 Agent 不在右侧再列一份头像；没有挂载到任一 Tab、仍可工作的后台 Agent 保留独立身份入口，避免静默消失。

## Topic topology 的 Tab 缩略图语言

Topic 行的 Tab 收起态只占一个紧凑图标位：如果只有一个 Region，直接显示这个 Region 的图标；Agent Region 显示其真实 Agent 头像，Terminal、Browser、File、Launcher 显示相应类型图标。如果有分栏，显示一个按真实 bounds 构成的方形宫格。收起态不显示 `Tn`、`nR` 等内部计数标记。悬浮详情中 Agent 以同一头像自然呈现，名称与最近活动作为辅助文字；不能只写 Agent 名字而把身份图标藏起来。Tab 标题、Region 数量、Executor、surface 类型和最近活动在 hover 或键盘 focus 后的同一个 inspector 中可见；详情不能被列表或滚动容器裁切。视觉密度见 surface-density 的「Topic topology Tab 缩略图的空间密度」。

## Topic Tab 图标簇的交互

多个 Tab 的收起态图标沿用 Agent 头像簇的轻微叠压关系，表达“这是同一 Topic 下的一组工作面”，不把每个 Tab 拉成一排彼此孤立的按钮。每个 Tab 仍是独立的 hover/focus 目标；被指向或聚焦的 Tab 必须浮到最上层并完整可读，点击和键盘顺序保持按 Tab 顺序。

## Topic Tab 缩略图导航与 hover 结构

Topic 行上的每个 Tab 缩略图是可操作的导航入口：点击或键盘确认后，必须直接激活该 Tab 所在的 Workspace、Tab 和 Region；只改变 hover 检视而不改变工作面的交互不成立。缩略图保持紧凑的横向 rail，单 Region 只显示该 Region 的身份图标，多 Region 显示与真实 bounds 同比例的分栏轮廓。

Tab 的 hover/focus 浮层只保留一份信息：上方是 Tab 身份，主体是按真实 Region bounds 绘制的工作面小地图，Region 内用图标识别 Agent、Terminal、Browser 或 File。最近活动作为 Region 的轻量辅助信息贴在对应格内或作为单行摘要，不再在地图下方重复列出同一批 Region。

## 全局工作面顶栏与名称

Focus 不留独立标题行，其必要过滤控件直接避开 macOS 原生窗口按钮；Goals 工作面的左上角标题也必须避开这些按钮。Project Rail 在全局工作面隐藏时，不能仍按它可见来决定标题起点；切换 Focus、Space 和 Goals、开合工具坞或重启恢复后，系统按钮与标题都必须保持可见、可操作。

顶级工作面和单项名称归[《左下角导航、Space 与 Goals》](#左下角导航space-与-goals)。名称调整只改变用户可见表达，持久化 Demand、Session 和已选工作面的身份继续由原 owner 持有。

## 浮层让位默认成立，而不是逐个接线

用户原话：「弹窗经常被浏览器挡了」。「经常」是这条约束的要害——它不是某一个弹窗的缺陷，而是让位**默认不成立**：让位要靠每个浮层各自记得申请，全仓二十余个浮层里只有个位数接上了，于是被挡与否取决于你恰好打开的是哪一个。

浮层默认沿共享宿主与浮层库的 Portal/打开态协议呈现，不依赖各组件申请手动遮挡租约，也不维护具体组件清单或扫描应用正文。与原生 Browser 的实际交叠、可见性和输入行为只引用[《Browser 任务能力与可复用资产》](browser-workface.md#browser-任务能力与可复用资产)，新增浮层不复制该合同。

用户新反馈：「浮窗上很多功能按键都不生效」「弹窗被浮窗自己遮下面」「浮窗和整个系统弹窗层级没做好？」提供的实际截图中，Stop Agent Session 确认大部分被前景 Mote 浮窗遮住。这是已观察到的层级缺陷；其它按键按准确原目标逐项核对，不把“很多”写成所有功能都坏。非模态浮窗发起的窗口级确认、选择、菜单与输入弹层须完整可读、可命中，沿通用宿主和原生 top-layer 的真实打开／关闭协议正确排序，不能只靠普通 DOM 的 z-index 或逐功能手动隐藏来补。较高层持有当前焦点、键盘与 Escape，背景浮窗不截走其操作；模态打开时背景 Mote 与普通工作面均不接收点击而改变对象、Tab/Region 或执行目标。取消／关闭后沿原准确入口与较晚的用户焦点返回，保原浮窗所选对象、Tab/Region、非空草稿和健康 Run。危险确认仍先取消、忙碌不重复执行，原停止、保留 Session 与关闭 View 的后果不变；不能为解决遮挡另造一套 modal、运行状态或生命周期。

嵌套浮层按各自真实打开、关闭和退场事实收口；关闭下拉不关闭仍打开的对话框，退场内容不再占用原生命中区。协议无法确认的浮层明确暴露限制，不以手动全局隐藏 Browser 作为长期后备路径。

Escape、点击外部、失焦、选中项、组件卸载与异常路径都退出对应浮层；原工作面保留与恢复仍沿[《Browser 任务能力与可复用资产》](browser-workface.md#browser-任务能力与可复用资产)的同一合同。

## Topic 默认终端与可发现关闭

用户反馈：「Topic 里 Terminal 默认渲染两个且找不到关闭入口」。普通 Topic 的首次打开应形成一个可用 Terminal；重复点击、创建完成后的打开、恢复或不同投影的挂载不能凭流程增加第二个 Terminal Session 或 Region。用户主动分割、打开的多个终端仍按真实布局呈现，不能靠隐藏第二个终端、清空持久布局或删除健康 Run 解决默认重复。终端的关闭动作在当前 Tab/Region 附近可发现，并复用已有关闭/停止合同；取消或关闭其他 Region 不影响未选中的健康工作。重启先恢复既有分割与引用，不重新运行首次创建路径。

## 初始 Launcher：紧凑、可定制的工作起点

用户要求「现在初始画面得优化了」：Launch options「太占地方」，画面「杂讯和重复信息还是太多」，要「更加现代化和高级，至少不能逊色于设置界面，产品完成度要高」；Resume 要能选「项目内还是全局」，选项有「recap / agent 名 / id 等」；「运行环境没体现，这里是重头戏，可以提前设计」；「不同尺寸 region 的适配做的不是很好」；组件要能关闭或展开部分，例如关闭 Agents、关闭 Terminal 并以按钮显示、Browser 初始就是搜索框、展开 Note；并「支持联动 mote」。本条的初始画面指 New Tab / Launcher 工作起点，不是应用品牌启动页；“lunch options”沿现有 Provider Launch options 解释，Mote 指现有协调对象，Note 是独立笔记工作面。

用户后续反馈「初始页面默认还是browser和note收起；现在和mote关系看不懂，应该是一个“让Mote帮我创建”的按钮，且支持选一个?」。默认开合与 Mote 动作沿本节更新；旧 Launcher Feature 的验收历史保留，本轮是明确创建委托的维护，不混入本地文件预览。

用户进一步要求再看启动画面：「This Mac 点开后太难看了」「目录应该遵循项目设置中的路径转换」「Options 和 Create with mote 位置奇怪」「Launch 和 Resume 按钮太难看」；Browser 展开希望「一个动画展开成一行」，Space 打开初始页应「默认是 terminal 打开，其他关闭」，整体视觉要更好。本轮细化同一工作起点的上下文、动作层级与首次开合，不把已归档的验收重新改成未完成，也不扩展为新的环境或生命周期能力。

用户继续追问「有足够好的交互和动效吗? 类似设置页」。Launcher 的完成度也包括真实选择、按需浮层和工具展开时的连续反馈；沿 Settings 既有控件、交互材质与动态刻度提升，不改变前轮已验收的工作起点、实际资源或生命周期事实。

用户随后明确要求「初始画面默认不要只显示最近的 Executor，而是展示所有激活的，那样比较有冲击力」。本条更新无显式偏好时的 Agent 展示起点；已有用户主动收起或关闭的选择仍保留，其他工具与生命周期边界不变。

用户最新细化：「普通初始页 terminal 应默认打开，只有 mote 和 survey 出现的初始页默认关闭」「展开 terminal 占空间稍大，当前太小」。默认由当前实际展示宿主决定，不把呈现时的默认当成用户已经保存的折叠选择；展开后的阅读空间随当前 Region 适配，原显式选择、草稿与 warm Run 保全。

- **先明确在哪工作，再立即开始。** 当前项目、实际目录、Host / Local 或已配置 SSH 身份在开始之前可读，展开可查看完整路径及真实探测状态。环境为独立可发现的上下文入口，未来的隔离 / 远端环境有明确扩展位置，但本轮没有真实能力的环境只能说明未支持；配置存在、探测中与已连通不得互相代称。环境信息投影已有配置与 Runtime / discovery，不能复制运行环境账本，也不为显示环境重启 Session。
- **目录沿项目已有的路径表示选择。** 启动页目录摘要与展开详情遵循既有路径转换设置，规则唯一见[《寻址与复制》](#寻址与复制)：仅已确认本机路径可按真实本机 home 显示为 `~`，选择绝对路径时给完整路径；远端、其他用户和未知 home 保持原路径。表示变化不改 Workspace 实际目录、Host、warm Terminal key、启动、Resume 或 Mote 委托的资源事实，不另加路径转换设置或第二份转换逻辑。完整原始地址仍可按需核对。
- **Launch options 随当前 Agent 按需展开。** 默认以紧凑动作与已选状态摘要呈现，未修改时不重复选项个数和 Provider defaults。可选 Agent 名与 Tab 名属于按需配置，不占据常驻双输入行；展开、关闭和 Region 变窄保留用户输入和选项。Provider describe / argv 分层、未声明不渲染与启动姿态语义沿[《Provider Launch Option》](agent-capabilities-and-messaging.md#provider-launch-option)，不加具体厂商分支。
- **每块内容可以决定是否展开。** Agents、Terminal、Browser 和 Note 有可辨的关闭 / 收起、展开与恢复入口；关闭一块只是收起它的呈现，不删除草稿、持久化工作面或停止健康 Run。Agents 收起后保留当前选择，并有可达的恢复 / 启动入口；Terminal 收起后有真实打开动作，展开复用同一个 warm terminal。Space 打开初始页且没有显式偏好时，Agents 默认展开，直接呈现所有已配置且当前 Host 未明确判为 missing 的 Executor，不只露出最近一个；检查中、检查失败或状态未知不当作未安装，沿原事实提示。最近选中的 Executor 继续高亮，不因完整阵容呈现而另选对象。普通初始页的 Terminal 默认展开，仅 Mote 与 Survey 中展示的初始页默认收起；判定来自本工作面的真实展示归属，不按全局当前页面、Workspace 名或是否为 Scratch 猜宿主。默认仅补未明确设置的部分，不写成用户偏好；已有明确 expanded / collapsed / hidden 继续优先，切展示位置不清草稿、不重建或停止 warm Terminal。Browser 与 Note 默认收起；用户主动收起或关闭 Agents 后尊重原偏好，收起的 Agents 以紧凑入口呈现当前选择、展开与 Resume；先展开真实 Agent 输入与配置上下文，再呈现 Options、Mote 创建委托与直接 Launch 动作，不在没有 Agent 输入框的默认工作面保留空白启动底栏。收起不等于移除入口。Browser 展开后在同一工具行直接输入地址或搜索词；Note 可展开输入真实笔记并通过既有笔记动作打开。已有明确显示偏好继续尊重，在重载和进程重启后保持，未保存时明确提示，不静默声称已记忆。
- **Browser 与 Note 都有完整动作结果。** Browser 输入按已有 URL / search 规则解析，提交进入同 Launcher 目标的真实 Browser；不得把搜索框画成没有导航的装饰。Note 展开后的输入、打开成功或失败与原稿保留可验证，不能把草稿存入无法打开的孤立临时区域。关闭部分、变窄、切 Tab 或启动失败后仍能继续原稿。
- **Mote 联动明确目标和创建意图。** 入口表达“让 Mote 帮我创建”，旁边能选择已有真实 Mote 并读出目标名称；显式点击才把当前完整请求与真实项目上下文交给所选 Mote 一次。原 Mote 已有 Agent 时沿其原输入动作，尚在 Launcher 时沿已有公开 Agent 启动能力；不另建影子 Mote、第二条启动通道或隐式改项目。空请求只打开所选 Mote 供描述，不能发送无内容。原 Launcher 草稿、原 Mote 未发送草稿与健康 Session 保留；权限仍由原交互处理，不自动批准。排队 / 提交表示委托已保留或交付，不等于对象已创建；失败、未知与等待有真实目标和原因，较晚选择或来源变化后旧异步操作不能错投或抢焦点。
- **Resume 信息够用且诚实。** 范围与恢复边界沿[《启动页 Resume 快捷入口》](session-recovery.md#启动页-resume-快捷入口)。候选同时可识别实际 Agent 名、Provider / Executor、所属项目与 Host、最近活动、稳定 Session ID，以及来自已保留记录的 recap / 请求摘要；缺摘要明确无可用 recap，不从 Provider、时间或名字编造。完整 ID / 路径可按需查看或复制，显示名永不当恢复 key。列表、计数、过滤与被选恢复对象同源，当前项目零候选仍能切全部项目。补充摘要只处理有界保留记录，不能因打开 Launcher 扫描所有 transcript 全文或增加无关 Session 的工作。
- **交互先兑现，动态随真实动作。** Agent 选择和部分开合由原控件与原状态立即兑现；键盘 Tab、Enter / Space 与浮层 Escape、关闭返回焦点沿既有可访问控件，不等待动效才允许输入或提交。Host / Options 的有限退出呈现不能继续接收点击、Tab 或旧提交；快速关闭重开、切 Agent 和尺寸变化后，旧完成事件不得关掉新面、覆盖真实选择、丢草稿或抢焦点。选择连续反馈只跟随本次真实目标，hover 不选择，未知环境不冒充已连接；动效不重挂编辑器、Terminal 或复制 Runtime / draft / selection owner。原选中 Agent、Options、名称、Prompt、Browser / Note 草稿和健康 Run 保留。减少动态、Launcher / document 隐藏或 retained inert 时停止装饰动态及无关局部观察，按当前状态立即呈现可读静态反馈，临时退出内容确实释放；不以动画终止事件缺席阻断原动作。视觉与材质复用唯一见密度 SSOT 同节。
- **Region 自身决定适配。** 宽、窄、矮以及连续分割下，主输入和启动、Resume、环境与恢复入口可达，没有横向撑破、双重滚动陷阱或弹层被 Region 裁掉。偏好展开状态与当前宽度是不同事实；尺寸临时收敛不得抹掉用户偏好或重建工作对象。主 Composer 沿既有整框可编辑与草稿身份合同。
- **重启恢复保全先于界面优化。** 同一次进程重启后，原 Tab / Tab Group / Region / 焦点 / 分割布局先按 durable 状态恢复，引用 Session 自动尝试 reattach / resume；Launcher 部分偏好和未发送草稿保留。临时空快照、超时和探测未知仍保留原工作面并用服务窗说明，只有 Core 终局事实允许移除投影。宽窄视觉验收必须以实际工作面为输入，且核对健康 Run 没有因开合、尺寸和联动被停止或重复创建。

视觉、密度、材质和控件层级唯一见密度 SSOT[《初始 Launcher 的现代工作台密度》](../presentation/spaces-and-layout.md#初始-launcher-的现代工作台密度)；本节只定义行为与约束。
