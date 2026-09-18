import { ChevronDown, ChevronRight, NotebookText, Pin, Sparkles, NotebookPen } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, MOTE_SOUL_PATH, scratchTopicDirectoryName } from '../../../shared/scratch-topics'
import { api } from '../lib/api'
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
  const openFile = useAppStore((state) => state.openFile)
  const setWorkspaceTool = useAppStore((state) => state.setWorkspaceTool)
  const current = layout ? activeTopicIdFromLayout(layout, tabs) : undefined
  const entries = topics?.filter((topic) => topic.id !== PMO_TEAMS_TOPIC_ID && !topic.soul) ?? []
  const orderedIds = partitionPinned(orderTopics(entries.map((topic) => topic.id), order), pinned ?? [])
  const motes = topics?.filter((topic) => topic.id !== PMO_TEAMS_TOPIC_ID && topic.soul) ?? []
  const byId = new Map(entries.map((topic) => [topic.id, topic]))

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
      {[topics?.find((topic) => topic.id === PMO_TEAMS_TOPIC_ID) ?? { id: PMO_TEAMS_TOPIC_ID, title: 'Mote' }, ...motes].map((mote) => (
        <div key={mote.id} className="project-rail-row-shell">
          <button type="button" className={`project-rail-row space-mote-row${activeWorkspaceId === workspace.id && current === mote.id ? ' project-rail-row--active' : ''}`}
            aria-label={`Open ${mote.id === PMO_TEAMS_TOPIC_ID ? 'Mote' : `Mote · ${mote.title}`}`} onClick={() => void openMote(mote.id)}>
            <span className="project-rail-row__icon"><Sparkles size={14} /></span>
            <span className="project-rail-row__identity"><strong>{mote.id === PMO_TEAMS_TOPIC_ID ? 'Mote' : mote.title}</strong></span>
          </button>
          <button type="button" className="icon-button" aria-label={`Edit ${mote.id === PMO_TEAMS_TOPIC_ID ? 'Mote' : mote.title} SOUL.md`}
            title="Edit SOUL.md · New sessions use saved changes" onClick={() => void openMote(mote.id, true)}><NotebookPen size={12} /></button>
          {'readError' in mote && mote.readError ? <div className="new-tab-error" role="alert">{mote.title}: {mote.readError}. Its work surface is retained.</div> : null}
        </div>
      ))}
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
