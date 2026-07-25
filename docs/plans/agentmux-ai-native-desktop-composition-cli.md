# AgentMux AI-Native Control CLI

本合同固定一套低熵心智：用户只面向意图动词和类型化目标；Tab 是完整工作面，
Region 是 Tab 内的空间位置，Surface 是 Region 当前展示的内容，Agent Session 才是
消息收件人。公共协议不再暴露与 Tab 同义的 `View`，也不再保留旧命令树。

## 1. 目标

让运行在 AgentMux 内的 Agent 不依赖 UI automation、终端标题、当前焦点或 tmux
词汇，就能通过随 `@agentmux/core` 同版本交付的 `agentmux` CLI：

- 精确识别自己的 Agent Session，以及它位于哪张 Tab、哪个 Region；
- 看到当前 Tab 里全部 Region 的相对位置，而不是只知道“我在哪一块”；
- 在新 Tab 或当前 Tab 的左、右、上、下打开 Agent、Terminal 或 Browser；Agent 带入 prompt，
  Terminal 执行 command，Browser 打开 URL；
- 把已有 Agent Session 放进当前 Tab 的指定方向，或通过 Desktop 已配置的 Agent Profile
  创建新 Agent；
- 一次应用三列、四宫格、六宫格或九宫格，并显式执行快速均分或把当前活跃 Region 排到前面；
- 从 Tab 菜单复制这张 Tab 的 `tabId`，或者复制一段带 `tabId` 和精确命令的
  Agent handoff prompt；
- 用 `send --to-session|--to-region|--to-tab` 表达发送目标，不再让用户记住“先找哪个
  对象命令组”；
- 得到版本化、类型稳定、可由 Agent 解析的 JSON receipt。

第一条纵切只支持当前唯一 Local Desktop Composition Owner。Desktop 不可用、调用者
没有唯一 Tab/Region、目标过期或歧义时失败关闭；不猜最近 Workspace、Tab 或焦点。

## 2. 原则层

### What

空间是 Client 的展示上下文，不是 Agent Session 或 CtxMux Run 的属性。一个 Tab 是一张
完整工作面，Tab 内部可以有多个 Region。CLI 暴露 `inspect/open/send/focus/arrange`
等用户意图；内部仍由各自 Owner 完成 Agent 生命周期、Browser 创建和 Tab 布局。统一的是
公共心智和 receipt，不是把所有真相塞进一个全能 Runtime Owner。

### Why

同一个 Agent Session 可以没有内容区域，也可以投影到多个内容区域；同一个 CtxMux Run 也能被不同
Client 展示。把 Tab/区域下沉到 ctxmux 会制造全局布局假象，把创建交给短命 CLI 又会丢失
Hook ingress Owner。当前 Desktop 已经同时拥有长期 RuntimeController 和真实 Layout Store，
应复用这两个 Owner，而不是增加 daemon、Registry 或 UI automation。

### Intended generalization

这一合同适用于所有愿意注册 Composition Host 的 AgentMux Client。不同 Client 可以采用不同
布局实现，但必须区分“新 Tab”“Tab 内分屏”和“移动整张 Tab”，并接受相同的精确目标与 receipt 语义。

### Failure boundary

- ctxmux 仍只拥有 Run、PTY、Replay、Input、Resize、Interrupt 与 Stop；不出现 Tab、Region 或 Surface。
- Core 不保存 Desktop Layout，不 import Electron/React，不建立第二份 Tab/Region Registry。
- CLI 不直接创建需要长期 Hook ingress 的 Agent 后立即退出；创建必须由长期 Owner 执行。
- 不加入兼容 alias、fallback、Backend Selector、通用事件总线、任意 JSON 参数袋或 UI automation。
- 直接用 `tabId`，删除公共 `viewId` 术语；不做alias、映射表或兼容字段。
- `send --to-tab` 仅在 Tab 内恰好有一个不同的 Agent Session 时成功；零个或多个都返回
  精确候选并失败关闭，不选 active Region、不广播、不从 UI 焦点猜。
