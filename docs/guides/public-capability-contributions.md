# 新功能的公共能力贡献约定

新增功能或修改既有行为的作者，必须在开工前判断公共接口影响，并把受影响的 JSON-RPC、CLI、发现与回执纳入同一 Feature 的计划和验收。面向用户或 Agent 的业务能力不能只交付 GUI；无需修改接口时也要说明理由。本约定指导作者判断和交付，精确签名、方法、参数与命令仍由[公共能力源码入口](../specs/public-capabilities.md)持有。

## 开工前判断接口影响

在现有 approved plan 的任务范围与 acceptance 中说明以下四项，不另建协议清单或 Tracker schema：

1. **业务对象与 owner。** 用户要查询什么事实、改变什么状态或执行什么动作；准确身份、资源与持久状态来自哪里。职责沿[系统分层](../architecture/system-ownership.md)，空间事实沿[Core 持久空间状态](../architecture/spatial-state.md)。
2. **RPC 的处理。** 列出受影响的原方法，判断复用、修改或新增；原方法足够时直接消费，不能因功能名不同另造同义方法。
3. **CLI 的处理。** 说明 Agent 怎样发现目标、执行动作、观察结果及处理未知；列出受影响的命令、参数、发现结果、help／skill 或使用示例。已有命令能完整表达时复用，不要求每个底层 RPC 都有一个独立命令。
4. **验收与边界。** 给出真实业务 owner 到公共服务、客户端与实际 CLI 的验证方式；说明权限、只读／副作用、错误和部分失败。无需接口变更时，指出保持成立的现有合同与理由。

| 改动 | 必须判断和交付的内容 |
| --- | --- |
| 新业务动作或新的可观察结果 | 优先复用或扩展原对象的方法与命令；没有合适入口时新增 typed RPC 和可发现的 CLI 使用方式。需要后续查询或持续观察的结果，沿原 inspect／operation／订阅 owner 表达。 |
| 已有能力的参数、结果、错误或语义改变 | 同步修改原类型、严格解析、服务接线及受影响的 CLI／Client；成功字段、错误 detail、候选和 unknown 不能在输送中丢失。 |
| 新配置项或 Provider 能力 | 配置沿[Settings 贡献约定](../settings-module-contributions.md)，Provider 沿原通用 Agent API；不能为配置字段或厂商另造一套业务命令。确有新的通用业务语义时，按前两行判断。 |
| 纯视觉、动画、内部重构或性能优化 | 保持公开行为时无需新增 RPC／CLI；若改变可查询事实、导航／输入、副作用、错误或恢复语义，仍按受影响的原接口修改和验证，不能因代码在 Renderer 就略过。 |

命令沿[对象优先 CLI](../design/behavior/public-control.md#对象优先-cli-与统一公共业务服务)归属业务对象，不按 Feature 名新增顶层域、兼容别名或通用任意执行入口。只读手册可以引用能力，不能代替业务接线。需要人类确认的能力仍由原可信 owner 取得实际确认；公开命令或 RPC 参数不能让 Agent 冒充用户、升级权限或绕过确认。

## 接到唯一业务服务和实际命令

先核原 owner，再沿已有接缝补齐受影响的部分：

- **业务与公共类型。** 行为在原 Core／Host／Client owner 实现；公共方法、参数、结果和流由 [public-rpc.ts](../../packages/core/src/public-rpc.ts)及其引用的领域类型定义。内部 Control DTO 不作为另一套公开 wire；Provider 只解释自己的原生协议。
- **服务与严格解析。** [AgentMuxRpcService](../../packages/core/src/public-rpc-service.ts)接原 owner；核对受影响的[业务 codec](../../packages/core/src/rpc-business-codec.ts)或[原生结果 codec](../../packages/core/src/rpc-native-codec.ts)，以及实际宿主注入端口。CLI、HTTP 和 SSH 共用同一服务与授权合同，保留原业务身份和结果，不为传输复制业务逻辑、状态或 Runtime。
- **命令与发现。** 在 [AGENTMUX_CLI_COMMANDS](../../packages/core/src/agentmux-cli-commands.ts)及其现有领域 parser 修改注册、参数和说明；[help／skill](../../packages/core/src/agentmux-cli-help.ts)从注册来源生成。新身份和结果须可原样用于后续精确命令；核对受影响的对象 ls／inspect、聚合观察、名片及运行指引，不从名称、cwd、焦点或首候选猜目标，也不把无关字段机械加入全部发现入口。
- **真实消费。** CLI 仅通过[公共客户端](../../packages/core/src/public-rpc-client.ts)调用服务；GUI 与其他客户端消费同一业务 owner 的事实，不要求 GUI 绕行 CLI，也不在 CLI 直接读写本地 Store。新增命令须接到实际业务，不能只注册 help 或用固定结果充当实现。

命令注册的 `method` 持有对象与动作拼写，`usage` 只描述其后的参数；help／skill 由原生成器组合两者。必需输入不用可选括号，描述须与原 parser 一致。验证实际生成的总帮助、对象／动作帮助与技能输出，不能只检查命令名出现过；这些输出仍须保留该候选原权限、只读／副作用及恢复说明。

一次请求的 JSON-RPC `id` 与原业务 `operationId` 分开。需要对账的副作用沿原操作身份查询；回执未知不当作未发生，不盲目重做。持续观察保原顺序、Gap 和完成事实；取消或断线只释放该 reader，不能停止原业务或健康 Agent。选择、实际呈现、输入、投递、任务接受和磁盘耐久性继续按[公共控制合同](../design/behavior/public-control.md)分别报告。

## 同一任务交付和验收

实现任务完成前，作者与 reviewer 核对计划中的接口判断已经兑现：

- 受影响的真实生产调用路径连到原业务 owner。修改公共业务能力时，以公共客户端和实际 CLI 验证结果与原业务事实一致；已有命令复用也验证它确实覆盖本次新行为。仅供 SDK／客户端组合的基础方法无需一比一命令时，证明其实际客户端或已有命令的消费路径并说明理由；这不能省掉面向用户或 Agent 的业务能力的 CLI 使用方式。
- 成功与有意义的失败均验证：准确目标和权限、不可用／unknown、部分成功、错误与恢复事实不能互相代签；异步能力验证真实观察和取消。只跑 parser、类型检查、help 或服务 fixture 不算完整接线。
- 沿[任务验收与假绿防护](../testing/strategy.md#任务验收与假绿防护)完成实际实现变异与真实产品调用链检查。撤掉或改坏关键服务接线、解析或调用者行为时，对应验证须能变红；不制造与实现镜像的手写方法全集，也不用空扫描或测试内自调用代签。
- 更新受影响的来源导航和操作指南，命令示例与该候选实际 help／skill 一致；验收绑定同一候选，源码、构建、安装与当前连接实例分别说明。共享传输的已验部分可复用，传输相关改动才补相应路径验证，本机通过不代签真实远端。

受影响的 RPC／CLI 接线或真实调用者未完成时，该实现任务不得标 done；按原 Tracker 如实记录缺口和 blocked，不用 GUI 成功代签。纯文档改动仍按[文档事实与维护](document-truth-and-maintenance.md)核来源、链接与语义保全，不制造不存在的代码验收。原视觉、恢复、性能与健康能力要求保持，打包消费任务验收，不把这份约定变成打包时的新一轮全量检查。
