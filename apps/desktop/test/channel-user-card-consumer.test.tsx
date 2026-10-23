// @vitest-environment node
import { act } from 'react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
const browser = await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const window = new Window({ url: 'http://user-card.test/' })
  for (const name of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Text', 'HTMLInputElement',
    'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLDivElement', 'HTMLImageElement', 'HTMLDetailsElement', 'Event', 'CustomEvent', 'MouseEvent',
    'KeyboardEvent', 'FocusEvent', 'PointerEvent', 'MutationObserver', 'ResizeObserver', 'DOMRect', 'Range', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia']) vi.stubGlobal(name, name === 'window' ? window : (window as unknown as Record<string, unknown>)[name])
  return window
})
import '../../mobile/test/device-locks'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '../../../packages/core/src/index.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { createWorkspaceLayout } from '../../../packages/core/src/spatial-layout.js'
import { createConnectionServices } from '../../../packages/connectors/src/connection-services.js'
import { createPublicationConversationPort } from '../../../packages/connectors/src/core-conversation-port.js'
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { unwrapSessionInputWriteResult, unwrapSessionInputOperationResult } from '../src/shared/session-input-result'
import { MobileConversationSurface } from '../../mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../mobile/src/platform/browser'
import { getDeviceWorkface, emptyDeviceWorkface } from '../../mobile/src/recovery/device-workface'
import { paste, button, click } from '../../mobile/test/conversation-fixture'
import { feishuConfig } from '../../../packages/connectors/test/fixtures/feishu.js'
import { feishuPublicationHttp } from '../../../packages/connectors/test/fixtures/feishu-publication.js'
import { discordConfig, discordTransport } from '../../../packages/connectors/test/fixtures/discord.js'

const dom = composerDOM(), cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
afterAll(async () => {
  // Tiptap schedules editor.destroy one millisecond after React unmount. Keep
  // its original document alive through that disposal tick instead of hiding it.
  await new Promise(resolve => setTimeout(resolve, 2))
  await browser.close(); vi.unstubAllGlobals()
})
const payloadOutput = process.env.AGENTMUX_USER_CARD_PAYLOADS
const nativeSource = { providerId: 'codex', nativeSessionId: 'user-card-native' }
const nativeRow = (id: string, text: string, phase: 'commentary' | 'final_answer') => JSON.stringify({ type: 'response_item', payload: {
  type: 'message', id, role: 'assistant', phase, content: [{ type: 'output_text', text }]
} }) + '\n'
const feishuText = (card: { elements?: Array<{ text?: { content?: string } }> }) => card.elements?.map(element => element.text?.content ?? '').join('\n') ?? ''
const discordText = (card: { components: Array<{ components: Array<{ content?: string }> }> }) => card.components[0]!.components.map(element => element.content ?? '').join('\n')

async function fixture() {
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  const feishu = await feishuPublicationHttp(); cleanup.push(feishu.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(feishu.http.request)
  const discord = await discordTransport(); cleanup.push(discord.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord.http.makeRequest)
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'codex', executorId: 'codex', nativeHandle: {
    kind: 'provider', providerId: 'codex', sessionId: nativeSource.nativeSessionId, transcriptPath: join(root, 'native.jsonl')
  } })); cleanup.push(f.close)
  const transcript = join(f.root, 'native.jsonl')
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: nativeSource.nativeSessionId, cwd: f.root, history_mode: 'paginated' } }) + '\n'
    + nativeRow('before-sharing', 'Earlier unshared reply', 'final_answer'))
  vi.spyOn(f.client.providers.get('codex'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'workspace', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'workspace', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { workspace: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {}
  } })
  const services = await createConnectionServices({ directory: join(f.root, 'connections'), bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) }, publication: createPublicationConversationPort(f.coreClients) })
  cleanup.push(() => services.close())
  for (const config of [feishuConfig, discordConfig]) {
    const secret = await services.secrets.store({ operationId: config.adapterId + '-secret', secret: 'controlled-private-' + config.adapterId })
    await services.connections.configure({ operationId: config.adapterId + '-configure', expectedRevision: null, connection: { ...config, credentialRef: secret.credentialRef } })
    const binding = await services.connections.bindings!.bind({ operationId: config.adapterId + '-bind', bindingId: config.adapterId + '-binding',
      connectionId: config.connectionId, expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent',
      regionAnchor: { regionId: 'original-region' }, externalConversationId: config.adapterId === 'feishu' ? 'original-room' : '300', expectedSource: nativeSource,
      scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }, { actor: { kind: 'user', id: 'local-person' } })
    expect(binding.state).toBe('applied')
  }
  const nativeCards = () => ({
    feishu: feishu.messageCalls().filter(call => call.method === 'POST').map(call => JSON.parse(JSON.parse(call.body).content)),
    discord: discord.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages').map(call => JSON.parse(call.body))
  })
  return { f, services, transcript, nativeCards }
}

