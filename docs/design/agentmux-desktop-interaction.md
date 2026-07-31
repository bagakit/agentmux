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

### 打包、安装与启动事实

- **用户启动的必须是同一份已验证候选**。`package:mac` 只产生
  `apps/desktop/release/mac/AgentMux.app` 与同批 DMG；`package:mac:install`
  只把这份候选原子替换到约定的 `~/Applications/AgentMux.app`。`apps/desktop/out`
  是构建中间产物，不能被当作可安装版本；其他路径下的同名 App 不属于当前
  安装事实。
- **候选必须携带可核对的来源身份**：至少包含源码 commit、tree、应用版本、平台与
  架构。安装前后都核对同一身份；版本号相同不等于产物相同，启动排障不能只看
  `CFBundleVersion`。
- **安装面只保留一个活动副本**。安装动作完成后，旧的 AgentMux App 不得继续被
  LaunchServices 选中；清理旧副本时保留到系统 Trash 以便恢复，不删除用户的
  Application Support、Session、Run 或其他运行数据。
- **打包失败不能阻断已安装的健康版本**。构建、签名或验证失败时，保留现有安装，
  明确报告失败阶段与候选来源；只有验证通过的候选才允许替换活动副本。
- **这是一条发布边界，不新增运行时事实**。安装路径、候选身份和报告属于打包工具的
  事实；Desktop Runtime 仍只有 Core/ctxmux 的既有 Owner，不在应用内复制一份
  Session、Run 或布局状态。

## 产品对象

### Project 与 Workspace

- Project Rail 只负责选择 Project/Scratch、显示紧凑状态和进入 Settings/Hosts。
- Project Rail 的 `Projects` 只是分组标签，不是页面标题：它必须使用低于项目行标题的元信息层级，弱化字重与字距，不抢项目名称的注意力。
- **选中和运行是两件独立的事实**。选中项目只用中性的整行 Surface 与 `aria-current` 表达；项目下存在处于 Board `working` 列（`starting`/`running`/`working`）的 Agent 时，在该行的独立尾部状态槽显示运行标记。这个标记对所有有运行中 Agent 的项目都显示，不能因为项目未选中而隐藏，也不能因为项目选中而变亮。运行标记必须复用 `sessionBoardColumn` 的判定，不维护第二份 Session 状态。
- 普通 Project 行不显示每行都相同的文件夹图标；行首留白，把宽度留给项目名。只有承担明确身份语义的特殊工作区（例如 Scratch）才可以保留独特图标，不能用装饰图标模拟运行状态。
- **多个 Project 之间的位置关系要看得见，用一种优雅的 UI 交互形式来展示**。用户原话：「假设两个 projects 在同一个目录下，就在界面中显示它们的分组」「如果某个 project 是在另一个 project 目录结构的子结构里面，就自然地把这两个排列到一起，并且把处于子目录的 project 向前缩进，形成一个树结构」。判据如下：
  - **分组的键是「同 host + 共同父目录」**，不是路径字面相同。`~/proj/agentmux` 与 `~/proj/bagakit` 归到 `~/proj` 一组；远程 host 上的 `~/proj` 与本机 `~/proj` **不同组**——路径字符串一样不代表是同一个地方，跨 host 混排会让用户点错机器。
  - **真嵌套才缩进**：一个 Project 位于另一个 Project 的目录内时，两者相邻排列、子项向前缩进成树。
  - **判断"在里面"必须按路径段边界，不能用裸字符串前缀**。`…/bagakit/agentmux-preview` 以 `…/bagakit/agentmux` 开头，但它不在 `agentmux` 里面，是它的兄弟。比较前给祖先补上分隔符（`ancestor + '/'`）才是"位于其目录内"。同理，一个 Project 嵌在多个 Project 里时**认最深的那个祖先**做父节点——挂到更浅的祖先上会让中间那层凭空消失。
  - **单例不成组**。一个分组里只有一个顶层 Project 时不显示分组头，它直接平铺。分组头的价值在于表达"这几个是一伙的"，只领一个成员时它不携带信息，只是又一行占位——与《控件语言》「一列全同的图标不是信息」同一条理由。实测用户真实的 10 个 Project 会派生出 6 个共同父目录，其中 4 个是单例：不设这条，一半的项目会各自顶着一个只领一人的标题。**数的是顶层成员，不是节点总数**：一个独苗项目底下挂着一串嵌套子项目时，那些子孙并不在这个父目录里（它们的归属由缩进表达），分组头同样只领一个成员。
  - **分组头不是可选中的行**。它是分组标签（`Projects` 那一档的元信息层级），不承担选中、不显示计数、不接收点击——它不是一个 Project，点它没有任何东西可以被激活。
  - **worktree 不进这棵树**。`defaultWorktreePath` 把 worktree 放在 `<repo>/.worktrees/<branch>`，它天然是子目录，但它已经是所属 Project 的一个 Workspace（在 Project 内部展开）。按路径包含关系再把它变成一个子节点，同一个东西就有了两套嵌套，用户无从判断该点哪个。**归属只有一种表达**：worktree 归它的 repo，树只表达 Project 之间的真实嵌套。
  - 这里只是**呈现**变了。分组与缩进都从既有的 `WorkspaceRecord.path`/`hostId` 派生，不新增第二份 Project 注册表，也不把层级写进配置——路径是唯一真相，用户在磁盘上移动了目录，这棵树就该跟着变。
- Workspace Tools 位于主工作区左侧，负责 Files + Branches、Agents 和 Browser Favorites。
- Scratch 使用同一工具槽，但内容是 Files + Topics。Topic 来自文件系统，不从打开的 View 反推。
- **一个 Topic 容纳多个 Agent，不是一 Agent 一 Topic**。同一 Topic 里的参与者关系在磁盘侧以 collaborators 表达（Scratch 文件系统是唯一真相），不另建 UI 侧的 Topic Registry；Topic 之间的切换归 Topic 面板，不靠 View 或 Tab 的开合暗中改绑。因此 `topicId` **绝不由 `tabId` 派生**——把当前 Tab 的 id 当作 topicId 会让每开一个 Tab 就凭空多出一个 Topic，与"一 Topic 多 Agent"直接矛盾；目标 Topic 由启动意图显式携带，缺失时不绑定任何 Topic 而非发明一个。
- Topic 条目的目录动作只在内置 Explorer 中展开、选中并滚动到对应目录，不调用 Finder 或其他系统文件管理器。
- Topic 条目的改名是对 `topic.md` 一级标题的语义编辑；`topic--*` 目录、`topicId`、Agent cwd 和 View 绑定保持稳定，Explorer 不向这些顶层目录暴露通用 Rename。
- **切 Topic 就换那一组 Tab，和项目里选 Branch 是同一种体验**。Branch 之所以天然换掉整条 Tab 条，是因为布局按 Workspace 键控、每个 worktree 就是一个 Workspace；而 Scratch 的所有 Topic 共用一个 Workspace，若不做处理，切过去会看到别的 Topic 遗留的 Tab。因此当前 Topic 是一个显式状态，Tab 条按它投影：**布局仍只有一份，过滤发生在渲染时，不建第二份 Tab 状态**（Topic 的真相仍在文件系统）。两条边界：**未绑定任何 Topic 的 Tab 始终可见**——它不属于任何 Topic，藏起来就再也找不回了；**活动 Tab 要跟着 Topic 走**，判据是"它属于这个 Topic"而不是"它还看得见"——让一个未绑定的 Tab 在切换后继续当活动项，等于切过去却什么也没发生。
- **选中一个 Topic 之后必须真的只看到它自己的 Tab**。上一条描述的投影只有在"当前 Topic"这个状态确实被设过时才生效——如果用户是通过点 Tab、恢复会话或任何 Topic 面板以外的路径进入某个 Topic 的，当前 Topic 仍是空，于是所有 Topic 的 Tab 一起摊在条上，这正是用户看到的混乱。**当前 Topic 必须从当前活动 Tab 的绑定派生，而不是只由 Topic 面板的点击设置**：活动 Tab 绑了哪个 Topic，当前就是哪个 Topic；活动 Tab 未绑定则不过滤。这样"选中 Topic"这件事无论从哪条路发生都成立，也不需要第二份状态去和它同步。
- **从当前工作线新建的 Tab 必须继承当前选中的 Topic 绑定**。点击 Tabbar 的 `+`、从当前 View 打开 Browser/Terminal/Agent，或由 Control/链接创建一个新 Tab 时，目标是当前活动 View 所属的 Topic；不能因为新建了一个 `WorkbenchTab` 就退回成未绑定 Tab。未选中 Topic 时仍保持未绑定，显式指定另一个 Topic 或已有 Agent Session 时以显式目标为准。这个继承发生在创建边界，不新增每 Topic 一份 layout、全局 Topic 注册表或第二份当前状态。
- Topic 面板与文件树共用内容槽时，**默认高度偏向 Topic 面板**：Topic 是 Scratch 的一等对象，文件树是它的底料。文件树默认占更小的一份。
- Topic 行的动作按频次分层：**定位到该 Topic 的目录**是高频、留在行上（图标要表达"聚焦定位"而不是"打开文件夹"，因为它不离开 AgentMux）；**改名**是低频，收进行的右键菜单，不在行上常驻一个图标——每多一个常驻图标，行的可读宽度就少一分。
- Topic 行**不用左侧竖条表达选中**。选中态是单一几何信号（干净的 Surface 填充），与全局控件语言一致；行首也不放没有区分意义的装饰图标——一列全同的图标不携带任何信息，只在消耗宽度。
- **Topic 行的 Agent 呈现为一组头像**，不是一排抽象的点。每个 Agent 用缩小的 Provider 图标（用户据此一眼看出这一行里跑着谁）；头像**默认不画常驻边框**，只有确实处于 `working`/`running` 的 Agent 才显示外描边/发光，其他状态用灰度处理，避免把静态身份误读成正在运行。悬停有轻量抬升与 tooltip 给出名字与状态，点击直接定位到该 Agent。这三件事——身份、状态、导航——过去要用户读完整行文字才知道，头像列把它们压进一个可点的小方块里。
- Project Rail 与 Workspace Tools 分别开关，不能共享状态或互相改变布局身份。

### Tab、Tab Group 与 Region

- `View` 是用户认知里的一张完整工作视图，在 Desktop 中表现为一个 Tab。
- `Tab Group` 用来整理整张 View；移动 Tab 不改变 View 内部内容布局。
- `Region` 是 View 内的内容 leaf，可展示 Agent、Terminal、File、Browser 或 Launcher。
- `split-left|right|up|down` 只修改当前 View 的 Region 树；`placement=tab` 只在用户明确要求时创建新 View。
- Workspace 保存 Tab Group 树，每个 View 保存自己的 Region 树。两个树使用不同 ID、焦点、resize 状态和操作入口。
- **关闭当前格、按序号切 Tab、分屏、切换焦点格都必须能纯键盘完成**，不该只有鼠标一条路。窗口级只补这四个高价值动作，**不建 action catalog、不做用户改键**——那是预防性抽象，与"最简实现"相悖。键位跟随成熟终端/编辑器的既有惯例而非自创：关闭当前 Region 用平台的关闭键（mac `Cmd+W`／其他平台 `Ctrl+Shift+W`），按序号切 Tab 用 `Cmd/Ctrl+1..9`（第 9 键恒指最后一张），分屏用 mac `Cmd+D`（右）/`Cmd+Shift+D`（下）、其他平台 `Ctrl+Shift+E`（右）/`Ctrl+Shift+O`（下），切换焦点格用 `Cmd/Ctrl+Alt+方向键`。**平台底线：非 macOS 绝不接管裸 `Ctrl+字母`**——那些是 shell/readline 的地盘（`Ctrl+W` 删词、`Ctrl+D` 是 EOF），接管会让用户在终端里丢掉肌肉记忆；数字与 `Ctrl+Alt+方向` 不落在 readline 键上，可安全使用。新键位不得与终端作用域键（`Cmd+F/C/K`、`Shift+Enter`）冲突，冲突判断按键位比对、不靠猜。判定与落点解析写成纯函数、组件只做注册与 `preventDefault`（本仓库 `renderToStaticMarkup` 不跑 effect，写进组件的分支断言够不着）；只测判定不够，**必须有接线测试**——删掉注册调用要让断言变红。焦点格的"相邻"按屏幕几何（Region 归一化 bounds）判定，不按分屏树的父子深度，与上文「哪个算右边」同一处轴向定义。

