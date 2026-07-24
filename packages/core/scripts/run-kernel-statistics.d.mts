export declare function mean(values: readonly number[]): number
export declare function percentile(values: readonly number[], percentileValue: number): number
export declare function summarizeSamples(values: readonly number[]): {
  count: number
  min: number
  mean: number
  p50: number
  p95: number
  max: number
}
