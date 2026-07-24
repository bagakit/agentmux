# AgentMux mux Runtime 架构决策

状态：已修正确认
Feature：`f-2248f4yx5`
Task：`T-010`
原确认日期：2026-08-10（Asia/Shanghai）
修正日期：2026-08-11（Asia/Shanghai）

## 1. 决策

AgentMux 采用 a mature workbench-like embeddable 架构，`ctxmux` 是最终唯一通用 Run Kernel。AgentMux 不再自行拥有 PTY daemon、Run wire、Replay、Journal、Backpressure 或进程树清理。

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

当前仓库中的自建 `agentmuxd` 是错误决策下已经实现的过渡代码，不是长期架构，也不是可继续扩展的备选 Backend。它会在 ctxmux 通过能力 Gate、Local/SSH 与 Desktop 完成切换时直接删除；切换前只维持仓库现有可运行性，不再为其新增产品能力或修补将随 Kernel 删除的私有协议债务。

最终产品不保留 tmux、自建 agentmuxd、Main-owned PTY 或 Hybrid Runtime 作为兼容层、Fallback、Migration 或可选 Backend。

## 2. 决策修正

提交 `b02803b` 已经把 ctxmux 固化为唯一 Run Kernel。提交 `236fce6` 随后把 Board 讨论中的用户回复“1”错误归因为 mux 选择，并将文档改写成“用户选择 AgentMux 自有 Daemon、排除 ctxmux”。当前线程没有可靠证据支持这个归因，因此该段用户确认无效。

2026-08-11 用户要求先修正 Feature 与 Goal，再按“能自行闭环的在前、会被外部能力卡住的在后”重排；如果 ctxmux 尚未完成替换所需能力，其接入放到最后，不阻塞前面的 AgentMux 领域工作。这是当前有效执行顺序。

修正不删除 Git 历史，也不把旧 Gate 改写成没发生过。旧自建 daemon 的运行证据继续证明故障模型与测试方法的价值，但不能证明 ctxmux 目标已经完成。

## 3. 为什么选择 ctxmux

AgentMux 的核心价值是统一 Agent 语义，而不是再造通用 mux 基建：

- Provider、ACP、Hook、Permission、Evidence 与 provider-native Resume 是 Agent-specific；
- PTY、Process、ordered bytes、Replay、Gap、Backpressure、Attach/Detach、Resize 与 Stop 是通用 Run Kernel 能力；
- Desktop、CLI 或另一个宿主不应分别重写两类能力；
- AgentMux 自建 daemon 会与 ctxmux 重复所有复杂、高风险、平台相关的 Run Owner 工作；
- ctxmux 缺少某项硬能力时应形成明确外部 Gap，不应成为 AgentMux 私有 fallback 的理由。

a mature workbench 的成熟模式同样证明：可恢复 Agent 产品需要稳定的 PTY/Process Owner，但 Agent Catalog、Hook、Permission、Provider Session 和产品 Workspace 不属于这个底层 Owner。

## 4. 候选比较

| 候选 | 进程与持久化 | 优点 | 长期问题 | 结论 |
| --- | --- | --- | --- | --- |
| 真实 tmux | tmux Server 持有 | Local/SSH 成熟、退出后继续 | command-per-input、snapshot polling、tmux 语义泄漏 | 不选 |
| Main-owned `node-pty` | Electron Main 持有 | 本地流式简单 | App 退出即丢失，无法满足恢复 | 不选 |
| AgentMux 自建 daemon | AgentMux 持有全部 Run 基建 | 已形成可运行原型和大量测试 | 重复 ctxmux，协议/安全/发布/跨平台/资源 Owner 全部自担 | 待删除过渡实现 |
| `ctxmux` Run Kernel | ctxmuxd 持有通用 Run | 复用专门 Owner，AgentMux 聚焦 Agent 语义 | 接入取决于公开 SDK、版本和能力 Gate | **唯一目标** |
| 长期 Hybrid | 多 Owner | 看似可绕过缺口 | 两套真相、测试和恢复组合数长期翻倍 | 禁止 |

## 5. 所有权边界

| 能力 | AgentMux | ctxmux | Desktop / Client |
| --- | --- | --- | --- |
| Provider Catalog、Launch、Prompt Strategy | 权威 | 不感知 Agent | 提交意图、展示能力 |
| AgentSession、ACP、Hook、Permission、Resume、Evidence | 权威 | 只承载关联所需 Run identity | 展示并显式响应 |
| Run、PTY、Process、真实运行状态 | 引用和投影 | 权威 | 不直接 Spawn/Kill |
| Ordered I/O、Sequence、Replay、Gap、Backpressure | 映射为 AgentMux Run fact | 权威 | 按 Attachment/Cursor 消费 |
| Attach/Detach、Resize、Signal、Stop | 通过 Adapter 请求 | 执行和确认 | 只调用公共 API |
| Workspace、Editor、Board、Pane、Tab、Browser、Git | 只关联必要上下文 | 不拥有 | Desktop Host 权威 |

