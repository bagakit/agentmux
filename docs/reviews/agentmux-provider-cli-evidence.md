# Provider CLI 能力核实（本机实测，2026-09-01）

> 本文件是 f-23z8fgsw3 的**证据基线**：每一条都来自本机真实 CLI 的 `--help` / `inspect` 输出或
> 该 CLI 自带的官方文档，可复验。**未在此处核实的能力，Provider 一律不声明**（计划北极星）。
>
> 复验命令写在每节标题下。`MISSING` 表示本机没有该可执行文件——它的能力**不得**凭推测声明。

## 本机可执行文件盘点

复验：`for c in grok gemini pi claude codex cursor-agent hermes agy traex opencode mimo droid devin omp prime copilot kimi; do command -v $c; done`

| CLI | 本机 | 对应 Task |
|---|---|---|
| `grok` | ✅ `~/.local/bin/grok` (1.0.13) | T-003 |
| `gemini` | ✅ `~/.local/npm/bin/gemini` | T-004 |
| `claude` | ✅ | T-006 |
| `hermes` | ✅ | T-007 |
| `cursor-agent` | ✅ | T-008 |
| `codex` / `agy` / `traex` | ✅ | 已接入 |
| `pi` | ❌ MISSING | T-005 |
| `opencode` `mimo` `droid` `devin` `omp` `prime` `copilot` `kimi` | ❌ MISSING | T-009…T-016 |

**影响**：T-005 与 T-009…T-016 的能力无法在本机用真实 CLI 核实。这些 Task 必须显式区分
「有证据」与「无证据」，无证据的能力保持未声明，或按计划记为 deferred，**绝不允许**为了让测试
变绿而编造 argv / 事件名 / handle 字段。

**补充（2026-09-01）**：「CLI 不在本机」不等于「无证据」——第一方**源码 / 发行物二进制 /
可加载的原生 runtime** 同样可核实，且比 `--help` 更完整（能读到事件名常量、payload 字段、
resume 的实现分支）。本轮盘查发现 `opencode` 与 `kimi-cli` 的完整源码在本机，故 T-009/T-016
从「无证据」升为「可核实」。

**再更正（2026-09-01，晚于上一段）**：上一段末尾曾写「另外六个仍不足」，该结论已被推翻——
其中 **T-011 Droid、T-015 Copilot 后续也凭第一方证据实现了**（Droid 读发行物二进制里的 zod
事件枚举，Copilot 加载其原生 runtime 解析器实测），故连同 T-016 Kimi 共**三个已实现**；
T-009 OpenCode 证据齐全但接入路径卡在一个架构决策上，属**待决策**而非证据不足；真正仍
**证据不足**的只剩 T-010/T-012/T-013/T-014 四个。逐条见下方《T-009…T-016 的证据面盘查》。

---

## Grok（T-003）

复验：`grok --help`、`grok inspect`、`~/.grok/docs/user-guide/10-hooks.md`

### 三处容易踩空的实测事实

1. **grok 确实有 hooks，但 `--help` 里一个字都不提。** `grok --help | grep -ic hook` = 0，
   而 `grok inspect` 报 `Hooks (18)`。只看 `--help` 会误判成 `hookStrategy: none`。
2. **配置键是 PascalCase，wire 上的事件值是 snake_case——这是两个不同的面，不是矛盾。**
   写进 `~/.grok/hooks/*.json` 的键是 `PreToolUse`；grok 投递到 stdin 的负载里是
   `"hookEventName": "pre_tool_use"`（官方文档 10-hooks.md:409 明确写 "the event value is `\"stop\"`"）。
   **归一化表只需要 wire 值**（那才是 normalizeHook 真正收到的东西）；PascalCase 只属于 installer。
   T-003 的验收同时说「snake_case 事件」与「hookEventName/sessionId」，两者都成立，无需改计划。
3. **handle 与 tool 输出字段都是 camelCase**：`sessionId`（不是 `session_id`）、
   `toolResult`（不是 Claude 的 `tool_response`，10-hooks.md 明确列为移植差异）。

### Hook 事件全集（10-hooks.md:88-104）

