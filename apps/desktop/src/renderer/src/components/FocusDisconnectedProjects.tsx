import { ChevronRight, RotateCcw } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { FocusContext } from '../lib/focus-context'
import type { FocusProjectLane } from '../lib/focus-project-lanes'
import { FocusProjectLanes } from './FocusProjectLanes'
import { FocusContextRow } from './FocusContextRow'

/** A compact projection of all confirmed offline Contexts, never a Session owner. */
export function FocusDisconnectedProjects({ lanes, contexts, selectedId, projectId, reveal, onProject, onSelect }: {
  lanes: readonly FocusProjectLane[]; contexts: ReadonlyMap<string, FocusContext>; selectedId: string | null
  projectId: string; reveal: { laneId: string; trigger: HTMLElement } | null
  onProject(id: string): void; onSelect(id: string): void
}) {
  const [expanded, setExpanded] = useState(false)
  const [activeReveal, setActiveReveal] = useState<typeof reveal>(null)
  const surface = useRef<HTMLElement>(null), header = useRef<HTMLButtonElement>(null)
  const ids = lanes.flatMap(lane => lane.contextIds.filter(id => contexts.has(id)))
  const projectCount = new Set(lanes.map(lane => lane.projectId)).size
  useLayoutEffect(() => {
    if (reveal && lanes.some(lane => lane.id === reveal.laneId)) { setExpanded(true); setActiveReveal(reveal) }
  }, [reveal])
  useLayoutEffect(() => {
    if (!expanded || !activeReveal || !surface.current) return
    const target = [...surface.current.querySelectorAll<HTMLElement>('[data-lane-id]')].find(node => node.dataset.laneId === activeReveal.laneId)
    if (!target) return
    target.scrollIntoView({ block: 'nearest' })
    if (document.activeElement === activeReveal.trigger || document.activeElement === document.body) {
      target.querySelector<HTMLButtonElement>('.focus-context')?.focus({ preventScroll: true })
    }
  }, [expanded, activeReveal])
  const close = () => {
    const focused = document.activeElement
    const usable = (node: HTMLElement | null | undefined) => node?.isConnected && !node.closest('[hidden], [inert], [aria-hidden="true"]')
      && (!(node instanceof HTMLButtonElement) || !node.disabled) && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden'
    const returnTo = usable(activeReveal?.trigger) ? activeReveal!.trigger : usable(header.current) ? header.current : null
    const mayReturn = focused instanceof Node && surface.current?.contains(focused)
    setExpanded(false); setActiveReveal(null)
    if (mayReturn && returnTo) returnTo.focus({ preventScroll: true })
  }
  if (!ids.length) return null
  return <section ref={surface} className="focus-disconnected-projects" aria-label="Disconnected projects"
    onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close() } }}>
    <div className="focus-disconnected-projects__heading">
      <button ref={header} type="button" className="focus-recovery-toggle" aria-expanded={expanded} onClick={() => { if (expanded) close(); else setExpanded(true) }}>
        <ChevronRight size={11} /><RotateCcw size={12} /><span>Disconnected</span>
        <span className="focus-recovery-toggle__count">{projectCount} {projectCount === 1 ? 'project' : 'projects'} · {ids.length} {ids.length === 1 ? 'context' : 'contexts'}</span>
      </button>
      {expanded ? <button type="button" className="focus-disconnected-projects__return" onClick={close}>Return</button> : null}
    </div>
    {expanded ? <FocusProjectLanes lanes={lanes} selectedWorkspaceId={projectId} onSelect={onProject} renderLane={(lane, heading) => <>
      {heading}<div className="focus-disconnected-projects__cards">{lane.contextIds.flatMap(id => {
        const context = contexts.get(id)
        return context ? [<FocusContextRow key={id} context={context} compact selected={id === selectedId} onSelect={onSelect} />] : []
      })}</div>
    </>} /> : null}
  </section>
}
