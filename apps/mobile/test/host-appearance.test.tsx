import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { GRAPHITE_THEME, themeValue, DEFAULT_THEME_ID } from '@agentmux/client-ui/theme'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { themeObservation } from '../../desktop/src/main/theme-observation.js'
import { configOwnerFixture } from '../../desktop/test/helpers/config-owner-fixture.js'
import { useHostAppearance, observedTerminalPalette } from '../src/appearance/useHostAppearance'

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
    <p role="status">{appearance.issue}</p><output>{appearance.terminalPalette?.background}</output></>
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
  const composer = container.querySelector('textarea')!, icon = container.querySelector('button svg')!
  composer.value = 'Unsent edited draft'; composer.focus(); composer.setSelectionRange(3, 8)
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
  await act(async () => { await f.owner.update(config => ({ ...config, appearance: { ...config.appearance, themeId: DEFAULT_THEME_ID } })) })
  expect(document.documentElement.dataset.theme).toBe('custom.mobile')
  await act(async () => root.render(<Harness client={client} />))
  await until(() => document.documentElement.dataset.theme === DEFAULT_THEME_ID)
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
  await act(async () => handlers.onEvent({ type: 'snapshot', data: { ...snapshot, revision: 2 } }))
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
