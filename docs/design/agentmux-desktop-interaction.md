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
- **一个 Topic 容纳多个 Agent，不是一 Agent 一 Topic**。同一 Topic 里的参与者关系在磁盘侧以 collaborators 表达（Scratch 文件系统是唯一真相），不另建 UI 侧的 Topic Registry；Topic 之间的切换归 Topic 面板，不靠 View 或 Tab 的开合暗中改绑。因此 `topicId` **绝不由 `tabId` 派生**——把当前 Tab 的 id 当作 topicId 会让每开一个 Tab 就凭空多出一个 Topic，与"一 Topic 多 Agent"直接矛盾；目标 Topic 由启动意图显式携带，缺失时不绑定任何 Topic 而非发明一个。
- Topic 条目的目录动作只在内置 Explorer 中展开、选中并滚动到对应目录，不调用 Finder 或其他系统文件管理器。
- Topic 条目的改名是对 `topic.md` 一级标题的语义编辑；`topic--*` 目录、`topicId`、Agent cwd 和 View 绑定保持稳定，Explorer 不向这些顶层目录暴露通用 Rename。
- **切 Topic 就换那一组 Tab，和项目里选 Branch 是同一种体验**。Branch 之所以天然换掉整条 Tab 条，是因为布局按 Workspace 键控、每个 worktree 就是一个 Workspace；而 Scratch 的所有 Topic 共用一个 Workspace，若不做处理，切过去会看到别的 Topic 遗留的 Tab。因此当前 Topic 是一个显式状态，Tab 条按它投影：**布局仍只有一份，过滤发生在渲染时，不建第二份 Tab 状态**（Topic 的真相仍在文件系统）。两条边界：**未绑定任何 Topic 的 Tab 始终可见**——它不属于任何 Topic，藏起来就再也找不回了；**活动 Tab 要跟着 Topic 走**，判据是"它属于这个 Topic"而不是"它还看得见"——让一个未绑定的 Tab 在切换后继续当活动项，等于切过去却什么也没发生。
- **选中一个 Topic 之后必须真的只看到它自己的 Tab**。上一条描述的投影只有在"当前 Topic"这个状态确实被设过时才生效——如果用户是通过点 Tab、恢复会话或任何 Topic 面板以外的路径进入某个 Topic 的，当前 Topic 仍是空，于是所有 Topic 的 Tab 一起摊在条上，这正是用户看到的混乱。**当前 Topic 必须从当前活动 Tab 的绑定派生，而不是只由 Topic 面板的点击设置**：活动 Tab 绑了哪个 Topic，当前就是哪个 Topic；活动 Tab 未绑定则不过滤。这样"选中 Topic"这件事无论从哪条路发生都成立，也不需要第二份状态去和它同步。
- Topic 面板与文件树共用内容槽时，**默认高度偏向 Topic 面板**：Topic 是 Scratch 的一等对象，文件树是它的底料。文件树默认占更小的一份。
- Topic 行的动作按频次分层：**定位到该 Topic 的目录**是高频、留在行上（图标要表达"聚焦定位"而不是"打开文件夹"，因为它不离开 AgentMux）；**改名**是低频，收进行的右键菜单，不在行上常驻一个图标——每多一个常驻图标，行的可读宽度就少一分。
- Topic 行**不用左侧竖条表达选中**。选中态是单一几何信号（干净的 Surface 填充），与全局控件语言一致；行首也不放没有区分意义的装饰图标——一列全同的图标不携带任何信息，只在消耗宽度。
- **Topic 行的 Agent 呈现为一组头像**，不是一排抽象的点。每个 Agent 用缩小的 Provider 图标（用户据此一眼看出这一行里跑着谁），**状态由边框表达**而不是另一枚色点；悬停有轻量抬升与 tooltip 给出名字与状态，点击直接定位到该 Agent。这三件事——身份、状态、导航——过去要用户读完整行文字才知道，头像列把它们压进一个可点的小方块里。
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
- **投影可以被显式移动到另一个 Workspace 的 View**，这只搬动展示身份、不动 Agent 事实。cwd 归 Core（`session.workspacePath`，一个已在运行的进程的工作目录），移动**绝不改变** `session.workspacePath`——没有任何通道能让运行中的进程改换工作目录，所以移动后这条 Session 的 Tab **仍**如实显示它自己的工作目录（cwd），不冒用目标 Workspace 的磁盘路径或名字。移动是用户按 Region 显式发起的（Tab 菜单选目标 Workspace），落点复用既有的 selectSession 导航；新建 worktree **绝不**把任何 Session 的投影**自动移动**过去，创建 worktree 与移动投影是两个独立动作。
- Desktop 只持久化 Session/Run 在哪张 View 的哪个 Region，不复制 PTY、Replay、Agent 状态或进程生命周期。

