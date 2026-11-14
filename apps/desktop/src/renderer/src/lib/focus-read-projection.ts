import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { FOCUS_EXCERPT_MAX, FOCUS_PAGE_DEFAULT, focusContextReferenceKey, parseFocusParams, parseFocusResult, parseFocusSource,
  type AgentMuxFocusMember, type AgentMuxFocusScope, type AgentMuxFocusSource, type FocusMethod, type FocusParams, type FocusResults } from '@agentmux/core/focus-control'
import type { AppState } from '../store'
import { folderSpaceFacts } from '@agentmux/core/space-folder'
import { createFocusProjectionSelector } from './focus-context'
import { createFocusContextIdentitySelector, focusContextIdentityKey } from './focus-context-identity'
import { deriveFocusProjectLanes } from './focus-project-lanes'
import { deriveFocusCollectionLanes } from './focus-collection-lanes'
import { focusGroupReadScope } from './focus-group-reference'
import { workbenchSelectionCatalog } from './desktop-focus-navigation'
import { workbenchNavigationTabs } from './workbench-navigation-catalog'
import { memberSpaceInputTarget } from './space-mount-view'

export type FocusReadLocations = { known: boolean; executionFor: Parameters<ReturnType<typeof createFocusContextIdentitySelector>>[5]; bindings?: unknown }
const unknownLocations: FocusReadLocations = { known: false, executionFor: () => null }

const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))))
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
type Cursor = { version: 1; source: AgentMuxFocusSource; request: string; membership: string; after: string }
const encode = (value: Cursor) => encodeURIComponent(JSON.stringify(value))
function cursor(value: string | undefined): Cursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Cursor
    return parsed.version === 1 && typeof parsed.request === 'string' && typeof parsed.membership === 'string' && typeof parsed.after === 'string'
      ? { ...parsed, source: parseFocusSource(parsed.source) } : null
  } catch { return null }
}