### Session、Run 与 View

- Agent Session 是 Provider 语义身份；Run 是 ctxmux 进程身份；View/Region 是 Desktop 展示身份。
- 一个 Session 可以没有 View，也可以投影到多个 View。关闭 Tab 内的 Region 只改变该 View 的内容布局；关闭承载某个 Session 最后一个 Region 的完整 View 时，Terminal 直接停止 Run，Agent 默认停止并二次确认，同时明确提供保留 Session 的选项。
- **投影可以被显式移动到另一个 Workspace 的 View**，这只搬动展示身份、不动 Agent 事实。cwd 归 Core（`session.workspacePath`，一个已在运行的进程的工作目录），移动**绝不改变** `session.workspacePath`——没有任何通道能让运行中的进程改换工作目录，所以移动后这条 Session 的 Tab **仍**如实显示它自己的工作目录（cwd），不冒用目标 Workspace 的磁盘路径或名字。移动是用户按 Region 显式发起的（Tab 菜单选目标 Workspace），落点复用既有的 selectSession 导航；新建 worktree **绝不**把任何 Session 的投影**自动移动**过去，创建 worktree 与移动投影是两个独立动作。
- Desktop 持久化的是**展示身份**，不复制 PTY、Replay、Agent 状态或进程生命周期。**布局恢复与 Session 恢复必须分开看待**：布局是 Renderer 的展示事实，Session 身份与 Provider-native resume token 是 Core 的语义事实；任何一侧失败都不能把另一侧静默删掉。
  - **判据是「这一面有没有可在冷启动复活的身份」，不是「它属于哪一类面」**。Agent/Terminal 面持久化 Session/Run 落在哪张 View 的哪个 Region；**文件面同样持久化，含它的路径原样**——一个文件面只有 `{regionId, kind, workspaceId, path}`，没有运行时内容可剥，而它的 Tab id 本就是 `file:<workspaceId>:<path>`，所以「存这一面」与「存这个路径」是同一件事，分不开。把文件面剥掉曾经让一个纯文件 Tab 整个消失、让 agent+文件的分屏塌成单面，这正是用户报的「重启后 tab 和分屏没了」。
  - **Browser 面反过来整面不持久化**。它内嵌活体页面快照（url/title/navigationId 全是必填的运行时事实），浏览历史与文件路径是两类不同的敏感度；更关键的是冷启动**没有**一条能把持久化的 browser 结构复活成可用空白页的生命周期，硬存一个结构标识只会 ship 一个死面板。**以缺席表达，而不是画一个打不开的面**。
  - **持久化了一个面，就必须有人在冷启动把它的内容装上**。文件面能存下来只是一半：若启动恢复不去加载那份文档，Tab 在、编辑器却报「不可用」——这比整个 Tab 消失更难诊断，因为看起来像文件坏了。**凡是新增一类可持久化的面，都要同时指明它冷启动时的加载入口**；没有加载入口的持久化是半成品，不许上线。
- **重新打开项目要无缝接回原来的工作面**。切换 Workspace/Project 只是改变可见投影，不能销毁仍在使用中的 Workbench、xterm 实例或 ctxmux attachment；回到项目时应直接看到离开前的终端画面，不再闪 `Restoring terminal…`，也不因为 replay 起点变化把用户误导成“历史丢了”。真正发生 replay gap 时仍需显示 gap 的诚实提示，但项目切换本身不得制造 gap。
- **应用重启与机器重启都先恢复布局，再恢复语义 Session**。启动时以持久化布局为索引，自动尝试对每个仍有有效 Provider-native handle 的 Agent Session 建立新 Run/attachment；用户不需要先点 `Resume` 才能看到可恢复的 Agent。恢复成功沿用原 View/Region，Run id 可以变化但 Session id 不变。
- **重启恢复必须使用同一个持久化根目录**。Renderer 的 Workbench 布局与 Core 的 Agent Session store 都绑定 Electron `app.getPath('userData')`；开发启动、打包 App、DMG 安装副本不得各自生成一份 store。启动恢复前若发现路径身份不一致，必须保留原布局并在服务窗说明实际路径，不能把空 store 当成“没有 Session”。
- **Session store 的陈旧锁不能把新 Agent 永久挡在门外**。写入锁带有可验证的 owner；owner 已退出时锁可回收。若锁文件为空、截断或 owner 身份无法验证，也不得把它当成永远存活的 owner：在确认没有对应活进程后应回收并继续写入；仍能确认 owner 存活时必须保留锁。一次锁清理失败只在服务窗/诊断面说明，不能删除 Session、布局或 ctxmux 的私有状态。
- **Session store 的高频读取不能反过来饿死生命周期写入**。列举/恢复等只读加载不得为了孤立 Timeline 清理而长期占用写锁；清理是可抢救的旁路，遇到短暂争用应让出。新建、恢复和停止等生命周期写入必须在同一份 store 上排队并保留可观测的有限重试；只有重试预算耗尽后才报告 `AGENT_SESSION_STORE_BUSY`，不能把正常的多 Agent 活跃状态误报成永久失败。
- **启动探测失败不能遮住已保存的工作面**。配置、Session snapshot 或 Provider capability 的单项 Host/runtime 失败时，Renderer 仍必须先提交已恢复的布局与可见 Region，再把失败作为作用域明确的服务窗/状态行呈现；只有布局本身无法读取时才进入无布局错误态。一次暂时不可达的 Host 不得让整个窗口回到空白 loading，也不得覆盖最后一份可恢复布局。若 snapshot 未能确认 Session 身份，原 Region 先保留为“待 Runtime 校验”的投影；下一次权威 snapshot 到达后再按已知缺失或匹配结果收敛，不能用空 snapshot 静默裁剪它。
- **Host 探测必须对 GUI 启动可靠**。登录 shell 探测失败时不得把所有 Provider 静默判为 missing；应合并已有环境并使用非交互登录 shell等可靠路径重试，同时在状态面明确“探测未完成/当前按已有 PATH 运行”。只要 CLI 仍可执行，Host 探测流程不得阻断布局、Session 或用户操作。
- **Managed Hook 不得绑死已卸载的 App 路径**。Hook 配置里的 AgentMux 命令由当前运行的 App 在启动和恢复已有 Session 时校正；旧安装留下的绝对路径失效时，Hook 只返回 Provider 所需的中性响应并把诊断作为非阻断提醒，不能因为宿主探测/回调失败而阻断 Agent 的正常 Prompt。Hook 配置仍保留用户自己的条目，AgentMux 只更新带自身 marker 的条目；这条修复不通过给 `/Applications` 重新造一个影子 App 来兜底。
- **恢复候选不能静默消失**。Provider 不支持 native resume、Session 从未记录过 verified handle、handle 已失效或 Core 返回冲突时，原布局位置仍保留一个可理解的失败/待处理投影，明确说明原因与下一步；不能开一个全新的 Run 冒充旧上下文，也不能因为恢复失败而把整张布局裁掉。
- **Session 恢复是独立的一等功能**。应用启动、切换回项目和机器重启后的首次打开，都必须自动尝试恢复；用户不需要先进入 Topic 再显式点击 `Resume`。恢复失败只能在 Core 已给出明确结果时出现，并且必须伴随保留原投影的服务窗说明；不能把“没有 verified Provider handle”当成唯一的无上下文黑箱错误。
- **「恢复不了」不是一句话，是四类结果加一个冲突，界面必须把它们分开说**。Core 的 unavailable 有四个原因（`provider-resume-unsupported` / `native-handle-unavailable` / `provider-unavailable` / `unknown-session`），另有 conflict 自成一类。合成一句「Agent resume unavailable」等于没说：**Provider 根本不支持 resume 是永久的**（这个 Agent 换个时间点也回不来，该新开一个），**handle 缺失只关乎这一条 Session**（别的 Agent 不受影响），**Provider 在这台 Host 上缺席则是可恢复的**（装回来/Host 回来就能续，此时叫用户新开 Agent 等于让他丢掉一个还活着的 Session），**conflict 说明东西还在、只是被占着**。用户此刻唯一要做的决定就是在「重试」「新开」「等一下」之间选，而这个决定完全由类别决定。
  - **恢复按钮上永远写得出"现在能做什么"，不留一个只写着"不可用"的死按钮**。只有可重试的那一类给可按的重试；其余给出各自该做的事。**一个按下去必然失败的按钮比禁用更糟——它承诺了一件做不到的事**；禁用态的说明由该类别的原因文本承载，不是空着。
  - **Core 没给原因时如实说不知道，不挑一类当默认**。把未知显示成"Provider 不支持"会把用户支去新开 Agent，而真相可能只是 Host 掉线。分不清就说分不清，这与「未知不得当作正常」同源。
  - 分类判定落在渲染层之外的纯函数里，且**对原因的分支不设 default**：Core 日后新增一个原因时，这里必须**编译不过**，而不是安静折进某句通用文案。
- **恢复动作必须幂等**。同一 Agent Session 在重复启动、窗口重新聚焦或 Topic 重进时，若已有精确匹配的 live Run 只能 attach；若 Run 已丢失且 handle 有效，只允许创建一个新的 Provider-native Run。任何迟到的旧 Run 事件都不得覆盖新的绑定。
- **机器重启后的边界必须如实表达**：旧 PTY 进程、ctxmux 内存 scrollback 与 pending interaction 不承诺可恢复；可恢复的是持久化的 Agent Session 语义身份及 Provider 自己支持的 resume。于是重启后终端可能从新 Run 的首屏开始，但布局、Agent 身份与自动恢复动作必须仍在。**布局仍在的含义是它的每一面都能用**：一个恢复出来的文件面必须真的把文档装上，而不是留一个报「不可用」的空壳；文件确已不在磁盘上时，走的是与「打开着的文件被删」完全同一条既有失败态，不另造一种。

### 寻址与复制

- **复制出去的是一个寻址方式，不是一个 id**。任何"复制"动作的成品都必须让接收方（通常是另一个 Agent）**仅凭这一次复制**就能完成寻址：说清目标是什么身份、给出可直接执行的命令。裸 id 不合格——接收方拿到 `session:abc` 或一串 uuid，无从知道它是哪一层身份、该配哪个 flag、该跑什么命令，只能回头问人或翻文档，而那正是这次复制本该省掉的一步。
- **三级地址回答三个不同的问题，绝不互为别名**（与上文 Session/Run/View 的身份边界同源）：
  - **Session** 回答"**哪个 Agent**"——Provider 语义身份，跨 View 稳定，一个 Session 可同时投影到多个 Region 与多个 Tab；
  - **Region** 回答"**屏幕上哪一格**"——View 内的内容 leaf，是分屏场景下**唯一无歧义**的展示身份；
  - **Tab/View** 回答"**哪张完整工作面**"——它只在该 View 恰好承载唯一一个 Agent 时才可用作 Agent 寻址。
