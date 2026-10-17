import { useCallback, useLayoutEffect, useRef } from 'react'
import { focusPreviewDelay, type FocusPreviewTrigger } from '../../../shared/focus-preferences'

/** Timing only. The caller keeps ownership of the original preview token and visibility. */
export function useAgentPreviewIntent(callback: () => void, trigger: FocusPreviewTrigger, enabled: boolean) {
  const latest = useRef(callback)
  latest.current = callback
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancel = useCallback(() => { clearTimeout(timer.current); timer.current = undefined }, [])
  useLayoutEffect(() => cancel, [trigger, enabled, cancel])
  const schedule = useCallback(() => {
    cancel()
    const delay = focusPreviewDelay(trigger)
    if (!enabled || delay === null) return
    timer.current = setTimeout(() => { timer.current = undefined; latest.current() }, delay)
  }, [trigger, enabled, cancel])
  return { schedule, cancel }
}
