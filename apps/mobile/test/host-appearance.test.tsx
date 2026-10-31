import './device-locks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { GRAPHITE_THEME, themeValue, DEFAULT_THEME_ID } from '@agentmux/client-ui/theme'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { themeObservation } from '../../host/src/theme-observation.js'
import { createHostAppearanceObservation } from '../../host/src/host-appearance.js'
import { BrandIcon } from '@agentmux/client-ui/components/BrandIcon'
import { configOwnerFixture } from '../../desktop/test/helpers/config-owner-fixture.js'
import { useHostAppearance, observedTerminalPalette } from '../src/appearance/useHostAppearance'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'

const cleanup: Array<() => void | Promise<void>> = []
let root: Root, container: HTMLDivElement, media: EventTarget & { matches: boolean }
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  media = Object.assign(new EventTarget(), { matches: true })
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  window.matchMedia = vi.fn(() => media as MediaQueryList)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); for (const close of cleanup.splice(0).reverse()) await close(); container.remove(); vi.unstubAllGlobals() })
function Harness({ client, connected = true }: { client: AgentMuxHostedClient | null; connected?: boolean }) {
  const appearance = useHostAppearance(client, connected ? 'connected' : 'disconnected')
  return <><textarea defaultValue="Original composer draft" aria-label="Composer" /><button aria-label="Copy"><SemanticIcon name="action.copy" /></button>
    <p role="status">{appearance.issue}</p><output>{appearance.terminalPalette?.background}</output><BrandIcon icon={appearance.appIcon} /></>
}
const until = async (ready: () => boolean) => { for (let i = 0; i < 100 && !ready(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); expect(ready()).toBe(true) }
async function actualHost() {
  const f = await configOwnerFixture()
  const directory = await mkdtemp(join(tmpdir(), 'mobile-theme-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], appearance: themeObservation(f.owner), execute: async () => { throw new Error('Read-only appearance consumer') } })
  cleanup.push(() => server.stop()); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const subscribeRpc = vi.fn(rpc.subscribe.bind(rpc))
  return { f, client: { subscribeRpc } as unknown as AgentMuxHostedClient, subscribeRpc }
}

it('consumes a real Main commit via public RPC in the retained Mobile root, including semantic icon and explicit Terminal palette', async () => {
  const { f, client, subscribeRpc } = await actualHost()
  await act(async () => root.render(<Harness client={client} />))
  await until(() => container.querySelector('output')!.textContent === '#000000')
  expect(container.querySelector('[data-app-icon]')?.getAttribute('data-app-icon')).toBe('qingzhuan')
  const composer = container.querySelector('textarea')!, icon = container.querySelector('button svg')!
  composer.value = 'Unsent edited draft'; composer.focus(); composer.setSelectionRange(3, 8)
  await act(async () => { await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, appIcon: 'huihuan' } })) })
  await until(() => container.querySelector('[data-app-icon]')?.getAttribute('data-app-icon') === 'huihuan')
  expect(subscribeRpc).toHaveBeenCalledTimes(1)
  const value = themeValue(structuredClone(GRAPHITE_THEME))
  value.variants.dark.colors.surface0 = '#152537'
  value.icons['action.copy'] = { kind: 'paths', paths: [{ d: 'M4 4 L20 20 M20 4 L4 20' }] }
  await act(async () => { await f.owner.update(config => ({ ...config, appearance: { ...config.appearance,
    themeId: 'custom.mobile', customThemes: { 'custom.mobile': value }, terminalTheme: 'catppuccin-mocha' } })) })
  await until(() => document.documentElement.dataset.theme === 'custom.mobile')
  expect(document.documentElement.style.getPropertyValue('--surface-0')).toBe('#152537')
  expect(container.querySelector('output')!.textContent).toBe('#1e1e2e')
  expect(document.getElementById('agentmux-icon-action.copy')!.innerHTML).toContain('M4 4 L20 20 M20 4 L4 20')
  expect(container.querySelector('button svg')).toBe(icon)
  expect(container.querySelector('textarea')).toBe(composer)
  expect(document.activeElement).toBe(composer); expect(composer.value).toBe('Unsent edited draft'); expect(composer.selectionStart).toBe(3)
  await act(async () => root.render(<Harness client={client} connected={false} />))
  await act(async () => { await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, themeId: DEFAULT_THEME_ID, appIcon: 'zheyu' } })) })
  expect(document.documentElement.dataset.theme).toBe('custom.mobile')
  expect(container.querySelector('[data-app-icon]')?.getAttribute('data-app-icon')).toBe('huihuan')
  await act(async () => root.render(<Harness client={client} />))
  await until(() => document.documentElement.dataset.theme === DEFAULT_THEME_ID)
  expect(container.querySelector('[data-app-icon]')?.getAttribute('data-app-icon')).toBe('zheyu')
  expect(subscribeRpc).toHaveBeenCalledTimes(2)
})
it('uses local phone system brightness and removes its single media listener when unmounted', async () => {
  const { f, client } = await actualHost()
  await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, appAppearance: 'system' } }))
  const remove = vi.spyOn(media, 'removeEventListener')
  await act(async () => root.render(<Harness client={client} />)); await until(() => container.querySelector('output')!.textContent === '#000000')
  expect(document.documentElement.dataset.appearance).toBe('dark')
  await act(async () => { media.matches = false; media.dispatchEvent(new Event('change')) })
  expect(document.documentElement.dataset.appearance).toBe('light')
  await act(async () => root.render(null)); expect(remove).toHaveBeenCalledWith('change', expect.any(Function))
})
it('keeps the last theme on unsupported documents, stale events and disconnect, then reports recovery', async () => {
  let handlers: any
  const subscription = { subscriptionId: 'fixture-reader', dispose: vi.fn(async () => {}) }
  const client = { subscribeRpc: vi.fn(async (_method, _params, supplied) => { handlers = supplied; return subscription }) } as unknown as AgentMuxHostedClient
  await act(async () => root.render(<Harness client={client} />))
  const snapshot = { sourceId: 'original-host', revision: 0, issues: [], values: { themeId: 'custom.first', theme: themeValue(GRAPHITE_THEME), appAppearance: 'dark', terminalPalette: { background: '#152537' } } }
  await act(async () => handlers.onInitial({ observation: snapshot }))
  expect(document.documentElement.dataset.theme).toBe('custom.first')
  await act(async () => handlers.onEvent({ type: 'snapshot', data: { ...snapshot, revision: 1, values: { ...snapshot.values, theme: { version: 999 } } } }))
  expect(document.documentElement.dataset.theme).toBe('custom.first'); expect(container.textContent).toContain('保留最后确认')
  await act(async () => handlers.onEvent({ type: 'snapshot', data: { ...snapshot, revision: 0 } }))
  expect(container.textContent).toContain('not newer')
  await act(async () => handlers.onEnd(new Error('Disconnected transport')))
  expect(document.documentElement.dataset.theme).toBe('custom.first'); expect(container.textContent).toContain('Disconnected transport')
  // An ended reader cannot report recovery through its old callbacks.
  await act(async () => handlers.onEvent({ type: 'snapshot', data: { ...snapshot, revision: 2 } }))
  expect(container.textContent).toContain('Disconnected transport')
  await act(async () => root.render(<Harness client={client} connected={false} />))
  await act(async () => root.render(<Harness client={client} />))
  await act(async () => handlers.onInitial({ observation: { ...snapshot, revision: 2 } }))
  expect(container.querySelector('[role=status]')!.textContent).toBe('')
})
it('releases an opening that settles after cancellation and never applies its late callback', async () => {
  let finish!: (value: any) => void, handlers: any
  const dispose = vi.fn(async () => {})
  const client = { subscribeRpc: (_method: unknown, _params: unknown, supplied: unknown) => { handlers = supplied; return new Promise(resolve => { finish = resolve }) } } as unknown as AgentMuxHostedClient
  await act(async () => root.render(<Harness client={client} />))
  await act(async () => root.render(<Harness client={null} connected={false} />))
  const before = document.documentElement.dataset.theme
  await act(async () => { handlers.onInitial({ observation: { sourceId: 'late-host', revision: 0, issues: [], values: { themeId: 'custom.late', theme: themeValue(GRAPHITE_THEME), appAppearance: 'dark', terminalPalette: { background: '#152537' } } } }); finish({ subscriptionId: 'late-reader', dispose }) })
  expect(dispose).toHaveBeenCalledOnce(); expect(document.documentElement.dataset.theme).toBe(before)
})
it('does not turn malformed terminal options into executable rendering config', () => {
  expect(() => observedTerminalPalette({ background: 'url(https://external.example)' })).toThrow()
  expect(() => observedTerminalPalette({ fontSize: 90 })).toThrow()
  expect(() => observedTerminalPalette({ extendedAnsi: [] })).toThrow()
})

