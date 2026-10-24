import { createHash } from 'node:crypto'
import { AgentMuxError, agentDiscoveryActivity, type AgentMuxAgentCreationInspection, type AgentMuxAgentSession, type AgentMuxClient } from '@agentmux/core'
import type { MoteChatTarget } from '@agentmux/core/mote-chat'
import type { MoteChatAgentPort, MoteChatCreatedAgent, MoteChatPreparedLaunch } from '@agentmux/connectors'
import type { MoteChatResourcePort } from './mote-resources.js'
import type { AgentMuxAgentCreateInput, AgentMuxHostExecutorInventory, AgentMuxHostAgentCreateInput } from '@agentmux/core'
type AgentMuxAgentCreationResult = Awaited<ReturnType<AgentMuxClient['createAgentWithDelivery']>>
type Core = Pick<AgentMuxClient, 'inspectAgentCreation' | 'readAgentSession' | 'runtimeSubject' | 'ensureAgentContinuity'> & { listHostExecutors(input?: { refresh?: boolean }): Promise<AgentMuxHostExecutorInventory>; createHostAgentWithDelivery(input: AgentMuxHostAgentCreateInput): Promise<AgentMuxAgentCreationResult> }
export type MoteChatExecutorPort = {
  resolve(hostId: string, executorId: string, workspacePath: string): Promise<
    { providerId: string; revision: string; launch?: never } |
    { providerId: string; revision?: never; launch: Pick<AgentMuxAgentCreateInput, 'commandOverride' | 'args' | 'env' | 'injectAgentMuxGuide'> }>
  create(prepared: MoteChatPreparedLaunch): Promise<AgentMuxAgentCreationResult>
}
export type MoteChatAgentOptions = {
  resources: MoteChatResourcePort
  clients(): readonly { hostId: string; client: Core }[]
  /** Existing embedding may provide its own original Executor/creation owner. No failure fallback. */
  executors?: MoteChatExecutorPort
}
function hostExecutors(clients: MoteChatAgentOptions['clients']): MoteChatExecutorPort {
  const exact = (hostId: string) => { const found = clients().filter(c => c.hostId === hostId); if (found.length !== 1) throw new AgentMuxError('The exact original Mote Host is unavailable.', 'MOTE_CHAT_HOST_UNAVAILABLE'); return found[0]!.client }
  return {
    resolve: async (hostId, executorId) => {
      const found = (await exact(hostId).listHostExecutors()).executors.filter(entry => entry.executorId === executorId)
      if (found.length !== 1) throw new AgentMuxError('The original saved Mote Executor is unavailable on its Host. Keep the original MOTE.md and existing conversations.', 'MOTE_CHAT_EXECUTOR_UNAVAILABLE')
      return { providerId: found[0]!.providerId, revision: found[0]!.configRevision }
    },
    create: async prepared => {
      const { agentSessionId, createOperationId, executorId, workspacePath, agentMuxNote, optionalContext } = prepared.input
      if (!prepared.executorRevision || !agentSessionId || !createOperationId || !executorId) throw new AgentMuxError('The original prepared Mote Host Executor revision is unconfirmed. Retain its creation and inspect it without recomposing.', 'MOTE_CHAT_EXECUTOR_UNCONFIRMED')
      return await exact(prepared.executionHostId).createHostAgentWithDelivery({ agentSessionId, createOperationId, executorId, executorRevision: prepared.executorRevision, workspacePath,
        ...(agentMuxNote === undefined ? {} : { agentMuxNote }), ...(optionalContext === undefined ? {} : { optionalContext }) })
    }
  }
}
export type HostMoteChatAgents = MoteChatAgentPort & {
  assertTarget(target: MoteChatTarget): Promise<void>
  /** Validate the saved new-chat Executor without preparing an identity or starting a Run. */
  assertReady(target: MoteChatTarget): Promise<void>
}
const failure = (code: string, message: string): never => { throw new AgentMuxError(message, code) }
const recoveryId = (sessionId: string, runId: string) => `mote-chat-recovery-${createHash('sha256').update(JSON.stringify([sessionId, runId])).digest('hex')}`

