# Diagnostic Evidence 公共协议

本规范持有证据封套、读取与组合的公共语义。字段和签名唯一见 [portable protocol](../../packages/diagnostic-evidence/src/protocol.ts)、[query](../../packages/diagnostic-evidence/src/query.ts) 和 [AgentMux 领域类型](../../packages/core/src/diagnostic-evidence.ts)；不另维护 schema 或完整字段副本。目标与行为约束见[独立设计](../design/diagnostic-evidence.md)，接入步骤见[模块指南](../guides/diagnostic-evidence-integration.md)。源码能力、发布与安装分别成立。

## 包、分层与扩展

`@agentmux/diagnostic-evidence` 是无运行时依赖、无 Node/UI/领域 IO 的 TypeScript 包。它提供 `DiagnosticEvidenceReader<TTarget,TData>`、引用与显式关系类型，以及 `DiagnosticEvidenceQuery.inspect`。普通 reader 不需要 timer、schema、operation 系统、额外 store 或 daemon。

业务 owner 持有目标、采集、原件、安全投影、权限、存储、时间及恢复解释。宿主显式注入 reader，沿原服务组装；通用包不扫描或装载任意插件。扩展 AgentMux 公共入口时，在 Core 的领域 union、实际 wire codec、分派和 CLI 加入同一强类型分支。该组合层只调用原 owner，不把新的领域规则加入 portable query。参考 [Delivery reader](../../packages/core/src/delivery-evidence-reader.ts) 和 [Toolkit reader](../../packages/core/src/toolkit-failure-evidence-reader.ts)。

内部模块直接使用强类型。文件、IPC、RPC、跨 Host、Provider 数据在真实接收边界解析；原 codec 可复用。没有 schemaVersion 的进程内 envelope 不需要为统一观测另加版本；持久原记录继续沿原 owner 的 schema，RPC 继续沿已有公共协议演进规则。跨语言 JSON Schema 只在实际消费者需要时贡献。

## 目标、原记录与身份

`target` 是所需来源和有界读取目标，`recordRef` 是实际取得的原记录。没有原 logId 的实时观察、artifact、Toolkit execution 和缺证均允许 `recordRef=null`，不得 mint 占位 ID、复用 root ID 或生成伪记录。

logId 沿原 owner 一次分配并全链复用；现有 Delivery 使用 identity 包的 `mintObjectId`。不可覆盖冲突核验仍由原存储执行。业务 operationId、RPC request ID、executionId、Session/Run、ACK 和 Native 语义完成是不同事实。

authority 统一为 `kind/id/lifetime`，仅描述记录 namespace；Delivery 分别使用 `client-journal` 的 journalId 和 `core-runtime` 的语义 runtimeId，客户端故障档案使用独立的 `client-incident-archive` 身份。routeHostId 是读取路线，不能当 runtime 身份。durable/instance/unknown 是实际取得的生命周期范围；Hosted cached identity 未公开其持久范围时为 unknown。当前 namespace 不回填旧记录的当时 producer、build、PID 或 ownerInstanceId。

authority 元数据与原记录可读性独立。未限定 authority 的准确 logId 读取在元数据 EACCES/损坏时仍可 found，保留 `recordRef.authority=null` 和身份缺证；显式 kind/id 限定必须 verified 且匹配，否则该限定读取拒绝，不能自动放宽。查询不连接、探测或恢复 Runtime 来补身份。journal 身份由原接收存储有界创建，读取本身不创建身份或改写旧文件。

## 读取结果与原始材料

| 字段 | 语义 |
| --- | --- |
| availability | 本来源取得材料的结果；not-found 不证明从未发生，缺索引/保留凭据时 completeness=unknown |
| scope | record、point-observation、interval-observation 或 artifact 的材料形态，不要求正常观察伪装失败 |
| observedAt / readAt | 原来源 wall 观察时刻与本次读取时刻；读取不刷新原快照时间，也不跨时钟相减冒因果 |
| persistence | 原 owner 的实际确认；读到旧文件仅 observed，不重新确认当时 fsync |
| completeness | 材料实际完整度，沿 cause 截断、遗漏及缺证，不从查询成功推出 complete |
| raw.retention | 原 owner 实际保留原文；retained、not-retained、unknown 与读取授权独立 |
| raw.returned | 本次 included、withheld 或 unavailable；included 也必须保原截断范围 |
| issue | 本来源的诊断问题；不替换 data 中的原业务失败，亦不冒外层传输错误 |

