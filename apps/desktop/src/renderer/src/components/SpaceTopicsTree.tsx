import { ArchiveRestore, NotebookText, Pin, NotebookPen } from 'lucide-react'
import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { MoteIcon } from './MoteIcon'
import { ProjectActivity } from './ProjectActivity'
import { SpaceSectionHeader } from './SpaceSectionHeader'
import type { SessionSnapshot, ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, MOTE_SOUL_PATH, scratchTopicDirectoryName, scratchTopicIdFromWorkspacePath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { scratchMoteTopics } from '../lib/scratch-topic-snapshots'
import { activeTopicIdFromLayout } from '../lib/scratch-topic-layout'
import { orderTopics, partitionPinned } from '../lib/topic-order'
import { rowAttention, rowAttentionLabel } from '../lib/row-attention'
import type { ActivityContextInput } from '../lib/activity-groups'
import { useAppStore } from '../store'
import { matchesSpaceQuery } from '../lib/space-tree-navigation'
import { topicSpaceIconTarget, type SpaceIconOverrides, type SpaceIconTarget } from '../lib/space-object-appearance'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { SpaceObjectContextMenu } from './SpaceObjectContextMenu'
import { MoteArchiveNotice, useMoteArchiveAction } from './MoteArchiveNotice'
import { MoteRenameDialog } from './MoteRenameDialog'

/** Filesystem objects and existing Session facts; no separate Space or heat registry. */
export function SpaceTopicsTree({ workspace, query = '', icons, onChangeIcon }: {
  workspace: WorkspaceRecord; query?: string; icons: SpaceIconOverrides; onChangeIcon(target: SpaceIconTarget): void
}) {
  const { topics, error } = useScratchTopics(workspace.id)
  const layout = useAppStore((state) => state.layouts[workspace.id])
  const tabs = useAppStore((state) => state.tabs)
  const sessions = useAppStore((state) => state.sessions)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const order = useAppStore((state) => state.scratchTopicOrder)
  const pinned = useAppStore((state) => state.pinnedItems[SCRATCH_WORKSPACE_ID])
  const collapsedGroups = useAppStore((state) => state.collapsedProjectGroups)
  const toggleGroup = useAppStore((state) => state.toggleProjectGroup)
  const togglePinned = useAppStore((state) => state.togglePinnedItem)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const openTopic = useAppStore((state) => state.openScratchTopic)
  const createTopic = useAppStore((state) => state.createScratchTopic)
  const reportError = useAppStore((state) => state.reportError)
  const openFile = useAppStore((state) => state.openFile)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const current = layout ? activeTopicIdFromLayout(layout, tabs) : undefined
  const filtering = Boolean(query.trim())
  // One pass through Sessions, using the same host/path owner predicate as the Board.
  const byTopic = useMemo(() => {
    const index = new Map<string, SessionSnapshot[]>()
    for (const session of sessions) {
      if (session.hostId !== workspace.hostId) continue
      const id = scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath)
      if (!id) continue
      const bucket = index.get(id)
      if (bucket) bucket.push(session)
      else index.set(id, [session])
    }
    return index
  }, [sessions, workspace.hostId, workspace.path])
  const entries = topics?.filter((topic) => topic.id !== PMO_TEAMS_TOPIC_ID && !topic.soul) ?? []
  const motes = scratchMoteTopics(topics)
  const archive = useMoteArchiveAction(workspace)
  const [showArchived, setShowArchived] = useState(false)
  const tree = useRef<HTMLDivElement>(null)
  const [renameTarget, setRenameTarget] = useState<ScratchTopicSnapshot | null>(null)
  const renameId = useRef<string | null>(null)
  const archivedMotes = motes.filter(topic => topic.moteArchive?.state === 'archived')

  async function openOverview(): Promise<void> {
    try { await selectWorkspace(workspace.id); setWorkspaceTool('files-branches') } catch (cause) { reportError(cause) }
  }
  async function openMote(id: string, edit = false): Promise<void> {
    try {
      await api.scratch.ensureMote(workspace.id, id)
      await openTopic(id, workspace.id)
      if (edit) await openFile(`${scratchTopicDirectoryName(id)}/${MOTE_SOUL_PATH}`, undefined, undefined, workspace.id)
    } catch (cause) { reportError(cause) }
  }

  function section(label: 'Motes' | 'Topics', objects: typeof motes) {
    const key = `space:${label.toLowerCase()}`
    const expanded = filtering || collapsedGroups[key] !== true
    const byId = new Map(objects.map((topic) => [topic.id, topic]))
    const filtered = objects.filter((topic) => matchesSpaceQuery(query, label, topic.title, topic.summary, topic.directoryPath, workspace.hostId))
    const ids = partitionPinned(orderTopics(filtered.map((topic) => topic.id), order), pinned ?? [])
    const sectionSessions = objects.flatMap((topic) => byTopic.get(topic.id) ?? [])
    const contexts: ActivityContextInput[] = objects.flatMap((topic) => {
      const bucket = byTopic.get(topic.id)
      return bucket?.length ? [{ id: topic.id, kind: 'topic', label: topic.id === PMO_TEAMS_TOPIC_ID ? 'Mote' : topic.title,
        hostId: workspace.hostId, path: bucket[0]!.workspacePath }] : []
    })
    const contextById = new Map(contexts.map((context) => [context.id, context]))
    return <nav className={`space-section space-${label.toLowerCase()}-section`} aria-label={label} key={label}>
      <SpaceSectionHeader label={label} count={objects.length} icon={label === 'Motes' ? <MoteIcon size={14} /> : <NotebookText size={14} />}
        expanded={expanded} filtering={filtering} onToggle={() => toggleGroup(key)}
        {...(label === 'Topics' ? { onOpen: () => void openOverview(), selected: activeWorkspaceId === workspace.id && !current } : {})}
        createLabel={label === 'Motes' ? 'Create Mote' : 'Create Topic'} onCreate={() => createTopic(label === 'Motes' ? 'mote' : undefined)}
        activity={!expanded && sectionSessions.some((session) => session.kind === 'agent') ? <ProjectActivity compact sessions={sectionSessions} contexts={contexts} /> : undefined} />
      {label === 'Motes' ? <button type="button" className="space-section-label" aria-label="Show archived Motes in Space"
        aria-pressed={showArchived} onClick={() => setShowArchived(value => !value)}><strong>{showArchived ? 'Hide archived' : 'Show archived'}</strong><small>{archivedMotes.length}</small></button> : null}
      {filtering && ids.length === 0 ? <p className="space-tree-empty" role="status">No matching {label}</p> : null}
      {expanded ? ids.map((id) => {
        const topic = byId.get(id)!
        const isMote = label === 'Motes'
        const name = topic.title
        const target = topicSpaceIconTarget(workspace, { ...topic, title: name })
        const selected = activeWorkspaceId === workspace.id && current === id
        const bucket = byTopic.get(id) ?? []
        const attentionLabel = rowAttentionLabel(rowAttention(bucket))
        const isPinned = pinned?.includes(id) === true
        const archived = topic.moteArchive?.state === 'archived'
        const togglePin = () => togglePinned(SCRATCH_WORKSPACE_ID, id), editMote = () => void openMote(id, true)
        return <SpaceObjectContextMenu key={id} target={target} onChangeIcon={onChangeIcon} {...(isMote ? {
          moteActions: { pinned: isPinned, onTogglePin: togglePin, onEdit: editMote,
            onRename: () => { renameId.current = topic.id; setRenameTarget(topic) },
            onNewDiscussion: () => { void openMote(id).then(() => { const state = useAppStore.getState(); const layout = state.layouts[workspace.id]
              if (layout) state.openLauncher({ workspaceId: workspace.id, tabGroupId: layout.activeGroupId, topicId: id, reveal: true }) }) },
            onMaterials: () => { void openMote(id).then(() => { setWorkspaceTool('files-branches'); useAppStore.setState({ toolsOpen: true, explorerCollapsed: { ...useAppStore.getState().explorerCollapsed, [workspace.id]: false } }) }) }
          }, moteArchive: {
          archived, disabled: archive.pending === id || id === PMO_TEAMS_TOPIC_ID || !topic.moteArchive || topic.moteArchive.state === 'unknown',
          ...(id === PMO_TEAMS_TOPIC_ID ? { reason: 'Primary Mote cannot be archived' } : {}),
          onChange: () => archive.change(topic, !archived),
          returnFocus: () => {
            const state = useAppStore.getState(), resource = state.config?.workspaces.find(item => item.id === workspace.id)
            if (resource?.hostId !== workspace.hostId || resource.path !== workspace.path || state.activeWorkspaceId !== activeWorkspaceId) return null
            return tree.current?.querySelector<HTMLButtonElement>('[aria-label="Show archived Motes in Space"]') ?? null
          }
        } } : {})}>
        <div className={`space-tree-entry${isMote ? ' space-mote-entry' : ''}`} data-space-entry data-mote-archive-state={isMote ? topic.moteArchive?.state : undefined}>
          <div className="project-rail-entry">
            <button type="button" data-space-nav={`topic:${id}`} data-space-parent={key}
              data-space-icon-target={target.key} style={{ '--rail-depth': 1 } as CSSProperties}
              className={`project-rail-row ${isMote ? 'space-mote-row' : 'space-topic-row'}${selected ? ' project-rail-row--active' : ''}`}
              aria-label={[`Open ${isMote && id !== PMO_TEAMS_TOPIC_ID ? `Mote · ${name}` : name}`, archived ? 'Archived' : '', attentionLabel].filter(Boolean).join(' · ')}
              aria-current={selected ? 'page' : undefined}
              title={[name, topic.readError ?? topic.summary, topic.directoryPath].filter(Boolean).join('\n')}
              onClick={() => isMote ? void openMote(id) : void openTopic(id, workspace.id).catch(reportError)}>
              <SpaceObjectIcon kind={isMote ? 'mote' : 'topic'} name={name} manualIcon={icons[target.key] ?? null} avatarObjectKey={target.key} avatarWorkspaceId={target.avatarTarget?.workspaceId} avatarTopicId={target.avatarTarget?.topicId} />
              <span className="project-rail-row__identity"><strong>{name}</strong>{archived ? <small>Archived</small> : null}</span>
            </button>
            <button type="button" className={`icon-button space-row-action space-pin${isPinned ? ' space-pin--pinned' : ''}`}
              aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${name}`} aria-pressed={isPinned} title={`${isPinned ? 'Unpin' : 'Pin'} ${name}`}
              onClick={togglePin}><Pin size={11} /></button>
            {isMote ? <button type="button" className="icon-button space-row-action space-mote-edit" aria-label={`Edit ${name} SOUL.md`}
              title="Edit SOUL.md · New sessions use saved changes" onClick={editMote}><NotebookPen size={12} /></button> : null}
            {archived ? <button type="button" className="icon-button space-row-action" aria-label={`Restore Mote ${name}`} title="Restore Mote"
              disabled={archive.pending === id} onClick={() => void archive.change(topic, false)}><ArchiveRestore size={12} /></button> : null}
            {bucket.some((session) => session.kind === 'agent') ? <ProjectActivity compact sessions={bucket} contexts={contextById.has(id) ? [contextById.get(id)!] : []} /> : null}
          </div>
          {topic.readError ? <div className="new-tab-error" role="alert">{name}: {topic.readError}. Its work surface is retained.</div> : null}
          {topic.moteArchive?.state === 'unknown' ? <MoteArchiveNotice workspaceId={workspace.id} issue={topic.moteArchive.issue} /> : null}
        </div></SpaceObjectContextMenu>
      }) : null}
    </nav>
  }
  return <div ref={tree} className="space-topics-tree">
    {section('Motes', motes.filter(topic => topic.moteArchive?.state !== 'archived' || showArchived))}
    {section('Topics', entries)}
    {error ? <div className="new-tab-error" role="alert">Topics could not be refreshed: {error}. Existing work surfaces remain available.</div> : null}
    <MoteArchiveNotice workspaceId={workspace.id} issue={archive.issue} />
    <MoteRenameDialog target={renameTarget ? { topic: renameTarget, workspace } : null} onClose={() => setRenameTarget(null)}
      returnFocus={() => tree.current?.querySelector<HTMLButtonElement>('[data-space-nav="topic:' + renameId.current + '"]') ?? null} />
  </div>
}
