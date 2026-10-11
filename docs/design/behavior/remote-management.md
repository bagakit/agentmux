# Remote 管理 PRD

本文是 AgentMux 远程管理的产品需求与行为 SSOT。它回答用户如何理解远端环境、找到正在工作的 Agent、判断观测缺口并完成准确的管理动作；Session 恢复、权限、消息和资源测量仍由各自原 owner 定义。当前源码入口见[公共能力与当前实现基线](#公共能力与当前实现基线)，源码存在不代签安装包或某台远端的运行能力。

[交互合同入口](../agentmux-desktop-interaction.md) · [Remote 呈现](../presentation/settings-and-observation.md#remote-管理拓扑) · [设置共同合同](settings-and-observation.md#设置页的信息架构)

## 已确认方向与方案范围

Remote 管理是独立、完整的产品主题；设置提供明确入口，以可探索的拓扑改善远端管理与监控的理解，实现时优先复用项目已有的无限画布依赖。用户提供的深色节点拓扑与右侧详情是构图参考，不授权接入其中的公网入口、代理出网、网络跳点或探测服务。

本文的观察层级、主流程和信息优先级是据此收敛的产品方案。分期是设计建议，不自动创建执行任务；新增采集、历史保存、通知策略、远端部署和控制能力须在对应 owner 明确合同后安排。当前实施范围是完整管理工作台与所选 Host 的真实只读运行监控；长期历史、主动告警、部署和批量运维仍按各自用户任务单独决策。

## 产品目标与主要任务

Remote 管理首先帮助用户回答四个问题：我连接了哪些环境；哪台机器上有哪些项目和 Agent；现在确认了什么、哪里尚未确认；下一步能沿哪个原对象安全完成。

- **找到工作。** 从一台远端进入其已登记项目和原 Session；从一个有问题的 Session 返回其真实执行 Host、语义 Runtime 和具体观察来源。
- **判断影响。** 区分一项连接检查失败、一个 reader 失败、Runtime 身份不符与 Agent 本身故障，知道哪些工作仍可继续。
- **完成管理。** 在准确环境上编辑连接、测试、登记已有项目、查看执行器、核验来源信任或查询原维护操作，明确动作目标和真实回执。
- **减少记忆。** 图与详情共用同一对象选择，保留可读的名字、地址、执行归属和最后确认时间；无需对照多处设置或记住 Session ID 才能追踪问题。

管理台不取代终端、Focus、项目导航、Session 工作面或通用 Performance。它是这些原对象的管理入口与观察投影，不建立第二套执行 Runtime、Agent 名册状态或跨 Host 权限。

## 对象与唯一 Owner

| 对象 | 在管理台中的含义 | 事实归属与不可混同之处 |
| --- | --- | --- |
| 管理入口 / Endpoint | 本客户端正在消费的原业务服务及其能力范围 | 原公共服务与客户端连接事实；CLI 所在机器、接收 Core 的机器和执行机器不混同 |
| Host | 原 endpoint 范围内的本地或 SSH 稳定路由及连接配置 | 现配置 owner；名称、SSH alias 和地址可编辑，不是跨 endpoint 全局机器 ID，也不证明连接就绪 |
| ExecutionHost | 该环境上的文件、shell 与目录访问能力 | 原 Host 执行服务；目录可读不代签 Agent Runtime 可用 |
| 语义 Runtime | 持有 Provider、AgentSession、权限与恢复语义的 Core 服务 | 原执行 Host 上的 Core；持久 Runtime 身份与当前服务进程代次分别表达 |
| ctxmux Runtime | 服务 PTY、Run、Attachment、ordered bytes、Replay 与 Gap 的运行时 | ctxmux；其身份、物理运行事实和资源读数不由 Desktop 猜测 |
| Project / Workspace | 已登记的准确 Host、目录与项目工作面引用 | 原配置与空间 owner；同名或同路径不证明跨机器同一目录 |
| AgentSession / Run | 持久 Agent 身份及某次执行实例 | 原 Core / ctxmux；Session 数、运行 Run 数和 Provider 工作状态是不同事实 |
| Tab / Region | 本地客户端展示原执行对象的位置 | Core 空间 owner 与客户端呈现；打开、选中、拖动拓扑节点不移动执行 cwd |
| Phone / Device | 被授权访问原宿主服务的客户端设备 | 原设备与授权 owner；与 SSH Host 不是同一类资源，不混算为远端服务器或跨 Host 授权端点 |

身份、绑定与恢复的完整合同唯一见[联邦 Runtime 与远端恢复边界](session-recovery.md#联邦-runtime-与远端恢复边界)、[Endpoint、Host 路由与源身份](public-control.md#endpointhost-路由与源身份)及[统一概念与空间寻址](spaces-and-layout.md#统一概念与空间寻址)。管理台消费这些事实，不能因需要画图或展示“健康度”增加自己的事实 Store。

## 入口与观察范围

Remote 在 Settings 中有可发现的独立管理入口，搜索、Overview、Host 身份入口及原设置深链都能到达准确对象。原连接、项目和信任管理能力沿同一 Host owner 承接，不以增加 Remote 为由出现两套可编辑 Host 清单。Settings 将 Remote 作为独立分组，环境工作台以 Environments 为入口，保留原 `hosts` 对象与准确导航身份。Phone、外部对话应用和全局 Executor 模板继续由原 owner 管理。

同一环境工作台按总览与监控、项目、应用与访问、连接配置组织任务。切换任务仍持有同一个准确 Host、原草稿与已访问操作，不建立三套选择器、清单或配置副本。总览承接拓扑与分源观察；连接配置承接原编辑、Test 与 Core 维护；应用与访问承接该 Host 的真实执行器盘点及跨 Host 来源核验、真人批准。全局模板不冒充远端已安装应用。

应用账户凭证、来源 Core 信任、单次 Agent 权限和 Phone / Device 配对各有不同主体与授权 owner；应用与访问不暗示它们已统一同步。后续账户同步须先限定应用能力、准确来源与目标、私密材料流转、撤销与目标侧验真合同，再决定执行；本轮不复制登录态、系统权限或整个用户目录。

进入后先显示已登记的环境和当前已有事实。查看拓扑不自动部署、升级、恢复全部 Session、运行任意 shell 或探测网络；需要实际连接才能取得的观察应在原服务明确范围后按需进行。离开页面只释放本页观察，不断开其他消费者或停止健康 Run。

“所有环境”必须说明它是已配置环境，不能冒充扫描发现的全部机器。筛选可按名称、地址、项目和明确的待处理状态收敛；筛选只改变可见范围，摘要说明过滤条件与观测覆盖，不把被过滤或读取失败的对象算成不存在。

## 拓扑及选择模型

### 真实关系优先

首层拓扑展示“本客户端 / 管理入口 → 原 endpoint 内 Host route → 已核验 Runtime”的逻辑关系。身份沿[Endpoint、Host 路由与源身份](public-control.md#endpointhost-路由与源身份)，不能把接收 Core 中的 `local` 一律画成 CLI 所在电脑；普通 Desktop 只有在原本机身份已确认时才显示 This Mac。Host 节点以原 endpoint 与 Host ID 定位，Runtime 有确认事实后再披露其准确绑定，不新增全局机器 ID。

边表示所配置或已确认的逻辑关系，不承诺真实物理网络路由、SSH 配置内部跳转或正在保持的 socket。连接观测有来源时才在边上表达其结论与时间；没有当前观察时仍保留配置边，并明确其未确认性质。

SSH alias、ProxyJump、内网 IP、相同主机名或地理名称不能自行派生网关、跳板、云区域与设备节点。以后增加协议可证明的中间关系，须保留其原来源、主体、用途和覆盖范围；原参考图不是来源。

同一 Host 的 Runtime、项目、执行器和 Session 关系放在选中详情或按需展开，不默认把所有资源铺成不可读的大图。多个 Host 是否属于同一物理设备，缺少权威身份就不合并；即使多个 route 已确认为同一 Runtime，也保留各自准确路由，不把连接别名统计成独立 Runtime。Host、Runtime 与会话聚合各保留自己的身份范围和去重口径。

### 连续理解与准确导航

拓扑节点和等价列表选择同一准确 Host，详情显示该对象当前可用事实与动作。缩放、平移、适配画布和筛选不改变配置、连接、焦点工作面或执行绑定；不提供拖线建立连接、拖拽迁移 Agent 等缺少真实业务合同的交互。

用户明确选择项目或 Session 后，沿原导航打开其准确工作面；现有工作面优先复用，远端暂不可用仍可查看原引用与恢复服务窗。选中节点本身不启动 Agent，不偷换当前执行环境。跨设备项目编组仅引用[原项目组织关系](spaces-and-layout.md#project-与-workspace)，不画成网络连接或一台虚拟 Host。

## 信息与监控层级

默认阅读顺序是环境身份、当前可确认结论、正在承载的工作、下一步；技术细节逐层披露。每一项动态事实均能追溯准确 Host / Runtime / Session / Run、来源与观察时间。最近成功与本次失败分别保留，不用刷新时间替旧值续期。

| 阅读层 | 应回答的问题 | 信息与边界 |
| --- | --- | --- |
| 环境总览 | 哪些环境值得我先看 | 已配置环境数、当前观察覆盖、明确需要处理的对象；不同事实不压成缺少依据的全局健康分数 |
| Host 节点 | 这是谁，现在知道什么 | 名称、连接类型、简短地址、具名观察状态、最近确认时间；可选项目与 Session 摘要明确是登记/引用还是当前运行口径 |
| Host 详情首层 | 这台环境正在承载哪些工作 | 准确 Host、语义 Runtime 绑定及身份确认结果；可定位的项目与原 Session；当前观察缺口和一项明确下一步 |
| 执行与能力 | 在这里能启动或恢复什么 | 原 Host 的执行器清单、Provider、配置来源、可用性、失败原因；全局模板不能冒充该 Host 已安装配置 |
| Runtime 详情 | Core 与物理 Runtime 各处于何种状态 | 当前可证明的 Runtime / owner / Native 身份、协议、平台与能力；serving 与 bundled 候选明确区分 |
| 资源详情 | 资源来自哪里，读数有多新 | 原 Runtime 已公开的 Run、Attachment 与保留输出等事实；CPU、内存、磁盘、链路质量仅在有原 owner 的测量合同时展示 |
| 诊断与维护 | 失败在哪一步，原动作做到了哪里 | 准确来源、步骤、原因、原 operation 与阶段、下一步；观察当前状态与查询旧操作回执分别表达 |

Session 的工作、等待、权限请求、未知等状态沿[Core 语义与 Provider 事实](agent-capabilities-and-messaging.md)，不能从进程 running、终端文案、输出速率或最新活动时间猜出。离线、尚未测试和不支持必须可辨；没有当前读数时不补零，也不借用本机 CPU、内存或卷容量代替远端。

资源采样、逻辑核口径、stale / pending / unavailable、共享采样及最后消费者释放沿[资源观察合同](settings-and-observation.md#status-bar-cpumemory-资源面板)。本管理台不另定义采样循环，不因缩放、图布局或节点渲染扫描无关 Session。历史趋势、告警阈值与长期可用性统计是有独立采集及留存成本的后续建议；未有 owner、观察区间、缺测与留存合同前，不画虚构曲线、在线率、延迟或资源趋势。

## 连接配置与测试

通用保存、冲突、搜索与草稿规则仍由[设置共同合同](settings-and-observation.md#设置页的信息架构)持有；本节持有 Host 专属要求，页面结构变化不授权另一份配置实现。

- SSH 连接的常用编辑为名称与 hostname／系统 SSH alias；用户、端口、密钥和服务覆盖按需展开，保留已有字面值与只读 Runtime binding，不扫描、展开或导入 SSH 配置，不自动部署服务。空覆盖沿系统 SSH 已有行为；保存连接不等于连接已就绪，Test 仍使用完整当前输入并显示真实结果。连接复用沿原 Workspace→Host 引用，展示选择不为全局 Executor 模板另存一份 Host 绑定；目标 Host 的注册配置与可用性沿[执行器设置 owner](settings-and-observation.md#设置页的信息架构)取得。Session 数只表达实际引用，不冒充运行中数量，原删除和保存保护不在布局调整中放松。 已确认本机 Host 不挂载 SSH 连接字段；其他对象的编辑挂载、精确选择、重复导航、新建聚焦、搜索命中与窄窗返回沿[设置共同合同](settings-and-observation.md#设置页的信息架构)。

- Hosts 的连接编辑区必须允许正常逐位输入 Hostname；首字符与后续内容变化不能自动折叠字段或移走输入焦点。展开/收起属于用户操作，同一 Host 的草稿、检查结果或无关配置更新不能改掉用户的展开选择；新 Host 可直接进入编辑。

- Hosts 编辑同样保留原始字段基线与保存期间后续输入；无关 Host/字段提交只刷新 clean 内容，同字段冲突、准备失败与外部删除保留草稿，不用保存时的新快照消除冲突或静默重建。当前远端准备能力尚不可用时如实说明，不把受控准备条件下的保存成功冒充远端 Runtime 能力，也不打断无关本地健康 Run/Input。说明文字和 Test 反馈须与当前实际能力一致，不先承诺保存或测试可用、再在动作后否认；失败原因完整可读，草稿与健康输入保持。

- Hosts 的 CLI 读取已提交的连接记录；已保存连接按明确稳定身份取得当前已提交对象并测试，草稿才按明确输入测试，不猜默认 Host、焦点或显示名称；测试不改配置、工作面或健康会话。连接就绪、当前能力明确不支持与检查没有取得事实必须区分，不能把检查失败说成目标不可用，也不能把未知说成就绪。测试结果保留原始原因并绑定本次输入，CLI 回执与界面当前结论都不得把同 ID 的旧 Ready 用于后改或并发替换的连接值；新输入未测试时如实说明，不覆盖检查期间的后续编辑；远端尚不支持时如实说明，不用另一条启动路径绕过它。Host 删除、连接重绑与身份复用另有引用完整性合同，不能只凭可见会话或 connected Run 为空放行。

- Remote 中的环境库按稳定 Host ID 展开对象子菜单，分别查看连接配置与已登记项目。展开或关闭只改变导航；项目依据原 Workspace 的 `hostId` 投影，不以同名、同路径或当前焦点猜归属，不产生第二个项目编辑器。切换对象、子页和手机设备分区继续保留原全库草稿、按对象持有的高级展开选择、保存期间输入及冲突，窄窗返回准确当前子页入口。

- **首次跨 Host 来源信任由用户显式批准。** 已保存的目标环境在应用与访问中提供来源核验入口，显示本机来源与目标的 Runtime 身份、公钥指纹和目标已保存的信任事实；仅真实用户核验后明确批准，不自动信任、不替换已绑定公钥。连接、身份或公钥变化使旧核验失效，未知、冲突和保存失败保留真实原因及重新核验路径。该入口复用原 Host 的公开信任能力，Agent 不能借自报身份或界面输入替用户批准；身份与签名合同沿[A2A owner](agent-capabilities-and-messaging.md#a2a-身份信封与持久化全局消息队列)。

## 诊断、维护与授权入口

跨模块证据、关联、历史与采样机制统一由[Diagnostic Evidence 设计](../diagnostic-evidence.md)持有；Remote 消费其原对象与来源，不另建诊断 Store 或事件中心。诊断先解释失败边界和已有可用能力，再给沿原目标的动作。连接测试、资源刷新、执行器检查和维护检查分别说明范围；它们不互相代签，不将“重新测试”包装成自动升级或重启。只读摘要可提供安全的准确身份、版本依据、失败步骤和原操作引用用于复制，密钥、token、私有 Executor 环境及输入正文不进入普通诊断。

连接检查失败的总览给出进入同一准确 Host 连接配置的动作，保留本次检查输入与原原因；不按错误文案猜处理路径，也不阻断原 Session。Native 能力按原适配器声明逐项呈现，说明来源读取时间与当前或保留的证据；声明不代签某个 Run 的状态或授权。当前协议六项能力均为必需声明，不制造“不支持”的虚构分支；没有来源则未确认。

已有 Core 升级与原操作查询在主阅读层呈现原回执当前阶段及更新时间，不推算百分比、已完成步骤或预计耗时。原操作查询沿维护 owner，准确资格、原 Runtime 与 Native 保全规则只见[远端恢复与维护合同](session-recovery.md#联邦-runtime-与远端恢复边界)。未知回执保留原 operation，详情优先提供原结果查询；刷新当前连接不能变成重做升级。自动部署、服务托管、批量重启、远端清理和批量信任不属于本次拓扑方向自动授权的能力。

来源信任沿本页[连接配置与测试](#连接配置与测试)及其引用的 A2A owner；节点选择、Test 或展示不代签批准。Phone / Devices 仍沿[设备接入合同](public-control.md#手机版-relay-连接)，不把“可信来源能创建 Agent”混写成“此设备有所有远端管理权限”。

## 状态、失败与恢复

每个 Host 同时可能有连接配置、最后成功观察、本次读取结论、若干仍健康的 Session 和一个未决维护操作。管理台保持这些维度独立，只在首层提出最需要用户处理的一项结论，完整原因可下钻；不发明一个覆盖全部维度的红绿总状态。

- 完整权威读取确认的零集合可以显示为空；pending、未测试、连接失败、来源未取得或局部失败都不能变为空集合。
- 配置修改后，旧检查仍属于旧输入；未提交草稿、已保存配置、当前检查与已完成业务操作分别显示。迟到结果不能覆盖后选 Host、较新配置或另一 Runtime 的事实。
- 观察失败保留上次已确认信息、来源和时间，并持续说明缺失步骤与恢复动作；最后确认的旧值不能当作当前正常。单项失败不遮掉其他已确认事实。
- 身份不匹配时保留原 Host / Runtime 绑定、引用和工作面，不自动信任新服务；本次不满足身份或授权的操作按原合同拒绝，已确认可用的无关能力继续可用。
- 服务不可达、reader 失败、未知 Session、未释放 lease 与空快照不授权删除节点对应的持久工作面。Session 终局、恢复与移除资格只由[原恢复合同](session-recovery.md#联邦-runtime-与远端恢复边界)判定。

全局通知与重复提醒继续消费[现通知 owner](settings-and-observation.md#全局通知与底部状态入口)；本管理台不因轮询、重进页面或节点重绘新增一份告警账本。新增跨 Host 告警、订阅通知和历史事件中心仍是待安排建议。

## 公共能力与当前实现基线

GUI、CLI 和其他客户端消费相同业务 owner。已有公开能力足够时直接复用；新增面向用户或 Agent 的观察、配置或动作时，在同一执行计划内判断 JSON-RPC、CLI、发现、准确回执与真实消费，沿[公共能力贡献约定](../../guides/public-capability-contributions.md)。本文不是第二份接口注册表，准确签名与命令以[公共能力源码入口](../../specs/public-capabilities.md)和当前实际 help / skill 为准。

以下是源码核对所得的实现范围，供后续执行判断复用与缺口；不代签实际安装包、远端服务能力或新拓扑验收。

| 已有基础 | 来源 | 已有范围与仍缺的闭环 |
| --- | --- | --- |
| 环境配置与管理工作台 | [HostConfig](../../../apps/desktop/src/shared/contracts.ts)、[HostSettingsPane](../../../apps/desktop/src/renderer/src/components/settings/HostSettingsPane.tsx)、[HostTopology](../../../apps/desktop/src/renderer/src/components/settings/HostTopology.tsx) | Remote 入口、拓扑 / 等价列表共用原选择和草稿；本地 / SSH、关联项目、原 Session 导航、执行器、检查及连接管理沿原 owner |
| Host 读取与 Test | [settings-hosts-control](../../../apps/desktop/src/main/settings-hosts-control.ts)、[公共 RPC](../../../packages/core/src/public-rpc.ts) | 已公开清单及测试；Test 结果为完整输入、outcome 与人读 detail，不能解析 detail 猜结构化版本、PID 或实时连接 |
| Session 与项目投影 | [SessionSnapshot / WorkspaceRecord](../../../apps/desktop/src/shared/contracts.ts)、[HostProjectsPane](../../../apps/desktop/src/renderer/src/components/settings/HostProjectsPane.tsx) | 原 Host / Session / Workspace 引用与已有状态可复用；引用数量与当前运行数量须分口径，读取缺口不能补成零 |
| Host 执行器和来源信任 | [public-rpc-host-settings](../../../packages/core/src/public-rpc-host-settings.ts)、[executor-contract](../../../packages/core/src/executor-contract.ts)、[HostCreationTrustPanel](../../../apps/desktop/src/renderer/src/components/settings/HostCreationTrustPanel.tsx) | 已有准确 Host 的发现、注册、可信来源读取与真人批准入口；不由拓扑另建配置或审批系统 |
| 所选 Host 的只读运行观察 | [分源观察](../../../packages/core/src/host-runtime-observation.ts)、[公共 Host 方法](../../../packages/core/src/public-rpc-host-settings.ts)、[HostRuntimePanel](../../../apps/desktop/src/renderer/src/components/settings/HostRuntimePanel.tsx) | 原 runtimeIdentity、runtimeDiagnostics、runtimeResourceSnapshot 由公共服务按准确 Host 组合；GUI 与 `settings hosts inspect` 消费同一结果。只观察当前已连接来源，缺失按来源报告，不冷启动 Native |
| Core 维护与原结果查询 | [remote-core-upgrade](../../../packages/core/src/remote-core-upgrade.ts)、[HostUpgradePanel](../../../apps/desktop/src/renderer/src/components/settings/HostUpgradePanel.tsx) | 管理台复用原检查、升级、operation 查询及诊断，保留已访问维护面及未决回执，不另写流程 |
| 无限画布 | [Desktop 依赖](../../../apps/desktop/package.json)、[HostTopology](../../../apps/desktop/src/renderer/src/components/settings/HostTopology.tsx) | 复用 `@xyflow/react`，缩放 / 平移仅改变投影；窄窗自动使用同对象列表，不新增持久画布配置 |

现有公开 Host 清单、测试和维护不等于完整配置 CRUD CLI；这项缺口由后续连接管理执行计划按原贡献约定判断。远端主机 CPU / RSS / 磁盘、网络跳点、RTT / 丢包、采集趋势与统一远端健康监控，目前不能仅凭上述源码声称已有；未来新增需从准确原 Host / Runtime 的公开事实取得，不能在 Renderer 私有 shell 探测或借展示解析补齐。

## 本次实施的完整结果

管理台在原 Settings 中替换环境管理呈现，拓扑和列表共用原 Host 选择与草稿；不保留另一套旧管理页或配置 owner。核心路径为“看全貌 → 选择准确远端 → 查看真实工作与观测 → 打开原工作面或完成准确管理动作”。项目、Session、执行器、连接、来源核验与维护均回到原业务服务，不能只有一张可拖动的图。

运行监控只读取选定的已保存 Host，沿原公共服务提供分源的语义 owner、Native 身份、诊断与 Run／Attachment／保留输出等资源事实。查看状态不冷启动 Native、不自动恢复 Session；当前连接缺失或某个来源读取失败时保留其他事实与原工作能力。观察仅随准确可见消费者存续，切对象、隐藏或取消后收敛，迟到结果不串用。

公共能力复用已有 Runtime 只读方法，由准确 Host 的查询组合；GUI 与 CLI 沿同一结果，不能在 Renderer 另跑 shell 或猜测展示文案。Core 继续与 UI 无关。新增接口的精确签名与接线由[公共能力源码入口](../../specs/public-capabilities.md)持有；源与回执、权限、恢复及性能边界仍沿本文引用的原 owner，不新增兼容层、旧版实现、迁移或独立监控事实库。

## 建议分期与交付判据

第一阶段建议先闭合准确对象和管理路径：独立 Remote 入口、真实关系拓扑与等价列表、Host 详情、已登记项目和原 Session 导航，以及原连接编辑、Test、维护和信任入口。只展示已有结构化事实；新增 Host 观察确有必要时补到原公共 owner。完成信号是用户无需猜机器、状态和作用范围即可到达原工作或完成原管理动作，而非画布可拖动。

第二阶段建议补充有真实来源的运行观察：按 Host 展示 Core / Native 身份、能力、Run 与 Attachment 等资源摘要，明确时效和部分失败，并让 GUI 与公开查询取得一致事实。CPU、内存、磁盘或链路质量只有在相应 owner 的测量合同和实际消费链完整后纳入，不以一张静态监控卡先占位。

第三阶段的候选是有界历史、变化诊断和主动通知，须先决定用户任务、来源、留存、缺测、成本与通知 owner；自动运维、部署编排和批量控制独立评审，不顺带进入。阶段顺序不是排期或全部实施承诺。

实施验收至少覆盖多个独立 Host 和相同名称/路径、从未测试与已确认正常、检查失败但健康 Agent 仍可用、部分读取与真实零值、配置换代的迟到结果、身份不匹配、原维护回执未知、按准确 Session 导航及返回。图和列表的选择/信息应一致，窄窗、键盘与主题沿[Remote 呈现](../presentation/settings-and-observation.md#remote-管理拓扑)。涉及布局或生命周期时仍按原合同验证真实重启与原工作面；涉及采样验证消费者离开后停止及无关 Session 不放大成本。测试、变异、实际公共链路和视觉评审按各原规则执行，纯文档整理不制造这些通过结论。

后续扩展仍需决定长期监控与通知的独立用户任务、来源与留存成本；本次工作台不新增持久画布偏好。这些问题不能反过来阻断现有连接、Agent 和原工作面。
