# AgentMux：按对象操作桌面

先用 `agentmux --skill` 看当前公开合同，具体命令用 `--help`。这些命令操作同一套桌面 owner；Core 提供通用 Session 与 Run API，桌面负责显示名称、空间关系与导航；Run 的进程事实由 ctxmux 持有。

Space 是组织工作面的空间，Project 是仓库／目录归属；两者不等同。Zone 可以关联 worktree、普通目录或 Topic/Mote 工作面。Tab 是完整工作面，Region 是其中一格。Session 回答“哪个 Agent”，它可以有多个展示位置。ID 原样使用，不从名称、当前目录或第一处展示位置猜身份。

## 给新 Agent 第一份任务

先发现 Executor 与空间：

```sh
agentmux list agents
agentmux space ls
```

以下是需替换 ID／路径的模板。在已有 Zone 开第一张或新 Tab：

```sh
agentmux agent open --executor '<executor-id>' --zone '<zone-id>' --new-tab --prompt '完成这份任务'
```

在明确 Space 创建 Git Zone，并直接拉起 Agent：

```sh
agentmux agent open --executor '<executor-id>' --space '<space-id>' --new-zone --worktree --new-branch feat/task --path /absolute/worktree --prompt '完成这份任务'
```

非 Git 来源使用 `--new-zone --directory /absolute/existing-directory`。存在多个绑定／展示位置时，需要从 `space ls` 取得准确的 `--space`、`--display-workspace`、`--group`，不能猜第一项。后台打开是默认行为，`--focus` 才导航过去。

最终 JSON 的 `result.agent.agentSessionId` 是新 Session 号，`result.to` 是已确认的位置。失败后分别看 `resource`、`agent`、`to`、`issues` 和 `save`，它们说明目录、Session 和工作面走到了哪一步；非零退出不代表全部没创建。失败不会自动删除已生成的 worktree 或停止已创建的健康 Session。回执区分初始任务交付与保存事实；`confirmed` 只证明初始任务交付协议，不能当作 Agent 已接受或完成任务。

后续任务用精确 SID：

```sh
agentmux send --to-session '<session-id>' --text '继续下一步'
agentmux inspect --session '<session-id>'
```

如果创建回执丢失，先按原请求号 `agentmux space inspect --request '<request-id>'` 对账，不能盲目重建、拉 Agent 或重发初始任务。`settings workspaces add` 仅登记已有目录，不建 Git worktree，也不拉起 Agent。

## 移动和切换位置

```sh
agentmux space mv --from-region '<region-id>' --expect-session '<session-id>' --zone '<zone-id>' --new-tab
agentmux focus --region '<region-id>'
agentmux focus --goal '<demand-id>'
agentmux inspect --client
```

移动改变空间位置，保留原 Session、Run、执行目录；`--expect-session` 防止位置内容已更换后操作另一个 Agent。源位置有歧义时，提供准确 `--from-space`／`--from-display-workspace`／`--from-group`。当前不支持移动所属 Tab 有多个 Group 展示的 Region，拒绝时保留全部引用和健康 Agent。`focus` 默认保留当前输入；明确需要把输入转给目标时才用 `--input target`。选择到目标与目标已经可见、已拿到输入，是回执里的不同事实。

`space bind|unbind` 操作 Zone／Space 关系或 Tab／display Workspace／Group 的准确展示关系。解除最后一处绑定仍保留实体与健康内容；显式 Close 是另一件事。具体参数以各命令 `--help` 为准。

## 打开文件，切换正文，交换格子

```sh
agentmux open file --zone '<zone-id>' --path 'docs/设计.md'
agentmux agent view --session '<session-id>' --mode activity
agentmux space view --region '<file-region-id>' --mode diff
agentmux space swap --region '<region-a>' --with '<region-b>'
```

