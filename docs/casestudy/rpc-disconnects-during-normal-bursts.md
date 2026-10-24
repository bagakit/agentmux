# 后台仍在运行，RPC 却在正常突发中被拒绝

## 定性

P0。连接入口把没有资源依据的 64 项业务 ACK 账本当成容量上限，主动销毁合法新连接；保护措施本身撤销了健康服务原可提供的能力。本文记录对故障包 `7f4ac9d06d` 的调查及后续源码修复，不把私有复现提升成每次现场断开的唯一原因。同日实际加载的 `5923cebb7e` 包含另一篇案例的首输入修复，却不含本篇传输修正；源码验收与补包安装分别结算。能力与真实资源边界沿 [RED-LINES](../../RED-LINES.md)。

## 用户可见症状

用户看到 RPC 断开、原 Agent 的附着或刷新失败。准确 reader 的错误为：

> `RPC ended before its response`

私有突发复现返回：

> `CONTROL_CONNECTION_FAILED` — `RPC connection failed; its business outcome is unconfirmed.`

同屏通知还在反复增长，但那是另一条已确认机制：Core 报告原未完成生命周期时丢掉 operation 身份，Renderer 每次生成新活动 ID。通知放大不能证明 socket 为什么关闭，降低通知数量也不能代签传输修好。

## 影响面

主缺陷位于本地 Unix listener worker 向 Core 交接 Socket 的入口。旧高层 RPC client 的每个 reader 又各自 dial，放大了正常并发对应的连接数。

| 已观察对象 | 结果与范围 |
| --- | --- |
| 同一高层 client 的 16 / 64 次并发 `system.endpoint` | 分别全部成功；不是产品配额或容量证明 |
| 同一 client 的 193 次并发，连续两轮 | 每轮均 64 成功、129 失败；对应旧实现形成的多连接突发 |
| listener publication | 因 pending=64 发布 `CONTROL_CAPACITY`，把人工账本满误报成不可用 |
| 用户原 SID、Run、Native ID 和进程 | 只读调查确认保留，原前台 attached / backend running；不能据此签此前失败操作已完成 |
| 原输出、已有连接和业务未知请求 | 不能被新连接失败撤销；未知施效不授权重放 |

以下不受该 64 分支直接影响：已经移交 Core 的 Socket、Native Run 生命周期、HTTP / Relay，以及一 Socket 对应一原 grant 的 forwarding 授权边界。worker 只销毁新到 Socket；这些事实可从 [listener worker](../../packages/core/src/control-endpoint-listener-worker.ts)、[publication owner](../../packages/core/src/control-endpoint-publication.ts) 和 [公共 client](../../packages/core/src/public-rpc-client.ts) 核对。现场出现的另一个 SSH Host 身份错误不归到本地容量分支。

## 止血措施

保留原 Session、Run、工作面、Attachment 与失败回执。突发回落后，可沿原入口明确重查纯只读观察。有副作用请求的结果未知时先查原 operation，不能自动重发。临时错峰只缓解新连接突发，不把“用户同时只能做 64 件事”变成使用要求。

对于现场那一次究竟由谁关闭 socket，原档案缺少 syscall、完整 transport cause 与准确 RPC method，尚无已证明能覆盖全部现场的带内恢复动作。停止健康 Run、重建 Session、清通知或增加任意超时都不是这份证据支持的止血办法。

## 引入时间线

历史用 `git log -S 'pending.size === 64'`、`git log -L 9,42:packages/core/src/control-endpoint-listener-worker.ts` 与该文件的 `git log --follow` 核对；SSH 同类问题另用 `git log -S 'writableLength'` 和对应 `git log -L` 定位。