默认只传安全字段。有限来源码、阶段、结构化确认、准确身份和时刻可以投影；任意 message/detail/stack/stderr、Prompt、凭据、自由关联说明和未知原错误码不因短或大写而变安全。原件只有 `includeRaw=true` 且原来源权限成立时返回；未知码留在原件。原件只代表 owner 实际保留的材料，不能还原未保存的 Error、stderr 或深层 cause。

普通 Toolkit get 已隐藏字节片段元数据时，未见截断只能使 `raw.truncated=null`；已有文本标记证明截断时仍为 true。safe summary 的 completeness 描述已取得投影，不能代签未读取原件的完整度；只有显式取得原材料才能据其元数据确认 false。查询不得为补该字段隐式读取 raw 或借当前 execution 的字节。

Toolkit 的 `diagnostics.failureEvidence` 保留原领域读取状态；封套 `raw.returned` 描述组合查询最终是否返回材料。原件超过剩余查询预算时保留安全失败，列 `omissions=['raw-query-budget']`、partial 和 QUERY_BUDGET，raw withheld；不返回重新裁切却标 complete 的“原件”。安全投影自身超预算时返回结构化预算结果。

## 关联与部分结果

关系由领域提供 `related(read)` 和 `relations(reads)`，portable query 不推断业务因果。basis 仅为有限 kind 和原证据 refs，不接受自由说明或正文；依据计入数量与字节预算。declared 目标端引用可以指未读取的已声明 logId，但该端 authority=null，实际 `recordRef` 仍为 null；basis.refs 只含实际读到的原记录。

Client 的 coreLogId 是客户端声明。取得双方原记录且 authority verified、双方已有的 Session/operation/预期 Run 等约束相容时最多 target-matched。缺原目标/身份为 declared 或 unverifiable，已核条件冲突为 conflict。expected Run 与失败时实际 Run 分开；同 ID、文本、时间接近或读取成功不能升级 owner-confirmed、Native 接受或 Input 已执行。

各来源不可达、损坏、不支持、缺证、权限拒绝、真实超时和投影失败可以 partial 返回。后续来源或关系处理失败不抹已取得 root。外层请求无效或 wire 封套违规仍为协议错误；不得用它代替来源的合法 unavailable。

## 查询预算与生命周期

当前小封套上限由 [query 常量](../../packages/diagnostic-evidence/src/query.ts)唯一持有：8 次读取、2 层关联、128KiB 序列化结果、1500ms，以及每个 service 8 个实际在途调用。请求只能收紧，maxDepth 可为 0，maxBytes 最小 4KiB；target 上限 1KiB。深度、重复目标、关系依据、错误封套和 capabilities 均计入预算。profile/heap/图片等大 artifact 由原 owner 分块读取，不塞进此封套。

查询使用本机 monotonic 时间控制本次期限；原观测时间仍保持原来源语义。超时/取消只中止本次等待并传递 signal，已经启动且不能取消的 IO 继续占实际槽至真正 settle。deferred reader 调用前重核取消和期限；不会重放读取或采集。Delivery 文件 reader 另保每 store 8 个真实 pending IO，并复用同 logId pending；finite 等待返回不释放原 IO 槽。

reader 生命周期归原宿主；复用一个 query 实例承担 service 总在途上限。普通读取无后台采样。未来 capture 需原 owner 的精确请求/采集身份、有限期限与预算，取消等待不代表停止采集，stop 返回不等于实际终态，丢回执不能自动重新 start。本入口没有 capture/start/stop/history 能力。

默认预算是可收紧的小封套上限，不承诺机器在压力下达到特定延迟；成本通过真实消费、超限及非取消 IO 反例核实。原 journal 总留存仍由 owner 治理；本包不增加第二套记录库或声称旧 Delivery 目录已有总体淘汰能力。

## 错误码

机制码使用 `DIAGNOSTIC_EVIDENCE_` 前缀及 [finite issue union](../../packages/diagnostic-evidence/src/protocol.ts)。源码码名为 SSOT，不再列一份并行全集。stage 区分 read、authority、projection、query。causeCode 只有原来源明确安全的有限码可默认投影；源码中的领域投影集合不是全局错误注册表，新增码按原 owner 的真实条件贡献。

原业务错误、诊断 issue、外层 transport/protocol error 分别保全。清理或保存失败不替换 primary；not-found 不必造错误，Native 当前 not-exposed 明确缺来源。诊断 drop/失败不能递归产生无界诊断，不 gating 健康 Input、Browser 或原工作面。

## AgentMux 公共入口

