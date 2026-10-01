import type { AgentMuxDesktopApi, AgentMuxPreloadApi } from '../../../shared/contracts'
import { requireSessionInput } from '../../../shared/session-input-receipt'

export function createRendererSessionInput(preload: AgentMuxPreloadApi['sessions']):
  Pick<AgentMuxDesktopApi['sessions'], 'write' | 'paste'> {
  return {
    write: async (control, data, source) => requireSessionInput(await preload.write(control, data, source)),
    paste: async (control, text, terminalData) => requireSessionInput(await preload.paste(control, text, terminalData))
  }
}
