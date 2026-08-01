import { AgentMuxError } from '../errors.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog } from './shared.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

export const PI_HOOKS: AgentNativeHookSpecification = {
  rules: [
    { events: ['tool_call', 'tool_execution_start'], toolNames: ['ask_user_question', 'askuserquestion'], state: 'blocked' },
    { events: ['agent_end', 'agent_settled'], state: 'done' },
    {
      events: ['before_agent_start', 'agent_start', 'tool_call', 'tool_execution_start', 'tool_execution_end', 'message_end'],
      state: 'working'
    }
  ],
  nativeHandle: {
    sessionIdKeys: ['session_id'],
    transcriptPathKeys: ['session_file'],
    requireTranscriptPath: true
  }
}

export function createPiProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  return defineAgentProvider({
    catalog: catalog({
      id: 'pi', label: 'Pi', executable: 'pi', expectedProcess: 'pi', promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'unmanaged' },
      resumeStrategy: { kind: 'provider-native', locator: 'transcript-path' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, hookEvents: true, timeline: 'complete-events', permission: 'observe',
        providerResume: true, acp: false, replyCorrelation: 'none'
      }
    }),
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: PI_HOOKS,
    buildResumeArgs: (_sessionId, transcriptPath, prompt, args) => {
      // 与「handle 属于别的 Provider」共用一个错误码，故必须靠 detail 分辨：这里是 Provider 对得上、
      // 但它要的 transcript 路径没到（Pi 的 resume locator 是 session_file，不是 session id）。
      // 该做的事也不同——等 hook 报出 session_file，而不是刷新会话。
      if (!transcriptPath) {
        throw new AgentMuxError(
          'Pi resume requires its hook-reported session file.',
          'INVALID_NATIVE_SESSION_HANDLE',
          'providerId=pi resumeLocator=transcript-path missingField=transcriptPath reason=hook-has-not-reported-session-file'
        )
      }
      return ['--session', transcriptPath, ...args, ...(prompt ? [prompt] : [])]
    }
  })
}
