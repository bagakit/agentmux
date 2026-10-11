import { act } from 'react'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, vi } from 'vitest'
import { createClientUiRoot } from '../helpers/client-ui-render'
import { moteConnectionOwner } from './mote-connection-owner'
import { moteEnrollmentWeb } from './mote-enrollment-web'
import { registerMoteConnectionIpc } from '../../src/main/mote-connection-ipc'
import { registerMotePreferencesIpc } from '../../src/main/mote-preferences-ipc'
import { registerConnectorIpc } from '../../src/main/connector-ipc'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'
import { MoteDetailsPanel } from '../../src/renderer/src/components/MoteDetailsPanel'
import { MoteConnectionIdentity } from '../../src/renderer/src/components/MoteConnectionIdentity'
import { ExternalConnectionsSettings } from '../../src/renderer/src/components/settings/ExternalConnectionsSettings'
import { SettingsNavigation } from '../../src/renderer/src/components/SettingsNavigation'
import type { MoteWorkfaceScope } from '../../src/renderer/src/lib/mote-workface'
import { installNativePopover, moteConfig } from './mote-workface'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../../packages/core/test/helpers/object-cli-rpc'

const { defaultHttpInstance } = createRequire(resolve('packages/connectors/package.json'))('@larksuiteoapi/node-sdk')
export async function moteBotUi(options: Parameters<typeof moteConnectionOwner>[1] = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const root = await mkdtemp(join(tmpdir(), 'amx-mote-ui-')), original = useAppStore.getState()
  const restore = installNativePopover(), calls: Array<{ method?: string; url?: string; data?: any }> = []
  let unknownPatch = false
  const native = moteEnrollmentWeb(), registration = vi.fn(native.fetch)
  vi.stubGlobal('fetch', registration)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(async (r: any) => {
    if (r.url?.includes('/auth/v3/')) return { code: 0, tenant_access_token: 'controlled-tenant-access', app_access_token: 'controlled-app-access', expire: 3600 }
    calls.push(r)
    if (r.url?.endsWith('/bot/v3/info')) return { code: 0, bot: { open_id: 'original-bot', app_name: 'Online bot', avatar_url: 'https://images.example.invalid/online.png' } }
    if (r.url?.endsWith('/app_avatar/upload')) return { code: 0, data: { url: 'https://images.example.invalid/uploaded.png' } }
    if (r.method === 'PATCH') { if (unknownPatch) throw new Error('Controlled unconfirmed PATCH'); return { code: 0, data: {} } }
    const app = r.url?.match(/applications\/([^/]+)/)?.[1] ?? 'cli_mote_1'
    if (r.url?.includes('/app_versions/')) return { code: 0, data: { app_version: { app_id: app, version_id: 'online-exact', description: 'Original online description', status: 1 } } }
    return { code: 0, data: { app: { app_id: app, online_version_id: 'online-exact', description: 'Metadata only', i18n: [{ i18n_key: 'zh_cn', name: 'Before' }, { i18n_key: 'en_us', name: 'Keep English' }] } } }
  })
  let owner: Awaited<ReturnType<typeof moteConnectionOwner>>
  try { owner = await moteConnectionOwner(root, options) }
  catch (error) {
    const cleanupErrors: unknown[] = []
    for (const close of [restore, () => rm(root, { recursive: true, force: true }), () => vi.restoreAllMocks(), () => vi.unstubAllGlobals(), () => vi.unstubAllEnvs()]) { try { await close() } catch (failure) { cleanupErrors.push(failure) } }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'Mote fixture initialization and cleanup failed')
    throw error
  }
  const config = { ...moteConfig, workspaces: [owner.workspace], startup: { skipAgentAvailabilityCheckWait: true } }
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  window.localStorage.clear(); await useAppStore.persist.rehydrate()
  const stop = await useAppStore.getState().initialize(); stop()
  useAppStore.setState({ config, loading: false, spaceZoneBindings: {}, moteBotRequests: {}, moteConnectionSaveIntents: {} })
  const handlers = new Map<string, (...args: any[]) => Promise<any>>(), sender = {}
  const handleWithEvent = (name: string, handler: (...args: any[]) => Promise<any>) => { handlers.set(name, handler) }
  const assertTrusted = (_channel: string, event: { sender: object }) => { if (event.sender !== sender) throw new Error('Untrusted renderer') }
  registerMoteConnectionIpc({ socketPath: owner.server.path, handleWithEvent, assertTrusted })
  registerMotePreferencesIpc({ socketPath: owner.server.path, handleWithEvent, assertTrusted })
  registerConnectorIpc({ socketPath: owner.server.path, handleWithEvent, assertTrusted, secrets: owner.connections.secrets })
  const forward = async (method: any, input: any) => await handlers.get('moteConnections:call')!({ sender }, method, input)
  const parentCalls = vi.spyOn(api.moteConnections, 'call').mockImplementation(forward)
  const connectionCalls = vi.spyOn(api.connections, 'call').mockImplementation(async (method, input) => await handlers.get('connections:call')!({ sender }, method, input))
  const saves = vi.spyOn(api.motePreferences, 'save').mockImplementation(async input => await handlers.get('motePreferences:save')!({ sender }, input))
  vi.spyOn(api.motePreferences, 'read').mockImplementation(async input => await handlers.get('motePreferences:read')!({ sender }, input))
  vi.spyOn(api.files, 'readPublic').mockImplementation(input => owner.client.call('file.read', input))
  vi.spyOn(api.moteAvatars, 'read').mockImplementation(input => owner.client.call('space.mote.avatar.read', input))
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  const container = document.createElement('div'); document.body.append(container)
  let view = createClientUiRoot(container), mounted = false
  const navigation = { open: vi.fn(), openToolkit: vi.fn(), openHost: vi.fn() }
  const scopes = await Promise.all(owner.motes.map(async m => {
    const topic = (await owner.topics.read(owner.workspace, m.id))!
    return { topic: { ...topic, title: 'Display title is not the public source', summary: 'DO-NOT-PUBLISH-DISPLAY' }, workspace: owner.workspace, rootPath: topic.directoryPath } satisfies MoteWorkfaceScope
  }))
  const render = async (index = 0, settings = false) => {
    await act(async () => view.render(<SettingsNavigation.Provider value={navigation}>{settings ? <ExternalConnectionsSettings active /> : <MoteConnectionIdentity key={index} scope={scopes[index]!} active />}</SettingsNavigation.Provider>)); mounted = true
  }
  async function click(text: string) {
    let node!: HTMLElement
    await vi.waitFor(async () => { await act(async () => {}); node = [...document.querySelectorAll<HTMLElement>('button,summary')].find(n => n.textContent?.trim() === text || n.getAttribute('aria-label') === text)!; expect(node, text + '\n' + document.body.textContent).toBeTruthy(); expect((node as HTMLButtonElement).disabled).not.toBe(true) })
    await act(async () => { node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', buttons: 1 })); node.click() })
    await settle()
  }
  async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }
  async function open(index = 0) { await render(index); await vi.waitFor(() => expect(document.querySelector('.mote-connection__row')).not.toBeNull()); await act(async () => (document.querySelector('.mote-connection__row') as HTMLElement).click()); await settle() }
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  return { ...owner, container, scopes, calls, registration, parentCalls, connectionCalls, saves, forward, handlers, sender, navigation, open, click, render, settle,
    async renderMotePanel(index = 0) { await act(async () => view.render(<SettingsNavigation.Provider value={navigation}><MoteDetailsPanel scope={scopes[index]!} active onOpenPath={async () => {}} /></SettingsNavigation.Provider>)); mounted = true; await settle() },
    get beginCount() { return options.generic ? owner.counts.begin : native.begins }, get authenticationCount() { return options.generic ? owner.counts.authentication : native.authentications },
    get creationCount() { return options.generic ? owner.counts.create : native.creates },
    setUnknownPatch() { unknownPatch = true },
    async preferenceCli() { const r = await runCompiledObjectCli(['--endpoint', 'unix:' + owner.server.path, 'space', 'mote', 'preferences', 'read', '--input', '-'], objectCliEnvironment(root), JSON.stringify({kind: 'connection', target: owner.target()})); expect(r.code, r.stdout + r.stderr).toBe(0); return JSON.parse(r.stdout).result },
    async cli(action: string, input: unknown) { const r = await runCompiledObjectCli(['--endpoint', 'unix:' + owner.server.path, 'space', 'mote', 'connection', action, '--input', '-'], objectCliEnvironment(root), JSON.stringify(input)); expect(r.code, r.stdout + r.stderr).toBe(0); return JSON.parse(r.stdout).result },
    async remount(index = 0) { if (mounted) await act(async () => view.unmount()); view = createClientUiRoot(container); await useAppStore.persist.rehydrate(); await open(index) },
    async close() {
      const errors: unknown[] = []
      const actions = [async () => { if (mounted) await act(async () => view.unmount()) }, () => container.remove(), () => owner.close(), settle, restore, () => window.localStorage.clear(), () => useAppStore.setState(original, true), () => rm(root, { recursive: true, force: true }), () => vi.restoreAllMocks(), () => vi.unstubAllGlobals(), () => vi.unstubAllEnvs()]
      for (const close of actions) { try { await close() } catch (error) { errors.push(error) } }
      if (errors.length) throw new AggregateError(errors, 'Mote Renderer consumer cleanup failed')
    }
  }
}
