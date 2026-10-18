// @vitest-environment node
import { act } from 'react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
const browser = await vi.hoisted(async () => {
  const { Window } = await import('happy-dom')
  const window = new Window({ url: 'http://saved-input.test/' })
  for (const name of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Element', 'Node', 'Text', 'HTMLInputElement',
    'HTMLTextAreaElement', 'HTMLButtonElement', 'HTMLDivElement', 'HTMLImageElement', 'HTMLDetailsElement', 'Event', 'CustomEvent', 'MouseEvent',
    'KeyboardEvent', 'FocusEvent', 'PointerEvent', 'MutationObserver', 'ResizeObserver', 'DOMRect', 'Range', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia']) vi.stubGlobal(name, name === 'window' ? window : (window as unknown as Record<string, unknown>)[name])
  return window
})
import '../../mobile/test/device-locks'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '../../../packages/core/src/index.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { createWorkspaceLayout } from '../../../packages/core/src/spatial-layout.js'
import { createDesktopConnections } from '../src/main/connector-host.js'
import { createPublicationConversationPort } from '../../../packages/connectors/src/core-conversation-port.js'
import { composerDOM } from './helpers/composer-dom-fixture'
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
  let activeClient = f.client
  const coreClients = () => [{ hostId: 'local', client: activeClient }]
  const services = await createDesktopConnections({ directory: join(f.root, 'connections'), encryption: {
    isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async value => Buffer.from(value),
    decryptStringAsync: async value => ({ result: value.toString(), shouldReEncrypt: false })
  }, bindings: { spatial, checkpoint: input => activeClient.conversationCheckpoint(input) }, publication: createPublicationConversationPort(coreClients) })
  cleanup.push(() => services.close())
  for (const config of [feishuConfig, discordConfig]) {
    const secret = await services.secrets.store({ operationId: config.adapterId + '-secret', secret: 'controlled-private-' + config.adapterId })
    await services.connections.configure({ operationId: config.adapterId + '-configure', expectedRevision: null, connection: { ...config, credentialRef: secret.credentialRef } })
  }
  const bind = async () => {
    for (const config of [feishuConfig, discordConfig]) {
      const result = await services.connections.bindings!.bind({ operationId: config.adapterId + '-bind', bindingId: config.adapterId + '-binding',
        connectionId: config.connectionId, expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent',
        regionAnchor: { regionId: 'original-region' }, externalConversationId: config.adapterId === 'feishu' ? 'original-room' : '300', expectedSource: nativeSource,
        scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }, { actor: { kind: 'user', id: 'local-person' } })
      expect(result.state).toBe('applied')
    }
  }
  const nativeCards = () => ({
    feishu: feishu.messageCalls().filter(call => call.method === 'POST').map(call => JSON.parse(JSON.parse(call.body).content)),
    discord: discord.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages').map(call => JSON.parse(call.body))
  })
  return { f, services, transcript, nativeCards, feishu, discord, bind, replaceClient: (client: core.AgentMuxClient) => { activeClient = client } }
}

