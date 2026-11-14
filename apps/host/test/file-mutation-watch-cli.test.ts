import { spawn } from 'node:child_process'
import { writeFile, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agent, cleanup, hostFixture } from './helpers/file-path-fixture.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { FileMutationObservations } from '../src/file-mutation-observations.js'
import { FilePathMutations } from '../src/file-path-mutations.js'
import { OrdinaryWorkspaceFiles } from '../src/ordinary-files.js'
import { startAgentMuxHost } from '../src/host.js'
import { createHostContent } from '../src/content-owner.js'
import * as core from '@agentmux/core'
import { desktopRpcMethods } from '../../desktop/src/main/desktop-rpc-exposure.js'
import { sourceFilesHosts } from '../../desktop/test/helpers/source-files-hosts.js'
import type { FileMutationEffect } from '@agentmux/core/files'

afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function watch(f: Awaited<ReturnType<typeof hostFixture>>, path = '.') {
  const params = { zoneId: 'original-files-zone', path, expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  const frames: any[] = [], child = spawn(process.execPath, [resolve('packages/core/bin/amux'), '--endpoint', 'unix:' + join(f.original.root, 'host.sock'), 'file', 'mutation', 'watch', '--input', '-'],
    { env: objectCliEnvironment(f.original.root, { AGENTMUX_AGENT_SESSION_ID: agent.actor.id, AGENTMUX_AGENT_CAPABILITY: f.original.capability }), stdio: ['pipe', 'pipe', 'pipe'] })
  let pending = '', stderr = '', exit: number | null | undefined
  const closed = new Promise<void>(yes => child.once('close', code => { exit = code; yes() }))
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    pending += chunk
    let end: number
    while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line) frames.push(JSON.parse(line)) }
  })
  child.stdin.end(JSON.stringify(params))
  cleanup.push(async () => { if (exit === undefined) child.kill('SIGINT'); await closed })
  await vi.waitFor(() => { expect(exit, JSON.stringify(frames) + stderr).toBeUndefined(); expect(frames[0]?.result?.initial?.delivery, JSON.stringify(frames) + stderr).toBe('live-only') }, { timeout: 10000 })
  return { frames, effects: () => frames.flatMap(frame => frame.params?.event?.type === 'effect' ? [frame.params.event.data] : []), close: async () => { child.kill('SIGINT'); await closed; expect(exit).toBe(0) } }
}

