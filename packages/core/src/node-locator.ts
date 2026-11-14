import { AgentMuxError } from './errors.js'
import { nodeAlias, parseNodePublishingResult, type NodePublication } from './node-publishing.js'
import { rpcRecord, rpcString } from './rpc-data.js'

export type NodeLocateParams = { alias: string; expectedRuntimeId?: string }
export type NodeLocatedMatch = {
  /** Preferred confirmed carrier. A confirmed canonical local carrier takes precedence. */
  hostId: string
  /** All confirmed configured carriers of this original Runtime, in configuration order. */
  hostIds: string[]
  publication: NodePublication
}
export type NodeLocateIssue = { hostId: string; code: string; message: string }
export type NodeLocateResult = {
  status: 'unique' | 'ambiguous' | 'unconfirmed' | 'missing'
  matches: NodeLocatedMatch[]
  issues: NodeLocateIssue[]
}
export const NODE_LOCATOR_METHODS = { 'node.locate': 'long' } as const
export type NodeLocatorMethod = keyof typeof NODE_LOCATOR_METHODS
export type NodeLocatorParamsMap = { 'node.locate': NodeLocateParams }
export type NodeLocatorResultMap = { 'node.locate': NodeLocateResult }

export function parseNodeLocateParams(value: unknown): NodeLocateParams {
  const p = rpcRecord(value, ['alias', 'expectedRuntimeId'])
  const alias = nodeAlias(p.alias)
  if (!alias) throw new AgentMuxError('A Node locator requires a nonempty published alias.', 'INVALID_CONTROL_REQUEST')
  return { alias, ...(p.expectedRuntimeId === undefined ? {} : { expectedRuntimeId: rpcString(p.expectedRuntimeId, 'Original Node Runtime') }) }
}

function status(input: NodeLocateParams, matches: readonly NodeLocatedMatch[], issues: readonly NodeLocateIssue[]): NodeLocateResult['status'] {
  if (matches.length > 1) return 'ambiguous'
  if (matches.length === 1 && (input.expectedRuntimeId !== undefined || issues.length === 0)) return 'unique'
  return issues.length ? 'unconfirmed' : 'missing'
}

export function parseNodeLocateResult(value: unknown, input: NodeLocateParams): NodeLocateResult {
  const fail = (): never => { throw new AgentMuxError('Node location returned malformed or different original facts.', 'CONTROL_PROTOCOL_ERROR') }
  const p = rpcRecord(value, ['status', 'matches', 'issues'], 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(p.matches) || !Array.isArray(p.issues)) return fail()
  const text = (value: unknown) => { try { return rpcString(value, 'Node location fact') } catch { return fail() } }
  const usedHosts = new Set<string>(), usedRuntimes = new Set<string>()
  const matches = p.matches.map((value): NodeLocatedMatch => {
    const p = rpcRecord(value, ['hostId', 'hostIds', 'publication'], 'CONTROL_PROTOCOL_ERROR'), hostId = text(p.hostId)
    if (!Array.isArray(p.hostIds) || !p.hostIds.length) return fail()
    const hostIds = p.hostIds.map(text)
    if (new Set(hostIds).size !== hostIds.length || !hostIds.includes(hostId) ||
        hostId !== (hostIds.includes('local') ? 'local' : hostIds[0]) || hostIds.some(id => usedHosts.has(id))) return fail()
    let publication: NodePublication
    try { publication = parseNodePublishingResult('node.inspect', p.publication, { hostId, ...(input.expectedRuntimeId === undefined ? {} : { expectedRuntimeId: input.expectedRuntimeId }) }) } catch { return fail() }
    if (input.expectedRuntimeId === undefined && publication.node.alias !== input.alias || usedRuntimes.has(publication.node.runtimeId)) return fail()
    usedRuntimes.add(publication.node.runtimeId); for (const id of hostIds) usedHosts.add(id)
    return { hostId, hostIds, publication }
  })
  const issueHosts = new Set<string>()
  const issues = p.issues.map((value): NodeLocateIssue => {
    const p = rpcRecord(value, ['hostId', 'code', 'message'], 'CONTROL_PROTOCOL_ERROR'), hostId = text(p.hostId)
    if (issueHosts.has(hostId) || usedHosts.has(hostId)) return fail()
    issueHosts.add(hostId)
    return { hostId, code: text(p.code), message: text(p.message) }
  })
  if (p.status !== status(input, matches, issues)) return fail()
  return { status: p.status as NodeLocateResult['status'], matches, issues }
}

/** One finite observation over the original configured scope; no discovery, cache or capability grants. */
export async function locatePublishedNodes(input: NodeLocateParams, hostIds: readonly string[],
  inspect: (hostId: string, signal?: AbortSignal) => Promise<NodePublication>, signal?: AbortSignal): Promise<NodeLocateResult> {
  signal?.throwIfAborted()
  const scopes = new Map<string, number>()
  for (const hostId of hostIds) scopes.set(hostId, (scopes.get(hostId) ?? 0) + 1)
  const observations = await Promise.all([...scopes].map(async ([hostId, count]): Promise<NodeLocatedMatch | NodeLocateIssue> => {
    if (count !== 1) return { hostId, code: 'NODE_ROUTE_AMBIGUOUS', message: 'This configured Host route is ambiguous. Inspect its original Host settings and locate again.' }
    try {
      const publication = parseNodePublishingResult('node.inspect', await inspect(hostId, signal), { hostId })
      return { hostId, hostIds: [hostId], publication }
    } catch (error) {
      signal?.throwIfAborted()
      return { hostId, code: error instanceof AgentMuxError ? error.code : 'NODE_LOCATION_UNAVAILABLE',
        message: 'This configured Node could not be observed. Restore that original Host route and locate again.' }
    }
  }))
  signal?.throwIfAborted()
  const runtimes = new Map<string, NodeLocatedMatch>(), issues: NodeLocateIssue[] = []
  for (const observed of observations) {
    if (!('publication' in observed)) { issues.push(observed); continue }
    const runtimeId = observed.publication.node.runtimeId, existing = runtimes.get(runtimeId)
    if (!existing) runtimes.set(runtimeId, observed)
    else {
      existing.hostIds.push(observed.hostId)
      if (observed.hostId === 'local') { existing.hostId = 'local'; existing.publication = observed.publication }
    }
  }
  const matches = [...runtimes.values()].filter(match => input.expectedRuntimeId === undefined
    ? match.publication.node.alias === input.alias : match.publication.node.runtimeId === input.expectedRuntimeId)
  return parseNodeLocateResult({ status: status(input, matches, issues), matches, issues }, input)
}
