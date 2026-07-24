import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runBenchmark } from '../scripts/run-daemon-cutover-benchmark.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })))
})

describe.runIf(
  process.env.AGENTMUX_BENCHMARK_SMOKE === '1' &&
  process.platform === 'darwin' &&
  process.arch === 'arm64'
)('Daemon cutover real smoke', () => {
  it('runs both public runtimes and leaves an auditable cleanup receipt', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-benchmark-test-')
    roots.push(root)
    const output = join(root, 'smoke.json')
    const receipt = await runBenchmark({ mode: 'smoke', round: 1, output })
    const raw = JSON.parse(await readFile(output, 'utf8')) as {
      schema: string
      mode: string
      verdict: string
      manifest: {
        processCpuObserver: {
          counterSource: string
          endpointClock: string
          unit: string
          calibration: {
            workload: string
            samples: number
            samplingDelayNanoseconds: string
            positiveStepsNanoseconds: string[]
            observedQuantumNanoseconds: string
          }
          sourceSha256: string
          binarySha256: string
          compileEnvironment: Record<string, string>
          compileArgv: string[]
        }
      }
      workloads: Record<string, unknown> & {
        resources: Record<'agentmux' | 'tmux', {
          idle: {
            cpuCounter: {
              start: { monotonicBeforeNanoseconds: string; monotonicAfterNanoseconds: string; totalNanoseconds: string }
              end: { monotonicBeforeNanoseconds: string; monotonicAfterNanoseconds: string; totalNanoseconds: string }
              observedQuantumNanoseconds: string
              cpuIntervalNanoseconds: { lower: string; upper: string }
              wallIntervalNanoseconds: { lower: string; estimate: string; upper: string }
            }
          }
          idleOwnerState: { live: number; historical: number; total: number }
          oneSessionOwnerState: { live: number; historical: number; total: number }
          manySessionsOwnerState: { live: number; historical: number; total: number }
          releasedOwnerState: { live: number; historical: number; total: number }
          expectedReleasedOwnerState: { live: number; historical: number; total: number }
          retainedHistoricalFdsPerRun: number | null
        }>
      }
      correctness: Record<string, { agentmux: boolean; tmux: boolean } | boolean>
      verdictFailures: string[]
      qualitativeWins: string[]
      skippedComparisons: string[]
      cleanup: { rootRemoved: boolean; errors: unknown[] }
      runnerError?: unknown
    }
    expect(receipt.output).toBe(output)
    expect(raw).toMatchObject({
      schema: 'agentmux.benchmark.daemon-cutover.v5',
      mode: 'smoke',
      verdict: 'smoke'
    })
    expect(Object.keys(raw.workloads)).toEqual([
      'resources',
      'inputToVisible',
      'throughput',
      'attachReplay',
      'reconnect',
      'sessionScale',
      'stopCleanup'
    ])
    expect(raw.manifest.processCpuObserver).toMatchObject({
      counterSource: 'proc_pid_rusage:RUSAGE_INFO_V4',
      endpointClock: 'clock_gettime:CLOCK_MONOTONIC_RAW',
      unit: 'nanoseconds',
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      binarySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      compileEnvironment: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'C',
        LC_ALL: 'C',
        TZ: 'UTC0',
        SDKROOT: '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk'
      },
      compileArgv: expect.arrayContaining(['-std=c11', '-O2', '-Werror'])
    })
    expect(raw.manifest.processCpuObserver.calibration).toMatchObject({
      workload: 'forked-child-continuous-cpu-burn',
      samples: 256
    })
    expect(raw.manifest.processCpuObserver.calibration.positiveStepsNanoseconds).not.toHaveLength(0)
    expect(raw.manifest.processCpuObserver.calibration.observedQuantumNanoseconds).toMatch(/^\d+$/u)
    for (const runtime of ['agentmux', 'tmux'] as const) {
      const cpu = raw.workloads.resources[runtime].idle.cpuCounter
      expect(cpu.start.totalNanoseconds).toMatch(/^\d+$/u)
      expect(cpu.start.monotonicBeforeNanoseconds).toMatch(/^\d+$/u)
      expect(cpu.start.monotonicAfterNanoseconds).toMatch(/^\d+$/u)
      expect(cpu.end.totalNanoseconds).toMatch(/^\d+$/u)
      expect(BigInt(cpu.wallIntervalNanoseconds.lower)).toBeGreaterThan(0n)
      expect(BigInt(cpu.wallIntervalNanoseconds.upper)).toBeGreaterThanOrEqual(
        BigInt(cpu.wallIntervalNanoseconds.lower)
      )
      expect(BigInt(cpu.cpuIntervalNanoseconds.upper)).toBeGreaterThanOrEqual(
        BigInt(cpu.cpuIntervalNanoseconds.lower)
      )
      expect(cpu.observedQuantumNanoseconds).toBe(
        raw.manifest.processCpuObserver.calibration.observedQuantumNanoseconds
      )
      expect(raw.workloads.resources[runtime].idleOwnerState).toEqual({ live: 0, historical: 0, total: 0 })
      expect(raw.workloads.resources[runtime].oneSessionOwnerState).toEqual({ live: 1, historical: 0, total: 1 })
      expect(raw.workloads.resources[runtime].manySessionsOwnerState).toEqual({ live: 2, historical: 0, total: 2 })
    }
    expect(raw.workloads.resources.agentmux.releasedOwnerState).toEqual({ live: 0, historical: 3, total: 3 })
    expect(raw.workloads.resources.agentmux.expectedReleasedOwnerState).toEqual({ live: 0, historical: 3, total: 3 })
    expect(raw.workloads.resources.agentmux.retainedHistoricalFdsPerRun).toBeTypeOf('number')
    expect(raw.workloads.resources.tmux.releasedOwnerState).toEqual({ live: 0, historical: 0, total: 0 })
    expect(raw.workloads.resources.tmux.expectedReleasedOwnerState).toEqual({ live: 0, historical: 0, total: 0 })
    expect(raw.workloads.resources.tmux.retainedHistoricalFdsPerRun).toBeNull()
    expect(Object.keys(raw.correctness)).toEqual(expect.arrayContaining([
      'inputToVisible',
      'throughput',
      'attachReplay',
      'reconnect',
      'sessionScale',
      'stopCleanup',
      'resources',
      'cleanup'
    ]))
    for (const name of [
      'resources',
      'inputToVisible',
      'throughput',
      'attachReplay',
      'reconnect',
      'sessionScale'
    ]) {
      expect(raw.correctness[name]).toEqual({ agentmux: true, tmux: true })
    }
    expect(raw.correctness.stopCleanup).toEqual({ agentmux: true, tmux: false })
    expect(raw.correctness.cleanup).toBe(true)
    expect(raw.verdictFailures).toEqual([])
    expect(raw.qualitativeWins).toEqual(['stopCleanup.complete-process-tree'])
    expect(raw.skippedComparisons).toEqual(['stopCleanup.p95'])
    expect(raw.runnerError).toBeUndefined()
    expect(raw.cleanup).toEqual(expect.objectContaining({ rootRemoved: true, errors: [] }))
  }, 120_000)
})
