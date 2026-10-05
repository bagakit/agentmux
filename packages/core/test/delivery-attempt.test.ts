import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryAttemptStore } from '../src/delivery-attempt-store.js'
import { newDeliveryLogId, type DeliveryAttempt } from '../src/delivery-attempt.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const io = vi.hoisted(() => ({ gate: null as null | Promise<void> }))
vi.mock('../src/durable-write.js', async original => {
  const actual = await original<typeof import('../src/durable-write.js')>()
  return { ...actual, durableWriteFile: async (...args: Parameters<typeof actual.durableWriteFile>) => {
    await actual.durableWriteFile(...args)
    if (io.gate) await io.gate
  } }
})
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { io.gate = null; for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function directory() { const root = await mkdtemp(fixturePath("tmp/amux-delivery-log-")); cleanup.push(() => rm(root, { recursive: true, force: true })); return root }
function record(source: 'core' | 'client' = 'client'): DeliveryAttempt {
  return { logId: newDeliveryLogId(), source, agentSessionId: 'original-session', operationId: 'original-operation', hostId: 'target-host',
    expectedRunId: 'original-run', afterSubmissionId: null, conditionAvailable: true, promptDigest: 'digest-only', execution: 'immediate',
    startedAt: 1, failedAt: 2, stage: 'core-submit', error: { name: 'Error', code: 'EIO', message: 'The original writer could not be read.', detail: 'original cause' } }
}
async function owner(ids?: string[]) { const h = await rpcOwnerFixture(ids); cleanup.push(h.close); return h }

describe('durable delivery diagnostics observe failures without admitting Input', () => {
  it('keeps the first report across restart and concurrent writers; rejects changed old facts', async () => {
    const root = await directory(), left = new DeliveryAttemptStore(root), right = new DeliveryAttemptStore(root), original = record()
    original.reporter = { kind: 'user', id: 'actual-user', routeHostId: 'local', receivedAt: 10 }
    const [first, second] = await Promise.all([left.record(original), right.record({ ...original,
      reporter: { ...original.reporter, receivedAt: 11 } })])
    expect(first.record).toEqual(second.record); expect(first.availability).toBe('found')
    expect((await stat(join(root, `${original.logId}.json`))).mode & 0o777).toBe(0o600)
    const reopened = new DeliveryAttemptStore(root)
    expect((await reopened.read(original.logId)).record).toEqual(first.record)
    await expect(reopened.record({ ...original, expectedRunId: 'replacement-run' })).rejects.toMatchObject({ code: 'DELIVERY_LOG_CONFLICT' })
    expect(JSON.parse(await readFile(join(root, `${original.logId}.json`), 'utf8'))).toEqual(first.record)
    await expect(reopened.read('../other-file')).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  })
  it('does not substitute an incoming payload when another process published a corrupt original', async () => {
    const root = await directory(), store = new DeliveryAttemptStore(root), original = record()
    let release!: () => void; io.gate = new Promise<void>(yes => { release = yes })
    const pending = store.record(original)
    await vi.waitFor(async () => expect((await store.read(original.logId)).availability).toBe('found'))
    await writeFile(join(root, `${original.logId}.json`), '{corrupt-original', { mode: 0o600 })
    io.gate = null; release()
    expect((await pending).availability).toBe('unavailable')
    expect((await store.read(original.logId)).availability).toBe('unavailable')
    expect(await readFile(join(root, `${original.logId}.json`), 'utf8')).toBe('{corrupt-original')
  })
  it('bounds diagnostic persistence independently of Input and retains exact late completion', async () => {
    const store = new DeliveryAttemptStore(await directory()), original = record('core')
    let release!: () => void; io.gate = new Promise<void>(yes => { release = yes })
    const before = Date.now(), result = await store.record(original)
    expect(Date.now() - before).toBeLessThan(1500)
    expect(result).toMatchObject({ availability: 'found', persistence: 'unconfirmed', record: original })
    expect(result.issue).toContain('pending')
    io.gate = null; release()
    await vi.waitFor(async () => expect((await store.read(original.logId)).persistence).toBe('confirmed'))
    expect((await new DeliveryAttemptStore(store.directory).read(original.logId)).record).toEqual(original)
  }, 2500)
  it('preserves ordinary structured errors, original cause, exact stage and two independent failed calls', async () => {
    const h = await owner(['caller']), original = Object.assign(new Error('actual provider plan EIO'), {
      code: 'EIO', detail: 'writer descriptor was not readable', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    const provider = h.client.providers.get('codex')
    vi.spyOn(provider, 'planPromptInput').mockImplementation(() => { throw original })
    const input = { agentSessionId: 'caller', operationId: 'same-original-operation', expectedRun: { runId: 'run-caller' },
      afterSubmissionId: null, prompt: 'private-original-body', authorHuman: true as const }
    const errors = []
    for (let index = 0; index < 2; index++) errors.push(await h.client.submitAgentPrompt(input).then(() => null, error => error))
    expect(errors[0]).toMatchObject({ code: original.code, detail: original.detail, controlFailure: original.controlFailure, cause: original })
    expect(errors[0].logId).not.toBe(errors[1].logId)
    for (const error of errors) {
      const log = await h.client.readDeliveryAttempt(error.logId)
      expect(log).toMatchObject({ availability: 'found', record: { source: 'core', stage: 'validation', operationId: input.operationId,
        expectedRunId: input.expectedRun.runId, error: { code: original.code, message: original.message, detail: original.detail } } })
      expect(JSON.stringify(log)).not.toContain(input.prompt)
    }
    expect(h.inner.kernel.attach).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    h.inner.connected = false
    const disconnected = await h.client.submitAgentPrompt(input).then(() => null, error => error)
    expect((await h.client.readDeliveryAttempt(disconnected.logId)).record?.stage).toBe('connection')
    expect((await h.client.readDeliveryAttempt(errors[0].logId)).availability).toBe('found')
  })
  it.each(['unix', 'http'] as const)('reports, inspects and returns original diagnostic IDs through actual %s RPC', async transport => {
    const root = await directory(), store = new DeliveryAttemptStore(join(root, 'reports')), original = record()
    const error = new AgentMuxError('actual input refused', 'ORIGINAL_CODE', 'original detail', { disposition: 'unknown', confirmedInputBytes: 7 }, newDeliveryLogId())
    const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: () => [],
      deliveryAttempts: { hostId: 'receiving-host', store }, http: { host: '127.0.0.1', port: 0, token: 'private-test-token' },
      execute: async () => { throw error } })
    await server.start(); cleanup.push(() => server.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: transport === 'unix' ? { transport, path: join(root, 'owner.sock') }
      : { transport, url: `http://127.0.0.1:${server.httpAddress!.port}/`, token: 'private-test-token' } })
    cleanup.push(() => rpc.dispose())
    const reported = await rpc.call('message.delivery.report', { hostId: 'receiving-host', record: original })
    expect(reported).toMatchObject({ availability: 'found', persistence: 'confirmed', record: { ...original,
      reporter: { kind: 'user', routeHostId: 'receiving-host' } } })
    const again = await rpc.call('message.delivery.report', { hostId: 'receiving-host', record: original })
    expect(again.record).toEqual(reported.record)
    expect((await rpc.call('message.delivery.inspect', { hostId: 'receiving-host', logId: original.logId })).record).toEqual(reported.record)
    expect(await rpc.call('message.delivery.inspect', { hostId: 'other-host', logId: original.logId })).toMatchObject({ availability: 'unavailable', record: null })
    await expect(rpc.call('message.delivery.report', { hostId: 'receiving-host', record: { ...original, source: 'core' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(rpc.call('space.ls', { target: {} })).rejects.toMatchObject({ code: error.code, detail: error.detail, controlFailure: error.controlFailure, logId: error.logId })
  })
  it('preserves Core failure and its old log through Hosted SDK and the actual RPC owner while offline', async () => {
    const h = await owner(['hosted-session']), root = await directory()
    Object.assign(h.inner.kernel, { identity: () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 18, buildIdentity: 'private-fixture' }),
      list: async () => [h.run('run-hosted-session')] })
    const service = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client))
    cleanup.push(() => service.dispose())
    const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: h.coreClients, hostedRuntime: () => service })
    await server.start(); cleanup.push(() => server.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'owner.sock') } })
    cleanup.push(() => rpc.dispose())
    const client = await connectHostedAgentMux({ rpc }); cleanup.push(() => client.dispose())
    const original = Object.assign(new Error('actual Hosted provider EIO'), { code: 'EIO', detail: 'original provider failure',
      controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    vi.spyOn(h.client.providers.get('codex'), 'planPromptInput').mockImplementation(() => { throw original })
    const error = await client.submitAgentPrompt({ agentSessionId: 'hosted-session', operationId: 'original-hosted-operation',
      expectedRun: { runId: 'run-hosted-session' }, afterSubmissionId: null, authorHuman: true, prompt: 'original private Hosted body' })
      .then(() => null, failure => failure)
    expect(error).toMatchObject({ code: original.code, detail: original.detail, controlFailure: original.controlFailure, logId: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{12}$/u) })
    const first = await client.readDeliveryAttempt(error.logId)
    expect(first).toMatchObject({ availability: 'found', record: { source: 'core', operationId: 'original-hosted-operation',
      error: { message: original.message, detail: original.detail } } })
    const connect = vi.spyOn(h.client, 'connect')
    h.inner.connected = false
    expect((await client.readDeliveryAttempt(error.logId)).record).toEqual(first.record)
    expect(connect).not.toHaveBeenCalled()
    expect(h.inner.kernel.attach).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
  it('does not let an authenticated Agent from a different original Core Host read client reports', async () => {
    const local = await owner(['local-agent']), remote = await owner(['remote-agent']), journal = new DeliveryAttemptStore(await directory()), original = record()
    await journal.record(original)
    // A configured Hosted route retains its original local Store metadata. The
    // SDK registry and capability authorization still use their real owners.
    const forwardRpc = vi.fn(async () => { throw new Error('Unexpected remote write') })
    Object.assign(remote.client, { forwardRpc })
    const read = vi.spyOn(journal, 'read'), service = new AgentMuxRpcService({ deliveryAttempts: { hostId: 'local', store: journal },
      coreClients: () => [{ hostId: 'local', client: local.client }, { hostId: 'remote', client: remote.client }] })
    cleanup.push(() => service.dispose())
    await expect(service.call('message.delivery.inspect', { logId: original.logId, hostId: 'local' }, { caller: remote.credentials }))
      .rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(read).not.toHaveBeenCalled()
    expect(forwardRpc).not.toHaveBeenCalled()
    expect((await service.call('message.delivery.inspect', { logId: original.logId }, { caller: remote.credentials })).availability).toBe('not-found')
    expect(read).not.toHaveBeenCalled()
    expect((await service.call('message.delivery.inspect', { logId: original.logId, hostId: 'local' }, { caller: local.credentials })).record).toEqual(original)
    await expect(service.call('message.delivery.report', { hostId: 'local', record: original }, { caller: local.credentials }))
      .rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  })
  it('reads the original immutable failure through the actual public CLI process', async () => {
    const root = await directory(), store = new DeliveryAttemptStore(join(root, 'reports')), original = record()
    const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: () => [],
      deliveryAttempts: { hostId: 'original-owner', store } })
    await store.record(original); await server.start(); cleanup.push(() => server.stop())
    const { build } = await import('esbuild')
    const entry = fileURLToPath(new URL('../src/agentmux.ts', import.meta.url)), output = join(root, 'agentmux.mjs')
    await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'))
    const built = await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm',
      packages: 'external', target: 'node24', metafile: true })
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) delete env[key]
    const execute = (args: string[]) => new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      // The bundle lives in a private directory: resolve only original installed deps.
      const child = spawn(process.execPath, [output, '--endpoint', `unix://${join(root, 'owner.sock')}`, ...args], { env })
      let stdout = '', stderr = ''
      child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
      child.on('error', reject); child.on('close', exit => resolve({ exit, stdout, stderr }))
    })
    const result = await execute(['message', 'delivery', 'inspect', '--logid', original.logId, '--host-id', 'original-owner'])
    expect(result.exit, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operation: 'message.delivery.inspect',
      result: { availability: 'found', record: original } })
    const help = await execute(['message', 'delivery', 'inspect', '--help'])
    expect(help.exit, help.stderr).toBe(0); expect(help.stdout).toContain('--logid ID')
    expect(Object.keys(built.metafile.inputs).length).toBeGreaterThan(0)
    const evidence = process.env.AGENTMUX_T031_EVIDENCE
    if (evidence) {
      await writeFile(join(evidence, 'public-cli.metafile.json'), JSON.stringify(built.metafile))
      await writeFile(join(evidence, 'public-cli.actual.json'), JSON.stringify({ result, help, logId: original.logId, record: original }))
      await writeFile(join(evidence, 'public-cli.actual.mjs'), await readFile(output))
    }
  }, 15_000)
})
