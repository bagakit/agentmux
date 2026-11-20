import { formatSpaceLink, parseSpaceLinkAddress, type SpaceLinkAddress } from './space-link.js'
export { parseSpaceLinkResult } from './space-link.js'
import { renderAmuxProtocol } from './amux-protocol.js'
import { nodeAlias } from './node-publishing.js'
import { isObjectId } from '@agentmux/identity'
import { deriveBoundGoalId } from '@agentmux/demand/goals'
export { deriveBoundGoalId } from '@agentmux/demand/goals'
import { isGoalTicketHash } from '@agentmux/demand/goal-plan'

/** Plain-text sharing. Identity fields describe objects; they never authenticate a sender. */
export type AmuxSharingKind = 'File' | 'Browser'

/** Owners supply the original content; framing does not reinterpret or trim it. */
export function formatAmuxSharing(kind: AmuxSharingKind, content: string): string {
  return renderAmuxProtocol('sharing', 'wire', { kind, body: content })
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** The exact semantic target also serves error-recovery guidance. */
export function agentSessionSendCommand(agentSessionId: string): string {
  return `amux agent send --to-session=${shellArgument(agentSessionId)} --text "..."`
}

export function agentSessionInspectCommand(agentSessionId: string, hostId?: string): string {
  return `amux agent inspect${hostId === undefined ? '' : ` --host=${shellArgument(hostId)}`} --session=${shellArgument(agentSessionId)}`
}

export const AMUX_AGENT_LIST_COMMAND = 'amux agent ls'

export type AmuxHostAddress = {
  alias: string
  runtimeId?: string
  resource?: { kind: 'agent'; agentSessionId: string } | { kind: 'capsule'; capsuleId: string }
}

/** Semantic and spatial identities remain different object kinds. */
export type AmuxObjectLinkTarget =
  | ({ kind: 'host' } & AmuxHostAddress)
  | ({ kind: 'goal' } & AmuxGoalLinkTarget)
  | { kind: 'agent'; agentSessionId: string }
  | { kind: 'region'; regionId: string }
  | { kind: 'tab'; tabId: string }
  | { kind: 'space'; spaceId: string }
  | { kind: 'zone'; zoneId: string }
  | { kind: 'capsule'; capsuleId: string }
  | { kind: 'mote'; spaceId: string; eventId?: string; address?: never }
  | { kind: 'mote'; address: SpaceLinkAddress; spaceId?: never; eventId?: never }

export type AmuxGoalLinkTarget = { goalId: string } & (
  | { runtimeId: string; namespace: string; section?: 'plan'; nodeId?: string; bound?: never }
  | { runtimeId?: never; namespace?: never; section?: 'plan'; nodeId?: never; bound: true }
  | { runtimeId?: never; namespace?: never; section?: never; nodeId: string; bound?: never }
)
export type AmuxGoalAddress = { runtimeId: string; namespace: string; goalUrl: string; planUrl: string; creationOperationId?: string }

export function hasOriginalGoalBinding(goalId: string, address: AmuxGoalAddress): boolean {
  return typeof address.creationOperationId === 'string' && address.creationOperationId.length > 0 &&
    goalId === deriveBoundGoalId(address.runtimeId, address.namespace, address.creationOperationId)
}

export function formatGoalTicketLink(goalId: string, address: AmuxGoalAddress, nodeId: string): string {
  return formatAmuxObjectLink(hasOriginalGoalBinding(goalId, address) ? { kind: 'goal', goalId, nodeId }
    : { kind: 'goal', goalId, nodeId, runtimeId: address.runtimeId, namespace: address.namespace })
}

export function formatGoalAddress(goalId: string, runtimeId: string, namespace: string, creationOperationId?: string): AmuxGoalAddress {
  const bound = creationOperationId && goalId === deriveBoundGoalId(runtimeId, namespace, creationOperationId)
  const target = { kind: 'goal' as const, goalId, ...(bound ? { bound: true as const } : { runtimeId, namespace }) }
  return { runtimeId, namespace, ...(bound ? { creationOperationId } : {}),
    goalUrl: formatAmuxObjectLink(target), planUrl: formatAmuxObjectLink({ ...target, section: 'plan' }) }
}

export function parseGoalAddress(value: unknown, goalId: string): AmuxGoalAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('An original Goal address is required.')
  const a = value as Record<string, unknown>
  if (typeof a.runtimeId !== 'string' || !a.runtimeId || typeof a.namespace !== 'string' || !a.namespace ||
      (a.creationOperationId !== undefined && (typeof a.creationOperationId !== 'string' || !a.creationOperationId)))
    throw new TypeError('The original Goal address is incomplete.')
  const expected = formatGoalAddress(goalId, a.runtimeId, a.namespace, a.creationOperationId)
  if (Object.keys(a).length !== Object.keys(expected).length || a.goalUrl !== expected.goalUrl ||
      a.planUrl !== expected.planUrl || a.creationOperationId !== expected.creationOperationId)
    throw new TypeError('The original Goal address does not match its binding.')
  return expected
}