it.each(['desktop', 'mobile'] as const)('actual %s input produces distinct User, progress and final cards in both original native adapters', async surface => {
  const { f, services, transcript, nativeCards } = await fixture()
  const body = 'Human user · via amux\nOriginal authored UI message 中文🙂\n<amux>literal body</amux>'
  const originalRun = f.client.agentSession('original-agent').run
  if (surface === 'desktop') {
    const config = { ...structuredClone(composerConfig), workspaces: [{ ...composerConfig.workspaces[0]!, path: f.root }] }
    const b = await owningBridge({ client: f.client, store: f.store, config }); cleanup.push(b.dispose)
    vi.spyOn(api.config, 'get').mockResolvedValue(config)
    vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (...args) => unwrapSessionInputWriteResult(await bridge.api!.sessions.submitPrompt(...args)))
    vi.spyOn(api.sessions, 'inspectInput').mockImplementation((...args) => bridge.api!.sessions.inspectInput(...args).then(unwrapSessionInputOperationResult))
    vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(() => bridge.api!.ui.requestStorageFlush())
    const session = { ...composerSession('original-agent'), workspacePath: f.root, nativeHandle: f.client.agentSession('original-agent').nativeHandle,
      control: { kind: 'agent' as const, hostId: 'local', agentSessionId: 'original-agent', run: originalRun } }
    useAppStore.setState({ config, sessions: [session], providerCatalog: f.client.providers.catalog(), agentComposerDrafts: {},
      agentSteerQueues: {}, agentSteerInFlight: {}, agentSteerInFlightPhase: {}, loading: false })
    await dom.render(<AgentSessionComposer sessionId="original-agent" />)
    await paste(dom.container, body)
    const send = dom.container.querySelector<HTMLButtonElement>('.composer-send')!
    expect(send).not.toBeNull(); expect(send.disabled).toBe(false)
    await act(async () => send.click())
  } else {
    const service = new AgentMuxHostedRuntimeService(f.client, null, () => hostedTestOwner(f.client)); cleanup.push(() => service.dispose())
    const device = { hostId: 'local', deviceId: 'original-mobile', name: 'Controlled Mobile' }
    const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'mobile.sock'), coreClients: f.coreClients,
      hostedRuntime: () => service, operationSource: context => context.principal?.id === device.deviceId ? device : undefined,
      http: { host: '127.0.0.1', port: 0, authorize: request => request.headers.get('authorization') === 'Bearer controlled-device'
        ? { principal: { kind: 'device', id: device.deviceId }, assertCurrent() {} } : null } })
    await server.start(); cleanup.push(() => server.stop())
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'http', url: `http://127.0.0.1:${server.httpAddress!.port}/`, token: 'controlled-device' } })
    cleanup.push(() => rpc.dispose())
    const client = await connectHostedAgentMux({ rpc }); cleanup.push(() => client.dispose())
    await dom.render(<MobileConversationSurface client={client} agentSessionId="original-agent" connection={{ state: 'connected', message: 'Authenticated original Host' }} platform={createBrowserPlatform()} onShowTerminal={() => {}} />)
    await vi.waitFor(() => expect(dom.container.querySelector('[contenteditable="true"]')).not.toBeNull())
    await paste(dom.container, body); await click(button(dom.container, 'Send'))
  }
  await vi.waitFor(async () => {
    const timeline = (await f.client.sessionTimeline('original-agent')).items
    expect(timeline.find(item => item.content === body)).toMatchObject({ authorHuman: true, publicContent: 'confirmed' })
  }, { timeout: 10_000 })
  const input = (await f.client.sessionTimeline('original-agent')).items.find(item => item.content === body)!
  const progress = 'Original Agent progress', final = 'Original Agent final answer'
  await appendFile(transcript, nativeRow('current-progress', progress, 'commentary') + nativeRow('current-final', final, 'final_answer'))
  services.publication!.refresh()
  await vi.waitFor(() => {
    const cards = nativeCards()
    for (const value of [body, progress, final]) {
      expect(cards.feishu.filter(card => feishuText(card).includes(value))).toHaveLength(1)
      expect(cards.discord.filter(card => discordText(card).includes(value))).toHaveLength(1)
    }
  }, { timeout: 10_000 }).catch(async error => {
    if (payloadOutput) {
      const bindings = (await services.connections.bindings!.list({})).bindings
      await writeFile(payloadOutput + '.' + surface + '.failure.json', JSON.stringify({ cards: nativeCards(), timeline: await f.client.sessionTimeline('original-agent'),
        bindings, operations: bindings.map(binding => services.publication!.store.list(binding)) }, null, 2))
    }
    throw error
  })
  const cards = nativeCards(), userF = cards.feishu.find(card => feishuText(card).includes(body))!, userD = cards.discord.find(card => discordText(card).includes(body))!
  expect(userF.header).toEqual({ title: { tag: 'plain_text', content: 'User · via amux' }, template: 'green' })
  expect(userF.elements[0].text.content).toBe('Human user · via amux\n' + body)
  expect(userD.components[0].accent_color).toBe(0x2e8b57)
  expect(userD.components[0].components[0].content).toBe('**User · via amux**\nHuman user · via amux\n' + body)
  for (const [text, heading] of [[progress, 'Agent progress'], [final, 'Agent reply']]) {
    expect(cards.feishu.find(card => JSON.stringify(card).includes(text))!.header.title.content).toBe(heading)
    expect(cards.discord.find(card => JSON.stringify(card).includes(text))!.components[0].components[0].content).toBe('**' + heading + '**\n' + text)
  }
  const bindings = (await services.connections.bindings!.list({})).bindings
  for (const binding of bindings) {
    const original = services.publication!.store.list(binding).find(operation => operation.relay?.sources.some(source => source.part.record.source.kind === 'captured' && source.part.record.source.recordId === input.id))!
    expect(original).toBeDefined(); expect(original.relay!.sources[0]!.author).toEqual({ kind: 'human' })
  }
  expect(JSON.stringify(cards)).not.toContain('Earlier unshared reply')
  if (payloadOutput) await writeFile(payloadOutput + '.' + surface + '.json', JSON.stringify({ surface, cards }, null, 2) + '\n')
  expect(f.client.agentSession('original-agent').run).toEqual(originalRun)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 30_000)
