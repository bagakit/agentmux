import { request as httpRequest, type ClientRequest } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { expect, vi } from 'vitest'
import * as core from '../../../core/dist/index.js'
import { connectHostedAgentMux } from '../../../core/dist/hosted.js'
import { rpcOwnerFixture } from '../../../core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../core/test/helpers/object-cli-rpc.js'
import { createWorkspaceLayout } from '../../../core/src/spatial-layout.js'
import { createConnectionExternalInputAuthority } from '../../../../apps/host/src/external-input-authority.js'
import { startAgentMuxHost } from '../../../../apps/host/src/host.js'
import { createConnectionServices } from '../../src/connection-services.js'
import { createPublicationConversationPort } from '../../src/core-conversation-port.js'
import { createHostedIngressCorePort } from '../../src/core-ingress-port.js'
import type { PublicationSpeakerReader } from '../../src/publication-speaker.js'
import { feishuConfig, feishuSdkTransport } from './feishu.js'

/** Original Node Host/Hosted/Core Hook and default Desktop owners. Only Runtime and official SDK I/O are controlled. */
export async function permissionActionsFixture(initialCoreAvailable = true, speaker?: PublicationSpeakerReader) {
  const cleanup: Array<() => void | Promise<void>> = []
  const original = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'codex', executorId: 'codex', nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native', transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(() => original.close())
  const close = async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() }
  try {
    vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
    await writeFile(join(original.root, 'native.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'original-native', cwd: original.root, source: 'cli' } }) + '\n')
    const spatial = new core.AgentMuxSpatialStateStore(join(original.root, 'spatial.json'))
    await spatial.commit({ expectedRevision: 0, graph: {
      spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: original.root, projectId: 'project' }],
      zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: original.root, branch: null }],
      tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['original-region'] }],
      regions: [{ regionId: 'original-region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: original.root } }],
      bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
      tabLayouts: { tab: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {}
    } })
    const runtime = original.inner.kernel, socketPath = join(original.root, 'semantic.sock'), desktopSocketPath = join(original.root, 'desktop.sock')
    await original.client.dispose()
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local')
      for (const name of ['isConnected', 'status', 'identity', 'input', 'openInput', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = runtime[name]
      inner.connected = true
    })
    let services!: Awaited<ReturnType<typeof createConnectionServices>>
    const externalInputAuthority = createConnectionExternalInputAuthority({ executionHostId: 'local', ingress: async () => services.ingress! })
    const host = await startAgentMuxHost({ externalInputAuthority, store: original.store, socketPath, desktopSocketPath, mobileBuildDirectory: join(original.root, 'absent-assets') })
    cleanup.push(() => host.dispose())
    original.client = host.client; original.inner = host.client as unknown as typeof original.inner
    original.coreClients = () => [{ hostId: 'local', client: original.client }]
    await vi.waitFor(() => expect(original.inner.connected).toBe(true)); connect.mockRestore()
    const provider = original.client.providers.get('codex')
    provider.discoverNativeSession = async () => ({ handle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native', transcriptPath: join(original.root, 'native.jsonl') }, assertCurrent: async () => {} })
    provider.observeSessionStatus = async () => ({ dispose() {} })
    original.inner.kernel.status = vi.fn(async (id: string) => ({ ...original.run(id), pid: 123 }))
    const semantic = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => semantic.dispose())
    const hosted = await connectHostedAgentMux({ rpc: semantic }); cleanup.push(() => hosted.dispose())
    const clients = () => [{ hostId: 'local', client: hosted }]
    let coreAvailable = initialCoreAvailable
    const ingressCore = createHostedIngressCorePort(clients)
    const sdk = feishuSdkTransport(), effects: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
    let lastCard: Record<string, unknown> | undefined, failPatch = false
    const imageUploads: string[] = []
    const cards = new Map<string, Record<string, unknown>>()
    vi.spyOn(defaultHttpInstance, 'request').mockImplementation(async input => {
      const path = String(input.url), method = String(input.method ?? 'GET').toUpperCase()
      if (path.endsWith('/im/v1/images') && method === 'POST') { imageUploads.push(path); return { code: 0, data: { image_key: 'original-question-portrait' } } }
      if (path.includes('im/v1/messages')) {
        const inspectedId = path.split('/').at(-1)!, inspectedCard = cards.get(inspectedId)
        if (method === 'GET') return { code: 0, data: { items: inspectedCard && !failPatch ? [{ message_id: inspectedId, chat_id: 'original-room', msg_type: 'interactive', body: { content: JSON.stringify(inspectedCard) } }] : [] } }
        const transforms = Array.isArray(input.transformRequest) ? input.transformRequest : [input.transformRequest]
        const wire = transforms[0] as ((value: unknown) => string) | undefined
        const body = JSON.parse(wire ? wire(input.data) : JSON.stringify(input.data))
        const messageId = method === 'POST' ? 'original-card' + (cards.size ? '-' + (cards.size + 1) : '') : inspectedId
        effects.push({ method, path, body }); lastCard = JSON.parse(body.content); cards.set(messageId, lastCard!)
        if (method === 'PATCH' && failPatch) throw new Error('Controlled lost platform update receipt')
        return { code: 0, data: method === 'PATCH' ? {} : { message_id: messageId, chat_id: 'original-room', msg_type: body.msg_type, body: { content: body.msg_type === 'post' ? JSON.stringify(JSON.parse(body.content).zh_cn) : body.content } } }
      }
      if (path.endsWith('/members')) return { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: 'original-external-user', name: 'Ada' }], has_more: false } }
      if (path.endsWith('/chats') || path.endsWith('chats/search')) return { code: 0, data: { items: [{ chat_id: 'original-room', name: 'Design review', chat_status: 'normal' }], has_more: false } }
      if (path.includes('/chats/')) return { code: 0, data: { name: 'Design review', chat_status: 'normal', chat_mode: 'group' } }
      return sdk.request({ url: path })
    })
    services = await createConnectionServices({ directory: join(original.root, 'connectors'),
      bindings: { spatial, checkpoint: async ref => await hosted.conversationCheckpoint(ref) },
      publication: createPublicationConversationPort(clients), ...(speaker ? { speaker } : {}), ingress: { core: hostId => coreAvailable ? ingressCore(hostId) : undefined } })
    cleanup.push(() => services.close())
    const business = new core.AgentMuxControlServer({ socketPath: desktopSocketPath, connections: services.connections, spatialState: spatial, coreClients: original.coreClients })
    await business.start(); cleanup.push(() => business.stop())
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktopSocketPath } }); cleanup.push(() => rpc.dispose())
    const cli = async (args: string[], input?: unknown) => {
      const value = await runCompiledObjectCli(['--endpoint', 'unix:' + desktopSocketPath, ...args], objectCliEnvironment(original.root), input === undefined ? '' : JSON.stringify(input))
      expect(value.code, value.stdout + value.stderr).toBe(0); return JSON.parse(value.stdout).result
    }
    const credential = await services.secrets.store({ operationId: 'permission-credential', secret: 'fixture-credential' })
    await cli(['connection', 'configure', '--input', '-'], { operationId: 'permission-configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
    const bound = await cli(['connection', 'bind', '--input', '-'], { operationId: 'permission-bind', bindingId: 'original-binding', connectionId: feishuConfig.connectionId,
      expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' }, externalConversationId: 'original-room',
      expectedSource: { providerId: 'codex', nativeSessionId: 'original-native' }, scope: { input: 'all-messages', publication: 'future-shared-conversation' } })
    expect(bound.state).toBe('applied')
    services.publication!.refresh()
    await vi.waitFor(() => expect(services.publication!.store.list(bound.binding).some(value => value.payload.kind === 'binding-lifecycle' && value.state === 'confirmed')).toBe(true))
    effects.splice(0); lastCard = undefined
    const actor = { application: feishuConfig.application, idType: 'open_id' as const, userId: 'original-external-user' }
    const grant = async (capabilities: Array<'input' | 'answer' | 'permission'> = ['permission'], revision: number | null = null) => await cli(['connection', 'grant', '--input', '-'], {
      operationId: 'permission-grant-' + String(revision), grantId: 'original-member', bindingId: bound.binding.bindingId, expectedBindingRevision: 1, expectedRevision: revision, actor, capabilities, state: capabilities.length ? 'active' : 'revoked' })
    await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1))
    let request: ClientRequest | undefined
    const open = async (requestId = 'original-request', command = 'original command', kind: 'permission' | 'question' = 'permission') => {
      const server = Reflect.get(original.client, 'hookServer') as { start(): Promise<void>; createBinding(sid: string, provider: string): { bindRun(run: string): Promise<void>; endpoint: { url: string; token: string } } }
      await server.start()
      const hook = server.createBinding('original-agent', 'codex'); await hook.bindRun('run-original-agent')
      const callback = new Promise<unknown>((resolveBody, reject) => {
        request = httpRequest(hook.endpoint.url, { method: 'POST', headers: { authorization: 'Bearer ' + hook.endpoint.token } }, response => {
          let body = ''; response.setEncoding('utf8'); response.on('data', value => { body += value })
          response.once('error', reject); response.once('end', () => { try { expect(response.statusCode).toBe(200); resolveBody(JSON.parse(body)) } catch (error) { reject(error) } })
        }); request.once('error', reject)
        const eventName = kind === 'question' ? 'PreToolUse' : 'PermissionRequest'
        request.end(JSON.stringify({ receiptId: requestId, eventName, ...(kind === 'permission' ? { decision: true } : {}), payload: {
          hook_event_name: eventName, session_id: 'original-native', turn_id: 'original-turn',
          tool_name: kind === 'question' ? 'request_user_input' : 'Bash',
          tool_input: kind === 'question' ? { question: command, options: ['Keep the original work', 'Review first'] } : { command } } }))
      })
      void callback.catch(() => {})
      cleanup.push(async () => { request?.destroy(); await Promise.allSettled([callback]) })
      await vi.waitFor(() => expect(original.client.agentSession('original-agent').pendingInteraction?.request.id).toBe(requestId))
      return { request: original.client.agentSession('original-agent').pendingInteraction!.request, callback }
    }
    const action = (actionRef: string, eventId = 'original-action-event', overrides: Record<string, unknown> = {}) => ({ schema: '2.0', header: { app_id: feishuConfig.application.appId, event_id: eventId, event_type: 'card.action.trigger' },
      event: { operator: { open_id: actor.userId }, context: { open_chat_id: 'original-room', open_message_id: services.publication!.store.list(bound.binding).find(value => value.state === 'confirmed' && value.payload.kind === 'permission' && value.payload.options.some(option => option.actionRef === actionRef))?.mapping?.messageId ?? 'original-card' }, action: { tag: 'button', value: { actionRef }, form_value: { arbitrary: 'never becomes a response' } }, ...overrides } })
    const buttons = () => (lastCard?.elements as Array<{ actions?: Array<{ text: { content: string }; value: { actionRef: string } }> }> | undefined)?.flatMap(element => element.actions ?? []).filter(button => button.value?.actionRef) ?? []
    const tracedClose = async () => {
      const directory = resolve('.bagakit/feature-tracker/features/f-2wr8fmvnv/artifacts/permission-actions/consumer-traces')
      await mkdir(directory, { recursive: true })
      const name = expect.getState().currentTestName ?? 'original-permission-consumer'
      const intake = await services.ingress!.list({ connectionId: feishuConfig.connectionId })
      const receipts = await Promise.all(intake.ingresses.map(record => services.ingress!.inspect({ ingressId: record.ingressId })))
      await writeFile(join(directory, createHash('sha256').update(name).digest('hex').slice(0, 16) + '.json'), JSON.stringify({ name,
        boundary: 'Original default Desktop, Node Host helper, protected Hosted, Core Hook HTTP and official SDK dispatcher; Runtime and SDK HTTP/WS I/O controlled. No live tenant or Native adoption claim.',
        sdkAcks: sdk.ack(), effects, receipts, originalRun: original.client.agentSession('original-agent').run,
        lifecycleCalls: { stop: vi.mocked(original.inner.kernel.stop as () => void).mock.calls.length, input: vi.mocked(original.inner.kernel.input as () => void).mock.calls.length }
      }, null, 2) + '\n')
      await close()
    }
    return { original, host, hosted, services, rpc, cli, sdk, effects, imageUploads, grant, open, action, buttons, actor, binding: bound.binding,
      setCoreAvailable: (value: boolean) => { coreAvailable = value },
      disablePermissionSupport: () => { Reflect.deleteProperty(Reflect.get(services.publication!, 'options').connections.publicationAdapter(feishuConfig.connectionId), 'permissionActions') },
      card: (messageId?: string) => messageId ? cards.get(messageId) : lastCard, setFailPatch: (value: boolean) => { failPatch = value }, close: tracedClose }
  } catch (error) { await close(); throw error }
}
