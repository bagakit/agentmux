export type TerminalStartupPhase = 'restoring' | 'starting-agent' | null

export function terminalStartupPhase(input: {
  hydrating: boolean
  attachFailed: boolean
  agent: boolean
  running: boolean
  hasOutput: boolean
}): TerminalStartupPhase {
  if (input.attachFailed) return null
  if (input.hydrating) return 'restoring'
  if (input.agent && input.running && !input.hasOutput) return 'starting-agent'
  return null
}
