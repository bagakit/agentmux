import { useEffect, useState } from 'react'
import type { ToolkitMetricsSnapshot } from '../../../../shared/toolkit'

export function usePerformanceAppTrend(snapshot: ToolkitMetricsSnapshot | null, paused: boolean, observationKey: string) {
  const [trend, setTrend] = useState<{ key: string; lastSourceAt: number | null; resumePending: boolean; points: ToolkitMetricsSnapshot['trend'] }>({ key: '', lastSourceAt: null, resumePending: false, points: [] })
  useEffect(() => {
    if (!snapshot) return
    setTrend(previous => {
      const incoming = snapshot.trend.slice(-60)
      const numeric = (point: ToolkitMetricsSnapshot['trend'][number]) => point.appCpuPercent !== null || point.appRssKib !== null
      if (previous.key !== observationKey) {
        let lastSourceAt: number | null = null
        for (let index = incoming.length - 1; index >= 0; index--) {
          const point = incoming[index]!
          if (numeric(point)) { lastSourceAt = point.observedAt; break }
        }
        return { key: observationKey, lastSourceAt, resumePending: paused, points: incoming }
      }
      if (paused) {
        if (previous.resumePending) return previous
        return { ...previous, resumePending: true, points: previous.points.length ? [...previous.points,
          { observedAt: snapshot.observedAt ?? previous.lastSourceAt ?? 0, appCpuPercent: null, appRssKib: null }].slice(-60) : previous.points }
      }
      const fresh = incoming.filter(point => numeric(point) && (previous.lastSourceAt === null || point.observedAt > previous.lastSourceAt))
      if (previous.resumePending) {
        const latest = fresh.at(-1)
        return latest ? { key: observationKey, lastSourceAt: latest.observedAt, resumePending: false,
          points: [...previous.points, latest].slice(-60) } : previous
      }
      let anchor = -1
      for (let index = incoming.length - 1; index >= 0; index--) {
        const point = incoming[index]!
        if (numeric(point) && point.observedAt === previous.lastSourceAt) { anchor = index; break }
      }
      const start = anchor >= 0 ? anchor + 1 : fresh.length ? incoming.indexOf(fresh[0]!) : incoming.length - 1
      const points = previous.points.slice()
      let lastSourceAt = previous.lastSourceAt
      for (const point of incoming.slice(start)) {
        if (numeric(point)) {
          if (lastSourceAt !== null && point.observedAt <= lastSourceAt) continue
          lastSourceAt = point.observedAt; points.push(point)
        } else if (points.length && numeric(points.at(-1)!)) points.push(point)
      }
      return points.length === previous.points.length ? previous : { key: observationKey, lastSourceAt, resumePending: false, points: points.slice(-60) }
    })
  }, [observationKey, snapshot?.trend, paused])
  return trend.key === observationKey ? trend.points : []
}
