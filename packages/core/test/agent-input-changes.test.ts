import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { realpath, writeFile } from 'node:fs/promises'
import { hashAgentCapability } from '../src/agent-capability.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { ingressFixture } from '../../connectors/test/fixtures/ingress.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { messageJournalIo } from './helpers/message-journal-io.js'
import { parseAgentInputChangesPage, parseAgentInputChangesRead, type AgentInputChangesPage } from '../src/agent-input-changes.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import type { AgentInputSubmissionReceipt } from '../src/agent-input-wait.js'

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const loader = new URL('./fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url)
const cliEnv = (root: string) => objectCliEnvironment(root, process.env.AGENTMUX_TEST_INPUT_CHANGES_CLI_LOADED ? { AGENTMUX_RESUMED_INBOX_CLI_LOADED: process.env.AGENTMUX_TEST_INPUT_CHANGES_CLI_LOADED } : {})
const trusted = { principal: { kind: 'user' as const, id: 'reader' } }
const key = (submissionId: string) => ({ kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId })
const input = (operationId: string) => ({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId, prompt: 'Private original body', admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const, authorHuman: true, sourceChannel: 'message-tool' as const })
async function owner() {
  const h = await rpcOwnerFixture(['recipient', 'other']); cleanup.push(h.close)
  h.inner.connected = false; h.inner.kernel.isConnected = () => false
  return { ...h, queue: new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath()) }
}
async function wait(h: Awaited<ReturnType<typeof owner>>, id: string) {
  const receipt = await h.client.submitAgentPrompt(input(id)) as AgentInputSubmissionReceipt
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: key(id) }))?.control.waiting?.phase).toBe('runtime')
  return receipt
}

