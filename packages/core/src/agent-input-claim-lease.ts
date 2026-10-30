import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { AgentMuxAgentSessionStore } from './agent-session-store.js'
import type { AgentPromptInputKey } from './agent-prompt-condition.js'
import { AgentMuxError } from './errors.js'

declare const claimLease: unique symbol
/** Package-private capability: a structural or serialized copy is never live. */
export type AgentInputClaimLease = Readonly<{ [claimLease]: true }>
type Scope = { store: AgentMuxAgentSessionStore; storeScope: string; journalId: string; key: AgentPromptInputKey }
const live = new WeakMap<AgentInputClaimLease, Scope>()
const journalOwners = new WeakMap<object, AgentMuxAgentSessionStore>()

/** Only the constructing Core owner binds its journal instance to its real Store. */
export function bindAgentInputClaimStore(journal: object, store: AgentMuxAgentSessionStore): void { journalOwners.set(journal, store) }

const memoryScopes = new WeakMap<AgentMuxAgentSessionStore, string>()

function storeScope(store: AgentMuxAgentSessionStore): string {
  const path = (store as { path?: unknown }).path
  if (typeof path === 'string') return createHash('sha256').update(resolve(path) + '.prompt-locks').digest('hex')
  let scope = memoryScopes.get(store)
  if (!scope) { scope = 'instance:' + randomUUID(); memoryScopes.set(store, scope) }
  return scope
}

/** The Store grants entry; no public DTO or journal argument can mint this lease. */
export async function withAgentInputClaimLease<T>(store: AgentMuxAgentSessionStore, journalId: string,
  key: AgentPromptInputKey, execute: (lease: AgentInputClaimLease) => Promise<T>): Promise<T> {
  return await store.withPromptSubmission(key.agentSessionId, async () => {
    const lease = Object.freeze({}) as AgentInputClaimLease
    live.set(lease, { store, storeScope: storeScope(store), journalId, key: structuredClone(key) })
    try { return await execute(lease) } finally { live.delete(lease) }
  })
}

export function assertAgentInputClaimLease(lease: AgentInputClaimLease, journal: object, journalId: string,
  key: AgentPromptInputKey, expectedStoreScope?: string): string {
  const scope = live.get(lease)
  if (!scope || journalOwners.get(journal) !== scope.store || scope.journalId !== journalId || !isDeepStrictEqual(scope.key, key) ||
      expectedStoreScope !== undefined && expectedStoreScope !== scope.storeScope) throw new AgentMuxError(
    'The original input requires its active exact Session claim owner. Its input and Agent are retained.', 'AGENT_INPUT_CLAIM_LEASE_INVALID')
  return scope.storeScope
}
