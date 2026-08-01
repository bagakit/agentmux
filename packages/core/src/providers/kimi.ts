import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * Kimi 写进 `~/.kimi/config.toml` 的事件名（`[[hooks]]` 数组，docs/en/customization/hooks.md:43）。
 *
 * 拼法是 PascalCase，与 Claude 一族**逐字相同**（`PreToolUse`/`PostToolUse`/`Stop`/…），负载键则是
 * snake_case 的 `hook_event_name`——两者都已被既有的 `PASCAL_CASE_HOOK_DIALECT` 与
 * `HOOK_EVENT_NAME_PAYLOAD_KEYS` 覆盖，所以本 Provider **不必**往方言表加任何条目。这是"同名同结构"
 * 的合法复用（见 agent-hook-event.ts 里"键允许在 Provider 之间重复"那段），不是偷懒：Kimi 的
 * `PreToolUse` 在结构上确实就是一次工具调用的事前。
 *
 * 这份清单是**给手工接线的用户看的**（见下面 hookStrategy 为何是 unmanaged），也是 rules 的取值域。
 * Kimi 另有 `SessionEnd`/`PreCompact`/`PostCompact`/`Notification` 四个（config.py:5-19 共 13 个），
 * Core 今天没有任何判断需要它们，故不列。
 */
export const KIMI_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure'
] as const

export const KIMI_HOOKS: AgentNativeHookSpecification = {
  rules: [
    // 两种收尾都算 done：正常完成与失败收尾。少任何一条都会卡在 working。Kimi 没有第三种
    // （grok 的 `stop_cancelled` 在这里不存在，别照抄）。
    //
    // 但**这两条并没有覆盖全部收尾**——这是 Kimi 的固有限制，不是这里可以补的，也别试着发明一个
    // 事件名去填：中断（Ctrl-C / Esc）与 `MaxStepsReached` 两条路**一个 hook 都不发**。
    // `except asyncio.CancelledError`（soul/kimisoul.py:791）与 `except MaxStepsReached`（:788）
    // 都在 `Stop` 的 trigger（:742）**之前**重新抛出；`StopFailure` 在 `_agent_loop` 的
    // `except Exception` 里，而 `CancelledError` 自 py3.8 起是 `BaseException`、抓不到，
    // `MaxStepsReached` 的 raise 点也在那个 try 之上。且中断后 Kimi 进程仍活在 composer 上
    // （SIGINT 只取消当前 turn），于是连"进程退出"这个兜底事实都没有。
    // 后果：用户中断或撞上步数上限后，这个 Agent 会一直显示运行中。
    // 与 grok 的区别要认清——grok 是**发了**另一个事件（`StopCancelled`）而我们没接，
    // Kimi 是真的什么都不发（config.py:5-19 的 13 个事件里没有任何 cancel 类），
    // 所以这里正确的做法是如实记录这个限制，而不是编一个收尾事件出来。
    { events: ['Stop', 'StopFailure'], state: 'done' },
    {
      events: [
        'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
        'PostToolUseFailure', 'SubagentStart'
      ],
      state: 'working'
    }
  ],
  // 子代理按**名字**记账，不是按 id：Kimi 的 SubagentStart/Stop 负载里只有 `agent_name`
  // （hooks/events.py:117-142，两个事件都只带 agent_name + prompt/response），没有任何 id 键。
  // 因此同名子代理并发时会记成一个——这是上游负载的事实，不是这里可以补的。
  subagentTracking: {
    startEvents: ['SubagentStart'],
    stopEvents: ['SubagentStop'],
    mainStopEvents: ['Stop', 'StopFailure'],
    idKeys: ['agent_name']
  },
  // 负载键是 snake_case `session_id`（hooks/events.py:9 的 `_base`，每个事件都经它）。
  // **不**声明 transcriptPathKeys：Kimi 的 hook 负载里没有任何 transcript/session 文件路径键，
  // resume 靠 session id。
  nativeHandle: {
    sessionIdKeys: ['session_id']
  }
}

