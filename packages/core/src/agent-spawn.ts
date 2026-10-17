import { AgentMuxError } from './errors.js'

/** Relative to the original child Session owner, never a display Host alias. */
export type AgentMuxSpawnCreator = {
  agentSessionId: string
  run: { runId: string }
  owner: { kind: 'local' } | { kind: 'runtime'; runtimeId: string }
}

/** Structure validation does not authenticate a creator. Only the creation owner does. */
export function parseAgentSpawnCreator(value: unknown): AgentMuxSpawnCreator {
  const invalid = (): never => { throw new AgentMuxError('Spawn source requires its exact original owner, Session and Run.', 'INVALID_AGENT_SPAWN_SOURCE') }
  const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
    const source = value as Record<string, unknown>
    if (Object.keys(source).length !== keys.length || keys.some(key => !Object.hasOwn(source, key))) return invalid()
    return source
  }
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) return invalid()
    return value
  }
  const source = object(value, ['agentSessionId', 'run', 'owner'])
  const run = object(source.run, ['runId'])
  if (!source.owner || typeof source.owner !== 'object' || Array.isArray(source.owner)) return invalid()
  const kind = (source.owner as Record<string, unknown>).kind
  const owner = object(source.owner, kind === 'local' ? ['kind'] : ['kind', 'runtimeId'])
  if (kind !== 'local' && kind !== 'runtime') return invalid()
  return { agentSessionId: id(source.agentSessionId), run: { runId: id(run.runId) },
    owner: kind === 'local' ? { kind } : { kind, runtimeId: id(owner.runtimeId) } }
}

/** Generated from verified creation facts, kept separate from the creator's original prompt. */
export function agentSpawnContext(creator: AgentMuxSpawnCreator): string {
  const owner = creator.owner.kind === 'local' ? 'this original Core owner' : `Runtime ${creator.owner.runtimeId}`
  return `This Session was created by AgentMux Session ${creator.agentSessionId}, Run ${creator.run.runId}, at ${owner}.\n` +
    'Read your creation record with amux whoami or amux agent inspect; use amux agent spawn --help for original creation relations.\n' +
    'Creation is provenance only: it grants no task ownership, credentials or authority over another Agent. Follow the actual authorized request.'
}
