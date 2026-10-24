import { mintObjectId } from '@agentmux/core/object-id'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollaborationLayoutInput, CollaborationLayoutBox, CollaborationLayoutRequest, CollaborationLayoutResponse, CollaborationLayoutStructure } from './collaboration-layout-engine'
import { collaborationLayoutStructureKey, translateCollaborationPath, type CollaborationPath } from './collaboration-layout-engine'
import { COLLABORATION_LAYOUT_TRANSITION_MS, interpolateCollaborationGeometry, type CollaborationGeometryFrame } from './collaboration-map-transition'
import { useWorkbenchDocument } from './workbench-document'

/** The original browser Worker boundary is replaceable only by test transport, not another layout engine. */
export function createCollaborationLayoutWorker() { return new Worker(new URL('./collaboration-layout.worker.ts', import.meta.url), { type: 'module' }) }

/** Disposable map geometry. Structural placement and new-path demand have separate invalidation. */
export function useCollaborationLayout(input: CollaborationLayoutInput, active: boolean, readingAnchor: { current: string | null }, motion: boolean) {
  const structure = collaborationLayoutStructureKey(input)
  const topology = JSON.stringify(input.connections.map(edge => [edge.id, edge.source, edge.target, edge.kind]))
  const [retry, setRetry] = useState(0), [arrange, setArrange] = useState(0)
  const [frame, setFrame] = useState<CollaborationGeometryFrame>(() => ({ boxes: new Map(), paths: new Map() }))
  const [transitioning, setTransitioning] = useState(false)
  const [busy, setBusy] = useState(false), [issues, setIssues] = useState<ReadonlyMap<string, string>>(new Map())
  const geometry = useRef({ structure: '', arrange: -1, ...frame, held: new Map<string, CollaborationLayoutBox>(), structureInput: null as CollaborationLayoutStructure | null }), epoch = useRef(0)
  const presented = useRef(frame), animation = useRef<number | null>(null), motionEnabled = useRef(motion)
  const window = useWorkbenchDocument().defaultView!
  motionEnabled.current = motion
  const publish = useCallback((next: CollaborationGeometryFrame) => {
    if (presented.current.boxes === next.boxes && presented.current.paths === next.paths) return
    presented.current = next; setFrame(next)
  }, [])
  const settle = useCallback((complete = true) => {
    if (animation.current !== null) window.cancelAnimationFrame(animation.current)
    animation.current = null; setTransitioning(false)
    if (complete) publish({ boxes: geometry.current.boxes, paths: geometry.current.paths })
  }, [window, publish])
  const present = useCallback((target: CollaborationGeometryFrame, animate: boolean) => {
    settle(false)
    const from = presented.current
    if (!animate || !motionEnabled.current || !from.boxes.size || ![...target.boxes].some(([id, box]) => from.boxes.has(id) && from.boxes.get(id) !== box)) { publish(target); return }
    setTransitioning(true)
    let started: number | undefined
    const step = (time: number) => {
      started ??= time
      const progress = Math.min(1, (time - started) / COLLABORATION_LAYOUT_TRANSITION_MS), eased = progress * progress * (3 - 2 * progress)
      publish(interpolateCollaborationGeometry(from, target, eased))
      if (progress < 1) animation.current = window.requestAnimationFrame(step)
      else { animation.current = null; setTransitioning(false) }
    }
    animation.current = window.requestAnimationFrame(step)
  }, [window, publish, settle])
  useEffect(() => { if (!motion || !active) settle() }, [motion, active, settle])
  useEffect(() => () => { if (animation.current !== null) window.cancelAnimationFrame(animation.current) }, [window])
  const latest = useRef(input); latest.current = input
  const latestStructure = useRef(structure); latestStructure.current = structure
  useEffect(() => {
    const token = ++epoch.current
    if (!active) { setBusy(false); return }
    let worker: Worker | undefined, warning: ReturnType<typeof setTimeout> | undefined
    const current = () => token === epoch.current && latestStructure.current === structure
    const failure = (message: string, key = 'layout') => setIssues(previous => new Map(previous).set(key, message))
    const needsPlacement = geometry.current.structure !== structure || geometry.current.arrange !== arrange
    const missing = latest.current.connections.filter(edge => !geometry.current.paths.has(edge.id))
    if (!needsPlacement && !missing.length) { setBusy(false); return }
    setBusy(true)
    // Combine pages arriving together, without coupling Worker jobs to source loading or live pulse timers.
    const start = setTimeout(() => {
      if (!current()) return
      try { worker = createCollaborationLayoutWorker() }
      catch (error) { setBusy(false); failure(`Map layout could not start: ${error instanceof Error ? error.message : String(error)}. Original Agents and sources are retained.`); return }
      const id = mintObjectId()
      const submitted = latest.current
      const requestedAnchor = readingAnchor.current
      const staged = needsPlacement && geometry.current.boxes.size > 0 && geometry.current.arrange === arrange && motionEnabled.current
      let layoutFailed = false
      let offset = { x: 0, y: 0 }
      worker.onmessage = (event: MessageEvent<CollaborationLayoutResponse>) => {
        const response = event.data
        if (!current() || response.id !== id) return
        if (response.type === 'boxes') {
          // Read the last real occurrence now, not the pointer/selection from when this job started.
          const anchor = readingAnchor.current, previous = anchor ? geometry.current.boxes.get(anchor) : undefined
          const placed = anchor ? response.boxes.find(box => box.id === anchor) : undefined
          const point = (box: CollaborationLayoutBox) => box.kind === 'area' ? { x: box.x + box.heading.x, y: box.y + box.heading.y } : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
          if (response.retainedPaths && anchor !== requestedAnchor && previous && placed && (point(previous).x !== point(placed).x || point(previous).y !== point(placed).y)) {
            // A later real reading intent supersedes this local placement; keep the visible world until it settles.
            ++epoch.current; worker?.terminate(); setRetry(value => value + 1); return
          }
          if (response.retainedPaths === undefined && previous && placed) offset = { x: point(previous).x - point(placed).x, y: point(previous).y - point(placed).y }
          else if (anchor && !placed) readingAnchor.current = null
          const next = new Map(response.boxes.map(box => {
            const value = offset.x || offset.y ? { ...box, x: box.x + offset.x, y: box.y + offset.y } : box
            const old = geometry.current.boxes.get(box.id)
            const sameHeading = value.kind !== 'area' || old?.kind === 'area' && value.heading.x === old.heading.x && value.heading.y === old.heading.y && value.heading.width === old.heading.width && value.heading.height === old.heading.height
            return [box.id, old && old.kind === value.kind && old.areaId === value.areaId && old.x === value.x && old.y === value.y && old.width === value.width && old.height === value.height && old.folded === value.folded && sameHeading ? old : value] as const
          }))
          const retained = new Set(response.retainedPaths ?? []), paths = new Map([...geometry.current.paths].filter(([id]) => retained.has(id)))
          const valid = new Set([...submitted.areas.map(area => area.id), ...submitted.nodes.map(node => node.id)])
          const held = new Map([...(response.retainedPaths === undefined ? [] : geometry.current.held), ...next].filter(([id]) => valid.has(id)))
          geometry.current = { structure, arrange, boxes: next, paths, held, structureInput: { areas: submitted.areas, nodes: submitted.nodes } }
          if (!staged) publish({ boxes: next, paths })
          setIssues(new Map())
        } else if (response.type === 'paths') {
          const next = new Map(geometry.current.paths)
          for (const [key, path] of Object.entries(response.paths)) next.set(key, translateCollaborationPath(path, offset))
          setIssues(previous => { const next = new Map(previous); for (const key of Object.keys(response.paths)) next.delete(key); return next })
          geometry.current = { ...geometry.current, paths: next }
          if (!staged) publish({ boxes: geometry.current.boxes, paths: next })
        } else if (response.type === 'error') { if (!response.connectionId) layoutFailed = true; failure(response.message, response.connectionId ?? 'layout') }
        else if (response.type === 'complete') { clearTimeout(warning); worker?.terminate(); if (staged) present({ boxes: geometry.current.boxes, paths: geometry.current.paths }, true); setBusy(false); if (!layoutFailed) setIssues(previous => { const next = new Map(previous); next.delete('layout'); return next }) }
      }
      worker.onerror = () => { if (current()) { clearTimeout(warning); worker?.terminate(); setBusy(false); failure('Map layout stopped. Existing positions, original Agents and sources are retained. Retry layout.')} }
      warning = setTimeout(() => { if (current()) failure('Map layout is still computing. You can keep reading, or retry this layout.') }, 8000)
      const request: CollaborationLayoutRequest = needsPlacement ? geometry.current.boxes.size && geometry.current.arrange === arrange
        ? { id, type: 'reconcile', input: submitted, previousStructure: geometry.current.structureInput!, boxes: [...geometry.current.held.values()], paths: [...geometry.current.paths.values()], anchor: requestedAnchor }
        : { id, type: 'arrange', input: submitted }
        : { id, type: 'route', boxes: [...geometry.current.boxes.values()], connections: missing }
      worker.postMessage(request)
    }, 100)
    return () => { ++epoch.current; clearTimeout(start); clearTimeout(warning); worker?.terminate(); settle(false) }
  }, [structure, topology, active, retry, arrange, readingAnchor, publish, present, settle])
  return { ...frame, busy: busy || transitioning, issues, settle, retry: () => setRetry(value => value + 1), arrange: () => { settle(); setArrange(value => value + 1) } }
}
