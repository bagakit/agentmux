# AgentMux Surface 与密度合同

> 产品交互与 Owner 边界见
> [`agentmux-desktop-interaction.md`](./agentmux-desktop-interaction.md)；导航与会话栏需求见
> [`agentmux-project-rail-navigation.md`](../plans/agentmux-project-rail-navigation.md)。

本文只保存当前视觉规则、密度预算和控件 Owner。历史实现步骤、来源记录、截图流水和过期数值不属于设计真相。

### Topic 导航反馈（2026-09-22）

- Topic 选中行与右侧可见 Tabs 必须一致；布局、焦点和读取失败约束见交互合同《Topic 点击必须打开可见 Tabs》。使用现有选中态和服务窗，不加重复导航栏或无限全页加载。

### Agent 输入行密度（2026-09-23）

- `AGENT INPUT` 行保持单行基线：左侧显示 Agent 用户名，右侧用弱化的小字号承载 Executor/Provider 与短 Session 标识；名称过长以省略号收窄，完整信息由 tooltip/读屏补全。
- Terminal/Activity 视图切换使用一个 28px 左右的图标按钮，不使用常驻的双按钮分段控件；图标只表达下一步动作，焦点环和 tooltip 保留可发现性。
- Scratch Topic 点击后右侧必须有内容面或明确的 loading/failed surface；不可用状态沿用同一 Region 几何，不留无文字、无动作的空白区域。

## 保护原则

本轮方向（2026-09-16）：技术架构延续原有成熟组件，视觉向 Workflow 的低干扰、分层观察语言靠拢。设计规则按「全局基础 → 观察组件 → 聊天表面」阅读；同一约束只在所属层定义，其他章节引用。产品交互和事实归属仍以 Desktop interaction 为准。

- 全局基础保留 Graphite / Mint、现有字号/间距/状态 token；克制的表面明度与文字层次取代装饰性线框和重复卡片。
- 观察组件先让用户识别对象、当前状态和需要处理的异常；数字为次级信息，详情按需展开，持续问题始终可找到。运行中、失败、未知须有非颜色提示。
- 聊天表面区分可读正文、紧凑机器步骤与需要人决定的操作；三者共享对齐、焦点和状态语言，但不压成同一种行高。权限选择和服务窗不能因美化而变弱。
- 独立 Gallery 同时展示真实 Workflow 与现有聊天组件，合成数据明确标识；深浅色、窄屏、键盘、状态更新和恢复展开意图均可核验。视觉提升必须落到真实组件样式，不能只美化展厅。

- 保留 Graphite / Mint 与 terminal-first 的产品身份。
- 删除顶部空行、重复标题、线框拼装和低分辨率感。
- 描边不作为控件的主要视觉手段；Surface 填充、明度差、顶部高光和状态色承担层级。
- 一个身份层级只在一个主要位置可见；低频信息进入 tooltip、context menu 或 Activity。
- 视觉改动不得创建第二套 Agent、Terminal、Browser、Topic 或 Layout 生命周期。
- Agent 操作 AgentMux 的反馈必须来自 Control receipt、语义状态或原生工作面变化；不在产品表面引入截图、坐标点击、Computer Use 权限提示或 a mature workbench 专属入口。外部桌面自动化失败时，产品表面只显示可行动的诊断，不把权限状态伪装成 AgentMux 运行状态。
- 打包来源身份属于安装与诊断边界，不在工作面新增常驻版本条、重复状态栏或第二套
  运行时状态；需要核对时通过候选报告与文件元数据完成。安装失败的保留规则见交互合同
  《打包、安装与启动事实》，包括候选运行依赖完整和实际启动验收的约束；失败阶段停留在诊断面。
- 发布审计与运行路径校验属于同一条诊断边界：候选、canonical 安装副本和当前运行
  实例只通过身份报告对照，不在界面常驻显示版本号，也不复制一份 Session/Run 真相。
- New Browser 的结果沿用交互合同中的可见成功/失败投影：不新增常驻版本或状态条；成功时
  由聚焦 Pane 的 Tab/Region 承担变化，失败时由该工作面已有的服务窗/错误面承担反馈，
  不能留下无变化的空白点击结果。

- 本轮整体 review 延续 Graphite / Mint 与既有 Surface 层级：可靠性与焦点约束见交互合同《整体 review 的可靠性约束》。Prompt 验证降级复用 Session 服务窗，持续可见、不遮挡、不抢焦点；Board 读取失败用现有行内错误语汇，不能用无限 loading 或空态代替。高密度 Board 的排序与分组不应反复全表扫描或复制已分组成员。

- 无独立动作的聚合头像沿用相同身份和状态色，但不显示按钮手势或交互抬升；可定位到 Session 的头像保留现有悬停与键盘焦点表现。

## 尺度系统（字号、间距、颜色的唯一来源）

### 主题与样式 SSOT 规范（2026-09-23）

主题系统采用“运行时 CSS 真值 + 类型化语义边界 + 可选适配层”的三层结构：

- `styles/tokens.css` 是全站主题值的唯一真值。颜色、字号、间距、圆角、阴影和动效都在这里定义；
  其他样式表只能引用 token，不得再声明第二个 `:root` 或复制一套主题值。
- 组件只依赖语义角色（例如 surface、text、line、success、danger、focus），不依赖具体色号或某个
  页面名称。组件自己的几何规则留在所属 surface 文件，不能把业务状态写进主题 token。
- `data-appearance="dark|light"` 是浏览器运行时的主题切换入口。React 状态、持久化配置和系统偏好只
  负责决定这个属性的值，不再并行维护一套组件级 ThemeProvider 真值。
- 外观选择项（dark、light、system）必须从共享的 `APP_APPEARANCE_IDS` 元组派生；设置页、配置校验和
  类型不能各自再写一份列表。新增一个外观时，单点改动应能让三者一起变宽。
- 如果未来引入 Tailwind 或其他 utility 层，只能通过 `@theme inline` 或等价的适配表把 utility 名称
  映射到现有 CSS token；适配层不得写颜色、字号或间距的第二份值，也不能让 utility 绕过语义 token。
- Terminal 的原生调色板属于独立渲染器契约，和 App chrome 主题分开保存；Monaco 编辑器的明暗主题跟随
  resolved App appearance，避免设置页切换后编辑表面仍停在另一套明度。Terminal 与 App chrome 可以在设置
  界面并列，不能互相读取或覆盖对方的 token。
- 新增主题 token 必须同时满足三个条件：有真实调用者、有明确语义、能被契约测试从来源反推出；没有调用者
  的“以后可能用到” token 应删除。

这套规则吸收了现有 CSS 的单一入口、Multica 的语义映射和 a mature workbench 的类型边界，但不把任何宿主 UI 框架
引入核心包。未来若把 primitives 抽到共享 UI 包，包只允许消费这组语义契约，不能拥有第二套主题值。

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
| `--sp-page` / `--sp-page-wide` | 72px / 120px | Global Agents 等宽屏 surface 的响应式内边距上限 |

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
  状态点使用它填充；Topic 头像保留 Provider 身份色，运行状态只由共享状态角标表达，
  不再给头像加常驻边框。**新表面不得再列一遍九个状态**——那等于让同一个状态在两处各说一次，迟早说岔。
  这条由 `apps/desktop/test/topic-agent-status.test.ts` 守住。


这三节由 `apps/desktop/test/surface-scale-contract.test.ts` 守住：它从样式表反推出全部字号、
间距与颜色字面值，核对是否落在 token 或已声明的例外清单内，并断言不存在悬空 token 引用。加一个
未声明的字面值会红——这正是意图，一个新字面值要么该用 token，要么该被论证进例外清单。

### 动效

动效与字号、间距同为尺度，**节奏与曲线也是 token**，不在各表面手写毫秒数。刻度按"这个动作是什么"
选，不按"想显得多快"选。

| Token | 用途 |
| --- | --- |
| `--dur-fast` | 微交互：hover、图标着色、按钮态 |
| `--dur-enter` | 浮层入场：菜单、tooltip、卡片 |
| `--dur-breath` | 长时呼吸：状态点脉动、恢复态光标 |
| `--dur-sweep` | 长时扫掠：恢复态扫描线 |
| `--ease-enter` | 入场减速曲线（浮层从指针处生长的那条） |

约束：

- **一个 App 只有一条通用 spinner**（`.spin`），它属于**行内**尺度——按钮里、行首、面板 header
  这类 11–16px 的位置。它不携带品牌，也不该携带：十六处行内加载各自长出一个品牌动画，等于没有品牌。
- **全屏状态覆盖层用品牌语言**。占满一格终端、一块 Board 的等待态是产品的门面，用通用转圈是把
  最显眼的位置让给了最没有信息的图形。工具属性不是设计粗糙的理由。终端恢复态是这一档的样板：
  品牌绿扫描线 + 方块光标呼吸，与它的兄弟态（Agent 启动）同族——同一种居中卡片、同一套 Surface
  与阴影，只在动效与色相上区分"在恢复画面"与"在等第一段输出"。
- **动效不得是唯一的信息载体**。`prefers-reduced-motion` 下全局 `animation-duration: 0s`，任何
  keyframe 都会被冻在首帧。所以静态那一帧本身必须读得出"正在工作"（可见的绿色扫描位置 + 文案），
  而不是冻成一张看不出状态的静图。这条对所有新动效成立，不只恢复态。

### 全页加载大屏（2026-09-22）

- 启动、恢复、全页导航和大块数据加载共用一个 `FullPageLoadingSurface` 组件；视觉语言统一为 Graphite 深底、低对比网格/切片、非对称注册标记和一处清晰阶段标题。调用方不重复实现全屏 spinner 或品牌 splash。
- 大屏的前景层保持稳定可读，包含 AgentMux 品牌、阶段标题、短说明和当前可用动作；扫描线、错位框线和微动效只作用于中景，不闪烁整屏、不遮蔽错误文案。
- loading、recovering、ready 和 blocked/failed 共享同一几何与密度预算，状态只改变语义色、图标和动作，不改变页面结构。真实工作面出现后加载层卸载，不留下空的 chrome 行。
- `prefers-reduced-motion` 下停止扫描与位移，保留静态切片、边框和阶段状态；所有大屏必须提供可访问的 live 文本和不会因动画变化而重复播报的标签。

## Surface 层级

### Scratch Topic 首次打开的工作面反馈（2026-09-23）

- Topic 首次打开时，Terminal 的 launching 状态直接占据目标 Region，并沿用全页加载/恢复的阶段语汇；不得短暂露出空白 Launcher 作为成功结果。
- 启动完成后加载层卸载，Terminal 露出真实内容；失败态保持同一几何和密度预算，显示原因与 Retry，不用空白面或只留一个无动作的占位块。
- Topic 行的主要内容区承担导航命中面，标题、摘要和 Board 行保持同一点击密度；定位、头像等辅助动作单独保留自己的命中区，不把打开 Topic 压缩成一枚孤立图标。

### Settings 控制工作面（2026-09-23）

- Settings 使用“紧凑导航 + 宽内容”的工作台构图：左侧导航不靠重复描述撑高，当前分区的完整说明只在主区头部出现一次。
- 当前分区图标是标题的语义前缀，不使用彩色方块装饰；品牌色只表达焦点、状态或唯一主操作。选中导航使用 Surface 填充和顶部高光，不使用左侧竖条或整圈描边。
- 主区头部提供分区层级、说明和 Close/Escape 入口；区块间用抬起的可操作 Surface 与平铺的信息层形成主次，保持现有 Token、圆角和动效刻度。
- 窄窗口时导航变为横向滚动的单行入口，设置内容保持独立纵向滚动；搜索和关闭动作仍可键盘访问。

重启恢复是工作面的一等状态：恢复期间保留原 Tab、Tab Group 和 Region 的几何位置，不用空白欢迎页替换它们。流程故障以停在旁边的服务窗提示，提示包含失败步骤、当前按什么状态运行以及恢复动作；只有 Core 确认 Session 退休时才收掉对应 Region。冲突提示必须区分“旧 owner 仍存活”和“租约可回收”，不能把一次重启后的 stale lease 画成健康 Session 被其他进程占用。

| 层级 | Surface | 用途 | 边界规则 |
| --- | --- | --- | --- |
| S0 | `--bg` / `--surface-0` | Window 与 Pane 工作面 | 不用连续网格包围；分屏边界除外 |
| S1 | `--surface-1` | Project Rail、Tool Dock、Titlebar Plane | 用明度差和局部阴影分组，只保留 resize 或窗口分区边界 |
| S2 | `--surface-2` | Hover、工具内容块、搜索与局部 Toolbar | 默认无描边；交互时提升 |
| S3 | `--surface-3` | Selected、Segment、Badge、浮层按钮 | 小面积使用，不铺成整列 |
| Accent | Mint / Blue / Amber / Red | Focus、Host、Attention、Danger | 颜色表达状态，不兼任布局线 |

## 控件语言

### 三工作面与注意力密度

- 底部中央只保留一组 `Agents / Session / Board` 切换，使用紧凑文字和单一选中 Surface；顶行不重复同一组三项。
- Agents 收件箱按注意力排序，Needs you 使用现有琥珀语义，working 使用现有绿色/蓝色语义，结果审查入口使用低对比度次级动作；不为同一状态增加第二枚常驻徽章。
- Board 卡片先读 Task 身份，再读 Project 和状态；Session 名称、Provider 与执行状态进入次级元信息，不抢 Task 标题层级。
- 没有选中 Task 时主区占满可用宽度；不画空右栏、不画占位边框、不使用“从右到左”的方向性动画。只有多个 Region 真实存在时才显示 arrangement 控件。

| 层级 | 视觉语言 | 用途 |
| --- | --- | --- |
| Primary | 实心品牌绿渐变、深色文字、顶部高光 | 页面唯一主操作 |
| Secondary | 干净 Surface 填充、软高光、无常驻描边 | 次级操作与行内确认。**落地类名只有 `.small-button` 一个**，见下「一档控件只有一个类名」 |
| Ghost / Icon | 透明底，hover 才提升 Surface | 图标按钮与工具栏动作 |
| Selected | 单一几何信号；实心图标格或底部横条 | Project、Segment 与 Tab 选中态 |
| Danger | 实心红色变体、深色文字、顶部高光 | 删除、移除等破坏性主操作 |

补充规则：

