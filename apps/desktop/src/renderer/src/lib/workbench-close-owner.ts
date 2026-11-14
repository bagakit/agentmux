import { AgentMuxError } from '@agentmux/core/control'
import { spaceCloseDigest, type SpaceClosePrepare, type SpaceCloseProjection, type SpaceCloseReceipt } from '@agentmux/core/space-close'
import type { AppState } from '../store'
import { documentKey, removeWorkbenchRegion, workbenchSurfaces } from './workbench-tabs'
import { planWorkbenchViewClose, workbenchRegionCloseTarget, reconcileWorkbenchViewClose, workbenchViewCloseStillApproved,
  browserAgentBinding, closingWorkbenchReservations, type WorkbenchViewClosePlan, type WorkbenchViewCloseSurfaceOwner } from './workbench-view-close'
import { documentLifetime, fileSaveTails } from './file-document-bookkeeping'
import { hasFileDocumentConsumer } from './file-document-consumers'
import { hasNoteComposition } from './note-live-merge'
import { readNoteMarkdownHeader } from '@agentmux/core/note-format'
import { hasRecoverableFileBuffer } from './file-workbench-state'

type State = Pick<AppState, 'tabs' | 'layouts' | 'sessions' | 'documents' | 'dirtyDocuments' | 'documentGenerations' |
  'documentObservationGenerations' | 'savingDocuments' | 'closingWorkbenchViews' | 'config'> & Partial<Pick<AppState, 'documentIssues'>>
