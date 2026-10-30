import { useState, type ReactNode } from 'react'
import type { ConnectionRecord, RoomBinding } from '@agentmux/core/connections'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import type { CheckedGroupDiagnosis } from '../lib/use-connector-group-diagnosis'
import { connectorConnectionPresentation } from '../lib/connector-connection-presentation'
import { groupTarget } from '../lib/group-diagnosis'
import type { ConnectorProblemAction, ConnectorProblemActions } from '../lib/connector-group-status'
import { ConnectorConnectionOverview } from './ConnectorConnectionOverview'
import { ConnectorDeliveryDetails } from './ConnectorDeliveryDetails'
import type { ConnectorGroupSection } from './ConnectorGroupDetails'

/** Both panels stay mounted. Tab navigation changes visibility, not original action ownership. */
export function ConnectorGroupActivity({ id, section, binding, connection, hostingTarget, snapshot, onCheck, onSection, actions, details, configuration }: {
  id: string; section: ConnectorGroupSection; binding: RoomBinding; connection?: ConnectionRecord | undefined; hostingTarget: ConnectionHostingTarget
  snapshot: CheckedGroupDiagnosis | undefined; onCheck(): void; onSection(section: ConnectorGroupSection): void
  actions: ConnectorProblemActions; details: ReactNode; configuration: ReactNode
}) {
  const report = snapshot?.report ?? null, model = connectorConnectionPresentation(report), key = JSON.stringify([groupTarget(binding), hostingTarget])
  const [selected, setSelected] = useState<{ target: string; action: ConnectorProblemAction } | null>(null)
  return <ConnectorConnectionOverview key={key} binding={binding} connection={connection} report={report} hostingTarget={hostingTarget} onCheck={onCheck}
    onNavigate={next => next === 'sync' ? actions.sync?.({ kind: 'sync', label: '' }) : next === 'channel-settings' ? actions['channel-settings']?.({ kind: 'channel-settings', label: '' }) : onSection(next)} render={({ overview, diagnostics }) => <>
      <div id={`${id}-overview-panel`} role="tabpanel" aria-labelledby={`${id}-overview-tab`} hidden={section !== 'overview'} className="connector-group-details__panel" data-connection-panel="overview">
        {overview}
        {model.waiting ? <button className="agent-connector-text-action" onClick={() => { setSelected({ target: key, action: { kind: 'incoming', label: '', ingressId: model.waiting!.ingressId } }); onSection('diagnostics') }}>Saved input is waiting <span aria-hidden="true">→</span></button> : null}
        <button className="agent-connector-text-action" onClick={() => onSection('sharing')}>Group and sync settings <span aria-hidden="true">→</span></button>
      </div>
      <div id={`${id}-diagnostics-panel`} role="tabpanel" aria-labelledby={`${id}-diagnostics-tab`} hidden={section !== 'diagnostics'} className="connector-group-details__panel" data-connection-panel="diagnostics">
        {diagnostics}
        <ConnectorDeliveryDetails binding={binding} connection={connection} hostingTarget={hostingTarget} active={section === 'diagnostics'} showConfiguration={false} details={details} incomingControl={null}
          observation={{ snapshot, check: onCheck }} selectedProblem={selected?.target === key ? selected : null} onMembers={() => onSection('members')} actions={actions} />
        {configuration}
      </div>
    </>} />
}
