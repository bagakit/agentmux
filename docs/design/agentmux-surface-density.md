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
- 打包来源身份属于安装与诊断边界，不在工作面新增常驻版本条、重复状态栏或第二套
  运行时状态；需要核对时通过候选报告与文件元数据完成。
- 发布审计与运行路径校验属于同一条诊断边界：候选、canonical 安装副本和当前运行
  实例只通过身份报告对照，不在界面常驻显示版本号，也不复制一份 Session/Run 真相。
- New Browser 的结果沿用交互合同中的可见成功/失败投影：不新增常驻版本或状态条；成功时
  由聚焦 Pane 的 Tab/Region 承担变化，失败时由该工作面已有的服务窗/错误面承担反馈，
  不能留下无变化的空白点击结果。

- 本轮整体 review 延续 Graphite / Mint 与既有 Surface 层级：可靠性与焦点约束见交互合同《整体 review 的可靠性约束》。Prompt 验证降级复用 Session 服务窗，持续可见、不遮挡、不抢焦点；Board 读取失败用现有行内错误语汇，不能用无限 loading 或空态代替。高密度 Board 的排序与分组不应反复全表扫描或复制已分组成员。

- 无独立动作的聚合头像沿用相同身份和状态色，但不显示按钮手势或交互抬升；可定位到 Session 的头像保留现有悬停与键盘焦点表现。

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
  状态点使用它填充；Topic 头像只在 `working`/`running` 时读取它绘制外描边/发光，其他状态保持灰度，
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

## Surface 层级

