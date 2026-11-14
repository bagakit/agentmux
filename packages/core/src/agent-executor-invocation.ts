import { createHash } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { readContinuityExecutor, type AgentContinuityExecutor } from './agent-session-recovery/executor.js'
import type { AgentMuxStoredAgentSession } from './types.js'

type InvocationOwner = Pick<AgentMuxStoredAgentSession, 'providerId' | 'executorId' | 'creation'>
type SdkExecutor = Extract<AgentContinuityExecutor, { source: 'sdk' }>
/** Original caller options, before Provider wrappers, Hook credentials or Runtime environment are added. */
type ExecutorInvocation = { createOperationId: string; intentDigest: string; executor: SdkExecutor }
const unavailable = () => new AgentMuxError('The original creation execution source is unconfirmed. Its Session, native identity and terminal are retained; restore that original private source.', 'AGENT_EXECUTOR_INVOCATION_UNCONFIRMED')
const digest = (value: ExecutorInvocation) => {
  const sorted = (input: unknown): unknown => Array.isArray(input) ? input.map(sorted) : input && typeof input === 'object'
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)])) : input
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex')
}
export function captureExecutorInvocation(providerId: string, executorId: string, createOperationId: string, intentDigest: string,
  input: SdkExecutor['options']): { value: ExecutorInvocation; digest: string } | undefined {
  if (!['commandOverride', 'args', 'env'].some(key => input[key as keyof typeof input] !== undefined)) return
  const executor = readContinuityExecutor({ original: { providerId, executorId, source: 'sdk', options: {
    ...(input.commandOverride === undefined ? {} : { commandOverride: input.commandOverride }),
    ...(input.args === undefined ? {} : { args: [...input.args] }), ...(input.env === undefined ? {} : { env: { ...input.env } }) } } }, 'original')!
  if (executor.source !== 'sdk') throw unavailable()
  const value = { createOperationId, intentDigest, executor }
  return { value, digest: digest(value) }
}
/** A public digest opts in only this exact original private source; old unknown sources stay independent. */
export function readExecutorInvocation(owner: InvocationOwner, value: unknown): SdkExecutor | undefined {
  if (!owner.creation?.executorInvocationDigest) return
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
    const p = value as Record<string, unknown>
    if (Object.keys(p).some(key => !['createOperationId', 'intentDigest', 'executor'].includes(key)) ||
      p.createOperationId !== owner.creation.createOperationId || p.intentDigest !== owner.creation.intentDigest) throw unavailable()
    const executor = readContinuityExecutor({ original: p.executor }, 'original')
    if (executor?.source !== 'sdk' || executor.providerId !== owner.providerId || executor.executorId !== owner.executorId) throw unavailable()
    const normalized = { createOperationId: p.createOperationId as string, intentDigest: p.intentDigest as string, executor }
    if (digest(normalized) !== owner.creation.executorInvocationDigest) throw unavailable()
    return executor
  } catch { throw unavailable() }
}
