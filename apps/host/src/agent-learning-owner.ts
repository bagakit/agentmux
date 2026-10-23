import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError, durableWriteFile, mintObjectId, type AgentMuxClient, type AgentMuxHostAgentCreateInput,
  type AgentMuxRpcCallContext } from '@agentmux/core'
import { parseAgentLearningOperation, parseAgentLearningParams, type AgentLearningBinding, type AgentLearningConfirm,
  type AgentLearningMethod, type AgentLearningOperation, type AgentLearningParamsMap, type AgentLearningPort,
  type AgentLearningResultMap, type AgentLearningTarget, type AgentLearningWorker } from '@agentmux/core/agent-learning'
import { composeAgentExtraction, composeAgentLearning } from './agent-learning-prompts.js'

type Core = Pick<AgentMuxClient, 'inspectAgentCreation'>
type Launch = { input: AgentMuxHostAgentCreateInput; dispatched: boolean }
type Stored = { schemaVersion: 1; operation: AgentLearningOperation; extraction: Launch; learning?: Launch;
  learningExecutor?: { providerId: string; revision: string } }
export type AgentLearningOwnerOptions = {
  directory: string; ownerRuntimeId(): string; core(): Core
  executor(executorId: string): Promise<{ providerId: string; revision: string }>
  /** Resolve the frozen original configuration; no argv/environment is copied into this operation. */
  create(input: AgentMuxHostAgentCreateInput): ReturnType<AgentMuxClient['createAgentWithDelivery']>
  /** The original target directory/config/spatial owner validates and prepares the exact resource. */
  target(target: AgentLearningTarget, input?: { providerId: string; sessionId: string }): Promise<{
    workspacePath: string; agentMuxNote?: string; optionalContext?: AgentMuxHostAgentCreateInput['optionalContext']
  }>
  /** This is the original live native App adapter, never a parameter-supplied confirmation. */
  confirmation(confirmationId: string, binding: AgentLearningBinding): Promise<void>
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
function fail(code: string, message: string): never { throw new AgentMuxError(message, code) }

/** One narrow Host workflow. Knowledge and all process/input facts remain with their original owners. */
export class AgentLearningOwner implements AgentLearningPort {
  private readonly locks = new Map<string, Promise<void>>()
  constructor(private readonly options: AgentLearningOwnerOptions) {}
  private path(id: string) { return join(this.options.directory, hash(id) + '.json') }
  private local(hostId: string) {
    if (hostId !== 'local') fail('LEARNING_HOST_UNSUPPORTED', 'This learning owner supports its own original Host only. No source or target was remapped; original Agents remain available.')
  }
  private async read(id: string): Promise<Stored | null> {
    let value: Stored
    try { value = JSON.parse(await readFile(this.path(id), 'utf8')) as Stored }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const operation = parseAgentLearningOperation(value.operation)
    if (value.schemaVersion !== 1 || operation.operationId !== id || operation.ownerRuntimeId !== this.options.ownerRuntimeId())
      return fail('LEARNING_OWNER_CONFLICT', 'The retained learning operation belongs to another original Host owner. Its content and Agents are kept.')
    if (operation.approved && operation.approved.candidateDigest !== hash(operation.candidate!.content))
      return fail('LEARNING_CANDIDATE_CONFLICT', 'The saved reviewed candidate no longer matches its original confirmation. Keep this operation and inspect its original content.')
    return { ...value, operation }
  }
  private async save(value: Stored) {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    await durableWriteFile(this.path(value.operation.operationId), JSON.stringify(value) + '\n')
  }
  private async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    this.locks.set(id, next)
    await previous
    try { return await operation() }
    finally { release(); if (this.locks.get(id) === next) this.locks.delete(id) }
  }
  private person(context: AgentMuxRpcCallContext) {
    if (context.caller || !context.principal || !['user', 'device'].includes(context.principal.kind))
      fail('CONTROL_PERMISSION_DENIED', 'Only the original person or device can edit a review draft. This does not approve learning; original Agents remain available.')
  }
  private readable(operation: AgentLearningOperation, context: AgentMuxRpcCallContext) {
    const id = context.caller?.agentSessionId
    if (id && id !== operation.source.agentSessionId && id !== operation.proposer.agentSessionId && id !== operation.learner?.agentSessionId)
      fail('CONTROL_PERMISSION_DENIED', 'This learning candidate belongs to another original source and participants. No private material or Agent capability was changed.')
  }
  private async observed(value: Stored): Promise<AgentLearningOperation> {
    const operation = structuredClone(value.operation)
    for (const step of ['extraction', 'learning'] as const) {
      const worker = step === 'extraction' ? operation.proposer : operation.learner
      if (!worker || worker.state === 'prepared' || worker.state === 'not-applied') continue
      try {
        const original = await this.options.core().inspectAgentCreation(worker.agentSessionId)
        const creation = original.kind === 'agent' ? original.creation : original.history?.creation
        if (!creation || original.agentSessionId !== worker.agentSessionId || creation.createOperationId !== worker.createOperationId)
          fail('LEARNING_CREATION_CONFLICT', 'The original Core creation belongs to another exact intent. No replacement Agent was used.')
        worker.state = original.kind === 'agent' ? 'created' : 'retired'
        worker.runId = original.run.runId
        worker.initialPrompt = creation.initialPrompt
        worker.context = creation.agentMuxContext ?? 'unknown'
      } catch (error) {
        operation.unavailable.push({ step, code: error instanceof AgentMuxError ? error.code : 'LEARNING_OBSERVATION_UNAVAILABLE',
          message: error instanceof Error ? error.message : String(error) })
      }
    }
    return operation
  }
  private async dispatch(value: Stored, step: 'extraction' | 'learning', context: AgentMuxRpcCallContext, explicit = false) {
    const launch = step === 'extraction' ? value.extraction : value.learning!
    const worker = step === 'extraction' ? value.operation.proposer : value.operation.learner!
    if (launch.dispatched && !explicit) return // An unknown boundary requires an explicit same-operation action.
    await context.assertCurrent?.(); context.signal?.throwIfAborted()
    launch.dispatched = true; worker.state = 'unknown'
    await this.save(value) // Before the original Core side effect; no automatic replay across this boundary.
    try {
      const result = await this.options.create(launch.input)
      if (!result.session.creation || result.session.agentSessionId !== worker.agentSessionId || result.session.creation.createOperationId !== worker.createOperationId)
        fail('LEARNING_CREATION_CONFLICT', 'Core returned another Agent creation. Retain this original operation; do not create another Agent.')
      worker.state = 'created'; worker.runId = result.session.run.runId
      worker.initialPrompt = result.session.creation.initialPrompt; worker.context = result.session.creation.agentMuxContext ?? 'unknown'
    } catch (error) {
      if (error instanceof AgentMuxError && error.controlFailure?.disposition === 'not_applied') {
        launch.dispatched = false; worker.state = 'not-applied'
      }
      value.operation.issues.push({ step, code: error instanceof AgentMuxError ? error.code : 'LEARNING_CREATE_UNCONFIRMED',
        message: error instanceof Error ? error.message : String(error) })
    }
    await this.save(value)
  }
  async call<M extends AgentLearningMethod>(method: M, raw: AgentLearningParamsMap[M], context: AgentMuxRpcCallContext): Promise<AgentLearningResultMap[M]> {
    const input = parseAgentLearningParams(method, raw)
    if (method === 'agent.learning.confirmation') return fail('CONTROL_PERMISSION_DENIED', 'Only the live native App adapter can confirm the original reviewed learning scope.')
    const p = input as AgentLearningParamsMap['agent.learning.prepare'] & AgentLearningParamsMap['agent.learning.confirm'] & AgentLearningParamsMap['agent.learning.propose'] & AgentLearningParamsMap['agent.learning.ls'] & AgentLearningParamsMap['agent.learning.continue']
    this.local(method === 'agent.learning.prepare' ? p.source.hostId : p.hostId)
    if (method === 'agent.learning.ls') {
      const ids: string[] = []
      for (const name of await readdir(this.options.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
        const value = JSON.parse(await readFile(join(this.options.directory, name), 'utf8')) as Stored
        const operation = parseAgentLearningOperation(value.operation)
        if (p.agentSessionId && operation.source.agentSessionId !== p.agentSessionId) continue
        if (context.caller && ![operation.source.agentSessionId, operation.proposer.agentSessionId, operation.learner?.agentSessionId].includes(context.caller.agentSessionId)) continue
        ids.push(operation.operationId)
      }
      const selected = ids.sort().filter(id => !p.cursor || id > p.cursor).slice(0, p.limit ?? 30)
      const operations = await Promise.all(selected.map(async id => this.observed((await this.read(id))!)))
      return { ownerRuntimeId: this.options.ownerRuntimeId(), operations, nextCursor: ids.some(id => id > (selected.at(-1) ?? p.cursor ?? '')) ? selected.at(-1) ?? null : null } as AgentLearningResultMap[M]
    }
    return await this.exclusive(p.operationId, async () => {
      let value = await this.read(p.operationId)
      if (method === 'agent.learning.prepare') {
        if (context.caller && context.caller.agentSessionId !== p.source.agentSessionId)
          return fail('CONTROL_PERMISSION_DENIED', 'A managed Agent can prepare experience only from its own exact source. Other Agents and their work remain available.')
        if (value && (!same(value.operation.source, p.source) || value.operation.proposer.executorId !== p.executorId))
          return fail('LEARNING_OPERATION_CONFLICT', 'This original operation has another source or Executor. Inspect it without replacing its identity.')
        if (!value) {
          const original = await this.options.core().inspectAgentCreation(p.source.agentSessionId)
          const workspacePath = original.kind === 'agent' ? original.workspacePath : original.history?.workspacePath
          if (original.agentSessionId !== p.source.agentSessionId || original.hostId !== 'local' || !workspacePath)
            return fail('LEARNING_SOURCE_UNCONFIRMED', 'The exact original execution source is unconfirmed. Its Session and work are kept; refresh this source.')
          const executor = await this.options.executor(p.executorId), agentSessionId = mintObjectId(), createOperationId = mintObjectId()
          const operation: AgentLearningOperation = { operationId: p.operationId, ownerRuntimeId: this.options.ownerRuntimeId(), source: p.source, revision: 1,
            proposer: { agentSessionId, createOperationId, executorId: p.executorId, state: 'prepared', initialPrompt: 'not-requested', context: 'unknown' }, candidate: null, approved: null, learner: null, issues: [], unavailable: [] }
          value = { schemaVersion: 1, operation, extraction: { dispatched: false, input: { agentSessionId, createOperationId, executorId: p.executorId,
            executorRevision: executor.revision, workspacePath, agentMuxTask: composeAgentExtraction(operation) } } }
          await context.assertCurrent?.(); await this.save(value)
        }
        await this.dispatch(value, 'extraction', context)
      } else {
        if (!value) {
          if (method === 'agent.learning.inspect') return { operation: null } as AgentLearningResultMap[M]
          return fail('LEARNING_OPERATION_UNKNOWN', 'The original learning operation is unconfirmed. No replacement operation or Agent was created.')
        }
        this.readable(value.operation, context)
        if (method === 'agent.learning.propose' || method === 'agent.learning.revise') {
          const operation = value.operation
          if (method === 'agent.learning.propose' && context.caller?.agentSessionId !== operation.proposer.agentSessionId)
            return fail('CONTROL_PERMISSION_DENIED', 'Only this original operation’s authenticated extraction Agent can propose. The current draft and Agents are kept.')
          if (method === 'agent.learning.revise') this.person(context)
          const author = method === 'agent.learning.propose' ? 'proposer' : 'editor'
          if (!operation.approved && operation.revision === p.expectedRevision + 1 && operation.candidate?.content === p.content && operation.candidate.author === author)
            return { operation: await this.observed(value) } as AgentLearningResultMap[M]
          if (operation.approved || operation.revision !== p.expectedRevision || method === 'agent.learning.propose' && operation.candidate?.author === 'editor')
            return fail('LEARNING_REVISION_CONFLICT', 'The candidate was changed, edited by a person or already confirmed. Read this original draft; do not overwrite it.')
          operation.candidate = { content: p.content, author }; operation.revision++
          await context.assertCurrent?.(); await this.save(value)
        } else if (method === 'agent.learning.continue') {
          this.person(context)
          const observed = await this.observed(value), worker = p.step === 'extraction' ? observed.proposer : observed.learner
          if (worker?.state === 'created' || worker?.state === 'retired') return { operation: observed } as AgentLearningResultMap[M]
          if (p.step === 'extraction') await this.dispatch(value, 'extraction', context, true)
          else {
            const binding = value.operation.approved
            if (!binding) return fail('CONTROL_PERMISSION_DENIED', 'No original human confirmation authorizes this learner. The source and candidate are kept.')
            await this.confirm(value, { hostId: value.operation.source.hostId, operationId: binding.operationId, ownerRuntimeId: binding.ownerRuntimeId,
              expectedRevision: binding.candidateRevision, candidateDigest: binding.candidateDigest, target: binding.target, executorId: binding.executorId, confirmationId: mintObjectId() }, context, true)
          }
        } else if (method === 'agent.learning.confirm') {
          this.person(context)
          await this.confirm(value, p, context)
        }
      }
      return { operation: await this.observed(value) } as AgentLearningResultMap[M]
    })
  }
  private async confirm(value: Stored, input: AgentLearningConfirm, context: AgentMuxRpcCallContext, explicit = false) {
    const operation = value.operation
    if (!operation.candidate || operation.ownerRuntimeId !== input.ownerRuntimeId || operation.revision !== input.expectedRevision || hash(operation.candidate.content) !== input.candidateDigest)
      return fail('LEARNING_REVISION_CONFLICT', 'The candidate changed before confirmation. Review this exact current version; its draft and original Agents are kept.')
    this.local(input.target.expectedResource.hostId)
    const binding: AgentLearningBinding = { operationId: operation.operationId, ownerRuntimeId: operation.ownerRuntimeId, source: operation.source,
      candidateRevision: operation.revision, candidateDigest: hash(operation.candidate.content), target: input.target, executorId: input.executorId }
    if (operation.approved) {
      if (!same(operation.approved, binding)) return fail('LEARNING_CONFIRMATION_CONFLICT', 'The original confirmation covers different content or target. Inspect its original learner; nothing was retargeted.')
      if (value.learning?.dispatched && !explicit) return // No automatic continuation after an unknown creation.
    } else {
      await this.options.target(input.target)
      const executor = await this.options.executor(input.executorId)
      await this.options.confirmation(input.confirmationId, binding)
      await context.assertCurrent?.(); context.signal?.throwIfAborted()
      operation.approved = binding
      operation.learner = { agentSessionId: mintObjectId(), createOperationId: mintObjectId(), executorId: input.executorId,
        state: 'prepared', initialPrompt: 'not-requested', context: 'unknown' }
      value.learningExecutor = { providerId: executor.providerId, revision: executor.revision }
      // Freeze the actual approval and learner identity before target preparation can write a collaborator plaque.
      await this.save(value)
    }
    if (!value.learning) {
      if (!value.learningExecutor || !operation.learner) return fail('LEARNING_PREPARATION_UNCONFIRMED', 'The original approved learner preparation is unconfirmed. Keep this operation and restore its original record; no replacement Agent was created.')
      const { agentSessionId, createOperationId } = operation.learner
      const target = await this.options.target(input.target, { providerId: value.learningExecutor.providerId, sessionId: agentSessionId })
      value.learning = { dispatched: false, input: { agentSessionId, createOperationId, executorId: input.executorId, executorRevision: value.learningExecutor.revision,
        workspacePath: target.workspacePath, agentMuxTask: composeAgentLearning(binding, operation.candidate.content),
        ...(target.agentMuxNote ? { agentMuxNote: target.agentMuxNote } : {}),
        ...(target.optionalContext ? { optionalContext: target.optionalContext } : {}) } }
      await this.save(value)
    }
    await this.dispatch(value, 'learning', context, explicit)
  }
}
