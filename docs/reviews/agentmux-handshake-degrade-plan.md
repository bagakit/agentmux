# Task Plan Review — 握手探测失败不该杀掉一个健康的 Agent

日期：2026-08-29
原则 SSOT：`AGENTS.md` 第 11 条（三种状态）
设计 SSOT：`docs/design/agentmux-desktop-interaction.md` 的《我们的流程坏了，不等于 Agent 坏了》

## 用户原话

> 有时链接报错 "Timed out waiting for the Provider terminal capability query." 退回到初始页, 之前输入过的东西没缓存

> 我觉得当然不能算坏了，也不能阻断，但是可以有一个类似服务窗之类的设计给用户提醒。我觉得这里要区分出三种状态：1. 完全坏了 2. Agent 没坏，但我们的流程坏了 3. 完全好的
> 原则上不能因为我们的流程问题，让原本已经跑通的 Agent 受阻，这是绝对不允许的。

用户报告的是一个症状，底下是两件独立的事：**输入丢了**（已修，commit `e92fc6d`），
和**一次探测超时杀掉了一个活着的 Agent**（本文档）。第二件才是原则 11 的正题。

## 结论

**approved**。四个调用点全部要改，但改法不是同一种——其中三个是"别 throw"，
第四个（提交 prompt）性质不同，是"根本不该拦在这里"。

## 这次探测在做什么

`ensureTerminalHandshake`（`packages/core/src/client.ts:1930-2228`）不只是观察。它：

1. 从 daemon 的 `run.acceptedInputBytes` 取当前 input 游标作为 `startByte`（`:2055`）
2. 预留 `[startByte, startByte+responseBytes)` 这段区间，**先落 receipt 再写**
3. 用 `expectedByte` 栅栏把 `[?0u` 写进 `kernel.input`（`:2154-2170`）

所以它确实建立了一条真实的不变量：**`[?0u` 这个回复恰好送达一次，且位置被栅栏钉死。**
`operationId` 是确定性的，崩溃重连也不会重复送。

**但它不是后续输入的必经栅栏。** 每条 prompt 路径自己都会兜底到 daemon 的权威游标：

- `submitAgentInputPlan`：`this.agentInputCursors.get(...) ?? run.acceptedInputBytes`（`:2238`）
- `writeAgentInput`（`:2969`）、native interaction response（`:2840`）同样

没有 handshake 的 provider 走的就是这条（`:1937-1939`）。所以**跳过 claim 之后写出的 prompt
依然是被栅栏保护的**——用的是 daemon 自己的游标。降级损失的只有两样：`[?0u` 那个回复，
和首条 prompt 的 readiness 锚点。两样都不致命。

## 关键判断：降级会不会让按键编码错掉

这是降级唯一真正危险的地方——如果不回 `[?0u` 会让 codex 改用另一种按键编码，而我们
这边还按老编码送，那**静默降级比 abort 更糟**，直接违反原则 11 的第一条边界。

**答案是不会，因为渲染层根本不从我们的回复推断编码，它读 codex 自己的声明。**

Shift+Enter 的决策链是 `shiftEnterInput`（`terminal-shortcuts.ts:45`）→ `isKittyKeyboardActive`
（`terminal-kitty-keyboard.ts:92`）→ 只由 codex 的实时 PTY 输出喂入（`TerminalView.tsx:414,448`）。
而那个 parser 只匹配 kitty 的**推入/弹出/修改**序列：

```
terminal-kitty-keyboard.ts:34   const KITTY_SEQUENCE = /\[([>=<])([0-9;]*)u/g
```

它刻意不匹配查询/应答形式的 `CSI ? u`。渲染层的能力应答器只回 OSC 颜色槽 10/11
（`terminal-capability-replies.ts:18`），从不回 `[?u`；全仓 `[?0u` 只在 codex provider
定义一处（`agent-provider.ts:716-717`）。**Core 的握手是 `[?u` 的唯一应答方。**

于是两条分支都自洽：

- 回了 → codex 若认定支持并推 `CSI > flags u`，渲染层看见 → Shift+Enter 送 CSI-u
- 降级不回 → codex 若认定不支持、不推 → 渲染层什么也没看见 → 送 `ESC CR`，而 codex 正按
  legacy 解析 → 字节正确

两边始终配对，因为渲染层跟的是 codex 的宣告，不是我们的回复。

**唯一的空洞（诚实标注，未验证）**：这条推理依赖 codex 遵守 progressive enhancement 的约定
——推入才算启用，查询无人应答就当不支持。若 codex 在查询没等到回应时按某个内部默认
**启用了 kitty 输入解码却不发 `CSI > flags u`**，渲染层就会漏看，Shift+Enter 会错。这违反协议
本身的定义，但那是 codex 的行为，不是我们的。

判定实验：在 ctxmux 下跑 codex 两次，一次保留 `[?0u` 写入、一次屏蔽，各自抓原始 PTY 输出，
比较 (1) 是否出现 `CSI > flags u`，(2) 物理 Shift+Enter 被如何解释。若屏蔽后解释变了却没有
对应的 push，降级不安全，必须换路把 `[?0u` 送出去再继续。

## 四个调用点，逐个定性