`packages/core` 不依赖 Electron、React、Desktop Store、ctxmux 私有模块或 ctxmux wire 类型。`CtxmuxRunAdapter` 是唯一项目自有 mux 边界，不演化成 Backend Registry。

## 6. 对象模型

- `Run`：ctxmux 持有的物理进程和终端事实；
- `AgentSession`：AgentMux 持有的 Provider/模型语义和 native resume identity；
- `Attachment`：一个 Client 对 Run output/control 的有界订阅；
- `View`：Desktop Pane/Tab 对 Run 或 AgentSession 的产品投影。

Reattach 原 Run、provider-native resume、Spawn 新 Run、创建新 AgentSession 和打开新 View 是不同动作。Terminal Output、Process Liveness 与 Agent Evidence 保持来源差异；PTY 可证明“进程输出了什么”，不能证明 Tool、Permission、Reply、模型私有 Chain-of-thought 或模型上下文连续。

## 7. Local、SSH 与恢复

Local 与 SSH 使用同一 AgentMux Run 合同，只替换 ctxmux 的连接与显式部署方式：

- Desktop 完全退出、Renderer/Main 崩溃后，仍在运行的 Run 继续；重开只 Attach；
- SSH 网络中断只结束 Transport/Attachment，不自动结束远端 Run；
- 丢失 Create Response 不能重复 Spawn；同一 Run ID 的新物理进程必须有新 Incarnation；
- Replay 窗口外明确报告 Gap/Truncated，不能把残缺历史伪装成完整屏幕；
- 只有 ACP handle 或 provider-native resume 能证明 AgentSession 上下文连续；
- 系统 SSH 与用户现有认证保持权威，不复制 Private Key、不静默下载或安装、不开放未授权监听端口。

具体 create fence、input identity、process tree、remote artifact、capability negotiation 与资源边界由 ctxmux capability audit 和 Conformance Kit 验证。缺失任何硬能力时，最终接入任务阻塞，不回退自建实现。

2026-08-11 的 T-015 已固定审计公开 commit `b2bbc7a`：Local Start/Attach/Replay/Resize/Stop 与 Client 重连已有真实证据，但 License/Release/Package、SSH、Create/Input 幂等 byte cursor、Output byte cursor、完整进程树、全局资源预算和 Runtime capability identity 尚未齐备。原 T-016 因这些精确外部缺口 parked；当前 T-020 必须对新的已提交、版本化 public candidate 重新审计，完整矩阵与解除条件见 `docs/plans/ctxmux-capability-audit.md`。

## 8. 实施顺序

先完成不依赖 ctxmux 新能力、可以自行闭环的工作：

1. 修正 Goal、Tracker、决策与资产处置；
2. 分开 Run、AgentSession、Attachment 与 View；
3. 收口 Provider、ACP、Hook、Permission 与 Resume；
4. 提炼 Kernel-neutral Conformance Kit；
5. 收口 Desktop、CLI 与外部 Consumer 的 Kernel-neutral 投影。

最后执行外部依赖链：

6. 审计 ctxmux 当前公开 SDK、版本、License、发布与 Local/SSH 能力；
7. 能力齐备后接入一个 CtxmuxRunAdapter，原子切换 Local/SSH 与 Desktop；
8. 直接删除自建 agentmuxd、node-pty Owner、wire、Journal、Remote Artifact 和旧 package bin；
9. 在最终 AgentMux+ctxmux candidate 上重做 Package、Security、Chaos、Resource、Benchmark 与 Review。

## 9. 验收条件

- 仓库中只剩 ctxmux 一个 Run Kernel，没有 tmux/agentmuxd 生产路径或双 Owner；
- AgentMux 公共 API 不泄漏 ctxmux、自建 daemon 或 Electron wire；
- 五个 Provider、ACP、Hook、Permission 与 Resume 在同一 AgentMux lifecycle 下诚实表达能力差异；
- Local/SSH、退出重开、Crash、Partition、Lost Response、Late Event、Gap、Resize、Stop 与资源释放通过最终 Conformance；
- Desktop 与干净外部 Consumer 只使用 Core 公共 API；
- 最终 Package、Benchmark 和独立 Review 只引用最终 candidate SHA；
- 不实际发布、不修改用户全局 Agent Hook 或 SSH Credential。

## 10. 非目标

- 等待 ctxmux 期间继续完善自建 daemon；
- 用私有 fallback 补 ctxmux 缺口；
- 把 Agent Catalog、ACP、Hook、Permission、Agent status 或产品布局下沉到 ctxmux；
- 复制 a mature workbench Account、Mobile、AI Vault、WSL、Emulator 或 Hosted Issue Integration；
- 为尚未出现的 Transport、平台或多租户建立通用插件层。

## 11. 用户确认

- 架构：a mature workbench-like embeddable，ctxmux 是唯一 Run Kernel；
- 排序：先完成能独立闭环的 AgentMux 工作，ctxmux 接入和最终 mux 替换放在后序；
- 等待策略：ctxmux 能力不齐时记录精确 blocker，不阻塞前序、不建立 fallback；
- 修正确认：2026-08-11，本线程当前指令。
