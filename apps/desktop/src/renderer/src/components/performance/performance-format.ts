export const performanceCPU = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(1)}%`
export const performanceMemory = (value: number | null | undefined) => value == null ? '—' : value >= 1048576 ? `${(value / 1048576).toFixed(1)} GiB` : value >= 1024 ? `${Math.round(value / 1024)} MiB` : `${Math.round(value)} KiB`

export const performanceBytes = (value: number | null | undefined) => value == null ? '—'
  : value >= 1073741824 ? `${(value / 1073741824).toFixed(1)} GiB`
  : value >= 1048576 ? `${(value / 1048576).toFixed(1)} MiB`
  : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${Math.round(value)} B`

export function performanceReadingTime(at: number | null | undefined, updateAt: number | null | undefined) {
  if (at == null) return 'Waiting for a reading'
  const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const age = updateAt == null ? 0 : Math.max(0, Math.floor((updateAt - at) / 1000))
  return `${time}${age ? ` · ${age >= 60 ? `${Math.floor(age / 60)}m` : `${age}s`} old` : ''}`
}
