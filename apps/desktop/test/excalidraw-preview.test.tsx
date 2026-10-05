// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { validateExcalidrawScene } from '../src/renderer/src/lib/file-formats/excalidraw-scene'
import { ExcalidrawFilePreview } from '../src/renderer/src/components/file-preview/ExcalidrawFilePreview'

const engine = vi.hoisted(() => ({ load: vi.fn(async (blob: Blob) => JSON.parse(await blob.text())), props: vi.fn(), wait: undefined as Promise<void> | undefined, importing: false }))
vi.mock('@excalidraw/excalidraw', async () => { engine.importing = true; await engine.wait; return { loadFromBlob: engine.load, Excalidraw: (props: unknown) => { engine.props(props); return <canvas /> } } })
afterEach(() => { engine.load.mockClear(); engine.props.mockClear(); vi.unstubAllGlobals() })
const image = 'data:image/png;base64,iVBORw0KGgo='
const scene = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ type: 'image', id: 'img', fileId: 'one' }], files: { one: { dataURL: image } } })

it('does not parse a scene after its in-flight engine import was hidden', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let resume!: () => void
  engine.wait = new Promise(resolve => { resume = resolve })
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<ExcalidrawFilePreview content={scene} />))
    await expect.poll(() => engine.importing).toBe(true)
    await act(async () => root.render(<ExcalidrawFilePreview content={scene} visible={false} />))
    resume(); await act(async () => { await vi.dynamicImportSettled() })
    expect(engine.load).not.toHaveBeenCalled()
    expect(container.querySelector('canvas')).toBeNull()
  } finally { resume(); engine.wait = undefined; await act(async () => root.unmount()) }
})

it('Excalidraw retains embedded images, forces read-only canvas and unmounts while hidden', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const observers: Array<{ resize(): void; disconnect: ReturnType<typeof vi.fn> }> = [], frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.stubGlobal('ResizeObserver', class { disconnect = vi.fn(); constructor(callback: () => void) { observers.push({ resize: callback, disconnect: this.disconnect }) } observe() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const flushFrames = async () => { for (let count = 0; count < 2; count++) await act(async () => { const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback(0)) }) }
  const container = document.createElement('div'), root = createRoot(container)
  const flush = async () => { await act(async () => { await vi.dynamicImportSettled() }); await act(async () => {}) }
  try {
    await act(async () => root.render(<ExcalidrawFilePreview content={scene} />)); await flush()
    expect(container.querySelector('canvas')).not.toBeNull()
    const props = engine.props.mock.calls.at(-1)?.[0]
    expect(props.viewModeEnabled).toBe(true)
    expect(props.handleKeyboardGlobally).toBe(false)
    expect(props.initialData.files.one.dataURL).toBe(image)
    expect(props.validateEmbeddable).toBe(false)
    const api = { refresh: vi.fn(), scrollToContent: vi.fn() }
    props.excalidrawAPI(api); await flushFrames()
    expect(api.scrollToContent).toHaveBeenCalledWith(undefined, { fitToContent: true, viewportZoomFactor: .85, animate: false })
    observers[0]!.resize(); await flushFrames()
    expect(api.refresh).toHaveBeenCalledTimes(2)
    expect(api.scrollToContent).toHaveBeenCalledTimes(2)
    observers[0]!.resize()
    await act(async () => root.render(<ExcalidrawFilePreview content={scene} visible={false} />))
    expect(container.querySelector('canvas')).toBeNull()
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
  } finally { await act(async () => root.unmount()) }
})

it('Excalidraw refuses ordinary JSON, remote images, missing images and over-budget scenes', () => {
  for (const content of ['{}', JSON.stringify({ version: 2, elements: [] }), JSON.stringify({ type: 'excalidraw', version: 99, elements: [] }),
    JSON.stringify({ type: 'excalidraw', version: 2, elements: [], files: { one: { dataURL: 'https://example.com/a.png' } } }),
    JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ type: 'image', fileId: 'missing' }] }),
    JSON.stringify({ type: 'excalidraw', version: 2, elements: Array.from({ length: 257 }, () => ({ type: 'rectangle' })) })]) {
    expect(() => validateExcalidrawScene(content)).toThrow()
  }
  expect(() => validateExcalidrawScene(scene)).not.toThrow()
})
