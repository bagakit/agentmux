import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { connectAgentMuxRpc as SourceConnect } from '../src/public-rpc-client.js'
import { connectSshAgentMux as SourceConnectSsh } from '../src/runtime-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import type { AgentMuxControlHost } from '../src/control.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const connect: typeof SourceConnect = process.env.AGENTMUX_TEST_RPC_CLIENT_ENTRY
  ? (await import(process.env.AGENTMUX_TEST_RPC_CLIENT_ENTRY)).connectAgentMuxRpc : SourceConnect
const closes: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
async function sshCarrier(socketPath: string, delay = 0) {
  const directory = await mkdtemp(fixturePath("tmp/amx-ssh-carrier-")), log = join(directory, 'spawn.ndjson'), latency = join(directory, 'reply-delay')
  await writeFile(latency, '0')
  const forward = pathToFileURL(resolve(import.meta.dirname, '../dist/agentmux-rpc-stdio.js')).href
  // Exercise real child stdio, the official CLI forwarding leaf and a real Unix
  // owner. Farm separately proves OpenSSH authentication and the network carrier.
  await writeFile(join(directory, 'ssh'), `#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';\nimport {Writable} from 'node:stream';\nimport {forwardAgentMuxRpcStdio} from ${JSON.stringify(forward)};\nappendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');\nawait new Promise(resolve=>setTimeout(resolve,${delay}));\nconst output=new Writable({write(bytes,encoding,done){const ms=Number(readFileSync(${JSON.stringify(latency)},'utf8'));setTimeout(()=>process.stdout.write(bytes,done),ms)}});\nawait forwardAgentMuxRpcStdio({endpoint:{transport:'unix',path:${JSON.stringify(socketPath)}},input:process.stdin,output});\n`, { mode: 0o700 })
  vi.stubEnv('PATH', directory + ':' + process.env.PATH)
  closes.push(() => rm(directory, { recursive: true, force: true }))
  return { endpoint: { transport: 'ssh' as const, host: 'private-owner', socketPath },
    replyDelay: (ms: number) => writeFile(latency, String(ms)),
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[] }),
    count: async () => (await readFile(log, 'utf8')).trim().split('\n').length }
}
const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }
it('establishes once before business deadlines, multiplexes callers and releases only each SSH reader', async () => {
  const h = await rpcOwnerFixture(); closes.push(h.close)
  const events = new Map<string, Parameters<NonNullable<AgentMuxControlHost['subscribeBrowserOperation']>>[1]>()
  const disposed: string[] = []
  let finishLate!: (value: { runOperation: null; gap: null; dispose(): void }) => void
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'ssh.sock'), coreClients: h.coreClients,
    execute: async () => ({ operation: 'space.ls', catalog }),
    subscribeBrowserOperation: async (request, push) => {
      events.set(request.operationId, push)
      if (request.operationId === 'business-hang') return await new Promise(() => {})
      if (request.operationId === 'late') return await new Promise(resolve => { finishLate = resolve })
      return { runOperation: null, gap: null, dispose: () => { disposed.push(request.operationId) } }
    } })
  await server.start(); closes.push(() => server.stop())
  const ssh = await sshCarrier(server.path, 2_300), client = await connect({ endpoint: ssh.endpoint }); closes.push(() => client.dispose())
  const firstEvents: unknown[] = [], secondEvents: unknown[] = [], secondEnd = vi.fn()
  const cold = await Promise.all([
    Promise.all([client.call('space.ls', { target: {} }), client.call('system.endpoint', {})]).then(value => ({ value }), error => ({ error })),
    client.subscribe('browser.follow', { operationId: 'first' }, { onInitial: () => {}, onEvent: event => firstEvents.push(event) }),
    client.subscribe('browser.follow', { operationId: 'second' }, { onInitial: () => {}, onEvent: event => secondEvents.push(event), onEnd: secondEnd })
  ]).then(value => ({ value }), error => ({ error }))
  expect(cold, 'SSH establishment precedes the original short business deadline').toHaveProperty('value')
  if (!('value' in cold)) throw cold.error
  const [calls, first, second] = cold.value
  expect(calls, 'SSH establishment precedes the original short business deadline').toMatchObject({ value: [{ catalog }, { protocol: 'jsonrpc-2.0' }] })
  expect(await ssh.count(), 'warm calls and readers share one SSH process').toBe(1)
  expect((await ssh.calls())[0]!.args.at(-1)).toBe(`'amux' '--endpoint' 'unix:${server.path}' 'system' 'endpoint' '--stdio'`)
  await ssh.replyDelay(2_300)
  const delayed = await client.call('space.ls', { target: {} }).then(value => ({ value }), error => ({ error }))
  expect(delayed, 'SSH response transit cannot masquerade as a failed short business intent').toEqual({ value: { catalog } })
  await ssh.replyDelay(0)
  await first.dispose()
  expect(secondEnd, 'cancelling one SSH reader preserves its peer').not.toHaveBeenCalled()
  await until(() => disposed, values => values.includes('first'), 'first reader released')
  events.get('second')!({ sequence: 1, event: { kind: 'peer-still-live' } })
  await until(() => secondEvents.length, count => count === 1, 'peer notification after cancellation')
  expect(secondEnd, 'cancelling one SSH reader preserves its peer').not.toHaveBeenCalled()
  expect(firstEvents).toEqual([])
  const failedEnd = vi.fn(), failed = await client.subscribe('browser.follow', { operationId: 'failed' }, { onInitial: () => {}, onEvent: () => {}, onEnd: failedEnd })
  events.get('failed')!({ sequence: -1, event: { kind: 'invalid-reader-cursor' } })
  await until(() => failedEnd.mock.calls.length, count => count === 1, 'invalid reader ended')
  expect(failedEnd.mock.calls[0]![0]).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  events.get('second')!({ sequence: 2, event: { kind: 'peer-still-live-again' } })
  await until(() => secondEvents.length, count => count === 2, 'peer notification after isolated failure')
  expect(secondEnd).not.toHaveBeenCalled(); await failed.dispose()
  const cancel = new AbortController(), late = client.subscribe('browser.follow', { operationId: 'late' }, { signal: cancel.signal, onInitial: () => {}, onEvent: () => {} }).then(value => ({ value }), error => ({ error }))
  await until(() => events.has('late'), Boolean, 'pending exact reader'); cancel.abort()
  expect(await late).toMatchObject({ error: { code: 'CONTROL_CANCELLED' } })
  finishLate({ runOperation: null, gap: null, dispose: () => { disposed.push('late') } })
  await until(() => disposed, values => values.includes('late'), 'late cancelled owner observer')
  const hung = await client.subscribe('browser.follow', { operationId: 'business-hang' }, { onInitial: () => {}, onEvent: () => {} }).then(value => ({ value }), error => ({ error }))
  expect(hung, 'remote business opening keeps its original deadline').toMatchObject({ error: { code: 'CONTROL_TIMEOUT' } })
  expect(await client.call('space.ls', { target: {} })).toEqual({ catalog })
  expect(await ssh.count(), 'warm calls and readers share one SSH process').toBe(1)
  expect(secondEnd).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled(); await second.dispose()
}, 30_000)