it('retains the confirmed brand on unsupported choices while applying the independently valid theme, and defaults older snapshots to A', async () => {
  let handlers: any
  const client = { subscribeRpc: vi.fn(async (_method, _params, supplied) => {
    handlers = supplied; return { subscriptionId: 'brand-reader', dispose: async () => {} }
  }) } as unknown as AgentMuxHostedClient
  await act(async () => root.render(<Harness client={client} />))
  const snapshot = { sourceId: 'brand-host', revision: 0, issues: [], values: { appIcon: 'lingban', themeId: 'custom.brand',
    theme: themeValue(GRAPHITE_THEME), appAppearance: 'dark', terminalPalette: { background: '#152537' } } }
  await act(async () => handlers.onInitial({ observation: snapshot }))
  expect(container.querySelector('[data-app-icon]')?.getAttribute('data-app-icon')).toBe('lingban')
  const composer = container.querySelector('textarea')!
  composer.value = 'Private unsent brand-independent draft'; composer.focus(); composer.setSelectionRange(4, 11)
  await act(async () => handlers.onEvent({ type: 'snapshot', data: { ...snapshot, revision: 1,
    values: { ...snapshot.values, appIcon: 'future-brand', themeId: 'custom.next', appAppearance: 'light' } } }))
  expect(document.documentElement.dataset.theme).toBe('custom.next')
  expect(document.documentElement.dataset.appearance).toBe('light')
  expect(container.querySelector('[data-app-icon]')?.getAttribute('data-app-icon')).toBe('lingban')
  expect(container.querySelector('[role=status]')!.textContent).toContain('保留最后确认的图标')
  expect(container.querySelector('textarea')).toBe(composer)
  expect(composer.value).toBe('Private unsent brand-independent draft'); expect(composer.selectionStart).toBe(4)
  await act(async () => handlers.onEvent({ type: 'snapshot', data: { ...snapshot, revision: 2, values: { ...snapshot.values, appIcon: null } } }))
  expect(container.querySelector('[data-app-icon]')?.getAttribute('data-app-icon')).toBe('lingban')
  await act(async () => handlers.onEvent({ type: 'snapshot', data: { ...snapshot, revision: 3, values: { ...snapshot.values, appIcon: 'classic' } } }))
  expect(container.querySelector('[data-app-icon]')?.getAttribute('data-app-icon')).toBe('classic')
  expect(container.querySelector('[role=status]')!.textContent).toBe('')
  const { appIcon: _unavailableOnOlderHost, ...olderValues } = snapshot.values
  await act(async () => handlers.onEvent({ type: 'snapshot', data: { ...snapshot, revision: 4, values: olderValues } }))
  expect(container.querySelector('[data-app-icon]')?.getAttribute('data-app-icon')).toBe('qingzhuan')
})

