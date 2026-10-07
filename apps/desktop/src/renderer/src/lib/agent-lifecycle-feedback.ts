import type { AgentSessionControl } from '../../../shared/contracts'
import type { AgentMuxRunState } from '@agentmux/core'
import type { RenderableServiceNotice } from './service-window-notice'

/** Presentation attributes of the source-owned current failure, not another Runtime fact store. */
export type AgentLifecycleFailure =
  | { step: 'launch'; regionId: string; tabId: string }
  | { step: 'resume'; subject: AgentSessionControl; lastProcessState: AgentMuxRunState }

export type AgentLifecycleFeedbackOwner = { regionId: string } | { subject: AgentSessionControl }

/** Region identity survives movement; a resume belongs to one exact Session and Run. */
export function lifecycleFeedbackOwnerKey(owner: AgentLifecycleFeedbackOwner): string {
  return JSON.stringify('regionId' in owner ? ['launch', owner.regionId]
    : ['resume', owner.subject.hostId, owner.subject.agentSessionId, owner.subject.run.runId])
}

/** The entry point knows the failed step; the original error never becomes a type guessed from text. */
export function agentLifecycleFailureNotice(failure: AgentLifecycleFailure, message: string): RenderableServiceNotice {
  return {
    kind: 'indeterminate',
    notice: {
      step: failure.step === 'launch' ? 'Starting this Agent did not complete' : 'Resuming this Session did not complete',
      mode: `${message}\n${failure.step === 'launch'
        ? 'The new Agent’s availability is not confirmed. Your draft and existing workbench are kept.'
        : `The original Run was last observed ${failure.lastProcessState}; current availability is not confirmed. Your Session, workbench and draft are kept.`}`,
      restore: failure.step === 'launch'
        ? 'Review the reported cause, then retry Start agent with your preserved draft. This failure does not stop other Sessions.'
        : 'Review the reported cause, then retry Resume for this same Session. This failure does not stop other Sessions.'
    }
  }
}
