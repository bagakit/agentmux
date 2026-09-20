import { NotebookText, Pin, NotebookPen } from 'lucide-react'
import { useMemo } from 'react'
import { MoteIcon } from './MoteIcon'
import { ProjectActivity } from './ProjectActivity'
import { SpaceSectionHeader } from './SpaceSectionHeader'
import type { SessionSnapshot, ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, MOTE_SOUL_PATH, scratchTopicDirectoryName, scratchTopicIdFromWorkspacePath } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { activeTopicIdFromLayout } from '../lib/scratch-topic-layout'
import { orderTopics, partitionPinned } from '../lib/topic-order'
import { rowAttention, rowAttentionLabel } from '../lib/row-attention'
import type { ActivityContextInput } from '../lib/activity-groups'
import { useAppStore } from '../store'
import { matchesSpaceQuery } from '../lib/space-tree-navigation'

/** Filesystem objects and existing Session facts; no separate Space or heat registry. */
export function SpaceTopicsTree({ workspace, query = '' }: { workspace: WorkspaceRecord; query?: string }) {
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
  const defaultMote = topics?.find((topic) => topic.id === PMO_TEAMS_TOPIC_ID) ?? {
    id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: '', directoryPath: scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID),
    topicPath: `${scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)}/topic.md`, collaborators: []
  }
  const motes: ScratchTopicSnapshot[] = [defaultMote, ...(topics?.filter((topic) => topic.id !== PMO_TEAMS_TOPIC_ID && topic.soul) ?? [])]

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
      {filtering && ids.length === 0 ? <p className="space-tree-empty" role="status">No matching {label}</p> : null}
      {expanded ? ids.map((id) => {
        const topic = byId.get(id)!
        const isMote = label === 'Motes'
        const name = id === PMO_TEAMS_TOPIC_ID ? 'Mote' : topic.title
        const selected = activeWorkspaceId === workspace.id && current === id
        const bucket = byTopic.get(id) ?? []
        const attentionLabel = rowAttentionLabel(rowAttention(bucket))
        const isPinned = pinned?.includes(id) === true
        return <div key={id} className="space-tree-entry" data-space-entry>
          <div className="project-rail-entry">
            <button type="button" data-space-nav={`topic:${id}`} data-space-parent={key}
              className={`project-rail-row ${isMote ? 'space-mote-row' : 'space-topic-row'}${selected ? ' project-rail-row--active' : ''}`}
              aria-label={[`Open ${isMote && id !== PMO_TEAMS_TOPIC_ID ? `Mote · ${name}` : name}`, attentionLabel].filter(Boolean).join(' · ')}
              aria-current={selected ? 'page' : undefined}
              title={[name, topic.readError ?? topic.summary, topic.directoryPath].filter(Boolean).join('\n')}
              onClick={() => isMote ? void openMote(id) : void openTopic(id, workspace.id).catch(reportError)}>
              {isMote ? <span className="project-rail-row__icon"><MoteIcon size={14} /></span> : null}
              <span className="project-rail-row__identity"><strong>{name}</strong></span>
            </button>
            <button type="button" className={`icon-button space-row-action space-pin${isPinned ? ' space-pin--pinned' : ''}`}
              aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${name}`} aria-pressed={isPinned} title={`${isPinned ? 'Unpin' : 'Pin'} ${name}`}
              onClick={() => togglePinned(SCRATCH_WORKSPACE_ID, id)}><Pin size={11} /></button>
            {isMote ? <button type="button" className="icon-button space-row-action space-mote-edit" aria-label={`Edit ${name} SOUL.md`}
              title="Edit SOUL.md · New sessions use saved changes" onClick={() => void openMote(id, true)}><NotebookPen size={12} /></button> : null}
            {bucket.some((session) => session.kind === 'agent') ? <ProjectActivity compact sessions={bucket} contexts={contextById.has(id) ? [contextById.get(id)!] : []} /> : null}
          </div>
          {topic.readError ? <div className="new-tab-error" role="alert">{name}: {topic.readError}. Its work surface is retained.</div> : null}
        </div>
      }) : null}
    </nav>
  }
  return <div className="space-topics-tree">
    {section('Motes', motes)}
    {section('Topics', entries)}
    {error ? <div className="new-tab-error" role="alert">Topics could not be refreshed: {error}. Existing work surfaces remain available.</div> : null}
  </div>
}
