import { parseAppWindowTarget, parseSurveyPageSelection, type AppWindowDescriptor, type AppWindowTarget, type AgentMuxSurveyPresentation } from '@agentmux/core/control'

export const WORKBENCH_WINDOW_REQUEST = 'workbenchWindows:request'
export const WORKBENCH_WINDOW_RESPONSE = 'workbenchWindows:response'
export const WORKBENCH_WINDOW_CHANGED = 'workbenchWindows:changed'

export type WorkbenchWindowRequest = {
  requestId: string
  windowId: string
  documentGeneration: string
  target: AppWindowTarget
  returnContext?: WorkbenchReturnContext | null
} & (
  | { action: 'prepare'; operationId?: string }
  | { action: 'open'; url: string; frameName: string }
  | { action: 'return'; navigate?: boolean }
  | { action: 'focus' }
)
export type WorkbenchWindowResponse = {
  requestId: string
  windowId: string
  documentGeneration: string
  outcome: 'applied' | 'rejected' | 'unconfirmed'
  message: string | null
  returnContext?: WorkbenchReturnContext | null
}
export type WorkbenchWindowSnapshot = {
  windows: AppWindowDescriptor[]
  issue: string | null
}

export type WorkbenchWindowDocument = { windowId: string; documentGeneration: string }

/** Client navigation provenance, separate from the original spatial/window identity. */
export type WorkbenchReturnReference = { displayWorkspaceId: string; groupId: string; tabId: string; regionId: string }
export type WorkbenchReturnSelection = NonNullable<AgentMuxSurveyPresentation['selection']>
export type WorkbenchReturnContext =
  | { surface: 'space' | 'focus'; reference: WorkbenchReturnReference; view: 'tab' | 'region' }
  | { surface: 'survey'; reference: WorkbenchReturnReference; selection: WorkbenchReturnSelection }

/** A failed provenance observation does not take away the original window or Browser. */
export function readWorkbenchReturnContext(value: unknown, target?: AppWindowTarget): WorkbenchReturnContext | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const row = value as Record<string, unknown>
    if (!row.reference || typeof row.reference !== 'object' || Array.isArray(row.reference)) return null
    const { kind: _kind, ...reference } = parseAppWindowTarget({ ...row.reference, kind: 'region' }) as Extract<AppWindowTarget, { kind: 'region' }>
    if (target && (reference.displayWorkspaceId !== target.displayWorkspaceId || reference.groupId !== target.groupId ||
      reference.tabId !== target.tabId || target.kind === 'region' && reference.regionId !== target.regionId)) return null
    if (row.surface === 'space' || row.surface === 'focus') return row.view === 'tab' || row.view === 'region'
      ? { surface: row.surface, reference, view: row.view } : null
    if (row.surface !== 'survey' || !row.selection || typeof row.selection !== 'object' || Array.isArray(row.selection)) return null
    const selected = row.selection as Record<string, unknown>
    if (selected.kind === 'page') return { surface: 'survey', reference, selection: parseSurveyPageSelection(selected) }
    const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value)
    if (!id(selected.zoneId) || !Array.isArray(selected.selection)) return null
    const member = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const row = value as Record<string, unknown>
      return id(row.tabId) && id(row.regionId) ? { tabId: row.tabId, regionId: row.regionId } : null
    }
    const members = selected.selection.map(member)
    if (members.some(value => value === null) || selected.active !== null && !member(selected.active)) return null
    return { surface: 'survey', reference, selection: { zoneId: selected.zoneId,
      selection: members as { tabId: string; regionId: string }[], active: selected.active === null ? null : member(selected.active) } }
  } catch { return null }
}
export function workbenchReturnLabel(context: WorkbenchReturnContext | null | undefined): string {
  return context ? `Return to ${context.surface === 'space' ? 'Space' : context.surface === 'focus' ? 'Focus' : 'Survey'}` : 'Return to original view'
}
