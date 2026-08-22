# Browser 通用能力协议：选型、缺口与竖切顺序

状态：架构决策与 reviewed task plan 的评审输入，待用户 review
日期：2026-09-20
Feature：`f-27c8fr4x2`（Browser 通用能力协议与 CLI/Skill 接入）
方法：先读现状再定方案；全部结论附 file:line，缺席结论附证伪命令

---

## 0. 结论先行

**本 Feature 的主体不是"新建一个协议"，而是"把已经存在的协议补成唯一入口"。**

`browser.run` / `browser.history` / `browser.replay` 已经在同一个 `browser` 命名空间里、
已经在同一个 typed union 上、已经过同一个 `OPERATION_BUDGET` 穷尽表
（`control.ts:239-255`、`control.ts:442-444`）。四分类结局是真类型
（`control.ts:274-278`）。journal 已经 durable 且重启后会把活着的操作转成 `indeterminate`
（`browser-operation-journal.ts:329-368`）。

所以需求里"建立可复用入口"这句话，落到代码上是**五个具体缺口**（§2），而不是一层新抽象。
把它写成"设计一个新协议"会得到一个大而空的适配层，违反交付约束最后一条。

**传输选型结论：不引入 JSON-RPC，继续用现有 NDJSON-over-unix-socket，并把它从
"一问一答"扩成"一问一答 + 可选事件流"。** 论证见 §3，这是本文档最主要的取舍。

---

## 1. 现状事实（读出来的，不是推的）

### 1.1 协议层已有的

| 事实 | 位置 |
| --- | --- |
| 三个 browser 操作在同一 union、同一命名空间 | `control.ts:204-238`、`239-255` |
| 操作档位由唯一穷尽表决定，缺键即 TS2741 | `control.ts:424-445` |
| 合法操作名判定**派生**自那张表，不是第二份手抄 | `control.ts:473-474` |
| 四分类结局是一等类型，且解析层拒绝折叠未知 | `control.ts:274-278`、`control-host.ts:539-546` |
| 请求/回执两侧各有 `never` 穷尽出口 | `control-host.ts:316`、`557` |
| Core 对 Browser 语义**故意保持不透明**（`steps: unknown[]`） | `control.ts:280-294`、`296-302` |

### 1.2 运行时已有的

| 事实 | 位置 |
| --- | --- |
| journal 持久化走 core 的 `durableWriteFile`（tmp→fsync→rename→dir-fsync） | `browser-operation-journal.ts:95-102`、`durable-write.ts:22-54` |
| 重启后活着的操作转 `indeterminate` + `operation-recovered` 事件 | `browser-operation-journal.ts:145`、`329-368` |
| journal 已有完整事件模型（6 种事件） | `browser-operation-journal.ts:26-63` |
| 停止链路已存在：`AbortController` → SIGKILL 子进程 | `browser-view-manager.ts:667`、`714-730`、`browser-script-runner.ts:269-273` |
| 人工接管优先已是活的不变量 | `browser-view-manager.ts:645-647`（拒绝新 run）、`698-712`（首次真实输入即翻转） |
| 接管后只拒动作、放行观察 | `browser-view-manager.ts:213-224`、`1047` |
| 页面函数唯一真清单（18 个名字） | `browser-script-runner.ts:44-67` |
| 回放白名单**派生**自那份清单，不是手抄 | `browser-view-manager.ts:144` |

### 1.3 CLI 已有的

- 输出是稳定机器契约：`printSuccess` 写 `{schemaVersion,requestId,ok,operation,result}`
  （`agentmux.ts:142-144`），失败走 stderr 且**保留 error.code**（`agentmux.ts:660-673`）。
- **已经存在 NDJSON 流式信封**：`printStream` 多一个 `event` 字段（`agentmux.ts:145-147`），
  `output --follow` 用它（`agentmux.ts:471-481`）。**这一条决定了 §3 的选型。**

---

## 2. 五个缺口（每条附证伪命令）

### 缺口 A — Skill 的能力清单是手抄 prose，不是生成的

`AGENTMUX_CLI_SKILL` 是模板字面量（`agentmux-cli-help.ts:277`），页面函数名手写在
`:148-149` 与 `:363-366`。真清单在**另一个包**
（`browser-script-runner.ts:44-67`）。

唯一的连接是一条扫描测试（`browser-drive-doc-consistency.test.ts:185-204`），它自己在注释里
承认"两者分属两个包、不在同一条构建图上，skill 那份只能手抄"。

**且那条测试用的正是本仓反复踩过的 `indexOf` 锚点式切片**（`:193-197`）：
`## Drive an open Browser` 一旦改名，`indexOf` 返回 -1，`slice` 切出空串或过宽段，
之后每条 `toContain` 恒真。它自己加了 `section.length > 200` 自检，是对的一半；
但锚点在场 ≠ 锚点切的是那一段。

