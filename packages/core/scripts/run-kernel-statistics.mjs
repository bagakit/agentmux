export function mean(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('mean requires one or more finite numbers')
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function percentile(values, percentileValue) {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(percentileValue) ||
    percentileValue < 0 ||
    percentileValue > 100
  ) {
    throw new Error('percentile requires finite samples and a percentile from 0 to 100')
  }
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.max(1, Math.ceil(percentileValue / 100 * sorted.length))
  return sorted[rank - 1]
}

export function standardDeviation(values) {
  const average = mean(values)
  return Math.sqrt(
    values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length
  )
}

export function seededRandom(seed) {
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer')
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function bootstrapConfidenceIntervals(
  values,
  { iterations = 10_000, seed = 8008 } = {}
) {
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new Error('bootstrap iterations must be a positive safe integer')
  }
  mean(values)
  const random = seededRandom(seed)
  const distributions = {
    mean: [],
    p50: [],
    p95: [],
    p99: []
  }
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = Array.from(
      { length: values.length },
      () => values[Math.floor(random() * values.length)]
    )
    distributions.mean.push(mean(sample))
    distributions.p50.push(percentile(sample, 50))
    distributions.p95.push(percentile(sample, 95))
    distributions.p99.push(percentile(sample, 99))
  }
  return Object.fromEntries(
    Object.entries(distributions).map(([name, samples]) => [name, {
      lower: percentile(samples, 2.5),
      upper: percentile(samples, 97.5)
    }])
  )
}

export function summarizeSamples(values, options = {}) {
  mean(values)
  return {
    count: values.length,
    min: Math.min(...values),
    mean: mean(values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: Math.max(...values),
    standardDeviation: standardDeviation(values),
    confidenceIntervals: bootstrapConfidenceIntervals(values, options)
  }
}
