// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { BrowserPresentationStage, type BrowserStagePresentation } from '../src/renderer/src/components/BrowserPresentationStage'
import { api } from '../src/renderer/src/lib/api'
const observation = vi.hoisted(() => ({ update: null as (() => void) | null }))
vi.mock('../src/renderer/src/lib/browser-stage-geometry', async importOriginal => ({ ...await importOriginal<object>(),
  observeBrowserStageGeometry(_stage: HTMLElement, update: () => void, active: boolean) { if (active) { observation.update = update; update() }; return () => { if (observation.update === update) observation.update = null } } }))
let root: ReturnType<typeof createClientUiRoot> | undefined, container: HTMLElement | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); container = undefined; observation.update = null; vi.restoreAllMocks(); vi.unstubAllGlobals() })
const a = { x: 220, y: 74, width: 960, height: 690 }, b = { ...a, y: 104, height: 660 }
it.each(['selection', 'retry'] as const)('[window-return-geometry] %s confirmation and observer keep one serial geometry owner', async action => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let rect = a, accepted: typeof a | null = null, release!: () => void, held = false
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(rect.x, rect.y, rect.width, rect.height))
  vi.spyOn(api.ui, 'getZoomFactor').mockReturnValue(1)
  vi.spyOn(api.browser, 'registerPresentation').mockResolvedValue({ leaseId: 'original-stage-lease' })
  vi.spyOn(api.browser, 'removePresentation').mockResolvedValue(undefined)
  const writes = vi.spyOn(api.browser, 'updatePresentation').mockImplementation(async (_lease, value) => {
    if (value.visible && value.bounds.y === b.y && !held) { held = true; await new Promise<void>(resolve => { release = resolve }) }
    accepted = value.visible ? value.bounds : null
  })
  const media = { stream: null, captureId: null, nativeCoverage: null, notice: action === 'retry' ? 'Original preview observation unavailable' : null,
    capturePhase: 'idle' as const, registered: vi.fn(async () => {}), ensureCapture: vi.fn(async () => {}), retryCapture: vi.fn(async () => {}),
    ownerClearedRevision: 0, readInputIntentRevision: () => 3 }
  const presentation: BrowserStagePresentation = { occurrence: { presentationId: 'original-stage', location: { displayWorkspaceId: 'display', groupId: 'group', tabId: 'tab', regionId: 'page' } },
    stageHostId: 'original-host', visible: true, active: true, yieldToFocusRing: false,
    target: { hostId: 'original-host', visible: true, active: true, surface: 'survey' } }
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  const render = (selected: boolean) => act(async () => root!.render(createElement(BrowserPresentationStage, { browserId: 'original-browser', navigationId: 'original-navigation', presentation, inputSelected: selected, blocked: false, media })))
  await render(false)
  await vi.waitFor(() => expect(accepted).toEqual(a))
  rect = b
  if (action === 'selection') await render(true)
  else await act(async () => [...container!.querySelectorAll('button')].find(button => button.textContent === 'Retry preview')!.click())
  await vi.waitFor(() => expect(held).toBe(true))
  rect = a
  expect(observation.update).not.toBeNull()
  await act(async () => observation.update!())
  release(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  await vi.waitFor(() => expect(accepted, 'The last native ACK must describe the actual current original Stage, including a return to its pre-detach rectangle').toEqual(a))
  expect(writes.mock.calls.filter(([, value]) => value.visible).map(([, value]) => value.visible && value.bounds)).toEqual([a, b, a])
})
