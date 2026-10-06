import { fixtureClock as reshapeFixtureClock, fixtureDay as reshapeFixtureDay, fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { activateRuntime } from '../node_modules/@ctxmux/sdk/dist/index.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import { nativeProcessBirth } from '../src/agent-native-process.js'
import * as runner from '../src/process-runner.js'
import { nativeProcessBirth as compiledBirth } from '../dist/agent-native-process.js'
import * as compiledRunner from '../dist/process-runner.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function record(kind: string, facts: unknown) {
  const path = process.env.AMX_PROCESS_BIRTH_PROOF
  if (path) { await mkdir(path, { recursive: true }); await appendFile(join(path, 'actual.jsonl'), JSON.stringify({ kind, facts }) + '\n') }
}

// Independent libproc ABI observation. It does not invoke the production C helper,
// read process argv/env, or infer identity from a display date.
const kernelIdentity = String.raw`
import ctypes,json,sys
class BSD(ctypes.Structure):
 _fields_=[(n,ctypes.c_uint32) for n in ('flags','status','xstatus','pid','ppid','uid','gid','ruid','rgid','svuid','svgid','rfu')]+[('comm',ctypes.c_char*16),('name',ctypes.c_char*32)]+[(n,ctypes.c_uint32) for n in ('nfiles','pgid','jobc','tdev','tpgid')]+[('nice',ctypes.c_int32),('sec',ctypes.c_uint64),('usec',ctypes.c_uint64)]
lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
lib.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]
lib.proc_pidinfo.restype=ctypes.c_int
pid=int(sys.argv[1]);v=BSD()
assert lib.proc_pidinfo(pid,3,0,ctypes.byref(v),ctypes.sizeof(v))==ctypes.sizeof(v)
assert v.pid==pid
print(json.dumps(['darwin',v.pid,v.uid,str(v.sec),str(v.usec)]))
`

it.runIf(process.platform === 'darwin')('uses the original kernel PID/UID and microsecond birth, independent of ps display', async () => {
  const child = spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(child.stdout!, 'data')
    const expected = await runner.runProcess('/usr/bin/python3', ['-c', kernelIdentity, String(child.pid)], { timeoutMs: 2000 })
    expect(expected.exitCode).toBe(0)
    const original = runner.runProcess
    const calls = vi.spyOn(runner, 'runProcess').mockImplementation((command, args, options) => {
      if (command === 'ps' || command === '/bin/ps') throw new Error('Display process identity is forbidden')
      return original(command, args, options)
    })
    const observed = await nativeProcessBirth(child.pid!, AbortSignal.timeout(4000)).then(value => ({ value }), error => ({ error }))
    expect(observed).not.toHaveProperty('error')
    const identity = 'value' in observed ? observed.value : ''
    expect(JSON.parse(identity)).toEqual(JSON.parse(expected.stdout))
    expect(calls.mock.calls).toHaveLength(1)
    expect(calls.mock.calls[0]?.[1]).toEqual(['--process-identity', String(child.pid)])
    expect(await nativeProcessBirth(child.pid!, AbortSignal.timeout(4000))).toBe(identity)
    expect(await compiledBirth(child.pid!, AbortSignal.timeout(4000))).toBe(identity)
    await record('kernel-birth', { childPid: child.pid, independentKernel: JSON.parse(expected.stdout), sourceIdentity: JSON.parse(identity), compiledMatches: true })
  } finally {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited
  }
  await expect(nativeProcessBirth(child.pid!, AbortSignal.timeout(4000))).rejects.toBeDefined()
})

it.runIf(process.platform === 'darwin')('same-second private processes stay distinct across display locale and timezone changes', async () => {
  let children: ChildProcess[] = [], expected: unknown[][] = []
  const release = async () => {
    await Promise.all(children.map(async child => { if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }))
    children = []
  }
  try {
    // The fixture selects the same-second case from actual kernel facts; it does
    // not infer birth from a clock, output text or an assumed scheduling gap.
    for (let attempt = 0; attempt < 4; attempt++) {
      children = [0, 1].map(() => spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] }))
      await Promise.all(children.map(child => once(child.stdout!, 'data')))
      expected = await Promise.all(children.map(async child => {
        const reference = await runner.runProcess('/usr/bin/python3', ['-c', kernelIdentity, String(child.pid)], { timeoutMs: 2000 })
        expect(reference.exitCode).toBe(0); return JSON.parse(reference.stdout) as unknown[]
      }))
      if (expected[0]?.[3] === expected[1]?.[3]) break
      await release()
    }
    expect(children).toHaveLength(2); expect(expected[0]?.[3]).toBe(expected[1]?.[3])
    const identities = await Promise.all(children.map(child => nativeProcessBirth(child.pid!, AbortSignal.timeout(4000))))
    expect(identities).toEqual(expected.map(value => JSON.stringify(value)))
    expect(identities[0]).not.toBe(identities[1])
    vi.stubEnv('TZ', 'Pacific/Honolulu'); vi.stubEnv('LC_ALL', 'C')
    expect(await nativeProcessBirth(children[0]!.pid!, AbortSignal.timeout(4000))).toBe(identities[0])
    vi.stubEnv('TZ', 'Asia/Shanghai'); vi.stubEnv('LC_ALL', 'zh_CN.UTF-8')
    expect(await nativeProcessBirth(children[1]!.pid!, AbortSignal.timeout(4000))).toBe(identities[1])
    await record('same-second-kernel-processes', { expected, distinct: true, localeTimezoneUnchanged: true })
  } finally { await release() }
})

