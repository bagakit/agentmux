# Provider 与人机交互分层重构计划评审

Status: approved

授权来源：用户确认先做“不考虑自演化、不引入新复杂度也有价值”的熵减重构，并明确“与人交互的多层逻辑也应该是 AgentMux 关注的部分”，要求创建专门 Feature 指导重构。本评审将这一授权落为边界和任务；不授权新增业务编排平台或改变权限策略。

## 代码基线与纠偏

DSH 参考版本为 c291e7961a。可借鉴 packages/core/agent-loop、goal/goal-round-driver、schedule/schedule 的所有权与投递阶段分离，以及 jobs/jobs 的 owner 语义；不据此引入 Cordis 或照搬其模型循环。
AgentMux 已有 packages/core/src/agent-provider.ts、agent-interaction.ts、agent-delivery-queue.ts、agent-session-continuity.ts、continuous-progress.ts、continuous-progress-scheduler.ts；desktop 已有 continuous-progress-loop-manager/store/tracker、prompt-readiness-diagnostics 和 renderer steer queue。此前对话中称“只有外置 loop 原型/没有内置 scheduler”的描述不符合当前代码，不能成为新实现依据。Core 的 delivery consumer ack 与 prompt 被 Harness 消费不是同一事实，不能为了统一命名合并。

## 技术边界

从现有 Core 模块收敛，先完成 Codex/Claude → Core → 一个真实 UI/CLI consumer 的竖切，再枚举 registry 验证其他 Provider。类型名和是否拆独立 package 由已证明的职责决定，不预设新包；只有现有第二个消费者与可独立测试边界成立才提取。共享 types.ts/client.ts、runtime-controller.ts、store.ts 由集成 owner 串行合入；适配器/纯域逻辑/展示测试可独立推进。不改 ctxmux 实现。

人与系统的交互分三类 owner：Provider 协议语义；Core 请求/投递生命周期与作用域；Client 输入、呈现、注意力与定位。宿主系统权限和 Provider 权限也不混为一个请求。原生终端仍可直接交互；typed 操作不伪装普通按键。终端层机制沿用 docs/design/agentmux-terminal-interaction-layers.md，不复制另一份键盘/IME 状态机。

## 既有 Feature 归属

- f-23z8fgsw3：新增 Provider 和 parity 验收留原 owner；本 Feature 只统一其既有协议的消费边界。
- f-2548fr8qc：/、$、@ 候选与菜单留原 owner；本 Feature 只收敛其输入操作/回执接线。
- f-2558f5auz：队列逐项面板及删除交互留原 owner；Core 投递合同由本 Feature 提供，不能各造一个 queue owner。
- f-25h8fysz9：结果通报分级的产品规则留原 owner；本 Feature 复用其当前规则，收敛来源身份与局部/Session/全局呈现边界。
- f-25a8fpvcp、f-25d8fh9bv、f-25e8fm2tf、f-25j8fe2vc：OS 注意力、已读/未读和 context 展示扩展留原 owner。
- f-24m8fphma 和 f-24e8ffbzq：空间算法和新布局交互留原 owner；此 Feature 只保障身份与恢复不变量。
- f-2538fz2rm 已归档，不回写其已完成任务。本 Feature 不宣称替代全部旧需求；未执行整 Feature transfer，后续确需移交时走公共 transfer/replan，保留历史。

## DAG 审核与验收

T-001 首先关闭观察到真实消费者的竖切。T-002 输入和 T-003 typed 请求消费其观测合同；T-004 呈现消费 T-002/T-003；T-005 身份恢复不依赖新 UI，可独立开始；T-006 现有 loop 消费 T-002/T-003/T-005，避免建立第二套决定。T-007 是精确整合候选的最终验收。依赖仅表示输入需要，不阻止提前准备 reviewer、夹具与隔离测试。

每项 implementation task 必须记录一次具体 mutation 的红/恢复绿、非定义文件生产调用者及真实行为测试。新验收测试路径是待实现的 gate，不是已存在证据；命令先 test -f，禁止空 filter 假绿。测试仅证明所断言行为，不能将一个 unit suite 的绿扩成整条链路已交付。源扫描必须证明扫描非空，并从实际来源派生。所有有损测试使用独立临时工作区/Runtime，单 worker，不运行用户真实权限请求，不留 Electron/ctxmuxd 子进程。

交付标准：删除被替代的判断和 owner、现有消费者全部接线、所有受影响 Provider 能力逐项准确、进程重启仍可见可恢复、Core 独立 consumer 可用。此 Feature 的完成不依赖引入自演化、通用 Job/DAG 或新 UI 需求。仅创建计划时不运行未来 gate，不把计划标 done。
