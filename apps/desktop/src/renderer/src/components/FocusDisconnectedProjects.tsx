import { ChevronRight, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import type { FocusContext } from '../lib/focus-context'
import type { FocusProjectLane } from '../lib/focus-project-lanes'
import { FocusProjectLanes } from './FocusProjectLanes'
import { FocusContextRow } from './FocusContextRow'

/** A compact projection of retained Contexts, never a second Session owner. */
export function FocusDisconnectedProjects({ lanes, contexts, selectedId, projectId, searching, onProject, onSelect }: {
  lanes: readonly FocusProjectLane[]; contexts: ReadonlyMap<string, FocusContext>; selectedId: string | null
  projectId: string; searching: boolean; onProject(id: string): void; onSelect(id: string): void
}) {
  const [expanded, setExpanded] = useState(false)
  const ids = lanes.flatMap(lane => lane.contextIds.filter(id => contexts.has(id)))
  const projectCount = new Set(lanes.map(lane => lane.projectId)).size
  const showing = expanded || searching || selectedId !== null && ids.includes(selectedId)
  if (!ids.length) return null
  return <section className="focus-disconnected-projects" aria-label="Disconnected projects">
    <button type="button" className="focus-recovery-toggle" aria-expanded={showing} onClick={() => setExpanded(!showing)}>
      <ChevronRight size={11} /><RotateCcw size={12} /><span>Disconnected</span>
      <span className="focus-recovery-toggle__count">{projectCount} {projectCount === 1 ? 'project' : 'projects'} · {ids.length} {ids.length === 1 ? 'context' : 'contexts'}</span>
    </button>
    {showing ? <FocusProjectLanes lanes={lanes} selectedWorkspaceId={projectId} onSelect={onProject} renderLane={(lane, heading) => <>
      {heading}<div className="focus-disconnected-projects__cards">{lane.contextIds.flatMap(id => {
        const context = contexts.get(id)
        return context ? [<FocusContextRow key={id} context={context} compact selected={id === selectedId} onSelect={onSelect} />] : []
      })}</div>
    </>} /> : null}
  </section>
}
