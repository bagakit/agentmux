const { fixtureEpoch: _batchFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
// Actual BrowserPane status consumer and Store branches; image preparation and transport are controlled.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserOperation } from '../src/shared/browser-operation'
import type { SessionSnapshot } from '../src/shared/contracts'
import type { BrowserOperatorAvatar, BrowserOperatorAvatarResult } from '../src/renderer/src/lib/browser-operator-avatar'

const images = vi.hoisted(() => ({ ready: undefined as BrowserOperatorAvatar | undefined, prepare: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => 'fixture-user' } }))
vi.mock('../src/renderer/src/lib/browser-operator-avatar', async original => ({
  ...await original<typeof import('../src/renderer/src/lib/browser-operator-avatar')>(),
  readBrowserOperatorAvatar: () => images.ready, prepareBrowserOperatorAvatar: images.prepare
}))
import { BrowserOperatorPresence } from '../src/renderer/src/components/BrowserOperationSurface'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { DEFAULT_CONFIG } from '../src/main/config-store'

const operation: BrowserOperation = { id: 'main-accepted', browserId: 'original-page',
  operator: { id: 'canonical-agent', name: 'Navigator', providerId: 'codex' }, startedAt: _batchFixtureEpoch(0, 0, 10),
  phase: 'preparing', summary: 'Observe page', url: 'https://generic.invalid/', steps: [] }
const control = { owner: 'agent', activeOperationId: operation.id, revision: 2, inputIsolation: 'preparing' } as const
const avatar = { dataUrl: 'data:image/png;base64,prepared-original', width: 64, height: 64, byteLength: 48 } as const
const appearance = { badge: 'shield' as const, tint: '#469b78' }
const session = (id = 'canonical-agent', hostId = 'original-host') => ({ id: 'presentation-agent', kind: 'agent', hostId,
  label: 'Navigator', providerId: 'codex', executorId: 'codex', control: { kind: 'agent', hostId, agentSessionId: id } }) as unknown as SessionSnapshot
const initial = useAppStore.getState()
let host: HTMLDivElement, root: Root
const take = vi.fn(), notice = vi.fn()
function deferred() {
  let resolve!: (value: BrowserOperatorAvatarResult) => void
  const promise = new Promise<BrowserOperatorAvatarResult>(done => { resolve = done })
  return { promise, resolve }
}
const props = () => ({ browserId: operation.browserId, activity: { operation, control: 'agent' as const }, control, onTakeControl: take })
async function render(overrides: Partial<Parameters<typeof BrowserOperatorPresence>[0]> = {}, ownerDocument?: Document) {
  const content = <BrowserOperatorPresence {...props()} {...overrides} />
  await act(async () => root.render(ownerDocument
    ? <WorkbenchDocumentContext.Provider value={{ document: ownerDocument, window: null }}>{content}</WorkbenchDocumentContext.Provider>
    : content))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const config = structuredClone(DEFAULT_CONFIG); config.executors.codex!.avatar = appearance
  useAppStore.setState({ config, sessions: [session()], reportError: notice })
  images.ready = undefined; images.prepare.mockReset().mockResolvedValue({ status: 'ready', avatar })
  take.mockClear(); notice.mockClear()
  for (const [name, value] of Object.entries({ '--text-2': '#8192a3', '--surface-0': '#101214', '--text': '#f0f1f2', '--surface-1': '#242628' })) {
    document.documentElement.style.setProperty(name, value)
  }
  vi.spyOn(api.browser, 'setOperatorAvatar').mockResolvedValue(true)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  document.querySelectorAll('iframe[data-avatar-owner-proof]').forEach(frame => frame.remove())
  document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(initial, true); document.documentElement.removeAttribute('style')
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('consumes the original resolved face and warm PNG through the real status and private API', async () => {
  images.ready = avatar
  await render()
  expect(host.querySelector('.agent-provider-icon')?.getAttribute('data-agent-provider')).toBe('codex')
  expect(host.querySelector('[data-avatar-badge="shield"]')).not.toBeNull()
  expect(host.querySelector('feFlood[result="rimColor"]')?.getAttribute('flood-color')).toBe(appearance.tint)
  expect(images.prepare).not.toHaveBeenCalled()
  expect(api.browser.setOperatorAvatar).toHaveBeenCalledExactlyOnceWith({ browserId: operation.browserId,
    operationId: operation.id, operatorId: operation.operator.id, png: avatar.dataUrl })
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Take control of Browser"]')!
  expect(button).not.toBeNull(); expect(button.classList.contains('browser-toolbar__secondary')).toBe(false)
  await act(async () => button.click()); expect(take).toHaveBeenCalledOnce()
})

it('does not wait for cold decoding before the real browser.run Store branch completes', async () => {
  const work = deferred(); images.prepare.mockReturnValue(work.promise)
  await render()
  const runOperation = { ...operation, phase: 'completed' as const }
  vi.spyOn(api.browser, 'runScript').mockResolvedValue({ result: 'action-result', logs: [], outcome: { kind: 'completed' }, runOperation })
  const receipt = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'original-run-request',
    operation: 'browser.run', browserId: operation.browserId, operationId: operation.id, code: 'return 1',
    caller: { agentSessionId: 'presentation-agent', capability: 'managed' } })
  expect(receipt).toMatchObject({ operation: 'browser.run', result: 'action-result' })
  expect(api.browser.runScript).toHaveBeenCalledExactlyOnceWith(operation.browserId, 'return 1',
    { id: 'canonical-agent', name: 'Navigator', providerId: 'codex' }, operation.id)
  expect(api.browser.setOperatorAvatar).not.toHaveBeenCalled()
  expect(images.prepare.mock.calls[0]![0]).toMatchObject({ document, providerId: 'codex', appearance,
    colors: { mark: '#8192a3', enamel: '#101214', badge: '#f0f1f2', badgeBackground: '#242628' } })
  await act(async () => work.resolve({ status: 'ready', avatar }))
  expect(api.browser.setOperatorAvatar).toHaveBeenCalledOnce()
})

