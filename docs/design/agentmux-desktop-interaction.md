# AgentMux Desktop 交互设计合同

> 当前确认的导航、Tab、分屏和会话栏需求见
> [`agentmux-project-rail-navigation.md`](../plans/agentmux-project-rail-navigation.md)。
> Scratch 的 Topic 与 Wiki 合同见
> [`agentmux-wiki-first-scratch.md`](../plans/agentmux-wiki-first-scratch.md)。

## 设计哲学

- AgentMux 是 Agent-first、terminal-first 的桌面 Client。Agent 状态、用户输入、终端输出和恢复动作必须靠近它们影响的 View。
- 同一信息只在最合适的位置显示一次。Tab 拥有会话名称和状态；低频 ID、Host 和时间进入 tooltip 或 context menu；Activity 拥有最近消息。
- 界面层级由 Surface、明度、局部高光和紧凑密度建立，不靠连续边框、重复标题或极小字号制造“专业感”。
- 选择、键盘、拖拽、菜单和可访问性交互使用维护中的成熟依赖与平台模式。
- Desktop 只组合 Core 的公共能力。所有 Agent 生命周期都经过 `packages/core`；所有 PTY、进程、Run、Replay 和 Attachment 事实都由 ctxmux 持有。

## 产品对象

### Project 与 Workspace

- Project Rail 只负责选择 Project/Scratch、显示紧凑状态和进入 Settings/Hosts。
- Workspace Tools 位于主工作区左侧，负责 Files + Branches、Agents 和 Browser Favorites。
- Scratch 使用同一工具槽，但内容是 Files + Topics。Topic 来自文件系统，不从打开的 View 反推。
- Topic 条目的目录动作只在内置 Explorer 中展开、选中并滚动到对应目录，不调用 Finder 或其他系统文件管理器。
- Topic 条目的改名是对 `topic.md` 一级标题的语义编辑；`topic--*` 目录、`topicId`、Agent cwd 和 View 绑定保持稳定，Explorer 不向这些顶层目录暴露通用 Rename。
- Project Rail 与 Workspace Tools 分别开关，不能共享状态或互相改变布局身份。

### Tab、Tab Group 与 Region

- `View` 是用户认知里的一张完整工作视图，在 Desktop 中表现为一个 Tab。
- `Tab Group` 用来整理整张 View；移动 Tab 不改变 View 内部内容布局。
- `Region` 是 View 内的内容 leaf，可展示 Agent、Terminal、File、Browser 或 Launcher。
- `split-left|right|up|down` 只修改当前 View 的 Region 树；`placement=tab` 只在用户明确要求时创建新 View。
- Workspace 保存 Tab Group 树，每个 View 保存自己的 Region 树。两个树使用不同 ID、焦点、resize 状态和操作入口。

### Session、Run 与 View

- Agent Session 是 Provider 语义身份；Run 是 ctxmux 进程身份；View/Region 是 Desktop 展示身份。
- 一个 Session 可以没有 View，也可以投影到多个 View。关闭 Tab 内的 Region 只改变该 View 的内容布局；关闭承载某个 Session 最后一个 Region 的完整 View 时，Terminal 直接停止 Run，Agent 默认停止并二次确认，同时明确提供保留 Session 的选项。
- Desktop 只持久化 Session/Run 在哪张 View 的哪个 Region，不复制 PTY、Replay、Agent 状态或进程生命周期。
- 后台 Agent 由 Agents 工具重新发现和打开，不建立第二份 Session Registry。

## 界面结构

### 顶部与项目栏

