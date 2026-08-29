# f-29f8f7krj 计划细化 review（2026-09-22）

Review: approved（仅限本 Feature 已有目标内的计划细化，不代表实现完成或已执行发布）。

## 授权、来源和改变的前提

用户先要求创建 Feature，再要求「在 Feature：f-29f8f7krj 中完善下细节」。这授权完善已有闭环的范围、任务和验证，不授权本轮启动实现、安装或重启用户应用；本轮只修改文档和规划。

本轮读取开始时为 revision 0；期间其他执行路径安装了 revision 1、绑定 current_tree 并启动 T-001。以当前 tasks.json 为准，保留活动 T-001 的语义、依赖、verification 和执行状态，绝不用新草稿覆盖它。

本次修订的真实新前提：
1. 已启动 T-001 只闭合 Agents 聚合与导航；它不含就地回答/确认/下一项。这是既有 Goal 的剩余缺口，新增 T-004 承接。
2. preview-provider-catalog.test.ts 测的是 Web 开发预览中的 Provider mock，不是开发服务发现。此前引用的 lib/preview-provider-catalog.ts 不存在，不可作为能力或验证依据。T-002 使用已存在的 openHttpLink 和明确 URL；自动端口发现不在本 Feature。
3. revision 1 verification.ref 是 Markdown 文件，真正命令被写在 proves；T-003 还引用了 desktop 不存在的 test script。未开始的 T-002/T-003 直接修正为真实可执行命令形状。T-001 已活动，按 Tracker 规则保留原样；执行 owner 若 gate 因此失败，应按窄命令修复流程只交换其 command ref/proves 中的误填内容所需部分（严格保持 proves 等语义：实际只能改 ref），再重跑。不在本轮运行该 gate 或虚构失败。
4. 原先宽泛 rg 命中计数未排除定义文件，无法证明产品接线。新任务逐组件排除定义文件，同时要求挂载后事件行为测试与块级变异。

## 范围和权威分类

| 分类 | 内容 |
| --- | --- |
| 用户 Goal | 已有「发现需要我 → 做决定 → 检查结果 → 继续运行」闭环，范围不变 |
| 保护不变量 | Core/ctxmux 唯一 Owner；健康 Agent 不因流程失败被阻断；持久工作面先恢复；通用协议和用户选择，不写站点分支 |
| Reviewed Tasks | 保留 T-001；T-002 完善结果动作；T-004 闭合回答请求；T-003 消费所有结果做联合恢复验证 |
| 派生实现选择 | SessionResultReview/AttentionRequestPanel 是计划组件名；新的行为测试和 isolated restart probe 是待实现 oracle，当前不存在不等于已验证 |
| 环境观察 | AgentInteractionCard、AgentTreePanel、respondInteraction、openHttpLink、Git Diff 已有；进程恢复与自动服务发现不从文件名推定为完整交付 |
| 非目标 | Remote/SSH、移动端、Watch、语音、Push、账户额度监控、自动服务扫描/启动、第二 Inbox/Session/Run/Preview registry |

行为与视觉分别只在两份 SSOT 的「注意力处理与结果审查闭环」「注意力与审查密度」维护。来源产品名仅保留在本历史 review 和 Feature 标题，不进入公共机制或测试判据。

## 任务边界和依赖

- T-001 保持现有最小工作面入口；既有导航 Feature f-29e8fufey 与它有接触面，只消费同一实现，不新建第三套导航。原活动合同不在本次改写。
- T-002 消费 T-001 的入口语境并在 SessionPane 放结果动作；拥有 SessionResultReview、其行为测试及必要的 Store 动作接线。
- T-004 消费 T-001 的可用全局列表，拥有 AttentionRequestPanel、其请求状态与键盘处理；只调用已存在的 respondInteraction，不新增 Core 待办集合。
- T-002/T-004 的输入不依赖彼此，DAG 不加人为顺序。SessionPane/store.ts 等共享文件仍由当前执行 owner 串行整合；没有隔离和分工时不因图上可并行就安排并发写同文件。
- T-003 是首次完整联合验收点，依赖 T-002 和 T-004；其端到端和真实进程 oracle 与各组件测试不同。恢复约束贯穿每个实现任务，不再单列一个泛化 Runtime 重写任务。
- 既有未读/已读 Feature f-25d8fh9bv、Remote Feature f-23e8f89d8 仍归原 owner，本 Feature 不顺便实现。

