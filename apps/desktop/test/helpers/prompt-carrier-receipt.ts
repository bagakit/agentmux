import type { AgentInputSubmissionReceipt } from '@agentmux/core'

/** Renderer boundary fixture; real native/terminal delivery is tested separately. */
export function promptCarrierWaiting(agentSessionId: string, runId: string, submissionId: string): AgentInputSubmissionReceipt {
  const key = { kind: 'prompt' as const, agentSessionId, expectedRun: { runId }, submissionId }
  const ref = { key, waitGeneration: 1 }
  return { key, ref, persistence: 'confirmed', control: { ref, state: 'enabled', at: 1 },
    admission: null, status: 'waiting', observation: 'owned' }
}