### 寻址与复制

- **复制出去的是一个寻址方式，不是一个 id**。任何"复制"动作的成品都必须让接收方（通常是另一个 Agent）**仅凭这一次复制**就能完成寻址：说清目标是什么身份、给出可直接执行的命令。裸 id 不合格——接收方拿到 `session:abc` 或一串 uuid，无从知道它是哪一层身份、该配哪个 flag、该跑什么命令，只能回头问人或翻文档，而那正是这次复制本该省掉的一步。
- **三级地址回答三个不同的问题，绝不互为别名**（与上文 Session/Run/View 的身份边界同源）：
  - **Session** 回答"**哪个 Agent**"——Provider 语义身份，跨 View 稳定，一个 Session 可同时投影到多个 Region 与多个 Tab；
  - **Region** 回答"**屏幕上哪一格**"——View 内的内容 leaf，是分屏场景下**唯一无歧义**的展示身份；
  - **Tab/View** 回答"**哪张完整工作面**"——它只在该 View 恰好承载唯一一个 Agent 时才可用作 Agent 寻址。
- **歧义在源头消除，不甩给接收方**。一张 View 分屏承载多个 Agent 时，Tab 地址本身就是歧义的；此时复制出的地址必须**直接是 Region 地址**，而不是一段"先 inspect、若返回 `MESSAGE_TARGET_NOT_UNIQUE` 再从 candidates 里挑一个"的操作指引——把消歧工作转嫁给接收方，等于这次复制没有把寻址方式说清楚。歧义只在源头可见：复制发生时我们知道用户点的是哪一格，接收方不知道。
- **复制入口按其能消除的歧义就近放置**：**Region 右键菜单**产出 Region 地址（用户点哪一格就是哪一格，无需推断当前聚焦，而想寻址的那一格往往恰恰不是聚焦的那一格）；**Tab 右键菜单**产出 View 级地址，语义收敛为"整张工作面"。同一 Session 在两处产出的 Session 地址必须一致——它们是同一份真相的两个入口，不是两套格式。
- 复制的地址**只使用已被 CLI 与 Control 面接受的寻址方式**（`--to-session` / `--to-region` / `--to-tab` 及 `inspect` 的对应 flag），不为复制发明第二套语法。地址里的 id 一律按 shell 语义转义，使带空格或引号的 id 粘贴即可执行。
- 后台 Agent 由 Agents 工具重新发现和打开，不建立第二份 Session Registry。
- **Agent 自己就能把 terminal、browser 或文件开到某个方向的分栏里**，走的是既有的 `open` / `arrange` CLI——那已经是"Agent 驱动界面"的接口，**不新建第二条通路、不新增 surface kind**。缺的从来不是能力而是发现：因此由启动时注入的提示负责让每个 Agent 知道这件事存在、并知道去哪查确切用法，而**不把完整 CLI 语法抄进提示**（那会与 skill 争夺唯一真相，并在语法演进时立刻过期）。这条的验收是行为断言——证明启动路径确实携带了该提示，而不是断言 skill 文本里含某个字符串：后者在改动前也会通过，证明不了任何事。

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
- **切回一个开过的 Tab 不重来一遍**。用户的说法是"现在切换是都会 restoring terminal"。恢复态每次
  切换都亮，根子在一个决定：把"不可见"实现为"不渲染"。只挂活动 Tab 时，切走即卸载整棵子树、
  xterm 实例随之销毁，切回时只能从头重放全部 scrollback——恢复态不是慢，是必然发生。因此
  **非活动 Tab 留在 DOM 里、用 CSS 隐藏**：实例活着，就没有东西需要恢复。修法在保住实例，不在
  把重放做快。三条边界：
  - **保住实例的代价必须为零**，这是首要约束不是优化项。不可见的 Region 里终端与原生表面一律
    停工——不 fit、不 resize、不渲染，且不新增常驻定时器或监听；否则开十个 Tab 就是十份持续开销，
    等于拿一种卡顿换另一种。这类退化不会让任何行为测试变红（画面仍然正确），必须显式断言。
  - **实例的存活边界严格等于 Region 的存活边界**：关闭 Region 即销毁实例。**不建终端实例缓存池**
    ——那会造出第二套终端生命周期，谁回收、何时回收都无人负责，与 Region 是展示身份 SSOT 直接冲突。
  - **恢复态本身不删**。真的没有内容可显示时——首次 attach、断连重连、replay 有缺口——仍要如实说
    正在恢复。删掉它会更安静，但那是拿谎报换安静：用户会盯着一个空白终端不知道在等什么。
  - 隐藏用 `visibility` 而非 `display:none`：后者的子树量不到尺寸，切回时得先重新 fit 一次才显示对的
    行列数，那正是要消掉的那一帧。隐藏格必须 absolute 叠放，留在文档流里会把活动格挤变形。

