# 模块接入 Diagnostic Evidence

本页说明一个模块怎样把自己的诊断证据接入统一查询。先读[设计目标与 owner 边界](../design/diagnostic-evidence.md)和[协议](../specs/diagnostic-evidence-protocol.md)。通用包只负责小封套查询；模块负责自己的事实、采集、原件、权限、恢复解释与可选的持久化。普通接入不启动采样，也不需要新的错误类、store、timer 或 schema。

## 最短接入路径

1. **定义领域的 target 与 data 类型。** 复用原有的 logId，或原 execution／artifact 身份；没有原 logId 时让 `recordRef` 为 `null`，不另造。需要历史或区间查询时，贡献真实、有界的索引与 coverage，不扫描所有 Host。
2. **实现一个 `DiagnosticEvidenceReader<TTarget, TData>`。** 它委托原 owner 读取，保留来源的状态、时间与确认程度，只投影有限的安全字段。原文件或 wire 在原 owner 的边界解析，模块内部直接传 TypeScript 类型。
3. **宿主复用一个 `DiagnosticEvidenceQuery`。** 显式组装 reader 与可选的关联函数；只有实际 owner 的证据才能贡献关系。新领域不需要修改 portable query。
4. **要对 Agent 或产品公开时，接到公共接口。** 在 Core 的领域 union、wire codec、服务分支和 CLI 中加入准确目标，更新实际 capabilities，并验证 owner → RPC → typed client → CLI 整条链。尚未接入的业务留在该 owner 的计划里，通用机制不能替它宣称完成。

以下组装代码可直接使用 portable package。Browser owner 的 target/data 是示例领域类型；其 reader 实际实现仍归 Browser 模块。

```ts
import { DiagnosticEvidenceQuery, type DiagnosticEvidenceReader }
  from '@agentmux/diagnostic-evidence'

type BrowserCaptureTarget = { domain: 'browser.capture'; captureId: string }
type BrowserCaptureSummary = { step: 'capture' | 'save'; originalCode: string | null }

export function createBrowserEvidenceInspection(
  reader: DiagnosticEvidenceReader<BrowserCaptureTarget, BrowserCaptureSummary>,
) {
  const query = new DiagnosticEvidenceQuery()
  return (target: BrowserCaptureTarget, signal: AbortSignal) =>
    query.inspect(target, reader, { signal })
}
```

不要每次请求新建 query 来绕过总在途预算（当前实现中 `DiagnosticEvidenceQuery` 的构造默认值是 8 个在途读取）。reader 收到 `signal` 与 `maxBytes` 后，只读取本来源的有限材料；诊断握手失败不能成为停止、重启原执行或重发未知输入的理由。已经发出、不可取消的 IO 继续占用在途名额，直到它真正结束。业务成功与诊断材料的保存确认分别表达。

## 两个可复用的真实适配

[Delivery reader](../../packages/core/src/delivery-evidence-reader.ts) 调用原 DeliveryAttemptStore 与 Core 读取，独立取得 namespace 身份：

- 未限定 namespace 身份时，即使元数据损坏，已找到的记录仍报告 found；限定了身份却无法核验时，拒绝这次限定读取。
- Client 声明的 Core logId，关系核验最多到 `target-matched`；原 Input ACK 只从 Core 记录读取。

[Toolkit reader](../../packages/core/src/toolkit-failure-evidence-reader.ts) 调用原 `toolkit.get`，匹配已有的 `failure.executionId`：

- 它不采集、不 watch、不运行脚本，也不新建存储或 logId；failure 的首次记录和显式 capture 仍归原 owner。
- 原 latest 记录不匹配时返回 not-found 或 unknown，不能据此声称旧执行从未失败。
- 超出本次查询预算的原件标为 withheld；安全的失败事实仍返回，并标 partial 与 omission。

## Agent 查询

```sh
amux system diagnostics inspect --list
amux system diagnostics inspect --domain delivery.client --host-id local --logid LOGID
amux system diagnostics inspect --domain delivery.core --host-id HOST --logid LOGID --authority RUNTIME_ID
amux system diagnostics inspect --domain toolkit.performance-failure --host-id local --execution-id EXECUTION_ID
amux system diagnostics inspect --domain toolkit.performance-failure --host-id local --execution-id EXECUTION_ID --include-raw
amux system diagnostics inspect --domain native-recorder-failure --host-id HOST --session-id SID --run-id RUN
amux system diagnostics inspect --domain reading.lifecycle --host-id HOST --recent --session-id SID --limit 8
amux system diagnostics inspect --domain reading.lifecycle --host-id HOST --logid LOGID --authority CORE_INSTANCE_ID
amux system diagnostics inspect --domain client.incident --host-id local --recent --session-id SID --limit 8
amux system diagnostics inspect --domain client.incident --host-id local --recent --limit 16
amux system diagnostics inspect --domain client.incident --host-id local --logid LOGID --authority ARCHIVE_ID
amux system diagnostics inspect --domain client.notifications --host-id local
amux system diagnostics inspect --domain client.notifications --host-id local --section current --unread --limit 16 --include-raw
amux system diagnostics inspect --domain client.notifications --host-id local --notification-id NOTIFICATION_ID --include-raw
amux system diagnostics inspect --input mote-context-query.json
```

