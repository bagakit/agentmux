// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { HostBadge } from '../src/renderer/src/components/HostBadge'
import { HostConnectionLibrary } from '../src/renderer/src/components/settings/HostConnectionLibrary'
import { HostTopology } from '../src/renderer/src/components/settings/HostTopology'
import { hostIdentityProjection } from '../src/renderer/src/lib/region-execution-host'
import { DeviceHomeError, deviceHomeFailureDetail } from '../src/renderer/src/lib/device-home-feedback'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { HostConfig, HostTransportSnapshot } from '../src/shared/contracts'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM()
const first: HostConfig = { id: 'remote-one', kind: 'ssh', label: 'Same device', hostname: 'one.invalid', transport: 'ssh-tailcat', tailcat: { address: 'tcprivateFixture', keyFile: '/private/client-key' } }
const second: HostConfig = { ...first, id: 'remote-two', hostname: 'two.invalid', transport: 'tailcat' }
const connected = (transport: 'ssh' | 'tailcat', fallback = false): HostTransportSnapshot => ({ state: 'connected', transport, fallback, establishedAt: 1793773800000, observedAt: 1793773800000 })
const tooltip = () => document.querySelector<HTMLElement>('[role="tooltip"]')!
async function focus(element: HTMLElement) { await act(async () => element.focus()); expect(tooltip()).not.toBeNull() }
async function escape() { await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(tooltip()).toBeNull() }
beforeEach(() => {
  installNoteCanvasGeometry()
  useAppStore.setState({ config: { ...structuredClone(composerConfig), hosts: [...composerConfig.hosts, first, second] },
    hostTransports: { [first.id]: connected('tailcat', true), [second.id]: connected('ssh') }, hostChecks: {}, runtimeEndpointWarnings: [], activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    sessions: [composerSession('healthy')], collapsedProjectGroups: {}, projectGroups: [], agentComposerDrafts: { healthy: 'original draft' } })
})

it('device names expose home and actual fallback through keyboard and hover without reading or testing a Host', async () => {
  const read = vi.spyOn(api.hosts, 'inspect'), home = vi.spyOn(api.hosts, 'home'), check = vi.spyOn(api.hosts, 'check'), network = vi.spyOn(api.hosts, 'network')
  await dom.render(<WorkspaceSidebar />)
  const heading = dom.container.querySelector<HTMLElement>(`[data-folder-host="${first.id}"] .space-section-label`)!
  expect(heading.textContent).toContain('Same device~0')
  await focus(heading)
  expect(tooltip().textContent).toContain('Current: Tailcat · Channel connected')
  expect(tooltip().textContent).toContain('Tailcat backup selected')
  expect(tooltip().textContent).toContain('Saved preference: SSH first, Tailcat backup')
  expect(tooltip().textContent).toContain('Host Runtime RPC channel')
  expect(tooltip().textContent).toContain('~ opens this device’s home')
  expect(heading.getAttribute('aria-describedby')).toBe(tooltip().id)
  expect(document.body.textContent).not.toContain('tcprivateFixture'); expect(document.body.innerHTML).not.toContain('/private/client-key')
  await escape()
  await act(async () => heading.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(tooltip().textContent).toContain('Current: Tailcat')
  expect(read).not.toHaveBeenCalled(); expect(home).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled()
})

it('a passive channel close updates every badge immediately and never promotes the saved preference into a fact', async () => {
  await dom.render(<HostBadge context="Host" host={hostIdentityProjection(first.id, first)} />)
  const badge = dom.container.querySelector<HTMLElement>('[data-host-id]')!
  await focus(badge)
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: first.id,
    hostTransport: { ...connected('tailcat', true), state: 'disconnected' }, event: { type: 'connection-state', state: 'lost', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: 1793773800010 } } }))
  expect(tooltip().textContent).toContain('Current: channel disconnected')
  expect(tooltip().textContent).toContain('Last confirmed: Tailcat')
  expect(tooltip().textContent).not.toContain('Channel connected')
  expect(useAppStore.getState().sessions).toHaveLength(1)
  expect(useAppStore.getState().agentComposerDrafts.healthy).toBe('original draft')
  await act(async () => useAppStore.setState({ hostTransports: {} }))
  expect(tooltip().textContent).toContain('Current: not confirmed')
  expect(tooltip().textContent).not.toContain('Current: SSH')
})

