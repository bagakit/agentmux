# 模块接入 Diagnostic Evidence

先读[设计目标与 owner 边界](../design/diagnostic-evidence.md)和[协议](../specs/diagnostic-evidence-protocol.md)。通用包负责小封套查询；模块负责自己的事实、采集、原件、权限、恢复解释与可选持久化。普通接入不启动采样，不需要新错误类、store、timer 或 schema。

## 最短接入路径

1. 定义明确领域 target/data。复用原 logId 或 execution/artifact 身份；无原 logId 就让 recordRef=null。为历史/区间查询贡献真实有界索引和 coverage，不扫描所有 Host。
2. 实现一个 `DiagnosticEvidenceReader<TTarget,TData>`。委托原 owner 读取，保来源状态/时间/确认，投影有限安全字段。原文件或 wire 在原边界解析，内部直接传 TS 类型。
3. 宿主复用一个 `DiagnosticEvidenceQuery`，显式组装 reader 与可选关联函数。只有实际 owner 证据才能贡献关系；新领域不需改变 portable query。
4. 若对 AgentMux Agent/产品公开，在 Core 领域 union、wire codec、服务分支和 CLI 贡献准确目标，更新实际 capabilities，并验证 owner→RPC→typed client→CLI。未接入的业务留在该 owner 的计划中，不能由通用机制宣称完成。

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

不要每次请求新建 query 来绕过总在途预算。reader 收到 signal/maxBytes 后，只读取本来源的有限材料；不能因诊断握手失败 stop/restart 原执行或重发未知输入。已有 IO 不可取消时如实保在途成本。业务成功和诊断保存确认分别表达。

## 两个可复用的真实适配

[Delivery reader](../../packages/core/src/delivery-evidence-reader.ts) 调用原 DeliveryAttemptStore/Core read，独立取得 namespace 身份。未限定身份且元数据损坏时仍保 found；限定身份未核验时拒绝该限定读取。Client 声明的 Core logId 最多 target-matched，原 Input ACK 只从 Core 记录读取。

[Toolkit reader](../../packages/core/src/toolkit-failure-evidence-reader.ts) 调用原 `toolkit.get`，匹配已有 failure.executionId。它不采集、不 watch、不运行脚本，不新建存储或 logId；原 failure 首次记录和显式 capture 仍归原 owner。原 latest 不匹配时 not-found/unknown，不能声称旧执行从未失败。超出本查询预算的原件 withheld，安全失败仍返回 partial 和 omission。

## Agent 查询

```sh
amux system diagnostics inspect --list
amux system diagnostics inspect --domain delivery.client --host-id local --logid LOGID
amux system diagnostics inspect --domain delivery.core --host-id HOST --logid LOGID --authority RUNTIME_ID
amux system diagnostics inspect --domain toolkit.performance-failure --host-id local --execution-id EXECUTION_ID
amux system diagnostics inspect --domain toolkit.performance-failure --host-id local --execution-id EXECUTION_ID --include-raw
amux system diagnostics inspect --domain native-recorder-failure --host-id HOST --session-id SID --run-id RUN
amux system diagnostics inspect --input mote-context-query.json
```

跨进程使用原 `connectAgentMuxRpc` 的 `call('system.diagnostics.inspect', {target,...})`，结果严格解析为 [Core 类型](../../packages/core/src/diagnostic-evidence.ts)。`--no-related` 只读取 root；预算参数只收紧。原领域 CLI 可以负责发现 logId/executionId、专属恢复或 artifact 内容，通用查询不直接读本地文件。

先查看 availability、失败阶段、已确认事实、issue、completeness 与原目标，再看关系的 verification。Native not-exposed 表示根因材料缺失，不能以关联成功补造根因。raw 明确请求且来源有权限才读取；retained 不等于本次 included，也不代表无限保留。

## owner 的必要取舍

| 事项 | 接入责任 |
| --- | --- |
| 错误码与阶段 | 领域有限安全码/阶段；未知原字符串只留显式原件，任意大写 regex 不构成安全合同 |
| 时间与身份 | 原 producer/observer/实例/clock domain，失败时材料与后来观察分开，当前 namespace 不回填旧发生身份 |
| 原件与留存 | 明确哪些材料实际保留、是否裁切、确认状态和总体预算；原件不可恢复时直接说明 |
| 正常性能/限制观察 | 保原 MetricsSource 的 pending/stale/unavailable、旧 data/原时刻；限制命中保当时 effective limit/revision/动作 |
| coverage/capture | 短环、peak、first、历史分别承诺；采样真实进度/结束/空窗，查询不启采样，stop 与实际终态分开 |
| 健康与成本 | 写盘/读取/metadata/慢消费者失败只影响诊断；普通 reader 没有健康能力 gate，热路径不随无关 Session 放大 |

## 接入证明

用两种不同的实际触发检查新机制的通用边界。必需反例包括：可读原件但身份缺证、显式限定不放宽、主失败后诊断/cleanup 失败、部分来源不可达、取消/慢读者/真实 pending IO、raw 和总封套预算、未知码与私密原文、原记录跨 owner reload。测试必须消费真实产品 owner 和公共 CLI，改坏关键接线/投影应 AssertionRED，不能只测手写模拟结果或导出符号。

原 owner 无 history/capture/artifact 能力时保持 unsupported/缺证，先闭合普通 reader；不为接入新建万能插件库或统一状态 DB。源级通过不代表安装包已加载，也不替 Native 根因、性能收益或原 Session 恢复验收。

## Mote 原 action 观察

实际注入 `mote.context.client` 的 client 用原 AppStore action map，不增加 journal。先用 `app snapshot --include workspaces` 冻结 resource Workspace 的 hostId/path，用 Mote discovery 取 topicId，用 `app inspect` / `space ls` 取原 Tab/reference。`include motes` 没有 workspaces 是显式筛选，不是资源不可发现；Mote physical/HomeZone/logical topic path 不代替原 Workspace.path。当前发现不回填旧 failure 的 captured target。

完整查询通过既有 CLI `--input FILE|-` 或 typed RPC 传入，字段以 [领域类型](../../packages/core/src/mote-context-observation.ts) 为准，例如：

```json
{"target":{"domain":"mote.context.client","hostId":"local","scope":{"hostId":"RESOURCE_HOST","directoryPath":"RESOURCE_WORKSPACE_PATH","topicId":"TOPIC_ID","tabId":"TAB_ID"},"action":"prepare"},"includeRaw":false,"includeRelated":false}
```

外层 hostId 是 client reader route；scope.hostId 是资源 Host。prepare 不限定显示 reference；open-space 必须另传原完整 reference 或真实 null。读回 operation/failure 保实际目标、步骤和时刻；另一 scope/occurrence 不代替原 record。原材料只是实际 retained cause 文本。默认不跨 IPC 请求原文，显式 includeRaw 仍受原可信来源权限与预算；不足时保安全事实与 withheld/partial，不返回剪短却标完整的原因。安全封套自身也超预算时返回 QUERY_BUDGET。

这个读面不保证历史留存或原 Session 健康；没有 scope key/reload 后缺源，保 not-found/unknown。完整 Main 与 Renderer 匹配更新后才组装 capability；Renderer-only 更新继续使用不变的 inspect.client v1，不向旧 Main 广告新 domain。读取不重试、focus、ensure 或启动 Run；取消等候不提前释放仍在途 IPC 的真实成本。