重启恢复是工作面的一等状态：恢复期间保留原 Tab、Tab Group 和 Region 的几何位置，不用空白欢迎页替换它们。流程故障以停在旁边的服务窗提示，提示包含失败步骤、当前按什么状态运行以及恢复动作；只有 Core 确认 Session 退休时才收掉对应 Region。冲突提示必须区分“旧 owner 仍存活”和“租约可回收”，不能把一次重启后的 stale lease 画成健康 Session 被其他进程占用。

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
- 单 Pane 时根 Tabbar 与窗口顶行合并为 36px；分屏时使用 36px 全局 chrome 行和每 Pane 31px Tabbar。
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
| Project Rail Nesting Indent | 每层 `var(--sp-4)`；最多 3 层 | 只有**真嵌套**（一个 Project 在另一个 Project 目录内）才缩进，同父目录的兄弟不缩进——缩进表达的是包含关系，不是分组。深度经 CSS 自定义属性注入，且必须在样式表里声明默认值（见控件语言「注入的自定义属性要声明默认值」）。层数封顶避免深目录把标题挤没 |
| Explorer / Branch Header | 32–34px | 不形成第二层大 Topbar |
| Tree Row | 24px | 保持键盘扫描和专家密度 |
| Tool Dock Width | 默认 300px；最小 236px；最大 440px | 同时容纳 Explorer / Branches，保留主工作面容量 |
| Tool Content Padding | 8–12px | 仅用于局部卡片，不包住整栏 |
| Context Menu | 176px 最小宽；26px Row；8px 横向 Padding；5px 容器 Padding | 全部 Context Menu 共用一套基座。Surface 填充 + 阴影 + 顶部高光建立层级，**不使用描边**；hover 提升明度并把图标转为品牌绿；破坏性项 hover 保持红色语义，不被绿色 hover 覆盖。菜单从指针处生长（120ms），表明它是这次点击召唤出来的，而非盖在界面上的一层浮层 |
| Activity Log Row | 24px Row；20px 节点槽；56px 等宽时间槽；12px 横向 Padding | 与 Tree Row 同一节奏。整列共用一条 hairline spine，节点用填充光晕挖空它而非画环。展开内容与该行标题同一左缘（104px），不得比自己的标题突出。**仅**机器上报（tool_call / permission / lifecycle）走这一寄存器 |
| Scratch Topic Row | 标题 11px、摘要 10px 次行；头像 18px 成簇锚定行右缘并垂直居中 | 一行只回答**这个 Topic 里的 Agent 现在怎么样了**。**Agent 呈现为一组头像而非一排抽象点**：缩小的 Provider 图标给出身份；头像默认无常驻边框，只有 `working`/`running` 才显示外描边/发光，未运行状态灰度处理。**头像簇锚定行的统一右缘**——所有行的头像右缘必须齐平，不得随各行摘要长短浮动（一列参差的右缘读作"没对齐"，而不是"信息不同"）。这条与"同一族列表行共用一套表现层"是同一件事的两面：簇是行网格里独立的尾列，因此它对齐的是行，不是标题那一行的内容盒；也因此它在两行 identity 上垂直居中，而不是吊在标题的基线上。**数量多时叠压而非平铺**：相邻头像负向重叠成一摞，像会议里的参与者列，最靠右的一枚在最上层；超过可容纳枚数折成 `+N`，全名进 tooltip，不无限撑宽。悬停有 macOS 程序坞那种抬升放大——该枚上浮、放大并盖过邻座使自己完整可见（`transform` 不参与布局，因此不推动同排其它头像），配 tooltip 给出名字与状态；点击直接定位到该 Agent，走全局同一个 `selectSession`。**不重复呈现同一事实**：既然逐个 Agent 已经在场，就不再另给一个 `N agents` 计数；既然当前项整行高亮，就不再另挂一枚 `Current` 文字标签。没有 live Session 的协作者如实显示 disconnected，不假装在跑。**行首不放 Topic 图标**——一列全同的图标不携带信息（见控件语言）。**选中态是干净的 Surface 填充，不用左侧竖条**。行上只留"定位到目录"一个高频动作，改名收进右键菜单。**顺序可由用户拖拽决定**，复用 Tab 条同一套 sortable 与键盘路径；用户顺序是一份偏好而非真相来源——磁盘上没有的 Topic 不会因排过而出现，没排过的保持彼此既有次序落在后面，新建的不会跳到不可预期的位置 |
| Activity Turn Row | 与 Log Row 共用同一 spine 与 20px 节点槽（14px 图标）；正文 13px/1.6 用 `--text` 主色，caption 11px `--text-3` 大写，时间移到行首右侧的 mono 戳；上下各 6px 呼吸 | user_message、assistant_message 两个可读回合脱离 24px 机器寄存器：正文是主体不是 payload，永不裁剪、永不折叠。<br><br>用户「User 发的消息要单独显示」。**用户发言整块成立**——底色、内缩、圆角与左侧 2px 实心色带一起把它围成一条独立的发言，而不是只给正文一层底：只给正文时 caption 与时刻浮在底色之外，一句话读起来是"一个标签 + 一块底色"两件东西，扫下来与 Agent 回合只差一点底色深浅。成块之后正文自己不再叠第二层底（浅底叠浅底边界更糊），字色降一档——用户自己的话是"我说过什么"的回看，Agent 的答复才是主叙述。Assistant 正文在 S0 上流动，保持敞开的叙述形状。<br><br>那道色带**不属于**被禁掉的选中竖条：禁令针对密集列表里表达**选中**的贴边装饰，这里既不表达选中也不在列表里，走的是同文件已有的**内容**语汇（`.md-quote`、`.log-row__output` 同样用 2px 左侧色带说"这一段是引来的/跑出来的"），一句被读回的用户发言正是一段引文。边界仍由填充承担，色带只在一侧、不画出框。<br><br>形状按 **SPEAKER ROLE** 选，不按 kind：A2A 落地后 agent 侧不管有多少身份都保持同一形状，而"这台机器前面的人说的话"始终是被框起来的那一条。native-hook 的 assistant 回合不进入折叠 |
| Activity Turn Prose | 标题全部 13px（与正文同号）靠 600 字重与上下留白分级；表格 4×9px 单元、hairline 行分隔；引用块左缩 9px 配 2px 竖线；水平线 1px | 对话回合的正文渲染 GFM 子集：标题、强调、删除线、行内与围栏代码、有序/无序含嵌套列表、表格（含列对齐）、引用块、水平线、链接。**多级标题字号完全相同**——密度合同对字号设下限并禁止用尺度买层级，故 h1..h6 只靠字重、颜色与留白区分，绝不放大。解析器（remark-parse + remark-gfm）只产 mdast **语法树、从不产 HTML**：节点映射为 React 元素，`dangerouslySetInnerHTML` 从不出现，因此不可信的 Agent 输出**没有东西需要 sanitise**——风险面是构造性为零而非"已过滤"。raw HTML 节点按字面文本呈现，绝不成为标签。宽表在自己的 `overflow-x` 容器里横向滚动，不得撑宽回合、更不得让整个 feed 横向滚动。链接渲染为 button 而非 `<a href>`，经既有 openExternal seam 打开（不可信输出里的 `<a>` 是导航逃逸口）。只在 turn register 渲染；机器行保持纯文本，纯文本也不进解析器以免重排从来不是 markdown 的句子 |
| Activity Ruler | 顶部 sticky；18px track | tick 按真实经过时间比例定位——密集事件自然聚簇、长思考自然留白。首末时间戳无跨度时退化为序数轴并用虚线明示，不得让间距宣称数据没有的精度。ruler 可交互，三项均由**同一个双向纯映射**（像素位置 ↔ timeline 位置）驱动，不各自重算：**点击**跳到对应事件（落在两事件之间时就近取一个**真实事件**，绝不插值出不存在的时刻），并有键盘等价路径与可见 focus；**可视范围**在 track 上框出日志当前看到的那一段，来源是真实可见区域；**悬停/聚焦**读出该位置的具体时间，锚定不遮挡它所描述的那段 ruler（沿用终端链接预览的同一条规则），且不改变选中状态。**零跨度时三者全部退化为序数语义**——只说"第 N 个事件"，不显示也不暗示任何时刻；这条由返回类型强制：ordinal 变体在类型上就没有承载时刻的字段，因此伪造精度无法通过编译。可视范围的更新**不在滚动热路径上**：由观察式 API 驱动而非每帧 scroll 处理器，一条阅读用的装饰不该成为滚动卡顿的原因。范围为空或日志短于一屏时不画占满全宽的假框（那会读作"什么都看得见"）|
| Activity 时间读数 | 时刻固定 `HH:MM:SS` 24 小时补零；时长按最高非零位起报 `3h04m03s` / `4m03s` / `3.2s` / `840ms`；均 mono + `tabular-nums` | 用户「时间只显示分钟太不友好了, 应该显示从什么时间点到什么时间点, 消耗的时分秒」。<br><br>**时长不在分钟处封顶。**小时位不是可选修饰：Agent 跑一下午是这个产品的常态，而封顶的实现会把一次三小时的 Session 报成 `184m03s`，让读者自己去除以 60。低位补零（等宽下不跳位），高位为零则省掉（短跑不必读 `0h00m03s`）。这条同时管偏移量、标尺跨度、折叠段耗时与读屏可访问名——**只有一个格式化器**，四处共用；任何一处靠切字符串（`+3h04m03s` 去掉加号）拼出时长都会在前缀变化时啃掉一位数字。<br><br>**时刻用固定 24 小时而不是 `toLocaleTimeString`。**读数落在等宽的时间沟里，一列上下必须对齐，而 locale 格式的宽度随小时变化（`2:03:07 PM` vs `14:03:07`）。日志读数取可预测的对齐，这也是各类日志查看器的通行做法。<br><br>**三个事实各就其位，不重复。**标尺头上给起、止、耗时（这是用户那句话的完整答案，三段回答同一个问题，摆成一行而不是分两处让读者自己拼）；一句话的行内给**时刻**（一句话关心"什么时候说的"），偏移量退进 title；机器行仍给**偏移量**（一条 tool_call 关心"距开始多久"）；折叠头把它藏起来的那段时长摆在 `N steps` 旁边，于是展开与否都在同一位置回答"这一段值不值得展开"。<br><br>**没有时间可报时不报。**序数轴不渲染跨度，同刻的折叠段不渲染耗时——硬报一个 `0s` 会把 ruler 在类型上刻意排除掉的那种不诚实又请回来（见 Activity Ruler）。<br><br>**分档按将要显示的那个值判。**秒档显示到 0.1s，所以先把时长归到十分之一秒再决定进不进分钟档。两个精度各判一次必印出这套记法里不存在的读数：以整数秒判档、以四舍五入显示，`59_950ms` 会留在秒档而印成 `60.0s`；分/时交界同理会给出 `59m60s`。<br><br>**「一个格式化器」是可执行的约束，不是文档里的说法。**偏移量整段就是「一个符号 + 一段时长」，不自带毫秒档与秒档——那两行与时长格式化器同义，留着就等于同一条规则住在两处，而它真的走岔过：分档修好之后时间沟里仍印着 `+60.0s`，而机器行每一行都在读它。<br><br>**折叠段的耗时算到末步跑完，不是算到末步开始。**起点是首条的 `createdAt`（这一步开始），终点是这一段里最后完成的那个 `updatedAt`（这一步结束），取 max 因为并发几步的完成顺序不必跟着开始顺序。末步往往是最贵的那一步（build、跑测试），拿"末步开始"当终点会把它整段跑的时间漏掉——一个藏着五分钟构建的折叠头会宣称自己只有 1 秒 |
| Activity 对话轴 | 两条各 16px 高，之间 `--sp-1`；标记头像 16px，命中区 `--sp-7`(24px) 圆形；与 ruler track 共处一个 `stack` 列 | 两条轴的**需求真相在交互合同**（见 [`agentmux-desktop-interaction.md`](./agentmux-desktop-interaction.md) 的说话人轴/自我 Agent 轴），本行只管密度与几何。<br><br>**共用一个坐标盒是这两条轴的存在理由。**标记的 `left: N%` 与 tick 的 `left: N%` 必须对同一个宽度解析，否则两行只在分数上一致、在像素上不一致——ruler 行的 track 是 `flex: 1`，左侧被行内缩、右侧被跨度读数与 note 各占掉几十像素，一条横跨整个 feed 的轴会越靠后越右偏，最后一枚头像浮在它该指的 tick 一个时间戳宽度之外。所以轴不是 ruler 的兄弟，它与 track 同处 `.activity-ruler__stack` 这一列。<br><br>**轴高必须等于它所座的头像尺寸**（今天 16px）：标记全是绝对定位，轴自己没有内容可撑高，短了裁掉头像、高了在 ruler 上方留死白。两者是同一个数，不是"碰巧都是 16"。<br><br>**命中区大于头像，且不靠布局买。**头像保持 16px，`min-width/height` 取 24px——触摸目标比鼠标目标大得多，这是移动端可移植性在源头就兑现而不是留给以后。命中区长大不推动邻座，因为标记绝对定位且靠 `translate(-50%,-50%)` 以**自身中心**对位。24px 是"还称得上目标"的下限；桌面窄侧（~320px 时 track 只剩约 190px）两个相近的标记会有十几像素重叠，靠 hover/focus 抬 `z-index` 并放大**头像**（不是按钮——按钮的 transform 正是它的对位手段）把当前那枚提到可完整看见，邻座不动。<br><br>**选中与 tick 同一套配方**：长大几何 + 一圈 `--surface-0` 让位，不额外上色、不加描边（选中是单一几何信号）。选中的缩放必须压过 hover 的，否则指上去会让当前选中看起来"更不选中"。 |
| Tool Dock Header | 30–34px；10px 左缩进；24px 图标按钮 | 各工具坞标题共享同一左缘。分屏时上下堆叠的标题必须对齐，近似对齐比不对齐更伤观感 |
| Agent Attention Bar | 24px 高；横跨整宽；12px 横向 Padding；12px 段间距；11px tabular-nums | 窗口底部唯一的跨会话注意力汇总。`surface-1` 填充 + 顶部高光 + 一条 hairline 顶边界定它，不使用描边。复用共享状态点语汇，计数为零保持中性灰；栏存在时把折叠的 Rail 角标抬高让位，纯 CSS `:has()`，不耦合 JS |
| Agent Provider Catalog | 142px 最小列宽；44px Card；最多 268px 高 | 容器独立滚动，不扩大 Launcher |
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
  dock.css        Tool Dock 及其面板（Explorer、Topics、Branches、Agents）
  workbench.css   Pane、Region、分屏、拖放
  terminal.css    终端表面与它的状态覆盖层
  surfaces.css    Board、Settings、New Tab、Launch、Welcome
  browser.css     Browser 工具与地址栏
  agent.css       Composer、Markdown 回合、Roster
  activity.css    Activity 时间线、机器步骤与标尺
  activity-conversation.css  Activity 对话回合与 Markdown 内容
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

