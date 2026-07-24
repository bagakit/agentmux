export declare const BENCHMARK_SCHEMA: 'agentmux.benchmark.daemon-cutover.v5'
export declare const PROTOCOL_REVISION: 5
export declare const RUNNER_VERSION: 5
export declare const FORMAL_RESULT_PREFIX: 'revision-5'
export declare const WORKLOAD_EXECUTION_ORDER: readonly [
  'resources',
  'inputToVisible',
  'throughput',
  'attachReplay',
  'reconnect',
  'sessionScale',
  'stopCleanup'
]
export declare const CTXMUX_ARTIFACT: Readonly<{
  commit: string
  tree: string
  version: string
  protocol: number
  manifestSha256: string
}>

export declare function parseBenchmarkArguments(argv: readonly string[]):
  | { help: true }
  | { help: false; mode: 'full' | 'smoke'; round: 1 | 2; output: string | null }
export declare function benchmarkConfiguration(mode: 'full' | 'smoke'): Record<string, unknown>
export declare function parseProcessCpuSnapshot(value: string): {
  monotonicBeforeNanoseconds: string
  monotonicAfterNanoseconds: string
  userNanoseconds: string
  systemNanoseconds: string
  totalNanoseconds: string
}
export declare function parseProcessCpuCalibration(value: string): {
  workload: 'forked-child-continuous-cpu-burn'
  samples: number
  samplingDelayNanoseconds: string
  positiveStepsNanoseconds: string[]
  observedQuantumNanoseconds: string
}
export declare function processCpuInterval(
  start: {
    monotonicBeforeNanoseconds: string
    monotonicAfterNanoseconds: string
    totalNanoseconds: string
  },
  end: {
    monotonicBeforeNanoseconds: string
    monotonicAfterNanoseconds: string
    totalNanoseconds: string
  },
  observedQuantumNanoseconds: string
): {
  distinguishable: boolean
  deltaNanoseconds: string
  observedQuantumNanoseconds: string
  cpuIntervalNanoseconds: { lower: string; upper: string }
  wallIntervalNanoseconds: { lower: string; estimate: string; upper: string }
  cpuSeconds: number
  wallSeconds: number
  cpuPercent: number
  cpuPercentInterval: { lower: number; upper: number }
}
export declare function verifyBurstOutput(
  text: string,
  label: string,
  bytes: number
): { byteCount: number; sha256: string }
export declare function parseOwnedDaemonProcesses(
  psOutput: string,
  expected: { daemonPath: string; socketPath: string; stateDirectory: string }
): number[]
export declare function evaluateFullRound(
  workloads: Record<string, unknown>,
  summary: Record<string, unknown>,
  environmentMatches: boolean
): {
  verdict: 'pass' | 'fail'
  failures: string[]
  qualitativeWins: string[]
  skippedComparisons: string[]
}
export declare function runBenchmark(options: {
  mode: 'full' | 'smoke'
  round: 1 | 2
  output: string | null
}): Promise<{ output: string; result: Record<string, unknown> }>
