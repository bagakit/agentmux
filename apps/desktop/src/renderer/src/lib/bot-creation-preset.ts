import iconUrl from '../../../../resources/icon-512.png'
import type { ConnectionEnrollmentPreset } from '@agentmux/core/connections'

/** The Desktop supplies its own public asset; the common protocol receives explicit PNG bytes. */
export async function desktopBotCreationPreset(name: string): Promise<ConnectionEnrollmentPreset> {
  const response = await fetch(iconUrl)
  if (!response.ok) throw new Error('The bot image could not be loaded. Your bot details are kept.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  // The shared public codec validates the PNG, size and dimensions before admission.
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { name, avatar: { pngDataUrl: 'data:image/png;base64,' + btoa(binary) } }
}
