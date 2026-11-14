import { createHash } from 'node:crypto'
import { AgentMuxError, type AgentExecutionInspection } from '@agentmux/core'
import type { AgentExecutionLegacyLocator, AgentExecutionLegacyObservation, AgentExecutionRecoveryReference } from '../shared/contracts'

/** The original Main creation identity, shared by admission and retained-intent lookup. */
export function originalExecutionBindingId(hostId: string, agentSessionId: string, createOperationId: string): string {
  return createHash('sha256').update(JSON.stringify([hostId, agentSessionId, createOperationId])).digest('hex')
}

/** Reads only the original Coordinator's retained intent. Current configuration cannot supply missing input. */
export async function resolveOriginalExecutionBinding(value: unknown, ports: {
  inspect(bindingId: string): Promise<AgentExecutionInspection | null>
  coordinatorTarget(): Promise<AgentExecutionRecoveryReference['coordinator']>
  assertCoordinator(target: AgentExecutionRecoveryReference['coordinator']): Promise<void>
}): Promise<AgentExecutionLegacyObservation | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<AgentExecutionLegacyLocator>
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !/[\0\r\n]/u.test(v)
  if (!text(input.hostId) || !text(input.agentSessionId) || !text(input.createOperationId) ||
    !text(input.toolWorkspace?.hostId) || typeof input.toolWorkspace?.path !== 'string' || !input.toolWorkspace.path || input.toolWorkspace.path.includes('\0')) return null
  const reference = { bindingId: originalExecutionBindingId(input.hostId, input.agentSessionId, input.createOperationId),
    agentSessionId: input.agentSessionId, createOperationId: input.createOperationId }
  const coordinator = await ports.coordinatorTarget()
  await ports.assertCoordinator(coordinator)
  const inspection = await ports.inspect(reference.bindingId)
  await ports.assertCoordinator(coordinator)
  if (!inspection) return null
  if (inspection.bindingId !== reference.bindingId || inspection.agentHostId !== input.hostId ||
    inspection.agentSessionId !== reference.agentSessionId || inspection.resourceHostId !== input.toolWorkspace.hostId ||
    inspection.resourceWorkspacePath !== input.toolWorkspace.path || inspection.continuation?.bindingId !== reference.bindingId ||
    inspection.continuation.agentSessionId !== reference.agentSessionId || inspection.continuation.createOperationId !== reference.createOperationId) {
    throw new AgentMuxError('The original Coordinator did not confirm this retained request and tool resource. No request was reconstructed or continued.', 'EXECUTION_INTENT_UNCONFIRMED')
  }
  return { target: { coordinator, reference: inspection.continuation }, inspection }
}
