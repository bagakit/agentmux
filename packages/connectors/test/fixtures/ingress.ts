import { vi, expect } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import * as core from '../../../core/dist/index.js'
import { rpcOwnerFixture } from '../../../core/test/helpers/public-rpc-owner.js'
import { DurableIngressHost, ConnectionHost, RoomBindingHost, type VerifiedIngressEvent } from '../../dist/index.js'
import { createWorkspaceLayout } from '../../../core/src/spatial-layout.js'
import { config, context } from './room-binding.js'

/** One compiled Core/Store/Provider and original binding. Runtime byte I/O uses the existing deterministic port. */
export async function ingressFixture(running = false) {
  const h = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'ingress-native', transcriptPath: join(root, 'native.jsonl') } }))
  const transcript = join(h.root, 'native.jsonl')
  await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: 'ingress-native', uuid: 'native-before-binding', message: { role: 'user', content: 'Existing original work' } }) + '\n')
  if (!running) { h.inner.connected = false; h.inner.kernel.isConnected = () => false }
  else {
    // Controlled Provider transport plan: this fixture proves Core/journal consumption, not a live TUI render ACK.
    const provider = (h.client as unknown as { providers: { get(id: string): { planPromptInput(text: string): unknown } } }).providers.get('claude')
    vi.spyOn(provider, 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  }
  const spatial = new core.AgentMuxSpatialStateStore(join(h.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: h.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: h.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: h.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {}
  } })
  const connections = new ConnectionHost({ databasePath: join(h.root, 'connections.sqlite'), secrets: { resolve: async () => null } })
  await connections.configure({ operationId: 'configure-ingress', expectedRevision: null, connection: config })
  const bindings = new RoomBindingHost({ connections, spatial, checkpoint: async ref => ({ ...ref, checkpoint: await h.client.conversationCheckpoint(ref.agentSessionId) }) }); connections.bindings = bindings
  const input = { operationId: 'bind-ingress', bindingId: 'original-binding', connectionId: config.connectionId, expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'original-region' }, externalConversationId: 'original-room', scope: { input: 'mentions-and-replies' as const, publication: 'future-native-user-facing' as const }, expectedSource: { providerId: 'claude', nativeSessionId: 'ingress-native' } }
  expect(await bindings.bind(input, context)).toMatchObject({ state: 'applied' })
  const actor = { application: config.application, idType: 'open_id', userId: 'original-external-user' }
  const grant = { operationId: 'grant-ingress', bindingId: input.bindingId, expectedBindingRevision: 1, grantId: 'original-grant', expectedRevision: null, actor, capabilities: ['input' as const], state: 'active' as const }
  expect(await bindings.grant(grant, context)).toMatchObject({ state: 'applied' })
  const verifier = vi.fn(async (_config, raw: string): Promise<VerifiedIngressEvent> => {
    const parsed = JSON.parse(raw)
    if (parsed.proof !== 'adapter-private-witness') throw new Error('Unverified transport')
    return parsed.event
  })
  const options = { connections, bindings, authenticators: [{ adapterId: 'sample', verify: verifier }], core: (hostId: string) => hostId === 'local' ? h.client : undefined }
  const ingress = new DurableIngressHost(options); connections.ingress = ingress
  const event = (override: Partial<VerifiedIngressEvent> = {}) => ({ eventId: 'original-event', messageId: 'original-message', externalConversationId: input.externalConversationId, actor, body: 'Original external body\nEvery line is retained.', selection: 'mention' as const, ...override })
  const receive = (override: Partial<VerifiedIngressEvent> = {}, ack = vi.fn()) => ingress.receive({ connectionId: config.connectionId, raw: JSON.stringify({ proof: 'adapter-private-witness', event: event(override), opaqueOriginal: { complete: 'preserved payload' } }) }, ack)
  return { ...h, connections, bindings, spatial, input, session: h.client.agentSession('original-agent'), actor, grant, ingress, options, event, receive, verifier, transcript,
    databasePath: join(h.root, 'connections.sqlite'),
    async close() { connections.close(); await h.close() } }
}
