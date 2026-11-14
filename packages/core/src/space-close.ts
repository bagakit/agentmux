import { sha256 } from '@noble/hashes/sha2.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString, rpcCount } from './rpc-data.js'
import { parseTerminalControl, parseTerminalControlResult, type TerminalControlRequest, type TerminalControlReceipt } from './terminal-control.js'
import { parseAgentStopReceipt, type AgentMuxAgentStopReceipt } from './agent-stop-receipt.js'

/** Client-owned workface close: these are frozen references, never a second layout or Runtime. */
export type SpaceCloseTarget = { kind: 'tab-occurrence'; displayWorkspaceId: string; groupId: string; tabId: string }
  | { kind: 'region'; displayWorkspaceId: string; groupId: string; tabId: string; regionId: string }
export type SpaceCloseActor = { kind: 'user' | 'device'; id: string } | { kind: 'agent'; id: string; hostId: string }
export type SpaceCloseControl = { kind: 'agent'; hostId: string; agentSessionId: string; run: { runId: string } }
  | { kind: 'terminal'; hostId: string; runId: string; run: { runId: string } }
export type SpaceCloseSurfaceOwner =
  | { regionId: string; kind: 'agent' | 'terminal'; phase: 'launching' | 'attached'; sessionId: string; runId: string | null }
  | { regionId: string; kind: 'browser'; browserId: string }
  | { regionId: string; kind: 'file'; workspaceId: string; path: string }
  | { regionId: string; kind: 'launcher' }
  | { regionId: string; kind: 'git' | 'git-diff'; identity: string }
export type SpaceCloseResource = { key: string; kind: 'session'; sessionId: string; control: SpaceCloseControl }
  | { key: string; kind: 'browser'; browserId: string }
export type SpaceCloseDocument = { hostId: string; workspaceId: string; path: string; noteId: string | null }
export type SpaceCloseDraft = { document: SpaceCloseDocument; witness: string; regionIds: string[] }
export type SpaceCloseProjection = { workspaceId: string; tabGroupId: string; tabId: string; closesView: boolean;
  surfaces: Array<{ owner: SpaceCloseSurfaceOwner; resourceKeys: string[]; witness: string; blocker: 'session-unconfirmed' | 'draft-busy' | null; binding: { hostId: string; agentSessionId: string } | null; bindingAvailability: 'known' | 'unconfirmed' | null }>;
  resources: SpaceCloseResource[]; reservedSessionIds: string[]; drafts: SpaceCloseDraft[]; otherOccurrences: Array<{ displayWorkspaceId: string; groupId: string }> }
export type SpaceClosePlan = { authority: { ownerId: string; endpoint: string; documentGeneration: string }; target: SpaceCloseTarget;
  keepAgentSessions: boolean; projection: SpaceCloseProjection;
  children: Array<{ key: string; operationId: string; terminal: Extract<TerminalControlRequest, { action: 'terminal-stop' | 'terminal-interrupt' }> | null; issue: 'native-unconfirmed' | null }> }
export type SpaceCloseDecision = { action: 'discard'; document: SpaceCloseDocument; expectedDraft: string }
  | { action: 'close-view-only'; regionId: string; expectedWitness: string } | { action: 'stop'; control: SpaceCloseControl } | { action: 'close-browser'; browserId: string }
export type SpaceClosePrepare = { operationId: string; target: SpaceCloseTarget; keepAgentSessions: boolean }
export type SpaceCloseApply = { operationId: string; expectedPlanDigest: string; decisions: SpaceCloseDecision[] }
export type SpaceCloseInspect = { operationId: string }
export type SpaceCloseListParams = { limit?: number; cursor?: { ownerId: string; actorScope: string; afterMember: string } }
export type SpaceCloseSummary = { operationId: string; target: SpaceCloseTarget; preparedBy: SpaceCloseActor; phase: 'prepared' | 'applying' | 'settled' | 'unconfirmed'; outcome: SpaceCloseReceipt['outcome']; preparedAt: number; updatedAt: number; planDigest: string; diskDurability: 'confirmed' | 'unconfirmed' }
export type SpaceCloseList = { ownerId: string; observedAt: number; coverage: 'live-page'; availability: 'complete' | 'partial'; items: SpaceCloseSummary[];
  nextCursor: NonNullable<SpaceCloseListParams['cursor']> | null; issues: Array<{ code: 'member-unconfirmed'; member: string | null }> }

