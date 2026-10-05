# Diagnostic Evidence：统一观测与诊断机制

本文独立持有 AgentMux 观测诊断系统的目标、接入边界、证据语义和错误码设计。机制覆盖 AgentMux 自身及以 AgentMux 为环境的实际执行，供模块 owner 接入、产品呈现和 Agent CLI 诊断使用。目标与职责已确认；包布局、类型形状和新增公共入口仍为设计候选，尚未实施，不代表当前安装已支持。

[文档导航](../README.md) · [交互专题索引](agentmux-desktop-interaction.md) · [系统职责地图](../architecture/system-ownership.md) · [公共能力来源](../specs/public-capabilities.md)

## 目标与交付边界

各模块应能以相对统一、可插拔的方式产生和集成诊断证据，便于当次排查、未来回查及 Agent 辅助诊断。诊断对象包括 Core、Host、client 等 AgentMux 模块，也包括实际执行中的 Agent、Browser 等。Message 投递、截图和性能观察是检验接入边界的不同领域，不限定长期范围。

通用机制提供准确目标与引用、显式关联、来源和时间语义、有界查询、部分结果，以及隐私、留证和诊断自身失败的公共边界。具体事实采集、领域 payload、原始材料、业务错误解释、恢复动作及领域 API/CLI 由对应模块 owner 实现。新增领域不应要求通用层增加该领域的业务判断。

机制交付包含完善且 SSOT 的协议与接入文档，使模块 owner 可以快速理解并完成接入。内部使用 TypeScript 强类型；实际外部数据在原读取边界解析。接口、命名和层数保持简洁，不以通用性为由要求每层 schema、全局注册框架或统一业务状态数据库。

