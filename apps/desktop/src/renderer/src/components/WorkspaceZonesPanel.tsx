import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { memo } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { useWorkspaceZoneContext } from '../lib/workspace-zone-context'
import { useAppStore } from '../store'
import { SelectorListHeader, SelectorRow } from './SelectorList'

const CreateWorktreeIcon = semanticIconComponent('action.create-worktree')
const SelectedIcon = semanticIconComponent('status.selected')

export const WorkspaceZonesPanel = memo(function WorkspaceZonesPanel({ workspace, onCreateWorktree, visible = true }: {
  workspace: WorkspaceRecord
  onCreateWorktree(): void
  visible?: boolean
}) {
  const context = useWorkspaceZoneContext(workspace)
  const displayPath = usePathDisplay()

  async function selectZone(zoneId: string): Promise<void> {
    try {
      const result = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(),
        operation: 'focus', target: { kind: 'space', spaceId: context.spaceId, zoneId }, inputPolicy: 'preserve' })
      if (result.operation !== 'focus' || result.navigation.state === 'rejected' || result.navigation.state === 'unconfirmed') {
        const detail = result.operation === 'focus' ? result.issues.map(issue => `${issue.message} ${issue.recovery}`).join('\n') : ''
        useAppStore.getState().reportError(new Error(detail || 'Zone navigation is unconfirmed. The original workface is kept; inspect this Space and retry the exact Zone.'))
      }
    } catch (error) { useAppStore.getState().reportError(error) }
  }

  if (!visible) return null
  return <section className="workspace-zones-panel" aria-label="Zones">
    <SelectorListHeader title="Zones" actions={<button type="button" className="icon-button" aria-label="Create worktree"
      title="Create worktree in Git" onClick={() => onCreateWorktree()}><CreateWorktreeIcon size={14} /></button>} />
    {context.issue ? <p className="workspace-zones-issue" role="status">{context.issue}</p> : null}
    <div className="workspace-zones-list">
      {context.zones.map(zone => {
        const title = zone.branch ?? zone.directoryPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? zone.workspaceId
        const path = zone.directoryPath && zone.hostId ? displayPath(zone.directoryPath, zone.hostId) : null
        const selected = zone.zoneId === context.selectedZoneId
        const detail = path ? `${path} · ${zone.hostId}` : `Resource unknown · ${zone.workspaceId}`
        return <button key={zone.zoneId} type="button" className="workspace-zone-entry" data-zone-id={zone.zoneId}
          aria-pressed={selected} title={[zone.zoneId, zone.issue, zone.kind === 'unknown' ? 'Restore the original Workspace or choose another Zone.' : null].filter(Boolean).join('\n')}
          onClick={() => { void selectZone(zone.zoneId) }}>
          <SelectorRow title={title} subtitle={detail} titleTooltip={`${title}\n${zone.zoneId}`} subtitleTooltip={detail}
            trailing={selected ? <SelectedIcon size={12} aria-label="Selected Zone" /> : null} />
        </button>
      })}
      {!context.zones.length ? <p className="workspace-zones-empty">No Zones are currently confirmed in this Space.</p> : null}
    </div>
  </section>
})
