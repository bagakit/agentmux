import { useAppStore, warmTerminalKey } from '../../src/renderer/src/store'

export function warmCandidates(workspacePath: string, hostId = 'local') {
  return useAppStore.getState().warmTerminals[warmTerminalKey(hostId, workspacePath)] ?? []
}
