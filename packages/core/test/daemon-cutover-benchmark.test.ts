import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BENCHMARK_SCHEMA,
  CTXMUX_ARTIFACT,
  FORMAL_RESULT_PREFIX,
  PROTOCOL_REVISION,
  WORKLOAD_EXECUTION_ORDER,
  benchmarkConfiguration,
  evaluateFullRound,
  parseBenchmarkArguments,
  parseOwnedDaemonProcesses,
  parseProcessCpuCalibration,
  parseProcessCpuSnapshot,
  processCpuInterval,
  runBenchmark,
  verifyBurstOutput
} from '../scripts/run-daemon-cutover-benchmark.mjs'

function passingWorkloads(): Record<string, unknown> {
  return Object.fromEntries([
    'inputToVisible',
    'throughput',
    'attachReplay',
    'reconnect',
    'sessionScale',
    'stopCleanup',
    'resources'
  ].map((name) => [name, {
    agentmux: { correctness: true },
    tmux: { correctness: true }
  }]))
}

function passingSummary(): Record<string, unknown> {
  const lower = {
    agentmux: { p50: 1, p95: 1, p99: 1 },
    tmux: { p50: 2, p95: 2, p99: 2 }
  }
  const higher = {
    agentmux: { p50: 2, p95: 2, p99: 2 },
    tmux: { p50: 1, p95: 1, p99: 1 }
  }
  return {
    inputToVisible: structuredClone(lower),
    throughput: structuredClone(higher),
    attachReplay: structuredClone(lower),
    reconnect: structuredClone(lower),
    scaleWall: structuredClone(lower),
    scaleRate: structuredClone(higher),
    stopCleanup: structuredClone(lower),
    resources: {
      agentmux: {
        idleCpuPercent: 0.5,
        idleCpuPercentLower: 0.45,
        idleCpuPercentUpper: 0.55,
        idleRssKiB: 1024,
        perSessionRssKiB: 10,
        steadyRssKiB: 2048,
        peakRssKiB: 4096,
        releasedRssKiB: 1024
      },
      tmux: {
        idleCpuPercent: 0.75,
        idleCpuPercentLower: 0.7,
        idleCpuPercentUpper: 0.8,
        idleRssKiB: 2048,
        perSessionRssKiB: 20,
        steadyRssKiB: 4096,
        peakRssKiB: 8192,
        releasedRssKiB: 2048
      }
    }
  }
}

