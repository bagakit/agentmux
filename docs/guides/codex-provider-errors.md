# Codex Provider 错误资料与适配范围

本文帮助核对 Codex 原生错误和 AgentMux 的适配范围，依据 [OpenAI 官方 Error codes](https://developers.openai.com/api/docs/guides/error-codes)、Codex 当前原生合同与本仓库实现。官方资料描述 API、WebSocket 和 Python SDK 的错误，不证明当前 Codex CLI 会暴露所有字段；通用产品约束只见[《模型请求失败与工作结果》](../design/behavior/agent-capabilities-and-messaging.md#模型请求失败与工作结果)，Focus 的结果资格见[《项目归属、状态与离线目录》](../design/behavior/focus-context.md#项目归属状态与离线目录)。

## 官方说明的核对范围

完整核对官方页面时覆盖以下全部类别；新增官方条目继续按原码保留，不能把下面的清单作为丢弃未知错误的白名单。表中状态与码是官方 API 含义，只有原生来源确实提供时才能填写为当前请求事实。

| 官方类别 | 已定义的状态或码 | 适配解释范围 |
| --- | --- | --- |
| 服务层级不允许 | `400`，invalid `service_tier` | 配置资格问题 |
| 无效认证、错误凭证、组织成员资格、IP 限制 | `401` | 认证与访问资格；各具体原因保原生说明 |
| 地区不支持 | `403` | 访问范围限制 |
| 余额耗尽 | `429`／`credit_balance_exhausted` | 计费问题；不能当成容量过载 |
| 请求速率限制 | `429` | 速率问题 |
| 请求增长过快 | `429`／`rate_limit_error`／`slow_down` | 速率增长限制，与余额和容量分开 |
| 组织消费限额 | `429`／`organization_spend_limit_exceeded` | 组织计费限制 |
| 项目消费限额 | `429`／`project_spend_limit_exceeded` | 项目计费限制 |
| 组织使用限额 | `429`／`organization_usage_limit_exceeded` | 服务方分配的使用上限 |
| 服务内部错误 | `500` | 请求处理失败 |
| 模型暂时过载 | `503`／`service_unavailable_error`／`server_is_overloaded` | 当前请求的模型容量不足，不推断其他模型有容量 |
| WebSocket 前序响应不可用 | `previous_response_not_found` | 连接上下文引用失败 |
| WebSocket 连接时限 | `websocket_connection_limit_reached` | 连接寿命结束 |

SDK 部分也须核对全部十类：`APIConnectionError`、`APITimeoutError`、`AuthenticationError`、`BadRequestError`、`ConflictError`、`InternalServerError`、`NotFoundError`、`PermissionDeniedError`、`RateLimitError`、`UnprocessableEntityError`。它们帮助解释连接、超时、认证、请求、冲突、服务、资源、权限、速率与处理失败；Python 异常类不是 Codex CLI 的原生错误枚举，不能据此伪造 CLI 已返回该类。

官方页还包含持续错误排查与程序处理建议。计费类的宽泛 `error.type` 可能仍为 `insufficient_quota`，具体原因须保留并读取实际 `error.code`；`429` 与 `503` 不能合并成一个容量原因，计费、消费或使用限额不能靠原样重试恢复。暴露了 `Retry-After` 时保留其值并按官方指引说明等待。这里提供解释和人工恢复指引，不授权 AgentMux 自动重发未知请求、更新账户配置、重建连接上下文或换模型。

## 原生证据与公共错误的对应

每个实际接入的错误形态需沿同一来源核对以下范围，完整文档覆盖与实际 CLI 支持分别说明：

- 原生结构化错误中的 code、type、HTTP 状态、message、retry 信息、model 和 thread／turn 身份各自是否存在；不从同页一般说明补造当前字段。未识别 code 原样保留；缺 native code 明确未知，AgentMux 分类标识注明为本地分类。
- Codex 自己渲染的错误若不带原码，只能识别其实际失败事实和有依据的分类。`Selected model is at capacity. Please try a different model.` 这一呈现不能单独证明 HTTP `503` 或 `server_is_overloaded`；识别还须证明是当前原生错误呈现，不能搜索普通聊天、引用、工具文本或旧屏幕后冒充当前请求失败。
- 原生错误可能发生在独立子 Agent。错误事实保实际主体，主 Agent 当前是否仍在工作或本轮是否失败由真实协议决定；不根据相邻 review 文本猜具体模型或子线程。
- 原生重试通知、最终请求失败、轮结束和进程退出分别核对。后续同请求成功、新轮或来源更换只按准确身份收敛，迟到旧错误不覆盖新结果，历史仍可读。
- Core 公共状态及 SDK／JSON-RPC／CLI、Desktop 服务窗与 Focus 必须消费同一事实；不能只在 Provider helper 或终端看得到便声称闭环。普通输入、原 Session、Run、布局、历史和草稿继续保留。

## 当前适配的原生信号

当前实现直接读取准确原生 JSONL 的轮边界，不通过额外 app-server 查询模型、不扫描 TTY 文案。[`codexTurnRecordEvidence`](../../packages/core/src/providers/codex-prompt-execution-evidence.ts) 在沿原 `session_meta`、FD 文件身份与原生来源确认的记录中解释 `ordinal`、`turn_id` 和可选 `thread_id`；与主来源不符的显式 thread 不成为主轮状态。

| 原生信号 | 当前源码解释 | 暴露边界 |
| --- | --- | --- |
| `task_complete.error` 非空 | 当前轮失败，由 [`codexFailure`](../../packages/core/src/providers/codex-errors.ts) 归一化 | 保可读 message、原生码和实际提供的有效 HTTP 状态；缺码不填官方 API 码 |
| `task_started`／`turn_context` | 当前原生轮 working | 必须有可证明的 turn 与 ordinal，不从对话文本补轮身份 |
| `task_complete` 没有 error | 当前轮完成 | 真实轮边界与旧结果分别表达 |
| `turn_aborted` | 当前轮已结束、成功未知 | 不转换为正常完成；实际含 error 时仍保失败 |
| 原生重试中的普通错误／进度记录 | 不单独作为终局失败 | 仅终局错误边界改变失败结论，后续已核轮状态收敛 |
| 未识别原生错误码 | 通用 `AGENT_PROVIDER_ERROR` 等注明来源的分类，保 nativeCode | 新码不因未列入分类表而被丢弃，不根据错误说明猜码 |
| 聊天、工具输出、历史提示或显式 foreign thread | 不作为当前主轮失败 | 原记录仍沿现历史 reader 可读，不让相同错误文字改写状态 |

`codexFailure` 对 CLI 实际提供的 native 枚举和明确转发码给出恢复指引：容量／服务层级、速率、usage／budget、context、认证／请求、内部／连接／流中断、重试耗尽、策略／权限／sandbox、会话操作与 steer 资格各自解释。官方计费／消费／使用限额码若被转发也按其原码分类；只有 HTTP `429` 时保持通用请求限制，不冒具体速率原因。CLI 的 `server_overloaded` 保留为 nativeCode，不能改写成官方 API 的 `server_is_overloaded`；两者的分类解释相近不证明来源或字段相同。

Provider 的 [`observeCodexSessionStatus`](../../packages/core/src/providers/codex-session-status.ts) 复用轮证据解码与准确原文件观察，初读有界，后续读取新增字节；[`createCodexProvider`](../../packages/core/src/providers/codex.ts) 贡献 `observeSessionStatus`。Core 的 [`ensureNativeStatusObservation`／`statusAgent`](../../packages/core/src/client.ts) 接准确 Run／native source、持久状态与公共事件，SDK／JSON-RPC／CLI 复用原 `agent.inspect`、`agent.ls`、`whoami`。实际消费与后续恢复按对应实现的验证来源和边界核实。

上述是当前源码路径，不表示官方 API、WebSocket 或 Python SDK 的所有错误在 CLI 都会出现，模型、完整 API error.type、Retry-After 等字段也不因此变成已暴露事实。真实支持按轮记录实际字段及对应实现的证明报告；没有原生终局记录或读取失败时保观察未知／明确诊断，不改健康 Run。

## 当前源码入口与交付边界

[Codex Provider](../../packages/core/src/providers/codex.ts) 的 `createCodexProvider` 持有原生协议接缝；[原生历史 reader](../../packages/core/src/providers/codex-native-history.ts) 的 `readCodexSessionHistoryPage`／`itemEntry` 持有对话记录投影，[原生只读 helper](../../packages/core/src/providers/codex-native-read.ts) 的 `withCodexNativeRead` 不执行模型请求。通用 [AgentProvider](../../packages/core/src/agent-provider.ts) 与 [Core Client](../../packages/core/src/client.ts) 的 `statusAgent` 是公共能力和当前状态出口，`probeCapabilities` 的 executable 检查不能证明模型服务有容量。

上面的适配表描述当前源码机制，具体构建与安装的支持范围仍需核对实际版本。核对时记录实际读取的原生载体、可暴露字段、未知边界、对应公共消费及验证来源；源码、构建与当前安装实例分别核对。不存在原生错误码时仍可准确显示失败和带来源的分类，不用 HTTP 状态猜补完整性，也不为预先检查容量另发模型请求。