文件路径相对 Zone 的真实目录。默认后台打开或复用原 File Tab；`--focus` 才导航到它，多个展示位置用准确 `--display-workspace`／`--group` 指定。目录不会顺带打开 Explorer；媒体与二进制沿原预览，书签文件按源码打开。回执分别报告 `resource`、`placement`、`data`、`navigation`、`save`。读取或导航失败后，已打开的原工作面仍保留；不能用非零退出判断“什么都没创建”，也不能在回执未知时自动重试。

`agent view` 的 `terminal|activity` 偏好属于 Session，会作用于它的全部展示位置。`space view` 的 `source|diff|preview` 偏好属于准确 File Region；同一文件的另一格可以保持自己的模式。省略 `--mode` 只读当前事实，不加载正文、保存或聚焦。File 回执的 `supportedModes` 来自实际格式和读取事实，未知时为 `null`；模式已应用和正文已读到是两件事。File 模式是临时偏好，重启后按原格式默认恢复。

`space swap` 交换同一 Tab 的两个 Region 位置，作用于这个 Tab 的全部展示位置；它保留原 Session、Run、执行目录、文档、草稿、分割比例和逻辑活动 Region。跨 Tab、正在关闭或不唯一的目标会在改动前拒绝，自己与自己交换返回 `unchanged`。这四个入口都不默认抢输入；操作完成后原输入失去资格，回执会如实返回 `partial` 和输入问题，保留已应用结果。保存回执仍不能当作磁盘确认。

## 改显示名，再读取当前值

```sh
agentmux agent rename --session '<session-id>' --name 'CLI 实现'
agentmux agent inspect --session '<session-id>'
agentmux space rename --tab '<tab-id>' --name '评审'
```

两种改名都支持 `--clear`；名称文本可以使用 `--name=--help`。改名只改桌面显示名称。保存失败会保留已应用的值，返回 `partial` 并退出非零；保存请求不代表磁盘已确认。稍后 `agent inspect` 读取的是当前桌面显示覆盖名（`override`，字符串或 `null`），不能确认早先请求的结果，也不能从 `null` 推断 Session 是否存在、退休或健康。要看 Core Session 事实，使用 `inspect --session`。

右键 Agent 名片用 SID 发送与检查；知道点击的准确 Region 时，另外给空间检查、保输入导航和需填写目标的移动模板。向 Tab 发送时按不同 SID 消歧：同一个 SID 的多个 Region 仍是一个收件人；多个不同 SID 会返回真实候选。最终 owner 发现内容已替换时拒绝原投递，不改投、重发或冒称成功。

## 桌面操作覆盖到哪

命令和参数由当前版本的 `--skill`／`--help` 提供。下表只说明入口，不能把 Source 已实现当成当前安装包已更新。

| 要做的事 | 当前入口 |
| --- | --- |
| 在指定 Space／Zone 开 Agent，交第一份任务 | `agent open` |
| 发现空间、准确查询、绑定、解绑、移动、改名 | `space ls/inspect/bind/unbind/mv/rename` |
| 导航 Space／Goal／工作面，观察选择与输入归属 | `focus`、`inspect --client` |
| 打开 Terminal／Browser，操作已开的 Browser | `open terminal/browser`、`browser` |
| 按 Zone 目录后台打开或复用文件 | `open file` |
| 读取或切换 Agent／File Region 正文模式 | `agent view`、`space view` |
| 交换同一 Tab 的两个 Region 位置 | `space swap` |
| 提升 Region 为 Tab、调整布局 | `promote`、`arrange` |
| PMO 观察、Demand 和显式 Session 关系 | `pmo`、`demand` |
| 已支持的偏好、诊断与资源观察 | `settings`、`diagnostics`、`metrics` |
| Session 消息、输出、生命周期 | `send`、`deliveries`、`dispatch`、`output`、`interrupt/resume/stop` |

“全部桌面操作”还没有完成。共享投影在各界面的完整输入／可见性闭环仍需补齐，上述入口也不保证全部 UI 控件已可操作；不在 help 中的能力不要猜命令。共享实体／展示关系继续由同一 Store owner 提供，CLI 消费它，不另建一套空间模型。
