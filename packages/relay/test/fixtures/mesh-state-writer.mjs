// Private fault fixture. The product owner performs every actual metadata write.
import fs from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

const [mode, directory, operationId] = process.argv.slice(2)
const originalRename = fs.promises.rename.bind(fs.promises)
const originalOpen = fs.promises.open.bind(fs.promises)
let product
if (mode === 'hold-rename') {
  fs.promises.rename = async (from, to) => {
    if (to === join(directory, 'identity.json')) {
      const released = new Promise(resolve => {
        const receive = message => { if (message?.releaseOperationId === operationId) { process.removeListener('message', receive); resolve() } }
        process.on('message', receive)
      })
      await new Promise((resolve, reject) => process.send({ stage: 'held-rename', operationId, inspection: undefined }, error => error ? reject(error) : resolve()))
      await released
    }
    return originalRename(from, to)
  }
}
if (mode === 'lost-sync') {
  fs.promises.open = async (...args) => {
    const file = await originalOpen(...args)
    if (args[0] === directory) {
      const current = await fs.promises.readFile(join(directory, 'identity.json'), 'utf8').then(JSON.parse, () => null)
      if (current?.operationId === operationId) file.sync = async () => { throw Object.assign(Error('Private lost directory durability ACK'), { code: 'EIO' }) }
    }
    return file
  }
}
syncBuiltinESMExports()
product = await import('../../dist/mesh-state.js')
try {
  const owner = await product.acquireRelayMeshIdentity(directory, operationId)
  const result = { stage: 'committed', operationId, inspection: await product.inspectRelayMeshState(directory) }
  if (process.send) await new Promise((resolve, reject) => process.send(result, error => error ? reject(error) : resolve()))
  else await new Promise(resolve => process.stdout.write(JSON.stringify(result) + '\n', resolve))
  // Deliberate owner exit without release models an abrupt standalone exit.
  process.exit(0)
} catch (error) {
  const result = { stage: 'refused', operationId, error: { code: error.code }, inspection: await product.inspectRelayMeshState(directory) }
  if (process.send) await new Promise((resolve, reject) => process.send(result, error => error ? reject(error) : resolve()))
  else await new Promise(resolve => process.stdout.write(JSON.stringify(result) + '\n', resolve))
  process.exit(0)
}