it('actual source CLI rediscovers an offline stopped and rejoined original input without inventing prior stages', async () => {
  const h = await owner(), original = await wait(h, 'offline-original')
  const path = join(h.root, 'input-changes.sock'), server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  async function cli(read: Record<string, unknown>) {
    const result = await runSourceObjectCli(['--endpoint', 'unix://' + path, 'agent', 'input', 'changes', '--input', '-'], cliEnv(h.root), JSON.stringify({ hostId: 'local', agentSessionId: 'recipient', ...read }), 30_000, loader)
    expect(result.code, result.stderr + result.stdout).toBe(0)
    return JSON.parse(result.stdout).result as AgentInputChangesPage
  }
  const initial = await cli({}); expect(initial.changes).toEqual([]); expect(initial.checkpoint).not.toBeNull()
  await h.client.stopAgentInputWaiting({ ref: original.ref, cancelOperationId: 'stop-original' })
  const rejoined = await h.client.rejoinAgentInputWaiting({ ref: original.ref })
  expect(rejoined).toMatchObject({ key: original.key, ref: { waitGeneration: 2 }, status: 'waiting' })
  await expect.poll(async () => (await h.client.inspectAgentInput({ key: original.key }))?.control.waiting?.phase).toBe('runtime')
  const changed = await cli({ after: initial.checkpoint })
  expect(changed.changes.map(item => item.key)).toEqual([original.key])
  expect(changed.changes[0]!.controlSequence).toBeGreaterThan(initial.checkpoint!.sequence)
  expect(Object.keys(changed.changes[0]!)).toEqual(['key', 'controlSequence'])
  expect(JSON.stringify(changed)).not.toContain('Private original body')
  expect(await h.client.readAgentInputChanges({ agentSessionId: 'recipient', after: changed.checkpoint! })).toMatchObject({ changes: [], nextCursor: null })
  const discovery = await runSourceObjectCli(['agent', '--skill'], cliEnv(h.root), '', 30_000, loader)
  expect(discovery.code, discovery.stderr).toBe(0); expect(discovery.stdout).toContain('agent input changes')
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('public and source CLI preserve external message keys alongside prompt keys and their original inspection', async () => {
  const f = await ingressFixture(false, undefined, undefined, { publication: 'future-shared-conversation' }); cleanup.push(f.close)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'external-changes.sock'), coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const service = new AgentMuxRpcService({ coreClients: f.coreClients })
  const scope = { hostId: 'local', agentSessionId: f.input.agentSessionId }
  const start = await service.call('agent.input.changes', scope, trusted)
  const received = await f.receive(), sent = await f.ingress.dispatch(received.ingress.ingressId)
  expect(sent.inputReceipt?.key.kind).toBe('message')
  await f.client.submitAgentPrompt({ ...input('alongside'), agentSessionId: f.input.agentSessionId, expectedRun: f.session.run })
  const cli = await runSourceObjectCli(['--endpoint', 'unix://' + join(f.root, 'external-changes.sock'), 'agent', 'input', 'changes', '--input', '-'], cliEnv(f.root), JSON.stringify({ ...scope, after: start.checkpoint }), 30_000, loader)
  expect(cli.code, cli.stderr + cli.stdout).toBe(0)
  const page = JSON.parse(cli.stdout).result
  expect(page.changes.map((item: any) => item.key)).toEqual(expect.arrayContaining([sent.inputReceipt!.key, { kind: 'prompt', agentSessionId: f.input.agentSessionId, expectedRun: f.session.run, submissionId: 'alongside' }]))
  expect(page.changes).toHaveLength(2)
  expect(JSON.stringify(page)).not.toContain(f.event().body)
  const inspected = await service.call('agent.input.inspect', { key: sent.inputReceipt!.key }, trusted)
  expect(inspected.input).toMatchObject({ key: sent.inputReceipt!.key, status: 'waiting', originalControlOperationId: expect.any(String) })
})

it('keeps finite cuts over multiple pages and rediscovers a key that moves beyond the cut', async () => {
  const h = await owner(), start = await h.client.readAgentInputChanges({ agentSessionId: 'recipient' })
  const originals = []
  for (const id of ['first', 'second', 'third']) originals.push(await wait(h, id))
  const first = await h.client.readAgentInputChanges({ agentSessionId: 'recipient', after: start.checkpoint!, limit: 1 })
  expect(first.changes[0]!.key).toEqual(key('first')); expect(first.checkpoint).toBeNull(); expect(first.nextCursor).not.toBeNull()
  await h.client.stopAgentInputWaiting({ ref: originals[1]!.ref, cancelOperationId: 'stop-moved' })
  const second = await h.client.readAgentInputChanges({ agentSessionId: 'recipient', cursor: first.nextCursor!, limit: 1 })
  expect(second.changes.map(item => item.key)).toEqual([key('third')]); expect(second.nextCursor).toBeNull()
  expect(second.checkpoint!.sequence).toBe(first.throughSequence)
  const next = await h.client.readAgentInputChanges({ agentSessionId: 'recipient', after: second.checkpoint! })
  expect(next.changes.map(item => item.key)).toEqual([key('second')])
  const reopened = new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
  expect(await reopened.readInputChanges({ agentSessionId: 'recipient', cursor: first.nextCursor! }, async () => {})).toEqual(second)
  const registration = `import { register } from 'node:module'; register(${JSON.stringify(loader.href)}, ${JSON.stringify(import.meta.url)});`
  const script = `const {DurableAgentMuxMessageQueue}=await import(${JSON.stringify(new URL('../src/agent-global-message-queue.ts', import.meta.url).href)});const q=new DurableAgentMuxMessageQueue(process.env.AGENTMUX_MESSAGE_QUEUE_PATH);console.log(JSON.stringify(await q.readInputChanges(${JSON.stringify({ agentSessionId: 'recipient', cursor: first.nextCursor, limit: 1 })},async()=>{})));`
  const independent = await promisify(execFile)(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(registration), '--input-type=module', '--eval', script], { env: cliEnv(h.root), timeout: 30_000 })
  expect(JSON.parse(independent.stdout)).toEqual(second)
})

