import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ClientUiPlatform } from '../platform.js'

/** A message can cancel its unfinished full-text preparation when a nested Copy is chosen. */
export const ContentCopyIntentContext = createContext<(() => void) | undefined>(undefined)

type CopyState = 'idle' | 'copying' | 'copied' | 'failed'
type CopyAction = { owner: object; pending: boolean; writing: boolean; failed: boolean; controller: AbortController }

/** One action owns its feedback; cancellation can prevent preparation, never undo a write. */
export function useContentCopyAction(identity: unknown, write: ClientUiPlatform['copyText'] | undefined, active = true, resetAfterMs?: number) {
  const onIntent = useContext(ContentCopyIntentContext)
  const owner = useMemo(() => ({}), [identity, write, active])
  const latestOwner = useRef(owner); latestOwner.current = owner
  const mounted = useRef(true)
  const actionRef = useRef<CopyAction | null>(null)
  const [copy, setCopy] = useState<{ owner: object; state: CopyState; error?: unknown } | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; actionRef.current?.controller.abort(); actionRef.current = null }
  }, [])
  useEffect(() => () => { if (actionRef.current?.owner === owner) actionRef.current.controller.abort() }, [owner])
  useEffect(() => {
    if (!resetAfterMs || copy?.owner !== owner || copy.state !== 'copied') return
    const timer = setTimeout(() => setCopy(current => current === copy ? null : current), resetAfterMs)
    return () => clearTimeout(timer)
  }, [copy, owner, resetAfterMs])
  const cancelPreparation = useCallback(() => {
    const action = actionRef.current
    if (!action || !action.pending || action.writing) return
    action.controller.abort(); action.pending = false; actionRef.current = null
    setCopy(null)
  }, [])
  async function copyContent(content: string | ((signal: AbortSignal) => Promise<string>), onError?: (error: unknown) => void) {
    if (!write || !active || !mounted.current || latestOwner.current !== owner || (actionRef.current?.owner === owner && actionRef.current.pending)) return
    onIntent?.()
    const action: CopyAction = { owner, pending: true, writing: false, failed: false, controller: new AbortController() }
    actionRef.current = action
    const current = () => mounted.current && latestOwner.current === owner && actionRef.current === action && !action.controller.signal.aborted
    const failed = (error: unknown) => {
      if (!current()) return
      action.failed = true; action.pending = false
      setCopy({ owner, state: 'failed', error }); onError?.(error)
    }
    setCopy({ owner, state: 'copying' })
    try {
      const text = typeof content === 'string' ? content : await content(action.controller.signal)
      if (!current()) return
      action.writing = true
      const accepted = await write(text, failed) === true
      action.pending = false
      if (current() && !action.failed) setCopy({ owner, state: accepted ? 'copied' : 'failed' })
    } catch (error) { failed(error) }
  }
  return { state: copy?.owner === owner ? copy.state : 'idle' as CopyState,
    error: copy?.owner === owner ? copy.error : undefined, copy: copyContent, cancelPreparation }
}
