import { memo, useMemo, type CSSProperties } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { useVisibleWork } from '@agentmux/client-ui/use-visible-work'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import type { FocusListActivity } from '../lib/focus-list-activity'

const activityLabels = { sent: '观察到发送', received: '观察到接收', self: '观察到自发自收', updated: '派发记录更新' }

export const FocusCommunicationFeedback = memo(function FocusCommunicationFeedback({ activity }: { activity: FocusListActivity }) {
  const active = useWorkbenchPresentationActive()
  const { ref, visible } = useVisibleWork<HTMLDivElement>(active)
  const delay = useMemo(() => Math.min(0, activity.pulse.startedAt - Date.now()), [activity.pulse, visible])
  return <div ref={ref} className="focus-communication-feedback" role="status" data-activity-id={activity.pulse.id}
    data-kind={activity.pulse.kind} data-direction={activity.direction} data-motion-active={visible}
    style={{ '--activity-delay': `${delay}ms` } as CSSProperties}>
    <span key={`${activity.pulse.id}:${visible}`} className="focus-communication-feedback__mark" aria-hidden="true">
      <SemanticIcon name={activity.direction === 'updated' ? 'action.refresh' : activity.direction === 'received' ? 'navigation.back' : 'action.send'} size={12} />
    </span><span>{activityLabels[activity.direction]}</span>
  </div>
})