## Agent 空间与身份呈现

- 新 Agent 的落点必须在当前可见工作面中可辨识，不能用 Tab 条上的相邻标题冒充屏幕右侧分栏。空间是否足够取决于分割后的可读宽高与内容用途，不仅比较面积；少动现有布局，不为自动整理持续重排。
- 自定义 Executor 与内置 Executor 共用名称、Provider 身份和状态语汇；详细 ID、归属与能力由检查面承载，不把完整机器元信息塞进窄 Tab 标题。
- 空间与启动流程降级沿用持续、中性服务窗，说明发生了什么、Agent 在哪里或是否尚未展示、如何恢复。空间决策、完整元信息与布局包边界见 [Desktop interaction](agentmux-desktop-interaction.md) 的“Agent 自助创建与空间操作”。

## 悬停菜单

- Split 与同类下拉菜单沿用现有按钮、箭头、菜单尺寸和选中语言；降低操作次数，不增加常驻控件。触发器与浮层之间的视觉间距不能成为指针操作的断点。行为以 [Desktop interaction](agentmux-desktop-interaction.md) 的“少一步操作”为准。

## 非目标


- 不建设主题导入器、任意颜色编辑器、插件市场或通用扩展框架。
- 不为没有规模证据的虚拟列表、文件拖动或移动端布局预建状态。
- 不在正式设计合同保留来源路径、固定 commit、Copy/Adapt/Omit 表或已完成任务流水。
- **不引入 CSS-in-JS、Tailwind 或预处理器**。问题是"字面值没有名字"，不是"CSS 不够强"；
  原生 custom property 已经足以给尺度命名，换一套构建期方案只会在解决同一个问题的同时新增一层工具链。
