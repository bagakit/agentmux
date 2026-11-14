# 全局视觉、尺度与样式 Owner

本文保存本主题的视觉、密度与控件约束；行为、身份和动作资格引用交互合同，不在这里复制。原有未确认范围按正文状态阅读。

[返回视觉与密度合同](../agentmux-surface-density.md) · [同主题交互](../behavior/shared-rules.md)

**本页章节**

- [对象、消息与工作面的共同呈现](#对象消息与工作面的共同呈现)
- [保护原则](#保护原则)
- [UI 现代化的独立评估边界](#ui-现代化的独立评估边界)
- [Agent 主观审美的判断边界](#agent-主观审美的判断边界)
- [主题与样式 SSOT 规范](#主题与样式-ssot-规范)
- [字号阶梯](#字号阶梯)
- [排版角色与来源](#排版角色与来源)
- [间距刻度](#间距刻度)
- [圆角](#圆角)
- [颜色](#颜色)
- [动效](#动效)
- [控件语言](#控件语言)
- [界面文案](#界面文案)
- [身份归属](#身份归属)
- [密度预算](#密度预算)
- [工作台控件与状态的 Owner](#工作台控件与状态的-owner)
- [弹层作用域与层级](#弹层作用域与层级)
- [响应式与可访问性](#响应式与可访问性)
- [验收](#验收)
- [样式表的组织](#样式表的组织)
- [非目标](#非目标)
- [语义图标密度与性能](#语义图标密度与性能)
- [动态视觉的渲染边界](#动态视觉的渲染边界)
- [成熟产品界面的控件与分组](#成熟产品界面的控件与分组)

## 对象、消息与工作面的共同呈现

动作菜单共用键盘导航、分支焦点与可用空间约束。点击与悬停各自保持原触发方式。宿主提供原文档与浮层目标，调用者提供菜单内容与业务动作。

本节收集跨多个专题出现的对象分享、消息阅读与工作面位置的呈现约束；行为、身份与资格仍只在所链接的交互合同中定义。

Agent／Region／Tab／Category／Topic 的对象分享直接复制链接，菜单使用清楚的 Copy … Link 名称，同一对象不并列重复的名片或消息复制动作；沿既有菜单密度、图标与键盘焦点，不新增装饰或说明面。File／Browser 上下文分享保留原紧凑外框与正文阅读格式；身份、链接、命令发现及来源唯一引用[交互合同《寻址与复制》](../behavior/public-control.md#对象地址分享与方向)。普通路径、URL、选区及终端内容继续沿原复制语汇。

Provider 完整性（Session 分析、对话模式与 trace 观察）的行为与能力边界统一见 [交互合同《Provider 能力对齐与移植边界》](../behavior/agent-capabilities-and-messaging.md#provider-能力对齐与移植边界)。同类消息、资源与观察事实沿既有公共组件呈现；缺口与流程降级沿既有服务窗表达，不能逐家制造另一套控件语言。合法空或被遮蔽 reasoning 仍沿既有 trace 折叠可达，opaque 数据不铺成正文，不增加常驻控件；真实性只定义在该交互合同。

原生会话主记录与已提交旁写日志的来源、只读快照、预算、取消与变化诊断，唯一见交互合同[《Provider 能力对齐与移植边界》](../behavior/agent-capabilities-and-messaging.md#provider-能力对齐与移植边界)；读取缺口沿既有服务窗说明，保留共同消息行、已读内容与原阅读位置，不增加常驻指标或另一套历史界面。

Focus 的未知时间输入与旧窗覆盖说明沿既有紧凑输入入口和单条消息预览呈现，不能增加一条常驻工具栏或为每个空 Context 展开消息卡。按需入口可选择 Context、扫描输入和显式继续／刷新，正文、资源和链接复用共同对话消息组件；不复制一套聊天界面、不撑高约 24px 轨道。已固定的消息预览在可用宽度变化后仍须留在可见范围内，关闭和继续读取控件可操作，并保留原正文与选区。阅读预算、选区保持、未知作者／时间与来源变化只定义在[Focus 共同消息的有界阅读](../behavior/focus-context.md#共同消息的有界阅读)。 Focus 固定阅读中的复合头像、辅助归属和 Info 入口复用[《消息布局与身份密度》](conversation-mode.md#消息布局与身份密度)，轻量 hover 保持原摘录而不叠完整资料墙；共享正文与来源详情在332px中仍可读、可操作，不重复堆出第二组姓名和空字段。资料与来源的事实边界只见交互合同中的 Focus 共同正文消费约束。

Focus 消息预览的完整表面不能被活跃 Region 的焦点描边穿过；标题、正文与底部动作连续清晰，描边在预览之外保持可辨，浮层尺寸与选择、关闭语义引用交互合同对应消息预览约束。

共用 Zone→Tabs→Regions 工作面保同一内容与控件语言，外层 chrome 由当前展示位置提供；需要分辨时用紧凑可读说明表达实体来源与当前位置，不叠重复全局标题或把位置当内容归属。下钻某 Tab 或 Region 仍有准确原动作目标与可见焦点，未知呈现不假装可输入。流程未确认的说明与原可用工作面保持可辨，不把校验未确认呈现为 Agent 已失败。多位置、取消绑定与实体关闭、位置及公开导航回执的准确对应、真实呈现及恢复只定义在交互 SSOT[《Zone→Tabs→Regions 的实体与展示绑定》](../behavior/spaces-and-layout.md#zonetabsregions-的实体与展示绑定)。

原生 Browser 多位置画面的活体导航、媒体与首击输入合同引用交互 SSOT[《Zone→Tabs→Regions 的实体与展示绑定》](../behavior/spaces-and-layout.md#zonetabsregions-的实体与展示绑定)。同一控件的可见画面、当前输入位置与尚未确认的交接应能分辨；失败提示停在旁侧，不遮盖健康原页面，不将「已显示」或「已聚焦」呈现为「这一击已生效」。镜像的可见画面不冒充已经证明原生输入可操作。

对象优先 CLI、跨对象 `app snapshot`、Goal／PMO 手册归域与统一 JSON-RPC 公共业务服务的行为，唯一见交互合同[《对象优先 CLI 与统一公共业务服务》](../behavior/public-control.md#对象优先-cli-与统一公共业务服务)。沿原对象身份、观察与服务窗呈现已知／unknown，不增加第二套资料名册、常驻协议栏或说明卡；本节不把目标命令与传输写成当前已实现能力。

Agent CLI 导航桌面主画面、保留 Mote 对话输入及选择／呈现／caret 事实的边界，唯一见交互合同[《Agent 操作桌面主画面与保留对话输入》](../behavior/public-control.md#agent-操作桌面主画面与保留对话输入)。沿原导航选中、工作面与服务窗表达结果，不加第二套桌面控制栏、浮窗 header、全页确认或遮挡；正常、窄窗与恢复中的实际主面和仍可输入浮窗须一同看图。

## 保护原则

设计方向：技术架构延续原有成熟组件，视觉向 Workflow 的低干扰、分层观察语言靠拢。设计规则按「全局基础 → 观察组件 → 聊天表面」阅读；同一约束只在所属层定义，其他章节引用。产品交互和事实归属仍以 Desktop interaction 为准。

- 全局基础保留 Graphite / Mint、现有字号/间距/状态 token；克制的表面明度与文字层次取代装饰性线框和重复卡片。
- 观察组件先让用户识别对象、当前状态和需要处理的异常；数字为次级信息，详情按需展开，持续问题始终可找到。运行中、失败、未知须有非颜色提示。
- 聊天表面区分可读正文、紧凑机器步骤与需要人决定的操作；三者共享对齐、焦点和状态语言，但不压成同一种行高。权限选择和服务窗不能因美化而变弱。
- Gallery、真实对话与 Workflow 的共同组件呈现由[对话专题](conversation-mode.md#开发观察与真实消费者)持有；真实过程与正文的视觉层级见[过程层级与详情](conversation-mode.md#过程层级与详情)，来源／窗口说明见[共同阅读密度](conversation-mode.md#共同阅读密度)。原记录及长过程披露见[共同组件行为](../behavior/conversation-mode.md#可复用对话与-workflow-表面组件)，输入与过程的顺序见[共同记录顺序](../behavior/conversation-mode.md#共同过程与消息的记录顺序)。本页只持全局基础与共享组件预算。

- 保留 Graphite / Mint 与 terminal-first 的产品身份。
- 删除顶部空行、重复标题、线框拼装和低分辨率感。
- 描边不作为控件的主要视觉手段；Surface 填充、明度差、顶部高光和状态色承担层级。
- 一个身份层级只在一个主要位置可见；低频信息进入 tooltip、context menu 或 Activity。
- 视觉改动不得创建第二套 Agent、Terminal、Browser、Topic 或 Layout 生命周期。
- Agent 操作 AgentMux 的反馈来自 Control receipt、语义状态或原生工作面变化。自有 Computer Use 的行为与分层约束见交互合同[《AgentMux 自操作与 Computer Use 边界》](../behavior/public-control.md#agentmux-自操作与-computer-use-边界)；目标、执行中与失败原因在同一操作反馈位置呈现，权限问题沿用可行动的服务窗，不能混同 Agent 运行状态或增加外部工具的专属常驻状态栏。
- 打包来源身份、发布审计与运行路径校验属于安装与诊断边界：候选、canonical 安装副本和当前运行实例只通过身份报告与文件元数据对照，不在工作面常驻显示版本号、重复状态栏或第二套 Session／Run 状态，失败阶段停留在诊断面。安装失败的保留规则、候选运行依赖完整与实际启动验收见交互合同[《打包、安装与启动事实》](../behavior/session-recovery.md#打包安装与启动事实)。
- New Browser 的结果沿用交互合同中的可见成功／失败投影，不新增常驻版本或状态条：成功时由聚焦 Pane 的 Tab／Region 承担变化，失败时由该工作面已有的服务窗或错误面承担反馈，不能留下无变化的空白点击结果。

- 整体 review 延续 Graphite / Mint 与既有 Surface 层级：Prompt 验证降级的行为见交互合同[《P0 的共同交付边界》](../behavior/agent-capabilities-and-messaging.md#p0-的共同交付边界)，工作线读取的行为见[《工作线的读取与切换》](../behavior/spaces-and-layout.md#工作线的读取与切换)。Prompt 验证降级复用 Session 服务窗，持续可见、不遮挡、不抢焦点；工作线读取失败用现有行内错误语汇，不能用无限 loading 或空态代替。高密度列表的排序与分组不应反复全表扫描或复制已分组成员。

- 无独立动作的聚合头像沿用相同身份和状态色，但不显示按钮手势或交互抬升；可定位到 Session 的头像保留现有悬停与键盘焦点表现。
- Shell 环境读取不完整时，复用服务窗的持续、中性、非模态告示，说明读取范围和恢复动作，不展示环境值，也不靠 toast 自动消失；行为归属见 [Desktop interaction](../agentmux-desktop-interaction.md) 的本地 shell 环境约束。登录 shell 降级时告示保持一行紧凑服务窗，说明「交互配置未确认，当前按登录／继承环境运行」，不显示 PATH、凭据或完整环境转储；非交互 fallback 成功后告示仍持续可见，直到下一次应用启动重新确认，布局、Session 与输入不被遮罩。
- 兼容但归属未确认的 Runtime 使用持续的中性服务窗说明，不使用错误弹窗，不阻挡已有工作面；归属状态不展示路径、PID 或凭据。

## UI 现代化的独立评估边界

UI 现代化的评估以对象层级、阅读密度、字体与空间、表面层次、图标与身份，以及窄窗、失败、焦点与恢复中的可见行为为依据，保留 Graphite / Mint、terminal-first 与现有字号、间距、表面和状态 token；测试数量或单页好看不能代替完整的正常、窄窗、失败与恢复流程判断。组件化评估只见[交互合同《组件化的独立评估边界》](../behavior/shared-rules.md#组件化的独立评估边界)。

现代化改动在正常、窄格、失败与恢复中使用同一对象层级和控件语言；服务窗持续说明失败步骤、当前能力与恢复路径，完整详情随时可达，同时保留可用的终端阅读和输入空间。当前对象的身份与状态在各层有明确且不同的用途；窄窗的摘要、工具和长字段不靠缩小正文字号或隐藏必要事实解决；深浅主题、键盘返回与减少动画偏好沿现设计系统保持一致。行为、组件贡献与 owner 边界只见上述交互合同，单次截图或评分不代替完整路径验收。

整体视觉风格是「精致、现代、简约、紧凑」：精致体现为一致的字体层级、对齐、间距、边界和状态细节；现代与简约服从对象辨识和真实反馈；紧凑优先保留终端阅读与输入面积，同时让动作可发现、文字可读。紧凑不要求每个表面同一密度，等待舞台以舒展留白和清楚主次承载当前状态与原动作，具体构图归[《启动与恢复的分量分开》](session-recovery.md#启动与恢复的分量分开)。沿 Graphite / Mint 的既有 palette 与 token 收敛，不以堆叠卡片、装饰阴影、渐变或缩小正文字号代替信息组织。

选中导航符号可沿自身结构做一次短促的展开、对焦或翻页，完成后停在清楚的静态轮廓；只由该实例当前选中事实触发，不因无关状态刷新重播，不将选择表现成持续运行或业务确认。未选中实例与其业务反馈独立，主题自定义图形保持完整；减少动态效果时直接静止，命中区和邻接排布全程稳定。

角色插画、概念场景，以及 Space、Focus、Survey、Recall 等产品对象符号的共同美术语言归[品牌架构《共同美术语言》](brand-identity.md#共同美术语言)。

## Agent 主观审美的判断边界

所有界面改动的通用视觉交付约束唯一见交互合同[《Agent 主观审美的端到端验证》](../behavior/shared-rules.md#agent-主观审美的端到端验证)，本节只定义判断边界。

独立 Agent 基于已经看见的真实产品截图，结合当前任务和本合同判断层级、紧凑程度、对齐、留白，以及信息与控件是否清楚；结论须说明画面中的具体位置、为何影响阅读或操作，以及怎样修正。同一截图可有主观分歧，保留理由与未确认事项，不把评分或单个数字伪装成审美真相。

具体像素阈值、截图差异分数或 CSS 字符串只能辅助核对明确的工程事实，不能自动判定精致、现代、简约或紧凑，也不能为了某一个画面的距离发明专用门槛。真实操作、采集身份、独立看图、每批执行证据、fixture 与需求一致性及失败保全只见交互 SSOT[《Agent 主观审美的端到端验证》](../behavior/shared-rules.md#agent-主观审美的端到端验证)；本节不另设场景清单或第二套设计规则。独立评审到明确满意为止的修正、复拍与交付边界同样只归该交互章节，不以本节的几何或评分替代。

## 主题与样式 SSOT 规范

主题系统采用“声明式主题目录 + 单一运行时语义投影 + 原生适配”的结构：

- 跨客户端主题 schema、内置目录和解析归 `packages/client-ui` 的独立纯主题入口。目录中的稳定主题身份与明度选择分开：每套主题完整定义 dark / light，原 `APP_APPEARANCE_IDS` 的 dark / light / system 决定使用哪一版本。Graphite / Mint、辐射 4 和复古未来均覆盖实际共享语义角色；Light 按长期阅读优化层级、文字、分隔、阴影、状态、选中、hover、focus 和编辑器，不能机械反转暗色。
- Main 原 ConfigOwner 持有选择及自定义主题的唯一持久事实。自定义主题保存完整定义，不建继承图；内置原版不可覆盖或删除，编辑内置须另存副本。损坏的自定义记录逐项保留、隔离并具名说明，不导致原外观、Terminal 配色或其他用户数据整体重置。
- `data-theme` 与 `data-appearance="dark|light"` 及根元素的语义 custom properties 是浏览器运行时投影。一个根控制器解析选择、系统偏好和临时预览，同步更新投影并释放订阅；不并行维护组件级主题真值，不按页面判断主题，不因主题切换重建工作面或编辑器。`palette.css` 只持派生公式与初始默认投影，主题可写字段由声明式 schema 持有。Desktop 的 `tokens.css` 继续持有宿主密度与几何，Mobile 的字号与触控尺度由[手机呈现](mobile-client.md#尺度与-token)持有，不复制主题目录。
- 组件消费 surface、text、line、action、success、warning、danger、focus 等语义角色；主题不能改变动作资格、状态含义、未知反馈或可访问名称。组件局部几何仍由所属 surface 持有；主题可编辑参数只覆盖实际支持的颜色、受控字体/材质、圆角及图标表现，不执行任意 CSS、脚本或外部资源。
- Terminal 的显式原生调色板独立保存，不因 App 主题切换被覆盖；用户可明确选择 Workspace theme，按本窗口已解析主题与明度派生 ANSI 语义色，不另存终端颜色副本。Mobile System 使用手机自己的根明度投影，Host 只传配对标记；Core 仍只承载 opaque client 数据。Monaco 从同一已解析主题适配明度、编辑背景、文字、选择、差异和语法层级；原生适配不产生第二套可编辑主题事实。更新现有 Terminal 配色须就地应用，保 buffer、阅读位置、选择和 Attachment。
- 全项目受控图标按动作、对象与状态建立共享语义目录，组件与原生/DOM适配消费稳定语义，主题选择图形。默认映射、允许的覆盖和有界自定义资产由同一 schema 约束；未指定项用目录默认映射，不改变点击范围和布局。Desktop、Mobile、共享控件、菜单工具栏、文件与状态、内置工具及原编辑器适配均须有可检查的真实消费者覆盖；不能只建立 registry 而旧页面仍直连库图标。品牌与 Provider 标志保身份含义，不能借主题冒充另一身份；外部网页和用户文件正文不属于产品图标目录，用户已保存头像/空间身份装饰仍沿原对象 owner。
- 原生控件仍持有值、键盘、焦点、禁用/只读状态和命中范围；主题只投影浏览器开放的绘图槽位。日期与日期时间入口使用日历语义，时间入口使用时钟语义，与选择、勾选和折叠控件共用根图形 owner。宿主未开放同一槽位时保留其原生行为；选择器内部日历/时间面板及系统 Save/Open 窗口的内部图形归宿主，产品自己的入口图形仍须可主题化。
- 三套主题的辨识来自完整色彩、表面材质、字体层级和图标语言。辐射 4 的工业磷光语言与复古未来的模拟科技语言须明显不同；装饰服从终端、正文、ANSI 和危险/警告/成功/未知的可读性。减少动画偏好继续生效。
- 新增 token 必须有实际消费者、明确语义和从声明来源反推的契约检查。共享控件、菜单/弹层、浮窗与 Gallery 消费同一投影，不闪回旧主题；utility 层只能映射既有 token。Core 不依赖 UI 框架或主题包，Provider 不持有主题分支。

主题编辑、预览、文件往返、冲突与保存反馈归[设置行为](../behavior/settings-and-observation.md#外观app-图标与主题文件)，设置呈现归[设置呈现](settings-and-observation.md#主题编辑器)。真实产品操作、生产变异、独立技术 review 与完整原图审美分别证明各自结论，构建和概念图不能代签。

Terminal 的经典配色复用原生调色板目录与原设置 owner，以原作者的完整 ANSI 定义为来源。Dracula、Nord、Gruvbox Dark、Solarized Dark 和 Solarized Light 分别明确命名，保持原 Graphite / Catppuccin 选择；显式配色不随 App 明暗或主题变化改写。Workspace theme 是用户明确选择的配对项。静态预览、Desktop 与 Mobile 原生 Terminal、Main 的默认前景/背景及公开设置发现/写入消费同一目录，不另建经典配色存储、字体设置或执行插件。配色切换在现有实例内生效，保 buffer、阅读位置、选区、输入与原 Attachment；原 ANSI、警告/危险输出仍须辨认。

字号、间距与颜色三类尺度都通过具名 token 使用，样式表不写裸字面值；token 之外确有必要的值按选择器具名列为例外。下面三节分别定义刻度与例外边界；具名例外清单与核对方法见测试策略[《界面规则与真实行为》](../../testing/strategy.md#界面规则与真实行为)。

## 字号阶梯

以下六档是 Desktop App chrome 与常规内容的默认尺度。每一档有明确职责，选档看这段文字承担的职责，不看它想显得多大。手机按触屏阅读任务定义自己的[字号与几何](mobile-client.md#尺度与-token)，不直接套用本表的 Desktop 值；共享主题、角色语义与可访问性要求仍有效。

| Token | 值 | 职责 |
| --- | --- | --- |
| `--fs-micro` | 10px | 微标、角标、计数、时间戳。密度下限，不得更小 |
| `--fs-meta` | 11px | 元信息、caption、次级说明、工具栏文字 |
| `--fs-body` | 12px | 列表行标题、按钮、输入框、菜单项——界面默认字号 |
| `--fs-prose` | 13px | 可读正文：Agent 回合、对话、长文本 |
| `--fs-title` | 14px | 卡片与对话框标题、区块 header |
| `--fs-display` | 20px | 页面级标题（Board、New Tab、Welcome） |

专属阅读工作面先按实际阅读任务核对这些默认角色。Mote 的搭档交流目标归[同主题呈现](motes-and-coordination.md#mote-快捷入口与当前协调上下文)；若默认工具密度不能满足长时间阅读，在 owning 呈现合同说明职责，并沿本页 token owner、真实消费者及命名语义定义阅读角色，不以六档数量拒绝必要的阅读尺度，也不在局部 CSS 另写主题值。方向稿中的字号只表达候选，未经对应实现与实拍验收不成为已交付 token；原工具栏、菜单及微标默认尺度继续适用。

Settings 中的当前分区标题属于工具工作面的区块 header，使用既有 `--fs-title`；其导航、搜索、对象列表与表单密度沿[Settings 控制工作面](settings-and-observation.md#settings-控制工作面)，不另设字号 token 或把每个分区放大成页面宣传标题。

等宽内容不另设字号档：它按所在位置取对应档位，与 `--font-mono` 配对即可。Terminal 字号仍由原 owner 原生渲染；Editor 的继承与显式 override 只见行为合同[《Explorer 与 Editor》](../behavior/files-and-git.md#explorer-与-editor)，实际字形与行距由 Monaco 原生渲染，不另设一份 App 默认值。

约束：

- 页面级标题只有一档 `--fs-display`。Board、New Tab、Welcome 与 Discussion 回答的是同一个问题「这一屏叫什么」，不各用一个字号；层级差异靠留白与位置表达。
- Desktop App chrome 不使用半像素字号（如 10.5px、11.5px）：DPR 切换时渲染不稳定，在两档之间犹豫说明应改选档位，而不是再加一档。手机字号由[手机呈现](mobile-client.md#尺度与-token)单独持有。
- 字号不低于 10px（`--fs-micro`）。状态点的问号、叹号形状由语义图标 mask 绘制（`--native-presence-*-mask`，投影见 `packages/client-ui/src/theme/icon-sprite.ts`），不是文字，不受字号阶梯约束。
- 多级标题字号相同，层级靠字重、颜色与留白区分；共同正文 Markdown 的标题规则见[《正文与 Markdown》](conversation-mode.md#正文与-markdown)。

### 排版角色与来源

选择字号时一并核对字体、字重、行高和文字层级；字号相同不代表可以把控件、元信息与长正文互换。下表给出原 Owner 的查找路径，不另设通用字重／行高表，不把局部值扩大成全局刻度。

| 使用对象 | 字号职责 | 字重、行高与文字层级的来源 |
| --- | --- | --- |
| 微标、计数与元信息 | `--fs-micro`／`--fs-meta` | 所属表面的计数、时间与辅助说明样式；不能用微标档承载逐句阅读的正文 |
| 列表、菜单与普通字段 | `--fs-body` 默认职责 | 原行或字段样式；原生输入继承与焦点见[输入模块](../../../packages/client-ui/src/input/input.css)，菜单行见[菜单样式](../../../apps/desktop/src/renderer/src/styles/context-menu.css) |
| 动作文字 | 沿[字号阶梯](#字号阶梯)的按钮职责核对 | [Button](../../../packages/client-ui/src/components/Button.tsx)／[IconButton](../../../packages/client-ui/src/components/IconButton.tsx)与[共享按钮样式](../../../packages/client-ui/src/styles/buttons.css)，宿主只适配原密度；不要从原生 button 标签推断字号或自行补一套档位 |
| 回合正文与长文本 | `--fs-prose` 默认职责 | [正文与 Markdown](conversation-mode.md#正文与-markdown)及原阅读组件；标题、代码、表格与长内容沿该专题，不套菜单行高 |
| 区块、弹层与页面标题 | `--fs-title`／`--fs-display` | 原 header 或页面样式及本页[密度预算](#密度预算)；不因标题更重要就增加字号档位 |
| Terminal、Editor 与手机 | 各自原尺度 | [原渲染 Owner](#字号阶梯)与[手机尺度](mobile-client.md#尺度与-token)，保显式设置、DPR、触控与输入法差异 |

当前实现与规则须分别阅读：[共享按钮样式](../../../packages/client-ui/src/styles/buttons.css)的文字按钮默认使用 `--fs-meta`，与[字号阶梯](#字号阶梯)规定的按钮默认职责存在差异。本页提供来源，不将该现状改判为新规范，也不宣称已完成对齐；调整仍须沿原控件与真实消费者验收。主题字体与颜色从[共享投影](../../../packages/client-ui/src/theme/css-variables.ts)读取，Desktop 字号刻度从[宿主 tokens](../../../apps/desktop/src/renderer/src/styles/tokens.css)读取，不在表格再维护一份行高或字重数值真相。

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

约束：奇数像素间距不进入刻度。同一层级的两个元素间距相差 1–2px，在单个控件上无感，在整屏上会表现为节奏抖动。

刻度只到 24／32px；更大的值是布局几何而不是节奏，例如为 macOS 交通灯让出的 80px、输入框右侧图标占用的 28px、`clamp()` 在大屏上的上界。这类值按选择器与属性具名放行，不把数值加入全局白名单，否则放行一个 30px 后全表都能写 30px；具名了布局几何的选择器，其常规间距仍走刻度。刻度外的小值同样必须具名，例如 hairline 的 1px 与 Activity spine 的 104px 对齐点。

## 圆角

圆角只使用 `--radius-sm`、`--radius`、`--radius-lg` 三档，只有两类例外：紧凑交互控件（24px 图标按钮、Tree/File Row、Tab 与 Region 的关闭键、Tab Group 动作等）在 6px 下显得过圆，取 4–5px；微标与装饰件（状态点、hairline 轨道、ruler tick、图标裁角、选中标记等）取 1–3px。面性容器（卡片、菜单、弹窗、输入框、工具坞）一律走 token，不因“看起来更合适”而硬编码。验证方法见[界面规则与真实行为](../../testing/strategy.md#界面规则与真实行为)。

## 颜色

颜色分为以下四组，均从基础 token 派生，不另设全局色值。

| 组 | Token | 说明 |
| --- | --- | --- |
| 基础 | `--bg`、`--surface-0..3`、`--line`、`--line-soft`、`--text`、`--text-2`、`--text-3` | Surface 与文字阶梯 |
| 中性中间层 | `--neutral-1..3` | `--text-3` 与 `--line` 之间：禁用文字、次级图标、滚动条、终端选区 |
| 状态家族 | `--{red,green,amber}-{text,bg,line,wash}` | 每个语义色的「浅文字 / 深底 / 中边框 / 极淡叠加」 |
| 叠加 | `--scrim-1..3`、`--wash-1..3`、`--overlay-surface`、`--overlay-line` | 黑色遮罩、白色高光、浮层玻璃 |

约束：

- 状态家族由 `color-mix()` 从基色派生，不写死为 hex；这样调整 `--red` 才会同步调整整套危险语汇，各层级不会各自漂移。
- 样式表不写裸 hex。亮度只差 1–2% 的近似色应收敛为同一 Surface token；唯一例外是 `color-mix()` 中作为配料的纯白与纯黑，例如 `color-mix(… var(--green) 88%, #ffffff)` 表达「把这个 token 提亮」。
- 引用不存在的 token 是缺陷：CSS 会静默丢弃该声明而不报错，所以须由检查发现（核对方法见[《界面规则与真实行为》](../../testing/strategy.md#界面规则与真实行为)）。
- 定义了却无人引用的 token 删除，不为「以后可能用得上」保留。
- Agent 状态到颜色的对照只定义一次：状态语汇段为每个 `.status--<state>`（working、running、waiting、blocked、error、exited、done、disconnected）赋一次 `--status-ink`，状态点用它填充。Topic 头像保留 Provider 身份色，运行状态只由共享状态角标表达，不给头像加常驻边框；新表面不再列一遍状态到颜色的映射（核对方法见[《界面规则与真实行为》](../../testing/strategy.md#界面规则与真实行为)）。

## 动效

有限的状态变化应表达同一个对象的连续性：按下、选中、披露与已决各有清楚职责，容器几何、正文可读与图形反馈可以分开编排，而非统一淡入。主动作、次动作与辅助动作以同一主题内的字重、填充和轻轮廓区分；低阴影只解释表面，不给每个对象套强光晕。保原控件、语义图标和 token，不因参考库新增另一套动画引擎或状态。初次挂载、无关刷新、隐藏返回不无故重播；不为动效延迟真实已确认事实或改变命中尺寸。

动效的时长与曲线同为 token，不在各表面手写毫秒数；按动作的性质选档，不按想显得多快选。

| Token | 用途 |
| --- | --- |
| `--dur-fast` | 微交互：hover、图标着色、按钮态 |
| `--dur-enter` | 浮层入场：菜单、tooltip、卡片 |
| `--dur-exit` | 浮层淡出：比入场慢，让自动隐藏的控件退场不显突兀（快进慢出） |
| `--dur-indicator` | 瞬时指示：一次输入的反馈气泡出现到消失的总时长 |
| `--dur-breath` | 长时呼吸：状态点脉动、恢复态光标 |
| `--dur-sweep` | 长时扫掠：恢复态扫描线 |
| `--ease-enter` | 入场减速曲线（浮层从指针处生长的那条） |

约束：

- 一个 App 只有一条通用 spinner：语义图标 `status.loading` 以 `animation="spin"` 呈现，只转图形声明的 spin 部件，由语义图标动画 owner 持有唯一的旋转关键帧。它属于按钮内、行首、面板 header 这类 11–16px 的行内尺度，别处不另写整图旋转，也不携带品牌。
- 应用启动与 Region 等待使用不同构图。品牌主体限应用启动面；Region 恢复与停泊采用开放阅读构图，保真实阶段、活动信号和原动作。材质、布局与动态唯一见[《启动与恢复的分量分开》](session-recovery.md#启动与恢复的分量分开)，不能把品牌大屏缩小到终端格。
- 动效不得是唯一的信息载体。减少动态时，静态画面、阶段文案和动作仍须准确表达忙碌、停泊或失败，不能只留下看不出状态的静图；这条对所有新动效成立。

## 控件语言

控件档位与原生交互语义跨客户端共用；本节的落地类名约束属于 Desktop 样式 owner。手机复用共同组件，在手机样式边界使用[手机档位与类名](mobile-client.md#控件语言)，不改写 Desktop 默认或另造动作资格。

共享组件系统以可独立开源、供其他宿主采用为目标。基础控件定义一次输入、滚动或选择怎样响应。交互模式定义人完成一项 Agent 工作时需要哪些事实、能做什么、怎样辨认结果。两者以可观察的行为为公共约定，允许桌面与手机选择适合各自的密度、手势和容器。模式的说明与验收用例要足以让其他团队在自己的宿主独立实现。宿主引用公共组件与模式，向它们提供数据和动作。宿主的对象、权限、执行事实和集成说明由各业务专题持有。包的[独立入口](../../../packages/client-ui/README.md)与[维护规范](../../../packages/client-ui/CONTRIBUTING.md)说明怎样贡献，首例[Agent 与工作的位置](../../../packages/client-ui/docs/patterns/agent-work-location.md)给出跨宿主可检验的结果。

应用内同类单选字段共用紧凑触发器、可滚动选项层与单一选中标记，沿 Listbox 语义提供键盘导航、类型检索、Escape 与返回焦点，复用原窗口弹层宿主。控件不自行加载数据或执行领域动作；原对象标识、未知选项、保存草稿和资格由原调用者持有。长选项保全文可读，窄窗内弹层不越界，不让系统菜单与应用菜单在同一功能组混用。执行器选择复用同一领域组件，以目录或紧凑字段呈现原 Host 侧头像、名称、Provider 和可用状态；未知不冒充不可用，保存的失效身份仍可读，不各自复制发现逻辑。

面板标签指向原面板，行内单选表达字段值，开关表达原生二值输入。各自沿原键盘操作和焦点顺序。标签与选中标记的位移跟随最新选择，窄处把当前项留在控件可视范围内，初次呈现与减少动态直接定位。保存或发送等动作的反馈区域须容纳多行，错误可读，状态更新不挪动相邻动作的命中位置。

身份 Tooltip 在键盘可见焦点时直接可读，鼠标沿有意悬停展开；按下取消尚未展开的悬停提示，不因鼠标聚焦在按下与释放之间插入新浮层。已展开的阅读面保留滚读，不能抢走原按钮的点击、长按或拖动；提示的出现与关闭不改变原动作资格或输入。

| 层级 | 视觉语言 | 用途 |
| --- | --- | --- |
| Primary | 实心品牌绿渐变、深色文字、顶部高光 | 页面唯一主操作 |
| Secondary | 干净 Surface 填充、软高光、无常驻描边 | 次级操作与行内确认；Desktop 落地类名只有 `.small-button`，见下方按钮类名约束 |
| Ghost / Icon | 透明底，hover 才提升 Surface | 图标按钮与工具栏动作 |
| Selected | 单一几何信号；实心图标格或底部横条 | Project、Segment 与 Tab 选中态；Tab 选中态使用轻微背景和底部 2px 横条，不使用顶部高光或整圈描边 |
| Danger | 实心红色变体、深色文字、顶部高光 | 删除、移除等破坏性主操作 |

### 控件逐态职责

以下按同一控件的状态查找既有要求；状态可以共存，不能用一种状态替代另一种。业务资格与准确对象仍由原 Owner 给出，呈现不授予输入、权限、完成或恢复事实。

| 状态 | 呈现与使用职责 |
| --- | --- |
| 正常 | 使用上表档位、所属表面的字号与几何；原动作名称、目标和命中区保持可辨 |
| Hover／按下 | 沿原档位的 Surface、颜色与内阴影反馈；命中区和对齐不因反馈位移，不能把 hover 当作选中或已执行 |
| 选中／已勾选 | 显示原调用者确认的选择，沿单一几何信号；单选、复选、Tab 与动作按钮保留各自原生语义，不因共用样式变成同一种控件 |
| 键盘焦点 | 可见焦点与选中分开；文字输入、复合输入及图标动作使用各自既有焦点边界，菜单与模态弹层沿[原作用域](#弹层作用域与层级)管理焦点返回 |
| 禁用 | 只消费原调用者的禁用事实；不显示可执行的 hover／按下反馈。未知、观察失败和忙碌本身不能被呈现组件擅自改成禁用 |
| 忙碌／等待 | 由原在途事实表达，具名文案与既有 spinner 保动作可辨；`aria-busy` 不替代 `disabled`，是否阻止重复动作由原业务决定，不由动画决定 |
| 错误／未确认 | 沿原字段、保存区或服务窗显示准确范围；字段没有无效事实时不标 `aria-invalid`。保原值、草稿、已确认进度及恢复入口，不用颜色、toast 消失或忙态冒充错误已解除 |
| 只读 | 原值可读、可选择与复制的内容继续可达；只读与禁用、权限不足分别表达，不用外观推断可编辑资格 |

逐态核对从原实现开始：[按钮](../../../packages/client-ui/src/styles/buttons.css)、[输入](../../../packages/client-ui/src/input/input.css)、[原生选择控件](../../../packages/client-ui/src/styles/native-controls.css)、[菜单](../../../apps/desktop/src/renderer/src/styles/context-menu.css)与[共享 Modal](../../../packages/client-ui/src/components/Modal.tsx)。`Button`／`IconButton` 不自动推导忙碌或操作资格，[FormRow](../../../packages/client-ui/src/components/FormRow.tsx)关联原控件、标签、说明和字段反馈，控件的值、校验、保存和恢复留在原调用者。

补充规则：

- 最高信噪比：让用户需要的信息清楚可辨，减少重复文字、无意义装饰和额外阅读负担。能用图标表达清楚就不用文字、能用一行表达清楚就不用多行，都是具体应用，取舍以理解效率为准。图标保留 tooltip、可访问名称和键盘焦点，必要正文、错误原因与恢复动作保持可读。
- 品牌强调色只表达焦点、状态或页面唯一主操作（色彩角色归[品牌架构《色彩角色》](brand-identity.md#色彩角色)），说明性卡片不挂装饰性彩色图标格。
- 同一语义在不同容器中使用同一控件层级。高频按钮与图标按钮共用原生控件入口和唯一样式 owner，统一正常、选中、忙碌、禁用与键盘焦点；动作资格、草稿及保存／重试仍由原调用者决定，忙碌反馈不自行撤销可用能力。局部视图切换共用材质、对齐与选中语言，同时保留原 tabs、按钮组或配置字段的语义与键盘规则。
- hover 提升 Surface 明度；active 用内阴影表达按下，不靠边框位移。
- 同类布尔设置行共用原生控件、标签和说明的关联与排列；整行点击沿原生 label，键盘与当前 checked、disabled 仍由原 input 和调用者持有，不自写第二套切换状态。说明可通过辅助技术读取，整体保存错误继续留在原保存区，没有字段无效事实时不把整次失败标成某个字段无效。
- 文本输入聚焦统一使用 `--focus-line` 与 `--focus-ring`，形成一条清楚、克制的焦点边界，与原控件边缘对齐；内嵌提问、改名、创建和配置字段不叠粗亮外圈、内边与光晕。复合输入由整个输入容器表达焦点，内部文本框不再画第二圈；独立输入的键盘焦点仍须可辨。深浅主题和强制颜色下保留焦点、错误及禁用的区别，不改变原草稿、IME、保存与取消语义。基础单行、多行与组合输入使用共享 client-ui 输入模块；模块持有原生控件和呈现，入口持有草稿与业务动作。富文本消息编辑复用既有共享 Composer，保持与原生字段分层。
- 紧凑多行编辑面共用正文大小、内距和单层焦点。正文随内容增高，达到所属编辑面的上限后在字段内滚读。底栏在正文之后，次要资料与当前可用动作各有对齐，主动作居右，窄面需要换行时仍可按原顺序到达。调用者提供原提示、动作和宿主可用高度。
- Mote 等内嵌提问入口使用轻而可辨的组合输入：淡底色、单层完整边界，文字保留横向留白；单行约 38px、左留白 12px，不以零 padding 或仅底部细线表达可编辑区域。聚焦时完整边界与底色清楚响应，行动按钮位置固定且有轻底座，内容就绪后使用柔和 Mint 色；长问题自然增高并有界阅读。普通改名和搜索保留紧凑尺度。准备讨论的原业务语义不变，快捷键须尊重组字，在途与失败沿真实读取状态表达并保留问题；行内忙态复用共同 spinner。
- 每档动作按钮在 Desktop 只有一个落地类名：Primary＝`.primary-button`、Secondary＝`.small-button`、Ghost/Icon＝`.icon-button`、Danger＝`.danger-button`。不按档位名另造类名（如 `.secondary-button`）：全局 `button` 重置只覆盖字体与颜色、不覆盖背景，没有规则的类名会让按钮落回平台原生样式。扫描方法与事故样本见[《界面规则与真实行为》](../../testing/strategy.md#界面规则与真实行为)。
- `justify-content: space-between` 只用于子元素数量固定且已知的容器：它把剩余空间分摊到子元素之间，两簇时各靠一端，三个以上松散子元素会被推向两极、中间留空；组件测试不计算布局，这类错误不会让测试变红（验证方法见[《界面规则与真实行为》](../../testing/strategy.md#界面规则与真实行为)）。「首元素靠左、其余靠右」的工具栏与页脚改用 `justify-content: flex-end` 加首元素 `margin-right: auto`，子元素数量变化时仍成立。
- 选中态不用左侧竖条。贴在行左缘的亮色竖线既不是填充也不是描边，在密集列表里会连成噪音；选中由单一几何信号表达：干净的 Surface 填充，必要时配实心图标格。这条对所有列表行成立（Project Rail、Topic、Tree、Segment、Settings 分区）：`box-shadow: inset <n>px 0 …` 与 `border-left`／`border-inline-start` 在屏幕上是同一根线，都不得用于表达选中；容器分隔线与内容引用条不属于选中表达。扫描方法见[《界面规则与真实行为》](../../testing/strategy.md#界面规则与真实行为)。
- 一列全同的行首图标不提供区分，只占用标题宽度。若列表每行的行首图标都相同（重复的 Topic 类型图标、纯文件列表的文件图标），去掉它；行首位置留给有区分度的对象身份、状态或 Provider 身份，或者留白。Space 的共用对象身份槽遵守[《Project Rail 与 Topic 行密度》](spaces-and-layout.md#project-rail-与-topic-行密度)。

Mailbox 原生输入的来源更新与有界阅读告示引用交互文档[《用户消息从 Provider 原生会话取得》](../behavior/conversation-mode.md#用户消息从-provider-原生会话取得)；沿原有就地边界与服务窗语言，不新增常驻工具栏、另一套状态或消息表面。

### Mote 默认身份与装饰徽标

Mote 默认身份表达持久、机灵而克制的搭档，使用原创填充 SVG，以有注意力方向的不对称轮廓和清楚负空间建立辨识；12–24px、单色和深浅背景均保持完整，不能靠放大、颜色或动态才看懂。造型有稳定的记忆点，不直接采用普通字母 m、通用机器人方脸或制式 AI 星芒；无渐变、阴影、滤镜和装饰性碎部。类型入口、主 Mote 与普通 Mote 的自动默认外观消费同一语义标记及主题资产，跟随当前文字颜色，不再由主身份的独立默认 PNG 绕开主题覆盖。类型标记、历史作者与导出保持静止；自动默认在可见对象头像槽内可有局部交互动作，不能受宿主通用 SVG 姿态选择器整体驱动。默认交互、用户选择头像的已有姿态与真实状态表达统一归[原 Mote 呈现 owner](motes-and-coordination.md#mote-头像与主-mote)。

自动默认剪影在对象身份槽中使用当前主题的次级文字色，与界面整体协调；手选图形及已保存图片、捏脸和系列保持各自原色，不因默认配色调整而染色。自动默认只适用于原外观 owner 确认没有显式选择的 Mote；恢复自动后使用同一默认身份。用户已保存的图标、捏脸、图片与系列选择优先，保持原内容、原色、比例与部件，不能因主身份、资源读取失败或默认升级而被改写。对象手动外观继续沿[共用身份规则](spaces-and-layout.md#project-rail-与-topic-行密度)及[头像行为合同](../behavior/motes-and-coordination.md#mote-头像与主-mote)选择和保存。功能入口、对象身份与执行状态分别表达；新轮廓不授予运行、权限或操作资格。

Executor 头像的装饰徽标使用独立语义项与适合 6／8px 的简单静态轮廓，不借用 Mote 身份图形。已有 `spark` 等徽标数据与选择含义保留，徽标和 Mote 主题资产可分别覆盖；微小徽标不加入星芒碎部、运行态或循环。项目自己的通用 AI 星芒（Lucide Sparkles / WandSparkles）退场：新建工作面、技能与跳过权限提示各用准确语义。Provider 官方品牌资产保留，不作为制式 AI 图标替换。产品身份边界见[《Space、Folder 与 Topic》](../behavior/spaces-and-layout.md#spacefolder-与-topic)。

## 界面文案

普通界面先说用户正在处理的对象、动作和结果，技术详情保准确来源。以下原则跨客户端共用；手机的中文词表与普通／技术信息分层仍见[手机文案](mobile-client.md#文案)，Settings 的英文口径仍见[原设置呈现](settings-and-observation.md#分区层级与通用反馈)，不因整理统一成一种语言。

- 动作名称在所在上下文中说明做什么、作用于谁；破坏性确认保对象与后果，避免用孤立的“确定／OK”遮蔽实际动作。返回、关闭、取消等成熟通用动作沿原语义，不为补对象堆重复标题。
- 错误说明哪个操作或步骤未完成；原因、恢复建议与重试必须有实际依据。结果可能部分完成或未知时保原操作与已确认进度，不能默认“请重试”诱导重复写入、发送或停止；持续反馈沿[原服务窗](../behavior/session-recovery.md#我们的流程坏了不等于-agent-坏了)。
- 进行中与结果文案描述真实动作和对象，不用动画、宣传语或笼统“成功”替代实际结果；未知如实说明未确认范围，不写成失败、停止或正常。没有结果事实时不提前使用完成语气。
- 空态区分确实为空、尚未读取和读取失败；首个可用动作清楚可达，原因未知时不编造操作建议。正常状态不堆无信息增量的说明。
- 精简保留对象、作用范围、生效条件与不可逆后果；可访问名称、tooltip、菜单、搜索和对应设置使用一致概念，完整诊断与准确身份仍沿原详情可读。文案变化不改变操作权限、状态或恢复判定。

## 身份归属

| 位置 | 主要身份 | 不应重复的内容 |
| --- | --- | --- |
| Project Rail Row | 选择了哪个 Project、在跑几个 Agent、要不要你 | 完整路径、worktree 数与 Session 详情 |
| Topbar Breadcrumb | 当前主区 Workspace 与 Branch | 完整绝对路径 |
| Tool Dock Header | 文件树根与可见路径 | 第二个同义图标或重复 Breadcrumb |
| Session Tab | Session 名称、Provider、状态 | 第二条 Session Info Bar |
| Tooltip / Context Menu | Session ID、Host、开始/活动时间 | 常驻占用内容高度 |
| Activity View | 最近消息和结构化事件 | Terminal 上方的重复摘要 |

macOS Dock 的系统徽标只显示当前待用户处理数，零时不显示；使用平台原生样式，不增加窗口内第二个同义控件。事实与更新行为归交互合同[《跨会话注意力与系统通知》](../behavior/settings-and-observation.md#跨会话注意力与系统通知)。

消息与 Agent 地址的具体可读性约束见交互合同[《A2A 消息要让人一眼看懂》](../behavior/a2a-collaboration.md#a2a-消息要让人一眼看懂)；本层只要求工作面优先显示紧凑地址，不常驻铺开机器回执或完整 ID。

## 密度预算

工具与配置表面先让用户辨认当前对象、状态和下一步，信息查找与修改配置各有清楚的具名路径。一个页面容纳不下的独立任务以具名 tab 分区，不靠缩小字号、堆长说明或把全部内容塞进多层折叠。首层保持简洁，详细证据与低频配置按所属分区查看；切换 tab 保留准确对象、原草稿、已提交操作及可辨焦点，不以切换取消已接纳业务。

需要用户处理或核对的 tab 使用有语义的角标，事实来自原 owner；未知或读取失败可具名“待核对”，不能冒充已确认故障。普通进度、可自行恢复的等待和用户主动关闭／暂停不一概告警。角标只说明该分区确有待处理事实，不用当前有界页的数量冒充全历史失败总数；正常时不添零计数或装饰。具体来源与动作仍由所属专题定义，不为角标新增状态 Store 或观察循环。

| 对象 | 预算 | 说明 |
| --- | --- | --- |
| Titlebar Plane / root Tabbar | 36px | 与窗口顶边和相邻 header 对齐 |
| Pane Tabbar | 31px | 分屏 leaf 的紧凑索引高度 |
| Project Rail Footer / Corner Badge | 32px / 28px | Footer 只容纳两个 24px 图标入口 |
| Project Rail Section Label | `--fs-micro`；轻字重；紧凑上下留白；尾部常驻 `+` | Motes、Topics、Folders 是分组标签，不是重复页面标题；项目名称保持主要阅读层级，分区创建的含义归交互合同 |
| Project Rail Group Header | 随行密度为 20–24px；`--fs-micro`；字重 560；紧凑字距；折叠与类型共用一槽 | 共同父目录名只显示最后一段，完整路径进 tooltip；只领一个成员时不渲染。分类标签轻于对象标题，折叠只为真实子项提供，不在叶节点预留箭头槽。hover 只提亮文字，不借用对象行的 Surface；折叠后保留可读组名和紧凑地址，完整成员及状态仍可获知。 |
| Project Rail Group Collapse | 折叠态持久化；折叠后组头补地址、成员数与注意力角标 | 分组从磁盘路径派生，不是可重命名、删除或配置的实体，组头唯一的动作是折叠，不为它另建注册表。折叠后成员行隐藏，组头须自己说明身份：地址保留尾部三段（如 `team/projects/example`），因为同一台机器上路径的前几段大多相同，不能用 CSS `text-overflow` 截掉有区分度的末尾；同时显示成员数。展开时地址与角标都不渲染，由成员行各自表达。折叠必须把成员的注意力汇总到组头（复用项目行的 rollup 与配色），否则有 Agent 等待处理的折叠组会看起来与空闲组相同。折叠状态的 key 包含 hostId，两台机器上同名的 `…/kit` 不是同一分组。 |
| Project Rail Row | 28–32px 单行；标题从统一左缘起；尾部独立运行状态槽 | 选中只用中性 Surface；运行中的 Agent 在相关项目行显示独立活动控件；行首图区分项目、仓库和目录。一行只占一行：标题与状态同处一行，不为常驻元信息另起次行。尾部计数是正在运行的 Agent 数，回答「这个项目现在有没有 Agent 在工作」；worktree 数属于仓库结构，降级进 tooltip。计数为零时不显示数字（一列全是同值的徽章不携带信息，理由同控件语言的行首图标规则）。Host 只在不是本机时占位，`This Mac` 对每行都相同。 |
| Project Rail Nesting Indent | 分类成员一级 12px；真实父子每层 12px、最多 3 层；三档密度均保持可辨 | Motes、Topics、Folders 的成员身份图形相对分类身份图形增加 12px 阅读缩进，成员标题相对分类标题至少增加 12px；同级对象身份槽与标题共用基准。不把分类当作实体目录；路径聚合组与真实后代另按每层 12px 增加层级。只保留一份必要外缘，不叠加容器留白、空箭头槽或空图标槽；Pinned child 遵守同一层级差，无连接线。 |
| Project Rail Pinned Child | 唯一见[《Project Rail 与 Topic 行密度》](spaces-and-layout.md#project-rail-与-topic-行密度) | 层级差遵守上一行 Project Rail Nesting Indent；本表不另定义 pinned child 的字号与 hover。 |
| Tree Row | 24px | 保持键盘扫描和专家密度 |
| Tool Dock Width | 默认 300px；最小 236px；最大 440px | 同时容纳 Explorer / Branches，保留主工作面容量 |
| Tool Content Padding | 8–12px | 仅用于局部卡片，不包住整栏 |
| Context Menu | 176px 最小宽；26px Row；8px 横向 Padding；4px（`--sp-2`）容器 Padding | 全部 Context Menu 共用一套基座。Surface 填充 + 阴影 + 顶部高光建立层级，不使用描边；hover 提升明度并把图标转为品牌绿；破坏性项 hover 保持红色语义，不被绿色 hover 覆盖。菜单从指针处生长（120ms），表明它是这次点击召唤出来的，而非盖在界面上的一层浮层 |
| Activity Log Row | 平铺机器行与记录型过程的槽位、缩进及宽窄变体唯一见[共同过程组件密度](conversation-mode.md#可复用对话与-workflow-组件密度)。 | 仅机器事件走此寄存器；user／assistant 正文消费共同消息，不在通用预算表另造一套过程布局。 |
| Scratch Topic Row | 标题 11px、摘要 10px 次行；presence 18px 成簇锚定行右缘并垂直居中；结构摘要使用 `--fs-micro` | 一行回答 Topic 身份和工作面结构。Agent 用 Provider 图标成簇表达身份与状态；同一可复用 presence 组件同时给出 Tab 数量与 Region 结构。hover 显示 Tab 顺序/标题、分屏布局、每个 Region 的 Executor 和最近活动摘要；没有摘要明确显示 `No recent activity`。键盘 focus 时显示同一结构摘要，不能把 hover 当作唯一信息来源。不重复呈现同一事实：不再另挂无法定位的总 Agent 数；结构详情只在一处出现，定位动作仍走全局 `selectSession`。行首不用重复的 Topic 类型图标；对象的共用手动身份遵守[《Project Rail 与 Topic 行密度》](spaces-and-layout.md#project-rail-与-topic-行密度)。选中态使用 Surface 填充，不用左侧竖条。 |
| Activity Turn Row | 正文与机器寄存器分开，阅读高度随内容；身份、时间与原操作紧凑 | user_message／assistant_message 使用[共同消息呈现](conversation-mode.md#消息布局与身份密度)，作者停靠、气泡与头像不在预算表再定义。完整正文、原生 assistant 与 A2A 作者边界保持；过程步骤仍沿机器行／Workflow 的原展开规则。 |
| Activity Turn Prose | 正文、标题、列表、引用、表格与代码的尺度唯一见[《正文与 Markdown》](conversation-mode.md#正文与-markdown)与[《长内容、代码与局部查找》](conversation-mode.md#长内容代码与局部查找) | 只在 turn register 渲染 Markdown；机器行保持纯文本，不进解析器。Agent 输出解析为语法树后映射为 React 元素；raw HTML 只按[有限白名单](../behavior/files-and-git.md#markdown-的-html-子集与提示块)投影为数据节点，其余按字面文本呈现，不成为可执行标签。代码着色与公式是例外：两者由受控渲染器在可终止的 worker 中生成 HTML 后插入，输入与输出都有字节与元素上限，公式渲染不信任命令（KaTeX `trust: false`、`strict: 'error'`），超限或失败时显示原文。链接渲染为按钮，经宿主注入的打开入口处理，不输出 `<a href>`。宽表与长代码在自身容器内横向滚动，不撑宽回合或整个 feed。 |
| Activity 历史读取入口 | 当前与较早记录沿同一共同阅读面；消息、过程、来源与等待的层级唯一见[共同阅读密度](conversation-mode.md#共同阅读密度)，不在通用控件表另定义辅助聊天或浮动加载变体。 | 原较早／回到最新／Return／恢复动作、来源、读取与选区保护沿行为专题[《History 使用共同对话阅读面》](../behavior/conversation-mode.md#history-使用共同对话阅读面)；局部反馈不授予业务状态或制造另一读取 owner。 |
| Activity Ruler | 顶部sticky；一行紧凑起止／已加载记录数与范围入口；一排24px参与者轨＋14px状态标尺 | 默认24h，可选6h／12h／24h／3d／7d／全部时间；初始和扩大范围沿共同阅读合同异步补读，缩小仅收窄概览。真实已载成员决定起止，记录不足时收紧轴，不铺空白时段；耗时与偏移进入悬停／键盘说明，无跨度序数退化。身份、密度、状态与可见区共用唯一坐标与原目标。低对比较早记录和较亮最近已记录一小时，最多48桶微高度表达记录密度；连续实线表示已记录工作、轻虚线表示已记录空闲，等待回应独立色，缺事实中性未知。可见范围以14px轨内清楚的轻填充边框标出，置于状态装饰之上、事件刻度之下；正文遮挡按实际sticky高度，折叠过程标题代理原记录，展开后按真实步骤观察。可见区观察不进滚动热路径。详细事实边界只见交互专题的顶部参与者轨约束。 |
| Activity 时间读数 | 统一时刻／时长格式、数字密度和紧凑过程的时间披露唯一见[时刻与时长读数](conversation-mode.md#时刻与时长读数)。 | 源记录时刻、记录范围及未知的事实边界只见[Activity 记录时间](../behavior/conversation-mode.md#activity-记录时间的直接阅读)，观察跨度不升级为执行耗时或完成事实。 |
| Activity 对话轴 | 一排24px高；头像16px，单标记命中24px，参与者簇命中64px | 沿共同消息头像；簇露出最多三个唯一参与者＋余数，完整记录原菜单可达并明确This agent／Sender。完整命中框容纳头像及余数，端点可内侧避让，真实刻度不移位。稀疏原话预览、键盘／Escape共享协议；按实际宽度聚合，不改来源或时间事实。 |
| Tool Dock Header（Explorer／Branches 等） | 不高于 root Tabbar 的 36px；24px 图标按钮 | 各工具坞标题共享同一左缘，不形成第二层大 Topbar；分屏时上下堆叠的标题必须对齐。 |
| 跨会话注意力入口 | 沿[Focus 与底部状态入口](settings-and-observation.md#全局通知与底部状态入口)的原紧凑预算 | Working／Needs you／Error 聚合值、请求处理及结果查看只见[Focus 行为 owner](../behavior/focus-context.md#focus-执行上下文项目泳道与底部时间音轨)。不在此另立全宽 Attention Bar、第二 roster 或另一份状态事实 |
| Agent Provider Catalog | 有界最大高度、独立纵向滚动；紧凑密度更矮 | 容器独立滚动，不扩大 Launcher：有界高度与独立 `overflow` 是容器自身的约束，不依赖卡片数量少，Agent 装得再多也不把下方的 prompt 推出屏幕。具体高度由 `.agent-catalog` 规则持有。 |
| Settings Pane | 两层容器：可操作／主内容卡＝`--surface-1` + `--elev-2` + `--hl` + `--radius-lg`（抬起）；信息／次级块＝与页面同底的平铺 `--surface-0` + 一条 `--line-soft` 发丝线，无阴影、不成盒。卡片／区块标题走 `--fs-title`（14px），说明降到 `--fs-meta`／`--text-3` 读作从属；区块头句首大写 `--text-2`，不叠第三层大写字距 | 合成器、只读说明、执行器分组与工作区列表不压成同一平面，「抬起」与「平铺」的对比承担主次。说明区块的强调色沿[《控件语言》](#控件语言)的通用规则。侧栏选中＝干净 Surface 填充（`--surface-2` + `--hl`，与 Project Rail active 同语汇），绿落在该项图标或 `aria-current` 上，不画整圈描边；侧栏本身是 `--surface-1`，选中态再填 `--surface-1` 会让 hover 比选中更实。每节导航前缀图标各不相同，予以保留。入场用 `--dur-enter`／`--ease-enter` 的淡入上浮，不做长时遮罩揭幕或光标跟随。 |
| 操作与元数据文字 | 11–13px；微标不低于 10px | 不用 7–9px 冒充密度 |
| Terminal / Editor | 字号、行距沿[原渲染 owner](#字号阶梯) | 由 xterm／Monaco 原生 DPR 渲染，不用 CSS transform；不在 App 密度表另设默认值 |
| Terminal replay recovery | 有界批次；批次间让出事件循环；连续 live bytes 合并成视觉批次；输入/切换控件不被输出队列饿死；切回时按视口记忆停在上次位置或最新输出 | 大量 scrollback 恢复时优先保持界面可操作，避免一次性 parser 工作造成假死、逐字绘制或把回放过程暴露成从顶部滚落 |
| Terminal link span | 裸 URL 下划线只覆盖 ASCII URL 本身；相邻 CJK 文字/标点保持普通终端字形 | 链接边界只见[《Terminal 链接 hover 范围与单元格》](../behavior/terminal-reading.md#terminal-链接-hover-范围与单元格)；不因相邻中文输出改变 URL 的目标或悬停范围 |
| Terminal link readout | 延迟出现的边角被动读出；目标为主层、真实类型 / 来源和打开方式为紧凑次层；长目标保留可辨部分，宽度不超过 Region | 读出须清晰：提高真实目标与动作说明的可扫读层级，用平面、轻边界与共享可读刻度，不加图标按钮、快捷键胶囊或重复路径。事实、清除、避字与打开边界唯一见交互 SSOT[《Terminal 链接读出与目的地面的信息归属》](../behavior/terminal-reading.md#terminal-链接读出与目的地面的信息归属)及[《Terminal 链接 hover 范围与单元格》](../behavior/terminal-reading.md#terminal-链接-hover-范围与单元格) |
| Terminal restart projection | 保留原 durable Tab／Region；Runtime 未确认时就地显示中性等待／不可用事实及原动作，旧 Run 明确丢失时表达真实状态 | Run／PTY 缺失不授权删除持久工作面；移除、明确关闭与恢复资格只见[《工作面持久恢复与启动边界》](../behavior/session-recovery.md#工作面持久恢复与启动边界)。未知不冒充可输入、终局或新 Session |
| Confirmed Agent crash notice | 沿用现有服务窗与唯一错误提示；由同一分类派生 ARIA 音量 | 行为边界归交互合同[《我们的流程坏了，不等于 Agent 坏了》](../behavior/session-recovery.md#我们的流程坏了不等于-agent-坏了)。不另造弹窗、严重度颜色表或覆盖工作面的遮罩 |
| Managed Hook notice | 服务窗/状态行；不覆盖 Terminal 内容、不抢焦点 | Hook 路径失效属于流程降级，Agent 仍可用；说明如何让当前 App 重新校正配置 |
| Provider capability notice | 服务窗/状态行；与 Managed Hook notice 共用告示槽 | Provider 的 Hook、resume 或探测能力缺失/降级时只在对应 Agent 旁说明，不覆盖工作面、不抢焦点；unsupported 与暂时 unavailable 必须分开，不画一个看似可点击但必然失败的 Resume 按钮 |

- Topic presence 的静息密度：Region mosaic 的 Agent 头像只在真实 Region 单元格内出现，背景 Agent 头像与它们不重复；结束态不渲染，未知/断开仍可见并保持中性状态。焦点 Region 沿用共享 1px token，Tab/Region 结构详情通过 hover 与键盘 focus 进入，不增加常驻大卡或第二层状态条。

## 工作台控件与状态的 Owner

| 控件 / 状态 | Owner | 下游行为 |
| --- | --- | --- |
| `projectRailOpen` | Renderer Store | 只展开或收起 Project Rail |
| `toolsOpen` | Renderer Store | 收起或恢复同一个 Workspace Tool Dock |
| `workspaceTool` | Renderer Store | 在 `surface-tool-dock.ts` 的 `WORKSPACE_TOOL_IDS` 中三选一：`files-branches`、`agents`、`git` |
| `toolDockWidth` | Renderer Store | 拖拽中更新 owner DOM，结束时写回唯一状态 |
| Explorer / Topics（`files-branches`） | Workspace Tool Panel | 枚举真实文件系统并打开到 Focused View |
| Agents（`agents`） | Workspace Tool Panel | 投影现有 Agent Session，不创建第二 Registry |
| Git（`git`） | Workspace Tool Panel | 消费原 Git owner 的事实；Scratch 与 Mote 范围不显示该工具 |
| Agent Launch | Universal New Tab / Topic Launcher | 通过 Core 创建 Session，不属于 Tools 状态 |
| Goals 清单／看板 | Goals Surface | 消费同一 Goal／Demand 投影；不另立 Branch × 状态矩阵 |
| Titlebar drag | Titlebar Plane | Breadcrumb 可拖拽；按钮、Tab、输入区全部 no-drag |

## 弹层作用域与层级

共享 client UI 持有语义层级与模态呈现基座；Desktop 和 Mobile 只适配各自窗口根、几何与输入设备，不复制 token 或另写一套数值顺序。层级类别表达同一作用域内的窗口 chrome、tooltip、popover、服务提示与模态；不能把类别的全局数字当作跨父子、跨 document 或跨原生合成层的完整排序。

窗口模态在当前 document 的窗口根按真实打开顺序排列。每个模态建立独立层叠作用域：遮罩在内容后方，所属菜单／tooltip 等附件在内容前方，附件的 Portal 位于滚动内容之外。后开的窗口模态覆盖先前模态的全部附件；非模态 popover 保持原来的轻量语义。共享组件默认取得这份归属，不要求业务组件自行抬高 z-index、猜祖先或申请 Browser 隐藏租约。

模态内容采用主题的实色 Surface，保留细微中性高光、柔和阴影与原字号、密度和圆角；同一 authored 材质在有无原生 Browser 时一致，不临时把透明像素换成伪造背景。遮罩只表达一次背景让位，原生适配补足的区域与 Main 确认的原生页面对应。正常、窄矮、缩放、全屏与独立窗口均保持完整可读内容、命中和有界滚动；失败恢复面沿既有紧凑服务语汇呈现。行为、失败保全与窗口形态责任唯一见[《浮层让位与输入层级》](../behavior/browser-workface.md#浮层让位与输入层级)。

## 响应式与可访问性

长选择字段的查询在具名对话框顶部使用紧凑、稳定的输入；当前选择标志、键盘高亮、完整名称与说明各自清楚。结果和空匹配在同一有界滚动面内，清除与原入口在短矮窄窗、明暗和触屏下可达，不另叠选择窗口或为少量选项增加常驻搜索。行为见[原选择字段约束](../behavior/shared-rules.md#共享控件的选择与键盘行为)。

Note 与截图标注工具栏的组内键盘焦点使用原 focus-visible 语汇，当前工具／格式状态与焦点位置分开表达；方向移动不触发选中或执行。窄窗换行和不可用动作仍沿原密度，Tab 可离开，不因减少停点隐藏可操作项。

原生切换按钮通过稳定名称和 `aria-pressed` 表达同一个动作。开启时保留可见的标记，即使指针移开、焦点移到同组其他动作或系统减少动态效果。瞬时按压和键盘焦点用各自的深度与轮廓。以切换目的地命名的导航动作沿原入口语义。

原位保存动作使用稳定的名称和触控区。可用宽度、缩放与动作集合相同的情况下，等待、完成和失败均保持各动作的位置和尺寸。状态反馈独立可读，长原因可换行并完整查看。空间不足时按可用宽度重排。减少动态时保留静态状态，动作资格仍沿原保存与恢复合同。

字段保留可见名称，说明与当前错误通过原生关联读给正在编辑的人。格式错误只标识需要更正的字段，保存失败保留原原因与原值。字段名称和帮助在窄面自然换行，仍和所属输入放在一起。

- Tool Dock 变为覆盖层时仍消费同一宽度和开合 truth，不复制移动端状态。
- 每个图标按钮必须有 tooltip、`aria-label` 和可见键盘 focus。正常、禁用与忙碌状态由同一公共控件表达；禁用时不响应 hover 或按下效果，不用可点击指针暗示仍能执行。业务动作是否可用仍由原 owner 决定。
- Tab 名称始终单行；过长省略，空间不足时由 Pane 内横向 overflow 解决。
- Surface 明度和状态色必须保持足够对比；不可只靠颜色区分选中、危险或不可用。
- 共享状态点（`.status--{state} .status__dot`，StatusDot 与 Focus 注意力汇总同源复用）中，"需要你"（`waiting`/`blocked`）必须带形状而非仅靠颜色：琥珀状态点使用问号形状的语义图标 mask，使其在色盲与快速一瞥下仍与其他琥珀含义可辨。`disconnected` 是掉线而非请求关注，从琥珀让出、改用中性空心环，令琥珀唯一地表示"需要你"。5px 角标（Tab 角、Rail 行）容不下也无需形状：颜色加角落位置已足够区分，形状只在全尺寸状态点上出现。
- Agent 字母牌是叠压头像簇里同一 Provider 多个 Agent 的判别器，可见判别归[《状态标记与 Executor 叠加密度》](agent-capabilities-and-messaging.md#状态标记与-executor-叠加密度)。它与项目字母牌共用字形与几何语汇：`--fs-micro`（10px，即刻度最小值，不需要豁免）、`font-weight: 640`、`line-height: 1`、`overflow: hidden`（emoji 比字母宽，会撑破格子）；色相沿既有派生，并在规则里声明默认值，不藏进 `var()` 兜底。不为 Agent 新挑尺寸或配色，头像格也不为字母放大：`.project-rail-row__icon[data-monogram]` 已在 16px 格内绘制 10px 字母。Space 自动对象身份的低彩度约束只见[《Project Rail 与 Topic 行密度》](spaces-and-layout.md#project-rail-与-topic-行密度)，不改变 Agent 头像的既有派生色相。
  - 同一格子放第二个记号时采用角标溢出而非扩容：注意力 `?`／`!` 为 8px 见方并探出格外，不以牺牲品牌图标为代价。两个记号不能同时占同一角，落角由下条的统一分配决定。

- 叠压头像簇的角位统一分配：可见的两个角留给必须始终可见的两种记号，其余记号让位。

  几何前提：头像 18px，相邻槽 `.selector-presence__slot + .selector-presence__slot` 以 `margin-left: calc(-1 * var(--sp-3))` 叠压 6px，z-index 随 DOM 顺序从左到右递增，右侧头像盖住左侧头像右侧的 6px；悬停或键盘聚焦的头像临时置顶。因此对非簇尾头像，只有左上、左下两个角始终可见。

  | 记号 | 落角 | 理由 |
  |---|---|---|
  | 注意力 `?`／`!`（`.agent-avatar__status`） | 左上 | 表达「这个 Agent 在等你／出错了」；看不见时用户不知道该响应，代价最大。 |
  | Provider 归并计数（`.agent-avatar__count`） | 左下 | 回答「这一枚代表几个 Agent」；看不见会数错数量。 |
  | 用户自定义徽标（`.agent-avatar__badge`） | 右上（让位） | 用户选择的静态装饰，不表达变化中的事实；被邻座盖住只损失装饰。 |
  | 显示名字母牌 | 右下 | 字母牌只在簇内有多枚时才需要判别，而那正是它被盖住的场景，所以不能靠角标位交付；右下只是登记占位，字母牌要真正可用须换载体（名字直接可见）或另给尺寸。 |

  四种记号的落角从同一份分配取值（`packages/client-ui/src/lib/presence-mark-corner.ts` 的 `PRESENCE_MARK_CORNERS`），不在各自 CSS 规则里写死方位，否则下一个新记号仍会就近落进被盖住的右侧带。

## 验收

- Production Electron 验证真实 DOM 尺寸、DPR、Canvas backing、Tab overflow、拖拽落点与窗口 drag/no-drag。
- 单 Pane 与分屏都不得出现重复 Topbar、第二条 Session chrome 或工具栏遮挡。
- Rail 与 Tool Dock 的四种开关组合都保持固定顶部按钮、正确内容起点和可操作角标。
- Terminal、Editor 和 Browser 的内容缩放由各自 owner 管理，不建立全局缩放补偿层。
- 视觉改动通过项目统一检查和目标窗口交互验证；截图只证明渲染，不替代状态和安全测试。
- 受 Radix `Presence` 管理的节点（Dialog/Menu 的 `Content`、`SubContent`、`Overlay`）上的入场 keyframe 动画必须限定在 `[data-state='open']`：Presence 关闭时读取计算出的 `animation-name`，无条件的入场动画会让它等待一个永不触发的 `animationend`，留下失效节点。有意的退出动画可以限定在 `[data-state='closed']`，但必须使用与入场不同的动画名、真实定义的 keyframes 和明确的有限时长，退出的完成与卸载须在真实 Native Renderer 上证明，不能靠删除入场动效满足检查（方法见[《界面规则与真实行为》](../../testing/strategy.md#界面规则与真实行为)）。

## 样式表的组织

样式按表面分文件，与组件目录同构，改一个表面时能在一处找到它的全部规则；同一表面的默认、状态与响应式规则由同一 owner 持有，窄布局按实际可用容器生效，不由后置无条件规则覆写。共同对话样式归 `packages/client-ui/src/styles`，组件正常呈现所需的 overlay、尺寸与可访问性规则也随组件归包；宿主提供主题 token、Portal 容器与平台能力，不补另一份共享组件必需样式。以下清单按 Desktop 入口的实际层叠顺序排列，Desktop 在原层叠位置导入，其他 Client 直接消费共享包样式：

```
styles/
  index.css       入口：@import 的顺序即层叠顺序
  workbench-windows.css  独立窗口宿主与内容顶边共用的窗口控件样式
  tokens.css  导入共享颜色、焦点与表面阴影；持有 Desktop 字号、间距、圆角、动效与宿主几何
  theme-transition.css  切换主题时所有表面同步变色，首帧后恢复控件过渡（packages/client-ui/src/styles）
  semantic-icons.css  语义图标的组合盒、动效与运行态画法（packages/client-ui/src/styles）
  base.css  reset、html/body、滚动条、共享原子（.icon-button/.small-button/.eyebrow/.status）
  buttons.css  原生动作按钮：small / primary / danger / icon（packages/client-ui/src/styles）
  surface-state.css  空态、加载与失败的单栏阅读面和滚动容器
  input.css  共用输入框与输入组的低特异度默认样式（packages/client-ui/src/input）
  context-menu.css  工作台与独立图片窗口共用的右键菜单面
  chrome.css  Titlebar、Project Rail、Tabbar 与窗口 chrome
  selection-field.css  共用选择字段：当前值、展开态与 Listbox
  space-tree.css  Space 查找、分类、折叠与目录 pins 归属
  project-groups.css  Project Rail 的项目分组、关联与分组对话框
  space-object-appearance.css  Space 共用身份图标与紧凑选择面
  mote-avatar-series.css  Mote 头像系列目录、3D/图片调整与示例创建向导
  selector.css  同一族列表行的共享表现层（容器 header + 行 + Agent 簇）
  dock.css  Tool Dock 这个容器本身及其 Topics / Agents 面板
  space-content-presentation.css  Tool Dock 内容槽展开后填满原有外壳，不移动保留的工作面
  topic-topology.css  Topic 行尾的工作台拓扑：Region 缩略图、在场簇、悬停展开的 Tab/Region 检视面
  workbench-topology.css  共用 Tab/Region 身份缩略图与只读检视面
  topic-knowledge.css  Space Topic 树的分类标题、Topic 知识与导航面板
  topic-promotion.css  Topic 升格对话框：前后对照、进度与回执
  file-explorer.css  被塞进工具槽的文件浏览器：Explorer 头、搜索、文件树、文件列表
  surface-mode-switch.css  共用模式切换按钮组与滑动选中块
  source-control.css  Source Control 面板：Branches、Changes、History 共用导航与工作列表
  workspace-git.css  工具槽与 Zone 面板里的 Git 工具布局
  workspace-zones.css  Workspace Zone 面板：范围、列表、详情与提示
  git-history.css  Git History 的固定引用选择、已读提交与拓扑图
  workbench.css  Pane、Region、分屏、拖放
    workbench-tabs.css  同一入口先读的 Pane 顶栏、Tab 身份与动作
  file-preview.css  共用文件预览与就地编辑
  media-player.css  File Region 的音视频与直播播放器
  file-data-preview.css  JSON 等结构化数据文件的树状预览
  pdf-content.css  PDF 预览的页面容器与工具
  note.css  Note 阅读、编辑与恢复
  note-links.css  Note 双向链接面板：来源、范围与块引用
  note-shared-details.css  Note 共享块就近详情浮层：使用处与返回阅读位置
  note-canvas.css  Note 画布：工具栏、卡片、端点与连线
  terminal.css  终端表面与它的状态覆盖层
  toolkit-tui.css  工具结果里的 TUI 终端：状态、提示与尺寸调整
  surfaces.css  Settings、New Tab、Launch、Welcome
  settings-search.css  Settings 搜索结果与返回
  settings-groups.css  Settings 分组标题的语义图标
  settings-theme.css  Settings 主题选择、主题库与主题编辑器
  settings-overview.css  Settings overview 的实际分区与紧凑身份行
  settings-toolkit.css  Settings 工具目录
  toolkit-custom.css  自定义工具的动作、参数与结果
  mobile-connection.css  手机连接浮层：连接码与连接步骤
  phone-connection-visuals.css  手机连接视觉：设置设备页、手机连接浮窗与其工具设置共用的二维码卡片、网络选择与在线设备
  toolkit-agent-cards.css  工具结果里的 Agent 卡片：原 Agent 头像与有界身份信息
  settings-keyboard-shortcuts.css  Settings 键盘快捷键
  settings-workview-layout.css  Settings 的 Space、Goals 与 Focus 偏好：密度、视图示例与布局
  settings-continuity.css  Settings 连续推进与自动化默认值：范围、数值、预览与展开项
  settings-recall.css  Settings Notes 阅读尺寸、宽度预览与存储目录
  settings-survey.css  Settings Browser 起始页的字段与预览
  browser-agent-control-settings.css  Settings Browser Agent 控制：编辑区与预览
  remote-management.css  Settings Hosts 工作台：图与列表两种投影、详情分页与拓扑
  remote-execution-settings.css  Settings 远程执行：准备、绑定、端点与身份
  settings-workflows.css  Settings 工作流偏好：阅读尺寸、宽度、Goals 视图与 Notes 目录
  settings-focus.css  Settings Focus 偏好：Map 预览、窗口范围与示例
  session-region-host.css  SessionRegionHost 的共享工作面布局
  global-board.css  Global Agents Board 的 demand/session 列、工作区和 region
  goals.css  现有 Agent Goal 与任务约束表面
  goal-continuation.css  Goal 监督向导与连续推进控件（Goal 详情与 Mote 当前工作共用）
  goal-delegation.css  Goal 委派工作：报告与动作（Goal 详情与 Mote 当前工作共用）
  goal-plan.css  Goal 计划图：依赖分列、节点卡片、评审证据与进度
  goal-finite-start.css  一次性任务入口：接收者选择与发起动作
  goal-responsibility.css  Goal 责任摘要与巡视（列表、详情与 Mote 共用）
  focus-workspace-stage.css  Focus 卡片派生动作的就地层，覆盖 Focus 工作区一侧
  collaboration.css  Focus 协作图：画布、筛选、关系与检视面
  focus.css  Focus 三段工作面：历史、状态、选中的 Session
    focus-context.css  同一入口先读的查找、上下文卡片与位置选择
  agent-operation-feedback.css  Agent 卡片及 Region 的异步操作短状态、局部动效与原操作详情
  agent-input-recap.css  Focus 卡片里的原输入回看与图片缩略
  agent-bookmarks.css  Agent 信息阅读窗里的书签、更新提示与问题
  focus-timeline-ruler.css  Focus 时间轴与有界标尺
  pmo-teams-topic.css  Mote 快捷面、对象选择与 compact 入口
  mote-cooperation.css  Mote 团队协作的紧凑阅读面与返回
  mote-primary-agent.css  Mote 主 Agent：返回入口、输入回执与浮动动作
  mote-quick-mode.css  Mote 快速模式：保持开启、空闲时长与自动维护
  mote-calendar.css  Mote 日历与日程：模式切换、排期与创建
  mote-private-chat.css  Mote 私聊：参与者、请求、活动与历史
  mote-connection-identity.css  Mote 连接身份：Bot 设置、确认与历史
  mote-origin-story.css  Mote 来源故事：选择与路径
  settings-mote.css  Settings Mote 目录视图与头像尺寸
  mote-workface.css  Mote 工作面外壳：Space 框架、详情、导航与资料
    mote-workface-frame.css  同一入口先读的 Space 框架、详情与资料
  mote-directory.css  Mote 目录：列表、归档、当前项与身份动效
  mote-idea-controls.css  Mote 每日想法的动作按钮
  browser-recovery-surface.css  Browser 恢复与证书问题页
  browser.css  Browser 工具与地址栏
  browser-resources.css  Browser 资源概览、筛选与批量回收（Settings 与性能工具共用）
  capsule-interaction.css  Capsule 工具条、外壳与问题交互
  browser-contextual-composer.css  Browser 就地输入浮层：轨迹、历史、选区与图片标注
  browser-operation-surface.css  Browser 操作轨迹与回放表面
  browser-step-evidence.css  Browser 步骤证据详情
  browser-structured-fields.css  Browser 有限结构化字段与来源
  browser-task-assets.css  Browser 版本资产与参数编辑
  agent.css  Agent 会话外壳、状态栏与 Provider 选择
  settings-resource-library.css  Settings 资源库：列表、搜索、选中草稿与编辑区
  settings-capsule.css  Settings Capsule 字段
  channel-settings.css  Settings 平台连接：Bot 库、环境与 Host 托管
  channel-metadata.css  Settings Channel 资料元数据：类型与工具条
  connector-identity-cards.css  Settings 连接器的 Mote 身份卡片与详情
  settings-lark.css  Settings Lark 连接：凭据来源、诊断与下一步
  settings-discord.css  Settings Discord 连接设置
  settings-connections.css  Settings 连接：设备管理、Host 升级与信任、连接器注册与配置
  interaction.css  权限与问题卡（packages/client-ui/src/styles）
  inline-rename-field.css  就地改名输入框（packages/client-ui/src/styles）
  settings-prompts.css  Settings 用户 Prompt
  liquid-selection.css  共用滑动选中块的位置与动效
  settings-materials.css  Settings 素材目录
  settings-actions.css  Settings 尺度下的共用动作按钮角色
  recall.css  Recall 笔记本选择、目录工具与折叠图
  survey.css  结构化问答表面
  result-review.css  Result ready 的紧凑入口、结果详情与复查动作
  service-notice.css  服务提醒的轻量入口、收起、复查与有界详情
  mote-context-status.css  Mote 上下文状态与服务提示
  status-prompts.css  用户 Prompt 的状态绑定与 Composer 快捷动作
  agent-region-header.css  Agent Region 身份与就地操作
  region-current-demand.css  Region header 里的当前需求入口与菜单
  agent-current-fork.css  当前会话分叉：复核、首条消息预览与取消
  connector-entity-identity.css  连接器实体身份字段与复制
  connector-sharing.css  连接器共享图：回复模式与边界
  connector-group-details.css  连接器群组详情：头部、状态与群元数据
  connector-group-status.css  连接器群组状态浮层：卡片、收发统计、成员与恢复
  connector-traffic-summary.css  连接器收发摘要：方向、计数与投递详情
  connector-connection-overview.css  连接器连接概览：接收状态与主动作
  agent-connector.css  Agent 连接器对话框：身份、房间、成员、投递详情与绑定恢复
  session-connecting.css  Connecting 与 Session 恢复：身份、Executor、初始 Prompt（舞台本身归 full-page-loading.css）
  composer.css  Composer——Agent 那格底部的输入条（packages/client-ui/src/styles）
    composer-editor.css  同一入口先读的编辑器、工具与输入模式
  input-history.css  输入历史：搜索、记录与来源（packages/client-ui/src/styles）
  message-delivery-failure.css  消息投递失败提示与投递记录（packages/client-ui/src/styles）
  original-input-waiting.css  原输入等待：回执与重试动作
  mailbox-collaboration.css  Mailbox 协作记录的有界阅读面
  automation.css  连续推进与自动化：概览、编辑、间隔与目标
  launcher.css  新 Agent 启动入口
  session-takeover.css  Session 接管层与恢复选择
  session-learning.css  Session 学习：来源与状态
  resume.css  已有 Session 恢复入口
  launcher-resume-actions.css  启动器里恢复入口的动作与复制
  activity.css  Activity 时间线、机器步骤与标尺
  agent-session-action-surface.css  Agent 会话记录阅读浮层：标题与正文
  conversation-message.css  对话回合、消息动作与状态（packages/client-ui/src/styles）
    conversation-turn.css  同一入口先读的回合结构、文本与消息动作
  conversation-tool-diff.css  工具编辑的增删行 diff（packages/client-ui/src/styles）
  conversation-message-disclosure.css  对话消息的展开与收起（packages/client-ui/src/styles）
  reading-find.css  阅读区查找与浮动触发（packages/client-ui/src/styles）
  conversation-resource-text.css  对话里的文本资源读取与控件（packages/client-ui/src/styles）
  conversation-resource-file.css  对话里的文件资源卡片（packages/client-ui/src/styles）
  conversation-reactions.css  对话消息的表情回应（packages/client-ui/src/styles）
  markdown.css  共同正文的 Markdown 与资源（packages/client-ui/src/styles）
  conversation-image.css  共同图片缩略图、放大预览与可访问性（packages/client-ui/src/styles）
  diagram-image.css  对话里的图表预览（packages/client-ui/src/styles）
  conversation-capsule.css  对话里的 Capsule 卡片（packages/client-ui/src/styles）
  conversation-input-details.css  消息来源、作者与输入详情（packages/client-ui/src/styles）
  conversation-tool-trace.css  原生对话工具调用与结果（packages/client-ui/src/styles）
  content-copy.css  共用复制按钮（packages/client-ui/src/styles）
  conversation-tool-payload.css  工具调用载荷的格式切换与动作（packages/client-ui/src/styles）
  conversation-trace-feedback.css  工具详情展开与复制结果的反馈动效（packages/client-ui/src/styles）
  conversation-process-collapse.css  对话过程的折叠按钮（packages/client-ui/src/styles）
  conversation-native-thread.css  原生对话过程与消息顺序（packages/client-ui/src/styles）
  conversation-metrics.css  对话回合的用量与耗时（packages/client-ui/src/styles）
  conversation-turn-failure.css  对话回合失败提示（packages/client-ui/src/styles）
  workflow.css  Workflow 观察画廊：组件目录、章节与流程图
  workflow-status.css  Workflow 状态图标的共用颜色（packages/client-ui/src/styles）
  conversation-avatar.css  两条对话轴共用的说话人身份标记（packages/client-ui/src/styles）
  conversation-axis.css  共同参与者轨与原文菜单（本会话／发送者同源身份）
  overlays.css  Dialog、Context Menu、Quick Switch、Tooltip
  goal-agent-picker.css  Goal 的 Agent 选择器
  agent-panels.css  Agent 的 Portal 面板（花名册、计数树、资源用量）——紧跟 overlays
  performance-toolkit.css  性能观察与脚本工具
  agent-avatar-face.css  Agent 头像的角标几何与 Provider 图标（packages/client-ui/src/styles）
  agent-avatar.css  执行器头像的 Provider 轮廓、角标、状态、计数与设置预览
  full-page-loading.css  启动与全页 loading/recovering/failed 大屏的网格、切片、品牌层和动效
  session-recap.css  Session recap 的真实来源、阅读与就地动作
  session-recovery-actions.css  Session 恢复动作与确认对话框
  conversation-ruler.css  对话标尺的窗口控件与密度
  host-identity.css  Host 身份标记
  git-workbench.css  Git 工作台：提交详情、分支 diff 与编辑头
  conversation-landmarks.css  对话阅读点：命名与跳转
  bot-setup-guide.css  Bot 设置进度：阶段与已确认里程碑
  bot-profile.css  Bot 资料结果：写入回执与当前观察
  mote-profile-task.css  Mote 资料任务：结果、检查、动作与请求追踪
  connector-experience.css  连接器任务画布：引导、注册与 Bot 任务
```

这张清单由 `apps/desktop/test/stylesheet-organisation.test.ts` 核对：测试解析本节以 `styles/` 开头的代码块，两空格缩进的文件名须与 `index.css` 顶层 `@import` 的顺序和集合逐一一致，四空格缩进的子表不参与比对。拆分或调整样式文件时同步本清单；描述列只供阅读，不参与核对。

约束：

- 全局主题值的唯一 owner 与消费边界见[《主题与样式 SSOT 规范》](#主题与样式-ssot-规范)；组织守护检查真实声明的归属，不把读取现有外观的选择器判成第二份主题值。
- 按表面分文件，不按属性分（不设 `typography.css`／`colors.css`），修改一个表面时不必在多个文件之间来回查找。
- 入口按上述顺序 `@import`，层叠顺序即文件顺序；不依赖选择器特异性打架来决定胜负。
- 单文件超过 400 行时按表面继续拆，不靠注释分节代替分层。拆出的表面块在原入口的合法顶层 `@import` 中保持原层叠位置：层叠顺序即文件顺序，换位置等于改变层叠。上面的文件顺序核对覆盖这条。
- 没有孤儿文件：每个 `.css` 都要沿 `index.css` 的导入图可达，子表可由原表面的入口递归 `@import`。不在导入图中的样式文件规则永不生效，扫描却仍会读到它。
- 读取样式的测试经 `apps/desktop/test/helpers/styles.ts` 沿导入图按层叠顺序读取整张样式表，不硬编码单个 `.css` 路径：按表面再拆分是常规动作，写死路径的断言会在规则搬走后扫到空内容而保持绿色。`apps/desktop/test/stylesheet-organisation.test.ts` 会报出硬编码 `styles/*.css` 路径的测试。

## 非目标

- 不建设主题市场、账号服务、任意 CSS / 脚本插件或通用扩展框架。声明式主题编辑与本地文件导入导出属于已确认范围。
- 不为没有规模证据的虚拟列表、文件拖动或移动端布局预建状态。
- 不在正式设计合同保留来源路径、固定 commit、Copy/Adapt/Omit 表或已完成任务流水。
- 不引入 CSS-in-JS、Tailwind 或预处理器：原生 custom property 已足以给尺度命名，换用构建期方案只会多一层工具链。

## 语义图标密度与性能

- App 品牌与界面语义图标分别沿自己的共享呈现入口。品牌组件只绘制调用方明确提供的已观察选择，宿主负责配置、资源读取和系统投影；业务页面不直连某份默认 PNG。App 图标的轮廓、底板、选择呈现及品牌出现的位置归[品牌架构](brand-identity.md)；保存与系统生效范围见[App icon 行为](../behavior/settings-and-observation.md#外观app-图标与主题文件)。
- semantic icon 按状态、对象、动作、导航、层级五类组织；同一语义在 Gallery、Workflow、Activity、聊天状态栏中使用同一几何和尺寸契约。
- 开发受控 UI 图标时先按实际对象、动作目标或导航目的地复用共享目录的稳定语义身份，不能仅凭同名动词或相似图形借位，确需新含义才扩展原目录；React 组件与原生/DOM 适配都通过共享投影引用语义，不在业务页面另建默认映射或直接绑定库字形。目录定义含义与可选图形，业务状态、权限与动作资格仍由原事实 owner 持有，不能从图标反推。
- 项目自绘图标共用 24 单位网格、轮廓与留白语言，线宽和端点沿主题与实例参数继承；静态、单色及小尺寸下先保证语义可辨，颜色与动画只作辅助。全目录按真实消费者核对图形与含义，牵强或误导的默认映射改用同族自绘，不限于 Activity；清楚的标准方向、键盘、选择控件、小状态点及带明确文案的创建加号继续沿原惯例。同一语义身份被用于不同含义时修正实际调用或拆分语义，不用更泛化的图形掩盖误绑。
- 每个自绘图形都须由原绘图 owner 同时定义清楚、好看的静止轮廓和合理的动态选择，工作台从同一来源展示和预览。动态选择按含义区分有条件循环、明确触发的单次反馈与保持静止；对象、历史、代码类型、身份标记和精确操作几何不为了凑齐动画而摆动。新增图形不能只交路径而缺少静止与动态设计；控件原有的禁用规则继续由宿主持有。
- 默认工作相关图标按真实语义分别表达正在产出、流式内容到达、浏览器操作执行与历史工作记录；读取等待使用加载语义，不能共用泛化的 Activity 心电图。内置主题的对应变体遵循同一语义与自绘语言；相同含义跨页面继续共用语义项，用户已显式保存的图形选择仍保留。
- 图标工作台复用产品当前语义目录、图标投影、根主题运行时及主题文件 schema，不另维护条目或默认绘图事实；打开即预览当前来源与主题，审阅注释与产品事实明确区分。完整语义用途、自绘设计（包括无绑定图形）和当前组件的交互预览在同一入口可发现，可按用途与设计搜索，在原图、当前主题与草稿之间比较并返回编辑。小尺寸与深浅主题预览保留实际辨识条件，不以少量常用样例代替目录覆盖。

  Mote 相关的角色与动作在独立视图集中比较，当前图形与未采用设计分别标明，可在同一主题和实际小尺寸中对照。身份、主会话角色与晋升动作各自可辨；候选图形不因同页展示而成为产品默认或操作资格。

  动态预览消费当前共享绘制结构与交互 owner，不能只复制路径或关键帧而遗漏局部结构、可见性及输入行为。Mote 的自动身份预览复用真实组件的靠近、悬停、键盘聚焦与触控按压回应，明确 glyph/paths 覆盖沿原主题解析保持；类型、历史和目录缩略图仍静止。仅选中的演示区域启用动作，离开后释放，暂停、重播及减少动画沿原能力表达；演示不产生业务状态、操作回执或持久修改。未来候选单独标明拟议用途、定义来源和采用状态，候选几何不进入当前产品目录、图形选择或产品主题导出。

  开发模式随原目录、图形及共享呈现能力的源码变化自动更新，无须人工重建或重新导入盘点；扫描范围包含客户端共享的语义选项映射，扫描与监听共用同一范围，源码线索不冒称完整动态消费证明。搜索兼顾目录默认与当前主题实际图形；从预览明确返回某项编辑时，目标不能被遗留筛选隐藏。所有语义项可对照默认与当前主题的实际小尺寸，分屏下保留编辑、导入及导出入口的可达性。发布的静态页面明确其源码快照身份与范围，不冒称持续跟随开发源码。页面更新保留原草稿身份、按稳定语义身份记录的修改和历史，无法对应的旧项保留并明确待核对；源码更新、切换预览与播放动作不能覆盖尚未保存的输入。页面编辑与预览、产品实际应用状态分别表达，完整主题导出可由原设置导入，页面操作不自动应用产品。
- 共享图标支持尺寸、颜色、线条等明确呈现参数；调用方显式值优先，未指定项沿主题与上下文继承。React 与原生图标投影共用参数含义，不改变主题图形选择、可访问名称和原命中区。
- 图标动画须由调用方显式选择，默认静态；语义名字或所选字形不自动启动动画。分类与列标题、历史工作记录、已记录状态及目录审阅样本保持静态；当前工作、内容流入、浏览器执行或读取等待是否持续，由原状态 owner 的准确事实决定，不能从图标、文字或历史的运行标签推断。静态、未知或终态不持续播放，完成反馈如需动画仅用明确的有限动作。
- 工作动效使用可爱而克制的小循环，保持图形可见和原可测几何，不以持续 opacity 明灭闪烁吸引注意。共享动画 owner 统一节奏和局部载体，不由业务页面重复实现。图形内有明确动作部位时只让该部位运动：`work-writing` 的文字线固定，笔做落笔、书写和抬笔的小循环，不摇晃整枚图标；等待沙漏表现上部沙量减少、细沙落下、下部积沙以及耗尽后的短暂停顿与翻面，不持续匀速自转、不表达实际剩余时长或完成比例。部件身份与原绘图同源，未声明相应部件的用户自定义图形保持其完整静态绘图，不猜分段或覆盖资产。加载与刷新也由原准确 pending 事实通过实例动画参数显式选择；`spin` 只驱动原绘图声明的可旋转部位，不旋转整枚载体，旧局部整图旋转样式不另行驱动。未声明该部位的图形保持完整静止，原 busy 文字与操作事实保留；用户资产不被拆分或替换。减少动画时退化为稳定 glyph。组合图标共享同一 viewBox、对齐基线和命中区。停泊或非活跃的留存工作面暂停自身及后代关键帧，回到可见宿主后自然恢复；不卸载阅读器、不改变可测几何，不把装饰性的 `aria-hidden` 或交互 `inert` 当作渲染隐藏。
- 图标组件默认不创建额外状态、不订阅 Store、不触发布局测量；映射表和 renderer 保持模块级稳定引用，避免列表滚动时重复创建图标定义。
- 同一功能含义跨 Desktop、Mobile 及不同 surface 共用稳定语义身份，尺寸和显式动画可以按宿主事实不同。不同语义保留独立身份、覆盖入口与可访问名称，可以共用默认 glyph，不为分开定制而机械新增绘图；需要同时辨认的状态须以图形、文字或状态色清楚区分，不能被装饰统一掩盖。

## 动态视觉的渲染边界

头像、状态图标和局部插画等持续动态，在不改变外部几何时，其样式、布局与绘制工作须由共享组件 owner 限定在相关视觉范围；固定可见动态实例及负载后，增加无关留存工作面不能放大它们的逐帧布局与绘制成本。确需推动正文或父布局的交互由 owning 专题定义实际变化范围，不能把装饰运动当作外部几何变化。各宿主复用同一边界，不分别补隔离样式。

React 组件、`memo`、独立定时器、稳定槽位及 CSS `transform` 均不构成浏览器隔离证明；合成层和布局边界分别核实。SVG 部件动画、溢出和同步几何读取须按实际 Renderer 观察传播，不能把 HTML 合成动画的经验直接套到内部 SVG。技术可采用有效的局部布局／绘制隔离或适合现有内容的渲染方式，由原 owner 选择最小方案；不要求每实例独立进程或统一改用 Canvas。采用 CSS containment 时须作用于有效布局盒，并核对固有尺寸、基线、定位、溢出、焦点与命中；`paint` 会裁剪溢出，`size` 会改变内在尺寸参与，不能机械套用 `contain: strict`。这些语义沿 [CSS Containment 规范](https://www.w3.org/TR/css-contain-2/)核对。

可组合插画的静态绘图与动态骨骼由同一 owner 管理；选择渲染结构时，同时保护部件顺序、继承的颜色与线条、组透明度、模型关节、表情及连续指针／手势组合。绘图叶不参加载体的泛化动效，生产仅保留一棵绘制树；不能靠隐藏原树却继续运行其动画来模拟隔离。固定部件的模型几何可直接定义并以原生绘图核对，不为关节位置建立逐帧测量或可见性重试链。

指针响应只测必要的可见局部范围，同批几何读取先完成再写入，避免实例间交替读写造成强制布局。动画与状态变化保原外观、真实语义和必要的连续运动；静止策略沿各专题已有可见性合同。不能靠关闭原动效、卸载留存工作面或暂停健康 Run 获得成本通过。验证方法唯一见[《动态视觉的浏览器成本验证》](../../testing/strategy.md#动态视觉的浏览器成本验证)。

## 成熟产品界面的控件与分组

Goals 的清单／看板、详情和工具带唯一见[《Goals 的目标正文与对齐密度》](goals-and-demand.md#goals-的目标正文与对齐密度)。公共控件保持工作面优先：短工具、清楚作用域、单一选中信号，不为每个动作包彩色胶囊或重建旧 Branch Board。

页面层级靠留白、字号、对齐和单一选中信号建立。Surface 使用中性深色层、hairline 分隔和很小的状态色面积；禁止多彩渐变、发光轮廓、连续彩色线框和无语义的装饰图标。Project 色只在身份点、短边或状态标记上出现，不能铺满整卡。Browser 空白起始页可关闭的背景装饰沿[起始页专题](browser-workface.md#browser-空白起始页)作为局部例外，业务控件与卡片仍遵守本节约束。

Goal 清单／详情、执行 Session 观察和 Mote 讨论是同一流程中用途不同的表面，不成为并列产品。每个区域有可回答的问题和明确返回／收起动作；演示性“页面 01／02／03”不进入产品合同。宽窗详情保同屏列表，窄窗需要独立阅读时沿原返回入口，不借覆盖边缘重新定义 drawer 行为。

Mote 讨论复用原空间引用、消息与 Composer；身份区、对象／讨论导航、单一边界与首屏层级只见[Mote 呈现 owner](motes-and-coordination.md#mote-快捷入口与当前协调上下文)。确认策略与写入状态沿原紧凑控件，真实协作身份和消息正文不因“客服式卡片”禁令被删。

Topic Wiki 注入只在原生 Topic chrome 里以一个轻量状态表达，例如“Wiki · 已加载 12 条规则”或一个可检查的注入图标；不要把整份规则常驻在对话面板。用户点击后进入现有 Topic/Wiki 编辑入口，查看来源、版本、启用状态和最近修改；注入规则在 Agent 输出中只以必要的来源标记出现，避免再造一套知识库卡片。
