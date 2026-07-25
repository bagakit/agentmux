# AgentMux mux Runtime 架构决策

状态：已接受

## 1. 决策

AgentMux 采用可嵌入架构，`ctxmux` 是最终唯一通用 Run Kernel。AgentMux 不再自行拥有 PTY daemon、Run wire、Replay、Journal、Backpressure 或进程树清理。

```text
Desktop / CLI / external Node consumer
                  │
                  ▼
          @agentmux/core public API
 Provider / AgentSession / ACP / Hook / Permission / Resume
                  │
                  ▼
             CtxmuxRunAdapter
                  │
                  ▼
          @ctxmux/sdk -> ctxmuxd
 Run / PTY / Process / ordered I/O / replay / stop
```

生产链路不包含自建 Run Kernel、旧 Local/SSH Run paths 或 `node-pty` Owner。Local Terminal
与 Agent Provider 只经过固定 CtxMux public contract；AgentMux 独立拥有 Provider、Hook、
Agent Session、Resume、Prompt readiness 与身份解析。Remote 在公共合同完成前明确
unsupported。

最终产品不保留 tmux、自建 agentmuxd、Main-owned PTY 或 Hybrid Runtime 作为兼容层、Fallback、Migration 或可选 Backend。

这项选择不把 ctxmux 变成 AgentMux 的内部服务。ctxmux 的 daemon、CLI、协议与 SDK
独立发布、独立使用并独立通过完整 Run 生命周期验收；AgentMux 只是其中一个高级 Client。
AgentMux 当前固定并随包携带 ctxmux artifact，是供应链和 endpoint policy，不改变依赖方向。

边界判断固定为：对 shell、server、test、script 和 Agent 都成立，并且只能由 PTY、
process、Backend 或 daemon owner 证明的事实属于 ctxmux；必须理解 Provider、AgentSession、
Permission、消息、任务或 UI 才成立的判断属于 AgentMux 或 Desktop。

## 2. 为什么选择 ctxmux

AgentMux 的核心价值是统一 Agent 语义，而不是再造通用 mux 基建：

- Provider、ACP、Hook、Permission、Evidence 与 provider-native Resume 是 Agent-specific；
- PTY、Process、ordered bytes、Replay、Gap、Backpressure、Attach/Detach、Resize 与 Stop 是通用 Run Kernel 能力；
- Desktop、CLI 或另一个宿主不应分别重写两类能力；
- AgentMux 自建 daemon 会与 ctxmux 重复所有复杂、高风险、平台相关的 Run Owner 工作；
- ctxmux 缺少某项硬能力时应形成明确外部 Gap，不应成为 AgentMux 私有 fallback 的理由。

## 3. 候选比较

| 候选 | 进程与持久化 | 优点 | 长期问题 | 结论 |
| --- | --- | --- | --- | --- |
| 真实 tmux | tmux Server 持有 | Local/SSH 成熟、退出后继续 | command-per-input、snapshot polling、tmux 语义泄漏 | 不选 |
| Main-owned `node-pty` | Electron Main 持有 | 本地流式简单 | App 退出即丢失，无法满足恢复 | 不选 |
| AgentMux 自建 daemon | AgentMux 持有全部 Run 基建 | 曾形成可运行原型和大量测试 | 重复 ctxmux，协议/安全/发布/跨平台/资源 Owner 全部自担 | 已删除 |
| `ctxmux` Run Kernel | ctxmuxd 持有通用 Run | 复用专门 Owner，AgentMux 聚焦 Agent 语义 | 接入取决于公开 SDK、版本和能力 Gate | **唯一目标** |
| 长期 Hybrid | 多 Owner | 看似可绕过缺口 | 两套真相、测试和恢复组合数长期翻倍 | 禁止 |

## 4. 所有权边界

| 能力 | AgentMux | ctxmux | Desktop / Client |
| --- | --- | --- | --- |
| Provider Catalog、Launch、Prompt Strategy | 权威 | 不感知 Agent | 提交意图、展示能力 |
| AgentSession、ACP、Hook、Permission、Resume、Evidence | 权威 | 只承载关联所需 Run identity | 展示并显式响应 |
| Run、PTY、Process、真实运行状态 | 引用和投影 | 权威 | 不直接 Spawn/Kill |
| Ordered I/O、Sequence、Replay、Gap、Backpressure | 映射为 AgentMux Run fact | 权威 | 按 Attachment/Cursor 消费 |
| Attach/Detach、Resize、Signal、Stop | 通过 Adapter 请求 | 执行和确认 | 只调用公共 API |
| Workspace、Editor、Board、Pane、Tab、Browser、Git | 只关联必要上下文 | 不拥有 | Desktop Host 权威 |

