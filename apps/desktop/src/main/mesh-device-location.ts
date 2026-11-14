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
  const stop = () => { if (!contents.isDestroyed()) void contents.executeJavaScript('window.cancelNodeLocationRead?.(' + token + ')').catch(() => {}) }
  signal.addEventListener('abort', stop, { once: true })
  try {
    const result: unknown = await contents.executeJavaScript('window.readOriginalNodeLocation?.(' + token + ')')
    signal.throwIfAborted()
    return result == null ? null : parseNodePublishingResult('node.location', result, { hostId: 'local' })
  } finally { signal.removeEventListener('abort', stop) }
}