export type SpaceCloseResourceResult = { key: string; operationId: string; outcome: 'pending' | 'acknowledged' | 'unknown' | 'not-applied';
  receipt: TerminalControlReceipt | AgentMuxAgentStopReceipt | { kind: 'browser-closed'; browserId: string } | null; issue?: string }
export type SpaceCloseSave = { layoutApplied: boolean; clientStateWritten: boolean; storageFlushRequested: boolean; diskDurability: 'confirmed' | 'unconfirmed'; reason: string | null }
export type SpaceCloseProjectionResult = { applied: boolean; removedRegions: string[]; retainedRegions: string[]; save: SpaceCloseSave | null }
export type SpaceCloseCommitResult = { clientProjection: SpaceCloseProjectionResult; spatialContribution: { save: SpaceCloseSave | null } }
export type SpaceCloseReceipt = { operationId: string; request: SpaceClosePrepare; plan: SpaceClosePlan; planDigest: string;
  preparedBy: SpaceCloseActor; approvedBy: SpaceCloseActor | null; decisions: SpaceCloseDecision[];
  phase: 'prepared' | 'applying' | 'settled'; outcome: 'prepared' | 'applied' | 'partial' | 'unknown' | 'not-applied';
  resources: SpaceCloseResourceResult[]; clientProjection: SpaceCloseProjectionResult; spatialContribution: { save: SpaceCloseSave | null };
  preparedAt: number; updatedAt: number; diskDurability: 'confirmed' | 'unconfirmed'; issue?: string }
