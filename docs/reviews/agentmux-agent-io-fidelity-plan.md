# Task Plan Review — AgentMux Agent Address, Envelope and Terminal Fidelity

日期：2026-08-29
Plan revision：1
设计 SSOT：`docs/design/agentmux-desktop-interaction.md`（《寻址与复制》《AgentMux 对 Agent 说的话》《启动握手与自命名》《Agent Composer 与 Terminal》四节）

## 结论

**approved.** 六个 task 各自可独立验收。T-001 先做——它是唯一有用户实测复现的缺陷。

## 需求来源

用户在同一轮里给出三批需求，原话为：

> 加个需求: Agentmux 给 Agent 发消息的实现内聚到统一模块，然后做的更加结构化，比如可以用
> `<amux from='amux' ...> .... </amux>`
> 另外, 当起名能力齐全了以后, 可以在欢迎语句里头给出指令 agent 给自己起名

> shift + enter, 正常在 Claude 的 TUI 里头应该是换行，但是在 Agent_Marks 里面打开的话，
> 它就直接发出去了。看看是不是抄 a mature workbench 没抄对

> 这个 shift + enter 对不对, 以及能不能选中 copy, 要放进需求细节和测试集, 因为容易出错.
> 而且要仔细 review 这里是照抄 a mature workbench, 还是自由发挥了

> 终端要像终端, 说的很好, 不像终端不光用户理解不了, 我们的复杂度也很高

以及用户转来的一份他人 review（五条，P0 三条 P1 两条），要求"这些也加入 feature"。

## 对转来的 review 做了什么

逐条核对源码后，五条里**三条前提成立、一条需要修正、一条要缩范围**：

1. **启动握手（P0）——成立。** `agent-launch-prompt.ts:1-2` 的全文只说"需要分屏/终端/浏览器时
   运行 `--skill`"，确实没有任何启动握手。Agent 直到想开分屏那一刻才知道自己在 AgentMux 里。
   落为 T-004。但 review 建议的 `"$AGENTMUX_CLI" context` **这个 verb 不存在**——CLI 现有
   verb 只有 inspect/list/open/send/discuss/focus/arrange/output/interrupt/resume/stop
   （`agentmux.ts:391-402`）。所以 T-004 含新增该 verb，不能假定它已在。
2. **交接默认精确地址（P0）——需要修正措辞。** review 说"当前 View 文本虽然正确，但仍把前提
   留给接收方判断"。核对 `agent-address.ts:64-73`：View 地址**显式声明**了自己的前提，并指明
   分屏时改用 Region 地址——它没有把判断藏起来。真正的缺口在**入口**不在文案：Tab 右键菜单的
   首项是 `Copy View Address`（`WorkbenchTabContextMenu.tsx:62`），`Copy Session Address`
   是条件次项（`:68`）；且**没有任何入口叫"给这个 Agent 发消息"**。所以 T-003 改的是入口命名
   与解析顺序，不是重写 View 文案（那会把一段本来诚实的文字改坏）。
3. **失败结果带恢复命令（P0）——成立。** `MESSAGE_TARGET_NOT_UNIQUE` 确实只有 `candidates`
   （`control.ts:171-177`），无可执行命令。落为 T-003 的一部分：恢复命令与复制地址共用同一个
   格式化出口，不为错误路径另写一份拼接。
4. **Handoff 提成 CLI 动作（P1）——成立但要缩范围。** `agent-handoff.ts` 确实已区分 Handoff
   与 Dispatch（唯一边界是 `originAwaits`，`:17`/`:73`），`client.handOff()` 也在（`client.ts:805`），
   但没有 CLI verb。落为 T-005。**但 review 里"原子完成 delivery receipt"这半句要按下**：
   receipt/ledger 属于已否决的 T-019（见下）。T-005 只做"把已有的 Core 能力接到 CLI 上"。
5. **对话组件一键 Fork/Handoff（P1）——成立。** 转写/对话组件今天**没有任何**逐条消息动作
   （`ActivityView.tsx` 只有时间轴与折叠交互），delivered/failed 也没有真实展示——唯一出现处
   是 `BoardDiscussionCanvas.tsx:214-220` 一句硬编码的发送前提示。落为 T-006，排最后。

## 与已否决的 T-019 的边界（重要）

同仓 `f-2248f4yx5/T-019「交付 Agent 间结构化通信与 Inbox 协作」`**已被评估后决定不做**，
理由记录在 `ideas/index.md:334`：在 human-in-the-loop 的多路复用器里**人是信任锚**，agent B
不需要密码学地信任 agent A；capability 认证、evidence 分级、幂等 ledger 那套最难的工程，
只有当 agent 自主地对彼此消息采取动作时才值钱，而那正是 `docs/plans/agent-communication.md:36`
明确否认的 coordinator 编排。

本 Feature 与它**方向不同而非程度不同**，必须守住：

