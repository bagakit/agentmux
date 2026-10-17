import { fixtureEpoch as _followupFixtureEpoch } from "../../../test/fixture-values.mjs"
import { spawn } from 'node:child_process'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, parseAgentMuxControlRequest } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs } from '../src/control.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { parseRpcControlResult, rpcControlRequest } from '../src/rpc-business-codec.js'
import { parseRendererAnimationsInput, parseRendererAnimationsResult, RENDERER_ANIMATIONS_MAX_ITEMS,
  type RendererAnimationsResult } from '../src/renderer-animations.js'
import { compileRendererProfileCli } from './helpers/renderer-profile-cli.js'

const target = { windowId: 2, webContentsId: 3, generation: 4, pid: 123, creationTime: 100.5 }
function observation(): RendererAnimationsResult {
  return { schema: 'agentmux.renderer-animations.v1', scope: 'renderer-document', target: { ...target }, status: 'completed',
    timing: { requestedAt: _followupFixtureEpoch(0, 0, 1000), sampledAt: _followupFixtureEpoch(0, 0, 1002), finishedAt: _followupFixtureEpoch(0, 0, 1003) }, sourceVerified: { before: true, after: true },
    evaluation: { requested: true, settled: true }, issues: [],
    snapshot: { totalAnimations: 3, omittedAnimations: 1, animations: [
      { kind: 'css-animation', name: 'ambient', playState: 'running', pending: false, currentTime: -2.5,
        duration: 2000, iterations: 'infinite', ancestry: ['span.indicator', 'div.workface'], stringsTruncated: false, targetTruncated: true },
      { kind: 'web-animation', name: null, playState: 'paused', pending: true, currentTime: null,
        duration: 'auto', iterations: 2.5, ancestry: null, stringsTruncated: false, targetTruncated: false }
    ] } }
}
function incomplete(status: 'failed' | 'unknown'): RendererAnimationsResult {
  return { ...observation(), status, timing: { requestedAt: _followupFixtureEpoch(0, 0, 1000), sampledAt: null, finishedAt: _followupFixtureEpoch(0, 0, 1003) },
    sourceVerified: { before: true, after: false }, evaluation: { requested: true, settled: false }, snapshot: null,
    issues: [{ stage: 'evaluation', code: 'OBSERVATION_UNCONFIRMED', message: 'Original document read is unconfirmed.', messageTruncated: false }] }
}
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function owner(result: RendererAnimationsResult | (() => RendererAnimationsResult) = observation()) {
  const directory = await mkdtemp(join(tmpdir(), 'animations-'))
  const inspectAnimations = vi.fn(async () => typeof result === 'function' ? result() : result)
  const execute = vi.fn(() => { throw new Error('No unrelated operation may execute.') })
  const subscribe = vi.fn(() => { throw new Error('No periodic metrics reader may start.') })
  const server = new AgentMuxControlServer({ execute, metrics: { inspectAnimations, subscribe } }, join(directory, 'control.sock'))
  await server.start()
  cleanup.push(async () => { await server.stop(); await rm(directory, { recursive: true }) })
  return { directory, path: join(directory, 'control.sock'), inspectAnimations, subscribe, execute }
}
async function call(path: string) {
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  try { return await client.call('system.metrics.animations.inspect', { target }) } finally { await client.dispose() }
}
let entry: string
beforeAll(async () => {
  const root = process.env.AGENTMUX_ANIMATIONS_SOURCE_ROOT, directory = process.env.AGENTMUX_ANIMATIONS_OUTPUT
  if (!root || !directory || !process.env.AGENTMUX_ANIMATIONS_PRIVATE_ROOT) throw new Error('Private animation consumer preparation is required.')
  const frozen: Record<string, string> = process.env.AGENTMUX_ANIMATIONS_FROZEN ? JSON.parse(process.env.AGENTMUX_ANIMATIONS_FROZEN) : {}
  entry = await compileRendererProfileCli(root, directory, frozen, process.env.AGENTMUX_ANIMATIONS_LOADED)
})
async function cli(directory: string, args: string[]) {
  const child = spawn(process.execPath, [entry, '--endpoint', 'unix://' + join(directory, 'control.sock'), ...args], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes.toString() }); child.stderr.on('data', bytes => { stderr += bytes.toString() })
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    await appendFile(join(process.env.AGENTMUX_ANIMATIONS_OUTPUT!, 'cli.ndjson'), JSON.stringify({ args, pid: child.pid, code, stdout, stderr }) + '\n')
    return { code, stdout, stderr }
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
}
const args = ['system', 'metrics', 'animations', 'inspect', '--window-id', '2', '--web-contents-id', '3', '--generation', '4', '--pid', '123', '--creation-time', '100.5']

it('preserves nonempty native timing, unsupported values, omission and explicit truncation facts without mutation', () => {
  const value = observation(), original = JSON.stringify(value)
  value.snapshot!.animations[1]!.duration = 'infinite'
  expect(parseRendererAnimationsResult(value, { target })).toBe(value)
  value.snapshot!.animations[1]!.duration = 'auto'
  expect(JSON.stringify(value)).toBe(original)
  expect(parseRendererAnimationsInput({ target }).target).toBe(target)
  for (const status of ['failed', 'unknown'] as const) expect(parseRendererAnimationsResult(incomplete(status)).status).toBe(status)
})

