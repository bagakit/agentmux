import { registerHooks } from 'node:module'
let fault = null
let removalWrites = 0
// Faults are injected by a test-only Node loader; the production owner has no test switches.
globalThis.capsuleFault = (stage, path, value) => {
  if (!fault) return
  const isRecord = path.includes('/records/')
  let shouldThrow = false
  if (fault === 'record-sync') shouldThrow = isRecord && (stage === 'after-rename' || stage === 'confirm')
  if (fault === 'deletion-final-write' && stage === 'before-rename' && isRecord && value.removed) {
    removalWrites++
    shouldThrow = removalWrites >= 2
  }
  if (shouldThrow) throw Object.assign(new Error('injected storage failure'), { code: 'EIO' })
}
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/capsule/dist/storage.js')) return result
    let source = String(result.source)
    source = source.replace(
      'await rename(temporary, path);',
      "globalThis.capsuleFault('before-rename', path, value); await rename(temporary, path); globalThis.capsuleFault('after-rename', path, value);",
    )
    source = source.replace(
      'export async function confirmDurable(path) {',
      "export async function confirmDurable(path) { globalThis.capsuleFault('confirm', path);",
    )
    return { ...result, source }
  },
})
const { NodeCapsuleOwner } = await import('../dist/node.js')
const owner = await NodeCapsuleOwner.open({ stateDirectory: process.env.CAPSULE_TEST_STATE })
process.send({ ready: true })
process.on('message', async (message) => {
  try {
    if (message.method === 'fault') {
      fault = message.params.mode
      removalWrites = 0
      process.send({ id: message.id, result: true })
      return
    }
    if (message.method === 'close') {
      await owner.close()
      process.send({ id: message.id, result: true }, () => process.exit(0))
      return
    }
    const result = await owner.call(message.method, message.params)
    process.send({ id: message.id, result })
  } catch (error) {
    process.send({ id: message.id, error: { code: error.code, message: error.message } })
  }
})
