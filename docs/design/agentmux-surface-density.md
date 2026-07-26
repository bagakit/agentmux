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

## 尺度系统（字号、间距、颜色的唯一来源）

设计语言要能被执行，前提是它在代码里**有一个可引用的名字**。散落的字面值不是"细微调整"，是把设计决策
藏进 2000 多行样式表里：改一档字号要靠 grep，改错一处没人发现。因此三类尺度全部收进 token，
**样式表里不再出现裸字面值**。

### 字号阶梯

六档，够用且不多。每一档有明确职责，选档看**这段文字是什么**，不看它想显得多大。

| Token | 值 | 职责 |
| --- | --- | --- |
| `--fs-micro` | 10px | 微标、角标、计数、时间戳。密度下限，不得更小 |
| `--fs-meta` | 11px | 元信息、caption、次级说明、工具栏文字 |
| `--fs-body` | 12px | 列表行标题、按钮、输入框、菜单项——界面默认字号 |
| `--fs-prose` | 13px | 可读正文：Agent 回合、对话、长文本 |
| `--fs-title` | 14px | 卡片与对话框标题、区块 header |
| `--fs-display` | 20px | 页面级标题（Board、Settings、New Tab、Welcome） |

等宽内容不另设字号档：它按所在位置取对应档位，与 `--font-mono` 配对即可。Terminal 与 Editor 的
字号由各自 owner 的原生渲染决定（见密度预算表），不走这套阶梯。


约束：

- **页面级标题只有一档**。Board 用 23px、Settings 用 24px、New Tab 用 20px、Welcome 用 31px、
  Discussion 用 19px，这五处说的是同一件事——"这一屏叫什么"——却给了五个字号。它们全部收敛到
  `--fs-display`，层级差异靠留白与位置表达，不靠尺度买。
- **不使用半像素字号**。10.5/11.5px 在 DPR 切换时渲染不稳定，且它们的存在证明作者当时在两档之间
  犹豫——那说明档位选错了，不是需要第八档。
- **不低于 10px**。7px 与 9px 在密集界面里不是密度是失明。唯一例外是**状态点内嵌字形**
  （`.status__dot::after` 的 `?`），它不是文字而是图形符号，随点尺寸缩放，故不受字号阶梯约束，
  但必须在例外清单里具名。
- 多级标题**字号相同**（见 Activity Turn Prose），这条与本节一致：层级不靠放大。

### 间距刻度

4px 基准，允许半档（2px）用于紧凑控件内部。

| Token | 值 | 用途 |
| --- | --- | --- |
| `--sp-1` | 2px | 图标与文字之间、微标内缩 |
| `--sp-2` | 4px | 紧凑控件内部、列表项内部行距 |
| `--sp-3` | 6px | 行内元素间距、小按钮 padding |
| `--sp-4` | 8px | 标准间距——默认先试它 |
| `--sp-5` | 12px | 区块之间、卡片 padding |
| `--sp-6` | 16px | 大区块分隔 |
| `--sp-7` | 24px | 页面级留白 |
| `--sp-8` | 32px | 空态与页面级留白 |

约束：**奇数像素间距不进入刻度**。当前 5px/7px/9px 合计出现三百余次，它们不是设计决定而是"看着差一点
就 ±1"的累积；这种微调在单个控件上无感，在整屏上表现为节奏抖动——同一层级的两个元素间距差 2px，
眼睛读得出但说不清哪里不对。

刻度到 24/32px 为止，**再往上的值不是节奏而是几何**：给红绿灯让出的 80px、输入框右侧图标占的 28px、
`clamp()` 在大屏上的上界。把它们塞进刻度会让刻度失去含义（一个含 80px 的"节奏刻度"约束不了任何
东西），因此它们按**选择器**具名放行，而不是把数值加进白名单——数值一旦放开 30px，全表哪里都能写
30px。具名了布局几何的选择器，它的常规间距仍要走刻度。

刻度外的小值同样必须具名：hairline 的 1px、Activity spine 的 104px 对齐点。

### 颜色

颜色分三组，都从基础 token 派生，没有第四种写法。

| 组 | Token | 说明 |
| --- | --- | --- |
| 基础 | `--bg`、`--surface-0..3`、`--line`、`--line-soft`、`--text`、`--text-2`、`--text-3` | Surface 与文字阶梯 |
| 中性中间层 | `--neutral-1..3` | `--text-3` 与 `--line` 之间：禁用文字、次级图标、滚动条、终端选区 |
| 状态家族 | `--{red,green,amber}-{text,bg,line,wash}` | 每个语义色的「浅文字 / 深底 / 中边框 / 极淡叠加」 |
| 叠加 | `--scrim-1..3`、`--wash-1..3`、`--overlay-surface`、`--overlay-line` | 黑色遮罩、白色高光、浮层玻璃 |

约束：

- **状态家族必须由 `color-mix()` 从基色派生**，不得写死为 hex。这是"调 `--red` 等于调整整个危险
  语汇"这句话成立的前提；一旦写死，三个层级就会各自漂移，回到最初那三十多个手调近似值的状态。
- **样式表内不出现裸 hex**。此前非 `:root` 区域有 330 处硬编码颜色，其中大量是
  `#12151b`/`#13171d`/`#14171d` 这种彼此相差不到 2% 亮度的近似值——它们本该是同一个 Surface，
  却因为分头手调而分裂成十几个。唯一的例外是 `color-mix()` 里的纯白与纯黑：那是**配料**不是界面色，
  `color-mix(… var(--green) 88%, #ffffff)` 表达的正是"把这个 token 提亮"这种从 token 派生的关系。
