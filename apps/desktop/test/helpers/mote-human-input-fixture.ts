import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, vi } from 'vitest'
import { createMoteInputFixture } from '../../../../packages/core/test/helpers/mote-input-owner'
import { CtxmuxRunAdapter } from '../../../../packages/core/src/ctxmux-run-adapter'
import { AgentMuxControlServer } from '../../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../../packages/core/src/public-rpc-client'
import { MoteDialogueStore } from '../../../../packages/core/src/mote/dialogue-store'
import { spatialCatalog } from '../../../../packages/core/src/spatial-state'
import { createHostContent } from '../../../host/src/content-owner'
import { createHostMoteMainReader, createHostMoteDialogue } from '../../../host/src/mote-dialogue'
import { HostMoteQuickPreferences } from '../../../host/src/mote-quick-preferences'
import { PMO_TEAMS_TOPIC_ID } from '../../../host/src/mote-model'

/** Real Host/Files/role/RPC/Core and private Native PTY; the tiny process only
 * echoes received bytes. It supplies no model, native actor or acceptance claim. */
export async function createMoteHumanInputFixture(closes: Array<() => Promise<unknown>>, state: 'idle' | 'working') {
  const f = await createMoteInputFixture({ directoryAddress: true, topicId: PMO_TEAMS_TOPIC_ID })
  closes.push(f.close)
  const nativeState = join(f.root, 'state', 'ctxmux')
  await mkdir(nativeState, { recursive: true, mode: 0o700 })
  const daemon = spawn(resolve(import.meta.dirname, '../../../../packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(f.root, 'ctxmux.sock'), '--state-dir', nativeState, '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let diagnostic = ''; daemon.stderr!.on('data', bytes => { diagnostic += String(bytes) })
  const native = new CtxmuxRunAdapter()
  closes.push(async () => {
    try {
      if (native.isConnected()) for (const run of await native.list()) if (run.state.type === 'running') await native.stop(await native.prepareStop(run.runId))
    } finally {
      native.disconnect()
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited
      }
    }
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw Error(diagnostic) })])
  await native.connect()
  const program = "process.stdin.setRawMode(true);process.stdin.on('data',d=>console.log('BYTES:'+d.toString('hex')));console.log('ORIGINAL_TUI_READY');setInterval(()=>{},1000)"
  const run = await native.start({ operationKey: 'original-ordinary-main', program: process.execPath, args: ['-e', program], cwd: f.root, env: {} })
  const replay = async () => (await native.replay(run.runId, 0)).replay.map(chunk => chunk.data).join('')
  await vi.waitFor(async () => expect(await replay()).toContain('ORIGINAL_TUI_READY'))
  const old = (await f.store.readMetadata('primary'))!
  expect(old.nativeActor).toBeUndefined()
  const observedAt = Date.now()
  await f.store.compareAndSwapMetadata(old, { ...old, updatedAt: observedAt, run: { runId: run.runId }, semanticStatus: {
    state: state === 'idle' ? 'done' : 'working', source: 'native-hook', observedAt, nativeTurnId: 'original-' + state
  } })
  await f.inner.registry.load('local')
  const spatial = (await f.spatial.read())!
  await f.spatial.commit({ expectedRevision: spatial.revision, graph: { ...spatial.graph,
    regions: spatial.graph.regions.map(region => region.agentSessionId === 'primary' ? { ...region, runId: run.runId } : region) } })
  const originalStatus = f.inner.kernel.status as (id: string) => unknown
  f.inner.kernel.identity = native.identity.bind(native)
  f.inner.kernel.status = vi.fn(async (id: string) => id === run.runId ? await native.status(id) : await originalStatus(id))
  const open = native.openInput.bind(native)
  const byteWrites: string[] = []
  f.inner.kernel.input = vi.fn(async (id: string, input: Parameters<typeof native.input>[1]) => {
    byteWrites.push(typeof input.data === 'string' ? input.data : Buffer.from(input.data).toString('utf8'))
    return await native.input(id, input)
  })
  f.inner.kernel.openInput = vi.fn(async (id: string) => {
    const channel = await open(id)
    return { ...channel, input: async (data: string | Uint8Array) => {
      byteWrites.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
      return await channel.input(data)
    } }
  })
  const provider = f.client.providers.get('codex')
  const nativePreparation = vi.fn(async () => { throw Error('This ordinary TUI has no native actor input service.') })
  f.client.providers.replace({ ...provider, prepareNativeInput: nativePreparation })
  const configurationPath = join(f.root, 'configuration.json')
  const content = createHostContent({ configurationPath, spatial: f.spatial })
  const main = createHostMoteMainReader({ configurationPath, spatial: f.spatial, files: content.files! })
  const store = new MoteDialogueStore(join(f.root, 'human-dialogue.sqlite'))
  const dialogue = createHostMoteDialogue({ main, spatial: f.spatial, store, clientForHost: async host => {
    expect(host).toBe('local'); return f.client
  } })
  const quick = new HostMoteQuickPreferences({ main, files: content.files!, recordMainSource: dialogue.recordMainSource,
    catalog: async () => spatialCatalog((await f.spatial.read())!.graph), executors: async () => [] })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'human-main.sock'), coreClients: f.coreClients, moteDialogue: dialogue, moteQuickPreferences: quick })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const space = (await f.spatial.read())!.graph.spaces[0]!
  const target = { spaceId: space.spaceId, zoneId: f.graph.zones[0]!.zoneId,
    expectedResource: { hostId: 'local', workspaceId: '__scratch__', workspacePath: join(f.root, 'scratch') } }
  const snapshot = await main.readCurrentMoteMain(target)
  expect(snapshot.status).toBe('ready'); expect(snapshot.current?.sessionId).toBe('primary')
  const key = (operationId: string) => ({ kind: 'prompt' as const, agentSessionId: 'primary', expectedRun: { runId: run.runId }, submissionId: operationId })
  return { ...f, target, main, quick, mainRpc: rpc, snapshot, native, run, replay, byteWrites, nativePreparation,
    originalNativePreparation: provider.prepareNativeInput!, inputKey: key,
    switchRole: async (sessionId: string) => {
      const preferences = await quick.read({ kind: 'quick', target })
      if (!preferences.source?.resource || preferences.source.result.status !== 'read' || !preferences.defaults) throw Error('Original Files baseline required')
      const reference = preferences.choices.conversations.find(choice => choice.reference.sessionId === sessionId)!.reference
      const { hostId: _host, sessionId: _sid, ...location } = reference
      const saved = await quick.save({ kind: 'quick', target, operationId: 'switch-before-human-input',
        baseline: { resource: preferences.source.resource, document: preferences.source.result.document, defaults: preferences.defaults },
        values: { ...preferences.defaults, conversation: reference }, destination: { kind: 'occurrence', ...location } })
      expect(saved.status, saved.message ?? '').toBe('saved')
    } }
}
