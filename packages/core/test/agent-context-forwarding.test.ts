import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectSshAgentMux } from '../src/runtime-client.js'
import { hashAgentCapability } from '../src/agent-capability.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import type { AgentContextPage } from '../src/agent-context.js'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (process.env.AGENTMUX_CONTEXT_FORWARD_FACTS) await appendFile(process.env.AGENTMUX_CONTEXT_FORWARD_FACTS,
    JSON.stringify({ test: expect.getState().currentTestName, cleanupErrors: failures.map(String) }) + '\n')
  if (failures.length) throw new AggregateError(failures, 'Private context readers did not close')
})
const fullText = 'Complete original context 中🙂\n'.repeat(2000)
async function fixture() {
  const a = await rpcOwnerFixture(['source-caller']); cleanup.push(a.close)
  const b = await nativeHistoryFixture('claude', jsonl([0, 1, 2].map(i => ({ sessionId: 'native-main', uuid: `native-${i}`,
    type: 'user', timestamp: new Date((i + 1) * 60_000).toISOString(), message: { role: 'user', content: i === 2 ? fullText : `Native ${i}` } }))),
    { agentSessionId: 'original-b-target' }); cleanup.push(b.close)
  for (let i = 0; i < 3; i++) await b.store.applyTimelineMutation({ type: 'append', agentSessionId: b.session.agentSessionId,
    item: { id: `captured-${i}`, agentSessionId: b.session.agentSessionId, kind: 'user_message', status: 'complete', source: 'user',
      createdAt: i, updatedAt: i, title: 'Saved original input', content: i === 2 ? fullText : `Captured ${i}`, authorHuman: true } })
  // Real unrelated durable records, never a second authorization source.
  for (let i = 0; i < 40; i++) await b.store.compareAndSwap(null, { ...b.session, agentSessionId: `unrelated-${i}`,
    run: { runId: `unrelated-run-${i}` }, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: `unrelated-native-${i}` } })
  const sources = vi.spyOn(b.client, 'sessionHistorySources'), bAuthorize = vi.spyOn(b.client, 'authorizeRetainedAgentCaller')
  let identity: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'private-b-runtime', ownerInstanceId: 'private-b-owner',
    protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' }
  const hosted = new AgentMuxHostedRuntimeService(b.client, b.storePath, () => identity); cleanup.push(() => hosted.dispose())
  const options = { coreClients: () => [{ hostId: 'local', client: b.client }], hostedRuntime: () => hosted }
  const receiver = new AgentMuxControlServer({ ...options, socketPath: join(b.root, 'receiver.sock') })
  await receiver.start(); cleanup.push(() => receiver.stop())
  const carrierRoot = await mkdtemp(join(tmpdir(), 'amux-context-carrier-')); cleanup.push(() => rm(carrierRoot, { recursive: true, force: true }))
  const log = join(carrierRoot, 'wire.jsonl')
  const cli = process.env.AGENTMUX_TEST_OBJECT_CLI ?? resolve(import.meta.dirname, '../bin/amux')
  const stdio = pathToFileURL(resolve(dirname(cli), '../dist/agentmux-rpc-stdio.js')).href
  // The production SSH client and its credential encoder run unchanged. Only
  // OpenSSH/network authentication is a local stdio→original Unix test leaf.
  await writeFile(join(carrierRoot, 'ssh'), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nimport {Transform} from 'node:stream';\nimport {forwardAgentMuxRpcStdio} from ${JSON.stringify(stdio)};\nlet tail='';const tap=new Transform({transform(bytes,encoding,done){tail+=bytes.toString();let n;while((n=tail.indexOf('\\n'))>=0){const line=tail.slice(0,n);tail=tail.slice(n+1);try{const q=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify({method:q.method,callerSID:q.params?.caller?.agentSessionId,hasCapability:typeof q.params?.caller?.capability==='string',runtimeFence:q.params?.runtimeFence})+'\\n')}catch{}}done(null,bytes)}});process.stdin.pipe(tap);\nawait forwardAgentMuxRpcStdio({endpoint:{transport:'unix',path:${JSON.stringify(receiver.path)}},input:tap,output:process.stdout});\n`, { mode: 0o700 })
  vi.stubEnv('PATH', carrierRoot + ':' + process.env.PATH)
  const remote = await connectSshAgentMux({ waitForReady: false, expectedRuntimeId: identity.runtimeId,
    target: { hostId: 'saved-b', hostname: 'private.invalid', remoteSocketPath: receiver.path } })
  cleanup.push(() => remote.dispose())
  const forward = vi.spyOn(remote, 'forwardRpc')
  const clients = () => [...a.coreClients(), { hostId: 'saved-b', client: remote }]
  const ingress = new AgentMuxControlServer({ socketPath: join(a.root, 'ingress.sock'), coreClients: clients })
  await ingress.start(); cleanup.push(() => ingress.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: ingress.path }, credentials: a.credentials })
  cleanup.push(() => rpc.dispose())
  const env = objectCliEnvironment(a.root, { AGENTMUX_RPC_ENDPOINT: `unix:${ingress.path}`,
    AGENTMUX_AGENT_SESSION_ID: a.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: a.capability })
  const input = { hostId: 'saved-b', agentSessionId: b.session.agentSessionId, limit: 1 }
  const wires = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
    method: string; callerSID?: string; hasCapability: boolean; runtimeFence?: { runtimeId: string; ownerInstanceId: string } })
  return { a, b, sources, bAuthorize, remote, forward, clients, rpc, env, input, wires, options,
    replaceOwner: () => { identity = { ...identity, ownerInstanceId: 'replacement-b-owner' } } }
}

it('remote context: managed CLI pages both complete original sources through the configured credential encoder', async () => {
  const f = await fixture(), before = await f.b.bytes(), captured: string[] = [], native: string[] = []
  expect(await f.b.client.readAgentSession(f.a.credentials.agentSessionId)).toBeNull()
  let cursor: string | undefined
  for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
    const call = await runCompiledObjectCli(['agent', 'context', '--host', f.input.hostId, '--session', f.input.agentSessionId,
      '--limit', '1', ...(cursor ? ['--cursor', cursor] : [])], f.env)
    expect(call.code, call.stderr).toBe(0)
    const page: AgentContextPage = JSON.parse(call.stdout).result
    expect(page).toMatchObject({ hostId: 'saved-b', sourceHostId: 'local', agentSessionId: f.input.agentSessionId })
    expect(page.descriptor.hostId).toBe('local')
    captured.push(...page.captured!.items.map(item => item.id)); native.push(...(page.native?.items ?? []).map(item => item.id))
    if (pageIndex === 0) {
      expect(page.captured!.items[0]!.content).toBe(fullText)
      expect(page.native!.items[0]!.contentParts).toMatchObject([{ kind: 'text', text: fullText }])
    }
    if (page.nextCursor === null) break
    cursor = page.nextCursor
    expect(pageIndex).toBeLessThan(4)
  }
  expect(captured.sort()).toEqual(['captured-0', 'captured-1', 'captured-2'])
  expect(native.sort()).toEqual(['native-0', 'native-1', 'native-2'])
  expect(f.bAuthorize).not.toHaveBeenCalled()
  const forwarded = (await f.wires()).filter(q => q.method === 'agent.context')
  expect(forwarded).toHaveLength(3)
  for (const call of forwarded) {
    expect(call).not.toHaveProperty('callerSID'); expect(call.hasCapability).toBe(false)
    expect(call.runtimeFence).toEqual({ runtimeId: 'private-b-runtime', ownerInstanceId: 'private-b-owner' })
  }
  expect(f.sources).toHaveBeenCalledTimes(6)
  for (const [scope] of f.sources.mock.calls) expect(scope).toMatchObject({ agentSessionId: f.input.agentSessionId })
  expect(await f.b.bytes()).toEqual(before)
  for (const control of f.b.controls.slice(0, 5)) expect(control).not.toHaveBeenCalled()
})

it('remote context: a same-SID B record never becomes the A caller identity', async () => {
  const f = await fixture()
  await f.b.store.compareAndSwap(null, { ...f.b.session, agentSessionId: f.a.credentials.agentSessionId,
    run: { runId: 'different-b-run' }, capabilityHash: hashAgentCapability('different-b-capability'),
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'different-b-native' } })
  const page = await f.rpc.call('agent.context', f.input)
  expect(page.agentSessionId).toBe(f.input.agentSessionId)
  expect(f.bAuthorize).not.toHaveBeenCalled()
  expect((await f.wires()).find(q => q.method === 'agent.context')).not.toHaveProperty('callerSID')
})

it('remote context: invalid source credentials never reach B and unchanged writes still carry the original caller', async () => {
  const f = await fixture()
  const invalid = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.a.root, 'ingress.sock') },
    credentials: { ...f.a.credentials, capability: 'invalid' } }); cleanup.push(() => invalid.dispose())
  const rejected = await invalid.call('agent.context', f.input).then(value => ({ value }), error => ({ error }))
  expect(rejected).toMatchObject({ error: { code: 'AGENT_CAPABILITY_INVALID' } })
  expect(f.forward).not.toHaveBeenCalled(); expect(f.sources).not.toHaveBeenCalled()
  await expect(f.remote.forwardRpc!('agent.rename', { agentSessionId: f.input.agentSessionId, name: 'Do not rename', expectedNameRevision: 0 },
    { caller: f.a.credentials })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  expect((await f.wires()).find(q => q.method === 'agent.rename')).toMatchObject({ callerSID: f.a.credentials.agentSessionId, hasCapability: true })
  expect(f.bAuthorize).toHaveBeenCalledWith(f.a.capability, f.a.credentials.agentSessionId)
  // The unchanged write authorization may inspect its original retained caller catalogue.
  expect(f.sources.mock.calls.every(args => args.length === 0)).toBe(true)
})

it('remote context: exact target, route, cursor and original Runtime fence reject substitutions', async () => {
  const f = await fixture()
  const first = await f.rpc.call('agent.context', f.input)
  await expect(f.rpc.call('agent.context', { ...f.input, hostId: 'missing' })).rejects.toMatchObject({ code: 'UNKNOWN_HOST' })
  await expect(f.rpc.call('agent.context', { ...f.input, agentSessionId: 'missing' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  await expect(f.rpc.call('agent.context', { ...f.input, agentSessionId: 'unrelated-0', cursor: first.nextCursor! }))
    .rejects.toMatchObject({ code: 'AGENT_CONTEXT_SOURCE_CHANGED' })
  const envelope = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString())
  await expect(f.rpc.call('agent.context', { ...f.input, cursor: Buffer.from(JSON.stringify({ ...envelope, sourceHostId: 'foreign-source' })).toString('base64url') }))
    .rejects.toMatchObject({ code: 'AGENT_CONTEXT_SOURCE_CHANGED' })
  f.replaceOwner()
  await expect(f.rpc.call('agent.context', f.input)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  for (const control of f.b.controls.slice(0, 5)) expect(control).not.toHaveBeenCalled()
})

it('remote context: the method-local boundary preserves original cancellation, principal and device forwarding', async () => {
  const f = await fixture()
  const b = new AgentMuxRpcService(f.options); cleanup.push(() => b.dispose())
  const page = await b.call('agent.context', { ...f.input, hostId: 'local' })
  const forward = vi.fn(async (_method: string, _params: unknown, _context: unknown) => page)
  const borrowed = Object.assign(Object.create(f.remote) as typeof f.remote, { forwardRpc: forward })
  const service = new AgentMuxRpcService({ coreClients: () => [...f.a.coreClients(), { hostId: 'saved-b', client: borrowed }] })
  cleanup.push(() => service.dispose())
  const controller = new AbortController(), assertCurrent = vi.fn(), forwarding = vi.fn()
  const principal = { kind: 'device' as const, id: 'original-device' }
  const context = { caller: f.a.credentials, signal: controller.signal, principal, forwarding, assertCurrent, transport: 'unix' as const }
  await service.call('agent.context', f.input, context)
  expect(forward.mock.calls[0]?.[2]).toEqual({ signal: controller.signal, principal, forwarding, assertCurrent, transport: 'unix' })
  await expect(f.remote.forwardRpc!('agent.context', { ...f.input, hostId: 'local' }, { principal }))
    .rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
})
