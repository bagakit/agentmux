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

export function summarizeSamples(values) {
  return {
    count: values.length,
    min: Math.min(...values),
    mean: mean(values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values)
  }
}