- 布局整理只能由用户或 Agent 显式触发；不在后台持续重排并让工作面跳动。
- 第一版不解决多 Desktop 发现、Remote/SSH 或无 Client 的长期 headless Owner。
- 当前 Desktop 必须持久化同一 App 内的 Tab/Region 展示关系。App 重启后，仍在 Core 中的 Agent/Terminal
  Session 要回到原来的 Tab 分屏树，不能退化成“每个 Session 一个 Tab”。

### Transfer checks

- Headless Client 可以创建/控制 Run，但没有 Composition Host 时不能声称已经“放到右边”。
- 同一 Agent Session 出现在两个 Region 时，使用 `self` 作为 Tab/Region anchor 必须报歧义，不能选最近焦点。
- Desktop Renderer 消失在 Agent 创建期间时，新建 Session 必须按现有 Agent creation owner 语义回滚，
  不能留下用户不可见且无人承接 Hook 的 Agent。
- Composition 请求超时或 Desktop 关闭时，Main 必须按 `requestId` 通知 Renderer 取消。Renderer
  立即撤掉 pending Tab/Region；如果 Agent 随后才启动成功，必须停止这个晚到的 Run。
- Electron Main、Preload 和 Renderer 之间只传普通的 request、response 和 cancellation 数据。
  `AbortSignal` 不能跨 `contextBridge` 传递；真正执行布局事务的 Renderer 必须自己创建它。

## 3. Owner 与对象

```text
agentmux CLI
    │ typed local Composition request
    ▼
AgentMux Composition Control
    │
    ▼
Desktop Composition Host                 唯一外部事务入口
    ├─ RuntimeController → Core → ctxmux  AgentSession / Run lifecycle
    ├─ Main Browser Owner                 Browser lifecycle
    └─ Renderer Layout Store              Tab / Region placement
```

- `AgentSession`：Provider/模型上下文的稳定身份。
- `Run`：ctxmux 持有的物理进程身份。
- `Tab`：用户认知里的一张完整工作面，拥有自己的 Region 布局和稳定 `tabId`。
- `Region`：Tab 内容分屏树的 leaf，拥有稳定 `regionId`。
- `Surface`：Region 当前展示的 Agent、Terminal、Browser、File 或 Launcher。Surface 不再另造一个
  公共 ID；Region receipt 直接返回内容 kind 和其 Owner ID。
- `Tab Group`：Renderer 内部组织 Tab strip 的布局结构。当前公共协议不需要它，因此 receipt 不暴露
  `tabGroupId`；新 Tab 通过一张精确 anchor Tab 定位。
- `inspect.regions`：一张 Tab 的空间地图。每个 Region 返回精确 `regionId`、类型化 Surface 和
  `0..1` 归一化 bounds；它是 Renderer Layout SSOT 的只读投影，不是 Core 保存的第二份布局。

说得更直接一点：`packages/core` 定义“相对哪个 Region 打开”或“相对哪张 Tab 新建 Tab”，
具体 App 保存 Workspace 的 Tab 分区树和每个 Tab 的内容分屏树，并真正计算尺寸和切换焦点。
Core 不保存或渲染任何布局。移动整张 Tab 到新 Tab Group 是另一种产品操作，当前不扩张入
Composition CLI。

当前公共 Composition 把 Desktop Tab 命名为 View/viewId。本次直接切换后，Desktop 和公共
Composition 只使用 Tab/tabId；Runtime 的读模型继续使用 Snapshot/Projection 术语。
公共 receipt 同时返回 `tabId` 与精确 `regionId`。

### 协议形状与依赖方向

Core 只定义类型化 discriminated union，不定义一个全能 JSON 参数袋：