### Agent Composer 与 Terminal

- Composer 属于 Agent Session Region，不属于 Activity。Agent 的 Terminal 与 Activity 只是同一 Session 的两种投影；切换投影时 Composer 必须保持挂载，不能清空未发送草稿。
- Activity 投影画成时序日志而非卡片流，但日志有**两个寄存器共用同一条 spine**。机器上报（tool_call / permission / lifecycle）保持 24px 紧凑行：一连串 native-hook 步骤折叠成一条 “N steps” 摘要，展开后字节完全相同的重复合并为一行并标 xN，重试循环因此读作一个事实；工具调用的 argv 默认折叠、按需展开。人真正要读的**对话回合**（user_message、assistant_message）脱离这条机器寄存器：它们沿同一条 spine、同一个 20px 节点槽渲染，但正文用 13px 主色、caption 只是一枚安静的 speaker 标签，始终完整渲染、永不折叠——那是 trace 的实质，不是 payload。折叠只按 kind 收机器步骤，assistant 回合虽是 native-hook 也绝不被卷进折叠；不为任一回合重建 per-hook 卡片。User 正文用 `--surface-1` 圆角填充给出起止边界（描边不作手段），Assistant 正文在工作面上流动，二者靠 blue/green 图标与填充差别在一眼之内区分。顶部 ruler 的诚实时间轴与无跨度时的序数退化见 [`agentmux-surface-density.md`](./agentmux-surface-density.md) 的 Activity Ruler。
- 每个 Agent Region 都显示同一个 Composer。Agent 尚在启动、已经断连、退出或中断时仍显示，但在 Agent Run 不可交互时禁用；Raw Terminal 永远不显示 Agent Composer。
- Composer 使用独立、受控、无 Store 依赖的可复用输入组件；Session adapter 负责草稿、当前文件、Submit 与 Interrupt 绑定，为附件和其他富输入能力保留唯一扩展面。
- Renderer 不根据 `working`、`waiting`、`blocked` 或 `done` 猜测 Prompt readiness。Core 拒绝提交时保留草稿供重试；semantic resume 和恢复动作继续由现有 Owner 负责。
- **运行中可 steer**：Agent 处于 `working` 时界面仍允许提交，补的那句话经**既有** send 通路（store.send → submitPrompt → Core.submitAgentPrompt）送出，与普通 prompt 同一条路——不新增 Renderer 侧第二条写通道。「界面是否允许提交」与「主动作是 Send 还是 ■」是两个不同问题：working 时前者为真而后者仍是 ■，一个跑动中的 Agent 既要能被补话也要能被叫停，二者不互斥。判定收敛为一个纯函数（`lib/composer-submit-mode.ts`），不读 Store、不按 providerId 分支。
  - 这**不是**"working 时提交一律送达"的承诺。能否送达仍由 Core 裁决：render-then-submit Provider（9 家里只有 codex）的 mid-turn steer 会被 Core fail-closed 拒绝，那是一等预期而非缺陷。被拒时草稿保留（这就是诚实的"没送出去"信号），且不产生任何 user 回合——Core 在记录回合之前就抛错。合同不得被改写成普遍送达承诺，那会与 codex 已封的 readiness 门自相矛盾，并诱导后人去削弱它。
  - pending interaction 期间**不允许** steer：待答请求期间卡片是唯一输入面（既有合同），Renderer 侧不提供提交、Core 侧亦抛 `AGENT_INTERACTION_PENDING`，双重保险。
  - 不做输入队列：下游 CLI 自带输入行，且就绪门控对 8/9 Provider 不可实现，排队只会制造一份界面以为已送达、进程并不知情的假状态。
