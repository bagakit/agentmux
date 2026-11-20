import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { fixturePath } from './helpers/fixture-values.js'
import { until } from './helpers/headless-runtime-fixture.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

// Keep real processes and frames. Only the health sampling interval is compressed.
vi.mock('node:timers/promises', async importOriginal => {
  const timers = await importOriginal<typeof import('node:timers/promises')>()
  return { ...timers, setTimeout: (ms?: number, value?: unknown, options?: import('node:timers').TimerOptions) =>
    timers.setTimeout(ms === 30_000 && options?.ref === false ? 40 : ms, value, options) }
})

const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }

async function owner(runtimeId: string, beforeCatalog?: () => Promise<void>) {
  const h = await rpcOwnerFixture()
  closes.push(h.close)
  const identity = { runtimeId, ownerInstanceId: 'live-owner', protocolVersion: 2 as const,
    processId: process.pid, ctxmux: h.client.runtimeIdentity(), availability: 'connected' as const }
  const hosted = new AgentMuxHostedRuntimeService(h.client, join(h.root, 'sessions.json'), () => identity)
  closes.push(() => hosted.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'liveness.sock'),
    coreClients: h.coreClients, hostedRuntime: () => hosted,
    execute: async () => {
      await beforeCatalog?.()
      return { operation: 'space.ls', catalog }
    } })
  await server.start()
  closes.push(() => server.stop())
  return { socket: server.path, fence: { runtimeId, ownerInstanceId: identity.ownerInstanceId }, stopRun: h.inner.kernel.stop }
}

async function carrier(transport: 'ssh' | 'tailcat', socket: string) {
  const directory = await mkdtemp(fixturePath('tmp/amx-remote-liveness-'))
  closes.push(() => rm(directory, { recursive: true, force: true }))
  const log = join(directory, 'processes'), target = join(directory, 'target'), drop = join(directory, 'drop')
  await Promise.all([writeFile(log, ''), writeFile(target, socket), writeFile(drop, '')])
  const entry = pathToFileURL(process.env.AGENTMUX_TEST_RPC_STDIO_ENTRY ??
    resolve(import.meta.dirname, '../dist/agentmux-rpc-stdio.js')).href
  await writeFile(join(directory, transport), `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
import { Writable } from 'node:stream'
import { forwardAgentMuxRpcStdio } from ${JSON.stringify(entry)}
const pid = String(process.pid)
const path = readFileSync(${JSON.stringify(target)}, 'utf8')
appendFileSync(${JSON.stringify(log)}, pid + '\\n')
const output = new Writable({ write(bytes, _encoding, done) {
  if (readFileSync(${JSON.stringify(drop)}, 'utf8') === pid) done()
  else process.stdout.write(bytes, done)
} })
await forwardAgentMuxRpcStdio({ endpoint: { transport: 'unix', path }, input: process.stdin, output })
`, { mode: 0o700 })
  vi.stubEnv('PATH', directory + ':' + process.env.PATH)
  const endpoint = transport === 'ssh' ? { transport, host: 'approved-host', socketPath: socket } as const
    : { transport, address: 'tcfixture', keyFile: 'approved-key' } as const
  return { endpoint, silence: (pid: string) => writeFile(drop, pid), pointAt: (path: string) => writeFile(target, path),
    processes: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean) }
}

it.each(['ssh', 'tailcat'] as const)('releases only a confirmed silent %s carrier and can observe the same Runtime again', async transport => {
  let releaseCatalog!: () => void, catalogReads = 0
  const heldCatalog = new Promise<void>(resolve => { releaseCatalog = resolve })
  const original = await owner('original-runtime', async () => { catalogReads++; await heldCatalog })
  const other = await owner('other-runtime')
  const connection = await carrier(transport, original.socket)
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(ms === 30_000 ? 900 : ms))
  const rpc = await connectAgentMuxRpc({ endpoint: connection.endpoint })
  closes.push(() => rpc.dispose())
  const ended = vi.fn()
  const observe = (consumerId: string, onEnd = ended) => rpc.subscribe('runtime.events', {
    consumerId, fence: original.fence
  }, { onInitial: () => {}, onEvent: () => {}, onEnd })
  const existing = await observe('original-observer')
  closes.push(() => existing.dispose())
  const [originalPid] = await connection.processes()
  const slow = rpc.call('space.ls', { target: {} }, { runtimeFence: original.fence }).then(value => ({ value }), error => ({ error }))
  try {
    await until(() => catalogReads, count => count === 1, 'the original catalog request reached its owner')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(await connection.processes(), 'a slow business read does not force an independent carrier').toEqual([originalPid])
    expect(ended).not.toHaveBeenCalled()
  } finally { releaseCatalog() }
  expect(await slow).toEqual({ value: { catalog } })
  await new Promise(resolve => setTimeout(resolve, 120))
  expect(await connection.processes(), 'a quiet reader can answer probes on the original carrier').toEqual([originalPid])
  expect(ended).not.toHaveBeenCalled()

  await connection.pointAt(other.socket)
  await connection.silence(originalPid!)
  await until(connection.processes, values => values.length >= 3, 'fresh probes against the wrong Runtime')
  expect(ended, 'another Runtime cannot confirm loss of this carrier').not.toHaveBeenCalled()
  expect(rpc.remoteTransportObservation()).toMatchObject({ state: 'connected', transport })

  await connection.pointAt(original.socket)
  await until(() => ended.mock.calls.length, count => count === 1, 'original reader ends after matching Runtime answers', 6_000)
  expect(ended).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'CONTROL_CONNECTION_FAILED' }))
  expect(rpc.remoteTransportObservation()).toMatchObject({ state: 'disconnected', transport })
  expect(original.stopRun).not.toHaveBeenCalled()

  const rejoinedEnd = vi.fn()
  const rejoined = await observe('original-observer', rejoinedEnd)
  closes.push(() => rejoined.dispose())
  expect(rpc.remoteTransportObservation()).toMatchObject({ state: 'connected', transport })
  expect(rejoinedEnd).not.toHaveBeenCalled()
  expect(ended).toHaveBeenCalledTimes(1)
  expect(catalogReads).toBe(1)
}, 20_000)
