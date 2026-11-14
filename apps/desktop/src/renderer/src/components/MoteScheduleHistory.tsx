import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { Button } from '@agentmux/client-ui/components/Button'
import { validateScheduleRpcResult, type ScheduleResultMap } from '@agentmux/core/schedule-rpc'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import { api } from '../lib/api'
import { scheduleCalendarLabel } from './ScheduleArrangementRow'
import { SelectionField } from './SelectionField'

type HistoryResult = ScheduleResultMap['schedule.history']
type HistoryWindow = { from: number; to: number }
type HistoryTrail = readonly (string | undefined)[]
const firstPage = [undefined] as const

const deliveryLabel: Record<HistoryResult['entries'][number]['delivery'], string> = {
  'terminal-confirmed': 'Sent to terminal', 'native-admitted': 'Input accepted', 'not-applied': 'Not sent', unconfirmed: 'Delivery unconfirmed'
}
const nativeLabel = { completed: 'Agent turn completed', failed: 'Agent turn failed', interrupted: 'Agent turn interrupted' } as const

export function MoteScheduleHistory({ records, window, timezone, active, selectedSchedule, onSelectSchedule }: {
  records: readonly ContinuousProgressLoop[]; window: HistoryWindow; timezone: string; active: boolean; selectedSchedule?: string | undefined
  onSelectSchedule(scheduleId: string): void
}) {
  const record = records.length === 1 ? records[0] : records.find(value => value.loopId === selectedSchedule)
  if (!records.length) return null
  return <section className="mote-calendar__recorded" aria-label="Recorded history">
    <h4 tabIndex={-1}>Recorded history</h4>
    {records.length > 1 ? <SelectionField label="Arrangement history" value={record?.loopId ?? ''}
      options={records.map(value => ({ value: value.loopId, label: scheduleCalendarLabel(value) }))}
      missingOptionLabel="Choose an arrangement" onValueChange={onSelectSchedule} /> : null}
    {record ? <HistoryPages key={JSON.stringify([record.loopId, window.from, window.to])} scheduleId={record.loopId}
      window={window} timezone={timezone} active={active} /> : null}
  </section>
}

function HistoryPages({ scheduleId, window, timezone, active }: {
  scheduleId: string; window: HistoryWindow; timezone: string; active: boolean
}) {
  const [page, setPage] = useState<HistoryResult>()
  const [trail, setTrail] = useState<HistoryTrail>(firstPage)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<HistoryTrail>()
  const request = useRef<symbol | undefined>(undefined)
  const hasPage = page !== undefined
  const { from, to } = window
  const read = useCallback(async (nextTrail: HistoryTrail) => {
    if (!active || request.current) return
    const original = Symbol()
    request.current = original
    const cursor = nextTrail.at(-1)
    const input = { scheduleId, from, to, ...(cursor ? { cursor } : {}) }
    setBusy(true); setFailed(undefined)
    try {
      const result = validateScheduleRpcResult('schedule.history', await api.schedule.history(input), input)
      if (original !== request.current) return
      if (result.coverage === 'unconfirmed' && !result.entries.length && !result.nextCursor) { setFailed(nextTrail); return }
      setPage(result); setTrail(nextTrail)
    } catch {
      if (original === request.current) setFailed(nextTrail)
    } finally {
      if (original === request.current) { request.current = undefined; setBusy(false) }
    }
  }, [active, scheduleId, from, to])
  useLayoutEffect(() => {
    let current = true
    if (active && !hasPage) void Promise.resolve().then(() => { if (current) void read(firstPage) })
    if (!active) setBusy(false)
    return () => { current = false; request.current = undefined }
  }, [active, hasPage, read])

  return <div className="mote-calendar__time-page" aria-busy={busy}>
    {!page && busy ? <p className="continuous-progress-control__help" role="status">Reading history…</p> : null}
    {failed ? <p className="continuous-progress-control__help" role="status">History could not be checked. {page ? 'The previous page is still shown.' : null}</p> : null}
    {page ? <>
      {page.entries.length ? <><p className="mote-calendar__reading-note">Scheduled time and result</p>
        <ol aria-label="Recorded input receipts">{page.entries.map(entry => {
          const time = DateTime.fromMillis(entry.occurrenceAt, { zone: timezone })
          const native = entry.nativeResult.state
          return <li key={entry.operationId}>
            <time dateTime={time.toISO()!} title={time.toFormat('HH:mm:ss ZZ')}>{time.toFormat('HH:mm')}</time>
            <span>{deliveryLabel[entry.delivery]}</span>
            {native !== 'unknown' && native !== 'unsupported' ? <small data-native-result={native}>{nativeLabel[native]}</small> : null}
          </li>
        })}</ol></> : page.coverage === 'recorded-inputs' ? <p className="continuous-progress-control__help">No recorded inputs in this period.</p> : null}
      {page.coverage === 'unconfirmed' ? <p className="continuous-progress-control__help" role="status">Some original input records could not be checked.</p> : null}
      {trail.length > 1 || page.nextCursor ? <nav aria-label="Recorded history pages" className="mote-calendar__time-pager">
        <Button disabled={!active || busy || trail.length < 2} onClick={() => void read(trail.slice(0, -1))}>Previous</Button>
        <span>Page {trail.length}</span>
        <Button disabled={!active || busy || !page.nextCursor} onClick={() => void read([...trail, page.nextCursor!])}>Next</Button>
      </nav> : null}
    </> : null}
    {failed || page ? <Button disabled={!active || busy} onClick={() => void read(failed ?? trail)}>{failed ? 'Retry history' : 'Refresh history'}</Button> : null}
  </div>
}