it('reauthorizes every original page and preserves input after foreign, revoked and source errors', async () => {
  const h = await owner(), original = await wait(h, 'authorized')
  const start = await h.client.readAgentInputChanges({ agentSessionId: 'recipient' }, h.credentials)
  const service = new AgentMuxRpcService({ coreClients: h.coreClients })
  await expect(service.call('agent.input.changes', { hostId: 'local', agentSessionId: 'other' }, { caller: h.credentials })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('agent.input.changes', { hostId: 'elsewhere', agentSessionId: 'recipient' }, { caller: h.credentials })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(service.call('agent.input.changes', { hostId: 'local', agentSessionId: 'recipient' }, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  for (const after of [{ ...start.checkpoint!, incarnation: 'replaced-source' }, { ...start.checkpoint!, queueId: 'foreign-queue' }, { ...start.checkpoint!, sequence: Number.MAX_SAFE_INTEGER }]) {
    await expect(h.client.readAgentInputChanges({ agentSessionId: 'recipient', after })).rejects.toMatchObject({ code: 'AGENT_INPUT_CHANGE_SOURCE_CHANGED' })
  }
  await expect(h.client.readAgentInputChanges({ agentSessionId: 'other', after: start.checkpoint! })).rejects.toMatchObject({ code: 'INVALID_AGENT_INPUT_READ' })
  await expect(h.client.readAgentInputChanges({ agentSessionId: 'recipient', after: start.checkpoint! }, { ...h.credentials, capability: 'revoked' })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  const stored = (await h.store.load()).find(session => session.agentSessionId === 'recipient')!
  await h.store.compareAndSwap(stored, { ...stored, capabilityHash: hashAgentCapability('replacement-capability') })
  await expect(h.client.readAgentInputChanges({ agentSessionId: 'recipient', after: start.checkpoint! }, h.credentials)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect((await h.client.inspectAgentInput({ key: original.key }))?.status).toBe('waiting')
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('uses actual Hosted SDK and forwarded public routes with strict source and parameter fences', async () => {
  const h = await owner(), path = join(h.root, 'hosted-changes.sock')
  const host = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client)); cleanup.push(() => host.dispose())
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients, hostedRuntime: () => host })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => rpc.dispose())
  vi.spyOn(h.client, 'connect').mockRejectedValue(new Error('Unrelated Runtime observation unavailable'))
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false }); cleanup.push(() => hosted.dispose())
  const start = await hosted.readAgentInputChanges({ agentSessionId: 'recipient' })
  await wait(h, 'through-hosted')
  const page = await hosted.readAgentInputChanges({ agentSessionId: 'recipient', after: start.checkpoint! })
  expect(page.changes.map(item => item.key)).toEqual([key('through-hosted')])
  await expect(hosted.readAgentInputChanges({ agentSessionId: 'recipient', caller: h.credentials } as any)).rejects.toMatchObject({ code: 'INVALID_AGENT_INPUT_READ' })
  const local = new AgentMuxRpcService({ coreClients: h.coreClients })
  const routed = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'original-route', client: { forwardRpc: (method: any, params: any, context: any) => local.call(method, params, context) } as any }] })
  const result = await routed.call('agent.input.changes', { hostId: 'original-route', agentSessionId: 'recipient', after: start.checkpoint! }, trusted)
  expect(result).toEqual({ ...page, hostId: 'original-route' })
})