`system.diagnostics.inspect` 是 typed、只读 RPC；CLI 为 `amux system diagnostics inspect`。`--list` 只列本服务实际组装的领域合同，不读 owner，也不宣称当前来源在线。具体签名见 [public-rpc](../../packages/core/src/public-rpc.ts)，命令和 help/skill 来自 [CLI 注册](../../packages/core/src/agentmux-cli-commands.ts)。

公共宿主已有 business-owner 转接时，发现并列本地与原 client 实际返回的能力，按 domain/target 组合保本地合同，同领域的不同选择器分别保留。已有本地选择器始终沿原 reader、journal、authority 和原件，不依赖 GUI；只有本地未组装的选择器才通过原通用转接读取。转接缺失或真实 transport 不可用时保本地事实；远端明确拒绝、取消、预算结果或坏回执不改成本地重读，也不凭转接 callback 广告能力。原 client query 继续持其实际在途成本，不新建第二 query 或跨跳完成期限。

| domain | 准确目标 | 原 owner 与范围 |
| --- | --- | --- |
| delivery.client | hostId、logId，可选 authority | receiving client journal；默认安全投影、显式原件 |
| delivery.core | hostId、logId，可选 authority | 已有 Core client 的原 DeliveryAttempt；路由与语义 runtime 分开 |
| toolkit.performance-failure | hostId、executionId | 原 Toolkit get 的 latest failure；无 logId，不提供 archive/采样 |
| performance.scene | hostId、captureId | 原 Scene owner 已保留的 capture；读取不启动采集，无原 logId |
| mote.context.client | client route hostId、原 resource scope、prepare/open-space action；open-space 另含完整 reference | 原 client action owner 的 latest-per-scope-action 事实；无 logId、持久化或健康结论 |
| reading.lifecycle | hostId、logId、可选原 Core instance authority，或 recent 范围 | 原 Core read／watch 的有限阶段；仅当前实例，metadata-only，原 scope 与访问路线分开 |
| agent.startup | hostId、logId、可选原 Core authority，或 recent 范围 | Core 已接受的原启动 unknown／failed 及其后来 ready；[领域类型](../../packages/core/src/startup-diagnostic.ts)保留原 Run／actor／lifecycle、来源时间与接收者，默认隐藏私有失败文本 |
| client.incident | client route hostId、logId、可选原 archive authority，或 recent 范围 | 原 client 档案的有限 Terminal／连接／探测／读取阶段；[公共类型](../../packages/core/src/client-incident.ts) 持字段全集，保原 producer 和原 reading ID，确认状态逐记录表达 |
| client.notifications | client route hostId、原通知 ID，或有界列表筛选 | 原通知 client 当前问题和保留活动；[公共类型](../../packages/core/src/client-notifications.ts)持字段与严格解析，无日志档案，读取不标读或恢复 |
| native-recorder-failure | hostId、agentSessionId、runId | 当前缺原 producer，not-exposed/null 原引用；不冒根因已取得 |

managed Agent 沿原 capability 认证，受自身 Host 路线限定，不能借 user/device 或 Runtime 私有权限读其他 Host。局部拒绝不关闭原健康 Agent。GUI 继续沿原领域消费事实，既有 message.delivery.inspect、toolkit.inspect/watch 语义和原件能力不被替换。

`agent.startup` 的 `--recent` 不要求 Session ID，可按原 source observedAt 范围、SID／Run 和最多 32 条分页；cursor 绑定原 authority 与筛选，返回顺序是该 journal 的接收序列，不把来源 wall clock 当单调时钟。精确读取沿 `--logid` 和可选 `--authority`；恢复记录的 `previousLogId` 仅关联同一 SID／Run／actor／frontend／lifecycle 下原已保留的异常，不授予恢复权限。正常启动不新增记录，订阅前与 owner 空窗均是未知覆盖，不能从空页推定没有发生过故障。

原 Headless semantic owner 注入已确认 runtimeId 和当时 ownerInstanceId；file Store 的 durable authority 可在另一 owner 下读回，bare SDK 仅有 instance 范围并留在有界内存。持久记录在原状态根旁独立存放，最多 128 条／512 KiB 记录 payload；索引、单条未完成发布凭据及临时候选分别有额外固定边界，最多 32 条待写观察、一个实际写入和四个实际文件读取。写入／索引失败停止本 owner 扩盘，保有界内存和缺口；新 owner 仅对一个原发布凭据对账，不碰 Session／Run／输入。取得独立诊断写锁后，最多检查该诊断目录 141 项；超过 140 项时停止新持久化并报告覆盖缺口，不删除未知临时文件，也不把目录项当 Agent 历史。此上限限制本机制继续扩盘，不声明已有未知文件的字节数或全盘保留量。索引损坏不覆盖原索引，合法 exact 原件与 recent 缺证分别表达。

