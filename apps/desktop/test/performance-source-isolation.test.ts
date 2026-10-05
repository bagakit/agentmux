import { appendFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createInputPerformanceRecorder, hostedCarrierPerformance, type ClientPerformanceDiagnostics } from '@agentmux/core'
import { parseClientPerformanceDiagnostics, parseMetricsObservation } from '../../../packages/core/src/metrics.js'
import { parseToolkitSnapshot } from '../../../packages/core/src/toolkit.js'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { deepMetricsSnapshot } from '../../../packages/core/test/helpers/toolkit-metrics.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { MainPerformanceDiagnostics } from '../src/main/performance-diagnostics.js'

const facts = (processId: number) => ({ processId, observedAt: 1000,
  input: createInputPerformanceRecorder(() => 0, () => 1000).snapshot(), carrier: hostedCarrierPerformance.snapshot() })
const storage = { location: 'main-user-home-volume' as const, availableBytes: 17, totalBytes: 100 }
const variants = ['missing-field', 'extra-field', 'prototype', 'getter', 'oversized'] as const
function invalidSource(variant: typeof variants[number]) {
  const value = facts(200), getter = vi.fn(() => 200)
  if (variant === 'missing-field') Reflect.deleteProperty(value.input, 'nativeInput')
  if (variant === 'extra-field') Reflect.set(value, 'unexpected', true)
  if (variant === 'prototype') Object.setPrototypeOf(value, { inherited: true })
  if (variant === 'getter') Object.defineProperty(value, 'processId', { enumerable: true, get: getter })
  if (variant === 'oversized') value.input.active = Array(65).fill(null)
  return { value, getter }
}
async function observed(variant: typeof variants[number]) {
  const bad = invalidSource(variant), local = facts(100), healthy = facts(300)
  const writes = vi.fn(), stops = vi.fn(), healthyRead = vi.fn(async () => healthy)
  const badRead = vi.fn(async () => bad.value)
  const observer = new MainPerformanceDiagnostics(async () => storage)
  const entries = [
    { client: { clientPerformanceDiagnostics: badRead, write: writes, stop: stops }, executionHost: { id: 'unavailable-host' } },
    { client: { clientPerformanceDiagnostics: healthyRead }, executionHost: { id: 'healthy-host' } }
  ]
  const result = await observer.observe(entries, () => local, new AbortController().signal)
  expect(result.main).toBe(local)
  expect(result.hosts[0]).toEqual({ hostId: 'unavailable-host', data: null, unavailable: expect.any(String) })
  expect(result.hosts[0]!.unavailable!.length).toBeGreaterThan(0)
  expect(result.hosts[0]!.unavailable!.length).toBeLessThanOrEqual(4096)
  expect(result.hosts[1]).toEqual({ hostId: 'healthy-host', data: healthy, unavailable: null })
  expect(result.hosts[1]!.data).toBe(healthy)
  expect(result.storage).toBe(storage); expect(result.storageUnavailable).toBeNull()
  expect(bad.getter).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(stops).not.toHaveBeenCalled()
  const toolkit = deepMetricsSnapshot()
  toolkit.observation!.diagnostics = { state: 'available', observedAt: 1000, lastSuccessAt: 1000, reason: null,
    data: { ...result, eventLoop: { resolutionMs: 20, generation: 0, count: 0, meanMs: null, maxMs: null } } }
  expect(parseMetricsObservation(toolkit.observation)).toBe(toolkit.observation)
  expect(parseToolkitSnapshot(toolkit)).toBe(toolkit)
  return { observer, entries, result, toolkit, badRead, healthyRead, local, healthy }
}

afterEach(() => { vi.restoreAllMocks() })

it.each(variants)('uses the same strict parser to isolate a fulfilled %s Host without losing healthy facts', async variant => {
  const bad = invalidSource(variant), valid = facts(100)
  expect(parseClientPerformanceDiagnostics(valid)).toBe(valid)
  expect(() => parseClientPerformanceDiagnostics(bad.value)).toThrow()
  expect(bad.getter).not.toHaveBeenCalled()
  const current = await observed(variant)
  const recovered = facts(200)
  current.badRead.mockResolvedValue(recovered)
  const next = await current.observer.observe(current.entries, () => current.local, new AbortController().signal)
  expect(next.hosts[0]).toEqual({ hostId: 'unavailable-host', data: recovered, unavailable: null })
  expect(current.badRead).toHaveBeenCalledTimes(2); expect(current.healthyRead).toHaveBeenCalledTimes(2)
})