| 原提交 | 变化及遗漏 |
| --- | --- |
| `cb713ba31c`，`feat(remote): integrate federated Runtime and durable recovery` | SSH writer 引入 `writableLength + encodedBytes > AGENTMUX_RPC_MAX_MESSAGE_BYTES` 的聚合拒绝，把单帧限制当队列总预算；属于同类资源单位混淆，不是本地 64 连接的直接成因 |
| `3e7ee4f4ce`，`fix(core): recover original control endpoint publication` | 建立私有 listener worker，当时还没有 64 项账本 |
| `9e574fe2d0`，`fix(core): transfer sockets without duplicating listener ownership` | 修复 Unix Server 句柄重复所有权，改为移交 Socket；同时引入 `pending.size === 64` 拒绝、业务 admitted ACK 与 publication 容量状态 |
| `7f4ac9d06d` | 原运行包与私有突发复现绑定的源码；不是阈值引入时间 |
| `285f38fffc`，`fix(core): deliver RPC bursts through actual transport backpressure` | main 删除人工准入账本，复用原连接与实际 writer 背压；对应独立候选提交 `8144e6bf5a` |
| `f19b7ee7ab`，`fix(core): preserve exact cancellation facts before shared dispatch` | main 补回共享 writer 确切未派发取消的 not_applied 事实；对应候选 `a1a659c7dc`，与已派发 unknown 分开 |
| `5923cebb7e` | 同日另核的实际加载包，尚不包含上述传输修正或本轮通知身份修正；不能用该包已启动证明本缺陷已交付 |

引入提交自述为 “Explicit admission ACKs bound pending handoffs at 64”，并在 RED-LINES 说明中把这 64 项称为真实 pending descriptors。原验证证明了封顶、已有连接保留和句柄释放，却没有证明这份账本准确计量资源，或 65 个合法连接为何不能继续交付。`git log -L` 确认，直到本故障包，这段 worker 容量代码自引入后没有再被修改；不能把后续文件存在当成有人重新审过必要性。SSH writer 的该阈值行也保留到了故障包，后续 endpoint 诊断、身份分配改动没有验证合法多帧的聚合背压。

## 根因分析

**直接原因**是 `pending` 混装两类对象：尚未发送的 Socket，以及已经发送、等待 Core 业务 `admitted` ACK 的记录。迟到的业务 ACK 仍占名额；第 65 个到达连接因此直接 `destroy()`。publication 再把账本满报告为 `CONTROL_CAPACITY`。