it('authenticated mounted Mobile saves waiting input into both native User cards and later updates the same original messages once', async () => {
  const { f, services, nativeCards, feishu, discord, bind } = await fixture(); await bind()
  const service = new AgentMuxHostedRuntimeService(f.client, null, () => hostedTestOwner(f.client)); cleanup.push(() => service.dispose())
  const device = { hostId: 'local', deviceId: 'original-mobile', name: 'Controlled Mobile' }
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'waiting-mobile.sock'), coreClients: f.coreClients,
    hostedRuntime: () => service, operationSource: context => context.principal?.id === device.deviceId ? device : undefined,
    http: { host: '127.0.0.1', port: 0, authorize: request => request.headers.get('authorization') === 'Bearer controlled-device'
      ? { principal: { kind: 'device', id: device.deviceId }, assertCurrent() {} } : null } })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'http', url: `http://127.0.0.1:${server.httpAddress!.port}/`, token: 'controlled-device' } })
  cleanup.push(() => rpc.dispose())
  const client = await connectHostedAgentMux({ rpc }); cleanup.push(() => client.dispose())
  await dom.render(<MobileConversationSurface client={client} agentSessionId="original-agent" connection={{ state: 'connected', message: 'Authenticated original Host' }} platform={createBrowserPlatform()} onShowTerminal={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelector('[contenteditable="true"]')).not.toBeNull())
  f.inner.connected = false; f.inner.kernel.isConnected = () => false
  const body = 'Waiting original Mobile user 中文🙂'
  await paste(dom.container, body); await click(button(dom.container, 'Send'))
  let mailbox = await client.readAgentInputMailbox({ agentSessionId: 'original-agent' })
  await vi.waitFor(async () => { mailbox = await client.readAgentInputMailbox({ agentSessionId: 'original-agent' }); expect(mailbox.items).toHaveLength(1) }, { timeout: 10_000 })
  const entry = mailbox.items[0]!
  if (entry.kind !== 'item' || entry.item.kind !== 'controlled' || !entry.item.receipt) throw Error('The original trusted input was not saved')
  const receipt = entry.item.receipt
  expect(receipt.status).toBe('waiting'); expect(entry.item.intent.source).toMatchObject({ authorHuman: true, prompt: body })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(dom.container.querySelector('.conversation-submission-summary')?.textContent).toContain('已保存 · 等待 Agent'), { timeout: 10_000 })
  expect(dom.container.querySelectorAll('[data-submission-id]')).toHaveLength(1)
  expect(dom.container.querySelector('.conversation-submission-summary')?.textContent).not.toContain('提交未确认')
  const waitingPage = await client.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent' })
  await vi.waitFor(async () => {
    const cards = nativeCards(), bound = (await services.connections.bindings!.list({})).bindings
    const diagnosis = JSON.stringify(bound.map(binding => ({cut: binding.sourceFrontier, operations: services.publication!.store.list(binding), coverage: services.publication!.store.coverage(binding)})))
    expect(cards.feishu.filter(card => feishuText(card).includes(body)), diagnosis).toHaveLength(1)
    expect(cards.discord.filter(card => discordText(card).includes(body))).toHaveLength(1)
  }, { timeout: 10_000 })
  const bindings = (await services.connections.bindings!.list({})).bindings
  const originals = bindings.map(binding => services.publication!.store.list(binding).find(operation => operation.payload.kind === 'speech' && operation.payload.text.includes(body))!)
  for (const original of originals) {
    expect(original.state).toBe('confirmed'); expect(original.payload).toMatchObject({ inputSubmission: { status: 'waiting' } })
    expect(original.relay!.sources[0]!.author).toEqual({ kind: 'human' }); expect(original.mapping?.messageId).toBeTruthy()
  }
  await client.stopAgentInputWaiting({ ref: receipt.ref, cancelOperationId: 'explicit-stop-before-resume' })
  f.inner.connected = true; f.inner.kernel.isConnected = () => true
  let failReceipt = true, failedReceipt = 0
  const apply = f.store.applyTimelineMutation.bind(f.store)
  vi.spyOn(f.store, 'applyTimelineMutation').mockImplementation(async mutation => {
    if (failReceipt && mutation.type !== 'update' && mutation.item.inputSubmission?.status === 'terminal-confirmed') {
      failedReceipt++; throw new Error('Controlled original input receipt projection is temporarily unavailable')
    }
    return await apply(mutation)
  })
  cleanup.push(f.client.onEvent(event => { if (event.type === 'agent-error' && event.code === 'AGENT_INPUT_CONVERSATION_UNCONFIRMED') failReceipt = false }))
  await client.rejoinAgentInputWaiting({ ref: receipt.ref })
  await vi.waitFor(async () => expect((await client.inspectAgentInput({ key: receipt.key }))?.status).toBe('terminal-confirmed'))
  await vi.waitFor(() => {
    expect(failedReceipt).toBeGreaterThan(0)
    for (let i = 0; i < bindings.length; i++) {
      const operations = services.publication!.store.list(bindings[i]!).filter(operation => operation.payload.kind === 'speech' && operation.payload.text.includes(body))
      const latest = operations.at(-1)!
      expect(latest.payload).toMatchObject({ inputSubmission: { status: 'terminal-confirmed', observation: 'closed' } })
      expect(latest.state).toBe('confirmed'); expect(latest.projectionId).toBe(originals[i]!.projectionId)
      expect(latest.mapping).toEqual(originals[i]!.mapping)
    }
  }, { timeout: 10_000 })
  expect(feishu.messageCalls().filter(call => call.method === 'POST' && call.body.includes(body))).toHaveLength(1)
  expect(discord.calls.filter(call => call.method === 'POST' && call.body.includes(body))).toHaveLength(1)
  expect(feishu.messageCalls().some(call => call.method === 'PATCH' && call.body.includes(body))).toBe(true)
  expect(discord.calls.some(call => call.method === 'PATCH' && call.body.includes(body))).toBe(true)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  const read = await client.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent' })
  const userRecords = read.items.flatMap(value => value.kind === 'item' ? value.item.records : []).filter(record => record.original.kind === 'captured' && record.original.item.kind === 'user_message')
  expect(userRecords).toHaveLength(1)
  await vi.waitFor(() => expect(dom.container.querySelector('.conversation-submission-summary')?.textContent).toContain('已送入终端 · Agent 接收未确认'), { timeout: 10_000 })
  if (process.env.SAVED_INPUT_SCENE_DIRECTORY) {
    await mkdir(process.env.SAVED_INPUT_SCENE_DIRECTORY, { recursive: true })
    await writeFile(join(process.env.SAVED_INPUT_SCENE_DIRECTORY, 'waiting-scene.json'), JSON.stringify(waitingPage, null, 2))
    await writeFile(join(process.env.SAVED_INPUT_SCENE_DIRECTORY, 'terminal-scene.json'), JSON.stringify(read, null, 2))
  }
  expect(JSON.stringify(nativeCards())).not.toContain('Earlier unshared reply')
}, 30_000)

