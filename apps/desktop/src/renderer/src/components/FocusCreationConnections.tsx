import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusAgentCreations } from '../lib/focus-agent-creations'
import { focusContextIdentityKey } from '../lib/focus-context-identity'

const CreationIcon = semanticIconComponent('object.agent-creation')

export function FocusCreationMark({ label }: { label: string }) {
  return <span className="focus-creation-mark" role="img" aria-label={label} title={label}><CreationIcon size={12} /></span>
}

function pathBetween(from: DOMRect, to: DOMRect, origin: DOMRect, view: DOMRect): string {
  const fromX = from.left + from.width / 2 - origin.left, fromY = from.top + from.height / 2 - origin.top
  const toX = to.left + to.width / 2 - origin.left, toY = to.top + to.height / 2 - origin.top
  const horizontalGap = Math.max(to.left - from.right, from.left - to.right)
  const verticalGap = Math.max(to.top - from.bottom, from.top - to.bottom)
  if (horizontalGap >= 16) {
    const direction = fromX < toX ? 1 : -1
    const x = fromX + direction * (from.width / 2 + 2), end = toX - direction * (to.width / 2 + 3)
    const turn = (x + end) / 2
    return `M ${x} ${fromY} C ${turn} ${fromY}, ${turn} ${toY}, ${end} ${toY}`
  }
  if (verticalGap >= 16) {
    const direction = fromY < toY ? 1 : -1
    const y = fromY + direction * (from.height / 2 + 2), end = toY - direction * (to.height / 2 + 3)
    const turn = (y + end) / 2
    return `M ${fromX} ${y} C ${fromX} ${turn}, ${toX} ${turn}, ${toX} ${end}`
  }
  // Adjacent cards may only have a few pixels between them. Route along
  // their edges so the dashed segment and arrow remain visible and face inward.
  if (Math.abs(fromY - toY) < Math.min(from.height, to.height) / 2) {
    const above = Math.min(from.top, to.top) - view.top >= 12
    const y = (above ? from.top : from.bottom) - origin.top
    const end = (above ? to.top - 2 : to.bottom + 2) - origin.top
    const turn = above ? Math.min(y, end) - 5 : Math.max(y, end) + 5
    return `M ${fromX} ${y} C ${fromX} ${turn}, ${toX} ${turn}, ${toX} ${end}`
  }
  const left = Math.min(from.left, to.left) - view.left >= 12
  const x = (left ? from.left : from.right) - origin.left
  const end = (left ? to.left - 2 : to.right + 2) - origin.left
  const turn = left ? Math.min(x, end) - 10 : Math.max(x, end) + 10
  return `M ${x} ${fromY} C ${turn} ${fromY}, ${turn} ${toY}, ${end} ${toY}`
}

/** Inspect only the selected Agent's endpoints. Scrolling reuses the same nodes. */
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
      const origin = layer.getBoundingClientRect(), view = port.getBoundingClientRect()
      layer.style.setProperty('--focus-creation-clip', `inset(${view.top - origin.top}px ${origin.right - view.right}px ${origin.bottom - view.bottom}px ${view.left - origin.left}px)`)
      const endpoint = (key: string) => (nodes.get(key) ?? []).map(node => node.getBoundingClientRect()).filter(rect => intersecting(rect, view))
      const next = pairs.flatMap(pair => {
        const from = endpoint(pair.from), to = endpoint(pair.to)
        return from.length === 1 && to.length === 1 ? [{ ...pair, path: pathBetween(from[0]!, to[0]!, origin, view) }] : []
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
        for (const target of targets) observe?.observe(target)
      }
      schedule()
    }
    const selectedKeys = new Set(pairs.flatMap(pair => [pair.from, pair.to]))
    const mutations = new window.MutationObserver(changes => {
      if (changes.some(change => change.type === 'attributes' || [...change.addedNodes, ...change.removedNodes].some(node => {
        if (!(node instanceof window.Element)) return false
        const slot = node.closest<HTMLElement>('[data-focus-card-key]')
        return slot ? selectedKeys.has(slot.dataset.focusCardKey ?? '') : Boolean(node.querySelector('[data-focus-card-key]'))
      }))) refresh()
      else schedule()
    })
    mutations.observe(port, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-collapsed'] })
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
    <defs><marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
      <path className="focus-creation-arrow" d="M 1 1 L 7 4 L 1 7" />
    </marker></defs>
    {paths.map(({ from, to, path }) => <path key={JSON.stringify([from, to])} data-focus-creation-from={from} data-focus-creation-to={to}
      className="focus-creation-line" d={path} markerEnd={`url(#${arrow})`} />)}
  </svg>
}