it('the real Host file reader publishes icon-only changes and diagnoses malformed brand data without rejecting the theme', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-brand-')), path = join(directory, 'config.json')
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const config = { appearance: { terminalTheme: 'graphite', appAppearance: 'light', appIcon: { unsupported: true } } }
  await writeFile(path, JSON.stringify(config))
  const controller = new AbortController(), updates: any[] = []
  const reader = await createHostAppearanceObservation(path).subscribe(value => { updates.push(value) }, error => { throw error }, controller.signal)
  cleanup.push(() => { controller.abort(); reader.dispose() })
  expect(reader.initial.values.appIcon).toBeNull()
  expect(reader.initial.values.appAppearance).toBe('light')
  expect(reader.initial.values.themeId).toBe(DEFAULT_THEME_ID)
  expect(reader.initial.issues.some(item => item.id === 'app-icon')).toBe(true)
  await reader.start()
  await writeFile(path + '.next', JSON.stringify({ ...config, appearance: { ...config.appearance, appIcon: 'huihuan' } }))
  await rename(path + '.next', path)
  await until(() => updates.some(value => value.values.appIcon === 'huihuan'))
  expect(updates.at(-1).values.appAppearance).toBe('light')
  expect(updates.at(-1).issues).toEqual([])
})

it('projects Workspace ANSI from the phone Root system mode through the real Main public watch', async () => {
  const { f, client } = await actualHost()
  await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, appAppearance: 'system', terminalTheme: 'workspace' } }))
  const value = themeValue(structuredClone(GRAPHITE_THEME))
  value.variants.dark.colors.surface0 = '#132837'; value.variants.light.colors.surface0 = '#fff6e8'
  await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, themeId: 'custom.phone', customThemes: { 'custom.phone': value } } }))
  const reader = await themeObservation(f.owner).subscribe(async () => {}, async () => {}, new AbortController().signal)
  expect(reader.initial.values.terminalTheme).toBe('workspace')
  expect(reader.initial.values).not.toHaveProperty('terminalPalette')
  reader.dispose()
  await act(async () => root.render(<Harness client={client} />))
  await until(() => container.querySelector('output')!.textContent === '#132837')
  const composer = container.querySelector('textarea')!
  composer.value = 'Original phone draft'; composer.focus(); composer.setSelectionRange(1, 7)
  await act(async () => { media.matches = false; media.dispatchEvent(new Event('change')) })
  expect(container.querySelector('output')!.textContent).toBe('#fff6e8')
  expect(document.documentElement.dataset.appearance).toBe('light')
  expect(container.querySelector('textarea')).toBe(composer)
  expect(composer.value).toBe('Original phone draft'); expect(composer.selectionStart).toBe(1)
  await act(async () => { await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, terminalTheme: 'graphite' } })) })
  await until(() => container.querySelector('output')!.textContent === '#000000')
  await act(async () => { media.matches = true; media.dispatchEvent(new Event('change')) })
  expect(container.querySelector('output')!.textContent).toBe('#000000')
})

