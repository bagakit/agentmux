import { appendFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import * as core from '../../core/src/index.js'
import { NativeJsonlHistoryReader } from '../../core/src/native-jsonl-history-reader.js'
import { jsonl, nativeHistoryFixture } from '../../core/test/fixtures/native-history-session.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { agentPromptCondition } from '../../core/src/agent-prompt-condition.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createBuiltinConnectionAdapters } from '../src/index.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'

// Only the selected real file's observed mount device number changes. The file,
// native protocol, offsets, fingerprints, original cursors and readers stay real.
const mount = vi.hoisted(() => ({ path: '', generation: 0 }))
vi.mock('node:fs/promises', async originalImport => {
  const original = await originalImport<typeof import('node:fs/promises')>()
  const observed = <T extends { dev: number | bigint }>(value: T): T => {
    const dev = typeof value.dev === 'bigint' ? value.dev + BigInt(mount.generation) : value.dev + mount.generation
    return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { dev }) as T
  }
  return { ...original,
    stat: async (...args: Parameters<typeof original.stat>) => {
      const value = await original.stat(...args)
      return String(args[0]) === mount.path ? observed(value) : value
    },
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args)
      if (String(args[0]) === mount.path) {
        const readStat = handle.stat.bind(handle)
        Object.defineProperty(handle, 'stat', { value: async (...options: Parameters<typeof readStat>) => observed(await readStat(...options)) })
      }
      return handle
    }
  }
})

const cleanup: Array<() => unknown | Promise<unknown>> = [], facts: unknown[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  mount.path = ''; mount.generation = 0; vi.restoreAllMocks(); vi.unstubAllEnvs()
})
afterAll(async () => {
  if (process.env.AGENTMUX_TEST_NATIVE_DEVICE_FACTS) await writeFile(process.env.AGENTMUX_TEST_NATIVE_DEVICE_FACTS, JSON.stringify(facts, null, 2) + '\n')
})
type Provider = 'codex' | 'pi'
const header = (provider: Provider, cwd: string, id = 'native-main') => provider === 'codex'
  ? { type: 'session_meta', payload: { id, cwd } } : { type: 'session', version: 3, id, cwd }
const speech = (provider: Provider, id: string, parent: string | null, text = id, phase = 'final_answer') => provider === 'codex'
  ? { type: 'response_item', payload: { type: 'message', role: 'assistant', id, phase, content: [{ type: 'output_text', text }] } }
  : { type: 'message', id, parentId: parent, message: { role: 'assistant', content: [{ type: 'text', text }] } }
const decode = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { dev: number; ino: number; birth: number; offset: number }
const texts = (items: core.AgentSessionHistoryItem[]) => items.flatMap(item => item.contentParts.flatMap(part => part.kind === 'text' ? [part.text] : []))

for (const provider of ['codex', 'pi'] as const) it(`${provider}: original native changes survive device renumbering through replacement Client, RPC and compiled CLI`, async () => {
  const f = await nativeHistoryFixture(provider, root => jsonl([header(provider, root), speech(provider, 'before', null)])); cleanup.push(f.close)
  mount.path = f.path
  let client = f.client
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, metadata = await f.store.loadMetadata()
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'device.sock'), coreClients: () => [{ hostId: ref.hostId, client }] })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const original = await rpc.call('agent.conversation.checkpoint', ref)
  const originalBytes = JSON.stringify(original.checkpoint), native = original.checkpoint.frontier.cuts.find(cut => cut.kind === 'native')!
  if (native.kind !== 'native') throw Error('The genuine original native cut is required')
  const fileBefore = await stat(f.path), cursorBefore = decode(native.checkpoint.cursor)
  expect(cursorBefore.dev).toBe(fileBefore.dev)
  await client.dispose()
  mount.generation = 7
  client = new core.AgentMuxClient({ store: f.store }); cleanup.push(() => client.dispose())
  const kernel = Reflect.get(client, 'kernel'), controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name))
  await appendFile(f.path, jsonl([speech(provider, 'progress', 'before', 'Original progress', 'commentary'), speech(provider, 'reply', 'progress', 'Original reply')]))
  const continued = await client.readSessionHistoryChanges(ref.agentSessionId, { checkpoint: native.checkpoint })
  expect(continued.items.map(item => item.id)).toEqual(['progress', 'reply'])
  expect(texts(continued.items)).toEqual(['Original progress', 'Original reply'])
  if (provider === 'codex') expect(continued.items.map(item => item.messagePhase)).toEqual(['progress', 'final'])
  const fileAfter = await stat(f.path), cursorAfter = decode(continued.checkpoint.cursor)
  expect(fileAfter.dev).toBe(fileBefore.dev + 7)
  expect([fileAfter.ino, fileAfter.birthtimeMs]).toEqual([fileBefore.ino, fileBefore.birthtimeMs])
  expect(cursorAfter).toMatchObject({ dev: cursorBefore.dev + 7, ino: cursorBefore.ino, birth: cursorBefore.birth })
  expect(cursorAfter.offset).toBeGreaterThan(cursorBefore.offset)
  const input = { ...ref, checkpoint: original.checkpoint, limit: 30 }, page = await rpc.call('agent.conversation.changes', input)
  expect(page.coverage.find(value => value.source.kind === 'native')).toMatchObject({ current: 'complete-through-cut', gaps: [] })
  expect(page.items.length).toBeGreaterThan(0)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'agent', 'conversation', 'changes', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(input))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  const cliPage = JSON.parse(cli.stdout).result
  expect(cliPage.items).toEqual(page.items); expect(cliPage.checkpoint).toEqual(page.checkpoint)
  expect(JSON.stringify(original.checkpoint)).toBe(originalBytes)
  expect(await f.store.loadMetadata()).toEqual(metadata)
  controls.forEach(control => expect(control).not.toHaveBeenCalled()); f.controls.forEach(control => expect(control).not.toHaveBeenCalled())
  facts.push({ case: provider, oldDevice: cursorBefore.dev, newDevice: cursorAfter.dev, oldOffset: cursorBefore.offset, newOffset: cursorAfter.offset,
    originalCheckpointUnedited: true, originalMetadataUnchanged: true, output: texts(continued.items), phases: continued.items.map(item => item.messagePhase ?? null), strictRpcAndCompiledCliMatched: true, runtimeControlCalls: 0 })
})

