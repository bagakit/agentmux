import { usePathDisplay } from '../hooks/usePathDisplay'
import { Archive, ArchiveRestore, Check, Ellipsis, NotebookText, Pin, NotebookPen, FolderPlus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MoteIcon } from './MoteIcon'
import { ProjectActivity } from './ProjectActivity'
import { SpaceSectionHeader } from './SpaceSectionHeader'
import { MOTE_DIRECTORY_VIEW_DEFAULT, type SessionSnapshot, type ScratchTopicSnapshot, type WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, MOTE_SOUL_PATH, scratchTopicDirectoryName, scratchTopicPhysicalPath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { useTopicSessions, useTopicSessionPaths } from '../lib/topic-session-subscriptions'
import { scratchMoteTopics } from '../lib/scratch-topic-snapshots'
import { activeTopicIdFromLayout } from '../lib/scratch-topic-layout'
import type { TopicCategory } from '@agentmux/core/control'
import { formatSpaceAddress, formatAmuxSpatialLink } from '@agentmux/core/sharing'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { TopicCategoryContextMenu, TopicCategoryActionsMenu } from './TopicCategoryMenu'
import { isKnowledgeTopicInBindings } from '../../../shared/topic-categories'
import { originalTopicAddress, directoryIdentity } from '../../../shared/space-addresses'
import { TopicCategoryDialog } from './TopicCategoryDialog'
import { orderTopics, partitionPinned } from '../lib/topic-order'
import { rowAttention, rowAttentionLabel } from '../lib/row-attention'
import type { ActivityContextInput } from '../lib/activity-groups'
import { fileNavigationSelection, useAppStore } from '../store'
import { matchesSpaceQuery } from '../lib/space-tree-navigation'
import { categorySpaceIconTarget, topicSpaceIconTarget, type SpaceIconOverrides, type SpaceIconTarget } from '../lib/space-object-appearance'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { SpaceObjectContextMenu } from './SpaceObjectContextMenu'
import { MoteArchiveNotice, useMoteArchiveAction } from './MoteArchiveNotice'
import { MoteRenameDialog } from './MoteRenameDialog'
import '../styles/mote-directory.css'

/** Filesystem objects and existing Session facts; no separate Space or heat registry. */
const NO_TOPICS: readonly ScratchTopicSnapshot[] = []

export function SpaceTopicsTree({ workspace, query = '', icons, onChangeIcon, visible = true }: {
  workspace: WorkspaceRecord; query?: string; visible?: boolean; icons: SpaceIconOverrides; onChangeIcon(target: SpaceIconTarget): void
}) {
  const displayPath = usePathDisplay()
  const { topics, error } = useScratchTopics(workspace.id, visible)
  const layout = useAppStore((state) => state.layouts[workspace.id])
  const tabs = useAppStore((state) => state.tabs)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const directoryView = useAppStore(state => state.config?.moteDirectoryView ?? MOTE_DIRECTORY_VIEW_DEFAULT)
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
  const categoryInvoker = useRef<HTMLElement | null>(null)
  function editCategory(target: TopicCategory | 'create'): void {
    categoryInvoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setCategoryTarget(target)
  }
  const current = selection?.workspaceId === workspace.id ? selection.topicId : layout ? activeTopicIdFromLayout(layout, tabs) : undefined
  const filtering = Boolean(query.trim())
  // One pass through Sessions, using the same host/path owner predicate as the Board.
  const entries = useMemo(() => topics?.filter(topic => isKnowledgeTopicInBindings(topic, bindings)) ?? [], [topics, bindings])
  const motes = useMemo(() => scratchMoteTopics(topics), [topics])
  const sessionPaths = useTopicSessionPaths(workspace, topics ?? NO_TOPICS)
  const motePaths = useMemo(() => motes.flatMap(topic => sessionPaths.get(topic.id) ?? []), [motes, sessionPaths])
  const sessions = useTopicSessions(workspace.hostId, motePaths, [], visible)
  const byTopic = useMemo(() => {
    const topicByPath = new Map(motes.flatMap(topic => (sessionPaths.get(topic.id) ?? []).map(path => [path, topic.id] as const)))
    const index = new Map<string, SessionSnapshot[]>()
    for (const session of sessions) {
      const id = topicByPath.get(session.workspacePath)
      if (!id) continue
      const bucket = index.get(id) ?? []
      bucket.push(session); index.set(id, bucket)
    }
    return index
  }, [sessions, motes, sessionPaths])
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

  function moteSection(objects: typeof motes) {
    const label = 'Motes', key = 'space:motes', heading = label
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
    return <nav className="space-section space-motes-section" aria-label={heading}>
      <div className="space-category-heading"><SpaceSectionHeader label={heading} count={objects.length} icon={<MoteIcon size={14} />}
        expanded={expanded} filtering={filtering} onToggle={() => toggleGroup(key)}
        navigationId={key} createLabel="Create Mote" onCreate={() => createTopic('mote')}
        actions={<button type="button" className="icon-button mote-directory-archive" aria-label="Show archived Motes in Space"
          aria-pressed={showArchived} title={`${showArchived ? 'Hide' : 'Show'} archived Motes · ${archivedMotes.length}`}
          onClick={() => setShowArchived(value => !value)}><Archive size={13} /><span>{archivedMotes.length}</span></button>}
        activity={!expanded && sectionSessions.some((session) => session.kind === 'agent') ? <ProjectActivity compact visible={visible} sessions={sectionSessions} contexts={contexts} /> : undefined} /></div>
      {filtering && ids.length === 0 ? <p className="space-tree-empty" role="status">No matching {label}</p> : null}
      <div className="mote-directory" data-mote-directory-view={directoryView}>
      {expanded ? ids.map((id) => {
        const topic = byId.get(id)!
        const isMote = true
        const name = topic.title
        const target = topicSpaceIconTarget(workspace, { ...topic, title: name }, bindings)
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
              data-space-icon-target={target?.key} style={{ '--rail-depth': 1 } as CSSProperties}
              className={`project-rail-row ${isMote ? 'space-mote-row' : 'space-topic-row'}${selected ? ' project-rail-row--active' : ''}`}
              aria-label={[`Open ${isMote && id !== PMO_TEAMS_TOPIC_ID ? `Mote · ${name}` : name}`, archived ? 'Archived' : '', attentionLabel].filter(Boolean).join(' · ')}
              aria-current={selected ? 'page' : undefined}
              title={[name, topic.readError ?? topic.summary, displayPath(scratchTopicPhysicalPath(workspace, topic), workspace.hostId)].filter(Boolean).join('\n')}
              onClick={() => isMote ? void openMote(id) : void openTopic(id, workspace.id).catch(reportError)}>
              <SpaceObjectIcon kind={isMote ? 'mote' : 'topic'} name={name} manualIcon={target ? icons[target.key] ?? null : null} imageTarget={target?.imageTarget} avatarObjectKey={target?.key} avatarWorkspaceId={target?.avatarTarget?.workspaceId} avatarTopicId={target?.avatarTarget?.topicId} visible={visible} />
              <span className="project-rail-row__identity"><strong>{name}</strong>{archived ? <small>Archived</small> : null}</span>
              {selected ? <Check className="mote-directory-current" size={11} aria-hidden="true" /> : null}
            </button>
            <button type="button" className="icon-button space-row-action mote-directory-more" aria-label={`More actions for ${name}`} title={`More actions for ${name}`}
              onClick={event => {
                const rect = event.currentTarget.getBoundingClientRect()
                event.currentTarget.closest('[data-space-entry]')?.dispatchEvent(new MouseEvent('contextmenu', {
                  bubbles: true, cancelable: true, button: 2, clientX: rect.left, clientY: rect.bottom
                }))
              }}><Ellipsis size={14} /></button>
            <button type="button" className={`icon-button space-row-action space-pin${isPinned ? ' space-pin--pinned' : ''}`}
              aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${name}`} aria-pressed={isPinned} title={`${isPinned ? 'Unpin' : 'Pin'} ${name}`}
              onClick={togglePin}><Pin size={11} /></button>
            {isMote ? <button type="button" className="icon-button space-row-action space-mote-edit" aria-label={`Edit ${name} SOUL.md`}
              title="Edit SOUL.md · New sessions use saved changes" onClick={editMote}><NotebookPen size={12} /></button> : null}
            {archived ? <button type="button" className="icon-button space-row-action" aria-label={`Restore Mote ${name}`} title="Restore Mote"
              disabled={archive.pending === id} onClick={() => void archive.change(topic, false)}><ArchiveRestore size={12} /></button> : null}
            {bucket.some((session) => session.kind === 'agent') ? <ProjectActivity compact visible={visible} sessions={bucket} contexts={contextById.has(id) ? [contextById.get(id)!] : []} /> : null}
          </div>
          {topic.readError ? <div className="surface-inline-error" role="alert">{name}: {topic.readError}. Its work surface is retained.</div> : null}
          {topic.moteArchive?.state === 'unknown' ? <MoteArchiveNotice workspaceId={workspace.id} issue={topic.moteArchive.issue} /> : null}
        </div></SpaceObjectContextMenu>
      }) : null}
      </div>
    </nav>
  }
  const { categoryTopics, uncategorized } = useMemo(() => {
    const categoryTopics = new Map(categories.map(category => [category.spaceId, [] as ScratchTopicSnapshot[]]))
    const uncategorized: ScratchTopicSnapshot[] = []
    for (const topic of entries) {
      const original = originalTopicAddress(workspace, topic, bindings)
      const members = original ? categories.filter(category => bindings[original.zoneId]?.relations?.[category.spaceId] === true) : []
      if (!members.length) uncategorized.push(topic)
      else for (const category of members) categoryTopics.get(category.spaceId)!.push(topic)
    }
    return { categoryTopics, uncategorized }
  }, [categories, entries, workspace, bindings])
  const matchingCategories = categories.filter(category => matchesSpaceQuery(query, 'Topics', category.title, category.directoryPath, category.hostId) ||
    categoryTopics.get(category.spaceId)!.some(topic => matchesSpaceQuery(query, 'Topics', category.title, topic.title, topic.summary, scratchTopicPhysicalPath(workspace, topic), workspace.hostId)))
  return <div ref={tree} className="space-topics-tree">
    {moteSection(motes.filter(topic => topic.moteArchive?.state !== 'archived' || showArchived))}
    <div className="space-section space-topics-section"><SpaceSectionHeader label="Topics" count={categories.length} icon={<NotebookText size={14} />}
      expanded={filtering || collapsedGroups['space:topics'] !== true} filtering={filtering} onToggle={() => toggleGroup('space:topics')}
      onOpen={() => void openOverview()} createLabel="Create Category" createIcon={<FolderPlus size={13} />}
      onCreate={async () => editCategory('create')} />
      {filtering || collapsedGroups['space:topics'] !== true ? <>
        {matchingCategories.map(category => {
          const target = categorySpaceIconTarget(category)
          const actions = { target, onChangeIcon, onRename: () => editCategory(category),
            onCopyCard: () => void copyTextToClipboard(formatSpaceAddress({ spaceId: category.spaceId, label: category.title }), reportError),
            onCopyLink: () => void copyTextToClipboard(formatAmuxSpatialLink({ kind: 'space', spaceId: category.spaceId }), reportError) }
          return <nav className="space-topic-category" aria-label={category.title} key={category.categoryId}>
            <TopicCategoryContextMenu {...actions}>
              <div className="space-category-heading"><SpaceSectionHeader label={category.title} count={categoryTopics.get(category.spaceId)!.length}
                icon={<SpaceObjectIcon kind="category" name={category.title} manualIcon={icons[target.key] ?? null} imageTarget={target.imageTarget} />} iconTargetKey={target.key}
                expanded={false} filtering={filtering} collapsible={false} onToggle={() => {}}
                navigationId={'topic-category:' + category.categoryId} parentNavigationId="space:topics"
                selected={activeWorkspaceId === workspace.id && selection?.spaceId === category.spaceId}
                onOpen={() => useAppStore.setState({ activeWorkspaceId: workspace.id, mainSurface: 'workbench', workspaceTool: 'files-branches', toolsOpen: true,
                  workbenchSpaceSelection: { spaceId: category.spaceId, zoneId: null, workspaceId: workspace.id, topicId: null, tabId: null, groupId: null, regionId: null },
                  retainedSpatialFocus: null, workbenchNavigationInputPolicy: null })} />
                <TopicCategoryActionsMenu {...actions} />
              </div>
            </TopicCategoryContextMenu>
            {category.readError ? <div className="surface-inline-error" role="status">{category.readError}</div> : null}
          </nav>
        })}
        {filtering && matchingCategories.length === 0 ? <p className="space-tree-empty" role="status">No matching Topics</p> : null}
        {uncategorized.length ? <p className="space-tree-empty" role="status">Category not confirmed for {uncategorized.length} Topic{uncategorized.length === 1 ? '' : 's'}. Open Topics overview to access them.</p> : null}
      </> : null}
    </div>
    <TopicCategoryDialog target={categoryTarget} onClose={() => setCategoryTarget(null)} returnFocus={() => categoryInvoker.current?.isConnected ? categoryInvoker.current : null} />
    {error ? <div className="surface-inline-error" role="alert">Topics could not be refreshed: {error}. Existing work surfaces remain available.</div> : null}
    <MoteArchiveNotice workspaceId={workspace.id} issue={archive.issue} failure={archive.failure} />
    <MoteRenameDialog target={renameTarget ? { topic: renameTarget, workspace } : null} onClose={() => setRenameTarget(null)}
      returnFocus={() => tree.current?.querySelector<HTMLButtonElement>('[data-space-nav="topic:' + renameId.current + '"]') ?? null} />
  </div>
}
