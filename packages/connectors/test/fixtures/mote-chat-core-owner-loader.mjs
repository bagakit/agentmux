import '../../../../apps/host/test/mote-presence-node-loader.mjs'
import { registerHooks } from 'node:module'
import { relative, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../../..'), assets = process.env.MOTE_CHAT_RESTART_ASSETS
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const path = relative(root, fileURLToPath(url)), original = String(result.source)
  let loaded = original
  const pins = {
    'packages/core/src/agent-native-process.ts': ["fileURLToPath(new URL('../dist/native-socket-peer-darwin', import.meta.url))", JSON.stringify(join(assets, 'native-socket-peer-darwin'))],
    'packages/core/src/control-endpoint-publication.ts': ["join(dirname(packagePath), 'dist/control-endpoint-listener-worker.js')", JSON.stringify(join(assets, 'control-endpoint-listener-worker.mjs'))]
  }
  const pin = pins[path]
  if (pin) {
    if (!original.includes(pin[0])) throw Error('Exact original Core asset reference is absent: ' + path)
    loaded = original.replaceAll(pin[0], pin[1])
  }
  if (process.env.MOTE_CHAT_RESTART_TRACE && /^(?:packages\/(?:core|connectors)\/src|apps\/host\/src)\//u.test(path)) {
    const sha = value => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.MOTE_CHAT_RESTART_TRACE, JSON.stringify({ pid: process.pid, path, originalSHA256: sha(original), loadedSHA256: sha(loaded), assetPin: !!pin }) + '\n')
  }
  return loaded === original ? result : { ...result, source: loaded }
} })