it('compiled watch consumes actual Host/Native positive effects, distinguishes no-OP creation and filters another managed actor without replay', async () => {
  const f = await hostFixture(), observer = await watch(f), subtree = await watch(f, 'original')
  const stat = async (path: string) => (await f.cli(['stat'], { zoneId: 'original-files-zone', path, expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } })).body.result
  const mkdir = async (path: string, operationId: string, who = agent.actor.id) => {
    const seen = await stat(path), input = { zoneId: 'original-files-zone', path, operationId, expectedResource: seen.resource, expectedAbsent: true, expected: { root: seen.result.observation.root, parent: seen.result.observation.parent } }
    const reply = await f.cli(['mkdir'], input, who)
    expect(reply.code, reply.stdout + reply.stderr).toBe(0); expect(reply.body.result.result.filesystem).toBe('created')
    return input
  }
  const original = await mkdir('original', 'original-live-mkdir')
  await vi.waitFor(() => expect(observer.effects()).toHaveLength(1))
  await f.cli(['mutation', 'inspect'], { zoneId: original.zoneId, path: original.path, operationId: original.operationId, expectedResource: original.expectedResource })
  await f.cli(['mkdir'], original)
  await mkdir('other', 'other-actor-live-mkdir', 'other-files-agent')
  const absent = await stat('created.txt')
  const create = await f.cli(['create'], { zoneId: 'original-files-zone', path: 'created.txt', expectedResource: absent.resource, content: 'Original live body', expectedRevision: null })
  expect(create.code, create.stdout + create.stderr).toBe(0)
  expect(create.body.result.result.status).toBe('written')
  const source = await stat('original'), destination = await stat('moved')
  const moveInput = { operationId: 'original-live-move', zoneId: 'original-files-zone', path: 'original', expectedResource: source.resource,
    expected: { root: source.result.observation.root, parent: source.result.observation.parent, entry: source.result.observation.entry },
    destination: { zoneId: 'original-files-zone', path: 'moved', expectedResource: destination.resource, expectedAbsent: true,
      expected: { root: destination.result.observation.root, parent: destination.result.observation.parent } } }
  const moved = await f.cli(['move'], moveInput)
  expect(moved.code, moved.stdout + moved.stderr).toBe(0); expect(moved.body.result.result.filesystem).toBe('moved')
  const remove = await stat('moved'), deletion = { operationId: 'original-live-delete', zoneId: 'original-files-zone', path: 'moved', expectedResource: remove.resource,
    expected: { root: remove.result.observation.root, parent: remove.result.observation.parent, entry: remove.result.observation.entry } }
  const deleted = await f.cli(['delete'], deletion)
  expect(deleted.code, deleted.stdout + deleted.stderr).toBe(0); expect(deleted.body.result.result.filesystem).toBe('deleted')
  await mkdir('last', 'last-live-mkdir')
  await vi.waitFor(() => expect(observer.effects()).toHaveLength(5))
  expect(observer.effects().map(value => [value.type, value.request?.operationId])).toEqual([
    ['path-mutation', original.operationId], ['created-file', undefined], ['path-mutation', moveInput.operationId], ['path-mutation', deletion.operationId], ['path-mutation', 'last-live-mkdir']
  ])
  expect(observer.effects()[0]).toMatchObject({ action: 'mkdir', request: original, receipt: { operationId: original.operationId, result: { filesystem: 'created' } } })
  expect(Object.keys(observer.effects()[1]).sort()).toEqual(['resource', 'revision', 'type'])
  await vi.waitFor(() => expect(subtree.effects()).toHaveLength(2))
  expect(subtree.effects().map(value => value.request.operationId)).toEqual([original.operationId, moveInput.operationId])
  expect(observer.effects()[2]).toMatchObject({ request: moveInput, receipt: moved.body.result })
  expect(observer.effects()[3]).toMatchObject({ request: deletion, receipt: deleted.body.result })
  await subtree.close()
  await observer.close()
  const after = await mkdir('after-cancel', 'after-watch-cancel')
  expect(after.operationId).toBe('after-watch-cancel')
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

it('a finite Core request retains its Runtime fence when the Desktop endpoint answers for another actual Source with the same physical resource', async () => {
  const f = await sourceFilesHosts(cleanup, { sharedProject: true }), [a, b] = f.sources
  const registrations = []
  for (const source of [a!, b!]) {
    const observed = await source.rpc.call('space.folder.inspect', { runtimeId: source.identity.runtimeId, path: source.project })
    expect(observed.resource).not.toBeNull()
    registrations.push(await source.rpc.call('space.folder.register', { runtimeId: source.identity.runtimeId, directory: observed.resource! }))
  }
  const original = registrations[0]!, other = registrations[1]!
  expect(a!.identity.runtimeId).not.toBe(b!.identity.runtimeId)
  expect({ zoneId: original.zoneId, workspaceId: original.workspaceId, resource: original.resource }).toEqual({ zoneId: other.zoneId, workspaceId: other.workspaceId, resource: other.resource })
  const observed = await a!.rpc.call('file.stat', { zoneId: original.zoneId, path: 'original-runtime-only',
    expectedResource: { hostId: 'local', workspaceId: original.workspaceId, workspacePath: a!.project } })
  expect(observed.result.status).toBe('observed')
  if (observed.result.status !== 'observed' || !observed.resource) throw new Error('The original Source stat is unavailable.')
  const input = { operationId: 'finite-original-runtime-fence', zoneId: original.zoneId, path: 'original-runtime-only', expectedResource: observed.resource, expectedAbsent: true as const,
    expected: { root: observed.result.observation.root, parent: observed.result.observation.parent } }
  await a!.client.dispose(); await a!.rpc.dispose(); await a!.host.dispose()
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', dirname(a!.socketPath)); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', a!.state)
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(a!.state, 'spatial.json')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(a!.state, 'messages.ndjson'))
  const desktopPath = join(f.root, 'other-source-desktop.sock')
  const mkdir = vi.fn((params: any) => b!.rpc.call('file.mkdir', params))
  const desktop = new core.AgentMuxControlServer({ socketPath: desktopPath, exposedMethods: desktopRpcMethods(),
    coreClients: () => [{ hostId: 'local', client: b!.host.client }],
    // Exact SDK business-port delegation to B; no invented Namespace or Runtime.
    files: { read: p => b!.rpc.call('file.read', p), list: p => b!.rpc.call('file.list', p), write: p => b!.rpc.call('file.write', p), create: p => b!.rpc.call('file.create', p), mkdir },
    callOriginalCore: (_host, method, params, context) => b!.rpc.call(method, params, context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}) })
  await desktop.start(); cleanup.push(() => desktop.stop())
  const forwarded = await startAgentMuxHost({ store: a!.store, socketPath: a!.socketPath, desktopSocketPath: desktopPath, mobileBuildDirectory: join(a!.directory, 'absent-mobile') })
  cleanup.push(() => forwarded.dispose())
  const identity = (await forwarded.hosted.call('runtime.owner.identity', {})).owner
  expect(identity.runtimeId).toBe(a!.identity.runtimeId)
  const native = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'mkdirPath'), requests = vi.spyOn((desktop as any).service, 'call')
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: a!.socketPath }, runtimeFence: { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId } })
  cleanup.push(() => rpc.dispose())
  await expect(rpc.call('file.mkdir', input)).rejects.toThrow()
  expect(requests.mock.calls.find(row => row[0] === 'file.mkdir')?.[2]).toMatchObject({ runtimeFence: { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId } })
  expect(mkdir).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled()
  await expect(lstat(join(a!.project, input.path))).rejects.toMatchObject({ code: 'ENOENT' })
}, 60000)