it('drops a late original image after Main publishes another operation and sends only its actual replacement', async () => {
  const old = deferred(), next = deferred(); images.prepare.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  await render()
  const replacement = { ...operation, id: 'next-main-operation' }
  await render({ activity: { operation: replacement, control: 'agent' }, control: { ...control, activeOperationId: replacement.id } })
  await act(async () => old.resolve({ status: 'ready', avatar }))
  expect(api.browser.setOperatorAvatar).not.toHaveBeenCalled()
  await act(async () => next.resolve({ status: 'ready', avatar: { ...avatar, dataUrl: 'data:image/png;base64,replacement' } }))
  expect(api.browser.setOperatorAvatar).toHaveBeenCalledExactlyOnceWith({ browserId: operation.browserId,
    operationId: replacement.id, operatorId: operation.operator.id, png: 'data:image/png;base64,replacement' })
})

it('keeps control, completion and Browser identity independent from a historical Agent phase', async () => {
  const waiting = { ...operation, phase: 'waiting' as const }
  for (const state of [
    { control: { ...control, owner: 'human' as const, activeOperationId: null, inputIsolation: 'inactive' as const } },
    { control: { ...control, owner: 'unknown' as const, inputIsolation: 'unconfirmed' as const } },
    { control: { ...control, activeOperationId: 'another-operation' } },
    { browserId: 'another-browser' },
    { activity: { operation: { ...operation, phase: 'completed' as const }, control: 'agent' as const },
      control: { ...control, owner: 'human' as const, activeOperationId: null, inputIsolation: 'inactive' as const } }
  ]) {
    await render({ activity: { operation: waiting, control: 'agent' }, ...state })
    expect(host.querySelector('[data-icon-animation="wait"]')).toBeNull()
    const owner = state.control?.owner ?? control.owner
    expect(Boolean(host.querySelector('[aria-label="Take control of Browser"]'))).toBe(owner === 'agent')
  }
  expect(images.prepare).not.toHaveBeenCalled(); expect(api.browser.setOperatorAvatar).not.toHaveBeenCalled()
})

it('preserves known Main takeover while missing or mismatched details remain unknown and historical control stays inert', async () => {
  for (const detail of [null, { ...operation, id: 'stale-history' }]) {
    await render({ activity: { operation: detail, control: 'agent' } })
    expect(host.querySelector('.browser-operation-status')?.getAttribute('data-phase')).toBe('unknown')
    expect(host.querySelector('[aria-label^="Browser activity:"]')?.getAttribute('aria-label')).toContain('Activity details are loading')
    expect(host.querySelector('.agent-avatar')).toBeNull()
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Take control of Browser"]')
    expect(button).not.toBeNull()
    await act(async () => button!.click())
  }
  expect(take).toHaveBeenCalledTimes(2)
  await render({ activity: { operation: { ...operation, control }, control: 'agent' }, control: undefined })
  expect(host.querySelector('[aria-label="Take control of Browser"]')).toBeNull()
  expect(host.querySelector('[data-icon-animation]')).toBeNull()
  expect(images.prepare).not.toHaveBeenCalled(); expect(api.browser.setOperatorAvatar).not.toHaveBeenCalled()
})

it('freezes the first appearance while step and configuration broadcasts remain on the same original operation', async () => {
  const work = deferred(); images.prepare.mockReturnValue(work.promise)
  await render()
  const config = structuredClone(useAppStore.getState().config!); config.executors.codex!.avatar = { badge: 'spark', tint: '#aabbcc' }
  await act(async () => useAppStore.setState({ config }))
  await render({ activity: { operation: { ...operation, phase: 'running', steps: [{ sequence: 1, method: 'read', label: 'Read page', status: 'running', startedAt: _batchFixtureEpoch(0, 0, 11) }] }, control: 'agent' } })
  expect(images.prepare).toHaveBeenCalledOnce()
  expect(images.prepare.mock.calls[0]![0].appearance).toEqual(appearance)
  await act(async () => work.resolve({ status: 'ready', avatar }))
  expect(api.browser.setOperatorAvatar).toHaveBeenCalledOnce()
})