- macOS 红绿灯之后固定放 Projects 与 Workspace tools 两个开关，顺序和位置不随面板状态变化。
- 单 Pane 时，根 Tabbar 与窗口顶行合并；分屏时保留全局 chrome 行，每个 Pane 使用自己的紧凑 Tabbar。
- Project Rail 展开时只在底部放 Settings 与 Hosts；收起后只保留不遮挡内容的 Settings 角标。
- Breadcrumb 只展示工作上下文；绝对路径只在文件树根区域可见，并可通过 tooltip 查看完整值。
- 窗口底部有且仅有一条**跨会话注意力汇总栏**，横跨整宽。窗口里其余每个状态指示都是**有作用域**的——Tab 状态点只讲一个 Session，Board 列只讲一个 Project，Agents 工具的总数只讲一个 Workspace 且只在其工具坞打开时。这条栏回答它们都不回答的那一个问题：这整个窗口里（含折叠的 Pane、其他 Tab Group、其他 Workspace），现在有没有 Agent 需要你。它只在窗口至少投影一个 Agent Session 时出现，否则完全不占位。它是聚合而非某一个 Session，因此没有诚实的 `status.source`/`observedAt` 可交给 StatusDot——绝不伪造证据，只复用共享状态语汇（同一套点与颜色），使这里的一个点与 Tab 上的点含义完全一致；计数为零时保持中性灰。"需要你" 与 "错误" 两段是动作：点击跳到该注意力类别里 `status.observedAt` 最早、即等待最久的那个 Session；聚合计数写进这两段按钮自己的可访问名，让读屏得到事实而不只是"跳转"。它只读 Store 里已有的 Session 投影，不新增任何管线。
- 汇总栏的**总数段是名册的展开入口**。栏回答"有没有需要你"并跳到等待最久的那一个；名册回答"都有哪些"。二者是同一份聚合的两个尺寸，不是两个数字：折叠态只占那枚本已存在的计数，展开才付出空间，且关闭时展开内容不驻留 DOM。名册**只读**既有 Session 投影与 Core 已有的 pending interaction 事实，不新增 Core 合同、不建第二条消息状态机、不为待处理请求另开一个列表——待答的行就是这张表里的行。排序复用全窗口同一套语汇：needs-you 优先于 error 优先于 working，同一类内 `status.observedAt` 最早者在前，与汇总栏"跳到等待最久"的落点一致。
- 名册的每一行显示该 Agent **启动时固定的授权范围**。它来自 Core Session 记录里已持久化的 launch-option 选择，经 DESCRIBE 半边（仅 choice id）跨 IPC，标签由 Renderer 用 Provider 自己的 catalog 声明解析——argv 仍然不出 Core。两条诚实规则：创建时未收窄任何一项则**什么也不显示**，绝不写"默认"（那是无人记录过的事实）；选择所对应的 option 或 choice 若 Provider 已不再声明，该项**丢弃**而非渲染裸 id（一个 `bypass-all` 当标签显示，会像一个已核实的授权，实际却无从解析）。行上最多一枚风险标记，取该行诸范围中最宽的那一档；Provider 未声明 tier 的选项不被补成 `safe`。
- **注意力沿导航树上卷**：某一层内有 Agent 需要你时，该层的折叠行也必须表达出来，否则折起来的项目与空闲项目无法区分，"先处理谁"就退化成逐层展开去找。上卷复用同一份 Session 投影与共享状态语汇，不建第二个聚合管线；一行只显示其下**最紧要**的那一个信号（needs-you 优先于 error），并带形状而非仅靠颜色。`done` 不点亮任何行——完成已由通知与 Board 承载，常驻标记会让整条栏长亮，从而淹没"有人在等你"这唯一要紧的信号；`disconnected` 同样保持中性。
- **后台 Agent 主动出声**：完成、需要你、失败三类状态跃迁在用户看不到该 Session 时升起系统通知。原生通知能力只由 Desktop Main 持有并经 typed IPC 暴露，Renderer 不直接触达 OS，也不持有第二份通知状态；点击由 Main 聚焦窗口，去哪个 View/Region 仍由 Renderer 决定。"是否值得打扰"是一个**纯判定**，由通知、上卷与名册三面共用，绝不各自从状态字段重新推导：同一状态重复上报不算跃迁（Provider 会重播状态）；首次见到不算跃迁（否则挂载到一屏早已完成的 Agent 上会炸出一串通知，教会用户忽略这个通道）；用户正在看的那一个不打扰（点与 Activity 已经在讲了）。可见与否是**派生**的而非猜测——某 Session 占据某个 Tab Group 当前活动 Tab 的一个 Region 才算在屏上，因此窗口聚焦时仍会为背后 Tab 里的 Agent 发通知。投递结果是 typed 的：`shown` 与 `unsupported` 必须可区分，平台或用户系统设置拒绝时**明确降级并只报一次**（会拒绝的系统每次都会拒绝，重复上报会把一次诚实失败变成噪音），此时窗口内的点与 Board 仍照常承载该事实。关闭通知期间发生的跃迁只推进基线、不排队，重新打开不回放积压。

