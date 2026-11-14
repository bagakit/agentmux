import { WorkbenchRegionOwners } from './WorkbenchRegionOwners'
import { rendererPerformance } from '../lib/renderer-performance'
import { useEffect, type ReactNode } from 'react'
import { useAgentStatusDecay } from '../lib/agent-status-decay'
import { SurfaceMemoryBudgetProvider, useSurfaceMemoryBudget } from '../lib/surface-memory-budget-coordinator'

function PerformanceRecorderOwner() {
  useEffect(() => rendererPerformance.observeMainThread(), [])
  return null
}

function AgentStatusDecayOwner() {
  useAgentStatusDecay()
  return null
}

function SurfaceMemoryOwner({ children, workbenchVisible, projectedVisibleTabIds, projectedVisibleRegionIds, measurementActive }: {
  children: ReactNode
  workbenchVisible: boolean
  projectedVisibleTabIds?: ReadonlySet<string> | undefined
  projectedVisibleRegionIds?: ReadonlySet<string> | undefined
  measurementActive: boolean
}) {
  const state = useSurfaceMemoryBudget({ workbenchVisible, projectedVisibleTabIds, projectedVisibleRegionIds, measurementActive })
  return <SurfaceMemoryBudgetProvider state={state}>{children}</SurfaceMemoryBudgetProvider>
}

/** Lifecycle subscriptions update their owners, while the window's children keep their identity. */
export function RendererResourceOwners({ children, workbenchVisible, projectedVisibleTabIds, projectedVisibleRegionIds, measurementActive }: {
  children: ReactNode
  workbenchVisible: boolean
  projectedVisibleTabIds?: ReadonlySet<string> | undefined
  projectedVisibleRegionIds?: ReadonlySet<string> | undefined
  measurementActive: boolean
}) {
  return <>
    <PerformanceRecorderOwner />
    <AgentStatusDecayOwner />
    <SurfaceMemoryOwner workbenchVisible={workbenchVisible} projectedVisibleTabIds={projectedVisibleTabIds} projectedVisibleRegionIds={projectedVisibleRegionIds} measurementActive={measurementActive}>
      <WorkbenchRegionOwners>{children}</WorkbenchRegionOwners>
    </SurfaceMemoryOwner>
  </>
}
