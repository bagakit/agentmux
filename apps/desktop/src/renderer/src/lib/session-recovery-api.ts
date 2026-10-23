import type { AgentMuxDesktopApi, AgentMuxPreloadApi } from '../../../shared/contracts'
import { readSessionRecoveryReply } from '../../../shared/session-recovery-result'

/** Decode in the Renderer realm, after contextBridge has transported the plain reply. */
export function createRendererSessionRecovery(recover: AgentMuxPreloadApi['sessions']['recover']): AgentMuxDesktopApi['sessions']['recover'] {
  return (...args) => readSessionRecoveryReply(() => recover(...args))
}
