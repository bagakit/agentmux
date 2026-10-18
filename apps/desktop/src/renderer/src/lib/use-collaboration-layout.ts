import { useEffect, useRef, useState } from 'react'
import type { CollaborationLayoutInput, CollaborationLayoutBox, CollaborationLayoutRequest, CollaborationLayoutResponse } from './collaboration-layout-engine'
import { translateCollaborationPath, type CollaborationPath } from './collaboration-layout-engine'

/** The original browser Worker boundary is replaceable only by test transport, not another layout engine. */
export function createCollaborationLayoutWorker() { return new Worker(new URL('./collaboration-layout.worker.ts', import.meta.url), { type: 'module' }) }

/** Disposable map geometry. Structural placement and new-path demand have separate invalidation. */
export function useCollaborationLayout(input: CollaborationLayoutInput, active: boolean, readingAnchor: { current: string | null }) {
  const structure = JSON.stringify([input.areas.map(area => [area.id, area.members, area.folded]), input.nodes])
  const topology = JSON.stringify(input.connections.map(edge => [edge.id, edge.source, edge.target, edge.kind]))
  const [retry, setRetry] = useState(0), [arrange, setArrange] = useState(0)
  const [boxes, setBoxes] = useState<ReadonlyMap<string, CollaborationLayoutBox>>(new Map())
  const [paths, setPaths] = useState<ReadonlyMap<string, CollaborationPath>>(new Map())
  const [busy, setBusy] = useState(false), [issues, setIssues] = useState<ReadonlyMap<string, string>>(new Map())
  const geometry = useRef({ structure: '', arrange: -1, boxes, paths }), epoch = useRef(0)
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
      let layoutFailed = false
      let offset = { x: 0, y: 0 }
      worker.onmessage = (event: MessageEvent<CollaborationLayoutResponse>) => {
        const response = event.data
        if (!current() || response.id !== id) return
        if (response.type === 'boxes') {
          // Read the last real occurrence now, not the pointer/selection from when this job started.
          const anchor = readingAnchor.current, previous = anchor ? geometry.current.boxes.get(anchor) : undefined
          const placed = anchor ? response.boxes.find(box => box.id === anchor) : undefined
          if (previous?.kind === 'agent' && placed?.kind === 'agent') offset = { x: previous.x - placed.x, y: previous.y - placed.y }
          else if (previous?.kind === 'area' && placed?.kind === 'area') offset = {
            x: previous.x + previous.heading.x - placed.x - placed.heading.x,
            y: previous.y + previous.heading.y - placed.y - placed.heading.y }
          else if (anchor) readingAnchor.current = null
          const next = new Map(response.boxes.map(box => [box.id, offset.x || offset.y ? { ...box, x: box.x + offset.x, y: box.y + offset.y } : box]))
          geometry.current = { structure, arrange, boxes: next, paths: new Map() }
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
      const request: CollaborationLayoutRequest = needsPlacement ? { id, type: 'arrange', input: latest.current }
        : { id, type: 'route', boxes: [...geometry.current.boxes.values()], connections: missing }
      worker.postMessage(request)
    }, 100)
    return () => { ++epoch.current; clearTimeout(start); clearTimeout(warning); worker?.terminate() }
  }, [structure, topology, active, retry, arrange, readingAnchor])
  return { boxes, paths, busy, issues, retry: () => setRetry(value => value + 1), arrange: () => setArrange(value => value + 1) }
}