it('an actual Native producer never waits for a slow observer and terminates only that bounded reader once', async () => {
  const f = await hostFixture(), effects = new FileMutationObservations()
  const owner = new FilePathMutations({ directory: join(f.original.root, 'separate-mutation-records'), files: f.ordinary, effects, noteLease: work => work() })
  const controller = new AbortController(), received: FileMutationEffect[] = [], ended: Error[] = []
  let release!: () => void
  const held = new Promise<void>(yes => { release = yes })
  const observer = effects.subscribe(f.descriptor('.'), agent, event => { received.push(event); return held }, error => { if (error) ended.push(error) }, controller.signal)
  observer.start()
  const first = await owner.mkdir(f.workspace, await f.request('slow-first', 'slow-first-operation'), agent)
  expect(first.result.filesystem).toBe('created')
  await vi.waitFor(() => expect(received).toHaveLength(1))
  expect((await owner.mkdir(f.workspace, await f.request('slow-second', 'slow-second-operation'), agent)).result.filesystem).toBe('created')
  expect(ended).toHaveLength(1); expect(ended[0]).toMatchObject({ code: 'FILE_MUTATION_OBSERVATION_GAP' })
  expect((await owner.mkdir(f.workspace, await f.request('slow-third', 'slow-third-operation'), agent)).result.filesystem).toBe('created')
  expect(received).toHaveLength(1); expect(ended).toHaveLength(1)
  release(); controller.abort()
  await writeFile(join(f.root, 'ordinary-healthy.txt'), 'Original reads and writes remain healthy')
  expect((await f.cli(['stat'], { zoneId: 'original-files-zone', path: 'ordinary-healthy.txt', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } })).body.result.result.status).toBe('observed')
}, 30000)