it('does not choose a Host from focus or the page when the canonical identity has multiple candidates', async () => {
  useAppStore.setState({ sessions: [session(), { ...session('canonical-agent', 'other-host'), id: 'other-presentation' }] })
  await render()
  expect(images.prepare).not.toHaveBeenCalled(); expect(api.browser.setOperatorAvatar).not.toHaveBeenCalled()
  expect(host.querySelector('[data-avatar-badge]')).toBeNull()
  const takeControl = host.querySelector<HTMLButtonElement>('[aria-label="Take control of Browser"]')!
  await act(async () => takeControl.click()); expect(take).toHaveBeenCalledOnce()
})

it('keeps a failed or closed decoration nonblocking and preserves the original name and takeover', async () => {
  images.prepare.mockResolvedValue({ status: 'failed', message: 'Original artwork unavailable; the original name remains visible.' })
  await render()
  expect(notice).toHaveBeenCalledExactlyOnceWith('Original artwork unavailable; the original name remains visible.', { kind: 'process-degraded' })
  expect(api.browser.setOperatorAvatar).not.toHaveBeenCalled()
  expect(host.querySelector('[aria-label^="Browser activity:"]')?.getAttribute('aria-label')).toContain('Navigator')
  expect(host.querySelector('[aria-label="Take control of Browser"]')).not.toBeNull()
  const work = deferred(); images.prepare.mockReturnValue(work.promise)
  const next = { ...operation, id: 'short-operation' }
  await render({ activity: { operation: next, control: 'agent' }, control: { ...control, activeOperationId: next.id } })
  await render({ activity: { operation: { ...next, phase: 'completed' }, control: 'human' },
    control: { owner: 'human', activeOperationId: null, revision: 3, inputIsolation: 'inactive' } })
  await act(async () => work.resolve({ status: 'ready', avatar }))
  expect(api.browser.setOperatorAvatar).not.toHaveBeenCalled()
})

it('reads the actual hosting document palette and shares canonical identity with the real replay Store branch', async () => {
  const frame = document.createElement('iframe'); frame.dataset.avatarOwnerProof = ''; document.body.append(frame)
  const ownerDocument = frame.contentDocument!
  for (const [name, value] of Object.entries({ '--text-2': '#123456', '--surface-0': '#234567', '--text': '#345678', '--surface-1': '#456789' })) {
    ownerDocument.documentElement.style.setProperty(name, value)
  }
  await render({}, ownerDocument)
  expect(images.prepare.mock.calls[0]![0]).toMatchObject({ document: ownerDocument, colors: {
    mark: '#123456', enamel: '#234567', badge: '#345678', badgeBackground: '#456789' } })
  const plan = { schema: 'agentmux.browser-replay.v1' as const, operationId: 'recorded-operation', url: operation.url, steps: [] }
  vi.spyOn(api.browser, 'replayPlan').mockResolvedValue(plan)
  vi.spyOn(api.browser, 'runReplay').mockResolvedValue({ result: null, logs: [], outcome: { kind: 'completed' }, runOperation: operation })
  await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'original-replay-request', operation: 'browser.replay',
    browserId: operation.browserId, operationId: plan.operationId, caller: { agentSessionId: 'presentation-agent', capability: 'managed' } })
  expect(api.browser.runReplay).toHaveBeenCalledExactlyOnceWith(operation.browserId, plan,
    { id: 'canonical-agent', name: 'Navigator', providerId: 'codex' })
  frame.remove()
})

it('takes control through the actual BrowserPane and original public stop even before activity details catch up', async () => {
  const [{ BrowserPane }, { createClientUiRoot }] = await Promise.all([
    import('../src/renderer/src/components/BrowserPane'), import('./helpers/client-ui-render')
  ])
  await act(async () => root.unmount()); root = createClientUiRoot(host)
  useAppStore.setState({ toolsOpen: false })
  const page = await api.browser.create(operation.browserId, operation.url, 'original-workspace')
  const stop = vi.spyOn(api.browser, 'stopOperationById').mockResolvedValue(null)
  vi.spyOn(api.browser, 'setAnnotationMarkers').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
  for (const detail of [null, { ...operation, id: 'stale-activity-operation' }]) {
    await act(async () => root.render(<BrowserPane tab={{ ...page, kind: 'browser', browserId: page.id,
      regionId: 'original-region', workspaceId: 'original-workspace', control, activity: { operation: detail, control: 'agent' } }} visible />))
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Take control of Browser"]')
    expect(button).not.toBeNull()
    await act(async () => button!.click())
    expect(stop.mock.calls.at(-1)).toEqual([control.activeOperationId])
  }
  expect(stop).toHaveBeenCalledTimes(2)
})