export function createKimiProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'kimi', label: 'Kimi', executable: 'kimi',
      // **不是** `kimi`。这个 CLI 启动时把自己的进程名改成 `Kimi Code`
      // （cli/__init__.py:373 调 init_process_name("Kimi Code")，utils/proctitle.py:6-13 走
      // setproctitle，且 setproctitle 是硬依赖 pyproject.toml:38）。readySignal 是
      // foreground-process 按 expectedProcess 比对，写 `kimi` 会让"就绪"永远等不到——
      // 这正是"从可执行文件名推进程名"这类形状推理的失效点。
      expectedProcess: 'Kimi Code',
      // 首个 prompt **送不到**，所以如实声明 post-launch-only 而不是 positional-argv。
      //
      // Kimi 的交互 UI 没有「带着一条 prompt 启动、并继续活着」的入口，这一点是两面夹死的：
      //   1. `-p/--prompt`（与别名 `-c/--command`，cli/__init__.py:217-226）在 shell UI 里走的是
      //      `Shell.run(command=...)`，而那条路 `# run single command and exit`
      //      （ui/shell/__init__.py:382-399）跑完就 return——不是一个活着的 PTY。
      //   2. 没有 Gemini `--prompt-interactive` 那样的旗标。把 cli/__init__.py 的整份选项清单读完，
      //      prompt 只有上面那一个入口。
      //   （`prefill_text` 不是第三条路：它只由 `Reload` 异常传入（cli/__init__.py:779），
      //     并在交互循环内部才应用（ui/shell/__init__.py:497），任何命令行旗标都到不了它。）
      //
      // 于是首个 prompt 只能在进程起来之后当一条普通 turn 提交（`submitAgentPrompt`，那条路对本
      // Provider 是通的：single-phase 不需要 composer readiness 纪元）。
      //
      // **绝不能**声明 positional-argv 再在 buildArgs 里把 prompt 丢掉：那样用户的原话只会落进
      // timeline、永不进入进程，而界面上一切正常——最难发现的一类丢失。声明成 post-launch-only 后，
      // 带 prompt 启动会被 buildLaunch 当场拒绝（AGENT_LAUNCH_PROMPT_UNSUPPORTED）。
      promptDelivery: 'post-launch-only',
      // `unmanaged` 而非 `explicit-managed`：hook 是真的、Core 也认得，但它的配置面是
      // `~/.kimi/config.toml` 的 `[[hooks]]` 数组——**TOML**，而本仓四种 merge 策略
      // （json-owned-key / json-managed-events / yaml-managed-events / json-managed-approvals）
      // 没有一种能编辑 TOML，Core 也没有 TOML 解析器（依赖只有 @xterm/headless 与 yaml）。
      //
      // 而这个文件是用户自己的主配置：model、credentials、theme 都在里面
      // （docs/en/configuration/config-files.md:7）。所以它和 grok 的 `~/.grok/hooks/*.json`
      // 那种一文件一用途的 drop-in **不是**同一回事——整份覆盖会是一次数据损坏而不是一次安装，
      // 而幂等的 TOML merge 要么加一个新依赖、要么手写一个保注释的 TOML 编辑器，两者都远超
      // 本 Provider 的范围。按「能力未核实/未实现就不声明」如实记 unmanaged：hook 只在用户
      // 自己接线后才响，Core 不假装安装过。
      hookStrategy: { kind: 'native', installation: 'unmanaged' },
      // `--session/-S/--resume/-r <id>` 直传 session id，故 locator 是 session-id。
      // 注意它是 **find-or-create**：id 不存在时会静默新建一个用该 id 的会话
      // （cli/__init__.py:558-565，docs/en/guides/sessions.md:37）。对 AgentMux 无害——我们只用
      // Core 记下来的、真的存在过的 id 去恢复；但**绝不能**把这个旗标当"给新会话指定 id"用。
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      // ACP 真实存在（`kimi acp` 子命令 + agent-client-protocol 硬依赖），但 AgentMux 侧的 ACP
      // 适配未接，故如实声明 none/false——与 Gemini 同一处理。
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, hookEvents: true, timeline: 'complete-events',
        // observe 而非 respond：Kimi 的 PreToolUse 确实能在 stdout 上回 permissionDecision:deny
        // 来拦一次调用，但那要求这个 fire-and-forget 的 hook 变成一条阻塞 RPC。那条通路今天不存在。
        // 且它的 hook 引擎是 **fail-open**（超时/崩溃/正则错一律 allow，hooks/runner.py:30,44-55），
        // 本就不能当安全边界。AgentMux 靠 PTY 注入按键回答授权提示。
        permission: 'observe',
        providerResume: true, acp: false, replyCorrelation: 'none'
        // usage 刻意不声明：Kimi 的收尾负载（Stop / StopFailure，hooks/events.py:73-96）里
        // **没有任何 token 字段**，它也不报 transcript 路径。今天两个 reader（claude-jsonl /
        // codex-rollout）都无从下手。按「能力未核实就不声明」留空，UI 据此说"此 Provider 不报用量"。
      }
    }),
    // prompt 一定是空的：非空的启动 prompt 已被 buildLaunch 依 post-launch-only 拒在门外
    // （理由与出处见上面 promptDelivery 那段），所以这里只需把解析出的旗标原样传下去。
    buildArgs: (_prompt, args) => [...args],
    hook: KIMI_HOOKS,
    buildResumeArgs: (sessionId, _transcriptPath, _prompt, args) => ['--session', sessionId, ...args]
  })
}
