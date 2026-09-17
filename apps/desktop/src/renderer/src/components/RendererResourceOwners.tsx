import { type ReactNode } from 'react'
import { useAgentStatusDecay } from '../lib/agent-status-decay'
import { TerminalParkingProvider, useTerminalColdParking } from '../lib/terminal-cold-parking-coordinator'
import { SurfaceMemoryBudgetProvider, useSurfaceMemoryBudget } from '../lib/surface-memory-budget-coordinator'

function AgentStatusDecayOwner() {
  useAgentStatusDecay()
  return null
}

function TerminalParkingOwner({ children, workbenchVisible, measurementActive }: {
  children: ReactNode
  workbenchVisible: boolean
  measurementActive: boolean
}) {
  const parkedRegionIds = useTerminalColdParking({ workbenchVisible, measurementActive })
  return <TerminalParkingProvider parkedRegionIds={parkedRegionIds}>{children}</TerminalParkingProvider>
}

function SurfaceMemoryOwner({ children, workbenchVisible, measurementActive }: {
  children: ReactNode
  workbenchVisible: boolean
  measurementActive: boolean
}) {
  const state = useSurfaceMemoryBudget({ workbenchVisible, measurementActive })
  return <SurfaceMemoryBudgetProvider state={state}>{children}</SurfaceMemoryBudgetProvider>
}

/** Lifecycle subscriptions update their owners, while the window's children keep their identity. */
export function RendererResourceOwners({ children, workbenchVisible, measurementActive }: {
  children: ReactNode
  workbenchVisible: boolean
  measurementActive: boolean
}) {
  return <>
    <AgentStatusDecayOwner />
    <TerminalParkingOwner workbenchVisible={workbenchVisible} measurementActive={measurementActive}>
      <SurfaceMemoryOwner workbenchVisible={workbenchVisible} measurementActive={measurementActive}>
        {children}
      </SurfaceMemoryOwner>
    </TerminalParkingOwner>
  </>
}