**根因**是实现用业务确认数量替代了实际传输资源和背压。Node 已有 `process.send` callback 串行流控，`keepOpen:false` 规定发送侧不保留 Socket；callback 表示发送完成，仍不能代签接收方业务处理完成。业务 ACK 与 IPC 发送不是同一资源事实，不能拿它们再建一份人工容量账本。[Node 的原生合同](https://nodejs.org/api/child_process.html#subprocesssendmessage-sendhandle-options-callback)明确区分这些阶段。

旧 Unix client 每次调用单独建立连接，使普通并发观察变成连接突发。SSH 聚合 writer 的另一处错误相似：每一帧合法，却可能因总排队量碰到单帧上限而拒绝。单帧编码限制、真实 writer backpressure、操作权限和同时调用数量是四种不同边界。

**为什么没更早发现**：引入时验证了真实的句柄所有权缺陷，却把附带新增的防御当成无须单独反证的安全措施。封顶测试的绿色只说明常量生效，无法证明常量合理。已有规则要求先问“绕过检查是否还能工作”，提交自己也写了 RED-LINES；评审仍接受了错误资源单位及“超过就可能无界”的推断，没有让合法突发与真实流控承担判据。通知缺身份又扩大了观察噪声，但没有证据证明它直接触发全部 drop。

## 改进措施

1. **删除 listener 的人工 64 drop、业务 ACK 容量账本与假容量状态。** 保留准确 endpoint owner、目录 0700 / Socket 0600、句柄移交与原 `process.send` callback 流控。实际 IPC / OS 资源失败仍按原 owner 报告并清理准确未移交句柄。**是否足够 root**：修复一个共享准入实例；另发现 SSH 聚合阈值这一同类实例，单改 listener 不宣称两处都完成。**能否彻底避免**：能消除这条按常量主动 drop 的原因，不能避免真实资源耗尽。**是否降低系统熵**：删除第二账本、ACK 协议与容量投影；更简单的“把 64 调大”仍保留错误事实来源，因此不采用。

2. **同一公共 Unix client 复用原连接，按 request / subscription ID 分发。** 沿已有 SSH 分发机制共享通用部分，forwarding 保留独立 Socket / grant；取消只释放准确 reader，连接失效不自动重发未知业务。独立 review 又发现排队未写帧的取消被一律报告为 unknown，现以原 writer dispatch 回调保留确切 not_applied，已写出仍 unknown。**是否足够 root**：覆盖一个 Unix per-reader dial 放大点及 Unix / SSH 的共享派发边界；与独立 client 的合法连接准入分别验证。**能否彻底避免**：降低连接放大并消除该错误未知分类，不能掩盖独立连接仍被错误拒绝。**是否降低系统熵**：复用原分发 owner，派发状态只属该 reader 的局部事实；不建业务账本，不用“全部串行调用”把成本转嫁给消费者。

3. **把单帧限制与真实写入背压分开。** SSH 既有聚合阈值已改为沿共享 writer 的 write / drain 交付合法帧，保准确失败和取消。**是否足够 root**：处理第二个已定位的资源单位混淆实例；订阅 reader 的聚合队列另列待核，不声称全仓穷尽。**能否彻底避免**：去掉了该错误聚合拒绝，真实 Writable 的慢写 / drain 反例承担证明，不以源码删除代签。**是否降低系统熵**：复用标准流背压；更简单的“无限制调用 write”会放任缓冲积累，因此不能替代流控。

## 验证

原只读复现从已安装 `7f4ac9d06d` 导入真实 ControlServer / RpcClient，在私有临时 Socket 启动服务，同一 client 顺序执行 16、64、193、193 的并发 cohort，全部请求是 `system.endpoint`。前两组全部成功，后两组各失败 129 次；publication 同时给出 pending=64 的准确诊断。没有访问用户 Runtime、发送 Agent 输入或重启用户 App。它证明真实实现存在可重复缺陷，不证明所有 原用户会话现场断开都由此触发。

该反例的突发复现脚本与原始回执保留在本机过程资料中。新实现的 `node packages/core/scripts/verify-control-admission-burst.mjs --mutations` 最终取得 **35 条通过、六个源码变异各一条业务失败、恢复两条通过**。真实消费包含 193 个独立 client 全部合法准入，同 client 的 16 / 64 / 193 重复突发维持一个物理 Socket、193 个 stream lease 独立取消与通知分发、真实 CLI / Native / SSH 消费以及断线后原 mutation 不重放。六个变异分别恢复 64 drop、撤掉 Unix 共享接线、取消时关闭同伴、错配 subscription、重放未知业务和丢失排队取消事实。

共享 writer 的 `node packages/core/scripts/verify-rpc-stream-writer.mjs --mutations` 另有四条 baseline / 四条恢复通过；恢复聚合阈值、忽略 drain、保留已取消 queued entry、不结算物理关闭等待者四个变异，分别造成 1 / 4 / 1 / 2 个行为失败。夹具使用真实 Node Writable 的 false / drain / close / error，控制慢读行为，不声称实际分配了 64MiB 或测得系统无限容量。实现见 [共享 stream transport](../../packages/core/src/rpc-stream-transport.ts)。

实测的是私有源码候选；403 个输入保持稳定，其中五个产品文件的 hash 逐字节绑定到 main `f19b7ee7abe485beddabf4d7bdb2256b991db7f1`。这不把外层执行树的 HEAD 或后续文档提交冒称实测候选。上述是源码与真实调用链证据，已加载包仍为当次观察到的 `5923cebb7e`，尚无包含这批传输修正的补包安装回执。

通知 producer 丢 ID 与辅助 unknown 触发全局观察，另由准确 Core 生命周期 / Session owner 修复，不把它们的测试绿色算作 Socket 准入证据。纯文档本次仅核原始来源、Git 时间线、直接链接及语义保全，不重跑真实 Runtime 或打包。

## 遗留

- 原用户会话 某次 socket close 的具体底层原因仍未确定；应保准确 method、endpoint / owner、request ID、transport cause 和原 reader，而不是从错误标题猜死亡。
- 新传输源码和共享 writer 背压已获各自真实反例与变异证明；补包安装和 原用户会话现场的对应传输恢复仍需独立回执，不由源码绿色代签。
- `public-rpc-wire.ts` 的订阅累计 pendingBytes 也使用单帧上限，但尚未取得本次真实反例；这里只登记待核，不把静态相似性当已证根因。
- 删除人工阈值不等于承诺无限容量。真实单帧协议、权限、准确目标和资源耗尽边界仍须保留；不能为减少报错静默重放业务或关闭健康 Agent。
