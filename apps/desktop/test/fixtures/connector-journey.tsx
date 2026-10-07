import { act } from 'react'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { roomProvisioningFixture, config, core } from '../../../../packages/connectors/test/fixtures/room-provisioning.js'
import { createDesktopConnections } from '../../src/main/connector-host.js'
import { registerConnectorIpc } from '../../src/main/connector-ipc.js'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion } from '../../src/renderer/src/lib/workbench-tabs'
import { WorkspaceWorkbench } from '../../src/renderer/src/components/WorkspaceWorkbench'
import { SettingsNavigation } from '../../src/renderer/src/components/SettingsNavigation'
import { composerConfig, composerDOM, composerSession } from '../helpers/composer-dom-fixture'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../../packages/core/test/helpers/object-cli-rpc.js'

/** Production Renderer, IPC, public Core and Desktop Host; only encryption/adapter/terminal leaves are controlled. */
export function connectorJourneyFixture() {
  const dom = composerDOM(), settings = vi.fn()
  let original: Awaited<ReturnType<typeof roomProvisioningFixture>>, services: Awaited<ReturnType<typeof createDesktopConnections>>
  let server: InstanceType<typeof core.AgentMuxControlServer>, calls: { method: ConnectionMethod; input: unknown; result?: unknown }[]
  let forward: <M extends ConnectionMethod>(method: M, params: ConnectionParamsMap[M]) => Promise<ConnectionResultMap[M]>
  beforeEach(async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    // Use the original startup/hydration owner to admit real UI intent persistence.
    localStorage.removeItem('agentmux-workbench-v1')
    vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
    await useAppStore.persist.rehydrate()
    const stopStartup = await useAppStore.getState().initialize(); stopStartup()
    original = await roomProvisioningFixture()
    vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
    services = await createDesktopConnections({ directory: join(original.root, 'ui-connections'), adapters: [original.adapter], bindings: { spatial: original.spatial, checkpoint: original.checkpoint },
      encryption: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } })
    const secret = await services.secrets.store({ operationId: 'ui-credential', secret: 'controlled-host-credential' })
    await services.connections.configure({ operationId: 'ui-configure', expectedRevision: null, connection: { ...config, credentialRef: secret.credentialRef } })
    const socketPath = join(original.root, 'ui.sock')
    server = new core.AgentMuxControlServer({ socketPath, connections: services.connections, spatialState: original.spatial, coreClients: () => [{ hostId: 'local', client: original.client }] })
    await server.start()
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
    registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: vi.fn(), socketPath, secrets: services.secrets })
    calls = []; settings.mockReset()
    forward = async (method, params) => { const call: typeof calls[number] = { method, input: structuredClone(params) }; calls.push(call); const result = await handlers.get('connections:call')!({}, method, params) as ConnectionResultMap[typeof method]; call.result = result; return result }
    vi.spyOn(api.connections, 'call').mockImplementation(forward)
    const session = { ...composerSession(original.session.agentSessionId, 'claude'), workspacePath: original.root, nativeHandle: original.session.nativeHandle!, label: 'Original Mote Agent' }
    let tab = createWorkbenchTab('ui-tab', { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: 'original-region', sessionId: session.id })
    tab = addWorkbenchRegion(tab, 'original-region', 'right', { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: 'other-region', sessionId: session.id })
    useAppStore.setState({ loading: false, config: { ...composerConfig, workspaces: [{ ...composerConfig.workspaces[0]!, path: original.root }] }, sessions: [session],
      tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('ui-group', [tab.id]) }, activeWorkspaceId: 'workspace', mainSurface: 'workbench', viewModes: { [session.id]: 'terminal' },
      agentComposerDrafts: { [session.id]: 'Keep the original draft 中' }, connectorRoomIntents: {}, agentNames: {}, agentSteerQueues: {}, agentSteerInFlight: {}, timelines: {} })
    vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (reference, options) => original.client.sessionHistoryPage(reference.agentSessionId, options))
    vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(undefined)
  })
  afterEach(async () => {
    if (calls?.length) {
      const test = expect.getState().currentTestName!, directory = resolve('.bagakit/feature-tracker/features/f-2wr8fmvnv/artifacts/T-013-consumers')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, createHash('sha256').update(test).digest('hex').slice(0, 12) + '.json'), JSON.stringify({
        test, scope: 'Mounted original Workbench/menu/Composer through trusted IPC and compiled public Core/CLI into the original Desktop Host. Adapter, encryption and terminal rendering are controlled; no real platform or provider qualification.',
        publicCalls: calls, originalRoomRequests: original.create.mock.calls.map(call => call[0]), originalMemberRequests: original.addMembers.mock.calls.map(call => call[0]),
        retainedClientIntents: useAppStore.getState().connectorRoomIntents, originalDraft: useAppStore.getState().agentComposerDrafts['original-agent']
      }, null, 2) + '\n')
    }
    await dom.render(null); await server?.stop(); services?.close(); await original?.close(); vi.unstubAllEnvs()
  })
  async function mount() { await dom.render(<SettingsNavigation.Provider value={{ open: settings, openToolkit: () => {}, openHost: () => {} }}><WorkspaceWorkbench workspaceId="workspace" /></SettingsNavigation.Provider>) }
  async function menu(label: string, regionId = 'original-region', context = false) {
    const trigger = document.querySelector<HTMLElement>('[data-workbench-region-id="' + regionId + '"] .agent-region-header__more')
    expect(trigger, 'original Agent More trigger').not.toBeNull()
    await act(async () => {
      if (context) document.querySelector('[data-workbench-region-id="' + regionId + '"]')!.dispatchEvent(new MouseEvent('contextmenu', { button: 2, clientX: 24, clientY: 24, bubbles: true, cancelable: true }))
      else { trigger!.focus(); trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) }
    })
    let item: HTMLElement | undefined
    await vi.waitFor(async () => { await act(async () => {}); item = [...document.querySelectorAll<HTMLElement>(context ? '.region-context-menu [role="menuitem"]' : '.agent-region-menu[data-owner-region-id="' + regionId + '"] [role="menuitem"]')].find(node => node.textContent?.trim() === label); expect(item, 'actual ' + label + ' action').toBeDefined() }, { timeout: 6000 })
    await act(async () => item!.click())
    await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('[role="dialog"]')).not.toBeNull() })
    await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector<HTMLSelectElement>('[aria-label="Group application"]')?.value, document.querySelector('[role="dialog"]')?.textContent).toBe(config.connectionId) }, { timeout: 6000 })
  }
  async function fill(label: string, value: string) {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-label="' + label + '"]')!
    expect(input).not.toBeNull()
    await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  async function button(label: string) { const item = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent?.trim() === label); expect(item, label).toBeDefined(); await act(async () => item!.click()) }
  async function cli(args: string[]) {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', ...args], objectCliEnvironment(original.root))
    expect(output.code, output.stdout + output.stderr).toBe(0)
    return JSON.parse(output.stdout).result
  }
  return { dom, mount, menu, fill, button, cli, settings, get original() { return original }, get services() { return services }, get calls() { return calls }, get forward() { return forward }, get session() { return useAppStore.getState().sessions[0]! } }
}
