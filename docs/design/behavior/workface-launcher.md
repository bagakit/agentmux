# Launcher 工作起点

本文定义 New Tab／Launcher 的环境选择、可收起工具、未发送草稿、Mote 创建委托与 Resume。它是一个原 Region 中的工作起点；应用启动大屏与 Session 恢复沿[恢复合同](session-recovery.md)，视觉沿[Launcher 呈现](../presentation/spaces-and-layout.md#初始-launcher-的现代工作台密度)。已确认约束不代表实现或安装已验收。

[返回交互合同](../agentmux-desktop-interaction.md) · [空间模型](spaces-and-layout.md#空间模型)

## 环境、目录与文件引用


- **工作地点由入口确定，起点只读呈现。** Launcher 的项目与所在设备来自打开它的 Space 入口（已登记目录或[设备入口](spaces-and-layout.md#设备主目录工作面)确认的 home）。起点的项目身份头部只读呈现项目名、路径与设备，不在头部混入第二个选择器；未来工作安排通过下节具名 Work mode 编辑面修改，原 Space 入口继续可用。设备标签的悬停或键盘焦点可读完整路径、设备名称与身份，以及原连接 owner 的当前通信方式与最近一次检查结果；未知观察明确未知，不画成已连接。选择、显示与实际创建请求使用同一个执行目标，执行目标与当前展示落点分开；选择未来创建目标不迁移、重建或停止已有 Session/Run，不改其它 Region 的执行身份；原未发送输入、名称与选项保留。明确选择的 Agent 与运行设备沿该 Launcher Region 的原持久 owner 保存，保存回执、Agent 或 Terminal 启动失败重挂及普通进程重启后仍是同一选择，不能按 Tab 的展示项目覆盖执行目标。环境信息复用已有配置与 Runtime/discovery，配置存在、观察未知与已连通不能互相代称；健康边界沿[联邦 Runtime 与远端恢复合同](session-recovery.md#联邦-runtime-与远端恢复边界)。

- **目录沿项目已有的路径表示选择。** 启动页目录摘要与展开详情遵循既有路径转换设置，规则唯一见[《路径显示与复制》](spaces-and-layout.md#路径显示与复制)：仅已确认本机路径可按真实本机 home 显示为 `~`，选择绝对路径时给完整路径；远端、其他用户和未知 home 保持原路径。表示变化不改 Workspace 实际目录、Host、warm Terminal key、启动、Resume 或 Mote 委托的资源事实，不另加路径转换设置或第二份转换逻辑。摘要与悬停路径都沿同一表示偏好；完整原始地址在设备标签的悬停面按需阅读或复制，缩写不隐藏实际执行目录。

- **文件引用属于项目资源端。** 本机文件选择沿已有系统入口；远端选择沿所选 Workspace 的原文件能力浏览和引用真实项目文件，不用本机文件对话框或缓存地址冒充远端文件。尚无跨机器附件交付时，图片粘贴保留正文并明确说明文件没有送达，提供当前项目文件引用入口；不插入不可达的本机路径，不静默改回本机，也不因此封闭原启动能力。异步结果的来源约束沿[会话输入](conversation-input.md)，不另建附件或草稿账本。

## Agent 运行端与项目工具端

Launcher 沿原两个地址表达项目端与 Agent 运行端：项目取原 resource Workspace，Agent 取原 agent Workspace，未显式分端时跟随项目。模式及参照定义唯一见[Remote 工作模式](remote-management.md#独立-remote-execution-工作台)，不新增持久模式字段、创建协议或配置副本。

普通项目、初始页、空 Zone／Group 与 New Agent 共用同一工作起点。项目 Launcher 固定原 resource Workspace，只选择 Agent 运行端：本地项目提供 Local／Outpost，远端项目提供 Reach／Orbit；模式不搬动项目，也不在这个入口选择另一目录。项目身份头部与准备面保持原项目只读，切换模式立即反馈本次选择，读取 Agent 端资料只作用于所选设备，等待或失败不阻断独立初始页。Settings 等尚未选定项目的全局准备入口可选择项目位置，再进入该项目自己的 Launcher；两类入口复用同一两端模型，不各造模式字段。Apply arrangement 一次提交准确原字段，Cancel 保留原安排；用户正在编辑未提交安排时不把旧地址冒充新选择发起启动。Launcher 的准备不创建 Agent，最终仍由原 Launch 动作确认。已有独立创建与关系事务的普通入口（如 Goal 新建 Agent）复用同一两端准备，再选择目标 Host 的配置，沿原 Create Agent 确认；原创建回执、未知结果与关系草稿仍由原事务持有，不因复用界面而转交或丢弃。

分端时 Agent 启动目录默认用目标 Host 已确认 home，经原查询与普通目录登记，不猜路径、不要求项目副本。Settings 的 Open in Launcher 仅携带同样两端进入原起点；来自 Settings 的安排在 Launcher 可原位修改 Agent 端，项目仍归原 Workspace。登记缺失或读取失败就地说明准确对象、原原因和恢复入口；异步结果只作用于原项目／Launcher 与 Host 配置，后选对象或后续输入不被覆盖。

Agent 启动目录持有原生配置、登录与 Skills 来源；项目端持有文件、命令与工作区工具。Executor 从准确 Agent Host 的原配置及 revision 选择，不能按名字继承另一 Host 配置。同项目切运行端保留原 Region、完整 Prompt、名字、Provider 选项、辅助工具草稿与原操作回执；明确换到另一项目时打开该项目自己的 Launcher，原项目输入与相对文件／Note／Browser 回执仍留原 owner，不跨文件系统根复制或吞掉。准确两端由原 Store 一次提交，不先改项目再异步补运行端。空 Zone 建立原 Region 仍沿原输入认领链保全。

新 Session 冻结准确两端，Resume、接管及重接沿原身份／binding，选择新建模式不迁移已有 Agent。项目文件候选、文件选择与正文链接消费原 toolExecution 资源地址；原生 Skills、配置、输入与历史仍归运行端。缺少登记只影响该次文件操作，保留 binding，不回落到运行端同名目录。图片的本机来源、持久保留与原 Session 上传保持各自 owner。

Scratch／Mote 及 canonical Goal 上下文沿原资格：没有分端能力时解释这次受限安排，保留原普通启动、草稿与恢复，不静默替换普通项目或关闭健康能力。配置 inventory 未读、失败或来源不符时保留原输入、已确认来源和重读／重选动作；只有原 ready 零集合才称未配置，不借本机同名模板代替。Provider 分项资格、原生权限及实际回执仍由原 owner 判定，模式不能代签 Ready 或授权。

创建请求的准备已返回失败时，原页立即显示这次准确请求的失败步骤、原因与原身份，不继续用无限 Starting／计时动画表示仍在执行。一次失败回执不证明 Agent 未创建或 Run 终局；结果未知时保留原请求、草稿与检查原结果入口，不自动重发、返回空白起点或用另一 Session 代替。后续请求的反馈只消费自己的原回执，不继承同 Region 上一次失败。

设置与 Launcher 的指南消费[同一 Core 正文](../../../packages/core/guides/actions/remote-execution.md)，不另写一份流程或能力清单。

## Agent 选择、选项与草稿


- **Launch options 随当前 Agent 按需展开。** 默认以紧凑动作与已选状态摘要呈现，未修改时不重复选项个数和 Provider defaults。可选 Agent 名与 Tab 名属于按需配置，不占据常驻双输入行。Prompt、名称与启动选项沿原 durable 输入 owner 保留；选项按准确 Launcher Region 与 Provider 隔离，切 Provider 不串用，返回原 Provider 仍保留其显式选择。真正首次启动、空 Tab Group 尚无 Tab / Region 时，同一工作起点的原始未发送输入与选择在建立准确 Launcher Region 时保全归属，包括 Prompt、名称、各 Provider 配置及辅助工具的草稿与既有创建引用。启动失败回到该 Region 后仍可继续编辑和恢复原工作，建立工作面不得改变用户所选全局空间或把未发送稿误当已消费。展开、关闭、Region 变窄、pending 卸载后失败重挂以及进程重读都保留未发送输入和已选配置，不能恢复 Prompt 却悄悄改用 Provider 默认。只有成功请求确实使用且此后未改的原记录可以被消费，晚成功不得吞掉新编辑；其他 Mote 或上下文的启动不消费原 Mote 未发送草稿。Provider describe / argv 分层、未声明不渲染与启动姿态语义沿[《Provider Launch Option》](agent-capabilities-and-messaging.md#provider-launch-option)，不加具体厂商分支。
- **启动选择在选择前可比较。** 选项面沿 Provider 原声明的标签与说明，区分未设置的 Agent 默认、显式草稿选择和仍保留的未知保存值；键盘高亮不改变值，只有明确选择才更新原启动草稿。说明只使用已有声明，不猜默认档位、推荐值或运行中模型／effort；清楚说明作用于该次启动，不把启动选项冒充 live SET。选择、关闭、Escape 和窄 Region 碰撞避让复用原控件／焦点 owner，保 Prompt、名字及各 Provider 选择。

## 工具开合与 Browser／Note


- **每块内容可以决定是否展开。** Agents、Terminal、Browser 和 Note 有可辨的关闭 / 收起、展开与恢复入口；关闭一块只是收起它的呈现，不删除草稿、持久化工作面或停止健康 Run。Agents 收起后保留当前选择，并有可达的恢复 / 启动入口；Terminal 收起后有真实打开动作，展开复用同一个 warm terminal。

- **预热只服务准确目标。** 自动预热失败后，本次 Launcher 不因预热槽清空而连续重发同一 Host／目录的启动；保留完整输入与原显式 Terminal 启动。真实预热成功后被使用可补充原槽，目标资源变化可按新目标尝试，不复制 Runtime 或把失败猜成健康 Run 不可用。 可复用 Terminal 只复用同项目准确执行目标下尚未使用、且已释放预览归属的候选；各项目分别保留。每个可见 Launcher 都保有可用 Terminal 预览，同时可见时不互夺同一 Run。没有合适的空闲候选就创建独立 Terminal，另一项目、活跃预览或认领中的候选不得让当前 Terminal 消失，也不得阻止创建多个 Terminal。复用是可选优化，不是可见性或数量配额。

- **预热不限制显式打开。** 预热命中、在途或已被认领只影响复用，不能阻断另一个 Region 的 Shell 打开；不同 Region 使用各自准确的原请求与 Run。同一 Region（或尚无 Region 的空 Tab Group）同次打开的重复动作幂等，不重复创建。原请求晚确认遇展示关闭或替换时，保留可核对的请求与健康 Run，不复活旧 Region，也不因此停止候选。预览与 resize 的单消费者归属只约束呈现，不绑定执行身份。 观察释放不能停止或清除已被显式打开认领的候选及原请求；从未认领的自动预热仍按原资源治理释放。

- **默认展开不冒充用户偏好。** Space 打开初始页且没有显式偏好时，Agents 默认展开，直接呈现所有已配置且当前 Host 未明确判为 missing 的 Executor，不只露出最近一个；检查中、检查失败或状态未知不当作未安装，沿原事实提示。没有配置 Agent 时提供可发现的相应 Settings 配置动作，原输入、Resume 与其他健康工具仍可用。最近选中的 Executor 继续高亮，不因完整阵容呈现而另选对象。普通初始页的 Terminal 默认展开，仅 Mote 与 Survey 中展示的初始页默认收起；判定来自本工作面的真实展示归属，不按全局当前页面、Workspace 名或是否为 Scratch 猜宿主。默认仅补未明确设置的部分，不写成用户偏好；已有明确 expanded / collapsed / hidden 继续优先，切展示位置不清草稿、不重建或停止 warm Terminal。Browser 与 Note 默认收起；用户主动收起或关闭 Agents 后尊重原偏好，收起的 Agents 以紧凑入口呈现当前选择、展开与 Resume；先展开真实 Agent 输入与配置上下文，再呈现 Options、Mote 创建委托与直接 Launch 动作，不在没有 Agent 输入框的默认工作面保留空白启动底栏。收起不等于移除入口。Browser 展开后在同一工具行直接输入地址或搜索词；Note 可展开输入真实笔记并通过既有笔记动作打开。已有明确显示偏好继续尊重，在重载和进程重启后保持，未保存时明确提示，不静默声称已记忆。

- **Browser 与 Note 都有完整动作结果。** Browser 输入按已有 URL / search 规则解析，提交进入同 Launcher 目标的真实 Browser；不得把搜索框画成没有导航的装饰。Note 展开后的输入、打开成功或失败与原稿保留可验证，不能把草稿存入无法打开的孤立临时区域。存在正文时，主要打开动作使用同一保存现稿意图；独立空白创建明确表达并避免重复入口，不能用相近的打开动作让用户误以为当前稿已提交。原 Launcher Tab 与未消费稿保持可回。关闭部分、变窄、切 Tab 或启动失败后仍能继续原稿。

## Mote 创建委托与目标


- **Mote 联动明确目标和创建意图。** 入口表达“让 Mote 帮我创建”，旁边能选择已有真实 Mote 并读出目标名称；显式点击才把当前完整请求与真实项目上下文交给所选 Mote 一次。原 Mote 已有 Agent 时沿其原输入动作，尚在 Launcher 时沿已有公开 Agent 启动能力；不另建影子 Mote、第二条启动通道或隐式改项目。空请求只打开所选 Mote 供描述，不能发送无内容。原 Launcher 草稿、原 Mote 未发送草稿与健康 Session 保留；权限仍由原交互处理，不自动批准。排队 / 提交表示委托已保留或交付，不等于对象已创建；失败、未知与等待有真实目标和原因，较晚选择或来源变化后旧异步操作不能错投或抢焦点。

- **创建目标记住最近明确选择。** Launcher 的 Mote 入口在用户选定一个真实 Mote 后，以它作为其他 Launcher 和下次打开的默认目标，重载及进程重启后仍保持；没有明确选择时沿原默认 Mote 身份。该单一创建偏好由已有 Launcher UI owner 保存，只记录准确 Mote 身份，不复制目录、头像、Tab / Region 或 Session / Run。浮窗浏览、hover 和其他工作面的导航不改写这项偏好，Launcher 内选择本身不打开或移动浮窗、不启动 Agent、不改执行焦点。创建入口的图标消费所选 Mote 的同一已保存头像；名称、头像与实际交付目标保持一致。保存失败保留当前内存选择与原草稿，明确未保存，不声称下次已经记住。

- **归档目标仍是同一创建目标。** 已保存或当前明确选择的 Mote 归档时，Launcher 保留原身份、可用创建入口与可发现的原地恢复动作；不因退出常用名册而替换成另一位 Mote，也不把归档当 Session 终局或要求先恢复才能使用健康 Agent。新选择的推荐、确认写入、未知与失败沿[《Mote 归档与恢复》](motes-and-coordination.md#mote-归档与恢复)；目录暂不可读或找不到原记录时保原引用并说明未知，不按名称或名册首项借目标。归档 / Restore 请求和失败反馈归属准确 Mote；切换目标或旧请求晚回复后，保留原失败对象和原因，不把它挂到新健康目标的当前状态下，也不静默抹掉原失败。

## Resume 与交互连续


- **已有原生会话可以从这里继续。** Resume 候选覆盖 Core 已管理的 AgentSession 与 Provider 可验证的原生持久会话；原生会话不以曾由 AgentMux 创建、已有 Runtime Run 或未在其它工作面展示为入选前提。Core 通过 Provider 确认原生来源、身份及真实执行目录，Launcher 消费同一公开能力，不自行解析厂商存储。已管理的同一原生会话沿原 AgentSession 与执行身份恢复；首次接入未管理会话可以建立 AgentSession，但必须继续准确原生 conversation，不能把新 Run、空会话或另一原生 ID 当作恢复完成。具体 reattach、native resume、当前 Run 重读与已退休会话的显式继续沿[恢复合同](session-recovery.md#启动页-resume-快捷入口)，不复制生命周期逻辑。原生候选按用户打开 Resume 后的查询范围按需读取，冷启动不因这个入口扫描或批量启动历史 CLI。

- **Resume 信息够用且诚实。** 范围与恢复边界沿[《启动页 Resume 快捷入口》](session-recovery.md#启动页-resume-快捷入口)。候选同时可识别已知 Agent 名、Provider / Executor、所属项目与 Host、最近活动及来自已保留记录的 recap / 请求摘要；已管理候选保稳定 AgentSession ID，未管理候选保准确 Provider 原生 ID，缺失字段明确未知，不以 Run ID 代称语义会话。缺摘要明确无可用 recap，不从 Provider、时间或名字编造。完整 ID / 路径可按需查看或复制，显示名永不当恢复 key。列表、计数、过滤与被选恢复对象同源，同一 Host / Provider 原生会话只呈现同一准确目标，已管理绑定优先沿原 Session；当前项目零候选仍能切全部项目。查找范围与有界摘要读取只见上述 Resume 合同，不以未读取内容作搜索承诺。原生发现或摘要读取失败保留已知候选、原草稿和健康 Run，说明失败范围与可重试动作，不把某个 Provider 的观察缺口说成全部会话不存在。

- **Resume 中可以直接操作原会话。** 已确认 Core AgentSession 身份的候选提供 Copy Agent link；原 Provider Session ID 可独立复制，原生会话尚无 Core 身份时不伪造 Agent link。Take over 从所选候选的准确执行 Host、目录与原历史来源创建新的接管 Agent，沿已有接管创建与原操作核对能力，不要求先恢复原 CLI；原 Session、Run、工作面与草稿保留。预览或发现观察失败不能拿走已有操作，错误来源与未知回执仍在原操作范围内说明。扫描、列表预览与选中详情分别消费自己的相关事实；更新未改变行身份或原历史页时，不重复订阅整份列表或重建完整阅读内容。

- **交互先兑现，动态随真实动作。** Agent 选择和部分开合由原控件与原状态立即兑现；键盘 Tab、Enter / Space 与浮层 Escape、关闭返回焦点沿既有可访问控件，不等待动效才允许输入或提交。Browser 收起或工具关闭移除原控件后，焦点交回同一对象在本 Launcher 的展开 / 恢复入口，不能落到 BODY 让用户重新寻找位置。Options 的有限退出呈现不能继续接收点击、Tab 或旧提交；快速关闭重开、切 Agent 和尺寸变化后，旧完成事件不得关掉新面、覆盖真实选择、丢草稿或抢焦点。选择连续反馈只跟随本次真实目标，hover 不选择，未知环境不冒充已连接；动效不重挂编辑器、Terminal 或复制 Runtime / draft / selection owner。原选中 Agent、Options、名称、Prompt、Browser / Note 草稿和健康 Run 保留。截图、文件或 Skills 选择器的异步结果沿准确来源 Region / 草稿归属，来源已改变时不得写入后来的输入或抢焦点；原引用与失败事实保持可追溯。当前 Launcher 只订阅自己实际使用的输入与名称，不因无关 Session 更新而放大 retained 工作面的局部观察或渲染工作。减少动态、Launcher / document 隐藏或 retained inert 时停止装饰动态及无关局部观察，按当前状态立即呈现可读静态反馈，临时退出内容确实释放；不以动画终止事件缺席阻断原动作。视觉与材质复用唯一见密度 SSOT 同节。

## Region 适配与重启保全


- **Region 自身决定适配。** 宽、窄、矮以及连续分割下，主输入和启动、Resume、设备标签与恢复入口可达，没有横向撑破、双重滚动陷阱或弹层被 Region 裁掉。矮 Region 的起点首屏优先保留完整主输入与主动作，装饰间距和辅助阅读面不能先占预算而把空请求的启动动作挤到可见区外；展开辅助面仍保持原偏好与可达滚动。偏好展开状态与当前宽度是不同事实；尺寸临时收敛不得抹掉用户偏好或重建工作对象。主 Composer 沿既有整框可编辑与草稿身份合同。

- **重启恢复保全先于界面优化。** 同一次进程重启后，原 Tab / Tab Group / Region / 焦点 / 分割布局先按 Core durable 状态恢复，Launcher 部分偏好和未发送草稿保留。健康 Run 自动接回；已结束或丢失 Run 的恢复时机、按需执行以及 Mote 固定主对话的例外，唯一遵循[《冷启动按需恢复》](session-recovery.md#冷启动按需恢复p0-末位)，不因 Launcher 可见或草稿存在批量启动 CLI。临时空快照、超时和探测未知仍保留原工作面并用服务窗说明，只有 Core 终局事实允许移除投影。工具开合、Region 尺寸变化与 Mote 联动都不停止或重复创建健康 Run。

视觉、密度、材质和控件层级唯一见密度 SSOT[《初始 Launcher 的现代工作台密度》](../presentation/spaces-and-layout.md#初始-launcher-的现代工作台密度)；本节只定义行为与约束。
