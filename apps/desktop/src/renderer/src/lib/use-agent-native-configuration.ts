import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentConfigurationInspection, AgentConfigurationSnapshot, AgentConfigurationTarget } from '@agentmux/core'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from './api'

type Inspection = Extract<AgentConfigurationInspection, { kind: 'configuration' }>
type Reading = { snapshot?: AgentConfigurationSnapshot | undefined; target?: AgentConfigurationTarget | undefined; loading: boolean; issue?: string | undefined }

/** Core owns configuration. This mounted reader keeps only the exact visible request and its result. */
export function useAgentNativeConfiguration(control: AgentSessionControl | undefined, visible: boolean,
  snapshot?: AgentConfigurationSnapshot, nativeSessionId?: string) {
  const key = control ? JSON.stringify([control.hostId, control.agentSessionId, control.run.runId, nativeSessionId]) : null
  const owner = useMemo(() => ({ key, visible }), [key, visible])
  const latest = useRef(owner); latest.current = owner
  const mounted = useRef(true)
  const [reading, setReading] = useState<{ owner: typeof owner; value: Reading }>()
  const inFlight = useRef<{ owner: typeof owner; promise: Promise<Inspection> } | undefined>(undefined)
  const version = useRef(0), published = useRef(snapshot)
  const value: Reading = reading?.owner === owner ? reading.value : { snapshot, loading: false }
  const currentValue = useRef(value); currentValue.current = value
  const current = () => mounted.current && latest.current === owner && visible
  const refresh = useCallback((): Promise<Inspection> => {
    if (!control || !current()) return Promise.reject(new Error('The original model surface is no longer visible. No model change was requested.'))
    if (inFlight.current?.owner === owner) return inFlight.current.promise
    const started = version.current
    setReading({ owner, value: { ...currentValue.current, loading: true, issue: undefined } })
    const promise = (async () => {
      try {
        const result = await api.sessions.inspectConfiguration(control)
        if (!current()) throw new Error('The original model scope changed. No model change was requested.')
        if (result.kind !== 'configuration' || result.target.hostId !== control.hostId || result.target.agentSessionId !== control.agentSessionId ||
            result.target.expectedRun.runId !== control.run.runId || nativeSessionId && result.snapshot?.observation && result.snapshot.observation.nativeSessionId !== nativeSessionId) {
          throw new Error('The original native model source changed. Read this Session’s model choices again.')
        }
        setReading({ owner, value: { snapshot: started === version.current ? result.snapshot ?? undefined : currentValue.current.snapshot,
          target: result.target, loading: false } })
        return result
      } catch (error) {
        if (current()) setReading({ owner, value: { ...currentValue.current, loading: false,
          issue: error instanceof Error ? error.message : 'The original native model configuration could not be read.' } })
        throw error
      } finally { if (inFlight.current?.owner === owner) inFlight.current = undefined }
    })()
    inFlight.current = { owner, promise }
    return promise
  }, [owner])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (control && visible) void refresh().catch(() => {}) }, [owner, refresh])
  useEffect(() => {
    if (snapshot !== published.current && current()) {
      version.current++
      currentValue.current = { ...currentValue.current, snapshot }
      setReading({ owner, value: currentValue.current })
    }
    published.current = snapshot
  }, [snapshot, owner])
  return { ...value, refresh }
}