for (const provider of ['codex', 'pi'] as const) for (const change of ['replacement', 'truncation', 'boundary', 'foreign-native'] as const) {
  it(`${provider}: device renumbering does not admit real ${change} at the original cut`, async () => {
    const initial = (root: string) => jsonl([header(provider, root), speech(provider, 'before', null, 'Original accepted body')])
    const f = await nativeHistoryFixture(provider, initial); cleanup.push(f.close); mount.path = f.path
    const checkpoint = await f.client.sessionHistoryCheckpoint(f.session.agentSessionId), original = JSON.stringify(checkpoint)
    mount.generation = 7
    if (change === 'replacement') { await rename(f.path, f.path + '.original'); await writeFile(f.path, initial(f.root)) }
    if (change === 'truncation') await writeFile(f.path, jsonl([header(provider, f.root)]))
    if (change === 'boundary') await writeFile(f.path, initial(f.root).replace('Original accepted body', 'Changed! accepted body'))
    if (change === 'foreign-native') await writeFile(f.path, jsonl([header(provider, f.root, 'foreign-one'), speech(provider, 'before', null, 'Original accepted body')]))
    await expect(f.client.readSessionHistoryChanges(f.session.agentSessionId, { checkpoint })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
    expect(JSON.stringify(checkpoint)).toBe(original)
    f.controls.forEach(control => expect(control).not.toHaveBeenCalled())
    facts.push({ case: provider + '-' + change, originalCheckpointRetained: true, rejected: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', runtimeControlCalls: 0 })
  })
}

it('device identity still protects an already open native reader from a changed named source', async () => {
  const f = await nativeHistoryFixture('codex', root => jsonl([header('codex', root), speech('codex', 'before', null)])); cleanup.push(f.close); mount.path = f.path
  const reader = await NativeJsonlHistoryReader.open({ source: { providerId: 'codex', nativeSessionId: 'native-main' }, command: 'unused', args: [], env: {},
    workspacePath: f.root, transcriptPath: f.path, limit: 10, signal: new AbortController().signal })
  try {
    await reader.seekChanges(undefined, true)
    mount.generation = 7
    await expect(reader.verifyUnchanged()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  } finally { await reader.close() }
  facts.push({ case: 'same-open-device-change', rejected: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
})

it('default Host resumes original native progress and final after device renumbering without replaying an unknown effect', async () => {
  // Runtime byte I/O uses the existing deterministic port. Core admission, source
  // reading, durable publication and the official SDK run against real files/HTTP.
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'codex', executorId: 'codex',
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-main', transcriptPath: join(root, 'native.jsonl') } })); cleanup.push(f.close)
  const path = join(f.root, 'native.jsonl'); await writeFile(path, jsonl([header('codex', f.root), speech('codex', 'before', null)])); mount.path = path
  const ref = { hostId: 'local', agentSessionId: 'original-agent' }, originalRun = f.client.agentSession(ref.agentSessionId).run
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['region'] }],
    regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: ref.agentSessionId, runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {}
  } })
  const unknownBody = 'Original effect with missing platform receipt'
  const remote = await feishuPublicationHttp(call => call.method === 'POST' && call.path.endsWith('/messages') && call.body.includes(unknownBody)
    ? { status: 200, body: { code: 0, data: {} } } : undefined); cleanup.push(remote.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(options => {
    const { params, ...request } = options
    if (params !== undefined && (params === null || typeof params !== 'object')) throw Error('Expected original SDK query parameters')
    return remote.http.request({ ...request, ...(params === undefined ? {} : { params }) })
  })
  const options: Parameters<typeof createConnectionServices>[0] = { directory: join(f.root, 'host'), adapters: createBuiltinConnectionAdapters(),
    bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) }, publication: createPublicationConversationPort(f.coreClients) }
  let services = await createConnectionServices(options); cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'credential', secret: 'private-fixture-credential' })
  await services.connections.configure({ operationId: 'configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind({ operationId: 'original-cut', bindingId: 'original-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: ref.hostId, agentSessionId: ref.agentSessionId, regionAnchor: { regionId: 'region' }, externalConversationId: 'original-room',
    expectedSource: { providerId: 'codex', nativeSessionId: 'native-main' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }, { actor: { kind: 'user', id: 'original-user' } })
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Original binding must exist')
  const binding = structuredClone(bound.binding), operations = () => services.publication!.store.list(binding)
  const copies = (text: string) => remote.messageCalls().filter(call => call.method === 'POST' && call.body.includes(text)).length
  await appendFile(path, jsonl([speech('codex', 'unknown-effect', null, unknownBody)])); services.publication!.refresh()
  await vi.waitFor(() => expect(operations().find(operation => operation.payload.kind === 'speech' && operation.payload.text === unknownBody)?.state).toBe('unknown'), { timeout: 8000 })
  const unknown = structuredClone(operations().find(operation => operation.payload.kind === 'speech' && operation.payload.text === unknownBody)!)
  const retained = services.publication!.store.retainedCheckpoint(binding)!
  expect(retained).toBeDefined()
  const retainedBytes = JSON.stringify(retained), oldNative = retained.frontier.cuts.find(cut => cut.kind === 'native')!
  if (oldNative.kind !== 'native') throw Error('Original retained native cut required')
  await services.close()
  mount.generation = 7
  await appendFile(path, jsonl([speech('codex', 'resumed-progress', null, 'Native progress after reopen', 'commentary'), speech('codex', 'resumed-final', null, 'Native final after reopen')]))
  services = await createConnectionServices(options)
  const captured = 'Independent captured input after owner reopen'
  await f.client.submitAgentPrompt({ ...agentPromptCondition(f.client.agentSession(ref.agentSessionId)), agentSessionId: ref.agentSessionId,
    operationId: 'independent-input', prompt: captured, authorHuman: true, allowUncertainTurn: true })
  services.publication!.refresh()
  await vi.waitFor(() => {
    expect(copies(captured)).toBe(1)
    expect(operations().find(operation => operation.payload.kind === 'speech' && operation.payload.text === captured)?.state).toBe('confirmed')
  }, { timeout: 8000 })
  await vi.waitFor(() => {
    for (const text of ['Native progress after reopen', 'Native final after reopen']) expect(copies(text)).toBe(1)
    for (const text of ['Native progress after reopen', 'Native final after reopen']) expect(operations().find(operation => operation.payload.kind === 'speech' && operation.payload.text === text)?.state).toBe('confirmed')
  }, { timeout: 8000 })
  const resumed = operations().filter(operation => operation.payload.kind === 'speech' && operation.payload.text.startsWith('Native '))
  expect(resumed.map(operation => operation.payload.kind === 'speech' ? operation.payload.phase : null)).toEqual(['progress', 'final'])
  expect(resumed.every(operation => operation.reference.source.kind === 'native')).toBe(true)
  const current = services.publication!.store.retainedCheckpoint(binding)!.frontier.cuts.find(cut => cut.kind === 'native')!
  if (current.kind !== 'native') throw Error('Continued native cut required')
  expect(decode(current.checkpoint.cursor).offset).toBeGreaterThan(decode(oldNative.checkpoint.cursor).offset)
  expect(JSON.stringify(retained)).toBe(retainedBytes)
  expect(services.publication!.store.inspect(unknown.operationId)).toEqual(unknown); expect(copies(unknownBody)).toBe(1)
  expect((await services.connections.bindings!.list({ connectionId: binding.connectionId })).bindings[0]).toEqual(binding)
  expect(f.client.agentSession(ref.agentSessionId).run).toEqual(originalRun)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'delivery.sock'), connections: services.connections, spatialState: spatial, coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const report = await rpc.call('connection.diagnose', { executionHostId: ref.hostId, agentSessionId: ref.agentSessionId })
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'diagnose', '--host', ref.hostId, '--session', ref.agentSessionId], objectCliEnvironment(f.root))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.groups.value.items[0].outgoing.value.deliveries).toEqual(report.groups.value!.items[0]!.outgoing.value!.deliveries)
  facts.push({ case: 'default-host', originalCheckpointUnedited: true, originalBindingUnchanged: true, originalRunUnchanged: true,
    nativePhases: ['progress', 'final'], nativeConfirmed: 2, capturedConfirmed: 1, unknownEffectRetained: true, unknownPostCopies: copies(unknownBody), strictRpcAndCompiledCliMatched: true,
    boundary: 'Device number observation and Runtime byte I/O are controlled; real files, builtin Provider, Core, Host, Outbox and official SDK reach loopback HTTP. No live platform delivery is certified.' })
})
