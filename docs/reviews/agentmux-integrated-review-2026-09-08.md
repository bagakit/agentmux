# AgentMux 整体 review · 2026-09-08

Status: approved

授权：用户明确委托整体 review，结合项目内容直接修复 bug、代码熵、性能和设计问题。本轮审批由该授权覆盖；不改写其他 Agent 的 active Task 或未实现 proposal。

Closure：修复本轮确认的发送/告示、异步焦点与 Board 读取一致性问题，提供行为、变异及产品调用链证据，留下后续接续记录。不是所有历史 Feature 的重新验收。

初始三个独立任务分别拥有 Core→Session 告示、Region 焦点、Board 读取/分组，后续增补头像交互任务，依赖边为空；本轮单 reviewer 顺序修改，共用工作树不引入并发写同一文件。

验收须包含真实生产调用、故障变异后红测、恢复后绿测。既有源码扫描测试只作补充，不替代行为证据。

## 初始发现

- P1：屏幕观察取消被改写为“重发”，但 payload 已接受、提交仍占用；流程故障阻断健康 Agent。
- P1：Core 持久化 terminalPromptDelivery，但 Desktop snapshot 没有投影，服务窗实际零调用，构成静默降级。
- P1：屏幕新字节边界当前为 >=，允许旧屏幕提前确认。
- P1：Region 焦点 nonce 在清空后复用，指针导航不撤销旧意图；异步 Monaco 挂载前意图被清掉。
- P2：WorkspaceBoard 保留旧读取 hook，又调用 useBoardRows；刷新更新的是旧快照，行消费另一个快照。Topic 请求没有 Workspace 归属，切换时可串屏。
- P2：Topic 排序逐 id filter、分组逐成员复制数组，带来二次复杂度。

## 验证与接续

详见下方《本轮结果与接续边界》。

## Revision 2 · 浏览器实测补充

Status: approved

P2：实际浏览器报告 Branch row 的原生 button 内嵌 AgentAvatar button；聚合头像没有 onOpen，却补了空回调、吞掉点击。新增 T-004，沿用用户直接修复遗漏 bug 的授权；与前三任务无前置输入依赖，不改其 active 语义。

## Revision 3 · 修正验收命令

Status: approved

新测试与既有 service-window-notice.test.ts 同 basename，TypeScript 会跳过 .tsx。新文件改名为 prompt-delivery-service-window.test.tsx，T-001 保留 cancelled 历史，由 T-005 supersedes；实现、验收目标不变，其余 active Task 不变。不得拿未被 tsc 纳入的测试文件作为类型证明。

## 本轮结果与接续边界

本轮审查当前工作树的 Core 发送/恢复边界，以及 Desktop 的输入焦点、Board 请求、头像交互和实际服务窗。其他 Agent 已有改动被保留；没有把未实现的 proposal 或历史 blocked Feature 改成 done。

| 严重度 | 已修复问题 | 生产落点与证明 |
| --- | --- | --- |
| P1 | resize 替换屏幕观察后，payload 已写入却要求重发，留下 busy 占用 | `prompt-submission.ts`：同一 Run 仍活着才继续原提交；断连/退出仍拒绝。真实 coordinator + evidence store，双阶段受据与幂等重试断言 |
| P1 | Core 降级标记未进入 Desktop，用户实际看不到告示 | `runtime-controller.ts` 的 snapshot 与 `session-state.ts` 的 live 更新同时投影；Core 清除时移除旧标记；`SessionPane` 显示已有服务窗 |
| P1 | 新输出边界被放宽为 `>=`，旧画面可提前确认 | `AgentTerminalScreenEvidence.wait` 恢复严格 `>`；只打开字节守卫的现有测试能独立打红 |
| P1 | Editor 加载前丢弃焦点请求、清空后复用 nonce、指针导航未撤旧请求 | `focusRegion` 序号不复用；指针导航取消旧请求；Editor/xterm 挂载和更新共用消费入口，隐藏表面不夺焦；React DOM 验证异步 mount |
| P2 | Board 刷新与行读取各持有一份快照，主视图和 Dock 再各读一遍 | `BoardRowsProvider` 持有一次读取，主视图和 Dock 消费同一结果；真实 DOM 点 Refresh，两处同时更新且只发一次请求 |
| P2 | Topic 读取结果没有 Workspace 归属，切换瞬间串屏 | `useScratchTopics` 将请求结果绑定 Workspace；渲染时隔离旧结果，忽略晚到回复 |
| P2 | 高密度 Topic 排序反复全表扫描、分组反复复制已收集成员 | ID→row Map 与单次分组；2000 Run 的引用遍历预算 ≤8000，恢复原实现产生 2,005,000 次并被测试拒绝。此证据证明分组成本，不宣称全应用 FPS |
| P2 | 聚合头像伪装成按钮、嵌在分支按钮里并吞掉父行点击 | 无目标头像用 span，有目标才用 button；真实 DOM 点击、焦点测试，浏览器确认零嵌套按钮错误 |
| P2 | 当前树分屏比例的夹取被移除，NaN 可流入第三方 Panel | 恢复 `clampSplitRatio(node.ratio)`；原有交接口守卫先红后绿 |

