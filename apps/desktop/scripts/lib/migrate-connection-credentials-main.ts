import { app, safeStorage } from 'electron'
import { mkdirSync } from 'node:fs'

// Only the original native provider lives in Electron; SQLite stays in the Node parent.
const send = (message: object) => {
  if (!process.connected || !process.send) { app.exit(1); return }
  try { process.send(message, error => { if (error) app.exit(1) }) } catch { app.exit(1) }
}
function start() {
  app.setName('AgentMux')
  const isolated = process.argv[2]!
  mkdirSync(isolated, { recursive: true, mode: 0o700 })
  app.setPath('userData', isolated)
  app.setPath('sessionData', isolated)
  app.setActivationPolicy('accessory')
  let busy = false, providerReady = false, completed = 0
  process.on('disconnect', () => app.exit(1))
  process.on('message', async (value: unknown) => {
    const message = value as { kind?: unknown; id?: unknown; ciphertext?: { type?: unknown; data?: unknown } }
    if (message?.kind === 'close') { app.exit(busy ? 1 : 0); return }
    if (busy || message?.kind !== 'decrypt' || !Number.isSafeInteger(message.id) ||
        message.ciphertext?.type !== 'Buffer' || !Array.isArray(message.ciphertext.data) ||
        !message.ciphertext.data.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      send({ kind: 'failure', stage: 'native-request' }); return
    }
    busy = true
    let stage = 'native-provider'
    try {
      if (!providerReady) {
        send({ kind: 'stage', stage: 'opening-original-provider' })
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Native provider unavailable.')
        providerReady = true
        send({ kind: 'stage', stage: 'reading-original-credentials' })
      }
      stage = 'native-decrypt'
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(message.ciphertext.data))
      if (typeof decrypted.result !== 'string') throw new Error('Native value unconfirmed.')
      send({ kind: 'decrypted', id: message.id, plaintext: decrypted.result })
      completed++
      if (completed % 50 === 0) send({ kind: 'progress', completed })
    } catch { send({ kind: 'failure', id: message.id, stage }) }
    finally { busy = false }
  })
  void app.whenReady().then(() => send({ kind: 'ready' })).catch(() => {
    send({ kind: 'failure', stage: 'native-ready' }); app.exit(1)
  })
}
try { start() } catch { send({ kind: 'failure', stage: 'native-ready' }); app.exit(1) }
