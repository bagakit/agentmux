import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'

export type MobileAgentPresentation = NonNullable<AgentMuxSpaceCatalog['agentPresentation']>[number]
/** Display density only. This never qualifies input, recovery, or Runtime health. */
export function ordinaryUnknownAgentStatus(presentation: MobileAgentPresentation | undefined, hasRequest = false): boolean {
  if (hasRequest || presentation?.group === 'attention' || presentation?.stateMark === 'attention' || presentation?.stateMark === 'error' ||
    presentation?.state === 'error' || presentation?.state === 'waiting' || presentation?.state === 'blocked') return false
  if (presentation?.group === 'working' || presentation?.group === 'results' || presentation?.stateMark === 'working' ||
    presentation?.stateMark === 'results' || presentation?.stateMark === 'interrupted' || presentation?.stateMark === 'recovery' ||
    presentation?.state === 'working' || presentation?.state === 'starting' || presentation?.state === 'exited') return false
  return !presentation || presentation.stateMark === 'unknown' || presentation.presenceUnknown === true ||
    presentation.state === 'unknown' || presentation.state === 'running' && !presentation.stateMark
}
