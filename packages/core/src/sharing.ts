/** Plain-text sharing. Identity fields describe objects; they never authenticate a sender. */
export type AmuxSharingKind = 'IDCard' | 'Region' | 'Tab' | 'Space' | 'Zone' | 'File' | 'Browser'

export type AgentSharingMetadata = {
  nativeSessionId?: string | undefined
  provider?: string | undefined
  executor?: string | undefined
}

/** Owners supply the original content; framing does not reinterpret or trim it. */
export function formatAmuxSharing(kind: AmuxSharingKind, content: string): string {
  return `--- amux : ${kind} ---\n${content}\n-----`
}

/** Keep display metadata on one line without making it another identity or field. */
function field(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/gu,
    character => {
      const escaped = JSON.stringify(character).slice(1, -1)
      return escaped === character
        ? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
        : escaped
    })
    .replaceAll('|', '\\|')
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** The exact semantic target also serves error-recovery guidance. */
export function agentSessionSendCommand(agentSessionId: string): string {
  return `amux agent send --to-session=${shellArgument(agentSessionId)} --text "..."`
}

export const AMUX_AGENT_LIST_COMMAND = 'amux agent ls'

export function formatSessionAddress(
  agentSessionId: string,
  metadata: AgentSharingMetadata = {}
): string {
  return formatMessagingAddress({
    agentSessionId, nativeSessionId: metadata.nativeSessionId,
    provider: metadata.provider, executor: metadata.executor
  })
}

/** A clicked Region is additional presentation context, never the semantic recipient. */
export function formatMessagingAddress(
  target: AgentSharingMetadata & { agentSessionId: string; regionId?: string }
): string {
  return formatAmuxSharing('IDCard', [
    `ID: ${field(target.agentSessionId)}`,
    `Exe: ${field(target.nativeSessionId || '?')} | ${field(target.executor || '?')} (${field(target.provider || '?')})`,
    ...(target.regionId === undefined ? [] : [`Region: ${field(target.regionId)}`]),
    `# ${agentSessionSendCommand(target.agentSessionId)}`,
    '# amux --skill'
  ].join('\n'))
}

export function formatRegionAddress(regionId: string): string {
  return formatAmuxSharing('Region', [
    `ID: ${field(regionId)}`,
    `# amux space inspect --region=${shellArgument(regionId)}`,
    '# amux --skill'
  ].join('\n'))
}

export function formatTabAddress(tabId: string): string {
  return formatAmuxSharing('Tab', [
    `ID: ${field(tabId)}`,
    `# amux space inspect --tab=${shellArgument(tabId)}`,
    '# amux --skill'
  ].join('\n'))
}

/** An original spatial object, independent of its current display parent or title. */
export type AmuxSpatialLinkTarget = { kind: 'space'; spaceId: string } | { kind: 'zone'; zoneId: string }

export function formatAmuxSpatialLink(target: AmuxSpatialLinkTarget): string {
  if (target.kind !== 'space' && target.kind !== 'zone') throw new TypeError('A spatial link must identify a Space or Zone.')
  const id = target.kind === 'space' ? target.spaceId : target.zoneId
  if (typeof id !== 'string' || !id) throw new TypeError('An exact original spatial identity is required.')
  return `amux://${target.kind}/${encodeURIComponent(id)}`
}

/** Only generated spatial links are accepted. No command, location hint or metadata is executed. */
export function parseAmuxSpatialLink(raw: string): AmuxSpatialLinkTarget {
  if (typeof raw !== 'string') throw new TypeError('A spatial link must be text.')
  const match = /^amux:\/\/(space|zone)\/([^/?#]+)$/u.exec(raw)
  if (!match) throw new TypeError('Choose an amux Space or Zone link with one exact identity.')
  const id = decodeURIComponent(match[2]!)
  const target: AmuxSpatialLinkTarget = match[1] === 'space' ? { kind: 'space', spaceId: id } : { kind: 'zone', zoneId: id }
  if (formatAmuxSpatialLink(target) !== raw) throw new TypeError('The spatial link encoding is not an exact original identity.')
  return target
}

function formatSpatialAddress(target: AmuxSpatialLinkTarget, label?: string): string {
  const id = target.kind === 'space' ? target.spaceId : target.zoneId
  return formatAmuxSharing(target.kind === 'space' ? 'Space' : 'Zone', [
    `ID: ${field(id)}`,
    ...(label === undefined ? [] : [`Name: ${field(label)}`]),
    `Link: ${formatAmuxSpatialLink(target)}`,
    `# amux space inspect --${target.kind}=${shellArgument(id)}`,
    '# amux --skill'
  ].join('\n'))
}

export function formatSpaceAddress({ spaceId, label }: { spaceId: string; label?: string }): string {
  return formatSpatialAddress({ kind: 'space', spaceId }, label)
}

export function formatZoneAddress({ zoneId, label }: { zoneId: string; label?: string }): string {
  return formatSpatialAddress({ kind: 'zone', zoneId }, label)
}