function protocolLink(target: string): string {
  return renderAmuxProtocol('link', 'wire', { target })
}

export function formatAmuxObjectLink(target: AmuxObjectLinkTarget): string {
  if (target.kind === 'mote' && target.address) return formatSpaceLink(target.address)
  if (target.kind === 'goal') {
    if (typeof target.goalId !== 'string' || !target.goalId || target.nodeId !== undefined && !isGoalTicketHash(target.nodeId) ||
        target.section !== undefined && (target.section !== 'plan' || target.nodeId !== undefined))
      throw new TypeError('An exact Goal and a valid reading target are required.')
    const root = protocolLink(`goal/${encodeURIComponent(target.goalId)}`)
    const fragment = target.nodeId === undefined ? '' : `#T-${encodeURIComponent(target.nodeId)}`
    if (target.runtimeId === undefined && target.namespace === undefined) {
      if (fragment) return root + fragment
      if (target.bound === true && isObjectId(target.goalId)) return root + (target.section === 'plan' ? '/plan' : '')
    }
    if (typeof target.runtimeId !== 'string' || !target.runtimeId || typeof target.namespace !== 'string' || !target.namespace)
      throw new TypeError('Both original Goal owner coordinates are required.')
    return `${root}${target.section === 'plan' ? '/plan' : ''}?runtime=${encodeURIComponent(target.runtimeId)}&namespace=${encodeURIComponent(target.namespace)}${fragment}`
  }
  if (target.kind === 'host') {
    const alias = nodeAlias(target.alias)
    if (!alias) throw new TypeError('A published Node alias is required.')
    const resource = target.resource
    const id = resource?.kind === 'agent' ? resource.agentSessionId : resource?.capsuleId
    if (resource && (typeof id !== 'string' || !id)) throw new TypeError('An exact original resource identity is required.')
    if (target.runtimeId !== undefined && (typeof target.runtimeId !== 'string' || !target.runtimeId)) throw new TypeError('An exact original Runtime identity is required.')
    return protocolLink(`host/${alias}${resource ? `/${resource.kind}/${encodeURIComponent(id!)}` : ''}${target.runtimeId === undefined ? '' : `?runtime=${encodeURIComponent(target.runtimeId)}`}`)
  }
  const id = target.kind === 'agent' ? target.agentSessionId
    : target.kind === 'region' ? target.regionId
    : target.kind === 'tab' ? target.tabId
    : target.kind === 'space' || target.kind === 'mote' ? target.spaceId
    : target.kind === 'zone' ? target.zoneId
    : target.kind === 'capsule' ? target.capsuleId : undefined
  if (typeof id !== 'string' || !id) throw new TypeError('An exact original object identity is required.')
  const eventId = target.kind === 'mote' ? target.eventId : undefined
  if (eventId !== undefined && (typeof eventId !== 'string' || !eventId)) throw new TypeError('An exact original Mote work event identity is required.')
  return protocolLink(`${target.kind}/${encodeURIComponent(id)}${eventId === undefined ? '' : `/thread/${encodeURIComponent(eventId)}`}`)
}