it.runIf(process.platform === 'darwin').each(['pid', 'uid', 'seconds', 'microseconds', 'schema'] as const)('refuses an unbound %s kernel receipt', async field => {
  const receipt = { type: 'native-process-identity', schema: 1, pid: 11223, uid: process.getuid!(), startSec: String(reshapeFixtureEpoch(1) / 1_000), startUsec: '123456' }
  const invalid = { ...receipt, ...(field === 'pid' ? { pid: 11224 } : field === 'uid' ? { uid: receipt.uid + 1 }
    : field === 'seconds' ? { startSec: '0' } : field === 'microseconds' ? { startUsec: '1000000' } : { schema: 2 }) }
  // Adversarial protocol receipt; this is not an actual kernel identity claim.
  vi.spyOn(runner, 'runProcess').mockResolvedValue({ exitCode: 0, stdout: JSON.stringify(invalid), stderr: '' })
  vi.spyOn(compiledRunner, 'runProcess').mockResolvedValue({ exitCode: 0, stdout: JSON.stringify(invalid), stderr: '' })
  for (const read of [nativeProcessBirth, compiledBirth]) {
    const outcome = await read(receipt.pid, AbortSignal.timeout(1000)).then(value => ({ value }), error => ({ error }))
    expect(outcome).toHaveProperty('error')
    expect('error' in outcome ? outcome.error : null).toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  }
})

