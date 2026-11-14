import { formatSpaceLink, parseSpaceLinkAddress, type SpaceLinkAddress } from './space-link.js'
export { parseSpaceLinkResult } from './space-link.js'
import { AMUX_PROTOCOL_DEFINITIONS } from './amux-protocol-definition.js'
import { nodeAlias } from './node-publishing.js'

/** Plain-text sharing. Identity fields describe objects; they never authenticate a sender. */
export type AmuxSharingKind = 'File' | 'Browser'

/** Owners supply the original content; framing does not reinterpret or trim it. */
export function formatAmuxSharing(kind: AmuxSharingKind, content: string): string {
  return `--- ${AMUX_PROTOCOL_DEFINITIONS.sharing.tag} : ${kind} ---\n${content}\n-----`
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
  | { kind: 'goal'; goalId: string; runtimeId: string; namespace: string; section?: 'plan' }
  | { kind: 'agent'; agentSessionId: string }
  | { kind: 'region'; regionId: string }
  | { kind: 'tab'; tabId: string }
  | { kind: 'space'; spaceId: string }
  | { kind: 'zone'; zoneId: string }
  | { kind: 'capsule'; capsuleId: string }
  | { kind: 'mote'; spaceId: string; eventId?: string; address?: never }
  | { kind: 'mote'; address: SpaceLinkAddress; spaceId?: never; eventId?: never }

export type AmuxGoalAddress = { runtimeId: string; namespace: string; goalUrl: string; planUrl: string }

export function formatGoalAddress(goalId: string, runtimeId: string, namespace: string): AmuxGoalAddress {
  return { runtimeId, namespace, goalUrl: formatAmuxObjectLink({ kind: 'goal', goalId, runtimeId, namespace }),
    planUrl: formatAmuxObjectLink({ kind: 'goal', goalId, runtimeId, namespace, section: 'plan' }) }
}

export function formatAmuxObjectLink(target: AmuxObjectLinkTarget): string {
  if (target.kind === 'mote' && target.address) return formatSpaceLink(target.address)
  if (target.kind === 'goal') {
    if (typeof target.goalId !== 'string' || !target.goalId || typeof target.runtimeId !== 'string' || !target.runtimeId || typeof target.namespace !== 'string' || !target.namespace || target.section !== undefined && target.section !== 'plan') throw new TypeError('An exact Goal and its original Runtime are required.')
    return `${AMUX_PROTOCOL_DEFINITIONS.link.tag}goal/${encodeURIComponent(target.goalId)}${target.section === 'plan' ? '/plan' : ''}?runtime=${encodeURIComponent(target.runtimeId)}&namespace=${encodeURIComponent(target.namespace)}`
  }
  if (target.kind === 'host') {
    const alias = nodeAlias(target.alias)
    if (!alias) throw new TypeError('A published Node alias is required.')
    const resource = target.resource
    const id = resource?.kind === 'agent' ? resource.agentSessionId : resource?.capsuleId
    if (resource && (typeof id !== 'string' || !id)) throw new TypeError('An exact original resource identity is required.')
    if (target.runtimeId !== undefined && (typeof target.runtimeId !== 'string' || !target.runtimeId)) throw new TypeError('An exact original Runtime identity is required.')
    return `${AMUX_PROTOCOL_DEFINITIONS.link.tag}host/${alias}${resource ? `/${resource.kind}/${encodeURIComponent(id!)}` : ''}${target.runtimeId === undefined ? '' : `?runtime=${encodeURIComponent(target.runtimeId)}`}`
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
  return `${AMUX_PROTOCOL_DEFINITIONS.link.tag}${target.kind}/${encodeURIComponent(id)}${eventId === undefined ? '' : `/thread/${encodeURIComponent(eventId)}`}`
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
  const goal = /^amux:\/\/goal\/([^/?#]+)(\/plan)?\?runtime=([^&#?]+)&namespace=([^&#?]+)$/u.exec(raw)
  if (goal) {
    const target = { kind: 'goal' as const, goalId: decodeURIComponent(goal[1]!), runtimeId: decodeURIComponent(goal[3]!), namespace: decodeURIComponent(goal[4]!), ...(goal[2] ? { section: 'plan' as const } : {}) }
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