使用者先看到失败步骤或观察范围、已知与未知、准确引用和可执行动作；技术详情和实际保留的原材料仍可达。诊断自身的读取、保存、上传、裁切、过期、未确认及采样中断同样可见。机制失效、资源压力或慢读者只能影响该次诊断，不能拿走健康 Agent、Browser 的能力、原身份、草稿和工作面；保护边界沿[共享规则](behavior/shared-rules.md#低资源下的正确性与可恢复性)与[Session 恢复](behavior/session-recovery.md)。

## 原事实 owner

| 原 owner | 持有的事实 | 机制的消费边界 |
| --- | --- | --- |
| ctxmux | Run、PTY、进程、ordered bytes、Replay、Gap、Runtime 状态及原生存储事实 | 读取实际公开来源；缺原 producer 时明确不可取得 |
| Core / Provider | AgentSession、语义、准备失败、Input admission、Permission、Provider 原生协议及恢复 | 保留原记录；原生解释留在 Provider |
| Desktop / client | 点击、IPC 回执、capture/select/save、App 身份、权限观察、Renderer 和宿主观察 | 记录自己实际取得的事实，不创作 Core 输入或 Native 处理事实 |
| 领域采集 owner | 本领域采样、限制决策、覆盖范围、artifact 与采集生命周期 | 可接入普通 reader 或显式采样操作，不成为新的 Runtime owner |
| 公共业务服务 | 原调用者权限、路由、原 owner 的查询结果 | 有界分派、核验关联与组合安全投影，不复制业务状态 |

分层和执行身份沿[系统职责地图](../architecture/system-ownership.md)。Settings、Session 服务窗、Toolkit、产品详情和 CLI 是消费者，不因展示同一结果而拥有第二份业务事实。

## 包与逻辑模块（候选）

候选位置为 `packages/diagnostic-evidence`，包名为 `@agentmux/diagnostic-evidence`。名称明确诊断证据用途，公开类型使用 `DiagnosticEvidence` 前缀，避免与泛用 Source、Context、Record 或项目已有 evidence 概念重名。发布前核名称冲突、平台及 exports；名称可用不能由本文件代签。

Core、Host、Desktop 和业务模块依赖该包，包不反向依赖 Core、Electron、React、Browser 或 Provider。默认入口可在浏览器和 Node 使用，不载入 fs、Worker 或常驻采集器；确有共享宿主实现时才提供明确的 Node 子入口。

保持一个包、三个逻辑模块，不先拆成多包：

| 模块 | 通用职责 | 原 owner 的贡献 |
| --- | --- | --- |
| protocol | 引用、读取、关联、问题及扩展接口的强类型和语义 | 本领域的准确目标、结果、阶段和错误 |
| integration | 显式注入 typed reader/handler、留证接缝及接入生命期 | 实际事实生产、安全投影、原材料、存储和释放 |
| query | 有界分派、去重、关联核验与 partial | 原权限、业务核验及领域解释 |

RPC/CLI、UI、具体采样器和领域 IO 在原服务与 owner 组装。接入不需要独立 daemon、全局可变 registry、自动扫描工作区或任意执行插件；也不要求没有现成 journal 的模块放弃留证。该模块可以在自己的边界注入有界文件或记录适配，保存诊断观察，继续由该模块持有原材料。

### 强类型与实际数据边界

可信模块在进程内直接传递 TS 类型，不重复序列化或校验。CLI/RPC/IPC、文件、跨 Host wire 和外部 Provider 数据在实际接收端从 unknown 解析成原类型，随后按同一类型传递；类型断言不能代签校验。

优先复用原 codec。需要结构化 schema 的实际边界可以复用已有 Zod；运行时 schema 不成为每个模块的接入条件。机器可读 JSON Schema 仅在跨语言或工具确有消费需要时提供，不预建 schema registry、代码生成或全局校验层。结构校验也不证明权限、来源身份、关联真实性或业务完成。

### 现有与成熟能力的复用

| 能力 | 取舍 | 限制 |
| --- | --- | --- |
| ID | 使用现有 [identity](../../packages/identity/src/index.ts) 的 mintObjectId | 不另造 ID 分配器；仍须核 namespace 容量与不可覆盖冲突 |
| 边界解析 | 原 codec；必要时复用 [Desktop 的 Zod 依赖](../../apps/desktop/package.json)及[实际用法](../../apps/desktop/src/shared/client-observation.ts) | 不默认给机制增加 schema 依赖 |
| 来源与时间 | 借鉴 [OpenTelemetry Logs 数据模型](https://opentelemetry.io/docs/specs/otel/logs/data-model/) | 不默认引入全套 SDK/Collector；trace context 不代签因果 |
| Node 日志输出 | 实际需要时评估 Pino 适配 | [异步 transport](https://github.com/pinojs/pino/blob/main/docs/transports.md)不代签崩溃前持久确认；[字段 redaction](https://github.com/pinojs/pino/blob/main/docs/redaction.md)不证明任意错误文本安全 |
| 存储与消费 | 原 journal、公共服务和命令注册 | 不复制成另一套业务状态库或本地文件 CLI |

新增概念须能指出真实问题或模块间已有重复；依赖取舍同时核平台、打包、热路径成本与不能证明的范围。代码短、下载量高或抽象多不能代替实际成本与消费证明。

## 身份、logId 与准确引用

logId 标识原 owner 的一份诊断记录，在原记录的尝试边界分配一次。跨传输、保存和后续读取不重新生成；Client 与 Core 分别记录自己观察到的事实时各有 logId，以显式关联连接。业务 operationId、RPC requestId、Run 和输入字节 ACK 保持各自含义。

候选直接复用 mintObjectId：当前实现为 12 位 Base58，使用安全随机源，约 70.3 bit；[DeliveryAttempt](../../packages/core/src/delivery-attempt.ts) 已消费它。随机 ID 不是数学上的绝对全局唯一，也不是授权凭据。写入端保留不可覆盖的冲突核验；冲突只影响该次诊断，不能覆盖原件或重发业务。按 namespace、生成量与留存规模核容量，不从 ID 解码时间、顺序或因果，也不从正文 hash 推导身份。

准确原记录引用包含 domain、logId 和可核的记录 authority；访问路线 routeHostId 独立表达。Core authority 复用原 durable runtimeId。Client journal 的 journalId 是其接收存储 namespace 的 server-created 身份，不能借用相邻 Core runtimeId、路径 hash 或报送者自称身份。Headless 与 Desktop 的 client journal 也不因都叫 local 而合并。

authority 不是当时 producer。producer/build/ownerInstanceId、ctxmux instance、Run、PID 及出生证据按领域原来源保留；当前读取 namespace 不能回填成旧记录的当时身份。只有 ephemeral identity 的独立 Core 明确其范围，不能宣称跨重启连续性。

身份元数据可取得性与记录可读取性独立。未限定 authority 的准确读取，只要原授权成立且文件可读，就保留 found 原安全投影，单独报告身份缺证和关联 unverifiable。显式要求某 authority 而无法核验时，拒绝该限定读取；核为不同 authority 时报告 mismatch，不自动放宽请求。其余已合法取得的事实与原错误继续可用。

route 经现有可信连接核实际 owner；改绑路由不能将新 owner 的相似记录当作旧证据。不能跨 Host 搜索猜测 owner，或凭名称、路径、PID、文本合并记录。

## 三个读取与关联原语（类型形状候选）

机制的必要原语是原记录引用、显式关联和按来源读取结果。读取目标是请求上下文，不是额外的持久实体。下面仅示意形状，领域和 authority 分支不是永久封闭列表；正式公开类型、wire 与扩展方式须在实现时共同收敛。

```ts
type DiagnosticEvidenceAuthority =
  | { kind: 'core'; runtimeId: string }
  | { kind: 'client'; journalId: string }
type DiagnosticEvidenceRef = {
  domain: string
  logId: string
  authority: DiagnosticEvidenceAuthority | null
  routeHostId: string | null
}
type DiagnosticEvidenceRead<TTarget, TData> = {
  target: TTarget
  recordRef: DiagnosticEvidenceRef | null
  readAuthority: DiagnosticEvidenceAuthority | null
  authorityStatus: 'verified' | 'unconfirmed' | 'unavailable'
  availability: 'found' | 'not-found' | 'unavailable' | 'corrupt' |
    'evicted' | 'expired' | 'not-exposed' | 'unsupported' | 'forbidden'
  data: TData | null
  persistence: 'confirmed' | 'observed' | 'unconfirmed' | null
  scope: 'record' | 'point-observation' | 'interval-observation' | 'artifact'
  observedAt: number | null
  readAt: number
  completeness: 'complete' | 'partial' | 'unknown'
  issue: { code: DiagnosticEvidenceIssueCode; stage: string; causeCode: string | null } | null
}
interface DiagnosticEvidenceReader<TTarget, TData> {
  read(target: TTarget, bounds: { signal: AbortSignal; maxBytes: number }):
    Promise<DiagnosticEvidenceRead<TTarget, TData>>
}
type DiagnosticEvidenceRelation = {
  from: DiagnosticEvidenceRef
  to: DiagnosticEvidenceRef
  declaredBy: DiagnosticEvidenceRef
  kind: 'reported-core-error' | 'owner-recorded-receipt' | 'context'
  verification: 'declared' | 'target-matched' | 'owner-confirmed' |
    'unverifiable' | 'conflict'
  // 有限依据与原记录引用；不接受自由文本、正文或凭据。
  basis: Array<{
    kind: 'declared-reference' | 'scoped-record-read' | 'compatible-constraints' |
      'owner-recorded-receipt' | 'context-only'
    refs: DiagnosticEvidenceRef[]
  }>
}
```

domain 由已接入模块的明确公开合同识别，目标和数据由 typed reader 成对绑定；没有任意 payload 的通用执行入口。进程内不要求 reader schema；wire 仍解析实际模块分支，不能让 metrics 填进投递分支。

recordRef 只指实际取得的原诊断记录。实时观察、未取得记录、未公开的 Native 来源不复用 root logId、不 mint 占位 ID，也不生成伪造文件。artifact 若只有原领域 artifactRef，则放在该领域的准确目标与结果中，recordRef=null；不能为适配本模型改称 logId。引用实际保留的 artifact manifest 时才使用其原诊断记录引用。

scope 描述材料形态，不要求正常性能区间或限制聚合伪装失败。失败时快照、对原发生的观察和后来观察的关系由领域目标与原 payload 明确表达，不能由读取时间推断。observedAt 仅为来源实际给出的 wall 观察时间，缺失为 null；readAt 是本次读取时间。区间和 monotonic 时间保留在原领域数据中。

示例：Native 内部 first I/O failure 没有公开 producer，读取原 Session/Run 的 native-recorder-failure 目标返回 not-exposed、recordRef=null、data=null、observedAt=null 和 SOURCE_NOT_EXPOSED 的诊断问题；原投递 root 仍保留。后来 system.storage 读取返回 found 原观察、recordRef=null、scope=point-observation、原 observedAt 和 readAt；它是后来观察，不成为失败时快照，也不产生持久确认。

反例：journal 身份 metadata 报 EACCES，但未绑定 authority 的准确旧 logId 文件可读，返回 found + 安全投影，readAuthority=null、authorityStatus=unavailable；无原身份的 recordRef.authority 为 null，关联 unverifiable。显式要求 journalId=A 时，同一元数据缺证只使 A 的限定读取不可用，不能把未核文件送作 A 的原件。原文件自带已核身份时保留该事实，不冒充当前 namespace 已核。

### 关联可信度

basis 的 kind 使用有限 literal union，refs 仅引用原 owner 的实际记录；依据种类与引用数量、字节计入查询预算。默认关联结果不接受自由说明、错误正文、Prompt 或凭据；技术原文沿原件权限显式读取。缺原记录或依据时保留 declared/unverifiable，不 mint 占位引用，也不以某个依据标签升级成因果或 owner-confirmed。模块需要新依据时在 owning 类型与字段合同中明确扩展，不放宽为任意字符串或 raw payload。

| 结论 | 必要原依据 | 能证明的范围 |
| --- | --- | --- |
| declared | Client 原记录声明 coreLogId，目标尚未取得 | 客户端提出关联线索 |
| target-matched | 原 owner 的准确目标已读到，身份和实际有值约束相容 | 找到被声明的原记录；不等于同次 RPC、因果或原生处理成功 |
| owner-confirmed | 原 owner 在发生时保留明确对应回执或 occurrence 关联且身份可核 | 仅证明原 owner 声明的关系 |
| context | 同 Session/Run 或附近时间，无原对应凭据 | 背景相关，不形成因果边 |
| conflict / unverifiable | 已核冲突或缺 owner、身份、关联依据 | 保留双方原事实与问题 |

authenticated report 证明原上报者与接收时间，不能创作 Core 输入事实。同 operationId、同正文、同 hash 或同文案不证明同一尝试。expectedRunId 与实际 failure Run 的角色不同，不机械等同；真实条件改变须显式呈现。当前 Core 记录若没有反向认证 Client 对应关系，组合层不能自行给 owner-confirmed。

## 时间、覆盖与跨重启留证

首批失败路径只保存已经取得的有限事实及各自原观察时间，不额外触发 metrics、storage、FD、原生 recorder 或签名探测。Core admission/字节阶段与 Client 点击回执沿原 owner；primary failure 不被后来诊断或清理失败替换。保存反馈超时不取消可能仍在发布的原写入，不重发未知业务或新增 Input；迟到确认保留实际确认时刻。

同机的不同进程也不默认共享 monotonic 起点；时长只在相同 clock domain 与实例内计算。跨进程/Host 关联沿原 send/receive、occurrence、operation 与 receipt 事实，wall 时间可供大致查找，不能相减、相加冒充跨层耗时或 CPU。确有已核时钟映射时才使用并保留误差。嵌套 wall 阶段不能相加；字节 ACK、原生语义处理与诊断持久确认继续独立。

区间来源按其领域强类型表达请求范围、实际覆盖范围、原 producer/build/instance、采集方式及缺段。须能分清无事件、未启用、不支持、不可达、丢弃、合并、短环覆盖、裁切、到期、producer 重启、observer 中断和未知；不能只给一个 partial 或用未知计数填 0。样本间隔、计数器重置与实例切段沿原 owner，不拼成未经证明的连续趋势。

最新短环、时窗 peak、首次异常和长时 archive 是不同承诺。只有当前/上一窗口就不能称全天峰值；原短环已覆盖的历史不能由后来更好的 recorder 回填。需跨重启的触发证据，由原 owner 在实际预算内保存 first/peak、范围和必要索引，保存状态与内存可见状态分开。文件可读不证明原写入曾 fsync；crash、磁盘满或未发布队列都可能使尾部和 drop 数量未知。

采集成本有界：热路径只复制已有必要事实，持久化异步队列、条数、字节、维度和在途工作均有预算。诊断写盘失败、drop 和 collector 成本采用原 owner 的有限计数及少量代表，不能递归写“日志失败日志”造成雪崩。没有可取得成本就报告未知。

### 冻结与独立 observer

Renderer 冻结时自身 JS 埋点不能继续执行；恢复后出现的 callback 不回填完整冻结原因。Main 或其他原宿主独立观察可保留自己取得的进程、队列和最后已接收 readout，必须标 observer、源实例、来源时间与接收时间；RSS 和 owner count 不升级为模块堆占用或 CPU 栈。

producer 与 observer 一起挂死时明确未知，不能承诺所有故障都有盘上材料。公共服务不响应则保留原失败/引用与查询不可达，幸存原 owner 的证据仍可读取；不默认新增 daemon，不通过重启、kill 或输入探针制造采集条件。

## 普通 reader、历史查找与可选采样

普通 typed reader 是基础；即时读取、历史查找、capture、progress/stop 和 artifact 读取仅按模块实际支持的能力发现。查询不偷偷启采样；模块不必实现全部能力，声明不支持时给准确结果，不能只有 help。

下面是在性能 owner 模块中的最小接入示意；MetricsWindow 与 MetricsObservation 复用[原 metrics 类型](../../packages/core/src/metrics.ts)，不是诊断包对 Core 的依赖。保留 Main 已持有的 MetricsObservation.renderer 原 MetricsSource 封套；新历史范围/coverage 是领域候选，不表示既有 metrics 已有持久历史：

```ts
type RendererPerformanceQuery =
  | { kind: 'current'; window: MetricsWindow }
  | { kind: 'instance-history'; instanceId: string; window: MetricsWindow;
      fromWallMs: number; toWallMs: number; cursor: string | null }
  | { kind: 'archive-history';
      fromWallMs: number; toWallMs: number; cursor: string | null }
type RendererPerformanceObservation =
  Pick<MetricsObservation, 'scope' | 'window' | 'observedAt' | 'renderer'>
type RendererPerformancePage = {
  observations: RendererPerformanceObservation[]
  coverage: {
    intervals: Array<{ instanceId: string | null; fromWallMs: number; toWallMs: number }>
    gaps: Array<{ fromWallMs: number; toWallMs: number;
      reason: 'not-collected' | 'overwritten' | 'interrupted' | 'unknown' }>
  }
  nextCursor: string | null
}
type RendererPerformanceReader =
  DiagnosticEvidenceReader<RendererPerformanceQuery, RendererPerformancePage>
```

found 只表示取得原来源封套，不证明 Renderer 当前仍能响应。renderer 的 pending 是尚待观察，不是业务失败；stale 保留原旧 data、observedAt/lastSuccessAt 与 reason，不以 readAt 刷新来源时间；unavailable 不冒充无事件。Main 的 observedAt、scope 与实际来源的 window 也照原语义保留，不将 Renderer IPC 的 MetricsRendererResult 当成公开 source 状态。

只有大致卡顿时刻、没有 logId 或旧 MetricsWindow 时，可用 archive-history 在公共服务已授权且实际选定的原 Host/app archive 范围内查找；不必知道易失的旧 generation/webContentsId。该分支仅在原 owner 真有有界索引时支持，不跨 Host 扫描。instance-history 则读取已知原 instance/window。结果按真实 producer/instance/window 切段，原实例身份缺证为 null，不 mint 历史 producer 身份。wall 范围是查找条件，不是因果证明；cursor 绑定原 archive 与查询范围。

coverage intervals 必须有原采集生命窗、有效样本及间隔/缺段依据，不能只凭第一和最后两帧宣称连续覆盖。保留和采样缺口继续由原领域表达。没有历史来源/索引时返回 unsupported；已有区间不足时返回真实 coverage/gap，不能宣称“无异常”。首批准确失败引用查询无需等待性能历史实现。

注册 reader 不创建 timer、后台扫描、采样或每 Session 状态。读取复用原已取得 snapshot，确需消费原 metrics 订阅时使用原 lease，结束/取消在 finally 释放本 lease，并沿原 window generation 防止迟到结果进入新实例。不停止其他 reader 或业务 Run；有限返回和有限在途同时成立。

可选 capture 由领域显式贡献 typed 操作，示意如下；请求和回执类型由原性能 owner 定义，不要求所有模块实现通用采样器：

```ts
type RendererCaptureLookup =
  | { kind: 'request'; captureRequestId: string }
  | { kind: 'capture'; capture: RendererCaptureRef }
interface RendererPerformanceCapturePort {
  start(request: RendererCaptureRequest, signal: AbortSignal): Promise<RendererCaptureReceipt>
  inspect(target: RendererCaptureLookup, signal: AbortSignal): Promise<RendererCaptureProgress>
  stop(capture: RendererCaptureRef, signal: AbortSignal): Promise<RendererCaptureProgress>
  readArtifact(request: RendererArtifactReadRequest, signal: AbortSignal): Promise<RendererArtifactChunk>
}
```

这些领域类型必须表达准确实例、实际授权/确认、采样方式与副作用、期限和资源预算。captureRef 是原采集操作身份，不替换为诊断 logId；stop 只释放本采样，不能停止别的 reader 或被观察 Run。多采样是否合并由原 owner 在相容目标和预算内决定，不能由机制全局合并。

start 已受理后，AbortSignal 取消等待不等于停止采集；回执丢失也不能自动重新 start 或写成已停止。领域在副作用边界保留请求前已知的 captureRequestId 或原采集身份及实际查询支持，沿原 owner inspect 对账；这不是 RPC id、输入权限或重放授权。无可定位身份/查询来源时报告 unknown，原已受理采集仍受自身有限 deadline/预算约束。普通 reader 不因此拥有 operation 协议，机制不新建通用任务库。

stop 请求已发送或返回不等于采集已经结束；只有原 owner 确认的终态与发生时刻可写作结束原因，artifact 的发布/持久确认仍单独报告。请求未受理、取消等待、采集停止与采集结果取得保留各自事实，不由传输状态代签。

前窗仅能来自已经启用的原 recorder；未采过的 profile 或 heap 材料明确不存在，事后采样不能回填。后窗按原 owner 的有限期限、频率、字节、队列与在途成本采集。profile/heap 等成本和敏感性由原 owner 告知并授权，不由普通读取自动触发。

采集进度保留实际已收到的范围、最后源进度与 observer 心跳，源进度不以接收时间代替。到时限、调用者 stop、上游正常结束、断线、预算停止、实例结束和未知中断分别表达；有 close code/signal 就保留，缺证不能猜。配置期限、进程已启动和没有错误日志均不证明覆盖完整。deadline 尚未到而上游先结束时，不能默认写 duration-limit。重启后的新采集切成新 lifetime segment，空窗仍可见，不偷偷恢复重型采样或拼接成连续覆盖。

artifact 只指原 owner 实际保留的材料及其格式、范围、字节、coverage、裁切和持久状态。大 profile/heap 沿原 owner 分块或流读，cursor 绑定原 artifact/版本，不塞进小通用 JSON，不重新采样冒充续读。读取授权与留存独立；尚在内存、正在发布、未留存、已删除和真实可读分别表达。

## 动态限制与诊断自身限制

限制证据在实际决策点由原 owner 留下当时 effective limit、单位、scope、policy revision、实际已知 demand/observed value、动作、原因及受影响数量；未知值保留未知。事后新配置不能覆盖当时阈值，逻辑字节不能冒充 backing allocation，排队 wall 不能冒充 CPU。

业务限流、拒绝、淘汰、合并与诊断查询/留证限制分开。高频命中按有限维度聚合并保留少量原例，不逐条放大记录或无限保护每个首次命中。字段含义和聚合窗口由领域 owner 持有，不另建通用策略状态库。

公共层限制总字节、耗时、记录数、深度及实际在途工作；不能对已经 typed 的 metrics 重施通用 JSON 深度限制。子来源损坏、旧 Host 或不可取消 I/O 只使该子结果不可用；不可取消工作占用有限槽位，不能每次查询新建永久挂起任务。达到预算停止新读取、释放本 reader，不取消业务。

## 错误码设计规范

错误码标识原 owner 确认的条件，是稳定的机器可消费合同。可变文案用于解释；stage、logId、operation、Run、配置值及厂商/OS 原码使用各自字段，不能拼进错误码，也不能靠匹配 stderr 文案创造通用根因。

| 层 | 持有码的 owner | 公开表达 |
| --- | --- | --- |
| 领域原失败 | 发生失败的 Core、Provider、Capture、采集或业务 owner | 保留原 code、primary cause 与确认范围；诊断 issue 不能替换它 |
| 诊断自身问题 | 诊断读取、核验、查询或留证 owner | 子读取中的 typed issue，阶段与已取得证据独立 |
| 外层请求/传输失败 | 原 RPC/IPC/授权/transport owner | 复用原请求与传输错误合同，不另造同义码 |

机制自身使用明确 `DIAGNOSTIC_EVIDENCE_` 前缀及有限 TS literal union。领域沿已有命名和强类型合同，不为接入重命名历史错误；新增领域码用明确领域前缀和准确条件，避免泛用 ERROR、FAILED、UNKNOWN。Provider 原生码、errno、syscall、exit code/signal 是原 cause 的事实，不强制并入机制 union。错误码与原错误文本的隐私/留存也分开。

以下为首批必要条件的候选语义，精确 union 在公开协议实现时按实际分支收敛；无错误的 not-found、expired、evicted、unsupported 不必各造一个同义错误码：

| 候选码（前缀均为 DIAGNOSTIC_EVIDENCE_） | 准确条件 | 可执行处理边界 |
| --- | --- | --- |
| AUTHORITY_UNAVAILABLE | 身份 metadata/来源未取得，可读原件仍可能存在 | 保留合法可读数据，关联降为无法核验；不扩大成整个诊断不可用 |
| AUTHORITY_UNVERIFIABLE | 请求明确限定 authority，但没有足够原依据核验 | 拒绝该限定读取，保留其他合法事实；不自动放宽请求 |
| AUTHORITY_MISMATCH | 原已核 authority 与明确限定不符 | 拒绝该目标，核原路线/身份；不能搜相似记录替代 |
| SOURCE_NOT_EXPOSED | 所需原 producer 没有可消费的公开来源 | 明确缺证与支持范围，不能包装推测成原失败 |
| READ_FAILED | 原子来源读取确已失败 | 保留原 I/O/传输 cause 的已知范围与其他结果；不猜缺失历史 |
| INVALID_SOURCE_DATA | 原来源的数据未通过该来源边界解析 | 隔离该来源并保留已取得事实；不将整条查询变成 protocol error |
| QUERY_LIMIT_REACHED | 本次查询实际触及预算、deadline 或在途上限 | 返回 partial 与已用预算/停止原因，动作只影响本查询 |
| PERSIST_FAILED | 本次诊断材料保存/发布确已失败 | 原业务错误继续返回，保留实际内存/持久状态；不宣称已保存 |

候选强类型直接定义有限码，不新增运行时码注册表或错误类层级：

```ts
type DiagnosticEvidenceIssueCode =
  | 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNAVAILABLE'
  | 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNVERIFIABLE'
  | 'DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH'
  | 'DIAGNOSTIC_EVIDENCE_SOURCE_NOT_EXPOSED'
  | 'DIAGNOSTIC_EVIDENCE_READ_FAILED'
  | 'DIAGNOSTIC_EVIDENCE_INVALID_SOURCE_DATA'
  | 'DIAGNOSTIC_EVIDENCE_QUERY_LIMIT_REACHED'
  | 'DIAGNOSTIC_EVIDENCE_PERSIST_FAILED'
```

causeCode 仅保留原来源实际取得、该字段安全合同允许的有限原码；例如已核的 EACCES。未取得为 null，不能由错误文本推导。原 cause 的更多字段和 raw 留存沿领域合同，机制不承诺还原完整 Error。复用[原错误及确认类型](../../packages/core/src/errors.ts)和[公共 RPC 编解码](../../packages/core/src/public-rpc-wire.ts)的接缝；JSON-RPC 数值 error.code 与领域字符串 code 仍是不同层的字段，不互相改名或冒充。

缺支持、覆盖不足、正常结束与 unknown 属于相应能力/读取/生命周期状态，不强行包成业务异常。用户先读到原失败与诊断缺口，再由已核条件选择动作；单个 retryable 布尔值不能授权未知输入重放或原业务重试。

同一码只能有一个 owning 定义，定义同时说明触发条件、能证明和不能证明的事实、产生步骤、必要安全字段、原 cause 留存及允许动作。各可触发分支必须能由真实领域链路核对；不可达码和以文案猜出的分类不列为支持。语义变化须改原 owning 合同及消费者，不给旧码悄悄赋新意义，不以兼容包装层掩盖 owner 变化。

原 primary failure 不被晚到 cleanup、诊断保存或读取错误替换。二级问题各保原阶段；CLI/API/产品共同消费相同结构，JSON 输出保留码、阶段、准确引用、availability、确认/未知及 partial，人类文案不成为 parser。新增码须核当前客户端对未知领域/native 码和协议版本的行为：不能猜已知根因或因一个子来源新码抹掉其他合法证据；严格外层合同和子来源隔离同时成立。

例：准备失败原码 AGENT_PROMPT_PREPARATION_FAILED、not_applied/confirmedInputBytes=0 仍是原 Core 事实。Native 读取的 SOURCE_NOT_EXPOSED 是另一项诊断问题，不提升为 ENOSPC；journal 保存 PERSIST_FAILED 也不能把原失败替换成“投递日志错误”。采集上游提前结束且没有原 close 原因时保留 unknown 中断，不创作 duration-limit 或 App restart 根因。

## 公共查询、隐私与有限留存

候选薄组合入口为 `system.diagnostics.inspect` / `amux system diagnostics inspect`，经既有公共业务服务分派原 owner，保留原领域 inspect 的原件语义；不新增 CLI 直接扫盘。字段、命令、发现和真实消费沿[公共能力贡献约定](../guides/public-capability-contributions.md)，命名尚未成为已安装合同。

准确记录、领域有界 target/time-range、分页、采样和 artifact 能力分别按实际支持发现；首切只实现准确失败引用与关联，不以此宣称全领域历史/采样已支持。不做无索引的任意全历史、全 Host 或全文搜索；领域可提供自己的有界索引，覆盖不足与不支持直接可见。

组合结果保留各来源读取、关系、completeness 和已用预算。root 缺失仍返回其准确状态，related 失败不抹 root；被拒来源不泄露受限记录是否存在。原 owner 级解析失败变成子结果，不把坏 payload 直接塞进外层。外层断线时消费者保留原错误/引用和本次查询失败。取消只释放本 reader，慢 Host 和不可取消 IO 都有实际在途上限。

默认展示结构化步骤、code、确认事实、身份、时间和缺证；任意 message/detail/stack/stderr 不因短就变安全。Prompt、环境变量、argv、cookie、凭据、截图内容和原生 tool input 不默认进入新记录。raw 由具备原来源权限的消费者显式读取，按原字节范围和裁切返回，不能把清洗文本称为原件。

raw 是否保留与本次是否返回独立：retained、withheld、not-retained、truncated、evicted/expired 分别表达；withheld 同时报告实际留存状态，不能代替未留存。显式读取不重新生成未留存材料；原件只指实际保留范围，不能还原完整原 Error、更深 cause、未记 stderr 或被裁切尾部。瞬时材料不留存时，当次原消费面和后续查询都明确以后无法还原。

首切安全摘要不削弱[现有 DeliveryAttempt](../../packages/core/src/delivery-attempt.ts)的原件字段与读取能力，不改写旧文件或为了投影缩短原 cause 留存。已有文件可能含敏感错误文本，不能由本设计宣称安全；整体淘汰及其依据单独表达。

每个 owner 的总条数、字节、内存、artifact、索引和淘汰凭据均有预算，实际常量按原保留需求和成本确定。在被保留的一次尝试内 first failure 不可变；有限总体留存不承诺所有首次失败永存。确知删除可报告 evicted/expired；无凭据时为 not-found + coverage unknown。诊断删除绝不删除 Session/Run、恢复材料或修改 ACK，清理失败只影响诊断，维护不在 Input 热路径全目录扫描。

## 协议与使用文档的 SSOT

本文持有目标与设计语义。准确公开类型、协议版本、模块扩展、权限、错误、partial、生命周期和字段合同由机制公开类型及唯一协议规范共同维护；实现时拟使用 `docs/specs/diagnostic-evidence-protocol.md`，该协议文件目前尚未创建。类型持有字段和签名，规范解释其语义，不手写另一套全集；wire codec 留在实际数据边界。

owner 接入指南拟放在 `docs/guides/diagnostic-evidence-integration.md`，目前尚未创建。指南引用原协议与类型，说明责任分工、最小 typed reader、外部读取边界、可选留证/capture、CLI 发现及实际查询、缺证和失败处理、释放与成本验证；包 README 只作导航和起步。示例必须在实际包/API/CLI 成立，不能用本文类型示意冒充已发布接口。

Settings 只持有[设置与观测入口的产品消费](behavior/settings-and-observation.md#统一观测与诊断机制)，具体业务文档沿自身 owner；它们引用本机制，不重复定义通用协议。当前实现导航仍归[公共能力来源](../specs/public-capabilities.md)，不会因设计文件创建而宣布交付。

## 接入验证与不能证明的部分

首个真实竖切是 Message Tool 原失败 → Client 原记录 → Core 原记录 → 有界关联/缺证 → 产品详情、typed API 和真正 CLI。复用[Client 捕获](../../packages/client-ui/src/lib/delivery-diagnostics.ts)、[Core 原存储](../../packages/core/src/delivery-attempt-store.ts)和[公共服务](../../packages/core/src/public-rpc-service.ts)，不修造 Native 内部 producer。原草稿和健康输入保留，查询不增加 Input 次数或触发重试。

第二种领域验证由原[截图 owner](../../apps/desktop/src/main/composer-screenshot.ts)记录 select/capture/save 的原阶段、primary/cleanup failure、有限原 cause 和准确 App/权限观察时刻，经 trusted IPC、产品、typed API/CLI 消费。截图不塞进投递 payload；不同 OS/协议触发检验通用边界，denied 不直接归因为用户未授权。

截图的 create-directory、spawn、close、stat/save 和 cleanup 也沿实际来源保留阶段；child PID/出生、exit code/signal、errno/syscall、stderr 范围和裁切仅在确已取得时报告。运行 App 身份沿启动时已核材料及核验时刻，失败处理时读到的权限不是 selector 开始时快照。code=0 且没有输出不证明取消，cleanup 错误不替换 primary；截图失败保留草稿和健康 Agent，公开查询不能绕过原 trusted capture 或权限确认。

公共接口冻结前用普通性能 reader 与可选 capture 示意验证正常区间、无 logId 查找、unsupported、原 artifact 读取与最小生命周期；后续性能实现仍由性能 owner 接入原 recorder/metrics/Toolkit。短环覆盖、窗口外查找、producer 冻结、阈值修改、旧 Host 子结果失败、collector 提前结束及重启空窗是可证伪反例，不要求 Message/截图等待全部性能能力。

纯设计变更核来源、链接与语义保全；实现时按原计划和[测试策略](../testing/strategy.md#任务验收与假绿防护)验证变异与真实产品/API/CLI。仅有 logger、接口导出、模拟组合结果、help 或某个业务的专用查询不足以证明可插拔机制和文档完成，模块 owner 还应能依据 SSOT 文档完成接入。

关联成功不证明 Native 根因或语义接受；缺 writer 不证明 ENOSPC、pending actor 或原 Session 恢复。此尝试 not_applied/0 不证明同一逻辑消息历史从未输入。后来 metrics/PID/权限不能回填失败时状态，新进程或当前健康不代签原身份恢复。有限留存和查询无结果不证明业务从未发生，配置采样时长不证明实际覆盖，RSS/owner count 不证明模块占用或原卡顿根因。
