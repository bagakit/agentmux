import type { WorkspaceBranchesSnapshot } from '../../../shared/contracts'

export type WorkspaceBranchesRequestState = {
  workspaceId: string
  snapshot: WorkspaceBranchesSnapshot | null
  loading: boolean
  error: string | null
}

export type VisibleWorkspaceBranchesState = {
  snapshot: WorkspaceBranchesSnapshot | null
  loading: boolean
  error: string | null
}

export function visibleWorkspaceBranchesState(
  workspaceId: string | null,
  state: WorkspaceBranchesRequestState | null
): VisibleWorkspaceBranchesState {
  if (!workspaceId) return { snapshot: null, loading: false, error: null }
  if (state?.workspaceId !== workspaceId) {
    return { snapshot: null, loading: true, error: null }
  }
  return {
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error
  }
}
