import { usePathDisplay } from '../hooks/usePathDisplay'
import { ArchiveRestore, NotebookText, Pin, NotebookPen, FolderPlus, Pencil } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MoteIcon } from './MoteIcon'
import { ProjectActivity } from './ProjectActivity'
import { SpaceSectionHeader } from './SpaceSectionHeader'
import type { SessionSnapshot, ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, MOTE_SOUL_PATH, scratchTopicDirectoryName, scratchTopicIdFromWorkspacePath, scratchTopicPhysicalPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { scratchMoteTopics } from '../lib/scratch-topic-snapshots'
import { activeTopicIdFromLayout } from '../lib/scratch-topic-layout'
import type { TopicCategory } from '@agentmux/core/control'
import { isKnowledgeTopicInBindings } from '../../../shared/topic-categories'
import { originalTopicAddress, directoryIdentity } from '../../../shared/space-addresses'
import { TopicCategoryDialog } from './TopicCategoryDialog'
import { orderTopics, partitionPinned } from '../lib/topic-order'
import { rowAttention, rowAttentionLabel } from '../lib/row-attention'
import type { ActivityContextInput } from '../lib/activity-groups'
import { fileNavigationSelection, useAppStore } from '../store'
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
  const displayPath = usePathDisplay()
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
  const selection = useAppStore(state => state.workbenchSpaceSelection)
  const categories = useAppStore(state => state.topicCategories)
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const [categoryTarget, setCategoryTarget] = useState<TopicCategory | 'create' | null>(null)
  const current = selection?.workspaceId === workspace.id ? selection.topicId : layout ? activeTopicIdFromLayout(layout, tabs) : undefined
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
  const entries = topics?.filter(topic => isKnowledgeTopicInBindings(topic, bindings)) ?? []
  const motes = scratchMoteTopics(topics)
  const archive = useMoteArchiveAction(workspace)
  const [showArchived, setShowArchived] = useState(false)
  const tree = useRef<HTMLDivElement>(null)
  const [renameTarget, setRenameTarget] = useState<ScratchTopicSnapshot | null>(null)
  const renameId = useRef<string | null>(null)
  const archivedMotes = motes.filter(topic => topic.moteArchive?.state === 'archived')

  async function openOverview(): Promise<void> {
    try { const preparing = selectWorkspace(workspace.id); useAppStore.setState({ workbenchSpaceSelection: { spaceId: directoryIdentity(workspace.hostId, workspace.path), zoneId: null, workspaceId: workspace.id, topicId: null, tabId: null, groupId: null, regionId: null }, workspaceTool: 'files-branches', toolsOpen: true }); await preparing } catch (cause) { reportError(cause) }
  }
  const pendingOpen = useRef<AbortController | null>(null)
  useEffect(() => () => pendingOpen.current?.abort(), [])
  async function openMote(id: string, edit = false): Promise<boolean> {
    pendingOpen.current?.abort()
    const controller = new AbortController(); pendingOpen.current = controller
    const selected = fileNavigationSelection(useAppStore.getState())
    const cancel = () => controller.abort()
    const unsubscribe = useAppStore.subscribe(state => {
      if (fileNavigationSelection(state) !== selected) cancel()
    })
    // FocusScope and our own reveal restore focus without a new human intent.
    const events = ['pointerdown', 'keydown', 'input'] as const
    for (const event of events) document.addEventListener(event, cancel, true)
    let released = false
    const release = () => {
      if (released) return
      released = true; unsubscribe()
      for (const event of events) document.removeEventListener(event, cancel, true)
      controller.signal.removeEventListener('abort', release)
    }
    controller.signal.addEventListener('abort', release, { once: true })
    try {
      await api.scratch.ensureMote(workspace.id, id)
      if (controller.signal.aborted) return false
      // The original Topic owner fences its own read/reveal. Stop observing before
      // handing it navigation, so its accepted activation is never self-cancelled.
      release()
      const opened = await openTopic(id, workspace.id, { signal: controller.signal })
      if (!opened || controller.signal.aborted) return false
      if (edit) await openFile(`${scratchTopicDirectoryName(id)}/${MOTE_SOUL_PATH}`, undefined, undefined, workspace.id)
      return true
    } catch (cause) { reportError(cause); return false }
    finally { release(); if (pendingOpen.current === controller) pendingOpen.current = null }
  }

  function section(label: 'Motes' | 'Topics', objects: typeof motes, category?: TopicCategory) {
    const key = category ? `topic-category:${category.categoryId}` : `space:${label.toLowerCase()}`
    const heading = category?.title ?? label
    const expanded = filtering || collapsedGroups[key] !== true
    const byId = new Map(objects.map((topic) => [topic.id, topic]))
    const filtered = objects.filter((topic) => matchesSpaceQuery(query, heading, label, topic.title, topic.summary, scratchTopicPhysicalPath(workspace, topic), workspace.hostId))
    const ids = partitionPinned(orderTopics(filtered.map((topic) => topic.id), order), pinned ?? [])
    const sectionSessions = objects.flatMap((topic) => byTopic.get(topic.id) ?? [])
    const contexts: ActivityContextInput[] = objects.flatMap((topic) => {
      const bucket = byTopic.get(topic.id)
      return bucket?.length ? [{ id: topic.id, kind: 'topic', label: topic.id === PMO_TEAMS_TOPIC_ID ? 'Mote' : topic.title,
        hostId: workspace.hostId, path: bucket[0]!.workspacePath }] : []
    })
    const contextById = new Map(contexts.map((context) => [context.id, context]))
    return <nav className={`space-section space-${label.toLowerCase()}-section${category ? " space-topic-category" : ""}`} aria-label={heading} key={key}>
      <div className="space-category-heading"><SpaceSectionHeader label={heading} count={objects.length} icon={label === 'Motes' ? <MoteIcon size={14} /> : <NotebookText size={14} />}
        expanded={expanded} filtering={filtering} onToggle={() => toggleGroup(key)}
        {...(label === 'Topics' ? { onOpen: () => { if (!category) { void openOverview(); return }; useAppStore.setState({ activeWorkspaceId: workspace.id, mainSurface: 'workbench', workspaceTool: 'files-branches', toolsOpen: true, workbenchSpaceSelection: { spaceId: category.spaceId, zoneId: null, workspaceId: workspace.id, topicId: null, tabId: null, groupId: null, regionId: null }, retainedSpatialFocus: null, workbenchNavigationInputPolicy: null }) }, selected: activeWorkspaceId === workspace.id && (category ? selection?.spaceId === category.spaceId && !current : !selection && !current) } : {})}
        navigationId={key} createLabel={label === 'Motes' ? 'Create Mote' : category ? `Create Topic in ${category.title}` : 'Create Topic'} onCreate={() => createTopic(label === 'Motes' ? 'mote' : undefined, undefined, category ? { categoryId: category.categoryId } : undefined)}
        activity={!expanded && sectionSessions.some((session) => session.kind === 'agent') ? <ProjectActivity compact sessions={sectionSessions} contexts={contexts} /> : undefined} />{category ? <button type="button" className="icon-button space-row-action" aria-label={`Rename category ${category.title}`} onClick={() => setCategoryTarget(category)}><Pencil size={11} /></button> : label === 'Topics' ? <button type="button" className="icon-button" aria-label="New Topic category" title="New Topic category" onClick={() => setCategoryTarget('create')}><FolderPlus size={13} /></button> : null}</div>
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
            onNewDiscussion: () => { void openMote(id).then(opened => { if (!opened) return; const state = useAppStore.getState(); const layout = state.layouts[workspace.id]
              if (layout) state.openLauncher({ workspaceId: workspace.id, tabGroupId: layout.activeGroupId, topicId: id, reveal: true }) }) },
            onMaterials: () => { void openMote(id).then(opened => { if (!opened) return; setWorkspaceTool('files-branches'); useAppStore.setState({ toolsOpen: true, explorerCollapsed: { ...useAppStore.getState().explorerCollapsed, [workspace.id]: false } }) }) }
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
              data-space-icon-target={target.key} style={{ '--rail-depth': category ? 2 : 1 } as CSSProperties}
              className={`project-rail-row ${isMote ? 'space-mote-row' : 'space-topic-row'}${selected ? ' project-rail-row--active' : ''}`}
              aria-label={[`Open ${isMote && id !== PMO_TEAMS_TOPIC_ID ? `Mote · ${name}` : name}`, archived ? 'Archived' : '', attentionLabel].filter(Boolean).join(' · ')}
              aria-current={selected ? 'page' : undefined}
              title={[name, topic.readError ?? topic.summary, displayPath(scratchTopicPhysicalPath(workspace, topic), workspace.hostId)].filter(Boolean).join('\n')}
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
          {topic.readError ? <div className="surface-inline-error" role="alert">{name}: {topic.readError}. Its work surface is retained.</div> : null}
          {topic.moteArchive?.state === 'unknown' ? <MoteArchiveNotice workspaceId={workspace.id} issue={topic.moteArchive.issue} /> : null}
        </div></SpaceObjectContextMenu>
      }) : null}
    </nav>
  }
  return <div ref={tree} className="space-topics-tree">
    {section('Motes', motes.filter(topic => topic.moteArchive?.state !== 'archived' || showArchived))}
    <div className="space-section space-topics-section"><SpaceSectionHeader label="Topics" count={entries.length} icon={<NotebookText size={14} />} expanded={filtering || collapsedGroups['space:topics'] !== true} filtering={filtering} onToggle={() => toggleGroup('space:topics')} onOpen={() => void openOverview()} createLabel="Create Topic" onCreate={() => createTopic()} />
      <button type="button" className="small-button space-category-create" onClick={() => setCategoryTarget('create')}><FolderPlus size={12} /> New category</button>
      {filtering || collapsedGroups['space:topics'] !== true ? <>{categories.map(category => section('Topics', entries.filter(topic => {
        const original = originalTopicAddress(workspace, topic, bindings)
        return original && bindings[original.zoneId]?.relations?.[category.spaceId] === true
      }), category))}
      {entries.filter(topic => { const original = originalTopicAddress(workspace, topic, bindings); return !original || !categories.some(category => bindings[original.zoneId]?.relations?.[category.spaceId] === true) }).length ? section('Topics', entries.filter(topic => { const original = originalTopicAddress(workspace, topic, bindings); return !original || !categories.some(category => bindings[original.zoneId]?.relations?.[category.spaceId] === true) })) : null}</> : null}
    </div>
    <TopicCategoryDialog target={categoryTarget} onClose={() => setCategoryTarget(null)} />
    {error ? <div className="surface-inline-error" role="alert">Topics could not be refreshed: {error}. Existing work surfaces remain available.</div> : null}
    <MoteArchiveNotice workspaceId={workspace.id} issue={archive.issue} failure={archive.failure} />
    <MoteRenameDialog target={renameTarget ? { topic: renameTarget, workspace } : null} onClose={() => setRenameTarget(null)}
      returnFocus={() => tree.current?.querySelector<HTMLButtonElement>('[data-space-nav="topic:' + renameId.current + '"]') ?? null} />
  </div>
}