### Tab 与 Pane

- Agent/Terminal 内容上方只保留一行 Tabbar，不再显示第二条 Session Info Bar。
- Agent Tab 使用 Provider 图标并叠加语义状态点；Terminal Tab 使用 Terminal 图标，不能用同形状态点同时表达内容身份。
- 语义状态点是全窗口共享语汇（StatusDot 与 Attention Bar 的 StatusCount 同源）：`waiting`/`blocked`（"需要你"）带 `?` 字形而非仅靠颜色，`disconnected` 用中性空心环从琥珀让出，使琥珀唯一表示"需要你"；字形只在全尺寸点上浮现，Tab 角与 Rail 行的 5px 角标仍只用颜色加位置区分。详见 `agentmux-surface-density.md`「响应式与可访问性」。
- Tab 保持稳定可读宽度和单行名称；窄 Pane 使用自身横向 overflow、左右导航和自动滚入可见区。
- Active Run 的 Stop 是 Tabbar 内的图标动作，继续使用统一确认和 Core stop owner。
- `Split` 表示拆分当前 View 内容；移动整张 Tab 使用独立命令和拖拽落点，两种预览和结果不能混用。

### Agent Composer 与 Terminal

- Composer 属于 Agent Session Region，不属于 Activity。Agent 的 Terminal 与 Activity 只是同一 Session 的两种投影；切换投影时 Composer 必须保持挂载，不能清空未发送草稿。
- Activity 投影画成时序日志而非卡片流，但日志有**两个寄存器共用同一条 spine**。机器上报（tool_call / permission / lifecycle）保持 24px 紧凑行：一连串 native-hook 步骤折叠成一条 “N steps” 摘要，展开后字节完全相同的重复合并为一行并标 xN，重试循环因此读作一个事实；工具调用的 argv 默认折叠、按需展开。人真正要读的**对话回合**（user_message、assistant_message）脱离这条机器寄存器：它们沿同一条 spine、同一个 20px 节点槽渲染，但正文用 13px 主色、caption 只是一枚安静的 speaker 标签，始终完整渲染、永不折叠——那是 trace 的实质，不是 payload。折叠只按 kind 收机器步骤，assistant 回合虽是 native-hook 也绝不被卷进折叠；不为任一回合重建 per-hook 卡片。User 正文用 `--surface-1` 圆角填充给出起止边界（描边不作手段），Assistant 正文在工作面上流动，二者靠 blue/green 图标与填充差别在一眼之内区分。顶部 ruler 的诚实时间轴与无跨度时的序数退化见 [`agentmux-surface-density.md`](./agentmux-surface-density.md) 的 Activity Ruler。
- 每个 Agent Region 都显示同一个 Composer。Agent 尚在启动、已经断连、退出或中断时仍显示，但在 Agent Run 不可交互时禁用；Raw Terminal 永远不显示 Agent Composer。
- Composer 使用独立、受控、无 Store 依赖的可复用输入组件；Session adapter 负责草稿、当前文件、Submit 与 Interrupt 绑定，为附件和其他富输入能力保留唯一扩展面。
- Renderer 不根据 `working`、`waiting`、`blocked` 或 `done` 猜测 Prompt readiness。Core 拒绝提交时保留草稿供重试；semantic resume 和恢复动作继续由现有 Owner 负责。
- Provider/ACP 报告的 semantic status 与 pending interaction 由 Core 持久化。Desktop 刷新或重新 Attach 时优先投影这份 Agent 语义；新的 Run `running` 事实只更新进程态，不能覆盖 `working`、`waiting`、`blocked` 或 `done`。Run 退出或中断仍由进程事实结束当前可交互态。
- Approval/Question 卡片只渲染 Core 的 typed request，选择后只经 typed IPC 调用 Core 的 semantic response API。Renderer 不解析 `status.detail`，不发送裸 ESC、数字选项、普通 Prompt 或 raw PTY fallback。Run interruption 使用独立 typed reason 控制恢复分支，`status.detail` 只做人类可读展示。Permission request 携带 Provider **声明**的每一个 scoped option（allow-once、可选 allow-always、deny），与 launch option 同构地在紧邻 interaction protocol 处按 Provider 声明，沿用相同的 DESCRIBE/CONTRIBUTE 拆分：兑现某一行的按键（`input`）只留在 Core，DESCRIBE 半边（id/label/kind/description/tier）跨 IPC 供 Renderer 渲染；回复时按用户实际选中的 option 解析出它声明的按键，绝不固定发 '1'。只声明位置**稳定**的行——Claude 的三行提示（Yes / Yes 并不再询问该工具 / No）行 2 位置不变，故 Claude 诚实获得 live 的 allow-always；Codex 的中间行按命令/主机/文件动态出现和重排，故其 live 列表只保留 allow-once 与 deny，更激进的 auto/never 姿态由既有 launch option 在启动时提供。只有 codex 与 claude 走到这条 permission 管线（其余 Provider 为 `none` | `observe`）。当前 Question 只展示 Core 已验证的单题单选能力。
- 待处理 interaction 出现时，卡片成为当前 Agent 唯一用户输入面；Composer 保持挂载和草稿但禁用 Prompt，Agent Terminal 的键盘、粘贴和 capability reply 也停用，直到 request 被 Core 结算。卡片提交只有在 Provider delivery 与 Core settlement 完成后才显示成功；失败保留明确错误，不提前消失。`working` 时 Composer 的唯一主动作仍是 Stop，并调用 Core semantic interrupt。启动姿态（sandbox/approval/permission-mode）只在 Launcher 一次性设定；Composer 上的 live permission 控制有且仅有两条诚实通路：其一是用更宽的 scope 回答挂在 agent-input-stack 上那张 pending request 卡片；其二是 Provider 声明了**可寻址**的 in-band posture 控件时（见下文 posture control），在 Composer 上直接切到某个具名 mode。两者都经 PTY-input 通道兑现运行中进程的自有 affordance——启动 argv flag 永不作为 live composer 开关出现，因为它对运行中的 PTY 进程静默 no-op。
- Composer 表面透明，只用边界、工具动作和 focus ring 表达层级，不使用黑色填充或黑色投影。Approval/Question 卡片相反：用实心 Surface 填充与 elevation 承载重量，并以一枚琥珀 STATUS 图标表达“需要注意”这一状态——不用描边（描边会与紧邻其下的 Composer 争夺同一条边界），也不用常驻的彩色边（accent 表达状态，不作装饰）。卡片内的动作是同一种等高按钮，图标与文字共享中轴；allow-once 是唯一实心品牌绿主操作（最安全的肯定动作才承载最重的分量，绝不让最宽 scope 的按钮成为主操作），scoped 升级为 secondary 并以一枚克制的 tier 圆点表达风险状态；deny/dismiss 分置一侧，Dismiss 是退出而非裁决并降为 ghost 权重。option 数≥2 个 allow 时，allow 采用 CLI 自身的竖排编号节奏，否则保持紧凑动作行。
- Composer 的附件与粘贴图片都产出**路径引用**，由 Agent 自行读取，Composer 不内联文件内容。这是运行时事实决定的：prompt 通道是有字节上限的纯文本，且当前没有 Provider 走 ACP，不存在把二进制送进模型上下文的通路。粘贴的图片由 Desktop main 落盘（渲染进程只提供字节，不指定写入位置与文件名），再以与附件相同的引用形式进入草稿。工作区内的路径写成相对路径，因为那才是 Agent 的工作目录能解析的形式。
- 引用当前打开文件的快捷方式只在确有打开文件时出现。它是快捷方式而非第二条附件通道，没有可引用对象时隐藏，不以禁用态占位。
- Terminal 使用 xterm 的真实字符网格、DPR 和 TUI 输入。没有 pending interaction 时，Agent Terminal 的 xterm TUI 输入与 Agent Composer 是同一 Agent 的两条明确输入路径；Raw Terminal 只保留 TUI 输入。
- Terminal 链接只在手势确实是**点击**时才响应：指针位移超过阈值或留下选区，都判定为选择文本而非点击链接——拖选跨过链接不得触发打开。悬停显示目标与打开方式，锚定位置永不遮挡它所描述的那一行链接。链接分两类，共用同一套手势守卫与悬停预览：http(s) URL 由 web-links 拥有，Cmd（非 macOS 为 Ctrl）+ 点击直接在系统浏览器打开，普通点击走目标选择菜单；文件路径由一个独立 link provider 拥有，普通点击在编辑器 Region 打开该文件。
- Terminal 文件路径识别是**纯语法、保守**的：检测在 xterm 渲染/悬停热路径上运行，只做字符串工作——读 xterm 已持有的那一行 buffer 文本并用纯函数匹配，热路径上没有磁盘或 IPC，更不做存在性探测。规则的关键判据是「core 含 `/` 或带 `:line` 后缀」，据此丢弃裸词（`e.g.`、`1.2.3`、`README`）却仍捕获 `README.md:3:1` 与真实相对/绝对路径；绝对路径仅当落在活动 Workspace 根内才识别，`~/`、逃出根的相对路径不识别。识别出的路径归一为 Workspace 相对路径，交给与 Explorer 同一个 `openFile` seam 打开；带 `:line[:col]` 时通过一次性 reveal target 落到该行。误报或不存在的路径在点击打开时经 reportError 明确失败，绝不静默——「点击开不出来」而非污染状态。相对路径按 Workspace 根解析（非终端 live cwd）。
- Terminal 主题只属于 Desktop Renderer。ctxmux、RunSpec 和 Core 公共合同不出现主题字段。
- Renderer 负责把最新 `cols × rows` 通过 Core 公共 Resize 提交给 ctxmux；resize 热路径只保留一个在途请求和一个最新 pending size。
- Replay、Live、Gap、ACK 与 Attachment lease 均服从 ctxmux/Core 的 ordered-byte 合同，View 不建立补偿状态机。

