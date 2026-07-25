# AgentMux Surface 与密度合同

> 产品交互与 Owner 边界见
> [`agentmux-desktop-interaction.md`](./agentmux-desktop-interaction.md)；导航与会话栏需求见
> [`agentmux-project-rail-navigation.md`](../plans/agentmux-project-rail-navigation.md)。

本文只保存当前视觉规则、密度预算和控件 Owner。历史实现步骤、来源记录、截图流水和过期数值不属于设计真相。

## 保护原则

- 保留 Graphite / Mint 与 terminal-first 的产品身份。
- 删除顶部空行、重复标题、线框拼装和低分辨率感。
- 描边不作为控件的主要视觉手段；Surface 填充、明度差、顶部高光和状态色承担层级。
- 一个身份层级只在一个主要位置可见；低频信息进入 tooltip、context menu 或 Activity。
- 视觉改动不得创建第二套 Agent、Terminal、Browser、Topic 或 Layout 生命周期。

## Surface 层级

| 层级 | Surface | 用途 | 边界规则 |
| --- | --- | --- | --- |
| S0 | `--bg` / `--surface-0` | Window 与 Pane 工作面 | 不用连续网格包围；分屏边界除外 |
| S1 | `--surface-1` | Project Rail、Tool Dock、Titlebar Plane | 用明度差和局部阴影分组，只保留 resize 或窗口分区边界 |
| S2 | `--surface-2` | Hover、工具内容块、搜索与局部 Toolbar | 默认无描边；交互时提升 |
| S3 | `--surface-3` | Selected、Segment、Badge、浮层按钮 | 小面积使用，不铺成整列 |
| Accent | Mint / Blue / Amber / Red | Focus、Host、Attention、Danger | 颜色表达状态，不兼任布局线 |

## 控件语言

| 层级 | 视觉语言 | 用途 |
| --- | --- | --- |
| Primary | 实心品牌绿渐变、深色文字、顶部高光 | 页面唯一主操作 |
| Secondary | 干净 Surface 填充、软高光、无常驻描边 | 次级操作与行内确认 |
| Ghost / Icon | 透明底，hover 才提升 Surface | 图标按钮与工具栏动作 |
| Selected | 单一几何信号；实心图标格或底部横条 | Project、Segment 与 Tab 选中态 |
| Danger | 实心红色变体、深色文字、顶部高光 | 删除、移除等破坏性主操作 |

补充规则：

- 同一语义在不同容器中使用同一控件层级。
- **选中态一律不用左侧竖条（inset 竖线）**。一条贴边的亮色竖线是"AI 生成的管理后台"最容易辨认的印记：它既不是填充也不是描边，只是一根贴在行左缘的装饰，在密集列表里连成一片噪音。选中由**单一几何信号**表达——干净的 Surface 填充，必要时配实心图标格。这条对所有列表行成立（Project Rail、Topic、Tree、Segment、Settings 分区），没有例外；`box-shadow: inset <n>px 0 ...` 这一形状不得用于表达选中。这条由 `apps/desktop/test/surface-selection-contract.test.ts` 守住：它从 CSS 推出所有水平方向的 inset 竖条并在选中态类名上断言其不存在，加回一条会红。
- **一列全同的图标不是信息，是宽度开销**。若某个列表里每一行的行首图标都相同（Topic 行的 Topic 图标、纯文件列表的文件图标），去掉它——图标的价值在于区分，无可区分时它只在挤压标题的可读宽度。行首位置留给真正有区分度的东西（状态、Provider 身份）或干脆留白。
- hover 提升 Surface 明度；active 用内阴影表达按下，不靠边框位移。
- 输入聚焦统一使用 `--focus-line` 与 `--focus-ring`。
- 圆角只使用 `--radius-sm`、`--radius`、`--radius-lg` 三档，**两类例外据实开放**：其一是紧凑交互控件——24px 图标按钮、Tree/File Row、Tab 与 Region 的关闭键、pane 动作等在 6px 下会显得过圆，故取 4–5px；其二是微标与装饰件——状态点、hairline 轨道、ruler tick、图标裁角、选中标记等取 1–3px。例外只对**这两类**成立：面性容器（卡片、菜单、弹窗、输入框、工具坞）一律走 token，不得因为"看起来更合适"而硬编码。这条由 `apps/desktop/test/surface-radius-contract.test.ts` 守住：它从 CSS 推出所有低于最小 token 的圆角并核对是否落在已声明的例外清单内，新增一个未声明的硬编码圆角会红。
- Tab 选中态使用轻微背景和底部 2px 横条，不使用顶部高光或整圈描边。
- Composer 表面同样不使用描边：它靠比所在 Region 高一档的 Surface 填充与顶部高光界定自己，四周 margin 与紧邻其上的审批卡片一致，读作工作面的一部分而非浮在上面的盒子。这也消解了卡片刻意不用描边的那条理由——两处不再争夺同一条边界。去掉常驻描边后 focus 不再能寄生在 `border-color` 上，故由 `--focus-ring` 加一道 inset `--focus-line` 独立承担，可见性不因"更平"而退化，且内阴影不改变盒模型、不引起布局位移。

