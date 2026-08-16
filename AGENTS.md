# 目标

本项目有两个层次的目标，优先级从核心包到编辑器依次递减。

## 1. 通用本地 Agent 核心包

首要目标是在 `packages/core` 实现一个可独立发布、无 UI 依赖、与宿主框架无关的本地 Agent Runtime。它统一管理 Codex、Claude、TraeX、Hermes、Pi 等 Agent CLI 的能力，并且可以通过清晰的 Provider 扩展新 Agent。

核心包向上提供一套类型安全、稳定、与 Agent 无关的 API，负责 Agent 的发现与配置、启动与停止、会话与进程生命周期、输入输出、状态与事件、权限与交互请求等通用能力。任何项目都应该只需安装该包、选择或注册 Provider、传入工作区，就能将本地 Agent CLI 接入自己的 client，不必重复实现进程管理、终端传输和各 Agent 的协议差异。

`packages/core` 不得依赖 Electron、React 或本项目的编辑器实现。新增 Agent 原则上只需新增 Provider，不应迫使 client 改写交互逻辑。

## 2. Agent 原生编辑器

第二个目标是提供一个达到成熟产品水准的 Agent 原生编辑器。它不是另一套 Agent Runtime，而是 `packages/core` 的第一方 client 和完整参考实现，用真实的编辑、终端、会话、工作区、worktree 与多 Agent 协作流程验证核心包的可用性。

编辑器要保持 Agent-first 和 terminal-first：Agent 状态清晰可见，人机交互顺畅，工作区和多会话管理高效，并在信息架构、交互细节和视觉完成度上达到成熟产品水准。所有 Agent 生命周期能力都必须通过 `packages/core` 的公开 API 实现，编辑器不得绕过核心包直接管理 Agent 进程。

# 原则

1. 不保留向后兼容。过时的直接删，别加兼容层、别写migration、别留fallback。
2. 选能满足当前需求的最简单实现。不要预防性抽象，不要多此一举的配置层。
3. 系统分层长。先跑通一个最小的端到端版本，再往上加东西。绝不为了未完成的复杂度拆掉能跑的东西。
4. 组件保持模块化，关注点分离。
5. 优先用成熟的、有人维护的库。没有明确理由别自己重写。
6. 先翻项目里已有的依赖能做什么，再考虑加新包或自己写。别上来就假设库里没有。
7. 架构决策往长了做。不接受"先这样以后再换"的临时方案。
8. 先看成熟产品怎么解决同一个问题，用已验证的模式，别从零发明。
9. 和用户讨论过的内容，要及时更新到需求文档，并尽量用贴近用户原始说法的表述方式。
10. `ctxmux` 是可独立发布和使用的通用 Run Runtime，AgentMux 是它的高级 Client。PTY、进程、
    Run lifecycle、ordered bytes、Replay、Gap、Attachment 与权威 Runtime 事实由 ctxmux 持有；
    Provider、AgentSession、Hook、Permission、Prompt readiness、Agent status 与 semantic resume
    由 AgentMux 持有。不得在任一侧保留第二份实现或把 Level B 暗中降为 Level A。
11. **不能因为我们的流程问题，让原本已经跑通的 Agent 受阻。这是绝对不允许的。**
    任何一处失败在阻断用户之前，必须先分清它是哪一种：

    1. **完全坏了** —— Agent 本身不行了（进程死了、CLI 崩了、工作区没了）。
       这时阻断是诚实的：事情确实做不下去。
    2. **Agent 没坏，是我们的流程坏了** —— Agent 活得好好的，是我们的握手、探测、
       校验或某个中间步骤没走通。**这一类绝不阻断**：放行，同时把状态明确告诉用户。
    3. **完全好的** —— 不打扰。

    第 2 类是这条原则的全部要害，也是最容易被写成第 1 类的一类：一次超时、一个没等到的
    回应、一次读不到的能力探测，代码里往往顺手 `throw`，于是一个健康的 Agent 被我们自己
    的流程杀掉。判据是**「Agent 还能干活吗」，而不是「我们的检查过了吗」**。

    表达方式是**服务窗式的提醒**——像窗口上贴的一条告示：说清楚哪一步没走通、现在按什么
    状态在跑、要恢复完整能力该做什么。它停在旁边，不挡路，也不消失。

    两条边界：不许把第 2 类**静默**放行——用户有权知道自己在降级状态下工作；也不许把
    未知当成好的——分不清是哪一类时，先如实说"分不清"，而不是猜一个然后照着做。

    执行细则（下手前的判定流程、过度防御反面清单、机械执行边界）见 `RED-LINES.md`。

12. **重启恢复是核心不变量，不是附加体验。** 进程重启、应用重装或 Runtime 短暂不可用后，
    之前的 Tab、Tab Group、Region、焦点与分割布局必须先从 durable 状态恢复；其中引用的
    Session 必须自动尝试 reattach/resume。启动快照为空、恢复握手超时、Provider 探测失败、
    旧 lifecycle lease 未及时释放，都属于流程状态，不能把持久化工作面清成空白，也不能把
    健康 Session 静默删除或伪装成新 Session。只有 Core 明确给出 Session retired/unknown 等
    终局事实时，才允许移除对应投影；其他情况保留原 Tab/Region，并在服务窗说清失败步骤、
    当前运行状态和恢复动作。任何涉及布局或 Session 生命周期的改动，都必须有一次“进程重启
    后仍可见且可恢复”的回归验证。