### Browser 工作面

- Browser 是 AgentMux 内的一等工作面，不是外链跳板：它可导航、可标记、可被 Agent 安全消费，且生命周期与权限事实**只由 Desktop Main 持有**。Renderer 既不拥有 WebContents，也不持有第二份导航或权限状态。
- 页面**元素选择**产出结构化上下文——tagName、role、可访问名、selector、文本、邻近文本、白名单属性与净化后的 HTML——并以文本形式进入 Composer 草稿，与其他附件同一条通路。净化在 Main 侧完成，Renderer 不把原始 DOM 当证据传递。当前**不采集 computed CSS**，截图也**只进剪贴板、不并入 prompt**：这两点是已知边界，不以"看起来完整"的措辞掩盖。
- 截屏与标记编辑属于 Browser 自己的工具，产物是可验证证据而非装饰：标记后的图像仍是同一次观察的产物，不重建第二份截图生命周期。
- 链接打开使用统一的**目的地菜单**（当前 Region / 分屏 / 新 Tab），与 Terminal 链接共享同一套目的地语汇，不让浏览器另发明一套打开语义。
- Browser Profile 由 Browser Tools 导入，凭据与 Cookie 归 Main；导入路径落在 Workspace/Profile 约束内，逃出约束一律 typed 失败关闭，不静默降级到默认 Profile。
- 内置浏览器只能打开本机可达的地址。**没有 SSH 转发或隧道**，因此"看远端主机的 dev server"当前不成立——这与 Remote 能力整体延后一致，不为它单开一条私有通路。

