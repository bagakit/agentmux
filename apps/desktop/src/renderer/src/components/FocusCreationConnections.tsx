import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusAgentCreations } from '../lib/focus-agent-creations'
import { focusCardLinkPath } from '../lib/focus-card-link-path'
import { focusContextIdentityKey } from '../lib/focus-context-identity'
import { useWorkbenchNameTooltip } from './WorkbenchNameTooltip'

const CreationIcon = semanticIconComponent('object.agent-creation')
const linkObstacles = '[data-focus-card-key], .focus-context-group__bucket, .focus-context-group__count, .focus-context-group__pending, .focus-project-lanes__axis, .focus-project-frame__title > :is(button, span), .focus-topic-section'

type Connection = { from: string; to: string; creator: string; child: string; path: string }
type ConnectionPreview = { index: number; x: number; y: number; placement: 'right-start' | 'top' }

export function FocusCreationMark({ label }: { label: string }) {
  return <span className="focus-creation-mark" role="img" aria-label={label} title={label}><CreationIcon size={12} /></span>
}

function CreationConnectionHint({ edge, x, y, placement }: Omit<ConnectionPreview, 'index'> & { edge: Connection }) {
  const anchor = useRef<SVGRectElement>(null)
  const tooltip = useWorkbenchNameTooltip(edge.creator, `Created ${edge.child}`, false, { placement, pointerPassThrough: true })
  const show = useRef(tooltip.showFor)
  show.current = tooltip.showFor
  useLayoutEffect(() => { if (anchor.current) show.current(anchor.current) }, [x, y])
  return <><rect ref={anchor} x={x} y={y} width="1" height="1" fill="none" aria-hidden="true" />{tooltip.content}</>
}

/** Read visible card gutters only while a selected relationship can be drawn. */
export function FocusCreationConnections({ selected, creation, scrollRef }: {
  selected: string
  creation: FocusAgentCreations
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const svg = useRef<SVGSVGElement>(null)
  const arrow = useId()
  const dot = useId()
  const [paths, setPaths] = useState<readonly Connection[]>([])
  const [pointer, setPointer] = useState<ConnectionPreview | null>(null)
  const [keyboard, setKeyboard] = useState<ConnectionPreview | null>(null)
  useLayoutEffect(() => {
    const layer = svg.current, port = scrollRef.current
    if (!layer || !port) return
    const window = port.ownerDocument.defaultView!
    const parent = creation.parents.get(selected)
    const pairs = [
      ...(parent?.creator ? [{ from: parent.creator, to: selected, creator: parent.creatorName, child: parent.child.name }] : []),
      ...(creation.children.get(selected) ?? []).map(({ child, creatorName }) => ({
        from: selected, to: focusContextIdentityKey(child.hostId, child.id), creator: creatorName, child: child.name
      }))
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
        previous.every((item, index) => {
          const current = next[index]
          return current && item.from === current.from && item.to === current.to && item.path === current.path &&
            item.creator === current.creator && item.child === current.child
        }) ? previous : next)
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

  useLayoutEffect(() => {
    const port = scrollRef.current, layer = svg.current
    setPointer(null)
    setKeyboard(null)
    if (!port || !layer || !paths.length) return
    // Observe the gutters through the scrollport. The SVG never intercepts card input.
    const targets = Array.from(layer.querySelectorAll<SVGPathElement>('.focus-creation-hit'))
    const leave = () => setPointer(null)
    const move = (event: PointerEvent) => {
      const target = event.target as Element
      if (event.pointerType === 'touch' || event.buttons || target.closest('[data-focus-card-key], button, a, .focus-context-group__bucket, .focus-project-lanes__axis')) {
        leave()
        return
      }
      const origin = layer.getBoundingClientRect()
      const x = event.clientX - origin.left, y = event.clientY - origin.top
      const point = layer.createSVGPoint()
      point.x = x; point.y = y
      const index = targets.findIndex(path => path.isPointInStroke(point))
      const hit = targets[index]
      if (!hit) { leave(); return }
      point.y = y - 8
      const above = hit.isPointInStroke(point)
      point.y = y + 8
      const placement = above || hit.isPointInStroke(point) ? 'right-start' : 'top'
      setPointer(previous => previous?.index === index ? previous : { index, x, y, placement })
    }
    port.addEventListener('pointermove', move, { passive: true })
    port.addEventListener('pointerleave', leave)
    port.addEventListener('scroll', leave, { passive: true })
    return () => {
      port.removeEventListener('pointermove', move)
      port.removeEventListener('pointerleave', leave)
      port.removeEventListener('scroll', leave)
    }
  }, [paths, scrollRef])

  const preview = pointer ?? keyboard
  const active = preview && paths[preview.index]
  return <svg ref={svg} className="focus-creation-connections" data-preview={Boolean(active) || undefined}
    aria-label="Agent creation relationships" aria-hidden={paths.length ? undefined : true}>
    <defs>
      <marker id={dot} viewBox="0 0 8 8" refX="4" refY="4" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse">
        <circle className="focus-creation-dot" cx="4" cy="4" r="2.5" />
      </marker>
      <marker id={arrow} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto" markerUnits="userSpaceOnUse">
        <path className="focus-creation-arrow" d="M 1 1 L 7 4 L 1 7 Z" />
      </marker>
    </defs>
    {paths.map(({ from, to, path }) => <path key={JSON.stringify([from, to])} className="focus-creation-underlay" d={path} aria-hidden="true" />)}
    {paths.map((edge, index) => {
      const { from, to, path } = edge
      return <g key={JSON.stringify([from, to])} className="focus-creation-edge" role="img" tabIndex={0}
        aria-label={`${edge.creator} created ${edge.child}`} data-preview={preview?.index === index || undefined}
        onFocus={event => {
          const line = event.currentTarget.querySelector<SVGPathElement>('.focus-creation-line')!
          const middle = line.getTotalLength() / 2
          const { x, y } = line.getPointAtLength(middle)
          const nearby = line.getPointAtLength(middle + 2)
          setKeyboard({ index, x, y, placement: Math.abs(nearby.y - y) > Math.abs(nearby.x - x) ? 'right-start' : 'top' })
        }}
        onBlur={() => setKeyboard(null)}>
        <path className="focus-creation-hit" d={path} />
        <path data-focus-creation-from={from} data-focus-creation-to={to} className="focus-creation-line" d={path}
          markerStart={`url(#${dot})`} markerEnd={`url(#${arrow})`} />
        {preview?.index === index ? <path className="focus-creation-pulse" d={path} pathLength="100" /> : null}
      </g>
    })}
    {active && preview ? <CreationConnectionHint key={JSON.stringify([active.from, active.to])} edge={active}
      x={preview.x} y={preview.y} placement={preview.placement} /> : null}
  </svg>
}
