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
| 按已读版本改显示名 | [name](../../packages/core/guides/modules/name.md) |
| 消息、待发消息与准备退避 | [message](../../packages/core/guides/modules/message.md) |
| Endpoint、Host 路由与远程调用 | [system-endpoint](../../packages/core/guides/actions/system-endpoint.md) |
| 读改设置，读取崩溃记录、指标与 doctor 诊断 | [settings](../../packages/core/guides/modules/settings.md)、[system](../../packages/core/guides/modules/system.md)、[diagnostic](../../packages/core/guides/shared/diagnostic.md) |
| Mote 协作与 `mote playbook pmo` 协调流程 | [mote](../../packages/core/guides/modules/mote.md)、[mote-pmo](../../packages/core/guides/actions/mote-pmo.md) |
| 同步问题、权限请求与原生会话 | [agent](../../packages/core/guides/modules/agent.md)、[agent-native](../../packages/core/guides/actions/agent-native.md) |
| 创建 Goal、打开讨论与人认可 | [goal-create](../../packages/core/guides/actions/goal-create.md)、[goal](../../packages/core/guides/modules/goal.md) |

源码、构建、安装与实际运行分别核对；不在当前执行版本 help 中的能力不要猜命令。