证伪：`grep -rn "'snapshot'" packages/core/src/` → 空（core 没有副本）。

### 缺口 B — 空程序守卫只在 CLI，协议层放行

`agentmux.ts:544-548` 拒绝空程序。协议侧 `control-host.ts:252-266` 只过 `text()`，
而 `text()` 接受空串（`control-host.ts:64-68`）。

**这一条同时是"CLI 不薄"的样本和一个协议缺口**：直连协议的客户端发空程序会得到一次
"跑了但什么都没做"的成功——正是 CLI 注释警告的那种不可区分结局。

证伪：`grep -n "trim" packages/core/src/control-host.ts` → 无 code 相关命中。

### 缺口 C — 没有任何协议路径可以取消一个在飞的操作

停止只有两个触发点，都够不着协议：人工输入事件（`browser-view-manager.ts:698-712`）、
Renderer 专属 IPC `browser:stopOperation`（`ipc.ts:705-708`）。

证伪：`grep -rn "'browser\." packages/core/src apps/desktop/src | grep -oE "'browser\.[a-z]+'" | sort -u`
→ 只有 `browser.history` / `browser.replay` / `browser.run`。

### 缺口 D — operationId 在操作结束前拿不到，因此"跨连接查询"没有入口

`operationId` 在 `browser-view-manager.ts:670` 由 `randomUUID()` 铸出，只在**终局回执**里
露出（`control.ts:323-332`）。socket 是严格一问一答（`control-host.ts:674-703`）。

于是链条断在第一环：**Agent 手上永远没有一个可用于查询的 id**，直到操作已经结束。
journal 的 `get()` / `events()` 已实现（`:291-308`）但**零生产调用方**
（`ipc.ts:146-148` 构造时不传 options）。

### 缺口 E — Renderer 绕过协议，存在两条入口

`contracts.ts:1415-1419` 给 Renderer 一套自己的 `listOperationHistory` / `replayPlan` /
`runReplay` / `stopOperation`；`BrowserPane.tsx:350` 直接调 `api.browser.stopOperation`。
Control 那条路进到 Renderer store 之后，又落回同一批 `api.browser.*`。

两条路在 Renderer 汇合，**但语义各自维护**：`stopOperation` 只有 IPC 一侧有。

---

## 3. 传输选型：为什么不是 JSON-RPC

需求明确"JSON-RPC 不是预设答案"，所以按六个判据逐条比，而不是按流行度。

### 候选

1. **A：现有 NDJSON over unix socket，扩成一问一答 + 可选事件流**
2. **B：JSON-RPC 2.0（含 notification 做事件）**
3. **C：gRPC / protobuf**
4. **D：直接上 MCP**

### 逐条对比

| 判据 | A 现有扩展 | B JSON-RPC | C gRPC | D MCP |
| --- | --- | --- | --- | --- |
| 现有实现改动量 | 最小：框架、错误码表、穷尽表全复用 | 要替换整个 `parseAgentMuxControlRequest`/`Receipt`，14 个操作全改 wire 形状 | 要引入 codegen + 运行时依赖 | 要先有一个 server 生命周期，且它本身就要一个下层传输 |
| 跨语言接入 | NDJSON + unix socket，Python/Go/Rust 都是几十行；**真正的障碍不是格式而是 socket 路径发现**（见下） | 同样容易，且有现成库 | 最好（有 stub），但代价是全仓引入 protobuf | 生态好，但它的定位是"给模型用的工具面"，不是"给客户端用的能力协议" |
| 事件订阅 | **仓内已有同形先例**（`printStream` + `output --follow`），复用同一信封 | notification 天然支持 | streaming 天然支持 | 有 notification |
| 取消 | 需新增一个 operation（与现有 14 个同形） | 有 `$/cancelRequest` 约定，但它取消的是**请求**，而这里要取消的是**operation**（跨连接、比请求命长）——语义不对口 | 有 context 取消，同样是请求级 | 同 B |
| 重连 | journal 已 durable，重连即重读（与 ctxmux replay/gap 同一房规） | 协议本身不管重连 | 同 | 同 |
| 演进成本 | `schemaVersion` 已在场且被校验（`control-host.ts:581`）；AGENTS.md:21 禁兼容层，所以**版本化的表面越小越好** | 换 wire 是一次性大改，且换完并没有让表面变小 | 最高 | 最高 |

### 决定

**选 A。** 三条理由，按权重：