`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、
`PermissionDenied`、`Stop`、`StopFailure`、`StopCancelled`、`Notification`、`SubagentStart`、
`SubagentStop`、`PreCompact`、`PostCompact`、`SessionEnd`。

阻断性（可 deny/block）：`UserPromptSubmit`、`PreToolUse`、`Stop`、`SubagentStop`。
其余为 observe-only。

### 收尾事件的三分与「取代」语义（10-hooks.md:96-98, 310, 314-316, 326）

这是 grok 最容易接错、且错了不会报错只会永久卡住的一处，逐字引证：

- `StopCancelled`：**"Runs instead of `Stop` when a turn ends without completing"**——用户中断
  （Ctrl+C / Esc / 客户端 stop）、拒绝授权、`--max-turns` 上限、no-progress 兜底。
- `StopFailure`：API 错误时同样**取代** `Stop`。
- `Stop` 自己的表述里就写明："An agent turn ends on a genuine completion
  (an interrupt fires `StopCancelled` instead)"。

结论：一个 turn **至多报三者之一**（"A turn reports at most one of the three"）。因此把 done
只绑在 `Stop` 上，用户按下中断后不会有任何后续事件把状态救回来——Agent 永久停在 working。
三条必须同时映射为收尾。

另有一条只对**装了阻断式 `Stop` gate** 的宿主成立的陷阱（:328）：`Stop` 作为 gate 被 block 时
会在每一轮续跑时重复触发，而被动观察者分不清「续跑那次」与「最终那次」，于是"a UI gated on
`Stop` alone shows a false idle"。AgentMux 不受此影响，因为它声明 `permission: 'observe'`
且 hook 子进程从不往 stdout 写 decision、也从不 exit 2（见 `packages/core/bin/agentmux-hook.js`），
grok 的 `Stop` 因此只会以「报告」身份触发一次。这个前提由测试钉住——一旦哪天 hook 子进程开始
应答 decision，false-idle 就会出现，而那时才发现就太晚了。

### 公共负载字段（10-hooks.md:237-255）

每个事件都带：`hookEventName`、`sessionId`、`cwd`、`workspaceRoot`、`timestamp`、
`permissionMode`（`default` / `auto` / `plan` / `bypassPermissions`）、`promptId`（session 级事件缺席）。
`PreToolUse` 另带 `toolName`、`toolInput`、`toolUseId`、`toolInputTruncated`。

### Hook 安装位置（10-hooks.md:63-74）

`~/.grok/hooks/*.json`（全局，始终受信）、`<project>/.grok/hooks/*.json`（需 trust）、
`~/.grok/config.toml`。另外 grok **主动读** `~/.claude/settings.json` 与 `~/.cursor/hooks.json`
做兼容——因此安装时必须只写自有 marker，不能把 AgentMux 的条目混进用户的 Claude 配置。

### Resume（`grok --help`）

`-r, --resume [<SESSION_ID_OR_TITLE>]`：按 ID 或标题恢复，省略则最近一条。UUID 形状一律当 ID。
`-s, --session-id <SESSION_ID>` 是**给新会话指定 UUID**，不能用来 resume（help 原文明确）。
故 native resume 的 locator 是 session-id，argv 为 `grok --resume <session-id>`。

### Permission / posture（`grok --help`）

`--always-approve`（自动批准全部工具）、`--allow <RULE>` / `--deny <RULE>`、`--sandbox <PROFILE>`。
本机 `config.toml` 有 `[ui] permission_mode = "always-approve"`。

---

## Gemini（T-004）

复验：`gemini --help`、`gemini hooks --help`、`gemini --version`（本机 0.55.1）、
以及**读实现**：`npm pack @google/gemini-cli@0.57.0` 后在 bundle 里读 `findSession`／`resolveSession`
（本机 0.55.1 的 `chunk-4PTN4HDB.js` 与 0.57.0 逐字一致）。

- **有 hooks 子命令**：`gemini hooks migrate` 的作用是 "Migrate hooks from Claude Code to Gemini CLI"
  ——说明 Gemini 的 hook 形状与 Claude 同族。具体事件名需在 T-004 用 Gemini 自身文档核实，
  **不得**照抄 Claude 的事件清单。
  配置面：`~/.gemini/settings.json` 有真实的 `hooks` 键。注意它与 Antigravity 的
  `~/.gemini/config/hooks.json` 是**不同文件**（见 `createAntigravityManagedHookPlan`），
  同在 `~/.gemini` 下但互不覆盖——T-004 的「不把 Antigravity 的共享配置误当成 Gemini 事件」成立且可满足。
- **Resume 接受 UUID，`--help` 少说了**：`-r, --resume` 的 help 只写
  `Use "latest" for most recent or index number (e.g. --resume 5)`，据此会误判成「只能按序号」。
  但实现里的 `findSession(identifier)` 明确是 **UUID 优先**：
  先 `sortedSessions.find(s => s.id === trimmedIdentifier)`，命中即返回；**只有**在 UUID 匹配不上时
  才回退到 1-based 序号。其自身 doc comment 也写 `--resume {number}, --resume {uuid}, or --resume latest`。
  故 `gemini --resume <session-uuid>` 是真实且稳定的定位方式，T-004 的 session-id locator 描述**正确**。

  这条与 grok 的「hooks 不在 --help 里」是同一类陷阱：**只读 `--help` 会漏掉真实能力**。
  凡 `--help` 与参考实现冲突，必须读实现或实测再判，不能拿 help 文本当能力上限。
  （反面：若当真只按序号实现，序号是位置性的——删一条其余全移位——存进去的 5 之后可能恢复到
  另一段对话，正是 Prime Directive 点名要避免的「把用户上下文接到错误会话上」。）
- **本机认证已失效**（与能力判定无关，但影响端到端实测）：`gemini --list-sessions` 报
  `IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals`，
  官方指向 Antigravity。因此 Gemini 的 resume/hook 只能靠读实现 + 单测证明，**不能**声称做过真实会话恢复。
- 其他实测：`--acp`（ACP 模式真实存在）、`-i/--prompt-interactive`（现有 promptDelivery 正确）、
  `--approval-mode default|auto_edit|yolo|plan`、`-y/--yolo`、`--skip-trust`、`--session-id <UUID>`
  （**给新会话指定** UUID，不是恢复）、`--session-file <JSON>`、`--list-sessions`、`--delete-session`。

---

## T-009…T-016 的证据面盘查（2026-09-01）

复验：`ls ~/proj/github | grep -iE 'opencode|kimi'`、`ls ~/.copilot`、`command -v <每个>`

> **本节结论已随后续接入更新（2026-09-01）。** 最初这里写「八个 Task 里只有两个能凭第一方源码
> 核实，其余六个必须落 deferred」——那句话在写下时成立，但**已被后续实现推翻**。Droid（T-011）
> 与 Copilot（T-015）后来各自找到了第一方证据面（发行物二进制里的 zod 事件枚举 / 可加载的原生
> runtime 解析器）并完成实现，与 Kimi（T-016）一起共**三个已实现**且已进 `BuiltInAgentProviderId`
> union（`packages/core/src/types.ts:4-16`）与 registry（`packages/core/src/providers/index.ts:36-37`）。
> 保留原判断的演进轨迹而不抹掉，是因为「当时只有两个可核实」本身是一条真实记录，它解释了后面
> 三条为什么各写了一段「落地时才读出来的非显然事实」。
>
> 分档判据仍是本 Feature Goal 的证据优先级（真实 CLI 实测 > 第一方源码/二进制/runtime 实测 >
> 多参考互相印证 > 单一参考）。**当前**落点：

| Task | CLI 在本机 | 第一方证据 | 当前状态 | 依据 |
|---|---|---|---|---|
| T-009 OpenCode | ❌ | ✅ 本机有完整 checkout + npm 包类型 | **待决策**（证据齐全，接入路径待用户拍板） | 见下 |
| T-011 Droid | ❌ 不在 PATH | ✅ 发行物二进制（`@factory/cli-darwin-arm64@0.208.2` 的 `bin/droid`）里的 zod 事件枚举 | **已实现** | `packages/core/src/providers/droid.ts`；commit `d4613b8`、`1c6c17f` |
| T-015 Copilot | ❌ 不在 PATH | ✅ 加载其原生 runtime（`prebuilds/<platform>/runtime.node`）实测事件与负载 | **已实现** | `packages/core/src/providers/copilot.ts`；commit `e7cb617` |
| T-016 Kimi | ❌ | ✅ 本机有完整 checkout（`kimi-cli` 1.49.0） | **已实现**，见下 | `packages/core/src/providers/kimi.ts`；commit `c7db679`、`391f6d1`、`d2419fb`、`a733c6f` |
| T-010 Mimo / T-012 Devin / T-013 OMP / T-014 Prime | ❌ | ❌ | **证据不足**（deferred）：唯一线索是第三方参考语料 | 见《四个只有第三方线索的条目》 |

### OpenCode（T-009）：证据齐全，卡在一个架构决策上——待决策，不是证据不足

**这一条必须与「证据不足」分清。** OpenCode 的能力证据是**齐全**的：本机有完整 checkout，且它的
两条接入通路都能从第一方 npm 包的类型定义逐字读到。它没实现，不是因为读不到能力，而是因为**接进
AgentMux 需要在两条形态完全不同的通路里选一条，而这个选择是架构决策，已上抛给用户拍板**。

两条通路（依据来自第一方包类型）：

1. **JS/TS 插件**：`@opencode-ai/plugin`（1.18.25）的 `Hooks` 接口——所有 hook 都是
   `(input, output) => Promise<void>` 的函数，靠**就地改 `output` 对象**生效，由 CLI **同进程**
   加载插件模块。它**没有**任何「往配置文件写一条命令、CLI 在事件发生时执行它、用 stdin/stdout
   交换 JSON」的形态；而 AgentMux 整个 managed-hook 架构恰恰**建立在后者之上**。依据：
   `@opencode-ai/plugin` 的 `dist/index.d.ts:173` 起的 `Hooks` 接口。
2. **SSE 长连接**：`@opencode-ai/sdk` 的 `event.subscribe` 是一条 SSE 事件流，事件名如
   `session.idle` / `session.compacted` / `permission.updated` / `message.part.updated`。它与 hook
   是**不同的接入类型**——需要 Core 新增「起服务 / 连接生命周期 / 重连 / 与 ctxmux Run 生命周期
   对齐」一整套机制。依据：`@opencode-ai/sdk` 的 `dist/gen/sdk.gen.d.ts:375` 的 `subscribe`。

**待决策的内容**：选 JS 插件（要把 AgentMux 的 hook 模型扩出一条「同进程回调」形态）还是选 SSE
（要给 Core 加一条长连接事件通路）。**决策人是用户**——这是产品/架构取舍，不是取证工作能替代的。
出处：feature-tracker 的 T-009，`status: blocked`，blocked 原因逐字记录了上述两条通路与
「选 JS 插件还是 SSE 属架构决策，待用户定夺」（`.bagakit/feature-tracker/features/f-23z8fgsw3/tasks.json`
的 T-009 blocked.reason，非 git 跟踪）。

因此它的正确落点是**待决策（decision-pending）**：证据已备齐、实现被一个明确的、指名到人的决策
挡住。把它写成「证据不足」会误导下一个读者去补证据——而证据不缺；缺的是一次拍板。

### Droid（T-011）落地时读出来的三处非显然事实

复验：读发行物二进制 `@factory/cli-darwin-arm64@0.208.2` 的 `bin/droid`（本机下载）。
`command -v droid` 失败——没有运行时证据，下面每条都由二进制里内嵌的 zod schema 支撑，实现里
（`packages/core/src/providers/droid.ts`）也只声明这些。三处非显然事实各自带守卫，改坏任一条即红：

1. **`hooks.json` 的顶层键就是事件名，不套 `hooks:` 包装层**（zod：`object({ PreToolUse:
   array(...).optional(), …, hooksDisabled: boolean().optional() })`）。照 Claude 的形状多包一层
   会让整份配置被 zod 判为无效——不是少响几个事件，是一个都不响。因此合并策略必须是根层那一支
   `json-root-managed-events`；用 `json-managed-events` 是数据丢失：它去 `hooks` 下找桶找不到，
   于是既不清扫旧条目、又把根级事件键盖在用户同名桶上，用户手写的 `PreToolUse` 审计 hook 会在
   下次启动后消失（`renderMergedHookContent` 实测如此，commit `1c6c17f`）。
2. **hook 负载里没有工具关联 id**：`toolCallId` 走派发函数的第四个内部 context 参数、不进负载；
   二进制里的 `tool_call_id`/`tool_use_id` 分别属于 LLM 消息格式与 OTEL 属性，不是 hook 负载键。
   所以一次调用在时间轴上是两行而不是一行——如实声明 `replyCorrelation: none`，不编一个 id 键
   让关联静默错配。与 Copilot 同一个上游损失。
3. **只有 `SubagentStop` 没有对应的 `SubagentStart`**（zod 枚举里就这九个），故**不声明**
   `subagentTracking`——子代理在途记账要求 start/stop 成对，只装 stop 会让计数变成负数并压制主
   Agent 的收尾（它会一直等一个永远等不到的减一）。与 Hermes 同一判断。

另外：`SessionEnd` 刻意不装（它是**会话**终结而非轮次事实，判「这一轮结束」靠 `Stop`，会话终结
由 PTY 事实回答——与 Gemini 对它自己的 `SessionEnd` 同一既定判断）；usage 不声明（收尾负载 `Stop`
里只有 `tool_execution_count`/`elapsed_time`，没有任何 token 字段）；`FACTORY_HOME_OVERRIDE ?? HOME`
必须尊重，忽略它会写一份该 CLI 永不读的配置。四处变异各自打红（套 hooks 外层杀 3、忽略 HOME 覆盖
杀 1、装 SessionEnd 杀 2、编造 stop-only 记账杀 3），见 commit `d4613b8` 与 `test/providers/droid.test.ts`。

### Kimi（T-016）落地时读出来的三处非显然事实

复验：读 `~/proj/github/kimi-cli`（`1.49.0`）。`command -v kimi` 失败——**没有**任何运行时证据，
下面每条都只由源码支撑，实现里也只声明这些。

1. **`expectedProcess` 必须是 `Kimi Code`，不是 `kimi`。** CLI 启动时调
   `init_process_name("Kimi Code")`（`cli/__init__.py`），底层走 `setproctitle`（硬依赖）。
   AgentMux 的 `readySignal: foreground-process` 是拿 `expectedProcess` 去比对**操作系统进程名**的，
   所以按"可执行文件名即进程名"这个形状去推，会得到一个永远等不到就绪的 Provider——而且不会报错，
   只会一直显示在启动中。这是本仓第十一个内置 Provider 里**唯一**一个两者不相等的条目。
2. **首个 prompt 送不到，只能起来之后再提交。** 这条被复核推翻过一次，值得记全：`-p/--prompt`
   （含别名 `-c/--command`）在 shell UI 里走 `Shell.run(command=...)`，而那条路是
   `# run single command and exit`，跑完就返回——不是一个活着的交互 PTY。**且没有** Gemini
   `--prompt-interactive` 那样"带 prompt 启动且保持交互"的旗标：把 `cli/__init__.py` 的整份选项
   清单读完，prompt 只有上面那一个入口。`prefill_text` 看着像第三条路，其实不是——它只由 `Reload`
   异常传入，并且在交互循环**内部**才应用，任何命令行旗标都到不了它。

   所以 Kimi 的 `promptDelivery` 是 `post-launch-only`，而**不是** `positional-argv`。
   最初的实现声明成 positional-argv 再在 `buildArgs` 里把 prompt 丢掉，并在注释里说"改在 PTY 里
   键入"——那条 PTY 键入路径在启动期根本不存在（`planPromptInput` 只被 `submitAgentPrompt` 调用，
   initial-composer 兜底要求 `terminalHandshake`+`terminalPromptRender`，只有 codex 声明）。
   净效果是用户的原话只落进 timeline、永不进入进程，而界面上一切正常。现在两个出口
   （`buildLaunch` / `buildResumeLaunch`）都会当场拒绝并报 `AGENT_LAUNCH_PROMPT_UNSUPPORTED`。

   **修正一处此前写错的收尾说法。** 这里曾写「空 prompt 照常启动：Kimi 空手起来完全可用」，那句话
   当时是**假的**，而且它掩盖的是同一轮修复自己制造的回归：运行时引导默认注入，
   `composeAgentLaunchPrompt(undefined, true)` 实测 528 字符、恒非空，于是"拒绝一切非空启动 prompt"
   等于拒绝**每一次**默认启动——一个根本起不来的 Provider。当时的用例用手写的 `prompt: ''` 绕过了
   组装器，所以全绿。（教训见下面第二条。）

   真正的落点是**分流加补送**，收口在一个共用纯函数 `splitLaunchPromptByDelivery`
   （`agent-provider.ts`）：`post-launch-only` 的 Provider 拿到 `atLaunch: ''`，整份文本落到
   `deferred`；两条生命周期路径（`createAgent` / `resumeAgentRun`）都必须把 `deferred` 交给
   `deliverPostLaunchPrompt`，在进程起来之后按一条普通 turn 经 `submitInputPlan` 真的键入
   （single-phase 不需要 composer readiness 纪元，故这条路对它是通的）。送达失败发 `agent-error`
   而不抛——进程已经起来了，抛出去会让调用方回滚一个健康的 Run；但也绝不许静默，静默就等于把
   丢失从 argv 挪到了调用点。

   **教训**：「声明一个能力，再在实现里悄悄不做」比「如实声明做不到」坏得多——后者是一次响亮的
   失败，前者是一次静默的数据丢失。而当时那条注释还替这个丢失作了担保，让读者以为有条替代路径。

   **第二条教训（来自上面那次回归）**：给一个「做不到」的取值加拒绝时，必须问「拒绝的判据落在
   哪个值上」。这里的判据落在**组装之后**的文本上，而组装器几乎总是产出非空结果，于是拒绝的边界
   从"用户带了 prompt"悄悄变成了"启动"。而验证它的用例用手写的 `prompt: ''` 绕过组装器，正是
   「绕过真实构造器的 fixture 会让测试对整类回归失明」——现在那条用例改为**先跑真的
   `composeAgentLaunchPrompt`、断言它非空，再断言分流结果**，删掉分流即红。
3. **hook 是真的，但配置面是 TOML，故记 `unmanaged` 而非 `explicit-managed`。**
   `[[hooks]]` 写在 `~/.kimi/config.toml`，而那是用户主配置（model / credentials / theme 都在里面）。
   本仓四种 merge 策略（`json-owned-key` / `json-managed-events` / `yaml-managed-events` /
   `json-managed-approvals`）没有一种能编辑 TOML，Core 也没有 TOML 解析器。整份覆盖是数据损坏而不是
   安装；声明成 managed 就等于"说装了其实没装"。

另外两条"不声明"：`usage` 不声明（`Stop`/`StopFailure` 负载里没有任何 token 字段，也不报 transcript
路径）；`acpStrategy: none`（`kimi acp` 子命令与 `agent-client-protocol` 依赖都真实存在，但 AgentMux
侧的 ACP 适配没接——**能力存在 ≠ 我们接上了**，如实记未接）。

#### 一条无法在本仓弥补的固有限制：中断与步数上限不发任何收尾事件

`Stop` + `StopFailure` 看着像覆盖了全部收尾，其实没有。两条路一个 hook 都不发：

- **用户中断（Ctrl-C / Esc）**：`run()` 的 `except asyncio.CancelledError`（`soul/kimisoul.py:791`）
  重新抛出，而 `Stop` 的 trigger（`:742`）在它**之后**，于是被跳过。`StopFailure` 在 `_agent_loop`
  的 `except Exception` 里，而 `CancelledError` 自 py3.8 起是 `BaseException`——抓不到。
- **`MaxStepsReached`**：raise 点在那个 `except Exception` 的 `try` **之上**（`:788` 接住后重抛），
  同样绕过 `StopFailure`。

关键在于中断后 **Kimi 进程仍然活着**（停在 composer 上，SIGINT 只取消当前 turn），所以连"进程退出"
这个兜底事实都没有。后果：用户中断或撞上步数上限后，这个 Agent 会继续显示运行中。

**但不是"永远"**——这条要说准：本仓有一条与 Provider 无关的通用衰减（`agent-status-freshness.ts`），
`working` 无新证据 15 分钟后落到 `unknown`（诚实的"不知道"，不伪造 done/error），desktop 侧经
`agent-status-decay.ts` 接线。所以真实的失效形态是**最多 15 分钟的错误"运行中"**，而不是永久卡死。
这也正是那条衰减存在的理由：它兜的就是"该发收尾却没发"这一类，无需为 Kimi 单独加机制。

与 grok 那次的区别必须认清：grok 是**发了**另一个事件（`StopCancelled`）而我们没接，补上映射即可；
Kimi 是真的什么都不发——`config.py:5-19` 的 13 个事件里没有任何 cancel 类。所以正确的做法是如实
记录这个限制并靠既有的通用衰减兜底，**不是**发明一个收尾事件去填。

而「中断」这个操作**今天就已经暴露给用户了**，不是将来才有的假设：composer 在 Agent 处于运行中时
就渲染那颗中断当前回合的按钮，它只按「是否在运行中」判，**不按 Provider 判**
（`AgentComposer.tsx` 的 `primaryAction === 'stop'` 分支），一路到
`runtime-controller.ts` 的 `interrupt()` → `client.signalAgent(…, 'SIGINT')`。于是一次用户主动中断
之后，界面会继续显示运行中直到 15 分钟的衰减兜住——**对一次用户自己刚点下的操作来说，这个延迟明显
过长**（用户知道自己中断了，界面却还在转）。这是本条限制在 Kimi 上真实的用户可见后果，落点是
Provider 的固有能力缺口而非本仓可修的缺陷；把它写成「若将来要暴露中断」会低估现状，而低估和高估
一样会误导下一个读者的判断。

事件名（PascalCase）与负载键（`hook_event_name` / `session_id`）与 Claude 一族逐字同形，已被既有方言
表覆盖，故**没有**往 `agent-hook-event.ts` 加任何条目。

### Copilot（T-015）：从「跑过 ≠ 能力可核实」到已实现

> **结论已更新（2026-09-01）。** 此前本节标题是「Copilot 的『跑过』不等于『能力可核实』」，
> 落点是 deferred。那个判断在**当时给定的证据面（进程日志）下是对的**，下面整段原始论证予以保留；
> 被推翻的只是「因此不可核实、只能 deferred」这个结论——后来找到了一条更强的证据面（直接加载它
> 自己的原生 runtime 解析器），据此 Copilot **已实现**（`packages/core/src/providers/copilot.ts`，
> commit `e7cb617`），并已进 union 与 registry。**此前记录「不足」，实测为「可实现」，依据是那条
> runtime 证据面，而非日志。** 保留原论证是因为它本身是一条有价值的记录：它精确说明了「日志能证
> 什么、证不了什么」，也解释了为什么最终没有靠日志、而是靠 runtime 去落地。

**原始论证（基于进程日志，结论已被上面更新）：**

本机确有 `~/.copilot/config.json`（`firstLaunchAt: 2026-07-30`）与 6 份 process 日志，最新到
2026-09-01，内容形如 `CLI server ready (stdio mode, Rust JSON-RPC engine)`——**证明这个 CLI 在
本机真的跑过**，比另外五个强。但把日志全文抓一遍事件名，只捞到一个 `prepared`（`[INFO]
Preparing runtime for graceful shutdown` 里的普通英文词），**没有任何生命周期事件名、resume
旗标或 hook 配置**。

所以它证明的是「存在 stdio JSON-RPC 服务模式」这一个事实，而 Provider 声明需要的是事件名、
handle 字段与 resume 定位器的确切拼法。**「装过」和「能力可核实」是两件事**，日志证得了前者、
证不了后者，中间那段不许用推测补——那正是 grok/cursor 两次踩到的坑（配置侧与投递侧拼法不同，
猜一边就静默失效）。

**后来怎么补上的（commit `e7cb617`）：** 不再依赖日志，而是把它的原生 runtime
（`prebuilds/<platform>/runtime.node`）直接加载进 node，真的喂配置、真的让它 spawn 捕获脚本、
真的读回每个事件的 stdin 负载。这条路证到了日志证不了的东西，且暴露出三处「最自然的猜法」会静默
失效之处，各由 `test/providers/copilot.test.ts` 逐字钉住：

- 事件名是 `userPromptSubmitted` 不是 `userPromptSubmit`（Claude 一族拼法）——该解析器对不认识的
  事件名**静默丢弃**，猜错了配置照样加载成功、那个桶永远不响。
- `matcher` 是**正则**不是 glob：`'*'` 被当无效正则拒掉（整桶失效），`'.*'` 才对。与 droid 恰好
  相反（droid 的 `'*'` 是合法 glob），两家不能互抄这个字面量。
- 字段名是 `timeoutSec` 不是 `timeout`，写错会被剥掉然后静默用它自己的默认超时。

如实**不声明**的能力（`copilot.ts:169-186`）：`acpStrategy: none`（`--acp` 真存在但 AgentMux 没有
adapter 那一端）；`replyCorrelation: none`（`preToolUse`/`postToolUse` 两端拿不到同一个工具 id，
一次调用在时间轴上是两行——与 droid 同一上游损失）；usage 不声明（收尾负载 `agentStop` 里只有
`stopReason`/`transcriptPath`，没有任何 token 字段）。

### 四个只有第三方线索的条目

> **更正（2026-09-01）：此前本节标题是「五个只有第三方线索的条目」，Droid 曾在其列。** Droid 后来
> 找到了第一方证据面（发行物二进制 `@factory/cli-darwin-arm64@0.208.2` 的 `bin/droid` 内嵌 zod
> 事件枚举）并完成实现（`packages/core/src/providers/droid.ts`，commit `d4613b8`/`1c6c17f`），
> 故从本列移出。**此前记录 Droid「无源码、单一参考、不足」，实测为「发行物二进制可核实、已实现」，
> 依据是那份二进制里的 zod 枚举。** 现存四个仍然只有第三方线索。

Mimo / Devin / OMP / Prime 在本机既无可执行文件、无源码，也无配置或 session 目录
（`~/.mimo`、`~/.config/devin`、`~/.omp` 等逐个确认不存在）。
它们唯一的线索来自第三方参考语料对启动命令与配置路径的描述——按证据优先级属**单一参考**，
且是宿主专有产物，不足以支撑能力声明。计划自己的规定就是这个落点：

- `agentmux-provider-parity-plan.md:14`「能力未核实就保持未声明」
- `agentmux-provider-parity-plan.md:18`「launch-only 或宿主专属 wrapper 不盲目复制，必须记录为
  明确的 deferred/non-goal」
- `agentmux-provider-parity-plan.md:35`「'对照语料里有但暂不纳入'的条目只允许作为审计策略记录，
  不能伪装成已实现 Provider」

（顺带更正一处措辞：计划里用的词是 `deferred` 与 `non-goal`，**没有** `not-comparable` 这个
分类——T-017 的 acceptance 提到三分类时按前两个加 implemented 理解。）

---

## Cursor（T-008）

复验：`cursor-agent --help`

- **Resume 存在但形状特殊**：`--resume [chatId]`（"Select a session to resume"，默认 false）
  与 `--continue`。是否能用一个确定的 chatId 无交互地恢复，需 T-008 核实；不确定就保持
  `providerResume: false`（现状），不要为了填满能力矩阵而声明。
- Permission/posture 实测：`-f/--force`、`--yolo`、`--auto-review`、
  `--sandbox enabled|disabled`、`--mode plan|ask`、`--approve-mcps`。
- grok 的文档提到 `~/.cursor/hooks.json` 存在（grok 读它做兼容），说明 Cursor 有 hook 配置面；
  其事件名需用 Cursor 自身证据核实。

---

## 与 T-002 的关系

T-002 已把事件名的**字段读取**（`hook_event_name` / `hookEventName` / `eventName` 三拼法同权）
和**方言映射**收口到 `packages/core/src/agent-hook-event.ts`。上面 grok 的实测正好验证了这个分层：

- 读 `hookEventName` 这一半，T-002 已经做对了（grok 用的正是这个键）。
- grok 的 wire 值（`pre_tool_use` / `post_tool_use` / `stop` / …）目前**全部 UNMAPPED**——
  实测确认。落点是 T-003：往 `AGENT_HOOK_LIFECYCLE_DIALECT` 补 grok 的 snake_case 值。
  在补之前，grok 的事件会如实落在「认不出」（`lifecycleEvent` 缺席、原始名进诊断、
  语义仍由 rules 给出），**不会**被伪造成 working/done——这正是 T-002 要的失败模式。