/** A Mote thread carries its original event within that exact Mote's stable Space. */
export function parseAmuxObjectLink(raw: string): AmuxObjectLinkTarget {
  if (typeof raw !== 'string') throw new TypeError('An object link must be text.')
  const mote = /^amux:\/\/mote\/([^/?#]+)\?runtime=([^&#?]+)$/u.exec(raw)
  if (mote) {
    const address = parseSpaceLinkAddress({linkId:mote[1],runtimeId:decodeURIComponent(mote[2]!)})
    if (formatSpaceLink(address) !== raw) throw new TypeError('The public Mote address encoding is not canonical.')
    return {kind:'mote',address}
  }
  const goal = /^amux:\/\/goal\/([^/?#]+)(\/plan)?(?:\?runtime=([^&#?]+)&namespace=([^&#?]+))?(?:#T-([^/?#]+))?$/u.exec(raw)
  if (goal) {
    const goalId = decodeURIComponent(goal[1]!)
    const nodeId = goal[5] === undefined ? undefined : decodeURIComponent(goal[5])
    const target: AmuxObjectLinkTarget = goal[3] !== undefined
      ? { kind: 'goal', goalId, runtimeId: decodeURIComponent(goal[3]), namespace: decodeURIComponent(goal[4]!),
        ...(goal[2] ? { section: 'plan' as const } : {}), ...(nodeId === undefined ? {} : { nodeId }) }
      : nodeId === undefined ? { kind: 'goal', goalId, bound: true, ...(goal[2] ? { section: 'plan' } : {}) }
        : { kind: 'goal', goalId, nodeId }
    if (formatAmuxObjectLink(target) !== raw) throw new TypeError('The Goal link encoding is not canonical.')
    return target
  }
  const host = /^amux:\/\/host\/([^/?#]+)(?:\/(agent|capsule)\/([^/?#]+))?(?:\?runtime=([^&#?]+))?$/u.exec(raw)
  if (host) {
    const target: AmuxObjectLinkTarget = { kind: 'host', alias: host[1]!,
      ...(host[4] === undefined ? {} : { runtimeId: decodeURIComponent(host[4]) }),
      ...(host[2] === undefined ? {} : { resource: host[2] === 'agent'
        ? { kind: 'agent' as const, agentSessionId: decodeURIComponent(host[3]!) }
        : { kind: 'capsule' as const, capsuleId: decodeURIComponent(host[3]!) } }) }
    if (formatAmuxObjectLink(target) !== raw) throw new TypeError('The Node link encoding is not canonical.')
    return target
  }
  const match = /^amux:\/\/(agent|region|tab|space|zone|capsule|mote)\/([^/?#]+)(?:\/thread\/([^/?#]+))?$/u.exec(raw)
  if (!match || match[3] !== undefined && match[1] !== 'mote') throw new TypeError('Choose an exact amux object link or a Mote thread link.')
  const id = decodeURIComponent(match[2]!)
  const target: AmuxObjectLinkTarget = match[1] === 'agent' ? { kind: 'agent', agentSessionId: id }
    : match[1] === 'region' ? { kind: 'region', regionId: id }
    : match[1] === 'tab' ? { kind: 'tab', tabId: id }
    : match[1] === 'space' ? { kind: 'space', spaceId: id }
    : match[1] === 'zone' ? { kind: 'zone', zoneId: id }
    : match[1] === 'capsule' ? { kind: 'capsule', capsuleId: id }
    : { kind: 'mote', spaceId: id, ...(match[3] === undefined ? {} : { eventId: decodeURIComponent(match[3]) }) }
  if (formatAmuxObjectLink(target) !== raw) throw new TypeError('The object link encoding is not an exact original identity.')
  return target
}

export function formatSessionAddress(agentSessionId: string): string {
  return formatAmuxObjectLink({ kind: 'agent', agentSessionId })
}
export function formatHostAddress(target: AmuxHostAddress): string {
  return formatAmuxObjectLink({ kind: 'host', ...target })
}
export function formatRegionAddress(regionId: string): string {
  return formatAmuxObjectLink({ kind: 'region', regionId })
}
export function formatTabAddress(tabId: string): string {
  return formatAmuxObjectLink({ kind: 'tab', tabId })
}
export function formatSpaceAddress(target: { spaceId: string }): string {
  return formatAmuxObjectLink({ kind: 'space', spaceId: target.spaceId })
}
export function formatZoneAddress(target: { zoneId: string }): string {
  return formatAmuxObjectLink({ kind: 'zone', zoneId: target.zoneId })
}
export function formatCapsuleAddress(capsuleId: string): string {
  return formatAmuxObjectLink({ kind: 'capsule', capsuleId })
}
export function formatMoteAddress(target: { spaceId: string; eventId?: string }): string {
  return formatAmuxObjectLink({ kind: 'mote', spaceId: target.spaceId, ...(target.eventId === undefined ? {} : { eventId: target.eventId }) })
}
