import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { AgentExecutionJournal } from '../src/agent-execution-journal.js'
import { createAgentExecutionExecutor } from '../src/agent-execution-executor.js'
import type { AgentExecutionIntent, AgentExecutionProtocol } from '../src/agent-execution-protocol.js'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

type Frame = { type: string; state?: string; generation: string; scope?: string; operation?: import('../src/agent-execution-journal.js').AgentExecutionOperationKey; code?: string; payload?: { id?: number; method?: string; result?: Record<string, unknown>; error?: { code: number } } }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const native = String.raw`
  const {createInterface}=require('node:readline');const fs=require('node:fs');
  let count=0;process.stderr.write('private-native-stderr');
  (async()=>{for await(const line of createInterface({input:process.stdin})){
    const request=JSON.parse(line);fs.appendFileSync(process.argv[1],request.method+'\n');
    if(request.method==='hang')continue;
    if(request.method==='die')process.exit(3);
    if(request.method==='notice')continue;
    if(request.method==='echo-event')process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'native-event',params:{sequence:1}})+'\n');
    if(request.method==='hold-save'){fs.appendFileSync(process.argv[2],'effect\n');count++;await new Promise(resolve=>{const check=()=>{if(fs.existsSync(process.argv[3])){watcher.close();resolve();}};const watcher=fs.watch(require('node:path').dirname(process.argv[3]),check);check();});}
    if(request.method==='save'){fs.appendFileSync(process.argv[2],'effect\n');count++;await new Promise(r=>setTimeout(r,50));}
    process.stdout.write('  '+JSON.stringify({jsonrpc:'2.0',id:request.id,result:{pid:process.pid,count}})+' \n');
  }})();`

async function fixture(executable = process.execPath, contribution: Pick<AgentExecutionProtocol, 'concurrentConnections' | 'projectResponse'> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'amux-executor-test-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const journal = await AgentExecutionJournal.open(join(root, 'journal'))
  cleanup.push(() => journal.close())
  const input = new PassThrough(), output = new PassThrough(), stderr = new PassThrough()
  const frames: Frame[] = [], events = new EventEmitter(), errors: Error[] = [], grants: { bindingId: string; generation: string; intent: AgentExecutionIntent }[] = []
  let allowed = true, privateError = ''
  stderr.on('data', chunk => { privateError += chunk.toString() })
  const lines = createInterface({ input: output })
  lines.on('line', line => { const frame = JSON.parse(line) as Frame; frames.push(frame); events.emit('frame', frame) })
  const log = join(root, 'native.log'), effects = join(root, 'effects'), release = join(root, 'release')
  const protocol: AgentExecutionProtocol = {
    ...contribution,
    executor: { command: executable, args: ['-e', native, log, effects, release], cwd: root },
    parseServer(payload) {
      const p = payload as Record<string, unknown>
      if (p.method === 'native-event') return { kind: 'notification', method: p.method, payload: p }
      return protocol.parse(payload)
    },
    parse(payload) {
      const p = payload as { id: number; method?: string; params?: Record<string, unknown>; result?: unknown }
      if (Object.hasOwn(p, 'result')) return { kind: 'response', requestId: p.id, payload: p }
      if (p.method === 'notice') return { kind: 'notification', method: p.method, payload: p }
      if (!['hello', 'save', 'hold-save', 'echo', 'echo-event', 'hang', 'die', 'open-resource', 'use-resource', 'close-resource'].includes(p.method!)) {
        return { kind: 'rejected', requestId: p.id, code: -32601, reason: 'Unknown native method', payload: p }
      }
      const intent: AgentExecutionIntent = { kind: ['save', 'hold-save'].includes(p.method!) ? 'write' : 'control', paths: [] }
      if (p.method === 'hello') {
        intent.initialize = true
        if (p.params?.resume !== undefined) intent.resumeSessionId = String(p.params.resume)
      }
      if (p.method?.endsWith('-resource')) intent.handle = { kind: 'file', id: String(p.params?.handle), action: p.method === 'open-resource' ? 'create' : p.method === 'use-resource' ? 'use' : 'close' }
      return { kind: 'request', requestId: p.id, method: p.method!, params: p.params ?? null, payload: p, intent }
    },
  }
  const executor = createAgentExecutionExecutor({ bindingId: 'fixed-binding', journal, protocol, input, output, stderr,
    async authorize(target) { grants.push(target); if (!allowed) throw new Error('not authorized') }, onError(error) { errors.push(error) } })
  cleanup.push(async () => { await executor.dispose(); input.destroy(); output.destroy(); stderr.destroy(); lines.close() })
  const send = (id: number, method: string, generation = 'original', params?: Record<string, unknown>) => {
    input.write(JSON.stringify({ type: 'request', bindingId: 'untrusted-frame-target', generation, payload: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } }) + '\n')
  }
  const wait = (predicate: (frame: Frame) => boolean, from = 0): Promise<Frame> => {
    const previous = frames.slice(from).find(predicate)
    if (previous) return Promise.resolve(previous)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { events.off('frame', listener); reject(new Error('Exact executor frame was not observed')) }, 3000)
      const listener = (frame: Frame) => { if (predicate(frame)) { clearTimeout(timer); events.off('frame', listener); resolve(frame) } }
      events.on('frame', listener)
    })
  }
  const reply = (id: number, from = 0) => wait(frame => frame.type === 'response' && frame.payload?.id === id, from)
  const initialize = async (generation = 'original') => { send(0, 'hello', generation); return wait(frame => frame.type === 'response' && frame.generation === generation && frame.payload?.id === 0) }
  return { journal, input, output, executor, frames, grants, errors, log, effects, send, wait, reply, initialize,
    closeGeneration(generation = 'original') { input.write(JSON.stringify({ type: 'closed', generation }) + '\n') },
    release() { return writeFile(release, '') },
    allow(value: boolean) { allowed = value }, privateError: () => privateError }
}

