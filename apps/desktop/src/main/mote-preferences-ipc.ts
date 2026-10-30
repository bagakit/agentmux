import type { IpcMainInvokeEvent } from 'electron'
import { parseMotePreferencesReadInput, parseMotePreferencesSaveParams } from '@agentmux/core/mote-preferences'
import type { RuntimeController } from './runtime-controller.js'
import type { ConnectionHostingTarget } from '../shared/contracts.js'
import { connectionHostTarget, type ConnectionHostIpc } from './connection-host-ipc.js'

export type MotePreferencesIpcChannel = 'motePreferences:read' | 'motePreferences:save'
/** A transparent authenticated Desktop client of the original public preference service. */
export function registerMotePreferencesIpc(options: {
  handleWithEvent(channel: MotePreferencesIpcChannel, handler: (event: IpcMainInvokeEvent, params: unknown, target?: ConnectionHostingTarget) => Promise<unknown>): void
  assertTrusted(channel: MotePreferencesIpcChannel, event: IpcMainInvokeEvent): void
  socketPath: string
  runtime: ConnectionHostIpc & Pick<RuntimeController, 'callOriginalCore'>
}): void {
  options.handleWithEvent('motePreferences:read', async (event, params, target) => {
    options.assertTrusted('motePreferences:read', event)
    const input = parseMotePreferencesReadInput(params)
    if (input.kind === 'quick') return await options.runtime.callOriginalCore(input.target.expectedResource.hostId, 'space.mote.preferences.read', input, { transport: 'unix' })
    return await options.runtime.callConnectionHost(await connectionHostTarget(options.runtime, target), 'space.mote.preferences.read', input)
  })
  options.handleWithEvent('motePreferences:save', async (event, params, target) => {
    options.assertTrusted('motePreferences:save', event)
    const input = parseMotePreferencesSaveParams(params)
    if (input.kind === 'quick') return await options.runtime.callOriginalCore(input.target.expectedResource.hostId, 'space.mote.preferences.save', input, { transport: 'unix' })
    return await options.runtime.callConnectionHost(await connectionHostTarget(options.runtime, target), 'space.mote.preferences.save', input)
  })
}
