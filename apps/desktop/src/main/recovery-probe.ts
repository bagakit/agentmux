/**
 * Small, read-only projections used by the real Electron restart probe.
 *
 * The probe must inspect the same durable records the application reads. It must not create a second
 * layout or Session store just for verification, so this module only parses the persisted Zustand
 * projection and the Core-owned Session store and returns identity-bearing summaries.
 */

export type RecoveryWorkbenchSummary = {
  storagePresent: boolean
  tabIds: string[]
  regionIds: string[]
  activeRegionIds: string[]
  activeWorkspaceId: string | null
  draftSessionIds: string[]
  drafts: Record<string, string>
  executionFocusSessionId: string | null
  executionFocusHistory: string[]
  pmoFocusSessionId: string | null
}

export type RecoverySessionSummary = {
  storePresent: boolean
  sessions: Array<{
    agentSessionId: string
    runId: string | null
    providerId: string | null
    nativeSessionId: string | null
  }>
}

export type RecoveryIdentity = {
  userData: string
  runtimeDirectory: string
  tabIds: string[]
  regionIds: string[]
  activeRegionIds: string[]
  activeWorkspaceId: string | null
  draftSessionIds: string[]
  drafts: Record<string, string>
  executionFocusSessionId: string | null
  executionFocusHistory: string[]
  pmoFocusSessionId: string | null
  sessionIds: string[]
  runIds: string[]
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

export function summarizeRecoveryStorage(raw: string | null): RecoveryWorkbenchSummary {
  if (raw === null) {
    return {
      storagePresent: false,
      tabIds: [],
      regionIds: [],
      activeRegionIds: [],
      activeWorkspaceId: null,
      draftSessionIds: [],
      drafts: {},
      executionFocusSessionId: null,
      executionFocusHistory: [],
      pmoFocusSessionId: null
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      storagePresent: true,
      tabIds: [],
      regionIds: [],
      activeRegionIds: [],
      activeWorkspaceId: null,
      draftSessionIds: [],
      drafts: {},
      executionFocusSessionId: null,
      executionFocusHistory: [],
      pmoFocusSessionId: null
    }
  }
  const state = objectRecord(objectRecord(parsed).state)
  const workbench = objectRecord(state.restoredWorkbench)
  const tabs = objectRecord(workbench.tabs)
  const tabIds = sortedStrings(Object.keys(tabs))
  const regionIds = sortedStrings(Object.values(tabs).flatMap((tab) => Object.keys(objectRecord(objectRecord(tab).regions))))
  const activeRegionIds = sortedStrings(Object.values(tabs).flatMap((tab) => {
    const activeRegionId = stringValue(objectRecord(tab).layout && objectRecord(objectRecord(tab).layout).activeRegionId)
    return activeRegionId ? [activeRegionId] : []
  }))
  const rawDrafts = objectRecord(state.agentComposerDrafts)
  const drafts = Object.fromEntries(Object.entries(rawDrafts).flatMap(([sessionId, draft]) => (
    typeof draft === 'string' ? [[sessionId, draft] as const] : []
  )))
  const agentFocus = objectRecord(state.agentFocus)
  const execution = objectRecord(agentFocus.execution)
  const history = Array.isArray(execution.history)
    ? execution.history.flatMap((entry) => {
        const value = objectRecord(entry)
        return stringValue(value.sessionId) ? [stringValue(value.sessionId)!] : []
      })
    : []
  const pmo = objectRecord(agentFocus.pmo)
  return {
    storagePresent: true,
    tabIds,
    regionIds,
    activeRegionIds,
    activeWorkspaceId: stringValue(state.activeWorkspaceId),
    draftSessionIds: sortedStrings(Object.keys(drafts)),
    drafts,
    executionFocusSessionId: stringValue(execution.sessionId),
    executionFocusHistory: history,
    pmoFocusSessionId: stringValue(pmo.sessionId)
  }
}

export function summarizeRecoverySessionStore(raw: string | null): RecoverySessionSummary {
  if (raw === null) return { storePresent: false, sessions: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { storePresent: true, sessions: [] }
  }
  const rawSessions = objectRecord(parsed).sessions
  const sessions = (Array.isArray(rawSessions) ? rawSessions : []).flatMap((value) => {
    const session = objectRecord(value)
    const agentSessionId = stringValue(session.agentSessionId)
    if (!agentSessionId) return []
    const run = objectRecord(session.run)
    const nativeHandle = objectRecord(session.nativeHandle)
    return [{
      agentSessionId,
      runId: stringValue(run.runId),
      providerId: stringValue(session.providerId),
      nativeSessionId: stringValue(nativeHandle.sessionId)
    }]
  })
  return {
    storePresent: true,
    sessions: sessions.sort((left, right) => left.agentSessionId.localeCompare(right.agentSessionId))
  }
}

export function recoveryIdentityFromReport(report: {
  userData: string
  runtimeDirectory: string
  workbench: RecoveryWorkbenchSummary
  sessions: RecoverySessionSummary
}): RecoveryIdentity {
  return {
    userData: report.userData,
    runtimeDirectory: report.runtimeDirectory,
    tabIds: report.workbench.tabIds,
    regionIds: report.workbench.regionIds,
    activeRegionIds: report.workbench.activeRegionIds,
    activeWorkspaceId: report.workbench.activeWorkspaceId,
    draftSessionIds: report.workbench.draftSessionIds,
    drafts: report.workbench.drafts,
    executionFocusSessionId: report.workbench.executionFocusSessionId,
    executionFocusHistory: report.workbench.executionFocusHistory,
    pmoFocusSessionId: report.workbench.pmoFocusSessionId,
    sessionIds: report.sessions.sessions.map((session) => session.agentSessionId),
    runIds: report.sessions.sessions.flatMap((session) => session.runId ? [session.runId] : [])
  }
}

export function recoveryIdentityMatches(
  before: RecoveryIdentity,
  after: RecoveryIdentity
): boolean {
  return JSON.stringify(before) === JSON.stringify(after)
}
