# Task Plan Review — AgentMux Desktop Workline Surfaces

日期：2026-08-31（最近一次修订）
Plan revision：5
设计 SSOT：`docs/design/agentmux-desktop-interaction.md`（《Board 与 Settings》《状态栏》《显示名与身份》三节，通知与项目行相关约束在《顶部与项目栏》）；
视觉 SSOT：`docs/design/agentmux-surface-density.md`（密度预算的 Project Rail Row / Scratch Topic Row 两行，与《控件语言》《样式表的组织》两段）

## 结论

**approved.** 十个 task 各自可独立验收，依赖关系与用户确认的落地顺序一致。

## Revision 5：新增 T-009、T-010（Project Rail 单行三信号 / 同族列表行共享表现层）

本轮用户看最新截图后提了五条。逐条查过代码后，其中**两条的真因与用户的猜测不同**，据此
拆成两个 task 而不是五个——它们各自是一个能独立验收的闭环，按五条切会把同一份改动切开。

**T-009（用户第 1、3 条）——"Agent 数字不准"的真因不是算错，是算的另一件事。**
`WorkspaceSidebar.tsx:142-144` 显示的是 `project.workspaces.length`（worktree 数），
而密度合同《身份归属》早就写明这行答的是"在跑几个 Agent"。**代码与设计文档已经漂移**，
所以修法是让代码回到文档，不是调样式。同一行还有两处一列全同的内容：每行都写 `This Mac`
（本机 host），以及计数恒为 `1` 的徽章——按《控件语言》"一列全同的图标不是信息"同一条理由，
两者都该消失。用户第 3 条（Scratch 前的 `Sparkles` 换成项目 icon）落在同一个组件的同一行
结构上，与前者同批改动，故合并进 T-009；经与用户确认，用的是已存在的 `BrandIcon`
（`resources/icon-128.png`），**不新造 per-project 图标体系**。

**T-010（用户第 2、4、5 条）——"图标没对齐"的真因是隐式 auto 网格列。**
`dock.css` 里 `.workspace-topic-entry > span` 只有一个隐式 auto 列，该列按内容宽度定尺，
于是 `.workspace-topic-agents { margin-left: auto }` 靠的是**内容盒右缘**而非行右缘。
截图逐行量过：头像右缘恰好按描述文字长度分成三档。修法是把那一列显式写成 `minmax(0, 1fr)`。
用户第 5 条要求 branch bar 与 topic bar 复用——**确认只抽表现层**：两者的选中真相模型确实
不同（Branch 换 `activeWorkspaceId`，worktree 自成一个 workspace；Topic 是对同一份 Scratch
layout 做投影，见 `scratch-topic-layout.ts:42`），不得为了"统一"把其中一侧改成另一侧。
第 4 条（Topics 标题与计数排版）正是共享容器 header 的一部分，故与第 5 条同属 T-010。

### 需要盯住的风险

- **T-010 最大的风险是竖切未闭合**：抽出共享组件却只接了一侧，或两侧各自保留一份"长得像"
  的写法。判据不是"测试绿"，是**两个 bar 上看起来相同的东西必须真的是同一段代码**——
  沿用本 Feature 全局的零调用者检查，并额外要求断言两侧渲染出同一批共享类名。
- **不得把 Topic 的头像上限做成无限**。当前 Topic 侧无上限（直接 map 全量），branch 侧截断
  到 4 并给 `+N`。共享后统一取 branch 的做法：叠压省宽度但不是无限的。
- **`dock.css` 已 393 行、上限 400**，三项改动都落在它身上，必须按表面再拆一刀
  （新建 `selector.css`）。新样式文件必须同时进 `index.css` 的 `@import` 序列与
  `stylesheet-organisation.test.ts` 的精确顺序数组——只做前者不会红，只做后者会直接红。
- **既有测试里有钉死 CSS 字面量的写法**（`surface-tool-dock.test.ts` 断言了一整条
  `.workspace-topic-entry { ... }` 字符串）。修对齐必然改到它；改的时候要把断言从"字面量
  相等"改成**断言意图**，否则下一次调格子它还会假红。

## Revision 3：新增 T-008（Project Rail 视觉语义与简化）

