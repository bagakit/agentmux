# f-22q8f25qd 独立实现审查：扇出的执行半边没有用户入口

日期：2026-08-29
审查者：主 session（未参与 T-001..T-005 的实现）
审查对象：工作树当前状态（含未追踪文件）

## 结论先说

T-001..T-005 各自的**单元**都成立，37 个断言全绿
（fanout-plan 11 + fanout-run 11 + fanout-group 15）。但把它们连起来看，
**扇出的执行半边今天没有任何用户可达的入口**：用户无法发起一次扇出。

因此 T-006 的第一条验收「用户可指定保留一路」目前无法被满足——
在没有办法**发起**扇出的前提下，谈不上留下胜者、拆除其余。

## 证据

对 `apps/desktop/src` 全量 grep，两个编排模块都是零生产调用者：

- `apps/desktop/src/main/fanout-plan.ts:65` `planFanOut` —— 除
  `apps/desktop/test/fanout-plan.test.ts` 外无任何引用。
- `apps/desktop/src/main/fanout-run.ts:84` `runFanOut` —— 除
  `apps/desktop/test/fanout-run.test.ts` 外无任何引用。fanout-run.ts:2 只是
  从 fanout-plan 引入类型。

而且它**根本没有 IPC 面**。对 `fanOut|fanout` 分别 grep 四个接线层，全部零命中：

- `apps/desktop/src/shared/contracts.ts` —— 无扇出契约
- `apps/desktop/src/preload/index.ts` —— 无扇出方法
- `apps/desktop/src/main/ipc.ts` —— 无扇出 handler
- `apps/desktop/src/renderer/src/store.ts` —— 无扇出 action

对照 Git feature 的同类接线（contracts 的 git 命名空间 → preload:51 →
ipc.ts:204-209），扇出这条链一节都不存在。

**展示半边是活的**，这也是容易误判为"已完成"的原因：
`fanout-group.ts` 经 `FanOutStrip.tsx:119` 被 `WorkspaceBoard.tsx:212` 渲染。
也就是说，如果扇出的 worktree 与 Session 用别的途径存在了，Board 会正确地把它们
识别成一组并显示——但没有任何途径去创建它们。

## 这不等于 T-004 谎报

T-004 的验收原文是「编排位于 Desktop main……**返回逐路结果**……**调用方据此渲染**」，
它交付的是编排原语本身，其 gate（fanout-run.test.ts）确实在实测这个原语：
逐路结果、部分失败归属、一路失败不阻断其余。这些断言是载荷性的。

缺的是那个「调用方」——从未有人把这个原语接到 IPC 与 UI 上。
按项目原则（先跑通一个最小的端到端版本），这是**竖切没有真正闭合**。

## 处置建议

T-006 收尾前必须补上最小端到端接线，否则整个 feature 是一段测得很好但用不到的代码：

1. `contracts.ts` 加扇出契约（判别联合表达逐路结果，沿用 T-004 已定义的
   `FanOutResult` / `launchedLanes` / `strandedLanes` 形状，不新造第二套）。
2. `preload/index.ts` + `ipc.ts` 接一个 handler，内部依次调用
   `planFanOut` → `runFanOut`，不在 handler 里重新拼分支名与路径
   （fanout-plan 的存在理由正是"名字与路径只有一个出处"）。
3. renderer 给出发起入口与"保留这一路、拆除其余"的动作，拆除复用 T-002 的原语，
   脏树保护不得绕过。
4. 部分失败经既有 reportError 浮现，不新增第二套错误状态机。

在此之前，T-006 不应被判为 done。
