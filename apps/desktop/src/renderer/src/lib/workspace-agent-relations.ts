import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxMessageEvent, AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { api } from './api'
import { workspaceAgentOrderKey } from './workspace-agent-key'
import { retainedWorkspaceAgentEntry, workspaceAgentMessageLinks, workspaceAgentRetiredSources, type WorkspaceAgentEntry } from './workspace-agent-arrangement'
import { createWorkspaceAgentListSelector, type WorkspaceAgentScopeState, type WorkspaceAgentExecutionResolver } from './workspace-agent-scope'

export function workspaceAgentOrderEntries(state: WorkspaceAgentScopeState, workspace: WorkspaceRecord, sources: readonly AgentSessionHistoryDescriptor[], resolveExecution?: WorkspaceAgentExecutionResolver) {
  const index = new Map(sources.map(source => [JSON.stringify([source.hostId, source.agentSessionId]), source]))
  const list = createWorkspaceAgentListSelector(resolveExecution)(state, workspace, state.sessions, index)
  const retired = workspaceAgentRetiredSources(list.sessions, sources)
  const entries: WorkspaceAgentEntry[] = list.sessions.filter(session => !retired.has(workspaceAgentOrderKey(session)))
  for (const member of list.members) {
    const key = JSON.stringify([member.subject.hostId, member.subject.agentSessionId]), source = retired.get(key)
    if (source) entries.push(retainedWorkspaceAgentEntry(source))
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
  const readings: Reading[] = [], queue = [...entries]
  let incomplete = false
  async function worker() {
    while (queue.length) {
      const entry = queue.shift()!
      try { readings.push(await read(subject(entry))) } catch { incomplete = true }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
  return { links: workspaceAgentMessageLinks(readings), incomplete }
}

/** A mounted reader retains confirmed metadata on observation failure, without a fact Store. */
export function useWorkspaceAgentLinks(entries: readonly WorkspaceAgentEntry[], enabled: boolean) {
  const key = JSON.stringify(entries.map(workspaceAgentOrderKey).sort())
  const [readings, setReadings] = useState<Record<string, Reading>>({})
  const [issues, setIssues] = useState<Record<string, string>>({})
  const latest = useRef(entries); latest.current = entries
  const reader = useRef<{ update(entries: readonly WorkspaceAgentEntry[], refresh?: boolean): void } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let current = true
    let running = 0
    const subjects = new Map<string, ReturnType<typeof subject>>()
    const pending = new Set<string>(), dirty = new Set<string>(), queue = new Set<string>()
    function refresh(key: string) {
      if (pending.has(key)) { dirty.add(key); return }
      queue.add(key); pump()
    }
    function pump() {
      // Same independent four-reader budget as the collaboration map. No slow source holds its peers.
      while (current && running < 4 && queue.size) {
        const key = queue.values().next().value!; queue.delete(key)
        const original = subjects.get(key)
        if (!original) continue
        pending.add(key); running++
        void load(key, original)
      }
    }
    async function load(key: string, original: ReturnType<typeof subject>) {
      try {
        const value = await read(original)
        if (current && subjects.get(key) === original) {
          setReadings(previous => ({ ...previous, [key]: value }))
          setIssues(previous => { if (!previous[key]) return previous; const next = { ...previous }; delete next[key]; return next })
        }
      } catch (error) { if (current && subjects.get(key) === original) setIssues(previous => ({ ...previous, [key]: error instanceof Error ? error.message : String(error) })) }
      finally { pending.delete(key); running--; if (current && dirty.delete(key) && subjects.has(key)) queue.add(key); pump() }
    }
    const owner = { update(entries: readonly WorkspaceAgentEntry[], all = false) {
      const next = new Map(entries.map(entry => [workspaceAgentOrderKey(entry), subject(entry)]))
      for (const key of subjects.keys()) if (!next.has(key)) { subjects.delete(key); queue.delete(key); dirty.delete(key) }
      const added: string[] = []
      for (const [key, value] of next) if (!subjects.has(key)) { subjects.set(key, value); added.push(key) }
      setReadings(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => next.has(key))))
      setIssues(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => next.has(key))))
      for (const key of all ? subjects.keys() : added) refresh(key)
    } }
    reader.current = owner; owner.update(latest.current, true)
    const unsubscribe = api.sessions.onEvent(({ hostId, event }) => {
      if (event.type !== 'agent-message-changed' || event.recordKind !== 'message' && event.recordKind !== 'message-peer-inbox') return
      for (const id of new Set([event.senderSessionId, event.recipientSessionId])) {
        const key = JSON.stringify([hostId, id]); if (subjects.has(key)) refresh(key)
      }
    })
    return () => { current = false; if (reader.current === owner) reader.current = null; unsubscribe() }
  }, [enabled])
  useEffect(() => { reader.current?.update(entries) }, [key])
  return useMemo(() => {
    const keys: string[] = JSON.parse(key)
    const errors = keys.flatMap(key => issues[key] ? [issues[key]!] : [])
    return { links: workspaceAgentMessageLinks(keys.flatMap(key => readings[key] ? [readings[key]!] : [])), refresh: () => reader.current?.update(latest.current, true),
      issue: errors.length ? 'Communication proximity is partially observed. Existing Agent order and actions remain available.' : null }
  }, [key, readings, issues])
}