```ts
type InspectTarget =
  | { kind: 'agent-session'; agentSessionId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'provider-native'; providerId: string; nativeSessionId: string }
  | { kind: 'acp-native'; adapterId: string; nativeSessionId: string }
  | { kind: 'tab'; tabId: string }
  | { kind: 'region'; regionId: string }

type MessageTarget =
  | { kind: 'agent-session'; agentSessionId: string }
  | { kind: 'tab'; tabId: string }
  | { kind: 'region'; regionId: string }

type OpenDestination =
  | { kind: 'split'; region: RegionAnchor; direction: 'left' | 'right' | 'up' | 'down' }
  | { kind: 'new-tab'; after: TabAnchor }
  | { kind: 'launcher'; regionId: string }

type OpenContent =
  | { kind: 'new-agent'; executorId: string; prompt?: string }
  | { kind: 'agent-session'; agentSessionId: string }
  | { kind: 'terminal'; command?: string }
  | { kind: 'browser'; url: string }

type MessageTargetNotUnique = {
  code: 'MESSAGE_TARGET_NOT_UNIQUE'
  message: string
  candidates: Array<{ agentSessionId: string; regionIds: string[] }>
}
```

`self` 只是 CLI 输入层的受管 caller selector，不会被保存为身份。Host 必须在一次请求中
将它解析为精确 ID；同一 Session 有多个展示时，Tab/Region `self` 都失败关闭。

公共 CLI 可以是一套心智，但内部不为此变成一个第二 Runtime Owner：

| 意图 | 真相 Owner | 路由 |
| --- | --- | --- |
| `inspect/list/output/interrupt/resume/stop --session|--run|--*-native` | Core AgentSession / ctxmux Run | 直接调用 Core 公开 API |
| `inspect/focus/arrange --tab|--region` | Renderer Layout Store | 经 Composition Host |
| `open agent` | Desktop RuntimeController → Core Provider | Composition Host 编排创建与布局回滚 |
| `open terminal` | Desktop RuntimeController → Core → ctxmux | Composition Host 编排一次 Run 创建与布局回滚 |
| `open browser` | Main Browser Owner | Composition Host 编排 Browser 创建与布局回滚 |
| `send --to-session` | Core Provider prompt contract | 直接调用 Core 公开 API |
| `send --to-tab|--to-region` | Renderer 解析展示，Core 接收 prompt | Composition Host 解析精确 Session 后调用同一 Core API |

Composition Host 是跨 Owner 事务编排边界，不保存 Provider、Run、Browser 或 Layout 第二份真相。

### Agent 如何选择 Split 还是 Tab

- 用户明确说“新 Tab”时，使用 `--new-tab-after <tab-id|self>`。
- 用户要求“在左边/右边/上面/下面开一个 Session”时，方向表示当前 Tab 内分屏，不创建 Tab。
- Agent 判断新 Session 仍在处理同一件事时，默认留在同一 Tab，并使用内容分屏组织并行工作。
- 只有 Agent 明确判断这是另一件事、可能需要独立工作视图时，才询问用户是否新建 Tab；用户没有确认前不擅自创建。
- 判断不出是另一件事时，不额外打断用户，也不把 Session 自动升级成新 Tab。

### Agent 如何理解“左边”

- “在左边/右边/上面/下面开”默认指整张当前 Tab 的空间，不等于机械地切调用者自己的 Region。
- Agent 先读取 `agentmux inspect --tab self` 的 Region bounds，再选择要被切开的精确 `regionId`。
  只有当前 Tab 只有一个 Region，或用户明确说“在我旁边”时，才把 `self` 直接作为方向 anchor。
- 例如右半边已经上下两块、左半边还是一整块时，用户说“在左边开 TraeX”，应把左边那块上下分，
  形成清楚的 2×2；不能继续把右下角调用者左右分成更窄的小块。
- App 不根据一句自然语言偷偷猜目标，也不引入自动布局算法；Core 只定义空间地图合同，Agent 用
  精确 Region 发起动作，Renderer 仍是唯一布局 Owner。用户显式请求的 preset、balance 或
  active-first 是封闭的布局事务，不是后台自动猜布局。

## 4. CLI 合同

CLI 借鉴 lark-cli 的可发现性：稳定的用户意图动词、互斥的 typed target flags、逐级 Help、
机器可读默认输出和稳定错误码。AgentMux 领域没有 lark-cli 那样的大量 API domain，因此不照搬
`domain + shortcut` 分层，也不接受 `--params/--data` 任意 JSON 袋。

公共命令树只有用户意图：

