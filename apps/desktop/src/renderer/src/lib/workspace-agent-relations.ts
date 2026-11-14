import { useEffect, useMemo, useState } from 'react'
import type { AgentMuxMessageEvent, AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { api } from './api'
import { workspaceAgentOrderKey } from './workspace-agent-key'
import { retainedWorkspaceAgentEntry, workspaceAgentMessageLinks, type WorkspaceAgentEntry } from './workspace-agent-arrangement'
import { createWorkspaceAgentListSelector, type WorkspaceAgentScopeState, type WorkspaceAgentExecutionResolver } from './workspace-agent-scope'

export function workspaceAgentOrderEntries(state: WorkspaceAgentScopeState, workspace: WorkspaceRecord, sources: readonly AgentSessionHistoryDescriptor[], resolveExecution?: WorkspaceAgentExecutionResolver) {
  const index = new Map(sources.map(source => [JSON.stringify([source.hostId, source.agentSessionId]), source]))
  const list = createWorkspaceAgentListSelector(resolveExecution)(state, workspace, state.sessions, index)
  const entries: WorkspaceAgentEntry[] = [...list.sessions]
  const live = new Set(entries.map(workspaceAgentOrderKey))
  for (const member of list.members) {
    const key = JSON.stringify([member.subject.hostId, member.subject.agentSessionId]), source = index.get(key)
    if (!live.has(key) && source?.state === 'retired') entries.push(retainedWorkspaceAgentEntry(source))
  }
  return entries
}

type Reading = { hostId: string; events: readonly AgentMuxMessageEvent[] }
async function read(subject: { hostId: string; agentSessionId: string }): Promise<Reading> {
  const page = await api.sessions.messageEvents(subject, { latest: true, limit: 50 })
  if (page.hostId !== subject.hostId || page.participantSessionId !== subject.agentSessionId) throw new Error('Original communication source is unconfirmed.')
  return { hostId: subject.hostId, events: page.events }
}
const subject = (entry: WorkspaceAgentEntry) => ({ hostId: entry.control?.hostId ?? entry.hostId,
  agentSessionId: entry.control?.kind === 'agent' ? entry.control.agentSessionId : entry.id })

/** Read-only, bounded metadata from this exact member set; never conversation bodies. */
export async function readWorkspaceAgentLinks(entries: readonly WorkspaceAgentEntry[]) {
  const results = await Promise.allSettled(entries.map(entry => read(subject(entry))))
  return { links: workspaceAgentMessageLinks(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])),
    incomplete: results.some(result => result.status === 'rejected') }
}

/** A mounted reader retains confirmed metadata on observation failure, without a fact Store. */
export function useWorkspaceAgentLinks(entries: readonly WorkspaceAgentEntry[], enabled: boolean) {
  const key = JSON.stringify(entries.map(workspaceAgentOrderKey).sort())
  const [readings, setReadings] = useState<Record<string, Reading>>({})
  const [issues, setIssues] = useState<Record<string, string>>({})
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let current = true
    const subjects = new Map(entries.map(entry => [workspaceAgentOrderKey(entry), subject(entry)]))
    const pending = new Set<string>(), dirty = new Set<string>()
    async function refresh(key: string) {
      if (pending.has(key)) { dirty.add(key); return }
      pending.add(key)
      try {
        const value = await read(subjects.get(key)!)
        if (current) { setReadings(previous => ({ ...previous, [key]: value })); setIssues(previous => { const next = { ...previous }; delete next[key]; return next }) }
      } catch (error) { if (current) setIssues(previous => ({ ...previous, [key]: error instanceof Error ? error.message : String(error) })) }
      finally { pending.delete(key); if (current && dirty.delete(key)) void refresh(key) }
    }
    for (const key of subjects.keys()) void refresh(key)
    const unsubscribe = api.sessions.onEvent(({ hostId, event }) => {
      if (event.type !== 'agent-message-changed') return
      for (const id of new Set([event.senderSessionId, event.recipientSessionId])) {
        const key = JSON.stringify([hostId, id]); if (subjects.has(key)) void refresh(key)
      }
    })
    return () => { current = false; unsubscribe() }
  }, [key, enabled, revision])
  return useMemo(() => {
    const keys: string[] = JSON.parse(key)
    const errors = keys.flatMap(key => issues[key] ? [issues[key]!] : [])
    return { links: workspaceAgentMessageLinks(keys.flatMap(key => readings[key] ? [readings[key]!] : [])), refresh: () => setRevision(value => value + 1),
      issue: errors.length ? 'Communication proximity is partially observed. Existing Agent order and actions remain available.' : null }
  }, [key, readings, issues])
}
