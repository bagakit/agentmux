import { spawn } from 'node:child_process'
import { terminalWriteContextFixture } from './helpers/renderer-performance.js'
import { expect, it, vi } from 'vitest'
import { createRendererPerformance } from '../../../apps/desktop/src/renderer/src/lib/renderer-performance'
import { createTabSwitchObservation } from '../../../apps/desktop/src/renderer/src/lib/tab-switch-observation'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'
import { parseAgentMuxControlReceipt } from '../src/control-codec.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentMuxControlServer } from '../src/control-host.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseMetricsObservation } from '../src/metrics.js'
import { parseToolkitSnapshot } from '../src/toolkit.js'
import { createInputPerformanceRecorder, hostedCarrierPerformance } from '../src/performance-diagnostics.js'
import { deepMetricsSnapshot } from './helpers/toolkit-metrics.js'
import { correlationParent } from './helpers/input-correlation.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

it('preserves nonempty stage evidence and unknown sources through actual Unix RPC, compiled CLI and typed Toolkit', async () => {
  let ms = 0
  const recorder = createInputPerformanceRecorder(() => ms, () => 1000 + ms)
  const input = recorder.begin({ sessionId: 'public-session', runId: 'public-run', kind: 'protocol', bytes: 6, hostId: 'local', parent: correlationParent('protocol'),
    sender: { webContentsId: 771, window: { windowId: 77, webContentsId: 771, generation: 4 } } })
  input.executionOwner('public-daemon')
  ms += 21; input.dequeue()
  await expect(input.measure('native-input', async () => { ms += 31; throw new Error('synthetic rejected input') })).rejects.toThrow()
  input.settle(false)
  const toolkit = deepMetricsSnapshot(), observation = toolkit.observation!
  observation.diagnostics = { state: 'available', observedAt: 1000, lastSuccessAt: 1000, reason: null,
    data: { main: { processId: process.pid, observedAt: 1000, input: recorder.snapshot(), carrier: hostedCarrierPerformance.snapshot() },
      hosts: [{ hostId: 'unavailable-host', data: null, unavailable: 'connected owner could not answer' }], omittedHosts: 0,
      storage: { location: 'main-user-home-volume', availableBytes: 0, totalBytes: 1000000 }, storageUnavailable: null,
      eventLoop: { resolutionMs: 20, generation: 3, count: 1, meanMs: 80, maxMs: 80 } } }
  // Use actual production recorders, not a hand-authored public field fixture.
  let time = 1000
  const renderer = createRendererPerformance(() => time, () => 1000 + time)
  time = 1070; renderer.sessionEvent('status', 1000)
  time = 2900; renderer.terminalWrite(false, 'private-output', 1083.3, { ...terminalWriteContextFixture(), runId: 'exact-peak-run', cause: 'checkpoint' })
  for (let i = 0; i < 40; i++) { time += 100; renderer.terminalWrite(false, new Uint8Array(1), time - 70, terminalWriteContextFixture()) }
  const callbacks: FrameRequestCallback[] = []
  const navigation = createTabSwitchObservation(() => time, () => 1000 + time,
    callback => { callbacks.push(callback); return callbacks.length }, () => {})
  const target = { presentationId: 'public-space', displayWorkspaceId: 'public-workspace', groupId: 'public-group', tabId: 'public-tab', regionId: 'public-region' }
  navigation.registerPlacement(target, () => true)
  navigation.registerTerminal(target, () => ({ sessionId: 'public-session', runId: 'public-run', readySinceAt: null,
    visible: true, revealed: true, liveReady: false, acceptsInput: false, readOnly: false, replaying: true }))
  navigation.begin(target, 'terminal', null); navigation.selected(target)
  callbacks.shift()!(time); callbacks.shift()!(time); time += 1500
  observation.renderer.data!.performance = { ...renderer.snapshot(), tabSwitches: navigation.snapshot(), tabSwitchesOmitted: navigation.omitted() }
  const pendingRequest = renderer.beginInputRequest('user', renderer.start(), { hostId: 'local', sessionId: 'public-session', runId: 'public-run' })
  expect(pendingRequest.parent).toBeDefined()
  observation.renderer.data!.performance.inputRequestDetails = renderer.snapshot().inputRequestDetails
  const expectedRenderer = observation.renderer.data!.performance
  expect(expectedRenderer.slowEventsOmitted['terminal-write']).toBe(36)
  expect(expectedRenderer.slowEvents.some(event => event.kind === 'session-event')).toBe(true)
  expect(expectedRenderer.slowEvents.find(event => event.retainedAs.includes('current-peak') && event.kind === 'terminal-write')).toMatchObject({ terminal: { runId: 'exact-peak-run', cause: 'checkpoint', payload: { unit: 'string-code-units', length: 14 } } })
  expect(expectedRenderer.timingEpochs.current.timings['terminal-write']).toEqual({ count: 41, totalMs: 4616.7, maxMs: 1816.7 })
  expect(expectedRenderer.tabSwitches[0]).toMatchObject({ state: 'pending', pendingStage: 'input-gate', elapsedMs: 1500 })
  expect(parseToolkitSnapshot(toolkit)).toEqual(toolkit)
  const receipt = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'correlated-input', operation: 'toolkit.get', ok: true, result: { snapshot: toolkit } }
  expect(parseAgentMuxControlReceipt(receipt)).toEqual(receipt)
  const bad = structuredClone(observation); bad.diagnostics.data!.main.input.active = Array.from({ length: 65 }, () => recorder.snapshot().recent[0]!)
  expect(() => parseMetricsObservation(bad)).toThrow()
  for (const parent of [{ ...correlationParent(), sequence: 0 }, { ...correlationParent(), observerId: 'not-a-nonce' }, { ...correlationParent(), source: 'mouse' }]) {
    const invalid = structuredClone(observation); invalid.diagnostics.data!.main.input.recent[0]!.parent = parent as never
    expect(() => parseMetricsObservation(invalid)).toThrow()
  }
  const wrongUnits = structuredClone(observation); (wrongUnits.units as any).cpuBasis = 'whole-machine'
  expect(() => parseMetricsObservation(wrongUnits)).toThrow()
  const missing = structuredClone(observation); delete (missing.diagnostics.data!.main.input as any).nativeInput
  expect(() => parseMetricsObservation(missing)).toThrow()
  const directory = await mkdtemp(join(tmpdir(), 'amux-perf-public-')), path = join(directory, 'control.sock')
  const execute = vi.fn(), releases = vi.fn()
  const owner = new AgentMuxControlServer({ execute, coreClients: () => [], toolkit: {
    async execute(request) { expect(request.operation).toBe('toolkit.get'); return { operation: 'toolkit.get', snapshot: toolkit } },
    async subscribe() { throw new Error('No Toolkit watch requested in this test') }
  }, metrics: {
    async subscribe(push) { queueMicrotask(() => push(observation)); return { dispose: releases } }
  } }, path)
  await owner.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  try {
    const result = await client.call('system.metrics.get', {})
    expect(result.observation.diagnostics).toEqual(observation.diagnostics)
    expect(result.observation.renderer.data!.performance).toEqual(expectedRenderer)
    const initial = new Promise<void>((resolve, reject) => {
      void client.subscribe('system.metrics.watch', {}, { onInitial(value) {
        try { expect(value.observation.diagnostics).toEqual(observation.diagnostics); expect(value.observation.renderer.data!.performance).toEqual(expectedRenderer); resolve() } catch (error) { reject(error) }
      }, onEvent: () => {}, onEnd: error => { if (error) reject(error) } }).then(sub => sub.dispose(), reject)
    })
    await initial
    const cli = await runCompiledObjectCli(['--endpoint', 'unix://' + path, 'system', 'metrics', 'get'], objectCliEnvironment(directory))
    expect(cli.code).toBe(0); expect(cli.stderr).toBe('')
    const parsedCli = JSON.parse(cli.stdout.trim())
    expect(parsedCli.result.observation.renderer.data.performance).toEqual(expectedRenderer)
    const viaToolkit = await client.call('toolkit.inspect', { toolId: 'performance' })
    expect(viaToolkit.snapshot).toEqual(toolkit)
    const toolkitCli = await runCompiledObjectCli(['--endpoint', 'unix://' + path, 'toolkit', 'inspect', 'performance'], objectCliEnvironment(directory))
    expect(toolkitCli.code).toBe(0); expect(toolkitCli.stderr).toBe('')
    expect(JSON.parse(toolkitCli.stdout.trim()).result.snapshot).toEqual(toolkit)
    const child = spawn(process.execPath, [resolve('apps/desktop/resources/toolkit/performance.mjs'), resolve('packages/core/bin/amux')], {
      env: objectCliEnvironment(directory), stdio: ['ignore', 'pipe', 'pipe'] })
    let scriptOutput = '', scriptError = ''
    child.stdout.on('data', bytes => { scriptOutput += bytes.toString() }); child.stderr.on('data', bytes => { scriptError += bytes.toString() })
    const closed = new Promise(resolve => child.once('close', resolve))
    try {
      await vi.waitFor(() => expect(scriptOutput.split('\n').filter(Boolean).length, scriptError).toBeGreaterThan(0), { timeout: 5000 })
      const frame = JSON.parse(scriptOutput.split('\n')[0]!)
      expect(frame.event, scriptError).toBe('result')
      expect(frame.payload.renderer.data.performance).toEqual(expectedRenderer)
      expect(parseToolkitSnapshot({ ...toolkit, observation: frame.payload, document: frame.document })).toMatchObject({ observation: { renderer: { data: { performance: expectedRenderer } } } })
      expect(scriptError).toBe('')
    } finally { child.kill('SIGTERM'); await closed }

    const evidencePath = process.env.AGENTMUX_TERMINAL_INPUT_LOADED
    if (evidencePath) appendFileSync(evidencePath + '.correlation', JSON.stringify({ case: 'actual-unix-compiled-cli-typed-toolkit',
      diagnostics: observation.diagnostics, rendererInput: expectedRenderer.inputRequestDetails, toolkitReceiptParsed: true,
      unixToolkitExact: true, cliMetricsExact: true, cliToolkitExact: true,
      compiledCLISHA256: createHash('sha256').update(readFileSync(new URL('../dist/agentmux.js', import.meta.url))).digest('hex') }) + '\n')
    const text = JSON.stringify(parsedCli)
    for (const fact of ['native-input', 'one-logical-core', 'connected owner could not answer', 'main-user-home-volume', 'parentMatch', 'observerId', 'oldestPendingMs', 'public-daemon']) expect(text).toContain(fact)
    expect(text).not.toContain('synthetic rejected input')
    expect(execute).not.toHaveBeenCalled(); expect(releases.mock.calls.length).toBeGreaterThanOrEqual(2)
  } finally { await client.dispose(); await owner.stop(); await rm(directory, { recursive: true, force: true }) }
})