- 不做设计 token 的运行时主题切换。当前只有一套深色语言，`color-scheme: dark` 是事实而非临时状态。

- Shell 环境读取不完整时，复用服务窗的持续、中性、非模态告示；说明读取范围和恢复动作，不展示环境值、不靠 toast 自动消失。行为归属见 [Desktop interaction](agentmux-desktop-interaction.md) 的本地 shell 环境约束。

- 兼容但归属未确认的 Runtime 使用持续的中性服务窗说明，不使用错误弹窗，不阻挡已有工作面；归属状态不展示路径、PID 或凭据。

## Explorer 与快捷输入区

- 键盘入口与底部设置按钮相邻并保持相同控件尺度。Explorer 忽略项弱化但可读；链接以文件／文件夹图标叠加链接标记呈现，失效链接有可访问的说明，不显示 `link` 文字徽章。行为见 [Desktop interaction](agentmux-desktop-interaction.md)“Explorer 的真实文件与快捷键入口”。
- Agent 输入区采用紧凑文本区和一排具名快捷工具；文件、截屏、技能、指令可直接辨认。发送用上箭头，中断用标准实心方块并明确标注当轮含义，避免框中套点；收起后保留轻量恢复入口与草稿提示。行为见 [Desktop interaction](agentmux-desktop-interaction.md)“可收起的 Agent 快捷输入区”。
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