- **歧义在源头消除，不甩给接收方**。一张 View 分屏承载多个 Agent 时，Tab 地址本身就是歧义的；此时复制出的地址必须**直接是 Region 地址**，而不是一段"先 inspect、若返回 `MESSAGE_TARGET_NOT_UNIQUE` 再从 candidates 里挑一个"的操作指引——把消歧工作转嫁给接收方，等于这次复制没有把寻址方式说清楚。歧义只在源头可见：复制发生时我们知道用户点的是哪一格，接收方不知道。
- **复制入口按其能消除的歧义就近放置**：**Region 右键菜单**产出 Region 地址（用户点哪一格就是哪一格，无需推断当前聚焦，而想寻址的那一格往往恰恰不是聚焦的那一格）；**Tab 右键菜单**产出 View 级地址，语义收敛为"整张工作面"。同一 Session 在两处产出的 Session 地址必须一致——它们是同一份真相的两个入口，不是两套格式。
- 复制的地址**只使用已被 CLI 与 Control 面接受的寻址方式**（`--to-session` / `--to-region` / `--to-tab` 及 `inspect` 的对应 flag），不为复制发明第二套语法。地址里的 id 一律按 shell 语义转义，使带空格或引号的 id 粘贴即可执行。
- **按意图给入口命名，而不是按地址种类**。"复制 View 地址"要求用户先知道自己想要哪一层身份，可用户想的是"把这个 Agent 交给别人"。因此交接类入口按意图呈现（"给这个 Agent 发消息"），并由我们解析成**最精确的那个地址**：指向某一格分屏时是 Region，目标唯一时是 Session。View 地址不因此消失，但它的意图是"分享/检查整张工作面"，不是交接的默认落点——这与上一条同源：知道用户点了哪一格的是我们，不是接收方。
- **失败结果要自带下一步命令，而不只是候选清单**。`MESSAGE_TARGET_NOT_UNIQUE` 已经带 `candidates`，但候选清单仍要求接收方自己拼出命令——那正是"歧义不甩给接收方"这条原则在错误路径上的漏洞。因此这类失败要额外返回**可直接执行的恢复命令**；stale View、目标不是 Agent、Agent 已退出各自给自己的恢复入口。恢复命令与复制出去的地址**共用同一个格式化出口**，不为错误路径另写一份拼接（两份拼接会各自演进，且漂移时不会有测试变红）。
  - **恢复文本挂在控制错误的出口层，不挂在抛出点**。同一个失败码往往有多个抛出点（`TAB_NOT_OPEN` 与 `REGION_NOT_OPEN` 各三处），在每个抛出点拼一次恢复文本，必然随时间各自演进，而漂移的那天不会有任何测试变红。控制错误离开渲染进程只有一个出口，恢复文本要说服的正是**出口对面那个调用方**——所以那一层是它唯一该长出来的地方。
  - **哪些码算"寻址失败"由地址模块自己判定，出口层不列第二份码表**——两份码表同样会漂移。不属于寻址失败的码**不附加恢复文本**：一句放之四海的"再试一次"既没有信息，又会盖住原始 message 里真正的原因。
  - **恢复命令只用已通过校验的候选**。未校验的 id 可能带换行或保留字，会把恢复文本切成一段执行不了、甚至误导人的命令——那比不给恢复更糟。
  - **给出的每一行命令都必须真能跑；给不出就不写命令**。"下一步"的价值全在于粘贴即可执行，一条命令形状但跑不了的文字比不给更糟——它看起来像出路，用户照做撞的是第二次失败。判据不是"读起来像命令"，而是拿真实 CLI 语法逐行校验：`inspect` 必须恰好一个选择器 flag，`send` 除选择器外**还必须带 `--text`**（少了它是 `INVALID_CLI_ARGUMENT: Message text is required.`），`list` 必须带子命令。守卫若只断言"含 `agentmux inspect`"，对跑不了的裸形式同样为真，等于没有守卫。
  - **守卫的粒度必须细过它要防的那个 bug**。上一条的裸 `inspect` 修好后，形状表把 `send` 与 `inspect` 合写成一条，于是漏掉 `--text` 的 `send` 又一次照样匹配——同一个洞换了个位置复发。凡是修"断言太粗"，都要回头检查同一条断言里还有没有第二个粗的地方；不同动词有不同必填项，就不能共用一条形状。
  - **写"下一步"之前，先证明这个失败是怎么到达的**。判据是抛出点外层的分支条件，不是错误码的名字。`AMBIGUOUS_REGION_TARGET` / `AMBIGUOUS_TAB_TARGET` 听起来像"你给的地址匹配到多个"，实际只从 `self` 分支抛，真实含义是"发起方自己同时显示在多处"——显式 id 走不到那里（Region id 是 UUID，全局唯一）。按名字直觉写出来的文案会让用户去改地址，而问题出在"我在哪"这个前提上：**一条方向错的下一步比没有下一步更糟**。这类文案要用语义断言钉住（必须点名 `self`，不许套用另一个码的说法），形状断言（"命令能跑"）对措辞错误一视同仁，抓不到张冠李戴。
  - **这条判据对复制侧与恢复侧同时成立**。"粘贴即可执行"本就是复制这件事的全部意义，而它一度只被施加在恢复文本上：改掉命令出口的 `--text`，三个地址的复制断言纹丝不动，因为它们只校验到 id 就收手了。共用出口的两侧，判据也要共用同一个校验函数，各自带"检查了几行"的下界防"一行都没检查"。
  - **有些失败本来就没有对应的命令，如实承认**。恢复层只拿得到错误码，拿不到 tabId、regionId（抛出点没带过来）；而 View / Region id 本就是界面上的临时身份，关掉即失效，CLI 无从重建。这类失败的诚实下一步是**界面里的动作**（在那一格上右键重取地址），外加一条真能跑的旁路：Session 跨 View 稳定，用它照样够得到同一个 Agent。
  - **"列出还活着的 Agent"是 `list sessions`，不是 `list agents`**。后者列的是配好的 executor 类型（provider 目录），不是此刻活着的 Session——两个子命令都能跑，因此"命令真能跑"这条守卫对它们一视同仁，必须另有一条断言钉住语义，否则改错了不会红。
- **「左边/右边/上面/下面」在创建时是分栏，在查看时也能落到 Tab**。用户原话：「当描述"右边"、"左边"的时候，除了识别 region，也可以去识别 tab（也就是 tab 的关系也应该能查到）」「如果要创建一个"左边、右边、上面、下面"，那应该就是 split」「但如果让他去查看"左边、右边、上面、下面"的时候，如果没有 split，tab 应该也要能识别」。今天方向只存在于 `open` 的 `destination`（`{kind:'split', region, direction}`），`inspect` 一侧根本没有方向这个概念——于是 Agent 能造出一个右边，却问不出"我右边是什么"，除非那一格恰好是它已知 id 的 Region。
  - **创建与查看的默认落点不同，这是有意的，不是不一致**：创建一个方向只有一种诚实解释——用户要多一格，那就是 split（新开一个 Tab 不叫"在右边"）；而查看一个方向时，屏幕上"右边"的东西可能是同一 View 里的另一格 Region，**也可能在没有分栏时就是 Tab 条上相邻的那张 Tab**。查看端拒绝回答"没有分栏所以没有右边"，等于对着用户眼睛看得见的东西说不存在。
  - **优先级由"屏幕上更近"决定：先 Region 后 Tab**。同一 View 内有分栏时，方向解析必须落在 Region 上——那才是用户视线里紧挨着的那一格；只有当该方向上没有兄弟 Region 时，才退到 Tab 邻接。反过来（先 Tab）会让一个分了栏的 View 把用户指向另一张 Tab，与所见不符。
  - **上下方向对 Tab 不成立**。Tab 条是一维水平序列，"上面那张 Tab"没有所指；此时如实回答该方向没有邻居，**不许把 up/down 悄悄折成 prev/next**——那会让 Agent 以为自己拿到了上方的东西，实际拿到的是左边那张。
  - **"哪个算右边"只有一处定义**。创建与查看做的**不是**同一件事——split 是在 Region 树上劈开一个节点，查看是在已排好的版面上找邻居——但两者对 left/right/up/down 的**轴向解释**必须来自同一处（横向轴属 left/right，纵向轴属 up/down）。方向查询自身写成纯函数，从既有的版面几何（Region 的归一化 bounds）与既有的 Tab 序列推导，不为它另建一份布局真相；否则漂移时只表现为 Agent 偶尔寻址到隔壁，而没有测试会红。
  - 这是**寻址能力的补齐，不是新身份**：解析结果仍然是既有的 Region 地址或 Tab 地址，走既有的 `--to-region` / `--to-tab`，不发明第四级地址，也不新增 surface kind。
- 后台 Agent 由 Agents 工具重新发现和打开，不建立第二份 Session Registry。
- **Agent 自己就能把 terminal、browser 或文件开到某个方向的分栏里**，走的是既有的 `open` / `arrange` CLI——那已经是"Agent 驱动界面"的接口，**不新建第二条通路、不新增 surface kind**。缺的从来不是能力而是发现：因此由启动时注入的提示负责让每个 Agent 知道这件事存在、并知道去哪查确切用法，而**不把完整 CLI 语法抄进提示**（那会与 skill 争夺唯一真相，并在语法演进时立刻过期）。这条的验收是行为断言——证明启动路径确实携带了该提示，而不是断言 skill 文本里含某个字符串：后者在改动前也会通过，证明不了任何事。

### AgentMux 对 Agent 说的话

- **AgentMux 自己发给 Agent 的话，收敛到一个模块**。今天这类文本散在启动提示、discuss 首条消息、send、resume 四处各拼各的，唯一共用的只有终端粘贴的字节封装（bracketed paste），那是**字节层**的包裹，不是**语义层**的署名。散着拼的后果不是难看而是不可演进：想给所有出站消息加一个字段，得记得改四个地方，漏掉的那个不会有测试变红。
- **出站消息要结构化，让 Agent 能分辨这句话是谁说的**。形如 `<amux from="amux" …>…</amux>` 的显式信封，把"AgentMux 在对你说话"与"用户在对你说话"分开——没有信封时，一段系统注入的运行时说明和用户的真实请求在 Agent 眼里是同一段文本，它只能靠措辞猜。信封是**给 Agent 读的**，因此格式要人类可读、可嵌套在自然语言里，而不是另造一套需要解析器的线协议。
- **信封承载的是已有的事实，不新建第二份消息台账**。作者、因果、投递状态已经在 Core 的 Message/Delivery 类型里；信封只是把其中该让 Agent 知道的那几项序列化进它真正读到的文本。这条明确划清与已否决的 agent 间可信通信（capability 签名、幂等 ledger）的边界：那套东西的前提是 **Agent 之间要互相认证**，而我们的模型里**人是信任锚**——信封不做认证，它只做署名与可读性。
- **因此 `from="amux"` 是声明，不是凭证——它可被伪造，任何代码都不得把它当已核实的信任凭据**。信封无签名无校验，一段 `<amux from="amux">…</amux>` 是纯文本，谁都能写出字面相同的一段。这在 discuss 这条链上是真实注入面：发起方 Agent 的正文按用户段透传，它完全可以在正文里嵌一段假信封冒充 AgentMux，而发起方不是人——"人是信任锚"的论证在 Agent 对 Agent 时并不成立。所以入站侧**绝不**把 `<amux>` 解析回任何信任或授权决策；信封只服务于"给 Agent 读、让它区分这话是谁说的"，越过可读性去当安全边界用就是误用。真正的身份判定仍走 Core 的 capability（见《消息账本》），与这层文本署名两回事。
- **用户内容永远不被信封改写**。信封包裹的是 AgentMux 自己的话；用户那句原文照旧原样送达，不被塞进属性、不被转义成另一种形状。Agent 收到的用户文本必须与用户敲的一致，否则复现问题时没人知道 Agent 究竟读到了什么。