本轮用户反馈为：左侧 `Projects` 文字存在感过强；选中项目的图标变亮容易被误读成
“只有这个项目有 Agent 在跑”；普通项目行的重复图标没有信息价值，希望改成参考图那样的
紧凑列表。

落点是同一个 Project Rail Closure，不新增 Runtime 或 Session 状态：

1. `Projects` 只作为分组标签，使用低于项目行标题的元信息层级。
2. 选中只由中性整行 Surface/`aria-current` 表达；运行状态由 `sessionBoardColumn` 的
   `working` 列派生，在每个有运行中 Agent 的项目行独立显示，不受选中与否影响。
3. 普通项目去掉重复 `FolderGit2` 槽；Scratch 的独特图标只有在承担工作区身份时保留。

T-008 的验收会同时覆盖选中/运行的四种组合，避免回到“亮图标=选中且运行”的单一信号。

## Revision 2：新增 T-007（通知内容与停留时长）

用户在 revision 1 执行途中补充一条需求，原话为：

> 通知时显示的内容要详实，包括是哪个 agent、什么状态、最近的 agent 回复消息、最近的用户问题等。
> 停留时间可以稍微久一点，最好是让用户确认关闭。
> 当然可以在设置里提供通知模式的配置（比如停留时间以及是否关闭）。感觉可以做成一个滑轨：
> 从关闭，到打开后的不同停留时间，再到最长的"等待用户确认"

解读与落点：

1. **"详实"针对的是现状的泛化文案。** 当前正文只有一句 `${label} is waiting for your answer.`
   （`attention-notifier.ts:41-45`），标题是三选一的固定串。用户要的是看到通知就能决定要不要
   放下手上的事——所以正文要带最近一轮对话（Agent 最近回复 + 用户最近提问）。内容从既有
   Session 投影与 Activity 时间线派生，不为通知另建一份对话记录。
2. **"滑轨"是一个连续量级，不是开关加输入框。** 用户明确描述了它的形状：`关闭 → 若干档停留
   时长 → 等待用户确认`。这三段在一个维度上，因此是一个控件而不是两个。档位表只有一处定义，
   投递与设置共用。
3. **"等待用户确认"在 Electron 上有平台差异**，这是本 task 的主要风险（见下）。

## 需求来源与两处前提修正

五条需求来自用户，原话为：状态栏显示各类 agent 的活跃/待机数量和 tps 及总 tps（统计开销要低）、
状态栏显示 CPU RSS、抄 a mature workbench 的启动时同时命名 agent 与 tab 及运行中改名并做成默认行为、
Topic 也应该有 inbox 和 board 视图、board 工具的次级菜单换成工作清单。用户指明前两条"大部分可以从 a mature workbench 直接抄"。

对 a mature workbench（MIT，`/Users/bytedance/proj/github/a mature workbench`）做只读调研后，两处前提不成立，已与用户确认：

1. **a mature workbench 没有 tps。** 全仓 `tps`/`tokens per second`/`throughput`/`token rate` 零命中；
   它只有累计 token 用量（计费面板），没有速率。这部分无可抄。用户据此决定：先接 Provider
   原生 usage 再做 tps，本轮状态栏只出活跃/待机计数（T-003 出计数，T-006 出 tps）。
2. **a mature workbench 里 agent 名 ≡ tab 名，是同一个字段**，不存在"同时命名两处"。它启动对话框里用户填的
   Name 命名的是 workspace，与 agent 选择是两个独立控件。我们与 a mature workbench 的结构差异在于**一个 Tab
   可分屏承载多个 Agent**，所以不能照搬合一模型。用户决定两个独立名字字段，并补充了关键策略：
   "Tab 比 Agent 所在的 Region 高一级，所以如果只有一个 Agent，Tab 默认就对齐 Agent 名字，
   但是可能再开 Region，这个时候 Tab 应该要能体现出是一个 Agent 家族。所以名字要分开，
   方便有更好的策略。" 这条已写入 SSOT 并成为 T-005 的验收。

可抄的部分（只学机制，不抄代码）：CPU/RSS 的采样架构——仅面板打开时轮询、in-flight 去重、
一次全主机 `ps` 扫描按 pid 子树归并、共享祖先按注册顺序只归第一个。均已落入 T-004 验收。

