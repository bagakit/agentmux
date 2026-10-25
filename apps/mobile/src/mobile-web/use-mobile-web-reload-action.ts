import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useMobileWebUpdateSafety } from './update-safety'

/** Presentation for one explicit action; the existing safety owner decides navigation. */
export function useMobileWebReloadAction(active = true) {
  const safety = useMobileWebUpdateSafety()
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<{ message: string; attempt: number } | null>(null)
  const attempt = useRef(0), intent = useRef<AbortController | null>(null)
  const cancel = useCallback(() => { intent.current?.abort() }, [])
  useLayoutEffect(() => { if (!active) cancel(); return cancel }, [active, cancel])
  const reload = async () => {
    if (intent.current) return
    const originalIntent = new AbortController(), currentAttempt = ++attempt.current
    intent.current = originalIntent
    setBusy(true); setIssue(null)
    try {
      const result = await safety.apply(originalIntent.signal)
      if (!originalIntent.signal.aborted && result.status === 'blocked') setIssue({ message: result.message, attempt: currentAttempt })
    } catch {
      if (!originalIntent.signal.aborted) setIssue({ message: '原页面重开尚未确认；当前工作面和内容保留，请稍后重试。', attempt: currentAttempt })
    } finally { if (intent.current === originalIntent) { intent.current = null; setBusy(false) } }
  }
  return { busy, issue, reload, cancel }
}
