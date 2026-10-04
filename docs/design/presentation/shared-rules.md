# 全局视觉、尺度与样式 Owner

本文保存本主题的视觉、密度与控件约束；行为、身份和动作资格引用交互合同，不在这里复制。原有未确认范围按正文状态阅读。

[返回视觉与密度合同](../agentmux-surface-density.md) · [同主题交互](../behavior/shared-rules.md)

**本页章节**

- [范围与基础约束](#范围与基础约束)
- [保护原则](#保护原则)
- [UI 现代化的独立评估边界](#ui-现代化的独立评估边界)
- [Agent 主观审美的判断边界](#agent-主观审美的判断边界)
- [主题与样式 SSOT 规范](#主题与样式-ssot-规范)
- [字号阶梯](#字号阶梯)
- [间距刻度](#间距刻度)
- [颜色](#颜色)
- [动效](#动效)
- [控件语言](#控件语言)
- [身份归属](#身份归属)
- [密度预算](#密度预算)
- [Owner](#owner)
- [响应式与可访问性](#响应式与可访问性)
- [验收](#验收)
- [样式表的组织](#样式表的组织)
- [非目标](#非目标)
- [语义图标密度与性能](#语义图标密度与性能)
- [成熟产品界面的控件与分组](#成熟产品界面的控件与分组)

## 范围与基础约束

Agent／Region／Tab／Category／Topic 的对象分享直接复制链接，菜单使用清楚的 Copy … Link 名称，同一对象不并列重复的名片或消息复制动作；沿既有菜单密度、图标与键盘焦点，不新增装饰或说明面。File／Browser 上下文分享保留原紧凑外框与正文阅读格式；身份、链接、命令发现及来源唯一引用[交互合同《寻址与复制》](../behavior/public-control.md#对象地址分享与方向)。普通路径、URL、选区及终端内容继续沿原复制语汇。

Provider 完整性（Session 分析、对话模式与 trace 观察）的行为与能力边界统一见 [交互合同《Provider 能力对齐与移植边界》](../behavior/agent-capabilities-and-messaging.md#provider-能力对齐与移植边界)。同类消息、资源与观察事实沿既有公共组件呈现；缺口与流程降级沿既有服务窗表达，不能逐家制造另一套控件语言。 合法空或被遮蔽 reasoning 仍沿既有 trace 折叠可达，opaque 数据不铺成正文，不增加常驻控件；真实性只定义在该交互合同。

原生会话主记录与已提交旁写日志的来源、只读快照、预算、取消与变化诊断，唯一见交互合同[《Provider 能力对齐与移植边界》](../behavior/agent-capabilities-and-messaging.md#provider-能力对齐与移植边界)；读取缺口沿既有服务窗说明，保留共同消息行、已读内容与原阅读位置，不增加常驻指标或另一套历史界面。

Outbox、Focus 时间轴与对话模式的全来源用户消息及作者、时间、投递边界统一见交互合同《用户消息从 Provider 原生会话取得》。各入口沿既有消息行、紧凑标记和按需说明呈现，不另造消息样式或增加常驻状态栏；已有说话人视觉必须服从该合同的真实作者归属。 读取范围与失败用消息面内的简短说明和就地 History／Retry 动作呈现，空态和窄窗仍可操作，不增加常驻工具栏；范围、较早记录可达性与返回行为只见上述用户消息合同。 首窗被后续工具／活动占满时的输入可达性同样只引用该交互合同；继续沿原读取说明与较早记录入口表达，不新增控件或消息样式。 原生新增记录的来源通知可靠性同样只引用该交互合同。

Focus 的未知时间输入与旧窗覆盖说明沿既有紧凑输入入口和单条消息预览呈现，不能增加一条常驻工具栏或为每个空 Context 展开消息卡。按需入口可选择 Context、扫描输入和显式继续／刷新，正文、资源和链接复用共同对话消息组件；不复制一套聊天界面、不撑高约 24px 轨道。已固定的消息预览在可用宽度变化后仍须留在可见范围内，关闭和继续读取控件可操作，并保留原正文与选区。阅读预算、选区保持、未知作者／时间与来源变化只定义在上述交互合同。 Focus 固定阅读中的复合头像、辅助归属和 Info 入口复用[《用户消息气泡的内文密度》](conversation-input.md#用户消息气泡的内文密度)，轻量 hover 保持原摘录而不叠完整资料墙；共享正文与来源详情在332px中仍可读、可操作，不重复堆出第二组姓名和空字段。资料与来源的事实边界只见交互合同中的 Focus 共同正文消费约束。

Focus 消息预览的完整表面不能被活跃 Region 的焦点描边穿过；标题、正文与底部动作连续清晰，描边在预览之外保持可辨，浮层尺寸与选择、关闭语义引用交互合同对应消息预览约束。

共用 Zone→Tabs→Regions 工作面保同一内容与控件语言，外层 chrome 由当前展示位置提供；需要分辨时用紧凑可读说明表达实体来源与当前位置，不叠重复全局标题或把位置当内容归属。下钻某 Tab 或 Region 仍有准确原动作目标与可见焦点，未知呈现不假装可输入。多位置、取消绑定与实体关闭、真实呈现及恢复只定义在交互 SSOT[《Zone→Tabs→Regions 的实体与展示绑定》](../behavior/spaces-and-layout.md#zonetabsregions-的实体与展示绑定)。

位置及公开导航回执的准确对应只定义在交互 SSOT[《Zone→Tabs→Regions 的实体与展示绑定》](../behavior/spaces-and-layout.md#zonetabsregions-的实体与展示绑定)；流程未确认的说明与原可用工作面保持可辨，不将校验未确认冒已失败的 Agent。

原生 Browser 多位置画面的活体导航、媒体与首击输入合同引用交互 SSOT[《Zone→Tabs→Regions 的实体与展示绑定》](../behavior/spaces-and-layout.md#zonetabsregions-的实体与展示绑定)。同一控件的可见画面、当前输入位置与尚未确认的交接应能分辨；失败提示停在旁侧，不遮盖健康原页面，不将「已显示」或「已聚焦」呈现为「这一击已生效」。镜像的可见画面不冒充已经证明原生输入可操作。

对象优先 CLI、跨对象 `app snapshot`、Goal／PMO 手册归域与统一 JSON-RPC 公共业务服务的行为，唯一见交互合同[《对象优先 CLI 与统一公共业务服务》](../behavior/public-control.md#对象优先-cli-与统一公共业务服务)。沿原对象身份、观察与服务窗呈现已知／unknown，不增加第二套资料名册、常驻协议栏或说明卡；本节不把目标命令与传输写成当前已实现能力。

Agent CLI 导航桌面主画面、保留 Mote 对话输入及选择／呈现／caret 事实的边界，唯一见交互合同[《Agent 操作桌面主画面与保留对话输入》](../behavior/public-control.md#agent-操作桌面主画面与保留对话输入)。沿原导航选中、工作面与服务窗表达结果，不加第二套桌面控制栏、浮窗 header、全页确认或遮挡；正常、窄窗与恢复中的实际主面和仍可输入浮窗须一同看图。

## 保护原则

本轮方向：技术架构延续原有成熟组件，视觉向 Workflow 的低干扰、分层观察语言靠拢。设计规则按「全局基础 → 观察组件 → 聊天表面」阅读；同一约束只在所属层定义，其他章节引用。产品交互和事实归属仍以 Desktop interaction 为准。

- 全局基础保留 Graphite / Mint、现有字号/间距/状态 token；克制的表面明度与文字层次取代装饰性线框和重复卡片。
- 观察组件先让用户识别对象、当前状态和需要处理的异常；数字为次级信息，详情按需展开，持续问题始终可找到。运行中、失败、未知须有非颜色提示。
- 聊天表面区分可读正文、紧凑机器步骤与需要人决定的操作；三者共享对齐、焦点和状态语言，但不压成同一种行高。权限选择和服务窗不能因美化而变弱。
- 独立 Gallery 同时展示真实 Workflow 与现有聊天组件，合成数据明确标识；深浅色、窄屏、键盘、状态更新和恢复展开意图均可核验。视觉提升必须落到真实组件样式，不能只美化展厅。 真实对话过程复用 Workflow 的紧凑步骤与状态语言，标题、具体记录时间、状态与按需展开内容有清楚主次，不能让步骤卡抢过回答正文；没有阶段事实不留空阶段壳，也不伪造百分比或 Agent 统计。输入来源、当前窗口与缺时间说明采用已有轻量来源语言，不新增常驻来源工具栏；事实与读取边界唯一见交互文档《用户消息从 Provider 原生会话取得》。 长过程的最近／失败与全部步骤披露只见交互文档[《可复用对话与 Workflow 表面组件》](../behavior/conversation-input.md#可复用对话与-workflow-表面组件)；原生过程与输入的顺序只见《共同过程与消息的记录顺序》，不能以密度压缩丢失中途输入。

- 保留 Graphite / Mint 与 terminal-first 的产品身份。
- 删除顶部空行、重复标题、线框拼装和低分辨率感。
- 描边不作为控件的主要视觉手段；Surface 填充、明度差、顶部高光和状态色承担层级。
- 一个身份层级只在一个主要位置可见；低频信息进入 tooltip、context menu 或 Activity。
- 视觉改动不得创建第二套 Agent、Terminal、Browser、Topic 或 Layout 生命周期。
- Agent 操作 AgentMux 的反馈来自 Control receipt、语义状态或原生工作面变化。自有 Computer Use 的行为与分层约束见交互合同[《AgentMux 自操作与 Computer Use 边界》](../behavior/public-control.md#agentmux-自操作与-computer-use-边界)；目标、执行中与失败原因在同一操作反馈位置呈现，权限问题沿用可行动的服务窗，不能混同 Agent 运行状态或增加外部工具的专属常驻状态栏。
- 打包来源身份属于安装与诊断边界，不在工作面新增常驻版本条、重复状态栏或第二套
  运行时状态；需要核对时通过候选报告与文件元数据完成。安装失败的保留规则见交互合同
  [《打包、安装与启动事实》](../behavior/session-recovery.md#打包安装与启动事实)，包括候选运行依赖完整和实际启动验收的约束；失败阶段停留在诊断面。
- 发布审计与运行路径校验属于同一条诊断边界：候选、canonical 安装副本和当前运行
  实例只通过身份报告对照，不在界面常驻显示版本号，也不复制一份 Session/Run 真相。
- New Browser 的结果沿用交互合同中的可见成功/失败投影：不新增常驻版本或状态条；成功时
  由聚焦 Pane 的 Tab/Region 承担变化，失败时由该工作面已有的服务窗/错误面承担反馈，
  不能留下无变化的空白点击结果。

- 本轮整体 review 延续 Graphite / Mint 与既有 Surface 层级：可靠性与焦点约束见交互合同[《整体 review 的可靠性约束》](../behavior/shared-rules.md#整体-review-的可靠性约束)。Prompt 验证降级复用 Session 服务窗，持续可见、不遮挡、不抢焦点；Board 读取失败用现有行内错误语汇，不能用无限 loading 或空态代替。高密度 Board 的排序与分组不应反复全表扫描或复制已分组成员。

- 无独立动作的聚合头像沿用相同身份和状态色，但不显示按钮手势或交互抬升；可定位到 Session 的头像保留现有悬停与键盘焦点表现。

## UI 现代化的独立评估边界

用户希望单独评价 UI 现代化，以对象层级、阅读密度、字体与空间、表面层次、图标与身份，以及窄窗、失败、焦点与恢复中的可见行为为依据。保留 Graphite / Mint、terminal-first 与现有字号、间距、表面和状态 token；测试数量或某一页漂亮不能代替完整正常、窄窗、失败与恢复流程的判断。组件化评估只见 [交互合同《组件化的独立评估边界》](../behavior/shared-rules.md#组件化的独立评估边界)，此处不重复定义。

插件贡献注册被拒绝后的目录保持与修正重试也见上述交互合同，不新增视觉规则。

用户要求把现代化实质优化到高水准并减少后续迭代绕路。正常、窄格、失败与恢复使用同一对象层级和控件语言；服务窗持续说明失败步骤、当前能力与恢复路径，完整详情随时可达，同时保留可用的终端阅读和输入空间。当前对象的身份与状态在各层有明确且不同的用途，窄窗的摘要、工具和长字段不得靠缩小正文字号或隐藏必要事实解决；深浅主题、键盘返回与减少动画偏好沿现设计系统保持一致。行为、组件贡献与 owner 边界只见上述交互合同，单次截图或评分不代替完整路径验收。

用户明确整体视觉风格要「精致、现代、简约、紧凑」。精致体现为一致的字体层级、对齐、间距、边界和状态细节；现代与简约服从对象辨识和真实反馈；紧凑优先保留终端阅读与输入面积，同时让动作可发现、文字可读。紧凑不要求每个表面同一密度，等待舞台以舒展留白和清楚主次承载当前状态与原动作，具体构图归[《启动与恢复的分量分开》](session-recovery.md#启动与恢复的分量分开)。沿 Graphite / Mint 的既有 palette 与 token 收敛，不以堆叠卡片、装饰阴影、渐变或缩小正文字号代替信息组织。整体美术保持高冷、现代与效率感；局部插画采用更平面、简洁的品牌语言，以克制构图、清楚轮廓和大块形体与当前字体、图标、主题和表面层级协调，避免过度设计。具体角色、材质与局部配色属于设计选择，不把一批素材的画法扩成全 App 的配色或控件规则；独立素材的清晰度和材质细节不能代替真实页面的协调与主次。插画不替代动作标签、当前值、状态和反馈，也不把静态装饰画成运行、选中或已确认；密集终端、工具条、列表与编辑区继续以文字和语义控件为主。

## Agent 主观审美的判断边界

所有界面改动的通用视觉交付约束唯一见 interaction[《Agent 主观审美的端到端验证》](../behavior/shared-rules.md#agent-主观审美的端到端验证)，本节只定义判断边界。


独立 Agent 基于已经看见的真实产品截图，结合当前任务和本合同判断层级、紧凑程度、对齐、留白，以及信息与控件是否清楚；结论须说明画面中的具体位置、为何影响阅读或操作，以及怎样修正。同一截图可有主观分歧，保留理由与未确认事项，不把评分或单个数字伪装成审美真相。

具体像素阈值、截图差异分数或 CSS 字符串只能辅助核对明确的工程事实，不能自动判定精致、现代、简约或紧凑，也不能为了某一个画面的距离发明专用门槛。真实操作、采集身份、独立看图、每批执行证据、fixture 与需求一致性及失败保全只见交互 SSOT[《Agent 主观审美的端到端验证》](../behavior/shared-rules.md#agent-主观审美的端到端验证)；本节不另设场景清单或第二套设计规则。 用户要求独立审美评审到明确满意为止，修正／复拍及交付边界同样只归该交互章节，不以本节几何或评分替代。

## 主题与样式 SSOT 规范

主题系统采用“运行时 CSS 真值 + 类型化语义边界 + 可选适配层”的三层结构：

- `styles/tokens.css` 是全站主题值的唯一真值。颜色、字号、间距、圆角、阴影和动效都在这里定义；
  其他样式表只能消费既有 token，不得定义第二套全局主题值。用 `:root[data-appearance]` 等选择器读取已有外观，是消费既有主题，不是声明新的主题真值。
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

这套规则吸收了现有 CSS 的单一入口、语义映射与类型边界这三条成熟实践，但不把任何宿主 UI 框架
引入核心包。共享 UI 包只消费这组语义契约，不能拥有第二套主题值；Gallery 与产品使用同一外观解析和系统偏好监听，不能把缺少外观属性当作跟随系统。

设计语言要能被执行，前提是它在代码里**有一个可引用的名字**。散落的字面值不是"细微调整"，是把设计决策
藏进 2000 多行样式表里：改一档字号要靠 grep，改错一处没人发现。因此三类尺度全部收进 token，
**样式表里不再出现裸字面值**。

## 字号阶梯

六档，够用且不多。每一档有明确职责，选档看**这段文字是什么**，不看它想显得多大。

| Token | 值 | 职责 |
| --- | --- | --- |
| `--fs-micro` | 10px | 微标、角标、计数、时间戳。密度下限，不得更小 |
| `--fs-meta` | 11px | 元信息、caption、次级说明、工具栏文字 |
| `--fs-body` | 12px | 列表行标题、按钮、输入框、菜单项——界面默认字号 |
| `--fs-prose` | 13px | 可读正文：Agent 回合、对话、长文本 |
| `--fs-title` | 14px | 卡片与对话框标题、区块 header |
| `--fs-display` | 20px | 页面级标题（Board、Settings、New Tab、Welcome） |

等宽内容不另设字号档：它按所在位置取对应档位，与 `--font-mono` 配对即可。Terminal 字号仍由原 owner 原生渲染；Editor 的继承与显式 override 只见行为合同[《Explorer 与 Editor》](../behavior/files-and-git.md#explorer-与-editor)，实际字形与行距由 Monaco 原生渲染，不另设一份 App 默认值。


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

## 间距刻度

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

## 颜色

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

## 动效

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
  最显眼的位置让给了最没有信息的图形。工具属性不是设计粗糙的理由。恢复、启动与停泊的当前
  材质、布局和动效合同见[《Terminal 信息与恢复画面的视觉品质》](terminal-reading.md#terminal-信息与恢复画面的视觉品质)，沿共享大屏表达真实阶段。
- **动效不得是唯一的信息载体**。减少动态时，静态画面、阶段文案和动作仍须准确表达忙碌、停泊
  或失败，不能只留下看不出状态的静图。这条对所有新动效成立，不只恢复态。

## 控件语言

应用内同类单选字段共用紧凑触发器、可滚动选项层与单一选中标记，复用既有菜单库的键盘导航、类型检索、Escape、返回焦点和窗口弹层宿主。控件不自行加载数据或执行领域动作；原对象标识、未知选项、保存草稿和资格由原调用者持有。长选项保全文可读，窄窗内弹层不越界，不让系统菜单与应用菜单在同一功能组混用。执行器选择复用同一领域组件，以目录或紧凑字段呈现原 Host 侧头像、名称、Provider 和可用状态；未知不冒充不可用，保存的失效身份仍可读，不各自复制发现逻辑。

| 层级 | 视觉语言 | 用途 |
| --- | --- | --- |
| Primary | 实心品牌绿渐变、深色文字、顶部高光 | 页面唯一主操作 |
| Secondary | 干净 Surface 填充、软高光、无常驻描边 | 次级操作与行内确认。**落地类名只有 `.small-button` 一个**，见下「一档控件只有一个类名」 |
| Ghost / Icon | 透明底，hover 才提升 Surface | 图标按钮与工具栏动作 |
| Selected | 单一几何信号；实心图标格或底部横条 | Project、Segment 与 Tab 选中态 |
| Danger | 实心红色变体、深色文字、顶部高光 | 删除、移除等破坏性主操作 |

补充规则：

- 同一语义在不同容器中使用同一控件层级。
- 文本输入聚焦用一条清楚、克制的焦点边界，与原控件边缘对齐；内嵌提问、改名、创建和配置字段不叠粗亮外圈、内边与光晕。复合输入由整个输入容器表达焦点，内部文本框不再画第二圈；独立输入的键盘焦点仍须可辨。深浅主题和强制颜色下保留焦点、错误及禁用的区别，不改变原草稿、IME、保存与取消语义。基础单行、多行与组合输入使用共享 client-ui 输入模块；模块持有原生控件和呈现，入口持有草稿与业务动作。富文本消息编辑复用既有共享 Composer，保持与原生字段分层。
- Mote 等内嵌提问入口使用轻而可辨的组合输入：淡底色、单层完整边界，文字保留横向留白；单行约 38px、左留白 12px，不以零 padding 或仅底部细线表达可编辑区域。聚焦时完整边界与底色清楚响应，行动按钮位置固定且有轻底座，内容就绪后使用柔和 Mint 色；长问题自然增高并有界阅读。普通改名和搜索保留紧凑尺度。准备讨论的原业务语义不变，快捷键须尊重组字，在途与失败沿真实读取状态表达并保留问题；行内忙态复用共同 spinner。
- **一档控件只有一个类名。** 上表五档各自只有一个落地类名：Primary＝`.primary-button`、Secondary＝`.small-button`、Ghost/Icon＝`.icon-button`、Danger＝`.danger-button`。**不得按表里的档位名另造一个类名**——那个名字读起来像"就该存在"，于是没人会去查它有没有规则。实证：`.secondary-button` 被这样写出来过一次（启动页 Resume），全仓零规则，而 `base.css` 的全局 `button` 只重置 `font`/`color`、**不重置 `background`**，于是它落到 macOS 原生按钮样式——一颗浅灰实心药丸，在深色主题里比紧邻的品牌绿主操作还重，恰好推翻上表"Primary＝页面唯一主操作"。这条由 `apps/desktop/test/rendered-class-has-rule.test.ts` 守住：它的扫描面除 BEM 记号外**还收 `-button` 结尾的扁平类名**，渲染了却没有规则即红。扁平名此前整族在扫描面之外（判据只认 `__`/`--`），这不是漏登记而是结构性缺席，所以修的是判据形状而不是加一条豁免。
- **`justify-content: space-between` 是一份「有几簇」的契约，不是"把东西摊开"的通用手法。** 它把自由空间**摊在子元素之间**，所以结果是子元素**个数**的纯函数：两簇时各抱一端（这才是它的用途），三个以上松散子元素则被甩向两极、中间留出大洞。这份"应该有几簇"的期待写在 CSS 里，而供给子元素的是另一个文件里的 JSX，两边没有任何东西对齐它们——**供错形状不报错，只是默默排错**，而本仓测试跑在 happy-dom 下不算布局，没有任何 gate 会红。因此：**space-between 只用于子元素集合固定且已知的容器**；凡是"一个留在左缘、其余聚到右缘"的工具栏与页脚，一律用 `justify-content: flex-end` 配首元素 `margin-right:auto`——它对 2、3、4 个子元素都成立，**契约本身被删掉了**，而不是被记在文档里等人遵守。这套写法本仓已有多处（`surfaces.css` 的 `.settings-pane-actions`、`dock.css` 的 `.workspace-composer > footer`、`board.css` 的 `.discussion-canvas__footer`）。实证：`.composer__toolbar` 与 `.settings-pane-toolbar` 都配了 `> div` 的两簇写法，各自有一个调用方老实给两簇、另一个调用方给四个松散子元素，于是同一条规则在两个界面上同时排错。
- **选中态一律不用左侧竖条（inset 竖线）**。一条贴边的亮色竖线是"AI 生成的管理后台"最容易辨认的印记：它既不是填充也不是描边，只是一根贴在行左缘的装饰，在密集列表里连成一片噪音。选中由**单一几何信号**表达——干净的 Surface 填充，必要时配实心图标格。这条对所有列表行成立（Project Rail、Topic、Tree、Segment、Settings 分区），没有例外；`box-shadow: inset <n>px 0 ...` 与 `border-left: <n>px ...`（含 `border-inline-start`）这两种拼法都不得用于表达选中——它们在屏幕上是同一根线，禁的是那根线而不是某一种画法。这条由 `apps/desktop/test/surface-selection-contract.test.ts` 守住：它从 CSS 推出两种拼法的所有左缘竖条并在选中态类名上断言其不存在，加回一条会红；两个形状判定各自带一条自证（拿合法的容器分隔线与内容引用条当样本），因为一个认不出竖条的检查会因"没找到"而全绿。
- **一列全同的图标不是信息，是宽度开销**。若某个列表里每一行的行首图标都相同（重复的 Topic 类型图标、纯文件列表的文件图标），去掉它——图标的价值在于区分，无可区分时它只在挤压标题的可读宽度。行首位置留给真正有区分度的东西（对象的手动或自动身份、状态、Provider 身份）或干脆留白；Space 的共用对象身份槽遵守[《Project Rail 与 Topic 行密度》](spaces-and-layout.md#project-rail-与-topic-行密度)。

用户要求替换 Mote 和项目中制式的 AI 星芒图标。Mote 默认类型图形使用原创 SVG 标记，以克制的不对称实体轮廓与留白表达微小但稳定的身份；在 12–24px 保持清楚，跟随当前文字颜色，无渐变、阴影、滤镜、装饰性星芒或动画。相同 Mote 类型入口共用同一标记；对象可按[《Project Rail 与 Topic 行密度》](spaces-and-layout.md#project-rail-与-topic-行密度)的共用身份规则选择手动图标。项目自己的通用 AI 星芒（Lucide Sparkles / WandSparkles）退场：新建工作面用创建语义、技能用技能语义、跳过权限提示用明确权限语义；现头像 spark 徽标保留原数据含义而更换其字形。保留 Provider 官方品牌资产，不能把它们当成制式 AI 图标替换。产品身份边界见 interaction[《Space、Folder 与 Topic》](../behavior/spaces-and-layout.md#spacefolder-与-topic)。

Mailbox 原生输入的来源更新与有界阅读告示引用交互文档《用户消息从 Provider 原生会话取得》；沿原有就地边界与服务窗语言，不新增常驻工具栏、另一套状态或消息表面。

## 身份归属

| 位置 | 主要身份 | 不应重复的内容 |
| --- | --- | --- |
| Project Rail Row | 选择了哪个 Project、在跑几个 Agent、要不要你 | 完整路径、worktree 数与 Session 详情 |
| Topbar Breadcrumb | 当前主区 Workspace 与 Branch | 完整绝对路径 |
| Tool Dock Header | 文件树根与可见路径 | 第二个同义图标或重复 Breadcrumb |
| Session Tab | Session 名称、Provider、状态 | 第二条 Session Info Bar |
| Tooltip / Context Menu | Session ID、Host、开始/活动时间 | 常驻占用内容高度 |
| Activity View | 最近消息和结构化事件 | Terminal 上方的重复摘要 |

macOS Dock 的系统徽标只显示当前待用户处理数，零时不显示；使用平台原生样式，不增加窗口内第二个同义控件。事实与更新行为归交互合同[《Agents / Session / Board 与注意力闭环》](../behavior/goals-and-demand.md#agents--session--board-与注意力闭环)。

消息与 Agent 地址的具体可读性约束见交互合同[《A2A 消息要让人一眼看懂》](../behavior/agent-capabilities-and-messaging.md#a2a-消息要让人一眼看懂)；本层只要求工作面优先显示紧凑地址，不常驻铺开机器回执或完整 ID。

## 密度预算

| 对象 | 预算 | 说明 |
| --- | --- | --- |
| Titlebar Plane / root Tabbar | 36px | 与窗口顶边和相邻 header 对齐 |
| Pane Tabbar | 31px | 分屏 leaf 的紧凑索引高度 |
| Project Rail Footer / Corner Badge | 32px / 28px | Footer 只容纳两个 24px 图标入口 |
| Project Rail Section Label | `--fs-micro`；轻字重；紧凑上下留白；尾部常驻 `+` | Motes、Topics、Folders 是分组标签，不是重复页面标题；项目名称保持主要阅读层级，分区创建的含义归交互合同 |
| Project Rail Group Header | 随行密度为 20–24px；`--fs-micro`；字重 560；紧凑字距；折叠与类型共用一槽 | 共同父目录名只显示最后一段，完整路径进 tooltip；只领一个成员时不渲染。分类标签轻于对象标题，折叠只为真实子项提供，不在叶节点预留箭头槽。hover 只提亮文字，不借用对象行的 Surface；折叠后保留可读组名和紧凑地址，完整成员及状态仍可获知。 |
| Project Rail Group Collapse | 折叠态持久化；折叠后头上补地址与角标 | 用户「分组上面是不是应该有些操作？」——折叠是这个位置唯一说得通的动作。分组是从磁盘路径**派生**的，不是可重命名/删除/配置的实体，给它挂那类操作就是凭空发明一个注册表。<br><br>用户「后退的时候，是不是应该显示它的地址之类的元信息呀」——折叠就是那个"后退"。成员一藏，这一行就是那几个项目在界面上唯一的痕迹，于是它必须自己答出身份：**地址保留尾部三段**（`~/proj/kit`），因为同一台机器上路径开头几段大都相同，分辨力全在末尾——这也是不能用 CSS `text-overflow` 的原因，它砍掉的正是唯一有信息的那一头；以及**成员数**。<br><br>展开时地址与角标都不渲染：下面那几行项目名已经答完"这是哪儿"，每行也各自带着角标，再挂一份就是同一事实占两处。<br><br>折叠**必须把注意力卷上来**（复用项目行那一个 rollup 与那一套配色）。这是一个已经犯过一次的错：项目行只显示 workspace 计数时，"一个 Agent 正在里面等你"的折叠项目看起来和空闲的一模一样；分组折叠会在分组这一层原样复现那个洞。折叠状态的 key 必须带 hostId——两台机器上同名的 `…/kit` 不是一个分组。 |
| Project Rail Row | 28–32px 单行；标题从统一左缘起；尾部独立运行状态槽 | 选中只用中性 Surface；运行中的 Agent 在相关项目行显示独立活动控件；行首图区分项目、仓库和目录。**一行只占一行**——标题与状态同处一行，不为常驻元信息另起次行。尾部计数是**在跑的 Agent 数**，不是 worktree 数：用户问的是"这个项目现在有没有人在干活"，worktree 有几个是仓库结构，答的不是同一个问题，降级进 tooltip。计数为零时不显示数字（一列全是 `1` 的徽章不携带信息，见控件语言同一条理由）。Host 只在**不是本机**时占位——`This Mac` 每行都一样，属于一列全同的元信息 |
| Project Rail Nesting Indent | 分类成员一级 12px；真实父子每层 12px、最多 3 层；三档密度均保持可辨 | Motes、Topics、Folders 的成员身份图形相对分类身份图形增加 12px 阅读缩进，成员标题相对分类标题至少增加 12px；同级对象身份槽与标题共用基准。不把分类当作实体目录；路径聚合组与真实后代另按每层 12px 增加层级。只保留一份必要外缘，不叠加容器留白、空箭头槽或空图标槽；Pinned child 遵守同一层级差，无连接线。 |
| Project Rail Pinned Child | 比 Project Row 小一档；hover 只下划线；靠一层缩进与 pin 标记表达归属 | Pinned Topic/Branch 是导航入口，但视觉上是从属内容。标记不携带选中或注意力状态，不画虚线、树干或拐线，也不把子项重新当成一个顶层项目 |
| Explorer / Branch Header | 32–34px | 不形成第二层大 Topbar |
| Tree Row | 24px | 保持键盘扫描和专家密度 |
| Tool Dock Width | 默认 300px；最小 236px；最大 440px | 同时容纳 Explorer / Branches，保留主工作面容量 |
| Tool Content Padding | 8–12px | 仅用于局部卡片，不包住整栏 |
| Context Menu | 176px 最小宽；26px Row；8px 横向 Padding；5px 容器 Padding | 全部 Context Menu 共用一套基座。Surface 填充 + 阴影 + 顶部高光建立层级，**不使用描边**；hover 提升明度并把图标转为品牌绿；破坏性项 hover 保持红色语义，不被绿色 hover 覆盖。菜单从指针处生长（120ms），表明它是这次点击召唤出来的，而非盖在界面上的一层浮层 |
| Activity Log Row | 24px Row；20px 节点槽；56px 等宽时间槽；12px 横向 Padding | 与 Tree Row 同一节奏。整列共用一条 hairline spine，节点用填充光晕挖空它而非画环。展开内容与该行标题同一左缘（104px），不得比自己的标题突出。**仅**机器上报（tool_call / permission / lifecycle）走这一寄存器 |
| Scratch Topic Row | 标题 11px、摘要 10px 次行；presence 18px 成簇锚定行右缘并垂直居中；结构摘要使用 `--fs-micro` | 一行回答 Topic 身份和工作面结构。Agent 用 Provider 图标成簇表达身份与状态；**同一可复用 presence 组件同时给出 Tab 数量与 Region 结构**。hover 显示 Tab 顺序/标题、分屏布局、每个 Region 的 Executor 和最近活动摘要；没有摘要明确显示 `No recent activity`。键盘 focus 时显示同一结构摘要，不能把 hover 当作唯一信息来源。**不重复呈现同一事实**：不再另挂无法定位的总 Agent 数；结构详情只在一处出现，定位动作仍走全局 `selectSession`。行首不用重复的 Topic 类型图标；对象的共用手动身份遵守[《Project Rail 与 Topic 行密度》](spaces-and-layout.md#project-rail-与-topic-行密度)。选中态使用 Surface 填充，不用左侧竖条。 |

- Topic presence 的静息密度已经收口：Region mosaic 的 Agent 头像只在真实 Region 单元格内出现，背景 Agent 头像与它们不重复；结束态不渲染，未知/断开仍可见并保持中性状态。焦点 Region 沿用共享 1px token，Tab/Region 结构详情通过 hover 与键盘 focus 进入，不增加常驻大卡或第二层状态条。
| Activity Turn Row | 与 Log Row 共用同一 spine 与 20px 节点槽（14px 图标）；正文 13px/1.6 用 `--text` 主色，caption 11px `--text-3` 大写，时间移到行首右侧的 mono 戳；上下各 6px 呼吸 | user_message、assistant_message 两个可读回合脱离 24px 机器寄存器：正文是主体不是 payload，永不裁剪、永不折叠。<br><br>用户「User 发的消息要单独显示」。**用户发言整块成立**——底色、内缩、圆角与左侧 2px 实心色带一起把它围成一条独立的发言，而不是只给正文一层底：只给正文时 caption 与时刻浮在底色之外，一句话读起来是"一个标签 + 一块底色"两件东西，扫下来与 Agent 回合只差一点底色深浅。成块之后正文自己不再叠第二层底（浅底叠浅底边界更糊），字色降一档——用户自己的话是"我说过什么"的回看，Agent 的答复才是主叙述。Assistant 正文在 S0 上流动，保持敞开的叙述形状。<br><br>那道色带**不属于**被禁掉的选中竖条：禁令针对密集列表里表达**选中**的贴边装饰，这里既不表达选中也不在列表里，走的是同文件已有的**内容**语汇（`.md-quote`、`.log-row__output` 同样用 2px 左侧色带说"这一段是引来的/跑出来的"），一句被读回的用户发言正是一段引文。边界仍由填充承担，色带只在一侧、不画出框。<br><br>形状按 **SPEAKER ROLE** 选，不按 kind：A2A 落地后 agent 侧不管有多少身份都保持同一形状，而"这台机器前面的人说的话"始终是被框起来的那一条。native-hook 的 assistant 回合不进入折叠 |
| Activity Turn Prose | 标题全部 13px（与正文同号）靠 600 字重与上下留白分级；表格 4×9px 单元、hairline 行分隔；引用块左缩 9px 配 2px 竖线；水平线 1px | 对话回合的正文渲染 GFM 子集：标题、强调、删除线、行内与围栏代码、有序/无序含嵌套列表、表格（含列对齐）、引用块、水平线、链接。**多级标题字号完全相同**——密度合同对字号设下限并禁止用尺度买层级，故 h1..h6 只靠字重、颜色与留白区分，绝不放大。解析器（remark-parse + remark-gfm）只产 mdast **语法树、从不产 HTML**：节点映射为 React 元素，`dangerouslySetInnerHTML` 从不出现，因此不可信的 Agent 输出**没有东西需要 sanitise**——风险面是构造性为零而非"已过滤"。raw HTML 节点按字面文本呈现，绝不成为标签。宽表在自己的 `overflow-x` 容器里横向滚动，不得撑宽回合、更不得让整个 feed 横向滚动。链接渲染为 button 而非 `<a href>`，经既有 openExternal seam 打开（不可信输出里的 `<a>` 是导航逃逸口）。只在 turn register 渲染；机器行保持纯文本，纯文本也不进解析器以免重排从来不是 markdown 的句子 |
| Activity 历史读取入口 | 当前对话区域内的紧凑轻透明浮动提示和安静文字动作，无全宽边框／独立历史面板；加载状态不占正文行、不推动卡片或改变阅读区高度，正常可读正文不被覆盖；耗尽且无动作时不留空位 | 原较早／回到最新／Return／恢复动作不变；真实等待沿现 Workflow SVG 和短淡入动画，减弱动态时静态；仅局部 polite 通知，不把整个阅读区设 busy，不造百分比、历史总数或另一读取状态；正文选择与原交互不被浮层拦截。数据与保护边界见行为专题[《History 使用共同对话阅读面》](../behavior/terminal-reading.md#history-使用共同对话阅读面)。 |
| Activity Ruler | 顶部sticky；一行紧凑起止／已加载记录数与范围入口；一排24px参与者轨＋14px状态标尺 | 默认24h，可选6h／12h／24h／3d／7d／全部时间；初始和扩大范围沿共同阅读合同异步补读，缩小仅收窄概览。真实已载成员决定起止，记录不足时收紧轴，不铺空白时段；耗时与偏移进入悬停／键盘说明，无跨度序数退化。身份、密度、状态与可见区共用唯一坐标与原目标。低对比较早记录和较亮最近已记录一小时，最多48桶微高度表达记录密度；连续实线表示已记录工作、轻虚线表示已记录空闲，等待回应独立色，缺事实中性未知。可见范围以14px轨内清楚的轻填充边框标出，置于状态装饰之上、事件刻度之下；正文遮挡按实际sticky高度，折叠过程标题代理原记录，展开后按真实步骤观察。可见区观察不进滚动热路径。详细事实边界只见交互专题的顶部参与者轨约束。 |
| Activity 时间读数 | 时刻固定 `HH:MM:SS` 24 小时补零；时长按最高非零位起报 `3h04m03s` / `4m03s` / `3.2s` / `840ms`；均 mono + `tabular-nums` | 用户「时间只显示分钟太不友好了, 应该显示从什么时间点到什么时间点, 消耗的时分秒」。<br><br>**时长不在分钟处封顶。**小时位不是可选修饰：Agent 跑一下午是这个产品的常态，而封顶的实现会把一次三小时的 Session 报成 `184m03s`，让读者自己去除以 60。低位补零（等宽下不跳位），高位为零则省掉（短跑不必读 `0h00m03s`）。这条同时管偏移量、标尺跨度、折叠段耗时与读屏可访问名——**只有一个格式化器**，四处共用；任何一处靠切字符串（`+3h04m03s` 去掉加号）拼出时长都会在前缀变化时啃掉一位数字。<br><br>**时刻用固定 24 小时而不是 `toLocaleTimeString`。**读数落在等宽的时间沟里，一列上下必须对齐，而 locale 格式的宽度随小时变化（`h:mm:ss a` vs `HH:mm:ss`）。日志读数取可预测的对齐，这也是各类日志查看器的通行做法。<br><br>**三个事实各就其位，不重复。**标尺头上给真实起止与已加载记录数，耗时退入悬停／键盘说明；一句话的行内给**时刻**（一句话关心"什么时候说的"），偏移量退进 title；机器行直接给**具体时刻**，折叠头给**［记录起时－记录止时］ · N steps**；偏移量退进悬停／键盘可读的时间说明，原耗时若保留仅作次级信息。较长范围用自然换行而不扩大固定时间沟挤掉工具名；同日短钟表、跨日带日期，宽窄都能完整辨认。时间事实与组范围边界只见交互 SSOT《Activity 记录时间的直接阅读》。<br><br>**没有时间可报时不报。**序数轴不渲染跨度，同刻的折叠段不渲染耗时——硬报一个 `0s` 会把 ruler 在类型上刻意排除掉的那种不诚实又请回来（见 Activity Ruler）。<br><br>**分档按将要显示的那个值判。**秒档显示到 0.1s，所以先把时长归到十分之一秒再决定进不进分钟档。两个精度各判一次必印出这套记法里不存在的读数：以整数秒判档、以四舍五入显示，`59_950ms` 会留在秒档而印成 `60.0s`；分/时交界同理会给出 `59m60s`。<br><br>**「一个格式化器」是可执行的约束，不是文档里的说法。**偏移量整段就是「一个符号 + 一段时长」，不自带毫秒档与秒档——那两行与时长格式化器同义，留着就等于同一条规则住在两处，而它真的走岔过：分档修好之后时间沟里仍印着 `+60.0s`，而机器行每一行都在读它。<br><br>**折叠段的耗时算到末步跑完，不是算到末步开始。**起点是首条的 `createdAt`（这一步开始），终点是这一段里最后完成的那个 `updatedAt`（这一步结束），取 max 因为并发几步的完成顺序不必跟着开始顺序。末步往往是最贵的那一步（build、跑测试），拿"末步开始"当终点会把它整段跑的时间漏掉——一个藏着五分钟构建的折叠头会宣称自己只有 1 秒 |
| Activity 对话轴 | 一排24px高；头像16px，单标记命中24px，参与者簇命中64px | 沿共同消息头像；簇露出最多三个唯一参与者＋余数，完整记录原菜单可达并明确This agent／Sender。完整命中框容纳头像及余数，端点可内侧避让，真实刻度不移位。稀疏原话预览、键盘／Escape共享协议；按实际宽度聚合，不改来源或时间事实。 |
| Tool Dock Header | 30–34px；10px 左缩进；24px 图标按钮 | 各工具坞标题共享同一左缘。分屏时上下堆叠的标题必须对齐，近似对齐比不对齐更伤观感 |
| Agent Attention Bar | 24px 高；横跨整宽；12px 横向 Padding；12px 段间距；11px tabular-nums | 窗口底部唯一的跨会话注意力汇总。`surface-1` 填充 + 顶部高光 + 一条 hairline 顶边界定它，不使用描边。复用共享状态点语汇，计数为零保持中性灰；栏存在时把折叠的 Rail 角标抬高让位，纯 CSS `:has()`，不耦合 JS |
| Agent Provider Catalog | 142px 最小列宽；44px Card；最多 268px 高 | 容器独立滚动，不扩大 Launcher。**「不扩大」是容器自己的约束，不是"卡片少所以碰巧没长"**：容器必须带有界高度与独立 `overflow`，Agent 装多少都不得把下方的 prompt 推下去。这条由 `apps/desktop/test/surface-scale-contract.test.ts` 守住——它判 `.agent-catalog` 的规则体里 `max-height` 与 `overflow` 同时在场（先断言确实扫到了这条规则）。守的是"有界"这件事而不是 268 这个数：把数字抄进测试等于同一个值住两处，改一处就漂 |
| Settings Pane | 两层容器，不是一层：**可操作/主内容**卡＝`--surface-1` + `--elev-2` + `--hl` + `--radius-lg`（抬起）；**信息/次级**块＝与页面同底的平铺 `--surface-0` + 一条 `--line-soft` 发丝线，无阴影、不成盒。卡片/区块标题走 `--fs-title`(14)，说明降到 `--fs-meta`/`--text-3` 读作从属；区块头句首大写 `--text-2`，不叠第三层大写字距 | 此前一条规则把合成器、只读说明、执行器分组、工作区列表压成同一个平面，于是整屏一样重、读不出主次——两层的"抬起 vs 平铺"对比**就是**这次重做。**装饰性 hero 说明卡已退役**（见控件语言"装饰性强调图标格"）：绿只留给状态与唯一主操作。侧栏选中＝干净 Surface 填充（`--surface-2` + `--hl`，与 Project Rail active 同语汇），绿落在该项图标或 `aria-current` 上，**不画整圈描边**——侧栏本身是 `--surface-1`，往选中态填 `--surface-1` 等于没填，会让 hover 反而比选中更"实"。每节导航前缀图标各不相同，予以保留。入场用 `--dur-enter`/`--ease-enter` 的淡入上浮，不做长时遮罩揭幕或光标跟随——那类破坏工具身份 |
| 操作与元数据文字 | 11–13px；微标不低于 10px | 不用 7–9px 冒充密度 |
| Terminal / Editor | Terminal `12px / 1.0`；Editor `14px / 21px` | 由 xterm/Monaco 原生 DPR 渲染，不使用 CSS transform |
| Terminal replay recovery | 有界批次；批次间让出事件循环；连续 live bytes 合并成视觉批次；输入/切换控件不被输出队列饿死；切回时按视口记忆停在上次位置或最新输出 | 大量 scrollback 恢复时优先保持界面可操作，避免一次性 parser 工作造成假死、逐字绘制或把回放过程暴露成从顶部滚落 |
| Terminal link span | 裸 URL 下划线只覆盖 ASCII URL 本身；相邻 CJK 文字/标点保持普通终端字形 | 链接边界属于交互合同（见 [`agentmux-desktop-interaction.md`](../agentmux-desktop-interaction.md) 的 Terminal 链接约束）；不因相邻中文输出改变 URL 的目标或悬停范围 |
| Terminal link readout | 延迟出现的边角被动读出；目标为主层、真实类型 / 来源和打开方式为紧凑次层；长目标保留可辨部分，宽度不超过 Region | 用户要求「hover 浮窗信息不清晰」：提高真实目标与动作说明的可扫读层级，用平面、轻边界与共享可读刻度，不加图标按钮、快捷键胶囊或重复路径。事实、清除、避字与打开边界唯一见交互 SSOT[《Terminal 链接读出与目的地面的信息归属》](../behavior/terminal-reading.md#terminal-链接读出与目的地面的信息归属)及[《Terminal 链接 hover 范围与单元格》](../behavior/terminal-reading.md#terminal-链接-hover-范围与单元格) |
| Terminal restart projection | Runtime 未确认期间保留布局但在 Region 内显示中性等待/不可用状态；权威 snapshot 确认旧 PTY 不存在后清掉 Terminal Region/Tab，不留只有标题的空壳 | Terminal 没有 Provider-native semantic resume，不能把未知身份伪装成可用终端，也不能让临时探测失败变成永久空 Tab |
| Confirmed Agent crash notice | 沿用现有服务窗与唯一错误提示；由同一分类派生 ARIA 音量 | 行为边界归交互合同[《我们的流程坏了，不等于 Agent 坏了》](../behavior/session-recovery.md#我们的流程坏了不等于-agent-坏了)。不另造弹窗、严重度颜色表或覆盖工作面的遮罩 |
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
- 每个图标按钮必须有 tooltip、`aria-label` 和可见键盘 focus。正常、禁用与忙碌状态由同一公共控件表达；禁用时不响应 hover 或按下效果，不用可点击指针暗示仍能执行。业务动作是否可用仍由原 owner 决定。
- Tab 名称始终单行；过长省略，空间不足时由 Pane 内横向 overflow 解决。
- Surface 明度和状态色必须保持足够对比；不可只靠颜色区分选中、危险或不可用。
- 共享状态点（`.status--{state} .status__dot`，StatusDot 与 Attention Bar 的 StatusCount 同源复用）中，"需要你"（`waiting`/`blocked`）必须带**形状**而非仅靠颜色：琥珀圆点内嵌 `?` 字形，使其在色盲与快速一瞥下仍与其他琥珀含义可辨。`disconnected` 是掉线而非请求关注，从琥珀让出、改用中性空心环，令琥珀唯一地表示"需要你"。5px 角标（Tab 角、Rail 行）容不下字形也无需字形——颜色加角落位置已足够区分，字形只在全尺寸状态点上浮现。
- **Agent 字母牌**（叠压头像簇里同 provider 多个 Agent 的判别器，可见判别见[对应呈现合同](spaces-and-layout.md#agent-头像簇的可见判别)）：与项目字母牌共享字形与几何语汇——`--fs-micro`、`font-weight: 640`、`line-height: 1`、`overflow: hidden`（emoji 比字母宽，会撑破格子），色相走既有派生并在规则里**声明**默认值（不藏进 `var()` 兜底，全表守卫读的是声明）。不为 Agent 新挑尺寸或配色，保持既有 Provider/会话身份语言。Space 自动对象身份的低彩度约束只见[《Project Rail 与 Topic 行密度》](spaces-and-layout.md#project-rail-与-topic-行密度)，不改变 Agent 头像的既有派生色相。
  - **10px 不需要豁免，它就是刻度的最小值。** 曾在此写过「字母受 10px 下限约束、须先放大头像格」——那是把「低于 10px 需要具名豁免」错记成「10px 需要豁免」。事实：字号刻度含 10（`--fs-micro`），而 `FONT_SIZE_EXCEPTIONS` 被恒等断言冻结在 7px 且每条都必须真画 `content` 字形，所以字母**根本走不到也不需要**那条豁免路；`.project-rail-row__icon[data-monogram]` 正是在 **16px** 格子里画 10px 字母，一直合规。**头像格不必为字母放大**。这条更正的意义不止于本条：涉及尺寸的约束必须从刻度与守卫的断言反推，"我记得有个下限"不是判据。
  - **一个格子里放第二个记号，本仓的既有答案是角标溢出而非扩容。** 注意力那枚 `?`/`!` 就是这么做的（8px 见方、探出格外），因此第二个记号不以牺牲品牌图标为代价。字母若落在这个位置，须先解决与注意力角标的占位冲突（两者不能同时在同一角），这是一个**取位**决定，不是尺寸决定——裁决见下条。

- **叠压头像簇的角位分配：可见的两角归"必须始终可见"的两枚，其余记号让位。** 这条裁掉上面那个悬而未决的取位问题，也修正它与交互合同里"两条左缘都空闲"的同一处错算。

  **几何前提**（从样式表反推，不照注释抄）：头像 18px，`.selector-presence__slot + .selector-presence__slot` 负 `margin-left: calc(-1 * var(--sp-3))` = 6px，z-index 随 DOM 序左→右递增，故**右压左**——每一枚自己的**右 6px 被右邻座整枚盖住，左侧在上**。于是四角里只有**左上、左下**落在可见带上；右上、右下对"非簇尾那几枚"恒不可见。

  **可见角只有两个，而记号有四种**（此前两份文档都把它数成三种，漏了用户自定义徽标 `.agent-avatar__badge`——它一直占着左上，所以"两条左缘都空闲"从来不成立）。因此必须排序，判据是**看不见的代价谁更大**：

  | 记号 | 落角 | 理由 |
  |---|---|---|
  | 注意力 `?`/`!`（`.agent-avatar__status`） | **左上** | 全产品最响的通报"这个 Agent 在等你／出错了"。看不见＝用户不知道该去响应，代价最大，拿第一个可见角。 |
  | provider 归并计数（`.agent-avatar__count`） | **左下** | 它回答"这一枚代表几个"，读错会数错 Agent 数量。拿第二个可见角。 |
  | 用户自定义徽标（`.agent-avatar__badge`） | **右上**（让位） | 用户自己挑的静态装饰，不通报任何变化中的事实；被邻座盖住只损失装饰，不损失信息。四者里唯一可让的一个。 |
  | 显示名字母牌（f-27a8f3deq/T-002） | **右下** | 它的判别力只在"簇里有多枚"时才被需要，而多枚正是它被盖住的场景——所以它**不能靠角标位交付**，取右下只是登记占位。这条因此同时是对那个 task 的约束：字母牌要真正可用，出路是换载体（名字直接可见）或另给尺寸，不是抢一个角。 |

  **这是一处统一决定，不是每种记号各自就近挑角。** 四种记号的落角从同一份分配取值（`presence-mark-corner.ts`），而不是各自在自己的 CSS 规则里写死一个方位——各写各的，下一个新记号仍会就近落进被盖的右侧带，这个缺陷会原样复发。

## 验收

- Production Electron 验证真实 DOM 尺寸、DPR、Canvas backing、Tab overflow、拖拽落点与窗口 drag/no-drag。
- 单 Pane 与分屏都不得出现重复 Topbar、第二条 Session chrome 或工具栏遮挡。
- Rail 与 Tool Dock 的四种开关组合都保持固定顶部按钮、正确内容起点和可操作角标。
- Terminal、Editor 和 Browser 的内容缩放由各自 owner 管理，不建立全局缩放补偿层。
- 视觉改动通过项目统一检查和目标窗口交互验证；截图只证明渲染，不替代状态和安全测试。
- 受 Radix `Presence` 管理的节点（Dialog/Menu 的 `Content`、`SubContent`、`Overlay`）上的入场 keyframe 动画必须限定在 `[data-state='open']`。有意的退出可以限定在 `[data-state='closed']`，但必须使用与入场不同的动画名、真实定义的 keyframes 和明确的有限时长，并由真实 Native Renderer 证明完成与卸载；静态守护本身不能证明退出完成。Presence 关闭时读取计算出的 `animation-name`；无条件入场会让它等一个永不触发的 `animationend`，留下失效节点。这条由 `apps/desktop/test/presence-exit-animation.test.ts` 从 Desktop 与共享 UI 包的实际组件源码推导受管节点，集合必须非空，不维护手抄类名；同时保留入场动画的断言，不能靠删动效满足。

## 样式表的组织

一个 2551 行的 `styles.css` 不是"文件大"的问题，是**找不到东西**的问题：改 Topic 行要先 grep 出
它散在哪几段，改完不知道有没有漏。样式按**表面**分文件，与组件目录同构；同一表面的默认、状态与响应式规则由同一 owner 持有，窄布局按实际可用容器生效，不由后置无条件规则覆写。共同对话样式归 `packages/client-ui/src/styles`，组件正常呈现所需的 overlay、尺寸与可访问性规则也随组件归包；宿主提供主题 token、Portal 容器与平台能力，不补另一份共享组件必需样式。以下清单按 Desktop 入口的实际层叠顺序排列，Desktop 在原层叠位置导入，其他 Client 直接消费共享包样式：

```
styles/
  index.css       入口：@import 的顺序即层叠顺序
  tokens.css  唯一全局主题值——颜色、字号、间距、圆角、阴影、动效
  base.css  reset、html/body、滚动条、共享原子（.icon-button/.small-button/.eyebrow/.status）
  chrome.css  Titlebar、Project Rail、Tabbar、Attention Bar
  space-tree.css  Space 查找、分类、折叠与目录 pins 归属
  space-object-appearance.css  Space 共用身份图标与紧凑选择面
  selector.css  同一族列表行的共享表现层（容器 header + 行 + Agent 簇）
  dock.css  Tool Dock 这个容器本身及其 Topics / Agents 面板
  topic-topology.css  Topic 行尾的工作台拓扑：Region 缩略图、在场簇、悬停展开的 Tab/Region 检视面
  file-explorer.css  被塞进工具槽的文件浏览器：Explorer 头、搜索、文件树、文件列表
  source-control.css  Source Control 面板：Branches、Changes、History 共用导航与工作列表
  git-history.css  Git History 的固定引用选择、已读提交与拓扑图
  workbench.css  Pane、Region、分屏、拖放
  file-preview.css  共用文件预览与就地编辑
  note.css  Note 阅读、编辑与恢复
  terminal.css  终端表面与它的状态覆盖层
  surfaces.css  Settings、New Tab、Launch、Welcome
  settings-overview.css  Settings overview 的实际分区与紧凑身份行
  settings-toolkit.css  Settings 工具目录
  toolkit-custom.css  自定义工具的动作、参数与结果
  settings-keyboard-shortcuts.css  Settings 键盘快捷键
  board.css  Board：Branch/Topic × 状态矩阵、扇出条、Board 工具清单、Discussion 画布
  global-board.css  Global Agents Board 的 demand/session 列、工作区和 region
  goals.css  现有 Agent Goal 与任务约束表面
  focus.css  Focus 三段工作面：历史、状态、选中的 Session
  focus-timeline-ruler.css  Focus 时间轴与有界标尺
  pmo-teams-topic.css  Mote 快捷面、对象选择与 compact 入口
  browser.css  Browser 工具与地址栏
  browser-operation-surface.css  Browser 操作轨迹与回放表面
  browser-step-evidence.css  Browser 步骤证据详情
  browser-structured-fields.css  Browser 有限结构化字段与来源
  browser-task-assets.css  Browser 版本资产与参数编辑
  agent.css  Agent 会话外壳、状态栏与 Provider 选择
  interaction.css  权限与问题卡（packages/client-ui/src/styles）
  settings-prompts.css  Settings 用户 Prompt
  settings-materials.css  Settings 素材目录
  survey.css  结构化问答表面
  result-review.css  Result ready 的紧凑入口、结果详情与复查动作
  service-notice.css  服务提醒的轻量入口、收起、复查与有界详情
  status-prompts.css  用户 Prompt 的状态绑定与 Composer 快捷动作
  agent-region-header.css  Agent Region 身份与就地操作
  session-connecting.css  Connecting 与 Session 恢复：身份、Executor、初始 Prompt（舞台本身归 full-page-loading.css）
  composer.css  Composer——Agent 那格底部的输入条（packages/client-ui/src/styles）
  launcher.css  新 Agent 启动入口
  resume.css  已有 Session 恢复入口
  activity.css  Activity 时间线、机器步骤与标尺
  conversation-message.css  对话回合、消息动作与状态（packages/client-ui/src/styles）
  markdown.css  共同正文的 Markdown 与资源（packages/client-ui/src/styles）
  conversation-image.css  共同图片缩略图、放大预览与可访问性（packages/client-ui/src/styles）
  conversation-input-details.css  消息来源、作者与输入详情（packages/client-ui/src/styles）
  conversation-tool-trace.css  原生对话工具调用与结果（packages/client-ui/src/styles）
  conversation-native-thread.css  原生对话过程与消息顺序（packages/client-ui/src/styles）
  session-history.css  持久会话记录的内联阅读
  workflow.css  Workflow 观察画廊：组件目录、章节与流程图
  conversation-avatar.css  两条对话轴共用的说话人身份标记（packages/client-ui/src/styles）
  conversation-axis.css  共同参与者轨与原文菜单（本会话／发送者同源身份）
  overlays.css  Dialog、Context Menu、Quick Switch、Tooltip
  agent-panels.css  Agent 的 Portal 面板（花名册、计数树、资源用量）——紧跟 overlays
  performance-toolkit.css  性能观察与脚本工具
  agent-avatar.css  执行器头像的 Provider 轮廓、角标、状态、计数与设置预览
  full-page-loading.css  启动与全页 loading/recovering/failed 大屏的网格、切片、品牌层和动效
  session-recap.css  Session recap 的真实来源、阅读与就地动作
```

这张清单由 `stylesheet-organisation.test.ts` 钉住：文件名集合必须与 `index.css` 的 `@import`
列表逐一对上，拆一刀而忘了改这里当场红。描述那一列不锁——它是写给人看的判断，不是清单。

约束：

- 全局主题值的唯一 owner 与消费边界见[《主题与样式 SSOT 规范》](#主题与样式-ssot-规范)；组织守护检查真实声明的归属，不把读取现有外观的选择器判成第二份主题值。
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

## 非目标


- 不建设主题导入器、任意颜色编辑器、插件市场或通用扩展框架。
- 不为没有规模证据的虚拟列表、文件拖动或移动端布局预建状态。
- 不在正式设计合同保留来源路径、固定 commit、Copy/Adapt/Omit 表或已完成任务流水。
- **不引入 CSS-in-JS、Tailwind 或预处理器**。问题是"字面值没有名字"，不是"CSS 不够强"；
  原生 custom property 已经足以给尺度命名，换一套构建期方案只会在解决同一个问题的同时新增一层工具链。
- 应用外观支持深色、浅色和跟随系统；选择持久化，系统模式在系统外观改变时更新。全局 Surface、文字、控件和编辑器保持一致，终端调色板仍可单独选择。

- Shell 环境读取不完整时，复用服务窗的持续、中性、非模态告示；说明读取范围和恢复动作，不展示环境值、不靠 toast 自动消失。行为归属见 [Desktop interaction](../agentmux-desktop-interaction.md) 的本地 shell 环境约束。
- 登录 shell 降级时告示保持一行紧凑服务窗：说明“交互配置未确认，当前按登录/继承环境运行”，不显示 PATH、凭据或完整环境转储。非交互 fallback 成功后告示仍持续可见，直到下一次应用启动重新确认；布局、Session 和输入不被遮罩。

- 兼容但归属未确认的 Runtime 使用持续的中性服务窗说明，不使用错误弹窗，不阻挡已有工作面；归属状态不展示路径、PID 或凭据。

## 语义图标密度与性能

- semantic icon 按状态、对象、动作、导航、层级五类组织；同一语义在 Gallery、Workflow、Activity、聊天状态栏中使用同一几何和尺寸契约。
- 动态/组合图标仍是同一体系的成员：动画只表达状态变化，静态状态不启动动画；减少动画时退化为稳定 glyph；组合图标共享同一 viewBox、对齐基线和命中区。
- working 图标的持续 opacity 动效由共享图标的 HTML 载体合成，保留原字形、节奏、尺寸与减少动画退化，避免每帧整页重绘。停泊或非活跃的留存工作面暂停自身及后代关键帧，回到可见宿主后自然恢复；不卸载阅读器、不改变可测几何，不把装饰性的 `aria-hidden` 或交互 `inert` 当作渲染隐藏。
- 图标组件默认不创建额外状态、不订阅 Store、不触发布局测量；映射表和 renderer 保持模块级稳定引用，避免列表滚动时重复创建图标定义。
- 同一语义在不同 surface 可以有尺寸和动画差异，但不能与另一语义落成相同 glyph；视觉区分优先于装饰统一。
- 动画是语义的一部分：运行、完成、失败、暂停、排队等状态使用各自合适的局部动作，静态终态不启动无意义动画；所有动作都必须有 reduced-motion 静态退化。

## 成熟产品界面的控件与分组

Board 默认使用“工作面优先”的密度：去掉营销式大标题、hero 文案和底部页面切换器，首屏从任务列与当前详情开始。全局工具栏控制范围、搜索、筛选、排序和默认 Session；操作组使用紧凑的 segmented control、图标按钮和少量文字动作，不把每个动作包进彩色胶囊。

页面层级靠留白、字号、对齐和单一选中信号建立。Surface 使用中性深色层、hairline 分隔和很小的状态色面积；禁止多彩渐变、发光轮廓、连续彩色线框和无语义的装饰图标。Project 色只在身份点、短边或状态标记上出现，不能铺满整卡。

任务分组只有三种稳定语义：Task 状态列、当前 Task 详情、执行 Session Region。每一个区域都必须有可回答的问题和明确的退出/收起动作；“页面 01/02/03”“MVP 原型页面”这类演示性分组不进入产品表面。浮动入口和右侧 Inspector 是同一工作面的附着层，不能被视觉处理成三个并列产品。

Task drawer 打开时仍保留 Board 的列和上下文，宽度变化由 drawer 占用空间或覆盖边缘完成，不通过路由跳转或整页重排制造“详情页面”。Session Region 沿用当前 Agent surface 的身份、输出密度和 attachment 事实；只增加观察层，不复制终端 chrome，不画成新的产品卡片。

Default Session 浮窗直接复用原生 Topic Tab/Region：顶部是既有 tab/chrome，中间是既有 Session 内容，底部是既有 composer。不要再画一套客服式的消息卡、头像、欢迎语、独立 Task 卡和复杂确认表单；确认策略只保留一个紧凑设置入口，Task 写入状态使用一行原生通知或消息标记表达。

Topic Wiki 注入只在原生 Topic chrome 里以一个轻量状态表达，例如“Wiki · 已加载 12 条规则”或一个可检查的注入图标；不要把整份规则常驻在对话面板。用户点击后进入现有 Topic/Wiki 编辑入口，查看来源、版本、启用状态和最近修改；注入规则在 Agent 输出中只以必要的来源标记出现，避免再造一套知识库卡片。
