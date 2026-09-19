import { ChevronDown, ChevronRight, NotebookText, Pin, NotebookPen } from 'lucide-react'
import { MoteIcon } from './MoteIcon'
import type { CSSProperties } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, MOTE_SOUL_PATH, scratchTopicDirectoryName } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { activeTopicIdFromLayout } from '../lib/scratch-topic-layout'
import { orderTopics, partitionPinned } from '../lib/topic-order'
import { useAppStore } from '../store'
import { matchesSpaceQuery } from '../lib/space-tree-navigation'

/** Filesystem projection; selection, pins, order and disclosure reuse existing owners. */
export function SpaceTopicsTree({ workspace, query = '' }: { workspace: WorkspaceRecord; query?: string }) {
  const { topics, error } = useScratchTopics(workspace.id)
  const layout = useAppStore((state) => state.layouts[workspace.id])
  const tabs = useAppStore((state) => state.tabs)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const order = useAppStore((state) => state.scratchTopicOrder)
  const pinned = useAppStore((state) => state.pinnedItems[SCRATCH_WORKSPACE_ID])
  const collapsed = useAppStore((state) => state.collapsedProjectGroups['space:topics'] === true)
  const toggleGroup = useAppStore((state) => state.toggleProjectGroup)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const openTopic = useAppStore((state) => state.openScratchTopic)
  const reportError = useAppStore((state) => state.reportError)
  const openFile = useAppStore((state) => state.openFile)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const current = layout ? activeTopicIdFromLayout(layout, tabs) : undefined
  const entries = topics?.filter((topic) => topic.id !== PMO_TEAMS_TOPIC_ID && !topic.soul) ?? []
  const filteredEntries = entries.filter((topic) => matchesSpaceQuery(query, 'Topics', topic.title, topic.summary, topic.directoryPath, workspace.hostId))
  const orderedIds = partitionPinned(orderTopics(filteredEntries.map((topic) => topic.id), order), pinned ?? [])
  const motes = topics?.filter((topic) => topic.id !== PMO_TEAMS_TOPIC_ID && topic.soul) ?? []
  const byId = new Map(entries.map((topic) => [topic.id, topic]))
  const expanded = Boolean(query.trim()) || !collapsed

  async function openOverview(): Promise<void> {
    try {
      await selectWorkspace(workspace.id)
      setWorkspaceTool('files-branches')
    } catch (cause) { reportError(cause) }
  }

  async function openMote(id: string, edit = false): Promise<void> {
    try {
      await api.scratch.ensureMote(workspace.id, id)
      await openTopic(id, workspace.id)
      if (edit) await openFile(`${scratchTopicDirectoryName(id)}/${MOTE_SOUL_PATH}`, undefined, undefined, workspace.id)
    } catch (cause) { reportError(cause) }
  }

  return (
    <nav className="space-topics-tree" aria-label="Topics">
      {[topics?.find((topic) => topic.id === PMO_TEAMS_TOPIC_ID) ?? { id: PMO_TEAMS_TOPIC_ID, title: 'Mote' }, ...motes].map((mote) => {
        const defaultMote = mote.id === PMO_TEAMS_TOPIC_ID
        const name = defaultMote ? 'Mote' : mote.title
        const selected = activeWorkspaceId === workspace.id && current === mote.id
        if (!matchesSpaceQuery(query, 'Mote', name, 'summary' in mote ? mote.summary : undefined, 'directoryPath' in mote ? mote.directoryPath : undefined, workspace.hostId)) return null
        return (
          <div key={mote.id} className="space-tree-entry" data-space-entry>
            <div className="project-rail-row-shell">
              <span className="project-rail-row__collapse-spacer" aria-hidden="true" />
              <button
                type="button"
                data-space-nav={mote.id}
                className={`project-rail-row space-mote-row${selected ? ' project-rail-row--active' : ''}`}
                aria-label={`Open ${defaultMote ? name : `Mote · ${name}`}`}
                aria-current={selected ? 'page' : undefined}
                title={defaultMote ? name : `Mote · ${name}`}
                onClick={() => void openMote(mote.id)}
              >
                <span className="project-rail-row__icon"><MoteIcon size={14} /></span>
                <span className="project-rail-row__identity"><strong>{name}</strong></span>
              </button>
              <button
                type="button"
                className="icon-button space-mote-edit"
                aria-label={`Edit ${name} SOUL.md`}
                title="Edit SOUL.md · New sessions use saved changes"
                onClick={() => void openMote(mote.id, true)}
              >
                <NotebookPen size={12} />
              </button>
            </div>
            {'readError' in mote && mote.readError ? (
              <div className="new-tab-error" role="alert">{name}: {mote.readError}. Its work surface is retained.</div>
            ) : null}
          </div>
        )
      })}
      <div className="project-rail-row-shell" data-space-entry>
        <button
          type="button"
          className="project-rail-row__collapse"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} Topics`}
          aria-expanded={expanded}
          data-space-disclosure
          disabled={Boolean(query.trim())}
          onClick={() => toggleGroup('space:topics')}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <button
          type="button"
          className={`project-rail-row space-topics-row${activeWorkspaceId === workspace.id && !current ? ' project-rail-row--active' : ''}`}
          aria-label="Topics overview"
          aria-current={activeWorkspaceId === workspace.id && !current ? 'page' : undefined}
          data-space-nav="space:topics"
          data-space-expanded={!query.trim() ? expanded : undefined}
          title={workspace.path}
          onClick={() => void openOverview()}
        >
          <span className="project-rail-row__icon"><NotebookText size={14} /></span>
          <span className="project-rail-row__identity"><strong>Topics</strong></span>
          <small>{entries.length}</small>
        </button>
      </div>
      {error ? (
        <div className="new-tab-error" role="alert">Topics could not be refreshed: {error}. Existing work surfaces remain available.</div>
      ) : null}
      {query.trim() && orderedIds.length === 0 ? <p className="space-tree-empty" role="status">No matching Topics</p> : null}
      {expanded && orderedIds.length > 0 ? (
        <div className="space-topic-children">
          {orderedIds.map((id) => {
            const topic = byId.get(id)!
            const selected = activeWorkspaceId === workspace.id && current === id
            return (
              <div key={id} className="space-tree-entry" data-space-entry>
                <div className="project-rail-row-shell" style={{ '--rail-depth': 1 } as CSSProperties}>
                  <span className="project-rail-row__collapse-spacer" aria-hidden="true" />
                  <button
                    type="button"
                    className={`project-rail-row space-topic-row${selected ? ' project-rail-row--active' : ''}`}
                    style={{ '--rail-depth': 1 } as CSSProperties}
                    aria-label={`Open ${topic.title}`}
                    data-space-nav={`topic:${id}`}
                    data-space-parent="space:topics"
                    aria-current={selected ? 'page' : undefined}
                    title={[topic.title, topic.readError ?? topic.summary, topic.directoryPath].filter(Boolean).join('\n')}
                    onClick={() => void openTopic(id, workspace.id).catch(reportError)}
                  >
                    <span className="project-rail-row__icon" aria-hidden="true" />
                    <span className="project-rail-row__identity"><strong>{topic.title}</strong></span>
                    {pinned?.includes(id) ? <Pin size={10} aria-label="Pinned" /> : null}
                  </button>
                </div>
                {topic.readError ? (
                  <div className="new-tab-error" role="alert">{topic.title}: {topic.readError}. Its work surface is retained.</div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </nav>
  )
}