- Provider/ACP 报告的 semantic status 与 pending interaction 由 Core 持久化。Desktop 刷新或重新 Attach 时优先投影这份 Agent 语义；新的 Run `running` 事实只更新进程态，不能覆盖 `working`、`waiting`、`blocked` 或 `done`。Run 退出或中断仍由进程事实结束当前可交互态。
- Approval/Question 卡片只渲染 Core 的 typed request，选择后只经 typed IPC 调用 Core 的 semantic response API。Renderer 不解析 `status.detail`，不发送裸 ESC、数字选项、普通 Prompt 或 raw PTY fallback。Run interruption 使用独立 typed reason 控制恢复分支，`status.detail` 只做人类可读展示。Permission request 携带 Provider **声明**的每一个 scoped option（allow-once、可选 allow-always、deny），与 launch option 同构地在紧邻 interaction protocol 处按 Provider 声明，沿用相同的 DESCRIBE/CONTRIBUTE 拆分：兑现某一行的按键（`input`）只留在 Core，DESCRIBE 半边（id/label/kind/description/tier）跨 IPC 供 Renderer 渲染；回复时按用户实际选中的 option 解析出它声明的按键，绝不固定发 '1'。只声明位置**稳定**的行——Claude 的三行提示（Yes / Yes 并不再询问该工具 / No）行 2 位置不变，故 Claude 诚实获得 live 的 allow-always；Codex 的中间行按命令/主机/文件动态出现和重排，故其 live 列表只保留 allow-once 与 deny，更激进的 auto/never 姿态由既有 launch option 在启动时提供。只有 codex 与 claude 走到这条 permission 管线（其余 Provider 为 `none` | `observe`）。当前 Question 只展示 Core 已验证的单题单选能力。
- 待处理 interaction 出现时，卡片成为当前 Agent 唯一用户输入面；Composer 保持挂载和草稿但禁用 Prompt，Agent Terminal 的键盘、粘贴和 capability reply 也停用，直到 request 被 Core 结算。卡片提交只有在 Provider delivery 与 Core settlement 完成后才显示成功；失败保留明确错误，不提前消失。`working` 时 Composer 的主动作是一枚 ■ 记号，它**中断当轮**并调用 Core semantic interrupt；Run 与 session 继续存活。**终止整个 Run/session 是另一个动作，位置在 Tabbar**（Run owner 的既有动作）。两者对象不同，不得合并、不得共用措辞：把 ■ 写成 "Stop" 会被读成"我会丢掉整个 session"，从而让用户不敢按一个本该轻量的动作。■ 的可访问名与 tooltip 都必须说的是"当前这一轮"。它的位置与权重不随 steer 改变，避免用户在 Agent 跑动中误按。启动姿态（sandbox/approval/permission-mode）只在 Launcher 一次性设定；Composer 上的 live permission 控制有且仅有两条诚实通路：其一是用更宽的 scope 回答挂在 agent-input-stack 上那张 pending request 卡片；其二是 Provider 声明了**可寻址**的 in-band posture 控件时（见下文 posture control），在 Composer 上直接切到某个具名 mode。两者都经 PTY-input 通道兑现运行中进程的自有 affordance——启动 argv flag 永不作为 live composer 开关出现，因为它对运行中的 PTY 进程静默 no-op。
- Composer 表面不使用描边，靠比所在 Region 高一档的 Surface 填充与顶部高光表达层级，不使用黑色填充或黑色投影；focus 由 `--focus-ring` 加一道 inset `--focus-line` 承担（详见密度合同的控件语言）。Approval/Question 卡片同样不用描边——原先的理由是"描边会与紧邻其下的 Composer 争夺同一条边界"，Composer 去掉描边后这条争夺已不存在，但卡片依旧靠实心 Surface 填充与 elevation 承载重量，并以一枚琥珀 STATUS 图标表达"需要注意"这一状态，也不用常驻的彩色边（accent 表达状态，不作装饰）。卡片内的动作是同一种等高按钮，图标与文字共享中轴；allow-once 是唯一实心品牌绿主操作（最安全的肯定动作才承载最重的分量，绝不让最宽 scope 的按钮成为主操作），scoped 升级为 secondary 并以一枚克制的 tier 圆点表达风险状态；deny/dismiss 分置一侧，Dismiss 是退出而非裁决并降为 ghost 权重。option 数≥2 个 allow 时，allow 采用 CLI 自身的竖排编号节奏，否则保持紧凑动作行。
- Composer 的附件与粘贴图片都产出**路径引用**，由 Agent 自行读取，Composer 不内联文件内容。这是运行时事实决定的：prompt 通道是有字节上限的纯文本，且当前没有 Provider 走 ACP，不存在把二进制送进模型上下文的通路。粘贴的图片由 Desktop main 落盘（渲染进程只提供字节，不指定写入位置与文件名），再以与附件相同的引用形式进入草稿。工作区内的路径写成相对路径，因为那才是 Agent 的工作目录能解析的形式。
- 引用当前打开文件的快捷方式只在确有打开文件时出现。它是快捷方式而非第二条附件通道，没有可引用对象时隐藏，不以禁用态占位。
- Terminal 使用 xterm 的真实字符网格、DPR 和 TUI 输入。没有 pending interaction 时，Agent Terminal 的 xterm TUI 输入与 Agent Composer 是同一 Agent 的两条明确输入路径；Raw Terminal 只保留 TUI 输入。
- **切回一个已经打开过的终端不得重放"Restoring terminal…"**。切 Tab 不是重新连接：一个已经 attach 上、字节已经在屏上的终端，切走再切回应当就在那儿。当前每次切换都闪一次恢复态，是因为非活动 Tab 的终端视图被卸载、xterm 实例被销毁，切回时从零重建并重放。修法在**保住实例**而不在加速重放：不可见的终端**保留其 xterm 实例与 attachment**，切换只改变可见性。据此有三条边界：**不可见的终端不做布局与渲染工作**（否则保实例换来的是持续开销）；**实例的存活边界是 Region 的存活边界**——Region 真的关掉时实例必须销毁，不建第二个绕过 Region 生命周期的缓存池；**恢复态只在真正需要重放时出现**（首次 attach、断连重连、replay gap），它仍是一个诚实信号，不能因为"看着烦"就删掉。
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
- **打不开的文件必须给出一个能落地的出口，而不是只说"打不开"**。Editor 的失败态除文案外提供一个 Reveal 动作，经**既有**的揭示通路落地，不新增第二条 IPC 或第二套路径解析。揭示目标对**已删除的文件回退到最近的存在的祖先目录**——文件已被删除正是"打不开"最常见的成因，揭示父目录仍然回答了用户的问题（它不在那儿了），而报一个二次错误没有回答任何问题；回退的每一步仍做根内约束校验，不得借符号链接逃出 Workspace 根。远端（非 local host）Workspace 下不提供该动作：那条通路对非 local host 必然失败，**以缺席表达而非画一个禁用的假按钮**。揭示失败经既有 reportError 浮现，不静默吞掉，也不把编辑器面板替换成第二个错误态。
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