```bash
agentmux inspect --session self
agentmux inspect --session <session-id>
agentmux inspect --tab self
agentmux inspect --tab <tab-id>
agentmux inspect --region self
agentmux inspect --region <region-id>
agentmux inspect --run <run-id>
agentmux inspect --provider-native <native-session-id> --provider <provider-id>
agentmux inspect --acp-native <native-session-id> --adapter <adapter-id>
agentmux list sessions

agentmux open agent --agent codex --prompt "Inspect the failing tests" --right-of self
agentmux open agent --agent traex --below <left-region-id>
agentmux open agent --session <session-id> --left-of <region-id>
agentmux open terminal --command "pnpm test:fast" --below self
agentmux open browser --url "http://localhost:5173" --new-tab-after self
agentmux open agent --agent claude --prompt "Review the writer" --in-region <launcher-region-id>

agentmux send --to-session <session-id|self> --text "Continue"
agentmux send --to-region <region-id> --text "Continue"
agentmux send --to-tab <tab-id> --text "Continue"

agentmux focus --region <region-id>
agentmux focus --tab <tab-id>

agentmux arrange --tab <tab-id|self> --preset columns-3
agentmux arrange --tab <tab-id|self> --preset grid-4
agentmux arrange --tab <tab-id|self> --preset grid-6
agentmux arrange --tab <tab-id|self> --preset grid-9
agentmux arrange --tab <tab-id|self> --balance
agentmux arrange --tab <tab-id|self> --active-first

agentmux output --session <session-id|self> --follow
agentmux interrupt --session <session-id|self>
agentmux resume --session <session-id|self> --text "Continue after recovery"
agentmux stop --session <session-id|self>
```

### 类型化目标

- `inspect` 恰好接受 `--session|--tab|--region|--run|--provider-native|--acp-native` 中一个。
  `--provider-native` 额外要求 `--provider`，`--acp-native` 额外要求 `--adapter`；它们直接复用
  Core 现有的唯一身份解析，用新心智保留旧 `session resolve` 的完整能力。
  `inspect --session self` 从受管
  环境取精确 Agent Session ID，只返回 Core Session/Run 真相；`inspect --tab self` 和
  `inspect --region self` 由 Composition Host 从同一 caller Session 解析展示，不唯一时失败关闭。
  Core 查询不做 Desktop enrichment，Composition 不可用时也不返回缩水结果。所有读操作都不改变焦点。
- `send` 恰好接受 `--to-session|--to-region|--to-tab` 中一个。`--to-region` 要求该 Region
  当前展示 Agent；`--to-tab` 要求该 Tab 当前恰好只投影一个不同的 Agent Session。零个或
  多个都返回 `MESSAGE_TARGET_NOT_UNIQUE` 和按 Session 去重的精确 `candidates`，并提示先
  `inspect --tab`；不用 active Region、标题、顺序或最近焦点猜。这是封闭错误 union，不是
  任意 `details` JSON 袋。
- `focus` 只接受精确 `--region` 或 `--tab`。不提供 `--session`，因为同一 Session 可以有
  多个展示。
- `output/interrupt/resume/stop` 始终以 Agent Session 为语义目标；不接受 Tab/Region，
  不将展示容器偷偷升格成 Runtime Owner。

### 打开和方位

`open` 是 Agent、Terminal 和 Browser 共用的唯一打开入口，但负载保持类型化：
Agent 恰好使用 `--agent + --prompt` 或 `--session`，Terminal 使用 `--command`，Browser 使用
`--url`。不能用一个含混的 `--content` 或 JSON 参数袋抹平三种 owner。Terminal command
必须进入一次明确的 Run 创建合同，不能在 Renderer attach 后模拟键盘输入；Browser URL
继续由既有 Main Browser owner 校验和创建；Agent prompt 继续由 Provider 合同接收。

`open` 必须恰好提供一个 destination，不设惊喜默认值：

- `--left-of|--right-of|--above|--below <region-id|self>`：相对精确 Region 分屏。
- `--new-tab-after <tab-id|self>`：在 anchor Tab 所在 Tab Group 新建 Tab；公共协议无需暴露
  `tabGroupId`。
- `--in-region <region-id>`：只填充 preset 创建的 Launcher Region；已承载其他 Surface 时失败，
  不暗中关闭或替换用户内容。

