import { useMemo, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { automationCalendarTimezone, resolveAutomationPreferences } from '../../../shared/automation-preferences'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { useScheduleRecords } from '../lib/schedule-controller'
import { useScheduleClock } from '../lib/schedule-clock'
import { useAppStore } from '../store'
import { moteScheduleQueries } from './MoteCalendar'
import { scheduleStateLabel } from './ScheduleArrangementRow'

const Forward = semanticIconComponent('navigation.forward')

/** A bounded reading of the same arrangements shown in Calendar. */
export function MoteUpcoming({ scope, active, onOpenCalendar }: {
  scope: MoteWorkfaceScope; active: boolean; onOpenCalendar(scheduleId?: string): void
}) {
  const queries = moteScheduleQueries(scope), retained = useRef(queries)
  if (queries.length) retained.current = queries
  const source = useScheduleRecords(queries.length ? queries : retained.current, active && queries.length > 0)
  const now = useScheduleClock(active)
  const [timezone] = useState(() => automationCalendarTimezone(resolveAutomationPreferences(useAppStore.getState().config?.automation)))
  const upcoming = useMemo(() => source.records.filter(record => record.status !== 'stopped')
    .sort((a, b) => a.nextCheckAt - b.nextCheckAt || a.loopId.localeCompare(b.loopId)).slice(0, 3), [source.records])
  return <section className="mote-upcoming" aria-label="Next arrangements">
    <div className="mote-details__section-actions">
      <button type="button" className="mote-details__navigation" onClick={() => onOpenCalendar()}>
        <span>Coming up<small>{timezone}</small></span><Forward size={14} />
      </button>
    </div>
    {!queries.length || source.error ? <div className="mote-details__issue" role="status">
      <span>{!queries.length ? scope.issue ?? scope.topic.readError ?? 'Mote directory scope is unconfirmed.' : source.error} Last confirmed arrangements are kept.</span>
      {queries.length ? <button type="button" className="small-button" onClick={source.refresh}>Retry arrangements</button> : null}
    </div> : null}
    {upcoming.length ? <ol className="mote-upcoming__list">{upcoming.map(record => {
      const date = DateTime.fromMillis(record.nextCheckAt, { zone: timezone })
      return <li key={record.loopId}><button type="button" className="mote-upcoming__item" data-upcoming-id={record.loopId}
        onClick={() => onOpenCalendar(record.loopId)}>
        <time className="mote-upcoming__date" dateTime={date.toISO()!}><b>{date.toFormat('dd')}</b><span>{date.toFormat('LLL')}</span></time>
        <span className="mote-upcoming__copy"><strong>{record.prompt.split('\n')[0]}</strong>
          <small>{date.toFormat('ccc · HH:mm')}<span> · {scheduleStateLabel(record, now)}</span></small></span>
        <Forward size={13} />
      </button></li>
    })}</ol> : <p className="mote-details__hint">{source.observed ? 'Room for the next thing. Add an arrangement in Calendar.'
      : source.error || !queries.length ? 'Arrangements are not confirmed.' : 'Reading arrangements…'}</p>}
  </section>
}
