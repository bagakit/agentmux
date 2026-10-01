/** Plain-text sharing. Identity fields describe objects; they never authenticate a sender. */
export type AmuxSharingKind = 'IDCard' | 'Region' | 'Tab' | 'File' | 'Browser'

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