### Explorer 与 Editor

- Explorer 以 Selected Worktree 为根，使用层级目录、文件夹优先排序、多选、键盘导航、Reveal、刷新和受 Workspace Root 约束的文件操作。Move 当前明确为单项操作：Pointer drag 在开始时收敛到被拖动项；Context Menu/`Shift+F10` 使用 `Move This Item to` 子菜单，并在执行时收敛到该项，不用多选外观暗示尚未实现的批量移动。
- Stale response 不能覆盖新 Workspace 或新目录 revision；刷新期间保留现有内容，直到新结果原子替换。
- Desktop Main 是 Workspace 文件与磁盘版本的唯一事实 Owner；`packages/core` 不承载文件服务，
  Renderer 不直接读写磁盘，也不维护第二份文件 revision 或 watcher truth。
- 打开文件时由 Main 返回内容与不透明 revision；保存必须携带读取时的 revision，并由 Main 在
  Workspace Root 约束内原子替换。磁盘内容已经变化时保存必须明确冲突并保留编辑草稿，不能静默覆盖。
- 外部工具或 Agent 修改已打开文件时，由 Main 发布权威变更。无本地草稿的 Document 自动读取新
  revision；有本地草稿的 Document 保留草稿并进入明确冲突状态，不能假装保存成功或悄悄回退内容。
