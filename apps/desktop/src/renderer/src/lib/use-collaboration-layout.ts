import { useEffect, useRef, useState } from 'react'
import type { CollaborationLayoutInput, CollaborationLayoutBox, CollaborationLayoutRequest, CollaborationLayoutResponse } from './collaboration-layout-engine'
import { translateCollaborationPath, type CollaborationPath } from './collaboration-layout-engine'

/** The original browser Worker boundary is replaceable only by test transport, not another layout engine. */
export function createCollaborationLayoutWorker() { return new Worker(new URL('./collaboration-layout.worker.ts', import.meta.url), { type: 'module' }) }

/** Disposable map geometry. Structural placement and new-path demand have separate invalidation. */
export function useCollaborationLayout(input: CollaborationLayoutInput, active: boolean, readingAnchor: { current: string | null }) {
  const structure = JSON.stringify([input.areas.map(area => [area.id, [...area.members].sort(), area.folded]).sort(), [...input.nodes].sort((a, b) => a.id.localeCompare(b.id))])
  const topology = JSON.stringify(input.connections.map(edge => [edge.id, edge.source, edge.target, edge.kind]))
  const [retry, setRetry] = useState(0), [arrange, setArrange] = useState(0)
  const [boxes, setBoxes] = useState<ReadonlyMap<string, CollaborationLayoutBox>>(new Map())
  const [paths, setPaths] = useState<ReadonlyMap<string, CollaborationPath>>(new Map())
  const [busy, setBusy] = useState(false), [issues, setIssues] = useState<ReadonlyMap<string, string>>(new Map())
  const geometry = useRef({ structure: '', arrange: -1, boxes, paths, held: new Map<string, CollaborationLayoutBox>() }), epoch = useRef(0)
  const latest = useRef(input); latest.current = input
  useEffect(() => {
    const token = ++epoch.current
    if (!active) { setBusy(false); return }
    let worker: Worker | undefined, warning: ReturnType<typeof setTimeout> | undefined
    const current = () => token === epoch.current
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
      const id = crypto.randomUUID()
      const requestedAnchor = readingAnchor.current
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
          if (response.retainedPaths === undefined && previous?.kind === 'agent' && placed?.kind === 'agent') offset = { x: previous.x - placed.x, y: previous.y - placed.y }
          else if (response.retainedPaths === undefined && previous?.kind === 'area' && placed?.kind === 'area') offset = {
            x: previous.x + previous.heading.x - placed.x - placed.heading.x,
            y: previous.y + previous.heading.y - placed.y - placed.heading.y }
          else if (anchor && !placed) readingAnchor.current = null
          const next = new Map(response.boxes.map(box => {
            const value = offset.x || offset.y ? { ...box, x: box.x + offset.x, y: box.y + offset.y } : box
            const old = geometry.current.boxes.get(box.id)
            const sameHeading = value.kind !== 'area' || old?.kind === 'area' && value.heading.x === old.heading.x && value.heading.y === old.heading.y && value.heading.width === old.heading.width && value.heading.height === old.heading.height
            return [box.id, old && old.kind === value.kind && old.x === value.x && old.y === value.y && old.width === value.width && old.height === value.height && old.folded === value.folded && sameHeading ? old : value] as const
          }))
          const retained = new Set(response.retainedPaths ?? []), paths = new Map([...geometry.current.paths].filter(([id]) => retained.has(id)))
          const valid = new Set([...latest.current.areas.map(area => area.id), ...latest.current.nodes.map(node => node.id)])
          const held = new Map([...(response.retainedPaths === undefined ? [] : geometry.current.held), ...next].filter(([id]) => valid.has(id)))
          geometry.current = { structure, arrange, boxes: next, paths, held }
          setBoxes(next); setPaths(geometry.current.paths); setIssues(new Map())
        } else if (response.type === 'paths') {
          const next = new Map(geometry.current.paths)
          for (const [key, path] of Object.entries(response.paths)) next.set(key, translateCollaborationPath(path, offset))
          setIssues(previous => { const next = new Map(previous); for (const key of Object.keys(response.paths)) next.delete(key); return next })
          geometry.current = { ...geometry.current, paths: next }; setPaths(next)
        } else if (response.type === 'error') { if (!response.connectionId) layoutFailed = true; failure(response.message, response.connectionId ?? 'layout') }
        else if (response.type === 'complete') { clearTimeout(warning); worker?.terminate(); setBusy(false); if (!layoutFailed) setIssues(previous => { const next = new Map(previous); next.delete('layout'); return next }) }
      }
      worker.onerror = () => { if (current()) { clearTimeout(warning); worker?.terminate(); setBusy(false); failure('Map layout stopped. Existing positions, original Agents and sources are retained. Retry layout.')} }
      warning = setTimeout(() => { if (current()) failure('Map layout is still computing. You can keep reading, or retry this layout.') }, 8000)
      const request: CollaborationLayoutRequest = needsPlacement ? geometry.current.boxes.size && geometry.current.arrange === arrange
        ? { id, type: 'reconcile', input: latest.current, boxes: [...geometry.current.held.values()], paths: [...geometry.current.paths.values()], anchor: requestedAnchor }
        : { id, type: 'arrange', input: latest.current }
        : { id, type: 'route', boxes: [...geometry.current.boxes.values()], connections: missing }
      worker.postMessage(request)
    }, 100)
    return () => { ++epoch.current; clearTimeout(start); clearTimeout(warning); worker?.terminate() }
  }, [structure, topology, active, retry, arrange, readingAnchor])
  return { boxes, paths, busy, issues, retry: () => setRetry(value => value + 1), arrange: () => setArrange(value => value + 1) }
}