it('the actual MobileApp owns one root and consumes committed theme and semantic icon changes over the original public watch', async () => {
  const { f, client, subscribeRpc } = await actualHost()
  // Only unrelated Session/navigation reads are finite; appearance is the real
  // Main ConfigOwner -> Core Unix RPC -> hosted SDK stream used by the product.
  const hosted = { ...client, agentSessions: () => [], onEvent: () => () => {} } as unknown as AgentMuxHostedClient
  const platform = createBrowserPlatform({ overlayContainer: () => container })
  await act(async () => root.render(<MobileApp client={hosted} connection={{ state: 'connected', message: 'Private original appearance transport' }} platform={platform} />))
  await until(() => subscribeRpc.mock.calls.length === 1)
  const menu = container.querySelector<HTMLButtonElement>('[aria-label="手机设置与连接"]')!
  expect(menu, 'original retained Mobile root menu').not.toBeNull()
  const custom = themeValue(structuredClone(GRAPHITE_THEME))
  custom.variants.light.colors.background = '#faf0ce'
  custom.icons['action.menu'] = { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] }
  await act(async () => { await f.owner.update(config => ({ ...config, appearance: { ...config.appearance,
    appAppearance: 'light', appIcon: 'lingban', themeId: 'custom.actual-phone', customThemes: { 'custom.actual-phone': custom }, terminalTheme: 'workspace' } })) })
  await until(() => document.documentElement.dataset.theme === 'custom.actual-phone')
  expect(document.documentElement.dataset.appearance).toBe('light')
  expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#faf0ce')
  expect(document.getElementById('agentmux-icon-action.menu')?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  expect(container.querySelector('[aria-label="手机设置与连接"]')).toBe(menu)
  expect(window.matchMedia).toHaveBeenCalledTimes(1)
  expect(container.textContent).not.toContain('Theme runtime is already mounted')
  expect(subscribeRpc).toHaveBeenCalledExactlyOnceWith('settings.appearance.watch', {}, expect.any(Object))
})

