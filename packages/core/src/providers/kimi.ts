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
      // 位置参数：**绝不能**声明 flag-prompt-interactive。Kimi 的 `-p/--prompt` 在 shell UI 里是
      // "跑完这一条就退出"（ui/shell/__init__.py:391-399 的 `# run single command and exit`），
      // 而 AgentMux 要的是一个活着的交互 PTY。所以首个 prompt 不走 argv（见下面的 buildArgs），
      // 改在 PTY 里键入——`promptDelivery` 如实记为 positional-argv 的空 argv 形态。
      //
      // 键入走的是默认的 single-phase（原样加回车），**不是** bracketed paste：本 Provider 不声明
      // planPromptInput，全仓只有 codex 声明了 paste 形态。多行 prompt 因此按换行原样进 PTY——
      // 这是这条默认路的既有行为，claude / cursor / grok / gemini 同此，不是 Kimi 的特例。
      promptDelivery: 'positional-argv',
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
    // 首个 prompt 不进 argv，理由见上面 expectedProcess/promptDelivery 那两段注释。
    buildArgs: (_prompt, args) => [...args],
    hook: KIMI_HOOKS,
    buildResumeArgs: (sessionId, _transcriptPath, _prompt, args) => ['--session', sessionId, ...args]
  })
}