it('does not turn cancellation or an unsupported Host into a display fallback', async () => {
  const read = vi.spyOn(runner, 'runProcess').mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' })
  const compiledRead = vi.spyOn(compiledRunner, 'runProcess').mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' })
  await expect(nativeProcessBirth(0, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  const controller = new AbortController(); controller.abort(new Error('original cancellation'))
  await expect(nativeProcessBirth(11223, controller.signal)).rejects.toThrow('original cancellation')
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  try {
    await expect(nativeProcessBirth(11223, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
    await expect(compiledBirth(11223, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  }
  finally { platform.mockRestore() }
  expect(read).not.toHaveBeenCalled()
  expect(compiledRead).not.toHaveBeenCalled()
})

// Real ctxmux Run and OS-owned presence. The Native file contents are a controlled
// Provider protocol fixture, not a vendor CLI or installed App claim.
it.runIf(process.platform === 'darwin')('the public Core discovers and retains the exact private Run native identity while Raw remains usable', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'am-birth-'))), runtime = join(root, 'runtime'), state = join(root, 'state')
  const directory = await lstat(root, { bigint: true })
  await mkdir(runtime); await mkdir(state)
  const presence = join(root, 'presence'), id = '5e82f398-e7f1-4a8c-a0b1-cf6fb486ffb2'
  await mkdir(presence)
  const transcript = join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
  await mkdir(join(root, 'brain', id, '.system_generated', 'logs'), { recursive: true })
  await writeFile(transcript, JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
    created_at: reshapeFixtureDay(1) + 'T' + reshapeFixtureClock(0, 0, 0) + 'Z', content: '<USER_REQUEST>Controlled native record</USER_REQUEST>' }) + '\n')
  const lock = join(presence, id + '.lock'), worker = join(root, 'worker.mjs')
  await writeFile(lock, '')
  await writeFile(worker, `import{openSync,writeFileSync}from'node:fs';openSync(${JSON.stringify(lock)},'r+');writeFileSync(${JSON.stringify(join(root, 'ready'))},'ready');process.stdin.on('data',b=>process.stdout.write(b));setInterval(()=>{},1000);`)
  for (const key of Object.keys(process.env).filter(key => /^(AGENTMUX_|CTXMUX_)/u.test(key))) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  let activation: Awaited<ReturnType<typeof activateRuntime>> | undefined, client: AgentMuxClient | undefined
  let session: ReturnType<AgentMuxClient['agentSession']> | undefined
  const events: AgentMuxClientEvent[] = []
  const failures: unknown[] = []
  try {
    activation = await activateRuntime({ executable: fileURLToPath(new URL('../vendor/ctxmux/darwin-arm64/bin/ctxmuxd', import.meta.url)),
      socketPath: join(runtime, 'ctxmux.sock'), stateDir: join(state, 'ctxmux'), env: { AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined },
      timeoutMs: 5000, childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'pipe' } })
    const builtin = new AgentProviderRegistry().get('antigravity')
    client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')),
      providers: [{ ...builtin, planManagedHooks: () => null, buildLaunch: () => ({ command: process.execPath, args: [worker], env: {} }) }] })
    client.onEvent(event => events.push(event))
    await client.connect()
    session = await client.createAgent({ agentSessionId: 'private-birth', createOperationId: 'private-birth-create', providerId: 'antigravity',
      executorId: 'antigravity', workspacePath: root, prompt: 'Controlled protocol fixture', injectAgentMuxGuide: false })
    await vi.waitFor(async () => expect(await readFile(join(root, 'ready'), 'utf8')).toBe('ready'), { timeout: 5000 })
    const read = await client.sessionHistoryPage(session.agentSessionId).then(page => ({ page }), error => ({ error }))
    expect(read).not.toHaveProperty('error')
    const page = 'page' in read ? read.page : { items: [] }
    expect(page.items).toHaveLength(1)
    const observed = client.agentSession(session.agentSessionId)
    expect(observed.nativeHandle).toEqual({ kind: 'provider', providerId: 'antigravity', sessionId: id,
      transcriptPath: join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl') })
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    try {
      expect((await client.sessionHistoryPage(session.agentSessionId, { refreshNativeSource: true })).items).toEqual(page.items)
      expect(client.agentSession(session.agentSessionId).nativeHandle).toEqual(observed.nativeHandle)
      expect(client.agentSession(session.agentSessionId).nativeSourceObservation?.state).toBe('unknown')
      expect(events.some(event => event.type === 'agent-error' && event.agentSessionId === session!.agentSessionId && event.code === 'AGENT_NATIVE_SOURCE_UNCONFIRMED')).toBe(true)
      const ack = await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'RAW-WHILE-UNKNOWN\r' })
      expect(ack.runId).toBe(session.run.runId)
    } finally { platform.mockRestore() }
    const before = await client.statusAgent(session.agentSessionId)
    expect(before.run).toMatchObject({ runId: session.run.runId, state: 'running' })
    const ack = await client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'RAW-REMAINS\r' })
    expect(ack.runId).toBe(session.run.runId)
    const after = await client.statusAgent(session.agentSessionId)
    expect(after.run).toMatchObject({ runId: session.run.runId, pid: before.run?.pid, state: 'running' })
    expect(after.session.nativeHandle).toEqual(observed.nativeHandle)
    await record('public-core-consumer', { originalRun: session.run, originalPid: before.run?.pid, nativeHandle: observed.nativeHandle,
      retainedSourceUnknownBranch: true, rawAck: ack, protocolFixture: 'controlled-Antigravity-presence', vendorCli: false })
  } catch (error) { failures.push(error) }
  finally {
    // Original SDK inventory/receipts remain available even if Core stop/dispose failed.
    if (session && client) try { await client.stopAgent(session.agentSessionId, session.run) } catch (error) { failures.push(error) }
    if (client) try { await client.dispose() } catch (error) { failures.push(error) }
    if (activation) try {
      expect(activation.spawned).toBe(true)
      const sdk = activation.client, runs = await sdk.list()
      for (const run of runs) { if (run.state.type === 'running') await sdk.stop(await sdk.prepareStop(run.id)); await sdk.remove(run.id) }
      expect(await sdk.list()).toEqual([])
      await activation.shutdown(); await activation.dispose()
      const current = await lstat(root, { bigint: true })
      expect([current.dev, current.ino]).toEqual([directory.dev, directory.ino])
      await expect(lstat(activation.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await rm(root, { recursive: true })
      await record('private-runtime-cleanup', { directory: root, childPid: activation.childPid, correctiveRunIds: runs.map(run => run.id),
        childExit: 'confirmed-by-original-SDK-shutdown', namespace: 'removed', failuresBeforeCleanup: failures.length })
    } catch (error) { failures.push(error); await record('private-runtime-cleanup-unconfirmed', { directory: root, childPid: activation.childPid, namespace: 'retained' }) }
    else if (failures.length === 0) await rm(root, { recursive: true })
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Original fixture assertion and cleanup failures')
}, 30_000)