it('Remote list and topology show the exact hovered Host even with identical names and another selected Host', async () => {
  const onSelect = vi.fn()
  await dom.render(<HostConnectionLibrary selectedId={first.id} panel="overview" query="" onQuery={() => {}} onSelect={onSelect} focusRequest={null}
    items={[first, second].map(host => ({ id: host.id, name: host.label, detail: 'Saved connection', mark: null, status: null, projectCount: 0 }))} />)
  await focus(dom.container.querySelector<HTMLElement>(`[data-host-disclosure="${second.id}"] summary`)!)
  expect(tooltip().textContent).toContain(second.id); expect(tooltip().textContent).toContain('Current: SSH')
  expect(tooltip().textContent).toContain('Saved preference: Tailcat only'); expect(onSelect).not.toHaveBeenCalled()
  await escape()
  await dom.render(<HostTopology selectedId={first.id} onSelect={onSelect} items={[first, second].map(host => ({ host, check: undefined, projectCount: 0, sessionCount: 0 }))} />)
  const node = dom.container.querySelector<HTMLElement>(`[data-host-node="${second.id}"]`)!
  expect(node).not.toBeNull(); await focus(node)
  expect(tooltip().textContent).toContain(second.id); expect(tooltip().textContent).toContain('Current: SSH')
  expect(node.getAttribute('aria-pressed')).toBe('false'); expect(onSelect).not.toHaveBeenCalled()
})

it('home failure stays one compact line and exposes safe stage/code detail rather than original errors', async () => {
  const original = Object.assign(new Error('tcprivateFixture /private/client-key raw stderr'), { code: 'REMOTE_CORE_UPGRADE_REQUIRED' })
  const read = vi.spyOn(api.hosts, 'home').mockRejectedValue(original)
  await dom.render(<WorkspaceSidebar />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>(`[data-folder-host="${first.id}"] .space-section-label`)!.click())
  const section = dom.container.querySelector<HTMLElement>(`[data-folder-host="${first.id}"]`)!
  expect(section.querySelector('[role="status"]')?.textContent).toBe('Home unavailableRetry')
  await focus(section.querySelector<HTMLElement>('.space-device-home-reason')!)
  expect(tooltip().textContent).toContain('Reading this device’s home directory was not confirmed')
  expect(tooltip().textContent).toContain('Remote Core update required')
  expect(document.body.innerHTML).not.toMatch(/tcprivateFixture|\/private\/client-key|raw stderr/)
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace'); expect(useAppStore.getState().sessions).toHaveLength(1)
  await escape()
  await act(async () => section.querySelector<HTMLButtonElement>('.space-device-home-retry')!.click())
  expect(read).toHaveBeenCalledTimes(2)
  try { await useAppStore.getState().openHostHome(first.id); throw new Error('Expected original failure') }
  catch (error) { expect(error).toBeInstanceOf(DeviceHomeError); expect((error as DeviceHomeError).cause).toBe(original) }
  expect(deviceHomeFailureDetail(new DeviceHomeError('register', original))).toContain('Saving the home directory')
  expect(deviceHomeFailureDetail(new DeviceHomeError('open', original))).toContain('Opening the home workface')
})


it('the original snapshot resync supplies passive facts and the persisted document never stores connected metadata', async () => {
  const snapshot = vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [composerSession('healthy')], timelines: {}, recoveryCandidates: [], hostTransports: { [first.id]: connected('ssh') } })
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: first.id, event: { type: 'connection-state', state: 'restored', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: 1793773800020 } } }))
  await vi.waitFor(() => expect(useAppStore.getState().hostTransports?.[first.id]).toEqual(connected('ssh')))
  expect(snapshot).toHaveBeenCalled()
  const persisted = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  expect(persisted).not.toHaveProperty('hostTransports')
})

