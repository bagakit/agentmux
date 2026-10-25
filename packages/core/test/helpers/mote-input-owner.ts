import { expect, vi } from 'vitest'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient, type AgentMuxClientOptions } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { AgentMuxSpatialStateStore, type AgentMuxSpatialGraph } from '../../src/spatial-state.js'
import { createWorkspaceLayout } from '../../src/spatial-layout.js'
import { AgentMuxControlServer } from '../../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../src/public-rpc-client.js'
import { nativeInputCorrelationKey, createNativeInputCorrelation } from '../../src/native-input-correlation.js'
import { moteInputObservationId, type AgentInputMoteResolver } from '../../src/mote-input.js'
import { DurableAgentMuxMessageQueue } from '../../src/agent-global-message-queue.js'
import type { MoteInputOwner } from '../../src/mote-input-owner.js'
import { createHostMoteInputSource } from '../../../../apps/host/src/mote-input-source.js'
import { createHostContent } from '../../../../apps/host/src/content-owner.js'
import { homeZoneId, serializeMoteQuickMode, scratchTopicDirectoryName } from '../../../../apps/host/src/mote-model.js'
import { rpcOwnerFixture } from './public-rpc-owner.js'
import { runSourceObjectCli } from './source-object-cli.js'
import { objectCliEnvironment } from './object-cli-rpc.js'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../../src/hosted-client.js'
import { hostedTestOwner } from './hosted-runtime-port.js'

export const moteInputTestSource = {
  spaceId: 'mote-original',
  zoneId: homeZoneId('mote-original'),
  tabId: 'tab-member',
  regionId: 'region-member'
}
const source = moteInputTestSource
let resolveSource: AgentInputMoteResolver
export function setMoteInputTestResolver(value: AgentInputMoteResolver) {
  resolveSource = value
}
class MoteClient extends AgentMuxClient {
  constructor(options: AgentMuxClientOptions) {
    super({ ...options, moteInputResolver: (input) => resolveSource(input) })
  }
}
export const moteInputTestOwnerModule = { AgentMuxClient: MoteClient, AgentMuxFileAgentSessionStore }
const jsonl = (rows: unknown[]) => rows.map((value) => JSON.stringify(value)).join('\n') + '\n'

