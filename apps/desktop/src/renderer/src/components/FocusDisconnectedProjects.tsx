import { ChevronRight, Unplug } from 'lucide-react'
import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { FocusContext } from '../lib/focus-context'
import { focusProjectKey, type FocusProjectLane } from '../lib/focus-project-lanes'
import { FocusProjectLanes } from './FocusProjectLanes'
import { FocusContextRow } from './FocusContextRow'

/** The same confirmed-offline directory in both the full and mixed Focus surfaces. */
export function FocusDisconnectedProjects({ lanes, contexts, visibleIds, selectedId, projectKey, expanded, canReturn, reveal, fallbackFocus, onExpand, onClose, onClearFilters, onProject, onSelect }: {
  lanes: readonly FocusProjectLane[]; contexts: ReadonlyMap<string, FocusContext>; selectedId: string | null
  visibleIds: ReadonlySet<string>; expanded: boolean; canReturn: boolean
  projectKey: string; reveal: { laneId: string; trigger: HTMLElement } | null
  fallbackFocus: RefObject<HTMLInputElement | null>
  onExpand(): void; onClose(): void; onClearFilters(): void
  onProject(id: string): void; onSelect(id: string): void
}) {
  const surface = useRef<HTMLElement>(null), header = useRef<HTMLButtonElement>(null)
  const pendingReturn = useRef<{ target: HTMLElement | null; from: Element | null } | null>(null)
  const ids = new Set(lanes.flatMap(lane => lane.contextIds.filter(id => contexts.has(id))))
  const visibleLanes = lanes.filter(lane => lane.contextIds.some(id => contexts.has(id) && visibleIds.has(id)))
  const matchingCount = [...ids].filter(id => visibleIds.has(id)).length
  const projectCount = new Set(lanes.map(lane => focusProjectKey(lane.hostId, lane.projectId))).size
  useLayoutEffect(() => {
    if (!expanded || !reveal || !surface.current) return
    const target = [...surface.current.querySelectorAll<HTMLElement>('[data-lane-id]')].find(node => node.dataset.laneId === reveal.laneId)
    if (!target) return
    target.scrollIntoView({ block: 'nearest' })
    if (document.activeElement === reveal.trigger || document.activeElement === document.body) {
      target.querySelector<HTMLButtonElement>('.focus-context')?.focus({ preventScroll: true })
    }
  }, [expanded, reveal])
  useLayoutEffect(() => {
    const pending = pendingReturn.current
    if (expanded || !pending) return
    pendingReturn.current = null
    const focused = document.activeElement
    if (focused !== pending.from && focused !== document.body && focused?.isConnected) return
    const usable = (node: HTMLElement | null | undefined) => node?.isConnected && !node.closest('[hidden], [inert], [aria-hidden="true"]')
      && (!(node instanceof HTMLButtonElement) || !node.disabled) && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden'
    const target = usable(pending.target) ? pending.target : usable(fallbackFocus.current) ? fallbackFocus.current : null
    target?.focus({ preventScroll: true })
  }, [expanded, fallbackFocus])
  const close = () => {
    if (!canReturn) return
    const focused = document.activeElement
    if (focused instanceof Node && surface.current?.contains(focused)) {
      pendingReturn.current = { target: reveal?.trigger ?? header.current, from: focused }
    }
    onClose()
  }
  if (!ids.size) return null
  const title = <><Unplug size={14} aria-hidden="true" /><strong>Disconnected</strong>
    <span className="focus-disconnected-projects__count">{projectCount} {projectCount === 1 ? 'project' : 'projects'} · {ids.size} {ids.size === 1 ? 'context' : 'contexts'}</span></>
  return <section ref={surface} className="focus-disconnected-projects" aria-label="Disconnected projects" data-expanded={expanded ? 'true' : 'false'}
    onKeyDown={event => { if (event.key === 'Escape' && expanded && canReturn) { event.preventDefault(); event.stopPropagation(); close() } }}>
    <div className="focus-disconnected-projects__heading">
      {canReturn ? <button ref={header} type="button" className="focus-disconnected-projects__toggle" aria-expanded={expanded} onClick={() => { if (expanded) close(); else onExpand() }}>
        <ChevronRight size={12} aria-hidden="true" />{title}
      </button> : <div className="focus-disconnected-projects__title">{title}</div>}
      {expanded && canReturn ? <button type="button" className="focus-disconnected-projects__return" onClick={close}>Return to board</button> : null}
    </div>
    {expanded && matchingCount !== ids.size ? <p className="focus-disconnected-projects__matches">{matchingCount} of {ids.size} contexts match the current filters</p> : null}
    {expanded && visibleLanes.length ? <FocusProjectLanes lanes={visibleLanes} selectedProjectKey={projectKey} onSelect={onProject} renderLane={(lane, heading) => <>
      {heading}<div className="focus-disconnected-projects__cards">{lane.contextIds.flatMap(id => {
        const context = visibleIds.has(id) ? contexts.get(id) : null
        return context ? [<FocusContextRow key={id} context={context} variant="directory" selected={id === selectedId} onSelect={onSelect} />] : []
      })}</div>
    </>} /> : expanded ? <div className="focus-disconnected-projects__empty" role="status">
      <strong>No matching disconnected contexts</strong><span>Try another search or clear the filters.</span>
      <button type="button" onClick={onClearFilters}>Clear filters</button>
    </div> : null}
  </section>
}
