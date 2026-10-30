import type { IpcMainInvokeEvent } from 'electron'
import { parseMoteDialogueParams } from '@agentmux/core/mote-dialogue'
import type { RuntimeController } from './runtime-controller.js'

type MoteDialogueChannel = 'moteDialogue:setup:inspect' | 'moteDialogue:setup:advance' | 'moteDialogue:read' | 'moteDialogue:link' | 'moteDialogue:recovery:ensure' | 'moteDialogue:recovery:inspect'
/** The registered App-document transport delegates to the original resource or admission Host. */
export function registerMoteDialogueIpc(options: {
  handleWithEvent(channel: MoteDialogueChannel, handler: (event: IpcMainInvokeEvent, params: unknown) => Promise<unknown>): void
  runtime: Pick<RuntimeController, 'callOriginalCore'>
}): void {
  for (const action of ['inspect','advance'] as const) {
    const channel = `moteDialogue:setup:${action}` as const, method = `space.mote.dialogue.setup.${action}` as const
    options.handleWithEvent(channel,async (event,params) => {
      const input = parseMoteDialogueParams(method,params)
      const result = await options.runtime.callOriginalCore(input.creation.hostId,method,{...input,creation:{...input.creation,hostId:'local'}},{transport:'unix'})
      return {...result,ownerHostId:input.creation.hostId}
    })
  }
  for (const action of ['ensure', 'inspect'] as const) {
    const channel = `moteDialogue:recovery:${action}` as const, method = `space.mote.dialogue.recovery.${action}` as const
    options.handleWithEvent(channel, async (event, params) => {
      const input = parseMoteDialogueParams(method, params)
      return await options.runtime.callOriginalCore(input.target.expectedResource.hostId, method, input, { transport:'unix' })
    })
  }
  options.handleWithEvent('moteDialogue:read', async (event, params) => {
    const input = parseMoteDialogueParams('space.mote.dialogue.read', params)
    return await options.runtime.callOriginalCore(input.target.expectedResource.hostId, 'space.mote.dialogue.read', input, { transport: 'unix' })
  })
  options.handleWithEvent('moteDialogue:link', async (event, params) => {
    const input = parseMoteDialogueParams('space.mote.dialogue.link', params)
    return await options.runtime.callOriginalCore(input.target.expectedResource.hostId, 'space.mote.dialogue.link', input, { transport: 'unix' })
  })
}
