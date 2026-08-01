# AgentMux Provider Parity — reviewed plan

Status: approved

本 Feature 由用户明确要求建立，用来收口 AgentMux 与一份外部对照语料比对后发现的
Provider 移植缺口。审计基线是 AgentMux 当前 9 个内建 Provider 与对照语料中 36 个
Agent 定义的源码/运行证据；同名重叠为 8 个，AgentMux 的 `traex` 与
`trae`/`traecli` 是不同 Provider。

## 目标

- Core Provider 协议优化是准备过程的一等结果：公共 `AgentProvider` 合同要同时诚实表达 capability、evidence、Hook、permission、resume、prompt delivery 与 reply-correlation，Provider 分支只能在这份协议上扩展，不能各自发明一套字段或状态。
- 现有 Provider 的 Hook、status、permission、native resume 和部署闭环必须以真实
  CLI 能力为准，能力未核实就保持未声明。
- Grok、Gemini、Pi、Claude、Hermes、Cursor 的已知缺口各自有独立实现与回归证明。
- 对照语料中具备完整 lifecycle 证据的高价值 Agent（OpenCode、Mimo Code、Droid、Devin、
  OMP、Prime Agent、Copilot、Kimi）逐个纳入；launch-only 或宿主专属 wrapper
  不盲目复制，必须记录为明确的 deferred/non-goal。
- 所有 Provider 与 semantic resume 逻辑留在 `packages/core`；ctxmux 继续只拥有
  Run、PTY、ordered bytes、Replay、Gap、Attachment 与进程事实。

## 并行与所有权

先完成共享 Provider 模块边界和 Hook canonicalization 两个脊柱任务，再并行执行
每个 Provider 的独立分支。Provider 分支只写自己的 module、fixture 与测试；内建
registry、公共 capability 类型和最终文档由单独的集成/合同任务拥有。所有分支在
集成 join 后才计入 Feature workspace，最后由跨 Provider acceptance 统一验证。

每个实现 Task 都必须通过：

1. 自己的 executable gate；
2. 变异测试（改坏对应实现后必须变红）；
3. 零调用者检查（证明能力接到了产品调用路径，而不是只有定义和测试）。

“对照语料里有但暂不纳入”的条目只允许作为审计策略记录，不能伪装成已实现 Provider。
