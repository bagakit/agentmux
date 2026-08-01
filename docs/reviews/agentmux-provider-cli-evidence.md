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

**补充（2026-09-01）**：「CLI 不在本机」不等于「无证据」——第一方**源码** checkout 同样可核实，
且比 `--help` 更完整（能读到事件名常量、payload 字段、resume 的实现分支）。本轮盘查发现
`opencode` 与 `kimi-cli` 的完整源码在本机，故 T-009/T-016 从「无证据」升为「可核实」；另外
六个仍不足。逐条见下方《T-009…T-016 的证据面盘查》。

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

八个 Task 里，**只有两个**能凭第一方源码核实，其余六个的落点必须是 deferred 而非实现。
分档判据是本 Feature Goal 的证据优先级（真实 CLI 实测 > 多参考互相印证 > 单一参考）：

| Task | CLI | 第一方源码 | 能力可核实性 |
|---|---|---|---|
| T-009 OpenCode | ❌ | ✅ 本机有完整 checkout | **可核实**（读源码 + 自带文档） |
| T-016 Kimi | ❌ | ✅ 本机有完整 checkout | **可核实**（读源码 + 自带文档） |
| T-015 Copilot | ❌ 不在 PATH | ❌ | **不足**，见下 |
| T-010 Mimo / T-011 Droid / T-012 Devin / T-013 OMP / T-014 Prime | ❌ | ❌ | **不足**：唯一线索是第三方参考语料 |

### Copilot 的「跑过」不等于「能力可核实」

本机确有 `~/.copilot/config.json`（`firstLaunchAt: 2026-07-30`）与 6 份 process 日志，最新到
2026-09-01，内容形如 `CLI server ready (stdio mode, Rust JSON-RPC engine)`——**证明这个 CLI 在
本机真的跑过**，比另外五个强。但把日志全文抓一遍事件名，只捞到一个 `prepared`（`[INFO]
Preparing runtime for graceful shutdown` 里的普通英文词），**没有任何生命周期事件名、resume
旗标或 hook 配置**。

所以它证明的是「存在 stdio JSON-RPC 服务模式」这一个事实，而 Provider 声明需要的是事件名、
handle 字段与 resume 定位器的确切拼法。**「装过」和「能力可核实」是两件事**，日志证得了前者、
证不了后者，中间那段不许用推测补——那正是 grok/cursor 两次踩到的坑（配置侧与投递侧拼法不同，
猜一边就静默失效）。

### 五个只有第三方线索的条目

Mimo / Droid / Devin / OMP / Prime 在本机既无可执行文件、无源码，也无配置或 session 目录
（`~/.mimo`、`~/.config/mimocode`、`~/.factory`、`~/.config/devin`、`~/.omp` 逐个确认不存在）。
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
