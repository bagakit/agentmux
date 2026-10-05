import * as Vega from 'vega'
import { expressionInterpreter } from 'vega-interpreter'
import { compileVegaRuntime } from './vega-spec'
import type { ChartBinding, ChartEvent, ChartRequest, ChartSnapshot } from './vega-chart-protocol'
import { WORKSPACE_FILE_MAX_BYTES } from '../../../../shared/workspace-file-bytes'

// Vega exports these mature runtime APIs; vega-typings omits their method signatures.
type Item = any
type Stream = { receive(event: unknown): void }
const EventStream = (Vega as unknown as { EventStream: new (filter?: (_: any) => boolean) => Stream }).EventStream
const streams: { source: ChartEvent['source']; type: string; stream: Stream }[] = []
let view: Vega.View | undefined, bindings: ChartBinding[] = [], rendering = false, queued = false, disposed = false, commandRunning = false
let nextResource = 0, tooltip = ''
const activeItems: Record<'mouse' | 'pointer', Item> = { mouse: null, pointer: null }
let containerWidth = 1, containerHeight = 1
let responsiveWidth = false, responsiveHeight = false
// Vega-Lite's responsive specs use this official expression function. The real
// ResizeObserver supplies the measured preview surface across the Worker boundary.
Vega.expressionFunction('containerSize', () => [containerWidth, containerHeight])
const resources = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d')!
;(context as any).pixelRatio = 1
class Picker extends Vega.CanvasHandler { context() { return context } }
const picker = new Picker() as unknown as { pick(scene: unknown, x: number, y: number, gx: number, gy: number): Item }

function resource(method: 'load' | 'sanitize', args: unknown[]): Promise<any> {
  return new Promise((resolve, reject) => { const id = ++nextResource; resources.set(id, { resolve, reject }); self.postMessage({ resource: { id, method, args } }) })
}
const denied = async (): Promise<never> => { throw new Error('Chart resources require the original Workspace loader.') }
const loader: Vega.Loader = { load: (...args) => resource('load', args), async sanitize(...args) {
  const result = await resource('sanitize', args)
  if (!result.bytes) return result
  const bytes = new Uint8Array(result.bytes)
  if (!/^image\/(png|jpeg|gif|webp)$/.test(result.mimeType) || bytes.byteLength > WORKSPACE_FILE_MAX_BYTES) throw new Error('Chart image is unavailable or exceeds the preview budget.')
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return { href: `data:${result.mimeType};base64,${btoa(binary)}` }
}, http: denied, file: denied }
// Vega's SVG renderer uses the browser Image contract for intrinsic dimensions.
// Worker decoding stays on this terminatable owner and closes its bitmap immediately.
class WorkerImage {
  width = 0; height = 0; complete = false; private value = ''
  onload?: () => void; onerror?: () => void
  get src() { return this.value }
  set src(value: string) {
    this.value = value
    if (!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(value)) { this.onerror?.(); return }
    const comma = value.indexOf(','), binary = atob(value.slice(comma + 1))
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    void createImageBitmap(new Blob([bytes], { type: value.slice(5, value.indexOf(';')) })).then(bitmap => {
      this.width = bitmap.width; this.height = bitmap.height; bitmap.close(); this.complete = true; this.onload?.()
    }).catch(() => this.onerror?.())
  }
}
Object.assign(globalThis, { Image: WorkerImage })
class ChartView extends Vega.View {
  events(source: any, type: any, filter?: (_: any) => boolean): any {
    if (source === 'timer') return super.events(source, type, filter)
    if (!['view', 'window', 'container'].includes(source)) throw new Error('Chart events may target the chart, its container or pointer window. External DOM selectors are unavailable.')
    const stream = new EventStream(filter)
    streams.push({ source, type, stream })
    return stream
  }
  async runAsync(...args: any[]): Promise<Vega.View> {
    const result = await (Vega.View.prototype.runAsync as (...args: any[]) => Promise<Vega.View>).apply(this, args)
    if (!rendering && !commandRunning) schedule()
    return result
  }
}
function schedule() {
  if (queued || disposed || !view) return
  queued = true
  queueMicrotask(() => { queued = false; void render().catch(fail) })
}
function fail(error: unknown) {
  if (disposed) return
  self.postMessage({ error: error instanceof Error ? error.message : String(error) })
}
async function render() {
  if (!view || disposed || rendering) return
  rendering = true
  try {
    const svg = await view.toSVG()
    if (new TextEncoder().encode(svg).byteLength > WORKSPACE_FILE_MAX_BYTES) throw new Error('The chart SVG exceeds the 16 MiB preview budget. Source was kept.')
    const width = Number(svg.match(/\bwidth="([\d.]+)"/)?.[1]), height = Number(svg.match(/\bheight="([\d.]+)"/)?.[1])
    const snapshot: ChartSnapshot = { svg, width, height, bindings: bindings.map(binding => ({ ...binding, value: view!.signal(binding.signal) })), events: [...streams.map(({ source, type }) => ({ source, type })), { source: 'view', type: 'mousemove' }, { source: 'view', type: 'pointermove' }], tooltip }
    if (!disposed) self.postMessage({ snapshot })
  } finally { rendering = false }
}