describe('resource executor original native stream', () => {
  it('keeps independent concurrent Provider connections and identical request IDs on their original generations', async () => {
    const h = await fixture(process.execPath, { concurrentConnections: true })
    const first = Number((await h.initialize('main')).payload!.result!.pid)
    const initialized = await h.initialize('subagent')
    expect(initialized.payload!.result).toBeDefined()
    const second = Number(initialized.payload!.result!.pid)
    expect(second).not.toBe(first)
    h.send(1, 'save', 'main'); h.send(1, 'echo', 'subagent')
    expect((await h.wait(frame => frame.type === 'response' && frame.generation === 'main' && frame.payload?.id === 1)).payload!.result).toEqual({ pid: first, count: 1 })
    expect((await h.wait(frame => frame.type === 'response' && frame.generation === 'subagent' && frame.payload?.id === 1)).payload!.result).toEqual({ pid: second, count: 0 })
    h.closeGeneration('main')
    await h.wait(frame => frame.type === 'generation' && frame.generation === 'main')
    h.send(2, 'save', 'main'); h.send(2, 'echo', 'subagent')
    expect((await h.wait(frame => frame.type === 'response' && frame.generation === 'main' && frame.payload?.id === 2)).payload!.error!.code).toBe(-32002)
    expect((await h.wait(frame => frame.type === 'response' && frame.generation === 'subagent' && frame.payload?.id === 2)).payload!.result!.pid).toBe(second)
    expect(await readFile(h.effects, 'utf8')).toBe('effect\n')
    for (const streamGeneration of ['main', 'subagent']) expect(await h.journal.inspect({ bindingId: 'fixed-binding', streamGeneration, nativeRequestId: 1 })).toMatchObject({ phase: 'completed' })
  })

  it('projects the exact request response after raw native journal completion, including completed replay', async () => {
    const projected = vi.fn((request, response) => request.method === 'save' ? { ...response, result: { public: true } } : response)
    const h = await fixture(process.execPath, { projectResponse: projected }); await h.initialize()
    h.send(1, 'save')
    expect((await h.reply(1)).payload!.result).toEqual({ public: true })
    const key = { bindingId: 'fixed-binding', streamGeneration: 'original', nativeRequestId: 1 }
    const operation = (await h.journal.inspect(key))!
    const original = Buffer.from((await h.journal.readResult(key, operation.payloadDigest))!).toString()
    expect(original.startsWith('  {')).toBe(true)
    expect(JSON.parse(original).result.count).toBe(1)
    const cursor = h.frames.length
    h.send(1, 'save')
    expect((await h.reply(1, cursor)).payload!.result).toEqual({ public: true })
    expect(projected.mock.calls.filter(([request]) => request.method === 'save')).toHaveLength(2)
    expect(await readFile(h.effects, 'utf8')).toBe('effect\n')
  })

  it('executes a pending request once, returns its original completed response and retains exact private bytes', async () => {
    const h = await fixture(), initialized = await h.initialize(), pid = initialized.payload!.result!.pid
    h.send(1, 'save'); h.send(1, 'save'); h.send(2, 'echo')
    await h.reply(2)
    expect(h.frames.filter(frame => frame.payload?.id === 1)).toHaveLength(1)
    expect(await readFile(h.effects, 'utf8')).toBe('effect\n')
    const cursor = h.frames.length
    h.send(1, 'save')
    expect((await h.reply(1, cursor)).payload!.result).toEqual({ pid, count: 1 })
    expect(await readFile(h.effects, 'utf8')).toBe('effect\n')
    const key = { bindingId: 'fixed-binding', streamGeneration: 'original', nativeRequestId: 1 }
    const receipt = (await h.journal.inspect(key))!
    const exact = Buffer.from((await h.journal.readResult(key, receipt.payloadDigest))!).toString()
    expect(exact.startsWith('  {')).toBe(true); expect(exact.endsWith(' ')).toBe(true)
    expect(h.privateError()).toBe('private-native-stderr')
    expect(JSON.stringify(h.frames)).not.toContain('private-native-stderr')
    expect(h.grants.every(grant => grant.bindingId === 'fixed-binding')).toBe(true)
  })

  it('refuses unsupported, unauthorized and foreign-handle operations while the same native process stays usable', async () => {
    const h = await fixture(), pid = (await h.initialize()).payload!.result!.pid
    h.send(1, 'unknown'); expect((await h.reply(1)).payload!.error!.code).toBe(-32601)
    h.allow(false); h.send(2, 'save'); expect((await h.reply(2)).payload!.error!.code).toBe(-32001); h.allow(true)
    h.send(3, 'use-resource', 'original', { handle: 'foreign' }); expect((await h.reply(3)).payload!.error!.code).toBe(-32003)
    h.send(4, 'open-resource', 'original', { handle: 'owned' }); await h.reply(4)
    h.send(5, 'use-resource', 'original', { handle: 'owned' }); expect((await h.reply(5)).payload!.result!.pid).toBe(pid)
    h.send(6, 'close-resource', 'original', { handle: 'owned' }); await h.reply(6)
    h.send(7, 'use-resource', 'original', { handle: 'owned' }); expect((await h.reply(7)).payload!.error!.code).toBe(-32003)
    h.send(8, 'hello', 'foreign-generation'); expect((await h.reply(8)).payload!.error!.code).toBe(-32002)
    h.send(9, 'echo'); expect((await h.reply(9)).payload!.result!.pid).toBe(pid)
    const accepted = await readFile(h.log, 'utf8')
    expect(accepted).not.toContain('unknown'); expect(accepted).not.toContain('save')
    expect(accepted.match(/use-resource/gu)).toHaveLength(1)
  })

  it('does not reexecute unknown requests or recreate a closed generation after native exit', async () => {
    const h = await fixture(); await h.initialize()
    h.send(1, 'hang'); h.send(2, 'die')
    await h.wait(frame => frame.code === 'NATIVE_CONNECTION_ENDED')
    const before = await readFile(h.log, 'utf8'), cursor = h.frames.length
    h.send(1, 'hang')
    await h.wait(frame => frame.code === 'ORIGINAL_OPERATION_OUTCOME_UNKNOWN', cursor)
    h.send(3, 'hello')
    expect((await h.reply(3)).payload!.error!.code).toBe(-32002)
    expect(await readFile(h.log, 'utf8')).toBe(before)
    h.send(4, 'hello', 'fresh', { resume: 'unproven-session' })
    expect((await h.reply(4)).payload!.error!.code).toBe(-32002)
    await h.initialize('fresh')
    expect(await h.journal.inspect({ bindingId: 'fixed-binding', streamGeneration: 'original', nativeRequestId: 1 })).toMatchObject({ outcome: 'unknown' })
  })

  it('forwards Provider-confirmed server notifications without admitting client notification injection', async () => {
    const h = await fixture(); await h.initialize()
    h.send(1, 'echo-event')
    await h.wait(frame => frame.generation === 'original' && frame.payload?.method === 'native-event')
    expect((await h.reply(1)).payload!.result).toBeDefined()
    h.send(2, 'native-event')
    expect((await h.reply(2)).payload!.error!.code).toBe(-32601)
    h.send(3, 'echo'); expect((await h.reply(3)).payload!.result).toBeDefined()
    expect((await readFile(h.log, 'utf8')).match(/native-event/gu)).toBeNull()
  })

  it('retries an undispatched original initialization after a storage failure on the same healthy child', async () => {
    const h = await fixture()
    vi.spyOn(h.journal, 'dispatch').mockRejectedValueOnce(new Error('writer unavailable before dispatch'))
    h.send(0, 'hello')
    await h.wait(frame => frame.code === 'ORIGINAL_DISPATCH_STORAGE_UNCONFIRMED')
    h.send(0, 'hello')
    const initialized = await h.reply(0)
    expect(initialized.payload!.result!.pid).toBeTypeOf('number')
    h.send(1, 'echo'); expect((await h.reply(1)).payload!.result!.pid).toBe(initialized.payload!.result!.pid)
    expect((await readFile(h.log, 'utf8')).match(/hello/gu)).toHaveLength(1)
  })

  it('keeps the native response for an explicit persistence retry without repeating the tool effect', async () => {
    const h = await fixture(); await h.initialize()
    const complete = vi.spyOn(h.journal, 'complete').mockRejectedValueOnce(new Error('storage unavailable'))
    h.send(1, 'save')
    expect(await h.wait(frame => frame.code === 'RESPONSE_STORAGE_UNCONFIRMED')).toMatchObject({ scope: 'operation', operation: { bindingId: 'fixed-binding', streamGeneration: 'original', nativeRequestId: 1 } })
    expect(h.frames.some(frame => frame.type === 'operation-completed' && frame.operation?.nativeRequestId === 1)).toBe(false)
    expect(h.frames.some(frame => frame.type === 'response' && frame.payload?.id === 1)).toBe(false)
    h.send(1, 'save'); expect((await h.reply(1)).payload!.result!.count).toBe(1)
    expect(complete).toHaveBeenCalledTimes(2)
    expect(h.frames.filter(frame => frame.type === 'operation-completed' && frame.operation?.nativeRequestId === 1)).toEqual([{ type: 'operation-completed', generation: 'original', operation: { bindingId: 'fixed-binding', streamGeneration: 'original', nativeRequestId: 1 } }])
    expect(await readFile(h.effects, 'utf8')).toBe('effect\n')
  })
  it('allows a new generation only after original socket close while old child and late response stay original', async () => {
    const h = await fixture(), oldPid = Number((await h.initialize()).payload!.result!.pid)
    h.send(1, 'hold-save')
    await vi.waitFor(async () => { expect(await readFile(h.effects, 'utf8')).toBe('effect\n') })
    h.send(8, 'hello', 'fresh')
    expect((await h.reply(8)).payload!.error!.code).toBe(-32002)
    h.closeGeneration(); h.closeGeneration()
    await h.wait(frame => frame.type === 'generation' && frame.state === 'detached' && frame.generation === 'original')
    const freshPid = Number((await h.initialize('fresh')).payload!.result!.pid)
    expect(freshPid).not.toBe(oldPid)
    expect(() => process.kill(oldPid, 0)).not.toThrow()
    const oldKey = { bindingId: 'fixed-binding', streamGeneration: 'original', nativeRequestId: 1 }
    expect(await h.journal.inspect(oldKey)).toMatchObject({ outcome: 'unknown' })
    h.send(2, 'save', 'original')
    expect((await h.reply(2)).payload!.error!.code).toBe(-32002)
    await h.release()
    const oldReply = await h.wait(frame => frame.type === 'response' && frame.generation === 'original' && frame.payload?.id === 1)
    expect(oldReply.payload!.result).toEqual({ pid: oldPid, count: 1 })
    expect(await h.journal.inspect(oldKey)).toMatchObject({ phase: 'completed' })
    expect(h.frames.filter(frame => frame.type === 'generation' && frame.state === 'detached')).toHaveLength(1)
    h.send(1, 'echo', 'fresh')
    const freshReply = await h.wait(frame => frame.type === 'response' && frame.generation === 'fresh' && frame.payload?.id === 1)
    expect(freshReply.payload!.result).toEqual({ pid: freshPid, count: 0 })
    const cursor = h.frames.length
    h.send(1, 'hold-save', 'original')
    expect((await h.reply(1, cursor)).payload!.result).toEqual({ pid: oldPid, count: 1 })
    expect(await readFile(h.effects, 'utf8')).toBe('effect\n')
    await h.executor.dispose()
    for (const pid of [oldPid, freshPid]) expect(() => process.kill(pid, 0)).toThrow()
  })

  it('retains the live original child and pending work after process errors without an exit', async () => {
    const h = await fixture(), pid = Number((await h.initialize()).payload!.result!.pid)
    const child = vi.mocked(spawn).mock.results.at(-1)!.value as ChildProcessWithoutNullStreams
    expect(child.pid).toBe(pid)
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
        child.once('exit', () => resolve()); child.kill('SIGTERM')
      })
    })
    h.send(1, 'hold-save')
    await vi.waitFor(async () => { expect(await readFile(h.effects, 'utf8')).toBe('effect\n') })
    const key = { bindingId: 'fixed-binding', streamGeneration: 'original', nativeRequestId: 1 }
    const before = await h.journal.inspect(key)
    const cursor = h.frames.length
    child.emit('error', Object.assign(new Error('signal permission unavailable'), { code: 'EPERM', syscall: 'kill' }))
    expect((await h.wait(frame => frame.code === 'NATIVE_PROCESS_ERROR_UNCONFIRMED' || frame.code === 'NATIVE_CONNECTION_ENDED', cursor)).code).toBe('NATIVE_PROCESS_ERROR_UNCONFIRMED')
    const second = h.frames.length
    child.emit('error', Object.assign(new Error('signal still unconfirmed'), { code: 'EPERM', syscall: 'kill' }))
    await h.wait(frame => frame.code === 'NATIVE_PROCESS_ERROR_UNCONFIRMED', second)
    expect(await h.journal.inspect(key)).toEqual(before)
    expect(h.frames.slice(cursor).some(frame => frame.type === 'generation' || frame.code === 'NATIVE_CONNECTION_ENDED')).toBe(false)
    expect(() => process.kill(pid, 0)).not.toThrow()
    h.send(8, 'hello', 'replacement')
    expect((await h.reply(8)).payload!.error!.code).toBe(-32002)
    await h.release()
    expect((await h.reply(1)).payload!.result).toEqual({ pid, count: 1 })
    expect(await h.journal.inspect(key)).toMatchObject({ phase: 'completed' })
    h.send(2, 'echo'); expect((await h.reply(2)).payload!.result!.pid).toBe(pid)
    await h.executor.dispose()
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('recognizes a failed spawn without a pid as an unavailable original generation', async () => {
    const h = await fixture(join(tmpdir(), 'missing-native-executor-command'))
    h.send(0, 'hello')
    await h.wait(frame => frame.code === 'NATIVE_CONNECTION_ENDED')
    const child = vi.mocked(spawn).mock.results.at(-1)!.value as ChildProcessWithoutNullStreams
    expect(child.pid).toBeUndefined()
    h.send(1, 'hello')
    expect((await h.reply(1)).payload!.error!.code).toBe(-32002)
  })

  it('detaching the reader preserves the generation and lets its original native response settle', async () => {
    const h = await fixture(), pid = Number((await h.initialize()).payload!.result!.pid)
    h.send(1, 'hold-save')
    await vi.waitFor(async () => { expect(await readFile(h.effects, 'utf8')).toBe('effect\n') })
    h.executor.closeObservation()
    expect(() => process.kill(pid, 0)).not.toThrow()
    await h.release()
    await vi.waitFor(async () => {
      expect(await h.journal.inspect({ bindingId: 'fixed-binding', streamGeneration: 'original', nativeRequestId: 1 })).toMatchObject({ phase: 'completed' })
    })
    expect(h.frames.some(frame => frame.type === 'generation' && frame.state === 'detached')).toBe(false)
    expect(h.frames.some(frame => frame.payload?.id === 1)).toBe(false)
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

})
