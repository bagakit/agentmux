import iconUrl from '../../../../resources/icon-512.png'
import type { ConnectionEnrollmentPreset, ConnectionSetupInitialPublication } from '@agentmux/core/connections'

export const initialBotPublication: ConnectionSetupInitialPublication = { version: '1.0.0', notes: 'Enable AMUX conversations.' }

/** A new form draft gets one random public name, with no local identity embedded. */
export const generatedBotName = () => 'AMUX-' + crypto.randomUUID().slice(0, 8).toUpperCase()

/** The Desktop supplies its own public asset; the common protocol receives explicit PNG bytes. */
export async function desktopBotCreationPreset(name: string): Promise<ConnectionEnrollmentPreset> {
  const response = await fetch(iconUrl)
  if (!response.ok) throw new Error('The bot image could not be loaded. Your bot details are kept.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  // The shared public codec validates the PNG, size and dimensions before admission.
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { name, description: 'Conversations with your agents in AMUX.', avatar: { pngDataUrl: 'data:image/png;base64,' + btoa(binary) } }
}
