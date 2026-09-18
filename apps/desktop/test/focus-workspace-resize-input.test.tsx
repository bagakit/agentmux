// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

// Mount the real Focus surface, controls and Store. Only its right-side Session
// leaf is replaced. The web-preview API supplies typed facts, not actual Runs.
// happy-dom has no CSS layout: the explicit rectangle below is pointer input,
// and splitX expresses the right-pane ratio contract, not a measured window.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const baseline = useAppStore.getState()
const layoutRect = { x: 100, y: 20, top: 20, left: 100, right: 1100, bottom: 620, width: 1000, height: 600, toJSON() {} }
let container: HTMLDivElement, root: Root
let originalCursor: string, originalUserSelect: string
let identity: Pick<ReturnType<typeof useAppStore.getState>, 'agentFocus' | 'sessions' | 'tabs' | 'agentComposerDrafts'>

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  originalCursor = document.body.style.cursor
  originalUserSelect = document.body.style.userSelect
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const config = await api.config.get(), { sessions } = await api.sessions.snapshot()
  const selected = sessions.find(session => session.kind === 'agent')!
  expect(selected).toBeTruthy()
  useAppStore.setState({ config, sessions, timelines: {}, tabs: {}, agentNames: {}, mainSurface: 'agents', agentComposerDrafts: { [selected.id]: 'Keep this original draft' }, agentFocus: { execution: { sessionId: selected.id, history: [{ sessionId: selected.id, focusedAt: 1 }] }, pmo: { sessionId: null } } })
  identity = useAppStore.getState()
  await act(async () => root.render(createElement(GlobalFocusSurface)))
  const layout = container.querySelector<HTMLElement>('.global-focus-layout')!
  expect(layout).toBeTruthy()
  vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue(layoutRect)
  expect(handle().getAttribute('aria-orientation')).toBe('vertical')
  expect(ratio()).toBeCloseTo(0.618)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState(baseline, true)
  document.body.style.cursor = originalCursor
  document.body.style.userSelect = originalUserSelect
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function handle() {
  const node = container.querySelector<HTMLElement>('[aria-label="Resize Focus workspace"]')
  expect(node).toBeTruthy()
  return node!
}

function ratio() {
  const surface = container.querySelector<HTMLElement>('.global-focus-surface')!
  expect(surface).toBeTruthy()
  const value = surface.style.getPropertyValue('--focus-workspace-width')
  const match = /^calc\(([\d.]+)% - 6px\)$/.exec(value)
  expect(match, `Actual product ratio style: ${value}`).not.toBeNull()
  return Number(match![1]) / 100
}

const splitX = () => layoutRect.right - layoutRect.width * ratio()
const key = (value: string) => act(async () => handle().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
const pointer = (target: EventTarget, type: string, init: PointerEventInit = {}) => act(async () => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', ...init })))

function expectOriginalIdentity() {
  const state = useAppStore.getState()
  expect(state.agentFocus).toBe(identity.agentFocus)
  expect(state.sessions).toBe(identity.sessions)
  expect(state.tabs).toBe(identity.tabs)
  expect(state.agentComposerDrafts).toBe(identity.agentComposerDrafts)
}

it.each([
  ['ArrowRight', 0.598, 20],
  ['ArrowLeft', 0.638, -20]
] as const)('%s moves the split in the same direction as primary pointer input', async (direction, expectedRatio, displacement) => {
  const beforeX = splitX()
  await key(direction)
  expect(ratio()).toBeCloseTo(expectedRatio)
  expect(splitX() - beforeX).toBeCloseTo(displacement)
  expect(handle().getAttribute('aria-valuenow')).toBe(String(Math.round(expectedRatio * 100)))
  await pointer(handle(), 'pointerdown', { button: 0, buttons: 1, clientX: splitX() })
  await pointer(window, 'pointermove', { buttons: 1, clientX: beforeX })
  expect(ratio()).toBeCloseTo(0.618)
  await pointer(window, 'pointerup', { button: 0, buttons: 0 })
  expectOriginalIdentity()
})

it('primary pointer changes the right-pane ratio and retains the existing bounds', async () => {
  await pointer(handle(), 'pointerdown', { button: 0, buttons: 1, clientX: splitX() })
  expect(document.body.style.cursor).toBe('col-resize')
  expect(document.body.style.userSelect).toBe('none')
  await pointer(window, 'pointermove', { buttons: 1, clientX: 600 })
  expect(ratio()).toBeCloseTo(0.5)
  await pointer(window, 'pointermove', { buttons: 1, clientX: 200 })
  expect(ratio()).toBeCloseTo(0.76)
  await pointer(window, 'pointermove', { buttons: 1, clientX: 1000 })
  expect(ratio()).toBeCloseTo(0.38)
  await pointer(window, 'pointerup', { button: 0, buttons: 0 })
  expect(document.body.style.cursor).toBe(originalCursor)
  expect(document.body.style.userSelect).toBe(originalUserSelect)
  expectOriginalIdentity()
})

it.each([[1, 4], [2, 2]] as const)('non-primary button %i does not resize on subsequent pointermove', async (button, buttons) => {
  await pointer(handle(), 'pointerdown', { button, buttons, clientX: splitX() })
  await pointer(window, 'pointermove', { buttons, clientX: 600 })
  expect(ratio()).toBeCloseTo(0.618)
  expect(document.body.style.cursor).toBe(originalCursor)
  expect(document.body.style.userSelect).toBe(originalUserSelect)
  expectOriginalIdentity()
})

it.each(['blur', 'pointercancel', 'pointerup'])('%s ends drag before any further pointermove', async stopEvent => {
  await pointer(handle(), 'pointerdown', { button: 0, buttons: 1, clientX: splitX() })
  await pointer(window, 'pointermove', { buttons: 1, clientX: 600 })
  expect(ratio()).toBeCloseTo(0.5)
  await act(async () => window.dispatchEvent(stopEvent === 'blur' ? new Event('blur') : new PointerEvent(stopEvent, { pointerId: 7, pointerType: 'mouse' })))
  await pointer(window, 'pointermove', { buttons: 1, clientX: 700 })
  expect(ratio()).toBeCloseTo(0.5)
  expect(document.body.style.cursor).toBe(originalCursor)
  expect(document.body.style.userSelect).toBe(originalUserSelect)
  expectOriginalIdentity()
})

it('Home and End retain the existing right-pane limits without changing focus', async () => {
  await key('Home')
  expect(ratio()).toBeCloseTo(0.38)
  await key('End')
  expect(ratio()).toBeCloseTo(0.76)
  expectOriginalIdentity()
})
