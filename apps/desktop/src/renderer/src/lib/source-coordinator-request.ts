import type { AgentExecutionRecoveryReference, AgentLaunchResult } from '../../../shared/contracts'
import { api } from './api'
import { checkpointMountedSpaceInputs, useAppStore } from '../store'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { sourceCoordinatorInput, sourceCoordinatorInputKey, type SourceCoordinatorInput } from './source-coordinator-input'
import { applyOriginalLaunchNames } from './original-launch-names'

// Only coalesce concurrent explicit sends of this exact retained request. Core
// remains the operation owner; this promise carries no persisted outcome.
const associationSends = new WeakMap<SourceCoordinatorInput['request'], Promise<NonNullable<SourceCoordinatorInput['association']['receipt']>>>()

/** The existing C recovery producer can finish its retained private L intent;
 * ordinary C recovery without that exact private entry is unchanged. */
export async function associateRetainedSourceCoordinator(target: AgentExecutionRecoveryReference, created: AgentLaunchResult['created']) {
  const key = sourceCoordinatorInputKey({ sourceCoordinator: target.coordinator, ...target.reference })
  const input = sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, key)
  if (input) try { await associateCreatedSourceCoordinator(input, created) }
  catch (cause) {
    useAppStore.getState().retainSourceCoordinatorInput(key, current => current?.request === input.request
      ? { ...current, association: { ...current.association, issue: presentError(cause) } } : current)
  }
}

/** One explicit original Launch may associate its confirmed A creation with B.
 * C remains owned by A. Reads and restart never call this write producer. */
export async function associateCreatedSourceCoordinator(input: SourceCoordinatorInput, created: AgentLaunchResult['created']) {
  const key = sourceCoordinatorInputKey(input.request), original = input.request, tool = created.toolExecution
  const retain = (update: (current: SourceCoordinatorInput) => SourceCoordinatorInput) => useAppStore.getState().retainSourceCoordinatorInput(key,
    current => current?.request === original ? update(current) : current)
  if (created.agentSessionId !== original.agentSessionId || created.hostId !== original.hostId || created.creation?.createOperationId !== original.createOperationId ||
      !tool || tool.resourceHostId !== original.toolWorkspace.hostId || tool.resourceRuntimeId !== original.sourceCoordinator.resourceRuntimeId || tool.workspacePath !== original.toolWorkspace.path)
    throw Error('The original creation and resource binding are unconfirmed. The Agent and this project-link intention are retained.')
  const target = { coordinator: { hostId: original.hostId, runtimeId: original.sourceCoordinator.runtimeId },
    reference: { bindingId: tool.bindingId, agentSessionId: original.agentSessionId, createOperationId: original.createOperationId } }
  retain(current => current.acknowledged ? current : { ...current, acknowledged: { target, run: { ...created.run } } })
  const retained = sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, key)
  if (!retained || retained.request !== original) return
  void applyOriginalLaunchNames({ kind: 'reach', input: retained }, ['agent'])
  return await sendOriginalSourceAssociation(retained)
}

/** Explicit same-L send/continue. A fresh association witness is a locator fact,
 * not a grant, a current Run observation or the acknowledgement of an old L. */
export function sendOriginalSourceAssociation(input: SourceCoordinatorInput) {
  const existing = associationSends.get(input.request)
  if (existing) return existing
  const sending = sendAssociation(input)
  associationSends.set(input.request, sending)
  void sending.finally(() => { if (associationSends.get(input.request) === sending) associationSends.delete(input.request) }).catch(() => {})
  return sending
}
async function sendAssociation(input: SourceCoordinatorInput) {
  const key = sourceCoordinatorInputKey(input.request), original = input.request
  const current = () => sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, key)
  const retain = (update: (value: SourceCoordinatorInput) => SourceCoordinatorInput) => useAppStore.getState().retainSourceCoordinatorInput(key,
    value => value?.request === original ? update(value) : value)
  if (!input.acknowledged) throw Error('Check the original Coordinator creation before linking this project. No new Agent was requested.')
  if (input.association.receipt?.outcome === 'opened' || input.association.receipt?.outcome === 'retired') return input.association.receipt
  let dispatched = false
  try {
    const target = input.acknowledged.target, inspection = await api.sessions.executionBinding(target, 'association'), witness = inspection?.association
    if (!witness || witness.state !== 'confirmed' || witness.reference.bindingId !== target.reference.bindingId ||
        witness.reference.agentSessionId !== original.agentSessionId || witness.reference.createOperationId !== original.createOperationId ||
        witness.agentRuntimeId !== original.sourceCoordinator.runtimeId || witness.resourceRuntimeId !== input.target.reference.runtimeId ||
        witness.resourceWorkspacePath !== input.origin.project.path)
      throw Error('The original Coordinator has not confirmed this project resource. Its Agent and original link operation are retained.')
    const request = input.association.request ?? { operationId: input.association.operationId,
      content: { kind: 'agent-session' as const, reference: { kind: 'coordinator-agent' as const, runtimeId: original.sourceCoordinator.runtimeId, binding: target.reference },
        expectedResource: { runtimeId: input.target.reference.runtimeId, workspaceId: input.target.workspaceId, workspacePath: input.origin.project.path } },
      destination: { spaceId: input.target.reference.spaceId, zoneId: input.target.zoneId, newTab: true as const }, focus: false }
    retain(value => ({ ...value, association: { ...value.association, request, submitted: true } }))
    await checkpointMountedSpaceInputs()
    if (current()?.request !== original || current()?.association.request !== request)
      throw Error('The original project-link intention changed before dispatch. No replacement was submitted.')
    dispatched = true
    const receipt = await api.spaceMounts.call('open', { hostId: input.target.hostId, reference: input.target.reference, request })
    if (receipt.operationId !== input.association.operationId) throw Error('This reply belongs to another project-link operation. Keep and check the original L.')
    retain(value => ({ ...value, association: { ...value.association,
      originalReceipt: Object.hasOwn(value.association, 'originalReceipt') ? value.association.originalReceipt : value.association.receipt ?? receipt, receipt } }))
    const retained = current()
    if (retained) void applyOriginalLaunchNames({ kind: 'reach', input: retained }, ['tab'])
    return receipt
  } catch (cause) {
    retain(value => ({ ...value, association: { ...value.association, submitted: input.association.submitted || dispatched,
      issue: `${dispatched || input.association.submitted ? 'The original project-link result is unknown.' : 'The project link was not sent in this attempt.'} ${presentError(cause)}` } }))
    throw cause
  }
}
