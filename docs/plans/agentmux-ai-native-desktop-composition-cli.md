# AgentMux AI-Native Desktop Composition CLI

状态：用户已纠正分屏语义；本版覆盖此前的 Pane/Tab Placement 表述。历史 Feature `f-2298fjkx4` 已归档，后续修正由当前 Desktop Feature 承接。

## 1. 目标

让运行在 AgentMux 内的 Agent 不依赖 UI automation、终端标题、当前焦点或 tmux
词汇，就能通过随 `@agentmux/core` 同版本交付的 `agentmux` CLI：

- 精确识别自己的 Agent Session，以及它位于哪张 Tab View、哪个内容区域；
- 看到当前 Tab View 里全部内容区域的相对位置，而不是只知道“我在哪一块”；
- 把已有 Agent Session 放进当前 Tab View 的指定方向，或在用户明确要求时创建新 Tab；
- 通过 Desktop 已配置的 Agent Profile 创建 Agent，并把新 Session 放进正确的 Tab View 和内容区域；
- 得到版本化、类型稳定、可由 Agent 解析的 JSON receipt。

第一条纵切只支持当前唯一 Local Desktop Composition Owner。Desktop 不可用、调用者
没有唯一 Tab View、内容区域目标过期或歧义时失败关闭；不猜最近 Workspace、Tab 分区或焦点。

## 2. 原则层

### What

空间是 Client 的展示上下文，不是 Agent Session 或 CtxMux Run 的属性。一个 Tab 是用户认知里的
一张完整 View，Tab 内部可以有多个内容区域。CLI 暴露用户意图，AgentMux Composition Host 负责
把 Agent 生命周期、Tab View 和内容区域组合成一个可审计结果。

### Why

同一个 Agent Session 可以没有内容区域，也可以投影到多个内容区域；同一个 CtxMux Run 也能被不同
Client 展示。把 Tab/区域下沉到 ctxmux 会制造全局布局假象，把创建交给短命 CLI 又会丢失
Hook ingress Owner。当前 Desktop 已经同时拥有长期 RuntimeController 和真实 Layout Store，
应复用这两个 Owner，而不是增加 daemon、Registry 或 UI automation。

### Intended generalization

这一合同适用于所有愿意注册 Composition Host 的 AgentMux Client。不同 Client 可以采用不同
布局实现，但必须区分“新 Tab”“Tab 内分屏”和“移动整张 Tab”，并接受相同的精确目标与 receipt 语义。

### Failure boundary

- ctxmux 仍只拥有 Run、PTY、Replay、Input、Resize、Interrupt 与 Stop；不出现 Tab、View 或内容区域。
- Core 不保存 Desktop Layout，不 import Electron/React，不建立第二份 View/Region Registry。
- CLI 不直接创建需要长期 Hook ingress 的 Agent 后立即退出；创建必须由长期 Owner 执行。
- 不加入兼容 alias、fallback、Backend Selector、通用事件总线、任意 JSON 参数袋或 UI automation。
- 第一版不解决多 Desktop 发现、Remote/SSH 或无 Client 的长期 headless Owner。
- 当前 Desktop 必须持久化同一 App 内的 Tab/Region 展示关系。App 重启后，仍在 Core 中的 Agent/Terminal
  Session 要回到原来的 View 分屏树，不能退化成“每个 Session 一个 Tab”。

### Transfer checks

- Headless Client 可以创建/控制 Run，但没有 Composition Host 时不能声称已经“放到右边”。
- 同一 Agent Session 出现在两个内容区域时，`relative-to self` 必须报歧义，不能选最近焦点。
- Desktop Renderer 消失在 Agent 创建期间时，新建 Session 必须按现有 launch owner 语义回滚，
  不能留下用户不可见且无人承接 Hook 的 Agent。
- Composition 请求超时或 Desktop 关闭时，Main 必须按 `requestId` 通知 Renderer 取消。Renderer
  立即撤掉 pending View；如果 Agent 随后才启动成功，必须停止这个晚到的 Run。
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
    └─ Renderer Layout Store              Tab Group / Tab View / Region placement
