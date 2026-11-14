import { identityRuntimeSource } from '@agentmux/identity/runtime-source'
import { createPiHookSpecification, planPiManagedHooks, buildPiResumeArgs } from '@agentmux/providers/pi/provider'
import { executionEnvironmentValue, executionHomeDirectory, executionPath, type ProviderExecutionEnvironment } from './execution-environment.js'
import { AgentMuxError } from '../errors.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import { normalizeNativeSessionId, normalizeNativeTranscriptPath } from '../agent-native-locator.js'
import { catalog, hookToolFields } from './shared.js'
import { hookDeliverySource } from '../agent-hook-delivery.js'
import { readPiConversationChanges, readPiSessionHistoryPage } from './pi-native-history.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

const services = { executionEnvironmentValue, executionHomeDirectory, executionPath, hookDeliverySource, identityRuntimeSource }
export const PI_HOOKS = createPiHookSpecification({ hookToolFields, normalizeNativeSessionId, normalizeNativeTranscriptPath })
export const createPiManagedHookPlan = (env?: ProviderExecutionEnvironment, workspacePath?: string) =>
  planPiManagedHooks(services, env, workspacePath)

export function createPiProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    planManagedHooks: ({ env, workspacePath }) => createPiManagedHookPlan(env, workspacePath),
    readSessionHistoryPage: readPiSessionHistoryPage,
    readConversationChanges: readPiConversationChanges,
    observeSessionHistory: observeNativeJsonlHistory,
    catalog: catalog({
      composer: {"skillRoots": [".pi/agent/skills", ".agents/skills"], "commands": [{"text": "/help", "description": "Available commands"}, {"text": "/model", "description": "Choose model"}, {"text": "/compact", "description": "Compact context"}]},
      id: 'pi', label: 'Pi', executable: 'pi', expectedProcess: 'pi', promptDelivery: 'positional-argv',
      // `explicit-managed` 而非此前的 `unmanaged`：AgentMux 现在真的把状态扩展装进 Pi 的扩展目录。
      // 之前记 unmanaged 是因为没有第一方证据能确定装载合同（目录、导出形状、可用事件名）；这些现在
      // 逐条来自上游源码，见上面各段的引用。
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      resumeStrategy: { kind: 'provider-native', locator: 'transcript-path' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events',
        // `none` 而非 observe：Pi 没有任何可订阅的授权/等待事件（`types.ts` 里没有 permission 族；
        // `ui_prompt_*` 只在扩展自己弹窗时发，见 PI_HOOKS 那段）。声明 observe 会是一句
        // 「我们看得见它在等人」的谎。
        permission: 'none',
        providerResume: true,
        // 工具调用两端确实带同一个 `toolCallId`（`types.ts:889-892`/`:798-803`/`:815-821`），但我们
        // 今天没有把它投递上来（payload 只放 tool_name/tool_input）。按「未接线就不声明」记 none；
        // 要改成有关联，得先在扩展源码里把 toolCallId 投出来，两处一起改。
        replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: PI_HOOKS,
    buildResumeArgs: (...args) => buildPiResumeArgs(AgentMuxError, ...args)
  })
}
