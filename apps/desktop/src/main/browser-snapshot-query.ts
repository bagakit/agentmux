import type { BrowserPageNode, BrowserPageSnapshot } from '../shared/contracts.js'
import type { BrowserScopedSnapshot, BrowserSnapshotObservation, BrowserSnapshotQuery } from '../shared/browser-snapshot-query.js'

export const DEFAULT_SNAPSHOT_MAX_NODES = 200
export const MAX_SNAPSHOT_MAX_NODES = 1000

export type NormalizedBrowserSnapshotQuery = BrowserSnapshotQuery & {
  scope: 'page' | 'viewport'
  interactiveOnly: boolean
  maxNodes: number
}

/** Main-owned capture facts. Sets never cross the script/Control transport. */
export type BrowserSnapshotScopeFacts = {
  document: string | null
  backendNodes: Set<string> | null
  omittedFrames: string[]
  unlocated: number
  work: BrowserSnapshotObservation['work']
}

export function browserSnapshotNodeIdentity(node: Pick<BrowserPageNode, 'sessionId' | 'backendNodeId'>): string {
  return `${node.sessionId ?? 'main'}:${node.backendNodeId}`
}

export function parseBrowserSnapshotQuery(value: unknown): NormalizedBrowserSnapshotQuery {
  if (value === undefined) return { scope: 'page', interactiveOnly: false, maxNodes: DEFAULT_SNAPSHOT_MAX_NODES }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('snapshot options must be an object')
  const query = value as Record<string, unknown>
  for (const key of Object.keys(query)) {
    if (!['scope', 'within', 'withinRef', 'interactiveOnly', 'maxNodes'].includes(key)) throw new TypeError(`Unknown snapshot option: ${key}`)
  }
  if (query.scope !== undefined && query.scope !== 'page' && query.scope !== 'viewport') throw new TypeError('snapshot scope must be page or viewport')
  if (query.within !== undefined && query.withinRef !== undefined) throw new TypeError('snapshot accepts either within or withinRef, not both')
  for (const key of ['within', 'withinRef']) {
    if (query[key] !== undefined && (typeof query[key] !== 'string' || (query[key] as string).trim() === '')) throw new TypeError(`snapshot ${key} must be a nonempty string`)
  }
  if (query.interactiveOnly !== undefined && typeof query.interactiveOnly !== 'boolean') throw new TypeError('snapshot interactiveOnly must be a boolean')
  const maxNodes = query.maxNodes ?? DEFAULT_SNAPSHOT_MAX_NODES
  if (typeof maxNodes !== 'number' || !Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_SNAPSHOT_MAX_NODES) throw new TypeError(`snapshot maxNodes must be an integer between 1 and ${MAX_SNAPSHOT_MAX_NODES}`)
  return {
    scope: query.scope === 'viewport' ? 'viewport' : 'page',
    interactiveOnly: query.interactiveOnly === true,
    maxNodes,
    ...(query.within === undefined ? {} : { within: query.within as string }),
    ...(query.withinRef === undefined ? {} : { withinRef: query.withinRef as string })
  }
}

/** Project one complete identity graph without mutating it or issuing new refs. */
export function projectBrowserSnapshot(
  snapshot: BrowserPageSnapshot,
  facts: BrowserSnapshotScopeFacts,
  query: NormalizedBrowserSnapshotQuery
): BrowserScopedSnapshot {
  const scoped = facts.backendNodes === null ? snapshot.nodes : snapshot.nodes.filter((node) => facts.backendNodes!.has(browserSnapshotNodeIdentity(node)))
  const matched = query.interactiveOnly ? scoped.filter((node) => node.ref !== '') : scoped
  const nodes = matched.slice(0, query.maxNodes)
  const subtree = query.within !== undefined || query.withinRef !== undefined
  return {
    url: snapshot.url,
    title: snapshot.title,
    navigationId: snapshot.navigationId,
    nodes,
    missingFrames: snapshot.missingFrames,
    observation: {
      scope: {
        kind: subtree ? (query.scope === 'viewport' ? 'subtree-viewport' : 'subtree') : query.scope,
        document: facts.document,
        ...(query.within === undefined ? {} : { within: query.within }),
        ...(query.withinRef === undefined ? {} : { withinRef: query.withinRef })
      },
      fullObserved: snapshot.nodes.length,
      scoped: scoped.length,
      matched: matched.length,
      returned: nodes.length,
      truncated: nodes.length < matched.length,
      omittedFrames: facts.omittedFrames,
      unlocated: facts.unlocated,
      work: facts.work
    }
  }
}
