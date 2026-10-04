// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeOverlayReceipt, NativeOverlayRegion } from '../src/shared/native-overlay'
import { useNativeOverlayChrome } from '../src/renderer/src/hooks/useNativeOverlayChrome'

const signals = vi.hoisted(() => ({
  publish: vi.fn<(regions: NativeOverlayRegion[]) => Promise<NativeOverlayReceipt>>(),
  collect: undefined as undefined | ((regions: NativeOverlayRegion[], warning?: string) => void),
  warning: undefined as undefined | ((warning: string) => void),
  demand: undefined as undefined | ((visibility: import('../src/shared/native-overlay').NativeBrowserVisibility) => void),
  setDemand: vi.fn(), demandUnsubscribe: vi.fn(), initialDemand: vi.fn(),
  dispose: vi.fn(), pointerUnsubscribe: vi.fn(), warningUnsubscribe: vi.fn(),
  dismiss: vi.fn()
}))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { ui: {
  publishNativeOverlays: signals.publish, getZoomFactor: () => 1,
  nativeBrowserVisibility: signals.initialDemand,
  onNativeBrowserVisibility(listener: typeof signals.demand) { signals.demand = listener; return signals.demandUnsubscribe },
  onNativeOverlayWarning(listener: (warning: string) => void) { signals.warning = listener; return signals.warningUnsubscribe },
  onNativeBrowserInput(listener: unknown) { expect(listener).toBe(signals.dismiss); return signals.pointerUnsubscribe }
} } }))
vi.mock('../src/renderer/src/lib/native-overlay-regions', () => ({
  observeNativeOverlayRegions(body: HTMLElement, _zoom: unknown, collect: typeof signals.collect) {
    expect(body).toBe(document.body)
    signals.collect = collect
    return { dispose: signals.dispose, handleNativeInput: signals.dismiss, setNativeDemand: signals.setDemand }
  }
}))

function Consumer() { return <output>{useNativeOverlayChrome()}</output> }
let root: Root | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.innerHTML = ''
  signals.collect = signals.warning = undefined
  signals.demand = undefined
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
function region(id: string): NativeOverlayRegion[] { return [{ id, bounds: { x: 10, y: 20, width: 50, height: 40 }, radius: 4 }] }
async function mount(): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = document.createElement('div'); document.body.appendChild(element)
  signals.initialDemand.mockImplementation(() => new Promise(() => {}))
  root = createRoot(element)
  await act(async () => root!.render(<Consumer />))
  return element
}

it('one in-flight publication coalesces actual next frames, with owner warnings kept in the mounted consumer', async () => {
  let finish!: (receipt: NativeOverlayReceipt) => void
  signals.publish.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  signals.publish.mockResolvedValue({ projected: 1, capturedPixels: 2000 })
  const element = await mount()
  await act(async () => {
    signals.collect!(region('first'))
    signals.collect!(region('superseded'))
    signals.collect!(region('latest'), 'Actual unsupported clip')
  })
  expect(signals.publish.mock.calls).toEqual([[region('first')]])
  await act(async () => { finish({ projected: 1, capturedPixels: 2000 }) })
  expect(signals.publish.mock.calls).toEqual([[region('first')], [region('latest')]])
  expect(element.querySelector('output')!.textContent).toBe('Actual unsupported clip')
  await act(async () => { signals.warning!('Actual native owner paint failed') })
  expect(element.querySelector('output')!.textContent).toBe('Actual native owner paint failed')
})

it('failed publication remains a visible notice and unmount releases the one window owner', async () => {
  signals.publish.mockRejectedValueOnce(new Error('IPC publication unavailable'))
  signals.publish.mockResolvedValue({ projected: 0, capturedPixels: 0 })
  const element = await mount()
  await act(async () => { signals.collect!(region('failed')) })
  expect(element.querySelector('output')!.textContent).toContain('Browser remains available')
  await act(async () => root!.unmount()); root = undefined
  expect(signals.dispose).toHaveBeenCalledTimes(1)
  expect(signals.pointerUnsubscribe).toHaveBeenCalledTimes(1)
  expect(signals.warningUnsubscribe).toHaveBeenCalledTimes(1)
  expect(signals.publish.mock.calls).toEqual([[region('failed')], [[]]])
})

it('initial visibility cannot override a newer Main event and a retired consumer never accepts delayed demand', async () => {
 let resolveInitial!: (visibility: import('../src/shared/native-overlay').NativeBrowserVisibility) => void
 signals.initialDemand.mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve }))
 await mount()
 signals.demand!({ revision: 2, bounds: [{ x: 10, y: 20, width: 50, height: 40 }] })
 await act(async () => resolveInitial({ revision: 1, bounds: [] }))
 expect(signals.setDemand.mock.calls).toEqual([[{ revision: 2, bounds: [{ x: 10, y: 20, width: 50, height: 40 }] }]])
 const oldDemand = signals.demand!
 await act(async () => root!.unmount()); root = undefined
 oldDemand({ revision: 3, bounds: [] })
 expect(signals.setDemand).toHaveBeenCalledTimes(1); expect(signals.demandUnsubscribe).toHaveBeenCalledTimes(1)
})
