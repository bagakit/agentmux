import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { HostConfig } from '../../../shared/contracts'
import { FOCUS_BUCKETS, type FocusContext } from './focus-context'
import { focusContextIdentityKey } from './focus-context-identity'

const contextKey = (context: FocusContext) => focusContextIdentityKey(context.hostId, context.id)
const runtimeKey = (runtimeId: string, sessionId: string) => JSON.stringify([runtimeId, sessionId])

type Creation = {
  creator: string | null
  creatorName: string
  originalCreator: string
  child: FocusContext
}
export type FocusAgentCreations = {
  parents: ReadonlyMap<string, Creation>
  children: ReadonlyMap<string, readonly Creation[]>
}

function setUnique(index: Map<string, FocusContext | null>, key: string, context: FocusContext) {
  const previous = index.get(key)
  index.set(key, previous === undefined || previous === context ? context : null)
}

/** A projection of the same durable metadata used by the collaboration map. */
export function focusAgentCreations(sources: readonly AgentSessionHistoryDescriptor[], contexts: readonly FocusContext[],
  hosts: readonly HostConfig[] = []): FocusAgentCreations {
  if (!sources.some(source => source.state !== 'deleted' && source.history?.creation?.createdBy)) return { parents: new Map(), children: new Map() }
  const routes = new Map<string, FocusContext | null>()
  const runtimes = new Map<string, FocusContext | null>()
  const runtimeByHost = new Map(hosts.flatMap(host => host.kind === 'ssh' && host.runtimeId ? [[host.id, host.runtimeId] as const] : []))
  for (const context of contexts) {
    if (context.kind !== 'agent') continue
    if (context.access) {
      const original = context.access.identity
      if (original.runtimeId) setUnique(runtimes, runtimeKey(original.runtimeId, original.agentSessionId), context)
    } else {
      const hostId = context.control?.hostId ?? context.hostId
      const sessionId = context.control?.agentSessionId ?? context.id
      setUnique(routes, focusContextIdentityKey(hostId, sessionId), context)
      const runtimeId = runtimeByHost.get(hostId)
      if (runtimeId) setUnique(runtimes, runtimeKey(runtimeId, sessionId), context)
    }
  }
  const exact = (hostId: string, sessionId: string) => {
    const route = routes.get(focusContextIdentityKey(hostId, sessionId))
    const runtimeId = runtimeByHost.get(hostId)
    return route === undefined && runtimeId ? runtimes.get(runtimeKey(runtimeId, sessionId)) : route
  }
  const tracked = new Map<string, Creation | null>()
  for (const source of sources) {
    const creator = source.history?.creation?.createdBy
    if (!creator || source.state === 'deleted') continue
    const child = exact(source.hostId, source.agentSessionId)
    if (!child) continue
    const parent = creator.owner.kind === 'local'
      ? exact(source.hostId, creator.agentSessionId)
      : runtimes.get(runtimeKey(creator.owner.runtimeId, creator.agentSessionId))
    const key = contextKey(child), creatorKey = parent ? contextKey(parent) : null
    if (key === creatorKey) continue
    const previous = tracked.get(key)
    const originalCreator = JSON.stringify([creator.owner.kind === 'local' ? ['host', source.hostId] : ['runtime', creator.owner.runtimeId],
      creator.agentSessionId, creator.run.runId])
    const owner = creator.owner.kind === 'local' ? source.hostId : creator.owner.runtimeId
    const evidence = { creator: creatorKey, creatorName: parent?.name ?? `${creator.agentSessionId} · ${owner}`, originalCreator, child }
    tracked.set(key, previous === undefined ? evidence : previous && previous.creator === creatorKey &&
      previous.originalCreator === originalCreator ? previous : null)
  }
  const parents = new Map<string, Creation>(), children = new Map<string, Creation[]>()
  for (const [key, creation] of tracked) if (creation) {
    parents.set(key, creation)
    if (creation.creator) {
      const entries = children.get(creation.creator) ?? []
      entries.push(creation)
      children.set(creation.creator, entries)
    }
  }
  return { parents, children }
}

type Bucket = FocusContext['bucket']
type GroupedContexts = Record<Bucket, FocusContext[]>

export type FocusCreationRow = {
  depth: number
  childCount: number
  references: readonly { context: FocusContext; label: string | undefined }[]
  expanded: boolean
}
export type FocusCreationTree = {
  rows: ReadonlyMap<string, FocusCreationRow>
  groups: GroupedContexts
  revealAncestors: ReadonlySet<string>
}

/** Keep the pre-existing scan order for roots and siblings. Each accepted child has one tree home. */
export function focusCreationTree(groups: GroupedContexts, creation: FocusAgentCreations, visible: ReadonlySet<string>,
  collapsed: ReadonlySet<string>, section?: ReadonlyMap<string, { id: string; name: string }>, revealKey?: string): FocusCreationTree {
  const ordered = FOCUS_BUCKETS.flatMap(bucket => groups[bucket].map(context => ({ context, bucket })))
  const local = new Map(ordered.map(({ context }) => [contextKey(context), context.bucket]))
  const needsReference = (parent: string, child: string) => !local.has(child) || !local.has(parent) ||
    section?.get(parent)?.id !== section?.get(child)?.id || local.get(child) === 'attention'
  const parents = new Map<string, string>()
  for (const { context } of ordered) {
    const child = contextKey(context), parent = creation.parents.get(child)?.creator
    if (parent && !needsReference(parent, child)) parents.set(child, parent)
  }
  const checked = new Set<string>()
  for (const { context } of ordered) {
    const path = new Set<string>()
    let key: string | undefined = contextKey(context)
    while (key !== undefined && !checked.has(key)) {
      if (path.has(key)) {
        let cycle = key
        do {
          const next = parents.get(cycle)!
          parents.delete(cycle)
          cycle = next
        } while (cycle !== key)
        break
      }
      path.add(key)
      key = parents.get(key)
    }
    for (const item of path) checked.add(item)
  }
  const revealAncestors = new Set<string>()
  for (let key = revealKey && parents.get(revealKey); key; key = parents.get(key)) revealAncestors.add(key)
  const children = new Map<string, FocusContext[]>()
  for (const { context } of ordered) {
    const parent = parents.get(contextKey(context))
    if (parent) {
      const entries = children.get(parent) ?? []
      entries.push(context)
      children.set(parent, entries)
    }
  }
  const displayed: GroupedContexts = { attention: [], working: [], results: [], idle: [] }
  const rows = new Map<string, FocusCreationRow>()
  for (const { context, bucket } of ordered) {
    if (parents.has(contextKey(context))) continue
    const stack = [{ context, depth: 0 }]
    while (stack.length) {
      const { context, depth } = stack.pop()!
      const key = contextKey(context)
      const descendants = children.get(key) ?? []
      const references = (creation.children.get(key) ?? []).flatMap(({ child }) => {
        const childKey = contextKey(child)
        return needsReference(key, childKey) && visible.has(childKey)
          ? [{ context: child, label: local.has(childKey) ? section?.get(childKey)?.name : child.workspaceName }] : []
      })
      const expanded = !collapsed.has(key) || revealAncestors.has(key)
      rows.set(key, { depth, childCount: descendants.length + references.length, references: expanded ? references : [], expanded })
      displayed[bucket].push(context)
      if (expanded) for (let index = descendants.length - 1; index >= 0; index--) stack.push({ context: descendants[index]!, depth: depth + 1 })
    }
  }
  return { rows, groups: displayed, revealAncestors }
}
