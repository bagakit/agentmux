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
  onNativeBrowserInput(_listener: unknown) { return signals.pointerUnsubscribe }
} } }))
vi.mock('../src/renderer/src/lib/native-overlay-regions', () => ({
  observeNativeOverlayRegions(body: HTMLElement, _zoom: unknown, collect: typeof signals.collect) {
    expect(body).toBe(document.body)
    signals.collect = collect
    return { dispose: signals.dispose, handleNativeInput: signals.dismiss, setNativeDemand: signals.setDemand }
  }
}))

function Consumer({ generation }: { generation?: number }) { return <output>{useNativeOverlayChrome(document, generation === undefined ? undefined : { windowId: 'source-window', documentGeneration: generation })}</output> }
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

it('identical descriptors do not republish or clear a later native owner notice', async () => {
  signals.publish.mockResolvedValue({ projected: 1, capturedPixels: 2000 })
  const element = await mount()
  await act(async () => { signals.collect!(region('same')) })
  await act(async () => { signals.warning!('Actual owner input readiness is unconfirmed'); signals.collect!(region('same')) })
  expect(signals.publish).toHaveBeenCalledTimes(1)
  expect(element.textContent).toContain('input readiness is unconfirmed')
  await act(async () => { signals.warning!(''); signals.collect!(region('same')) })
  expect(signals.publish).toHaveBeenCalledTimes(1); expect(element.textContent).toBe('')
})

it('A followed by B in flight then A restores the latest A after B', async () => {
  signals.publish.mockResolvedValue({ projected: 1, capturedPixels: 2000 })
  await mount(); await act(async () => { signals.collect!(region('A')) })
  let finish!: (receipt: NativeOverlayReceipt) => void
  signals.publish.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await act(async () => { signals.collect!(region('B')); signals.collect!(region('A')) })
  expect(signals.publish.mock.calls).toEqual([[region('A')], [region('B')]])
  await act(async () => { finish({ projected: 1, capturedPixels: 2000 }) })
  expect(signals.publish.mock.calls).toEqual([[region('A')], [region('B')], [region('A')]])
})

it('an unconfirmed in-flight delivery invalidates the earlier descriptor before retrying the same A', async () => {
  signals.publish.mockResolvedValue({ projected: 1, capturedPixels: 2000 })
  await mount(); await act(async () => { signals.collect!(region('A')) })
  let reject!: (error: Error) => void
  signals.publish.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  await act(async () => { signals.collect!(region('B')); signals.collect!(region('A')) })
  await act(async () => { reject(new Error('B delivery is unknown')) })
  expect(signals.publish.mock.calls).toEqual([[region('A')], [region('B')], [region('A')]])
})

it('an older response cannot restore a notice cleared by its actual owner while publication was in flight', async () => {
  let finish!: (receipt: NativeOverlayReceipt) => void
  signals.publish.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const element = await mount()
  await act(async () => { signals.collect!(region('A')); signals.warning!('preparing'); signals.warning!('') })
  await act(async () => { finish({ projected: 1, capturedPixels: 2000, warning: 'earlier preparation was unconfirmed' }) })
  expect(element.textContent).toBe('')
})

it.each(['id', 'bounds', 'radius', 'scrim', 'modal', 'stage', 'order'] as const)('a changed %s is a new native descriptor', async field => {
  signals.publish.mockResolvedValue({ projected: 2, capturedPixels: 2000 })
  await mount()
  const first = [...region('A'), ...region('B')], changed = structuredClone(first)
  if (field === 'id') changed[0]!.id = 'C'
  if (field === 'bounds') changed[0]!.bounds.x++
  if (field === 'radius') changed[0]!.radius++
  if (field === 'scrim') changed[0]!.scrim = 'rgba(0,0,0,.4)'
  if (field === 'modal') changed[0]!.modal = { id: 'original-presentation', part: 'content' }
  if (field === 'stage') changed[0]!.browserStages = [{ browserId: 'original-page', bounds: { x: 10, y: 20, width: 20, height: 20 } }]
  if (field === 'order') changed.reverse()
  await act(async () => { signals.collect!(first) }); await act(async () => { signals.collect!(changed) })
  expect(signals.publish).toHaveBeenCalledTimes(2)
})

