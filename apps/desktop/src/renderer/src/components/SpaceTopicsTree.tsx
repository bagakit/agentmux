import { ChevronDown, ChevronRight, NotebookText, Pin } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { activeTopicIdFromLayout } from '../lib/scratch-topic-layout'
import { orderTopics, partitionPinned } from '../lib/topic-order'
import { useAppStore } from '../store'

/** Filesystem projection; selection, pins, order and disclosure reuse existing owners. */
export function SpaceTopicsTree({ workspace }: { workspace: WorkspaceRecord }) {
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
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const current = layout ? activeTopicIdFromLayout(layout, tabs) : undefined
  const entries = topics?.filter((topic) => topic.id !== PMO_TEAMS_TOPIC_ID) ?? []
  const orderedIds = partitionPinned(orderTopics(entries.map((topic) => topic.id), order), pinned ?? [])
  const byId = new Map(entries.map((topic) => [topic.id, topic]))

  async function openOverview(): Promise<void> {
    try {
      await selectWorkspace(workspace.id)
      setWorkspaceTool('files-branches')
    } catch (cause) { reportError(cause) }
  }

  return (
    <nav className="space-topics-tree" aria-label="Topics">
      <div className="project-rail-row-shell">
        <button type="button" className="project-rail-row__collapse"
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} Topics`} aria-expanded={!collapsed}
          onClick={() => toggleGroup('space:topics')}>
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <button type="button" className={`project-rail-row${activeWorkspaceId === workspace.id ? ' project-rail-row--active' : ''}`}
          aria-label="Topics overview" title={workspace.path} onClick={() => void openOverview()}>
          <span className="project-rail-row__icon"><NotebookText size={14} /></span>
          <span className="project-rail-row__identity"><strong>Topics</strong></span>
          <small>{entries.length}</small>
        </button>
      </div>
      {error ? <div className="new-tab-error" role="alert">Topics could not be refreshed: {error}. Existing work surfaces remain available.</div> : null}
      {collapsed ? null : orderedIds.map((id) => {
        const topic = byId.get(id)!
        const selected = activeWorkspaceId === workspace.id && current === id
        return (
          <div key={id} className="project-rail-entry" style={{ '--rail-depth': 1 } as CSSProperties}>
            <button type="button" className={`project-rail-row space-topic-row${selected ? ' project-rail-row--active' : ''}`}
              style={{ '--rail-depth': 1 } as CSSProperties} aria-label={`Open ${topic.title}`}
              aria-current={selected ? 'page' : undefined} title={topic.readError ?? (topic.summary || topic.directoryPath)}
              onClick={() => void openTopic(id, workspace.id).catch(reportError)}>
              <span className="project-rail-row__identity"><strong>{topic.title}</strong></span>
              {pinned?.includes(id) ? <Pin size={10} aria-label="Pinned" /> : null}
            </button>
            {topic.readError ? <div className="new-tab-error" role="alert">{topic.title}: {topic.readError}. Its work surface is retained.</div> : null}
          </div>
        )
      })}
    </nav>
  )
}