### Activity 工作线聚合与错误告示（2026-09-11）
- Activity 弹层默认按 Topic / Branch / Worktree 分组；一组只占一条紧凑的 context 行，头像簇重叠排列并固定在右缘，避免逐 Agent 平铺造成纵向噪音。分组行保留 28–32px 高度、8–12px 横向内距和单行摘要；展开明细才进入逐 Agent 视图。
- 聚合行的视觉顺序固定为“context 类型与名称 → 最近摘要 → 最紧要状态 → Provider 头像簇”。类型短标签（`Topic` / `Branch` / `Worktree` / `Unassigned`）与必要的路径/Host 元信息让悬停内容可读；头像只承载身份与参与者数量，状态颜色只承载最紧要状态；不重复渲染 `N agents`、`Current` 等可由头像或选中态直接读出的标签。
- 聚合行正文点击直接定位该组最需处理的 Agent；折叠/展开使用独立的小命中区，不让用户为了导航先逐个猜 Agent，也不把展开动作误解成发送或停止。
- 未分组 Agent 使用独立的“未分组”分区，不伪造 Topic 名称；跨 Host 的同名工作线不得合并。分组标题是分类标签，不做成可选中的 Project 行。
- transient 错误使用靠近窗口边缘但不覆盖内容的 notice surface（优先顶部或侧边的保留槽），最小 32px 高，带关闭按钮与 `aria-label`；关闭按钮命中区不小于 24px。错误文字允许换行但不得把 Terminal/Activity 内容推离视口，重新查看入口放在状态或诊断面。
- Service Window Notice 继续使用持久、非模态、无关闭按钮的服务窗语汇；transient notice 与 Service Window 不共享生命周期，避免把必须持续可见的降级事实误关掉。