describe('Daemon cutover benchmark protocol', () => {
  it('freezes Revision 5 identity, resource-first execution, and smoke isolation', () => {
    expect(BENCHMARK_SCHEMA).toBe('agentmux.benchmark.daemon-cutover.v5')
    expect(PROTOCOL_REVISION).toBe(5)
    expect(FORMAL_RESULT_PREFIX).toBe('revision-5')
    expect(WORKLOAD_EXECUTION_ORDER).toEqual([
      'resources',
      'inputToVisible',
      'throughput',
      'attachReplay',
      'reconnect',
      'sessionScale',
      'stopCleanup'
    ])
    expect(CTXMUX_ARTIFACT).toMatchObject({
      commit: 'a0897087fdd0eb131c39c43d4d6791901335d69e',
      tree: '54d0f0631a51063a5f4c18088f4e8cba1f80444a',
      protocol: 13,
      manifestSha256: '5e67346cf1fedd60eba15e2b58aac3005df632684891ad086d613014276dc639'
    })
    expect(parseBenchmarkArguments(['--', '--round', '2'])).toEqual({
      help: false,
      mode: 'full',
      round: 2,
      output: null
    })
    expect(parseBenchmarkArguments([
      '--smoke', '--round', '1', '--output', '/private/tmp/agentmux-benchmark-smoke.json'
    ])).toEqual({
      help: false,
      mode: 'smoke',
      round: 1,
      output: '/private/tmp/agentmux-benchmark-smoke.json'
    })
    expect(() => parseBenchmarkArguments(['--smoke', '--round', '1'])).toThrow(
      'requires an explicit --output'
    )
    expect(() => parseBenchmarkArguments([
      '--smoke',
      '--round',
      '1',
      '--output',
      'docs/benchmarks/results/not-formal.json'
    ])).toThrow('cannot be written')
    expect(() => parseBenchmarkArguments(['--round', '3'])).toThrow('exactly 1 or 2')
  })

  it('parses endpoint-bounded CPU snapshots and calibrated positive steps without Number truncation', () => {
    expect(parseProcessCpuSnapshot('sample 100 120 9007199254740993 17\n')).toEqual({
      monotonicBeforeNanoseconds: '100',
      monotonicAfterNanoseconds: '120',
      userNanoseconds: '9007199254740993',
      systemNanoseconds: '17',
      totalNanoseconds: '9007199254741010'
    })
    expect(parseProcessCpuCalibration('calibration 4 100000\nstep 3000\nstep 1000\nstep 2000\n')).toEqual({
      workload: 'forked-child-continuous-cpu-burn',
      samples: 4,
      samplingDelayNanoseconds: '100000',
      positiveStepsNanoseconds: ['3000', '1000', '2000'],
      observedQuantumNanoseconds: '1000'
    })
    expect(() => parseProcessCpuSnapshot('0:00.01')).toThrow('Invalid process CPU snapshot')
    expect(() => parseProcessCpuSnapshot('sample 2 1 3 4')).toThrow('monotonic interval regressed')
    expect(() => parseProcessCpuCalibration('calibration 2 100000')).toThrow('did not observe')
  })

  it('compares CPU over endpoint uncertainty and fails closed inside the observed quantum', () => {
    const start = {
      monotonicBeforeNanoseconds: '1000',
      monotonicAfterNanoseconds: '1100',
      totalNanoseconds: '5000'
    }
    const end = {
      monotonicBeforeNanoseconds: '2100',
      monotonicAfterNanoseconds: '2300',
      totalNanoseconds: '5600'
    }
    expect(processCpuInterval(start, end, '100')).toEqual({
      distinguishable: true,
      deltaNanoseconds: '600',
      observedQuantumNanoseconds: '100',
      cpuIntervalNanoseconds: { lower: '500', upper: '700' },
      wallIntervalNanoseconds: { lower: '1000', estimate: '1150', upper: '1300' },
      cpuSeconds: 6e-7,
      wallSeconds: 0.00000115,
      cpuPercent: 600 / 1150 * 100,
      cpuPercentInterval: { lower: 500 / 1300 * 100, upper: 700 / 1000 * 100 }
    })
    expect(processCpuInterval(start, { ...end, totalNanoseconds: '5100' }, '100')).toMatchObject({
      distinguishable: false
    })
    expect(() => processCpuInterval(start, { ...end, monotonicBeforeNanoseconds: '1050' }, '100')).toThrow(
      'positive ordered window'
    )
  })

  it('keeps formal and smoke workloads separate without mutating frozen values', () => {
    const full = benchmarkConfiguration('full') as {
      latency: { samples: number }
      throughput: { bytes: number }
      scale: { sessions: number }
    }
    const smoke = benchmarkConfiguration('smoke') as typeof full
    expect(full.latency.samples).toBe(120)
    expect(full.throughput.bytes).toBe(4 * 1024 * 1024)
    expect(full.scale.sessions).toBe(32)
    expect(smoke.latency.samples).toBeLessThan(full.latency.samples)
    expect(smoke.throughput.bytes).toBeLessThan(full.throughput.bytes)
    full.latency.samples = 1
    expect((benchmarkConfiguration('full') as typeof full).latency.samples).toBe(120)
  })

  it('verifies exact byte count and hash instead of accepting an end marker alone', () => {
    const label = 'oracle'
    const payload = 'x'.repeat(32)
    const hash = createHash('sha256').update(payload).digest('hex')
    const text = [
      `run-kernel-verified-ready:${label}:32:${hash}\r`,
      `run-kernel-verified-payload:${label}\r`,
      payload,
      `run-kernel-verified-end:${label}:32:${hash}\r`,
      ''
    ].join('\n')
    expect(verifyBurstOutput(text, label, 32)).toEqual({ byteCount: 32, sha256: hash })
    expect(() => verifyBurstOutput(text.replace(payload, `${payload}x`), label, 32)).toThrow(
      'Payload oracle failed'
    )
  })

  it('matches only the exact benchmark-owned daemon scope', () => {
    const expected = {
      daemonPath: '/repo/vendor/bin/ctxmuxd',
      socketPath: '/private/tmp/agentmux-benchmark-abc/runtime/ctxmux.sock',
      stateDirectory: '/private/tmp/agentmux-benchmark-abc/runtime/state'
    }
    const owned = `  123 ${expected.daemonPath} --socket ${expected.socketPath} --state-dir ${expected.stateDirectory} --readiness-fd 3`
    const user = '  456 /repo/vendor/bin/ctxmuxd --socket /private/tmp/user.sock --state-dir /private/tmp/user-state'
    expect(parseOwnedDaemonProcesses(`${owned}\n${user}\n`, expected)).toEqual([123])
  })

  it('fails closed when comparison or budget evidence is missing or non-finite', () => {
    expect(evaluateFullRound(passingWorkloads(), passingSummary(), true)).toEqual({
      verdict: 'pass',
      failures: [],
      qualitativeWins: [],
      skippedComparisons: []
    })

    const missing = passingSummary() as {
      reconnect: { agentmux: { p95?: number } }
    }
    delete missing.reconnect.agentmux.p95
    expect(evaluateFullRound(passingWorkloads(), missing, true)).toMatchObject({
      verdict: 'fail',
      failures: expect.arrayContaining(['reconnect.p95.missing'])
    })

    const malformed = passingSummary() as {
      resources: { agentmux: { peakRssKiB: number } }
    }
    malformed.resources.agentmux.peakRssKiB = Number.NaN
    expect(evaluateFullRound(passingWorkloads(), malformed, true)).toMatchObject({
      verdict: 'fail',
      failures: expect.arrayContaining([
        'resources.peakRssKiB.missing',
        'budget.peakRssKiB.missing'
      ])
    })

    expect(evaluateFullRound({}, {}, true)).toMatchObject({
      verdict: 'fail',
      failures: expect.arrayContaining(['correctness', 'throughput.p50.missing'])
    })

    const overlappingCpu = passingSummary() as {
      resources: {
        agentmux: { idleCpuPercentUpper: number }
        tmux: { idleCpuPercentLower: number }
      }
    }
    overlappingCpu.resources.agentmux.idleCpuPercentUpper = 0.71
    expect(evaluateFullRound(passingWorkloads(), overlappingCpu, true)).toMatchObject({
      verdict: 'fail',
      failures: expect.arrayContaining(['resources.idleCpuPercent'])
    })

    const cpuBudget = passingSummary() as {
      resources: { agentmux: { idleCpuPercentUpper: number } }
    }
    cpuBudget.resources.agentmux.idleCpuPercentUpper = 1.01
    expect(evaluateFullRound(passingWorkloads(), cpuBudget, true)).toMatchObject({
      verdict: 'fail',
      failures: expect.arrayContaining(['budget.idleCpuPercent'])
    })
  })

  it('treats only the proven tmux stop-tree limitation as a qualitative correctness win', () => {
    const stopLimited = passingWorkloads() as {
      stopCleanup: {
        agentmux: { correctness: boolean }
        tmux: { correctness?: boolean }
      }
      throughput: { tmux: { correctness: boolean } }
    }
    stopLimited.stopCleanup.tmux.correctness = false
    const withoutStopTiming = passingSummary() as {
      stopCleanup: { tmux: unknown }
    }
    withoutStopTiming.stopCleanup.tmux = null
    expect(evaluateFullRound(stopLimited, withoutStopTiming, true)).toEqual({
      verdict: 'pass',
      failures: [],
      qualitativeWins: ['stopCleanup.complete-process-tree'],
      skippedComparisons: ['stopCleanup.p95']
    })

    const agentMuxStopFailure = structuredClone(stopLimited)
    agentMuxStopFailure.stopCleanup.agentmux.correctness = false
    expect(evaluateFullRound(agentMuxStopFailure, withoutStopTiming, true)).toMatchObject({
      verdict: 'fail',
      failures: expect.arrayContaining(['correctness.agentmux.stopCleanup'])
    })

    const unrelatedTmuxFailure = structuredClone(stopLimited)
    unrelatedTmuxFailure.throughput.tmux.correctness = false
    expect(evaluateFullRound(unrelatedTmuxFailure, withoutStopTiming, true)).toMatchObject({
      verdict: 'fail',
      failures: expect.arrayContaining(['correctness.tmux.throughput'])
    })

    const missingTmuxStop = passingWorkloads() as typeof stopLimited
    delete missingTmuxStop.stopCleanup.tmux.correctness
    expect(evaluateFullRound(missingTmuxStop, passingSummary(), true)).toMatchObject({
      verdict: 'fail',
      failures: expect.arrayContaining(['correctness.tmux.stopCleanup.missing'])
    })
  })

  it.runIf(process.platform === 'darwin' && process.arch === 'arm64')(
    'restores the caller runtime scope and removes its private root after an early failure',
    async () => {
      const outputRoot = await mkdtemp('/private/tmp/agentmux-benchmark-failure-proof-')
      const output = join(outputRoot, 'failure.json')
      const original = process.env.AGENTMUX_RUNTIME_DIRECTORY
      process.env.AGENTMUX_RUNTIME_DIRECTORY = '/private/tmp/agentmux-caller-sentinel'
      try {
        const receipt = await runBenchmark({
          mode: 'invalid',
          round: 1,
          output
        } as unknown as Parameters<typeof runBenchmark>[0])
        const result = receipt.result as {
          manifest: { runtimeScope: string }
          cleanup: { rootRemoved: boolean; errors: unknown[] }
          runnerError: { message: string }
        }
        expect(result.runnerError.message).toContain('Unknown benchmark mode')
        expect(result.cleanup).toEqual(expect.objectContaining({ rootRemoved: true, errors: [] }))
        expect(process.env.AGENTMUX_RUNTIME_DIRECTORY).toBe('/private/tmp/agentmux-caller-sentinel')
        await expect(stat(result.manifest.runtimeScope)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        if (original === undefined) delete process.env.AGENTMUX_RUNTIME_DIRECTORY
        else process.env.AGENTMUX_RUNTIME_DIRECTORY = original
        await rm(outputRoot, { recursive: true })
      }
    }
  )
})