删除了只改错误文案的重发包装、重复的 Board 读取与冗长的焦点形状测试。没有另加 Runtime、Provider 特例或缓存层。新增 `happy-dom` 仅作测试依赖，用真实 React effect 生命周期验证异步行为。

## 验证

- 生产 `pnpm typecheck` 与 `pnpm build` 通过。
- 最终快速回归：431 个测试文件通过，5217 条测试通过；3 条需要显式启用的真实 Agent/benchmark 测试跳过。此前一轮出现 Core dist 文件缺失与依赖加载失败，重新构建后全量通过；共享工作树持续有其他改动，本轮不将构建期间的加载失败归因为产品缺陷。日志见 `fast-final-pass.log`，原失败保留为 `fast-build-interference.log`。
- 四条 Task gate 全部通过；12 个故障变异全被 AssertionError 杀死，随后恢复实现。证据为本 Feature artifacts 中的 `mutations.json` 与逐条日志。
- 7 个产品入口均有定义文件之外的调用，见 `product-callers.json`。Service notice 同时覆盖冷快照、live 投影与 UI 消费。
- Playwright 浏览器预览：1440×1000 检查 Board，主视图与工具列表均可见；重载后 console error 为 0，DOM `button button` 为 0。预览使用内建假数据，不冒充真实多 Agent 压力测试。
- 安装包验收：`package-consumer.integration.test.ts` 独立运行 15.23 秒通过。第一次与快速套件并行时在 `agentmux resume` 遇到 `CONTROL_TIMEOUT`；根因尚未确认，不能把串行重跑通过表述为已经修复这个间歇超时。保留两次原始日志。
- Desktop 历史测试仍有类型债；现有按文件上限守卫通过，本轮新文件已全部进入 TypeScript 且无新增类型错误。没有抬高历史错误基线。

## 后续 Agent 从这里继续

1. 沿已有 Feature frontier 继续 Provider parity、Core maturity 等工作；本轮不是这些 Feature 的重新验收。
2. 下一轮可靠性 review 优先复现安装包 Control resume 的并行超时，保留 Run、Hook 与握手时间线再归因；不要加超时掩盖问题。
3. 下一轮性能验收应跑真实多 Agent 长会话、输出洪峰与 cold parking 场景。本轮只证明具体分组成本和输入/刷新链路，不宣称达到全天稳定性或性能上限。
4. 保持服务窗事实贯通 Core → snapshot/live → Session；不能因为单元测试通过就遗漏投影或产品调用。
5. 只收敛有因果证据的源码扫描测试；不要为了固定文本、固定文件数量维持重复状态或恢复空回调。被删除和未跟踪的测试都应按当前工作树真实文件枚举。

## 学习与推广

复用既有原则 11、单一事实源与零调用者纪律：同一个 hook 的代码复用不代表共享请求状态；状态字段加到类型上不代表 live/cold 两条链路均已接通；异步加载必须测试 effect 与 mount 的先后顺序。修正已进入设计 SSOT 和行为测试，本轮不新增知识存储或原则层。
