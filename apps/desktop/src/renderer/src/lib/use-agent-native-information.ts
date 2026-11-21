import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentInformationSnapshot } from '@agentmux/core'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from './api'

type Reading = { information?: AgentInformationSnapshot | undefined; loading: boolean; issue?: string | undefined }

/** Account information is read only when its information surface asks for it. */
export function useAgentNativeInformation(control: AgentSessionControl | undefined, visible: boolean,
  information?: AgentInformationSnapshot, nativeSessionId?: string) {
  const key = control ? JSON.stringify([control.hostId, control.agentSessionId, control.run.runId, nativeSessionId]) : null
  const owner = useMemo(() => ({ key, visible }), [key, visible])
  const latest = useRef(owner); latest.current = owner
  const mounted = useRef(true)
  const [reading, setReading] = useState<{ owner: typeof owner; value: Reading }>()
  const inFlight = useRef<{ owner: typeof owner; promise: Promise<void> } | undefined>(undefined)
  const version = useRef(0), published = useRef(information)
  const value: Reading = reading?.owner === owner ? reading.value : { information, loading: false }
  const currentValue = useRef(value); currentValue.current = value
  const current = () => mounted.current && latest.current === owner && visible
  const refresh = useCallback((): Promise<void> => {
    if (!control || !current()) return Promise.resolve()
    if (inFlight.current?.owner === owner) return inFlight.current.promise
    const started = version.current
    setReading({ owner, value: { ...currentValue.current, loading: true, issue: undefined } })
    const promise = (async () => {
      try {
        const result = await api.sessions.inspectInformation(control)
        if (!current()) return
        if (result.target.hostId !== control.hostId || result.target.agentSessionId !== control.agentSessionId ||
            result.target.expectedRun.runId !== control.run.runId || nativeSessionId && result.snapshot && result.snapshot.nativeSessionId !== nativeSessionId) {
          throw new Error('The original Agent information source changed. Refresh this Session.')
        }
        setReading({ owner, value: { information: started === version.current ? result.snapshot ?? undefined : currentValue.current.information,
          loading: false, ...(result.issue ? { issue: result.issue.message } : {}) } })
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
  return { ...value, refresh }
}