export async function createMoteInputFixture() {
  const cleanup: Array<() => Promise<unknown>> = []
  const f = await rpcOwnerFixture(['member', 'primary', 'stranger'], moteInputTestOwnerModule)
  cleanup.push(f.close)
  const errors: unknown[] = []
  f.client.onEvent((event) => {
    if (event.type === 'agent-error') errors.push(event)
  })
  const scratch = join(f.root, 'scratch'),
    directory = join(scratch, scratchTopicDirectoryName('AbCdEfGh1234'))
  await mkdir(directory, { recursive: true })
  const configurationPath = join(f.root, 'configuration.json')
  await writeFile(
    configurationPath,
    JSON.stringify({ workspaces: [{ id: '__scratch__', hostId: 'local', path: scratch }] })
  )
  const preferences = () =>
    serializeMoteQuickMode('', {
      conversation: {
        hostId: 'local',
        sessionId: 'primary',
        displayWorkspaceId: '__scratch__',
        groupId: 'group',
        tabId: 'tab-primary',
        regionId: 'region-primary'
      }
    })
  const motePath = join(directory, 'MOTE.md')
  await writeFile(motePath, preferences())
  const graph: AgentMuxSpatialGraph = {
    spaces: [
      {
        spaceId: source.spaceId,
        kind: 'mote',
        topicId: 'AbCdEfGh1234',
        name: 'Original',
        hostId: 'local',
        directoryPath: directory,
        projectId: null
      }
    ],
    zones: [
      {
        zoneId: source.zoneId,
        kind: 'home',
        workspaceId: '__scratch__',
        hostId: 'local',
        directoryPath: directory,
        branch: null
      }
    ],
    bindings: [{ spaceId: source.spaceId, zoneId: source.zoneId }],
    tabs: ['member', 'primary'].map((id) => ({
      tabId: 'tab-' + id,
      zoneId: source.zoneId,
      workspaceId: '__scratch__',
      name: null,
      regionIds: ['region-' + id]
    })),
    regions: ['member', 'primary'].map((id) => ({
      tabId: 'tab-' + id,
      regionId: 'region-' + id,
      kind: 'agent',
      agentSessionId: id,
      runId: 'run-' + id,
      execution: { hostId: 'local', cwd: f.root }
    })),
    layouts: { __scratch__: createWorkspaceLayout('group', ['tab-member', 'tab-primary']) },
    tabLayouts: Object.fromEntries(
      ['member', 'primary'].map((id) => [
        'tab-' + id,
        { root: { type: 'leaf', regionId: 'region-' + id }, activeRegionId: 'region-' + id }
      ])
    ),
    resources: { 'tab-member': { draft: 'unchanged' } }
  }
  const spatial = new AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph })
  const content = createHostContent({ configurationPath, spatial })
  resolveSource = createHostMoteInputSource({ configurationPath, spatial, files: content.files! })
  expect(await resolveSource({ source, agentSessionId: 'member' })).toMatchObject({
    primary: { agentSessionId: 'primary' }
  })
  const transcript = join(f.root, 'member.jsonl'),
    header = jsonl([{ type: 'session_meta', payload: { id: 'member-native', cwd: f.root, history_mode: 'paginated' } }])
  await writeFile(transcript, header)
  for (const id of ['member', 'primary']) {
    const old = (await f.store.readMetadata(id))!
    await f.store.compareAndSwapMetadata(old, {
      ...old,
      nativeHandle: {
        kind: 'provider',
        providerId: 'codex',
        sessionId: id + '-native',
        ...(id === 'member' ? { transcriptPath: transcript } : {})
      }
    })
  }
  await f.inner.registry.load('local')
  f.inner.kernel.status = vi.fn(async (id) => ({ ...f.run(id), pid: 1234 }))
  const provider = f.client.providers.get('codex'),
    { discoverNativeSession: _d, observeSessionStatus: _s, ...rest } = provider
  vi.spyOn(
    f.client as unknown as { probePreparedAgent: typeof f.client.probeAgent },
    'probePreparedAgent'
  ).mockResolvedValue({
    providerId: 'codex',
    executable: 'codex',
    installed: true,
    capabilities: provider.catalog.capabilities
  })
  let primaryIdle = false,
    unknownNotice = false
  const writes: Array<{
    key: ReturnType<typeof nativeInputCorrelationKey>
    wire: string
    thread: string
    correlation: string
  }> = []
  f.client.providers.replace({
    ...rest,
    readPromptExecutionEvidence: async (context) => ({
      state:
        context.nativeHandle?.kind === 'provider' && context.nativeHandle.sessionId === 'primary-native' && !primaryIdle
          ? 'working'
          : 'idle',
      sourceId: 'native-' + context.nativeHandle?.sessionId,
      id: 'idle-1'
    }),
    prepareNativeInput: async (_context, target) => ({
      plan: {
        kind: 'native-rpc',
        protocolId: 'fixture-protocol',
        sourceId: JSON.stringify([target.providerId, target.nativeSessionId]),
        threadId: target.nativeSessionId,
        actorId: 'fixture-actor',
        operation: target.idleOnly ? 'queue-idle' : 'start-or-steer'
      },
      assertCurrent: async () => {},
      dispose: async () => {},
      send: async (wire, plan) => {
        const key = nativeInputCorrelationKey(plan.clientCorrelation!)
        writes.push({ key, wire, thread: plan.threadId, correlation: plan.clientCorrelation! })
        if (unknownNotice && key?.agentSessionId === 'primary') throw Error('Native notice ACK unavailable')
        return plan.operation === 'queue-idle'
          ? {
              outcome: 'admitted',
              queuedSubmissionId: 'queued-' + (key?.kind === 'prompt' ? key.submissionId : 'other')
            }
          : { outcome: 'admitted', turnId: 'turn-' + (key?.kind === 'prompt' ? key.submissionId : 'other') }
      }
    })
  })
  const queue = Reflect.get(f.client, 'messageQueue') as DurableAgentMuxMessageQueue,
    observer = Reflect.get(f.client, 'moteInputs') as MoteInputOwner
  const server = new AgentMuxControlServer({
    socketPath: join(f.root, 'mote.sock'),
    coreClients: f.coreClients,
    hostedRuntime: () => new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client))
  })
  await server.start()
  cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanup.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false })
  cleanup.push(() => hosted.dispose())
  // The visible member already consumes its history; initialize that original read owner before timing input.
  await f.client.conversationCheckpoint({ hostId: 'local', agentSessionId: 'member' })
  const submit = async (id: string, extra: Record<string, unknown> = {}) =>
    await hosted.submitAgentPrompt({
      agentSessionId: 'member',
      operationId: id,
      prompt: 'Human original ' + id,
      expectedRun: { runId: 'run-member' },
      admissionIntent: {
        kind: 'native-conversation',
        source: { providerId: 'codex', nativeSessionId: 'member-native' }
      },
      execution: 'immediate',
      authorHuman: true,
      moteSource: source,
      ...extra
    } as Parameters<typeof f.client.submitAgentPrompt>[0])
  const key = (id: string) => ({
    kind: 'prompt' as const,
    agentSessionId: 'member',
    expectedRun: { runId: 'run-member' },
    submissionId: id
  })
  const observation = (id: string) => moteInputObservationId({ kind: 'prompt', key: key(id) })
  const read = (id: string) =>
    rpc.call('agent.input.observation', { agentSessionId: 'member', observationId: observation(id) })
  const idle = () => {
    primaryIdle = true
    observer.changed('primary')
  }
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      const jobs = Reflect.get(observer, 'jobs') as Map<string, { promise: Promise<void> }>
      if (!jobs.size) return
      await Promise.all([...jobs.values()].map((value) => value.promise))
    }
  }
  const append = async (id: string, qualified = true, padding = 0) => {
    const keyValue = key(id),
      turn = 'turn-' + id
    await appendFile(
      transcript,
      jsonl([
        {
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            thread_id: 'member-native',
            turn_id: turn,
            item: {
              type: 'UserMessage',
              id: 'user-' + id,
              client_id: qualified
                ? writes.find((value) => value.key?.kind === 'prompt' && value.key.submissionId === id)!.correlation
                : createNativeInputCorrelation({ ...keyValue, submissionId: 'unrelated' }),
              content: [{ type: 'text', text: 'Human original ' + id }]
            }
          }
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            id: 'assistant-' + id,
            content: [{ type: 'output_text', text: 'Original result ' + id }],
            internal_chat_message_metadata_passthrough: { turn_id: turn }
          }
        },
        {
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: turn, ...(padding ? { diagnostic: 'x'.repeat(padding) } : {}) }
        }
      ])
    )
    observer.changed('member')
    await settle()
  }
  const cli = async (id: string) => {
    const result = await runSourceObjectCli(
      [
        '--endpoint',
        'unix://' + server.path,
        'agent',
        'input',
        'observation',
        '--session',
        'member',
        '--id',
        observation(id)
      ],
      objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: 'primary', AGENTMUX_AGENT_CAPABILITY: f.capability }),
      '',
      20_000,
      new URL('../fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url)
    )
    expect(result.code, result.stderr + result.stdout).toBe(0)
    return JSON.parse(result.stdout).result
  }
  return {
    ...f,
    errors,
    queue,
    observer,
    spatial,
    graph,
    motePath,
    transcript,
    writes,
    server,
    rpc,
    hosted,
    submit,
    key,
    observation,
    read,
    idle,
    append,
    cli,
    settle,
    loseNotice: () => {
      unknownNotice = true
    },
    close: async () => {
      for (const close of cleanup.reverse()) await close()
    }
  }
}