- 信封（T-002）做的是**署名与可读性**——让 Agent 分得清这段文本是 AgentMux 说的还是用户说的。
  它不做认证：信封里的 `from` 是一个**声明**，不是一份可验证的凭证。
- 交接（T-005/T-006）的发起者始终是**人**。不引入 agent 自主地把任务派给另一个 agent 的回路。
- 因此**不得**在本 Feature 里引入 capability 签发/校验、签名 ledger、或幂等 delivery 状态机。
  需要展示 delivered/failed 时，投影 Core **已有**的 `AgentDelivery` 事实（`agent-message.ts:23`），
  不新建第二份状态机。

这条边界写在这里，是因为它极易被"顺手做扎实一点"侵蚀，而侵蚀的那一刻不会有任何测试变红。

## 逐 task 核

| Task | 独立可验收 | 备注 |
|---|---|---|
| T-001 终端 Shift+Enter 与选中复制 | 是 | 唯一有用户实测复现的缺陷，排第一；断言落在字节上 |
| T-002 出站消息模块与 `<amux>` 信封 | 是 | 四处拼接收敛为一处；用户原文不被改写有独立断言 |
| T-003 交接入口按意图命名 + 失败带恢复命令 | 是 | 复制与恢复共用一个格式化出口 |
| T-004 启动握手（含新增 `context` verb） | 是 | 依赖 T-002 的信封承载握手文本 |
| T-005 `handoff` CLI verb | 是 | 只接既有 Core 能力，不做 receipt |
| T-006 逐条消息 Fork/Handoff 与投递状态 | 是 | 依赖 T-003 的地址解析与 T-005 的 verb |

## 落地顺序

T-001 → T-002 → T-003 → T-004 → T-005 → T-006。T-001 先做因为它是实测缺陷且完全独立；
T-002 排第二因为 T-004 的握手文本要走信封；T-006 排最后因为它同时依赖地址解析与 handoff verb。

## 需要盯住的风险

- **T-001 的 kitty 协议不能假定，只能探测。** 强开 CSI-u 会让没协商过的 TUI 收到一串它不认识
  的字节——那会把一个"少了个功能"的缺陷换成一个"输入全乱"的缺陷。参考实现从 TUI 自己的 PTY
  输出里读 push/pop/set 来判断，我们也必须如此；探测不到就退回 `\x1b\r`。
- **T-001 的断言不能停在"handler 注册过"。** 那在 handler 写错时同样会绿。判据是**送出的字节**：
  Shift+Enter 与 Enter 必须产出不同的字节，且 Enter 仍是 `\r`（别修好一个弄坏另一个）。
- **T-002 不得改写用户原文。** 信封包的是 AgentMux 自己的话。一旦用户文本被塞进属性或被转义，
  复现问题时就没人知道 Agent 究竟读到了什么——这需要一条独立断言，不能靠"我们不会那么写"。
- **T-002 收敛四处拼接时，`buildPromptInputPayload` 的字节层封装（bracketed paste）不要一起卷进来。**
  它解决的是"多行文本怎么安全地进终端"，与"这段话是谁说的"是两层，混在一起会让信封被粘贴模式
  的转义规则牵着走。
- **T-003 的入口改名不要顺手重写 View 地址文案。** 核对下来那段文案本身是诚实的（它声明了自己
  的前提）。缺口在入口，不在文案；改文案只会让一段本来对的字变差。
- **T-004 的握手不得把完整 CLI 语法抄进提示。** 与 SSOT 既有那条同源：抄进去会与 skill 争夺
  唯一真相，并在语法演进时立刻过期。验收是行为断言——证明启动路径确实携带并执行了握手。
- **T-006 的 delivered/failed 必须投影 Core 已有事实。** 今天唯一的展示是一句硬编码的
  `describeDeliveryEvidence('delivered').label`（`BoardDiscussionCanvas.tsx:214-220`）——那是
  发送前的提示文案，不是投递状态。把它当成"已经有了"会让这个 task 什么都不做就通过。

## 竖切闭合要求（本 Feature 全局）

沿用同仓 `f-23a8ftmaj` 的口径：每个 task 判 done 前，对其交付的每个新符号跑一遍**排除定义
文件本身**的调用者检查（`grep -rn "<symbol>" src | grep -v test`），命中全在定义文件内即为
竖切未闭合。此条来自 `f-2248f4yx5/T-019` 的教训——12 处变异验证全绿，但七个动作在 `client.ts`
之外零调用者。变异测试证明代码被测试用到，不证明能力接到产品上。

## T-005 落地时查明：Handoff 的语义前提尚未建立

实现 T-005 时按上面这条做调用者检查，查出的不是"接线接了一半"，而是这条能力的**语义前提
本身缺席**。三层，从果到根：

1. **无存储。** `HandoffResult` 在全仓没有任何持久化落点。Agent Session 上所有 `owner*`
   字段（`lifecycleOwnerId`、`ownerId`/`ownerPid`、`runOwner`）讲的都是进程与 Run 的生命周期
   归属，与"某个任务归某个 Agent"无关。
