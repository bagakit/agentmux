import type { SpaceClosePrepare, SpaceCloseProjection, SpaceCloseReceipt, SpaceCloseCommitResult } from '@agentmux/core'
export type WorkbenchCloseRendererRequest =
  | { operation: 'workbench.close.capture'; requestId: string; input: SpaceClosePrepare }
  | { operation: 'workbench.close.reserve' | 'workbench.close.release' | 'workbench.close.commit'; requestId: string; record: SpaceCloseReceipt }
  | { operation: 'workbench.close.validate'; requestId: string; record: SpaceCloseReceipt; key: string }
export type WorkbenchCloseRendererResult =
  | { operation: 'workbench.close.capture'; requestId: string; projection: SpaceCloseProjection }
  | { operation: 'workbench.close.commit'; requestId: string; result: SpaceCloseCommitResult }
  | { operation: 'workbench.close.reserve' | 'workbench.close.release' | 'workbench.close.validate'; requestId: string }
export function isWorkbenchCloseRendererRequest(request: { operation: string }): request is WorkbenchCloseRendererRequest {
  return ['workbench.close.capture', 'workbench.close.reserve', 'workbench.close.release', 'workbench.close.validate', 'workbench.close.commit'].includes(request.operation)
}