## 身份归属

| 位置 | 主要身份 | 不应重复的内容 |
| --- | --- | --- |
| Project Rail Row | 选择了哪个 Project、Host、活动数 | 完整路径与 Session 详情 |
| Topbar Breadcrumb | 当前主区 Workspace 与 Branch | 完整绝对路径 |
| Tool Dock Header | 文件树根与可见路径 | 第二个同义图标或重复 Breadcrumb |
| Session Tab | Session 名称、Provider、状态 | 第二条 Session Info Bar |
| Tooltip / Context Menu | Session ID、Host、开始/活动时间 | 常驻占用内容高度 |
| Activity View | 最近消息和结构化事件 | Terminal 上方的重复摘要 |

## 顶行与 Tabbar

- Projects 与 Workspace tools 两个固定开关位于 macOS 红绿灯之后，只用 active treatment 表达开合，不翻转图标方向。
- 单 Pane 时根 Tabbar 与窗口顶行合并为 36px；分屏时使用 36px 全局 chrome 行和每 Pane 31px Tabbar。
- Tool Dock header 与相邻顶行对齐。非交互品牌标记不进入功能按钮组。
- Tab DOM 始终保留在自己的 Pane owner 下；顶行合并不得改变 DnD、split 或 focus 的状态归属。
- Agent/Terminal Pane 不显示 Session Info Bar。Stop Run 进入 Tabbar；Recent message 回到 Activity。

## 密度预算

