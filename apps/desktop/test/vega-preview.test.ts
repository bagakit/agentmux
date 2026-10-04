import { View } from 'vega'
import { expressionInterpreter } from 'vega-interpreter'
import { afterEach, expect, it, vi } from 'vitest'
import { compileVegaRuntime } from '../src/renderer/src/lib/file-formats/vega-spec'
import { createVegaPreview } from '../src/renderer/src/lib/file-formats/vega-worker'

const denied = async (): Promise<never> => { throw new Error('Unexpected resource') }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('Vega and Vega-Lite use real parsers and CSP-safe headless runtime expressions', async () => {
  const vega = { $schema: 'https://vega.github.io/schema/vega/v6.json', signals: [{ name: 'answer', update: '40 + 2' }], marks: [] }
  const lite = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', data: { values: [{ x: 'a', y: 3 }, { x: 'b', y: 5 }] }, mark: 'bar', encoding: { x: { field: 'x', type: 'nominal' }, y: { field: 'y', type: 'quantitative' } } }
  for (const [spec, mode] of [[vega, 'vega'], [lite, 'vega-lite']] as const) {
    let view: View | undefined, failure: unknown
    try {
      view = new View(compileVegaRuntime(JSON.stringify(spec), mode), { expr: expressionInterpreter, renderer: 'none' })
      await view.runAsync()
      if (mode === 'vega') expect(view.signal('answer')).toBe(42)
      else expect(view.data('source_0')).toHaveLength(2)
      expect(await view.toSVG()).toContain('<svg')
    } catch (error) { failure = error }
    finally { view?.finalize() }
    expect(failure).toBeUndefined()
  }
  expect(() => compileVegaRuntime(JSON.stringify(lite), 'vega')).toThrow('schema')
  expect(() => compileVegaRuntime('{', 'vega')).toThrow()
})

it('owns persistent, terminatable dataflow workers and bridges only original loader requests and ordered input', async () => {
  const workers: Array<any> = []
  vi.stubGlobal('Worker', class { onmessage?: (event: { data: unknown }) => void; postMessage = vi.fn(); terminate = vi.fn(); constructor() { workers.push(this) } })
  const controller = new AbortController(), snapshot = vi.fn(), error = vi.fn()
  let resolve!: (value: string) => void
  const load = vi.fn(() => new Promise<string>(yes => { resolve = yes }))
  const job = createVegaPreview('unsaved', 'vega-lite', { load, sanitize: denied, http: denied, file: denied }, controller.signal, { snapshot, error })
  const worker = workers[0]!
  expect(worker.postMessage).toHaveBeenCalledWith({ action: 'start', content: 'unsaved', mode: 'vega-lite', serial: 1 })
  worker.onmessage({ data: { snapshot: { svg: '<svg/>', width: 2, height: 2, bindings: [], events: [] } } })
  expect(snapshot).toHaveBeenCalledOnce()
  expect(worker.terminate).not.toHaveBeenCalled()
  worker.onmessage({ data: { handled: 1 } })
  job.event({ source: 'view', type: 'mousemove', x: 1, y: 1 })
  job.event({ source: 'view', type: 'mousemove', x: 2, y: 2 })
  job.event({ source: 'view', type: 'mousemove', x: 3, y: 3 })
  expect(worker.postMessage).toHaveBeenCalledTimes(2)
  worker.onmessage({ data: { handled: 2 } })
  expect(worker.postMessage).toHaveBeenLastCalledWith({ action: 'event', event: { source: 'view', type: 'mousemove', x: 3, y: 3 }, serial: 3 })
  job.event({ source: 'view', type: 'mousemove', x: 4, y: 4 })
  job.event({ source: 'view', type: 'click', x: 4, y: 4 })
  job.event({ source: 'view', type: 'mousemove', x: 5, y: 5 })
  worker.onmessage({ data: { handled: 3 } })
  expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: 'mousemove', x: 4 }) }))
  worker.onmessage({ data: { handled: 4 } })
  expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: 'click', x: 4 }) }))
  worker.onmessage({ data: { handled: 5 } })
  expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ event: expect.objectContaining({ type: 'mousemove', x: 5 }) }))
  worker.onmessage({ data: { resource: { id: 9, method: 'load', args: ['data.csv'] } } })
  expect(load).toHaveBeenCalledWith('data.csv')
  const late = worker.onmessage
  controller.abort()
  expect(worker.terminate).toHaveBeenCalledOnce()
  const sent = worker.postMessage.mock.calls.length
  resolve('late bytes'); await Promise.resolve(); await Promise.resolve()
  late({ data: { snapshot: { svg: '<svg>old</svg>' } } })
  expect(worker.postMessage).toHaveBeenCalledTimes(sent)
  expect(snapshot).toHaveBeenCalledOnce()
  job.dispose()
  expect(worker.terminate).toHaveBeenCalledOnce()
  const unavailable = createVegaPreview('source kept', 'vega', { load, sanitize: denied, http: denied, file: denied }, new AbortController().signal, { snapshot, error })
  workers[1].onmessage({ data: { resource: { id: 10, method: 'unknown', args: [] } } })
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unknown chart resource operation.' }))
  expect(workers[1].terminate).toHaveBeenCalledOnce()
  unavailable.dispose()
})

it('the actual worker runs official dataflow, emits SVG and finalizes the owned View on graceful disposal', async () => {
  vi.resetModules()
  const messages: any[] = [], port: { onmessage?: (event: any) => void; postMessage(value: any): void } = { postMessage: value => messages.push(value) }
  vi.stubGlobal('self', port)
  vi.stubGlobal('Image', undefined)
  vi.stubGlobal('OffscreenCanvas', class { getContext() { return { pixelRatio: 1, setTransform() {} } } })
  const engine = await import('vega'), finalize = vi.spyOn(engine.View.prototype, 'finalize')
  await import('../src/renderer/src/lib/file-formats/vega-chart.worker')
  port.onmessage!({ data: { action: 'start', content: JSON.stringify({ $schema: 'https://vega.github.io/schema/vega/v6.json', signals: [{ name: 'answer', update: '40+2' }, { name: 'level', value: 2, bind: { input: 'range', min: 0, max: 5 } }, { name: 'measured', value: 0, on: [{ events: 'container:resize', update: 'containerSize()[0]' }] }], marks: [{ type: 'text', encode: { update: { text: { signal: "answer + ':' + level + ':' + measured" } } } }] }), mode: 'vega', serial: 1 } })
  for (let i = 0; i < 100 && !messages.some(message => message.snapshot || message.error); i++) await new Promise(resolve => setTimeout(resolve, 2))
  expect(messages.find(message => message.error)).toBeUndefined()
  expect(messages.find(message => message.snapshot)?.snapshot.svg).toContain('42:2:0')
  port.onmessage!({ data: { action: 'signal', name: 'level', value: 4, serial: 2 } })
  await expect.poll(() => messages.some(message => message.snapshot?.svg.includes('42:4:0'))).toBe(true)
  port.onmessage!({ data: { action: 'resize', width: 333, height: 222, serial: 3 } })
  await expect.poll(() => messages.some(message => message.snapshot?.svg.includes('42:4:333'))).toBe(true)
  port.onmessage!({ data: { action: 'signal', name: 'unknown', value: 1, serial: 4 } })
  await expect.poll(() => messages.some(message => message.error === 'Unknown chart signal binding.')).toBe(true)
  port.onmessage!({ data: { action: 'dispose', serial: 5 } })
  for (let i = 0; i < 100 && !finalize.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 2))
  expect(finalize).toHaveBeenCalledOnce()
})
