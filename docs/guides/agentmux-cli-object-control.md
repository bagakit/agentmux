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

读取已经保存的原文件，不打开 Tab 或读取编辑器中的未保存草稿：

```sh
agentmux file read --zone '<zone-id>' --path 'saved.md' --host '<host-id>' --workspace '<resource-workspace-id>' --workspace-path "$RESOURCE_DIRECTORY"
```

先从 `space ls`／`space inspect` 的原 Zone 资源确认 Host、Workspace 与目录；这些是文件资源，不是当前显示 Workspace。`--path` 相对该 Zone；可加 `--space` 核对原绑定，多处合法绑定不会改变文件身份。结果的 `resource` 与 `result` 分别表达准确来源和原 Files 的读取事实：文本保留完整 `sha256` revision，二进制、已删除、目录和原错误保持原状态。`unknown` 表示这次观察未确认，保留原引用并重新发现／读取；不解释为文件已删除，也不影响原文件编辑或健康 Agent。

日历提醒使用显式 JSON，沿原 Session／调度 owner 执行：

```sh
agentmux schedule list
agentmux schedule inspect --data request.json
agentmux schedule create --data request.json
agentmux schedule pause --data request.json
agentmux schedule resume --data request.json
agentmux schedule cancel --data request.json
```

`--data` 接受文件或 `-` 标准输入。创建包含 `target: {hostId, agentSessionId, providerId, workspacePath}`、非空 `prompt`、`operationId` 和 `calendar`。日历显式给出 IANA `timezone`、本地 `time`、`kind`（`once|daily|weekly|monthly|yearly`）及 `policies: {gap:'skip', fold:'earlier'|'later', monthEnd:'clamp', overdue:'latest'}`；各周期的日期字段以公共类型为准。检查在 `scheduleId` 与原 `operationId` 中选一个；暂停／恢复／取消包含 `scheduleId`、已读 `expectedRevision` 与本次 `operationId`。每次变更核真实 caller，不允许用 timer 冒人类作者。未知回执先检查原 operation；不自动重发。保存不等于已投递，投递不等于 Agent 完成；断开宿主时不会假装仍在云端执行。

用户可在同一创建 JSON 中显式加入 `checkIn: {silenceMs:64800000, minIntervalMs:72000000, dailyBudget:1, quiet:{start:'<quiet-start-HH:mm>', end:'<quiet-end-HH:mm>'}}` 开启安静跟进；其中安静时段的两个占位符须替换为实际策略时刻，JSON 文件需使用双引号。省略即关闭，已鉴权 Agent 不能开启。两个间隔可明确设置为 5 分钟至 30 天，预算为每个保存时区的日历日 1–3 次；安静时段使用该时区的 `HH:mm`，开始与结束须不同。`inspect` 显示保存策略、已认领预算、未答状态与未知原因，暂停／继续／取消仍用上面的原操作。跟进要求可确认的本会话人工上下文；较晚未知输入或当前来源未确认时保原到期安排。问候内容由真实 Agent 依据保存主题生成，不能把 timer、Native 文本或 Agent 消息当人类答复。

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
| 读取准确 Zone 原文件的已保存正文与完整版本 | `file read` |
| 检查、创建或暂停准确 Session 的日历提醒 | `schedule list\|inspect\|create\|pause\|resume\|cancel` |
| 读取或切换 Agent／File Region 正文模式 | `agent view`、`file view` |
| 交换同一 Tab 的两个 Region 位置 | `space swap` |
| 提升 Region 为 Tab、调整布局 | `space promote/arrange` |
| 跨对象观察、Goal 和显式 Session 关系 | `app snapshot`、`goal`；方法手册 `mote playbook pmo` |
| 已支持的偏好、诊断与资源观察 | `settings`、`system crash-log/metrics/doctor` |
| Session 消息、输出、生命周期 | `agent send/output/interrupt/resume/stop`、`message inbox/dispatch` |

“全部桌面操作”还没有完成。共享投影在各界面的完整输入／可见性闭环仍需补齐，上述入口也不保证全部 UI 控件已可操作；不在 help 中的能力不要猜命令。共享实体／展示关系继续由同一 Store owner 提供，CLI 消费它，不另建一套空间模型。

## RPC 与远程调用

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

## Answer native asynchronous questions

Read original records with `agent history --host <host-id> --session <session-id> --source native`. Question IDs are opaque Provider values; never construct them. A missing answer means unknown, not proof that the Agent is waiting. `agent question reply --input FILE|-` answers through the same public business owner; its `--help` and [public types](../../packages/core/src/public-rpc.ts) define the input and original Run condition. A trusted user or device is required; managed Agents cannot impersonate human confirmation.

A `submitted` receipt confirms ordinary input submission. Read native history by the exact question ID to observe the answer. A changed source, Run or operation rejects only that input; the original Agent and ordinary manual input remain available. When a receipt is lost or the outcome is unknown, keep the original operation ID and inspect original session records before deciding; do not blindly resend. Synchronous permissions and Hook waiting retain their existing interaction response entry.
