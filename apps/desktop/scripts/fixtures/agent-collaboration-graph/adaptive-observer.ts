import type { CollaborationLayoutBox, CollaborationPath } from '../../../src/renderer/src/lib/collaboration-layout-engine'
import { agentInformationPreview } from '../../../src/renderer/src/lib/agent-information-preview'

type Delivered = { boxes: ReadonlyMap<string, CollaborationLayoutBox>; paths: ReadonlyMap<string, CollaborationPath>; busy: boolean; transitioning: boolean; issues: ReadonlyMap<string, string> }
const delivered = () => (globalThis as typeof globalThis & { __collaborationCaptureLayout?: Delivered }).__collaborationCaptureLayout
const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }

/** Explicit finite observation of the real presented frame and original DOM.
 * It never writes geometry, camera, inputs or product scheduling. */
export function createAdaptivePresentationObserver(ids: () => ReadonlySet<string>, parents: () => ReadonlyMap<string, string>) {
  let anchor: HTMLElement | null = null, reader: Element | null = null, focused: Element | null = null
  let reading: { id: string; token: object; hostId: string; subject: string; runId: string } | null = null
  type Trace = { label: string; frame: number; samples: ReturnType<typeof sample>[]; overheadMS: number; gesture?: { at: number; trusted: boolean; inCanvas: boolean; transitioning: boolean | null } }
  let trace: Trace | undefined
  let gestureListener: ((event: PointerEvent) => void) | undefined
  function sample() {
    const request = reading && agentInformationPreview.getAll().find(request => request.token === reading!.token)
    const layout = delivered(), wanted = ids(), parent = parents(), selected = [...wanted].flatMap(id => { const box = layout?.boxes.get(id); return box ? [box] : [] })
    const nodes = new Map([...document.querySelectorAll<HTMLElement>('.collaboration-map .react-flow__node')].filter(node => wanted.has(node.dataset.id!)).map(node => [node.dataset.id!, node]))
    const viewport = document.querySelector('.collaboration-map .react-flow__viewport'), matrix = viewport ? new DOMMatrix(getComputedStyle(viewport).transform) : null
    const edges = [...document.querySelectorAll<SVGGElement>('.collaboration-map .react-flow__edge')].flatMap(edge => {
      const [, source, target] = JSON.parse(edge.dataset.id!) as [string, string, string]
      if (!wanted.has(source) || !wanted.has(target)) return []
      const path = edge.querySelector<SVGPathElement>('.react-flow__edge-path'), transform = path?.getScreenCTM(), length = path?.getTotalLength()
      if (!path || !transform || !length) return []
      const endpoints = [[source, 0], [target, length]].flatMap(([id, at]) => {
        const body = nodes.get(String(id))?.querySelector<HTMLElement>('.collaboration-agent__body')
        if (!body) return []
        const point = path.getPointAtLength(Number(at)), screen = new DOMPoint(point.x, point.y).matrixTransform(transform)
        return [{ id: String(id), point: { x: screen.x, y: screen.y }, body: rect(body), radius: Number.parseFloat(body.style.borderRadius) * Math.hypot(transform.a, transform.b) }]
      })
      return [{ id: edge.dataset.id!, path: path.getAttribute('d'), endpoints }]
    })
    const envelopes = [...nodes].flatMap(([id, node]) => {
      const path = node.querySelector<SVGPathElement>('.collaboration-area__envelope path'), area = layout?.boxes.get(id)
      if (!path || area?.kind !== 'area' || area.folded) return []
      const members = selected.filter(box => box.id !== id && (box.kind === 'agent' ? box.areaId === area.areaId : parent.get(box.id) === id))
      const rectangles = [area.heading, ...members.map(box => ({ ...box, x: box.x - area.x, y: box.y - area.y }))]
      return [{ id, members: members.map(box => box.id), path: path.getAttribute('d'), corners: rectangles.flatMap(box => [box.x, box.x + box.width].flatMap(x => [box.y, box.y + box.height].map(y => ({ x, y, inside: path.isPointInFill(new DOMPoint(x, y)) })))) }]
    })
    const renderer = document.querySelector('.collaboration-map .react-flow__renderer')
    return { at: performance.now(), busy: layout?.busy ?? null, transitioning: layout?.transitioning ?? null,
      boxes: selected, issues: [...layout?.issues ?? []],
      camera: viewport?.getAttribute('style') ?? null, zoom: matrix?.a ?? null,
      surface: renderer ? rect(renderer) : null, transform: matrix ? { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f } : null,
      nodes: [...nodes].map(([id, node]) => ({ id, bounds: rect(node), transform: node.style.transform })), edges, envelopes,
      held: { sameAnchor: Boolean(anchor?.isConnected && request?.anchor === anchor), sameReader: Boolean(reader?.isConnected && request?.id === reading?.id && document.getElementById(request.id) === reader), sameFocus: Boolean(focused && focused === document.activeElement), readers: document.querySelectorAll('.agent-information-reader').length,
        subject: request?.context.id, hostId: request?.context.hostId, runId: request?.context.runId,
        sameSubject: Boolean(request && reading && request.context.id === reading.subject && request.context.hostId === reading.hostId && request.context.runId === reading.runId), readerBounds: reader?.isConnected ? rect(reader) : null },
      motion: document.querySelector('[aria-label="Map animations"]')?.getAttribute('aria-pressed'), packets: document.querySelectorAll('.collaboration-edge__packet,.collaboration-edge__pulse').length }
  }
  return {
    status() { const layout = delivered(); return { busy: layout?.busy ?? true, transitioning: layout?.transitioning ?? false, boxes: layout?.boxes.size ?? 0, paths: layout?.paths.size ?? 0 } },
    remember(element: HTMLElement) {
      const request = agentInformationPreview.getAll().find(request => request.anchor === element)
      const panel = request && document.getElementById(request.id)
      if (!request || !panel?.matches('.agent-information-reader') || element.getAttribute('aria-describedby') !== request.id || !element.isConnected) throw Error('The exact original adaptive request, Reader and anchor must be linked')
      anchor = element; reader = panel; focused = document.activeElement
      reading = { id: request.id, token: request.token, hostId: request.context.hostId, subject: request.context.id, runId: request.context.runId }
      return sample()
    },
    rememberFocus() { focused = document.activeElement },
    sample,
    start(label: string) {
      if (trace) throw Error('Only one finite adaptive observation at a time')
      const current: Trace = trace = { label, frame: 0, samples: [], overheadMS: 0 }
      gestureListener = event => { current.gesture = { at: performance.now(), trusted: event.isTrusted, inCanvas: Boolean((event.target as Element)?.closest('.collaboration-canvas')), transitioning: delivered()?.transitioning ?? null } }
      document.addEventListener('pointerdown', gestureListener, { capture: true, once: true })
      const next = () => {
        if (trace !== current) return
        const start = performance.now(); current.samples.push(sample()); current.overheadMS += performance.now() - start
        if (current.samples.length < 240) current.frame = requestAnimationFrame(next)
      }
      current.frame = requestAnimationFrame(next)
    },
    stop() { if (!trace) throw Error('An actual adaptive observation must be active'); const current = trace; trace = undefined; cancelAnimationFrame(current.frame); if (gestureListener) document.removeEventListener('pointerdown', gestureListener, true); gestureListener = undefined; return { ...current, frame: undefined } }
  }
}