```

- `AgentSession`：Provider/模型上下文的稳定身份。
- `Run`：ctxmux 持有的物理进程身份。
- `View`：用户认知里的一张完整工作视图，在 Desktop 中表现为一个 Tab；它拥有自己的内容布局。
- `Region`：View 内容分屏树的 leaf，展示一个 Agent Session、Terminal、File、Browser 或启动面。
- `Tab Group`：整理整张 Tab/View 的分区，每个分区有自己的 Tab strip；它不等于 View 内的 Region。
- `Placement=split-left|split-right|split-up|split-down`：在当前 View 内相对精确 Region 新建内容区域。
- `Placement=tab`：显式创建一张新 View/Tab；不能因为启动了新 Session 就自动使用。
- `context.regions`：当前 View 的空间地图。每个 Region 返回精确 `regionId`、内容种类和
  `0..1` 归一化 bounds；它是 Renderer Layout SSOT 的只读投影，不是 Core 保存的第二份布局。

说得更直接一点：`packages/core` 定义“在当前 View 的哪个方向放 Region”或“明确新建 Tab”，
具体 App 保存 Workspace 的 Tab 分区树和每个 Tab 的内容分屏树，并真正计算尺寸和切换焦点。
Core 不保存或渲染任何布局。移动整张 Tab 到新分区是第三种操作，不能复用 `split-*`。

Core 当前按 Run 自动生成的 `AgentMuxWorkspaceView/AgentMuxView` 只是 Runtime Projection，
不是 Desktop View。实现必须消除这一重名，并把 `View` 专用于 Tab 级 Client presentation。
公共 Composition receipt 同时返回 `viewId` 与精确 `regionId`；Tab 分区身份只在需要移动整张 Tab
时出现，不能继续用一个含混的 `paneId` 同时表示两层布局。

### Agent 如何选择 Split 还是 Tab

- 用户明确说“新 Tab”时，使用 `placement=tab`。
- 用户要求“在左边/右边/上面/下面开一个 Session”时，方向表示当前 Tab 内分屏，不创建 Tab。
- Agent 判断新 Session 仍在处理同一件事时，默认留在同一 Tab，并使用内容分屏组织并行工作。
- 只有 Agent 明确判断这是另一件事、可能需要独立工作视图时，才询问用户是否新建 Tab；用户没有确认前不擅自创建。
- 判断不出是另一件事时，不额外打断用户，也不把 Session 自动升级成新 Tab。

### Agent 如何理解“左边”

- “在左边/右边/上面/下面开”默认指整张当前 Tab 的空间，不等于机械地切调用者自己的 Region。
- Agent 先读取 `agentmux context` 的 Region bounds，再选择要被切开的精确 `regionId`。只有当前
  View 只有一个 Region，或用户明确说“在我旁边”时，才直接使用 `--relative-to self`。
- 例如右半边已经上下两块、左半边还是一整块时，用户说“在左边开 TraeX”，应把左边那块上下分，
  形成清楚的 2×2；不能继续把右下角调用者左右分成更窄的小块。
- App 不根据一句自然语言偷偷猜目标，也不引入自动布局算法；Core 只定义空间地图合同，Agent 用
  精确 Region 发起动作，Renderer 仍是唯一布局 Owner。

## 4. CLI 合同

CLI 使用逐级 Help、typed flags、机器可读默认输出、稳定错误码与内置 Agent Skill；不增加
`+verb` 分层，也不接受 `--params/--data` 任意 JSON 袋。

```bash
agentmux context  # 返回 caller 和当前 View 的全部 Region bounds
agentmux launch --agent codex --prompt "Inspect the failing tests" \
  --placement split-right --relative-to self

# 非平凡布局：先从 context 选择左侧 Region，再把它上下分
agentmux launch --agent traex --placement split-down \
  --relative-to region:<left-region-id>

agentmux session list
agentmux session resolve ...
agentmux session status <session-id>
agentmux session send <session-id> --text "..."
agentmux session interrupt <session-id>
agentmux session output <session-id> --follow
agentmux session resume <session-id> --text "..."
agentmux session stop <session-id>

agentmux region open --session <session-id> --placement split-right --relative-to self
agentmux region focus --region <region-id>
```

首个实现交付 `context`、`launch`、`region open`、`region focus`，以及现有 Agent Session 操作的
`session` 命令树。CLI 默认 `placement=split-right`；只有显式写出 `placement=tab` 才创建新 Tab。
`region list/move/close` 未交付；它们只有在同一 Owner 合同和行为证明自然支持时才进入后续计划，
不为命令对称性扩张第一纵切。

成功向 stdout 输出版本化 JSON；失败向 stderr 输出稳定 `code`/`message` 并非零退出。
`context` 只从受管环境中的 `AGENTMUX_AGENT_SESSION_ID` 建立 caller identity，并返回当前 View
全部 Region 的归一化 bounds；`--relative-to self` 由 Composition Host 解析。非平凡布局或发生
歧义时使用 context 返回的精确 `regionId`，不能静态注入某个“最近焦点”ID。

Desktop 内置 Grok Profile 默认使用 Grok 官方的免确认参数
`--permission-mode bypassPermissions`。这是可见、可编辑的 Profile args，不在 Provider 内藏第二套
权限开关；用户显式保存的 args 仍是启动真相。

创建 Agent 后，如果 Run 已建立但还没有产生第一段 Replay 或 Live 输出，Region 不能只显示一块
黑色终端。它应明确显示“正在启动 <Agent>”，首段输出到达后立即让位给真实 TUI；进程退出或连接
失败仍显示真实错误，不重试、不伪造 ready。

`session output --follow` 必须先输出 `attached`，再输出 Replay，最后才输出 Live。Attach
期间到达的 Live 字节先暂存；Replay 已覆盖的 byte range 不能重复输出，游标不能倒退。

## 5. 验收

- 受管 Agent 可查询唯一 Tab View 和当前 Region，并用一条 `launch --placement split-right` 在同一
  Tab 右侧启动配置过的 Codex；操作前后 Tab 数量不变。
- `context` 返回当前 View 全部 Region 的精确 ID、内容种类与归一化 bounds。三块不对称布局中，
  Agent 可以选中左侧整块并把它上下分成 2×2，而不是只能相对自己继续切小块。
- `placement=tab` 只在用户明确要求后创建新 Tab；Agent 明确判断为另一件事时先询问，不自动创建。
- 四向 split 只修改当前 Tab 的内容树；Tab 分区调整只移动整张 Tab。两个 reducer、ID、焦点、
  预览和 receipt 字段不能混用；最终 Region 尺寸仍通过现有 resize 路径提交给 ctxmux。
- 创建、布局、回滚与 receipt 经过一个 Composition Control 协议；旧 focus-only server 和
  flat CLI 被删除，不保留 alias。
- 无 Desktop、unknown/stale/ambiguous caller/target、Renderer timeout 和 launch failure 都有
  确定错误码且不改变布局或泄漏 Agent Session。
- 生产版 `agentmux launch --placement split-right` 必须经过 Electron 隔离世界边界成功；取消时仍能
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
