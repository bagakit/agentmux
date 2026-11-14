import type { AgentMuxAgentSession } from '@agentmux/core'
import { parseCreationInspection } from '../../../../packages/core/src/agent-creation-inspection.js'

/** Valid Core protocol facts, including the different prepared/closed shapes. */
export function nonSessionCreation(kind: 'prepared-agent-creation' | 'closed-agent-creation', original: {
  agentSessionId: string; hostId: string; workspacePath: string; createOperationId: string; runId: string;
  providerId?: string; executorId?: string; creation?: AgentMuxAgentSession['creation']
}) {
  const { agentSessionId, hostId, workspacePath, createOperationId, runId } = original
  const { createdRun: _run, initialInputKey: _key, resolution: _resolution, ...creation } = original.creation ?? { createOperationId, intentDigest: 'd'.repeat(64), initialPrompt: 'not-requested' as const }
  return parseCreationInspection({ kind, agentSessionId, providerId: original.providerId ?? 'codex', executorId: original.executorId ?? 'codex', hostId, workspacePath, creation,
    ...(kind === 'prepared-agent-creation' ? { observation: { runtimeId: 'original-runtime', retainedRun: { runId } } } : {
      resolution: { operationId: 'close-' + createOperationId, createOperationId, agentSessionId, originalCreationKey: 'original-key',
        runtimeId: 'original-runtime', admittedAt: 1, source: { kind: 'prepared-dispatch' }, historicalEffect: 'unknown',
        initialInputContinuation: 'held', outcome: 'fenced' }
    }) })
}
