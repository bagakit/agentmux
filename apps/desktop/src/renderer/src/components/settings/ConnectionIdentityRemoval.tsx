import { mintObjectId } from '@agentmux/core/object-id'
import { useEffect, useRef, useState } from 'react'
import type { ConnectionDeleteOperation, ConnectionRecord } from '@agentmux/core/connections'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'
import type { ConnectionHostingTarget } from '../../../../shared/contracts'
import { retainedIdentityRemovalTasks, restoredIdentityRemovalTask, botTaskSelectionKey, readBotTaskLocator, type IdentityRemovalTaskScope } from '../../lib/bot-task-selection'
import { retainBotTaskSelection, setBotTaskSelection, useAppStore } from '../../store'
import { ConfirmationDialog } from '../ConfirmationDialog'
import { linkedMoteUses } from './ConnectionIdentityFacts'
import type { MoteIdentityReadings } from './MoteIdentityCards'

/** A removable local identity; the original public owner holds the deletion and its receipt. */
export function ConnectionIdentityRemoval({ record, readings, active, hostingTarget, onDeleted }: {
  record: { config: Pick<ConnectionRecord['config'], 'connectionId' | 'adapterId' | 'application' | 'label'>; revision: number }; readings: MoteIdentityReadings; active: boolean; hostingTarget: ConnectionHostingTarget | null; onDeleted(receipt: ConnectionDeleteOperation): void
}) {
  const selections = useAppStore(state => state.botTaskSelections)
  const candidate = restoredIdentityRemovalTask(record, selections, hostingTarget)
  const retained = candidate && (!candidate.hostingTarget || JSON.stringify(candidate.hostingTarget) === JSON.stringify(hostingTarget)) ? candidate : null
  const originalHost = retained ? retained.hostingTarget : hostingTarget
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [issue, setIssue] = useState('')
  const [notRecorded, setNotRecorded] = useState(false), alive = useRef(true), flight = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const motes = linkedMoteUses(record, readings)
  const clearOriginal = (scope: IdentityRemovalTaskScope, operationId: string, owner: ConnectionHostingTarget) => {
    const current = readBotTaskLocator(useAppStore.getState().botTaskSelections[botTaskSelectionKey(scope)])
    if (current?.operationId === operationId && JSON.stringify(current.hostingTarget) === JSON.stringify(owner)) setBotTaskSelection(scope, null)
  }
  const accept = (operation: ConnectionDeleteOperation, scope: IdentityRemovalTaskScope, owner: ConnectionHostingTarget) => {
    if (operation.connectionId !== record.config.connectionId || operation.application.domain !== record.config.application.domain || operation.application.appId !== record.config.application.appId || operation.deletedRevision !== scope.expectedRevision)
      throw Error('The original removal receipt belongs to another identity. The original request is kept.')
    clearOriginal(scope, operation.operationId, owner)
    if (alive.current) { setOpen(false); onDeleted(operation) }
  }
  async function inspect() {
    if (!retained || !retained.hostingTarget || flight.current) return
    flight.current = true; setBusy(true); setIssue('')
    try {
      const result = await api.connections.call('connection.delete.inspect', { operationId: retained.operationId }, retained.hostingTarget)
      if (result.operation) accept(result.operation, retained.scope, retained.hostingTarget)
      else if (alive.current) { setNotRecorded(true); setIssue('No removal receipt is recorded in this reading. You can continue the same original removal; the identity and revision stay fixed.') }
    } catch (error) { if (alive.current) setIssue('The original removal result is not confirmed. ' + presentError(error)) }
    finally { flight.current = false; if (alive.current) setBusy(false) }
  }
  async function remove() {
    if (!originalHost || flight.current) return
    const request = retained ?? { operationId: mintObjectId(), scope: { kind: 'identity-removal' as const,
      connectionId: record.config.connectionId, adapterId: record.config.adapterId, domain: record.config.application.domain,
      appId: record.config.application.appId, expectedRevision: record.revision, hostingTarget: originalHost } }
    flight.current = true; setBusy(true); setIssue(''); setNotRecorded(false)
    try {
      const retained = await retainBotTaskSelection(request.scope, { operationId: request.operationId, hostingTarget: originalHost })
      if (!retained.localStorageWritten) throw new Error('The original removal request could not be saved. No removal was sent.')
      accept(await api.connections.call('connection.delete', { operationId: request.operationId, connectionId: request.scope.connectionId, expectedRevision: request.scope.expectedRevision }, originalHost), request.scope, originalHost)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'CONNECTION_REVISION_CONFLICT') {
        clearOriginal(request.scope, request.operationId, originalHost)
        if (alive.current) setIssue('The application changed before removal, so this request was refused. Return to All identities and refresh before starting another removal.')
      } else if (alive.current) setIssue('Removal result not confirmed. Check this original removal before deciding another action. ' + presentError(error))
    } finally { flight.current = false; if (alive.current) setBusy(false) }
  }
  if (!originalHost) return <section className="connector-identity-removal" aria-label="Original identity removal">
    <p className="settings-group-note">The original removal Host is not recorded. This request is kept and cannot be checked or continued on another Host.</p>
    {retained ? <code>{retained.operationId}</code> : null}
  </section>
  return <section className="connector-identity-removal" aria-label="Remove local identity">
    <button type="button" className="small-button" data-identity-remove onClick={() => setOpen(true)}>{retained ? 'Review identity removal' : 'Remove from AgentMux'}</button>
    {retained ? <p role="status">An original removal request is retained. Its result is checked separately from the current identity list.</p> : null}
    <ConfirmationDialog open={active && open} title="Remove this identity from AgentMux?" subject={record.config.label}
      description="Removes this saved identity locally and prevents new messages through its connection. The remote bot application, Motes, conversations and original operation history are kept."
      confirmLabel={retained ? notRecorded ? 'Continue original removal' : 'Check original removal' : 'Remove identity'} busy={busy}
      onCancel={() => setOpen(false)} onConfirm={() => void (retained && !notRecorded ? inspect() : remove())}
      feedback={<div className="connector-identity-removal__review">
        <dl className="connector-identity"><div><dt>Platform</dt><dd>{record.config.application.domain}</dd></div><div><dt>App ID</dt><dd><code>{record.config.application.appId}</code></dd></div></dl>
        <p>{motes.length ? `Referenced by ${motes.join(', ')}. Those Mote references are kept and will show this identity as unavailable.` : readings.complete ? 'No Mote association currently points to this identity.' : 'Mote associations are not fully confirmed. Any saved references are kept and will show this identity as unavailable.'}</p>
        {motes.length && !readings.complete ? <p>Other Mote associations are not fully confirmed. Their original references are also kept.</p> : null}
        <p>Existing group bindings and chat history remain. New connection traffic requires an available identity; pending operations keep their original receipts.</p>
        {issue ? <p role="status" className="settings-inline-error">{issue}</p> : null}
      </div>} />
  </section>
}

/** A missing list row cannot hide an original removal whose reply was lost. */
export function RetainedIdentityRemovals({ readings, active, hostingTarget, onDeleted }: { readings: MoteIdentityReadings; active: boolean; hostingTarget: ConnectionHostingTarget | null; onDeleted(receipt: ConnectionDeleteOperation): void }) {
  const selections = useAppStore(state => state.botTaskSelections)
  const requests = retainedIdentityRemovalTasks(selections).filter(request => !request.hostingTarget || JSON.stringify(request.hostingTarget) === JSON.stringify(hostingTarget))
  if (!requests.length) return null
  return <section className="connector-identity-removals" aria-label="Original identity removals"><h3>Original identity removals</h3>
    {requests.map(({ scope, operationId, hostingTarget }) => <div key={operationId} data-identity-removal-request={operationId}>
      <code>{scope.appId}</code><ConnectionIdentityRemoval hostingTarget={hostingTarget} record={{ config: { connectionId: scope.connectionId, adapterId: scope.adapterId, application: { domain: scope.domain, appId: scope.appId }, label: scope.appId }, revision: scope.expectedRevision }} readings={readings} active={active} onDeleted={onDeleted} />
    </div>)}
  </section>
}
