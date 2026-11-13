import type { AgentInputSubmissionReceipt } from '@agentmux/core'

/** Synthetic original input, never copied from a user's message or avatar. */
export function profileReceipt(operationId = 'profile-original'): AgentInputSubmissionReceipt {
  const run = { runId: 'profile-run' }, key = { kind: 'prompt' as const,
    agentSessionId: 'profile-session', expectedRun: run, submissionId: operationId }
  const ref = { key, waitGeneration: 2 }, gateId = 'profile-gate'
  return { key, ref, persistence: 'confirmed', status: 'terminal-confirmed', observation: 'closed',
    control: { ref, state: 'dispatch-authorized', at: 1, gateId },
    admission: { agentSessionId: key.agentSessionId, run, admission: { inputKey: key,
      inputDispatch: { ref, gateId }, submissionId: operationId, operationId,
      transport: 'pty', startByte: 0, endByte: 24, acknowledged: true,
      intent: { run, ownerInstanceId: 'profile-owner', prompt: 'Synthetic original wire', execution: 'immediate',
        admissionIntent: { kind: 'manual-actor', expectedRun: run }, plan: { kind: 'single-phase', data: 'Synthetic original wire\r' },
        message: { userContent: 'Synthetic queue body', systemContext: 'Synthetic frozen context', authorHuman: true,
          sourceDevice: { hostId: 'local', deviceId: 'profile-device', name: 'Synthetic device' },
          authorProfile: { name: 'Synthetic author', avatar: { revision: 'sha256:' + '0'.repeat(64), mimeType: 'image/png', byteLength: 12702,
            width: 64, height: 64, dataBase64: 'A'.repeat(16936) } } } } } } }
}

export function withoutProfile(receipt: AgentInputSubmissionReceipt): AgentInputSubmissionReceipt {
  const copy = structuredClone(receipt)
  delete copy.admission!.admission!.intent!.message!.authorProfile
  return copy
}
