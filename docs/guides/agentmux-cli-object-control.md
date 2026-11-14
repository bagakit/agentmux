# AgentMux：用 CLI 操作桌面的指南导航

本页只做导航：Agent 用 CLI 操作桌面时，按要做的事找到对应的 Core 系统指南。命令、参数与回执字段以当前执行版本的 `amux --help`、`amux <模块> --skill` 为准，正文唯一在 [Core 系统指南](../../packages/core/guides/README.md)。

委派给谁、内容打开在哪里、要不要改变导航和输入、怎样确认落点，见 Core 的 [Delegation and opening playbook](../../packages/core/guides/shared/spatial.md#delegation-and-opening-playbook-advisory)。公共能力的源码入口见[公共能力来源导航](../specs/public-capabilities.md#cli-与服务的当前来源)，行为合同见[公共控制合同](../design/behavior/public-control.md#对象优先-cli-与统一公共业务服务)。

## 命令从哪里读

| 要做的事 | Core 指南 |
| --- | --- |
| Space、Zone、Tab、Region 与 Session 的含义和身份 | [spatial-terms](../../packages/core/guides/shared/spatial-terms.md)、[space](../../packages/core/guides/modules/space.md) |
| 开 Agent、交第一份任务、Mote 首问 | [agent-open](../../packages/core/guides/actions/agent-open.md)、[agent](../../packages/core/guides/modules/agent.md) |
| Agent 的检查、输入、输出、对话读取与生命周期 | [agent](../../packages/core/guides/modules/agent.md) |
| 打开终端与 Browser、操作 Browser 页面与任务 | [terminal](../../packages/core/guides/modules/terminal.md)、[browser](../../packages/core/guides/modules/browser.md)、[browser-task](../../packages/core/guides/actions/browser-task.md) |
| 发现、移动、聚焦、绑定、交换空间对象，分屏与新 Tab | [space](../../packages/core/guides/modules/space.md)、[spatial](../../packages/core/guides/shared/spatial.md) |
| 独立窗口、应用导航、工作面截图与录制 | [app](../../packages/core/guides/modules/app.md) |
| 读写和打开文件、切换正文模式、编辑 Note | [file](../../packages/core/guides/modules/file.md)、[note-editing](../../packages/core/guides/shared/note-editing.md)、[notebook](../../packages/core/guides/actions/notebook.md) |
| 日历提醒、倒计时与重复消息 | [schedule](../../packages/core/guides/modules/schedule.md) |
| 原 Terminal Run 的读取、输入、中断与停止 | [terminal](../../packages/core/guides/modules/terminal.md) |
| Host 登记、配置、测试与原维护申请 | [settings](../../packages/core/guides/modules/settings.md) |
| 外部连接、原账号确认、收发与恢复 | [connection](../../packages/core/guides/modules/connection.md) |
| Node 发布范围、原资源读取与跨节点路由 | [node](../../packages/core/guides/modules/node.md)、[route](../../packages/core/guides/modules/route.md) |
| Browser Profile、代理、书签与原创建操作查询 | [browser](../../packages/core/guides/modules/browser.md) |
| 固定提交、分支比较与原 worktree | [git](../../packages/core/guides/modules/git.md) |
| 按已读版本改显示名 | [name](../../packages/core/guides/modules/name.md) |
| 消息、待发消息与准备退避 | [message](../../packages/core/guides/modules/message.md) |
| Endpoint、Host 路由与远程调用 | [system-endpoint](../../packages/core/guides/actions/system-endpoint.md) |
| 读改设置，读取崩溃记录、指标与 doctor 诊断 | [settings](../../packages/core/guides/modules/settings.md)、[system](../../packages/core/guides/modules/system.md)、[diagnostic](../../packages/core/guides/shared/diagnostic.md) |
| Mote 协作与 `mote playbook pmo` 协调流程 | [mote](../../packages/core/guides/modules/mote.md)、[mote-pmo](../../packages/core/guides/actions/mote-pmo.md) |
| 同步问题、权限请求与原生会话 | [agent](../../packages/core/guides/modules/agent.md)、[agent-native](../../packages/core/guides/actions/agent-native.md) |
| 创建 Goal、打开讨论与人认可 | [goal-create](../../packages/core/guides/actions/goal-create.md)、[goal](../../packages/core/guides/modules/goal.md) |

源码、构建、安装与实际运行分别核对；不在当前执行版本 help 中的能力不要猜命令。

审查功能完整性时，沿同一业务 owner 核对发现、准确目标与权限、动作、原结果查询、未知结果与重开恢复，以及 GUI 的同源消费。全量注册与帮助差集、带明确输入样例的 transport 检查、实际业务调用链分别说明证明范围；方法计数、无效 JSON 或 help 成功不能代替完整链验收。原请求、业务 operationId、当前观察与原确认回执分别保留，查询不自动重放未知操作。

RPC 无需逐方法对应一个独立命令。Hosted SDK 承载、签名接收 transport、reader 取消和真实 producer 报告由原消费者组合；它们不成为可制造确认的业务动作。学习批准、Host 维护审核、来源信任和人的页面输入仍沿原可信主体，不因存在 CLI 而放宽。原 GUI 的拖动、选区与逐键编辑无需另造一套 CLI 手势层。具体源码、消费者和边界见[公共能力来源导航](../specs/public-capabilities.md)，新增或改变行为按[公共能力贡献约定](public-capability-contributions.md)验收。
