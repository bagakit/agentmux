# 多层注意力：AgentMux 的分层依据

一个人同时带多个 Agent 时，最先用完的是人的注意力。本页说明 AgentMux 为什么用五层注意力加一层执行底座组织产品：每层替人吸收什么、向人或上层交出什么，这套结构对 Agent 集群调度意味着什么，以及它的边界和验证方法。执行底座指 ctxmux 与 Core 的 Provider、Session 层，见 AGENTS 的[分层与身份](../../AGENTS.md#分层与身份)。

本页是依据与假设，不定义新约束。各层的行为、呈现与机制只在所链接的 owner 文档中定义；下文列出的做法都是这些 owner 中的约束，不代表当前实现都已满足。

[文档导航](../README.md) · [交互专题索引](agentmux-desktop-interaction.md)

## 瓶颈在人

Agent 能独立工作的时间越来越长。一个人同时开五个、十个 Agent 时，限制产出的就是人：看哪一个，切过去，重新看懂它在做什么，判断结果能不能收。一项随机对照试验中，资深开发者在允许使用 2025 年初 AI 工具的任务上实测慢了 19%，本人却以为快了 20%，时间更多花在写提示、等待、审阅和空闲上（Becker 等，2025）；这项试验是一人配一个 AI 助手。另一项网络作战仿真中，被试用命令行监督自主计算机 Agent，只计打字时间的模型估算一个人能带 7.43 个，实测平均只有 2.27 个（Mancuso 等，2015）。

## 五条原则

1. **注意力以时间计量，是稀缺资源。** 信息消耗的是接收者的注意力（Simon，1971）。多开一个 Agent，就多一个信息源。评估一项设计，看它让每单位 Agent 进展多花还是少花人的时间。
2. **一层只有吸收的多于交出的，才省注意力**（Simon，1971）。每层从它覆盖的对象收到大量信号，向人交出的必须更少。评审新功能时也问同一个问题：它向人发出的信号，是否少于它替人吸收的信号。
3. **一个人能带多少 Agent，上限由两段时间决定。** Olsen 与 Wood（2004）把它定义为 Agent 有效工作的时间 ÷ 人每次介入的时间；Crandall 等（2005）写成（Agent 无人照看也能推进的时间 + 人每次介入的时间）÷ 人每次介入的时间。可用的杠杆只有两类：让 Agent 无人照看时推进得更久，让每次介入更短。介入的时间主要花在看状态并挑出下一个、找回该 Agent 的目标与现场、想清下一步怎么做上，打字下命令只占小部分。
4. **信号必须可信。** 多数告警是误报时，人会学会忽略告警（Sendelbach 与 Funk，2013）。上层的每次汇总都建立在下层信号之上，所以控制事实只取准确对象上的协议事实，分不清时明确未知，见 AGENTS 的[健康能力与未知状态](../../AGENTS.md#健康能力与未知状态)与[通用机制与 Provider 适配](../../AGENTS.md#通用机制与-provider-适配)。
5. **被打断的工作必须能沿原身份接上。** 中断无法避免，代价主要在恢复：挂起的目标会被淡忘，恢复时需要仍然在场的线索（Altmann 与 Trafton，2002）；把工作分成可以保存的中间状态，一次中断只损失一小段（Simon，1962）。与此一致，持久 Session 与原身份恢复是 P00，见 [Durable Runtime 健康](behavior/session-recovery.md#durable-runtime-健康)。

## 各层替人吸收什么

| 层 | 时间尺度 | 替人吸收 | 向人或上层交出 | 规则所在 |
| --- | --- | --- | --- | --- |
| 执行底座 | 毫秒到秒 | 各家 Agent CLI 的原生协议与终端字节 | 进程、语义与输入就绪各自的状态，明确的未知，操作回执 | [Agent 全局状态](behavior/agent-capabilities-and-messaging.md#agent-全局状态唯一事实与投影) · [Terminal、历史与成本](behavior/terminal-reading.md) |
| Focus | 秒到分钟 | 每个执行 Agent 的状态与待答请求 | Attention、Working、Results、Idle／Recovery 四组与准确计数；转入完成、Needs you 或失败且用户看不到时一次通知 | [Focus 执行上下文](behavior/focus-context.md#focus-执行上下文项目泳道与底部时间音轨) · [跨会话注意力与系统通知](behavior/settings-and-observation.md#跨会话注意力与系统通知) |
| Space | 分钟到小时 | 全部项目、Tab、Region 与绑定 | 稳定的位置；折叠后卷上来的后代注意力，需要回答与错误同时存在时都保留；重启后原位恢复的工作面 | [对象树与真实注意力](behavior/spaces-and-layout.md#对象树与真实注意力) · [冷启动按需恢复](behavior/session-recovery.md#冷启动按需恢复p0-末位) |
| Goal | 小时到天 | 多条执行、委派、报告与证据 | 每条执行一个下一步负责人；人给出意图与关键取舍，确认目标、接受结果 | [Goals](behavior/goals.md) |
| Mote | 周到月 | 成员的工作与回流、目标与未完成的承诺，以及它所在会话和本地环境里发生的事 | 一位长期搭档、一条主对话；把值得做的事主动转成 Goal、成员工作与回看，有结果或需要人决定时适时找人，没有变化时不出声 | [Mote 与 PMO 协调](behavior/motes-and-coordination.md) · [主动感知与外部沟通](behavior/motes-and-coordination.md#主动感知与外部沟通) |
| 知识 | 月到年 | 浏览研究、Note 与 Agent 的工作经验 | 显式保存的成果、授权范围内写回的记忆与 Topic 知识、经人确认转正的经验；Mote 与 Topic 的原文件在新 Session 启动时载入 | [Survey／Recall 工作流](behavior/knowledge-workflows.md) · [会话入口与原文件记忆](behavior/motes-and-coordination.md#会话入口与原文件记忆) · [Topics 知识库的层级与沉淀](behavior/spaces-and-layout.md#topics-知识库的层级与沉淀) |

按时间尺度读这几层，与 Simon（1962）对层级系统的观察一致：低层变化快，高层变化慢。时间尺度只是理解分工的读法，不是源码中的显式分层，也不是新的导航分组或空间实体；表中 Space 指空间模型与 Space 入口，知识层横跨 Topic、Recall 与 Mote 记忆。表中越靠上，信号越多、变化越快；越靠下，对象越少、保存越久。各层不是严格的上下堆叠，每一层把它覆盖对象的大量变化收成少量需要人或上层知道的事。

## 省下注意力的做法

### 只在转变时出声

- 后台 Agent 转入完成、Needs you 或失败，且用户看不到该 Session 时，才发系统通知。同一状态的重复上报和第一次看到的 Session 不算转变，否则一屏早已完成的 Agent 会连发通知，让用户学会忽略这个通道；用户正在看的那一个不打扰。见[跨会话注意力与系统通知](behavior/settings-and-observation.md#跨会话注意力与系统通知)。
- 折叠的对象把后代的注意力卷上来；热度变化不改变对象顺序，保住空间记忆。见[对象树与真实注意力](behavior/spaces-and-layout.md#对象树与真实注意力)。
- 普通 A2A 来信默认把正文留在 Inbox，在接收方确认空闲的投递机会按顺序有界合并为引用通知，由 Agent 按 ID 取信，不逐条打断；发送方仍可显式选择立即通知。见[A2A 引用通知与主动取信](behavior/a2a-collaboration.md#a2a-引用通知与主动取信)。
- Mote 主动工作，但只在有事时出声。主 Agent 的心跳检查当前目标、成员工作、待处理决定、未完成承诺和尚未查看的会话事件，在已授权的范围内继续推进；没有变化就安静结束，感知不另开计时器，也不逐条消息唤醒 Agent。需要找人时说明发生了什么、已经做了什么、需要人决定什么，不叠问、不刷屏，同一决定不在多处催问。见[主对话的自动接回](behavior/motes-and-coordination.md#主对话的自动接回)与[主动感知与外部沟通](behavior/motes-and-coordination.md#主动感知与外部沟通)。

### 只让人做必须由人做的事

- Goal 中，整理目标与成功标准由 Agent 承担；人给出意图与关键取舍，确认目标、接受结果，持续推进另需人单独授权。普通接受只面向当前已确认、非空且每条都有当前检查与依据的结果。见[目标确认与结果接受](behavior/goals.md#目标确认与结果接受)。
- 委派报告待回收，或执行 Run 权威退出、中断时，先给准确的 Supervisor 一次提示，不算作人的步骤。任务停滞时，告警指明停滞与准确负责者；人点一次「PMO 巡查」，请求就送到准确的管理 Session。见[委派回报与责任接续](behavior/goal-execution-and-supervision.md#委派回报与责任接续)与[执行责任、停滞告警与 PMO 巡查](behavior/goal-execution-and-supervision.md#执行责任停滞告警与-pmo-巡查)。
- Needs you 的集中入口直接显示具体 Session 与请求：有结构化请求时给出可执行的回答，没有时定位原 Session 和真实状态；处理完进入下一项，并能回到原工作面。见[注意力处理与结果审查闭环](behavior/agent-capabilities-and-messaging.md#注意力处理与结果审查闭环)。
- 人不必在会话、平台和代码托管之间搬运消息、催办或找回上下文：Mote 把跨来源的线索串起来，沿原能力转成 Goal、成员工作与回看。外部消息里的要求只是线索，不构成授权；合入、发布、对外发言、删除或付款等有外部后果的动作，先向创建者说明依据和影响并取得明确确认。见[主动感知与外部沟通](behavior/motes-and-coordination.md#主动感知与外部沟通)。
- 经验转正由 Agent 从原 Session 提炼候选，人审阅、修订并选定目标 Mote 或 Topic 后，明确确认把这份候选交给这个目标学习；候选或目标一变，旧确认不再授权。见[Agent 工作经验的转正](behavior/knowledge-workflows.md#agent-工作经验的转正)。

### 中断后沿原身份接上

- 重启后先恢复 Tab、Group、Region、布局、焦点、草稿与可读历史，健康 Run 自动接回。Run 已结束或丢失的 Session，最后一次主会话活动仍在自动恢复时间窗内的才自动续接；超窗或时间未知的由用户按需恢复，冷启动不批量拉起长期闲置的 CLI。见[冷启动按需恢复](behavior/session-recovery.md#冷启动按需恢复p0-末位)。
- 恢复沿原 Session 与原生身份进行，失败时不暗中降为新的空会话。见 [Durable Runtime 健康](behavior/session-recovery.md#durable-runtime-健康)。
- 把 Agent 移到别的 Tab 或 Region 只改变展示位置，不改变它的 Session、Run 与执行目录。见[统一概念与空间寻址](behavior/spaces-and-layout.md#统一概念与空间寻址)。
- 人格与记忆文件只在新 Session 启动时载入，编辑人格不打断正在工作的 Agent。见[会话入口与原文件记忆](behavior/motes-and-coordination.md#会话入口与原文件记忆)。

### 成本只随相关对象增长

- 热路径的工作量随真正相关的消费者和事实增长，不因无关 Session 放大。见 AGENTS 的[工作面恢复与终端阅读](../../AGENTS.md#工作面恢复与终端阅读)。
- Goals 的扫描随可见目标与实际关联的 Session 增长，不为每张卡挂载终端，也不因无关输出重算全部目标。见[目标确认与结果接受](behavior/goals.md#目标确认与结果接受)。
- 长时间隐藏、超出热保留数量的工作面可以冷停，停放有闲置时限、数量上限与冷却期；重新附着从上次读到的位置继续，超出保留范围的部分在终端外明确标为缺口。见[Tabbar 与切换保活](behavior/spaces-and-layout.md#tabbar-与切换保活)与[终端历史读取与投递确认提示](behavior/terminal-reading.md#终端历史读取与投递确认提示)，当前机制见[隐藏工作面与冷停](../architecture/terminal-runtime.md#4-隐藏工作面与冷停cold-park)。

## 对 Agent 集群调度的意义

说到 Agent 集群调度，常见的对象是推理资源，或一次运行内部的子任务。AgentMux 不调度模型推理，也不接管各 CLI 自己的模型循环与上下文管理（见 [Agent 全局状态](behavior/agent-capabilities-and-messaging.md#agent-全局状态唯一事实与投影)）。它调度两样东西：

- **工作的责任。** Goal 为每条执行指明当前阶段与下一步负责人。负责人身份、进程在运行或界面焦点都不能单独证明谁在执行，执行绑定只来自原 Goal 的开始、原 Core 输入或核对过来源的委派关联。见[执行责任、停滞告警与 PMO 巡查](behavior/goal-execution-and-supervision.md#执行责任停滞告警与-pmo-巡查)与[委派回报与责任接续](behavior/goal-execution-and-supervision.md#委派回报与责任接续)。Mote 是工作进入这条责任链的入口之一：它把感知到的事转成有负责人的 Goal、成员工作或回看，线索不停在聊天里。
- **人的注意力。** 人收到的提醒只随需要人的状态转变增加；同一状态的重复上报、第一次看到的 Session 和用户正在看的那一个都不增加提醒。人只在需要人决定的环节进入责任链；普通接受要求逐条有当前检查和依据，缺项、差距与未知如实交给人判断。

两者相连：下一步能交给执行 Agent 或管理者的越多，需要人处理的就越少。Agent 越多，需要人的转变仍会越多，这部分成本见下文边界。

## 边界

- 两段时间的公式给出的是上限，实测通常远低于估算：上文的网络作战仿真是 7.43 对 2.27。多无人机监督中，把等待（主要是重新弄清现场）计入模型后，容量预测最多下降 67%（Cummings 与 Mitchell，2008）。
- 收益取决于工作能否拆开：可分解的任务上，多 Agent 最多比单 Agent 高 80.8%；顺序规划类任务上，所有多 Agent 变体都下降 39%–70%（Kim 等，2025）。同一代码库上的 Agent 往往并不相互独立。AgentMux 面向的是许多彼此独立的目标并行推进，不是 Agent 越多越好。
- 人的监督与管理能力是多任务 Agent 的主要限制（Mozannar 等，2025）。主观感受不能当作效率证据，见上文 Becker 等的试验。
- 未知也要人判断，不是零成本的状态；它的数量与停留时间列入下文的验证量。
- Space 的依据是空间记忆与恢复线索的研究（Robertson 等，1998；Iqbal 与 Horvitz，2007）。对象多了以后，只靠位置找东西不如按名字找（Jones 与 Dumais，1986），所以对象树提供按名称、摘要、路径与 Host 的就地查找，见[对象发现与创建](behavior/spaces-and-layout.md#对象发现与创建)。
- Mote 的价值在主动闭环，以及身份、承诺与记忆的一致；没有证据表明人格本身能提升编码任务的表现。拟人化会让信任在 Agent 出错后更不容易下降（de Visser 等，2016），可能推迟校准，所以人对 Mote 的信任仍按协议事实与结果记录校准。
- 主动本身也花人的注意力。混合主动界面的经典原则要求按收益、打扰的代价和对用户目标的把握决定是否行动，并按人的注意力安排时机（Horvitz，1999）。一项编程助手的随机实验中，主动建议让完成的任务多出 12%–18%，但提高建议频率后，相对基线更偏好主动助手的被试减少一半（Chen 等，2025）。该实验是编辑器里的单次任务，不是跨天的长期搭档；Mote 主动消息的数量与有用比例列入下文的验证量。

## 怎样验证

「多层注意力能提高一个人有效带动的 Agent 数」目前是有间接依据的假设：多数层的做法有经典研究或同行实证的间接支持，Space 与 Mote 缺少 Agent 场景的直接证据。目前没有找到测量一个人跨多天监督数十个编码 Agent 实际跨度的研究，AgentMux 也还没有测过。

以下是提议的验证量，产品目前尚未采集；正式口径应写进[测试策略](../testing/strategy.md)或 benchmark 文档。验证时在版本之间比较：

1. 产品内跨度：每分钟由 Core 协议事实确认正在工作的 Agent 数。
2. Needs you 响应时间：从 Agent 需要人，到人处理完。
3. 切换后的恢复时间：从回到一个 Agent，到人对它做出下一次输入、回答或接受。
4. 无需处理的通知（含 Mote 的主动消息）在全部通知中的比例。
5. 每个被接受的结果花掉的人审阅时间。
6. 未知状态的数量与停留时间。

只报告「能同时运行多少 Agent」，说明不了人的注意力花在了哪里。

## 研究依据

- Altmann, E. M., & Trafton, J. G. (2002). Memory for Goals: An Activation-Based Model. *Cognitive Science* 26(1):39–83.
- Becker, J., Rush, N., Barnes, E., & Rein, D. (2025). Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity. arXiv:2507.09089.
- Chen, V., Zhu, A., Zhao, S., Mozannar, H., Sontag, D., & Talwalkar, A. (2025). Need Help? Designing Proactive AI Assistants for Programming. CHI 2025.
- Crandall, J. W., Goodrich, M. A., Olsen, D. R., & Nielsen, C. W. (2005). Validating Human–Robot Interaction Schemes in Multitasking Environments. *IEEE TSMC-A* 35(4):438–449.
- Cummings, M. L., & Mitchell, P. J. (2008). Predicting Controller Capacity in Supervisory Control of Multiple UAVs. *IEEE TSMC-A* 38(2):451–460.
- de Visser, E. J., et al. (2016). Almost Human: Anthropomorphism Increases Trust Resilience in Cognitive Agents. *Journal of Experimental Psychology: Applied* 22(3):331–349.
- Horvitz, E. (1999). Principles of Mixed-Initiative User Interfaces. CHI 1999, pp. 159–166.
- Iqbal, S. T., & Horvitz, E. (2007). Disruption and Recovery of Computing Tasks: Field Study, Analysis, and Directions. CHI 2007.
- Jones, W. P., & Dumais, S. T. (1986). The Spatial Metaphor for User Interfaces: Experimental Tests of Reference by Location versus Name. *ACM TOIS* 4(1):42–63.
- Kim, Y., et al. (2025). Towards a Science of Scaling Agent Systems. arXiv:2512.08296. 所引数字出自比较 260 种配置的版本；早期版本的数字不同。
- Mancuso, V. F., Funke, G. J., Eckold, M. B., & Strang, A. J. (2015). Human Span-of-Control in Cyber Operations: An Experimental Evaluation of Fan-Out. ISAP 2015.
- Mozannar, H., Bansal, G., et al. (2025). Magentic-UI: Towards Human-in-the-loop Agentic Systems. arXiv:2507.22358.
- Olsen, D. R., & Wood, S. B. (2004). Fan-out: Measuring Human Control of Multiple Robots. CHI 2004.
- Robertson, G., et al. (1998). Data Mountain: Using Spatial Memory for Document Management. UIST 1998.
- Sendelbach, S., & Funk, M. (2013). Alarm Fatigue: A Patient Safety Concern. *AACN Advanced Critical Care* 24(4):378–386.
- Simon, H. A. (1962). The Architecture of Complexity. *Proceedings of the American Philosophical Society* 106(6):467–482.
- Simon, H. A. (1971). Designing Organizations for an Information-Rich World. In M. Greenberger (Ed.), *Computers, Communications, and the Public Interest*, pp. 37–72. Baltimore: Johns Hopkins Press.
