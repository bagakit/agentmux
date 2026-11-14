import { AgentMuxError, type AgentMuxRuntimeSubject } from '@agentmux/core'
import { connectSpaceMember, type SpaceMemberClient } from '@agentmux/core/space-member-client'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxRpcClient } from '@agentmux/core'
import type { SessionSnapshot } from '../shared/contracts.js'
import type { SpaceMountMemberRoute, SpaceMountMemberSurface, SpaceMountMemberEvent, SpaceMountMemberMethods } from '../shared/space-mount.js'

type Actions = { [M in keyof SpaceMountMemberMethods]: (input: SpaceMountMemberMethods[M]['input'], signal?: AbortSignal) => Promise<SpaceMountMemberMethods[M]['result']> }
/** A sender-owned original SDK reader, not another Session or attachment owner. */
export async function createSpaceMemberSurface(input: SpaceMountMemberRoute, ports: {
  rpc: Pick<AgentMuxRpcClient, 'call' | 'subscribe'>; assertCurrent(): void
  project(subject: AgentMuxRuntimeSubject, catalog: import('@agentmux/core').AgentCatalogEntry[]): SessionSnapshot
}, emit: (event: SpaceMountMemberEvent) => void, signal: AbortSignal): Promise<SpaceMountMemberSurface & { start(): void }> {
  const client = await connectSpaceMember(ports.rpc, input.target) as SpaceMemberClient
  const readingOnly = !('expectedRun' in input.target)
  const originalRun = () => {
    if (!('expectedRun' in input.target)) throw new AgentMuxError('This original surface grants conversation reading only.', 'CONTROL_PERMISSION_DENIED')
    return input.target.expectedRun
  }
  const initial = { id: JSON.stringify(['space-member', input.hostId, input.target]),
    hostId: JSON.stringify(['space-member', input.hostId, input.target.reference, input.target.runtimeId]) }
  let closed = false, reading: Promise<SessionSnapshot> | undefined, readAgain = false
  const leases = new Set<string>()
  const views = new Set<string>(), conversationReference = { hostId: 'local', agentSessionId: input.target.agentSessionId }
  const conversations = new Map<string, Awaited<ReturnType<typeof client.observeConversation>>>()
  const conversationInput = <T extends object>(value: T): T => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || 'hostId' in value || 'agentSessionId' in value) throw new AgentMuxError(
      'This fixed member reader accepts conversation options only; its original Host and Session cannot be replaced.', 'SPACE_MEMBER_TARGET_MISMATCH')
    return value
  }
  const check = () => { signal.throwIfAborted(); ports.assertCurrent(); if (closed) throw new AgentMuxError('This original member view closed. Its Agent remains available.', 'CONTROL_CANCELLED') }
  const read = async () => {
    check()
    const metadata = await client.metadata()
    const subject = await client.runtimeSubject({ kind: 'agent-session', agentSessionId: input.target.agentSessionId })
    check()
    if (subject.kind !== 'agent' || subject.agentSession.agentSessionId !== input.target.agentSessionId || subject.run.runId !== originalRun().runId) throw new AgentMuxError('This member now refers to another Run. The original input is retained.', 'STALE_AGENT_SESSION_BINDING')
    const projected = ports.project({ ...subject, hostId: initial.hostId }, metadata.catalog)
    if (projected.kind !== 'agent') throw new AgentMuxError('The original member projector returned another object kind.', 'SPACE_MEMBER_TARGET_MISMATCH')
    return { ...projected, id: initial.id, hostId: initial.hostId, control: { kind: 'agent' as const, hostId: initial.hostId, agentSessionId: input.target.agentSessionId, run: originalRun() } }
  }
  const report = (cause: unknown) => { if (!closed) emit({ type: 'observation-error', error: { code: cause instanceof AgentMuxError ? cause.code : 'SPACE_MEMBER_OBSERVATION_UNAVAILABLE', message: cause instanceof Error ? cause.message : String(cause) } }) }
  const refresh = () => {
    if (closed) return
    if (reading) { readAgain = true; return }
    readAgain = false
    reading = read()
    void reading.then(session => { if (!closed) emit({ type: 'session', session }) }).catch(report).finally(() => {
      reading = undefined
      if (readAgain) refresh()
    })
  }
  const unlisten = client.onEvent(event => {
    if (closed || signal.aborted) return
    try { ports.assertCurrent() } catch (cause) { report(cause); return }
    emit({ type: 'runtime', event: { type: 'core', hostId: initial.hostId, event } })
    if (!readingOnly && (event.type === 'agent-session' || event.type === 'agent-status' || event.type === 'process-state' || event.type === 'connection-state' && event.state === 'restored')) refresh()
  }, { observeMessages: false })
  const requireLease = (id: string) => { if (!leases.has(id)) throw new AgentMuxError('This attachment belongs to another original member view.', 'INVALID_ATTACHMENT') }
  const attach = async (afterByte: number, previous?: string | null) => {
    check(); if (previous) requireLease(previous)
    const attached = previous !== undefined ? await client.refreshRunAttachment(originalRun(), afterByte, 'terminal')
      : leases.size ? await client.readRunReplay(originalRun(), afterByte, 'terminal')
      : await client.attachTerminal(originalRun().runId, afterByte, 'terminal')
    try {
      check(); if (attached.run.runId !== originalRun().runId) throw new AgentMuxError('The original attachment belongs to another Run.', 'STALE_AGENT_SESSION_BINDING')
      const session = await read(), attachmentId = previous ?? mintObjectId(); leases.add(attachmentId)
      return { attachmentId, session, currentSize: attached.run.cols === null || attached.run.rows === null ? null : { cols: attached.run.cols, rows: attached.run.rows },
        replay: attached.replay, gap: attached.gap, terminal: attached.terminal, resizeRevision: attached.resizeRevision }
    } catch (cause) { if (!leases.size) await client.releaseRunAttachment(originalRun()).catch(report); throw cause }
  }
  const actions: Actions = {
    read,
    skills: async (_value, requestSignal) => {
      const page = await ports.rpc.call('space.member.call', { target: input.target,
        call: { method: 'skill.ls', params: conversationReference } }, requestSignal ? { signal: requestSignal } : {}) as import('@agentmux/core').AgentMuxRpcResult<'skill.ls'>
      check()
      if (page.hostId !== 'local' || page.agentSessionId !== input.target.agentSessionId) throw new AgentMuxError('These Skills belong to another original Agent.', 'SPACE_MEMBER_TARGET_MISMATCH')
      return page.skills
    },
    history: async (value, requestSignal) => {
      const page = await client.readAgentSessionHistory({ ...conversationInput(value.input), ...conversationReference }, requestSignal ? { signal: requestSignal } : {})
      check()
      if (page.hostId !== 'local' || page.agentSessionId !== input.target.agentSessionId) throw new AgentMuxError('This history belongs to another original Agent.', 'SPACE_MEMBER_TARGET_MISMATCH')
      return { ...page, hostId: initial.hostId }
    },
    historyResource: async (value, requestSignal) => {
      const page = await client.sessionHistoryResource(input.target.agentSessionId, { ...conversationInput(value.input), ...(requestSignal ? { signal: requestSignal } : {}) })
      check()
      if (page.agentSessionId !== input.target.agentSessionId) throw new AgentMuxError('This history resource belongs to another original Agent.', 'SPACE_MEMBER_TARGET_MISMATCH')
      return page
    },
    inputMailbox: async value => {
      const page = await client.readAgentInputMailbox({ ...conversationInput(value.input), agentSessionId: input.target.agentSessionId })
      check()
      if (page.agentSessionId !== input.target.agentSessionId) throw new AgentMuxError('This input journal belongs to another original Agent.', 'SPACE_MEMBER_TARGET_MISMATCH')
      return page
    },
    conversationRead: async (value, requestSignal) => {
      const page = await client.readAgentConversation({ ...conversationInput(value.input), ...conversationReference }, requestSignal ? { signal: requestSignal } : {})
      if (closed) { if (page.window.view) await client.releaseConversationView({ ...conversationReference, view: page.window.view }); check() }
      if (page.window.view) views.add(page.window.view)
      check(); return page
    },
    conversationCheckpoint: async (value, requestSignal) => {
      const page = await client.conversationCheckpoint({ ...conversationInput(value.input), ...conversationReference }, requestSignal ? { signal: requestSignal } : {})
      check(); return page
    },
    conversationChanges: async (value, requestSignal) => {
      const page = await client.readConversationChanges({ ...conversationInput(value.input), ...conversationReference }, requestSignal ? { signal: requestSignal } : {})
      if (closed) { if (page.window.view) await client.releaseConversationView({ ...conversationReference, view: page.window.view }); check() }
      if (page.window.view) views.add(page.window.view)
      check(); return page
    },
    conversationRelease: async value => {
      const result = await client.releaseConversationView({ ...conversationReference, view: value.view })
      views.delete(value.view); check(); return result
    },
    conversationWatch: async (value, requestSignal) => {
      const readerId = mintObjectId()
      const opened = await client.observeConversation({ ...value, ...conversationReference }, observation => {
        if (!closed && conversations.has(readerId)) emit({ type: 'conversation', readerId, observation })
      }, requestSignal ? { signal: requestSignal } : {})
      if (closed) { opened.dispose(); check() }
      conversations.set(readerId, opened)
      const released = () => { if (conversations.get(readerId) === opened) conversations.delete(readerId) }
      opened.closed.addEventListener('abort', released, { once: true }); if (opened.closed.aborted) released()
      check(); return { readerId, hostId: opened.hostId, agentSessionId: opened.agentSessionId, sourceHostId: opened.sourceHostId, scope: opened.scope, coverage: opened.coverage }
    },
    conversationUnwatch: async value => { const reader = conversations.get(value.readerId); conversations.delete(value.readerId); reader?.dispose() },
    attach: value => attach(value.afterByte),
    refreshAttachment: value => attach(value.afterByte, value.attachmentId),
    replay: async value => { check(); requireLease(value.attachmentId); const result = await client.readRunReplay(originalRun(), value.afterByte, 'terminal'); check(); return { replay: result.replay, gap: result.gap } },
    detach: async value => { requireLease(value.attachmentId); leases.delete(value.attachmentId); if (!leases.size) await client.releaseRunAttachment(originalRun()) },
    resize: async value => { check(); requireLease(value.attachmentId); const result = await client.resizeTerminal(originalRun(), value.cols, value.rows); check(); return { cols: result.cols, rows: result.rows } },
    write: async value => { check(); await client.writeAgent({ agentSessionId: input.target.agentSessionId, expectedRun: originalRun(), ...value }); check() },
    paste: async value => { check(); await client.pasteAgent({ agentSessionId: input.target.agentSessionId, expectedRun: originalRun(), ...value }); check() },
    inspectInteraction: async value => { check(); return await client.inspectAgentInteractionOperation({ agentSessionId: input.target.agentSessionId, operationId: value.operationId }) }
  }
  const dispose = async () => {
    if (closed) return
    closed = true; for (const reader of conversations.values()) reader.dispose(); conversations.clear()
    signal.removeEventListener('abort', abort); unlisten(); leases.clear()
    const retained = [...views]; views.clear()
    const releases = await Promise.allSettled(retained.map(view => client.releaseConversationView({ ...conversationReference, view })))
    for (const release of releases) if (release.status === 'rejected') console.warn('[space-member] Conversation view release unconfirmed', release.reason)
    await client.dispose()
  }
  const abort = () => { void dispose().catch(report) }; signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) { await dispose(); signal.throwIfAborted() }
  return { initial, call: async (method, value, requestSignal) => {
    requestSignal?.throwIfAborted(); check()
    if (readingOnly && !method.startsWith('conversation') && method !== 'history' && method !== 'historyResource' && method !== 'inputMailbox' && method !== 'skills') throw new AgentMuxError('This original surface grants conversation reading only.', 'CONTROL_PERMISSION_DENIED')
    const result = await actions[method](value, requestSignal); requestSignal?.throwIfAborted(); return result
  }, start: () => { if (!readingOnly) void client.connect().then(refresh).catch(report) }, dispose }
}