- 同一语义在不同容器中使用同一控件层级。
- **一档控件只有一个类名。** 上表五档各自只有一个落地类名：Primary＝`.primary-button`、Secondary＝`.small-button`、Ghost/Icon＝`.icon-button`、Danger＝`.danger-button`。**不得按表里的档位名另造一个类名**——那个名字读起来像"就该存在"，于是没人会去查它有没有规则。实证：`.secondary-button` 被这样写出来过一次（启动页 Resume），全仓零规则，而 `base.css` 的全局 `button` 只重置 `font`/`color`、**不重置 `background`**，于是它落到 macOS 原生按钮样式——一颗浅灰实心药丸，在深色主题里比紧邻的品牌绿主操作还重，恰好推翻上表"Primary＝页面唯一主操作"。这条由 `apps/desktop/test/rendered-class-has-rule.test.ts` 守住：它的扫描面除 BEM 记号外**还收 `-button` 结尾的扁平类名**，渲染了却没有规则即红。扁平名此前整族在扫描面之外（判据只认 `__`/`--`），这不是漏登记而是结构性缺席，所以修的是判据形状而不是加一条豁免。
- **`justify-content: space-between` 是一份「有几簇」的契约，不是"把东西摊开"的通用手法。** 它把自由空间**摊在子元素之间**，所以结果是子元素**个数**的纯函数：两簇时各抱一端（这才是它的用途），三个以上松散子元素则被甩向两极、中间留出大洞。这份"应该有几簇"的期待写在 CSS 里，而供给子元素的是另一个文件里的 JSX，两边没有任何东西对齐它们——**供错形状不报错，只是默默排错**，而本仓测试跑在 happy-dom 下不算布局，没有任何 gate 会红。因此：**space-between 只用于子元素集合固定且已知的容器**；凡是"一个留在左缘、其余聚到右缘"的工具栏与页脚，一律用 `justify-content: flex-end` 配首元素 `margin-right:auto`——它对 2、3、4 个子元素都成立，**契约本身被删掉了**，而不是被记在文档里等人遵守。这套写法本仓已有多处（`surfaces.css` 的 `.settings-pane-actions`、`dock.css` 的 `.workspace-composer > footer`、`board.css` 的 `.discussion-canvas__footer`）。实证：`.composer__toolbar` 与 `.settings-pane-toolbar` 都配了 `> div` 的两簇写法，各自有一个调用方老实给两簇、另一个调用方给四个松散子元素，于是同一条规则在两个界面上同时排错。
- **选中态一律不用左侧竖条（inset 竖线）**。一条贴边的亮色竖线是"AI 生成的管理后台"最容易辨认的印记：它既不是填充也不是描边，只是一根贴在行左缘的装饰，在密集列表里连成一片噪音。选中由**单一几何信号**表达——干净的 Surface 填充，必要时配实心图标格。这条对所有列表行成立（Project Rail、Topic、Tree、Segment、Settings 分区），没有例外；`box-shadow: inset <n>px 0 ...` 与 `border-left: <n>px ...`（含 `border-inline-start`）这两种拼法都不得用于表达选中——它们在屏幕上是同一根线，禁的是那根线而不是某一种画法。这条由 `apps/desktop/test/surface-selection-contract.test.ts` 守住：它从 CSS 推出两种拼法的所有左缘竖条并在选中态类名上断言其不存在，加回一条会红；两个形状判定各自带一条自证（拿合法的容器分隔线与内容引用条当样本），因为一个认不出竖条的检查会因"没找到"而全绿。
- **一列全同的图标不是信息，是宽度开销**。若某个列表里每一行的行首图标都相同（Topic 行的 Topic 图标、纯文件列表的文件图标），去掉它——图标的价值在于区分，无可区分时它只在挤压标题的可读宽度。行首位置留给真正有区分度的东西（状态、Provider 身份）或干脆留白。
- Project Rail 的选中与活动分开：选中用中性 Surface 填充，活动用独立控件。项目图标、分组和目录的区分见文末“Projects”约束；分组文字仍比项目名轻，区别靠角色与结构。
- 文件树目录右键菜单的“作为项目打开”使用现有菜单语言，不增加常驻图标或行高；行为见 [Desktop interaction](agentmux-desktop-interaction.md)。
- 分屏菜单的 `Move to New Tab` 继续表达搬动，完成后源处不留同一 Agent 的副本；不新增常驻重复视图提示。移动与额外投影的行为约束见 [Desktop interaction](agentmux-desktop-interaction.md)。
- Project Rail 的“移除视图”放在项目行的 context menu 中，使用危险动作语义但不画成常驻删除图标；确认文案必须说清楚“只从侧栏移除，磁盘文件不受影响”。路径失效时的“重设路径”是错误面中的次级按钮，与 Retry 并列但不抢错误标题，选择成功后仍回到同一行的工作面。
- 用户反馈“自动放到一起并缩进，但是视觉上区分度不高”，分组必须优雅且清晰：成员整体向内一格，嵌套成员继续缩进；展开的有名分组使用低对比、非交互的细结构线串联其成员，组间留白明确归属。结构线不占文字槽、不改变行高、不承载选中或运行状态；无分组头的项目不画线。分组头仍轻于项目标题，折叠时不留空结构线。
- **同一族列表行共用一套表现层**。Branch/Worktree 条与 Topic 条回答的是同一种形状的问题——"这一组条目里挑一个，进去是一组 Tab、每个 Tab 是一套 Region 分屏"。因此列表容器（标题 + 计数 + 动作位）与行（状态槽 + identity + 尾部 Agent 簇）**只有一套实现**，数据源、选中判定与动作由调用方注入。两者的**选中真相模型确实不同**——Branch 换的是 `activeWorkspaceId`（worktree 自成一个 workspace），Topic 是对同一份 Scratch layout 做投影——这条差异归交互合同，表现层不感知它，也不得为了"统一"把其中一侧改成另一侧。判据：两个条上看起来相同的东西（计数徽章、Agent 簇、hover、选中填充）必须真的是同一段代码，不是两处长得像的写法。
- 失效的声明比错的声明更危险。`-var(--sp-2)` 这类写法不是合法 CSS，浏览器**静默丢弃整条声明**——它不报错、不回退、在样式表里看起来完全正常，而它想做的事从未发生（负外边距归零，靠它做居中或叠压的东西一直是错位的）。数值型契约测试抓不到这一族，因为压根没有数字字面值可扫。负值必须写成 `calc(-1 * var(--sp-2))`，或改用不依赖数值的手法（如 `translate(-50%)` 随自身尺寸走）。这条由 `apps/desktop/test/stylesheet-organisation.test.ts` 守住：它扫全表断言 `-var(` 出现零次并报出文件与行号。**这类失效还会掩盖第二层错误**——声明既然从未生效，写在里面的数值对不对也就从来没人验证过；修复时要重新核算那个值，而不是照抄进 `calc()`。
- hover 提升 Surface 明度；active 用内阴影表达按下，不靠边框位移。
- 输入聚焦统一使用 `--focus-line` 与 `--focus-ring`。
- 圆角只使用 `--radius-sm`、`--radius`、`--radius-lg` 三档，**两类例外据实开放**：其一是紧凑交互控件——24px 图标按钮、Tree/File Row、Tab 与 Region 的关闭键、pane 动作等在 6px 下会显得过圆，故取 4–5px；其二是微标与装饰件——状态点、hairline 轨道、ruler tick、图标裁角、选中标记等取 1–3px。例外只对**这两类**成立：面性容器（卡片、菜单、弹窗、输入框、工具坞）一律走 token，不得因为"看起来更合适"而硬编码。这条由 `apps/desktop/test/surface-radius-contract.test.ts` 守住：它从 CSS 推出所有低于最小 token 的圆角并核对是否落在已声明的例外清单内，新增一个未声明的硬编码圆角会红。
- **状态在场标志与规则必须成对，判定按元素而非按属性名。**`data-x={cond ? '' : undefined}`（只有空串与不在场两种取值）对 JS 携带零信息，它存在的唯一理由就是被 `[data-x]` 选中；因此渲染了它却没有 `.那个class[data-x]` 规则，要么是规则在重构里丢了，要么这个属性本就多余、该删。**没有例外清单**——这个记号和 BEM 一样按定义成立。这条由 `apps/desktop/test/rendered-class-has-rule.test.ts` 守住，它逐元素配对：起因是那份测试原本只查选择器**名**在不在，于是删掉 `.log-fold[data-open] .log-fold__chevron { transform: rotate(90deg); }` 之后折叠箭头永久不转，而它自己 3 条 + `stylesheet-organisation` 8 条全绿（实测）——`[data-open]` 因为 `.log-row__chevron[data-open]` 还在而"依然出现过"。按属性名判会漏掉的正是它自己那次事故的形状，所以判据必须落到"同一个元素上的 class × 该元素的标志"，并另有一条自证钉住这个区别（拿一对成对的与一对属性名存在但元素不对的当样本）。
- **受控表单控件必须有写回口，或显式声明它永不接受输入。** 判据不是自拟清单，而是 React 运行时自己的规则：给了 `value`/`checked` 却既无 `onChange`/`onInput` 也无无条件的 `readOnly`/`disabled`，React 会报 "without an `onChange` handler … read-only"。受控取值与写回口按定义成对（单独一个 `value` 没有任何用途——用户敲不进去），与上一条的在场标志同一形状，故同样**没有例外清单**：`defaultValue`、`readOnly`、`disabled` 本身就是判据的另一半。这条由 `apps/desktop/test/controlled-input-is-writable.test.tsx` 守住，它静态扫每一个组件文件、并把 React 的那句告警接成断言钉住判据。起因：启动对话框那两格名字输入删掉 `onChange` 之后永久不可写（用户填什么都送不出去），涉及该组件的 23 条测试与 `tsc --noEmit` **全绿**（实测）——本仓只有 `renderToStaticMarkup`，不跑 effect、不派发 DOM 事件，这类失效没有行为测试能覆盖。**只有无条件的 `disabled` 才算自洽**：事故现场那两格正带着 `disabled={busy !== null}`（忙时才禁用），把任何 `disabled` 都算过的话这次变异照旧全绿（实测）。
- Tab 选中态使用轻微背景和底部 2px 横条，不使用顶部高光或整圈描边。
- Composer 表面同样不使用描边：它靠比所在 Region 高一档的 Surface 填充与顶部高光界定自己，四周 margin 与紧邻其上的审批卡片一致，读作工作面的一部分而非浮在上面的盒子。这也消解了卡片刻意不用描边的那条理由——两处不再争夺同一条边界。去掉常驻描边后 focus 不再能寄生在 `border-color` 上，故由 `--focus-ring` 加一道 inset `--focus-line` 独立承担，可见性不因"更平"而退化，且内阴影不改变盒模型、不引起布局位移。
- **装饰性强调图标格不是卡片元素**。给一段说明卡挂一个品牌绿的 36px 图标格（原 Settings 的 `.settings-card--hero` / `.settings-card__icon`），是把最抢眼的强调色花在一段不可操作的文字上。强调（品牌绿实心格/描边）只表达**状态**或页面**唯一主操作**；说明性卡片靠字号阶梯与留白分级，不靠一枚彩色图标求存在感。每节导航前缀的**区分性**图标不在此列——它们各不相同，是身份标识而非装饰（见"一列全同的图标"那条的反面）。

## 身份归属

| 位置 | 主要身份 | 不应重复的内容 |
| --- | --- | --- |
| Project Rail Row | 选择了哪个 Project、在跑几个 Agent、要不要你 | 完整路径、worktree 数与 Session 详情 |
| Topbar Breadcrumb | 当前主区 Workspace 与 Branch | 完整绝对路径 |
| Tool Dock Header | 文件树根与可见路径 | 第二个同义图标或重复 Breadcrumb |
| Session Tab | Session 名称、Provider、状态 | 第二条 Session Info Bar |
| Tooltip / Context Menu | Session ID、Host、开始/活动时间 | 常驻占用内容高度 |
| Activity View | 最近消息和结构化事件 | Terminal 上方的重复摘要 |

## 顶行与 Tabbar

- Projects 与 Workspace tools 两个固定开关位于 macOS 红绿灯之后，只用 active treatment 表达开合，不翻转图标方向。
- Session 顶层 Tabbar 是最上方的工作面平面：单 Pane 时与窗口顶行合并为 36px；分屏时由左上方首个 Pane 的 Tabbar 承载一次必要的窗口 chrome，其余 Pane 直接从同一顶边开始使用 31px Tabbar，不再给没有 Tab 的全局 chrome 行预留 36px。
- Tool Dock header 与相邻顶行对齐。非交互品牌标记不进入功能按钮组。
- Tab DOM 始终保留在自己的 Pane owner 下；顶行合并不得改变 DnD、split 或 focus 的状态归属。
- Workspace/Project 切换不以卸载 DOM 换取密度：非当前 Workbench 使用隐藏与停工状态保留 xterm/TUI attachment，回访时不出现 `Restoring terminal…` 或二次 loading；只有 Region/Workbench 真正关闭才销毁实例。窗口重启后的布局与 Session 恢复约束归交互合同，见 [`agentmux-desktop-interaction.md`](./agentmux-desktop-interaction.md)。
- 资源密度采用有限 hot-retain：活动与近期使用的重资源 surface 保持 warm，长期隐藏或超过预算的 surface 才允许 cold-park；跨 Workspace 隐藏的 Workbench 仍保持 warm，避免项目切换制造二次 replay。具体保活/重建约束归交互合同，见 [`agentmux-desktop-interaction.md`](./agentmux-desktop-interaction.md)；本层只要求内存回收不能靠额外常驻缓存、不能让隐藏 surface 继续执行高频工作，并以同场景 owner count 与 working-set before/after 证明收益。
- Core 侧用于 prompt/readiness 的屏幕证据同样计入内存预算：不得为每次观察临时堆出与全会话历史等长的 headless 终端尖峰；增量或帧起点有界证据是交互合同要求，本层只要求该证据不得变成常驻无界缓存，且 cold-park 唤醒不得依赖「从 byte 0 重放全史」作为唯一重建路径。
- Durable Runtime 的异常使用同一套紧凑服务窗语言：瞬态 WAL busy 的重试不占据 Terminal 内容区，也不显示永久 loading；只有重试耗尽、磁盘不足或完整性失败才在原 Region 旁显示一行分类告示与下一步。具体状态与 Owner 边界归交互合同的《Durable Runtime 健康》，本层不复制错误码或另造控件。相关回归测试必须在隔离临时 state-dir 注入 I/O 失败，不填满宿主磁盘、不改用户 runtime；测试只验证服务窗分类与恢复边界，不把宿主带入故障态。
- 资源面板和基线报告按 Main/Renderer/GPU/Utility/Browser 进程与 Terminal/Monaco/Browser/attachment owner 分栏；不把共享 RSS 或 V8 已保留容量重复计入，也不以单一总 RSS 推断泄漏。跨客户端比较只采用同窗口、同场景、同等待窗口的相对变化。
- Session 恢复状态使用现有服务窗/状态行表达，不新增一条常驻的“Resume”工具栏或第二套 Tab chrome；自动恢复成功不占视觉空间，只有分类失败或待处理状态才在原 Region 旁给出短告示和动作入口。
- 启动时先显示已保存的布局；单个 Host/runtime 探测失败只占用对应服务窗/状态行的密度，不得用全屏 loading 或空态覆盖工作面。具体恢复顺序与错误边界归交互合同，见 [`agentmux-desktop-interaction.md`](./agentmux-desktop-interaction.md)。
- 新建 Tab 的视觉归属沿用当前工作线，不增加额外的 Topic 标签、层级条或第二条 Tab chrome；Topic 绑定与继承规则以交互合同为准（见 [`agentmux-desktop-interaction.md`](./agentmux-desktop-interaction.md)）。
- Agent/Terminal Pane 不显示 Session Info Bar。Stop Run 进入 Tabbar；Recent message 回到 Activity。

## 密度预算

