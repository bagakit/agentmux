# ACP Provider 运行指南

### 查看与创建

在 **Settings → Agent CLIs → Providers** 中选择 Host，查看该 Host 声明的 ACP 适配能力。目录读取不会启动 CLI，也不会检测账号。需要确认原执行环境时，先从 Executors 获取准确的 Host、Runtime、Executor 和配置修订，再执行原 Workspace 的探测。

```sh
amux agent provider probe --host HOST --runtime RUNTIME --executor EXECUTOR \
  --config-revision REVISION --workspace WORKSPACE_PATH
```

Antigravity 新建 Agent 的 **Interaction** 选项提供 **Terminal** 和 **ACP**，默认是 Terminal。使用 CLI 时，将 `{"interaction":"acp"}` 作为 `agent open --launch-options` 的 JSON 输入，使用原 Executor 和明确的显示位置。用 `amux agent open --help` 查看该位置可用的参数。

### 运行与恢复

选择 ACP 启动后，沿原 Session 的输入、权限和 Activity 入口使用。首次登录前 `agent provider probe` 可以确认原可执行文件的握手能力，并另外返回会话服务的认证状态。未确认的开场消息保留原输入记录，采用后可从原操作查询回执。

会话提供模型、推理力度或模式等选项时，输入框的 **Session settings** 显示原生当前值和可选项。切换完成以原会话返回的整组配置为准。CLI 可用 `amux agent configuration inspect --host HOST --session SESSION --run RUN` 读取原选项和修订，用 `amux agent configuration set --input FILE` 提交该原 Run 的选择。回执未知时，用 `inspect --operation-id OPERATION` 查询原操作。

重开 Desktop 或 Core 时接回健康 Run。原生进程已结束时，恢复沿保存的 Session 和原生 ID，等待 `session/resume` 或已声明的 `session/load` 确认再接入后续工作。取消的终局来自原 `session/prompt` 回包。原权限请求使用它自己提供的选项和对应的原生请求 ID。

可用的原生能力取决于选定 Executor 运行的二进制与账号环境。协议定义见 [ACP v1 会话](https://agentclientprotocol.com/protocol/v1/session-setup)、[ACP v1 回合](https://agentclientprotocol.com/protocol/v1/prompt-turn)与 [ACP v1 会话选项](https://agentclientprotocol.com/protocol/v1/session-config-options)。