从 a mature workbench 学到的两条反面教训也已落入验收：它的 tab 改名要双写 legacy 与 unified 两个模型
（T-005 要求只有一个 Tab 模型）；它的 workspace 名进了路径与 session key，改名会炸引用，
只能靠 `priorWorktreeIds` 别名和"已删名不复用"打补丁（T-005 要求名字绝不进 id 与 key，
并有断言证明改名后三级地址不变）。

## 逐 task 核

| Task | 独立可验收 | 备注 |
|---|---|---|
| T-001 Board 行来源参数化 | 是 | Branch 行为不变 + Topic 行产出正确，两侧都有断言 |
| T-002 工作清单换掉说明页 | 是 | 依赖 T-001 的参数化行，避免清单自己查一遍数据 |
| T-003 按 Provider 活跃/待机计数 | 是 | 纯函数派生，无新 IPC、无定时器 |
| T-004 展开时采样 CPU/RSS | 是 | 依赖 T-003 的状态栏结构；折叠零采样是首要约束 |
| T-005 Agent 与 Tab 显示名 | 是 | 动 contracts，用 `pnpm check` 兜全链路类型 |
| T-006 Provider usage 与真实 tps | 是 | 依赖 T-003；无真实 usage 就不展示，不估算 |
| T-007 通知内容详实 + 停留时长滑轨 | 是 | 不依赖其余；内容从既有投影派生，档位表单一出处 |

## 落地顺序

按用户确认：先 T-001+T-002（Topic/Board，数据源现成、见效最快），再 T-003+T-004（状态栏），
最后 T-005（命名，动 contracts 面最大）。T-006 排在最后且不阻塞其余——它取决于 Provider
是否真的报 usage，是本计划里唯一可能长期挂起的一条。

## 需要盯住的风险

- **T-004 的折叠零开销是首要约束，不是优化项。** 一个常驻的全主机 `ps` 轮询会让空闲窗口持续
  耗电，且这类缺陷不会让任何测试变红——必须有"面板关闭时采样函数零调用"的显式断言。
- **T-004 不得改造 `apps/desktop/src/main/resource-probe.ts`。** 它是一次性验收探针（跑完写
  报告退出），与常驻采样器职责不同，混用会让验收探针的语义漂移。
- **T-005 的名字绝不进 key。** 这是前置约束而非事后优化：一旦名字进了 id 或持久化 key，就只能
  靠别名表打补丁（a mature workbench 的现状即为证）。
- **T-006 的诚实口径。** 字节数除以系数冒充 token 数会产出一个无法验证的数字，比没有这个数字
  更糟；未接入 usage 的 Provider 必须表现为"不报用量"而不是 0。
- **T-007 的"等待用户确认"是平台能力，不是我们能单方面保证的。** Electron 的 `Notification`
  没有通用的"不自动消失"开关：macOS 靠通知的 alert 样式（由系统偏好而非应用决定），Windows
  有 `toast` 的 scenario，Linux 取决于通知守护进程。因此这一档必须**如实降级**——尽最大努力
  请求常驻，做不到时不假装做到了。判据沿用既有的 typed 投递：`shown` 之外要能区分出"已按
  请求的模式展示"与"平台把它降级成了普通提示"，不得静默当作成功。
- **T-007 的正文不得为通知另建对话记录。** Agent 最近回复与用户最近提问都已在 Session 投影与
  Activity 时间线里；再存一份会与真相漂移，且漂移时不会有任何测试变红。取不到就略去那一段，
  不填占位文字——"最近的消息：（无）"比不显示这一行更糟。

## 竖切闭合要求（本 Feature 全局）

每个 task 判 done 前，对其交付的每个新符号跑一遍**排除定义文件本身**的调用者检查：
`grep -rn "<symbol>" src | grep -v test`，命中全在定义文件内即为竖切未闭合。
此条来自同仓 f-2248f4yx5/T-019 的教训——那里 12 处变异验证全绿，但七个动作在 `client.ts`
之外零调用者，纯函数被当成了交付。变异测试证明代码被测试用到，不证明能力接到产品上。