export const SPACE_CLOSE_METHODS = { 'space.close.ls': 'short', 'space.close.prepare': 'long', 'space.close.apply': 'long', 'space.close.inspect': 'short' } as const
export type SpaceCloseMethod = keyof typeof SPACE_CLOSE_METHODS
export type SpaceCloseParams = { 'space.close.ls': SpaceCloseListParams; 'space.close.prepare': SpaceClosePrepare; 'space.close.apply': SpaceCloseApply; 'space.close.inspect': SpaceCloseInspect }
export type SpaceCloseResults = { [M in Exclude<SpaceCloseMethod, 'space.close.ls'>]: { operation: SpaceCloseReceipt | null } } & { 'space.close.ls': SpaceCloseList }
export type SpaceCloseContext = { actor: SpaceCloseActor; originalContext: import('./public-rpc-service.js').AgentMuxRpcCallContext; assertCurrent?(): void | Promise<void>; signal?: AbortSignal }
export type SpaceClosePort = { call<M extends SpaceCloseMethod>(method: M, input: SpaceCloseParams[M], context: SpaceCloseContext): Promise<SpaceCloseResults[M]> }
function invalid(): never { throw new AgentMuxError('The original workface close facts are unconfirmed. Keep the original plan, drafts and operation ID.', 'CONTROL_PROTOCOL_ERROR') }
const member = (v: unknown, values: readonly string[]): v is string => typeof v === 'string' && values.includes(v)
const text = (v: unknown): string => rpcString(v, 'Original workface close reference')
const bool = (v: unknown): boolean => { if (typeof v !== 'boolean') invalid(); return v }
const list = <T>(v: unknown, parse: (item: unknown) => T): T[] => { if (!Array.isArray(v) || v.length > 512) invalid(); return v.map(parse) }
const strings = (v: unknown): string[] => list(v, text)
const unique = (v: readonly string[]) => { if (new Set(v).size !== v.length) invalid() }
export const spaceCloseDigest = (v: unknown): string => 'sha256:' + Array.from(sha256(new TextEncoder().encode(JSON.stringify(v))), b => b.toString(16).padStart(2, '0')).join('')
export function parseSpaceCloseActor(value: unknown): SpaceCloseActor {
  const p = rpcRecord(value), kind = p.kind
  if (kind === 'agent') { rpcRecord(p, ['kind', 'id', 'hostId']); return { kind, id: text(p.id), hostId: text(p.hostId) } }
  rpcRecord(p, ['kind', 'id']); if (kind !== 'user' && kind !== 'device') invalid()
  return { kind, id: text(p.id) }
}
export function parseSpaceCloseTarget(value: unknown): SpaceCloseTarget {
  const p = rpcRecord(value, ['kind', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'])
  const common = { displayWorkspaceId: text(p.displayWorkspaceId), groupId: text(p.groupId), tabId: text(p.tabId) }
  if (p.kind === 'region') return { kind: 'region', ...common, regionId: text(p.regionId) }
  if (p.kind !== 'tab-occurrence' || p.regionId !== undefined) throw new AgentMuxError('Choose one exact Tab occurrence or Region; a Region close never expands to its Tab.', 'INVALID_CONTROL_REQUEST')
  return { kind: 'tab-occurrence', ...common }
}
export function parseSpaceCloseControl(value: unknown): SpaceCloseControl {
  const p = rpcRecord(value, ['kind', 'hostId', 'agentSessionId', 'runId', 'run']), run = rpcRecord(p.run, ['runId'])
  const common = { hostId: text(p.hostId), run: { runId: text(run.runId) } }
  if (p.kind === 'agent' && p.runId === undefined) return { kind: 'agent', ...common, agentSessionId: text(p.agentSessionId) }
  if (p.kind !== 'terminal' || p.agentSessionId !== undefined || p.runId !== run.runId) invalid()
  return { kind: 'terminal', ...common, runId: text(p.runId) }
}
function document(value: unknown): SpaceCloseDocument {
  const p = rpcRecord(value, ['hostId', 'workspaceId', 'path', 'noteId'])
  if (typeof p.path !== 'string' || !p.path || p.path.includes('\0')) invalid()
  return { hostId: text(p.hostId), workspaceId: text(p.workspaceId), path: p.path, noteId: p.noteId === null ? null : text(p.noteId) }
}
export function parseSpaceCloseDecision(value: unknown): SpaceCloseDecision {
  const p = rpcRecord(value)
  if (p.action === 'discard') { rpcRecord(p, ['action', 'document', 'expectedDraft']); return { action: 'discard', document: document(p.document), expectedDraft: text(p.expectedDraft) } }
  if (p.action === 'close-view-only') { rpcRecord(p, ['action', 'regionId', 'expectedWitness']); return { action: 'close-view-only', regionId: text(p.regionId), expectedWitness: text(p.expectedWitness) } }
  if (p.action === 'stop') { rpcRecord(p, ['action', 'control']); return { action: 'stop', control: parseSpaceCloseControl(p.control) } }
  if (p.action !== 'close-browser') invalid()
  rpcRecord(p, ['action', 'browserId']); return { action: 'close-browser', browserId: text(p.browserId) }
}
export function spaceCloseDecisions(plan: SpaceClosePlan): SpaceCloseDecision[] {
  return [...plan.projection.surfaces.filter(s => plan.projection.closesView && s.bindingAvailability === 'unconfirmed').map(s => ({ action: 'close-view-only' as const, regionId: s.owner.regionId, expectedWitness: s.witness })), ...plan.projection.drafts.map(d => ({ action: 'discard' as const, document: d.document, expectedDraft: d.witness })),
    ...plan.projection.resources.map(r => r.kind === 'browser' ? { action: 'close-browser' as const, browserId: r.browserId } : { action: 'stop' as const, control: r.control })]
}
export function parseSpaceCloseListParams(value: unknown): SpaceCloseListParams {
  const p = rpcRecord(value, ['limit', 'cursor'])
  const cursor = p.cursor === undefined ? undefined : (() => {
    const c = rpcRecord(p.cursor, ['ownerId', 'actorScope', 'afterMember'])
    if (typeof c.afterMember !== 'string' || !/^[a-f0-9]{64}$/u.test(c.afterMember)) invalid()
    return { ownerId: text(c.ownerId), actorScope: text(c.actorScope), afterMember: c.afterMember }
  })()
  const limit = rpcCount(p.limit, 25, 100); if (limit < 1) throw new AgentMuxError('Close page limit must be between one and one hundred.', 'INVALID_CONTROL_REQUEST')
  return { limit, ...(cursor ? { cursor } : {}) }
}
export function parseSpaceCloseParams<M extends SpaceCloseMethod>(method: M, value: unknown): SpaceCloseParams[M] {
  if (method === 'space.close.ls') return parseSpaceCloseListParams(value) as SpaceCloseParams[M]
  const p = rpcRecord(value, method === 'space.close.prepare' ? ['operationId', 'target', 'keepAgentSessions'] : method === 'space.close.apply' ? ['operationId', 'expectedPlanDigest', 'decisions'] : ['operationId'])
  const operationId = text(p.operationId)
  if (method === 'space.close.prepare') return { operationId, target: parseSpaceCloseTarget(p.target), keepAgentSessions: bool(p.keepAgentSessions) } as SpaceCloseParams[M]
  if (method === 'space.close.apply') return { operationId, expectedPlanDigest: text(p.expectedPlanDigest), decisions: list(p.decisions, parseSpaceCloseDecision) } as SpaceCloseParams[M]
  return { operationId } as SpaceCloseParams[M]
}
function owner(value: unknown): SpaceCloseSurfaceOwner {
  const p = rpcRecord(value), common = { regionId: text(p.regionId) }
  if (p.kind === 'agent' || p.kind === 'terminal') {
    rpcRecord(p, ['regionId', 'kind', 'phase', 'sessionId', 'runId']); if (!member(p.phase, ['launching', 'attached'])) invalid()
    return { ...common, kind: p.kind, phase: p.phase as 'launching' | 'attached', sessionId: text(p.sessionId), runId: p.runId === null ? null : text(p.runId) }
  }
  if (p.kind === 'browser') { rpcRecord(p, ['regionId', 'kind', 'browserId']); return { ...common, kind: 'browser', browserId: text(p.browserId) } }
  if (p.kind === 'file') { rpcRecord(p, ['regionId', 'kind', 'workspaceId', 'path']); if (typeof p.path !== 'string' || !p.path || p.path.includes('\0')) invalid(); return { ...common, kind: 'file', workspaceId: text(p.workspaceId), path: p.path } }
  if (p.kind === 'git' || p.kind === 'git-diff') { rpcRecord(p, ['regionId', 'kind', 'identity']); return { ...common, kind: p.kind, identity: text(p.identity) } }
  if (p.kind !== 'launcher') invalid(); rpcRecord(p, ['regionId', 'kind']); return { ...common, kind: 'launcher' }
}
export function parseSpaceCloseProjection(value: unknown): SpaceCloseProjection {
  const p = rpcRecord(value, ['workspaceId', 'tabGroupId', 'tabId', 'closesView', 'surfaces', 'resources', 'reservedSessionIds', 'drafts', 'otherOccurrences'])
  const resources = list(p.resources, value => {
    const r = rpcRecord(value)
    if (r.kind === 'browser') { rpcRecord(r, ['key', 'kind', 'browserId']); if (r.key !== `browser:${r.browserId}`) invalid(); return { key: text(r.key), kind: 'browser' as const, browserId: text(r.browserId) } }
    rpcRecord(r, ['key', 'kind', 'sessionId', 'control']); if (r.kind !== 'session' || r.key !== `session:${r.sessionId}`) invalid()
    return { key: text(r.key), kind: 'session' as const, sessionId: text(r.sessionId), control: parseSpaceCloseControl(r.control) }
  })
  const surfaces = list(p.surfaces, value => {
    const s = rpcRecord(value, ['owner', 'resourceKeys', 'witness', 'blocker', 'binding', 'bindingAvailability'])
    if (s.blocker !== null && s.blocker !== 'session-unconfirmed' && s.blocker !== 'draft-busy' || s.bindingAvailability !== null && s.bindingAvailability !== 'known' && s.bindingAvailability !== 'unconfirmed') invalid()
    const b = s.binding === null ? null : rpcRecord(s.binding, ['hostId', 'agentSessionId'])
    return { owner: owner(s.owner), resourceKeys: strings(s.resourceKeys), witness: text(s.witness), blocker: s.blocker as 'session-unconfirmed' | 'draft-busy' | null,
      binding: b ? { hostId: text(b.hostId), agentSessionId: text(b.agentSessionId) } : null, bindingAvailability: s.bindingAvailability as 'known' | 'unconfirmed' | null }
  })
  unique(resources.map(r => r.key)); unique(surfaces.map(s => s.owner.regionId))
  for (const s of surfaces) { unique(s.resourceKeys); if (s.resourceKeys.some(k => !resources.some(r => r.key === k))) invalid() }
  const drafts = list(p.drafts, value => { const d = rpcRecord(value, ['document', 'witness', 'regionIds']); const regionIds = strings(d.regionIds); unique(regionIds); if (regionIds.some(id => !surfaces.some(s => s.owner.regionId === id && s.owner.kind === 'file'))) invalid(); return { document: document(d.document), witness: text(d.witness), regionIds } })
  return { workspaceId: text(p.workspaceId), tabGroupId: text(p.tabGroupId), tabId: text(p.tabId), closesView: bool(p.closesView), surfaces, resources, reservedSessionIds: strings(p.reservedSessionIds), drafts, otherOccurrences: list(p.otherOccurrences, value => { const o = rpcRecord(value, ['displayWorkspaceId', 'groupId']); return { displayWorkspaceId: text(o.displayWorkspaceId), groupId: text(o.groupId) } }) }
}
export function parseSpaceClosePlan(value: unknown): SpaceClosePlan {
  const p = rpcRecord(value, ['authority', 'target', 'keepAgentSessions', 'projection', 'children']), a = rpcRecord(p.authority, ['ownerId', 'endpoint', 'documentGeneration'])
  const target = parseSpaceCloseTarget(p.target), projection = parseSpaceCloseProjection(p.projection)
  if (projection.workspaceId !== target.displayWorkspaceId || projection.tabGroupId !== target.groupId || projection.tabId !== target.tabId ||
    target.kind === 'region' && (projection.surfaces.length !== 1 || projection.surfaces[0]!.owner.regionId !== target.regionId || !projection.closesView)) invalid()
  const children = list(p.children, value => {
    const c = rpcRecord(value, ['key', 'operationId', 'terminal', 'issue']), resource = projection.resources.find(r => r.key === c.key)
    if (!resource) invalid()
    const terminal = c.terminal === null ? null : parseTerminalControl(c.terminal)
    if (resource.kind === 'session' && resource.control.kind === 'terminal') {
      if (terminal ? terminal.action !== 'terminal-stop' || terminal.operationId !== c.operationId || terminal.target.hostId !== resource.control.hostId || terminal.target.run.runId !== resource.control.run.runId || c.issue !== null : c.issue !== 'native-unconfirmed') invalid()
    } else if (terminal || c.issue !== null) invalid()
    return { key: text(c.key), operationId: text(c.operationId), terminal: terminal as SpaceClosePlan['children'][number]['terminal'], issue: c.issue as SpaceClosePlan['children'][number]['issue'] }
  })
  unique(children.map(c => c.key)); unique(children.map(c => c.operationId)); if (children.length !== projection.resources.length) invalid()
  return { authority: { ownerId: text(a.ownerId), endpoint: text(a.endpoint), documentGeneration: text(a.documentGeneration) }, target, keepAgentSessions: bool(p.keepAgentSessions), projection, children }
}
function save(value: unknown): SpaceCloseSave | null {
  if (value === null) return null
  const s = rpcRecord(value, ['layoutApplied', 'clientStateWritten', 'storageFlushRequested', 'diskDurability', 'reason'])
  if (!member(s.diskDurability, ['confirmed', 'unconfirmed']) || s.reason !== null && typeof s.reason !== 'string') invalid()
  return { layoutApplied: bool(s.layoutApplied), clientStateWritten: bool(s.clientStateWritten), storageFlushRequested: bool(s.storageFlushRequested), diskDurability: s.diskDurability as SpaceCloseSave['diskDurability'], reason: s.reason as string | null }
}
export function parseSpaceCloseProjectionResult(value: unknown): SpaceCloseProjectionResult {
  const p = rpcRecord(value, ['applied', 'removedRegions', 'retainedRegions', 'save'])
  const removedRegions = strings(p.removedRegions), retainedRegions = strings(p.retainedRegions); unique([...removedRegions, ...retainedRegions])
  return { applied: bool(p.applied), removedRegions, retainedRegions, save: save(p.save) }
}
export function parseSpaceCloseCommitResult(value: unknown): SpaceCloseCommitResult {
  const p = rpcRecord(value, ['clientProjection', 'spatialContribution']), spatial = rpcRecord(p.spatialContribution, ['save'])
  return { clientProjection: parseSpaceCloseProjectionResult(p.clientProjection), spatialContribution: { save: save(spatial.save) } }
}
export function parseSpaceCloseReceipt(value: unknown): SpaceCloseReceipt {
  const p = rpcRecord(value, ['operationId', 'request', 'plan', 'planDigest', 'preparedBy', 'approvedBy', 'decisions', 'phase', 'outcome', 'resources', 'clientProjection', 'spatialContribution', 'preparedAt', 'updatedAt', 'diskDurability', 'issue'])
  const request = parseSpaceCloseParams('space.close.prepare', p.request), plan = parseSpaceClosePlan(p.plan), preparedBy = parseSpaceCloseActor(p.preparedBy), approvedBy = p.approvedBy === null ? null : parseSpaceCloseActor(p.approvedBy)
  if (request.operationId !== p.operationId || JSON.stringify(request.target) !== JSON.stringify(plan.target) || request.keepAgentSessions !== plan.keepAgentSessions || !Number.isSafeInteger(p.preparedAt) || !Number.isSafeInteger(p.updatedAt) || Number(p.preparedAt) < 0 || Number(p.updatedAt) < Number(p.preparedAt) || p.planDigest !== spaceCloseDigest(plan) ||
    !member(p.phase, ['prepared', 'applying', 'settled']) || !member(p.outcome, ['prepared', 'applied', 'partial', 'unknown', 'not-applied']) || !member(p.diskDurability, ['confirmed', 'unconfirmed']) || approvedBy?.kind === 'agent' ||
    p.phase === 'prepared' && (!['prepared', 'unknown'].includes(p.outcome as string) || approvedBy !== null) || p.phase !== 'prepared' && !approvedBy || p.issue !== undefined && typeof p.issue !== 'string') invalid()
  const decisions = list(p.decisions, parseSpaceCloseDecision)
  const resources = list(p.resources, value => {
    const r = rpcRecord(value, ['key', 'operationId', 'outcome', 'receipt', 'issue']), child = plan.children.find(c => c.key === r.key), resource = plan.projection.resources.find(c => c.key === r.key)
    if (!child || !resource || r.operationId !== child.operationId || !member(r.outcome, ['pending', 'acknowledged', 'unknown', 'not-applied']) || r.issue !== undefined && typeof r.issue !== 'string') invalid()
    let receipt: SpaceCloseResourceResult['receipt'] = null
    if (r.receipt !== null) {
      if (resource.kind === 'browser') { const b = rpcRecord(r.receipt, ['kind', 'browserId']); if (b.kind !== 'browser-closed' || b.browserId !== resource.browserId) invalid(); receipt = { kind: 'browser-closed', browserId: resource.browserId } }
      else if (resource.control.kind === 'terminal') { if (!child.terminal) invalid(); receipt = parseTerminalControlResult(r.receipt, child.terminal) }
      else { receipt = parseAgentStopReceipt(r.receipt, { agentSessionId: resource.control.agentSessionId }); if (receipt.expectedRun.runId !== resource.control.run.runId || receipt.admission === 'new' && receipt.operationId !== child.operationId) invalid() }
    }
    if (r.outcome === 'acknowledged' && (receipt === null || 'action' in receipt && !['applied', 'no-op'].includes(receipt.outcome))) invalid()
    return { key: text(r.key), operationId: text(r.operationId), outcome: r.outcome as SpaceCloseResourceResult['outcome'], receipt, ...(r.issue === undefined ? {} : { issue: r.issue as string }) }
  })
  unique(resources.map(r => r.key)); if (resources.length !== plan.children.length) invalid()
  const spatial = rpcRecord(p.spatialContribution, ['save'])
  const clientProjection = parseSpaceCloseProjectionResult(p.clientProjection), spatialContribution = { save: save(spatial.save) }
  const ids = plan.projection.surfaces.map(s => s.owner.regionId)
  if ([...clientProjection.removedRegions, ...clientProjection.retainedRegions].some(id => !ids.includes(id))) invalid()
  if (p.phase === 'prepared' ? decisions.length || resources.some(r => r.outcome !== 'pending' || r.receipt) || clientProjection.applied || clientProjection.save || spatialContribution.save
    : spaceCloseDigest(decisions.map(spaceCloseDigest).sort()) !== spaceCloseDigest(spaceCloseDecisions(plan).map(spaceCloseDigest).sort())) invalid()
  if (p.outcome === 'applied' && (p.phase !== 'settled' || clientProjection.retainedRegions.length || resources.some(r => r.outcome !== 'acknowledged') ||
    ![clientProjection.save, spatialContribution.save].every(s => s?.diskDurability === 'confirmed' && s.clientStateWritten && s.storageFlushRequested))) invalid()
  return { operationId: text(p.operationId), request, plan, planDigest: text(p.planDigest), preparedBy, approvedBy, decisions,
    phase: p.phase as SpaceCloseReceipt['phase'], outcome: p.outcome as SpaceCloseReceipt['outcome'], resources, clientProjection,
    spatialContribution, preparedAt: p.preparedAt as number, updatedAt: p.updatedAt as number, diskDurability: p.diskDurability as SpaceCloseReceipt['diskDurability'], ...(p.issue === undefined ? {} : { issue: p.issue as string }) }
}
export function parseSpaceCloseList(value: unknown, input: SpaceCloseListParams): SpaceCloseList {
  const p = rpcRecord(value, ['ownerId', 'observedAt', 'coverage', 'availability', 'items', 'nextCursor', 'issues'])
  if (p.coverage !== 'live-page' || !Number.isSafeInteger(p.observedAt) || Number(p.observedAt) < 0 || p.availability !== 'complete' && p.availability !== 'partial') invalid()
  const ownerId = text(p.ownerId)
  const items = list(p.items, value => {
    const r = rpcRecord(value, ['operationId', 'target', 'preparedBy', 'phase', 'outcome', 'preparedAt', 'updatedAt', 'planDigest', 'diskDurability'])
    if (!member(r.phase, ['prepared', 'applying', 'settled', 'unconfirmed']) || !member(r.outcome, ['prepared', 'applied', 'partial', 'unknown', 'not-applied']) || !member(r.diskDurability, ['confirmed', 'unconfirmed']) ||
      !Number.isSafeInteger(r.preparedAt) || !Number.isSafeInteger(r.updatedAt) || Number(r.preparedAt) < 0 || Number(r.updatedAt) < Number(r.preparedAt)) invalid()
    return { operationId: text(r.operationId), target: parseSpaceCloseTarget(r.target), preparedBy: parseSpaceCloseActor(r.preparedBy), phase: r.phase, outcome: r.outcome,
      preparedAt: r.preparedAt, updatedAt: r.updatedAt, planDigest: text(r.planDigest), diskDurability: r.diskDurability } as SpaceCloseSummary
  })
  unique(items.map(i => i.operationId)); if (items.length > (input.limit ?? 25)) invalid()
  const nextCursor = p.nextCursor === null ? null : parseSpaceCloseListParams({ cursor: p.nextCursor }).cursor!
  if (nextCursor && nextCursor.ownerId !== ownerId || input.cursor && (input.cursor.ownerId !== ownerId || nextCursor && (nextCursor.actorScope !== input.cursor.actorScope || nextCursor.afterMember <= input.cursor.afterMember))) invalid()
  const issues = list(p.issues, value => { const i = rpcRecord(value, ['code', 'member']); if (i.code !== 'member-unconfirmed' || i.member !== null && typeof i.member !== 'string') invalid(); return { code: 'member-unconfirmed' as const, member: i.member as string | null } })
  if (issues.length && p.availability !== 'partial') invalid()
  return { ownerId, observedAt: p.observedAt as number, coverage: 'live-page', availability: p.availability, items, nextCursor, issues }
}
export function parseSpaceCloseResult<M extends SpaceCloseMethod>(method: M, value: unknown, input: SpaceCloseParams[M]): SpaceCloseResults[M] {
  if (method === 'space.close.ls') return parseSpaceCloseList(value, input as SpaceCloseListParams) as SpaceCloseResults[M]
  const p = rpcRecord(value, ['operation'], 'CONTROL_PROTOCOL_ERROR'), operation = p.operation === null ? null : parseSpaceCloseReceipt(p.operation)
  const operationId = (input as SpaceCloseInspect).operationId
  if (operation && (operation.operationId !== operationId || method === 'space.close.prepare' && JSON.stringify(operation.request) !== JSON.stringify(input) || method === 'space.close.apply' && operation.planDigest !== (input as SpaceCloseApply).expectedPlanDigest) || method !== 'space.close.inspect' && !operation) invalid()
  return { operation } as SpaceCloseResults[M]
}
