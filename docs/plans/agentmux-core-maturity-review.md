# AgentMux Core Maturity 方案评审

状态：已批准
对应 Feature：`f-2248f4yx5`
当前计划：revision 9（T-020 Local cutover；T-021 Remote）
前置决策：`docs/plans/mux-runtime-decision.md`

## 1. 修正结论

AgentMux 的长期边界恢复为已经确认的 a mature workbench-like embeddable 方案：`ctxmux` 是唯一通用 Run Kernel，AgentMux 是它上面的 Agent Runtime。

```text
Desktop / CLI / external Node consumer
                  │
                  ▼
          @agentmux/core public domain
 Provider / Agent Session / ACP / Hook / Permission / Resume
                  │
                  ▼
             CtxmuxRunAdapter
                  │
                  ▼
          @ctxmux/sdk -> ctxmuxd
 Run / PTY / Process / ordered bytes / replay / stop
```

2026-08-10 的 `236fce6` 把 Board 讨论中的用户回复“1”错误归因为 mux 选择，并据此把已经在 `b02803b` 固化的 ctxmux 方向反写成自建 `agentmuxd`。这个变更没有可靠的用户确认来源，因此 revision 4 的 Goal 与 Task 不能继续作为方向真相。

本轮不通过简单回退 Commit 抹掉已经产生的证据。自建 daemon 阶段形成的故障模型、correctness oracle、fixtures、资源测量与 Benchmark 方法保留并改造成 Run Kernel Conformance；重复实现的 PTY、wire、Replay、Journal、Remote Artifact 与进程清理生产代码在 ctxmux 切换时直接删除。

## 2. 为什么立即停止继续完善自建 Daemon

局部实现证明了团队理解 Create Fence、Incarnation、Replay、Gap、Backpressure、Crash、SSH 和资源边界，但这些能力属于通用 Run Kernel。继续修复 request timeout、operation fingerprint、PID identity、setsid 后代、同步 Journal 或 burst backpressure，只会让错误 Owner 更难删除。

T-008 的首轮临时 Debug 又显示 4 MiB sustained output 未能在 30 秒形成完整 Hash 证据。这个结果作为历史 failure 保留，但不再通过修改自建 daemon 来争取通过；最终 Benchmark candidate 必须是 AgentMux+ctxmux。

## 3. 最终所有权

### AgentMux 拥有

- Provider Catalog、Launch/Prompt Strategy 与 Capability；
- Agent Session、ACP、Hook、Permission、Evidence 与 provider-native Resume；
- Run 引用与 Agent Session 的关联；
- Client API、Workspace 关联、Desktop/CLI 投影；
- 不依赖 Kernel 私有类型的 Agent-to-Agent 与 Artifact 上层能力。

### ctxmux 拥有

- Run、PTY、Process 与真实运行状态；
- Ordered Input/Output、Sequence、Replay、Gap、Backpressure；
- Attachment、Attach/Detach、Resize、Signal、Stop 与 Run-level Recovery；
- Local/Remote Run Kernel 的版本、能力、资源和进程安全边界。

### 不允许存在

- AgentMux 自建 PTY daemon 或私有 Run protocol；
- tmux、ctxmux、自建 daemon 的 Backend Selector；
- Compatibility Alias、Migration、Fallback 或隐藏双 Runtime；
- 把 Terminal Output、idle 或 replay 冒充 Tool、Reply、Permission 或模型上下文连续。

## 4. 排序原则

先做不依赖 ctxmux 新实现、能在当前仓库独立闭环的工作：

1. 修正 SSOT 与资产处置；
2. 分开 Run、Agent Session、Attachment 与 View；
3. 收口 Provider、ACP、Hook、Permission 与 Resume；
4. 提炼 Kernel-neutral Conformance Kit；
5. 收口 Desktop 与外部 Consumer 的 Kernel-neutral 投影。

最后按可独立证明的边界推进 Kernel 工作：

6. 固定一个已提交的 ctxmux commit，补齐 AgentMux Local consumer 所需的 public byte cursor、interrupt/process-tree stop 与可复现消费合同；
7. 一次接入 Local Terminal+Codex 并删除自建 daemon、node-pty 和旧 Local/SSH production paths；Remote 明确 unsupported；
8. 在 Local 最终 candidate 上重做 Package、可靠性、安全、资源、Benchmark 与独立 Review；
9. 在最终 Runtime 与 Package 证据稳定后，交付 a mature workbench-like 的 Agent 间结构化通信、Inbox 与 Discussion Canvas；
10. 通过独立 T-021 以 ctxmux public Remote 合同恢复 SSH，并完成 Feature Closeout。

