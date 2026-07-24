export declare function mean(values: readonly number[]): number
export declare function percentile(values: readonly number[], percentileValue: number): number
export declare function standardDeviation(values: readonly number[]): number
export declare function seededRandom(seed: number): () => number
export type ConfidenceInterval = { lower: number; upper: number }
export declare function bootstrapConfidenceIntervals(
  values: readonly number[],
  options?: { iterations?: number; seed?: number }
): Record<'mean' | 'p50' | 'p95' | 'p99', ConfidenceInterval>
export declare function summarizeSamples(
  values: readonly number[],
  options?: { iterations?: number; seed?: number }
): {
  count: number
  min: number
  mean: number
  p50: number
  p95: number
  p99: number
  max: number
  standardDeviation: number
  confidenceIntervals: Record<'mean' | 'p50' | 'p95' | 'p99', ConfidenceInterval>
}