2. **无读者。** `HandoffResult` / `ownerAgentSessionId` / `originAwaits` 在 `client.ts` 之外
   零消费者，Desktop 侧同样为空。`openDispatch` 是同一形状——两个方法都只造一个 frozen 对象
   返回。`AgentDelivery` 承载不了它：那是**一条消息**的投递状态机（queued→delivered→…），
   而 handoff 按边界不投递任何 message，硬塞一个 `ownership-transferred` 进去等于扩状态机
   兼造 receipt，正撞上面那条否决线。
3. **无实体（根因）。** `grep "^export type.*Task" packages/core/src/types.ts` 零命中——
   **Core 没有 Task 这个概念**，`taskId` 是一个不指向任何东西的自由字符串。

第 3 条决定了前两条**不能靠"补一张表"解决**：此刻加一个 `ownedTaskIds` 字段，存进去的会是
一串无人能验证有效性、无人知道何时算完成的自由文本——那比不存更糟，因为它看起来像事实。

因此 T-005 的范围守在"把已有能力接到 CLI 上"是对的，**且比原以为的更该守**：所有权要落地，
先要有一个可被指向的实体（是引入 Task，还是把所有权挂到已存在的 Thread 上），那是 Feature
级决策。T-005 交付时必须如实标注：验收「新增符号有产品调用者」**字面满足**（`client.handOff`
有了 CLI 调用者）、**用意未满足**（转移下一秒即蒸发）。不得用"机制已就绪"含混带过——
`f-2248f4yx5/T-019` 正是被这句话放行的。

## T-006 判 blocked：不是接线未完成，是依赖能力缺席

T-006 要求「delivered/failed 必须投影 Core 已有的 `AgentDelivery` 事实」（见上文风险清单）。
只读追查下来，**那条事实到不了 renderer**，而且缺的不是一根线，是三个各自独立的前提（每条都用
grep 复核过，不是推断）：

1. **词汇过了河，事实没有。** `AgentDeliveryState` 这个**类型**确实已经进了 Desktop
   （`delivery-evidence.ts:1` 从 `@agentmux/core` 导入，并为 7 个状态各备好了文案）——但
   `AgentThread` / `AgentDelivery` / `AgentMessage` 在 `apps/desktop/src/` 零出现，`ipc.ts`
   与 `preload/index.ts` 里也没有任何 delivery/thread 通道。**能描述状态的字典有了，被描述的
   那条状态从不跨进程。**这比"什么都没有"更容易误判成"接一下就行"。
2. **Desktop 的对话路径根本不产 thread。** 唯一产出带 `delivery` 的 `AgentThread` 的方法是
   `client.startDiscussion`，它只有一个非测试消费者——CLI（`agentmux.ts:277`）。Desktop 里那个
   同名的 `startDiscussion` 是**巧合**：它调 `launchBoardAgent` → `launchAgent`，走完全另一条路，
   从不产生 Core thread，也就从不推进 delivery。
3. **Core 里没有 fork 能力。** `forkAgent` / `forkThread` / `splitThread` / `cloneThread` 全部零
   命中（`client.ts` 的 `cloneSession` 是 publish 前的防御性拷贝，不是 fork）。

附带一条形状问题：`ActivityView` 渲染的是 `AgentTimelineItem`，它来自 native-hook 事件投影，
**既无 delivery 字段，也无 per-message 身份**——连一个能当作 Fork/Handoff 目标锚点的东西都没有。

**两个近似物不得拿来冒充**：session 投影上的 `terminalPromptDelivery` 是「PTY 一次 prompt 提交
的屏幕验证没走通」这一降级事实，与 `queued→delivered→accepted→replied` 的消息账本是两个概念；
`BoardDiscussionCanvas.tsx` footer 那句提示调的是正确的 SSOT helper，但参数写死 `'delivered'`，
语义是**发送前的未来时说明**而非某条消息的当前状态——它本身是诚实的，**不该改**（改它就是重演
「入口改名不要顺手重写本来诚实的文案」那个坑）。

再叠上 T-005 已确认的：handoff 结果无存储、无读者、无 Task 实体。所以即便把管道打通，UI 上
"交出去了"也只能显示那一次调用返回的 `ownerAgentSessionId` / `originAwaits`，仍然回答不了
"这任务现在归谁"。

**判 blocked 而非缩范围**：能诚实做的两半——Fork 缺 Core 能力，Handoff 投影缺数据源——缩到
最后是空。造一个假状态源能让 gate 变绿（`activity-view.test.tsx` 今天零个 delivery/fork/handoff
断言，什么都不做也全绿），但那正是本文档反复警告的东西。解锁 T-006 要先有一个前置：把
`AgentDelivery` 投影跨 IPC，并让 Desktop 的对话路径产出 Core thread；那与「所有权落点」是同一
个 Feature 级决策的两面。
