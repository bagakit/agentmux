import { useCallback, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MobileTopicsRoute } from '../recovery/presentation-route'
import { getDeviceWorkface } from '../recovery/device-workface'
import { createTopicsNavigation, observeTopicsNavigation, projectTopicsRoute, reduceTopicsNavigation,
  type TopicsNavigationController, type TopicsNavigationIntent, type TopicsNavigationObservation } from './topics-navigation'

/** React state only; DeviceWorkface remains the sole persistent record owner. */
export function useTopicsNavigation(initial?: MobileTopicsRoute, client?: AgentMuxHostedClient | null): TopicsNavigationController {
  const [state, setState] = useState(() => createTopicsNavigation(initial))
  const recordId = getDeviceWorkface().recordIdentity()
  const identity = client?.runtimeOwnerIdentity?.()
  const runtimeId = identity?.runtimeId, instanceId = identity?.ownerInstanceId
  const latest = useRef({ client, recordId, runtimeId, instanceId }); latest.current = { client, recordId, runtimeId, instanceId }
  const send = useCallback((intent: TopicsNavigationIntent) => setState(value => reduceTopicsNavigation(value, intent)), [])
  const observe = useCallback((observation: TopicsNavigationObservation) => {
    const now = latest.current, current = now.client?.runtimeOwnerIdentity?.()
    if (now.client !== client || now.recordId !== recordId || getDeviceWorkface().recordIdentity() !== recordId
      || current?.runtimeId !== runtimeId || current?.ownerInstanceId !== instanceId) return
    setState(value => observeTopicsNavigation(value, observation))
  }, [client, recordId, runtimeId, instanceId])
  const route = useMemo(() => projectTopicsRoute(state), [state])
  return { state, route, send, observe }
}
