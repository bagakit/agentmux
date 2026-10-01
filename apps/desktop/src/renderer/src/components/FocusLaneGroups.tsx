import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { allocateFocusLaneColumns, type FocusLaneCounts, type FocusLaneLayout, type FocusLaneMetrics } from '../lib/focus-lane-layout'

/** Local, disposable presentation state; Session facts and card order stay with the caller. */
export function FocusLaneGroups({ counts, metrics, children }: {
  counts: FocusLaneCounts; metrics: FocusLaneMetrics; children(layout: FocusLaneLayout): ReactNode
}) {
  const previous = useRef<readonly number[] | undefined>(undefined)
  const pressedSession = useRef<string | undefined>(undefined)
  const [attention, working, results, idle] = counts
  const { width, padding, gap, cardGap } = metrics
  const layout = useMemo(() => allocateFocusLaneColumns([attention, working, results, idle], { width, padding, gap, cardGap }, previous.current), [attention, working, results, idle, width, padding, gap, cardGap])
  useLayoutEffect(() => { previous.current = layout.columns }, [layout])
  return <div className="focus-project-lanes__groups" data-focus-card-slots={layout.slots} data-focus-max-rows={layout.maxRows}
    onPointerDownCapture={event => {
      if (event.button === 0) pressedSession.current = (event.target as Element).closest<HTMLElement>('.focus-context[data-session-id]')?.dataset.sessionId
    }}
    onPointerCancelCapture={() => { pressedSession.current = undefined }}
    onClickCapture={event => {
      const pressed = pressedSession.current
      pressedSession.current = undefined
      if (event.detail > 0 && pressed && pressed !== (event.target as Element).closest<HTMLElement>('.focus-context[data-session-id]')?.dataset.sessionId) {
        event.preventDefault()
        event.stopPropagation()
      }
    }}>{children(layout)}</div>
}
