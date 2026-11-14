// @vitest-environment happy-dom
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION } from '../../../packages/core/src/runtime-owner-protocol'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { registerLoadedIdentityIpc } from '../src/main/client-observation'
import type { DesktopLoadedIdentity } from '../src/shared/client-observation'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

vi.mock('node:child_process', async original => {
  const real = await original<typeof import('node:child_process')>()
  return { ...real, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    real.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../../../packages/core/src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof real.fork }
})

const dom = composerDOM()
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose() })
const group = () => dom.container.querySelector<HTMLElement>('[data-settings-field="runtime-versions"]')!
const row = (label: string) => [...group().querySelectorAll('dt')].find(value => value.textContent === label)?.nextElementSibling?.textContent
const packageStamp = { schema: 'agentmux.package-identity.v1', appVersion: '0.3.1', sourceCommit: 'af'.repeat(20), sourceTree: 'ab'.repeat(20), platform: 'darwin', arch: 'arm64' } as const
const staged = { kind: 'staged', id: 'b'.repeat(64), identity: { ctxmux: 'bundled-version-alone', shell: 'earlier-shell-build' } } as const

function useOriginalLoadedIpc(appVersion: string, loaded: () => DesktopLoadedIdentity['renderer'], stamp: DesktopLoadedIdentity['package'] = packageStamp) {
  const handlers = new Map<string, (event: any) => DesktopLoadedIdentity>()
  registerLoadedIdentityIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, appVersion, package: stamp, renderer: loaded })
  return vi.spyOn(api.ui, 'readLoadedIdentity').mockImplementation(async () => handlers.get('ui:readLoadedIdentity')!({}))
}

it('shows the immediately available App with live Native from the original RPC after Settings search', async () => {
  const core = await rpcOwnerFixture([]); cleanups.push(core.close)
  core.inner.kernel.identity = () => ({ daemonInstanceId: 'fixture-native', protocolVersion: 23, buildIdentity: 'ctxmuxd/0.9.8' })
  const host = new AgentMuxHostedRuntimeService(core.client, null, () => ({
    ownerInstanceId: 'private-semantic-instance', runtimeId: 'private-runtime', ctxmux: core.client.runtimeIdentity(),
    availability: 'connected', processId: process.pid, protocolVersion: AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION
  }))
  cleanups.push(() => host.dispose())
  const server = new AgentMuxControlServer({ coreClients: core.coreClients, hostedRuntime: () => host, socketPath: join(core.root, 'settings.sock') })
  await server.start(); cleanups.push(() => server.stop())
  const hostedRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => hostedRpc.dispose())
  const routes: string[] = []
  const desktopServer = new AgentMuxControlServer({ coreClients: core.coreClients, socketPath: join(core.root, 'desktop.sock'),
    callOriginalCore: async (hostId, method, params) => { routes.push(hostId + ':' + method); return await hostedRpc.call(method, params) } })
  await desktopServer.start(); cleanups.push(() => desktopServer.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktopServer.path } }); cleanups.push(() => rpc.dispose())
  let resume!: () => void
  const ready = new Promise<void>(resolve => { resume = resolve })
  const runtime = vi.spyOn(api.spatial, 'owner').mockImplementation(async () => { await ready; return await rpc.call('runtime.owner.identity', {}) })
  const desktop = useOriginalLoadedIpc(packageStamp.appVersion, () => staged)

  await dom.render(<SettingsPanel onClose={() => {}} />)
  expect(runtime).not.toHaveBeenCalled()
  expect(desktop).not.toHaveBeenCalled()
  const search = dom.container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Kernel version')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await dom.click('[data-settings-search-result="general:runtime-versions"]')
  expect(row('App')).toContain(packageStamp.appVersion)
  expect(row('App')).toContain(packageStamp.sourceCommit)
  expect(row('Renderer build')).toContain(staged.id)
  expect(row('Kernel (ctxmux)')).toBe('Checking…')
  expect(runtime).toHaveBeenCalledOnce()
  await act(async () => { resume(); await runtime.mock.results[0]!.value })
  expect(row('Kernel (ctxmux)')).toContain('ctxmuxd/0.9.8')
  expect(row('Kernel (ctxmux)')).toContain('Protocol 23')
  expect(row('Kernel (ctxmux)')).not.toContain(staged.identity.ctxmux)
  expect(row('Core protocol')).toContain('private-semantic-instance')
  expect(routes).toEqual(['local:runtime.owner.identity'])
  expect(core.inner.kernel.connect).not.toHaveBeenCalled()
  expect(core.inner.kernel.stop).not.toHaveBeenCalled()
})

it('shows the actual Main version even without a stamp when the original Host is unavailable', async () => {
  useOriginalLoadedIpc('0.2.4', () => null, null)
  vi.spyOn(api.spatial, 'owner').mockRejectedValue(new Error('Original Core unavailable'))
  await dom.render(<SettingsPanel initialSection="general" onClose={() => {}} />)
  expect(row('App')).toBe('0.2.4')
  expect(row('Renderer build')).toBe('Unconfirmed')
  expect(row('Kernel (ctxmux)')).toBe('Unconfirmed')
  expect(row('Core protocol')).toBe('Unconfirmed')
})

it('does not read an inactive General and refreshes exactly once after it becomes visible', async () => {
  let loaded: DesktopLoadedIdentity['renderer'] = staged
  const app = useOriginalLoadedIpc(packageStamp.appVersion, () => loaded)
  const runtime = vi.spyOn(api.spatial, 'owner').mockRejectedValue(new Error('Original Core unavailable'))
  const save = vi.spyOn(api.config, 'save')
  const render = (visible: boolean) => dom.render(<SettingsPanel initialSection="general" visible={visible} onClose={() => {}} />)
  await render(false)
  expect(app).not.toHaveBeenCalled()
  expect(runtime).not.toHaveBeenCalled()
  await render(true)
  expect(row('Renderer build')).toContain(staged.id)
  loaded = null
  await dom.click('[aria-label="Refresh versions"]')
  expect(row('Renderer build')).toBe('Unconfirmed')
  expect(row('App')).toContain(packageStamp.sourceCommit)
  expect(app).toHaveBeenCalledTimes(2)
  expect(runtime).toHaveBeenCalledTimes(2)
  expect(save).not.toHaveBeenCalled()
})