/** One bounded read of already loaded owners. No card, Reader, request, subscription or navigation mounts here. */
export function readFocusGroups<M extends FocusMethod>(state: AppState, input: { method: M; params: FocusParams[M] }, source: AgentMuxFocusSource,
  locations: FocusReadLocations = unknownLocations): FocusResults[M] {
  const params = parseFocusParams(input.method, input.params)
  source = parseFocusSource(source)
  const now = Date.now(), catalog = workbenchSelectionCatalog(state)
  const projection = createFocusProjectionSelector()(state, true, 'metadata', true)
  const contexts = [...projection.contexts, ...projection.coordinationContexts]
  const identities = createFocusContextIdentitySelector()(catalog, workbenchNavigationTabs(state.tabs), contexts,
    state.config, state.layouts, locations.executionFor, locations.known, locations.bindings)
  const raw = deriveFocusProjectLanes([...projection.laneContexts, ...projection.coordinationContexts], state.config, undefined, identities, now, state.scratchTopicSnapshots)
  const lanes = deriveFocusCollectionLanes(raw, catalog, { bindings: state.spaceZoneBindings, categories: state.topicCategories })
  const resources = [...state.config?.workspaces ?? [], ...contexts.flatMap(context => context.workspace ? [context.workspace] : [])]
  const groups = new Map<string, { scope: AgentMuxFocusScope; name: string; identityStatus: 'confirmed' | 'unconfirmed'; references: Set<string> }>()
  for (const lane of lanes) {
    const scope = focusGroupReadScope(lane, resources)
    if (!scope) continue
    const key = JSON.stringify(scope), prior = groups.get(key)
    const group = prior ?? { scope, name: lane.collection ? lane.name : resources.find(resource => resource.hostId === lane.hostId && resource.id === lane.projectWorkspaceId)?.name ?? lane.labels[0] ?? lane.name,
      identityStatus: lane.collection && !lane.collection.confirmed || lane.locationUnconfirmed ? 'unconfirmed' as const : 'confirmed' as const, references: new Set<string>() }
    for (const ref of lane.contextRefs) group.references.add(focusContextIdentityKey(ref.hostId, ref.id))
    groups.set(key, group)
  }
  const sourceStatuses: Array<{ source: string; status: 'observed' | 'unconfirmed' | 'unavailable' }> = [
    { source: 'loaded-sessions', status: state.loading ? 'unconfirmed' : 'observed' },
    { source: 'original-spatial-document', status: locations.known ? 'observed' : 'unconfirmed' }
  ]
  // Member Reader observations are owned by their visible source consumer, not this Store.
  // Never borrow local SID facts for those references or cause a fresh read to improve coverage.
  const issues: Array<{ code: string; message: string }> = []
  const pageSize = params.limit ?? FOCUS_PAGE_DEFAULT
  const directory = [...groups].sort(([a], [b]) => compare(a, b))
  const read = input.method === 'focus.read' ? params as FocusParams['focus.read'] : null
  for (const [key, observation] of Object.entries(state.mountedSpaceObservations)) {
    let relevant = !read
    if (read) {
      try {
        const target = memberSpaceInputTarget(state.mountedSpaceInputs, key)
        relevant = Boolean(target && (read.scope.kind === 'collection'
          ? target.hostId === read.scope.hostId && read.scope.categorySpaceIds.includes(target.reference.spaceId)
          : state.config?.workspaces.some(resource => resource.hostId === target.hostId && resource.id === target.workspaceId &&
            resource.hostId === read.scope.hostId && folderSpaceFacts(resource).space.spaceId === (read.scope as Extract<AgentMuxFocusScope, { kind: 'project' }>).projectSpaceId)))
      } catch { /* An unreadable unrelated source does not remove this exact scope's loaded facts. */ }
    }
    if (relevant) sourceStatuses.push({ source: 'mounted-space:' + key, status: observation.error ? 'unavailable' : 'unconfirmed' })
  }
  const group = read ? groups.get(JSON.stringify(read.scope)) : undefined
  const byReference = new Map(contexts.map(context => [focusContextIdentityKey(context.hostId, context.id), context]))
  const selected = read ? read.selection.kind === 'members' ? read.selection.references.map(reference => [focusContextReferenceKey(reference), reference] as const)
    : [...group?.references ?? []].sort(compare).map(key => { const [hostId, contextId] = JSON.parse(key) as [string, string]; return [key, { hostId, contextId }] as const }) : []
  const all = read ? selected : directory
  const membership = hash(read ? [[...group?.references ?? []].sort(compare), selected.map(([key]) => [key, group?.references.has(key) ?? false, byReference.has(key)])]
    : directory.map(([key, item]) => [key, [...item.references].sort(compare)]))
  const request = hash(read ? { scope: read.scope, selection: read.selection } : { method: input.method })
  const prior = cursor(params.cursor)
  const changed = Boolean(params.cursor && (!prior || JSON.stringify(prior.source) !== JSON.stringify(source) || prior.request !== request || prior.membership !== membership || !all.some(([key]) => key === prior.after)))
  if (changed) issues.push({ code: 'FOCUS_CONTINUATION_CHANGED', message: 'The original Focus source or membership changed. Read the first page again; these pages are not a complete snapshot.' })
  if (read && !group) issues.push({ code: 'FOCUS_GROUP_UNCONFIRMED', message: 'The original Focus group is not currently confirmed. Its exact references are retained; no other group was substituted.' })
  else if (group?.identityStatus === 'unconfirmed') issues.push({ code: 'FOCUS_GROUP_UNCONFIRMED', message: 'This is the original unconfirmed Focus group bucket, not a confirmed Category identity.' })
  const offset = prior && !changed ? all.findIndex(([key]) => key === prior.after) + 1 : 0
  const slice = changed ? [] : all.slice(offset, offset + pageSize)
  const memberChanged = Boolean(read && selected.some(([key]) => !group?.references.has(key) && byReference.has(key)))
  const memberUnknown = Boolean(read && selected.some(([key]) => !byReference.has(key)))
  const items = read ? slice.map(([key, value]): AgentMuxFocusMember => {
    const reference = value as { hostId: string; contextId: string }, context = byReference.get(key)
    const observed = Boolean(context && group?.references.has(key)), availability = observed ? 'observed' : context ? 'changed' : 'unconfirmed'
    const identity = observed ? identities.get(key) : undefined
    return { reference, availability, name: observed ? context!.name : null, kind: observed ? context!.kind : null,
      state: observed ? { process: context!.processState, semantic: context!.activitySemantic ?? null, label: context!.stateLabel, unobserved: context!.runUnobserved ?? false } : null,
      agent: observed && context!.control ? { hostId: context!.control!.hostId, agentSessionId: context!.control!.agentSessionId, run: { runId: context!.control!.run.runId } } : null,
      excerpt: observed ? { text: context!.detail.slice(0, FOCUS_EXCERPT_MAX), truncated: context!.detail.length > FOCUS_EXCERPT_MAX } : null,
      locations: { status: identity?.locations.status ?? 'unconfirmed', occurrences: identity?.locations.occurrences.flatMap(occurrence => occurrence.display.hostId ? [{
        hostId: occurrence.display.hostId, workspaceId: occurrence.display.workspaceId, groupId: occurrence.display.groupId,
        tabId: occurrence.display.tabId, regionId: occurrence.display.regionId
      }] : []) ?? [] } }
  }) : slice.map(([, value]) => { const item = value as typeof directory[number][1]; return { scope: item.scope, name: item.name, identityStatus: item.identityStatus, memberCount: item.references.size } })
  const nextCursor = !changed && offset + slice.length < all.length && slice.length ? encode({ version: 1, source, request, membership, after: slice.at(-1)![0] }) : null
  const unconfirmed = memberUnknown || Boolean(read && (!group || group.identityStatus === 'unconfirmed')) || sourceStatuses.some(item => item.status !== 'observed')
  const result = { schemaVersion: 1, source, readAt: now, status: changed || memberChanged ? 'changed' : unconfirmed ? 'unconfirmed' : 'observed', items, nextCursor,
    coverage: { complete: !changed && !unconfirmed && !memberChanged && nextCursor === null, total: read ? group?.references.size ?? 0 : directory.length,
      selected: all.length, returned: items.length, sourceStatuses }, issues, ...(read ? { scope: read.scope, selection: read.selection } : {}) }
  return parseFocusResult(input.method, result, params)
}