const stale = () => new AgentMuxError('The original close target, Run, last View or draft changed. Its current content and healthy work are retained; prepare its current plan.', 'WORKBENCH_CLOSE_STALE')
function originalPlan(state: State, input: SpaceClosePrepare): WorkbenchViewClosePlan {
  const t = input.target, tab = state.tabs[t.tabId], layout = state.layouts[t.displayWorkspaceId]
  if (!tab || !layout?.groups.some(g => g.id === t.groupId && g.tabOrder.includes(t.tabId))) throw stale()
  if (t.kind === 'tab-occurrence') {
    const plan = planWorkbenchViewClose({ tabs: state.tabs, layouts: state.layouts, sessions: state.sessions,
      workspaceId: t.displayWorkspaceId, tabGroupId: t.groupId, tabId: t.tabId, keepAgentSessions: input.keepAgentSessions,
      closing: closingWorkbenchReservations(state.closingWorkbenchViews) })
    if (!plan) throw stale(); return plan
  }
  if (!tab.regions[t.regionId] || !removeWorkbenchRegion(tab, t.regionId)) throw new AgentMuxError('A single Region cannot close its entire Tab. Prepare that exact Tab occurrence instead.', 'WORKBENCH_CLOSE_TARGET_REQUIRED')
  const selected = workbenchRegionCloseTarget({ tabs: state.tabs, sessions: state.sessions, tabId: t.tabId, regionId: t.regionId, keepAgentSessions: input.keepAgentSessions,
    closing: closingWorkbenchReservations(state.closingWorkbenchViews) })
  if (!selected) throw stale()
  return { ...selected, workspaceId: t.displayWorkspaceId, tabGroupId: t.groupId, closesView: true,
    reservedSessionIds: selected.resources.flatMap(r => r.kind === 'session' ? [r.sessionId] : []) }
}
function draftBusy(state: State, workspaceId: string, path: string): boolean {
  const key = documentKey(workspaceId, path), editing = state.documents[key]?.noteEditing
  return state.dirtyDocuments[key] === true && !state.documents[key] || state.savingDocuments[key] === true || fileSaveTails.has(key) || hasNoteComposition(key) || Boolean(editing?.attempt || editing?.input || editing?.share || editing?.shareUndo)
}
function fileWitness(state: State, workspaceId: string, path: string, cache?: Map<string, string>): string {
  const key = documentKey(workspaceId, path), document = state.documents[key], workspace = state.config?.workspaces.find(w => w.id === workspaceId)
  const held = cache?.get(key); if (held !== undefined) return held
  const witness = spaceCloseDigest({ workspace: workspace ? { id: workspace.id, hostId: workspace.hostId, path: workspace.path } : null,
    document: document ?? null, generation: state.documentGenerations[key] ?? null, observation: state.documentObservationGenerations[key] ?? null,
    lifetime: documentLifetime(key), dirty: state.dirtyDocuments[key] === true, issue: state.documentIssues?.[key] ?? null, saving: state.savingDocuments[key] === true,
    consumer: hasFileDocumentConsumer(key), composition: hasNoteComposition(key) })
  cache?.set(key, witness); return witness
}
function surfaceWitness(state: State, plan: WorkbenchViewClosePlan, owner: WorkbenchViewCloseSurfaceOwner, cache?: Map<string, string>): string {
  const surface = state.tabs[plan.tabId]?.regions[owner.regionId]
  const hasOwnStop = plan.surfaces.find(s => s.owner.regionId === owner.regionId)?.resourceKeys.some(k => k.startsWith('session:'))
  return spaceCloseDigest({ owner: owner.kind === 'agent' || owner.kind === 'terminal' ? { ...owner, runId: hasOwnStop ? owner.runId : null } : owner,
    binding: binding(state, plan, owner).binding,
    source: !surface ? null : surface.kind === 'browser' ? { browserId: surface.browserId, navigationId: surface.navigationId, agent: browserAgentBinding(surface) }
      : surface.kind === 'file' ? fileWitness(state, surface.workspaceId, surface.path, cache) : null })
}
function binding(state: State, plan: WorkbenchViewClosePlan, owner: WorkbenchViewCloseSurfaceOwner): Pick<SpaceCloseProjection['surfaces'][number], 'binding' | 'bindingAvailability'> {
  if (owner.kind === 'agent') {
    const session = state.sessions.find(s => s.id === owner.sessionId)
    return session?.control.kind === 'agent' ? { binding: { hostId: session.control.hostId, agentSessionId: session.control.agentSessionId }, bindingAvailability: 'known' }
      : { binding: null, bindingAvailability: 'unconfirmed' }
  }
  const surface = state.tabs[plan.tabId]?.regions[owner.regionId]
  if (surface?.kind === 'browser') {
    const source = browserAgentBinding(surface)
    if (source === undefined) return { binding: null, bindingAvailability: 'unconfirmed' }
    if (source === null) return { binding: null, bindingAvailability: null }
    const original = { hostId: source.hostId, agentSessionId: source.agentSessionId }
    return { binding: original, bindingAvailability: state.sessions.some(s => s.control.kind === 'agent' && s.control.hostId === original.hostId && s.control.agentSessionId === original.agentSessionId) ? 'known' : 'unconfirmed' }
  }
  return { binding: null, bindingAvailability: null }
}
/** Same GUI planner, with frozen machine witnesses. Bodies never leave the original document. */
export function captureWorkbenchClose(state: State, input: SpaceClosePrepare): SpaceCloseProjection {
  const witnesses = new Map<string, string>(), plan = originalPlan(state, input), drafts: SpaceCloseProjection['drafts'] = []
  if (plan.closesView) {
    const closingRegions = new Set(plan.surfaces.map(s => s.owner.regionId))
    const documents = new Map<string, { owner: Extract<WorkbenchViewCloseSurfaceOwner, { kind: 'file' }>; regionIds: string[] }>()
    for (const { owner } of plan.surfaces) if (owner.kind === 'file') {
      const key = documentKey(owner.workspaceId, owner.path), found = documents.get(key)
      if (found) found.regionIds.push(owner.regionId)
      else documents.set(key, { owner, regionIds: [owner.regionId] })
    }
    // One relevant topology pass, independent of how many selected Views share
    // one document. This is a snapshot-local index, never a historical cache.
    const outside = new Set<string>()
    if (documents.size) for (const tab of Object.values(state.tabs)) for (const surface of workbenchSurfaces(tab)) {
      if (surface.kind !== 'file' || tab.id === plan.tabId && closingRegions.has(surface.regionId)) continue
      const key = documentKey(surface.workspaceId, surface.path)
      if (documents.has(key)) outside.add(key)
    }
    const workspaces = new Map(state.config?.workspaces.map(w => [w.id, w]) ?? [])
    for (const [key, { owner, regionIds }] of documents) {
      const document = state.documents[key]
      if (!document || !state.dirtyDocuments[key] && !hasRecoverableFileBuffer(document, state.documentIssues?.[key]) || outside.has(key) || hasFileDocumentConsumer(key) || document.noteEditing?.share || document.noteEditing?.shareUndo) continue
      const header = readNoteMarkdownHeader(document.content)
      if (header.status === 'valid' && header.kind === 'shared-block') continue
      const workspace = workspaces.get(owner.workspaceId)
      if (!workspace) throw stale()
      drafts.push({ document: { hostId: workspace.hostId, workspaceId: workspace.id, path: owner.path, noteId: header.status === 'valid' ? header.noteId : null },
        witness: fileWitness(state, owner.workspaceId, owner.path, witnesses), regionIds })
    }
  }
  return { ...plan, surfaces: plan.surfaces.map(s => ({ owner: { ...s.owner }, resourceKeys: [...s.resourceKeys], witness: surfaceWitness(state, plan, s.owner, witnesses), ...binding(state, plan, s.owner),
    blocker: s.owner.kind === 'file' && draftBusy(state, s.owner.workspaceId, s.owner.path) ? 'draft-busy' : (s.owner.kind === 'agent' || s.owner.kind === 'terminal') && s.owner.phase === 'attached' && s.owner.runId === null && plan.closesView && (s.owner.kind === 'terminal' || !input.keepAgentSessions) ? 'session-unconfirmed' : null })),
    resources: structuredClone([...plan.resources]), reservedSessionIds: [...plan.reservedSessionIds], drafts, otherOccurrences: Object.entries(state.layouts).flatMap(([displayWorkspaceId, layout]) => layout.groups.flatMap(g => g.tabOrder.includes(plan.tabId) && (displayWorkspaceId !== plan.workspaceId || g.id !== plan.tabGroupId) ? [{ displayWorkspaceId, groupId: g.id }] : [])) }
}
function plannerProjection(record: SpaceCloseReceipt): WorkbenchViewClosePlan {
  // The strict shared codec has already checked these exact resource-key forms.
  return record.plan.projection as WorkbenchViewClosePlan
}
/** Immediately before every child, not only before the first external await. */
export function validateWorkbenchClose(state: State, record: SpaceCloseReceipt, resourceKey?: string): void {
  const witnesses = new Map<string, string>(), approved = plannerProjection(record), current = originalPlan(state, record.request)
  if (!workbenchViewCloseStillApproved(approved, current, state.tabs[approved.tabId])) throw stale()
  const relevant = resourceKey === undefined ? approved.surfaces.filter(s => record.plan.projection.surfaces.find(p => p.owner.regionId === s.owner.regionId)?.blocker !== 'draft-busy') : approved.surfaces.filter(s => s.resourceKeys.includes(resourceKey as never))
  if (resourceKey && !current.resources.some(r => r.key === resourceKey)) throw stale()
  for (const surface of relevant) {
    const frozen = record.plan.projection.surfaces.find(s => s.owner.regionId === surface.owner.regionId)!
    const now = current.surfaces.find(s => s.owner.regionId === surface.owner.regionId)
    if (!now || frozen.blocker === 'draft-busy' || frozen.blocker === 'session-unconfirmed' && frozen.bindingAvailability !== 'unconfirmed' || now.owner.kind === 'file' && draftBusy(state, now.owner.workspaceId, now.owner.path) || surfaceWitness(state, approved, now.owner, witnesses) !== frozen.witness) throw stale()
  }
}
/** Call inside the one original state transaction: external waits can never consume new dirty input. */
export function reconcileWorkbenchClose(state: State, record: SpaceCloseReceipt): { plan: WorkbenchViewClosePlan; tab: AppState['tabs'][string] | null } {
  const approved = plannerProjection(record), currentTab = state.tabs[approved.tabId]
  if (!approved.closesView) { validateWorkbenchClose(state, record); return { plan: approved, tab: null } }
  let current: WorkbenchViewClosePlan | undefined
  try { current = originalPlan(state, record.request) } catch { /* The original surface may already be gone; no replacement is adopted. */ }
  if (!current || !current.closesView) return { plan: approved, tab: currentTab ?? null }
  const witnesses = new Map<string, string>()
  const acknowledgedWithoutProjection = new Set<string>()
  const eligible = approved.surfaces.filter(s => {
    const frozen = record.plan.projection.surfaces.find(p => p.owner.regionId === s.owner.regionId)!, now = current?.surfaces.find(p => p.owner.regionId === s.owner.regionId)
    if (!now || frozen.blocker === 'draft-busy' || frozen.blocker === 'session-unconfirmed' && frozen.bindingAvailability !== 'unconfirmed' || now.owner.kind === 'file' && draftBusy(state, now.owner.workspaceId, now.owner.path)) return false
    if (surfaceWitness(state, approved, now.owner, witnesses) === frozen.witness) return true
    // An exact original ACK can retire the Session projection before the View
    // consumes it. Absence alone proves nothing, and a present successor never
    // enters this branch. Keep the real surface/source and original child fence.
    const owner = s.owner, actual = now.owner
    if ((owner.kind !== 'agent' && owner.kind !== 'terminal') || actual.kind !== owner.kind || actual.phase !== owner.phase || actual.sessionId !== owner.sessionId ||
      state.sessions.some(session => session.id === owner.sessionId)) return false
    const resource = approved.resources.find(r => r.kind === 'session' && r.sessionId === owner.sessionId && s.resourceKeys.includes(r.key))
    if (resource?.kind !== 'session' || resource.control.kind !== owner.kind || resource.control.run.runId !== owner.runId ||
      resource.control.kind === 'agent' && (frozen.binding?.hostId !== resource.control.hostId || frozen.binding.agentSessionId !== resource.control.agentSessionId)) return false
    const result = record.resources.find(r => r.key === resource.key)
    if (result?.outcome !== 'acknowledged' || !result.receipt) return false
    acknowledgedWithoutProjection.add(owner.regionId)
    return true
  })
  const result = reconcileWorkbenchViewClose({ plan: { ...approved, surfaces: eligible.map(s => acknowledgedWithoutProjection.has(s.owner.regionId) && (s.owner.kind === 'agent' || s.owner.kind === 'terminal') ? { ...s, owner: { ...s.owner, runId: null } } : s) }, currentTab, currentSessions: state.sessions,
    receipts: record.resources.map(r => ({ key: r.key as never, status: r.outcome === 'acknowledged' ? 'fulfilled' : 'rejected' })) })
  return { plan: approved, tab: result.tab }
}

