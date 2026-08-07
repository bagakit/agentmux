import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { HERMES_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog, hermesHookCommand, HOOK_COMMAND_TIMEOUT_SECONDS } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * 写进 `~/.hermes/config.yaml` 的 `hooks:` 块的事件名。
 *
 * Hermes 的事件全集在本机 `hermes_cli/plugins.py` 的 `VALID_HOOKS` 里（约 30 个）。装这九个：
 *
 * - `on_session_start`/`on_session_end`：一轮的两端。`on_session_end` 的 `extra` 带
 *   `completed`/`interrupted` 两个布尔，是「这一轮是跑完的还是被打断的」的唯一来源。
 * - `pre_llm_call`/`post_llm_call`：一次模型往返的两端。
 * - `pre_tool_call`/`post_tool_call`：一次工具调用的两端。`post_tool_call` 的 `extra` 带
 *   `status: "ok"|"error"|"blocked"`、`result`、`error_message`、`tool_call_id`。
 * - `pre_approval_request`/`post_approval_response`：授权门的两端。这两条是本 task 的核心：
 *   本机源码逐字写明它们「fires BOTH for CLI-interactive prompts and for gateway/ACP approvals」，
 *   也就是说不论用户是在 TUI 上按键还是在 IM 里点按钮，AgentMux 都能看见「Agent 正卡在一个授权上」。
 *   `post_approval_response` 的 `extra.choice` 是 `once|session|always|deny|timeout` 五值之一。
 *   Hermes 明说这两个是 **observers only（返回值被忽略）**，所以我们只观察不应答——这与 catalog 的
 *   `permission: 'observe'` 是同一件事的两处表达。
 * - `subagent_stop`：子代理落地。`extra` 带 `child_session_id`/`child_status`/`child_summary`。
 *
 * 刻意不装的几族：`transform_*`（要求返回替换后的文本，是改写通路而非观察）、`pre_verify`
 * （返回值能让 Agent 继续跑，属策略而非观察）、`pre_gateway_dispatch`（能丢消息/改写文本）、
 * `kanban_task_*`（跑在另一个进程里，与本会话的状态无关）、`pre_api_request`/`post_api_request`
 * （每次 API 往返都触发，比 llm_call 更热且更细）。
 *
 * `subagent_start` 不装：`VALID_HOOKS` 里有它，但本机 `shell_hooks.py` 的 per-event `extra` 表
 * **只列了 `subagent_stop`**，也就是说它的 id 键未被证据佐证。子代理在途记账要求 start/stop 成对
 * （少了 start 记不上、花名册永不加一），单装 stop 会让计数变成负数——所以两个都不装，按
 * 「未核实就不声明」不给 `subagentTracking`，而不是装一个半残的记账。
 */
export const HERMES_HOOK_EVENTS = [
  'on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call', 'post_llm_call',
  'pre_approval_request', 'post_approval_response', 'subagent_stop', 'on_session_end'
] as const

export const HERMES_HOOKS: AgentNativeHookSpecification = {
  // 事件名随负载到达：Hermes 的 `_serialize_payload` 每条事件都写 `hook_event_name`（本机第一方源码
  // 实测：`~/.hermes/.../shell_hooks.py`）。所以它虽不带 `--event`、也不注入 env，仍然安全。
  eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' },
  rules: [
    // 授权门：Hermes 正把这次执行按住等一个决定（TUI 按键、或 IM 上的一次点击）。
    // 判 working 会让「等我点一下」和「正在干活」在界面上长得一模一样。
    { events: ['pre_approval_request'], state: 'waiting' },
    { events: ['pre_tool_call'], toolNames: ['clarify'], state: 'waiting' },
    { events: ['post_llm_call', 'on_session_end'], state: 'done' },
    // `post_approval_response` 是「决定已经给了」——不论决定是允许还是拒绝，Agent 都从等待里出来了。
    // `subagent_stop` 同理：主 Agent 仍在干活。
    {
      events: [
        'on_session_start', 'pre_llm_call', 'pre_tool_call', 'post_tool_call',
        'post_approval_response', 'subagent_stop'
      ],
      state: 'working'
    }
  ]
}

export function createHermesManagedHookPlan(env?: Readonly<Record<string, string>>): AgentManagedHookPlan {
  const hermesHome = env?.HERMES_HOME?.trim()
  const home = hermesHome ? resolve(hermesHome) : join(homedir(), '.hermes')
  const command = hermesHookCommand()
  const hooks = Object.fromEntries(
    HERMES_HOOK_EVENTS.map((eventName) => [eventName, [{ command, timeout: HOOK_COMMAND_TIMEOUT_SECONDS }]])
  )
  const approvals = HERMES_HOOK_EVENTS.map((eventName) => ({ event: eventName, command }))
  return {
    providerId: 'hermes',
    mutations: [
      {
        path: join(home, 'config.yaml'),
        content: `${JSON.stringify({ hooks }, null, 2)}\n`,
        mode: 0o600,
        merge: { kind: 'yaml-managed-events', marker: 'agentmux-hook.js' }
      },
      {
        path: join(home, 'shell-hooks-allowlist.json'),
        content: `${JSON.stringify({ approvals }, null, 2)}\n`,
        mode: 0o600,
        merge: { kind: 'json-managed-approvals', marker: 'agentmux-hook.js' }
      }
    ]
  }
}

export function createHermesProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'hermes', label: 'Hermes', executable: 'hermes', expectedProcess: 'hermes',
      promptDelivery: 'hermes-query',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'none' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events', permission: 'observe',
        providerResume: false, replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => prompt ? ['chat', '--query', prompt, ...args, '--tui'] : [...args, '--tui'],
    hook: HERMES_HOOKS,
    launchOptions: HERMES_LAUNCH_OPTIONS
  })
}