/** Exact Mote files and existing Core creation, independently of Renderer, focus or Region placement. */
export function createMoteChatAgents(options: MoteChatAgentOptions): HostMoteChatAgents {
  const executors = options.executors ?? hostExecutors(options.clients)
  function core(hostId: string): Core {
    const matches = options.clients().filter(entry => entry.hostId === hostId)
    if (matches.length !== 1) failure('MOTE_CHAT_HOST_UNAVAILABLE', 'The original Mote execution Host is unavailable or ambiguous. Its messages, creation and existing Agents are retained.')
    return matches[0]!.client
  }
  async function ready(input: MoteChatTarget) {
    const original = await options.resources.read(input), topic = original.topic
    if (topic.quickMode?.status === 'unconfirmed') return failure('MOTE_CHAT_EXECUTOR_UNCONFIRMED', 'This Mote saved Executor is unconfirmed. Restore its original MOTE.md; existing conversations remain available.')
    const executorId = topic.quickMode?.status === 'saved' ? topic.quickMode.defaults.executorId : undefined
    if (!executorId) return failure('MOTE_CHAT_EXECUTOR_REQUIRED', 'Choose Executor for new chat in this Mote Profile. No Agent was started.')
    const executor = await executors.resolve(original.workspace.hostId, executorId, original.topic.physicalDirectoryPath!)
    core(original.workspace.hostId)
    return { ...original, executorId, executor }
  }
  function exact(prepared: MoteChatPreparedLaunch, session: AgentMuxAgentCreationInspection): AgentMuxAgentSession {
    const input = prepared.input
    if (session.kind !== 'agent') return failure('MOTE_CHAT_AGENT_RETIRED', 'This original Mote chat Agent was explicitly retired. Its history and exact creation remain available; it was not recreated.')
    if ('forkSource' in input || 'nativeResumeSource' in input || session.forkedFrom) return failure('MOTE_CHAT_CREATE_MISMATCH', 'Private chat requires its original dedicated creation, not an imported or copied conversation. The original message and creation are retained.')
    if (session.agentSessionId !== input.agentSessionId || session.hostId !== 'local' && session.hostId !== prepared.executionHostId ||
      session.providerId !== input.providerId || session.executorId !== input.executorId || session.workspacePath !== input.workspacePath ||
      !input.createOperationId || session.creation?.createOperationId !== input.createOperationId) {
      return failure('MOTE_CHAT_CREATE_MISMATCH', 'The original Core creation does not confirm this exact Mote chat Session and intent. Keep the original operation and inspect it without replacing its identity.')
    }
    if (prepared.executorRevision && session.creation?.executorRevision !== prepared.executorRevision) return failure('MOTE_CHAT_CREATE_MISMATCH', 'The original Mote creation has another Executor revision. Retain and inspect its original operation.')
    if (session.creation?.agentMuxContext !== 'confirmed') return failure('MOTE_CHAT_CONTEXT_UNCONFIRMED', 'The original Agent exists, but its required Mote and conversation-history context is unconfirmed. Its creation and incoming message are retained for inspection.')
    return session
  }
  async function created(prepared: MoteChatPreparedLaunch, value: AgentMuxAgentCreationInspection): Promise<MoteChatCreatedAgent> {
    const session = exact(prepared, value)
    return { executionHostId: prepared.executionHostId, agentSessionId: session.agentSessionId }
  }
  async function prepareInput(prepared: MoteChatPreparedLaunch): Promise<void> {
    const client = core(prepared.executionHostId)
    const session = exact(prepared, await client.inspectAgentCreation(prepared.input.agentSessionId!))
    const current = session.continuity
    // A prepared replacement Run is not the completed recovery receipt. Rejoin our
    // original operation before ingress can freeze that Run into a new input.
    const pending = current && ['pending', 'starting'].includes(current.kind) &&
      current.operationId === recoveryId(session.agentSessionId, current.previousRun.runId) &&
      [current.previousRun.runId, current.newRun?.runId].includes(session.run.runId) ? current : undefined
    if (!pending) {
      let subject: Awaited<ReturnType<Core['runtimeSubject']>> | undefined
      try { subject = await client.runtimeSubject({ kind: 'terminal-run', runId: session.run.runId }) }
      catch (error) {
        if (error instanceof AgentMuxError && ['AGENT_SESSION_RUN_MISMATCH', 'RUNTIME_OWNER_MISMATCH', 'CONTROL_PERMISSION_DENIED'].includes(error.code)) throw error
        // Observation failure is not evidence that a healthy Agent needs recovery.
        // The original Core input path still owns its exact Run and admission.
        if (!(error instanceof AgentMuxError && error.code === 'CTXMUX_run_not_found')) return
      }
      const run = subject?.run
      // A terminal-run observation intentionally carries no Agent identity; the
      // canonical creation above owns that binding, while Runtime owns this Run.
      if (run && (run.runId !== session.run.runId || run.workspacePath !== session.workspacePath)) {
        return failure('MOTE_CHAT_TARGET_UNCONFIRMED', 'The Runtime observation belongs to another Mote chat target. The original conversation and incoming message are retained.')
      }
      if (run?.state === 'running') return
    }
    const expectedRun = pending?.previousRun ?? session.run
    const operationId = pending?.operationId ?? recoveryId(session.agentSessionId, expectedRun.runId)
    const prior = session.continuityOperations?.[operationId]
    // Default Host creation owns saved AppConfig options; Core freezes those logical
    // options on the first recovery. Rechecks use that original frozen executor.
    const { commandOverride, args, env } = prepared.executorRevision === undefined ? prepared.input : {}
    const result = await client.ensureAgentContinuity({ agentSessionId: session.agentSessionId, expectedRun, operationId, trigger: 'input',
      ...(!prior && !prepared.executorRevision ? {
        ...(commandOverride === undefined ? {} : { commandOverride }),
        ...(args === undefined ? {} : { args }), ...(env === undefined ? {} : { env })
      } : {}) })
    if (result.kind === 'resumed' || result.kind === 'reattachable') { exact(prepared, result.session); return }
    if (result.kind === 'retired') return failure('MOTE_CHAT_AGENT_RETIRED', 'The original Mote chat Agent was retired. Its conversation and incoming message are retained.')
    return failure(result.kind === 'unavailable' ? 'MOTE_CHAT_RECOVERY_UNAVAILABLE' : 'MOTE_CHAT_RECOVERY_PENDING',
      'The original Mote chat is not ready after recovery. Its original recovery and incoming message are retained; no input was dispatched.')
  }
  return {
    assertTarget: async input => { await options.resources.read(input) },
    assertReady: async input => { await ready(input) },
    prepare: async ({ generation, systemContext }) => {
      const original = await ready(generation.target)
      if (generation.executionHostId !== original.workspace.hostId) return failure('MOTE_CHAT_TARGET_UNCONFIRMED', 'The chat reservation belongs to another Mote Host. Its original identity and incoming message are retained.')
      const executor = structuredClone(original.executor), profileContext = original.profileContext
      const prepared = await options.resources.prepare(generation.target, original, { providerId: executor.providerId, sessionId: generation.agentSessionId })
      const input = {
        agentSessionId: generation.agentSessionId, createOperationId: generation.createOperationId,
        providerId: executor.providerId, executorId: original.executorId, workspacePath: prepared.absolutePath,
        agentMuxNote: [prepared.prompt, systemContext, profileContext].filter(note => note?.trim()).join('\n\n'),
        optionalContext: structuredClone(prepared.optionalContext)
      }
      return executor.revision === undefined
        ? { executionHostId: generation.executionHostId, input: { ...input, ...executor.launch } }
        : { executionHostId: generation.executionHostId, input, executorRevision: executor.revision }
    },
    create: async prepared => {
      const receipt = await executors.create(structuredClone(prepared))
      return await created(prepared, receipt.session)
    },
    inspect: async prepared => {
      let session: AgentMuxAgentCreationInspection
      try { session = await core(prepared.executionHostId).inspectAgentCreation(prepared.input.agentSessionId!) }
      catch (error) {
        // Core explicitly has neither a Session nor prepared creation; stable create IDs are still retained.
        if (error instanceof AgentMuxError && error.code === 'AGENT_CREATION_UNKNOWN') return null
        throw error
      }
      return await created(prepared, session)
    },
    prepareInput,
    activity: async reference => {
      const session = await core(reference.executionHostId).readAgentSession(reference.agentSessionId)
      if (!session) return { lastActivityAt: null }
      if (session.agentSessionId !== reference.agentSessionId || session.hostId !== 'local' && session.hostId !== reference.executionHostId) {
        return failure('MOTE_CHAT_TARGET_UNCONFIRMED', 'The activity observation belongs to another original Mote chat Session. Its recorded activity and Agent are retained.')
      }
      return { lastActivityAt: agentDiscoveryActivity(session)?.observedAt ?? null }
    }
  }
}