/** Both GUI choices are prepared before confirmation; Keep cannot consume a newer draft or binding. */
export function samePreparedCloseReview(left: SpaceCloseReceipt, right: SpaceCloseReceipt): boolean {
  const a = left.plan.projection, b = right.plan.projection
  const occurrences = (p: SpaceCloseProjection) => p.otherOccurrences.map(spaceCloseDigest).sort()
  return spaceCloseDigest(left.plan.authority) === spaceCloseDigest(right.plan.authority) && spaceCloseDigest(left.plan.target) === spaceCloseDigest(right.plan.target) &&
    a.workspaceId === b.workspaceId && a.tabGroupId === b.tabGroupId && a.tabId === b.tabId && a.closesView === b.closesView &&
    a.surfaces.length === b.surfaces.length && spaceCloseDigest(occurrences(a)) === spaceCloseDigest(occurrences(b)) &&
    spaceCloseDigest(a.drafts) === spaceCloseDigest(b.drafts) &&
    left.plan.projection.surfaces.every(surface => {
      const other = right.plan.projection.surfaces.find(s => s.owner.regionId === surface.owner.regionId)
      return other && spaceCloseDigest(surface.binding) === spaceCloseDigest(other.binding) &&
        (surface.owner.kind === 'agent' ? other.owner.kind === 'agent' && surface.owner.sessionId === other.owner.sessionId && surface.owner.phase === other.owner.phase
          : surface.witness === other.witness)
    })
}
