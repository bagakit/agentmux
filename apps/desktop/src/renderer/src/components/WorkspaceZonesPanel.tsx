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
import { directoryStatus, unrepresentedWorktrees, worktreeKind } from '../lib/zone-worktree-observation'

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
  const ready = git.snapshot?.kind === 'ready' ? git.snapshot : null
  const notHere = ready && !git.stale ? unrepresentedWorktrees(ready, context.zones, git.directories) : null
  const directories = useMemo(() => new Map(git.directories.map(value => [value.path, value])), [git.directories])

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return
    const rows = [...event.currentTarget.closest('.workspace-zones-list')!.querySelectorAll<HTMLButtonElement>('[data-zone-id]')]
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
    <SelectorListHeader title="Working directories" count={context.zones.length} actions={<button type="button" className="icon-button" aria-label="Refresh Zone Git metadata" title="Refresh directories and worktrees" aria-busy={git.loading} onClick={() => { void git.refresh() }}><RefreshIcon size={12} /></button>} />
    <div className="workspace-zones-scope"><span>Saved in this Space</span><button type="button" className="workspace-zones-manage" aria-label="Manage worktrees"
      title="View all Git worktrees; viewing does not add working directories to this Space" onClick={() => onManageWorktrees()}>All worktrees{ready ? ` ${ready.worktrees.length}` : ''}<NextIcon size={12} aria-hidden="true" /></button>
      {ready && !git.stale && notHere !== null ? <span>{notHere} not in this Space</span> : null}
      {ready && git.stale ? <span>Last observed</span> : null}</div>
    {context.issue ? context.files && !context.resource
      ? <details className="workspace-zones-notice">
        <summary>Files available. Use a repository working directory for Git.</summary>
        <p>{context.issue}</p>
      </details>
      : <details className="workspace-zones-notice workspace-zones-notice--issue"><summary>Selected directory is unconfirmed.</summary><p role="status">{context.issue}</p></details> : null}
    {git.issue || ready?.warnings.length ? <details className="workspace-zones-notice workspace-zones-notice--issue">
      <summary role="status">{git.issue ? `Git update unavailable.${ready ? ' Last observation is shown.' : ''}` : 'Some directory relationships are unconfirmed.'} Refresh to retry.</summary>
      <p>{[git.issue, ...ready?.warnings ?? []].filter(Boolean).join('\n')}</p>
    </details> : null}
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
        const directory = zone.kind !== 'unknown' && zone.hostId === git.directoryObservation?.hostId && zone.directoryPath ? directories.get(zone.directoryPath) : undefined
        const presentUnlisted = directory?.kind === 'directory' && !git.directoryStale && ready && !git.stale && !ready.warnings.length && !observed
        const kind = zone.kind === 'home' || zone.kind === 'unknown' ? zone.kind : observed ? observed.kind === 'linked' ? 'worktree' : 'directory' : nonGit || presentUnlisted ? 'directory' : zone.kind
        const branch = observed ? observed.detached ? 'Detached HEAD' : observed.branch : null
        const gitState = observed || nonGit ? git.stale ? 'stale' : 'current' : 'unknown'
        const pathIssue = directoryStatus(directory)
        const kindLabel = kind === 'home' ? 'Home' : observed ? worktreeKind(observed) : zone.kind === 'directory' && selected && context.files?.rootPath && context.files.directoryPath === zone.directoryPath ? 'Subdirectory' : kind === 'worktree' ? 'Saved worktree' : KIND_LABELS[kind]
        const observation = gitState === 'stale' ? 'Last observed' : null
        const relationship = !observed && !nonGit && kind !== 'home' && kind !== 'unknown' && !pathIssue ? presentUnlisted ? 'Not listed as a worktree here' : 'Git relationship unconfirmed' : null
        const rowIssue = pathIssue ?? relationship ?? (zone.kind === 'unknown' ? 'Resource unconfirmed' : null)
        const KindIcon = kind === 'worktree' ? WorktreeIcon : kind === 'unknown' ? UnknownIcon : FolderIcon
        return <div className="workspace-zone-item" key={zone.zoneId}><button type="button" className="workspace-zone-entry" data-zone-id={zone.zoneId} data-zone-kind={kind} data-zone-git-state={gitState}
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
          {rowIssue ? <details className="workspace-zone-details"><summary>{rowIssue}{pathIssue && git.directoryStale ? ' · Last checked' : ''}</summary><p>{zone.issue ?? (directory?.kind === 'unavailable' ? directory.reason : pathIssue ? `${zone.directoryPath} — ${pathIssue}. The saved workface is kept.` : presentUnlisted ? 'This directory is present but is not listed as a worktree in this repository. Its Git relationship elsewhere has not been checked.' : 'The current Git relationship of this saved directory has not been confirmed. Files and the original workface remain available when their resource is confirmed.')}
            {zone.directoryPath ? `\n${zone.hostId} · ${zone.directoryPath}` : ''}
            {git.directoryObservation ? `\n${git.directoryStale ? 'Last checked' : 'Checked'} ${new Date(git.directoryObservation.checkedAt).toLocaleString()}.` : ''} Refresh to retry.</p></details> : null}
        </div>
      })}
      {!context.zones.length ? <p className="workspace-zones-empty">No working directories are saved in this Space.</p> : null}
    </div>
    {footer ? <div className="workspace-zones-footer">{footer}</div> : null}
  </section>
})
