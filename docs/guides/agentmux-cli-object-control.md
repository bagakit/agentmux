# AgentMux：按对象操作桌面

先用 `agentmux --skill` 看当前公开合同，具体命令用 `--help`。命令经同一公开 JSON-RPC 服务调用各自业务 owner；Core 持有 AgentSession 语义与[持久空间图](../architecture/spatial-state.md)，Client 消费原位置，负责呈现、真实输入焦点及原宿主资源能力；Run 的进程事实由 ctxmux 持有。

Space 是组织工作面的空间，Project 是仓库／目录归属；两者不等同。Zone 可以关联 worktree、普通目录或 Topic/Mote 工作面。Tab 是完整工作面，Region 是其中一格。Session 回答“哪个 Agent”，它可以有多个展示位置。ID 原样使用，不从名称、当前目录或第一处展示位置猜身份。

## 给新 Agent 第一份任务

先发现 Executor 与空间：

```sh
agentmux settings executors ls
agentmux app snapshot
agentmux space ls
```

以下是需替换 ID／路径的模板。在已有 Zone 开第一张或新 Tab：

```sh
agentmux agent open --executor '<executor-id>' --zone '<zone-id>' --new-tab --prompt '完成这份任务'
```

明确选择 Project 资源与 Space 落点，创建 Git Zone，并直接拉起 Agent：

```sh
agentmux agent open --executor '<executor-id>' --project '<project-id>' --space '<space-id>' --new-zone --worktree --new-branch feat/task --path "$WORKTREE_PATH" --prompt '完成这份任务'
```

新 Zone 必须指定资源 `--project`；Project 多个来源且没有唯一根目录时，用 `--source-workspace` 选择精确来源，不从当前目录或第一个 worktree 猜起点。非 Git 来源使用 `--new-zone --directory "$EXISTING_DIRECTORY"`。存在多个绑定／展示位置时，需要从 `space ls` 取得准确的 `--space`、`--display-workspace`、`--group`，不能猜第一项。后台打开是默认行为，`--focus` 才导航过去。

最终 JSON 的 `result.agent.agentSessionId` 是新 Session 号，`result.to` 是已确认的位置。失败后分别看 `resource`、`agent`、`to`、`issues` 和 `save`，它们说明目录、Session 和工作面走到了哪一步；非零退出不代表全部没创建。失败不会自动删除已生成的 worktree 或停止已创建的健康 Session。回执区分初始任务交付与保存事实；`confirmed` 只证明初始任务交付协议，不能当作 Agent 已接受或完成任务。

后续任务用精确 SID：

```sh
agentmux agent send --to-session '<session-id>' --text '继续下一步'
agentmux agent inspect --session '<session-id>'
```

如果创建回执丢失，先按原 `--operation-id` 业务操作号 `agentmux space inspect --operation-id '<operation-id>'` 对账，不能盲目重建、拉 Agent 或重发初始任务。`settings workspaces register` 仅登记已有目录，不建 Git worktree，也不拉起 Agent。

## 移动和切换位置

```sh
agentmux space mv --from-region '<region-id>' --expect-session '<session-id>' --zone '<zone-id>' --new-tab
agentmux space focus --region '<region-id>'
agentmux goal focus --goal '<goal-id>'
agentmux app inspect
```

移动改变空间位置，保留原 Session、Run、执行目录；`--expect-session` 防止位置内容已更换后操作另一个 Agent。源位置有歧义时，提供准确 `--from-space`／`--from-display-workspace`／`--from-group`。当前不支持移动所属 Tab 有多个 Group 展示的 Region，拒绝时保留全部引用和健康 Agent。`focus` 默认保留当前输入；明确需要把输入转给目标时才用 `--input target`。选择到目标与目标已经可见、已拿到输入，是回执里的不同事实。

`space bind|unbind` 操作 Zone／Space 关系或 Tab／display Workspace／Group 的准确展示关系。解除最后一处绑定仍保留实体与健康内容；显式 Close 是另一件事。具体参数以各命令 `--help` 为准。

提交已编辑的完整空间图解散项目组时，先用 `space state` 读取原图与准确 revision。将本次确认解散的原 `groupId` 填入 `removed.json`，内容例如：

```json
["<exact-group-id>"]
```