- **引用不存在的 token 是 bug，不是笔误**。`var(--text-1)`、`var(--border-subtle)`、`var(--shadow)`
  曾被引用却从未定义，这些声明**静默失效**——Topic 标题那两行的颜色实际上从未生效过。CSS 不会
  报错，所以必须由检查报错。
- **定义了却无人引用的 token 一律删除**，不留"以后可能用得上"。一个没有落点的 token 比没有更糟：
  它让下一个人以为这里已经有答案了。
- **状态到颜色只说一次**。九个 Agent 状态（working/running、waiting/blocked、error/exited、done、
  disconnected）到颜色的对照表只存在于状态语汇段：每个 `.status--<state>` 赋一次 `--status-ink`，
  状态点用它填充、Agent 头像用它描边，将来任何形状也读它。**新表面不得再列一遍九个状态**——
  那等于让同一个状态在两处各说一次，迟早说岔（用户看到 Tab 角是绿的、头像却是灰的，无从判断
  哪个是真的）。这条由 `apps/desktop/test/topic-agent-status.test.ts` 守住。


这三节由 `apps/desktop/test/surface-scale-contract.test.ts` 守住：它从样式表反推出全部字号、
间距与颜色字面值，核对是否落在 token 或已声明的例外清单内，并断言不存在悬空 token 引用。加一个
未声明的字面值会红——这正是意图，一个新字面值要么该用 token，要么该被论证进例外清单。

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
| Scratch Topic Row | 标题 11px 与 Agent 头像同一行，摘要 10px 次行；头像 18px 成簇靠右、`--sp-1` 间距 | 一行只回答**这个 Topic 里的 Agent 现在怎么样了**。**Agent 呈现为一组头像而非一排抽象点**：缩小的 Provider 图标给出身份（这一行里跑着谁），**状态由头像边框表达**而非另加一枚色点——同一枚方块同时承载身份与状态，避免"点讲状态、文字讲身份"要求用户读两处。边框色沿用共享状态语汇（`status--<state>` 加 AttentionCategory），一个状态在哪儿都是同一个颜色。悬停有 macOS 导航栏那种轻量抬升，配 tooltip 给出名字与状态；点击直接定位到该 Agent，走全局同一个 `selectSession`。**不重复呈现同一事实**：既然逐个 Agent 已经在场，就不再另给一个 `N agents` 计数；既然当前项整行高亮，就不再另挂一枚 `Current` 文字标签。没有 live Session 的协作者如实显示 disconnected，不假装在跑。**行首不放 Topic 图标**——一列全同的图标不携带信息（见控件语言）。**选中态是干净的 Surface 填充，不用左侧竖条**。行上只留"定位到目录"一个高频动作，改名收进右键菜单。**顺序可由用户拖拽决定**，复用 Tab 条同一套 sortable 与键盘路径；用户顺序是一份偏好而非真相来源——磁盘上没有的 Topic 不会因排过而出现，没排过的保持彼此既有次序落在后面，新建的不会跳到不可预期的位置 |
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

## 样式表的组织

一个 2551 行的 `styles.css` 不是"文件大"的问题，是**找不到东西**的问题：改 Topic 行要先 grep 出
它散在哪几段，改完不知道有没有漏。样式按**表面**分文件，与组件目录同构：

```
styles/
  index.css       入口：@import 的顺序即层叠顺序
  tokens.css      唯一的 :root——颜色、字号、间距、圆角、阴影、动效
  base.css        reset、html/body、滚动条、共享原子（.icon-button/.small-button/.eyebrow/.status）
  chrome.css      Titlebar、Project Rail、Tabbar、Attention Bar
  dock.css        Tool Dock 及其面板（Explorer、Topics、Branches、Agents）
  workbench.css   Pane、Region、分屏、拖放
  terminal.css    终端表面与它的状态覆盖层
  surfaces.css    Board、Settings、New Tab、Launch、Welcome
  browser.css     Browser 工具与地址栏
  agent.css       Composer、Markdown 回合、Roster
  activity.css    Activity 时间线与标尺
  overlays.css    Dialog、Context Menu、Quick Switch、Tooltip
```

约束：

- **`:root` 只有一处**，在 `tokens.css`。其余文件不得声明全局 token，只能引用。
- 分文件是**按表面切**而不是按属性切（不设 `typography.css`/`colors.css`）——改一个表面时想看到的是
  它的全部规则，而不是在三个文件间来回跳。
- 入口按上述顺序 `@import`，层叠顺序即文件顺序；不依赖选择器特异性打架来决定胜负。
- 单文件超过 400 行时按表面继续拆，不靠注释分节假装分层。
- **没有孤儿文件**：每个 `.css` 都要在 `index.css` 里 `@import`。一个没进入口的样式文件是死文件——
  规则永不生效，而契约测试会照常扫描它并放行。
- 契约测试读的是**整张表**（`test/helpers/styles.ts` 按 `@import` 顺序拼接），不硬编码单个文件路径；
  否则下一次再拆一刀，它们会扫到空内容却全绿。守护：`stylesheet-organisation.test.ts`。

## 非目标

- 不建设主题导入器、任意颜色编辑器、插件市场或通用扩展框架。
- 不为没有规模证据的虚拟列表、文件拖动或移动端布局预建状态。
- 不在正式设计合同保留来源路径、固定 commit、Copy/Adapt/Omit 表或已完成任务流水。
- **不引入 CSS-in-JS、Tailwind 或预处理器**。问题是"字面值没有名字"，不是"CSS 不够强"；
  原生 custom property 已经足以给尺度命名，换一套构建期方案只会在解决同一个问题的同时新增一层工具链。
- 不做设计 token 的运行时主题切换。当前只有一套深色语言，`color-scheme: dark` 是事实而非临时状态。

