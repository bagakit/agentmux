/** Plain-text sharing. Identity fields describe objects; they never authenticate a sender. */
export type AmuxSharingKind = 'File' | 'Browser'

/** Owners supply the original content; framing does not reinterpret or trim it. */
export function formatAmuxSharing(kind: AmuxSharingKind, content: string): string {
  return `--- amux : ${kind} ---\n${content}\n-----`
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** The exact semantic target also serves error-recovery guidance. */
export function agentSessionSendCommand(agentSessionId: string): string {
  return `amux agent send --to-session=${shellArgument(agentSessionId)} --text "..."`
}

export function agentSessionInspectCommand(agentSessionId: string): string {
  return `amux agent inspect --session=${shellArgument(agentSessionId)}`
}

export const AMUX_AGENT_LIST_COMMAND = 'amux agent ls'

/** Semantic and spatial identities remain different object kinds. */
export type AmuxObjectLinkTarget =
  | { kind: 'agent'; agentSessionId: string }
  | { kind: 'region'; regionId: string }
  | { kind: 'tab'; tabId: string }
  | { kind: 'space'; spaceId: string }
  | { kind: 'zone'; zoneId: string }

export function formatAmuxObjectLink(target: AmuxObjectLinkTarget): string {
  const id = target.kind === 'agent' ? target.agentSessionId
    : target.kind === 'region' ? target.regionId
    : target.kind === 'tab' ? target.tabId
    : target.kind === 'space' ? target.spaceId
    : target.kind === 'zone' ? target.zoneId : undefined
  if (typeof id !== 'string' || !id) throw new TypeError('An exact original Agent, Region, Tab, Space or Zone identity is required.')
  return `amux://${target.kind}/${encodeURIComponent(id)}`
}

/** Canonical links carry one original identity, without executable parameters or location guesses. */
export function parseAmuxObjectLink(raw: string): AmuxObjectLinkTarget {
  if (typeof raw !== 'string') throw new TypeError('An object link must be text.')
  const match = /^amux:\/\/(agent|region|tab|space|zone)\/([^/?#]+)$/u.exec(raw)
  if (!match) throw new TypeError('Choose an amux Agent, Region, Tab, Space or Zone link with one exact identity.')
  const id = decodeURIComponent(match[2]!)
  const target: AmuxObjectLinkTarget = match[1] === 'agent' ? { kind: 'agent', agentSessionId: id }
    : match[1] === 'region' ? { kind: 'region', regionId: id }
    : match[1] === 'tab' ? { kind: 'tab', tabId: id }
    : match[1] === 'space' ? { kind: 'space', spaceId: id }
    : { kind: 'zone', zoneId: id }
  if (formatAmuxObjectLink(target) !== raw) throw new TypeError('The object link encoding is not an exact original identity.')
  return target
}

export function formatSessionAddress(agentSessionId: string): string {
  return formatAmuxObjectLink({ kind: 'agent', agentSessionId })
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
