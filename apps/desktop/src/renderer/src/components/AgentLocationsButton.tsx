import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useMemo, useState } from 'react'
import { agentRegionExecution, agentRegionLocationBindings, agentRegionLocationsKnown, useAppStore } from '../store'
import { sessionWorkbenchLocationCounts, workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'
import type { FocusContext } from '../lib/focus-context'

const LocationIcon = semanticIconComponent('navigation.space')

/** Mounted by Source details only; original display facts never control a Run. */
export function AgentLocationsButton({ context, subject = context.control, beforeOpen }: {
  context: FocusContext; subject?: { hostId: string; agentSessionId: string } | undefined; beforeOpen?: () => void
}) {
  const [issue, setIssue] = useState<string | null>(null)
  const tabs = useAppStore(state => workbenchNavigationTabs(state.tabs))
  const catalog = useAppStore(workbenchSelectionCatalog)
  const known = useAppStore(agentRegionLocationsKnown)
  const bindings = useAppStore(agentRegionLocationBindings)
  const hostId = subject?.hostId ?? context.hostId, agentSessionId = subject?.agentSessionId
  const observed = useMemo(() => sessionWorkbenchLocationCounts(tabs, catalog,
    id => id === context.id && agentSessionId ? { hostId, agentSessionId } : null, agentRegionExecution).get(context.id),
  [tabs, catalog, bindings, context.id, hostId, agentSessionId])
  const count = known && agentSessionId && observed !== null ? observed ?? 0 : undefined
  const quantity = count === undefined ? 'Locations unconfirmed' : `${count} ${count === 1 ? 'location' : 'locations'}`
  const label = `${context.name} · ${quantity.toLowerCase()} · Choose location`
  return <><button type="button" className="agent-locations" aria-label={label} onClick={() => {
    if (useAppStore.getState().requestSessionLocations(context.id, { subject: subject ?? null })) {
      setIssue(null); beforeOpen?.()
    } else setIssue('The original Agent identity is no longer confirmed. This reading is kept; reopen the Agent’s current details to choose its location.')
  }}><LocationIcon size={14} aria-hidden="true" /><span>{quantity}</span><span>Choose location</span></button>
  {issue ? <p role="status">{issue}</p> : null}</>
}
