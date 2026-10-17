import type { useScheduleOperation } from '../lib/schedule-controller'

export function ScheduleOperationNotice({ operation }: { operation: ReturnType<typeof useScheduleOperation> }) {
  return operation.error || operation.pending ? <div className="calendar-schedules__notice" role="status">
    <p>{operation.error ?? 'The original operation is awaiting confirmation. Its request is kept.'}</p>
    {operation.pending ? <p>Manual messages remain available. A retry uses the same request.</p> : null}
    {operation.pending ? <div className="calendar-schedules__actions">
      <button type="button" className="small-button" disabled={operation.busy} onClick={() => void operation.inspect()}>Check original operation</button>
      <button type="button" className="small-button" disabled={operation.busy} onClick={() => operation.pending && void operation.perform(operation.pending)}>Retry original operation</button>
    </div> : null}
  </div> : null
}
