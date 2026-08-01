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

复验：`gemini --help`、`gemini hooks --help`

- **有 hooks 子命令**：`gemini hooks migrate` 的作用是 "Migrate hooks from Claude Code to Gemini CLI"
  ——说明 Gemini 的 hook 形状与 Claude 同族。具体事件名需在 T-004 用 Gemini 自身文档核实，
  **不得**照抄 Claude 的事件清单。
- **Resume 语义与 T-004 描述不同**：`-r, --resume` 的 help 原文是
  `Resume a previous session. Use "latest" for most recent or index number (e.g. --resume 5)`
  ——它接受 `latest` 或**序号**，而不是会话 UUID。另有 `--session-id <UUID>`（给新会话指定 UUID）、
  `--session-file <JSON>`、`--list-sessions`、`--delete-session`。
  因此 `gemini --resume <id>` 这一形式**在本机版本上未被证实**；T-004 必须核实到底哪种形式能定位
  一个确定的历史会话，否则 resume 能力不得声明为 session-id locator。
- 其他实测：`--acp`（ACP 模式真实存在）、`-i/--prompt-interactive`（现有 promptDelivery 正确）、
  `--approval-mode default|auto_edit|yolo|plan`、`-y/--yolo`、`--skip-trust`。

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
