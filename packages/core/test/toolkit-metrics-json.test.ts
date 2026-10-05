import { fixturePath } from './helpers/fixture-values.js'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../src/control-host.js'
import { parseToolkitResult, parseToolkitSnapshot } from '../src/toolkit.js'
import { parseMetricsObservation } from '../src/metrics.js'
import { settingsResourceRecord } from '../src/settings-resource-json.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES } from '../src/control.js'
import { deepMetricsSnapshot } from './helpers/toolkit-metrics.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
it('preserves both nonempty terminal interaction and tab-switch observations through typed wrappers', () => {
  const snapshot = deepMetricsSnapshot()
  expect(() => settingsResourceRecord({ snapshot }, 'CONTROL_PROTOCOL_ERROR')).toThrow('Settings resource JSON')
  expect(parseMetricsObservation(snapshot.observation)).toEqual(snapshot.observation)
  expect(() => parseToolkitSnapshot(snapshot)).not.toThrow()
  expect(parseToolkitSnapshot(snapshot)).toEqual(snapshot)
  expect(() => parseToolkitResult('toolkit.get', { snapshot })).not.toThrow()
  expect(parseToolkitResult('toolkit.get', { snapshot })).toEqual({ operation: 'toolkit.get', snapshot })
  const tabsOnly = deepMetricsSnapshot(); tabsOnly.observation!.renderer.data!.performance.terminals = []
  expect(parseToolkitResult('toolkit.get', { snapshot: tabsOnly })).toEqual({ operation: 'toolkit.get', snapshot: tabsOnly })
})
it('rejects malformed typed observations before serialization', () => {
  const nan = deepMetricsSnapshot(); nan.observation!.renderer.data!.performance.terminals[0]!.interaction.keydown.delay.maxMs = NaN
  expect(() => parseToolkitSnapshot(nan)).toThrow()
  const mismatch = deepMetricsSnapshot(); mismatch.observation!.window!.generation++
  expect(() => parseToolkitResult('toolkit.get', { snapshot: mismatch })).toThrow()
})
it.each(['record getter', 'record symbol', 'record nonenumerable', 'record extra', 'record prototype', 'array getter', 'array symbol', 'array nonenumerable', 'array extra', 'array prototype', 'array iterator', 'array hole', 'cycle'])('rejects %s without executing user code', kind => {
  const snapshot = deepMetricsSnapshot(), perf = snapshot.observation!.renderer.data!.performance
  let invoked = 0
  const getter = () => { invoked++; return 1000 }
  if (kind === 'record getter') Object.defineProperty(perf, 'observedAt', { get: getter, enumerable: true })
  if (kind === 'record symbol') Object.defineProperty(perf, Symbol('extra'), { value: 1 })
  if (kind === 'record nonenumerable') Object.defineProperty(perf, 'observedAt', { value: perf.observedAt, enumerable: false })
  if (kind === 'record extra') Object.defineProperty(perf, 'extra', { value: 1 })
  if (kind === 'record prototype') Object.setPrototypeOf(perf, { toJSON: getter })
  if (kind === 'array getter') Object.defineProperty(perf.terminals, '0', { get: getter, enumerable: true })
  if (kind === 'array symbol') Object.defineProperty(perf.terminals, Symbol('extra'), { value: 1 })
  if (kind === 'array nonenumerable') Object.defineProperty(perf.terminals, '0', { value: perf.terminals[0], enumerable: false })
  if (kind === 'array extra') Object.defineProperty(perf.terminals, 'extra', { value: 1 })
  if (kind === 'array prototype') Object.setPrototypeOf(perf.terminals, { toJSON: getter })
  if (kind === 'array iterator') Object.defineProperty(perf.terminals, Symbol.iterator, { get: getter })
  if (kind === 'array hole') delete perf.terminals[0]
  if (kind === 'cycle') (perf as any).terminals[0] = perf
  expect(() => parseToolkitSnapshot(snapshot)).toThrow()
  expect(invoked).toBe(0)
})
it('retains arbitrary Settings depth and package retained cycle guards', () => {
  const deep = (n: number): any => n ? { child: deep(n - 1) } : 0
  expect(() => settingsResourceRecord(deep(8), 'CONTROL_PROTOCOL_ERROR')).not.toThrow()
  expect(() => settingsResourceRecord(deep(9), 'CONTROL_PROTOCOL_ERROR')).toThrow()
  const cyclic: any = { schema: 'agentmux.toolkit.v1', kind: 'package-unavailable', toolId: 'user',
    configuration: { kind: 'package', id: 'user', packagePath: fixturePath("tmp/tool"), enabled: true, statusBar: 'icon', workspacePath: fixturePath('temporary'), args: [], revision: 'rev' }, reason: 'unavailable' }
  cyclic.retained = cyclic
  expect(() => parseToolkitSnapshot(cyclic)).toThrow('Settings resource JSON')
})
it('retains complete message byte budget without truncating valid metrics', () => {
  const snapshot = deepMetricsSnapshot(), text = '\x01'.repeat(4096)
  snapshot.observation!.process = { state: 'available', observedAt: 1000, lastSuccessAt: 1000, reason: null,
    data: Array.from({ length: 1400 }, () => ({ runId: text, hostId: text, rootPid: 1, processCount: 1,
      cpuPercent: 0, rssKib: 1, rootRssKib: 1, descendantsRssKib: 0, descendantProcessCount: 0 })) }
  expect(parseMetricsObservation(snapshot.observation)).toBe(snapshot.observation)
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES)
  expect(() => parseToolkitSnapshot(snapshot)).toThrow('budget')
})
it.each(['terminals', 'tabSwitches', 'slowEvents', 'trend', 'process'])('retains typed %s count budget', kind => {
  const snapshot = deepMetricsSnapshot(), perf = snapshot.observation!.renderer.data!.performance
  if (kind === 'terminals') perf.terminals = Array(65).fill(perf.terminals[0])
  if (kind === 'tabSwitches') perf.tabSwitches = Array(17).fill(perf.tabSwitches[0])
  if (kind === 'slowEvents') perf.slowEvents = Array(33).fill({ kind: 'terminal-interaction', detail: 'keydown', durationMs: 1, observedAt: 1 }) as any
  if (kind === 'trend') snapshot.trend = Array(61).fill(snapshot.trend[0])
  if (kind === 'process') snapshot.observation!.process = { state: 'available', observedAt: 1000, lastSuccessAt: 1000, reason: null, data: Array(4097).fill({ runId: 'run', hostId: 'local', rootPid: 1, processCount: 1, cpuPercent: 0, rssKib: 1, rootRssKib: 1, descendantsRssKib: 0, descendantProcessCount: 0 }) }
  expect(() => parseToolkitSnapshot(snapshot)).toThrow()
})
it('serves complete deep metrics through real Unix RPC and compiled CLI inspect/watch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-toolkit-metrics-')), snapshot = deepMetricsSnapshot(), disposals = vi.fn()
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const owner = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: vi.fn(),
    toolkit: { execute: async () => ({ operation: 'toolkit.get', snapshot }),
      subscribe: async (_id, push) => { push(snapshot); return { dispose: disposals } } } })
  await owner.start(); cleanup.push(() => owner.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'control.sock') } })
  cleanup.push(() => rpc.dispose())
  expect(await rpc.call('toolkit.inspect', { toolId: 'performance' })).toEqual({ snapshot })
  const frames: unknown[] = [], subscription = await rpc.subscribe('toolkit.watch', { toolId: 'performance' }, { onInitial: () => {}, onEvent: event => frames.push(event) })
  await vi.waitFor(() => expect(frames).toEqual([{ type: 'snapshot', data: snapshot }]))
  await subscription.dispose(); await vi.waitFor(() => expect(disposals).toHaveBeenCalledOnce())
  const env = objectCliEnvironment(root)
  const result = await runCompiledObjectCli(['toolkit', 'inspect', 'performance'], env)
  expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout).result.snapshot).toEqual(snapshot)
  const cli = fileURLToPath(new URL('../bin/amux', import.meta.url))
  const child = spawn(process.execPath, [cli, 'toolkit', 'watch', 'performance'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  cleanup.push(() => { if (child.exitCode === null) child.kill('SIGTERM') })
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  await vi.waitFor(() => {
    const values = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    expect(values.some(value => JSON.stringify(value).includes('"interaction"')), stderr).toBe(true)
    expect(values.at(-1)?.params?.event?.data).toEqual(snapshot)
  }, { timeout: 5000 })
  child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()))
  await vi.waitFor(() => expect(disposals).toHaveBeenCalledTimes(2))
}, 15000)
