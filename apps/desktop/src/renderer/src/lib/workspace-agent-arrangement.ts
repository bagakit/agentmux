import type { AgentMuxMessageEvent, AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { workspaceAgentOrderKey } from './workspace-agent-key'

export type WorkspaceAgentEntry = {
  id: string; hostId: string; createdAt: number
  control?: SessionSnapshot['control']
  creation?: Extract<SessionSnapshot, { kind: 'agent' }>['creation']
  forkedFrom?: Extract<SessionSnapshot, { kind: 'agent' }>['forkedFrom']
}
export type WorkspaceAgentLink = { source: string; target: string; weight: number }
export type WorkspaceAgentGroup<T> = { key: string; members: { session: T; depth: number }[] }

/** A newer Core Session record supersedes an older retirement, even if its catalogue cannot refresh. */
export function workspaceAgentRetiredSources(sessions: readonly SessionSnapshot[], sources: readonly AgentSessionHistoryDescriptor[]) {
  const current = new Map(sessions.flatMap(session => session.kind === 'agent' && session.hostId === session.control.hostId
    ? [[workspaceAgentOrderKey(session), session] as const] : []))
  return new Map(sources.filter(source => {
    if (source.state !== 'retired') return false
    const session = current.get(JSON.stringify([source.hostId, source.agentSessionId]))
    return !session || source.retiredAt !== undefined && session.agentSessionUpdatedAt <= source.retiredAt
  }).map(source => [JSON.stringify([source.hostId, source.agentSessionId]), source]))
}

/** A retained entry is ordering metadata, never a fabricated live Session/Run. */
export function retainedWorkspaceAgentEntry(source: AgentSessionHistoryDescriptor): WorkspaceAgentEntry {
  return { id: source.agentSessionId, hostId: source.hostId, createdAt: source.history?.createdAt ?? source.retiredAt ?? 0,
    ...(source.history?.creation ? { creation: source.history.creation } : {}),
    ...(source.history?.forkedFrom ? { forkedFrom: source.history.forkedFrom } : {}) }
}

/** Undirected proximity counts each original message once, not delivery observations. */
export function workspaceAgentMessageLinks(readings: readonly { hostId: string; events: readonly AgentMuxMessageEvent[] }[]): WorkspaceAgentLink[] {
  const seen = new Set<string>(), links = new Map<string, WorkspaceAgentLink>()
  for (const reading of readings) for (const event of reading.events) {
    if (event.kind !== 'message' && event.kind !== 'message-peer-inbox') continue
    for (const message of event.messages) {
      // Runtime-qualified peers require an owner mapping; a Host alias cannot supply it.
      if ((message.senderRuntimeId || message.recipientRuntimeId) && message.senderRuntimeId !== message.recipientRuntimeId) continue
      const id = JSON.stringify([reading.hostId, message.senderSessionId, message.messageId])
      if (seen.has(id)) continue
      seen.add(id)
      const pair = [JSON.stringify([reading.hostId, message.senderSessionId]), JSON.stringify([reading.hostId, message.recipientSessionId])].sort()
      if (pair[0] === pair[1]) continue
      const key = JSON.stringify(pair), held = links.get(key)
      if (held) held.weight++
      else links.set(key, { source: pair[0]!, target: pair[1]!, weight: 1 })
    }
  }
  return [...links.values()]
}

/** Exact derivation trees are indivisible; manual group order wins over communication. */
export function workspaceAgentGroups<T extends WorkspaceAgentEntry>(sessions: readonly T[], order: readonly string[] = [], links: readonly WorkspaceAgentLink[] = []): WorkspaceAgentGroup<T>[] {
  const entries = new Map<string, T>()
  for (const session of sessions) if (!entries.has(workspaceAgentOrderKey(session))) entries.set(workspaceAgentOrderKey(session), session)
  const keys = [...entries.keys()].sort((a, b) => entries.get(a)!.createdAt - entries.get(b)!.createdAt || a.localeCompare(b))
  const parents = new Map<string, string>()
  for (const key of keys) {
    const session = entries.get(key)!, creator = session.creation?.createdBy
    // A native fork records conversation ancestry; otherwise use the authenticated creator.
    const parentId = session.forkedFrom?.agentSessionId ?? (creator?.owner.kind === 'local' ? creator.agentSessionId : undefined)
    const parent = parentId ? JSON.stringify([session.hostId, parentId]) : undefined
    if (parent && parent !== key && entries.has(parent)) parents.set(key, parent)
  }
  // A malformed cycle cannot become invented ancestry or remove any original member.
  const settled = new Set<string>()
  for (const start of keys) {
    const path: string[] = [], visited = new Map<string, number>()
    let key: string | undefined = start
    while (key && !settled.has(key)) {
      const cycle = visited.get(key)
      if (cycle !== undefined) { for (const member of path.slice(cycle)) parents.delete(member); break }
      visited.set(key, path.length); path.push(key); key = parents.get(key)
    }
    for (const member of path) settled.add(member)
  }
  const children = new Map<string, string[]>()
  for (const key of keys) { const parent = parents.get(key); if (parent) { const members = children.get(parent) ?? []; members.push(key); children.set(parent, members) } }
  const groups: WorkspaceAgentGroup<T>[] = [], owner = new Map<string, string>()
  for (const key of keys) if (!parents.has(key)) {
    const group: WorkspaceAgentGroup<T> = { key, members: [] }, stack = [{ key, depth: 0 }]
    while (stack.length) {
      const member = stack.pop()!
      group.members.push({ session: entries.get(member.key)!, depth: member.depth }); owner.set(member.key, key)
      for (const child of [...children.get(member.key) ?? []].reverse()) stack.push({ key: child, depth: member.depth + 1 })
    }
    groups.push(group)
  }
  const ranks = new Map(order.map((key, index) => [key, index])), manual = new Map<string, number>()
  for (const group of groups) for (const { session } of group.members) {
    const rank = ranks.get(workspaceAgentOrderKey(session))
    if (rank !== undefined) manual.set(group.key, Math.min(rank, manual.get(group.key) ?? Infinity))
  }
  const pinned = groups.filter(group => manual.has(group.key)).sort((a, b) => manual.get(a.key)! - manual.get(b.key)!)
  const automatic = groups.filter(group => !manual.has(group.key))
  const adjacency = new Map<string, Map<string, number>>()
  for (const link of links) {
    const a = owner.get(link.source), b = owner.get(link.target)
    if (!a || !b || a === b) continue
    for (const [from, to] of [[a, b], [b, a]] as const) { const neighbors = adjacency.get(from) ?? new Map<string, number>(); neighbors.set(to, (neighbors.get(to) ?? 0) + link.weight); adjacency.set(from, neighbors) }
  }
  const baseline = new Map(automatic.map((group, i) => [group.key, i])), remaining = new Map(automatic.map(group => [group.key, group]))
  const nearby: WorkspaceAgentGroup<T>[] = []
  // Stable greedy walks keep connected peers next to one another; ties keep startup order.
  while (remaining.size) {
    let next = remaining.values().next().value as WorkspaceAgentGroup<T> | undefined
    while (next) {
      nearby.push(next); remaining.delete(next.key)
      const neighbors = [...adjacency.get(next.key) ?? []].filter(([key]) => remaining.has(key))
        .sort((a, b) => b[1] - a[1] || baseline.get(a[0])! - baseline.get(b[0])!)
      next = neighbors.length ? remaining.get(neighbors[0]![0]) : undefined
    }
  }
  return [...pinned, ...nearby]
}
