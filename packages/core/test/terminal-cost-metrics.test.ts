import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../src/control-host.js'
import { parseMetricsObservation, parseRendererPerformanceSnapshot, type MetricsObservation } from '../src/metrics.js'
import { performanceFixture, terminalCostFixture } from './helpers/renderer-performance.js'
import { rendererMemoryFixture } from './helpers/toolkit-metrics.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

function observation(): MetricsObservation {
  const pending = { state: 'pending', data: null, observedAt: null, lastSuccessAt: null, reason: null } as const
  const window = { windowId: 1, webContentsId: 2, generation: 3 }
  const visible = terminalCostFixture(1), hidden = terminalCostFixture(2)
  visible.writes.live = { started: 3, completed: 2, bytes: 37, stringCodeUnits: 0, callbackWall: { count: 2, totalMs: 11, maxMs: 7 } }
  visible.renderCallbacks = 4
  hidden.visible = false
  hidden.writes.checkpoint = { started: 1, completed: 1, bytes: 0, stringCodeUnits: 9, callbackWall: { count: 1, totalMs: 5, maxMs: 5 } }
  return { schema: 'agentmux.metrics.v1', observedAt: 1000,
    scope: { kind: 'unix-host', hostId: 'local', hostname: 'private-host', mainPid: 100 }, window,
    units: { cpu: 'percent', cpuBasis: 'one-logical-core', rss: 'KiB', storage: 'bytes', cpuAggregate: '10s-reading-peak', rssAggregate: 'latest' },
    process: pending, runTotals: null, app: pending, runtime: pending, main: pending, diagnostics: pending,
    renderer: { state: 'available', observedAt: 900, lastSuccessAt: 900, reason: null, data: {
      ...rendererMemoryFixture(), window, counts: { monacoEditors: null, monacoModels: 0, documents: 1, runtimeSubscriptions: 2,
        terminalViews: 2, terminalAddons: 0, terminalListeners: 0 },
      performance: { ...performanceFixture(), terminals: [visible, hidden], omittedTerminals: 3, unavailableTerminals: 1 } } } }
}
const close: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn() })
function expectTerminals(value: MetricsObservation, expected = observation()) {
  expect(value.renderer.data!.performance.terminals).toHaveLength(2)
  expect(value.renderer.data!.performance.terminals).toEqual(expected.renderer.data!.performance.terminals)
  expect(value.renderer.data!.performance).toMatchObject({ omittedTerminals: 3, unavailableTerminals: 1 })
}

it('requires exact nonempty terminal cost fields and rejects missing, unknown, accessor and invalid measurements', () => {
  expectTerminals(parseMetricsObservation(observation()))
  const mutate = (change: (row: any) => void) => {
    const value = observation().renderer.data!.performance
    change(value.terminals[0])
    expect(() => parseRendererPerformanceSnapshot(value)).toThrow()
  }
  for (const field of ['hostId', 'instanceId', 'writes', 'renderCallbacks']) mutate(row => { delete row[field] })
  for (const cause of ['live', 'history', 'checkpoint']) mutate(row => { delete row.writes[cause] })
  for (const field of ['started', 'completed', 'bytes', 'stringCodeUnits', 'callbackWall']) mutate(row => { delete row.writes.live[field] })
  for (const value of [-1, NaN, Infinity, 1.5]) mutate(row => { row.writes.live.started = value })
  mutate(row => { row.writes.live.callbackWall.maxMs = NaN })
  mutate(row => { row.writes.live.payload = 'not permitted' })
  const getter = vi.fn(() => 1)
  mutate(row => { Object.defineProperty(row, 'renderCallbacks', { enumerable: true, get: getter }) })
  expect(getter).not.toHaveBeenCalled()
})

async function owner() {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-cost-metrics-')), path = join(directory, 'control.sock')
  let current = observation()
  const listeners = new Set<(value: MetricsObservation) => void>(), released = vi.fn(), execute = vi.fn()
  const server = new AgentMuxControlServer({ execute, metrics: { async subscribe(push) {
    listeners.add(push); push(current)
    return { dispose: () => { listeners.delete(push); released() } }
  } } }, path)
  await server.start()
  close.push(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }) })
  return { directory, path, execute, released, listeners,
    publish(value: MetricsObservation) { current = value; for (const listener of listeners) listener(value) } }
}

it('preserves two exact instances and subsequent completion through real public get and watch', async () => {
  const source = await owner(), client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: source.path } })
  close.push(() => client.dispose())
  expectTerminals((await client.call('system.metrics.get', {})).observation)
  const frames: any[] = []
  const subscription = await client.subscribe('system.metrics.watch', {}, { onFrame: frame => frames.push(frame), onInitial: () => {}, onEvent: () => {} })
  expectTerminals(frames[0].result.initial.observation)
  const next = observation(); next.renderer.data!.performance.terminals[0]!.writes.live.completed++
  source.publish(next)
  await vi.waitFor(() => expect(frames).toHaveLength(2))
  expectTerminals(frames[1].params.event.data, next)
  expectTerminals(frames[0].result.initial.observation)
  await subscription.dispose()
  await vi.waitFor(() => expect(source.released).toHaveBeenCalledTimes(2))
  expect(source.listeners.size).toBe(0); expect(source.execute).not.toHaveBeenCalled()
})

it.each(['get', 'watch'] as const)('actual CLI system metrics %s returns nonempty current terminal ownership and measurements', async verb => {
  const sourceEntry = process.env.AGENTMUX_METRICS_CLI ?? fileURLToPath(new URL('../bin/amux', import.meta.url))
  const source = await owner()
  const child: ChildProcess = spawn(process.execPath, [sourceEntry!, '--endpoint', 'unix://' + source.path, 'system', 'metrics', verb], {
    env: objectCliEnvironment(source.directory), stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise<number | null>(resolve => child.once('close', resolve))
  close.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  let stdout = '', stderr = ''
  child.stdout!.on('data', chunk => { stdout += chunk.toString() }); child.stderr!.on('data', chunk => { stderr += chunk.toString() })
  await vi.waitFor(() => { expect(stderr).toBe(''); expect(stdout).toContain('\n') }, { timeout: 10000 })
  if (verb === 'watch') child.kill('SIGINT')
  const code = await exited
  if (process.env.AGENTMUX_TERMINAL_COST_CLI_RAW) await appendFile(process.env.AGENTMUX_TERMINAL_COST_CLI_RAW, JSON.stringify({ verb, code, stdout, stderr }) + '\n')
  expect(code).toBe(0); expect(stderr).toBe('')
  const frames = stdout.trim().split('\n').map(line => JSON.parse(line))
  expect(frames).toHaveLength(1)
  expectTerminals(verb === 'get' ? frames[0].result.observation : frames[0].result.initial.observation)
  await vi.waitFor(() => expect(source.released).toHaveBeenCalledOnce())
  expect(source.execute).not.toHaveBeenCalled()
})