it('prepares an unverified SSH endpoint immediately and disposes its pending child without an admitted reader', async () => {
  const directory = await mkdtemp(fixturePath("tmp/amx-ssh-pending-")), log = join(directory, 'pending.json')
  await writeFile(join(directory, 'ssh'), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));\nprocess.stdin.resume();setInterval(()=>{},1000);\n`, { mode: 0o700 })
  vi.stubEnv('PATH', directory + ':' + process.env.PATH)
  closes.push(() => rm(directory, { recursive: true, force: true }))
  const connectSsh: typeof SourceConnectSsh = process.env.AGENTMUX_TEST_RUNTIME_CLIENT_ENTRY
    ? (await import(process.env.AGENTMUX_TEST_RUNTIME_CLIENT_ENTRY)).connectSshAgentMux : SourceConnectSsh
  const started = performance.now()
  const client = await connectSsh({ waitForReady: false, expectedRuntimeId: 'pinned-owner',
    target: { hostId: 'pending', hostname: 'private-owner', user: 'tester', port: 2222,
      identityFile: ((fixturePath("private/key")) + " with spaces"), remoteCommand: ((fixturePath("private/agentmux")) + " owner"), remoteSocketPath: ((fixturePath("private/runtime")) + " socket") } })
  closes.push(() => client.dispose())
  expect(performance.now() - started, 'initial preparation must not wait for a remote response').toBeLessThan(1000)
  expect(client.runtimeOwnerIdentity()).toBeNull()
  const child = await until(async () => { try { return JSON.parse(await readFile(log, 'utf8')) as { pid: number; args: string[] } } catch { return null } }, Boolean, 'pending SSH child')
  expect(child!.args).toContain(((fixturePath("private/key")) + " with spaces"))
  expect(child!.args).toContain('tester@private-owner')
  expect(child!.args.at(-1)).toBe(("'" + (fixturePath("private/agentmux")) + " owner' '--endpoint' 'unix:" + (fixturePath("private/runtime")) + " socket' 'system' 'endpoint' '--stdio'"))
  await client.dispose()
  await until(() => { try { process.kill(child!.pid, 0); return false } catch { return true } }, Boolean, 'pending SSH child disposed')
}, 10_000)

it('uses one SSH channel for typed Native input, semantic facts and independent live Run attachments', async () => {
  const scope = await headlessFixture(); closes.push(scope.cleanup)
  const ssh = await sshCarrier(scope.socketPath)
  const connectSsh: typeof SourceConnectSsh = process.env.AGENTMUX_TEST_RUNTIME_CLIENT_ENTRY
    ? (await import(process.env.AGENTMUX_TEST_RUNTIME_CLIENT_ENTRY)).connectSshAgentMux : SourceConnectSsh
  const client = await connectSsh({ expectedRuntimeId: scope.owner.runtimeId,
    target: { hostId: 'private-owner', hostname: ssh.endpoint.host, remoteSocketPath: scope.socketPath } })
  closes.push(() => client.dispose())
  const run = await client.createTerminal({ createOperationId: 'warm-ssh-terminal', workspacePath: scope.root, command: process.execPath,
    args: ['-e', "process.stdin.setRawMode(true);process.stdout.write('ready');process.stdin.on('data',b=>process.stdout.write(b));setInterval(()=>{},1000)"] })
  await until(() => client.listRuns(), runs => runs[0]?.latestOutputBytes === 5, 'original Native readiness')
  const events: import('../src/types.js').AgentMuxClientEvent[] = []; client.onEvent((event: import('../src/types.js').AgentMuxClientEvent) => events.push(event))
  await client.attachTerminal(run.runId)
  for (let index = 0; index < 3; index++) await client.writeTerminal({ runId: run.runId }, { operationId: 'warm-input-' + index,
    ownerInstanceId: client.runtimeIdentity().instanceId, expectedByte: index, data: String(index) })
  await until(() => events.filter(event => event.type === 'terminal-output').map(event => event.data).join(''), value => value === '012', 'original warm Native input')
  expect((await client.listRuns()).map(value => ({ runId: value.runId, pid: value.pid, acceptedInputBytes: value.acceptedInputBytes }))).toEqual([
    { runId: run.runId, pid: run.pid, acceptedInputBytes: 3 }
  ])
  expect((await client.forwardRpc!('agent.ls', {})).errors).toEqual([])
  expect(await ssh.count(), 'all typed Runtime intents and Native forwards reuse one SSH process').toBe(1)
  await client.releaseRunAttachment({ runId: run.runId })
  expect((await client.listRuns())[0]!.state).toBe('running')
  await client.stopTerminal({ runId: run.runId })
}, 60_000)
