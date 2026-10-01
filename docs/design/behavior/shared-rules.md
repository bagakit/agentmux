# 共同原则、设计事实与 Owner

本文集中本主题的交互与行为要求。已确认约束定义必须成立的结果，不代表当前实现通过验收；提案、历史与当轮授权状态按正文的明确范围阅读。

[返回交互合同](../agentmux-desktop-interaction.md) · [同主题视觉](../presentation/shared-rules.md)

**本页章节**

- [项目文档阅读与维护](#项目文档阅读与维护)
- [主题切换与样式真值](#主题切换与样式真值)
- [设计哲学](#设计哲学)
- [Agent 主观审美的端到端验证](#agent-主观审美的端到端验证)
- [组件化的独立评估边界](#组件化的独立评估边界)
- [Owner 边界](#owner-边界)
- [整体 review 的可靠性约束](#整体-review-的可靠性约束)
- [验收原则](#验收原则)
- [非目标](#非目标)
- [语义图标体系](#语义图标体系)
- [UI 架构实施原则](#ui-架构实施原则)
- [产品表面设计审核与参考层级](#产品表面设计审核与参考层级)

## 项目文档阅读与维护

用户反馈「现在 Agents.md 写的有点糟糕」，要求「偏移你处理下，然后我们治理下文档质量和结构」「建立更好的文档规范」。先校正事实偏移，再收敛文档职责与入口；文档必须让读者分清当前约束、当前实现、已验证结果、待确认提案与历史证据。旧 commit、协议版本和测试结果保留原观察范围，不能改一个版本号就冒充当前行为已验证。

每类事实只有一个 owning 文档或来源。根 AGENTS 提供短协作入口与硬边界，专题细则由对应文档持有，导航让相关来源可达；用户确认的约束在原 owning 章节合并，不继续按聊天记录追加同一要求。文档规范唯一见[文档事实与维护](../../guides/document-truth-and-maintenance.md)。

有价值的需求与思路以 idea 为原点，先记录整合；确认内容归 owning 需求或设计文档，决定执行后再登记 Tracker 并执行，具体顺序见[idea 的记录与整合](../../guides/document-truth-and-maintenance.md#以-idea-为原点记录和整合)。有价值但尚未执行的 idea 仍需保留，不自动成为执行 Task；idea 与过程资料不提交。

治理保全既有 Core／ctxmux／Provider 分层、健康 Agent 与原工作面、按需恢复、相关成本和协作交付权责。冲突依据用户已确认的 owning SSOT 收敛；缩短入口不能扩大自动恢复范围，也不能把公共机制的泛化要求误用为禁止 Provider 解释其原生协议。

纯文档任务以来源与链接核对、独立语义保全评审验收；代码变异和产品调用者证明用于对应实现任务，不为没有代码改动的任务制造假证据。静态来源核对不代表当前运行行为通过，历史证据不代签新候选。

用户要求「优化结构欠账」，并明确「过程性文档不提交」。交互与视觉的两个 canonical 入口保持短且可导航，完整约束按稳定对象与行为归到唯一专题正文；入口不再承担所有主题的追加正文。当前引用随正文归属准确可达，不复制全文，也不因结构重组改变权限、恢复、健康 Run、相关成本和交付责任。

本轮保全原文字句、标题语义与并发 HEAD / index / working 的原始内容和所属层，不大规模删旧需求。项目全貌与公共 API / CLI 的阅读入口说明事实 Owner，并到达实际源码合同，不另抄一套定义；参考项目只提供读者意图、事实 Owner 与单一来源的组织启发。

过程资料的 Git 边界、原始研究与未批准建议的本机定位，以及分别保全 index / working 后退出 Git 且不删本机原字节，唯一遵循 [过程目录](../../process-directories.md)。复盘方法归指南，验证方法归 [测试策略](../../testing/strategy.md)。结构治理以实际源段落与标题保全、有效引用和独立语义评审证明；静态文档证据不代签产品运行行为。

## 主题切换与样式真值

- App chrome 的主题只有一个运行时入口：根文档的 `data-appearance` 属性。设置、系统偏好与启动恢复都
  通过同一入口生效；组件不得各自保存一份主题真值。
- 主题值与语义映射属于 Surface SSOT，见
  [Surface 与密度合同《主题与样式 SSOT 规范》](../presentation/shared-rules.md#主题与样式-ssot-规范)。
- Monaco 编辑器跟随 resolved App appearance；Terminal 继续使用独立的 Terminal palette。切换 App appearance
  不得改变 Session、Run、Layout 或 Terminal palette 的持久化事实。
- 未来的 utility CSS 或共享 primitives 只能消费语义 token；切换主题不能改变 Session、Run、Layout 或
  其他产品事实，也不能为同一事实创建第二套状态。

> 当前确认的导航、Tab、分屏和会话栏需求见
> [顶部与项目栏](spaces-and-layout.md#顶部与项目栏)；`agentmux-project-rail-navigation.md`（本机过程资料：`docs/plans/agentmux-project-rail-navigation.md`）。
> Scratch 的 Topic 与 Wiki 合同见
> [Scratch 的交互与组织](spaces-and-layout.md#scratch-的交互与组织)；`agentmux-wiki-first-scratch.md`（本机过程资料：`docs/plans/agentmux-wiki-first-scratch.md`）。

## 设计哲学

- AgentMux 是 Agent-first、terminal-first 的桌面 Client。Agent 状态、用户输入、终端输出和恢复动作必须靠近它们影响的 View。
- 同一信息只在最合适的位置显示一次。Tab 保留工作面上下文，Region 标明其中 Agent 的身份；低频 ID、Host 和时间进入 tooltip 或 context menu；Activity 拥有最近消息。
- 界面层级由 Surface、明度、局部高光和紧凑密度建立，不靠连续边框、重复标题或极小字号制造“专业感”。
- 选择、键盘、拖拽、菜单和可访问性交互使用维护中的成熟依赖与平台模式。
- Desktop 只组合 Core 的公共能力。所有 Agent 生命周期都经过 `packages/core`；所有 PTY、进程、Run、Replay 和 Attachment 事实都由 ctxmux 持有。
- Renderer 等无 Node client 消费 Core 的纯投影时，公开入口的运行期依赖必须保持环境无关，不能把 Provider、Runtime 或 Node 内置模块带入 client 构建；同一投影继续由 Core 持有，不在 client 复制逻辑或替换 Node API 来掩盖边界错误。

## Agent 主观审美的端到端验证

用户要求：「但是不要搞过度设计，和过度防御，应该让 agent 去判断，像素距离这太 workaround 了，建立一个主观审美的端到端验证机制吧」。视觉交付必须能沿真实产品的端到端场景留下可重复的截图，并由独立 Agent 看见截图、结合当前任务和两份设计 SSOT 作出可解释的判断。已有产品 probe 承担场景与截图采集；合成展厅、源码字符串或局部几何检查不能替代真实工作面。

截图及评审必须能关联实际场景、产物身份和观察状态；独立 Agent 明确哪些画面已经看到、哪些情况仍缺证据，并给出具体问题、影响和修正建议。未看到画面、目标未显示或采集不清楚时诚实标为未知；采集或评审流程失败不能关闭健康 Agent、清空用户工作面或把流程问题写成产品已经坏了。机制只组合既有 probe、两份设计 SSOT 和 Agent 的看图判断，不增设通用测试框架、自动审美评分或另一份设计真相。判断所用的视觉语言与工程测量边界只定义在密度 SSOT[《Agent 主观审美的判断边界》](../presentation/shared-rules.md#agent-主观审美的判断边界)。

用户进一步要求：「各种界面设计，做完你自己先让subagent用最高审美品味看，要优化到他满意为止」。这是所有界面设计改动的交付约束：独立 Agent 按成熟产品的高审美标准实际看本批完整界面与关键状态；若结论为 needs_changes，修正具体问题、重新采集受影响场景并复审，直到独立评审明确 approved／满意、可交付。原图、未通过意见与修正后候选身份均保留，判断须说明具体画面与理由，不用主观数字评分。未知、未看或仍需修改不能判 done；测试全绿、几何达标、采图成功、高评分或旧批次满意不能代替本批候选的独立满意结论。范围、真实反馈与健康工作面的保护不因审美迭代而放松。

用户进一步要求视觉审计「保证执行，且不会违背与需求的 SSOT」。每个 UI 改动任务的验收必须有本批候选的实际场景执行、截图与独立 Agent 看图证据；发现问题并修正后，须有同场景复核。有流程说明、采图入口或旧批次报告，不能代替本次已执行。证据缺失时明确缺项，不宣称视觉已验收，审美判断仍由 Agent 完成。

fixture 只定义场景数据、操作、观察点与模拟边界，并引用当前需求 SSOT；不复制设计预期或在 fixture 内另定审美规则。需求 SSOT 变化后，Agent 必须检查受影响场景是否仍对应当前约束，调整已过时的场景并明确未覆盖或未执行的部分；旧截图和旧判断不能因 fixture 仍能运行而被当作当前验收。执行保证沿 UI 任务的验收与证据责任成立，不凭流程说明宣称已有每次自动执行的保证。

## 组件化的独立评估边界

用户希望摸底时单独评价组件化，以公开 API、服务的定义与实现及消费关系、贡献的注册与释放、真实调用者和替换成本为依据。比较项目仅作为证据，不能成为本项目的实现分支，也不自动形成 all-plugin 或 RSI 要求。评估与后续改进必须保护 Core 与 ctxmux 的既有职责和权威事实，不复制运行时 owner，不阻断健康 Run，不丢失现有工作面。

用户进一步要求「优化一轮到相当高的水准，让后续各类迭代少走弯路」。Provider 的 managed Hook 安装能力须由同一注册对象完整贡献，真实检查、启动与恢复消费同一贡献及其原工作区、环境和 endpoint；新增自定义 Provider 不应要求修改客户端或第二份内建能力名单。贡献替换后下一次消费使用新对象，非法替换保留原对象；上下文不足、计划失败与真实安装结果准确区分，流程失败不阻断健康 Run，既有 installer 保持唯一写盘责任。此要求不宣称任意活跃语义 Provider 热卸载已经成立。Desktop 的组合入口仍归 client，草稿、附件、Session、Run 与截图子进程各保持原 owner；可复用的展示必须在 Session 与新建工作面均有实际消费者，不能以拆文件或新增插件框架代替能力闭合。

插件 Provider 贡献的合法性及 duplicate 检查必须在本次任何贡献进入目录前全部成立。注册被拒绝时，原 Provider 对象目录、已注册插件与 Skill、command、PMO metadata 保持不变；修正后原 pluginId 可以直接重试。Provider 注册校验与提交保持同一 Registry owner，插件入口不复制校验规则，不先写入再回滚，不新增 Registry 或 transaction 平台，也不操作或阻断健康 Run。

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

## 整体 review 的可靠性约束

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

## 非目标

- 不把 AgentMux 做成另一个 Run Runtime。
- 不把 Desktop 布局、Topic、Provider 或 Agent 语义下沉到 ctxmux。
- 不为命令对称、未来平台或未出现的规模证据预建功能。

## 语义图标体系

- 具有产品语义的状态、对象、动作、导航和层级图标统一经过 semantic icon 目录；调用者传入语义枚举，不直接在业务 JSX 中选择 lucide glyph 或写状态字符串。
- 编辑器、终端和第三方内容内部的图标不强行迁移；只有跨表面共享、需要无障碍名称、状态表达或动画策略的图标进入该体系。
- 动态图标、动画图标和组合图标都必须通过同一 renderer contract，支持 `prefers-reduced-motion`、`aria-hidden`/可访问名称、稳定尺寸和低成本重渲染；动画不能由业务组件各自实现。
- 不保留向后兼容、migration 或 fallback；旧的 icon 语义直接删除或明确替换，不能让两套语义长期并存。
- 同一语义必须有唯一且足够独特的图标结构；不同语义不得复用同一个最终 glyph。图标映射测试必须钉死完整集合而不是只断言“有图标”。
- 动态图标必须为具体语义设计动作：例如运行态旋转、完成态打勾、等待态呼吸或暂停态停驻；不能所有状态都套同一种 spinner。reduced-motion 下退化为稳定但仍独特的静态结构。

## UI 架构实施原则

- 先分层和确定事实 owner，再写组件；设计、需求、状态和验证保持在项目知识 SSOT 内，避免无意义的平行抽象。
- 先跑通最小端到端路径，再扩展状态、插件和主题；不为了未完成的复杂度拆掉能跑的实现。
- 组件保持模块化和关注点分离，优先复用项目已有依赖与成熟模式；没有明确证据不新增库、不重写已有能力。
- 架构选择按长期维护和可验证性决定，不留下“以后再换”的临时兼容层。
- 测试按执行时间和变更范围设计：小改动优先定向并发验证，只有跨边界变化才触发更宽回归。

## 产品表面设计审核与参考层级

- 新的桌面工作面、浮层和工具栏在实现前必须先找同类成熟产品作为参考；参考必须匹配对象和交互，而不是只借颜色或圆角。浮动终端/工作面优先参考成熟桌面终端的浮动面板形态：36px 级别的工具栏直接承载 Tab、分屏和新建动作，工作面不再另造一条大标题。
- 设计默认采用内容优先、工具条优先和单一 chrome。标题是身份元信息，不是首屏主视觉；如果去掉标题仍能从 Tab、头像、状态和工具提示识别工作面，就不要保留大字标题、副标题或欢迎式说明。
- 一个表面只能有一套窗口边界、一套标题/Tab 层级和一套关闭语义。把完整 Workbench 放进弹窗时，必须复用 Workbench 的顶层 Tab/工具栏，不得再套一个同义标题栏、第二个空壳或重复的 PMO 入口。
- 评审第一眼必须能回答三个问题：当前工作面是什么、第一交互是什么、内容从哪里开始。不能回答时先删减层级和装饰，再考虑增加说明。大标题、宽 padding、持续副标题、重复边框和无操作的品牌卡片属于默认拒绝项。
- 参考证据、反例和最终截图/运行态核验必须写入 feature 的 design source evidence；“看起来更现代”不能只作为口头判断。验收至少包含正常宽度、窄宽度、打开后第一帧和拖动中的状态。