## 失败边界和用户动作

- 请求过期/目标 Run 改变：拒绝旧回答、重新读 Core；不是把 Agent 判死。
- 无 typed request：可定位原 Session，不伪造允许/拒绝。
- 回答失败：保留上下文与原因，不重试、不跳下一项；确认处理成功才推进。
- 无 diff 与 Git 读取失败分开；所有 Diff 标明 Workspace 范围，不归因给本轮 Agent。
- 无 URL、无效 URL、服务状态未知、导航失败分开；只有明确 HTTP/HTTPS URL 才交给现有 Browser，地址存在不表示在线。
- 继续输入只聚焦原 Composer；Board 原观察投影不因这些快捷操作获得交互权。

## 验证与证据

所有新增 command 的 ref 都是 shell 命令，proves 是它证明的行为；新增测试文件/重启 probe 由对应任务交付。本次规划没有运行这些未来命令，也没有声称产品验证通过。

生产接线按精确组件符号扫描 src、排除定义文件及 test/spec，零命中失败；该检查只是静态证据，必须配合挂载后的真实事件测试。不能靠已有 respondInteraction 字样、任意计数或纯函数测试代替。

每个实现任务自己的 mutation.md 记录候选/input identity、被改坏的块、基线通过→变异变红→恢复通过。集合空值变异覆盖该 it 中所有读取；每个扫描有明确非空和锚点证明。证据字段完整不等于实测成功，日志必须能对应实际运行。最终节点消费仍适用的已有证据，不重复同一昂贵证明。

真实重启在隔离数据/Run 下执行，记录 PID 变化、Tab/Region/布局/焦点、agentSessionId、reattach 或 native resume 事实、故障服务窗与 cleanup。Store hydrate 或组件 remount 不能充当进程重启。ctxmux/Core 恢复行为保持既有权威，不为测试造第二套 Runtime。

最终候选的精确 SHA、工作树、输入身份和包路径只进入 receipt。生产安装前若确需改变活动安装，按原发布边界准备干净、已通过 gate 的恢复点；本次无 Git/tag/install 操作。验证不得停止用户的健康 Run。

## 计划检查

本次仍是同一 Goal、同一桌面环境、同一恢复与 Owner 约束，无新产品线。活动任务保持原样，剩余任务各有用户结果及可证伪 oracle；T-003 消费两个分支作最早联合验收。无新的 ceremony task，无自动化证明替代真实交互。工作量估计为 Agent 执行小时，不是交付时间承诺。

tasks.json 是任务和状态唯一真相。docs/plans/attention-review-loop-task-plan.json 是本 revision 的导入证据；旧 attention-review-loop.json 仅保留 revision 1 来源，不作为第二份可编辑当前计划。


## Command preflight correction

在 materialize 前做命令预检时发现零调用者命令的 shell 转义把 `\b` 变成了字面 `b`，会错过真实符号。该 revision 只修正两个命令的 `ref` 文本为精确符号搜索，保留 verification kind、顺序、证明义务、依赖和 acceptance 不变；未执行实现 gate，也未把命令预检当作任务通过。

## Follow-up command repair

Tracker 保留活动 T-001 的原 verification（活动 Task 语义不可变）。为未开始的 T-002/T-004，修正两个零调用者 `ref` 中的字面边界写法为不含 shell 特殊转义的精确符号搜索；这是命令可执行性修复，不改变 acceptance、证明内容、Task 顺序或依赖。该修订已由 Tracker 记录为 revision 4，尚未执行任何实现 gate。
