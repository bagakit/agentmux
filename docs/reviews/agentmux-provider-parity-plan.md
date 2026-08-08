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
- 对照语料中具备完整 lifecycle 证据的高价值 Agent（OpenCode、Droid、Copilot、Kimi）
  逐个纳入；launch-only 或宿主专属 wrapper 不盲目复制，必须记录为明确的
  deferred/non-goal。Mimo Code、Devin、OMP、Prime Agent 四家在 revision 4 转为
  deferred，理由见下节。
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

## Revision 4：四家 Provider 转 deferred

原计划（revision 1–3）把 Mimo Code、Devin、OMP、Prime Agent 列为「逐个纳入」。
2026-09-01 逐家核实第一方发行物后，这个前提不成立：

| Provider | 实测事实 |
| --- | --- |
| Mimo Code | `npm view mimo-code` → 404；仓库内零痕迹 |
| Devin | npm 上的 `devin` 是同名占位包（author devjmetivier，version 0.0.0），不是那个 Agent CLI |
| OMP | npm 上的 `omp` 是同名空壳包（description `new `，version 1.0.0），不是那个 Agent CLI |
| Prime Agent | `npm view prime-agent` → 404 |

按 Goal 的证据优先级（真实 CLI 实测 > 多参考互相印证 > 单一参考），四家都连「单一参考」
都达不到——没有可安装的产物，也没有官方 hook 文档，无从核实扩展目录与事件名。硬写
就是 Goal 明令禁止的那种「凭猜实现一个会静默失效的安装器」。因此按 Feature Goal
的 Non-goal 条款记为 deferred：不为凑满能力矩阵而实现。

四条 Task（T-010/T-012/T-013/T-014）在 tracker 中转为 `cancelled`，各自的
`cancel_reason` 保留上表证据与解锁条件。T-017 的 depends_on 相应收窄到实际交付的
十条（T-003/004/005/006/007/008/009/011/015/016），并由 T-017 的 deferred inventory
如实记录这四家为 deferred——不得冒充已实现。日后若拿到第一方发行物或官方扩展文档，
另开新 Task，不复活已 cancelled 的条目。

一条留存的实现线索：若 OMP / Prime Agent 日后拿到第一方证据，可复用
`packages/core/src/providers/pi.ts` 里 `piFamilyExtensionDir` 的合同——同族共享
扩展目录形状，逐家不同的只有 env 变量名与默认配置目录名这两个（第三个参数 `env`
是环境快照，与是哪一家无关），理由与「绝不跨家兜底」的约束逐条写在该函数的
JSDoc 里。