### 启动握手与自命名

- **Agent 启动时应当先认识自己所处的环境**。今天的启动提示只在"需要分屏时"指向 `--skill`，于是 Agent 直到真的想开分屏那一刻才知道自己在 AgentMux 里——在此之前它既不知道自己是谁（Session/Region/Topic/Workspace），也不知道有哪些能力可用。因此启动时先做一次握手，让 Agent 从第一步就拿到自己的坐标与可用能力，而不是等到需要时才发现。
- **握手要一次问答就够，且不与 skill 争夺唯一真相**。返回坐标与能力清单，而不把完整 CLI 语法抄进提示（与上文同源：抄进去会在语法演进时立刻过期）。验收沿用同一条行为断言口径——证明启动路径确实携带并执行了握手，而不是断言提示文本里含某个字符串。
- **等命名能力齐备后，让 Agent 给自己起名**。名字的优先级链里已有"从成员/首条 prompt 派生"这一档（见《显示名与身份》），Agent 自命名是同一档上更好的一个来源：它比从首条 prompt 截一段更贴近这个 Agent 实际在做的事。它仍然**低于用户手改**——自动命名绝不覆盖用户意图这条不因来源变成 Agent 而松动。这条**排在命名链落地之后**，否则会先造出一个没有归属的名字字段。

### 交出去与派出去

- **"交接"必须是一个原子动作，不是一段靠措辞表达意图的普通消息**。Core 早就区分了两件事：**Handoff**（交出去，`originAwaits: false`，责任跟着工作走）与 **Dispatch**（派出去，原 Owner 仍要接问题、接升级、接收工）。唯一的分界就是 `originAwaits`，它留在 Core，命令面不复述也不重实现。用普通消息模拟交接的后果是"我以为你在管、你以为我交出去了"的悬空工作。
- **交接的发起者始终是人**。不引入 Agent 自主把任务派给另一个 Agent 的回路，因此 handoff **不夹带消息投递**——一旦它同时"转移所有权"和"投递指令"，那条被否决的回路就有了雏形。要送文本走 send/discuss，那是另一件事。
- **交接的目标用与位置无关的 Session 身份寻址**。多态寻址（Region/Tab）要过 Control 面解析成 Session，把一个原子动作拆成两跳，还让它依赖 Desktop 活着——而交出所有权不该有这个前提。
- **今天这条能力的语义前提尚未建立，界面不得假装它已建立**。`handOff()` 返回一个 frozen 的结果对象，**没有任何持久化落点、没有第二个读者**；更根本的是 **Core 没有 Task 实体**，`taskId` 是一个不指向任何东西的自由字符串。所以此刻能诚实展示的，只有那一次调用返回的事实（`ownerAgentSessionId` / `originAwaits`），**不能显示成"这个任务现在归谁"**——系统事后回答不了这个问题。补这个缺口要先有一个可被指向的实体，那是独立决策；在那之前，加一个 owner 字段存进去的是无人能验证有效性、无人知道何时算完成的自由文本，**比不存更糟，因为它看起来像事实**。

### 我们的流程坏了，不等于 Agent 坏了

用户原话："我觉得当然不能算坏了，也不能阻断，但是可以有一个类似服务窗之类的设计给用户提醒……原则上不能因为我们的流程问题，让原本已经跑通的 Agent 受阻，这是绝对不允许的。"

- **任何失败在阻断用户之前，先分清三种状态**（原则见 `AGENTS.md` 第 11 条）：**完全坏了**（Agent 本身不行了，阻断是诚实的）、**Agent 没坏但我们的流程坏了**（放行 + 提醒）、**完全好的**（不打扰）。判据是"Agent 还能干活吗"，不是"我们的检查过了吗"。
- **第二类绝不阻断**。启动握手超时是这一类的样板：`[?u` 这个能力探测在 10 秒内没等到，通常只说明 CLI 还没走到吐出它的那一步（冷启动慢、机器负载高），进程活得好好的；而当前实现四个调用点全部 fatal 且带回滚，等于用我们的一次探测失败杀掉一个健康的 Agent。**超时的正确含义是"这项能力当前未知"，不是"这个 Agent 坏了"**。
- **提醒的形态是服务窗**：像窗口上贴的一条告示，说清楚三件事——哪一步没走通、现在按什么状态在跑、要恢复完整能力该做什么。它停在旁边不挡路，不抢焦点，也不自动消失（消失了用户就再也无从知道自己在降级状态里）。它不是 toast，也不是错误弹窗——那两者一个留不住、一个在说"你完了"，都不符合"能干活，只是少一项能力"这个事实。
- **两条边界**：不许**静默**降级——用户有权知道自己在降级状态下工作，少一项能力可能改变他对 Agent 行为的判断；也不许**把未知当成好的**——分不清是哪一类时，如实说"分不清"，而不是猜一个然后照着做。
- **终端恢复态是这条原则的第二个消费方**。用户原话："现在有个 ctxmux 明明存在还在打开时显示 restoring"。恢复态此前只有两个出口——全链成功、attach 抛错——于是"我们的揭示流程卡住了"这一类在界面上表现为**永久转圈**，而 ctxmux、Run、PTY 全都好着。这是第 2 类被写成了"无限期等待"，比写成第 1 类更糟：连"哪里不对"都不告诉用户。**一个我们等不到的步骤，不得把一个健康的终端永久藏起来。** 揭示因此带 deadline，到点强制把画布交还给用户，并按同一个服务窗说清哪一步没走通、现在按什么状态在跑、怎么恢复（架构侧的揭示时序与锁竞争见 [`terminal-runtime.md`](../architecture/terminal-runtime.md)）。恢复态本身保留——真正需要重放时它仍是诚实信号，被削弱的只是它无限期遮挡画布的权利。
- **「放行」不等于「什么都通了」，且能力差异必须说准。** 第 2 类要求不阻断，但**不要求谎报**。终端揭示是这个陷阱的样板：强制揭示时 replay→live 的交接可能还没完成，此刻键盘敲下去会写进一个还没接上的 attachment。所以两件事必须同时成立——**输入真的没通**（三条输入通路统一卡在同一处判定；少卡一条就等于没卡，用户总会找到那一条），且**告示如实说输入还没通**，而不是笼统地说"现在可用了"。放行的是**用户的去路**（画布交还、不再挡着），不是**每一项能力**；把两者混为一谈会让告示变成一句好听的假话。相应地，"这项能力当前是否可用"这种输入**不给默认值**——默认必然偏向"可用"那一侧，而那正是会撒谎的一侧，等于把未知当成好的（见上一条第二边界）。
- **Prompt 交付验证是这条原则的第三个消费方**。render-then-submit 路径用终端屏幕证据确认 payload 已上屏再发提交键；当证据因我们的观察失败（replay 被截断、`OUTPUT_GAP`、render 超时）而读不到，但 payload receipt 已确认且 Run 仍活着时，**不得把提交挡住**——那是第 2 类。正确做法是照常发提交，并挂上服务窗：说清验证哪一步没走通、本次交付未经完整屏幕确认、如何恢复完整验证。真坏的边界不变：Run 已退出、进程已死、或 payload 本身从未被接受，仍 fail-closed。静默放行同样禁止。
- **屏幕语义证据不得按会话全史从零重建作为热路径**。每次提交或 readiness 观察若都从 byte 0 全量重放进临时 headless 终端，延迟随历史线性增长，并放大 gap 截断概率。活跃 Session 的屏幕证据应增量维护，或从最近完整 TUI 帧/检查点起点观察；失效（resize、重连、gap）时重建。字节史与 replay/checkpoint 权威仍在 ctxmux——Core 不另存第二份 Run 字节。Desktop cold-park 的重建成本与同一条有界证据合同对齐，见 [`agentmux-surface-density.md`](./agentmux-surface-density.md)。
- 这条与《寻址与复制》里"失败结果要自带下一步命令"同源：失败不是终点，是一个要说清楚"现在怎么办"的时刻。

## 界面结构

### 顶部与项目栏

