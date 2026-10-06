# AgentMux：按对象操作桌面

先用 `amux --skill` 看当前公开合同，具体命令用 `--help`。命令经同一公开 JSON-RPC 服务调用各自业务 owner；Core 持有 AgentSession 语义与[持久空间图](../architecture/spatial-state.md)，Client 消费原位置，负责呈现、真实输入焦点及原宿主资源能力；Run 的进程事实由 ctxmux 持有。

CLI 的 Space 是[概念词典](../design/behavior/spaces-and-layout.md#统一概念与空间寻址)中的持久实体；Agent 空间地址使用同一实体及展示绑定。Work 下的 Space 按钮是操作这些对象的视图，不是第二种 Space。Project 是仓库／目录归属，与 Space 不等同。Zone 可以关联 worktree、普通目录或 Topic/Mote 工作面。Tab 是完整工作面，Region 是其中一格。Session 回答“哪个 Agent”，它可以有多个展示位置。ID 原样使用，不从名称、当前目录或第一处展示位置猜身份。

## 委派与打开位置的建议策略

以下是按意图选择的 playbook，不是固定方向、尺寸阈值或额外审批流程。用户已指定的机制、位置和焦点要求优先；能从任务及当前工作面判断时，简短说明选择后继续，只在会改变任务目的、执行归属或可用工作面的实质歧义上问清。

**先判断委派方式，再决定是否打开工作面。** “subagent”“另找一个 Agent”可能指当前 Provider 的原生委派，也可能指独立 AgentMux Session。当前会话内的分工、短检查通常适合原生协作；用户要直接查看或继续该协作者、指定 Executor／Host，或需要独立持续工作面时，通常适合 AgentMux Agent。已有准确 Session 能承担任务时先考虑复用。上下文继承、原生 fork 和共享文件分别核对真实能力，独立 Session 不保证空上下文，原生子 Agent 也不保证继承全部历史；给协作者提供必要的任务、事实与交付约定。机制、原身份和消息责任沿[Agent 能力与消息合同](../design/behavior/agent-capabilities-and-messaging.md)。

**Agent 与文件都按用途选择展示位置。** 先从自己的准确位置及目标 Tab 观察现有内容、布局与展示绑定；文件还需确认所属 Zone 和原路径，Agent 的执行 Workspace 不从展示位置推断。需要同时对照的 Agent、源码、文档或预览，优先考虑在同一 Tab 分屏；长文、宽 diff、独立任务或继续分割会使已有内容难读时，考虑新 Tab。已有合适的展示可复用，不为“打开”重复创建 Session 或文件身份。

**分屏看整张 Tab，不机械地选右边。** 左右适合并排对照，前提是两侧保有可读列宽；上下可保较大宽度，但也会减少可读行数。结合内容用途、当前分割、阅读高度、主要动作及已有工作的可用性，选择准确锚点 Region 与方向，少动无关内容；不靠缩小文字、挤窄多个格或反复整理版面维持分屏。读到的方向邻居可能是 Region，也可能是 Tab，须先区分，再调用对应操作。可辨与密度沿[空间呈现合同](../design/presentation/spaces-and-layout.md#agent-空间与身份呈现)。

**新 Tab 考虑相关性和实际顺序。** 相关展示通常留在同一合适的 Group，位置若能紧邻自己的 Tab，会更容易来回核对；独立用途也可另作组织。内容与执行归属保持原 Zone／Workspace，不为 Tab 邻近搬目录或复制文件。先核对实际 Tab 顺序与当前操作能力，不能把 `--new-tab` 当作“插在我旁边”的承诺，也不猜插入或排序参数；Tab 条上相邻与屏幕分栏是两种位置。若明确需要来源 Tab 紧后方、当前展示与原 owner 的单一 Group 一致，可考虑分屏后将已确认的新 Region `promote` 为 Tab；这会短暂改变布局并激活新 Tab，不作常规默认，也不自动搬走已复用的旧 File Region。多投影时不能借此保证指定 occurrence 的相邻位置。开启或受支持的调整后回读真实顺序，说明实际落点。空间身份、排序与展示归属沿[空间行为合同](../design/behavior/spaces-and-layout.md#tab-group-与分屏布局)。

**按用户目的处理焦点，并确认结果。** 后台分工或准备文件通常保持原导航与输入；用户要看新内容时才选择相应导航动作，导航与取得输入焦点分别核对。开启后使用返回的准确 Session／File Region 和展示位置确认身份、落点及可读性，简短报告“哪个 Tab／哪一格”；新格身份不是锚点 Region 身份。回执未知保留原 operation：Agent 核原创建记录，File 查原资源与实际 File Region；缺失的原回执仍是未知，不能以今天的展示代签先前提交。保原工作面与健康 Run，不重建另一个 Agent 来补失联回执。

## 给新 Agent 第一份任务

先发现 Executor 与空间：

```sh
amux settings executors ls
amux app snapshot
amux space ls
```

以下是需替换 ID／路径的模板。在已有 Zone 开第一张或新 Tab：

```sh
amux agent open --executor '<executor-id>' --zone '<zone-id>' --new-tab --prompt '完成这份任务'
```

明确选择 Project 资源与 Space 落点，创建 Git Zone，并直接拉起 Agent：

```sh
amux agent open --executor '<executor-id>' --project '<project-id>' --space '<space-id>' --new-zone --worktree --new-branch feat/task --path "$WORKTREE_PATH" --prompt '完成这份任务'
```

新 Zone 必须指定资源 `--project`；Project 多个来源且没有唯一根目录时，用 `--source-workspace` 选择精确来源，不从当前目录或第一个 worktree 猜起点。非 Git 来源使用 `--new-zone --directory "$EXISTING_DIRECTORY"`。存在多个绑定／展示位置时，需要从 `space ls` 取得准确的 `--space`、`--display-workspace`、`--group`，不能猜第一项。后台打开是默认行为，`--focus` 才导航过去。

最终 JSON 的 `result.agent.agentSessionId` 是新 Session 号，`result.to` 是已确认的位置。失败后分别看 `resource`、`agent`、`to`、`issues` 和 `save`，它们说明目录、Session 和工作面走到了哪一步；非零退出不代表全部没创建。失败不会自动删除已生成的 worktree 或停止已创建的健康 Session。回执区分初始任务交付与保存事实；`confirmed` 只证明初始任务交付协议，不能当作 Agent 已接受或完成任务。

后续任务用精确 SID：

```sh
amux agent send --to-session '<session-id>' --text '继续下一步'
amux agent inspect --session '<session-id>'
```

如果创建回执丢失，先按原 `--operation-id` 业务操作号 `amux space inspect --operation-id '<operation-id>'` 对账，不能盲目重建、拉 Agent 或重发初始任务。`settings workspaces register` 仅登记已有目录，不建 Git worktree，也不拉起 Agent。

## 移动和切换位置

```sh
amux space mv --from-region '<region-id>' --expect-session '<session-id>' --zone '<zone-id>' --new-tab
amux space focus --region '<region-id>'
amux space focus --region '<region-id>' --expect-session '<session-id>'
amux goal focus --goal '<goal-id>'
amux app inspect
```

移动改变空间位置，保留原 Session、Run、执行目录；`--expect-session` 防止位置内容已更换后操作另一个 Agent。源位置有歧义时，提供准确 `--from-space`／`--from-display-workspace`／`--from-group`。当前不支持移动所属 Tab 有多个 Group 展示的 Region，拒绝时保留全部引用和健康 Agent。`focus --expect-session` 在准确 Region 上核对原 SID，并在回执 `navigation.expectedAgentSessionId` 保留条件；已更换的对象只拒绝本次导航。`focus` 默认保留当前输入；明确需要把输入转给目标时才用 `--input target`。选择到目标与目标已经可见、已拿到输入，是回执里的不同事实。

`space bind|unbind` 操作 Zone／Space 关系或 Tab／display Workspace／Group 的准确展示关系。解除最后一处绑定仍保留实体与健康内容；显式 Close 是另一件事。具体参数以各命令 `--help` 为准。

提交已编辑的完整空间图解散项目组时，先用 `space state` 读取原图与准确 revision。将本次确认解散的原 `groupId` 填入 `removed.json`，内容例如：

```json
["<exact-group-id>"]
```

以原组的精确 ID 替换占位符，不从名称猜 ID。`removed.json` 是精确组 ID JSON 数组；`--removed-project-groups` 只接受文件路径，不能用 `-`，完整 `graph.json` 仍由 stdin 传入。

```sh
amux space commit --revision N --removed-project-groups removed.json < graph.json
```

仅在新图中省略组不构成解散授权。按 [Core 项目组删除意图](../design/behavior/spaces-and-layout.md#跨设备关联项目组)与 [`AgentMuxSpatialCommit`](../../packages/core/src/spatial-graph.ts)，仅移除本次组的组织关系，保留其他组及原 Space／Zone／Tab／Region、Session 与 Run；该示例不请求实体删除。

## 打开文件，切换正文，交换格子

```sh
amux file open --zone '<zone-id>' --path 'docs/设计.md'
amux agent view --session '<session-id>' --mode activity
amux file view --region '<file-region-id>' --mode diff
amux space swap --region '<region-a>' --with '<region-b>'
```

文件路径相对 Zone 的真实目录。默认后台打开或复用原 File Tab；`--focus` 才导航到它，多个展示位置用准确 `--display-workspace`／`--group` 指定。目录不会顺带打开 Explorer；媒体与二进制沿原预览，书签文件按源码打开。回执分别报告 `resource`、`placement`、`data`、`navigation`、`save`。读取或导航失败后，已打开的原工作面仍保留；不能用非零退出判断“什么都没创建”，也不能在回执未知时自动重试。

`agent view` 的 `terminal|activity` 偏好属于 Session，会作用于它的全部展示位置。`file view` 的 `source|diff|preview` 偏好属于准确 File Region；同一文件的另一格可以保持自己的模式。省略 `--mode` 只读当前事实，不加载正文、保存或聚焦。File 回执的 `supportedModes` 来自实际格式和读取事实，未知时为 `null`；模式已应用和正文已读到是两件事。File 模式是临时偏好，重启后按原格式默认恢复。

`space swap` 交换同一 Tab 的两个 Region 位置，作用于这个 Tab 的全部展示位置；它保留原 Session、Run、执行目录、文档、草稿、分割比例和逻辑活动 Region。跨 Tab、正在关闭或不唯一的目标会在改动前拒绝，自己与自己交换返回 `unchanged`。这四个入口都不默认抢输入；操作完成后原输入失去资格，回执会如实返回 `partial` 和输入问题，保留已应用结果。保存请求不等于落盘；只有原 Core 持久空间 owner 返回的 `save.diskDurability` 为 `confirmed` 才是耐久确认，`unconfirmed` 保留已应用结果、未保存改动与健康 Agent。

读取已经保存的原文件，不打开 Tab 或读取编辑器中的未保存草稿：

```sh
amux file read --zone '<zone-id>' --path 'saved.md' --host '<host-id>' --workspace '<resource-workspace-id>' --workspace-path "$RESOURCE_DIRECTORY"
```

先从 `space ls`／`space inspect` 的原 Zone 资源确认 Host、Workspace 与目录；这些是文件资源，不是当前显示 Workspace。`--path` 相对该 Zone；可加 `--space` 核对原绑定，多处合法绑定不会改变文件身份。结果的 `resource` 与 `result` 分别表达准确来源和原 Files 的读取事实：文本保留完整 `sha256` revision，二进制、已删除、目录和原错误保持原状态。`unknown` 表示这次观察未确认，保留原引用并重新发现／读取；不解释为文件已删除，也不影响原文件编辑或健康 Agent。

保存已经读过的原文本文件，正文从 stdin 原样输入：

```sh
amux file write --zone '<zone-id>' --path 'saved.md' --resource '<原 file read 回执的完整 resource JSON>' --expected-revision 'sha256:<完整原修订>' < draft.md
```

它委托原 Files 的 revision-aware 保存，不创建新文件或新 Note 身份。`written` 返回新修订，`conflict` 保留观察到的修订；`error` 与 `unknown` 不冒保存成功。未知回执先读取同一资源核对，保留草稿，不自动重复写入。

日历提醒使用显式 JSON，沿原 Session／调度 owner 执行：

```sh
amux schedule list
amux schedule inspect --data request.json
amux schedule create --data request.json
amux schedule pause --data request.json
amux schedule resume --data request.json
amux schedule cancel --data request.json
```

`--data` 接受文件或 `-` 标准输入。创建包含 `target: {hostId, agentSessionId, providerId, workspacePath}`、非空 `prompt`、`operationId` 和 `calendar`。日历显式给出 IANA `timezone`、本地 `time`、`kind`（`once|daily|weekly|monthly|yearly`）及 `policies: {gap:'skip', fold:'earlier'|'later', monthEnd:'clamp', overdue:'latest'}`；各周期的日期字段以公共类型为准。检查在 `scheduleId` 与原 `operationId` 中选一个；暂停／恢复／取消包含 `scheduleId`、已读 `expectedRevision` 与本次 `operationId`。每次变更核真实 caller，不允许用 timer 冒人类作者。未知回执先检查原 operation；不自动重发。保存不等于已投递，投递不等于 Agent 完成；断开宿主时不会假装仍在云端执行。

用户可在同一创建 JSON 中显式加入 `checkIn: {silenceMs:64800000, minIntervalMs:72000000, dailyBudget:1, quiet:{start:'<quiet-start-HH:mm>', end:'<quiet-end-HH:mm>'}}` 开启安静跟进；其中安静时段的两个占位符须替换为实际策略时刻，JSON 文件需使用双引号。省略即关闭，已鉴权 Agent 不能开启。两个间隔可明确设置为 5 分钟至 30 天，预算为每个保存时区的日历日 1–3 次；安静时段使用该时区的 `HH:mm`，开始与结束须不同。`inspect` 显示保存策略、已认领预算、未答状态与未知原因，暂停／继续／取消仍用上面的原操作。跟进要求可确认的本会话人工上下文；较晚未知输入或当前来源未确认时保原到期安排。问候内容由真实 Agent 依据保存主题生成，不能把 timer、Native 文本或 Agent 消息当人类答复。

## 按已读版本改显示名

先读取准确对象的名称版本。Agent 使用 `agent inspect` 的 `displayName.nameRevision`；Tab 使用 `space inspect` 中该 Tab 的 `nameRevision`。只有版本已观察且为有效整数时才提交，不能猜零或从另一对象复用版本。

```sh
amux agent inspect --session '<session-id>'
amux agent rename --session '<session-id>' --name-revision N --name 'CLI 实现'
amux space inspect --tab '<tab-id>'
amux space rename --tab '<tab-id>' --name-revision M --name '评审'
```

`N` 与 `M` 分别替换为同一目标刚读到的名称版本。版本冲突时重新读取目标并由调用者确认新意图，不自动覆盖并发改名。准确参数与版本校验归[CLI parser](../../packages/core/src/agentmux-cli-commands.ts)和[空间状态名称 owner](../../packages/core/src/spatial-state.ts)。

两种改名都支持 `--clear`，清空同样需要原名称版本；名称文本可以使用 `--name=--help`。改名只改显示名称，不改变实体身份。保存失败保留已应用值，返回 `partial` 并退出非零；保存请求不代表磁盘已确认。后续读取分别报告 Core Session 与显示事实；覆盖名不能确认早先请求结果，覆盖名 `null` 不说明 Session 存在、退休或健康。客户端不可用时仍保留能读取到的 Core 事实。

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
| 人工待发消息与准备退避 | `message pending ls/edit/send/stop/archive/restore` |
| Session 消息、输出、生命周期 | `agent send/output/interrupt/resume/stop`、`message inbox/dispatch` |

表中入口的能力边界与接线见[公共能力来源导航](../specs/public-capabilities.md#cli-与服务的当前来源)及[公共控制合同](../design/behavior/public-control.md#对象优先-cli-与统一公共业务服务)。源码、构建、安装与实际运行分别核对；入口清单不代签具体 UI 控件的可操作性，不在当前执行版本 help 中的能力不要猜命令。

共享实体与展示关系由 Core 的同一持久空间 owner 提供；Desktop Store 消费并投影这些事实，CLI 接入同一公共服务，不另建一套空间模型。

## 查看消息等待，停止本条退避

Message Tool 的待发意图由原 Client owner 持有。先按原 Session 读取 `pendingId` 和等待进度，再停止这一条正在退避的消息：

```sh
amux message pending ls --session '<session-id>'
amux message pending stop --session '<session-id>' --pending-id '<pending-id>'
```

`stop` 经公开 `message.pending.stop` 调用与界面「停止等待」相同的 owner，只结束本条自动准备退避；原文、操作号、目标 Run 和手动发送入口保留。回执的 `preparationWait.state: "stopped"` 与 `changed` 说明等待事实，不表示撤回已写入输入或停止 Agent。没有活跃退避、目标不存在或已进入提交时，拒绝这一次停止，保留消息、原会话与终端；对已停止的原记录再次调用返回 `changed: false`。修改、发送和停止人工待发意图需要服务认证的 user／device，managed Agent 不能借此操作人工草稿。具体参数与当前执行版本的 `--help`／`--skill` 保持一致。

当 `pending.send` 返回 `AGENT_PROMPT_CONDITION_CHANGED`，原发送条件已经变化；本次调用未写入输入，不代表原消息此前一定未投递。先用 `message pending ls --session <id>` 与原对话核对全文及投递记录。可用 `message pending archive --session <id> --pending-id <id> --expected-text '<完整原文>'` 保留原记录并退出 Pending；归档不会撤回输入。之后明确编写新消息时使用普通 `agent send`，不要复用旧 operation/message identity。Desktop 的「移至草稿」会将正文追加到同 Session 的已有草稿并归档原条目，等待下一次明确发送。

## RPC 与远程调用

Endpoint、Host 路由与源身份的行为边界见[公共控制合同](../design/behavior/public-control.md#endpointhost-路由与源身份)；下文按直接连接服务与经配置 Host 两种任务入口操作，准确参数以当前 `--help`／`--skill` 为准。

命令只负责参数与回执，业务都通过同一 typed JSON-RPC 2.0 服务。Unix 与 SSH 使用逐行 JSON；HTTP 持续观察使用 SSE。`system endpoint` 给出当前选择的 endpoint 与 `connection: "not-attempted"`，不连接、不创建服务，也不证明机器可达或 Agent 健康。`system endpoint --inspect` 经原服务只读查询入口发布状态；RPC 回执的 `connection: "responded"` 只证明本次响应，`publication` 描述该语义 owner 的入口，未注入入口观测时为 `null`。入口发布失败与 Run 状态分别核对；已有连接仍可工作时，原 owner 自动重试发布并保留最初故障及当前重试诊断，不重放业务输入。

```sh
amux system endpoint
amux system endpoint --inspect
amux --endpoint "unix:$CONTROL_SOCKET" agent ls
amux --endpoint 'http://127.0.0.1:8787/' app snapshot
amux --endpoint 'ssh://user@host/' app inspect
```

HTTP 服务默认关闭，宿主必须显式配置监听地址与授权 token；HTTP client 从 `AGENTMUX_RPC_HTTP_TOKEN` 取得 token。Agent 的 Session capability 仍在同一服务里验证。SSH 需要远端已有服务和 `amux` 可执行文件；远端 `system endpoint --stdio` 只做转发。SSH endpoint 可以通过 `socket` 或 `command` 查询参数选择远端 socket 或可执行文件，值按 URI 编码。

`--endpoint` 选择公共服务；命令支持的 `--host` 选择该服务认识的 Host 路由 ID，不是 SSH 地址。`local` 指接收业务调用的 Core 服务本机，直接连接远端时不指 CLI 所在机器。`agent ls` 每个观察及 `agent inspect` 返回 `routeHostId`，原 `session.hostId` 保留；用发现出的路由 ID 继续 `agent context --host`，其 `sourceHostId` 与 descriptor 保留源服务身份。发现和后续操作须使用同一 endpoint，Host ID 不能跨 endpoint 当作全局机器身份。`settings hosts ls` 是配置发现，不代表已连接。

```sh
# Direct service: local is the remote Core service's machine.
amux --endpoint 'ssh://user@build-node/' agent ls
amux --endpoint 'ssh://user@build-node/' agent context --host local --session SID
# Via the default service: use its discovered routeHostId, such as build-host.
amux agent ls
amux agent context --host build-host --session SID
```

Project／Zone 的真实资源决定 `agent open` 的执行机器；展示 Space 或 Region 不改变已有 Session 的 Host／cwd。未知 Host、Session 未发现、owner 歧义与服务不可达保留各自错误，不自动选择首项或重路由。

订阅取消只释放该 reader，保留原 Agent/Run。持续输出携带完整帧、原始 bytes 的 base64 与 cursor；丢失回执后读原操作号，不盲目再发送首任务。

Prompt 的原 operation 若已由 Core 确认整条输入完全未应用，同 ID 不再重新执行，原拒绝与 Session 事实仍可查询。直接 SDK Prompt 恢复返回稳定 `not_applied`；`agent.send` RPC／CLI 仍沿原消息回执及查询合同报告，不能用其单次错误码代替整操作事实。下一次明确发送原拒绝消息使用新的 operation／message ID，沿当前条件建立新意图；原 unknown／partial 仍恢复原请求。公共事实及 SDK 判定见[Core Prompt 合同](../../packages/core/README.md#agent-调用与输入)。

## 回答当前同步问题与权限请求

`amux agent inspect --session '<session-id>'` 读取原 Session 的 typed pending request。将该请求的完整内容保存为 `expectedRequest`，连同 `agentSessionId`、`expectedRun`、稳定 `operationId` 与 typed `response` 一起交给：

```sh
amux agent interaction respond --input response.json
amux agent interaction inspect --session '<session-id>' --operation-id '<operation-id>'
```

响应需要传输批准的 user／device；managed Agent 不能借这个入口替人确认。回执丢失后先查询同一 operationId，问题完成或 Run 更换后仍可查原结果。保存、字节接受、Hook 写入与原生完成各有含义，不能据传输成功宣称工具获准、任务完成或 Native 已采用答案。查询没有输入副作用；用户明确重试同一操作时保留原 request、Run、operationId 和答案，沿原 recoverable Input join，仍核对真实目标资格。unknown 不授权自动重放或换 ID，原终端继续可用。

## Answer native asynchronous questions

Read original records with `agent history --host <host-id> --session <session-id> --source native`. Question IDs are opaque Provider values; never construct them. A missing answer means unknown, not proof that the Agent is waiting. `agent question reply --input FILE|-` answers through the same public business owner; its `--help` and [public types](../../packages/core/src/public-rpc.ts) define the input and original Run condition. A trusted user or device is required; managed Agents cannot impersonate human confirmation.

A `submitted` receipt confirms ordinary input submission. Read native history by the exact question ID to observe the answer. A changed source, Run or operation rejects only that input; the original Agent and ordinary manual input remain available. When a receipt is lost or the outcome is unknown, keep the original operation ID and inspect original session records before deciding; do not blindly resend. Synchronous permissions and Hook waiting retain their existing interaction response entry.

## 创建 Goal、打开原讨论与人认可

新建先持有准确 Goal ID，明确保存一个待定义目标，再打开同一 Goal 在原主 Mote 的专属 Tab。省略 `--project` 表示未分配，不代替 Goal 定义或开始执行：

```sh
amux goal create --goal '<held-goal-id>' --title 'Untitled goal' --risk low --confirm user --operation-id '<create-operation-id>'
amux goal inspect --goal '<held-goal-id>'
amux goal discuss --goal '<held-goal-id>' --mode open --operation-id '<discussion-operation-id>'
```

创建回执未知时先 inspect 这个准确 ID；不能按标题猜实例或另建 Goal。讨论的 `open|grill|grounding` 复用原 PMO 工作面与输入 owner；Tab、导航或队列回执不证明 Prompt 已应用、接受或完成。已保存但讨论失败的 Goal 保留，只明确重开同一个 Goal。

确认提案与接受结果仅允许经运输层认证的人或设备。先读当前内容，再使用原版本与准确提交 ID：

```sh
amux goal confirm --goal '<goal-id>' --revision 3 --operation-id '<human-confirm-operation-id>'
amux goal accept --goal '<goal-id>' --revision 3 --submission '<submission-id>' --operation-id '<human-accept-operation-id>'
```

接受报告中的差距须明确加 `--accept-gaps`；原差距不会被抹掉。Agent 可以讨论、提出提案和报告，不能凭业务字段自称人来确认或接受。认可回执未知时保留准确意图，先读取原 Goal 当前事实，不能自动重复提交。完整行为见 [Goals 与 Demand](../design/behavior/goals-and-demand.md)。
