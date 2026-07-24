import { describe, expect, it } from 'vitest'
import {
  mean,
  percentile,
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
    expect(summarizeSamples([1, 2, 3, 4])).toEqual({
      count: 4,
      min: 1,
      mean: 2.5,
      p50: 2,
      p95: 4,
      max: 4
    })
    expect(() => summarizeSamples([])).toThrow('one or more finite numbers')
    expect(() => percentile([1, Number.NaN], 95)).toThrow('finite samples')
  })
})