跨进程使用原 `connectAgentMuxRpc` 的 `call('system.diagnostics.inspect', {target,...})`，结果严格解析为 [Core 类型](../../packages/core/src/diagnostic-evidence.ts)。`--no-related` 只读取 root；预算参数只收紧。原领域 CLI 可以负责发现 logId/executionId、专属恢复或 artifact 内容，通用查询不直接读本地文件。

默认公共 Host 复用已有 `forwardControl` 接原 client 的缺域读面；现有本地 domain 仍由原服务读取，不能因 GUI 在场换成同 logId 的另一 journal。能力发现先保本地，再并列原 client 的实际合同。验证须经过真实 Host factory、原 Main business endpoint、typed client 与默认 CLI；只直连 Main 不能证明默认入口接线，callback 存在不能证明 reader 安装。

先查看 availability、失败阶段、已确认事实、issue、completeness 与原目标，再看关系的 verification。Native not-exposed 表示根因材料缺失，不能以关联成功补造根因。raw 明确请求且来源有权限才读取；retained 不等于本次 included，也不代表无限保留。

对话更新延迟先查原 Core `reading.lifecycle` 与 client `client.incident` 的近期候选，再按各自引用准确读取；同 Session 只构成背景关联，不能把不同消费生命周期或跨进程 wall 时间拼成同一次耗时。Core 元数据仅覆盖当前实例；Renderer 消费阶段沿原 client 档案留存，卸载后是否可查取决于实际保存、预算和覆盖。`confirmed` 是原写入确认，重启后 `observed` 只说明现有原字节可读；近期为空、候选已淘汰或采集未覆盖均不能证明业务没有更新。无需通过重发、重开页面或恢复原工作面制造诊断材料。

通知面板的事实使用 `client.notifications`，默认列当前问题与该 client 保留的活动，不读取 A2A Inbox 或全局日志档案。可按 current／activity、类别及未读筛选，沿返回的 notificationId 精查；原文须显式 `--include-raw`。同一页序列保留原筛选、limit 与 cursor，expired 时重新列举；不要把新旧快照拼成完整结果。查看 coverage 与 omissions，原 client 不可用或加载中不能当作空列表。查询使用同一通知 owner，不打开面板、不标读，也不执行通知中描述的恢复动作；字段、范围与游标合同见[原领域类型](../../packages/core/src/client-notifications.ts)和[诊断协议](../specs/diagnostic-evidence-protocol.md)。

## 客户端故障档案与原来源引用

