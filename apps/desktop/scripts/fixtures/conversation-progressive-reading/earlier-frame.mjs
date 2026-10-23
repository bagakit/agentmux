export function acceptedEarlierWindow(reads, accepted) {
  const window = accepted && reads.findLast(read => read.window?.complete === true &&
    read.window.id === accepted.id && read.window.revision === accepted.revision)?.window
  if (!window?.navigation?.older) throw new Error('No complete original earlier window for the accepted reading consumer frame')
  return window
}

export function earlierRequestWindow(reads, expected, method, input) {
  if (method !== 'readAgentConversation' || input.hostId !== expected.hostId ||
    input.agentSessionId !== expected.agentSessionId || input.preserveCurrent !== true ||
    typeof input.cursor !== 'string' || !input.cursor) return null
  return reads.findLast(read => read.window?.complete === true && read.window.id === expected.id &&
    read.window.revision >= expected.revision && read.window.navigation?.older === input.cursor)?.window ?? null
}
