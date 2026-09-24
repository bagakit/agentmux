import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog } from './shared.js'
import { readKimiSessionHistoryPage } from './kimi-native-history.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * Kimi (@moonshot-ai/kimi-code v2.1.1) Hook 协议映射。
 *
 * 真实第一方依据：
 * - packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts
 * - packages/agent-core-v2/src/features/externalHooks/internal/matchHooks.ts
 * - packages/agent-core-v2/src/features/externalHooks/configSection.ts
 * - apps/kimi-code/src/cli/commands.ts 与 package.json
 *
 * 事件投递侧经 toHookInputData 将 camelCase 字段转为 snake_case，事件名在 hook_event_name 中传递。
 *
 * 关键协议事实：
 * 1. Stop 是在 afterStep 上的可 veto 探测（loopService.ts onDidFinishStep -> runStop(ctx)），
 *    若 hook 返回 block 判定（exit code 2 或 structured block），Kimi 会将原因作为 system_trigger (stop_hook)
 *    写入 context 并调用 loop.notify() 继续运行；即使放行亦非 turn 结束。故 Stop 不当 main done 或 turn-end。
 * 2. StopFailure 与 Interrupt 真实负载（notifyTurnEnded）仅带 errorType/errorMessage 或 turnId/reason，
 *    不包含 agentId/agent_name 等主体作用域字段。未给 agent 作用域时诚实判定为 unknown/null，
 *    绝不凭名字猜 main，绝不凭名字猜成功 (done)，未证 extra 数据亦不得影响真实 native identity。
 * 3. 正常完成的 TurnEnded（reason === 'completed'）在第一方 AgentExternalHooksService 中不触发任何 hook；
 *    按既有事实诚实声明，不虚造事件。
 * 4. TS 2.1.1 中无 SubagentStart/SubagentStop hook，不声明 subagentTracking；亦不预设未证 agentName 别名猜测。
 */
export const KIMI_HOOKS: AgentNativeHookSpecification = {
  eventNameSource: { kind: 'payload', payloadKey: 'hook_event_name' },
  rules: [
    // Stop 是 afterStep 上的可 veto 探测，可能继续执行，不当 main done 或 turn-end
    {
      events: ['Stop'],
      state: 'working',
      lifecycleEvent: null
    },
    // StopFailure / Interrupt 真实负载无 agent 作用域；诚实判定为 unknown/null，不猜 main 或成功
    {
      events: ['StopFailure', 'Interrupt'],
      state: 'unknown',
      lifecycleEvent: null
    },
    // 主轮开工与进行中事件
    {
      events: ['TurnStarted'],
      state: 'working',
      lifecycleEvent: 'turn-start'
    },
    {
      events: ['PermissionRequest'],
      state: 'waiting',
      lifecycleEvent: 'permission-request'
    },
    {
      events: [
        'UserPromptSubmit',
        'UserPromptQueued',
        'PreToolUse',
        'PostToolUse',
        'PostToolUseFailure',
        'PermissionResult'
      ],
      state: 'working'
    }
  ],
  nativeHandle: {
    sessionIdKeys: ['session_id']
  }
}

export function createKimiProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    readSessionHistoryPage: readKimiSessionHistoryPage,
    catalog: catalog({
      id: 'kimi', label: 'Kimi', executable: 'kimi',
      // 第一方 TS 2.1.1 (apps/kimi-code) 并无进程改名 (setproctitle) 证据；保持原成熟可执行名 kimi。
      expectedProcess: 'kimi',
      promptDelivery: 'post-launch-only',
      // TS 2.1.1 配置位于 KIMI_CODE_HOME（默认 ~/.kimi-code）下的 config.toml。
      // configSection.ts 声明严格的 [[hooks]] 结构：{ event, matcher?, command, timeout? }。
      // 完整 managed config loader/merge 语义未在当前 review slice 中全面核过，
      // 诚实保留 unmanaged 范围与终局缺口，禁止猜测配置路径写入用户目录。
      hookStrategy: { kind: 'native', installation: 'unmanaged' },
      // apps/kimi-code commands.ts 提供 -S, --session [id] 与隐藏的 -r, --resume [id]，
      // locator 准确声明为 session-id
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events',
        permission: 'observe',
        providerResume: true, replyCorrelation: 'none'
      }
    }),
    buildArgs: (_prompt, args) => [...args],
    hook: KIMI_HOOKS,
    buildResumeArgs: (sessionId, _transcriptPath, _prompt, args) => ['--session', sessionId, ...args]
  })
}
