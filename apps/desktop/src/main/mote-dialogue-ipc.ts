import type { IpcMainInvokeEvent } from 'electron'
import { parseMoteDialogueParams } from '@agentmux/core/mote-dialogue'
import type { RuntimeController } from './runtime-controller.js'

/** A read-only transport to the original resource Host; no Renderer dialogue owner. */
export function registerMoteDialogueIpc(options: {
  handleWithEvent(channel: 'moteDialogue:read', handler: (event: IpcMainInvokeEvent, params: unknown) => Promise<unknown>): void
  runtime: Pick<RuntimeController, 'callOriginalCore'>
}): void {
  options.handleWithEvent('moteDialogue:read', async (event, params) => {
    const input = parseMoteDialogueParams('space.mote.dialogue.read', params)
    return await options.runtime.callOriginalCore(input.target.expectedResource.hostId, 'space.mote.dialogue.read', input, { transport: 'unix' })
  })
}