`client.incident` 由宿主显式注入 [共享 archive 实现](../../apps/host/src/client-incident-archive.ts)，保留自动报告的有限阶段、计数、原尝试和来源身份。先用 `--recent` 在准确 archive Host 发现候选，或以 `--authority` 限定原档案，再以返回的原 `recordRef.logId` 和 authority 精查；无 authority 的已知来源与 partial 合同见[手机网页的有限观察](../design/diagnostic-evidence.md#手机网页的有限观察)。archive 路线与报告中的执行 Host 分别保真。recent 的 coverage、persistence 和 cursor 均沿 [公共类型](../../packages/core/src/client-incident.ts)，空结果不能证明此前没有异常。`--include-raw` 不会给事件记录添加终端正文、错误文本、路径或截图。

报告只在原 owner 已有准确 typed 引用时填写 `references`。默认查询沿 [引用投影](../../packages/core/src/client-incident-evidence.ts) 将这些声明交给原 Delivery、Toolkit、Scene reader，继续使用同一查询预算、实际在途槽、权限和安全投影。引用原 logId、executionId 或 captureId，不迁移原件，不按相近时刻、同 Session 或文案补关联；Toolkit/Scene 没有原 logId，读回仍为 `recordRef=null`。读取成功只表示准确目标可读，不升级为 owner-confirmed 因果。

`--no-related` 只读事件原记录。关联源缺失、原件损坏、被淘汰、不可用或权限拒绝时，主记录和其他合法来源仍保留；查看各 read 的原 target、availability、issue 与 coverage。没有已得引用时 `references=[]`，不代表其他来源正常，也不表示普通终端事件已经自动关联全部诊断材料。

统一入口没有 Crash reader；不要构造 Crash logId 或广告该来源 supported。已有保留 Crash 事实继续用只读 `amux system crash-log inspect`，该入口不因此变成事件关联 reader。`native-recorder-failure` 仍明确 `not-exposed`，不以事件或 Scene 的读取结果代签 Native 首故障已取得。读取过程不提交输入、不刷新会话、不探测连接，也不启动新的采集。

## owner 的必要取舍

| 事项 | 接入责任 |
| --- | --- |
| 错误码与阶段 | 只公开领域内有限、安全的错误码与阶段；未知的原始字符串只放在显式请求的原件里。用任意大写字母正则匹配出来的字符串不构成安全合同。 |
| 时间与身份 | 保留原 producer、observer、实例与时钟域；失败当时的材料与后来的观察分开，不用当前 namespace 回填旧事件的身份。 |
| 原件与留存 | 说明哪些材料实际保留、是否裁切、确认状态和总预算；原件已不可恢复时直接说明。 |
| 正常性能与限制观察 | 保留原 MetricsSource 的 pending、stale、unavailable 状态及旧数据和原时刻；命中限制时保留当时生效的限值、revision 和所采取的动作。 |
| coverage 与采集 | 短环、峰值、首次和历史各自承诺覆盖范围；采样如实报告进度、结束与空窗。查询不启动采样，停止请求与实际终态分开报告。 |
| 健康与成本 | 写盘、读取、元数据或慢消费者失败只影响诊断本身；普通 reader 不是健康能力的门禁，热路径成本不随无关 Session 增长。 |

## 接入证明

新机制的通用边界至少用两种不同的实际触发来检查。必需的反例：

- 原件可读但身份缺少证据；显式限定的读取不被放宽；
- 主操作失败后诊断或 cleanup 也失败；部分来源不可达；
- 取消、慢读者与真实 pending IO；raw 与总封套预算；
- 未知错误码与私密原文；原记录跨 owner reload。

测试必须消费真实的产品 owner 和公共 CLI；改坏关键接线或投影后，断言必须失败。只测手写的模拟结果或导出符号不算接入证明。

原 owner 没有 history、capture 或 artifact 能力时，如实保持 unsupported 或缺证，先把普通 reader 接通；不为接入新建万能插件库或统一状态数据库。源级通过不代表安装包已加载，也不替 Native 根因、性能收益或原 Session 恢复验收。

## Mote 原 action 观察

注入了 `mote.context.client` 的 client 使用原 AppStore 的 action map，不另增 journal。查询前先取齐准确目标：

- 用 `app snapshot --include workspaces` 固定资源 Workspace 的 hostId 与 path；只请求 `--include motes` 时结果里没有 workspaces，这是显式筛选，不表示资源不可发现。
- 用 Mote 发现取 topicId，用 `app inspect` 或 `space ls` 取原 Tab 与展示 reference。
- Mote 的物理路径、HomeZone 或逻辑 Topic 路径都不能代替原 `Workspace.path`；今天的发现结果也不回填旧 failure 当时捕获的目标。

完整查询通过既有 CLI `--input FILE|-` 或 typed RPC 传入，字段以 [领域类型](../../packages/core/src/mote/context-observation.ts) 为准，例如：

```json
{"target":{"domain":"mote.context.client","hostId":"local","scope":{"hostId":"RESOURCE_HOST","directoryPath":"RESOURCE_WORKSPACE_PATH","topicId":"TOPIC_ID","tabId":"TAB_ID"},"action":"prepare"},"includeRaw":false,"includeRelated":false}
```

外层 `hostId` 是 client reader 的路由；`scope.hostId` 是资源所在的 Host。`prepare` 不限定展示 reference；`open-space` 必须另传原完整 reference，或真实的 `null`。读回的 operation 与 failure 保留实际目标、步骤和时刻；另一个 scope 或另一处展示不能代替原记录。原材料只是实际保留的原因文本：默认不跨 IPC 请求原文，显式 `includeRaw` 仍受原可信来源的权限与预算约束；不足时返回安全事实并标 withheld 或 partial，不返回被剪短却标为完整的原因。安全封套本身也超出预算时返回 `QUERY_BUDGET`。

这个读面不保证历史留存，也不说明原 Session 是否健康；没有 scope key，或 reload 后来源已不存在，返回 not-found 或 unknown。只有 Main 与 Renderer 都更新到匹配版本后才组装这项 capability；只更新 Renderer 时继续使用不变的 `inspect.client` v1，不向旧 Main 广告新 domain。读取不重试、不 focus、不 ensure，也不启动 Run；取消等待不会提前释放仍在途 IPC 的真实成本。
