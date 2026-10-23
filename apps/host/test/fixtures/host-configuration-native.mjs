import { appendFileSync, existsSync, readFileSync, watch } from 'node:fs'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(import.meta.dirname, '../../../..'), index = resolve(root, 'apps/host/dist/index.js')
const sha = value => createHash('sha256').update(value).digest('hex')
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const path = fileURLToPath(url)
  if (!path.endsWith('.js')) return result
  if (path !== index && !path.startsWith(resolve(root, 'packages/core/dist') + '/') && !path.startsWith(resolve(root, 'packages/connectors/dist') + '/')) return result
  const original = String(result.source); let served = original
  const variant = process.env.HOST_CONFIG_MUTANT
  if (path === index && variant) {
    const mutations = {
      'configured-clients-omitted': ['clients: () => configured.clients()', 'clients: () => []'],
      'runtime-pin-omitted': ['expectedRuntimeId: runtimeId, waitForReady: false', 'waitForReady: false']
    }
    const mutation = mutations[variant]
    if (!mutation || served.split(mutation[0]).length !== 2) throw Error('Default Host mutation must match exactly one executed owner expression')
    served = served.replace(mutation[0], mutation[1])
  }
  if (!process.env.HOST_CONFIG_TRACE) return { ...result, source: served }
  const receipt = { path: relative(root, path), pid: process.pid, originalSHA: sha(original), servedSHA: sha(served), ...(served !== original ? { mutation: variant } : {}) }
  const witness = "import { appendFileSync as __configurationLoad } from 'node:fs'; __configurationLoad(" + JSON.stringify(process.env.HOST_CONFIG_TRACE) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n'
  const offset = served.startsWith('#!') ? served.indexOf('\n') + 1 : 0
  return { ...result, source: served.slice(0, offset) + witness + served.slice(offset) }
} })
await import('./host-index-native.mjs')
// Only the original Native I/O availability leaf is controlled. The original
// Host/Input owners decide waiting, rejoin, authorization and persistence.
if (process.env.HOST_CONFIG_NATIVE_STATE) {
  const { AgentMuxClient } = await import('../../../../packages/core/dist/index.js')
  const connect = AgentMuxClient.prototype.connect
  AgentMuxClient.prototype.connect = async function () {
    await connect.call(this)
    const available = () => !existsSync(process.env.HOST_CONFIG_NATIVE_STATE) || readFileSync(process.env.HOST_CONFIG_NATIVE_STATE, 'utf8') === 'ready'
    const update = () => { this.connected = available() }
    this.kernel.isConnected = available; update()
    watch(process.env.HOST_CONFIG_NATIVE_STATE, { persistent: false }, update)
  }
}