两仓库同属用户，本次 Local 内部集成不以 License、公开 npm 或 GitHub Release 为前置；它仍必须固定干净 commit，并提供可复现、无需相邻目录或全局安装的 SDK/binary 消费合同。SSH 不阻塞 Local，也不允许保留旧 SSH fallback；T-020 后直到 T-021 完成前，Remote 必须诚实返回 unsupported。

## 5. 领域模型

`Session` 不再同时表示物理进程、模型上下文和 UI Tab：

- `Run`：一个由 ctxmux 持有的物理进程及终端事实；
- `AgentSession`：AgentMux 持有的模型/Provider 语义与 native resume identity；
- `Attachment`：一个 Client 对 Run output/control 的有界订阅；
- `View`：Desktop Pane/Tab 对 Run 或 AgentSession 的产品投影。

Reattach 原 Run、provider-native resume、spawn 新 Run、创建新 AgentSession 和打开新 View 是五个不同动作。公共 API 必须表达这些差异，不靠注释修补含混命名。

## 6. 资产处置原则

- Keep：Provider、ACP、Hook、Permission、Semantic Store、Evidence、Desktop interaction、故障模型、fixtures、correctness oracle、统计方法。
- Port：Create/Incarnation、ordered I/O、Replay/Gap、slow consumer、stop tree、SSH partition、resource 和 Benchmark 测试，改成 ctxmux public-boundary Conformance。
- Delete：自建 daemon server/client/protocol、session journal、node-pty owner、process-table cleanup、remote daemon artifact、agentmuxd bin，以及只证明这些实现的白盒测试。

详细逐文件清单由 T-010 写入 `docs/plans/ctxmux-correction-inventory.md`。

## 7. 与其他 Feature 的关系

`f-2258fa79w` 图片与鼠标输入继续保持独立 Feature。2026-08-12 用户要求把 a mature workbench CLI 式 Agent 通信追加到当前 Feature 的最后；因此旧 `f-2268fqs8a` proposal 的成熟约束被吸收到 T-019，并以当前 Feature 为唯一执行真相。旧 proposal 只保留 Tracker 历史，不再并行执行。

## 8. 完成门槛

- Goal、Tracker、决策文档与代码只存在一个 ctxmux Run Kernel 方向；
- AgentMux 公共模型清楚区分 Run、AgentSession、Attachment 与 View；
- 五个 Provider、ACP、Hook、Permission、Resume 与 Evidence 不依赖 Kernel 私有类型；
- Desktop、CLI、外部 Consumer 只通过 AgentMux 公共 API；
- 统一 CLI/SDK/Desktop 可用 runtime-issued Raw Terminal/View ID，或把稳定 `agentSessionId` 唯一解析为当前已打开 View 后执行 `switch`；该动作只改变 Desktop 焦点，与 Open、Attach、Resume 和 Run 生命周期严格分离，未知、歧义、过期、未打开目标失败关闭；
- ctxmux 通过适用 Conformance，T-020 完成 Local 切换并删除自建 daemon、node-pty 与旧 Local/SSH 生产路径；Remote 在 T-021 前明确 unsupported；
- 最终 Package、Security、Chaos、Stress、Resource 和两轮 Benchmark 在最终 SHA 通过；
- 独立 Review 的所有 Release Blocker 已处理；
- Agent 间消息、Inbox、Ask/Reply、Delivery Ack 与证据等级通过至少一个真实双 Agent 竖切；直接 Terminal Input、完整 Handoff 与受监督 Dispatch 不混为一种语义；
- 不实际发布、不修改用户全局 Agent 配置、不静默安装远端组件。

## 9. 非目标

- 在 ctxmux 未就绪时继续完善自建 Run Kernel；
- 为等待期建立临时 Backend、Compatibility 或 Fallback；
- 把 ctxmux Agent 化，或把 AgentMux 的 Provider/ACP/Permission 下沉到 ctxmux；
- 把 AgentMux Core 扩张成自动调度器、Agent 团队规划器、结果评判器、跨服务器 Relay 或 a mature workbench compatibility runtime；
- 用删除历史、重写旧 Gate 或覆盖旧失败结果来制造干净叙事。

## 10. 证据

- `AGENTS.md`
- `b02803b`：采用 ctxmux 唯一 Run Kernel 的已确认决策
- `236fce6`：错误反写为自建 daemon 的决策变更
- `docs/plans/mux-runtime-decision.md`
- `docs/a mature workbench-agent-runtime-notes.md`
- 当前安装版本的 `a mature workbench skills get a mature workbench-cli` 与 `a mature workbench skills get orchestration` 合同
- 当前 `packages/core`、Desktop、测试与 T-008 debug failure