it('the actual disconnected MobileApp renders the shared default brand in its header and connection page', async () => {
  await act(async () => root.render(<MobileApp client={null} connection={{ state: 'disconnected', message: 'Private disconnected device' }}
    platform={createBrowserPlatform({ overlayContainer: () => container })} />))
  expect(container.querySelector('.mobile-brand [data-app-icon]')?.getAttribute('data-app-icon')).toBe('qingzhuan')
  expect(container.querySelector('.mobile-connect-page [data-app-icon]')?.getAttribute('data-app-icon')).toBe('qingzhuan')
})

it('the actual MobileApp passes the committed non-default brand to its retained Mote welcome consumer', async () => {
  const { f, client, subscribeRpc } = await actualHost(), owner = getDeviceWorkface()
  const original = owner.snapshot().record
  cleanup.push(async () => { await owner.replaceBackup(original) })
  await owner.replaceBackup(emptyDeviceWorkface())
  await owner.confirmHost({ origin: location.origin, hostId: 'local' })
  const identity = { name: 'Brand test Mote', project: 'Private brand test', mote: { spaceId: 'brand-mote-space', name: 'Brand test Mote',
    contentReference: { hostId: 'local', workspaceId: 'brand-mote-workspace', workspacePath: join(tmpdir(), 'phone-brand-mote'), zoneId: 'brand-mote-zone' } } }
  await owner.updatePresentation({ selectedSessionId: null, hostUrl: '', panel: 'conversation' }, {
    primary: 'mote', showSession: true, showGoalWork: false, recentMoteSpaceId: identity.mote.spaceId, identity, profile: null,
    moteView: { spaceId: identity.mote.spaceId, section: 'discussion', detail: false, directAgent: false }
  })
  await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, appIcon: 'huihuan' } }))
  // Only appearance uses the real Unix Host stream here; no Mote creation/input is requested.
  const hosted = { ...client, agentSessions: () => [], onEvent: () => () => {} } as unknown as AgentMuxHostedClient
  await act(async () => root.render(<MobileApp client={hosted} connection={{ state: 'connected', message: 'Private original brand transport' }}
    platform={createBrowserPlatform({ overlayContainer: () => container })} restoreWorkface />))
  await until(() => container.querySelector('.mote-start__brand-art [data-app-icon]')?.getAttribute('data-app-icon') === 'huihuan')
  const welcome = container.querySelector('.mote-start'), composer = container.querySelector('.mote-start [contenteditable=true]')
  expect(welcome).not.toBeNull(); expect(composer).not.toBeNull()
  expect(welcome?.textContent).toContain('Brand test Mote')
  await act(async () => { await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, appIcon: 'classic' } })) })
  await until(() => container.querySelector('.mote-start__brand-art [data-app-icon]')?.getAttribute('data-app-icon') === 'classic')
  expect(container.querySelector('.mote-start')).toBe(welcome)
  expect(container.querySelector('.mote-start [contenteditable=true]')).toBe(composer)
  expect(subscribeRpc).toHaveBeenCalledExactlyOnceWith('settings.appearance.watch', {}, expect.any(Object))
})

it('actual MobileApp keeps its workface usable while reporting an unavailable appearance read service', async () => {
  const client = { agentSessions: () => [], onEvent: () => () => {} } as unknown as AgentMuxHostedClient
  await act(async () => root.render(<MobileApp client={client} connection={{ state: 'connected', message: 'Retained transport' }}
    platform={createBrowserPlatform({ overlayContainer: () => container })} />))
  await until(() => Boolean(container.querySelector('.mobile-service-notice')?.textContent?.includes('这个 Mac 尚未提供主题同步')))
  expect(container.querySelector('.mobile-service-notice')?.textContent).toContain('保留最后确认的主题、App 图标和原工作面')
  expect(container.querySelector('[aria-label="手机设置与连接"]')).not.toBeNull()
  expect(window.matchMedia).toHaveBeenCalledTimes(1)
})
