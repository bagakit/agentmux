import { useEffect, useMemo, useRef, useState } from 'react'
import { validateScheduleRpcResult, type ScheduleHistoryQuery, type ScheduleHistoryBucket, type ScheduleHistoryGroup } from '@agentmux/core/schedule-rpc'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import { api } from './api'

type PublicationBucket = { count: number; firstAt: number; lastAt: number }
type Snapshot = { version: string; lastAt: number | null; buckets: Map<number, ScheduleHistoryGroup[]>;
  publications: Map<number, PublicationBucket>; incomplete: boolean }
const empty = new Map<string, Snapshot>()
function mergePage(into: Map<number, ScheduleHistoryGroup[]>, buckets: ScheduleHistoryBucket[]) {
  for (const bucket of buckets) {
    const groups = into.get(bucket.from) ?? []
    for (const part of bucket.groups) {
      const match = groups.find(item => item.delivery === part.delivery && item.nativeState === part.nativeState)
      if (match) {
        if (match.originalLabel !== part.originalLabel) match.originalLabel = null
        match.count += part.count
        match.firstAt = Math.min(match.firstAt, part.firstAt)
        match.lastAt = Math.max(match.lastAt, part.lastAt)
      } else groups.push({ ...part })
    }
    into.set(bucket.from, groups)
  }
}

/** Summaries are scoped to the displayed grid. Advancing the clock or selecting a
 * cell does not reread the month. A new receipt invalidates only its schedule's tail. */
export function useCalendarReceipts(records: readonly ContinuousProgressLoop[], starts: number[], to: number, scope: string, enabled: boolean) {
  const range = JSON.stringify([scope, starts, to])
  const from = starts[0] ?? to
  const observations = useMemo(() => JSON.stringify(records.map(record => {
    const lastAt = record.lastInputRef?.futureIntent.occurrenceAt ?? record.lastOccurrenceAt ?? null
    if (lastAt === null || lastAt < from || lastAt >= to) return [record.loopId, lastAt !== null && lastAt >= to ? to : null, null, null, record.revision]
    return [record.loopId, lastAt, record.lastInputRef?.inputKey, record.lastOutcome, record.revision]
  })), [records, from, to])
  const current = useRef({ range, rows: empty })
  const [observed, publish] = useState(current.current)
  const [attempt, retry] = useState(0)
  const reopened = useRef(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!enabled || !starts.length) { reopened.current = true; setBusy(false); return }
    const renew = reopened.current
    reopened.current = false
    let cancelled = false
    const rows = new Map(current.current.range === range ? current.current.rows : undefined)
    const queue = (JSON.parse(observations) as [string, number | null, ...unknown[]][]).map(marker => ({
      id: marker[0], lastAt: marker[1], version: JSON.stringify(marker),
    }))
    const ids = new Set(queue.map(item => item.id))
    for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id)
    const jobs = queue.filter(job => renew || job.version !== rows.get(job.id)?.version || rows.get(job.id)?.incomplete)
    const update = () => { current.current = { range, rows: new Map(rows) }; publish(current.current) }
    update()
    setBusy(jobs.length > 0)
    async function worker() {
      for (let job = jobs.shift(); job && !cancelled; job = jobs.shift()) {
        const { id, version, lastAt } = job
        const prior = rows.get(id)
        const earliest = !renew && prior && !prior.incomplete && prior.lastAt !== null && lastAt !== null
          ? Math.min(prior.lastAt, lastAt) : -Infinity
        const later = starts.findIndex(start => start > earliest)
        const first = later < 0 ? starts.length - 1 : Math.max(0, later - 1)
        const boundaries = starts.slice(first)
        const buckets = new Map<number, ScheduleHistoryGroup[]>()
        const publications = new Map<number, PublicationBucket>()
        let cursor: string | null = null
        let incomplete = false
        try {
          do {
            const query: ScheduleHistoryQuery = { scheduleId: id, from: boundaries[0]!, to, bucketStarts: boundaries, ...(cursor ? { cursor } : {}) }
            const page = validateScheduleRpcResult('schedule.history', await api.schedule.history(query), query)
            if (cancelled) return
            if (!page.buckets) { incomplete = true; break }
            mergePage(buckets, page.buckets)
            for (const publication of page.publicationBuckets ?? []) publications.set(publication.from, publication)
            if (page.coverage === 'unconfirmed') incomplete = true
            cursor = page.nextCursor
          } while (cursor)
        } catch { incomplete = true }
        if (cancelled) return
        const merged = new Map(prior?.buckets)
        const mergedPublications = new Map(prior?.publications)
        if (!incomplete) for (const start of boundaries) { merged.delete(start); mergedPublications.delete(start) }
        // Partial reads do not replace previously confirmed complete buckets.
        for (const [key, value] of buckets) if (!incomplete || !merged.has(key)) merged.set(key, value)
        for (const [key, value] of publications) if (!incomplete || !mergedPublications.has(key)) mergedPublications.set(key, value)
        rows.set(id, { version, lastAt, buckets: merged, publications: mergedPublications, incomplete })
        update()
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker)).then(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [range, observations, starts, to, enabled, attempt])
  const rows = observed.range === range ? observed.rows : empty
  return { rows, busy, partial: [...rows.values()].some(row => row.incomplete), retry: () => retry(n => n + 1) }
}