it.each(['sync', 'async'] as const)('keeps a genuine %s Host read error bounded to that Host', async kind => {
  const error = new Error('source-failure-'.repeat(1000)), healthy = facts(300), local = facts(100)
  const read = () => { if (kind === 'sync') throw error; return Promise.reject<ClientPerformanceDiagnostics>(error) }
  const result = await new MainPerformanceDiagnostics(async () => storage).observe([
    { client: { clientPerformanceDiagnostics: read }, executionHost: { id: 'failed-host' } },
    { client: { clientPerformanceDiagnostics: async () => healthy }, executionHost: { id: 'healthy-host' } }
  ], () => local, new AbortController().signal)
  expect(result.hosts[0]!.data).toBeNull(); expect(result.hosts[0]!.unavailable).toHaveLength(4096)
  expect(result.hosts[1]!.data).toBe(healthy); expect(result.main).toBe(local); expect(result.storage).toBe(storage)
})

it.each(['missing-field', 'extra-field'] as const)('carries actual Main %s isolation through complete Unix Metrics/watch, compiled CLI and typed Toolkit', async variant => {
  const current = await observed(variant), observation = current.toolkit.observation!
  const directory = await mkdtemp(join(tmpdir(), 'amux-source-isolation-')), socket = join(directory, 'control.sock')
  const execute = vi.fn(), releases = vi.fn(), toolkitReads = vi.fn()
  const server = new AgentMuxControlServer({ coreClients: () => [], execute, metrics: {
    async subscribe(push) { queueMicrotask(() => push(observation)); return { dispose: releases } }
  }, toolkit: {
    async execute(request) {
      if (request.operation !== 'toolkit.get') throw new Error('Only Toolkit inspect is requested by this proof')
      toolkitReads(request.toolId)
      return { operation: 'toolkit.get', snapshot: current.toolkit }
    }, async subscribe() { throw new Error('No Toolkit watch requested by this proof') }
  } }, socket)
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
  try {
    const metrics = await rpc.call('system.metrics.get', {})
    expect(metrics.observation).toEqual(observation)
    const watched: unknown[] = []
    const lease = await rpc.subscribe('system.metrics.watch', {}, { onInitial: value => watched.push(value.observation), onEvent: () => {}, onEnd: () => {} })
    expect(watched).toEqual([observation]); await lease.dispose()
    const toolkit = await rpc.call('toolkit.inspect', { toolId: 'performance' })
    expect(toolkit.snapshot).toEqual(current.toolkit)
    const cliMetrics = await runCompiledObjectCli(['--endpoint', 'unix://' + socket, 'system', 'metrics', 'get'], objectCliEnvironment(directory))
    const cliToolkit = await runCompiledObjectCli(['--endpoint', 'unix://' + socket, 'toolkit', 'inspect', 'performance'], objectCliEnvironment(directory))
    for (const cli of [cliMetrics, cliToolkit]) { expect(cli.code).toBe(0); expect(cli.stderr).toBe('') }
    const metricResult = JSON.parse(cliMetrics.stdout), toolkitResult = JSON.parse(cliToolkit.stdout)
    expect(metricResult.result.observation).toEqual(observation)
    expect(toolkitResult.result.snapshot).toEqual(current.toolkit)
    expect(execute).not.toHaveBeenCalled(); expect(toolkitReads).toHaveBeenCalledWith('performance')
    expect(releases.mock.calls.length).toBeGreaterThanOrEqual(3)
    const path = process.env.AGENTMUX_TERMINAL_INPUT_LOADED
    if (path) appendFileSync(path + '.source-isolation', JSON.stringify({ variant, metrics: metricResult,
      toolkit: toolkitResult, unixMetrics: metrics, unixToolkit: toolkit, actualHostReads: current.entries.length, userRunTouched: false }) + '\n')
  } finally { await rpc.dispose(); await server.stop(); await rm(directory, { recursive: true, force: true }) }
})
