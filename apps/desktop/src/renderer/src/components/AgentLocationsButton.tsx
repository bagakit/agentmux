import { AgentWorkLocationTrigger, type AgentWorkLocationSummary } from '@agentmux/client-ui/patterns/agent-work-location'
import '@agentmux/client-ui/patterns/agent-work-location.css'
import { useMemo, useState } from 'react'
import { agentRegionExecution, agentRegionLocationBindings, useAppStore } from '../store'
import { sessionWorkbenchLocationSummary, workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'
import type { FocusContext } from '../lib/focus-context'

function locationLabel(summary: AgentWorkLocationSummary): string {
  if (summary.state === 'confirmed') return `${summary.count} ${summary.count === 1 ? 'location' : 'locations'}`
  return 'Locations unconfirmed'
}

/** Mounted by Source details only. The existing Store owns the exact selection. */
export function AgentLocationsButton({ context, subject = context.control, runtimeId, beforeOpen }: {
  context: FocusContext
  subject?: { hostId: string; agentSessionId: string } | undefined
  runtimeId?: string | undefined
  beforeOpen?: () => void
}) {
  const [issue, setIssue] = useState<string | null>(null)
  const tabs = useAppStore(state => workbenchNavigationTabs(state.tabs))
  const catalog = useAppStore(workbenchSelectionCatalog)
  const bindings = useAppStore(agentRegionLocationBindings)
  const hostId = subject?.hostId, agentSessionId = subject?.agentSessionId
  const summary = useMemo<AgentWorkLocationSummary>(() => {
    if (!bindings || hostId === undefined || agentSessionId === undefined) return { state: 'unconfirmed' }
    return sessionWorkbenchLocationSummary(tabs, catalog, context.id,
      { hostId, agentSessionId, ...(runtimeId === undefined ? {} : { runtimeId }) }, agentRegionExecution)
  }, [tabs, catalog, bindings, context.id, hostId, agentSessionId, runtimeId])
  return <>
    <AgentWorkLocationTrigger agentName={context.name} actionLabel="Choose location" summary={summary} describeSummary={locationLabel} onClick={() => {
      const original = subject ? { hostId: subject.hostId, agentSessionId: subject.agentSessionId,
        ...(runtimeId === undefined ? {} : { runtimeId }) } : null
      if (useAppStore.getState().requestSessionLocations(context.id, { subject: original })) {
        setIssue(null)
        beforeOpen?.()
      } else {
        setIssue('The original Agent identity is no longer confirmed. This reading is kept; reopen the Agent’s current details to choose its location.')
      }
    }} />
    {issue ? <p role="status">{issue}</p> : null}
  </>
}
