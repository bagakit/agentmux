import { api } from '../../../src/renderer/src/lib/api'
// A private durable public storage port. The production Desktop document owner
// still hydrates, validates, batches and confirms its original fragment bytes.
const key = 'agentmux.private-mote-initialization-native-user-document'
api.ui.readWorkbenchState = async () => localStorage.getItem(key)
api.ui.importWorkbenchState = async value => { localStorage.setItem(key, value); return value }
api.ui.writeWorkbenchState = async value => {
  localStorage.setItem(key, value)
  const bytes = new TextEncoder().encode(value)
  const contentDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('')
  return { diskDurability: 'confirmed', path: '/private-controlled/user-state.json', sizeBytes: bytes.byteLength, contentDigest, confirmedAt: Date.now() }
}
