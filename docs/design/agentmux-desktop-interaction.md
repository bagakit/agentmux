# AgentMux Desktop 交互设计合同

## 左下角导航、Space 与 Goals

用户确认：「把这一排页签切换的按钮改成这个顺序，然后把它们放到最左下角」。窗口只有一组主导航，固定顺序为 **Mote、Space、Focus、Goals、Survey**，在所有主工作面及 Project Rail 开合状态下都位于窗口左下角。

- **Mote** 是固定协调对象的快捷入口：打开或收起同一快捷面，保留当前主工作面的选中状态和执行焦点。Mote 排第一不意味着启动默认进入 Mote；启动仍恢复用户上一次工作面。PMO 是其初始化默认角色之一，产品身份见《Space、Folder 与 Topic》。
- **Space** 是实际工作现场，承载既有 Agent、Terminal、文件、Browser、Tab 与 Region；顶级入口、说明和可访问名称使用 Space。Space 作为更外层产品对象及其 Folder/Topic 两类定义见《Space、Folder 与 Topic》；Workspace 继续表达底层工作区对象。
- **Focus** 查看执行状态、最近上下文与需要用户处理的事项；进入已有 Session 时继续复用原 Tab/Region。
- **Goals** 是全局目标集合，单项显示为 Goal。标题、创建、搜索、详情、清单和统计使用同一名称；待澄清的想法可以先作为 Goal 记录，再由 PMO 补齐目标与完成标准。Demand 仍是持久化实体与控制协议身份，Goal 状态与执行 Session 状态独立。
- **Survey** 用于浏览与查证，打开网页后进入 Space 的既有 Browser 工作面。

用户进一步要求：「PMO 和其他的拆开，只有 PMO 自己高点吧；设置干脆放进这组按钮」。PMO 作为独立协调入口，和 Space、Focus、Goals、Survey 及设置组分开；设置接在 Survey 后，打开既有设置面，不改变当前工作面选中状态和执行焦点。快捷键帮助仍位于窗口右侧，状态摘要位于其前。窄窗口保留全部入口与需要用户处理的状态，长摘要可以收紧，控件不能重叠或被裁掉；这些规则不依赖 Project Rail 是否可见。底栏高度与局部尺寸约束只定义在密度 SSOT《左下角导航与右下角工具组》。

## 主题切换与样式真值

- App chrome 的主题只有一个运行时入口：根文档的 `data-appearance` 属性。设置、系统偏好与启动恢复都
  通过同一入口生效；组件不得各自保存一份主题真值。
- 主题值与语义映射属于 Surface SSOT，见
  [Surface 与密度合同《主题与样式 SSOT 规范》](./agentmux-surface-density.md#主题与样式-ssot-规范)。
- Monaco 编辑器跟随 resolved App appearance；Terminal 继续使用独立的 Terminal palette。切换 App appearance
  不得改变 Session、Run、Layout 或 Terminal palette 的持久化事实。
- 未来的 utility CSS 或共享 primitives 只能消费语义 token；切换主题不能改变 Session、Run、Layout 或
  其他产品事实，也不能为同一事实创建第二套状态。

> 当前确认的导航、Tab、分屏和会话栏需求见
> [`agentmux-project-rail-navigation.md`](../plans/agentmux-project-rail-navigation.md)。
> Scratch 的 Topic 与 Wiki 合同见
> [`agentmux-wiki-first-scratch.md`](../plans/agentmux-wiki-first-scratch.md)。

### Topic 点击必须打开可见 Tabs

- 用户点击 Topic 后，右侧必须显示该 Topic 已有的 Tabs、Region 和焦点；不能只改后台选中项而让工作面留在 Board 或 Agents。
- 已有持久化工作面应先可见；读取 Topic 元数据的流程不能挡住已存在 Tabs。文件读取失败必须明确展示，不能清空 Tabs 或另建 Session。
- Leader Topic 浮层的后台准备不能抢普通 Topic 的导航焦点，也不能重复挂载其他 Topic 的终端；重启后保留原工作面。

### Scratch Topic 首次打开必须有可用 Terminal

- 点击一个没有已绑定 Tab/Region 的 Scratch Topic 后，右侧必须进入该 Topic 的 Workbench，并在原来的落点启动一个 Terminal；只创建 Launcher 或只改变选中 Topic 都不算打开成功。
- 已有该 Topic 工作面的点击仍只聚焦并复用原 Tab、Region 和 Session，不重复启动 Terminal；后台准备的固定 Topic 仍可显式要求不抢当前工作面。
- Terminal 启动过程沿用统一的 launching/loading 反馈；启动失败必须保留 Topic 的可见工作面并显示原因与可重试动作，不能留下空白 Region。
- Topic 列表行和 Board 行的标题、摘要与主要内容区都必须可点击，并走同一条 Scratch Topic 导航；只有复制、定位、头像和右键菜单等独立动作阻止事件冒泡，不能让用户必须命中一个隐藏或孤立的小图标。

### Scratch 的交互与组织

用户确认：「每件事情自成 wiki 并记录 agent 铭牌，能力非常强大，但是当前的交互和组织，还是多少有点混乱」。Scratch 必须保留每件事情独立的 Wiki、资料、产出与 Agent 铭牌；改进交互和组织时不能丢失这套耐久上下文。

用户必须能清楚辨认当前在处理哪件事情、在哪里继续工作，以及资料、产出和参与 Agent 的归属。事情的存在与参与者铭牌不能依赖 Tab 是否打开；铭牌表达参与身份与耐久记忆，当前运行状态仍消费 Core 的权威事实。

Scratch 不再承担与其他工作上下文分离的一套产品组织方式。用户从「Scratch 放进 Projects 作为默认 Project」进一步提出更外层的 Space 抽象，当前产品对象方向见《Space、Folder 与 Topic》。

### Agent Region 关闭与身份入口

- 用户反馈：「右上角 Conversation history 好像占关闭位置，与画面中间按钮重复；这个位置应显示 Agent 名字和功能菜单」。首先必须恢复 Region 的基本关闭能力：多 Region 时，原 Region 关闭按钮始终可见、可点击且键盘可达；Terminal、显式 History、待恢复记录与流程告示都不能遮挡它的完整命中区。Tab 关闭成功不能代替 Region 关闭验收。
- History 只保留一个应用入口，使用现有记录阅读与返回 owner，不争用关闭位置。中间的 `Full-screen history` 是 TerminalView 的阅读边界状态告示，不是第二个手动入口，须保留其诚实边界。CLI 原生画面不冒充另一应用按钮，也不能靠遮盖正文掩饰重复内容 owner。
- Region 的完整方向是紧凑的 Agent 语义显示名与既有功能菜单，关闭保持在固定、可发现的位置；名称使用现有 Session 身份事实，不新增状态或厂商分支。关闭遮挡修复可独立交付，不等待完整 Header 编排。
- 关闭继续走现有精确 Tab/Region、未保存确认与资源处理 owner；同一 Session 的视图切换、History、冷态内联记录及服务窗不另建 Terminal、Session 或 Run。正常与恢复状态、窄分屏、记录面和进程重启后都保持这一合同；无关 Session 不产生额外处理。

### Agent 输入行与视图切换

- Agent 输入区的顶部行同时承担“这是哪个 Agent/Session”和“当前工作面是什么”的定位职责。主名称使用用户为该 Agent 设置的显示名（例如 `/name` 的结果），旁边以弱化元信息显示 Executor/Provider 与可辨认的 Session 标识；长文本必须截断，完整值放在 tooltip 与可访问名称中。
- Terminal 与 Activity 只保留一个紧凑的图标切换按钮。按钮的图标、tooltip 和可访问名称说明点击后将进入的视图；切换沿用同一个 Session 的 `viewMode`，不创建第二个 Terminal、Activity 或 Session。
- Scratch Topic 点击的成功条件是右侧存在可见的 Tab、Region 和内容面。若布局、会话或启动流程暂时不可用，原位置保留可操作的加载/失败表面与重试动作；不得以空白工作面表示正在加载或失败。

## 设计哲学

- AgentMux 是 Agent-first、terminal-first 的桌面 Client。Agent 状态、用户输入、终端输出和恢复动作必须靠近它们影响的 View。
- 同一信息只在最合适的位置显示一次。Tab 拥有会话名称和状态；低频 ID、Host 和时间进入 tooltip 或 context menu；Activity 拥有最近消息。
- 界面层级由 Surface、明度、局部高光和紧凑密度建立，不靠连续边框、重复标题或极小字号制造“专业感”。
- 选择、键盘、拖拽、菜单和可访问性交互使用维护中的成熟依赖与平台模式。
- Desktop 只组合 Core 的公共能力。所有 Agent 生命周期都经过 `packages/core`；所有 PTY、进程、Run、Replay 和 Attachment 事实都由 ctxmux 持有。

### AgentMux 自操作与 Computer Use 边界

- Agent 操作 AgentMux 自身时，必须使用 AgentMux 自有的 typed Control 协议与语义 CLI；`inspect`、`list`、`open`、`send`、`focus`、`arrange`、Demand/PMO 操作都走同一条 Control owner。不得通过截图、坐标点击、macOS Accessibility 或其他通用 Computer Use 旁路完成本产品已有的操作。
- AgentMux 的产品运行、Session/Run 生命周期、Board/PMO 管理和发布验收不得把外部 Computer Use 工具作为前置条件。外部工具不可用、权限过期或观察失败时，保留产品自身的真实状态并给出诊断，不得阻断健康 Agent。
- 内嵌 Browser 的网页操作继续使用已有 CDP/Browser Control；它是页面语义通道，不是 macOS 辅助功能，也不复制一套桌面自动化 Runtime。
- 用户确认：「agentmux 应该有自己的 computer use 方案」。AgentMux 应向 Agent 提供自己拥有的 Computer Use 能力入口与真实执行反馈，用于桌面观察和操作；这是一条独立需求，不能把开发者临时调用外部工具算成已经交付。
- AgentMux 的 Computer Use 与已有自操作 Control、Browser CDP 各有清晰职责：已有产品语义操作仍走其现有 owner；系统桌面能力的实际执行属于 Desktop／平台适配边界，不把 Electron、系统窗口或辅助功能实现带入无 UI 的 Core，也不复制 Agent／Run 生命周期。
- 桌面权限缺失、目标窗口消失或操作失败必须如实反馈，不能冒充成功；该能力不可用不能阻断健康 Agent 的输入、启动与恢复。外部桌面自动化工具仍可用于独立开发验收，但不是产品启动或发布的前置条件。

### 打包、安装与启动事实

- 候选包在签名、身份和安装前启动验证任一步失败时，保留旧的 canonical 安装并明确报告失败阶段，不能把旧包或半成品误报为最新版。
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
- **发布入口只有一条**。开发启动、`pnpm build` 生成的 `apps/desktop/out`、DMG
  挂载目录和任意临时/旧 `.app` 都不是可安装事实；只有同一次 clean build 产生的
  `release/mac/AgentMux.app` 才能进入安装动作。安装完成后，重启必须从
  `~/Applications/AgentMux.app` 这条 canonical path 发起，并能把运行进程的真实
  executable path 与 bundle 内 `package-identity.json` 对上；无法对上时应报告
  “启动了其他副本”，而不是把它解释成代码回滚。
- **旧副本要显式可见**。打包/安装报告必须列出 canonical App、`/Applications`、开发
  缓存 App 以及当前运行实例中发现的同名副本和身份。检测只负责告警，不得把用户的
  Session、Run、Application Support 或工作区数据当作旧包一起删除；清理 App 本身也
  必须是可恢复的 Trash 移动或经用户确认的动作。
- **打包报告本身必须可运行且可行动**。`report:package` 只能读取本次真实构建输出；如果
  候选不存在、构建输出不完整或路径不对，必须用一条简洁诊断说清缺少的路径和下一步命令，
  不能把 Node 的 `ENOENT` 栈直接当成用户反馈，也不能把报告失败解释成安装副本健康。
  clean-build/package smoke 必须覆盖这条失败边界。
- **功能来源也要能追溯**。发布审计对关键用户能力记录“设计约束 → 生产实现 → 测试
  调用者”三段证据；删除一个实现文件时，审计必须能指出替代实现和仍在生产路径上的
  调用者，或明确标记为待人工复核。单元测试仍不足以证明功能没有被并发 Agent 从产品
  路径上扫掉。
- **打包失败不能阻断已安装的健康版本**。构建、签名或验证失败时，保留现有安装，
  明确报告失败阶段与候选来源；只有验证通过的候选才允许替换活动副本。
- **这是一条发布边界，不新增运行时事实**。安装路径、候选身份和报告属于打包工具的
  事实；Desktop Runtime 仍只有 Core/ctxmux 的既有 Owner，不在应用内复制一份
  Session、Run 或布局状态。
- **Renderer 只能消费 Core 的 node-free 子路径**。需要运行时常量（例如 Provider id
  集合）时，必须从明确的 node-free export 读取；不能从 Core 根桶把 Node-only 的
  进程、文件系统或网络实现拖进浏览器 bundle。打包 Gate 将 Renderer 构建失败视为
  候选不可发布，而不是用 externalize 或缓存产物掩盖它。
- **候选必须包含主进程和预加载脚本运行时导入的全部生产依赖**。开发环境能启动不能
  代替安装包启动验收；缺依赖的候选必须在替换 canonical 安装前失败并指出缺少的运行时，
  完整候选须由 LaunchServices 实际启动并通过就绪检查。

### 全页加载与启动大屏

- 电脑重启后的启动预热与工作面恢复必须在启动大屏上持续显示当前真实阶段和已知进度；用户能看出是在读取持久工作面、连接 Runtime、恢复 Session，还是恢复其它工作面。没有可证明的总量时显示阶段，不编造百分比。启动大屏应先于耗时恢复出现，阶段变化时更新，完成后才让出工作面。
- 界面已经加载、Agent 仍可能健康时，预热或恢复步骤超过固定等待时间不能被判成“更新界面未就绪”并退出应用。保留已恢复的 Tab、Region、焦点和 Session 引用；可继续工作时进入工作面并以服务窗说明未完成的步骤、当前可用状态及恢复动作。只有界面本身无法加载或进程确实不可用，才显示相应的真实启动失败。
- 启动失败文案必须对应实际失败阶段；已发生恢复或持久化写入时，不得声称“停止前没有写入任何数据”。
- AgentMux 启动、重启恢复和任何覆盖整个工作面的加载阶段都使用同一个可复用的 `FullPageLoadingSurface` 语义组件；调用方只提供阶段、短说明和可选恢复动作，不各自造一套 spinner、空白页或品牌动画。
- Terminal 的 Restoring 也属于覆盖整个 Region 的恢复阶段，必须直接使用 `FullPageLoadingSurface` 的 `scope="region"` / `phase="recovering"`；恢复事实、输出重放、缺口和服务窗仍由 TerminalView 持有，组件不复制终端状态。
- Browser 恢复和 Agent Terminal attach 同样使用这套 Region 级 loading/recovering 表面；恢复期间保留原 Tab/Region，完成后卸载加载层，失败由原有错误/服务窗承接。
- 大屏动画是非阻断的过程提示：它必须说明当前阶段和已知的下一步，不能把 Provider 探测、恢复握手或页面加载失败伪装成终局错误。底层 Agent/Session 仍健康时，加载提示停在旁边或允许进入可用工作面。
- 动画结束后保留真实工作面状态；加载层不能清空 durable Tab、Region、焦点、草稿或 Session 引用。组件只提供 failed 阶段的告示骨架，持久失败由调用方接入既有服务窗并给出恢复动作，只有 Core 的终局事实允许移除投影。
- 动效要尊重系统减少动态效果设置；降级为静态大屏构图时仍保留阶段、Executor/Provider 身份和可访问文本。动画不得依赖具体站点、Provider 文案或不可复用的启动路径。

## 产品对象

### Space、Folder 与 Topic

用户提出：「沿用 Space 的定义的话，那么这里我们可以拓展为两类 Space 定义，一类就是 Project（或者就叫 Folder），另一类就是 Topic，他们的特点不一样」，并确认这里要表达「一个更外层的抽象概念：space」。Space 是 Folder/Project 与 Topic 共用的外层产品概念；两类 Space 的组织特点必须可辨认，不能因为共用入口而抹平差异。用户补充：「topic 和一般 folders 虽然底层行为一致，但视觉上还是区分开，目标是好懂好找」；共同工作能力不变，树中使用可读分组、类型图标和父子层级帮助定位。Folder/Project 的最终显示名称尚未确定。

- Folder/Project 类围绕已有目录组织工作。Project 可以由普通目录承载，Git 能力按真实仓库事实提供；不因采用 Space 概念就要求目录使用 Topic 的 Wiki 脚手架。
- Topic 类围绕一件事情组织工作，保留独立 Wiki、资料、产出与 Agent 铭牌。Topic 的存在与耐久内容不依赖 Agent 或 Tab 是否仍打开。
- 两类 Space 共用既有 Agent、Terminal、Browser、文件与 Tab/Region 工作能力，遵守同一重启恢复与健康 Session 保留合同。Space 不复制 Core 的 Session/Agent 状态或 ctxmux 的 Run 事实，启动继续恢复用户上次工作面。

用户进一步要求：「在 space 树里他们显示不太一样，比如 topic 会自动根据规则去读 topic.md 来显示，且 topic 会自动识别和显示，不用手动绑定」，树上的 `+` 提供 `Open Folder As a Project` 与 `Create Another Topic` 两类入口。

- Space 树对 Folder/Project 与 Topic 使用各自适合的内容来源。Folder/Project 表达打开的目录与实际项目事实；Topic 按识别规则自动发现，从该目录的 `topic.md` 读取人类可读标题、摘要等显示信息。Topic 不要求用户手动注册或绑定，发现与显示不依赖当前 Tab、Region 或 Session。
- 用户进一步确认：「所有 Topic 默认就是 Space 树的一个默认一级节点，ICON 特殊；在 space 树中，每个 TOPIC 是其一个子节点」，并要求保留已经 polish 过的 Topics 列表页。Space 树默认提供一个用特殊图标识别的 Topics 一级节点，各 Topic 在其下自动显示为子节点；Topics 一级节点保留现有总览列表入口，树与列表使用同一 Topic 集合、选中与工作面事实。总览页的视觉与控件约束只定义在 surface-density《Project Rail 与 Topic 行密度》。
- 用户要求优化 Space 左侧树的交互体验。Mote、Topics 与 Folders 在同一导航滚动区内保持可达，顶部创建和密度动作留在固定标题行；展开与收起只改变树的显示，不启动、停止或替换 Session。长标题可通过 hover 信息和可访问名称读全；名称打开对象，折叠动作与 Mote 人格编辑各自有完整命中区，键盘操作能清楚看到当前焦点。窄栏与短窗口继续保留原对象、选中、折叠和工作面事实。对齐、缩进及视觉节奏只定义在 surface-density《Project Rail 与 Topic 行密度》。
- 用户继续反馈：「现在继续优化左边树结构，当下显然没有达到顶尖水准」。树需要承担快速找 Space、辨认当前位置和继续操作的完整导航职责。就地查找只筛选已知的 Mote、Topic 和 Folder 名称、摘要、路径及 Host，不扫描磁盘、不启动 Agent；匹配项的祖先临时可见，清除查找后还原用户原有折叠与滚动位置。无结果必须明确可恢复，不能表现为对象被删除。键盘可沿当前可见对象连续移动、到达首尾、展开或收起分组，Enter 打开明确聚焦的对象；移动焦点本身不改变工作面。Topic 的 pin 等既有事实、原总览入口和 Folder 导航身份继续共用原 owner。状态摘要优先展示需要用户处理的情况，完整分类与准确数量仍在同一入口的提示、无障碍名称与展开面中可读；收敛常驻信息不能把未知当作正常，或隐藏待回答与错误。视觉层级与信息预算只定义在密度 SSOT 同节。
- 树上的 `+` 必须明确区分打开已有目录与创建新 Topic。打开目录进入 Folder/Project；创建 Topic 形成独立的持久目录与 Wiki、资料、产出、Agent 铭牌结构，创建后自动可见可进入。
- 显示信息读取失败属于流程状态：保留已有 Space 与工作面，在对应条目或服务窗明确说明问题。一个 Topic 的读取失败不能隐藏其他健康 Topic，也不能清空其已有 Tab/Region 或停止健康 Agent。

用户进一步提出把 PMO Agent 这样的特殊 Topic 赋予特定类型，体验参考 muse 或 OpenAI dot，并明确：「这种 Agent 其实非常类似 Topic 的逻辑，和普通 folder 共享一套 space 管理逻辑，但是有自己的特殊预制」。

- PMO 等特殊 Agent 以带预制的 Topic 组织，复用 Topic 的耐久目录、Wiki、资料、产出与铭牌，以及 Folder/Topic 共用的 Space 管理能力。预制负责特殊身份、默认上下文与产品入口，不建立另一套 Space、Topic、Agent 或 Run 生命周期。
- 特殊 Agent 的入口、Space 树条目与已有工作面必须指向同一个持久 Space；打开、收起、恢复或切换入口不创建第二个 Topic 或 Session。现有 PMO 的身份、职责和执行焦点约束继续见《PMO teams topic 名称与职责》与《执行 Agent 焦点历史与 PMO 上下文隔离》。
- 普通 Topic 不继承特殊预制的角色。特殊身份属于产品预制，与执行它的 Provider/Executor 区分；实际 Agent Session 仍通过 Core 的公开能力启动与恢复。
- 用户补充：「现在 mote 的图标太过制式，一看就是 AI 生成，应该生成一个更有质感的 icon svg」，并希望项目其他地方用于表示 AI 的同类图标「都换掉」。Mote 的持久产品身份使用独立矢量标记；新建工作面、技能和权限动作按各自含义表达，不能把所有 AI 相关入口都替换成 Mote 身份。Provider 官方标识与真实运行状态继续沿原 owner；具体字形、尺寸与替换范围只定义在密度 SSOT《控件语言》。
- 用户确认：「每个 PMO 都有全局负责的能力，如果不是这样，用 topic 就够了」。这一类带持久人格的产品对象具有跨 Folder/Topic 全局负责的能力；其职责不被自身 Topic 目录或当前选中 Space 限定。用户同时确认「稳定身份和 session 不绑定」：产品身份在没有运行 Session、Session 结束、更换或恢复时仍然存在，不能用某一次 Session 的身份代替持久角色身份。

用户进一步明确：「就像 topic 创建时会带有知识管理结构，这种 agent 创建的时候可以带有 soul，甚至可以是 topic 的超集（当前 PMO Team 其实就是这么设计）」，随后澄清：「我说的 soul 是类似 openclaw 和 hermes 的 SOUL.md」。Agent Space 可以作为 Topic 的超集：保留 Topic 的知识管理与协作者结构，创建时额外带有具体可读、可编辑的 `SOUL.md` 等特殊预制。`SOUL.md` 表达这位 Agent 的持久人格、价值取向、沟通方式与行为边界，和当前执行它的 Session、Run、Provider/Executor 身份区分；更换或恢复执行会话不能把这些耐久内容丢掉，也不能用模板覆盖用户已经编辑的内容。

用户确认：「topic 就是在按照 topic 的知识管理来，Agent 的话让他自己决定」。普通 Topic 沿用已有知识管理结构；这类持久角色自行决定如何组织和维护自己的知识，产品提供创建预制和可读、可编辑的文件，不额外强制统一的记忆分类、文件集合或维护流程。`SOUL.md` 仍承载持久人格；已有 Wiki、资料、产出、铭牌和用户编辑内容继续保全，Session/Run 的权威事实仍由原 owner 持有。

PMO Team 是这种 Agent Space 的已有产品实例，继续复用原固定 Topic、Wiki、角色说明与工作面。`SOUL.md` 属于耐久上下文，不能覆盖用户当前指令、既有授权与 Core/ctxmux 的权威事实，也不能把设定了长期职责伪装成已经启动或完成了后台执行。文件存在与执行会话实际加载是两件事：启动、恢复和文件编辑后的生效情况必须按真实执行能力表达，不能仅因预制了文件就声称已加载，也不能为一个 Space 修改其他 Agent 的全局人格。加载方式与更新时机遵守本节下文的新会话与恢复约束。

用户要求：「创建一个 feature-tracker 专门来做这个迭代吧，包括现在左下角的 PMO Teams 头像的交互，也可以借这次想的更加明白一些」。本轮迭代覆盖 Space 的统一组织、Topic 自动发现与创建、带 `SOUL.md` 的特殊预制，以及左下角现有 PMO Teams 头像与同一 Space 的交互关系。头像快捷入口、Space 树条目和完整工作面必须指向同一持久对象；讨论要明确点击、展开、收起、切换与原工作面焦点的关系。用户随后确认「现在可以始终指向 PMO」：本轮底部入口固定指向现有协调对象，不随当前 Space 自动换对象。快捷面、人格编辑入口与完整 Space 的往返遵守本节下文的确认；现行职责、焦点隔离与恢复约束继续成立。

用户进一步要求：「这个 Agent 在我们项目里最好有个不容易重复的名字」，并强调「Agent 毕竟太通用了」，随后明确「PMO 这名字也不好，得换一个，只是在初始化这类 Agent 的时候，默认角色中包含 PMO」。在比较并撤回 Giu 后，用户最终明确：「就用 mote 吧？」。这类有稳定身份、SOUL.md 和全局负责能力的持久产品对象统一叫 **Mote**，Space 树、创建入口和固定快捷入口采用同一含义；PMO 是初始化默认角色之一。命名不改变耐久目录、持久对象、Core Session 或 ctxmux Run 身份。候选历史只保留在 brainstorm 记录中，不作为当前产品文案。

用户要求「继续，彻底完成推进」。本次按以上确认落实完整迭代，不再停在提案：Space 树把默认 Topics 节点与 Folder/Project、Mote 放在同一导航面；Topics 子项和现有总览同源，Mote 使用独立的预制身份标识。默认 Topic 收纳目录仍是既有目录，文件和工作面身份保持连续；Topic 的发现规则只读取该目录的直接 Topic 子目录，不扫描无关项目或全盘。

- Space 的 `+` 提供 Open Folder As a Project、Create Another Topic 和 Create Mote；从任意当前 Space 创建 Topic/Mote 都进入其持久目录，不要求先切到默认 Topics。
- Mote 创建时提供可编辑的 SOUL.md 和默认 PMO 角色；普通 Topic 不继承人格。一个目录中的 SOUL.md 是该目录具有持久人格的文件事实，和有没有运行 Session 分开。Topic 的知识基础继续保留，Mote 自行组织后续知识。
- 左下角默认 Mote 仍打开已有协调对象的快捷面；入口的展开状态独立于 Working / Needs you 等真实 Session 状态，无障碍名称与描述可辨；树条目进入该对象的完整工作面。快捷面可打开完整 Space，完整面可编辑同一 SOUL.md。两条入口复用既有 Tab/Region/Session，不因面板开合新建对象；关闭快捷面恢复原执行上下文，进入完整 Space 则保留明确选择的新目标。同一 Mote 有多个会话时，快捷面与重启恢复保留已有目标 Tab 和 Mote 焦点，不能仅因它排在列表前面就换到另一个会话；浮层的目标选择不改写原主工作面的选中。
- 新 Mote 从没有运行 Session 的可用启动面开始，不凭打开或创建预制启动额外 Terminal。普通 Topic 的首次 Terminal 规则继续成立。
- SOUL.md 的内容在新执行会话启动时作为该 Mote 的人格上下文实际传入 Core；恢复已有会话保留其原上下文和持久目录。正在运行的会话不因文件保存而声称已热更新；文件编辑入口明确说明新会话使用更新后的内容。读取失败应给出可见原因，原目录、工作面和健康 Session 保留。
- Topic 升级成角色、复制、归档和自定义头像是此前 Agent 提出的额外设想，不是本轮已确认需求。

### Agents / Session / Board 与注意力闭环

- 主导航的入口、顺序、位置和名称见《左下角导航、Space 与 Goals》；顶行不重复平级导航，Session 表示工作面中的 Agent/Terminal 生命周期。
- Agents 是全局注意力收件箱：先显示 Needs you，再显示工作中、已完成和错误的 Agent；卡片选中后在同屏右侧显示该 Session 的观察工作区，明确的“打开 Session”动作才导航到原工作台。Needs you 的 typed request 从同一详情区进入既有回答面板，不能在这里复制一份 Session 或 Runtime 状态。
- Session 是具体 Agent Session 的 terminal/workbench；Agent 的请求、回复和恢复动作在同一 Session 内完成，处理后仍留在原 Session。
- Board 的主实体是 Demand。Demand 卡片第一层显示 Demand ID、Project 和状态，关联 Session 只作为执行事实；没有选中 Demand 时不渲染 DemandWorkspace，也不保留空右栏。
- 一个决定完成后，Agents 面要能把用户带到同一 Session 的结果审查入口：已有 Diff 或 Browser preview 可直接打开，缺少结果时明确显示“等待结果”，不得用猜测替代 Runtime 事实。
- 单工作面保持连续全宽。只有真实存在多个 Region 时才使用 arrangement；不能因为没有详情而把内容视觉上推到左侧、保留空右栏或播放方向性重排动画。
- 进程重启先恢复 durable 的面、Tab、Region 与焦点，再尝试 reattach/resume Session。恢复探测、握手或 Provider 流程失败时保留原工作面并显示服务窗提醒；只有 Core 的终局事实允许移除投影。

### Project 与 Workspace

- 导航围绕 Space 的工作上下文组织；Folder/Project 与 Topic 两类的产品归属见《Space、Folder 与 Topic》。当前 Project Rail 负责选择工作上下文、显示紧凑状态和进入 Settings/Hosts。
- Project Rail 的 `Projects` 只是分组标签，不是页面标题：它必须使用低于项目行标题的元信息层级，弱化字重与字距，不抢项目名称的注意力。
- **选中和运行是两件独立的事实**。选中项目只用中性的整行 Surface 与 `aria-current` 表达；项目下存在处于 Board `working` 列（`starting`/`running`/`working`）的 Agent 时，在该行的独立尾部状态槽显示运行标记。这个标记对所有有运行中 Agent 的项目都显示，不能因为项目未选中而隐藏，也不能因为项目选中而变亮。运行标记必须复用 `sessionBoardColumn` 的判定，不维护第二份 Session 状态。
- **“活着”和“正在产出”分开说**。`running` 表示进程可用但当前回合安静，只在 Project/Scratch 行显示为 muted 的 `idle` 数量；`starting`/`working` 才进入行内的 `Agent is working` 文案。独立的运行标记仍覆盖整个 Board working 列，让健康但安静的 Session 可被找到，却不能让同一 Agent 同时读成 working 和 idle。
- **Project tree 的行尾状态统一为小图标 + 数字。** idle、running/working 与 error 都占同一枚紧凑状态槽，数字表示该 Project 的对应 Session 数量；图标形状和语义色区分状态，不能让某一类变成一段长文案或另一种尺寸的徽章。没有数量时不占位，tooltip/读屏补充完整状态名称。
- **每个 Project 行行首显示这个项目自己的图标**。前提变了才改的：这条原先写的是"普通 Project 行不显示每行都相同的文件夹图标，行首留白"——那句在**每一行都是同一枚文件夹**时是对的（一列全同的图标不是信息，见密度合同《控件语言》「一列全同的图标」）。一旦主进程能从项目仓库里探到各自真实的图标文件（favicon、app icon 等），这一列就有了区分度：`agentmux` 与 `avatars` 各顶自己的标识，用户一眼认出哪行是哪个。此时**文件夹/仓库 glyph 退化成"未知"态**——只在探不到图标时兜底，而不再是唯一态。兜底必须是**统一的文件夹/仓库 glyph**，不用 name-derived 色点、不留空：实测用户 10 个项目只有 4 个有图标，混排留空会让左缘参差。图标只表达身份，不模拟运行状态（运行仍走独立尾部状态槽）。Scratch 仍用它自己的品牌图标。
- **多个 Project 之间的位置关系要看得见，用一种优雅的 UI 交互形式来展示**。用户原话：「假设两个 projects 在同一个目录下，就在界面中显示它们的分组」「如果某个 project 是在另一个 project 目录结构的子结构里面，就自然地把这两个排列到一起，并且把处于子目录的 project 向前缩进，形成一个树结构」。判据如下：
  - **分组的键是「同 host + 共同父目录」**，不是路径字面相同。`~/proj/agentmux` 与 `~/proj/bagakit` 归到 `~/proj` 一组；远程 host 上的 `~/proj` 与本机 `~/proj` **不同组**——路径字符串一样不代表是同一个地方，跨 host 混排会让用户点错机器。
  - **真嵌套才缩进**：一个 Project 位于另一个 Project 的目录内时，两者相邻排列、子项向前缩进成树。
  - **判断"在里面"必须按路径段边界，不能用裸字符串前缀**。`…/bagakit/agentmux-preview` 以 `…/bagakit/agentmux` 开头，但它不在 `agentmux` 里面，是它的兄弟。比较前给祖先补上分隔符（`ancestor + '/'`）才是"位于其目录内"。同理，一个 Project 嵌在多个 Project 里时**认最深的那个祖先**做父节点——挂到更浅的祖先上会让中间那层凭空消失。
  - **单例不成组**。一个分组里只有一个顶层 Project 时不显示分组头，它直接平铺。分组头的价值在于表达"这几个是一伙的"，只领一个成员时它不携带信息，只是又一行占位——与《控件语言》「一列全同的图标不是信息」同一条理由。实测用户真实的 10 个 Project 会派生出 6 个共同父目录，其中 4 个是单例：不设这条，一半的项目会各自顶着一个只领一人的标题。**数的是顶层成员，不是节点总数**：一个独苗项目底下挂着一串嵌套子项目时，那些子孙并不在这个父目录里（它们的归属由缩进表达），分组头同样只领一个成员。
  - **分组头不是可选中的行**。它是分组标签（`Projects` 那一档的元信息层级），不承担选中、不显示计数、不接收点击——它不是一个 Project，点它没有任何东西可以被激活。
  - **worktree 不进这棵树**。`defaultWorktreePath` 把 worktree 放在 `<repo>/.worktrees/<branch>`，它天然是子目录，但它已经是所属 Project 的一个 Workspace（在 Project 内部展开）。按路径包含关系再把它变成一个子节点，同一个东西就有了两套嵌套，用户无从判断该点哪个。**归属只有一种表达**：worktree 归它的 repo，树只表达 Project 之间的真实嵌套。
- 这里只是**呈现**变了。分组与缩进都从既有的 `WorkspaceRecord.path`/`hostId` 派生，不新增第二份 Project 注册表，也不把层级写进配置——路径是唯一真相，用户在磁盘上移动了目录，这棵树就该跟着变。
- 左侧 Project Rail 的项目行支持“从侧栏移除视图”。这只撤销该 Project 的 Workspace 注册与导航入口，不删除磁盘目录、文件、布局、Session 或正在运行的 Agent；移除当前项目后应落到仍可用的 Scratch/其他 Project，并保留 Runtime 中未被停止的事实。
- 当已登记的本地 Workspace 目录被移动、导致 Explorer 报 `Could not read workspace` 时，错误面必须提供“选择新目录/重设路径”出口。重设更新原 Workspace 的路径并保留 Workspace id、Session 归属与已有工作面；取消选择或选择失败不应清空原记录。仅把失败重试留给用户是不完整的恢复路径。
- 有分组头时，分组成员整体比未分组项目多一层轻微缩进；成员之间的真实嵌套在此基础上继续增加缩进。分组头仍是标签而不是项目行，不能与成员落在同一条左缘，也不能因此新增持久化层级。
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
- **Topic 行必须能看懂它的工作面结构。** presence 组件在一行内给出该 Topic 当前可见的 Tab 数量；hover 时显示每个 Tab 的顺序/标题、Region 的分屏结构，以及每个 Region 当前绑定的 Executor。每个 Region 的摘要必须能定位到对应 Tab，不把多个 Tab 的内容压成一个无法操作的总数。
- **Region hover 要回答“最近在做什么”。** Agent Region 使用最近一条可读的用户/Agent活动摘要；没有可读摘要时明确显示 `No recent activity`，不能编造或用 Session id 冒充工作内容。摘要来源复用已有 timeline/first prompt 投影，Topic 行只负责呈现，不维护第二份活动状态。
- Topic presence 的 Tab/Region 结构由一个可复用组件渲染，Branch/Topic 等同形列表只注入数据与定位动作；组件必须保留键盘可达的等价信息，hover 只是加速阅读，不是唯一入口。
- Topic presence 的交付态以真实工作面投影为准：打开 Tab 的 Agent 身份嵌在对应 Region 结构中，健康但未挂载到可见 Region 的后台 Agent 保留在同一行，已结束 Agent 不占用在场名额；Tab 顺序、Region 边界、Executor、最近活动与焦点状态都来自现有 Workspace/Session/Timeline 事实，不创建第二份布局或 Session 状态。
- **旧配置的 Executor 身份不能丢**。头像设置迁移到 Executor 后，旧 `Appearance` 中按 Executor ID 保存的 tint/badge 仍先显示在对应模板与所有头像簇/Tab 标记中；用户明确点击 Reset 才写入一个空的 Executor 覆盖，不能静默删除旧记录或把它误认成默认 Provider。
- Project Rail 与 Workspace Tools 分别开关，不能共享状态或互相改变布局身份。

### Agent 自助创建与空间操作

- **自定义 Executor 与内置 Executor 走同一创建路径**。用户说“应该要可以开出来，且也有完整的元信息”。发现结果必须区分用户名称和稳定 Executor ID，并以当前配置为准；按名称指定时，唯一名称可解析到稳定 ID，重名须返回候选而不猜。未找到名称不能被描述为“这个 Provider 不支持自定义 Agent”，也不能擅自用默认 Executor 代替用户选中的配置。
- **元信息足以发现、启动和核验同一个 Agent**：创建前可见 Executor ID、名称、Provider 与目标 Host 的探测状态；创建后可关联 Session、Run、Host、Workspace、View、Region 和能力。Session/Run/能力来自 Core，布局坐标来自布局 Owner；配置里的环境值与凭据不是发现元信息。未探测、探测失败与确认缺失必须可区分，不把“未探测”说成“不能启动”。
- **“在右边新开一个”不是“查找右边已有的”**。旁边已有 Agent 不满足新建请求，也不构成空间已满。Tab 条相邻只表达导航关系，不能被当作当前 View 中可见的分屏占用；空间判断取同一次 View 几何与内容快照，不按 Tab 标题、列表次序或树深度猜。
- **技能中的空间原则保持简短、通用**：先看当前视图，优先复用符合方向意图的空位；需要拆分时，选择能让新旧内容都清晰可用且扰动最小的区域；保留现有工作，完成后核对实际落点。由 Agent 根据可见空间决定具体拆哪格，不枚举窄/宽/左右的特例，不要求面积相等；用户明确给定的目标与方向优先。
- **成功以提交后的实际归属为准**。创建、拆分、移动与重排不能用过时计划的 Tab/Region 身份宣称成功；源、目标、树叶、内容索引和焦点必须一致。异步创建期间布局变化不得覆盖较新的布局；Agent 已经健康启动但展示目标失效时，保留其 Session 可发现性并明确说明当前落点或未展示状态，不因为布局流程失败停止它。
- **独立布局包必须是真正的唯一实现**。通用树结构、几何、方向、分割、移动和不变量属于可独立使用、无 React/Electron/Agent 依赖的布局包；Desktop 用它的公开 API 绑定内容、渲染与持久化。Workspace 的 Tab Group 树与 View 的 Region 树保持不同身份，复用同一套布局代数；不把 Session、Provider 或 Run 生命周期装进布局包，也不在 Desktop 保留第二份树实现。是否完成以独立包消费验证和产品调用为准。

### 少一步操作

- **能一下解决的，就不要让用户多点一下。** 顶部 Split 和同类仅用于展开选项的下拉入口，鼠标悬停即显示菜单，选择动作只需点击一次；不要求先点开再点选。悬停本身只展示选项，不执行命令。
- 指针从触发器移进菜单（包括间隙与子菜单）时菜单保持可用，离开后收起；禁用入口不展开。悬停不抢走编辑器或终端的输入焦点，Escape、外部点击和选择后正常关闭；点击、键盘与触屏仍能完整操作。同一时刻只显示正在使用的菜单。
- 直接执行的按钮仍直接执行；右键菜单、编辑弹窗与需要确认的动作不改成悬停执行。悬停菜单继续使用既有原生 Browser 让位与资源订阅的开关，不留隐藏遮挡或后台采样。

### Tab、Tab Group 与 Region

- `View` 是用户认知里的一张完整工作视图，在 Desktop 中表现为一个 Tab。
- `Tab Group` 用来整理整张 View；移动 Tab 不改变 View 内部内容布局。
- `Region` 是 View 内的内容 leaf，可展示 Agent、Terminal、File、Browser 或 Launcher。
- `split-left|right|up|down` 只修改当前 View 的 Region 树；`placement=tab` 只在用户明确要求时创建新 View。
- Workspace 保存 Tab Group 树，每个 View 保存自己的 Region 树。两个树使用不同 ID、焦点、resize 状态和操作入口。
- **眼前的分屏比例必须与已保存布局一致。** 用户或公开 Control 追加、重排及改变分屏比例后，已打开的原 Region 立即按同一布局显示；不能只写持久树、等重启才变成真实尺寸。拖动仍由原分隔条表达当前意图，不被过时投影拉回。同步尺寸保留 Tab、Group、Region、焦点、原内容实例与健康 Run；普通重启在同窗口尺寸与字体条件下恢复同一最终比例和终端网格。
- **应用重启必须先恢复持久化的 Tab Group/Region 拓扑，再恢复其中的 Session 投影**。Tab、分组、Region、焦点和 split ratio 是用户工作面的 durable 索引，不能因为 Runtime 首次快照暂时为空、恢复探测超时或恢复流程报错而被写回空布局；健康 Agent 的流程故障只留下可见服务窗告示并保留原 Region。只有 Core 明确报告 Session 已退休，才能移除该 Region。
- **恢复不能把旧进程的生命周期租约当成仍在运行**。启动新进程时必须回收 owner PID 已退出、租约已过期或属于本次重启的未完成 lifecycle reservation；只有能证明旧 owner 仍活着的租约才报告“运行在其他进程”。判断不清时保留 Session/Region，并明确提示正在等待归属核验，不得静默丢失或伪造新 Session。
- **退役 Run 记满了，不能把整次启动判死。** 用户原话：「刚才打包以后启动就失败了」。新进程回收未完成的停止租约时，必须把这次停止落进账本：该 Session 记成用户退役，它的 Run 进入有上限的退役 Run 环。环满时丢掉最旧的 Run，并同时丢掉只指向这些 Run 的退役 Session——这是容量到顶，不是账本损坏。刚刚停下的这条 Session 的退役记录必须留下。不得因为挤掉了旧记录就让停止落账失败、整窗退出。同一身份仍在当前 Session 里，才是真冲突，继续拒绝。
- **界面就绪握手只证明新页面已挂上。** 用户原话：重启电脑后还是报 `Updated interface did not become ready`。打包启动要等渲染进程回报就绪，这个回报只表示页面已加载且 IPC 可用。恢复 Session、重绘终端这些启动工作在握手之后继续。不得把「全部恢复跑完」当作启动放行条件；恢复慢或超时走服务窗，不整窗退出。
- **关闭当前格、按序号切 Tab、分屏、切换焦点格都必须能纯键盘完成**，不该只有鼠标一条路。窗口级只补这四个高价值动作，**不建 action catalog、不做用户改键**——那是预防性抽象，与"最简实现"相悖。键位跟随成熟终端/编辑器的既有惯例而非自创：关闭当前 Region 用平台的关闭键（mac `Cmd+W`／其他平台 `Ctrl+Shift+W`），按序号切 Tab 用 `Cmd/Ctrl+1..9`（第 9 键恒指最后一张），分屏用 mac `Cmd+D`（右）/`Cmd+Shift+D`（下）、其他平台 `Ctrl+Shift+E`（右）/`Ctrl+Shift+O`（下），切换焦点格用 `Cmd/Ctrl+Alt+方向键`。**平台底线：非 macOS 绝不接管裸 `Ctrl+字母`**——那些是 shell/readline 的地盘（`Ctrl+W` 删词、`Ctrl+D` 是 EOF），接管会让用户在终端里丢掉肌肉记忆；数字与 `Ctrl+Alt+方向` 不落在 readline 键上，可安全使用。新键位不得与终端作用域键（`Cmd+F/C/K`、`Shift+Enter`）冲突，冲突判断按键位比对、不靠猜。判定与落点解析写成纯函数、组件只做注册与 `preventDefault`（本仓库 `renderToStaticMarkup` 不跑 effect，写进组件的分支断言够不着）；只测判定不够，**必须有接线测试**——删掉注册调用要让断言变红。焦点格的"相邻"按屏幕几何（Region 归一化 bounds）判定，不按分屏树的父子深度，与上文「哪个算右边」同一处轴向定义。

### 单格临时铺满 Tab 后还原

- 用户读终端或 diff 时，可把当前一格临时铺满所在 Tab 的内容区，再恢复原分屏；其他 Tab Group 和窗口工具区不受影响。只有一格的 Tab 不提供无意义的铺满动作。
- 原分屏树、比例、Region 身份和内容保持原样，铺满不是关掉其他格或重新打开终端。未保存文件、草稿、历史、Session 与 Run 仍归原 owner；隐藏格不可交互，并沿既有可见性约束暂停原生表面及尺寸同步，不把零尺寸写给健康 PTY。
- 铺满跟随该 Tab 的现有焦点，不再保存另一份目标或旧焦点。切到另一格时它成为铺满格；还原保留当前焦点。铺满期间方向导航仍按原分屏几何定位；显式新增、删除、换位、重排或拖动比例先退出铺满。
- 原树、比例、焦点与铺满状态一起耐久保存；普通重启后先恢复工作面，再接回原 Session/Run。变成单格时不保留无意义的铺满状态，未知 Runtime 事实不能删原 Region。
- 按钮、Region 右键菜单、既有快捷键入口和 typed Control 表达同一操作。inspect 区分原布局几何与 Tab 内当前呈现几何：铺满格占整 Tab，隐藏格当前 bounds 为 null；null 只表示在该 Tab 内隐藏，不表示 Region/Session 不存在。布局结构缩略图明确展示原结构。
- 局部显示或尺寸握手失败留下范围明确的服务窗，健康 Agent 仍能输入；铺满/还原不启动、恢复、停止或替换 Run。

### Session、Run 与 View

- 当 Agent 正等待 typed interaction 时，Composer 的普通 Prompt 保持有界 steer 排队，不能当作权限或问题的回答。用户在原生终端明确输入的按键仍可送达健康 Run；待答观察不能禁用该入口，原生输入也不能冒充 typed 回答成功、清除请求或扩大权限。界面保留真实待答事实与原生入口；无法确认是否已处理时显示待核实。队列在 Provider 能接受时按序自动投递，也可手动重试原队列，保留文字与投递原因。队列满时拒绝新入队并保留输入草稿，不淘汰旧条目、不静默丢字。
- **发送路径与排队路径只能有一个用户草稿归属**。一次发送若已被 Desktop 接收入队、但 Provider 暂时未消费，队列条目就是这段文字的唯一待投递副本；失败反馈必须说明“已保留、会重试”，不能再把同一段文字留在输入框里诱导用户再次入队。只有队列拒绝接收（例如超过 Core 的 prompt 上限）时，文字才继续留在草稿中。用户点“立即发送”只重试原条目并复用原关联 id，不复制条目。
- **整块消息交互必须低熵、自收敛、职责清楚**。Renderer 只拥有草稿、队列意图与可见反馈，Core 拥有投递与幂等，ctxmux 拥有字节受据；手动与自动消费共享一个入口。同一 Session 同时只投递一个条目，每次投递前读取当前队列与 Session，删除尚未开始的条目立即生效；已在途时如实显示无法撤回。旧 Run 的条目保留供复制但不阻塞新 Run；快照恢复、连接恢复和 readiness 变化必须能重新推进队列，普通输出和其他 Session 的事件不得制造重试洪水。临时拒绝保持可见且安静，自动路径不弹全局错误；不能以叠加防御、厂商特例或第二份状态机替代 owner 修复。
- Branch 行与 Topic 行都展示对应工作线的 recap，沿用同一份 Board 行摘要来源，不复制状态管线。

- Agent Session 是 Provider 语义身份；Run 是 ctxmux 进程身份；View/Region 是 Desktop 展示身份。
- 一个 Session 可以没有 View，也可以投影到多个 View。关闭 Tab 内的 Region 只改变该 View 的内容布局；关闭承载某个 Session 最后一个 Region 的完整 View 时，Terminal 直接停止 Run，Agent 默认停止并二次确认，同时明确提供保留 Session 的选项。
- **关不掉必须有下文，不能没反应。** 用户原话「经常出现 session 关不掉」。关闭要等 Runtime 收尾，而这一等**必须有上限**：等不到回音时，那是我们的握手没走通（原则 11 第 2 类），不是这个 Agent 坏了。超时之后不许把用户卡在原地——要么让这次关闭落地，要么把「哪一步没走通、现在按什么状态在跑、怎么恢复」写进服务窗。**沉默不是可接受的结果**：点了关闭什么都没发生，用户无从判断是慢、是卡住、还是自己没点中。
- **一次没关成，不能让关闭按钮从此失效。** 关闭进行中会占一把租约防止重入，这把租约**必须在任何结局下释放**——成功、失败、超时都算结局。一个永不落地的等待会把租约永久扣住，于是之后每一次点击都被静默吞掉：用户看到的是「这个 Tab 现在连反应都没有了」，而这比第一次没关掉更糟，因为它连重试这条路都堵死了。
- **告诉用户「再关一次」，那条路就必须真的走得通。** 停止是终局动作，不与 resize/attach/detach 这些改附着状态的操作共用串行队列：那条队列保护的是中间态不被穿插，而停止没有需要被保护的中间态，同一个 Run 停两次对 Runtime 是幂等的。反过来它必须能插队——卡住队首的往往正是上一次没回执的停止，让重试排在它后面，等于把恢复动作也一起卡死。附着在**决定停止的那一刻**作废，不等 Runtime 回话。
- **“把这个 Agent 挪到另一个 Tab”必须移动，不能偷偷复制一份视图。** 用户反馈“分屏里加载的 Agent 在 Tab 上又加载了一次”：搬动后原分屏不再保留被搬走的 Region，其他 Region、Session/Run 身份和正在执行的工作保持不变。GUI 与 Agent 控制入口必须能明确表达同一搬移动作；打开已有 Session 的额外投影不等于移动，不得把新增投影的回执报告成“已移动”。多 View 投影能力仍按上一条保留。
- **投影可以被显式移动到另一个 Workspace 的 View**，这只搬动展示身份、不动 Agent 事实。cwd 归 Core（`session.workspacePath`，一个已在运行的进程的工作目录），移动**绝不改变** `session.workspacePath`——没有任何通道能让运行中的进程改换工作目录，所以移动后这条 Session 的 Tab **仍**如实显示它自己的工作目录（cwd），不冒用目标 Workspace 的磁盘路径或名字。移动是用户按 Region 显式发起的（Tab 菜单选目标 Workspace），落点复用既有的 selectSession 导航；新建 worktree **绝不**把任何 Session 的投影**自动移动**过去，创建 worktree 与移动投影是两个独立动作。
- Desktop 持久化的是**展示身份**，不复制 PTY、Replay、Agent 状态或进程生命周期。**布局恢复与 Session 恢复必须分开看待**：布局是 Renderer 的展示事实，Session 身份与 Provider-native resume token 是 Core 的语义事实；任何一侧失败都不能把另一侧静默删掉。
  - **判据是「这一面有没有可在冷启动复活的身份」，不是「它属于哪一类面」**。Agent/Terminal 面持久化 Session/Run 落在哪张 View 的哪个 Region；**文件面同样持久化，含它的路径原样**——一个文件面只有 `{regionId, kind, workspaceId, path}`，没有运行时内容可剥，而它的 Tab id 本就是 `file:<workspaceId>:<path>`，所以「存这一面」与「存这个路径」是同一件事，分不开。把文件面剥掉曾经让一个纯文件 Tab 整个消失、让 agent+文件的分屏塌成单面，这正是用户报的「重启后 tab 和分屏没了」。
  - **Browser 面反过来整面不持久化**。它内嵌活体页面快照（url/title/navigationId 全是必填的运行时事实），浏览历史与文件路径是两类不同的敏感度；更关键的是冷启动**没有**一条能把持久化的 browser 结构复活成可用空白页的生命周期，硬存一个结构标识只会 ship 一个死面板。**以缺席表达，而不是画一个打不开的面**。
  - **持久化了一个面，就必须有人在冷启动把它的内容装上**。文件面能存下来只是一半：若启动恢复不去加载那份文档，Tab 在、编辑器却报「不可用」——这比整个 Tab 消失更难诊断，因为看起来像文件坏了。**凡是新增一类可持久化的面，都要同时指明它冷启动时的加载入口**；没有加载入口的持久化是半成品，不许上线。
- **重新打开项目要无缝接回原来的工作面**。切换 Workspace/Project 只是改变可见投影，不能销毁仍在使用中的 Workbench、xterm 实例或 ctxmux attachment；回到项目时应直接看到离开前的终端画面，不再闪 `Restoring terminal…`，也不因为 replay 起点变化把用户误导成“历史丢了”。真正发生 replay gap 时仍需显示 gap 的诚实提示，但项目切换本身不得制造 gap。
- **应用重启与机器重启都先恢复布局，再恢复语义 Session**。启动时以持久化布局为索引；健康 Run 自动接回，已结束或丢失的 Run 是否立即续接按《冷启动按需恢复》执行。用户不需要先点 `Resume` 才能看到原工作面和可读记录。恢复成功沿用原 View/Region，Run id 可以变化但 Session id 不变。
- **resume/重新 attach 的画面必须按 Runtime 确认的几何恢复**。ctxmux 持有 `current_size`；Desktop 必须把 attach 时的尺寸交给终端，并在 retained replay 与启动期间缓冲的 pending 输出全部写完之前保持解析几何稳定，不能让 RAF/ResizeObserver 在中途改变行列数。两段输出交接完成后再按当前可见 Region 同步尺寸；交接失败或 Run 不可控制也必须解除本地几何锁；需要重画时走既有 redraw。未知尺寸必须如实提示并尝试可见视口同步，不能用未知尺寸阻断健康 Agent，也不能把初始尺寸当成确认事实。当前尺寸不保证历史上每段字节的原始几何，回放缺口与历史局限仍如实表达。 首次视口同步失败不能撤销持续同步意图或首次重绘义务；下一次正常视口观察必须还能重试，不添加轮询。失败以服务窗持续可见，Runtime 确认后撤下相应告示，不阻断健康 Agent。
- **运行期保存也必须经过宿主持久化边界**。布局、焦点、草稿和待发消息在界面里读到最新值，不等于强制退出后下一进程还能读到。真实工作面变更聚合后必须提交给现有宿主存储机制，不能只等正常退出；状态事件、读操作与相同持久化值不增加提交。提交失败要在服务窗说明“当前保存未确认”和下一次真实变更的重试动作，不阻断健康 Agent；平台的 void 提交请求不能表述为 fsync 成功，可靠性结论须绑定无测试额外提交的真实隔离重启输入。
- **重启恢复必须使用同一个持久化根目录**。Renderer 的 Workbench 布局与 Core 的 Agent Session store 都绑定 Electron `app.getPath('userData')`；开发启动、打包 App、DMG 安装副本不得各自生成一份 store。启动恢复前若发现路径身份不一致，必须保留原布局并在服务窗说明实际路径，不能把空 store 当成“没有 Session”。
- **Session store 的陈旧锁不能把新 Agent 永久挡在门外**。写入锁带有可验证的 owner；owner 已退出时锁可回收。若锁文件为空、截断或 owner 身份无法验证，也不得把它当成永远存活的 owner：在确认没有对应活进程后应回收并继续写入；仍能确认 owner 存活时必须保留锁。一次锁清理失败只在服务窗/诊断面说明，不能删除 Session、布局或 ctxmux 的私有状态。
- **Session store 的高频读取不能反过来饿死生命周期写入**。列举/恢复等只读加载不得为了孤立 Timeline 清理而长期占用写锁；清理是可抢救的旁路，遇到短暂争用应让出。新建、恢复和停止等生命周期写入必须在同一份 store 上排队并保留可观测的有限重试；只有重试预算耗尽后才报告 `AGENT_SESSION_STORE_BUSY`，不能把正常的多 Agent 活跃状态误报成永久失败。
- **启动探测失败不能遮住已保存的工作面**。配置、Session snapshot 或 Provider capability 的单项 Host/runtime 失败时，Renderer 仍必须先提交已恢复的布局与可见 Region，再把失败作为作用域明确的服务窗/状态行呈现；只有布局本身无法读取时才进入无布局错误态。一次暂时不可达的 Host 不得让整个窗口回到空白 loading，也不得覆盖最后一份可恢复布局。若 snapshot 未能确认 Session 身份，原 Region 先保留为“待 Runtime 校验”的投影；下一次权威 snapshot 到达后再按已知缺失或匹配结果收敛，不能用空 snapshot 静默裁剪它。
- **配置升级不得把用户登记的 Host 静默变没**。版本升级时每个可读的 authored Host 都必须原样保留；本机 `local` 是运行时默认项，不能用它的回填掩盖 authored Host 全部不可读的情况。若所有 authored Host 记录都无法解析，必须保留原文件并给出确定性拒绝，而不是启动一个只剩 `local` 的新配置。该判断必须有 focused regression，且验证命令在打包前可单独运行。
- **未知 Session 的保留必须有收敛出口**。上述待校验投影只适用于 snapshot 尚未给出权威事实的窗口期；后续权威 snapshot 必须同时对齐 Agent 与 Terminal。被 Core 明确列出的 Agent/恢复候选按语义连续性保留或恢复；没有 semantic resume 的 Terminal 若不再出现在权威 Runtime snapshot 中，必须从其 Region、Tab layout 与下一次持久化投影中一起移除，不能留下只有标题的空壳 Tab。Runtime 仍不可达时可以暂时保留，但要在原 Region 显示中性的等待/不可用状态，并在重连后的第一次权威 snapshot 收敛。
- **“进程又启动不了了”必须能看见真实原因**。Runtime 恢复时的持久化容量、I/O 或状态库错误不得被统一掩盖成 readiness 超时；诊断必须说明失败步骤、当前状态与恢复动作。历史输出增长不能让下一次正常重启永久失败；容量回收与恢复由 ctxmux 持有，AgentMux 不实现第二套数据库维护。现场恢复保留可回退的原始数据，并区分“窗口和历史已恢复”与“旧 Agent 已重新运行”。
- **安装或退出不能把所有终端留在“Host 正在重新配置”的假故障里**。退出清理、真实 Host 配置变更与 Agent 故障必须分开呈现。更新因旧 App 未能退出而中止时，用户必须能知道停在哪一步、Agent 是否仍在运行以及如何恢复；不能让仍可见的窗口永久保留一个拒绝所有 attach 的中间态，也不能要求停止健康 Run 来解除 Desktop 的流程门禁。
- **控制客户端断开不能让整个 App 退出**。客户端超时、退出或中断连接时，读取请求、等待执行及发送回执期间的连接错误只终结该连接，不得升级成主进程致命异常；已经执行的操作不得因回执无法送达而重复执行，其他客户端及已有 Agent/Terminal 必须继续可用。
- **Runtime 兼容性与启动归属必须分开判断**：“自己”是同一用户的持久化 Runtime，不是当前 App 的 PID；重启、重装、移动安装位置不改变已有 Run。选定本地 endpoint 上的 daemon 只要公开协议、Runtime build 与所需能力兼容，就允许连接、查看和操作已有 Agent，不要求当前 App 启动它。owner receipt 只控制“能否由本进程安全清理/终止”的权限；缺失或不匹配时持续显示“归属未确认”，不能把兼容 Runtime 当成不兼容，也不能整窗退出。每次业务请求仍绑定已连接的精确 Runtime identity，端点中途被另一实例替换时拒绝串发。Artifact 的磁盘校验约束本次启动输入；不得把它说成对已运行进程的远程代码证明。
- **启动 Agent/Terminal 时，系统本地 zshrc 等脚本里 export 的环境变量必须带进进程**，不能只带 PATH。GUI 启动须读取用户交互式登录 shell 的导出环境；Executor 显式配置优先。每个新 Run 使用当前应用环境，不能依赖常驻 daemon 的旧启动环境。非导出变量、alias 和 shell function 不属于子进程环境。交互配置读取失败时继续使用可读取的登录环境/已有环境，并持续说明 zshrc 尚未确认；不把部分读取称为完整成功。告示不得展示变量值或凭据。配置变更在重启应用后对新 Run 生效，已有进程保留启动时的环境。
- **Host 探测必须对 GUI 启动可靠**。登录 shell 探测失败时不得把所有 Provider 静默判为 missing；应合并已有环境并使用非交互登录 shell等可靠路径重试，同时在状态面明确“探测未完成/当前按已有 PATH 运行”。只要 CLI 仍可执行，Host 探测流程不得阻断布局、Session 或用户操作。
- **登录 shell 的降级必须保留已有 PATH，并把“未读到交互配置”说清楚。** `-ilc` 读取 `.zshrc`/等价交互配置成功时采用完整导出环境；该臂超时或失败时，必须在总预算内继续尝试非交互 `-lc`，并把它得到的 PATH 与应用继承 PATH 去重合并。两臂都失败时保持应用原环境，不把 Executor 报成 missing；告示只说明读取范围和恢复动作，不泄露变量值。
- **Managed Hook 不得绑死已卸载的 App 路径**。Hook 配置里的 AgentMux 命令由当前运行的 App 在启动和恢复已有 Session 时校正；旧安装留下的绝对路径失效时，Hook 只返回 Provider 所需的中性响应并把诊断作为非阻断提醒，不能因为宿主探测/回调失败而阻断 Agent 的正常 Prompt。Hook 配置仍保留用户自己的条目，AgentMux 只更新带自身 marker 的条目；这条修复不通过给 `/Applications` 重新造一个影子 App 来兜底。
- **恢复候选不能静默消失**。Provider 不支持 native resume、Session 从未记录过 verified handle、handle 已失效或 Core 返回冲突时，原布局位置仍保留一个可理解的失败/待处理投影，明确说明原因与下一步；不能开一个全新的 Run 冒充旧上下文，也不能因为恢复失败而把整张布局裁掉。
- **Session 恢复是独立的一等功能**。应用启动、切换回项目和机器重启后的首次打开，都保留可恢复的身份、工作面和直接可达的恢复动作；自动续接与按需续接遵守《冷启动按需恢复》。恢复失败只能在 Core 已给出明确结果时出现，并且必须伴随保留原投影的服务窗说明；不能把“没有 verified Provider handle”当成唯一的无上下文黑箱错误。
- **「恢复不了」不是一句话，是四类结果加一个冲突，界面必须把它们分开说**。Core 的 unavailable 有四个原因（`provider-resume-unsupported` / `native-handle-unavailable` / `provider-unavailable` / `unknown-session`），另有 conflict 自成一类。合成一句「Agent resume unavailable」等于没说：**Provider 根本不支持 resume 是永久的**（这个 Agent 换个时间点也回不来，该新开一个），**handle 缺失只关乎这一条 Session**（别的 Agent 不受影响），**Provider 在这台 Host 上缺席则是可恢复的**（装回来/Host 回来就能续，此时叫用户新开 Agent 等于让他丢掉一个还活着的 Session），**conflict 说明东西还在、只是被占着**。用户此刻唯一要做的决定就是在「重试」「新开」「等一下」之间选，而这个决定完全由类别决定。
  - **恢复按钮上永远写得出"现在能做什么"，不留一个只写着"不可用"的死按钮**。只有可重试的那一类给可按的重试；其余给出各自该做的事。**一个按下去必然失败的按钮比禁用更糟——它承诺了一件做不到的事**；禁用态的说明由该类别的原因文本承载，不是空着。
  - **Core 没给原因时如实说不知道，不挑一类当默认**。把未知显示成"Provider 不支持"会把用户支去新开 Agent，而真相可能只是 Host 掉线。分不清就说分不清，这与「未知不得当作正常」同源。
  - 分类判定落在渲染层之外的纯函数里，且**对原因的分支不设 default**：Core 日后新增一个原因时，这里必须**编译不过**，而不是安静折进某句通用文案。
- **恢复动作必须幂等**。同一 Agent Session 在重复启动、窗口重新聚焦或 Topic 重进时，若已有精确匹配的 live Run 只能 attach；若 Run 已丢失且 handle 有效，只允许创建一个新的 Provider-native Run。任何迟到的旧 Run 事件都不得覆盖新的绑定。
- **机器重启后的边界必须如实表达**：旧 PTY 进程、ctxmux 内存 scrollback 与 pending interaction 不承诺可恢复；可恢复的是持久化的 Agent Session 语义身份及 Provider 自己支持的 resume。于是重启后终端可能从新 Run 的首屏开始，但布局、Agent 身份与恢复入口必须仍在。**布局仍在的含义是它的每一面都能用**：一个恢复出来的文件面必须真的把文档装上，而不是留一个报「不可用」的空壳；文件确已不在磁盘上时，走的是与「打开着的文件被删」完全同一条既有失败态，不另造一种。

### 冷启动按需恢复（P0 末位，）

用户要求「可以不把所有的都自动恢复」「idle 超过一定时间的就不自动恢复，而是让用户手动（但是方便），节省资源」，用户随后将门槛调整为**闲置超过一天（24 小时）**。对于 Core 已确认结束或丢失的 Run，长期闲置的 Agent 不因冷启动批量启动 CLI；原 Tab、Group、Region、布局、焦点、草稿与可读的持久历史先恢复。已有健康 Run 自动接回，不因这项策略主动停止。

用户希望未执行恢复时也「看起来像已经恢复」。这表示工作面完整可读、能继续写草稿，不表示伪造正在运行、完整 TUI 屏幕或成功恢复。待执行的 Agent 明确呈现“待恢复”；读取历史、滚动、切换 Tab 和写草稿不触发 CLI 启动。**第一次需要 Agent 执行的操作自动恢复并显示“恢复中”**，同时保留这次意图；不能丢输入、重复提交或要求用户先找另一个 Resume 页面。独立恢复按钮仍直接可达。首次执行只绑定一次恢复后的 Run；旧 Run 已经收过的消息不能自动改投新 Run。历史上的排队意图不因读取工作面自动恢复或重投，投递结果不明时保留消息并说明未知。闲置证据保存失败不得把 ctxmux 已接受的输入伪装成发送失败、重发输入或停止健康 Run；保留真实回执并在服务窗说明证据无法保存及当前未知状态。

已经绑定 Run 的执行意图必须由 Core 在输入入口核对目标，不能只在 Desktop 预先查一次状态。尚未绑定 Run 的新操作可按 Session 身份提交；一旦明确绑定，续接到另一 Run 不能替它改投。原生历史的短命只读助手属于阅读成本，不能把它计为恢复的 Agent Run，也不能宣称阅读完全不启动进程。

闲置时长只采用 Core 已证实进入 idle/done 的起点；同状态重复通知不重置起点，文件写入、后台探测、视图焦点、终端协议回复和单纯长时间没输出都不能被当成最近活动或闲置证明。已经提交执行后旧闲置证据失效，不据旧 done 推断仍闲置；旧记录或当前 working/unknown 等缺乏有效闲置证据时，按需恢复并说明未知，不回填旧时间。只有已证实闲置不超过 24 小时的已结束/丢失 Run 才在冷启动立即尝试续接；已超过一天（24 小时）或证据不足的保留待恢复工作面及入口。恰好 24 小时仍尝试续接，该门槛是内部固定策略，不新增配置入口。并发恢复必须收敛到同一 Session 的唯一 Run；失败说明具体步骤且可重试，其他 Agent 不受影响。历史能力和完整 TUI 续接的边界仍按《Terminal 连续向上阅读历史》执行。这项需求按用户指定排在 P0 末位。

旧输入回执不能清掉随后重新进入 done 的证据。同一毫秒内连续切换、时间超前、时钟回退或无法确定年龄时，如实将进入时间记为未知并保留待恢复工作面；不能虚构时间或据此批量启动。

### 寻址与复制

- **终端的每一档复制范围，读的必须是真能回答它的那个缓冲区。** 全屏 TUI 会把终端切到 alternate
  buffer（DECSET ?1049），那里按定义只有一屏、没有回滚；滚出去的历史留在 normal buffer 里，而
  `buffer.active` 此刻并不指向它。所以「复制可见输出」读 active——它问的就是"现在屏幕上有什么"；
  「复制全部输出」读 normal——它问的是"这个会话到现在输出过什么"，这个答案不该因为某个程序占用了
  alternate buffer 就缩水成一屏。判据只能是终端自己的缓冲区模型，不能是"哪个 Agent 在跑"：同一条
  规则必须对任何占用 alternate buffer 的程序都成立，实现和测试里都不得出现具体 Provider 名。
  这是 #638 的补全——那次正确地从选区服务换到了缓冲区数据 API，但没察觉 active 这个指针在同一条件下
  本身就是残缺的，于是修好了不吃满 alternate buffer 的那些 Agent，留下了真·全屏 TUI 的那些。
- **取不到内容就要说出来，不能静默返回。** 复制路取到空字符串时，既不写空剪贴板，也不假装什么都没
  发生——说清哪一档范围是空的、另一档还能用。Agent 是好的、字节是全的，坏的是我们这一步取值，按
  原则 11 第 2 类，它必须可见而不阻断。
- **复制出去的是一个寻址方式，不是一个 id**。任何"复制"动作的成品都必须让接收方（通常是另一个 Agent）**仅凭这一次复制**就能完成寻址：说清目标是什么身份、给出可直接执行的命令。裸 id 不合格——接收方拿到 `session:abc` 或一串 uuid，无从知道它是哪一层身份、该配哪个 flag、该跑什么命令，只能回头问人或翻文档，而那正是这次复制本该省掉的一步。
- **三级地址回答三个不同的问题，绝不互为别名**（与上文 Session/Run/View 的身份边界同源）：
  - **Session** 回答"**哪个 Agent**"——Provider 语义身份，跨 View 稳定，一个 Session 可同时投影到多个 Region 与多个 Tab；
  - **Region** 回答"**屏幕上哪一格**"——View 内的内容 leaf，是分屏场景下**唯一无歧义**的展示身份；
  - **Tab/View** 回答"**哪张完整工作面**"——它只在该 View 恰好承载唯一一个 Agent 时才可用作 Agent 寻址。
- **歧义在源头消除，不甩给接收方**。一张 View 分屏承载多个 Agent 时，Tab 地址本身就是歧义的；此时复制出的地址必须**直接是 Region 地址**，而不是一段"先 inspect、若返回 `MESSAGE_TARGET_NOT_UNIQUE` 再从 candidates 里挑一个"的操作指引——把消歧工作转嫁给接收方，等于这次复制没有把寻址方式说清楚。歧义只在源头可见：复制发生时我们知道用户点的是哪一格，接收方不知道。
- **复制入口按其能消除的歧义就近放置**：**Region 右键菜单**产出 Region 地址（用户点哪一格就是哪一格，无需推断当前聚焦，而想寻址的那一格往往恰恰不是聚焦的那一格）；**Tab 右键菜单**产出 View 级地址，语义收敛为"整张工作面"。同一 Session 在两处产出的 Session 地址必须一致——它们是同一份真相的两个入口，不是两套格式。
- **复制出来的路径默认用 `~` 表示当前用户的家目录，可切回绝对路径。** 用户原话：「现在我复制路径的时候，经常会复制出这样的 `home/proj/github/pi`，但是前面的其实就是 user 嘛，就是我当前的 user 嘛，所以这种情况下复制出来是波浪线就更好……但这是一个风格上的选择。我个人喜欢波浪线，所以我们可以把它弄成一个设置项：默认是波浪线，但也可以支持用户配置这种绝对地址」。它与本节第一条同源：复制出去的东西要**便于人和 Agent 直接用**，而家目录前缀对双方都是机器记法——`~/proj/github/pi` 在任何 shell 里都成立，且不把用户名带进被粘贴的文本。默认缩写、开关可关，用户原话即判据。
  - **缩写只在"这确实是当前用户的家目录"时发生，判据是真实 home 值而不是路径长相。** 不得用形如 `/Users/<任意一段>` 的正则去猜（那会把**别人的**家目录也改写成 `~`，粘给对方时指向错的地方）。边界必须是 `home` 本身或 `home + '/'`，不是 `startsWith(home)`——否则 `/Users/bytedanceOTHER/x` 会被剥成 `~OTHER/x`，一个看起来合法、实则不存在的路径。这条与 Terminal 路径识别那侧的根内判据同源，两侧不得各写一份边界。
  - **远程主机的路径绝不套用本机家目录。** Workspace 可以挂在 SSH 主机上，而"我的 home"是本机事实；把本机 home 从远程路径上剥掉会产出一个在对面根本不存在的路径。所以缩写以**该路径所属主机是本机**为前置条件；非本机一律原样给绝对路径。这属于"分不清就如实说"的同一条纪律：宁可长，不可错。
  - **一个概念一个出口。** 今天"复制路径"有多处各自拼接（其中若干直接把绝对路径递给剪贴板，绕过了既有的路径格式化出口），这条能力**必须先把它们收成一处**再实现缩写；分散实现意味着开关只对一部分入口生效，而用户看到的是"有时缩写有时不缩写"。已知的相邻事实：剪贴板写入本身已经只有一个出口，但它同时承载终端选区与分支名等非路径文本，**不是**缩写该发生的层——缩写属于"路径怎么表示"，不属于"文本怎么写进剪贴板"。
- 复制的地址**只使用已被 CLI 与 Control 面接受的寻址方式**（`--to-session` / `--to-region` / `--to-tab` 及 `inspect` 的对应 flag），不为复制发明第二套语法。地址里的 id 一律按 shell 语义转义，使带空格或引号的 id 粘贴即可执行。
- **按意图给入口命名，而不是按地址种类**。"复制 View 地址"要求用户先知道自己想要哪一层身份，可用户想的是"把这个 Agent 交给别人"。因此交接类入口按意图呈现（"给这个 Agent 发消息"），并由我们解析成**最精确的那个地址**：指向某一格分屏时是 Region，目标唯一时是 Session。View 地址不因此消失，但它的意图是"分享/检查整张工作面"，不是交接的默认落点——这与上一条同源：知道用户点了哪一格的是我们，不是接收方。
- **每一处能看见某个 Agent 的地方都要能寻址到它，TUI 里面也算**。用户原话：「现在右键 TUI 上，实际也没有办法复制出某个 agent 自己的身份，这样就不方便和他通信」。Region / Tab / Roster 三处右键已经有「给这个 Agent 发消息」与「复制 Session 地址」，而**终端画布自己的右键菜单没有**——于是用户正在跟这个 Agent 对话、光标就在它的 TUI 里，却必须先离开这块画布去别的菜单里找它的身份。这不是缺一种地址，是同一份真相少接了一个入口：终端画布上的右键**知道自己是哪个 Session**（那一格就是它），因此它是最不该缺的那个入口。
  - 入口按上一条的意图命名规则呈现，**并复用同一个格式化出口**（`agent-address` 那一份）——不为终端另拼一次文本。同一个 Session 从终端、Region、Tab、Roster 四处复制出来必须逐字一致。
  - **终端菜单里这一项只在这一格是 Agent 时在场**。终端 Session 没有 Agent 身份可寻址，给它画一个灰掉的「给这个 Agent 发消息」是在承诺一件不存在的事；缺席即如实。
  - 终端菜单原有的三个 Copy 回答的是「**画面上有什么**」（选区／可视区／回滚），这一项回答的是「**这是谁**」。两者不是一族，因此**分隔线分组**，不混在复制文本那一簇里——否则用户会以为它复制的是终端内容。
- **多个 Agent 并排且只有图标时，必须有一个不靠颜色的判别器**。用户原话：「我们那个 agents 的图标可以根据 provider 的图标做一些色彩、正片叠底、追加角标之类的操作……要不然有点难以辨认不同的 agent alias」。这条与上文「颜色在同 provider 的 A2A 下不足以区分身份，判别器必须是名字」同源，但补的是它没覆盖的那一半：**那条结论假设名字在场**（`aria-label` 与 hover 面板），而叠压头像簇里名字只在 tooltip 里——肉眼扫过去时三个通道（形状、颜色、名字）**一个都不可用**，因为同 provider 共用一枚品牌图标、颜色会撞、名字要 hover 才出。
  - **判别器是名字的可见投影，不是第二种配色**：取显示名的首个字素簇画成字母牌，与 provider 图标**同时在场**（图标答「哪家」，字母答「哪一个」）。字母来自名字，所以它继承了名字作为判别器的全部理由，而不新增一个会撞的通道。
  - **取的是显示名，不是 executor label**。用户拍板：「跟你看到的那个名字一致」。判据是**牌面与用户在 Tab 上读到的那个字必须是同一个**——牌子的全部价值在于「我认得这个名字」，而显示名才是用户脑子里那个名字；重命名一个 Agent，牌面立刻跟着变（身份没变但**称呼**变了，而牌子画的正是称呼）。取 executor label 会让牌面与 Tab 上的名字对不上，那是两个真相。
  - **前置条件：名字要先到得了这枚头像，而这是一条独立的、优先级更高的缺陷。** 上一条不是偏好，它是这条能力的**前提**，而今天这个前提不成立——叠压簇拿到的 `label` 是 `session.label`（Main 建的 `executorLabel · workspaceLabel`，即优先级链**最低**那一档），不是链求值后的显示名。于是把字母接上去会同时踩中两件事：它取的正是上一条明令禁止的 executor label；而对「同 provider 多个 Agent 同一目录」这个**唯一要解的场景**，两段串完全相同，每一枚都画同一个字母——用户报的「难以辨认」一字未动。
    - **这条缺陷不止于字母，它现在就在伤人**：那串兜底名同时是头像的 `aria-label` 与 tooltip，所以**读屏与悬停也读不出是哪一个**。即使最终决定不画字母，这一处也必须修——它比"没有字母"更基础。
    - **绕过命名链的不只这一处**（Agents 工具栏列表、快速切换器、Board 均直接用 `session.label`）。逐处修不是本条的要求，但**新增任何显示 Agent 名的表面都必须经那条链**，不得再添一处绕过。
    - 顺序因此是：**先让显示名到达这枚头像**（经既有 `resolveAgentName`，不在面板里重拼），再谈画不画字母。**不接受「先按 label 画着、以后再换成显示名」**——那正是本文档反对的临时方案，且它交付的是一个看起来在场、实则判别力为零的通道。
  - **牌面与 provider 图标同处一格是取位问题，不是尺寸问题。** 曾在此写过「字母受 10px 下限约束、18px 格子塞不下、须先整体放大」——实测推翻：10px 就是字号刻度的最小合法值（`--fs-micro`），而低于 10px 的具名例外被一条恒等断言冻结在 7px、且每条都必须真画 `content` 字形，所以字母**走不到也不需要**那条豁免；`.project-rail-row__icon[data-monogram]` 正是在 **16px** 格子里画 10px 字母，一直合规。头像格因此不必为字母放大。真正要解的是**一格之内两个记号怎么共存**，而本仓对「第二个记号」的既有答案是**角标溢出格外**（注意力那枚 `?`/`!`：8px 见方、`top/right: -3px`），它不以牺牲品牌图标为代价。若字母取这个位置，须先处置与注意力角标的同位冲突——那是取位裁决，不是密度裁决。
  - **正片叠底与「给品牌图标染色」明确否决**。品牌图标里有两家是硬编码品牌色而非 `currentColor`，叠底会把它们染歪；而它解决的正是那个已被实测判定为不足的颜色通道。色相**继续只做扫视分组线索**，沿用既有派生（让开语义色的那套），不新造调色板。
  - **角标位要先数清空位再占，且要按样式表数、不按注释数**。叠压簇里头像四角的实占情况：**右缘**被右邻座压掉（`.slot + .slot` 的负 `margin-left` 配合 z-index 左→右递增，是**右压左**，所以被盖住的是自己的右缘、左缘反而画在上面）。dock.css 里那句「叠压是右压左」与「左缘被邻座压掉」自相矛盾，**以样式表为准**——这类几何断言必须从规则反推，照注释抄会把方向记反。
    - **此前这里把记号数成三种，漏了一种，于是"两条左缘都空闲"是错的**：用户自定义徽标（`.agent-avatar__badge`）一直占着左上。可见角只有左上、左下**两个**，而记号有**四种**（注意力、归并计数、自定义徽标、字母牌）。分配裁决与排序理由见[密度合同](./agentmux-surface-density.md)那条"叠压头像簇的角位分配"，不在此复述。
    - 对字母牌的结论因此不变且更强：它**不是第五枚角标**，可见角本就不够分。真正的出路是上一条说的换载体或另给尺寸，而不是找一个还没被占的角——右下角那个位置只是登记占位，它恰好是字母牌最需要被看见时（簇里有多枚）必然被盖住的那一角。
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

### 持久消息的显式消费与派发等待

- 受管 Agent 应能实际“检查这一批消息，处理后明确确认”，不同进程在确认前拿到同一批身份和顺序；只能检查自己的收件，不能指定别人的消费游标。读取和确认不等于已投递、接受、回复、用户已读或需求完成，也不自动发送正文、创建、停止或恢复 Agent。
- 当前 Run 的凭证、Session 身份和持久消费批次必须相符。换 Run 后，新 Run 接管未确认批次，不丢原消息；旧 Run 的迟到确认或检查不能覆盖新绑定。失败说清是哪一步不可用，健康 Agent 仍可工作，不为消费增加生命周期门禁。
- 消息的消费、投递和监督等待都引用同一份持久消息身份与正文。队列由 Core 唯一持有，宿主和其受管 CLI 选择同一来源；明确注入的现有队列来源有权威，默认队列保持 durable，不能随 ctxmux 的临时版本端点回收。来源之间不猜测、合并、搬迁或静默宣称旧历史已纳入。
- Dispatch 监督的是针对真实消息的通信等待：发起者仍须接问题、升级、明确收工和收尾。不同问题消息分别保留，同一消息重放幂等；投递或游标确认不能解除该等待。只有经过参与者、当前 Run 和对话归属核验的明确收工报告才解除通信等待，不能据此显示“任务归谁”或把 Demand/Tracker 标成完成。Core 没有 Task 实体的边界仍见《交出去与派出去》。

### 我们的流程坏了，不等于 Agent 坏了

用户原话："我觉得当然不能算坏了，也不能阻断，但是可以有一个类似服务窗之类的设计给用户提醒……原则上不能因为我们的流程问题，让原本已经跑通的 Agent 受阻，这是绝对不允许的。"

- **任何失败在阻断用户之前，先分清三种状态**（原则见 `AGENTS.md` 第 11 条）：**完全坏了**（Agent 本身不行了，阻断是诚实的）、**Agent 没坏但我们的流程坏了**（放行 + 提醒）、**完全好的**（不打扰）。判据是"Agent 还能干活吗"，不是"我们的检查过了吗"。
- **第二类绝不阻断**。启动握手超时是这一类的样板：`[?u` 这个能力探测在 10 秒内没等到，通常只说明 CLI 还没走到吐出它的那一步（冷启动慢、机器负载高），进程活得好好的；而当前实现四个调用点全部 fatal 且带回滚，等于用我们的一次探测失败杀掉一个健康的 Agent。**超时的正确含义是"这项能力当前未知"，不是"这个 Agent 坏了"**。
- **创建成功不能被显示读取失败撤销。** Core 已确认创建 Agent Session 后，读取或重读 Session/Timeline 投影失败不等于创建失败，不能因此停止健康 Run、退休 Session、删除已绑定身份或把原 Region 回退成未创建。保留精确 Session/Run 与工作面；已确认的输入能力继续可用。服务窗说明哪一项显示信息尚未确认及如何重读；未知进程状态和缺失 Timeline 不得伪造成 running、exited 或一份成功的空记录。只有真正创建失败才清理本次未完成的准备，用户明确停止／取消的既有授权边界不因此放宽。
- **提醒的形态是服务窗**：像窗口上贴的一条告示，说清楚三件事——哪一步没走通、现在按什么状态在跑、要恢复完整能力该做什么。它停在旁边不挡路，不抢焦点，也不自动消失（消失了用户就再也无从知道自己在降级状态里）。它不是 toast，也不是错误弹窗——那两者一个留不住、一个在说"你完了"，都不符合"能干活，只是少一项能力"这个事实。
- **两条边界**：不许**静默**降级——用户有权知道自己在降级状态下工作，少一项能力可能改变他对 Agent 行为的判断；也不许**把未知当成好的**——分不清是哪一类时，如实说"分不清"，而不是猜一个然后照着做。
- **终端恢复态是这条原则的第二个消费方**。用户原话："现在有个 ctxmux 明明存在还在打开时显示 restoring"。恢复态此前只有两个出口——全链成功、attach 抛错——于是"我们的揭示流程卡住了"这一类在界面上表现为**永久转圈**，而 ctxmux、Run、PTY 全都好着。这是第 2 类被写成了"无限期等待"，比写成第 1 类更糟：连"哪里不对"都不告诉用户。**一个我们等不到的步骤，不得把一个健康的终端永久藏起来。** 揭示因此带 deadline，到点强制把画布交还给用户，并按同一个服务窗说清哪一步没走通、现在按什么状态在跑、怎么恢复（架构侧的揭示时序与锁竞争见 [`terminal-runtime.md`](../architecture/terminal-runtime.md)）。恢复态本身保留——真正需要重放时它仍是诚实信号，被削弱的只是它无限期遮挡画布的权利。
- **「放行」不等于「什么都通了」，且能力差异必须说准。** 第 2 类要求不阻断，但**不要求谎报**。终端揭示是这个陷阱的样板：强制揭示时 replay→live 的交接可能还没完成，此刻键盘敲下去会写进一个还没接上的 attachment。所以两件事必须同时成立——**输入真的没通**（三条输入通路统一卡在同一处判定；少卡一条就等于没卡，用户总会找到那一条），且**告示如实说输入还没通**，而不是笼统地说"现在可用了"。放行的是**用户的去路**（画布交还、不再挡着），不是**每一项能力**；把两者混为一谈会让告示变成一句好听的假话。相应地，"这项能力当前是否可用"这种输入**不给默认值**——默认必然偏向"可用"那一侧，而那正是会撒谎的一侧，等于把未知当成好的（见上一条第二边界）。
- **Prompt 交付验证是这条原则的第三个消费方**。render-then-submit 路径用终端屏幕证据确认 payload 已上屏再发提交键；当证据因我们的观察失败（replay 被截断、`OUTPUT_GAP`、render 超时）而读不到，但 payload receipt 已确认且 Run 仍活着时，**不得把提交挡住**——那是第 2 类。正确做法是照常发提交，并挂上服务窗：说清验证哪一步没走通、本次交付未经完整屏幕确认、如何恢复完整验证。真坏的边界不变：Run 已退出、进程已死、或 payload 本身从未被接受，仍 fail-closed。静默放行同样禁止。
- **实时输出通道断了、进程没死，是这条原则的第四个消费方**。重连成功了，但这一个 Run 的输出泵没能重建：输入照常送达 Agent，它的回显却永远到不了这块屏。这是第 2 类里最容易被漏掉的一种——**没有任何一步报错**，界面看上去完全正常，用户对着一块永不回显的屏幕继续打字。所以放行的同时必须如实说明"输出可能没在这里显示，但你的输入仍然送达"，并给出恢复动作（把这块 pane 在 Activity 与 Terminal 之间切一下——那是唯一会立刻卸载并重挂终端、从而触发 reattach 的用户动作）。**恢复动作不能点名 Resume**：Resume 对一个还在 running 的 Run 判出 `reattachable` 就直接返回投影，根本不进 attach，输出通道原样断着——点名一个按了等于没按的动作，比不给动作更糟。这条事实是 run 作用域、可持久的，挺过视图切换与快照刷新，直到一次成功的 reattach 撤下它——它不能是一条会被下一张会话快照洗白的瞬时错误，否则用户只在最初那一瞬有机会看见。
- **告示的音量由三分类派生，不由调用点各自挑。** 一个"我们的步骤没走通、Agent 好着呢"的降级，和一个"Agent 真的没了"，不该用同一个音量喊。音量因此是**分类的派生值**：第 2 类（放行 + 提醒）与"分不清"都轻声说，只有第 1 类才打断。让每个调用点自己挑音量，结果必然是全部取最响的那一档——一旦所有提示都在喊，用户就不再分辨哪条真的要紧，而真正要紧的那条也就失去了它的音量。这条约束同时约束**两个渲染面**（持续的服务窗告示与瞬时错误提示）：两个面共用同一条严重度轴，不允许各自维护一张严重度表。
- **“最响的那一档通报”必须在真实产品中可达。** 只有 Core 已确认崩溃的当前 Agent Run 才使用这档；用户停止、Runtime 中断、流程失败和退出原因分不清时，不能假装 Agent 崩溃。提示说明是哪一个 Agent 和已知退出事实，停在现有提示位置，不抢焦点、不挡另一健康 Agent 的输入，也不因此启动、停止或恢复进程。
- **同一次崩溃重复观察不反复叫醒用户。** 用户可以关闭并重新查看该条提示；新 Run 真崩溃不能被旧 Run 的关闭记录吞掉。启动时已存在的历史崩溃保持安静，启动后的新成员、会员重同步和新 Run 的已确认崩溃仍须能提醒；不得维护第二份进程状态或持久崩溃台账。
- **Prompt readiness 的拒绝必须按原因分别说清楚**。`not-ready`（还没有这个 Run 的可用 composer 证据）、`readiness-consumed`（当前 epoch 已被另一条 prompt 占用）、`submission-busy`（上一条 payload/render/submit 尚未收口）和 `readiness-conflict`（并发观察与 Session 的代次校验冲突）不是同一件事，不能再合成一句“Agent 仍在工作”。每种告示都要带上不含用户正文的 Run/epoch/submission 诊断与下一步动作，让用户或受管 Agent 能判断应等待、重试、刷新观测还是检查 Provider；Core 的拒绝门与草稿保留规则不因此放宽。
- **用户关掉的是一个原因，不是一串字符。** 用户原话："然后这个错报一次、关掉了以后，就不应该再报了，对吗？"——成立。同一个失败被回放事件与轮询重复上报是常态，所以关掉之后它不得复活；而**判定"是否同一个"必须按原因，不按呈现给用户的那串文本**。诊断上下文（Run/epoch/游标字节数）是给人看的，随 Agent 每打印一个字节而变，把它算进身份等于每次上报都是一条"新错误"，用户的关掉被逐次击穿。反向的边界同样硬：身份也不得粗到把两个不同的失败合成一个——静默吞掉一个真的新问题，比重复报一次更糟。因此身份剥掉易变上下文、保留失败本身，**且诊断不因此丢失**：关掉只压住这一面，重新打开仍要拿得到可粘贴的诊断。

- **屏幕语义证据不得按会话全史从零重建作为热路径**。每次提交或 readiness 观察若都从 byte 0 全量重放进临时 headless 终端，延迟随历史线性增长，并放大 gap 截断概率。活跃 Session 的屏幕证据应增量维护，或从最近完整 TUI 帧/检查点起点观察；失效（resize、重连、gap）时重建。字节史与 replay/checkpoint 权威仍在 ctxmux——Core 不另存第二份 Run 字节。Desktop cold-park 的重建成本与同一条有界证据合同对齐，见 [`agentmux-surface-density.md`](./agentmux-surface-density.md)。
- **当前终端尺寸只认 ctxmux 的 owner-confirmed 事实。** `RunSpec.size` 是启动时请求的尺寸，此后不变，不能当作现在几列几行。Run 投影与虚拟屏幕使用 `RunInfo.current_size`；它为 `null` 时是明确的 unknown，不得回退成 spec.size。成功 resize 后的 `RunEvent::Resized` 让长连接屏幕证据失效并按新尺寸重建。Viewport 可以向 PTY 提交测得的网格，但只能把 receipt 里的 applied size 记成已经生效的尺寸。`current_size` 不能单独重建历史 TUI；跨尺寸历史仍按 gap/resync 处理。
- 这条与《寻址与复制》里"失败结果要自带下一步命令"同源：失败不是终点，是一个要说清楚"现在怎么办"的时刻。

#### 完成与 error 判定可信度

用户原话：“感觉 agentmux 的完成和 error 判定有问题”。

- Agent 的语义状态与 Run 终局只消费其权威来源。我们的探测、观察、交付验证或显示流程失败，不得据此把 Agent 投影成失败；turn 结束、空闲或进程退出也不等于需求已经验收完成。真实语义错误与已确认崩溃仍按原事实呈现。
- 流程诊断进入上述既有服务窗，保留原因、来源和可确认的作用域；不得替换 Agent 语义状态、抬高语义新鲜度或屏蔽已确认可用的健康输入。状态未知仍如实显示未知，不能为了消除错误而猜成健康；新的权威快照不能被旧流程诊断黏成失败。
- 告示只归属可确认的当前 Host、Session 与 Run，旧 Run 或其他 Host 的诊断不得污染当前工作面。作用域无法确认时明确说明，不假定归属；成员重同步、工作面恢复后仍应可见，同时保留原布局、焦点、草稿和身份。

## 界面结构

### Agent 已经这样多久了

- 用户需要知道“这个 Agent 已经这样多久了”：干了多久、等我多久、完成后闲置多久。Activity 明细采用 Core 已确认的当前语义状态起点；最后一次观察不等于状态起点，重复同状态的观察不得重置时长。
- 已确认的工作状态显示持续时长，并保留真实上下文压力；等待、完成和语义错误也各显示对应状态的持续时长。起点缺失、已失效、无法确认、来源不符或当前状态已衰减时，明确显示起点未知；进程活着、退出或断开本身不能证明空闲从何时开始。
- 完整 Session 更新必须忠实表达已有语义事实的新增和清除，包括观察时刻未变而旧起点已被清除的情况。时长不改变状态新鲜度、断开状态或输入可用性，不为显示时长生成第二份起点。
- 单 Agent 工作线在现有摘要行直接展示状态时长和上下文，不要求用户展开一张不能展开的列表。只有完成态 Agent 的项目仍保留 Activity 的紧凑入口，用户可以查看完成后的闲置时长；完成数量不升级为待处理告警。
- 静默等待的时长在打开且可见的 Activity 菜单中继续前进，关闭或窗口不可见后停止显示刷新；菜单内所有 Agent 使用同一时刻，不为每个 Agent 启动常驻计时或 Runtime 轮询。
- 注意力跳转保留现有“最早观察到待办”的顺序；该顺序不冒称等待最久。状态持续时长与最后活动时刻分开表达。
- 新状态观察到达时，时长必须使用该次实际渲染的当前时间；不能因菜单的秒钟还停在上一拍，把有效起点闪成未知。未来或不可信的来源时刻仍如实拒绝。

### 顶部与项目栏

- 左侧状态汇总的 running/error 数量采用紧凑语义图标与短数字；hover activity 面板展示 Provider 图标、最近活动摘要与停止时长，信息密度优先，不重复完整会话正文。
- 左侧项目菜单使用较轻字重与明确的层级、状态和图标语义，降低装饰性重复信息；Status Bar 内的 Agent 状态采用低调的语义图标与短标签，不再使用“点+数量”作为唯一表达。
- **最左侧 Projects 栏支持拖拽调宽**。用户可从项目栏与主工作区的边界拖拽改变宽度，拖拽过程中项目内容即时适配，松开后保留最终宽度；边界提供可发现的 resize affordance、键盘焦点与可访问名称。调宽只影响 Projects 栏，不改变 Workspace Tools 或主工作区布局；收起和恢复沿用同一份宽度状态。
- **文件树目录是可操作的项目入口**。目录右键菜单提供“作为项目打开”：把该目录注册为新项目并立即切换到该项目；动作只对目录显示，复用既有 Workspace 创建/选择 seam。失败时保留当前项目，并用持续可见的服务窗提示说明恢复动作。

- macOS 红绿灯之后固定放 Projects 与 Workspace tools 两个开关，顺序和位置不随面板状态变化。
- Session 的顶层 Tab 组始终直接占据窗口最上方的 Tabbar。单 Pane 时它与窗口顶行合并；分屏时也不再额外预留一条空的全局 chrome 行，由左上方的首个 Pane 承载一次必要的窗口 chrome，其余 Pane 只保留自己的紧凑 Tabbar。
- Project Rail 底部并排放 Settings 与键盘帮助，展开和收起时均可直接访问。
- **项目行回答三件事：哪个 Project、在跑几个 Agent、要不要你**。尾部的数字是**当前在跑的 Agent 数**，不是这个项目有几个 worktree——用户扫这一栏是在找"哪儿还有活在动"，仓库有几个 worktree 属于结构事实，答的不是同一个问题，进 tooltip。零不显示数字，只有真在跑才占位。Host 同理：本机是绝大多数情况，每行都写一遍 `This Mac` 不携带信息，只有远程 Host 才值得占一个位置。
- **Branch/Worktree 条与 Topic 条是同一种交互，但不是同一份真相**。两者都是"挑一个条目 → 进到一组 Tab、每个 Tab 是一套 Region 分屏"，因此**表现层共用**（见密度合同《控件语言》）。但选中真相不同且必须保持不同：Branch 切换换掉的是 `activeWorkspaceId`——一个 worktree 本身就是一个 Workspace，天然拥有自己那份 layout；Topic 全部共享 Scratch 这一个 Workspace 的同一份 layout，切 Topic 是把它**投影**成只含该 Topic 的那组 Tab。不得为了"看起来统一"把 Topic 也提升成真实 store 字段，或把 Branch 降成投影——那会给同一件事造出第二份真相。
- 窗口底部有且仅有一条**跨会话注意力汇总栏**，横跨整宽。窗口里其余每个状态指示都是**有作用域**的——Tab 状态点只讲一个 Session，Board 列只讲一个 Project，Agents 工具的总数只讲一个 Workspace 且只在其工具坞打开时。这条栏回答它们都不回答的那一个问题：这整个窗口里（含折叠的 Pane、其他 Tab Group、其他 Workspace），现在有没有 Agent 需要你。它只在窗口至少投影一个 Agent Session 时出现，否则完全不占位。它是聚合而非某一个 Session，因此没有诚实的 `status.source`/`observedAt` 可交给 StatusDot——绝不伪造证据，只复用共享状态语汇（同一套点与颜色），使这里的一个点与 Tab 上的点含义完全一致；计数为零时保持中性灰。"需要你" 与 "错误" 两段是动作：点击跳到该注意力类别里 `status.observedAt` 最早、即最早观察到该待办的 Session；聚合计数写进这两段按钮自己的可访问名，让读屏得到事实而不只是"跳转"。它只读 Store 里已有的 Session 投影，不新增任何管线。
- 汇总栏的**总数段是名册的展开入口**。栏回答"有没有需要你"并跳到最早观察到待办的那一个；名册回答"都有哪些"。二者是同一份聚合的两个尺寸，不是两个数字：折叠态只占那枚本已存在的计数，展开才付出空间，且关闭时展开内容不驻留 DOM。名册**只读**既有 Session 投影与 Core 已有的 pending interaction 事实，不新增 Core 合同、不建第二条消息状态机、不为待处理请求另开一个列表——待答的行就是这张表里的行。排序复用全窗口同一套语汇：needs-you 优先于 error 优先于 working，同一类内 `status.observedAt` 最早者在前，与汇总栏"跳到最早观察到的待办"的落点一致。
- 名册的每一行显示该 Agent **启动时固定的授权范围**。它来自 Core Session 记录里已持久化的 launch-option 选择，经 DESCRIBE 半边（仅 choice id）跨 IPC，标签由 Renderer 用 Provider 自己的 catalog 声明解析——argv 仍然不出 Core。两条诚实规则：创建时未收窄任何一项则**什么也不显示**，绝不写"默认"（那是无人记录过的事实）；选择所对应的 option 或 choice 若 Provider 已不再声明，该项**丢弃**而非渲染裸 id（一个 `bypass-all` 当标签显示，会像一个已核实的授权，实际却无从解析）。行上最多一枚风险标记，取该行诸范围中最宽的那一档；Provider 未声明 tier 的选项不被补成 `safe`。
- **注意力沿导航树上卷**：某一层内有 Agent 需要你时，该层的折叠行也必须表达出来，否则折起来的项目与空闲项目无法区分，"先处理谁"就退化成逐层展开去找。上卷复用同一份 Session 投影与共享状态语汇，不建第二个聚合管线；一行只显示其下**最紧要**的那一个信号（needs-you 优先于 error），并带形状而非仅靠颜色。`done` 不点亮任何行——完成已由通知与 Board 承载，常驻标记会让整条栏长亮，从而淹没"有人在等你"这唯一要紧的信号；`disconnected` 同样保持中性。
- **窗口外也能看到有几个 Agent 在等你**：macOS Dock 徽标持续显示已有全窗口 `needsYou` 汇总的当前数量，为零清除。窗口聚焦不等于请求已解决，前台也按真实数量更新；这不是未读消息或通知次数，不能另存一份待办。启动即投影当前事实，只在相关 Session 变化时更新，其他平台没有原生 Dock 时安静跳过。系统徽标更新失败通过已有非阻塞提醒说明，可在后续相关变化重试同一数量，不能影响 Agent 输入、状态和草稿。
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
  - 已实测：**对话正文的形状只能有一个出处，就是身份判定那个纯函数**。原先正文按 `kind` 分叉（`log-turn--user_message` 之类），于是"这段话是谁说的"在同一个元素上有了两套答案——属性一套、头像与 caption 另一套。把其中一套单独改坏，既有断言 23 条全绿，元素自相矛盾（属性说 agent、头像说 human）也没人报：**每条断言只看其中一套，粒度比 bug 更粗**。判据：属性、头像、caption 三者同源，且要用一个"两个候选判据会给出相反答案"的 fixture 去验（例如 `source:'user'` 配 `kind:'lifecycle'`），否则守卫在两个判据恰好一致的常规数据上永远绿。**机器上报那一路仍按 `kind` 画**（tool_call 是锤子、permission 是盾）——那一路问的是"这是什么事件"，锤子就是对的答案；不要把"身份不许由 kind 反推"错读成"kind 不许决定任何画法"。
  - **说话人轴上是头像，hover 出面板展现原话**。**当前这条轴上只会有人类用户的发言**——用户原话：「所以现在在用户或者说话人的这条轴上, 应该只会有人类用户的发言」。A2A 只做**设计预留**，不要求真的完成：身份按开放集建模（轴能并置多个头像、身份不由 `kind` 反推），但今天的实际值域就是一个人类用户。这个区分很重要——预留的是**形状**，不是一条现在就要点亮的功能；把 A2A 当成本轮交付会让一个还没有真实数据源的轴先长出空槽。头像是开放集在窄轴上唯一站得住的表示：文字 caption 在多身份下会挤成一团，而头像既能表达身份、又能在一个 16-20px 的轴上并置多个。**自我 Agent 轴上，Agent 说话了的那些位置同样用头像**——两条轴共用同一套身份表示，不是各画一套。hover 面板给的是**原话**，不是摘要：轴的作用是让人在不滚动的情况下找到"那句话在哪儿"，摘要会让这个用途失效。
  - **必须是一个可复用组件，按轴的语义参数化，不是两个组件**。这与 Board「一个 Board 组件按行来源参数化，不是两个 Board」同源：两条轴共用时间基准、共用头像表示、共用 hover 锚定（复用既有 `terminalLinkPreviewAnchor`，那条"永不遮挡它所描述的东西"的规矩已经在 ruler 与终端链接预览之间共用了一次，不能在这里开第三份）。分成两个组件，就等于给"轴怎么定位、头像怎么画、面板怎么锚"各开两份答案，日后必然漂移。
  - **主视觉要服务 A 端快速交互，不是服务阅读一篇文章**。用户原话：「着重考虑主视觉和相关设计语言, 是否最符合和 Agent / A 端的快速交互特点」。与 Agent 交互的实际节奏是**扫**而不是**读**：用户要在一屏里判断"轮到我了吗、上一句我说了什么、它现在卡在哪"。所以视觉权重给这三件事，而不是给装饰——头像与轴让"谁说的"在一眼之内落位，正文保持既有的 13px 主色不被削弱，机器上报继续压在 24px 紧凑行。任何让扫视变慢的处理（额外描边、每条消息一张卡、头像加光晕）都与这条相悖。
  - **样式要能移植到手机**。用户原话：「这个样式要能够比较好地移植到手机上去, 尽量照顾到」。这对轴的实现有硬约束：hover 在触屏上不存在，所以"hover 出面板"必须有一条**同源的**点按通路（同一个面板、同一套锚定，不是另写一个移动端组件）；轴的命中区要够大（触屏最小命中尺寸远大于鼠标）；两条轴在窄屏下要能退化而不是横向溢出。这条不要求本轮真的出移动端，但**不许做出一个只能靠 hover 才能用的轴**——那会让移植变成重写。
  - **顶部那条已经炼化落地的进度条要保留**。它比其他实现更强的部分（诚实时间轴、每行偏移、无跨度时退化为序数）是既有资产，新增的两条轴是**在它之上分轴**，不是替换它。任何"重写一个更简单的 ruler"的方案都要先解释它如何不丢这三条。
  - 已实测：**"在它之上"必须是同一个坐标框里的一行，不能是它上方的一个兄弟**。轴标记与刻度都用 `left: N%` 定位，而百分比解析的是各自包含块的宽度——两者只有在同一个盒子里才落在同一个像素上。ruler 那一行是 `.activity-ruler`：它有侧向内缩，且把刻度轨道当 `flex: 1` 排在跨度读数与说明**之后**（约 90–110px）。所以做成兄弟的轴会整体右漂，且漂移量随 fraction 增大——事件越晚、偏得越多，最左那枚还被裁掉一半。判据：轴与刻度轨道必须是同一列（一个共用的 stack）的两行，跨度读数与说明留在这一列之外。**对齐是这两条轴存在的全部理由**，所以这不是"顺带做好一点"，而是它的正确性条件。
  - **身份来源必须有唯一权威，不在渲染层猜**。头像取自哪个身份事实（Agent 的 providerId/label、还是 A2A 的参与者身份）需要在 Core 侧有明确出处；渲染层不得按 `kind` 反推身份，那正是今天二值 caption 的形态。这条与「显示名与身份严格分离」同一条约束：身份用于寻址与取头像，显示名只用于显示。
  - 已查证：**timeline 上今天没有能承载"开放集说话人"的字段**。`AgentTimelineItem` 的两个相关字段都是闭集：`kind` 只有 `user_message | assistant_message | tool_call | permission | lifecycle`，`source` 只有 `terminal-output | run-process | native-hook | acp | user`（均见 `packages/core/src/types.ts`）。二者都不携带身份，没有 speaker/participant 之类的字段。所以按上一条，**开放集说话人是一次公共合同变更，不是 Renderer 的自由**——与 skill 派发需要新增 kind 是同一类判断，不得在 Renderer 里靠 `label` 字符串凑。
  - 由此得到本轮的落点，**顺序不可颠倒**：今天可交付的是「把身份判定从渲染层的二值分支收敛成一个有唯一出处的纯函数」，它的值域就是今天真实存在的那两个身份（人类用户、这个 Agent 自己），并且**函数的返回形状要能容纳第三个身份而不必改调用方**。真正的开放集（多个 Agent 各有身份与头像）要等 Core 侧先有身份事实——那是一次独立的合同变更，不在本轮。**不要为了让轴"看起来支持 A2A"就在 Renderer 里造一个假的身份来源**，那正是这条约束要挡的东西。
  - 已查证：**现有头像组件只有半边能复用**。`AgentProviderIcon` 是纯的受控组件（吃 `providerId` + `size`，已 `aria-hidden`，各家真图标 + `Bot` 兜底），**可以**直接作为 agent 身份的画法。但 `AgentAvatar` **不能**原样复用：它是一枚 `<button>`，带 `onOpen` 跳转、`AgentDisplayState` 状态外描边、`AttentionCategory` 角标，语义是「Board 上可跳转的 Agent 行头像」，而且 `providerId` 是必填——人类没有 providerId，`AgentProviderIcon` 也没有「人」这一路。所以说话人头像组件要**按 role 分叉**（human 给人形/首字母，agent 复用 `AgentProviderIcon`），而 `{role, id}` 恰好是驱动这个分叉的正确入参：role 选画法，id 在 agent 支去 store 查 providerId。这也说明「两条轴共用同一套身份表示」是共用**身份表示**（那个 `{role,id}`），不是共用某个现成组件。
  - 已实测：**颜色在同 provider 的 A2A 下不足以区分身份，判别器必须是名字**。说话人色相由 id 派生（开放集不能用固定调色板，第四个身份就会撞色），派生本身是均匀的——10 万个真实形态 id（`randomUUID`，见 `client.ts` 的 `input.agentSessionId ?? randomUUID()`）落进 12 个 30° 桶各 8.2–8.5%。但**均匀恰恰意味着会撞**：这是生日问题，360 度环上取 n 点、要求两两相隔 ≥20°，撞的概率是 2 个身份 11%、3 个 30%、4 个 **52%**、6 个 86%（实测与闭式 `1-(1-n·thr/360)^(n-1)` 吻合）。换任何散列都一样，不是实现缺陷。而同 provider 的两个 Agent 画的是**同一枚品牌图标**，所以形状也不分。于是三个通道里两个失效，剩下的唯一判别器是**名字**（`aria-label` 与 hover 面板里的那个名字）。这条对接线有硬约束：**接线方必须为同一条对话里的多个 Agent 传入互相可分的名字**，不许把「两个 Agent 能不能认出来」押在颜色上。颜色是辅助（一眼扫过时的分组线索），名字才是身份。
  - 已实测：**派生色相必须让开语义色所占的弧**。状态色是**词汇**不是配色——amber 专表「需要你」、red 表失败、green 表成功、blue 表人类说话人。一个散列到 amber 附近的 Agent 会被读成"这个在等你"，而它只是名字碰巧落在那里；**身份色误报状态比两个 Agent 撞色更难查**（撞色你会去看名字，误报状态你会去点那个 Agent）。这条推理在人类身份上已经用过一次（人类固定取 blue、不派生，理由正是"派生结果可能撞语义色"），对 agent 一样成立，所以要兑现成代码而不是只写在人类那条注释里。判据：**由保留弧的补集取值**，不是"算出色相再往外推"——后者会把两侧的值都挤到弧的边缘，制造出人为聚簇，恰好破坏派生存在的理由；而且最暖的那个语义色（red 约 2°）的弧跨过 0°，"往外推"在那一段会直接算错（实测过一版：10.8% 的身份仍落在它附近）。让开半宽取 22°，略大于可分辨所需的 20°：目的不是"恰好不等于"，而是"不会被误读成"。实测结果 190/360 度可用，且是**三段而非四段**——red 与 amber 相距不到两倍半宽，两段禁区连成一整片暖色；想把半宽调小来省回这一片的人要先解释，为什么在两者之间劈出一条"同时离两个状态色都只有 20° 出头"的窄缝更好。色相取整数度：可分辨粒度远粗于 1°，小数位换不到任何一双眼睛能看见的东西。
  - 由此还有一条边界：**providerId 不进身份判定函数的返回**。它不回答「谁说的」，而是「这个身份怎么画」；用地址（`agentSessionId`）去 store 查它，正是上面「身份用于寻址与取头像」的字面兑现。把 providerId 塞进那个纯函数会逼它把 store 当入参——而 `AgentTimelineItem` 里根本没有 providerId，那等于让纯函数不再纯。
  - 另一条已查证的事实，用来校正用户报的那句「user 消息也会被收进 Agent 的历史」：用户 prompt 确实与该 Agent 的 `tool_call`/`assistant_message` 写在**同一条 per-session 时间轴**上（唯一收录点在 Core 的 launch/send 路径，`kind:'user_message'` 恒等价于 `source:'user'`，由单一生产者保证；`UserPromptSubmit` hook 刻意不重复收，已有测试守着）。但**没有**任何路径把它喂回 Agent 的 LLM 上下文——AgentTimeline 是观测投影，Agent 的真实对话历史在 provider 自己的 transcript 里。所以用户说的"不够优雅"是**呈现问题而非污染问题**：两个身份共用一种形状，读起来像被收进去了。修法在形状与身份表示，不在"把 user 消息从时间轴里摘出去"——摘出去会让用户失去"我上一句说了什么"这个最常用的定位锚。
- **Composer 在 TUI 投影下可收起成一枚悬浮按钮，在对话投影下始终展示**。用户原话：「在对话模式下始终展示，但在 TUI 模式下要能够支持收起，收起到一个小的悬浮按钮里面」。两种投影要的东西不同：对话投影里 Composer 就是主输入，收起等于把这个界面的用途拿掉；TUI 投影里用户是在直接和 CLI 的全屏界面打交道，此时固定占一条高度的 Composer 会挤掉正被阅读的终端内容。三条边界：
  - **收起只是隐藏，不是卸载**。草稿必须活过收起再展开——Composer 挂载点不变（同一 Region、同一 adapter），否则收起就成了一次静默的清空，与"切换投影时不能清空未发送草稿"是同一条约束。
  - **收起状态按 Region 记，且只在 TUI 投影下有意义**。切回对话投影时无条件展示，不去记忆"用户在对话模式下也收起过"——那是一个用户没法表达的状态。
  - **悬浮按钮要能表达有未发送草稿**。收起之后草稿不可见，若按钮只是一枚静态图标，用户会忘记自己写了一半——按钮需带上"有草稿"这一事实，否则收起就在制造丢失感。
- **Composer 要认 skill 与 slash 命令**。用户原话：「现在对话组件对 skill 的支持不太好」。今天的缺口是**整条链路都没有这个概念**：Composer 是一个纯 textarea，没有 `/` 触发、没有补全、没有发现；Core 的 timeline kind 是一个被校验器封住的闭集（`user_message | assistant_message | tool_call | permission | lifecycle`），没有 skill 的位置。于是一次 skill 调用要么根本不进 timeline，要么塌进一条**与任何别的工具无法区分**的 `tool_call`（同一枚 Hammer）。
  - **触发前缀由 Provider 声明，不在 Renderer 里按 providerId 分支**。各家 CLI 的前缀并不统一（有用 `/` 的，也有用 `$` 的），这正是既有 Provider 能力声明（posture、interaction 同处）该多一条的东西——与 permission option 的 DESCRIBE/CONTRIBUTE 拆分同构：声明半边跨 IPC 供 Renderer 渲染，兑现半边留在 Core。
  - **两个来源合并成一个选择器**：一份**手工维护的命令目录**（CLI 不提供任何机器可读的命令列表，这是事实约束，不是偷懒），加一份**磁盘发现的 skill**（扫 skill 根下 `SKILL.md` 的 frontmatter 取名字与描述）。前者是纯数据，可以自由生长。
  - **发送时按"行首 token"分流，且不得先 trim**。一句以空格开头的正文即便看着像命令也仍是正文——抢一条"已派发"的记号给一段从未派发的文本，是在制造假状态。入队不等于实际派发，不能拿排队记录充作送达。
  - **一次派发在 timeline 里要看得出是派发**，既不是用户气泡，也不是一张完整工具卡。这需要 Core 侧动那个闭集（新增一个 kind 是**公共合同变更**，不是 Renderer 的自由），否则 Renderer 无论怎么画都是在给 `tool_call` 打补丁。
  - **有歧义就显示歧义，不替用户裁决**：一个名字同时是命令又是 skill、或来自多个来源时，标注出来交给 Agent 解析。参数是**自由文本**，不做 schema、不做发送前校验——参数语义归 CLI 所有，我们插入 token 加一个空格就收手。
  - **发现按 skill 真正运行的位置取值**，带明确超时与 Retry；**远端 host 下明确"不可用"而不是给一个空列表**——空列表说的是"这儿没有 skill"，那是假话。与 Editor 失败态的 Reveal 在远端**以缺席表达**是同一条规矩。
  - 未验证、动手前要先确认的一件事：**我们消费的 hook 里，一次 skill 到底以什么 toolName 到达**。这决定了 timeline 侧是"补一个 kind"还是"先得能认出它"。
- Composer 使用独立、受控、无 Store 依赖的可复用输入组件；Session adapter 负责草稿、当前文件、Submit 与 Interrupt 绑定，为附件和其他富输入能力保留唯一扩展面。
- Renderer 不根据 `working`、`waiting`、`blocked` 或 `done` 猜测 Prompt readiness。Core 拒绝提交时保留草稿供重试；semantic resume 和恢复动作继续由现有 Owner 负责。
- **运行中可 steer**：Agent 处于 `working` 时界面仍允许提交，补的那句话经**既有** send 通路（store.send → submitPrompt → Core.submitAgentPrompt）送出，与普通 prompt 同一条路——不新增 Renderer 侧第二条写通道。「界面是否允许提交」与「主动作是 Send 还是打断」是两个不同问题：working 时前者为真而后者仍是打断，一个跑动中的 Agent 既要能被补话也要能被叫停，二者不互斥。判定收敛为一个纯函数（`lib/composer-submit-mode.ts`），不读 Store、不按 providerId 分支。
  - 投递结果仍由 Core 按真实输入能力与回执裁决；显式 steer 不因缺少回合结束／readiness 观测而变为永久排队。正在进行的部分投递、同操作幂等、错 Run、待答交互和 Provider 确实不支持的输入边界仍保留。发送意图只在下述「Cmd+Enter 直接 steer」定义，队列归「Composer 消息队列与紧凑状态」。
  - 明确发送所需的恢复或持久化步骤失败时，保留原条目与具体原因，结束这一次尝试；同一次授权不能让失败的恢复进入无界重试。其他明确发送仍按各自意图与 Run 边界处理，用户对原条目的下一次明确重试才发起新的尝试。
  - pending interaction 期间**不允许** steer：待答请求期间卡片是唯一输入面（既有合同），Renderer 侧不提供提交、Core 侧亦抛 `AGENT_INTERACTION_PENDING`，双重保险。

- **终端要像终端：宿主不许悄悄改写按键与选择行为**。Agent 跑的是它自己的 TUI，用户练熟的是那套 TUI 的手感；我们只是宿主。宿主把某个键翻译错了，用户会以为是那个 CLI 坏了——这类缺陷最难归因，因为它在 CLI 自己的终端里复现不出来。而且**代价是双份的**：不像终端不仅让用户理解不了，也会推高我们自己的复杂度——每偏离一次，就要为这个偏离补一层解释、一处特例和一条它自己的回归，而照着终端既有的约定做，这些都不必存在。所以"像终端"是省复杂度的选择，不是额外的工。
  - **多行粘贴是一次编辑，不是逐行发送。** 用户澄清「终端内 Codex 输入框，没按 shift」「粘贴多行，每行都被拆开」。整段文本必须作为一次粘贴进入原输入框，保留换行、空白与末尾换行，不附加提交动作；原生粘贴与右键粘贴遵循同一约束。恢复后的终端模式未知不能把已声明接受粘贴协议的 Agent 降成逐行 Enter。Provider 拥有它接受的文本输入协议，Core 兑现；普通终端的粘贴仍由终端库按真实模式编码。不能按 Provider 名称在界面猜模式，不能强开终端模式，也不能改变普通 Enter 的原生语义。
  - **Shift+Enter 换行，不提交**。终端默认对 Enter 与 Shift+Enter 不可分辨（都送 `\r`），所以"分得开"必须由我们**显式**兑现：拦下这个键，在下游 TUI 已协商 kitty keyboard 协议时送 CSI-u 编码（`\x1b[13;2u`），否则退回 `\x1b\r`。协议是否生效要从该 TUI 自己的输出里**探测**，不能假定、更不能强开——强开会让没协商过的 TUI 收到一串它不认识的字节。
  - **能用鼠标选中并复制，而这条能力真正的敌人不在复制这条路上**。终端里的选中/复制是读日志、抄报错的基本动作。用户会用四种不同手势触发它，它们是**四条独立的路**、不是一条路的四种叫法，所以要**分别**守：**拖选**走 xterm 原生选择；**右键菜单 Copy** 只在有选中时可点、点下去走复制动作，且右键前先快照选中（菜单夺焦会清空 xterm 的实时选区）；**裸 Ctrl+C** 有选中时复制、无选中时把键原样交还终端（那一刻它是 SIGINT）；**⌘C（mac）／Ctrl+Shift+C（其他平台）** 走注册表和弦复制。四条路都要在，因为它们覆盖不同的肌肉记忆——少一条用户就会说"复制坏了"。
  - **根因几乎总是选区从一开始就没建立，不是复制那一步失败**。这四条路**同时**失效过好几轮，正因为它们全都以「有没有选区」为闸：PTY 里的全屏 TUI 一开鼠标上报（DECSET ?1000/?1002/?1003，或旧式 ?9），xterm 的 `onProtocolChange` 就 `this._selectionService.disable()`——此后一次平白左拖被直接让给程序，`getSelection()` 恒空、`hasSelection()` 恒 false，四条路一起断。判据是 xterm 的 `areMouseEventsActive`（events≠0）：五种鼠标上报模式里除 `none` 外的四种都让它为真。所以「复制又坏了」几乎从不是复制的锅，**先查选区服务有没有被鼠标上报关掉**（机制逐字读 vendored 的 @xterm/xterm 5.5.0，收在 `lib/terminal-selection-mode.ts`）。
  - **选区被关掉时必须把逃生手势说给用户，而这句提示与让它生效的配置是同一件事、必须一起动**。xterm 的逃生阀是 `shouldForceSelection`：mac 上按住 ⌥ Option 再拖、其他平台按住 Shift 再拖。mac 那条**只在** `macOptionClickForcesSelection: true` 时才真的管用（配置在 `lib/terminal-theme.ts`），提示文案却在 `lib/terminal-selection-mode.ts`——两个文件、一件事。谁把配置关掉却留着「按 ⌥ 拖」的提示，就是在教用户做一个不生效的动作，且全程无报错；反过来开着配置却不提示，等于配了一个没人发现的逃生阀（这正是最初那轮"划词选不中又没有任何解释"的形态）。所以这两处要由**同一道**守卫同时读到：提示宣传 ⌥ 手势，当且仅当配置真的开着。
  - **平台差异要说准，不许把没验过的当已验**。复制手感只在 **macOS** 上实测过。两条经查证的平台事实不得再被复述反：**mac 上 ⌘C 不经过 Ctrl+C**（是两个不同的键），且非 mac 上「无选中的 Ctrl+C 发 SIGINT」是**刻意**的、不是待修 bug——改掉会让用户在终端里中断不了跑飞的程序。Windows/Linux 的复制与逃生手势（Shift 拖）接线在，但**当作未验**，别在文案或注释里写成"两个平台都验过了"。
  - **写空剪贴板比没复制更糟**。xterm 对「有没有选区」给两个判得不一样的答案——`hasSelection()` 是纯坐标、`getSelection()` 走 trimRight 之后的文本；在空白处横拖时坐标有区间而文本是空串。此时若照样「复制」，写进剪贴板的是空串，**把用户上一次复制的内容静默抹掉**（剪贴板出口只在 IPC 抛错时报，写空串是它的正常路径）。所以认领复制的条件是**文本非空**、不是坐标有选区；而且「读哪份选区」与「写哪份进剪贴板」必须是同一处判定，不许各判一遍——分开判正是这条分岔被引爆的方式。
  - **粘贴的所有者是原生 Edit→Paste，不在这里复制第二遍**。xterm 的 `attachCustomKeyEventHandler` 返回 false 不会 preventDefault，原生路径照旧触发；在这里再处理一次 Cmd/Ctrl+V 会把同一份剪贴板文本贴两次。
  - 这几条**易错且回归无声**，因此验收落在**可观察结果**上——送出的字节、写进剪贴板的内容、菜单项可不可点、提示说了哪个修饰键——不是「某个 handler 存在」；断言 handler 注册过，在 handler 写错时同样会绿，源码文本 grep 也一再被换个拼法绕过。**验收规则：对终端键盘/鼠标处理的任何改动，在每一种复制手势都各有一道「把它的承重条件取反就变红」的守卫之前，都不算完成**——右键 Copy 的可点与动作接线、裸 Ctrl+C 的两侧、⌘C/Ctrl+Shift+C 的注册表和弦、拖选逃生手势与其配置的耦合、以及「文本为空却写剪贴板」这一刻，各自都要有一个把它的承重条件取反就变红的靶子。缺哪一个，就是那一条路下一次静默失效的入口。
Desktop 刷新或重新 Attach 时优先投影这份 Agent 语义；新的 Run `running` 事实只更新进程态，不能覆盖 `working`、`waiting`、`blocked` 或 `done`。Run 退出或中断仍由进程事实结束当前可交互态。
- Approval/Question 卡片只渲染 Core 的 typed request，选择后只经 typed IPC 调用 Core 的 semantic response API。Renderer 不解析 `status.detail`，不发送裸 ESC、数字选项、普通 Prompt 或 raw PTY fallback。Run interruption 使用独立 typed reason 控制恢复分支，`status.detail` 只做人类可读展示。Permission request 携带 Provider **声明**的每一个 scoped option（allow-once、可选 allow-always、deny），与 launch option 同构地在紧邻 interaction protocol 处按 Provider 声明，沿用相同的 DESCRIBE/CONTRIBUTE 拆分：兑现某一行的按键（`input`）只留在 Core，DESCRIBE 半边（id/label/kind/description/tier）跨 IPC 供 Renderer 渲染；回复时按用户实际选中的 option 解析出它声明的按键，绝不固定发 '1'。只声明位置**稳定**的行——Claude 的三行提示（Yes / Yes 并不再询问该工具 / No）行 2 位置不变，故 Claude 诚实获得 live 的 allow-always；Codex 的中间行按命令/主机/文件动态出现和重排，故其 live 列表只保留 allow-once 与 deny，更激进的 auto/never 姿态由既有 launch option 在启动时提供。只有 codex 与 claude 走到这条 permission 管线（其余 Provider 为 `none` | `observe`）。当前 Question 的结构化回答只展示 Core 已验证的单题单选能力；自由文本、多题、多选或不能验证的选项仍保留精确原生问题观察，显示能力缺失原因与原终端入口，不合成选项，不用普通 Prompt 冒充回答。
- 待处理 interaction 出现时，卡片负责结构化回答；Composer 保持挂载和草稿，普通 Prompt 按 Session/Run/View 合同排队。Agent Terminal 的原生键盘、鼠标、粘贴和协议回复仍能操作健康 Run。卡片提交只有在 Provider delivery 与 Core settlement 完成后才显示成功；失败保留明确错误，不提前消失。`working` 时 Composer 的主动作是打断当前回复，它**中断当轮**并调用 Core semantic interrupt；Run 与 session 继续存活。**终止整个 Run/session 是另一个动作，位置在 Tabbar**（Run owner 的既有动作）。两者对象不同，不得合并、不得共用措辞：把打断写成 "Stop" 会被读成"我会丢掉整个 session"，从而让用户不敢按一个本该轻量的动作。打断的可访问名与 tooltip 都必须说的是"当前这一轮"。它的位置与权重不随 steer 改变，避免用户在 Agent 跑动中误按。启动姿态（sandbox/approval/permission-mode）只在 Launcher 一次性设定；Composer 上的 live permission 控制有且仅有两条诚实通路：其一是用更宽的 scope 回答挂在 agent-input-stack 上那张 pending request 卡片；其二是 Provider 声明了**可寻址**的 in-band posture 控件时（见下文 posture control），在 Composer 上直接切到某个具名 mode。两者都经 PTY-input 通道兑现运行中进程的自有 affordance——启动 argv flag 永不作为 live composer 开关出现，因为它对运行中的 PTY 进程静默 no-op。
- 原生问题或权限已经完成且没有在途 typed 回答时，旧请求卡必须由 Core 按 Provider 确认的同一 Run、同一种请求、同一原生调用身份结算；不能继续拦住健康终端或拒收下一道问题。已有 typed 回答 claim 时，仍由原有投递回执结算，原生完成通知不得删除 claim 或替下一题确认输入。`working`、无关工具、子 Agent、缺失关联、旧 Run 或重复完成回执都不能替代精确结算；原生完成只说明该请求已结束，不代表选择了任何答案，也不代表由 AgentMux 批准权限。缺少可验证关联时如实保留请求，不猜答案或补写历史身份。用户已在原生终端输入且投递已接受或结果未知时，旧卡片显示“原生处理待核实”与真实终端入口，停止对这张旧请求再发结构化回答；这不阻断原生终端，也不停止 Run。明确 not_applied 不改变旧卡片的可回答性，自动协议回复不产生这项状态。原生输入回执只归属于调用时捕获的 Session、Run 与 requestId；等待期间请求或 Run 改变，迟到 ACK/unknown 不写入新请求。相同原生调用的真实完成或 Provider 已声明且有行为证明的 supersede 才能使旧观察收口；不同的新 requestId 本身不是旧请求完成的证据。未能确认旧请求结束时，新的原生请求仍按精确身份保存为观察，不能拒收 Hook 或阻断健康终端；多条尚未结算的观察不能伪装成当前可回答的单一请求。旧 typed claim 不被伪确认，旧回答不得重绑或清除新请求。原生输入及其待核实事实随原 Session/Run/request 持久保存，重启不自动重放输入或被原生输入取代的旧 typed claim。
- Core 请求快照的新旧只由 Core 会话记录自身的时间判定；进程、终端和时间轴的较新活动不能让有效请求被丢弃，也不能使旧请求覆盖新请求。最近活动仍按原有事实显示和排序。
- Composer 表面不使用描边，靠比所在 Region 高一档的 Surface 填充与顶部高光表达层级，不使用黑色填充或黑色投影；focus 由 `--focus-ring` 加一道 inset `--focus-line` 承担（详见密度合同的控件语言）。Approval/Question 卡片同样不用描边——原先的理由是"描边会与紧邻其下的 Composer 争夺同一条边界"，Composer 去掉描边后这条争夺已不存在，但卡片依旧靠实心 Surface 填充与 elevation 承载重量，并以一枚琥珀 STATUS 图标表达"需要注意"这一状态，也不用常驻的彩色边（accent 表达状态，不作装饰）。卡片内的动作是同一种等高按钮，图标与文字共享中轴；allow-once 是唯一实心品牌绿主操作（最安全的肯定动作才承载最重的分量，绝不让最宽 scope 的按钮成为主操作），scoped 升级为 secondary 并以一枚克制的 tier 圆点表达风险状态；deny/dismiss 分置一侧，Dismiss 是退出而非裁决并降为 ghost 权重。option 数≥2 个 allow 时，allow 采用 CLI 自身的竖排编号节奏，否则保持紧凑动作行。
- Composer 的附件与粘贴图片都产出**路径引用**，由 Agent 自行读取，Composer 不内联文件内容。这是运行时事实决定的：prompt 通道是有字节上限的纯文本，且当前没有 Provider 走 ACP，不存在把二进制送进模型上下文的通路。粘贴的图片由 Desktop main 落盘（渲染进程只提供字节，不指定写入位置与文件名），再以与附件相同的引用形式进入草稿。工作区内的路径写成相对路径，因为那才是 Agent 的工作目录能解析的形式。
- 引用当前打开文件的快捷方式只在确有打开文件时出现。它是快捷方式而非第二条附件通道，没有可引用对象时隐藏，不以禁用态占位。
- Terminal 使用 xterm 的真实字符网格、DPR 和 TUI 输入。Agent Terminal 的 xterm TUI 输入与 Agent Composer 是同一 Agent 的两条明确输入路径；Raw Terminal 只保留 TUI 输入。
- **切回一个已经打开过的终端不得重放"Restoring terminal…"**。切 Tab 不是重新连接：一个已经 attach 上、字节已经在屏上的终端，切走再切回应当就在那儿。当前每次切换都闪一次恢复态，是因为非活动 Tab 的终端视图被卸载、xterm 实例被销毁，切回时从零重建并重放。修法在**保住实例**而不在加速重放：不可见的终端**保留其 xterm 实例与 attachment**，切换只改变可见性。据此有三条边界：**不可见的终端不做布局与渲染工作**（否则保实例换来的是持续开销）；**实例的存活边界是 Region 的存活边界**——Region 真的关掉时实例必须销毁，不建第二个绕过 Region 生命周期的缓存池；**恢复态只在真正需要重放时出现**（首次 attach、断连重连、replay gap），它仍是一个诚实信号，不能因为"看着烦"就删掉。
- **切回终端时，恢复工作必须让出渲染主线程并优先保持界面可操作**。保留的 xterm 实例在首次 attach、断连重连或 replay gap 时仍要按顺序重放 retained bytes，但重放必须以有界批次调度、批次之间让出宿主事件循环；不能把一个大 scrollback 变成一次不可抢占的 parser 工作。恢复期间输入门控可以如实保持关闭，直到 replay→live 边界完成，但切换、关闭、服务窗和其他界面操作不能被输出回放饿死；live backlog 也必须合并/有界，不得形成无穷串行写队列。这个约束只由 AgentMux Renderer 负责，ctxmux 继续是 replay 与 ordered bytes 的权威来源。
- **切回终端不得把用户的视口从顶部滚回到底部**。用户离开时若正在看最新输出，回切应继续停在最新输出并跟随后续输出；用户主动向上翻阅时，回切应恢复上次的滚动位置，不得强制跳到最新或展示一段从顶部滚下来的回放。首次建立、真正重建或没有可恢复的视口记忆时，默认直接显示最新输出；视口记忆属于该 TerminalView 的展示状态，不进入 ctxmux、Run 或 Session 真相。
- **RuntimeEvent 的边界不是终端的视觉帧**。TUI 输出可能被底层拆成很小的连续事件；TerminalView 必须在有界窗口内合并连续 live bytes 再交给 xterm，让一个 TUI 更新尽量一次绘制，同时在批次之间让出事件循环。不得为了追求响应而把每个字节逐事件写入、让用户看到逐字蹦出的假动画；也不得取消有界让出，令大段输出重新饿死切换、输入和关闭。
- **多个 Agent 的 terminal capability 探测互不阻塞**。每个 Run 的探测超时只允许把该 Session 标成 `unknown/degraded` 并继续提供 prompt；不能按 Session 串行等待十秒，导致后面的健康 Agent 一起等候或重复看到 capability failure。探测可以并发，但每个探测的 attach、超时、退出和降级事件必须绑定精确 Run，不能扩大到共享连接或其他 Session。
- Terminal 链接只在手势确实是**主键点击**时才响应：指针位移超过阈值或留下选区，都判定为选择文本而非点击链接——拖选跨过链接不得触发打开；右键只属于上下文菜单，不能同时打开 URL、文件或系统产物。用户反馈「Terminal 链接 hover 浮窗设计差、现在一点直接跳转」：HTTP(S) 普通点击必须先显示目的地选择，只有平台的 Cmd/Ctrl 点击才系统直达；文件路径保留既有文件出口，不因修饰键改走网页出口。
- Terminal 链接悬停只被动显示目标与打开方式；经过链接时不立即弹出遮住正文的浮窗。读出贴在当前 Region 的边角并在窄栏内收敛，避开被解释的链接行，不跟随指针遮住相邻正文；开始选择、滚动、离开链接或隐藏 Region 时清除，也不能在延迟结束后重新冒出。提示不抢焦点、不吃指针，不改变终端网格、attachment 或健康 Run。
- **裸 URL 的可点击范围不能吞掉相邻的中文正文或中文标点**。终端输出经常把 URL 紧贴在 `。`、`，`、`：`、右括号或下一段中文后面；这些字符不是 URL 的一部分，不能被下划线、悬停预览或目的地菜单一起带走。裸 URL provider 必须在链接边界处排除 Unicode 中文标点及 CJK 文字，并保留合法 URL 内实际需要的 ASCII 路径、查询和片段字符；OSC 8 的范围以它声明的链接区间为准，不用这条裸文本启发式重新裁剪。该边界由纯函数/可观察链接文本回归测试守住，避免只测“handler 已注册”而漏掉范围错误。
- **一个 http 链接在终端里有两种表示，它们由两条互不相干的 provider 处理，必须都接到同一个出口。** 用户原话：「哦 所以和我们接入的是两类不同的链接是吗?」「那这个在我们的需求文档里重点说明, 需要有多类链接接入吧」。两条路是：**裸文本 URL**（终端只是打印了字符，靠我们的正则识别）由 `WebLinksAddon` 拥有，activate 由我们传入；**OSC 8 超链接**（终端用转义序列声明"这段文字是个链接"，Claude Code 就这么输出）由 xterm **内建的** `OscLinkProvider` 拥有，它的 activate 取自构造选项 `terminal.options.linkHandler`——**不设这个选项，它就落到 xterm 自己的 `defaultActivate`：一个原生 `confirm("…could potentially be dangerous")` 加 `window.open`**。加上文件路径那条自有 provider，终端一共三条 provider、两个 http 入口。
  - **这一族缺陷的判据是「出口个数」，不是「这个动作有没有被处理」。** 实测教训：OSC 8 那条从功能落地起就没接过线，而裸 URL 那条一直是好的——于是"点链接出选择器"在开发中每次手验都通过，用户看到的却是浏览器厂商的告警框，**界面上没有任何我们的字符串**，因此源码 grep 与包内 grep 都搜不到异常。13 个并行 agent 全部漏掉它，因为他们各自追的都是那条已知的路。同一个概念有两个入口时，只接一个**不会让另一个变红**。
  - **这条要求的前身正是本文件此前的一句错误分类。** 旧文写的是「链接分两类：http(s) URL 由 web-links 拥有；文件路径由独立 provider 拥有」——分类轴选在了"URL 还是文件路径"上，于是"同一个 URL 有两种终端表示"这件事在需求层面根本不存在，实现漏掉它是被文档授权的。**枚举"某物有几类"时，先问这个轴是不是唯一的轴。**
  - 两条 http 路共用**同一个** activate 函数（不是两份各自实现）：手势守卫、Cmd（非 macOS 为 Ctrl）+点击直连系统浏览器的快路、悬停预览、目标选择器全部同源。两份手抄必然在"什么算点击""快路按哪个键"上无声漂移，而漂移的症状只是"这个链接点了没反应"，没人会报。
  - 文件路径由一个独立 link provider 拥有，普通点击在编辑器 Region 打开该文件。
  - **推而广之：凡是依赖同时提供「插件式注册」与「构造选项/全局默认」两条配置面的能力，都要显式确认两条都归我们。** 依赖的默认行为跑在依赖的代码里，它的输出不含我们的任何标识，对我们这一侧的任何文本检查都是隐形的。
- Terminal 文件路径识别是**纯语法、保守**的：检测在 xterm 渲染/悬停热路径上运行，只做字符串工作——读 xterm 已持有的那一行 buffer 文本并用纯函数匹配，热路径上没有磁盘或 IPC，更不做存在性探测。规则的关键判据是「core 含 `/` 或带 `:line` 后缀」，据此丢弃裸词（`e.g.`、`1.2.3`、`README`）却仍捕获 `README.md:3:1` 与真实相对/绝对路径；绝对路径仅当落在活动 Workspace 根内才识别，`~/`、逃出根的相对路径不识别。识别出的路径归一为 Workspace 相对路径，交给与 Explorer 同一个 `openFile` seam 打开；带 `:line[:col]` 时通过一次性 reveal target 落到该行。误报或不存在的路径在点击打开时经 reportError 明确失败，绝不静默——「点击开不出来」而非污染状态。相对路径按 Workspace 根解析（非终端 live cwd）。
- **Activity 里 Markdown 引用到的项目内文件同样可点开，走的必须是同一个 seam**。用户原话：「在对话中的 Markdown 解析中，如果有些引用的是项目内的文件，点击时要支持打开（就像在文件系统中点击的一样），同时在文件导航中也要指向并打开该文件」。这句话有两半，第二半是关键：**"在文件导航中指向并打开"不是要新写的第二个功能，而是复用既有 `openFile` 的自然结果**——`openFile` 会更新该 Workspace 的 last active file，Explorer 据此自动展开祖先、选中并滚动到该行（与 Terminal 点击路径、Explorer 自身打开文件完全同一条通路）。反过来说：任何"就地开个 Tab"的手写实现都会**静默丢掉用户明确要的第二半**，而且丢得没有任何报错。这就是此处只许复用、不许另起一条的全部理由。
  - **归一化与根内约束复用 Terminal 那份纯函数**，不写第二套路径解析。判据、拒绝规则（裸词、`~/`、逃出 Workspace 根的相对路径、根外绝对路径）与 `:line[:col]` 的一次性 reveal 全部同源；两处若各有一份，会在"什么算路径"上无声漂移，而漂移时误判只表现为"这个链接点不动"，没人会报。
  - **分流点只有一个**：一个引用要么是 http(s)（既有 `openExternal`，Main 裁决 scheme），要么是 Workspace 内的文件（`openFile`）。**今天所有 Markdown link 一律送进 `openExternal`**，于是 `[x](./src/x.ts)` 会被丢给系统浏览器——这是现状的缺口，不是新增能力的边角。分流写成纯函数，不在渲染组件里分支。
  - **要认的主要不是 Markdown link，而是行内 code 与正文里的裸路径**。Agent 写路径时几乎不写成 `[](…)`，写的是 `` `src/foo.ts` `` 或直接散在句子里；只处理 link 语法等于对真实输出基本不生效。这决定了识别落在 inline 节点上而非只看 `href`。
  - **注入而非 import**，与既有 `openExternal` 同形。`AgentMarkdown` 是无 Store 依赖的纯组件，直接 import Store 或 api 会让每个渲染回合的测试都要先记得 mock——那个坑已经付过一次调试代价。
  - 验收落在**可观察结果**上：给定一段 Markdown，分流函数对哪些 token 判为文件、判成什么归一路径。断言"某个 handler 挂上了"在 handler 写错时同样会绿（测试栈是 `renderToStaticMarkup`，本就跑不了 effect、点不动 DOM），所以载荷逻辑必须是 `lib/` 里的纯函数。
- Terminal 主题只属于 Desktop Renderer。ctxmux、RunSpec 和 Core 公共合同不出现主题字段。
- Renderer 负责把最新 `cols × rows` 通过 Core 公共 Resize 提交给 ctxmux；resize 热路径只保留一个在途请求和一个最新 pending size。
- 中文输入法在终端内连续输入、移动光标后再次组合和确认候选时，每次确认只交付一次本次文字，不能重发先前内容；组合期间不能被应用快捷键截走。持续输出、分屏尺寸变化与字体变化不能使终端画面损坏到必须手工缩放才能恢复。参考最新版 reference project 的成熟处理，但适配本项目唯一输入出口和 ctxmux 尺寸权威，不复制另一套输入或 Runtime。
- “Earlier scrollback is unavailable” 必须区分历史缺失与当前屏幕重绘。Redraw 只请求当前屏幕重画，不能恢复已经丢失的历史；执行成功、无法执行和失败都必须有可见反馈。成功请求后收起整条提示为可悬停查看历史缺失原因的小标记，不能一直占据顶部让人误以为按钮没生效；新的 Run 或新缺口重新提示。
- Replay、Live、Gap、ACK 与 Attachment lease 均服从 ctxmux/Core 的 ordered-byte 合同，View 不建立补偿状态机。

### Durable Runtime 健康

- **状态库达到物理容量上限时不能把恢复流程伪装成 readiness 超时。** ctxmux 仍是容量与无损恢复的唯一 Owner；Desktop 必须保留已持久化的布局、Session 与 Run 投影，并把 `disk-full`/`database-full` 这类可行动诊断固定在服务窗。压实、备份或重试失败时不得删除 Session、回放或布局，也不得让后续健康 Agent 因一次启动失败被静默挡住。
- **退出与 Host 重配置的 attach 门禁必须有明确终局。** 退出清理只拒绝新 attach 到正在销毁的 Host；清理完成后门禁必须释放，清理失败也必须回报“退出未完成”并允许恢复动作。真实重配置、退出中间态和 Agent 故障分别投影，不能用一个永久的 `Runtime host is being reconfigured` 拒绝所有健康 Session。

- **打开 Terminal 不得被一次瞬态 WAL checkpoint 争用永久阻断**。ctxmux 是 WAL、SQLite durable state 与 persistence actor 的唯一 Owner；AgentMux 只消费它公开的可用性结果，不在 Desktop 另建 checkpoint、截断或修复逻辑。
- **可恢复的 busy 不是永久失败**。当 WAL checkpoint 因短暂 reader/attachment 争用未能归零时，ctxmux 必须在有界窗口内重试并继续 FIFO 写入；一次可恢复的 busy 不得把 persistence actor 锁存在 `durable state rejected`，也不得让后续 Terminal 创建或 semantic resume 永久失败。
- **合法写入不能被 WAL 自身增长限额永久堵住（，P0）**。用户实际遇到「ctxmux durable state rejected a mutation: ctxmux durable state is corrupt: WAL exceeds 16 MiB」。WAL 是唯一 Native owner 可安全回收的提交日志，物理长度超出运行预算不等于 SQLite 数据损坏。持续合法输出与可恢复状态须在有界内存、写入和回收成本下继续推进；输出准入要包含实际修改、裁剪与索引页的工作，不能只按新正文大小估计后在提交成功时把健康 Runtime 永久锁死。真正的完整性、权限与 I/O 故障仍按原事实区分；不得盲增阈值、吞 corruption、删除或截断用户 WAL、迁移格式，或建立第二个修复 owner。原有字节、durable fence、Run 身份和健康输入保持；已有持久化故障时，升级不能以停止健康 Run 换取解除锁存，无法证明安全交接就保留旧服务并说明限制。现场原因与隔离复现分别绑定，局部通过不能声称当前用户错误已消失。
- **真正的数据完整性或不变量失败仍需 fail closed**。无法确认 WAL 已安全回收、SQLite 报告 corruption、磁盘空间不足或 checkpoint 在有界窗口内持续失败时，界面要保留原投影并给出可操作的服务窗告示；不得静默丢掉 Run、Session 或布局，也不得手工删除/截断用户状态。
- **健康边界必须可观测**。ctxmux 对外给出可区分的 recovered、busy-retry-exhausted、disk-full 与 corruption 结果；Desktop 的 Terminal/Resume 入口沿用同一结果分类，不把所有底层错误折叠成“Agent resume unavailable”。
- **持久化故障回归必须是隔离注入，而不是破坏宿主**。测试在临时 state-dir 中注入一次可控的 SQLite I/O 失败，验证 mutation 的失败分类、后续写入的边界以及 daemon 重启后的恢复；不得填满宿主磁盘、触碰用户 runtime、杀掉宿主应用或把测试故障伪装成真实用户数据损坏。
- **ctxmux 的 daemon、CLI、SDK 与 manifest 必须作为同一个精确 artifact 升级**。协议代际变化由 ctxmux SDK 在 Core 私有适配边界解码，Desktop 与 Core 公共 API 继续只看 ordered bytes；不得只替换 binary、混用不同 protocol 的 SDK，或为了保留旧代际在 AgentMux 维护私有 backport/兼容层。

### Browser 工作面

- Browser 是 AgentMux 内的一等工作面，不是外链跳板：它可导航、可标记、可被 Agent 安全消费，且生命周期与权限事实**只由 Desktop Main 持有**。Renderer 既不拥有 WebContents，也不持有第二份导航或权限状态。
- **Browser 是 Agent 自我改进的观察—行动—复盘闭环。** Agent 读取结构化页面事实，执行语义动作，得到页面变化与失败结局，再把这一轮沉淀成可检查的操作记录和可复用脚本。`browser.run` 的 CLI 是这个闭环的公共入口；每一步都必须有可读结果，不能只有“脚本退出 0”。
- **Agent 操作是 Browser 的一等活动。** 一轮操作有稳定的 operation identity、发起 Agent、目标 Browser、脚本/步骤摘要、当前阶段、结果和时间；Desktop Main 是事实 Owner，Renderer 只投影。驱动开始、动作派发、页面观察、权限等待、用户接管和结束都进入同一条有序记录，不能另建一份只供 UI 使用的“操作状态”。
- **交接必须先让人看懂，再让人接手。** Browser chrome、Tab 标记和页面内提示同时表达“哪个 Agent 正在操作哪一页、当前做到哪一步、下一步会触发什么”。人点击、输入或滚动后，Agent 动作立即停止并返回 `stopped`；恢复必须由人明确发起，不能靠 Agent 重试夺回页面。用户主动把控制权交给 Agent 时，要看到目标、脚本摘要和可停止出口。
- **操作记录可以变成脚本，但不是坐标录制。** 回放资产由语义步骤（观察、ref、导航身份、动作、等待、结果）组成，保留页面身份检查、权限/外部应用交接和不可逆动作的人工闸门；不录入密码、Cookie、原始敏感输入或屏幕坐标。回放默认先预览，执行中可逐步暂停，页面身份不符或结果不确定时停在服务窗。
- **人工闸门是操作记录的一部分，不能靠跳过它让回放变绿。** 敏感输入、带私密参数的导航、未审查代码与协议调用在计划中保留原来的步骤位置和阻断原因；隐去原始值后需要重新确认，不能删除步骤或把地址改成另一个地址后继续执行。失败、不确定和记录裁剪造成的缺口同样必须可见。
- **Agent 身份和操作位置必须同时可见。** Tab/Browser chrome 显示 Agent avatar、名称和驱动状态；页面内用不遮挡内容的语义目标标记表达当前 ref/动作位置，脚本生成或等待时显示对应阶段。颜色只作辅助，头像、名称、动作名和目标语义必须能独立说明是谁在做什么。
- **Browser timeline 与聊天 Activity 共用时间语义。** Browser 面提供可展开的操作时间线，能按轮查看脚本、观察、动作、结果、接管和失败；它复用同一条时间轴和状态词，链接回页面快照、脚本行和可重放入口。时间线缺口、页面导航和人接管不能被折叠成“完成”。
- **历史可达，记录失败可见。** Browser 重建或应用重启后，历史操作仍可从 Browser 的历史入口找到；恢复的记录明确表示中断或不确定，不伪装成正在执行。记录加载、保存或投影失败只降低记录能力，不阻断健康页面或 Agent；对应 Browser 持续显示失败步骤、当前仍可用的能力与恢复动作，不能静默变成“没有历史”。
- **退出应用或恢复失败不能把 Browser Region 当作用户关闭。** 正常退出只释放原生页面资源，保留原 Browser 身份、Tab、Region、焦点与分割布局；重复恢复同一身份返回原页面的真实状态，不重新导航、不更换 Profile。恢复握手、页面创建失败或原生 owner 意外消失时，同一 Region 保留地址与可执行的 Retry，并在服务窗说明失败步骤；Retry 重新取得同一页面 owner。只有明确的关闭事实才移除该页面投影，资源释放、重复握手与未知恢复结果都不是关闭授权。普通进程重启必须验证原工作面仍在且页面可恢复，其他健康工作面不受影响。
- Browser 驱动脚本的 `cdp(method, params)` 是明确的逃生口：Main 必须把 CDP 的成功结果原样交回脚本，并把协议异常作为失败浮现；不能把它变成静默 `undefined`。它是 Agent 自行补齐尚未封装浏览器能力的正式通路，正向结果和异常结果都必须有行为守卫。
- **New Browser 必须有可见结果**。在聚焦的 Universal Pane（包括当前不是 launcher 的非启动器
  Region）点击 `New Browser` 后，必须创建并显示一个 Browser Tab/Region；如果 Main-owned
  Browser 创建失败，必须在同一工作面给出确定性、可执行的错误。按钮不得在状态、Tab、Region
  和错误提示都不变化的情况下静默 no-op；renderer regression 要覆盖聚焦非 launcher pane 的
  Tab/Region/browser 状态变化或错误投影。
- 页面**元素选择**产出结构化上下文——tagName、role、可访问名、selector、文本、邻近文本、白名单属性与净化后的 HTML——并以文本形式进入 Composer 草稿，与其他附件同一条通路。净化在 Main 侧完成，Renderer 不把原始 DOM 当证据传递。当前**不采集 computed CSS**，截图也**只进剪贴板、不并入 prompt**：这两点是已知边界，不以"看起来完整"的措辞掩盖。
- Agent 发起的元素上下文通过 Browser drive 的显式 `elementContext(ref)` 入口提供：目标必须来自当前 Browser snapshot 的授权 ref，经 Main-owned CDP 句柄解析；入口只能读取结构化字段（tagName、role、可访问名、selector、文本、邻近文本、白名单属性、净化 HTML），不能返回原始 DOM 或执行事件。入口与人工选择是两条有意分开的能力：人工选择继续由真实 `event.isTrusted` 门禁保护，Agent 入口不得删除或绕过该门禁。
- `elementContext` 失败必须保持可区分：ref 不在当前快照、ref 解析后不是 Element、页面导航/句柄失效和提取/净化错误分别给出可行动诊断；不能静默返回空对象或把失败伪装成 Agent 没有权限。读取结果沿 Browser drive 的 typed receipt/Composer 通路交付，不能在 Renderer 另建一份 DOM 事实。
- 截屏与标记编辑属于 Browser 自己的工具，产物是可验证证据而非装饰：标记后的图像仍是同一次观察的产物，不重建第二份截图生命周期。
- 链接打开使用统一的**目的地菜单**（当前 Region / 分屏 / 新 Tab），与 Terminal 链接共享同一套目的地语汇，不让浏览器另发明一套打开语义。
- **Agent 正在驱动某个 Browser 时，不切过去也要知道是哪一格。** 页面内角标只在人看着那一页时成立，
  而人恰恰是"在别处干活、想知道那边跑到哪了"。所以标签上的 Browser 标记在被驱动期间要与闲着的
  Browser **画得不一样**，且这条差别是标记去重的一部分——两个 Browser Region 一个在被驱动一个没有，
  标签上必须画两个，折成一个就是把"哪一格在被驱动"这条信息折没了。驱动是**瞬时事实**，随运行开始
  和结束，绝不进持久化：重启后复活一个"正在被驱动"的死标记，比不画更糟。
- Browser Profile 由 Browser Tools 导入，凭据与 Cookie 归 Main；导入路径落在 Workspace/Profile 约束内，逃出约束一律 typed 失败关闭，不静默降级到默认 Profile。
- **应用链接（非 `http(s)` 的 URL scheme，例如自定义应用 scheme 与 `mailto:`）要像一般浏览器那样交给系统，不能当成非法地址挡掉。** 用户原话：「对齐一般浏览器，假定用户会自己把本应用当做浏览器」。这类链接不能被静默吞掉，也不能因为某个站点的按钮形态而增加站点专用分支。约束：
  - **两条路的症状不同，必须分别处理。** 真机探针（Electron 43.3.0，`WebContentsView`，与生产同形：不设 `setWindowOpenHandler`）实测：
    - 页面内导航（`location.href = 'custom-app://…'`）走 `will-navigate`，被 `guardNavigation` 拦下并写进 `entry.error`，URL 不变。这一条**有**错误可显示。
    - `window.open` 与 `target="_blank"`（外部应用交接控件常见的形状）**不**走 `will-navigate`。Electron 默认行为是**真的开一个 `BrowserWindow`**：探针里窗口数 1 → 2 → 3，`did-create-window:custom-app://open` 各发一次。所以症状不是「被吞掉」，是**冒出一个应用管不着的空窗口**，而那个窗口既不在 Region 里、也没有工具栏、还不归 Browser 的生命周期管。
  - **那个缺席的 handler 是一次有意的决定，不是遗漏。** `649df3a2`（"preserve native popup semantics"）把它删掉，并留下 `browser-view-manager.test.ts:643` 钉住 `windowOpenHandler` 为 `null`。要改回去就得先推翻那条决定并改那条断言——不许绕过它，也不许假装它不存在。
  - **默认不静默移交，也不静默丢弃。** 一般浏览器在把地址交给另一个应用之前会问一次，并允许「以后都这样」。这里同样：每个 scheme 首次出现时问一次，记住选择；拒绝或失败要在同一工作面说出来，说到下一步为止。需要这一层的理由是能力边界——一个被访问的页面可以任意构造 `scheme://…`，无条件移交等于让任意网页拿用户选定的参数去启动本机应用。
  - **判定是纯函数，不是写在 Electron 回调里的语句。** 照 `window-security.ts` 的形状：那个文件的 docstring 记着两个**实测存活**的变异，都是因为判定住在回调体里、只能靠文本扫描守。这里的判定同样要能被单元测试直接质询，回调体里不留语句。
  - `mailto:` 属于同一类，不单开一条通路。
  - **公共机制必须使用协议事实而不是站点身份。** 生产代码、公共测试、设计文档和帮助文字不得预设具体站点、产品名、厂商协议、按钮文案或登录流程；测试交接时使用合成 scheme 和通用触发形态，至少覆盖两个不同形态。真实站点只能作为黑盒输入，发现问题时修复它背后的 URL、frame、系统交接或用户确认机制。

- **「把一个链接存成文件」和「打开一个存着链接的文件」是一般浏览器的既有能力，走标准格式，不自造。** 本机实测确认三种格式都被系统认得：`.webloc`（macOS，plist，键为 `URL`；`kMDItemContentType = com.apple.web-internet-location`，XML 与二进制 plist 两种皆可）、`.url`（`[InternetShortcut]` + `URL=`，CRLF；macOS 报 `com.microsoft.internet-shortcut`）、以及 Netscape bookmark HTML（`<!DOCTYPE NETSCAPE-Bookmark-file-1>`，每家浏览器导入导出都用它）。约束：单条链接的存取用前两者（`.webloc` 在本平台是首选，`.url` 只读即可），整批导入导出用第三者。存下来的文件必须能被本机 Finder 与其他浏览器直接打开——自造一份 JSON 就把这条能力关在了应用内部，那还不如不做。
  - 这是与应用链接移交**不同的闭包**，单开 Feature，不混进同一批验收。
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
- **Settings 是一个控制工作面，不是卡片墙。** 左侧只承担搜索和分区导航，条目保持单行、标题优先；当前分区的说明只在主区头部出现一次。主区先给出当前上下文和可用动作，再进入设置内容，避免同一标题/描述在侧栏和正文重复。
- **可操作内容与只读说明分层。** 能修改配置的区块使用抬起的 Surface；运行时说明、来源和隐私提示落在页面底色上，用留白和发丝线分隔，不使用装饰性品牌图标格伪装成主操作。
- Settings 的关闭动作始终可见；Escape 先清搜索，再关闭。窄窗口必须完整发现全部分区并用键盘选择，不能依赖用户发现屏外的横向条目，也不能牺牲正文与保存区。
- Agent Detection 以 Host 为键，由 Core discovery 统一投影到 Settings、Launcher 和状态面。
- 资源检索、常用/高级配置与身份约束统一归《设置页的信息架构》。

### 状态栏

- 状态栏是**整窗唯一**的跨 Session 汇总。每一项都必须是别处没有、且用户需要一直看见的事实；Tab 点、Board 列、Agents 工具各自有作用域，状态栏不重复它们。
- **活跃/待机计数按 Provider 分类展示**。「活跃」不是状态栏自己的定义——它就是 Board 的 working 列（`sessionBoardColumn`），其余一律算待机。同一个 `running` 的 Agent 绝不能 Board 判它在跑、状态栏判它待机；照抄一份 switch 正是这种分歧的来源，所以计数调用那一个函数而不是复述它。这与关注度汇总（`summarizeAgentAttention`：谁在等我）是刻意并存的两套口径，回答的是不同问题。零 Agent 的 Provider 不占位；全闲的 Provider 压低但仍在场——消失会让"这个 Provider 总共几个"失去出处。守护：`agent-status-bar.test.tsx`。
- **资源指标只在展开时采样**。折叠态不得触发任何进程扫描——一个常驻的全主机 `ps` 轮询会让空闲窗口持续耗电。展开后按固定周期采样，关闭即停。并发调用共享同一次进行中的采样（in-flight 去重），一次轮询风暴只产生一次子进程。
- **一次全主机扫描，按 pid 子树归并**。为每个 Agent 单独起一个采样进程，开销随 Agent 数线性增长；正确做法是一次扫描后按 run 的 pid 归并出各自子树，共享祖先按注册顺序只归第一个，避免重复计数。
- **只声明证据支持的口径**。输出字节速率就叫字节速率，不除以一个系数冒充 token/s——终端字节含 ANSI 转义与 TUI 重绘，与真实 token 数不成比例，一个无法验证的数字比没有这个数字更糟。
- **token 用量报累计量，永不报速率**。分子（token 数）必须由 Provider 自己报出：声明 `usage` 能力的 Provider 在 turn 收尾时由 hook 进程读一次自家 transcript 尾部，把这一 turn 的真实 token 数随既有回执带回（`AgentUsageCapability` / `AgentTurnUsage`，守护：`agent-usage-transcript.test.ts`、`agent-usage-capability.test.ts`；catalog 声明到 hook 环境那次注入由 `agent-usage-env-injection.test.ts` 守，断了它整条链会静默失效而其余全绿）。**而分母没有诚实的取法**：`tokens/s` 的分母（turn 墙钟时长）含用户思考、审批等待、工具执行、网络往返，是我们自己拼的、不可验证的数——真实分子除以编出来的分母，仍是编出来的数。所以接入之后也**不给任何速率**，只报「最近一个 turn」的累计量并在 UI 上明说是哪一段。这条口径的落点是**名册行**而不是状态栏：用量是每个 Agent 各自的事实，跨 Session 加总它没有意义（见上文"状态栏不重复有作用域的指标"）。三态各自不同且一态都不许塌成 0——报了用量、声明了但还没有一 turn（显示"不知道"）、根本不报用量（明说不报），守护：`agent-usage-display.test.ts`、`agent-roster.test.ts`。

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
- **默认 worktree 落在项目内，且只有一处出处**。为某个分支新建 worktree 时，默认位置是项目自身的隐藏子目录 `<项目>/.worktrees/<清洗后的分支名>`，而不是与项目同级的兄弟目录——它随项目目录一起被移动或删除、并出现在项目自身的文件树里，因为它本就属于这个项目；仓库卫生由后面的 clone-local `info/exclude` 约束。这条默认路径只由**一处**推导：Branches 面板取默认值、扇出取各 lane 的 worktree 根，都经同一个出处得出，任何调用点都不得再自行拼第二份默认位置。扇出把各 lane 建在其 worktree 根下，该根必须解析到同一个项目内 `.worktrees` 目录，不另立第二处真相。分支名先收敛为路径安全字符、空名回落为固定占位，使目录名不泄露分支里的路径分隔符。
- **项目内的 worktree 是工具产物，不能把用户仓库弄脏**。创建成功后，产品应把项目内 `.worktrees/` 根目录写入该 clone 的 Git `info/exclude`（幂等、可重复执行、已有内容和无换行文件都要保留），而不是修改用户跟踪的 `.gitignore`。这条卫生动作失败只提示降级，不得阻断已经成功的 worktree 创建；验收以真实 `git status --porcelain` 为准，而不是只检查是否发出了写入命令。
- **移除 worktree 前要把留下来的分支事实说清楚**。普通确认框必须明确签出目录会被移除、分支仍保留；若 Git 能数出相对权威 base 的独有提交，显示数量和分支名；若 base 只是猜测或探针失败，明确说“无法核实”，不得把未知伪装成安全。这个提示只帮助用户决定，不得因为探针超时或失败阻断移除；未提交改动仍由既有脏树保护单独拦截。
- **移除确认框的 retention note 必须到达最终正文**。生产者、IPC 和面板转发都不是完成标准，只有用户真正看到 note 才算闭环；未询问到时保持空白，探针明确给出“无法核实”时必须原样呈现。丢弃未提交改动的二次确认不得混入这条分支留存提示。
- 一路失败绝不掀翻其余：扇出返回逐路结果而从不为某一路抛出。区分三态——已启动、worktree 建成但 Agent 未起（明说 worktree 是否留在磁盘上，否则成为无主目录）、worktree 都没建成（无可清理）。逐路的部分失败经**既有** `reportError` 面浮现，不另建扇出专属的错误状态机。
- **分组是派生的，复用共享状态语汇**，不新建第二套。扇出计划把 lane 命名为 `<stem>-1`、`<stem>-2`……，stem 已经标识了这一组，因此比稿面从分支名推导分组，而不持久化 group id（持久化等于给分支名已经说清的事再开一份会漂移的注册表）。每条 lane 的状态点用与 StatusDot、关注栏同一套 class；点一条 lane 走与全局同一个 selectSession；"跳到最早观察到待办的一路"与关注栏"跳到最早的"同序。没有比较时整条 strip 不占空间。
- **留一路、拆其余**：用户指定保留的那一路，worktree 与 Session 原样留下；其余各路经既有拆除原语移除，不写第二套拆除逻辑。**脏树保护仍然生效**——有未提交改动（含未 `git add` 的产物）的那一路被拒绝、留在磁盘、留在记录集、并如实报告为 retained，绝不因为它没被选中就静默丢弃。要丢弃是逐路、显式的选择（`discardChanges`），批量收尾没有"一键丢弃所有脏 loser"的开关，因为那正是保护要消除的数据丢失杠杆。一路拒绝清理不阻断能清理的其余路。
- **扇出 v1 不自动合并胜者，不加入通用逐行批注**。扇出的状态比较与留一路、拆其余保持现有责任；已提交的两条分支差异复用下面 Git 源码控制的比较入口，不另建 Git owner 或 Review 系统。

### Git 源码控制与 PR

- **已经提交的两条本地分支也必须能比较**。从现有 Branches 工作面明确选择 A、B；默认看 B 从共同祖先分叉后的改动，也可明确选择 A 与 B 两个提交的差异。比较不签出、不改工作树、不创建 worktree，不触发 Agent。一次结果固定两个 commit 和实际比较起点；分支随后移动不能混入同一结果，显式刷新才产生新快照。
- **只读比较面仍是可寻址的真实 Region**。Control 用通用只读 view 表达这种工作面，不伪装成磁盘 File、Launcher 或 Agent，也不因它的存在让整个 Tab 无法 inspect。Git 快照与 blob 仍归 Desktop，Core 只持有通用 Region 身份。Tab/Region 地址沿用既有短的不透明身份并持久保存；比较的去重与逻辑身份由已有 Tab 中的完整快照和文件事实决定，合法长路径不能撑破地址协议，也不另建比较身份表。
- **比较先列小范围，再读取所选文件**。路径逐字保留，重命名旧侧使用原路径；只读取被打开文件两侧的固定提交。真实缺席才是新增或删除的空侧，读失败、无共同祖先、超限或桥不可用必须说明，不能当作零改动或暗换 HEAD。单个比较失败不影响其他编辑面或健康 Agent。
- **固定比较是独立只读工作面身份**。同路径的不同快照与普通脏编辑文档必须能共存，不对比较面执行文件 attach/save/watch。复用现有 Diff、Tab、Region、布局和持久化，只保存比较 descriptor，不保存 blob 或第二份比较注册表；重启先恢复原面与焦点，再读同一快照。对象不可读取时原身份保留并给出原因。

- **本地**：看到当前分支的改动（`status --porcelain=v1 -z`——`-z` 使 NUL 分隔、关掉 git 的 C-quoting，因此带空格、引号、换行或 CJK 字节的路径逐字到达，解析器永远不必解码），stage 单个文件、commit、结构化 diff、unstage、discard。**diff 读 blob 而非解析 unified-diff 文本**：旧侧取 `HEAD:<path>`、新侧读工作区文件，二进制由 NUL 扫描判定而非塞进文本字段；**读不到就是失败，不回落到 HEAD**——"读不到"正是渲染新增/删除文件的依据，被静默吞成空 diff 就再也分不清。
- **共享工作树的事故按案例回看**：并发 Agent 可以共享工作树，也可以共享 `git add`；别人的改动被一并带入提交本身不是失败，最终目标是所有 Agent 停止时 main 正确且协作吞吐最高。add 之后检查 `git diff --cached` 是为了知道本次提交的真实边界、识别半成品并及时协调，不是为了按作者拒绝内容。发现进行中的改动时不要用 `stash`、`reset --hard`、无明确范围的 `checkout` 或 `clean` 清场；自己的完整改动仍应尽快形成小提交。已发生的形状与证据集中在 [`docs/casestudy/`](../casestudy/)，这里记录约束，案例记录现象、根因和排查证据。
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

- 用户要求「很多 Provider 的实现不完整」，全面分析后对照最新参考实现逐家完善，尤其是 Agent 的 Session 分析、对话模式与 trace 观察。每个 Provider 的能力闭环必须分别可验证：原生 Session 身份与记录解析、完整对话与资源顺序、工具与推理等观察事实、恢复与交互能力不能只凭启动成功或 Hook 存在宣称完成。已有参考实现的能力应核验并复用；缺少协议依据时如实保留未知或不支持，不能把观察缺口变成健康 Agent 的阻断。完善任务按 Provider 分开验收，共享协议与展示只有一个 owner。
- 用户进一步要求「实现达到成熟产品级别，且交互体验和性能远超竞品，所有功能你自己也要测试后满意」。Provider 完善必须经实际使用链与独立复核验收，覆盖真实身份接入、重启后原 Session 与工作面、对话阅读、trace 展开与完整复制；测试通过不替代交互验收。阅读与刷新只处理目标 Session 的有界记录，不因其他健康会话增加扫描或轮询工作。竞品比较须在相同输入、数据规模与观测条件下有实测证据，不能将结构更简单或合成测试更快直接称为领先。终端连续阅读及成本底线仍以《Terminal 连续向上阅读历史》为唯一合同。
- 外部对照只提供对照证据，不是 AgentMux 的第二份 Provider 注册表。每个 AgentMux Provider 必须以真实可执行文件与真实运行回执为准，分别声明 launch、ready、Hook、permission、status、resume 与 reply-correlation 能力；未核实的能力保持未声明，不用 UI 对称性或终端字节推断补齐。
- 现有 Provider 的 parity 工作按能力闭环推进：Grok 与 Gemini 若二进制支持 native resume，就必须同时接通可信 native handle、resume argv、managed Hook 与事件字段归一化；Pi 的 resume 与扩展部署是两件事，不能只做 locator；Claude、Hermes、Cursor 的事件/信任细节分别按各自 CLI 合同接入。Cursor 没有 native resume 时必须明确保持 unsupported，不伪造恢复入口。
- Hook 入口同时接受厂商的 camelCase 与 snake_case 字段，但在 Core 内收敛到同一 canonical event；`sessionId` 等 provider-native handle 只能由对应 Provider 解释，不能由 ctxmux 或 Desktop 猜测。流程探测或 Hook 安装失败属于非阻断降级，必须在服务窗说明当前状态与恢复动作。
- 尚未纳入的 Agent 分成三类：具备完整 Hook/session/resume 证据的优先纳入；只有 status/Hook 的按实际需要纳入；只有 launch 配置或宿主专属 wrapper 的明确记录为暂不纳入。**同名不等于同身份**：TraeX (`traex`) 与 Trae CLI (`traecli`) 是两个不同 Provider，二进制与合同都不同，不得合并身份。
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

### 整体 review 的可靠性约束

用户要求结合项目内容 review 并直接修复遗漏的 bug、代码品位、代码熵与设计风格问题；目标是“使用起来很可靠，操作多 Agent 很丝滑，性能很好，设计世界顶尖”。每轮 review 要留下已验证的修复与接续边界，不能把局部测试通过表述成整个产品完成。

- 发送时调整终端尺寸属于观察被替换。payload 已接受且权威 Run 仍在运行时，同一提交必须继续完成并明确展示验证降级，不能留下占用后只叫用户重发；确认必须使用输入边界之后的新输出。Run 已退出或连线状态无法确认时，不得谎称交付成功。
- 键盘切格的输入焦点必须到达目标表面，包括异步加载的编辑器。较晚的指针导航取消旧移焦意图；旧消费者不得清掉更新的请求。隐藏表面不得在稍后加载完成时夺回焦点。
- Board 的行、读取状态和刷新动作必须来自同一次读取。刷新后行必须更新；读失败不能呈现为空项目，切换 Workspace 不得短暂显示上一 Workspace 的 Topic。

- 聚合的 Provider 头像若没有独立定位目标，只表达身份与状态，不伪装成可点击按钮；有会话目标的头像才独立可操作。列表行动作不得嵌套原生按钮，键盘与指针的动作含义一致。

## 验收原则

- 行为验证优先于 CSS 声明：Production Electron 要检查真实尺寸、DPR、overflow、焦点、拖拽落点和恢复结果。
- 安全与状态一致性不能由截图替代；`pnpm check`、Owner-level tests 和相应 Production Gate 必须通过。
- 文件保存覆盖继续输入、外部修改、删除、读取失败、写入失败和替换失败；草稿不被静默覆盖，原文件不被失败写入截断。
- 文件移动覆盖目标碰撞、外部竞争、Workspace Root/父目录换代、source/destination 被无关对象替换、helper 缺失和 syscall 后回执失败；磁盘未确认成功时 Renderer 状态保持不变。Packaged Electron Explorer probe 另覆盖 PointerSensor、Radix Move 子菜单、`Shift+F10`、非法 drop、500ms hover expand/cancel cleanup、单项选择收敛、Workspace 回访和 Workbench DnD 隔离；既有 file-editing probe 直接订阅 mounted Zustand owner，证明满足态回访零 Explorer projection 通知，并用 move commit barrier 证明旧 Workspace closure 的两个 parent refresh 在 Renderer admission 被拒绝、未到达 Main 或污染当前 Workspace cache。
- 资源收益只用同一场景的 before/after 数据声明，不强制 GC，不卸载仍使用的 Surface，不增加全局 Cache 框架。
- 一个用例只证一件事。把 N 个各自 spawn 子进程的场景串进同一个 `it`，会同时买下三样坏东西：耗时叠加逼近默认超时（并发跑时先炸的就是它）、失败时不指出是哪个场景、以及后面的场景被前面的失败挡住从不执行。安全性质要逐操作立各自的用例，并断言注入钩子已被消费——钩子没触发的绿是假绿。
- Unsupported 能力明确失败关闭；不加兼容层、migration、fallback、第二 Runtime Owner 或隐藏 Registry。

### 注意力处理与结果审查闭环

- 用户能以更少操作完成「发现需要我 → 做决定 → 检查结果 → 继续运行」，并保持原来的工作区和 Session 上下文。
- Needs you 的集中入口应能直接显示具体 Session、请求内容和可执行回答；处理后可以继续进入下一项，并能回到原工作面。它复用 Core 的 typed interaction 和已有通知/Session 定位，不建立第二套 Inbox 或 Session Registry。
- Agent 完成后，结果附近应能直接进入工作区变更、已确认的开发预览或同一 Session 的后续对话。完成、变更存在、预览可用和任务成功必须分别表达，不能把停机或进程退出当成成功。
- 预览只能使用已确认的通用开发服务事实；没有端口、发现失败或服务状态未知时保留工作面并说明当前事实，不猜测 URL。
- 终端、对话、审批和审查切换时保留同一 Agent Session、草稿、附件和待回答交互；重连失败不能清空工作面或删除健康 Session。
- 移动端、语音、Watch、Push 和 Remote/SSH 不属于本轮闭环，后续必须基于 Core/ctxmux 的公开能力另立需求。

- Needs you 不保证一定有可回答的结构化请求；没有 typed request 时只提供定位原 Session 和真实状态，不能猜允许/拒绝按钮。聚合入口中的回答属于显式交互入口，不改变 Board 观察 Region 禁止发送和生命周期修改的约束。
- 请求以 Core 当前 Session、Run 与 request 身份为准。提交中禁止重复点击；失败保留问题与用户选择，不自动重发或跳过；旧请求已被替换时刷新投影，不把旧回答送给新请求。成功按 Core 确认收敛后才进入下一项；到末项返回空状态和稳定焦点，不自动批准下一项。
- 查看变更展示所属工作区的 Git 事实，明确它可能包含其他人或其他 Agent 的改动；无仓库、无变更、读取失败是不同状态。继续追问只聚焦同一 Session 的既有 Composer，不自动发送、创建新 Session 或暗中 resume。
- 明确的 HTTP/HTTPS 地址可以由用户输入或从当前 Session 的链接中明确选择，再使用既有 Browser 打开能力；地址合法不等于服务在线。多个地址由用户选择，不能挑最近端口或从其他 Session 借用地址。没有服务观测时显示尚未验证可用；自动扫描端口、自动启动服务不属于本闭环。
- 显示投影的失败不停止健康 Run；旧请求、无效地址等动作仍须拒绝错误目标，拒绝该次动作不等于阻断整个 Agent。切换可恢复原焦点和草稿；只有 Core 确认终局事实才允许移除对应 Session 投影。

## 非目标

- 不把 AgentMux 做成另一个 Run Runtime。
- 不把 Desktop 布局、Topic、Provider 或 Agent 语义下沉到 ctxmux。
- 不为命令对称、未来平台或未出现的规模证据预建功能。

### Explorer 的真实文件与快捷键入口

- 键盘快捷键入口属于全局工具，应在项目栏最底部设置按钮右边；顶部只承载视图开关。项目栏收起后仍能访问。
- Explorer 默认能看到被 `.gitignore` 忽略的文件与目录，并明确区分忽略状态；不按 node_modules、dist 等固定名字静默过滤。忽略事实来自 Git 自身规则，包括嵌套规则与否定规则。
- 软链接同时表现目标类型与链接身份，使用图标而不是 `link` 文字。目录链接应能在链接所在位置按需展开；文件链接应能打开；失效链接如实显示。显示路径保留链接路径，禁止循环展开。浏览链接不意味着允许把已有工作区写入约束放宽。

### 可收起的 Agent 快捷输入区

- 底部对话输入区应可收起并一键恢复，收起不丢草稿；主要提供文件引用、截屏、技能选择、快捷指令四类快捷入口。文件引用沿用当前 Agent 的文本提交通路，选择结果先进入草稿，用户决定何时发送。
- 展开/收起入口放在快捷工具行最左侧，与文件、截屏、技能、指令等按钮同排；展开态不额外占用一整行高度，收起后仍保留同一位置的一键恢复入口与草稿提示。**这一枚就是唯一入口**（三态语义见「Agents、队列与 Message Tools」一节）。
- 展开入口必须参与底部工具行的正常布局流，不能以浮动定位覆盖输入文字；收起态仍在该行同一位置提供恢复按钮。**绝对定位的第二入口已废止**：它此前靠给工具行留一段左内边距来避让，而工具行在窄宽度下会折行，避让与绝对定位一起错位——这正是本条约束要禁止的形态。
- 截屏使用系统选区，取消不改草稿；成功后生成可供当前 Agent 读取的图片引用。技能选择显示实际发现的技能及来源；快捷指令依据当前 Provider 提供，输入 `/` 可选择，选择只填写草稿，不暗中执行。
- 发送、中断当轮、收起输入区是三个清楚区分的动作；中断沿用 Core 的当轮 interrupt，不终止会话。输入法组字、失败保留草稿、运行中 steer 的既有约束继续成立。

### Projects 结构与状态可读性

- Projects 必须能区分项目、路径自动聚合分组与实际目录；父子关系可扫读。有项目自身图标时优先使用，缺失时按项目／目录类型显示图标。分组仍是路径派生事实，不新增实体。
- 活动提示应直接说明正在运行的 Agent；通知必须能解释哪个 Agent 在等什么或出了什么问题，悬停显示明细，点击直达对应会话。已读提醒可消退，但尚待回答的请求不可伪装成已解决；查看后继续显示明确的待处理原因，处理后由 Session 事实自动消失。

### 分层更新与回切

本次版本交付的范围索引见 [桌面体验与分层更新交付清单](../delivery/desktop-experience-update.md)；任务状态与验收证据仍由其引用的 Tracker 持有。

- 参考 deepseek-harness 的组件生命周期：可替换表面必须释放订阅与副作用，状态和进程由稳定所有者持有；不为热更新复制 Runtime。
- 纯前端且宿主、preload、IPC 与运行时依赖未变时优先热更新，保留会话、布局和未发送草稿，可回切上一候选。涉及宿主但不涉及 ctxmux 底层时安装应用并重启，保留 Run 并重新 attach，必要时依据 Provider native handle resume。需求顺序优先闭合可独立更新的前端体验切片。
- ctxmux 底层变更须单独判定兼容性，不等于必须杀进程。无法保留 Run 时才考虑恢复会话的重启。若连 Session 都无法保持或 resume，必须在安装前提醒用户停止工作、确认现场不再需要，获得明确确认后执行。未知恢复能力不能当成可恢复。
- 回切只替换相容的界面代码，不回滚会话事实、文件内容或用户操作。校验失败保留当前可用版本；不能自动强杀健康 Agent。

### 本地文件预览与按格式编辑

- 用户要求「内置的 browser 应该要支持打开本地文件进行预览」，不能只接收网络 URL。
- 对能识别的网页、图片、文本等常见格式，应提供适合该格式的预览与编辑体验，而不是都落到同一种通用显示。
- 具体编辑能力与格式边界先参考成熟产品，再形成对应 Feature 的评审任务；需求由 `local-file-preview-editors` 持有，不混入既有版本安装验收。

#### 文件树目录作为项目打开

- 文件树目录的右键菜单提供“Open as Project”；文件行不显示这个动作。入口只把当前 Workspace 的 host 与目录路径交给既有 `workspaces:add`，不建立第二份 Project 注册表。
- 目录名作为默认 Project 名称，路径由当前 Workspace 根与目录相对路径派生。Renderer 的同路径快路径只用于减少一次请求；是否已注册由 Main 的归一化位置判定决定，尾斜杠、`.` 等等价写法不能产生重复 Workspace。
- 添加失败必须落到现有错误面；不能静默关闭菜单或让用户误以为项目已经打开。成功后选中新建或已存在的 Project。

#### 书签文件（.webloc / .url，）

- 存书签「不要整页打包 就是保存个 link」：把当前页存成一个书签文件，不做整页归档。
- 打开书签「应该是默认 browser」：双击 `.webloc` / `.url` 在 AgentMux 自己的 Browser 里打开那个地址，不跳去系统浏览器。
- 「查看源码指的是书签文件本身的源码」，不是网页 HTML——网页源码 DevTools 已覆盖。所以这个入口回到文本路径打开那份书签文件。
- 「如果是 binary 就不支持切换到编辑, 如果是文件就支持」。二进制 plist 那一档的提示「绝对要极简, 比如就是按钮灰掉, hover 告知」——不弹框、不 toast、不加警告条。
- 二进制判定是主进程的事实，随书签内容一次取回；renderer 不重新读一遍字节（utf8 往返会损坏二进制 plist）。
- Netscape bookmark HTML 批量导入导出本轮不做：今天没有书签库，导进来无处安放。

### 当前 Agent 的上下文余量与输入焦点

- 用户要求「给你自己的对话框上加 context 剩余监控」：每个 Agent 输入区展示所属 Session 的原生上下文余量及观测时间；容量与当前占用来自 Provider，经 Core 的既有用量事件发布。累计计费 token 不是上下文占用，不可用它扣减容量。压缩后的新观测可降低占用，缺数时明确未知；最近一次观测不能伪装实时计量，监控缺失不能阻断输入。
- 用户要一眼看出哪个 Agent 快把上下文窗口用完了：Agent 名册和工作区 Agents 列表按同一原生占用率显示 70%／90% 的提醒，并说明可收尾或开新会话；这只是产品提醒，不宣称 Provider 的压缩阈值。低占用不添“安全”状态，未知不作 0% 或安全，提醒不改变 Agent 状态、输入权限或 needs-you。
- 聚焦 Region 时，Terminal/TUI 应收到其原生键；只对匹配且属于宿主作用域的动作消费事件。IME 组字不触发快捷键；没有消费的键原样交给聚焦内容。冲突解决复用既有快捷键注册与作用域，不在各组件复制拦截规则。
- 浏览器产生新页面时以来源 View/Region 归属决定打开位置：分屏来源在该工作视图中选择合理区域，独立 Tab 来源开新 Tab，不默认弹出独立窗口。网页链接右键提供既有分屏/Tab 打开位置菜单，用户显式选择优先。

### Projects 状态与 Activity 菜单
- Projects 栏的 running/error 计数保持可见，但采用紧凑的图标与短标签，避免挤占目录树空间。
- Activity hover 菜单每行必须提供 provider 图标、最近活动摘要与停止/空闲时长；信息按单行优先、紧凑间距呈现。
- Composer 的展开/收起入口与底部快捷工具行保持同一布局行，不得覆盖或压住输入文字。
- Claude 与 Codex 的 Executor 设置提供一个明确的“一键 YOLO”操作；它写入该 Provider 已验证的无人值守启动参数，并立即保存。该操作只影响后续启动或恢复的 Run，不伪装成运行中进程的实时开关。
- Activity 默认按已有的 Topic / Branch / Worktree 工作线聚合，而不是把每个 Run 平铺成一行。聚合键必须从 Workspace、Host 和 Scratch collaborators 等既有事实派生，不增加 UI 侧注册表或第二份 Runtime 状态。
- 每个聚合行只回答一件事：这条工作线里有哪些 Agent、最需要处理的状态是什么、最近发生了什么。行内显示 context 名称、Provider 头像簇与数量、最紧要状态与短摘要；点击聚合行定位到该组中最需要处理的 Agent，展开后仍可查看并选择具体 Session。
- 聚合行的 context 身份必须在悬停面板中明说（`Topic` / `Branch` / `Worktree` / `Unassigned`），不能只放一个裸标题让用户猜它是什么；路径或非本机 Host 作为次级元信息出现。聚合行的主点击直达该组中最需处理的 Agent，折叠/展开是独立的 disclosure 操作，不得让用户先逐个试 Agent 才知道这一行在表达什么。
- 不同 context 必须能被区分：Topic、Branch、Worktree 名称和必要的 host 元信息不能被一条泛化的“Agent activity”标题取代；没有 context 的 Session 进入明确的“未分组”组，而不是凭空猜 Topic。
- 全局 transient `reportError` 不得固定在工作区底部遮挡内容。它应停靠在不覆盖主工作面的 notice 区，带清晰的关闭按钮和可访问名称；关闭只隐藏当前展示，不删除 Runtime/Session 事实，并保留从状态或诊断入口重新查看的路径。持久的 Service Window Notice 仍是独立告示，不增加关闭按钮，也不自动消失。
- Run 的权威 lifecycle 已进入 stopped/exited/done 后，所有 pending composer readiness 必须失效或被清理；Desktop 不得继续把它翻译成“Run is still running / wait”。此时 Composer 给出 resume/restart 等可执行恢复出口；真正仍在运行但尚未观察到 readiness 的 Run 继续 fail-closed，不能为消灭提示而绕过 Core readiness 门。

### 重启后的 Tab/Region 与 Session 恢复
- 重启恢复必须先还原持久化的 Workbench Tab、Region、分屏树、顺序和焦点，再把其中的 Agent/Terminal Region 按其稳定 session identity attach 到仍由 Runtime 持有的 Run；不得因为 Runtime 尚未返回首个 snapshot 就创建第二个 session 或把 Region 清空。
- “session 仍在运行”与“界面尚未重新 attach”必须是两个独立状态。健康 Runtime 只允许显示连接中/待同步告示，不得把它翻译成“在其他应用打开”并要求用户手动 resume。
- 只有 Core 明确确认原 Run 已退出且 Provider native handle 可恢复时，才显示 resume/restart 出口；恢复失败必须保留原 Tab/Region 拓扑和可解释的服务窗告示。

### Composer 消息队列与紧凑状态
- Composer 的 Context、发送和中断控制采用紧凑工具栏布局；Context 以低噪声状态徽标呈现，完整剩余量通过 hover/展开查看，不占用正文行。
- 用户在 Agent 工作中发送的内容必须先进入该 Session 的有界消息队列；Provider 当前可接收时立即按序投递为 steer，否则保持 queued 状态并在下一次可投递时自动发送。队列条目可见、保序、可删除，失败保留原因，不得静默丢失。
- pending interaction 不得被普通消息绕过；消息继续排队，交互回答完成后再按序尝试投递。
- **队列里等着的是用户亲手写下的文字，它必须挺过一次重启。** 进程重启后草稿还在、排着的消息却没了，是把 AGENTS.md 第 12 条反过来做。恢复后这些条目仍按「它是对哪个 Run 写的」判定可投递性：对不上当前 Run 的照旧显示为不可投递、交给用户处置，但内容不得替用户丢掉。
- 发件列表还应允许调整尚未在途条目的顺序，保留同一消息身份、文字、目标 Run 和失败原因；调整只改变当前队列顺序，不授权执行、不触发恢复，也不解除重启后的待执行状态。已在途条目不能被移位、越过或伪装成可撤回；不存在或已确认投递的条目不参与重排。
- 条目有真实入队时间时可查看，首次接收入队记录的时间在恢复、重试和重排中保持不变；缺少这一事实时如实显示未知，不用 Session 创建时间、历史消息时间或当前时间补造。入队时间不是 Agent 闲置证据，冷启动仍只消费 Core 的语义状态事实。

## 内置任务持续推进（，AFTERTIME 使用需求）

- 用户开启一次「持续推进」后，不应因 Agent 阶段总结、关闭观察面板或正常结束一轮而丢失配置；默认每 30 分钟检查，可修改间隔与续行提示。目标必须显示并绑定精确 Host、Session、Provider 与 workspace，Run 是可替换的执行实例。
- 调度状态、Agent 执行状态、业务任务状态分别保留。调度不能批准权限、绕过问题、隐式 resume、改变权限策略或修改业务完成状态。检查失败只暂停自动续行并说明原因，不阻断健康 Agent 的人工使用。
- 到期遇忙跳过，不堆积消息，不在忙转闲时额外补发。只有正常一轮结束、输入就绪且仍有可推进工作时才能续行；立即检查遵循相同规则。working 活动证据过期显示未知并提示检查，不猜空闲或强杀重启。
- 权限或用户问题等待时不发送，并能定位原请求。用户中断/停止应暂停循环，恢复循环须明确操作；暂停循环与中断 Agent 是两个动作。无法分辨正常 Stop 与用户中断时，不宣称可以安全自动续行。
- 每次检查有 tickId；同一 Run 的同一就绪信号最多提交一次。提交边界必须复核身份、就绪信号、执行状态和用户输入占用，覆盖重复检查、直接 Terminal 输入和未提交的 Composer 草稿。自动续行不得挤掉用户输入；缺少证据时暂停自动投递并说明。
- 自动续行只消费精确目标的现有草稿/人工队列占用；观察缺席、取消或退出仅暂停循环并说明，不阻断人工使用。新自动认领须由同 Run 的真实 Native 输入栅栏确认，未知不能补零；旧未知操作仍按原完整请求调和。人工取消在认领前到达才撤销自动候选，已认领字节不能撤回；Renderer 观察与 Core 认领不宣称分布式原子。
- 决定发送、Host 接受、Provider 消费/新一轮开始分别记录，不能观察时标 unknown。结果未知不自动重发；检查与最小回执持久保存，界面重载不得造成双发。
- 应用退出或休眠期间不承诺调度；恢复后仅重新检查一次，不集中补发漏掉的周期。配置不依赖模型内部 Cron、调用者 shell 环境、临时终端或 UI 定时器。同一精确目标至多一个活动循环；接管内部 /loop 时提示用户停用旧循环，不声称可以自动检测和删除它。
- 可选绑定 Feature Tracker 等只读任务来源。无绑定时可设置截止时间/触发上限，只称定时续行，不能证明业务完成。Tracker 全部 Task done 但未 closeout 仍未完成；closeout 是待推进工作。archived 表示完成，discarded/transferred 表示终止或转交，不能都显示业务成功。依赖阻塞与任务来源不可读必须分别说明。
- 任务来源由用户显式绑定 root、Feature ID 和公开脚本；每次仅核一项公开 owner receipt，不重算 Task frontier。全部 Task done 待收口只暂停并说明，归档才可称业务完成；终止、转交、不可读不冒充成功。来源检查不改变旧未知输入操作，人工输入保持可用。
- 无可运行项时展示阻塞原因，不空发相同提示。空转提醒必须有任务适配器声明的进展证据；token、输出量、一次测试通过不能单独证明完成。
- 暂不包含自动批准权限、多 Agent DAG、模型切换、部署或成本优化。现有 Core 输入与生命周期 API 是唯一执行边界，续行策略由 Host 持有，不下沉到 ctxmux。
- 观察界面见 [Surface density](agentmux-surface-density.md#持续推进观察界面)。评估与验收建议见 [AFTERTIME intake](../reviews/continuous-progress.md)。

### Session 发现与维护者定向提交

- list sessions 应逐项返回：某个 stale binding 带准确 Session/Run/错误码，不导致其他条目不可见；可按 Provider、workspace、状态和活动时间筛选。全局连接失败不得伪装为空列表。
- 维护者身份应由显式注册的项目角色/capability 解析，不能猜标题、Provider、布局或最近活跃会话。无明确目标返回 MAINTAINER_TARGET_UNRESOLVED，不广播。
- 维护者过期时保留需求草稿和引用，不自动改发。明确绑定目标后才可 typed send，并保存回执。诊断命令不支持时提供真实可用的帮助或诊断入口，不虚构 doctor 能力。

### Session 重启后的持续推进恢复

- Agent Session 重启或 Run 更换后，循环配置必须保留，但旧 Run 的 tick、readiness、提交回执和活动时间不得冒充新 Run 事实。恢复先重新解析精确 Session 身份与当前 Run，再执行一次检查；不补发旧周期。
- 恢复期间将“执行状态”“循环状态”“恢复状态”分开显示。旧回执未知、绑定 stale、Provider 尚未就绪或恢复检查失败时，循环暂停并显示具体对象与原因；不能同时显示 busy 与 error_paused 而不给出优先级和下一步。
- Session 重启完成不等于新一轮已开始。只有 Host 接受、Provider 消费或新一轮活动的真实证据才能推进对应阶段；旧 Run 的 stop/readiness 不能用于新 Run 的去重。
- 应用重载、监督器重连和窗口重新打开使用同一个恢复检查入口，幂等且只产生一个恢复 tick。恢复失败保留待检查状态与原续行提示，用户可立即检查或恢复循环。

### Message Tools 的事实来源与快捷语法

- 初始页与 Agent Session Composer 共用同一个 Message Tools 能力面。输入区支持常见的 `@` 文件/目录引用、`/` Provider command/subcommand、`$` skill 选择；工具选择和手写快捷语法最终都生成同一份可恢复 prompt 草稿。
- `commands` 与 `skills` 的能力范围优先来自当前 Provider 的 catalog/声明；AgentMux 自己提供的配置型能力复用工作区或用户目录下 `.agents` 事实协议，不复制一份 Provider 任务真值。来源、路径和不可用原因要可见。
- 未连接 Session 的初始页只能使用项目/工作区上下文与可发现的本地 `.agents` 内容；需要 Provider Session 才能解析的能力显示为待启动或 unknown，不能伪造可执行项。启动失败保留输入、引用、skill 和 command 选择。
- Provider command 与 AgentMux 自己的快捷命令命名冲突时，不静默改写；显示来源并按明确选择生成 prompt。未知 `@`、`/`、`$` 文本保留为普通输入。

#### 对话里的贴图

- 粘进对话的图片要**看得见**：渲染成缩略图，而不是一颗只显示路径的文件链接按钮。点击放大到灯箱。
- 路径表示原样保留：Agent 要靠那个 `@path` 去读图，缩略图只是给人看的一层，不替换引用本身。
- 走 data URI 是 CSP 逼出来的（`img-src 'self' data:` 挡死 `file:`），不是选择。
- 读图有信任边界：落盘目录收成一处派生，读回时 realpath 双侧解析，防止 symlink 逃出贴图目录读到外部字节。
- 起头的 `@` 是记号不是路径字符，解析路径时要剥掉，否则 `@src/foo.ts` 永远打不开。
- 缩略图的读取失败或仍在加载时必须保留原始路径引用；不能留下破图框，也不能因为展示失败把 Agent 可读的引用删掉。非本应用贴图目录的图片路径继续走普通文件引用规则。
- 灯箱是同一张图的放大查看，关闭后焦点回到触发缩略图；不建立第二份附件或图片字节事实。远程图片不因这条能力自动请求。

### Message Tools 失败反馈与 Browser Region 选中态

- Message Tools 的文件、截图、Skill、command 和发送操作失败时，优先在组件自身显示短暂、可重试的原子错误层；全局通知只作为跨组件或无法定位来源的补充。错误层不得清空 prompt 或已选引用。重试与原入口的后续成功都应清除旧失败；切换 Workspace、Provider 或 Session 后，旧请求与旧重试不得污染新对象。多项工具结果同时返回仍须完整追加到当时的草稿。
- 组件内操作错误保留失败动作的重试入口；成功重试或主动关闭后收起，失败不覆盖当前草稿。初始页一次选择多个文件必须全部加入，并基于选择完成时的草稿追加。初始页共用工具能力，但没有三态输入宿主时不显示空转的形态切换键，工具保持直接可用。
- Browser Region 点击内容区必须更新 Workbench 的明确 active Region；选中边界、标题和键盘焦点与 Terminal/File/Agent Region 使用同一事实，不靠浏览器内部 URL 或 hover 猜测。

### Activity 工作线展开信息密度

- `Activity by work line` 折叠态保留工作线摘要和“选择一行打开”；展开箭头只在确实有额外可操作或诊断信息时出现。
- 展开项不得重复聚合行已经表达的名称、Provider 数量和状态。明细优先显示 Agent 图标、最近活动、状态原因、空闲/停止时长和可直接处理的动作；没有新增信息时保持折叠或隐藏展开控件。

### 启动页 Resume 快捷入口

- 启动页只对当前 workspace/Host 存在、身份和 Provider 能力均可验证的 recovery candidate 显示 Resume；不得按标题、Provider 或最近活动猜测目标。
- Resume 前显示候选 Agent、workspace、当前 Run 与恢复原因；执行中、权限等待、stale binding、不可用 Provider 和已终止候选不显示为可点击 Resume。
- Resume 失败保留启动页输入草稿和候选信息，显示可处理原因；Resume 只是显式恢复 Run，不等同于发送 prompt、开启 loop 或批准权限。
- **控件报出几个候选，就得让用户挑哪一个。** 上面两条合起来已经禁掉了"猜目标"，但被违反的方式是一个不显眼的形状：按钮上写着 `Resume (17)`，`onClick` 里恢复的却永远是 `candidates[0]`。计数把"这里有 17 个"讲了出来，动作却只当一个——用户按下去得到的不是他以为的那个，而且**没有任何报错**，因为程序自己认为成功了。所以：候选多于一个时，Resume 必须先呈现候选（身份/workspace/原因，按上一条）让用户选中一个，不得一边显示复数计数一边按索引取值；只有一个候选时才是直接动作，此时也不显示计数（一个不需要数）。判据是**读数与动作指向同一个对象**，不是"有没有报错"。

### 通知关闭后的稳定性

- 用户关闭某条 transient error 后，同一错误由重复事件、轮询或恢复重放再次到达时不得重新弹出。只有新的错误内容，或用户主动选择重新查看，才能恢复提示。
- 原始错误事实继续保留在可重新打开入口；关闭的是当前展示，不是删除诊断记录。

### Status Bar 状态图标与 Activity 详情

- Status Bar 的 Agents、Needs You、Error 必须使用语义图标加紧凑数量，不能只用点或无来源的装饰形状；hover/辅助文本说明对象、数量和动作。
- Activity 展开应是诊断/处理面板，不重复聚合行已有信息；单 Agent 且无额外诊断时不显示展开箭头，多 Agent 或有原因/时长时才展开。

### Agents 入口与 Activity 详情归一

- Activity 工作线展开的每个 Agent 必须显示所属 Project/Workspace、Provider、执行状态、最近活动与等待/停止时长；统计至少区分总数、running、needs you、error，缺失事实显示 unknown。
- Agents 列表只有一个主入口。左侧 Projects/Agents 工具作为统一入口，右侧重复的 Agents roster 不再单独占位；原有定位、筛选和状态统计能力并入统一入口。

### Status Bar CPU/Memory 资源面板

- 用户要求「性能指标在右下角的观测面板看不出」「ctxmux 的泄漏管理应该也能看出来」。观测面板必须分清应用、Agent CLI 和 ctxmux：应用按 Main、Renderer、GPU、Browser/Utility 显示 CPU 与内存，Agent 按现有 Run 归属，Runtime 显示其公开合同提供的 Run、attachment、保留输出及回收事实。不能以应用内存总数代替卡顿来源，也不能从 RSS 高直接判为泄漏。
- 进程指标、资源 owner 数量、保留历史容量与回收结果是不同事实；观察时间、CPU 聚合口径、未知/过期与失败原因必须可读。应用 CPU 的测量区间平均与 Agent 的平台 ps 平均读数必须分开说明；10 秒读数峰值不能冒充同一种瞬时 CPU。首次尚未形成 CPU 测量窗口不能冒充 0；Runtime 缺少公开指标时准确说缺少什么，不读写其私有数据库来补一个假完整面板。
- 观测仅在面板打开期间按需采样，关闭即停，慢采样不堆积。Runtime 存储统计不随每秒 CPU 采样反复遍历；局部指标失败不使其他指标消失，也不停止、删除或重启 Agent。既有孤儿目录回收与当前 Run 的历史回收分别显示，打开面板不是删除历史的授权。
- 关闭观测面板、切换页面、销毁窗口或替换订阅时，属于这次订阅的采样与生命周期监听必须一起释放；反复打开不能留下逐次增长的监听闭包。释放是同一订阅 owner 的幂等动作，不依赖下次打开或人工清理。
- 每个资源对象尽量显示所属 Project/Workspace、Agent/Provider 和最近活动/idle 时长；没有归属时明确显示 unknown。资源采样与 Agent 语义状态分开，不能把低 CPU 误判成 Agent idle。信息层级与紧凑布局归 Surface 密度合同。

###  资源与 Activity 观测
Status Bar 的资源面板必须能把每个进程关联到项目/工作区、Provider 与当前 Agent 状态；空闲时显示可理解的 idle 时长。资源数值与 Agent 语义状态分开，缺失数据保持未知。Activity 展开行只补充能帮助定位的上下文，不重复左侧 Agents 入口。

###  Region 移位入口
Region 的右键菜单必须提供“移位”入口，允许在当前工作面把 Region 与目标位置交换/移动；动作使用统一布局 owner，执行后保留 Session 与 Region 身份，不通过标题或视觉位置猜测目标。

###  控件说明与对话完整性
所有图标或模式切换按钮必须在 hover 附近提供简短用途说明，并在存在快捷键时一并展示；同时提供可访问名称。对话视图必须按时间顺序显示用户消息与 Agent 回复，不能只呈现 Agent 一侧。

###  文件打开目的地
文件点击也应进入统一的打开目的地选择器；目录点击保持 Explorer 导航语义。目的地目前使用有明确布局语义的四个基数方向与新 Tab，斜向按钮只有在布局 owner 能提供真实语义时才增加，不为凑齐九宫格制造无效动作；不可行目的地置灰并说明原因。

### 验证进程的资源归属

- 用户内存有限，验证失败、超时或中断后不得留下 Electron、文件 observer 或测试 Runtime；runner 报告结束前必须确认本次进程已退出，不能把一条超时日志当作进程结束。一次验证未完成回收，不得再启动下一份 Electron 验证。
- 清理只针对本次验证的进程组、独立临时目录和 Runtime 身份，不影响正式应用和用户 Agent。观察失败必须明确报告，不能当作零残留；先回收进程，再删除它们依赖的临时目录。
- 文件 observer 属于创建它的应用进程；宿主异常退出也必须终止观察，不能成为长期存活的孤儿。此约束不改变 ctxmux 对用户 Run 的持有和恢复语义。

- 验证模式的启动落点只决定初始选择，不能持续覆盖用户或 probe 随后的 Workspace 切换；测试模式不得使项目切换失效。

- 文件树跨 Workspace 的验证事件必须按操作和 Workspace epoch 归属；挂载重建不许复用聚合 DOM 计数推断一次 mutation。Move 提交只产生一条权威 receipt，旧 epoch 的刷新明确记为 rejected，Stop 对已消失 Run 归入幂等终态。

- Tab 拖动默认表达同一 Region 内的排序；只有拖到明确的边缘/方位 drop zone 才表达拆分为新 Region。Split 按钮直接点击默认向右，hover 菜单复用统一方位组件，并按当前布局可行性置灰。

### 整合版本的交付约束（f-2538fz2rm）

- 全局外观支持深色、浅色与跟随系统，重启保留选择；视觉 token 和编辑器一起响应，终端主题独立。取代旧版只允许深色的限制。
- 自有标题栏与 macOS 原生窗口控制共同组成窗口顶栏，交通灯与可交互内容不重叠；保留原生无障碍行为，不为自绘而重造系统按钮。
- 用户可以从一条消息继续到新会话；新会话只包含截至所选消息的可见对话上下文，保持精确 Workspace/Executor 绑定，明确这不是 Provider 原生 fork。启动失败保留原对话与可重试内容。
- 对话中的本地图片以缩略图显示，可复用路径引用到草稿。远程图片不自动请求，读取失败保留引用；沿用已有受控文件读取入口，不新增任意 URL 读取通道。
- 项目维护者通过 `.agents` 下的显式角色绑定发现：注册绑定精确 Session 和项目，解析时检查当前 Session 事实，过期或不存在返回 `MAINTAINER_TARGET_UNRESOLVED`；不会按标题或最近活动猜目标，不广播。目录解析不自动投递，后续发送使用已有 typed send 并保留原草稿与回执。
- Agent 创建后布局已经变化时回执使用实际 Region/Tab；纯布局失败不得停止仍健康的 Agent，应保留其 Session 并给出持续可见的说明。

### Message Tools 触发与菜单

- 输入 `/`、`$`、`@` 分别打开 command、skill、文件引用候选；选择只写入草稿，不暗中发送。三者复用同一个可访问菜单，支持上下方向键、Enter、Escape，菜单展开不改变底部工具栏的布局高度。
- 候选菜单沿用 Message Tools 的浮层与控件语言，不另造一套高列表；当候选过多时在浮层内部滚动，输入框和底部操作保持可见。

### Gallery 到聊天页的生产替换

- 聊天页面的观察区直接消费 Gallery 已验收的 Workflow surface；Gallery 是隔离验收入口，不是另一套生产组件。
- 替换只改变观察区的展示与交互编排，消息、Session、Agent 状态和 Runtime 事实继续由原有 owner 提供；生产聊天不得读取 Gallery fixture。

### 语义图标体系

- 具有产品语义的状态、对象、动作、导航和层级图标统一经过 semantic icon 目录；调用者传入语义枚举，不直接在业务 JSX 中选择 lucide glyph 或写状态字符串。
- 编辑器、终端和第三方内容内部的图标不强行迁移；只有跨表面共享、需要无障碍名称、状态表达或动画策略的图标进入该体系。
- 动态图标、动画图标和组合图标都必须通过同一 renderer contract，支持 `prefers-reduced-motion`、`aria-hidden`/可访问名称、稳定尺寸和低成本重渲染；动画不能由业务组件各自实现。
- 不保留向后兼容、migration 或 fallback；旧的 icon 语义直接删除或明确替换，不能让两套语义长期并存。
- 同一语义必须有唯一且足够独特的图标结构；不同语义不得复用同一个最终 glyph。图标映射测试必须钉死完整集合而不是只断言“有图标”。
- 动态图标必须为具体语义设计动作：例如运行态旋转、完成态打勾、等待态呼吸或暂停态停驻；不能所有状态都套同一种 spinner。reduced-motion 下退化为稳定但仍独特的静态结构。

### UI 架构实施原则

- 先分层和确定事实 owner，再写组件；设计、需求、状态和验证保持在项目知识 SSOT 内，避免无意义的平行抽象。
- 先跑通最小端到端路径，再扩展状态、插件和主题；不为了未完成的复杂度拆掉能跑的实现。
- 组件保持模块化和关注点分离，优先复用项目已有依赖与成熟模式；没有明确证据不新增库、不重写已有能力。
- 架构选择按长期维护和可验证性决定，不留下“以后再换”的临时兼容层。
- 测试按执行时间和变更范围设计：小改动优先定向并发验证，只有跨边界变化才触发更宽回归。

### 观察界面最终统一

- Gallery 与聊天页面使用同一套生产组件；Gallery 不是样稿，而是聊天观察区的快速验收入口。
- 聊天页的 Activity、Workflow、服务窗、权限卡和 Composer 必须共享同一条观察主线：对象先于装饰，状态先于颜色，动作靠近事实。
- 统一后的界面必须同时表达“现在发生什么、为什么发生、用户下一步能做什么”；没有事实就不画空壳，不用示例数据冒充真实状态。
- 视觉效果可以有强烈的层次、光泽和动势，但不能牺牲密度、键盘可达性、reduced-motion 或状态可辨识性。

### Project Rail、通知与 Topic presence

- Project Rail 的分组父节点和树节点都支持收起；收起不改变路径归属、焦点或选中项目，重新展开后保留原来的树顺序。
- 分组标题、项目、嵌套项目和 pinned 子项使用同一条缩进计算，不因某组收起而改变其他组的左缘。
- Pinned 子项仍是所属 Project 的可点击导航入口，但必须读作从属内容：标题比普通项目小一档，悬停只加下划线、不铺普通项目的背景高亮；它与所属 Project 之间保留一条低对比虚线连接，连接只表达归属，不承担选中、运行或错误语义。
- 没有品牌图标的节点使用低对比、低饱和的 monogram；字母只是识别辅助，不能用高饱和背景抢过项目名。
- 右侧运行/错误通知默认只显示语义 icon 和数量；hover、focus 或明确交互时再展开文案，展开不能遮挡项目名或改变列表跳动。
- Pinned item 必须是可点击的导航入口；Topic 的 pin 标记贴近标题并保持在标题行的视觉轨道内，不漂浮到整行中央。
- Scratch Topic 只展示当前打开的 Agent，顺序沿用真实 Tab 顺序；Agent 图标、状态和对应 Tab/Region 信息必须在同一行内成组表达。
- Project Rail 的密度由用户在 Projects 标题行就地切换（加号旁），不进设置页；提供默认、紧凑、更紧凑三档，按同一个入口循环。切换只改变行高、行图标尺寸与每层缩进，**不改变树结构、归属、选中项或滚动位置**——密度是看法，不是数据。默认档的树缩进也要保持克制，避免切换后仍把项目标题推得太远；该选择重启后仍然有效（视觉档位见 DEN「Project Rail 与 Topic 行密度」）。
- running 与 working 必须**同时**在字形与动势上可分：`running`（进程活着、未在产出）保持静态 glyph，`working`（正在产出）带节奏动势。只换提示文字、只换颜色、或两者都静态都不满足这条；reduced-motion 下动势退化为静态但**字形差异必须保留**（约束原文见 DEN「Agents、队列与语义 token 密度」，此处只补「哪一个是哪一个」）。

### Agents、队列与 Message Tools

- Agents 二级菜单优先呈现对象、当前动作和下一步，不堆叠 provider、配置名、路径和重复状态；详细信息在展开或 hover 中补充。
- `running` 表示 Agent 已打开可交互，`working` 表示已打开且正在输出；两者在图标、文案和动态上必须有稳定区分。最近动作可得时优先显示动作，未知时才退回状态词。
- Agent 的用户显示名、Provider 名和配置名必须分别标注，不能把 Provider/配置名伪装成用户给 Agent 起的名字。
- 消息队列项必须可展开后删除或立即发送，保留原消息和失败原因，发件列表逐条表达受阻与失败，未读提醒通过统一邮箱红点表达。**「自动发送失败后停止重试」只对真的失败成立，不对「我们没看清」成立。** 这条原先写成无条件停止重试，那是把 AGENTS.md 第 11 条的第 2 类写成了第 1 类：readiness 还没观察到（`epoch-missing`）时 Agent 进程活着、PTY 照收字节，停止重试等于我们自己的观测没走通就把用户的消息判了死刑。用户原话：「即使当时发不出去，它也应该还是在队列里面一直等着，对吗？」——对。因此：Agent 仍可工作时，条目**留在队列里并继续等下一次可投递时机**，同时如实说明当前没投出去和原因。这里「如实说明」是硬约束而不是补充：投递受阻必须是一个**与正常排队并列的独立状态**，不能复用「排队中」那一档。只有两档（排队中／失败）时，受阻只能借「排队中」的文案，数量标识会**肯定地**说「N messages queued for delivery」，而真相是此刻投不出去——那是第 11 条的另一侧边界：不许静默降级。反过来也不许借「失败」那一档：Agent 好着，画成报错样子是往第 1 类说谎。所以三档各说各的话，且各自要求另外两档的说法**不在场**；受阻这一档要说清三件事——哪一步没走通、现在什么状态、要不要用户动手（不需要，会自动重试）。同一条受阻**只在第一次发现时上报一次**：用户刚敲完回车那次必须说（邮箱红点与收件通知让真正原因可发现），之后的自动重试保持安静——已读后的驻留状态由邮箱中的当前问题表达，不靠反复弹窗。只有 Agent 真的不能再工作（Run 已退出、进程已死、payload 从未被接受）才进终局并停止重试。
- **一个未投出的条目不得堵住它后面能投的条目。** 保序是「按作者顺序投递」，不是「卡在第一个上」。一个条目进了终局，队列不能因此整条停摆——那会让一次失败升级成整个 Session 再也发不出消息。
- Message Tools 使用独立于队列的图标和三态点击，三态改变的是**输入区自身的形态**：收起成一行（只留输入行与主动作，工具整排隐藏）、两行常态（输入行 + 一排工具）、大输入框（输入区放高供长文编辑，工具排仍在）。用户原话：「最左下角的 message tool 按钮才需要支持三态点击（收起成一行，支持展开两行可输入格式和大输入框）」。
- **三态的触发入口只有一个**，即工具行最左侧那枚键。用户原话：「而不是右边那个 collapse」——曾经并存的第二个入口（绝对定位在左下角、与这枚键共用同一枚图标的 disclosure）已废止：同一枚图标出现在两处，用户无法从图标区分两者管的是不同的事，而它们管的本就是同一件事。此后新增任何收起/展开手势都必须并入这一枚键，不得再长出第二个入口。
- **三档必须有真实可见的形态差异，切换入口始终留在左边。** 用户补充：「第三次切换好像没有变化」「换个更一看就懂的图标，且保持在左边」。空草稿和短文字切到大输入框也必须立即变高，不能只增加生长上限；回到一行时草稿、引用和编辑能力保留。唯一切换键用展开工具行、放大输入框、收回一行的动作图形与可访问名称说明下一步，不再用设置滑杆暗示它是参数设置。该键在三档里都在输入组件左侧，不随工具数目或分屏宽度漂到右边。
- **一行态里任何东西都不许叠在另一样东西上。** 用户原话：「现在 messagetools 收成一行的时候会叠在一起」。两行态下有两处不参与文档流、靠绝对定位待在输入框上方空白里的元素（Region 名水印）以及一排允许折行的工具按钮；收成一行之后，那片空白不存在了，绝对定位的元素正好落在工具条与主操作的位置上，而允许折行的按钮排在窄宽度下会叠成两层。约束是：**一行态必须是真正的一行**——没有安放位置的装饰性元素在该形态下不显示（其信息在别处仍可得，例如 Region 名在标签页上），控件排不折行。判据不是 z-index 谁在上面：叠在可点击控件上的装饰即使不吃点击，读起来也是糊成一团。
- 输入中的 skill/component/subcommand 以带下划线的语义 token 呈现，显示短名，hover 显示完整引用，点击打开对应交互或预置 prompt。
- **启动页的 message tool 与页面其余块同一条列居中，不许偏左。** 用户原话：「初始页面上 message tool 偏左」。启动页（Launcher / NewTabSurface）里标题、Agent 目录、命名输入与页脚都在同一条 640px 列内居中；message tool 是同一列的一员，必须与紧邻其上的 Agent 目录、其下的命名输入左右对齐。它复用会话 Composer 的表面样式，但会话 Composer 那份贴着 Region 边缘的侧向 inset 只属于 Region 内，不得让启动页这一块被钉到左缘。
- **启动页的 message tool 整个可见框都必须能打字。** 用户原话：「而且无法输入」。用户看到的输入框有多高，可编辑区就有多高——不许出现「上面一行能输入、下面一片是死区」：点击可见框的任何位置都落在可编辑元素上并放置光标，而不是点空、把已聚焦的编辑器 blur 掉。约束落在**可编辑元素自身**的高度上，不靠撑高它外层那个不可编辑的包裹容器（那正是死区的来源）。


### Provider 与人机交互的分层收敛

- AgentMux 接入多个 harness，不自行接管各 harness 的模型循环、工具执行、上下文压缩或内部任务真值。Provider 负责协议差异；Core 负责跨 Provider 的 Session、投递、交互与恢复语义；Client 负责呈现和用户手势；ctxmux 继续独占 Run/PTY/Replay 等运行时事实。
- 观测必须区分运行时存活、Provider 执行状态、输入可消费状态、等待用户和业务任务状态。缺失、过期、互相矛盾的证据有来源与时间，不能合并为一个 busy 布尔值，也不能以进程输出或 CPU 代替语义。Provider 特有的工具/goal/workflow 事件只按已声明能力呈现。
- 人机交互由 AgentMux 统一承接：Provider 描述原生权限/问题及可回答选项，Core 绑定精确 Session、Run 与 request 身份并维护其生命周期，Client 复用对应交互面。普通消息、排队、steer、回答权限/问题、interrupt 当前轮、stop 执行、pause loop 的意图必须区分；共享身份、投递与回执规则不等于共用一种写入语义。
- 用户消息从草稿到已入队、Host 已接收、Provider 已消费的证据必须区分；未知回执不冒充成功，也不自动重复发送。尚未成功生效的内容应保持可取回；草稿编辑状态由 Client 持有，提交后的投递事实由 Core 持有，不能把草稿硬搬成 Runtime 真值。
- 原生回答或其他客户端已处理的请求不得继续显示为待回答；旧 Run/request 的迟到回复不得作用于新请求。无法确认是否已处理时明确显示待核实和原生交互入口，不自动选择选项，不用普通 prompt 绕过权限问题。
- Agent 活着但我们的握手、探测或观察失败时，保留其已有可用操作并呈现服务窗；不通过盲发、猜选项或伪装 ready 来“恢复”。完全损坏才诚实阻断，未知如实标未知。
- 人机交互反馈分为：当前输入组件内的操作结果、Session 的待答请求/持续服务窗、跨工作区的注意力摘要。每一层消费同一个请求或结果身份；已关闭 transient 提示不因重放复活，尚未解决的持久问题仍可找到并定位原对象。
- 重启/重装/暂时空快照后先恢复 durable Tab、Tab Group、Region、焦点和布局，再按原 Session 身份自动 reattach/resume；流程超时、旧 lease 和 Provider 探测失败不能删除投影。只有 Core 明确 retired/unknown 终局事实允许移除。交互与投递恢复不能串到替换后的 Run。
- 此次收敛以现有状态、interaction、delivery queue、continuous-progress scheduler 与持久化接口为起点；消除重复 owner 和重复判断，不要求将所有状态改成事件溯源，不新增自演化引擎、通用 Job/Workflow/插件平台或平行兼容实现。已有 loop 复用统一观察与投递边界，任务完成真值仍归任务来源。

- 架构可发现性也是本次分层收敛的约束：公共文档与 API 入口应能引导维护者找到既有能力的唯一 owner、真实消费者与行为证据，区分已有实现、可选 Provider 能力和待实现需求；分析遗漏须先核对来源，不以未经查证的“能力缺失”新增平行实现。

### 可复用对话与 Workflow 表面组件

用户确认的演进方向：技术方面向原有成熟组件靠拢，设计风格参考新的 Workflow；提高视觉设计感和产品成熟度，让工作流观察更清晰。组件事实归宿主，展示策略有唯一 owner，交互状态支持宿主控制；Gallery 展示必须能独立构建，不初始化桌面 Store 或 Runtime。现有聊天和观察表面的视觉改版保留输入、权限、滚动、身份轴与服务窗的既有行为，不把 Workflow 假数据接入真实聊天。前端技术栈按当前依赖、实际问题与迁移成本评审，不以换框架代替设计工作。视觉规范的层级和唯一来源见 Surface 密度合同。

- 参考页里的 Workflow 时间线不是一张只能复制的样稿，而是一组可以被不同 Client 消费的受控组件：普通 tool 行、Workflow 摘要头、阶段折叠、Agent 行、Agent 元信息、安静项折叠、旧 daemon 降级行、dock 压缩态和输入框上方提示条都必须有稳定的类型化输入与可访问状态。
- 这些组件先形成独立的 Renderer 组件层和只读展示 Gallery，暂不接入现有聊天时间线；Gallery 只是验证真实生产调用者、响应式密度和状态切换，不成为第二个聊天数据源。后续聊天接入时，数据适配发生在宿主层，组件不读 Store、不猜 Provider/Run 状态。
- Workflow 组件只表达观察事实：`running`、`completed`、`failed`、`killed`、`paused`、`queued` 的视觉与中文文案一一对应；只有真实拥有阶段明细时才提供折叠箭头，旧 daemon 退化成普通 tool 行并持续说明“daemon 版本较旧，暂无阶段明细”，不留空壳。
- 折叠是统一的 disclosure 语义：按钮通过 `aria-expanded`/`aria-controls` 管理卡片、阶段和“还有 n 个”；Agent 行点击、Enter、Space 都能打开同一份元信息，失败行永不被安静折叠吞掉。运行中保持展开，终态默认摘要化；用户展开后状态更新不能把焦点或展开意图抹掉。
- 大规模列表超过 8 个 Agent 时自动分栏；分栏后尾部连续的 queued/completed 安静项可以收进可反复展开的“还有 n 个”，失败项不能进入该折叠。窄屏隐藏模型与最近工具，并把头部统计放到第二行；dock 使用同一组件的紧凑变体并限制内部滚动高度。

- 工作中的 Composer 同时保留“发送 steer”和“中断当轮”两个可见动作；发送只提交补充指令，不改变当前 Run 的生命周期。Enter 仍是发送快捷键，按钮文案必须让两者可区分。
- Activity 聚合行的状态只出现一次；等待、错误和阻塞等摘要不得再追加同义状态标签。路径与 Host 只作为次级元信息，不得把工作线行撑成多行卡片。
- 聊天页已有的 ConversationAxis、AgentMarkdown、AgentInteractionCard、ComposerTextarea、StatusDot 和 ServiceWindowNotice 是同一组件体系的既有成员；它们继续各自拥有身份轴、正文、请求回答、IME 输入、状态点和服务窗事实，不复制一份“聊天版”实现。Activity 内部的 Row/Run/Turn/Ruler 在后续接入时也沿用同一边界。
- 组件的可访问名称、键盘操作、焦点环、减少动画和非颜色状态提示是组件契约，不由 Gallery 或未来聊天宿主补丁式添加。颜色与侧边细条不得成为唯一选中/状态信号；状态必须同时有字形、文案或结构变化。

### 对话接入新组件与输入引用闭环

- 用户确认「继续推进，另外对话的样式也可以接入新组件」：真实对话与 Gallery 共用消息组件，沿用现有时间线、说话人身份、Markdown、文件打开、图片、继续会话和滚动行为；不把示例 Workflow 阶段或进度伪造为真实对话事实。
- 输入中的 skill/component 引用在正文原位显示短名、类型与下划线，可查看完整引用并打开；编辑、选择、粘贴、撤销、中文组字与发送保持可靠。引用目标随草稿一起恢复，重启后不能只剩无法解析的短名。
- Provider 原生命令保持原语义；本地预置 prompt 明确标识为提示词，点击后在原位展开为可编辑正文，保留其他草稿且不自动发送。两者复用已有工具候选入口，不建立第二套命令执行系统。

#### Shortcuts（AgentMux 自己的快捷指令）与识别词

- **命名：Agent 的叫 commands，AgentMux 的叫 Shortcuts。** 用户原话：「如果现在的 commands 是指用到的 agent 自己的 commands, 那么我们再加一个 shortcuts 表示 Agentmux 提供的自定义能力」。`commands` 这个词归 Provider 原生命令（`/compact`、`/context` 这些由 Agent 自己执行的）；AgentMux 提供、用户可编辑的那一套叫 **Shortcut**。两者行为本就不同——一个交给 Agent 执行，一个只是把正文填进草稿——用同一个词称呼它们，用户没有办法表达「我要改的是我自己那套」。
- **Shortcut 只有一套，且由用户拥有。** 用户原话：「Review Changes 等快捷指令 和 commands 是不是重复了，应该只有一套，而且配置页面要支持用户自定义」。此前的形态是两套并存：一份写死在代码里的预置只能从两枚常驻按钮到达，而把它并入候选列表的那段代码从来匹配不上任何东西——即用户打 `/review` 一条候选都不会出。合并的判据是**候选入口只有一处**：Provider 原生命令与 Shortcut 在同一份候选里出现，不是两排按钮、也不是两个浮层。
- **同一个 `/` 列表，但按来源分组并带组标题。** 用户在被问到呈现方式时选定此项。候选浮层分成 Shortcuts 与 Agent commands 两段，各有小标题；用户因此只需记一个触发符，同时能看清每条是谁提供的。不采用第二个触发符（如 `>`）把两者彻底分开：那要求用户记两个符号，且这类前缀在终端语境里另有含义。命名冲突仍沿用本节上方「显示来源并按明确选择生成 prompt」那条。
- **代码不再持有 Shortcut 正文。** 内置的那两条作为**可改可删的默认项**落进用户配置，此后增删改全归用户；删掉即永久没有，不被补回。设置页是它唯一的编辑面。
- **缺席与空列表是两件事。** 配置里**没有这个键**＝这份配置写于本功能之前，读成默认那两条；**显式空列表**＝用户把默认那两条都删了，保持为空。两者只差一个键的有无，混为一谈会二择其一地坏：要么旧配置的用户永远看不到任何 Shortcut（功能像根本没做），要么用户删掉的东西被塞回来。
- **每条 Shortcut 可选绑定单个 Provider。** 留空即对所有 Agent 生效；绑定后只在该 Provider 的 Composer 出现——「这条只对某一家有意义」必须能表达，否则用户只能靠自觉不去用错。
- **识别词（keyword）是同一条 Shortcut 的另一个到达方式，不是第二份注册表。** 用户原话：「prompt 要支持 "识别词"，比如 eli5 或者 grill_me prompt，当用户在 messagetool 输入 eli5 或者 grill 时，要出现下划线 / 输入的时候就出现 tips 提醒，tab 一键替换 / 点击出现菜单，可以一键替换」。同一个 keyword 字段同时供 `/` 候选与**裸词**识别：命中即在正文原位加下划线（沿用既有语义 token 的下划线语汇，不新造一种视觉），打字过程中就给出提示，Tab 一键替换为正文，点击则复用同一份候选浮层。
- **Tab 只在光标处确实命中 keyword 时被接管**，否则原样放行给焦点遍历——沿用本仓既有纪律（方向键在没有候选时把按键还给光标移动）。未命中的 `eli5` 之外的普通词保持普通输入，不得因为像识别词就被改写。
#### Skill 加载必须快到没有加载感

用户原话：「现在我加载 Skill 和 Command 的时候非常卡，既卡顿又很慢。Command 相对比较快，但 Skill
上来还要 loading 一会儿，而且在 loading 的时候就会卡住」「我理解 Skill 的 loading 应该有很多策略，
可以让它在 SSOT 的情况下加载得更好一些」。

这条差异本身就是判据：Command 与 Skill 同一时刻同一台机器，一个快一个慢，所以它是**代码路径**的
事实，不是环境的事实。

- **Provider 声明 skill 目录这件事已经是规范，不新建第二套。** 每个 Provider 在自己的 catalog 里
  声明 `composer.skillRoots`（用户原话「我们应该可以在 Provider 上定义规范」）。新增 Provider 只
  需要声明自己的目录，发现策略不得按 Provider 名分支。
- **发现必须剪枝。** 依赖目录、版本控制内部目录与构建产物里不存在 skill，遍历不得进入。仓内已有
  一处经过实测的同类策略（`project-appearance.ts` 的 SKIP_DIRS + 深度封顶 + 目录数预算 + 常规位置
  先试），Skill 发现沿用同一套，不各写一份。判据：遍历的目录数必须与**真实 skill 目录**同数量级，
  而不是与工作区的目录总数同数量级。
- **加载不得阻塞输入。** 菜单可以先出现再填充，但输入框在任何时刻都必须能继续打字。
- **同一份结果不得反复重算。** 打开菜单不是"目录变了"的证据；只有目录真的变了才重新发现。
- **两个入口一个策略。** Session 侧与 Workspace 侧的 skill 发现回答同一个问题，不允许一个入口比
  另一个多付代价（例如为查一个 session 先取整个运行时快照）。

#### Composer 静息形态与主操作

- **静息即一行。** 用户原话「现在一上来就是两行的样式，是不是改成一上来是一行？」。空输入框的静息
  形态是一行；两行及大输入框是用户主动换的档位，不是默认。
- **切换键在一行态必须是弱的。** 用户原话「只有一行的时候存在感有点太强了（这个时候本来就应该是
  弱的），高度应该稍微再窄一些，最好不要有那么强的边框」。一行态是最安静的形态，它的控件也要最
  安静：控件同高（见密度 SSOT）、不要重边框。切换位置与图标统一遵循上文 Message Tools 三态约束。
- **Send 与 Interrupt 收成图标。** 用户原话「现在 send 和 interrupt 的样式也有点太强了，是不是直接
  用图标就好了？」。两者都降为图标控件；Interrupt 仍必须与 Send 在视觉上可区分——它是破坏性动作，
  收成图标不等于收掉这个区分。
- **Cmd+Enter 直接 steer。** 用户原话「如果发消息，现在好像默认不会 steer。有一些常见操作，比如说
  按住 command + 回车的话，应该就是直接 steer 发送出去这条消息」。约束：`Cmd+Enter` 表示"插到当前
  这一轮里去"，与裸 Enter 的"按常规发送"是两个不同的意图，不能互相退化；Agent 闲着时它也必须有
  确定含义，而不是只在忙的时候才存在。
  - 用户再次反馈「MessageTool 原始需求是发送直接 steer，结果现在都在排队」：Cmd/Ctrl+Enter、显式 Send 和发件条目的“立即发送”本身就是**这一条消息**的 steer 授权，不要求再点 Continue。它应立即尝试向当前 Run 投递；真实交互、部分投递或错误 Run 仍可拒绝，并保留原因和文字。缺少回合结束或屏幕确认属于流程观测，须如实说明，不能因此永久阻断本可输入的 Agent。
  - 同一原意适用于已通过目标、身份和当前 Run 校验的 Control `send` 与 CLI `agentmux send`：这一条明确命令就是当前消息的 steer 意图。缺少上一轮完成或输入框确认不能把它挡成未投递；沿 Core 既有单消息选择尝试，保留真实不确定性告示。交互、部分投递、操作幂等、Run 与能力边界仍由各自 owner 裁决；定时／持续推进、后台消费和普通队列不借用这一次命令的授权。
  - 裸 Enter 在 working／待答时仍表示排队，不借用另一条消息的显式授权。旧 queue-only 项不阻塞新明确 steer；多个明确 steer 保持自身队列顺序，共用唯一消费者，不双发。发送中再来的 steer 意图不能因 await 丢失；重启、自动消费、阅读、队列重排或其他消息不生成新的 steer 授权。

#### Message Tools 的身份与右上角那行字

- **正在用的 Agent 要看得见。** 用户原话「我感觉 MessageTools 该品牌升级了，实际在用的 Agent 头像
  也应该显示出来，而不是只在右边有一个名字」。Composer 必须能直接看出此刻在跟哪个 Agent 说话。
- **右上角那行字要换成对用户有意义的名字。** 用户原话「右边的项目名字，也应该改成 tab 名 / region
  内的 session 名，要不然没啥意义」。它此前显示 Region 名（常常就是项目名，用户已明确说没意义）。
  连带约束：此前因为它是"无意义的装饰"而在一行态整个隐藏的处理，必须随内容一起重新判断——一个有
  意义的 session 名不能沿用"反正没意义所以藏掉"这个理由继续藏着。用户进一步明确「有了 Agent 图标，是不是就不用额外显示名字，而且最好是靠右边，不和功能区放一起」：常态只显示右侧头像，与左侧功能区分离；Session 名、Tab 上下文和状态保留在悬停提示及可访问名称，不再额外常驻名称文字。

- 交付证据必须覆盖真实宿主调用、关键实现变异变红、浏览器交互及草稿恢复；此前已归档任务的验收缺口在本次明确补证，不以归档状态代替验证。

- **Browser 内嵌 frame 发起的应用交接也必须走同一条应用链接交接。** 页面把自定义应用 scheme 放在跨域 iframe 或其他子 frame 中时，Browser 不能因为它不是顶层导航就静默放行或吞掉。约束：顶层页面和子 frame 的应用链接都先拦截、按 scheme 询问一次并交给系统，普通 http(s) 子 frame 继续由页面自行加载，页面本身仍留在当前 Browser。

### Browser 通用交接闭环

- 用户要求「彻底完成」：外部应用交接以系统调用的完成或失败为准；失败在当前 Browser 说明失败步骤与重试动作，网页保持可用。记住选择失败不能阻断用户这一次明确同意的交接，也不能假装保存成功。
- 顶层、子 frame、重定向及新窗口中的应用链接复用同一机制；普通网页导航和原生窗口语义保持可用。异步结果不能覆盖后来的请求或已经离开的页面；一次用户回答只执行一次交接。
- 用户要求「Agent 在操作的指示要高级，最好也参考交接设计」：操作中、交还用户和结束必须可区分；人点击、输入或滚动后立即停止 Agent 后续操作，提示交还结果。提示不抢焦点、不遮挡主内容，控制权仍由 Main 的真实输入事实持有，页面装饰不能授予 Agent 控制权。

### Browser RSI 记录与回放可达性

- 操作历史是工作面的一等入口：没有新操作时也能打开，重启后仍能看到已完成、已停止和需要复核的记录。当前 Browser 的即时投影与 durable 历史不得各自维护一套语义；选择某条历史后，时间线、来源 Agent、页面身份和回放计划仍指向同一个 operation identity。
- 回放计划必须保留所有已观察到的步骤。需要重新输入、权限确认、外部应用交接、脚本或协议逃生口等人工闸门可以阻止执行，但不能从预览和审计记录中消失，也不能让前面的动作先执行后才发现后面不可执行。
- 记录或投影写入失败属于流程状态：健康 Browser 继续工作，同时在操作条、历史入口或服务窗持续说明“记录不可用”和恢复动作；不能静默降级，也不能把空历史伪装成“没有操作”。
- 停止、接管、交还和单步回放必须通过同一条 Main-owned 控制链，拥有清晰的下一步和取消路径；Renderer 只能消费事实，不能自己推断某个回放已经成功。

### Browser 通用能力协议与 CLI/Skill 接入

选型论证、现状缺口与竖切顺序见
[`browser-capability-protocol-and-cli-skill.md`](../reviews/browser-capability-protocol-and-cli-skill.md)；
本节只记约束。

- **协议层是 Browser 能力的唯一事实入口。** 能力清单、权限、身份、requestId、operationId、
  事件与进度、取消、历史、回放和 indeterminate 结果都从这一层给出。任何客户端——CLI、编辑器
  自身、以及将来的 MCP/HTTP 适配器——都只能是这一层之上的平级客户端，不得绕过它直接驱动
  Browser，也不得为自己保留一份第二语义。编辑器现有的停止、历史与回放入口属于"与协议重叠"
  的那部分，必须收口到同一入口；与能力无关的视口、截图、DevTools 等本地控制不在此列。
- **协议刻意放宽的类型，收窄点只能有一个。** 协议不持有 Desktop 的步骤语义，也不该为了 Desktop 多
  一档状态就发一次版本，所以它把 phase 与 step 放宽。代价落在 Desktop：收窄必须只经一个门，两个门
  就是两份词表，加一档时漏改一处会让那一档在其中一条路上静默降级。认不出的状态只能落到"不确定"
  那一档，不得改写成一个眼熟的档位——那是拿一个我们没有的事实冒充。
- **CLI 只做适配，不做判断。** 它把命令与 stdin 转成协议请求、把回执按稳定信封打印出来。
  凡是"什么算合法请求"的判断都属于协议层：同一条规则不许在 CLI 与协议各写一遍，也不许只写在
  CLI 里——后者会让直连协议的客户端拿到一个 CLI 客户端拿不到的不确定结局。
  - Core 已区分的“另一条消息正在投递”与“Session Store 读取未确认”，经过公开 Control 与 CLI 后仍须保留对应错误类型；消息与原 Session/Run 保持，未确认不等于退休或进程故障。提示只给真实可执行的下一步，不指示重新创建、停止健康 Run 或盲重放未知投递。错误码由同一协议来源给出，不在 CLI 另抄清单；协议回执通过不替代 Desktop IPC 错误字段传输的实际证明。
- **Agent 面向的能力说明必须从协议与运行时能力生成。** 机械部分——能调哪些页面能力、签名、
  错误码——只能有一个来源，由它渲染出 Skill 文本。手抄一份再用扫描测试去对齐不算满足：
  那只对齐名字，不对齐签名与错误信息，且扫描自身会在锚点消失时静默恒真。散文式的意图说明
  仍由人维护，但不得与机械清单争夺真相。
- **页面能力清单作为数据跨层流动，不作为操作进协议。** 协议表面保持 `browser` 命名空间下
  那几个操作；`snapshot` / `click` / `js` / `cdp` 这类页面能力属于库层词汇，提升成协议操作会
  让每次增删能力都变成一次协议版本变更。观察—行动—验证闭环写在脚本里，`js` / `cdp` 两个
  逃生口是必须项。
- **operation 的寿命长于任何一条连接。** 一次操作从可被引用的那一刻起就有稳定 identity，
  并且要在操作还在跑的时候就能被别的连接查询、订阅进度和取消。CLI 断开、daemon 重启或
  客户端换一条连接都不得让操作事实消失或变成"没有这回事"；已经无法继续的操作按既有 durable
  历史表达为中断或不确定，不伪装成正在执行。operation identity 只能有一个铸造点。
- **取消是对 operation 的取消，不是对请求的取消。** 判据是"那次操作是否停下了"，
  而不是"我这条请求是否被放弃"。对一个已经结束的操作取消是幂等成功并答出它的终局，不是失败。
- **人工接管优先，且拒绝必须是机器可判的。** 人在控制中时，Agent 的驱动请求被拒绝，
  恢复只能由人明确发起；Agent 不得靠重试静默夺回页面。这条拒绝要带类型化的原因，
  让协议客户端能把"人在用这一页"与"出故障了"分开，而不是收到一句散文。
- **协议自身的流程失败不得拿走 Browser 已有的能力。** 订阅建立不成、进度流中断、查不到某条
  operation、版本协商不一致——这些都属于我们的流程状态：操作照跑、页面照用，同时用服务窗说清
  哪一步没走通、现在按什么状态在跑、要恢复完整能力该做什么。只有能力本身真的不可用
  （页面没了、进程死了、注入清单读不出来）才允许阻断。进度有缺口时明说缺口，不静默丢事件。
- **进度是一条独立的长连接路径，不是把一问一答那条放宽。** 现有操作全都是"读一条→回一条→关闭"，
  且拒绝尾随数据；为了流式而放宽那条检查会让全部操作的 framing 假设一起松掉。所以订阅是新增的
  一支：开场一帧交代当下事实（那条操作、以及有没有缺口），之后每条事件一帧。事件游标只在**一个
  进程的生命周期内**有意义——事件落盘时不带号，重启后拿旧游标接着要没有意义，客户端要么从头要、
  要么接受一个明说的缺口。
- **外部客户端要够得着这条协议。** 端点位置与协议版本必须可以从产品自身问出来，
  而不是要求对方复算内部派生规则。这条服务的是"另一个语言写的客户端能接进来"，
  不是某个具体客户端。
- **全链站点/厂商无关。** 协议、CLI、生成出的能力说明与公共测试都只依赖通用事实
  （页面能力名、通用逃生口、URL scheme、导航事件、人工输入）。不得在实现分支、公共测试或
  验收条件里预设具体站点、按钮文案或厂商协议；真实站点只作黑盒验证输入。

### 终端历史读取与投递确认提示

- 用户反馈经常出现 “Reading the terminal output history didn’t complete / Prompt delivery continued without full screen confirmation”，但看不出原因。提示必须说明实际缺失的是哪种证据、当前是否已提交、应做什么；不得将历史保留窗口的正常截断笼统说成发送失败。
- 旧终端历史不在保留区，不能让健康 Agent 此后的每次发送永久退回同一降级。屏幕确认应围绕当前提交所需的权威输出与当前尺寸收敛；真实缺口仍须如实表达，不把部分证据伪装成完整验证，也不因确认流程失败阻断健康进程。
- 投递确认提示由 Core 的当前 Run/提交证据拥有；已被后续有效证据解决的状态应自动收敛，历史告示不得被旧观察反复复活。

### Message Tools 邮箱

用户要求像游戏里的 Mailbox：“新消息有红点，看过了红点就消失”，排队消息也放到“发件列表”，“这两个组件就统一了”。Message Tools 只保留一个邮箱入口，与右侧 Agent 头像合成位置稳定的会话控件，内部区分收件通知与发件列表；不再同时摆放独立队列入口或在输入区铺设持久报错横幅。新通知有红点；打开并看到收件通知即算已读，红点消失，当前问题仍可回看。仅浏览发件列表不能把未看的通知标已读。数量与未读是不同事实，不能把正在排队误报成新通知。

已读不表示运行时恢复。收件通知保留当前问题、影响和恢复动作；相同原因持续更新而非重复堆积，只有恢复后再发生、原因或严重程度变化、新 Run 的问题才重新提醒。切换 Tab、重挂载和应用重启不能把相同已读问题重新变成未读。已解决条目随权威事实消失，不维护第二份 Runtime 状态或无限错误历史。连接、投递核验、队列阻塞和局部操作失败都归入当前 Session 邮箱；局部重试仍然可用。发件列表的复制和手动重试失败也留在同一个邮箱中，不另开全局错误条；再次成功后相应局部错误消除。

发件列表保留实际待发送文字、次序、状态与原因，以及已有重试、复制和移除能力。看过通知不会取消或重投消息；发送中不能移除或并发重试；旧 Run 的消息不能误投到新 Run。空列表明确为空。邮箱在三种输入框形态都可访问，不因忙碌、输入禁用或窄分屏而不可用。视觉约束见密度 SSOT 的“Message Tools 邮箱”。

### Steer 与 Provider 输入能力

用户反馈工作中的 steer 被“composer readiness epoch already consumed”拒绝。Provider 负责具体 CLI 的可用输入方式及就绪证据，Core 负责同一 Run 的并发提交、去重和交付。不能把 turn 完成信号当成所有输入的唯一机会，使本可接受 steer 的健康 Agent 被内部纪元卡住；也不能绕过尚未完成的提交或把未知输入状态猜成安全。已入队未投出的消息必须保留；提示准确说清当前等待对象，不能承诺永远等不到的自动恢复，也不能建议结束健康 Session 来修复流程。

Readiness 是 Provider 输入框的观测证据，不是健康 Run 的永久发送许可证。一次未观测到、超时、已消费的旧证据不得阻断后续人工发送或 steer；事务冲突、未完成投递、错 Run 和待回答交互仍由各自权威 owner 处理。缺少屏幕确认时必须明确告知，后续真实验证成功才清除不确定性。

自动续跑以当前 Run 的实际 turn 完成事实作为触发机会，每个完成事实最多推进一次；working、待回答交互、未知完成状态仍不自动发送。其去重必须由持久化调度 owner 持有，不靠屏幕 readiness 恰好成功或被消费来间接阻止重复。

自动推进的认领和发送确认必须分开：在认领之后、确认之前重启，显示结果未知并保留原投递标识供显式继续；不得伪装为已完成，也不得默默重复投递。暂停、停止、新一轮开始或 Run 更换后，旧完成事实不得再触发发送。通知已读记录不能因重启过程尚未载入 Session 事实而丢失。

人工消息先于 Provider 的开始工作事件被接收时，旧 done 事实也已经被该次输入使用，不能让自动推进再借它发送一条；这个事实由 Core 在输入认领时原子记录，适用于单阶段和两阶段 Provider。人工 steer 不受已使用完成事实的限制；同一已认领操作仍可取回原回执。

### 输入框截图缩略图

用户反馈“现在截图在输入框里头还是没有变成缩略图展示”。截图与粘贴图片进入草稿后，必须在输入框内显示可辨认的缩略图并可放大检查；发送前即可确认是哪张图。缩略图只是同一图片引用的展示，不改变实际发送路径、草稿持久化、复制、撤销或删除语义。加载中和不可读取时原始引用仍可见，不能把图片引用悄悄丢掉。重挂载后仍能从同一持久引用恢复缩略图；Session 输入框和新建 Agent 的输入框共用这项能力。尺寸语言见密度 SSOT。

### Message Tools 右侧操作整体

用户要求“右下角的所有图标，包括发送和打断也放一起”，现状“不够整体”。用量、主操作、邮箱与 Agent 头像共用固定右侧操作组，忙闲、三种输入框形态和窄分屏不改变组高度或右侧落点。邮箱与头像分别交互，打开邮箱不发送也不打断。头像名称留在 hover 和详情，不挤占功能区。

- 发送与打断共用一个主按钮：空闲时发送、执行中实心方块打断。打断仅中断当前回复并保留 Session，终止 Session 仍归生命周期入口；键盘发送／排队／steer 语义保持不变。
- Mailbox 分为 Inbox（其他 Agent 来信）、Outbox（用户发件及投递状态）、System（系统通知）。每次打开优先展示未读内容，没有未读且有发件时默认 Outbox，其余为空 Inbox；打开后不因新消息到达强制换栏。已读只表示用户看过，不代表 Agent 处理或投递成功。
- 邮件保留窗口与工具活动窗口分开，工具活动不能把尚未查看的来信挤掉；沿用 Core 持久记录，不另建交付账本。只把已确认投递的输入称为 Sent；初始／恢复输入的失败或未知结果如实呈现并保留内容。
- 已有持久送达事实的排队消息，即使发送调用随后因回包丢失而失败，也必须退出待发队列并继续处理下一条；不得重发已确认消息，也不得让后续消息无提示地停住。
- 已读回执不得复制正文或随消息长度增长，不得挤占布局与草稿存储。正文或送达状态改变重新提示，重启保持已读；仅明确终局移除 Session 时清理回执，未知或暂时空快照不得清理。
- 头像中央表示 Provider，颜色叠加与左上固定 Icon **按执行器配置**；右上表示状态，右下表示数量。菜单与头像共用状态语义，running（在线）与 working（正在处理）可区分。正常完成、主动打断与主动停止不得冒充真实错误；未知原因如实表达。
- 执行器 tint 采用珐琅标识语汇：Provider 与固定 Icon 先合并成一个闭合的相对实面，下面有不透明中性底片，底片外留 1px 间距后再用不透明 tint 画最外侧 1px 轮廓；Provider 本体颜色与镂空保持不变。不得用整幅 flood 覆盖图标本体，不得在镂空内侧画第二圈，也不得用模糊、半透明光晕代替珐琅轮廓。运行状态由右上共享状态角标表达。
- 图片保持内容比例并对齐正文行高。操作间距、hover、轮廓描边与颜色语言见密度 SSOT 同名小节。此确认取代此前举手与文字打断提议。

### Branch Pin 的层级与操作位

用户反馈「branch 被 pin 了以后，它的缩进不对」，且 Pin 按钮不应在没有 hover 时占用名称空间。固定分支仍归属原 Project；导航、组内顺序、折叠语义不变。Pin 操作只切换固定，不打开分支；鼠标悬停与键盘聚焦时均可发现和操作。视觉约束见 surface-density 的同名小节。

## Topic 行的 Region 与 Agent 在场状态

用户要求「topic 的 region 表示和 agent 图标融合到一起」「已经关闭的 agents 就不要再显示在那边」。Topic 行在 Region 缩略格内显示属于该 Region 的小 Agent 图标，不再将同一 Agent 另列一枚重复头像。没有打开 Region 的后台健康 Agent 仍应可见可达；关闭 Tab 不等于结束 Agent。已明确结束的进程不再占 Topic 行头像位，未知/断连不伪装成关闭；历史 Session 与协作者文件保持原状。视觉约束见 surface-density 的同名段。
### Outbox 成功送达后的收尾

用户反馈「已发送成功的消息有时仍留在 Outbox 的待发送列表」。待发送列表只包含尚未证实送达的操作；Core 已确认并记录成功的消息必须退出待发送，不能继续像排队中一样显示或提供重复发送入口。Renderer 更新、重启或响应链路丢失后，待发送仍须与同一 Session 的权威送达记录收敛。按操作身份对账，不以相同文本、Agent 开始工作或模糊提示猜测成功。已发送历史属于历史展示，不重新进入待发送。

### 旧 Agent 的恢复与叹号

用户报告当前版本不少叹号 Agent resume 一直停在 Resuming。Runtime 重启、用户停止、正常完成与 Agent 真正崩溃必须分清；恢复失败须说明卡在哪一步并保留原 Session 和工作面。恢复必须沿用原会话记录，不得让旧通知的失效观察无限挡住新 Run。仍活着的生命周期 owner 不因耗时超过预计期限就被其他客户端接管；进程已死仍须自动恢复。其他健康 Agent 不得被连带停止。状态视觉遵守 surface-density 的统一语言。

### Message Tools 单一主按钮与行内图片

按用户最新确认：发送与打断合成一个图标按钮，空闲显示发送箭头，执行中显示实心方形，打断保留会话。键盘的排队与 steer 意图保持独立且可用。粘贴截图按原比例适应内容，缩略图与正文行高对齐，仍可点开查看。头像与三分邮箱约束沿用本轮已确认设计，后续交付单独验收。
### Message Tool 粘贴保持光标与草稿

用户反馈「粘贴会覆盖内容，而非在光标位置 append」。普通文本、截图与文件引用必须插入光标处，只替换用户真实选中的范围，不能重置整段草稿。异步保存截图或选择文件期间继续输入的内容必须保留；插入位置随文档编辑移动，不能拿启动操作时的旧草稿覆盖最新输入。Agent 与 Launcher 共用此行为，粘贴可撤销。

### 全局通知与底部状态入口

- 全局环境提醒也必须可以收起，不能在整个工作面最下面长期占据一整条不可关闭的空间。收起只表示用户已看过，不表示环境已修好；未解决的问题仍可从固定系统通知入口再次查看。问题内容变化时重新提示未读，重启后相同已读问题不反复打扰。
- 全局系统问题与单个 Agent 的消息作用域明确；通知保留失败步骤、当前实际运行方式与恢复动作。通知不阻断健康 Agent。
- Working、Needs you、Error 的列表入口必须是清晰、一致、可键盘使用的同一类控件；跳转 Agent 与展开列表各自保持明确动作，空列表不提供无效入口。视觉约束见 surface-density 的同名条目。

### 恢复与多 View 的终端尺寸

- Resume / Attach / 重连后的终端网格必须取 ctxmux 当前尺寸事实，历史启动尺寸不能冒充当前尺寸。长时间打开的 View 也必须收到其他 Client 改尺寸的事实，按权威网格解析后续字节。
- 被动收到尺寸变化只同步展示，不能反向发 resize 与其他 View 来回争夺。只有真实布局/可见性变化触发的尺寸请求才表达本地 View 的需求；请求与回执仍由现有 Runtime 归属。
- 尺寸未知或观察失败不阻断健康 Agent，也不把旧缓存冒充确认结果；保留工作面并从系统通知说明当前可确认范围。

### Connecting 与 Redraw 必须收敛（ 复查）

- 用户反馈新 Session 一直 Connecting。新建和恢复必须最终进入可用输入／输出，或明确说明真实失败步骤与恢复动作；健康 Run 不能因 Renderer 重载、投影读取或握手流程悬住。一次正常启动只交付一个 Renderer 生命周期，精确 Session 的连接不能依赖无关历史 Run 的状态。
- 用户反馈点 Redraw 无效、画面错位但缩放能恢复，且恢复后 Redraw 不消失。Redraw 必须请求当前可见网格的真实重绘；布局／缩放恢复也必须让过期的画面损坏提示收敛。历史输出缺口与当前画面是否正确是不同事实，不得用缺失的历史永久否认已经恢复的当前画面。
- 左上标记只能从固定 Icon 集合中选择，不能输入、保存或渲染任意文字；选择结果在执行器设置、头像预览和所有 Executor 入口保持一致，位置与状态角标分开。

### Session 加载页的可恢复信息

- 加载页必须显示用户选择的目标 Executor（Provider 图形与执行器名称）以及本次初始 Prompt；Prompt 旁有复制按钮，复制完整原文并给出成功／失败反馈，卡住时也能手动继续。
- 加载意图属于这次启动请求，必须在发请求前保存；不能从正在输入的新草稿或相邻 Session 猜测。无初始 Prompt 时诚实说明，恢复已有 Session 不伪造初始 Prompt。动效不代表虚构的进度百分比。
- 新建、恢复与未知 Session 等待应说明各自事实；视觉约束见密度 SSOT 同名小节。

### Connecting 与 Terminal 恢复页的全页状态舞台

- **Connecting 是当前 Region 的全页状态舞台，不是一个挤在中间的小卡片**。它占满当前 Agent/Terminal Region 的内容面，保留窗口级 Titlebar、Tab、分屏边界与可导航的工作面；不覆盖整个应用窗口，也不把用户带到脱离原 Tab 的独立欢迎页。布局、Session 身份与用户已经输入的启动意图在舞台切换期间保持不变。
- Connecting 舞台用一个稳定的“意图锚点”承载 Executor、阶段标题和初始 Prompt；解构线条、注册标记、扫描线和背景层只围绕锚点运动。文字、Executor 图标和 Prompt 不抖动、不逐字跳动、不被动效遮挡，也不显示虚构的百分比或倒计时。
- Terminal 恢复页与 Connecting 共用同一套视觉语法，但占用规则不同：**没有可显示的当前终端画面时**，恢复舞台可以占满 Region；**已有可显示画面或 Run 仍健康时**，终端画面必须先交还给用户，恢复状态降为不遮挡的边缘层或服务窗。一次没有等到的握手、尺寸确认或输出泵重建不得永久把健康终端藏在全页 loading 后面。

### Terminal 内容层级与可读性

- Terminal 的 PTY 输出、恢复/失败服务窗、搜索条和 Agent Composer 必须各自占有明确的层级与边界；装饰背景不能穿过输出层制造点阵、重影或伪字符。
- xterm 的真实画布只由它自己的容器尺寸决定，隐藏、冷停或恢复阶段不得让旧 canvas、装饰层或 Composer 继续占用可见区域；内容区与输入区之间保留稳定的分隔和可读高度。
- 输出文本按终端原生字形连续渲染，光标、选择和 ANSI 色彩是唯一的内容强调；任何恢复动画只停留在空内容层，不覆盖已有输出，也不抢输入焦点。
- 终端在窄窗口、DPR 变化和切换回 Tab 后仍需重新测量真实 cell geometry；失败时保留可用输出并在旁边服务窗说明步骤，不用重叠的空白层伪装成成功。
- 恢复阶段必须把当前事实说清楚：例如“正在重放保留输出”“等待 Runtime 确认当前尺寸”“输出通道尚未接回”。只有 Runtime/Core 已确认的阶段才能显示；未知阶段写“尚未确认”，不能用动画暗示已经前进。输入是否可用与画面是否已交还分别表达，不能用一个“恢复中”笼统覆盖两者。
- 从舞台回到真实终端只在真实 attach、replay→live 交接或当前画面确认后发生一次收敛过渡；超时放行时保留原 Region 和服务窗告示，不能伪装成全链路成功。服务窗持续说明哪一步未完成、当前按什么状态运行以及可执行的恢复动作。
- Connecting 舞台可被复制 Prompt 的操作打断，但不因复制、切 Tab、切换分屏或窗口重绘而重新生成一套启动意图。恢复舞台的退出不能销毁 Tab、Region、Session 或布局持久化事实。

### Executor 标识的归属

- 用户明确：固定 Icon 直接在 Executor／Execution 配置里，这不算显示配置，而是为了标识 Executor。颜色叠加与左上 Icon 和该 Executor 一起编辑、保存；外观设置不再另放一份入口或配置。
- 所有代表具体 Agent 的图标都显示其 Executor 标识，不再只显示 Provider 标识；同 Provider 不同 Executor 可区分。Provider 图形作为未自定义时的默认底图。纯 Provider 能力目录仍表示 Provider，不凭空关联 Executor。
- 菜单、Tab／Region、Topic、列表、消息工具与设置预览消费同一 Executor 标识；状态角标与身份保持独立。此约束取代此前放在显示设置下的方案，视觉轮廓仍遵循密度 SSOT。

### 全局 Board 与固定 Leader Topic

用户确认：Board 不作为 Agents 的默认主视图。Board 是全局任务面，跨 Project、Workspace、Branch、Topic 可见；它承载任务卡、任务状态、目标项目和与 Agent 执行的关联，不再以当前 Workspace 的 Branch/Topic × Agent 状态矩阵作为产品模型。任务状态与 Agent/Attempt/Session 状态是不同事实，不能用同一个列或状态字段互相替代。

Agents 提供一个常驻的浮动助手入口。这个入口叫 **Leader Topic**，点击后展开或聚焦一个固定、产品拥有的 Topic；Topic 里的 Session 仍是正常的 AgentSession，必须通过 Core 的公开生命周期能力运行，不建立隐藏的第二套 Runtime。它可以读取全局项目目录与 Board，但不复用用户当前 Scratch Topic，也不跟随 Scratch 当前选中的 Topic。

用户可以直接与默认 Session 讨论需求。Session 分析后可以在全局 Board 创建任务，并为任务标记应执行的 Project；创建结果、目标 Project、分析依据和关联 Session 必须在对话与任务卡上可追踪，不能把跨项目的创建变成不可见的副作用。无法确定目标 Project 时保留待确认状态，不猜测归属，也不阻断 Session 继续对话。

Board 的“New Demand”直接在窗口中央打开固定 Leader Topic 浮窗，并注入本次需求讨论的提示词，让 Leader Agent 开始和人澄清目标及项目归属。入口携带当前 Project 筛选上下文，不创建空白 Demand；后续 Demand 写入遵守既有确认策略。

入口只负责打开/聚焦 Leader Topic，不代替 Board 的全局浏览入口。Leader Topic 恢复状态未知时，入口仍保留并打开恢复提示；不能因启动握手或读取快照失败清空全局 Board。浮动入口的视觉和位置约束见 surface-density SSOT 的同名小节。

点击 Leader 头像后必须在同一个入口内呈现可见的 Leader Topic 工作面：头像打开的是已经准备好的固定 Topic 浮窗，浮窗必须有可见的 Workbench、Tab/Region 和可输入的 Composer；若 Topic 准备仍在进行，先显示全幅恢复/加载表面，准备完成后自动切换到内容，不能留下空白浮层或只更新隐藏状态。准备失败时保留浮窗并在其中显示服务窗式失败说明与重试动作。

点击 Leader 头像后必须在同一个入口内呈现可见的 Leader Topic 工作面：头像打开的是已经准备好的固定 Topic 浮窗，浮窗必须有可见的 Workbench、Tab/Region 和可输入的 Composer；若 Topic 准备仍在进行，先显示全幅恢复/加载表面，准备完成后自动切换到内容，不能留下空白浮层或只更新隐藏状态。准备失败时保留浮窗并在其中显示服务窗式失败说明与重试动作。

### Leader Topic 入口的浮动与收纳

“收起”表示把 Leader Topic 入口**收纳到底部的三项工作面切换器旁边**，不表示彻底移除入口。入口只有两种持久位置：`floating`（浮动在当前工作面边缘）或 `compact`（与底部 Agents / Session / Board 组件同组）；两种位置都能打开/聚焦同一个 Leader Topic，并保留未读/需要用户处理的提示。用户可通过入口操作菜单在两种位置间切换。MVP 不提供让入口真正不可达的“彻底隐藏”。

紧凑入口与三个工作面按钮保持独立的助手图标、分隔和命中区，不能让两个动作合并。浮动／紧凑形态的切换只放在底部入口位置，不再在浮窗右上角放三个点或远端菜单。底部入口在浮动形态时显示“收起到下方”的图标动作；切到紧凑形态后恢复为打开 PMO Teams 的头像按钮。浮动入口支持直接拖动，拖动锚点与收纳位置必须持久化。重启后先恢复入口位置和形态，再尝试恢复固定 Topic 的 Session。

入口是全局 Chrome，不依赖当前是否正在浏览 Board；切换到 Workbench、Settings 或窄窗口后仍保留一个可见且可键盘聚焦的停靠入口。浮动入口被遮挡、拖动越界或窗口尺寸变化时自动夹回可用区域；停靠入口空间不足时保留图标和提示，不把 Board 挤出视口。通知栏、Agents roster 和入口不得各自复制一份未读计数，统一消费同一份注意力投影。

浮动位置必须有一个看得见的紧凑助手按钮作为唯一打开入口：它固定在当前窗口工作面边缘，带有注意力提示，普通点击必须打开或聚焦同一个可交互的 `launcher:leader` 浮窗；浮窗不能只更新状态而继续隐藏，也不能被入口拖动层拦截。只有超过拖动阈值的 pointer 手势才取消这次点击。它不能因为 Session 分屏、切换到 Settings 或当前没有活动 Tab 而消失。用户收起后，入口移动到底部三项切换器旁；不能只留下不可发现的顶栏动作。按钮必须支持拖动改变悬浮位置，并在窗口尺寸变化时夹回可用区域。

### Leader Topic 入口头像

Leader Topic 入口必须使用 AgentMux 项目现有的绿色 low-poly 龙头像作为身份图标，不再使用另一套独立生成的角色头像。浮动态入口采用显眼的圆角矩形徽章承载龙头像，点击命中区包含整个徽章；收纳到下方切换器时沿用同一头像，只缩小徽章，不改变身份。头像只表达“这是 AgentMux 的 Leader Topic”，运行、未读和需要处理等状态继续由独立角标表达。

浮动入口的头像与展开面板是一个连续控件：三个点操作按钮必须紧贴头像并与其共用一块面板边界，不能漂在远处让人猜测含义。点击头像打开面板，再次点击同一头像收起面板；打开状态下头像仍是可操作的收起开关。面板打开和收起不得创建第二个 Topic、Session 或入口状态。

不再显示三个点操作按钮。头像徽章不使用绿色描边，改用半透明毛玻璃面和轻阴影表达层级；绿色只保留在龙头像和注意力状态上。浮动态点击必须沿用同一份 open/close 状态，不能因为 pointer capture 或隐藏面板层把点击吞掉；拖动超过阈值才取消点击。compact 入口打开面板时，必须以底部入口为锚点，把面板夹在靠近底边的可用区域内，不复用随机的历史 `position`。浮窗打开时底部入口仍可见，并用明确的收起图标表达“收纳回底部”。

默认 Session 使用的宿主能力必须是通用的 CUI/JSON 协议：读取全局 Project 目录和 Board、搜索任务、创建/更新任务、绑定目标 Project、关联 Attempt/Session、读取事件增量。Provider 只提供 Agent 对话与生命周期，不把 Board 命令塞进某个 Provider 配置；协议失败属于流程状态，必须在入口或对话中说明并保留已有任务。

`agentmux` CLI 必须能让 Agent 查到当前所有已注册项目，以及各项目中的其他活跃 Agent；返回稳定 Project/Workspace/Session ID、路径、Provider/Executor 和真实状态。未打开 Tab 的活跃 Agent 仍可发现，未知或查询失败不能伪装成空列表。

### Leader Topic 与任务写入确认

项目调度 Agent 适合作为一个固定的 Leader Topic，而不是一段无法定位的临时对话。该 Topic 持续承载全局项目目录、Board 需求、路由分析、用户确认和结果回执；它仍然是普通 Topic/Session，遵守 Topic 的文件系统真相和重启恢复约束，但使用产品固定的 `launcher:leader` 身份，不进入用户 Scratch Topic 的选择投影，也不随着用户当前 Scratch Topic 改变。

Task 写入策略必须是用户可配置的开关，默认值为“按风险确认”。明确且低风险的单项目请求可以直接创建，并在对话和 Board 中产生可追踪的 Task receipt；涉及跨项目路由、目标不明确、不可逆或高影响动作时，先展示来源与依据、候选 Project、风险和待确认项，不能静默写入。用户也可以切换为“全部确认”或“默认直接创建”，设置的改变必须持久化并在入口可见。

每次用户确认、修改目标 Project、接受/拒绝风险判断或撤销 Task，都要作为该默认 Topic 的结构化决策记录进入全局知识库。记录至少包含原始请求、候选与最终 Project、风险判断、用户选择、Task/operationId、时间和来源 Session；不能把完整聊天转储冒充可检索知识。默认 Topic 可以根据这些记录学习风险与路由建议，但学习只改变建议和默认排序，不能绕过用户当前设置、确认闸门或既有事实；当证据不足时仍显示“无法确定”，让用户决定。

该知识库的读取、写入、检索和增量订阅必须通过通用版本化 CUI/JSON 能力暴露给调度 Agent；Provider 不拥有知识库语义，也不能通过 Provider 配置暗中改变 Board 的写入规则。

### Demand 文件事实与独立包

Demand 是与 Project、Session 平级的长期产品事实，不属于 Core 的 Agent Runtime，也不属于 Desktop Store 的临时 UI 状态。Demand 管理能力放在一个与 `packages/core` 平行的独立包中，包同时提供宿主无关的 TypeScript API 与 CLI；它以文件系统作为唯一持久化事实，负责 Demand 的创建、读取、状态流转、关联 Project / Session / Attempt、索引和原子写入。

Leader Topic 默认通过该包的 CLI/API 访问 Demand。Leader Topic 可以分析、建议和提交 Demand，但不能在 Topic 目录或 Renderer 中另存一套任务记录；Board 读取同一份文件事实并投影状态。Core 继续只拥有 Provider、Session、Run、PTY 和 ordered bytes 的生命周期事实，Demand 包不得启动或管理 Agent 进程。

Demand 包的文件格式、锁、原子替换、损坏恢复和 CLI 输出协议必须独立可测试，未来其他 Client 也能在不依赖 Electron、React 或 AgentMux Desktop 的情况下使用。Demand 与 Session 的关联保存稳定 ID 和可验证引用；不存在的 Session 只能显示为历史关联或 unknown，不能伪造成当前运行状态。

### Demand 的完整业务闭环

Demand 不能只是一张标题卡。完整闭环至少包括四条可从 UI 和 CUI 重放的流程：

1. **提出需求**：用户点击 `New Demand`，中央打开 Leader Topic 浮窗并注入来源、当前 Project 筛选和“先澄清再写入”的提示；Leader Agent 通过对话补齐标题、描述、优先级、目标 Project、风险和下一步，用户确认后才创建 Demand。
2. **分配执行上下文**：用户或 Leader Agent 从可见 Project/活跃 Agent 摘要中选择目标 Project，并把零个、一个或多个已有 Session 关联到 Demand；Project 归属和 Session 关联是两个独立动作，不能用当前选中 Session 猜测。
3. **管理与推进**：Board 详情可以编辑标题、描述、优先级、状态、Project、Executor 和 Session 关联，能查看 Activity/Decision receipt；删除 Demand 是显式、可确认、可审计的动作，删除不能删掉 Session 或 Project。
4. **恢复与审计**：重启或 CLI 跨进程读取后，Demand、描述、Project、状态、Session IDs 和 receipt 仍一致；文件/Runtime 查询失败时保留已读内容并显示服务窗，不把 Demand 变成空卡。

Demand 卡片的执行摘要必须能读出实际工作拓扑：关联 Agent 的 Topic/Branch 上下文、所有打开的 Tab、每个 Tab 的分栏/Region，以及每个分栏当前运行的 Agent。不能只显示“n 个 Session”后要求用户再去猜 Session 在哪个工作面；没有 Tab、分栏或 Agent 时明确显示缺失事实。该拓扑摘要由统一的可复用组件提供，Demand、Agents、Session 和详情面板只传入投影数据，不各自重建一套卡片结构。

UI 和 CUI 必须共享同一组语义动作：`demand.list/show/create/update/delete/link-project/unlink-project/link-session/unlink-session/decision-log/activity`。UI 不得拥有 CUI 没有的第二套写入逻辑；CUI 也不能绕过 UI 使用的确认、稳定 ID、权限和 receipt 约束。

### 全局 Board 的成熟产品界面

全局 Board 是长期工作的产品界面，不是介绍概念的落地页。首屏不放营销式大标题、说明性 hero 或为了展示原型而存在的页面分组；用户进入后直接看到任务工作面、筛选和当前选择。任务总览、Task Inspector 和 Default Session 是同一工作流中的状态，不在页面底部另造一组“01/02/03”导航。

顶部只保留全局范围、搜索/筛选、Board 操作和默认 Session 入口。按钮优先使用紧凑的图标按钮、文字图标组合和分段控件；只有创建、确认、进入项目等明确动作使用文字按钮。任何分组都必须回答一个稳定的问题（任务状态、当前选择、执行来源或下一步），不能用装饰性卡片、彩色边框或标题制造层级。

Board 的第一视觉层是任务卡和任务状态，第二层是 Project、优先级、下一步和执行事实。卡片使用中性 Surface、细分隔线和单一选中信号；颜色只表示状态或 Project 身份，不作为大面积渐变、发光边框或装饰性线框。Default Session 以可收纳的工作面/浮窗出现，Task Inspector 以 Board 内的右侧面板出现；二者不占用独立的演示页。

选中 Task、展开详情或查看 Session Region 都不能改变当前页面路由；Board 保持可见，右侧 drawer 只更新当前 Task 的投影。Session Region 必须复用当前 Agent 会话的既有承载方式和生命周期事实，不能把一个 Session 拆成新的页面、第二个终端或第二个 Agent surface。详情里的 Region 只做同一 Session 的观察投影，需要输入、编辑或调整终端尺寸时，用户显式进入原工作面并交还唯一控制权。

这里的“右侧 drawer”在产品实现上是 Board 同屏的右半边 Task 工作区，不是覆盖在 Board 上方的弹层。Task 工作区占用稳定的右侧面，中心区域直接承载多个 Session Region 和对应 terminal；左侧仍保留任务列和当前筛选。关闭 Task 工作区只恢复 Board 宽度，不改变页面路由或创建新页面。

默认 Session 的浮动入口打开的是默认 Topic 的原生 Tab/Region 工作面，不打开一套独立的聊天产品。Topic 的 tab、region、Agent 身份、输出面和 composer 沿用 AgentMux 现有工作台；Task 草案、确认策略和知识库回执只作为工作面中的轻量状态行或原生消息出现。用户需要输入时直接使用同一个 Session 的 composer，不能再叠加一层自定义对话 header、消息卡和人工确认流程。

每个 Topic 都支持一份可编辑的 Wiki 注入，注入属于 Topic 的知识边界，不属于 Provider、Executor 或某个临时 Session。Topic 打开时，Core/Client 按稳定版本加载该 Wiki 注入并向 Agent 明示来源和版本；编辑、启用、停用和恢复都写入 Topic 的持久状态，重启后仍然可见。注入内容和工作区文件、Agent 对话、全局决策知识库分开显示，不能把一段聊天默认为 Wiki。

默认 Topic 自带一份默认注入，至少说明：如何使用 AgentMux 的 Project、Workspace、Branch/Topic、Session、Task、Attempt 和 ctxmux 能力；如何依据项目目录、Topic 关联和历史决策判断需求应落在哪个 Project；何时把相近需求合并到已有 Task，何时拆成独立 Task；哪些信息不足时必须先追问用户；哪些写入操作需要遵守当前确认策略。默认注入是可查看、可编辑、可恢复的 Wiki 初始内容，不是不可见的系统提示。

Topic 注入的优先级必须可解释：平台安全与运行时事实高于 Topic Wiki，用户当前指令高于默认建议，权威 Project/Task 状态高于历史推断。Wiki 可以提供规则和例子，不能伪造 Session、Run、Project 或 Task 事实；当注入和权威状态冲突时，Agent 必须说明冲突并追问或降级为待确认，而不是默默覆盖事实。

### 全局 Board 的三栏任务闭环

全局 Board 是一个完整的任务界面，不是 Agents 面板的放大版。中间是按少量稳定 Task 状态组织的任务卡，右侧是当前任务的固定详情面板；左侧“来源与依据”不是默认常驻栏，只在选中任务确实有来源、路由依据、外部引用、待确认项或用户主动打开时按需出现。人工批注仅在用户主动添加时进入该范围。点击任务卡只更新右侧详情，不离开 Board 总览；右侧至少能在同一任务上下文中切换详情、文件、变更、Activity 和 Agent 对话。

任务卡优先表达任务结果和归属：稳定 Task ID、标题、目标 Project、状态、优先级/标签、更新时间和进度可快速扫描；多个 Attempt、Agent Session、Agent 活动和关联 Task 聚合在卡片或详情内，不把 Session 复制成多条主卡。复杂的 running、needs-user、blocked、停止原因等执行语义属于 Attempt/Session 事实，在卡片内以来源明确的次级信息表达。

看板顶部提供全局筛选和搜索，至少能按 Project、Task 状态、优先级、标签、Agent/Session 和归档状态切片；当前筛选可复制或由 CLI 重现。看板负责计划、分拣和预览，工作台负责完整编辑与执行；只读或预览能力的边界必须在入口附近说明，不能让用户误以为看板中的文本编辑已经写入项目。

默认 Session 创建或更新任务后，任务卡和右侧详情必须能即时显示分析依据、目标 Project、创建的 Task 以及关联 Attempt/Session。来源与依据抽屉中的原始需求、路由理由、引用对象和待确认项都锚定任务；完整评论和 Agent Activity 留在右侧，不能让需求分析漂移成无法定位的全局聊天。

编排调度 Agent 与执行任务的 Agent 使用不同的展开语义。编排 Agent 是全局入口，保持浮窗对话；它创建或更新任务后只在对话中给出可点击的 Task receipt，不把整段编排对话塞进任务详情。任务有正在执行的 Agent 时，点击任务默认在右侧打开任务执行面板，展示 Attempt、Agent Activity、最近对话和下一步动作，同时保留 Board 上下文。只有用户明确选择“进入工作台／打开 Agent 所在项目”时，才跳转到对应 Project、Workspace、Branch/Topic 和 Session；查看执行进度不能隐式改变当前工作面。

任务执行面板在没有可达 Workspace、Session 恢复未知或目标存在歧义时仍保留任务事实和失败步骤，并提供显式恢复/定位动作；不能因为跳转流程失败而清空详情或删除任务。

### Task 详情中的 Session Region 投影

Task 关联一个或多个具体 Agent Session 时，选中 Task 在右侧打开同一批 Session 的 Region 投影。一个 Session 使用一个 Region；多个 Session 使用现有的分屏/网格 arrangement 原语自动排布，用户可以在详情面板内切换已支持的排列方式。这个 arrangement 是 Task 详情的临时投影，不修改任何 Project 的持久 Tab/Region 布局，也不创建新的 Agent Session。

每个投影 Region 都显示稳定的 Project、Workspace、Branch/Topic 和 Session 身份，并提供明确的“进入项目/打开工作台”动作。该动作按精确 Session 与 Project 上下文聚焦或打开原有工作面；不能根据当前焦点、最近顺序或终端标题猜目标。返回 Board 时保留原 Task 选中状态和详情位置。

投影 Region 复用既有 Session/Terminal/Agent surface 和 ctxmux Run 的观察事实。渲染投影可以建立额外的 attachment lease，但底层 Run、PTY、ordered bytes、Replay、Gap 和输入/生命周期 owner 只有一份；不能为详情面板启动第二个进程、复制一份终端缓冲或让 Renderer 自己重建 ctxmux 事实。

Task 详情中的 Session 默认是观察投影：可以查看实时输出、Activity、状态和可归属的控制动作；PTY 输入、编辑器写入和终端尺寸控制仍由原工作台拥有。若未来允许在投影中接管交互，必须显式转移唯一交互 owner，并在原工作台留下清晰的控制权变化；多个 Region 不能同时争夺同一个 Run 的输入或尺寸。

### Board 交接缺口的闭合

- Task 中的观察 Region 必须同时禁止 PTY 输入、Agent composer 发送、生命周期修改和主动尺寸控制；只禁止 resize 不构成观察模式。进入项目仍定位原 Session。
- Topic Wiki 的启用状态、内容版本和更新时间必须可见且可持久恢复；禁用不注入，恢复默认不重建 Topic 或 Session。Wiki 注入明示来源和版本，并服从用户当前指令与 Runtime 权威事实。
- Board 暂时缺少 Session 快照时仍保留选择和关联身份，区分“尚未恢复”和“从未关联”；不能在加载阶段清除用户工作面。
- 本轮交付包含真实安装包、安装重启和恢复验证。未通过对照的 Runtime 升级不能捆绑进入正常产品安装。

### 启动配置错误与诊断

- 用户确认本次直接修复已安装配置，适配当前合同；不为已退役字段新增兼容层。修复前保留原始备份，有效颜色保留，已不支持的文字角标不臆造为新图标。
- Executor 主标签使用用户可读名称，复制序号不承担产品语义。内部 ID 是 Session 的稳定引用；不能只改配置键而让已有 Session 失去执行器绑定。
- 启动失败须留下本地持久诊断，不能只弹对话框或写终端 stderr。记录失败阶段、错误类型与调用栈、启动 attempt/PID、包身份和配置路径；不记录配置正文、环境变量或 Prompt。日志有体积上限，写入失败不盖住原始失败。
- 启动错误提示提供诊断文件位置。安装后的验证不能仅凭进程短暂出现就宣称正常启动，必须确认真实配置下窗口加载完成且进程仍存活。

### Agents、Session 与 Board 的全局入口

- 当前产品明确区分三种全局工作面：**Agents** 展示 Agent/Executor 的聚合与状态，**Session** 展示具体会话与它们的上下文，**Board** 展示 Demand 计划与执行关联。Demand 卡不能因为带有 Session 就改名成 Agent，Session 也不能作为 Board 的隐含主实体。
- 三种工作面使用同一组全局切换入口，切换只改变中心工作面的投影，不改变当前 Project、Workspace 或 Session 的持久身份。主切换的位置归《左下角导航、Space 与 Goals》；右上角不再放一套平级导航。 这条约束同样覆盖 Session 的单 Tab Group 标签栏与多 Tab Group 分屏顶栏，两者都不得再渲染主视图切换。
- Board 选中 Demand 后可以在右侧展开关联 Session Region；这只是 Demand 的执行投影。Agents 与 Session 选中对象的详情沿用同一右侧工作区语义，不能通过“把右面板搬到左面板”来表达未分屏状态。
- 没有分屏时，左右栏只表达真实存在的内容：没有右侧详情就保持主工作面全宽，不能把右侧内容视觉上推到左侧或反向滑入，造成方向与焦点错觉。分屏布局只在存在两个可见 Region 时启用对应的 arrangement。
- 切换入口必须可键盘操作、保留当前选中项和可恢复焦点；重启恢复后先恢复三种工作面的选择，再尝试恢复其中引用的 Session/Demand 投影。

### Board Demand 与 Session 关联边界

- Board 的主实体是 Demand。Demand 可以在没有任何 Session 时创建和持久存在，也可以关联多个 Session；Session 只是 Demand 的执行上下文，不是 Demand 卡片的身份。
- 没有显式关联的 Session 不得自动生成 `session:*` Board 卡片。Agents 和 Session 工作面负责展示这些 Session；Board 只展示持久化 Demand。
- Demand 详情显示零个、一个或多个关联 Session。Session 暂时不可见时保留 Demand 和关联 ID，区分“尚未恢复”和“从未关联”，不能把 Demand 降级成 Session 卡片。

### 对话消息、终端缺口与缩放重绘

- Codex 对话模式按 Session timeline 的每一条 `user_message` 渲染用户消息。首条消息不能成为唯一的用户气泡；后续发送、恢复和重连后的消息都必须单独可见，并保留它们原本的顺序与正文。时间轴同步遇到缺口时先重取权威快照，不能静默只留下第一条。
- 终端的有序字节缺口不能写成终端内容。保留历史不足时，在终端外显示可收起的服务窗，说明缺失范围和恢复动作；当前 Run 健康时继续显示最新字节，并请求一次当前屏幕重绘。缺口提示与当前画面正确性是两件事，成功重绘后提示收敛，但历史缺口事实仍可查。
- Region 缩放、分屏或字体变化后，顶部的 Redraw 提示只在当前可见网格尚未确认时出现；重绘已成功或尺寸已重新确认后自动消失。提示不能覆盖正确的缩放内容，也不能因为旧的历史缺口永久复活。
- Restoring 舞台与 Agent 启动舞台共享同一套全幅布局质量、身份锚点、状态语义和可读性。Restoring 明确表达“重放保留输出/接回当前画面”，通过 `FullPageLoadingSurface` 的 recovering 语义呈现；Agent 启动表达“等待进程首段输出”，仍可保留自己的局部启动提示，但不得再为 Restoring 另造一套终端专用全屏动画。
- Agent 的 Skill 必须能指导它为自己设置用户可读的显示名，并为当前工作区设置用户可读的名称。显示名是可持久化的展示事实，Session、Workspace、路径和其他内部 ID 保持稳定；设置失败要留在当前工作面说明，不得清空工作区。

### 插件扩展边界

- Provider、Skill 和命令通过 `packages/core` 暴露的类型化插件合同发现和注册。宿主先读取清单，再按用户选择激活；编辑器只消费统一目录和能力，不为某个厂商写分支。
- 插件拥有自己的声明和生命周期投影，但 Run、PTY、ordered bytes、Replay、Gap 与 Session 权威事实仍归 Core/ctxmux；插件不能复制一套进程或终端状态。流程探测失败作为服务窗提示，不阻断健康 Agent。

### Agents 看板与 Board 需求流转

- 用户确认「把 board 的设计照搬替换掉 Agents，同时 board 先照抄 multica 的业务逻辑」。Agents 使用原 Board 的紧凑工具栏、卡片、状态列和同屏右侧会话工作区，替换简单列表；主实体是 Agent Session，按 Needs you、Working、Results、Error 展示，普通终端归 Session。
- Agents 卡片换成 Board 语言后，注意力动作仍然必须在同一张卡片的工作区内可达：选中 Needs you 的 Agent 后，固定详情区提供“在这里查看请求”；typed request 由同一个 Session 身份交给既有交互卡和 Core respond API。没有 typed request 时只能提供“打开 Session”定位动作，不能伪造回答控件。卡片、详情和请求面板都不得复制 Session、Run 或 pending request 真相。
- Board 是与 Project、Session 平级的最高级全局工作面；进入 Board 时 Project Rail 被工作面覆盖，不显示左侧 Project 导航。Board 内主实体不是泛意义的 task，而是 Demand（需求），按 Backlog、Todo、In progress、In review、Blocked、Done、Cancelled 流转。状态由显式操作维护，不从 Session 是否需要我、退出或报错推断完成。负责人、Project、优先级、描述与活动记录属于 Demand；负责人可以未分配，分配 Executor 与关联 Session 是不同操作。
- Backlog 可以先指定负责人而不启动；用户明确执行需求时通过既有 Core 启动路径创建并关联 Session，每次执行保留关联，失败保留需求与说明。需求可编辑、跨列流转、评论、关联或解除关联已有 Session，重启后仍成立。
- Demand 可以在没有 Session 时创建和持久存在，也可以关联多个 Session。没有显式关联的 Session 不自动生成 Board 卡片。快照缺失保留 Demand、关联 ID 与当前选择，并区分尚未恢复和从未关联。

### Demand 命名合同

- Board 领域的代码名称统一使用 `Demand`：持久化字段、类型、选择器、组件、文件名和控制协议都以 `demand` 表达。Board 的 `Task` 只保留在泛义任务或其他独立领域的上下文中。
- Demand 的控制操作使用 `demand.*`，请求与回执使用 `demandId`、`demands` 和 `demand`；CLI 入口使用 `agentmux demand`。不保留同一语义的 `task.*` 别名或兼容层，避免代码和用户模型继续把需求误读成 Session 任务。

- **Terminal 中的系统文件路径必须保持系统文件语义。** 终端输出的工作区内 `.app`、`.dmg`、`.pkg`、`.exe`、`.msi`、`.deb`、`.rpm`、`.AppImage` 与常见压缩包等可由系统处理的文件，点击后交给当前操作系统打开，不得误送进编辑器或 Browser Tab。路径仍必须先经过既有 Workspace 根约束；远端 Workspace 没有本机系统打开出口，因此只提供可用的文件管理器揭示能力，不能画一个点击后必然失败的假按钮。
- **终端路径的右键菜单要回答“去哪里找它”。** 指针停在已识别的文件路径上时，右键菜单提供平台对应的 `Reveal in Finder`、`Reveal in File Explorer` 或 `Reveal in File Manager`；系统可处理的文件额外提供打开动作。右键普通输出、拖选文本或无法归一化的路径不显示这些动作。揭示和打开都复用 Main 的 Workspace 文件安全边界，不能把绝对路径直接从 Renderer 交给系统。
- **文件路径和 HTTP 链接是两条不同的出口。** HTTP(S) 仍进入 Browser 的目的地选择；只有归一化成功的本地 Workspace 文件路径才进入系统文件动作。系统动作失败必须以可读错误浮现，不能静默退回编辑器 Tab。

### 状态投影、Browser 页面与 Scratch Topic 工作面

- Agent 的进程已经停止、正常退出或退出原因未知时，不能因为流程告警或投递检查失败而显示成红色错误。只有 Core 给出真实崩溃、非零退出或明确故障事实时才进入 error；连接丢失单独显示为 disconnected。左侧 Project 树继续显示 idle Session 数量，头像和 Executor 角标不因此常驻亮起。
- Browser 的控制权提示只是页面旁边的辅助信息。`Browser ready`、`You have control` 之类的提示不能替代、覆盖或把真实页面变成空白控制面；没有进行中的操作或控制权交接时不显示占位提示，页面仍由 Main-owned Browser surface 承载。
- Scratch / Topic 列表是工作区导航的一等内容：Scratch 是父级工作面，Topic 是可辨识的子项。Topic 行采用更紧凑但完整的标题、更新时间/打开状态和可见操作区；选中、hover、空列表、新建和恢复状态都要有一致的反馈，不能依赖一张已经失效的装饰卡片。Topic 与对应工作区的关系在树中可追踪，重启后仍保持。

### Executor 身份组件与信息面板

- 所有显示 Executor/Provider 身份的地方，包括顶部 Tab、Project/Topic 列表、Session、Board 和 Browser 操作条，都必须使用同一个可复用 Executor identity 组件。Provider 图标、较小的 Executor 自定义图标、珐琅式外轮廓和状态标记只能由这一组件组合，不能在调用方各自画点、描边或叠加。
- Executor 面板在 hover 或键盘 focus 时以统一的 tooltip 信息面板出现，展示可读名称、Provider、当前状态和可用的上下文；不要求先点击才能看见。面板的字号、内边距、颜色和动作区与其他信息面板一致，不能因为来源不同出现另一套密度。
- 自定义头像属于 Executor 配置，不属于 Appearance。面板只提供一个小型设置入口；点击后进入该 Executor 对应的模板设置，不能跳到 Appearance，也不能在信息面板内复制一套配置表单。身份 ID、Session 绑定和工作区事实保持稳定。
- 头像编辑归属 Executor 模板；移动设置入口不能改变已有身份外观、丢弃已存头像，或因头像问题阻断应用启动。仍存在的 Appearance 头像按原 Executor ID 继续显示，新的 Executor 编辑写入其稳定配置；未匹配的旧记录保留原样，不猜测新身份。

### 工作状态与 Executor 叠加标记

- `working` 必须有一个明确的活动字形，表达 Agent 正在产出；普通 `running`／idle 只表示进程仍可用，不在头像右上角放常驻标记。
- 等待用户、阻塞、断联和真实错误属于需要用户知道的特殊事实，保留各自的提醒形状；错误行优先显示 Runtime 提供的具体原因，无法取得详情时才使用短的事实说明。
- Executor 自定义图标与 Provider 图标先合成一个身份图，再应用共享的珐琅外轮廓。Executor 图标应小而紧，叠在 Provider 图标内部，不得成为围在外面的第二圈。
- 状态语义只通过右上角的小型标记或活动字形表达；普通身份不使用外描边制造状态。
- 活动菜单必须保留可读的原因、项目和 Provider 信息；长内容在有界菜单内换行或滚动，不能被固定宽度裁成看不懂的尾巴。

### 默认 Session 的浮动工作面

Default Session 的打开动作呈现为当前工作面上的浮窗，交互沿用成熟桌面产品的 floating workspace 形态：有独立标题栏、拖动定位、最小化/关闭和明确焦点环。浮窗打开时保留用户正在看的 Agents、Session 或 Board 工作面，关闭后焦点回到打开前的控件；不能通过切换到 Scratch 主路由来冒充浮窗。

浮窗内容就是唯一 `launcher:leader` Topic 的原生 Tab、Region、Agent 身份、输出和 composer。它不创建第二个 Session、PTY 或聊天产品；浮窗只是同一 Topic 工作面的附着投影。Board、Agents 和 Session 中的入口都打开/聚焦同一个浮窗，不能各自维护一份 Leader Topic。

浮窗的打开状态、位置和引用的 Topic 工作面属于持久 UI 状态。重启后先恢复浮窗和原有 Tab/Region，再尝试 reattach/resume；恢复握手、探测或浮窗渲染失败时保留入口和持久工作面，在服务窗说明失败步骤，不清空布局。

浮窗与主工作面分别拥有自己的导航焦点；浮窗内新建、关闭、文件与快捷键必须按该 Topic 的明确身份执行。默认 Topic 的可见性也必须进入现有终端泊车、内存预算与通知判定，不能一边显示一边回收。窗口支持缩放与最大化/还原；标题栏按钮不触发拖动，关闭只收起。旧的“跳到 Scratch 主路由”实现不能作为此行为的替代。

### 真实进程重启的恢复边界

重启验收必须启动隔离的真实 Electron 主进程和 Renderer，记录应用进程身份、持久化布局身份、焦点、草稿以及 Session/Run/Provider-native handle；至少发生一次真实退出，再由不同进程从同一 userData 根目录恢复。组件 remount、Store 序列化或只比较启动文件不能替代这条证据。恢复先重建 Tab/Region/focus，再尝试 reattach/resume 原 Session；Run 可以依法换代，但 Session、工作面和草稿不能被伪造成新对象。

Runtime snapshot 为空、恢复握手超时、Provider 探测失败或布局暂时不可读时，原工作面继续可见并显示服务窗，记录失败步骤与下一步；只有 Core 明确给出 retired/unknown 等终局事实时才移除投影。探针只能操作自己创建的隔离资源，必须记录不同 PID 和前后身份匹配，并在结束时清理临时目录，不得停止用户已有 Run。

### Leader 对话浮窗的清晰度

Leader 浮窗默认以已有 Agent 对话模式打开，用户仍可切换终端。外缘在复杂工作面上必须清晰可辨；标题与内容是一体的紧凑表面，不能用高大的 Leader Topic 标题行重复占位。固定 Topic、原 Session、拖动、收纳和重启恢复保持同一事实。

### PMO Teams 入口位置与展开动效

PMO Teams 不再提供独立的浮动头像形态；产品入口的位置见《左下角导航、Space 与 Goals》。打开后龙头像仍作为同一入口的身份锚点，不被移到随机屏幕位置。PMO 面板的上一次位置和尺寸属于持久 UI 状态；再次打开沿用该位置，若窗口边界改变只做最小夹紧，不重置到随机位置。

面板展开采用原位出现：不做整块缩放，不从远处飞入。允许一段很短的透明度、边界亮度和细微扫描线/信号校准动画，让用户看出面板已从 PMO 入口接通；动画结束后保持静止，`prefers-reduced-motion` 下只保留即时出现。头像眼睛的粒子反馈只在打开时短促出现，随后静止；展开状态由按钮轮廓与可访问状态共同表达，不能依赖颜色作为唯一状态。

龙头像打开态的在线反馈使用左右两束对称的短烟火：每束从一只眼睛附近向外发散数枚小粒子，带有不同角度、距离和透明度，在短周期内完成后低频重播。粒子只覆盖眼睛周围的透明区域，不遮住龙脸和底部入口文字；它是装饰性状态提示，不能替代 `aria-expanded` 或可读状态。

### Leader Topic 的身份与职责

- `launcher:leader` 是 AgentMux 的协调者 Topic，不是普通 Project Agent 的替身。它的默认职责是理解需求、澄清缺口、提出 Project/Topic/Session 分配方案、记录 Demand 决策并跟踪进展。
- Leader 默认先对话后执行：没有用户明确确认和目标 Agent 分配时，不自行修改业务文件、不替用户完成编码任务、不把“帮我推进”默认为“自己直接实现”。它可以读取全局 Project、Tab、Region、Session 和 Agent 摘要，用于做出可检查的分配建议。
- Leader 的身份必须同时写入固定 Topic 的默认 Wiki 和启动时的 AgentMux context；用户消息、Runtime/权限/Session/Project 事实优先于 Wiki。普通 Topic 继续使用通用 Topic Wiki，不得误把 Leader 角色传播给其他 Topic。
- Leader 需要实际执行工作时，先把目标、承担者、Project、Session、风险和验收写成待确认方案；用户确认后再通过公开 Demand/CUI 能力分配或触发工作。确认前的工具调用只能用于观察、澄清和准备，不得产生不可逆业务写入。

### 全局加载过程的统一入口盘点

所有会让用户暂时失去主内容的过程都必须使用同一个可复用的加载/恢复表面：应用启动、工作面恢复、固定 Topic 准备、Session 连接、Terminal replay/hydration、Browser/文件/差异内容首次装载。局部刷新（例如列表重新取数）可以保留上一份事实并使用行内忙碌标记，但不能把整页替换成另一套 spinner。加载、恢复、失败和重试的语义由共享组件统一表达，并遵守减少动态效果设置。

### 设置页的信息架构

设置页要像一个现代工作台：侧栏只负责快速定位，主区首屏明确当前设置对象、当前状态和唯一主操作；可编辑内容与只读说明分层，重复说明收起到次级层。搜索、键盘导航、窄窗口和保存反馈必须保持可见且可恢复，切换分区不能丢弃未保存草稿。

- 用户要求「继续，直到设置界面质量彻底满意」。设置作为辅助界面，第一眼必须是当前对象和动作；Workspace 与 Executor 可按名字、路径或身份检索，大量资源不靠逐条扫读。Executor 常用身份与外观优先，高级启动配置按需进入；已有 Provider 与 Executor ID 保持不可修改，新 Executor 创建后直接进入编辑。改变分组或检查结果不能丢失展开、输入或焦点。
- 设置保存仍经既有公开 API，启动配置的说明应明确针对后续启动，不能冒充已改变健康 Run。高级权限动作保持显式选择，不自动批准；所有分区保留原功能、草稿、错误反馈和 status bar。
- 启动参数的可编辑表示必须与实际 argv 可逆；追加或修改一个参数不能拆开其他参数中的空格、引号、反斜杠或空值。
- 字体字号等数字设置必须允许清空、选中替换与逐位输入完整值；输入中的未完成值不能被立即钳位或舍入打断。明确保存时才验证有限整数和实际允许范围，非法输入保留草稿并说明原因，不改变已提交值；滑块选择保持合法，外部 CLI 提交、冲突与保存失败仍遵守同一草稿保留规则。
- 外观与终端主题的单选组遵守完整键盘行为：Tab 进入当前选择并能离组，方向键移动并选择相邻项、两端可回绕，Space 可选择焦点项；当前选择与键盘焦点都清楚可见。只给按钮标注 radio 角色而没有相应行为，不算键盘可达。
- Executor 与 Prompt 的 CLI 按稳定 ID 明确 list/get/add/update/remove，与界面共用原始编辑基线和配置事实。add 不覆盖已有对象，update 不默默创建；启动参数与环境整项替换并允许明确清空，正文逐字保留，支持的数据 key 不可在成功后静默丢失。外部提交仅刷新 clean 内容，保留 dirty 与保存期间后续编辑。Prompt 的 Provider 过滤可以更换或解除，删空 Prompt 库重启后仍为空；头像 Reset 不能复活旧装饰。
- Executor 是启动模板，Session/Run 是独立对象。仍被 retained Session 或已准入启动引用的模板不能删除，界面与 CLI 都具名说明引用，配置不变且不停止、暂停或重建 Agent；引用范围不能只数可见格子或 connected 会话。引用事实读失败，只拒绝这一次危险删除或重绑并说明未知，普通设置和健康输入继续。已缺模板的同 ID 显式重建必须与现 Session 的 Provider 事实一致，只修改配置而不自动执行；冲突事实不能猜一个。已准入启动在完成前同样受引用完整性保护，不因尚未出现 Session 就被删掉依赖；不保存第二份模板或永久删除身份表来掩盖原 context 缺失。
- Hosts 编辑同样保留原始字段基线与保存期间后续输入；无关 Host/字段提交只刷新 clean 内容，同字段冲突、准备失败与外部删除保留草稿，不用保存时的新快照消除冲突或静默重建。当前远端准备能力尚不可用时如实说明，不把受控准备条件下的保存成功冒充远端 Runtime 能力，也不打断无关本地健康 Run/Input。说明文字和 Test 反馈须与当前实际能力一致，不先承诺保存或测试可用、再在动作后否认；失败原因完整可读，草稿与健康输入保持。

- Hosts 的连接编辑区必须允许正常逐位输入 Hostname；首字符与后续内容变化不能自动折叠字段或移走输入焦点。展开/收起属于用户操作，同一 Host 的草稿、检查结果或无关配置更新不能改掉用户的展开选择；新 Host 可直接进入编辑。

- Browser 的设置 CLI 沿当前 Unix 用户的本地配置管理权限；显式开启自动化要说明能力扩大，但不冒充真人批准，不因浏览器操作失败自动开启，也不绕过已有 Profile 批准、控制交还或原生应用链接选择。界面保存自动化和忘记链接选择时，保护编辑或点击时看到的字段/答案；CLI 的 forget 明确忘记命令处理时当前答案，由同一配置 owner 原子处理，不暗示先前列表的 CAS。forget 回到下次询问，不提供 allow/deny setter，也不覆盖其它链接选择或普通偏好。

- 用户要求「所有设置项是否都可以通过 cli 完成，且 cli 设计的足够优雅清晰简单」。设置界面与 CLI 使用同一份配置事实和公开能力；可编辑设置都能从 CLI 读取和修改，命令明确对象、作用范围和生效时机，失败保留原值并给出可行动的原因。CLI 不另建配置系统，不用交互表象猜运行状态，也不自动扩大权限。只读系统事实通过诊断入口查询；纯粹的窗口动作不伪装成持久设置。

 的「设置界面不酷」反馈与视觉约束归密度 SSOT 的「Settings 控制工作面」。设置页现代化的既有行为合同仍然有效；保存失败保留编辑与切换分区保留草稿是两种不同情形，前者通过不能替代后者。当前证据与需求状态见 [设置界面视觉复核](../reviews/settings-visual-review.md)。

用户随后要求：「用你最好的交互设计水准，重构这个页面」「设置界面出现时也不应该遮挡 status bar」「设置作为没有太多功能的辅助界面，应该尽可能体现品牌感和产品感」。Settings 占据窗口内容区，原 32px status bar 始终可见、可交互，仍使用原窗口的入口、状态与浮层；切回工作面立即离开 Settings，并保留原 Tab、Region、焦点和健康 Run。被设置遮住的内容不接收输入，status bar 不跟随它一起 inert。Settings 不成为新的执行工作面或另一套全局导航。

设置分区切换保留已访问分区的草稿与阅读位置；尚未访问的分区不为保留草稿而提前挂载。已有资源优先于新增表单，新增入口明确且可收回；空资源时直接给出创建路径。保存动作在长内容中仍可达，结果在当前设置对象旁说明，保存失败保留编辑。设置文案围绕作用范围、当前选择和生效时机；底层包归属与实现术语退到诊断语境。现有 Provider/Executor 身份、权限与保存 API 保持稳定。

用户进一步要求：「先深度思考，要找什么样的参考，能确保我们的设计到最高水准」，并询问「如果要支持 `~/proj/github/deepseek-harness` 那样能为 RSI 提供基础的灵活度，设置这块要抽象到什么程度」。本轮先研究参考的适用任务，以及设置、配置与外部 Harness 的职责；具体配置 API、作用域、插件组成和 RSI 工作流仍是待确认的设计问题，不因为研究提案而自动成为产品要求。参考与架构证据见 [Settings 参考与 RSI 配置研究](../reviews/settings-reference-rsi-research.md)，Feature 为 `f-2dn8f8k3z`；品牌和视觉目标归密度 SSOT 的「Settings 控制工作面」。

### Agent 内部视图切换归 Message Tool

顶部 Chrome 只表达工作区、当前工作面和 Agent 生命周期汇总。Terminal 与对话/Activity 是单个 Agent 内部的交互模式，必须收进该 Agent 的 Message Tool 区域；切换不应占用工作区顶栏，也不能改变 Session、Tab 或 Region 的生命周期。切换控件要和消息工具同一套命中区、焦点、禁用和窄栏规则。

### 对话消息的阅读、复制与标注

对话模式不是左右两张客服卡。用户自己发出的消息靠右对齐，用独立但克制的身份样式表达；Agent 消息保持阅读流宽度，不使用左侧单像素竖线或大面积卡片阴影。每条消息都必须有可发现的复制动作，复制的是该消息的完整原文（含纯文本降级）。

用户可以在消息正文中选择一段文字，打开就地标注入口，输入留言后把“引用原文 + 留言 + 当前 Agent/Session”作为一次可追踪的回复请求发送。标注必须保留引用文本、来源消息稳定 ID 和范围信息；选区消失、消息切换或发送失败时不丢留言草稿。没有选区时不显示标注入口，避免把普通点击变成额外 chrome。

### PMO teams topic 名称与职责

固定协调对象的产品类型与快捷入口统一称为 Mote，原 `PMO teams topic` / `PMO teams` 是历史名称；PMO 作为默认角色之一，约束见《Space、Folder 与 Topic》。现有协调职责是和人讨论需求、组织执行 Agent、分配工作并持续跟进结果；底层仍是同一个 Topic，改名不创建新 Topic，不改变已存在的 Session、对话、文件目录和布局身份。用户已明确授权的分配与推进直接执行，不重复索要确认；默认把项目实现交给执行 Agent，只有用户明确要求 PMO 亲自实现时才承担该项实现。普通 Topic 不继承 PMO 身份。

### PMO Teams 从入口展开

用户点击浮动态 PMO Teams 头像时，面板从头像所在位置快速展开，展开后头像紧贴面板边缘并随面板拖动。点击头像和面板唯一的收起按钮都只收起同一个 Topic；不同时放置语义相同的关闭和最小化按钮。减少动态效果开启时直接显示最终位置。产品名称的当前约束见《Space、Folder 与 Topic》；名称与入口变化不改变持久 Topic、Session 或 Run 身份。

### Agents 全局层级与拓扑图

Focus 与 Space、Goals 位于同一组全局工作面。Focus 打开时 Project Rail 被遮挡，Project 只作为 Agent 的归属事实和未来拓扑图的分组边界，不再在左侧重复出现。Agents 当前先保留可用的分组/详情表面；引力图是独立 Feature：活跃 Agent 居中，不活跃 Agent 灰度保留；同一 Project 或 Demand 的 Agent 距离更近，Project 关联范围形成多边形区域。图中的节点、边和状态必须复用现有 Session/Project/Demand 事实，不能建立第二套 Agent registry。

### Demand 管理闭环

Demand 保留目标、背景、验收、负责人、状态和讨论；每次 Agent 执行、失败、重试或取消作为独立的 Demand 工作记录和既有 Session/Run 事实挂在 Demand 上。执行结束不能直接推断 Demand 完成，`done` 由显式确认或明确的外部事实推进。

Demand 需要同时支持未分配、只分配不启动、明确开始执行和重新分配。负责人（谁跟进）与 Project（共享目标和资源）与 Session（一次执行上下文）是三个独立关系；一个 Demand 可以没有 Session，也可以有多个 Session，改负责人或状态不会隐式停止已经开始的 Session。`backlog` 只表示暂不启动，离开它时才出现是否开始的明确动作。

Demand 详情与卡片共享同一组可编辑属性：标题、描述、状态、优先级、Project、负责人、标签、计划起止日期、父 Demand/推进批次和活动记录。父子 Demand 的状态不互相伪造；推进批次只用于解释一批子 Demand 的推进。活动、决策、评论和执行日志按来源区分，并在详情内按时间顺序可追踪。

Board 必须有一个可恢复的路由队列入口，用于查看无 Project、无负责人、未确认或需要用户处理的 Demand；路由队列不改变 Demand 的生命周期状态。顶部搜索、状态、Project、负责人、优先级、标签、日期和 Session/Agent 筛选作用于同一批 Demand，当前筛选可以清除、复制或由 CUI 重放。看板、列表或表格只是同一 Demand 集合的不同投影，不得各自维护数据。

Demand 卡只展示足以扫描和路由的摘要：稳定 ID、标题、状态、优先级、Project/负责人、标签、日期、子 Demand 进度和关联 Session/Agent 摘要。完整描述、活动、决策、评论、执行日志、重试/停止和删除确认在固定详情工作区中完成；删除是明确的危险动作，取消优先于删除以保留历史。AgentMux 的 Demand 文件系统包、Core Runtime 和 ctxmux 事实边界保持不变。
> 命名更新：历史讨论中的 “Leader Topic” 与 “PMO Teams Topic” 现称 **Mote**；PMO 仍表达默认协调角色，其固定身份、快捷面和职责约束继续有效。

### Topic topology 的计数与浮层边界

Topic 行默认横向列出所有 Tab，每个 Tab 以一个紧凑图标位快速扫读，当前 Tab 有明确的选中边界；总的 Tab/Region 计数不再单独占一个摘要块。用户 hover 或键盘 focus 某个 Tab 时，展开同一个顶层 topology inspector，只展示该 Tab 的真实 Region 几何、Executor、surface 类型和最近活动，并保留 Tab 标题与上下文。Inspector 不能被 Topic 列表、滚动面板或工作区工具容器的 overflow 裁掉；靠近边缘时在锚点上方或下方选择可见位置。Topic 行原有的点击打开动作保持不变。

### PMO 浮窗标题与 Board 左侧清单

- PMO Teams Topic 展开后是一块连续的紧凑工作面。标题只作为身份提示和拖动把手，不得另造高大的标题区域；头像、标题、关闭动作与对话内容属于同一块表面。视觉标题可以使用紧凑的 `PMO teams`，完整的 `PMO teams topic` 仍保留在可访问名称和工具提示中。
- PMO 浮窗的边界、焦点和拖动反馈必须清楚，但标题栏不能挤压对话首屏。展开、收起和窗口重启继续复用同一份浮窗状态，不能生成第二个 Topic 或 Session。
- Board 左侧工具面板只展示持久化 Demand 的摘要、数量和明确空态。Demand 为零时不得把 `main` 或任意 Branch 名称当成需求行；Branch/Project 上下文只在真正需要展示归属时出现，不能冒充 Board 主实体。
- Board 工具顶栏只保留一组不重叠的工作面控制和 Board 身份。Project Rail 被 Board 遮挡时，不得用固定宽度的侧栏 chrome 挤压或覆盖 Board 图标；控件必须在窄宽度下仍保持可见、可点击和可读。
- Demand 有两条创建入口：用户直接在 PMO Teams Topic 对话时，PMO 先澄清需求并在确认后决定是否公开创建；用户点击 Board 的“新建”按钮时，界面先创建一条可见 Demand，再以该 Demand 的上下文打开同一个 PMO Teams Topic 浮窗。两条入口都不能创建第二个 Topic 或把 Demand 偷换成 Session。

### Demand 的专属 PMO Tab

- Board 的 `New Demand` 每次都创建一个新的 PMO Teams Tab，并为该 Tab 启动一个全新的 PMO Agent 上下文。不同 Demand 不能共享同一个 PMO 对话来澄清、分配或跟进，避免上下文串线。
- Demand 与专属 PMO Tab 的绑定是可恢复的编辑器投影。Demand 文件仍只保存 Demand 领域事实；绑定关系和 Tab/Region 继续由编辑器工作面状态持久化，重启后先恢复原 Tab，再尝试恢复其中的 Session。
- Demand 详情必须提供明确的“打开 PMO”动作。点击后打开 PMO Teams 浮窗并聚焦该 Demand 的专属 Tab；如果原 Tab 已被关闭或不可恢复，动作先为该 Demand 建立新的专属 PMO Tab，再打开它，不能悄悄切到另一个 Demand 的上下文。
- New Demand 的初始提示词必须带上稳定 Demand ID、标题、描述和当前路由事实，并明确 PMO 只负责澄清、分配和跟进，不直接冒充执行 Agent。PMO 对话创建 Demand 的路径仍由 PMO 自己决定是否写入，不因为专属 Tab 规则自动新建空 Demand。
- New Demand 打开的浮窗如果带有明确目标 Tab，浮窗只能等待并展示这张 Tab 的 Agent；目标 Agent 尚未挂上时不能先展示旧 PMO Session，也不能在目标标记清除后回退到其他 Demand 的 PMO。

### Scratch Topic 打开后的工作面渲染

点击 Scratch Topic 后，Scratch workspace 的 Workbench 必须和普通 workspace 一样进入窗口级 registry 并显示对应 Tab/Region；Topic 只改变导航和绑定，不得因为 Scratch 是 wiki 工作区而留下空白右侧工作面。未准备完成时显示共享的 loading/失败服务窗，工作面本身不能被错误地过滤掉。

### Topic Workbench topology 的可读层级

Topic 行的工作面摘要必须明确区分三层事实：Tab 数量、每个 Tab 的 Region 布局、Region 内的 Executor 与最近活动。收起态横向列出所有 Tab，让用户第一眼看到工作面；单 Region 用该 Region 的身份图标，多 Region 用真实分栏网格。hover 或键盘 focus 后展开同一个 topology inspector，按选中的 Tab 展示真实 Region 几何、Executor、surface 类型和最近活动。已有 Tab 内的 Agent 不在右侧再列一份头像；没有挂载到任一 Tab、仍可工作的后台 Agent 保留独立身份入口，避免静默消失。

### Topic topology 的 Tab 缩略图语言

Topic 行的 Tab 收起态只占一个紧凑图标位：如果只有一个 Region，直接显示这个 Region 的图标；Agent Region 显示其真实 Agent 头像，Terminal、Browser、File、Launcher 显示相应类型图标。如果有分栏，显示一个按真实 bounds 构成的方形宫格。收起态不显示 `Tn`、`nR` 等内部计数标记。悬浮详情中 Agent 以同一头像自然呈现，名称与最近活动作为辅助文字；不能只写 Agent 名字而把身份图标藏起来。Tab 标题、Region 数量、Executor、surface 类型和最近活动在 hover 或键盘 focus 后的同一个 inspector 中可见；详情不能被列表或滚动容器裁切。视觉密度见 surface-density 的「Topic topology Tab 缩略图的空间密度」。

### Topic Tab 图标簇的交互

多个 Tab 的收起态图标沿用 Agent 头像簇的轻微叠压关系，表达“这是同一 Topic 下的一组工作面”，不把每个 Tab 拉成一排彼此孤立的按钮。每个 Tab 仍是独立的 hover/focus 目标；被指向或聚焦的 Tab 必须浮到最上层并完整可读，点击和键盘顺序保持按 Tab 顺序。

### 安装后的 Renderer 选择

安装新 App 或重启到新的内置 Renderer 后，启动必须先确认当前用户目录里的 hot update 是否属于同一份内置 Renderer。旧版本的 `active` 指针不能覆盖新安装包的界面；发现内置 Renderer 已变化时清空旧指针并使用新内置页面，同时保留布局、Tab、Region、Session 和其它 durable 工作面事实。热更新本身仍可在同一内置版本内恢复，失败时回退到该版本的内置页面并留下可诊断记录。

### 跨主视图的 Session 上下文连续性

用户打开或选中的 Session 是 Focus、Space、Goals 之间共享的导航上下文。切换到 Space 时，必须显示这个 Session 已有的 Workspace、Tab 和 Region；切换到 Focus 时，继续选中同一个 Session 的观察工作区；切换到 Goals 时，保留同一 Session 对应的执行行或卡片选中与可见定位。切换只改变主视图投影，不创建第二个 Session、Run 或 Region，也不改变 Agent 的工作目录。

如果 Session 已经结束、恢复中或暂时不可定位，切换不能清空当前工作面，也不能猜测一个新 Session；沿用现有服务窗和恢复事实说明当前状态。重新打开或从任意表面点击同一 Session，必须回到同一身份上下文。

### Agent Input 的可用宽度

Agent Input 的编辑区是这一行的主要内容，单行姿态下应优先获得剩余宽度。左右工具和发送、邮箱、身份控件保留稳定命中区，但不能用固定宽度把中间文字压成窄列；长文本在编辑区自然换行。Agent 名称、Executor 和 Session 信息留在上方身份 rail，不能为了给编辑区让路而重复塞进正文行。

### Message Tools 的底部回看入口

当 Message Tools 的编辑区或消息内容已经离开底部时，在 composer 内提供一个紧凑的“滑动到底部”入口。入口只负责把同一个编辑区滚动容器带回最新内容，不创建第二个滚动面，也不改变草稿或工具状态。编辑区已经在底部时入口必须消失；用户继续向下滚动时它可以重新出现。入口要有键盘焦点和无障碍名称，并且不能挤压 Agent 身份、工具、邮箱或发送控件的稳定命中区。

### Agent 终端颜色与 Provider 环境

AgentMux 的 PTY 终端必须向所有 Provider 提供同一份可显示颜色的终端能力：`TERM=xterm-256color`、`COLORTERM=truecolor`，并清理宿主遗留的 `NO_COLOR`、`FORCE_COLOR=0` 和 `CLICOLOR=0`。这条清理覆盖 Agent 启动、恢复和终端重连的完整路径；不能因为某个 Provider 更尊重这些变量而显示成单色，而另一个 Provider 仍有颜色。

Provider 或用户明确传入的其它终端环境仍按显式配置处理，但上述三个禁色信号不能从桌面宿主环境意外渗入新的 Agent。颜色能力只影响显示，不得阻断健康 Agent；若颜色探测或清理流程失败，终端仍保持可输入并留下可诊断提示。

### Agent 终端 256 色显示

Claude 的终端输出会使用 ANSI 256 色（包含橙色等索引色），这些颜色字节到达桌面后必须在 xterm 的 DOM 与 WebGL 渲染路径中保持可见。终端主题只提供基础 16 色时，也不能把其余 ANSI 索引色折叠成前景色、背景色或灰度；Provider 名称、消息类型和是否为 diff 不得改变 256 色的解析结果。回退渲染路径与主渲染路径必须使用同一份颜色语义，颜色失败不能阻断健康 Agent 的输入和输出。

### Result ready 在小 Region 中的可用性

Agent 完成后的 Result ready 只占一行紧凑摘要，默认不展开文件和链接。用户可以明确展开、收起或关闭它；关闭后终端、Message Tool 和 Region 的主要操作必须立即恢复可用。展开的结果按文件和预览目标分组为可扫描列表，内容有独立滚动上限，不能靠把每个目标平铺成按钮而把小 Region 撑成十行左右。窄 Region 里所有可见控件必须可点、可键盘到达；面板不能盖住或挤走输入区。

### Claude Prompt 提交

从 Message Tool 发送给 Claude 的文字必须完成一次真实的 Prompt 提交：文字进入 Claude 输入区后，终端要收到该 Provider 当前输入模式对应的提交键，并能从后续终端字节或状态观察到已离开编辑态。不能把“文字已写入输入框”当成发送成功；发送失败或 readiness 尚未完成时要保留草稿并给出可诊断提示，不静默清空或假装执行。

### Topic Tab 缩略图导航与 hover 结构

Topic 行上的每个 Tab 缩略图是可操作的导航入口：点击或键盘确认后，必须直接激活该 Tab 所在的 Workspace、Tab 和 Region；只改变 hover 检视而不改变工作面的交互不成立。缩略图保持紧凑的横向 rail，单 Region 只显示该 Region 的身份图标，多 Region 显示与真实 bounds 同比例的分栏轮廓。

Tab 的 hover/focus 浮层只保留一份信息：上方是 Tab 身份，主体是按真实 Region bounds 绘制的工作面小地图，Region 内用图标识别 Agent、Terminal、Browser 或 File。最近活动作为 Region 的轻量辅助信息贴在对应格内或作为单行摘要，不再在地图下方重复列出同一批 Region。

### 对话中用户消息的阅读方向

用户消息气泡整体靠右，用来表达对话轴上的发言归属；气泡内部正文、Markdown、列表和代码块统一居左对齐，长内容从左侧开始阅读。用户头像、时间和操作元数据可以继续沿右侧排列，但不能让正文跟着气泡方向右对齐。

### 执行 Agent 焦点历史与 PMO 上下文隔离

执行 Agent 与 PMO Teams Agent 属于两套不同的上下文。用户在 Space、Focus、Goals 之间切换时，只沿用当前执行 Agent 的身份、Workspace、Tab、Region 和焦点；打开或切换 PMO Teams 不得改写执行 Agent，也不得把 PMO Session 放进执行 Agent 的历史。

执行 Agent 焦点由一个明确的全局导航上下文承载：当前 Session 和真实聚焦事件共用同一份有界持久化记录。最近上下文入口按最近使用顺序从该记录派生，同一个 Session 只出现一次；时间音轨保留记录中的真实重访位置，不以最新位置覆盖旧事件，也不回填从前未保留的事件。任何执行 Agent 的打开、选中或跨表面跳转都通过这一上下文记录；切换主表面只读取它，不另猜一个“最近变化的 Session”。历史可以被 Agents 界面作为可操作的最近上下文入口，也作为只读上下文提供给 PMO Teams；PMO 只能观察这份执行上下文，不能把自己的交互写回去。

PMO Teams 有独立的当前 Session/Tab 焦点，只由 PMO 浮窗和 PMO Topic 导航使用。PMO 打开、恢复、提交消息和切换 PMO Tab 都更新 PMO 焦点；关闭 PMO 后回到之前的执行 Agent 上下文。执行 Agent 历史和 PMO 历史不合并，两个身份在 UI、持久化和提供给 Agent 的上下文中都必须可区分。

### Focus 执行上下文、项目泳道与底部时间音轨

用户进一步要求 Focus「达成熟产品水准，交互与性能远超竞品，所有功能自己测试满意」。质量以现有 Focus 的完整使用流程成立为准：从入口预览、辨认和筛选上下文，到处理请求、查看结果、在原工作面继续工作、查询时间音轨并返回，再到布局调整、跨表面切换与重启恢复；各功能既能单独使用，也能连贯完成真实任务。鼠标与键盘、宽窄窗口、空态及恢复状态都须可理解、可到达，阅读和输入不能被操作栏、浮层或滚动边界阻碍。自行体验验收须记录实际操作、可见结果、响应成本与保留的原身份，不能以组件测试通过或安装成功代替；发现的缺陷与未验证边界如实保留。成熟度与竞品优越性是用户目标，只有绑定对比版本、同等数据和任务条件的证据才可形成比较结论，不能将目标写成已完成事实。事实来源、性能、连续阅读及身份保留继续沿用本节与《Terminal 连续向上阅读历史》的既有约束。

用户补充：「focus 按钮的 hover 感觉信息可以包含一些动态信息，更丰富一些」。Focus 入口的悬停与键盘聚焦预览呈现当前执行事实：Working、Attention、Results 与 Idle / Recovery 数量，以及当前关注和少量优先需要处理、正在工作或已有结果的上下文。每项用任务名、项目归属与最近已知活动回答“谁在做什么”。归类、名称、摘要复用 Focus 的同一事实来源，PMO 协调上下文保持既有职责边界；Disconnected 以紧凑数量表达，不扩成历史名册，即使它是当前关注项也不展示详情；原关注选择与 Session 身份仍保留。未知与空态如实呈现，不把存活或旧输出推断为正在工作或新结果。

预览随真实状态更新；关闭后不保留详细预览订阅，不因无关 PTY 字节重绘或新增后台查询、轮询。悬停只阅读，不切换表面、不更改执行焦点、不发送输入；点击 Focus 仍进入既有工作面。Escape、失焦与指针离开正常收起，键盘可读同样的信息。具体视觉约束见密度 SSOT 的对应 Focus 章节。

用户确认「按你说的改一版」，并要求「时间音轨参考一些视频编辑软件的样式，且放在最下面」。Focus 保留项目泳道、Recent Focus 与右侧完整原工作面；时间音轨位于整个 Focus 内容底部、全局状态栏上方，项目扫描与继续工作占据上方主区。PMO Teams 不混入执行上下文或其历史。

用户持续反馈 Focus「滚动有问题」「右边的加载也有问题」，并将 Renderer 性能作为 P0。大数量资格验证须绑定实际数据来源、版本与窗口条件；真实观测集合和扩展压力样本分别声明，不能把合成样本或自然窗口之外的局部测试称为真实使用通过。左侧泳道与底部音轨保持各自连续阅读，右侧加载与 Focus/原工作面交还保持同一 Tab、Region、Session 和健康 Run。成本沿真正相关的消费者和变化事实核对，不因无关项目、保留的断连上下文或其他历史数量反复推导整份工作面；通用终端成本与连续阅读要求引用《Terminal 连续向上阅读历史》，不在 Focus 另立协议或历史账本。

用户进一步指出「每一个砖块上的信息，什么都看不出来，而且利用率很低」。条目首屏必须能区分同一项目、同一模型的多个 Agent：名称遵循既有显示名优先级，最近动作来自已有可观察事件；项目归属在泳道头表达，完整路径和完整身份按需查看，不在每块重复消耗首屏。事实不足时如实说明，不编造任务、进度或正在执行的动作。

缺少任务语义的 Terminal 以原 Tab 的已有名称和 Region 的真实位置区分同 Tab 多格，归属与既有 Focus/Space 导航实际选中的原工作面一致；同名跨无名 Tab 只按需查看真实地址，不宣称任务已知或首屏全局唯一，也不改变 Agent 语义命名、原身份或生命周期。

用户反馈「泳道里有很多显示 failed 的 terminal，感觉逻辑不太闭环」。Focus 展示当前可继续的终端工作：有原 Tab/Region 的失败、中断或结束终端仍保留，沿原工作面查看输出与恢复；已经结束或中断且没有工作面引用的历史 Run 不再混入当前泳道和入口预览，底层记录仍保留。仍在运行的无窗口终端保持可发现；暂时恢复中的原 Region 仍算原工作面，不以名称、挂载或输入是否已就绪判断归属。失败条目须展示已有退出说明与退出码，已记录主动停止、异常退出、原因未知分别诚实表达，不能把非零码或终止信号推断为具体肇因，也不能用旧任务活动盖住退出事实。归类与说明随同一来源的事实变化更新，不新增轮询、终端历史注册表或生命周期操作。

项目是纵向分组，宽屏支持状态组横向比较；左侧收窄时按状态分组纵向排列，所有 Context 和状态仍可到达。用户指出「项目的名字还是完整地占满了一整行（或一列）」：项目名与层级归属以紧凑组头表达，不独占项目轴。泳道按已有 Project、Branch/worktree、Topic 事实展开到实际层级，Scratch 的 Topic 不能合并成一个看不出主题的大组。已销毁的 worktree 仍保留独立的历史泳道与明确状态；Disconnected 不等于 worktree 已销毁，缺少事实时表达未知。需要用户处理的事项优先可见；空分组不占大块空态。Working 只接收权威状态确认为运行/工作中的上下文，disconnected、stopped、idle、未知或待恢复状态保持原义，不伪装成 Working、完成结果或进程失败。项目计数区分活跃 Run 与全部上下文。

用户进一步要求「很多小体验功能也要优化，比如 Focus 泳道，不活跃超过一段时间的就应该往后放」。泳道按真实近期活动组织：需要处理的事项与权威 Working 保持前列，超过一天（24 小时）没有可读任务活动的泳道后置；已知近期活动优先于无法判断活动时间的历史泳道。最近活动只取已有任务事件和权威状态进入时间，后台探测、同状态心跳、终端字节与打开视图不能刷新排序依据。归属层级、原 Context 与恢复入口保持，不能用后置代替删除或改变 Runtime 状态；同等级保持稳定次序，不随心跳反复跳动。该时间门槛是当前可调整的产品默认，用户另行选择时同步更新此处。

用户最终选择「Disconnected 还是放在 Idle / Recovery 里头，但是不要占这么多空间」。每条泳道的 Disconnected 留在 Idle / Recovery 内，默认折叠为显示数量的紧凑入口；展开后能查看、选择和恢复原 Context。搜索命中的断连上下文与当前选中上下文保持可发现，不因折叠丢失身份，也不为节省空间删除 Session。

用户继续指出「Needs you 和 Error 感觉没有分开的必要，有点浪费空间」。两者在 Focus 合为一个优先的待处理组，保留待授权、需回复、受阻与真实运行失败各自的状态、严重性和处理入口；合并分组不修改 Core 状态，不把流程降级或未知归为 Agent 失败。没有待处理时该组只在统一状态过滤入口保留计数，不在每个项目重复空组或占完整空列。主区按待处理、运行中、结果与闲置/待恢复组织；后者内部明确区分 Idle 与恢复/未知事实。

用户追加反馈「Results 的利用率非常低，感觉根本没这个状态，而 idle 却和 working 混在一起」。Focus 的 Results 由当前轮已确认完成、可查看的真实产出驱动，不要求 Agent 进程退出；已有完成回答且没有后续执行的闲置 Session 可在 Results 展示，其状态仍明确表达闲置/已完成。没有当前完成产出的闲置 Context 单独归 Idle；Working 不吸收 idle、disconnected 或未知。继续提交新一轮后，旧结果不再作为当前完成结果。Results 首屏显示有辨识力的结果摘要并可定位到同一 Session 的原工作面，不复制对话、不创建第二份完成/未读状态。

用户要求完整使用流程自行体验达到成熟产品水准。从 Results 查看 Activity、文件变化或网页预览时，所选结果须在用户选择的既有工作面中可见、可读、可操作；仅已读取或隐藏创建不算查看成功，用户无需再寻找一次 Space 或目标 Tab。返回 Focus 后保留原执行 Context、Tab、Region、Session、Run、历史与草稿。显式查看结果与后台准备保持各自职责；准备、恢复或后台创建不改变人的当前主工作面与浮窗归属。隐藏保留面的绘制与命中边界见密度 SSOT 对应 Focus 章节。

文件仍在读取时，用户后来选择的 Space、Tab 或 Region 继续拥有当前画面；读取完成不能抢回旧结果，即使两个 Tab 属于同一 Space、都没有 Agent Session。成功读取的文件与 Diff 仍保留在原目标工作面，不丢产出，也不把后来选择的文件记成旧结果。

连续显式打开多个文件时，最后一次打开拥有显示目标，不能按磁盘读取完成的先后决定画面；共享同一次读取也不共享激活权。后来的选择失败或用户离开又返回，都不让更早请求自动抢回画面。等待期间在其他 Space 的实际导航同样受保护，包括从浮窗发起的结果查看。

点击 Agent 输入框里的文件、技能或组件引用时，打开引用中的真实文件路径，并明确归属该 Agent 所在的 Space；当前正在查看另一个 Space 时也不能混淆归属。引用的显示名、Space 身份与文件路径各自保持原义，文件打开仍遵循上述最新选择与等待期间不抢导航的约束。

引用点击是显式查看动作：立即进入引用所属的 Space 工作面，文件读取成功后在该工作面可见，不能只在后台放好文件让用户再找一次。读取期间用户后来去往别处或打开其他文件，仍拥有最新画面；失败沿既有错误面说明并保留原 Session 与草稿。低层文件与 Browser 准备本身继续保持当前主工作面，不承担此入口的显式导航。

用户追加指出「PMO context is isolated 这种冗余，顶部的标题栏也是冗余，白白浪费一行空间」，并希望「status bar 活跃 Agent 的观测和左下角 Focus 选项合并」。Focus 不重复显示已由导航表达的工作面标题、隔离说明、总量脚注或独立项目标题行；搜索、项目过滤和必要动作贴近内容。整窗 Agent 观测归左下角 Focus 入口：运行数与待处理数可扫描，待授权、需回复和错误的明细及直达原 Session 的动作仍可到达；不在状态栏另复制一套计数和展开入口。待处理须可发现，PMO 与执行上下文仍保留其身份边界，不能为了合并视觉而隐去有效请求。资源观测沿用独立按需入口。

用户进一步要求「顶部应该还是要有一个 bar，连成一横排」，左右部分分别承载过滤与当前 Focus 上下文；这是同一条操作栏，不再叠加标题行。右侧支持右键与键盘菜单中的改名、回到原 Space 工作面、查看待处理请求与关闭观察投影；动作复用原身份、显示名与导航所有者，不管理 Agent 生命周期。

Focus 菜单由哪个控件打开，Escape 后键盘焦点就回到该控件；从身份区打开的右键或键盘菜单回到当前身份按钮。行内改名按 Escape 取消后回到同一身份按钮，名称保持未提交。选择改名时输入框获得焦点；继续到 Space、关闭 Focus 工作区或查看请求后，由所选动作的目标承接焦点，不能被菜单关闭时的焦点恢复拉回，也不无条件聚焦终端。外部点击或改名失焦提交时，焦点继续跟随用户实际选择的新目标。

显式选择 Continue in Space 后，第一键进入实际激活的原 Region；用户不必再点一次终端。显式关闭 Focus 工作区后，第一键进入仍可见的 Search contexts，不能落在页面空处或送给隐藏终端。仅这些明确动作交还输入焦点，后台更新、指针选择与其他工作面切换不自动抢焦点。

Recent Focus 只读取同一份持久化 execution focus history 与 Core 已持有的消息事实，点击片段回到对应已有 Session；当前焦点和最近历史可扫描，完整轨道可以展开与收起，轨道内容独立滚动。用户要求「下面的时间轴，高度要支持可调」：顶部边界可拖拽，也可用键盘调整，记住用户高度；收起后再打开恢复此前高度。窗口收窄或变矮时仍保留主工作面的有效操作空间。时间位置取自真实 focusedAt 事件；片段终点只使用已知的下一次聚焦事件，未知终点明确保持开放，不补造未来十五分钟或精确运行时长。

用户进一步要求「Recent Focus 可以支持查询任意时间」，默认「过去三小时到未来一小时共四小时的窗口」，并支持「快速切换窗口大小」。用户可选择任意日期与时间、前后移动同样大小的窗口，并一键回到当前窗口；默认窗口随当前时间缓慢前移，历史查询窗口保持所选位置。窗口选择不改变执行焦点或原工作面。像剪辑软件那样的竖线贯穿标尺与各 Context 轨道，表达真实当前时刻；当前 Context 的选中标识与时间位置分别可辨认。未来部分保持为空，窗口里没有已保留记录时如实说明；任意时间可查询不等于捏造完整无限历史，记录保留边界与未知区间须可发现。

用户希望「把用户什么时候在哪个块上把消息展示出来」，并确认「只标用户消息」：用户真实发出的消息按 Core user_message 的发生时间展示在对应 Context 轨道，不标 Agent 回复，不从终端字节、焦点切换或 Agent 回复猜测。消息标记能查看时间、原 Context 和消息内容，并可回到同一已有 Session 的原工作面；按需预览不修改焦点，不复制持久化对话，不创建第二份 Runtime 事实。

Focus、Space、Goals 共享同一执行上下文。切换表面、选择泳道条目、调整比例、收起音轨时，原 Tab、Region、Session、Run 与健康工作面保持；Focus 与 Space 之间不能因 portal 目的地变化重挂载已存在的终端、Browser 或编辑器。分割树与原组地址仍归 durable Workbench，Focus 只改变投影。目标暂未出现或恢复事实未就绪时保留原内容与可见说明，自动尝试接管，不以空白或删除身份代替恢复；每条正常分割分组及其非选中 Tab 都必须保持可恢复。

执行 Agent 在 Space 中点击或键盘进入 Region、从 Focus/Goals/Quick Switcher/Topic 定位时，复用同一 execution focus 写入入口。最近上下文入口对同一 Session 只显示一个最近位置；同一 Session 内切 Activity/Terminal 不重复记录切换、不创建第二份历史。重启先恢复历史、当前 Session 和原 Tab/Region，再尝试续接。

主区、音轨与工作面各自拥有明确滚动边界；增长的历史不能挤掉主区，空 registry 壳不能截走点击、滚轮或输入。右侧减少重复标题，恢复/未知/真实失败显示既有服务窗语义并保留输入能力。涉及这些热路径时，正常活跃终端连续向上阅读与工作量边界同时按《Terminal 连续向上阅读历史》验收。视觉尺寸、密度与控件语言只定义在 surface-density 的同名章节。

### 全局工作面顶栏与名称

Focus 不留独立标题行，其必要过滤控件直接避开 macOS 原生窗口按钮；Goals 工作面的左上角标题也必须避开这些按钮。Project Rail 在全局工作面隐藏时，不能仍按它可见来决定标题起点；切换 Focus、Space 和 Goals、开合工具坞或重启恢复后，系统按钮与标题都必须保持可见、可操作。

顶级工作面和单项名称归《左下角导航、Space 与 Goals》。名称调整只改变用户可见表达，持久化 Demand、Session 和已选工作面的身份继续由原 owner 持有。

### 原生 Browser 与 Agent 身份浮层

Agent 头像的 hover/focus 详情属于最高层的非模态身份浮层。它可以跨 Region 阅读，不能被相邻 Region 的 Browser 原生视图盖住；`z-index` 只解决 Renderer 内部层级，不能代替对窗口级 Browser 的让位。浮层打开时沿用统一的原生表面遮挡租约，浮层关闭、失焦、Escape、组件卸载和异常路径都必须释放租约，不能留下永久空白 Browser。

Browser 在窗口或分栏尺寸调整期间保持最近一次有效画面。Renderer 暂时得到零宽/零高或未完成布局时，属于几何过渡，不得把 Browser 当成关闭而调用隐藏；等下一次有效矩形到达后直接更新边界。真正的不可见、切换、停放、截图/选择操作和错误状态仍然可以主动隐藏 Browser。尺寸调整不能触发 Browser 销毁、重新导航或空白闪烁。

### 浮层让位默认成立，而不是逐个接线

用户原话：「弹窗经常被浏览器挡了」。「经常」是这条约束的要害——它不是某一个弹窗的缺陷，而是让位**默认不成立**：让位要靠每个浮层各自记得申请，全仓二十余个浮层里只有个位数接上了，于是被挡与否取决于你恰好打开的是哪一个。

所以约束是：**任何画在 Renderer 里、会盖住窗口级原生视图的浮层，让位必须默认成立，不依赖它自己接线。** 新增一个浮层的人不需要知道这条规矩，也不会因为不知道而制造一个被挡住的浮层。判据取浮层库本身的 DOM 协议（内容 portal 到应用根之外并带打开态标记），不点名任何具体组件、不维护一张浮层清单——清单会和代码漂开，而且它一存在，下一个人遇到误报的第一反应就是往里加一行。

叠放必须逐层收口：对话框里打开一个下拉，关掉下拉时原生视图不得回来，因为对话框还开着。退场动画期间的浮层不再算遮挡，原生视图不能等到动画结束才回来。协议覆盖不到的浮层（portal 出去时不带打开态标记的）继续自己持租约，两者互不覆盖。

Escape、点击外部、失焦、选中项、组件卸载与异常路径之后，原生视图都必须回来；任何一条漏掉都会留下一格永久空白的 Browser，那比被挡住更糟。

### PMO Teams 浮窗拖拽与工作面外壳

PMO Teams 浮窗拖拽必须保持指针跟手：拖拽过程只更新当前渲染所需的临时位置，pointer move 不能逐次写 localStorage、广播全局状态或触发完整 PMO 工作面重建；位置提交、边界归一化和持久化在 pointer up 后完成。拖拽需要捕获指针，离开标题栏或跨过内部工作面仍不能丢失手势；取消、窗口失焦和卸载必须清理临时拖拽状态。

PMO Teams 是固定产品工作面，不应只是完整 Workbench 的透明容器。浮窗外壳需要有自己的标题、层级和内容边界；通用 Workbench 的 Tab/Region 能力可以复用，但重复的窗口 chrome、空态装饰和 PMO 标识不能互相叠加。浮窗打开后第一眼应能识别“这是一个独立的 PMO 工作面”，内容区保持连续可操作，拖拽和关闭不改变其中的 Session/Tab 事实。

### 产品表面设计审核与参考层级

- 新的桌面工作面、浮层和工具栏在实现前必须先找同类成熟产品作为参考；参考必须匹配对象和交互，而不是只借颜色或圆角。浮动终端/工作面优先参考成熟桌面终端的浮动面板形态：36px 级别的工具栏直接承载 Tab、分屏和新建动作，工作面不再另造一条大标题。
- 设计默认采用内容优先、工具条优先和单一 chrome。标题是身份元信息，不是首屏主视觉；如果去掉标题仍能从 Tab、头像、状态和工具提示识别工作面，就不要保留大字标题、副标题或欢迎式说明。
- 一个表面只能有一套窗口边界、一套标题/Tab 层级和一套关闭语义。把完整 Workbench 放进弹窗时，必须复用 Workbench 的顶层 Tab/工具栏，不得再套一个同义标题栏、第二个空壳或重复的 PMO 入口。
- 评审第一眼必须能回答三个问题：当前工作面是什么、第一交互是什么、内容从哪里开始。不能回答时先删减层级和装饰，再考虑增加说明。大标题、宽 padding、持续副标题、重复边框和无操作的品牌卡片属于默认拒绝项。
- 参考证据、反例和最终截图/运行态核验必须写入 feature 的 design source evidence；“看起来更现代”不能只作为口头判断。验收至少包含正常宽度、窄宽度、打开后第一帧和拖动中的状态。

### Fork / Resume 的工作面归属与 Message Tools 编辑器

- Fork 出来的 Agent 仍属于它自己的 Session/Tab/Region 映射。之后从旧 Session resume、打开 Browser 或创建新 Tab 时，目标必须由被操作的 Session 上下文解析出所属 Workspace、Tab、Region 和插入位置；不能使用当前鼠标焦点、最近全局焦点或“旧 Agent 右侧”作为隐式落点。
- 如果目标 Session 已不可定位，界面必须显示明确的恢复/选择目标动作；不能悄悄把内容挂到另一个 Agent 的 Region，也不能因为焦点切换而改变目标归属。创建后的新 Tab 必须能从 UI 直接确认它属于哪个 Session。
- Message Tools 的编辑区在单行状态下输入增长时自动扩展为多行，保留左右工具、Agent 身份和发送动作的稳定命中区；中间编辑区占据剩余宽度并从左侧开始阅读，不得把长文本压成居中的窄列或只露一条细线。达到上限后才滚动，回删后可以恢复单行。

### Session Attach 与 Runtime Projection 的边界

打开、刷新或恢复一个 Session 时，操作先绑定目标 Session/Run，再消费目标 Attachment 或精确 Subject 返回的权威 Run 事实；一个单目标操作不能为了生成单个 Session 画面而枚举全部历史 Run。启动快照、Agents 聚合和跨 Host 查找等确实需要全量事实的入口可以读取完整 Runtime projection，但它们不能成为单目标操作的隐式前置步骤。

ctxmux 持有 PTY、Run、Attachment、ordered bytes、Replay 和 Gap；AgentMux Core 负责把目标 Run 与 AgentSession 组合成 Runtime Subject；Desktop 负责工作面恢复和服务窗。Runtime 暂时不可用或流程握手失败时，保留原 Tab、Region 和 Session 引用，明确显示失败步骤与恢复动作；只有 Core 给出终局 retired/unknown 事实时才移除投影。

### 联邦 Runtime 与远端恢复边界

- AgentMux Runtime 是可被 Desktop 管理的最小远端单元。它可以运行在本机，也可以运行在无 UI 的 Linux 服务中；远端 Runtime 自己权威持有 Provider、AgentSession、Hook、Permission、readiness、semantic resume 以及它所连接的 ctxmux 事实。Desktop 只是客户端和工作面投影，不把这些事实复制成第二份本地真相。
- Desktop 只持久化 Runtime endpoint 配置、可信身份、稳定的 Session/Run 引用、工作面布局和最后一次观察结果。远端暂时不可达、握手失败或能力探测未完成时，原 Tab、Region 和引用继续保留，并以“尚未确认/正在重连”服务窗表达；只有 Core 明确给出终局 retired/unknown，才允许移除投影。
- `ExecutionHost`（文件、shell、SSH 等执行能力）与 `AgentMux Runtime endpoint` 是两种不同的产品能力。即使它们落在同一台远端机器上，也不能因为能访问工作区就假定 Agent Runtime 可用；两者的身份、能力和恢复状态分别呈现。
- 远端管理的对象是 AgentMux Runtime，而不是把 Desktop 直接变成 ctxmux 的远程控制器。ctxmux 继续只负责 PTY、进程、Run、ordered bytes、Replay、Gap、Attachment 和权威运行时事实；AgentMux 负责 Agent 语义与 Session 恢复，Desktop 不在两层之间再保留一份实现。
- ctxmux 的持久化语义必须如实表达：客户端断开和 daemon 重启可以保留历史 Run、Replay 与恢复线索；宿主机重启后的原生 PTY/进程连续性不是 ctxmux 的保证。宿主重启后由 AgentMux 使用 durable Provider handle 语义恢复同一 Session、创建新的 Run 时，界面应显示“同一 Session 的新 Run”，不能声称原 PTY 仍在继续运行。

### 断电后旧 Run 消失时的 Agent 恢复

断电或 Runtime 重启会使旧 CtxMux Run 失效，但不能使持久 Agent Session、Provider 原生会话句柄、Tab/Region 或焦点消失。恢复流程必须按稳定的 Agent Session 身份决定：旧 Run 存在时 reattach，旧 Run 不存在且 Provider 句柄可用时启动 Provider-native resume；任何恢复竞态都必须保留原工作面并给出可重试的服务窗提示。

旧 Run 的 attach 失败属于恢复流程状态，不得直接把用户留在“Attach failed”终端错误上；恢复完成后必须重新解析当前 Session control，再附着新的 Run。Provider 探测失败只允许在权威探测确实失败时显示，不能由一次早于环境准备完成的探测把可恢复 Session 终结为不可恢复。

### P0 的共同交付边界

零输入字节只能证明当前失败尝试没有写入，不能证明更早一轮已结束。原 operationId 的恢复继续走幂等路径；换成另一条消息且回合仍未知时，必须有这条消息自己的明确继续选择，不能借用上一条消息的批准。

用户要求完成当前六项 P0 的设计与实现，包括此前只规划的可读 A2A 协议。各项约束仍归其所属章节；“代码已有”不能代表交付，必须证明真实入口、失败分支和重启后的恢复。发送与恢复的检查失败不能拿走健康 Agent 的工作能力；无法确认的事实保持未知，并在原工作面持续说明恢复动作。Browser 批准只授权被确认的目标和操作；Demand 详情保留原需求身份与编辑能力。

### 操作成本与当前卡顿

- 隐藏终端仍要接收和解析输出，保留原 Session 与 Runtime attachment；GPU 绘制资源只属于当前可见的终端。切换可见性不能重新启动 Agent、丢输出或换身份。
- 浮层的共享宿主是唯一的窗口级 DOM 身份。解析它不能反复遍历终端、文件树或正文；工作面内容变多，不得增加这项固定窗口操作的成本。宿主被移除后仍能由原所有者重新建立，显式指定的容器保持原路由。

- 用户原话：「现在进程非常卡」「让系统成本只随真正相关的工作增长，先缩小范围再做重处理，不要让无关数据、历史和功能拖慢当前操作」。输入、切换与当前工作面的更新不能被无关 Session、历史或后台观察反复拖慢。
- 卡顿定位必须区分主进程、Renderer、Runtime、Agent CLI 和验证负载，结论绑定采样版本与操作；不能以一次体感或静态代码推测冒充根因。局部修复须证明原热点成本收敛并保留 ordered bytes、恢复与健康 Agent 的工作能力。
- 默认不保留兼容层、legacy、fallback 或临时 workaround；不做 migration。复用当前依赖和平台能力，在权威事实的所属层修复，避免为探测、重试或性能增加竞争状态与中间层。P2/P3 的独立问题不能作为本轮 P0 交付的阻断门。

### 跨重启的 Prompt 投递凭据

- Prompt 两阶段投递的持久化 claim 是去重与恢复记录，不是把下一条 Prompt 永久挡在门外的许可闸。应用重启后重新接入同一个仍为 `running` 的 Run 时，旧 claim 未确认本身不得触发 Resume、Retire 或删除健康 Session。
- 两个公开 `AgentMuxClient` 实例共享同一受支持 Session Store/Run，以及两个 Control/Renderer 经同一 Core owner 发送，都必须保有唯一在途 Prompt 投递 owner。另一 Client 看不到本实例内存记录，不代表旧 owner 已结束；活跃 claim 不能被替换。投递前须重新读取当前 Session/Run 与待答边界，普通 Prompt 不冒充交互回答。精确绑定当前 Session/Run/request 的人类回答不等待可选的 Prompt 渲染观察；结束该观察不取消已派发的 Native Input，也不替请求补完成或批准。
- Core 投递 scope 释放或进程退出，不代表 Native Input 已终结；游标仍在旧 claim 起点也不能证明旧输入将来不会写入。首次投递前须在现 admission 保存原始 bytes、key、range、daemon incarnation 与两阶段意图，冷恢复只按原 tuple 接续既有 recoverableInput，不能从 digest 或变化后的 Provider 计划重建输入。unknown/partial 保留原 operation、内容、工作面与原生输入能力，并说明待核实原因；缺 tuple 如实 unknown。不同消息接管须有真实 not_applied 或其他终局事实，证明旧请求已无未来写资格；不能猜 TTL、PID 或语义状态，不能留下无法自行恢复的永久 BUSY。
- 两阶段 Prompt 的正文已接受、提交未派发时，人工输入可能占用旧提交范围。恢复须核对原提交的终局；不能把正文已接受改成整条消息未投递，也不能因为已终结的提交阶段让后续消息永久卡住。无法确认的部分仍保留原消息与原生输入能力。
- 新的提交建立自己的两阶段字节范围与 readiness 观察；同一 `submissionId` 和相同内容按原冻结输入幂等续做，冲突内容拒绝。旧 ACK 只属于原 Session/Run/operation，不清新 claim、请求或草稿；Host accepted 不冒充 Provider consumed。任何恢复流程失败都要保留可见工作面和健康 Session。
- 普通 Prompt 的意图在首次可能执行的 RPC 前，从 exact Core Session/Run 事实捕获显式 admission 前驱条件，与 operationId、原正文和原 Run 一起先保存，再发送；未派发的 queue tail 不在 enqueue 时提前绑定。`null` 仅表示已确认没有 admission，缺字段、不可读事实或现记录缺逻辑身份均是 unknown。重试、丢 ACK、冷恢复和跨客户端不换前驱或 Run；MessageTool/CLI 也在现有消息 journal 中保留第一次条件，不能由 Main 每次发送时补最新值。
- 首次条件读取只刷新精确目标 Session 的持久事实，不以进程状态代替 admission，不顺带探测、投影或恢复其它 Session。Mote 浮窗和任务入口的消息复用现发件列表；入队表示保留意图，不能把它称为 Agent 已经收到或执行。 浮窗交接被拒时保留未交接文字及原因，只报告一次，不因重渲染反复交接或修改焦点。 目标事实读取的等待不得占住全局消息写通道，阻挡其它 Session 的消息；两个客户端准备同一消息时，只有首次保存的条件有效。
- 消息回执只有已成立的状态转换才能写入 durable journal；被拒的转换不得留下无法重放的记录，也不得覆盖该消息已有的投递事实。
- 控制链路报错或丢回执只说明该次投递无法确认，不据此把消息标为终局 failed。消息保留最后已确认的状态及未确认原因；取得真实回执后消除该提醒。迟到的报错不能降低另一客户端已确认的投递事实。 未确认原因是普通文本，保留换行；诊断时间必须有效，不能改写最后已确认状态的时间。同状态回执保持原值，不因重试刷新时间或原因。
- Core 在现同 Session 独占 scope 中，先核条件再写 claim：当前是本 operation 且原 tuple 完整时继续恢复；当前仍是捕获的前驱时才允许首次 admission；已是其它后续 operation 则具名 unknown，零新派发、不改后续事实。只有真实证明该意图尚未 admission 且没有原在途执行，才能重新准备首次条件；timeout、丢 ACK、unknown 和零游标均不证明这一点。某个旧操作 unknown 不禁用整个健康 Session，新显式意图与 raw 仍可用。
- 一个仍能接受输入的 Agent 必须有明确可达的发送路径。回合结束回执缺失不能把 readiness 变成永久许可闸；无法确认回合边界时说明风险，人工显式发送按「Cmd+Enter 直接 steer」执行；自动消费仍不能猜测空输入框等于回合已结束。已被接受但未确认的 Prompt 使用原 operation identity 续做，不重新发送正文；排队消息不因无关 Runtime 事件反复提交。

### Hook 配置隔离与非 AgentMux 会话

原生恢复身份与会话记录必须属于当前 Agent Session。下属 Agent 的普通工具、权限与生命周期事件及其记录位置不能覆盖主 Agent 的原生会话句柄，也不能把主身份与下属记录路径拼成一个貌似有效的句柄。Provider 已声明的下属事件继续提供状态、活动和在途事实；记录归属不清时如实保留未知，不阻断主 Agent 的工作。合法主会话事件仍可建立或更新主会话句柄，不靠目录扫描、标题或最近文件猜测身份。

- AgentMux Hook 的安装、读取、更新和卸载必须只作用于 AgentMux 自己的受管配置作用域；Provider 的共享配置文件仍保留用户和项目已有条目，不能把 AgentMux Hook 当成共享默认值。
- Hook 事件必须携带并校验 AgentMux Session/Run 关联身份。没有该关联、关联不匹配或无法确认来源的 Provider 事件不得触发 AgentMux ingress；应记录可诊断的降级事实，不影响外部 Provider 会话继续工作。
- Hook 探测、合并或安装失败属于流程问题时，健康 Agent 继续可用；服务窗说明哪一步未完成、当前按什么能力运行和恢复动作。只有 Agent/进程本身明确终止才允许阻断。
- Doctor 必须逐 Provider 如实报告 Hook 安装策略，包括不受管与无 Hook 的情况；Runtime 不可达也不能把这些策略改成全局默认值。策略声明不代表磁盘配置已安装，实际磁盘安装状态是另一项事实，不能混在同一字段中。
- **Hook 安装状态按这次实际检查判定**。公开 Core 在明确 Provider、Workspace 和执行环境作用域内新读受管配置，报告 installed、not_installed、partial、error 或 skipped，以及检查时刻、范围、原因和恢复动作。文件存在、过去回执、安装策略、整文件格式差异或未核实的原生 enabled 都不能代替完整且当前的受管定义及必要加载/信任事实；未查成不能叫未安装。检查不注册安装 intent、不修配置、不执行 Hook，不复制 Provider 的路径/事件/所有权事实。
- **Doctor 不能先修好再冒充原本已安装**。其真实 CLI 入口先做连接前的只读点时检查，再保留普通连接及明确执行环境下的启动／恢复修复；明确标注检查阶段，后续修复不能倒填结果。Runtime 不可达或一家 Provider 失败仍保留其他逐 Provider 检查，健康 Session 和输入继续可用；输出不含配置原文、完整命令或凭证。

### A2A 身份信封与持久化全局消息队列

- **验收修正：发送成功必须意味着收件 Agent 实际收到可读来源和原始正文，且 Core 已按真实 Session/Run 与已解析目标核验身份。** CLI 环境变量只是身份线索，不是权威；Desktop 不得忽略结构化来源后只投递裸正文。可读表达归下节约束，目标的完整关联留在持久事实中。Control requestId 仍只作请求关联；同一消息的重试必须复用稳定的消息身份。
- **持久队列的唯一写入权属于 AgentMux Core。** 同一路径即使遇到多个进程或多个对象并发，也必须保持全局唯一、递增的顺序号和可重放的完整记录；队列所在位置不得受 ctxmux 版本化临时端点回收影响。失去持久写入确认时明确拒绝入队并告知状态，不能宣称已投递或判定健康 Agent 死亡。
- **身份授权必须在 Core 里完成，不能把 `AGENTMUX_AGENT_SESSION_ID` 或 Control caller 字段当凭证。** 受管 Agent 的 send 必须携带当前 Run 的 invocation capability，由 Core 核对 capability hash、Session 和 Run；没有 capability 或 capability 属于旧 Run 的请求必须拒绝，健康 Agent 仍可继续工作。
- **队列写入必须能从写入者崩溃中恢复，且回收不能碰掉新写入者。** 同一路径的跨进程排他性以系统可随进程退出释放的事务锁为准；遗留的孤儿 `.lock` 文件不得阻断新写入。并发恢复后每条消息仍只能占一个唯一、连续的顺序号，健康 Agent 不能永久收到 backpressure。
- **相同 `messageId` 是重试的幂等身份，跨新的 Control request/operation 与 createdAt 仍返回原 receipt；冲突正文、目标或来源必须拒绝。** Region/Tab 只是寻址输入，落盘 envelope 和收件信封必须写入解析后的真实 recipient Session/Run。
- `agentmux send` 的消息必须带可验证的来源、目标和 AgentMux Session/Run 关联事实；这些事实来自 Core 凭证和会话上下文，不得从 View、Region、标题或正文猜出。`requestId` 只标识 Control request，不能充当 `messageId`。
- 全局消息队列由 AgentMux Core 独占持有。消息记录 append-only 且不可变，至少保留 `messageId`、版本化 A2A envelope、`createdAt`、sender/recipient、workspace/session/run 关联、thread/correlation/replyTo、顺序号，以及独立的投递状态变更和失败原因；消息本体和投递状态不能因空快照、握手超时或重启被清空。
- 队列重启后必须可 reopen/replay。consumer 游标与 ack 带 generation fence；重复检查可安全重放，迟到或旧 generation 的 ack 必须失败而不能推进新一代游标。相同 `messageId`/operation 的重试必须幂等。
- 队列必须有界并明确背压或拒绝码。无法确认 durable append 时不得返回已入队；Store 短暂故障按服务窗降级，不能把健康 Agent 误判为死亡，也不能静默丢正文。正文原样保留，可读来源只是展示，不是认证。

### 破坏性 Browser 操作的作用域与人工批准

- 清理 Profile 数据、删除 Profile 或登出等不可逆操作必须带明确的操作作用域；本轮最小闭环只允许用户删除一个指定的非默认 Profile，不能把整个 Browser 或所有 Profile 作为隐含范围。
- 破坏性操作必须经过用户在当前界面明确确认。调用入口传递结构化批准事实（操作、作用域、目标 Profile），主进程再次校验目标未被打开的 Browser 使用、不能是默认 Profile，并拒绝缺少批准事实的请求。
- Agent 浏览器自动化不能借用人的 UI 确认；没有专用的人批准事实时必须返回类型化拒绝，健康 Browser 与其登录态保持不变。

### A2A 消息要让人一眼看懂

- 用户原话：「`from="local-cli" to="765ae7ef-b886-4681-b9b5-0bbc561e8f1a"`，from 和 to 的语义完全不同；amux 中包 JSON 太奇怪了；冗余信息也多；人类完全不可读」「现在的 agent id 设计太长了，非常浪费」。消息里表示发送者和收件者时，两端必须是同一层的参与者身份；`local-cli` 是进入系统的通道，不是一个人或 Agent 的身份，不能占据 `from`。通道、已核验身份与未核验来源必须分开表达；无法核实发送者时如实标未知，不能猜成某个 Agent。
- Core 的持久消息事实与投递回执供机器审计和重试；投递给 Agent 的文本只保留完成交流所需的来源、正文，以及确有回复需要时的简短引用。不得把整个回执 JSON、`requestId`、`queueId`、Run ID 或一串重复的 Session ID 自动塞进可读消息。正文若本来就是发送者写的 JSON，仍按原文保留，并明确它是正文，不让它看起来像 AgentMux 协议层。
- 用户明确选择「持久地址也缩短，从防撞目标出发，不用这么长；还要支持类似 Git 的部分 hash 寻址」。新建 Agent Session 的**持久 ID 本身**应缩短，而不是给长 UUID 再套一层别名；长度由明确的碰撞概率目标决定，不靠“看起来够短”。同一完整 ID 重启后仍指向同一 Session，已存在的长 ID 保持原身份并可恢复，不为缩短地址重写它们。
- 防撞目标是在一千万个 Session 下，任意两个新 ID 碰撞的概率低于万亿分之一；字符必须能直接用作 CLI 参数与持久引用。新 ID 的前缀同样不能被误当作另一项命令选项。
- 新建 Agent 的每一个短 ID 都必须符合创建、持久化、浏览器客户端与 CLI 的同一套合法地址约束，不能因为随机生成了某个首字符就偶发创建失败。地址本身满足约束，不要求调用者修饰、改写或重试地址；已有身份不改写。
- 所有以 Agent Session ID 寻址的 CLI 动词都应接受唯一前缀：只在当前权威 Session 集合中恰好命中一个 ID 时解析；零命中或多命中明确报错，绝不能按最近活跃、标题、View 或位置猜一个。前缀是便捷输入，不是另一个持久身份；新 Session 出现后旧前缀可能变成歧义，但不能静默改指向。Core 拥有铸造、查找和碰撞判定，Renderer 只展示权威结果。
- Demand 的关联 Session 和 PMO 的混合 Session 筛选可以包含普通 Terminal，归现有通用 Session 入口所有；不得拿 Core 的 Agent 集合拒绝这些完整引用。只有领域明确要求 Agent 的入口才做 Agent 前缀解析。
- 一条消息在收件 Agent 和人类阅读面上只有一份简洁的表达；机器回执留在命令结果/审计入口，不作为消息正文再转发。可读信封只是展示，不是认证；发送授权仍按上节的 capability 与 Session/Run 事实核验。

### Terminal 连续向上阅读历史

- **输出安静后也必须完成耐久化（，P0）**。ctxmux 已读取的仍可保留输出不能因为最后一块遇到持久化队列背压，就永久等下一次输出才提交。持久化健康时，队列恢复可用后原尾段须自行收敛到真实 durable 水位；不得要求用户再打字、改变尺寸、退出或升级来补写。自然安静收敛与显式交接 flush 分别证明，FIFO barrier 只确认已经入队的字节，不能把未提交尾段或未知来源伪装成已耐久化。补写工作只随确有未提交输出的 Run 和原字节增长，不扫描无关会话、不阻塞共享 PTY 读取；原保留范围、真实存储失败、健康输入与安全交接边界保持。
- 用户在新版安装后再次反馈「现在我往前滚还是不行」。必须以实际安装工作面里仍保留内容的可阅读性为结果：持续输出、重绘、布局和输入模式变化时，双指阅读仍须可用。安装成功与私有样例通过不能替代这一结果；未观察到的现场缓冲区、模式和事件路径如实保持未知，不能用保留上限解释掉显示故障。
- 用户进一步确认双指滚动时「画面完全不动」，同时反馈「打字输入也卡」。阅读与输入应在持续输出和后台活动中保持响应；滚轮是否进入终端协议与界面线程是否繁忙分别按实际状态判断，不能把输入卡顿归结为没有历史。用户再次明确「Mac 的触控板上双指往下滑，整个 TUI 没有任何反应」：原始输出保留容量与事件接线分别验证，回滚行数为零不能证明滚轮已经到达，人工逐行输出可滚也不能替代当前 TUI 的现场验收。 用户进一步反馈「只要是 Codex 的好像就滚动不了，Claude 的没受影响」：不同 Provider 的实际终端模式、事件接收与原始输入路径应分别核对，不能把一种模式的验证推广为全部终端通过。故障定位不得写入或重启健康 Run，处理成本只随当前视图和真正相关的变更增长。
- 用户补充「其他打开的 session 好像可以滚动，但也很卡」。跨 Session 的输入与阅读响应单独验收。全局浮层观察只应处理应用根之外的真实浮层及其加入、退出和开关变化；终端、编辑器、时间线在应用根内的正文重绘不得产生浮层观察工作。已有空容器后挂内容、嵌套浮层和退场动画仍沿同一 DOM 协议处理。
- 用户的原始终端输入不能被可选屏幕确认占住；等待确认期间的滚轮、打字与手动 TUI 操作应及时取得原输入通道。已接受的消息仍必须按原协议完整、有序提交，不能穿插字节或破坏幂等接收；未完成的观察如实说明，不能伪装为确认成功。观察的时间与取消边界覆盖从读取服务握手到确认结束，不能在开始计时之前无限等待。
- 同一健康 Run 经另一公开 Client 接受输入后，新滚轮或打字不能因本 Client 的过期输入游标被我们丢掉；新原始输入与空输入的无操作结果，以当前 Run 公开确认的真实输入游标为准，不拿旧缓存、补零或数值较大者冒充权威事实。已冻结的 semantic／Native 请求仍保留原身份、字节与范围，未知接受结果不能重放。读取当前事实后仍可能发生真实写入竞争，拒绝或未知须如实说明，不能声称已经接受；缺少游标也不能被解释为 Agent 本身失败或新增健康输入门禁。空输入没有实际接受字节，原生游标未知时其范围和已接受水位必须明确为空值，不得用缓存或补零伪造确认。
- 对一个明确 Region 的只读检查应能取得其当前终端投影：视图网格、缓冲区类型与保留行位置、鼠标上报模式及当前输入门。投影由实际 TerminalView 的公开终端事实按需读取，不解析正文、不写输入、不触发恢复或尺寸同步；它不是 ctxmux 的权威尺寸或 VT 状态。未取得投影时明确保持未知，不猜未挂载或健康。观察只随所请求的 Region 增长，组件结束后不得残留读取其终端的引用。
- 用户明确反馈「单纯的无法往上 scroll」，使用 Mac 触控板双指滑动。当前已有内容的滚动必须独立于历史保留边界判定：普通缓冲区的保留行应能正常向上／向下阅读；程序接管滚轮的 TUI 应收到与实际归一化滚动距离相符、保序的原生鼠标或方向键输入，不能把多行距离压成一次。标准滚动值非零时，不能被同轴为零的旧事件字段吞掉。
- 滚动由终端库的既有缓冲、协议与事件 owner 裁决；修复保持原有方向、修饰键、精细滚动的分数累积和只读／待答交互边界。TUI 只拥有当前屏幕时，反馈沿其真实滚动行为，不伪造终端历史；滚动修复的验收必须观察固定网格下的视口移动或 TUI 实际内容变化，历史分页通过不能代替这项验收。

用户反馈「terminal 只能往上滚一点，应该可以一直往上滚」。用户向上阅读时必须能连续到达当前会话仍可用的历史，新输出、尺寸变化和切换工作面不能把阅读位置反复拉回底部或丢掉已有历史。输入、PTY 和原 Session 保持可用，明确回到最新输出才恢复跟随。

正常屏幕与全屏应用的 alternate buffer 按协议区分：不能把滚动手势暗中变成 Agent 命令，也不能把重绘帧伪造为对话历史。恢复和积压处理不得因界面自己的小窗口把 Runtime 仍保留的历史当成不存在；Runtime 确已淘汰的字节、终端行缓存边界或应用自身的全屏历史能力必须准确说明，不能声称无限历史、不能新增第二份 Runtime 输出账本。

用户在安装后再次反馈「还是无法往上滚动」，并追问「这个终端限制来自哪里，agentmux 还是 ctxmux」「终端限制就一定读取不到吗，比如是否有持久化」。视图的行缓存、ctxmux 的原始字节保留与 Provider 的持久会话记录是不同的能力边界；一个边界不能被当作其他历史也不存在的证据。仍在磁盘上的会话记录必须有诚实、可达的阅读方式，说明内容来源与完整性，不能伪装成原始 PTY 回放。

终端重新附着时，只有连续字节或可信的运行时状态才能支持屏幕和输入模式的恢复。完整 TUI 续接状态由 ctxmux 持有，并与原始输出字节和确认尺寸按同一权威顺序交付；Core 只公开投影，Desktop 只消费，不能各自补一份模式或解析器真相。屏幕导出、会话消息历史与完整解析续接是不同能力，来源缺失时继续按未知说明。从中途保留的字节开始解析，不能把解析器的默认模式当作原应用的当前模式，也不能按 Provider 名称猜测并强行开启鼠标或 alternate buffer。模式无法确认时明确说明，保留原 Session、输入和工作面。 续接能力按实际支持的终端协议声明范围：正常回滚、全屏应用的原生滚轮、真实鼠标编码和字节／尺寸顺序必须完整验收；未支持的扩展状态如实说明。局部扩展缺口不能阻断已验证的基础输入与阅读，也不能把基础画面导出称为完整协议续接。滚动交付必须绑定实际界面的缓冲区、真实滚轮事件和阅读到的历史范围；纯解析器与直接调用滚动方法的测试不能替代它。

终端快照的局部存储失败或告警通道关闭，不能拖死共享持久化线程、阻断其他终端创建，或拿走健康 Run 的输入。后台启动、运行和原地交接的正常提示与可恢复告警同样不能因日志接收端已经关闭而终止 daemon、删除原 endpoint 或中断健康 Run；日志不是生命周期判据。快照是否可信仍由 Runtime 的字节边界、存储与交接事实判定；告警写入成功与否不能改变这个事实，也不能代替真实的数据错误结果。此前可用的工作面和 Run 保留，缺失的续接能力按本节的服务窗边界表达。

重连后的终端仍留在原工作面，按 Runtime 的同来源快照恢复真实画面，再继续接收实况。不能把最后一次尺寸伪装成中途某个字节位置发生过的 resize，也不能把一段原始字节存在等同于其间尺寸历史已知。只有字节来源的消费者继续拿到原始字节；缺失的历史尺寸明确按未知说明，不捏造丢字节或尺寸边界。重新绘制已活着的终端不得禁用健康 Agent 的输入；快照种子不算原始输出、ACK、新帧证据或 PTY 输入，历史回放也不得重复触发通知、剪贴板或终端查询回复等副作用。重连快照的来源未知或暂不可用时，保留已有画面与健康输入，持续说明“断连期间终端状态未能续接，显示可能不完整，会话仍在运行”；缺少尺寸顺序的历史尾段不绘入旧网格，不伪造完整恢复。Runtime 快照确认的输出边界和当前尺寸可用于继续接收其后的新输出；跳过无法证明尺寸顺序的历史范围不能算已阅读、已消费或已确认的字节，也不能引发原始字节回补后冒充画面恢复。只有取得可信续接状态才能消除这个未知。


Runtime 的既有地址与持久状态归属不随构建版本改变。打包或安装终端后台更新时，必须接回原 Runtime 和健康 Run，不能因产物摘要变化另起一个空 Runtime，再把旧会话报告成未知或要求重新启动。后台更新的接管身份、协议范围与失败结果按实际交接事实验证；未完成交接不能宣称旧 Run 已保留。进程和应用目录替换的真实安装行为也属于这个验收边界，私有原地二进制替换成功不能替代它。

**第一方界面与 Native 更新分别提交**。公开协议和所需能力满足时，界面可以接回原服务，不能因为后台升级安全尚未确认而停止健康 Run、另起空 daemon 或新增输入门禁。界面与后台分别报告实际提交、失败或未知；后台未提交时明确暂缓，保原地址、持久状态、归属记录和仍在使用的旧 Native image，不把界面更新称为后台升级完成。

安装时若没有正在服务的界面，不能因为读不到不存在的旧界面而阻断正常冷安装。新界面仍沿原持久化工作面恢复并核对实际加载身份和 serving Runtime；没有旧工作面的完整观察时明确说“界面已激活，完整恢复核对未确认”，不能伪造空基线或把未知称为完整保留。界面在切换前重新出现时保留原安装；仍活着的界面的退出风险不能被归入冷安装。安装观察的缺口不增加健康输入门禁。

界面激活后正常出现的新 Renderer、GPU 和 utility 不能因为不在启动瞬间的 PID 名单里而被误称旧实例。新进程归属须来自本次实际加载的 Main、操作系统父子与出生事实；原 serving 实例仍持有旧映像时继续拒绝替换成功，不能忽略 helper 或只看磁盘目录。归属观察不足如实报告未确认，不因此关闭已经可用的新界面或干预健康 Run。

随包产物与实际 serving Runtime 分别表达：随包身份来自已校验的产物，实际服务身份只消费公开确认的事实。没有实际服务的源码提交证据时保持未知，不从随包 commit、版本字符串或地址猜来源；归属未确认只限制清理权限，不等于协议不兼容。旧后台的持久化或日志故障仍如实说明，实际输入未确认或被 Native 拒绝时不能称已可用或已修复。

界面更新本身必须保原 Tab、Group、Region、布局、焦点与 Browser 描述符，资源释放不能变成用户关闭 Region。退出资格绑定真实 outgoing App，旧版退出失败、Browser owner 未知或资格不足时不执行真实替换，不强杀、不补写布局、不用 HUP 试探；新候选的安全释放不能替旧进程取得资格。候选界面实际加载、接回原服务并能访问原工作面后才算界面提交，进程出现不等于成功。后台未提交时，目录切换或界面激活失败仅恢复已合格的原界面；无法确认恢复则明确 unknown 并保留两份产物。后台已确认升级后，不退回不兼容的 client；当前用户旧实例尚未证明安全的限制不得隐藏。

运行中界面观察只读本次实际加载的 Main／Renderer 身份和一次完整工作面元信息，保留尚未 attached 或暂缺 Session 的 Region；不读取正文、不连接 Runtime、不刷新或写盘。界面早期 ready 与 loading 结束不是恢复成功，跨导航或预算不足如实不可确认。界面独立更新只以候选 Core 的同源公开纯判据核已选 listener 的协议能力，不把归属未确认当不兼容，也不据此取得后台升级或旧界面退出资格。

界面独立更新的健康 Run 保留核对只绑定 Native 当前确认仍在运行、且被原完整工作面引用的 Run；历史引用的 Native Run 已不存在，不能阻断健康服务的界面更新，也不表示 AgentSession 退休或允许删除原 Tab、Group、Region、Browser、布局与焦点。完整历史工作面原样保留；真正需要保护的原 Run 仍须按同一实例、精确 ID、PID 与字节边界复核，未知或其他读取失败如实表达，不能放宽后台升级资格。

持久会话历史在原 Session 的工作面内阅读，来源与终端回放明确区分；进入与退出阅读不能重建终端、发送应用按键或改变 Run。向上读取更早页保留正在阅读的项目及其位置，每次读取有界且只有一项在途；失败保留已读内容和输入，并提供重试。消息正文、交错的图片／音频／资源引用按来源保留，无法预览的引用如实显示；没有记录的时间和状态不得补造。Core 提供与 Provider 无关的分页接口，Provider 持有原生读取协议；Desktop 不解析厂商文件、不维护第二份历史账本。

用户进一步要求「复用每个 provider 提供的 session 解析能力，以及我们的对话模式组件」「即使那个对话模式组件实现得不好，要优化的话，应该也是先去优化这个组件」。原生会话协议与记录解释只有对应 Provider 一个 owner；已经存在的读取／解析能力应被复用，缺少完整对话读取能力时明确说明，不能把用量统计或实时事件解析当作完整历史。历史与实时对话中的同类消息使用同一消息组件；说话人、正文、资源、链接、复制与未知元数据的呈现只定义一次。组件的不足在这个共同 owner 上改进，历史入口只持有读取窗口与阅读位置，不能另造一套消息渲染、身份或时间事实。改进仍保持上述原工作面、终端行为与健康 Run 约束。

用户明确要求参考成熟项目的既有实现覆盖所有已接入 Provider 的原生会话阅读。记录来源、身份、内容及资源顺序由对应 Provider 解释，client 通过同一公开接口阅读；参考实现已经支持的能力不能因未接线而被报告为不存在。确实缺少读取途径或格式依据的 Provider 必须单列缺口，不用未核验的解析结果或静默降级补齐能力清单。

用户进一步要求「注意代码品位」「发挥全部水平，成熟产品级别，高级、优雅、简约，所有功能自己测试满意」。Provider 的会话分析、对话模式与 trace 必须沿原生协议闭合到真实产品调用；内容顺序、主会话身份、恢复、长对话阅读和资源边界分别有真实验证。原生事件的同名不等于同义：依赖负载才能区分的收尾、取消、普通通知与子主体必须由 Provider 声明真实语义，不能把所有通知画成工作中，也不能让子主体覆盖主 Session。未知原生元数据如实缺席；不能靠猜测别名、默认成功、最近文件或额外运行时补齐。成熟度与竞品优越性是验收目标，只有绑定实际版本、同等任务与数据的比较证据才能报告为结论。

原生会话记录在活跃追加、半行尾部和一条记录包含多条消息时，向前分页仍须按同一读取快照连续返回，不重不漏。Provider 只解释原生语义，物理字节位置、文件身份、快照边界和重复读取同一记录由共享读取 owner 持有；不能在 Provider 外侧另算文件大小或改写不透明游标。游标只携带定位该读取快照所需的事实，不能随历史长度累积。

原生协议已确认本轮结束或取消后，用户可在同一健康 Session 开始下一轮；取消不能被画成成功完成，也不能因成功 completion 身份缺席而被提交门禁挡住。自动投递仍只消费真实成功完成身份。结束事实必须属于当前 Run、晚于已消费边界，并在下一次提交后被消费；普通通知、旧回执、未结束的工作和未回答交互都不能放开提交。重启后沿同一持久事实恢复这些边界，不增加第二份状态账本。

Hook 修复必须使用当前操作明确提供的 Executor 执行环境，作用于该 Agent 实际读取的配置目录。普通连接只恢复既有 Hook 绑定，不得在没有执行环境时向默认用户目录重新生成配置；具有明确执行环境的启动与会话恢复承担受管定义的校正。两个 Executor 即使使用同一 Provider 和 Workspace，其不同配置作用域也不能被合并。修复失败保留健康 Run、原工作面和输入，并持续说明失败步骤、运行状态与恢复动作；未知作用域不能被当成默认作用域。自动化验收的 Runtime、配置目录、消息队列与 Session 存储必须隔离，并核对其实际子进程边界。

用户明确指出「往前翻的能力」和「提供 history 的查看」是两件事，两件都要做好。终端滚动与持久记录阅读分别验收；可查看原生记录不能充当终端滚动失败的兜底或完成证据，记录呈现也必须沿同一对话组件集中改进。

用户进一步反馈「往前滚动就会变成 history」「现在会切换界面，能不能做得丝滑一点」，并指出「当前这个 session 是活跃的，为什么也会往前滚动一点就进入 history」「只有那种落盘很久的才应该这样」。用户明确将「活跃会话本地可滚行少，history需要切换界面且和terminal样式差别很大」均视为不可接受。交付结果必须是活跃会话可以连续往前阅读，阅读保持同一工作面与一致呈现；本地缓存满不满不能决定这个结果是否成立。**活跃健康 Run 的向上阅读继续属于原终端，不因本地缓存触顶或可滚行很少就自动切到持久记录。** 终端行缓存到头不意味着会话长期未恢复；仅撤销自动跳转或打开可分页的记录页，都不能算活跃终端滚动已修好。程序接管鼠标或 alternate buffer、横向手势、修饰键及回放期间仍遵循原终端行为，不猜模式或发应用按键。

长期未恢复的会话沿《冷启动按需恢复》的既有判定保留原工作面，持久记录直接内联可读，不要求先跳进另一个 History 界面。该判定不能由标题、文件mtime、Terminal缓存大小或“没有输出”另算一份年龄，也不能把仍有健康 Run 的长闲置会话误当待恢复。查看记录、分页、滚动和草稿不触发恢复；执行时的恢复动作与进度沿原合同。持久记录有一个明确可达入口，阅读期间保持原Region、阅读位置、输入区与Run，来源变化只作紧凑说明，不以切换整屏和另一套阅读样式表达。读取失败保留工作面和已读内容，不把不存在的终端前缀或未知模式伪装为已恢复。

持久历史读取只依赖权威 Session 身份和原生记录来源，不以 Runtime 连接、Run 握手或恢复成功为前提；Runtime 暂时不可用时，已有记录仍应独立尝试读取。阅读动作不得顺带启动、恢复或附着 Run。

同一 Region 的持久会话历史只有一个固定可达入口；Runtime gap、终端行边界和全屏说明不再各自重复画同一按钮，服务提醒与真实重绘动作仍保留。用户报告“existing native history endpoint is unavailable”时，必须分清原生记录仍在与读取服务不可达，不能把另一个桌面应用偶然开启的控制 socket 当作独立核心包的历史能力前提。读取使用对应 Executor 的原生 CLI、环境及精确会话身份；Provider 拥有读取通道的取消、期限、大小边界和结束清理，不能用新增 Agent Run、另一份历史解析或双路径降级伪装成读取成功。

用户明确要求「terminal / tui 使用方面的，要修了就打包，这个会影响我现在的操作」。影响当前操作的修复在自身验证通过后及时打包安装，不等待无关功能收口；安装仍保留原工作面和健康 Run，安装成功与用户问题解决分别验收。

会话活动的处理成本应随当前变更增长，不能在每条已验证日志的处理过程中反复扫描、校验或序列化无关的完整历史。减少重复工作仍必须保留内容、顺序、去重、状态、版本与持久恢复的原有含义；局部优化与应用整体卡顿的结论分别绑定其实际版本、输入和采样条件。

用户明确将当前性能优化列为P0，并指出「一个会话的输出游标变化，会重写全部会话记录」不可接受。单Run的输出不能因无关Session、隐藏终端或其他历史数量而放大跨进程传输、解析、渲染和持久化成本。权威Runtime游标仍归ctxmux；AgentMux的语义持久状态只因真实语义事实变化写入，不能把高频运行投影的变化当作重写全部Session记录的理由。持久身份、原生句柄、已接受执行的语义证据及进程重启恢复不能为减少写盘而丢失。性能验收同时覆盖真实事件响应、相关owner的工作计数、磁盘写入与重启后的正确性，不能以节流隐藏积压或仅减少调用次数冒充交付。

Runtime 的持续输出写盘可以合并同一收集窗口内的真实追加，但等待窗口必须有界，不能被后来输出不断延长；生命周期、快照与持久化屏障到达时，先按原顺序提交此前字节，再处理对应事实。实况输入和显示不等待落盘合批；已收集或已显示的游标不能冒充已提交的持久游标。空闲 Runtime 不因这项优化新增轮询或逐 Run 定时任务，不扫描无关 Run／Session。收益与退化按同版本、同数据格式、同负载的写盘、CPU、延迟与恢复证据分别报告，不把上游或其他格式的数字当作当前交付结果。

终端持续输出的入队、裁剪与取批只处理本次新增或真正消费的内容；积压增多时，不能让每一块新输出反复扫描、复制整份待处理队列。正常连续批次只合成一次原始字节；只有恢复改变了接收边界时才重新裁剪。按原顺序保留快照、尺寸变化和真实缺口，积压上限与健康输入不因优化失效。

CPU与内存观测按Renderer、Main、GPU及ctxmux分别归因；样本绑定版本、采样窗口、活跃Session／输出负载与用户操作，避免把新启动短样本和长期运行样本混成同一结论。高频输出应先收窄真实消费者，再处理内容；一份原始输出跨边界传输不得因无关订阅者数量重复复制。缺少条件的用户样本保留为问题证据与优化优先级依据，不能补造其测量条件或把RSS增长直接称泄漏。

用户再次反馈「Renderer 的性能仍然差」，要求单独测量和优化。单个 Session 的更新不得让窗口壳和无关工作面一起重渲染；身份、状态衰减与资源回收只消费其判定真正使用的事实。Browser／Monaco 的回收不依赖 Agent 状态，不能因 Agent 活动重建其候选或重排期限。优化验收记录实际挂载入口的更新次数和相关变化仍可达的行为，不以隐藏界面、延迟正确状态或删掉恢复事实降低负载。 用户要求「无关会话不放大」：被当前身份、Run 或新鲜度规则拒绝的状态事件，以及没有改变任何投影事实的重复事件，必须保留原 Session 对象与集合引用，不能唤醒无关会话的界面消费者。真实的当前 Run 状态、观察时间、明细清除与其他投影事实变化仍须即时可达。

Agent 的状态、时间线等运行时投影变化若没有改变持久化工作面的输入，不得重复投影和序列化全部 Tab、Region、布局及草稿。已有相同内容的保存请求不得重置新草稿或布局的落盘计时；只有真实持久化内容变化才参与既有保存合并。启动写闸、恢复、删除、退出补写和写入失败仍由同一持久化 owner 处理，不能另建字段清单、历史账本或后台轮询。进程在保存期限后突然中断且未执行退出补写时，已到期的工作面和草稿仍须在新进程恢复。

### ordered bytes 的公开传输边界

「核心路径可用」「从根上保证正确」要求 Runtime 的原始字节穿过 Core 公开 Replay 和 Live API 后仍原样到达消费者。字节游标与裁剪只作用于同一份原始字节；UTF-8 字符、ANSI 序列可以跨事件，不能把已解码文本重新编码后冒充该事件的字节范围。终端使用平台已有的流式字节解析能力，客户端不新增字符游标或第二份输出账本。

Core 的语义文本供 Provider/readiness 等文本观察使用，与 ordered bytes 分工明确：一个事件的文本可以为空，也可以包含前一事件留下的字符尾部，不能由文本长度推断字节范围。CLI 的 ordered output 同样裁剪原始字节；JSON 输出使用明确的 base64 字节字段，Replay 与 Follow 保持同一种表示，不把解码损失冒充完整输出。不保留旧的文本裁剪兼容分支。

### Hover 提示不改变 Terminal 几何

用户反馈「现在 hover 的时候，terminal size 会变得有问题」。提示、菜单与其他浮层的出现和关闭只改变浮层本身；没有真实工作面尺寸变化时，Terminal 的容器边界、解析行列、Runtime 确认尺寸、阅读位置和 Session 身份必须保持稳定。原生 Browser 为浮层让位不能被当成 Terminal 的布局变化，不能因短暂不可见或浮层测量过程提交错误 PTY resize。真实分割、窗口尺寸与可见 Region 变化仍按既有权威尺寸合同同步；失败明确提示而不阻断健康 Agent。

### Topic 默认终端与可发现关闭

用户反馈：「Topic 里 Terminal 默认渲染两个且找不到关闭入口」。普通 Topic 的首次打开应形成一个可用 Terminal；重复点击、创建完成后的打开、恢复或不同投影的挂载不能凭流程增加第二个 Terminal Session 或 Region。用户主动分割、打开的多个终端仍按真实布局呈现，不能靠隐藏第二个终端、清空持久布局或删除健康 Run 解决默认重复。终端的关闭动作在当前 Tab/Region 附近可发现，并复用已有关闭/停止合同；取消或关闭其他 Region 不影响未选中的健康工作。重启先恢复既有分割与引用，不重新运行首次创建路径。
