import type { IpcMainInvokeEvent } from 'electron'
import { connectAgentMuxRpc } from '@agentmux/core'
import { parseMotePreferencesReadInput, parseMotePreferencesSaveParams } from '@agentmux/core/mote-preferences'

export type MotePreferencesIpcChannel = 'motePreferences:read' | 'motePreferences:save'
/** A transparent authenticated Desktop client of the original public preference service. */
export function registerMotePreferencesIpc(options: {
  handleWithEvent(channel: MotePreferencesIpcChannel, handler: (event: IpcMainInvokeEvent, params: unknown) => Promise<unknown>): void
  assertTrusted(channel: MotePreferencesIpcChannel, event: IpcMainInvokeEvent): void
  socketPath: string
}): void {
  options.handleWithEvent('motePreferences:read', async (event, params) => {
    options.assertTrusted('motePreferences:read', event)
    const input = parseMotePreferencesReadInput(params)
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.socketPath } })
    try { return await client.call('space.mote.preferences.read', input) }
    finally { await client.dispose() }
  })
  options.handleWithEvent('motePreferences:save', async (event, params) => {
    options.assertTrusted('motePreferences:save', event)
    const input = parseMotePreferencesSaveParams(params)
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.socketPath } })
    try { return await client.call('space.mote.preferences.save', input) }
    finally { await client.dispose() }
  })
}
