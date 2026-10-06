import { currentNotificationRows, notificationTrigger, toggleNotificationCenter } from './helpers/notification-center'
import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { runtimeEndpointNotice } from '../src/renderer/src/lib/runtime-endpoint-notice'

const dom = composerDOM(), openHost = vi.fn()
beforeEach(() => {
  openHost.mockClear()
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts,
    { id: 'remote-id', kind: 'ssh', label: 'Build server', hostname: 'literal.invalid' }] },
    runtimeEndpointWarnings: [{ hostId: 'remote-id', step: 'Connecting to Runtime', code: 'REMOTE_CORE_UPGRADE_REQUIRED',
      message: 'Original technical receipt problem', recovery: 'Original recovery facts', availability: 'unverified' }],
    runtimeOwnershipWarnings: [], environmentWarning: undefined, loading: false, displacedAgentSessionIds: [],
    sessions: [], workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null,
    error: null, lastError: null, errorNoticeContext: null, noticeReadReceipts: {}, desktopNavigationNotice: null })
})
const mount = () => dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn(), openHost }}><GlobalSystemNotices /></SettingsNavigation.Provider>)
it('explains the exact Host on the first surface and uses real settings navigation without changing healthy inputs', async () => {
  const drafts = useAppStore.getState().agentComposerDrafts, tabs = useAppStore.getState().tabs
  await mount()
  const notice = dom.container.querySelector('.service-window')!
  expect(currentNotificationRows(dom.container)[0]!.querySelector('.notification-item__title')!.textContent).toBe('Build server: Remote service needs an update')
  expect(notice.querySelector('.service-window__mode')!.textContent).toContain('REMOTE_CORE_UPGRADE_REQUIRED: Original technical receipt problem')
  expect(currentNotificationRows(dom.container)[0]!.querySelector('.notification-item__original')!.textContent).toContain('Original technical receipt problem')
  await dom.click('.notification-item__action')
  expect(openHost).toHaveBeenCalledExactlyOnceWith('remote-id')
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(useAppStore.getState().tabs).toBe(tabs)
})
it('keeps an unknown handshake distinct from a version update and retains its original reason', async () => {
  useAppStore.setState({ runtimeEndpointWarnings: [{ hostId: 'remote-id', step: 'Connecting to Runtime',
    code: 'CONTROL_PROTOCOL_ERROR', message: 'Arbitrary malformed result', recovery: 'Retry observation' }] })
  await mount()
  const notice = dom.container.querySelector('.service-window')!
  expect(currentNotificationRows(dom.container)[0]!.querySelector('.notification-item__title')!.textContent).toBe('Build server: Connection could not be verified')
  expect(notice.querySelector('.service-window__mode')!.textContent).toContain('CONTROL_PROTOCOL_ERROR: Arbitrary malformed result')
  expect(notice.querySelector('.service-window__mode')!.textContent).not.toContain('older')
  expect(currentNotificationRows(dom.container)[0]!.querySelector('.notification-item__original')!.textContent).toContain('Arbitrary malformed result')
})

it('consumes typed Native and semantic connection observations in the real global inbox without classifying old running markers as alive', async () => {
  const native = { hostId: 'local', scope: 'observation' as const, step: 'Core to ctxmux connection', code: 'RUNTIME_UNAVAILABLE',
    message: 'Original Native connection is lost', recovery: 'Refresh original observation', availability: 'unverified' as const,
    observationOrigin: { kind: 'runtime-connection' as const, boundary: 'core-ctxmux' as const }, evidence: { source: 'run-process' as const, observedAt: _reshape_fixtureEpoch(0, 0, 123) } }
  const original = { ...composerSession(), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }
  useAppStore.setState({ runtimeEndpointWarnings: [native, { ...native, step: 'Core control connection',
    observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: _reshape_fixtureEpoch(0, 0, 124) } }],
    sessions: [{ ...original, hostId: 'local', control: { ...original.control, hostId: 'local' },
      terminalCapability: { state: 'unknown', reason: 'handshake-timeout', run: original.control.run, observedAt: _reshape_fixtureEpoch(0, 0, 1), mode: 'degraded' } }] })
  await mount()
  const rows = dom.container.querySelectorAll('.notification-item[data-notice-id]')
  expect(rows).toHaveLength(3)
  expect(dom.container.textContent).toContain('Original Native connection is lost')
  expect(dom.container.textContent).toContain('by run-process')
  expect(dom.container.textContent).toContain('Core control connection')
  expect(rows[2]!.querySelector('.service-window')?.getAttribute('data-kind')).toBe('indeterminate')
  expect(rows[2]!.textContent).not.toContain('Agent is still usable')
})

it('keeps compatibility and unknown connection issues in one collapsed entry with exact Host settings actions', async () => {
  const before = useAppStore.getState()
  await mount()
  expect(dom.container.querySelector('.remote-core-upgrade-notices')).toBeNull()
  expect(notificationTrigger(dom.container).getAttribute('aria-expanded')).toBe('false')
  expect(currentNotificationRows(dom.container)).toHaveLength(1)
  expect(currentNotificationRows(dom.container)[0]!.querySelector<HTMLDetailsElement>('.notification-item__details')!.open).toBe(false)
  await dom.click('.notification-item__action')
  expect(openHost).toHaveBeenCalledExactlyOnceWith('remote-id')
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [{ hostId: 'remote-id', step: 'Connecting', code: 'CONTROL_PROTOCOL_ERROR',
    message: 'Arbitrary malformed result', recovery: 'Retry observation' }] }))
  expect(dom.container.textContent).not.toContain('needs an update')
  expect(dom.container.textContent).toContain('Arbitrary malformed result')
})