| 对象 | 预算 | 说明 |
| --- | --- | --- |
| Titlebar Plane / root Tabbar | 36px | 与窗口顶边和相邻 header 对齐 |
| Pane Tabbar | 31px | 分屏 leaf 的紧凑索引高度 |
| Project Rail Footer / Corner Badge | 32px / 28px | Footer 只容纳两个 24px 图标入口 |
| Project Rail Section Label | `--fs-micro`；轻字重；紧凑上下留白 | `Projects` 是分组标签，不是页面标题；项目名称保持主要阅读层级 |
| Project Rail Group Header | 22–24px；`--fs-micro`；字重 560；大写 + `.07em` 字距；左侧 14px chevron 槽 | 共同父目录的名字（只显示最后一段，完整路径进 tooltip）。**只领一个成员时不渲染**——分组头答的是"这几个是一伙的"，领一个人时不携带信息，也因此没有可折叠的东西。<br><br>用户反馈「分组的样式和正式项目的样式太接近了，是不是应该稍微区分一下？」。区分**不走字号或颜色**：它必须比项目名轻，这条不动（父目录名比项目名还响是更糟的错）。走的是角色——它是个 **disclosure 控件**（项目行没有 chevron）、大写字距展开的分类学写法（与 Section Label 同族）、且 chevron 占在缩进槽里而**不侵占项目名那条左缘**（"同一条左缘 + 同一个 `--text-3`"正是当初读起来像同一列表两行的原因）。hover 只提亮文字，**不上填充**：填充是项目行表达 hover 与选中的手段，借了就又变回"一行条目"。 |
| Project Rail Group Collapse | 折叠态持久化；折叠后头上补地址与角标 | 用户「分组上面是不是应该有些操作？」——折叠是这个位置唯一说得通的动作。分组是从磁盘路径**派生**的，不是可重命名/删除/配置的实体，给它挂那类操作就是凭空发明一个注册表。<br><br>用户「后退的时候，是不是应该显示它的地址之类的元信息呀」——折叠就是那个"后退"。成员一藏，这一行就是那几个项目在界面上唯一的痕迹，于是它必须自己答出身份：**地址保留尾部三段**（`…/me/proj/kit`），因为同一台机器上路径开头几段大都相同，分辨力全在末尾——这也是不能用 CSS `text-overflow` 的原因，它砍掉的正是唯一有信息的那一头；以及**成员数**。<br><br>展开时地址与角标都不渲染：下面那几行项目名已经答完"这是哪儿"，每行也各自带着角标，再挂一份就是同一事实占两处。<br><br>折叠**必须把注意力卷上来**（复用项目行那一个 rollup 与那一套配色）。这是一个已经犯过一次的错：项目行只显示 workspace 计数时，"一个 Agent 正在里面等你"的折叠项目看起来和空闲的一模一样；分组折叠会在分组这一层原样复现那个洞。折叠状态的 key 必须带 hostId——两台机器上同名的 `…/kit` 不是一个分组。 |
| Project Rail Row | 28–32px 单行；标题从统一左缘起；尾部独立运行状态槽 | 选中只用中性 Surface；运行中的 Agent 在相关项目行显示独立活动控件；行首图区分项目、仓库和目录。**一行只占一行**——标题与状态同处一行，不为常驻元信息另起次行。尾部计数是**在跑的 Agent 数**，不是 worktree 数：用户问的是"这个项目现在有没有人在干活"，worktree 有几个是仓库结构，答的不是同一个问题，降级进 tooltip。计数为零时不显示数字（一列全是 `1` 的徽章不携带信息，见控件语言同一条理由）。Host 只在**不是本机**时占位——`This Mac` 每行都一样，属于一列全同的元信息 |
| Project Rail Nesting Indent | 默认每层 `var(--sp-3)`；紧凑档和更紧凑档继续递减；最多 3 层 | 只有**真嵌套**（一个 Project 在另一个 Project 目录内）才缩进，同父目录的兄弟不缩进——缩进表达的是包含关系，不是分组。深度经 CSS 自定义属性注入，且必须在样式表里声明默认值（见控件语言「注入的自定义属性要声明默认值」）。层数封顶避免深目录把标题挤没。Pinned child 沿用同一深度公式，再由连接线指向所属 Project，不另造一套左缘 |
| Project Rail Pinned Child | 比 Project Row 小一档；hover 只下划线；一条低对比虚线连接父 Project | Pinned Topic/Branch 是导航入口，但视觉上是从属内容。连接线保持可见但安静，不携带选中或注意力状态，也不把子项重新当成一个顶层项目 |
| Explorer / Branch Header | 32–34px | 不形成第二层大 Topbar |
| Tree Row | 24px | 保持键盘扫描和专家密度 |
| Tool Dock Width | 默认 300px；最小 236px；最大 440px | 同时容纳 Explorer / Branches，保留主工作面容量 |
| Tool Content Padding | 8–12px | 仅用于局部卡片，不包住整栏 |
| Context Menu | 176px 最小宽；26px Row；8px 横向 Padding；5px 容器 Padding | 全部 Context Menu 共用一套基座。Surface 填充 + 阴影 + 顶部高光建立层级，**不使用描边**；hover 提升明度并把图标转为品牌绿；破坏性项 hover 保持红色语义，不被绿色 hover 覆盖。菜单从指针处生长（120ms），表明它是这次点击召唤出来的，而非盖在界面上的一层浮层 |
| Activity Log Row | 24px Row；20px 节点槽；56px 等宽时间槽；12px 横向 Padding | 与 Tree Row 同一节奏。整列共用一条 hairline spine，节点用填充光晕挖空它而非画环。展开内容与该行标题同一左缘（104px），不得比自己的标题突出。**仅**机器上报（tool_call / permission / lifecycle）走这一寄存器 |
| Scratch Topic Row | 标题 11px、摘要 10px 次行；presence 18px 成簇锚定行右缘并垂直居中；结构摘要使用 `--fs-micro` | 一行回答 Topic 身份和工作面结构。Agent 用 Provider 图标成簇表达身份与状态；**同一可复用 presence 组件同时给出 Tab 数量与 Region 结构**。hover 显示 Tab 顺序/标题、分屏布局、每个 Region 的 Executor 和最近活动摘要；没有摘要明确显示 `No recent activity`。键盘 focus 时显示同一结构摘要，不能把 hover 当作唯一信息来源。**不重复呈现同一事实**：不再另挂无法定位的总 Agent 数；结构详情只在一处出现，定位动作仍走全局 `selectSession`。行首不放 Topic 图标，选中态使用 Surface 填充，不用左侧竖条。 |
| Activity Turn Row | 与 Log Row 共用同一 spine 与 20px 节点槽（14px 图标）；正文 13px/1.6 用 `--text` 主色，caption 11px `--text-3` 大写，时间移到行首右侧的 mono 戳；上下各 6px 呼吸 | user_message、assistant_message 两个可读回合脱离 24px 机器寄存器：正文是主体不是 payload，永不裁剪、永不折叠。<br><br>用户「User 发的消息要单独显示」。**用户发言整块成立**——底色、内缩、圆角与左侧 2px 实心色带一起把它围成一条独立的发言，而不是只给正文一层底：只给正文时 caption 与时刻浮在底色之外，一句话读起来是"一个标签 + 一块底色"两件东西，扫下来与 Agent 回合只差一点底色深浅。成块之后正文自己不再叠第二层底（浅底叠浅底边界更糊），字色降一档——用户自己的话是"我说过什么"的回看，Agent 的答复才是主叙述。Assistant 正文在 S0 上流动，保持敞开的叙述形状。<br><br>那道色带**不属于**被禁掉的选中竖条：禁令针对密集列表里表达**选中**的贴边装饰，这里既不表达选中也不在列表里，走的是同文件已有的**内容**语汇（`.md-quote`、`.log-row__output` 同样用 2px 左侧色带说"这一段是引来的/跑出来的"），一句被读回的用户发言正是一段引文。边界仍由填充承担，色带只在一侧、不画出框。<br><br>形状按 **SPEAKER ROLE** 选，不按 kind：A2A 落地后 agent 侧不管有多少身份都保持同一形状，而"这台机器前面的人说的话"始终是被框起来的那一条。native-hook 的 assistant 回合不进入折叠 |
| Activity Turn Prose | 标题全部 13px（与正文同号）靠 600 字重与上下留白分级；表格 4×9px 单元、hairline 行分隔；引用块左缩 9px 配 2px 竖线；水平线 1px | 对话回合的正文渲染 GFM 子集：标题、强调、删除线、行内与围栏代码、有序/无序含嵌套列表、表格（含列对齐）、引用块、水平线、链接。**多级标题字号完全相同**——密度合同对字号设下限并禁止用尺度买层级，故 h1..h6 只靠字重、颜色与留白区分，绝不放大。解析器（remark-parse + remark-gfm）只产 mdast **语法树、从不产 HTML**：节点映射为 React 元素，`dangerouslySetInnerHTML` 从不出现，因此不可信的 Agent 输出**没有东西需要 sanitise**——风险面是构造性为零而非"已过滤"。raw HTML 节点按字面文本呈现，绝不成为标签。宽表在自己的 `overflow-x` 容器里横向滚动，不得撑宽回合、更不得让整个 feed 横向滚动。链接渲染为 button 而非 `<a href>`，经既有 openExternal seam 打开（不可信输出里的 `<a>` 是导航逃逸口）。只在 turn register 渲染；机器行保持纯文本，纯文本也不进解析器以免重排从来不是 markdown 的句子 |
| Activity Ruler | 顶部 sticky；18px track | tick 按真实经过时间比例定位——密集事件自然聚簇、长思考自然留白。首末时间戳无跨度时退化为序数轴并用虚线明示，不得让间距宣称数据没有的精度。ruler 可交互，三项均由**同一个双向纯映射**（像素位置 ↔ timeline 位置）驱动，不各自重算：**点击**跳到对应事件（落在两事件之间时就近取一个**真实事件**，绝不插值出不存在的时刻），并有键盘等价路径与可见 focus；**可视范围**在 track 上框出日志当前看到的那一段，来源是真实可见区域；**悬停/聚焦**读出该位置的具体时间，锚定不遮挡它所描述的那段 ruler（沿用终端链接预览的同一条规则），且不改变选中状态。**零跨度时三者全部退化为序数语义**——只说"第 N 个事件"，不显示也不暗示任何时刻；这条由返回类型强制：ordinal 变体在类型上就没有承载时刻的字段，因此伪造精度无法通过编译。可视范围的更新**不在滚动热路径上**：由观察式 API 驱动而非每帧 scroll 处理器，一条阅读用的装饰不该成为滚动卡顿的原因。范围为空或日志短于一屏时不画占满全宽的假框（那会读作"什么都看得见"）|
| Activity 时间读数 | 时刻固定 `HH:MM:SS` 24 小时补零；时长按最高非零位起报 `3h04m03s` / `4m03s` / `3.2s` / `840ms`；均 mono + `tabular-nums` | 用户「时间只显示分钟太不友好了, 应该显示从什么时间点到什么时间点, 消耗的时分秒」。<br><br>**时长不在分钟处封顶。**小时位不是可选修饰：Agent 跑一下午是这个产品的常态，而封顶的实现会把一次三小时的 Session 报成 `184m03s`，让读者自己去除以 60。低位补零（等宽下不跳位），高位为零则省掉（短跑不必读 `0h00m03s`）。这条同时管偏移量、标尺跨度、折叠段耗时与读屏可访问名——**只有一个格式化器**，四处共用；任何一处靠切字符串（`+3h04m03s` 去掉加号）拼出时长都会在前缀变化时啃掉一位数字。<br><br>**时刻用固定 24 小时而不是 `toLocaleTimeString`。**读数落在等宽的时间沟里，一列上下必须对齐，而 locale 格式的宽度随小时变化（`2:03:07 PM` vs `14:03:07`）。日志读数取可预测的对齐，这也是各类日志查看器的通行做法。<br><br>**三个事实各就其位，不重复。**标尺头上给起、止、耗时（这是用户那句话的完整答案，三段回答同一个问题，摆成一行而不是分两处让读者自己拼）；一句话的行内给**时刻**（一句话关心"什么时候说的"），偏移量退进 title；机器行仍给**偏移量**（一条 tool_call 关心"距开始多久"）；折叠头把它藏起来的那段时长摆在 `N steps` 旁边，于是展开与否都在同一位置回答"这一段值不值得展开"。<br><br>**没有时间可报时不报。**序数轴不渲染跨度，同刻的折叠段不渲染耗时——硬报一个 `0s` 会把 ruler 在类型上刻意排除掉的那种不诚实又请回来（见 Activity Ruler）。<br><br>**分档按将要显示的那个值判。**秒档显示到 0.1s，所以先把时长归到十分之一秒再决定进不进分钟档。两个精度各判一次必印出这套记法里不存在的读数：以整数秒判档、以四舍五入显示，`59_950ms` 会留在秒档而印成 `60.0s`；分/时交界同理会给出 `59m60s`。<br><br>**「一个格式化器」是可执行的约束，不是文档里的说法。**偏移量整段就是「一个符号 + 一段时长」，不自带毫秒档与秒档——那两行与时长格式化器同义，留着就等于同一条规则住在两处，而它真的走岔过：分档修好之后时间沟里仍印着 `+60.0s`，而机器行每一行都在读它。<br><br>**折叠段的耗时算到末步跑完，不是算到末步开始。**起点是首条的 `createdAt`（这一步开始），终点是这一段里最后完成的那个 `updatedAt`（这一步结束），取 max 因为并发几步的完成顺序不必跟着开始顺序。末步往往是最贵的那一步（build、跑测试），拿"末步开始"当终点会把它整段跑的时间漏掉——一个藏着五分钟构建的折叠头会宣称自己只有 1 秒 |
| Activity 对话轴 | 两条各 16px 高，之间 `--sp-1`；标记头像 16px，命中区 `--sp-7`(24px) 圆形；与 ruler track 共处一个 `stack` 列 | 两条轴的**需求真相在交互合同**（见 [`agentmux-desktop-interaction.md`](./agentmux-desktop-interaction.md) 的说话人轴/自我 Agent 轴），本行只管密度与几何。<br><br>**共用一个坐标盒是这两条轴的存在理由。**标记的 `left: N%` 与 tick 的 `left: N%` 必须对同一个宽度解析，否则两行只在分数上一致、在像素上不一致——ruler 行的 track 是 `flex: 1`，左侧被行内缩、右侧被跨度读数与 note 各占掉几十像素，一条横跨整个 feed 的轴会越靠后越右偏，最后一枚头像浮在它该指的 tick 一个时间戳宽度之外。所以轴不是 ruler 的兄弟，它与 track 同处 `.activity-ruler__stack` 这一列。<br><br>**轴高必须等于它所座的头像尺寸**（今天 16px）：标记全是绝对定位，轴自己没有内容可撑高，短了裁掉头像、高了在 ruler 上方留死白。两者是同一个数，不是"碰巧都是 16"。<br><br>**命中区大于头像，且不靠布局买。**头像保持 16px，`min-width/height` 取 24px——触摸目标比鼠标目标大得多，这是移动端可移植性在源头就兑现而不是留给以后。命中区长大不推动邻座，因为标记绝对定位且靠 `translate(-50%,-50%)` 以**自身中心**对位。24px 是"还称得上目标"的下限；桌面窄侧（~320px 时 track 只剩约 190px）两个相近的标记会有十几像素重叠，靠 hover/focus 抬 `z-index` 并放大**头像**（不是按钮——按钮的 transform 正是它的对位手段）把当前那枚提到可完整看见，邻座不动。<br><br>**选中与 tick 同一套配方**：长大几何 + 一圈 `--surface-0` 让位，不额外上色、不加描边（选中是单一几何信号）。选中的缩放必须压过 hover 的，否则指上去会让当前选中看起来"更不选中"。 |
| Tool Dock Header | 30–34px；10px 左缩进；24px 图标按钮 | 各工具坞标题共享同一左缘。分屏时上下堆叠的标题必须对齐，近似对齐比不对齐更伤观感 |
| Agent Attention Bar | 24px 高；横跨整宽；12px 横向 Padding；12px 段间距；11px tabular-nums | 窗口底部唯一的跨会话注意力汇总。`surface-1` 填充 + 顶部高光 + 一条 hairline 顶边界定它，不使用描边。复用共享状态点语汇，计数为零保持中性灰；栏存在时把折叠的 Rail 角标抬高让位，纯 CSS `:has()`，不耦合 JS |
| Agent Provider Catalog | 142px 最小列宽；44px Card；最多 268px 高 | 容器独立滚动，不扩大 Launcher。**「不扩大」是容器自己的约束，不是"卡片少所以碰巧没长"**：容器必须带有界高度与独立 `overflow`，Agent 装多少都不得把下方的 prompt 推下去。这条由 `apps/desktop/test/surface-scale-contract.test.ts` 守住——它判 `.agent-catalog` 的规则体里 `max-height` 与 `overflow` 同时在场（先断言确实扫到了这条规则）。守的是"有界"这件事而不是 268 这个数：把数字抄进测试等于同一个值住两处，改一处就漂 |
| Settings Pane | 两层容器，不是一层：**可操作/主内容**卡＝`--surface-1` + `--elev-2` + `--hl` + `--radius-lg`（抬起）；**信息/次级**块＝与页面同底的平铺 `--surface-0` + 一条 `--line-soft` 发丝线，无阴影、不成盒。卡片/区块标题走 `--fs-title`(14)，说明降到 `--fs-meta`/`--text-3` 读作从属；区块头句首大写 `--text-2`，不叠第三层大写字距 | 此前一条规则把合成器、只读说明、执行器分组、工作区列表压成同一个平面，于是整屏一样重、读不出主次——两层的"抬起 vs 平铺"对比**就是**这次重做。**装饰性 hero 说明卡已退役**（见控件语言"装饰性强调图标格"）：绿只留给状态与唯一主操作。侧栏选中＝干净 Surface 填充（`--surface-2` + `--hl`，与 Project Rail active 同语汇），绿落在该项图标或 `aria-current` 上，**不画整圈描边**——侧栏本身是 `--surface-1`，往选中态填 `--surface-1` 等于没填，会让 hover 反而比选中更"实"。每节导航前缀图标各不相同，予以保留。入场用 `--dur-enter`/`--ease-enter` 的淡入上浮，不做长时遮罩揭幕或光标跟随——那类破坏工具身份 |
| 操作与元数据文字 | 11–13px；微标不低于 10px | 不用 7–9px 冒充密度 |
| Terminal / Editor | Terminal `12px / 1.0`；Editor `14px / 21px` | 由 xterm/Monaco 原生 DPR 渲染，不使用 CSS transform |
| Terminal replay recovery | 有界批次；批次间让出事件循环；连续 live bytes 合并成视觉批次；输入/切换控件不被输出队列饿死；切回时按视口记忆停在上次位置或最新输出 | 大量 scrollback 恢复时优先保持界面可操作，避免一次性 parser 工作造成假死、逐字绘制或把回放过程暴露成从顶部滚落 |
| Terminal link span | 裸 URL 下划线只覆盖 ASCII URL 本身；相邻 CJK 文字/标点保持普通终端字形 | 链接边界属于交互合同（见 [`agentmux-desktop-interaction.md`](./agentmux-desktop-interaction.md) 的 Terminal 链接约束）；不因相邻中文输出改变 URL 的目标或悬停范围 |
| Terminal restart projection | Runtime 未确认期间保留布局但在 Region 内显示中性等待/不可用状态；权威 snapshot 确认旧 PTY 不存在后清掉 Terminal Region/Tab，不留只有标题的空壳 | Terminal 没有 Provider-native semantic resume，不能把未知身份伪装成可用终端，也不能让临时探测失败变成永久空 Tab |
| Managed Hook notice | 服务窗/状态行；不覆盖 Terminal 内容、不抢焦点 | Hook 路径失效属于流程降级，Agent 仍可用；说明如何让当前 App 重新校正配置 |
| Provider capability notice | 服务窗/状态行；与 Managed Hook notice 共用告示槽 | Provider 的 Hook、resume 或探测能力缺失/降级时只在对应 Agent 旁说明，不覆盖工作面、不抢焦点；unsupported 与暂时 unavailable 必须分开，不画一个看似可点击但必然失败的 Resume 按钮 |

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
- **Agent 字母牌**（叠压头像簇里同 provider 多个 Agent 的判别器，行为约束见 [交互合同](./agentmux-desktop-interaction.md#寻址与复制) 那条"多个 Agent 并排且只有图标时"）：沿用项目字母牌**同一套**视觉语汇——`--fs-micro`、`font-weight: 640`、`line-height: 1`、`overflow: hidden`（emoji 比字母宽，会撑破格子），色相走既有派生并在规则里**声明**默认值（不藏进 `var()` 兜底，全表守卫读的是声明）。**不为它新挑一套尺寸或配色**：两处答的是同一个问题（开放集身份要稳定且认得出），各挑一套就是同一个决定做了两遍。
  - **10px 不需要豁免，它就是刻度的最小值。** 曾在此写过「字母受 10px 下限约束、须先放大头像格」——那是把「低于 10px 需要具名豁免」错记成「10px 需要豁免」。事实：字号刻度含 10（`--fs-micro`），而 `FONT_SIZE_EXCEPTIONS` 被恒等断言冻结在 7px 且每条都必须真画 `content` 字形，所以字母**根本走不到也不需要**那条豁免路；`.project-rail-row__icon[data-monogram]` 正是在 **16px** 格子里画 10px 字母，一直合规。**头像格不必为字母放大**。这条更正的意义不止于本条：涉及尺寸的约束必须从刻度与守卫的断言反推，"我记得有个下限"不是判据。
  - **一个格子里放第二个记号，本仓的既有答案是角标溢出而非扩容。** 注意力那枚 `?`/`!` 就是这么做的（8px 见方、`top/right: -3px` 探出格外），因此第二个记号不以牺牲品牌图标为代价。字母若落在这个位置，须先解决与注意力角标的占位冲突（两者不能同时在右上角），这是一个**取位**决定，不是尺寸决定。

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
  selector.css    同一族列表行的共享表现层（容器 header + 行 + Agent 簇）
  dock.css        Tool Dock 这个容器本身及其 Topics / Agents 面板
  file-explorer.css   被塞进工具槽的文件浏览器：Explorer 头、搜索、文件树、文件列表
  source-control.css  Source Control 面板：Branches 与 Changes 两视图及其共用外壳
  workbench.css   Pane、Region、分屏、拖放
  terminal.css    终端表面与它的状态覆盖层
  session-connecting.css  Connecting 与 Session 恢复的 Region 状态舞台
  surfaces.css    Settings、New Tab、Launch、Welcome
  board.css       Board：Branch/Topic × 状态矩阵、扇出条、Board 工具清单、Discussion 画布
  global-board.css  Global Agents Board 的 demand/session 列、工作区和 region
  focus.css       Focus 三段工作面：历史、状态、选中的 Session
  pmo-teams-topic.css  PMO Teams Topic 的悬浮窗口、标题栏和 compact 入口
  browser.css     Browser 工具与地址栏
  agent.css       Agent 会话外壳、状态栏、Provider 选择、权限卡点
  composer.css    Composer——Agent 那格底部的输入条
  activity.css    Activity 时间线、机器步骤与标尺
  activity-conversation.css  Activity 对话回合与 Markdown 内容
  workflow.css    Workflow 观察画廊：组件目录、章节与流程图
  conversation-avatar.css    两条对话轴共用的说话人身份标记
  conversation-axis.css      说话人轴与 this-agent 轴（标尺之上的身份轨）
  overlays.css    Dialog、Context Menu、Quick Switch、Tooltip
  agent-panels.css  Agent 的 Portal 面板（花名册、计数树、资源用量）——紧跟 overlays
  agent-avatar.css  执行器头像的 Provider 轮廓、角标、状态、计数与设置预览
  full-page-loading.css  启动与全页 loading/recovering/failed 大屏的网格、切片、品牌层和动效
```

这张清单由 `stylesheet-organisation.test.ts` 钉住：文件名集合必须与 `index.css` 的 `@import`
列表逐一对上，拆一刀而忘了改这里当场红。描述那一列不锁——它是写给人看的判断，不是清单。

约束：

- **`:root` 只有一处**，在 `tokens.css`。其余文件不得声明全局 token，只能引用。
- 分文件是**按表面切**而不是按属性切（不设 `typography.css`/`colors.css`）——改一个表面时想看到的是
  它的全部规则，而不是在三个文件间来回跳。
- 入口按上述顺序 `@import`，层叠顺序即文件顺序；不依赖选择器特异性打架来决定胜负。
- 单文件超过 400 行时按表面继续拆，不靠注释分节假装分层。**拆出去的那一半要紧跟原文件 `@import`**——
  层叠顺序即文件顺序，排到别处就不是搬家而是在改层叠。守护就是上面那条文件顺序断言。
- **没有孤儿文件**：每个 `.css` 都要在 `index.css` 里 `@import`。一个没进入口的样式文件是死文件——
  规则永不生效，而契约测试会照常扫描它并放行。
- 契约测试读的是**整张表**（`test/helpers/styles.ts` 按 `@import` 顺序拼接），不硬编码单个文件路径；
  否则下一次再拆一刀，它们会扫到空内容却全绿。这条对**任何**读样式的测试都成立，不只是那几条以
  "contract" 命名的：一条判「某个 class 有没有规则」的断言，只要来源写死了某个 `.css`，它守的就变成了
  「规则在那个文件里」——而按表面拆分是常规动作。拆走之后红算走运，拆走之后恰好不再被覆盖就是静默
  失守。守护：`stylesheet-organisation.test.ts` 会扫出任何硬编码 `styles/*.css` 的测试。

## Agent 空间与身份呈现

- 新 Agent 的落点必须在当前可见工作面中可辨识，不能用 Tab 条上的相邻标题冒充屏幕右侧分栏。空间是否足够取决于分割后的可读宽高与内容用途，不仅比较面积；少动现有布局，不为自动整理持续重排。
- 自定义 Executor 与内置 Executor 共用名称、Provider 身份和状态语汇；详细 ID、归属与能力由检查面承载，不把完整机器元信息塞进窄 Tab 标题。
- 空间与启动流程降级沿用持续、中性服务窗，说明发生了什么、Agent 在哪里或是否尚未展示、如何恢复。空间决策、完整元信息与布局包边界见 [Desktop interaction](agentmux-desktop-interaction.md) 的“Agent 自助创建与空间操作”。

## 悬停菜单

- Split 与同类下拉菜单沿用现有按钮、箭头、菜单尺寸和选中语言；降低操作次数，不增加常驻控件。触发器与浮层之间的视觉间距不能成为指针操作的断点。行为以 [Desktop interaction](agentmux-desktop-interaction.md) 的“少一步操作”为准。

### 注意力与审查密度（2026-09-22）

- 行为、请求处理顺序和恢复边界只由 [交互合同](agentmux-desktop-interaction.md#注意力处理与结果审查闭环2026-09-22) 定义；本节只规定呈现。
- 全局 Needs you 入口和 Session 内交互卡使用同一套状态颜色、图标和文案；列表行优先显示 Agent/Session 身份、请求类型和摘要，数量放在聚合入口。
- 选中的请求复用现有交互卡和动作语言；提交中、失败、请求已过期与列表已空均有独立可读状态，不能只靠颜色表达。键盘焦点在下一项或入口按钮上可见。
- Diff、Browser preview 和继续对话使用结果附近的一组紧凑动作；展开内容才占用详情或 Region，静息时不制造空右栏。
- Context、Usage、Needs you 和 Error 保持不同语义表达；既有未知值保持中性 unavailable/unknown，不能用绿色或 0% 代替未知。本 Feature 不新增 Usage 数据源或仪表盘。
- 预览和审查入口沿用当前 Surface、Region 和服务窗语言；窄屏时可以收进动作菜单，但不能依赖 hover 才能使用。

## 非目标


- 不建设主题导入器、任意颜色编辑器、插件市场或通用扩展框架。
- 不为没有规模证据的虚拟列表、文件拖动或移动端布局预建状态。
- 不在正式设计合同保留来源路径、固定 commit、Copy/Adapt/Omit 表或已完成任务流水。
- **不引入 CSS-in-JS、Tailwind 或预处理器**。问题是"字面值没有名字"，不是"CSS 不够强"；
  原生 custom property 已经足以给尺度命名，换一套构建期方案只会在解决同一个问题的同时新增一层工具链。
- 应用外观支持深色、浅色和跟随系统；选择持久化，系统模式在系统外观改变时更新。全局 Surface、文字、控件和编辑器保持一致，终端调色板仍可单独选择。

- Shell 环境读取不完整时，复用服务窗的持续、中性、非模态告示；说明读取范围和恢复动作，不展示环境值、不靠 toast 自动消失。行为归属见 [Desktop interaction](agentmux-desktop-interaction.md) 的本地 shell 环境约束。

- 兼容但归属未确认的 Runtime 使用持续的中性服务窗说明，不使用错误弹窗，不阻挡已有工作面；归属状态不展示路径、PID 或凭据。

## Explorer 与快捷输入区

- 键盘入口与底部设置按钮相邻并保持相同控件尺度。Explorer 忽略项弱化但可读；链接以文件／文件夹图标叠加链接标记呈现，失效链接有可访问的说明，不显示 `link` 文字徽章。行为见 [Desktop interaction](agentmux-desktop-interaction.md)“Explorer 的真实文件与快捷键入口”。
- Agent 输入区采用紧凑文本区和一排具名快捷工具；文件、截屏、技能、指令可直接辨认。发送用上箭头，中断用举手图标并明确标注当轮含义，避免复用结束 Session 的实心方块；收起后保留轻量恢复入口与草稿提示。行为见 [Desktop interaction](agentmux-desktop-interaction.md)“可收起的 Agent 快捷输入区”。
- 展开/收起按钮与快捷工具同排并置于最左端，避免为单一开关增加独立占高；按钮保持与同排工具一致的尺度、焦点和 tooltip 语言。

## Projects 层级与活动语言

- 左侧菜单降低字重与重复装饰，状态栏内使用低对比语义图标和短标签承载 Agent 状态；数量作为辅助信息，不再由单点加数字承担全部语义。
- Branch 与 Topic 的 recap 使用同一紧凑摘要表面，放在工作线行的次级信息层，不抢主标题。
- Projects 栏与主工作区之间保留一条可拖拽的窄分隔带；悬停和拖拽时提高边界对比度并显示 resize cursor，静止时保持低干扰。宽度变化即时反映在项目名称、层级缩进与状态槽的可用空间中，结束拖拽后只持久化一个最终宽度，不增加第二份布局状态。行为约束见 [`agentmux-desktop-interaction.md`](./agentmux-desktop-interaction.md)「顶部与项目栏」。
- 分组使用轻量目录集合图标和分类标签；项目使用自身图标或仓库图标，普通目录用文件夹。每层缩进配合连接线，避免只靠文字亮度猜层级。
- running/error 汇总使用紧凑图标微标与短数字；hover activity 面板以小尺寸 Provider 图标、单行最近活动与停止时长构成，避免大块数字方框和空白。
- 运行状态采用细小节奏条和简短文案，尊重减少动画偏好；待处理采用有语义图标与原因短语，移除“点＋数字方框”和“数字＋叹号方框”。详情在悬停面板中显示 Agent 名称与状态，点击定位。行为见 [Desktop interaction](agentmux-desktop-interaction.md)“Projects 结构与状态可读性”。

## 本地文件查看与编辑表面

- 网页、图片与文本的展示应符合各自内容类型，沿用工作台已有控件语言；行为和范围见 [Desktop interaction](agentmux-desktop-interaction.md)“本地文件预览与按格式编辑”。具体工具栏与编辑能力在成熟产品调研后评审。

## 输入区 Context 监控

- 上下文余量使用工具行内低干扰的短标签，悬停说明容量、已用量与采样时刻；未知明确显示，不为监控单独增加一整行。行为见交互合同「当前 Agent 的上下文余量与输入焦点」。

### 紧凑状态与输入工具行（2026-09-11）
- running/error 状态使用低高度语义图标和紧凑计数，状态栏内保持低调层级。
- Activity 菜单减少行高和留白，在有限宽度内优先 provider、活动摘要、idle 时长。
- Composer 展开/收起按钮属于底部工具行的第一个控件，与其他快捷操作共享基线和间距。
- 一键 YOLO 使用单个低噪声的语义按钮，和 Executor 的其他启动设置放在同一层级；当前权限姿态仍以启动参数和 Provider 回执为准。

### Activity 工作线聚合与错误告示（2026-09-11）
- Activity 弹层默认按 Topic / Branch / Worktree 分组；一组只占一条紧凑的 context 行，头像簇重叠排列并固定在右缘，避免逐 Agent 平铺造成纵向噪音。分组行保留 28–32px 高度、8–12px 横向内距和单行摘要；展开明细才进入逐 Agent 视图。
- 聚合行的视觉顺序固定为“context 类型与名称 → 最近摘要 → 最紧要状态 → Provider 头像簇”。类型短标签（`Topic` / `Branch` / `Worktree` / `Unassigned`）与必要的路径/Host 元信息让悬停内容可读；头像只承载身份与参与者数量，状态颜色只承载最紧要状态；不重复渲染 `N agents`、`Current` 等可由头像或选中态直接读出的标签。
- 聚合行正文点击直接定位该组最需处理的 Agent；折叠/展开使用独立的小命中区，不让用户为了导航先逐个猜 Agent，也不把展开动作误解成发送或停止。
- 未分组 Agent 使用独立的“未分组”分区，不伪造 Topic 名称；跨 Host 的同名工作线不得合并。分组标题是分类标签，不做成可选中的 Project 行。
- transient 错误使用靠近窗口边缘但不覆盖内容的 notice surface（优先顶部或侧边的保留槽），最小 32px 高，带关闭按钮与 `aria-label`；关闭按钮命中区不小于 24px。错误文字允许换行但不得把 Terminal/Activity 内容推离视口，重新查看入口放在状态或诊断面。
- Service Window Notice 继续使用持久、非模态、无关闭按钮的服务窗语汇；transient notice 与 Service Window 不共享生命周期，避免把必须持续可见的降级事实误关掉。

### 重启恢复告示（2026-09-12）
- 重启期间保留原 Tab/Region 的空间骨架与焦点位置；连接中状态使用 Region 内低干扰短标签，不用空白面或新建 Tab 代替。
- Runtime 尚未完成 attach 时，告示必须明确“布局已恢复，正在连接既有 Session”，不得显示“在其他应用打开”这类会诱导用户重复 resume 的文案。
- 恢复回放的几何与未知状态遵循交互合同的 resume/attach 约束；尺寸不可确认或同步失败复用原 Region 的服务窗，不新增常驻尺寸控件。

### Composer 状态与队列密度（2026-09-12）
- 三态入口固定在左侧：一行态与输入同排，展开态在工具行起点；工具行与大输入框的入口位置一致。大输入框给出受视口约束的实际编辑高度，空内容也可辨；展开/收起图形表达下一动作，仍沿用无边框、低干扰控件语言。行为唯一来源见交互合同 Message Tools 三态约束。
- Context 使用紧凑徽标，不在输入区占据独立大行；hover 提供精确 token 与更新时间。
- Send、Interrupt 和 queued 数量共用一排工具控件，主动作保持清晰但不重复占据输入区。
- 工作中的 Composer 仍在同一排提供紧凑的 Send steer 与 Interrupt 两个动作；Activity 聚合行不重复打印同一状态，常态高度保持在 28–32px。
- 队列只显示短摘要与数量，展开后显示状态、顺序、失败原因和删除操作。
- 队列复用现有摘要与展开面板；在途、暂缓、旧 Run 不可投递分别可辨，动作按条目事实呈现，已在途不提供虚假的撤回。未投递原因在队列旁持续可见，不靠反复全局通知。草稿归属与恢复行为见交互合同，不另存视觉状态。
- **工具行必须能在窄宽度下收窄，而不是折成多行。** 窄到放不下时按「先丢文字、后丢控件」降级为图标态（tooltip 与可访问名保留全文），常态行高不因窄宽度而增加。Composer 所在的 Region 可被分屏拖窄，故这里量的是**该组件自己的可用宽度**，不是窗口宽度——用窗口断点会在窄分屏里完全不触发。折行是本条要禁止的形态：工具行折行会把主动作挤到第三行，也会让任何依赖「工具行只有一行」的避让一起错位。

## 持续推进观察界面

- 折叠只占一行：循环图标、Provider 图标、执行短状态、下次检查时间；不为 timer 增加常驻大面板或终端。沿用现有图标语言，Agent 卡片显示低干扰的循环标记与暂停原因。
- 展开轻量面板：目标与工作目录、任务链接、执行/循环两种状态、带来源时间的最近活动、最近/下次检查及倒计时、最近决定和回执、最近 5–10 条事件。无活动来源显示未知，暂停不显示伪倒计时。
- 暂停、恢复、停止循环、立即检查、设置和任务记录保持可达；停止循环与中断 Agent 的标签必须区分。错误有对象、原因和可操作入口，不出现无解释的空白面板。
- 调度、投递与完成规则只由 [Desktop interaction](agentmux-desktop-interaction.md#内置任务持续推进2026-09-12aftertime-使用需求) 定义。

### Session 重启恢复状态

- 重启恢复在循环行中以短状态显示（`恢复检查中`、`已恢复`、`需处理`），不复用 `working`/`error` 造成矛盾语义。
- 展开面板明确列出当前 Run、旧回执是否可用、恢复检查时间和下一步动作；旧 Run 活动不覆盖新 Run 的最近活动。

### Message Tools 快捷语法

- 工具行提供统一入口；`@`、`/`、`$` 的补全面板使用与 Session Composer 相同的紧凑菜单和来源标识。不可用能力显示原因，不占用单独常驻行。
- 初始页与已连接 Session 的工具视觉语言一致，差异只体现在项目上下文或 Provider 能力尚未就绪。

### 输入错误与浏览器选中态

- Message Tools 失败层覆盖工具行或其边界，短文案说明失败动作并提供重试，不弹大块全局方框。
- Browser Region 选中态使用与其他 Region 相同的低对比边框/标题强调，点击内容后保持可见，不增加额外装饰。

### Activity 展开密度

- 聚合行保持一行高；展开明细只保留新增信息，不重复标题、数量和状态。无新增信息的分组不显示空箭头。
- 明细使用紧凑单行摘要，Provider 图标和处理动作优先，减少空白与重复标签。

### 通知关闭状态

- 关闭后的相同通知保持收敛，不在底部反复冒出；重新查看入口保持低干扰且不伪装成新错误。

### Status Bar 与 Activity 密度

- Status Bar 用统一语义图标语言承载 Agents/Needs You/Error，数字仅作辅助；低对比但可识别。
- Activity 展开项只占用承载新增信息的高度；没有新增信息就不提供展开控件。

### Activity Agent 明细与 Agents 单入口

- Agent 明细采用紧凑两行：第一行 Project/Workspace 与 Provider 图标，第二行状态、最近活动、时长；统计信息用短徽标，不堆叠大数字。
- Agents 入口在左侧统一承载，右侧不再重复显示同一 roster；状态栏只保留跨窗口摘要。

### CPU/Memory 面板密度

- 资源面板使用紧凑列表行，优先显示对象与 CPU/Memory，Project/Workspace 和 idle 时长作为次级信息；总览仍保持一行摘要。
- 沿用 Agents/Activity 的 Provider 图标、圆角、行高和 hover 说明，避免出现第三套列表视觉语言。

### 2026-09-12 资源面板密度
CPU/Memory 面板复用 Activity 行的紧凑列表语言：一行一个 Agent，首行身份，次行项目与状态，指标靠右；默认折叠，展开后不重复冗余标题。

### 2026-09-12 Region 移位菜单
Region 移位属于低频布局动作，放入右键菜单，不增加常驻按钮；菜单项使用简短动词并在 hover/子菜单中呈现可用目标。

### 2026-09-12 Hover 说明
低频图标按钮的解释放入 tooltip，正文保持紧凑；tooltip 文案同时说明动作和快捷键，避免用户多次试错。

- Tab 排序与 Region 拆分使用不同的 drop affordance：排序保持紧凑，边缘方位才显示拆分目标；Split 默认向右，方位菜单沿用全局组件。

### 整合版本：消息续聊与图片

- 消息动作保持低调，提供从当前消息继续到新会话的入口；明确标为可见对话上下文续聊，不冒充 Provider 原生 fork。图片附件用紧凑缩略图，保留引用复用入口；加载失败仍显示路径与原因。行为见 Desktop interaction 的整合版本约束。

### Message Tool candidate density
候选菜单统一复用 Message Tool 的浮层，不改变工具栏高度；菜单有边界和内部滚动，方向键与 Enter/Escape 操作一致。候选项以紧凑的图标、名称和一行辅助信息呈现。

按来源分段时，段标题沿用本仓已有的**分段标题语汇**（micro 字号、大写、字距、次级文字色），不新造第二种标题形态；标题在滚动时吸顶，使长列表里当前段的归属始终可见。**只有确实存在两个以上来源时才出现标题**——单一来源加标题等于给一份列表起个多余的名字。段序由候选自身的拼装顺序决定，不另立一张优先级表。

候选项重名时必须能看出**是哪一个**：同名但来自不同来源的两条（例如不同插件各带一个 `configure`）要带上足以区分的来源标记；而**同一条** skill 被同一来源重复收进来若干次（安装缓存与市场副本并存、镜像目录各算一遍）不是"需要区分"，是不该出现第二条——前者靠标注解决，后者靠去重解决，两者不是同一个问题。

### Composer 静息密度与主操作
静息态是**一行**：空输入框不占两行高。一行态是最安静的形态，其控件密度也必须最低——切换键在一行态同高但更安静、不带重边框；两行与大输入框档位才允许更强的存在感。Send 与 Interrupt 以不同图标呈现：发送用上箭头和推进色，打断用举手与中性色；结束 Session 等生命周期破坏性操作仍用危险色，不把打断当前回复画成会话销毁。

**一行态里那一行文字垂直居中，不下沉贴底。** 用户原话：「message tool 只有一行时，文字下对齐会导致视觉不均衡」。一行态是网格布局，行高由较高的工具列决定；那一行文字必须在这个行高里垂直居中，不能沉到底部留出上方空档。工具与主操作控件仍锚在底部（编辑区涨到多行时它们留在下缘才对），这与文字居中不矛盾。


### 分层人机交互的呈现

交互行为以 [Provider 与人机交互的分层收敛](agentmux-desktop-interaction.md#provider-与人机交互的分层收敛) 为唯一约束来源。输入结果、待答请求、服务窗和注意力摘要复用现有控件语言：紧凑图标、对象、原因和可执行动作；只在有信息时展开详情。持续问题不遮住可用终端或占据重复全局弹窗；提示与原对象可互相定位，并保留键盘操作、IME 和无障碍名称。

### Gallery 到聊天页的生产替换

- 生产聊天观察区与 Gallery 使用同一套 Workflow surface、密度和状态表达；不为聊天页复制一套视觉实现。
- 聊天页适配层只负责把真实 Activity/Run/Agent 事实映射到公开 props；缺失或未知事实保持未知，不用 Gallery 示例值补齐。

### 语义图标密度与性能

- semantic icon 按状态、对象、动作、导航、层级五类组织；同一语义在 Gallery、Workflow、Activity、聊天状态栏中使用同一几何和尺寸契约。
- 动态/组合图标仍是同一体系的成员：动画只表达状态变化，静态状态不启动动画；减少动画时退化为稳定 glyph；组合图标共享同一 viewBox、对齐基线和命中区。
- 图标组件默认不创建额外状态、不订阅 Store、不触发布局测量；映射表和 renderer 保持模块级稳定引用，避免列表滚动时重复创建图标定义。
- 同一语义在不同 surface 可以有尺寸和动画差异，但不能与另一语义落成相同 glyph；视觉区分优先于装饰统一。
- 动画是语义的一部分：运行、完成、失败、暂停、排队等状态使用各自合适的局部动作，静态终态不启动无意义动画；所有动作都必须有 reduced-motion 静态退化。

### 最终观察面视觉统一

- 聊天观察区采用 Workflow 的“时间线 + 分层 surface + 状态轨道”语言，但保留对话正文、权限请求和 Composer 各自的内容密度。
- 惊艳感来自层次、对比、细微动势和状态反馈，不来自大面积渐变、过重阴影或装饰性卡片堆叠。
- Gallery 必须展示最终生产组件、真实公开 props 和全部关键状态，页面结构与聊天页保持一一对应，便于快速回归。

### Project Rail 与 Topic 行密度

- Project Rail 的所有树层级采用同一个 `--rail-depth` 公式；group header、project row、pinned child 不再各自补缩进。Pinned child 的标题比普通项目小一档，hover 只使用下划线，不使用项目行的 Surface 填充；它和所属 Project 之间用一条低对比、断续的连接线表达层级关系。连接线是结构提示，不得复用选中、running、needs-you 或 error 的颜色与动效。
- 用户原话（2026-09-19）：「左侧项目菜单的缩进有点多, 图标有点大, 每个项的高度有点高了, 可以更加紧凑些, 或者在顶层的 projects 上的加号旁边增加一个组件, 调整紧凑程度」。
  三项各自独立可调：**每层缩进**、**行图标尺寸**、**行高**。默认档必须比 2026-09-19 之前更紧（当时是每层 16px 缩进 / 20px 图标框 / 28px 行高），且三者必须**同一个密度档一起变**，不允许出现「行变矮了但缩进照旧」的半档。
- 密度档由用户拥有，控件落在 Projects 标题行的加号旁；它是**可见的常驻控件**，不是隐藏偏好，也不进设置页——用户要在看着树的同时调。档位数保持极少（默认、紧凑、更紧凑三档），不做无级滑块：滑块要求用户自己找一个好值，而这件事只有几个稳定好值。默认档的层级缩进要比旧实现克制，额外的更紧凑档继续同时压低每层缩进、图标尺寸和行高。
- 密度档是 durable 的：重启后仍是用户选的那一档。缺席即默认档，不回写。
- 通知胶囊默认保持 icon+count 的窄态，hover/focus 才过渡到 icon+count+label；状态颜色只作辅助，图形和数字始终存在。
- Topic 行的 pin、Agent presence、Region mosaic 和标题按固定轨道排列；pin 与标题相邻，Agent presence 与其对应的 Tab/Region 在同一语义组内。

### Agents、队列与语义 token 密度

- Agents 菜单默认一行对象 + 一行最近动作；Provider/配置/路径降为次级信息，只有事实不足时才显示状态词。
- running 使用稳定静态 glyph，working 使用带节奏的动态 glyph；两者不能只靠颜色区分。
- 队列默认显示短消息、状态 glyph 和数量；展开后提供明确的删除/立即发送动作，失败项使用 warning/error surface，不自动反复闪烁。
- Message Tools 的 token 使用短名和下划线，不把完整 URL/引用文本直接塞进正文；不同 token 类型用形状/前缀/辅助色区分，完整引用只在 hover/详情中出现。
- 识别词命中沿用**同一套下划线语汇**，不新造第二种视觉：它与已插入的语义 token 的区别在于它仍是可编辑正文（尚未替换），故不取 token 的实心/前缀形态，只加下划线提示「这个词可以展开」。提示条与候选菜单复用 Message Tool 的既有浮层与紧凑菜单，不占用输入区的常驻行高。

### 可复用对话与 Workflow 组件密度（2026-09-15）

- Workflow 时间线沿用聊天 Activity 的低干扰行语言：普通 tool 行与 Workflow 卡片共用时间线缩进和折叠箭头，不额外套一层装饰性外框；只有输入框上方 dock 作为独立浮层保留 surface、圆角与内部滚动。
- 组件密度固定在 `--fs-micro` / `--fs-meta` / `--fs-body` 三档与 2/4/6/8/12/16px 间距刻度内。状态徽标、模型短名、最近工具、耗时、token 和调用次数使用 `tabular-nums`，数字不因状态切换跳位。
- Workflow 头部的 progress rail 是结构性进度，不是选中指示；选中阶段或 Agent 使用整行轻量 surface、`aria-expanded` 和焦点环表达，不使用重复的单边竖条。状态颜色只承担语义，失败/终止/暂停仍需字形或文案。
- Agent 行默认一行：状态字形、label、模型短名、最近工具、耗时、token；打开后才显示阶段、尝试、排队/开始/最近活动、工具调用等新增信息。展开面板用两列 `dl`，不重复标题和状态。
- 超过 8 个 Agent 才进入双列 grid；超过 12 行且尾部连续安静项才显示“还有 n 个”。失败项与当前运行项始终优先可见。≤560px 隐藏模型与最近工具，头部数字换行到第二行；触屏控件最小命中区 44px。
- 同一 Workflow 组件通过 `dock` 变体复用结构，仅收紧模型和行高并限制 `max-height: 220px`；不得为 dock 维护另一套状态投影。旧 daemon 用 flat tool 行样式，无箭头、无空卡片。
- Gallery 是组件的唯一观察表面：它可以切换 light/dark/system，集中展示 running/completed/failed/killed/paused、窄屏和旧 daemon；展示数据是静态 fixture，不引入 Runtime 或 Chat Store。未来聊天页只消费组件公开 props。

### 真实对话与行内引用（2026-09-16）

- 对话与 Gallery 使用同一消息组件：身份、安静时间戳与语义状态组成摘要，用户正文保留轻量 surface，Agent 正文保持开放阅读面；沿用 Workflow 的层级、间距和状态字形，不给每句话另套卡片。
- 引用短名在输入正文中原位呈现，下划线提供可操作暗示，类型由字形和名称共同表达；焦点可见，窄窗不横向撑宽。功能与恢复约束见 interaction「对话接入新组件与输入引用闭环」。

- Browser 的应用链接提示是工作面级服务窗；外部应用交接请求来自嵌入 frame 时，提示仍挂在当前 Browser，不新开不可追踪的窗口，也不改变地址栏。提示按通用 scheme 与用户选择表达，不出现站点或厂商专用文案。
- Browser 工具的逃生口不能用“无内容返回”伪装成功：`cdp` 的结果要回到脚本，协议异常要以可读失败呈现。工具反馈的密度服从同一条原则——能继续行动的结果与需要重新规划的失败必须可区分。

### Browser RSI 操作表面

- Browser 操作条是一个低高度的状态 rail：头像、Agent 名称、动作短名、目标 ref 和阶段组成一行；脚本正文、参数和完整结果进入展开面板，不把工具调用堆在页面上。
- Agent 接管和交还使用同一条身份语言：驱动时显示头像与“正在操作”，人接管后变成安静的确认态并保留最后一步；不靠颜色或呼吸动画表达唯一事实。
- 当前操作位置使用语义目标标记（ref、role、可访问名或页面内目标框），不显示猜测的鼠标坐标。标记不能遮挡页面，也不能阻止用户点击交还。
- Browser timeline 与聊天 timeline 共用 20px 节点槽、时间 ruler、状态 glyph 和折叠规则；连续的低价值 CDP/等待步骤可合并，但脚本、用户接管、权限等待、失败和不确定结果始终可见。
- 回放入口显示“预览 / 单步 / 运行”三档动作和停止按钮。回放脚本的来源、页面身份和人工闸门在入口附近可见，避免把一次重放误认为普通刷新。
- 历史入口与操作条同层可达，不要求先发生新操作。记录不可用时沿用紧凑、持续的服务窗；被隐去的敏感步骤保留行号、原因与确认状态，不能在预览里消失。行为以 interaction 的“人工闸门”及“历史可达，记录失败可见”为准。

### Browser 控制权提示（2026-09-19）

- 操作指示采用紧凑、低饱和的浮动状态条，统一字重、细边框与轻阴影；用明确文字和状态图形表达控制权，不能只靠呼吸灯或颜色。页面内容保持可读且可操作。
- 交还用户时改为安静的确认态，不继续显示 Agent 忙碌；尊重减少动态效果偏好，窄窗保持在视口内。行为真源见 interaction「Browser 通用交接闭环」。

### Message Tools 身份与切换稳定性（2026-09-20）

- 身份在右侧，仅保留 Agent 头像，不与左侧功能按钮混排；全名与状态进入提示和可访问名称。行为以交互合同的 Message Tools 身份约束为准。
- 用户反馈「换左下角切换图标的时候，高度好像不一致，导致高度在抖」。三态共用等高的工具命中区和纵向对齐；一行态的低干扰只通过视觉权重表达，不再靠缩短按钮制造高度差。仅编辑区按三态改变高度，工具行不能因换图标、隐藏文字或切换状态额外跳动。

### Message Tools 邮箱（2026-09-20）

邮箱使用直观的信封图标，与右侧 Agent 头像组成一个紧凑入口；位置不受左侧工具展开/折叠影响，不再散成两个独立小图标。未读用静态红点，不能用告警色整块高亮代替红点。发件数量独立呈现，不和未读数相加。浮层中收件通知、发件列表共用一个容器和两项切换，内容可滚动且受视口约束。会话入口与其他控件等高，一行态也不消失；通知到达和阅读不能撑高输入框。行为约束见交互 SSOT 的“Message Tools 邮箱”。

### 输入框图片（2026-09-20）

截图/粘贴图片在输入文本流中显示等高缩略图；一行态保持原行高，展开编辑时缩略图随内容流排列。图片比例保持，点击可放大，不能用长路径挤占输入区。读取失败仍显示引用文字。行为见交互 SSOT 的“输入框截图缩略图”。

### Message Tools 右侧操作整体（2026-09-20）

用量、主操作、邮箱和头像读作一条紧凑操作组，共用连续底色与圆角边界。点击区 24px 等高、图形视觉等距；静息不各自画色块，hover、键盘焦点和展开态保持可辨。

主按钮占一个固定点击格：空闲上箭头，执行中实心方块并保持中性平面样式。行内图片高度跟随正文行高、宽度依内容比例，不强制方框。

头像中央 Provider、左上自定义角标、右上状态、右下数量互不挤占；描边沿图形透明轮廓，不画外接矩形。运行状态不改变中央身份色。running 用安静蓝色空心标记，working 用绿色活动标记，颜色和形状同时可辨；正常结束保持中性，真实错误才红色。未读红点归独立信封。行为与执行器设置范围见交互 SSOT 同名小节。
已保存的 Executor 头像沿用同一套尺寸、角标和珐琅规则，设置入口移动不改变其显示；旧 Appearance 记录仍以原 ID 显示，不伪装成新 Executor。

### Branch Pin 的层级与操作位（2026-09-20）

固定分支的标题左缘沿用所属 Project 的折叠槽、图标槽和密度刻度，再深一层；不能因为缺少图标而退到父级左边。Pin 按钮缩小内边距，未悬停或聚焦时不占操作位，悬停或键盘聚焦后才为按钮留空间；已固定状态保留安静的视觉提示，不用常驻大按钮挤压名称。行为约束见 desktop-interaction 的同名小节。

## Topic 行的 Region 与 Agent 在场状态（2026-09-20）

选中 Region 的绿框只需 1px，保持四边可见且不增加叠加光晕；原生 Browser 为焦点环让出的尺寸必须与同一宽度一致。Topic 的 Agent 图标缩小放在对应 Region 格子里，形成一个整体，几何仍表达真实分屏；窄格内不得溢出覆盖相邻格。Agent 状态与可见性语义见 desktop-interaction 同名段。

### Message Tools 主按钮密度（2026-09-20）

主按钮保持同一点击区：发送箭头与执行中的实心方形互换，后者保持中性平面样式与 hover 反馈。行内截图不用固定方形框，保留比例并限制在一行文字的高度。此约束替代此前 Send steer 与 Hand 并排的提议；行为见 desktop-interaction 对应小节。

### 全局通知与底部状态入口

- 底部 Working / Needs you / Error 的列表展开按钮共用紧凑尺寸、对齐和组内间距，不能露出浏览器默认按钮的灰底、边框或 padding。图标居中，hover、键盘焦点和展开态都清楚可见。
- 全局系统通知收起为固定紧凑入口，未读标记只在该入口上；展开内容沿用系统通知的语言与密度。收起、已读和问题解决的行为约束见 desktop-interaction 同名条目。

### 图标与打断按钮复查（2026-09-20）

- Executor／Agent Provider 图形用很细的外轮廓描边，不得画背景光晕、模糊发光或状态扩散阴影。
- 外描边必须像珐琅徽章：Provider 与左上固定 Icon 先合成相对实面的轮廓，镂空下方由不透明中性底片承托；底片比图形向外多出 1px，最外沿再加清晰、不透明的 1px tint 描边。图形本身颜色和细节保持原样，tint 不能铺满原图，也不能在镂空内侧重复描边；没有自定义 tint 时不增加彩色轮廓。
- 禁止在这层轮廓、外层容器及连接／恢复页继续叠加 drop-shadow、模糊或半透明发光；working 和 attention 同样不例外，状态只由右上共享标记表达。实际渲染必须能看见实体底片与外沿之间的层次，而非荧光。
- 固定 Icon 选择位于左上；右上只表示状态，右下只表示数量，三者不得重叠。Icon 与 Provider 图标先合并再描边，设置预览与菜单／实际 Agent 入口保持同一位置。
- 打断仍为与发送共用同一点击格的实心方形，但不涂黄色底或独立强调色块；保持功能组的平面中性风格，hover／focus 仍清晰。此要求取代此前琥珀色提议。

### Session 加载页的动势（2026-09-21）

用户希望「动感更强更帅，有后现代和解构主义的感觉」。用错位字组、切片线条、非对称构图与有节奏的扫描／位移动效表达等待；沿用现有暗色与强调色，不用整屏高亮闪烁。Executor 和初始 Prompt 保持稳定、清晰、可选择；复制入口紧邻 Prompt。窄分屏能滚动读完整内容，系统减少动态效果时保留静态构图。

### Connecting 与 Terminal 恢复页的动态构图（2026-09-21）

- **全页的含义是占满当前 Region，不是遮住整个 App**。舞台使用 `--surface-0` 到 `--surface-2` 的深浅层次铺开内容区，Titlebar、Tab、Project Rail、Tool Dock 和分屏边界继续可见；这样用户始终知道自己在原来的工作面里等待。
- Connecting 的构图采用三层：底层是低对比度的 Graphite 网格/切片，中层是错位的注册标记、斜向扫描线和不对称框线，前层是稳定的 Executor、阶段标题和 Prompt。动效只作用于中层与注册标记；前层内容保持可读、可选、可复制。
- Terminal 恢复在无画面时可使用同一构图，但把“重建屏幕”的几何作为主角：空终端框、行列刻度、缺口标记和单向扫描表达重放与尺寸确认。已有画面时不再铺满动画；只保留顶缘/侧缘的细扫描和一条服务窗，终端输出仍是视觉第一层。
- Connecting 与 Terminal 恢复使用同一色温而非同一状态色：品牌 Mint/Green 表示正在建立或重建，灰白表示已确认的身份与文本，红色只表示真实失败，琥珀色只表示需要用户处理。动效不能承担状态判定。
- 动势是“建立秩序”而不是“播放等待”。切片有轻微错位和回收，扫描线单向通过注册点，完成时所有线条向真实终端边界收敛；不使用整屏闪白、随机故障噪声、持续高频抖动、伪进度条或无意义的数字倒计时。

### Terminal 内容层与输入层的清晰边界（2026-09-22）

- Terminal 输出是第一视觉层，保持连续的等宽字形、明确的行高和稳定的 cell 几何；点阵、网格、扫描线等装饰只允许出现在没有输出的状态层，不能透进已有文本或 Composer。
- xterm 容器必须由唯一的尺寸 owner 测量，宽高、margin 和可见性不能互相叠加出第二个画布；冷停/恢复时的旧 canvas 要么隐藏并不接收指针，要么完整释放，不能留下半透明残影。
- Composer 是独立的输入 surface，使用自己的背景、边框和最小高度；它与 Terminal 之间保留一条可见分隔，不把输入占位、工具按钮或动画混入终端滚动区。
- 窄栏和 reduced-motion 下仍保留输出、光标与服务窗的可读层级；恢复成功后移除状态层，不留下空白 chrome 或无意义的装饰纹理。
- 舞台至少在 320px 和 420px 窄分屏保持可读：锚点内容按纵向流动，Prompt 可滚动，复制控件保持命中区；不把动效元素放在文字上方造成遮挡。更宽的 Region 才增加非对称留白和第二组注册标记，不改变信息层级。
- `prefers-reduced-motion: reduce` 下保留一帧完整的静态构图：扫描线停在可见位置，注册标记和当前事实仍可辨；移除位移、呼吸与扫描循环，但不把舞台退化成通用 spinner 或空白。
- 动效只在状态边界发生变化时入场/收敛；长时间等待使用低频呼吸，不重复重启动画。真实 attach 或恢复事实到达后，过渡应短而克制，避免用户把视觉完成误认为 Runtime 已完成。

### Executor 身份一致性（2026-09-21）

具体 Agent 的图标在各处保留同一 Executor 颜色／角标与默认底图，密度变化只调整尺寸，不丢身份定制。标识编辑控件嵌入该 Executor 配置，不归全局外观；行为归属见交互 SSOT 同名条目。

### 全局 Board 与 Leader Topic 浮动入口（2026-09-22）

浮动入口是低干扰、可拖动、始终可达的单一 Leader Topic 控件；它与全局通知入口分开，不用状态颜色替代身份，也不因打开 Topic 改变工作区布局。入口展开后复用普通 Session 的对话表面，用户能看见 Leader Topic 的 Executor 身份、运行状态与恢复提示。

全局 Board 的任务卡以任务标题和目标 Project 为第一层信息，任务状态、最近 Attempt/Agent 和 Session 上下文为第二层；不要把同一 Session 复制成多条 Agent 行。跨项目上下文用简短的 Project/Workspace/Branch/Topic 路径表达，窄窗优先保留任务标题、状态和目标 Project。行为约束见 desktop-interaction 的“全局 Board 与可配置默认 Session”。

Board 的 `New Demand` 使用紧凑文字图标按钮，打开居中的 Leader Topic 对话浮窗；入口行为归交互 SSOT，不增加空卡表单。

### Leader Topic 入口的浮动与收纳（2026-09-22）

浮动入口使用单一紧凑按钮、轻阴影和清晰焦点环，拖动只改变停靠位置，不改变 Leader Topic 身份或注意力语义。收起后，入口缩小并与底部 Agents / Session / Board 按钮同组，保持独立的命中区、间距和 tooltip；不能用一个叠加图标同时承担“打开 Board”和“打开 Leader Topic”。窄窗中优先保留两个图标和未读提示，文字标签可以隐藏；空间不足时保留图标，不把入口删除。

未读/需要处理提示只使用一个静态角标或数字，不使用持续动画；与系统通知、Agents roster 共用颜色和形状语义。行为约束见 desktop-interaction 的“Leader Topic 入口的浮动与收纳”。

### 全局 Board 的三栏任务闭环（2026-09-21）

中间 Board 保留稳定的列标题、数量和加号入口；卡片第一眼读到 Task ID、标题、目标 Project 和 Task 状态，Attempt/Agent 活动压到次级行，超过可读数量折叠为“还有 n 个”。顶部筛选条保持一行低高度，搜索、Project、状态、优先级、标签和归档筛选不抢占任务卡空间。

右侧详情采用固定侧栏，不用弹窗遮住 Board；详情、文件、变更、Activity 和对话使用同一容器与 tab 语言。左侧“来源与依据”默认收起为按需抽屉，只有确有原始需求、路由理由、外部引用或待确认项时才占用空间，长文本进入右侧阅读面。窄窗优先保留中间任务标题/状态/Project 与右侧可回退的详情抽屉，不能让三栏同时压缩到不可读。

Task 卡的视觉质量高于参考实现的默认卡片：任务身份、目标 Project、状态和下一步动作形成清晰的第一阅读层；Attempt/Agent 活动用紧凑的执行 rail、头像和时间形成第二阅读层；进度、依赖和阻塞原因使用局部标记，不把卡片堆成信息表。选中卡片用完整轮廓和轻微层级抬升表达，状态颜色只做语义补充；动效用于真实执行变化，不能用装饰性发光掩盖状态。

编排 Agent 的浮窗与任务执行面板保持两种密度：浮窗优先对话连续性，执行面板优先任务事实、Attempt 和可操作的下一步。二者共享身份、状态和项目标识，但不复制同一段消息。

### Task 详情中的 Session Region 投影（2026-09-21）

右侧 Task 面板以 Region 为基本单位：一个 Session 占一个 Region，多个 Session 复用现有分屏/网格的几何语言。每个 Region 顶部保留轻量 Project/Workspace/Branch/Topic 标识和“进入项目”按钮，按钮与终端/对话区域分开，不覆盖内容。

投影默认使用观察密度：保留真实输出、状态、最近活动和进度，隐藏会改变 PTY 的输入工具与独立尺寸控制。详情面板中的多个 Region 共享同一身份、状态 glyph 和时间语言；当 Region 数量超过可读范围时，通过 arrangement/折叠入口表达，不把卡片压成细条。

行为约束见 desktop-interaction 的“全局 Board 的三栏任务闭环”。

### 默认 Topic 与确认开关（2026-09-21）

默认 Topic 的表面要让用户看见它正在积累“项目路由与确认依据”，但不把知识库画成第二个聊天窗口。浮窗中使用一个紧凑的确认策略控件，显示当前模式：`按风险确认`（默认）、`全部确认` 或 `默认直接创建`；控件与 Task 草案的 `needs confirmation` 状态相邻，不能藏在通用设置深处。

Task 草案的视觉顺序固定为：原始请求摘要 → 候选 Project 与路由理由 → 风险/待确认项 → 创建策略 → 确认或创建动作。用户确认后显示短 receipt 和“已记录到默认 Topic”的可追踪提示；知识库条目在来源与依据抽屉中以紧凑记录出现，包含时间、决策和关联 Task，不能重复铺开整段对话。学习到的风险/Project 建议使用“建议”标签和依据数量，不用高亮或动画暗示它已经是真相。

### 成熟产品界面的控件与分组（2026-09-21）

Board 默认使用“工作面优先”的密度：去掉营销式大标题、hero 文案和底部页面切换器，首屏从任务列与当前详情开始。全局工具栏控制范围、搜索、筛选、排序和默认 Session；操作组使用紧凑的 segmented control、图标按钮和少量文字动作，不把每个动作包进彩色胶囊。

页面层级靠留白、字号、对齐和单一选中信号建立。Surface 使用中性深色层、hairline 分隔和很小的状态色面积；禁止多彩渐变、发光轮廓、连续彩色线框和无语义的装饰图标。Project 色只在身份点、短边或状态标记上出现，不能铺满整卡。

任务分组只有三种稳定语义：Task 状态列、当前 Task 详情、执行 Session Region。每一个区域都必须有可回答的问题和明确的退出/收起动作；“页面 01/02/03”“MVP 原型页面”这类演示性分组不进入产品表面。浮动入口和右侧 Inspector 是同一工作面的附着层，不能被视觉处理成三个并列产品。

Task drawer 打开时仍保留 Board 的列和上下文，宽度变化由 drawer 占用空间或覆盖边缘完成，不通过路由跳转或整页重排制造“详情页面”。Session Region 沿用当前 Agent surface 的身份、输出密度和 attachment 事实；只增加观察层，不复制终端 chrome，不画成新的产品卡片。

Default Session 浮窗直接复用原生 Topic Tab/Region：顶部是既有 tab/chrome，中间是既有 Session 内容，底部是既有 composer。不要再画一套客服式的消息卡、头像、欢迎语、独立 Task 卡和复杂确认表单；确认策略只保留一个紧凑设置入口，Task 写入状态使用一行原生通知或消息标记表达。

Topic Wiki 注入只在原生 Topic chrome 里以一个轻量状态表达，例如“Wiki · 已加载 12 条规则”或一个可检查的注入图标；不要把整份规则常驻在对话面板。用户点击后进入现有 Topic/Wiki 编辑入口，查看来源、版本、启用状态和最近修改；注入规则在 Agent 输出中只以必要的来源标记出现，避免再造一套知识库卡片。

### Board / Task 工作区的面性设计（2026-09-21）

Board、Task 工作区和 Topic Region 共享 AgentMux 原生 surface token：`surface-0` 作为工作面底，`surface-1` 作为卡片或 chrome 层，`surface-2` 只用于 hover、选中或临时控件。区域之间优先使用留白和 1px hairline；只有列间、Tab 边界、Region 头尾和真正的输入框保留线。

Task 卡默认是无边框的面，选中只增加一处统一焦点信号；Task 工作区是右半边连续的 surface，Session terminal 是其中的内容面，不再用“抽屉卡 → 执行卡 → terminal 卡”的套娃结构。任何新增边框、圆角、阴影或颜色都必须对应一个交互状态，否则不进入实现。

### 默认 Session 入口的原生复用（2026-09-22）

Leader Topic 入口只承担打开既有 `launcher:leader` Topic 的动作，使用现有 tab／region／composer 的密度和身份表达。浮动位置显示一个 36px 级别的紧凑助手按钮，按钮使用项目专属 low-poly 头像、可键盘聚焦并沿用同一份注意力提示；拖动坐标和 floating/compact 形态持久化。收起后与底部三项切换器同组，不再占用顶栏空位。Session chrome 不再额外画一套重复的内联入口。位置切换和收起动作只通过底部入口承载，不展开第二套聊天控件。

### 启动错误与 Executor 命名的表面（2026-09-22）

启动错误使用现有服务窗／错误面语言：短标题先说明失败阶段，正文给出当前事实和下一步，复制诊断是一个紧邻的次级动作。不能把 JSON schema 路径、堆栈或内部字段名直接铺成主标题，也不能用无尽 loading 代替解析失败。配置仍安全保留时，提示保持可读且不遮住已经恢复的工作面。

Executor 的主标签优先使用用户可读名称；内部 ID 只在详情、复制诊断和 CLI 精确操作中出现。多个同 Provider Executor 以名称、稳定身份色和角标区分，序号后缀不承担产品语义。启动恢复或配置修复时，身份标记保持一致，不因为字段清理而换成新的随机标识。

### Agents、Session 与 Board 的切换（2026-09-22）

底部中央使用一组低高度的 segmented switcher，只有 `Agents`、`Session`、`Board` 三个平级项；当前项用单一底色／下划线和焦点环表达。顶部右侧保留搜索、筛选和当前工作面的动作，不重复放三项导航。 Session 顶栏也遵循此规则；删除重复导航后不保留空的右侧占位容器。

三种工作面有清晰的第一层信息：Agents 先读 Executor/Agent 状态，Session 先读 Session/Topic/Workspace，Board 先读 Demand/Project/状态。Board 的需求列不混入以 Session 为主身份的卡片；需要看执行 Session 时进入右侧 Region 工作区。

未分屏时主工作面保持连续的全宽 Surface，切换不做左右互换或把内容从右边“搬到左边”的过渡。只有真实存在多个 Region 时，才使用现有分屏 arrangement；没有详情时不保留空的右侧框、占位线或方向性动画。

### 对话、终端恢复与插件表面（2026-09-22）

- Codex 用户消息每条占一行独立的紧凑消息槽，沿用同一身份字形和正文面；不能把后续消息并入首条或折叠成不可见的输入历史。消息槽的垂直间距与 Agent 消息一致，长正文自然换行。
- 输出缺口使用终端外的服务窗，不把黄色提示字符串写入 xterm。服务窗与终端边缘保持固定间距，允许收起；最新画面继续占满内容面，重绘成功后告示折叠为轻量状态点或消失。
- Redraw 提示属于当前 Region 的顶部状态 rail，使用低高度中性色控件；缩放后的终端内容优先，提示不能覆盖第一行，也不能在当前网格已确认后继续占位。Region 的 redraw 与历史 output gap 使用不同的状态 glyph。
- Restoring 使用 `FullPageLoadingSurface` 的统一内容宽度、网格、注册标记、边框、阴影和 reduced-motion 规则；恢复文案说明正在重放保留输出并接回画面。Agent 启动保留执行器图形、加载 glyph 和“等待首段输出”文案，两者不共用一套终端专用全屏 DOM。
- Agent 与 Workspace 的显示名编辑使用紧凑的行内控件：名称文本优先，内部 ID 退到详情/诊断；成功后的新名称在 Tab、Region、Project rail 和 Skill 说明中即时一致。失败只在当前表面留下短服务窗，不撑高导航。
- 插件目录、Skill 和命令入口沿用现有 Settings/Launcher 密度：清单先显示名称、版本和能力摘要，激活状态用一个小状态点表达；不为每个插件增加独立卡片、颜色或厂商专属控件。

### Agents 看板与 Board 需求流转（2026-09-22）

Agents 直接沿用原 Board 的工具栏、状态列、卡片和右半工作区设计。卡片以 Agent 显示名和 Executor 身份为主，观察与请求处理保留同屏上下文；选中 Needs you 卡片后，详情区的“在这里查看请求”保持一个明确的次级动作位，不能把回答动作藏回旧列表行。没有 typed request 时只显示定位 Session 的动作。Board 卡片先读需求标题、状态、负责人、Project 和优先级，Session 数量和运行状态是次级事实。零 Session 与多 Session 的需求具有相同地位。需求编辑与关联在固定详情区完成；行为约束见 interaction SSOT 同名小节。


### Board Demand 的全局层级（2026-09-22）

Board 是与 Project、Session 平级的最高级工作面。进入 Board 后 Project Rail 被 Board 连续 Surface 覆盖，不能在左侧继续显示 Project 树；Board 内的卡片、筛选、详情和右侧工作区以 Demand 为文案，Demand 才是需求身份，关联 Session 只作为执行事实。

### Demand 命名合同（2026-09-22）

Board 的可见文案、DOM 选择器和实现名称统一使用 Demand。`demand` 是需求身份，`Session` 是执行事实；同一 Board 语义不再混用 `task` 命名。控制操作、CLI 和持久化投影也使用 Demand 词根，避免在高密度卡片和详情工作区里产生两套身份语言。

- **Terminal 文件动作保持轻量且可扫读。** 右键中的系统文件动作放在路径动作分组，使用平台对应的短文案与统一 14px 图标；没有路径命中时整组缺席，不留空分隔线。菜单不能因长路径把动作裁掉，动作文本允许单行省略并保留完整 title/可访问名称。

### 状态标记与 Executor 叠加密度（2026-09-22）

工作中的 Agent 使用小型活动字形，避免用一个小绿点承担“正在产出”的含义；idle／普通 running 保持无标记的身份图。等待、阻塞、断联和错误只在确有提醒价值时显示右上角标记。Executor 角标缩小到 Provider 图标内部的叠加层，保留一圈很窄的底色隔离，不向外扩张，不和 Provider 身份图分开排布。活动详情菜单使用有限宽度、可换行和最大高度滚动，原因文本与时间、Project 元数据仍能同时读到。
### 状态、Browser 与 Scratch / Topic 密度（2026-09-22）

- Project 树的 idle、running/working、error 统一为同一宽度的“小图标 + 数字”状态槽；只换 glyph 和语义色，不换控件结构。完整状态名称进入 tooltip/无障碍名称，避免长文案破坏树的列对齐。停止/退出态使用中性颜色，error 只使用于明确故障事实。
- working 与 idle 的计数口径归交互合同「活着和正在产出分开说」，本层只定义它们的视觉层级。
- Browser 页面优先于控制提示。控制条是紧凑的 page-adjacent rail，只有 active operation、接管或交还时占用一行；空闲 Browser 不画大卡片或 `Browser ready / You have control` 占位文案，也不遮挡原生页面。
- Scratch 父行与 Topic 子行共享 Project rail 的缩进和垂直节奏。Topic 的字号比普通项目小一级、行高更紧，标题允许省略但操作和选中态完整；hover 用细线/下划线和轻微 surface 变化表达，不使用厚重背景块。Topic 行的打开状态、更新时间或 Agent presence 用低对比度辅助信息表达，新增和空列表用明确但紧凑的引导。

### Executor identity 的统一密度（2026-09-22）

- Executor identity 组件在 Tab、树、Session、Board 和 Browser rail 中共享同一图标盒、状态点尺寸、珐琅外轮廓和 hover/focus 信息面板；调用方只提供尺寸上下文，不重写内部间距。
- 自定义 Executor 图标是 Provider 图标内部的小型叠加，不能向外扩成第二圈。状态点只在 working、needs-user、blocked、disconnected 或明确 error 时显示，idle/正常停止不添加常驻装饰。
- 信息面板使用现有 tooltip 的 micro/compact 字号和边距，内容分成身份、状态和一个小型设置动作；设置动作进入 Executor 模板设置，不把 Appearance 的控件复制进面板。
- 既有头像的保留和 Reset 语义归交互合同「旧配置的 Executor 身份不能丢」；所有尺寸下的设置预览与实际身份图保持一致。

### Leader Topic 的 a mature workbench 风格浮窗（2026-09-22）

Leader Topic 浮窗采用 a mature workbench floating workspace 的密度：外层是轻阴影和 hairline，顶部是可拖动的短标题栏与最小化/关闭控件，中间直接放固定 `launcher:leader` 的原生 Topic Tab/Region，底部保留现有 composer。浮动位置同时显示一个 36px 级别的紧凑助手按钮，按钮使用项目专属 low-poly 头像、可键盘聚焦并沿用同一份注意力提示。浮窗不使用客服式消息卡、独立头像墙或重复的聊天 header。

Leader Topic 的头像沿用项目资源中的绿色 low-poly 龙图标。浮动态入口使用圆角矩形徽章而非圆形头像：徽章需要在工作面边缘一眼可见，内部龙头像保持清晰、完整和不变形；收纳态缩小为同一徽章的紧凑尺寸，与底部三个工作面按钮共享圆角和焦点语言。不得用新生成的角色头像、纯色字母或通用 Provider glyph 取代项目龙头像。

浮窗关闭后只变为不可见并交还焦点，不能卸载或清空其 Topic/Region；再次打开应保留原 Tab、输出和滚动位置。悬浮头像普通点击后必须呈现可见、可聚焦、可输入的浮窗，拖动阈值内的点击不能被吞掉；入口可切换为与底部三项同组的 compact 形态；Board footer、Session chrome 和 Agents surface 不再各画一套内联菜单。

Leader Topic 的头像、三个点和展开面板使用一个连续的浮动面：三个点紧贴头像，动作按钮采用明确的更多操作提示，不单独漂移；面板标题栏与头像徽章共享边界、背景和阴影。头像是展开/收起的唯一主开关，打开后再次点击头像收起，收起后只保留紧凑头像和三个点；不增加第二枚关闭头像或远距离的重复切换按钮。

不显示三个点操作按钮；浮动／紧凑形态的切换与收起动作统一放在底部入口位置。浮动形态下底部入口使用明确的收起图标，点击后把头像和 Topic 收纳到下方；紧凑形态下底部入口恢复为打开 PMO Teams 的头像按钮。头像外层使用 `backdrop-filter` 毛玻璃、半透明 surface 和柔和阴影，不画绿色描边；绿色只作为品牌图形和注意力语义。compact 态打开面板时，面板从底部切换器上方或邻近侧面出现，并在视口边界内夹紧，保持入口与面板的视觉连接。

### Demand 包与 Leader Topic 投影（2026-09-22）

Demand 由与 Core 平行的文件系统包提供，Board 和 Leader Topic 只消费同一份 Demand 投影。界面中的 Demand 卡第一层显示标题、状态和目标 Project，关联 Session / Attempt 作为第二层执行 rail；不在卡片内复制一套 Session 状态机或把 Agent 行伪装成 Demand。CLI/API 的失败沿用服务窗语言，保留已读到的 Demand，不用空列表覆盖工作面。

### Demand 管理与业务流程表面（2026-09-23）

Demand 详情必须有可编辑的描述、优先级、状态、目标 Project、Executor 和关联 Session 列表；每个编辑动作沿用紧凑的行内控件与 receipt，不把详情做成空白表单或信息堆。关联 Session 使用稳定 ID 和 Agent/Project 摘要，提供添加、移除和进入原工作面的动作；删除 Demand 放在明确的危险动作菜单里，要求确认并保留审计信息。

Demand 卡片的执行 rail 使用统一的“Agent 工作拓扑摘要”组件：先显示 Topic/Branch，再按 Tab 展示其全部分栏，分栏内显示 Region 类型、Agent 名称、Provider/Executor 和运行状态。Tab/Region 信息采用紧凑树形层级，可折叠但不能默认只剩计数；组件在 Agents、Session、Demand 详情中复用同一间距、身份 glyph 和状态槽。

Leader Topic 浮窗承担“提出需求”和“分配上下文”的对话入口，Board 承担扫描、编辑和审计；两者共享同一 Demand 事实。一个流程从浮窗开始时，Board 不提前画空卡；确认写入后卡片立即显示描述、Project、状态和 Session 数量。CUI 查询与 UI 详情使用相同字段顺序和稳定 ID，Agent 可以完成与人相同的提出、分配、推进和删除流程。

### Demand 专属 PMO Tab 的表面（2026-09-24）

每个由 Board `New Demand` 创建的 Demand 都有一枚专属 PMO Tab。Demand 卡片和详情只显示一个紧凑的 PMO 入口，入口文字使用 `Open PMO` 或同义短文案；不在卡片上重复渲染整段对话。打开后浮窗直接切到对应 Tab，Tab 标题可用 Demand 标题辅助识别，内容区保持普通 PMO 对话密度。新 Demand 的 Tab 与其它 Demand 的 Tab 在 Tab 条上可并列扫读，但不得合并成一个共享的 Session。

绑定关系属于工作面恢复事实：Demand 的文件投影不增加编辑器字段，编辑器状态单独保存 Demand 到 PMO Tab 的映射。映射失效时，入口显示一次明确的恢复动作并创建新的专属 Tab；不能把用户送到另一个 Demand 的 PMO 对话，也不能因为映射暂时不可用把 Demand 详情清空。

从 New Demand 打开的 PMO 浮窗在目标 Agent 挂载前保持同一张目标 Tab 的等待状态；不短暂显示其他 PMO Tab 的内容，避免用户看到旧需求的对话闪回。

### 真实重启恢复的表面密度（2026-09-22）

真实重启后的第一帧先显示原有 Tab、Region 和焦点所属工作面；Runtime/Provider 恢复中的服务窗贴在受影响 Region 的边缘，不用全屏 loading 覆盖工作面。服务窗短标题说明失败阶段，正文说明当前保留的事实和恢复动作；恢复成功后收敛为轻量状态，不制造第二套恢复面板。验收证据必须来自不同的真实 Electron 进程和同一持久化根目录，不能用组件重挂载或静态启动标记代替。

### Leader 一体式对话面（2026-09-23）

Leader 浮窗使用清晰中性细边框、外阴影与实色内容底，标题和内容同底色。标题区收紧至 36px，头像融入同一行，不显示内部 Topic ID，不重复放最小化和关闭这两个相同动作。展开头像缩至适配标题行的尺寸；毛玻璃保留在独立悬浮入口，不牺牲正文可读性。默认对话模式的行为归交互 SSOT。

Leader 内容区的身份提示采用一条短的职责说明和一个明确的“先澄清、再分配、经确认才写入”状态槽，不增加高大的客服式欢迎卡。对话内容、Composer 和工作区事实仍沿用普通 Topic 的密度；职责约束由固定 Leader Wiki 提供，普通 Topic 不显示这条额外提示。

### 全局加载表面（2026-09-23）

Browser restoring、Agent Terminal attach 和 Terminal restoring 共用同一套 Region 级动画与阶段文案，不能各自再造局部 loading 卡片；真实 surface 出现后统一卸载。

应用级和 Region 级加载只保留一套 graphite grid / sweep / registration mark 语言。首次装载显示全幅动画；局部刷新保留已有事实，只在原位显示轻量忙碌信号。任何新的等待态先复用 `FullPageLoadingSurface`，再决定是否需要额外上下文，不另起一套 spinner 视觉。

### 设置页现代化密度（2026-09-23）

设置页使用“窄侧栏导航 + 宽内容画布 + sticky 上下文头”的工作台布局。侧栏导航项保持清楚的图标、标题和一行说明；主区卡片只抬起可编辑内容，信息说明贴底，保存动作在可视区域内稳定可见。主色只用于选中、成功和唯一主操作，避免整页卡片化和彩色装饰。

### Message Tool 内的 Agent 视图切换（2026-09-23）

Terminal / Activity 切换从 Pane 顶栏移到 Message Tool 的工具带，和 Skills、Commands、Capture 共用紧凑按钮语言。顶栏保留 Tab、Workspace、Agent 生命周期和分屏动作；切换按钮必须在窄栏仍可发现，当前模式用 selected/focus 语义表达，不用额外大标题。

### 对话消息的视觉语言（2026-09-23）

消息流采用编辑器式阅读布局：用户消息靠右、宽度收窄、使用柔和的 surface 色块和圆角；Agent 消息靠左但无左边竖线，依靠身份小标、字号和段落留白建立层级。复制、标注等动作默认隐身，hover/focus 时在消息头部出现，保持内容优先。选中文本后的标注浮层贴近选区并在视口内夹紧，提交区使用现有 Message Tool 的输入与发送语言。

PMO 团队的浮窗标题、入口 tooltip 和无障碍名称统一使用 `PMO teams topic`；紧凑团队称呼为 `PMO teams`。名称和职责见交互 SSOT「PMO teams topic 名称与职责」，保留龙头像和现有紧凑窗口语言，不额外增加占空间的角色说明栏。

PMO Teams 展开使用短促的位移、缩放与淡入，起点对齐触发头像，结束时头像与面板接合；不要从无关的屏幕角落弹出。标题栏只保留一个收起动作；浮动／紧凑形态切换和“收起到下方”由底部入口承载，不再显示右上角三个点。按钮语义见交互 SSOT「PMO Teams 从入口展开」。

### Workspaces 与 Agents 全局工作面（2026-09-23）

底部三项切换器使用 `Agents`、`Workspaces`、`Board`。`Workspaces` 只表达工作台集合，不把 Session 生命周期误当作顶级导航。Agents 和 Board 都是全局表面，打开后 Project Rail 不占空间；Project 归属在内容中以紧凑元数据表达。Agents 引力图的具体布局属于独立 Feature，当前表面先保持可扫描和可恢复。

### Demand 卡片与详情密度（2026-09-23）

Demand 卡沿用现有无套娃的 surface 语言：第一行放稳定 Demand ID、优先级和轻量状态信号；第二行放可读标题；随后最多两行描述预览；底部用紧凑 chips/metadata 排列 Project、负责人、标签、日期、子 Demand 进度和 Session/Agent 摘要。空值不画空槽，字段超长省略并保留完整 tooltip/无障碍名称。

Board 顶部使用一条低高度工具带承载搜索、状态/Project/负责人/标签/日期筛选、视图切换和唯一的新建入口；路由队列作为可切换的同级筛选态，不额外制造一块高大的独立卡片。筛选结果、列计数和空状态在同一条视觉节奏中，批量动作只在确有选中项时出现。

Demand 详情是连续的右侧 surface：标题和状态在短 header 中，属性编辑使用行内 picker/紧凑输入，描述和评论保持阅读宽度；活动与决策收在可展开的时间线分组，进行中的 Demand 工作记录和 Session 固定在上方，历史记录可折叠。删除、取消、停止和重试使用统一危险/次级动作语言，不把运行状态画成第二套卡片。

右侧 Demand 首屏以需求标题、描述和路由属性建立阅读顺序，不重复显示一个静态大标题和一格同文案的 Title 输入框。标题编辑控件呈现为标题本身，描述默认是可直接编辑的正文面；输入框边界仅在 hover/focus 时出现。状态、优先级、Project、负责人排成可换行的紧凑属性组，不让四个宽选择框横跨整栏。标签、日期和批次放在明确命名的可展开“更多属性”区，空值不占据首屏。Session 区紧随需求正文；零 Session 使用短的就地说明，工作拓扑和排列按钮只在有可观察执行内容时出现。窄窗允许属性换行，控件仍保持可读标签和键盘焦点。

多 Session 投影继续复用现有 Region arrangement。卡片只显示可扫描的 Agent topology 摘要，完整 Topic/Branch/Tab/Region 层级在详情内可展开；unknown 或尚未恢复的事实占用同样的稳定槽位，不用空白或跳动布局掩盖缺口。
> 命名更新（2026-09-23）：此前文档中的 “Leader Topic” 统一以代码和产品现名 **PMO Teams Topic** 为准；视觉与密度约束继续有效。

### Scratch Topic 工作面可见性（2026-09-23）

Scratch 的 Files + Topics 工具栏与右侧 Workbench 是同一工作区的两块表面。打开 Topic 后，右侧必须保留普通 Workbench 的 Tab bar、Region 和 Terminal/Agent 内容；不得把 Scratch 从 Workbench registry 排除而只留下全幅空底。

### PMO 浮窗与 Board 工具栏的紧凑度（2026-09-23）

PMO 展开面使用一体式短标题行：标题字号服从正文元信息档，头像与标题行接合，边框和阴影清楚但不靠高大的留白制造层级。标题行高度不应成为对话首屏的主要占用；完整名称放在 tooltip/无障碍名称中。Board 工具栏采用单行、单网格负责人布局；Project Rail 被遮挡时不保留 180px 的空 chrome，也不让侧栏按钮与 Board 图标落在同一格互相覆盖。

PMO Teams 的入口固定在底部中央，页面内不再保留独立浮动头像。展开面板继续使用已保存的几何位置和尺寸，入口与面板通过清晰的边界接合；打开动画只使用短促的 opacity、边界高光和信号扫描层，不缩放面板内容。扫描层必须在 200ms 级别内完成并在静止后移除，避免持续闪烁。龙头像眼睛的粒子仅作很轻的在线反馈，不能把聊天内容压暗或制造大面积发光。

眼睛反馈采用两束短烟火，每束最多 6 枚 2px 级粒子，局部、短促、低对比度；粒子通过有限的 CSS keyframes 或同等轻量实现，不引入全局粒子运行时。粒子不改变入口尺寸、不推动底部布局，关闭或 `prefers-reduced-motion` 时立即停用。

Board 左侧清单的视觉单位是 Demand 卡片。零 Demand 只显示一条可操作的空态和创建提示，不能显示 Branch 名、`main` 或其它技术上下文作为占位行。创建按钮保持和工具带同一低高度，创建后再展开 PMO 对话，避免先弹出一个空的大面板。

### Topic topology 的摘要与展开密度（2026-09-23）

Topic 行的 topology 收起态是一排紧凑 Tab 图标位；每枚只表达一个 Tab，不增加整排宽大的底座或重复的 Agent 头像簇。展开面板保持单一连续 surface：Tab 标题在上、Region 几何在中、Agent 头像、Executor 与最近活动在 Region 内或紧邻其下；状态色只做辅助，文字负责解释含义。当前 Tab 使用清楚的边界，不能靠纯颜色区分。

### Topic topology 计数与浮层的空间密度（2026-09-23）

收起态使用横向 Tab strip 列出全部 Tab；每枚 Tab 只占一个紧凑图标位，当前项用边界建立层级，不再重复放总计数。Tab strip 在窄宽度下水平滚动但不隐藏 Tab 事实。Inspector 使用顶层 viewport 浮层的密度和边界，展示当前 hover/focus Tab 的完整 Region 几何、Agent 头像、Executor 和最近活动；它可以在锚点上方或下方翻转，不能被列表滚动区域裁切，也不能因为靠近面板顶部而只露出一条残片。

### Topic topology Tab 缩略图的空间密度（2026-09-23）

收起态的每枚 Tab 只占一个小图标槽位：单 Region 直接放该 Region 的图标，不再套一层空心方框；多 Region 按真实 bounds 形成紧凑方形宫格。相邻槽位不再被一整块带内边距的胶囊包住；图标之间用间距与当前项边界建立可读性，不在槽位中写 `Tn`、`nR` 或其它实现计数。右侧不重复堆叠已在 Tab 中出现的 Agent 头像。Inspector 采用较窄的内容宽度，以 Agent 头像为身份锚点，名称、surface 类型和最近活动紧邻其后；超长文字省略但保留完整 tooltip/无障碍名称。

多个 Tab 的图标槽位采用与 Agent presence 相同的轻微叠压：相邻 Tab 约重叠一个小间距，整体宽度按簇收敛；当前、hover 和 focus 项通过层级浮到最上面，不改变其它图标的位置。叠压只表达同一 Topic 的集合关系，不遮住图标的主要识别形状。

### 安装后 Renderer 版本边界（2026-09-23）

安装包启动时只能显示当前内置 Renderer 或同一内置版本下的有效热更新；上一安装包留下的热更新页面不能混入新包。版本边界失败时显示内置页面并保留工作面事实，不用空白或旧版 UI 占据首屏。

### 跨视图 Session 定位与 Agent Input 宽度（2026-09-24）

Agents、Workspaces、Board 共用一个选中 Session 上下文。切换器只换主表面投影；Workspaces 展开已有 Region，Agents 保留右侧观察面，Board 高亮对应执行事实。不要为跨视图连续性新增重复卡片、隐藏 Session 或第二套选中状态。

Agent Input 的 collapsed composer 采用“左右有界控件 + 中间弹性编辑区”的密度：编辑区占据全部剩余宽度，工具和会话动作只占自身命中区。长消息可以换行，身份 rail 单独承担 Agent 名称、Executor 和 Session 摘要；不能用固定中间列、居中窄框或重复身份文字降低可输入面积。

### Topic Tab Rail 与 Region 地图密度（2026-09-24）

Topic rail 以紧凑的 Tab 图标簇表达打开面，不再用宽大的 chip 或重复计数抢占 Topic 标题空间。点击目标 Tab 直接切换工作面；hover 只负责预览，不承担导航的唯一入口。预览浮层使用一个按实际分栏比例绘制的 Region map，去掉地图下方重复的 Region 列表，地图内只保留必要的身份图标和截断标签。

### 用户消息气泡的内文密度（2026-09-24）

用户气泡可以停靠在右侧，但正文阅读线保持左对齐，和 Agent 回复共享同一套 Markdown 阅读基线。右侧停靠表达说话者，不改变段落、列表、表格和代码的阅读起点。

### Agent 焦点历史与 PMO 隔离的空间密度（2026-09-24）

Agents 表面在工具栏下提供一条低高度的“最近执行 Agent”上下文 rail：只显示当前与少量最近 Session 的头像、显示名和状态，允许直接回到对应工作面；没有历史时用一行短空态，不占用卡片首屏。PMO 浮窗不复用这条 rail，也不在执行 Agent 卡片中混入 PMO 身份。PMO 的当前 Session 只在自己的标题和工作面中表达，避免两个焦点在同一条视觉层级竞争。

焦点历史是导航事实，不额外创建卡片、Region 或对话。rail 使用现有 Agent 头像与状态语言，最近项按轻微叠压和紧凑间距排列；完整 Session、Workspace 和恢复状态放入 tooltip/可访问名称。

### Focus 主表面与左侧历史列表（2026-09-24）

Focus 使用三段式工作面：左侧是固定宽度的历史列表，中间是执行 Session 状态区，右侧是当前 Session 的观察区。历史列表宽度保持在可读的窄栏范围，不用顶部横向 rail 抢占状态区首屏；窄窗口时历史列表可以收窄，但不能把 Session 身份压成只有图标。

历史列表使用轻量 Git-like 时间线：一条细竖线、当前项节点、紧凑行高和单层选中 surface。每行最多两层文字，第一层是 Agent 名称或 Terminal 标识，第二层是 Workspace/状态；时间和 `HEAD` 关系放在右侧弱化显示。列表不嵌套大卡片、不重复绘制右侧观察区中的 Region。

Focus 的 Agent 与 Terminal 采用同一行结构，只替换身份图标和类型标签；不得因为 Terminal 没有头像而留下空槽。PMO 不占用历史列表的位置，也不与执行 Session 共用状态颜色。主区沿用现有状态列，但工具栏使用 `Focus`、`Recent contexts` 等产品词，不再把“Agents”作为整个表面的唯一身份。

### 全局工作面标题栏留白与 Work 标签（2026-09-24）

Focus 与 Work 在 Project Rail 缺席时，顶栏标题从系统窗口控制区右侧开始；macOS 的三色按钮和文字不能叠放。让位属于顶栏 chrome，使用与已有窗口按钮留白相同的几何来源，不在 Focus、Work 各自的内容面板里另加一份边距。非 macOS 不因 macOS 按钮预留无意义的空白，窄窗中次级面包屑可截断，主名称仍可读。

底部导航、面包屑与工作面工具栏统一显示 `Work`；其上下文副标题使用 `Requests & ideas`，让用户知道这里承接的是自己的诉求和想法。Demand 卡片、详情和操作可以继续用 Demand 指代持久化对象，但面向用户的创建、搜索和统计文案使用 request/idea 语言。`Goal` 表达单条 Work 想达成的结果，属于对象语义，不承担全局入口名称。行为约束见交互合同“全局工作面顶栏与 Work 命名”。

### Browser 与身份浮层的空间层级（2026-09-24）

头像详情浮层保持紧凑尺寸，但拥有跨 Region 的连续阅读层级；相邻 Region 的 Browser 不能在浮层后面继续绘制并截断文字。浮层打开时 Browser 让位只覆盖实际需要的短暂 hover/focus 生命周期，关闭后沿原边界恢复；不能用扩大浮层尺寸、重复画一份 Browser 或永久降低 Browser 层级来解决。

Browser 调整窗口或分栏尺寸时优先保持最近一次有效内容，避免“先消失再出现”的视觉断裂。零尺寸、布局尚未提交和 ResizeObserver 的中间读数不画空白占位，也不触发停放动画；有效矩形稳定后平滑更新。加载、错误、主动停放仍使用各自已有状态表面，不与尺寸过渡混在一起。

### PMO Teams 浮窗的拖拽反馈与密度（2026-09-25）

拖拽反馈使用单帧更新，视觉位置由临时 bounds 直接驱动；持久化写入只发生在拖拽结束。拖拽中不重复广播整个浮窗状态，也不让内容区因为 pointer move 反复重排。PMO 外壳使用轻量标题栏和单一内容边界，标题、关闭操作、Tab/Region 内容和底部输入区各有清楚层次，避免“浮窗套 Workbench”造成两套标题、空态和工具栏争夺注意力。

### PMO Teams 浮窗的参考驱动简约规则（2026-09-25）

- 参考成熟工作台 浮动工作面的顶层工具栏：高度目标 32–36px，横向 padding 8–12px；头像/身份图标 18–20px；关闭、新建、分屏等动作使用 24px 命中区。不得用 42px 以上的标题带承载普通身份文字。
- PMO 标题只保留紧凑的身份标签（例如 `PMO teams`）和必要状态；不常驻副标题、不显示内部 Topic ID、不放欢迎语。完整名称、职责和 Session 信息进入 tooltip、无障碍名称或工作区内容本身。
- 顶部优先放可操作的 Tab/Region 工具条。PMO 自有身份只占一个小图标槽，不能和嵌入 Workbench 的 Tabbar 形成“标题栏 + 第二标题栏”的两层大 chrome。
- 浮窗只使用一个内容边界和一个阴影层；外层定位节点负责移动，内层工作面负责内容。不要给同一层级连续套边框、胶囊和卡片背景。打开后的首屏内容应尽可能从第一行工具条下开始。
- 简约性是可验证约束：删除某个标题、分组或装饰后，如果信息仍由图标、Tab、状态和 hover 提供，则该元素必须删除；新增视觉元素必须说明它表达了哪一个用户可操作事实。

### Session 归属与 Message Tools 的自适应密度（2026-09-25）

- Fork / Resume 的 Tab 入口沿用目标 Session 的工作面归属，不能从当前焦点 Region 借用位置。新 Tab 的插入点只由目标 Tab 的布局事实决定，不能用“当前 Agent 右侧”这种无法解释的空间捷径。
- Message Tools 的 composer 采用“左右稳定、中间弹性”的布局：单行时使用一行高度，输入超过可读宽度时扩展为 2–4 行，工具与发送控件不被文字挤压；超出最大高度后才在编辑区内部滚动。文本始终左对齐，不能用固定窄宽度和居中布局牺牲输入面积。
