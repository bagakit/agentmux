import { randomUUID } from 'node:crypto'
import { parseNodePublishingResult } from '@agentmux/core/node-publishing'
import { readMeshDeviceLink } from '../shared/mesh-device-link.js'
import { existingMeshDeviceWindow } from './mesh-device-window.js'

/** Borrow an already open, authorized device workface. Observing a map never opens or pairs one. */
export async function readMeshDeviceLocation(link: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const window = existingMeshDeviceWindow(readMeshDeviceLink(link).url)
  if (!window) return null
  const contents = window.webContents, token = JSON.stringify(randomUUID())
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(6000)])
  let rejectClosed!: (reason: unknown) => void
  const cancelled = new Promise<never>((_, reject) => { rejectClosed = reject })
  const stop = () => {
    rejectClosed(lifetime.reason)
    if (!contents.isDestroyed()) void contents.executeJavaScript('window.cancelNodeLocationRead?.(' + token + ')').catch(() => {})
  }
  lifetime.addEventListener('abort', stop, { once: true })
  try {
    const result: unknown = await Promise.race([contents.executeJavaScript('window.readOriginalNodeLocation?.(' + token + ')'), cancelled])
    lifetime.throwIfAborted()
    return result == null ? null : parseNodePublishingResult('node.location', result, { hostId: 'local' })
  } finally { lifetime.removeEventListener('abort', stop) }
}
