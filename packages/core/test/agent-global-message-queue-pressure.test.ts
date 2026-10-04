import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { DurableAgentMuxMessageQueue, type AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'
import { AgentMuxControlServer } from '../src/control-host.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { privateRpcCorePort } from './helpers/private-rpc-core.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

type Fault = { kind: 'partial' | 'short' | 'file-sync' | 'dir-sync' | 'rename' | 'open' | 'read' | 'chmod';
  code: string; remaining: number; afterRename?: number }
const io = vi.hoisted(() => ({ path: '', fault: undefined as Fault | undefined, triggered: 0,
  renames: 0, written: [] as { path: string; bytes: number }[], syncs: [] as string[], candidates: 0, maxCandidates: 0,
  observeMemory: false, memory: [] as ReturnType<typeof process.memoryUsage>[] }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const sample = () => { if (io.observeMemory && io.memory.length < 32) io.memory.push(process.memoryUsage()) }
  const error = () => Object.assign(new Error(`private storage ${io.fault!.code}`), { code: io.fault!.code })
  const consume = (kind: Fault['kind']) => {
    if (!io.fault || io.fault.kind !== kind || !io.fault.remaining || io.renames < (io.fault.afterRename ?? 0)) return false
    io.fault.remaining--; io.triggered++; return true
  }
  const temporary = (path: string) => path.startsWith(`${io.path}.`) && path.endsWith('.tmp')
  return { ...fs,
    async chmod(path: Parameters<typeof fs.chmod>[0], mode: Parameters<typeof fs.chmod>[1]) {
      if (String(path) === `${io.path}.mutex.sqlite` && consume('chmod')) throw error()
      return fs.chmod(path, mode)
    },
    async readFile(...args: Parameters<typeof fs.readFile>) {
      if (String(args[0]) === io.path && consume('read')) throw error()
      const result = await fs.readFile(...args); sample(); return result
    },
    async rename(from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) {
      if (String(to) === io.path) {
        if (consume('rename')) throw error()
        await fs.rename(from, to); io.renames++; io.candidates--; return
      }
      return fs.rename(from, to)
    },
    async unlink(path: Parameters<typeof fs.unlink>[0]) {
      const result = await fs.unlink(path); if (temporary(String(path))) io.candidates--; return result
    },
    async open(...args: Parameters<typeof fs.open>) {
      const path = String(args[0]), relevant = path === io.path || temporary(path)
      if (relevant && consume('open')) throw error()
      const handle = await fs.open(...args)
      if (temporary(path) && String(args[1]).includes('x')) {
        io.candidates++; io.maxCandidates = Math.max(io.maxCandidates, io.candidates)
      }
      if (!relevant && path !== dirname(io.path)) return handle
      return new Proxy(handle, { get(target, key) {
        if (key === 'sync') return async () => {
          sample(); io.syncs.push(path)
          if ((relevant && consume('file-sync')) || (path === dirname(io.path) && consume('dir-sync'))) throw error()
          return target.sync()
        }
        if (key === 'write' || key === 'writeFile') return async (value: string | Uint8Array, ...rest: unknown[]) => {
          const bytes = Buffer.from(value); sample()
          if (consume('partial')) { await target.write(bytes.subarray(0, Math.min(17, bytes.length))); throw error() }
          if (key === 'write' && consume('short')) {
            await target.write(bytes.subarray(0, 17)); return { bytesWritten: 17, buffer: value }
          }
          io.written.push({ path, bytes: bytes.length })
          if (key === 'writeFile') return target.writeFile(value)
          return Reflect.apply(target.write, target, [value, ...rest])
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
  }
})

const roots: string[] = []
const exec = promisify(execFile)
const condition = { expectedRun: { runId: 'run-recipient' }, afterSubmissionId: null }
function input(id = 'one'): AgentMuxMessageAppendInput {
  return { messageId: `message-${id}`, operationId: `operation-${id}`, createdAt: 100,
    sender: { kind: 'human', principal: 'local-cli' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
    threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null,
    senderSessionId: null, senderRunId: null, recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
    body: `exact\nbody 😀 ${id}`, execution: 'immediate', sourceChannel: 'agent-message' }
}
async function queue() {
  const root = await mkdtemp(join(tmpdir(), 'amux-journal-pressure-')); roots.push(root)
  const value = new DurableAgentMuxMessageQueue(join(root, 'messages.ndjson')); io.path = value.path
  return value
}
function fault(kind: Fault['kind'], code = 'ENOSPC', afterRename?: number) {
  io.fault = { kind, code, remaining: 1, ...(afterRename === undefined ? {} : { afterRename }) }
}
afterEach(async () => {
  io.path = ''; io.fault = undefined; io.triggered = 0; io.renames = 0; io.written = []
  io.syncs = []; io.candidates = 0; io.maxCandidates = 0; io.observeMemory = false; io.memory = []
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('journal persistence under isolated resource pressure', () => {
  it('keeps the complete live prefix after a real partial write and retries the same operation', async () => {
    const q = await queue(); const first = await q.append(input()); await q.preparePrompt(first.messageId, async () => condition)
    const before = await readFile(q.path); fault('partial')
    const error = await q.append(input('two')).catch(error => error)
    expect(io.triggered).toBe(1); expect(await readFile(q.path)).toEqual(before)
    expect(error).toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE' })
    io.fault = undefined
    const retry = await new DurableAgentMuxMessageQueue(q.path).append(input('two'))
    const { execution: _execution, sourceChannel: _sourceChannel, ...originalEnvelope } = input('two')
    expect(retry.sequence).toBe(3); expect(retry.envelope).toEqual({ schema: 'agentmux.a2a.v1', ...originalEnvelope })
    const records = await q.readJournal(); expect(records.map(row => row.sequence)).toEqual([1, 2, 3])
    expect((await q.listAfter())[0]!.promptCondition).toEqual(condition)
  })

  it('does not publish a short successful FileHandle.write as a complete record', async () => {
    const q = await queue(); fault('short')
    const receipt = await q.append(input())
    expect((await new DurableAgentMuxMessageQueue(q.path).listAfter())[0]?.envelope).toEqual(receipt.envelope)
  })

  it.each(['open', 'file-sync', 'rename'] as const)('preserves first EIO stage and original bytes at %s', async kind => {
    const q = await queue(); await q.append(input()); const before = await readFile(q.path); fault(kind, 'EIO')
    const error = await q.append(input('two')).catch(error => error)
    expect(error).toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE' })
    expect(JSON.parse(error.detail)).toMatchObject({ stage: 'journal-publish', cause: { phase: 'before-replace', code: 'EIO' } })
    expect(io.triggered).toBe(1); expect(await readFile(q.path)).toEqual(before)
    io.fault = undefined; expect((await new DurableAgentMuxMessageQueue(q.path).append(input('two'))).sequence).toBe(2)
  })

  it.each(['message', 'condition', 'delivery'] as const)('reconfirms the existing %s after a replaced but unacknowledged directory', async kind => {
    const q = await queue(); if (kind !== 'message') await q.append(input())
    const capture = vi.fn(async () => condition)
    const operation = () => kind === 'message' ? q.append(input()) : kind === 'condition'
      ? q.preparePrompt('message-one', capture) : q.recordDelivery('message-one', 'delivered', 200)
    fault('dir-sync', 'EIO', io.renames + 1)
    const original = await operation().catch(error => error)
    expect(original).toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE' })
    expect(JSON.parse(original.detail).cause.phase).toBe('after-replace')
    const replaced = await readFile(q.path); const expectedLines = replaced.toString().trim().split('\n').length
    fault('dir-sync', 'EIO')
    const refused = await operation().catch(error => error)
    expect(refused).toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE' })
    expect(io.fault?.remaining).toBe(0); expect(await readFile(q.path)).toEqual(replaced)
    io.fault = undefined; await operation()
    expect((await q.readJournal())).toHaveLength(expectedLines)
    if (kind === 'condition') expect(capture).toHaveBeenCalledTimes(1)
    if (kind === 'delivery') expect((await q.listAfter())[0]?.delivery.state).toBe('delivered')
  })

  it.each(['read', 'chmod'] as const)('preserves EACCES cause at %s and releases its created mutex', async kind => {
    const q = await queue(); await q.append(input()); fault(kind, 'EACCES')
    const error = await q.append(input('two')).catch(error => error)
    expect(error.code).toBe('MESSAGE_QUEUE_UNAVAILABLE')
    expect(JSON.parse(error.detail).cause.code).toBe('EACCES'); expect(io.triggered).toBe(1)
    io.fault = undefined; expect((await new DurableAgentMuxMessageQueue(q.path).append(input('two'))).sequence).toBe(2)
  })

  it('refuses unknown corrupt history without truncating or guessing that an old input did not happen', async () => {
    const q = await queue(); await q.append(input()); const corrupt = Buffer.concat([await readFile(q.path), Buffer.from('{"kind":')])
    await writeFile(q.path, corrupt)
    await expect(q.append(input('two'))).rejects.toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE' })
    expect(await readFile(q.path)).toEqual(corrupt)
  })

  it('does not silently rewrite malformed UTF-8 bytes in historical opaque bodies', async () => {
    const q = await queue(); await q.append(input()); const original = await readFile(q.path)
    const at = original.indexOf(Buffer.from('exact')); expect(at).toBeGreaterThan(0)
    original[at] = 255; await writeFile(q.path, original)
    await expect(q.append(input('two'))).rejects.toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE' })
    expect(await readFile(q.path)).toEqual(original)
  })

  it('returns promptly while a real second process owns the writer and allows the same operation after release', async () => {
    const q = await queue(); await q.append(input())
    const script = `import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1]);d.exec('BEGIN IMMEDIATE');process.send('held');setTimeout(()=>{d.exec('COMMIT');d.close();process.exit(0)},1400)`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, `${q.path}.mutex.sqlite`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject) })
      let beats = 0; timer = setInterval(() => beats++, 10)
      const start = performance.now(); const result = await q.append(input('two')).catch(error => error); const elapsed = performance.now() - start
      console.log('__JOURNAL_CONTENTION__', JSON.stringify({ elapsedMs: elapsed, resultCode: result.code ?? null }))
      expect(result).toMatchObject({ code: 'MESSAGE_QUEUE_BACKPRESSURE' }); expect(elapsed).toBeLessThan(700)
      await new Promise(resolve => setTimeout(resolve, 50)); expect(beats).toBeGreaterThan(1)
      expect(await exited).toBe(0); expect((await q.append(input('two'))).sequence).toBe(2)
    } finally { if (timer) clearInterval(timer); if (child.exitCode === null) { child.kill('SIGKILL'); await exited } }
  })

  it('observes bounded whole-file write amplification for small and near-default-limit journals', async () => {
    const q = await queue(); await q.append(input())
    const template = JSON.parse((await readFile(q.path, 'utf8')).trim())
    const seededJournal = (targetBytes: number) => {
      const lines: string[] = []; let bytes = 0
      for (let sequence = 1; bytes < targetBytes; sequence++) {
        const record = { ...template, sequence, envelope: { ...template.envelope,
          messageId: `seed-message-${sequence}`, operationId: `seed-operation-${sequence}`, body: '' } }
        const overhead = Buffer.byteLength(`${JSON.stringify(record)}\n`)
        if (targetBytes - bytes < overhead) break
        record.envelope.body = 'x'.repeat(Math.min(64 * 1024, targetBytes - bytes - overhead))
        const line = `${JSON.stringify(record)}\n`; lines.push(line); bytes += Buffer.byteLength(line)
      }
      return lines.join('')
    }
    for (const targetBytes of [16 * 1024, 16 * 1024 * 1024 - 2048]) {
      // Fixture construction is not queue work; the observed operation replays real complete opaque records.
      await writeFile(q.path, seededJournal(targetBytes)); const priorBytes = (await readFile(q.path)).length
      io.written = []; io.maxCandidates = 0; io.memory = [process.memoryUsage()]; io.observeMemory = true
      const baseline = io.memory[0]!; const start = performance.now()
      const key = `sized-${targetBytes}`; await q.append(input(key)); const elapsedMs = performance.now() - start
      io.memory.push(process.memoryUsage()); io.observeMemory = false
      const actual = await readFile(q.path); const write = io.written.filter(row => row.path.endsWith('.tmp'))
      expect(write).toHaveLength(1); expect(write[0]!.bytes).toBe(actual.length); expect(actual.length).toBeLessThanOrEqual(16 * 1024 * 1024)
      expect(io.maxCandidates).toBe(1)
      const sampledMax = Object.fromEntries(Object.keys(baseline).map(key => [key,
        Math.max(...io.memory.map(sample => sample[key as keyof typeof sample]))]))
      console.log('__JOURNAL_COST__', JSON.stringify({ priorBytes, writtenBytes: write[0]!.bytes, elapsedMs,
        candidateFiles: io.maxCandidates, replayedMessages: actual.toString().trim().split('\n').length,
        memory: { measurement: 'sampled at original filesystem seams and operation boundaries; not continuous process peak',
          sampleCount: io.memory.length, baseline, sampledMax } }))
    }
  })

  it('uses actual SDK admission and keeps one input when a post-input delivery ACK fails', async () => {
    const q = await queue(); const root = dirname(q.path), storePath = join(root, 'sessions.json')
    const store = new AgentMuxFileAgentSessionStore(storePath)
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'recipient', providerId: 'synthetic', executorId: 'synthetic', hostId: 'local', workspacePath: root,
      run: condition.expectedRun, retiredRuns: [], hookBindingId: 'hook', hookToken: 'token', createdAt: 1, updatedAt: 1 })
    const core = await privateRpcCorePort(storePath, q.path)
    const submit = vi.spyOn(core.client as unknown as { submitPromptInternal(input: unknown): Promise<void> }, 'submitPromptInternal')
      .mockImplementation(async () => { fault('dir-sync', 'EIO', io.renames + 1) })
    const envelope = { ...input(), schema: 'agentmux.a2a.v1' as const, messageId: 'message-one' }
    try {
      fault('partial')
      await expect(core.client.submitAgentMessage({ agentSessionId: 'recipient', envelope, condition, execution: 'immediate' })).rejects.toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE' })
      expect(submit).not.toHaveBeenCalled(); io.fault = undefined
      const afterInput = await core.client.submitAgentMessage({ agentSessionId: 'recipient', envelope, condition, execution: 'immediate' }).catch(error => error)
      expect(afterInput.code).toBe('MESSAGE_QUEUE_UNAVAILABLE'); expect(afterInput.controlFailure).toBeUndefined(); expect(submit).toHaveBeenCalledTimes(1)
      io.fault = undefined
      await core.client.submitAgentMessage({ agentSessionId: 'recipient', envelope, condition, execution: 'immediate' })
      expect(submit).toHaveBeenCalledTimes(1); expect((await q.listAfter())[0]?.delivery.state).toBe('delivered')
    } finally { await core.dispose() }
  })

  it('consumes a real compiled CLI through public RPC and retries its original ID after a storage fault', async () => {
    const q = await queue(); const root = dirname(q.path), storePath = join(root, 'sessions.json')
    const store = new AgentMuxFileAgentSessionStore(storePath)
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'recipient', providerId: 'synthetic', executorId: 'synthetic', hostId: 'local', workspacePath: root,
      run: condition.expectedRun, retiredRuns: [], hookBindingId: 'hook', hookToken: 'token', createdAt: 1, updatedAt: 1 })
    const core = await privateRpcCorePort(storePath, q.path); const sends: unknown[] = []
    // Registry identity is real; no native Provider behavior is invoked by this persisted-facts port.
    const provider = core.client.providers.list()[0]!
    core.client.providers.register({ ...provider, id: 'synthetic', label: 'Private journal target',
      catalog: { ...provider.catalog, id: 'synthetic' } })
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: core.clients,
      execute: async request => {
        if (request.operation === 'list.active-agents') return { operation: 'list.active-agents', agents: [{
          agentSessionId: 'recipient', promptCondition: condition, projectId: null, projectName: null,
          workspacePath: root, providerId: 'synthetic', executorId: 'synthetic', processState: 'running',
          status: 'active', updatedAt: 1 }] }
        if (request.operation === 'send') { sends.push(request); return { operation: 'send', agentSessionId: 'recipient' } }
        throw new Error(`Unexpected private operation ${request.operation}`)
      } })
    await server.start()
    const cli = fileURLToPath(new URL('../dist/agentmux.js', import.meta.url))
    const args = [cli, 'agent', 'send', '--to-session', 'recipient', '--text', 'opaque CLI body', '--execution', 'immediate', '--operation-id', 'cli-operation', '--message-id', 'cli-message']
    const env = { ...objectCliEnvironment(root), AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'durable'), AGENTMUX_AGENT_SESSION_STORE: storePath,
      AGENTMUX_MESSAGE_QUEUE_PATH: q.path, AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined }
    try {
      fault('partial')
      const rejected = await exec(process.execPath, args, { env, timeout: 5000 }).catch(error => error)
      console.log('__JOURNAL_CLI_REJECTED__', rejected.stderr)
      expect(rejected.stderr).toContain('MESSAGE_QUEUE_UNAVAILABLE'); expect(rejected.stderr).toContain('ENOSPC'); expect(sends).toHaveLength(0)
      io.fault = undefined
      const accepted = JSON.parse((await exec(process.execPath, args, { env, timeout: 5000 })).stdout)
      expect(accepted).toMatchObject({ ok: true, operationId: 'cli-operation', result: { messageId: 'cli-message', delivery: { state: 'delivered' } } })
      expect(sends).toHaveLength(1)
      await exec(process.execPath, args, { env, timeout: 5000 }); expect(sends).toHaveLength(1)
      expect((await q.readJournal()).filter(row => row.kind === 'message')).toHaveLength(1)
    } finally { await server.stop(); await core.dispose() }
  })
})