- Board 是 `行 × Inbox/Working/Needs You/Done` 的二维矩阵。状态变化只在同一行内移动。
- **行的身份取决于 Workspace 是什么，不是另一种 Board**。Git 项目的行是 Branch/Worktree；Scratch 的行是 Topic。两者共用同一套列、同一套状态归类、同一个 Inbox 语义——**一个 Board 组件按行来源参数化，不是两个 Board**。理由与 `Files + Branches` / `Files + Topics` 同源：Topic 与 Branch 都是"一条并行的工作线"，只是承载物一个是 worktree、一个是 topic 目录。为 Topic 复制一份 Board 会让状态归类、列定义、Inbox 入口各出现第二份，日后必然漂移。
- **Topic 与 Branch 一样有 Inbox**。Inbox 是矩阵第一列和带上下文的创建入口，不是 Tools 中的重复页面——Branch Inbox 带 Branch 上下文，Topic Inbox 带 Topic 上下文，走同一个创建路径。
- **Board 工具的次级面板是工作清单，不是说明页**。它列出当前 Board 的行与行内 Agent，可展开、可点击定位——用户来这里是找一条具体的工作线，不是读一段介绍 Board 是什么的文案。图例式的静态说明只在没有任何行时作为空态出现。清单的行与 Agent 状态点复用共享状态语汇，不发明第二套。
- Settings 按可操作资源优先组织为 Workspaces、Hosts、Agents、Appearance、General；默认打开第一个可操作分区。
- Agent Detection 以 Host 为键，由 Core discovery 统一投影到 Settings、Launcher 和状态面。

### 状态栏

- 状态栏是**整窗唯一**的跨 Session 汇总。每一项都必须是别处没有、且用户需要一直看见的事实；Tab 点、Board 列、Agents 工具各自有作用域，状态栏不重复它们。
- **活跃/待机计数按 Provider 分类展示**。「活跃」不是状态栏自己的定义——它就是 Board 的 working 列（`sessionBoardColumn`），其余一律算待机。同一个 `running` 的 Agent 绝不能 Board 判它在跑、状态栏判它待机；照抄一份 switch 正是这种分歧的来源，所以计数调用那一个函数而不是复述它。这与关注度汇总（`summarizeAgentAttention`：谁在等我）是刻意并存的两套口径，回答的是不同问题。零 Agent 的 Provider 不占位；全闲的 Provider 压低但仍在场——消失会让"这个 Provider 总共几个"失去出处。守护：`agent-status-bar.test.tsx`。
- **资源指标只在展开时采样**。折叠态不得触发任何进程扫描——一个常驻的全主机 `ps` 轮询会让空闲窗口持续耗电。展开后按固定周期采样，关闭即停。并发调用共享同一次进行中的采样（in-flight 去重），一次轮询风暴只产生一次子进程。
- **一次全主机扫描，按 pid 子树归并**。为每个 Agent 单独起一个采样进程，开销随 Agent 数线性增长；正确做法是一次扫描后按 run 的 pid 归并出各自子树，共享祖先按注册顺序只归第一个，避免重复计数。
- **只声明证据支持的口径**。输出字节速率就叫字节速率，不除以一个系数冒充 token/s——终端字节含 ANSI 转义与 TUI 重绘，与真实 token 数不成比例，一个无法验证的数字比没有这个数字更糟。真实 tokens/s 需要 Provider 原生 usage 回执，在 catalog 声明该能力并接入之前不展示。