- 文件 Rename 和删除先由 Desktop Main 完成磁盘操作；成功后，Renderer 用一次纯 reducer 原子更新 Document、Dirty、Last Active、Tab Group、View/Region 路径以及当前 Workspace 的 Explorer Selection/Expanded 投影。路径映射若会占用已有 Tab、Document 或 Region owner，Renderer 会在请求磁盘操作前拒绝。
- 路径映射使用 segment-aware 子树判断。受影响保存先被 mutation admission 阻止并等待静止；磁盘失败或最终位置未知时不提交 Renderer 映射。active-file auto-reveal 若 Selection 已含该路径且 ancestors 已展开，必须原样返回并跳过 Store 写；确需 Reveal 时只原子补齐 ancestors，并保留包含 active path 的现有多选。
- Drag 与菜单从同一份已加载文件树 facts 预计算 Move plan；同 parent、自身或后代目标、已加载的 destination collision 不显示为可提交目标，也不依赖 Main 最终拒绝来代替交互计划。
- Darwin Local move 使用同一 Desktop owner 构建和分发的原子 no-replace helper，同时执行 Workspace Root-relative、no-follow 和 no-clobber 约束。Renderer 的 Rename、Drag 和菜单入口使用同一 move transaction；helper 缺失或平台无法满足合同会明确返回 typed unsupported，不回退到普通 `rename`、`mv`、重试或事后回滚。
- Main 只有在 helper 明确成功时返回 `moved`，明确未提交时返回 `finalLocation: source`；commit 后回执缺失始终返回 `finalLocation: unknown`，不得用 source/destination pathname occupancy 猜对象身份。Renderer 对成功或 unknown 并发、去重重读恰好 source/destination 两个 parent，对确认留在 source 的失败不刷新；unknown 仍不提交路径投影。
- 内置 Editor 保存 Topic 的 `topic.md` 后使 Topics 文件系统快照失效并重读，不建立第二份 watcher 或 Renderer Topic Registry。
- Monaco 只声明当前真正注册的语言能力；未知或未注册语言回落 plaintext，不伪造 tokenizer。

#### Revision-aware 保存与外部冲突

- Desktop Main 的 `WorkspaceFiles` 独占 Workspace Root confinement、磁盘 revision、同目录临时写入、同步、mode 保留、原子替换、单文件观察和磁盘错误事实。Shared contract 与 preload 只暴露 typed read、write、observe 和 move 能力。
- Read 返回内容和不透明 revision。Write 必须携带 expected revision，只返回 `written | conflict | error`。Remote workspace 无法满足同一原子保存合同时返回 typed unsupported。
- 临时写入或替换失败会清理临时文件并保持原文件字节不变。普通文件系统 revision 是 optimistic concurrency signal；最终 revision 复核与原子替换之间仍存在外部进程竞争窗口，不宣称强跨进程 compare-and-swap。
- Renderer 持有 Monaco buffer、dirty、保存 generation、observation generation、document lifetime 和冲突交互。每文件保存串行化；保存期间继续输入时旧 written 回执只更新落盘 revision，不清除更新后的 buffer 或 dirty。
- Main observation 只发布 `{ workspaceId, path }` 失效事实，Renderer 重新 read。Clean buffer 自动采用新内容与 revision；dirty buffer 保留草稿并进入 changed/deleted conflict；read error 保留最后 buffer且不能伪装成删除。
- Reload 明确采用 observed disk state。Overwrite 使用最近一次 observed revision；若磁盘再次变化则继续 conflict。旧 save/read completion 不能越过 close、reopen 或 move 的 lifetime 边界修改新文档 owner。

### Board 与 Settings

