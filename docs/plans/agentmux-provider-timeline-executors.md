# Provider、执行器与 Activity 视图

## 我们要解决什么

现在一个 Provider 只能对应一份启动配置。比如 Codex 只能配置一条命令，首屏也只能显示一个 Codex。

实际使用中，同一个 Provider 经常需要几种不同的启动方式。例如：

- 一个 Codex 使用默认参数；
- 一个 Codex 默认开启更高权限；
- 一个 Codex 使用不同模型或环境变量。

这些启动方式看起来是不同的 Agent，但底层仍然都属于 Codex Provider。它们应该继续复用 Codex 的 Resume、Session 识别、Prompt 输入、Hooks、权限和其他特殊处理。

我们还需要把同一个 Agent Session 的结构化活动独立展示。Terminal 和 Activity 只是同一个 Session 的两种视图，切换视图不能创建新的 Agent，也不能改变 Session 身份。

## 三个对象

### Provider

Provider 是代码里的适配器。它知道某一类 Agent 的协议和行为，例如：

- 怎么启动和恢复；
- 怎么发送 Prompt；
- 怎么识别原生 Session；
- 怎么处理 Hooks、权限和结构化事件；
- 支持哪些能力。

Provider 不是首屏上的启动项，也不保存用户的具体命令配置。

### 执行器

执行器是用户可以配置和选择的具体启动项。每个执行器必须选择一个 Provider，并保存：

- 名称；
- Provider；
- 命令；
- 参数；
- 环境变量；
- 是否注入 AgentMux 操作指南。

同一个 Provider 可以有任意多个执行器。首屏展示执行器，Provider 只作为执行器的类型和能力来源。

执行器 ID 和 Provider 的绑定属于身份。已经保存的执行器不能在原来的 ID 上改成另一个 Provider；想换 Provider，就新建一个执行器。名称、命令、参数和环境变量仍然可以修改。

### Agent Session

Agent Session 是一次持续的 Agent 上下文。它同时记住：

- `providerId`：应该使用哪套 Agent 行为；
- `executorId`：这次 Session 来自哪份启动配置。

Resume、后续 Fork、Session 展示和注入能力都先找到执行器，再沿它绑定的 Provider 执行。删除或修改执行器不会把 Session 伪装成另一个 Provider。

Resume 前必须确认执行器当前绑定的 Provider 和 Session 里保存的 `providerId` 一致。不一致就明确失败，不能拿旧 Provider 的恢复规则去启动另一个 Provider 的命令。

## 首屏和设置

- 首屏列出可用执行器，而不是为每个 Provider 固定显示一个 Agent。
- 每个执行器显示自己的名称，同时用小字和图标说明它属于哪个 Provider。
- 设置页可以新增、编辑和删除执行器。
- 新建执行器时必须选择 Provider。
- 检测安装状态时，检查执行器自己的命令，同时使用它所选 Provider 的能力定义。
- 默认配置仍提供一组开箱即用的执行器，但它们和用户新增的执行器使用同一数据模型。

不保留旧的 `agents` 配置结构，不写 migration、兼容读取或 fallback。

## Session Activity

Core 维护统一的 Session Timeline。Provider 把自己的原生事件转换成统一条目，Desktop 只负责展示，不判断当前是 Codex、Claude 还是其他 Provider。

这里的 Activity 只表示 Agent Session Timeline 的产品投影，不表示 Agent-to-Agent Conversation、Discussion 或 Inbox。代码、状态和 UI 一律使用 `activity`；过时的 `conversation` 命名直接删除，不保留 alias、migration 或 fallback。

第一版统一条目覆盖：

- 用户消息；
- Agent 回复；
- 工具调用；
- 权限请求；
- 生命周期事件。

Provider 能提供结构化增量时，Core 按同一个消息身份发布增量，Activity 在原位置流式更新。Provider 只能提供完整 Hook 或完整 Transcript 条目时，就按完整条目展示，不假装支持 Token 级流式输出。

不能解析 ANSI 或 Terminal 画面来伪造对话。没有结构化来源的 Provider 应明确显示 Activity 能力不可用，Terminal 仍然正常工作。

每个 Session 的 Timeline 单独持久化，并带一个只会递增的 revision。Core 先保存，再发布带 revision 的事件；snapshot 和新建 Session 的返回结果也带当前 revision。这样应用启动、重启或 Agent 刚创建时，即使 snapshot 和流式事件交错，Activity 也能知道哪些已经包含、哪些还没收到，不会重复拼接或静默丢失。发现 revision 中间断档时，应重新读取 Core snapshot，不能猜着补。

## 分层

```text
Provider 原生协议、Hook 或 Transcript
                  ↓
          Provider Driver
                  ↓
       Core Session Timeline
                  ↓
        Desktop Activity View
```

- `packages/core` 拥有 Provider、执行器公共类型、Session Timeline 和事件合同。
- Core Store 是 Timeline revision 的唯一分配者；Hook、ACP、Desktop 和 Renderer 都不能自己编 revision。
- Desktop 配置保存具体执行器，并在启动时把执行器身份和配置传给 Core。
- Desktop main 只把 Core 的 Session 和 Timeline 投影给 Renderer；启动结果和全量 snapshot 使用同一套 Timeline 基线。
- Desktop Renderer 不包含 Provider 特例，也不解析 Terminal 输出，只按 Core revision 合并 snapshot 和增量。
- ctxmux 继续只拥有 Run、PTY、进程和字节流，不拥有 Agent Timeline。

## 第一轮不做什么

- 不实现新的 Fork 交互；本轮只保证 Session 保存执行器和 Provider 身份，后续 Fork 可以复用。
- 不为了所有 Provider 一次做完而拆掉现有可用 Terminal。
- 不引入第二套 Agent Runtime。
- 不增加 Provider 插件系统或多余配置层。
- 不把推理私有内容当作可展示的 Activity。

## 验收

1. Core 的 Provider 注册和 Session 公共类型不再把 Provider 身份叫作具体 Agent。
2. 同一个 Provider 可以配置两个不同执行器，并分别从首屏启动。
3. 新 Session 同时保存 `providerId` 和 `executorId`；Resume 继续走对应 Provider 和执行器配置。
4. Activity 消费统一 Timeline，同一个消息的增量在原位置更新，不生成一串重复卡片。
5. Desktop 中没有按 Provider 名称分支解析 Activity。
6. 应用启动、重启和新建 Agent 时，snapshot 与流式事件交错也不会丢消息、重复消息或重复拼接内容。
7. 已有执行器不能原位改绑 Provider；Resume 遇到 Provider 不一致时明确失败。
8. 没有旧配置兼容层、migration、Terminal 解析或隐藏 fallback。