1. **取消的语义不对口，这是最硬的一条。** JSON-RPC / gRPC 的取消都是**请求级**：
   "别做我刚才让你做的那件事"。而本 Feature 要的是**operation 级**：一条 CLI 连接断了，
   另一条连接凭 `operationId` 取消它。请求级取消在这里不仅不够用，还会诱导实现把
   operation 生命周期绑到连接上——正是需求明令禁止的那件事
   （"CLI 断开不能让操作事实消失"）。所以无论选哪个传输，都得自己定义一个
   operation 级的取消操作；那么换 wire 换来的只是"换了个格式重新定义同一件事"。

2. **换 wire 不会让协议表面变小，只会让它翻新一遍。** AGENTS.md:21 禁止向后兼容层，
   意味着协议表面是**发出去就撤不回**的。现有 14 个操作的校验、四分类结局的拒折叠解析、
   两个 `never` 穷尽出口、`OPERATION_BUDGET` 的 tsc 强制穷尽——这些都是已经交过学费的
   资产。JSON-RPC 换来的是 `{jsonrpc:"2.0",method,params,id}` 这层信封，而我们真正缺的
   （§2 五个缺口）它一个都不解决。

3. **跨语言的真实障碍不是格式。** 是**路径发现**：socket 路径由
   `CTXMUX_MANIFEST_SHA256`（`runtime-paths.ts:11`）再 sha256 取前 24 位派生
   （`runtime-paths.ts:19`），外部客户端无法复算。JSON-RPC 不解决这件事；
   一条能打印 endpoint 的命令解决这件事（缺口列为 F，见 §4 T-007）。

**未来 MCP / HTTP 适配的关系（明确写下来，避免以后被当成"当初没想过"）：**
MCP/HTTP 适配器应当是**协议之上的第二层客户端**，与 CLI 平级，
funnel 进同一个 operation registry（AGENTS.md 原则 10：不许第二份实现）。
本 Feature 不实现它们，但**选 A 不阻断它们**：适配器把 MCP 的 tool call 映成
本协议的 request，正是 `acp-adapter.ts` 已经在干的事（它把外部协议映到 core 概念上，
用回调而非 JSON-RPC）。这是仓内唯一的同类先例，形状可照抄。

### 被否决但值得记的

- **"给 browser 单开一个 socket / 命名空间"**：否决。三个操作已经在同一 union 上，
  单开等于把已经满足的约束拆开重造。
- **"把页面函数（snapshot/click/...）提升成协议操作"**：**明确否决**，且这是本设计里
  最容易做错的一步。`browser-script-runner.ts:28-42` 有一次有意的决定：
  协议层、`OPERATION_BUDGET`、CLI help **都不收这些名字**，
  "兼容负担从协议层挪到了库层"。提升它们会反转这个决定，让每加一个页面函数都变成一次
  协议版本变更。**页面函数清单要作为数据跨包流动，不作为操作进协议。**

---

## 4. 竖切顺序（每一刀都端到端，不先铺抽象层）

| 刀 | 内容 | 关掉的缺口 |
| --- | --- | --- |
| T-001 | 页面能力清单进 core 成 SSOT，Desktop 反向 import，Skill 从它渲染 | A |
| T-002 | 空程序守卫下沉到协议层，删 CLI 那份 | B |
| T-003 | `browser.stop`：一个 operation 级取消，跨连接凭 operationId | C |
| T-004 | `browser.operation`：按 id 查一条操作（含终局与 indeterminate） | D |
| T-005 | operationId 在开跑前就给出来（`browser.run` 先回 id，再回终局） | D |
| T-006 | 进度订阅：复用 `printStream` 信封 + journal 已有事件流 | D |
| T-007 | endpoint 发现：一条命令打印 socket 路径与 schemaVersion | F |
| T-008 | Renderer 的 stop/history/replay 收口到协议，消掉第二条语义 | E |

顺序理由：T-001/T-002 是无依赖的独立小刀，先落地把"Skill 生成"和"CLI 变薄"这两条
约束各兑现一条。T-003 在 T-004 之前，因为取消不需要先有查询，而查询的价值一半来自
"取消完了想知道它现在什么状态"。T-005 是 T-006 的真前提（没有早期 id 就没有可订阅的对象），
但不是 T-003/T-004 的前提——那两条可以用终局回执里的 id 先闭环。

---

## 5. 红线判定（下手前先跑一遍 RED-LINES.md 的四步）

本 Feature 新增的失败点，逐个判类：