- Board 是 `Branch/Worktree × Inbox/Working/Needs You/Done` 的二维矩阵。状态变化只在同一 Branch 行内移动。
- Inbox 是矩阵第一列和带 Branch 上下文的创建入口，不是 Tools 中的重复页面。
- Settings 按可操作资源优先组织为 Workspaces、Hosts、Agents、Appearance、General；默认打开第一个可操作分区。
- Agent Detection 以 Host 为键，由 Core discovery 统一投影到 Settings、Launcher 和状态面。

### Provider Launch Option

- Provider 以数据形式声明自己可供选择的启动项（例如 model、权限或沙箱模式）。每个 choice 把 UI 展示的标签与兑现它的 argv 写在同一处，两者不可能漂移。
- 契约分成两半：describe 半边是纯数据，跨 IPC 供 Renderer 渲染；argv 半边只留在 Core。**Renderer 永远看不到命令行**，Launcher 也永远不知道 Provider 的名字——任何调用点都不得按 `providerId` 分支决定启动项。
- 未声明即不渲染。Provider 落地速度不同是常态，没有声明的启动项在界面上完全不出现，而不是显示一个禁用控件。给某个 Provider 后补一项能力，不需要改动 Renderer 任何一行。
- 作用域是**启动时**，这不是过渡方案而是运行时的全部事实：Agent 是经 PTY 驱动的真实 CLI 进程，当前没有 Provider 走 ACP，不存在能让运行中进程改换 model 的通道。把选择编码进 spawn 时的 argv 是运行时唯一能兑现的形式，类型系统据实表达这一点，不得用暗示"运行中可切换"的控件掩盖它。将来某个 Provider 具备 ACP 后，实时能力作为**并列**的另一项能力加入，启动时这一条不被拆除。
- 只声明对着真实二进制核实过的 flag。核实不了的一律不声明——这正是部分 Provider 目前不提供任何启动项的原因。核实的对象是 Provider 真正的可执行文件（如 cursor 是 `cursor-agent` 而非 `cursor`），拿错二进制核实等于没核实。
- **不声明自由字符串 model**。gemini / grok / traex / hermes / antigravity 的 `--model` 都收任意字符串、无枚举，手写一张模型名清单会在厂商改动阵容时立刻过期；只有当 CLI 自身 `--help` 明确枚举了别名（如 claude 的 fable/opus/sonnet）才声明。核实到的是**枚举**才落一个选项：gemini `--approval-mode`、grok/claude/traex `--permission-mode`、codex/traex `--sandbox` 都是显式 possible-values；hermes `--yolo`、antigravity `--sandbox` 是布尔开关，落成两档 choice（保守档贡献空 argv，激进档贡献 flag）。每档 tier 据实标注：绕过审批或沙箱为 `danger`，收窄一类为 `caution`，保守默认为 `safe`（agy 的 `--sandbox` 是**加**限制，故开启档才是 `safe`，无沙箱的默认档为 `caution`）。
- Permission option 是并列的一套按 Provider 声明（见 `packages/core/src/agent-interaction.ts` 的 `TerminalPermissionOption`）：与 launch option 同构地拆成 describe/contribute 两半——DESCRIBE 半边（id/label/kind/description/tier）跨 IPC，CONTRIBUTE 半边（回答提示的 PTY 按键 `input`）只留在 Core，于 reply 时解析。两者的区别在于作用时机：launch option 作用在 spawn 的 argv，permission option 作用在运行中 Provider 自己的编号提示上；同样只声明位置稳定、对真实 CLI 核实过的行。
- Posture control 是第三套并列声明（见 `packages/core/src/agent-interaction.ts` 的 `PostureControlDeclaration` 与 `createPostureControl`），是 Composer 上"这些权限设置也要能在聊天框上设"这一诉求唯一诚实的兑现方式。它专治运行时的 live 权限姿态：与 permission option 同处 Provider 的 interaction protocol 声明，同样拆成 DESCRIBE 半边（`AgentPostureControl`：control 的 id/label + 每个 mode 的 id/label/description/tier）跨 IPC，CONTRIBUTE 半边（每个 mode 的 in-band 按键 `input`）只留在 Core，由 `planPostureSet(modeId)` 在 set 时解析、经既有 PTY-input 通道（`setAgentPosture` → `writeAgentInput`）写入。诚实性由结构强制：一个 posture control **必须**声明 ≥2 个 mode，每个 mode 的按键**非空且互异**——因此一个只有盲态 Shift+Tab cycle（一枚按键在读不到的状态间轮转）的 Provider 结构上无法被表达成 set-mode 控件，绝不会伪装成"切到 mode X"。**盲发按键是真实风险，故只声明效果确定、可寻址的控件**：仅当存在能指名目标态的 slash 命令时才声明。据此对着真实二进制复核后，只有 grok 合格——它的 `/always-approve [on|off]`（clap ValueEnum 核实）给出 Ask / Auto-approve 两个各由独立 slash 命令 SET 的具名 mode；claude、gemini、codex 只有盲态 cycle（codex 另有无法盲导航的 `/approvals` 弹窗），一律不声明，Composer 对它们不画任何控件（未声明即不渲染）。控件是 fire-and-forget 的 SET，不是有状态开关：Composer 从不标记"当前 mode"，因为 live 姿态活在读不到的 CLI TUI 里，标一个 active mode 就是谎称掌握了它——菜单只提供可寻址的目标态，当前落点归 CLI 自己。

