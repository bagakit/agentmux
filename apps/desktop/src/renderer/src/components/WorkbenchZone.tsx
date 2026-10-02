import type { ReactNode } from 'react'
import { ArrowUpRight, Globe2 } from 'lucide-react'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkbenchProjection } from '../lib/workbench-projection'
import { useAppStore } from '../store'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'

/** A Zone reference loads its original workbenches, never a second content tree. */
export function WorkbenchZone({ zoneId, catalog, projection, viewTargets, visible, leadingChrome, onCreateTab, onStartBrowsing }: {
  zoneId: string
  catalog: AgentMuxSpaceCatalog | null
  projection: WorkbenchProjection | null
  viewTargets: Parameters<typeof WorkspaceWorkbench>[0]['viewTargets']
  visible: boolean
  leadingChrome?: ReactNode
  onCreateTab(displayWorkspaceId: string, groupId: string): void
  onStartBrowsing(): void
}) {
  const zone = catalog?.zones.find(zone => zone.zoneId === zoneId)
  const layout = useAppStore(state => zone ? state.layouts[zone.workspaceId] : undefined)
  const empty = Boolean(zone && !catalog?.tabs.some(tab => tab.zoneId === zoneId))
  const canCreate = empty && zone && layout?.activeGroupId
  return <div className="workbench-zone" data-workbench-zone-id={zoneId}>
    {projection ? <WorkspaceWorkbench key={projection.displayWorkspaceId}
      workspaceId={projection.displayWorkspaceId} projection={projection} viewOwnership="projection" viewTargets={viewTargets}
      onCreateTab={groupId => onCreateTab(projection.displayWorkspaceId, groupId)} leadingChrome={leadingChrome} visible={visible} />
      : <div className="workbench-zone-state" role="status" aria-label={empty ? 'Empty research' : 'Research unavailable'}>
        <div className="workbench-zone-state-orbit" aria-hidden="true"><Globe2 size={32} strokeWidth={1.1} /></div>
        <span className="workbench-zone-state-eyebrow">{empty ? 'A clean slate' : 'Your research is kept'}</span>
        <h2>{empty ? 'Where would you like to go?' : 'This research is unavailable'}</h2>
        <p>{empty ? 'Open a page. Follow an idea.' : 'We can’t open this research right now. Your saved content hasn’t been removed.'}</p>
        <button type="button" className="workbench-zone-state-action" onClick={() => canCreate && zone && layout
          ? onCreateTab(zone.workspaceId, layout.activeGroupId) : onStartBrowsing()}>
          {canCreate ? 'Open a page' : 'Start browsing'}<ArrowUpRight size={15} />
        </button>
      </div>}
  </div>
}
