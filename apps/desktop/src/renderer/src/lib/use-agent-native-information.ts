import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentInformationInspection, AgentInformationSnapshot } from '@agentmux/core'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from './api'
import { useWorkbenchDocument } from './workbench-document'

type Reading = { information?: AgentInformationSnapshot | undefined; loading: boolean; issue?: string | undefined; issueCode?: string | undefined }

const SAMPLE_INTERVAL = 30_000
const pendingReads = new Map<string, Promise<AgentInformationInspection>>()

/** Share a live request across a rapid close/reopen, without caching its result here. */
function readAccount(key: string, control: AgentSessionControl) {
  const pending = pendingReads.get(key)
  if (pending) return pending
  const reading = api.sessions.inspectInformation(control).finally(() => pendingReads.delete(key))
  pendingReads.set(key, reading)
  return reading
}

/** Account information is read only when its information surface asks for it. */
export function useAgentNativeInformation(control: AgentSessionControl | undefined,
  information?: AgentInformationSnapshot, nativeSessionId?: string) {
  const key = control ? JSON.stringify([control.hostId, control.agentSessionId, control.run.runId, nativeSessionId]) : null
  const document = useWorkbenchDocument()
  const owner = useMemo(() => ({ key }), [key])
  const lastAttempt = useRef<{ owner: typeof owner; at: number } | undefined>(undefined)
  const [now, setNow] = useState(Date.now)
  const latest = useRef(owner); latest.current = owner
  const mounted = useRef(true)
  const [reading, setReading] = useState<{ owner: typeof owner; value: Reading }>()
  const inFlight = useRef<{ owner: typeof owner; promise: Promise<void> } | undefined>(undefined)
  const version = useRef(0), published = useRef(information)
  const value: Reading = reading?.owner === owner ? reading.value : { information, loading: false }
  const currentValue = useRef(value); currentValue.current = value
  const current = () => mounted.current && latest.current === owner
  const refresh = useCallback((): Promise<void> => {
    if (!key || !control || !current()) return Promise.resolve()
    if (inFlight.current?.owner === owner) return inFlight.current.promise
    lastAttempt.current = { owner, at: Date.now() }
    const started = version.current
    setReading({ owner, value: { ...currentValue.current, loading: true, issue: undefined } })
    const promise = (async () => {
      try {
        const result = await readAccount(key, control)
        if (!current()) return
        if (result.target.hostId !== control.hostId || result.target.agentSessionId !== control.agentSessionId ||
            result.target.expectedRun.runId !== control.run.runId || nativeSessionId && result.snapshot && result.snapshot.nativeSessionId !== nativeSessionId) {
          throw new Error('The original Agent information source changed. Refresh this Session.')
        }
        setReading({ owner, value: { information: started === version.current ? result.snapshot ?? (result.issue ? currentValue.current.information : undefined) : currentValue.current.information,
          loading: false, ...(result.issue ? { issue: result.issue.message, issueCode: result.issue.code } : {}) } })
      } catch (error) {
        if (current()) setReading({ owner, value: { ...currentValue.current, loading: false,
          issue: error instanceof Error ? error.message : 'Native information could not be refreshed.' } })
      } finally { if (inFlight.current?.owner === owner) inFlight.current = undefined }
    })()
    inFlight.current = { owner, promise }
    return promise
  }, [owner])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (information !== published.current && current()) {
      version.current++
      currentValue.current = { ...currentValue.current, information }
      setReading({ owner, value: currentValue.current })
    }
    published.current = information
  }, [information, owner])
  useEffect(() => {
    if (!key) return
    const tick = () => {
      if (document.visibilityState === 'hidden' || !current()) return
      const at = Date.now()
      setNow(at)
      const previous = lastAttempt.current
      if (previous?.owner !== owner) { void refresh(); return }
      const { issueCode } = currentValue.current
      if (!nativeSessionId || issueCode === 'AGENT_INFORMATION_UNSUPPORTED' || issueCode === 'AGENT_INFORMATION_SOURCE_UNCONFIRMED') return
      if (at - previous.at >= SAMPLE_INTERVAL) void refresh()
    }
    tick()
    const timer = document.defaultView!.setInterval(tick, SAMPLE_INTERVAL)
    document.addEventListener('visibilitychange', tick)
    return () => { document.defaultView!.clearInterval(timer); document.removeEventListener('visibilitychange', tick) }
  }, [key, owner, nativeSessionId, document, refresh])
  return { ...value, now, refresh }
}
