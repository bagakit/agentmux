import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { compileRendererProfileCli } from '../../../packages/core/test/helpers/renderer-profile-cli.js'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RendererV8Profiler } from '../src/main/renderer-v8-profile.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { parseRpcControlResult, rpcControlRequest } from '../../../packages/core/src/rpc-business-codec.js'
import { agentMuxControlTimeoutMs } from '../../../packages/core/src/control.js'
import { parseRendererV8ProfileInput, parseRendererV8ProfileResult, type RendererV8Profile,
  type RendererV8ProfileTarget } from '../../../packages/core/src/renderer-v8-profile.js'
import { writeRendererV8Profile } from '../../../packages/core/src/renderer-v8-profile-cli.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'

const target: RendererV8ProfileTarget = { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 1000 }
const input = (durationMs = 1000) => ({ target: { ...target }, durationMs })
const originalProfile = (): RendererV8Profile => ({
  startTime: 100, endTime: 1100,
  nodes: [{ id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, children: [2] },
    { id: 2, callFrame: { functionName: 'privateProfileWork', scriptId: '1', url: 'private-fixture.js', lineNumber: 0, columnNumber: 0 }, hitCount: 2 }],
  samples: [2, 2], timeDeltas: [500, 500]
})
function fixture() {
  let current: RendererV8ProfileTarget | null = { ...target }
  const state = { attached: false, devtools: false, destroyed: false, profile: originalProfile(), onStop: () => {} }
  const debuggerClient = Object.assign(new EventEmitter(), {
    isAttached: vi.fn(() => state.attached),
    attach: vi.fn(() => { if (state.attached) throw new Error('Original debugger is busy'); state.attached = true }),
    detach: vi.fn(() => { state.attached = false; debuggerClient.emit('detach') }),
    sendCommand: vi.fn(async (method: string): Promise<any> => {
      if (method === 'Profiler.stop') { state.onStop(); return { profile: state.profile } }
      return {}
    })
  })
  const contents = Object.assign(new EventEmitter(), { debugger: debuggerClient,
    isDestroyed: () => state.destroyed, isDevToolsOpened: () => state.devtools })
  const profiler = new RendererV8Profiler(contents as unknown as WebContents, () => current)
  return { profiler, state, debuggerClient, contents, setCurrent: (value: RendererV8ProfileTarget | null) => { current = value } }
}
async function finish(f: ReturnType<typeof fixture>, duration = 1000) {
  const pending = f.profiler.capture(input(duration))
  await vi.advanceTimersByTimeAsync(duration)
  return pending
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('Renderer V8 profile original owner', () => {
  it.each([1000, 5000])('returns the complete original profile after %i ms and releases only its own debugger', async duration => {
    vi.useFakeTimers()
    const f = fixture(), result = await finish(f, duration)
    expect(result.status).toBe('completed')
    expect(result.profile).toEqual(originalProfile())
    expect(result.target).toEqual(target)
    expect(result.sourceVerified).toEqual({ before: true, after: true })
    expect(result.cleanup).toEqual({ stopRequested: true, stopAcknowledged: true, disableAcknowledged: true, detached: 'confirmed' })
    expect(f.debuggerClient.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Profiler.enable', 'Profiler.start', 'Profiler.stop', 'Profiler.disable'])
    expect(f.debuggerClient.detach).toHaveBeenCalledOnce()
    expect(f.state.attached).toBe(false)
    expect(f.debuggerClient.listenerCount('detach')).toBe(0)
    expect(f.contents.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(result.timing.stoppedAt! - result.timing.startedAt!).toBe(duration)
    expect(result.profileBytes).toBe(Buffer.byteLength(JSON.stringify(originalProfile())))
    expect(result.sha256).toBe(createHash('sha256').update(JSON.stringify(originalProfile())).digest('hex'))
  })
  it('rejects an incorrect initial target before any attach or command', async () => {
    const f = fixture()
    const result = await f.profiler.capture({ ...input(), target: { ...target, pid: 99 } }).catch(error => error)
    expect(f.debuggerClient.attach).not.toHaveBeenCalled()
    expect(f.debuggerClient.sendCommand).not.toHaveBeenCalled()
    expect(result).toMatchObject({ code: 'CONTROL_OWNER_LOST' })
  })
  it.each(['devtools', 'debugger'])('preserves a pre-existing %s owner without attempting attach or detach', async owner => {
    const f = fixture(); f.state.devtools = owner === 'devtools'; f.state.attached = owner === 'debugger'
    const result = await f.profiler.capture(input()).catch(error => error)
    expect(f.debuggerClient.attach).not.toHaveBeenCalled()
    expect(f.debuggerClient.sendCommand).not.toHaveBeenCalled()
    expect(f.debuggerClient.detach).not.toHaveBeenCalled()
    expect(result).toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(f.state.devtools).toBe(owner === 'devtools'); expect(f.state.attached).toBe(owner === 'debugger')
  })
  it.each(['windowId', 'webContentsId', 'generation', 'pid', 'creationTime'] as const)('does not complete a profile after stop changes %s', async field => {
    vi.useFakeTimers()
    const f = fixture(); f.state.onStop = () => f.setCurrent({ ...target, [field]: target[field] + 1 })
    const result = await finish(f)
    expect(result.status).toBe('unknown')
    expect(result.sourceVerified.after).toBe(false)
    expect(result.issues[0]).toMatchObject({ stage: 'source', code: 'CONTROL_OWNER_LOST' })
    expect(result.target).toEqual(target)
    expect(f.debuggerClient.attach).toHaveBeenCalledOnce()
    expect(result.cleanup.stopAcknowledged).toBe(true)
    expect(result.cleanup.detached).toBe('confirmed')
  })
  it('does not detach a foreign debugger acquired after the original detach event', async () => {
    vi.useFakeTimers()
    const f = fixture(), pending = f.profiler.capture(input())
    await vi.advanceTimersByTimeAsync(0)
    f.debuggerClient.emit('detach', {}, 'replaced_with_devtools')
    f.state.attached = true
    const result = await pending
    expect(result.status).toBe('unknown')
    expect(result.cleanup.detached).toBe('owner-lost')
    expect(f.debuggerClient.detach).not.toHaveBeenCalled()
    expect(f.debuggerClient.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Profiler.enable', 'Profiler.start'])
    expect(f.state.attached).toBe(true)
  })
  it('keeps an unacknowledged stop unknown and ignores late completion after cancellation', async () => {
    vi.useFakeTimers()
    const f = fixture(), abort = new AbortController()
    let resolveStop!: (value: unknown) => void
    f.debuggerClient.sendCommand.mockImplementation(async method => method === 'Profiler.stop'
      ? await new Promise(resolve => { resolveStop = resolve }) : {})
    const pending = f.profiler.capture(input(), abort.signal)
    await vi.advanceTimersByTimeAsync(1000)
    expect(resolveStop).toBeTypeOf('function')
    abort.abort(new Error('private cancellation'))
    const result = await pending, original = JSON.stringify(result)
    expect(result.status).toBe('unknown')
    expect(result.cleanup).toMatchObject({ stopRequested: true, stopAcknowledged: false, detached: 'confirmed' })
    expect(result.profile).toBeNull()
    f.state.attached = true
    resolveStop({ profile: originalProfile() }); await vi.advanceTimersByTimeAsync(0)
    expect(JSON.stringify(result)).toBe(original)
    expect(f.debuggerClient.detach).toHaveBeenCalledOnce()
    expect(f.state.attached).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('preserves default AbortSignal cancellation facts without treating a numeric DOMException code as a protocol error', async () => {
    vi.useFakeTimers()
    const f = fixture(), abort = new AbortController(), pending = f.profiler.capture(input(), abort.signal)
    await vi.advanceTimersByTimeAsync(0)
    abort.abort()
    const result = await pending
    expect(result.status).toBe('unknown')
    expect(result.issues[0]).toMatchObject({ code: 'CONTROL_CANCELLED' })
    expect(result.cleanup.detached).toBe('confirmed')
    expect(result.cleanup.stopAcknowledged).toBe(false)
  })
  it('requests stop only once on disposal and preserves simultaneous primary and cleanup errors', async () => {
    vi.useFakeTimers()
    const f = fixture(), pending = f.profiler.capture(input())
    await vi.advanceTimersByTimeAsync(0)
    f.debuggerClient.detach.mockImplementation(() => { throw new Error('private detach failure') })
    f.profiler.dispose()
    const result = await pending
    expect(result.status).toBe('unknown')
    expect(result.issues.map(i => i.stage)).toEqual(['recording', 'detach'])
    expect(result.issues[0]).toMatchObject({ code: 'CONTROL_OWNER_LOST' })
    expect(result.cleanup).toMatchObject({ stopRequested: true, stopAcknowledged: false, detached: 'unconfirmed' })
    expect(f.debuggerClient.sendCommand.mock.calls.filter(([method]) => method === 'Profiler.stop')).toHaveLength(1)
  })
  it('reports real oversized output without truncating a profile or pretending the Run failed', async () => {
    vi.useFakeTimers()
    const f = fixture(); f.state.profile.nodes[1]!.callFrame.url = 'x'.repeat(8 * 1024 * 1024)
    const result = await finish(f)
    expect(result.status).toBe('failed')
    expect(result.profile).toBeNull(); expect(result.sha256).toBeNull()
    expect(result.profileBytes).toBeGreaterThan(8 * 1024 * 1024)
    expect(result.issues[0]).toMatchObject({ stage: 'profile', code: 'CONTROL_PROTOCOL_ERROR' })
    expect(result.cleanup).toMatchObject({ stopAcknowledged: true, detached: 'confirmed' })
  })
  it('does not claim success when the native stop command fails', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.debuggerClient.sendCommand.mockImplementation(async method => { if (method === 'Profiler.stop') throw new Error('private stop failure'); return {} })
    const result = await finish(f)
    expect(result.status).toBe('failed'); expect(result.profile).toBeNull()
    expect(result.cleanup.stopAcknowledged).toBe(false)
    expect(result.cleanup.detached).toBe('confirmed')
    expect(result.issues[0]).toMatchObject({ stage: 'stop', message: 'private stop failure' })
  })
  it('ends a pending enable at the request budget without inventing a start or stop acknowledgement', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.debuggerClient.sendCommand.mockImplementation(async method => method === 'Profiler.enable' ? await new Promise(() => {}) : {})
    const pending = f.profiler.capture(input())
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await pending
    expect(result.status).toBe('unknown')
    expect(result.issues[0]).toMatchObject({ stage: 'enable', code: 'CONTROL_TIMEOUT' })
    expect(result.timing.startedAt).toBeNull()
    expect(result.cleanup).toMatchObject({ stopRequested: false, stopAcknowledged: false, detached: 'confirmed' })
    expect(f.debuggerClient.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Profiler.enable', 'Profiler.disable'])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Renderer V8 profile public contract and CLI', () => {
  it('validates original non-null identities and explicit duration without accepting extra fields', () => {
    for (const durationMs of [999, 5001, 1500.5]) expect(() => parseRendererV8ProfileInput(input(durationMs))).toThrow()
    for (const key of ['pid', 'creationTime', 'generation'] as const) {
      expect(() => parseRendererV8ProfileInput({ ...input(), target: { ...target, [key]: null } })).toThrow()
    }
    expect(() => parseRendererV8ProfileInput({ ...input(), output: 'not-an-rpc-path' })).toThrow()
    expect(agentMuxControlTimeoutMs('metrics.profile.capture')).toBe(60_000)
    expect(agentMuxControlTimeoutMs('metrics.get')).toBe(2000)
  })
  it('uses actual CLI parsing, public service, metrics port and original Main capture at the 5-second endpoint', async () => {
    vi.useFakeTimers()
    const f = fixture(), subscribe = vi.fn()
    const port = createResourceMetricsPort({ sampler: { subscribe } as never, currentWindow: () => target, profiler: f.profiler })
    const cli = await parseAgentMuxCliInvocation(['system', 'metrics', 'profile', 'capture', '--window-id', '1', '--web-contents-id', '2',
      '--generation', '3', '--pid', '4', '--creation-time', '1000', '--duration-ms', '5000', '--output', 'original.cpuprofile'])
    expect(cli.output).toBe('original.cpuprofile')
    expect(cli.params).toEqual(input(5000))
    expect(cli.command.method).toBe('system.metrics.profile.capture')
    expect(rpcControlRequest('system.metrics.profile.capture', cli.params)).toMatchObject({ operation: 'metrics.profile.capture', ...input(5000) })
    const service = new AgentMuxRpcService({ metrics: port })
    const pending = service.call('system.metrics.profile.capture', cli.params as never, { principal: { kind: 'device', id: 'private-device' } })
    await vi.advanceTimersByTimeAsync(2001)
    expect(f.debuggerClient.detach).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2999)
    const body = await pending
    expect(body.capture.status).toBe('completed')
    expect(parseRpcControlResult('system.metrics.profile.capture', body, cli.params)).toEqual(body)
    expect(subscribe).not.toHaveBeenCalled()
    expect(() => parseRpcControlResult('system.metrics.profile.capture', body, { ...cli.params, target: { ...target, pid: 88 } })).toThrow()
    port.dispose()
    await expect(port.captureProfile!(input())).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  })
  it('keeps unsupported scoped to capture and rejects mismatched or empty returned profiles', async () => {
    const service = new AgentMuxRpcService({ metrics: { subscribe: vi.fn() } })
    await expect(service.call('system.metrics.profile.capture', input())).rejects.toMatchObject({ code: 'METRICS_UNSUPPORTED' })
    vi.useFakeTimers()
    const result = await finish(fixture())
    expect(() => parseRendererV8ProfileResult({ ...result, profile: { ...result.profile, nodes: [] } })).toThrow()
    expect(() => parseRendererV8ProfileResult({ ...result, cleanup: { ...result.cleanup, stopAcknowledged: false } })).toThrow()
    expect(() => parseRendererV8ProfileResult({ ...result, timing: { ...result.timing, startMonotonicMs: null, stopMonotonicMs: null } })).toThrow()
  })
  it('saves exact original JSON with checksum and mode, and never overwrites files or symlinks', async () => {
    vi.useFakeTimers()
    const capture = await finish(fixture())
    vi.useRealTimers()
    const directory = await mkdtemp(join(tmpdir(), 'profile-cli-'))
    try {
      const path = join(directory, 'original.cpuprofile')
      const output = await writeRendererV8Profile(path, { capture })
      expect(await readFile(path, 'utf8')).toBe(JSON.stringify(originalProfile()))
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(output).toMatchObject({ path, sha256: capture.sha256, bytes: capture.profileBytes })
      await expect(writeRendererV8Profile(path, { capture })).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await readFile(path, 'utf8')).toBe(JSON.stringify(originalProfile()))
      const destination = join(directory, 'private-original'); await writeFile(destination, 'original data')
      const linked = join(directory, 'linked.cpuprofile'); await symlink(destination, linked)
      await expect(writeRendererV8Profile(linked, { capture })).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await readFile(destination, 'utf8')).toBe('original data')
      await expect(writeRendererV8Profile(join(directory, 'corrupt.cpuprofile'), { capture: { ...capture, sha256: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('runs the actual compiled CLI against the original private RPC service and preserves the capture receipt on local write failure', async () => {
    vi.useFakeTimers()
    const capture = await finish(fixture())
    vi.useRealTimers()
    const root = resolve(import.meta.dirname, '../../..')
    const directory = process.env.PROFILE_UNIT_OUTPUT!, namespace = process.env.PROFILE_NAMESPACE!
    expect(directory).toBeTruthy(); expect(namespace).toBeTruthy()
    await mkdir(directory, { recursive: true })
    const frozen = JSON.parse(readFileSync(process.env.AGENTMUX_PERFORMANCE_SOURCES!, 'utf8'))
    const entry = await compileRendererProfileCli(root, directory, frozen, process.env.AGENTMUX_PERFORMANCE_LOADED)
    const captureProfile = vi.fn(async () => capture)
    const socket = join(namespace, 'c.sock'), owner = new AgentMuxControlServer({ coreClients: () => [], metrics: { captureProfile, subscribe: vi.fn() } }, socket)
    await owner.start()
    const output = join(directory, 'from-cli.cpuprofile')
    const cli = async (name: string) => {
      const child = spawn(process.execPath, ['--import', process.env.PROFILE_PRE_IMPORT_MODULE!, entry,
        '--endpoint', 'unix://' + socket, 'system', 'metrics', 'profile', 'capture', '--window-id', '1', '--web-contents-id', '2',
        '--generation', '3', '--pid', '4', '--creation-time', '1000', '--duration-ms', '1000', '--output', output],
      { env: { ...process.env, PROFILE_PRE_IMPORT: join(directory, name + '-pre-import.json') }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', part => { stdout += part.toString() }); child.stderr.on('data', part => { stderr += part.toString() })
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000)
      const code = await new Promise<number | null>((yes, no) => {
        child.once('close', value => { clearTimeout(watchdog); yes(value) })
        child.once('error', error => { clearTimeout(watchdog); no(error) })
      })
      appendFileSync(join(directory, 'cli-raw.jsonl'), JSON.stringify({ name, code, stdout, stderr }) + '\n')
      return { code, stdout, stderr }
    }
    try {
      const first = await cli('first')
      expect(first.code).toBe(0); expect(first.stderr).toBe('')
      expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, operation: 'system.metrics.profile.capture', result: { capture }, output: { path: output, sha256: capture.sha256 } })
      expect(await readFile(output, 'utf8')).toBe(JSON.stringify(originalProfile()))
      const second = await cli('existing-output')
      expect(second.code).toBe(1)
      expect(JSON.parse(second.stdout)).toMatchObject({ ok: false, result: { capture }, outputError: { code: 'EEXIST' } })
      expect(captureProfile).toHaveBeenCalledTimes(2)
      expect(await readFile(output, 'utf8')).toBe(JSON.stringify(originalProfile()))
    } finally { await owner.stop() }
  })
})
