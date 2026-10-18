import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store'
import '../styles/space-content-presentation.css'

export type SpaceContentPresentation = {
  expanded: boolean
  expand(): void
  collapse(): void
}

export const SpaceContentPresentationContext = createContext<SpaceContentPresentation | null>(null)
export function useSpaceContentPresentation() { return useContext(SpaceContentPresentationContext) }

type Expansion = {
  workspaceId: string
  selection: ReturnType<typeof useAppStore.getState>['workbenchSpaceSelection']
  toolsOpen: boolean
}

/** An explicit view of the existing content slot. Spatial identity and layout stay with their owner. */
export function useSpaceContentPresentationOwner(): SpaceContentPresentation {
  const [expansion, setExpansion] = useState<Expansion | null>(null)
  const current = useRef<Expansion | null>(null)
  useLayoutEffect(() => useAppStore.subscribe(state => {
    const owner = current.current
    if (owner && (state.mainSurface !== 'workbench' || state.activeWorkspaceId !== owner.workspaceId ||
      state.workbenchSpaceSelection !== owner.selection || state.workspaceTool !== 'files-branches' || state.toolsOpen !== owner.toolsOpen)) {
      current.current = null
      setExpansion(null)
    }
  }), [])
  const expand = useCallback(() => {
    const state = useAppStore.getState()
    if (state.mainSurface !== 'workbench' || !state.activeWorkspaceId) return
    if (state.workspaceTool !== 'files-branches') useAppStore.setState({ workspaceTool: 'files-branches' })
    const selected = useAppStore.getState()
    const owner = { workspaceId: selected.activeWorkspaceId!, selection: selected.workbenchSpaceSelection, toolsOpen: selected.toolsOpen }
    current.current = owner
    setExpansion(owner)
  }, [])
  // Each async caller keeps its original view intent. Its late result cannot close a later home.
  const collapse = useCallback(() => {
    if (current.current !== expansion) return
    current.current = null
    setExpansion(null)
  }, [expansion])
  return useMemo(() => ({ expanded: expansion !== null, expand, collapse }), [expansion, expand, collapse])
}