### 显示名与身份

- **显示名与身份严格分离**。名字只用于显示，绝不进入 id、寻址 key 或持久化路径。改名因此永远不会破坏引用——这条不是优化，是前置约束：一旦名字进了 key，后面就只能靠别名表和"已删名不复用"打补丁。
- **Agent 与 Tab 各有自己的名字，因为它们是两级身份**。Tab 比 Agent 所在的 Region 高一级（与上文 Tab/Region 的层级同源）：Agent 名回答"**这个 Agent 在做什么**"，Tab 名回答"**这张工作面是什么**"。把两者合成一个字段，就等于假设一张 View 永远只有一个 Agent——而分屏恰恰是常态。
- **Tab 名的默认策略随 Region 数量变化，这正是分开存的价值**：
  - **一个 Agent 时，Tab 名默认对齐该 Agent 的名字**——此时两级身份指向同一件事，让用户填一次名字就够。
  - **再开 Region 之后，Tab 名要体现这是一个 Agent 家族**，而不是继续显示其中某一个 Agent 的名字（那会让另外几个 Agent 在这张 View 上失去表示，也会让 Tab 名随"哪个 Region 是 title region"而跳变）。家族名从成员派生，不要求用户手填。
  - 用户显式改过 Tab 名之后，上面两条自动策略对这个 Tab 永久停手——它变成一个手改名，不再随成员增减而变。
- **名字有一条统一的优先级链**，只有一处定义：`用户手改 > 启动时指定 > 从成员/首条 prompt 派生 > Provider·Workspace 派生`。任何展示名字的地方都经这条链求值，不各自拼一份。
- **自动命名绝不覆盖用户意图**。派生名只在当前名仍是系统生成时才更新；用户手改过一次之后，自动机制对这个名字永久停手。


### 扇出比稿

- 一个 prompt 扇出 N 路：从当前 HEAD 起 N 个新分支、各自一个 worktree、各跑一个 Agent，比较哪一路更好后留一路、拆其余。整套编排归 **Desktop Main**：它只按顺序调用已有的公共命令（worktree 创建、单条 Agent 启动、worktree 拆除），不引入新的运行时事实。**发起与收尾复用既有的单一 IPC 与导航路径，不新增第二条**：发起一次扇出＝依次调用既有的 worktree 创建与单条 Agent 启动；「留一路、拆其余」＝保留所选那一路、其余经既有拆除原语移除；跳转任一路仍走既有 `selectSession`——没有专属于扇出的第二套 IPC、导航或错误状态机。这条竖切的完成标准是**端到端可达**：用户能发起、也能收敛。只做出编排原语与比稿展示面却没有发起入口，是一段测得很好却用不到的代码，不计为已交付。
- **Core 不拥有 coordinator loop**。`packages/core` 只认识单条 Agent Session；"同时跑 N 条并收敛"不是 Core 的概念。把这个循环放进 Core 会让它凭空多出一个它并不持有的生命周期对象——批处理编排是 Desktop Main 顺序调度公共调用的结果，不是 Core 的第二种 Session 语义。lane 顺序创建（并发 `git worktree add` 会争抢同一 index 与 metadata，config 也逐路串行穿过每次注册），Agent 一旦启动即并发运行——用户要的并行发生在这里。
- **默认 worktree 落在项目内，且只有一处出处**。为某个分支新建 worktree 时，默认位置是项目自身的隐藏子目录 `<项目>/.worktrees/<清洗后的分支名>`，而不是与项目同级的兄弟目录——它因此受项目 `.gitignore` 覆盖、随项目目录一起被移动或删除、并出现在项目自身的文件树里，因为它本就属于这个项目。这条默认路径只由**一处**推导：Branches 面板取默认值、扇出取各 lane 的 worktree 根，都经同一个出处得出，任何调用点都不得再自行拼第二份默认位置。扇出把各 lane 建在其 worktree 根下，该根必须解析到同一个项目内 `.worktrees` 目录，不另立第二处真相。分支名先收敛为路径安全字符、空名回落为固定占位，使目录名不泄露分支里的路径分隔符。
- 一路失败绝不掀翻其余：扇出返回逐路结果而从不为某一路抛出。区分三态——已启动、worktree 建成但 Agent 未起（明说 worktree 是否留在磁盘上，否则成为无主目录）、worktree 都没建成（无可清理）。逐路的部分失败经**既有** `reportError` 面浮现，不另建扇出专属的错误状态机。
- **分组是派生的，复用共享状态语汇**，不新建第二套。扇出计划把 lane 命名为 `<stem>-1`、`<stem>-2`……，stem 已经标识了这一组，因此比稿面从分支名推导分组，而不持久化 group id（持久化等于给分支名已经说清的事再开一份会漂移的注册表）。每条 lane 的状态点用与 StatusDot、关注栏同一套 class；点一条 lane 走与全局同一个 selectSession；"跳到等待最久的一路"与关注栏"跳到最早的"同序。没有比较时整条 strip 不占空间。
- **留一路、拆其余**：用户指定保留的那一路，worktree 与 Session 原样留下；其余各路经既有拆除原语移除，不写第二套拆除逻辑。**脏树保护仍然生效**——有未提交改动（含未 `git add` 的产物）的那一路被拒绝、留在磁盘、留在记录集、并如实报告为 retained，绝不因为它没被选中就静默丢弃。要丢弃是逐路、显式的选择（`discardChanges`），批量收尾没有"一键丢弃所有脏 loser"的开关，因为那正是保护要消除的数据丢失杠杆。一路拒绝清理不阻断能清理的其余路。
- **v1 明确不含 diff 逐行比较与自动合并胜者**。比较就是读 N 条 lane 的状态与各自终端；留胜者就是在该 worktree 继续、拆掉其余。不做站内 diff/合并有据可循：diff owner 会引入一个全新的 git-diff 事实源（当前整个 git 面只有 for-each-ref / worktree list / add / remove 这几样本地 plumbing）、一套新 IPC、一种新 surface kind、以及与浏览器批注并行的第二套行锚批注模型；review 已被用户自己的 editor / git / 平台 PR 覆盖。要等扇出真正落地、证明确实需要"站内比较"，再考虑先做 branch-vs-branch 而非通用行批注——为一个尚未证明的需求预建第二个 owner 是我们否决的熵。