| 对象 | 预算 | 说明 |
| --- | --- | --- |
| Titlebar Plane / root Tabbar | 36px | 与窗口顶边和相邻 header 对齐 |
| Pane Tabbar | 31px | 分屏 leaf 的紧凑索引高度 |
| Project Rail Footer / Corner Badge | 32px / 28px | Footer 只容纳两个 24px 图标入口 |
| Explorer / Branch Header | 32–34px | 不形成第二层大 Topbar |
| Tree Row | 24px | 保持键盘扫描和专家密度 |
| Tool Dock Width | 默认 300px；最小 236px；最大 440px | 同时容纳 Explorer / Branches，保留主工作面容量 |
| Tool Content Padding | 8–12px | 仅用于局部卡片，不包住整栏 |
| Context Menu | 176px 最小宽；26px Row；8px 横向 Padding；5px 容器 Padding | 全部 Context Menu 共用一套基座。Surface 填充 + 阴影 + 顶部高光建立层级，**不使用描边**；hover 提升明度并把图标转为品牌绿；破坏性项 hover 保持红色语义，不被绿色 hover 覆盖。菜单从指针处生长（120ms），表明它是这次点击召唤出来的，而非盖在界面上的一层浮层 |
| Activity Log Row | 24px Row；20px 节点槽；56px 等宽时间槽；12px 横向 Padding | 与 Tree Row 同一节奏。整列共用一条 hairline spine，节点用填充光晕挖空它而非画环。展开内容与该行标题同一左缘（104px），不得比自己的标题突出。**仅**机器上报（tool_call / permission / lifecycle）走这一寄存器 |
| Scratch Topic Row | 标题 11px 与 Agent 头像同一行，摘要 10px 次行；头像 18px 成簇靠右、3px 间距 | 一行只回答**这个 Topic 里的 Agent 现在怎么样了**。**Agent 呈现为一组头像而非一排抽象点**：缩小的 Provider 图标给出身份（这一行里跑着谁），**状态由头像边框表达**而非另加一枚色点——同一枚方块同时承载身份与状态，避免"点讲状态、文字讲身份"要求用户读两处。边框色沿用共享状态语汇（`status--<state>` 加 AttentionCategory），一个状态在哪儿都是同一个颜色。悬停有 macOS 导航栏那种轻量抬升，配 tooltip 给出名字与状态；点击直接定位到该 Agent，走全局同一个 `selectSession`。**不重复呈现同一事实**：既然逐个 Agent 已经在场，就不再另给一个 `N agents` 计数；既然当前项整行高亮，就不再另挂一枚 `Current` 文字标签。没有 live Session 的协作者如实显示 disconnected，不假装在跑。**行首不放 Topic 图标**——一列全同的图标不携带信息（见控件语言）。**选中态是干净的 Surface 填充，不用左侧竖条**。行上只留"定位到目录"一个高频动作，改名收进右键菜单。**顺序可由用户拖拽决定**，复用 Tab 条同一套 sortable 与键盘路径；用户顺序是一份偏好而非真相来源——磁盘上没有的 Topic 不会因排过而出现，没排过的保持彼此既有次序落在后面，新建的不会跳到不可预期的位置 |
| Activity Turn Row | 与 Log Row 共用同一 spine 与 20px 节点槽（14px 图标）；正文 13px/1.6 用 `--text` 主色，caption 11px `--text-3` 大写，时间移到行首右侧的 mono 戳；上下各 6px 呼吸 | user_message、assistant_message 两个可读回合脱离 24px 机器寄存器：正文是主体不是 payload，永不裁剪、永不折叠。User 正文用 `--surface-1` 圆角填充建立起止边界（描边不作手段），Assistant 正文在 S0 上流动。native-hook 的 assistant 回合不进入折叠 |
| Activity Turn Prose | 标题全部 13px（与正文同号）靠 600 字重与上下留白分级；表格 4×9px 单元、hairline 行分隔；引用块左缩 9px 配 2px 竖线；水平线 1px | 对话回合的正文渲染 GFM 子集：标题、强调、删除线、行内与围栏代码、有序/无序含嵌套列表、表格（含列对齐）、引用块、水平线、链接。**多级标题字号完全相同**——密度合同对字号设下限并禁止用尺度买层级，故 h1..h6 只靠字重、颜色与留白区分，绝不放大。解析器（remark-parse + remark-gfm）只产 mdast **语法树、从不产 HTML**：节点映射为 React 元素，`dangerouslySetInnerHTML` 从不出现，因此不可信的 Agent 输出**没有东西需要 sanitise**——风险面是构造性为零而非"已过滤"。raw HTML 节点按字面文本呈现，绝不成为标签。宽表在自己的 `overflow-x` 容器里横向滚动，不得撑宽回合、更不得让整个 feed 横向滚动。链接渲染为 button 而非 `<a href>`，经既有 openExternal seam 打开（不可信输出里的 `<a>` 是导航逃逸口）。只在 turn register 渲染；机器行保持纯文本，纯文本也不进解析器以免重排从来不是 markdown 的句子 |
| Activity Ruler | 顶部 sticky；18px track | tick 按真实经过时间比例定位——密集事件自然聚簇、长思考自然留白。首末时间戳无跨度时退化为序数轴并用虚线明示，不得让间距宣称数据没有的精度。ruler 可交互，三项均由**同一个双向纯映射**（像素位置 ↔ timeline 位置）驱动，不各自重算：**点击**跳到对应事件（落在两事件之间时就近取一个**真实事件**，绝不插值出不存在的时刻），并有键盘等价路径与可见 focus；**可视范围**在 track 上框出日志当前看到的那一段，来源是真实可见区域；**悬停/聚焦**读出该位置的具体时间，锚定不遮挡它所描述的那段 ruler（沿用终端链接预览的同一条规则），且不改变选中状态。**零跨度时三者全部退化为序数语义**——只说"第 N 个事件"，不显示也不暗示任何时刻；这条由返回类型强制：ordinal 变体在类型上就没有承载时刻的字段，因此伪造精度无法通过编译。可视范围的更新**不在滚动热路径上**：由观察式 API 驱动而非每帧 scroll 处理器，一条阅读用的装饰不该成为滚动卡顿的原因。范围为空或日志短于一屏时不画占满全宽的假框（那会读作"什么都看得见"）|
| Tool Dock Header | 30–34px；10px 左缩进；24px 图标按钮 | 各工具坞标题共享同一左缘。分屏时上下堆叠的标题必须对齐，近似对齐比不对齐更伤观感 |
| Agent Attention Bar | 24px 高；横跨整宽；12px 横向 Padding；12px 段间距；11px tabular-nums | 窗口底部唯一的跨会话注意力汇总。`surface-1` 填充 + 顶部高光 + 一条 hairline 顶边界定它，不使用描边。复用共享状态点语汇，计数为零保持中性灰；栏存在时把折叠的 Rail 角标抬高让位，纯 CSS `:has()`，不耦合 JS |
| Agent Provider Catalog | 142px 最小列宽；44px Card；最多 268px 高 | 容器独立滚动，不扩大 Launcher |
| 操作与元数据文字 | 11–13px；微标不低于 10px | 不用 7–9px 冒充密度 |
| Terminal / Editor | Terminal `12px / 1.0`；Editor `14px / 21px` | 由 xterm/Monaco 原生 DPR 渲染，不使用 CSS transform |