it('a journal-first crash followed by a later native binding cut never publishes the older input on its first capture or resume', async () => {
  const { f, services, nativeCards, bind, replaceClient } = await fixture()
  f.inner.connected = false; f.inner.kernel.isConnected = () => false
  const failedCapture = vi.spyOn(f.store, 'applyTimelineMutation').mockRejectedValue(new Error('Capture unavailable before crash'))
  const body = 'Saved before the later audience cut'
  const saved = await f.client.submitAgentPrompt({ agentSessionId: 'original-agent', expectedRun: f.client.agentSession('original-agent').run,
    operationId: 'pre-cut-original', prompt: body, authorHuman: true, admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' }) as core.AgentInputSubmissionReceipt
  await f.client.dispose(); failedCapture.mockRestore()
  const store = new core.AgentMuxFileAgentSessionStore(f.store.path), reader = new core.AgentMuxClient({ store }); cleanup.push(() => reader.dispose())
  replaceClient(reader)
  const stillUnavailable = vi.spyOn(store, 'applyTimelineMutation').mockRejectedValue(new Error('Capture remains unavailable at the later cut'))
  await bind(); stillUnavailable.mockRestore()
  const bindings = (await services.connections.bindings!.list({})).bindings
  expect(bindings).toHaveLength(2)
  for (const binding of bindings) expect(binding.sourceFrontier!.frontier.cuts.find(cut => cut.kind === 'captured')).toMatchObject({ sequence: 0, inputJournal: { sequence: expect.any(Number) } })
  await reader.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent' })
  await reader.stopAgentInputWaiting({ ref: saved.ref, cancelOperationId: 'stop-old-wait' })
  const inner = Reflect.get(reader, 'kernel')
  for (const method of ['status', 'input', 'identity', 'observeOutput', 'attach', 'detach', 'stop']) inner[method] = f.inner.kernel[method]
  inner.isConnected = () => true; Reflect.set(reader, 'connected', true)
  await Reflect.get(reader, 'registry').load('local')
  vi.spyOn(reader.providers.get('codex'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  await reader.rejoinAgentInputWaiting({ ref: saved.ref })
  await vi.waitFor(async () => expect((await reader.inspectAgentInput({ key: saved.key }))?.status).toBe('terminal-confirmed'), { timeout: 10_000 })
  await vi.waitFor(() => {
    services.publication!.refresh()
    for (const binding of bindings) expect(services.publication!.store.coverage(binding).gaps.some(gap => gap.reason === 'start-cut-unconfirmed')).toBe(true)
  }, { timeout: 10_000 })
  expect(nativeCards().feishu.filter(card => feishuText(card).includes(body))).toHaveLength(0)
  expect(nativeCards().discord.filter(card => discordText(card).includes(body))).toHaveLength(0)
  expect((await reader.readAgentInputMailbox({ agentSessionId: 'original-agent' })).items).toHaveLength(1)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)