/** Vega's documented event.vega contract, backed by its own scenegraph picker. */
function chartEvent(packet: ChartEvent, previous?: Item): Record<string, unknown> {
  const padding = view!.padding() as { left: number; top: number }, origin = view!.origin()
  const offset = [padding.left + origin[0], padding.top + origin[1]], point = [packet.x - offset[0]!, packet.y - offset[1]!]
  context.setTransform(1, 0, 0, 1, offset[0]!, offset[1]!)
  const item = packet.source === 'view' ? previous ?? picker.pick((view!.scenegraph() as unknown as { root: unknown }).root, packet.x, packet.y, point[0]!, point[1]!) : null
  const group = (name?: string) => {
    let result = item ? item.mark.marktype === 'group' ? item : item.mark.group : null
    if (name) for (let current = item; current; current = current.mark?.group) if (current.mark?.name === name) { result = current; break }
    return result?.mark?.interactive ? result : {}
  }
  const xy = (relative?: Item) => {
    if (!relative) return point
    if (typeof relative === 'string') relative = group(relative)
    const result = point.slice()
    while (relative) { result[0]! -= relative.x || 0; result[1]! -= relative.y || 0; relative = relative.mark?.group }
    return result
  }
  tooltip = item?.tooltip == null ? '' : typeof item.tooltip === 'string' ? item.tooltip.slice(0, 2048) : JSON.stringify(item.tooltip).slice(0, 2048)
  return { ...packet, preventDefault() {}, dataflow: view, item, vega: { view: () => view, item: () => item || {}, group, xy, x: (relative?: Item) => xy(relative)[0], y: (relative?: Item) => xy(relative)[1] } }
}
async function handle(request: Exclude<ChartRequest, { action: 'resource' }>) {
  if (disposed) return
  if (request.action === 'start') {
    const compiled = compileVegaRuntime(request.content, request.mode), runtime = compiled.runtime
    responsiveWidth = compiled.responsiveWidth; responsiveHeight = compiled.responsiveHeight
    bindings = (runtime.bindings ?? []).map((binding: any) => {
      if (binding.element || !['range', 'select', 'radio', 'checkbox', 'number', 'text', 'color', 'date'].includes(binding.input)) throw new Error('This chart binding is unavailable in an isolated preview. Source was kept.')
      return { ...binding, value: null }
    })
    view = new ChartView(runtime, { expr: expressionInterpreter, renderer: 'none', loader, hover: true })
    containerWidth = view.width() || 1; containerHeight = view.height() || 1
    // The message precedes synchronous dataflow so callers can prove termination while it is busy.
    self.postMessage({ phase: 'evaluating' })
    await view.runAsync()
    await render()
  } else if (request.action === 'event' && view) {
    const packet = request.event, prefix = packet.type.startsWith('pointer') ? 'pointer' : 'mouse', activeItem = activeItems[prefix]
    const leave = /^(mouse|pointer)out$/.test(packet.type), event = chartEvent(packet, leave ? activeItem : undefined)
    const emit = (source: string, type: string, value: unknown) => { for (const stream of streams) if (stream.source === source && stream.type === type) stream.stream.receive(value) }
    await (view as ChartView).runAsync(null, () => {
      if (packet.source === 'view' && /^(mouse|pointer)move$/.test(packet.type) && event.item !== activeItem) {
        if (activeItem) emit('view', `${prefix}out`, chartEvent({ ...packet, type: `${prefix}out` }, activeItem))
        emit('view', `${prefix}over`, chartEvent({ ...packet, type: `${prefix}over` }))
      }
      emit(packet.source, packet.type, event)
      if (packet.source === 'view' && /^(mouse|pointer)(move|over|out)$/.test(packet.type)) activeItems[prefix] = leave ? null : event.item
    })
    await render()
  } else if (request.action === 'signal' && view) {
    if (!bindings.some(binding => binding.signal === request.name)) throw new Error('Unknown chart signal binding.')
    view.signal(request.name, request.value)
    await view.runAsync()
    await render()
  } else if (request.action === 'resize' && view) {
    containerWidth = Math.max(1, request.width); containerHeight = Math.max(1, request.height ?? containerHeight)
    if (responsiveWidth) view.width(containerWidth)
    if (responsiveHeight) view.height(containerHeight)
    view.resize()
    await (view as ChartView).runAsync(null, () => {
      for (const stream of streams) if (stream.source === 'container' && stream.type === 'resize') stream.stream.receive(chartEvent({ source: 'container', type: 'resize', x: 0, y: 0 }))
    })
    await render()
  } else if (request.action === 'dispose') {
    disposed = true
    view?.finalize()
    view = undefined
    resources.clear()
  }
}
let tail = Promise.resolve()
self.onmessage = (event: MessageEvent<ChartRequest>) => {
  const request = event.data
  if (request.action === 'resource') {
    const pending = resources.get(request.id); resources.delete(request.id)
    if (request.error) pending?.reject(new Error(request.error))
    else pending?.resolve(request.value)
  } else tail = tail.then(async () => { commandRunning = true; try { await handle(request) } finally { commandRunning = false } }).catch(fail).finally(() => { if (request.serial !== undefined) self.postMessage({ handled: request.serial }) })
}