| 新失败点 | 类别 | 处理 |
| --- | --- | --- |
| 订阅建立失败，但 Browser 活着、操作在跑 | **2 类** | 放行操作，服务窗说"进度不可用"，照 `confirmRenderOrDegrade`（`prompt-submission.ts:484-524`） |
| `browser.operation` 查不到 id（journal 坏了/被裁剪） | **2 类** | 答"查不到"，不阻断新操作；journal 本来就是 advisory（`browser-operation-journal.ts:76-80`） |
| 取消时操作已经结束 | **不是失败** | 幂等成功，答它的终局。竞态是常态不是错误 |
| 取消目标 id 不存在 | **2 类** | typed 拒绝，但不影响该 Browser 其他能力 |
| 页面能力清单读不出来（T-001 之后） | **1 类** | 这一条是真坏：清单是注入的前提，读不到就真跑不了程序 |
| 人在控制中，Agent 请求驱动 | **不是失败，是拒绝** | 需求明令"人工接管优先"。要 typed 码，不要 prose Error（现状 `browser-view-manager.ts:1048` 是裸 Error） |

**留痕要求**：以上任何一条如果实现成 `throw`，commit message 必须回答
RED-LINES.md 的四步，含那一问"绕过我这段代码，这条路还能不能通"。

---

## 6. 站点/厂商无关（原则 13）

现有能力面本来就是按通用事实构造的：ref 寻址来自我方快照（role/name/ordinal），
不接受坐标与 selector（`browser-script-runner.ts:31-35`），逃生口是 `js` / `cdp`
两个通用口而非某厂商方法。

**本 Feature 的约束**：生成的能力清单只能从 `BROWSER_PAGE_FUNCTION_NAMES` 与协议 union
派生；不得出现任何站点名、按钮文案、厂商协议名——包括在错误信息与验收条件里。
非过拟合证明按既有先例（`browser-protocol-generalization-2026-09-19.md`）：
至少两个不同的通用触发形态。

---

## 7. 已知风险与未决项

1. **T-001 的方向性风险**：把清单搬进 core 之后，Desktop 反向 import。
   要确认 core 的 `exports` 子路径不让 Renderer 值导入根 barrel
   （`renderer-core-import-is-browser-safe.test.ts` 会咬）。清单是纯字符串数组，无依赖，
   所以搬迁本身安全；风险在**导出位置**而不在内容。
2. **T-006 的传输改造是本 Feature 唯一动 socket 生命周期的一刀。**
   现有 `handle()` 读一条消息就 `socket.end()`（`control-host.ts:702`），
   且 `readMessage` 会拒绝尾随数据（`:619`）。事件流必须**新增一条明确的长连接路径**，
   不能就地放宽一问一答那条——放宽会让所有 14 个操作的 framing 假设一起松掉。
3. **T-008 的收口范围要克制**：把 Renderer 全部 browser IPC 改道协议是一次大重构，
   且 Renderer 有些调用（viewport/screenshot/devtools）与本 Feature 无关。
   只收口 stop/history/replay 这三条**语义与协议重叠**的。
4. **`operationId` 形状契约今天不存在**：它是裸 `randomUUID`，协议侧只校验非空
   （`control-host.ts:295`）。若要承诺跨客户端 join 语义，得显式定义，
   本 Feature 不扩大到这一步，但 T-005 铸 id 的位置一旦上移，
   **必须只有一个铸造点**（MEMORY：读的 key 与写的 key 必须只判一次）。
5. **进度订阅的背压未决**：journal 事件上限 512（`browser-operation-journal.ts:21`），
   一个长操作可能溢出。T-006 要么接受"进度可能有缺口"并按 ctxmux 的 gap 房规明说，
   要么限流；不许静默丢事件。

---

## 8. 测试房规对本 Feature 的具体要求

- **变异测试**：每个 task 的验收都要点名"改坏什么、哪条测试必须转红"。
- **零调用者检查**：`grep -rn '<符号>' <src> | grep -v test` 排除定义文件本身后仍有命中。
  T-001 尤其要这条——搬进 core 的清单如果只有测试读，就是竖切未闭合。
- **扫描类测试三种白绿**（AGENTS.md）：
  - 扫到空 → 必须 `expect(found.size).toBeGreaterThan(0)`；
  - `indexOf` 锚点没了 → 两端都判（`expect(start).toBeGreaterThan(-1)`），
    并再判"切出来的这段确实是那一段"。**缺口 A 现有的守卫正是这一族的样本，
    T-001 要把它换成真正的单一来源，而不是再加一条同形扫描**；
  - 空集合上的谓词 → 同一 `it()` 里要有非空证明，变异须**块级**。
- **新操作的机械要求**（不满足就 tsc 红，不是测试红）：
  `control.ts` 加 union 臂 + `OPERATION_BUDGET` 一行；
  `control-host.ts` 加**请求解析臂与回执解析臂各一条**，否则两个 `never` 出口报 TS2345。
- **新导出的可达性**：`control-export-reachability.test.ts:77-85` 要求每个值导出有真生产
  消费方，定义文件内的引用不算。
