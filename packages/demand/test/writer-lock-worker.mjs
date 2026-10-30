import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { openDemandStore } from '../src/demand-store.js'
import { runDemandCli } from '../src/cli.js'
import { DemandStoreError } from '../src/errors.js'

const input = JSON.parse(process.argv[2])
const send = value => process.send?.({ pid: process.pid, ...value })
let continueWork
const continued = new Promise(resolve => { continueWork = resolve })
process.on('message', message => { if (message === 'continue') continueWork() })
const pause = async point => {
  if (input.pause !== point) return
  send({ event: 'paused', point })
  await continued
}
const lock = join(input.root, 'store.lock'), snapshot = join(input.root, 'store.json')
const open = fs.open.bind(fs), link = fs.link.bind(fs), rename = fs.rename.bind(fs)
let replacedSnapshot = false
const primaryCause = { kind: 'goal-start-version-conflict', goalId: 'original', operationId: 'original-operation', currentUpdatedAt: 123 }
const primaryFailure = new DemandStoreError('INVALID_INPUT', 'validate', snapshot, 'Original domain failure', primaryCause)
fs.open = async (...args) => {
  if (String(args[0]).startsWith(snapshot + '.tmp-')) {
    await pause('snapshot')
    if (input.primaryFailure) throw primaryFailure
  }
  if (input.openFailure && String(args[0]).startsWith(lock + '.tmp-')) {
    const original = await open(args[0], 'wx', 0o600)
    await original.writeFile('Existing file owned by another creator'); await original.close()
    send({ event: 'open-failure', path: String(args[0]) })
    throw Object.assign(Error('Private temporary open failed before ownership'), { code: input.openFailure })
  }
  const handle = await open(...args)
  if (String(args[0]) === lock) {
    send({ event: 'opened-lock' })
    if (input.closeFailure) { const close = handle.close.bind(handle); handle.close = async () => {
      await close(); throw Object.assign(Error('Private writer close failed after releasing FD'), { code: 'EIO' })
    } }
  }
  if (input.directorySyncFailure && String(args[0]) === input.root && args[1] === 'r') {
    const sync = handle.sync.bind(handle); handle.sync = async () => {
      if (replacedSnapshot) throw Object.assign(Error('Private snapshot directory sync unconfirmed'), { code: 'EIO' })
      await sync()
    }
  }
  return handle
}
fs.link = async (...args) => {
  if (String(args[1]) === lock) await pause('before-publish')
  const result = await link(...args)
  if (String(args[1]) === lock) await pause('after-publish')
  return result
}
fs.rename = async (...args) => {
  if (String(args[1]) === snapshot && input.beforeReplaceFailure) throw Object.assign(Error('Private snapshot was not replaced'), { code: 'EIO' })
  const result = await rename(...args)
  if (String(args[1]) === snapshot) replacedSnapshot = true
  return result
}
try {
  send({ event: 'started' })
  if (input.cli) {
    const exitCode = await runDemandCli(input.argv)
    process.exitCode = exitCode
    send({ event: 'result', result: { exitCode } })
  } else if (input.legacy) {
    const fd = await open(lock, 'wx', 0o600)
    await fd.writeFile(`${process.pid}\n${Date.now()}\n`)
    await fd.sync(); await fd.close()
    send({ event: 'legacy-held' })
    await continued
    await fs.unlink(lock)
    send({ event: 'result', result: { released: true } })
  } else {
    const store = openDemandStore({ root: input.root, lockTimeoutMs: input.timeout ?? 5000, lockRetryMs: 5 })
    const result = await store[input.method](...input.args)
    send({ event: 'result', result })
  }
} catch (error) {
  send({ event: 'failure', error: { message: error.message, code: error.code, phase: error.phase, path: error.path },
    ...(input.primaryFailure ? { sameError: error === primaryFailure, sameCause: error.cause === primaryCause, cause: error.cause, cleanupCount: error.cleanup?.length } : {}) })
  process.exitCode = 1
} finally { process.disconnect?.() }
