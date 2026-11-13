import { mkdir, readFile, realpath, access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { HostedExecutionHost as SourceHostedExecutionHost } from '../src/hosted-execution-host.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { fixturePath } from './helpers/fixture-values.js'
import type { AgentMuxClientEvent, AgentMuxRun, AgentMuxRunAttachment } from '../src/types.js'

const scopes: Array<Awaited<ReturnType<typeof headlessFixture>>> = []
const HostedExecutionHost: typeof SourceHostedExecutionHost = process.env.AGENTMUX_TEST_HOSTED_EXECUTION_HOST_ENTRY
  ? (await import(process.env.AGENTMUX_TEST_HOSTED_EXECUTION_HOST_ENTRY)).HostedExecutionHost : SourceHostedExecutionHost
afterEach(async () => { for (const scope of scopes.splice(0)) await scope.cleanup() })

async function fixture() {
  const scope = await headlessFixture(); scopes.push(scope)
  const client = await scope.client()
  const connect = vi.fn(async () => client)
  return { scope, client, connect, host: new HostedExecutionHost({ id: 'remote', label: 'Remote', connect }) }
}

describe('HostedExecutionHost through the real Core and official ctxmux', () => {
  it('runs literal argv, cwd, env, large binary input and independent stdout/stderr through the existing hosted APIs', async () => {
    const { scope, client, connect, host } = await fixture()
    const cwd = join(scope.root, 'folder with spaces'); await mkdir(cwd)
    const sentinel = join(scope.root, 'must-not-exist')
    const literal = `literal ' quote $(touch '${sentinel}') \`touch '${sentinel}'\`\nlast line`
    const input = Buffer.alloc(192 * 1024); for (let i = 0; i < input.length; i++) input[i] = i % 256
    const code = 'const chunks=[];process.stdin.on("data",v=>chunks.push(v));process.stdin.on("end",()=>{const b=Buffer.concat(chunks);process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1],value:process.env.AGENTMUX_TEST_VALUE,removed:process.env.PATH,input:b.toString("base64")}));process.stderr.write("separate error\\n");process.exitCode=17})'
    const result = await host.run(process.execPath, ['-e', code, literal], {
      cwd, env: { AGENTMUX_TEST_VALUE: literal, PATH: undefined }, input, timeoutMs: 20_000, maxOutputBytes: 512 * 1024
    })
    expect(result.exitCode).toBe(17)
    expect(result.stderr).toBe('separate error\n')
    expect(JSON.parse(result.stdout)).toEqual({ cwd: await realpath(cwd), arg: literal, value: literal, input: input.toString('base64') })
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await host.run('/bin/sh', ['-c', 'printf reused'])).toEqual({ stdout: 'reused', stderr: '', exitCode: 0 })
    expect(connect).toHaveBeenCalledOnce()
    expect(await client.listRuns()).toEqual([])
  }, 40_000)

  it('retains the original creation and Run when the create reply is lost, without replay or teardown', async () => {
    const { client, host } = await fixture()
    const original = client.createPreparedTerminal.bind(client)
    const create = vi.spyOn(client, 'createPreparedTerminal').mockImplementation(async prepared => {
      await original(prepared)
      throw new AgentMuxError('The original creation reply was lost.', 'CONTROL_CONNECTION_FAILED')
    })
    const error = await host.run('/bin/echo', ['once']).catch(error => error)
    expect(error).toMatchObject({ code: 'CONTROL_CONNECTION_FAILED', controlFailure: { disposition: 'unknown' } })
    const retained = await client.listRuns()
    expect(retained).toHaveLength(1)
    expect(retained[0]).toMatchObject({ state: 'running', kind: 'terminal' })
    expect(JSON.parse(error.detail)).toEqual({ createOperationId: create.mock.calls[0]![0].createOperationId })
    expect(error.terminalOperation.prepared).toEqual(create.mock.calls[0]![0])
    expect(create).toHaveBeenCalledOnce()
  }, 20_000)

  it('never replays an input whose original receipt is lost and keeps its completed result available on the same Run', async () => {
    const { scope, client, host } = await fixture()
    const target = join(scope.root, 'once')
    const original = client.writeTerminal.bind(client)
    const input = vi.spyOn(client, 'writeTerminal').mockImplementation(async (...args) => {
      await original(...args)
      throw new AgentMuxError('The input acknowledgement was lost.', 'CONTROL_CONNECTION_FAILED')
    })
    const error = await host.run('/bin/sh', ['-c', 'printf x >> "$1"', 'test', target]).catch(error => error)
    expect(error).toMatchObject({ code: 'CONTROL_CONNECTION_FAILED', controlFailure: { disposition: 'unknown' } })
    const identity = JSON.parse(error.detail)
    expect(identity).toMatchObject({ runId: input.mock.calls[0]![0].runId, inputOperationId: input.mock.calls[0]![1].operationId })
    await until(async () => { try { return await readFile(target, 'utf8') } catch { return '' } }, text => text === 'x', 'exact original command side effect')
    expect(await readFile(target, 'utf8')).toBe('x')
    expect(input).toHaveBeenCalledOnce()
    const retained = await client.listRuns()
    expect(retained).toHaveLength(1)
    expect(retained[0]!.runId).toBe(identity.runId)
  }, 20_000)

  it('cancels only its own transient Run and preserves an unrelated healthy Terminal', async () => {
    const { scope, client, host } = await fixture()
    const healthy = await client.createTerminal({ workspacePath: scope.root, command: '/bin/sh', args: ['-c', 'sleep 60'] })
    const marker = join(scope.root, 'started'), controller = new AbortController()
    const stop = vi.spyOn(client, 'stopTerminal')
    const work = host.run('/bin/sh', ['-c', 'printf yes > "$1"; sleep 60', 'test', marker], { signal: controller.signal }).catch(error => error)
    await until(async () => { try { return await readFile(marker, 'utf8') } catch { return '' } }, text => text === 'yes', 'own transient command started')
    controller.abort()
    expect(await work).toMatchObject({ code: 'COMMAND_ABORTED', controlFailure: { disposition: 'unknown' } })
    expect(stop).toHaveBeenCalledOnce()
    expect(stop.mock.calls[0]![0].runId).not.toBe(healthy.runId)
    expect((await client.listRuns()).find(run => run.runId === healthy.runId)).toMatchObject({ state: 'running', pid: healthy.pid })
  }, 20_000)

  it('bounds a hanging connect by the timeout as not applied, and the next command connects again', async () => {
    const { client } = await fixture()
    let attempts = 0
    const connect = vi.fn(() => ++attempts === 1 ? new Promise<typeof client>(() => {}) : Promise.resolve(client))
    const host = new HostedExecutionHost({ id: 'remote', label: 'Remote', connect })
    const started = Date.now()
    await expect(host.run('/bin/echo', ['first'], { timeoutMs: 300 })).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT', controlFailure: { disposition: 'not_applied' } })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await host.run('/bin/echo', ['second'], { timeoutMs: 20_000 })).toMatchObject({ stdout: 'second\n', exitCode: 0 })
    expect(connect).toHaveBeenCalledTimes(2)
  }, 20_000)

  it('bounds a create that does not reply, and stops and removes its Run if it arrives later', async () => {
    const { client, host } = await fixture()
    const original = client.createPreparedTerminal.bind(client)
    let release!: () => void
    vi.spyOn(client, 'createPreparedTerminal').mockImplementation(async prepared => {
      await new Promise<void>(resolve => { release = resolve })
      return await original(prepared)
    })
    const started = Date.now()
    const error = await host.run('/bin/sh', ['-c', 'sleep 60'], { timeoutMs: 300 }).catch(error => error)
    expect(error).toMatchObject({ code: 'COMMAND_TIMEOUT', controlFailure: { disposition: 'unknown' } })
    expect(Date.now() - started).toBeLessThan(5_000)
    release()
    await until(() => client.listRuns(), runs => runs.length === 0, 'late own Run stopped and removed')
  }, 30_000)

  it('removes a timed-out command Run once its stop is confirmed, keeping unrelated Runs', async () => {
    const { scope, client, host } = await fixture()
    const healthy = await client.createTerminal({ workspacePath: scope.root, command: '/bin/sh', args: ['-c', 'sleep 60'] })
    const remove = vi.spyOn(client, 'removeTerminal')
    for (const attempt of [1, 2, 3]) {
      await expect(host.run('/bin/sh', ['-c', 'sleep 60'], { timeoutMs: 1_500 })).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' })
      void attempt
    }
    await until(() => client.listRuns(), runs => runs.length === 1, 'timed-out own Runs removed')
    expect((await client.listRuns())[0]).toMatchObject({ runId: healthy.runId, state: 'running' })
    expect(remove).toHaveBeenCalledTimes(3)
    expect(remove.mock.calls.every(([run]) => run.runId !== healthy.runId)).toBe(true)
  }, 40_000)

  it('keeps a Run whose stop is not confirmed, for recovery under its original identity', async () => {
    const { client, host } = await fixture()
    vi.spyOn(client, 'stopTerminal').mockRejectedValue(new AgentMuxError('The stop reply was lost.', 'CONTROL_CONNECTION_FAILED'))
    const remove = vi.spyOn(client, 'removeTerminal')
    await expect(host.run('/bin/sh', ['-c', 'sleep 60'], { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' })
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(remove).not.toHaveBeenCalled()
    expect(await client.listRuns()).toHaveLength(1)
  }, 20_000)

  it('rejects invalid command data before creating a connection', async () => {
    const connect = vi.fn()
    const host = new HostedExecutionHost({ id: 'remote', label: 'Remote', connect })
    await expect(host.run('test', ['bad\0arg'])).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
    await expect(host.run('test', [], { env: { 'invalid;name': 'value' } })).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
    expect(connect).not.toHaveBeenCalled()
  })
})

describe('HostedExecutionHost while a native receipt is pending', () => {
  function pendingFixture(stage: 'attachment' | 'input', unknown?: 'stop' | 'end') {
    let token = '', createOperationId = '', releasePending!: () => void, entered!: () => void
    let receive: ((event: AgentMuxClientEvent) => void) | undefined
    const pendingEntered = new Promise<void>(resolve => { entered = resolve })
    const pending = new Promise<void>(resolve => { releasePending = resolve })
    const run: AgentMuxRun = { runId: 'own-command-run', kind: 'terminal', providerId: null, executorId: null,
      agentSessionId: null, workspacePath: fixturePath('command/remote'), pid: null, state: 'running',
      cols: 80, rows: 24, observedAt: 0, latestOutputBytes: 0, acceptedInputBytes: 0, nativeService: null }
    const snapshot = (data = `${token}:ready\n`): AgentMuxRunAttachment => {
      const bytes = Buffer.from(data)
      return { run, gap: null, terminal: { type: 'not-requested' }, resizeRevision: 0,
        replay: [{ runId: run.runId, type: 'data', startByte: 0, endByte: bytes.length, dataBytes: bytes, data }] }
    }
    const client = {
      prepareTerminal: vi.fn(async (input: { createOperationId: string; args: string[] }) => { token = input.args[3]!; createOperationId = input.createOperationId; return input }),
      createPreparedTerminal: vi.fn(async () => run),
      attachTerminal: vi.fn(async () => { if (stage === 'attachment') { entered(); await pending }; return snapshot() }),
      writeTerminal: vi.fn(async (_run: AgentMuxRun, input: { data: string; expectedByte: number }) => { entered(); await pending; return { acceptedThroughByte: input.expectedByte + Buffer.byteLength(input.data) } }),
      stopTerminal: vi.fn(async () => { if (unknown === 'stop') throw new AgentMuxError('The original stop receipt is unconfirmed.', 'CONTROL_CONNECTION_FAILED'); if (unknown !== 'end') run.state = 'exited' }),
      releaseRunAttachment: vi.fn(async () => {}), removeTerminal: vi.fn(async () => {}),
      listRuns: vi.fn(async () => [run]), runtimeIdentity: () => ({ instanceId: 'original-owner' }),
      onRunEvent: vi.fn((_runId: string, listener: (event: AgentMuxClientEvent) => void) => { receive = listener; return () => { receive = undefined } }),
      onStatusEvent: vi.fn(() => () => {}), dispose: vi.fn(async () => {})
    }
    const host = new HostedExecutionHost({ id: 'remote', label: 'Remote', connect: async () => client as never })
    const completeResult = () => {
      run.state = 'exited'
      receive?.({ type: 'terminal-snapshot', ...snapshot(`${token}:ready\n${token}:result:0\n${Buffer.from('finished').toString('base64')}\n\n${token}:done\n`) } as AgentMuxClientEvent)
    }
    return { client, host, run, pendingEntered, releasePending, completeResult, createOperationId: () => createOperationId }
  }

  it.each(['attachment', 'input'] as const)('deadline settles while the %s receipt never replies and cleans up its late attachment once', async stage => {
    vi.useFakeTimers()
    const f = pendingFixture(stage)
    let outcome: unknown
    const result = f.host.run('/bin/echo', ['literal'], { timeoutMs: 100, input: 'x'.repeat(32 * 1024) }).catch(error => error)
    void result.then(value => { outcome = value })
    try {
      await f.pendingEntered
      await vi.advanceTimersByTimeAsync(100)
      expect(outcome).toMatchObject({ code: 'COMMAND_TIMEOUT', controlFailure: { disposition: 'unknown' } })
      expect(JSON.parse((outcome as AgentMuxError).detail!)).toMatchObject({ createOperationId: f.createOperationId(), runId: f.run.runId,
        ...(stage === 'input' ? { inputOperationId: expect.any(String) } : {}) })
      expect(f.client.createPreparedTerminal).toHaveBeenCalledOnce()
      expect(f.client.writeTerminal).toHaveBeenCalledTimes(stage === 'input' ? 1 : 0)
      expect(f.client.stopTerminal).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId })
      f.releasePending(); await vi.advanceTimersByTimeAsync(0)
      expect(f.client.releaseRunAttachment).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId })
      expect(f.client.removeTerminal).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId })
      expect(f.client.writeTerminal).toHaveBeenCalledTimes(stage === 'input' ? 1 : 0)
    } finally { f.releasePending(); await vi.advanceTimersByTimeAsync(1_000); await result; vi.useRealTimers() }
  })

  it.each(['attachment', 'input'] as const)('abort settles while the %s receipt never replies without input replay or a replacement Run', async stage => {
    vi.useFakeTimers()
    const f = pendingFixture(stage), controller = new AbortController()
    let outcome: unknown
    const result = f.host.run('/bin/echo', ['literal'], { signal: controller.signal, input: 'x'.repeat(32 * 1024) }).catch(error => error)
    void result.then(value => { outcome = value })
    try {
      await f.pendingEntered
      controller.abort(); await vi.advanceTimersByTimeAsync(0)
      expect(outcome).toMatchObject({ code: 'COMMAND_ABORTED', controlFailure: { disposition: 'unknown' } })
      expect(JSON.parse((outcome as AgentMuxError).detail!)).toMatchObject({ createOperationId: f.createOperationId(), runId: f.run.runId,
        ...(stage === 'input' ? { inputOperationId: expect.any(String) } : {}) })
      expect(f.client.stopTerminal).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId })
      f.releasePending(); await vi.advanceTimersByTimeAsync(0)
      expect(f.client.releaseRunAttachment).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId })
      expect(f.client.createPreparedTerminal).toHaveBeenCalledOnce()
      expect(f.client.writeTerminal).toHaveBeenCalledTimes(stage === 'input' ? 1 : 0)
    } finally { f.releasePending(); await vi.advanceTimersByTimeAsync(1_000); await result; vi.useRealTimers() }
  })

  it.each(['stop', 'end'] as const)('a late attachment keeps its exact Run when %s is unconfirmed', async unknown => {
    vi.useFakeTimers()
    const f = pendingFixture('attachment', unknown)
    let outcome: unknown
    const result = f.host.run('/bin/echo', ['literal'], { timeoutMs: 100 }).catch(error => error)
    void result.then(value => { outcome = value })
    try {
      await f.pendingEntered
      await vi.advanceTimersByTimeAsync(100)
      expect(outcome).toMatchObject({ code: 'COMMAND_TIMEOUT', controlFailure: { disposition: 'unknown' } })
      f.releasePending(); await vi.advanceTimersByTimeAsync(1_000)
      expect(f.client.releaseRunAttachment).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId })
      expect(f.client.removeTerminal).not.toHaveBeenCalled()
    } finally { f.releasePending(); await vi.advanceTimersByTimeAsync(1_000); await result; vi.useRealTimers() }
  })

  it.each(['result-first', 'receipt-first'] as const)('returns the complete original result without sending more input when the %s settles first', async order => {
    vi.useFakeTimers()
    const f = pendingFixture('input')
    let outcome: unknown
    const result = f.host.run('/bin/echo', ['literal'], { input: 'x'.repeat(32 * 1024) }).then(value => { outcome = value; return value })
    try {
      await f.pendingEntered
      if (order === 'receipt-first') f.releasePending()
      f.completeResult(); await vi.advanceTimersByTimeAsync(0)
      expect(outcome).toEqual({ stdout: 'finished', stderr: '', exitCode: 0 })
      expect(f.client.stopTerminal).not.toHaveBeenCalled()
      expect(f.client.writeTerminal).toHaveBeenCalledOnce()
      f.releasePending(); await vi.advanceTimersByTimeAsync(0)
      expect(f.client.writeTerminal).toHaveBeenCalledOnce()
      expect(f.client.releaseRunAttachment).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId })
      expect(f.client.removeTerminal).toHaveBeenCalledExactlyOnceWith({ runId: f.run.runId })
    } finally { f.releasePending(); await vi.advanceTimersByTimeAsync(1_000); await result; vi.useRealTimers() }
  })
})