it('captures the original descriptor before the caller mutates its next desired geometry', async () => {
  let finish!: (receipt: NativeOverlayReceipt) => void
  signals.publish.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  signals.publish.mockResolvedValue({ projected: 1, capturedPixels: 2000 })
  await mount(); const original = region('A')
  await act(async () => { signals.collect!(original) })
  original[0]!.bounds.x = 600
  await act(async () => { signals.collect!(original) })
  expect(signals.publish.mock.calls[0]![0][0]!.bounds.x).toBe(10)
  await act(async () => { finish({ projected: 1, capturedPixels: 2000 }) })
  expect(signals.publish.mock.calls[1]![0][0]!.bounds.x).toBe(600)
})

it('retries the same descriptor after rejection or a typed modal delivery failure', async () => {
  signals.publish.mockRejectedValueOnce(new Error('transport failed'))
  signals.publish.mockResolvedValueOnce({ projected: 0, capturedPixels: 0, failures: [{ modalId: 'modal', message: 'preparation failed' }] })
  signals.publish.mockResolvedValue({ projected: 1, capturedPixels: 2000 })
  await mount()
  for (let attempt = 0; attempt < 3; attempt++) await act(async () => { signals.collect!(region('A')) })
  expect(signals.publish.mock.calls).toEqual([[region('A')], [region('A')], [region('A')]])
})

it.each(['y', 'width', 'height', 'modal-id', 'modal-part', 'stage-id', 'stage-x', 'stage-y', 'stage-width', 'stage-height', 'stage-order'] as const)('preserves the complete ordered descriptor for %s', async field => {
  signals.publish.mockResolvedValue({ projected: 1, capturedPixels: 2000 })
  await mount()
  const first = region('A')
  first[0]!.modal = { id: 'modal', part: 'content' }
  first[0]!.browserStages = ['page-A', 'page-B'].map(browserId => ({ browserId, bounds: { x: 10, y: 20, width: 20, height: 20 } }))
  const changed = structuredClone(first), item = changed[0]!
  if (field === 'y' || field === 'width' || field === 'height') item.bounds[field]++
  if (field === 'modal-id') item.modal!.id = 'another-modal'
  if (field === 'modal-part') item.modal!.part = 'scrim'
  if (field === 'stage-id') item.browserStages![0]!.browserId = 'another-page'
  if (field === 'stage-order') item.browserStages!.reverse()
  if (field === 'stage-x' || field === 'stage-y' || field === 'stage-width' || field === 'stage-height') item.browserStages![0]!.bounds[field.slice(6) as 'x' | 'y' | 'width' | 'height']++
  await act(async () => { signals.collect!(first) }); await act(async () => { signals.collect!(changed) })
  expect(signals.publish).toHaveBeenCalledTimes(2)
})

it('starts a fresh delivery cache when the same window has a new document generation', async () => {
  signals.publish.mockResolvedValue({ projected: 1, capturedPixels: 2000 })
  await mount()
  await act(async () => root!.render(<Consumer generation={7} />))
  await act(async () => { signals.collect!(region('A')) })
  const retiredCollect = signals.collect!
  await act(async () => root!.render(<Consumer generation={8} />))
  await act(async () => { retiredCollect(region('retired')); signals.collect!(region('A')) })
  expect(signals.publish.mock.calls.filter(call => call[0].length)).toEqual([
    [region('A'), { windowId: 'source-window', documentGeneration: 7 }],
    [region('A'), { windowId: 'source-window', documentGeneration: 8 }]
  ])
})
