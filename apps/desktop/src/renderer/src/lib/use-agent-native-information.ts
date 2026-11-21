import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentConfigurationSnapshot, AgentInformationInspection, AgentInformationSnapshot } from '@agentmux/core'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from './api'

type Reading = { information?: AgentInformationSnapshot | undefined; configuration?: AgentConfigurationSnapshot | undefined; loading: boolean; issue?: string | undefined }

/** Visible-Composer observation only. Core owns the cached facts and native operations. */
export function useAgentNativeInformation(control: AgentSessionControl | undefined, visible: boolean,
  information?: AgentInformationSnapshot, configuration?: AgentConfigurationSnapshot, nativeSessionId?: string) {
  const key = control ? JSON.stringify([control.hostId, control.agentSessionId, control.run.runId, nativeSessionId]) : null
  const owner = useMemo(() => ({ key, visible }), [key, visible])
  const latest = useRef(owner); latest.current = owner
  const mounted = useRef(true)
  const [reading, setReading] = useState<{ owner: typeof owner; value: Reading }>()
  const inFlight = useRef<{ owner: typeof owner; promise: Promise<void> } | undefined>(undefined)
  const informationVersion = useRef(0), configurationVersion = useRef(0)
  const published = useRef({ information, configuration })
  const value: Reading = reading?.owner === owner ? reading.value : { information, configuration, loading: false }
  const currentValue = useRef(value); currentValue.current = value
  const current = () => mounted.current && latest.current === owner && visible
  const refresh = useCallback((): Promise<void> => {
    if (!control || !visible || !mounted.current) return Promise.resolve()
    if (inFlight.current?.owner === owner) return inFlight.current.promise
    const startedInformationVersion = informationVersion.current, startedConfigurationVersion = configurationVersion.current
    setReading({ owner, value: { ...currentValue.current, loading: true, issue: undefined } })
    const promise = (async () => {
      try {
        const result: AgentInformationInspection = await api.sessions.inspectInformation(control)
        if (!current()) return
        if (result.target.hostId !== control.hostId || result.target.agentSessionId !== control.agentSessionId ||
            result.target.expectedRun.runId !== control.run.runId || nativeSessionId && result.snapshot && result.snapshot.nativeSessionId !== nativeSessionId) {
          throw new Error('The original Agent information source changed. Refresh this Session.')
        }
        const retained = currentValue.current
        setReading({ owner, value: {
          information: startedInformationVersion === informationVersion.current ? result.snapshot ?? undefined : retained.information,
          configuration: startedConfigurationVersion === configurationVersion.current ? result.configuration ?? undefined : retained.configuration,
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
  useEffect(() => { if (visible && control) void refresh() }, [owner, refresh])
  useEffect(() => {
    const changedInformation = information !== published.current.information
    const changedConfiguration = configuration !== published.current.configuration
    if (current() && (changedInformation || changedConfiguration)) {
      if (changedInformation) informationVersion.current++
      if (changedConfiguration) configurationVersion.current++
      currentValue.current = { ...currentValue.current,
        ...(changedInformation ? { information } : {}), ...(changedConfiguration ? { configuration } : {}) }
      setReading({ owner, value: currentValue.current })
    }
    published.current = { information, configuration }
  }, [information, configuration, owner])
  const adoptConfiguration = useCallback((snapshot: AgentConfigurationSnapshot) => {
    if (current()) {
      configurationVersion.current++
      currentValue.current = { ...currentValue.current, configuration: snapshot }
      setReading({ owner, value: currentValue.current })
    }
  }, [owner])
  return { ...value, refresh, adoptConfiguration }
}
