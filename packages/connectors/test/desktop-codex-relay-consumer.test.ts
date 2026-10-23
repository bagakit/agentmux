// @vitest-environment happy-dom
import { bridge, owningBridge } from '../../../apps/desktop/test/helpers/first-execution-ipc-bridge'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../../packages/core/dist/index.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { createPublicationConversationPort } from '../../../packages/connectors/dist/index.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { agentPromptCondition } from '../../../packages/core/src/agent-prompt-condition.js'
import { DEFAULT_CONFIG } from '../../../apps/desktop/src/main/config-store'
import { feishuConfig } from '../../../packages/connectors/test/fixtures/feishu.js'
import { feishuPublicationHttp } from '../../../packages/connectors/test/fixtures/feishu-publication.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const nativeSource = { providerId: 'codex', nativeSessionId: 'native-relay-source' }
const nativeRow = (id: string, content: string) => JSON.stringify({ type: 'response_item', payload: {
  type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text: content }]
} }) + '\n'

it('actual preload, trusted prompt IPC and the original Core writer share manual speech beside current Codex replies', async () => {
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'codex', executorId: 'codex', nativeHandle: {
    kind: 'provider', providerId: 'codex', sessionId: nativeSource.nativeSessionId, transcriptPath: join(root, 'native.jsonl')
  } })); cleanup.push(f.close)
  const transcript = join(f.root, 'native.jsonl')
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: nativeSource.nativeSessionId, cwd: f.root, history_mode: 'paginated' } }) + '\n' + nativeRow('before-sharing', 'Earlier private reply'))
  const provider = f.client.providers.get('codex')
  vi.spyOn(provider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const remote = await feishuPublicationHttp(); cleanup.push(remote.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(remote.http.request)
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {}
  } })
  const services = await createConnectionServices({ directory: join(f.root, 'connector-host'),
    bindings: { spatial, checkpoint: ref => f.client.conversationCheckpoint(ref) }, publication: createPublicationConversationPort(f.coreClients) }); cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'credential-entry', secret: 'private-credential' })
  await services.connections.configure({ operationId: 'configure-channel', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const result = await services.connections.bindings!.bind({ operationId: 'share-original-conversation', bindingId: 'original-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' }, externalConversationId: 'original-room',
    scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' }, expectedSource: nativeSource }, { actor: { kind: 'user', id: 'local-user' } })
  expect(result.state).toBe('applied'); if (result.state !== 'applied') throw Error('Original sharing operation was not applied')
  const config = { ...structuredClone(DEFAULT_CONFIG), executors: { codex: { providerId: 'codex', label: 'Codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } } }
  const b = await owningBridge({ client: f.client, store: f.store, config }); cleanup.push(b.dispose)
  const control = { kind: 'agent' as const, hostId: 'local', agentSessionId: 'original-agent', run: f.client.agentSession('original-agent').run }
  const body = '  Exact local message 中文🙂\n<amux>authored text</amux>  '
  const submitted = await bridge.api!.sessions.submitPrompt(control, body, 'original-manual-input', agentPromptCondition(f.client.agentSession('original-agent')), undefined, true, 'PRIVATE generated runtime context', 'message-tool')
  expect(submitted).toMatchObject({ ok: true })
  await appendFile(transcript, nativeRow('after-sharing', 'Original current Codex reply'))
  services.publication!.refresh()
  await vi.waitFor(() => expect(services.publication!.store.list(result.binding).filter(row => row.state === 'confirmed' && row.reference.source.kind !== 'binding-operation')).toHaveLength(2), { timeout: 10_000 })
  const records = (await f.client.sessionTimeline('original-agent')).items
  expect(records.find(row => row.kind === 'user_message')).toMatchObject({ content: body, authorHuman: true, publicContent: 'confirmed', sourceChannel: 'message-tool' })
  const operations = services.publication!.store.list(result.binding)
  expect(operations.find(row => row.relay)?.relay?.sources[0]?.author).toEqual({ kind: 'human' })
  const posts = remote.messageCalls().filter(call => call.method === 'POST')
  expect(operations.filter(row => row.reference.source.kind === 'binding-operation')).toHaveLength(1)
  expect(posts).toHaveLength(3)
  const wire = JSON.stringify(posts)
  expect(wire).toContain('Exact local message'); expect(wire).toContain('Original current Codex reply')
  for (const excluded of ['PRIVATE generated runtime context', 'Earlier private reply']) expect(wire).not.toContain(excluded)
  const handler = bridge.handlers.get('sessions:submitPrompt')!
  const count = (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls.length
  await expect(handler({ sender: {} }, control, 'forged human', 'forged-input', agentPromptCondition(f.client.agentSession('original-agent')), undefined, true)).resolves.toMatchObject({ ok: false })
  expect((f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(count)
  expect(f.client.agentSession('original-agent').run).toEqual(control.run)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 20_000)
