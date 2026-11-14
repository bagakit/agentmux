import { useLayoutEffect, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { Button } from '@agentmux/client-ui/components/Button'
import { validateScheduleRpcResult, type ScheduleResultMap } from '@agentmux/core/schedule-rpc'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'
import { api } from '../lib/api'
import { scheduleCalendarLabel } from './ScheduleArrangementRow'
import { SelectionField } from './SelectionField'

type HistoryResult = ScheduleResultMap['schedule.history']
type HistoryWindow = { from: number; to: number }

const deliveryLabel: Record<HistoryResult['entries'][number]['delivery'], string> = {
  'terminal-confirmed': 'Sent to terminal', 'native-admitted': 'Input accepted', 'not-applied': 'Not sent', unconfirmed: 'Delivery unconfirmed'
}
const nativeLabel = { completed: 'Native turn completed', failed: 'Native turn failed', interrupted: 'Native turn interrupted' } as const

export function MoteScheduleHistory({ records, window, timezone, active, selectedSchedule, onSelectSchedule }: {
  records: readonly ContinuousProgressLoop[]; window: HistoryWindow; timezone: string; active: boolean; selectedSchedule?: string | undefined
  onSelectSchedule(scheduleId: string): void
}) {
  const scheduleId = records.length === 1 ? records[0]!.loopId : selectedSchedule ?? ''
  const record = records.find(value => value.loopId === scheduleId)
  if (!records.length) return null
  return <details className="mote-calendar__time-details mote-calendar__recorded">
    <summary>Recorded history</summary>
    {records.length > 1 ? <SelectionField label="Arrangement history" value={scheduleId}
      options={records.map(value => ({ value: value.loopId, label: scheduleCalendarLabel(value) }))}
      missingOptionLabel="Choose an arrangement" onValueChange={onSelectSchedule} /> : null}
    {record ? <HistoryPages key={JSON.stringify([record.loopId, window.from, window.to])} scheduleId={record.loopId}
      window={window} timezone={timezone} active={active} /> : null}
  </details>
}

function HistoryPages({ scheduleId, window, timezone, active }: {
  scheduleId: string; window: HistoryWindow; timezone: string; active: boolean
}) {
  const [page, setPage] = useState<HistoryResult>()
  const [trail, setTrail] = useState<readonly (string | undefined)[]>([undefined])
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState(false)
  const request = useRef(0)
  useLayoutEffect(() => {
    if (!active) setBusy(false)
    return () => { request.current++ }
  }, [active])

  async function read(nextTrail: typeof trail) {
    if (!active || busy) return
    const original = ++request.current
    const cursor = nextTrail.at(-1)
    const input = { scheduleId, ...window, ...(cursor ? { cursor } : {}) }
    setBusy(true); setIssue(false)
    try {
      const result = validateScheduleRpcResult('schedule.history', await api.schedule.history(input), input)
      if (original !== request.current) return
      if (result.coverage === 'unconfirmed' && !result.entries.length && !result.nextCursor) { setIssue(true); return }
      setPage(result); setTrail(nextTrail)
    } catch {
      if (original === request.current) setIssue(true)
    } finally {
      if (original === request.current) setBusy(false)
    }
  }

  return <div className="mote-calendar__time-page" aria-busy={busy}>
    {!page ? <Button disabled={!active || busy} onClick={() => void read(trail)}>{busy ? 'Reading history…' : 'Read history'}</Button> : null}
    {issue ? <p className="continuous-progress-control__help" role="status">History could not be checked. {page ? 'The previous page is still shown.' : 'Try the same arrangement again.'}</p> : null}
    {page ? <>
      {page.entries.length ? <><p className="mote-calendar__reading-note">Original due time and delivery</p>
        <ol aria-label="Recorded input receipts">{page.entries.map(entry => {
          const time = DateTime.fromMillis(entry.occurrenceAt, { zone: timezone })
          const native = entry.nativeResult.state
          return <li key={entry.operationId}>
            <time dateTime={time.toISO()!} title={time.toFormat('HH:mm:ss ZZ')}>{time.toFormat('HH:mm')}</time>
            <span>{deliveryLabel[entry.delivery]}</span>
            {native !== 'unknown' && native !== 'unsupported' ? <small>{nativeLabel[native]}</small> : null}
          </li>
        })}</ol></> : page.coverage === 'recorded-inputs' ? <p className="continuous-progress-control__help">No recorded inputs in this period.</p> : null}
      {page.coverage === 'unconfirmed' ? <p className="continuous-progress-control__help" role="status">Some original input records could not be checked.</p> : null}
      {trail.length > 1 || page.nextCursor ? <nav aria-label="Recorded history pages" className="mote-calendar__time-pager">
        <Button disabled={!active || busy || trail.length < 2} onClick={() => void read(trail.slice(0, -1))}>Previous</Button>
        <span>Page {trail.length}</span>
        <Button disabled={!active || busy || !page.nextCursor} onClick={() => void read([...trail, page.nextCursor!])}>Next</Button>
      </nav> : null}
    </> : null}
  </div>
}