it('compact badges preserve hover and reuse an existing focus owner without inserting a nested tab stop', async () => {
  await dom.render(<button type="button" aria-describedby="original-description">Original action<HostBadge context="Host" compact host={hostIdentityProjection(first.id, first)} /></button>)
  const owner = dom.container.querySelector<HTMLButtonElement>('button')!, badge = owner.querySelector<HTMLElement>('[data-host-id]')!
  expect(badge.hasAttribute('tabindex')).toBe(false)
  await focus(owner)
  expect(tooltip().textContent).toContain('Current: Tailcat')
  expect(owner.getAttribute('aria-describedby')).toContain('original-description')
  expect(owner.getAttribute('aria-describedby')).toContain(tooltip().id)
  await escape()
  expect(owner.getAttribute('aria-describedby')).toBe('original-description')
  await act(async () => badge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(tooltip().textContent).toContain(first.id)
})

it.each([false, true])('queued channel facts respect the original Main cut across route adoption, including equal millisecond timestamps (later=%s)', async later => {
  let resolve!: (value: Awaited<ReturnType<typeof api.sessions.snapshot>>) => void
  const read = vi.spyOn(api.sessions, 'snapshot').mockImplementation(() => new Promise(done => { resolve = done }))
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: first.id, event: { type: 'connection-state', state: 'restored', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: 1793773800020 } } }))
  await vi.waitFor(() => expect(read).toHaveBeenCalled())
  await act(async () => {
    useAppStore.getState().applyEvent({ type: 'core', hostId: first.id, hostTransport: { ...connected('ssh'), state: 'disconnected' }, hostTransportSequence: later ? 3 : 1,
      event: { type: 'connection-state', state: 'lost', observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: 1793773800020 } } })
    useAppStore.setState(state => ({ config: { ...state.config!, hosts: state.config!.hosts.map(host => host.id === first.id ? { ...first, transport: 'tailcat' } : host) } }))
    resolve({ sessions: [composerSession('healthy')], timelines: {}, recoveryCandidates: [], hostTransports: { [first.id]: connected('tailcat') }, hostTransportCut: 2 })
  })
  await vi.waitFor(() => expect(useAppStore.getState().hostTransports?.[first.id]).toEqual(later ? { ...connected('ssh'), state: 'disconnected' } : connected('tailcat')))
  expect(useAppStore.getState().agentComposerDrafts.healthy).toBe('original draft')
})


it('the latest focused reason replaces a still-hovered title, and Escape releases only the tooltip layer', async () => {
  vi.spyOn(api.hosts, 'home').mockRejectedValue(Object.assign(new Error('private original error'), { code: 'REMOTE_CORE_UPGRADE_REQUIRED' }))
  await dom.render(<WorkspaceSidebar />)
  const heading = dom.container.querySelector<HTMLButtonElement>(`[data-folder-host="${first.id}"] .space-section-label`)!
  await act(async () => heading.click())
  await act(async () => heading.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(tooltip().textContent).toContain('Current: Tailcat')
  await focus(dom.container.querySelector<HTMLElement>('.space-device-home-reason')!)
  expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
  expect(tooltip().textContent).toContain('Remote Core update required')
  await escape()
  const close = vi.fn()
  await dom.render(<SettingsPanel initialSection="hosts" onClose={close} />)
  await vi.waitFor(() => expect(dom.container.querySelector(`[data-host-node="${first.id}"]`)).not.toBeNull())
  await focus(dom.container.querySelector<HTMLElement>(`[data-host-node="${first.id}"]`)!)
  await escape()
  expect(close).not.toHaveBeenCalled()
  await escape()
  expect(close).toHaveBeenCalledOnce()
})