- macOS 红绿灯之后固定放 Projects 与 Workspace tools 两个开关，顺序和位置不随面板状态变化。
- 单 Pane 时，根 Tabbar 与窗口顶行合并；分屏时保留全局 chrome 行，每个 Pane 使用自己的紧凑 Tabbar。
- Project Rail 展开时只在底部放 Settings 与 Hosts；收起后只保留不遮挡内容的 Settings 角标。
- **项目行回答三件事：哪个 Project、在跑几个 Agent、要不要你**。尾部的数字是**当前在跑的 Agent 数**，不是这个项目有几个 worktree——用户扫这一栏是在找"哪儿还有活在动"，仓库有几个 worktree 属于结构事实，答的不是同一个问题，进 tooltip。零不显示数字，只有真在跑才占位。Host 同理：本机是绝大多数情况，每行都写一遍 `This Mac` 不携带信息，只有远程 Host 才值得占一个位置。
- **Branch/Worktree 条与 Topic 条是同一种交互，但不是同一份真相**。两者都是"挑一个条目 → 进到一组 Tab、每个 Tab 是一套 Region 分屏"，因此**表现层共用**（见密度合同《控件语言》）。但选中真相不同且必须保持不同：Branch 切换换掉的是 `activeWorkspaceId`——一个 worktree 本身就是一个 Workspace，天然拥有自己那份 layout；Topic 全部共享 Scratch 这一个 Workspace 的同一份 layout，切 Topic 是把它**投影**成只含该 Topic 的那组 Tab。不得为了"看起来统一"把 Topic 也提升成真实 store 字段，或把 Branch 降成投影——那会给同一件事造出第二份真相。
- 窗口底部有且仅有一条**跨会话注意力汇总栏**，横跨整宽。窗口里其余每个状态指示都是**有作用域**的——Tab 状态点只讲一个 Session，Board 列只讲一个 Project，Agents 工具的总数只讲一个 Workspace 且只在其工具坞打开时。这条栏回答它们都不回答的那一个问题：这整个窗口里（含折叠的 Pane、其他 Tab Group、其他 Workspace），现在有没有 Agent 需要你。它只在窗口至少投影一个 Agent Session 时出现，否则完全不占位。它是聚合而非某一个 Session，因此没有诚实的 `status.source`/`observedAt` 可交给 StatusDot——绝不伪造证据，只复用共享状态语汇（同一套点与颜色），使这里的一个点与 Tab 上的点含义完全一致；计数为零时保持中性灰。"需要你" 与 "错误" 两段是动作：点击跳到该注意力类别里 `status.observedAt` 最早、即等待最久的那个 Session；聚合计数写进这两段按钮自己的可访问名，让读屏得到事实而不只是"跳转"。它只读 Store 里已有的 Session 投影，不新增任何管线。
- 汇总栏的**总数段是名册的展开入口**。栏回答"有没有需要你"并跳到等待最久的那一个；名册回答"都有哪些"。二者是同一份聚合的两个尺寸，不是两个数字：折叠态只占那枚本已存在的计数，展开才付出空间，且关闭时展开内容不驻留 DOM。名册**只读**既有 Session 投影与 Core 已有的 pending interaction 事实，不新增 Core 合同、不建第二条消息状态机、不为待处理请求另开一个列表——待答的行就是这张表里的行。排序复用全窗口同一套语汇：needs-you 优先于 error 优先于 working，同一类内 `status.observedAt` 最早者在前，与汇总栏"跳到等待最久"的落点一致。
- 名册的每一行显示该 Agent **启动时固定的授权范围**。它来自 Core Session 记录里已持久化的 launch-option 选择，经 DESCRIBE 半边（仅 choice id）跨 IPC，标签由 Renderer 用 Provider 自己的 catalog 声明解析——argv 仍然不出 Core。两条诚实规则：创建时未收窄任何一项则**什么也不显示**，绝不写"默认"（那是无人记录过的事实）；选择所对应的 option 或 choice 若 Provider 已不再声明，该项**丢弃**而非渲染裸 id（一个 `bypass-all` 当标签显示，会像一个已核实的授权，实际却无从解析）。行上最多一枚风险标记，取该行诸范围中最宽的那一档；Provider 未声明 tier 的选项不被补成 `safe`。
- **注意力沿导航树上卷**：某一层内有 Agent 需要你时，该层的折叠行也必须表达出来，否则折起来的项目与空闲项目无法区分，"先处理谁"就退化成逐层展开去找。上卷复用同一份 Session 投影与共享状态语汇，不建第二个聚合管线；一行只显示其下**最紧要**的那一个信号（needs-you 优先于 error），并带形状而非仅靠颜色。`done` 不点亮任何行——完成已由通知与 Board 承载，常驻标记会让整条栏长亮，从而淹没"有人在等你"这唯一要紧的信号；`disconnected` 同样保持中性。
- **通知要说清是谁、什么状态、在聊什么**。一句"Agent needs you"不足以让用户决定要不要放下手上的事——他需要知道是哪个 Agent、现在什么状态、Agent 最近说了什么、自己最近问的是什么。通知正文因此带上最近一轮对话的摘要（Agent 最近回复 + 用户最近提问），而不只是一个名字加一句泛化描述。内容从既有的 Session 投影与 Activity 时间线派生，不为通知另建一份对话记录；取不到时如实略去那一段，不填占位文字。
- **停留时长是一条滑轨，从关闭到"等待用户确认"**。用户看到通知时往往正在别处，一闪而过的提示等于没发。这条设置是一个连续的量级选择——`关闭` → 若干档停留时长 → `等待用户确认`（不自动消失，用户点过才走）——而不是一个"开/关"加一个隐藏的时长输入。默认档要足够长到用户能读完带对话摘要的正文。滑轨的取值只有一处定义，通知投递与设置界面共用它，不各写一份档位表。
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
- **切换 Project/Workspace 也遵守同一条保活合同**。所有已打开 Workspace 的 Workbench 由窗口级 owner 保持挂载；非当前 Workspace 只隐藏并停工，不卸载其 Session Region。切换回来不得重新 attach、重新 loading TUI 或从 replay 起点重放一遍。Workbench 真的关闭、Region 被删除或 Session 被用户明确停止时，才释放对应实例与 attachment。
- **保活不等于无限常驻重资源**。活动 Workspace 与近期访问的工作面保持 warm，确保回访不触发恢复态；长期隐藏、超出明确 hot-retain 数量的 Terminal/Monaco/Browser surface 可以进入 cold-park，但只能在该 surface 有可验证的重建或 replay 路径、且不切断 Core Session/Run 事实时进行。cold-park 必须有 TTL、数量上限与 cooldown，避免在项目来回切换时反复卸载/挂载；语义 Session、Topic/Region 布局和可恢复的 attachment 归属不得因内存预算被删除。
- **项目切换本身不得触发 cold-park**。非当前 Workspace 的 Workbench 虽然隐藏，仍受保活合同保护；只有当前 Workspace 内长期隐藏且满足重建条件的非活动 Tab 才能进入 cold-park。这样切换项目后立即回来不会因为 30 秒计时器卸载 TerminalView/attachment，因而不会凭空制造 replay gap；真正关闭 Workbench/Region 或用户明确停止 Session 的释放边界不变。
- **内存归因必须按进程和 owner 分层**。比较 AgentMux 与其他客户端时，不能把 Chromium helper 的 RSS、共享页或 V8 保留容量直接相加后称为“应用泄漏”；至少要分别记录 Main、Renderer、GPU/Utility、Browser target，以及 Terminal/Monaco/Browser/attachment owner。只有在同一场景的 working-set 与 owner count 同时收敛时，才把 cold-park 记为有效回收；没有证据的数值不得写成产品承诺。

### Agent Composer 与 Terminal