这些互斥方位 flag 直接替换容易产生非法组合的 `--placement + --relative-to`。
`open` 跑通后删除旧 `launch`、`region open` 和 `surface open`，不保留 alias 或兼容帮助。

### 布局

Preset 在精确 Tab 内原子形成固定 reading-order slot：`columns-3` 为三等列，`grid-4` 为 2×2，
`grid-6` 为 3×2，`grid-9` 为 3×3。已有 Region 依稳定 reading order 保留，空 slot 使用现有
Launcher Region，Region 多于 slot 时失败关闭。`balance` 按每个 split 子树的 leaf 数计算比例，
使最终 slot 等面积；`active-first` 只把当前 `activeRegionId` 放到 reading order 第一位，其他 Region
保持相对顺序。两者都由 Renderer 在一个事务中完成，不从 Terminal bytes 推断活跃状态。

### Tab identity 与 handoff

菜单中的 “Copy Tab ID” 复制同一个 `tabId`。“Copy Agent Handoff” 生成一段短 prompt，
内含 `agentmux inspect --tab <tabId>`、唯一 Agent 时可用的
`agentmux send --to-tab <tabId> --text <message>`，以及多 Agent 时改用
`agentmux send --to-session <agentSessionId> --text <message>` 的说明。Tab 关闭后 `tabId` 立即失效。

`send --to-tab` 是便利 selector，不是 Tab 通信通道：Desktop 只在当前 Layout Snapshot 中解析唯一
Agent Session，然后调用同一 Core Provider prompt 合同。Tab 不保存消息、不广播、不成为
Session Registry。`send --to-session` 在无 Desktop 时仍直接走 Core；Tab/Region 目标没有
Composition Host 则明确失败。

### receipt 与删除面

成功向 stdout 输出版本化 JSON；失败向 stderr 输出稳定 `code`/`message` 并非零退出。
所有成功 receipt 固定 `schemaVersion/requestId/operation/result`；操作结果返回最终解析的
`agentSessionId/tabId/regionId/runId` 中适用的精确身份。不返回 `viewId`、`tabGroupId`、
`paneId` 或 Surface ID。

旧 `context`、`launch`、`session *`、`region *`、`surface *` 和 `layout *` 命令在新纵切跑通后直接
删除，不保留 alias、迁移帮助或 fallback。`move/close` 等尚无需求的 CLI 不为对称性扩张。

Desktop 内置 Grok Profile 默认使用 Grok 官方的免确认参数
`--permission-mode bypassPermissions`。这是可见、可编辑的 Profile args，不在 Provider 内藏第二套
权限开关；用户显式保存的 args 仍是启动真相。

创建 Agent 后，如果 Run 已建立但还没有产生第一段 Replay 或 Live 输出，Region 不能只显示一块
黑色终端。它应明确显示“正在启动 <Agent>”，首段输出到达后立即让位给真实 TUI；进程退出或连接
失败仍显示真实错误，不重试、不伪造 ready。

`output --session <id> --follow` 必须先输出 `attached`，再输出 Replay，最后才输出 Live。Attach
期间到达的 Live 字节先暂存；Replay 已覆盖的 byte range 不能重复输出，游标不能倒退。

## 5. 验收

- 受管 Agent 可用 `inspect --session self` 查询 Core Session/Run，再用 `inspect --tab self`
  查询唯一 Tab 和当前 Region，并用一条
  `open agent --agent codex --right-of self` 在同一 Tab 右侧启动配置过的 Codex；操作前后
  Tab 数量不变。
- Agent、Terminal 与 Browser 都通过同一个 typed `open` 合同在新 Tab 或四向
  Region 打开；prompt、command 和 URL 各自只到达一次正确 owner，失败只回滚本次 Region。
- `inspect --tab` 返回当前 Tab 全部 Region 的精确 ID、内容种类与归一化 bounds。
  三块不对称布局中，
  Agent 可以选中左侧整块并把它上下分成 2×2，而不是只能相对自己继续切小块。
- `--new-tab-after` 只在用户明确要求后创建新 Tab；Agent 明确判断为另一件事时先询问，
  不自动创建。