13. **核心能力必须按协议和行为泛化，不能为具体站点或厂商做 walkaround。** Browser、Runtime
    与编辑器的公共机制只能依赖通用事实（例如 URL scheme、导航事件、嵌入 frame、系统应用链接
    交接和用户选择），不得在核心包、主进程、设计 SSOT 或公共测试中预设某个站点、产品名、按钮
    文案或厂商协议。真实站点只能作为黑盒验证输入；若某站点暴露出缺陷，应修复其背后的通用机制，
    并至少用两个不同的通用协议/触发形态证明没有过拟合。历史复盘可以保留触发背景，但不得把
    背景写成实现分支或验收条件。

# 需求落地流程

用户每提出一条需求（无论是新功能、体验抱怨还是技术债），**在动手改代码之前**必须先完成这两件事，
缺一不可：

1. **更新设计文档**。产品交互与行为约束写进 `docs/design/agentmux-desktop-interaction.md`，
   视觉、密度与控件语言写进 `docs/design/agentmux-surface-density.md`。这两份是设计 SSOT，
   用贴近用户原话的表述记录**约束**（"什么必须成立"），不记录实现步骤。
   同一件事只写在一处，另一处引用它。
2. **建或更新 feature-tracker**。用
   `python3 /Users/bytedance/proj/priv/bagakit/bagakit/skills/harness/bagakit-feature-tracker/scripts/feature-tracker.py`
   驱动：新需求若与现有 Feature 的 Closure 不同就 `create-feature`（`--tasks-file` 要
   `schema: "bagakit.feature-task-plan.v1"` + 已 approved 的 review artifact），
   同一 Closure 内则给现有 Feature 追加 task。每个 task 必须有可证伪的 acceptance 与
   verification command。

判 task done 要过两把尺，缺任一把都不算交付：

- **变异测试**：改坏实现，确认对应测试变红。证明"这行代码在被测试用到"。
- **零调用者检查**：`grep -rn "<symbol>" src | grep -v test`，**并排除定义它的那个文件本身**。
  证明"这条能力接到了产品上"。命中全在定义文件内即为竖切未闭合，如实标 blocked。

变异全绿不能替代零调用者检查——纯函数被纯函数的测试覆盖，那证明不了能力交付了。

扫描式的契约测试（从样式表、源码里反推事实的那种）还有第三种白绿：**扫到空内容**。
所以这类测试必须自己断言扫描有收获（`expect(found.size).toBeGreaterThan(0)`），并且
从来源反推而不是维护一份手写清单——手写清单会和来源一起漂移，漂移时它自己不会响。
破例要按选择器点名，不按值点名（放行 `30px` 这个值，等于全表哪里都能写 `30px`）。

扫到空内容最隐蔽的一支是 **`indexOf` 取锚点取空了**：`s.slice(s.indexOf('<Foo'), …)` 里起锚点
一旦在源码里不存在，`indexOf` 返回 `-1`，`slice` 把它换算到末尾之后，切出来是**空串**——
之后每一条 `not.toContain` 都恒真。类名换掉、JSX 挪走都会造成这个，而 `tsc` 干净、测试全绿、
review 看不出（锚点长得像还在的样子）。守护：`apps/desktop/test/sliced-scan-surface-not-empty.test.ts`
逐个核对锚点是否真的出现在它所读的源文件里。自己写这种断言时，把两端都判一次
（`expect(start).toBeGreaterThan(-1)`），并再判一句「切出来的这段确实是那一段」。

同一件事在**运行期集合**上的那一支：**谓词遍历了一个空集合**。`[].every(p)` 是 `true`，
`[].some(p)` 是 `false`——于是 `expect(xs.every(p)).toBe(true)` 与 `expect(xs.some(p)).toBe(false)`
在生产代码开始「什么都不返回」时照样绿，而「什么都不返回」通常比被测的那个缺陷严重得多。
反过来 `every→false` / `some→true` 对空集合当场红，不需要守。守护：
`apps/desktop/test/vacuous-on-empty-predicate.test.ts`，要求同一个 `it()` 里有一句非空证明；
最省事的写法是**把整个集合钉死**（`toEqual([...])`）而不是写 `every`。豁免走紧贴上一行的
`// vacuous-ok:` 注释，不设集中清单——清单会和代码漂开，而且它一存在，下一个人遇到误报的
第一反应就是往里加一行，守卫从此开始溶解。

这一族的变异必须是**块级**的：只在 `.every()` 那个调用点喂空集合什么都证明不了（`.every([])`
按定义就恒真）。正确的做法是把那个 `it()` 里对该集合的每一次读取都改成空，模拟「生产代码返回了
空」，再看它红不红。
