// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL as FileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LatestBrowserBoundsSynchronizer } from '../src/renderer/src/lib/browser-bounds-sync'
import { observeBrowserStageGeometry } from '../src/renderer/src/lib/browser-stage-geometry'

const observation = vi.hoisted(() => ({ update: null as (() => void) | null, cleanup: vi.fn() }))
const observe = vi.hoisted(() => vi.fn())
vi.mock('@floating-ui/dom', () => ({ autoUpdate: observe }))
const resize = { callback: null as ResizeObserverCallback | null, observe: vi.fn(), disconnect: vi.fn() }
vi.stubGlobal('ResizeObserver', class {
  constructor(callback: ResizeObserverCallback) { resize.callback = callback }
  observe = resize.observe
  disconnect = resize.disconnect
})
afterEach(() => { observation.update = null; resize.callback = null; document.body.replaceChildren(); vi.clearAllMocks() })

describe('native Browser stage position observation', () => {
  it('sends a position-only movement through the existing bounds owner and releases observation', async () => {
    const stage = document.createElement('div')
    let rect = { x: 510, y: 74, width: 242, height: 794 }
    stage.getBoundingClientRect = () => new DOMRect(rect.x, rect.y, rect.width, rect.height)
    document.body.append(stage)
    const apply = vi.fn(async () => {})
    const sync = new LatestBrowserBoundsSynchronizer(apply, vi.fn())
    const update = () => sync.observe(rect)
    observe.mockImplementation((reference, backing, callback) => {
      expect(reference).toBe(stage); expect(backing).toBe(stage)
      observation.update = callback; callback()
      return observation.cleanup
    })
    const dispose = observeBrowserStageGeometry(stage, update, true)
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce())
    rect = { ...rect, y: 71 }
    expect(observation.update).toBeTypeOf('function')
    observation.update!()
    await vi.waitFor(() => expect(apply.mock.calls).toEqual([
      [{ x: 510, y: 74, width: 242, height: 794 }],
      [{ x: 510, y: 71, width: 242, height: 794 }]
    ]))
    expect(observe).toHaveBeenCalledWith(stage, stage, update, { elementResize: false, layoutShift: true, animationFrame: false })
    expect(resize.observe).toHaveBeenCalledExactlyOnceWith(stage)
    rect = { ...rect, height: 820 }
    expect(resize.callback).toBeTypeOf('function')
    resize.callback!([], {} as ResizeObserver)
    await vi.waitFor(() => expect(apply.mock.calls.at(-1)).toEqual([{ x: 510, y: 71, width: 242, height: 820 }]))
    expect(apply).toHaveBeenCalledTimes(3)
    dispose(); expect(observation.cleanup).toHaveBeenCalledOnce(); expect(resize.disconnect).toHaveBeenCalledOnce()
    sync.dispose()
  })

  it('does not subscribe or update an inactive stage', () => {
    const update = vi.fn()
    const dispose = observeBrowserStageGeometry(document.createElement('div'), update, false)
    expect(observe).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled()
    expect(resize.observe).not.toHaveBeenCalled()
    dispose(); expect(observation.cleanup).not.toHaveBeenCalled()
  })

  it('the product calls and cleans the observer in its geometry effect with actual visibility facts', () => {
    const source = readFileSync(fileURLToPath(new FileURL('../src/renderer/src/components/BrowserPane.tsx', import.meta.url)), 'utf8')
    const start = source.indexOf('let stopObserving = observeBrowserStageGeometry(')
    const end = source.indexOf('// yieldToFocusRing', start)
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start)
    const effect = source.slice(start, end)
    expect(effect).toContain('observeBrowserStageGeometry(stage, update, visible && !released && !restoring)')
    expect(effect).toContain('stopObserving()')
    expect(effect).toContain('synchronizer.dispose()')
    expect(effect).not.toContain('observer.observe(stage)')
  })
})
