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

### Tab 与 Pane

- Agent/Terminal 内容上方只保留一行 Tabbar，不再显示第二条 Session Info Bar。
- Agent Tab 使用 Provider 图标并叠加语义状态点；Terminal Tab 使用 Terminal 图标，不能用同形状态点同时表达内容身份。
- Tab 保持稳定可读宽度和单行名称；窄 Pane 使用自身横向 overflow、左右导航和自动滚入可见区。
- Active Run 的 Stop 是 Tabbar 内的图标动作，继续使用统一确认和 Core stop owner。
- `Split` 表示拆分当前 View 内容；移动整张 Tab 使用独立命令和拖拽落点，两种预览和结果不能混用。

### Agent Composer 与 Terminal

- Composer 属于 Agent Session Region，不属于 Activity。Agent 的 Terminal 与 Activity 只是同一 Session 的两种投影；切换投影时 Composer 必须保持挂载，不能清空未发送草稿。
- 每个 Agent Region 都显示同一个 Composer。Agent 尚在启动、已经断连、退出或中断时仍显示，但在 Agent Run 不可交互时禁用；Raw Terminal 永远不显示 Agent Composer。
- Composer 使用独立、受控、无 Store 依赖的可复用输入组件；Session adapter 负责草稿、当前文件、Submit 与 Interrupt 绑定，为附件和其他富输入能力保留唯一扩展面。
- Renderer 不根据 `working`、`waiting`、`blocked` 或 `done` 猜测 Prompt readiness。Core 拒绝提交时保留草稿供重试；semantic resume 和恢复动作继续由现有 Owner 负责。
- Composer 表面透明，只用边界、工具动作和 focus ring 表达层级，不使用黑色填充或黑色投影。
- Terminal 使用 xterm 的真实字符网格、DPR 和 TUI 输入。Agent Terminal 的 xterm TUI 输入与 Agent Composer 是同一 Agent 的两条明确输入路径；Raw Terminal 只保留 TUI 输入。
- Terminal 主题只属于 Desktop Renderer。ctxmux、RunSpec 和 Core 公共合同不出现主题字段。
- Renderer 负责把最新 `cols × rows` 通过 Core 公共 Resize 提交给 ctxmux；resize 热路径只保留一个在途请求和一个最新 pending size。
- Replay、Live、Gap、ACK 与 Attachment lease 均服从 ctxmux/Core 的 ordered-byte 合同，View 不建立补偿状态机。

### Explorer 与 Editor

- Explorer 以 Selected Worktree 为根，使用层级目录、文件夹优先排序、多选、键盘导航、Reveal、刷新和受 Workspace Root 约束的文件操作。
- Stale response 不能覆盖新 Workspace 或新目录 revision；刷新期间保留现有内容，直到新结果原子替换。
- Desktop Main 是 Workspace 文件与磁盘版本的唯一事实 Owner；`packages/core` 不承载文件服务，
  Renderer 不直接读写磁盘，也不维护第二份文件 revision 或 watcher truth。
- 打开文件时由 Main 返回内容与不透明 revision；保存必须携带读取时的 revision，并由 Main 在
  Workspace Root 约束内原子替换。磁盘内容已经变化时保存必须明确冲突并保留编辑草稿，不能静默覆盖。
- 外部工具或 Agent 修改已打开文件时，由 Main 发布权威变更。无本地草稿的 Document 自动读取新
  revision；有本地草稿的 Document 保留草稿并进入明确冲突状态，不能假装保存成功或悄悄回退内容。
- 文件 Rename 和删除先由 Desktop Main 完成磁盘操作；成功后，Renderer 用一次纯 reducer 原子更新 Document、Selection、Dirty、Last Active、Tab Group 和 View/Region 路径投影。路径映射若会占用已有 Tab、Document 或 Region owner，Renderer 会在请求磁盘操作前拒绝。
- 路径映射使用 segment-aware 子树判断。受影响保存先被 mutation admission 阻止并等待静止；磁盘失败或最终位置未知时不提交 Renderer 映射。
- Darwin Local move 使用同一 Desktop owner 构建和分发的原子 no-replace helper，同时执行 Workspace Root-relative、no-follow 和 no-clobber 约束。当前 Renderer 的文件树 Rename 入口使用该能力；helper 缺失或平台无法满足合同会明确返回 typed unsupported，不回退到普通 `rename`、`mv`、重试或事后回滚。
- 内置 Editor 保存 Topic 的 `topic.md` 后使 Topics 文件系统快照失效并重读，不建立 watcher 或 Renderer Topic Registry。
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
- 文件移动覆盖目标碰撞、外部竞争、父目录换根、helper 缺失和 syscall 后回执失败；磁盘未确认成功时 Renderer 状态保持不变。
- 资源收益只用同一场景的 before/after 数据声明，不强制 GC，不卸载仍使用的 Surface，不增加全局 Cache 框架。
- Unsupported 能力明确失败关闭；不加兼容层、migration、fallback、第二 Runtime Owner 或隐藏 Registry。

## 非目标

- 不把 AgentMux 做成另一个 Run Runtime。
- 不把 Desktop 布局、Topic、Provider 或 Agent 语义下沉到 ctxmux。
- 不为命令对称、未来平台或未出现的规模证据预建功能。