it('strictly rejects invented timing, overflow, missing source facts and non-data values without evaluating getters', () => {
  const changes: ((v: RendererAnimationsResult) => void)[] = [
    v => { v.snapshot!.animations[0]!.iterations = Infinity },
    v => { v.snapshot!.animations[0]!.currentTime = NaN },
    v => { v.snapshot!.animations[0]!.duration = -1 },
    v => { v.snapshot!.animations[0]!.name = 'x'.repeat(129) },
    v => { v.snapshot!.animations[0]!.ancestry = ['a', 'b', 'c', 'd'] },
    v => { v.snapshot!.animations.push(...Array.from({ length: RENDERER_ANIMATIONS_MAX_ITEMS }, () => ({ ...v.snapshot!.animations[0]! }))) },
    v => { v.snapshot!.omittedAnimations++ },
    v => { v.sourceVerified.after = false },
    v => { v.evaluation.requested = false },
    v => { v.timing.sampledAt = _followupFixtureEpoch(0, 0, 999) },
    v => { Reflect.deleteProperty(v.snapshot!.animations, '0') },
    v => { Object.assign(v.snapshot!.animations[0]!, { textContent: 'private text must not be accepted' }) }
  ]
  for (const change of changes) {
    const value = observation(); change(value)
    expect(() => parseRendererAnimationsResult(value)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  }
  let reads = 0
  const value = observation()
  Object.defineProperty(value.snapshot!.animations[0], 'name', { enumerable: true, get() { reads++; return 'private' } })
  expect(() => parseRendererAnimationsResult(value)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(reads).toBe(0)
  const coercible = observation()
  Object.assign(coercible, { status: { toString() { reads++; return 'completed' } } })
  expect(() => parseRendererAnimationsResult(coercible)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(reads).toBe(0)
})

it('maps exact request/result through the original strict control and business codecs', () => {
  const request = rpcControlRequest('system.metrics.animations.inspect', { target })
  expect(parseAgentMuxControlRequest(request)).toMatchObject({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'metrics.animations.inspect', target })
  expect(agentMuxControlTimeoutMs(request.operation)).toBe(agentMuxControlTimeoutMs('metrics.memory.inspect'))
  const value = observation()
  expect(parseRpcControlResult('system.metrics.animations.inspect', { observation: value }, { target })).toEqual({ observation: value })
  expect(() => parseAgentMuxControlRequest({ ...request, script: 'arbitrary caller code' })).toThrow()
  expect(() => parseRendererAnimationsInput({ target: { ...target, generation: -1 } })).toThrow()
  expect(() => parseRpcControlResult('system.metrics.animations.inspect', { observation: value, unknown: true }, { target })).toThrow()
})

it('routes one actual Unix RPC read to the original metrics port and preserves the exact result', async () => {
  const value = observation(), f = await owner(value)
  expect(await call(f.path)).toEqual({ observation: value })
  expect(f.inspectAnimations).toHaveBeenCalledExactlyOnceWith({ target }, expect.any(AbortSignal))
  expect(f.subscribe).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
})

it('rejects a foreign original target returned by the owner', async () => {
  const value = observation(); value.target.creationTime++
  const f = await owner(value)
  await expect(call(f.path)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(f.inspectAnimations).toHaveBeenCalledOnce()
  expect(value.target.creationTime).toBe(target.creationTime + 1)
  expect(f.subscribe).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
})

it('reports unsupported through the original service without starting another diagnostic or Runtime', async () => {
  const execute = vi.fn(), service = new AgentMuxRpcService({ execute })
  await expect(service.call('system.metrics.animations.inspect', { target })).rejects.toMatchObject({ code: 'METRICS_UNSUPPORTED' })
  expect(execute).not.toHaveBeenCalled()
})

it('compiled public CLI discovers help/skill and consumes completed/failed/unknown as distinct exit facts', async () => {
  let value = observation()
  const f = await owner(() => value)
  for (const flags of [['system', 'metrics', 'animations', 'inspect', '--help'], ['system', '--skill']]) {
    const help = await cli(f.directory, flags)
    expect(help.code).toBe(0); expect(help.stderr).toBe('')
    expect(help.stdout).toContain('animations inspect')
  }
  expect(f.inspectAnimations).not.toHaveBeenCalled()
  for (const status of ['completed', 'failed', 'unknown'] as const) {
    value = status === 'completed' ? observation() : incomplete(status)
    const result = await cli(f.directory, args)
    expect(result.code).toBe(status === 'completed' ? 0 : 1)
    expect(result.stderr).toBe('')
    const frame = JSON.parse(result.stdout)
    expect(frame).toMatchObject({ ok: true, operation: 'system.metrics.animations.inspect', result: { observation: value } })
  }
  expect(f.inspectAnimations).toHaveBeenCalledTimes(3)
  const invalid = await cli(f.directory, [...args, '--output', 'not-supported.json'])
  expect(invalid.code).toBe(1)
  expect(JSON.parse(invalid.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
  expect(f.inspectAnimations).toHaveBeenCalledTimes(3)
  expect(f.subscribe).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
})
