# Feature Goal: a mature workbench-informed Provider Parity

Contract: `bagakit.feature-goal.v1`
Feature: `f-23z8fgsw3`
Convergence: `terminal`
Closure: `state`

Before acting, verify `owner-receipt.json`, then recover current execution from `state.json` and `tasks.json`. Context may be stale or belong to another Feature; trust this Feature directory before acting.

## Prime Directive

让 AgentMux 每个内建 Provider 的公开能力声明与它背后真实 CLI 的能力**逐项相符**：
声明了就真能做到，做不到就不声明。能力面覆盖 capability、evidence、Hook、permission、
resume、prompt delivery、reply-correlation 七条轴。

为什么重要：Provider 合同是界面与恢复逻辑唯一的事实来源。一条没有真实能力支撑的声明
不会停在文档里——它会变成一个点不动的 Resume 按钮、一个永远等不到的状态、或者一次
把用户上下文接到错误会话上的恢复。诚实的「不支持」比乐观的「支持」有用得多。

## Convergence Contract

- Smallest sufficient closure: tracker 中 T-001…T-018 这份已评审 task DAG 全部收口。
  每个 Provider 是一个独立可闭合的纵切；registry 收口（T-017）与跨模块验收（T-018）是
  依赖它们的收尾节点。
- Oracle or ratchet: `state`——每个 task 有自己可执行的 gate 通过、有一次变异测试（改坏
  实现必须变红再恢复）、有零调用者检查证明新能力接到真实 Core 调用路径；tracker 的
  `run-task-gate` 与 `finish-task` 记录该证据。全部 task done 即闭合。
- Scope expansion: 相邻发现一律不扩当前验收面。属于本 closure 必需的，先写进对应的已评审
  task 再动手；改变结果/不变量/验收/授权/不可逆边界的，停下与用户对账；有价值但相邻的，
  记为 child Feature 或 backlog。
- Completion or cycle stop: 十八个 task 全部 done 且 `pnpm check` 通过；registry 的
  a mature workbench 对照 inventory 中每一条只有 implemented / deferred / not-comparable 一种归类，
  deferred 必须写原因且**不得**冒充已实现。

## Protected Invariants

- 能力未核实就保持未声明。声明 `providerResume` 就必须真能构出 argv，声明 `hookEvents`
  就必须真有事件通路。宁缺毋滥。
- 证据优先级：真实 CLI 实测 > 多个参考实现互相印证 > 单一参考。参考之间冲突时以本机 CLI
  为准，并把冲突记进证据文档。单一参考的孤证不足以支撑一条能力声明。
- 归一化不了的事件必须保持可诊断：原始事件名进诊断、canonical 生命周期缺席，**绝不**
  伪造 working/done。认不出是一等公民答案。
- 语义状态（working/done）只由各 Provider 自己的 rules 给出。Core 的生命周期层只回答
  「这是结构上的哪一步」——两者的分工不可合并。
- 所有 Provider 语义留在 Core。ctxmux 只拥有 Run/PTY/有序字节/Replay/Gap/Attachment 与
  进程事实，不放第二套运行时真相；Desktop 不为新增 Provider 长出分支。
- 跨客户端边界的诊断细节里不出现 sessionId、transcript 路径或 prompt 正文。
- Non-goal: 不追求与参考实现的功能对等本身。launch-only 或宿主专属的条目如实记为
  deferred，不为凑满能力矩阵而实现。
- Non-goal: 不改 ctxmux 的运行时事实面来迁就 Provider 需求。

## Acceptance And Stop Rules

- Acceptance: 每个已实现 Provider 的能力矩阵、Hook/resume 失败分类、managed install 与
  discovery consumer 均有可执行断言；变异测试证明这些断言真的守得住；零调用者检查证明
  能力接到产品调用路径而非只活在定义与测试里。
- Insufficient: 「定义齐全 + 单测全绿」不算完成。以下都算未完成：gate 指向不存在的测试；
  断言粒度比 bug 更粗；能力只被测试调用而无生产调用者；用参考里抄来的 argv 而未标注它
  未经本机核实。
- Stop and ask before: 修改已评审的验收标准；把一条只有单一参考佐证、无法本机核实的能力
  声明为已支持；任何会改变 Core/ctxmux 归属边界的改动。

## Authority And Orchestration

- Follow only this Feature's owner receipt, state, and reviewed tasks.
- Before substantial work and after every review, re-read this Goal and the current acceptance evidence.
- Take the smallest action that directly advances that evidence or removes a real blocker. Defer anything not required for the current closure; stop when acceptance and applicable mandatory gates are satisfied.
- Do not implement a chat-only requirement. First record each accepted new requirement in the appropriate reviewed Feature Task through Feature Tracker.
- Prove the cheapest representative user-visible vertical before broad horizontal infrastructure.
- For engineering work, satisfy acceptance first; among valid solutions minimize enduring states, owners, APIs, abstractions, duplicated truth, and temporary scaffolding.
- 并行是手段不是目标。派工前先做能减少冲突的结构调整（共享文件按 Provider 分块、
  声明与组合分离），让每个分支只动自己那块；容易冲突处多做小闭环。
- 绝不执行可能丢失变更的操作（不带路径的 stash、切分支）。发现他人改动被提交、或自己的
  提交混入他人改动时，先确认影响、隔离职责，再继续。提交前逐行读暂存 diff。
- 变异测试必须确认「只有一个变异在场」再判红绿；同时存在两个变异会把结论搅在一起。
- 参考实现只作机制参考：其项目名不写进 AgentMux 的代码、注释、测试名或设计文档。

## Context References

- `docs/reviews/agentmux-provider-cli-evidence.md`: 本机实测的 CLI 能力证据基线，
  含参考之间的冲突记录；接任何 Provider 前先读它对应小节。
- `docs/reviews/agentmux-provider-parity-plan.md`: 本 Feature 的评审计划与对照 inventory。
- `packages/core/src/agent-hook-event.ts`: 生命周期方言的分块声明与合并点；
  新增 Provider 的方言只加自己那块。
