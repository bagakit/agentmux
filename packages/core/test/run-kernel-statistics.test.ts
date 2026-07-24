import { describe, expect, it } from 'vitest'
import {
  bootstrapConfidenceIntervals,
  mean,
  percentile,
  seededRandom,
  standardDeviation,
  summarizeSamples
} from '../scripts/run-kernel-statistics.mjs'

describe('Run Kernel Conformance statistics', () => {
  it('uses deterministic nearest-rank percentiles without mutating source samples', () => {
    const values = [40, 10, 30, 20]
    expect(mean(values)).toBe(25)
    expect(percentile(values, 50)).toBe(20)
    expect(percentile(values, 95)).toBe(40)
    expect(values).toEqual([40, 10, 30, 20])
  })

  it('summarizes bounded samples and rejects empty or invalid evidence', () => {
    expect(summarizeSamples([1, 2, 3, 4], { iterations: 128 })).toEqual({
      count: 4,
      min: 1,
      mean: 2.5,
      p50: 2,
      p95: 4,
      p99: 4,
      max: 4,
      standardDeviation: Math.sqrt(1.25),
      confidenceIntervals: bootstrapConfidenceIntervals(
        [1, 2, 3, 4],
        { iterations: 128 }
      )
    })
    expect(() => summarizeSamples([])).toThrow('one or more finite numbers')
    expect(() => percentile([1, Number.NaN], 95)).toThrow('finite samples')
  })

  it('freezes population deviation and Mulberry32 bootstrap evidence', () => {
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2)
    const first = seededRandom(8008)
    const second = seededRandom(8008)
    expect(Array.from({ length: 8 }, () => first())).toEqual(
      Array.from({ length: 8 }, () => second())
    )
    const source = [10, 20, 30, 40]
    const intervals = bootstrapConfidenceIntervals(source, { iterations: 256, seed: 8008 })
    expect(intervals).toEqual(
      bootstrapConfidenceIntervals(source, { iterations: 256, seed: 8008 })
    )
    for (const interval of Object.values(intervals)) {
      expect(interval.lower).toBeLessThanOrEqual(interval.upper)
      expect(interval.lower).toBeGreaterThanOrEqual(10)
      expect(interval.upper).toBeLessThanOrEqual(40)
    }
    expect(source).toEqual([10, 20, 30, 40])
  })
})