## Owner 边界

| 事实或动作 | 唯一 Owner | Desktop 的职责 |
| --- | --- | --- |
| PTY、进程、Run、ordered bytes、Replay、Gap、Attachment | ctxmux | 通过 Core 公共 API 消费 |
| Provider、Agent Session、Hook、Permission、Prompt readiness、Agent status、semantic resume | `packages/core` | 投影状态并发起公共命令 |
| Tab Group、View、Region、焦点、尺寸与空间组合 | Desktop Renderer | 保存和变更界面布局 |
| Workspace Root、revision、写入、观察、move、Git、Browser WebContents 与原生系统能力 | Desktop Main | 提供 typed IPC 和最终磁盘事实 |
| File tree、buffer、dirty、generation、冲突、路径映射与交互 | Desktop Renderer | 消费 Main 事实并原子投影视图状态 |
| Topic 内容与协作者身份 | Scratch 文件系统 | 枚举、导航和绑定 View |

任何一层都不得为方便 UI 再持有第二份 Runtime、Session、Topic、Layout 或磁盘真相。

## 验收原则

- 行为验证优先于 CSS 声明：Production Electron 要检查真实尺寸、DPR、overflow、焦点、拖拽落点和恢复结果。
- 安全与状态一致性不能由截图替代；`pnpm check`、Owner-level tests 和相应 Production Gate 必须通过。
- 文件保存覆盖继续输入、外部修改、删除、读取失败、写入失败和替换失败；草稿不被静默覆盖，原文件不被失败写入截断。
- 文件移动覆盖目标碰撞、外部竞争、Workspace Root/父目录换代、source/destination 被无关对象替换、helper 缺失和 syscall 后回执失败；磁盘未确认成功时 Renderer 状态保持不变。Packaged Electron Explorer probe 另覆盖 PointerSensor、Radix Move 子菜单、`Shift+F10`、非法 drop、500ms hover expand/cancel cleanup、单项选择收敛、Workspace 回访和 Workbench DnD 隔离；既有 file-editing probe 直接订阅 mounted Zustand owner，证明满足态回访零 Explorer projection 通知，并用 move commit barrier 证明旧 Workspace closure 的两个 parent refresh 在 Renderer admission 被拒绝、未到达 Main 或污染当前 Workspace cache。
- 资源收益只用同一场景的 before/after 数据声明，不强制 GC，不卸载仍使用的 Surface，不增加全局 Cache 框架。
- 一个用例只证一件事。把 N 个各自 spawn 子进程的场景串进同一个 `it`，会同时买下三样坏东西：耗时叠加逼近默认超时（并发跑时先炸的就是它）、失败时不指出是哪个场景、以及后面的场景被前面的失败挡住从不执行。安全性质要逐操作立各自的用例，并断言注入钩子已被消费——钩子没触发的绿是假绿。
- Unsupported 能力明确失败关闭；不加兼容层、migration、fallback、第二 Runtime Owner 或隐藏 Registry。

## 非目标

- 不把 AgentMux 做成另一个 Run Runtime。
- 不把 Desktop 布局、Topic、Provider 或 Agent 语义下沉到 ctxmux。
- 不为命令对称、未来平台或未出现的规模证据预建功能。