### Git 源码控制与 PR

- **本地**：看到当前分支的改动（`status --porcelain=v1 -z`——`-z` 使 NUL 分隔、关掉 git 的 C-quoting，因此带空格、引号、换行或 CJK 字节的路径逐字到达，解析器永远不必解码），stage 单个文件、commit、结构化 diff、unstage、discard。**diff 读 blob 而非解析 unified-diff 文本**：旧侧取 `HEAD:<path>`、新侧读工作区文件，二进制由 NUL 扫描判定而非塞进文本字段；**读不到就是失败，不回落到 HEAD**——"读不到"正是渲染新增/删除文件的依据，被静默吞成空 diff 就再也分不清。
- **远程**：push（默认 `origin HEAD` 并 `--set-upstream`，`--force-with-lease` 永不裸 `--force`）、pull（可 pin ff-only/merge/rebase；未 pin 时对分叉自动回退为显式 merge，因为主机可能没有 reconcile 策略）、fetch `--prune`。**ahead/behind 对有效上游计算**：先解析 `@{push}` 再 `@{upstream}`，因此覆盖"分支 track `origin/main` 却 push 到 `origin/<branch>`"与"上游是本地分支"两种情形，不是只看配置上游。
- **PR**：`gh pr create`，正文写临时文件经 `--body-file` 传。**认证完全委托 `gh auth`**——只探测 `gh auth status`，AgentMux 不读取、不持久化任何 token（`gh` 自己继承 `GH_TOKEN`/`GITHUB_TOKEN`），与"什么都不出机器"的隐私线一致，零新增鉴权存储面。`gh` 缺失与未认证是两种可区分的结果，各自给出可操作文案，不混成一个泛化错误。
- 四条**不可退让**的约束，任何后续改动都不得削弱：
  1. **argv 不拼 shell**。一律数组传参；路径用 `--` 终结符与 `:(literal)` pathspec；任何以 `-` 开头的用户可控输入（路径、分支名、remote、refspec）被拒。`clean` 是唯一会从磁盘删文件的动词，调用前额外做 worktree 内约束校验，绝不 clean 到 worktree 之外。
  2. **远程错误擦凭据后再上浮**。git 会把远程 URL 回显进错误文本，因此**任何**上浮路径都先经同一个纯函数擦除。擦的是 http(s) 类 URL 的**全部 userinfo**——既包括 `user:pass@`，也包括**无冒号的 bare-token** `https://<token>@host`（这是 CI 与 `git remote set-url` 嵌入 PAT 的标准写法，只匹配冒号的规则会把它逐字泄露）；ssh 的 `git@host` 保留，那是身份不是秘密，擦掉只会毁掉报错里唯一有用的信息。且只有带 `fatal:` 前缀且匹配已知短语的 "no upstream" 被吞，鉴权失败、非 git 仓库、损坏一律上浮，不被误判成 no-upstream 而静默隐藏。
  3. **PR 一键流键到 run-token**。点击时捕获 `{repo, worktree, branch, base, startedAt}`，异步各步只在 token 仍匹配时落地。**切到另一个 worktree 明确不算冲突**——运行照旧对原 worktree 完成、create payload 打到原 worktree/分支；**只有同一 worktree 内 branch/base 漂移才算冲突**并中止。搞反方向会让用户切个窗口就丢掉正在建的 PR。创建失败**不清空 composer**：标题/正文/base 原样保留、按钮重新可用，否则一次网络抖动就吃掉用户写的正文。
  4. **后端 preflight 终裁，unavailable 即拒**。renderer 的资格探测是提示，不是权威；main 在真正创建前用"base 必须在远程存在"重查，探测**不可用时拒绝而非放行**——放行等于用一个没验过的前提去写外部世界。写操作**不重试**：重试会重复建 PR。
