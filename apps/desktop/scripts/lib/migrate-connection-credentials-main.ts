import { app, safeStorage } from 'electron'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { convertConnectionCredentials } from './connection-credential-conversion.js'

const request = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const report = (stage: string, facts: Record<string, number | boolean | string> = {}) => process.stdout.write('AMUX_CREDENTIAL_TRANSFER ' + JSON.stringify({ operationId: request.operationId, stage, ...facts }) + '\n')
// The caller must confirm the original native namespace before running this tool.
if (request.applicationName !== 'AgentMux') throw new Error('The original application namespace is unconfirmed.')
app.setName(request.applicationName)
const isolated = join(dirname(process.argv[1]!), 'isolated-user-data')
mkdirSync(isolated, { mode: 0o700 })
app.setPath('userData', isolated)
app.setPath('sessionData', isolated)
app.setActivationPolicy('accessory')

void app.whenReady().then(async () => {
  let database: DatabaseSync | undefined
  try {
    const file = lstatSync(request.databasePath), directory = lstatSync(dirname(request.databasePath))
    if (!file.isFile() || file.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink() ||
        String(file.dev) !== request.expectedDatabase.device || String(file.ino) !== request.expectedDatabase.inode ||
        file.uid !== process.getuid!() || directory.uid !== process.getuid!() || (file.mode & 0o077) || (directory.mode & 0o077)) throw new Error('Original private database identity is unconfirmed.')
    database = new DatabaseSync(request.databasePath)
    let completed = 0
    const result = await convertConnectionCredentials({ database, backup: request.backup, decryptLegacy: async ciphertext => {
      if (!completed) {
        report('opening-original-provider')
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Original native credential provider is unavailable.')
        report('reading-original-credentials')
      }
      const decrypted = await safeStorage.decryptStringAsync(ciphertext)
      completed++
      if (completed % 50 === 0) report('reading-original-credentials', { completed })
      return decrypted.result
    } })
    const receipt = { operationId: request.operationId, databaseIdentity: request.expectedDatabase, backup: request.backup, result,
      boundary: 'Original local native provider; same SQLite references and operations. No platform request, owner stop, key export or keychain deletion.' }
    writeFileSync(join(request.evidenceDirectory, 'conversion-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    report('conversion-confirmed', result)
    database.close(); database = undefined
    app.exit(0)
  } catch {
    report('conversion-unconfirmed', { originalRequestKept: true, keychainDeleted: false })
    try { database?.close() } catch { /* The original operation must be inspected before any continuation. */ }
    app.exit(1)
  }
})
