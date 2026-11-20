// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ProfileNetworkDiagnostics } from '../src/renderer/src/components/settings/ProfileNetworkDiagnostics.js'
import type { BrowserProfileSummary } from '../src/shared/contracts.js'
import type { BrowserProxyProbe } from '@agentmux/core/control'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const clean: (() => Promise<void>)[] = []
afterEach(async () => { for (const action of clean.splice(0)) await action() })
const profile: BrowserProfileSummary = { id: 'exact-profile', revision: 'config-original', label: 'Research', createdAt: 1, source: null, isDefault: false,
  network: { mode: 'proxy', server: { scheme: 'socks5', host: 'proxy.example', port: 1080 } } }
const diagnostic: BrowserProxyProbe = { id: 'exact-probe', profileId: profile.id, configurationRevision: profile.revision, route: { mode: 'proxy', scheme: 'socks5', host: 'proxy.example', port: 1080 },
  exitOrigin: 'https://exit.example', startedAt: 1, finishedAt: 2, phase: 'observed', tcp: { status: 'connected', latencyMs: 1 },
  authentication: { status: 'rejected', reason: 'authentication-rejected', latencyMs: 2 }, exit: { status: 'unknown', reason: 'exit-unavailable', latencyMs: 3 },
  webrtc: { status: 'observed', policy: 'disable_non_proxied_udp', observedPages: 1 } }
async function mount(ports: NonNullable<Parameters<typeof ProfileNetworkDiagnostics>[0]['ports']>) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => { root.render(createElement(ProfileNetworkDiagnostics, { profile, ports })) })
  clean.push(async () => { await act(async () => root.unmount()); container.remove() })
  const click = async (text: string) => { const button = [...container.querySelectorAll('button')].find(button => button.textContent === text); expect(button).toBeDefined(); await act(async () => button!.click()) }
  return { container, root, click }
}
it('shows separate protocol facts and invokes the actual network port with a retained original id', async () => {
  const probeProfileNetwork = vi.fn(async (_profileId: string, operationId: string) => ({ diagnostic: { ...diagnostic, id: operationId }, historySaved: true })), profileNetworkHistory = vi.fn(async () => ({ diagnostics: [diagnostic], nextCursor: null }))
  const f = await mount({ probeProfileNetwork, profileNetworkHistory }); await f.click('Check route')
  expect(probeProfileNetwork).toHaveBeenCalledExactlyOnceWith(profile.id, expect.any(String))
  const facts = [...f.container.querySelectorAll('dd')].map(row => row.textContent)
  expect(facts).toEqual(['Connected', 'Proxy rejected sign-in', 'No exit response confirmed', 'Non-proxied UDP disabled · 1 page'])
  expect(f.container.textContent).not.toContain('Authenticated'); expect(f.container.textContent).toContain('The exit check uses this Profile')
})
it('an unknown result inspects the exact original id without sending another probe', async () => {
  const probeProfileNetwork = vi.fn(async (_profileId: string, _operationId: string) => { throw new Error('The reply was lost') }), profileNetworkHistory = vi.fn(async (_profile: string, id?: string) => ({ diagnostics: id ? [{ ...diagnostic, id }] : [], nextCursor: null }))
  const f = await mount({ probeProfileNetwork, profileNetworkHistory }); await f.click('Check route')
  const original = probeProfileNetwork.mock.calls[0]![1]
  expect(f.container.textContent).toContain('result is unconfirmed'); await f.click('Inspect check')
  expect(profileNetworkHistory).toHaveBeenLastCalledWith(profile.id, original); expect(probeProfileNetwork).toHaveBeenCalledTimes(1)
  expect(f.container.textContent).toContain('Proxy rejected sign-in')
})
it('history failure remains visible and leaves a fresh check available', async () => {
  const probeProfileNetwork = vi.fn(async (_profileId: string, operationId: string) => ({ diagnostic: { ...diagnostic, id: operationId }, historySaved: false })), profileNetworkHistory = vi.fn(async () => { throw new Error('Unknown read') })
  const f = await mount({ probeProfileNetwork, profileNetworkHistory })
  expect(f.container.textContent).toContain('History could not be read')
  await f.click('Check route'); expect(probeProfileNetwork).toHaveBeenCalledTimes(1)
  expect(f.container.textContent).toContain('history save is unconfirmed')
  expect([...f.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New check')?.disabled).toBe(false)
})
it('consumes original Main result envelopes through the same methods as the production Renderer bridge', async () => {
  const { ipcResult, unwrapIpcResultMethods, BROWSER_PROFILE_RESULT_METHODS } = await import('../src/shared/ipc-result.js')
  const probe = vi.fn(async (_profileId: string, operationId: string) => ipcResult(() => ({ diagnostic: { ...diagnostic, id: operationId }, historySaved: true })))
  const history = vi.fn(async () => ipcResult(() => ({ diagnostics: [diagnostic], nextCursor: null })))
  const ports = unwrapIpcResultMethods<any, any>({ probeProfileNetwork: probe, profileNetworkHistory: history } as never, BROWSER_PROFILE_RESULT_METHODS)
  const f = await mount(ports)
  expect(f.container.textContent).toContain('Recent checks · 1')
  expect(f.container.textContent).toContain('Sign-in rejected')
  await f.click('Check route')
  expect(probe).toHaveBeenCalledExactlyOnceWith(profile.id, expect.any(String))
  expect(f.container.textContent).toContain('No exit response confirmed')
  expect(f.container.textContent).not.toContain('undefined')
})