it('retains exact Host receipts through remount, unknown projection and changed diagnostic prose', async () => {
  const first = useAppStore.getState().runtimeEndpointWarnings![0]!
  await mount(); await toggleNotificationCenter(dom.container, 'open'); await toggleNotificationCenter(dom.container, 'closed')
  const receipts = useAppStore.getState().noticeReadReceipts
  await dom.render(null); await mount()
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: undefined }))
  expect(useAppStore.getState().noticeReadReceipts).toEqual(receipts)
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [{ ...first, message: 'Later original diagnostic', recovery: 'Later recovery observation' }] }))
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toBe('System notifications: 0 unread, 1 current, 0 recent events')
  expect(useAppStore.getState().noticeReadReceipts).toEqual(receipts)
  expect(dom.container.textContent).toContain('Later original diagnostic')
  await dom.click('.notification-item__action')
  expect(openHost).toHaveBeenCalledExactlyOnceWith('remote-id')
})

it('acknowledges two exact Hosts together and admits only confirmed recurrence or a new typed cause', async () => {
  const first = useAppStore.getState().runtimeEndpointWarnings![0]!
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [first, { ...first, hostId: 'other-remote' }] }))
  await mount()
  expect(currentNotificationRows(dom.container)).toHaveLength(2)
  await toggleNotificationCenter(dom.container, 'open'); await toggleNotificationCenter(dom.container, 'closed')
  expect(Object.keys(useAppStore.getState().noticeReadReceipts['global:runtime-endpoints']!)).toEqual([
    JSON.stringify(['remote-id', first.step]), JSON.stringify(['other-remote', first.step])
  ])
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [first] }))
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toBe('System notifications: 0 unread, 1 current, 0 recent events')
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [] }))
  expect(useAppStore.getState().noticeReadReceipts['global:runtime-endpoints']).toBeUndefined()
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [first] }))
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toBe('System notifications: 1 unread, 1 current, 0 recent events')
  await toggleNotificationCenter(dom.container, 'open'); await toggleNotificationCenter(dom.container, 'closed')
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [{ ...first, step: 'Reading a new connection receipt' }, { ...first, hostId: 'unconfigured-host' }] }))
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toBe('System notifications: 2 unread, 2 current, 0 recent events')
  const unconfigured = currentNotificationRows(dom.container).find(row => row.textContent?.includes('unconfigured-host'))!
  await act(async () => unconfigured.querySelector<HTMLButtonElement>('.notification-item__action')!.click())
  expect(openHost).toHaveBeenCalledExactlyOnceWith('unconfigured-host')
})

it('acknowledges distinct current Session lanes without resolving their original owners', async () => {
  const a = composerSession('prompt-a'), b = composerSession('delivery-b')
  const request = { ...a, status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() }, creation: { createOperationId: 'create-a', initialPrompt: 'unconfirmed' as const } }
  const disconnected = { ...b, semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() }, status: { state: 'disconnected' as const, source: b.status.source, observedAt: _reshape_fixtureEpoch(0, 0, 1) } }
  await act(async () => useAppStore.setState({ sessions: [request, disconnected] }))
  await mount()
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toBe('System notifications: 4 unread, 4 current, 0 recent events')
  await toggleNotificationCenter(dom.container, 'open'); await toggleNotificationCenter(dom.container, 'closed')
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toBe('System notifications: 0 unread, 4 current, 0 recent events')
  expect(useAppStore.getState().sessions).toEqual([request, disconnected])
  expect(dom.container.textContent).toContain('Build server')
})

it('keeps two observation steps on one Host distinct without declaring its Runtime unavailable or connected', async () => {
  const warnings = ['Reading Provider catalog', 'Reading retained History sources'].map(step => ({
    hostId: 'remote-id', step, code: 'CONTROL_UNAVAILABLE', message: `Original ${step} failure`,
    recovery: `Retry ${step} on the original Host`, scope: 'observation' as const, availability: 'connected' as const
  }))
  const notices = warnings.map(warning => runtimeEndpointNotice(warning, 'Build server', openHost))
  expect(new Set(notices.map(notice => notice.id)).size).toBe(2)
  for (const [index, notice] of notices.entries()) {
    expect(notice.summary!.step).toBe(`Build server: ${warnings[index]!.step}`)
    expect(notice.summary!.mode).not.toMatch(/Runtime is connected|settings step|running state is unconfirmed/)
    expect(notice.summary!.restore).toBe(warnings[index]!.recovery)
  }
  const drafts = useAppStore.getState().agentComposerDrafts, tabs = useAppStore.getState().tabs
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: warnings }))
  await mount()
  expect(dom.container.querySelectorAll('.notification-item[data-notice-id]')).toHaveLength(2)
  expect(dom.container.textContent).toContain('Build server: Reading Provider catalog')
  expect(dom.container.textContent).toContain('Build server: Reading retained History sources')
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(useAppStore.getState().tabs).toBe(tabs)
})
