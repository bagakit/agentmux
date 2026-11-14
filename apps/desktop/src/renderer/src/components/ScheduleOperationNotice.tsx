import { Button } from '@agentmux/client-ui/components/Button'
import type { useScheduleOperation } from '../lib/schedule-controller'

export function ScheduleOperationNotice({ operation }: { operation: ReturnType<typeof useScheduleOperation> }) {
  return operation.error || operation.pending ? <div className="calendar-schedules__notice" role="status">
    <p>{operation.error ?? 'The original operation is awaiting confirmation. Its request is kept.'}</p>
    {operation.pending ? <p>Manual messages remain available. A retry uses the same request.</p> : null}
    {operation.pending ? <div className="calendar-schedules__actions">
      <Button type="button" disabled={operation.busy} onClick={() => void operation.inspect()}>Check original operation</Button>
      <Button type="button" disabled={operation.busy} onClick={() => operation.pending && void operation.perform(operation.pending)}>Retry original operation</Button>
    </div> : null}
  </div> : null
}