it('strict public parsing accepts only source-bound metadata pages and finite request positions', async () => {
  const h = await owner(), start = await h.client.readAgentInputChanges({ agentSessionId: 'recipient' })
  await wait(h, 'strict')
  const read = { agentSessionId: 'recipient', after: start.checkpoint! }, page = await h.client.readAgentInputChanges(read)
  expect(parseAgentInputChangesPage(page, read)).toEqual(page)
  for (const alter of [(p: any) => { p.changes[0].body = 'private' }, (p: any) => { p.source.incarnation = 'wrong' },
    (p: any) => { p.checkpoint.sequence++ }, (p: any) => { p.changes[0].key.agentSessionId = 'other' },
    (p: any) => { p.changes.push(p.changes[0]) }, (p: any) => { p.nextCursor = { after: p.checkpoint, throughSequence: p.throughSequence } }]) {
    const copy = structuredClone(page); alter(copy)
    expect(() => parseRpcNativeResult('agent.input.changes', { ...copy, hostId: 'local' }, { ...read, hostId: 'local' })).toThrow()
  }
  for (const invalid of [{ ...read, limit: 101 }, { ...read, limit: 0 }, { ...read, cursor: { after: start.checkpoint!, throughSequence: 0 } }, { agentSessionId: 'recipient', cursor: { after: { ...start.checkpoint!, sequence: 5 }, throughSequence: 4 } }]) expect(() => parseAgentInputChangesRead(invalid)).toThrow()
})

it('reads unchanged large original history through the control index with bounded journal IO', async () => {
  const h = await owner(), original = await wait(h, 'measured')
  const start = await h.client.readAgentInputChanges({ agentSessionId: 'recipient' })
  const io = await messageJournalIo(); cleanup.push(() => io.close()); io.target(await realpath(h.client.agentMessageQueuePath()))
  io.reset(); await h.client.readAgentInputChanges({ agentSessionId: 'recipient', after: start.checkpoint! }); const before = io.stats()
  for (let i = 0; i < 120; i++) {
    const agentSessionId = i % 2 ? 'recipient' : 'other'
    const saved = await h.queue.savePromptInput({ key: { ...key('old-' + i), agentSessionId }, admissionIntent: { kind: 'manual-actor', expectedRun: original.key.expectedRun }, execution: 'immediate', environment: { providerId: 'codex', executorId: 'codex' }, source: { kind: 'prompt', prompt: 'Unrelated retained history '.repeat(200) } })
    await h.queue.stopInputWaiting(saved!.control.ref, 'cancel-old-' + i, false)
  }
  const current = await h.client.readAgentInputChanges({ agentSessionId: 'recipient' })
  io.reset(); const empty = await h.client.readAgentInputChanges({ agentSessionId: 'recipient', after: current.checkpoint! }); const after = io.stats()
  expect(empty.changes).toEqual([]); expect(after.readBytes).toBeLessThanOrEqual(before.readBytes * 2 + 65536); expect(after.writes).toBe(0)
  const db = new DatabaseSync(h.client.agentMessageQueuePath())
  try {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT i.control_sequence FROM input_intents i WHERE i.recipient_id=? AND i.control_sequence>? AND i.control_sequence<=? ORDER BY i.control_sequence LIMIT ?').all('recipient', current.checkpoint!.sequence, current.checkpoint!.sequence, 26)
    expect(JSON.stringify(plan)).toContain('input_recipient_control')
    expect(db.prepare("SELECT count(*) AS count FROM input_intents WHERE recipient_id='recipient'").get()!.count).toBe(61)
    db.exec('DROP INDEX input_recipient_control')
  } finally { db.close() }
  io.reset(); await h.client.readAgentInputChanges({ agentSessionId: 'recipient', after: current.checkpoint! }); const indexConstruction = io.stats()
  io.reset(); await h.client.readAgentInputChanges({ agentSessionId: 'recipient', after: current.checkpoint! }); const steady = io.stats()
  expect(indexConstruction.writes).toBeGreaterThan(0); expect(steady.writes).toBe(0)
  if (process.env.AGENTMUX_TEST_INPUT_CHANGES_COST) await writeFile(process.env.AGENTMUX_TEST_INPUT_CHANGES_COST,
    JSON.stringify({ originalInputs: 121, selectedRecipientInputs: 61, before, after, indexConstruction, steady }))
})