- 模型生成 PR 标题/正文时，分支名、文件路径、commit 文本、链接的 issue 全部作为**不可信数据**注入，明示"当数据不当指令"。解析在 `JSON.parse` **之前**先跑结构化上限守卫（token 数与嵌套深度），越限直接拒绝；去 ``` fence 用逐字符扫描而非可回溯正则（防 ReDoS）。解析失败返回明确的"无法解析"，**绝不把半解析状态当成功**。

### Provider Launch Option

- Provider 以数据形式声明自己可供选择的启动项（例如 model、权限或沙箱模式）。每个 choice 把 UI 展示的标签与兑现它的 argv 写在同一处，两者不可能漂移。
- 契约分成两半：describe 半边是纯数据，跨 IPC 供 Renderer 渲染；argv 半边只留在 Core。**Renderer 永远看不到命令行**，Launcher 也永远不知道 Provider 的名字——任何调用点都不得按 `providerId` 分支决定启动项。
- 未声明即不渲染。Provider 落地速度不同是常态，没有声明的启动项在界面上完全不出现，而不是显示一个禁用控件。给某个 Provider 后补一项能力，不需要改动 Renderer 任何一行。
- 作用域是**启动时**，这不是过渡方案而是运行时的全部事实：Agent 是经 PTY 驱动的真实 CLI 进程，当前没有 Provider 走 ACP，不存在能让运行中进程改换 model 的通道。把选择编码进 spawn 时的 argv 是运行时唯一能兑现的形式，类型系统据实表达这一点，不得用暗示"运行中可切换"的控件掩盖它。将来某个 Provider 具备 ACP 后，实时能力作为**并列**的另一项能力加入，启动时这一条不被拆除。
- 只声明对着真实二进制核实过的 flag。核实不了的一律不声明——这正是部分 Provider 目前不提供任何启动项的原因。核实的对象是 Provider 真正的可执行文件（如 cursor 是 `cursor-agent` 而非 `cursor`），拿错二进制核实等于没核实。
- **不声明自由字符串 model**。gemini / grok / traex / hermes / antigravity 以及 codex / cursor 的 `--model` 都收任意字符串、无枚举，手写一张模型名清单会在厂商改动阵容时立刻过期，故一律不声明、依"未声明即不渲染"保持无按钮，绝不为对称而编造一张会过期的清单；只有当 CLI 自身 `--help` 给出可声明的取值才声明，且据实区分它给取值的两种方式——claude 的 `--model` 是**例举式**（`--help` 以 e.g. 举出 fable / opus / sonnet，并非严格 possible-values），我们只把这组指向"最新模型"的**稳定别名**据实声明（它同时也接受模型全名，但**全名不声明**，出自同一条会过期的理由），措辞按"稳定别名"表述、绝不写成一份穷举清单；claude 的 `--effort` 则是**严格 possible-values 枚举** low / medium / high / xhigh / max。核实到的是**枚举**才落一个选项：gemini `--approval-mode`、grok/claude/traex `--permission-mode`、codex/traex `--sandbox` 都是显式 possible-values；hermes `--yolo`、antigravity `--sandbox` 是布尔开关，落成两档 choice（保守档贡献空 argv，激进档贡献 flag）。每档 tier 据实标注：绕过审批或沙箱为 `danger`，收窄一类为 `caution`，保守默认为 `safe`（agy 的 `--sandbox` 是**加**限制，故开启档才是 `safe`，无沙箱的默认档为 `caution`）。
- **model 与 effort 不带 tier**。claude 的 model 与 effort 是仅有的两处按**能力**（而非权限）据实声明的启动项。RiskTier 分级的是审批/沙箱姿态的危险程度，而选模型或选推理深度既不放宽也不收紧任何权限——给它标一档 tier，会在名册行上打出一个无人记录过的假风险标记。claude 的启动项里只有 permission-mode 真正移动权限姿态，故只有它带 tier。
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
