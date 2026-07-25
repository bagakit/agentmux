# Task Plan Review — AgentMux Surface Language & Live Region

日期：2026-08-29
Plan revision：1
设计 SSOT：`docs/design/agentmux-surface-density.md`（《尺度系统》《控件语言》《Scratch Topic Row》
《样式表的组织》）与 `docs/design/agentmux-desktop-interaction.md`（《Scratch 与 Topic》《Terminal》）

## 结论

**approved.** 八个 task 各自可独立验收。三组需求（Topic 行体验、终端恢复态、全局设计语言）
共用同一个 feature，因为它们改的是同一批文件（`styles.css`、Topic 面板、Workbench 渲染），
分成三个 feature 只会让同一片代码被三条流水线轮流改写。

## 需求来源

三条需求全部来自用户，原话逐字记录如下。

### 一、Topics 页面六条（附截图）

> 1. 现在选择 topic , 没有像 branch 那样只展示自己的 tabs, 而是展示所有, 这个看起来很混乱
> 2. 默认情况下, 上面的文件系统高度可以窄
> 3. 跳转文件的图标换一个表示 "聚焦定位" 的更好, 而改名不用给个专门图标, 可以放进 topic 右键菜单
> 4. 现在 topic 左边的窄边表示选中, 太难看了, AI 味道重, 不够现代化. 这个项目有没有设计引导,
>    能不能吧这种样式全 ban 了
> 5. Topic 左侧的图标没有任何含义, 不如去掉?
> 6. 每个 item 的用点样式表示执行情况, 方向正确, 但是是不是最好用缩小的 Agent 图标, 做成类似于
>    人员头像列表, 用边框类型表示状态, 鼠标划过有 mac 导航栏的悬停效果 + tooltip 显示信息 + 点击跳转

第 4 条问的是"这个项目有没有设计引导"——有，`docs/design/agentmux-surface-density.md`。用户要求
"把这种样式全 ban 了"，因此这不是改一行 CSS，而是**往控件语言里加一条禁令并由测试守住**，
否则下一个人还会写出来。

### 二、终端恢复态

> 现在切换是都会 restoring terminal, 但是 /Users/bytedance/proj/github/a mature workbench 就不会,
> 可以看看差距在哪儿, 记个技术需求并放进 tracker 优化

### 三、全局设计语言

> 需求要加上全局的设计语言、框架、规范梳理, 字号边距统一等, 包括相关的代码架构和实现优化

用户把"代码架构和实现优化"和"字号边距统一"并列提出。这是对的：字面值散落既是视觉问题也是架构问题，
2464 行的单文件样式表让"统一字号"这件事本身无法被安全执行。因此 T-107（样式表按表面分文件）
与尺度收敛同属一个 feature，且必须排在收敛之后——先有 token 再搬家，否则搬完还要再改一遍。

## 现状实测（写计划前跑的只读审计）

对 `apps/desktop/src/renderer/src/styles.css`（2464 行）的量化结果，全部为本轮实测：

| 维度 | 现状 |
|---|---|
| 字号字面值 | **16 种**，283 处声明；`font-size: var(...)` **零处** |
| 违反现有合同的字号 | 7px、9px 各一处（合同写明"微标不低于 10px"） |
| 半像素字号 | 10.5px×2、11.5px×5 |
| 页面级标题字号 | **5 个不同值**：16 / 19 / 20 / 23 / 24 / 31px |
| 间距字面值 | **32 种**，778 处；其中奇数像素 326 处（5/7/9px 合计 201 处） |
| 非 `:root` 硬编码颜色 | **330 处**，含 `#12151b`/`#13171d`/`#14171d` 这类亮度差 <2% 的近似值 |
| 悬空 token 引用 | `--text-1`×2、`--border-subtle`×1、`--shadow`×1 —— **静默失效** |
| 无人引用的 token | `--violet` |

最后两行是 bug 而非风格问题：`.workspace-topic-title-line strong { color: var(--text-1) }`
引用了一个从未定义的变量，那行标题的颜色**从未生效过**，CSS 不报错所以至今无人发现。
这直接说明为什么需要静态检查，而不只是一次性清理。

## 终端恢复态：差距定位

**AgentMux**：`WorkspaceWorkbench.tsx:647` 是 `{activeTab ? <PaneNode … /> : null}`——只渲染
当前 tab 的布局树。切走 tab 即卸载整棵树，`TerminalView` 随之卸载，xterm 实例与 PTY 连接一并销毁。
切回时组件重新挂载，`TerminalView.tsx:115` 的 `useState(true)` 让 `hydrating` 从 true 起步，
`terminal-startup.ts:11` 据此判定为 `'restoring'`，于是必然重放"Restoring terminal…"。

**a mature workbench**（MIT，只读机制调研，不抄代码）：隐藏 tab 用 `display:none` **保活**，实例不销毁。
其 `terminal-pane/TerminalPane.tsx` 的注释写明 "ordinary hidden tabs are display:none and refit
on visibility resume"，配套有 `use-terminal-container-fit-sync.ts` 处理"display:none 的 pane
量不出尺寸"这一后果，以及 reveal 时补发目标网格的路径。