以原组的精确 ID 替换占位符，不从名称猜 ID。`removed.json` 是精确组 ID JSON 数组；`--removed-project-groups` 只接受文件路径，不能用 `-`，完整 `graph.json` 仍由 stdin 传入。

```sh
agentmux space commit --revision N --removed-project-groups removed.json < graph.json
```

仅在新图中省略组不构成解散授权。按 [Core 项目组删除意图](../design/behavior/spaces-and-layout.md#跨设备关联项目组)与 [`AgentMuxSpatialCommit`](../../packages/core/src/spatial-graph.ts)，仅移除本次组的组织关系，保留其他组及原 Space／Zone／Tab／Region、Session 与 Run；该示例不请求实体删除。

## 打开文件，切换正文，交换格子

```sh
agentmux file open --zone '<zone-id>' --path 'docs/设计.md'
agentmux agent view --session '<session-id>' --mode activity
agentmux file view --region '<file-region-id>' --mode diff
agentmux space swap --region '<region-a>' --with '<region-b>'
```

文件路径相对 Zone 的真实目录。默认后台打开或复用原 File Tab；`--focus` 才导航到它，多个展示位置用准确 `--display-workspace`／`--group` 指定。目录不会顺带打开 Explorer；媒体与二进制沿原预览，书签文件按源码打开。回执分别报告 `resource`、`placement`、`data`、`navigation`、`save`。读取或导航失败后，已打开的原工作面仍保留；不能用非零退出判断“什么都没创建”，也不能在回执未知时自动重试。

`agent view` 的 `terminal|activity` 偏好属于 Session，会作用于它的全部展示位置。`file view` 的 `source|diff|preview` 偏好属于准确 File Region；同一文件的另一格可以保持自己的模式。省略 `--mode` 只读当前事实，不加载正文、保存或聚焦。File 回执的 `supportedModes` 来自实际格式和读取事实，未知时为 `null`；模式已应用和正文已读到是两件事。File 模式是临时偏好，重启后按原格式默认恢复。

`space swap` 交换同一 Tab 的两个 Region 位置，作用于这个 Tab 的全部展示位置；它保留原 Session、Run、执行目录、文档、草稿、分割比例和逻辑活动 Region。跨 Tab、正在关闭或不唯一的目标会在改动前拒绝，自己与自己交换返回 `unchanged`。这四个入口都不默认抢输入；操作完成后原输入失去资格，回执会如实返回 `partial` 和输入问题，保留已应用结果。保存请求不等于落盘；只有原 Core 持久空间 owner 返回的 `save.diskDurability` 为 `confirmed` 才是耐久确认，`unconfirmed` 保留已应用结果、未保存改动与健康 Agent。

## 改显示名，再读取当前值

```sh
agentmux agent rename --session '<session-id>' --name 'CLI 实现'
agentmux agent inspect --session '<session-id>'
agentmux space rename --tab '<tab-id>' --name '评审'
```

两种改名都支持 `--clear`；名称文本可以使用 `--name=--help`。改名只改桌面显示名称。保存失败会保留已应用的值，返回 `partial` 并退出非零；保存请求不代表磁盘已确认。稍后 `agent inspect` 分别报告 Core Session 与桌面显示事实。桌面覆盖名不能确认早先请求的结果，也不能从覆盖名 `null` 推断 Session 是否存在、退休或健康；桌面不可用时仍保留能读取到的 Core 事实。

右键 Agent 名片用 SID 发送与检查；知道点击的准确 Region 时，另外给空间检查、保输入导航和需填写目标的移动模板。向 Tab 发送时按不同 SID 消歧：同一个 SID 的多个 Region 仍是一个收件人；多个不同 SID 会返回真实候选。最终 owner 发现内容已替换时拒绝原投递，不改投、重发或冒称成功。

## 桌面操作覆盖到哪

命令和参数由当前版本的 `--skill`／`--help` 提供。下表只说明入口，不能把 Source 已实现当成当前安装包已更新。

| 要做的事 | 当前入口 |
| --- | --- |
| 在指定 Space／Zone 开 Agent，交第一份任务 | `agent open` |
| 发现空间、准确查询、绑定、解绑、移动、改名 | `space ls/inspect/bind/unbind/mv/rename` |
| 导航 Space／Goal／工作面，观察选择与输入归属 | `space focus`、`goal focus`、`app focus/inspect` |
| 打开 Terminal／Browser，操作已开的 Browser | `terminal open`、`browser open`、`browser` |
| 按 Zone 目录后台打开或复用文件 | `file open` |
| 读取或切换 Agent／File Region 正文模式 | `agent view`、`file view` |
| 交换同一 Tab 的两个 Region 位置 | `space swap` |
| 提升 Region 为 Tab、调整布局 | `space promote/arrange` |
| 跨对象观察、Goal 和显式 Session 关系 | `app snapshot`、`goal`；方法手册 `mote playbook pmo` |
| 已支持的偏好、诊断与资源观察 | `settings`、`system crash-log/metrics/doctor` |
| Session 消息、输出、生命周期 | `agent send/output/interrupt/resume/stop`、`message inbox/dispatch` |

表中入口的能力边界与接线见[公共能力来源导航](../specs/public-capabilities.md#cli-与服务的当前来源)及[公共控制合同](../design/behavior/public-control.md#对象优先-cli-与统一公共业务服务)。源码、构建、安装与实际运行分别核对；入口清单不代签具体 UI 控件的可操作性，不在当前执行版本 help 中的能力不要猜命令。

共享实体与展示关系由 Core 的同一持久空间 owner 提供；Desktop Store 消费并投影这些事实，CLI 接入同一公共服务，不另建一套空间模型。

## RPC 与远程调用

Endpoint、Host 路由与源身份的行为边界见[公共控制合同](../design/behavior/public-control.md#endpointhost-路由与源身份)；下文按直接连接服务与经配置 Host 两种任务入口操作，准确参数以当前 `--help`／`--skill` 为准。

命令只负责参数与回执，业务都通过同一 typed JSON-RPC 2.0 服务。Unix 与 SSH 使用逐行 JSON；HTTP 持续观察使用 SSE。`system endpoint` 给出当前选择的 endpoint 与 `connection: "not-attempted"`，不连接、不创建服务，也不证明机器可达或 Agent 健康。直接 RPC 调用该方法得到 `connection: "responded"`，只证明本次服务响应。

```sh
agentmux system endpoint
agentmux --endpoint 'unix:/path/to/control.sock' agent ls
agentmux --endpoint 'http://127.0.0.1:8787/' app snapshot
agentmux --endpoint 'ssh://user@host/' app inspect
```

HTTP 服务默认关闭，宿主必须显式配置监听地址与授权 token；HTTP client 从 `AGENTMUX_RPC_HTTP_TOKEN` 取得 token。Agent 的 Session capability 仍在同一服务里验证。SSH 需要远端已有服务和 `agentmux` 可执行文件；远端 `system endpoint --stdio` 只做转发。SSH endpoint 可以通过 `socket` 或 `command` 查询参数选择远端 socket 或可执行文件，值按 URI 编码。

`--endpoint` 选择公共服务；命令支持的 `--host` 选择该服务认识的 Host 路由 ID，不是 SSH 地址。`local` 指接收业务调用的 Core 服务本机，直接连接远端时不指 CLI 所在机器。`agent ls` 每个观察及 `agent inspect` 返回 `routeHostId`，原 `session.hostId` 保留；用发现出的路由 ID 继续 `agent context --host`，其 `sourceHostId` 与 descriptor 保留源服务身份。发现和后续操作须使用同一 endpoint，Host ID 不能跨 endpoint 当作全局机器身份。`settings hosts ls` 是配置发现，不代表已连接。

```sh
# Direct service: local is the remote Core service's machine.
agentmux --endpoint 'ssh://user@build-node/' agent ls
agentmux --endpoint 'ssh://user@build-node/' agent context --host local --session SID
# Via the default service: use its discovered routeHostId, such as build-host.
agentmux agent ls
agentmux agent context --host build-host --session SID
```

Project／Zone 的真实资源决定 `agent open` 的执行机器；展示 Space 或 Region 不改变已有 Session 的 Host／cwd。未知 Host、Session 未发现、owner 歧义与服务不可达保留各自错误，不自动选择首项或重路由。

订阅取消只释放该 reader，保留原 Agent/Run。持续输出携带完整帧、原始 bytes 的 base64 与 cursor；丢失回执后读原操作号，不盲目再发送首任务。