`packages/core` 不依赖 Electron、React、Desktop Store、ctxmux 私有模块或 ctxmux wire 类型。`CtxmuxRunAdapter` 是唯一项目自有 mux 边界，不演化成 Backend Registry。

## 5. 对象模型

- `Run`：ctxmux 持有的物理进程和终端事实；
- `AgentSession`：AgentMux 持有的 Provider/模型语义和 native resume identity；
- `Attachment`：一个 Client 对 Run output/control 的有界订阅；
- `View`：Desktop Pane/Tab 对 Run 或 AgentSession 的产品投影。

Reattach 原 Run、provider-native resume、Spawn 新 Run、创建新 AgentSession 和打开新 View 是不同动作。Terminal Output、Process Liveness 与 Agent Evidence 保持来源差异；PTY 可证明“进程输出了什么”，不能证明 Tool、Permission、Reply、模型私有 Chain-of-thought 或模型上下文连续。

## 6. Local、Remote 与恢复

Local 只使用 ctxmux。Remote/SSH 必须通过同一 AgentMux Run 合同恢复，只替换 ctxmux 的
连接与显式部署方式：

- Desktop 完全退出、Renderer/Main 崩溃后，仍在运行的 Run 继续；重开只 Attach；
- SSH 网络中断只结束 Transport/Attachment，不自动结束远端 Run；
- 丢失 Create Response 不能重复 Spawn；CtxMux RunId 永不复用，新物理进程必须有新的 RunId；
- Replay 窗口外明确报告 Gap/Truncated，不能把残缺历史伪装成完整屏幕；
- 只有 ACP handle 或 provider-native resume 能证明 AgentSession 上下文连续；
- 系统 SSH 与用户现有认证保持权威，不复制 Private Key、不静默下载或安装、不开放未授权监听端口。

Remote 支持完成前返回 typed unsupported，不回退自建实现。具体 process tree、Remote
artifact、capability negotiation 与资源边界由 ctxmux 公共合同和 Conformance Kit 验证。

## 7. 交付规则

- AgentMux 可以独立完成 Provider、AgentSession、Hook、Permission、Composition 与 Client
  投影；缺少的通用 Run 能力直接在 ctxmux 公共边界补齐。
- Local 始终只经过一个 `CtxmuxRunAdapter`，不引入第二个 Owner 或临时 fallback。
- 每个可发布候选都通过 Package、Security、Chaos、Resource、Benchmark 与独立 Review。
- Remote 作为独立能力通过 ctxmux 公共合同加入，不复活旧 SSH Run path。

## 8. 验收条件

- 仓库中只剩 ctxmux 一个 Run Kernel，没有 tmux/agentmuxd 生产路径或双 Owner；
- AgentMux 公共 API 不泄漏 ctxmux、自建 daemon 或 Electron wire；
- 五个 Provider、ACP、Hook、Permission 与 Resume 在同一 AgentMux lifecycle 下诚实表达能力差异；
- Local Terminal、代表性 Agent Provider、退出重开、Late Event、Gap、Input、Resize、
  Interrupt、Stop 与资源释放通过最终 Conformance，Remote 明确 unsupported；
- Remote 上线后，SSH Partition 与 recovery 通过同一 public contract；
- Desktop 与干净外部 Consumer 只使用 Core 公共 API；
- 最终 Package、Benchmark 和独立 Review 只引用最终 candidate SHA；
- 不实际发布、不修改用户全局 Agent Hook 或 SSH Credential。

## 9. 非目标

- 等待 ctxmux 期间继续完善自建 daemon；
- 用私有 fallback 补 ctxmux 缺口；
- 把 Agent Catalog、ACP、Hook、Permission、Agent status 或产品布局下沉到 ctxmux；
- 把账户、移动端、云同步、虚拟化环境或第三方 Issue 集成塞进 Run Kernel；
- 为尚未出现的 Transport、平台或多租户建立通用插件层。
