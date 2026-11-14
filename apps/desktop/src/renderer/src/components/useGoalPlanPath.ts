import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { GoalPlanNodeView } from './GoalPlanGraph'

type Direction = 'upstream' | 'downstream'
type PathRole = Direction | 'current'
type PathMark = HTMLElement | SVGPathElement
type DrawnEdge = { from: string; to: string; boundary?: 'start' | 'finish' }
type Neighbor = { id: string; path: SVGPathElement | undefined }

/** Trace saved dependencies on the mounted graph, without measuring, scrolling or opening a task. */
export function useGoalPlanPath(canvas: RefObject<HTMLDivElement | null>, nodes: GoalPlanNodeView[],
  drawnEdges: readonly DrawnEdge[], selected: string | undefined) {
  const pointer = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const root = canvas.current
    if (!root) return
    const cards = new Map([...root.querySelectorAll<HTMLElement>('[data-goal-plan-node]')].map(card => [card.dataset.goalPlanNode!, card]))
    const paths = root.querySelectorAll<SVGPathElement>('.goal-plan__edge')
    const pathsByTarget = new Map<string, Map<string, SVGPathElement>>()
    const boundary = { upstream: new Map<string, SVGPathElement>(), downstream: new Map<string, SVGPathElement>() }
    drawnEdges.forEach((edge, index) => {
      const path = paths[index]
      if (!path) return
      if (edge.boundary === 'start') boundary.upstream.set(edge.to, path)
      else if (edge.boundary === 'finish') boundary.downstream.set(edge.from, path)
      else {
        const parents = pathsByTarget.get(edge.to) ?? new Map<string, SVGPathElement>()
        parents.set(edge.from, path)
        pathsByTarget.set(edge.to, parents)
      }
    })
    const neighbors = new Map(nodes.map(({ node }) => [node.id, { upstream: [] as Neighbor[], downstream: [] as Neighbor[] }]))
    for (const { node } of nodes) {
      for (const parent of node.dependsOn) {
        const path = pathsByTarget.get(node.id)?.get(parent)
        neighbors.get(node.id)!.upstream.push({ id: parent, path })
        neighbors.get(parent)?.downstream.push({ id: node.id, path })
      }
    }
    const cardAt = (target: EventTarget | null) => target instanceof Element && root.contains(target)
      ? target.closest<HTMLElement>('[data-goal-plan-node]')?.dataset.goalPlanNode : undefined
    let focused = cardAt(root.ownerDocument.activeElement)
    if (pointer.current && !cards.has(pointer.current)) pointer.current = undefined
    let marked = new Map<PathMark, PathRole>()

    const trace = () => {
      const id = pointer.current ?? focused ?? selected
      if (root.dataset.goalTrace === id) return
      const next = new Map<PathMark, PathRole>()
      if (id && cards.has(id)) {
        next.set(cards.get(id)!, 'current')
        for (const direction of ['upstream', 'downstream'] as const) {
          const stack = [id]
          while (stack.length) {
            const here = stack.pop()!
            const boundaryEdge = boundary[direction].get(here)
            if (boundaryEdge) next.set(boundaryEdge, direction)
            for (const neighbor of neighbors.get(here)?.[direction] ?? []) {
              if (neighbor.path) next.set(neighbor.path, direction)
              const card = cards.get(neighbor.id)
              if (card && !next.has(card)) {
                next.set(card, direction)
                stack.push(neighbor.id)
              }
            }
          }
        }
        root.dataset.goalTrace = id
      } else {
        delete root.dataset.goalTrace
      }
      for (const element of marked.keys()) if (!next.has(element)) delete element.dataset.goalPath
      for (const [element, role] of next) if (marked.get(element) !== role) element.dataset.goalPath = role
      marked = next
    }

    function point(event: PointerEvent) {
      if (event.pointerType === 'touch') return
      const next = cardAt(event.type === 'pointerout' ? event.relatedTarget : event.target)
      if (pointer.current === next) return
      pointer.current = next
      trace()
    }
    function focus(event: FocusEvent) {
      focused = cardAt(event.type === 'focusout' ? event.relatedTarget : event.target)
      pointer.current = undefined
      trace()
    }
    trace()
    root.addEventListener('pointerover', point)
    root.addEventListener('pointerout', point)
    root.addEventListener('focusin', focus)
    root.addEventListener('focusout', focus)
    return () => {
      root.removeEventListener('pointerover', point)
      root.removeEventListener('pointerout', point)
      root.removeEventListener('focusin', focus)
      root.removeEventListener('focusout', focus)
      for (const element of marked.keys()) delete element.dataset.goalPath
      delete root.dataset.goalTrace
    }
  }, [canvas, nodes, drawnEdges, selected])
}