- Composer 属于 Agent Session Region，不属于 Activity。Agent 的 Terminal 与 Activity 只是同一 Session 的两种投影；切换投影时 Composer 必须保持挂载，不能清空未发送草稿。
- Activity 投影画成时序日志而非卡片流，但日志有**两个寄存器共用同一条 spine**。机器上报（tool_call / permission / lifecycle）保持 24px 紧凑行：一连串 native-hook 步骤折叠成一条 “N steps” 摘要，展开后字节完全相同的重复合并为一行并标 xN，重试循环因此读作一个事实；工具调用的 argv 默认折叠、按需展开。人真正要读的**对话回合**（user_message、assistant_message）脱离这条机器寄存器：它们沿同一条 spine、同一个 20px 节点槽渲染，但正文用 13px 主色、caption 只是一枚安静的 speaker 标签，始终完整渲染、永不折叠——那是 trace 的实质，不是 payload。折叠只按 kind 收机器步骤，assistant 回合虽是 native-hook 也绝不被卷进折叠；不为任一回合重建 per-hook 卡片。User 正文用 `--surface-1` 圆角填充给出起止边界（描边不作手段），Assistant 正文在工作面上流动，二者靠**头像**与填充差别在一眼之内区分——不靠"blue/green 两枚图标"：Agent 一侧的头像颜色由身份 id 派生且**刻意避开 green**（green 是"成功"这个状态词，见本章「派生色相必须让开语义色所占的弧」），所以"assistant 是绿的"这条早期说法已被推翻。green 只留在 ruler 刻度与机器上报行上，那两处回答的是"这是什么事件"而不是"这是谁"。顶部 ruler 的诚实时间轴与无跨度时的序数退化见 [`agentmux-surface-density.md`](./agentmux-surface-density.md) 的 Activity Ruler。
- 每个 Agent Region 都显示同一个 Composer。Agent 尚在启动、已经断连、退出或中断时仍显示，但在 Agent Run 不可交互时禁用；Raw Terminal 永远不显示 Agent Composer。
- **对话体的说话人要有头像与身份，而不是一枚文字 caption；ruler 分两条轴**。用户原话：「现在有很多 bug, 比如 user 消息也会被收进 Agent 的历史, 感觉不够优雅」「在进度条上, 也可以分成自我 Agent 轴, 和 说话人 轴, 说话人这条轴, 考虑到接下来可能有 A2A, 所以最好的方法是, 在说话人轴上显示头像, hover 是有面板展现原话, 然后自我 Agent 轴上, Agent 说话了的情况也可以用头像」「要做成可复用组件」。
  - **今天的缺口是身份被压成了一个二值**：`Turn` 只按 `kind === 'user_message'` 在 `'You'` 与 `'Assistant'` 之间选一个文字 caption，于是"谁说的"只有两种可能。A2A 一旦落地（见 [`发起协作`](#交出去与派出去) 与 A2A 设计包），说话人就是**开放集**——多个 Agent、以及代表用户的那个身份，都要能在同一条对话里被认出来。把开放集塞进二值 caption，就是今天这个"不够优雅"的根：user 消息与 Agent 自己的话共用一种形状，读起来像是被"收进"了 Agent 的历史。
  - **两条轴回答两个不同问题，所以是两条而不是一条**。**自我 Agent 轴**回答"这个 Agent 这一轮在干什么"（机器上报的节奏、工具步骤、这一轮的跨度）；**说话人轴**回答"这段话是谁说的"。二者时间基准同源（同一条诚实时间轴），但值域不同——前者是一个 Agent 的活动强度，后者是若干个身份的出现位置。合成一条会让"Agent 在忙"与"有人说话"抢同一个视觉通道，而这恰恰是用户要分开看的两件事。
  - 已实测（2026-08-31）：**对话正文的形状只能有一个出处，就是身份判定那个纯函数**。原先正文按 `kind` 分叉（`log-turn--user_message` 之类），于是"这段话是谁说的"在同一个元素上有了两套答案——属性一套、头像与 caption 另一套。把其中一套单独改坏，既有断言 23 条全绿，元素自相矛盾（属性说 agent、头像说 human）也没人报：**每条断言只看其中一套，粒度比 bug 更粗**。判据：属性、头像、caption 三者同源，且要用一个"两个候选判据会给出相反答案"的 fixture 去验（例如 `source:'user'` 配 `kind:'lifecycle'`），否则守卫在两个判据恰好一致的常规数据上永远绿。**机器上报那一路仍按 `kind` 画**（tool_call 是锤子、permission 是盾）——那一路问的是"这是什么事件"，锤子就是对的答案；不要把"身份不许由 kind 反推"错读成"kind 不许决定任何画法"。
  - **说话人轴上是头像，hover 出面板展现原话**。**当前这条轴上只会有人类用户的发言**——用户原话：「所以现在在用户或者说话人的这条轴上, 应该只会有人类用户的发言」。A2A 只做**设计预留**，不要求真的完成：身份按开放集建模（轴能并置多个头像、身份不由 `kind` 反推），但今天的实际值域就是一个人类用户。这个区分很重要——预留的是**形状**，不是一条现在就要点亮的功能；把 A2A 当成本轮交付会让一个还没有真实数据源的轴先长出空槽。头像是开放集在窄轴上唯一站得住的表示：文字 caption 在多身份下会挤成一团，而头像既能表达身份、又能在一个 16-20px 的轴上并置多个。**自我 Agent 轴上，Agent 说话了的那些位置同样用头像**——两条轴共用同一套身份表示，不是各画一套。hover 面板给的是**原话**，不是摘要：轴的作用是让人在不滚动的情况下找到"那句话在哪儿"，摘要会让这个用途失效。
  - **必须是一个可复用组件，按轴的语义参数化，不是两个组件**。这与 Board「一个 Board 组件按行来源参数化，不是两个 Board」同源：两条轴共用时间基准、共用头像表示、共用 hover 锚定（复用既有 `terminalLinkPreviewAnchor`，那条"永不遮挡它所描述的东西"的规矩已经在 ruler 与终端链接预览之间共用了一次，不能在这里开第三份）。分成两个组件，就等于给"轴怎么定位、头像怎么画、面板怎么锚"各开两份答案，日后必然漂移。
  - **主视觉要服务 A 端快速交互，不是服务阅读一篇文章**。用户原话：「着重考虑主视觉和相关设计语言, 是否最符合和 Agent / A 端的快速交互特点」。与 Agent 交互的实际节奏是**扫**而不是**读**：用户要在一屏里判断"轮到我了吗、上一句我说了什么、它现在卡在哪"。所以视觉权重给这三件事，而不是给装饰——头像与轴让"谁说的"在一眼之内落位，正文保持既有的 13px 主色不被削弱，机器上报继续压在 24px 紧凑行。任何让扫视变慢的处理（额外描边、每条消息一张卡、头像加光晕）都与这条相悖。
  - **样式要能移植到手机**。用户原话：「这个样式要能够比较好地移植到手机上去, 尽量照顾到」。这对轴的实现有硬约束：hover 在触屏上不存在，所以"hover 出面板"必须有一条**同源的**点按通路（同一个面板、同一套锚定，不是另写一个移动端组件）；轴的命中区要够大（触屏最小命中尺寸远大于鼠标）；两条轴在窄屏下要能退化而不是横向溢出。这条不要求本轮真的出移动端，但**不许做出一个只能靠 hover 才能用的轴**——那会让移植变成重写。
  - **顶部那条已经炼化落地的进度条要保留**。它比其他实现更强的部分（诚实时间轴、每行偏移、无跨度时退化为序数）是既有资产，新增的两条轴是**在它之上分轴**，不是替换它。任何"重写一个更简单的 ruler"的方案都要先解释它如何不丢这三条。
  - 已实测（2026-08-31）：**"在它之上"必须是同一个坐标框里的一行，不能是它上方的一个兄弟**。轴标记与刻度都用 `left: N%` 定位，而百分比解析的是各自包含块的宽度——两者只有在同一个盒子里才落在同一个像素上。ruler 那一行是 `.activity-ruler`：它有侧向内缩，且把刻度轨道当 `flex: 1` 排在跨度读数与说明**之后**（约 90–110px）。所以做成兄弟的轴会整体右漂，且漂移量随 fraction 增大——事件越晚、偏得越多，最左那枚还被裁掉一半。判据：轴与刻度轨道必须是同一列（一个共用的 stack）的两行，跨度读数与说明留在这一列之外。**对齐是这两条轴存在的全部理由**，所以这不是"顺带做好一点"，而是它的正确性条件。
  - **身份来源必须有唯一权威，不在渲染层猜**。头像取自哪个身份事实（Agent 的 providerId/label、还是 A2A 的参与者身份）需要在 Core 侧有明确出处；渲染层不得按 `kind` 反推身份，那正是今天二值 caption 的形态。这条与「显示名与身份严格分离」同一条约束：身份用于寻址与取头像，显示名只用于显示。
  - 已查证（2026-08-31）：**timeline 上今天没有能承载"开放集说话人"的字段**。`AgentTimelineItem` 的两个相关字段都是闭集：`kind` 只有 `user_message | assistant_message | tool_call | permission | lifecycle`，`source` 只有 `terminal-output | run-process | native-hook | acp | user`（均见 `packages/core/src/types.ts`）。二者都不携带身份，没有 speaker/participant 之类的字段。所以按上一条，**开放集说话人是一次公共合同变更，不是 Renderer 的自由**——与 skill 派发需要新增 kind 是同一类判断，不得在 Renderer 里靠 `label` 字符串凑。
  - 由此得到本轮的落点，**顺序不可颠倒**：今天可交付的是「把身份判定从渲染层的二值分支收敛成一个有唯一出处的纯函数」，它的值域就是今天真实存在的那两个身份（人类用户、这个 Agent 自己），并且**函数的返回形状要能容纳第三个身份而不必改调用方**。真正的开放集（多个 Agent 各有身份与头像）要等 Core 侧先有身份事实——那是一次独立的合同变更，不在本轮。**不要为了让轴"看起来支持 A2A"就在 Renderer 里造一个假的身份来源**，那正是这条约束要挡的东西。
  - 已查证（2026-08-31）：**现有头像组件只有半边能复用**。`AgentProviderIcon` 是纯的受控组件（吃 `providerId` + `size`，已 `aria-hidden`，各家真图标 + `Bot` 兜底），**可以**直接作为 agent 身份的画法。但 `AgentAvatar` **不能**原样复用：它是一枚 `<button>`，带 `onOpen` 跳转、`AgentDisplayState` 状态外描边、`AttentionCategory` 角标，语义是「Board 上可跳转的 Agent 行头像」，而且 `providerId` 是必填——人类没有 providerId，`AgentProviderIcon` 也没有「人」这一路。所以说话人头像组件要**按 role 分叉**（human 给人形/首字母，agent 复用 `AgentProviderIcon`），而 `{role, id}` 恰好是驱动这个分叉的正确入参：role 选画法，id 在 agent 支去 store 查 providerId。这也说明「两条轴共用同一套身份表示」是共用**身份表示**（那个 `{role,id}`），不是共用某个现成组件。
  - 已实测（2026-08-31）：**颜色在同 provider 的 A2A 下不足以区分身份，判别器必须是名字**。说话人色相由 id 派生（开放集不能用固定调色板，第四个身份就会撞色），派生本身是均匀的——10 万个真实形态 id（`randomUUID`，见 `client.ts` 的 `input.agentSessionId ?? randomUUID()`）落进 12 个 30° 桶各 8.2–8.5%。但**均匀恰恰意味着会撞**：这是生日问题，360 度环上取 n 点、要求两两相隔 ≥20°，撞的概率是 2 个身份 11%、3 个 30%、4 个 **52%**、6 个 86%（实测与闭式 `1-(1-n·thr/360)^(n-1)` 吻合）。换任何散列都一样，不是实现缺陷。而同 provider 的两个 Agent 画的是**同一枚品牌图标**，所以形状也不分。于是三个通道里两个失效，剩下的唯一判别器是**名字**（`aria-label` 与 hover 面板里的那个名字）。这条对接线有硬约束：**接线方必须为同一条对话里的多个 Agent 传入互相可分的名字**，不许把「两个 Agent 能不能认出来」押在颜色上。颜色是辅助（一眼扫过时的分组线索），名字才是身份。
  - 已实测（2026-08-31）：**派生色相必须让开语义色所占的弧**。状态色是**词汇**不是配色——amber 专表「需要你」、red 表失败、green 表成功、blue 表人类说话人。一个散列到 amber 附近的 Agent 会被读成"这个在等你"，而它只是名字碰巧落在那里；**身份色误报状态比两个 Agent 撞色更难查**（撞色你会去看名字，误报状态你会去点那个 Agent）。这条推理在人类身份上已经用过一次（人类固定取 blue、不派生，理由正是"派生结果可能撞语义色"），对 agent 一样成立，所以要兑现成代码而不是只写在人类那条注释里。判据：**由保留弧的补集取值**，不是"算出色相再往外推"——后者会把两侧的值都挤到弧的边缘，制造出人为聚簇，恰好破坏派生存在的理由；而且最暖的那个语义色（red 约 2°）的弧跨过 0°，"往外推"在那一段会直接算错（实测过一版：10.8% 的身份仍落在它附近）。让开半宽取 22°，略大于可分辨所需的 20°：目的不是"恰好不等于"，而是"不会被误读成"。实测结果 190/360 度可用，且是**三段而非四段**——red 与 amber 相距不到两倍半宽，两段禁区连成一整片暖色；想把半宽调小来省回这一片的人要先解释，为什么在两者之间劈出一条"同时离两个状态色都只有 20° 出头"的窄缝更好。色相取整数度：可分辨粒度远粗于 1°，小数位换不到任何一双眼睛能看见的东西。
  - 由此还有一条边界：**providerId 不进身份判定函数的返回**。它不回答「谁说的」，而是「这个身份怎么画」；用地址（`agentSessionId`）去 store 查它，正是上面「身份用于寻址与取头像」的字面兑现。把 providerId 塞进那个纯函数会逼它把 store 当入参——而 `AgentTimelineItem` 里根本没有 providerId，那等于让纯函数不再纯。
  - 另一条已查证的事实，用来校正用户报的那句「user 消息也会被收进 Agent 的历史」：用户 prompt 确实与该 Agent 的 `tool_call`/`assistant_message` 写在**同一条 per-session 时间轴**上（唯一收录点在 Core 的 launch/send 路径，`kind:'user_message'` 恒等价于 `source:'user'`，由单一生产者保证；`UserPromptSubmit` hook 刻意不重复收，已有测试守着）。但**没有**任何路径把它喂回 Agent 的 LLM 上下文——AgentTimeline 是观测投影，Agent 的真实对话历史在 provider 自己的 transcript 里。所以用户说的"不够优雅"是**呈现问题而非污染问题**：两个身份共用一种形状，读起来像被收进去了。修法在形状与身份表示，不在"把 user 消息从时间轴里摘出去"——摘出去会让用户失去"我上一句说了什么"这个最常用的定位锚。
- **Composer 在 TUI 投影下可收起成一枚悬浮按钮，在对话投影下始终展示**。用户原话：「在对话模式下始终展示，但在 TUI 模式下要能够支持收起，收起到一个小的悬浮按钮里面」。两种投影要的东西不同：对话投影里 Composer 就是主输入，收起等于把这个界面的用途拿掉；TUI 投影里用户是在直接和 CLI 的全屏界面打交道，此时固定占一条高度的 Composer 会挤掉正被阅读的终端内容。三条边界：
  - **收起只是隐藏，不是卸载**。草稿必须活过收起再展开——Composer 挂载点不变（同一 Region、同一 adapter），否则收起就成了一次静默的清空，与"切换投影时不能清空未发送草稿"是同一条约束。
  - **收起状态按 Region 记，且只在 TUI 投影下有意义**。切回对话投影时无条件展示，不去记忆"用户在对话模式下也收起过"——那是一个用户没法表达的状态。
  - **悬浮按钮要能表达有未发送草稿**。收起之后草稿不可见，若按钮只是一枚静态图标，用户会忘记自己写了一半——按钮需带上"有草稿"这一事实，否则收起就在制造丢失感。
- **Composer 要认 skill 与 slash 命令**。用户原话：「现在对话组件对 skill 的支持不太好」。今天的缺口是**整条链路都没有这个概念**：Composer 是一个纯 textarea，没有 `/` 触发、没有补全、没有发现；Core 的 timeline kind 是一个被校验器封住的闭集（`user_message | assistant_message | tool_call | permission | lifecycle`），没有 skill 的位置。于是一次 skill 调用要么根本不进 timeline，要么塌进一条**与任何别的工具无法区分**的 `tool_call`（同一枚 Hammer）。
  - **触发前缀由 Provider 声明，不在 Renderer 里按 providerId 分支**。各家 CLI 的前缀并不统一（有用 `/` 的，也有用 `$` 的），这正是既有 Provider 能力声明（posture、interaction 同处）该多一条的东西——与 permission option 的 DESCRIBE/CONTRIBUTE 拆分同构：声明半边跨 IPC 供 Renderer 渲染，兑现半边留在 Core。
  - **两个来源合并成一个选择器**：一份**手工维护的命令目录**（CLI 不提供任何机器可读的命令列表，这是事实约束，不是偷懒），加一份**磁盘发现的 skill**（扫 skill 根下 `SKILL.md` 的 frontmatter 取名字与描述）。前者是纯数据，可以自由生长。
  - **发送时按"行首 token"分流，且不得先 trim**。一句以空格开头的正文即便看着像命令也仍是正文——抢一条"已派发"的记号给一段从未派发的文本，是在制造假状态。这条与"不做输入队列"同源。
  - **一次派发在 timeline 里要看得出是派发**，既不是用户气泡，也不是一张完整工具卡。这需要 Core 侧动那个闭集（新增一个 kind 是**公共合同变更**，不是 Renderer 的自由），否则 Renderer 无论怎么画都是在给 `tool_call` 打补丁。
  - **有歧义就显示歧义，不替用户裁决**：一个名字同时是命令又是 skill、或来自多个来源时，标注出来交给 Agent 解析。参数是**自由文本**，不做 schema、不做发送前校验——参数语义归 CLI 所有，我们插入 token 加一个空格就收手。
  - **发现按 skill 真正运行的位置取值**，带明确超时与 Retry；**远端 host 下明确"不可用"而不是给一个空列表**——空列表说的是"这儿没有 skill"，那是假话。与 Editor 失败态的 Reveal 在远端**以缺席表达**是同一条规矩。
  - 未验证、动手前要先确认的一件事：**我们消费的 hook 里，一次 skill 到底以什么 toolName 到达**。这决定了 timeline 侧是"补一个 kind"还是"先得能认出它"。
- Composer 使用独立、受控、无 Store 依赖的可复用输入组件；Session adapter 负责草稿、当前文件、Submit 与 Interrupt 绑定，为附件和其他富输入能力保留唯一扩展面。
- Renderer 不根据 `working`、`waiting`、`blocked` 或 `done` 猜测 Prompt readiness。Core 拒绝提交时保留草稿供重试；semantic resume 和恢复动作继续由现有 Owner 负责。
- **运行中可 steer**：Agent 处于 `working` 时界面仍允许提交，补的那句话经**既有** send 通路（store.send → submitPrompt → Core.submitAgentPrompt）送出，与普通 prompt 同一条路——不新增 Renderer 侧第二条写通道。「界面是否允许提交」与「主动作是 Send 还是 ■」是两个不同问题：working 时前者为真而后者仍是 ■，一个跑动中的 Agent 既要能被补话也要能被叫停，二者不互斥。判定收敛为一个纯函数（`lib/composer-submit-mode.ts`），不读 Store、不按 providerId 分支。
  - 这**不是**"working 时提交一律送达"的承诺。能否送达仍由 Core 裁决：render-then-submit Provider（9 家里只有 codex）的 mid-turn steer 会被 Core fail-closed 拒绝，那是一等预期而非缺陷。被拒时草稿保留（这就是诚实的"没送出去"信号），且不产生任何 user 回合——Core 在记录回合之前就抛错。合同不得被改写成普遍送达承诺，那会与 codex 已封的 readiness 门自相矛盾，并诱导后人去削弱它。
  - pending interaction 期间**不允许** steer：待答请求期间卡片是唯一输入面（既有合同），Renderer 侧不提供提交、Core 侧亦抛 `AGENT_INTERACTION_PENDING`，双重保险。
  - 不做输入队列：下游 CLI 自带输入行，且就绪门控对 8/9 Provider 不可实现，排队只会制造一份界面以为已送达、进程并不知情的假状态。
- **终端要像终端：宿主不许悄悄改写按键与选择行为**。Agent 跑的是它自己的 TUI，用户练熟的是那套 TUI 的手感；我们只是宿主。宿主把某个键翻译错了，用户会以为是那个 CLI 坏了——这类缺陷最难归因，因为它在 CLI 自己的终端里复现不出来。而且**代价是双份的**：不像终端不仅让用户理解不了，也会推高我们自己的复杂度——每偏离一次，就要为这个偏离补一层解释、一处特例和一条它自己的回归，而照着终端既有的约定做，这些都不必存在。所以"像终端"是省复杂度的选择，不是额外的工。
  - **Shift+Enter 换行，不提交**。终端默认对 Enter 与 Shift+Enter 不可分辨（都送 `\r`），所以"分得开"必须由我们**显式**兑现：拦下这个键，在下游 TUI 已协商 kitty keyboard 协议时送 CSI-u 编码（`\x1b[13;2u`），否则退回 `\x1b\r`。协议是否生效要从该 TUI 自己的输出里**探测**，不能假定、更不能强开——强开会让没协商过的 TUI 收到一串它不认识的字节。
  - **能用鼠标选中并复制**。终端里的选中/复制是读日志、抄报错的基本动作：拖选走 xterm 原生选择，复制走一个只在有选中时才生效的修饰键和弦，右键前先快照选中（焦点转移会清空它）。
  - 这两条**易错且回归无声**，因此验收落在**送出的字节**与**剪贴板内容**这类可观察结果上，不是"某个 handler 存在"——断言 handler 注册过，在 handler 写错时同样会绿。
Desktop 刷新或重新 Attach 时优先投影这份 Agent 语义；新的 Run `running` 事实只更新进程态，不能覆盖 `working`、`waiting`、`blocked` 或 `done`。Run 退出或中断仍由进程事实结束当前可交互态。
- Approval/Question 卡片只渲染 Core 的 typed request，选择后只经 typed IPC 调用 Core 的 semantic response API。Renderer 不解析 `status.detail`，不发送裸 ESC、数字选项、普通 Prompt 或 raw PTY fallback。Run interruption 使用独立 typed reason 控制恢复分支，`status.detail` 只做人类可读展示。Permission request 携带 Provider **声明**的每一个 scoped option（allow-once、可选 allow-always、deny），与 launch option 同构地在紧邻 interaction protocol 处按 Provider 声明，沿用相同的 DESCRIBE/CONTRIBUTE 拆分：兑现某一行的按键（`input`）只留在 Core，DESCRIBE 半边（id/label/kind/description/tier）跨 IPC 供 Renderer 渲染；回复时按用户实际选中的 option 解析出它声明的按键，绝不固定发 '1'。只声明位置**稳定**的行——Claude 的三行提示（Yes / Yes 并不再询问该工具 / No）行 2 位置不变，故 Claude 诚实获得 live 的 allow-always；Codex 的中间行按命令/主机/文件动态出现和重排，故其 live 列表只保留 allow-once 与 deny，更激进的 auto/never 姿态由既有 launch option 在启动时提供。只有 codex 与 claude 走到这条 permission 管线（其余 Provider 为 `none` | `observe`）。当前 Question 只展示 Core 已验证的单题单选能力。
- 待处理 interaction 出现时，卡片成为当前 Agent 唯一用户输入面；Composer 保持挂载和草稿但禁用 Prompt，Agent Terminal 的键盘、粘贴和 capability reply 也停用，直到 request 被 Core 结算。卡片提交只有在 Provider delivery 与 Core settlement 完成后才显示成功；失败保留明确错误，不提前消失。`working` 时 Composer 的主动作是一枚 ■ 记号，它**中断当轮**并调用 Core semantic interrupt；Run 与 session 继续存活。**终止整个 Run/session 是另一个动作，位置在 Tabbar**（Run owner 的既有动作）。两者对象不同，不得合并、不得共用措辞：把 ■ 写成 "Stop" 会被读成"我会丢掉整个 session"，从而让用户不敢按一个本该轻量的动作。■ 的可访问名与 tooltip 都必须说的是"当前这一轮"。它的位置与权重不随 steer 改变，避免用户在 Agent 跑动中误按。启动姿态（sandbox/approval/permission-mode）只在 Launcher 一次性设定；Composer 上的 live permission 控制有且仅有两条诚实通路：其一是用更宽的 scope 回答挂在 agent-input-stack 上那张 pending request 卡片；其二是 Provider 声明了**可寻址**的 in-band posture 控件时（见下文 posture control），在 Composer 上直接切到某个具名 mode。两者都经 PTY-input 通道兑现运行中进程的自有 affordance——启动 argv flag 永不作为 live composer 开关出现，因为它对运行中的 PTY 进程静默 no-op。
- Composer 表面不使用描边，靠比所在 Region 高一档的 Surface 填充与顶部高光表达层级，不使用黑色填充或黑色投影；focus 由 `--focus-ring` 加一道 inset `--focus-line` 承担（详见密度合同的控件语言）。Approval/Question 卡片同样不用描边——原先的理由是"描边会与紧邻其下的 Composer 争夺同一条边界"，Composer 去掉描边后这条争夺已不存在，但卡片依旧靠实心 Surface 填充与 elevation 承载重量，并以一枚琥珀 STATUS 图标表达"需要注意"这一状态，也不用常驻的彩色边（accent 表达状态，不作装饰）。卡片内的动作是同一种等高按钮，图标与文字共享中轴；allow-once 是唯一实心品牌绿主操作（最安全的肯定动作才承载最重的分量，绝不让最宽 scope 的按钮成为主操作），scoped 升级为 secondary 并以一枚克制的 tier 圆点表达风险状态；deny/dismiss 分置一侧，Dismiss 是退出而非裁决并降为 ghost 权重。option 数≥2 个 allow 时，allow 采用 CLI 自身的竖排编号节奏，否则保持紧凑动作行。
- Composer 的附件与粘贴图片都产出**路径引用**，由 Agent 自行读取，Composer 不内联文件内容。这是运行时事实决定的：prompt 通道是有字节上限的纯文本，且当前没有 Provider 走 ACP，不存在把二进制送进模型上下文的通路。粘贴的图片由 Desktop main 落盘（渲染进程只提供字节，不指定写入位置与文件名），再以与附件相同的引用形式进入草稿。工作区内的路径写成相对路径，因为那才是 Agent 的工作目录能解析的形式。
- 引用当前打开文件的快捷方式只在确有打开文件时出现。它是快捷方式而非第二条附件通道，没有可引用对象时隐藏，不以禁用态占位。
- Terminal 使用 xterm 的真实字符网格、DPR 和 TUI 输入。没有 pending interaction 时，Agent Terminal 的 xterm TUI 输入与 Agent Composer 是同一 Agent 的两条明确输入路径；Raw Terminal 只保留 TUI 输入。
- **切回一个已经打开过的终端不得重放"Restoring terminal…"**。切 Tab 不是重新连接：一个已经 attach 上、字节已经在屏上的终端，切走再切回应当就在那儿。当前每次切换都闪一次恢复态，是因为非活动 Tab 的终端视图被卸载、xterm 实例被销毁，切回时从零重建并重放。修法在**保住实例**而不在加速重放：不可见的终端**保留其 xterm 实例与 attachment**，切换只改变可见性。据此有三条边界：**不可见的终端不做布局与渲染工作**（否则保实例换来的是持续开销）；**实例的存活边界是 Region 的存活边界**——Region 真的关掉时实例必须销毁，不建第二个绕过 Region 生命周期的缓存池；**恢复态只在真正需要重放时出现**（首次 attach、断连重连、replay gap），它仍是一个诚实信号，不能因为"看着烦"就删掉。
- **切回终端时，恢复工作必须让出渲染主线程并优先保持界面可操作**。保留的 xterm 实例在首次 attach、断连重连或 replay gap 时仍要按顺序重放 retained bytes，但重放必须以有界批次调度、批次之间让出宿主事件循环；不能把一个大 scrollback 变成一次不可抢占的 parser 工作。恢复期间输入门控可以如实保持关闭，直到 replay→live 边界完成，但切换、关闭、服务窗和其他界面操作不能被输出回放饿死；live backlog 也必须合并/有界，不得形成无穷串行写队列。这个约束只由 AgentMux Renderer 负责，ctxmux 继续是 replay 与 ordered bytes 的权威来源。
- **切回终端不得把用户的视口从顶部滚回到底部**。用户离开时若正在看最新输出，回切应继续停在最新输出并跟随后续输出；用户主动向上翻阅时，回切应恢复上次的滚动位置，不得强制跳到最新或展示一段从顶部滚下来的回放。首次建立、真正重建或没有可恢复的视口记忆时，默认直接显示最新输出；视口记忆属于该 TerminalView 的展示状态，不进入 ctxmux、Run 或 Session 真相。
- **RuntimeEvent 的边界不是终端的视觉帧**。TUI 输出可能被底层拆成很小的连续事件；TerminalView 必须在有界窗口内合并连续 live bytes 再交给 xterm，让一个 TUI 更新尽量一次绘制，同时在批次之间让出事件循环。不得为了追求响应而把每个字节逐事件写入、让用户看到逐字蹦出的假动画；也不得取消有界让出，令大段输出重新饿死切换、输入和关闭。
- **多个 Agent 的 terminal capability 探测互不阻塞**。每个 Run 的探测超时只允许把该 Session 标成 `unknown/degraded` 并继续提供 prompt；不能按 Session 串行等待十秒，导致后面的健康 Agent 一起等候或重复看到 capability failure。探测可以并发，但每个探测的 attach、超时、退出和降级事件必须绑定精确 Run，不能扩大到共享连接或其他 Session。
- Terminal 链接只在手势确实是**点击**时才响应：指针位移超过阈值或留下选区，都判定为选择文本而非点击链接——拖选跨过链接不得触发打开。悬停显示目标与打开方式，锚定位置永不遮挡它所描述的那一行链接。链接分两类，共用同一套手势守卫与悬停预览：http(s) URL 由 web-links 拥有，Cmd（非 macOS 为 Ctrl）+ 点击直接在系统浏览器打开，普通点击走目标选择菜单；文件路径由一个独立 link provider 拥有，普通点击在编辑器 Region 打开该文件。
- Terminal 文件路径识别是**纯语法、保守**的：检测在 xterm 渲染/悬停热路径上运行，只做字符串工作——读 xterm 已持有的那一行 buffer 文本并用纯函数匹配，热路径上没有磁盘或 IPC，更不做存在性探测。规则的关键判据是「core 含 `/` 或带 `:line` 后缀」，据此丢弃裸词（`e.g.`、`1.2.3`、`README`）却仍捕获 `README.md:3:1` 与真实相对/绝对路径；绝对路径仅当落在活动 Workspace 根内才识别，`~/`、逃出根的相对路径不识别。识别出的路径归一为 Workspace 相对路径，交给与 Explorer 同一个 `openFile` seam 打开；带 `:line[:col]` 时通过一次性 reveal target 落到该行。误报或不存在的路径在点击打开时经 reportError 明确失败，绝不静默——「点击开不出来」而非污染状态。相对路径按 Workspace 根解析（非终端 live cwd）。
- **Activity 里 Markdown 引用到的项目内文件同样可点开，走的必须是同一个 seam**。用户原话：「在对话中的 Markdown 解析中，如果有些引用的是项目内的文件，点击时要支持打开（就像在文件系统中点击的一样），同时在文件导航中也要指向并打开该文件」。这句话有两半，第二半是关键：**"在文件导航中指向并打开"不是要新写的第二个功能，而是复用既有 `openFile` 的自然结果**——`openFile` 会更新该 Workspace 的 last active file，Explorer 据此自动展开祖先、选中并滚动到该行（与 Terminal 点击路径、Explorer 自身打开文件完全同一条通路）。反过来说：任何"就地开个 Tab"的手写实现都会**静默丢掉用户明确要的第二半**，而且丢得没有任何报错。这就是此处只许复用、不许另起一条的全部理由。
  - **归一化与根内约束复用 Terminal 那份纯函数**，不写第二套路径解析。判据、拒绝规则（裸词、`~/`、逃出 Workspace 根的相对路径、根外绝对路径）与 `:line[:col]` 的一次性 reveal 全部同源；两处若各有一份，会在"什么算路径"上无声漂移，而漂移时误判只表现为"这个链接点不动"，没人会报。
  - **分流点只有一个**：一个引用要么是 http(s)（既有 `openExternal`，Main 裁决 scheme），要么是 Workspace 内的文件（`openFile`）。**今天所有 Markdown link 一律送进 `openExternal`**，于是 `[x](./src/x.ts)` 会被丢给系统浏览器——这是现状的缺口，不是新增能力的边角。分流写成纯函数，不在渲染组件里分支。
  - **要认的主要不是 Markdown link，而是行内 code 与正文里的裸路径**。Agent 写路径时几乎不写成 `[](…)`，写的是 `` `src/foo.ts` `` 或直接散在句子里；只处理 link 语法等于对真实输出基本不生效。这决定了识别落在 inline 节点上而非只看 `href`。
  - **注入而非 import**，与既有 `openExternal` 同形。`AgentMarkdown` 是无 Store 依赖的纯组件，直接 import Store 或 api 会让每个渲染回合的测试都要先记得 mock——那个坑已经付过一次调试代价。
  - 验收落在**可观察结果**上：给定一段 Markdown，分流函数对哪些 token 判为文件、判成什么归一路径。断言"某个 handler 挂上了"在 handler 写错时同样会绿（测试栈是 `renderToStaticMarkup`，本就跑不了 effect、点不动 DOM），所以载荷逻辑必须是 `lib/` 里的纯函数。
- Terminal 主题只属于 Desktop Renderer。ctxmux、RunSpec 和 Core 公共合同不出现主题字段。
- Renderer 负责把最新 `cols × rows` 通过 Core 公共 Resize 提交给 ctxmux；resize 热路径只保留一个在途请求和一个最新 pending size。
- Replay、Live、Gap、ACK 与 Attachment lease 均服从 ctxmux/Core 的 ordered-byte 合同，View 不建立补偿状态机。

### Durable Runtime 健康

- **打开 Terminal 不得被一次瞬态 WAL checkpoint 争用永久阻断**。ctxmux 是 WAL、SQLite durable state 与 persistence actor 的唯一 Owner；AgentMux 只消费它公开的可用性结果，不在 Desktop 另建 checkpoint、截断或修复逻辑。
- **可恢复的 busy 不是永久失败**。当 WAL checkpoint 因短暂 reader/attachment 争用未能归零时，ctxmux 必须在有界窗口内重试并继续 FIFO 写入；一次可恢复的 busy 不得把 persistence actor 锁存在 `durable state rejected`，也不得让后续 Terminal 创建或 semantic resume 永久失败。
- **真正的数据完整性或不变量失败仍需 fail closed**。无法确认 WAL 已安全回收、SQLite 报告 corruption、磁盘空间不足或 checkpoint 在有界窗口内持续失败时，界面要保留原投影并给出可操作的服务窗告示；不得静默丢掉 Run、Session 或布局，也不得手工删除/截断用户状态。
- **健康边界必须可观测**。ctxmux 对外给出可区分的 recovered、busy-retry-exhausted、disk-full 与 corruption 结果；Desktop 的 Terminal/Resume 入口沿用同一结果分类，不把所有底层错误折叠成“Agent resume unavailable”。
- **持久化故障回归必须是隔离注入，而不是破坏宿主**。测试在临时 state-dir 中注入一次可控的 SQLite I/O 失败，验证 mutation 的失败分类、后续写入的边界以及 daemon 重启后的恢复；不得填满宿主磁盘、触碰用户 runtime、杀掉宿主应用或把测试故障伪装成真实用户数据损坏。
- **ctxmux 的 daemon、CLI、SDK 与 manifest 必须作为同一个精确 artifact 升级**。协议代际变化由 ctxmux SDK 在 Core 私有适配边界解码，Desktop 与 Core 公共 API 继续只看 ordered bytes；不得只替换 binary、混用不同 protocol 的 SDK，或为了保留旧代际在 AgentMux 维护私有 backport/兼容层。

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
- **Board 工具的次级面板是工作清单，不是说明页**。它列出当前 Board 的行与行内 Agent，可展开、可点击定位——用户来这里是找一条具体的工作线，不是读一段介绍 Board 是什么的文案。图例式的静态说明只在没有任何行时作为空态出现。清单的行与 Agent 状态点复用共享状态语汇，不发明第二套。**行必须与 Board 主视图同源**：一份行来源分叉（Scratch 出 Topic 行、Git 项目出 Branch 行）、一份排序，由 `useBoardRows` 持有，两处都调它。让面板自己再查一遍 topics/branches，就等于给"这个 Board 有哪些行"开第二份答案——两处会在筛选、排序、加载时序上各自漂移，而漂移时谁都不会响。行数超出时其余折叠为可展开的一条，不无限撑长也不截断丢弃。守护：`surface-tool-dock.test.tsx`。
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

### Provider 能力对齐与移植边界

- a mature workbench 只提供对照证据，不是 AgentMux 的第二份 Provider 注册表。每个 AgentMux Provider 必须以真实可执行文件与真实运行回执为准，分别声明 launch、ready、Hook、permission、status、resume 与 reply-correlation 能力；未核实的能力保持未声明，不用 UI 对称性或终端字节推断补齐。
- 现有 Provider 的 parity 工作按能力闭环推进：Grok 与 Gemini 若二进制支持 native resume，就必须同时接通可信 native handle、resume argv、managed Hook 与事件字段归一化；Pi 的 resume 与扩展部署是两件事，不能只做 locator；Claude、Hermes、Cursor 的事件/信任细节分别按各自 CLI 合同接入。Cursor 没有 native resume 时必须明确保持 unsupported，不伪造恢复入口。
- Hook 入口同时接受厂商的 camelCase 与 snake_case 字段，但在 Core 内收敛到同一 canonical event；`sessionId` 等 provider-native handle 只能由对应 Provider 解释，不能由 ctxmux 或 Desktop 猜测。流程探测或 Hook 安装失败属于非阻断降级，必须在服务窗说明当前状态与恢复动作。
- a mature workbench 中尚未纳入的 Agent 分成三类：具备完整 Hook/session/resume 证据的优先纳入；只有 status/Hook 的按实际需要纳入；只有 launch 配置或宿主专属 wrapper 的明确记录为暂不纳入。TraeX (`traex`) 与 a mature workbench Trae (`traecli`) 是两个不同 Provider，不得合并身份。
- 所有 Provider、Agent Session、Hook 与 semantic resume 逻辑归 `packages/core`；ctxmux 只持有 Run、PTY、ordered bytes、Replay、Gap、Attachment 与进程事实。Provider parity 不得在 ctxmux 复制第二套实现。

## 自举：在 AgentMux 里开一个 Agent 优化 AgentMux

用户原话：「在 AgentMax 里面提供方便调试 AgentMax、并且能获取相关信息的基础设施，方便它自举」「我希望能在 AgentMax 里面开一个 Agent 去优化 AgentMax 本身。这就需要它有方法能够快速操作 AgentMax，而不是仅仅通过 Computer Use 去点击；而且在它操作之后，AgentMax 的一些相关元信息和截图也要能给它看，用来加速」「这个对代码架构的挑战可能会相对比较高，需要深思熟虑」。

拆成三件事，其中只有前两件是新的：

- **快速操作**：已有 Control 协议（`packages/core/src/control.ts`，schema v5）覆盖 inspect/open/send/focus/arrange/list/interrupt/resume/stop，Agent 通过 socket 发结构化请求，本来就不必点。**缺的不是通道，是可观测性**——Agent 发完一个请求，只拿到一张 receipt，看不到界面变成了什么样。
- **回看结果**：操作之后要能拿到 AgentMux 自己的元信息与截图。这是新增的能力，也是架构风险最高的一件。
- **不做的**：不为自举新开第二条控制通道。Control 协议已经是 Owner 边界上唯一的入口，再加一条"调试专用"的路，等于让 AgentMux 有两套关于"现在是什么状态"的说法。

三条硬边界，逐条都有它防的具体坏事：

- **观测走 Control 协议自己的 operation，不新建旁路**。新增的是 `inspect.*` 家族里的成员（截图、元信息），复用同一套 caller 校验、同一套错误码、同一份 receipt 形状。旁路会绕开 caller 身份校验——一个 Agent 就能观测另一个 Agent 的界面。
- **截图是 Desktop Main 的职责，且必须标注它拍到的是什么时刻**。原生窗口能力只有 Main 持有（见 Owner 边界表）。一张不带 `observedAt` 与目标 region 身份的截图，会让 Agent 拿一张操作前的旧图去判断操作成功了——**这比不给图更糟**，按原则 11，宁可如实说"这一刻抓不到"。
- **元信息只投影既有真相，不为自举新建注册表**。布局树、Session 投影、Region 绑定都已经有唯一 Owner；观测接口读它们，绝不另存一份"给 Agent 看的状态"——两份状态一定会分叉，而分叉时 Agent 会照着错的那份改代码。
- **自举 Agent 不享有特权**。它和任何 Agent 走同一套授权：能做什么由它启动时固定的 launch option 决定。一个"因为它在优化我们自己所以放开限制"的后门，是这个功能唯一真正危险的失败模式。



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