- 四向 split 只修改当前 Tab 的内容树；Tab 分区调整只移动整张 Tab。两个 reducer、ID、焦点、
  预览和 receipt 字段不能混用；最终 Region 尺寸仍通过现有 resize 路径提交给 ctxmux。
- 三列、四宫格、六宫格和九宫格产生确定的 Region bounds 与 Launcher slot；balance 和
  active-first 只在显式请求时原子重排，并保留每个 Surface 的唯一 owner。
- Tab 菜单复制的 ID 与 Composition receipt 的 `tabId` 完全相同；复制 handoff 带入该 ID 和
  `inspect/send` 用法。单 Agent Tab 的 `send --to-tab` 成功；零 Agent 或多 Agent Tab 以
  `MESSAGE_TARGET_NOT_UNIQUE` 失败，不改发给 active Session，不广播。
- 创建、布局、回滚与 receipt 经过 Composition Control 协议；实际 Agent prompt 仍仅由 Core
  Provider 合同接收。旧命令树和 `viewId/tabGroupId` 公共字段被删除，不保留 alias。
- 无 Desktop、unknown/stale/ambiguous caller/target、Renderer timeout 和 launch failure 都有
  确定错误码且不改变布局或泄漏 Agent Session。
- 生产版 `agentmux open agent --agent codex --right-of self` 必须经过 Electron 隔离世界边界成功；取消时仍能
  立刻回滚 pending Region，不能把跨 world 的普通对象误当成 `AbortSignal`。
- 慢启动 Agent 在第一段终端输出前显示明确的启动中状态；Grok 的内置默认 Profile 使用
  `--permission-mode bypassPermissions`，设置与实际启动 argv 使用同一份 args。
- Composition socket 按原始字节收齐一条消息后再做 UTF-8 解码。中文等多字节字符即使跨 socket
  chunk 也不能损坏；对端提前关闭时请求必须结束并报错，不能一直挂住。
- Core package consumer 能发现 CLI/Skill 并验证公共 JSON receipt；Repository `pnpm check` 通过。

## 6. 用户确认

用户确认：空间属于连接中的 Client/Workspace presentation；ctxmux 只提供 Run
Kernel；AgentMux Core 提供宿主中立 Composition 合同；具体 Desktop 持有布局；CLI 保持
AI 可发现、JSON 输出和 typed flag，不增加 `+shortcut` 或通用 JSON 参数。

用户纠正：Tab 决定“一张完整视图”的心智；同一件事里按方向打开 Session，默认是
当前 Tab 内分屏。只有用户明确要求 Tab 时才创建 Tab；Agent 明确判断为另一件事时，先询问用户
是否需要新 Tab。Tab 分区自由组合与 Tab 内分屏是两套独立行为。

用户进一步纠正：方向是当前 Tab 的空间概念，不是 `relative-to self` 的机械同义词。Agent 必须先
看到当前 Tab 的 Region 位置；右侧已有上下两块而左侧仍是一整块时，“在左边开”应切左侧整块，
形成 2×2。TraeX 实际能创建，但第一段输出可能很慢；等待期间不能用纯黑 Region 让人误以为
失败。Grok 内置 Profile 默认免确认。

用户进一步确认：`agentmux --skill` 要能在指定方位打开 Agent、Terminal 或 Browser，并分别带入
prompt、command 或 URL；要提供三列、四宫格、六宫格、九宫格及 Writer/Reviewer、大规模并发等
常见用法说明，还要提供显式的快速对齐和活跃 Region 优先整理。

用户进一步提出 Tab 菜单复制身份和 handoff。最低熵合同不新增第二份 Tab identity：
直接把现有 Desktop Tab 身份命名为 `tabId`，菜单复制同一 ID，并可复制一段带该 ID 和可执行
命令的 Agent prompt。

用户进一步要求整体重新设计一套心智统一、低熵的协议，并提出借鉴 lark-cli 的
`send --to-session / --to-tab`。因此公共面收敛为意图动词与 typed target flags；Tab 可作为严格的
便利 selector，但只在唯一 Agent Session 时成功，不产生第二通信 Owner。