诊断写锁独立于 semantic lease。旧 owner 的真实诊断 IO 未结束时仍持原锁，Core 关闭与新 owner 的业务接回不等待它；新 owner 仅报告诊断 busy 并保有界观察，后续实际诊断读取或观察再尝试原锁并加载最新索引，没有后台重试计时器。诊断自身失败不会改变启动结果。

安全摘要保原步骤和数字码（包括 `0`），字符串码仅沿有限安全集合；任意错误原文默认 withheld。显式 `--include-raw` 只返回已取得的 `failure.message/code` 有界材料，不含整个 Error、stack、环境、argv、Prompt 或终端副本；已知原 actor／Hook 凭据先精确脱敏，保原 JSON 材料字节数、实际留存字节数、裁切与脱敏事实，不把它冒充未加工完整原件。错误正文最多保留 4096 UTF-8 字节、字符串原码最多 2048 字节，实际 JSON 材料最多 8192 字节；转义膨胀会进一步裁切私有材料，保留安全事实。没取得材料时 `not-retained`。原 Run output 引用标 `not-captured`，读取该引用仍遵循原输出保留与权限合同。

通知查询沿原 client 已提交的投影，面板收起时仍可读，不为请求重新挂载阅读 owner。每项保原来源、对象、Current／Activity、等级和阅读状态，准确 ID 与内容版本分别沿原身份压缩；不是 logId、操作身份或权限。`recordRef`、authority、persistence 与 envelope observedAt 均为空，scope 是 point-observation；实际接收或观察时间只在原条目中保留，缺失时不补造。原 document 的 instanceId 限定本次范围，未注册、已卸载或加载代次不匹配不能返回另一窗口或假空列表。

通知列表的总数是筛选后分页前的原条目数；cursor 绑定原 document、列表快照和筛选范围，不另留快照 Store。原内容或阅读事实变化后旧 cursor 返回 expired，调用者须从新列表开始；准确 ID 查询返回原条目当前版本，缺席为 not-found，不代表问题从未发生。默认只返回有限结构字段，任意标题、原因、对象名称或路径只在显式 includeRaw 中返回；原文超过当前预算则整项 withheld，保安全条目、raw-query-budget 与 partial，不能裁掉正文却声明完整。来源尚不完整时 coverage 保原不可用来源，零条目不冒充没有通知；读取不标读、清理、focus、探测或重试，健康 Run 与用户工作面不受影响。

`recent` 是有界发现，不指一条原记录，因此 `recordRef=null`；每个候选保自己的准确引用，再以其原 authority 和 route 读取。cursor 只续接原来源、namespace 和筛选范围，不跨重启猜测重用。`reading.lifecycle` 的来源仅有 instance authority，不能声明 durable；exact 的 observedAt 和 completeness 与原事件时间和覆盖缺口一致。`client.incident` 的原档案 authority 不等于当时 Renderer producer；接收时间不能覆盖内嵌 reading 的来源时间。两种目标都沿原公共入口，不提供任意 payload 或本地文件读面。

客户端故障档案的 recent 只发现当前保留候选，空页不能签此前没有故障；准确原件读取保原 authority 与持久确认语义。报告的执行 Host、Main 接收身份、Renderer 文档代次和原观察时刻分别保真。关联仅沿报告已得的 typed references 交给原 reader，重复目标按 JSON 对象语义去重；对象属性顺序不改变目标身份，数组顺序仍保留。查询不为补关联触发输入、刷新、探测或采集；没有公共 reader 的来源仍为缺证。

Mote scope 的 host/path 来自原 action 捕获的 resource Workspace，不能用 Mote 的 physical/HomeZone/logical topic 目录替代。客户端路由和资源 Host 可以不同；读取不连接资源 Runtime。原 pending attempt 与保留 failure 的 target/time 分开，后来的发现不改写它们。该 point observation 的 recordRef/readAuthority/persistence 为 null，envelope observedAt 为 null；实际 action/failure 时刻留在 data，readAt 只表示本次读取。source absent 的 not-found/unknown 不签历史无错误。

Mote 默认 safe 投影在 Renderer/IPC 原边界就移除任意 cause；显式 raw 只返回实际 retained 原字符串，不重建 Error/stack/cause chain。原字符串无截断元数据时 raw.truncated 仍为 null。原独立 `inspect.mote-context` envelope 与 loaded Renderer/navigation owner 一致，旧严格 `inspect.client` v1 不添加字段。查询期限或取消结束等候时，实际 IPC 成本仍占原槽直到回复或原 owner disposal。
