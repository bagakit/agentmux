# Connection 公共协议

本文是 `connection.*` 与 `space.mote.connection.*` 公共方法的调用合同：宿主怎样接入、谁可以调用、写操作的身份与回执，以及每组方法的效果边界。字段与签名唯一见下文各组链接的 Core 合同文件和严格解析（`packages/core/src/*-contract.ts`、`*-codec.ts`），本文不复制字段表。产品行为归[外部对话渠道与群聊连接](../design/behavior/conversation-channels.md)和[外部对话应用接入](../design/behavior/settings-and-observation.md#外部对话应用接入)；宿主实现与平台 adapter 见 [`@agentmux/connectors`](../../packages/connectors/README.md)；命令用法以所运行版本的 `amux connection --help` / `--skill` 为准（[connection 指南](../../packages/core/guides/modules/connection.md)）。源码中存在某个方法，不代表它已打包、安装或在某个平台完成验收。

[文档导航](../README.md) · [公共能力入口](public-capabilities.md) · [对话协议](conversation-protocol.md)

## 宿主接入与可用性

Core 不构造平台 adapter，也不保存凭据。宿主通过 `AgentMuxRpcServiceOptions.connections` 注入一个 [`ConnectionPort`](../../packages/core/src/connections-contract.ts)；其中 `rooms`、`bindings`、`delivery`、`ingress`、`setup`、`enrollment`、`profile`、`metadata`、`service`、`applicationAccess`、`credential`、`receiver`、`api` 与删除方法都是可选子端口。某个子端口没有注入时，只有对应方法返回 `CONTROL_UNAVAILABLE`，其他方法、已有连接和 Agent 照常可用。

一个 endpoint 没有注入 `ConnectionPort` 但配置了控制转发时，除 `connection.owner.inspect`（由本 endpoint 应答）和 `connection.credential.*`（只在持有连接器的 endpoint 执行，从不转发）外，请求转发到持有连接器的 Host；两者都没有时返回 `CONTROL_UNAVAILABLE`。`connection.owner.inspect` 报告本 endpoint 的注册情况：`local`（本 endpoint 持有连接器）、`forwarded`（只有转发入口）或 `unavailable`。这里的 `local` 指这个 endpoint，不是用户的本机；该读取不打开连接器数据库，不说明凭据、平台连接或投递状态，也不授予配置或成员管理权限。

连接器托管 Host 与 Binding 的执行 Host 是两个事实：前者持有应用、凭据和收发，后者运行 Agent。请求带有 Runtime fence 时，服务在派发或转发前校验它。

## 调用者与授权

所有方法都要求已认证的调用者：经可信传输认证的人（`user`）或设备（`device`），或经 Session capability 认证的托管 Agent。JSON 参数中的身份、作者或 `authorizedBy` 不授予任何权限；写操作的操作者由服务从传输上下文填入。

| 方法 | 人或设备 | 托管 Agent |
| --- | --- | --- |
| `connection.credential.*` | 允许；需要 Runtime fence，`store` 只接受 Unix（含 SSH 转发到 Unix）或端到端加密 Relay 传输 | 拒绝 |
| `connection.receiver.*` | 允许；需要 Runtime fence | 拒绝 |
| `connection.configure`、`connection.delete*`、`connection.service.*`、`connection.application.access.*`、`connection.grant`、`connection.binding.member.inherit`、`connection.ingress.ls/authority/record-authority`、`connection.metadata.watch` | 允许 | 拒绝 |
| `connection.ls`、`connection.inspect`、`connection.test`、`connection.setup.*`、`connection.profile.*`、`connection.metadata.get/ls/refresh/clear`、`connection.room.ls/search/get/members/link.*` | 允许 | 只限该 Agent 自己通过 `connection.enrollment.*` 接入的应用；`connection.ls` 只返回这些应用；`setup.inspect/advance` 与 `room.link.inspect` 另由 owner 核对原操作者 |
| `connection.enrollment.*` | 允许 | 允许；enrollment owner 只向原操作者返回私密确认材料 |
| `connection.room.create`、`connection.bind`、`connection.binding.relink/pause/resume/detach/inspect/ls` | 允许 | 只限自己接入的应用、目标是自己的 Session、且由自己授权的 Binding；`inspect` 不返回成员访问和映射冲突，`ls` 只返回自己授权的 Binding |
| `connection.delivery.*`、`connection.ingress.inspect/rejoin` | 允许 | 只限执行 Host 与 Session 是自己的 Binding；`delivery.source.recover` 不能带扩大共享范围的 `review` |
| `connection.api.*` | 允许 | 只能使用执行 Host 与 Session 是自己的 Binding 身份 |
| `connection.diagnose`、`connection.owner.inspect` | 允许 | 允许（安全只读投影，不含正文、私密设置材料或授权写入） |

托管 Agent 的放行规则唯一见 [`assertAgentConnectionAccess`](../../packages/core/src/connection-agent-access.ts) 与 [`AgentMuxRpcService`](../../packages/core/src/public-rpc-service.ts) 的 connection 分支；新增方法时在那里加入同一判断，默认拒绝。

## 操作身份、修订与回执

以下规则适用于所有带 `operationId` 的写方法，各组只在有差异时另行说明。

- **先记意图，再产生效果。** owner 先把完整请求与操作身份写入持久记录，再解析凭据或调用平台。每次可能产生效果的平台请求有自己的 attempt 记录，结果写回同一 attempt。
- **同一身份只施效一次。** 同一 `operationId` 和同一输入返回原回执；同一 `operationId` 配不同输入或不同方法返回冲突错误。`connection.configure` 与 `connection.service.configure` 共用同一个操作索引，不能互相复用 ID。
- **修订号做并发控制。** 修改已有对象时传入读到的修订号（`expectedRevision`、`expectedConnectionRevision`、`expectedBindingRevision` 等）；`null` 表示新建。修订不符时拒绝，调用方重新读取后决定，服务不自动重试。
- **查询不施效。** 各组的 `inspect` 与列表只读本地记录，不解析凭据、不访问平台、不重试，也不派发输入。
- **结果未知先查原操作。** 回执丢失或状态为 `unknown` / `dispatching` 时，用同一 `operationId` 查询；不能换新 ID 重投，也不能按名称或当前状态猜结果。只有 owner 确认「平台未应用」（`not-applied`）时，方法才可能允许显式重试，规则见各组。
- **回执、当前状态和平台观察分开。** 当前值不能证明较早的操作已经生效；较晚的读取也不能确认较新的配置修订。
- **失败只影响本次操作。** 存储、凭据或平台失败只拒绝或挂起当前方法，不停止健康 Agent、不替换 Session，也不删除已有连接、Binding 或回执。

## 应用配置与删除

方法：`connection.ls`、`connection.inspect`、`connection.configure`、`connection.test`、`connection.delete`、`connection.delete.inspect`。合同：[connections-contract](../../packages/core/src/connections-contract.ts)、[connection-deletion-contract](../../packages/core/src/connection-deletion-contract.ts)。

- 一个连接的应用身份由 `application` 和 `adapterId` 确定，保存后不能改。`application.domain` 标识平台，`application.appId` 保留原生不透明 ID；协议将账号限定在服务实例时，另保留经原认证确认的 `application.issuer`，不得把实例拼入原生 ID 或用连接别名代替。相同原生 ID 在不同实例下是不同应用；未提供实例的原身份保持原范围，不能继承或补填另一实例。`credentialRef`、`label`、`enabled` 可以在准确修订上修改。配置只保存不透明的 `credentialRef`，从不包含凭据值或路径。
- `connection.inspect --operation-id` 返回原配置回执，同时返回连接的当前记录，因此旧回执不会掩盖之后的凭据轮换。
- 连接记录中的 `authentication`、`transport`、`intake`、`delivery` 四项观察相互独立。保存配置不触发检查；`connection.test` 是显式检查，结果不能代表更新的配置修订；Host 重启后内存中的观察回到 `unknown`。`connection.test` 只解析凭据并做一次认证检查，返回的记录只更新 `authentication`，接收器的 `transport` 与 `intake` 观察保持原样；它不重建或重连接收器，接收器恢复只经 `connection.receiver.recover`。已停用的连接直接返回当前记录，不做检查。
- `capabilities` 表示已注册 adapter 实现了群发现、建群、加入链接或接收器恢复，不代表平台权限已经生效；缺失时为未知。`initialSetup` 只投影受管初始化流程的原结果，不代表当前平台就绪。
- `connection.delete` 在准确修订上删除一个本地身份。远端应用和不可变回执保留，被删除的连接不会为了读取旧缓存而重建。

## 凭据

方法：`connection.credential.store`、`connection.credential.inspect`。合同：[connection-credential-contract](../../packages/core/src/connection-credential-contract.ts)。

`store` 接收 `{ operationId, secret }`，只返回 `{ credentialRef }`；`inspect` 返回原操作的引用或 `null`。没有任何方法能读回凭据值。CLI 只从 stdin 读取明文；凭据不应出现在参数、环境变量、输入文件、活动记录或诊断里。`null` 只是当前观察，不能证明在途写入一定没有提交。凭据查找失败时，通过连接记录中 `authentication` / `transport` 阶段的原因（`credential-missing`、`credential-format-unsupported`、`credential-unavailable`）和 `connection.diagnose` 的有限原因报告，不新增写入命令，也不授予管理权限。存储格式、权限和旧格式处理见 [Host 凭据存储](../../apps/host/credential-storage.md)。

## 服务策略

方法：`connection.service.get`、`connection.service.configure`、`connection.service.inspect`。合同：[connection-service-contract](../../packages/core/src/connection-service-contract.ts)。

- 不带 `adapterId` 时读写本 endpoint 的全局自动收发策略；带 `adapterId` 时读写该平台的独立策略。新的自动接收和外发要求全局与平台策略都开启，两者都不改写各应用的 `enabled`。
- 存储确认没有记录时，策略视为修订 0 的开启状态；存储状态不确定时不能套用这个默认值。
- `configure` 需要 `operationId` 与 `expectedRevision`。保存后的回执在之后的修改或 owner 重启后仍可查询。
- 关闭和重新开启对已有接收、输入与投递的影响见[外部对话应用接入](../design/behavior/settings-and-observation.md#外部对话应用接入)。在入站记录上的表现是：关闭期间已收下但未认领的消息保持 `received`，重新开启后沿同一个入站身份继续；原 Core 等待须在当前授权下显式 `rejoin`。

## 接收器恢复

方法：`connection.receiver.recover`、`connection.receiver.inspect`。合同：[connection-receiver-contract](../../packages/core/src/connection-receiver-contract.ts)。

`recover` 冻结 Connection、配置修订、调用者看到的接收器引用（`receiverRef`，可为 `null`）和操作者。结果 `disposition` 区分 `already-ready`、`joined`（加入正在进行的恢复）、`scheduled`、`not-current`（引用已被更新的接收器取代）、`disabled` 与 `unconfirmed`。`receiverRef: null` 只能加入一次尚未确认的启动观察，不能授权替换接收器。重复同一操作只查询或加入原恢复，旧引用不会关闭后来健康的接收器。

## 群发现、加入链接与创建

方法：`connection.room.ls/search/get/members`、`connection.room.link.create/inspect`、`connection.room.create/inspect`。合同：[room-discovery-contract](../../packages/core/src/room-discovery-contract.ts)、[room-provisioning-contract](../../packages/core/src/room-provisioning-contract.ts)。

- **读取。** 每次读取都要传 `connectionId` 与 `expectedConnectionRevision`；配置在读取期间改变时，迟到的结果被拒绝。读取不创建 Agent、Binding、成员关系或分享链接。分页使用返回的不透明 `next`，只能用于同一查询和修订。`observation` 为 `unknown` / `unavailable` 时表示读取失败，与确认的空页不同。群名只用于显示，不参与路由。成员列表是平台账号，不代表本地创建者、真人身份或聊天授权。
- **加入链接。** `link.create` 先记录意图，再发一次平台请求；`confirmed` 只说明平台签发了这个链接，不说明链接仍然可用、有人加入或有聊天权限；停用机器人或把它移出群都会使它签发的链接失效。结果未知时跨重启都只能查询；没有按平台去重键的查询，`inspect` 也不会再签发链接。
- **建群。** 输入冻结 `operationId`、`connectionId`、`expectedConnectionRevision`、执行目标（`executionHostId`、`agentSessionId`、可选 `regionAnchor`）、群名和成员 `{ idType, userId }`；应用身份取自已配置的连接。建群与成员加入是两个阶段，各有 attempt 和回执。已知的群 ID 在成员部分失败或之后绑定失败时仍保留；成员为空时也保留已建的群。
- **建群的结果处理。** 尚未派发 attempt 的 pending 阶段，只有完全相同的原请求可以显式继续；平台确认未建群（`not-applied`）后，可以用新操作重新建群；成员加入的 `not-applied` 不会被隐式重试。
- **一个 Session 一个建群声明。** 同一 Connection、执行 Host 与 Session 只保留一个建群声明，跨 Region 和操作 ID 都返回原群；只有确认未建群才释放它。配置修订或准确 Region 的占用者变化时，pending 的效果被拒绝，本地 Agent 保留；无关的空间变化不影响目标。
- 建群不授予 Binding、历史分享、成员能力或 Agent 输入；共享范围通过 `connection.bind` 另行确认。

## Binding、成员授权与应用规则

方法：`connection.bind`、`connection.binding.inspect/ls/pause/resume/detach/relink/member.inherit`、`connection.grant`、`connection.application.access.get/configure/inspect`。合同：[room-binding-contract](../../packages/core/src/room-binding-contract.ts)、[connection-application-access-contract](../../packages/core/src/connection-application-access-contract.ts)。行为要求见[群入口与成员访问](../design/behavior/conversation-channels.md#群入口与成员访问)和[群触发与同步配置](../design/behavior/conversation-channels.md#群触发与同步配置)。

- **绑定输入。** `bind` 指定执行目标（`executionHostId`、`agentSessionId`）、当前 Connection 修订、外部会话 ID、共享范围和期望的原生来源 `expectedSource`。`expectedSource` 取自 `amux agent conversation checkpoint` 返回的实际来源；来源不受支持或已变化时拒绝。新 Binding 的发布范围固定为 `future-shared-conversation`，输入触发可选 `mentions-and-replies` 或 `all-messages`。新 Binding 从当前来源切点开始，不分享已有历史。
- **路由与导航。** 执行路由只有 `executionHostId` 与 `agentSessionId`；`regionAnchor` 只用于导航，发布时不会去解析 Region 当前的占用者。同一 Connection 与 Session 的另一个 Region 复用已有 Binding。一个应用加一个外部会话同时只有一个当前映射。
- **回执。** `preparing` 只确认意图已记录；确认后，Binding、当前映射与操作回执在同一事务中写入。已应用的操作总是返回原切点。旧修订可以用 `binding inspect --binding ID --revision N` 读取。
- **暂停、恢复与解除。** `pause` 生成不可变的暂停修订，停止新的接收与发布；旧修订中从未尝试派发的普通待发操作标为 `cancelled`（原因 `binding-revised`），已派发或结果未知的操作保持原状。暂停不停止 Agent，也不关闭展示。`resume` 只接受暂停中的 Binding：它在新修订上取当前来源的新切点，暂停期间积累的内容不会补发；连接须仍然启用且应用未变，成员授权随之保留。`detach` 结束关系，成员授权不再延续。
- **重连。** 改变受众、执行目标或原生来源需要 `relink` 并传入当前修订。对一个仍处于 active、发布关系完全不变且来源相同的完整共享 Binding，`relink` 沿用原切点，`publicationBoundary` 指回原发布修订；其他情况取新切点，并按暂停的规则取消旧修订中从未派发的待发操作。
- **群内通知。** `bind`、`pause`、`resume`、`detach` 和 `relink` 的回执可以带 `notices`（`connected`、`disconnected`、`paused`、`resumed`、`updated`），每条对应一个投递操作 ID，可用 `connection.delivery.inspect` 核对。通知的操作 ID 由 Binding 操作、事件和修订派生，重复处理同一 Binding 操作不会产生第二条通知。
- **历史范围。** 早先只共享 Agent 回复的 Binding（`future-native-user-facing`）保留原范围；扩大到完整对话需要显式 `relink`、准确修订和新切点。读取或复用 Binding 不会扩大范围。
- **成员授权。** `grant` 指定准确的 Binding 修订、应用、外部会话、成员身份 `{ idType, userId }` 和能力；`input`、`answer`、`permission` 三项相互独立，授权有自己的修订，旧修订不可变；已冻结的输入或动作引用仍绑定它们的原修订。群成员身份或消息署名都不授予能力。后续 Binding 修订只在应用、群、执行 Host / Runtime、Session 与输入目标都不变时延续成员决定（包括撤销）；更换授权对象不会转移授权。
- **应用规则。** `connection.application.access.*` 按 adapter、原生应用和成员身份命名空间保存应用级规则，不需要先有群绑定，另一个机器人或 Host 不继承。有本群决定时完整使用本群决定，本群未写的能力和撤销都不用应用规则补齐；`member.inherit` 只释放本群当前决定、改为继承应用规则，保留历史决定和回执。有效授权带类型化来源（本群或应用），应用规则不会复制成本群授权。读不到应用访问时，已知的本地访问仍可用，观察缺口保持显式。规则变化只唤醒相关的发布队列，不重启接收器，也不重放被拒绝或未知的输入。

## 投递

方法：`connection.delivery.inspect/ls/retry`、`connection.delivery.source.recover`。合同：[connection-delivery-contract](../../packages/core/src/connection-delivery-contract.ts)。行为要求见[共同来源与双向交付](../design/behavior/conversation-channels.md#共同来源与双向交付)。

- **安全投影。** 查询返回操作、受众、来源引用、分片、队列状态和平台回执，不含正文、预备好的请求或凭据。
- **列表。** `ls` 限定一个 Connection 加一个 Binding 修订，续页用返回的 `next` 和 `--after`，不按 ID 字面顺序猜位置。列表可附带当前 Binding 范围的发布队列观察（`observation`、`sourceObservation`、`effectObservation`）和内容覆盖（`coverage`，含缺口）；还没有投递时也能看到来源缺口。这些观察只描述当前进程的服务状态，不是平台 ACK、送达、原生采用或 Agent 健康结论。
- **状态与回执分开。** `state` 是操作当前的队列状态（`superseded`、`cancelled` 等），`receipt` 是平台结果；未知不等于未执行。
- **资源上传。** 图片和文件的上传（`resourceUpload`，`kind` 为 `image` 或 `file`）与聊天消息是两个效果；公开投影只给出原内容片段、上传 attempt 和上传状态，不暴露平台资源 key 或字节。
  - 适配器声明了独立上传协议时，Host 先把确认的上传 key 私下保存，再冻结消息请求，所以重开不会再次上传。
  - 适配器随消息直接发送资源（multipart）时，Outbox 冻结 multipart 载荷和通用描述符（原操作的资源身份、hash、字节数、传输文件名和 MIME），只有认领了同一 Outbox 操作的效果上下文能读取并核验保留的字节；这些字节与展示资料缓存的清理无关。直接 multipart 只有一个消息效果，不会编造上传 key 或上传回执。
  - 上传结果未知既不说明消息已应用，也不说明未应用，不会自动重新上传。原文件没有名称时保持缺失，即使适配器需要一个中性的传输文件名。
- **重试与续接。** `retry` 只能使用投递上公开的 `retrySource`，即 Host owner 认定的原失败来源 `{ kind: 'message' | 'content-upload', attempt }`；它保留原操作身份和受众，操作者来自可信传输。
  - `message` 来源要求该 attempt 有平台确认的 not-applied 回执。`content-upload` 来源只在聊天消息从未准备或尝试、且最后一次上传结果未知时，允许一次后继上传；较早的上传 attempt 保留各自回执。
  - 每个来源在后继认领之前最多被接受一次续接，结果中的 `continuation` 与投递上的 `lastContinuation` 记录 `source` 和 `acceptedAt`。回复丢失、并发或重启后重复同一输入，返回同一续接和当前投递，不再接受新的续接。
  - 来源不符返回 `PUBLICATION_RETRY_UNCONFIRMED`，当前 Binding 不再授权发布返回 `PUBLICATION_NOT_AUTHORIZED`，操作不存在返回 `UNKNOWN_PUBLICATION_OPERATION`。
  - 迟到的旧 unknown 不能撤回已接受的待处理续接。在下一次上传认领之前到达的旧确认上传，可以复用它的 key 完结同一续接；认领或消息准备之后，它只是历史，不改变当前 key、冻结请求、映射或队列结果。
  - 来源引用只是观察，不是授权：新效果使用当前准确的操作者、Binding、受众和 Runtime 授权，已接受的旧续接在原读取范围内仍可读。已取消或被替代的工作不能靠重复旧来源复活；可能已应用的聊天消息只能查询，保留原预备请求和 key。结果未知的操作先 `inspect`，不能换 ID 重放。
  - 限流、目标缺失或平台失败都不会把消息从话题改投到群的主会话或其他目标，也不会换一个平台去重键重发。
- **限流冷却。** 平台明确返回「未生效」的消息限流时，Outbox 可以在这个失败来源上保留一条私有观察：原生资源范围、固定的 `notBefore` 和来源 `native` 或 `local`。平台给出的有效重置时间原样保留、不截断；没有或无效时使用本地 5 秒冷却。
  - Publication Host 的周期检查可以在当前发布授权下接受同一来源的自然续接。显式提前接受的续接和新准备的首条消息，在认领时共用同一个原子的范围门；平台配额跨 Binding 或应用共享时，在其他 Binding 观察到的冷却同样生效。
  - 取消业务操作不会抹掉仍有效的平台窗口；重开同一 Store 保留该窗口，没有合格原生证据的旧记录不会自动获得资格。
  - 这是对已知未生效结果的恢复，不是全局配额分配：另一次原生限流产生它自己的结果与冷却。结果未知的消息或上传、永久拒绝和可选的原生效果都不获得自动续接。
- **等待观察。** `inspect`、`ls` 和 `retry` 的结果可以在待处理的消息、或明确因限流失败的消息上给出 `wait: { reason: 'rate-limit', notBefore, basis: 'native' | 'local' }`。它只是有限的等待观察，不表示成功或未来授权，也不能代替 `retrySource` / `lastContinuation`；公开的效果回执不变，私有范围 key、请求头和租户或应用的配额细节都不外泄。SDK、Hosted 转发和对象 CLI 消费同一个 owner 投影与命令。读取不派发；重试被接受后原消息保持 `pending`，直到共同的范围门放行它的效果。
- **交互全文附件。** 原生交互卡片显示不下完整原文时，同一操作可以带一个显式的 `public-interaction-text` 资源来源。
  - 字节由该操作冻结的公开问题正文和已记录的回答、或共享权限的标题、上下文与选项标签确定地生成；私有字段、动作引用以及生成的传输或可用性元数据都不进入附件。
  - 描述符保留同一原操作身份、准确 hash、字节数、传输文件名和 MIME，认领后的效果上下文拒绝其他操作或描述符。不另建 blob 存储或缓存副本。
  - 短卡片说明完整原文在附件中，并保留原动作和准确的本地 Agent 入口。附件只改变呈现，不改变问题语义、授权或回答归属；结果未知的 multipart 效果沿用同样的只查询恢复边界。
- **不可编辑的文件消息。** 平台不能编辑文件消息时，替换在同一 Outbox 中按顺序排队为撤回与新建两个操作；撤回失败时它仍是可重试的前序操作，前序结果未知时不能绕过它。
- **来源恢复。** `source.recover` 唤醒或加入当前 Binding 的原发布读取，保留原发布边界和切点，并重新核对授权。已有读取工作时返回 `joined`，新唤醒时返回 `requested`，Binding 已停用或当前范围不再授权时返回 `disabled`；三者都不表示来源就绪或平台已送达。同一范围重复调用不需要新的操作 ID，也不会重建接收器或重放未知消息。
- **接收反馈。** `queryFeedback` 记录外部请求的阶段（`received` 到 `completed` / `failed` / `interrupted`）。`effect: upsert` 添加阶段标记，`effect: withdraw` 撤掉 `predecessorOperationId` 指向的旧标记；两笔操作的回执分别可查，平台的 `reactionId` 与原消息 `messageId` 分开记录。阶段标记不代表正文送达。

## 入站

方法：`connection.ingress.ls/inspect/authority/record-authority/rejoin`。合同：[ingress-contract](../../packages/core/src/ingress-contract.ts)。行为要求见[入站认证、收件与恢复](../design/behavior/conversation-channels.md#入站认证收件与恢复)。

- **列表与详情。** `ls` 限定一个 Connection，可选 Binding，续页用 `afterIngressId`；带 Binding 的续页必须来自同一 Binding 与 Connection。`inspect` 返回业务正文、成员身份、安全的拒绝代码和输入引用，并只读地读取 Core 的输入回执；原始平台载荷和传输证明只留在 Host。
- **状态含义。** `received` 表示已耐久收下；`claimed` 表示可能已经调用 Core，因此之后只能查询原操作，回执缺失不授权重放、换目标或换 ID；`refused` 带原因代码。
- **原生动作。** 同一条源消息上的两个平台动作事件是两条入站记录；同一事件的精确重投返回原回执，同一动作事件 ID 下的冲突内容不能替换已保留的载荷。被授权的问题回答与权限决定，经原 Core responder 执行，派发前用意图摘要再核对当前授权；不支持的动作以 `INGRESS_ACTION_UNSUPPORTED` 拒绝，格式无效的回答以 `INGRESS_QUESTION_ANSWER_INVALID` 拒绝。动作引用本身不是授权。
- **授权读取。** `authority` 只返回原认领记录和当前 owner 的授权观察（`current` / `refused` / `unavailable`），不读取 Core 回执，也不构成可传递的许可。
- **重新加入。** `rejoin` 只对 owner 确认已保存的原 Core 等待显式重新加入，使用当前授权，不重放结果未知的效果。动作身份是持有连接器的 Runtime 上的 `(ingressId, operationId)`，只在这条入站记录上核对；重复同一动作只读取或接回原结果，旧来源不影响后来的准备代次。入站 owner 只管理 `received`、首次保存交接和自己的观察；已有 Core 引用时只返回原指针与当前进展，重试、重新启用和派发仍归 Core 输入 owner。自动确保或唤醒不会因为同一引用后来变成 not-applied 而升级为新一次尝试，也不会复活已停止的输入。动作身份或来源引用不授予读取正文、授权或跨 Runtime 控制的权限。

## 原生 API

方法：`connection.api.identities`、`connection.api.request`、`connection.api.inspect`。合同：[connection-api-contract](../../packages/core/src/connection-api-contract.ts)。行为要求见[绑定身份与原生 OpenAPI](../design/behavior/conversation-channels.md#绑定身份与原生-openapi)。

- `identities` 列出某个 Session 可用的绑定身份（Binding 与 Connection 修订、应用、外部会话）及 adapter 声明的请求、响应格式和文档地址，不返回凭据。
- `request` 以选定身份调用平台原生 API：`method`、相对路径、`query`、JSON `body` 或 multipart `files`（文件以 base64 随请求传入，不读取执行 Host 上的路径）。平台 origin 与认证由 adapter 负责。回执只记录方法、路径和覆盖完整请求（含文件字节）的摘要，不保存正文。
- 回执状态为 `responded`（带 HTTP 状态和响应体，可能已脱敏）或 `unknown`。HTTP 响应不代表平台业务操作成功。同一 `operationId` 只返回原结果，改动目标或正文时报冲突。

## 管理认证、应用接入与资料

方法：`connection.setup.begin/advance/inspect/ls`、`connection.enrollment.begin/advance/inspect/ls`、`connection.profile.get/inspect/ls`。合同：[connection-setup-contract](../../packages/core/src/connection-setup-contract.ts)、[connection-enrollment-contract](../../packages/core/src/connection-enrollment-contract.ts)、[connection-profile-contract](../../packages/core/src/connection-profile-contract.ts)。

- **两类意图。** Enrollment 是「创建一个新应用并保存为连接」；Setup 是「对已保存的应用做有限的平台管理」，`goal` 为 `agent-conversation`（`interaction: messages | cards`）或 `profile-update`。两者都只在原操作者面前返回私密确认材料（如扫码载荷、账号与企业）；列表只返回安全摘要和本地实现能力（`support` / `capabilities`）。实现能力不代表平台授权。机器人停用（`enabled: false`）或自动收发服务关闭时，Setup 与 Enrollment 的管理、发现和查询仍可用。机器人的配置修订变化后，Setup 不再返回旧的扫码挑战与账号，原请求保留；私密视图在每次等待安全存储之后重新核对原传输与认证尝试，过期的读取不能暴露先前的二维码或账号。Enrollment 不创建 Agent、群、Binding 或共享授权。
- **逐步推进。** 每次 `advance` 必须使用服务提供的 `actionId` 及对应修订（Setup 为 `expectedRevision`，Enrollment 为 `ownRevision`），每个动作至多发出一个平台请求，请求先认领、结果另存。重复同一动作只读取原回执，或补完本地私密存储的确认；不会重复已认领的平台请求，包括 owner 进程重启之后。重新登录（Setup 的 `renew`、Enrollment 的 `renew-authentication`）放弃当前登录并在同一意图内申请新的挑战，旧回执保留，不会因此创建应用。
- **确认的范围。** 确认账号只确认显示的账号与企业，不证明应用管理权限、租户成员资格、配置、发布或已可聊天。Enrollment 的 `create` 动作授权一个有限序列：上传冻结的 PNG 头像、创建一个普通应用、读取该应用凭据、保存凭据与连接；已建应用的 ID 在凭据移交前保存，读取凭据失败时可用 `read-credential` 继续同一应用，不会重建或按名称选择应用。头像 PNG 由调用方提供：Desktop 素材和 Mote 源图经各自的 client / Host owner 传入，不是 Core 文件路径或托管图片 URL。已退役的 device-registration 流程留下的旧操作保留原 ID 与字节，只做只读投影并可补完原本地确认，不迁移，也不另设兼容执行；缺少网页账号状态时，也不会生成新的原生动作或自动换成另一条创建路线。
- **从 Enrollment 接续。** Setup 的 `source: { kind: 'enrollment', operationId, expectedRevision }` 复用同一操作者在创建应用时已确认的登录，不发 HTTP，要求原保存的创建者。这次本地交接的回执 `request.kind` 为 `enrollment-handoff`，`confirmed` 只表示已在本地保存，不代表扫码初始化或管理权限；接续来的账号仍须单独确认，应用数据也须单独读取。
- **初始化发布。** 新建应用可在同一 Setup 或 Enrollment 输入中显式带 `initialPublication`，授权完成会话所需的消息、事件、权限、接收与（`cards` 时）卡片回调配置，并创建、提交仅创建者可见的首个版本。Setup 中的 `initialPublication` 必须同时带准确的 Enrollment 来源（`source`），`profile-update` 不能带这两者。Host 只创建并提交属于本意图的首个版本，不选用或替换已有的独立版本；重复同一 begin 只回读原版本，不会再次提交。`initialSetup` 是本地进度投影，完成需要读到获批的准确版本，不代表接收器已在线或消息已送达。
- **配置效果。** 每个配置效果有明确的读取来源和独立回执：
  - `enable-messaging`、`use-persistent-connection`、`use-persistent-callback`、`add-card-actions` 是标量开关。`use-persistent-connection` 与 `use-persistent-callback` 分别把整个应用的事件投递和卡片回调改为长连接，会影响该应用已有的其他事件消费者；已是长连接时不写入，未知的原生模式保持未知。
  - `add-application-permissions` 须指定用途。`agent-conversation` 用途覆盖收发消息、建群与绑定群、读取成员名称和头像，以及查询本应用的创建者；新建机器人、绑定已有机器人和补齐已保存机器人缺的权限共用这一用途。能访问平台某个接口不等于有其中资料字段的权限，具体权限项由 adapter 决定。缺口为零时不发请求。
  - `add-message-reception` 只添加所需的消息事件，沿用上次读到的整应用投递模式，不会暗中调用模式开关。
  - 发布用两种草稿：创建版本 `{ kind: 'create-version', version, notes, visibility: 'current' | 'creator-only', desktopEntry?, mobileEntry?, reason? }` 只返回准确的 `versionId`，不发布；提交版本 `{ kind: 'submit-version', versionId, fullRelease }` 必须读取并显式选定准确的版本，不能按列表位置或版本标签选择。发布影响整个应用，审核时须核对全部应用变更、完整的可见与排除受众、入口和外部分享；它不会锁住平台上并发的变更。
  - 请求被接受、当前配置、实际生效的权限、发布和真实收消息是分别成立的事实。结果未知的效果不能经重新登录、新 Setup 或应用别名重放；`recover-configuration-effect` 只补完原效果的本地加密确认。
- **资料。** `profile-update` 须由原账号登录并对该准确应用确认；它不建应用，也不用机器人凭据代替管理授权。它读取当前应用与发布受众、按需上传头像、写入基本信息、回读后创建并提交版本；其他待发布变更需要另行审核。结果未知的写入不会经新账号或别名再次发送。`connection.profile.get` 显式联网观察当前线上资料：线上简介（`profile.description`）只取应用当前线上版本（`onlineVersionId`）的描述，应用顶层描述只作为 `metadata`；机器人名称与头像、版本状态也分别成立，图片 URL 不证明与 PNG 一致。`inspect` / `ls` 只读历史资料操作的回执，其中头像上传与基本信息 PATCH 分开认领、各有状态（`upload` / `patch`），`publication` 只取 `not-requested` 或 `platform-review-required`，资料写入不会隐式发布。
- **请求轨迹。** `setup inspect` 与 `enrollment inspect` 可带 `requestTrace` 返回本地日志投影：原步骤 ID、顺序和回执，不含账号、Cookie、二维码、令牌或原始响应；`network: null` 表示该项未记录 HTTP 细节。读取轨迹不发平台请求、不修复、不重放。

## Channel 展示资料

方法：`connection.metadata.get/ls/refresh/clear/watch`。合同：[channel-metadata-contract](../../packages/core/src/channel-metadata-contract.ts)。

成员和群的显示名、头像按 adapter、平台域名和应用 ID 隔离缓存，与机器人自身资料和消息的不可变署名分开。`get` / `ls` 只读本地缓存，不访问平台，连接停用或配置变化时仍可读；`refresh` 需要当前 Connection 修订并发起一次准确的平台查询；`clear` 需要当前 Connection 修订和 `expectedCacheRevision`（缓存不存在时为 `null`），只清除该 adapter 的派生资料，不影响消息、授权、Session 或待投内容。缓存条目不是输入或授权证据。`watch` 是给本 Host 人或设备的变化提示流，快照仍以 `get` / `ls` 为准。

## 诊断

方法：`connection.diagnose`。合同：[connection-diagnosis-contract](../../packages/core/src/connection-diagnosis-contract.ts)。

按执行 Host 与 Session 读取有界的本地投影：服务策略、每个 Binding 的连接与接收器观察、成员授权计数、最近的出站投递与内容覆盖、入站记录及其 Core 状态；可选 `activity` 汇总最近的收发窗口。出站投递（最新在前）、入站记录和来源缺口每页最多五笔（`connectionDiagnosisWindowLimit`），超出的缺口数量计入 `omittedGapCount`。出站投递按类型化来源区分对话内容、权限、Binding 通知和 `query-feedback` 阶段反馈；较早的 unknown 投递与来源缺口各自保留，不会因为较新的确认投递而消失。每一项读取独立报告 `read-unavailable` / `target-unconfirmed`，一项失败不遮蔽其他项。它不是原子历史，也不是平台就绪检查，不含正文或私密设置材料。

## Mote 机器人操作

方法：`space.mote.connection.create/sync/advance/inspect/ls`。合同：[mote-connection-contract](../../packages/core/src/mote/connection-contract.ts)。

父操作组合 Mote 已保存的公开资料、Enrollment 与 Setup 子操作和默认偏好保存：创建时冻结准确的公开主题修订、可选的头像修订、默认文件基线和子操作 ID，只共享已保存的公开标题、摘要和选中的 PNG，人格、私有记忆和未保存的编辑内容不在其中。`advance` 只观察或显式推进固定的子操作，账号确认与创建需要传入准确的子操作 ID、动作和修订，父操作不替用户选择。旧版本只记录了来源前提（`expectedTopicRevision` / `expectedAvatarRevision`）的父操作仍可读取，并沿已冻结的子步骤续接；这些历史前提不会作为新写入的输入，结果未知的旧请求也不会改形重发。默认偏好保存是一次 Files CAS 写入，丢失确认时保持未知，不因当前值相同而视为成功。同步已有应用的公开资料会影响使用同一应用的其他 Mote 与群。托管 Agent 只能操作自己工作区或其准确 Mote 执行目录内的目标；`sync` 只能用于该 Agent 自己接入的机器人。父操作的所有结果（包括 `inspect` / `ls`）只带子操作的安全摘要，不含扫码载荷、账号等私密确认材料；早期记录里残留的扫码挑战在返回时去掉，原记录不改写。这些材料只经 `connection.enrollment.*` 与 `connection.setup.*` 向原操作者返回。
