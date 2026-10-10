import type { AppWindowDescriptor, AppWindowTarget } from '@agentmux/core/control'

export const WORKBENCH_WINDOW_REQUEST = 'workbenchWindows:request'
export const WORKBENCH_WINDOW_RESPONSE = 'workbenchWindows:response'
export const WORKBENCH_WINDOW_CHANGED = 'workbenchWindows:changed'

export type WorkbenchWindowRequest = {
  requestId: string
  windowId: string
  documentGeneration: string
  target: AppWindowTarget
} & (
  | { action: 'prepare' }
  | { action: 'open'; url: string; frameName: string }
  | { action: 'return' }
  | { action: 'focus' }
)
export type WorkbenchWindowResponse = {
  requestId: string
  windowId: string
  documentGeneration: string
  outcome: 'applied' | 'rejected' | 'unconfirmed'
  message: string | null
}
export type WorkbenchWindowSnapshot = {
  windows: AppWindowDescriptor[]
  issue: string | null
}

export type WorkbenchWindowDocument = { windowId: string; documentGeneration: string }
