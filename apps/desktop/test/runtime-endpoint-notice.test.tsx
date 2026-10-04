// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { RemoteCoreUpgradeNotices } from '../src/renderer/src/components/RemoteCoreUpgradeNotices'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'

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
  expect(notice.querySelector('.service-window__step')!.textContent).toBe('Build server: Remote service needs an update')
  expect(notice.querySelector('.service-window__mode')!.textContent).toContain('older Core interface')
  expect(notice.querySelector('details')!.textContent).toContain('Original technical receipt problem')
  await dom.click('.global-system-notices__action')
  expect(openHost).toHaveBeenCalledExactlyOnceWith('remote-id')
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(useAppStore.getState().tabs).toBe(tabs)
})
it('keeps an unknown handshake distinct from a version update and retains its original reason', async () => {
  useAppStore.setState({ runtimeEndpointWarnings: [{ hostId: 'remote-id', step: 'Connecting to Runtime',
    code: 'CONTROL_PROTOCOL_ERROR', message: 'Arbitrary malformed result', recovery: 'Retry observation' }] })
  await mount()
  const notice = dom.container.querySelector('.service-window')!
  expect(notice.querySelector('.service-window__step')!.textContent).toBe('Build server: Connection could not be verified')
  expect(notice.querySelector('.service-window__mode')!.textContent).toContain('unconfirmed')
  expect(notice.querySelector('.service-window__mode')!.textContent).not.toContain('older')
  expect(notice.querySelector('details')!.textContent).toContain('Arbitrary malformed result')
})

const mountVisible = () => dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn(), openHost }}><RemoteCoreUpgradeNotices /></SettingsNavigation.Provider>)
it('shows the automatic compatibility warning without opening the inbox and preserves healthy inputs', async () => {
  const drafts = useAppStore.getState().agentComposerDrafts, tabs = useAppStore.getState().tabs
  await mountVisible()
  expect(dom.container.querySelector('.remote-core-upgrade-notices .service-window')).not.toBeNull()
  expect(dom.container.querySelector('.global-system-notices__trigger')).toBeNull()
  expect(dom.container.textContent).toContain('Build server: Remote service needs an update')
  expect(dom.container.querySelector('.service-disclosure__trigger')).not.toBeNull()
  expect(dom.container.querySelector('.service-disclosure__trigger')!.getAttribute('aria-expanded')).toBe('false')
  expect(dom.container.querySelector('.remote-core-upgrade-notices details')).toBeNull()
  expect(dom.container.querySelector('.remote-core-upgrade-notices .service-disclosure__inline-actions button')).not.toBeNull()
  await dom.click('.remote-core-upgrade-notices .service-disclosure__inline-actions button')
  expect(openHost).toHaveBeenCalledExactlyOnceWith('remote-id')
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(useAppStore.getState().tabs).toBe(tabs)
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [] }))
  expect(dom.container.querySelector('.remote-core-upgrade-notices')).toBeNull()
})
it('never labels an unknown malformed connection as a version problem', async () => {
  useAppStore.setState({ runtimeEndpointWarnings: [{ hostId: 'remote-id', step: 'Connecting', code: 'CONTROL_PROTOCOL_ERROR',
    message: 'Arbitrary malformed result', recovery: 'Retry observation' }] })
  await mountVisible()
  expect(dom.container.textContent).not.toContain('needs an update')
  expect(dom.container.querySelector('.remote-core-upgrade-notices')).toBeNull()
})

const automaticRows = () => [...dom.container.querySelectorAll<HTMLElement>('.remote-core-upgrade-notices .service-disclosure')]
const row = (label = 'Build server') => automaticRows().find(node => node.querySelector('.service-disclosure__trigger')?.getAttribute('title')?.startsWith(label))!
const mountAll = () => dom.render(<SettingsNavigation.Provider value={{ open: vi.fn(), openToolkit: vi.fn(), openHost }}>
  <RemoteCoreUpgradeNotices /><GlobalSystemNotices /></SettingsNavigation.Provider>)
