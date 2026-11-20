import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusAgentCreations } from '../lib/focus-agent-creations'
import { focusCardLinkPath } from '../lib/focus-card-link-path'
import { focusContextIdentityKey } from '../lib/focus-context-identity'

const CreationIcon = semanticIconComponent('object.agent-creation')
const linkObstacles = '[data-focus-card-key], .focus-context-group__bucket, .focus-context-group__count, .focus-context-group__pending, .focus-project-lanes__axis, .focus-project-frame__title > :is(button, span), .focus-topic-section'

export function FocusCreationMark({ label }: { label: string }) {
  return <span className="focus-creation-mark" role="img" aria-label={label} title={label}><CreationIcon size={12} /></span>
}

/** Read visible card gutters only while a selected relationship can be drawn. */
export function FocusCreationConnections({ selected, creation, scrollRef }: {
  selected: string
  creation: FocusAgentCreations
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const svg = useRef<SVGSVGElement>(null)
  const arrow = useId()
  const [paths, setPaths] = useState<readonly { from: string; to: string; path: string }[]>([])
  useLayoutEffect(() => {
    const layer = svg.current, port = scrollRef.current
    if (!layer || !port) return
    const window = port.ownerDocument.defaultView!
    const parent = creation.parents.get(selected)
    const pairs = [
      ...(parent?.creator ? [{ from: parent.creator, to: selected }] : []),
      ...(creation.children.get(selected) ?? []).map(({ child }) => ({ from: selected, to: focusContextIdentityKey(child.hostId, child.id) }))
    ]
    let nodes = new Map<string, HTMLElement[]>(), frame = 0
    const observe = typeof window.ResizeObserver === 'undefined' ? null : new window.ResizeObserver(schedule)
    const intersecting = (box: DOMRect, view: DOMRect) => box.width > 0 && box.height > 0 &&
      box.right > view.left && box.bottom > view.top && box.left < view.right && box.top < view.bottom
    function measure() {
      if (!port || !layer || !window) return
      frame = 0
      const origin = layer.getBoundingClientRect(), bounds = port.getBoundingClientRect()
      const view = new window.DOMRect(bounds.left, bounds.top, port.clientWidth, port.clientHeight)
      layer.style.setProperty('--focus-creation-clip', `inset(${view.top - origin.top}px ${origin.right - view.right}px ${origin.bottom - view.bottom}px ${view.left - origin.left}px)`)
      const boxes = new Map<Element, DOMRect>()
      const box = (node: Element) => {
        const previous = boxes.get(node)
        if (previous) return previous
        const bounds = node.getBoundingClientRect()
        boxes.set(node, bounds)
        return bounds
      }
      const endpoint = (key: string) => (nodes.get(key) ?? []).map(box).filter(rect => intersecting(rect, view))
      const visible = pairs.flatMap(pair => {
        const from = endpoint(pair.from), to = endpoint(pair.to)
        return from.length === 1 && to.length === 1 ? [{ pair, from: from[0]!, to: to[0]! }] : []
      })
      const obstacles: DOMRect[] = []
      if (visible.length) for (const lane of port.children) {
        if (!intersecting(box(lane), view)) continue
        if (lane.matches(linkObstacles)) obstacles.push(box(lane))
        for (const element of lane.querySelectorAll(linkObstacles)) {
          const bounds = box(element)
          if (intersecting(bounds, view)) obstacles.push(bounds)
        }
      }
      const next = visible.flatMap(({ pair, from, to }) => {
        const path = focusCardLinkPath(from, to, origin, view, obstacles)
        return path ? [{ ...pair, path }] : []
      })
      setPaths(previous => previous.length === next.length &&
        previous.every((item, index) => item.from === next[index]?.from && item.to === next[index]?.to && item.path === next[index]?.path) ? previous : next)
    }
    function schedule() { if (!frame) frame = window.requestAnimationFrame(measure) }
    function refresh() {
      if (!port) return
      observe?.disconnect()
      observe?.observe(port)
      nodes = new Map()
      for (const key of new Set(pairs.flatMap(pair => [pair.from, pair.to]))) {
        const slots = [...port.querySelectorAll<HTMLElement>(`[data-focus-card-key="${window.CSS.escape(key)}"]`)]
        const targets = slots.filter(slot => slot.querySelector('button.focus-context'))
        nodes.set(key, targets)
        for (const target of targets) {
          observe?.observe(target)
          const group = target.closest('.focus-project-lanes__groups')
          if (group) observe?.observe(group)
        }
      }
      schedule()
    }
    const selectedKeys = new Set(pairs.flatMap(pair => [pair.from, pair.to]))
    const mutations = new window.MutationObserver(changes => {
      const targetsChanged = changes.some(change => {
        if (change.type === 'attributes') return change.attributeName === 'hidden' || change.attributeName === 'data-collapsed'
        return [...change.addedNodes, ...change.removedNodes].some(node => {
          if (!(node instanceof window.Element)) return false
          const slot = node.closest<HTMLElement>('[data-focus-card-key]')
          return slot ? selectedKeys.has(slot.dataset.focusCardKey ?? '') : Boolean(node.querySelector('[data-focus-card-key]'))
        })
      })
      if (targetsChanged) refresh()
      else schedule()
    })
    mutations.observe(port, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-collapsed', 'data-focus-card-slots', 'style'] })
    port.addEventListener('scroll', schedule, { passive: true })
    refresh()
    return () => {
      window.cancelAnimationFrame(frame)
      port.removeEventListener('scroll', schedule)
      observe?.disconnect()
      mutations.disconnect()
    }
  }, [creation, selected, scrollRef])
  return <svg ref={svg} className="focus-creation-connections" aria-hidden="true">
    <defs><marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto" markerUnits="userSpaceOnUse">
      <path className="focus-creation-arrow" d="M 1 1 L 7 4 L 1 7" />
    </marker></defs>
    {paths.map(({ from, to, path }) => <path key={JSON.stringify([from, to])} data-focus-creation-from={from} data-focus-creation-to={to}
      className="focus-creation-line" d={path} markerEnd={`url(#${arrow})`} />)}
  </svg>
}