| 调用点 | 路径 | 超时时 Agent 还活着吗 | 类别 | 处置 |
|---|---|---|---|---|
| `client.ts:492` | connect 重连循环 | 几乎总是——正在接一个已在跑的 run | **第 2 类** | 降级。**当前危害最大** |
| `client.ts:999` | launch / createAgent | 是——冷启动慢 | **第 2 类**（run 已退出则第 1 类） | 超时降级；仅进程退出才中止 |
| `client.ts:1274` | resume | 同上 | **第 2 类**（同上） | 同上 |
| `client.ts:1504` | submitAgentPrompt | 是——run 一直活着 | **第 2 类** | **性质不同：根本不该拦在这里** |

**`:492` 是灾难级的。** 循环对每个 running session 调一次握手（`:489-493`），任何 throw 被
`:498-502` 接住后执行 `this.kernel.disconnect()` 并 rethrow——**一个 session 的握手超时会拆掉
整条 client 连接，把所有健康的 Agent 一起带走。** 这是原则 11 的教科书式违例。而且 `[?u` 是
codex 启动时的一次性输出，重连时只能靠 `attach(runId, 0)` 的 replay 看到（`:2048-2050`）；
一旦滚出保留区就再也不会重来——等更久没有任何用。中止损失整条连接，继续只损失一个
早已过期的回复。

**`:999` / `:1274` 在 throw 时会回滚**：关 hook 绑定、退休 run、删/退 session
（`:1000-1021`、`:1275-1299`）。这是在用我们一次慢探测**杀掉一个刚启动好的健康 Agent**。

**`:1504` 性质不同。** 它不是生命周期路径——run 早就活着，用户此刻正在提交 prompt。这里的
握手是一句"写之前顺手确认一下"（不带 `knownRun`）。它超时，throw 直接冲出 `submitAgentPrompt`，
**用户这条 prompt 被拒。** 更糟的是：`[?u` 是一次性启动输出，对一个几分钟前启动的 run 早已
不可达，于是**每一条 prompt 都会被永久挡住**。这是"我们的流程坏了挡住能干活的 Agent"最
直接的形态。它绝不能成为 prompt 的前置门：握手状态没满足就照发（`?? run.acceptedInputBytes`
的兜底本来就够用），同时亮出降级告示。

## 超时的形状本身就错了，与时长无关

观察是**一次性的，超时即拆**：监听与定时器都在 `finally` 里释放（`:2219-2227`）。超时 reject
之后 `queryObserved` 连同死掉的 promise 一起被丢弃，订阅没了。**10.1 秒才到的合法 `[?u`
被永久忽略**——没有重新武装，没有升级路径。

所以这跟"10 秒太短"是两个 bug：再有耐心的用户也等不到，因为已经没人在看了。

叠加上 `[?u` 的一次性：在 `:492` 与 `:1504` 这两个点上，"等更久"是完全错误的杠杆——正确
行为是扫 replay，扫不到就**立刻**降级，而不是为一个不可能再发生的事件白等 10 秒。

## 降级要做对的五件事

1. **只接超时，不接一切。** `AGENT_TERMINAL_HANDSHAKE_TIMEOUT`（`:2040-2045`，第 2 类 → 降级）
   要与 run 退出时抛的 `AGENT_TERMINAL_HANDSHAKE_FAILED`（`:2033-2038`，第 1 类 → Agent 真没了，
   诚实中止）分开。`..._STATE_INVALID` / receipt 不匹配保持 fatal——那是数据损坏，不是慢探测。
2. **从 daemon 播种输入游标。** 降级时照抄已有的无握手分支（`:1937-1939`），用
   `run.acceptedInputBytes` 设 `agentInputCursors`，让首条 prompt 栅栏正确。
3. **绝不伪造已确认的握手。** 没送 `[?0u` 却写 `acknowledged: true`，是在受据上撒谎，之后会
   撞上 `acceptedInputBytes >= endByte` 的断言（`:2143-2148`、`:1993-2001`）并污染崩溃恢复的
   幂等性。让 `terminalHandshake` 保持未设（状态＝未知），而不是编一个。
4. **记下"能力未知/降级"并显示服务窗告示。** 今天**没有这个字段**——core 与 renderer 里
   grep `degrad`/`serviceWindow`/`capabilityUnknown` 全空。必须新增：静默降级本身就是违例
   （`AGENTS.md:50-51`、设计文档第 85 行）。
5. **修 `:492` 的爆炸半径。** 即便有了前四条，也要保证 connect 循环把单个 session 的握手问题
   当作单个 session 的事，永不为它 `kernel.disconnect()`。

## 边界（不做什么）

- 不为"等更久"加配置项。时长不是杠杆，形状才是。
- 不把 `[?0u` 改从渲染层回——那会让能力应答分成两处，且渲染层只该回它自己知道的事
  （颜色槽）。
- 不引入第二条失败通路。降级状态走既有的 session 投影到渲染层。
- codex 的按键编码实验未做之前，**不宣称降级已验证安全**——按原则 11 的第二条边界，
  分不清就说分不清。

## Task 核

| Task | 独立可验收 | 备注 |
|---|---|---|
| 服务窗机制（分类器 + 告示） | 是 | 原则 11 的公共底座，两个消费方共用。纯函数承重。 |
| 四个调用点降级 | 是 | 依赖上一条有落点。超时/退出分流 + `:492` 爆炸半径 + `:1504` 不拦 prompt。 |
| codex 按键编码实验 | 是 | 双跑抓 PTY 对比。结论若为不安全，降级方案要改。 |