## Owner

| 控件 / 状态 | Owner | 下游行为 |
| --- | --- | --- |
| `projectsOpen` | Renderer Store | 只展开或收起 Project Rail |
| `toolsOpen` | Renderer Store | 收起或恢复同一个 Workspace Tool Dock |
| `workspaceTool` | Renderer Store | `files-branches / agents / browser-favorites` 三选一 |
| `toolDockWidth` | Renderer Store | 拖拽中更新 owner DOM，结束时写回唯一状态 |
| Explorer / Topics | Workspace Tool Panel | 枚举真实文件系统并打开到 Focused View |
| Agents | Workspace Tool Panel | 投影现有 Agent Session，不创建第二 Registry |
| Browser Favorites | Workspace Tool Panel | 只路由 Main-owned Browser View |
| Agent Launch | Universal New Tab / Topic Launcher | 通过 Core 创建 Session，不属于 Tools 状态 |
| Branch Board | Board Surface | 投影 Project Scope、四列状态和真实 Run 数量 |
| Titlebar drag | Titlebar Plane | Breadcrumb 可拖拽；按钮、Tab、输入区全部 no-drag |

## 响应式与可访问性

- Tool Dock 变为覆盖层时仍消费同一宽度和开合 truth，不复制移动端状态。
- 每个图标按钮必须有 tooltip、`aria-label` 和可见键盘 focus。
- Tab 名称始终单行；过长省略，空间不足时由 Pane 内横向 overflow 解决。
- Surface 明度和状态色必须保持足够对比；不可只靠颜色区分选中、危险或不可用。
- 共享状态点（`.status--{state} .status__dot`，StatusDot 与 Attention Bar 的 StatusCount 同源复用）中，"需要你"（`waiting`/`blocked`）必须带**形状**而非仅靠颜色：琥珀圆点内嵌 `?` 字形，使其在色盲与快速一瞥下仍与其他琥珀含义可辨。`disconnected` 是掉线而非请求关注，从琥珀让出、改用中性空心环，令琥珀唯一地表示"需要你"。5px 角标（Tab 角、Rail 行）容不下字形也无需字形——颜色加角落位置已足够区分，字形只在全尺寸状态点上浮现。

## 验收

- Production Electron 验证真实 DOM 尺寸、DPR、Canvas backing、Tab overflow、拖拽落点与窗口 drag/no-drag。
- 单 Pane 与分屏都不得出现重复 Topbar、第二条 Session chrome 或工具栏遮挡。
- Rail 与 Tool Dock 的四种开关组合都保持固定顶部按钮、正确内容起点和可操作角标。
- Terminal、Editor 和 Browser 的内容缩放由各自 owner 管理，不建立全局缩放补偿层。
- 视觉改动通过项目统一检查和目标窗口交互验证；截图只证明渲染，不替代状态和安全测试。
- 受 Radix `Presence` 管理的节点（Dialog/Menu 的 `Content`、`SubContent`、`Overlay`）上的 keyframe 动画**必须**限定在 `[data-state='open']`。Presence 在关闭时读计算出的 `animation-name` 判断是否有退场动画在跑；一个无条件声明的入场动画会让它等一个关闭永不触发的 `animationend`，节点因此永久留在 DOM——菜单项继续命中查询，Escape 关不掉任何可观测的东西。这条由一个静态检查守住（`apps/desktop/test/presence-exit-animation.test.ts`）：它从组件源码推出受管类名而非手工清单，因此后加的菜单自动被覆盖；同时断言入场动画仍在，使这条规则不能靠删掉动效来满足。

## 非目标

- 不建设主题导入器、任意颜色编辑器、插件市场或通用扩展框架。
- 不为没有规模证据的虚拟列表、文件拖动或移动端布局预建状态。
- 不在正式设计合同保留来源路径、固定 commit、Copy/Adapt/Omit 表或已完成任务流水。