async function toggleDetails(node: HTMLElement, newState: 'open' | 'closed') {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: newState })
  await act(async () => node.querySelector('.service-disclosure__details')!.dispatchEvent(event))
}
it('keeps the named Host and exact settings action after acknowledgement, remount and changed diagnostic text', async () => {
  const drafts = useAppStore.getState().agentComposerDrafts, tabs = useAppStore.getState().tabs
  await mountVisible()
  expect(automaticRows()).toHaveLength(1)
  expect(row().querySelector('.service-disclosure__trigger')!.getAttribute('aria-expanded')).toBe('false')
  expect(row().querySelector('.service-disclosure__inline-actions')!.textContent).toContain('Connection settings')
  const input = document.createElement('textarea'); dom.container.append(input); input.value = 'original unsent draft'; input.focus()
  await act(async () => row().querySelector<HTMLButtonElement>('.service-disclosure__close')!.click())
  expect(row().getAttribute('data-unread')).toBe('false')
  expect(row().querySelector('.service-disclosure__summary')).not.toBeNull()
  expect(row().querySelector('.service-disclosure__summary')!.textContent).toContain('Build server: Remote service needs an update')
  const receipts = useAppStore.getState().noticeReadReceipts
  await dom.render(null); await mountVisible()
  await act(async () => useAppStore.setState(state => ({ runtimeEndpointWarnings: state.runtimeEndpointWarnings!.map(item => ({ ...item, message: 'Later diagnostics at cursor 99', recovery: 'Later recovery observation' })) })))
  expect(row().getAttribute('data-unread')).toBe('false')
  expect(useAppStore.getState().noticeReadReceipts).toEqual(receipts)
  await act(async () => row().querySelector<HTMLButtonElement>('.service-disclosure__inline-actions button')!.click())
  expect(openHost).toHaveBeenCalledExactlyOnceWith('remote-id')
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts); expect(useAppStore.getState().tabs).toBe(tabs)
})
it('does not let two subset rows erase each other read receipts, but confirmed removal admits a recurrence', async () => {
  const first = useAppStore.getState().runtimeEndpointWarnings![0]!
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, hosts: [...state.config!.hosts, { id: 'other-remote', kind: 'ssh', label: 'Other server', hostname: 'other.invalid' }] }, runtimeEndpointWarnings: [first, { ...first, hostId: 'other-remote' }] })))
  await mountAll()
  expect(automaticRows()).toHaveLength(2)
  await act(async () => row('Build server').querySelector<HTMLButtonElement>('.service-disclosure__close')!.click())
  await act(async () => row('Other server').querySelector<HTMLButtonElement>('.service-disclosure__close')!.click())
  expect(automaticRows().map(node => node.getAttribute('data-unread'))).toEqual(['false', 'false'])
  expect(Object.keys(useAppStore.getState().noticeReadReceipts['global:runtime-endpoints']!)).toEqual(['remote-id', 'other-remote'])
  const saved = useAppStore.getState().noticeReadReceipts
  await dom.render(null); await mountAll()
  expect(automaticRows().map(node => node.getAttribute('data-unread'))).toEqual(['false', 'false'])
  expect(useAppStore.getState().noticeReadReceipts).toEqual(saved)
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: undefined }))
  expect(useAppStore.getState().noticeReadReceipts).toEqual(saved)
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [first] }))
  expect(row().getAttribute('data-unread')).toBe('false')
  expect(useAppStore.getState().noticeReadReceipts['global:runtime-endpoints']).not.toHaveProperty('other-remote')
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [] }))
  expect(useAppStore.getState().noticeReadReceipts['global:runtime-endpoints']).toBeUndefined()
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [first] }))
  expect(row().getAttribute('data-unread')).toBe('true')
})
it('keeps distinct current Session lanes while acknowledgement changes only unread, not current count', async () => {
  const a = composerSession('prompt-a'), b = composerSession('delivery-b')
  const request = { ...a, creation: { createOperationId: 'create-a', initialPrompt: 'unconfirmed' as const } }
  // Each original Session has a real service lane; no fake error counter is introduced.
  const disconnected = { ...b, status: { state: 'disconnected' as const, source: b.status.source, observedAt: 1 } }
  await act(async () => useAppStore.setState({ sessions: [request, disconnected] }))
  await mountAll()
  expect(automaticRows()).toHaveLength(1)
  const trigger = () => dom.container.querySelector('.global-system-notices__trigger')!
  expect(trigger().getAttribute('aria-label')).toBe('System notifications: 3 unread, 3 current')
  await act(async () => row().querySelector<HTMLButtonElement>('.service-disclosure__close')!.click())
  expect(trigger().getAttribute('aria-label')).toBe('System notifications: 2 unread, 3 current')
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => dom.container.querySelector('.global-system-notices__details')!.dispatchEvent(event))
  expect(trigger().getAttribute('aria-label')).toBe('System notifications: 0 unread, 3 current')
  expect(useAppStore.getState().sessions).toEqual([request, disconnected])
  expect(row().querySelector('.service-disclosure__summary')!.textContent).toContain('Build server')
})
it('keeps original facts and restores input focus when the explicitly opened detail is escaped', async () => {
  await mountVisible(); expect(automaticRows()).toHaveLength(1)
  const input = document.createElement('textarea'); dom.container.append(input); input.value = 'kept draft'; input.focus()
  await act(async () => row().querySelector('.service-disclosure__trigger')!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
  await toggleDetails(row(), 'open')
  expect(row().querySelector('.service-disclosure__trigger')!.getAttribute('aria-expanded')).toBe('true')
  expect(row().querySelector('.service-disclosure__details details')).toBeNull()
  expect(row().querySelector('.service-disclosure__details')!.textContent).toContain('Original technical receipt problem')
  expect(row().querySelector('.service-disclosure__details')!.textContent).toContain('Original recovery facts')
  await act(async () => row().querySelector('.service-disclosure__details')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(row().querySelector('.service-disclosure__trigger')!.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(input); expect(input.value).toBe('kept draft')
  expect(useAppStore.getState().runtimeEndpointWarnings).toHaveLength(1)
})

it('admits a changed typed cause on the same Host without acknowledging a different Host', async () => {
  const first = useAppStore.getState().runtimeEndpointWarnings![0]!
  await mountAll()
  expect(automaticRows()).toHaveLength(1)
  await act(async () => row().querySelector<HTMLButtonElement>('.service-disclosure__close')!.click())
  await act(async () => useAppStore.setState({ runtimeEndpointWarnings: [{ ...first, step: 'Reading a new connection receipt' }, { ...first, hostId: 'unconfigured-host' }] }))
  expect(automaticRows()).toHaveLength(2)
  expect(row().getAttribute('data-unread')).toBe('true')
  expect(row('unconfigured-host').getAttribute('data-unread')).toBe('true')
  await act(async () => row('unconfigured-host').querySelector<HTMLButtonElement>('.service-disclosure__inline-actions button')!.click())
  expect(openHost).toHaveBeenCalledExactlyOnceWith('unconfigured-host')
  expect(useAppStore.getState().runtimeEndpointWarnings![0]!.hostId).toBe('remote-id')
})

it('handles Escape at the actually focused trigger only while details are open, leaving IME and closed Escape alone', async () => {
  await mountVisible(); expect(automaticRows()).toHaveLength(1)
  const input = document.createElement('textarea'); dom.container.append(input); input.value = 'Original keyboard draft'; input.focus()
  const trigger = row().querySelector<HTMLButtonElement>('.service-disclosure__trigger')!
  await act(async () => trigger.dispatchEvent(new Event('pointerdown', { bubbles: true })))
  trigger.focus(); await toggleDetails(row(), 'open')
  expect(document.activeElement).toBe(trigger)
  for (const properties of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...properties })
    await act(async () => trigger.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false); expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(trigger)
  }
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => trigger.dispatchEvent(escape))
  expect(escape.defaultPrevented).toBe(true); expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(input); expect(input.value).toBe('Original keyboard draft')
  const closedEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => trigger.dispatchEvent(closedEscape))
  expect(closedEscape.defaultPrevented).toBe(false)
  expect(useAppStore.getState().runtimeEndpointWarnings).toHaveLength(1)
})