it('compiled watch crosses the actual unconfigured Core forwarding port and Desktop RPC service to the original Native Files owner', async () => {
  const f = await hostFixture(), native = (f.host.client as any).kernel
  await f.host.dispose()
  let forwarded!: Awaited<ReturnType<typeof startAgentMuxHost>>
  const desktopPath = join(f.original.root, 'forwarded-desktop.sock'), socketPath = join(f.original.root, 'host.sock')
  const content = createHostContent({ configurationPath: f.configurationPath, spatial: f.spatial,
    directoryScope: predicate => forwarded.client.retainExecutionDirectoryMutation(predicate) })
  // The Desktop endpoint borrows the original Files business owner. It does not
  // mint a second Runtime owner. Its production semantic-fence port is the
  // existing callOriginalCore, added to the fenced case separately.
  const desktop = new core.AgentMuxControlServer({ socketPath: desktopPath, exposedMethods: desktopRpcMethods(),
    coreClients: () => forwarded ? [{ hostId: 'local', client: forwarded.client }] : [], files: content.files,
    callOriginalCore: async (hostId, method, params, context) => {
      expect(hostId).toBe('local')
      const original = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath },
        ...(context.caller ? { credentials: context.caller } : {}), ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}) })
      try { return await original.call(method, params) } finally { await original.dispose() }
    } })
  await desktop.start(); cleanup.push(() => desktop.stop())
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as any
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
    inner.kernel.listPage = async () => ({ runs: [], nextCursor: null })
  })
  try {
    // Deliberately omit configurationPath: production Host must forward instead
    // of using its locally configured Files port, which hid the original gap.
    forwarded = await startAgentMuxHost({ store: f.original.store, socketPath, desktopSocketPath: desktopPath,
      mobileBuildDirectory: join(f.original.root, 'absent-mobile') })
    cleanup.push(() => forwarded.dispose())
    await vi.waitFor(() => expect((forwarded.client as any).connected).toBe(true))
  } finally { connect.mockRestore() }
  const delegatedWatch = vi.spyOn(content.files!, 'watchMutations'), nativeMkdir = vi.spyOn(OrdinaryWorkspaceFiles.prototype, 'mkdirPath')
  const owner = (await forwarded.hosted.call('runtime.owner.identity', {})).owner
  const scope = { zoneId: 'original-files-zone', path: '.', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  for (const runtimeFence of [{ runtimeId: 'another-original-runtime', ownerInstanceId: owner.ownerInstanceId }, { runtimeId: owner.runtimeId, ownerInstanceId: 'another-original-instance' }]) {
    const wrong = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath }, credentials: { agentSessionId: agent.actor.id, capability: f.original.capability }, runtimeFence })
    try { await expect(wrong.subscribe('file.mutation.watch', scope, { onInitial: () => {}, onEvent: () => {} })).rejects.toThrow() }
    finally { await wrong.dispose() }
  }
  expect(delegatedWatch).not.toHaveBeenCalled(); expect(nativeMkdir).not.toHaveBeenCalled()
  const reader = await watch(f)
  expect(delegatedWatch).toHaveBeenCalledTimes(1)
  expect(delegatedWatch.mock.calls[0]![4]).toMatchObject({ actor: agent.actor, callerHostId: agent.callerHostId })
  const query = { zoneId: 'original-files-zone', path: 'crossed', expectedResource: { hostId: 'local', workspaceId: f.workspace.id, workspacePath: f.root } }
  const observed = await f.cli(['stat'], query)
  expect(observed.code, observed.stdout + observed.stderr).toBe(0)
  const stat = observed.body.result
  const input = { ...query, operationId: 'original-forwarded-directory', expectedResource: stat.resource, expectedAbsent: true,
    expected: { root: stat.result.observation.root, parent: stat.result.observation.parent } }
  const created = await f.cli(['mkdir'], input)
  expect(created.code, created.stdout + created.stderr).toBe(0)
  expect(created.body.result.result.filesystem).toBe('created')
  expect(nativeMkdir).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(reader.effects()).toHaveLength(1))
  expect(reader.effects()[0]).toMatchObject({ request: input, receipt: created.body.result })
  await reader.close()
  const borrowed = vi.spyOn((desktop as any).service, 'subscribe'), fencedEvents: any[] = []
  const runtimeFence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
  const fenced = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath },
    credentials: { agentSessionId: agent.actor.id, capability: f.original.capability }, runtimeFence })
  cleanup.push(() => fenced.dispose())
  const fencedReader = await fenced.subscribe('file.mutation.watch', scope, { onInitial: () => {}, onEvent: event => { fencedEvents.push(event) } })
  cleanup.push(() => fencedReader.dispose())
  expect(borrowed.mock.calls[0]![3]).toMatchObject({ runtimeFence, caller: { agentSessionId: agent.actor.id } })
  const fencedStat = (await f.cli(['stat'], { ...query, path: 'fenced-crossed' })).body.result
  const fencedCreated = await f.cli(['mkdir'], { ...input, operationId: 'fenced-crossed', path: 'fenced-crossed', expectedResource: fencedStat.resource,
    expected: { root: fencedStat.result.observation.root, parent: fencedStat.result.observation.parent } })
  expect(fencedCreated.code, fencedCreated.stdout + fencedCreated.stderr).toBe(0)
  expect(fencedCreated.body.result.result.filesystem).toBe('created')
  await vi.waitFor(() => expect(fencedEvents.filter(event => event.type === 'effect')).toHaveLength(1))
  expect(fencedEvents[0]).toMatchObject({ type: 'effect', data: { request: { operationId: 'fenced-crossed' } } })
  await fencedReader.dispose(); await fenced.dispose()
  const delivered: any[] = []
  let release!: () => void
  const held = new Promise<void>(yes => { release = yes })
  // Exercise the production Core forward branch with the original sender's
  // Promise held. The downstream transport deliberately has void callbacks.
  const slow = await (forwarded.server as any).service.subscribe('file.mutation.watch', scope, (event: any) => {
    delivered.push(event); if (event.type === 'effect') return held
  }, { transport: 'unix', caller: { agentSessionId: agent.actor.id, capability: f.original.capability } })
  cleanup.push(async () => { release(); await slow.dispose() })
  await slow.start()
  for (const name of ['slow-forward-first', 'slow-forward-second', 'healthy-after-forward-gap']) {
    const seen = (await f.cli(['stat'], { ...query, path: name })).body.result
    const result = await f.cli(['mkdir'], { ...input, operationId: name, path: name, expectedResource: seen.resource,
      expected: { root: seen.result.observation.root, parent: seen.result.observation.parent } })
    expect(result.code, result.stdout + result.stderr).toBe(0); expect(result.body.result.result.filesystem).toBe('created')
    if (name === 'slow-forward-first') await vi.waitFor(() => expect(delivered.filter(event => event.type === 'effect')).toHaveLength(1))
    else await vi.waitFor(() => expect(delivered.filter(event => event.type === 'error')).toHaveLength(1))
  }
  expect(delivered.map(event => event.type)).toEqual(['effect', 'error'])
  expect(delivered[1]).toMatchObject({ error: { code: 'FILE_MUTATION_OBSERVATION_GAP' } })
  expect(nativeMkdir).toHaveBeenCalledTimes(5)
  release(); await slow.dispose()
  expect(native.stop).not.toHaveBeenCalled()
}, 30000)
