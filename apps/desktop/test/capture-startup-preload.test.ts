import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CaptureSurfaceApi, CaptureSurfaceEvent, CaptureSurfaceInput } from '../src/shared/capture-surface'

const wire = vi.hoisted(() => ({ api: null as CaptureSurfaceApi | null, invoke: vi.fn(), events: new Map<string, (...args: any[]) => void>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: CaptureSurfaceApi) => { expect(name).toBe('captureSurface'); wire.api = api } },
  ipcRenderer: {
    invoke: wire.invoke,
    on: (name: string, listener: (...args: any[]) => void) => wire.events.set(name, listener),
    removeListener: (name: string, listener: (...args: any[]) => void) => { if (wire.events.get(name) === listener) wire.events.delete(name) }
  }
}))
const originalMainFrame = Object.getOwnPropertyDescriptor(process, 'isMainFrame')
beforeEach(() => {
  vi.resetModules(); wire.api = null; wire.events.clear(); wire.invoke.mockReset()
  Object.defineProperty(process, 'isMainFrame', { configurable: true, value: true })
})
afterEach(() => {
  if (originalMainFrame) Object.defineProperty(process, 'isMainFrame', originalMainFrame)
  else delete (process as NodeJS.Process & { isMainFrame?: boolean }).isMainFrame
})

const image = { mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,AA==', width: 1, height: 1, byteLength: 1 }
const initial: CaptureSurfaceInput = {
  requestId: 'request-1', revision: 1, displayId: 1, frame: { x: 0, y: 0, width: 1, height: 1 }, scale: 1, safeTop: 0,
  attachToDraft: false, expandable: true, theme: { status: 'unavailable', message: 'fixture' }, background: 'included',
  backgrounds: {
    included: { status: 'ready', capturedAt: 1, image, windows: [], engine: 'included' },
    excluded: { status: 'pending', capturedAt: 0 }
  }
}
const settled: CaptureSurfaceEvent = { kind: 'snapshot', requestId: 'request-1', revision: 2, background: 'excluded',
  frame: { status: 'ready', capturedAt: 2, image: { ...image, dataUrl: 'data:image/png;base64,AQ==' }, windows: [], engine: 'excluded' } }

it('replays a settled deferred frame through load and acknowledges it without duplicate PNG delivery', async () => {
  await import('../src/preload/capture-surface')
  const receive = wire.events.get('screenshot:capture-surface-event')
  expect(receive, 'the preload listens before Renderer calls load').toBeDefined()
  wire.invoke.mockImplementation(async (_channel: string, action: string) => action === 'load' ? initial : undefined)
  receive!({}, settled)
  expect(wire.invoke).toHaveBeenCalledWith('screenshot:capture-surface', 'frame-ack', { requestId: 'request-1', revision: 2 })
  const loaded = await wire.api!.load()
  expect(loaded).toMatchObject({ revision: 2, backgrounds: { included: initial.backgrounds.included, excluded: settled.kind === 'snapshot' ? settled.frame : null } })
  const events: CaptureSurfaceEvent[] = []
  wire.api!.onEvent(event => events.push(event))
  await Promise.resolve()
  expect(events).toEqual([settled])
  receive!({}, settled)
  receive!({}, { ...settled, revision: 1 })
  await Promise.resolve()
  expect(events, 'revision deduplicates a repeated large PNG and rejects stale delivery').toEqual([settled])
})
