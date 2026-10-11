import { AgentMuxError } from './errors.js'

/** Original logical SDK options only; never a RunSpec, generated credential or input carrier. */
export type AgentContinuityExecutor = { providerId: string; executorId: string } & (
  { source: 'sdk'; options: { commandOverride?: string; args?: readonly string[]; env?: Readonly<Record<string, string>> } } |
  { source: 'host' | 'provider' }
)

export function unconfirmedContinuityExecutor(): AgentMuxError {
  return new AgentMuxError('The original recovery execution source is unconfirmed. Its Session, Run and input are retained; restore the original execution owner or explicitly authorize a new recovery intent.',
    'AGENT_CONTINUITY_EXECUTOR_UNCONFIRMED')
}

/** Preserve uninterpretable private records at rest; validate only the requested root. */
export function continuityExecutorEntries(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function readContinuityExecutor(value: unknown, rootId: string): AgentContinuityExecutor | undefined {
  if (value === undefined) return undefined
  const entries = continuityExecutorEntries(value)
  if (!entries) throw unconfirmedContinuityExecutor()
  if (!Object.hasOwn(entries, rootId)) return undefined
  const invalid = (): never => { throw unconfirmedContinuityExecutor() }
  const record = (input: unknown, fields?: readonly string[]): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || fields && Object.keys(input).some(key => !fields.includes(key))) invalid()
    return input as Record<string, unknown>
  }
  const text = (input: unknown): string => {
    if (typeof input !== 'string' || !input || input.includes('\0')) invalid()
    return input as string
  }
  const p = record(entries[rootId], ['providerId', 'executorId', 'source', 'options'])
  const common = { providerId: text(p.providerId), executorId: text(p.executorId) }
  if (p.source === 'host' || p.source === 'provider') {
    if (Object.hasOwn(p, 'options')) invalid()
    return { ...common, source: p.source }
  }
  if (p.source !== 'sdk') invalid()
  const options = record(p.options, ['commandOverride', 'args', 'env'])
  if (!Object.keys(options).length || options.args !== undefined && (!Array.isArray(options.args) ||
    options.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) invalid()
  const environment = options.env === undefined ? undefined : record(options.env)
  if (environment && Object.entries(environment).some(([key, item]) => !key || key.includes('=') || key.includes('\0') ||
    typeof item !== 'string' || item.includes('\0'))) invalid()
  return { ...common, source: 'sdk', options: {
    ...(options.commandOverride === undefined ? {} : { commandOverride: text(options.commandOverride) }),
    ...(options.args === undefined ? {} : { args: [...options.args as string[]] }),
    ...(environment === undefined ? {} : { env: { ...environment } as Record<string, string> })
  } }
}
