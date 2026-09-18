import { type ReactNode } from 'react'
import { useAgentStatusDecay } from '../lib/agent-status-decay'
import { TerminalParkingProvider, useTerminalColdParking } from '../lib/terminal-cold-parking-coordinator'
import { SurfaceMemoryBudgetProvider, useSurfaceMemoryBudget } from '../lib/surface-memory-budget-coordinator'

function AgentStatusDecayOwner() {
  useAgentStatusDecay()
  return null
}

function TerminalParkingOwner({ children, workbenchVisible, projectedVisibleTabIds, measurementActive }: {
  children: ReactNode
  workbenchVisible: boolean
  projectedVisibleTabIds?: ReadonlySet<string> | undefined
  measurementActive: boolean
}) {
  const parkedRegionIds = useTerminalColdParking({ workbenchVisible, projectedVisibleTabIds, measurementActive })
  return <TerminalParkingProvider parkedRegionIds={parkedRegionIds}>{children}</TerminalParkingProvider>
}

function SurfaceMemoryOwner({ children, workbenchVisible, projectedVisibleTabIds, measurementActive }: {
  children: ReactNode
  workbenchVisible: boolean
  projectedVisibleTabIds?: ReadonlySet<string> | undefined
  measurementActive: boolean
}) {
  const state = useSurfaceMemoryBudget({ workbenchVisible, projectedVisibleTabIds, measurementActive })
  return <SurfaceMemoryBudgetProvider state={state}>{children}</SurfaceMemoryBudgetProvider>
}

/** Lifecycle subscriptions update their owners, while the window's children keep their identity. */
export function RendererResourceOwners({ children, workbenchVisible, projectedVisibleTabIds, measurementActive }: {
  children: ReactNode
  workbenchVisible: boolean
  projectedVisibleTabIds?: ReadonlySet<string> | undefined
  measurementActive: boolean
}) {
  return <>
    <AgentStatusDecayOwner />
    <TerminalParkingOwner workbenchVisible={workbenchVisible} projectedVisibleTabIds={projectedVisibleTabIds} measurementActive={measurementActive}>
      <SurfaceMemoryOwner workbenchVisible={workbenchVisible} projectedVisibleTabIds={projectedVisibleTabIds} measurementActive={measurementActive}>
        {children}
      </SurfaceMemoryOwner>
    </TerminalParkingOwner>
  </>
}
