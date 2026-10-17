import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { memo, useMemo, type KeyboardEvent, type ReactNode } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { useWorkspaceZoneContext } from '../lib/workspace-zone-context'
import { useAppStore } from '../store'
import { summarizeRelatedPath } from '../lib/copy-path-display'
import { workspaceProjectId } from '../lib/workspace-projects'
import { SelectorListHeader, SelectorRow } from './SelectorList'
import { useZoneWorktrees } from '../hooks/useZoneWorktrees'

const FolderIcon = semanticIconComponent('object.folder')
const WorktreeIcon = semanticIconComponent('object.repository')
const BranchIcon = semanticIconComponent('object.branch')
const UnknownIcon = semanticIconComponent('status.unknown')
const NextIcon = semanticIconComponent('navigation.forward')
const SelectedIcon = semanticIconComponent('status.selected')
const RefreshIcon = semanticIconComponent('action.refresh')
const KIND_LABELS = { directory: 'Folder', worktree: 'Worktree', home: 'Home', unknown: 'Unknown' } as const

export const WorkspaceZonesPanel = memo(function WorkspaceZonesPanel({ workspace, onManageWorktrees, visible = true, footer }: {
  workspace: WorkspaceRecord
  onManageWorktrees(): void
  visible?: boolean
  footer?: ReactNode
}) {
  const context = useWorkspaceZoneContext(workspace)
  const displayPath = usePathDisplay()
  const workspaces = useAppStore(state => state.config?.workspaces)
  const resources = useMemo(() => new Map(workspaces?.map(value => [value.id, value])), [workspaces])
  const git = useZoneWorktrees(context.spaceId, workspace, visible)
  const worktrees = useMemo(() => new Map(git.snapshot?.kind === 'ready' ? git.snapshot.worktrees.flatMap(value => [value.path, ...value.aliases].map(path => [path, value] as const)) : []), [git.snapshot])

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return
    const rows = [...event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[data-zone-id]')]
    const index = rows.indexOf(event.currentTarget)
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1)
      : event.key === 'ArrowUp' ? Math.max(index - 1, 0)
        : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : null
    if (next === null) return
    event.preventDefault()
    rows[next]?.focus({ preventScroll: true })
    rows[next]?.scrollIntoView({ block: 'nearest' })
  }

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
    <SelectorListHeader title="Zones" count={context.zones.length} actions={<>
      <button type="button" className="icon-button" aria-label="Refresh Zone Git metadata" title="Refresh current worktree branches" aria-busy={git.loading} onClick={() => { void git.refresh() }}><RefreshIcon size={12} /></button>
      <button type="button" className="workspace-zones-manage" aria-label="Manage worktrees"
      title="Manage worktrees in Git" onClick={() => onManageWorktrees()}>Worktrees<NextIcon size={12} aria-hidden="true" /></button></>} />
    {context.issue ? <p className="workspace-zones-issue" role="status">{context.issue}</p> : null}
    {git.issue ? <p className="workspace-zones-issue" role="status">Git metadata unavailable: {git.issue} {git.snapshot ? 'Last observation is shown.' : 'Existing Zones remain available.'} Refresh to retry.</p> : null}
    {git.snapshot?.kind === 'ready' && git.snapshot.warnings.length ? <p className="workspace-zones-issue" role="status">{git.snapshot.warnings.join(' ')}</p> : null}
    <div className="workspace-zones-list" role="group" aria-label="Zone working directories">
      {context.zones.map(zone => {
        const original = resources.get(zone.workspaceId)
        const resource = original?.hostId === zone.hostId && original.path === zone.directoryPath ? original : null
        const title = resource?.name ?? zone.directoryPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? zone.workspaceId
        const path = zone.directoryPath && zone.hostId ? displayPath(zone.directoryPath, zone.hostId) : null
        const related = resource && resource.hostId === workspace.hostId && workspaceProjectId(resource) === workspaceProjectId(workspace)
        const pathLabel = path && related ? summarizeRelatedPath(zone.directoryPath!, workspace.repoPath ?? workspace.path, path) : path
        const selected = zone.zoneId === context.selectedZoneId
        const detail = path ? `${path} · ${zone.hostId}` : `Resource unknown · ${zone.workspaceId}`
        const observed = zone.kind !== 'unknown' && zone.hostId === git.snapshot?.hostId && zone.directoryPath ? worktrees.get(zone.directoryPath) : undefined
        const nonGit = zone.kind !== 'unknown' && git.snapshot?.kind === 'not-a-git-repository' && zone.hostId === git.snapshot.hostId && zone.directoryPath === git.snapshot.workspacePath
        const kind = zone.kind === 'home' || zone.kind === 'unknown' ? zone.kind : observed ? observed.kind === 'linked' ? 'worktree' : 'directory' : nonGit ? 'directory' : zone.kind
        const branch = observed ? observed.detached ? 'Detached HEAD' : observed.branch : null
        const gitState = observed || nonGit ? git.stale ? 'stale' : 'current' : 'unknown'
        const kindLabel = observed?.kind === 'bare' ? 'Bare repository' : KIND_LABELS[kind]
        const observation = gitState === 'stale' ? 'Last observed' : gitState === 'unknown' && kind !== 'home' && kind !== 'unknown' ? 'Git unknown' : null
        const KindIcon = kind === 'worktree' ? WorktreeIcon : kind === 'unknown' ? UnknownIcon : FolderIcon
        return <button key={zone.zoneId} type="button" className="workspace-zone-entry" data-zone-id={zone.zoneId} data-zone-kind={kind} data-zone-git-state={gitState}
          aria-pressed={selected} title={[title, branch, detail, zone.zoneId, zone.issue, observation,
            observed || nonGit ? `Git observed: ${new Date(git.snapshot!.checkedAt).toLocaleString()}` : 'Current Git relationship is unconfirmed.',
            zone.kind === 'unknown' ? 'Restore the original Workspace or choose another Zone.' : 'Open the existing Zone workface.'].filter(Boolean).join('\n')}
          onKeyDown={moveFocus}
          onClick={() => { void selectZone(zone.zoneId) }}>
          <SelectorRow leading={<KindIcon size={14} aria-hidden="true" />} title={<><span className="workspace-zone-entry__name">{title}</span>
            {branch && branch !== title ? <span className="workspace-zone-entry__branch"><BranchIcon size={10} aria-hidden="true" />{branch}</span> : null}</>}
            subtitle={<><span className="workspace-zone-entry__kind">{kindLabel}</span>
              {pathLabel ? <><span aria-hidden="true">·</span><span className="workspace-zone-entry__path">{pathLabel}</span></> : null}
              {observation ? <span className="workspace-zone-entry__observation">{observation}</span> : null}
              {zone.hostId && zone.hostId !== 'local' ? <span className="workspace-zone-entry__host">{zone.hostId}</span> : null}</>}
            titleTooltip={[title, branch, zone.zoneId].filter(Boolean).join('\n')} subtitleTooltip={detail}
            trailing={selected ? <SelectedIcon size={12} aria-label="Selected Zone" /> : null} />
        </button>
      })}
      {!context.zones.length ? <p className="workspace-zones-empty">No Zones are currently confirmed in this Space.</p> : null}
    </div>
    {footer ? <div className="workspace-zones-footer">{footer}</div> : null}
  </section>
})