**差距是一个决定**：AgentMux 把"这个 tab 不可见"实现为**不渲染**，a mature workbench 实现为**渲染但隐藏**。
恢复态不是加载慢，是实例真的没了——所以修法在保住实例，而不在加速重放。这条已写入 SSOT 的
Terminal 节，连同三条边界：不可见终端不做布局与渲染工作、实例存活边界是 Region 的存活边界
（不建绕过 Region 生命周期的缓存池）、恢复态只在真正需要重放时出现（首次 attach、断连重连、replay gap）。

## Topic tab 隔离：根因

反馈第 1 条的根因已定位：`layoutForActiveTopic`（`WorkspaceWorkbench.tsx`）按
`activeScratchTopicId` 过滤，而该字段只在 `openScratchTopic` 内被赋值。从任何其他路径进入
Topic（点 Tab、会话恢复、Board 跳转）时它是 null，过滤不发生，于是所有 Topic 的 tab 全部可见。

修法**不是**在每条入口补一次赋值——那是第二、第三条 Topic 绑定路径，与 T-001 刚刚消除的重复同类。
当前 Topic 必须**从当前活动 Tab 的绑定派生**：Tab 知道自己属于哪个 Topic，那就是唯一真相。
这条已写入 SSOT。

注：本条与已提交的 `72369ef feat: isolate topic tabs in the workbench` 存在重叠，T-101 开工前
必须先核对该提交实际做到哪一步，只补未闭合的部分，不重做。

## 逐 task 核

| Task | 独立可验收 | 备注 |
|---|---|---|
| T-101 Topic tab 隔离（派生而非赋值） | 是 | 先核 `72369ef` 已闭合部分；断言从非 `openScratchTopic` 路径进入也只见本 Topic 的 tab |
| T-102 尺度 token 落地 + 契约测试 | 是 | 先立 token 与 `surface-scale-contract.test.ts`，再逐片替换；悬空引用一并修掉 |
| T-103 ban 左侧竖条选中态 | 是 | 依赖 T-102 的契约测试基座；`surface-selection-contract.test.ts` 从 CSS 反推 inset 竖条 |
| T-104 Topic 行 Agent 头像列表 | 是 | 六条里最大的一条；复用共享 `status--<state>` 语汇与 `selectSession`，不新建状态映射 |
| T-105 Topic 行动作分层 + 面板默认高度 | 是 | 反馈 2/3/5：定位图标、改名进右键菜单、去掉行首图标、文件树默认收窄 |
| T-106 隐藏 Region 保活，消除恢复态 | 是 | 本 feature 风险最高的一条，见下 |
| T-107 样式表按表面分文件 | 是 | 依赖 T-102——先有 token 再搬家 |
| T-108 页面级标题收敛到一档 | 是 | 依赖 T-102；五个字号并作 `--fs-display` |

## 落地顺序

T-102 打底（token 与契约测试基座，后面四条都依赖它）→ T-103 + T-108（纯收敛，见效快、风险低）
→ T-101 + T-105 + T-104（Topic 三条，从小到大）→ T-107（搬家）→ T-106（保活，单独做）。

T-106 排最后且不与他人并行：它改的是 Workbench 渲染树，是本 feature 里唯一可能与其他人正在做的
分屏/拖放改动撞车的一条。

## 需要盯住的风险

- **T-106 会把"不可见"从"不存在"变成"存在但隐藏"，这是行为变更不是性能优化。** 一切原本靠
  "卸载即清理"隐式成立的东西都会失效：定时器、监听、resize 观察、渲染循环。必须有显式断言证明
  隐藏的终端**零布局零渲染工作**，否则开十个 tab 就是十个后台在跑。这类退化不会让任何现有测试变红。
- **T-106 不得建终端实例缓存池。** 实例存活边界必须与 Region 一致；一个绕过 Region 生命周期的
  池子会造出第二套终端生命周期，与 SSOT 的"视觉改动不得创建第二套生命周期"直接冲突，
  且泄漏时无人负责回收。
- **T-102 不得靠"改小合同"来达标。** 契约测试的例外清单是给真实例外用的（状态点字形、hairline、
  Activity spine 的 104px 对齐点），不是给"懒得改"用的。每加一条例外要在合同里写明理由。
- **T-102 与他人并行改 `styles.css` 的概率最高。** 本轮已观察到同事在同一棵树上提交
  （`72369ef` 一次带走 60+ 文件）。T-102 应一次改完一片、立刻跑 gate，不留长时间未提交的大改动。
- **T-104 不得新建状态映射。** Topic 行头像的状态边框必须读共享 `status--<state>` 与
  AttentionCategory；再写一份"这个状态显示什么颜色"就会与状态点、Attention Bar 三处不一致。
- **T-101 有重复劳动风险。** `72369ef` 已声称做了 topic tab 隔离，开工第一步是读它，不是写代码。
