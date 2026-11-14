import { AgentMuxError, validateAgentPromptInputBinding, type AgentMuxRuntimeSubject } from '@agentmux/core'
import { connectSpaceMember } from '@agentmux/core/space-member-client'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxRpcClient } from '@agentmux/core'
import type { SessionSnapshot } from '../shared/contracts.js'
import type { SpaceMountMemberTarget, SpaceMountMemberSurface, SpaceMountMemberEvent, SpaceMountMemberMethods } from '../shared/space-mount.js'

type Actions = { [M in keyof SpaceMountMemberMethods]: (input: SpaceMountMemberMethods[M]['input']) => Promise<SpaceMountMemberMethods[M]['result']> }
/** A sender-owned original SDK reader, not another Session or attachment owner. */
export async function createSpaceMemberSurface(input: SpaceMountMemberTarget, ports: {
  rpc: Pick<AgentMuxRpcClient, 'call' | 'subscribe'>; assertCurrent(): void
  project(subject: AgentMuxRuntimeSubject, catalog: import('@agentmux/core').AgentCatalogEntry[]): SessionSnapshot
}, emit: (event: SpaceMountMemberEvent) => void, signal: AbortSignal): Promise<SpaceMountMemberSurface & { start(): void }> {
  const client = await connectSpaceMember(ports.rpc, input.target)
  const initial = { id: JSON.stringify(['space-member', input.hostId, input.target]),
    hostId: JSON.stringify(['space-member', input.hostId, input.target.reference, input.target.runtimeId]) }
  let closed = false, reading: Promise<SessionSnapshot> | undefined
  const leases = new Set<string>()
  const check = () => { signal.throwIfAborted(); ports.assertCurrent(); if (closed) throw new AgentMuxError('This original member view closed. Its Agent remains available.', 'CONTROL_CANCELLED') }
  const read = async () => {
    check()
    const metadata = await client.metadata()
    const subject = await client.runtimeSubject({ kind: 'agent-session', agentSessionId: input.target.agentSessionId })
    check()
    if (subject.kind !== 'agent' || subject.agentSession.agentSessionId !== input.target.agentSessionId || subject.run.runId !== input.target.expectedRun.runId) throw new AgentMuxError('This member now refers to another Run. The original input is retained.', 'STALE_AGENT_SESSION_BINDING')
    const projected = ports.project({ ...subject, hostId: initial.hostId }, metadata.catalog)
    if (projected.kind !== 'agent') throw new AgentMuxError('The original member projector returned another object kind.', 'SPACE_MEMBER_TARGET_MISMATCH')
    return { ...projected, id: initial.id, hostId: initial.hostId, control: { kind: 'agent' as const, hostId: initial.hostId, agentSessionId: input.target.agentSessionId, run: input.target.expectedRun } }
  }
  const report = (cause: unknown) => { if (!closed) emit({ type: 'observation-error', error: { code: cause instanceof AgentMuxError ? cause.code : 'SPACE_MEMBER_OBSERVATION_UNAVAILABLE', message: cause instanceof Error ? cause.message : String(cause) } }) }
  const refresh = () => {
    if (closed || reading) return
    reading = read()
    void reading.then(session => { if (!closed) emit({ type: 'session', session }) }).catch(report).finally(() => { reading = undefined })
  }
  const unlisten = client.onEvent(event => {
    if (closed || signal.aborted) return
    try { ports.assertCurrent() } catch (cause) { report(cause); return }
    emit({ type: 'runtime', event: { type: 'core', hostId: initial.hostId, event } })
    if (event.type === 'agent-session' || event.type === 'process-state' || event.type === 'connection-state' && event.state === 'restored') refresh()
  }, { observeMessages: false })
  const requireLease = (id: string) => { if (!leases.has(id)) throw new AgentMuxError('This attachment belongs to another original member view.', 'INVALID_ATTACHMENT') }
  const attach = async (afterByte: number, previous?: string | null) => {
    check(); if (previous) requireLease(previous)
    const attached = previous !== undefined ? await client.refreshRunAttachment(input.target.expectedRun, afterByte, 'terminal')
      : leases.size ? await client.readRunReplay(input.target.expectedRun, afterByte, 'terminal')
      : await client.attachTerminal(input.target.expectedRun.runId, afterByte, 'terminal')
    try {
      check(); if (attached.run.runId !== input.target.expectedRun.runId) throw new AgentMuxError('The original attachment belongs to another Run.', 'STALE_AGENT_SESSION_BINDING')
      const session = await read(), attachmentId = previous ?? mintObjectId(); leases.add(attachmentId)
      return { attachmentId, session, currentSize: attached.run.cols === null || attached.run.rows === null ? null : { cols: attached.run.cols, rows: attached.run.rows },
        replay: attached.replay, gap: attached.gap, terminal: attached.terminal, resizeRevision: attached.resizeRevision }
    } catch (cause) { if (!leases.size) await client.releaseRunAttachment(input.target.expectedRun).catch(report); throw cause }
  }
  const actions: Actions = {
    read,
    attach: value => attach(value.afterByte),
    refreshAttachment: value => attach(value.afterByte, value.attachmentId),
    replay: async value => { check(); requireLease(value.attachmentId); const result = await client.readRunReplay(input.target.expectedRun, value.afterByte, 'terminal'); check(); return { replay: result.replay, gap: result.gap } },
    detach: async value => { requireLease(value.attachmentId); leases.delete(value.attachmentId); if (!leases.size) await client.releaseRunAttachment(input.target.expectedRun) },
    resize: async value => { check(); requireLease(value.attachmentId); const result = await client.resizeTerminal(input.target.expectedRun, value.cols, value.rows); check(); return { cols: result.cols, rows: result.rows } },
    write: async value => { check(); await client.writeAgent({ agentSessionId: input.target.agentSessionId, expectedRun: input.target.expectedRun, ...value }); check() },
    paste: async value => { check(); await client.pasteAgent({ agentSessionId: input.target.agentSessionId, expectedRun: input.target.expectedRun, ...value }); check() },
    submitPrompt: async value => {
      check(); const binding = validateAgentPromptInputBinding(value.binding)
      if (binding.expectedRun.runId !== input.target.expectedRun.runId) throw new AgentMuxError('The original input binding belongs to another Run.', 'STALE_AGENT_SESSION_BINDING')
      const result = await client.submitAgentPrompt({ agentSessionId: input.target.agentSessionId, ...binding, operationId: value.operationId, prompt: value.prompt,
        ...('admissionIntent' in binding ? { execution: 'immediate' as const } : {}) })
      check(); return result
    },
    inspectInput: async value => { check(); if (value.key.agentSessionId !== input.target.agentSessionId || value.key.expectedRun.runId !== input.target.expectedRun.runId) throw new AgentMuxError('This input key belongs to another original member.', 'SPACE_MEMBER_TARGET_MISMATCH'); return await client.inspectAgentInput({ key: value.key }) },
    inspectInteraction: async value => { check(); return await client.inspectAgentInteractionOperation({ agentSessionId: input.target.agentSessionId, operationId: value.operationId }) }
  }
  const dispose = async () => { if (closed) return; closed = true; signal.removeEventListener('abort', abort); unlisten(); leases.clear(); await client.dispose() }
  const abort = () => { void dispose().catch(report) }; signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) { await dispose(); signal.throwIfAborted() }
  return { initial, call: async (method, value, requestSignal) => { requestSignal?.throwIfAborted(); check(); const result = await actions[method](value); requestSignal?.throwIfAborted(); return result },
    start: () => { void client.connect().then(refresh).catch(report) }, dispose }
}
