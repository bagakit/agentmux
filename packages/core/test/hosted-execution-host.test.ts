import { mkdir, readFile, realpath, access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { HostedExecutionHost as SourceHostedExecutionHost } from '../src/hosted-execution-host.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'

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

  it('rejects invalid command data before creating a connection', async () => {
    const connect = vi.fn()
    const host = new HostedExecutionHost({ id: 'remote', label: 'Remote', connect })
    await expect(host.run('test', ['bad\0arg'])).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
    await expect(host.run('test', [], { env: { 'invalid;name': 'value' } })).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
    expect(connect).not.toHaveBeenCalled()
  })
})
